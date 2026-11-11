/**
 * 候选来源与草稿(docs/contracts.md §21.24 W0-6 / W0-2;R21-3.10)。**纯函数、无 I/O**:读暂存提案与信号库由端口完成(candidate-ports.ts)。
 *
 * 成为候选的条件(W0-6):`layer=personal ∧ op=add ∧ targets.length=1`,且暂存规则文件能按 `judge --ingest` 同口径装载(`parseAtom` 成功、
 * 原子 id 与提案目标一致)。**其余提案既不成候选也不报错**(`selectable` 返回 false,调用方不计、不审计)。
 * 一提案一候选(Q-N4-10 = A)。类别机械判:`kind=fact ∧ volatility=volatile ∧ trigger 非空` → pitfall,其余 → rule。
 * 候选 id 由 W1 的 `candidateId` 派生(崩溃重做得同一 id)。私有仓库里的原子文件把 `origin` 改为 `auto_rsi`(R21-3.10 的唯一来源值),
 * 改写后重新解析并核对正文与 id 未变,否则放弃该候选(fail-closed,不是写入半改的文件)。
 */
import { createHash } from 'node:crypto';
import { parseAtom } from '../../atoms/parse.js';
import type { Proposal } from '../../contracts/proposal.js';
import { RSI_SIGNATURE_MAX_TOKENS } from '../../contracts/rsi.js';
import type { Signal } from '../../contracts/signal.js';
import { canonicalJson } from '../../io/canonical-json.js';
import { tokenSet } from '../../reflect/text.js';
import { candidateId } from './ids.js';
import { expectedTargetPath } from './gates.js';
import type { CandidateDraft, ClusterSignature } from './gate-types.js';

/** 暂存提案的读出形状(由 `loadRunEntries` 的 `LoadedProposal` 适配而来) */
export interface StagedProposal {
  runId: string;
  proposal: Proposal;
  /** 暂存规则文件全文 */
  ruleText: string;
}

/** W0-6 的来源条件:只看提案形状(规则文件能否装载另见 {@link buildDraft}) */
export function selectable(p: Proposal): boolean {
  return p.layer === 'personal' && p.op === 'add' && p.targets.length === 1;
}

export type SkipReason =
  'rule_unloadable' | 'id_mismatch' | 'origin_rewrite_failed' | 'signature_unavailable';

export type DraftResult =
  | { kind: 'draft'; draft: CandidateDraft; signals: readonly Signal[] }
  | { kind: 'skip'; reason: SkipReason };

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const HEX16 = /^[0-9a-f]{16}$/;

/** 把原子 frontmatter 里的 `origin` 改为 `auto_rsi`;找不到 frontmatter 返回 undefined */
export function rewriteOrigin(text: string): string | undefined {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '---') return undefined;
  const close = lines.indexOf('---', 1);
  if (close < 0) return undefined;
  const idx = lines.findIndex((l, i) => i > 0 && i < close && /^origin:/.test(l));
  if (idx >= 0) lines[idx] = 'origin: auto_rsi';
  else lines.splice(close, 0, 'origin: auto_rsi');
  return lines.join('\n');
}

const mostCommon = (xs: readonly string[]): string => {
  const n = new Map<string, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? '';
};

/**
 * W0-2 的聚类签名(只用结构化字段与已脱敏摘录,不接受反思器的自由签名字段):
 *  - 证据**全部**是带工具名的失败信号 → `{kind:'tool', tool_name, tool_error_class?}`(取最常见的工具;该工具的失败都带同一个错误类时才加窄);
 *  - 否则 → `{kind:'lesson', rep_tokens}`:证据摘录的 token 频次最高的 ≤ 32 个(多于一条证据时只取出现在不止一条里的),升序去重。
 * 无证据 / 摘录里没有 token → `null`。
 */
