/**
 * D1a:`FactsProvider` 组合层(`makeFactsProvider`)——契约套件(假件与真组合层同跑)+ 纯计算与组合的专属用例。
 * 每条不变量都有负向用例与同世界下的正向对照。
 */
import { describe, expect, it } from 'vitest';
import type {
  CandidateWorkingCopy,
  PersonalLifecycleRecord,
} from '../../../src/contracts/rsi-personal.js';
import type { RsiBlacklistItem, RsiEffectsLedger } from '../../../src/contracts/rsi-store.js';
import { RsiLockError } from '../../../src/rsi/lock-error.js';
import { makeFactsProvider } from '../../../src/rsi/personal/facts/facts-provider.js';
import type { FactsProviderD1a } from '../../../src/rsi/personal/facts/facts-ports.js';
import { makeNearHasher, nearSketch } from '../../../src/rsi/personal/fp/near-algo.js';
import { BODY, NOW, toolSignal, DEFAULT_SIGNALS } from '../personal/w3-fixture.js';
import { TEST_KEY } from './d1a-fixture.js';
import { runFactsContract } from './facts-contract.js';
import {
  DEPENDS,
  expectedGate,
  expectedPromote,
  fingerprintOf,
  makeWorld,
  readersOf,
  type FactsWorld,
  type Failure,
} from './facts-world.js';

/** 假件:返回手写期望;依赖的读端口按契约失败(error → null,lock_lost → 抛) */
function fakeFacts(w: FactsWorld, failure: Failure): FactsProviderD1a {
  const gate = async (kind: 'gate' | 'promote') => {
    if (failure !== null && DEPENDS[kind].includes(failure.reader)) {
      if (failure.mode === 'lock_lost') throw new RsiLockError('lock_lost');
      return false;
    }
    return true;
  };
  // 同一份契约:工作副本与权威记录的 id / 来源对不上 → null(假件不能比真件宽松)
  const bound = (rec: PersonalLifecycleRecord, wc: CandidateWorkingCopy): boolean => {
    const sp = rec.source_proposal;
    return (
      sp !== null &&
      sp !== undefined &&
      wc.id === rec.id &&
      wc.source.run_id === sp.run_id &&
      wc.source.proposal_id === sp.proposal_id
    );
  };
  return {
    gateFacts: async (rec, wc) => (bound(rec, wc) && (await gate('gate')) ? expectedGate(w) : null),
    promoteFacts: async (rec, wc) =>
      bound(rec, wc) && (await gate('promote')) ? expectedPromote(w) : null,
    holdFacts: () => ({ budget_high_legacy: 'unavailable', cost_high_legacy: 'unavailable' }),
  };
}

const realOf = (
  w: FactsWorld,
  failure: Failure = null,
  extra: { now?: () => Date; near?: { threshold: number } } = {},
): FactsProviderD1a =>
  makeFactsProvider({
    readers: readersOf(w, failure),
    fingerprint: fingerprintOf,
    now: extra.now ?? (() => NOW),
    ...(extra.near !== undefined
      ? { near: { hasher: makeNearHasher(TEST_KEY), threshold: extra.near.threshold } }
      : {}),
  });

runFactsContract('假件', fakeFacts);
runFactsContract('真组合层(makeFactsProvider over 内存读端口)', (w, f) => realOf(w, f));

const ledgerWith = (over: Partial<RsiEffectsLedger>): RsiEffectsLedger => ({
  schema_version: 1,
  gen: 1,
  blacklist: [],
  tombstones: [],
  cooldowns: [],
  applied: [],
  ...over,
});
const item = (o: Partial<RsiBlacklistItem> = {}): RsiBlacklistItem => ({
  candidate_id: `ra_${'1'.repeat(12)}`,
  content_sha256: '1'.repeat(64),
  fp_hmac: '1'.repeat(16),
  near_fp: [],
  at: '2026-11-01T00:00:00Z',
  vetoed_gen: 1,
  ...o,
});

