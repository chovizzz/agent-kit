/**
 * L0 编排(R20-3.9.2、R20-6.7–6.9;R20-A2 B4c2)——**提交侧**。`runL0UnderLock`(confirmed:采集)与 `runArmedUnderLock`(armed:只列举)。调用方(B5 的 tick / worker)
 * 已经:拿 `rsi/lock` → `recoverUnderLock` → `resumeTaint` → STOP / 熔断 / 到期 / attempt 预写 → `captureRunBinding`,再把 `RunL0Input`(含 `recovered`、`binding`、`checkpoint`、`stateMutator`)交进来。
 *
 * `runL0UnderLock`:
 *   #pre `checkpoint('file')`(abort → [A0],此时盐可能都还没建)→ S 盐(`readSaltFile`;absent → 首建,全写点经 gate;empty → D15:持锁 + mtime 满 10 秒才删除重建,不足 10 秒 `salt_invalid`)
 *   → 指纹 → 列举 → 读 cursor → `collectRead`(零写入;abort → [A0];time_limit / 上限 → 继续,`ok_partial`)→ `taintNewlyExcluded`(隐私收紧,写 TAINTED、清暂存区,**不回滚**)
 *   → #0 `checkpoint('commit')`(权威复检,abort → [A0])→ `commitL0`(C1..C7,见 `commit.ts`)。
 * `runArmedUnderLock`(D3):只 `listArmedDetailed`,**不建盐、不读正文、不写数据文件、不写 counts**;只写 state(`armed_listing` 仅完整列举时持久化)+ 日志 + 快照。
 */
import { parse as parseToml } from 'smol-toml';
import { OverlaySchema, type Overlay } from '../../contracts/config.js';
import { KIT_VERSION } from '../../contracts/meta.js';
import type { Redactor } from '../../contracts/redact.js';
import type { TraceReader } from '../../contracts/reader.js';
import type { RsiAgentId, RsiOutcome, RsiState } from '../../contracts/rsi.js';
import { readFileSafe } from '../../io/read-fs.js';
import { createRedactor } from '../../redact/redactor.js';
import { SaltError, readSaltFile } from '../../signals/salt-read.js';
import { loadSalt } from '../../signals/state-store.js';
import {
  RSI_OVERLAY_MAX_BYTES,
  buildRsiPolicy,
  policyFingerprint,
  type RsiConfigOn,
} from '../config.js';
import type { RsiLockHandle } from '../lock.js';
import { commitUnderLockWith } from '../services/commit.js';
import {
  hooksFromGate,
  reclaimEmptySalt,
  readStateForWrite,
  writeStateFile,
} from '../services/fixed-write.js';
import { piDirIsSet } from '../services/open.js';
import { taintNewlyExcludedWith } from '../services/taint.js';
import { RsiFailClosedError, type RsiServiceCtx } from '../types.js';
import { listArmedDetailed } from './armed-listing.js';
import type { BudgetLimits } from './budget.js';
import { createRsiCollectPolicy } from './collect-policy.js';
import { collectRead } from './collect-read.js';
import {
  commitL0,
  logOf,
  makeGate,
  mapWriteError,
  readCursorDoc,
  zeroSummary,
  type AbortVerdict,
  type CommitL0Deps,
  type CommitL0Result,
} from './commit.js';
import { enumerateSessionFiles } from './enumerate.js';
import { cursorFingerprint, overlayRedactionDigestOf } from './fingerprint.js';
import { applyArmedListing, armedListingField, carryConfirm } from './state-mutate.js';
import type { L0Deps, L0Summary, RunL0Input } from './types.js';

const REDACT_TIMEOUT_MS = 250;

export interface RunL0Deps extends CommitL0Deps {
  /** 列举 / 头部读取 / 归属探测的测试缝与上限覆盖(含 `piDirSet`、`probe`、`limits`、`beforeStep`) */
  l0?: L0Deps;
  readers?: Partial<Record<RsiAgentId, TraceReader>>;
  limits?: Partial<BudgetLimits>;
  lineHookEvery?: { lines?: number; bytes?: number };
  /** 缺省按 overlay 构造 */
  redactor?: Redactor;
  /** 墙钟(毫秒),只用于 `duration_ms` 与读阶段的时间预算 */
  nowMs?: () => number;
  fallbackVersion?: string;
}

