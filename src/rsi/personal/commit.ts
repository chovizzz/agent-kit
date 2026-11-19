/**
 * 私有仓库提交原语 `commitPersonal`(contracts §21.3 R21-3.6;`runSync` 的三个授权文件之一,git 经 `repo-check.ts` 的封闭执行配置)。
 *
 * 调用方必须持 `personal/lock`(正常路径另持 `rsi/lock`,缩减入口下不持)。流程(每个提交点前 `assertHeld`,journal 见 `commit-journal.ts`):
 *   打开仓库(结构校验 R21-3.4 → journal 恢复 R21-3.6a → HEAD 判定 R21-3.5;只在情形①才继续,否则返回 `deferred`,R21-9.3a)
 *   → 以已接受 HEAD 的树为底稿,叠加 kit 管理路径的 upsert / 显式 delete(底稿里其它路径——含情形①接受的用户文件——原样保留),
 *     `hash-object -w --no-filters`、`mktree -z` 重建目标树 → journal `planned`
 *   → `commit-tree` → journal `objects_written` → `update-ref refs/heads/rsi <新> <旧>`(带期望旧值的原子比较交换)→ journal `ref_updated`
 *   → `read-tree -m -u <旧> <新>`(两树合并同步工作树,**不用 `--reset`**:有冲突的未提交改动时 git 拒绝覆盖,按 `personal_repo_diverged` 处理)
 *   → journal `worktree_synced` → `recorded` → 写 `head.json` → 删 journal。
 * 不依赖 `git revert`,不用 `add` / `commit` 的高层路径;作者与提交者固定为 `RSI_PERSONAL_AUTHOR`。
 * 树约束(R21-3.1):upsert / delete 的顶层只许布局目录(= kit 管理路径,见 {@link KIT_MANAGED_TOP_DIRS});路径段不得以 `.` 开头(含 `.gitattributes` / `.gitmodules` / `.git`),文件一律 `100644`。
 */
import { PersonalHeadSchema, type PersonalCommitJournal } from '../../contracts/rsi-personal.js';
import type { RsiAutoPauseReason } from '../../contracts/rsi.js';
import { REF_MOVED_AFTER_DENIED } from './commit-reasons.js';
import {
  PERSONAL_STATE_FILES,
  ensureEmptyDir,
  probeFirstTime,
  readHead,
  readJournal,
  removeJournal,
  statePath,
  writeHead,
  type PersonalHome,
} from './home-state.js';
import {
  assertLocks,
  bootstrapRepo,
  recordHeadAndFinish,
  recoverBootstrap,
  recoverCommitJournal,
  syncWorktree,
  writePhase,
  NO_BOOTSTRAP_AUTH,
  BootstrapDenied,
  type BootstrapAuth,
  type OpCtx,
  type PersonalLocks,
  type StepHook,
} from './commit-journal.js';
import {
  checkRepoStructure,
  classifyRepo,
  createClosedGit,
  gitMust,
  PersonalGitError,
  revParse,
  type ClosedGit,
  type RepoSituation,
} from './repo-check.js';

export type { BootstrapAuth, BootstrapStep, PersonalLocks, StepHook } from './commit-journal.js';

export interface PersonalRepoDeps {
  h: PersonalHome;
  /** 当前 `[rsi] repo` 的 `owner_repo_fp`(`ownerRepoFingerprint`) */
  ownerRepoFp: string;
  now?: () => Date;
  /** 测试注入:当前 uid(结构校验的属主判定) */
  uid?: number;
  /** 崩溃注入 / 观测缝(测试);产品代码不传 */
  onStep?: StepHook;
}

// ---------------------------------------------------------------------------
// 目标树
// ---------------------------------------------------------------------------

export interface TreeFile {
  /** 相对仓库根,正斜杠 */
  path: string;
  content: string;
}

export interface TreeSpec {
  kind: 'transition' | 'rollback' | 'clear' | 'purge_rewrite' | 'reconcile' | 'identity_change';
  /** journal 的 `txn_id`:`sha256(kind, candidate_ids, old_head, target_tree)` 前 16 位(W1 `ids.ts` 派生;崩溃重放得同一 id) */
  txnId: string;
  candidateIds: readonly string[];
  /**
   * 以已接受 HEAD 的树为底稿的**增量**:kit 管理路径(顶层在 {@link KIT_MANAGED_TOP_DIRS} 内)的 upsert。
   * 底稿里没被点名的路径(含情形①接受的用户新增文件、任何非管理路径)原样保留。
   */
  upserts: readonly TreeFile[];
  /** 显式 delete:只许落在 kit 管理的命名空间内;不存在的路径视为已删(崩溃重做幂等) */
  deletes?: readonly string[];
  message?: string;
  /**
   * 增影响提交的最终复核钩子(D1b-2):在**最后一次 `assertLocks` 之后、`update-ref` 之前**调用,钩子返回后再复核一次锁。
   * 只认一种拒绝:抛 {@link BeforeRefUpdateDenied} → 本次提交返回 `denied`(引用不动、自己写下的 journal 在所有权核对后删除);
   * 任何其它错误(含 `RsiLockError` / `PersonalLockLost` / 未知错误)原样传播,**不删 journal、不改引用**(留给下次恢复:`ref = old_head` → `discard`)。
   */
  beforeRefUpdate?: () => Promise<void>;
}

