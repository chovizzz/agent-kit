/**
 * 后台 worker `agent-kit __rsi --background`(契约 R20-3.9;A3)。由 poke / 顺带调度经零网络桥接 `update/self-spawn.ts` 以 detached、
 * stdio 丢弃的方式拉起;根入口 `cli.ts` 识别钩子形状后经 `hook-entry.ts` 直接加载本文件(不经启动器、不经 `src/cli.ts` 的 main)。
 *
 * **不输出**(stdout / stderr 恒空)、退出码恒 0;结果只进 `.state/rsi/log.jsonl` 与 `state.json`。不读 stdin(R20-1.9)。
 *
 * 顺序(R20-3.9.2,A3 方案 v2 R2 / R3):
 *  锁外:跳过条件(R20-1.6)→ 重读配置(off / usage → 零写入)→ 只读预检(off / stopped / 停止采集 / state 不可读 → 零写入)→ 试锁
 *  (占用 → 只在 `rsi/` 已存在且安全时无锁追加一行 `skipped_locked`,§20.5 矩阵许可的唯一无锁日志)。
 *  锁内:无副作用复检(拒绝 → 释放、零业务写入)→ `update/lock` 存活 → `skipped_update_busy` → `recoverUnderLock` →
 *  (confirmed 且合规 journal)续做 purge → 补 taint → **消费残留 attempt**(记一次 `crashed`,经提交落盘)→ STOP → 熔断(open → 日志 `breaker_open`,不开始新工作)→
 *  L0 到期(否 → `skipped_throttled`)→ **预写 attempt**(落盘 + 清单;一定在读任何会话文件之前)→ 运行绑定 → armed 列举 / confirmed 采集 →
 *  结果经 `tickStateMutator` + `applyBreaker` 写回(含 attempt 清除)→ 删过期预留标记 → `log.jsonl` 截断到 200 行 → 释放锁。
 *
 * 失败记账(R20-6.5 / R20-6.6):抛错按码分类。「不可记录」= 零写入(连日志也不写):失锁、写出口拒绝、状态目录不安全、`state.json` / 清单不可读;
 * 其余经 `commitUnderLockWith` 落盘熔断——它在提交清单前用生产 schema 全量复验,任一数据文件损坏即抛,此时同样按不可记录处理,
 * 所以错误路径**不会**把损坏数据背书进清单;重新认证「各文件合法的未完成提交」与 R20-5.6 下一个持锁写入方的 recover 语义相同。
 *
 * 不 import llm-exec / reflect 后端 / net / 更新启动器 / install(R20-1.1,`test/rsi/import-closure.test.ts` 钉住)。
 */
import * as path from 'node:path';
import {
  RSI_LOG_LINE_MAX_BYTES,
  RSI_LOG_MAX_LINES,
  RSI_OUTCOMES,
  RSI_POKE_RESERVATION_KEEP_WINDOWS,
  RsiLogLineSchema,
  type RsiOutcome,
  type RsiState,
} from '../contracts/rsi.js';
import { canonicalJsonLine } from '../io/canonical-json.js';
import type { IoContext, WriteAudit } from '../io/paths.js';
import { lstat, readDir, readFileSafe } from '../io/read-fs.js';
import { appendFile, createExclusive, remove, rename } from '../io/safe-fs.js';
import { bindingOf } from './l0/binding.js';
import { makeGate } from './l0/commit.js';
import { runArmedUnderLock, runL0UnderLock, type RunL0Deps } from './l0/run.js';
import type { L0Deps, RunL0Input, StateMutator } from './l0/types.js';
import { acquireRsiLock, type RsiLockDeps, type RsiLockHandle } from './lock.js';
import { RsiLockError } from './lock-error.js';
import { RSI_FILE_OWNER, makeIsAlive, rsiDirReadonly } from './lock-read.js';
import { policyFingerprint } from './config.js';
import { lockGate, type LockGateOptions } from './gate.js';
import { applyBreaker, breakerView, l0Due, windowIndex } from './services/breaker.js';
import { commitUnderLockWith, recoverUnderLock } from './services/commit.js';
import { hooksFromGate, readStateForWrite, writeStateFile } from './services/fixed-write.js';
import {
  armedCheckpoint,
  confirmedCheckpoint,
  observeRsi,
  type RsiObservation,
} from './services/observe.js';
import { openRsiIo, piDirIsSet, type OpenRsiIoDeps } from './services/open.js';
import { resumePurgeUnderLock } from './services/purge-engine.js';
import { mapPurgeResumeError } from './services/purge-resume-map.js';
import { RsiStagingBlockedError } from './services/staging.js';
import { detectPurgeJournal, resumeTaintWith, taintNewlyExcludedWith } from './services/taint.js';
import { defaultState, tickStateMutator } from './services/tick-state.js';
import { autoSkip } from './skip.js';
import { RsiSnapshotError } from './snapshot-read.js';
import { inspectSnapshot } from './snapshot.js';
import { productionSnapshotValidator } from './validators.js';
import { RsiFailClosedError, type RsiServiceCtx } from './types.js';

