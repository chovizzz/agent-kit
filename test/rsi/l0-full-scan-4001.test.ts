/**
 * R20-A2 B4c2:4001 个会话文件的全量扫描覆盖(R20-6.9 epoch 续跑):每次 tick 至多读 2000 个文件,三次提交(2000 / 2000 / 1)后 done,
 * 每个文件在这个 epoch 里恰好读一次,所有信号都入库且不重复;done 之后再跑什么都不读。
 */
import { describe, expect, it } from 'vitest';
import type { TraceReader } from '../../src/contracts/reader.js';
import { RsiCountsSchema, RsiCursorSchema } from '../../src/contracts/rsi.js';
import { createClaudeReader } from '../../src/readers/claude/index.js';
import { claudeLine, jl, put, uuid } from './l0-fixture.js';
import { inputOf, makeRunFx, rsiFile, runL0 } from './l0-run-fixture.js';

describe('4001 文件全量扫描', () => {
  it('2000 / 2000 / 1 三次提交后 done;每个文件一个 epoch 只读一次;信号 4001 条不重复;之后不再读', async () => {
    const fx = await makeRunFx('l0scan-');
    const proj = await fx.work('big');
    const TOTAL = 4001;
    for (let i = 1; i <= TOTAL; i++) {
      await put(
        fx.s.f,
        'claude',
        `p/${uuid(i)}.jsonl`,
        jl(claudeLine(proj, { timestamp: '2026-10-01T00:00:00.000Z' })),
      );
    }
    const reads = new Map<string, number>();
    const base = createClaudeReader();
    const counting: TraceReader = {
      agent: base.agent,
      discover: (src) => base.discover(src),
      read: (r, o) => {
        reads.set(r.path, (reads.get(r.path) ?? 0) + 1);
        return base.read(r, o);
      },
    };
    const deps = { readers: { claude: counting } };

    const t1 = await runL0(fx, inputOf(), deps);
    expect(t1.summary).toMatchObject({
      files_planned: 2000,
      files_read: 2000,
      outcome: 'ok_partial',
    });
    expect(t1.summary.limits_hit).toContain('RSI_LIMIT_FILES');
    expect(t1.summary.cursor.full_scan).toEqual({ epoch: 1, done: false });
    const t2 = await runL0(fx, inputOf(), deps);
    expect(t2.summary).toMatchObject({ files_planned: 2000, files_read: 2000 });
    expect(t2.summary.cursor.full_scan).toEqual({ epoch: 1, done: false });
    const t3 = await runL0(fx, inputOf(), deps);
    expect(t3.summary).toMatchObject({ files_planned: 1, files_read: 1, outcome: 'ok' });
    expect(t3.summary.cursor.full_scan).toEqual({ epoch: 1, done: true });
    expect(t1.signalsNew + t2.signalsNew + t3.signalsNew).toBe(TOTAL);

    expect(reads.size).toBe(TOTAL); // 每个文件都被读过
    expect([...reads.values()].every((n) => n === 1)).toBe(true); // 且只读一次
    const cursor = RsiCursorSchema.parse(await rsiFile(fx.s, 'cursor.json'));
    expect(Object.keys(cursor.files)).toHaveLength(TOTAL);
    expect(Object.values(cursor.files).every((e) => e.epoch === 1 && e.status === 'ok')).toBe(true);
    const counts = RsiCountsSchema.parse(await rsiFile(fx.s, 'counts.json'));
    expect(Object.values(counts.per_key)).toHaveLength(1);
    expect(Object.values(counts.per_key)[0]).toMatchObject({
      signals_total: TOTAL,
      sessions: TOTAL,
    });

    const t4 = await runL0(fx, inputOf(), deps);
    expect(t4.summary).toMatchObject({ files_planned: 0, files_read: 0 });
    expect(t4.summary.skipped.unchanged).toBe(TOTAL);
    expect(reads.size).toBe(TOTAL);
    expect([...reads.values()].every((n) => n === 1)).toBe(true);
  }, 300_000);
});
