/** build 的配置读取:kit.toml(必需)与 --overlay(可选)。只读,解析失败给诊断或抛错,不静默回退。 */
import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { KitConfigSchema, OverlaySchema } from '../contracts/config.js';
import type { KitConfig, Overlay } from '../contracts/config.js';
import { zodIssuesToDiagnostics } from '../contracts/diagnostics.js';
import type { Diagnostic } from '../contracts/diagnostics.js';
import { existsSync, readTextSync } from '../io/read-fs.js';

export function loadKitConfig(root: string): { config?: KitConfig; diagnostics: Diagnostic[] } {
  const file = path.join(root, 'kit.toml');
  if (!existsSync(file)) {
    return {
      diagnostics: [
        {
          code: 'CFG_KIT_TOML_MISSING',
          severity: 'error',
          path: 'kit.toml',
          message: '找不到 kit.toml,无法构建',
        },
      ],
    };
  }
  let raw: unknown;
  try {
    raw = parseToml(readTextSync(file));
  } catch (e) {
    return {
      diagnostics: [
        {
          code: 'CFG_TOML_SYNTAX',
          severity: 'error',
          path: 'kit.toml',
          message: `kit.toml 无法解析:${(e as Error).message.split('\n')[0] ?? ''}`,
        },
      ],
    };
  }
  const res = KitConfigSchema.safeParse(raw);
  if (!res.success) return { diagnostics: zodIssuesToDiagnostics(res.error, 'kit.toml') };
  return { config: res.data, diagnostics: [] };
}

/** `--overlay <path>`:路径按调用方给的原样读(与 redact 一致);解析/校验失败给诊断。 */
export function loadOverlayFile(file: string): { overlay?: Overlay; diagnostics: Diagnostic[] } {
  let raw: unknown;
  try {
    raw = parseToml(readTextSync(file));
  } catch (e) {
    return {
      diagnostics: [
        {
          code: 'CFG_OVERLAY_UNREADABLE',
          severity: 'error',
          path: '--overlay',
          message: `覆盖层无法读取或解析:${(e as Error).message.split('\n')[0] ?? ''}`,
        },
      ],
    };
  }
  const res = OverlaySchema.safeParse(raw);
  if (!res.success) return { diagnostics: zodIssuesToDiagnostics(res.error, '--overlay') };
  return { overlay: res.data, diagnostics: [] };
}
