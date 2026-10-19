/**
 * K4:G3 冻结核验 + 按块覆盖(设计 §3.2 的 W4–W12、W15–W17;W13 在 test/commands/attest-tile.test.ts,W14 在 test/commands/promote-frozen.test.ts)。
 * 全部用合成仓库(真 git 提交、按日期造历史),每个负向断言旁有正向对照。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addDays } from '../../src/atoms/dates.js';
import { guidanceSha256, signatureSha256 } from '../../src/judge/freeze.js';
import {
  PATH,
  PID,
  PROPOSAL_PATH,
  atomText,
  attestFile,
  digestOf,
  kitToml,
  recordFile,
} from './criteria-world.js';
import { buildWorld, GUIDANCE, twoTiles, type AttestSpec, type WorldOpts } from './frozen-world.js';
import { useRepoCleanup } from './helpers.js';

useRepoCleanup();

const G = (c: string): string => `GUARD_G3_${c}`;
const NC = G('ATTEST_NOT_COUNTED');
const D0 = '2026-10-06';
const win = (k: number, off = 0): { start: string; end: string } => ({
  start: addDays(D0, 7 * k + off),
  end: addDays(D0, 7 * k + off + 6),
});
const pair = (k: number, extra: Partial<AttestSpec> = {}): AttestSpec[] => [
  { member: '@alice', tile: k, ...extra },
  { member: '@bob', tile: k, ...extra },
];
const sha64 = (c: string): string => c.repeat(64);

const LIFECYCLE_BASE =
  '[lifecycle]\ncanary_window_days = 14\nmin_members = 2\nmin_non_owner_members = 1\nmin_exposure_sessions = 10\nmax_harmful = 0\nno_exposure_windows = 2';

async function runWorld(o: WorldOpts = {}) {
  const w = await buildWorld(o);
  const r = w.run();
  const reasons = r.diagnostics.filter((d) => d.code === NC).map((d) => d.message);
  return { w, r, codes: r.codes, reasons };
}

describe('K4 冻结核验:基线与口径', () => {
  it('合法对照:冻结在基线历史里、两名成员各交块 0 与块 1 → 绿,且没有任何 warn', async () => {
    const { w, r } = await runWorld();
    expect(w.d0).toBe(D0);
    expect(r.codes).toEqual([]);
    // 唯一的诊断是 K5a 的「校准样本不足,不加严」提示(基线里没有别的已结算预测)
    expect(r.diagnostics.map((d) => d.code)).toEqual([G('CALIBRATION_INSUFFICIENT')]);
  });

  it('W4 对齐:window_start = D0+1 不计入,D0+7 计入;长度不是 tile_days 不计入', async () => {
    const shifted = await runWorld({
      attests: [...pair(0), ...pair(1, { start: win(1, 1).start, end: win(1, 1).end })],
    });
    expect(shifted.codes).toEqual([NC, G('THRESHOLD_TILES')].sort());
    expect(shifted.reasons.join('|')).toContain('没有对齐');
    // 对照:同一份文件改成 D0+7 → 计入
    expect((await runWorld({ attests: [...pair(0), ...pair(1)] })).codes).toEqual([]);

    const short = await runWorld({
      attests: [...pair(0), ...pair(1, { start: win(1).start, end: win(1, -1).end })],
    });
    expect(short.codes).toEqual([NC, G('THRESHOLD_TILES')].sort());
    expect(short.reasons.join('|')).toContain('窗口长度');
  });

  it('W4 k < max_tiles:k = max_tiles 不计入,k = max_tiles−1 计入', async () => {
    const late = { commitDate: '2026-11-12' }; // 窗口结束之后才入库,避开「未来窗口」条件
    const over = await runWorld({ attests: [...pair(0), ...pair(4, late)] });
    expect(over.codes).toEqual([NC, G('THRESHOLD_TILES')].sort());
    expect(over.reasons.join('|')).toContain('max_tiles');
    const edge = await runWorld({ attests: [...pair(0), ...pair(3, late)] });
    expect(edge.codes).toEqual([]);
  });

  it('W4 早于 D0:window_start < D0 的窗口不计入(此时 advisory/textSince 都不拦,只有 D0 在拦)', async () => {
    const dates = { rule: '2026-09-18', proposal: '2026-09-19', advisory: '2026-09-20' };
    const before = await runWorld({
      dates,
      attests: [...pair(0), ...pair(-1, { commitDate: '2026-10-27' })].map((s) =>
        s.tile === -1 ? { ...s, tile: undefined, start: win(-1).start, end: win(-1).end } : s,
      ),
    });
    expect(before.codes).toEqual([NC, G('THRESHOLD_TILES')].sort());
    expect(before.reasons.join('|')).toContain('D0');
    // 对照:同一时间线下换成块 1 → 绿
    expect((await runWorld({ dates, attests: [...pair(0), ...pair(1)] })).codes).toEqual([]);
  });

  it('W5 textSince(F4 回归):规则正文在 advisory 期间被改,改动之前的窗口不计入;之后的窗口计入', async () => {
    const final = atomText({ status: 'advisory' });
    const editedAt = '2026-10-20';
    const world = (attests: AttestSpec[]): WorldOpts => ({
      earlierBody: '**做**:旧版正文。\n**为什么**:旧。\n**怎么验**:旧。\n',
      afterAdvisory: async ({ commitAt }) => {
        await commitAt({ [PATH]: final }, editedAt, 'content PR');
      },
      attests,
    });
    // 洞:块 0/块 1 的窗口(10-06…10-19)早于改动日,按旧口径(advisorySince=10-06)它们都「合法」
    const old = await runWorld(world([...pair(0), ...pair(1)]));
    expect(old.codes).toEqual([NC, G('THRESHOLD_EXPOSURE'), G('THRESHOLD_TILES')].sort());
    expect(old.reasons.join('|')).toContain('textSince');
    // 对照:改动日及之后的块 2、块 3 计入
    const ok = await runWorld(world([...pair(2), ...pair(3, { commitDate: '2026-11-03' })]));
    expect(ok.codes).toEqual([]);
  });

  it('W5 回退:X→Y→X 时 textSince 取最近一次回到当前文本的日期', async () => {
    const other = atomText({
      status: 'advisory',
      body: '**做**:中间版本。\n**为什么**:中。\n**怎么验**:中。\n',
    });
    const back = atomText({ status: 'advisory' });
    const hooks: Pick<WorldOpts, 'afterAdvisory'> = {
      afterAdvisory: async ({ commitAt }) => {
        await commitAt({ [PATH]: other }, '2026-10-12', 'Y');
        await commitAt({ [PATH]: back }, '2026-10-20', 'back to X');
      },
    };
    // 块 0/1(10-06…10-19)在回退之前:不计入;块 2/3 计入
    expect((await runWorld({ ...hooks, attests: [...pair(0), ...pair(1)] })).codes).toEqual(
      [NC, G('THRESHOLD_EXPOSURE'), G('THRESHOLD_TILES')].sort(),
    );
    expect(
      (
        await runWorld({
          ...hooks,
          attests: [...pair(2), ...pair(3, { commitDate: '2026-11-03' })],
        })
      ).codes,
    ).toEqual([]);
  });

  it('TEXT_SINCE_UNKNOWN:晋升 PR 自己改了规则正文 → 基线历史里没有当前文本的首次出现 → fail-closed', async () => {
    const r = await runWorld({
      headExtra: () => ({
        [PATH]: atomText({
          status: 'active',
          review_by: '2027-02-08',
          body: '**做**:PR 里改的正文。\n**为什么**:x。\n**怎么验**:x。\n',
        }),
      }),
    });
    expect(r.codes).toContain(G('TEXT_SINCE_UNKNOWN'));
    // 对照:不改正文 → 无此码
    expect((await runWorld()).codes).not.toContain(G('TEXT_SINCE_UNKNOWN'));
  });

  it('W6 acceptance_sha256:不符/缺失的 attest 不计入;相符的计入', async () => {
    for (const bind of [sha64('f'), false] as const) {
      const r = await runWorld({
        attests: [...pair(0), { member: '@alice', tile: 1 }, { member: '@bob', tile: 1, bind }],
      });
      expect(r.codes, String(bind)).toEqual([NC, G('THRESHOLD_TILES')].sort());
      expect(r.reasons.join('|')).toContain('acceptance_sha256');
    }
    expect((await runWorld()).codes).toEqual([]);
  });

  it('W7 attest 在冻结提交之前入库(拓扑更早)→ 不计入;同样的文件在冻结之后入库 → 计入', async () => {
    const early = await runWorld({ attests: [...pair(0, { in: 'early' }), ...pair(1)] });
    expect(early.codes).toEqual([NC, G('THRESHOLD_TILES')].sort());
    expect(early.reasons.join('|')).toContain('不晚于冻结提交');
    expect((await runWorld({ attests: [...pair(0), ...pair(1)] })).codes).toEqual([]);
  });

  it('未来窗口:attest 的入库日期早于窗口结束 → 不计入;窗口结束后入库 → 计入', async () => {
    // 块 3 = 10-27…11-02;10-27 入库 = 窗口还没结束
    const fut = await runWorld({ attests: [...pair(0), ...pair(3, { commitDate: '2026-10-27' })] });
    expect(fut.codes).toEqual([NC, G('THRESHOLD_TILES')].sort());
    expect(fut.reasons.join('|')).toContain('预先提交了未来窗口');
    const ok = await runWorld({ attests: [...pair(0), ...pair(3, { commitDate: '2026-11-03' })] });
    expect(ok.codes).toEqual([]);
  });
});

describe('K4 冻结核验:层 1 内容哈希(W9)与 W3', () => {
  const HASH = G('ACCEPTANCE_HASH_MISMATCH');
  const cases: [string, WorldOpts][] = [
    ['签名哈希', { tamper: (a) => ({ ...a, signature_sha256: sha64('a') }) }],
    ['基线哈希', { tamper: (a) => ({ ...a, baseline_sha256: sha64('b') }) }],
    ['规则哈希', { tamper: (a) => ({ ...a, rule_sha256: sha64('c') }) }],
    [
      '手改 reflector.guidance.baseline(acceptance 不动)',
      {
        guidanceInFile: {
          ...GUIDANCE,
          baseline: { sessions_total: 40, exposure_sessions: 30, fired: 31 },
        },
      },
    ],
    [
      '基线不自洽(exposure > fired),哈希与文件同步改',
      {
        tamper: (a) => ({
          ...a,
          baseline_sha256: guidanceSha256({
            ...GUIDANCE,
            baseline: { sessions_total: 40, exposure_sessions: 10, fired: 5 },
          }),
        }),
        guidanceInFile: {
          ...GUIDANCE,
          baseline: { sessions_total: 40, exposure_sessions: 10, fired: 5 },
        },
      },
    ],
    [
      'W3 自哈希:改 tile_days 却不重算 sha256',
      { rehash: false, tamper: (a) => ({ ...a, tile_days: 8 }) },
    ],
    [
      'prediction.acceptance_sha256 对不上',
      { tamperPrediction: (p) => ({ ...p, acceptance_sha256: sha64('d') }) },
    ],
  ];
  for (const [name, opts] of cases) {
    it(`${name} → ACCEPTANCE_HASH_MISMATCH`, async () => {
      const r = await runWorld(opts);
      expect(r.codes).toContain(HASH);
    });
  }

  it('单点篡改只报该码(签名/基线哈希,自哈希已按新内容重算 = 自洽);默认世界对照为绿', async () => {
    expect((await runWorld(cases[0]![1])).codes).toEqual([HASH]);
    expect((await runWorld(cases[1]![1])).codes).toEqual([HASH]);
    expect((await runWorld()).codes).toEqual([]);
  });

  it('签名真的改了(原子换成 tool 型签名)→ 与冻结的 signature_sha256 不符', async () => {
    const r = await runWorld({
      earlierBody: undefined,
      headExtra: () => ({
        [PATH]: atomText({ status: 'active', review_by: '2027-02-08' }).replace(
          'signature:\n  type: always',
          'signature:\n  type: tool\n  pattern: Bash',
        ),
      }),
      // 冻结时用的是 always 签名;当前原子改签名需要在基线历史里:用钩子提交带 tool 签名的 advisory 原子
      afterAdvisory: async ({ commitAt }) => {
        const t = atomText({ status: 'advisory' }).replace(
          'signature:\n  type: always',
          'signature:\n  type: tool\n  pattern: Bash',
        );
        await commitAt({ [PATH]: t }, '2026-10-08', 'sig change');
      },
      atom: {},
    });
    expect(r.codes).toContain(HASH);
  });

  it('signatureSha256 对象口径:无签名与 always 的哈希不同(防把「无签名」当成「always」)', () => {
    expect(signatureSha256(undefined)).not.toBe(signatureSha256({ type: 'always' }));
  });
});

describe('K4 冻结核验:层 2 git 锚点(W8、W11、W17)', () => {
  const CLOCK = G('ACCEPTANCE_CLOCK_INCONSISTENT');
  const UNKNOWN = G('FREEZE_COMMIT_UNKNOWN');

  it('W8 guidance_until > frozen_at → ACCEPTANCE_CLOCK_INCONSISTENT(哈希与文件同步改,只剩时钟问题)', async () => {
    const g = { ...GUIDANCE, until: '2026-10-05T11:00:00Z' }; // frozen_at = 10-05T10:00Z
    const bad = await runWorld({
      tamper: (a) => ({ ...a, guidance_until: g.until, baseline_sha256: guidanceSha256(g) }),
      guidanceInFile: g,
    });
    expect(bad.codes).toEqual([CLOCK]);
    // 对照:guidance_until 恰等于 frozen_at 合法
    const eq = { ...GUIDANCE, until: '2026-10-05T10:00:00Z' };
    const ok = await runWorld({
      tamper: (a) => ({ ...a, guidance_until: eq.until, baseline_sha256: guidanceSha256(eq) }),
      guidanceInFile: eq,
    });
    expect(ok.codes).toEqual([]);
  });

  it('W8 frozen_at 晚于冻结提交日期 → CLOCK;晚 1 天(时区差)仍放行', async () => {
    const bad = await runWorld({ tamper: (a) => ({ ...a, frozen_at: '2026-10-09T10:00:00Z' }) });
    expect(bad.codes).toContain(CLOCK);
    const tz = await runWorld({ tamper: (a) => ({ ...a, frozen_at: '2026-10-06T01:00:00Z' }) });
    expect(tz.codes).not.toContain(CLOCK);
  });

  it('W17 judged_at_head:不在冻结提交祖先线上 / 不存在 / 早于提案上一版 → CLOCK;默认(提案上一版之后)对照为绿', async () => {
    let side = '';
    const withSide: Pick<WorldOpts, 'beforeFreeze'> = {
      beforeFreeze: async ({ repo, commitAt }) => {
        const cur = repo.git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
        repo.branch('side', 'HEAD~1');
        side = await commitAt({ 'side.txt': 'x' }, '2026-10-03', 'side');
        repo.git(['checkout', '--quiet', cur]);
      },
    };
    const notAncestor = await runWorld({
      ...withSide,
      tamper: (a) => ({ ...a, judged_at_head: side }),
    });
    expect(notAncestor.codes).toEqual([CLOCK]);
    const missing = await runWorld({ tamper: (a) => ({ ...a, judged_at_head: '1'.repeat(40) }) });
    expect(missing.codes).toEqual([CLOCK]);
    expect((await runWorld(withSide)).codes).toEqual([]);
  });

  it('W17 提案在冻结提交里首次入库(没有「提案上一版」)时,judged_at_head 仍须是冻结提交的严格祖先', async () => {
    let side = '';
    const common: WorldOpts = {
      noReflectCommit: true,
      beforeFreeze: async ({ repo, commitAt }) => {
        const cur = repo.git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
        repo.branch('side', 'HEAD');
        side = await commitAt({ 'side.txt': 'x' }, '2026-10-03', 'side');
        repo.git(['checkout', '--quiet', cur]);
      },
    };
    const bad = await runWorld({ ...common, tamper: (a) => ({ ...a, judged_at_head: side }) });
    expect(bad.codes).toEqual([CLOCK]);
    expect((await runWorld(common)).codes).toEqual([]); // 对照
  });

  it('W17 judged_at_head 填成根提交 → 早于提案上一版 → CLOCK', async () => {
    let rootOid = '';
    const r = await runWorld({
      beforeFreeze: async ({ repo }) => {
        rootOid = repo.git(['rev-list', '--max-parents=0', 'HEAD']).trim();
      },
      tamper: (a) => ({ ...a, judged_at_head: rootOid }),
    });
    expect(r.codes).toEqual([CLOCK]);
  });

  it('W17 冻结只在晋升 PR 里(基线历史里没有 acceptance)→ FREEZE_COMMIT_UNKNOWN,不是静默放行', async () => {
    const pr = await runWorld({ freezeInHead: true });
    expect(pr.codes).toContain(UNKNOWN);
    expect((await runWorld()).codes).not.toContain(UNKNOWN);
  });

  it('W11 浅历史:冻结提交所在的历史被截断 → FREEZE_COMMIT_UNKNOWN(而不是把浅边界当冻结提交放行)', async () => {
    const w = await buildWorld();
    expect(w.run().codes).toEqual([]); // 对照:完整历史绿
    const shallow = path.join(path.dirname(w.repo.dir), 'shallow');
    w.repo.git(['clone', '--quiet', '--depth', '2', `file://${w.repo.dir}`, shallow]);
    const r = w.run({ base: w.baseOid, head: w.headOid, cwd: shallow });
    expect(r.codes).toContain(UNKNOWN);
    expect(r.diagnostics.some((d) => d.severity === 'error')).toBe(true);
  });

  it('PREDICTION_CHANGED_AFTER_FREEZE:冻结之后 prediction 被改(acceptance 不动);未改对照为绿', async () => {
    const r = await runWorld({
      afterAdvisory: async ({ repo, commitAt }) => {
        const text = repo.git(['show', `HEAD:${PROPOSAL_PATH}`]);
        expect(text.split('not_measurable').length - 1).toBe(1);
        await commitAt(
          { [PROPOSAL_PATH]: text.replace('not_measurable', 'baseline_insufficient') },
          '2026-10-10',
          'edit prediction',
        );
      },
    });
    expect(r.codes).toEqual([G('PREDICTION_CHANGED_AFTER_FREEZE')]);
    expect((await runWorld()).codes).toEqual([]);
  });

  it('ACCEPTANCE_CHANGED_AFTER_FREEZE:晋升 PR 改了基线里已冻结的 acceptance(哪怕自哈希对不上也先报这条);未改对照为绿', async () => {
    const r = await runWorld({
      headExtra: ({ proposalYaml }) => {
        expect(proposalYaml.split('tile_days: 7').length - 1).toBe(1);
        return { [PROPOSAL_PATH]: proposalYaml.replace('tile_days: 7', 'tile_days: 8') };
      },
    });
    expect(r.codes).toContain(G('ACCEPTANCE_CHANGED_AFTER_FREEZE'));
    expect((await runWorld()).codes).not.toContain(G('ACCEPTANCE_CHANGED_AFTER_FREEZE'));
  });

  it('重跑 judge(同一规则文本再冻结):不误杀,只记 warn ACCEPTANCE_REFROZEN;旧协议下的 attest 不计入、新协议下的计入', async () => {
    const dates = { freeze: '2026-10-05', advisory: '2026-10-06' };
    // 第二次冻结在 10-07 → D0 = 10-08;块 0 = 10-08…10-14
    const r = await runWorld({
      dates,
      refreeze: '2026-10-07',
      attests: [
        // 按新协议的 D0 对齐
        ...pair(0),
        ...pair(1),
      ],
    });
    expect(r.codes).toEqual([G('ACCEPTANCE_REFROZEN')]);
    expect(r.r.diagnostics.find((d) => d.code === G('ACCEPTANCE_REFROZEN'))?.severity).toBe('warn');
    expect(r.w.d0).toBe('2026-10-08');
  });

  it('W12 旧 judge 记录(没有 acceptance)→ ACCEPTANCE_MISSING;补跑 judge 后同一原子正常进入分块计数,且不是「重冻结」', async () => {
    expect((await runWorld({ noFreeze: true })).codes).toEqual([G('ACCEPTANCE_MISSING')]);
    // 补跑:先有一次没有 acceptance 的旧 judge 提交,之后重跑 judge 加上冻结
    const rejudge = await runWorld({
      beforeFreeze: async ({ repo, commitAt }) => {
        const text = repo.git(['show', `HEAD:${PROPOSAL_PATH}`]);
        void text;
        const { proposalYaml } = await import('./criteria-world.js');
        await commitAt(
          {
            [PROPOSAL_PATH]: proposalYaml(atomText({ status: 'proposed' }), { guidance: GUIDANCE }),
          },
          '2026-10-03',
          'old judge',
        );
      },
    });
    expect(rejudge.codes).toEqual([]);
    expect(rejudge.r.diagnostics.map((d) => d.code)).toEqual([G('CALIBRATION_INSUFFICIENT')]);
  });
});

describe('K4 冻结核验:层 3 与基线阈值(W10)', () => {
  const WEAKER = G('ACCEPTANCE_WEAKER_THAN_CORE');
  const kit = (extra: string): string => kitToml({ lifecycle: `${LIFECYCLE_BASE}\n${extra}` });

  it('W10 冻结的 tile_days 低于基线 kit.toml 的现值 → ACCEPTANCE_WEAKER_THAN_CORE;等于现值对照为绿', async () => {
    const weak = await runWorld({ kit: kit('acceptance_tile_days = 8\nacceptance_max_tiles = 4') });
    expect(weak.codes).toEqual([WEAKER]);
    expect(
      (await runWorld({ kit: kit('acceptance_tile_days = 7\nacceptance_max_tiles = 4') })).codes,
    ).toEqual([]);
  });

  it('W10 冻结的 max_tiles 高于基线现值 → WEAKER;等于对照为绿', async () => {
    expect(
      (await runWorld({ kit: kit('acceptance_tile_days = 7\nacceptance_max_tiles = 3') })).codes,
    ).toEqual([WEAKER]);
    expect(
      (await runWorld({ kit: kit('acceptance_tile_days = 7\nacceptance_max_tiles = 4') })).codes,
    ).toEqual([]);
  });
});

describe('K4 按块覆盖(W16)', () => {
  it('W16 A 只交块 0、B 只交块 1 → 没有一块被两人同时验过 → THRESHOLD_TILES;A、B 都交块 0 与块 1 → 绿', async () => {
    const split = await runWorld({
      attests: [
        { member: '@alice', tile: 0 },
        { member: '@bob', tile: 1 },
      ],
    });
    expect(split.codes).toEqual([G('THRESHOLD_EXPOSURE'), G('THRESHOLD_TILES')]);
    expect((await runWorld()).codes).toEqual([]);
  });

  it('块内非 owner 门槛:一块只有 owner 与另一名 owner 以外成员才有效;owner 单独不算', async () => {
    // 块 0:owner + alice(有效);块 1:只有 owner(无效) → 1 个有效块 < 2
    const r = await runWorld({
      attests: [
        { member: '@owner-handle', tile: 0 },
        { member: '@alice', tile: 0 },
        { member: '@owner-handle', tile: 1 },
      ],
    });
    expect(r.codes).toEqual([G('THRESHOLD_TILES')]);
    const ok = await runWorld({
      attests: [
        { member: '@owner-handle', tile: 0 },
        { member: '@alice', tile: 0 },
        { member: '@owner-handle', tile: 1 },
        { member: '@bob', tile: 1 },
      ],
    });
    expect(ok.codes).toEqual([]);
  });

  it('exposure 只在有效块上合计:无效块里的曝光不能凑数', async () => {
    const strict = kitToml({
      lifecycle: LIFECYCLE_BASE.replace('min_exposure_sessions = 10', 'min_exposure_sessions = 50'),
    });
    // 有效块 0、1 共 40;块 2 只有 alice(无效)的 100 不计 → 仍不足
    const r = await runWorld({
      kit: strict,
      attests: [...twoTiles(), { member: '@alice', tile: 2, exposure: 40 }],
    });
    expect(r.codes).toEqual([G('THRESHOLD_EXPOSURE')]);
    // 对照:bob 也交块 2 → 块 2 有效 → 140 ≥ 50
    const ok = await runWorld({
      kit: strict,
      attests: [
        ...twoTiles(),
        { member: '@alice', tile: 2, exposure: 40 },
        { member: '@bob', tile: 2 },
      ],
    });
    expect(ok.codes).toEqual([]);
  });

  it('同成员同块多份 attest 不重复累计 exposure(同窗口取 run_id 最新的一份)', async () => {
    const strict = kitToml({
      lifecycle: LIFECYCLE_BASE.replace('min_exposure_sessions = 10', 'min_exposure_sessions = 50'),
    });
    const dup = await runWorld({
      kit: strict,
      attests: [
        ...twoTiles(),
        { member: '@alice', tile: 0, run: 'run-20261020T000000Z-aaaaaa', exposure: 10 },
        { member: '@alice', tile: 0, run: 'run-20261021T000000Z-bbbbbb', exposure: 10 },
      ],
    });
    expect(dup.codes).toEqual([G('THRESHOLD_EXPOSURE')]);
  });

  it('harmful 取全部计入的 attest(含无效块)——比设计稿「只在有效块合计」更严,防止有害证据被静默丢弃', async () => {
    const r = await runWorld({
      attests: [...twoTiles(), { member: '@alice', tile: 2, harmful: 1 }],
    });
    expect(r.codes).toEqual([G('THRESHOLD_HARMFUL')]);
    expect((await runWorld()).codes).toEqual([]);
  });

  it('有效块数需求随 tile_days 变:tile_days=14 时 1 个有效块即够(ceil(14/14)=1)', async () => {
    const kit14 = kitToml({
      lifecycle: `${LIFECYCLE_BASE}\nacceptance_tile_days = 14\nacceptance_max_tiles = 2`,
    });
    const r = await runWorld({
      kit: kit14,
      tileDays: 14,
      maxTiles: 2,
      attests: [
        { member: '@alice', tile: 0, commitDate: '2026-10-27' },
        { member: '@bob', tile: 0 },
      ],
    });
    expect(r.codes).toEqual([]);
  });
});

describe('W15 退役口径隔离:retire 的 no_exposure / harmful 仍用原 countable', () => {
  const retireWorld = (attests: AttestSpec[], extra: Partial<WorldOpts> = {}): WorldOpts => ({
    headStatus: 'deprecated',
    label: 'kit:retire',
    attests,
    headExtra: ({ advisoryAtom, attestFiles }) => {
      const digests = Object.values(attestFiles).map(digestOf);
      const [p, t] = recordFile(advisoryAtom, { reason: 'harmful', digests });
      return { [p]: t };
    },
    ...extra,
  });

  it('不对齐、没有 acceptance_sha256、也没有冻结(旧 judge 记录)的 attest 仍可作为 harmful 退役证据;同一批 attest 在 T2 里一份也不计入', async () => {
    const attests: AttestSpec[] = [
      { member: '@alice', start: '2026-10-08', end: '2026-10-13', harmful: 1, bind: false },
      { member: '@bob', start: '2026-10-09', end: '2026-10-12', bind: false },
    ];
    const retire = await runWorld(retireWorld(attests, { noFreeze: true }));
    expect(retire.codes).toEqual([]);
    // 同一批 attest 走晋升(T2):全部不计入
    const promo = await runWorld({ attests, noFreeze: false });
    expect(promo.codes).toEqual([NC, G('THRESHOLD_EXPOSURE'), G('THRESHOLD_TILES')].sort());
    expect(promo.r.diagnostics.filter((d) => d.code === NC)).toHaveLength(2);
  });

  it('W5 的另一面:规则正文被改之前的窗口,T2 不计入,retire 的 harmful 证据照样计入(退役是安全方向)', async () => {
    const final = atomText({ status: 'advisory' });
    const hooks: Partial<WorldOpts> = {
      earlierBody: '**做**:旧版正文。\n**为什么**:旧。\n**怎么验**:旧。\n',
      afterAdvisory: async ({ commitAt }) => {
        await commitAt({ [PATH]: final }, '2026-10-20', 'content PR');
      },
    };
    const early: AttestSpec[] = [
      { member: '@alice', tile: 0, harmful: 1 },
      { member: '@bob', tile: 0 },
    ];
    expect((await runWorld(retireWorld(early, hooks))).codes).toEqual([]);
    expect((await runWorld({ ...hooks, attests: [...pair(0), ...pair(1)] })).codes).toContain(
      G('THRESHOLD_TILES'),
    );
  });

  it('对照:retire 的 no_exposure 理由要求每个被引用的窗口都在 countable 里——仍然生效', async () => {
    const attests: AttestSpec[] = [
      { member: '@alice', tile: 0, exposure: 0, harmful: 0 },
      { member: '@bob', tile: 1, exposure: 0 },
    ];
    const r = await runWorld({
      headStatus: 'deprecated',
      label: 'kit:retire',
      attests,
      headExtra: ({ advisoryAtom, attestFiles }) => {
        const [p, t] = recordFile(advisoryAtom, {
          reason: 'no_exposure',
          digests: Object.values(attestFiles).map(digestOf),
        });
        return { [p]: t };
      },
    });
    expect(r.codes).toEqual([]);
    void attestFile;
    void PID;
  });
});
