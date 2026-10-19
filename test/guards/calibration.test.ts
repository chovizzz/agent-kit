/**
 * K5a:judge 校准账 + 晋升加严(G3 T2)。真 git 合成仓库(复用 K4 的 buildWorld,叠同行提案 peers),每个负向旁有正向对照。
 * 默认世界:canary_window_days=14、tile_days=7 → 非加严需 2 个有效块,加严需 3 个;主世界默认交块 0、块 1。
 */
import { describe, expect, it } from 'vitest';
import { KitConfigSchema, LifecycleCoreConfigSchema } from '../../src/contracts/config.js';
import { createGuardGit } from '../../src/guards/index.js';
import { runGuards } from '../../src/guards/index.js';
import { lifecycleCriteria } from '../../src/guards/criteria.js';
import {
  calibrationKeys,
  computeCalibration,
  judgeKeyStat,
  ratioHit,
  type CalibrationEnv,
} from '../../src/lifecycle/calibration.js';
import { batch, peerFiles, peerHook, peerId, type Peer } from './calibration-world.js';
import { kitToml } from './criteria-world.js';
import { buildWorld, twoTiles, type AttestSpec, type WorldOpts } from './frozen-world.js';
import { useRepoCleanup } from './helpers.js';

useRepoCleanup();

const G = (c: string): string => `GUARD_G3_${c}`;
const OVER = G('JUDGE_OVERCONFIDENT');
const INSUF = G('CALIBRATION_INSUFFICIENT');
const UNAVAIL = G('CALIBRATION_UNAVAILABLE');
const UNREAD = G('CALIBRATION_ITEM_UNREADABLE');
const TILES = G('THRESHOLD_TILES');

const threeTiles = (): AttestSpec[] => [
  ...twoTiles(),
  { tile: 2, member: '@alice' },
  { tile: 2, member: '@bob' },
];

async function world(peers: Peer[], over: WorldOpts = {}, hook?: Parameters<typeof peerHook>[1]) {
  const w = await buildWorld({ afterAdvisory: peerHook(peers, hook), ...over });
  const r = w.run();
  const msgs = (code: string): string[] =>
    r.diagnostics.filter((d) => d.code === code).map((d) => d.message);
  return { w, r, all: r.allCodes, msgs };
}

function envOf(w: Awaited<ReturnType<typeof buildWorld>>, over: Partial<CalibrationEnv> = {}) {
  const git = createGuardGit(w.repo.io, w.repo.dir, w.repo.gitEnv);
  const env: CalibrationEnv = {
    git,
    baseOid: w.baseOid,
    baseView: (p) => git.textAt(w.baseOid, p),
    listBase: (d) => git.listFiles(w.baseOid, d),
    cfg: LifecycleCoreConfigSchema.parse({}),
    roster: new Map([
      ['@alice', undefined],
      ['@bob', undefined],
      ['@owner-handle', undefined],
    ]),
    excludeProposalId: 'none',
    target: { vendor: 'openai', model: 'gpt-6.1-sol' },
    ...over,
  };
  return env;
}

