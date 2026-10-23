import { deepFreezeArgSet } from './types.js';
import type { CliArgSet } from './types.js';

/**
 * pi 的参数集。整体门 `verified:false` 保持(noUserRouting=not_met:用户级 models.json 可改写 provider 的 baseUrl),用户放行靠 allow_unverified。
 * 2026-10-23 补测(pi 0.87.1):`--no-extensions` 不挡项目级文件(用户已保存的信任目录之下仍生效),须加 `--no-approve`。
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
    'noTools=verified(--no-tools);noSession=verified;inputViaStdin=verified;无可归因的全局写入。' +
    '补测(2026-10-23,pi 0.87.1,--provider openai --model gpt-6.1-sol,行为指令哨兵对照):' +
    'noProjectSettings=verified(须带 --no-approve;不带时在已保存信任的目录下项目级 APPEND_SYSTEM.md 仍生效);' +
    'noProjectContext=verified(对照:去掉 --no-context-files 则 AGENTS.md/CLAUDE.md 内令牌可被读到);' +
    'noMcp=verified(对照:去掉 --no-tools/--no-extensions 则模型自报含 mcp 工具);' +
    'noUserRouting=not_met(用户级 models.json 可改写 provider 的 baseUrl,--provider openai 因此实际经中转,厂商推导不保证端点)',
  claims: {
    noTools: 'verified',
    noMcp: 'verified',
    noSession: 'verified',
    noProjectContext: 'verified',
    noProjectSettings: 'verified',
    noUserRouting: 'not_met',
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
    '--no-approve',
    '--provider',
    provider ?? '',
    '--model',
    model,
    '--no-tools',
  ],
});
