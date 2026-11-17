/**
 * W0-29 ⑥:doctor D18「worker 安全残余」。展示合成(`checkD18`,纯)、log 末尾解析(`skippedLockedTailOf`)、真夹具采集(`collectD18`,只读不写)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkD18 } from '../../../src/doctor/checks.js';
import { collectD18, skippedLockedTailOf } from '../../../src/doctor/rsi-residual.js';
import { writeFile } from '../../../src/io/safe-fs.js';
import { makeTickFx, type TickFx } from '../b5a-fixture.js';
import { treeOf } from '../rsi-fixture.js';
import {
  NOW,
  baseState,
  countsOf,
  indexOf,
  key,
  mkProject,
  seed,
  validConfirm,
} from '../ro-fixture.js';
import { canaryDoc } from '../canary/w5-fixture.js';

const NOW_MS = Date.parse(NOW);
const FACTS = { lock: 'free', marker_b: false, marker_u: false };

describe('checkD18(纯展示合成)', () => {
  it('不适用 → n_a / absent;读不到 → warn / unreadable;无信号 → ok;有信号 → warn,result 取首个、items 列全部', () => {
    expect(
      checkD18({ applicable: false, unreadable: false, signals: [], facts: FACTS }),
    ).toMatchObject({
      id: 'D18',
      status: 'n_a',
      result: 'absent',
    });
    expect(
      checkD18({ applicable: true, unreadable: true, signals: [], facts: FACTS }),
    ).toMatchObject({
      status: 'warn',
      result: 'unreadable',
    });
    expect(
      checkD18({ applicable: true, unreadable: false, signals: [], facts: FACTS }),
    ).toMatchObject({
      status: 'ok',
      result: 'ok',
      items: [],
    });
    const w = checkD18({
      applicable: true,
      unreadable: false,
      signals: ['lock_starvation', 'p_heartbeat_approx'],
      facts: { lock: 'held_over_ttl', marker_b: false, marker_u: true },
    });
    expect(w).toMatchObject({
      status: 'warn',
      result: 'lock_starvation',
      counts: { signals: 2 },
      items: ['lock_starvation', 'p_heartbeat_approx'],
      facts: { lock: 'held_over_ttl', marker_b: false, marker_u: true },
    });
  });
  it('facts 里的非枚举串不原样输出(路径 / 用户名进不来)', () => {
    const c = checkD18({
      applicable: true,
      unreadable: false,
      signals: [],
      facts: { lock: '/Users/alice/secret', marker_b: null, marker_u: null },
    });
    expect(c.facts['lock']).toBeNull();
  });
});

describe('skippedLockedTailOf', () => {
  const row = (at: string, code: string, action = 'skipped'): string =>
    JSON.stringify({ at, trigger: 'poke', action, code });
  it('只数末尾连续的 skipped_locked;首尾时刻取最早 / 最晚', () => {
    const text = [
      row('2026-11-17T00:00:00Z', 'ok', 'ran'),
      row('2026-11-17T01:00:00Z', 'skipped_locked'),
      row('2026-11-17T01:20:00Z', 'skipped_locked'),
      row('2026-11-17T01:40:00Z', 'skipped_locked'),
      '',
    ].join('\n');
    expect(skippedLockedTailOf(text)).toEqual({
      count: 3,
      firstAtMs: Date.parse('2026-11-17T01:00:00Z'),
      lastAtMs: Date.parse('2026-11-17T01:40:00Z'),
    });
  });
  it('尾部有别的行 / 不合规行 → 0 条;中间夹别的行只数其后', () => {
    expect(
      skippedLockedTailOf(
        row('2026-11-17T01:00:00Z', 'skipped_locked') +
          '\n' +
          row('2026-11-17T02:00:00Z', 'other', 'failed'),
      ),
    ).toMatchObject({ count: 0 });
    expect(skippedLockedTailOf('not json')).toMatchObject({ count: 0 });
    expect(skippedLockedTailOf('')).toMatchObject({ count: 0, firstAtMs: null, lastAtMs: null });
  });
});

async function world(prefix: string, state: Record<string, unknown>): Promise<TickFx> {
  const f = await makeTickFx(prefix, { noSeed: true, extra: '\n[rsi.auto]\nenabled = true\n' });
  const p = await mkProject(f, 'one');
  await seed(f, {
    state: baseState({ confirm: await validConfirm(f), projects_ack_generation: 5, ...state }),
    index: indexOf([{ key: key(1), path: p.path, dev: p.dev, ino: p.ino, firstGen: 9 }], 9),
    counts: countsOf({ [key(1)]: { total: 1 } }),
  });
  return f;
}

describe('collectD18(真夹具;只读)', () => {
  it('safety 熔断 + canary 可注入 + B/U 皆无 → 信号 safety_breaker_inject;采集前后文件树不变', async () => {
    const f = await world('c2-d18-safety-', {
      breaker: { kind: 'safety', opened_at: NOW, until: null },
      last_tick: null,
    });
    await writeFile(f.io, path.join(f.rsiDir, 'canary.json'), JSON.stringify(canaryDoc({})), {
      mode: 0o600,
    });
    const before = await treeOf(f.dir);
    const r = await collectD18({ home: f.home, env: f.env, now: () => new Date(NOW_MS) });
    expect(r).toMatchObject({
      applicable: true,
      unreadable: false,
      signals: ['safety_breaker_inject'],
      facts: { marker_b: false, marker_u: false },
    });
    expect(await treeOf(f.dir)).toEqual(before);
  });

  it('B 标记在 → 同一夹具不再成立(正向对照)', async () => {
    const f = await world('c2-d18-marker-', {
      breaker: { kind: 'safety', opened_at: NOW, until: null },
    });
    await writeFile(f.io, path.join(f.rsiDir, 'canary.json'), JSON.stringify(canaryDoc({})), {
      mode: 0o600,
    });
    await writeFile(f.io, path.join(f.rsiDir, 'AUTO_PAUSE_BREAKER'), '{}', { mode: 0o600 });
    const r = await collectD18({ home: f.home, env: f.env, now: () => new Date(NOW_MS) });
    expect(r.signals).toEqual([]);
    expect(r.facts.marker_b).toBe(true);
  });

  it('log.jsonl 不合规 → 不抛、不臆测:无信号、不算 unreadable', async () => {
    const f = await world('c2-d18-badstate-', {});
    await writeFile(f.io, path.join(f.rsiDir, 'log.jsonl'), 'garbage\n', { mode: 0o600 });
    const r = await collectD18({ home: f.home, env: f.env, now: () => new Date(NOW_MS) });
    expect(r.unreadable).toBe(false);
    expect(r.signals).toEqual([]);
  });
});
