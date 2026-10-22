/**
 * `agent-kit sync [--agent <id>]… [--write] [--overwrite-drifted] [--json] [--home <dir>]
 *                 [--rollback <txn_id> | --resume | --uninstall | --adopt]`(S4,docs/contracts.md §19.2)。
 *
 * - **默认干跑**:只读磁盘与包内 payload,打印计划,不写任何文件、不建 `~/.local/state`;`--write` 以外绝不写。
 *   干跑行:`would <op> ~/<受管路径> sha256=<前12位> agents=<a,b>`(托管块操作末尾另有 `block=<id>`);`--write` 后行首换 `did`。
 * - **HOME**:缺省 `getRealHome()`;`--home` 只接受真实 HOME 或 KIT_TMP 严格之内的目录,否则退出 2 `home_not_allowed`。
 *   所有写盘经 `src/io/home-fs.ts`(由 `src/sync/apply.ts` 调用),本文件不 import 它。
 * - **payload**:从包内 `payload/` 读,使用前用包根 `integrity.json` 逐文件核对(缺失 / 篡改 → 退出 3 `SYNC_PAYLOAD_INVALID`);
 *   没有 payload → 退出 4 `SYNC_NO_PAYLOAD`。`KIT_PAYLOAD_DIR`(经 ctx.env 注入,且必须在 KIT_TMP 之内)只给测试夹具用。
 * - **v1 不执行 migrations**:payload.migrations 非空 → 退出 3 `SYNC_MIGRATION_UNSUPPORTED`(不写任何东西)。
 * - 退出码:0 完成或无变更;1 有漂移 / 外来 / 独占目录非登记文件被跳过(其余条目照常处理);2 用法;
 *   3 fail-closed(预检被拒、写出口拒绝、残留事务、登记表 / payload 损坏、回滚前提不成立、migrations 不支持);4 没有 payload、锁被占。
 * - stdout 只含计数、枚举、事务 id、哈希前缀、写死的受管相对路径(`--json` 为 canonical JSON);
 *   stderr 只含稳定码 `SYNC_<USAGE|CHECK_FAILED|NOT_RUN|FAIL_CLOSED> reason=<码>`,绝不回显文件内容 / 异常消息 / 绝对路径。
 */
import {
  DEFAULT_SYNC_AGENTS,
  SYNC_AGENT_CHOICES,
  SYNC_CHECK_FAILED_REASONS,
  SYNC_FAIL_CLOSED_REASONS,
  SYNC_NOT_RUN_REASONS,
  TXN_ID_RE,
  isHomeWritePath,
} from '../contracts/sync.js';
import type { RenderAgentId } from '../contracts/common.js';
import { ExitCode } from '../contracts/exit-codes.js';
import { canonicalJson } from '../io/canonical-json.js';
import { getRealHome } from '../io/paths.js';
import {
  ApplyError,
  acquireLock,
  applyPlan as applyPlanToDisk,
  freshTxnId,
  isHomeDenied,
  resumeTxn,
  rollbackTxn,
  tightenStateDir,
  type ApplyDeps,
  type ApplyEnv,
} from '../sync/apply.js';
import { OWNED_DIRS } from '../sync/classify.js';
import { SyncPayloadError, loadPayload, resolvePayloadRoot } from '../sync/payload-load.js';
import { planSync } from '../sync/plan.js';
import {
  buildDiskSnapshot,
  listResidualTxns,
  readLedger,
  resolveAllowedHome,
  stateDirUnsafe,
  type LedgerRead,
  type SnapshotResult,
} from '../sync/snapshot.js';
import { TxnError } from '../sync/txn.js';
import { WRITE_OPS, type PlanOp, type SyncPlan } from '../sync/types.js';
import type { LoadedPayload } from '../sync/payload-load.js';
import type { SyncLedger } from '../contracts/sync.js';
import type { EnvCommandContext } from './reflect.js';
import type { CommandContext, CommandDef } from './types.js';

export type SyncCommandDeps = ApplyDeps;

/** 契约 §19.2 追加(S4):v1 不执行 migrations。 */
export const SYNC_MIGRATION_UNSUPPORTED = 'SYNC_MIGRATION_UNSUPPORTED';

