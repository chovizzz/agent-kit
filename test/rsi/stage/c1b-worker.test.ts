/**
 * C1b:worker.ts 的个人步接线(真 `runWorker` + 假 `PersonalStage`;假 HOME / 真快照与锁)。
 * 覆盖:相位 0(不 eligible)逐字节同行为、P 在 `recoverUnderLock` 之后恰好一次、`update_busy` 后移(`update_in_progress_still_runs_P`)、
 * 兜底合并协议(原异常的 outcome 永不被替换;失锁 / 零写入五类 / `pCompleted` / 已试 一律不调;兜底自身失败只记日志)、P 违约路径、日志摘要与失锁。
 * 期望值手写。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bindWorkerPersonal } from '../../../src/rsi/assemble-worker.js';
import { RsiLockError } from '../../../src/rsi/lock-error.js';
import { exists, readText } from '../../../src/io/read-fs.js';
import { mkdirp, writeFile } from '../../../src/io/safe-fs.js';
import type {
  FallbackCtx,
  FallbackReport,
  PersonalCtx,
  PersonalRound,
  PersonalStage,
} from '../../../src/rsi/personal/stage/types.js';
import { personalSummaryLine, runWorker, type RsiWorkerRunDeps } from '../../../src/rsi/worker.js';
import { RsiFailClosedError } from '../../../src/rsi/types.js';
import { type TickFx, loseLockOf, makeTickFx } from '../b5a-fixture.js';
import { treeOf } from '../rsi-fixture.js';
import { NOW } from '../ro-fixture.js';

const T = Date.parse(NOW);
const eio = (): Error => Object.assign(new Error('eio'), { code: 'EIO' });

const CLEAN: PersonalRound = {
  growth: { kind: 'denied', code: 'update_busy' },
  faults: [],
  unsettled: [],
  l0DueNow: true,
  flags: { diverged: false, owner_changed: false },
  rollback_stalled: [],
  protection_marks: [],
};

interface Rec {
  runs: PersonalCtx[];
  fallbacks: FallbackCtx[];
  eligibleCalls: number;
}
function stageOf(
  o: {
    eligible?: () => boolean;
    run?: (ctx: PersonalCtx, rec: Rec) => Promise<PersonalRound>;
    fallback?: (ctx: FallbackCtx, rec: Rec) => Promise<FallbackReport>;
  } = {},
): { stage: PersonalStage; rec: Rec } {
  const rec: Rec = { runs: [], fallbacks: [], eligibleCalls: 0 };
  const stage: PersonalStage = {
    eligible: () => {
      rec.eligibleCalls += 1;
      return (o.eligible ?? (() => true))();
    },
    run: (ctx) => {
      rec.runs.push(ctx);
      return (o.run ?? (() => Promise.resolve(CLEAN)))(ctx, rec);
    },
    safetyFallback: (ctx) => {
      rec.fallbacks.push(ctx);
      return (o.fallback ?? (() => Promise.resolve({ kind: 'muted' } as FallbackReport)))(ctx, rec);
    },
  };
  return { stage, rec };
}

/** 测试注入的是 PersonalStage(含假件);这里经生产同一个 `bindWorkerPersonal` 绑上真实兜底协调器,与生产装配同一条路径 */
type WdOver = Omit<Partial<RsiWorkerRunDeps>, 'personal'> & { personal?: PersonalStage };
function wd(f: TickFx, over: WdOver = {}): RsiWorkerRunDeps {
  const { personal, ...rest } = over;
  return {
    env: f.env,
    now: () => new Date(T),
    nowMs: () => T,
    ...rest,
    ...(personal === undefined ? {} : { personal: bindWorkerPersonal(personal) }),
  };
}

/** 让 `recoverUnderLock` 在它的 `before:recover` 写点抛错 */
const failRecover = (make: () => Error): NonNullable<RsiWorkerRunDeps['run']> => ({
  beforeWrite: (op) => (op === 'recover' ? Promise.reject(make()) : Promise.resolve()),
});

async function logCodes(f: TickFx): Promise<string[]> {
  const p = path.join(f.rsiDir, 'log.jsonl');
  if (!(await exists(p))) return [];
  return (await readText(p))
    .trim()
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => (JSON.parse(l) as { code: string }).code);
}

