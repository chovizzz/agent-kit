/**
 * `agent-kit rsi tick [--write] [--json]`(契约 R20-3.1;R20-A2 B5a 实装,方案 §3)。
 *
 * 干跑(无 `--write`,R20-3.1.1):**纯计划、零写入**——`openRsiIo` → `readRsiState`(快照协议;清单不一致 → 4 `RSI_SNAPSHOT_BUSY`)→ `rsiStateOf` →
 * stopped / collect_blocked 退 4 → `planL0`;不拿锁、不建目录、不调 recover、不建盐。`L0Plan.salt` 的 `none` 映射成 `"ephemeral"`。
 *
 * `--write`:前台执行一次完整 L0,锁内顺序固定:**无副作用复检**(`observeRsi`,直读,D2:先于 recover)→ `recoverUnderLock` →
 * (confirmed 且有合规 purge journal:`resumePurgeUnderLock` 续做)→ `resumeTaintWith` →
 * confirmed:`runL0UnderLock`;armed:`taintNewlyExcludedWith` + 只校正 `counts.staged[].tainted`(counts 在且盐相符,D3)+ `runArmedUnderLock`。
 * 不预写 attempt(Q-K);熔断打开时照常执行,走完的 outcome 经 `tickStateMutator` 更新;抛错路径不调 mutator(A3 交接)。
 * `stopped` / `skipped_collect_blocked` / `skipped_binding_changed`(检查点中止)提交完状态后退 4,stdout 为空。
 *
 * `--json` 键集合固定(R20-3.1.4;**没有 `outcome`**,`reason` 取代它):mode、state、reason、salt、files_planned、files_read、bytes_read、signals_new、
 * sessions_new、projects、unknown_signals、skipped、limits_hit、cursor、duration_ms。文本模式同键 `key=value`。不含路径、key、项目名。
 * 不 import llm-exec / reflect 后端 / net / 更新启动器(R20-1.1,由 `import-closure.test.ts` 钉住)。
 */
import { ExitCode } from '../contracts/exit-codes.js';
import { RsiCountsSchema, type RsiOutcome } from '../contracts/rsi.js';
import { canonicalJson } from '../io/canonical-json.js';
import type { IoContext } from '../io/paths.js';
import { SaltError, readSaltFile } from '../signals/salt-read.js';
import { parseFlags } from './args.js';
import { failExit } from './exit.js';
import { RsiLockError } from './lock-error.js';
import { bindingOf } from './l0/binding.js';
import { recomputeStagedTainted } from './l0/counts-recompute.js';
import { makeGate } from './l0/commit.js';
import { planL0, type L0Plan } from './l0/plan.js';
import { runArmedUnderLock, runL0UnderLock, type RunL0Deps } from './l0/run.js';
import type { L0Deps, L0Summary, RunL0Input } from './l0/types.js';
import type { RsiLockDeps } from './lock.js';
import { emitLines, forbiddenPaths, jsonLines } from './output.js';
import { readRsiState } from './read-state.js';
import type { OutLine } from './sanitize.js';
import {
  commitUnderLockWith,
  recoverUnderLock,
  writeCountsProjectionWith,
} from './services/commit.js';
import { hooksFromGate } from './services/fixed-write.js';
import { openRsiIo, piDirIsSet, type OpenRsiIoDeps } from './services/open.js';
import {
  armedCheckpoint,
  confirmedCheckpoint,
  observeRsi,
  type RsiObservation,
} from './services/observe.js';
import { resumePurgeUnderLock } from './services/purge-engine.js';
import { RsiStagingBlockedError } from './services/staging.js';
import { detectPurgeJournal, resumeTaintWith, taintNewlyExcludedWith } from './services/taint.js';
import { tickStateMutator } from './services/tick-state.js';
import { readRsiFixed } from './services/attribution.js';
import { loadRepoIdentity, rsiStateOf } from './state.js';
import { buildRsiPolicy, policyFingerprint } from './config.js';
import { flattenDoc } from './status.js';
import { withRsiLockIfGated } from './with-lock.js';
import type { LockGateOptions } from './gate.js';
import {
  RsiFailClosedError,
  type RsiEarlyContext,
  type RsiServiceCtx,
  type RsiSubcommand,
} from './types.js';