export function deriveClusterSignature(signals: readonly Signal[]): ClusterSignature | null {
  if (signals.length === 0) return null;
  const isToolFail = (s: Signal): boolean =>
    s.tool_name !== undefined &&
    (s.event_kind === 'tool_result_failed' || s.type === 'tool_fail_retry');
  if (signals.every(isToolFail)) {
    const tool = mostCommon(
      signals.flatMap((s) => (s.tool_name === undefined ? [] : [s.tool_name])),
    );
    const classes = signals.filter((s) => s.tool_name === tool).map((s) => s.tool_error_class);
    const first = classes[0];
    const uniform = first !== undefined && classes.every((c) => c === first);
    return { kind: 'tool', tool_name: tool, ...(uniform ? { tool_error_class: first } : {}) };
  }
  const freq = new Map<string, number>();
  for (const s of signals) {
    for (const t of tokenSet(s.excerpt_redacted)) {
      if (t.length <= 64) freq.set(t, (freq.get(t) ?? 0) + 1);
    }
  }
  const floor = signals.length > 1 ? 2 : 1;
  const picked = [...freq.entries()]
    .filter(([, n]) => n >= floor)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, RSI_SIGNATURE_MAX_TOKENS)
    .map(([t]) => t)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return picked.length === 0 ? null : { kind: 'lesson', rep_tokens: picked };
}

/** 稳定的聚类 id:`c_` + 签名 canonical JSON 的 sha256 前 8 位(同签名同 id;不依赖某次 reflect 运行的序号) */
export const clusterIdOf = (sig: ClusterSignature): string =>
  `c_${sha256Hex(canonicalJson(sig)).slice(0, 8)}`;

export interface BuildDraftDeps {
  /** 本机密钥 HMAC(R21-11.2):输入规范化正文,输出 16 位十六进制 */
  fingerprint(canonicalBody: string): string;
}

/**
 * 暂存提案 → 候选草稿。`signals` = 提案证据 `sig` 在信号库里对应的信号(调用方读;缺失的 sig 不在其中)。
 * 任何一步不成立返回 `skip`,**不抛、不写**。
 */
export function buildDraft(
  staged: StagedProposal,
  signals: readonly Signal[],
  deps: BuildDraftDeps,
): DraftResult {
  const { proposal, runId, ruleText } = staged;
  const parsed = parseAtom(ruleText, `rules/personal/${proposal.targets[0] ?? 'unknown'}.md`);
  if (parsed.atom === undefined) return { kind: 'skip', reason: 'rule_unloadable' };
  const staged_ = parsed.atom;
  if (staged_.fm.id !== proposal.targets[0]) return { kind: 'skip', reason: 'id_mismatch' };

  const content = rewriteOrigin(ruleText);
  const stored =
    content === undefined ? undefined : parseAtom(content, 'personal/candidate.md').atom;
  if (
    content === undefined ||
    stored === undefined ||
    stored.fm.origin !== 'auto_rsi' ||
    stored.fm.id !== staged_.fm.id ||
    stored.body.do !== staged_.body.do ||
    stored.body.why !== staged_.body.why ||
    stored.body.verify !== staged_.body.verify
  ) {
    return { kind: 'skip', reason: 'origin_rewrite_failed' };
  }

  const sig = deriveClusterSignature(signals);
  if (sig === null) return { kind: 'skip', reason: 'signature_unavailable' };

  const category: CandidateDraft['category'] =
    stored.fm.kind === 'fact' &&
    stored.fm.volatility === 'volatile' &&
    stored.fm.trigger !== undefined &&
    stored.fm.trigger.length > 0
      ? 'pitfall'
      : 'rule';
  // content_sha256:按**存放的文件**算(R21-3.7「规范化正文的 sha256」;与 judge 的 rule_sha256 不是同一个量)
  const contentSha256 = stored.sha256;
  const id = candidateId(runId, proposal.id, contentSha256);
  const fpHmac = deps.fingerprint(`${stored.body.do}\n${stored.body.why}\n${stored.body.verify}`);
  if (!HEX16.test(fpHmac)) throw new Error('fingerprint 必须返回 16 位十六进制');

  return {
    kind: 'draft',
    signals,
    draft: {
      id,
      category,
      runId,
      proposalId: proposal.id,
      proposal,
      atom: stored,
      content,
      targetPath: expectedTargetPath(id, category),
      contentSha256,
      fpHmac,
      clusterSignature: sig,
      clusterId: clusterIdOf(sig),
    },
  };
}
