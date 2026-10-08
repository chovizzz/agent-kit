import type { Adapter } from '../../src/contracts/render.js';

/**
 * 骨架桩(B01):渲染器尚未实现,返回空输出并在报告里登记。
 * 由块 B07 替换本文件内容,保持 `export const adapter: Adapter` 的形状,
 * 并填写同目录的 managed-targets.json(格式 AdapterMetaSchema)。
 */
export const adapter: Adapter = {
  agent: 'claude',
  testedVersions: [],
  renderRules() {
    return {
      files: [],
      report: {
        dropped: [],
        sideEffects: [],
        shadowChecks: [],
        pendingProbes: [
          { id: 'adapter-not-implemented', description: 'claude 渲染器尚未实现(B01 骨架桩)' },
        ],
        skippedLayers: [],
      },
    };
  },
};
