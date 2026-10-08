/**
 * 日期算术只用 UTC 日历天数(Date.UTC),与进程时区无关;「+N 天」是天数相加,不是月数。
 * 入参必须是 IsoDateSchema 校验过的真实日历日。
 */
const MS_PER_DAY = 86_400_000;

export function toDayNumber(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / MS_PER_DAY;
}

export function fromDayNumber(n: number): string {
  return new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return fromDayNumber(toDayNumber(iso) + days);
}

/** to − from 的天数(可为负)。 */
export function daysBetween(fromIso: string, toIso: string): number {
  return toDayNumber(toIso) - toDayNumber(fromIso);
}
