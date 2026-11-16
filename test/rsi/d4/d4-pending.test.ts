/**
 * D4 / A6「待审」不计已成候选的提案(契约 R21-3.8 段末;设计稿 verify_r21-asm-d-design.md §7)。
 * 数据源 = 候选工作副本 `.state/rsi/candidates/<id>.json` 的 `source`。真实目录、假 HOME / KIT_TMP,不 mock 文件系统。
 * 每条不变量都带正向对照(同一夹具下去掉触发条件,结果必须不同)与负向用例(读失败一律「转化未知」= 不扣减)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readText } from '../../../src/io/read-fs.js';
import { chmod, mkdirp, symlink, writeFile } from '../../../src/io/safe-fs.js';
import { runRsiNotice } from '../../../src/rsi/notice.js';
import {
  convertedCount,
  readConvertedFromState,
  readConvertedProposals,
} from '../../../src/rsi/pending-converted.js';
import {
  scanPending,
  type Classify,
  type PendingScan,
  type ScanDeps,
} from '../../../src/rsi/pending.js';
import { makeA6World, putReport, putRsiFile, proposalIds, reportDoc } from '../a6-fixture.js';
import { treeOf } from '../rsi-fixture.js';
import { NOW, key, makeRoFx, type RoFx } from '../ro-fixture.js';

const allP: Classify = () => 'P';
const RUN = 'r-1';
const entry = (run_id: string, proposals: number) => ({
  run_id,
  proposals,
  evidence_keys: [key(1)],
  tainted: false,
});
const cid = (n: number): string => `ra_${n.toString(16).padStart(12, '0')}`;

/** 合法的工作副本(R21-3.8):只有 `id` 与 `source` 是本测试关心的 */
const copyDoc = (id: string, run: string, proposal: string): Record<string, unknown> => ({
  schema_version: 1,
  id,
  cluster_signature: { kind: 'tool', tool_name: 'Bash' },
  source: { run_id: run, proposal_id: proposal },
  shadow: { sessions: 0, hits: 0, canary_ready_since: null, queued_since: null },
  evidence: { sessions: [], days: [] },
  stats: { sessions_observed: 0, sessions_treat: 0, sessions_control: 0, bytes_injected: 0 },
  repo_removal_deferred: false,
});

const candDir = (f: RoFx): string => path.join(f.io.stateDir, 'rsi', 'candidates');
async function putCopy(f: RoFx, id: string, doc: unknown | string, name = `${id}.json`) {
  await mkdirp(f.io, candDir(f), 0o700);
  const text = typeof doc === 'string' ? doc : JSON.stringify(doc);
  await putRsiFile(f, `candidates/${name}`, text);
}
/** 给 run 的第 i 个提案造一个候选副本 */
async function convert(f: RoFx, n: number, run: string, proposalNo: number): Promise<void> {
  const p = proposalIds(Math.max(proposalNo, 1))[proposalNo - 1] as string;
  await putCopy(f, cid(n), copyDoc(cid(n), run, p));
}

const known = (s: PendingScan): Extract<PendingScan, { known: true }> => {
  if (!s.known) throw new Error(`扫描未知:${s.reason}`);
  return s;
};
const scan = (f: RoFx, proposals: number, deps: ScanDeps = {}, run = RUN) =>
  scanPending(
    {
      stateDir: f.io.stateDir,
      staged: [entry(run, proposals)],
      classify: allP,
      dismissed: new Set<string>(),
      notified: new Set<string>(),
    },
    deps,
  );
const brief = (s: Extract<PendingScan, { known: true }>) => ({
  pending: s.pending.map((r) => [r.runId, r.proposals]),
  toNotify: s.toNotify.map((r) => [r.runId, r.proposals]),
  converted: s.converted,
});

async function world(prefix: string, proposals = 3): Promise<RoFx> {
  const f = await makeRoFx(prefix);
  await putReport(f, RUN, 'ingest', proposals);
  return f;
}