type Env = Readonly<Record<string, string | undefined>>;

/** worker 的日志 / `last_tick` 触发源:子进程拿不到是谁拉起的(参数固定、环境走白名单),一律记 `poke`;真实来源见拉起方那一行的 `trigger` 与 `agent` */
const WORKER_TRIGGER = 'poke' as const;
/** `update/lock` 相对真实 HOME 的位置(§19.5;只读判存活,不 import update 模块——它们经 install 引入 net) */
const UPDATE_LOCK_SEGMENTS = ['.local', 'state', 'agent-kit', 'update', 'lock'] as const;
const UPDATE_LOCK_MAX_BYTES = 4096;

export interface RsiWorkerRunDeps {
  env?: Env;
  /** 写审计钩子(测试;经 `openRsiIo` 进 IoContext) */
  writeAudit?: WriteAudit;
  now?: () => Date;
  nowMs?: () => number;
  open?: OpenRsiIoDeps;
  gate?: LockGateOptions;
  lock?: RsiLockDeps;
  run?: RunL0Deps;
  /** `update/lock` 持有者存活判据(缺省 `process.kill(pid, 0)`;`EPERM` 算存活) */
  isAlive?: (pid: number) => boolean;
  /** 测试缝:锁内、复检之前 */
  afterLock?: () => Promise<void> | void;
}

/** worker 一次运行的结局(只给测试与日志用;进程退出码恒 0) */
export type WorkerResult =
  | { kind: 'skipped_pre_lock'; why: string }
  | { kind: 'skipped_locked' }
  | { kind: 'refused_in_lock'; why: string }
  | { kind: 'ran'; outcome: RsiOutcome; recorded: boolean };

/** 不可记录:状态目录 / 锁 / 写出口 / state.json / 清单本身有问题时,不再写任何东西 */
const UNRECORDABLE: ReadonlySet<RsiOutcome> = new Set([
  'lock_lost',
  'write_denied',
  'state_dir_unsafe',
  'state_invalid',
  'snapshot_invalid',
]);

const IO_ERRNO: ReadonlySet<string> = new Set([
  'EIO',
  'EAGAIN',
  'EMFILE',
  'ENFILE',
  'EBUSY',
  'ENOSPC',
  'EINTR',
  'ETIMEDOUT',
]);

const OUTCOME_SET: ReadonlySet<string> = new Set(RSI_OUTCOMES);

/** 抛错 → R20-6.5 的结果码。fail-closed 原因码不在结果表里的(如 `staging_unsafe_entry`)按 `internal`(可重试)记 */
export function outcomeOfError(e: unknown): RsiOutcome {
  if (e instanceof RsiLockError) {
    if (e.kind === 'locked' || e.kind === 'locked_over_ttl') return 'skipped_locked';
    return OUTCOME_SET.has(e.kind) ? (e.kind as RsiOutcome) : 'internal';
  }
  if (
    e instanceof RsiFailClosedError ||
    e instanceof RsiSnapshotError ||
    e instanceof RsiStagingBlockedError
  ) {
    const r: string = e.reason;
    return OUTCOME_SET.has(r) ? (r as RsiOutcome) : 'internal';
  }
  const code = (e as NodeJS.ErrnoException | null)?.code;
  if (typeof code === 'string' && IO_ERRNO.has(code)) return 'io_error';
  return 'internal';
}