describe('promoteFacts:content / signature / 草稿与记录的一致性', () => {
  it('current_content_sha256 取 HEAD 文件现算:未改 = 记录里的 sha;改了正文 = 不同(正向对照)', async () => {
    const w = makeWorld();
    const same = await realOf(w).promoteFacts(w.rec, w.wc);
    expect(same?.current_content_sha256).toBe(w.rec.content_sha256);
    w.headText = (w.headText as string).replace('检查命令退出码', '检查命令返回值');
    const changed = await realOf(w).promoteFacts(w.rec, w.wc);
    expect(changed).not.toBeNull();
    expect(changed?.current_content_sha256).not.toBe(w.rec.content_sha256);
  });

  it('HEAD 文件缺失 / 无法解析 → null(不当作未改动)', async () => {
    const w = makeWorld();
    w.headText = null;
    expect(await realOf(w).promoteFacts(w.rec, w.wc)).toBeNull();
    w.headText = 'not an atom';
    expect(await realOf(w).promoteFacts(w.rec, w.wc)).toBeNull();
  });

  it('current_cluster_signature 由信号重新派生:信号变了 = 不同;证据信号缺 = null(不用残缺信号凑)', async () => {
    const w = makeWorld();
    expect((await realOf(w).promoteFacts(w.rec, w.wc))?.current_cluster_signature).toEqual({
      kind: 'tool',
      tool_name: 'Bash',
      tool_error_class: 'not_found',
    });
    w.signals = DEFAULT_SIGNALS.map((s) => ({ ...s, tool_name: 'Git' }) as typeof s);
    expect((await realOf(w).promoteFacts(w.rec, w.wc))?.current_cluster_signature).toEqual({
      kind: 'tool',
      tool_name: 'Git',
      tool_error_class: 'not_found',
    });
    w.signals = DEFAULT_SIGNALS.slice(0, 1);
    const missing = await realOf(w).promoteFacts(w.rec, w.wc);
    expect(missing?.current_cluster_signature).toBeNull();
    expect(missing?.evidence_valid).toBe(false);
  });

  it('来源提案已不在暂存 / 工作副本指向别的提案 → 两个方法都是 null', async () => {
    const w = makeWorld();
    const other = { ...w.wc, source: { ...w.wc.source, proposal_id: '2026-11-05-999' } };
    expect(await realOf(w).gateFacts(w.rec, other)).toBeNull();
    expect(await realOf(w).promoteFacts(w.rec, other)).toBeNull();
    expect(await realOf(w).gateFacts(w.rec, w.wc)).not.toBeNull();
  });

  it('gateFacts:草稿与记录对不上(content_sha256 / id)→ null;一致则非 null(正向对照)', async () => {
    const w = makeWorld();
    expect(
      await realOf(w).gateFacts({ ...w.rec, content_sha256: 'b'.repeat(64) }, w.wc),
    ).toBeNull();
    expect(await realOf(w).gateFacts({ ...w.rec, id: `ra_${'b'.repeat(12)}` }, w.wc)).toBeNull();
    expect(await realOf(w).gateFacts(w.rec, w.wc)).not.toBeNull();
  });

  it('端口只被问证据信号:getMany 的参数 = 提案证据 sig 列表', async () => {
    const w = makeWorld();
    await realOf(w).promoteFacts(w.rec, w.wc);
    expect(w.calls.signalAsks).toEqual([DEFAULT_SIGNALS.map((s) => s.sig_id)]);
  });
});

describe('tainted / evidence_valid', () => {
  const promote = async (w: FactsWorld) => {
    const f = await realOf(w).promoteFacts(w.rec, w.wc);
    if (f === null) throw new Error('promoteFacts 不应为 null');
    return f;
  };
  it('干净世界:tainted = false 且 evidence_valid = true(正向对照)', async () => {
    const f = await promote(makeWorld());
    expect([f.tainted, f.evidence_valid]).toEqual([false, true]);
  });
  it('来源 run 带 TAINTED 标记 → tainted;端口收到的是 wc.source.run_id', async () => {
    const w = makeWorld();
    w.runTainted = true;
    expect((await promote(w)).tainted).toBe(true);
    expect(w.calls.runTaintAsks).toEqual([w.wc.source.run_id]);
  });
  it('purge journal 在场 → tainted', async () => {
    const w = makeWorld();
    w.purgePresent = true;
    expect((await promote(w)).tainted).toBe(true);
  });
  it('证据项目被排除 → tainted 且 evidence_valid = false', async () => {
    const w = makeWorld();
    w.verdicts.set(DEFAULT_SIGNALS[1]!.sig_id, { excluded: true, attribution: 'collecting' });
    const f = await promote(w);
    expect([f.tainted, f.evidence_valid]).toEqual([true, false]);
  });
  it('归属未知 → evidence_valid = false,但 tainted 仍为 false(不无证据地写 tainted)', async () => {
    const w = makeWorld();
    w.verdicts.set(DEFAULT_SIGNALS[0]!.sig_id, { excluded: false, attribution: 'unknown' });
    const f = await promote(w);
    expect([f.tainted, f.evidence_valid]).toEqual([false, false]);
  });
  it('摘录与信号库不一致 → evidence_valid = false', async () => {
    const w = makeWorld();
    w.signals = [
      toolSignal(1, '2026-11-01', 1, { excerpt_redacted: 'changed after the fact' }),
      DEFAULT_SIGNALS[1]!,
    ];
    expect((await promote(w)).evidence_valid).toBe(false);
  });
  it('policy 三项原样透传(负向:全 false)', async () => {
    const w = makeWorld();
    w.policy = { config_valid: false, enabled: false, authorized: false };
    const f = await promote(w);
    expect([f.config_valid, f.enabled, f.authorized]).toEqual([false, false, false]);
  });
});