export interface RsiTickDeps {
  /** 注入时钟(`last_tick.completed_at`、日志 `at`、cursor / 索引日期) */
  now?: () => Date;
  /** 墙钟毫秒(读阶段时间预算与 `duration_ms`) */
  nowMs?: () => number;
  open?: OpenRsiIoDeps;
  gate?: LockGateOptions;
  lock?: RsiLockDeps;
  /** L0 提交侧依赖与测试缝(`beforeWrite`、`l0`(含 `piDirSet`、`probe`、`beforeStep`、`limits`)、`readers`、`limits`、`redactor`……) */
  run?: RunL0Deps;
  /** 锁内、`observeRsi` 复检之前调用(演练「锁前预检之后、拿锁之后改配置」) */
  afterLock?: () => Promise<void> | void;
}

type TickMode = 'dry' | 'write';

interface TickOut {
  mode: TickMode;
  state: 'armed' | 'confirmed';
  summary: L0Summary;
  salt: 'persisted' | 'ephemeral';
}

/** 检查点中止的 outcome → `RSI_NOT_RUN reason=`;其余(成功)没有 reason */
const NOT_RUN: Partial<Record<RsiOutcome, 'stopped' | 'collect_blocked' | 'binding_changed'>> = {
  stopped: 'stopped',
  skipped_collect_blocked: 'collect_blocked',
  skipped_binding_changed: 'binding_changed',
};

function notRun(ctx: RsiEarlyContext, reason: string): number {
  ctx.stderr(`RSI_NOT_RUN reason=${reason}\n`);
  return ExitCode.NOT_RUN;
}

function render(o: TickOut): Record<string, unknown> {
  const s = o.summary;
  return {
    mode: o.mode,
    state: o.state,
    reason: null,
    salt: o.salt,
    files_planned: s.files_planned,
    files_read: s.files_read,
    bytes_read: s.bytes_read,
    signals_new: s.signals_new,
    sessions_new: s.sessions_new,
    projects: s.projects,
    unknown_signals: s.unknown_signals,
    skipped: s.skipped,
    limits_hit: s.limits_hit,
    cursor: s.cursor,
    duration_ms: s.duration_ms,
  };
}

async function diskSalt(io: IoContext): Promise<'persisted' | 'ephemeral'> {
  try {
    return (await readSaltFile(io.stateDir)).kind === 'ok' ? 'persisted' : 'ephemeral';
  } catch (e) {
    if (e instanceof SaltError) throw new RsiFailClosedError('salt_invalid');
    throw e;
  }
}

/** 锁内 / 锁前共用的拒绝判定(顺序:off → state_invalid → stopped → collect_blocked);返回 `RSI_NOT_RUN` 的 reason 或抛 fail-closed */
function refusal(o: RsiObservation): 'off' | 'stopped' | 'collect_blocked' | null {
  if (o.state.state === 'off') return 'off';
  if (o.state.stateInvalid) throw new RsiFailClosedError('state_invalid');
  if (o.state.state === 'stopped') return 'stopped';
  if (o.state.collectBlocked !== null) return 'collect_blocked';
  return null;
}

async function dryRun(
  ctx: RsiEarlyContext,
  deps: RsiTickDeps,
  sctx: RsiServiceCtx,
  json: boolean,
): Promise<number> {
  const { io, config } = sctx;
  const data = await readRsiState(io); // busy → 4 RSI_SNAPSHOT_BUSY;state 不合规 → 3
  const identity = await loadRepoIdentity(config, await buildRsiPolicy(config));
  const st = rsiStateOf({ config, stopPresent: data.stop.present, doc: data.stateDoc, identity });
  if (st.state === 'stopped') return notRun(ctx, 'stopped');
  if (st.collectBlocked !== null) return notRun(ctx, 'collect_blocked');
  const l0: L0Deps = {
    ...(deps.run?.l0 ?? {}),
    piDirSet: deps.run?.l0?.piDirSet ?? piDirIsSet(ctx.env),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  };
  let plan: L0Plan;
  try {
    plan = await planL0(io, config, { mode: st.state === 'confirmed' ? 'confirmed' : 'armed' }, l0);
  } catch (e) {
    if (e instanceof SaltError) throw new RsiFailClosedError('salt_invalid');
    throw e;
  }
  return emitTick(
    ctx,
    {
      mode: 'dry',
      state: plan.mode,
      summary: plan.summary,
      salt: plan.salt === 'none' ? 'ephemeral' : 'persisted',
    },
    json,
    await forbiddenPaths(ctx.env, [io.stateDir, io.repoRoot, config.repo]),
  );
}

