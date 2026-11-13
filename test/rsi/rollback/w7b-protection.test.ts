/**
 * W7b ②「保留原保护」(owner 2026-11-12 决定 1):`originProtection` 四态、`terminalEffectsOf` 单一事实源(引擎尾部与 `effectsForTerminal` 同调)、
 * E1(veto 事件即时黑名单,键 `veto:`)/ E2(终态批次,键 `terminal:`)分层、`recoverTerminalEffects` 第二遍、保护审计标记落点与幂等。
 * 期望值手写,不由被测函数反推。
 */
import { describe, expect, it } from 'vitest';
import {
  RsiAuditLineSchema,
  type PersonalLifecycleRecord,
} from '../../../src/contracts/rsi-personal.js';
import {
  auditKeyOf,
  effectsForTerminal,
  recoverTerminalEffects,
  terminalEffectKey,
  terminalEffectsOf,
  vetoEffectKey,
} from '../../../src/rsi/personal/effects-recover.js';
import { resumeAll, startRollback } from '../../../src/rsi/personal/rollback.js';
import type {
  KeyedEffectResult,
  KeyedEffectSink,
} from '../../../src/rsi/personal/rollback-ports.js';
import { isRefusal, transition } from '../../../src/rsi/personal/transition.js';
import type { Transitioned } from '../../../src/rsi/personal/transition.js';
import { originProtection } from '../../../src/rsi/personal/transition-table.js';
import { CANARY_AT, ctxFor, entry, rec } from '../personal/transition-fixture.js';
import { ID, SHA, harmReq, recordOf, world7 } from './w7-fixture.js';

type Entry = PersonalLifecycleRecord['transitions'][number];
const e = (
  n: number,
  from: string,
  to: string,
  reason: string,
  at = '2026-11-02T00:00:00Z',
): Entry => ({
  dim: 'lifecycle',
  from,
  to,
  at,
  reason,
  idem_key: n.toString(16).padStart(16, '0'),
});
/** canary → rolling_back 的进入条目(起因 = reason) */
const enter = (reason: string, n = 10): Entry => e(n, 'canary', 'rolling_back', reason);
const loop = (reason: string, n = 11): Entry => e(n, 'rolling_back', 'rolling_back', reason);
const TERM_AT = '2026-11-03T00:00:00Z';
const BASE = [entry(1), entry(2, 'canary', CANARY_AT)];

/** 走过回滚的终态记录 */
function terminal(
  lifecycle: 'rolled_back' | 'expired',
  terminalReason: PersonalLifecycleRecord['terminal_reason'],
  rbReason: string,
  transitions: Entry[],
  dropped = 0,
): PersonalLifecycleRecord {
  return rec(lifecycle, {
    terminal_reason: terminalReason,
    rollback: {
      phase: 'rollback_complete',
      reason: rbReason,
      target_terminal: lifecycle === 'expired' ? 'expired' : 'rolled_back',
    },
    transitions,
    transitions_dropped: dropped,
  });
}
const doneEntry = (to: string): Entry => e(20, 'rolling_back', to, 'compensation_done', TERM_AT);
const types = (r: PersonalLifecycleRecord): string[] => terminalEffectsOf(r).map((x) => x.type);
const cooldowns = (r: PersonalLifecycleRecord) =>
  terminalEffectsOf(r).filter((x) => x.type === 'start_cooldown');
const markers = (r: PersonalLifecycleRecord) =>
  terminalEffectsOf(r).flatMap((x) => (x.type === 'append_audit' ? [x] : []));

