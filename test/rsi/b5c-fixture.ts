/**
 * R20-A2 B5c 测试夹具:在 `makeSvc` 的真实目录 / 真实配置 / 真实锁上造一个「有已排除项目与未排除项目」的世界:
 * 索引(4 个项目:A、D 在排除目录 `ex` 之内,B、C 不在)、信号库(两个月)、会话计数(两个月)、cursor、暂存 run / promote、已提交的快照清单。
 * 全部经 safe-fs 写在 KIT_TMP 内,假 HOME;不碰真实 HOME;不 import node:fs。
 */
import * as path from 'node:path';
import type { RsiState } from '../../src/contracts/rsi.js';
import type { SessionStat } from '../../src/contracts/session-stat.js';
import { canonicalJson } from '../../src/io/canonical-json.js';
import { exists, readText } from '../../src/io/read-fs.js';
import { mkdirp } from '../../src/io/safe-fs.js';
import { buildRsiPolicy, policyFingerprint } from '../../src/rsi/config.js';
import { runPurge, type RsiPurgeDeps } from '../../src/rsi/purge.js';
import { commitSnapshot, inspectSnapshot } from '../../src/rsi/snapshot.js';
import { defaultState } from '../../src/rsi/services/tick-state.js';
import { loadRepoIdentity } from '../../src/rsi/state.js';
import { productionSnapshotValidator } from '../../src/rsi/validators.js';
import { writeSessionStats } from '../../src/signals/session-stats.js';
import { cmdFxOf, runCmd, type CmdFx } from './b5a-fixture.js';
import { treeOf } from './rsi-fixture.js';
import {
  KEY_A,
  KEY_B,
  KEY_C,
  countsDoc,
  makeRoot,
  makeSvc,
  put,
  signalObj,
  stagePromote,
  stageRun,
  withLock,
  writeIndex,
  type Svc,
} from './services-fixture.js';

export const KEY_D = 'p_dddddddddddddddd';
export const FIXED_NOW = '2026-10-26T12:00:00.000Z';
export const fixedNow = (): Date => new Date(FIXED_NOW);

/** 信号 id(16 位十六进制) */
export const sid = (n: number): string => n.toString(16).padStart(16, '0');
const sref = (n: number): string => `s_${sid(n)}`;

export const statOf = (n: number, k: string, ts: string): SessionStat => ({
  session_ref: sref(n),
  project_key: k,
  ts,
  external_content: false,
  counts: { user_messages: 1, tool_calls: 0, tool_failures: 0, unknown_event_types: {} },
});

export interface Sc {
  s: Svc;
  cf: CmdFx;
  roots: { ex: string; sub: string; ok: string; inc: string };
}

export interface ScOptions {
  /** 状态:armed(没有 state.json)/ confirmed(合规确认记录)/ stopped(STOP 在场,无确认) */
  state?: 'armed' | 'confirmed' | 'stopped';
  /** 不造暂存 run / promote */
  noStaging?: boolean;
  /** 不造信号库 / 会话计数 / cursor(最小世界,k 遍历用) */
  minimal?: boolean;
}

export const STOP_DOC = '{"at":"2026-10-26T00:00:00.000Z","by":"user"}';

