/**
 * 干跑(W8a):`rsi auto clear`(无 --write)与 `rsi rollback --to <日期>`(无 --write)——自己枚举(不经写出口),候选来自 `head.json` 记录的提交,
 * 内容验证双读协议;`rollback --to` 的选取规则(严格大于、日期不可知单列、记录矛盾 fail-closed)、`[rsi]` 关闭退 4、参数先于读取。
 */
import { describe, expect, it } from 'vitest';
import { runClearDry } from '../../../src/rsi/auto/read/clear-dry.js';
import { parseRollbackToArgs, runRollbackDry } from '../../../src/rsi/auto/read/rollback-dry.js';
import { journalNameOf } from '../../../src/rsi/auto/read/stall.js';
import { parseUtcDate, selectRollbackTo } from '../../../src/rsi/auto/select-rollback.js';
import { entry, rec } from '../personal/transition-fixture.js';
import {
  HEAD,
  makeSink,
  makeWorld,
  portsOf,
  recordFile,
  setCommit,
  type World,
} from './auto-fixture.js';

const A = 'ra_aaaaaaaaaaaa';
const B = 'ra_bbbbbbbbbbbb';
const C = 'ra_cccccccccccc';
const D = 'ra_dddddddddddd';
const canaryOn = (id: string, at: string, over = {}) =>
  rec('canary', { id, transitions: [entry(1), entry(2, 'canary', at)], ...over });

function withRecords(recs: ReturnType<typeof rec>[]): World {
  const w = makeWorld();
  setCommit(
    w,
    HEAD,
    Object.assign({}, ...recs.map((r) => recordFile(r))) as Record<string, string>,
  );
  return w;
}

async function clearDry(w: World, json = false) {
  const sink = makeSink();
  const code = await runClearDry(portsOf(w), { json, forbidden: [] }, sink);
  return { code, ...sink.text() };
}
async function rollbackDry(w: World, argv: string[]) {
  const sink = makeSink();
  const code = await runRollbackDry(portsOf(w), argv, { forbidden: [] }, sink);
  return { code, ...sink.text() };
}

describe('select-rollback(纯函数):严格大于 / 日期不可知 / 矛盾记录', () => {
  const recs = [
    canaryOn(A, '2026-11-05T00:00:00.000Z'),
    canaryOn(B, '2026-11-01T23:59:59.000Z'),
    canaryOn(C, '2026-11-01T00:00:00.000Z'),
  ];
  it('候选「进入 canary 的 UTC 日」> D(不含当日):D = 进入日 → 不含;D = 前一天 → 含;差一天的两侧都钉住', () => {
    const ids = (d: string) => selectRollbackTo(recs, d).candidates.map((c) => c.id);
    expect(ids('2026-11-01')).toEqual([A]);
    expect(ids('2026-10-31')).toEqual([A, B, C]);
    expect(ids('2026-11-04')).toEqual([A]);
    expect(ids('2026-11-05')).toEqual([]);
  });

  it('按生效逆序:进入 canary 晚者在前,同刻按 id', () => {
    const out = selectRollbackTo(recs, '2026-10-01').candidates.map((c) => c.id);
    expect(out).toEqual([A, B, C]);
    const same = [canaryOn(B, '2026-11-02T00:00:00.000Z'), canaryOn(A, '2026-11-02T00:00:00.000Z')];
    expect(selectRollbackTo(same, '2026-10-01').candidates.map((c) => c.id)).toEqual([A, B]);
  });

  it('带时区偏移的时间先换算成 UTC 日再比较', () => {
    const r = canaryOn(A, '2026-11-02T01:00:00+08:00'); // UTC 11-01 17:00
    expect(selectRollbackTo([r], '2026-11-01').candidates).toEqual([]);
    expect(selectRollbackTo([r], '2026-10-31').candidates.map((c) => c.id)).toEqual([A]);
  });

  it('日期不可知(transitions_dropped>0 且无进入 canary 的记录)→ 单列纳入,不进主列表;dropped=0 而缺记录 → invalid(不静默排除)', () => {
    const unknown = rec('canary', { id: D, transitions: [entry(1)], transitions_dropped: 3 });
    const bad = rec('canary', { id: B, transitions: [entry(1)], transitions_dropped: 0 });
    const s = selectRollbackTo(
      [unknown, bad, canaryOn(A, '2026-11-05T00:00:00.000Z')],
      '2026-11-01',
    );
    expect(s.candidates.map((c) => c.id)).toEqual([A]);
    expect(s.dateUnknown.map((c) => c.id)).toEqual([D]);
    expect(s.invalid).toEqual([B]);
  });

  it('只纳入进入过 canary 的非终态候选:shadow / 终态不纳入;已在 rolling_back 的在途候选纳入', () => {
    const s = selectRollbackTo(
      [
        rec('shadow', { id: A }),
        rec('rolled_back', {
          id: B,
          transitions: [entry(1), entry(2, 'canary', '2026-11-05T00:00:00.000Z')],
        }),
        rec('rolling_back', { id: C }),
      ],
      '2026-10-01',
    );
    expect(s.candidates.map((c) => c.id)).toEqual([C]);
  });

  it('rolling_back 可由从未进入 canary 的候选进入:完整历史(dropped=0)里没有进入记录 = 不在范围,不是 invalid;历史被截断则仍按日期不可知纳入', () => {
    const fromShadow = rec('rolling_back', {
      id: A,
      transitions: [entry(1)],
      transitions_dropped: 0,
    });
    const truncated = rec('rolling_back', {
      id: B,
      transitions: [entry(1)],
      transitions_dropped: 4,
    });
    const s = selectRollbackTo([fromShadow, truncated], '2026-10-01');
    expect(s.invalid).toEqual([]);
    expect(s.candidates).toEqual([]);
    expect(s.dateUnknown.map((c) => c.id)).toEqual([B]);
  });

  it('parseUtcDate:只接受真实日历日的 YYYY-MM-DD', () => {
    expect(parseUtcDate('2026-02-28')).toBe('2026-02-28');
    for (const bad of [
      '2026-02-30',
      '2026-13-01',
      '2026-1-1',
      '20261101',
      '2026-11-01T00:00',
      '',
      ' 2026-11-01',
    ]) {
      expect(parseUtcDate(bad), bad).toBeNull();
    }
  });
});

