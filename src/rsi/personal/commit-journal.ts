/**
 * 私有仓库提交 journal 与恢复(contracts §21.3 R21-3.6a;§21.24 W0-5 的 bootstrap 状态机)。本文件是 `runSync` 的三个授权文件之一(git 子进程都经
 * `repo-check.ts` 的 `createClosedGit`,这里不直接 import `runSync`,但归在同一授权集合里)。
 *
 * journal 是单文件 `rsi-personal/commit-journal.json`(0600),`personal/lock` 串行化所有提交,同一时刻至多一个在途提交。
 * `phase` ∈ `planned → objects_written → ref_updated → worktree_synced → recorded`:**某一步做完之后**先写 journal 并 fsync(home-fs 原子写),再做下一步;
 * `recorded` 之后才写 `head.json`,最后删 journal。`head.json` 只在 journal 到达 `recorded` 后写,所以「已提交但 head.json 未更新」一定由 journal 识别。
 *
 * 恢复(下一次任何持 `personal/lock` 者,先于 R21-3.5 判定)读五个观测值 ①HEAD 是否为指向 `journal.ref` 的符号引用 ②ref 的值 ③索引 ④工作树 ⑤未跟踪与忽略文件,
 * **只允许三种组合继续**(见 {@link decideRecovery}),其余一律保留 journal、判 `personal_repo_diverged`,不改引用、索引与工作树。
 * 恢复**只看观测值,不看 phase 与 head.json**:崩溃可能发生在任意两步之间(含「步骤做完、journal 还没写」)。
 *
 * bootstrap(W0-5):四个 phase `planned → initialized → committed → recorded`,不复用五 phase 的恢复谓词;恢复按观测到的引用值续做,任何不一致 → `personal_repo_invalid`(保留 journal)。
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { PersonalHeadSchema, type PersonalCommitJournal } from '../../contracts/rsi-personal.js';
import { readDir, lstat } from '../../io/read-fs.js';
import {
  makeRepoDir,
  readHead,
  removeJournal,
  writeHead,
  writeJournal,
  type PersonalHome,
} from './home-state.js';
import {
  checkRepoStructure,
  gitMust,
  gitOut,
  indexFlagged,
  PersonalGitError,
  revParse,
  statusEntries,
  type ClosedGit,
  type RepoInvalidWhy,
} from './repo-check.js';

/** 持有的锁(只用 `assertHeld`):`personal` 必须有;`rsi` 仅正常路径(缩减入口下不持) */
export interface PersonalLocks {
  personal: { assertHeld(): Promise<void> };
  rsi?: { assertHeld(): Promise<void> };
}

/** 崩溃注入 / 观测缝:在命名的步骤点调用(测试里抛错 = 该点之后「进程死亡」;产品代码不传) */
export type StepHook = (step: string) => void | Promise<void>;

export interface OpCtx {
  h: PersonalHome;
  git: ClosedGit;
  locks: PersonalLocks;
  now: () => Date;
  /** 当前 `[rsi] repo` 的 `owner_repo_fp` */
  ownerRepoFp: string;
  /** 测试注入:当前 uid(缺省 `process.getuid()`) */
  uid?: number;
  onStep?: StepHook;
}

/** 提交点前复核全部已持有的锁(R20-5.5:`lock_lost` 时调用方立即停止、不再写) */
export async function assertLocks(c: OpCtx): Promise<void> {
  await c.locks.personal.assertHeld();
  if (c.locks.rsi !== undefined) await c.locks.rsi.assertHeld();
}

/** 写下一个 phase 的 journal(先复核锁,原子写 + fsync),随后触发 `journal:<phase>` 步骤点 */
export async function writePhase(
  c: OpCtx,
  j: PersonalCommitJournal,
  patch: { phase: string; new_commit?: string },
): Promise<PersonalCommitJournal> {
  await assertLocks(c);
  const next: PersonalCommitJournal = {
    ...j,
    ...(patch.new_commit !== undefined ? { new_commit: patch.new_commit } : {}),
    phase: patch.phase,
    at: c.now().toISOString(),
  };
  await writeJournal(c.h, next);
  await c.onStep?.(`journal:${patch.phase}`);
  return next;
}

/**
 * `recorded` 之后:写 `head.json`(已有且合法时沿用其 `owner_repo_fp`——恢复发生在 R21-3.5 ④ 之前,不能借机悄悄改归属),最后删 journal。
 * 先写 head、后删 journal:两步之间崩溃 → 下次恢复看到「全部等于 new_commit」,只差记录,幂等重做。
 */
