/**
 * 判变差的计算核心(docs/contracts.md R21-7.2 / R21-7.4 / R21-7.4a / R21-7.6 / R21-7.7 / R21-7.8、§21.24 W0-10 V1i-7)。**纯函数,无 I/O**:输入是 `assemble` 的结果。
 *
 * 查看计划是**无状态**的:有观测会话按 `(ts, session_ref)` 排序,第 k 次查看 = 前 `k × RSI_LOOK_EVERY` 个会话的前缀;每次调用从头重算全部查看点
 * (worker 漏跑一轮也不会漏查;置换种子由 (种子, 指标, k) 确定,重算得同一 p)。信息时间 t_k = min(1, 前缀内对照组有观测会话数 / `RSI_MAX_SESSIONS_PER_ARM`)。
 * 每项边界取累计 α*(t_k)(`math.ts`),每项 α = `RSI_ALPHA_WORSE_TOTAL` / 4(C1、C2、C3、C6)。单侧置换 p ≤ 边界 → 该项越界。
 *
 * 取舍(契约未定处,见汇报「问题」):t 与查看节奏按**有观测会话**计(R21-1.7,不含资格),统计量只用「有观测 ∩ 资格成立」;
 * 「每 10 个新有观测会话」按两组合计;C6 检验「差值 = 0」(偏向回滚);C6 只能按 agent 分层(关联失败的会话没有项目);C6 的账行按查看时刻截断
 * (完整行看其会话是否在前缀时间内,不完整行看账行 `at`)。
 *
 * C6 的分母按 ITT(R21-6.7):被随机且**资格成立**的账行;已关联且资格不成立的(`eligible === false`)不进,未关联的资格不可知、保留(审计 `c6_ineligible_excluded`)。
 * R21-6.7「关联失败的按最坏情况做敏感性分析」:`c6_worst_case` 在最后一次查看的时点上,把关联失败的账行按最不利方向插补(treat 记「不完整」、control 记「完整」),
 * 再做一次 C6 置换检验;**只出报告,不参与判定**。C1 / C3 是计数结局,关联失败的会话没有项目(进不了分层)也没有可插补的上界,不做。
 *
 * 背景分段(R21-7.7):段 = 账里**连续**同一 `background_fp` 的一段(A → B → A 是三段,回到旧指纹也从 t = 0 重新计);只分析**当前段**(账里最后一段)的账行与会话,
 * 别的段只出点估计(敏感性),不查看、不产事件。
 * 正向方向恒 `not_decidable`(R21-7.13):本模块没有任何产生「变好」结论的路径,与 `RSI_DECIDE_BETTER_ENABLED` 无关。
 */
import {
  RSI_ANALYSIS_PLAN_VERSION,
  RSI_LOOK_EVERY,
  RSI_MAX_SESSIONS_PER_ARM,
  RSI_PERMUTATIONS,
  RSI_PROTECT_BOUNDS,
} from '../../contracts/rsi.js';
import type { Assembled } from './assemble.js';
import { informationTime, obfCumulativeAlpha } from './math.js';
import { permutationP } from './permute.js';
import type { AnalysisRandom } from './rng.js';
import { buildStrata } from './strata.js';
import { cellOf, statistic, totalValue, type StatKind } from './stats.js';
import {
  ALPHA_PER_METRIC,
  C2_COMPARABLE_AGENTS,
  HARM_P_METRICS,
  type HarmPMetric,
  type ObservedSession,
  type RandomizedLine,
  type Unit,
} from './types.js';

/**
 * 契约常量的集合(R21-7.1:不可配置)。**仅为计算核心的测试接缝**(用小的置换次数 / 上限跑夹具):生产入口 `runAnalysis` 不接受它,恒用 {@link DEFAULT_ANALYSIS_CONFIG}。
 */