async function makeUpdateBusy(f: TickFx): Promise<void> {
  const dir = path.join(f.home, '.local', 'state', 'agent-kit', 'update');
  await mkdirp(f.fx, dir, 0o700);
  await writeFile(f.fx, path.join(dir, 'lock'), JSON.stringify({ pid: 4242 }), { mode: 0o600 });
}

describe('相位 0 / 不 eligible:worker 与没有个人步时同行为', () => {
  it('eligible 为假:run / safetyFallback 调用数 0;结果与无 personal 的运行相同', async () => {
    const f1 = await makeTickFx('c1b-w-inel-a-', { confirmed: true });
    const f2 = await makeTickFx('c1b-w-inel-b-', { confirmed: true });
    const { stage, rec } = stageOf({ eligible: () => false });
    const r1 = await runWorker(wd(f1, { personal: stage }));
    const r2 = await runWorker(wd(f2));
    expect(r1).toEqual(r2);
    expect(rec.runs).toHaveLength(0);
    expect(rec.fallbacks).toHaveLength(0);
    expect(await logCodes(f1)).toEqual(await logCodes(f2));
  });

  it('不 eligible 时 update_busy 仍是原来的早返回(P 不跑)', async () => {
    const f = await makeTickFx('c1b-w-inel-upd-', { confirmed: true });
    await makeUpdateBusy(f);
    const { stage, rec } = stageOf({ eligible: () => false });
    const r = await runWorker(wd(f, { personal: stage, isAlive: (p) => p === 4242 }));
    expect(r).toEqual({ kind: 'ran', outcome: 'skipped_update_busy', recorded: true });
    expect(rec.runs).toHaveLength(0);
  });

  it('eligible 抛错 = 不进(fail-closed);恢复失败时也不调兜底', async () => {
    const f = await makeTickFx('c1b-w-elig-throws-', { confirmed: true });
    const { stage, rec } = stageOf({
      eligible: () => {
        throw new Error('phase unreadable');
      },
    });
    const r = await runWorker(wd(f, { personal: stage, run: failRecover(eio) }));
    expect(r).toEqual({ kind: 'ran', outcome: 'io_error', recorded: true });
    expect(rec.runs).toHaveLength(0);
    expect(rec.fallbacks).toHaveLength(0);
  });

  it('phase0_recover_failure_does_not_call_safety_fallback:没有 personal 时 recover 失败的行为不变(io_error 记账)', async () => {
    const f = await makeTickFx('c1b-w-nostage-', { confirmed: true });
    const r = await runWorker(wd(f, { run: failRecover(eio) }));
    expect(r).toEqual({ kind: 'ran', outcome: 'io_error', recorded: true });
    expect(await logCodes(f)).toEqual(['io_error']);
  });
});

describe('P:recoverUnderLock 之后恰好一次', () => {
  it('eligible:run 恰好一次,ctx 带真实锁句柄与 updateBusy=false;在 recover 的写点之后', async () => {
    const f = await makeTickFx('c1b-w-p-once-', { confirmed: true });
    const seen: string[] = [];
    const { stage, rec } = stageOf({
      run: () => {
        seen.push('run');
        return Promise.resolve(CLEAN);
      },
    });
    const r = await runWorker(
      wd(f, {
        personal: stage,
        run: {
          beforeWrite: (op) => {
            if (op === 'recover') seen.push('recover');
            return Promise.resolve();
          },
        },
      }),
    );
    expect(r).toMatchObject({ kind: 'ran', outcome: 'ok' });
    expect(rec.runs).toHaveLength(1);
    expect(seen.slice(0, 2)).toEqual(['recover', 'run']);
    expect(seen.filter((s) => s === 'run')).toHaveLength(1);
    const ctx = rec.runs[0] as PersonalCtx;
    expect(ctx.updateBusy).toBe(false);
    expect(typeof ctx.lock.nonce).toBe('string');
    expect(rec.fallbacks).toHaveLength(0);
    // 常态零行摘要
    expect((await logCodes(f)).filter((c) => /^(safety_|personal_)/.test(c))).toEqual([]);
  });

  it('update_in_progress_still_runs_P:update/lock 被存活进程持有且个人步可用 → run 仍恰好一次(updateBusy=true),outcome skipped_update_busy 记账;L0 / purge 续做不运行', async () => {
    const f = await makeTickFx('c1b-w-upd-p-', {
      confirmed: true,
      state: { consecutive_failures: 1 },
    });
    await makeUpdateBusy(f);
    const { stage, rec } = stageOf();
    const r = await runWorker(wd(f, { personal: stage, isAlive: (p) => p === 4242 }));
    expect(r).toEqual({ kind: 'ran', outcome: 'skipped_update_busy', recorded: true });
    expect(rec.runs).toHaveLength(1);
    expect((rec.runs[0] as PersonalCtx).updateBusy).toBe(true);
    expect(await exists(path.join(f.io.stateDir, 'salt'))).toBe(false); // 没读会话
    expect(await logCodes(f)).toEqual(['skipped_update_busy']);
  });
});

