import type { OutFile, RenderReport } from '../../src/contracts/render.js';

/** 托管块 id:同一真实文件里,各适配器的块 id 相同,P2 sync 发现内容冲突时必须报错而不是静默叠加。 */
export const BLOCK_ID = 'agent-kit-rules';

export const PERSONAL_SKIP = { layer: 'personal', reason: 'P2 才在本机渲染' } as const;

export function keyOf(f: Pick<OutFile, 'agent' | 'target' | 'relPath'>): string {
  return `${f.agent}/${f.target}/${f.relPath}`;
}

export function newReport(): RenderReport {
  return { dropped: [], sideEffects: [], shadowChecks: [], pendingProbes: [], skippedLayers: [] };
}

/**
 * 所有 renderXxx 报告共用:声明本渲染器没跑过探针,并写明版本缺口。
 * OpenCode 的格式依据是线上文档快照(页面标注 2026-10-08 更新,但没有版本号);
 * 本机装的是 1.1.19,调研 A 记录它"远落后线上文档",所以连"文档对应哪个版本"都不能声明 ⇒ tested_versions=[]。
 */
export const PROBE_NOT_RUN = {
  id: 'compat-probe-not-run',
  description:
    'opencode 渲染器的格式依据是线上文档快照(2026-10-08 读取,无版本号);本机 1.1.19 远落后于文档(调研 A §2.5-10),二者差异未核实,所以没有任何已验证的版本(tested_versions 为空),使用前必须先跑兼容探针(P1 才有);golden 不构成兼容声明(Q-N14)',
} as const;
