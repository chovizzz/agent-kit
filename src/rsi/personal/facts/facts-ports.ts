/**
 * §21 装配块 D1a 端口批 a(a4):`FactsProvider` 的组合层所依赖的**窄只读端口**(设计稿 v4 §7)。**只有类型**,不引用任何 C 段类型。
 * 沿用既有 `FactsProvider`(`candidate-port-types.ts`:`gateFacts` / `promoteFacts`,任一事实读失败 → `null`),只追加 `holdFacts()`。
 * 约定(所有端口):读失败抛普通错误 → 组合层映射为「事实不可得」(`null`);**锁丢失(`RsiLockError`)必须原样传播**,与 `shadow-facts.ts` 同口径。
 * 本块只交付纯计算与组合;这些端口的生产适配器(账读、仓库 HEAD 读、taint 标记读、预算 / 回放探针)不在 D1a。
 */
import type { PersonalLifecycleRecord } from '../../../contracts/rsi-personal.js';
import type { RsiEffectsLedger } from '../../../contracts/rsi-store.js';
import type { Signal } from '../../../contracts/signal.js';
import type {
  FactsProvider,
  PresetSource,
  SignalLookup,
  StagedSource,
} from '../candidate-port-types.js';
import type {
  ClusterSignature,
  CandidateDraft,
  EvidenceAttribution,
  GateBudget,
  GateExisting,
  GateReplay,
} from '../gate-types.js';
import type { NearHasher } from '../fp/near-algo.js';

/** 预算熔断两码在 V1 的事实源未查到:恒 `unavailable`。只少一道熔断,**不放行**增影响(记 `triggers_partial` 日志待接线,D1a 无日志端口) */
export interface HoldFacts {
  budget_high_legacy: 'unavailable';
  cost_high_legacy: 'unavailable';
}

export interface FactsProviderD1a extends FactsProvider {
  holdFacts(): HoldFacts;
}

/** 私有仓库 HEAD 里该候选的原子文件全文;文件不在 → `null` */
export interface HeadAtomReader {
  read(rec: PersonalLifecycleRecord): Promise<string | null>;
}

/** effects 账的只读快照(无锁读,靠原子 rename 读到完整版本) */
export interface EffectsLedgerReader {
  read(): Promise<RsiEffectsLedger>;
}

/** 信号所属项目的排除 / 归属判定 */
export interface SignalClassifier {
  classify(signal: Signal): Promise<{ excluded: boolean; attribution: EvidenceAttribution }>;
}

export interface TaintInputsReader {
  /** 来源 run 是否带 TAINTED 标记 */
  runTainted(runId: string): Promise<boolean>;
  purgeJournalPresent(): Promise<boolean>;
}

export interface PolicyReader {
  read(): Promise<{ config_valid: boolean; enabled: boolean; authorized: boolean }>;
}

/** 闸所需、本块不做真适配器的事实(透传;读失败 → `null`) */
export interface GateContextReader {
  /** 踩坑 `trigger` 在历史失败信号里的命中次数 */
  failureTriggerHits(trigger: string): Promise<number>;
  existing(): Promise<Omit<GateExisting, 'presets'>>;
  budget(draft: CandidateDraft): Promise<GateBudget>;
  replay(sig: ClusterSignature): Promise<GateReplay>;
  /** 当前文本的脱敏第二遍是否干净 */
  pass2Clean(text: string): Promise<boolean>;
}

export interface FactsReaders {
  staged: StagedSource;
  signals: SignalLookup;
  presets: PresetSource;
  head: HeadAtomReader;
  ledger: EffectsLedgerReader;
  classifier: SignalClassifier;
  taint: TaintInputsReader;
  policy: PolicyReader;
  context: GateContextReader;
}

export interface FactsProviderDeps {
  readers: FactsReaders;
  /** `BuildDraftDeps.fingerprint`:由 `makeFingerprint(fp.key)` 构造 */
  fingerprint(canonicalBody: string): string;
  now(): Date;
  /** 缺省 = 黑名单只做精确匹配(`fp_hmac` / `content_sha256` / `candidate_id`);给了才做近似匹配。阈值显式传入,不读 `NEAR_ALGO` */
  near?: { hasher: NearHasher; threshold: number } | undefined;
}
