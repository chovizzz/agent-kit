/**
 * 会话根的状态判定(R20-2.9;B4-0 冻结签名,B4a 实现)。根固定为 claude `~/.claude/projects`、codex `~/.codex/sessions`、pi `~/.pi/agent/sessions`;
 * 逐段 lstat:有符号链接 → `root_symlink`,不是目录 → `root_not_dir`,pi 且「已设」→ `pi_dir_override`;不存在 → `absent`。不用 `walkFiles`(它会 realpath 根,跟随链接)。
 * 「已设」:前台命令看 `PI_CODING_AGENT_DIR`,worker 看 `KIT_RSI_PI_DIR_SET`——由调用方折成 `piDirSet`。
 */
import type { RsiAgentId } from '../../contracts/rsi.js';
import type { AgentRootStatus, L0Deps } from './types.js';

export async function evaluateAgentRoot(
  home: string,
  agent: RsiAgentId,
  piDirSet: boolean,
  deps?: L0Deps,
): Promise<AgentRootStatus> {
  void [home, agent, piDirSet, deps];
  throw new Error('not implemented');
}