describe('rsi rollback --to 干跑', () => {
  it('参数先于任何读取:缺 --to / 坏日期 → 2 bad_date;未知参数 → 2 unknown_arg', async () => {
    const w = withRecords([]);
    for (const [argv, reason] of [
      [[], 'bad_date'],
      [['--to'], 'bad_date'],
      [['--to', '2026-02-30'], 'bad_date'],
      [['--to', '2026-11-01', '--bogus'], 'unknown_arg'],
      [['--to', '2026-11-01', '--to', '2026-11-02'], 'unknown_arg'],
    ] as [string[], string][]) {
      const r = await rollbackDry(w, argv);
      expect([r.code, r.err], argv.join(' ')).toEqual([2, `RSI_USAGE reason=${reason}\n`]);
    }
    expect(w.calls.head + w.calls.config).toBe(0);
    expect(parseRollbackToArgs(['--json', '--to', '2026-11-01'])).toEqual({
      ok: true,
      date: '2026-11-01',
      json: true,
    });
  });

  it('[rsi] 关闭 → 退 4 RSI_NOT_RUN reason=off,提示改用 rsi auto clear;不是 0', async () => {
    const w = withRecords([canaryOn(A, '2026-11-05T00:00:00.000Z')]);
    w.cfg = { rsiOn: false, enabled: false, profile: 'medium' };
    const r = await rollbackDry(w, ['--to', '2026-11-01']);
    expect([r.code, r.err]).toEqual([4, 'RSI_NOT_RUN reason=off\n']);
    expect(r.out).toContain('rsi auto clear');
    expect(w.calls.head).toBe(0);
  });

  it('文本:主列表与「日期不可知,按保守方向纳入」单列一节,计数分开;json 的 date_unknown[] 同样单列', async () => {
    const w = withRecords([
      canaryOn(A, '2026-11-05T00:00:00.000Z'),
      rec('canary', { id: D, transitions: [entry(1)], transitions_dropped: 2 }),
    ]);
    const t = await rollbackDry(w, ['--to', '2026-11-01']);
    expect(t.code).toBe(0);
    expect(t.out).toContain('将按生效逆序回滚 2026-11-01 之后(严格大于)进入 canary 的 1 个候选');
    expect(t.out).toContain('日期不可知,按保守方向纳入: 1');
    expect(t.out).toContain(`id=${A} lifecycle=canary entered_on=2026-11-05`);
    expect(t.out).toContain(`id=${D} lifecycle=canary entered_on=unknown`);
    expect(t.out).toContain('consistency=double-read');
    const j = JSON.parse((await rollbackDry(w, ['--json', '--to', '2026-11-01'])).out) as {
      candidates: { id: string }[];
      date_unknown: { id: string }[];
      write: boolean;
    };
    expect(j.candidates.map((c) => c.id)).toEqual([A]);
    expect(j.date_unknown.map((c) => c.id)).toEqual([D]);
    expect(j.write).toBe(false);
  });

  it('记录自相矛盾(dropped=0 而缺进入记录)→ 退 3 candidate_invalid;读失败 → 退 3;不稳定 → 退 4', async () => {
    const bad = withRecords([rec('canary', { id: B, transitions: [entry(1)] })]);
    expect((await rollbackDry(bad, ['--to', '2026-11-01'])).err).toBe(
      'RSI_FAIL_CLOSED reason=candidate_invalid\n',
    );
    const un = withRecords([]);
    un.recordedUnreadable = 'spawn_failed';
    expect((await rollbackDry(un, ['--to', '2026-11-01'])).code).toBe(3);
    const moving = withRecords([canaryOn(A, '2026-11-05T00:00:00.000Z')]);
    moving.hooks.after = (op, n) => {
      if (op === 'rev') moving.rev = { kind: 'ok', text: `r${n}` };
    };
    expect((await rollbackDry(moving, ['--to', '2026-11-01'])).err).toBe('RSI_SNAPSHOT_BUSY\n');
  });
});