export function isRecordable(o: RsiOutcome): boolean {
  return !UNRECORDABLE.has(o);
}

/** 锁外 / 锁内共用的拒绝判定(不作授权依据的锁外一遍 + 锁内权威一遍);state 不可读同样拒绝(无处记录) */
function refusalOf(o: RsiObservation): string | null {
  if (o.state.state === 'off') return 'off';
  if (o.state.stateInvalid) return 'state_invalid';
  if (o.state.state === 'stopped') return 'stopped';
  if (o.state.collectBlocked !== null) return 'collect_blocked';
  return null;
}

async function updateBusy(
  home: string | undefined,
  isAlive: (pid: number) => boolean,
): Promise<boolean> {
  if (home === undefined || !path.isAbsolute(home)) return false;
  const file = path.join(home, ...UPDATE_LOCK_SEGMENTS);
  let r;
  try {
    r = await readFileSafe(file, { maxBytes: UPDATE_LOCK_MAX_BYTES });
  } catch {
    return false;
  }
  if (r.kind !== 'ok') return false;
  try {
    const doc = JSON.parse(r.bytes.toString('utf8')) as { pid?: unknown };
    return (
      typeof doc.pid === 'number' &&
      Number.isSafeInteger(doc.pid) &&
      doc.pid > 0 &&
      isAlive(doc.pid)
    );
  } catch {
    return false;
  }
}

/** 锁内:读 state.json 供回写(不存在 → 缺省);整份不合规 → state_invalid(不可记录) */
async function stateForWrite(io: IoContext): Promise<{ prev: RsiState; rawConfirm?: unknown }> {
  const s = await readStateForWrite(io);
  return {
    prev: s.prev ?? defaultState(),
    ...(s.rawConfirm !== undefined ? { rawConfirm: s.rawConfirm } : {}),
  };
}

/** 锁内写 state.json + 日志一行 + 快照清单(提交前全量复验) */
async function commitState(
  sctx: RsiServiceCtx,
  lock: RsiLockHandle,
  next: RsiState,
  rawConfirm: unknown,
  log: { action: 'failed' | 'skipped'; code: string } | null,
): Promise<void> {
  await writeStateFile(sctx, lock, next, rawConfirm);
  await commitUnderLockWith(sctx, lock, {
    trigger: WORKER_TRIGGER,
    ...(log !== null ? { log } : {}),
  });
}

/** 只追加日志一行并提交清单(不改 state.json) */
async function commitLogOnly(
  sctx: RsiServiceCtx,
  lock: RsiLockHandle,
  log: { action: 'skipped' | 'failed'; code: string },
): Promise<void> {
  await commitUnderLockWith(sctx, lock, { trigger: WORKER_TRIGGER, log });
}

/** 删早于当前窗口 2 个以上的 poke 预留标记(R20-6.2;只删本格式的普通文件,其它一律不碰) */
async function pruneReservations(io: IoContext, lock: RsiLockHandle, nowMs: number): Promise<void> {
  const d = await rsiDirReadonly(io);
  if (d.kind !== 'ok') return;
  const dir = path.join(d.dir, 'poke');
  let entries;
  try {
    entries = await readDir(dir);
  } catch {
    return;
  }
  const cur = windowIndex(nowMs);
  for (const e of entries) {
    const m = /^(claude|codex|pi|kit)-(\d{1,15})$/.exec(e.name);
    if (m === null || !e.isFile || e.isSymbolicLink) continue;
    if (Number(m[2]) >= cur - RSI_POKE_RESERVATION_KEEP_WINDOWS) continue;
    await lock.assertHeld();
    await remove(io, path.join(dir, e.name));
  }
}

