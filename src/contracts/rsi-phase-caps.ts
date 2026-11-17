/**
 * 相位提升的**能力门禁**(设计稿 v3 §D.5、第 2 版 §5;§21.24 W0-26 第 13、15 条):`RSI_PHASE_REQUIRES` = 相位 → 必备能力。
 * 提相位(`RSI_AUTO_PHASE` ≥ V1a)的 PR 必须在**真生产装配**里带齐这些能力,否则 {@link assertPhaseCaps} 在任何写之前 fail-closed;
 * 能力不是字符串常量自报:`RSI_PRODUCTION_WIRED_CAPS` 只许由「生产装配里确实注入了该端口实例」的块(B2 / C / D)各自追加,假件与未注入都不算。
 * **B1b 合并时它是空集**(没有任何生产装配),相位常量保持 0(V0 无要求),所以本文件合并后生产惰性。纯常量与纯函数,无 I/O。
 * `near_fp`:`[]` 合法(schema ≤ 64 项,B 一律写 `[]`);依赖近似否决保护的相位提升由 `near_fp_producer` 阻断,D 的产生方 + 消费者验收齐之前提相位 PR 必红。
 */
import { RSI_AUTO_PHASE_ORDER, type RsiAutoPhaseName } from './rsi.js';

export const RSI_ASSEMBLY_CAPS = Object.freeze([
  // B:存储与压缩
  'effects_ledger_write',
  'audit_appender',
  'audit_compaction',
  // C:worker 骨架
  'audit_sweep',
  'recovery_scan',
  'growth_storage_guard',
  'seal_stamp_all_producers',
  // D:候选推进与授予
  'ledger_consume_ingest',
  'ledger_consume_g4',
  'near_fp_producer',
] as const);
export type RsiAssemblyCap = (typeof RSI_ASSEMBLY_CAPS)[number];

/** 相位 → 本相位**新增**的必备能力(累计:相位 p 的要求 = 下标 ≤ p 的各相位之并)。V0 无要求;V1a 起要求全部(首次生产写入 = 提相位 PR) */
export const RSI_PHASE_REQUIRES: Readonly<Record<RsiAutoPhaseName, readonly RsiAssemblyCap[]>> =
  Object.freeze({
    V0: [],
    V1a: RSI_ASSEMBLY_CAPS,
    V1b: [],
    'V1.5': [],
    V2: [],
    V3: [],
    V4: [],
    V5: [],
    V6a: [],
    V6b: [],
  });

/** 生产装配实际注入的能力(B1b = 空集;B2 / C / D 各自在真装配里追加) */
export const RSI_PRODUCTION_WIRED_CAPS: ReadonlySet<RsiAssemblyCap> = new Set<RsiAssemblyCap>();

/** 相位 `phase`(整数下标)尚缺的能力(按 `RSI_ASSEMBLY_CAPS` 顺序;越界 / 非整数相位 = 要求全部,默认拒绝) */
export function missingPhaseCaps(
  phase: number,
  wired: ReadonlySet<string> = RSI_PRODUCTION_WIRED_CAPS,
): RsiAssemblyCap[] {
  if (!Number.isInteger(phase) || phase < 0 || phase >= RSI_AUTO_PHASE_ORDER.length) {
    return [...RSI_ASSEMBLY_CAPS].filter((c) => !wired.has(c));
  }
  const need = new Set<RsiAssemblyCap>();
  RSI_AUTO_PHASE_ORDER.forEach((name, i) => {
    if (i <= phase) for (const c of RSI_PHASE_REQUIRES[name]) need.add(c);
  });
  return RSI_ASSEMBLY_CAPS.filter((c) => need.has(c) && !wired.has(c));
}

export class PhaseCapsMissingError extends Error {
  readonly code = 'RSI_PHASE_CAPS_MISSING';
  constructor(readonly missing: readonly RsiAssemblyCap[]) {
    super(`rsi phase caps missing: ${missing.join(',')}`);
  }
}

/** 装配启动时在任何写之前调用:缺能力 = 抛 {@link PhaseCapsMissingError}(fail-closed) */
export function assertPhaseCaps(
  phase: number,
  wired: ReadonlySet<string> = RSI_PRODUCTION_WIRED_CAPS,
): void {
  const missing = missingPhaseCaps(phase, wired);
  if (missing.length > 0) throw new PhaseCapsMissingError(missing);
}
