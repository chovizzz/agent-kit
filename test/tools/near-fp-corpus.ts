/**
 * near_fp 语料评估工具(离线;供 D3-nf 冻结阈值用)。**不含任何真实语料**;只在测试 / 语料工具模块里,不在生产 import 闭包内。
 * 经 `scripts/near-fp-corpus.mjs` 以 Node 的 type stripping 直接加载,所以本文件只用可擦除的 TS 语法,且运行时只 import `near-algo`(它只依赖 `node:crypto`)。
 *
 * 语料格式:目录下每个 `*.jsonl`(不递归,按文件名排序),每行一个 JSON 对象:
 *   {"id": "<唯一 id>", "label": "match" | "nomatch", "vetoed": "<被否决内容>", "candidate": "<候选内容>", "kind": "<可选分类>"}
 * `match` = 应被近似指纹拦下(扩写 / 前后缀 / 模板填充);`nomatch` = 不应拦(无关内容 / 同主题但独立的规则)。
 * 输出只含 case id 与统计,**绝不输出文本内容**。统计与密钥无关(固定使用一把内置的测试密钥;仅 32 位哈希碰撞的概率层面不同)。
 */
import {
  NEAR_ALGO,
  assertNearThreshold,
  nearCoverage,
  nearHashSet,
  nearMatches,
  nearSketch,
} from '../../src/rsi/personal/fp/near-algo.js';

export const CORPUS_KEY: Uint8Array = Uint8Array.from({ length: 32 }, (_v, i) => i + 1);
export const DEFAULT_THRESHOLDS: readonly number[] = Object.freeze(
  Array.from({ length: 20 }, (_v, i) => Math.round((i + 1) * 5) / 100),
);
/** 每类样本少于此数时报 `insufficient_sample`(阈值建议不可靠) */
export const MIN_CASES_PER_LABEL = 20;

export type CorpusLabel = 'match' | 'nomatch';
export interface CorpusCase {
  id: string;
  label: CorpusLabel;
  vetoed: string;
  candidate: string;
  kind?: string;
}

export interface ParseResult {
  cases: CorpusCase[];
  errors: string[];
}

export function parseCorpus(files: readonly { name: string; text: string }[]): ParseResult {
  const cases: CorpusCase[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const lines = f.text.split('\n');
    lines.forEach((line, i) => {
      if (line.trim() === '') return;
      const at = `${f.name}:${i + 1}`;
      let v: unknown;
      try {
        v = JSON.parse(line);
      } catch {
        errors.push(`${at}: not valid JSON`);
        return;
      }
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        errors.push(`${at}: not an object`);
        return;
      }
      const o = v as Record<string, unknown>;
      if (typeof o['id'] !== 'string' || o['id'] === '') {
        errors.push(`${at}: id must be a non-empty string`);
        return;
      }
      if (o['label'] !== 'match' && o['label'] !== 'nomatch') {
        errors.push(`${at}: label must be "match" or "nomatch"`);
        return;
      }
      if (typeof o['vetoed'] !== 'string' || typeof o['candidate'] !== 'string') {
        errors.push(`${at}: vetoed and candidate must be strings`);
        return;
      }
      if (o['kind'] !== undefined && typeof o['kind'] !== 'string') {
        errors.push(`${at}: kind must be a string`);
        return;
      }
      if (seen.has(o['id'])) {
        errors.push(`${at}: duplicate id ${o['id']}`);
        return;
      }
      seen.add(o['id']);
      cases.push({
        id: o['id'],
        label: o['label'],
        vetoed: o['vetoed'],
        candidate: o['candidate'],
        ...(typeof o['kind'] === 'string' ? { kind: o['kind'] } : {}),
      });
    });
  }
  return { cases, errors };
}

export interface ThresholdStat {
  threshold: number;
  tp: number;
  fn: number;
  fp: number;
  tn: number;
  hitRate: number | null;
  fpRate: number | null;
  fnIds: string[];
  fpIds: string[];
}
export interface CoverageSummary {
  n: number;
  min: number | null;
  median: number | null;
  max: number | null;
}
export interface CorpusReport {
  algo: { version: string; frozen: boolean; draftThreshold: number };
  cases: number;
  counts: { match: number; nomatch: number };
  /** 被否决内容不足 3 个 token(`near_fp = []`):近似匹配无从谈起,不计入阈值统计 */
  exactOnlyIds: string[];
  coverage: { match: CoverageSummary; nomatch: CoverageSummary };
  thresholds: ThresholdStat[];
  recommendation: null | { threshold: number; hitRate: number; fpRate: number };
  maxFpRate: number;
  warnings: string[];
}