/** `log.jsonl` 截断到最近 200 行(R20-6.7:持锁写入方改写时截断);临时文件 + rename。超长行丢弃 */
async function compactLog(io: IoContext, lock: RsiLockHandle): Promise<void> {
  const d = await rsiDirReadonly(io);
  if (d.kind !== 'ok') return;
  const file = path.join(d.dir, 'log.jsonl');
  const r = await readFileSafe(file, {
    maxBytes: 4 * 1024 * 1024,
    owner: RSI_FILE_OWNER,
  });
  if (r.kind !== 'ok') return;
  const lines = r.bytes
    .toString('utf8')
    .split('\n')
    .filter((l) => l !== '');
  if (lines.length <= RSI_LOG_MAX_LINES) return;
  const keep = lines
    .slice(-RSI_LOG_MAX_LINES)
    .filter((l) => Buffer.byteLength(l, 'utf8') <= RSI_LOG_LINE_MAX_BYTES);
  const tmp = `${file}.tmp`;
  await lock.assertHeld();
  await remove(io, tmp);
  await createExclusive(io, tmp, keep.map((l) => `${l}\n`).join(''), 0o600);
  await lock.assertHeld();
  await rename(io, tmp, file);
}

/** 锁外 `skipped_locked`:只在 `rsi/` 已存在且通过只读安全校验时无锁追加一行;不建、不修、不跟随 */
async function appendSkippedLocked(io: IoContext, now: Date): Promise<void> {
  const d = await rsiDirReadonly(io);
  if (d.kind !== 'ok') return;
  const file = path.join(d.dir, 'log.jsonl');
  try {
    const st = await lstat(file);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return;
  }
  const line = canonicalJsonLine(
    RsiLogLineSchema.parse({
      at: now.toISOString(),
      trigger: WORKER_TRIGGER,
      action: 'skipped',
      code: 'skipped_locked',
    }),
  );
  await appendFile(io, file, line, { mode: 0o600 });
}

export async function runWorker(deps: RsiWorkerRunDeps = {}): Promise<WorkerResult> {
  const env: Env = deps.env ?? {};
  const now = deps.now ?? ((): Date => new Date());
  const nowMs = deps.nowMs ?? ((): number => Date.now());
  const skip = autoSkip(env, 'worker');
  if (skip !== null) return { kind: 'skipped_pre_lock', why: skip };

  const open = await openRsiIo(
    {
      argv: [],
      overlayPath: undefined,
      explicitRoot: undefined,
      env,
      ...(deps.writeAudit !== undefined ? { writeAudit: deps.writeAudit } : {}),
      stdout: () => undefined,
      stderr: () => undefined,
    },
    deps.open,
  );
  if (open.kind !== 'ready') return { kind: 'skipped_pre_lock', why: open.kind };
  const sctx: RsiServiceCtx = { ...open.ctx, now };
  const { io } = sctx;

  // 锁外廉价预检:只读、不作授权依据
  const pre = refusalOf(await observeRsi(io, env));
  if (pre !== null) return { kind: 'skipped_pre_lock', why: pre };
  const gate = await lockGate(sctx.config, io, deps.gate);
  if (gate.kind !== 'lock') return { kind: 'skipped_pre_lock', why: `gate_${gate.kind}` };

  let lock: RsiLockHandle;
  try {
    lock = await acquireRsiLock(io, deps.lock);
  } catch (e) {
    if (e instanceof RsiLockError && (e.kind === 'locked' || e.kind === 'locked_over_ttl')) {
      try {
        await appendSkippedLocked(io, now());
      } catch {
        // 尽力
      }
      return { kind: 'skipped_locked' };
    }
    return { kind: 'skipped_pre_lock', why: 'lock_error' };
  }
  try {
    const track = { logged: false };
    const r = await underLock(sctx, lock, env, deps, now, nowMs, track);
    // 截断放在本轮全部追加之后(Pi 代码评审 #5 / 复核 #2):只要本轮在锁内成功追加过日志就截断,结束时 ≤ 200 行;
    // 真正零业务写入的分支(锁内拒绝、不可记录)没有追加过,不碰日志
    // 不可记录的结局(失锁、写出口拒绝、状态目录不安全……)不截断,保持「连日志也不写」;残余见契约 A3-9
    const unrecordable = r.kind === 'ran' && !r.recorded;
    if (track.logged && !unrecordable) await compactLog(io, lock).catch(() => undefined);
    return r;
  } finally {
    await lock.release().catch(() => undefined);
  }
}

