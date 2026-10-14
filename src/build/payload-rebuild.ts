/**
 * 从源码重新构建 payload 树(不写盘):build-payload 脚本与发布闸共用。
 * 与 `agent-kit build` 同一条流水线(无覆盖层、channel 取缺省),所以与仓库里提交的 out/ 同源。
 */
import * as path from 'node:path';
import { hasErrors } from '../contracts/diagnostics.js';
import { existsSync } from '../io/read-fs.js';
import { MANIFEST_FILE, readTree } from '../render/out-layout.js';
import { loadKitConfig } from './config.js';
import { buildPayload } from './payload.js';
import type { PayloadBundle } from './payload.js';
import { runPipeline } from './pipeline.js';

export type RebuildResult =
  { ok: true; bundle: PayloadBundle; kitVersion: string } | { ok: false; message: string };

export async function rebuildPayload(root: string): Promise<RebuildResult> {
  const loaded = loadKitConfig(root);
  if (loaded.config === undefined) {
    return { ok: false, message: loaded.diagnostics.map((d) => d.message).join('; ') };
  }
  const res = await runPipeline({ root, config: loaded.config, overlay: undefined });
  if (res.kind === 'fail_closed') return { ok: false, message: res.message };
  if (res.kind === 'check_failed') {
    const errs = res.diagnostics.filter((d) => hasErrors([d])).map((d) => `${d.code} ${d.path}`);
    return { ok: false, message: `lint/合并/预算未通过:${errs.slice(0, 3).join('; ')}` };
  }
  try {
    const bundle = buildPayload({
      files: res.rendered.files,
      resolved: res.merge.atoms,
      skills: res.skills,
      kitVersion: loaded.config.kit.version,
      channel: res.manifest.channel,
      skippedLayers: res.manifest.skippedLayers,
    });
    return { ok: true, bundle, kitVersion: loaded.config.kit.version };
  } catch (e) {
    return {
      ok: false,
      message: `${(e as { code?: string }).code ?? 'ERROR'}: ${(e as Error).message}`,
    };
  }
}

/** 仓库里的 out/(不含 manifest.json);没有 out/ 返回 undefined。 */
export async function readOutHomeTree(root: string): Promise<Map<string, string> | undefined> {
  const dir = path.join(root, 'out');
  if (!existsSync(dir)) return undefined;
  const tree = await readTree(dir);
  tree.delete(MANIFEST_FILE);
  return tree;
}
