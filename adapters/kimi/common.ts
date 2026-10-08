import type { OutFile, RenderReport } from '../../src/contracts/render.js';

/**
 * 本渲染器所依据的 Kimi Code 文档版本:文档站快照的最新条目为 2.1.1(2026-09-24,读于 2026-10-08)。
 * **文档依据,不是探针结果**;调研时本机装的是 2.0.0(与文档版本不同,差异未核实)。
 *
 * 置信度口径(Pi / Kimi / OpenCode 统一):documented = 官方文档(随包或文档站快照)对该条明文陈述,且文档版本带版本号
 * 可对照;文档无版本号、或与本机版本明显脱节的(OpenCode)整体 assumed。Kimi 文档版本 2.1.1 与调研时本机 2.0.0 只差一个小版本,
 * 文档站更新日志里 2.0.1–2.1.1 的条目没有直接改 AGENTS.md / 技能 / 子代理的格式(读于 2026-10-08),但 2.1.0 有"项目本地配置
 * 仅在工作区被信任后生效"一条(可能影响项目级 agents / skills 的加载时机,已登记进 P-Q5),故保持 documented,并在
 * compat-probe-not-run 里声明版本差;tested_versions 因此为空。
 */
export const DOCS_VERSION = '2.1.1';

/** 托管块 id:同一真实文件里,各适配器的块 id 相同,P2 sync 发现内容冲突时必须报错而不是静默叠加。 */
export const BLOCK_ID = 'agent-kit-rules';

export const PERSONAL_SKIP = { layer: 'personal', reason: 'P2 才在本机渲染' } as const;

export function keyOf(f: Pick<OutFile, 'agent' | 'target' | 'relPath'>): string {
  return `${f.agent}/${f.target}/${f.relPath}`;
}

export function newReport(): RenderReport {
  return { dropped: [], sideEffects: [], shadowChecks: [], pendingProbes: [], skippedLayers: [] };
}

/** 所有 renderXxx 报告共用:声明本渲染器没跑过探针。 */
export const PROBE_NOT_RUN = {
  id: 'compat-probe-not-run',
  description: `kimi 渲染器的格式依据 Kimi Code ${DOCS_VERSION} 文档站快照(2026-10-08 读取;调研时本机为 2.0.0),尚未跑兼容探针(P1 才有);golden 不构成兼容声明(Q-N14)`,
} as const;