export async function recordHeadAndFinish(c: OpCtx, j: PersonalCommitJournal): Promise<void> {
  // 协议不变量落成运行时闸:只有 journal 已(持久化)到达 recorded,才允许写 head.json
  if (j.phase !== 'recorded' || j.new_commit === null) {
    throw new Error('recordHeadAndFinish: journal 必须已到达 recorded');
  }
  const commit = j.new_commit;
  const cur = await readHead(c.h);
  const fp = cur.kind === 'ok' ? cur.value.owner_repo_fp : c.ownerRepoFp;
  await assertLocks(c);
  await writeHead(
    c.h,
    PersonalHeadSchema.parse({ schema_version: 1, head: commit, owner_repo_fp: fp }),
  );
  await c.onStep?.('after:head');
  await assertLocks(c);
  await removeJournal(c.h);
  await c.onStep?.('after:journal_removed');
}

// ---------------------------------------------------------------------------
// 五 phase 提交的恢复
// ---------------------------------------------------------------------------

export interface Observation {
  /** ① HEAD 是指向 `journal.ref` 的符号引用(不是 detached、不是别的分支) */
  headSymbolic: boolean;
  /** ② `journal.ref` 的值 */
  ref: string | null;
  /** ③ 索引树等于 `old_head` / `new_commit` */
  indexIsOld: boolean;
  indexIsNew: boolean;
  /** ④ 工作树与索引一致(无未暂存改动);配合 ③ 即「工作树等于该提交」 */
  worktreeMatchesIndex: boolean;
  /** ⑤ 有未跟踪(`??`)或被忽略(`!!`)的文件 */
  hasUntrackedOrIgnored: boolean;
  /** 索引里有 assume-unchanged / skip-worktree 等标志(`ls-files -v` 标签不是 `H`):`status` 会据此看不见真实改动,一律不当成「干净」 */
  indexFlagged: boolean;
}

function indexEquals(git: ClosedGit, sha: string | null): boolean {
  if (sha === null) return false;
  const r = git.run(['diff-index', '--cached', '--quiet', sha, '--'], { readOnly: true });
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  throw new PersonalGitError('diff-index --cached', r);
}