describe('originProtection 四态', () => {
  it('rollback=null → not_applicable(即便 transitions 里有 rolling_back 条目:以 rollback 字段为准)', () => {
    expect(originProtection(rec('rejected'))).toEqual({ kind: 'not_applicable' });
    expect(
      originProtection(
        rec('rejected', { rollback: null, transitions: [...BASE, enter('harm_c1')] }),
      ),
    ).toEqual({ kind: 'not_applicable' });
  });
  it('known:取第一条进入回滚的条目(不是最后一条);自环条目不算;limit_reached → expired,其余 → rolled_back', () => {
    const r = terminal('rolled_back', 'vetoed', 'vetoed', [
      ...BASE,
      enter('harm_c1'),
      loop('vetoed'),
      doneEntry('rolled_back'),
    ]);
    expect(originProtection(r)).toEqual({
      kind: 'known',
      origin_reason: 'harm_c1',
      origin_target: 'rolled_back',
    });
    // 自环条目排在前面也不算进入条目
    const r2 = terminal('rolled_back', 'vetoed', 'vetoed', [
      ...BASE,
      loop('vetoed', 9),
      enter('limit_reached'),
      doneEntry('rolled_back'),
    ]);
    expect(originProtection(r2)).toEqual({
      kind: 'known',
      origin_reason: 'limit_reached',
      origin_target: 'expired',
    });
  });
  it('unknown_rollback_origin:rollback 非空、无进入条目、transitions_dropped > 0', () => {
    const r = terminal('rolled_back', 'cleared', 'cleared', [doneEntry('rolled_back')], 3);
    expect(originProtection(r)).toEqual({ kind: 'unknown_rollback_origin' });
  });
  it('unclassified:rollback 非空、无进入条目、dropped = 0(自相矛盾);只有自环条目也算无进入条目', () => {
    const r = terminal('rolled_back', 'cleared', 'cleared', [...BASE, doneEntry('rolled_back')]);
    expect(originProtection(r)).toEqual({ kind: 'unclassified' });
    const r2 = terminal('rolled_back', 'cleared', 'cleared', [...BASE, loop('cleared')]);
    expect(originProtection(r2)).toEqual({ kind: 'unclassified' });
  });
});

describe('冷却:原来发什么就发什么,并按起因保留原保护', () => {
  const full = (origin: string, final: PersonalLifecycleRecord['terminal_reason'], rb = origin) =>
    terminal('rolled_back', final, rb, [...BASE, enter(origin), doneEntry('rolled_back')]);

  it('harm 起因 → clear / veto / taint 终态:仍有 90 天 auto_rollback 冷却(原保护不因终态理由升级而丢)', () => {
    for (const [fin, rb] of [
      ['cleared', 'cleared'],
      ['vetoed', 'vetoed'],
      ['tainted', 'tainted'],
    ] as const) {
      for (const m of ['harm_c1', 'harm_c2', 'harm_c3', 'harm_c4', 'harm_c6']) {
        expect(cooldowns(full(m, fin, rb)), `${m}/${fin}`).toEqual([
          { type: 'start_cooldown', cluster_id: 'cluster-1', kind: 'auto_rollback', days: 90 },
        ]);
      }
    }
  });
  it('harm → veto:黑名单 + 墓碑 + 90 天,顺序固定', () => {
    expect(types(full('harm_c1', 'vetoed'))).toEqual([
      'blacklist_veto',
      'write_tombstone',
      'start_cooldown',
    ]);
  });
  it('limit_reached 起因 → clear:30 天 expired 冷却;limit_reached 终态(auto_expired)照旧 30 天', () => {
    expect(cooldowns(full('limit_reached', 'cleared'))).toEqual([
      { type: 'start_cooldown', cluster_id: 'cluster-1', kind: 'expired', days: 30 },
    ]);
    const exp = terminal('expired', 'auto_expired', 'limit_reached', [
      ...BASE,
      enter('limit_reached'),
      doneEntry('expired'),
    ]);
    expect(cooldowns(exp)).toHaveLength(1);
  });
  it('判定类起因(judge_reject / judge_injection)→ clear:不新增冷却;起因为 cleared / vetoed / tainted 也不多发', () => {
    for (const origin of ['judge_reject', 'judge_injection', 'cleared', 'vetoed', 'tainted']) {
      expect(cooldowns(full(origin, 'cleared')), origin).toEqual([]);
      expect(markers(full(origin, 'cleared')), origin).toEqual([]);
    }
  });
  it('没走过回滚的终态与改前逐字节相同:闸拒绝无冷却;shadow 到期 30 天;直接 clear / veto 无冷却无标记', () => {
    expect(types(rec('rejected'))).toEqual(['write_tombstone']);
    expect(cooldowns(rec('expired', { terminal_reason: 'auto_expired' }))).toHaveLength(1);
    expect(types(rec('rejected', { terminal_reason: 'cleared' }))).toEqual(['write_tombstone']);
    expect(types(rec('rejected', { terminal_reason: 'vetoed' }))).toEqual([
      'blacklist_veto',
      'write_tombstone',
    ]);
  });
  it('至多一条冷却(负向):limit_reached 进入回滚、补偿期间又收到 harm_c1(目标升为 rolled_back,终态事实给 90、起因给 30)→ 只发 90 天 auto_rollback', () => {
    const r = terminal('rolled_back', 'auto_rollback', 'harm_c1', [
      ...BASE,
      enter('limit_reached'),
      loop('harm_c1'),
      doneEntry('rolled_back'),
    ]);
    expect(cooldowns(r)).toEqual([
      { type: 'start_cooldown', cluster_id: 'cluster-1', kind: 'auto_rollback', days: 90 },
    ]);
  });
});