/** 钩子的唯一拒绝信号(定义在本文件,不依赖 stage;`code` 是调用方给的原因码,本文件不解释) */
export class BeforeRefUpdateDenied extends Error {
  constructor(readonly code: string) {
    super(`before_ref_update_denied:${code}`);
    this.name = 'BeforeRefUpdateDenied';
  }
}

export class TreeSpecError extends Error {
  readonly code = 'RSI_PERSONAL_TREE_SPEC';
}

/**
 * **kit 管理路径** = R21-3.1 布局的顶层目录(整个子树);不在其中的路径(例如用户新增的 `notes/x.md`)不归 kit 管理:
 * kit 提交绝不修改或删除它们(upsert / delete 指向它们 → {@link TreeSpecError})。
 */
export const KIT_MANAGED_TOP_DIRS: readonly string[] = Object.freeze([
  'rules',
  'pitfalls',
  'methods',
  'agents',
  'capabilities',
  'exec',
  'cases',
  'lifecycle',
]);
const TOP_DIRS: ReadonlySet<string> = new Set(KIT_MANAGED_TOP_DIRS);
/** upsert / delete 的每一段必须以字母数字开头(所以 `.gitattributes` / `.gitmodules` / `.git` / `.` / `..` 都不可能出现) */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type Leaf = { content: string } | { sha: string };
interface DirNode {
  files: Map<string, Leaf>;
  dirs: Map<string, DirNode>;
}

/** 底稿:已接受 HEAD 的树里的全部文件(`ls-tree -r`);kit 自己的结构校验保证全是 100644 */
function readBaseTree(git: ClosedGit, head: string): { path: string; sha: string }[] {
  const out = gitMust(git, 'ls-tree', ['ls-tree', '-r', '-z', '--full-tree', head], {
    readOnly: true,
  });
  const res: { path: string; sha: string }[] = [];
  for (const ent of out.split('\0').filter((x) => x !== '')) {
    const tab = ent.indexOf('\t');
    const [mode, , sha] = ent.slice(0, tab).split(' ');
    if (mode !== '100644' || sha === undefined) throw new Error(`底稿里有非 100644 条目:${ent}`);
    res.push({ path: ent.slice(tab + 1), sha });
  }
  return res;
}

/** 底稿 + 增量 → 目标树节点。所有路径校验都在写任何对象之前 */
function buildTarget(base: readonly { path: string; sha: string }[], spec: TreeSpec): DirNode {
  if (!/^[0-9a-f]{16}$/.test(spec.txnId)) throw new TreeSpecError('txnId 必须是 16 位十六进制');
  const root: DirNode = { files: new Map(), dirs: new Map() };
  // 每一层的命名空间不区分大小写(大小写不敏感的卷上 `A` 与 `a` 是同一个名字):前缀(小写)→ 第一次见到的确切写法、类型与来源
  const names = new Map<string, { exact: string; kind: 'file' | 'dir'; src: 'base' | 'upsert' }>();
  const place = (p: string, leaf: Leaf, src: 'base' | 'upsert'): void => {
    const segs = p.split('/');
    let node = root;
    let prefix = '';
    for (const [i, seg] of segs.entries()) {
      prefix = prefix === '' ? seg : `${prefix}/${seg}`;
      const kind = i === segs.length - 1 ? 'file' : 'dir';
      const seen = names.get(prefix.toLowerCase());
      if (seen !== undefined) {
        if (src === 'upsert') {
          if (seen.exact !== prefix) throw new TreeSpecError(`大小写不同的同名路径:${p}`);
          if (seen.kind !== kind) throw new TreeSpecError(`文件与目录同名:${p}`);
          if (kind === 'file' && seen.src === 'upsert') throw new TreeSpecError(`重复路径:${p}`);
        }
      } else {
        names.set(prefix.toLowerCase(), { exact: prefix, kind, src });
      }
      if (kind === 'dir') {
        let next = node.dirs.get(seg);
        if (next === undefined) {
          next = { files: new Map(), dirs: new Map() };
          node.dirs.set(seg, next);
        }
        node = next;
      } else {
        node.files.set(seg, leaf);
        if (names.get(prefix.toLowerCase())?.src === 'base' && src === 'upsert') {
          names.set(prefix.toLowerCase(), { exact: prefix, kind, src });
        }
      }
    }
  };

  const gone = new Set<string>();
  for (const d of spec.deletes ?? []) {
    const dsegs = d.split('/');
    if (dsegs.length < 2 || !TOP_DIRS.has(dsegs[0] as string)) {
      throw new TreeSpecError(`不许删除非 kit 管理路径:${d}`);
    }
    for (const s of dsegs) {
      if (!SEGMENT_RE.test(s)) throw new TreeSpecError(`路径段不合法:${d}`);
    }
    gone.add(d);
  }
  for (const b of base) {
    if (!gone.has(b.path)) place(b.path, { sha: b.sha }, 'base');
  }
  for (const f of spec.upserts) {
    const segs = f.path.split('/');
    if (segs.length < 2) throw new TreeSpecError(`顶层不许放文件:${f.path}`);
    if (!TOP_DIRS.has(segs[0] as string)) throw new TreeSpecError(`不在 R21-3.1 布局内:${f.path}`);
    for (const s of segs) {
      if (!SEGMENT_RE.test(s)) throw new TreeSpecError(`路径段不合法:${f.path}`);
    }
    place(f.path, { content: f.content }, 'upsert');
  }
  return root;
}

