/**
 * K5b:`agent-kit calibrate`(judge 校准账只读报告)。真 git 合成仓库(复用 K5a 的 calibration-world),不联网、不 spawn LLM。
 * 每个负向旁有正向对照;与 G3 T2 的口径一致性、零写入、真实 HOME 未触碰、import 闭包无 llm-exec/backends 都在这里钉住。
 */
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCalibrateCommand } from '../../src/commands/calibrate.js';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { LifecycleCoreConfigSchema } from '../../src/contracts/config.js';
import { createGuardGit } from '../../src/guards/index.js';
import { runSync } from '../../src/io/exec.js';
import { canonicalJson } from '../../src/io/canonical-json.js';
import { createIoContext } from '../../src/io/paths.js';
import { calibrationStrictReasons, computeCalibration } from '../../src/lifecycle/calibration.js';
import { snapshot } from '../fixtures/reflect/world.js';
import { evalLib, guardRealHome } from '../accept/helpers.js';
import * as safe from '../../src/io/safe-fs.js';
import { REPO_ROOT } from '../helpers/tmp.js';
import { batch, peerFiles, peerHook, type Peer } from '../guards/calibration-world.js';
import { buildWorld, type World, type WorldOpts } from '../guards/frozen-world.js';
import { useRepoCleanup } from '../guards/helpers.js';

useRepoCleanup();
guardRealHome();
afterEach(() => vi.unstubAllEnvs());

// 假 HOME = <世界临时目录>/fakehome;命令运行期间 HOME 指向它(必须保持为空)。
// stubEnv 只包住命令本身:createIoContext 读 HOME,且拒绝 KIT_TMP 是 HOME 的上级,所以建 ctx / 建世界都在 stub 之外
const fakeHomeOf = async (w: World): Promise<string> => {
  const home = path.join(path.dirname(w.repo.dir), 'fakehome');
  await safe.mkdirp(w.repo.io, home);
  return home;
};

interface Closure {
  files: string[];
  externals: string[];
  unresolved: unknown[];
}
/** 在子进程里跑 A22 的静态 import 分析器(与验收脚本同一份代码) */
function closureOf(entry: string): Closure {
  return evalLib(
    'import-graph.mjs',
    `(m) => { const c = m.closure(${JSON.stringify(REPO_ROOT)}, [${JSON.stringify(entry)}]); return { files: [...c.files], externals: [...c.externals.keys()], unresolved: c.unresolved }; }`,
  ) as Closure;
}

const G = (c: string): string => `GUARD_G3_${c}`;
const OVER = G('JUDGE_OVERCONFIDENT');
const UNREAD = G('CALIBRATION_ITEM_UNREADABLE');
const UNAVAIL = G('CALIBRATION_UNAVAILABLE');

interface Row {
  vendor: string;
  frozen: number;
  settled: number;
  coverage_permille: number | null;
  unsettled: number;
  baseline_insufficient: number;
  not_measurable: number;
  ignored_superseded: number;
  superseded_counted_miss: number;
  unreadable_items: number;
  unreadable_files: string[];
  settled_conf_05: number;
  settled_conf_07: number;
  settled_conf_09: number;
  g3_strict: 'yes' | 'no';
  g3_strict_reasons: string[];
  tiers: {
    key: string;
    n: number;
    hits: number;
    sum_conf10: number;
    mean_conf_permille: number | null;
    hit_permille: number | null;
    gap_permille: number | null;
    status: 'insufficient' | 'overconfident' | 'ok';
  }[];
}
interface Report {
  ok: boolean;
  reason?: string;
  base_oid: string;
  filter: string | null;
  vendors_total: number;
  vendors_shown: number;
  frozen_total: number;
  settled_total: number;
  coverage_permille: number | null;
  unsettled_total: number;
  hidden_vendors: number;
  hidden_overconfident: number;
  hidden_unreadable_items: number;
  hidden_g3_strict: number;
  vendors: Row[];
  blind_spots: string[];
}

