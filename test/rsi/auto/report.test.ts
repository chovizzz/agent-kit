/**
 * `rsi report`(W8a;contracts R21-13.3、§21.24 W0-22 第 8 条):已观察事件范围、四类情形、损坏行、参数与区间。
 */
import { describe, expect, it } from 'vitest';
import { canonicalJsonLine } from '../../../src/io/canonical-json.js';
import { parseReportArgs, runReport, weekStart } from '../../../src/rsi/auto/read/report.js';
import { NOW, makeSink, makeWorld, portsOf } from './auto-fixture.js';

const line = (o: Record<string, unknown>): string =>
  canonicalJsonLine({
    at: '2026-11-10T00:00:00.000Z',
    kind: 'transition',
    id: 'ra_0123456789ab',
    ...o,
  });

async function run(
  w: ReturnType<typeof makeWorld>,
  range = { from: '2026-11-09', to: '2026-11-13' },
  json = true,
) {
  const sink = makeSink();
  const code = await runReport(portsOf(w), { json, range, forbidden: [] }, sink);
  return { code, ...sink.text() };
}

describe('参数与区间', () => {
  it('--week = 当前 UTC 周的周一起;--since D 必须是真实日历日;--week 与 --since 互斥', () => {
    expect(weekStart(new Date('2026-11-13T09:00:00Z'))).toBe('2026-11-09'); // 周五 → 周一
    expect(weekStart(new Date('2026-11-09T00:00:00Z'))).toBe('2026-11-09'); // 周一当天
    expect(weekStart(new Date('2026-11-15T23:59:59Z'))).toBe('2026-11-09'); // 周日
    expect(parseReportArgs([], NOW)).toEqual({
      ok: true,
      json: false,
      range: { from: '2026-11-09', to: '2026-11-13' },
    });
    expect(parseReportArgs(['--since', '2026-10-01', '--json'], NOW)).toEqual({
      ok: true,
      json: true,
      range: { from: '2026-10-01', to: '2026-11-13' },
    });
    expect(parseReportArgs(['--week', '--since', '2026-10-01'], NOW)).toEqual({
      ok: false,
      reason: 'mode_conflict',
    });
    for (const bad of [
      ['--since'],
      ['--since', '2026-02-30'],
      ['--since', '2026-1-1'],
      ['--since', '--json'],
    ]) {
      expect(parseReportArgs(bad, NOW), bad.join(' ')).toEqual({ ok: false, reason: 'bad_date' });
    }
    for (const bad of [['--bogus'], ['--json', '--json'], ['extra'], ['--since=2026-10-01']]) {
      expect(parseReportArgs(bad, NOW).ok, bad.join(' ')).toBe(false);
    }
  });
});

