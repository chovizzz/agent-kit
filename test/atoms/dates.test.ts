import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, fromDayNumber, toDayNumber } from '../../src/atoms/dates.js';

describe('日期算术(UTC 整数天)', () => {
  it('+30 天跨月:闰年与平年的 1 月 31 日结果不同', () => {
    expect(addDays('2028-01-31', 30)).toBe('2028-03-01');
    expect(addDays('2027-01-31', 30)).toBe('2027-03-02');
  });

  it('+180 天跨年', () => {
    expect(addDays('2026-10-08', 180)).toBe('2027-04-06');
  });

  it('闰日本身与跨闰日', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2028-02-29', 1)).toBe('2028-03-01');
    expect(addDays('2028-02-29', 366)).toBe('2029-03-01');
  });

  it('daysBetween 可为负,同日为 0', () => {
    expect(daysBetween('2026-10-08', '2026-10-08')).toBe(0);
    expect(daysBetween('2026-10-08', '2026-10-07')).toBe(-1);
  });

  it('跨夏令时切换日仍是整数天(不受进程时区影响)', () => {
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2); // 美国春季切换
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2); // 欧洲春季切换
    expect(daysBetween('2026-10-24', '2026-11-02')).toBe(9); // 欧洲/美国秋季切换
  });

  it('往返:fromDayNumber(toDayNumber(x)) === x,覆盖 1970 之前与 2100 年', () => {
    for (const d of ['1969-12-31', '1970-01-01', '2000-02-29', '2100-02-28', '2100-03-01']) {
      expect(fromDayNumber(toDayNumber(d))).toBe(d);
    }
  });
});
