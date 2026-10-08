import { canonicalJson } from '../io/canonical-json.js';
import type { RenderReport } from '../contracts/render.js';
import { byteCompare } from './out-layout.js';

export function emptyReport(): RenderReport {
  return { dropped: [], sideEffects: [], shadowChecks: [], pendingProbes: [], skippedLayers: [] };
}

function uniqSorted<T>(items: readonly T[], key: (t: T) => string): T[] {
  const map = new Map<string, T>();
  for (const it of items) {
    const k = key(it);
    if (!map.has(k)) map.set(k, it);
  }
  return [...map.entries()].sort((a, b) => byteCompare(a[0], b[0])).map(([, v]) => v);
}

/** 合并若干报告:各数组去重并按字节序排序,结果与输入顺序无关。 */
export function mergeReports(reports: readonly RenderReport[]): RenderReport {
  return {
    dropped: uniqSorted(
      reports.flatMap((r) => r.dropped),
      (d) => canonicalJson(d),
    ),
    sideEffects: uniqSorted(
      reports.flatMap((r) => r.sideEffects),
      (s) => s,
    ),
    shadowChecks: uniqSorted(
      reports.flatMap((r) => r.shadowChecks),
      (s) => s,
    ),
    pendingProbes: uniqSorted(
      reports.flatMap((r) => r.pendingProbes),
      (p) => canonicalJson(p),
    ),
    skippedLayers: uniqSorted(
      reports.flatMap((r) => r.skippedLayers),
      (s) => canonicalJson(s),
    ),
  };
}

/** 确定性序列化(键序、2 空格、LF、末尾换行)。 */
export function reportToJson(report: RenderReport): string {
  return canonicalJson(report);
}

/** 给人看的摘要;每节固定顺序,空节也写明「无」。 */
export function reportToText(report: RenderReport): string {
  const lines: string[] = [];
  const section = (title: string, rows: string[]): void => {
    lines.push(`## ${title}`);
    if (rows.length === 0) lines.push('- 无');
    else for (const r of rows) lines.push(`- ${r}`);
    lines.push('');
  };
  section(
    '丢弃的字段',
    report.dropped.map((d) => `${d.field}${d.file ? ` @ ${d.file}` : ''}:${d.reason}`),
  );
  section('副作用', report.sideEffects);
  section('遮蔽检查', report.shadowChecks);
  section(
    '待探针验证',
    report.pendingProbes.map((p) => `${p.id}:${p.description}`),
  );
  section(
    '跳过的层',
    report.skippedLayers.map((s) => `${s.layer}:${s.reason}`),
  );
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}