describe('四类情形', () => {
  it('(1)完整但前几天无事件 与 (2)被截断:不区分——输出逐字节相同,都是 request_before_observed=true', async () => {
    // 两者在盘上就是同一个文件:首行日期晚于请求起点。输出只依赖已观察事件,不声称区分
    const text = line({ at: '2026-11-11T00:00:00.000Z', to: 'canary', dim: 'lifecycle' });
    const a = makeWorld({ audit: { kind: 'ok', text } });
    const b = makeWorld({ audit: { kind: 'ok', text }, prior: true });
    const ra = await run(a);
    const rb = await run(b);
    expect(ra.code).toBe(0);
    expect(ra.out).toBe(rb.out);
    const j = JSON.parse(ra.out) as { request_before_observed: boolean; counts_scope: string };
    expect(j.request_before_observed).toBe(true);
    expect(j.counts_scope).toBe('observed');
    const t = await run(a, undefined, false);
    expect(t.out).toContain('已观察事件范围 2026-11-11..2026-11-11(1 行);不证明保留策略是否截断');
    expect(t.out).not.toContain('partial');
    expect(t.out).not.toContain('完整');
    expect(t.out).not.toContain('被截断');
  });

  it('请求起点不早于已观察起点 → request_before_observed=false', async () => {
    const w = makeWorld({ audit: { kind: 'ok', text: line({ at: '2026-11-01T00:00:00.000Z' }) } });
    const j = JSON.parse((await run(w)).out) as { request_before_observed: boolean };
    expect(j.request_before_observed).toBe(false);
  });

  it('(3)空文件:audit_file=present、observed=null、文本写「观察到 0 行」,不报「0 次转移」;账显示曾有转移 → 退 3 audit_invalid', async () => {
    const w = makeWorld({ audit: { kind: 'ok', text: '' } });
    const r = await run(w);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as { audit_file: string; observed: unknown };
    expect([j.audit_file, j.observed]).toEqual(['present', null]);
    const t = await run(w, undefined, false);
    expect(t.out).toContain('观察到 0 行');
    expect(t.out).not.toContain('transitions');
    w.prior = true;
    const f = await run(w);
    expect([f.code, f.out, f.err]).toEqual([3, '', 'RSI_FAIL_CLOSED reason=audit_invalid\n']);
  });

  it('(4)文件缺失:无账显示 → 退 0 并标「无审计文件(未观察到任何事件)」;账显示曾有转移 → 退 3 audit_invalid', async () => {
    const w = makeWorld();
    const r = await run(w, undefined, false);
    expect(r.code).toBe(0);
    expect(r.out).toContain('无审计文件(未观察到任何事件)');
    const j = JSON.parse((await run(w)).out) as { audit_file: string; observed: unknown };
    expect([j.audit_file, j.observed]).toEqual(['absent', null]);
    w.prior = true;
    expect((await run(w)).code).toBe(3);
  });

  it('任一行不合规 → corrupt_lines=<n>,退 3,不得跳过后退 0;读不出 → 退 3', async () => {
    const good = line({});
    const w = makeWorld({ audit: { kind: 'ok', text: `${good}{"bad":1}\nnot json\n` } });
    const r = await run(w);
    expect(r.code).toBe(3);
    expect(r.out).toBe('corrupt_lines=2\n');
    expect(r.err).toBe('RSI_FAIL_CLOSED reason=audit_invalid\n');
    const u = await run(makeWorld({ audit: { kind: 'unreadable' } }));
    expect([u.code, u.err]).toEqual([3, 'RSI_FAIL_CLOSED reason=audit_invalid\n']);
  });
});

describe('聚合(只算区间内的已观察行)', () => {
  it('转移 / 回滚 / 到期 / 灰度计数与 id;注入字节与 S2 次数求和;区间外的行不计', async () => {
    const text = [
      line({ id: 'ra_aaaaaaaaaaaa', dim: 'lifecycle', from: 'shadow', to: 'canary' }),
      line({ id: 'ra_aaaaaaaaaaaa', dim: 'lifecycle', from: 'canary', to: 'rolling_back' }),
      line({ id: 'ra_bbbbbbbbbbbb', dim: 'lifecycle', from: 'shadow', to: 'expired' }),
      line({ kind: 'evaluation', counts: { injected_bytes: 100, s2_count: 2 } }),
      line({
        at: '2026-10-01T00:00:00.000Z',
        dim: 'lifecycle',
        to: 'rolling_back',
        id: 'ra_cccccccccccc',
      }),
    ].join('');
    const j = JSON.parse((await run(makeWorld({ audit: { kind: 'ok', text } }))).out) as Record<
      string,
      { count?: number; ids?: string[] } & Record<string, unknown>
    >;
    expect(j['transitions']?.count).toBe(3);
    expect(j['rollbacks']).toEqual({ count: 1, ids: ['ra_aaaaaaaaaaaa'] });
    expect(j['expired']).toEqual({ count: 1, ids: ['ra_bbbbbbbbbbbb'] });
    expect(j['canary']).toEqual({ count: 1, ids: ['ra_aaaaaaaaaaaa'] });
    expect(j['cost']).toEqual({ injected_bytes: 100, s2_count: 2 });
    expect(Object.keys(j).sort()).toEqual(
      [
        'range',
        'transitions',
        'rollbacks',
        'expired',
        'cost',
        'canary',
        'audit_file',
        'observed',
        'request_before_observed',
        'counts_scope',
      ].sort(),
    );
  });

  it('不读私有仓库、不跑 git:受限只读 git 端口与 head.json 读取次数为 0', async () => {
    const w = makeWorld({ audit: { kind: 'ok', text: line({}) } });
    await run(w);
    expect([w.calls.commit, w.calls.tree, w.calls.blob, w.calls.head]).toEqual([0, 0, 0, 0]);
  });
});
