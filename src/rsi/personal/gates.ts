/**
 * 机器闸 G0–G7(docs/contracts.md R21-5.1 / R21-5.2 / R21-5.3 / R21-5.4;R21-1.5 不降档放行)。**确定性、零 LLM、无 I/O**。
 *
 * 每个闸是 `(facts) => GateVerdict` 的纯函数;`runGates` 按 G0 → G7 顺序执行,**首个红即停**(后面的闸不再执行):
 *  - 闸红 → `{kind:'red', gate, reason}`,原因码属于封闭枚举(`RSI_GATE_REASONS` ∪ `g0_<ingest 子码>`);
 *  - G7 排队 → `{kind:'queued'}`(不拒、候选停在 proposed);
 *  - **闸实现抛错或所需事实不可用 → `{kind:'internal'}`**:B2 `gate_internal` 熔断,**不记 rejected**(R21-5.2);任何分支都不存在「异常时返回通过」(R21-1.5 变异)。
 *
 * 与契约口径的取舍(全部列入 W3 汇报「问题」节):
 *  - G1 依赖 C1 话术极性修复(backlog 遗留 ①,`scanDangerousPhrases` 已收窄并有 `validate-polarity.test.ts`)。G1 取扫描结果里的**硬拒 id**,
 *    极性类 id(跳过测试 / no-verify / 关钩子 / 破坏性命令 / lint 关闭)归 G2 `g2_risky`;扫描抛错 → internal(= 视为不可用,R21-1.5)。
 *  - G0 含 ingest 同口径的话术 / 不可见字符检查(`g0_injection_suspected_local` / `g0_hidden_chars_in_output`),G1 / G2 是独立复扫(纵深防御);
 *    所以端到端运行时多数话术问题先以 G0 码拒绝,G1 / G2 的话术码只在直接调用闸函数(或 G0 之后新增的文本面)时出现。
 *  - V3 才有的类别(方法 / 技能 / 子代理:`g4_tools_expanded`、`g4_field_not_editable`、`g4_skill_size`)在 V1 没有候选来源(W0-6 只出 rule / pitfall),
 *    遇到其它类别一律抛 {@link GateNotImplementedError}(fail-closed → internal)。
 */
import { SignalTypeSchema } from '../../contracts/signal.js';
import {
  RSI_ATOM_MAX_BYTES,
  RSI_AUTO_LABEL,
  RSI_CANARY_INJECT_MAX_BYTES,
  RSI_GATE_REASONS,
  RSI_MARK_PREFIX,
  rsiG0Reasons,
} from '../../contracts/rsi.js';
import { findDuplicate, type DedupeTarget } from '../../reflect/dedupe.js';
import { hasInvisible, normalizeForMatch, sharesRun } from '../../reflect/text.js';
import {
  ECHO_RUN_CODEPOINTS,
  HARD_PHRASES,
  POLARITY_PHRASES,
  scanDangerousPhrases,
} from '../../reflect/validate.js';
import {
  GATE_ORDER,
  GateNotImplementedError,
  GateUnavailableError,
  type CandidateDraft,
  type GateFacts,
  type GateId,
  type GateOutcome,
  type GateVerdict,
} from './gate-types.js';

// ---------------------------------------------------------------------------
// 常量(代码常量,不可由配置调整;R21 通用约定)
// ---------------------------------------------------------------------------
/** G3:证据至少涉及的不同会话数 / 不同 UTC 日数 */
export const GATE_MIN_EVIDENCE_SESSIONS = 2;
export const GATE_MIN_EVIDENCE_DAYS = 2;
/** G3:踩坑 trigger 在历史失败信号里的最少命中次数 */
export const GATE_MIN_TRIGGER_HITS = 2;
/** G6:签名命中会话数下限 / 占同期会话比例上限 */
export const GATE_REPLAY_MIN_HITS = 2;
export const GATE_REPLAY_MAX_SHARE = 0.5;
/** G5(R21-5.3):新增使配额占用 ≥ 80% 时必须同时配对退役一条 */
export const GATE_QUOTA_PAIRING_RATIO = 0.8;
/** G4:`overlaps_preset` 的功能重叠阈值(低于近重复阈值 0.6 / 0.9;命中只记标志、不拒) */
export const OVERLAP_PRESET_THRESHOLDS = Object.freeze({
  jaccard: 0.35,
  containment: 0.6,
  minTokens: 6,
});
/** G2 `g2_kit_ref`:提及 kit 自身及其指标 / 信号类型的固定词(小写;`rsi` 另按单词边界匹配) */
export const G2_KIT_TERMS: readonly string[] = Object.freeze([
  'agent-kit',
  'agentkit',
  'agent_kit',
  'tool_result_failed',
  'retry_chain',
  'tool_error_class',
  'exposure_rate',
  'sig_id',
  ...SignalTypeSchema.options.filter((s) => s.includes('_')),
]);
/** G2 项目特征:短于这个长度的名字不比对(避免 `a`、`go` 之类噪声) */
export const G2_PROJECT_NAME_MIN_LEN = 3;