describe('兜底合并协议(catch)', () => {
  it('recover_eio_fallback_eio_preserves_original_outcome:原 io_error;兜底自身抛错 → 日志 safety_fallback_threw;outcome 仍 io_error;finish 照常(熔断记账)', async () => {
    const f = await makeTickFx('c1b-w-fb-eio-', { confirmed: true });
    const { stage, rec } = stageOf({ fallback: () => Promise.reject(eio()) });
    const r = await runWorker(wd(f, { personal: stage, run: failRecover(eio) }));
    expect(r).toEqual({ kind: 'ran', outcome: 'io_error', recorded: true });
    expect(rec.fallbacks).toHaveLength(1);
    expect((rec.fallbacks[0] as FallbackCtx).origin).toBe('recover_under_lock');
    expect(rec.runs).toHaveLength(0);
    expect(await logCodes(f)).toEqual(['safety_fallback_threw', 'io_error']);
  });

  it('兜底成功(muted):outcome 仍是原异常的 io_error;日志先 safety_fallback_muted 再 io_error', async () => {
    const f = await makeTickFx('c1b-w-fb-ok-', { confirmed: true });
    const { stage, rec } = stageOf();
    const r = await runWorker(wd(f, { personal: stage, run: failRecover(eio) }));
    expect(r).toEqual({ kind: 'ran', outcome: 'io_error', recorded: true });
    expect(rec.fallbacks).toHaveLength(1);
    expect(await logCodes(f)).toEqual(['safety_fallback_muted', 'io_error']);
  });

  it('兜底报告的 kind 不影响 outcome:任何报告都不改写 internal / io_error', async () => {
    for (const kind of ['removed', 'marker', 'unreliable', 'nothing'] as const) {
      const f = await makeTickFx(`c1b-w-fb-kind-${kind}-`, { confirmed: true });
      const { stage } = stageOf({ fallback: () => Promise.resolve({ kind }) });
      const r = await runWorker(wd(f, { personal: stage, run: failRecover(eio) }));
      expect(r, kind).toEqual({ kind: 'ran', outcome: 'io_error', recorded: true });
      expect(await logCodes(f), kind).toEqual([`safety_fallback_${kind}`, 'io_error']);
    }
  });

  it('recover_rsi_lock_lost_never_calls_fallback:原异常是 rsi lock_lost → 兜底零调用,零后续写入', async () => {
    const f = await makeTickFx('c1b-w-fb-lost-', { confirmed: true });
    const before = await treeOf(f.io.stateDir);
    const { stage, rec } = stageOf();
    const r = await runWorker(
      wd(f, { personal: stage, run: failRecover(() => new RsiLockError('lock_lost')) }),
    );
    expect(r).toEqual({ kind: 'ran', outcome: 'lock_lost', recorded: false });
    expect(rec.fallbacks).toHaveLength(0);
    expect(await treeOf(f.io.stateDir)).toEqual(before);
  });

  it('fallback_skipped_for_unrecordable_outcomes:零写入五类逐个(表驱动),兜底调用数 0,状态目录字节不变', async () => {
    const cases: [string, () => Error][] = [
      ['lock_lost', () => new RsiLockError('lock_lost')],
      ['write_denied', () => new RsiLockError('write_denied')],
      ['state_dir_unsafe', () => new RsiLockError('state_dir_unsafe')],
      ['state_invalid', () => new RsiFailClosedError('state_invalid')],
      ['snapshot_invalid', () => new RsiFailClosedError('snapshot_invalid')],
    ];
    for (const [outcome, make] of cases) {
      const f = await makeTickFx(`c1b-w-fb-unrec-${outcome}-`, { confirmed: true });
      const before = await treeOf(f.io.stateDir);
      const { stage, rec } = stageOf();
      const r = await runWorker(wd(f, { personal: stage, run: failRecover(make) }));
      expect(r, outcome).toEqual({ kind: 'ran', outcome, recorded: false });
      expect(rec.fallbacks, outcome).toHaveLength(0);
      expect(await treeOf(f.io.stateDir), outcome).toEqual(before);
    }
  });

  it('fallback_loses_rsi_lock_stops_all_further_writes:兜底报告 aborted → 不调 finish;原 outcome 不变;状态目录零变化', async () => {
    const f = await makeTickFx('c1b-w-fb-abort-', { confirmed: true });
    const { stage, rec } = stageOf({
      fallback: () => Promise.resolve({ kind: 'aborted', why: 'rsi_lock_lost' }),
    });
    const before = await treeOf(f.io.stateDir);
    const r = await runWorker(wd(f, { personal: stage, run: failRecover(eio) }));
    expect(r).toEqual({ kind: 'ran', outcome: 'io_error', recorded: false });
    expect(rec.fallbacks).toHaveLength(1);
    expect(await treeOf(f.io.stateDir)).toEqual(before);
  });

  it('兜底成功后追加安全日志时发现 rsi 失锁:停止,不调 finish(state / 清单 / 日志零写),outcome 仍是原异常的', async () => {
    const f = await makeTickFx('c1b-w-fb-logloss-', { confirmed: true });
    const { stage } = stageOf({
      fallback: async () => {
        await loseLockOf(f);
        return { kind: 'muted' };
      },
    });
    const r = await runWorker(wd(f, { personal: stage, run: failRecover(eio) }));
    expect(r).toEqual({ kind: 'ran', outcome: 'io_error', recorded: false });
    expect(await logCodes(f)).toEqual([]);
  });

  it('P 返回之后的抛点不再调兜底(pCompleted):outcome 由该异常算出并正常记账', async () => {
    const f = await makeTickFx('c1b-w-fb-pdone-', { confirmed: true });
    const { stage, rec } = stageOf();
    let armed = false;
    const r = await runWorker(
      wd(f, {
        personal: stage,
        run: {
          beforeWrite: (op) => {
            if (rec.runs.length > 0 && op !== 'recover' && !armed) {
              armed = true;
              return Promise.reject(eio());
            }
            return Promise.resolve();
          },
        },
      }),
    );
    expect(armed).toBe(true);
    expect(r).toMatchObject({ kind: 'ran', outcome: 'io_error' });
    expect(rec.runs).toHaveLength(1);
    expect(rec.fallbacks).toHaveLength(0);
  });
});

