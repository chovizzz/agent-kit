/**
 * N4-2 判官裁决的**只读判定**(contracts R20-18.34、W0-27;唯一实现)。纯判定:不读盘、不写盘、不 taint、不拿锁;
 * 一切读取经窄端口 {@link ProposalJudgeSource}(生产适配器见 `read/judge-source.ts`),`ruleSha256` 与 `judgeEvidence` 经 {@link JudgeEnv} 注入。
 *
 * **一份判定,两个消费者**:先算 ①–⑤ 得到 {@link JudgeVerdict}(已校验的裁决记录,或「没有可消费裁决」及原因),
 * 再分两路——{@link evaluateJudgeSignal} 追加 ⑥(`reject` / `injection_suspected` 才是信号,worker 与增影响闸用),
 * `rsi show` 的展示映射(`auto/read/judge-verdict.ts`)直接用 {@link JudgeVerdict}(⑥ 不适用于展示)。展示与消费因此不会分叉。
 *
 * 失败分类(fail-closed,绝不把「读不到」当成「通过」或「无风险」;转移侧一律只会少收紧):
 *  - 确定的「没有可消费裁决」:`no_link` / `run_gone` / `run_excluded` / `not_verified` / `rule_changed` / `not_tightening` / 内容类 `invalid`(解析 / id / layer / 校验失败);
 *  - 运行期读失败(IO 错、超时、读到一半被换、端口未装配、端口返回非法值)= `unreadable`,以及 `source_proposal` 自身损坏 = `invalid` 但按「读不出」对待;
 *  - 两类的转移侧结果相同(`none`),区别只在 {@link GrowthBlock}:调用方(增影响闸)据此决定该候选本 tick 能否增影响(W0-27、装配块 C 的 G6)。
 * 本模块只给出分类,不做闸;不改状态、不中断 worker。
 *
 * import 闭包:只许 `src/contracts/**`、`src/io/canonical-json.ts`(纯函数)与 node:crypto;**不** import `src/lifecycle/**`、`judge-ingest`、`judge/ingest/**`、`io/tty.ts`、`judge/store.ts`、任何写出口。
 */
import { createHash } from 'node:crypto';
import { RunIdSchema } from '../../contracts/common.js';
import {
  JUDGE_IGNORE_REASONS,
  type JudgeIgnoreReason,
  type JudgeSeen,
  type JudgeSignalResult,
} from '../../contracts/judge-signal.js';
import { ProposalSchema, type JudgeRecord, type Proposal } from '../../contracts/proposal.js';
import type { SideEvidence, VendorIssue } from '../../contracts/vendor.js';
import { canonicalJson } from '../../io/canonical-json.js';

/** 单次评估的读预算(毫秒;超时 = `unreadable`) */
export const JUDGE_READ_BUDGET_MS = 2000;

/** 读端口的返回(适配器已按 R20-18.34 ① ② 做完归属与安全读取;③–⑥ 由本模块做) */
export type JudgeSourceRead =
  | { kind: 'run_gone' }
  | { kind: 'run_excluded' }
  /** 运行期读失败:IO 错 / 不安全 / 超时 / 读到一半被换 / 归属读不出 / 提案文件缺失(归属为采集中的 run 不该缺);`why` 只给测试与调试,不进输出 */
  | { kind: 'unreadable'; why: string }
  /** 内容类失败:YAML 无法解析 / 不是对象(确定、可复现) */
  | { kind: 'invalid'; why: string }
  | {
      kind: 'ok';
      /** 解析后的提案对象(未经 schema 校验;跨信任边界,本模块再 `safeParse`) */
      proposal: unknown;
      /** `rules/personal/<target>.md`:`target` 是适配器据 `targets[0]` 读的名字;文件不存在 = `null` */
      rule: { target: string; text: string } | null;
    };

export interface ProposalJudgeSource {
  /** 只读、无副作用;`signal` 中止后适配器应尽快返回(迟到的结果被丢弃) */
  read(runId: string, proposalId: string, ctl: { signal: AbortSignal }): Promise<JudgeSourceRead>;
}

/** 由调用方(装配处)注入的纯函数:`ruleSha256` 唯一实现在 `lifecycle/rule-hash.ts`,`judgeEvidence` 在 `contracts/vendor.ts`(`vendorOverrides` 由装配处绑定) */
export interface JudgeEnv {
  ruleSha256(text: string): string;
  judgeEvidence(p: Proposal): { side: SideEvidence; issues: readonly VendorIssue[] };
}

/**
 * 增影响闸(装配块 C 的 G6)据此拒绝该候选本 tick 增影响;`null` = 本模块不拦(内容类失败、确实没有裁决)。
 *  - `no_source`:`source_proposal` 缺失 / null(V1 创建路径恒写它,缺失属异常);
 *  - `source_gone`:来源 run 目录不存在(gc 只删不含提案的 run,候选的来源 run 含提案,故不该消失);
 *  - `indeterminate`:读不出(含端口未装配、`source_proposal` 损坏)。
 */
export type GrowthBlock = 'no_source' | 'source_gone' | 'indeterminate';

