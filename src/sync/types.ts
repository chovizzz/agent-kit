import type { PayloadManifest } from '../contracts/payload.js';
import type { RenderAgentId } from '../contracts/common.js';
import type { SyncLedger, SyncOp } from '../contracts/sync.js';

/**
 * S3:sync 计划器的输入 / 输出类型(契约 §19.2)。计划器是纯函数:不读盘、不写盘、不联网;
 * 磁盘状态由调用方(S4 的 apply / S5 的 doctor)探测后以结构化快照传入。
 */

// ---------------------------------------------------------------------------
// 磁盘快照
// ---------------------------------------------------------------------------

export type DiskKind = 'missing' | 'file' | 'dir' | 'symlink' | 'hardlink' | 'other';

/** 托管块在某文件里的状态(口径同 src/render/managed-block.ts 的 inspectManagedBlock)。 */
export interface BlockSnapshot {
  /** intact = 标记行 sha 与块体一致;drifted = 块体被手改;block-missing = 文件里没有该 id 的块;corrupt = 标记结构坏 */
  state: 'intact' | 'drifted' | 'block-missing' | 'corrupt';
  /** 块体的实际 sha256(state 为 intact | drifted 时必填) */
  bodySha?: string;
  /** 去掉该块之后,文件其余内容是否只剩空白(卸载时据此决定删不删文件) */
  restBlank?: boolean;
}

/** 一个 HOME 相对路径在磁盘上的现状。未出现在快照里的路径等同 `{ kind: 'missing' }`。 */
export interface DiskEntry {
  kind: DiskKind;
  /** kind=file 时的整文件 sha256 */
  sha256?: string;
  /** 从 HOME 到该路径之间的某一中间段是符号链接 */
  linkedSegment?: boolean;
  /** 目标文件不存在,但它所在的条目目录(如 `.agents/skills/<name>/`)已被别人占用 */
  entryOccupied?: boolean;
  /** 托管块:按 block_id 给出状态 */
  blocks?: Readonly<Record<string, BlockSnapshot>>;
}

export interface DiskSnapshot {
  entries: Readonly<Record<string, DiskEntry>>;
  /**
   * 我们独占的目录(`OWNED_DIRS`)里实际存在的全部文件(目录相对 HOME 的完整路径,递归)。
   * 没给的目录视为「没有探测」,不报 SYNC_UNMANAGED_IN_OWNED_DIR。
   */
  ownedDirListings?: Readonly<Record<string, readonly string[]>>;
  /** 残留的未收尾事务 id(有则整次拒绝 SYNC_TXN_INCOMPLETE) */
  residualTxn?: string | null;
}

// ---------------------------------------------------------------------------
// 输入
// ---------------------------------------------------------------------------

export interface PlanOptions {
  /** 本次的 agent 集合(命令层已按 DEFAULT_SYNC_AGENTS / --agent 解出) */
  agents: readonly RenderAgentId[];
  overwriteDrifted: boolean;
  uninstall: boolean;
  adopt: boolean;
  /** 本次事务 id:被改动的登记条目会记它,未改动的条目保持原 txn */
  txnId: string;
}

export interface PlanInput {
  /** null = 没有 payload;sync / adopt 因此退出 4,uninstall 不需要 payload */
  payload: PayloadManifest | null;
  /** payload manifest 的 sha256(写进登记表头) */
  payloadSha256: string;
  /**
   * payload 文件的实际内容 sha256(键 = `payload_path`;managed-block 为块体 sha)。
   * 与 manifest 声明的 sha 不一致或缺失 → SYNC_PAYLOAD_INVALID。
   */
  payloadSha: Readonly<Record<string, string>>;
  /** adopt 认可的「已知 payload 版本」sha:键 = `targetKey(path, blockId)`;当前 payload 的 sha 总是被认可 */
  knownSha?: Readonly<Record<string, readonly string[]>>;
  ledger: SyncLedger | null;
  disk: DiskSnapshot;
  options: PlanOptions;
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

/** 稳定码(契约 §19.2);`code` 只出现在 skip / refuse / keep 类操作上。 */
export type PlanOpName =
  | SyncOp
  | 'adopt'
  | 'skip_drifted'
  | 'orphan_keep'
  | 'unmanaged_keep'
  | 'refuse_foreign'
  | 'refuse_link'
  | 'refuse_not_regular'
  | 'refuse_block_corrupt'
  | 'refuse_shared_conflict'
  | 'refuse_invalid'
  | 'refuse_denied'
  | 'refuse_residual_txn';

export interface PlanOpBase {
  op: PlanOpName;
  /** HOME 相对受管路径 */
  path: string;
  blockId?: string;
  /** 请求该路径的 agent(本次集合内) */
  agents: readonly RenderAgentId[];
  /** SKIP / REFUSE / KEEP 类操作的稳定码;写操作与 adopt 没有 */
  code?: string;
  /** 写操作:写前整文件 / 块体 sha(null = 不存在);写后 sha(null = 删除) */
  shaBefore?: string | null;
  shaAfter?: string | null;
  /** 写操作:该文件是否由本次新建(登记表 created_file) */
  createdFile?: boolean;
  /** update / block_upsert:覆盖了漂移内容(--overwrite-drifted) */
  overwroteDrifted?: boolean;
  /** block_remove:卸载时登记 created_file=true 且删块后只剩空白 → 连文件一起删 */
  deleteFileIfBlank?: boolean;
  /** 人读备注(不含文件内容 / 绝对路径) */
  detail?: string;
}
export type PlanOp = Readonly<PlanOpBase>;

export const WRITE_OPS: readonly PlanOpName[] = [
  'create',
  'update',
  'remove',
  'block_upsert',
  'block_remove',
];

export interface PlanSummary {
  create: number;
  update: number;
  remove: number;
  block_upsert: number;
  block_remove: number;
  adopt: number;
  skip_drifted: number;
  orphan_keep: number;
  unmanaged_keep: number;
  refuse_foreign: number;
  refuse_all: number;
}

export type PlanStatus = 'ok' | 'refuse-all' | 'not-run';

export interface PlanLedgerResult {
  /** none = 不动;write = 写 `next`;delete = 删登记表 */
  action: 'none' | 'write' | 'delete';
  next: SyncLedger | null;
}

export interface SyncPlan {
  status: PlanStatus;
  /** 按 (path, block_id) 字节序排列;refuse-all / not-run 时只含拒绝类操作,绝无写操作 */
  ops: readonly PlanOp[];
  ledger: PlanLedgerResult;
  summary: PlanSummary;
  /** 退出码建议:0 完成或无变更;1 有跳过项;3 整次拒绝;4 未执行 */
  exit: 0 | 1 | 3 | 4;
  /** 去重、升序的稳定码 */
  codes: readonly string[];
  /** ops 为空且登记表不变(连跳过 / 保留类提示都没有) */
  empty: boolean;
  skippedLayers: readonly string[];
}