export interface AnalysisConfig {
  permutations: number;
  lookEvery: number;
  maxPerArm: number;
  alphaPerMetric: number;
  c4LimitBytes: number;
}

export const DEFAULT_ANALYSIS_CONFIG: AnalysisConfig = Object.freeze({
  permutations: RSI_PERMUTATIONS,
  lookEvery: RSI_LOOK_EVERY,
  maxPerArm: RSI_MAX_SESSIONS_PER_ARM,
  alphaPerMetric: ALPHA_PER_METRIC,
  c4LimitBytes: RSI_PROTECT_BOUNDS.c4_canary_bytes,
});

export type MetricStatus = 'tested' | 'insufficient' | 'no_usable_strata';

export interface MetricLook {
  metric: HarmPMetric;
  status: MetricStatus;
  /** 单侧置换 p;未检验 = `null` */
  p: number | null;
  boundary: number;
  crossed: boolean;
  /** 点估计:C1 / C3 = MH 率比;C2 = 几何均值比;C6 = control − treat 完整率差(百分点) */
  estimate: number | null;
  strata: number;
  pooled_sessions: number;
  dropped_strata: number;
  dropped_sessions: number;
}

export interface LookResult {
  k: number;
  observed: number;
  control_observed: number;
  t: number;
  /** 至少有一项真正做了检验(R21-7.4a:无层可用 = 本次不判定、不消耗 α) */
  valid: boolean;
  metrics: readonly MetricLook[];
}

export interface C6WorstCase {
  /** 对应的查看序号(最后一次查看) */
  k: number;
  /** 该时点上关联失败(不完整)的可判账行数(按组) */
  unlinked: { treat: number; control: number };
  /** 插补后的 C6 检验结果(treat 的关联失败记「不完整」、control 的记「完整」) */
  look: MetricLook;
}

export interface HarmFinding {
  metric: HarmPMetric | 'c4';
  k: number;
  t: number;
  p: number | null;
  boundary: number | null;
}

export interface C4Result {
  status: 'ok' | 'exceeded' | 'unavailable' | 'no_treat';
  bytes: number | null;
  limit: number;
}

export interface PrimaryReport {
  /** 当前段、资格成立的有观测会话上的主判据 MH 率比;无层 / 两组零事件 = `null`(证据不足,R21-7.2 / R21-7.6) */
  rr: number | null;
  control_events: number;
  treat_events: number;
  insufficient: boolean;
}

export interface SensitivitySegment {
  /** 段序号(账里连续同一指纹的一段,从 0 起) */
  run: number;
  background_fp: string;
  observed: number;
  c1_rr: number | null;
  c3_rr: number | null;
  c6_diff_pp: number | null;
}

export interface SegmentAnalysis {
  kind: 'harm' | 'no_harm' | 'no_decision';
  plan_version: number;
  /** R21-7.13:正向方向恒不可判 */
  positive: 'not_decidable';
  background_fp: string | null;
  seed: string;
  looks: readonly LookResult[];
  harm: HarmFinding | null;
  c4: C4Result;
  /** R21-7.4a:一次有效查看都没完成过(到上限时据此走 R21-7.6 的证据不足) */
  never_valid_look: boolean;
  treat_observed: number;
  control_observed: number;
  max_arm_sessions: number;
  primary: PrimaryReport;
  /** R21-7.8:本段账行的 `overlaps_preset`(取最后一行;各行不一致时 `mixed` = true) */
  overlaps_preset: boolean | null;
  overlaps_preset_mixed: boolean;
  /** C6 说明:本段被随机的账行数 / 不完整数(按组;已剔除资格不成立的行) */
  randomized: { treat: number; control: number };
  incomplete: { treat: number; control: number };
  /** C6 分母里剔除的「已关联且资格不成立」账行数(按组;ITT,R21-6.7) */
  c6_ineligible_excluded: { treat: number; control: number };
  /** R21-6.7 最坏情况敏感性(只出报告);没有任何查看 = `null` */
  c6_worst_case: C6WorstCase | null;
  sensitivity: readonly SensitivitySegment[];
}