type Mode = 'sync' | 'rollback' | 'resume' | 'uninstall' | 'adopt';

interface Parsed {
  agents: RenderAgentId[];
  write: boolean;
  overwriteDrifted: boolean;
  json: boolean;
  home: string | undefined;
  mode: Mode;
  rollbackId: string | undefined;
  error: string | undefined;
}

function parseArgs(argv: readonly string[]): Parsed {
  const out: Parsed = {
    agents: [],
    write: false,
    overwriteDrifted: false,
    json: false,
    home: undefined,
    mode: 'sync',
    rollbackId: undefined,
    error: undefined,
  };
  const modes: Mode[] = [];
  const fail = (m: string): void => {
    out.error ??= m;
  };
  const agentSet = new Set<RenderAgentId>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const value = (name: string): string | undefined => {
      if (a === name) {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) {
          fail(name === '--rollback' ? 'missing:--rollback' : `unknown_arg`);
          return undefined;
        }
        i++;
        return v;
      }
      if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
      return undefined;
    };
    if (a === '--write') out.write = true;
    else if (a === '--overwrite-drifted') out.overwriteDrifted = true;
    else if (a === '--json') out.json = true;
    else if (a === '--resume') modes.push('resume');
    else if (a === '--uninstall') modes.push('uninstall');
    else if (a === '--adopt') modes.push('adopt');
    else if (a === '--rollback' || a.startsWith('--rollback=')) {
      modes.push('rollback');
      const v = value('--rollback');
      if (v === undefined) fail('missing:--rollback');
      else out.rollbackId = v;
    } else if (a === '--agent' || a.startsWith('--agent=')) {
      const v = value('--agent');
      if (v === undefined) {
        fail('bad_agent');
        continue;
      }
      for (const part of v.split(',')) {
        if (!(SYNC_AGENT_CHOICES as readonly string[]).includes(part)) fail('bad_agent');
        else agentSet.add(part as RenderAgentId);
      }
    } else if (a === '--home' || a.startsWith('--home=')) {
      const v = value('--home');
      if (v === undefined) fail('unknown_arg');
      else out.home = v;
    } else fail('unknown_arg');
  }
  out.agents = [...agentSet];
  if (modes.length > 1) fail('mode_conflict');
  out.mode = modes[0] ?? 'sync';
  if (out.mode === 'rollback' && out.rollbackId !== undefined && !TXN_ID_RE.test(out.rollbackId)) {
    fail('bad_txn_id');
  }
  if (out.overwriteDrifted && !out.write) fail('overwrite_requires_write');
  return out;
}

class Exit extends Error {
  constructor(
    readonly code: number,
    readonly tag: 'USAGE' | 'CHECK_FAILED' | 'NOT_RUN' | 'FAIL_CLOSED',
    readonly reason: string,
  ) {
    super(reason);
  }
}

const SAFE_PATH_RE = /^[\x21-\x7e]+$/;
const CHECK = new Set<string>(SYNC_CHECK_FAILED_REASONS);
const FAIL = new Set<string>(SYNC_FAIL_CLOSED_REASONS);
const NOTRUN = new Set<string>(SYNC_NOT_RUN_REASONS);

/** 只打印写死的受管相对路径:不在 HOME 写入表内、或含非可见 ASCII 的一律不原样输出。 */
function printable(p: string): string {
  return SAFE_PATH_RE.test(p) && isHomeWritePath(p) ? `~/${p}` : '~/<path>';
}

const sha12 = (s: string | null | undefined): string =>
  s === null || s === undefined ? '-' : s.slice(0, 12);

function opSha(o: PlanOp): string | null | undefined {
  return WRITE_OPS.includes(o.op) && o.op !== 'remove' && o.op !== 'block_remove'
    ? o.shaAfter
    : o.shaBefore;
}

