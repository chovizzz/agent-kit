import { describe, expect, it } from 'vitest';
import {
  MAX_BAD_VERSIONS,
  emptyState,
  markBad,
  markInstalled,
  markNotified,
  parseUpdateState,
  recordCheck,
  serializeUpdateState,
  shouldNotify,
} from '../../src/update/state.js';

const ANCHOR = 'a'.repeat(64);
const T0 = Date.parse('2026-10-14T12:00:00.000Z');

describe('UpdateState 读-改-写', () => {
  it('空状态序列化 → 解析往返一致,且是 canonical JSON(键有序、末尾换行)', () => {
    const text = serializeUpdateState(emptyState());
    expect(text.endsWith('}\n')).toBe(true);
    const back = parseUpdateState(text);
    expect(back.ok).toBe(true);
    if (back.ok) expect(serializeUpdateState(back.state)).toBe(text);
    expect(text.indexOf('"bad_versions"')).toBeLessThan(text.indexOf('"schema_version"'));
  });

  it('损坏的文件给出原因而不是静默重置', () => {
    expect(parseUpdateState('{nope')).toEqual({ ok: false, reason: 'not_json' });
    expect(parseUpdateState('{"schema_version":2}')).toEqual({ ok: false, reason: 'schema' });
    expect(parseUpdateState('{"schema_version":1,"surprise":1}')).toEqual({
      ok: false,
      reason: 'schema',
    });
  });

  it('序列化非法状态会抛,不写出坏文件', () => {
    const bad = { ...emptyState(), max_seen_version: 'banana' };
    expect(() => serializeUpdateState(bad)).toThrow();
  });

  it('recordCheck 只记观察,不抬高 max_seen_version(防被攻破的 registry 毒化防降级线)', () => {
    const s = recordCheck(emptyState(), {
      nowMs: T0,
      result: 'cooldown',
      latestSeen: '99.0.0',
      latestSeenPublishedAt: '2026-10-14T11:00:00.000Z',
    });
    expect(s.last_check_at).toBe('2026-10-14T12:00:00.000Z');
    expect(s.last_result).toBe('cooldown');
    expect(s.latest_seen).toBe('99.0.0');
    expect(s.max_seen_version).toBeUndefined();
  });

  it('markInstalled:max_seen 只增不减,previous 记上一版本', () => {
    const a = markInstalled(emptyState(), { version: '0.2.0', anchor: ANCHOR, nowMs: T0 });
    expect(a.max_seen_version).toBe('0.2.0');
    expect(a.previous).toBeUndefined();
    const b = markInstalled(a, { version: '0.3.0', anchor: ANCHOR, nowMs: T0 + 1000 });
    expect(b.max_seen_version).toBe('0.3.0');
    expect(b.previous?.version).toBe('0.2.0');
    // 回滚装回 0.2.0:max_seen 仍是 0.3.0
    const c = markInstalled(b, { version: '0.2.0', anchor: ANCHOR, nowMs: T0 + 2000 });
    expect(c.max_seen_version).toBe('0.3.0');
    expect(c.installed?.version).toBe('0.2.0');
    expect(() => serializeUpdateState(c)).not.toThrow();
  });

  it('markInstalled 不改入参', () => {
    const s = emptyState();
    markInstalled(s, { version: '0.2.0', anchor: ANCHOR, nowMs: T0 });
    expect(s.installed).toBeUndefined();
  });

  it('markBad 去重、不改入参;超上限时丢最低版本', () => {
    const s = markBad(markBad(emptyState(), '0.2.1'), '0.2.1');
    expect(s.bad_versions).toEqual(['0.2.1']);
    let big = emptyState();
    for (let i = 0; i < MAX_BAD_VERSIONS + 5; i++) big = markBad(big, `1.0.${i}`);
    expect(big.bad_versions).toHaveLength(MAX_BAD_VERSIONS);
    expect(big.bad_versions).toContain(`1.0.${MAX_BAD_VERSIONS + 4}`);
    expect(big.bad_versions).not.toContain('1.0.0');
    expect(() => serializeUpdateState(big)).not.toThrow();
  });

  it('失败提示每天一次', () => {
    const s = emptyState();
    expect(shouldNotify(s, T0)).toBe(true);
    const n = markNotified(s, T0);
    expect(shouldNotify(n, T0 + 23 * 3_600_000)).toBe(false);
    expect(shouldNotify(n, T0 + 24 * 3_600_000)).toBe(true);
    expect(shouldNotify(n, T0 - 1000)).toBe(true);
  });
});
