/**
 * `agent-kit rsi hooks (--print | --install | --uninstall | --restore <txn_id> | --discard-residue <txn_id> | --prune-backups)
 *   [--agent <claude|codex|pi>] [--write] [--json]`(contracts §20.15,N1;A5)。
 *
 * - 六个模式互斥;除 `--prune-backups` 外都必须给 `--agent`;`--print` 不接受 `--write`;其余模式不带 `--write` 是干跑(只打印将做的事,零写调用)。
 * - **自动路径永不调用**(R20-15.3):本目录只被分发器 `src/commands/rsi.ts` 引用;poke / hint / worker / kit-schedule 的 import 闭包不含它(测试钉住)。
 * - **状态无关**(R20-15.4):不要求 `[rsi] enabled` 或有效的 `[rsi] repo`,不读 rsi 配置、不建 `.state/rsi/`、不改变任何 rsi 状态。
 * - `--write`:前台、TTY、逐次确认(R20-15.18)。顺序:读 → 算计划 → 打印摘要并要求 `yes`(EOF / 其它输入 → 退 1 `RSI_HOOKS_DECLINED`,零写入)→ 拿 sync 锁 →
 *   **先**按 R20-15.22 处理残留 → 重读重算计划,与展示的任一字段不同 → 退 4 `stale_plan`(不静默重规划后执行)→ 事务(R20-15.21)→ 顺带修剪。
 * - 输出:stdout 是计划 / 结果 / `--json`;stderr 是交互提示与确认文案,以及失败时的稳定码行(不回显异常消息、配置内容、备份内容、绝对路径,R20-15.26)。
 *
 * 契约未规定码的两处缺口(列为「待主代理定夺」,这里取最保守的既有码):
 *  - `PI_CODING_AGENT_DIR` 已设时 pi 的写对象仍是固定的 `~/.pi/agent/...`(R20-15.2 不可配置),但 pi 实际会读覆盖目录,扩展不会被加载——
 *    install / uninstall / restore(pi)一律退 4 `agent_dir_overridden`(A5 订正 #2);
 *  - `--discard-residue` 所选 journal 不存在、不属于该 agent、或目标不是「第三种值」(契约只授权第三种值从这里退出)→ 退 4 `residue_not_discardable`(A5 订正 #2),不强行记 discarded。
 */
import { ExitCode } from '../../contracts/exit-codes.js';
import {
  HOOKS_TXN_ID_RE,
  PRODUCTION_SHAPES,
  RSI_HOOKS_DECLINED,
  RSI_HOOKS_MODE_FLAGS,
  RSI_HOOKS_MODES,
  RSI_HOOKS_NOT_RUN,
  RSI_HOOKS_WARN,
  isShapeWritable,
  type HookShape,
  type HookVariant,
  type HooksPlan,
  type HooksPlanOp,
  type RsiHooksMode,
  type RsiHooksResult,
  type ShapeTable,
} from '../../contracts/rsi-hooks.js';
import { RSI_AGENT_IDS, type RsiAgentId } from '../../contracts/rsi.js';
import { resolveIsTty, resolveReadLine } from '../../commands/types.js';
import { canonicalJson } from '../../io/canonical-json.js';
import { HooksFs } from '../../io/hooks-fs.js';
import { getExecPath, getRealHome } from '../../io/paths.js';
import {
  ApplyError,
  acquireLock,
  type ApplyDeps,
  type ApplyEnv,
  type LockHandle,
} from '../../sync/apply.js';
import { piDirIsSet } from '../services/open.js';
import type { RsiEarlyContext, RsiSubcommand } from '../types.js';
import { randomBytes } from 'node:crypto';
import { makeAgentVersionProbe } from './agent-version.js';
import { allJsonSpecs, entryFingerprint } from './entries.js';
import { parseStrictJson } from './json-strict.js';
import {
  HooksError,
  failClosed,
  newProgress,
  notRun,
  toStable,
  writeLevelOf,
  type HooksEnv,
  type Progress,
} from './env.js';
import { entriesFor } from './ledger.js';
import { computePlan, type Computed } from './plan.js';
import { renderPrint } from './print.js';
import {
  editChange,
  execPrune,
  hasResidue,
  ledgerForPlan,
  planDiscard,
  planPrune,
  planRestore,
  processResidue,
  runDiscard,
  runRestore,
  runTxn,
  targetState,
  type DiscardComputed,
  type RestoreComputed,
} from './txn.js';

