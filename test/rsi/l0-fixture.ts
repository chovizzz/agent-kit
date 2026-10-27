/**
 * B4a 测试夹具:在假 HOME 下造三家会话根(claude / codex / pi),文件全部经 safe-fs 写在 KIT_TMP 内;配置经真实 `loadRsiConfig` 读(`[rsi]` 段可加 exclude)。
 * 不碰真实会话根。
 */
import * as path from 'node:path';
import type { RsiAgentId } from '../../src/contracts/rsi.js';
import { loadRsiConfig, type RsiConfigOn } from '../../src/rsi/config.js';
import { mkdirp, writeFile } from '../../src/io/safe-fs.js';
import { makeRoFx, type RoFx } from './ro-fixture.js';

export interface L0Fx extends RoFx {
  config: RsiConfigOn;
}

export async function makeL0Fx(prefix: string, rsiExtra = ''): Promise<L0Fx> {
  const f = await makeRoFx(prefix, rsiExtra);
  const config = await loadRsiConfig({ env: f.env });
  if (config.status !== 'on') throw new Error(`夹具配置应为 on:${config.reason}`);
  return { ...f, config };
}

export const ROOTS: Record<RsiAgentId, string[]> = {
  claude: ['.claude', 'projects'],
  codex: ['.codex', 'sessions'],
  pi: ['.pi', 'agent', 'sessions'],
};
export const rootOf = (f: { home: string }, agent: RsiAgentId): string =>
  path.join(f.home, ...ROOTS[agent]);

/** claude 的 UUID 形状文件名(`SESSION_FILE_RE`:8-4-4-4-12,任意字符) */
export const uuid = (n: number): string =>
  `${n.toString(16).padStart(8, '0')}-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;

export const jl = (...objs: unknown[]): string =>
  objs.map((o) => JSON.stringify(o)).join('\n') + '\n';

/** 写一个会话文件(相对会话根的路径),并确保父目录存在;返回绝对路径 */
export async function put(
  f: { home: string; fx: RoFx['fx'] },
  agent: RsiAgentId,
  rel: string,
  text: string,
): Promise<string> {
  const abs = path.join(rootOf(f, agent), rel);
  await mkdirp(f.fx, path.dirname(abs), 0o755);
  await writeFile(f.fx, abs, text, { mode: 0o600 });
  return abs;
}

export const claudeLine = (
  cwd: string | undefined,
  extra: Record<string, unknown> = {},
): object => ({
  type: 'user',
  ...(cwd !== undefined ? { cwd } : {}),
  message: { role: 'user', content: 'x' },
  ...extra,
});