function emitTick(ctx: RsiEarlyContext, o: TickOut, json: boolean, forbidden: string[]): number {
  const doc = render(o);
  const lines: OutLine[] = json
    ? jsonLines(canonicalJson(doc))
    : flattenDoc(doc).map((head) => ({ head }));
  return emitLines(ctx, lines, forbidden);
}

/** armed 下 taint 有改动、counts 在且盐相符:只校正 `staged[].tainted`(其余段保持现值;D3) */
async function correctStagedTainted(
  sctx: RsiServiceCtx,
  lock: Parameters<typeof commitUnderLockWith>[1],
  hooks: ReturnType<typeof hooksFromGate>,
): Promise<void> {
  const r = await readRsiFixed(sctx.io, 'counts.json');
  if (r.kind !== 'ok') return;
  let prev;
  try {
    prev = RsiCountsSchema.parse(JSON.parse(r.bytes.toString('utf8')));
  } catch {
    throw new RsiFailClosedError('counts_invalid');
  }
  let salt;
  try {
    salt = await readSaltFile(sctx.io.stateDir);
  } catch (e) {
    if (e instanceof SaltError) throw new RsiFailClosedError('salt_invalid');
    throw e;
  }
  if (salt.kind !== 'ok' || salt.saltFp !== prev.salt_fp) return;
  const tainted = await recomputeStagedTainted(sctx.io);
  let changed = false;
  const next = prev.staged.map((e) => {
    const t = tainted.get(e.run_id) ?? e.tainted;
    if (t !== e.tainted) changed = true;
    return { ...e, tainted: t };
  });
  if (changed) await writeCountsProjectionWith(sctx, lock, { staged: next }, hooks);
}