describe('D4 A6:待审不计已成候选的提案', () => {
  it('正向对照:没有候选副本 → 整个 run 待审、待通知,proposals 是原数', async () => {
    const f = await world('d4-pend-ctl-');
    const s = known(await scan(f, 3));
    expect(brief(s)).toEqual({
      pending: [[RUN, 3]],
      toNotify: [[RUN, 3]],
      converted: 'missing',
    });
  });

  it('部分转化:仍待审,proposals 变为剩余数(待审与待通知一致)', async () => {
    const f = await world('d4-pend-part-');
    await convert(f, 1, RUN, 1);
    const s = known(await scan(f, 3));
    expect(brief(s)).toEqual({
      pending: [[RUN, 2]],
      toNotify: [[RUN, 2]],
      converted: 'ok',
    });
  });

  it('全部转化:run 不再待审、不再待通知(但仍是暂存 run);其它 run 的副本不影响本 run', async () => {
    const f = await world('d4-pend-all-');
    await convert(f, 1, RUN, 1);
    await convert(f, 2, RUN, 2);
    await convert(f, 3, RUN, 3);
    const s = known(await scan(f, 3));
    expect(s.staged.map((r) => r.runId)).toEqual([RUN]);
    expect(brief(s)).toEqual({ pending: [], toNotify: [], converted: 'ok' });

    // 对照:同样 3 个副本,但来源是别的 run → 本 run 一个都不扣
    const g = await world('d4-pend-other-');
    // 别的 run 的副本即使提案编号与本 run 的真实编号相同,也不能扣本 run
    for (const n of [1, 2, 3]) {
      await putCopy(g, cid(n), copyDoc(cid(n), 'r-other', proposalIds(3)[n - 1] as string));
    }
    expect(brief(known(await scan(g, 3))).pending).toEqual([[RUN, 3]]);
  });

  it('counts 的提案数与报告暂存编号(去重)个数不一致 → 该 run 转化未知,不扣减(不隐藏未转化的提案);基数一致才扣(对照)', async () => {
    // counts 登记 1 个、报告有 2 个编号,只转化了 -001:若直接相减会得到剩余 0,整个 run(含未转化的 -002)消失
    const f = await world('d4-pend-mismatch-a-', 2);
    await convert(f, 1, RUN, 1);
    expect(brief(known(await scan(f, 1))).pending).toEqual([[RUN, 1]]);
    // counts 登记 3 个、报告只有 2 个编号且都已转化:同样不扣
    const g = await world('d4-pend-mismatch-b-', 2);
    await convert(g, 1, RUN, 1);
    await convert(g, 2, RUN, 2);
    expect(brief(known(await scan(g, 3))).pending).toEqual([[RUN, 3]]);
    // 报告编号重复(去重后 1 个 ≠ counts 的 2 个)
    const h = await makeRoFx('d4-pend-mismatch-c-');
    const dup = reportDoc(RUN, 'ingest', ['2026-10-24-001', '2026-10-24-001']);
    await putReport(h, RUN, 'ingest', 2, `${JSON.stringify(dup)}\n`);
    await convert(h, 1, RUN, 1);
    expect(brief(known(await scan(h, 2))).pending).toEqual([[RUN, 2]]);
    // 对照:基数一致(counts 2、报告 2)→ 转化 -001 后剩 1
    expect(brief(known(await scan(f, 2))).pending).toEqual([[RUN, 1]]);
  });

  it('报告暂存编号里有重复:即使去重个数恰好等于 counts 的提案数也不扣(重复编号 = 报告不可信);对照:无重复时扣减', async () => {
    // counts 登记 1 个;报告 staged = [-001, -001](去重 1 个 = counts,旧口径会认为基数一致,把唯一的待审提案扣没)
    const h = await makeRoFx('d4-pend-dupids-');
    const dup = reportDoc(RUN, 'ingest', ['2026-10-24-001', '2026-10-24-001']);
    await putReport(h, RUN, 'ingest', 1, `${JSON.stringify(dup)}\n`);
    await convert(h, 1, RUN, 1);
    expect(brief(known(await scan(h, 1)))).toEqual({
      pending: [[RUN, 1]],
      toNotify: [[RUN, 1]],
      converted: 'ok',
    });
    // 对照:报告无重复、counts 1 = 编号 1 → 转化后不再待审
    const g = await world('d4-pend-dupids-ctl-', 1);
    await convert(g, 1, RUN, 1);
    expect(brief(known(await scan(g, 1))).pending).toEqual([]);
  });

  it('proposals = 0 的 run 保持改前行为(仍待审)', async () => {
    const z = await world('d4-pend-zero-', 0);
    await convert(z, 1, RUN, 1);
    expect(brief(known(await scan(z, 0))).pending).toEqual([[RUN, 0]]);
  });

  it('没有待审 run(没有暂存 run / 暂存 run 都已忽略)时不读候选目录(即使它不安全也不影响)', async () => {
    const f = await world('d4-pend-nostaged-');
    await convert(f, 1, RUN, 1);
    await chmod(f.io, candDir(f), 0o755);
    const base = {
      stateDir: f.io.stateDir,
      classify: allP,
      notified: new Set<string>(),
    };
    const none = known(await scanPending({ ...base, staged: [], dismissed: new Set<string>() }));
    expect(none.converted).toBe('missing');
    const dismissed = known(
      await scanPending({ ...base, staged: [entry(RUN, 3)], dismissed: new Set([RUN]) }),
    );
    expect(dismissed.converted).toBe('missing');
    // 对照:同一个世界里该 run 待审时才读(目录不安全 → unsafe)
    expect(known(await scan(f, 3)).converted).toBe('unsafe');
  });

  it('工作副本的 source 指向本 run、但提案编号不属于它(误写 / 伪造)→ 不扣减真实提案;对照:编号属于它则扣减', async () => {
    const f = await world('d4-pend-foreign-', 1);
    await putCopy(f, cid(1), copyDoc(cid(1), RUN, '2026-10-24-099')); // 报告里只有 -001
    const conv = await readConvertedProposals(path.join(f.io.stateDir, 'rsi'));
    expect(convertedCount(conv, RUN, proposalIds(1))).toBe(0);
    expect(brief(known(await scan(f, 1)))).toEqual({
      pending: [[RUN, 1]],
      toNotify: [[RUN, 1]],
      converted: 'ok',
    });
    await convert(f, 2, RUN, 1); // 真实编号 -001
    expect(brief(known(await scan(f, 1))).pending).toEqual([]);
  });
});

