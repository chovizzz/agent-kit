/**
 * B2:旧 `KeyedEffectSink` → 新存储端口适配层(映射规则逐格、元信息来源、user_veto 路由、错误不被吞成 deferred)。假新端口记录收到的调用。
 */
import { describe, expect, it } from 'vitest';
import {
  legacyKeyedEffects,
  terminalEventAt,
  toLegacyResult,
  vetoEventAt,
} from '../../../src/rsi/personal/effects-adapter.js';
import { newLayerRecorder } from '../../../src/rsi/personal/effects-layers.js';
import type { ApplyOnceResult } from '../../../src/rsi/store/ports.js';
import { ID, SHA, entry, rec } from '../personal/transition-fixture.js';
import { MemStore } from '../personal/w3-fixture.js';

const BL = [{ type: 'blacklist_veto', id: ID, content_sha256: SHA }] as const;

function setup(over: { result?: ApplyOnceResult; record?: ReturnType<typeof rec> | null } = {}) {
  const store = new MemStore();
  if (over.record !== null) store.put(over.record ?? rec('rejected'));
  const calls: { via: string; key: string; meta: unknown }[] = [];
  const result: ApplyOnceResult = over.result ?? { ledger: 'committed', audit: 'not_applicable' };
  const recorder = newLayerRecorder();
  const sink = {
    applyOnce: async (key: string, _e: unknown, meta?: unknown) => {
      calls.push({ via: 'sink', key, meta });
      return result;
    },
  };
  const userVeto = {
    veto: async (id: string, sha: string, meta: unknown) => {
      calls.push({ via: 'userVeto', key: `veto:${id}:${sha}`, meta });
      return result;
    },
    lift: async () => 'absent' as const,
  };
  return { store, calls, recorder, sink, userVeto };
}

describe('toLegacyResult:映射规则逐格', () => {
  const R = (ledger: ApplyOnceResult['ledger'], audit: ApplyOnceResult['audit']) =>
    toLegacyResult({ ledger, audit });
  it.each([
    ['committed', 'not_applicable', 'applied'],
    ['committed', 'pending', 'applied'],
    ['satisfied', 'appended', 'already'],
    ['satisfied', 'pending', 'already'],
    ['not_committed', 'not_applicable', 'deferred'],
    ['not_applicable', 'appended', 'applied'],
    ['not_applicable', 'compacted', 'already'],
    ['not_applicable', 'pending', 'deferred'],
    ['not_applicable', 'not_applicable', 'already'],
  ] as const)('ledger=%s audit=%s → %s', (l, a, want) => {
    expect(R(l, a)).toBe(want);
  });
});

