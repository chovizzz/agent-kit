/**
 * 无副作用观测与检查点(R20-A2 B5 方案 §2;**B5-0 只放签名桩,B5a 实装**)。
 *
 * 只读:只用直读(`readRsiFixed` / `lstat` / `loadRsiConfig`),**不经 `readVerified`**(未完成的提交会被它误报 busy);
 * 锁内的「无副作用复检」(D2:先于 `recoverUnderLock`)与检查点共用。配置来源与 `openRsiIo` 相同:`{ env }`(方案 §2.1)。
 */
import type { RsiAgentId } from '../../contracts/rsi.js';
import type { IoContext } from '../../io/paths.js';
import type { RsiConfig } from '../config.js';
import type { Checkpoint, RunBinding } from '../l0/types.js';
import type { RsiIdentity, RsiStateDoc, RsiStateResult } from '../state.js';
import { notImplemented } from './not-implemented.js';

/** 命令边界的 env(`EarlyCommandContext.env`;`undefined` = 取真实进程环境里 rsi 关心的几个名字) */
export type EarlyEnv = Readonly<Record<string, string | undefined>> | undefined;

/**
 * STOP 标记身份(R11):`'absent'`,或 `(dev, ino, size, mtimeMs, ctimeMs)` 加内容 sha256。
 * 以 `sha256`(含 `at` 时间戳)与 `(dev, ino)` 为主判据(部分文件系统的 mtime / ctime 只有秒级);STOP 不是普通文件时 `sha256: null`(confirm 退 3)。
 */
export type StopMarkId =
  | 'absent'
  | {
      dev: number;
      ino: number;
      size: number;
      mtimeMs: number;
      ctimeMs: number;
      sha256: string | null;
    };

export interface RsiObservation {
  /** 重读,来源与 `openRsiIo` 相同 */
  config: RsiConfig;
  /** `rsiStateOf(...)` */
  state: RsiStateResult;
  /** `parseRsiStateDoc`(直读 `state.json`) */
  doc: RsiStateDoc;
  /** config 为 on 时 `loadRepoIdentity(cfg, buildRsiPolicy(cfg))`;off 时 `null` */
  identity: RsiIdentity | null;
  stop: StopMarkId;
}

/** armed 状态下检查点比对的绑定(没有确认记录,所以不是 `RunBinding`) */
export interface ArmedBinding {
  repoSha256: string;
  repoDevIno: { dev: number; ino: number };
  policyFp: string;
  agents: readonly RsiAgentId[];
}

export async function observeRsi(io: IoContext, env: EarlyEnv): Promise<RsiObservation> {
  return notImplemented('observeRsi', io, env);
}

/** confirmed:包装 B4 的 `createCheckpoint`(`observe` = 由 `observeRsi` 派生) */
export function confirmedCheckpoint(i: {
  io: IoContext;
  env: EarlyEnv;
  binding: RunBinding;
  nowMs: () => number;
  startedAtMs: number;
}): Checkpoint {
  return notImplemented('confirmedCheckpoint', i);
}

/**
 * armed 专用:STOP → `stopped`;配置 off / block / `stateInvalid` → `skipped_collect_blocked`;状态变成 confirmed 或 repo / policy_fp / agents 变化 →
 * `skipped_binding_changed`;其余 `continue`。`where === 'commit'` 不返回 `time_limit`。(B4 的 `createCheckpoint` 在 armed 下 `current === null`,
 * 一调用就判 `binding_changed`,所以不能复用。)
 */
export function armedCheckpoint(i: {
  io: IoContext;
  env: EarlyEnv;
  armedBinding: ArmedBinding;
  nowMs: () => number;
  startedAtMs: number;
}): Checkpoint {
  return notImplemented('armedCheckpoint', i);
}

/** confirm 的展示指纹:canonical JSON(`{repo_sha256, repo_dev_ino, agents, exclude_hashes, overlay_sha256, kit_major, stop}`) */
export function displayFingerprint(o: RsiObservation): string {
  return notImplemented('displayFingerprint', o);
}
