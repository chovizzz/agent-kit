/**
 * `rsi/lock` 的**只读**部分(从 `lock.ts` 拆出,R20-A2 B3a):目录只读解析、锁文件句柄级读取、`peekRsiLock`、属主口径。
 * 只 import read-fs 与契约,**不** import safe-fs:`rsi status` / `rsi projects` 的 import 闭包因此不含任何写出口(§20.8.1 静态审计)。
 * `lock.ts` 原样 re-export 这里的符号,既有 import 路径不变。
 */
import * as path from 'node:path';
import {
  RSI_DIR_MODE,
  RSI_FILE_MODE,
  RSI_LOCK_MAX_BYTES,
  RSI_LOCK_PARTIAL_GRACE_MS,
  RSI_LOCK_STATES,
  RSI_LOCK_TTL_MS,
  RsiLockDocSchema,
  type RsiLockDoc,
} from '../contracts/rsi.js';
import type { IoContext } from '../io/paths.js';
import { readFileSafe, realpath, statDirSafe, type OwnerPolicy } from '../io/read-fs.js';

export interface RsiLockDeps {
  /** 进程存活判据;缺省 `process.kill(pid, 0)`:成功或 `EPERM` = 存活,仅 `ESRCH` = 不存在 */
  isAlive?: (pid: number) => boolean;
  now?: () => Date;
  pid?: number;
  randomHex?: (bytes: number) => string;
  kitVersion?: string;
  /** 测试缝:已判定为陈旧、尚未复读之前调用(用来在判定与删除之间换掉锁文件,演练回收竞态) */
  beforeReclaim?: () => Promise<void> | void;
  /** 测试缝:每次读锁文件、紧接着句柄级 open 之前调用(演练「检查之后、读取之前被换成符号链接 / FIFO」) */
  beforeRead?: (file: string) => Promise<void> | void;
}

/** 读入比较的上限;超过它 = 不是锁(`state_dir_unsafe`)。解析仍只接受 {@link RSI_LOCK_MAX_BYTES} 以内的内容 */
const RSI_LOCK_READ_CAP = 64 * 1024;

/** 存活判据(R20-5.5):发送成功或 `EPERM`(存在但无权发信号)= 存活;只有 `ESRCH` 才是「没有这个进程」。其它错误同样按存活(保守,不回收)。 */
export function makeIsAlive(kill: (pid: number, signal: 0) => unknown): (pid: number) => boolean {
  return (pid) => {
    try {
      kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  };
}
export const defaultAlive = makeIsAlive((pid, sig) => process.kill(pid, sig));

/** R20-7.2:`.state/rsi/` 下固定文件 / 目录的属主与权限口径(文件 0600、目录 0700;只读入口只校验,绝不收紧) */
export const RSI_FILE_OWNER: OwnerPolicy = { maxPerm: RSI_FILE_MODE };
export const RSI_DIR_OWNER: OwnerPolicy = { maxPerm: RSI_DIR_MODE };

/**
 * **只读方**用:同样的路径解析,但绝不创建目录、不 chmod(只读命令零写入,§20.8.1)。
 * 状态目录或 `rsi/` 不存在 → `missing`;`rsi/` 是符号链接 / 不是目录 / 属主不是当前用户 / 权限宽于 0700 → `unsafe`
 * (R20-7.2,句柄级校验,不自动收紧)。
 */
export async function rsiDirReadonly(
  io: IoContext,
  opts: { beforeOpen?: (file: string) => Promise<void> | void } = {},
): Promise<{ kind: 'ok'; dir: string } | { kind: 'missing' } | { kind: 'unsafe' }> {
  let stateReal: string;
  try {
    stateReal = await realpath(io.stateDir);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'unsafe' };
  }
  const dir = path.join(stateReal, 'rsi');
  const r = await statDirSafe(dir, {
    owner: RSI_DIR_OWNER,
    beforeOpen: () => opts.beforeOpen?.(dir),
  });
  if (r.kind === 'missing') return { kind: 'missing' };
  if (r.kind === 'unsafe') return { kind: 'unsafe' };
  return { kind: 'ok', dir };
}

export type LockRead =
  | { state: 'absent' }
  | { state: 'unsafe' }
  | { state: 'ok'; doc: RsiLockDoc; raw: Buffer; ino: string }
  | { state: 'bad'; raw: Buffer; ino: string; mtimeMs: number };

export async function readLock(
  file: string,
  beforeRead?: (file: string) => Promise<void> | void,
): Promise<LockRead> {
  // 句柄级读取(R20-7.2):O_NOFOLLOW、对句柄 fstat(普通文件 / nlink==1 / 属主 / ≤0600 / ≤64KiB)、有界读取。
  // 远大于正常内容的「锁文件」不是我们写的:不读、不比较、不回收,fail-closed(避免用空缓冲冒充「逐字节复读」)
  const r = await readFileSafe(file, {
    maxBytes: RSI_LOCK_READ_CAP,
    owner: RSI_FILE_OWNER,
    beforeOpen: () => beforeRead?.(file),
  });
  if (r.kind === 'missing') return { state: 'absent' };
  if (r.kind === 'unsafe') return { state: 'unsafe' };
  const raw = r.bytes;
  const ino = `${r.meta.dev}:${r.meta.ino}`;
  if (raw.length <= RSI_LOCK_MAX_BYTES) {
    try {
      const doc = RsiLockDocSchema.parse(JSON.parse(raw.toString('utf8')));
      return { state: 'ok', doc, raw, ino };
    } catch {
      // 落到 bad
    }
  }
  return { state: 'bad', raw, ino, mtimeMs: r.meta.mtimeMs };
}

/** 只读查看当前锁状态(`rsi status` 的 `lock:` 行用;不拿锁、不写)。D7:路径 / 锁文件不安全返回 `unsafe`(原 `unknown`) */
export async function peekRsiLock(
  io: IoContext,
  deps: RsiLockDeps = {},
): Promise<(typeof RSI_LOCK_STATES)[number]> {
  const alive = deps.isAlive ?? defaultAlive;
  const now = deps.now ?? ((): Date => new Date());
  const d = await rsiDirReadonly(io, { beforeOpen: deps.beforeRead });
  if (d.kind === 'missing') return 'free';
  if (d.kind === 'unsafe') return 'unsafe';
  const cur = await readLock(path.join(d.dir, 'lock'), deps.beforeRead);
  if (cur.state === 'absent') return 'free';
  if (cur.state === 'unsafe') return 'unsafe';
  if (cur.state === 'bad') {
    return now().getTime() - cur.mtimeMs < RSI_LOCK_PARTIAL_GRACE_MS ? 'held' : 'stale';
  }
  if (!alive(cur.doc.pid)) return 'stale';
  return now().getTime() - Date.parse(cur.doc.started_at) > RSI_LOCK_TTL_MS
    ? 'held_over_ttl'
    : 'held';
}