const KIND: Readonly<Record<HarmPMetric, StatKind>> = Object.freeze({
  c1: 'mh_rr',
  c2: 'mean_diff',
  c3: 'mh_rr',
  c6: 'completeness_diff',
});

const eligibleOf = (s: readonly ObservedSession[]): ObservedSession[] =>
  s.filter((x) => x.eligible);

function sessionUnits(metric: 'c1' | 'c2' | 'c3', s: readonly ObservedSession[]): Unit[] {
  const out: Unit[] = [];
  for (const x of s) {
    let v: number;
    if (metric === 'c1') v = x.c1;
    else if (metric === 'c3') v = x.c3;
    else {
      // C2:缺键 = 未测 / 不可比,不能当 0;codex / kimi 没有工具名,不与 claude / pi 比
      if (x.retry_chain_max === null || !C2_COMPARABLE_AGENTS.includes(x.agent)) continue;
      v = Math.log1p(x.retry_chain_max);
    }
    out.push({ agent: x.agent, project: x.project_key, arm: x.arm, v });
  }
  return out;
}

/** C6:每个可判的账行一个 unit(完整 = 1);无项目,按 agent 分层 */
const lineUnits = (lines: readonly RandomizedLine[]): Unit[] =>
  lines.map((l) => ({ agent: l.agent, project: '*', arm: l.arm, v: l.complete ? 1 : 0 }));

/** C6 分母(ITT):可判、资格没有被判不成立 */
const inC6 = (l: RandomizedLine): boolean => l.judgeable && l.eligible !== false;

function linesAt(lines: readonly RandomizedLine[], horizonMs: number): RandomizedLine[] {
  return lines.filter(
    (l) =>
      inC6(l) && (l.complete ? (l.session_ts_ms as number) <= horizonMs : l.at_ms <= horizonMs),
  );
}

/** 最坏情况插补:关联失败的账行,treat 记「不完整」(0)、control 记「完整」(1);已关联的照旧 */
const worstCaseUnits = (lines: readonly RandomizedLine[]): Unit[] =>
  lines.map((l) => ({
    agent: l.agent,
    project: '*',
    arm: l.arm,
    v: l.complete ? 1 : l.arm === 'control' ? 1 : 0,
  }));

function estimateOf(metric: 'c1' | 'c3' | 'c6', units: readonly Unit[]): number | null {
  const r = buildStrata(units);
  if (r.strata.length === 0) return null;
  const cells = r.strata.map(cellOf);
  if (metric === 'c1' || metric === 'c3') {
    if (totalValue(cells) === 0) return null;
    return statistic('mh_rr', cells);
  }
  return statistic('completeness_diff', cells) * 100;
}

function evalMetric(
  metric: HarmPMetric,
  units: readonly Unit[],
  boundary: number,
  random: AnalysisRandom,
  k: number,
  cfg: AnalysisConfig,
  label: string = metric,
): MetricLook {
  const built = buildStrata(units);
  const base = {
    metric,
    boundary,
    strata: built.strata.length,
    pooled_sessions: built.pooled_sessions,
    dropped_strata: built.dropped_strata,
    dropped_sessions: built.dropped_sessions,
  };
  if (built.strata.length === 0) {
    return { ...base, status: 'no_usable_strata', p: null, crossed: false, estimate: null };
  }
  const cells = built.strata.map(cellOf);
  // 两组均零事件(C1 / C3 / C2 的取值全 0)→ 证据不足,不检验
  if (metric !== 'c6' && totalValue(cells) === 0) {
    return { ...base, status: 'insufficient', p: null, crossed: false, estimate: null };
  }
  const r = permutationP(
    built.strata,
    KIND[metric],
    cfg.permutations,
    random.stream(`${label}:${k}`),
  );
  const estimate =
    metric === 'c2' ? Math.exp(r.observed) : metric === 'c6' ? r.observed * 100 : r.observed;
  return { ...base, status: 'tested', p: r.p, crossed: r.p <= boundary, estimate };
}