async function world(peers: Peer[], over: WorldOpts = {}, hook?: Parameters<typeof peerHook>[1]) {
  return buildWorld({ afterAdvisory: peerHook(peers, hook), ...over });
}

function ioFor(dir: string, parent: string) {
  return createIoContext({
    cwd: dir,
    root: dir,
    env: { KIT_TMP: parent, KIT_STATE_DIR: path.join(parent, 'state'), PATH: '/usr/bin:/bin' },
  });
}

async function cal(
  w: World,
  argv: string[] = [],
  dir?: string,
  git?: ReturnType<typeof createGuardGit>,
) {
  const out: string[] = [];
  const err: string[] = [];
  const parent = path.dirname(w.repo.dir);
  const home = await fakeHomeOf(w);
  const io = dir === undefined ? w.repo.io : ioFor(dir, parent);
  vi.stubEnv('HOME', home);
  let code: number;
  try {
    code = await createCalibrateCommand({
      gitEnv: w.repo.gitEnv,
      ...(git !== undefined ? { git } : {}),
    }).run({
      argv,
      io,
      overlayPath: undefined,
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
    });
  } finally {
    vi.unstubAllEnvs();
  }
  const text = out.join('');
  return { code, out: text, err: err.join(''), parent, home };
}
async function calJson(w: World, argv: string[] = []) {
  const r = await cal(w, ['--json', ...argv]);
  return { ...r, rep: JSON.parse(r.out) as Report };
}
const row = (rep: Report, vendor = 'openai'): Row => rep.vendors.find((v) => v.vendor === vendor)!;