describe('D4 A6:时间 / 字节预算耗尽 → 回退为旧口径的结果,而不是整个扫描 unknown', () => {
  it('转化读取阶段时间预算用尽:扫描仍 known,待审 / 待通知 = 未扣减的旧结果,converted=budget;预算充足时才扣减(对照)', async () => {
    const f = await world('d4-pend-over-');
    await convert(f, 1, RUN, 1);
    let calls = 0;
    // 第 1 次(读 report 之后)放行,第 2 次(转化读取里)起超时
    const s = known(await scan(f, 3, { over: () => ++calls > 1 }));
    expect(brief(s)).toEqual({ pending: [[RUN, 3]], toNotify: [[RUN, 3]], converted: 'budget' });
    expect(brief(known(await scan(f, 3, { over: () => false }))).pending).toEqual([[RUN, 2]]);
  });

  it('字节预算与报告读取共用同一个总量上限:报告读完只剩 10 字节 → budget、不扣减;余量充足 → 扣减(对照)', async () => {
    const f = await world('d4-pend-bytes-');
    await convert(f, 1, RUN, 1);
    const report = Buffer.byteLength(
      await readText(path.join(f.io.stateDir, 'reflect', RUN, 'report.json')),
    );
    const tight = known(await scan(f, 3, { limits: { maxTotalBytes: report + 10 } }));
    expect(brief(tight)).toEqual({
      pending: [[RUN, 3]],
      toNotify: [[RUN, 3]],
      converted: 'budget',
    });
    const none = known(await scan(f, 3, { limits: { maxTotalBytes: report } })); // 报告恰好用完总量:一个字节都不再读
    expect(brief(none)).toEqual({ pending: [[RUN, 3]], toNotify: [[RUN, 3]], converted: 'budget' });
    const roomy = known(await scan(f, 3, { limits: { maxTotalBytes: report + 1_000_000 } }));
    expect(brief(roomy).pending).toEqual([[RUN, 2]]);
    // 独立的测试缝也生效(取更小者)
    const seam = known(await scan(f, 3, { convertedLimits: { maxTotalBytes: 10 } }));
    expect(seam.converted).toBe('budget');
  });
});

