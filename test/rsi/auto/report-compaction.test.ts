/**
 * `rsi report` 读压缩文件(B1b;设计稿 v3 §D.4;§21.24 W0-26 第 7、8 条):压缩文件 → 审计 → 压缩文件 的 `gen` 双读。
 * 第二次读失败 / 不受支持不回退第一次结果(退 3 `audit_invalid`),第一次存在而第二次缺失 = `compaction_vanished`,`gen` 变化重试 ≤ 3 轮、耗尽退 4 `RSI_SNAPSHOT_BUSY`
 * (不输出部分结果)。P2 与 P3 之间的残留行(日期 ≤ W)不重计;压缩后审计为空 / 缺失不再误退 3;JSON 键集合不变。
 */
import { describe, expect, it } from 'vitest';
import { RSI_SNAPSHOT_BUSY } from '../../../src/contracts/rsi.js';
import type { RawRead } from '../../../src/rsi/auto/read/ports.js';
import { runReport } from '../../../src/rsi/auto/read/report.js';
import { canonicalJson, canonicalJsonLine } from '../../../src/io/canonical-json.js';
import { makeSink, makeWorld, portsOf } from './auto-fixture.js';

const row = (at: string, extra: Record<string, unknown> = {}): string =>
  canonicalJsonLine({
    at,
    kind: 'transition',
    id: 'ra_0123456789ab',
    to: 'canary',
    dim: 'lifecycle',
    ...extra,
  });
const comp = (
  gen: number,
  through: string | null = '2026-10-31',
  extra: Record<string, unknown> = {},
): RawRead => ({
  kind: 'ok',
  text: canonicalJson({ schema_version: 1, gen, through, months: {}, ...extra }),
});
const RANGE = { from: '2026-10-01', to: '2026-11-13' };

async function run(w: ReturnType<typeof makeWorld>, range = RANGE) {
  const sink = makeSink();
  const code = await runReport(portsOf(w), { json: true, range, forbidden: [] }, sink);
  return { code, ...sink.text() };
}
const doc = (out: string) =>
  JSON.parse(out) as {
    transitions: { count: number };
    observed: { from: string; to: string; lines: number } | null;
    request_before_observed: boolean;
    audit_file: string;
  };

describe('压缩后的审计口径', () => {
  it('report_between_p2_p3_no_double_count:P2 之后 P3 之前,日期 ≤ W 的残留行不计;W 之后的行照常计;对照:无压缩文件时两行都计', async () => {
    const text = row('2026-10-20T00:00:00.000Z') + row('2026-11-10T00:00:00.000Z');
    const w = makeWorld({ audit: { kind: 'ok', text }, compaction: comp(1) });
    const j = doc((await run(w)).out);
    expect(j.transitions.count).toBe(1);
    expect(j.observed).toEqual({ from: '2026-11-10', to: '2026-11-10', lines: 1 });
    const plain = doc((await run(makeWorld({ audit: { kind: 'ok', text } }))).out);
    expect(plain.transitions.count).toBe(2);
  });

  it('区间起点不晚于 W → request_before_observed=true(明细已并入月汇总,精度 = 月);起点晚于 W 且不早于已观察起点 → false', async () => {
    const text = row('2026-11-10T00:00:00.000Z');
    const w = makeWorld({ audit: { kind: 'ok', text }, compaction: comp(1) });
    expect(
      doc((await run(w, { from: '2026-10-31', to: '2026-11-13' })).out).request_before_observed,
    ).toBe(true);
    expect(
      doc((await run(w, { from: '2026-11-10', to: '2026-11-13' })).out).request_before_observed,
    ).toBe(false);
    // 审计里没有 W 之后的行(observed = null)时,只有水位线口径能给出该标志:起点 = W(含边界)→ true;起点晚于 W 一天 → false
    const emptyAfter = makeWorld({ audit: { kind: 'ok', text: '' }, compaction: comp(1) });
    const flagFor = async (from: string): Promise<[number, boolean | undefined, unknown]> => {
      const r = await run(emptyAfter, { from, to: '2026-11-13' });
      const j = doc(r.out);
      return [r.code, j.request_before_observed, j.observed];
    };
    expect(await flagFor('2026-10-31')).toEqual([0, true, null]);
    expect(await flagFor('2026-10-01')).toEqual([0, true, null]);
    expect(await flagFor('2026-11-01')).toEqual([0, false, null]);
  });

  it('report_empty_after_compaction_exit0:W 非空时审计为空 / 缺失 = 退 0(不因「账显示曾有转移」误退 3);无压缩文件的同一情形仍退 3', async () => {
    for (const audit of [{ kind: 'absent' }, { kind: 'ok', text: '' }] as RawRead[]) {
      const w = makeWorld({ audit, compaction: comp(1), prior: true });
      const r = await run(w);
      expect(r.code).toBe(0);
      const j = doc(r.out);
      expect([j.observed, j.request_before_observed]).toEqual([null, true]);
      const noCompaction = await run(makeWorld({ audit, prior: true }));
      expect(noCompaction.code).toBe(3);
    }
  });

  it('只剩残留行(全部 ≤ W)= 视同空审计:退 0,observed = null', async () => {
    const w = makeWorld({
      audit: { kind: 'ok', text: row('2026-10-20T00:00:00.000Z') },
      compaction: comp(1),
      prior: true,
    });
    const r = await run(w);
    expect(r.code).toBe(0);
    expect(doc(r.out).observed).toBeNull();
  });

  it('JSON 键集合不因压缩而变(不另加字段)', async () => {
    const w = makeWorld({
      audit: { kind: 'ok', text: row('2026-11-10T00:00:00.000Z') },
      compaction: comp(1),
    });
    const a = Object.keys(JSON.parse((await run(w)).out) as object).sort();
    const b = Object.keys(
      JSON.parse(
        (await run(makeWorld({ audit: { kind: 'ok', text: row('2026-11-10T00:00:00.000Z') } })))
          .out,
      ) as object,
    ).sort();
    expect(a).toEqual(b);
  });
});

