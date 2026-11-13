/**
 * `rsi auto status`(W8a;contracts R21-12.1 / R21-13.1、§21.24 W0-22 第 7 条):物化视图的缺失 / 陈旧 / 损坏语义、停住候选三态、`paused` 判据、存在性弱协议、键集合。
 * 处理函数直接以注入的相位 / 时钟 / 端口被调用(相位 0 下经 `main()` 只会走到桩)。
 */
import { describe, expect, it } from 'vitest';
import { runAutoStatus, computeAutoStatus } from '../../../src/rsi/auto/read/status.js';
import { journalNameOf } from '../../../src/rsi/auto/read/stall.js';
import { interpretView } from '../../../src/rsi/auto/read/view-read.js';
import { ID, NOW, SHA, makeSink, makeWorld, portsOf, rawView, viewOf } from './auto-fixture.js';

const rb = (over: Partial<ReturnType<typeof viewOf>['rolling_back'][number]> = {}) => ({
  id: ID,
  content_sha256: SHA,
  origin_reason: 'harm_c1',
  target_terminal: 'rolled_back' as const,
  entered_at: new Date(NOW.getTime() - 61 * 60_000).toISOString(),
  ...over,
});

async function run(
  w: ReturnType<typeof makeWorld>,
  o: { json?: boolean; phase?: number; forbidden?: string[] } = {},
) {
  const sink = makeSink();
  const code = await runAutoStatus(
    portsOf(w),
    { json: o.json ?? true, phase: o.phase ?? 1, forbidden: o.forbidden ?? [] },
    sink,
  );
  return { code, ...sink.text() };
}

const docOf = async (w: ReturnType<typeof makeWorld>, phase = 1) => {
  const r = await computeAutoStatus(portsOf(w), phase);
  if (r.kind !== 'ok') throw new Error('state_invalid');
  return r.doc;
};

describe('视图语义(interpretView):缺失 / 损坏 / 陈旧', () => {
  it('缺失 → missing;读不出 / 非 JSON / 不合 schema → corrupt;不会显示成全零', () => {
    expect(interpretView({ kind: 'absent' }, NOW).state).toBe('missing');
    expect(interpretView({ kind: 'unreadable' }, NOW).state).toBe('corrupt');
    expect(interpretView({ kind: 'ok', text: '{not json' }, NOW).state).toBe('corrupt');
    expect(interpretView({ kind: 'ok', text: '{}' }, NOW).state).toBe('corrupt');
    const bad = { ...viewOf(), extra_key: 1 };
    expect(interpretView(rawView(JSON.stringify(bad)), NOW).state).toBe('corrupt');
  });

  it('陈旧阈值 48 小时:恰好 48h 仍 fresh,多 1 毫秒即 stale;as_of 在未来超出时钟容差 → corrupt', () => {
    const at = (ms: number) =>
      rawView(viewOf({ as_of: new Date(NOW.getTime() - ms).toISOString() }));
    expect(interpretView(at(48 * 3_600_000), NOW).state).toBe('fresh');
    expect(interpretView(at(48 * 3_600_000 + 1000), NOW).state).toBe('stale');
    expect(interpretView(at(-60 * 60_000), NOW).state).toBe('corrupt');
  });
});