const summarize = (xs: number[]): CoverageSummary => {
  if (xs.length === 0) return { n: 0, min: null, median: null, max: null };
  const s = [...xs].sort((a, b) => a - b);
  return {
    n: s.length,
    min: s[0] as number,
    median: s[Math.floor((s.length - 1) / 2)] as number,
    max: s[s.length - 1] as number,
  };
};

export interface EvalOptions {
  thresholds?: readonly number[];
  maxFpRate?: number;
  key?: Uint8Array;
}

export function evaluateCorpus(cases: readonly CorpusCase[], opts: EvalOptions = {}): CorpusReport {
  const thresholds = [...(opts.thresholds ?? DEFAULT_THRESHOLDS)].sort((a, b) => a - b);
  for (const t of thresholds) assertNearThreshold(t);
  const maxFpRate = opts.maxFpRate ?? 0;
  if (typeof maxFpRate !== 'number' || !(maxFpRate >= 0 && maxFpRate <= 1)) {
    throw new RangeError('maxFpRate must be in [0, 1]');
  }
  const key = opts.key ?? CORPUS_KEY;
  const exactOnlyIds: string[] = [];
  const scored: {
    id: string;
    label: CorpusLabel;
    near: readonly string[];
    cand: ReadonlySet<string>;
  }[] = [];
  for (const c of cases) {
    const near = nearSketch(key, c.vetoed);
    if (near.length === 0) {
      exactOnlyIds.push(c.id);
      continue;
    }
    scored.push({ id: c.id, label: c.label, near, cand: nearHashSet(key, c.candidate) });
  }
  const cov = (label: CorpusLabel): number[] =>
    scored.filter((s) => s.label === label).map((s) => nearCoverage(s.near, s.cand) as number);
  const nMatch = scored.filter((s) => s.label === 'match').length;
  const nNo = scored.filter((s) => s.label === 'nomatch').length;
  const stats: ThresholdStat[] = thresholds.map((t) => {
    const st: ThresholdStat = {
      threshold: t,
      tp: 0,
      fn: 0,
      fp: 0,
      tn: 0,
      hitRate: null,
      fpRate: null,
      fnIds: [],
      fpIds: [],
    };
    for (const s of scored) {
      const hit = nearMatches(s.near, s.cand, t);
      if (s.label === 'match') {
        if (hit) st.tp++;
        else {
          st.fn++;
          st.fnIds.push(s.id);
        }
      } else if (hit) {
        st.fp++;
        st.fpIds.push(s.id);
      } else st.tn++;
    }
    st.hitRate = nMatch === 0 ? null : st.tp / nMatch;
    st.fpRate = nNo === 0 ? null : st.fp / nNo;
    return st;
  });
  // 建议:误报率 ≤ maxFpRate 的阈值里取命中率最高者;并列取最高阈值(离误报边界最远)
  const feasible = stats.filter(
    (s) => s.hitRate !== null && s.fpRate !== null && s.fpRate <= maxFpRate,
  );
  let recommendation: CorpusReport['recommendation'] = null;
  if (feasible.length > 0) {
    const best = Math.max(...feasible.map((s) => s.hitRate as number));
    const pick = feasible
      .filter((s) => s.hitRate === best)
      .reduce((a, b) => (b.threshold > a.threshold ? b : a));
    recommendation = {
      threshold: pick.threshold,
      hitRate: pick.hitRate as number,
      fpRate: pick.fpRate as number,
    };
  }
  const warnings: string[] = [];
  if (nMatch < MIN_CASES_PER_LABEL || nNo < MIN_CASES_PER_LABEL)
    warnings.push('insufficient_sample');
  if (nMatch === 0) warnings.push('no_match_cases');
  if (nNo === 0) warnings.push('no_nomatch_cases');
  if (recommendation === null) warnings.push('no_threshold_within_max_fp_rate');
  if (exactOnlyIds.length > 0) warnings.push('exact_only_cases_excluded');
  return {
    algo: {
      version: NEAR_ALGO.version,
      frozen: NEAR_ALGO.frozen,
      draftThreshold: NEAR_ALGO.threshold,
    },
    cases: cases.length,
    counts: { match: nMatch, nomatch: nNo },
    exactOnlyIds,
    coverage: { match: summarize(cov('match')), nomatch: summarize(cov('nomatch')) },
    thresholds: stats,
    recommendation,
    maxFpRate,
    warnings,
  };
}

