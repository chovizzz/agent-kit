/**
 * W3 端口里**只含类型**的那部分(从 `candidate-ports.ts` 原样拆出,装配块 A 段):读侧适配器与 `shadow-facts.ts` 只依赖这里,
 * 不必为了几个接口类型把 `candidate-ports.ts` 对 `commit.ts`(git 出口)的类型引用带进读侧的 import 闭包(含类型口径)。
 * `candidate-ports.ts` 再导出全部名字,既有 import 不变。契约说明见 `candidate-ports.ts` 头注。
 */
import type {
  CandidateWorkingCopy,
  PersonalLifecycleRecord,
  RsiRevocationLine,
} from '../../contracts/rsi-personal.js';
import type { Signal } from '../../contracts/signal.js';
import type { DedupeTarget } from '../../reflect/dedupe.js';
import type { StagedProposal } from './candidate-source.js';
import type { GateFacts } from './gate-types.js';
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

/** 信号库历史重算某 shadow 候选的首次达标 UTC 日(保留期内能证明达标的最早一天);无法重算返回 null */
export interface ReadySinceRecovery {
  recover(rec: PersonalLifecycleRecord): Promise<string | null>;
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