describe('rsi auto clear 干跑', () => {
  it('只列非终态候选(终态不列);带 journal 三态;不依赖 [rsi](关闭时照常完成)', async () => {
    const w = withRecords([
      rec('shadow', { id: A }),
      rec('rolled_back', { id: B }),
      canaryOn(C, '2026-11-05T00:00:00.000Z'),
    ]);
    w.cfg = { rsiOn: false, enabled: false, profile: 'medium' };
    const r = await clearDry(w);
    expect(r.code).toBe(0);
    expect(r.out).toContain('将处理 2 个非终态候选(未写入任何东西;加 --write 才执行)');
    expect(r.out).toContain(`id=${A} lifecycle=shadow journal=absent`);
    expect(r.out).toContain(`id=${C} lifecycle=canary journal=absent`);
    expect(r.out).not.toContain(B);
    expect(r.out).toContain('consistency=double-read');
    expect(r.out).not.toContain('原子');
  });

  it('在途 journal 数来自事务目录;不合规 journal 标 journal=invalid 并提示按运行手册处置', async () => {
    const w = withRecords([canaryOn(C, '2026-11-05T00:00:00.000Z')]);
    const name = journalNameOf(C, 'a'.repeat(64));
    w.names = [name];
    w.journals[name] = { kind: 'ok', text: '{broken' };
    const r = await clearDry(w);
    expect(r.out).toContain('in_flight_journals: 1');
    expect(r.out).toContain(`id=${C} lifecycle=canary journal=invalid`);
    expect(r.out).toContain('按运行手册处置');
  });

  it('head.json 不存在 → 没有候选(退 0);适配器未装配 / 读失败 → 退 3 personal_repo_invalid,不当成「没有候选」', async () => {
    const empty = await clearDry(makeWorld());
    expect(empty.code).toBe(0);
    expect(empty.out).toContain('将处理 0 个非终态候选');
    expect(empty.out).toContain('record=absent');
    const w = withRecords([rec('shadow', { id: A })]);
    w.recordedUnreadable = 'not_wired';
    const r = await clearDry(w);
    expect([r.code, r.err]).toEqual([3, 'RSI_FAIL_CLOSED reason=personal_repo_invalid\n']);
  });

  it('--json 形状固定:write=false、candidates[]、in_flight、record、consistency', async () => {
    const w = withRecords([rec('shadow', { id: A })]);
    const j = JSON.parse((await clearDry(w, true)).out) as Record<string, unknown>;
    expect(Object.keys(j).sort()).toEqual(
      ['candidates', 'consistency', 'in_flight', 'record', 'write'].sort(),
    );
    expect(j['write']).toBe(false);
    expect(j['record']).toBe('0123456789ab');
  });

  it('不稳定(在两次读之间 head 被推进)→ 退 4 RSI_SNAPSHOT_BUSY', async () => {
    const w = withRecords([rec('shadow', { id: A })]);
    w.hooks.after = (op, n) => {
      if (op === 'head') {
        w.head = {
          kind: 'ok',
          text: JSON.stringify({
            schema_version: 1,
            head: HEAD,
            owner_repo_fp: n.toString(16).padStart(16, '0'),
          }),
        };
      }
    };
    const r = await clearDry(w);
    expect([r.code, r.err]).toEqual([4, 'RSI_SNAPSHOT_BUSY\n']);
  });
});
