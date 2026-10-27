/**
 * `.state/rsi/` 的**写侧**目录准备(从 `lock.ts` 拆出,R20-A2 B3a):`acquireRsiLock`、快照写入方与 `rsi stop` 共用。
 * 会建目录并收紧权限,所以只有写入方 import 它;只读入口走 `lock-read.ts` 的 `rsiDirReadonly`。
 */
import * as path from 'node:path';
import { RSI_DIR_MODE } from '../contracts/rsi.js';
import type { IoContext } from '../io/paths.js';
import { lstat, realpath } from '../io/read-fs.js';
import { chmod, mkdirp } from '../io/safe-fs.js';
import { RsiLockError } from './lock-error.js';

/**
 * **写入方**用:状态目录的真实路径(必要时先建);`rsi/` 子目录必须是真实目录,权限收紧到 0700。
 * 已存在但是符号链接 / 不是目录 → `state_dir_unsafe`(不顺着链接、不 mkdir 进去)。
 */
export async function rsiDir(io: IoContext): Promise<string> {
  await mkdirp(io, io.stateDir, RSI_DIR_MODE);
  const stateReal = await realpath(io.stateDir);
  const dir = path.join(stateReal, 'rsi');
  const pre = await lstat(dir).catch(() => undefined);
  if (pre !== undefined && (pre.isSymbolicLink() || !pre.isDirectory())) {
    throw new RsiLockError('state_dir_unsafe');
  }
  await mkdirp(io, dir, RSI_DIR_MODE);
  const st = await lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new RsiLockError('state_dir_unsafe');
  // 别人的目录我们既不能收紧也不该写进去
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new RsiLockError('state_dir_unsafe');
  }
  if ((st.mode & 0o077) !== 0) await chmod(io, dir, RSI_DIR_MODE);
  return dir;
}
