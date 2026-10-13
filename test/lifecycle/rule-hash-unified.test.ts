import { describe, expect, it } from 'vitest';
import { normalizedRuleSha256 as guardsHash } from '../../src/guards/criteria.js';
import { ruleSha256 } from '../../src/lifecycle/checks.js';
import { normalizedRuleSha256 as attestHash } from '../../src/lifecycle/attest-count.js';

const src = (status: string, reviewBy: string, body = 'x'): string =>
  `---\nid: r\nstatus: ${status}\nreview_by: ${reviewBy}\n---\n${body}\n`;

describe('规则文本哈希:C6 / 晋升判据 / attest 三处必须同一口径', () => {
  it('同一输入三处相等,且 status/review_by 变化不影响、正文变化影响', () => {
    const a = src('advisory', '2027-01-01');
    const h = ruleSha256(a);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(guardsHash(a)).toBe(h);
    expect(attestHash(a)).toBe(h);
    expect(guardsHash(src('active', '2027-02-02'))).toBe(h);
    expect(attestHash(src('active', '2027-02-02'))).toBe(h);
    expect(guardsHash(src('advisory', '2027-01-01', 'y'))).not.toBe(h);
  });
  it('无法归一化时:判据返回 undefined,attest/C6 抛错(fail-closed)', () => {
    const bad = '---\nid: r\nstatus: active\n---\nx\n';
    expect(guardsHash(bad)).toBeUndefined();
    expect(() => attestHash(bad)).toThrow();
    expect(() => ruleSha256(bad)).toThrow();
  });
});
