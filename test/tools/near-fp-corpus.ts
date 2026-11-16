/**
 * near_fp 语料评估工具(离线;供 D3-nf 冻结阈值用)。**不含任何真实语料**;只在测试 / 语料工具模块里,不在生产 import 闭包内。
 * 经 `scripts/near-fp-corpus.mjs` 以 Node 的 type stripping 直接加载,所以本文件只用可擦除的 TS 语法,且运行时只 import `near-algo`(它只依赖 `node:crypto`)。
 *
 * 语料格式:目录下每个 `*.jsonl`(不递归,按文件名排序),每行一个 JSON 对象:
 *   {"id": "<唯一 id>", "label": "match" | "nomatch", "vetoed": "<被否决内容>", "candidate": "<候选内容>", "kind": "<可选分类>"}
 * `match` = 应被近似指纹拦下(扩写 / 前后缀 / 模板填充);`nomatch` = 不应拦(无关内容 / 同主题但独立的规则)。
 * 输出只含 case id 与统计,**绝不输出文本内容**(id 与文件名同样会被输出:语料提供者不得把正文放进 id / 文件名)。
 * 统计**依赖密钥**:被否决内容超过 64 个不同 shingle 时,最小 64 个哈希取决于密钥(换密钥会换抽样,覆盖率与命中率随之波动)。
 * 所以每个用例用多把公开、确定性的评估密钥各算一遍(`CORPUS_KEYS`),阈值统计取**评估密钥集合内的最坏值**(命中取最小、误报取最大),阈值建议按它给;
 * 这**不是**所有生产密钥的风险上界。计数与 id 列表同一口径:`fpIds` / `fnIds` 是达到最坏计数的那把密钥(并列取第一把,`fpWorstKey` / `fnWorstKey` 为其序号)下的 id,
 * 所以 `fp === fpIds.length`;任一密钥下出现过的 id 并集另列 `anyKeyFpIds` / `anyKeyFnIds`(显式命名,不与计数混用)。
 * 覆盖率分布用第一把密钥;存在超过 64 个 shingle 的被否决内容时报 `bottom_k_truncation_key_dependent`。评估密钥与生产 `fp.key` 无关,不读真实密钥。
 * 输入长度:任一侧(含 exact-only 用例)超过 `NEAR_MAX_INPUT_CHARS` 的用例**一律先于评估**判为「无法评估」:不进统计、只列 id(`unevaluableIds`)、
 * 警告 `unevaluable_input_too_long`,命令行退出 2;从不抛未处理异常、不输出异常对象与正文。
 */
import {
  NEAR_ALGO,
  NEAR_MAX_INPUT_CHARS,
  assertNearThreshold,
  NEAR_SKETCH_SIZE,
  nearCoverage,
  nearHashSet,
  nearMatches,
  nearShingles,
  nearSketch,
} from '../../src/rsi/personal/fp/near-algo.js';

/** 公开、确定性的评估密钥(第一把 = 字节 1..32);不是任何真实密钥 */
export const CORPUS_KEYS: readonly Uint8Array[] = Object.freeze(
  [1, 7, 53, 101, 199].map((mul) =>
    Uint8Array.from({ length: 32 }, (_v, i) => (mul * (i + 1)) & 0xff),
  ),
);
export const CORPUS_KEY: Uint8Array = CORPUS_KEYS[0] as Uint8Array;
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
  /** 漏掉(match 未命中)最多的那把评估密钥下的 id;`fn === fnIds.length`(并列取第一把密钥) */
  fnIds: string[];
  /** 误报最多的那把评估密钥下的 id;`fp === fpIds.length` */
  fpIds: string[];
  /** 达到最坏计数的密钥序号(0 起);计数为 0 时为 null */
  fnWorstKey: number | null;
  fpWorstKey: number | null;
  /** 任一评估密钥下出现过的 id 并集(不对应计数) */
  anyKeyFnIds: string[];
  anyKeyFpIds: string[];
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
  /** 任一侧输入超过 `NEAR_MAX_INPUT_CHARS` 的用例:无法评估,不计入统计(只列 id) */
  unevaluableIds: string[];
  coverage: { match: CoverageSummary; nomatch: CoverageSummary };
  thresholds: ThresholdStat[];
  /** 评估所用密钥数(阈值统计取这些密钥下的最坏情形) */
  keys: number;
  /** 被否决内容的完整 shingle 数超过草图容量(64)的用例:其统计随密钥波动 */
  truncatedIds: string[];
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
  /** 评估密钥(缺省 {@link CORPUS_KEYS});至少一把,每把 32 字节 */
  keys?: readonly Uint8Array[];
}