describe('截断 / 矛盾的记录:保守方向 90 天 + 审计标记(落点 = 既有 reconcile 行,无 schema 扩展)', () => {
  const unknownRec = (fin: 'cleared' | 'auto_rollback' = 'cleared') =>
    terminal(
      'rolled_back',
      fin,
      fin === 'cleared' ? 'cleared' : 'harm_c1',
      [doneEntry('rolled_back')],
      4,
    );
  const unclassifiedRec = () =>
    terminal('rolled_back', 'cleared', 'cleared', [...BASE, doneEntry('rolled_back')]);

  it('unknown_rollback_origin + clear:90 天 + protection_unknown;行可被既有 RsiAuditLineSchema 解析,at = 终态条目时间,不伪造 origin', () => {
    const r = unknownRec();
    expect(cooldowns(r)).toEqual([
      { type: 'start_cooldown', cluster_id: 'cluster-1', kind: 'auto_rollback', days: 90 },
    ]);
    const [m] = markers(r);
    expect(markers(r)).toHaveLength(1);
    expect(m?.line).toEqual({
      at: TERM_AT,
      kind: 'reconcile',
      id: ID,
      dim: 'lifecycle',
      from: 'rolling_back',
      to: 'rolled_back',
      reason: 'protection_unknown',
      counts: { cooldown_days: 90 },
    });
    expect(RsiAuditLineSchema.safeParse(m?.line).success).toBe(true);
    expect(m?.idem_key).toMatch(/^[0-9a-f]{16}$/);
    // 确定性:再算一次得同一行同一键
    expect(markers(r)).toEqual(markers(r));
  });
  it('unknown 但改前规则已给冷却(终态 auto_rollback):不变,不加标记', () => {
    const r = unknownRec('auto_rollback');
    expect(cooldowns(r)).toHaveLength(1);
    expect(markers(r)).toEqual([]);
  });
  it('unclassified + clear:90 天 + protection_unclassified(不是 protection_unknown);撤销 / 墓碑照常', () => {
    const r = unclassifiedRec();
    expect(types(r)).toEqual(['write_tombstone', 'start_cooldown', 'append_audit']);
    expect(cooldowns(r)).toHaveLength(1);
    expect(markers(r)[0]?.line).toMatchObject({ reason: 'protection_unclassified' });
    expect(markers(r)[0]?.idem_key).not.toBe(markers(unknownRec())[0]?.idem_key);
  });
  it('unclassified × 改前规则(无 / 30 天 expired / 90 天 auto_rollback):都恰好一条 90 天冷却 + 一条 protection_unclassified(不因 legacy 已有冷却而漏标记)', () => {
    const contradictory = [...BASE, doneEntry('rolled_back')];
    const cases = [
      terminal('rolled_back', 'cleared', 'cleared', contradictory),
      terminal('expired', 'auto_expired', 'limit_reached', [...BASE, doneEntry('expired')]),
      terminal('rolled_back', 'auto_rollback', 'harm_c1', contradictory),
    ];
    for (const r of cases) {
      expect(cooldowns(r), r.terminal_reason ?? '').toEqual([
        { type: 'start_cooldown', cluster_id: 'cluster-1', kind: 'auto_rollback', days: 90 },
      ]);
      expect(markers(r).map((m) => m.line.reason)).toEqual(['protection_unclassified']);
    }
  });
  it('known / not_applicable 永远没有标记', () => {
    expect(
      markers(
        terminal('rolled_back', 'cleared', 'cleared', [
          ...BASE,
          enter('harm_c1'),
          doneEntry('rolled_back'),
        ]),
      ),
    ).toEqual([]);
    expect(markers(rec('rejected'))).toEqual([]);
  });
});