describe('墓碑 / 冷却 / 黑名单', () => {
  const both = async (w: FactsWorld, now?: () => Date) => {
    const p = realOf(w, null, now === undefined ? {} : { now });
    return { g: await p.gateFacts(w.rec, w.wc), p: await p.promoteFacts(w.rec, w.wc) };
  };
  it('墓碑:本候选 id → tombstoned;别的 id 不算(正向对照)', async () => {
    const w = makeWorld();
    const tomb = (id: string) =>
      ledgerWith({
        tombstones: [
          { id, terminal: 'rejected', reason: 'rejected_gate', at: '2026-11-01T00:00:00Z' },
        ],
      });
    w.ledger = tomb(w.rec.id);
    const hit = await both(w);
    expect([hit.g?.tombstoned, hit.p?.tombstoned]).toEqual([true, true]);
    w.ledger = tomb(`ra_${'c'.repeat(12)}`);
    const miss = await both(w);
    expect([miss.g?.tombstoned, miss.p?.tombstoned]).toEqual([false, false]);
  });

  it('冷却:同聚类且未到期 → active;边界 at+days = 今天 → 不 active;别的聚类不算', async () => {
    const w = makeWorld();
    const cd = (cluster: string) =>
      ledgerWith({
        cooldowns: [{ cluster_id: cluster, kind: 'expired', days: 30, at: '2026-11-05T00:00:00Z' }],
      });
    w.ledger = cd(w.rec.cluster_id);
    expect((await both(w)).g?.cooldownActive).toBe(true);
    expect((await both(w)).p?.cooldown_active).toBe(true);
    // 2026-11-05 + 30 天 = 2026-12-05:当天起不再 active
    expect((await both(w, () => new Date('2026-12-04T23:59:59Z'))).p?.cooldown_active).toBe(true);
    expect((await both(w, () => new Date('2026-12-05T00:00:00Z'))).p?.cooldown_active).toBe(false);
    w.ledger = cd('c_deadbeef');
    expect((await both(w)).p?.cooldown_active).toBe(false);
  });

  it('黑名单精确匹配:fp_hmac / content_sha256 / candidate_id 各自命中;不相关项不命中', async () => {
    const w = makeWorld();
    const check = async (b: RsiBlacklistItem) => {
      w.ledger = ledgerWith({ blacklist: [b] });
      return (await both(w)).p?.blacklisted;
    };
    expect(await check(item({ fp_hmac: w.rec.fp_hmac }))).toBe(true);
    expect(await check(item({ content_sha256: w.rec.content_sha256 }))).toBe(true);
    expect(await check(item({ candidate_id: w.rec.id }))).toBe(true);
    expect(await check(item())).toBe(false);
  });

  it('已解除(lifted)的项不再命中(同一个 fp_hmac,有无 lifted 对照)', async () => {
    const w = makeWorld();
    w.ledger = ledgerWith({ blacklist: [item({ fp_hmac: w.rec.fp_hmac })] });
    expect((await both(w)).p?.blacklisted).toBe(true);
    w.ledger = ledgerWith({
      blacklist: [
        item({ fp_hmac: w.rec.fp_hmac, lifted_at: '2026-11-02T00:00:00Z', lifted_gen: 2 }),
      ],
    });
    expect((await both(w)).p?.blacklisted).toBe(false);
  });

  describe('近似指纹:显式装配才匹配;[] 只精确', () => {
    const vetoedText = `${BODY.do}\n${BODY.why}`;
    const nearItem = (text: string) =>
      item({
        near_fp: nearSketch(TEST_KEY, text),
        fp_hmac: '2'.repeat(16),
        content_sha256: '2'.repeat(64),
      });
    it('被否决内容是候选的子集(候选是扩写):装配 near 后命中;不装配则不命中(只精确)', async () => {
      const w = makeWorld();
      w.ledger = ledgerWith({ blacklist: [nearItem(vetoedText)] });
      expect(
        (await realOf(w, null, { near: { threshold: 0.5 } }).promoteFacts(w.rec, w.wc))
          ?.blacklisted,
      ).toBe(true);
      expect((await realOf(w).promoteFacts(w.rec, w.wc))?.blacklisted).toBe(false);
    });
    it('不相关内容的 near_fp 不命中(即使装配了 near);near_fp = [] 的项在装配 near 时也只能精确', async () => {
      const w = makeWorld();
      w.ledger = ledgerWith({
        blacklist: [
          nearItem(
            'Please execute every automated check prior to uploading changes into the common codebase',
          ),
          item({ near_fp: [], fp_hmac: '3'.repeat(16), content_sha256: '3'.repeat(64) }),
        ],
      });
      expect(
        (await realOf(w, null, { near: { threshold: 0.5 } }).promoteFacts(w.rec, w.wc))
          ?.blacklisted,
      ).toBe(false);
    });
    it('阈值不合法(0 / NaN / 1.5)→ 构造时抛 RangeError(不静默放行、不全部命中、不被读失败的 null 吞掉);0.5 通过', () => {
      const w = makeWorld();
      for (const t of [0, Number.NaN, 1.5]) {
        expect(() => realOf(w, null, { near: { threshold: t } })).toThrowError(
          new RangeError('near_fp threshold must be a finite number in (0, 1]'),
        );
      }
      expect(() => realOf(w, null, { near: { threshold: 0.5 } })).not.toThrow();
    });
  });
});