describe('gen 双读', () => {
  it('每轮读序 = 压缩 → 审计 → 压缩(一致时压缩读 2 次、审计读 1 次)', async () => {
    const order: string[] = [];
    const w = makeWorld({
      audit: { kind: 'ok', text: row('2026-11-10T00:00:00.000Z') },
      compaction: comp(1),
    });
    const ports = portsOf(w);
    const spy = {
      ...ports,
      compaction: async () => {
        order.push('c');
        return ports.compaction();
      },
      audit: async () => {
        order.push('a');
        return ports.audit();
      },
    };
    const sink = makeSink();
    expect(await runReport(spy, { json: true, range: RANGE, forbidden: [] }, sink)).toBe(0);
    expect(order).toEqual(['c', 'a', 'c']);
  });

  it('report_second_read_fails_not_fallback:第二次读不出 / 不合规 / 不受支持 → 退 3 audit_invalid 并带 cause,不回退第一次的结果', async () => {
    const text = row('2026-11-10T00:00:00.000Z');
    const cases: [RawRead, string][] = [
      [{ kind: 'unreadable' }, 'compaction_unreadable'],
      [{ kind: 'ok', text: '{not json' }, 'compaction_unsupported'],
      [comp(2, '2026-10-31', { schema_version: 2 }), 'compaction_unsupported'],
      [comp(2, '2026-11-13'), 'compaction_unsupported'], // through ≥ 今日
    ];
    for (const [second, cause] of cases) {
      const w = makeWorld({
        audit: { kind: 'ok', text },
        compactionAt: (n) => (n === 1 ? comp(1) : second),
      });
      const r = await run(w);
      expect([r.code, r.out, r.err]).toEqual([
        3,
        `cause=${cause}\n`,
        'RSI_FAIL_CLOSED reason=audit_invalid\n',
      ]);
    }
    // 只有第 2 次读(同一轮的第二次)失败、之后的读都成功:若实现吞掉第二次失败就会进入下一轮并成功(退 0)。必须在第 2 次读就退 3,且不再读第 3 次
    for (const [second, cause] of cases) {
      const w = makeWorld({
        audit: { kind: 'ok', text },
        compactionAt: (n) => (n === 2 ? second : comp(1)),
      });
      const r = await run(w);
      expect([r.code, r.out, r.err]).toEqual([
        3,
        `cause=${cause}\n`,
        'RSI_FAIL_CLOSED reason=audit_invalid\n',
      ]);
      expect(w.compactionReads).toBe(2);
    }
    // 对照:第二次读与第一次一致 → 成功
    const ok = makeWorld({ audit: { kind: 'ok', text }, compactionAt: () => comp(1) });
    expect((await run(ok)).code).toBe(0);
  });

  it('第一次读就失败 = 同样退 3(即使第二次读成功也不继续;不读审计)', async () => {
    const w = makeWorld({
      audit: { kind: 'ok', text: row('2026-11-10T00:00:00.000Z') },
      compactionAt: (n) => (n === 1 ? { kind: 'unreadable' } : comp(1)),
    });
    const r = await run(w);
    expect([r.code, r.out]).toEqual([3, 'cause=compaction_unreadable\n']);
  });

  it('report_compaction_vanished_between_reads_exit3:第一次存在(gen ≥ 1)、第二次缺失 = 退 3 compaction_vanished;两次都缺失 = 合法(虚拟 gen 0)', async () => {
    const text = row('2026-11-10T00:00:00.000Z');
    const w = makeWorld({
      audit: { kind: 'ok', text },
      compactionAt: (n) => (n === 1 ? comp(3) : { kind: 'absent' }),
    });
    const r = await run(w);
    expect([r.code, r.out, r.err]).toEqual([
      3,
      'cause=compaction_vanished\n',
      'RSI_FAIL_CLOSED reason=audit_invalid\n',
    ]);
    expect((await run(makeWorld({ audit: { kind: 'ok', text } }))).code).toBe(0);
  });

  it('report_cross_generation_retry:两次 gen 不同 → 重试;稳定后返回第二轮的快照(水位线取稳定那一轮)', async () => {
    const text = row('2026-10-20T00:00:00.000Z') + row('2026-11-10T00:00:00.000Z');
    const w = makeWorld({
      audit: { kind: 'ok', text },
      compactionAt: (n) => (n === 1 ? { kind: 'absent' } : comp(1)),
    });
    const r = await run(w);
    expect(r.code).toBe(0);
    expect(doc(r.out).transitions.count).toBe(1); // 第一轮(无水位线)被丢弃,不返回部分结果
    expect(w.compactionReads).toBe(4);
  });

  it('report_retry_exhausted_exit4:3 轮都不稳定 → 退 4 RSI_SNAPSHOT_BUSY,stdout 为空(无部分结果);第 3 轮才稳定则成功', async () => {
    const text = row('2026-11-10T00:00:00.000Z');
    const busy = makeWorld({ audit: { kind: 'ok', text }, compactionAt: (n) => comp(n) });
    const r = await run(busy);
    expect([r.code, r.out, r.err]).toEqual([4, '', `${RSI_SNAPSHOT_BUSY}\n`]);
    expect(busy.compactionReads).toBe(6);
    const third = makeWorld({
      audit: { kind: 'ok', text },
      compactionAt: (n) => (n <= 4 ? comp(n) : comp(100)),
    });
    const ok = await run(third);
    expect(ok.code).toBe(0);
    expect(third.compactionReads).toBe(6);
  });
});