export function c4Check(
  bytes: number | null,
  anyTreat: boolean,
  limit: number = RSI_PROTECT_BOUNDS.c4_canary_bytes,
): C4Result {
  if (!anyTreat) return { status: 'no_treat', bytes, limit };
  if (bytes === null) return { status: 'unavailable', bytes, limit };
  // C4 绝对上限:canary ≤ 1536 字节 / 会话;越限即回滚
  return { status: bytes > limit ? 'exceeded' : 'ok', bytes, limit };
}

const bySession = (a: ObservedSession, b: ObservedSession): number =>
  a.tsMs - b.tsMs || (a.session_ref < b.session_ref ? -1 : 1);

function primaryReport(sessions: readonly ObservedSession[]): PrimaryReport {
  const units = sessions.map((x): Unit => ({
    agent: x.agent,
    project: x.project_key,
    arm: x.arm,
    v: x.primary,
  }));
  const built = buildStrata(units);
  const cells = built.strata.map(cellOf);
  const control = cells.reduce((a, c) => a + c.s0, 0);
  const treat = cells.reduce((a, c) => a + c.s1, 0);
  const insufficient = cells.length === 0 || control + treat === 0;
  return {
    rr: insufficient ? null : statistic('mh_rr', cells),
    control_events: control,
    treat_events: treat,
    insufficient,
  };
}

function sensitivityOf(
  run: number,
  fp: string,
  lines: readonly RandomizedLine[],
  observed: readonly ObservedSession[],
): SensitivitySegment {
  const elig = eligibleOf(observed);
  return {
    run,
    background_fp: fp,
    observed: observed.length,
    c1_rr: estimateOf('c1', sessionUnits('c1', elig)),
    c3_rr: estimateOf('c3', sessionUnits('c3', elig)),
    c6_diff_pp: estimateOf('c6', lineUnits(lines.filter(inC6))),
  };
}

export interface AnalyzeInput {
  assembled: Assembled;
  random: AnalysisRandom;
  /** 每个 treat 会话的注入字节数(`treatText` 的 UTF-8 字节数);`null` = 取不到 */
  c4Bytes: number | null;
  config?: AnalysisConfig;
}