describe('键集合与文本 / JSON 形状', () => {
  it('--json:顶层键与 auto 下的键集合固定;缺失视图时派生键为 null,退 0', async () => {
    const w = makeWorld();
    const r = await run(w);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as Record<string, Record<string, unknown> | null>;
    expect(Object.keys(j).sort()).toEqual(
      ['auto', 'budget', 'canary', 'cost', 'last_rollback', 'pipeline'].sort(),
    );
    expect(Object.keys(j['auto'] as object).sort()).toEqual(
      [
        'enabled',
        'phase',
        'paused',
        'pause_reasons',
        'diverged',
        'profile',
        'profile_effective',
        'view_state',
        'as_of',
        'record_oid12',
        'rollback_stalled',
        'protection_marks',
        'breaker_marker',
      ].sort(),
    );
    const a = j['auto'] as Record<string, unknown>;
    expect(a['view_state']).toBe('missing');
    expect([a['as_of'], a['record_oid12'], a['rollback_stalled'], a['protection_marks']]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect([j['pipeline'], j['budget'], j['cost'], j['canary'], j['last_rollback']]).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it('损坏的视图:退 0,view_state=corrupt,派生键为 null(不是零)', async () => {
    const w = makeWorld({ view: { kind: 'ok', text: '{broken' } });
    const r = await run(w);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as { auto: { view_state: string }; pipeline: unknown };
    expect(j.auto.view_state).toBe('corrupt');
    expect(j.pipeline).toBeNull();
  });

  it('新鲜视图:数据照出,record_oid12 取前 12 位;文本模式不含路径', async () => {
    const w = makeWorld({ view: rawView(viewOf()) });
    const j = await docOf(w);
    expect(j.auto.view_state).toBe('fresh');
    expect(j.auto.record_oid12).toBe('0123456789ab');
    expect(j.pipeline?.states).toEqual({ shadow: 1 });
    const t = await run(w, { json: false });
    expect(t.code).toBe(0);
    expect(t.out).toContain('view: state=fresh');
    expect(t.out).toContain('pipeline: shadow=1');
  });

  it('profile_effective:相位 < V3 恒为 lite,相位 ≥ V3 取配置值', async () => {
    const w = makeWorld({ cfg: { rsiOn: true, enabled: true, profile: 'heavy' } });
    expect((await docOf(w, 1)).auto.profile_effective).toBe('lite');
    expect((await docOf(w, 5)).auto.profile_effective).toBe('heavy');
  });
});

describe('paused 判据与 breaker_marker', () => {
  it('state.json 过不了 schema → 退 3 state_invalid;stdout 为空', async () => {
    const r = await run(makeWorld({ state: { kind: 'invalid' } }));
    expect([r.code, r.out, r.err]).toEqual([3, '', 'RSI_FAIL_CLOSED reason=state_invalid\n']);
  });

  it('用户标记 U 存在 → paused,pause_reasons 含 user_paused;U 与熔断码互不替代', async () => {
    const w = makeWorld({ markers: { user: 'present', breaker: 'absent' } });
    const d = await docOf(w);
    expect(d.auto.paused).toBe(true);
    expect(d.auto.pause_reasons).toEqual(['user_paused']);
    expect(d.auto.breaker_marker).toBe('absent');
  });

  it('B 在而状态无熔断码 → paused 且 breaker_marker=pending;B 在且有码 → breaker_marker=absent', async () => {
    const w = makeWorld({ markers: { user: 'absent', breaker: 'present' } });
    const d = await docOf(w);
    expect([d.auto.paused, d.auto.breaker_marker, d.auto.pause_reasons]).toEqual([
      true,
      'pending',
      [],
    ]);
    w.state = {
      kind: 'ok',
      autoPause: { reasons: ['rollback_storm'], diverged: false, ownerChanged: false },
    };
    const d2 = await docOf(w);
    expect([d2.auto.paused, d2.auto.breaker_marker, d2.auto.pause_reasons]).toEqual([
      true,
      'absent',
      ['rollback_storm'],
    ]);
  });

  it('diverged / owner_changed 各自单独就使 paused 为真;全部为空则为 false', async () => {
    const mk = (diverged: boolean, ownerChanged: boolean) =>
      makeWorld({ state: { kind: 'ok', autoPause: { reasons: [], diverged, ownerChanged } } });
    expect((await docOf(mk(true, false))).auto.paused).toBe(true);
    expect((await docOf(mk(false, true))).auto.paused).toBe(true);
    expect((await docOf(mk(false, false))).auto.paused).toBe(false);
    expect((await docOf(mk(true, false))).auto.diverged).toBe(true);
  });
});

describe('停住候选三态(视图 fresh)', () => {
  const stalledOf = async (w: ReturnType<typeof makeWorld>) =>
    (await docOf(w)).auto.rollback_stalled;

  it('不可重建类 + 超过 60 分钟宽限 + 无 journal → stalled;宽限内 → pending(60 分钟整仍 pending)', async () => {
    const mk = (min: number) =>
      makeWorld({
        view: rawView(
          viewOf({
            rolling_back: [
              rb({ entered_at: new Date(NOW.getTime() - min * 60_000).toISOString() }),
            ],
          }),
        ),
      });
    expect(await stalledOf(mk(61))).toEqual([
      { id: ID, stall: 'event_required', state: 'stalled' },
    ]);
    expect((await stalledOf(mk(60)))?.[0]?.state).toBe('pending');
    expect((await stalledOf(mk(5)))?.[0]?.state).toBe('pending');
  });

  it('可重建类原因(cleared)即使超时也不是 stalled(worker 会补 journal)', async () => {
    const w = makeWorld({
      view: rawView(viewOf({ rolling_back: [rb({ origin_reason: 'cleared' })] })),
    });
    expect(await stalledOf(w)).toEqual([{ id: ID, stall: 'recoverable', state: 'pending' }]);
  });

  it('harm_* / judge_* / limit_reached 都按不可重建类', async () => {
    for (const origin_reason of ['harm_c3', 'judge_reject', 'limit_reached']) {
      const w = makeWorld({ view: rawView(viewOf({ rolling_back: [rb({ origin_reason })] })) });
      expect((await stalledOf(w))?.[0]?.state, origin_reason).toBe('stalled');
    }
  });

  it('该候选已有 journal(按 (id, sha) 现算的 txn 名)→ 不列入;同 id 不同 sha 的 journal 不算', async () => {
    const w = makeWorld({ view: rawView(viewOf({ rolling_back: [rb()] })) });
    w.names = [journalNameOf(ID, SHA)];
    expect(await stalledOf(w)).toEqual([]);
    w.names = [journalNameOf(ID, 'b'.repeat(64))];
    expect((await stalledOf(w))?.[0]?.state).toBe('stalled');
  });

  it('存在性双读之间事务目录变化 → unconfirmed:snapshot_moving(不重试、不退 4)', async () => {
    const w = makeWorld({ view: rawView(viewOf({ rolling_back: [rb()] })) });
    w.hooks.after = (op, n) => {
      if (op === 'names' && n === 1) w.names = [journalNameOf(ID, SHA)];
    };
    const d = await docOf(w);
    expect(d.auto.rollback_stalled?.[0]?.state).toBe('unconfirmed:snapshot_moving');
    expect(w.calls.names).toBe(2);
    const r = await run(w);
    expect(r.code).toBe(0);
  });

  it('撤销凭据在双读之间变化同样 → snapshot_moving;事务目录读不出 → unconfirmed:txn_unreadable', async () => {
    const w = makeWorld({ view: rawView(viewOf({ rolling_back: [rb()] })) });
    w.hooks.after = (op, n) => {
      if (op === 'rev' && n === 1) w.rev = { kind: 'ok', text: 'x' };
    };
    expect((await stalledOf(w))?.[0]?.state).toBe('unconfirmed:snapshot_moving');
    const u = makeWorld({
      view: rawView(viewOf({ rolling_back: [rb()] })),
      namesUnreadable: true,
    });
    expect((await stalledOf(u))?.[0]?.state).toBe('unconfirmed:txn_unreadable');
  });

  it('视图陈旧 → 全部 unconfirmed:view_stale,数据照出并带 as_of;缺失 / 损坏视图 → rollback_stalled 为 null', async () => {
    const stale = makeWorld({
      view: rawView(
        viewOf({
          as_of: new Date(NOW.getTime() - 49 * 3_600_000).toISOString(),
          rolling_back: [rb()],
        }),
      ),
    });
    const d = await docOf(stale);
    expect(d.auto.view_state).toBe('stale');
    expect(d.auto.as_of).not.toBeNull();
    expect(d.auto.rollback_stalled?.[0]?.state).toBe('unconfirmed:view_stale');
    expect(await stalledOf(makeWorld())).toBeNull();
  });

  it('保护标记候选单独列出(protection_marks),与 rollback_stalled 并列', async () => {
    const w = makeWorld({
      view: rawView(
        viewOf({
          protection_marks: [
            { id: ID, mark: 'protection_unclassified', at: '2026-11-12T00:00:00.000Z' },
          ],
        }),
      ),
    });
    expect((await docOf(w)).auto.protection_marks).toEqual([
      { id: ID, mark: 'protection_unclassified', at: '2026-11-12T00:00:00.000Z' },
    ]);
    const t = await run(w, { json: false });
    expect(t.out).toContain(`id=${ID} mark=protection_unclassified`);
  });
});

describe('status 不跑 git、不解析 journal 内容(弱协议)', () => {
  it('完整运行后:受限只读 git 端口与 journal 内容读取的调用次数都是 0', async () => {
    const w = makeWorld({ view: rawView(viewOf({ rolling_back: [rb()] })) });
    await run(w);
    await run(w, { json: false });
    expect([w.calls.commit, w.calls.tree, w.calls.blob, w.calls.journal, w.calls.head]).toEqual([
      0, 0, 0, 0, 0,
    ]);
  });
});

describe('停住候选的人工处置文案', () => {
  it('stalled 时给出固定处置;明说「不会自动恢复」;不含「删除即可」,不宣称会自动恢复,不写「完成后 resume」', async () => {
    const w = makeWorld({ view: rawView(viewOf({ rolling_back: [rb()] })) });
    const t = (await run(w, { json: false })).out;
    expect(t).toContain('state=stalled');
    expect(t).toContain('按视图 as_of=');
    expect(t).toContain('不会自动恢复');
    expect(t).toContain('rsi auto pause');
    expect(t).toContain('rsi auto clear --write');
    expect(t).toContain('rsi veto <id>');
    expect(t).not.toContain('删除即可');
    expect(t).not.toMatch(/(?<!不)会自动恢复/);
    expect(t).not.toContain('完成后 resume');
  });
});

describe('泄漏闸', () => {
  it('输出里出现禁止值 → 退 3 output_leak,stdout 一个字节都不写', async () => {
    const w = makeWorld({ view: rawView(viewOf({ rolling_back: [rb()] })) });
    const r = await run(w, { json: true, forbidden: [ID] });
    expect([r.code, r.out, r.err]).toEqual([3, '', 'RSI_FAIL_CLOSED reason=output_leak\n']);
  });
});
