/**
 * 非 LLM 合并器:把通过校验的提案草稿变成 `proposals/<id>.yaml` 与 `rules/<layer>/<id>.md`。
 * LLM 只贡献文字字段(id/title/do/why/verify/kind/volatility/applies_to/signature/rationale/证据别名);
 * 以下全部由本模块写死或机械计算,草稿里即使混进同名字段也被忽略:
 *  status=proposed、strength=should、不产出 disables/overrides、verifier=none、layer、owner、created/review_by、
 *  evidence[](摘录从信号机械复制)、支持次数(会话/项目数)。
 */
import { stringify } from 'yaml';
import { ProposalSchema, type Proposal, type ReflectorGuidance } from '../contracts/proposal.js';
import type { Layer } from '../contracts/atom.js';
import type { ReflectorProposalDraft } from '../contracts/reflect.js';
import { addDays } from '../atoms/dates.js';
import { parseAtom } from '../atoms/parse.js';
import type { Cluster, EvidenceItem } from './types.js';

export const REVIEW_DAYS_STABLE = 90;
export const REVIEW_DAYS_VOLATILE = 30;

export interface ReflectorInfo {
  provider: string;
  vendor: string;
  model: string;
  run_id: string;
  backend?: 'claude' | 'codex' | 'pi' | undefined;
  prompt_id: string;
  prompt_sha256: string;
  input_digest: string;
  kit_version?: string | undefined;
  stub: boolean;
}

/** 引导窗口基线(只有计数,口径同 attest 的 `countWindow`)。 */
export type GuidanceBaseline = ReflectorGuidance['baseline'];

/** 写进 `reflector.guidance` 的引导窗口落账;不传 = 不写(旧行为)。 */
export interface GuidanceInput {
  /** `reflect --since`;null = 不设下界 */
  since: string | null;
  /** reflect 运行时钟(ISO 时间戳),即 loadSignals 的上界 */
  until: string;
  baselineOf(draft: ReflectorProposalDraft): GuidanceBaseline;
}

export interface MergeInput {
  drafts: readonly ReflectorProposalDraft[];
  items: readonly EvidenceItem[];
  clusters: readonly Cluster[];
  owner: string;
  now: Date;
  reflector: ReflectorInfo;
  /** 已存在的 proposals/<id>.yaml 的 id(含暂存区),用来避开编号冲突 */
  usedProposalIds: ReadonlySet<string>;
  /**
   * 团队层 project_key 白名单:只有列在这里的项目的信号才可能进团队层并计入跨项目/跨会话门槛;
   * 不在名单里的一律按个人处理(fail-closed)。传空集 = 所有项目都是 personal。
   * 不传(undefined)= 不设限(库级默认,仅供不经命令层的直接调用;命令层总是传入集合)。
   */
  teamProjectKeys?: ReadonlySet<string> | undefined;
  guidance?: GuidanceInput | undefined;
}

export interface MergedProposal {
  proposalId: string;
  atomId: string;
  layer: Layer;
  proposal: Proposal;
  proposalPath: string;
  proposalYaml: string;
  atomPath: string;
  atomText: string;
  /** 本提案引用的证据信号 sig_id(测试与泄漏检查用) */
  evidenceSigs: string[];
}

const NL_RE = new RegExp('\\r\\n?|[\\u2028\\u2029\\u0085]', 'g');