export function analyzeSegment(input: AnalyzeInput): SegmentAnalysis {
  const cfg = input.config ?? DEFAULT_ANALYSIS_CONFIG;
  const { lines, observed } = input.assembled;
  // 分段 = 账里**连续**同一 `background_fp` 的一段(A → B → A 是三段;回到旧指纹也是新段,t 重新计)
  const lineRun: number[] = [];
  const runOf = new Map<string, number>();
  const runFp: string[] = [];
  for (const l of lines) {
    if (runFp[runFp.length - 1] !== l.background_fp) runFp.push(l.background_fp);
    lineRun.push(runFp.length - 1);
    runOf.set(l.marker, runFp.length - 1);
  }
  const lastRun = runFp.length - 1;
  const fp = lastRun < 0 ? null : (runFp[lastRun] as string);
  const segLines = lines.filter((_l, i) => lineRun[i] === lastRun);
  const segObs = observed.filter((s) => runOf.get(s.marker) === lastRun).sort(bySession);

  // 更早的段:只做敏感性点估计
  const sensitivity = runFp.slice(0, lastRun).map((f, r) =>
    sensitivityOf(
      r,
      f,
      lines.filter((_l, i) => lineRun[i] === r),
      observed.filter((s) => runOf.get(s.marker) === r),
    ),
  );

  const looks: LookResult[] = [];
  let harm: HarmFinding | null = null;
  const c4 = c4Check(
    input.c4Bytes,
    segLines.some((l) => l.arm === 'treat'),
    cfg.c4LimitBytes,
  );
  if (c4.status === 'exceeded') harm = { metric: 'c4', k: 0, t: 0, p: null, boundary: null };

  const nLooks = Math.floor(segObs.length / cfg.lookEvery);
  for (let k = 1; k <= nLooks && harm === null; k++) {
    const prefix = segObs.slice(0, k * cfg.lookEvery);
    const horizon = (prefix[prefix.length - 1] as ObservedSession).tsMs;
    const controlN = prefix.filter((s) => s.arm === 'control').length;
    const t = informationTime(controlN, cfg.maxPerArm);
    const boundary = obfCumulativeAlpha(cfg.alphaPerMetric, t);
    const elig = eligibleOf(prefix);
    const c6Units = lineUnits(linesAt(segLines, horizon));
    const metrics: MetricLook[] = HARM_P_METRICS.map((m) =>
      evalMetric(m, m === 'c6' ? c6Units : sessionUnits(m, elig), boundary, input.random, k, cfg),
    );
    const look: LookResult = {
      k,
      observed: prefix.length,
      control_observed: controlN,
      t,
      valid: metrics.some((m) => m.status === 'tested'),
      metrics,
    };
    looks.push(look);
    const hit = metrics.find((m) => m.crossed);
    if (hit !== undefined) harm = { metric: hit.metric, k, t, p: hit.p, boundary: hit.boundary };
  }

  const treatObs = segObs.filter((s) => s.arm === 'treat').length;
  const controlObs = segObs.length - treatObs;
  const randomized = { treat: 0, control: 0 };
  const incomplete = { treat: 0, control: 0 };
  const ineligibleExcluded = { treat: 0, control: 0 };
  for (const l of segLines) {
    if (!l.judgeable) continue;
    if (!inC6(l)) {
      ineligibleExcluded[l.arm] += 1;
      continue;
    }
    randomized[l.arm] += 1;
    if (!l.complete) incomplete[l.arm] += 1;
  }
  const overlaps = segLines.map((l) => l.overlaps_preset);
  const lastOverlap = overlaps[overlaps.length - 1];
  const anyValid = looks.some((l) => l.valid);
  let worst: C6WorstCase | null = null;
  const lastLook = looks[looks.length - 1];
  if (lastLook !== undefined) {
    const prefix = segObs.slice(0, lastLook.k * cfg.lookEvery);
    const horizon = (prefix[prefix.length - 1] as ObservedSession).tsMs;
    const atLook = linesAt(segLines, horizon);
    worst = {
      k: lastLook.k,
      unlinked: {
        treat: atLook.filter((l) => !l.complete && l.arm === 'treat').length,
        control: atLook.filter((l) => !l.complete && l.arm === 'control').length,
      },
      look: evalMetric(
        'c6',
        worstCaseUnits(atLook),
        obfCumulativeAlpha(cfg.alphaPerMetric, lastLook.t),
        input.random,
        lastLook.k,
        cfg,
        'c6_worst',
      ),
    };
  }
  return {
    kind: harm !== null ? 'harm' : anyValid ? 'no_harm' : 'no_decision',
    plan_version: RSI_ANALYSIS_PLAN_VERSION,
    positive: 'not_decidable',
    background_fp: fp,
    seed: input.random.seed,
    looks,
    harm,
    c4,
    never_valid_look: !anyValid,
    treat_observed: treatObs,
    control_observed: controlObs,
    max_arm_sessions: Math.max(treatObs, controlObs),
    primary: primaryReport(eligibleOf(segObs)),
    overlaps_preset: lastOverlap === undefined ? null : lastOverlap,
    overlaps_preset_mixed: new Set(overlaps).size > 1,
    randomized,
    incomplete,
    c6_ineligible_excluded: ineligibleExcluded,
    c6_worst_case: worst,
    sensitivity,
  };
}
