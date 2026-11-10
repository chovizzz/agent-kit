/**
 * 私有仓库提交原语 `commitPersonal`(contracts §21.3 R21-3.6;`runSync` 的三个授权文件之一,git 经 `repo-check.ts` 的封闭执行配置)。
 *
 * 调用方必须持 `personal/lock`(正常路径另持 `rsi/lock`,缩减入口下不持)。流程(每个提交点前 `assertHeld`,journal 见 `commit-journal.ts`):
 *   打开仓库(结构校验 R21-3.4 → journal 恢复 R21-3.6a → HEAD 判定 R21-3.5;只在情形①才继续,否则返回 `deferred`,R21-9.3a)
 *   → `hash-object -w --no-filters`、`mktree` 重建**整棵**目标树(候选集合 + 内容寻址快照)→ journal `planned`
 *   → `commit-tree` → journal `objects_written` → `update-ref refs/heads/rsi <新> <旧>`(带期望旧值的原子比较交换)→ journal `ref_updated`
 *   → `read-tree -m -u <旧> <新>`(两树合并同步工作树,**不用 `--reset`**:有冲突的未提交改动时 git 拒绝覆盖,按 `personal_repo_diverged` 处理)
 *   → journal `worktree_synced` → `recorded` → 写 `head.json` → 删 journal。
 * 不依赖 `git revert`,不用 `add` / `commit` 的高层路径;作者与提交者固定为 `RSI_PERSONAL_AUTHOR`。
 * 树约束(R21-3.1):顶层只许布局目录;任何位置不得出现 `.` 开头的名字(含 `.gitattributes` / `.gitmodules` / `.git`),文件一律 `100644`(无符号链接、无可执行位)。
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
  /** 完整的目标树(不是增量) */
  files: readonly TreeFile[];
  message?: string;
}

export class TreeSpecError extends Error {
  readonly code = 'RSI_PERSONAL_TREE_SPEC';
}

/** R21-3.1 布局的顶层目录 */
const TOP_DIRS: ReadonlySet<string> = new Set([
  'rules',
  'pitfalls',
  'methods',
  'agents',
  'capabilities',
  'exec',
  'cases',
  'lifecycle',
]);
/** 每一段必须以字母数字开头(所以 `.gitattributes` / `.gitmodules` / `.git` / `.` / `..` 都不可能出现) */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

interface DirNode {
  files: Map<string, string>;
  dirs: Map<string, DirNode>;
}

function validateSpec(spec: TreeSpec): DirNode {
  if (!/^[0-9a-f]{16}$/.test(spec.txnId)) throw new TreeSpecError('txnId 必须是 16 位十六进制');
  const root: DirNode = { files: new Map(), dirs: new Map() };
  const seen = new Set<string>();
  for (const f of spec.files) {
    const segs = f.path.split('/');
    if (segs.length < 2) throw new TreeSpecError(`顶层不许放文件:${f.path}`);
    if (!TOP_DIRS.has(segs[0] as string)) throw new TreeSpecError(`不在 R21-3.1 布局内:${f.path}`);
    for (const s of segs) {
      if (!SEGMENT_RE.test(s)) throw new TreeSpecError(`路径段不合法:${f.path}`);
    }
    const low = f.path.toLowerCase();
    if (seen.has(low)) throw new TreeSpecError(`重复路径(不区分大小写):${f.path}`);
    seen.add(low);
    let node = root;
    for (const dir of segs.slice(0, -1)) {
      if (node.files.has(dir)) throw new TreeSpecError(`文件与目录同名:${f.path}`);
      let next = node.dirs.get(dir);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(dir, next);
      }
      node = next;
    }
    const leaf = segs[segs.length - 1] as string;
    if (node.dirs.has(leaf)) throw new TreeSpecError(`文件与目录同名:${f.path}`);
    node.files.set(leaf, f.content);
  }
  return root;
}

/** 写 blob(`--no-filters`)与各层 tree,返回根树 sha。对象写进 odb 但没有引用,崩溃无害。 */
function writeTree(git: ClosedGit, node: DirNode): string {
  const lines: string[] = [];
  for (const [name, content] of node.files) {
    const sha = gitMust(git, 'hash-object', ['hash-object', '-w', '--no-filters', '--stdin'], {
      input: content,
    });
    lines.push(`100644 blob ${sha}\t${name}`);
  }
  for (const [name, child] of node.dirs) {
    lines.push(`040000 tree ${writeTree(git, child)}\t${name}`);
  }
  return gitMust(git, 'mktree', ['mktree'], {
    input: lines.length === 0 ? '' : `${lines.join('\n')}\n`,
  });
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

async function makeCtx(deps: PersonalRepoDeps, locks: PersonalLocks): Promise<OpCtx> {
  const now = deps.now ?? ((): Date => new Date());
  const emptyDir = await ensureEmptyDir(deps.h);
  return {
    h: deps.h,
    git: createClosedGit(deps.h, emptyDir, now),
    locks,
    now,
    ownerRepoFp: deps.ownerRepoFp,
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

  const s = await checkRepoStructure(deps.h, c.git, deps.uid === undefined ? {} : { uid: deps.uid });
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
  /** `update-ref` 的期望旧值不符(并发的第二个提交者):没有任何引用 / 索引 / 工作树被改 */
  | { status: 'cas_failed'; expected: string; actual: string | null };

export async function commitPersonal(
  deps: PersonalRepoDeps,
  locks: PersonalLocks,
  spec: TreeSpec,
): Promise<CommitResult> {
  const tree = validateSpec(spec);
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
  const targetTree = writeTree(git, tree);
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
  await writePhase(ctx, j, { phase: 'recorded' });
  await recordHeadAndFinish(ctx, commit);
  return { status: 'committed', commit, tree: targetTree };
}
