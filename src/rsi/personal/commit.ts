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
import { PersonalHeadSchema } from '../../contracts/rsi-personal.js';
import type { RsiAutoPauseReason } from '../../contracts/rsi.js';
import {
  ensureEmptyDir,
  probeFirstTime,
  readHead,
  readJournal,
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
} from './repo-check.js';

export type { PersonalLocks, StepHook } from './commit-journal.js';

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
 * 持 `personal/lock` 者的入口。`bootstrap = true` 时,证明为首次(W0-5)则自动建仓;否则返回 `absent`。
 * 顺序固定:journal(bootstrap 先恢复)→ 首次证明 → R21-3.4 结构校验 → R21-3.6a 恢复(先于 3.5)→ R21-3.5 判定 → 情形①更新记录。
 */
export async function openPersonalRepo(
  deps: PersonalRepoDeps,
  locks: PersonalLocks,
  opts: { bootstrap?: boolean } = {},
): Promise<OpenResult> {
  if (locks.personal === undefined) throw new Error('openPersonalRepo: 必须持 personal/lock');
  const c = await makeCtx(deps, locks);
  await assertLocks(c);

  const jr = await readJournal(deps.h);
  if (jr.kind === 'invalid') return invalid(`journal_${jr.why}`);
  let journal = jr.kind === 'ok' ? jr.value : null;

  if (journal !== null && journal.kind === 'bootstrap') {
    const r = await recoverBootstrap(c, journal);
    if (r.status === 'invalid') return invalid(r.why);
    journal = null; // created(已记录并删 journal)/ discarded(什么也没建)
  }

  if (journal === null && (await probeFirstTime(deps.h)) === 'first') {
    if (opts.bootstrap !== true) return { kind: 'absent' };
    const r = await bootstrapRepo(c);
    if (r.status !== 'created') {
      return invalid(r.status === 'invalid' ? r.why : 'bootstrap_discarded');
    }
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
  | { status: 'cas_failed'; expected: string; actual: string | null };

export async function commitPersonal(
  deps: PersonalRepoDeps,
  locks: PersonalLocks,
  spec: TreeSpec,
): Promise<CommitResult> {
  const open = await openPersonalRepo(deps, locks);
  if (open.kind === 'absent') return { status: 'absent' };
  if (open.kind === 'invalid') {
    return { status: 'invalid', why: open.why, breaker: open.breaker };
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
  const open = await openPersonalRepo(deps, locks);
  if (open.kind === 'absent') return { status: 'absent' };
  if (open.kind === 'invalid') return { status: 'invalid', why: open.why, breaker: open.breaker };
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