async function writeRun(
  ctx: RsiEarlyContext,
  deps: RsiTickDeps,
  sctx: RsiServiceCtx,
  json: boolean,
): Promise<number> {
  const { io, config } = sctx;
  const nowMs = deps.nowMs ?? deps.run?.nowMs ?? ((): number => Date.now());
  const startedAtMs = nowMs();
  const now = deps.now ?? ((): Date => new Date());
  // 锁前廉价早拒:只读、不作授权依据(锁内会以同一判据复检)
  const early = refusal(await observeRsi(io, ctx.env));
  if (early !== null) return notRun(ctx, early);

  const outcome = await withRsiLockIfGated(
    sctx,
    async (lock) => {
      if (lock === null) throw new RsiFailClosedError('internal');
      await deps.afterLock?.();
      // ① 无副作用复检(D2:先于 recover)。拒绝时除锁文件与 rsi/ 目录之外零写入
      const obs = await observeRsi(io, ctx.env);
      const why = refusal(obs);
      if (why !== null) return { kind: 'refused' as const, why };
      const gate = makeGate(lock, deps.run?.beforeWrite);
      const hooks = hooksFromGate(gate);
      // ② 恢复未完成的提交
      const recovered = await recoverUnderLock(sctx, lock, hooks);
      // ③ purge journal(R20-3.8.5 ②):confirmed 且合规 journal 在场 → 先续做(purge 五阶段 / salvage 三阶段,按 mode 分派);
      //   invalid / unreadable 在这里**不处理**(salvage 只属于前台 `purge --resume --write`,后台不得静默清空暂存摘录),交给 ④ 的 resumeTaint 抛 journal_invalid / purge_incomplete
      const confirmed = obs.state.state === 'confirmed';
      const jp = await detectPurgeJournal(sctx);
      if (confirmed && jp.state === 'present') {
        // 续做失败 → purge_incomplete(R20-3.8.5:其它写入方遇到无法完成的 journal;熔断按 safety 由 A3 记);失锁照旧是 lock_lost
        try {
          await resumePurgeUnderLock(sctx, lock, { hooks });
        } catch (e) {
          // 失锁与更具体的阻断(暂存目录数超限 / 暂存区里有 safe-fs 无法处理的条目)保留原码,其余一律 purge_incomplete
          if (e instanceof RsiLockError || e instanceof RsiStagingBlockedError) throw e;
          // write_denied:续做中 safe-fs 守卫拒绝,是排障线索,不吞;signal_store_corrupt 按契约原文(续做失败 → purge_incomplete)仍归并
          if (
            e instanceof RsiFailClosedError &&
            (e.reason === 'staging_too_large' || e.reason === 'write_denied')
          )
            throw e;
          throw new RsiFailClosedError('purge_incomplete');
        }
      }
      // ④ taint 续做
      await resumeTaintWith(sctx, lock, hooks);
      const identity = obs.identity;
      if (identity === null) throw new RsiFailClosedError('internal');
      const l0: L0Deps = {
        ...(deps.run?.l0 ?? {}),
        piDirSet: deps.run?.l0?.piDirSet ?? piDirIsSet(ctx.env),
      };
      const runDeps: RunL0Deps = { ...(deps.run ?? {}), l0, nowMs };
      const stateMutator = tickStateMutator({ trigger: 'tick', now });
      if (confirmed) {
        const confirmAt =
          obs.doc.kind === 'ok' ? (obs.doc.state.confirm?.confirmed_at ?? null) : null;
        const binding = bindingOf({ identity, confirmedAt: confirmAt });
        const input: RunL0Input = {
          trigger: 'tick',
          recovered,
          binding,
          checkpoint: confirmedCheckpoint({ io, env: ctx.env, binding, nowMs, startedAtMs }),
          stateMutator,
        };
        const r = await runL0UnderLock(sctx, lock, input, runDeps);
        return {
          kind: 'ran' as const,
          state: 'confirmed' as const,
          outcome: r.outcome,
          summary: r.summary,
        };
      }
      // armed(首次 / 失效后):taint 之后只校正 staged.tainted;只列举,不建盐、不读正文、不写 counts 的其余段
      const t = await taintNewlyExcludedWith(sctx, lock, { source: 'exclude' }, hooks);
      if (t.runsMarked + t.promotesMarked > 0) await correctStagedTainted(sctx, lock, hooks);
      const binding = bindingOf({ identity, confirmedAt: null });
      const input: RunL0Input = {
        trigger: 'tick',
        recovered,
        binding,
        checkpoint: armedCheckpoint({
          io,
          env: ctx.env,
          armedBinding: {
            repoSha256: identity.repoSha256,
            repoDevIno: { dev: identity.repoDevIno.dev, ino: identity.repoDevIno.ino },
            policyFp: policyFingerprint(identity.policy),
            agents: [...identity.policy.agents],
          },
          nowMs,
          startedAtMs,
        }),
        stateMutator,
      };
      const r = await runArmedUnderLock(sctx, lock, input, runDeps);
      return {
        kind: 'ran' as const,
        state: 'armed' as const,
        outcome: r.outcome,
        summary: r.summary,
      };
    },
    {
      ...(deps.gate !== undefined ? { gate: deps.gate } : {}),
      ...(deps.lock !== undefined ? { lock: deps.lock } : {}),
    },
  );
  if (outcome.kind === 'refused') return notRun(ctx, outcome.why);
  const why = NOT_RUN[outcome.outcome];
  if (why !== undefined) return notRun(ctx, why);
  return emitTick(
    ctx,
    { mode: 'write', state: outcome.state, summary: outcome.summary, salt: await diskSalt(io) },
    json,
    await forbiddenPaths(ctx.env, [io.stateDir, io.repoRoot, config.repo]),
  );
}

export async function runTick(ctx: RsiEarlyContext, deps: RsiTickDeps = {}): Promise<number> {
  const parsed = parseFlags(ctx.argv, ['--write', '--json']);
  if (!parsed.ok) {
    ctx.stderr('RSI_USAGE reason=unknown_arg\n');
    return ExitCode.USAGE;
  }
  const json = parsed.flags.has('--json');
  try {
    const open = await openRsiIo(ctx, deps.open);
    if (open.kind === 'usage') {
      ctx.stderr(`${open.code} reason=${open.reason}\n`);
      return ExitCode.USAGE;
    }
    if (open.kind === 'off') return notRun(ctx, 'off');
    const sctx: RsiServiceCtx = {
      ...open.ctx,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    };
    return parsed.flags.has('--write')
      ? await writeRun(ctx, deps, sctx, json)
      : await dryRun(ctx, deps, sctx, json);
  } catch (e) {
    return failExit(ctx.stderr, e);
  }
}

export const subcommand: RsiSubcommand = {
  name: 'tick',
  owner: 'B5',
  run: (ctx) => runTick(ctx),
};
