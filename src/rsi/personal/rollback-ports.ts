/**
 * W7 回滚 / 撤销执行器的窄端口(SOLID 的 I / D:业务只依赖这里,具体实现在部署组装处注入)。
 * **测试假件遵守与生产实现同一份契约**:读失败 = 抛错或 `unavailable`(不返回「空结果」冒充成功),写失败 = 抛错;
 * 生产里尚未装配的端口用 {@link unwired} 的实现:调用即抛 {@link PortNotWired}(fail-closed,执行器把它当「本段未完成」,不会推进)。
 */
import * as path from 'node:path';
import type { PersonalTxn, RsiRevocationLine } from '../../contracts/rsi-personal.js';
import type { RevocationReader } from './candidate-ports.js';
import { capabilityAvailable } from '../../contracts/rsi.js';
import { readDir } from '../../io/read-fs.js';
import {
  PERSONAL_STATE_FILES,
  readRevocations,
  readTxn,
  removeTxn,
  statePath,
  writeTxn,
  type PersonalHome,
  type StateRead,
} from './home-state.js';
import type { TransitionEffect } from './transition.js';
import { writeRevocation, type RevocationWrite } from './revoke-write.js';

export class PortNotWired extends Error {
  readonly code = 'RSI_PORT_NOT_WIRED';
  constructor(readonly port: string) {
    super(`port not wired: ${port}`);
  }
}

// --- journal(HOME 侧 `rsi-personal/txn/<id>.json`) ---
export interface TxnStore {
  read(id: string): Promise<StateRead<PersonalTxn>>;
  write(t: PersonalTxn): Promise<void>;
  remove(id: string): Promise<void>;
  /** 全部在途 journal 的 txn_id(升序);目录不存在 = 空 */
  list(): Promise<string[]>;
}

const TXN_FILE_RE = /^([0-9a-f]{16})\.json$/;

export function homeTxnStore(h: PersonalHome): TxnStore {
  return {
    read: (id) => readTxn(h, id),
    write: (t) => writeTxn(h, t),
    remove: (id) => removeTxn(h, id),
    async list() {
      let entries;
      try {
        entries = await readDir(statePath(h, PERSONAL_STATE_FILES.txnDir));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw e;
      }
      return entries
        .map((e) => TXN_FILE_RE.exec(path.basename(e.name))?.[1])
        .filter((x): x is string => x !== undefined)
        .sort();
    },
  };
}

// --- 撤销凭据写入(持 personal/lock) ---
export interface RevocationWriter {
  write(line: RsiRevocationLine): Promise<RevocationWrite>;
}
export const homeRevocationWriter = (
  h: PersonalHome,
  assertHeld: () => Promise<void>,
): RevocationWriter => ({ write: (line) => writeRevocation(h, assertHeld, line) });

/** 撤销凭据读:HOME 侧文件;读不到 / 不合规 = `invalid`(调用方不得授予任何影响) */
export const homeRevocationReader = (h: PersonalHome): RevocationReader => ({
  async read() {
    const r = await readRevocations(h);
    if (r.kind === 'invalid') return { kind: 'invalid', why: r.why };
    return { kind: 'ok', lines: r.kind === 'ok' ? r.value : [] };
  },
});

// --- 仓库 `.state` 下授予缓存的清理(canary.json、分组账 stop 行、exec-enabled.json 条目) ---
export type CacheCleanResult = 'cleaned' | 'pending';
export interface CacheCleanup {
  /**
   * `cleaned` = 已清并补 stop 行;`pending` = 本次不访问(仓库不可达 / `stopped` / `off` / 缩减入口),记为待对账(R21-9.1 第二段例外,R21-9.5)。
   * 清理失败抛错 → 第二段判据不成立。
   */
  clean(c: { candidate_id: string; content_sha256: string }): Promise<CacheCleanResult>;
}
/** 缩减入口(`rsi auto clear`)用:仓库 `.state` 一律不访问,恒 `pending`(R21-9.5) */
export const pendingCacheCleanup: CacheCleanup = Object.freeze({
  clean: async (): Promise<CacheCleanResult> => 'pending',
});

// --- 第三段:私有仓库移除(已接受 HEAD 底稿 + 显式 delete,W0-15) ---
export type RepoRemovalResult =
  | { status: 'committed' | 'already' | 'absent' }
  /** R21-9.3a:人工分叉 / 属主变化:不提交、不改引用 / 索引 / 工作树 */
  | { status: 'deferred'; why: string }
  | { status: 'invalid'; why: string };
