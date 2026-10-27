/**
 * 按 agent 区分的头部解析(R20-1.4,B4 方案 §2.3;B4-0 冻结签名,B4a 实现)。入参 `lines` 是 `readHeadLines` 返回的窗口内完整行。
 *  - pi(K=1):首行是对象且 `type === 'session'` 取 `cwd`;首行是对象、`type` 是字符串但不是 `session` → `notASession`;
 *  - codex(K=1):首行 `type === 'session_meta'` 取 `payload.cwd`(reader 还会用后面 `turn_context` 的 cwd;armed 下这种文件记 U);
 *  - claude(D1,K=`RSI_ARMED_CLAUDE_MAX_LINES`):按顺序找第一个「对象、`isSidechain !== true`、`cwd` 是非空字符串」的行,取它的 cwd 后立刻停止,后面的行不交给解析。
 * 逐行预处理复用 base-reader 的 `lineText`(去行首一个 BOM、判空白)/ `exceedsJsonDepth` / `parseObject`;空白行、太深的行、非对象的行跳过,不终止扫描。
 * 只返回 {@link HeadMeta},不保存、不输出行内容。
 */
import type { RsiAgentId } from '../../contracts/rsi.js';
import type { HeadMeta } from './types.js';

export function parseHead(agent: RsiAgentId, lines: readonly Buffer[]): HeadMeta {
  void [agent, lines];
  throw new Error('not implemented');
}
