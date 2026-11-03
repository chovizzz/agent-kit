/**
 * A6 测试共用夹具(docs/contracts.md §20.17):在 `ro-fixture` 的假 HOME / 合规 `[rsi] repo` 上造「暂存 run 的 report.json」「dismissed.json」「notice.json」,
 * 以及一个带 N 个暂存 run 的 confirmed 世界。全部经 safe-fs 写在 KIT_TMP(夹具目录)内,不碰真实 HOME。
 */
import * as path from 'node:path';
import type { ReflectRunReport } from '../../src/contracts/reflect.js';
import { chmod, mkdirp, writeFile } from '../../src/io/safe-fs.js';
import {
  NOW,
  baseState,
  countsOf,
  indexOf,
  key,
  mkProject,
  seed,
  validConfirm,
  type RoFx,
} from './ro-fixture.js';

/** 夹具项目目录名:足够独特,不会出现在合法输出里(`projects=` / `projects_collecting` 等不含它) */
export const PROJECT_NAME = 'secret-workdir-q7';

export type ReportMode = ReflectRunReport['mode'];

/** 合法的 `report.json`(`staged` 为提案编号列表;非空时 outcome=staged) */
export function reportDoc(
  runId: string,
  mode: ReportMode,
  staged: readonly string[],
): ReflectRunReport {
  return {
    run_id: runId,
    mode,
    signals_loaded: 0,
    signals_dropped: { schema: 0, residual: 0, external_excerpt_forced: 0 },
    clusters: 0,
    evidence_sent: 0,
    prompt_bytes: 0,
    prompt_sha256: null,
    input_digest: null,
    backend: null,
    calls_made: 0,
    calls_limit: 1,
    outcome: staged.length > 0 ? 'staged' : 'no_proposals',
    rejected: {},
    staged: [...staged],
    observations_n: 0,
  };
}

export const proposalIds = (n: number, day = '2026-10-24'): string[] =>
  Array.from({ length: n }, (_, i) => `${day}-${String(i + 1).padStart(3, '0')}`);

/** 写 `<state>/reflect/<run>/report.json`(`override` 给了就原样写那段文本,用来造损坏 / 不一致的报告) */
export async function putReport(
  f: Pick<RoFx, 'io'>,
  runId: string,
  mode: ReportMode = 'ingest',
  proposals = 1,
  override?: string,
): Promise<void> {
  const dir = path.join(f.io.stateDir, 'reflect', runId);
  await mkdirp(f.io, dir, 0o755);
  const text =
    override ?? `${JSON.stringify(reportDoc(runId, mode, proposalIds(proposals)), null, 2)}\n`;
  await writeFile(f.io, path.join(dir, 'report.json'), text, { mode: 0o644 });
}

export async function putRsiFile(f: RoFx, name: string, text: string, mode = 0o600): Promise<void> {
  const rsi = path.join(f.io.stateDir, 'rsi');
  await mkdirp(f.io, rsi, 0o700);
  await writeFile(f.io, path.join(rsi, name), text, { mode });
  await chmod(f.io, path.join(rsi, name), mode); // 覆盖已有文件时 mode 参数不一定生效
}

export const rsiFilePath = (f: Pick<RoFx, 'io'>, name: string): string =>
  path.join(f.io.stateDir, 'rsi', name);

export const dismissedDoc = (ids: readonly string[], at = NOW): string =>
  JSON.stringify({
    schema_version: 1,
    runs: [...ids].sort().map((run_id) => ({ run_id, at })),
  });

export const noticeDoc = (ids: readonly string[], started: string | null = null): string =>
  JSON.stringify({
    schema_version: 1,
    proposals_notified: [...ids].sort(),
    collection_started_for: started,
  });

export interface StagedSpec {
  runId: string;
  proposals?: number;
  mode?: ReportMode;
  /** false = 不写 report.json(目录也不建) */
  report?: boolean;
  tainted?: boolean;
}

export interface A6World {
  f: RoFx;
  /** 一个采集中项目的路径 */
  project: string;
  confirmedAt: string;
}

/**
 * confirmed 世界:一个采集中项目(P),`counts.staged` 里按 `runs` 登记暂存 run,并按需写 report.json。
 * `baselinePending` 缺省 false(首次 L0 已完成)。
 */
export async function makeA6World(
  f: RoFx,
  runs: readonly StagedSpec[],
  o: { baselinePending?: boolean; confirm?: boolean } = {},
): Promise<A6World> {
  const proj = await mkProject(f, PROJECT_NAME);
  const confirm = { ...(await validConfirm(f)), baseline_pending: o.baselinePending ?? false };
  await seed(f, {
    state: baseState({
      confirm: o.confirm === false ? null : confirm,
      projects_ack_generation: 1,
    }),
    index: indexOf([{ key: key(1), path: proj.path, dev: proj.dev, ino: proj.ino }]),
    counts: countsOf(
      { [key(1)]: { total: 3 } },
      {
        staged: runs.map((r) => ({
          run_id: r.runId,
          proposals: r.proposals ?? 1,
          evidence_keys: [key(1)],
          tainted: r.tainted ?? false,
        })),
      },
    ),
  });
  for (const r of runs) {
    if (r.report !== false) await putReport(f, r.runId, r.mode ?? 'ingest', r.proposals ?? 1);
  }
  return { f, project: proj.path, confirmedAt: confirm.confirmed_at };
}

/**
 * 写审计里相对 `stateDir` 的路径,去掉「拿锁的目录基础设施」:`acquireRsiLock` → `rsiDir()` 对**已存在**的 `.state` 与 `.state/rsi`
 * 各做一次幂等 `mkdirp`(`src/rsi/rsi-dir.ts`;A1 起的既有锁路径,hint / a4 / a5 同样如此)。只按 op 精确放行 `mkdirp` + 这两个路径,
 * 其余(含 `chmod`、对别处的 `mkdirp`)一律保留。
 */
export function auditRel(
  f: Pick<RoFx, 'io'>,
  audit: readonly { op: string; path: string }[],
): string[] {
  return audit
    .filter((a) => {
      const rel = path.relative(f.io.stateDir, a.path);
      return !(a.op === 'mkdirp' && (rel === '' || rel === 'rsi'));
    })
    .map((a) => path.relative(f.io.stateDir, a.path));
}