const nowOf = (ctx: RsiServiceCtx): Date => (ctx.now ?? ((): Date => new Date()))();

/** 盐:`ok` 直接用;`absent` → 首建(全写点经 gate);`empty` → D15(持锁 + 满 10 秒才回收;不足 → `salt_invalid`)。违规一律 `salt_invalid`,不静默重生成 */
async function ensureSalt(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  gate: ReturnType<typeof makeGate>,
  nowMs: number,
): Promise<{ salt: string; saltFp: string }> {
  const hooks = hooksFromGate(gate);
  for (let i = 0; i < 4; i++) {
    let r;
    try {
      r = await readSaltFile(ctx.io.stateDir);
    } catch (e) {
      if (e instanceof SaltError) throw new RsiFailClosedError('salt_invalid');
      throw e;
    }
    if (r.kind === 'ok') return { salt: r.salt, saltFp: r.saltFp };
    if (r.kind === 'empty') {
      const x = await reclaimEmptySalt(ctx, lock, nowMs, hooks);
      if (x === 'young') throw new RsiFailClosedError('salt_invalid');
      if (x === 'not_empty') continue; // 读与删之间别人写好了:重读
    }
    try {
      await loadSalt(ctx.io, { create: true, beforeWrite: gate });
    } catch (e) {
      if (e instanceof SaltError) throw new RsiFailClosedError('salt_invalid');
      mapWriteError(e);
    }
  }
  throw new RsiFailClosedError('salt_invalid');
}

async function fingerprintOf(config: RsiConfigOn, saltFp: string): Promise<string> {
  if (config.overlayPath !== null && config.overlaySha256 === null) {
    throw new RsiFailClosedError('overlay_invalid');
  }
  const ov = await overlayRedactionDigestOf(config.overlayPath);
  if (ov === undefined) throw new RsiFailClosedError('overlay_invalid');
  return cursorFingerprint({
    kitVersion: KIT_VERSION,
    policy: await buildRsiPolicy(config),
    overlayRedactionSha256: ov,
    saltFp,
  });
}

async function buildRedactor(config: RsiConfigOn): Promise<Redactor> {
  let overlay: Overlay | undefined;
  if (config.overlayPath !== null) {
    try {
      const r = await readFileSafe(config.overlayPath, { maxBytes: RSI_OVERLAY_MAX_BYTES });
      if (r.kind !== 'ok') throw new Error('overlay');
      overlay = OverlaySchema.parse(parseToml(r.bytes.toString('utf8')));
    } catch {
      throw new RsiFailClosedError('overlay_invalid');
    }
  }
  try {
    return createRedactor(
      { sensitive_words: overlay?.sensitive_words ?? [], timeout_ms: REDACT_TIMEOUT_MS },
      { internalDomains: overlay?.internal_domains ?? [] },
    );
  } catch {
    throw new RsiFailClosedError('redactor_init');
  }
}