/** 写新 blob(`--no-filters`)与各层 tree,返回根树 sha(底稿条目复用原 sha)。对象写进 odb 但没有引用,崩溃无害。 */
function writeTree(git: ClosedGit, node: DirNode): string {
  const entries: string[] = [];
  for (const [name, leaf] of node.files) {
    const sha =
      'sha' in leaf
        ? leaf.sha
        : gitMust(git, 'hash-object', ['hash-object', '-w', '--no-filters', '--stdin'], {
            input: leaf.content,
          });
    entries.push(`100644 blob ${sha}\t${name}\0`);
  }
  for (const [name, child] of node.dirs) {
    entries.push(`040000 tree ${writeTree(git, child)}\t${name}\0`);
  }
  return gitMust(git, 'mktree', ['mktree', '-z'], { input: entries.join('') });
}

// ---------------------------------------------------------------------------
// 打开仓库:结构校验 → journal 恢复 → HEAD 判定
// ---------------------------------------------------------------------------

/** R21-3.4 / R21-3.5 ③ 的熔断码(R21-10.2) */
export const PERSONAL_REPO_INVALID = 'personal_repo_invalid' as const satisfies RsiAutoPauseReason;

export type OpenResult =
  | { kind: 'ready'; head: string; ctx: OpCtx }
  /** 首次(尚无仓库)且未要求建仓 */
  | { kind: 'absent' }
  /** bootstrap 类 journal 在场且本模式不许续做(`read`:任一阶段;`complete_only`:`planned` / `initialized`):什么都没做,journal 原样 */
  | { kind: 'bootstrap_pending' }
  /** `mode:'bootstrap'` 的入口校验或某个建仓边界(`init` / `cas`)被授权端口拒绝;journal 停在原阶段 */
  | { kind: 'bootstrap_denied'; step: 'entry' | 'init' | 'cas' }
  /** 情形② / ④(或恢复判 diverged):暂停新增生效,不熔断,不碰引用 / 索引 / 工作树 */
  | { kind: 'deferred'; reason: 'personal_repo_diverged' | 'personal_owner_changed'; why: string }
  /** 熔断 `personal_repo_invalid`(`breaker` 是 R21-10.2 码表里的熔断码) */
  | { kind: 'invalid'; why: string; breaker: typeof PERSONAL_REPO_INVALID };

const invalid = (why: string): OpenResult & { kind: 'invalid' } => ({
  kind: 'invalid',
  why,
  breaker: PERSONAL_REPO_INVALID,
});

async function assertLockHandles(locks: PersonalLocks): Promise<void> {
  await locks.personal.assertHeld();
  if (locks.rsi !== undefined) await locks.rsi.assertHeld();
}

async function makeCtx(deps: PersonalRepoDeps, locks: PersonalLocks): Promise<OpCtx> {
  const now = deps.now ?? ((): Date => new Date());
  await assertLockHandles(locks); // 先复核锁,再做任何写入初始化(丢锁 → 不创建任何目录)
  const emptyDir = await ensureEmptyDir(deps.h);
  return {
    h: deps.h,
    git: createClosedGit(deps.h, emptyDir, now),
    locks,
    now,
    ownerRepoFp: deps.ownerRepoFp,
    ...(deps.uid !== undefined ? { uid: deps.uid } : {}),
    ...(deps.onStep !== undefined ? { onStep: deps.onStep } : {}),
  };
}

/**
 * `openPersonalRepo` 的模式(D1b-1;**必填**,没有默认,编译器找全部调用方)。bootstrap 类 journal 在场时:
 *  - `read`:不动它,返回 `bootstrap_pending`;首次(无仓库)返回 `absent`,不建仓;
 *  - `complete_only`:只许 `committed` / `recorded` 阶段——先读真实 ref 与树(`continueBootstrap` 的核对),吻合才 `committed → recorded → 写 head.json → 删 journal`,不吻合 = `invalid{bootstrap_inconsistent}`(保留 journal);
 *    `planned` / `initialized`:返回 `bootstrap_pending`,零 `git init` / `mktree` / `commit-tree` / `update-ref`(含 `planned` + 目录缺失:不丢弃 journal,D3 前恒如此);
 *  - `bootstrap`:全部阶段续做,建仓边界(`init` / `cas`)经 `auth.authorize`;首次(无 journal)证明为首次才建。**本期生产无调用方**。
 */