describe('P 违约(run 抛出非失锁错误)', () => {
  it('fallback_single_shot_after_p_contract_violation:兜底恰好一次(origin=p_contract_violation),原异常原样进 catch → outcome internal;catch 不再调兜底', async () => {
    const f = await makeTickFx('c1b-w-pviol-', { confirmed: true });
    const { stage, rec } = stageOf({ run: () => Promise.reject(new TypeError('contract')) });
    const r = await runWorker(wd(f, { personal: stage }));
    expect(r).toEqual({ kind: 'ran', outcome: 'internal', recorded: true });
    expect(rec.runs).toHaveLength(1);
    expect(rec.fallbacks).toHaveLength(1);
    expect((rec.fallbacks[0] as FallbackCtx).origin).toBe('p_contract_violation');
    expect(await logCodes(f)).toEqual(['safety_fallback_muted', 'internal']);
  });

  it('p_contract_violation_fallback_loses_lock_preserves_original_and_skips_finish:兜底 aborted → outcome internal、recorded=false、状态目录零变化、兜底仍只一次', async () => {
    const f = await makeTickFx('c1b-w-pviol-abort-', { confirmed: true });
    const before = await treeOf(f.io.stateDir);
    const { stage, rec } = stageOf({
      run: () => Promise.reject(new TypeError('contract')),
      fallback: () => Promise.resolve({ kind: 'aborted', why: 'rsi_lock_lost' }),
    });
    const r = await runWorker(wd(f, { personal: stage }));
    expect(r).toEqual({ kind: 'ran', outcome: 'internal', recorded: false });
    expect(rec.fallbacks).toHaveLength(1);
    expect(await treeOf(f.io.stateDir)).toEqual(before);
  });

  it('run 抛 rsi lock_lost:兜底零调用,outcome lock_lost、零写入', async () => {
    const f = await makeTickFx('c1b-w-pviol-lost-', { confirmed: true });
    const before = await treeOf(f.io.stateDir);
    const { stage, rec } = stageOf({ run: () => Promise.reject(new RsiLockError('lock_lost')) });
    const r = await runWorker(wd(f, { personal: stage }));
    expect(r).toEqual({ kind: 'ran', outcome: 'lock_lost', recorded: false });
    expect(rec.fallbacks).toHaveLength(0);
    expect(await treeOf(f.io.stateDir)).toEqual(before);
  });

  it('违约抛出的原异常是 write_denied 一类:outcome 取自它(不是一律 internal),零写入五类不调兜底', async () => {
    const f = await makeTickFx('c1b-w-pviol-wd-', { confirmed: true });
    const before = await treeOf(f.io.stateDir);
    const { stage, rec } = stageOf({ run: () => Promise.reject(new RsiLockError('write_denied')) });
    const r = await runWorker(wd(f, { personal: stage }));
    expect(r).toEqual({ kind: 'ran', outcome: 'write_denied', recorded: false });
    expect(rec.fallbacks).toHaveLength(0);
    expect(await treeOf(f.io.stateDir)).toEqual(before);
  });
});

