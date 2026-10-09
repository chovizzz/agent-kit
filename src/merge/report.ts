/** 合并报告:给人看的摘要(渲染报告引用)。每节固定顺序,空节写明「无」。 */
import type { MergeResult } from '../contracts/merge.js';

export function mergeReportText(result: MergeResult): string {
  const lines: string[] = [];
  const section = (title: string, rows: string[]): void => {
    lines.push(`## ${title}`);
    if (rows.length === 0) lines.push('- 无');
    else for (const r of rows) lines.push(`- ${r}`);
    lines.push('');
  };
  section(
    '被覆盖或关闭的原子',
    result.overridden.map(
      (o) => `${o.id} ← ${o.byLayer} 层的 ${o.by}(${o.kind === 'overrides' ? '替换' : '关闭'})`,
    ),
  );
  section(
    '不可入 core 输出的原子(personal 层,P2 才在本机渲染)',
    result.atoms.filter((a) => !a.coreEligible).map((a) => `${a.atom.fm.id}(${a.layer})`),
  );
  section(
    '诊断',
    result.diagnostics.map((d) => `${d.severity} ${d.code} ${d.path}: ${d.message}`),
  );
  return lines.join('\n');
}

/** 可入 core 输出的原子数与被标记为不可入的原子数,供命令摘要使用。 */
export function mergeCounts(result: MergeResult): {
  total: number;
  core: number;
  personal: number;
} {
  const core = result.atoms.filter((a) => a.coreEligible).length;
  return { total: result.atoms.length, core, personal: result.atoms.length - core };
}