export type OpenOpts =
  | { readonly mode: 'read' }
  | { readonly mode: 'complete_only' }
  | { readonly mode: 'bootstrap'; readonly auth: BootstrapAuth };

/** 运行时形状校验(跨信任边界:调用方可能是 JS / 强转):`auth.authorize` 必须是函数 */
function authShapeOk(opts: OpenOpts): boolean {
  const a = (opts as { auth?: unknown }).auth;
  return (
    typeof a === 'object' &&
    a !== null &&
    typeof (a as { authorize?: unknown }).authorize === 'function'
  );
}

/**
 * 持 `personal/lock` 者的入口(模式见 {@link OpenOpts})。
 * 顺序固定:journal(bootstrap 类按模式处理)→ 首次证明(`bootstrap` 才建)→ R21-3.4 结构校验 → R21-3.6a 恢复(先于 3.5)→ R21-3.5 判定 → 情形①更新记录。
 */
export async function openPersonalRepo(
  deps: PersonalRepoDeps,
  locks: PersonalLocks,
  opts: OpenOpts,
): Promise<OpenResult> {
  if (locks.personal === undefined) throw new Error('openPersonalRepo: 必须持 personal/lock');
  const mode = (opts as { mode?: unknown } | null | undefined)?.mode;
  if (mode !== 'read' && mode !== 'complete_only' && mode !== 'bootstrap') {
    throw new Error('openPersonalRepo: opts.mode 必填(read | complete_only | bootstrap)');
  }
  // bootstrap 的 auth 在任何副作用(含 makeCtx 的目录初始化、planned journal)之前校验
  if (mode === 'bootstrap' && !authShapeOk(opts)) {
    return { kind: 'bootstrap_denied', step: 'entry' };
  }
  const c = await makeCtx(deps, locks);
  await assertLocks(c);

  const jr = await readJournal(deps.h);
  if (jr.kind === 'invalid') return invalid(`journal_${jr.why}`);
  let journal = jr.kind === 'ok' ? jr.value : null;

  try {
    if (journal !== null && journal.kind === 'bootstrap') {
      if (mode === 'read') return { kind: 'bootstrap_pending' };
      const early = journal.phase === 'planned' || journal.phase === 'initialized';
      if (mode === 'complete_only' && early) return { kind: 'bootstrap_pending' };
      const auth = opts.mode === 'bootstrap' ? opts.auth : NO_BOOTSTRAP_AUTH;
      const r = await recoverBootstrap(c, journal, auth);
      if (r.status === 'invalid') return invalid(r.why);
      journal = null; // created(已记录并删 journal)/ discarded(什么也没建)
    }

    if (journal === null && (await probeFirstTime(deps.h)) === 'first') {
      if (opts.mode !== 'bootstrap') return { kind: 'absent' };
      const r = await bootstrapRepo(c, opts.auth);
      if (r.status !== 'created') {
        return invalid(r.status === 'invalid' ? r.why : 'bootstrap_discarded');
      }
    }
  } catch (e) {
    if (e instanceof BootstrapDenied) return { kind: 'bootstrap_denied', step: e.step };
    throw e;
  }

  const s = await checkRepoStructure(
    deps.h,
    c.git,
    deps.uid === undefined ? {} : { uid: deps.uid },
  );
  if (!s.ok) return invalid(s.why);

  if (journal !== null) {
    const rr = await recoverCommitJournal(c, journal);
    if (rr.outcome === 'diverged') {
      return { kind: 'deferred', reason: 'personal_repo_diverged', why: 'journal_recovery' };
    }
  }

  const hd = await readHead(deps.h);
  if (hd.kind !== 'ok') {
    return invalid(hd.kind === 'absent' ? 'record_missing' : `head_${hd.why}`);
  }
  const sit = await classifyRepo(c.git, hd.value, deps.ownerRepoFp);
  switch (sit.situation) {
    case 1:
      if (sit.head !== hd.value.head) {
        // 情形①:`记录..HEAD` 只新增了文件 → 接受并更新记录
        await assertLocks(c);
        await writeHead(
          deps.h,
          PersonalHeadSchema.parse({
            schema_version: 1,
            head: sit.head,
            owner_repo_fp: hd.value.owner_repo_fp,
          }),
        );
      }
      return { kind: 'ready', head: sit.head, ctx: c };
    case 2:
      return { kind: 'deferred', reason: 'personal_repo_diverged', why: sit.why };
    case 3:
      return invalid(sit.why);
    case 4:
      return { kind: 'deferred', reason: 'personal_owner_changed', why: 'owner_repo_fp' };
  }
}

// ---------------------------------------------------------------------------
// commitPersonal
// ---------------------------------------------------------------------------