/** 段落规范化:统一 LF、去行尾空白。parse 阶段本来就会把 CR 转 LF,这里保证「写出的字节 = lint 看到的字节」。 */
export function normalizeSegment(s: string): string {
  return s
    .replace(NL_RE, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim();
}

function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** 白名单判定:未设白名单 → 不设限;设了(含空集)→ 只有名单内的 key 算团队项目。 */
function isTeamKey(key: string, team: ReadonlySet<string> | undefined): boolean {
  return team === undefined || team.has(key);
}

/** 重新计算:排除非白名单项目成员后,聚类是否仍跨 ≥2 项目且 ≥2 会话。 */
function clusterTeamEligible(c: Cluster, team: ReadonlySet<string> | undefined): boolean {
  const rest = c.allSignals.filter((s) => isTeamKey(s.project_key, team));
  return (
    new Set(rest.map((s) => s.project_key)).size >= 2 &&
    new Set(rest.map((s) => s.session_ref)).size >= 2
  );
}

/**
 * layer 机械判定:证据里**任何一条**是「个人层独有」→ 整条降为 personal。
 * 个人层独有 = 属于个人项目,或所属聚类(排除个人项目成员后)不跨 ≥2 项目且 ≥2 会话。
 * 团队层另要求证据本身覆盖 ≥2 个 project_key 且 ≥2 个会话。
 */
export function decideLayer(
  evidence: readonly EvidenceItem[],
  clusters: readonly Cluster[],
  team?: ReadonlySet<string>,
): Layer {
  const byId = new Map(clusters.map((c) => [c.id, c]));
  for (const e of evidence) {
    if (!isTeamKey(e.signal.project_key, team)) return 'personal';
    const c = byId.get(e.clusterId);
    if (c === undefined || !clusterTeamEligible(c, team)) return 'personal';
  }
  const projects = new Set(evidence.map((e) => e.signal.project_key));
  const sessions = new Set(evidence.map((e) => e.signal.session_ref));
  return projects.size >= 2 && sessions.size >= 2 ? 'team' : 'personal';
}

function nextProposalId(date: string, used: Set<string>): string {
  for (let n = 1; n < 1000; n++) {
    const id = `${date}-${String(n).padStart(3, '0')}`;
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
  throw new RangeError('当日提案编号用尽');
}

const YAML_OPTS = { lineWidth: 0, blockQuote: false } as const;

export function mergeProposals(input: MergeInput): MergedProposal[] {
  const byAlias = new Map(input.items.map((i) => [i.alias, i]));
  const used = new Set(input.usedProposalIds);
  const created = isoDate(input.now);
  const out: MergedProposal[] = [];
  for (const d of input.drafts) {
    const ev = d.evidence.map((a) => {
      const it = byAlias.get(a);
      if (it === undefined) throw new RangeError(`证据别名 ${a} 不在输入中`);
      return it;
    });
    // 个人偏好(kind=preference)再多项目出现也不是团队规则
    const layer: Layer =
      d.kind === 'preference'
        ? 'personal'
        : decideLayer(ev, input.clusters, input.teamProjectKeys);
    const days = d.volatility === 'volatile' ? REVIEW_DAYS_VOLATILE : REVIEW_DAYS_STABLE;
    const doT = normalizeSegment(d.do);
    const whyT = normalizeSegment(d.why);
    const verifyT = normalizeSegment(d.verify);
    const proposalId = nextProposalId(created, used);
    const fm: Record<string, unknown> = {
      id: d.id,
      title: d.title,
      layer,
      strength: 'should',
      ...(d.applies_to !== undefined ? { applies_to: d.applies_to } : {}),
      kind: d.kind,
      volatility: d.volatility,
      status: 'proposed',
      owner: input.owner,
      created,
      review_by: addDays(created, days),
      evidence: ev.map((e) => ({
        type: 'trace',
        ref: e.signal.sig_id,
        excerpt: e.signal.excerpt_redacted,
      })),
      verifier: { type: 'none' },
      signature: { type: d.signature.type, pattern: d.signature.pattern },
      origin: `proposal/${proposalId}`,
    };
    const atomPath = `rules/${layer}/${d.id}.md`;
    const atomText = `---\n${stringify(fm, YAML_OPTS)}---\n\n**做**:${doT}\n**为什么**:${whyT}\n**怎么验**:${verifyT}\n`;
    const parsed = parseAtom(atomText, atomPath);
    if (parsed.atom === undefined) {
      throw new RangeError(
        `合并器产出的原子无法解析:${parsed.diagnostics.map((x) => x.code).join(',')}`,
      );
    }
    const r = input.reflector;
    const proposal = ProposalSchema.parse({
      id: proposalId,
      op: 'add',
      targets: [d.id],
      layer,
      rationale: d.rationale,
      evidence: ev.map((e) => ({
        sig: e.signal.sig_id,
        project_key: e.signal.project_key,
        excerpt: e.signal.excerpt_redacted,
      })),
      budget_delta_bytes: parsed.atom.bodyBytes,
      paired_retirements: [],
      cases: [],
      reflector: {
        provider: r.provider,
        vendor: r.vendor,
        model: r.model,
        run_id: r.run_id,
        ...(r.backend !== undefined ? { backend: r.backend } : {}),
        prompt_id: r.prompt_id,
        prompt_sha256: r.prompt_sha256,
        input_digest: r.input_digest,
        ...(r.kit_version !== undefined ? { kit_version: r.kit_version } : {}),
        ...(r.stub ? { stub: true as const } : {}),
        ...(input.guidance !== undefined
          ? {
              guidance: {
                since: input.guidance.since,
                until: input.guidance.until,
                baseline: input.guidance.baselineOf(d),
              },
            }
          : {}),
      },
    });
    out.push({
      proposalId,
      atomId: d.id,
      layer,
      proposal,
      proposalPath: `proposals/${proposalId}.yaml`,
      proposalYaml: stringify(proposal, YAML_OPTS),
      atomPath,
      atomText,
      evidenceSigs: ev.map((e) => e.signal.sig_id),
    });
  }
  return out;
}
