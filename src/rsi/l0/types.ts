/**
 * L0 服务(R20-A2 B4)的共享类型与冻结接口(B4-0 冻结;**B4a / B4b / B4c1 / B4c2 不得改本文件**,要加改动告知主代理)。
 * 依据:docs/contracts.md §20.1 R20-1.4 / R20-1.5a、R20-2.7–2.9、R20-4.1–4.6、R20-6.7–6.9;B4 方案 §1.3。
 *
 * 规划侧约束:本文件与 `src/rsi/l0/` 下除 `commit.ts` / `run.ts` 以外的模块、`src/rsi/exclude-match.ts`、`src/signals/salt-read.ts`
 * 只许 import 无写出口的模块——**不得**(含 `import type`)引入 safe-fs、`lock.ts`、`with-lock.ts`、`state-store.ts`、`session-stats.ts`、`snapshot.ts`
 * (见 `test/rsi/l0-closure.test.ts`)。所以 `RecoverOutcome` 从只读的 `snapshot-read.ts` 取。
 */
import type {
  RsiAgentId,
  RsiCounterCode,
  RsiCounts,
  RsiCursor,
  RsiOutcome,
  RsiPolicy,
  RsiProjectIndex,
  RsiState,
} from '../../contracts/rsi.js';
import type { ReadHeadHooks } from '../../io/read-fs.js';
import type { SessionResult } from '../../signals/pipeline.js';
import type { AttributionProbe } from '../attribution.js';
import type { RecoverOutcome } from '../snapshot-read.js';

// ---------------------------------------------------------------------------
// 会话根与列举(B4a)
// ---------------------------------------------------------------------------
export type AgentRootStatus =
  | { status: 'ok' }
  | { status: 'absent' }
  | { status: 'not_evaluated'; reason: 'root_symlink' | 'root_not_dir' | 'pi_dir_override' };

export interface SessionFile {
  agent: RsiAgentId;
  /** 绝对路径(会话根 + 相对路径,不 realpath) */
  path: string;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}

export interface Enumeration {
  /** 顺序:agent(claude、codex、pi)→ mtime 升序 → path 字节序(R20-6.7 处理顺序) */
  files: readonly SessionFile[];
  roots: Readonly<Record<RsiAgentId, AgentRootStatus>>;
  entriesSeen: number;
  /** 没触发 `RSI_LIMIT_ENTRIES`,且所有 agent 的根都是 `ok` 或 `absent` */
  complete: boolean;
  skipped: { notRegular: number };
  limitsHit: ReadonlySet<RsiCounterCode>;
}

/** 头部解析结果(R20-1.4;解析器只返回它,不保存、不输出行内容) */
export interface HeadMeta {
  /** 非空字符串才算取到;是否绝对路径交给采集策略判 */
  cwd: string | null;
  /** pi:首行是对象、`type` 是字符串但不是 `session`(isClearlyNotPiSession 口径) */
  notASession: boolean;
  /** 解析器实际拿到的行数(读审计:claude ≤ 找到 cwd 的那一行,且 ≤ `RSI_ARMED_CLAUDE_MAX_LINES`) */
  linesSeen: number;
}

/** 各 L0 服务共用的可选依赖与测试缝(缺省 = 真实实现) */
export interface L0Deps {
  /** 头部读取的读审计 / 换链接演练缝 */
  hooks?: ReadHeadHooks;
  /** 归属 / 排除用的 fs 探测 */
  probe?: AttributionProbe;
  now?: () => Date;
  /** 降低上限以便测试(缺省取契约常量) */
  limits?: Partial<{ maxDirEntries: number; armedMaxFiles: number; rebuildMaxFiles: number }>;
  /** 通用故障注入点:在每一步(列举一层目录、读一个头部……)之前调用,`step` 是稳定的短名 */
  beforeStep?: (step: string, absPath: string) => Promise<void> | void;
}