const GATE_REASON_SET: ReadonlySet<string> = new Set<string>([
  ...RSI_GATE_REASONS,
  ...rsiG0Reasons(),
]);
const HARD_IDS: ReadonlySet<string> = new Set(HARD_PHRASES.map((p) => p.id));
const POLARITY_IDS: ReadonlySet<string> = new Set(POLARITY_PHRASES.map((p) => p.id));

const red = (reason: string): GateVerdict => {
  // 原因码必须在封闭枚举内:拼错的码不会悄悄进入 transitions[].reason(会在 schema 层才炸)
  if (!GATE_REASON_SET.has(reason)) throw new Error(`未登记的闸原因码:${reason}`);
  return { red: reason };
};
const need = <T>(v: T | null, fact: string): T => {
  if (v === null) throw new GateUnavailableError(fact);
  return v;
};

// ---------------------------------------------------------------------------
// 文本面
// ---------------------------------------------------------------------------
/** 候选的全部文本面(闸统一扫描;顺序固定) */
export function textSurfaces(d: CandidateDraft): string[] {
  const { fm, body } = d.atom;
  return [
    fm.title,
    ...(fm.trigger !== undefined ? [fm.trigger] : []),
    d.proposal.rationale,
    body.do,
    body.why,
    body.verify,
  ];
}
const joined = (d: CandidateDraft): string => textSurfaces(d).join('\n');
const bodyParts = (d: CandidateDraft): string[] => [
  d.atom.body.do,
  d.atom.body.why,
  d.atom.body.verify,
];

/** 规则 / 踩坑的私有仓库路径(R21-3.1 布局):G0 路径守卫与创建共用 */
export function expectedTargetPath(id: string, category: CandidateDraft['category']): string {
  return `${category === 'pitfall' ? 'pitfalls' : 'rules'}/${id}.md`;
}

// ---------------------------------------------------------------------------
// G0:v2 受控入口全量校验(沿用 ingest 的码)
// ---------------------------------------------------------------------------
export function g0(f: GateFacts): GateVerdict {
  const d = f.draft;
  if (
    d.proposal.layer !== 'personal' ||
    d.proposal.op !== 'add' ||
    d.proposal.targets.length !== 1
  ) {
    return red('g0_schema_invalid');
  }
  if (d.atom.fm.layer !== 'personal') return red('g0_schema_invalid');
  if (d.targetPath !== expectedTargetPath(d.id, d.category)) return red('g0_path_guard');
  for (const s of textSurfaces(d)) if (hasInvisible(s)) return red('g0_hidden_chars_in_output');
  const evidence = need(f.evidence, 'evidence');
  for (const e of evidence) {
    if (e.signal === null) return red('g0_evidence_stale');
    if (e.signal.excluded) return red('g0_project_excluded');
    if (e.signal.attribution === 'unknown') return red('g0_attribution_unknown');
    // 摘录机械复制:提案里的摘录必须与信号库逐字一致(agent 不能自带摘录)
    if (e.excerpt !== e.signal.excerpt) return red('g0_schema_invalid');
  }
  for (const e of evidence) {
    for (const part of bodyParts(d)) {
      if (sharesRun(e.excerpt, part, ECHO_RUN_CODEPOINTS)) return red('g0_echo_detected');
    }
  }
  // 话术:ingest 同口径(扫描结果非空即拒);扫描抛错交给 runGates 归 internal
  if (scanDangerousPhrases(joined(d)).blocked.length > 0) {
    return red('g0_injection_suspected_local');
  }
  return null;
}

