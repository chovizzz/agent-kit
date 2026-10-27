/**
 * R20-A2 B5-0:共享服务签名桩的冻结。签名用编译期类型断言钉住(`pnpm typecheck` 覆盖 test/,改签名会红);运行期桩一律抛 `not implemented`。
 * 实装块(B5a / B5c)替换函数体时,这里的类型断言保持不动;要改签名必须走主代理。
 * 另钉:`RSI_STATUS_WARNINGS` 与 `status.ts` 现有的 `warnings.push('…')` 字面量一致(新增的 `index_rebuild_required` 由 B5a 接线)。
 */
import * as path from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { RsiCounts } from '../../src/contracts/rsi.js';
import { RSI_STATUS_NEXT_REBUILD, RSI_STATUS_WARNINGS } from '../../src/contracts/rsi.js';
import { readText } from '../../src/io/read-fs.js';
import type { IoContext } from '../../src/io/paths.js';
import type { Checkpoint, RunBinding, StateMutator } from '../../src/rsi/l0/types.js';
import * as observe from '../../src/rsi/services/observe.js';
import * as projections from '../../src/rsi/services/projections.js';
import * as purgeEngine from '../../src/rsi/services/purge-engine.js';
import * as purgeJournal from '../../src/rsi/services/purge-journal.js';
import * as purgePlan from '../../src/rsi/services/purge-plan.js';
import * as tickState from '../../src/rsi/services/tick-state.js';
import type { RsiState } from '../../src/contracts/rsi.js';
import type { RsiLockHandle } from '../../src/rsi/lock.js';
import type { RsiServiceCtx } from '../../src/rsi/types.js';
import * as storeRewrite from '../../src/signals/store-rewrite.js';
import type { WriteGate } from '../../src/signals/state-store.js';
import { REPO_ROOT } from '../helpers/tmp.js';

type Pass2 = Pick<import('../../src/contracts/redact.js').Redactor, 'pass2'>;
const ctx = {} as RsiServiceCtx;
const lock = {} as RsiLockHandle;
const io = {} as IoContext;
const redactor = {} as Pass2;