describe('D4 A6:读失败 = 转化未知 = 不扣减(噪音方向,绝不当作已转化)', () => {
  it('候选目录权限过宽(不安全)→ converted=unsafe,整个 run 仍待审;恢复权限后扣减(对照)', async () => {
    const f = await world('d4-pend-unsafe-');
    await convert(f, 1, RUN, 1);
    await chmod(f.io, candDir(f), 0o755);
    expect(brief(known(await scan(f, 3)))).toEqual({
      pending: [[RUN, 3]],
      toNotify: [[RUN, 3]],
      converted: 'unsafe',
    });
    await chmod(f.io, candDir(f), 0o700);
    expect(brief(known(await scan(f, 3))).pending).toEqual([[RUN, 2]]);
  });

  it('候选目录是符号链接 → unsafe,不跟随', async () => {
    const f = await world('d4-pend-link-');
    await mkdirp(f.io, path.join(f.io.stateDir, 'rsi'), 0o700);
    const real = path.join(f.io.stateDir, 'rsi', 'elsewhere');
    await mkdirp(f.io, real, 0o700);
    await writeFile(
      f.io,
      path.join(real, `${cid(1)}.json`),
      JSON.stringify(copyDoc(cid(1), RUN, 'p1')),
      {
        mode: 0o600,
      },
    );
    await symlink(f.io, real, candDir(f));
    expect(brief(known(await scan(f, 3)))).toMatchObject({
      pending: [[RUN, 3]],
      converted: 'unsafe',
    });
  });

  it('`.state/rsi` 本身是指向外部目录的符号链接(外部目录与其 candidates/ 都是 0700、副本合法)→ unsafe,不跟随;对照:同一份外部内容作为真实 rsi 目录时可扣减', async () => {
    const f = await world('d4-pend-rsilink-');
    const ext = path.join(f.io.stateDir, 'ext-rsi');
    await mkdirp(f.io, path.join(ext, 'candidates'), 0o700);
    await chmod(f.io, ext, 0o700);
    await writeFile(
      f.io,
      path.join(ext, 'candidates', `${cid(1)}.json`),
      JSON.stringify(copyDoc(cid(1), RUN, proposalIds(1)[0] as string)),
      { mode: 0o600 },
    );
    // 对照(前提):外部目录本身是合法的 rsi 目录,读取器直接读它 → ok,且该副本能扣掉 -001
    const direct = await readConvertedProposals(ext);
    expect(direct.state).toBe('ok');
    expect(convertedCount(direct, RUN, proposalIds(1))).toBe(1);

    const link = path.join(f.io.stateDir, 'rsi');
    await symlink(f.io, ext, link);
    // 直接读 `<stateDir>/rsi`(链接):读取器自己就拒绝
    expect((await readConvertedProposals(link)).state).toBe('unsafe');
    // 从 stateDir 出发:先验 rsi 目录
    const fromState = await readConvertedFromState(f.io.stateDir);
    expect([fromState.state, fromState.byRun.size]).toEqual(['unsafe', 0]);
    // 经 scanPending:不扣减(整个 run 仍待审、仍待通知)
    expect(brief(known(await scan(f, 3)))).toEqual({
      pending: [[RUN, 3]],
      toNotify: [[RUN, 3]],
      converted: 'unsafe',
    });
  });

  it('`.state/rsi` 不存在 → missing(扣减 0,不是 unsafe);rsi 目录权限过宽 → unsafe', async () => {
    const f = await world('d4-pend-norsi-');
    expect((await readConvertedFromState(f.io.stateDir)).state).toBe('missing');
    await mkdirp(f.io, path.join(f.io.stateDir, 'rsi'), 0o700);
    await chmod(f.io, path.join(f.io.stateDir, 'rsi'), 0o755);
    expect((await readConvertedFromState(f.io.stateDir)).state).toBe('unsafe');
    await chmod(f.io, path.join(f.io.stateDir, 'rsi'), 0o700);
    expect((await readConvertedFromState(f.io.stateDir)).state).toBe('missing'); // 对照:权限收紧后回到「没有候选目录」
  });

  it('坏文件(非 JSON / schema 不过 / 文件名与 id 不符 / 过大)不参与扣减并计入 unreadable;好文件照常扣减', async () => {
    const f = await world('d4-pend-bad-');
    await putCopy(f, cid(1), '{not json');
    await putCopy(f, cid(2), { schema_version: 1, id: cid(2) }); // schema 不过
    await putCopy(f, cid(3), copyDoc(cid(4), RUN, 'p-spoof'), `${cid(3)}.json`); // 文件名 ≠ id
    await putCopy(
      f,
      cid(5),
      `${JSON.stringify(copyDoc(cid(5), RUN, 'p-big'))}${' '.repeat(300 * 1024)}`,
    ); // 过大
    await convert(f, 6, RUN, 1); // 唯一的好副本
    const rsi = path.join(f.io.stateDir, 'rsi');
    const r = await readConvertedProposals(rsi);
    expect(r.state).toBe('ok');
    expect(r.unreadable).toBe(4);
    expect([...(r.byRun.get(RUN) ?? [])]).toEqual([proposalIds(1)[0]]);
    expect(brief(known(await scan(f, 3))).pending).toEqual([[RUN, 2]]);
  });

  it('条目数超过上限 → truncated,不给部分结果(一份都不扣);上限内 → ok(对照)', async () => {
    const f = await world('d4-pend-trunc-');
    await convert(f, 1, RUN, 1);
    await convert(f, 2, RUN, 2);
    const rsi = path.join(f.io.stateDir, 'rsi');
    const cut = await readConvertedProposals(rsi, { limits: { maxEntries: 1 } });
    expect([cut.state, cut.byRun.size]).toEqual(['truncated', 0]);
    const ok = await readConvertedProposals(rsi, { limits: { maxEntries: 2 } });
    expect([ok.state, ok.byRun.get(RUN)?.size]).toEqual(['ok', 2]);
  });

  it('总字节预算 / 调用方时间预算用尽 → budget,不给部分结果', async () => {
    const f = await world('d4-pend-budget-');
    await convert(f, 1, RUN, 1);
    await convert(f, 2, RUN, 2);
    const rsi = path.join(f.io.stateDir, 'rsi');
    const bytes = await readConvertedProposals(rsi, { limits: { maxTotalBytes: 10 } });
    expect([bytes.state, bytes.byRun.size]).toEqual(['budget', 0]);
    const time = await readConvertedProposals(rsi, { over: () => true });
    expect([time.state, time.byRun.size]).toEqual(['budget', 0]);
    expect((await readConvertedProposals(rsi, { over: () => false })).state).toBe('ok');
  });

  it('读取上限在读之前按剩余总量设置:文件恰好等于剩余量 → ok;少 1 字节 → budget(不是坏文件);第二个文件无剩余 → budget', async () => {
    const f = await world('d4-pend-cap-');
    await convert(f, 1, RUN, 1);
    const rsi = path.join(f.io.stateDir, 'rsi');
    const size = Buffer.byteLength(await readText(path.join(candDir(f), `${cid(1)}.json`)));
    const exact = await readConvertedProposals(rsi, { limits: { maxTotalBytes: size } });
    expect([exact.state, exact.unreadable, exact.byRun.get(RUN)?.size]).toEqual(['ok', 0, 1]);
    const less = await readConvertedProposals(rsi, { limits: { maxTotalBytes: size - 1 } });
    expect([less.state, less.unreadable, less.byRun.size]).toEqual(['budget', 0, 0]);
    await convert(f, 2, RUN, 2);
    const second = await readConvertedProposals(rsi, { limits: { maxTotalBytes: size } });
    expect([second.state, second.byRun.size]).toEqual(['budget', 0]);
  });

  it('候选目录里的非副本名(临时文件 / 点文件 / 目录)被忽略,不算坏文件', async () => {
    const f = await world('d4-pend-names-');
    await convert(f, 1, RUN, 1);
    await putCopy(f, 'x', 'noise', 'README.json');
    await putCopy(f, 'x', 'noise', `.${cid(2)}.json.tmp`);
    await mkdirp(f.io, path.join(candDir(f), cid(3)), 0o700);
    const r = await readConvertedProposals(path.join(f.io.stateDir, 'rsi'));
    expect([r.state, r.unreadable, r.byRun.get(RUN)?.size]).toEqual(['ok', 0, 1]);
  });
});

