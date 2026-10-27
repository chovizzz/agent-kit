/**
 * 会话根的状态判定(R20-2.9;B4-0 冻结签名,B4a 实现)。根固定为 claude `~/.claude/projects`、codex `~/.codex/sessions`、pi `~/.pi/agent/sessions`;
 * 逐段 lstat:有符号链接 → `root_symlink`,不是目录 → `root_not_dir`,pi 且「已设」→ `pi_dir_override`;不存在 → `absent`。不用 `walkFiles`(它会 realpath 根,跟随链接)。
 * 「已设」:前台命令看 `PI_CODING_AGENT_DIR`,worker 看 `KIT_RSI_PI_DIR_SET`——由调用方折成 `piDirSet`。
 * 这是会话根判定的唯一实现:`rsi status` 的 agents 列表与列举(`enumerate.ts`)都调它。
 */
import * as path from 'node:path';
import type { RsiAgentId } from '../../contracts/rsi.js';
import { lstat } from '../../io/read-fs.js';
import type { AgentRootStatus, L0Deps } from './types.js';

const AGENT_ROOTS: Readonly<Record<RsiAgentId, readonly string[]>> = {
  claude: ['.claude', 'projects'],
  codex: ['.codex', 'sessions'],
  pi: ['.pi', 'agent', 'sessions'],
};

/** 会话根的绝对路径(不 realpath) */
export function agentRootPath(home: string, agent: RsiAgentId): string {
  return path.join(home, ...AGENT_ROOTS[agent]);
}

export async function evaluateAgentRoot(
  home: string,
  agent: RsiAgentId,
  piDirSet: boolean,
  deps?: L0Deps,
): Promise<AgentRootStatus> {
  if (agent === 'pi' && piDirSet) return { status: 'not_evaluated', reason: 'pi_dir_override' };
  let cur = home;
  for (const seg of AGENT_ROOTS[agent]) {
    cur = path.join(cur, seg);
    await deps?.beforeStep?.('root', cur);
    let st;
    try {
      st = await lstat(cur);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // 只有明确的「不存在」才算 absent;EACCES / EIO 等读不了的不能当成没有东西可读(否则会把不完整的扫描认证成完整)。
      // `AgentRootStatus` 没有 io_error 原因码(冻结类型),按 `root_not_dir`(根不能当目录读)归类,已报主代理
      return code === 'ENOENT' || code === 'ENOTDIR'
        ? { status: 'absent' }
        : { status: 'not_evaluated', reason: 'root_not_dir' };
    }
    if (st.isSymbolicLink()) return { status: 'not_evaluated', reason: 'root_symlink' };
    if (!st.isDirectory()) return { status: 'not_evaluated', reason: 'root_not_dir' };
  }
  return { status: 'ok' };
}

/** 会话根当前的 `(dev, ino)`(根不是普通目录 / 读不了 → null):列举与头部读取前后比对,发现根被换掉就作废该 agent 的结果 */
export async function rootIdentity(
  home: string,
  agent: RsiAgentId,
): Promise<{ dev: number; ino: number } | null> {
  try {
    const st = await lstat(agentRootPath(home, agent));
    return st.isDirectory() && !st.isSymbolicLink() ? { dev: st.dev, ino: st.ino } : null;
  } catch {
    return null;
  }
}