describe('B5 服务签名(类型断言 = 冻结)', () => {
  it('observe.ts(B5a)', () => {
    expectTypeOf(observe.observeRsi).parameters.toEqualTypeOf<[IoContext, observe.EarlyEnv]>();
    expectTypeOf(observe.observeRsi).returns.toEqualTypeOf<Promise<observe.RsiObservation>>();
    expectTypeOf(observe.confirmedCheckpoint).parameters.toEqualTypeOf<
      [
        {
          io: IoContext;
          env: observe.EarlyEnv;
          binding: RunBinding;
          nowMs: () => number;
          startedAtMs: number;
        },
      ]
    >();
    expectTypeOf(observe.confirmedCheckpoint).returns.toEqualTypeOf<Checkpoint>();
    expectTypeOf(observe.armedCheckpoint).returns.toEqualTypeOf<Checkpoint>();
    expectTypeOf(observe.displayFingerprint).parameters.toEqualTypeOf<[observe.RsiObservation]>();
    expectTypeOf(observe.displayFingerprint).returns.toEqualTypeOf<string>();
    expectTypeOf<observe.StopMarkId>().toEqualTypeOf<
      | 'absent'
      | {
          dev: number;
          ino: number;
          size: number;
          mtimeMs: number;
          ctimeMs: number;
          sha256: string | null;
        }
    >();
  });

  it('projections.ts(B5a)', () => {
    expectTypeOf(projections.stagedProjection).returns.toEqualTypeOf<
      Promise<RsiCounts['staged']>
    >();
    expectTypeOf(projections.refreshStagedUnderLock).returns.toEqualTypeOf<
      Promise<'written_staged' | 'written_full' | 'skipped_no_salt'>
    >();
    expectTypeOf(projections.writeAllCountsUnderLock).returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf(projections.indexWritable).returns.toEqualTypeOf<boolean>();
    expectTypeOf(projections.indexWritable).parameters.toEqualTypeOf<
      [{ status: 'ok'; saltFp: string } | { status: 'absent' | 'invalid' }, boolean, string]
    >();
  });

  it('tick-state.ts(B5a)', () => {
    expectTypeOf(tickState.tickStateMutator).returns.toEqualTypeOf<StateMutator>();
    expectTypeOf(tickState.tickStateMutator).parameters.toEqualTypeOf<
      [{ trigger: 'tick' | 'poke' | 'kit'; now: () => Date }]
    >();
    expectTypeOf(tickState.defaultState).returns.toEqualTypeOf<RsiState>();
  });

  it('purge-*(B5c)与 store-rewrite(B5c)', () => {
    expectTypeOf(purgePlan.resolvePurgeKeys).returns.toEqualTypeOf<
      Promise<{ keys: string[]; notExcluded: boolean }>
    >();
    expectTypeOf(purgePlan.planPurgeTargets).returns.toEqualTypeOf<
      Promise<purgePlan.PurgeTargets>
    >();
    expectTypeOf(purgePlan.countPurge).returns.toEqualTypeOf<Promise<purgePlan.PurgeCounts>>();
    expectTypeOf(purgeJournal.writePurgeJournal).returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf(purgeJournal.removePurgeJournal).returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf(purgeEngine.runPurgeUnderLock).returns.toEqualTypeOf<
      Promise<purgeEngine.PurgeResult>
    >();
    expectTypeOf(purgeEngine.resumePurgeUnderLock).returns.toEqualTypeOf<
      Promise<purgeEngine.PurgeResult>
    >();
    expectTypeOf(purgeEngine.salvageInvalidJournal).returns.toEqualTypeOf<
      Promise<purgeEngine.SalvageResult>
    >();
    expectTypeOf(storeRewrite.rewriteMonthFileWithout).parameters.toEqualTypeOf<
      [IoContext, string, ReadonlySet<string>, (line: unknown) => string | null, WriteGate]
    >();
    expectTypeOf(storeRewrite.rewriteMonthFileWithout).returns.toEqualTypeOf<
      Promise<'unchanged' | { removed: number }>
    >();
  });

  it('运行期:每个桩都抛 not implemented(同步桩同步抛,异步桩拒绝)', async () => {
    const gate: WriteGate = () => Promise.resolve();
    const sync: Array<[string, () => unknown]> = [
      ['confirmedCheckpoint', () => observe.confirmedCheckpoint({} as never)],
      ['armedCheckpoint', () => observe.armedCheckpoint({} as never)],
      ['displayFingerprint', () => observe.displayFingerprint({} as never)],
      ['indexWritable', () => projections.indexWritable({ status: 'absent' }, false, 'x')],
      ['tickStateMutator', () => tickState.tickStateMutator({} as never)],
      ['defaultState', () => tickState.defaultState()],
    ];
    for (const [name, f] of sync) expect(f, name).toThrow(/not implemented/);
    const asyncStubs: Array<[string, () => Promise<unknown>]> = [
      ['observeRsi', () => observe.observeRsi(io, {})],
      ['stagedProjection', () => projections.stagedProjection(io)],
      ['recomputeAllCounts', () => projections.recomputeAllCounts(ctx, redactor)],
      ['refreshStagedUnderLock', () => projections.refreshStagedUnderLock(ctx, lock, redactor)],
      ['writeAllCountsUnderLock', () => projections.writeAllCountsUnderLock(ctx, lock, redactor)],
      ['resolvePurgeKeys', () => purgePlan.resolvePurgeKeys(io, {} as never, { kind: 'excluded' })],
      ['planPurgeTargets', () => purgePlan.planPurgeTargets(io, [])],
      ['countPurge', () => purgePlan.countPurge(io, [])],
      ['writePurgeJournal', () => purgeJournal.writePurgeJournal(ctx, lock, {} as never)],
      ['removePurgeJournal', () => purgeJournal.removePurgeJournal(ctx, lock)],
      [
        'runPurgeUnderLock',
        () =>
          purgeEngine.runPurgeUnderLock(ctx, lock, {
            keys: [],
            targets: { keys: [], runs: [], promotes: [] },
          }),
      ],
      ['resumePurgeUnderLock', () => purgeEngine.resumePurgeUnderLock(ctx, lock)],
      ['salvageInvalidJournal', () => purgeEngine.salvageInvalidJournal(ctx, lock)],
      [
        'rewriteMonthFileWithout',
        () => storeRewrite.rewriteMonthFileWithout(io, '/x', new Set(), () => null, gate),
      ],
    ];
    for (const [name, f] of asyncStubs) await expect(f(), name).rejects.toThrow(/not implemented/);
  });
});

describe('status 的 warnings / next 常量', () => {
  it('RSI_STATUS_WARNINGS = status.ts 现有的 warnings.push 字面量 + index_rebuild_required(B5a 接线);next 词固定', async () => {
    const text = await readText(path.join(REPO_ROOT, 'src/rsi/status.ts'));
    const pushed = [...text.matchAll(/warnings\.push\('([a-z_]+)'\)/g)].map((m) => m[1] as string);
    expect(pushed.length, '正向前提:抽到了现有的 warnings.push').toBeGreaterThanOrEqual(4);
    expect([...RSI_STATUS_WARNINGS].filter((w) => !pushed.includes(w)).sort()).toEqual([
      'index_rebuild_required',
    ]);
    expect(pushed.filter((w) => !(RSI_STATUS_WARNINGS as readonly string[]).includes(w))).toEqual(
      [],
    );
    expect(RSI_STATUS_NEXT_REBUILD).toBe('rebuild_index');
  });
});