describe('D4 A6:零写入与通知口径', () => {
  it('扫描前后目录树不变(只读)', async () => {
    const f = await world('d4-pend-ro-');
    await convert(f, 1, RUN, 1);
    const before = await treeOf(f.dir);
    await scan(f, 3);
    expect(await treeOf(f.dir)).toEqual(before);
  });

  it('提醒(notice):RSI_PROPOSALS_READY 的 proposals= 是剩余数;全部转化后什么都不提示、不记账', async () => {
    const f = await makeRoFx('d4-pend-notice-');
    const w = await makeA6World(f, [{ runId: RUN, proposals: 3 }], { baselinePending: true });
    void w;
    await convert(f, 1, RUN, 1);
    const run = async (): Promise<{ kind: string; err: string[] }> => {
      const err: string[] = [];
      const out = await runRsiNotice(
        { argv: ['status'], env: f.env, isTty: true, stderr: (t) => void err.push(t) },
        { now: () => new Date(NOW), clockMs: () => 0 },
      );
      return { kind: out.kind, err };
    };
    expect(await run()).toEqual({
      kind: 'printed',
      err: ['RSI_PROPOSALS_READY runs=1 proposals=2\n'],
    });

    // 对照 / 负向:另一个世界里 3 个提案全部成候选 → nothing,stderr 空
    const g = await makeRoFx('d4-pend-notice-all-');
    await makeA6World(g, [{ runId: RUN, proposals: 3 }], { baselinePending: true });
    for (const n of [1, 2, 3]) await convert(g, n, RUN, n);
    const err: string[] = [];
    const out = await runRsiNotice(
      { argv: ['status'], env: g.env, isTty: true, stderr: (t) => void err.push(t) },
      { now: () => new Date(NOW), clockMs: () => 0 },
    );
    expect([out.kind, err]).toEqual(['nothing', []]);
  });
});
