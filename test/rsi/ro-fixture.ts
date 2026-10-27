/**
 * B3a 只读命令(status / projects / stop)测试夹具:假 HOME + 合规 `[rsi] repo` + 真实持锁写入方造出的已提交快照。
 * 目录布局(都在一个 makeTempDir 目录 `dir` 内):`home/`(KIT_REAL_HOME_OVERRIDE)、`repo/`(`[rsi] repo`)、`tmp/`(KIT_TMP,与 home 互不为祖先)、`work/<name>/`(被测项目目录)。
 * 命令经真实 `main()` 的 runEarly 路径跑,写审计钩子由外部数组累计。
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { main } from '../../src/cli.js';
import { RsiCountsSchema, type RsiConfirm, type RsiProjectIndex } from '../../src/contracts/rsi.js';
import { createIoContext, type IoContext } from '../../src/io/paths.js';
import { stat } from '../../src/io/read-fs.js';
import { mkdirp, writeFile } from '../../src/io/safe-fs.js';
import { buildRsiPolicy, loadRsiConfig, policyFingerprint } from '../../src/rsi/config.js';
import { createRsiIoContext } from '../../src/rsi/io.js';
import { acquireRsiLock } from '../../src/rsi/lock.js';
import { commitSnapshot } from '../../src/rsi/snapshot.js';
import { loadRepoIdentity } from '../../src/rsi/state.js';
import { withWriteAudit, type AuditCall } from '../helpers/write-audit.js';
import { makeRsiFx, rsiToml, writeCfg, type RsiFx } from './rsi-fixture.js';

export const SALT_FP = 'aaaaaaaaaaaa';
export const NOW = '2026-10-24T08:00:00.000Z';

export interface RoFx extends RsiFx {
  tmp: string;
  env: Record<string, string>;
  /** rsi 专用上下文(状态目录 = repo/.state),给夹具造数据用 */
  io: IoContext;
}

export async function makeRoFx(prefix: string, rsiExtra = ''): Promise<RoFx> {
  const f = await makeRsiFx(prefix);
  const tmp = path.join(f.dir, 'tmp');
  await mkdirp(f.fx, tmp, 0o755);
  await mkdirp(f.fx, path.join(f.dir, 'work'), 0o755);
  await writeCfg(f, rsiToml(f, rsiExtra));
  const env = {
    KIT_TMP: tmp,
    KIT_REAL_HOME_OVERRIDE: f.home,
    PATH: '/usr/bin:/bin',
  };
  const io = createRsiIoContext({ repo: f.repo, env, cwd: f.dir });
  return { ...f, tmp, env, io };
}

export async function setExtra(f: RoFx, extra: string): Promise<void> {
  await writeCfg(f, rsiToml(f, extra));
}

/** 建一个被测项目目录并返回它的路径与 (dev, ino) */
export async function mkProject(
  f: RoFx,
  name: string,
): Promise<{ path: string; dev: number; ino: number }> {
  const p = path.join(f.dir, 'work', name);
  await mkdirp(f.fx, p, 0o755);
  const st = await stat(p);
  return { path: p, dev: st.dev, ino: st.ino };
}

export function key(n: number): string {
  // 前两位十六进制取 n:key8(`p_` 之后前 8 位)互不相同,排序即 n 的顺序
  return `p_${n.toString(16).padStart(2, '0')}${'0'.repeat(14)}`;
}

export interface EntrySpec {
  key: string;
  path: string;
  dev: number;
  ino: number;
  sessions?: number;
  signals?: number;
  firstGen?: number;
  lastSeen?: string;
  extraRoots?: { path: string; dev: number; ino: number; last_seen: string }[];
}

export function indexOf(entries: EntrySpec[], gen = 5, saltFp = SALT_FP): RsiProjectIndex {
  return {
    schema_version: 1,
    salt_fp: saltFp,
    generation: gen,
    entries: [...entries]
      .sort((a, b) => (a.key < b.key ? -1 : 1))
      .map((e) => ({
        key: e.key,
        roots: [
          {
            path: e.path,
            dev: e.dev,
            ino: e.ino,
            first_seen: '2026-10-01',
            last_seen: e.lastSeen ?? '2026-10-23',
          },
          ...(e.extraRoots ?? []).map((r) => ({ ...r, first_seen: '2026-10-01' })),
        ],
        sessions: e.sessions ?? 1,
        signals: e.signals ?? 1,
        first_indexed_generation: e.firstGen ?? 1,
      })),
  };
}

export function countsOf(
  perKey: Record<string, { total: number; sessions?: number; byDay?: Record<string, number> }>,
  extra: Partial<{
    unknown: number;
    clusters: { cluster_id: string; evidence_by_key: Record<string, number> }[];
    staged: { run_id: string; proposals: number; evidence_keys: string[]; tainted: boolean }[];
    saltFp: string;
    clusterMin: number;
  }> = {},
): unknown {
  return RsiCountsSchema.parse({
    schema_version: 1,
    salt_fp: extra.saltFp ?? SALT_FP,
    generation: 7,
    computed_at: NOW,
    cluster_min: extra.clusterMin ?? 3,
    per_key: Object.fromEntries(
      Object.entries(perKey).map(([k, v]) => [
        k,
        { signals_total: v.total, sessions: v.sessions ?? 1, signals_by_day: v.byDay ?? {} },
      ]),
    ),
    clusters: extra.clusters ?? [],
    staged: extra.staged ?? [],
    unknown_keys_signals: extra.unknown ?? 0,
  });
}

