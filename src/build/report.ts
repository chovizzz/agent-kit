/** `build --report` 的机器可读报告(写 `.state/reports/build.json`,不进 out/)。确定性:无时间戳、无绝对路径。 */
import type { BudgetStats } from '../budget/budget.js';
import type { Manifest, RenderReport } from '../contracts/render.js';

export interface BuildReport {
  schema_version: 1;
  kit_version: string;
  channel: Manifest['channel'];
  files: {
    path: string;
    bytes: number;
    sha256: string;
    mode: Manifest['files'][number]['mode'];
    confidence: Manifest['files'][number]['confidence'];
    conditional: string | null;
    atom_ids: string[];
  }[];
  skipped_layers: Manifest['skippedLayers'];
  render: RenderReport;
  budget: BudgetStats;
}

export function buildReport(
  manifest: Manifest,
  bytesByPath: ReadonlyMap<string, number>,
  render: RenderReport,
  budget: BudgetStats,
): BuildReport {
  return {
    schema_version: 1,
    kit_version: manifest.kit_version,
    channel: manifest.channel,
    files: manifest.files.map((f) => ({
      path: f.path,
      bytes: (() => {
        const b = bytesByPath.get(f.path);
        if (b === undefined) throw new Error(`build 报告:缺少 ${f.path} 的字节数`);
        return b;
      })(),
      sha256: f.sha256,
      mode: f.mode,
      confidence: f.confidence,
      conditional: f.conditional ?? null,
      atom_ids: f.atoms.map((a) => a.id),
    })),
    skipped_layers: manifest.skippedLayers,
    render,
    budget,
  };
}