function opLines(plan: SyncPlan, verb: string): string[] {
  const lines: string[] = [];
  let unmanaged = 0;
  for (const o of plan.ops) {
    if (o.op === 'unmanaged_keep') {
      unmanaged += 1; // 用户文件名不原样输出,只给计数
      continue;
    }
    const block = o.blockId !== undefined ? ` block=${o.blockId}` : '';
    lines.push(
      `${verb} ${o.op} ${printable(o.path)} sha256=${sha12(opSha(o))} agents=${o.agents.join(',') || '-'}${block}`,
    );
  }
  if (unmanaged > 0) {
    lines.push(
      `${verb} unmanaged_keep ${OWNED_DIRS.map((d) => `~/${d}`).join(',')} count=${unmanaged}`,
    );
  }
  return lines;
}

function summaryLines(plan: SyncPlan): string[] {
  const s = plan.summary;
  return [
    `plan create=${s.create} update=${s.update} remove=${s.remove} block_upsert=${s.block_upsert} block_remove=${s.block_remove} skip_drifted=${s.skip_drifted} refuse_foreign=${s.refuse_foreign}`,
    `plan_other adopt=${s.adopt} orphan_keep=${s.orphan_keep} unmanaged_keep=${s.unmanaged_keep} refuse_all=${s.refuse_all}`,
    `skippedLayers ${plan.skippedLayers.join(',') || '-'}`,
  ];
}

function emitCodes(ctx: CommandContext, codes: readonly string[]): void {
  for (const c of codes) {
    const tag = CHECK.has(c)
      ? 'CHECK_FAILED'
      : FAIL.has(c)
        ? 'FAIL_CLOSED'
        : NOTRUN.has(c)
          ? 'NOT_RUN'
          : 'FAIL_CLOSED';
    ctx.stderr(`SYNC_${tag} reason=${c}\n`);
  }
}

function jsonOps(plan: SyncPlan): Record<string, unknown>[] {
  return plan.ops
    .filter((o) => o.op !== 'unmanaged_keep')
    .map((o) => ({
      op: o.op,
      path: SAFE_PATH_RE.test(o.path) && isHomeWritePath(o.path) ? o.path : null,
      block_id: o.blockId ?? null,
      sha256_12: sha12(opSha(o)),
      agents: [...o.agents],
      code: o.code ?? null,
    }));
}

const emptyPlanSha = '0'.repeat(64);

function fromError(e: unknown): Exit {
  if (e instanceof Exit) return e;
  if (e instanceof SyncPayloadError) {
    return e.code === 'SYNC_NO_PAYLOAD'
      ? new Exit(ExitCode.NOT_RUN, 'NOT_RUN', e.code)
      : new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', e.code);
  }
  if (e instanceof ApplyError) {
    return e.code === 'SYNC_LOCKED'
      ? new Exit(ExitCode.NOT_RUN, 'NOT_RUN', e.code)
      : new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', e.code);
  }
  if (e instanceof TxnError) return new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', e.code);
  if (isHomeDenied(e)) {
    return new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'SYNC_WRITE_DENIED');
  }
  return new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'SYNC_WRITE_DENIED');
}

