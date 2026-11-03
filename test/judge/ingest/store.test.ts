/**
 * N4 ⑥:`store.ts` 的 ingest 写原语(R20-18.31 ⑥):只许改 `judge` / `judge_attempts` / `reflector.confirmed` 三处,
 * `reflector` 的其余字段改动即抛;`loadRunEntries` 区分不支持的提案(N4i-5)。
 */
import { describe, expect, it } from 'vitest';
import { JudgeStateError } from '../../../src/judge/errors.js';
import {
  applyIngestFields,
  assertOnlyIngestKeysChanged,
  loadRun,
  loadRunEntries,
} from '../../../src/judge/store.js';
import { newWork } from '../helpers.js';
import { writeSessionProposal } from './fixtures.js';

const raw = (): Record<string, unknown> => ({
  id: '2026-10-12-001',
  op: 'add',
  rationale: 'r',
  reflector: {
    provider: 'session',
    vendor: 'unknown',
    model: 'undeclared',
    run_id: 'run-0001',
    provenance: 'session_declared',
  },
  judge_attempts: [{ hop: 'codex' }],
});
const throwsState = (fn: () => unknown, msg: string) => {
  expect(fn).toThrow(JudgeStateError);
  expect(fn).toThrow(msg);
};

describe('applyIngestFields', () => {
  it('judge:写 judge 并删除 judge_attempts;其余键原样', () => {
    const next = applyIngestFields(raw(), { judge: { provenance: 'session_confirmed' } });
    expect(next['judge']).toEqual({ provenance: 'session_confirmed' });
    expect('judge_attempts' in next).toBe(false);
    expect(next['reflector']).toEqual(raw()['reflector']);
  });
  it('confirmed:reflector 里只追加 confirmed 一个键,其余字段与键序原样;judge_attempts 保留', () => {
    const next = applyIngestFields(raw(), { confirmed: { vendor: 'openai' } });
    expect(Object.keys(next['reflector'] as object)).toEqual([
      ...Object.keys(raw()['reflector'] as object),
      'confirmed',
    ]);
    expect(next['judge_attempts']).toEqual(raw()['judge_attempts']);
  });
  it('已有 confirmed(无效的旧值)被替换', () => {
    const r = raw();
    (r['reflector'] as Record<string, unknown>)['confirmed'] = { vendor: 'old' };
    const next = applyIngestFields(r, { confirmed: { vendor: 'new' } });
    expect((next['reflector'] as { confirmed: { vendor: string } }).confirmed.vendor).toBe('new');
  });
});

describe('assertOnlyIngestKeysChanged:reflector 其余字段改动即抛(具体原因)', () => {
  const mutate = (f: (r: Record<string, unknown>) => void) => {
    const after = raw();
    f(after['reflector'] as Record<string, unknown>);
    return after;
  };
  it('vendor / model / provenance / provider / run_id / 新增键 / 删除键 → 抛', () => {
    for (const f of [
      (r: Record<string, unknown>) => (r['vendor'] = 'openai'),
      (r: Record<string, unknown>) => (r['model'] = 'gpt-x'),
      (r: Record<string, unknown>) => (r['provenance'] = 'spawned'),
      (r: Record<string, unknown>) => (r['provider'] = 'x'),
      (r: Record<string, unknown>) => (r['run_id'] = 'run-0002'),
      (r: Record<string, unknown>) => (r['backend'] = 'claude'),
      (r: Record<string, unknown>) => delete r['model'],
    ]) {
      throwsState(
        () => assertOnlyIngestKeysChanged(raw(), mutate(f)),
        'reflector.confirmed 以外的 reflector 字段',
      );
    }
  });
  it('提案其它顶层键改动 → 抛;judge / judge_attempts / reflector.confirmed 的改动 → 不抛(正向对照)', () => {
    throwsState(
      () => assertOnlyIngestKeysChanged(raw(), { ...raw(), rationale: 'changed' }),
      'judge/judge_attempts/reflector.confirmed 以外的字段',
    );
    throwsState(() => assertOnlyIngestKeysChanged(raw(), { ...raw(), op: 'edit' }), '以外的字段');
    expect(() => assertOnlyIngestKeysChanged(raw(), { ...raw(), judge: { x: 1 } })).not.toThrow();
    expect(() =>
      assertOnlyIngestKeysChanged(
        raw(),
        mutate((r) => (r['confirmed'] = { vendor: 'openai' })),
      ),
    ).not.toThrow();
    const noAttempts = raw();
    delete noAttempts['judge_attempts'];
    expect(() => assertOnlyIngestKeysChanged(raw(), noAttempts)).not.toThrow();
  });
  it('reflector 不是对象 → 抛', () => {
    throwsState(
      () => assertOnlyIngestKeysChanged(raw(), { ...raw(), reflector: null }),
      'reflector 以外的结构',
    );
  });
});

describe('loadRunEntries / loadRun(N4i-5)', () => {
  it('不支持的提案记入 unsupported 而不抛;loadRun 对同一 run 仍整体中止(行为不变)', async () => {
    const w = await newWork();
    const ok = await writeSessionProposal(w, {
      id: '2026-10-12-001',
      target: 'rule-a',
      layer: 'personal',
    });
    const edit = await writeSessionProposal(w, {
      id: '2026-10-12-002',
      target: 'rule-b',
      layer: 'personal',
      op: 'edit',
    });
    const e = await loadRunEntries(w.io, 'run-0001');
    expect(e.loaded.map((l) => l.proposal.id)).toEqual([ok.id]);
    expect(e.unsupported).toEqual([edit.id]);
    await expect(loadRun(w.io, 'run-0001')).rejects.toThrow('只支持 op=add 且单目标的提案');
  });
});