describe('日志摘要(非常态才写;常态零行)', () => {
  const round = (over: Partial<PersonalRound>): PersonalRound => ({ ...CLEAN, ...over });

  it('personalSummaryLine 优先级:safety_fault > personal_fault > personal_locked;其余 null', () => {
    expect(
      personalSummaryLine(
        round({
          faults: [
            { code: 'internal' },
            { code: 'step_halted', detail: 'safety_fault:state_invalid:schema' },
          ],
        }),
      ),
    ).toEqual({ action: 'failed', code: 'safety_fault_state_invalid_schema' });
    expect(
      personalSummaryLine(round({ faults: [{ code: 'personal_lock_error:state_dir_unsafe' }] })),
    ).toEqual({ action: 'failed', code: 'personal_fault_personal_lock_error_state_dir_unsafe' });
    expect(
      personalSummaryLine(round({ growth: { kind: 'denied', code: 'personal_busy' } })),
    ).toEqual({ action: 'skipped', code: 'personal_locked' });
    expect(personalSummaryLine(CLEAN)).toBeNull();
  });

  it('safety fault → 日志一行 failed safety_fault_*;忙 → skipped personal_locked;各至多一行', async () => {
    const f = await makeTickFx('c1b-w-sum-', { confirmed: true });
    const { stage } = stageOf({
      run: () =>
        Promise.resolve(
          round({ faults: [{ code: 'step_halted', detail: 'safety_fault:mute_unreliable' }] }),
        ),
    });
    await runWorker(wd(f, { personal: stage }));
    expect((await logCodes(f)).filter((c) => c.startsWith('safety_fault_'))).toEqual([
      'safety_fault_mute_unreliable',
    ]);
    const g = await makeTickFx('c1b-w-sum-busy-', { confirmed: true });
    const busy = stageOf({
      run: () => Promise.resolve(round({ growth: { kind: 'denied', code: 'personal_busy' } })),
    });
    await runWorker(wd(g, { personal: busy.stage }));
    expect((await logCodes(g)).filter((c) => c === 'personal_locked')).toHaveLength(1);
  });

  it('摘要日志写时发现 rsi 失锁:上抛 → outcome lock_lost、零后续写、不调兜底', async () => {
    const f = await makeTickFx('c1b-w-sum-lost-', { confirmed: true });
    const { stage, rec } = stageOf({
      run: async () => {
        await loseLockOf(f);
        return round({ faults: [{ code: 'step_halted', detail: 'safety_fault:mute_unreliable' }] });
      },
    });
    const r = await runWorker(wd(f, { personal: stage }));
    expect(r).toEqual({ kind: 'ran', outcome: 'lock_lost', recorded: false });
    expect(rec.fallbacks).toHaveLength(0);
  });
});