export function createSyncCommand(deps: SyncCommandDeps = {}): CommandDef {
  const def: CommandDef = {
    name: 'sync',
    summary: '把包内预渲染产物同步到本机 HOME(默认干跑;--write 才写,经登记表 + 事务 + 备份)',
    phase: 'P2',
    ownerBlock: 'S4',
    flags: [
      {
        name: '--agent <id>',
        description: `可重复;缺省 ${DEFAULT_SYNC_AGENTS.join(',')};kimi / opencode 须显式指定`,
      },
      { name: '--write', description: '真的写(缺省干跑,零写入)' },
      { name: '--overwrite-drifted', description: '覆盖用户手改过的登记文件(先备份;需要 --write)' },
      { name: '--json', description: 'stdout 输出 canonical JSON' },
      {
        name: '--rollback <txn_id>',
        description: '用备份恢复该事务(前提:文件当前 sha 等于该事务写入后的 sha)',
      },
      { name: '--resume', description: '继续残留事务' },
      { name: '--uninstall', description: '卸载所选 agent 的登记条目(只删登记过且未漂移的)' },
      { name: '--adopt', description: '登记表丢失时认领内容等于 payload 同路径的文件' },
      { name: '--home <dir>', description: '只接受真实 HOME 或 KIT_TMP 之内的目录' },
    ],
    async run(ctx: CommandContext): Promise<number> {
      const args = parseArgs(ctx.argv);
      const env = (ctx as EnvCommandContext).env;
      try {
        if (args.error !== undefined) throw new Exit(ExitCode.USAGE, 'USAGE', args.error);
        const homeArg = args.home ?? getRealHome(env);
        const homeReal = await resolveAllowedHome(homeArg, ctx.io.tmpDir, env);
        if (homeReal === undefined) throw new Exit(ExitCode.USAGE, 'USAGE', 'home_not_allowed');
        const aenv: ApplyEnv = {
          home: homeReal,
          homeReal,
          tmpDir: ctx.io.tmpDir,
          env,
          deps,
        };
        if (await stateDirUnsafe(homeReal)) {
          throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'SYNC_PATH_SYMLINK');
        }
        if (args.mode === 'rollback') return await runRollback(ctx, args, aenv);
        if (args.mode === 'resume') return await runResume(ctx, args, aenv);
        return await runPlan(ctx, args, aenv);
      } catch (e) {
        let x = fromError(e);
        // 写到一半出错且事务 journal 已落盘:统一报 SYNC_TXN_INCOMPLETE(下次拒绝,可 --resume / --rollback)
        if (!(e instanceof Exit) && x.reason === 'SYNC_WRITE_DENIED') {
          x = await residualAware(ctx, env, args, x);
        }
        ctx.stderr(`SYNC_${x.tag} reason=${x.reason}\n`);
        return x.code;
      }
    },
  };

  /** 事务 journal 已在盘上 → 报 SYNC_TXN_INCOMPLETE;否则保持原码。 */
  async function residualAware(
    _ctx: CommandContext,
    env: EnvCommandContext['env'],
    args: Parsed,
    x: Exit,
  ): Promise<Exit> {
    try {
      const home = args.home ?? getRealHome(env);
      const real = await resolveAllowedHome(home, _ctx.io.tmpDir, env);
      if (real !== undefined && (await listResidualTxns(real)).length > 0) {
        return new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'SYNC_TXN_INCOMPLETE');
      }
    } catch {
      // 保持原码
    }
    return x;
  }

  interface Gathered {
    payload: LoadedPayload | null;
    ledgerRead: LedgerRead;
    snap: SnapshotResult;
    plan: SyncPlan;
  }

  async function gather(
    args: Parsed,
    aenv: ApplyEnv,
    payload: LoadedPayload | null,
    txnId: string,
  ): Promise<Gathered> {
    const ledgerRead = await readLedger(aenv.homeReal);
    if (ledgerRead.state === 'unsafe') {
      throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'SYNC_PATH_NOT_REGULAR');
    }
    const ledger: SyncLedger | null =
      ledgerRead.state === 'ok'
        ? ledgerRead.ledger
        : ledgerRead.state === 'invalid'
          ? ({} as SyncLedger) // 非法登记表:计划器按 SYNC_LEDGER_INVALID 整次拒绝
          : null;
    const paths = new Set<string>();
    const blockIds: Record<string, string[]> = {};
    const addBlock = (p: string, id: string | undefined): void => {
      if (id === undefined) return;
      const list = (blockIds[p] ??= []);
      if (!list.includes(id)) list.push(id);
    };
    for (const f of payload?.manifest.files ?? []) {
      if (f.target !== 'home') continue;
      paths.add(f.path);
      addBlock(f.path, f.block_id);
    }
    const ledgerPaths: string[] = [];
    if (ledgerRead.state === 'ok') {
      for (const e of ledgerRead.ledger.entries) {
        paths.add(e.path);
        ledgerPaths.push(e.path);
        addBlock(e.path, e.block_id);
      }
    }
    const snap = await buildDiskSnapshot({
      home: aenv.homeReal,
      paths: [...paths],
      blockIds,
      ledgerPaths,
      ownedDirs: OWNED_DIRS,
    });
    const plan = planSync({
      payload: payload?.manifest ?? null,
      payloadSha256: payload?.manifestSha256 ?? emptyPlanSha,
      payloadSha: payload?.payloadSha ?? {},
      ledger,
      disk: snap.snapshot,
      options: {
        agents: args.agents.length > 0 ? args.agents : [...DEFAULT_SYNC_AGENTS],
        overwriteDrifted: args.overwriteDrifted,
        uninstall: args.mode === 'uninstall',
        adopt: args.mode === 'adopt',
        txnId,
      },
    });
    return { payload, ledgerRead, snap, plan };
  }

  function hasChanges(plan: SyncPlan): boolean {
    return plan.ops.some((o) => WRITE_OPS.includes(o.op)) || plan.ledger.action !== 'none';
  }

  function report(
    ctx: CommandContext,
    args: Parsed,
    plan: SyncPlan,
    wrote: boolean,
    txn: string | undefined,
    files: number,
  ): number {
    const verb = plan.status !== 'ok' ? 'refused' : wrote ? 'did' : 'would';
    if (args.json) {
      ctx.stdout(
        canonicalJson({
          mode: args.mode,
          dry: !wrote,
          status: plan.status,
          exit: plan.exit,
          ops: jsonOps(plan),
          codes: [...plan.codes],
          summary: plan.summary,
          ledger: plan.ledger.action,
          skippedLayers: [...plan.skippedLayers],
          txn: txn ?? null,
          files,
        }),
      );
    } else {
      const lines = [...opLines(plan, verb), ...summaryLines(plan)];
      if (txn !== undefined) lines.push(`txn ${txn}`);
      ctx.stdout(`${lines.join('\n')}\n`);
    }
    emitCodes(ctx, plan.codes);
    return plan.exit;
  }

  /** D14 的写入例外:状态目录宽于 0700 时收紧(干跑只报);结果走 stderr,不改 stdout / --json 键集合。 */
  async function reportStateDirTighten(
    ctx: CommandContext,
    aenv: ApplyEnv,
    write: boolean,
  ): Promise<void> {
    const r = await tightenStateDir(aenv, write);
    if (r.result === 'tightened') {
      const from = r.from.toString(8).padStart(4, '0');
      ctx.stderr(
        `SYNC_STATE_DIR ${r.applied ? 'tightened' : 'would_tighten'} from=${from} to=0700\n`,
      );
    } else if (r.result === 'skipped_foreign_owner' || r.result === 'skipped_unsafe') {
      const reason = r.result === 'skipped_unsafe' ? 'link_or_not_dir' : 'foreign_owner';
      ctx.stderr(`SYNC_STATE_DIR_SKIPPED reason=${reason}\n`);
    }
  }

  async function runPlan(ctx: CommandContext, args: Parsed, aenv: ApplyEnv): Promise<number> {
    let payload: LoadedPayload | null = null;
    if (args.mode !== 'uninstall') {
      const root = await resolvePayloadRoot(aenv.env, aenv.tmpDir);
      payload = await loadPayload(root);
      if (payload.manifest.migrations.length > 0) {
        throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', SYNC_MIGRATION_UNSUPPORTED);
      }
    }
    // 同一个事务 id 贯穿规划与落盘:登记表条目里记的 txn 必须就是实际落盘的那个事务
    const txnId = freshTxnId(aenv);
    const first = await gather(args, aenv, payload, txnId);
    // 状态目录收紧(D14 例外,§19.2.2):干跑只报;写入只在「计划 ok 且已拿锁并在锁内重新规划仍 ok」之后做
    if (!args.write) {
      await reportStateDirTighten(ctx, aenv, false);
      return report(ctx, args, first.plan, false, undefined, 0);
    }
    if (first.plan.status !== 'ok') return report(ctx, args, first.plan, false, undefined, 0);
    if (!hasChanges(first.plan)) {
      // 无其它变更:仅当状态目录确需收紧时才拿锁(无锁预检只读,幂等运行仍零写入、不拿锁)
      if ((await tightenStateDir(aenv, false)).result === 'tightened') {
        const lock = await acquireLock(aenv);
        try {
          const g = await gather(args, aenv, payload, txnId);
          if (g.plan.status === 'ok') await reportStateDirTighten(ctx, aenv, true);
          return report(ctx, args, g.plan, false, undefined, 0);
        } finally {
          await lock.release().catch(() => undefined);
        }
      }
      return report(ctx, args, first.plan, false, undefined, 0);
    }
    // 有东西要写:先拿锁,再在锁内重读登记表 / 磁盘并重新规划(幂等运行不拿锁,零写入)
    const lock = await acquireLock(aenv);
    try {
      const g = await gather(args, aenv, payload, txnId);
      if (g.plan.status !== 'ok') return report(ctx, args, g.plan, false, undefined, 0);
      if (!hasChanges(g.plan)) {
        await reportStateDirTighten(ctx, aenv, true);
        return report(ctx, args, g.plan, false, undefined, 0);
      }
      await reportStateDirTighten(ctx, aenv, true);
      const res = await applyPlanToDisk(aenv, {
        action: args.mode === 'uninstall' ? 'uninstall' : args.mode === 'adopt' ? 'adopt' : 'sync',
        plan: g.plan,
        payload: g.payload,
        snapshot: g.snap,
        ledgerRead: g.ledgerRead,
        txnId,
        lock,
      });
      return report(ctx, args, g.plan, true, res.txnId, res.files);
    } finally {
      await lock.release().catch(() => undefined);
    }
  }

  async function runRollback(ctx: CommandContext, args: Parsed, aenv: ApplyEnv): Promise<number> {
    const id = args.rollbackId as string;
    const emit = (r: Awaited<ReturnType<typeof rollbackTxn>>, wrote: boolean): number => {
      const verb = wrote ? 'did' : 'would';
      if (args.json) {
        ctx.stdout(
          canonicalJson({
            mode: 'rollback',
            dry: !wrote,
            source_txn: r.sourceTxn,
            kind: r.kind,
            restore: r.restore.map((x) => ({ op: x.op, path: x.path })),
            ledger_restore: r.ledgerRestore,
            txn: r.txnId ?? null,
          }),
        );
      } else {
        const lines = r.restore.map((x) => `${verb} restore_${x.op} ${printable(x.path)}`);
        if (r.ledgerRestore) lines.push(`${verb} restore_ledger`);
        lines.push(`rollback source=${r.sourceTxn} kind=${r.kind} files=${r.restore.length}`);
        if (r.txnId !== undefined) lines.push(`txn ${r.txnId}`);
        ctx.stdout(`${lines.join('\n')}\n`);
      }
      return ExitCode.OK;
    };
    if (!args.write) return emit(await rollbackTxn(aenv, id, false, freshTxnId(aenv)), false);
    const lock = await acquireLock(aenv);
    try {
      return emit(await rollbackTxn(aenv, id, true, freshTxnId(aenv), lock), true);
    } finally {
      await lock.release().catch(() => undefined);
    }
  }

  async function runResume(ctx: CommandContext, args: Parsed, aenv: ApplyEnv): Promise<number> {
    const emit = (r: Awaited<ReturnType<typeof resumeTxn>>, wrote: boolean): number => {
      const verb = wrote ? 'did' : 'would';
      if (args.json) {
        ctx.stdout(
          canonicalJson({
            mode: 'resume',
            dry: !wrote,
            txn: r.txn,
            pending: r.pending.map((p) => (isHomeWritePath(p) ? p : null)),
            done: r.done.map((p) => (isHomeWritePath(p) ? p : null)),
          }),
        );
      } else {
        const lines = [
          ...r.pending.map((p) => `${verb} resume_write ${printable(p)}`),
          ...r.done.map((p) => `already_done ${printable(p)}`),
          `resume txn=${r.txn ?? '-'} pending=${r.pending.length} done=${r.done.length}`,
        ];
        ctx.stdout(`${lines.join('\n')}\n`);
      }
      return ExitCode.OK;
    };
    if (!args.write) return emit(await resumeTxn(aenv, false), false);
    const lock = await acquireLock(aenv);
    try {
      return emit(await resumeTxn(aenv, true, lock), true);
    } finally {
      await lock.release().catch(() => undefined);
    }
  }

  return def;
}

export const command: CommandDef = createSyncCommand();
