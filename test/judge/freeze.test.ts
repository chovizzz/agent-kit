import { describe, expect, it } from 'vitest';
import { AcceptanceProtocolSchema } from '../../src/contracts/proposal.js';
import type { AcceptanceProtocol } from '../../src/contracts/proposal.js';
import {
  acceptanceSha256,
  buildAcceptance,
  buildPrediction,
  decidePredictionStatus,
  guidanceSha256,
  sha256OfCanonical,
  signatureSha256,
} from '../../src/judge/freeze.js';
import { GUIDANCE, FROZEN_NOW } from './helpers.js';

const HEAD = 'a'.repeat(40);
const base = () =>
  buildAcceptance({
    ruleSha256: 'b'.repeat(64),
    signature: { type: 'phrase', pattern: 'x' },
    guidance: GUIDANCE,
    headOid: HEAD,
    now: FROZEN_NOW,
    tileDays: 7,
    maxTiles: 4,
  });

describe('冻结哈希口径(K4 的 G3 必须复用这些固定向量)', () => {
  it('硬编码 digest(独立用 node 另算,含乱序键与非 ASCII)', () => {
    expect(signatureSha256({ type: 'phrase', pattern: 'ünï "x"' })).toBe(
      'e8a1170d7ae7a4a63c377a3f7f931ea7958617456d389a44b1d002be9da258d1',
    );
    expect(guidanceSha256(GUIDANCE)).toBe(
      'ea74124d835f9a581b010c441502f16859e1bc8f3a8bd2cb22f84f0a180b0483',
    );
    expect(signatureSha256({ type: 'phrase', pattern: 'x' })).toBe(
      '666e532f468fe486a178c48ac08f53cc6e65ef6946c59eaaa978ee975350ab13',
    );
    expect(base().sha256).toBe('aeb4a98db17ce0a09ad3d1a341386fd440f9fe24eb651638e78c90f43b290269');
  });

  it('canonical 哈希固定向量', () => {
    // 固定向量:sha256("null\n")
    expect(sha256OfCanonical(null)).toBe(
      '38e0b9de817f645c4bec37c0d4a3e58baecccb040f5718dc069a72c7385a0bed',
    );
    expect(guidanceSha256(undefined)).toBe(sha256OfCanonical(null));
    expect(signatureSha256(undefined)).toBe(sha256OfCanonical(null));
    // pattern 缺省不带键;键序无关
    expect(signatureSha256({ type: 'always' })).toBe(sha256OfCanonical({ type: 'always' }));
    expect(signatureSha256({ type: 'phrase', pattern: 'p' })).toBe(
      sha256OfCanonical({ pattern: 'p', type: 'phrase' }),
    );
    expect(signatureSha256({ type: 'phrase', pattern: 'p' })).not.toBe(
      signatureSha256({ type: 'phrase' }),
    );
    expect(guidanceSha256(GUIDANCE)).not.toBe(guidanceSha256(undefined));
  });

  it('acceptance 字段值固定:anchor_min = max(until,frozen) UTC 日 +1;guidance_until 取 guidance', () => {
    const a = base();
    expect(AcceptanceProtocolSchema.safeParse(a).success).toBe(true);
    expect(a.anchor_min).toBe('2026-10-15');
    expect(a.guidance_until).toBe(GUIDANCE.until);
    expect(a.frozen_at).toBe('2026-10-14T05:40:00Z');
    expect(a.sha256).toBe(acceptanceSha256(a));
  });

  it('W3 逐字段:schema 里除 sha256 外的每个字段改动都会改变自哈希(字段集合由 schema 驱动)', () => {
    const a = base();
    const keys = Object.keys(AcceptanceProtocolSchema.shape).filter((k) => k !== 'sha256');
    expect(keys.length).toBe(Object.keys(a).length - 1); // 正向对照:没有 schema 之外的字段
    for (const k of keys) {
      const cur = (a as unknown as Record<string, unknown>)[k];
      const changed = typeof cur === 'number' ? cur + 1 : `${String(cur)}x`;
      const mutated = { ...a, [k]: changed } as AcceptanceProtocol;
      expect(acceptanceSha256(mutated), k).not.toBe(a.sha256);
    }
    // 对照:sha256 字段本身不参与
    expect(acceptanceSha256({ ...a, sha256: 'f'.repeat(64) })).toBe(a.sha256);
  });

  it('时钟早于 guidance.until → 抛错;没有 guidance(旧暂存提案)→ guidance_until=frozen_at', () => {
    expect(() =>
      buildAcceptance({
        ruleSha256: 'b'.repeat(64),
        signature: undefined,
        guidance: { ...GUIDANCE, until: '2026-10-15T00:00:00Z' },
        headOid: HEAD,
        now: FROZEN_NOW,
        tileDays: 7,
        maxTiles: 4,
      }),
    ).toThrow();
    const a = buildAcceptance({
      ruleSha256: 'b'.repeat(64),
      signature: undefined,
      guidance: undefined,
      headOid: HEAD,
      now: FROZEN_NOW,
      tileDays: 7,
      maxTiles: 4,
    });
    expect(a.guidance_until).toBe(a.frozen_at);
    expect(a.baseline_sha256).toBe(sha256OfCanonical(null));
  });

  it('预测状态:path/always/无签名 → not_measurable;基线不足 → baseline_insufficient;边界两侧', () => {
    const g = (s: number, e: number) => ({
      ...GUIDANCE,
      baseline: { sessions_total: s, exposure_sessions: e, fired: e },
    });
    const sig = { type: 'phrase' };
    expect(decidePredictionStatus(sig, g(20, 3))).toBe('predicted');
    expect(decidePredictionStatus(sig, g(19, 3))).toBe('baseline_insufficient');
    expect(decidePredictionStatus(sig, g(20, 2))).toBe('baseline_insufficient');
    expect(decidePredictionStatus(sig, undefined)).toBe('baseline_insufficient');
    expect(decidePredictionStatus({ type: 'tool' }, g(20, 3))).toBe('predicted');
    for (const t of ['path', 'always']) {
      expect(decidePredictionStatus({ type: t }, g(500, 50))).toBe('not_measurable');
    }
    expect(decidePredictionStatus(undefined, g(500, 50))).toBe('not_measurable');
  });

  it('buildPrediction:非 predicted 不带四值', () => {
    const a = base();
    const p = buildPrediction('baseline_insufficient', undefined, a);
    expect(Object.keys(p).sort()).toEqual([
      'acceptance_sha256',
      'metric',
      'schema_version',
      'status',
    ]);
    expect(p.acceptance_sha256).toBe(a.sha256);
  });
});
