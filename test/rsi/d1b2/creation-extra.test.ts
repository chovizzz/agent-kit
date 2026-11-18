/**
 * D1b-2:`CreationExtra` 端口与恒拒默认(`creation-extra.ts`;I14)。「创建恒拒」是防误接线:默认实现恒返回 `creation_unready`,
 * 接进 `GrowthReaders.extra` 后 `evaluateGrowth('candidate_create')` 恒拒(对照:默认全绿的 readers 通过,证明拒绝来自它)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readTextSync } from '../../../src/io/read-fs.js';
import {
  REFUSING_CREATION_EXTRA,
  type CreationExtra,
} from '../../../src/rsi/personal/creation-extra.js';
import {
  GROWTH_DENY_CODES,
  evaluateGrowth,
  isGrowthPass,
} from '../../../src/rsi/personal/stage/growth.js';
import { ROOT, closureOf } from '../closure-util.js';
import { STAGE_ALL, openBoth, readers } from '../stage/c1-fixture.js';

describe('d1_creation_always_refused_with_reason', () => {
  it('REFUSING_CREATION_EXTRA 恒返回 {ok:false, code:creation_unready}(冻结值,与回合无关)', async () => {
    const { round } = await openBoth();
    expect(Object.isFrozen(REFUSING_CREATION_EXTRA)).toBe(true);
    for (let i = 0; i < 3; i++) {
      expect(await REFUSING_CREATION_EXTRA.check(round)).toEqual({
        ok: false,
        code: 'creation_unready',
      });
    }
  });

  it('接进 GrowthReaders.extra:evaluateGrowth(candidate_create) → creation_unready;不接(全绿对照)→ 通过', async () => {
    const w = await openBoth();
    const wired = readers({ extra: (round) => REFUSING_CREATION_EXTRA.check(round) });
    const denied = await evaluateGrowth(w.round, { op: 'candidate_create' }, wired, STAGE_ALL);
    expect(isGrowthPass(denied)).toBe(false);
    expect((denied as { code: string }).code).toBe('creation_unready');
    expect(GROWTH_DENY_CODES).toContain('creation_unready');

    const w2 = await openBoth();
    const control = await evaluateGrowth(
      w2.round,
      { op: 'candidate_create' },
      readers(),
      STAGE_ALL,
    );
    expect(isGrowthPass(control)).toBe(true);
  });

  it('端口返回的码都在 C1a 的 ExtraDeny 子集内(creation_unready / purge / fp_key_unavailable 可被 extra 位接收)', async () => {
    for (const code of ['creation_unready', 'purge', 'fp_key_unavailable'] as const) {
      const w = await openBoth();
      const x: CreationExtra = { check: async () => ({ ok: false, code }) };
      const r = await evaluateGrowth(
        w.round,
        { op: 'candidate_create' },
        readers({ extra: (round) => x.check(round) }),
        STAGE_ALL,
      );
      expect((r as { code: string }).code, code).toBe(code);
    }
  });

  it('creation-extra.ts 不在 worker / 严格入口闭包里(只有 D3 的 readers 装配会引用它);文件只 import type', () => {
    for (const entry of ['src/rsi/assemble-worker.ts', 'src/rsi/personal/candidate-step.ts']) {
      const c = closureOf([entry], { includeTypes: true });
      expect(c.files.has('src/rsi/personal/creation-extra.ts'), entry).toBe(false);
    }
    const src = readTextSync(path.join(ROOT, 'src/rsi/personal/creation-extra.ts'));
    expect(src).toMatch(/import type \{ CheckResult \}/);
    expect(src).not.toMatch(/^import (?!type)/m);
  });
});