describe('gateFacts 的类别与透传', () => {
  it('规则类别:不查失败触发(端口未被调用),failureTriggerHits = 0', async () => {
    const w = makeWorld();
    const g = await realOf(w).gateFacts(w.rec, w.wc);
    expect(g?.failureTriggerHits).toBe(0);
    expect(w.calls.triggers).toEqual([]);
  });
  it('踩坑类别:以原子 trigger 查端口,结果透传', async () => {
    const w = makeWorld({ kind: 'fact', volatility: 'volatile', trigger: 'pnpm test' });
    expect(w.draft.category).toBe('pitfall');
    const g = await realOf(w).gateFacts(w.rec, w.wc);
    expect(g?.failureTriggerHits).toBe(3);
    expect(w.calls.triggers).toEqual(['pnpm test']);
  });
  it('证据信号缺失 → 对应条目 signal = null(闸据此判 evidence_stale),整体不是 null', async () => {
    const w = makeWorld();
    w.signals = DEFAULT_SIGNALS.slice(0, 1);
    const g = await realOf(w).gateFacts(w.rec, w.wc);
    expect(g?.evidence?.map((e) => e.signal === null)).toEqual([false, true]);
  });
  it('legacy HoldFacts:返回值只表示「事实源不可用」,不含放行 / 拒绝字段(`triggers_partial` 日志待接线,D1a 无日志端口)', () => {
    const p = realOf(makeWorld());
    expect(Object.keys(p.holdFacts()).sort()).toEqual(['budget_high_legacy', 'cost_high_legacy']);
    expect(Object.values(p.holdFacts())).toEqual(['unavailable', 'unavailable']);
  });
});