// ---------------------------------------------------------------------------
// 注入点(测试;生产 `subcommand.run` 一个都不传——形状表 / 故障注入不从 CLI、环境、用户配置暴露)
// ---------------------------------------------------------------------------
export interface HooksDeps {
  shapes?: ShapeTable;
  now?: () => Date;
  randomHex?: (bytes: number) => string;
  inject?: (point: string) => void | Promise<void>;
  trace?: (event: string) => void;
  /** 本机 agent 版本探测(形状表 `agent_versions` 非 null 时才会被调用;缺省 undefined = 未知)。生产接线见 {@link subcommand}(`agent-version.ts`) */
  agentVersion?: (agent: RsiAgentId) => Promise<string | undefined> | string | undefined;
  /** 安装的变体(缺省 plain;canary 由 `[rsi.auto]` 状态在安装时决定,§21 之前恒 plain) */
  variantOf?: (agent: RsiAgentId) => HookVariant;
  /** 拿 sync 锁(测试:失锁演练) */
  acquireLock?: (env: ApplyEnv) => Promise<LockHandle>;
  /** sync 锁的注入(pid 存活、时间) */
  applyDeps?: ApplyDeps;
  /** 当前 uid(测试) */
  uid?: number;
}

// ---------------------------------------------------------------------------
// 参数(严格;原因码复用 R20-3.0 既有的 RSI_USAGE 码)
// ---------------------------------------------------------------------------
interface Parsed {
  mode: RsiHooksMode;
  agent: RsiAgentId | undefined;
  write: boolean;
  json: boolean;
  txn: string | undefined;
}
type ParseResult =
  | { ok: true; value: Parsed }
  | { ok: false; reason: 'unknown_arg' | 'mode_conflict' | 'missing:--agent' | 'bad_agent' };

const FLAG_TO_MODE = new Map<string, RsiHooksMode>(
  RSI_HOOKS_MODES.map((m) => [RSI_HOOKS_MODE_FLAGS[m], m]),
);

export function parseHooksArgs(argv: readonly string[]): ParseResult {
  const modes: RsiHooksMode[] = [];
  let agent: string | undefined;
  let txn: string | undefined;
  let write = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const m = FLAG_TO_MODE.get(a);
    if (m !== undefined) {
      if (modes.includes(m)) return { ok: false, reason: 'unknown_arg' };
      modes.push(m);
      if (m === 'restore' || m === 'discard_residue') {
        const v = argv[++i];
        if (v === undefined || !HOOKS_TXN_ID_RE.test(v))
          return { ok: false, reason: 'unknown_arg' };
        txn = v;
      }
      continue;
    }
    if (a === '--agent') {
      if (agent !== undefined) return { ok: false, reason: 'unknown_arg' };
      const v = argv[++i];
      if (v === undefined) return { ok: false, reason: 'missing:--agent' };
      agent = v;
      continue;
    }
    if (a === '--write') {
      if (write) return { ok: false, reason: 'unknown_arg' };
      write = true;
      continue;
    }
    if (a === '--json') {
      if (json) return { ok: false, reason: 'unknown_arg' };
      json = true;
      continue;
    }
    return { ok: false, reason: 'unknown_arg' };
  }
  if (modes.length !== 1) return { ok: false, reason: 'mode_conflict' };
  const mode = modes[0] as RsiHooksMode;
  if (mode === 'prune_backups') {
    if (agent !== undefined) return { ok: false, reason: 'unknown_arg' };
  } else {
    if (agent === undefined) return { ok: false, reason: 'missing:--agent' };
    if (!(RSI_AGENT_IDS as readonly string[]).includes(agent)) {
      return { ok: false, reason: 'bad_agent' };
    }
  }
  if (mode === 'print' && write) return { ok: false, reason: 'unknown_arg' };
  return {
    ok: true,
    value: { mode, agent: agent as RsiAgentId | undefined, write, json, txn },
  };
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
const short = (fp: string | null): string => (fp === null ? '-' : fp.slice(0, 12));

