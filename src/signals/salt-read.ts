/**
 * 盐的共同**只读**原语(D5;B4-0 冻结签名,B4a 实现)。`loadSalt`、规划侧(armed / planL0 / rebuild)、counts 服务(`saltFpOf`)都经它读盐,
 * 三处对同一个盐文件结论相同。规则:普通文件(O_NOFOLLOW)、`nlink == 1`、权限 ≤ 0600、≤ `RSI_SALT_MAX_BYTES`、内容是 64 位十六进制(可带一个换行);
 * 违规抛 {@link SaltError}(调用方映射为 `salt_invalid`);空文件**不等待**(只有 `loadSalt` 有限等待;D15 的回收由持锁方做),只报 `empty` 与 mtime。
 * 本文件在规划侧闭包内:不得 import safe-fs / state-store / lock / snapshot。
 */
export class SaltError extends Error {
  readonly code = 'SIGNALS_SALT_INVALID';
}

export type SaltRead =
  /** `saltFp` = `sha256(salt)` 前 12 位十六进制 */
  | { kind: 'ok'; salt: string; saltFp: string }
  | { kind: 'absent' }
  /** 空普通文件:mtime 给持锁方判 D15 的 10 秒宽限 */
  | { kind: 'empty'; mtimeMs: number };

/** 读 `<stateDir>/salt`;不建目录、不等待、不写。 */
export async function readSaltFile(stateDir: string): Promise<SaltRead> {
  void [stateDir];
  throw new Error('not implemented');
}

/** 内存临时盐(`tick` 干跑盐不存在时用;`salt: "ephemeral"`,依赖 key 的计数为 null) */
export function ephemeralSalt(): string {
  throw new Error('not implemented');
}
