import { describe, expect, it } from 'vitest';
import { runMain } from './helpers.js';

/** cleanup3:--settle-ms 只收十进制非负整数(0..600000),空串 / 进制前缀 / 小数 / 符号 / 超界一律 USAGE(2)。 */
describe('zero-write --settle-ms 严格数字', () => {
  const run = (v: string, form: 'sep' | 'eq') =>
    runMain(
      form === 'sep' ? ['--settle-ms', v, '--bogus-flag'] : [`--settle-ms=${v}`, '--bogus-flag'],
    );

  it('非法值 → 退出 2,stderr 点名 --settle-ms', () => {
    for (const bad of [
      '',
      '0x10',
      '1e3',
      '+5',
      '-1',
      ' 5',
      '5 ',
      '1.5',
      '600001',
      '9'.repeat(30),
    ]) {
      for (const form of ['sep', 'eq'] as const) {
        const r = run(bad, form);
        expect(r.status, `${form} ${JSON.stringify(bad)}`).toBe(2);
        expect(r.stderr, `${form} ${JSON.stringify(bad)}`).toContain('--settle-ms 需要');
      }
    }
  });

  it('正向对照:0 / 120 / 0010 / 600000 通过参数解析(不报 --settle-ms 用法错)', () => {
    for (const ok of ['0', '120', '0010', '600000']) {
      const r = run(ok, 'eq');
      // 参数解析越过 --settle-ms,在后面的未知参数上才失败
      expect(r.status, ok).toBe(2);
      expect(r.stderr, ok).toContain('未知参数');
      expect(r.stderr, ok).not.toContain('--settle-ms 需要');
    }
  });
});