export function baseState(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    confirm: null,
    projects_ack_generation: 0,
    attempt: null,
    last_tick: null,
    consecutive_failures: 0,
    breaker: null,
    ...over,
  };
}

/** 与当前配置 / 仓库一致的有效确认记录 */
export async function validConfirm(f: RoFx): Promise<RsiConfirm> {
  const cfg = await loadRsiConfig({ home: f.home });
  if (cfg.status !== 'on') throw new Error('off');
  const policy = await buildRsiPolicy(cfg);
  const id = await loadRepoIdentity(cfg, policy);
  return {
    confirmed_at: NOW,
    kit_major: policy.kit_major,
    agents: [...policy.agents],
    exclude_hashes: [...policy.exclude_hashes],
    repo_sha256: createHash('sha256').update(cfg.repo).digest('hex'),
    repo_dev_ino: { ...id.repoDevIno },
    overlay_sha256: policy.overlay_sha256,
    policy_fp: policyFingerprint(policy),
    baseline_pending: false,
  };
}

export interface SeedSpec {
  state?: unknown;
  index?: unknown;
  counts?: unknown;
  cursor?: unknown;
  /** 原样文本(优先于对象形式),用来写损坏内容 */
  raw?: Partial<Record<'state.json' | 'projects.json' | 'counts.json' | 'cursor.json', string>>;
  /** 不进快照清单的附带文件(相对 `.state/rsi/`) */
  side?: Record<string, string>;
  /** `.state/reflect/<run>/TAINTED` 内容 */
  tainted?: Record<string, string>;
  commit?: boolean;
}

/** 经真实持锁写入方(acquireRsiLock + safe-fs + commitSnapshot)造出 `.state/rsi/*` 与清单 */
export async function seed(f: RoFx, s: SeedSpec): Promise<void> {
  const rsi = path.join(f.io.stateDir, 'rsi');
  await mkdirp(f.io, rsi, 0o700);
  const put = async (name: string, v: unknown, raw: string | undefined): Promise<void> => {
    if (raw === undefined && v === undefined) return;
    await writeFile(f.io, path.join(rsi, name), raw ?? JSON.stringify(v), { mode: 0o600 });
  };
  await put('state.json', s.state, s.raw?.['state.json']);
  await put('projects.json', s.index, s.raw?.['projects.json']);
  await put('counts.json', s.counts, s.raw?.['counts.json']);
  await put('cursor.json', s.cursor, s.raw?.['cursor.json']);
  for (const [n, text] of Object.entries(s.side ?? {})) {
    await writeFile(f.io, path.join(rsi, n), text, { mode: 0o600 });
  }
  for (const [run, text] of Object.entries(s.tainted ?? {})) {
    const d = path.join(f.io.stateDir, 'reflect', run);
    await mkdirp(f.io, d, 0o755);
    await writeFile(f.io, path.join(d, 'TAINTED'), text, { mode: 0o600 });
  }
  if (s.commit !== false) {
    const lock = await acquireRsiLock(f.io);
    try {
      await commitSnapshot(f.io, lock);
    } finally {
      await lock.release();
    }
  }
}

export interface RunResult {
  code: number;
  out: string;
  err: string;
  audit: AuditCall[];
}

/** 经真实 `main()` 跑 `agent-kit <argv>`;写审计钩子由外部数组累计 */
export async function runMain(
  f: RoFx,
  argv: string[],
  over: { env?: Record<string, string | undefined>; isTty?: boolean } = {},
): Promise<RunResult> {
  const a = withWriteAudit();
  let out = '';
  let err = '';
  const code = await main(argv, {
    env: { ...f.env, ...over.env },
    cwd: f.dir,
    writeAudit: a.hook,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    ...(over.isTty !== undefined ? { isTty: over.isTty } : {}),
  });
  return { code, out, err, audit: a.calls };
}

export { createIoContext };

import type { RsiEarlyContext } from '../../src/rsi/types.js';

/** 直接调命令函数(带 deps 注入);写审计钩子同样外部累计 */
export async function runDirect<D>(
  f: RoFx,
  run: (ctx: RsiEarlyContext, deps: D) => Promise<number>,
  argv: string[],
  deps: D,
  over: {
    env?: Record<string, string | undefined>;
    isTty?: boolean;
    explicitRoot?: string;
  } = {},
): Promise<RunResult> {
  const a = withWriteAudit();
  let out = '';
  let err = '';
  const code = await run(
    {
      argv,
      overlayPath: undefined,
      explicitRoot: over.explicitRoot,
      env: { ...f.env, ...over.env },
      cwd: f.dir,
      writeAudit: a.hook,
      stdout: (t) => (out += t),
      stderr: (t) => (err += t),
      ...(over.isTty !== undefined ? { isTty: over.isTty } : {}),
    },
    deps,
  );
  return { code, out, err, audit: a.calls };
}