// ---------------------------------------------------------------------------
// G1:已知注入模式
// ---------------------------------------------------------------------------
/** 终端控制序列:真实 ESC / C1 CSI,以及以文本写出的 `\x1b[`、`\033[`、`\e[`、`\u001b[` 与 OSC 形式 */
const CTRL_SEQ_RE = /[\u001b\u009b]|\\(?:x1b|x9b|033|e|u001b|u009b)(?:\[|\]|\()/i;
/** 技能 / 方法类另扫:执行外部下载、关闭校验 */
const SKILL_RISK_RES: readonly RegExp[] = [
  /(?:curl|wget)[^|\n]*\|\s*(?:sh|bash|zsh)/i,
  /(?:下载|download)[^。.\n]{0,20}(?:并|and|then)\s*(?:执行|运行|run|execute)/i,
  /--insecure|--no-check-certificate|verify\s*[=:]\s*false|strict-ssl\s*[=:]\s*false/i,
  /(?:关闭|禁用|跳过|取消)[^。.\n]{0,8}(?:校验|验证|签名检查)/,
];

export function g1(f: GateFacts): GateVerdict {
  const d = f.draft;
  const text = joined(d);
  const scan = scanDangerousPhrases(text);
  if (scan.blocked.some((id) => HARD_IDS.has(id))) return red('g1_phrase');
  if (textSurfaces(d).some((s) => hasInvisible(s))) return red('g1_invisible');
  if (!need(f.pass2Clean, 'pass2Clean')) return red('g1_redact');
  if (CTRL_SEQ_RE.test(text)) return red('g1_ctrl');
  if (d.category !== 'rule' && d.category !== 'pitfall') {
    // 技能 / 方法类另扫(V3 才有候选来源);扫描通过也不放行:其余闸未实现该类别
    if (skillRisk(text)) return red('g1_skill');
    throw new GateNotImplementedError(`g1 category=${String(d.category)}`);
  }
  return null;
}

/** 技能 / 方法文本的 G1 补充扫描:执行外部下载、关闭校验 */
export function skillRisk(text: string): boolean {
  return SKILL_RISK_RES.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------
// G2:已知风险模式
// ---------------------------------------------------------------------------
export function g2(f: GateFacts): GateVerdict {
  const d = f.draft;
  const text = joined(d);
  const scan = scanDangerousPhrases(text);
  if (scan.blocked.some((id) => POLARITY_IDS.has(id))) return red('g2_risky');
  const norm = normalizeForMatch(text);
  if (G2_KIT_TERMS.some((t) => norm.includes(t)) || /\brsi\b/.test(norm)) return red('g2_kit_ref');
  const existing = need(f.existing, 'existing');
  for (const name of existing.projectNames) {
    const n = normalizeForMatch(name);
    if (n.length >= G2_PROJECT_NAME_MIN_LEN && norm.includes(n)) return red('g2_project_feature');
  }
  const fm = d.atom.fm;
  const touched = [fm.id, ...(fm.overrides ?? []), ...(fm.disables ?? [])];
  if (touched.some((id) => existing.safetyAtomIds.has(id))) return red('g2_safety_atom');
  return null;
}

// ---------------------------------------------------------------------------
// G3:证据
// ---------------------------------------------------------------------------
export function g3(f: GateFacts): GateVerdict {
  const evidence = need(f.evidence, 'evidence');
  const sigs = evidence.map((e) => need(e.signal, 'evidence.signal'));
  if (new Set(sigs.map((s) => s.sessionRef)).size < GATE_MIN_EVIDENCE_SESSIONS) {
    return red('g3_sessions');
  }
  if (new Set(sigs.map((s) => s.day)).size < GATE_MIN_EVIDENCE_DAYS) return red('g3_days');
  if (f.draft.category === 'pitfall') {
    const hits = need(f.failureTriggerHits, 'failureTriggerHits');
    if (f.draft.atom.fm.trigger === undefined || hits < GATE_MIN_TRIGGER_HITS) {
      return red('g3_trigger');
    }
  }
  if (sigs.some((s) => s.attribution !== 'collecting')) return red('g3_attribution');
  return null;
}

// ---------------------------------------------------------------------------
// G4:冲突 / 重复 / 冷却
// ---------------------------------------------------------------------------
const toTarget = (d: CandidateDraft): DedupeTarget => ({
  id: d.atom.fm.id,
  do: d.atom.body.do,
  why: d.atom.body.why,
  status: d.atom.fm.status,
  signature:
    d.atom.fm.signature === undefined
      ? undefined
      : { type: d.atom.fm.signature.type, pattern: d.atom.fm.signature.pattern },
});

/** 与预置技能功能重叠(未达近重复阈值也会标记):创建时写入 `overlaps_preset` */
export function overlapsPreset(d: CandidateDraft, presets: readonly DedupeTarget[]): boolean {
  return findDuplicate(toTarget(d), presets, OVERLAP_PRESET_THRESHOLDS) !== undefined;
}

export function g4(f: GateFacts): GateVerdict {
  const d = f.draft;
  if (d.category !== 'rule' && d.category !== 'pitfall') {
    throw new GateNotImplementedError(`g4 category=${String(d.category)}`);
  }
  const existing = need(f.existing, 'existing');
  const fm = d.atom.fm;
  if (existing.atoms.some((a) => a.id === fm.id)) return red('g4_conflict');
  if ((fm.overrides?.length ?? 0) > 0 || (fm.disables?.length ?? 0) > 0) return red('g4_override');
  if (fm.strength !== 'should') return red('g4_strength');
  const pool: DedupeTarget[] = [
    ...existing.atoms,
    ...existing.presets,
    ...existing.stableCandidates,
  ];
  if (findDuplicate(toTarget(d), pool) !== undefined) return red('g4_near_dup');
  if (need(f.tombstoned, 'tombstoned')) return red('g4_tombstone');
  if (need(f.cooldownActive, 'cooldownActive')) return red('g4_cooldown');
  if (existing.frameworkIds.has(fm.id)) return red('g4_framework_path');
  return null;
}

// ---------------------------------------------------------------------------
// G5:预算与配额
// ---------------------------------------------------------------------------
/** treat 组注入的追加字节:标记行(≤ 64)+ 标签行 + 哈希行(12 位)+ 正文(R21-6.3 / M11) */
export function injectBytes(d: CandidateDraft): number {
  const marker = Math.max(
    64,
    Buffer.byteLength(`${RSI_MARK_PREFIX} rsm_${'0'.repeat(16)}`, 'utf8'),
  );
  return marker + Buffer.byteLength(RSI_AUTO_LABEL, 'utf8') + 1 + 12 + 1 + d.atom.bodyBytes;
}

/** 自动配额占目标预算的比例:25%;lite 档只用一半(12.5%);V1 里 medium 与 lite 同行为(W0-10) */
export const AUTO_QUOTA_RATIO = 0.25;
export const AUTO_QUOTA_SHARE: Readonly<Record<'rule' | 'pitfall' | 'skill', number>> =
  Object.freeze({
    rule: 0.5,
    pitfall: 0.3,
    skill: 0.2,
  });
export function quotaOf(total: number, profile: 'lite' | 'medium' | 'heavy'): number {
  return total * AUTO_QUOTA_RATIO * (profile === 'heavy' ? 1 : 0.5);
}

export function g5(f: GateFacts): GateVerdict {
  const d = f.draft;
  const b = need(f.budget, 'budget');
  if (!b.renderLevelOk) return red('g5_budget');
  if (b.targets.length === 0) throw new GateUnavailableError('budget.targets');
  const cls = d.category; // 'rule' | 'pitfall'(V1);技能类 V3
  for (const t of b.targets) {
    const quota = quotaOf(t.total, b.profile);
    const usedAll = t.used.rule + t.used.pitfall + t.used.skill;
    if (usedAll + t.add > quota) return red('g5_quota');
    if (t.used[cls] + t.add > quota * AUTO_QUOTA_SHARE[cls]) return red('g5_quota');
    if (usedAll + t.add >= GATE_QUOTA_PAIRING_RATIO * quota && !b.pairedRetirement) {
      return red('g5_quota');
    }
  }
  if (d.atom.bodyBytes > RSI_ATOM_MAX_BYTES) return red('g5_atom_bytes');
  if (injectBytes(d) > RSI_CANARY_INJECT_MAX_BYTES) return red('g5_inject_bytes');
  return null;
}

// ---------------------------------------------------------------------------
// G6:回放
// ---------------------------------------------------------------------------
export function g6(f: GateFacts): GateVerdict {
  const r = need(f.replay, 'replay');
  if (r.hitSessions < GATE_REPLAY_MIN_HITS) return red('g6_too_few');
  if (r.hitSessions > GATE_REPLAY_MAX_SHARE * r.totalSessions) return red('g6_too_broad');
  return null;
}

// ---------------------------------------------------------------------------
// G7:退火(同一目标聚类同时只有一个非终态候选;全局名额在 shadow → canary 处另判)
// ---------------------------------------------------------------------------
export function g7(f: GateFacts): GateVerdict {
  return need(f.clusterBusy, 'clusterBusy') ? { queued: 'g7_queued' } : null;
}

export const GATES: Readonly<Record<GateId, (f: GateFacts) => GateVerdict>> = Object.freeze({
  g0,
  g1,
  g2,
  g3,
  g4,
  g5,
  g6,
  g7,
});

/**
 * 按 G0 → G7 顺序执行,首个红 / 排队 / 内部错误即停。
 * **不存在「异常时返回通过」的分支**:抛错(含事实不可用、未实现的类别、未登记的原因码)一律是 `internal`。
 */
export function runGates(facts: GateFacts): GateOutcome {
  for (const gate of GATE_ORDER) {
    let v: GateVerdict;
    try {
      v = GATES[gate](facts);
    } catch (e) {
      return {
        kind: 'internal',
        gate,
        detail: e instanceof Error ? e.message : 'non-error thrown',
      };
    }
    if (v === null) continue;
    if ('red' in v) return { kind: 'red', gate, reason: v.red };
    return { kind: 'queued', reason: v.queued };
  }
  return { kind: 'green' };
}