export type CommitResult =
  | { status: 'committed'; commit: string; tree: string }
  | { status: 'absent' }
  | { status: 'deferred'; reason: 'personal_repo_diverged' | 'personal_owner_changed'; why: string }
  | { status: 'invalid'; why: string; breaker: typeof PERSONAL_REPO_INVALID }
  /**
   * `update-ref` 的期望旧值不符(并发的第二个提交者):没有任何引用 / 索引 / 工作树被改。
   * **注意**:本提交的在途 journal 可能仍留在盘上(`objects_written`),下一次恢复按 R21-3.6a 观测到「ref 是第三个值」→ `personal_repo_diverged`;
   * 它不是可以直接重试的干净失败(若并发者是持锁的 kit 提交者,它会先丢弃该 journal 而不留下)。
   */
  | { status: 'cas_failed'; expected: string; actual: string | null }
  /** `beforeRefUpdate` 钩子拒绝(增影响提交的最终复核没过):引用、索引、工作树都没动;`code` 是钩子给的原因码 */
  | { status: 'denied'; code: string };

/** 钩子拒绝后清理自己 journal 的结果:只有 `clean` 才允许对外返回普通 `denied`;其余保留现场(不删、不改引用),由调用方走既有完整性失败路径 */
type DiscardResult =
  | { kind: 'clean' }
  | { kind: 'ref_moved'; actual: string | null }
  | { kind: 'journal_unverified'; why: string };

/**
 * 钩子拒绝后删自己刚写的 journal:先复核锁(抛 → 传播,不动);盘上 journal 与本次写下的**逐字段全等**(含 phase)、
 * 当前 `refs/heads/rsi === old_head` 才删并返回 `clean`;journal 读不出 / 字段不符 → `journal_unverified`,ref 不是 `oldHead` → `ref_moved`,**两者都保留现场**
 * (不能确认是本次事务、或引用已被别人动过 = 完整性不明,不得降级为普通拒绝)。丢锁照旧传播。
 * 删除本身的 IO 失败吞掉(`clean` 照常返回:已确认是自己的 journal 且 `ref = old_head`;下次恢复是否 `discard` 还取决于 HEAD / 索引 / 工作树的观测,不满足时按既有恢复规则归为 diverged,不是本函数的保证)。
 */
async function discardOwnJournal(
  ctx: OpCtx,
  mine: PersonalCommitJournal,
  oldHead: string,
): Promise<DiscardResult> {
  await assertLocks(ctx);
  const early = await verifyOwnJournal(ctx, mine, oldHead);
  if (early.kind !== 'clean') return early;
  await assertLocks(ctx); // 最后一次锁复核(丢锁则传播,不进下面吞 IO 错误的 catch);上面的核对只是快速失败,不是依据
  // 所有权与引用的最终核对在最后一次锁复核**之后**、紧贴删除:锁复核期间(await)盘与引用可能被动过,前面读到的快照不能当依据
  const last = await verifyOwnJournal(ctx, mine, oldHead);
  if (last.kind !== 'clean') return last;
  try {
    await removeJournal(ctx.h);
  } catch {
    // 删除失败:保留 journal,交给下次恢复判定
  }
  return { kind: 'clean' };
}

/**
 * 保证的边界(不夸大):最终核对之后、`unlink` 之前没有 await 与锁复核,但路径删除不与「刚核对过的那个文件」绑定;合作写者都持同一把个人锁,
 * 锁有效期间不会换 journal;外部 `git update-ref` 不受该锁约束,发生在 `revParse` 之后的推进本函数观测不到(下次恢复按既有规则判 diverged)。
 * 盘上 journal 与本次写下的逐字段全等(含 phase)且 `refs/heads/rsi === oldHead` → `clean`;否则给出不可降级的原因 */
async function verifyOwnJournal(
  ctx: OpCtx,
  mine: PersonalCommitJournal,
  oldHead: string,
): Promise<DiscardResult> {
  const cur = await readJournal(ctx.h);
  if (cur.kind !== 'ok') return { kind: 'journal_unverified', why: `journal_${cur.kind}` };
  const a = cur.value;
  const same =
    a.txn_id === mine.txn_id &&
    a.kind === mine.kind &&
    a.old_head === mine.old_head &&
    a.target_tree === mine.target_tree &&
    a.new_commit === mine.new_commit &&
    a.phase === mine.phase &&
    a.candidate_ids.length === mine.candidate_ids.length &&
    a.candidate_ids.every((id, i) => id === mine.candidate_ids[i]);
  if (!same) return { kind: 'journal_unverified', why: 'journal_not_mine' };
  const actual = revParse(ctx.git, 'refs/heads/rsi');
  if (actual !== oldHead) return { kind: 'ref_moved', actual };
  return { kind: 'clean' };
}

