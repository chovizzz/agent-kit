/**
 * `out/manifest.json` 的构造:复用渲染核心的 `buildManifest`(它校验碰撞、未知原子、personal 泄漏,
 * 并按 UTF-8 字节序排序),这里只补 build 层的 skippedLayers 约定。
 */
import { canonicalJson } from '../io/canonical-json.js';
import type { ChannelName } from '../contracts/config.js';
import type { ResolvedAtom } from '../contracts/merge.js';
import type { Manifest, OutFile, RenderReport } from '../contracts/render.js';
import { buildManifest as renderBuildManifest, byteCompare } from '../render/out-layout.js';

/** P0 决策 a(docs/contracts.md §4.2):personal 层不渲染。reason 与适配器的 PERSONAL_SKIP 同文。 */
export const PERSONAL_SKIP = { layer: 'personal', reason: 'P2 才在本机渲染' } as const;

/** 渲染报告里的跳过层 + 恒有的 personal 说明(即使这次没有 personal 原子),去重后按字节序。 */
export function mergeSkippedLayers(report: RenderReport): Manifest['skippedLayers'] {
  const seen = new Map<string, Manifest['skippedLayers'][number]>();
  for (const s of [...report.skippedLayers, PERSONAL_SKIP]) {
    const v = { layer: s.layer, reason: s.reason };
    const k = canonicalJson(v);
    if (!seen.has(k)) seen.set(k, v);
  }
  return [...seen.entries()].sort((a, b) => byteCompare(a[0], b[0])).map(([, v]) => v);
}

export interface ManifestInput {
  files: readonly OutFile[];
  resolved: readonly ResolvedAtom[];
  report: RenderReport;
  kitVersion: string;
  channel: ChannelName;
}

export function buildManifest(input: ManifestInput): Manifest {
  return renderBuildManifest(input.files, input.resolved, {
    kitVersion: input.kitVersion,
    channel: input.channel,
    skippedLayers: mergeSkippedLayers(input.report),
  });
}
