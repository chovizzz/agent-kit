import { describe, expect, it } from 'vitest';
import { hasStructureFields, loadSignals } from '../../src/reflect/load.js';
import { SignalStoreError } from '../../src/signals/state-store.js';
import {
  CANARY_EXT,
  CANARY_LEGACY,
  CANARY_TR,
  fakeKey,
  putRawSignalLines,
  putSignals,
  sig,
  testRedactor,
  worldSignals,
  newWork,
} from '../fixtures/reflect/world.js';

describe('reflect/load', () => {
  it('外部内容摘录强制清空、失败结果摘录清空、缺结构字段的信号排除并计数', async () => {
    const w = await newWork('rl-load-');
    await putSignals(w.io, worldSignals());
    const r = await loadSignals(w.io, testRedactor());
    const all = JSON.stringify(r.signals);
    // 正向对照:允许的摘录确实在
    expect(all).toContain('pnpm run test --run');
    expect(all).toContain('CANARY_UM_ok');
    // 负向
    expect(all).not.toContain(CANARY_EXT);
    expect(all).not.toContain(CANARY_TR);
    expect(all).not.toContain(CANARY_LEGACY);
    expect(r.stats.external_excerpt_forced).toBe(1);
    expect(r.stats.failed_excerpt_dropped).toBe(2);
    expect(r.stats.structure_unknown).toBe(1);
    expect(r.stats.loaded).toBe(9);
    // 外部信号本身保留(只留结构)
    const ext = r.signals.find((s) => s.external_content);
    expect(ext?.excerpt_redacted).toBe('');
    expect(ext?.event_kind).toBe('tool_call');
  });

  it('过当前覆盖层 pass2:残留样式的摘录丢整条信号(不替换),并计数', async () => {
    const w = await newWork('rl-resid-');
    const bad = sig({
      project: 'A',
      session: 'A1',
      index: 0,
      text: `以后用这个 ${fakeKey()} 登录`,
    });
    const good = sig({ project: 'A', session: 'A1', index: 1, text: '以后先跑 lint 再提交代码' });
    expect(testRedactor().pass2(bad.excerpt_redacted).clean).toBe(false); // 正向对照:样式真会被识别
    await putSignals(w.io, [bad, good]);
    const r = await loadSignals(w.io, testRedactor());
    expect(r.stats.dropped_residual).toBe(1);
    expect(r.signals.map((s) => s.sig_id)).toEqual([good.sig_id]);
    expect(JSON.stringify(r.signals)).not.toContain('sk-');
  });

  it('坏行 → SignalStoreError;schema 不合 → 计数丢弃;since 过滤', async () => {
    const w = await newWork('rl-bad-');
    await putRawSignalLines(w.io, 'claude', '202610', ['{"not":"a signal"}']);
    const r = await loadSignals(w.io, testRedactor());
    expect(r.stats.dropped_schema).toBe(1);
    const w2 = await newWork('rl-bad2-');
    await putRawSignalLines(w2.io, 'claude', '202610', ['not json at all']);
    await expect(loadSignals(w2.io, testRedactor())).rejects.toBeInstanceOf(SignalStoreError);

    const w3 = await newWork('rl-since-');
    await putSignals(w3.io, [
      sig({
        project: 'A',
        session: 'A1',
        index: 0,
        text: '以后先 lint 一下',
        ts: '2026-09-01T00:00:00Z',
      }),
      sig({
        project: 'A',
        session: 'A1',
        index: 1,
        text: '以后先 test 一下',
        ts: '2026-10-05T00:00:00Z',
      }),
    ]);
    const all = await loadSignals(w3.io, testRedactor());
    const since = await loadSignals(w3.io, testRedactor(), { since: '2026-10-01' });
    expect(all.signals).toHaveLength(2);
    expect(since.signals).toHaveLength(1);
    expect(since.stats.filtered_out).toBe(0); // 早月份整文件被跳过
  });

  it('库不存在 → 空结果;hasStructureFields 判定', async () => {
    const w = await newWork('rl-empty-');
    const r = await loadSignals(w.io, testRedactor());
    expect(r.signals).toEqual([]);
    expect(
      hasStructureFields(sig({ project: 'A', session: 'A1', index: 0, noStructure: true })),
    ).toBe(false);
    expect(hasStructureFields(sig({ project: 'A', session: 'A1', index: 0 }))).toBe(true);
  });
});

describe('reflect/load 评审后补强', () => {
  it('会话级外部内容:先写入的非外部行,在会话后来出现外部信号时同样清空摘录', async () => {
    const w = await newWork('rl-sess-');
    await putSignals(w.io, [
      sig({ project: 'A', session: 'A1', index: 0, text: '以后先 lint 再提交 CANARY_EARLY_1' }),
      sig({
        project: 'A',
        session: 'A1',
        index: 5,
        kind: 'tool_call',
        tool: 'WebFetch',
        external: true,
        text: 'x',
      }),
      sig({ project: 'A', session: 'A2', index: 0, text: '以后先 test 再提交 CANARY_OTHER_2' }),
    ]);
    const r = await loadSignals(w.io, testRedactor());
    const all = JSON.stringify(r.signals);
    expect(all).toContain('CANARY_OTHER_2'); // 正向对照:别的会话不受影响
    expect(all).not.toContain('CANARY_EARLY_1');
    expect(r.stats.external_excerpt_forced).toBeGreaterThanOrEqual(2);
  });

  it('摘录含不可见字符 → 丢整条信号', async () => {
    const w = await newWork('rl-inv-');
    const hidden = String.fromCodePoint(0xe0041);
    await putSignals(w.io, [
      sig({ project: 'A', session: 'A1', index: 0, text: `以后先 lint${hidden} 再提交` }),
      sig({ project: 'A', session: 'A1', index: 1, text: '以后先 lint 再提交代码' }),
    ]);
    const r = await loadSignals(w.io, testRedactor());
    expect(r.signals).toHaveLength(1);
    expect(r.stats.dropped_residual).toBe(1);
  });
});