export async function commitPersonal(
  deps: PersonalRepoDeps,
  locks: PersonalLocks,
  spec: TreeSpec,
): Promise<CommitResult> {
  const open = await openPersonalRepo(deps, locks, { mode: 'read' });
  if (open.kind === 'absent') return { status: 'absent' };
  if (open.kind === 'invalid') {
    return { status: 'invalid', why: open.why, breaker: open.breaker };
  }
  if (open.kind === 'bootstrap_pending' || open.kind === 'bootstrap_denied') {
    return { status: 'invalid', why: open.kind, breaker: PERSONAL_REPO_INVALID };
  }
  if (open.kind === 'deferred') {
    return { status: 'deferred', reason: open.reason, why: open.why };
  }
  const { ctx, head: oldHead } = open;
  const { git } = ctx;

  await assertLocks(ctx);
  const base = readBaseTree(git, oldHead);
  const targetTree = writeTree(git, buildTarget(base, spec));
  let j = await writePhase(
    ctx,
    {
      schema_version: 1,
      txn_id: spec.txnId,
      kind: spec.kind,
      candidate_ids: [...spec.candidateIds],
      ref: 'refs/heads/rsi',
      old_head: oldHead,
      target_tree: targetTree,
      new_commit: null,
      phase: 'planned',
      at: ctx.now().toISOString(),
    },
    { phase: 'planned' },
  );

  await assertLocks(ctx);
  const commit = gitMust(git, 'commit-tree', [
    'commit-tree',
    targetTree,
    '-p',
    oldHead,
    '-m',
    spec.message ?? `rsi: ${spec.kind} ${spec.txnId}`,
  ]);
  j = await writePhase(ctx, j, { phase: 'objects_written', new_commit: commit });

  await ctx.onStep?.('before:update-ref');
  await assertLocks(ctx); // update-ref 之前复核锁(lock_lost 时立即停止)
  if (spec.beforeRefUpdate !== undefined) {
    try {
      await spec.beforeRefUpdate();
    } catch (e) {
      if (!(e instanceof BeforeRefUpdateDenied)) throw e;
      const d = await discardOwnJournal(ctx, j, oldHead);
      if (d.kind === 'ref_moved') {
        return {
          status: 'deferred',
          reason: 'personal_repo_diverged',
          why: REF_MOVED_AFTER_DENIED,
        };
      }
      if (d.kind === 'journal_unverified') {
        return { status: 'invalid', why: d.why, breaker: PERSONAL_REPO_INVALID };
      }
      return { status: 'denied', code: e.code };
    }
    await assertLocks(ctx); // 钩子是 async 现读:它之后到 update-ref 之间不得丢锁
  }
  const upd = git.run(['update-ref', 'refs/heads/rsi', commit, oldHead]);
  if (upd.status !== 0) {
    const actual = revParse(git, 'refs/heads/rsi');
    if (actual !== oldHead) return { status: 'cas_failed', expected: oldHead, actual };
    throw new PersonalGitError('update-ref', upd);
  }
  await ctx.onStep?.('after:update-ref');
  j = await writePhase(ctx, j, { phase: 'ref_updated' });

  await ctx.onStep?.('before:read-tree');
  await assertLocks(ctx);
  if (!syncWorktree(git, oldHead, commit)) {
    // git 拒绝覆盖与目标冲突的未提交改动:用户改动原样保留,journal 留在 ref_updated,按 diverged 处理
    return { status: 'deferred', reason: 'personal_repo_diverged', why: 'worktree_sync_refused' };
  }
  await ctx.onStep?.('after:read-tree');
  j = await writePhase(ctx, j, { phase: 'worktree_synced' });
  await recordHeadAndFinish(ctx, await writePhase(ctx, j, { phase: 'recorded' }));
  return { status: 'committed', commit, tree: targetTree };
}

// ---------------------------------------------------------------------------
// readPersonalFiles(W3 的读侧:权威副本 `lifecycle/<id>.json` 与原子文件)
// ---------------------------------------------------------------------------

export type ReadFilesResult =
  | { status: 'ok'; head: string; files: { path: string; content: string }[] }
  | { status: 'absent' }
  | { status: 'deferred'; reason: 'personal_repo_diverged' | 'personal_owner_changed'; why: string }
  | { status: 'invalid'; why: string; breaker: typeof PERSONAL_REPO_INVALID };

/**
 * 读已接受 HEAD 的树里某些顶层目录下的文件(只读 `ls-tree` / `cat-file`,不碰引用、索引与工作树)。调用方必须持 `personal/lock`。
 * 与 `commitPersonal` 走同一个 `openPersonalRepo`(结构校验 → journal 恢复 → HEAD 判定),所以 `absent` / `deferred` / `invalid` 的语义一致;
 * git 读取失败 = `invalid`(`git_read_failed`),**不会**当成「没有文件」返回空列表。放在本文件内,是为了私有仓库的 git 出口只在 W2 的三个授权文件里。
 */
export async function readPersonalFiles(
  deps: PersonalRepoDeps,
  locks: PersonalLocks,
  dirs: readonly string[],
): Promise<ReadFilesResult> {
  const open = await openPersonalRepo(deps, locks, { mode: 'read' });
  if (open.kind === 'absent') return { status: 'absent' };
  if (open.kind === 'invalid') return { status: 'invalid', why: open.why, breaker: open.breaker };
  if (open.kind === 'bootstrap_pending' || open.kind === 'bootstrap_denied') {
    return { status: 'invalid', why: open.kind, breaker: PERSONAL_REPO_INVALID };
  }
  if (open.kind === 'deferred') {
    return { status: 'deferred', reason: open.reason, why: open.why };
  }
  try {
    await assertLocks(open.ctx);
    const files: { path: string; content: string }[] = [];
    for (const b of readBaseTree(open.ctx.git, open.head)) {
      if (!dirs.some((d) => b.path.startsWith(`${d}/`))) continue;
      const content = gitMust(open.ctx.git, 'cat-file', ['cat-file', 'blob', b.sha], {
        readOnly: true,
      });
      files.push({ path: b.path, content });
    }
    return { status: 'ok', head: open.head, files };
  } catch (e) {
    if (e instanceof PersonalGitError || (e instanceof Error && !('code' in e))) {
      return { status: 'invalid', why: 'git_read_failed', breaker: PERSONAL_REPO_INVALID };
    }
    throw e;
  }
}

