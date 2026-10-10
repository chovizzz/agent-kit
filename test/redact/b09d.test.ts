/**
 * B09d:多层转义引号(`\"` `\\\"` `\\\\\\\"`)下两遍扫描必须一致;口令字面量一律脱敏。
 * 口令运行时拼装。
 */
import { describe, expect, it } from 'vitest';
import { newRedactor } from './helpers.js';

const r = newRedactor();
const PH = '[[REDACTED:';
const BS = '\\';
const val = ['Zk', '9fQ', 'x2L', 'm7Rt', 'b'].join('');
const key = ['pass', 'word'].join('');

/** 0 层:裸引号;n 层:JSON 转义 n 次后的引号(1 层 = \", 2 层 = \\\", 3 层 = \\\\\\\") */
function q(layers: number): string {
  if (layers === 0) return '"';
  return BS.repeat(2 ** layers - 1) + '"';
}

describe('B09d 多层转义引号', () => {
  for (const layers of [0, 1, 2, 3]) {
    it(`u.${key} 赋值,${layers} 层转义:脱敏、复扫干净、幂等`, () => {
      const Q = q(layers);
      const text = `p = (raw) => { const u = new URL(raw); u.${key} = ${Q}${val}${Q}; u.username = p`;
      const a = r.apply(text);
      expect(a.ok).toBe(true);
      if (!a.ok) return;
      expect(a.text).not.toContain(val);
      expect(a.text).toContain(PH);
      expect(r.pass2(a.text).clean).toBe(true);
      const b = r.apply(a.text);
      expect(b.ok).toBe(true);
      if (b.ok) expect(b.text).toBe(a.text);
      const p1 = r.pass1(text);
      expect(p1.text).not.toContain(val);
    });
  }
});