export async function runL0UnderLock(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  input: RunL0Input,
  deps: RunL0Deps = {},
): Promise<CommitL0Result> {
  const { io, config } = ctx;
  const gate = makeGate(lock, deps.beforeWrite);
  const hooks = hooksFromGate(gate);
  const common = {
    trigger: input.trigger,
    checkpoint: input.checkpoint,
    stateMutator: input.stateMutator,
  } as const;
  const nullRedactor = {
    pass2: (): never => {
      throw new RsiFailClosedError('internal');
    },
  };

  // #pre:读阶段开始之前的检查点;abort → [A0](盐可能都还没建)
  const pre = await input.checkpoint('file');
  if (pre.kind === 'abort') {
    // 盐可能还没建:只读取(不建、不等待);读不到 / 违规都当「没有盐」(staged 校正因此跳过,不阻断结果记录)
    let saltFp: string | null = null;
    try {
      const r = await readSaltFile(io.stateDir);
      if (r.kind === 'ok') saltFp = r.saltFp;
    } catch (e) {
      if (!(e instanceof SaltError)) throw e;
    }
    return commitL0(
      ctx,
      lock,
      {
        ...common,
        batch: null,
        salt: saltFp === null ? null : { saltFp },
        a0: pre,
        redactor: nullRedactor,
      },
      deps,
    );
  }

  // S 盐
  const salt = await ensureSalt(ctx, lock, gate, nowOf(ctx).getTime());
  const fingerprint = await fingerprintOf(config, salt.saltFp);
  const redactor = deps.redactor ?? (await buildRedactor(config));

  const home = io.hostEnv['HOME'] as string;
  const piSet = deps.l0?.piDirSet ?? piDirIsSet(undefined);
  const enumeration = await enumerateSessionFiles(home, config, piSet, deps.l0);
  const prevCursor = await readCursorDoc(io);
  const policy = await createRsiCollectPolicy(config, io.stateDir, deps.l0?.probe);

  const batch = await collectRead({
    enumeration,
    prevCursor,
    fingerprint,
    salt: salt.salt,
    nowIso: nowOf(ctx).toISOString(),
    policy,
    redactor,
    checkpoint: input.checkpoint,
    ...(deps.readers !== undefined ? { readers: deps.readers } : {}),
    ...(deps.fallbackVersion !== undefined ? { fallbackVersion: deps.fallbackVersion } : {}),
    ...(deps.limits !== undefined ? { limits: deps.limits } : {}),
    ...(deps.nowMs !== undefined ? { nowMs: deps.nowMs } : {}),
    ...(deps.l0 !== undefined ? { deps: deps.l0 } : {}),
    ...(deps.lineHookEvery !== undefined ? { lineHookEvery: deps.lineHookEvery } : {}),
  });

  let a0: AbortVerdict | null = batch.verdict.kind === 'abort' ? batch.verdict : null;
  if (a0 === null) {
    // 新 taint(隐私收紧,不回滚);写点经同一个 gate
    await taintNewlyExcludedWith(ctx, lock, { source: 'exclude' }, hooks);
    // #0 权威复检
    const v0 = await input.checkpoint('commit');
    if (v0.kind === 'abort') a0 = v0;
  }
  return commitL0(ctx, lock, { ...common, batch, salt, a0, redactor }, deps);
}

export interface ArmedRunResult {
  outcome: RsiOutcome;
  summary: L0Summary;
  /** 快照清单提交后的 generation */
  generation: number;
}

/**
 * armed(首次 / 失效后):只列举 + 读头部。不建盐、不写数据文件、不写 counts(D3);state 回写时 `armed_listing` 只在列举**完整**时持久化,
 * 不完整保持磁盘原值(没有就不写);`confirm` 按磁盘值回写(坏 confirm 原样透传)。
 */
export async function runArmedUnderLock(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  input: RunL0Input,
  deps: RunL0Deps = {},
): Promise<ArmedRunResult> {
  const { io, config } = ctx;
  const gate = makeGate(lock, deps.beforeWrite);
  const hooks = hooksFromGate(gate);
  const t0 = (deps.nowMs ?? ((): number => Date.now()))();
  const pre = await input.checkpoint('file');
  const aborted = pre.kind === 'abort' ? pre : null;
  const listing = aborted === null ? await listArmedDetailed(io, config, deps.l0) : null;

  const summary: L0Summary = {
    ...zeroSummary(aborted !== null ? aborted.outcome : 'ok'),
    ...(listing !== null
      ? {
          files_planned: listing.filesRead,
          bytes_read: listing.bytesRead,
          limits_hit: listing.limitsHit,
        }
      : {}),
    duration_ms: Math.max(0, (deps.nowMs ?? ((): number => Date.now()))() - t0),
  };
  const policyFp = policyFingerprint(await buildRsiPolicy(config));
  const stateDoc = await readStateForWrite(io);
  const field =
    listing === null
      ? undefined
      : armedListingField(listing, nowOf(ctx).toISOString(), policyFp, config.agents);
  const next: RsiState = applyArmedListing(
    carryConfirm(stateDoc.prev, input.stateMutator(stateDoc.prev, summary)),
    stateDoc.prev,
    field,
  );
  await writeStateFile(ctx, lock, next, stateDoc.rawConfirm, hooks);
  const lg = logOf(summary.outcome);
  const committed = await commitUnderLockWith(
    ctx,
    lock,
    {
      trigger: input.trigger,
      log: {
        action: lg.action,
        code: lg.code,
        duration_ms: summary.duration_ms,
        counts: { files_planned: summary.files_planned, bytes_read: summary.bytes_read },
      },
    },
    hooks,
  );
  return { outcome: summary.outcome, summary, generation: committed.generation };
}
