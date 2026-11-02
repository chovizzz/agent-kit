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
import { rsiDirReadonly } from './lock-read.js';

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

/**
 * `.state/rsi/digests/` 的**写侧**目录准备(R20-16.10 / R20-16.13,按 R20-15.21a 同类协议):先过 {@link rsiDir},再要求 `digests/` 是真实目录、
 * 属主是当前用户、无组 / 其他写位(缺失则建为 0700;权限宽于 0700 的自己的目录收紧)。符号链接 / 非目录 / 别人的目录 → `state_dir_unsafe`。
 */
export async function digestsDir(io: IoContext): Promise<string> {
  const base = await rsiDir(io);
  const dir = path.join(base, 'digests');
  const pre = await lstat(dir).catch(() => undefined);
  if (pre !== undefined && (pre.isSymbolicLink() || !pre.isDirectory())) {
    throw new RsiLockError('state_dir_unsafe');
  }
  await mkdirp(io, dir, RSI_DIR_MODE);
  const st = await lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new RsiLockError('state_dir_unsafe');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new RsiLockError('state_dir_unsafe');
  }
  if ((st.mode & 0o077) !== 0) await chmod(io, dir, RSI_DIR_MODE);
  return dir;
}

/** 目录元数据校验(R20-15.21a 同类):真实目录、属主 = `uid`(缺省当前 uid)、无组 / 其他写位。确认不了 / 不满足 → `state_dir_unsafe`。不修正、不写。 */
export function assertOwnDirSafe(
  st: { isSymbolicLink(): boolean; isDirectory(): boolean; uid: number; mode: number },
  uid?: number,
): void {
  if (st.isSymbolicLink() || !st.isDirectory()) throw new RsiLockError('state_dir_unsafe');
  const want = uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  if (want === undefined || st.uid !== want) throw new RsiLockError('state_dir_unsafe');
  if ((st.mode & 0o022) !== 0) throw new RsiLockError('state_dir_unsafe');
}

/**
 * `.state/rsi/digests/` 的**只读**校验(持槽位锁之后的业务访问用):不建目录、不 chmod。目录不在 / 不安全 → `state_dir_unsafe`。
 * 持锁后的 mkdir / chmod 一律不允许(purge 删掉 `digests/` 后,旧持有者不得重建)——目录准备只在取锁之前({@link digestsDir})。
 */
export async function digestsDirReadonly(io: IoContext): Promise<string> {
  const d = await rsiDirReadonly(io);
  if (d.kind !== 'ok') throw new RsiLockError('state_dir_unsafe');
  const dir = path.join(d.dir, 'digests');
  const st = await lstat(dir).catch(() => undefined);
  if (st === undefined) throw new RsiLockError('state_dir_unsafe');
  assertOwnDirSafe(st);
  return dir;
}