export function evaluateCorpus(cases: readonly CorpusCase[], opts: EvalOptions = {}): CorpusReport {
  const thresholds = [...(opts.thresholds ?? DEFAULT_THRESHOLDS)].sort((a, b) => a - b);
  for (const t of thresholds) assertNearThreshold(t);
  const maxFpRate = opts.maxFpRate ?? 0;
  if (typeof maxFpRate !== 'number' || !(maxFpRate >= 0 && maxFpRate <= 1)) {
    throw new RangeError('maxFpRate must be in [0, 1]');
  }
  const keys = opts.keys ?? CORPUS_KEYS;
  if (keys.length === 0) throw new RangeError('at least one evaluation key is required');
  // 长度检查先于一切评估,两侧都查(含 exact-only 用例):超长 = 无法评估,而不是抛错或因另一侧短而被悄悄放过
  const tooLong = (c: CorpusCase): boolean =>
    c.vetoed.length > NEAR_MAX_INPUT_CHARS || c.candidate.length > NEAR_MAX_INPUT_CHARS;
  const unevaluableIds = cases.filter(tooLong).map((c) => c.id);
  const evaluable = cases.filter((c) => !tooLong(c));
  const shingleCount = new Map(evaluable.map((c) => [c.id, nearShingles(c.vetoed).length]));
  const exactOnlyIds = evaluable.filter((c) => shingleCount.get(c.id) === 0).map((c) => c.id);
  const usable = evaluable.filter((c) => (shingleCount.get(c.id) as number) > 0);
  const truncatedIds = usable
    .filter((c) => (shingleCount.get(c.id) as number) > NEAR_SKETCH_SIZE)
    .map((c) => c.id);
  // 每把密钥各算一遍:草图取最小 64 个哈希,抽样随密钥变化
  const perKey = keys.map((key) =>
    usable.map((c) => ({
      id: c.id,
      label: c.label,
      near: nearSketch(key, c.vetoed),
      cand: nearHashSet(key, c.candidate),
    })),
  );
  const scored = perKey[0] as (typeof perKey)[number];
  const cov = (label: CorpusLabel): number[] =>
    scored.filter((s) => s.label === label).map((s) => nearCoverage(s.near, s.cand) as number);
  const nMatch = usable.filter((c) => c.label === 'match').length;
  const nNo = usable.length - nMatch;
  const stats: ThresholdStat[] = thresholds.map((t) => {
    // 最坏情形:命中取各密钥下的最小,误报取最大
    let tp = Number.POSITIVE_INFINITY;
    let tn = Number.POSITIVE_INFINITY;
    let fn = 0;
    let fp = 0;
    let fnWorstKey: number | null = null;
    let fpWorstKey: number | null = null;
    let fnWorst: string[] = [];
    let fpWorst: string[] = [];
    const fnSet = new Set<string>();
    const fpSet = new Set<string>();
    for (const [ki, rows] of perKey.entries()) {
      let kTp = 0;
      let kFn = 0;
      let kFp = 0;
      let kTn = 0;
      const kFnIds: string[] = [];
      const kFpIds: string[] = [];
      for (const s of rows) {
        const hit = nearMatches(s.near, s.cand, t);
        if (s.label === 'match') {
          if (hit) kTp++;
          else {
            kFn++;
            kFnIds.push(s.id);
            fnSet.add(s.id);
          }
        } else if (hit) {
          kFp++;
          kFpIds.push(s.id);
          fpSet.add(s.id);
        } else kTn++;
      }
      // 最坏密钥(严格更大才替换,并列取第一把),id 列表随它走,与计数同一口径
      if (kFn > fn) {
        fnWorstKey = ki;
        fnWorst = kFnIds;
      }
      if (kFp > fp) {
        fpWorstKey = ki;
        fpWorst = kFpIds;
      }
      tp = Math.min(tp, kTp);
      tn = Math.min(tn, kTn);
      fn = Math.max(fn, kFn);
      fp = Math.max(fp, kFp);
    }
    return {
      threshold: t,
      tp,
      fn,
      fp,
      tn,
      hitRate: nMatch === 0 ? null : tp / nMatch,
      fpRate: nNo === 0 ? null : fp / nNo,
      fnIds: fnWorst,
      fpIds: fpWorst,
      fnWorstKey,
      fpWorstKey,
      anyKeyFnIds: usable.filter((c) => fnSet.has(c.id)).map((c) => c.id),
      anyKeyFpIds: usable.filter((c) => fpSet.has(c.id)).map((c) => c.id),
    };
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
  if (unevaluableIds.length > 0) warnings.push('unevaluable_input_too_long');
  if (truncatedIds.length > 0) warnings.push('bottom_k_truncation_key_dependent');
  return {
    algo: {
      version: NEAR_ALGO.version,
      frozen: NEAR_ALGO.frozen,
      draftThreshold: NEAR_ALGO.threshold,
    },
    cases: cases.length,
    keys: keys.length,
    truncatedIds,
    counts: { match: nMatch, nomatch: nNo },
    exactOnlyIds,
    unevaluableIds,
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
  L.push(
    `eval keys ${r.keys} (worst case within this key set, not a bound for production keys); bottom-k truncated (key-dependent) ${r.truncatedIds.length}${r.truncatedIds.length > 0 ? ` [${r.truncatedIds.join(', ')}]` : ''}`,
  );
  for (const k of ['match', 'nomatch'] as const) {
    const c = r.coverage[k];
    L.push(`coverage ${k}: n=${c.n} min=${f4(c.min)} median=${f4(c.median)} max=${f4(c.max)}`);
  }
  if (r.unevaluableIds.length > 0)
    L.push(
      `unevaluable (input too long, excluded) ${r.unevaluableIds.length} [${r.unevaluableIds.join(', ')}]`,
    );
  L.push('threshold    tp   fn   fp   tn  hit_rate  fp_rate');
  for (const s of r.thresholds) {
    L.push(
      `${s.threshold.toFixed(2).padStart(9)} ${String(s.tp).padStart(5)} ${String(s.fn).padStart(4)} ${String(s.fp).padStart(4)} ${String(s.tn).padStart(4)}  ${f4(s.hitRate).padStart(8)}  ${f4(s.fpRate).padStart(7)}`,
    );
  }
  for (const s of r.thresholds) {
    if (s.fpIds.length > 0) {
      const extra = s.anyKeyFpIds.filter((id) => !s.fpIds.includes(id));
      L.push(
        `false positives @${s.threshold.toFixed(2)} (worst key #${s.fpWorstKey}): ${s.fpIds.join(', ')}${extra.length > 0 ? `; also at other keys: ${extra.join(', ')}` : ''}`,
      );
    }
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

/**
 * 退出码(稳定):0 完成;2 用法错 / 语料不合规(含 0 条用例、语料目录读失败、存在超长而无法评估的用例)。
 * 语料内容不会让它抛:读目录失败映射成固定文案,超长用例走「无法评估」;不输出异常对象 / 堆栈 / 正文,报告只含 case id。
 */
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
  let files: { name: string; text: string }[];
  try {
    files = await io.readCorpus(dir);
  } catch {
    io.err('corpus directory could not be read\n');
    return 2;
  }
  const parsed = parseCorpus(files);
  if (parsed.errors.length > 0) {
    io.err(`${parsed.errors.map((e) => `corpus error: ${e}`).join('\n')}\n`);
    return 2;
  }
  if (parsed.cases.length === 0) {
    io.err('corpus has no cases\n');
    return 2;
  }
  // 输入长度 / 类型已在 evaluateCorpus 内先行判定(超长 = unevaluable),参数在上面已校验;这里不会因语料内容抛
  const report = evaluateCorpus(parsed.cases, {
    ...(thresholds !== undefined ? { thresholds } : {}),
    maxFpRate,
  });
  io.out(json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
  if (report.unevaluableIds.length > 0) {
    io.err(
      `corpus has ${report.unevaluableIds.length} unevaluable case(s) (input too long): ${report.unevaluableIds.join(', ')}\n`,
    );
    return 2;
  }
  return 0;
}
