import { deepFreezeArgSet } from './types.js';
import type { CliArgSet } from './types.js';

/**
 * codex exec 的参数集。整体门 `verified:false` 保持,用户放行靠 allow_unverified。
 * R6(2026-10-13,codex-cli 0.161)实测:noTools 靠 `--disable` 组合成立;noMcp / noSession 不成立(not_met)。
 * 依据(只引用本仓库已有信息):
 * - docs/contracts.md §5.2「R3 传参要求」:codex 每次显式传 `-m` 与 `-c model_provider=…`(用户配置可改默认 provider),
 *   带 `-c mcp_servers={}`;
 * - R6 订正:`mcp_servers="{}"`(带引号)在 0.161 报 `invalid type: string "{}", expected a map`,必须写 `mcp_servers={}`;
 * - 设计 ⑤/⑥:评审形态用只读沙箱(`-s read-only`)与 `--skip-git-repo-check`(cwd 不是受信 git 目录)。
 * 零工具(R6):只靠只读沙箱 + 空 MCP 仍会执行 shell(read-only 下 echo 照跑);
 * 加 `--disable` 九项后回 NOTOOLS——组合有效,不知哪几项起决定作用,codex 升级后须重测。
 * 空 MCP(R6):`mcp_servers={}` 仍没阻止它尝试连 localhost:8000 的 MCP(报错但不影响结果)→ noMcp=not_met。
 * 会话(R6):`--ephemeral` 只是不存会话文件,仍写 ~/.codex 下四个 sqlite → noSession=not_met。
 */
const DISABLED_FEATURES = [
  'shell_tool',
  'unified_exec',
  'js_repl',
  'code_mode',
  'view_image',
  'multi_agent',
  'apps',
  'plugins',
  'memories',
] as const;

export const CODEX_ARGS: CliArgSet = deepFreezeArgSet({
  cli: 'codex',
  verified: false,
  basis:
    'contracts §5.2(R3 传参要求:-m、-c model_provider、-c mcp_servers)、' +
    'contracts §17.6 R6 实测(2026-10-13,codex-cli 0.161,合成提示,回复 NOTOOLS):noTools=verified(须带 --disable 组合,单靠只读沙箱仍执行 shell);' +
    'noMcp=not_met(mcp_servers={} 仍尝试连 localhost:8000);noSession=not_met(--ephemeral 挡不住 sqlite 写入);inputViaStdin=verified;' +
    'noProjectContext/noProjectSettings/noUserRouting 本次未测仍 unresolved;全局写入见 globalWrites',
  claims: {
    noTools: 'verified',
    noMcp: 'not_met',
    noSession: 'not_met',
    noProjectContext: 'unresolved',
    noProjectSettings: 'unresolved',
    noUserRouting: 'unresolved',
    inputViaStdin: 'verified',
  },
  provider: 'optional',
  globalWrites: [
    'codex 主目录: state_5 (sqlite 及 -shm/-wal)',
    'codex 主目录: goals_1 (sqlite 及 -shm/-wal)',
    'codex 主目录: queue_1 (sqlite 及 -shm/-wal)',
    'codex 主目录: logs_2 (sqlite 及 -shm/-wal)',
  ],
  build: ({ model, provider }) => [
    'exec',
    '-m',
    model,
    '-c',
    `model_provider=${JSON.stringify(provider ?? 'openai')}`,
    '-c',
    'mcp_servers={}',
    '-s',
    'read-only',
    '--skip-git-repo-check',
    '--ephemeral',
    ...DISABLED_FEATURES.flatMap((f) => ['--disable', f]),
  ],
});
