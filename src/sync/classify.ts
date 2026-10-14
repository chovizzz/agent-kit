import type { RenderAgentId } from '../contracts/common.js';
import type { SyncLedgerEntry } from '../contracts/sync.js';
import {
  SYNC_CHECK_FAILED_REASONS,
  SYNC_FAIL_CLOSED_REASONS,
  SYNC_NOT_RUN_REASONS,
} from '../contracts/sync.js';
import type { DiskEntry, PlanOpName } from './types.js';

/**
 * S3:单个目标的分类规则(纯函数,设计稿 §1.2 / §1.3)。
 * 一个「目标」= 一个 (路径, 托管块 id?);owned 目标的指纹是整文件 sha,block 目标的指纹是块体 sha。
 */

/** 稳定码常量(取自契约清单,拼写错误编译期即红)。 */
export const CODE = {
  DRIFTED: 'SYNC_DRIFTED',
  TARGET_FOREIGN: 'SYNC_TARGET_FOREIGN',
  UNMANAGED_IN_OWNED_DIR: 'SYNC_UNMANAGED_IN_OWNED_DIR',
  PATH_SYMLINK: 'SYNC_PATH_SYMLINK',
  PATH_HARDLINK: 'SYNC_PATH_HARDLINK',
  PATH_NOT_REGULAR: 'SYNC_PATH_NOT_REGULAR',
  BLOCK_CORRUPT: 'SYNC_BLOCK_CORRUPT',
  SHARED_PATH_CONFLICT: 'SYNC_SHARED_PATH_CONFLICT',
  LEDGER_INVALID: 'SYNC_LEDGER_INVALID',
  PAYLOAD_INVALID: 'SYNC_PAYLOAD_INVALID',
  WRITE_DENIED: 'SYNC_WRITE_DENIED',
  TXN_INCOMPLETE: 'SYNC_TXN_INCOMPLETE',
  NO_PAYLOAD: 'SYNC_NO_PAYLOAD',
} as const satisfies Record<string, string>;

/** 计划器会产出的稳定码;test 断言它与夹具覆盖清单相等。 */
export const PLANNER_CODES: readonly string[] = Object.values(CODE);

/** 契约里属于 sync 的、但不由计划器判定的稳定码(锁 / 回滚前提在 S4 的执行层判断)。 */
export const NON_PLANNER_CODES: readonly string[] = ['SYNC_LOCKED', 'SYNC_ROLLBACK_MISMATCH'];

/** 契约 §19.2 的全部 SYNC_ 稳定码(退出 1 / 3 / 4 三类)。 */
export const ALL_CONTRACT_CODES: readonly string[] = [
  ...SYNC_CHECK_FAILED_REASONS,
  ...SYNC_FAIL_CLOSED_REASONS,
  ...SYNC_NOT_RUN_REASONS,
];

/** 我们独占的目录:里面多出来的文件只报告、保留。 */
export const OWNED_DIRS: readonly string[] = ['.claude/rules/agent-kit/'];

export function targetKey(path: string, blockId?: string): string {
  return `${path}\u0000${blockId ?? ''}`;
}

export interface DesiredTarget {
  path: string;
  mode: 'owned' | 'block';
  blockId?: string;
  /** payload 里该目标的 sha(owned = 全文,block = 块体) */
  sha: string;
  /** 本次集合内请求它的 agent */
  agents: readonly RenderAgentId[];
}

// ---------------------------------------------------------------------------
// 预检:任何一条命中则整次 refuse-all
// ---------------------------------------------------------------------------

export interface PreflightHit {
  op: Extract<PlanOpName, 'refuse_link' | 'refuse_not_regular' | 'refuse_block_corrupt'>;
  code: string;
}