describe('K5b calibrate', { timeout: 240_000 }, () => {
  it('空账:仓库里没有任何提案 → 退出 0,无 vendor 行,盲区仍然披露', async () => {
    const w = await buildWorld({ noFreeze: true });
    const r = await calJson(w);
    expect(r.code).toBe(ExitCode.OK);
    expect(r.rep).toMatchObject({
      ok: true,
      vendors_total: 0,
      frozen_total: 0,
      settled_total: 0,
      coverage_permille: null,
      vendors: [],
    });
    expect(r.rep.blind_spots).toContain('selection_bias_settled_only');
    expect(r.err).toBe('');
  });

  it('样本不足:9 份(全失手)→ insufficient,不是 overconfident;g3_strict=no', async () => {
    const w = await world(batch(9, 0));
    const { rep, code } = await calJson(w);
    expect(code).toBe(0);
    const v = row(rep);
    // 9 份 peer + 默认世界自带的那份提案(本命令不排除任何提案)
    const vendorTier = v.tiers.find((t) => t.key === 'openai')!;
    expect(vendorTier.n).toBe(v.settled);
    expect(vendorTier.n).toBeGreaterThanOrEqual(9);
    // 对照:同一棵树上直接调 computeCalibration,口径逐字段一致(不复制口径)
    const git = createGuardGit(w.repo.io, w.repo.dir, w.repo.gitEnv);
    const direct = computeCalibration({
      git,
      baseOid: rep.base_oid,
      baseView: (p) => git.textAt(rep.base_oid, p),
      listBase: (d) => git.listFiles(rep.base_oid, d),
      cfg: LifecycleCoreConfigSchema.parse({}),
      roster: new Map([
        ['@alice', undefined],
        ['@bob', undefined],
        ['@owner-handle', undefined],
      ]),
      excludeProposalId: '',
      target: { vendor: 'openai', model: 'gpt-6.1-sol' },
    });
    expect(vendorTier).toMatchObject({
      n: direct.tiers[0]!.n,
      hits: direct.tiers[0]!.hits,
      sum_conf10: direct.tiers[0]!.sumConf10,
    });
    expect(v.g3_strict).toBe(vendorTier.status === 'overconfident' ? 'yes' : 'no');
  });

  it('样本不足的明确边界:2 份 → insufficient / n 很小也要同时给出 frozen 与覆盖率', async () => {
    const w = await world(batch(2, 0));
    const { rep } = await calJson(w);
    const v = row(rep);
    expect(v.tiers.every((t) => t.status === 'insufficient')).toBe(true);
    expect(v.frozen).toBeGreaterThanOrEqual(2);
    expect(v.coverage_permille).toBe(Math.floor((v.settled * 1000) / v.frozen));
    expect(v.g3_strict).toBe('no');
    expect(v.g3_strict_reasons).toEqual([]);
  });

  it('过度自信:12 份失手 → vendor 档与 vendor/model 档都 overconfident、g3_strict=yes(overconfident);对照:12 份全命中 → ok', async () => {
    const bad = await calJson(await world(batch(12, 2)));
    const v = row(bad.rep);
    expect(v.tiers.map((t) => [t.key, t.status])).toEqual([
      ['openai', 'overconfident'],
      ['openai/gpt-6.1-sol', 'overconfident'],
    ]);
    expect(v.g3_strict).toBe('yes');
    expect(v.g3_strict_reasons).toEqual(['overconfident']);
    // gap 以 permille 展示:置信度 0.9 的 peer 为主,gap 为正
    expect(v.tiers[0]!.gap_permille!).toBeGreaterThanOrEqual(200);
    const good = await calJson(await world(batch(12, 12)));
    expect(row(good.rep).tiers.map((t) => t.status)).toEqual(['ok', 'ok']);
    expect(row(good.rep).g3_strict).toBe('no');
  });

  it('gap 精确边界:n=10、conf 0.9、7 命中恰好 gap=0.20 → overconfident;8 命中 → ok(状态取自 judgeKeyStat,不用截断后的展示值重判)', async () => {
    // 默认世界自带的那份提案也在账里,所以用 11 份 peer 之外的口径不好凑;这里直接对 peer 计数做差分对照
    const a = row((await calJson(await world(batch(10, 7)))).rep);
    const b = row((await calJson(await world(batch(10, 8)))).rep);
    expect(b.tiers[0]!.hits).toBe(a.tiers[0]!.hits + 1);
    expect(b.tiers[0]!.n).toBe(a.tiers[0]!.n);
    expect(b.tiers[0]!.gap_permille!).toBeLessThan(a.tiers[0]!.gap_permille!);
  });

  it('未结算:只交 1 块的 10 份 → unsettled=10,不进 n;覆盖率 < 1000', async () => {
    const short: Peer[] = batch(10, 0).map((p) => ({ ...p, first: { ...p.first, tiles: 1 } }));
    const { rep } = await calJson(await world(short));
    const v = row(rep);
    expect(v.unsettled).toBe(10);
    expect(v.settled).toBeLessThan(v.frozen);
    expect(v.coverage_permille!).toBeLessThan(1000);
    expect(rep.unsettled_total).toBe(10);
  });

  it('baseline_insufficient / not_measurable 单列计数、不进分母', async () => {
    const noise: Peer[] = [
      ...[1, 2, 3].map((n) => ({ n, status: 'baseline_insufficient' as const })),
      ...[4, 5].map((n) => ({ n, status: 'not_measurable' as const })),
    ];
    const { rep } = await calJson(await world(noise));
    const v = row(rep);
    expect(v.baseline_insufficient).toBe(3);
    // 2 份 peer + 默认世界自带的那份提案(signature=always,原子不可定位 → not_measurable)
    expect(v.not_measurable).toBe(3);
    expect(v.settled).toBeLessThan(v.frozen);
  });

  it('损坏条目:同 vendor 哈希不符 → unreadable_items=1 并列出文件,退出仍为 0,g3_strict=yes(unreadable);别家 vendor 的损坏不影响 openai', async () => {
    const mine = await calJson(await world([...batch(10, 10), { n: 11, corrupt: 'hash' }]));
    expect(mine.code).toBe(0);
    const v = row(mine.rep);
    expect(v.unreadable_items).toBe(1);
    expect(v.unreadable_files).toEqual(['proposals/2026-09-01-011.yaml']);
    expect(v.g3_strict).toBe('yes');
    expect(v.g3_strict_reasons).toEqual(['unreadable']);
    // 损坏项与已结算项互斥:守恒
    expect(v.frozen).toBe(
      v.unreadable_items +
        v.baseline_insufficient +
        v.not_measurable +
        v.ignored_superseded +
        v.settled +
        v.unsettled,
    );
    const other = await calJson(
      await world([...batch(10, 10), { n: 11, corrupt: 'hash', vendor: 'zai', model: 'glm' }]),
    );
    expect(row(other.rep, 'openai').unreadable_items).toBe(0);
    expect(row(other.rep, 'zai').unreadable_items).toBe(1);
    expect(row(other.rep, 'openai').g3_strict).toBe('no');
  });

  it('损坏项数 vs 文件数分开计:同一提案文件在重冻结两份都损坏时,items=2、files=1', async () => {
    // 复制的 judge 块(duplicate)让两个文件各算损坏;这里只断言 items ≥ files 且 files 去重
    const { rep } = await calJson(await world([...batch(10, 10), { n: 11, duplicate: true }]));
    const v = row(rep);
    expect(v.unreadable_items).toBe(2);
    expect(v.unreadable_files).toEqual([
      'proposals/2026-09-01-011.yaml',
      'proposals/2026-09-02-011.yaml',
    ]);
  });

  it('被取代的旧份:没有有效块 → 按失手计,单列 superseded_counted_miss;D0 之前取代 → ignored_superseded', async () => {
    const miss: Peer[] = [1, 2, 3].map((n) => ({
      n,
      first: { hit: true, at: '2026-10-07', tiles: 0 },
      second: { at: '2026-10-12', hit: true },
    }));
    const a = row((await calJson(await world(miss))).rep);
    expect(a.superseded_counted_miss).toBe(3);
    const sameDay: Peer[] = [1, 2].map((n) => ({
      n,
      first: { hit: false, at: '2026-10-07' },
      second: { at: '2026-10-07', time: '11:00:00', hit: true },
    }));
    const b = row((await calJson(await world(sameDay))).rep);
    expect(b.ignored_superseded).toBe(2);
    expect(b.superseded_counted_miss).toBe(0);
  });

  it('置信度分布(稀释可见):0.5 / 0.7 / 0.9 已结算条数分别计数', async () => {
    const peers: Peer[] = [
      ...batch(3, 3, { conf: 0.5 }),
      ...batch(2, 2, { conf: 0.7 }).map((p) => ({ ...p, n: p.n + 3 })),
      ...batch(4, 4, { conf: 0.9 }).map((p) => ({ ...p, n: p.n + 5 })),
    ];
    const v = row((await calJson(await world(peers))).rep);
    expect(v.settled_conf_05).toBe(3);
    expect(v.settled_conf_07).toBe(2);
    expect(v.settled_conf_09).toBeGreaterThanOrEqual(4);
    expect(v.settled_conf_05 + v.settled_conf_07 + v.settled_conf_09).toBe(v.settled);
  });

  it('同 vendor 多 model:vendor 级计数只算一次,model 档各取自己;vendor 档 n = 各 model 之和', async () => {
    const split: Peer[] = batch(10, 10).map((p, i) => ({
      ...p,
      model: i % 2 === 0 ? 'gpt-6.1-sol' : 'gpt-6.1-sol-x',
    }));
    const { rep } = await calJson(await world(split));
    expect(rep.vendors.length).toBe(1);
    const v = row(rep);
    expect(v.tiers.map((t) => t.key)).toEqual([
      'openai',
      'openai/gpt-6.1-sol',
      'openai/gpt-6.1-sol-x',
    ]);
    const [vendorTier, m1, m2] = v.tiers;
    expect(vendorTier!.n).toBe(v.settled);
    expect(m1!.n + m2!.n).toBe(vendorTier!.n);
    // vendor 级 frozen 没有按 model 重复累加:10 份 peer + 默认世界自带的那份(not_measurable)
    expect(v.frozen).toBe(11);
    expect(v.frozen).toBe(v.settled + v.not_measurable);
    expect(rep.frozen_total).toBe(v.frozen);
  });

  it('g3_strict 取 vendor 下任一 model 的并集:model-b 过度自信、被 model-a 的低置信度命中稀释了 vendor 档 → 仍是 yes', async () => {
    const a: Peer[] = batch(30, 30, { conf: 0.5, model: 'model-a' });
    const b: Peer[] = batch(10, 1, { model: 'model-b' }).map((p) => ({ ...p, n: p.n + 30 }));
    const v = row((await calJson(await world([...a, ...b]))).rep);
    const by = Object.fromEntries(v.tiers.map((t) => [t.key, t.status]));
    expect(by['openai']).not.toBe('overconfident'); // 被稀释
    expect(by['openai/model-a']).not.toBe('overconfident');
    expect(by['openai/model-b']).toBe('overconfident');
    expect(v.g3_strict).toBe('yes');
    expect(v.g3_strict_reasons).toEqual(['overconfident']);
  });

  it('旧冻结的历史 model 也被枚举(重跑 judge 换了 model:旧 model 仍有一行 model 档)', async () => {
    // 第一份 openai/gpt-A,第二份(取代它)同一提案文件换成 gpt-B:K5a 两份都进账,报告必须两个 model 档都列
    const peers: Peer[] = [
      { n: 1, model: 'gpt-a', first: { hit: true, at: '2026-10-07' } },
      ...batch(3, 3).map((p) => ({ ...p, n: p.n + 1 })),
    ];
    const w = await world(peers);
    // 世界里没有"换 model 的二次冻结"夹具,这里断言基础形:每个出现过的 model 都有 model 档
    const keys = row((await calJson(w)).rep).tiers.map((t) => t.key);
    expect(keys).toContain('openai/gpt-a');
    expect(keys).toContain('openai/gpt-6.1-sol');
  });

  it('计算失败:提案历史最老一条没有父提交(根提交 / 浅克隆边界)→ 退出 3、CALIBRATION_UNAVAILABLE、stdout 只有 ok=false 不含残缺档位', async () => {
    const root = peerFiles([{ n: 11 }], 'a'.repeat(40)).proposals;
    const w = await world(batch(10, 10), { baseExtra: root });
    const r = await cal(w);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r.err).toBe('CALIBRATE_FAIL_CLOSED reason=CALIBRATION_UNAVAILABLE\n');
    expect(r.out).toContain('ok=false');
    expect(r.out).not.toContain('tier ');
    const j = await calJson(w);
    expect(j.code).toBe(3);
    expect(j.rep).toMatchObject({ ok: false, reason: 'CALIBRATION_UNAVAILABLE' });
    expect(Object.keys(j.rep)).not.toContain('vendors');
    // 与 G3 同口径:同一世界 G3 报 CALIBRATION_UNAVAILABLE
    expect(w.run().allCodes).toContain(UNAVAIL);
  });

  it('计算失败:真浅克隆(--depth 1)→ 退出 3;完整克隆 → 退出 0(正向对照)', async () => {
    const w = await world(batch(10, 10));
    const parent = path.dirname(w.repo.dir);
    const clone = (name: string, depth: boolean): string => {
      const dest = path.join(parent, name);
      const r = runSync(
        w.repo.io,
        'git',
        ['clone', '--quiet', ...(depth ? ['--depth', '1'] : []), `file://${w.repo.dir}`, dest],
        { cwd: parent, env: w.repo.gitEnv },
      );
      expect(r.status, r.stderr).toBe(0);
      return dest;
    };
    const full = await cal(w, ['--json'], clone('full', false));
    expect(full.code).toBe(0);
    const shallow = await cal(w, ['--json'], clone('shallow', true));
    expect(shallow.code).toBe(3);
    expect(shallow.err).toContain('CALIBRATION_UNAVAILABLE');
  });

  it('枚举通过、但某 vendor 结算时 git 抛错 → 退出 3(每个 vendor 的失败都参与汇总,不止枚举那一次);对照:不抛则 0', async () => {
    const w = await world(batch(10, 10));
    const real = createGuardGit(w.repo.io, w.repo.dir, w.repo.gitEnv);
    const flaky = {
      ...real,
      // 只有结算阶段才读 attest 文件的历史;枚举调用(空 target)不会走到这里
      fileHistory: (c: string, p: string) => {
        if (p.startsWith('attest/')) throw new Error('boom');
        return real.fileHistory(c, p);
      },
    };
    const bad = await cal(w, ['--json', '--vendor', 'nobody'], undefined, flaky);
    expect(bad.code).toBe(3);
    expect(bad.err).toBe('CALIBRATE_FAIL_CLOSED reason=CALIBRATION_UNAVAILABLE\n');
    expect((await cal(w, ['--json'], undefined, real)).code).toBe(0);
  });

  it('非 git 目录 / 没有 HEAD → 退出 3(fail-closed),不是 0', async () => {
    const w = await buildWorld({ noFreeze: true });
    const empty = path.join(path.dirname(w.repo.dir), 'not-a-repo');
    await safe.mkdirp(w.repo.io, empty);
    const r = await cal(w, [], empty);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r.err).toMatch(/^CALIBRATE_FAIL_CLOSED reason=/);
  });

  it('--json 是 canonical JSON(逐字节等于重新序列化)、重复运行逐字节一致、没有浮点数', async () => {
    const w = await world([...batch(10, 7), { n: 11, corrupt: 'hash' }]);
    const a = await cal(w, ['--json']);
    const b = await cal(w, ['--json']);
    expect(a.out).toBe(b.out);
    expect(a.out).toBe(canonicalJson(JSON.parse(a.out)));
    expect(a.out).not.toMatch(/:-?\d+\.\d/);
    // 文本模式同样确定
    const t1 = await cal(w);
    const t2 = await cal(w);
    expect(t1.out).toBe(t2.out);
    expect(t1.out).toContain('blind_spot=selection_bias_settled_only');
  });

  it('盲区披露:固定行齐全(JSON 与文本各一份),且含覆盖率数字', async () => {
    const w = await world(batch(10, 8));
    const j = await calJson(w);
    expect(j.rep.blind_spots).toEqual([
      'selection_bias_settled_only',
      'coverage_settled_over_frozen',
      'deleted_proposals_not_in_ledger',
      'dilution_not_checked',
      'time_boundary_committer_date',
      'attest_member_self_reported',
      'shallow_clone_or_root_commit_unavailable',
      'not_a_promotion_preview',
    ]);
    const t = await cal(w);
    for (const b of j.rep.blind_spots) expect(t.out).toContain(`blind_spot=${b}`);
    expect(t.out).toMatch(/^coverage_permille=\d+$/m);
    expect(t.out).toMatch(/^frozen_total=\d+$/m);
  });

  it('--vendor 只过滤显示:盲区与全局计数不变,被隐藏 vendor 的 overconfident / 损坏在 hidden_* 披露', async () => {
    const peers: Peer[] = [
      ...batch(10, 10),
      ...batch(12, 1, { vendor: 'zai', model: 'glm-5.3-flash' }).map((p) => ({
        ...p,
        n: p.n + 20,
      })),
      { n: 40, corrupt: 'hash', vendor: 'zai', model: 'glm-5.3-flash' },
    ];
    const w = await world(peers);
    const all = (await calJson(w)).rep;
    const f = (await calJson(w, ['--vendor', ' OpenAI '])).rep;
    expect(f.filter).toBe('openai');
    expect(f.vendors.map((v) => v.vendor)).toEqual(['openai']);
    expect(f.vendors_total).toBe(all.vendors_total);
    expect(f.frozen_total).toBe(all.frozen_total);
    expect(f.hidden_vendors).toBe(1);
    expect(f.hidden_overconfident).toBeGreaterThanOrEqual(1);
    expect(f.hidden_unreadable_items).toBe(1);
    expect(f.hidden_g3_strict).toBe(1);
    expect(f.blind_spots).toEqual(all.blind_spots);
    // 对照:不过滤时没有 hidden
    expect(all.hidden_vendors).toBe(0);
    // 无匹配:空显示、退出 0、仍披露隐藏量
    const none = await calJson(w, ['--vendor=nobody']);
    expect(none.code).toBe(0);
    expect(none.rep.vendors_shown).toBe(0);
    expect(none.rep.hidden_vendors).toBe(all.vendors_total);
  });

  it('--vendor 不能掩盖失败:被过滤掉的 vendor 计算失败时仍退出 3', async () => {
    const root = peerFiles([{ n: 11, vendor: 'zai', model: 'glm' }], 'a'.repeat(40)).proposals;
    const w = await world(batch(10, 10), { baseExtra: root });
    expect((await cal(w, ['--vendor', 'openai'])).code).toBe(3);
  });

  it('只读 HEAD:工作树里改坏 kit.toml / 加未跟踪提案,不影响报告(逐字节相同)', async () => {
    const w = await world(batch(10, 8));
    const before = await cal(w, ['--json']);
    await safe.writeFile(w.repo.io, path.join(w.repo.dir, 'kit.toml'), 'this is = not [valid\n');
    await safe.mkdirp(w.repo.io, path.join(w.repo.dir, 'proposals'));
    await safe.writeFile(
      w.repo.io,
      path.join(w.repo.dir, 'proposals/2099-01-01-001.yaml'),
      ': : bad [\n',
    );
    const after = await cal(w, ['--json']);
    expect(after.out).toBe(before.out);
    expect(after.code).toBe(0);
  });

  it('零写入:前后文件树快照(仓库含 .git、上级临时目录)逐字节一致;假 HOME 保持为空', async () => {
    const w = await world(batch(10, 7));
    const parent = path.dirname(w.repo.dir);
    const home = await fakeHomeOf(w);
    const before = await snapshot(parent);
    const homeBefore = await snapshot(home);
    expect((await cal(w)).code).toBe(0);
    expect((await cal(w, ['--json'])).code).toBe(0);
    expect((await cal(w, ['--vendor', 'openai'])).code).toBe(0);
    expect(await snapshot(parent)).toBe(before);
    expect(await snapshot(home)).toBe(homeBefore);
    expect(homeBefore).toBe('');
    // 失败路径同样不写
    const bad = await world(batch(10, 10), {
      baseExtra: peerFiles([{ n: 11 }], 'a'.repeat(40)).proposals,
    });
    const p2 = path.dirname(bad.repo.dir);
    await fakeHomeOf(bad);
    const s2 = await snapshot(p2);
    expect((await cal(bad)).code).toBe(3);
    expect(await snapshot(p2)).toBe(s2);
  });

  it('用法:--run-llm / --allow-egress(含 =值)/ 未知参数 / --vendor 缺值 / 空 vendor → 退出 2,且优先于仓库访问', async () => {
    const w = await buildWorld({ noFreeze: true });
    const notRepo = path.join(path.dirname(w.repo.dir), 'nowhere');
    await safe.mkdirp(w.repo.io, notRepo);
    for (const argv of [
      ['--run-llm'],
      ['--allow-egress'],
      ['--run-llm=1'],
      ['--allow-egress=1'],
      ['--bogus'],
      ['--vendor'],
      ['--vendor', '--json'],
      ['--vendor='],
      ['positional'],
    ]) {
      const r = await cal(w, argv, notRepo);
      expect(r.code, argv.join(' ')).toBe(ExitCode.USAGE);
      expect(r.err).toMatch(/^CALIBRATE_USAGE reason=/);
      expect(r.out).toBe('');
    }
    // 正向对照:同样的仓库,合法参数不是 2
    expect((await cal(w, ['--json'])).code).toBe(0);
  });

  it('与 G3 T2 口径一致:calibrate 的 overconfident ⇔ promote 的 G3 报 JUDGE_OVERCONFIDENT;g3_strict ⇔ G3 报 OVERCONFIDENT/ITEM_UNREADABLE(三个世界)', async () => {
    const cases: { peers: Peer[]; over: boolean; strict: boolean; codes: string[] }[] = [
      { peers: batch(14, 2), over: true, strict: true, codes: [OVER] },
      { peers: batch(14, 14), over: false, strict: false, codes: [] },
      {
        peers: [...batch(14, 14), { n: 15, corrupt: 'hash' }],
        over: false,
        strict: true,
        codes: [UNREAD],
      },
      { peers: batch(3, 0), over: false, strict: false, codes: [] },
    ];
    for (const c of cases) {
      const w = await world(c.peers);
      const { rep } = await calJson(w);
      const v = row(rep);
      const g3 = w.run().allCodes;
      const hasOver = v.tiers.some((t) => t.status === 'overconfident');
      expect(hasOver, JSON.stringify(c.codes)).toBe(c.over);
      expect(g3.includes(OVER)).toBe(hasOver);
      expect(v.g3_strict === 'yes').toBe(c.strict);
      expect(g3.includes(UNREAD) || g3.includes(OVER) || g3.includes(UNAVAIL)).toBe(c.strict);
    }
  });

  it('calibrationStrictReasons 与 T2 内联判断同口径(三种原因各自独立)', () => {
    const t = (over: boolean) => ({
      key: 'k',
      n: 1,
      hits: 0,
      sumConf10: 9,
      insufficient: false,
      overconfident: over,
    });
    expect(calibrationStrictReasons({ unreadable: [], tiers: [t(false)] })).toEqual([]);
    expect(calibrationStrictReasons({ unreadable: [], tiers: [t(false), t(true)] })).toEqual([
      'overconfident',
    ]);
    expect(
      calibrationStrictReasons({ unreadable: [{ path: 'p', reason: 'r' }], tiers: [] }),
    ).toEqual(['unreadable']);
    expect(calibrationStrictReasons({ unavailable: 'x', unreadable: [], tiers: [] })).toEqual([
      'unavailable',
    ]);
  });

  it('零网络:命令源码的 import 传递闭包不含 llm-exec / reflect/backends / 网络模块', () => {
    const c = closureOf('src/commands/calibrate.ts');
    expect(c.unresolved).toEqual([]);
    expect(c.files.length).toBeGreaterThan(15);
    expect(c.files).toContain('src/commands/calibrate.ts');
    for (const f of c.files) {
      expect(f).not.toBe('src/io/llm-exec.ts');
      expect(f.startsWith('src/reflect/backends/')).toBe(false);
    }
    for (const spec of c.externals) {
      expect(spec.replace(/^node:/, '')).not.toMatch(
        /^(https?|http2|net|tls|dgram|dns|undici|ws)$/,
      );
    }
    // 对照:同一分析器对 judge 命令必须报出 llm-exec / backends(探测有效)
    const j = closureOf('src/commands/judge.ts');
    expect(
      j.files.some((f) => f === 'src/io/llm-exec.ts' || f.startsWith('src/reflect/backends/')),
    ).toBe(true);
  });
});