// ---------------------------------------------------------------------------
// armed 列举与 rebuild(B4a / B4c1)
// ---------------------------------------------------------------------------
/** 首次 `armed` 的现算清单(名字 / 路径是原始值,由 `projects.ts` 清洗);`projects.ts` 从这里 re-export */
export interface ArmedListing {
  rows: { name: string; sessions: number; path: string; excluded: boolean }[];
  unknownSessions: number;
}
export interface ArmedListingDetailed extends ArmedListing {
  filesRead: number;
  bytesRead: number;
  /** 升序 */
  limitsHit: RsiCounterCode[];
}

export interface RebuildPlan {
  /** 重建后的索引(`generation` 为旧值或 0;提交侧负责 +1) */
  index: RsiProjectIndex;
  /** 旧索引有效时,从旧条目保留(可信)的条目数 */
  keptFromOld: number;
  /** 本次新观测更新 / 新增的条目数 */
  observed: number;
  filesRead: number;
  bytesRead: number;
  /** 超出 `RSI_REBUILD_MAX_FILES` 而没读头部的文件数(D11) */
  remainingFiles: number;
  /** 算不出 key 的会话数(仍计 U) */
  unknownSessions: number;
  limitsHit: RsiCounterCode[];
}

// ---------------------------------------------------------------------------
// 索引更新与 counts 重算(B4c1)
// ---------------------------------------------------------------------------
/** 读阶段对一个项目根的观测:只含 stat 成功的根(stat 失败 = 不更新这个根,R20-4.2) */
export interface IndexObservation {
  /** `p_…` */
  key: string;
  /** canonical 项目根(绝对路径) */
  path: string;
  dev: number;
  ino: number;
}
export type PerKeyCounts = RsiCounts['per_key'];
export interface UpdateIndexInput {
  prev: RsiProjectIndex | null;
  observations: readonly IndexObservation[];
  /** `recomputeCounts` 的 `perKey`:条目的 `sessions` / `signals` 取 `sessions` / `signals_total` */
  perKey: PerKeyCounts;
  /** 真实盐的指纹(新建索引时写入;`prev` 非空时必须与 `prev.salt_fp` 相等,否则调用方不该调用) */
  saltFp: string;
  /** 本次提交后的 generation */
  generation: number;
  /** UTC 日 `YYYY-MM-DD`(`first_seen` / `last_seen`) */
  today: string;
}
export interface UpdateIndexResult {
  index: RsiProjectIndex;
  /** 满 `RSI_INDEX_MAX_ENTRIES` 后新 key 没有入索引(`RSI_INDEX_FULL`) */
  full: boolean;
  /** 本次新增的 key(升序) */
  newKeys: string[];
}
/**
 * 从磁盘重算的 counts 三段中的两段(D13-A:`clusters` 由提交侧 `commit.ts` 重算——它要用 reflect 的 load,而那条链含 state-store 写出口;
 * `staged` 只重算 `tainted`,其余项保持现值,所以这里给出的是每项的 `tainted` 现值)。
 */
export interface RecomputedCounts {
  perKey: PerKeyCounts;
  unknownKeysSignals: number;
  /** `.state/reflect/<run_id>/TAINTED` 的实际存在情况(≤ `RSI_COUNTS_MAX_STAGED` 次 lstat) */
  stagedTainted: ReadonlyMap<string, boolean>;
}

// ---------------------------------------------------------------------------
// 指纹(B4b)
// ---------------------------------------------------------------------------
export interface CursorFingerprintInput {
  /** 完整 `KIT_VERSION`(D9-A) */
  kitVersion: string;
  policy: RsiPolicy;
  /** overlay 里与脱敏有关字段的 sha256;没有 overlay = null */
  overlayRedactionSha256: string | null;
  saltFp: string;
}

// ---------------------------------------------------------------------------
// 读阶段 / 提交阶段的协议(B4b → B4c2)
// ---------------------------------------------------------------------------
/** 运行绑定(R20-3.9.2):检查点上重新取 `rsiStateOf()` 与它比对 */
export interface RunBinding {
  repoSha256: string;
  repoDevIno: { dev: number; ino: number };
  policyFp: string;
  agents: readonly RsiAgentId[];
  confirmedAt: string | null;
}

