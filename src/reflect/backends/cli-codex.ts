import { deepFreezeArgSet } from './types.js';
import type { CliArgSet } from './types.js';

/**
 * codex exec 的参数集。**全部未核实(verified:false)**,R6 实测前默认拒绝真跑。
 * 依据(只引用本仓库已有信息):
 * - docs/contracts.md §5.2「R3 传参要求」:codex 每次显式传 `-m` 与 `-c model_provider=…`(用户配置可改默认 provider),
 *   带 `-c mcp_servers="{}"`;
 * - reflect 设计 ⑩:`codex exec --ephemeral` 是否完全不写 `~/.codex` 未核实;`mcp_servers="{}"` 并不总是生效;
 * - 设计 ⑤/⑥:评审形态用只读沙箱(`-s read-only`)与 `--skip-git-repo-check`(cwd 不是受信 git 目录)。
 * 零工具:codex 没有已知的「无工具」开关,只有只读沙箱 + 空 MCP,所以 noTools 标 unresolved。
 * 提示经 stdin 是否被 `codex exec` 接受未核实(unresolved)。
 */
export const CODEX_ARGS: CliArgSet = deepFreezeArgSet({
  cli: 'codex',
  verified: false,
  basis:
    'contracts §5.2(R3 传参要求:-m、-c model_provider、-c mcp_servers)、reflect 设计 ⑩(--ephemeral、mcp_servers 不总是生效)',
  claims: {
    noTools: 'unresolved',
    noMcp: 'claimed',
    noSession: 'claimed',
    noProjectContext: 'unresolved',
    noProjectSettings: 'unresolved',
    noUserRouting: 'unresolved',
    inputViaStdin: 'unresolved',
  },
  provider: 'optional',
  build: ({ model, provider }) => [
    'exec',
    '-m',
    model,
    '-c',
    `model_provider=${JSON.stringify(provider ?? 'openai')}`,
    '-c',
    'mcp_servers="{}"',
    '-s',
    'read-only',
    '--skip-git-repo-check',
    '--ephemeral',
  ],
});
