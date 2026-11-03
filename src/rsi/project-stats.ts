/**
 * 项目 / 信号 / 聚类计数的只读统计(从 `hint.ts` 抽出,A6):hint、提醒(`notice.ts`)共用同一份现算口径(与 `rsi status` 对拍)。
 * 只依赖归属判定(`attribution.ts`)与契约;**不含**任何写出口(`hint.ts` 带去重标记写入,不能当共享依赖)。
 * 待审提案数 M 不在这里算:它由 `pending.ts` 的扫描结果给出(R20-17.16)。
 */
import type { RsiCounts, RsiProjectIndex } from '../contracts/rsi.js';
import { attribute, type AttributionProbe, type IndexStatus } from './attribution.js';
import type { RsiConfigOn } from './config.js';
import type { Classify } from './pending.js';

export interface ProjectStats {
  /** 近 7 个 UTC 日内由 L0 新增、归属「采集中」的信号数 */
  N: number;
  /** 剔除 X 与 U 的证据后仍达门槛的聚类数 */
  K: number;
  P: number;
  n: number;
  X: number;
  U: number;
  /** 同一次归属结果的分类器(给 `scanPending` 用,避免重复探测) */
  classify: Classify;
}

function last7Days(now: Date): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < 7; i++) {
    out.add(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

/** 计数现算(与 `rsi status` 同口径;`test/rsi/a3-hint.test.ts` 对拍) */
export async function projectStats(i: {
  config: RsiConfigOn;
  indexStatus: IndexStatus;
  index: RsiProjectIndex | null;
  counts: RsiCounts | null;
  ackGen: number;
  now: Date;
  probe?: AttributionProbe;
}): Promise<ProjectStats> {
  const att = await attribute({
    config: i.config,
    indexStatus: i.indexStatus,
    index: i.index,
    counts: i.counts,
    ...(i.probe !== undefined ? { probe: i.probe } : {}),
  });
  const entries = i.index?.entries ?? [];
  let P = 0;
  let X = 0;
  let n = 0;
  for (const e of entries) {
    const a = att.byKey.get(e.key);
    if (a === 'P') {
      P++;
      if (e.first_indexed_generation > i.ackGen) n++;
    } else if (a === 'X') X++;
  }
  const c = i.counts;
  let U = c?.unknown_keys_signals ?? 0;
  let N = 0;
  let K = 0;
  if (c !== null) {
    const days = last7Days(i.now);
    for (const [k, v] of Object.entries(c.per_key)) {
      const cls = att.classify(k);
      if (cls === 'U') U += v.signals_total;
      if (cls === 'P')
        for (const [d, x] of Object.entries(v.signals_by_day)) if (days.has(d)) N += x;
    }
    for (const cl of c.clusters) {
      let m = 0;
      for (const [k, v] of Object.entries(cl.evidence_by_key)) if (att.classify(k) === 'P') m += v;
      if (m >= c.cluster_min) K++;
    }
  } else {
    for (const e of entries) if (att.classify(e.key) === 'U') U += e.signals;
  }
  return { N, K, P, n, X, U, classify: att.classify };
}