export type CheckpointWhere = 'file' | 'lines' | 'commit';
export type CheckpointVerdict =
  | { kind: 'continue' }
  | { kind: 'abort'; outcome: 'stopped' | 'skipped_collect_blocked' | 'skipped_binding_changed' }
  /** 冻结规则:`where === 'commit'` 时永不返回 `time_limit`(已经开始的有序提交一定走完) */
  | { kind: 'time_limit' };
export type Checkpoint = (where: CheckpointWhere) => Promise<CheckpointVerdict>;

/** 读阶段一个文件的结果,映射冻结(B4 方案 §3.1) */
export interface FileOutcome {
  file: SessionFile;
  sessionRef: string;
  status: RsiCursor['files'][string]['status'];
  projectKey: string | null;
  projectRoot: string | null;
  /** R21-1.7;P0 只在内存和日志计数里出现,不落 cursor */
  complete: boolean;
}

/** `tick --json` 去掉 `mode` / `state` / `reason` / `salt` 之后的部分(R20-3.1.4) */
export interface L0Summary {
  outcome: RsiOutcome;
  files_planned: number;
  files_read: number;
  bytes_read: number;
  /** 干跑(D14)与临时盐(`salt: "ephemeral"`)下依赖真实 key / 索引归属的计数不输出:`null`(不是 0,不用临时盐算出的值) */
  signals_new: number | null;
  sessions_new: number | null;
  /** 临时盐 / 首次 armed 没有盐时为 `null`(R20-3.1.1:不输出依赖 key 的计数) */
  projects: { collecting: number; excluded: number; new: number } | null;
  unknown_signals: number | null;
  skipped: {
    not_regular: number;
    too_large: number;
    unchanged: number;
    excluded: number;
    self_state: number;
    unknown_project: number;
  };
  limits_hit: RsiCounterCode[];
  cursor: { fingerprint_match: boolean | null; full_scan: { epoch: number; done: boolean } };
  duration_ms: number;
}

export interface CollectBatch {
  results: ReadonlyMap<RsiAgentId, readonly SessionResult[]>;
  outcomes: readonly FileOutcome[];
  /** 本次读到的项目根观测,供 `updateIndex`(只含 stat 成功的根) */
  observations: readonly IndexObservation[];
  summary: L0Summary;
  verdict: CheckpointVerdict;
  /** 实际读取的字节(含预扫) */
  bytesActual: number;
  /**
   * 列举是否完整(= `Enumeration.complete`:没触发 `RSI_LIMIT_ENTRIES`,且所有 agent 的根都是 `ok` 或 `absent`)。
   * `false` 时 `cursorNext.full_scan.done` 必为 `false`,且不剪除条目(B4 方案 §3.2),提交侧不用重新列举。
   */
  enumerationComplete: boolean;
  /**
   * 拟提交的 cursor:B4b 的纯函数按 epoch 状态机(§3.2)算好(epoch 转换、盖章、剪除、淘汰、`done` / `last_completed_at`);
   * 提交侧 C6 在前面全部步骤成功后原样写出,**不重新推导**。读阶段中止 / `time_limit` 的文件不在其中。
   */
  cursorNext: RsiCursor;
}

/** 只要本次走到提交(成功、中止、time_limit 都算)就调用一次;抛错退出时不调用,attempt 残留,下次记 `crashed` */
export type StateMutator = (prev: RsiState | null, s: L0Summary) => RsiState;

export interface RunL0Input {
  trigger: 'tick' | 'poke' | 'kit';
  recovered: RecoverOutcome;
  binding: RunBinding;
  checkpoint: Checkpoint;
  stateMutator: StateMutator;
}

/** 所有写操作之前调用;实现 = `assertHeld()` + 测试的故障注入点(B3b-4 / D16) */
export type BeforeWrite = (op: string, absPath: string) => Promise<void>;