const f4 = (x: number | null): string => (x === null ? '-' : x.toFixed(4));

export function formatReport(r: CorpusReport): string {
  const L: string[] = [];
  L.push(
    `near_fp corpus report (algo ${r.algo.version}, frozen=${r.algo.frozen}, draft threshold ${r.algo.draftThreshold}; ids only, no text)`,
  );
  L.push(
    `cases ${r.cases}: match ${r.counts.match}, nomatch ${r.counts.nomatch}, exact_only excluded ${r.exactOnlyIds.length}${r.exactOnlyIds.length > 0 ? ` [${r.exactOnlyIds.join(', ')}]` : ''}`,
  );
  for (const k of ['match', 'nomatch'] as const) {
    const c = r.coverage[k];
    L.push(`coverage ${k}: n=${c.n} min=${f4(c.min)} median=${f4(c.median)} max=${f4(c.max)}`);
  }
  L.push('threshold    tp   fn   fp   tn  hit_rate  fp_rate');
  for (const s of r.thresholds) {
    L.push(
      `${s.threshold.toFixed(2).padStart(9)} ${String(s.tp).padStart(5)} ${String(s.fn).padStart(4)} ${String(s.fp).padStart(4)} ${String(s.tn).padStart(4)}  ${f4(s.hitRate).padStart(8)}  ${f4(s.fpRate).padStart(7)}`,
    );
  }
  for (const s of r.thresholds) {
    if (s.fpIds.length > 0)
      L.push(`false positives @${s.threshold.toFixed(2)}: ${s.fpIds.join(', ')}`);
  }
  L.push(
    r.recommendation === null
      ? `recommendation: none within max_fp_rate ${r.maxFpRate}`
      : `recommendation: threshold ${r.recommendation.threshold.toFixed(2)} (hit_rate ${f4(r.recommendation.hitRate)}, fp_rate ${f4(r.recommendation.fpRate)}; max_fp_rate ${r.maxFpRate})`,
  );
  if (r.warnings.length > 0) L.push(`warnings: ${r.warnings.join(', ')}`);
  return `${L.join('\n')}\n`;
}

export interface CliIo {
  readCorpus(dir: string): Promise<{ name: string; text: string }[]>;
  out(s: string): void;
  err(s: string): void;
}

const USAGE =
  'usage: near-fp-corpus <corpus-dir> [--thresholds 0.3,0.5,0.7] [--max-fp-rate 0] [--json]\n';

/** 退出码:0 完成;2 用法错 / 语料不合规(含 0 条用例)。不抛(除 `io.readCorpus` 自身的读失败,调用方处理) */
export async function runCorpusCli(argv: readonly string[], io: CliIo): Promise<number> {
  let dir: string | undefined;
  let thresholds: number[] | undefined;
  let maxFpRate = 0;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--json') json = true;
    else if (a === '--thresholds' || a === '--max-fp-rate') {
      const v = argv[++i];
      if (v === undefined) {
        io.err(`missing value for ${a}\n${USAGE}`);
        return 2;
      }
      if (a === '--thresholds') {
        thresholds = v.split(',').map((x) => Number(x));
        try {
          for (const t of thresholds) assertNearThreshold(t);
        } catch {
          io.err(`--thresholds: every value must be a number in (0, 1]\n${USAGE}`);
          return 2;
        }
      } else {
        maxFpRate = Number(v);
        if (!(maxFpRate >= 0 && maxFpRate <= 1)) {
          io.err(`--max-fp-rate must be in [0, 1]\n${USAGE}`);
          return 2;
        }
      }
    } else if (a.startsWith('-')) {
      io.err(`unknown option ${a}\n${USAGE}`);
      return 2;
    } else if (dir === undefined) dir = a;
    else {
      io.err(`unexpected argument\n${USAGE}`);
      return 2;
    }
  }
  if (dir === undefined) {
    io.err(USAGE);
    return 2;
  }
  const parsed = parseCorpus(await io.readCorpus(dir));
  if (parsed.errors.length > 0) {
    io.err(`${parsed.errors.map((e) => `corpus error: ${e}`).join('\n')}\n`);
    return 2;
  }
  if (parsed.cases.length === 0) {
    io.err('corpus has no cases\n');
    return 2;
  }
  const report = evaluateCorpus(parsed.cases, {
    ...(thresholds !== undefined ? { thresholds } : {}),
    maxFpRate,
  });
  io.out(json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
  return 0;
}