describe('gateFacts:注入的 fingerprint 依赖失败', () => {
  const withFp = (w: FactsWorld, fingerprint: (b: string) => string): FactsProviderD1a =>
    makeFactsProvider({ readers: readersOf(w), fingerprint, now: () => NOW });

  it('fingerprint 抛普通错误 / 返回非法值 → gateFacts = null;promoteFacts 不依赖它(正向对照)', async () => {
    const w = makeWorld();
    const throwing = withFp(w, () => {
      throw new Error('fingerprint backend down');
    });
    expect(await throwing.gateFacts(w.rec, w.wc)).toBeNull();
    expect(await throwing.promoteFacts(w.rec, w.wc)).toEqual(expectedPromote(w));
    expect(await withFp(w, () => 'not-hex').gateFacts(w.rec, w.wc)).toBeNull();
    expect(await withFp(w, fingerprintOf).gateFacts(w.rec, w.wc)).toEqual(expectedGate(w));
  });

  it('fingerprint 抛 RsiLockError → 原实例传播(不吞成 null)', async () => {
    const w = makeWorld();
    const lost = new RsiLockError('lock_lost');
    const p = withFp(w, () => {
      throw lost;
    });
    const e = await p.gateFacts(w.rec, w.wc).then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(e).toBe(lost);
  });
});

