/**
 * B1a:§E 十组端口签名**冻结**——类型层断言(由 `tsc` 检查,改签名即红)+ 运行期形状。冻结 = 合并前不得改签名。
 * 十组:1 事务协调器 / 2 KeyedEffectSink / 3 LedgerRecoveryPort / 4 UserVetoPort+ReplayPort / 5 AuditAppender / 6 SealGuard / 7 ReconcileSource / 8 schema / 9 码表 / 10 冷却谓词。
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { TransitionEffect } from '../../../src/rsi/personal/transition.js';
import type { RsiAuditLine } from '../../../src/contracts/rsi-personal.js';
import type { RsiEffectsLedger, UtcDay } from '../../../src/contracts/rsi-store.js';
import { cooldownActive } from '../../../src/contracts/rsi-store.js';
import type {
  ApplyOnceMeta,
  ApplyOnceResult,
  AuditAppender,
  HeldStore,
  AuditTextRead,
  KeyedEffectSink,
  LedgerRecoveryPort,
  LockCap,
  RecoveryBatch,
  RecoveryResult,
  ReconcileSource,
  ReplayPort,
  SealGuard,
  SealRegion,
  TxnPorts,
  UserVetoPort,
} from '../../../src/rsi/store/ports.js';
import type { StoreFs } from '../../../src/rsi/store/fs-port.js';
import { planLedgerBatch } from '../../../src/rsi/store/ledger-plan.js';
import type { assembleRsiStore } from '../../../src/rsi/store/store.js';

describe('§E 签名冻结(类型层)', () => {
  it('1 事务协调器:HeldStore / TxnPorts 形状', () => {
    expectTypeOf<keyof HeldStore>().toEqualTypeOf<'closing' | 'transaction' | 'release'>();
    expectTypeOf<keyof TxnPorts>().toEqualTypeOf<'ledgerWrite' | 'auditAppend'>();
    expectTypeOf<HeldStore['release']>().toEqualTypeOf<() => Promise<void>>();
    expectTypeOf<HeldStore['closing']>().toEqualTypeOf<boolean>();
  });

  it('2 KeyedEffectSink.applyOnce(key, effects, meta?) → {ledger, audit};存储端不含 authority', () => {
    expectTypeOf<KeyedEffectSink['applyOnce']>().toEqualTypeOf<
      (
        key: string,
        effects: readonly TransitionEffect[],
        meta?: ApplyOnceMeta,
      ) => Promise<ApplyOnceResult>
    >();
    expectTypeOf<keyof ApplyOnceResult>().toEqualTypeOf<'ledger' | 'audit' | 'cause'>();
    expectTypeOf<ApplyOnceResult['ledger']>().toEqualTypeOf<
      'committed' | 'satisfied' | 'not_committed' | 'not_applicable'
    >();
    expectTypeOf<ApplyOnceResult['audit']>().toEqualTypeOf<
      'appended' | 'pending' | 'compacted' | 'not_applicable'
    >();
  });

  it('3 LedgerRecoveryPort.recoverThrough:逐批三态,无 audit / authority;planLedgerBatch 是纯函数', () => {
    expectTypeOf<LedgerRecoveryPort['recoverThrough']>().toEqualTypeOf<
      (W: UtcDay, batches: readonly RecoveryBatch[]) => Promise<readonly RecoveryResult[]>
    >();
    expectTypeOf<keyof RecoveryResult>().toEqualTypeOf<'batch_id' | 'state' | 'cause'>();
    expectTypeOf<RecoveryResult['state']>().toEqualTypeOf<
      'satisfied' | 'ledger_committed' | 'ledger_not_committed'
    >();
    expectTypeOf<keyof RecoveryBatch>().toEqualTypeOf<'key' | 'effects' | 'meta'>();
    expectTypeOf(planLedgerBatch).parameter(0).toEqualTypeOf<RsiEffectsLedger>();
    expect(planLedgerBatch.length).toBeLessThanOrEqual(5);
  });

  it('4 UserVetoPort 与 ReplayPort 分离:ReplayPort 没有 veto / lift,UserVetoPort 没有 applyOnce', () => {
    expectTypeOf<ReplayPort>().toEqualTypeOf<KeyedEffectSink>();
    expectTypeOf<keyof UserVetoPort>().toEqualTypeOf<'veto' | 'lift'>();
    expectTypeOf<ReplayPort>().not.toHaveProperty('veto');
    expectTypeOf<KeyedEffectSink>().not.toHaveProperty('recoverThrough');
    expectTypeOf<UserVetoPort>().not.toHaveProperty('applyOnce');
  });

  it('5 AuditAppender:first 的返回不含 compacted;replay 含;appendObservation(row)', () => {
    const typeCheck = (a: AuditAppender, r: SealRegion): void => {
      expectTypeOf(a.appendKeyed([], { kind: 'first', region: r })).toEqualTypeOf<
        Promise<readonly ('appended' | 'already')[]>
      >();
      expectTypeOf(
        a.appendKeyed([], { kind: 'replay', source: { kind: 'k', ref: 'r' } }),
      ).toEqualTypeOf<Promise<readonly ('appended' | 'already' | 'compacted')[]>>();
      expectTypeOf(a.appendObservation).parameters.toEqualTypeOf<[RsiAuditLine]>();
    };
    expect(typeof typeCheck).toBe('function');
  });

  it('6 SealGuard / SealRegion:open / stampFirst(now: () => Date) / close 与状态机', () => {
    expectTypeOf<keyof SealGuard>().toEqualTypeOf<'open'>();
    expectTypeOf<SealRegion['stampFirst']>().parameters.toEqualTypeOf<[now: () => Date]>();
    expectTypeOf<SealRegion['state']>().toEqualTypeOf<
      'open' | 'stamped' | 'source_committed' | 'audit_attempted' | 'closed'
    >();
    expectTypeOf<SealRegion['close']>().toEqualTypeOf<() => void>();
  });

  it('7 ReconcileSource:entriesThrough / batchesThrough / derivedThrough / resolve', () => {
    expectTypeOf<keyof ReconcileSource>().toEqualTypeOf<
      'entriesThrough' | 'batchesThrough' | 'derivedThrough' | 'resolve'
    >();
    expectTypeOf<ReconcileSource['resolve']>().returns.resolves.toEqualTypeOf<{
      idem_key: string;
      row: RsiAuditLine;
    } | null>();
  });

  it('10 冷却谓词:utcDay(at) + days > today;过期 = 非 active', () => {
    expect(cooldownActive({ at: '2026-10-17T00:00:00.000Z', days: 30 }, '2026-11-15')).toBe(true);
    expect(cooldownActive({ at: '2026-10-16T00:00:00.000Z', days: 30 }, '2026-11-15')).toBe(false);
  });

  it('验收评审的向后兼容扩展只加**可选**成员(已冻结端口的必选签名不变):LockCap.path / attachReleaseGate / canAttachReleaseGate / kind、StoreFs.root、AuditTextRead.torn;装配入口形参不变', () => {
    expectTypeOf<keyof LockCap>().toEqualTypeOf<
      'assertHeld' | 'release' | 'path' | 'attachReleaseGate' | 'canAttachReleaseGate' | 'kind'
    >();
    expectTypeOf<LockCap['path']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<LockCap['kind']>().toEqualTypeOf<'rsi' | 'personal' | undefined>();
    // 只有两个必选成员的旧形状仍可赋给 LockCap(向后兼容:测试假件与存量句柄不必改)
    const legacy: LockCap = { assertHeld: async () => undefined, release: async () => undefined };
    expect(Object.keys(legacy)).toEqual(['assertHeld', 'release']);
    expectTypeOf<StoreFs['root']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<AuditTextRead>().toEqualTypeOf<
      { kind: 'missing' } | { kind: 'ok'; text: string; torn?: true }
    >();
    expectTypeOf<keyof Parameters<typeof assembleRsiStore>[0]>().toEqualTypeOf<
      'fs' | 'rsi' | 'personal' | 'clock' | 'reconcile' | 'registry'
    >();
  });
});
