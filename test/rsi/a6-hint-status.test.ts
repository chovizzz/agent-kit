/**
 * R20-A6:hint 的 M 改口径与满区单行(R20-17.16 / R20-17.17;订正 ③ ⑥ ⑦)、status 的追加字段与「扫描未知」映射(R20-17.18 / R20-17.4a)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RSI_HINT_STAGING_FULL_LINE, RSI_STAGING_MAX_RUNS } from '../../src/contracts/rsi.js';
import { runHint, type RunHintDeps } from '../../src/rsi/hint.js';
import { runStatus, type StatusDoc } from '../../src/rsi/status.js';
import { mkdirp, symlink } from '../../src/io/safe-fs.js';
import type { AuditCall } from '../helpers/write-audit.js';
import { dismissedDoc, makeA6World, putReport, putRsiFile, reportDoc } from './a6-fixture.js';
import { NOW, makeRoFx, runDirect, setExtra, type RoFx } from './ro-fixture.js';

const NOW_MS = Date.parse(NOW);

async function hint(f: RoFx, nowMs = NOW_MS): Promise<{ out: string; audit: AuditCall[] }> {
  const audit: AuditCall[] = [];
  const deps: RunHintDeps = {
    env: f.env,
    writeAudit: (op, p) => void audit.push({ op, path: p }),
    now: () => new Date(nowMs),
    clockMs: () => 0,
  };
  return { out: await runHint(['--agent', 'claude'], deps), audit };
}
const status = async (f: RoFx): Promise<StatusDoc> =>
  JSON.parse(
    (await runDirect(f, runStatus, ['--json'], { now: () => new Date(NOW) })).out,
  ) as StatusDoc;
const reflectRoot = (f: RoFx): string => path.join(f.io.stateDir, 'reflect');
const padDirs = async (f: RoFx, n: number, prefix = 'pad'): Promise<void> => {
  for (let i = 0; i < n; i++)
    await mkdirp(f.io, path.join(reflectRoot(f), `${prefix}-${String(i).padStart(4, '0')}`), 0o755);
};

describe('R20-17.16 hint 的 M = 待审 run 里的提案数(订正 ③ ⑦)', () => {
  it('只计待审:可读 report 的暂存 run 计入;已忽略 / report 缺失 / run_id 不符不计;与 status.pending_proposals 对拍', async () => {
    const f = await makeRoFx('a6-hs-m-');
    await makeA6World(f, [
      { runId: 'r-ok', proposals: 2 },
      { runId: 'r-dis', proposals: 3 },
      { runId: 'r-nodir', proposals: 5, report: false },
      { runId: 'r-mis', proposals: 7, report: false },
    ]);
    await putReport(
      f,
      'r-mis',
      'ingest',
      7,
      `${JSON.stringify(reportDoc('r-else', 'ingest', ['2026-10-24-001']))}\n`,
    );
    await putRsiFile(f, 'dismissed.json', dismissedDoc(['r-dis']));
    const h = await hint(f);
    expect(h.out).toContain('待审提案 2、');
    expect((await status(f)).counts.pending_proposals).toBe(2);
    expect((await status(f)).counts.staged_proposals).toBe(2 + 3 + 5 + 7); // staged 口径不变
  });

  it('漏掉 dismissed 的实现会被抓到:全部忽略后 M=0,K<3 且 n=0 → hint 空输出、零写入', async () => {
    const f = await makeRoFx('a6-hs-m-dis-');
    await makeA6World(f, [{ runId: 'r-1' }]);
    expect((await hint(f)).out).toContain('待审提案 1、');
    const g = await makeRoFx('a6-hs-m-dis2-');
    await makeA6World(g, [{ runId: 'r-1' }]);
    await putRsiFile(g, 'dismissed.json', dismissedDoc(['r-1']));
    const r = await hint(g);
    expect([r.out, r.audit]).toEqual(['', []]);
  });

  it('写下排除、worker 尚未 taint:该 run 立即不计入(X 过滤);项目根消失(U)同理', async () => {
    const f = await makeRoFx('a6-hs-m-x-');
    await makeA6World(f, [{ runId: 'r-1' }]);
    await setExtra(f, `exclude_dirs = [${JSON.stringify(path.join(f.dir, 'work', 'proj'))}]\n`);
    expect((await hint(f)).out).toBe('');
    expect((await status(f)).counts.pending_runs).toBe(0);
  });

  it('hint 不读 notice.json:它损坏也不影响输出', async () => {
    const f = await makeRoFx('a6-hs-m-notice-');
    await makeA6World(f, [{ runId: 'r-1' }]);
    await putRsiFile(f, 'notice.json', '{garbage');
    expect((await hint(f)).out).toContain('待审提案 1、');
  });

  it('dismissed.json 损坏:只读路径按「无已忽略」计数(保守多算),status 报 dismissed_invalid', async () => {
    const f = await makeRoFx('a6-hs-m-baddis-');
    await makeA6World(f, [{ runId: 'r-1' }]);
    await putRsiFile(f, 'dismissed.json', '{"nope":true}');
    expect((await hint(f)).out).toContain('待审提案 1、');
    const st = await status(f);
    expect(st.warnings).toContain('dismissed_invalid');
    expect(st.counts.pending_runs).toBe(1);
  });
});

describe('R20-17.17 暂存区达到 run 上限', () => {
  it('目录数 ≥ 50 → 输出换成满区单行(≤ 200 字节、不暗示 dismiss 能释放容量),即使 M / K / n 都为 0;30 分钟去重同旧', async () => {
    const f = await makeRoFx('a6-hs-full-');
    await makeA6World(f, [{ runId: 'r-1' }]);
    await padDirs(f, RSI_STAGING_MAX_RUNS - 1); // 加上 r-1 恰好 50 个
    await putRsiFile(f, 'dismissed.json', dismissedDoc(['r-1'])); // M = 0
    const r = await hint(f);
    expect(r.out).toBe(`${RSI_HINT_STAGING_FULL_LINE}\n`);
    expect(Buffer.byteLength(r.out)).toBeLessThanOrEqual(200);
    expect(r.out).not.toContain('dismiss');
    expect((await hint(f)).out).toBe(''); // 去重窗口内
    expect((await hint(f, NOW_MS + 31 * 60_000)).out).toBe(`${RSI_HINT_STAGING_FULL_LINE}\n`);
    expect((await status(f)).staging).toEqual({ run_limit_reached: true, bytes_checked: false });
  });

  it('49 个目录 → 仍是原模板(旧模板与满区行不会互相冒充);只数非点开头目录', async () => {
    const f = await makeRoFx('a6-hs-full49-');
    await makeA6World(f, [{ runId: 'r-1' }]);
    await padDirs(f, RSI_STAGING_MAX_RUNS - 2);
    await mkdirp(f.io, path.join(reflectRoot(f), '.tmp-x'), 0o755);
    const r = await hint(f);
    expect(r.out).toContain('待审提案 1、');
    expect(r.out).not.toBe(`${RSI_HINT_STAGING_FULL_LINE}\n`);
    expect((await status(f)).staging.run_limit_reached).toBe(false);
  });
});

describe('R20-17.4a 扫描未知的入口映射', () => {
  it('reflect/ 下 1001 个子项:hint 空输出且零写入;status 的 pending / unreadable 为 null + warning run_scan_truncated,退出 0', async () => {
    const f = await makeRoFx('a6-hs-trunc-');
    await makeA6World(f, [{ runId: 'r-1' }]);
    await padDirs(f, 1000);
    const h = await hint(f);
    expect([h.out, h.audit]).toEqual(['', []]);
    const r = await runDirect(f, runStatus, ['--json'], { now: () => new Date(NOW) });
    expect(r.code).toBe(0);
    expect(r.audit).toEqual([]);
    const st = JSON.parse(r.out) as StatusDoc;
    expect([
      st.counts.pending_runs,
      st.counts.pending_proposals,
      st.counts.unreadable_runs,
    ]).toEqual([null, null, null]);
    expect(st.warnings).toContain('run_scan_truncated');
    expect(st.staging.run_limit_reached).toBe(true); // 扫描未知时目录数口径仍可判定
    expect(st.counts.staged_runs).toBe(1); // 既有字段不受影响
  }, 120_000);
});

describe('R20-17.18 status 追加字段与 gc 计划', () => {
  it('unreadable_runs:暂存 run 的 report 读不了 → 计入 unreadable,不计入待审', async () => {
    const f = await makeRoFx('a6-hs-unread-');
    await makeA6World(f, [{ runId: 'r-ok' }, { runId: 'r-bad', report: false }]);
    await putReport(f, 'r-bad', 'ingest', 1, '{broken');
    const c = (await status(f)).counts;
    expect([c.pending_runs, c.unreadable_runs, c.dismissed_runs]).toEqual([1, 1, 0]);
  });

  it('gc_candidates 来自只读的 GC 计划:过期且无暂存提案的 run 计入;计划失败 → null + warning gc_plan_failed(退出码不变)', async () => {
    const f = await makeRoFx('a6-hs-gc-');
    await makeA6World(f, [{ runId: 'r-1' }]);
    const old = 'run-20250101T000000Z-aaaaaa';
    await putReport(f, old, 'llm', 0, `${JSON.stringify(reportDoc(old, 'llm', []))}\n`);
    const ok = await status(f);
    expect(ok.counts.gc_candidates).toBe(1);
    expect(ok.warnings).not.toContain('gc_plan_failed');
    // 引用来源目录被换成符号链接 → 计划失败(fail-closed),不改 status 的退出码
    const elsewhere = path.join(f.repo, 'elsewhere');
    await mkdirp(f.fx, elsewhere, 0o755);
    await symlink(f.fx, elsewhere, path.join(f.repo, 'proposals'));
    const r = await runDirect(f, runStatus, ['--json'], { now: () => new Date(NOW) });
    const bad = JSON.parse(r.out) as StatusDoc;
    expect([r.code, bad.counts.gc_candidates]).toEqual([0, null]);
    expect(bad.warnings).toContain('gc_plan_failed');
    expect(r.audit).toEqual([]);
  });

  it('text 模式:新键同样以 key=value 输出,null 写成 -', async () => {
    const f = await makeRoFx('a6-hs-text-');
    await makeA6World(f, [{ runId: 'r-1' }]);
    const r = await runDirect(f, runStatus, [], { now: () => new Date(NOW) });
    expect(r.out).toContain('counts.pending_runs=1\n');
    expect(r.out).toContain('counts.pending_proposals=1\n');
    expect(r.out).toContain('staging.bytes_checked=false\n');
    expect(r.out).toContain('staging.run_limit_reached=false\n');
  });
});