describe('组合层的来源绑定:每个候选的事实只来自它自己的来源提案与 run(R21 验收评审 高项)', () => {
  const RUN_B = 'run-20261105T000000Z-bbb';
  const PROP_B = '2026-11-05-002';
  /** 世界 A(来源 run A 被标记 tainted)与世界 B(干净提案,同证据 → 同工具聚类签名);读端口同时暴露两份暂存提案 */
  function twoProposals() {
    const a = makeWorld();
    a.runTainted = true;
    const b = makeWorld({ runId: RUN_B, proposalId: PROP_B });
    const base = readersOf(a);
    const readers = {
      ...base,
      staged: { list: async () => [a.sp, b.sp] },
      taint: {
        runTainted: async (runId: string) => {
          a.calls.runTaintAsks.push(runId);
          return runId === a.wc.source.run_id;
        },
        purgeJournalPresent: async () => false,
      },
    };
    const provider = makeFactsProvider({ readers, fingerprint: fingerprintOf, now: () => NOW });
    return { a, b, provider, readers };
  }

  it('高项复现:工作副本 id=A 但 source 改成干净提案 B → 两个方法都是 null,不得产出 tainted:false 的事实', async () => {
    const { a, b, provider } = twoProposals();
    expect(b.rec.id).not.toBe(a.rec.id);
    expect(b.wc.cluster_signature).toEqual(a.wc.cluster_signature);
    const forged = { ...a.wc, source: { ...b.wc.source } };
    expect(await provider.promoteFacts(a.rec, forged)).toBeNull();
    expect(await provider.gateFacts(a.rec, forged)).toBeNull();
    // 正向对照:真实工作副本在同一世界里得到 A 自己的事实(来源 run A 带 TAINTED → tainted:true)
    const real = await provider.promoteFacts(a.rec, a.wc);
    expect(real?.tainted).toBe(true);
    expect(real?.evidence_valid).toBe(true);
    expect(a.calls.runTaintAsks.every((r) => r === a.wc.source.run_id)).toBe(true);
  });

  it('工作副本 id 与权威记录 id 不同 → null;一致则非 null(正向对照)', async () => {
    const { a, provider } = twoProposals();
    const other = { ...a.wc, id: `ra_${'d'.repeat(12)}` };
    expect(await provider.promoteFacts(a.rec, other)).toBeNull();
    expect(await provider.gateFacts(a.rec, other)).toBeNull();
    expect(await provider.promoteFacts(a.rec, a.wc)).not.toBeNull();
  });

  it('权威记录没有 source_proposal(旧版 / null)→ 两个方法都是 null,不以工作副本的来源代替', async () => {
    const { a, provider } = twoProposals();
    expect(await provider.promoteFacts({ ...a.rec, source_proposal: null }, a.wc)).toBeNull();
    expect(await provider.gateFacts({ ...a.rec, source_proposal: null }, a.wc)).toBeNull();
    const noField = { ...a.rec };
    delete noField.source_proposal;
    expect(await provider.promoteFacts(noField, a.wc)).toBeNull();
    expect(await provider.promoteFacts(a.rec, a.wc)).not.toBeNull();
  });

  it('权威记录的来源与工作副本的来源不一致(记录指向 B、副本指向 A)→ null', async () => {
    const { a, b, provider } = twoProposals();
    const recPointsB = { ...a.rec, source_proposal: { ...b.wc.source } };
    expect(await provider.promoteFacts(recPointsB, a.wc)).toBeNull();
    expect(await provider.gateFacts(recPointsB, a.wc)).toBeNull();
  });

  it('暂存材料在创建后被换了内容(同 run / 提案 id,规则正文不同)→ promoteFacts = null(不拼旧 HEAD 与新暂存);未改则非 null', async () => {
    const a = makeWorld();
    const changed = {
      ...a.sp,
      ruleText: a.sp.ruleText.replace('检查命令退出码', '检查命令返回值'),
    };
    expect(changed.ruleText).not.toBe(a.sp.ruleText);
    const readers = { ...readersOf(a), staged: { list: async () => [changed] } };
    const provider = makeFactsProvider({ readers, fingerprint: fingerprintOf, now: () => NOW });
    expect(await provider.promoteFacts(a.rec, a.wc)).toBeNull();
    expect(await realOf(a).promoteFacts(a.rec, a.wc)).not.toBeNull();
  });

  it('暂存区里同一 (run, 提案 id) 出现两份 → 歧义,null;一份则非 null', async () => {
    const a = makeWorld();
    const readers = { ...readersOf(a), staged: { list: async () => [a.sp, a.sp] } };
    const provider = makeFactsProvider({ readers, fingerprint: fingerprintOf, now: () => NOW });
    expect(await provider.promoteFacts(a.rec, a.wc)).toBeNull();
    expect(await provider.gateFacts(a.rec, a.wc)).toBeNull();
    expect(await realOf(a).promoteFacts(a.rec, a.wc)).not.toBeNull();
  });

  it('同一 run 里另有别的提案(提案 id 不同)→ 只认记录指向的那一份,非 null;(run, 提案 id) 两个维度都要匹配', async () => {
    const a = makeWorld();
    const sibling = makeWorld({ proposalId: '2026-11-05-777' });
    expect(sibling.sp.runId).toBe(a.sp.runId);
    const readers = { ...readersOf(a), staged: { list: async () => [sibling.sp, a.sp] } };
    const provider = makeFactsProvider({ readers, fingerprint: fingerprintOf, now: () => NOW });
    expect((await provider.promoteFacts(a.rec, a.wc))?.current_content_sha256).toBe(
      a.rec.content_sha256,
    );
    const otherRun = makeWorld({ runId: RUN_B });
    const readers2 = { ...readersOf(a), staged: { list: async () => [otherRun.sp, a.sp] } };
    const p2 = makeFactsProvider({ readers: readers2, fingerprint: fingerprintOf, now: () => NOW });
    expect(await p2.promoteFacts(a.rec, a.wc)).not.toBeNull();
  });

  it('信号端口多返回了未被请求的信号(别的提案的证据)→ null;只返回被请求的则非 null', async () => {
    const a = makeWorld();
    const foreign = toolSignal(9, '2026-11-02', 9);
    const base = readersOf(a);
    const readers = {
      ...base,
      signals: {
        getMany: async (sigs: readonly string[]) => [
          ...(await base.signals.getMany(sigs)),
          foreign,
        ],
      },
    };
    const provider = makeFactsProvider({ readers, fingerprint: fingerprintOf, now: () => NOW });
    expect(await provider.promoteFacts(a.rec, a.wc)).toBeNull();
    expect(await provider.gateFacts(a.rec, a.wc)).toBeNull();
    expect(await realOf(a).promoteFacts(a.rec, a.wc)).not.toBeNull();
  });

  it('信号端口把同一个信号返回两次 → null(重复也算读不全 / 读乱)', async () => {
    const a = makeWorld();
    const base = readersOf(a);
    const readers = {
      ...base,
      signals: {
        getMany: async (sigs: readonly string[]) => {
          const got = await base.signals.getMany(sigs);
          return [...got, ...got];
        },
      },
    };
    const provider = makeFactsProvider({ readers, fingerprint: fingerprintOf, now: () => NOW });
    expect(await provider.promoteFacts(a.rec, a.wc)).toBeNull();
    expect(await provider.gateFacts(a.rec, a.wc)).toBeNull();
    expect(await realOf(a).gateFacts(a.rec, a.wc)).not.toBeNull();
  });

  it('锁丢失仍原样抛(绑定检查没有把它吞成 null)', async () => {
    const a = makeWorld();
    const lost = new RsiLockError('lock_lost');
    const readers = {
      ...readersOf(a),
      staged: {
        list: async () => {
          throw lost;
        },
      },
    };
    const provider = makeFactsProvider({ readers, fingerprint: fingerprintOf, now: () => NOW });
    const e = await provider.promoteFacts(a.rec, a.wc).then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(e).toBe(lost);
  });
});