describe('引擎尾部与 terminalEffectsOf 同源(逐项相等)', () => {
  const complete = (r: PersonalLifecycleRecord): Transitioned => {
    const out = transition(
      r,
      { kind: 'compensation_done', evidence: 'c', completion_met: true },
      ctxFor(r),
    );
    if (isRefusal(out)) throw new Error(`应成功:${JSON.stringify(out)}`);
    return out;
  };
  const rolling = (reason: string, transitions: Entry[]) =>
    rec('rolling_back', {
      rollback: { phase: 'rollback_complete', reason, target_terminal: 'rolled_back' },
      transitions,
    });
  const termPart = (x: Transitioned) =>
    x.effects.filter(
      (f) =>
        f.type !== 'commit_lifecycle' &&
        !(f.type === 'append_audit' && f.line.kind === 'transition'),
    );
  const cases: [string, PersonalLifecycleRecord][] = [
    ['harm → clear(known)', rolling('cleared', [...BASE, enter('harm_c1')])],
    ['harm → veto(known)', rolling('vetoed', [...BASE, enter('harm_c1'), loop('vetoed')])],
    ['limit → clear(known,30)', rolling('cleared', [...BASE, enter('limit_reached')])],
    ['judge → clear(known)', rolling('cleared', [...BASE, enter('judge_reject')])],
    ['harm 起因条目被截断(unknown)', { ...rolling('cleared', [...BASE]), transitions_dropped: 2 }],
    ['矛盾记录(unclassified)', rolling('cleared', [...BASE])],
  ];
  it.each(cases)('%s:引擎的终态部分 == terminalEffectsOf(next)', (_n, r) => {
    const out = complete(r);
    expect(termPart(out)).toEqual(terminalEffectsOf(out.next));
    expect(effectsForTerminal(out.next)).toEqual(terminalEffectsOf(out.next));
    expect(terminalEffectsOf(out.next).length).toBeGreaterThan(0);
  });
  it('E1 并入 E2:黑名单在引擎批次里恰好一份(veto 直接进终态:E2 含它,不再单独推 E1)', () => {
    const s = rec('shadow');
    const out = transition(s, { kind: 'veto', evidence: 'v' }, ctxFor(s, { phase: 1 }));
    if (isRefusal(out)) throw new Error('应成功');
    expect(out.effects.filter((f) => f.type === 'blacklist_veto')).toHaveLength(1);
  });
  it('E1:veto 使记录进入回滚(未进终态)→ 只有 E1,没有墓碑;rolling_back 上 veto 自环同样产出 E1', () => {
    const c = rec('canary', { deploy: { claude: 'injected', pi: 'none', codex: 'none' } });
    const a = transition(c, { kind: 'veto', evidence: 'v' }, ctxFor(c));
    if (isRefusal(a)) throw new Error('应成功');
    expect(a.effects.filter((f) => f.type === 'blacklist_veto')).toEqual([
      { type: 'blacklist_veto', id: ID, content_sha256: SHA },
    ]);
    expect(a.effects.some((f) => f.type === 'write_tombstone')).toBe(false);
    const b = transition(a.next, { kind: 'veto', evidence: 'v2' }, ctxFor(a.next));
    if (isRefusal(b)) throw new Error('应成功');
    expect(b.effects.filter((f) => f.type === 'blacklist_veto')).toHaveLength(1);
  });
  it('键:E1 与 E2 的键不同且互不混用', () => {
    expect(vetoEffectKey(rec('rejected'))).toBe(`veto:${ID}:${SHA}`);
    expect(terminalEffectKey(rec('rejected'))).toBe(`terminal:${ID}:${SHA}`);
    expect(vetoEffectKey(rec('rejected'))).not.toBe(terminalEffectKey(rec('rejected')));
  });
});

