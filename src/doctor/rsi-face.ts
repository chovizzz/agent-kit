/**
 * doctor D17 的只读探测(契约 R20-17.19 / R20-17.20;A6):采集面按 §20.2 的配置结果判,钩子面经 `src/io/hooks-read.ts`。
 * **零写入、不拿任何锁、不清理残留**;只 import 只读模块(`hooks-read.ts`,**不是** `hooks-fs.ts`——eslint 闸与 `test/doctor` 的闭包审计钉住)。
 * 输出只含枚举 / 计数 / 布尔,无绝对路径、无用户名、无提案正文。
 *
 * 采集面(`collection`):
 *  - 用户配置不存在或没有 `[rsi]` → `n_a` / `absent`;`[rsi] enabled = false` → `n_a` / `disabled`;
 *  - 使状态为 `off` 的其它配置问题(`cfg_*`、`repo_invalid`)→ `fail`,`result` 为该原因码;
 *  - collect block(`overlay_invalid` / `exclude_invalid`,状态仍照算)→ `fail`,不论状态;
 *  - state / 索引 / 计数读不了或 schema 不过 → `fail`;
 *  - `stopped` / `armed` / 熔断打开 / 暂存达到 run 上限 / `unreadable_runs > 0` / `run_scan_truncated` / `run_scan_budget` / `dismissed_invalid` / `notice_invalid` / `notice_full` → `warn`;其余 `ok`。
 */
import { HooksRead } from '../io/hooks-read.js';
import type { AttributionProbe } from '../rsi/attribution.js';
import { loadRsiConfig } from '../rsi/config.js';
import { RsiSnapshotBusyError } from '../rsi/exit.js';
import { inspectHooks, type HooksFace } from '../rsi/hooks/inspect.js';
import { createRsiIoContext } from '../rsi/io.js';
import { readRsiState } from '../rsi/read-state.js';
import { RsiSnapshotError } from '../rsi/snapshot-read.js';
import { buildStatusDoc } from '../rsi/status.js';
import type { D17Input } from './checks.js';

type Env = Readonly<Record<string, string | undefined>>;

export interface CollectD17Args {
  home: string;
  env: Env;
  now?: () => Date;
  probe?: AttributionProbe;
}

const NO_FACTS: D17Input['facts'] = {
  state: null,
  projects_collecting: null,
  projects_excluded: null,
  pending_runs: null,
  pending_proposals: null,
  staging_run_limit_reached: null,
};

type Collection = Pick<D17Input, 'collection' | 'facts'>;

async function collectCollection(a: CollectD17Args): Promise<Collection> {
  const fail = (result: string): Collection => ({
    collection: { status: 'fail', result, items: [result] },
    facts: NO_FACTS,
  });
  const cfg = await loadRsiConfig({ env: a.env, home: a.home });
  if (cfg.status === 'off') {
    if (cfg.reason === 'absent' || cfg.reason === 'no_section') {
      return { collection: { status: 'n_a', result: 'absent', items: [] }, facts: NO_FACTS };
    }
    if (cfg.reason === 'disabled') {
      return { collection: { status: 'n_a', result: 'disabled', items: [] }, facts: NO_FACTS };
    }
    return fail(cfg.reason);
  }
  if (cfg.block !== null) return fail(cfg.block);
  try {
    const io = createRsiIoContext({ repo: cfg.repo, env: a.env });
    const data = await readRsiState(io);
    if (data.index.status === 'invalid') return fail('index_invalid');
    const doc = await buildStatusDoc(cfg, data, { env: a.env }, io, {
      ...(a.now !== undefined ? { now: a.now } : {}),
      ...(a.probe !== undefined ? { probe: a.probe } : {}),
      cursorFingerprint: () => null, // D17 不枚举会话根:不比较 cursor 指纹
    });
    const warns: string[] = [];
    if (doc.state === 'stopped') warns.push('stopped');
    if (doc.state === 'armed') warns.push('armed');
    if (doc.breaker.state === 'open') warns.push('breaker_open');
    if (doc.staging.run_limit_reached) warns.push('staging_run_limit');
    if ((doc.counts.unreadable_runs ?? 0) > 0) warns.push('unreadable_runs');
    for (const w of [
      'run_scan_truncated',
      'run_scan_budget',
      'dismissed_invalid',
      'notice_invalid',
      'notice_full',
    ]) {
      if (doc.warnings.includes(w)) warns.push(w);
    }
    return {
      collection: {
        status: warns.length > 0 ? 'warn' : 'ok',
        result: warns[0] ?? 'ok',
        items: warns,
      },
      facts: {
        state: doc.state,
        projects_collecting: doc.counts.projects_collecting,
        projects_excluded: doc.counts.projects_excluded,
        pending_runs: doc.counts.pending_runs,
        pending_proposals: doc.counts.pending_proposals,
        staging_run_limit_reached: doc.staging.run_limit_reached,
      },
    };
  } catch (e) {
    if (e instanceof RsiSnapshotBusyError) return fail('snapshot_busy');
    if (e instanceof RsiSnapshotError) return fail(e.reason);
    return fail('state_unreadable_rsi');
  }
}

async function collectHooks(home: string): Promise<HooksFace> {
  let reader: HooksRead;
  try {
    reader = new HooksRead({ home });
  } catch {
    return {
      status: 'n_a',
      result: 'absent',
      agents: { claude: 'not_installed', codex: 'not_installed', pi: 'not_installed' },
      residue: 0,
    };
  }
  return inspectHooks(reader);
}

export async function collectD17(a: CollectD17Args): Promise<D17Input> {
  const [c, hooks] = await Promise.all([collectCollection(a), collectHooks(a.home)]);
  return { ...c, hooks };
}
