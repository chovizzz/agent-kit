/**
 * §21 V1 装配块 C2——S1 / S2 / 污染 / 压缩调度的**窄端口类型与常量**(C v2 §11.1;不改 C1a 冻结的 `stage/ports.ts` / `stage/taint-types.ts`,只在它们之上加)。
 * 只有类型与常量,无 I/O。生产实现在 `src/rsi/assemble-personal.ts`(唯一拿真实写出口的装配层);本目录其余文件是纯编排,经这些端口注入。
 */
import type { PersonalFault } from '../stage/errors.js';
import type { JudgeReduceSlot } from '../judge-slot.js';
import type {
  Compactor,
  RecoveryPort,
  ReducePort,
  SafetyPort,
  StepOutcome,
} from '../stage/ports.js';
import type { TaintCandidate, TaintScanner } from '../stage/taint-types.js';

/**
 * `RoundBudget` 的 `startRollback` 上限(C1b 把它留给 C2;契约里没有对应常量,故落在这里并有测试钉住)。
 * 取法:全局评估名额只有 1 个(`evaluationSlotOccupied`:任一 canary / adopted / 观察中的 stable 即占用)× 三个调用方(污染 / 分析 / 到期)+ 1 个 S1 对账余量。
 */
export const START_ROLLBACK_LIMIT = 4;

/**
 * 污染凭据 / 回滚写失败(写结果不可判定):装配层的 `applyTaint` 抛它(写适配器据此使本轮 unsettled,下轮幂等重试),
 * S2 编排把它归成稳定码 `taint_apply_failed` + 失败候选 id 进 faults(不再是 `step_threw:TaintApplyFailed`)。
 */
export class TaintApplyFailed extends Error {
  override readonly name = 'TaintApplyFailed';
  /** 失败候选 id */
  readonly ids: readonly string[];
  constructor(ids: readonly string[]) {
    super('taint_apply_failed');
    this.ids = ids;
  }
}

/** 候选列表(S2 的输入):权威副本读不出 / 不存在时不判、不转移(读端口契约:读失败 = `unavailable`,从不返回空列表冒充成功) */
export type CandidateListing =
  | {
      readonly kind: 'ok';
      /** 非终态候选的污染扫描输入 */
      readonly cands: readonly TaintCandidate[];
      /** lifecycle = canary 的候选 id(分析链 / 到期 / unknown 来源的只停注入都只对它们) */
      readonly canaryIds: readonly string[];
    }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unavailable'; readonly why: string };
export interface CandidateSource {
  list(): Promise<CandidateListing>;
}

/** 污染扫描的事实端口(只读;`readPurgeJournal` / `readMark` 的窄化。purge journal **只经** `services/purge-journal.ts` 的同一个解析函数) */
export type PurgeJournalFacts =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ok'; readonly runs: readonly string[] }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unreadable' };
export type RunTaintState = 'tainted' | 'clean' | 'missing' | 'unreadable';
export type StagingBound = 'ok' | 'too_large' | 'unsafe_entry' | 'untrusted';
export interface TaintFactsPort {
  journal(): Promise<PurgeJournalFacts>;
  /** 暂存 run 的 `TAINTED` 标记 + 目录是否在 */
  runState(runId: string): Promise<RunTaintState>;
  stagingBound(): Promise<StagingBound>;
}

/** 到期轮的重扫(幂等的减影响:新命中排除 key 的暂存 run 先落 `TAINTED`);非 due 的轮不调 */
export interface ExcludeRescan {
  rescan(): Promise<StepOutcome>;
}

/** S1 的端口束(`RecoveryPort` 即冻结的端口) */
export interface S1Ports {
  readonly recovery: RecoveryPort;
}

/** S2 的端口束 */
export interface S2Ports {
  readonly reduce: ReducePort;
  readonly safety: SafetyPort;
  readonly scanner: TaintScanner;
  readonly candidates: CandidateSource;
  readonly rescan: ExcludeRescan;
  /** W9 槽 4b(缺省 `UNAVAILABLE_JUDGE.reduce`) */
  readonly judge: JudgeReduceSlot;
}

export type { Compactor };

/** 步骤结果 → 故障的稳定短标签(只放 `[a-z0-9_:]`,≤ 48;不放错误消息 / 路径) */
export const tagOf = (s: string): string => s.replace(/[^a-z0-9_:]/gi, '_').slice(0, 48);

export const faultOfOutcome = (step: string, o: StepOutcome): PersonalFault | null => {
  switch (o.kind) {
    case 'done':
    case 'skipped':
      return null;
    case 'incomplete':
      return { code: 'step_halted', detail: tagOf(`${step}_incomplete:${o.why}`) };
    case 'failed':
      return { code: 'step_halted', detail: tagOf(`${step}_failed:${o.why}`) };
  }
};
