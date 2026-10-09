import type { OutFile, RenderReport } from '../../src/contracts/render.js';

/** 本渲染器所依据的 Codex CLI 版本(官方文档读于 2026-10-08;**文档依据,不是探针结果**)。 */
export const DOCS_VERSION = '0.161.0';

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
  description: `codex 渲染器的格式依据 Codex CLI ${DOCS_VERSION} 的官方文档(2026-10-08 读取),尚未跑兼容探针(P1 才有);golden 不构成兼容声明(Q-N14)`,
} as const;