export interface JudgeNone {
  readonly kind: 'none';
  /** R20-18.34 的 8 个忽略原因之一(只进审计 `reason`) */
  readonly reason: JudgeIgnoreReason;
  /** `rsi show` 的取值(R20-18.37):确实「无裁决」= `none`;读 / 解析 / 校验失败 = `invalid` */
  readonly display: 'none' | 'invalid';
  readonly growth: GrowthBlock | null;
  /** 细分码(测试与调试用,不进审计、不进输出) */
  readonly why: string;
}

export interface JudgeVerified {
  readonly kind: 'verified';
  /** ③ 通过的提案(layer personal、op add、单目标) */
  readonly proposal: Proposal;
  readonly judge: JudgeRecord;
  /** ④ 通过的证据侧:`spawned` → `proven`;`session_confirmed` → `self_confirmed` */
  readonly side: SideEvidence;
  /** `session_confirmed`:`confirmation.binding_sha256`;`spawned`:整条记录内容哈希(R20-18.32a) */
  readonly binding_sha256: string;
}

export type JudgeVerdict = JudgeVerified | JudgeNone;

export type JudgeSignal =
  | {
      readonly kind: 'signal';
      /** `judge_injection` 与 `judge_reject` 同时成立取 `injection` */
      readonly verdict: 'reject' | 'injection';
      readonly binding_sha256: string;
      readonly judge_provenance: 'spawned' | 'session_confirmed';
    }
  | JudgeNone;

export interface JudgeEvalOptions {
  budgetMs?: number;
}

const none = (
  reason: JudgeIgnoreReason,
  display: 'none' | 'invalid',
  growth: GrowthBlock | null,
  why: string,
): JudgeNone => ({ kind: 'none', reason, display, growth, why });

const unreadable = (why: string): JudgeNone => none('unreadable', 'invalid', 'indeterminate', why);
const invalid = (why: string): JudgeNone => none('invalid', 'invalid', null, why);

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** `spawned` 记录没有 `confirmation.binding_sha256`:取解析后整条记录(含补上的 `provenance`)的规范 JSON 哈希,显式写与缺省写 `provenance` 结果相同 */
export function judgeRecordSha256(judge: JudgeRecord): string {
  return sha256Hex(canonicalJson(JSON.parse(JSON.stringify(judge))));
}

/** 读端口返回值的运行时校验(跨信任边界):不合形状一律 `null` */
function shapeOf(raw: unknown): JudgeSourceRead | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  switch (r['kind']) {
    case 'run_gone':
    case 'run_excluded':
      return { kind: r['kind'] };
    case 'unreadable':
    case 'invalid':
      return { kind: r['kind'], why: typeof r['why'] === 'string' ? r['why'] : 'unspecified' };
    case 'ok': {
      const rule = r['rule'];
      if (rule === null) return { kind: 'ok', proposal: r['proposal'], rule: null };
      if (typeof rule !== 'object' || rule === undefined) return null;
      const t = rule as Record<string, unknown>;
      if (typeof t['target'] !== 'string' || typeof t['text'] !== 'string') return null;
      return {
        kind: 'ok',
        proposal: r['proposal'],
        rule: { target: t['target'], text: t['text'] },
      };
    }
    default:
      return null;
  }
}

