/**
 * C1a:错误分类 `classify` / `classifyHalt` / `resolveLockLoss`,以及 `safetyFallback` 与原始异常的合并协议(`runFallbackOnce`、`planAfterFallback`)。
 * 原异常的 outcome 永不被兜底替换;rsi 失锁与零写入五类一律不调兜底;单飞;`aborted` 不调 `finish`。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RsiOutcome } from '../../../src/contracts/rsi.js';
import { RSI_OUTCOMES } from '../../../src/contracts/rsi.js';
import { readTextSync } from '../../../src/io/read-fs.js';
import { RsiLockError, type RsiLockErrorKind } from '../../../src/rsi/lock-error.js';
import type { StepHalt } from '../../../src/rsi/personal/candidate-ports.js';
import {
  DefinitelyNotWritten,
  PersonalLockLost,
  RoundInternalError,
  StaleGrowth,
  classify,
  classifyHalt,
  resolveLockLoss,
} from '../../../src/rsi/personal/stage/errors.js';
import {
  fallbackLogCode,
  fallbackSkipReason,
  newFallbackTrack,
  planAfterFallback,
  runFallbackOnce,
} from '../../../src/rsi/personal/stage/fallback.js';
import {
  FALLBACK_REPORT_KINDS,
  FALLBACK_SKIP_OUTCOMES,
  type FallbackCtx,
  type FallbackReport,
} from '../../../src/rsi/personal/stage/types.js';
import { ROOT } from '../closure-util.js';

describe('classify', () => {
  it('rsi lock_lost → rethrow(无条件上抛)', () => {
    expect(classify(new RsiLockError('lock_lost'))).toEqual({ kind: 'rethrow' });
  });
  it('PersonalLockLost → end_personal_round;且 PersonalLockLost 不是 RsiLockError(不会被映射成 UNRECORDABLE)', () => {
    expect(classify(new PersonalLockLost())).toEqual({ kind: 'end_personal_round' });
    expect(new PersonalLockLost()).not.toBeInstanceOf(RsiLockError);
  });
  const OTHERS: RsiLockErrorKind[] = [
    'locked',
    'locked_over_ttl',
    'state_dir_unsafe',
    'write_denied',
    'internal',
  ];
  it.each(OTHERS)(
    '其它 RsiLockError(%s)→ fault lock_error:<kind>(不 rethrow、不当成个人锁丢失)',
    (kind) => {
      expect(classify(new RsiLockError(kind))).toEqual({
        kind: 'fault',
        fault: { code: `lock_error:${kind}`, detail: 'RsiLockError' },
      });
    },
  );
  it('RoundInternalError → fault internal(带 reason);DefinitelyNotWritten / StaleGrowth / 普通错 / 非 Error → step_threw', () => {
    expect(classify(new RoundInternalError('write_in_flight:effects'))).toEqual({
      kind: 'fault',
      fault: { code: 'internal', detail: 'write_in_flight:effects' },
    });
    expect(classify(new DefinitelyNotWritten('x'))).toEqual({
      kind: 'fault',
      fault: { code: 'step_threw', detail: 'Error' },
    });
    expect(classify(new StaleGrowth('gen_changed'))).toEqual({
      kind: 'fault',
      fault: { code: 'step_threw', detail: 'Error' },
    });
    expect(classify(new TypeError('t'))).toEqual({
      kind: 'fault',
      fault: { code: 'step_threw', detail: 'TypeError' },
    });
    expect(classify('str')).toEqual({
      kind: 'fault',
      fault: { code: 'step_threw', detail: 'string' },
    });
    expect(classify(undefined)).toEqual({
      kind: 'fault',
      fault: { code: 'step_threw', detail: 'undefined' },
    });
  });
  it('故障里不带错误消息(避免路径外泄)', () => {
    const c = classify(new Error('/Users/secret/path'));
    expect(JSON.stringify(c)).not.toContain('secret');
  });
});

describe('classifyHalt(StepHalt 的处置;lock_lost 不能默认当个人锁)', () => {
  it('逐值钉死', () => {
    const table: Record<StepHalt, unknown> = {
      repo_absent: { kind: 'stop_step' },
      repo_deferred: { kind: 'stop_step' },
      repo_invalid: { kind: 'stop_step_unsettled', cause: 'repo_invalid' },
      revocations_invalid: { kind: 'stop_step_unsettled', cause: 'revocations_invalid' },
      commit_failed: { kind: 'stop_step_unsettled', cause: 'commit_failed' },
      candidate_invalid: { kind: 'stop_step_unsettled', cause: 'candidate_invalid' },
      lock_lost: { kind: 'lock_lost_unresolved' },
    };
    for (const [h, want] of Object.entries(table))
      expect(classifyHalt(h as StepHalt), h).toEqual(want);
  });
  it('未知值(跨信任边界)→ 按完整性不明处理(停本步并 unsettled),绝不当成可继续', () => {
    expect(classifyHalt('brand_new' as StepHalt).kind).toBe('stop_step_unsettled');
  });
});

describe('resolveLockLoss:StepHalt=lock_lost 查明是哪把锁', () => {
  const held = { assertHeld: () => Promise.resolve() };
  const lostRsi = { assertHeld: () => Promise.reject(new RsiLockError('lock_lost')) };
  const lostPersonal = { assertHeld: () => Promise.reject(new PersonalLockLost()) };
  it('rsi 丢 → rsi;两把都丢 → rsi(上抛优先);个人丢 → personal;都在手 → unknown', async () => {
    expect(await resolveLockLoss(lostRsi, held)).toBe('rsi');
    expect(await resolveLockLoss(lostRsi, lostPersonal)).toBe('rsi');
    expect(await resolveLockLoss(held, lostPersonal)).toBe('personal');
    expect(await resolveLockLoss(held, held)).toBe('unknown');
  });
  it('复核本身 I/O 失败 → unknown(fail-closed:调用方按个人锁结束并 unsettled)', async () => {
    const io = { assertHeld: () => Promise.reject(new Error('EIO')) };
    expect(await resolveLockLoss(io, held)).toBe('unknown');
    expect(await resolveLockLoss(held, io)).toBe('unknown');
  });
});

describe('兜底跳过集合 = worker 既有的零写入契约 UNRECORDABLE', () => {
  it('FALLBACK_SKIP_OUTCOMES 与 worker.ts 的 UNRECORDABLE 逐项相等(防两侧漂移)', () => {
    const src = readTextSync(path.join(ROOT, 'src/rsi/worker.ts'));
    const m = /const UNRECORDABLE[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(src);
    expect(m).not.toBeNull();
    const names = [...(m?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    expect(names.sort()).toEqual([...FALLBACK_SKIP_OUTCOMES].sort());
    expect([...FALLBACK_SKIP_OUTCOMES].sort()).toEqual([
      'lock_lost',
      'snapshot_invalid',
      'state_dir_unsafe',
      'state_invalid',
      'write_denied',
    ]);
    for (const o of FALLBACK_SKIP_OUTCOMES) expect(RSI_OUTCOMES).toContain(o);
  });
});

const CTX = {} as unknown as FallbackCtx;
const eligible = { eligible: () => true };

interface TestStage {
  calls: number;
  eligible(): boolean;
  safetyFallback(ctx: FallbackCtx): Promise<FallbackReport>;
}
function stageOf(report: () => Promise<FallbackReport>, el = true): TestStage {
  const s: TestStage = {
    calls: 0,
    eligible: () => el,
    safetyFallback: () => {
      s.calls += 1;
      return report();
    },
  };
  return s;
}

describe('fallbackSkipReason(纯判定;表驱动)', () => {
  const base = {
    original: new Error('eio'),
    outcome: 'io_error' as RsiOutcome,
    track: newFallbackTrack(),
    stage: eligible,
  };
  it('正向对照:io_error + 有资格的 stage + 未完成 P → 应调用(null)', () => {
    expect(fallbackSkipReason(base)).toBeNull();
  });
  it.each(FALLBACK_SKIP_OUTCOMES)('零写入类 outcome %s → unrecordable_outcome', (outcome) => {
    expect(fallbackSkipReason({ ...base, outcome })).toBe('unrecordable_outcome');
  });
  it('原异常是 rsi lock_lost → rsi_lock_lost(优先于其余);个人失锁 / 其它 RsiLockError 不属于它', () => {
    expect(
      fallbackSkipReason({
        ...base,
        original: new RsiLockError('lock_lost'),
        outcome: 'lock_lost',
      }),
    ).toBe('rsi_lock_lost');
    expect(
      fallbackSkipReason({ ...base, original: new RsiLockError('lock_lost'), outcome: 'io_error' }),
    ).toBe('rsi_lock_lost');
    expect(fallbackSkipReason({ ...base, original: new RsiLockError('write_denied') })).toBeNull();
  });
  it('pCompleted / fallbackTried / 无 stage / 无资格 / eligible 抛错 → 各自的原因', () => {
    expect(
      fallbackSkipReason({ ...base, track: { pCompleted: true, fallbackTried: false, fb: null } }),
    ).toBe('p_completed');
    expect(
      fallbackSkipReason({ ...base, track: { pCompleted: false, fallbackTried: true, fb: null } }),
    ).toBe('already_tried');
    expect(fallbackSkipReason({ ...base, stage: undefined })).toBe('no_stage');
    expect(fallbackSkipReason({ ...base, stage: { eligible: () => false } })).toBe('ineligible');
    expect(
      fallbackSkipReason({
        ...base,
        stage: {
          eligible: () => {
            throw new Error('x');
          },
        },
      }),
    ).toBe('ineligible');
  });
});

describe('runFallbackOnce(单飞协调器;永不抛)', () => {
  const run = (
    stage: TestStage | undefined,
    track = newFallbackTrack(),
    over: { original?: unknown; outcome?: RsiOutcome } = {},
  ) =>
    runFallbackOnce({
      track,
      stage,
      ctx: CTX,
      original: over.original ?? new Error('eio'),
      outcome: over.outcome ?? 'io_error',
    });

  it('调用一次并存入 track.fb;置 fallbackTried', async () => {
    const s = stageOf(() => Promise.resolve({ kind: 'muted' }));
    const t = newFallbackTrack();
    expect(await run(s, t)).toEqual({ kind: 'muted' });
    expect(s.calls).toBe(1);
    expect(t.fallbackTried).toBe(true);
    expect(t.fb).toEqual({ kind: 'muted' });
  });

  it('fallback_single_shot_after_p_contract_violation:两条入口共用 track —— 第二次不再调用,读同一个 fb', async () => {
    const s = stageOf(() => Promise.resolve({ kind: 'aborted', why: 'rsi_lock_lost' }));
    const t = newFallbackTrack();
    const viaP = await run(s, t); // P 违约包装层
    const viaCatch = await run(s, t); // catch
    expect(s.calls).toBe(1);
    expect(viaP).toEqual({ kind: 'aborted', why: 'rsi_lock_lost' });
    expect(viaCatch).toBe(viaP);
  });

  it('跳过:零写入类 / rsi 失锁 / pCompleted / 无 stage / 无资格 → 不调用,返回 track.fb(null)', async () => {
    const s = stageOf(() => Promise.resolve({ kind: 'muted' }));
    for (const outcome of FALLBACK_SKIP_OUTCOMES)
      expect(await run(s, newFallbackTrack(), { outcome })).toBeNull();
    expect(
      await run(s, newFallbackTrack(), { original: new RsiLockError('lock_lost') }),
    ).toBeNull();
    expect(await run(s, { pCompleted: true, fallbackTried: false, fb: null })).toBeNull();
    expect(await run(undefined)).toBeNull();
    expect(await run(stageOf(() => Promise.resolve({ kind: 'muted' }), false))).toBeNull();
    expect(s.calls).toBe(0);
    expect(newFallbackTrack().fallbackTried).toBe(false);
  });

  it('fallback_never_throws:兜底抛普通错 → threw(带类名);抛 rsi lock_lost → aborted(rsi_lock_lost);抛非 Error → threw', async () => {
    expect(await run(stageOf(() => Promise.reject(new TypeError('t'))))).toEqual({
      kind: 'threw',
      name: 'TypeError',
    });
    expect(await run(stageOf(() => Promise.reject(new RsiLockError('lock_lost'))))).toEqual({
      kind: 'aborted',
      why: 'rsi_lock_lost',
    });
    expect(await run(stageOf(() => Promise.reject('x')))).toEqual({
      kind: 'threw',
      name: 'string',
    });
    const syncThrow = {
      eligible: () => true,
      safetyFallback: (): Promise<FallbackReport> => {
        throw new Error('sync');
      },
    };
    expect(
      await runFallbackOnce({
        track: newFallbackTrack(),
        stage: syncThrow,
        ctx: CTX,
        original: new Error('e'),
        outcome: 'io_error',
      }),
    ).toEqual({ kind: 'threw', name: 'Error' });
  });

  it('失败的兜底也算已调用(不重试)', async () => {
    const s = stageOf(() => Promise.reject(new Error('x')));
    const t = newFallbackTrack();
    await run(s, t);
    await run(s, t);
    expect(s.calls).toBe(1);
  });
});

describe('planAfterFallback(原异常的 outcome 永不被替换)', () => {
  it('recover_eio_fallback_eio_preserves_original_outcome:任何兜底结果下 outcome 都原样带回,finish 照常调用', () => {
    const reports: (FallbackReport | null)[] = [
      null,
      { kind: 'muted' },
      { kind: 'removed' },
      { kind: 'marker' },
      { kind: 'unreliable' },
      { kind: 'nothing' },
      { kind: 'threw', name: 'Error' },
    ];
    for (const outcome of ['io_error', 'internal', 'crashed'] as RsiOutcome[]) {
      for (const fb of reports) {
        const plan = planAfterFallback(outcome, fb);
        expect(plan.outcome).toBe(outcome);
        expect(plan.callFinish).toBe(true);
      }
    }
  });
  it('日志码 safety_fallback_<kind>;被跳过不写行', () => {
    expect(planAfterFallback('io_error', null).logCode).toBeNull();
    for (const kind of ['muted', 'removed', 'marker', 'unreliable', 'nothing'] as const) {
      expect(planAfterFallback('io_error', { kind }).logCode).toBe(`safety_fallback_${kind}`);
    }
    expect(planAfterFallback('io_error', { kind: 'threw', name: 'E' }).logCode).toBe(
      'safety_fallback_threw',
    );
    expect(fallbackLogCode({ kind: 'aborted', why: 'rsi_lock_lost' })).toBe(
      'safety_fallback_aborted',
    );
    for (const k of FALLBACK_REPORT_KINDS)
      expect(`safety_fallback_${k}`).toMatch(/^[A-Za-z0-9_=.:-]{1,64}$/);
  });
  it('aborted_still_calls_finish 的反面:fallback 失锁 → 不调 finish,零后续写入(logCode 也为 null),outcome 仍是原异常的', () => {
    const plan = planAfterFallback('io_error', { kind: 'aborted', why: 'rsi_lock_lost' });
    expect(plan).toEqual({ outcome: 'io_error', callFinish: false, logCode: null });
  });
});