export function observeRepo(git: ClosedGit, j: PersonalCommitJournal): Observation {
  const sym = gitOut(git, ['symbolic-ref', '-q', 'HEAD'], { readOnly: true });
  const st = statusEntries(git);
  if (st === null)
    throw new PersonalGitError('status', {
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
  return {
    headSymbolic: sym === j.ref,
    ref: revParse(git, j.ref),
    indexIsOld: indexEquals(git, j.old_head),
    indexIsNew: indexEquals(git, j.new_commit),
    worktreeMatchesIndex: !st.some((e) => e.xy !== '??' && e.xy !== '!!' && e.xy[1] !== ' '),
    hasUntrackedOrIgnored: st.some((e) => e.xy === '??' || e.xy === '!!'),
    indexFlagged: indexFlagged(git),
  };
}

export type RecoveryAction = 'discard' | 'resync' | 'record' | 'diverged';

/**
 * R21-3.6a 恢复谓词(纯函数):只允许三种组合继续——
 *  a) HEAD 符号引用、ref = old_head、索引与工作树都 = old_head、无未跟踪 → `discard`(提交未生效);
 *  b) ref = new_commit、索引与工作树都 = old_head → `resync`(补 `read-tree -m -u`);
 *  c) ref = new_commit、索引与工作树都 = new_commit → `record`(只差记录)。
 * 其余任何组合(另一分支、detached、只改索引、工作树混合、未跟踪文件、ref 为第三个值)→ `diverged`。
 */
export function decideRecovery(
  o: Observation,
  j: Pick<PersonalCommitJournal, 'old_head' | 'new_commit'>,
): RecoveryAction {
  if (!o.headSymbolic || o.hasUntrackedOrIgnored || o.indexFlagged) return 'diverged';
  const clean = o.worktreeMatchesIndex;
  if (o.ref === j.old_head && o.indexIsOld && clean) return 'discard';
  if (j.new_commit !== null && o.ref === j.new_commit) {
    if (o.indexIsNew && clean) return 'record';
    if (o.indexIsOld && clean) return 'resync';
  }
  return 'diverged';
}

export type RecoveryResult =
  { outcome: 'discarded' | 'resynced' | 'recorded' } | { outcome: 'diverged' };

/** 两树合并同步工作树(R21-3.6):`read-tree -m -u <旧> <新>`;**不用 `--reset`**——有冲突的未提交改动时 git 拒绝覆盖 */
export function syncWorktree(git: ClosedGit, oldHead: string, newCommit: string): boolean {
  return git.run(['read-tree', '-m', '-u', oldHead, newCommit]).status === 0;
}

/** 持 `personal/lock` 者在 R21-3.5 判定之前调用;`j.kind` 不是 `bootstrap` */
export async function recoverCommitJournal(
  c: OpCtx,
  j: PersonalCommitJournal,
): Promise<RecoveryResult> {
  const act = decideRecovery(observeRepo(c.git, j), j);
  if (act === 'diverged') return { outcome: 'diverged' };
  if (act === 'discard') {
    // 新对象没有引用,无害(留给 gc);由调用方从头重做
    await assertLocks(c);
    await removeJournal(c.h);
    return { outcome: 'discarded' };
  }
  const newCommit = j.new_commit as string; // resync / record 只在 new_commit 非空时产生
  if (act === 'resync') {
    await assertLocks(c);
    // git 拒绝覆盖有冲突的改动 → 不当成恢复成功,保留 journal,按 diverged 处理(用户改动原样保留)
    if (!syncWorktree(c.git, j.old_head as string, newCommit)) return { outcome: 'diverged' };
    await c.onStep?.('recovery:worktree_synced');
    const synced = await writePhase(c, j, { phase: 'worktree_synced' });
    await recordHeadAndFinish(c, await writePhase(c, synced, { phase: 'recorded' }));
    return { outcome: 'resynced' };
  }
  // 只差记录:同样先把 journal 持久化到 recorded,再写 head.json(head.json 只在 journal 到达 recorded 后写)
  await recordHeadAndFinish(c, await writePhase(c, j, { phase: 'recorded' }));
  return { outcome: 'recorded' };
}

// ---------------------------------------------------------------------------
// bootstrap(W0-5)
// ---------------------------------------------------------------------------

/** 空树(SHA-1 仓库的固定值) */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** bootstrap 的 `txn_id`:常量派生(崩溃重放得到同一 id) */
export const BOOTSTRAP_TXN_ID = createHash('sha256')
  .update(`bootstrap|${EMPTY_TREE}`)
  .digest('hex')
  .slice(0, 16);

export type BootstrapResult =
  | { status: 'created'; commit: string }
  | { status: 'invalid'; why: RepoInvalidWhy | 'bootstrap_inconsistent' }
  /** journal 为 `planned` 且目录不存在:journal 已丢弃,什么也没建(调用方按「首次」再来一遍) */
  | { status: 'discarded' };

const inconsistent = (): BootstrapResult => ({ status: 'invalid', why: 'bootstrap_inconsistent' });

async function dirState(p: string): Promise<'missing' | 'empty' | 'nonempty'> {
  try {
    await lstat(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw e;
  }
  try {
    return (await readDir(p)).length === 0 ? 'empty' : 'nonempty';
  } catch {
    return 'nonempty'; // 不是目录 / 不可读:交给结构校验判
  }
}

/**
 * `git init` 之前的校验(planned 且目录缺失 / 为空):目录之下的每一级祖先(HOME 之下)都不是符号链接,目录自身是真实目录、属主为当前 uid、权限恰为 0700、确为空。
 * 任何一项不满足都不 init(否则目录被换成指向外部的链接时,`git init` 会往外写)。
 */
async function preInitCheck(c: OpCtx): Promise<RepoInvalidWhy | null> {
  const segs = path.relative(c.h.home, c.h.repoDir).split(path.sep);
  let cur = c.h.home;
  for (const seg of segs.slice(0, -1)) {
    cur = path.join(cur, seg);
    const a = await lstat(cur).catch(() => null);
    if (a === null) return 'ancestor_unreadable'; // 读取失败不当成「没问题」
    if (a.isSymbolicLink()) return 'ancestor_symlink';
    if (!a.isDirectory()) return 'ancestor_not_dir';
  }
  const st = await lstat(c.h.repoDir).catch(() => null);
  if (st === null) return 'repo_missing';
  if (st.isSymbolicLink()) return 'repo_dir_symlink';
  if (!st.isDirectory()) return 'repo_dir_not_directory';
  const uid = c.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  if (uid !== undefined && st.uid !== uid) return 'owner';
  if ((st.mode & 0o777) !== 0o700) return 'mode';
  if ((await readDir(c.h.repoDir)).length !== 0) return 'repo_dir_not_empty';
  return null;
}

/** 全新建仓(调用方已用 `probeFirstTime` 证明首次、并持锁) */
export async function bootstrapRepo(c: OpCtx): Promise<BootstrapResult> {
  const planned: PersonalCommitJournal = {
    schema_version: 1,
    txn_id: BOOTSTRAP_TXN_ID,
    kind: 'bootstrap',
    candidate_ids: [],
    ref: 'refs/heads/rsi',
    old_head: null,
    target_tree: EMPTY_TREE,
    new_commit: null,
    phase: 'planned',
    at: c.now().toISOString(),
  };
  await assertLocks(c);
  await writeJournal(c.h, planned);
  await c.onStep?.('journal:planned');
  return continueBootstrap(c, planned);
}

/**
 * 恢复一个在途的 bootstrap journal。`planned` 且目录不存在 → 丢弃 journal(什么也没建);
 * `planned` 且目录是空目录(已 mkdir、尚未 init)→ 继续;非空目录 → 结构校验通过且 `refs/heads/rsi` 不存在才继续,其余 `personal_repo_invalid`。
 */
export async function recoverBootstrap(
  c: OpCtx,
  j: PersonalCommitJournal,
): Promise<BootstrapResult> {
  if (j.phase === 'planned' && (await dirState(c.h.repoDir)) === 'missing') {
    await assertLocks(c);
    await removeJournal(c.h);
    return { status: 'discarded' };
  }
  return continueBootstrap(c, j);
}

/**
 * bootstrap 的观测核对(任何会写状态的步骤之前):HEAD 是指向 `refs/heads/rsi` 的符号引用、索引与工作树为空(无改动、无未跟踪 / 忽略文件、无索引标志),
 * 且已有提交时索引树 = 该提交(空树)。不满足 → 不一致,保留 journal。bootstrap 不复用五 phase 的恢复谓词,但同样不只看一个引用值。
 */
function bootstrapObserved(c: OpCtx, commit: string | null): boolean {
  if (gitOut(c.git, ['symbolic-ref', '-q', 'HEAD'], { readOnly: true }) !== 'refs/heads/rsi') {
    return false;
  }
  const st = statusEntries(c.git);
  if (st === null || st.length !== 0 || indexFlagged(c.git)) return false;
  return commit === null || indexEquals(c.git, commit);
}

async function continueBootstrap(c: OpCtx, start: PersonalCommitJournal): Promise<BootstrapResult> {
  let j = start;
  if (j.phase === 'planned') {
    const dir = await dirState(c.h.repoDir);
    if (dir === 'nonempty') {
      // 目录已存在且非空:要么 git init 已完成(只差写 initialized),要么是别的东西
      const s = await checkRepoStructure(c.h, c.git);
      if (!s.ok) return { status: 'invalid', why: s.why };
      if (revParse(c.git, 'refs/heads/rsi') !== null || !bootstrapObserved(c, null)) {
        return inconsistent();
      }
    } else {
      await assertLocks(c);
      if (dir === 'missing') await makeRepoDir(c.h);
      await c.onStep?.('bootstrap:dir_ready');
      const bad = await preInitCheck(c);
      if (bad !== null) return { status: 'invalid', why: bad };
      const r = c.git.init();
      if (r.status !== 0) throw new PersonalGitError('init', r);
    }
    j = await writePhase(c, j, { phase: 'initialized' });
  }
  // 仓库此刻必须已存在:先做 R21-3.4 结构校验,再读引用、写任何状态(initialized / committed / recorded 的恢复同样如此)
  const repoCheck = await checkRepoStructure(c.h, c.git);
  if (!repoCheck.ok) return { status: 'invalid', why: repoCheck.why };
  if (j.phase === 'initialized') {
    let commit = revParse(c.git, 'refs/heads/rsi');
    if (!bootstrapObserved(c, commit)) return inconsistent();
    if (commit === null) {
      await assertLocks(c);
      const tree = gitMust(c.git, 'mktree', ['mktree'], { input: '' });
      if (tree !== EMPTY_TREE) return inconsistent();
      commit = gitMust(c.git, 'commit-tree', ['commit-tree', EMPTY_TREE, '-m', 'rsi: bootstrap']);
      await c.onStep?.('bootstrap:before:update-ref');
      await assertLocks(c); // 正式引用被写之前复核锁
      // 期望旧值为「不存在」的比较交换
      gitMust(c.git, 'update-ref', ['update-ref', 'refs/heads/rsi', commit, '']);
    } else if (
      revParse(c.git, `${commit}^{tree}`) !== EMPTY_TREE ||
      revParse(c.git, `${commit}^`) !== null
    ) {
      return inconsistent();
    }
    j = await writePhase(c, j, { phase: 'committed', new_commit: commit });
  }
  const done = j.new_commit as string; // committed / recorded 的 journal 必带 new_commit(schema)
  if (revParse(c.git, 'refs/heads/rsi') !== done) return inconsistent();
  if (!bootstrapObserved(c, done)) return inconsistent();
  if (j.phase === 'committed') j = await writePhase(c, j, { phase: 'recorded' });
  await recordHeadAndFinish(c, j);
  return { status: 'created', commit: done };
}