function planLines(plan: HooksPlan, tense: 'would' | 'did'): string[] {
  if (plan.kind === 'restore') {
    return [
      `${tense} restore agent=${plan.agent} source_txn=${plan.source_txn} target=${plan.path}`,
      `current_sha256=${short(plan.target_sha256_after)} backup_sha256=${short(plan.backup_sha256)} ledger_generation=${plan.ledger_generation}`,
    ];
  }
  const lines = [
    `hooks ${plan.kind} agent=${plan.agent} shape=${plan.shape_version} variant=${plan.variant}`,
    `target=${plan.path} before_exists=${plan.before_exists}`,
  ];
  for (const o of plan.ops)
    lines.push(`${tense} ${o.op} event=${o.event} fp=${short(o.entry_fingerprint)}`);
  if (plan.ops.length === 0) lines.push('unchanged');
  return lines;
}

interface Snapshot {
  mode: RsiHooksMode;
  agent: RsiAgentId | null;
  shape: HookShape | null;
  verified: boolean | null;
  plan: { kind: string; before_exists: boolean | null; ops: HooksPlanOp[] } | null;
  txnId: string | null;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const TARGET_MODES: readonly RsiHooksMode[] = ['install', 'uninstall', 'restore'];

export async function runHooksCommand(ctx: RsiEarlyContext, deps: HooksDeps = {}): Promise<number> {
  const parsed = parseHooksArgs(ctx.argv);
  if (!parsed.ok) {
    ctx.stderr(`RSI_USAGE reason=${parsed.reason}\n`);
    return ExitCode.USAGE;
  }
  const p = parsed.value;
  if (p.write && !resolveIsTty(ctx)) {
    ctx.stderr('RSI_USAGE reason=not_tty\n');
    return ExitCode.USAGE;
  }

  const shapes = deps.shapes ?? PRODUCTION_SHAPES;
  const variantOf = deps.variantOf ?? ((): HookVariant => 'plain');
  /** 只在形状表有版本范围时才探测(范围 null = 不看版本,不 spawn):claude / codex 现在不会触发任何子进程 */
  const versionOf = async (agent: RsiAgentId): Promise<string | undefined> =>
    shapes[agent].agent_versions === null ? undefined : await deps.agentVersion?.(agent);
  const progress: Progress = newProgress();
  const snap: Snapshot = {
    mode: p.mode,
    agent: p.agent ?? null,
    shape: p.agent !== undefined ? shapes[p.agent] : null,
    verified: null,
    plan: null,
    txnId: null,
  };
  let lock: LockHandle | undefined;
  let fs: HooksFs | undefined;
  /** 人读输出:`--json` 时 stdout 只有固定键集的 JSON(R20-15.25) */
  const say = (t: string): void => {
    if (!p.json) ctx.stdout(t);
  };

  const emitJson = (result: RsiHooksResult): void => {
    if (!p.json) return;
    const targetTxn = p.write && TARGET_MODES.includes(p.mode);
    const out = {
      mode: p.mode,
      agent: snap.agent,
      shape_version: snap.shape?.shape_version ?? null,
      verified: snap.verified,
      plan: snap.plan,
      result,
      txn_id: progress.txnId ?? snap.txnId,
      write_level: targetTxn ? writeLevelOf(progress) : null,
      maintenance: progress.maintenance,
      maintenance_kind: progress.maintenanceKind,
    };
    ctx.stdout(canonicalJson(out));
  };
  const done = (exit: number, result: RsiHooksResult, line?: string): number => {
    if (line !== undefined) ctx.stderr(`${line}\n`);
    emitJson(result);
    return exit;
  };

  try {
    if (p.mode === 'print') {
      const agent = p.agent as RsiAgentId;
      const shape = shapes[agent];
      const variant = variantOf(agent);
      const verified = isShapeWritable(shape, await versionOf(agent));
      snap.verified = verified;
      snap.plan = { kind: 'print', before_exists: null, ops: [] };
      say(renderPrint(shape, variant, verified));
      return done(ExitCode.OK, 'printed');
    }

    // ---- 环境(只读阶段不拿锁、不写)----
    const home = getRealHome(ctx.env);
    try {
      fs = new HooksFs({
        home,
        ...(ctx.writeAudit !== undefined ? { writeAudit: ctx.writeAudit } : {}),
        ...(deps.trace !== undefined ? { trace: deps.trace } : {}),
        ...(deps.uid !== undefined ? { uid: deps.uid } : {}),
      });
    } catch {
      throw failClosed('hooks_target_unsafe');
    }
    const env: HooksEnv = {
      fs,
      shapes,
      now: deps.now ?? ((): Date => new Date()),
      randomHex: deps.randomHex ?? ((n: number): string => randomBytes(n).toString('hex')),
      ...(deps.inject !== undefined ? { inject: deps.inject } : {}),
      progress,
    };
    const aenv: ApplyEnv = {
      home: fs.home,
      homeReal: fs.home,
      tmpDir: undefined,
      env: ctx.env,
      deps: deps.applyDeps ?? {},
      ...(ctx.writeAudit !== undefined ? { writeAudit: ctx.writeAudit } : {}),
    };

    const takeLock = async (): Promise<void> => {
      progress.lockAttempted = true;
      try {
        lock = await (deps.acquireLock ?? acquireLock)(aenv);
      } catch (e) {
        if (e instanceof ApplyError && e.code === 'SYNC_LOCKED') throw notRun('locked');
        throw e;
      }
      const held = lock;
      (fs as HooksFs).setGuard(async () => {
        try {
          await held.assertHeld();
        } catch {
          throw failClosed('lock_lost');
        }
      });
    };

    const confirm = async (lines: readonly string[], note: string): Promise<boolean> => {
      ctx.stderr(`${lines.join('\n')}\n${note}\n输入 yes 确认,其它任何输入都会取消:`);
      const ans = await resolveReadLine(ctx)();
      ctx.stderr('\n');
      return ans === 'yes';
    };

    const pathDisplay = (agent: RsiAgentId): string => `~/${shapes[agent].target_rel}`;

    // ---- install / uninstall ----
    const computeEdit = async (
      kind: 'install' | 'uninstall',
      agent: RsiAgentId,
    ): Promise<Computed> => {
      const shape = shapes[agent];
      const variant = variantOf(agent);
      if (agent === 'pi' && piDirIsSet(ctx.env)) throw notRun('agent_dir_overridden');
      if (!(await (fs as HooksFs).agentRootExists(agent))) throw notRun('agent_not_installed');
      const ledger = await ledgerForPlan(env);
      const target = await (fs as HooksFs).readTarget(agent);
      let local: 'none' | 'found' | 'failed' = 'none';
      if (kind === 'install' && shape.kind === 'json-merge' && shape.local_duplicate_rel !== null) {
        local = await checkLocal(fs as HooksFs, agent, shape);
      }
      const c = computePlan({
        kind,
        shape,
        variant,
        before: target === null ? null : target.bytes,
        owned: entriesFor(ledger, agent),
        pathDisplay: pathDisplay(agent),
        local,
      });
      if (!c.ok) throw notRun(c.reason);
      return c;
    };

    if (p.mode === 'install' || p.mode === 'uninstall') {
      const agent = p.agent as RsiAgentId;
      const shape = shapes[agent];
      const kind = p.mode;
      snap.verified = isShapeWritable(shape, await versionOf(agent));
      // 形状核实是写能力的闸(R20-15.9):干跑不受限,`--install --write` 在确认与拿锁之前就拒
      if (kind === 'install' && p.write && snap.verified !== true) throw notRun('shape_unverified');

      const first = await computeEdit(kind, agent);
      snap.plan = { kind, before_exists: first.plan.before_exists, ops: first.plan.ops };
      const planText = planLines(first.plan, 'would');
      if (!p.write) {
        say(`${planText.join('\n')}\n`);
        return done(ExitCode.OK, first.plan.ops.length === 0 ? 'unchanged' : 'dry_run');
      }
      if (first.plan.ops.length === 0 && !(await hasResidue(env))) {
        say(`${planText.join('\n')}\n`);
        return done(ExitCode.OK, 'unchanged');
      }
      const ok = await confirm(
        planText,
        '将把整份配置备份到 kit 私有状态目录(~/.local/state/agent-kit/hooks/backups/)。',
      );
      if (!ok) return done(ExitCode.CHECK_FAILED, 'declined', RSI_HOOKS_DECLINED);
      await takeLock();
      await processResidue(env);
      const second = await computeEdit(kind, agent);
      if (canonicalJson(second.plan) !== canonicalJson(first.plan)) throw notRun('stale_plan');
      if (second.plan.ops.length === 0) {
        say(`${planLines(second.plan, 'would').join('\n')}\n`);
        return done(ExitCode.OK, 'unchanged');
      }
      const before = await targetState(env, agent);
      // 计划读与事务读之间目标又被改(锁内也可能被 agent 自己改写)→ 计划作废,不拿旧计划的写后字节去套新内容
      if (
        before.exists !== second.plan.before_exists ||
        before.sha256 !== second.plan.before_sha256
      ) {
        throw notRun('stale_plan');
      }
      const id = await runTxn(env, {
        agent,
        kind,
        plan: second.plan,
        before,
        after: { exists: second.after.exists, sha256: second.after.sha256 },
        buildChange: editChange(
          agent,
          kind,
          { exists: before.exists, sha256: before.sha256 },
          { exists: second.after.exists, sha256: second.after.sha256 },
          second.added,
          second.removed,
        ),
      });
      snap.txnId = id;
      say(`${planLines(second.plan, 'did').join('\n')}\ncommitted txn=${id}\n`);
      await incidentalPrune(env, ctx);
      return done(ExitCode.OK, 'committed');
    }

    // ---- restore ----
    if (p.mode === 'restore') {
      const agent = p.agent as RsiAgentId;
      const txn = p.txn as string;
      snap.verified = isShapeWritable(shapes[agent], await versionOf(agent));
      if (agent === 'pi' && piDirIsSet(ctx.env)) throw notRun('agent_dir_overridden');
      if (!(await fs.agentRootExists(agent))) throw notRun('agent_not_installed');
      const first = await planRestore(env, agent, txn, pathDisplay(agent));
      snap.plan = { kind: 'restore', before_exists: first.current.exists, ops: [] };
      const text = planLines(first.plan, 'would');
      if (!p.write) {
        say(`${text.join('\n')}\n`);
        return done(ExitCode.OK, 'dry_run');
      }
      const ok = await confirm(
        text,
        '将把目标放回该事务的写前状态;当前文件会先整份备份到 kit 私有状态目录。',
      );
      if (!ok) return done(ExitCode.CHECK_FAILED, 'declined', RSI_HOOKS_DECLINED);
      await takeLock();
      await processResidue(env);
      const second: RestoreComputed = await planRestore(env, agent, txn, pathDisplay(agent));
      if (canonicalJson(second.plan) !== canonicalJson(first.plan)) throw notRun('stale_plan');
      const id = await runRestore(env, second);
      snap.txnId = id;
      say(`${planLines(second.plan, 'did').join('\n')}\ncommitted txn=${id}\n`);
      await incidentalPrune(env, ctx);
      return done(ExitCode.OK, 'committed');
    }

    // ---- discard-residue ----
    if (p.mode === 'discard_residue') {
      const agent = p.agent as RsiAgentId;
      const txn = p.txn as string;
      const first: DiscardComputed = await planDiscard(env, agent, txn);
      snap.plan = { kind: 'discard_residue', before_exists: first.current.exists, ops: [] };
      const text = [
        `hooks discard_residue agent=${agent} txn=${txn} state=${first.journal.state}`,
        `current_sha256=${short(first.current.sha256)}`,
      ];
      if (!p.write) {
        say(`${text.join('\n')}\nwould discard txn=${txn}\n`);
        return done(ExitCode.OK, 'dry_run');
      }
      const ok = await confirm(
        text,
        '将保留当前文件现状:该事务记为 discarded,未提交的归属变更不生效,此后它的 --restore 不可用。',
      );
      if (!ok) return done(ExitCode.CHECK_FAILED, 'declined', RSI_HOOKS_DECLINED);
      await takeLock();
      // 唯一不先走通用残留处理的写模式:只接管所选的那一个 journal,其它残留仍照常先处理
      await processResidue(env, { skip: txn });
      const second = await planDiscard(env, agent, txn);
      if (
        second.current.sha256 !== first.current.sha256 ||
        second.current.exists !== first.current.exists
      ) {
        throw notRun('stale_plan');
      }
      await runDiscard(env, second);
      say(`did discard txn=${txn}\n`);
      return done(ExitCode.OK, 'maintenance_done');
    }

    // ---- prune-backups ----
    const first = await planPrune(env);
    snap.plan = { kind: 'prune_backups', before_exists: null, ops: [] };
    const lines = [...first.map((id) => `would prune txn=${id}`), `prune_count=${first.length}`];
    if (!p.write) {
      say(`${lines.join('\n')}\n`);
      return done(ExitCode.OK, 'dry_run');
    }
    if (first.length === 0 && !(await hasResidue(env))) {
      say(`${lines.join('\n')}\n`);
      return done(ExitCode.OK, 'unchanged');
    }
    const ok = await confirm(
      lines,
      '将删除上面列出的备份目录(受保护备份与在途事务引用的备份不删)。',
    );
    if (!ok) return done(ExitCode.CHECK_FAILED, 'declined', RSI_HOOKS_DECLINED);
    await takeLock();
    await processResidue(env);
    const second = await planPrune(env);
    // 确认的是 `first` 那一组:锁内(含残留处理之后)重算的集合与之不同 → stale_plan,不静默扩大删除集合
    if (second.length !== first.length || second.some((id, i) => id !== first[i])) {
      throw notRun('stale_plan');
    }
    await execPrune(env, second);
    say(
      `${second.map((id) => `did prune txn=${id}`).join('\n')}${second.length > 0 ? '\n' : ''}prune_count=${second.length}\n`,
    );
    return done(ExitCode.OK, second.length > 0 ? 'maintenance_done' : 'unchanged');
  } catch (e) {
    const s = e instanceof HooksError ? e : toStable(e);
    const lockLine = `${s.kind === 'not_run' ? RSI_HOOKS_NOT_RUN : 'RSI_FAIL_CLOSED'} reason=${s.reason}`;
    return done(
      s.kind === 'not_run' ? ExitCode.NOT_RUN : ExitCode.FAIL_CLOSED,
      s.kind === 'not_run' ? 'not_run' : 'fail_closed',
      lockLine,
    );
  } finally {
    fs?.setGuard(undefined);
    try {
      await lock?.release();
    } catch {
      // 释放失败不改变结果;陈旧锁由 sync 锁自己的回收规则处理
    }
  }
}

/**
 * claude 的 settings.local.json 只读重复检测(R20-15.27):确认存在 → found;检测本身失败 → failed(不当作「未发现」)。
 * 严格解析(UTF-8、无重复键;评审采纳),`hooks` 与形状表关心的事件必须是预期形状,无法可靠判断就是 failed。
 */
async function checkLocal(
  fs: HooksFs,
  agent: RsiAgentId,
  shape: HookShape,
): Promise<'none' | 'found' | 'failed'> {
  if (shape.kind !== 'json-merge') return 'none';
  try {
    const r = await fs.readAux(agent);
    if (r === null) return 'none';
    const p = parseStrictJson(r.bytes);
    if (!p.ok) return 'failed';
    const doc = p.value;
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return 'failed';
    const hooks = (doc as Record<string, unknown>)['hooks'];
    if (hooks === undefined) return 'none';
    if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return 'failed';
    const specs = allJsonSpecs(shape);
    const fps = new Set(specs.map((s) => s.fingerprint));
    for (const event of new Set(specs.map((s) => s.event))) {
      const arr = (hooks as Record<string, unknown>)[event];
      if (arr === undefined) continue;
      if (!Array.isArray(arr)) return 'failed';
      for (const el of arr) if (fps.has(entryFingerprint(event, el))) return 'found';
    }
    return 'none';
  } catch {
    return 'failed';
  }
}

/** 目标事务成功后顺带修剪(R20-15.24):失败不改变结果(仍 committed、退 0),stderr 一行警告 */
async function incidentalPrune(env: HooksEnv, ctx: Pick<RsiEarlyContext, 'stderr'>): Promise<void> {
  try {
    await execPrune(env, await planPrune(env));
  } catch {
    env.progress.maintenanceKind = 'prune';
    env.progress.maintenance = 'partial';
    ctx.stderr(`${RSI_HOOKS_WARN} reason=prune_incomplete\n`);
  }
}

export const subcommand: RsiSubcommand = {
  name: 'hooks',
  owner: 'A5',
  // 生产接线:版本探测经 io/exec.ts 的专用出口(只跑 `pi --version`,3 秒超时,失败即未知);形状表 / 故障注入仍不从 CLI 暴露
  run: (ctx) => runHooksCommand(ctx, { agentVersion: makeAgentVersionProbe(getExecPath(ctx.env)) }),
};
