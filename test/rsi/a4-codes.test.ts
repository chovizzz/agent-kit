/**
 * R20-A4:g0_ 子码表(docs/contracts.md R20-16.17)与稳定码枚举(R20-16.21)。
 * 静态覆盖:validator 的**全部**拒绝 code 与**全部** dropped 类别都在显式映射表里,映射值都属于封闭枚举;
 * validator 新增 code / 类别而未登记 → 本测试红(运行时的 `?? 'schema_invalid'` 兜底只是兜底,不替代这里)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RSI_DIGEST_REASONS,
  RSI_EXIT1_CODES,
  RSI_INGEST_REJECT_REASONS,
  RSI_NOT_RUN_REASONS,
  RSI_SESSION_REASONS,
  RSI_USAGE_REASONS,
  VALIDATOR_CODE_TO_REJECT,
  VALIDATOR_DROPPED_TO_REJECT,
} from '../../src/contracts/rsi.js';
import { readText } from '../../src/io/read-fs.js';
import { VALIDATOR_DROPPED_KINDS, VALIDATOR_REJECT_CODES } from '../../src/reflect/validate.js';
import { ROOT } from './closure-util.js';

const unmapped = (items: readonly string[], table: Readonly<Record<string, string>>): string[] =>
  items.filter((x) => !Object.hasOwn(table, x));
const FULL = await readText(path.join(ROOT, 'docs/contracts.md'));
const VALIDATE_SRC = await readText(path.join(ROOT, 'src/reflect/validate.ts'));

describe('R20-16.17 显式映射表的静态覆盖', () => {
  it('validator 的全部拒绝 code 都在 VALIDATOR_CODE_TO_REJECT 里,映射值都属于封闭枚举;同名原样映射', () => {
    expect(unmapped(VALIDATOR_REJECT_CODES, VALIDATOR_CODE_TO_REJECT)).toEqual([]);
    expect(Object.keys(VALIDATOR_CODE_TO_REJECT).sort()).toEqual(
      [...VALIDATOR_REJECT_CODES].sort(),
    );
    for (const [k, v] of Object.entries(VALIDATOR_CODE_TO_REJECT)) {
      expect(RSI_INGEST_REJECT_REASONS as readonly string[]).toContain(v);
      expect(v).toBe(k);
    }
  });
  it('validator 的全部 dropped 类别都在 VALIDATOR_DROPPED_TO_REJECT 里;evidence_alias_unknown → alias_unknown,其余同名', () => {
    expect(unmapped(VALIDATOR_DROPPED_KINDS, VALIDATOR_DROPPED_TO_REJECT)).toEqual([]);
    expect(Object.keys(VALIDATOR_DROPPED_TO_REJECT).sort()).toEqual(
      [...VALIDATOR_DROPPED_KINDS].sort(),
    );
    for (const [k, v] of Object.entries(VALIDATOR_DROPPED_TO_REJECT)) {
      expect(RSI_INGEST_REJECT_REASONS as readonly string[]).toContain(v);
      expect(v).toBe(k === 'evidence_alias_unknown' ? 'alias_unknown' : k);
    }
  });
  it('源码对照(防列表与实现脱节):validate.ts 里写出的每个 code: / bump(dropped, …) 字面量都在列表里', () => {
    const codes = [...VALIDATE_SRC.matchAll(/code: '([a-z_]+)'/g)].map((m) => m[1] as string);
    const kinds = [...VALIDATE_SRC.matchAll(/bump\(dropped, '([a-z_]+)'\)/g)].map(
      (m) => m[1] as string,
    );
    expect(codes.length).toBeGreaterThan(0); // 正向前提:正则确实抓到了
    expect(kinds.length).toBeGreaterThan(0);
    expect(new Set(codes)).toEqual(new Set(VALIDATOR_REJECT_CODES));
    expect(new Set(kinds)).toEqual(new Set(VALIDATOR_DROPPED_KINDS));
  });
  it('反向对照:列表里多一个未登记的 code / 类别,检查函数立刻抓到', () => {
    expect(
      unmapped([...VALIDATOR_REJECT_CODES, 'brand_new_code'], VALIDATOR_CODE_TO_REJECT),
    ).toEqual(['brand_new_code']);
    expect(
      unmapped([...VALIDATOR_DROPPED_KINDS, 'brand_new_kind'], VALIDATOR_DROPPED_TO_REJECT),
    ).toEqual(['brand_new_kind']);
  });
});

describe('枚举与契约正文逐项一致', () => {
  it('RSI_INGEST_REJECT_REASONS == R20-16.17 列出的 23 个子码(顺序、无重复)', () => {
    const line = FULL.split('\n').find((l) => l.startsWith('- R20-16.17')) as string;
    expect(line).toBeDefined();
    const head = line.slice(0, line.indexOf('。validator'));
    const doc = [...head.matchAll(/`([a-z_]+)`/g)]
      .map((m) => m[1] as string)
      .filter((t) => t !== 'g0_' && t !== 'reason');
    expect(doc).toHaveLength(23);
    expect([...RSI_INGEST_REJECT_REASONS]).toEqual(doc);
    expect(new Set(RSI_INGEST_REJECT_REASONS).size).toBe(RSI_INGEST_REJECT_REASONS.length);
  });
  it('R20-16.3 的会话授权判定码 / R20-16.9 的 digest reason 与契约一致', () => {
    expect([...RSI_SESSION_REASONS]).toEqual(['off', 'invalid', 'expired', 'agent_not_authorized']);
    expect([...RSI_DIGEST_REASONS]).toEqual([
      'ok',
      'no_project',
      'project_excluded',
      'attribution_unknown',
      'no_clusters',
    ]);
  });
  it('R20-16.21:NOT_RUN 追加 purge_pending / digest_backlog / policy_changed(rate_limited 共用);顶层(1)追加三个', () => {
    for (const c of ['purge_pending', 'digest_backlog', 'policy_changed', 'rate_limited']) {
      expect(RSI_NOT_RUN_REASONS as readonly string[]).toContain(c);
    }
    for (const c of ['RSI_INGEST_TOO_LARGE', 'RSI_STAGING_FULL', 'RSI_INGEST_REJECTED']) {
      expect(RSI_EXIT1_CODES as readonly string[]).toContain(c);
    }
    // A4 自己登记的 USAGE 码(契约没写具体码,待主代理并入)
    for (const c of ['missing:--json', 'missing:--digest', 'missing:--owner']) {
      expect(RSI_USAGE_REASONS as readonly string[]).toContain(c);
    }
  });
});