describe('元信息:持锁读记录现算,绝不取 now', () => {
  it('terminal: 键:event_at = 终态条目时间,fp_hmac = 记录的,near_fp = [];走 sink(replay)', async () => {
    const f = setup({
      record: rec('rejected', {
        transitions: [
          entry(1, 'proposed', '2026-10-01T00:00:00Z'),
          entry(2, 'rejected', '2026-10-05T00:00:00Z'),
        ],
      }),
    });
    const a = legacyKeyedEffects({
      sink: f.sink,
      userVeto: f.userVeto,
      store: f.store,
      recorder: f.recorder,
    });
    expect(await a.applyOnce(`terminal:${ID}:${SHA}`, [...BL])).toBe('applied');
    expect(f.calls).toEqual([
      {
        via: 'sink',
        key: `terminal:${ID}:${SHA}`,
        meta: { event_at: '2026-10-05T00:00:00Z', fp_hmac: '0123456789abcdef', near_fp: [] },
      },
    ]);
  });

  it('user_veto 路由:veto: 键上单项 blacklist_veto 走 userVeto;同样的 effect 放在 terminal: 键里走 sink(对照)', async () => {
    const f = setup();
    const a = legacyKeyedEffects({
      sink: f.sink,
      userVeto: f.userVeto,
      store: f.store,
      recorder: f.recorder,
    });
    await a.applyOnce(`veto:${ID}:${SHA}`, [...BL]);
    await a.applyOnce(`terminal:${ID}:${SHA}`, [...BL]);
    expect(f.calls.map((c) => c.via)).toEqual(['userVeto', 'sink']);
  });

  it('不给 userVeto(恢复 / worker 路径):veto: 键也走 sink(replay,不能复活 lifted)', async () => {
    const f = setup();
    const a = legacyKeyedEffects({ sink: f.sink, store: f.store, recorder: f.recorder });
    await a.applyOnce(`veto:${ID}:${SHA}`, [...BL]);
    expect(f.calls.map((c) => c.via)).toEqual(['sink']);
  });

  it.each([
    ['记录不存在', null, `terminal:${ID}:${SHA}`],
    ['内容哈希对不上', rec('rejected'), `terminal:${ID}:${'b'.repeat(64)}`],
    ['键形状不对', rec('rejected'), 'weird-key'],
  ] as const)(
    '读不到 / 对不上 = 抛 effects_meta_missing(不映射成 deferred,零调用):%s',
    async (_n, record, key) => {
      const f = setup({ record });
      const a = legacyKeyedEffects({
        sink: f.sink,
        userVeto: f.userVeto,
        store: f.store,
        recorder: f.recorder,
      });
      await expect(a.applyOnce(key, [...BL])).rejects.toMatchObject({
        code: 'effects_meta_missing',
      });
      expect(f.calls).toEqual([]);
      expect(f.recorder.records).toEqual([]);
    },
  );

  it('veto 事件时间 = 第一条进入回滚 / 终态的条目;终态时间 = 终态条目', () => {
    const r = rec('rolled_back', {
      transitions: [
        entry(1, 'proposed', '2026-10-01T00:00:00Z'),
        entry(2, 'rolling_back', '2026-10-02T00:00:00Z'),
        entry(3, 'rolled_back', '2026-10-03T00:00:00Z'),
      ],
    });
    expect(vetoEventAt(r)).toBe('2026-10-02T00:00:00Z');
    expect(terminalEventAt(r)).toBe('2026-10-03T00:00:00Z');
  });
});

describe('三层信息不塌缩:收集器保留完整 {ledger, audit, cause}', () => {
  it('账未提交(effects_full)→ 旧枚举 deferred,收集器记 reason=effects_full', async () => {
    const f = setup({
      result: { ledger: 'not_committed', audit: 'not_applicable', cause: 'effects_full' },
    });
    const a = legacyKeyedEffects({
      sink: f.sink,
      userVeto: f.userVeto,
      store: f.store,
      recorder: f.recorder,
    });
    expect(await a.applyOnce(`terminal:${ID}:${SHA}`, [...BL])).toBe('deferred');
    expect(f.recorder.records).toEqual([
      {
        kind: 'terminal',
        id: ID,
        ledger: 'not_committed',
        audit: 'not_applicable',
        cause: 'effects_full',
        reason: 'effects_full',
      },
    ]);
  });

  it('账已提交而审计待补 → 旧枚举 applied(不是 deferred),收集器记 audit=pending', async () => {
    const f = setup({ result: { ledger: 'committed', audit: 'pending', cause: 'store_io' } });
    const a = legacyKeyedEffects({ sink: f.sink, store: f.store, recorder: f.recorder });
    expect(await a.applyOnce(`terminal:${ID}:${SHA}`, [...BL])).toBe('applied');
    expect(f.recorder.records[0]).toMatchObject({
      ledger: 'committed',
      audit: 'pending',
      cause: 'store_io',
    });
  });

  it('仅审计键(audit:)不读记录、不要 meta;appended → applied', async () => {
    const f = setup({ result: { ledger: 'not_applicable', audit: 'appended' }, record: null });
    const a = legacyKeyedEffects({ sink: f.sink, store: f.store, recorder: f.recorder });
    const line = {
      at: '2026-10-05T00:00:00Z',
      kind: 'transition',
      id: ID,
      dim: 'lifecycle',
      from: 'a',
      to: 'b',
      reason: 'x',
    };
    expect(
      await a.applyOnce(`audit:${ID}:k1`, [
        { type: 'append_audit', line, idem_key: 'k1' } as never,
      ]),
    ).toBe('applied');
    expect(f.calls[0]).toMatchObject({ via: 'sink', meta: undefined });
  });
});