describe('K5a 纯函数', () => {
  it('judgeKeyStat:n 边界(9 不下结论,10 下结论)与 gap 边界(0.20 含,>0.20 之外)', () => {
    // conf 0.9:gap = 0.9 − hits/n。n=10:hits=7 → 0.20(含);hits=8 → 0.10
    expect(judgeKeyStat('k', 10, 7, 90).overconfident).toBe(true);
    expect(judgeKeyStat('k', 10, 8, 90).overconfident).toBe(false);
    // n=9 即使全失手也不下结论
    expect(judgeKeyStat('k', 9, 0, 81)).toMatchObject({ overconfident: false, insufficient: true });
    expect(judgeKeyStat('k', 10, 0, 90)).toMatchObject({
      overconfident: true,
      insufficient: false,
    });
    // 0.7:hits=5 → 0.20(含),hits=6 → 0.10
    expect(judgeKeyStat('k', 10, 5, 70).overconfident).toBe(true);
    expect(judgeKeyStat('k', 10, 6, 70).overconfident).toBe(false);
  });

  it('ratioHit:闭区间两端、inf 无上界、整数比较', () => {
    // 基线 10/40;r = (E/S)/(10/40)
    const hit = (lo: number, hi: number | 'inf', e: number) => ratioHit(lo, hi, e, 40, 10, 40);
    expect(hit(0.8, 1.25, 10)).toBe(true); // r=1
    expect(hit(0.8, 1.25, 8)).toBe(true); // r=0.8,下端含
    expect(hit(0.8, 1.25, 7)).toBe(false);
    expect(hit(0.8, 1.25, 12.5)).toBe(true); // r=1.25,上端含
    expect(hit(0.8, 1.25, 13)).toBe(false);
    expect(hit(2, 'inf', 1000)).toBe(true);
    expect(hit(2, 'inf', 19)).toBe(false);
    expect(hit(0, 0.1, 0)).toBe(true);
    expect(ratioHit('inf' as never, 'inf', 1, 1, 1, 1)).toBeUndefined();
  });

  it('calibrationKeys:大小写、空白归一', () => {
    expect(calibrationKeys(' OpenAI ', ' GPT-6.1-Sol ')).toEqual({
      vendorKey: 'openai',
      modelKey: 'openai/gpt-6.1-sol',
    });
  });
});

