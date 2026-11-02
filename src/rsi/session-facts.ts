/**
 * digest / ingest 共用的「现读现判」事实快照(docs/contracts.md R20-16.3 / R20-16.11 ② / R20-16.15 第 1、12 步;R20-A4)。
 *
 * 一次 {@link observeSessionFacts} 重读:用户配置(L-base + L-session)、状态(`STOP`)、purge journal 是否存在、快照清单代次与 `state.json`、
 * 会话授权判定、`session_policy_fp`。digest 在开始时取一份、输出前再取一份(最终复核),ingest 在第 1 步与第 12 步各取一份;两份的**可比较部分**
 * ({@link factsKey})不同即 `policy_changed`。不缓存,每次都读盘。读 `state.json` 经快照协议(`readVerified`),读不一致重读一次仍不一致 → `RsiSnapshotBusyError`。
 */
import * as path from 'node:path';
import type { RsiAgentId } from '../contracts/rsi.js';
import type { IoContext } from '../io/paths.js';
import { lstat, stat } from '../io/read-fs.js';
import { RsiSnapshotBusyError } from './exit.js';
import { buildRsiPolicy, loadRsiConfig, type RsiConfig, type RsiConfigOn } from './config.js';
import { rsiDirReadonly } from './lock-read.js';
import {
  judgeSession,
  normalizedSession,
  sessionPolicyFp,
  type SessionJudgement,
} from './session.js';
import { RsiSnapshotError, readVerified } from './snapshot-read.js';
import { loadRepoIdentity, parseRsiStateDoc, rsiStateOf, type RsiStateResult } from './state.js';
import { RsiFailClosedError } from './types.js';

type Env = Readonly<Record<string, string | undefined>> | undefined;

export interface SessionFacts {
  config: RsiConfig;
  /** 配置 `off` 时为 null */
  state: RsiStateResult | null;
  stopPresent: boolean;
  journalPresent: boolean;
  stateDocInvalid: boolean;
  judgement: SessionJudgement | null;
  fp: string | null;
  /** 快照清单代次;清单缺失 = 0 */
  generation: number;
}

/** `lstat` 判存在;无法确认(权限 / IO 错误)按在场(保守) */
async function present(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

export async function probeMarkers(io: IoContext): Promise<{ stop: boolean; journal: boolean }> {
  const d = await rsiDirReadonly(io);
  if (d.kind === 'unsafe') throw new RsiSnapshotError('state_dir_unsafe');
  if (d.kind === 'missing') return { stop: false, journal: false };
  return {
    stop: await present(path.join(d.dir, 'STOP')),
    journal: await present(path.join(d.dir, 'purge-journal.json')),
  };
}

export async function observeSessionFacts(
  io: IoContext,
  env: Env,
  agent: RsiAgentId,
  today: string,
): Promise<SessionFacts> {
  const config = await loadRsiConfig(env !== undefined ? { env } : {});
  const v = await readVerified(io, ['state.json']);
  if (v.status === 'busy') throw new RsiSnapshotBusyError();
  if (v.status === 'unsafe') throw new RsiSnapshotError('state_dir_unsafe');
  if (v.status === 'invalid') throw new RsiSnapshotError('snapshot_invalid');
  const generation = v.status === 'ok' ? v.generation : 0;
  const markers = await probeMarkers(io);
  if (config.status === 'off') {
    return {
      config,
      state: null,
      stopPresent: markers.stop,
      journalPresent: markers.journal,
      stateDocInvalid: false,
      judgement: null,
      fp: null,
      generation,
    };
  }
  const stateBytes = v.status === 'ok' ? (v.files.get('state.json') ?? null) : null;
  const doc = parseRsiStateDoc(stateBytes);
  const policy = await buildRsiPolicy(config);
  const identity = await loadRepoIdentity(config, policy);
  const state = rsiStateOf({ config, stopPresent: markers.stop, doc, identity });
  return {
    config,
    state,
    stopPresent: markers.stop,
    journalPresent: markers.journal,
    stateDocInvalid: doc.kind === 'invalid',
    judgement: judgeSession(config, agent, today),
    fp: await sessionPolicyFp(config, normalizedSession(config), identity.repoDevIno),
    generation,
  };
}

/** 两份事实可比较的部分:状态名、STOP、journal、授权判定、策略指纹、快照代次(不含配置对象本身) */
export function factsKey(f: SessionFacts): string {
  return JSON.stringify([
    f.config.status === 'on' ? 'on' : f.config.reason,
    f.state?.state ?? null,
    f.state?.collectBlocked ?? null,
    f.stopPresent,
    f.journalPresent,
    f.stateDocInvalid,
    f.judgement === null ? null : f.judgement.kind === 'ok' ? 'ok' : f.judgement.reason,
    f.fp,
    f.generation,
  ]);
}

/** 状态不是 `confirmed` 时的原码(R20-3.0):off / armed / stopped / 停止采集 → 退出 4 的 `reason`;`state.json` 整份不合规 → fail-closed `state_invalid` */
export function stateGate(f: SessionFacts): string | null {
  if (f.config.status === 'off' || f.state === null) return 'off';
  if (f.state.stateInvalid || f.stateDocInvalid) throw new RsiFailClosedError('state_invalid');
  if (f.state.state === 'stopped') return 'stopped';
  if (f.state.state === 'armed') return 'not_confirmed';
  if (f.state.state === 'off') return 'off';
  if (f.state.collectBlocked !== null) return 'collect_blocked';
  return null;
}

export type { RsiConfigOn };
/** 仓库根 `(dev, ino)` —— 仅测试辅助需要时用 */
export async function repoDevIno(config: RsiConfigOn): Promise<{ dev: number; ino: number }> {
  const st = await stat(config.repo);
  return { dev: st.dev, ino: st.ino };
}
