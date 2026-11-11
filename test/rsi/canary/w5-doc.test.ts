/**
 * W5 注入文本渲染与 `canary.json` 语义校验(R21-6.3 / M11):treat 输出 = 标记行 + 标签行 + 哈希前 12 位 + 正文,≤ 1536 字节;control 只有标记行。
 */
import { describe, expect, it } from 'vitest';
import {
  RSI_AUTO_LABEL,
  RSI_CANARY_INJECT_MAX_BYTES,
  RSI_MARK_PREFIX,
} from '../../../src/contracts/rsi.js';
import {
  canaryDocProblem,
  controlText,
  markerLine,
  treatText,
} from '../../../src/rsi/canary/canary-doc.js';
import { BODY, canaryDoc } from './w5-fixture.js';

const M = 'rsm_0123456789abcdef';

describe('渲染', () => {
  it('标记行 = 前缀 + 空格 + 标记,≤ 64 字节', () => {
    expect(markerLine(M)).toBe(`${RSI_MARK_PREFIX} ${M}`);
    expect(Buffer.byteLength(markerLine(M), 'utf8')).toBeLessThanOrEqual(64);
  });
  it('control 只有标记行;treat 在其后依次是 R21-1.9 标签、内容哈希前 12 位、正文', () => {
    expect(controlText(M)).toBe(`${markerLine(M)}\n`);
    expect(treatText(M, canaryDoc())).toBe(
      `${markerLine(M)}\n${RSI_AUTO_LABEL}\n${'a'.repeat(12)}\n${BODY}\n`,
    );
  });
  it('正文末尾已有换行不产生空行', () => {
    expect(treatText(M, canaryDoc({ body: '做:x\n' })).endsWith('做:x\n')).toBe(true);
    expect(treatText(M, canaryDoc({ body: '做:x\n' })).endsWith('\n\n')).toBe(false);
  });
});

describe('M11:treat 输出预算 ≤ 1536 字节(含标记行与末尾换行)', () => {
  const fits = (n: number): string | null => canaryDocProblem(canaryDoc({ body: 'a'.repeat(n) }));
  it('边界:恰好 1536 字节通过,多 1 字节被拒', () => {
    let lo = 1;
    while (fits(lo + 1) === null) lo++;
    expect(fits(lo)).toBeNull();
    expect(fits(lo + 1)).toBe('treat_over_budget');
    expect(Buffer.byteLength(treatText(M, canaryDoc({ body: 'a'.repeat(lo) })), 'utf8')).toBe(
      RSI_CANARY_INJECT_MAX_BYTES,
    );
  });
});

describe('语义校验的短码', () => {
  it('合法文档 → null;每种违规一个固定短码', () => {
    expect(canaryDocProblem(canaryDoc())).toBeNull();
    expect(canaryDocProblem(canaryDoc({ content_sha12: 'b'.repeat(12) }))).toBe('sha12_mismatch');
    expect(
      canaryDocProblem(
        canaryDoc({ agents_inject: ['pi', 'claude'], p_by_agent: { claude: 0.5, pi: 0.5 } }),
      ),
    ).toBe('agents_not_sorted');
    expect(canaryDocProblem(canaryDoc({ p_by_agent: { claude: 0 } }))).toBe('p_missing');
    expect(canaryDocProblem(canaryDoc({ body: `x ${RSI_MARK_PREFIX} y` }))).toBe(
      'body_has_marker_prefix',
    );
  });
});
