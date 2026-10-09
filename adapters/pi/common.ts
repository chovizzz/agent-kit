import type { OutFile, RenderReport } from '../../src/contracts/render.js';

/**
 * 本渲染器所依据的 Pi 版本:随包安装的官方文档 @earendil-works/pi-coding-agent 0.87.1
 * (docs/configuration.md、docs/skills.md,读于 2026-10-08;**文档依据,不是探针结果**)。
 */
export const DOCS_VERSION = '0.87.1';

/** 托管块 id:同一真实文件里,各适配器的块 id 相同,P2 sync 发现内容冲突时必须报错而不是静默叠加。 */
export const BLOCK_ID = 'agent-kit-rules';

export const PERSONAL_SKIP = { layer: 'personal', reason: 'P2 才在本机渲染' } as const;

/** Pi 没有声明式 hook:must 规则只能是文字,没有机械强制(设计 §4.4、§4.2 Pi 行)。 */
export const NO_ENFORCEMENT_NOTE =
  '⚠ 本 agent 无机械强制:Pi 没有声明式 hook(只有 TS 扩展),规则以文字形式交付,must 级规则也只靠模型遵守(TS 扩展垫片留 P4+)';

export function keyOf(f: Pick<OutFile, 'agent' | 'target' | 'relPath'>): string {
  return `${f.agent}/${f.target}/${f.relPath}`;
}

export function newReport(): RenderReport {
  return { dropped: [], sideEffects: [], shadowChecks: [], pendingProbes: [], skippedLayers: [] };
}

/** 所有 renderXxx 报告共用:声明本渲染器没跑过探针。 */
export const PROBE_NOT_RUN = {
  id: 'compat-probe-not-run',
  description: `pi 渲染器的格式依据 Pi ${DOCS_VERSION} 随包官方文档(2026-10-08 读取),尚未跑兼容探针(P1 才有);golden 不构成兼容声明(Q-N14)`,
} as const;
