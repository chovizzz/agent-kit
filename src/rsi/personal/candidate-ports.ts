/**
 * W3 的端口(窄接口;业务依赖端口,具体实现在部署组装处注入 —— SOLID 的 I / D)。
 * 每个端口只承担一件事:读权威记录、读写工作副本、读撤销凭据、读暂存提案、读信号、写审计、落效果。
 * **测试假件遵守与生产实现同一份契约**:读失败 = 抛错或返回 `invalid` / `unavailable`(从不返回「空结果」冒充成功),写失败 = 抛错。
 *
 * 真实实现的归属(本块只交付 `candidate-repo.ts` 一个真实适配器 = 私有仓库的读与提交):
 *  - 工作副本 / 审计 / 墓碑 / 否决 / 冷却:`.state/rsi/**` 的读写,随各自的所有者块装配(W5 / W7);
 *  - 信号读、暂存提案读:复用 `loadRunEntries` 与信号库读取,在 worker 装配处适配。
 */
import type { RsiAutoPauseReason } from '../../contracts/rsi.js';
import type {
  CandidateWorkingCopy,
  PersonalLifecycleRecord,
  RsiAuditLine,
  RsiRevocationLine,
} from '../../contracts/rsi-personal.js';
import type { Signal } from '../../contracts/signal.js';
import type { DedupeTarget } from '../../reflect/dedupe.js';
import type { CommitResult, TreeSpec } from './commit.js';
import type { GateFacts } from './gate-types.js';
import type { StagedProposal } from './candidate-source.js';
import type { TransitionEffect } from './transition.js';
import type { PromoteBase } from './transition-table.js';

/** 私有仓库(权威副本)的读结果。`deferred` = 人工分叉 / 换了仓库(R21-3.5 情形 ② / ④):不读不写,暂停增加影响 */
export type RepoRead<T> =
  | { kind: 'ok'; head: string; value: T }
  | { kind: 'absent' }
  | { kind: 'deferred'; reason: 'personal_repo_diverged' | 'personal_owner_changed'; why: string }
  | { kind: 'invalid'; why: string };

export type RecordRead =
  | { kind: 'ok'; head: string; record: PersonalLifecycleRecord }
  | { kind: 'missing'; head: string }
  | Exclude<RepoRead<never>, { kind: 'ok' }>;

/** 权威副本:私有仓库 `lifecycle/<id>.json`。调用方已持 `personal/lock`;每次调用都真读(不缓存) */
export interface AuthoritativeStore {
  readAll(): Promise<RepoRead<PersonalLifecycleRecord[]>>;
  read(id: string): Promise<RecordRead>;
  /** 经 W2 的 `commitPersonal` 提交(只读 / 写锁由实现自己断言) */
  commit(spec: TreeSpec): Promise<CommitResult>;
}

/** 工作副本 `.state/rsi/candidates/<id>.json`(含 shadow 计数与两个日期) */
export interface WorkingStore {
  list(): Promise<CandidateWorkingCopy[]>;
  put(copy: CandidateWorkingCopy): Promise<void>;
}

export type RevocationRead =
  | { kind: 'ok'; lines: readonly RsiRevocationLine[] }
  /** 读不到 / 超过 `RSI_REVOCATIONS_MAX_BYTES` / 解析失败:一律按「读取失败」处理(R21-6.11 第 4a 行),调用方不得授予任何影响 */
  | { kind: 'invalid'; why: string };
export interface RevocationReader {
  read(): Promise<RevocationRead>;
}

export interface StagedSource {
  /** 全部暂存提案(只读;装载失败的文件由实现按 `loadRunEntries` 的口径抛错) */
  list(): Promise<StagedProposal[]>;
}

export interface SignalLookup {
  /** 按 `sig_id` 取信号;库里没有的 id 不在结果里;读失败抛错 */
  getMany(sigs: readonly string[]): Promise<Signal[]>;
}

export interface PresetSource {
  /** 预置技能(`source=package`)的比对形:`overlaps_preset` 与 G4 近重复共用 */
  presets(): Promise<DedupeTarget[]>;
}

export interface AuditSink {
  append(lines: readonly RsiAuditLine[]): Promise<void>;
}

/** 转移引擎产出的外部效果(黑名单 / 墓碑 / 冷却)。持久化的 outbox 归 W7;失败抛错,步骤把它记为 `effects_failed` */
export interface EffectSink {
  apply(effects: readonly TransitionEffect[]): Promise<void>;
}

/**
 * worker 在入口事件之间对账用的标记(`.state/rsi/worker-marks.json` 一类的小文件)。
 * W0-13:`rsi auto pause` / `resume`、`enabled` 翻转、配置或策略指纹变化、私有仓库从不可达 / 分叉恢复、撤销凭据新增 → 清空全部 `queued_since`。
 */
export interface WorkerMarks {
  enabled: boolean;
  paused: boolean;
  policyFp: string;
  repoReachable: boolean;
  revocationCount: number;
}
export interface MarksStore {
  read(): Promise<WorkerMarks | null>;
  write(m: WorkerMarks): Promise<void>;
}

/** 步骤的环境事实(调用方持锁时读取;推进前会在锁内再读一次) */
export interface StepEnv {
  /** `RSI_AUTO_PHASE`(整数) */
  phase: number;
  /** R21-2.2:`confirmed ∧ enabled ∧ L-auto 通过 ∧ 相位 ≥ V1a` */
  autoLoopEffective: boolean;
  autoPaused: boolean;
  marks: Omit<WorkerMarks, 'revocationCount' | 'repoReachable'>;
}
export interface EnvReader {
  read(): Promise<StepEnv>;
}

/**
 * 闸与推进所需事实的收集器(读侧;端口只返回事实,不做判定)。`null` = 事实不可得 → 步骤按 internal / 不推进处理(fail-closed)。
 * `clusterBusy` 与 `slot_occupied` **不由它给**:二者取决于锁内的权威记录列表,步骤自己算(M13-4)。
 */
export interface FactsProvider {
  gateFacts(
    rec: PersonalLifecycleRecord,
    wc: CandidateWorkingCopy,
  ): Promise<Omit<GateFacts, 'clusterBusy'> | null>;
  promoteFacts(
    rec: PersonalLifecycleRecord,
    wc: CandidateWorkingCopy,
  ): Promise<Omit<PromoteBase, 'slot_occupied'> | null>;
}

export type StepBreaker = Extract<RsiAutoPauseReason, 'gate_internal' | 'personal_repo_invalid'>;

/** 步骤中止的原因(中止 = 之后的子步骤都不做;已提交的转移保留) */
export type StepHalt =
  | 'repo_absent'
  | 'repo_deferred'
  | 'repo_invalid'
  | 'revocations_invalid'
  | 'commit_failed'
  | 'lock_lost';
