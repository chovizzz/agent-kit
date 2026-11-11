/**
 * 机器闸 G0–G7 的输入事实与结果类型(docs/contracts.md R21-5.1 / R21-5.2;§21.24 W0-6)。
 * **纯类型 + 候选草稿的形状**:闸函数只读这里的快照,不做 I/O(读由 `GateFactsProvider` 端口负责,见 candidate-ports.ts)。
 *
 * 事实字段的 `null` = **不可用**(信号库读不到、墓碑文件损坏、渲染预算探针失败等):闸遇到 `null` 一律抛 {@link GateUnavailableError},
 * 由 `runGates` 归为 `internal`(B2 `gate_internal` 熔断、候选不动),**不是**「按通过处理」,也**不是** `rejected`(R21-1.5 / R21-5.2)。
 */
import type { Atom } from '../../contracts/atom.js';
import type { Proposal } from '../../contracts/proposal.js';
import type { RsiClusterSignatureSchema } from '../../contracts/rsi-personal.js';
import type { z } from 'zod';
import type { DedupeTarget } from '../../reflect/dedupe.js';

export type ClusterSignature = z.infer<typeof RsiClusterSignatureSchema>;

/** 候选草稿:由暂存提案机械派生(candidate-source.ts),创建与闸共用同一份 */
export interface CandidateDraft {
  /** `ra_` + 12 位十六进制(W0-6) */
  id: string;
  category: 'rule' | 'pitfall';
  runId: string;
  proposalId: string;
  proposal: Proposal;
  /** 私有仓库将存放的原子文件(`origin: auto_rsi`)解析结果 */
  atom: Atom;
  /** 私有仓库将存放的原子文件全文 */
  content: string;
  /** 私有仓库相对路径(`rules/<id>.md` 或 `pitfalls/<id>.md`) */
  targetPath: string;
  /** 规范化原子文件的 sha256(`Atom.sha256`,按存放的文件算) */
  contentSha256: string;
  fpHmac: string;
  clusterSignature: ClusterSignature;
  clusterId: string;
}

export type EvidenceAttribution = 'collecting' | 'other' | 'unknown';

/** 一条证据:提案里写的与信号库里取到的并列(摘录机械复制要对得上) */
export interface GateEvidenceItem {
  sig: string;
  excerpt: string;
  /** 信号库里该 `sig_id` 的事实;`null` = 信号已不在库(evidence_stale) */
  signal: null | {
    excerpt: string;
    sessionRef: string;
    /** UTC 日期 `YYYY-MM-DD` */
    day: string;
    /** 项目被排除(R20-4.6) */
    excluded: boolean;
    attribution: EvidenceAttribution;
  };
}

export interface ExistingAtomView extends DedupeTarget {
  title: string;
  layer: string;
}

export interface GateExisting {
  /** 框架与已有原子(含暂存区里别的运行的原子):冲突 / 近重复比对集合 */
  atoms: readonly ExistingAtomView[];
  /** 预置技能(`source=package`):近重复比对集合的一部分,也是 `overlaps_preset` 的来源 */
  presets: readonly DedupeTarget[];
  /** 全部 `stable` 候选(近重复比对集合) */
  stableCandidates: readonly DedupeTarget[];
  /** R21-1.2 框架保护 id:框架方法技能、预置技能、`rules/org/**` 的原子 id */
  frameworkIds: ReadonlySet<string>;
  /** 「安全类」既有原子 id(收集器缺省取 `strength=must` 的原子) */
  safetyAtomIds: ReadonlySet<string>;
  /** 信号库出现过的项目目录名 ∪ `exclude_names` */
  projectNames: readonly string[];
}

/** 自动配额的逻辑分类(R21-5.3:规则 50% / 踩坑 30% / 技能触发描述 20%) */
export type QuotaClass = 'rule' | 'pitfall' | 'skill';

/**
 * 一个渲染目标的预算与自动配额占用(R21-5.3)。计量单位按目标:claude 数行(`max_lines = 200`),其它目标数字节(16384)。
 * `used` = 各分类已占用(同单位),`add` = 本候选渲染后新增(同单位;由收集器按渲染结果给,G5 不自己猜渲染行数)。
 */
export interface GateQuotaTarget {
  target: 'claude' | 'pi' | 'codex';
  unit: 'lines' | 'bytes';
  /** 该目标的预算总量(claude 200 行;其它 16384 字节) */
  total: number;
  used: Readonly<Record<QuotaClass, number>>;
  add: number;
}

export interface GateBudget {
  /** 渲染后各目标 `level=ok`(与自动配额分开:这一项只说渲染预算) */
  renderLevelOk: boolean;
  /** 自动配额档位(`[rsi.auto] profile`);V1 里 medium 与 lite 同行为(W0-10) */
  profile: 'lite' | 'medium' | 'heavy';
  targets: readonly GateQuotaTarget[];
  /** 本次是否同时配对了一条退役(R21-5.3) */
  pairedRetirement: boolean;
}

export interface GateReplay {
  /** 签名在近 30 个 UTC 日信号上回放的命中会话数 / 同期会话数 */
  hitSessions: number;
  totalSessions: number;
}

/** 闸输入快照。每个可能读失败的事实都带 `| null` */
export interface GateFacts {
  draft: CandidateDraft;
  evidence: readonly GateEvidenceItem[] | null;
  /** 踩坑:`trigger` 在历史失败信号里的命中次数;非踩坑可传 0 */
  failureTriggerHits: number | null;
  /** 当前文本的脱敏第二遍结果(`pass2.clean`) */
  pass2Clean: boolean | null;
  existing: GateExisting | null;
  tombstoned: boolean | null;
  cooldownActive: boolean | null;
  budget: GateBudget | null;
  replay: GateReplay | null;
  /** 同聚类是否已有别的(更早进入流程的)非终态候选 */
  clusterBusy: boolean | null;
}

export type GateId = 'g0' | 'g1' | 'g2' | 'g3' | 'g4' | 'g5' | 'g6' | 'g7';
export const GATE_ORDER: readonly GateId[] = Object.freeze([
  'g0',
  'g1',
  'g2',
  'g3',
  'g4',
  'g5',
  'g6',
  'g7',
]);

/** 单个闸的判定:`null` = 绿;字符串 = 红的原因码;G7 的 `queued` 单独表示(排队,不拒) */
export type GateVerdict = null | { red: string } | { queued: 'g7_queued' };

export type GateOutcome =
  | { kind: 'green' }
  | { kind: 'red'; gate: GateId; reason: string }
  | { kind: 'queued'; reason: 'g7_queued' }
  /** 闸实现抛错 / 事实不可用:B2 `gate_internal` 熔断;**不是** rejected,候选停在 proposed(R21-5.2 / R21-1.5) */
  | { kind: 'internal'; gate: GateId; detail: string };

/** 闸读不到所需事实 */
export class GateUnavailableError extends Error {
  readonly code = 'RSI_GATE_UNAVAILABLE';
  constructor(readonly fact: string) {
    super(`gate fact unavailable: ${fact}`);
  }
}

/** 该闸尚未实现的类别(V3 的方法 / 技能 / 子代理等):fail-closed,不当作通过 */
export class GateNotImplementedError extends Error {
  readonly code = 'RSI_GATE_NOT_IMPLEMENTED';
  constructor(readonly what: string) {
    super(`gate not implemented: ${what}`);
  }
}