export interface RepoRemoval {
  /** 删除 `target_paths`(只限 kit 管理命名空间,保留 `lifecycle/<id>.json`);已不存在 = `already`。提交失败 / 并发冲突抛错 */
  remove(
    c: { id: string; content_sha256: string; target_paths: readonly string[] },
    kind: 'rollback' | 'clear',
  ): Promise<RepoRemovalResult>;
}

// --- 第四段:经撤销路径同步 HOME(`syncRevoke`,R21-9.3) ---
export type PayloadSyncResult =
  | { status: 'done' }
  /** 用户改过托管块 / 独占文件:不覆盖,停在 `static_removal_pending`,`rsi auto status` 提示(R21-9.3) */
  | { status: 'drift'; why: string }
  | { status: 'unavailable'; why: string };
export interface PayloadSync {
  /** 以「上次已同步版本减去这些候选」为目标,只删除自动产出的托管块 / 独占文件;不受 `auto_paused` / 候选状态 / `[rsi.auto] enabled` 阻挡 */
  revoke(candidateIds: readonly string[]): Promise<PayloadSyncResult>;
  /** 第四段完成判据:HOME 中该候选的托管块 / 独占文件不存在 */
  absent(candidateId: string): Promise<boolean>;
}
/** 没装配的 `syncRevoke`:任何调用都不推进(fail-closed) */
export const unwiredPayloadSync: PayloadSync = Object.freeze({
  revoke: async (): Promise<PayloadSyncResult> => {
    throw new PortNotWired('payload_sync');
  },
  absent: async (): Promise<boolean> => {
    throw new PortNotWired('payload_sync');
  },
});
/**
 * R21-9.2:V1 没有静态部署(没有任何自动产出的托管块 / 独占文件),第四段判据恒真。
 * 相位到了 `local_payload`(V2)能力可用时,这个恒真实现**自己拒绝**(换成 {@link unwiredPayloadSync}),防止 V2 上线后仍然静默当作「已清理」。
 */
export function v1PayloadSync(phase: number): PayloadSync {
  if (capabilityAvailable('local_payload', phase)) return unwiredPayloadSync;
  return Object.freeze({
    revoke: async (): Promise<PayloadSyncResult> => ({ status: 'done' }),
    absent: async (): Promise<boolean> => true,
  });
}

// --- E1 授权身份变化(R21-9.1 第二段例外;V6a 才有 exec 类) ---
export interface IdentityDeny {
  /** 旧身份的拒绝标记(R21-16.2c `exec-deny/<id>-<identity12>`)是否已落盘 */
  denied(candidateId: string, identity12: string): Promise<boolean>;
  /** 确保标记存在(已存在即成功) */
  deny(candidateId: string, identity12: string, reason: string): Promise<void>;
}
export const unwiredIdentityDeny: IdentityDeny = Object.freeze({
  denied: async (): Promise<boolean> => {
    throw new PortNotWired('identity_deny');
  },
  deny: async (): Promise<void> => {
    throw new PortNotWired('identity_deny');
  },
});

// --- 带键的效果落地(W0-16:效果由调用方持久化事务续做) ---
export type KeyedEffectResult = 'applied' | 'already' | 'deferred';
/**
 * 黑名单 / 墓碑 / 冷却的**按键幂等**落地:同一 `key` 只生效一次(`already` = 之前已落地)。落地与记键必须同一持久化步骤(崩溃后要么都有要么都没有)。
 * `deferred` = 本入口不能访问效果的存放处(缩减入口不访问仓库 `.state`),记为待对账,由 worker 的 `recoverTerminalEffects` 续做。
 */
export interface KeyedEffectSink {
  applyOnce(key: string, effects: readonly TransitionEffect[]): Promise<KeyedEffectResult>;
}
export const deferredKeyedEffects: KeyedEffectSink = Object.freeze({
  applyOnce: async (): Promise<KeyedEffectResult> => 'deferred',
});

/** 没装配的授予缓存清理 / 仓库移除:调用即抛 {@link PortNotWired}(执行器转成 `incomplete`,不推进) */
export const unwiredCacheCleanup: CacheCleanup = Object.freeze({
  clean: async (): Promise<CacheCleanResult> => {
    throw new PortNotWired('cache_cleanup');
  },
});
export const unwiredRepoRemoval: RepoRemoval = Object.freeze({
  remove: async (): Promise<RepoRemovalResult> => {
    throw new PortNotWired('repo_removal');
  },
});
export const unwiredKeyedEffects: KeyedEffectSink = Object.freeze({
  applyOnce: async (): Promise<KeyedEffectResult> => {
    throw new PortNotWired('keyed_effects');
  },
});
