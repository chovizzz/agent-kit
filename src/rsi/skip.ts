/**
 * 自动路径的跳过条件(契约 R20-1.6;A3)。纯函数、零依赖(只引 `contracts/ci-env.ts`),poke / hint / worker / 顺带调度共用。
 *
 * - `KIT_AUTO_RSI`:只能关不能开——严格等于 `0` 才关(不 trim,与契约字面一致);`=1`、其它值与未设相同(变异:去掉这条判断 → A3 变异表必杀)。
 * - `KIT_RSI_CHILD=1`:kit 手动 `reflect --run-llm` / `judge --run-llm` 起的 LLM 子进程(`llm-exec` 固定注入,§20.9 第 5 条)。
 * - CI:与 update 同一张 `CI_ENV_KEYS`。
 * - `KIT_LAUNCHED` 已设且不为 `0`:**只**跳过顺带调度(`kind: 'kit'`)。worker 由 `runSelf` 拉起,子进程恒带 `KIT_LAUNCHED=1`,
 *   所以 worker 的判定不看它;poke / hint 是钩子直接调用,也不看它。
 * 前台命令(`rsi status|projects|confirm|stop|purge|tick`)不调用本函数(不受 `KIT_AUTO_RSI` 影响)。
 */
import { isCiEnv, truthyEnv } from '../contracts/ci-env.js';

export type AutoEntryKind = 'poke' | 'hint' | 'worker' | 'kit';
export type AutoSkipReason = 'auto_off' | 'child' | 'ci' | 'launched';

type Env = Readonly<Record<string, string | undefined>>;

export function autoSkip(env: Env, kind: AutoEntryKind): AutoSkipReason | null {
  if (env['KIT_AUTO_RSI'] === '0') return 'auto_off';
  if (env['KIT_RSI_CHILD'] === '1') return 'child';
  if (isCiEnv(env)) return 'ci';
  if (kind === 'kit' && truthyEnv(env['KIT_LAUNCHED'])) return 'launched';
  return null;
}
