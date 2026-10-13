import { deepFreezeArgSet } from './types.js';
import type { CliArgSet } from './types.js';

/**
 * claude -p 的参数集。**全部未核实(verified:false)**,R6 实测前默认拒绝真跑。
 * 依据(只引用本仓库已有信息):
 * - docs/contracts.md §5.2「R3 传参要求」:claude 带 `--strict-mcp-config`;
 * - reflect 设计 ⑩:`--tools ""`、`--strict-mcp-config`、`--no-session-persistence` 是否存在/是否有效均「未核实」;
 * - 「不读项目上下文/设置文件」没有已知的参数写法:只靠固定的空 cwd(contracts §16① 指出 cwd 仍在仓库 git 树内,
 *   claude 向上找项目根时可能读到仓库的 CLAUDE.md / `.claude/settings.json`),标 unresolved。
 * 模型每次显式传 `--model`;提示经 stdin。
 */
export const CLAUDE_ARGS: CliArgSet = deepFreezeArgSet({
  cli: 'claude',
  verified: false,
  basis:
    'contracts §5.2(R3 传参要求:--strict-mcp-config)、reflect 设计 ⑩(--tools "" / --no-session-persistence 均未核实)、contracts §16①(cwd 在仓库树内)',
  claims: {
    noTools: 'claimed',
    noMcp: 'claimed',
    noSession: 'claimed',
    noProjectContext: 'unresolved',
    noProjectSettings: 'unresolved',
    noUserRouting: 'unresolved',
    inputViaStdin: 'unresolved',
  },
  provider: 'forbidden',
  build: ({ model }) => [
    '-p',
    '--model',
    model,
    '--tools',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
  ],
});
