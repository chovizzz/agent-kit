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
import type { PersonalLifecycleRecord, RsiAuditLine } from '../../contracts/rsi-personal.js';
import type { CommitResult, TreeSpec } from './commit.js';
import type { TransitionEffect } from './transition.js';

// 只含类型的读侧端口拆在 `candidate-port-types.ts`;这里再导出,既有 import 不变
import type { RepoRead, RecordRead } from './candidate-port-types.js';

export type {
  RepoRead,
  RecordRead,
  WorkingStore,
  RevocationRead,
  RevocationReader,
  StagedSource,
  SignalLookup,
  PresetSource,
  ReadySinceRecovery,
  FactsProvider,
} from './candidate-port-types.js';

/** 权威副本:私有仓库 `lifecycle/<id>.json`。调用方已持 `personal/lock`;每次调用都真读(不缓存) */
export interface AuthoritativeStore {
  readAll(): Promise<RepoRead<PersonalLifecycleRecord[]>>;
  read(id: string): Promise<RecordRead>;
  /** 经 W2 的 `commitPersonal` 提交(只读 / 写锁由实现自己断言) */
  commit(spec: TreeSpec): Promise<CommitResult>;
}

/**
 * 增影响汇点的注入端口(D1b-2;W0-30 取代 D v4 b4 的「`applyEvent(..., pass?: GrowthPass)`」):**结构类型,不出现任何 stage 类型**
 * (`candidate-apply.ts` / `candidate-step.ts` / `commit.ts` 在 worker 与严格入口的类型闭包里,`GrowthPass` / `GrowthDeny` 进不来)。
 * 真实现(D2 / D3):`claim` 内 `evaluateGrowth` → `checkGrowthVeto`,返回的钩子在 `update-ref` 之前调 `requireGrowth` 与最终复核序列。
 */
export type BeforeRefUpdate = () => Promise<void>;
export type GrowthClaimOp = 'candidate_create' | 'shadow_to_canary' | 'deploy_inject';
export interface GrowthClaimPort {
  /**
   * 取得「本次增影响提交」的最终复核钩子;拒绝 → `{ok:false, code}`(只读,零写入)。钩子由 `commitPersonal` 在 `update-ref` 之前调用,
   * 抛 `BeforeRefUpdateDenied` = 拒绝(`commitPersonal` 返回 `denied`),其它错误原样传播。`cand = null` 对应 `{cap:'candidate_create'}`。
   */
  claim(
    op: GrowthClaimOp,
    cand: { id: string; content_sha256: string } | null,
  ): Promise<{ ok: true; hook: BeforeRefUpdate } | { ok: false; code: string }>;
}

export interface AuditSink {
  append(lines: readonly RsiAuditLine[]): Promise<void>;
  /**
   * 带事件身份的落地(可选;装配了它的落地端优先用它):`idem_key` = 转移条目的稳定键,同一事件只落一次,不靠行内容去重
   * (两个 evidence 不同的合法转移可以产生内容完全相同的行)。没有条目的审计(终态空操作)没有键。
   */
  appendKeyed?(items: readonly { line: RsiAuditLine; idem_key?: string }[]): Promise<void>;
  /**
   * 无键观察行(`evaluation` 一类,没有转移条目、没有事件身份)的落地(可选)。**缺省 = 拒绝落观察行**:调用方记 `effectsFailed`,**不回落 `append`**
   * (生产的带键出口 `keyedAuditSink.append` 对无键行抛 `audit_key_missing`,回落只会把观察行当成无身份的转移行写进去)。
   */
  appendObservation?(row: RsiAuditLine): Promise<void>;
}

/**
 * 转移引擎产出的外部效果(黑名单 / 墓碑 / 冷却)。持久化的 outbox 归 W7;失败抛错,步骤把它记为 `effects_failed`。
 * 终态批次里的 `protection_mark`(W0-23)**只能**经带键的 `KeyedEffectSink.applyOnce(terminal:…)` 与同批效果一起落地;本无键出口收到它必须忽略(回滚执行器的实现就是只处理黑名单、忽略其余)。
 */
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
  /**
   * 入口事件代数:`rsi auto pause` / `resume`、`enabled` 翻转等入口每发生一次加 1(装配处维护)。
   * 只比较两次观测的最终布尔值会漏掉两次 tick 之间「pause → resume」这类来回,所以用单调计数补上。
   */
  resetGen: number;
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

export type StepBreaker = Extract<RsiAutoPauseReason, 'gate_internal' | 'personal_repo_invalid'>;

/** 步骤中止的原因(中止 = 之后的子步骤都不做;已提交的转移保留) */
export type StepHalt =
  | 'repo_absent'
  | 'repo_deferred'
  | 'repo_invalid'
  | 'revocations_invalid'
  | 'commit_failed'
  | 'candidate_invalid'
  | 'lock_lost'
  /** 事件时刻落在已封存区间(W0-26 第 9 条):源提交之前拒绝,零写入;时钟恢复后重跑 */
  | 'sealed_interval';
