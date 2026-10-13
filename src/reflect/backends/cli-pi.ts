import { deepFreezeArgSet } from './types.js';
import type { CliArgSet } from './types.js';

/**
 * pi 的参数集。整体门 `verified:false` 保持(noProjectSettings 等 R6 未测仍 unresolved),用户放行靠 allow_unverified。
 * R6(2026-10-13)实测:`--no-tools` 取代 `--tools read`,noTools / noSession / inputViaStdin 成立,无可归因的全局写入。
 * 依据(只引用本仓库已有信息):
 * - reflect 设计 ⑩:已知的有 `pi --no-session --no-context-files --no-skills --no-extensions`;
 *   「pi 的空工具集写法」未核实;
 * - 设计 ④:`pi --provider X --model M`(provider 必须显式给,厂商按模型族推导)。
 * 旧的 `--tools read` 是「只读工具」而**不是零工具**(read 可读任意绝对路径);R6 改用 `--no-tools`。
 */
export const PI_ARGS: CliArgSet = deepFreezeArgSet({
  cli: 'pi',
  verified: false,
  basis:
    'reflect 设计 ⑩(--no-session --no-context-files --no-skills --no-extensions 已知)、设计 ④(--provider/--model)、' +
    'contracts §17.6 R6 实测(2026-10-13,--provider openai --model gpt-6.1-sol,合成提示,回复 NOTOOLS):' +
    'noTools=verified(--no-tools);noSession=verified;inputViaStdin=verified;无可归因的全局写入;' +
    'noMcp/noProjectContext 沿用 claimed(本次未单测);noProjectSettings/noUserRouting 本次未测仍 unresolved',
  claims: {
    noTools: 'verified',
    noMcp: 'claimed',
    noSession: 'verified',
    noProjectContext: 'claimed',
    noProjectSettings: 'unresolved',
    noUserRouting: 'unresolved',
    inputViaStdin: 'verified',
  },
  provider: 'required',
  globalWrites: [],
  build: ({ model, provider }) => [
    '-p',
    '--no-session',
    '--no-context-files',
    '--no-skills',
    '--no-extensions',
    '--provider',
    provider ?? '',
    '--model',
    model,
    '--no-tools',
  ],
});
