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
import { convertedCount, readConvertedProposals } from '../../../src/rsi/pending-converted.js';
import {
  scanPending,
  type Classify,
  type PendingScan,
  type ScanDeps,
} from '../../../src/rsi/pending.js';
import { makeA6World, putReport, putRsiFile, proposalIds } from '../a6-fixture.js';
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

  it('counts 的提案数小于报告里的真实编号数(不一致)→ 剩余数下限 0,不出现负数;proposals = 0 的 run 保持改前行为(仍待审)', async () => {
    const f = await world('d4-pend-clamp-', 3); // 报告暂存 3 个编号,counts 却只登记 1 个
    for (const n of [1, 2, 3]) await convert(f, n, RUN, n);
    expect(brief(known(await scan(f, 1))).pending).toEqual([]);
    const conv = await readConvertedProposals(path.join(f.io.stateDir, 'rsi'));
    expect(convertedCount(conv, RUN, proposalIds(3))).toBe(3);

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