async function readBudgeted(
  source: ProposalJudgeSource,
  runId: string,
  proposalId: string,
  budgetMs: number,
): Promise<JudgeSourceRead | JudgeNone> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<JudgeNone>((resolve) => {
    timer = setTimeout(() => {
      ctl.abort();
      resolve(unreadable('timeout'));
    }, budgetMs);
  });
  const read = (async (): Promise<JudgeSourceRead | JudgeNone> => {
    try {
      const raw = await source.read(runId, proposalId, { signal: ctl.signal });
      return shapeOf(raw) ?? unreadable('port_contract');
    } catch {
      return unreadable('io');
    }
  })();
  try {
    return await Promise.race([read, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * R20-18.34 ①–⑤。`link` = 候选的 `source_proposal`(`null` / 缺失 = 无关联);`source` 为 `null` = 读端口未装配。
 * 永不抛错、不改任何状态。
 */
export async function readJudgeVerdict(
  link: unknown,
  source: ProposalJudgeSource | null,
  env: JudgeEnv,
  opts: JudgeEvalOptions = {},
): Promise<JudgeVerdict> {
  if (link === null || link === undefined) return none('no_link', 'none', 'no_source', 'null');
  // 跨信任边界:权威记录是 strictObject,这里是防御层——损坏不得降级成「无关联」放行
  const l = parseLink(link);
  if (l === null) return none('invalid', 'invalid', 'indeterminate', 'malformed_link');
  if (source === null) return unreadable('unwired');

  const r = await readBudgeted(
    source,
    l.run_id,
    l.proposal_id,
    opts.budgetMs ?? JUDGE_READ_BUDGET_MS,
  );
  if (r.kind === 'none') return r;
  switch (r.kind) {
    case 'run_gone':
      return none('run_gone', 'none', 'source_gone', 'run_gone');
    case 'run_excluded':
      return none('run_excluded', 'none', null, 'run_excluded');
    case 'unreadable':
      return unreadable(r.why);
    case 'invalid':
      return invalid(r.why);
    case 'ok':
      break;
  }

  // ③ ProposalSchema + id / run_id / layer(+ 评审的装载约束:op = add、单目标)
  const parsed = ProposalSchema.safeParse(r.proposal);
  if (!parsed.success) return invalid('schema');
  const p = parsed.data;
  if (p.id !== l.proposal_id) return invalid('id_mismatch');
  if (p.reflector.run_id !== l.run_id) return invalid('run_id_mismatch');
  if (p.layer !== 'personal') return invalid('layer_not_personal');
  if (p.op !== 'add' || p.targets.length !== 1) return invalid('not_reviewable');

  // ④ 记录来源与校验
  const judge = p.judge;
  if (judge === undefined) return none('not_verified', 'none', null, 'judge_absent');
  let ev: { side: SideEvidence; issues: readonly VendorIssue[] };
  try {
    ev = env.judgeEvidence(p);
  } catch {
    return none('not_verified', 'invalid', null, 'evidence_threw');
  }
  const wantTier = judge.provenance === 'spawned' ? 'proven' : 'self_confirmed';
  if (ev.side.tier !== wantTier || ev.issues.length > 0) {
    return none('not_verified', 'invalid', null, 'validation_failed');
  }

  // ⑤ 暂存规则文本与评审绑定的 rule_sha256 一致(`spawned` 记录里它是可选键:缺失不算通过)
  if (judge.rule_sha256 === undefined)
    return none('rule_changed', 'invalid', null, 'rule_sha_unbound');
  if (r.rule === null) return none('rule_changed', 'invalid', null, 'rule_absent');
  if (r.rule.target !== p.targets[0]) return unreadable('port_contract');
  let now: string;
  try {
    now = env.ruleSha256(r.rule.text);
  } catch {
    return invalid('rule_unhashable');
  }
  if (now !== judge.rule_sha256) return none('rule_changed', 'invalid', null, 'rule_sha_mismatch');

  return {
    kind: 'verified',
    proposal: p,
    judge,
    side: ev.side,
    binding_sha256:
      judge.provenance === 'session_confirmed'
        ? judge.confirmation.binding_sha256
        : judgeRecordSha256(judge),
  };
}

/** R20-18.34 ①–⑥:`reject` 或 `injection_suspected` 才是信号(同时成立取 `injection`),否则 `not_tightening` */
export async function evaluateJudgeSignal(
  link: unknown,
  source: ProposalJudgeSource | null,
  env: JudgeEnv,
  opts: JudgeEvalOptions = {},
): Promise<JudgeSignal> {
  const v = await readJudgeVerdict(link, source, env, opts);
  if (v.kind === 'none') return v;
  const { judge } = v;
  if (judge.injection_suspected || judge.verdict === 'reject') {
    return {
      kind: 'signal',
      verdict: judge.injection_suspected ? 'injection' : 'reject',
      binding_sha256: v.binding_sha256,
      judge_provenance: judge.provenance,
    };
  }
  return none('not_tightening', 'none', null, 'not_tightening');
}

function parseLink(link: unknown): { run_id: string; proposal_id: string } | null {
  if (typeof link !== 'object' || Array.isArray(link)) return null;
  const o = link as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== 2 || !keys.includes('run_id') || !keys.includes('proposal_id')) return null;
  const run = o['run_id'];
  const pid = o['proposal_id'];
  if (typeof run !== 'string' || !RunIdSchema.safeParse(run).success) return null;
  if (typeof pid !== 'string' || pid.length < 1 || pid.length > 128) return null;
  return { run_id: run, proposal_id: pid };
}

/** 评估结果 → 审计 / `judge_seen` 的 `result` 取值(R20-18.34 的 8 个原因或 R20-18.35 的转移原因) */
export function judgeResultCode(s: JudgeSignal): JudgeSignalResult {
  if (s.kind === 'none') return s.reason;
  return s.verdict === 'injection' ? 'judge_injection' : 'judge_reject';
}

/** 评估结果 → `judge_seen`(W0-27):`indeterminate` = 该次属「读不出」一类 */
export function judgeSeenOf(s: JudgeSignal): JudgeSeen {
  return {
    result: judgeResultCode(s),
    binding: s.kind === 'signal' ? s.binding_sha256 : null,
    indeterminate: s.kind === 'none' && s.growth === 'indeterminate',
  };
}

/**
 * 增影响闸的判定输入(装配块 C 的 G6 / W9b 的 `check`):有信号 → `signal`(候选本 tick 在终止转移落定前不得增影响);
 * 否则取 {@link GrowthBlock}。`null` = 本模块不拦。
 */
export function growthBlockOf(s: JudgeSignal): GrowthBlock | 'signal' | null {
  return s.kind === 'signal' ? 'signal' : s.growth;
}

/** 封闭集合的运行期校验(审计行 / `judge_seen` 读回时用):是否 8 个忽略原因之一 */
export function isJudgeIgnoreReason(x: unknown): x is JudgeIgnoreReason {
  return (JUDGE_IGNORE_REASONS as readonly unknown[]).includes(x);
}