/** 带「黑名单按 (id, sha) 集合插入」语义的假件:同键 already;不同键含同一黑名单 → 成员与计数都不重复(W8 `port-contract` 共用套件的内存对照) */
function setSink(): {
  sink: KeyedEffectSink;
  keys: Map<string, number>;
  blacklist: Set<string>;
  blacklistInserts: { n: number };
  audits: string[];
  cooldowns: string[];
} {
  const keys = new Map<string, number>();
  const blacklist = new Set<string>();
  const blacklistInserts = { n: 0 };
  const audits: string[] = [];
  const cooldowns: string[] = [];
  return {
    keys,
    blacklist,
    blacklistInserts,
    audits,
    cooldowns,
    sink: {
      async applyOnce(key, effects): Promise<KeyedEffectResult> {
        if (keys.has(key)) return 'already';
        keys.set(key, 1);
        for (const f of effects) {
          if (f.type === 'blacklist_veto') {
            const m = `${f.id}:${f.content_sha256}`;
            if (!blacklist.has(m)) {
              blacklist.add(m);
              blacklistInserts.n += 1; // 附带计数只在新成员时加
            }
          } else if (f.type === 'append_audit') audits.push(`${key}|${f.line.reason ?? ''}`);
          else if (f.type === 'start_cooldown') cooldowns.push(`${f.kind}:${f.days}`);
        }
        return 'applied';
      },
    },
  };
}

describe('recoverTerminalEffects:E1 第二遍与 E1 / E2 幂等', () => {
  const vetoRolling = () =>
    rec('rolling_back', {
      rollback: { phase: 'injection_disabled', reason: 'vetoed', target_terminal: 'rolled_back' },
      transitions: [...BASE, enter('harm_c1'), loop('vetoed')],
    });
  const store = (recs: PersonalLifecycleRecord[]) => ({
    readAll: async () => ({ kind: 'ok' as const, value: recs }),
  });

  it('回滚记录已提交、E1 落地前崩溃且回滚未完成:第二遍补出黑名单(veto: 键);再 recover → already', async () => {
    const s = setSink();
    const r1 = await recoverTerminalEffects({ store: store([vetoRolling()]), effects: s.sink });
    expect(r1.veto.applied).toEqual([ID]);
    expect(s.blacklist.has(`${ID}:${SHA}`)).toBe(true);
    expect(s.keys.has(vetoEffectKey(vetoRolling()))).toBe(true);
    const r2 = await recoverTerminalEffects({ store: store([vetoRolling()]), effects: s.sink });
    expect(r2.veto).toEqual({ applied: [], already: [ID], deferred: [] });
  });
  it('负向:rolling_back 但原因不是 vetoed、或 veto 之外的状态 → 第二遍不补;非终态不走第一遍', async () => {
    const s = setSink();
    const harm = rec('rolling_back', {
      rollback: { phase: 'injection_disabled', reason: 'harm_c1', target_terminal: 'rolled_back' },
    });
    const r = await recoverTerminalEffects({
      store: store([harm, rec('canary'), rec('shadow')]),
      effects: s.sink,
    });
    expect(r.veto).toEqual({ applied: [], already: [], deferred: [] });
    expect(s.keys.size).toBe(0);
  });
  it('E1 之后完成:E2 再含同一黑名单(不同键各落一次),集合成员与计数都只一份;E2 落地后再 recover 全 already', async () => {
    const s = setSink();
    const rolling = vetoRolling();
    await recoverTerminalEffects({ store: store([rolling]), effects: s.sink }); // E1
    const done = terminal('rolled_back', 'vetoed', 'vetoed', [
      ...BASE,
      enter('harm_c1'),
      loop('vetoed'),
      doneEntry('rolled_back'),
    ]);
    const r = await recoverTerminalEffects({ store: store([done]), effects: s.sink }); // E2
    expect(r.applied).toEqual([ID]);
    expect(s.blacklist.size).toBe(1);
    expect(s.blacklistInserts.n).toBe(1);
    expect(s.cooldowns).toEqual(['auto_rollback:90']);
    const again = await recoverTerminalEffects({ store: store([done]), effects: s.sink });
    expect(again.applied).toEqual([]);
    expect(again.already).toEqual([ID]);
    expect(s.cooldowns).toEqual(['auto_rollback:90']);
  });
  it('保护审计标记只落一次:按审计键落地,重复 recover 不重复;终态批次里不含 append_audit', async () => {
    const s = setSink();
    const r = terminal('rolled_back', 'cleared', 'cleared', [doneEntry('rolled_back')], 3);
    await recoverTerminalEffects({ store: store([r]), effects: s.sink });
    await recoverTerminalEffects({ store: store([r]), effects: s.sink });
    const mine = s.audits.filter((x) => x.endsWith('|protection_unknown'));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatch(new RegExp(`^audit:${ID}:[0-9a-f]{16}\\|protection_unknown$`));
    const key = auditKeyOf(ID, markers(r)[0]?.idem_key ?? '');
    expect(s.keys.has(key)).toBe(true);
    expect(s.cooldowns).toEqual(['auto_rollback:90']);
  });
  it('unclassified[]:矛盾记录的 id 出现在结果里;known / not_applicable 不出现;落地照常完成', async () => {
    const s = setSink();
    const bad = terminal('rolled_back', 'cleared', 'cleared', [...BASE, doneEntry('rolled_back')]);
    const r = await recoverTerminalEffects({ store: store([bad]), effects: s.sink });
    expect(r.unclassified).toEqual([ID]);
    expect(r.applied).toEqual([ID]);
    const ok = terminal('rolled_back', 'cleared', 'cleared', [
      ...BASE,
      enter('harm_c1'),
      doneEntry('rolled_back'),
    ]);
    const s2 = setSink();
    expect(
      (await recoverTerminalEffects({ store: store([ok]), effects: s2.sink })).unclassified,
    ).toEqual([]);
  });
});

