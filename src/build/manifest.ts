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

/** resolved 里出现重复原子 id:合并不变量被破坏(merge 无 error 时 id 唯一)。不做「后者覆盖」,一律拒绝。 */
export class ManifestDuplicateAtomError extends Error {
  readonly code = 'BUILD_MANIFEST_DUPLICATE_ATOM_ID';
}

/** 返回重复的原子 id 及其所在层(按 id 字节序),无重复返回空数组。 */
export function findDuplicateAtomIds(
  resolved: readonly ResolvedAtom[],
): { id: string; layers: string[] }[] {
  const seen = new Map<string, string[]>();
  for (const r of resolved) seen.set(r.atom.fm.id, [...(seen.get(r.atom.fm.id) ?? []), r.layer]);
  return [...seen.entries()]
    .filter(([, layers]) => layers.length > 1)
    .sort((a, b) => byteCompare(a[0], b[0]))
    .map(([id, layers]) => ({ id, layers }));
}

export function assertUniqueAtomIds(resolved: readonly ResolvedAtom[]): void {
  const dups = findDuplicateAtomIds(resolved);
  if (dups.length > 0) {
    throw new ManifestDuplicateAtomError(
      `合并结果含重复原子 id(不允许后者覆盖):${dups.map((d) => `${d.id}(${d.layers.join('、')})`).join('; ')}`,
    );
  }
}

export interface ManifestInput {
  files: readonly OutFile[];
  resolved: readonly ResolvedAtom[];
  report: RenderReport;
  kitVersion: string;
  channel: ChannelName;
}

export function buildManifest(input: ManifestInput): Manifest {
  assertUniqueAtomIds(input.resolved);
  return renderBuildManifest(input.files, input.resolved, {
    kitVersion: input.kitVersion,
    channel: input.channel,
    skippedLayers: mergeSkippedLayers(input.report),
  });
}
