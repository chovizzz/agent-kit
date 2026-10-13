import { deepFreezeArgSet } from './types.js';
import type { CliArgSet } from './types.js';

/**
 * claude -p 的参数集。整体门 `verified:false` 保持(noProjectContext 等三项 R6 未测,仍 unresolved),
 * 用户放行靠 allow_unverified。R6(2026-10-13)实测:noTools / noSession / inputViaStdin 成立。
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
    'contracts §5.2(R3 传参要求:--strict-mcp-config)、contracts §16①(cwd 在仓库树内)、' +
    'contracts §17.6 R6 实测(2026-10-13,合成提示,回复 NOTOOLS):noTools=verified;noSession=verified;inputViaStdin=verified;' +
    'noMcp 未单测仍 claimed;noProjectContext/noProjectSettings/noUserRouting 本次未测仍 unresolved;全局写入见 globalWrites',
  claims: {
    noTools: 'verified',
    noMcp: 'claimed',
    noSession: 'verified',
    noProjectContext: 'unresolved',
    noProjectSettings: 'unresolved',
    noUserRouting: 'unresolved',
    inputViaStdin: 'verified',
  },
  provider: 'forbidden',
  globalWrites: [
    '~/.claude.json',
    '~/.claude/backups/(新备份)',
    '~/.claude/plugins/.last_inuse_sweep',
    '~/.claude/plugins/synced/ 下同步文件',
    '~/.claude/skills/synced/ 下同步文件',
    '~/.claude/session-env/ 启动脚本',
  ],
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