describe('回滚执行器:E1 即时落地、E2 同批、保护标记不重复', () => {
  it('harm 回滚中收到 veto(自环):E1 立即按 veto: 键落地;完成后 E2(终态键)含黑名单 + 墓碑 + 90 天(起因 harm),各键只落一次', async () => {
    const w = world7();
    w.crashAt('after:payload');
    await expect(startRollback(w.d, harmReq())).rejects.toThrow('injected crash');
    const r = await startRollback(w.d, {
      ...harmReq(),
      reason: 'vetoed',
      by: 'veto',
      event: { kind: 'veto', evidence: 'rsi veto' },
    });
    expect(r.status).toBe('complete');
    const rec1 = recordOf(w);
    expect(w.effectLog.get(vetoEffectKey(rec1))?.map((x) => x.type)).toEqual(['blacklist_veto']);
    expect(w.effectLog.get(terminalEffectKey(rec1))?.map((x) => x.type)).toEqual([
      'blacklist_veto',
      'write_tombstone',
      'start_cooldown',
    ]);
    expect([...w.effectApplied.values()]).toEqual([1, 1]);
  });
  it('矛盾记录(rolling_back 夹具无进入条目)走完:终态批次 = 黑名单 + 墓碑 + 90 天;protection_unclassified 经审计键恰好落一行,终态批次里没有 append_audit', async () => {
    const w = world7({
      record: rec('rolling_back', {
        deploy: { claude: 'removal_pending', pi: 'none', codex: 'none' },
        rollback: { phase: 'injection_disabled', reason: 'vetoed', target_terminal: 'rolled_back' },
      }),
    });
    const out = await resumeAll(w.d);
    expect(out[0]?.status).toBe('complete');
    const final = recordOf(w);
    expect(w.effectLog.get(terminalEffectKey(final))?.map((x) => x.type)).toEqual([
      'blacklist_veto',
      'write_tombstone',
      'start_cooldown',
    ]);
    const lines = w.audits.filter((l) => l.reason === 'protection_unclassified');
    expect(lines).toHaveLength(1);
    // 再 recover:不新增
    await recoverTerminalEffects({ store: w.store, effects: w.d.keyedEffects });
    expect(w.audits.filter((l) => l.reason === 'protection_unclassified')).toHaveLength(1);
  });
});
