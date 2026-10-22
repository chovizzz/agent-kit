import { describe, expect, it } from 'vitest';
import { BudgetTargetSchema } from '../../src/contracts/config.js';

const PROBED = {
  limit_source: 'probed',
  probed_value: 1000,
  probed_agent_version: '1.0.0',
  probed_at: '2026-10-08T00:00:00Z',
} as const;

const msgs = (x: unknown): string => {
  const r = BudgetTargetSchema.safeParse(x);
  return r.success ? '' : r.error.issues.map((i) => i.message).join('; ');
};

describe('BudgetTarget.probed_lines(PB5)', () => {
  it('probed + max_bytes + max_lines + probed_lines 通过', () => {
    expect(
      BudgetTargetSchema.safeParse({
        max_bytes: 1000,
        max_lines: 500,
        ...PROBED,
        probed_lines: 600,
      }).success,
    ).toBe(true);
  });
  it('不写 probed_lines 的既有 probed 目标仍通过(向后兼容)', () => {
    expect(BudgetTargetSchema.safeParse({ max_bytes: 1000, ...PROBED }).success).toBe(true);
    expect(BudgetTargetSchema.safeParse({ max_bytes: 1000, max_lines: 5, ...PROBED }).success).toBe(
      true,
    );
  });
  it.each([0, -1, 1.5, '3'])('probed_lines=%s 非正整数 → 失败', (v) => {
    expect(
      BudgetTargetSchema.safeParse({ max_bytes: 1, max_lines: 5, ...PROBED, probed_lines: v })
        .success,
    ).toBe(false);
  });
  it('limit_source≠probed 却有 probed_lines → PROBED_LINES_REQUIRES_PROBED', () => {
    for (const src of ['documented', 'assumed']) {
      expect(msgs({ max_bytes: 1, max_lines: 5, limit_source: src, probed_lines: 3 })).toContain(
        'PROBED_LINES_REQUIRES_PROBED',
      );
    }
  });
  it('没有 max_lines 却有 probed_lines → PROBED_LINES_REQUIRES_MAX_LINES', () => {
    expect(msgs({ max_bytes: 1000, ...PROBED, probed_lines: 3 })).toContain(
      'PROBED_LINES_REQUIRES_MAX_LINES',
    );
  });
  it('未知字段仍被 strict 拒绝', () => {
    expect(BudgetTargetSchema.safeParse({ max_bytes: 1, ...PROBED, probed_line: 1 }).success).toBe(
      false,
    );
  });
});