describe('K5a G3 校准加严', { timeout: 180_000 }, () => {
  it('样本不足:9 份已结算(全失手)也不加严,只产 CALIBRATION_INSUFFICIENT', async () => {
    const { r, all, msgs } = await world(batch(9, 0));
    expect(all).toEqual([INSUF]);
    expect(r.diagnostics.every((d) => d.severity === 'warn')).toBe(true);
    expect(msgs(INSUF)[0]).toContain('n=9');
  });

  it('没有任何已结算预测(基线里没有同行提案):样本不足、不加严', async () => {
    const { all } = await world([]);
    expect(all).toEqual([INSUF]);
  });

  it('n=10 且 gap=0.20(7 命中,conf 0.9):加严,多要 1 块 → 只有 2 块报 THRESHOLD_TILES 且写明加严', async () => {
    const { all, msgs } = await world(batch(10, 7));
    expect(all).toEqual([OVER, TILES].sort());
    expect(msgs(TILES)[0]).toContain('已因 judge 过度自信');
    expect(msgs(TILES)[0]).toContain('需要 ≥3 个');
    expect(msgs(OVER)[0]).toContain('n=10');
  });

  it('正向对照:同一加严世界交满 3 块 → 通过(仍留 JUDGE_OVERCONFIDENT 提示)', async () => {
    const { all } = await world(batch(10, 7), { attests: threeTiles() });
    expect(all).toEqual([OVER]);
  });

  it('gap 边界另一侧:8 命中(gap=0.10)不加严,2 块即可通过,且无任何校准提示', async () => {
    const { all } = await world(batch(10, 8));
    expect(all).toEqual([]);
  });

  it('0.7 档的 gap 边界:5 命中(0.20)加严,6 命中(0.10)不加严', async () => {
    const strict = await world(batch(10, 5, { conf: 0.7 }));
    expect(strict.all).toEqual([OVER, TILES].sort());
    const loose = await world(batch(10, 6, { conf: 0.7 }));
    expect(loose.all).toEqual([]);
  });

  it('已结算 n 边界:10 份才下结论(9 份失手 + 1 份命中 = 10 → 加严;去掉 1 份 → 9 → 不加严)', async () => {
    expect((await world(batch(10, 1))).all).toEqual([OVER, TILES].sort());
    expect((await world(batch(9, 1))).all).toEqual([INSUF]);
  });

  it('只算基线树:PR(head)里补交的 attest 不影响自己的校准;同样的文件放进基线则该份结算、加严', async () => {
    // 第 10 份预测只有块 0(未结算);块 1 的 attest 要么在 PR 里补交(不算),要么已在基线里(算)
    const full = peerFiles([{ n: 10, first: { hit: false, tiles: 2 } }], 'a'.repeat(40)).attests1;
    const part = peerFiles([{ n: 10, first: { hit: false, tiles: 1 } }], 'a'.repeat(40)).attests1;
    const missing = Object.fromEntries(Object.entries(full).filter(([p]) => !(p in part)));
    expect(Object.keys(missing).length).toBe(2);
    const nine = batch(9, 0);
    const tenthPart: Peer = { n: 10, first: { hit: false, tiles: 1 } };
    const inHead = await world([...nine, tenthPart], { headExtra: () => missing });
    expect(inHead.all).toEqual([INSUF]);
    const inBase = await world([...nine, { n: 10, first: { hit: false, tiles: 2 } }]);
    expect(inBase.all).toEqual([OVER, TILES].sort());
  });

  it('自身排除:被判提案 id 在账本里的预测不计(单元口径,同一基线 n=10 → 排除一个得 n=9)', async () => {
    const w = await buildWorld({ afterAdvisory: peerHook(batch(10, 0)) });
    const full = computeCalibration(envOf(w));
    expect(full.tiers[0]).toMatchObject({ key: 'openai', n: 10, hits: 0, overconfident: true });
    const excl = computeCalibration(envOf(w, { excludeProposalId: peerId(3) }));
    expect(excl.tiers[0]).toMatchObject({ n: 9, overconfident: false, insufficient: true });
  });

  it('不进分母:baseline_insufficient / not_measurable 的 peer 再多也不改变结论(对照:它们若被计为失手会加严)', async () => {
    const predicted = batch(10, 8); // 8/10 命中:gap 0.10,不加严
    const noise: Peer[] = [
      ...[11, 12, 13].map((n) => ({ n, status: 'baseline_insufficient' as const })),
      ...[14, 15, 16].map((n) => ({ n, status: 'not_measurable' as const })),
    ];
    const { all, w } = await world([...predicted, ...noise]);
    expect(all).toEqual([]);
    expect(computeCalibration(envOf(w)).tiers[0]).toMatchObject({ n: 10, hits: 8 });
  });

  it('status 被手改:引导基线充足却标 baseline_insufficient(逃避结算)→ 条目损坏、加严;not_measurable 因原子不可定位放行', async () => {
    const good = batch(10, 10);
    const forged = await world([...good, { n: 11, forceStatus: 'baseline_insufficient' }]);
    expect(forged.all).toEqual([UNREAD, TILES].sort());
    const unknownSig = await world([...good, { n: 11, forceStatus: 'not_measurable' }]);
    expect(unknownSig.all).toEqual([]);
  });

  it('同一份规则被重跑 judge:被取代的第一份(失手)也进账,不能只看最新一份', async () => {
    // 5 份单次命中 + 5 份「第一份失手 → 重跑后第二份命中」:只看最新一份是 10/10 命中;含第一份是 10/15 命中 → 加严
    const refrozen: Peer[] = [6, 7, 8, 9, 10].map((n) => ({
      n,
      first: { hit: false, at: '2026-10-07' },
      second: { at: '2026-10-12', hit: true },
    }));
    const { all, w } = await world([...batch(5, 5), ...refrozen]);
    expect(all).toContain(OVER);
    expect(computeCalibration(envOf(w)).tiers[0]).toMatchObject({ n: 15, hits: 10 });
  });

  it('重跑发生在 D0 之前(同日,没有验收期数据可偷看):第一份忽略 → 只有 10 份,不加严', async () => {
    const sameDay: Peer[] = [6, 7, 8, 9, 10].map((n) => ({
      n,
      first: { hit: false, at: '2026-10-07' },
      second: { at: '2026-10-07', time: '11:00:00', hit: true },
    }));
    const { all, w } = await world([...batch(5, 5), ...sameDay]);
    expect(all).toEqual([]);
    expect(computeCalibration(envOf(w)).tiers[0]).toMatchObject({ n: 10, hits: 10 });
  });

  it('被取代的第一份没有有效块 → 按失手计入分母(不能靠不收集数据逃掉)', async () => {
    const refrozen: Peer[] = [6, 7, 8, 9, 10].map((n) => ({
      n,
      first: { hit: true, at: '2026-10-07', tiles: 0 },
      second: { at: '2026-10-12', hit: true },
    }));
    const { w } = await world([...batch(5, 5), ...refrozen]);
    expect(computeCalibration(envOf(w)).tiers[0]).toMatchObject({ n: 15, hits: 10 });
  });

  it('未结算(块不够)不进分母,披露条数', async () => {
    const short: Peer[] = batch(10, 0).map((p) => ({ ...p, first: { ...p.first, tiles: 1 } }));
    const { all, msgs } = await world(short);
    expect(all).toEqual([INSUF]);
    expect(msgs(INSUF)[0]).toContain('10 份最新预测未结算');
  });

  it('键:同 vendor 不同 model 的预测合并到 vendor 档,任一档过度自信即加严;不同 vendor 不互相污染', async () => {
    const split: Peer[] = batch(10, 0).map((p, i) => ({
      ...p,
      model: i % 2 === 0 ? 'gpt-6.1-sol' : 'gpt-6.1-sol-x',
    }));
    const mix = await world(split);
    expect(mix.all).toEqual([OVER, TILES].sort()); // vendor 档 n=10 加严,两个 model 档各 n=5
    const other = await world(batch(10, 0, { vendor: 'zai', model: 'glm-5.3-flash' }));
    expect(other.all).toEqual([INSUF]); // 全是别家的失手,不影响 openai
  });

  it('损坏(同键):acceptance 哈希不符 → CALIBRATION_ITEM_UNREADABLE 并加严;对照:别家 judge 的损坏条目不影响', async () => {
    const good = batch(10, 10);
    const bad = await world([...good, { n: 11, corrupt: 'hash' }]);
    expect(bad.all).toEqual([UNREAD, TILES].sort());
    expect(bad.msgs(TILES)[0]).toContain('已因');
    const other = await world([...good, { n: 11, corrupt: 'hash', vendor: 'zai', model: 'glm' }]);
    expect(other.all).toEqual([]);
  });

  it('损坏(同键):有 acceptance 无 prediction;冻结后 prediction 被改;同一冻结协议出现在两个文件 → 各自加严', async () => {
    const good = batch(10, 10);
    expect((await world([...good, { n: 11, corrupt: 'no_prediction' }])).all).toEqual(
      [UNREAD, TILES].sort(),
    );
    expect((await world([...good, { n: 11 }], {}, { driftNs: [11] })).all).toEqual(
      [UNREAD, TILES].sort(),
    );
    expect((await world([...good, { n: 11, duplicate: true }])).all).toEqual(
      [UNREAD, TILES].sort(),
    );
  });

  it('损坏(无法归属键):提案 yaml 解析失败 → CALIBRATION_UNAVAILABLE 并加严;交满 3 块则通过', async () => {
    const peers = [...batch(10, 10), { n: 11, corrupt: 'yaml' as const }];
    const strict = await world(peers);
    expect(strict.all).toEqual([UNAVAIL, TILES].sort());
    const ok = await world(peers, { attests: threeTiles() });
    expect(ok.all).toEqual([UNAVAIL]);
  });

  it('计算抛错:git.fileHistory 在 peer 提案上抛出 → CALIBRATION_UNAVAILABLE 并加严,不回落默认块数', async () => {
    const w = await buildWorld({ afterAdvisory: peerHook(batch(10, 10)) });
    const real = createGuardGit(w.repo.io, w.repo.dir, w.repo.gitEnv);
    const git = {
      ...real,
      fileHistory: (c: string, p: string) => {
        if (p.startsWith('proposals/2026-09-01')) throw new Error('boom');
        return real.fileHistory(c, p);
      },
    };
    const res = runGuards({
      git,
      base: 'kit-base',
      head: 'kit-head',
      label: 'kit:promotion',
      criteria: lifecycleCriteria,
    });
    const codes = [...new Set(res.diagnostics.map((d) => d.code))].sort();
    expect(codes).toEqual([UNAVAIL, TILES].sort());
    // 对照:不抛时同一世界无任何提示
    expect(w.run().allCodes).toEqual([]);
  });

  it('加严后冻结的 max_tiles 装不下:直接报 THRESHOLD_TILES 并说明须重跑 judge,不放宽', async () => {
    const { all, msgs } = await world(batch(10, 7), { maxTiles: 2 });
    expect(all).toContain(TILES);
    expect(msgs(TILES).join('|')).toContain('max_tiles=2');
    expect(msgs(TILES).join('|')).toContain('重跑 judge');
  });

  it('加严与 kit.toml 无关:canary_window_days=21 时非加严需 3 块、加严需 4 块;kit.toml 不接受任何校准/加严键', async () => {
    const lifecycle =
      '[lifecycle]\ncanary_window_days = 21\nmin_members = 2\nmin_non_owner_members = 1\nmin_exposure_sessions = 10\nmax_harmful = 0\nno_exposure_windows = 2';
    const kit = kitToml({ lifecycle });
    const tiles3 = (n: number, hits: number) =>
      batch(n, hits).map((p) => ({ ...p, first: { ...p.first, tiles: 3 } }));
    const strict = await world(tiles3(10, 7), { kit, attests: threeTiles() });
    expect(strict.all).toEqual([OVER, TILES].sort());
    expect(strict.msgs(TILES)[0]).toContain('需要 ≥4 个');
    const loose = await world(tiles3(10, 8), { kit, attests: threeTiles() });
    expect(loose.all).toEqual([]);
    // 覆盖面:想在 kit.toml 里写常量放宽 → 配置本身不合法
    const base = KitConfigSchema.safeParse({});
    void base;
    for (const key of ['strict_extra_tiles', 'calibration_min_n', 'calibration_gap']) {
      const bad = LifecycleCoreConfigSchema.safeParse({ [key]: 0 });
      expect(bad.success, key).toBe(false);
    }
  });
  it('acceptance 被写成 {} / 缺 sha256(prediction 仍在)不是旧记录:同键损坏、加严', async () => {
    const r = await world([...batch(10, 10), { n: 11, corrupt: 'empty_acceptance' }]);
    expect(r.all).toEqual([UNREAD, TILES].sort());
  });

  it('提案历史最老一条没有父提交(根提交 / 浅克隆边界,历史可能被截断)→ CALIBRATION_UNAVAILABLE 并加严', async () => {
    const root = peerFiles([{ n: 11 }], 'a'.repeat(40)).proposals;
    const r = await world(batch(10, 10), { baseExtra: root });
    expect(r.all).toEqual([UNAVAIL, TILES].sort());
    expect(r.msgs(UNAVAIL)[0]).toContain('没有父提交');
  });

  it('被取代的旧份有效块齐了但 sessions_total 合计为 0:是损坏(加严),不是普通失手', async () => {
    const zero: Peer = {
      n: 11,
      first: { hit: true, at: '2026-10-07', zeroSessions: true },
      second: { at: '2026-10-12', hit: true },
    };
    expect((await world([...batch(10, 10), zero])).all).toEqual([UNREAD, TILES].sort());
    const ok = { ...zero, first: { hit: true, at: '2026-10-07' } };
    expect((await world([...batch(10, 10), ok])).all).toEqual([]);
  });
});
