import { deepFreezeArgSet } from './types.js';
import type { CliArgSet } from './types.js';

/**
 * pi 的参数集。**全部未核实(verified:false)**,R6 实测前默认拒绝真跑。
 * 依据(只引用本仓库已有信息):
 * - reflect 设计 ⑩:已知的有 `pi --no-session --no-context-files --no-skills --no-extensions`;
 *   「pi 的空工具集写法」未核实;
 * - 设计 ④:`pi --provider X --model M`(provider 必须显式给,厂商按模型族推导)。
 * 这里沿用 Hub 评审约定的 `--tools read`,但那是「只读工具」而**不是零工具**(反思器要零工具,设计 ⑧-12):
 * pi 的 read 工具可读任意绝对路径,所以 noTools 标 unresolved——这是 R6 必须解决的首要项。
 */
export const PI_ARGS: CliArgSet = deepFreezeArgSet({
  cli: 'pi',
  verified: false,
  basis:
    'reflect 设计 ⑩(--no-session --no-context-files --no-skills --no-extensions 已知;空工具集未核实)、设计 ④(--provider/--model)',
  claims: {
    noTools: 'unresolved',
    noMcp: 'claimed',
    noSession: 'claimed',
    noProjectContext: 'claimed',
    noProjectSettings: 'unresolved',
    noUserRouting: 'unresolved',
    inputViaStdin: 'unresolved',
  },
  provider: 'required',
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
    '--tools',
    'read',
  ],
});
