/**
 * 盐的共同**只读**原语(D5;B4-0 冻结签名,B4a 实现)。`loadSalt`、规划侧(armed / planL0 / rebuild)、counts 服务(`saltFpOf`)都经它读盐,
 * 三处对同一个盐文件结论相同。规则:普通文件(O_NOFOLLOW)、`nlink == 1`、权限 ≤ 0600、属主是当前用户、≤ `RSI_SALT_MAX_BYTES`、内容是 64 位十六进制(可带一个换行);
 * 违规抛 {@link SaltError}(调用方映射为 `salt_invalid`);空文件**不等待**(只有 `loadSalt` 有限等待;D15 的回收由持锁方做),只报 `empty` 与 mtime。
 * 本文件在规划侧闭包内:不得 import safe-fs / state-store / lock / snapshot。
 */
import { createHash, randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { RSI_SALT_MAX_BYTES } from '../contracts/rsi.js';
import { readFileSafe } from '../io/read-fs.js';
import { SALT_RE } from './ids.js';

export class SaltError extends Error {
  readonly code = 'SIGNALS_SALT_INVALID';
}

export type SaltRead =
  /** `saltFp` = `sha256(salt)` 前 12 位十六进制 */
  | { kind: 'ok'; salt: string; saltFp: string }
  | { kind: 'absent' }
  /** 空普通文件:mtime 给持锁方判 D15 的 10 秒宽限 */
  | { kind: 'empty'; mtimeMs: number };

const UNSAFE_TEXT: Record<string, string> = {
  link: '盐文件是符号链接',
  not_regular: '盐文件不是普通文件',
  hardlink: '盐文件是硬链接(nlink > 1)',
  owner: '盐文件属主不是当前用户',
  perm: '盐文件权限宽于 0600',
  too_large: '盐文件超过大小上限',
  io: '盐文件读取失败',
};

/** 读 `<stateDir>/salt`;不建目录、不等待、不写。 */
export async function readSaltFile(stateDir: string): Promise<SaltRead> {
  const r = await readFileSafe(path.join(stateDir, 'salt'), {
    maxBytes: RSI_SALT_MAX_BYTES,
    owner: { maxPerm: 0o600 },
  });
  if (r.kind === 'missing') return { kind: 'absent' };
  if (r.kind === 'unsafe') throw new SaltError(UNSAFE_TEXT[r.why] ?? '盐文件不安全');
  if (r.bytes.length === 0) return { kind: 'empty', mtimeMs: r.meta.mtimeMs };
  const text = r.bytes.toString('utf8');
  const salt = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (!SALT_RE.test(salt)) throw new SaltError('盐文件格式非法(应为 64 位十六进制)');
  return { kind: 'ok', salt, saltFp: createHash('sha256').update(salt).digest('hex').slice(0, 12) };
}

/** 内存临时盐(`tick` 干跑盐不存在时用;`salt: "ephemeral"`,依赖 key 的计数为 null) */
export function ephemeralSalt(): string {
  return randomBytes(32).toString('hex');
}