export async function makeSc(prefix: string, o: ScOptions = {}): Promise<Sc> {
  const s = await makeSvc(prefix, {
    extraToml: (f) => `exclude_dirs = [${JSON.stringify(path.join(f.dir, 'proj', 'ex'))}]\n`,
  });
  const roots = {
    ex: await makeRoot(s, 'ex'),
    sub: await makeRoot(s, 'ex/sub'),
    ok: await makeRoot(s, 'ok'),
    inc: await makeRoot(s, 'inc'),
  };
  await writeIndex(s, [
    { key: KEY_A, root: roots.ex },
    { key: KEY_D, root: roots.sub },
    { key: KEY_B, root: roots.ok },
    { key: KEY_C, root: roots.inc },
  ]);
  if (o.minimal !== true) {
    const sig = (n: number, k: string): string => JSON.stringify(signalObj(sid(n), k));
    await put(
      s,
      path.join(s.state, 'signals', 'claude', '202609.jsonl'),
      `${sig(1, KEY_A)}\n${sig(2, KEY_A)}\n`,
    );
    await put(
      s,
      path.join(s.state, 'signals', 'claude', '202610.jsonl'),
      [sig(3, KEY_A), sig(4, KEY_B), sig(5, KEY_D), sig(6, KEY_C), sig(7, KEY_B)].join('\n') + '\n',
    );
    await writeSessionStats(s.io, 'claude', [
      statOf(1, KEY_A, '2026-09-20T00:00:00.000Z'),
      statOf(2, KEY_B, '2026-10-20T00:00:00.000Z'),
      statOf(3, KEY_A, '2026-10-21T00:00:00.000Z'),
      statOf(4, KEY_C, '2026-10-22T00:00:00.000Z'),
    ]);
    const files: Record<string, unknown> = {};
    const mk = (n: number, k: string | null): void => {
      files[sref(n)] = {
        agent: 'claude',
        size: 10,
        mtime_ms: 1,
        dev: 1,
        ino: n,
        project_key: k,
        epoch: 1,
        status: k === null ? 'unknown_project' : 'ok',
      };
    };
    mk(1, KEY_A);
    mk(2, KEY_B);
    mk(3, KEY_A);
    mk(4, null);
    await put(
      s,
      path.join(s.rsi, 'cursor.json'),
      canonicalJson({
        schema_version: 1,
        fingerprint: 'a'.repeat(64),
        full_scan: { epoch: 1, started_at: null, done: true, last_completed_at: FIXED_NOW },
        files,
      }),
    );
  }
  await put(s, path.join(s.rsi, 'counts.json'), canonicalJson(countsDoc()));
  if (o.state === 'confirmed') await writeConfirmed(s);
  if (o.state === 'stopped') await put(s, path.join(s.rsi, 'STOP'), STOP_DOC);
  if (o.noStaging !== true && o.minimal !== true) {
    await stageRun(s, 'run-ex', [sid(1), sid(3)], { proposals: 2 });
    await stageRun(s, 'run-ok', [sid(4)]);
    await stagePromote(s, 'promo-ex', 'run-ex');
    await stagePromote(s, 'promo-ok', 'run-ok');
  }
  await withLock(s, (lock) => commitSnapshot(s.io, lock));
  return { s, cf: cmdFxOf(s), roots };
}

/** 写一份与当前配置 / 仓库一致的确认记录进 state.json */
export async function writeConfirmed(s: Svc): Promise<void> {
  const policy = await buildRsiPolicy(s.cfg);
  const id = await loadRepoIdentity(s.cfg, policy);
  const state: RsiState = {
    ...defaultState(),
    confirm: {
      confirmed_at: '2026-10-26T00:00:00.000Z',
      kit_major: policy.kit_major,
      agents: [...policy.agents],
      exclude_hashes: [...policy.exclude_hashes],
      repo_sha256: id.repoSha256,
      repo_dev_ino: { ...id.repoDevIno },
      overlay_sha256: policy.overlay_sha256,
      policy_fp: policyFingerprint(policy),
      baseline_pending: false,
    },
  };
  await mkdirp(s.f.fx, s.rsi, 0o700);
  await put(s, path.join(s.rsi, 'state.json'), JSON.stringify(state));
}

/** 跑 `rsi purge`;默认 TTY、固定时钟 */
export function purge(
  sc: Sc,
  argv: string[],
  deps: RsiPurgeDeps = {},
  over: { isTty?: boolean; env?: Record<string, string | undefined> } = {},
): Promise<{ code: number; out: string; err: string }> {
  return runCmd(sc.cf, runPurge, argv, { now: fixedNow, ...deps }, { isTty: true, ...over });
}

export const json = (t: string): Record<string, unknown> =>
  JSON.parse(t) as Record<string, unknown>;

/** 受 purge 影响的数据文件的内容指纹(不含日志 / 清单 / counts 这类每次都变的文件) */
export async function dataFingerprint(s: Svc): Promise<string[]> {
  const out: string[] = [];
  for (const sub of ['signals', 'sessions', 'reflect', 'promote']) {
    out.push(...(await treeOf(path.join(s.state, sub))).map((l) => `${sub}/${l}`));
  }
  if (await exists(path.join(s.rsi, 'cursor.json'))) {
    out.push(`cursor.json ${await readText(path.join(s.rsi, 'cursor.json'))}`);
  }
  if (await exists(path.join(s.rsi, 'projects.json'))) {
    // 索引里的路径与 inode 随夹具目录不同,只取 generation 与 key 集合
    const idx = JSON.parse(await readText(path.join(s.rsi, 'projects.json'))) as {
      generation?: number;
      entries?: { key: string }[];
    };
    out.push(
      `projects.json gen=${idx.generation ?? '?'} keys=${(idx.entries ?? []).map((e) => e.key).join(',')}`,
    );
  }
  return out;
}

export const consistent = async (s: Svc): Promise<boolean> =>
  (await inspectSnapshot(s.io, productionSnapshotValidator)) === 'consistent';

export async function readState(s: Svc, rel: string): Promise<string> {
  return readText(path.join(s.state, rel));
}
