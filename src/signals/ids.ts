/**
 * 标识符哈希(docs/contracts.md §9,Q-N7)。盐是本机随机盐(`.state/salt`),不入仓。
 * `‖` = `\0`。形状(前缀 + 16 位十六进制)已写进 schema,改形状 = 契约变更。
 */
import { createHash } from 'node:crypto';

function h16(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);
}

export const SALT_RE = /^[0-9a-f]{64}$/;

export function sessionRefFor(salt: string, absPath: string): string {
  return `s_${h16([salt, 'session', absPath])}`;
}

export function projectKeyFor(salt: string, cwd: string): string {
  return `p_${h16([salt, 'project', cwd])}`;
}

/** `eventIndex` = 事件在该会话事件流里的序号(0 起,含不产出信号的事件),所以重跑得到同一值。 */
export function sigIdFor(salt: string, sessionRef: string, eventIndex: number): string {
  return `sig_${h16([salt, 'sig', sessionRef, String(eventIndex)])}`;
}

/**
 * discover 阶段(拿不到盐)用的临时 session_ref:无盐,仅在内存里存在,不得落盘、不得进报告。
 * collector 在 read() 之前一律用本机盐重算(见 pipeline.ts),reader 读取时也从 opts.salt 重算。
 */
export function provisionalSessionRef(absPath: string): string {
  return `s_${h16(['', 'session', absPath])}`;
}