/**
 * 只读:读 `head.json` 记录的那个提交的树里某些顶层目录下的文件(R21-9.3a / R21-9.5:人工分叉 / 属主变化下,缩减入口仍要能列出候选并写撤销凭据)。
 * 与 `readPersonalFiles` 的区别:**不做** R21-3.5 判定(也不更新 `head.json`、不恢复 journal),只做结构校验(R21-3.4)与记录提交存在性检查,
 * 之后只 `ls-tree` / `cat-file` 那个提交的对象:不碰引用、索引、工作树。调用方必须持 `personal/lock`。
 * 记录缺失 / 不可读 / 提交不存在 → `invalid`(不当成「没有文件」);仓库与记录都从未建过 → `absent`。
 */
export async function readRecordedPersonalFiles(
  deps: PersonalRepoDeps,
  locks: PersonalLocks,
  dirs: readonly string[],
): Promise<ReadFilesResult> {
  if (locks.personal === undefined)
    throw new Error('readRecordedPersonalFiles: 必须持 personal/lock');
  const c = await makeCtx(deps, locks);
  await assertLocks(c);
  const hd = await readHead(deps.h);
  if (hd.kind === 'absent') {
    return (await probeFirstTime(deps.h)) === 'first'
      ? { status: 'absent' }
      : { status: 'invalid', why: 'record_missing', breaker: PERSONAL_REPO_INVALID };
  }
  if (hd.kind === 'invalid') {
    return { status: 'invalid', why: `head_${hd.why}`, breaker: PERSONAL_REPO_INVALID };
  }
  const s = await checkRepoStructure(
    deps.h,
    c.git,
    deps.uid === undefined ? {} : { uid: deps.uid },
  );
  if (!s.ok) return { status: 'invalid', why: s.why, breaker: PERSONAL_REPO_INVALID };
  const recorded = hd.value.head;
  try {
    if (revParse(c.git, `${recorded}^{commit}`) === null) {
      return { status: 'invalid', why: 'record_missing', breaker: PERSONAL_REPO_INVALID };
    }
    const files: { path: string; content: string }[] = [];
    for (const b of readBaseTree(c.git, recorded)) {
      if (!dirs.some((d) => b.path.startsWith(`${d}/`))) continue;
      files.push({
        path: b.path,
        content: gitMust(c.git, 'cat-file', ['cat-file', 'blob', b.sha], { readOnly: true }),
      });
    }
    return { status: 'ok', head: recorded, files };
  } catch (e) {
    if (e instanceof PersonalGitError || (e instanceof Error && !('code' in e))) {
      return { status: 'invalid', why: 'git_read_failed', breaker: PERSONAL_REPO_INVALID };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 只读检视与 head.json 改写(`rsi auto rebase-baseline` 的端口;`runSync` 的授权文件之一,所以 git 调用放在这里)
// ---------------------------------------------------------------------------

export type InspectResult =
  /** 仓库从未建过 */
  | { kind: 'absent' }
  | { kind: 'invalid'; why: string }
  | { kind: 'ok'; situation: RepoSituation; record: PersonalHeadRecord; head: string | null };
type PersonalHeadRecord = { head: string; owner_repo_fp: string };

/**
 * **只读**检视(锁外也安全,`rebase-baseline` 的展示 / 复核用):不建任何目录(封闭 git 配置的空目录只引用路径、**不创建**)、不写 `head.json`、不恢复 journal、
 * 全部 git 调用 `GIT_OPTIONAL_LOCKS=0`。有未处理的提交 journal = `invalid`(分类要先恢复,恢复要持锁:调用方先让一次持锁写入跑完);记录 / 结构不合规 = `invalid`。
 * 与 `openPersonalRepo` 的差别正是上面几项(它会写);判定本身共用 `checkRepoStructure` + `classifyRepo`。
 */
export async function inspectPersonalRepo(deps: PersonalRepoDeps): Promise<InspectResult> {
  const hd = await readHead(deps.h);
  if (hd.kind === 'absent') {
    return (await probeFirstTime(deps.h)) === 'first'
      ? { kind: 'absent' }
      : { kind: 'invalid', why: 'record_missing' };
  }
  if (hd.kind === 'invalid') return { kind: 'invalid', why: `head_${hd.why}` };
  const jr = await readJournal(deps.h);
  if (jr.kind === 'invalid') return { kind: 'invalid', why: `journal_${jr.why}` };
  if (jr.kind === 'ok') return { kind: 'invalid', why: 'journal_pending' };
  const now = deps.now ?? ((): Date => new Date());
  const git = createClosedGit(deps.h, statePath(deps.h, PERSONAL_STATE_FILES.emptyDir), now);
  const s = await checkRepoStructure(deps.h, git, deps.uid === undefined ? {} : { uid: deps.uid });
  if (!s.ok) return { kind: 'invalid', why: s.why };
  try {
    const situation = await classifyRepo(git, hd.value, deps.ownerRepoFp);
    return { kind: 'ok', situation, record: hd.value, head: revParse(git, 'HEAD^{commit}') };
  } catch (e) {
    if (e instanceof PersonalGitError) return { kind: 'invalid', why: 'git_read_failed' };
    throw e;
  }
}

/** `记录..HEAD` 的相对路径(只读;未清洗;git 读取失败 / 记录不可读 = 抛错) */
export async function changedPathsSinceRecord(deps: PersonalRepoDeps): Promise<string[]> {
  const hd = await readHead(deps.h);
  if (hd.kind !== 'ok') throw new Error('head_unreadable');
  const now = deps.now ?? ((): Date => new Date());
  const git = createClosedGit(deps.h, statePath(deps.h, PERSONAL_STATE_FILES.emptyDir), now);
  const out = gitMust(
    git,
    'diff',
    [
      'diff',
      '--name-only',
      '-z',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      `${hd.value.head}..HEAD`,
    ],
    { readOnly: true },
  );
  return out.split('\0').filter((x) => x !== '');
}

/** `head.json` 当前是否满足改写的后置条件(只读;`baseline` = 记录的提交等于当前 HEAD;`owner` = 记录的 `owner_repo_fp` 等于当前指纹) */
export async function personalHeadRewritten(
  deps: PersonalRepoDeps,
  kind: 'baseline' | 'owner',
): Promise<boolean> {
  const hd = await readHead(deps.h);
  if (hd.kind !== 'ok') throw new Error(`head_${hd.kind === 'invalid' ? hd.why : 'absent'}`);
  if (kind === 'owner') return hd.value.owner_repo_fp === deps.ownerRepoFp;
  const now = deps.now ?? ((): Date => new Date());
  const git = createClosedGit(deps.h, statePath(deps.h, PERSONAL_STATE_FILES.emptyDir), now);
  return revParse(git, 'HEAD^{commit}') === hd.value.head;
}

/**
 * 改写 `head.json`(持 `personal/lock`):`baseline` = 记录提交换成 `expectHead`(须仍是当前 HEAD,否则抛 `head_changed`);
 * `owner` = `owner_repo_fp` 换成当前 `[rsi] repo` 的指纹(`expectHead` 同样须仍是当前 HEAD)。其余字段原样保留。
 * **顺序**:开头锁复核 → `await readHead` → 备好写入内容 → **读后锁复核**(最后一个 `await`)→ 同步 HEAD 复核(`revParse`)→ `writeHead`;
 * 提交前一定有一次晚于 `readHead` 的锁复核(读期间丢锁 → `lock_lost`,零写入),HEAD 复核与 `writeHead` 之间没有让出点(锁复核放在 HEAD 复核之前,不是之后)。
 * **并发边界(如实)**:`personal/lock` 只排除遵守项目锁的写者;不遵守项目锁的人工 git 操作与「复核 → 写入」之间仍有窗口,
 * 所以本函数**不保证**「HEAD 已变则零写入」——只保证:复核时 HEAD 已变则抛 `head_changed` 且零写入;写入后的一致性由调用方写后复核
 * (`rebase.ts`:写后情形不是 `ok` → 保持暂停、不清标志、不报完成)。
 */
export async function rewritePersonalHead(
  deps: PersonalRepoDeps,
  locks: PersonalLocks,
  kind: 'baseline' | 'owner',
  expectHead: string,
): Promise<void> {
  await assertLockHandles(locks);
  const hd = await readHead(deps.h);
  if (hd.kind !== 'ok') throw new Error(`head_${hd.kind === 'invalid' ? hd.why : 'absent'}`);
  const now = deps.now ?? ((): Date => new Date());
  const git = createClosedGit(deps.h, statePath(deps.h, PERSONAL_STATE_FILES.emptyDir), now);
  // 写入内容先备好(同步):其后只剩「锁复核(await)→ 同步 HEAD 复核 → 写入」
  const next = PersonalHeadSchema.parse({
    schema_version: 1,
    head: kind === 'baseline' ? expectHead : hd.value.head,
    owner_repo_fp: kind === 'owner' ? deps.ownerRepoFp : hd.value.owner_repo_fp,
  });
  await assertLockHandles(locks); // 读后锁复核:读 head.json 期间丢锁 → lock_lost,零写入
  // 最后一次复核:同步 revParse,紧贴写入,二者之间没有 await 让出
  if (revParse(git, 'HEAD^{commit}') !== expectHead) throw new Error('head_changed');
  await writeHead(deps.h, next);
}
