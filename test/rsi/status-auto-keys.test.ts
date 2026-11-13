/**
 * `rsi status --json` 的 R21-13.1 追加键(contracts R21-13.1、W0-22 第 7 条、W0-24):
 *   `auto`({enabled, phase, paused, pause_reasons, diverged, profile, profile_effective})、V1 的 `pipeline` / `budget` / `cost` / `canary` / `last_rollback` 取自物化视图
 *   (缺失 / 损坏 = null,不显示成全零;陈旧照出),V2+ 的 `static_watch` / `isolation` / `extensions` / `contrib` / `exec` 给惰性值。只读:目录树前后相同。
 */
import { describe, expect, it } from 'vitest';
import { RSI_AUTO_PHASE } from '../../src/contracts/rsi.js';
import { writeFile } from '../../src/io/safe-fs.js';
import { runStatus, type StatusDoc } from '../../src/rsi/status.js';
import { viewOf } from './auto/auto-fixture.js';
import { treeOf } from './rsi-fixture.js';
import { baseState, makeRoFx, runDirect, seed, validConfirm, type RoFx } from './ro-fixture.js';

const T_NOW = new Date('2026-11-13T09:00:00.000Z');
const run = (f: RoFx) => runDirect(f, runStatus, ['--json'], { now: () => T_NOW });
const doc = (out: string): StatusDoc => JSON.parse(out) as StatusDoc;

const INERT = {
  static_watch: null,
  isolation: { status: 'not_available', reason: null },
  extensions: { trial: 0, adopted: 0, pending_auth: 0 },
  contrib: 0,
  exec: 'not_available',
};

describe('rsi status --json:R21-13.1 追加键', () => {
  it('[rsi] 关闭(off):惰性值,V1 的视图派生键全是 null,auto 未启用 / 未暂停,phase 取当前相位', async () => {
    const f = await makeRoFx('st-ak-off-');
    await writeFile(f.fx, f.cfgFile, '[rsi]\nenabled = false\n', { mode: 0o600 });
    const r = await run(f);
    expect(r.code).toBe(0);
    const d = doc(r.out);
    expect(d.auto).toEqual({
      enabled: false,
      phase: RSI_AUTO_PHASE,
      paused: false,
      pause_reasons: [],
      diverged: false,
      profile: 'medium',
      profile_effective: 'lite',
    });
    expect([d.pipeline, d.budget, d.cost, d.canary, d.last_rollback]).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(d).toMatchObject(INERT);
  });

  it('on 而没有视图(missing):V1 的视图派生键是 null(绝不显示成全零);[rsi.auto] 启用与 profile 如实报告,相位低于 V3 时 profile_effective 恒 lite', async () => {
    const f = await makeRoFx('st-ak-missing-', '\n[rsi.auto]\nenabled = true\nprofile = "heavy"\n');
    await seed(f, { state: baseState({ confirm: await validConfirm(f) }) });
    const d = doc((await run(f)).out);
    expect(d.auto).toMatchObject({ enabled: true, profile: 'heavy', profile_effective: 'lite' });
    expect([d.pipeline, d.budget, d.cost, d.canary, d.last_rollback]).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(d).toMatchObject(INERT);
  });

  it('fresh 视图:pipeline / budget / cost / canary / last_rollback 取自视图;stale(超过 48 小时)同样照出', async () => {
    for (const asOf of ['2026-11-13T08:00:00.000Z', '2026-11-01T08:00:00.000Z']) {
      const f = await makeRoFx('st-ak-view-');
      const view = viewOf({
        as_of: asOf,
        budget: { used_pct: 42 },
        last_rollback: { id: 'ra_0123456789ab', at: '2026-11-12T00:00:00.000Z', reason: 'cleared' },
      });
      await seed(f, {
        state: baseState({ confirm: await validConfirm(f) }),
        side: { 'auto-view.json': JSON.stringify(view) },
      });
      const d = doc((await run(f)).out);
      expect(d.pipeline, asOf).toEqual(view.pipeline);
      expect(d.budget, asOf).toEqual({ used_pct: 42 });
      expect(d.cost, asOf).toEqual(view.cost);
      expect(d.canary, asOf).toBeNull();
      expect(d.last_rollback, asOf).toEqual(view.last_rollback);
    }
  });

  it('损坏的视图(不是 JSON / 过不了 schema):派生键 null,命令仍退 0', async () => {
    for (const text of ['not json', '{"schema_version":1}']) {
      const f = await makeRoFx('st-ak-corrupt-');
      await seed(f, {
        state: baseState({ confirm: await validConfirm(f) }),
        side: { 'auto-view.json': text },
      });
      const r = await run(f);
      expect(r.code, text).toBe(0);
      const d = doc(r.out);
      expect([d.pipeline, d.budget, d.cost, d.canary, d.last_rollback], text).toEqual([
        null,
        null,
        null,
        null,
        null,
      ]);
    }
  });

  it('暂停:U 文件存在 → paused 且 pause_reasons 含 user_paused;state 的熔断码与 diverged 如实带出;B 单独存在也算 paused', async () => {
    const a = await makeRoFx('st-ak-pause-u-');
    await seed(a, {
      state: baseState({ confirm: await validConfirm(a) }),
      side: { AUTO_PAUSE: '{}' },
    });
    const da = doc((await run(a)).out);
    expect(da.auto).toMatchObject({ paused: true, pause_reasons: ['user_paused'] });

    const b = await makeRoFx('st-ak-pause-state-');
    await seed(b, {
      state: baseState({
        confirm: await validConfirm(b),
        auto_pause: { reasons: ['rollback_storm'], diverged: true, owner_changed: false },
      }),
    });
    const db = doc((await run(b)).out);
    expect(db.auto).toMatchObject({
      paused: true,
      pause_reasons: ['rollback_storm'],
      diverged: true,
    });

    const c = await makeRoFx('st-ak-pause-b-');
    await seed(c, {
      state: baseState({ confirm: await validConfirm(c) }),
      side: { AUTO_PAUSE_BREAKER: '{}' },
    });
    expect(doc((await run(c)).out).auto).toMatchObject({ paused: true, pause_reasons: [] });

    const d = await makeRoFx('st-ak-pause-none-');
    await seed(d, { state: baseState({ confirm: await validConfirm(d) }) });
    expect(doc((await run(d)).out).auto).toMatchObject({ paused: false, pause_reasons: [] });
  });

  it('只读:跑 status 前后目录树相同,写审计为空', async () => {
    const f = await makeRoFx('st-ak-ro-');
    await seed(f, {
      state: baseState({ confirm: await validConfirm(f) }),
      side: { 'auto-view.json': JSON.stringify(viewOf({ as_of: '2026-11-13T08:00:00.000Z' })) },
    });
    const before = await treeOf(f.dir);
    const r = await run(f);
    expect(r.audit).toEqual([]);
    expect(await treeOf(f.dir)).toEqual(before);
  });
});
