/**
 * 无副作用观测与检查点(R20-A2 B5 方案 §2;**B5-0 只放签名桩,B5a 实装**)。
 *
 * 只读:只用直读(`readRsiFixed` / `lstat` / `loadRsiConfig`),**不经 `readVerified`**(未完成的提交会被它误报 busy);
 * 锁内的「无副作用复检」(D2:先于 `recoverUnderLock`)与检查点共用。配置来源与 `openRsiIo` 相同:`{ env }`(方案 §2.1)。
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { RSI_MAX_TICK_MS, type RsiAgentId, type RsiConfirm } from '../../contracts/rsi.js';
import { canonicalJson } from '../../io/canonical-json.js';
import type { IoContext } from '../../io/paths.js';
import { lstat, readFileSafe } from '../../io/read-fs.js';
import { buildRsiPolicy, loadRsiConfig, policyFingerprint, type RsiConfig } from '../config.js';
import { createCheckpoint, observationFrom, type BindingObservation } from '../l0/binding.js';
import type { Checkpoint, CheckpointVerdict, CheckpointWhere, RunBinding } from '../l0/types.js';
import { RSI_FILE_OWNER, rsiDirReadonly } from '../lock-read.js';
import {
  loadRepoIdentity,
  parseRsiStateDoc,
  rsiStateOf,
  type RsiIdentity,
  type RsiStateDoc,
  type RsiStateResult,
} from '../state.js';
import { RsiFailClosedError } from '../types.js';
import { readRsiFixed } from './attribution.js';

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

const STOP_MAX_BYTES = 4096;

/** STOP 的身份:只 `lstat` 不跟随链接;普通文件再读内容取 sha256(≤ 4 KiB),其余(链接 / 目录 / 过大 / 读不了)`sha256: null` */
async function observeStop(io: IoContext): Promise<StopMarkId> {
  const d = await rsiDirReadonly(io);
  if (d.kind === 'unsafe') throw new RsiFailClosedError('state_dir_unsafe');
  if (d.kind === 'missing') return 'absent';
  const file = path.join(d.dir, 'STOP');
  let st;
  try {
    st = await lstat(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    // 无法确认 = 当作在场(宁可当成已停止),身份不可得
    return { dev: 0, ino: 0, size: 0, mtimeMs: 0, ctimeMs: 0, sha256: null };
  }
  let sha256: string | null = null;
  if (st.isFile() && !st.isSymbolicLink()) {
    try {
      const r = await readFileSafe(file, { maxBytes: STOP_MAX_BYTES, owner: RSI_FILE_OWNER });
      if (r.kind === 'ok') sha256 = createHash('sha256').update(r.bytes).digest('hex');
    } catch {
      sha256 = null;
    }
  }
  return {
    dev: st.dev,
    ino: st.ino,
    size: st.size,
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
    sha256,
  };
}

/**
 * 无副作用观测(直读,不经 `readVerified`、不拿锁、不写、不建目录):重读配置(来源与 `openRsiIo` 相同:`{ env }`)→ 直读 `state.json` → STOP 身份 →
 * config 为 on 时现算仓库身份 → `rsiStateOf`。`state.json` 整份不合规时 `state.stateInvalid` 为真(调用方映射 3 `state_invalid`)。
 */
export async function observeRsi(io: IoContext, env: EarlyEnv): Promise<RsiObservation> {
  const config = await loadRsiConfig({ ...(env !== undefined ? { env } : {}) });
  if (config.status === 'off') {
    return {
      config,
      state: rsiStateOf({ config, stopPresent: false, doc: { kind: 'absent' } }),
      doc: { kind: 'absent' },
      identity: null,
      stop: 'absent',
    };
  }
  const stop = await observeStop(io);
  const r = await readRsiFixed(io, 'state.json');
  const doc = parseRsiStateDoc(r.kind === 'ok' ? r.bytes : null);
  const identity = await loadRepoIdentity(config, await buildRsiPolicy(config));
  const state = rsiStateOf({ config, stopPresent: stop !== 'absent', doc, identity });
  return { config, state, doc, identity, stop };
}

const confirmOf = (doc: RsiStateDoc): RsiConfirm | null =>
  doc.kind === 'ok' ? doc.state.confirm : null;

/** confirmed:包装 B4 的 `createCheckpoint`(`observe` = 由 `observeRsi` 派生;配置变 off 时 `identity` 为空,直接判停止采集) */
export function confirmedCheckpoint(i: {
  io: IoContext;
  env: EarlyEnv;
  binding: RunBinding;
  nowMs: () => number;
  startedAtMs: number;
}): Checkpoint {
  return createCheckpoint({
    nowMs: i.nowMs,
    startedAtMs: i.startedAtMs,
    maxMs: RSI_MAX_TICK_MS,
    binding: i.binding,
    observe: async (): Promise<BindingObservation> => {
      const o = await observeRsi(i.io, i.env);
      if (o.identity === null) {
        return { stopPresent: o.stop !== 'absent', collectBlocked: true, current: null };
      }
      return observationFrom({
        state: o.state,
        stopPresent: o.stop !== 'absent',
        identity: o.identity,
        confirm: confirmOf(o.doc),
      });
    },
  });
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
  return async (where: CheckpointWhere): Promise<CheckpointVerdict> => {
    const o = await observeRsi(i.io, i.env);
    if (o.stop !== 'absent') return { kind: 'abort', outcome: 'stopped' };
    if (
      o.identity === null ||
      o.state.state === 'off' ||
      o.state.collectBlocked !== null ||
      o.state.stateInvalid
    ) {
      return { kind: 'abort', outcome: 'skipped_collect_blocked' };
    }
    const b = i.armedBinding;
    const same =
      o.state.state === 'armed' &&
      o.identity.repoSha256 === b.repoSha256 &&
      o.identity.repoDevIno.dev === b.repoDevIno.dev &&
      o.identity.repoDevIno.ino === b.repoDevIno.ino &&
      policyFingerprint(o.identity.policy) === b.policyFp &&
      o.identity.policy.agents.length === b.agents.length &&
      o.identity.policy.agents.every((a, k) => a === b.agents[k]);
    if (!same) return { kind: 'abort', outcome: 'skipped_binding_changed' };
    if (where !== 'commit' && i.nowMs() - i.startedAtMs >= RSI_MAX_TICK_MS) {
      return { kind: 'time_limit' };
    }
    return { kind: 'continue' };
  };
}

/** confirm 的展示指纹:canonical JSON(`{repo_sha256, repo_dev_ino, agents, exclude_hashes, overlay_sha256, kit_major, stop}`);配置 off 时身份项为 `null` */
export function displayFingerprint(o: RsiObservation): string {
  const id: RsiIdentity | null = o.identity;
  return canonicalJson({
    repo_sha256: id?.repoSha256 ?? null,
    repo_dev_ino: id === null ? null : { dev: id.repoDevIno.dev, ino: id.repoDevIno.ino },
    agents: id === null ? null : [...id.policy.agents],
    exclude_hashes: id === null ? null : [...id.policy.exclude_hashes],
    overlay_sha256: id?.policy.overlay_sha256 ?? null,
    kit_major: id?.policy.kit_major ?? null,
    stop: o.stop,
  });
}