async function underLock(
  sctx: RsiServiceCtx,
  lock: RsiLockHandle,
  env: Env,
  deps: RsiWorkerRunDeps,
  now: () => Date,
  nowMs: () => number,
  track: { logged: boolean },
): Promise<WorkerResult> {
  const { io } = sctx;
  await deps.afterLock?.();
  const obs = await observeRsi(io, env);
  const why = refusalOf(obs);
  if (why !== null) return { kind: 'refused_in_lock', why };
  // 执行配置 = 锁内最新观测(Pi 代码评审 #1 / 复核 #1):在任何维护写入之前就核对仓库根并换上新配置,维护(恢复、purge 续做的脱敏器、taint)
  // 与本轮采集都不再用打开上下文时那份可能已过期的配置;仓库根变了(io 与锁不再对应)→ 锁内拒绝、零业务写入
  if (obs.config.status !== 'on' || obs.config.repo !== sctx.config.repo) {
    return { kind: 'refused_in_lock', why: 'repo_changed' };
  }
  const mctx: RsiServiceCtx = { ...sctx, config: obs.config };
  const isAlive = deps.isAlive ?? makeIsAlive((pid, sig) => process.kill(pid, sig));
  if (await updateBusy(io.hostEnv['HOME'], isAlive)) {
    return finish(mctx, lock, 'skipped_update_busy', false, now, track);
  }

  let halfOpen = false;
  try {
    const gateW = makeGate(lock, deps.run?.beforeWrite);
    const hooks = hooksFromGate(gateW);
    const recovered = await recoverUnderLock(mctx, lock, hooks);
    const confirmed = obs.state.state === 'confirmed';
    const jp = await detectPurgeJournal(mctx);
    if (confirmed && jp.state === 'present') {
      try {
        await resumePurgeUnderLock(mctx, lock, { hooks });
      } catch (e) {
        throw mapPurgeResumeError(e);
      }
    }
    await resumeTaintWith(mctx, lock, hooks);

    // 残留 attempt:上一次在读阶段崩溃 → 先记一次 crashed(R20-6.4),再按更新后的熔断决定本轮(Pi 评审 R2)
    {
      const s = await stateForWrite(io);
      if (s.prev.attempt !== null) {
        const ho = breakerView(s.prev, nowMs()) === 'half_open';
        const next = applyBreaker({ ...s.prev, attempt: null }, 'crashed', now(), ho);
        track.logged = true; // 先置位:追加可能已发生而随后的清单提交失败(Pi 复核 #2)
        await commitState(mctx, lock, next, s.rawConfirm, { action: 'failed', code: 'crashed' });
      }
    }

    // STOP(复检:taint 续做之后)
    const obs2 = await observeRsi(io, env);
    const why2 = refusalOf(obs2);
    if (why2 !== null) return { kind: 'refused_in_lock', why: why2 };
    // 本轮的执行配置 = 锁内最新观测(Pi 代码评审 #1):运行绑定、检查点与实际采集 / 列举 / taint 用同一份配置快照。
    // 打开上下文时的配置可能已过期(收紧的排除 / overlay 在拿锁前写下);仓库根变了则 io 与锁都不再对应 → 拒绝本轮
    if (obs2.config.status !== 'on' || obs2.config.repo !== sctx.config.repo) {
      return { kind: 'refused_in_lock', why: 'repo_changed' };
    }
    const rctx: RsiServiceCtx = { ...sctx, config: obs2.config };

    // 熔断
    const s1 = await stateForWrite(io);
    const view = breakerView(s1.prev, nowMs());
    if (view === 'open') {
      track.logged = true;
      await commitLogOnly(rctx, lock, { action: 'skipped', code: 'breaker_open' });
      return { kind: 'refused_in_lock', why: 'breaker_open' };
    }
    halfOpen = view === 'half_open';

    // L0 到期(锁内兜底;节流比较取反 → A3 变异表必杀)
    if (!l0Due(s1.prev, nowMs())) {
      await pruneReservations(io, lock, nowMs());
      return finish(rctx, lock, 'skipped_throttled', false, now, track);
    }

    // 预写 attempt:一定在读任何会话文件之前落盘(R20-6.4;变异:移到读之后 → 必杀)
    await commitState(
      rctx,
      lock,
      { ...s1.prev, attempt: { started_at: now().toISOString(), nonce: lock.nonce } },
      s1.rawConfirm,
      null,
    );

    const identity = obs2.identity;
    if (identity === null) throw new RsiFailClosedError('internal');
    const startedAtMs = nowMs();
    const l0: L0Deps = {
      ...(deps.run?.l0 ?? {}),
      piDirSet: deps.run?.l0?.piDirSet ?? piDirIsSet(env),
    };
    const runDeps: RunL0Deps = { ...(deps.run ?? {}), l0, nowMs };
    const tickM = tickStateMutator({ trigger: WORKER_TRIGGER, now });
    const ho = halfOpen;
    const stateMutator: StateMutator = (prev, s) =>
      applyBreaker(tickM(prev, s), s.outcome, now(), ho);
    let outcome: RsiOutcome;
    if (obs2.state.state === 'confirmed') {
      const confirmAt =
        obs2.doc.kind === 'ok' ? (obs2.doc.state.confirm?.confirmed_at ?? null) : null;
      const binding = bindingOf({ identity, confirmedAt: confirmAt });
      const input: RunL0Input = {
        trigger: WORKER_TRIGGER,
        recovered,
        binding,
        checkpoint: confirmedCheckpoint({ io, env, binding, nowMs, startedAtMs }),
        stateMutator,
      };
      track.logged = true; // L0 提交(commitL0)最后一步追加本轮结果;先置位,见上
      outcome = (await runL0UnderLock(rctx, lock, input, runDeps)).outcome;
    } else {
      await taintNewlyExcludedWith(rctx, lock, { source: 'exclude' }, hooks);
      const binding = bindingOf({ identity, confirmedAt: null });
      const input: RunL0Input = {
        trigger: WORKER_TRIGGER,
        recovered,
        binding,
        checkpoint: armedCheckpoint({
          io,
          env,
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
      track.logged = true;
      outcome = (await runArmedUnderLock(rctx, lock, input, runDeps)).outcome;
    }
    await pruneReservations(io, lock, nowMs());

    return { kind: 'ran', outcome, recorded: true };
  } catch (e) {
    return finish(mctx, lock, outcomeOfError(e), halfOpen, now, track, true);
  }
}

/**
 * 结束记账:跳过类只写日志一行;失败类按可记录性写熔断(state.json + 日志 + 清单);不可记录 → 零写入。
 * 失败类先做无副作用的全量复验,不通过(数据损坏)→ 放弃记账、零写入;通过后开始写,之后若再失败(如 I/O)是部分提交,由下一个持锁写入方的 recover 收拾。
 */
async function finish(
  sctx: RsiServiceCtx,
  lock: RsiLockHandle,
  outcome: RsiOutcome,
  halfOpen: boolean,
  now: () => Date,
  track: { logged: boolean },
  fromError = false,
): Promise<WorkerResult> {
  if (!isRecordable(outcome)) return { kind: 'ran', outcome, recorded: false };
  try {
    if (!fromError) {
      track.logged = true;
      await commitLogOnly(sctx, lock, { action: 'skipped', code: outcome });
      return { kind: 'ran', outcome, recorded: true };
    }
    // 先做无副作用的全量复验(Pi 代码评审 #2):数据文件已损坏 → 放弃记账、零写入;通过之后才改写 state.json
    await inspectSnapshot(sctx.io, productionSnapshotValidator);
    const s = await stateForWrite(sctx.io);
    const next = applyBreaker({ ...s.prev, attempt: null }, outcome, now(), halfOpen);
    track.logged = true;
    await commitState(sctx, lock, next, s.rawConfirm, { action: 'failed', code: outcome });
    return { kind: 'ran', outcome, recorded: true };
  } catch {
    return { kind: 'ran', outcome, recorded: false };
  }
}
