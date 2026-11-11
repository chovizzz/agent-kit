/**
 * hint `--canary` 的随机源缺省实现(R21-6.2:「hint 用注入的随机源」)。测试注入确定性实现;生产用 `node:crypto`。
 * 失败(抛错、越界值)由调用方按第 5 行 `rng_error` 处理,这里不吞错。
 */
import { randomBytes, randomInt } from 'node:crypto';

const SCALE = 2 ** 40;

/** [0, 1) 的均匀随机数(40 位精度(`randomInt` 的区间须小于 2**48)) */
export function cryptoUnit(): number {
  return randomInt(0, SCALE) / SCALE;
}

export function cryptoBytes(n: number): Uint8Array {
  return randomBytes(n);
}
