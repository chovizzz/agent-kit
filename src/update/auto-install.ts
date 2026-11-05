/**
 * `[update] auto_install` 的读取(D-AU2 / 评审 H3):后台 worker 与钩子的调度判定共用同一个函数,「怎么读」只有一份。
 * 零网络、只读(`io/probe.ts` 的 `probePath` + TOML 解析 + schema)。配置文件存在但读不出文本 / 解析失败 / 过不了 schema
 * → `{ ok: false }`(fail-closed:worker 记 `failed`,钩子不调度);文件不存在 → 缺省 `true`。
 */
import { parse as parseToml } from 'smol-toml';
import { UserConfigSchema } from '../contracts/update.js';
import { probePath } from '../io/probe.js';

export const USER_CONFIG_REL = '.config/agent-kit/config.toml';

export type AutoInstallRead = { ok: true; autoInstall: boolean } | { ok: false };

/** @param home 已校验的 HOME 真实路径 */
export async function readAutoInstall(home: string): Promise<AutoInstallRead> {
  const probe = await probePath(home, USER_CONFIG_REL);
  if (probe.entry.kind === 'missing') return { ok: true, autoInstall: true };
  try {
    if (probe.text === undefined) return { ok: false };
    return {
      ok: true,
      autoInstall: UserConfigSchema.parse(parseToml(probe.text)).update.auto_install,
    };
  } catch {
    return { ok: false };
  }
}