export function preflightEntry(d: DiskEntry, blockId?: string): PreflightHit | null {
  if (d.linkedSegment === true || d.kind === 'symlink') {
    return { op: 'refuse_link', code: CODE.PATH_SYMLINK };
  }
  if (d.kind === 'hardlink') return { op: 'refuse_link', code: CODE.PATH_HARDLINK };
  if (d.kind === 'dir' || d.kind === 'other') {
    return { op: 'refuse_not_regular', code: CODE.PATH_NOT_REGULAR };
  }
  if (blockId !== undefined && d.blocks?.[blockId]?.state === 'corrupt') {
    return { op: 'refuse_block_corrupt', code: CODE.BLOCK_CORRUPT };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 当前指纹
// ---------------------------------------------------------------------------

export interface Current {
  /** 目标内容是否存在(owned:文件;block:该 id 的块) */
  present: boolean;
  sha?: string;
  /** block:标记行 sha 与块体不符(块体被手改) */
  markerDrifted: boolean;
  restBlank: boolean;
}

export function currentOf(d: DiskEntry, blockId?: string): Current {
  if (d.kind !== 'file') return { present: false, markerDrifted: false, restBlank: false };
  if (blockId === undefined) {
    return d.sha256 === undefined
      ? { present: false, markerDrifted: false, restBlank: false }
      : { present: true, sha: d.sha256, markerDrifted: false, restBlank: false };
  }
  const b = d.blocks?.[blockId];
  if (
    b === undefined ||
    (b.state !== 'intact' && b.state !== 'drifted') ||
    b.bodySha === undefined
  ) {
    return { present: false, markerDrifted: false, restBlank: false };
  }
  return {
    present: true,
    sha: b.bodySha,
    markerDrifted: b.state === 'drifted',
    restBlank: b.restBlank === true,
  };
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

export type Decision =
  /** 与 payload 一致;`ledgerSha` = 需要把登记 sha 刷成它(用户手改后恰好等于 payload,视为已收敛) */
  | { act: 'noop'; ledgerSha?: string }
  | {
      act: 'write';
      op: 'create' | 'update' | 'block_upsert';
      shaBefore: string | null;
      createdFile: boolean;
      overwroteDrifted: boolean;
    }
  | { act: 'skip_drifted' }
  | { act: 'foreign' }
  /** sha = 磁盘上实际被认领的内容指纹(可能是旧版本),登记表必须记它而不是当前 payload 的 sha */
  | { act: 'adopt'; sha: string }
  | { act: 'drop' }
  | {
      act: 'remove';
      op: 'remove' | 'block_remove';
      shaBefore: string;
      deleteFileIfBlank: boolean;
    }
  | { act: 'orphan_keep' };

export interface DesiredCtx {
  overwriteDrifted: boolean;
  adopt: boolean;
  /** adopt 认可的 sha 集合(含当前 payload sha) */
  known: readonly string[];
}

export function decideDesired(
  t: DesiredTarget,
  L: SyncLedgerEntry | undefined,
  d: DiskEntry,
  ctx: DesiredCtx,
): Decision {
  const isBlock = t.mode === 'block';
  const cur = currentOf(d, t.blockId);
  const writeOp = isBlock ? 'block_upsert' : d.kind === 'file' ? 'update' : 'create';

  if (L === undefined) {
    if (ctx.adopt) {
      if (!cur.present) return { act: 'noop' };
      return cur.sha !== undefined && !cur.markerDrifted && ctx.known.includes(cur.sha)
        ? { act: 'adopt', sha: cur.sha }
        : { act: 'foreign' };
    }
    if (d.kind === 'missing') {
      // 条目目录被别人占着(如 skills-hub 的同名技能目录)但目标文件不在:仍属外来
      if (d.entryOccupied === true) return { act: 'foreign' };
      return {
        act: 'write',
        op: isBlock ? 'block_upsert' : 'create',
        shaBefore: null,
        createdFile: true,
        overwroteDrifted: false,
      };
    }
    // 文件存在:托管块目标在「文件里还没有该块」时是正常首装(追加),其余一律外来
    if (isBlock && !cur.present) {
      return {
        act: 'write',
        op: 'block_upsert',
        shaBefore: null,
        createdFile: false,
        overwroteDrifted: false,
      };
    }
    return { act: 'foreign' };
  }

  if (ctx.adopt) return { act: 'noop' };

  if (!cur.present) {
    return {
      act: 'write',
      op: isBlock ? 'block_upsert' : 'create',
      shaBefore: null,
      createdFile: d.kind === 'missing' ? true : L.created_file,
      overwroteDrifted: false,
    };
  }

  const drifted = cur.markerDrifted || cur.sha !== L.sha256;
  if (!drifted) {
    if (cur.sha === t.sha) return { act: 'noop' };
    return {
      act: 'write',
      op: writeOp,
      shaBefore: cur.sha ?? null,
      createdFile: L.created_file,
      overwroteDrifted: false,
    };
  }
  // 漂移:用户改过。恰好等于 payload 且块标记完好 = 已收敛,只刷登记 sha
  if (cur.sha === t.sha && !cur.markerDrifted) return { act: 'noop', ledgerSha: t.sha };
  if (ctx.overwriteDrifted) {
    return {
      act: 'write',
      op: writeOp,
      shaBefore: cur.sha ?? null,
      createdFile: L.created_file,
      overwroteDrifted: true,
    };
  }
  return { act: 'skip_drifted' };
}

/** 登记过、但本次不再被任何选中的 agent 请求的条目(payload 里没了 / 卸载)。 */
export function decideRemoval(L: SyncLedgerEntry, d: DiskEntry): Decision {
  const cur = currentOf(d, L.block_id);
  if (!cur.present) return { act: 'drop' };
  if (cur.markerDrifted || cur.sha !== L.sha256) return { act: 'orphan_keep' };
  if (L.kind === 'block') {
    return {
      act: 'remove',
      op: 'block_remove',
      shaBefore: L.sha256,
      deleteFileIfBlank: L.created_file && cur.restBlank,
    };
  }
  return { act: 'remove', op: 'remove', shaBefore: L.sha256, deleteFileIfBlank: false };
}
