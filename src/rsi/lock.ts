/**
 * `rsi/lock`:自动 RSI 的仓库级写锁(docs/contracts.md §20.5,R20-5.2 ~ R20-5.5;块 A1)。
 *
 * - 位置:`<realpath(stateDir)>/rsi/lock`(R20-5.3),同一仓库经不同路径写法是同一把锁;`rsi/` 目录 0700、锁文件 0600。
 *   `rsi/` 若是符号链接 / 不是目录 → fail-closed(`state_dir_unsafe`),不顺着链接建锁。
 * - 获取是**试锁、不排队**:`createExclusive`(`O_CREAT|O_EXCL|O_NOFOLLOW`),内容 `{pid, started_at, nonce, kit_version}`。
 *   已存在时(与 update / sync 锁同一套规则,契约 §19.5):
 *     · 空文件 / 内容损坏且距创建(mtime)不满 10 秒 → 占用(`locked`);
 *     · 内容可解析且 pid 存活(`process.kill(pid, 0)` 成功或 `EPERM`)→ 占用;超过 TTL(15 分钟)只报 `locked_over_ttl`,**不杀、不删**;
 *     · pid 不存在(`ESRCH`),或内容损坏且满 10 秒 → 回收:删除前**复读,与先前读到的逐字节相同**(并且仍是同一个 inode)才删,再独占创建重试一次。
 *   已知残余(照契约不弱化):两个回收者先后删除的竞态只靠 nonce 复核缩小窗口;pid 被无关长寿进程复用时会一直报 `locked_over_ttl`,
 *   需要用户手工删 `.state/rsi/lock`。
 * - 每个提交点前调 `assertHeld()`:锁文件的 nonce 仍是自己的,否则 `lock_lost`,调用方立即停止、不再写。
 * - 同一进程第二次获取同一把锁 = 编程错误(`internal`),不重入(R20-5.4)。
 * - 时钟、pid、进程存活判据、随机源都可注入,测试不依赖真实时间 / 真实进程。
 *
 * 本文件只管 `rsi/lock`。锁序里后面的 `personal/lock`、sync 锁(§21.3)A1 不涉及;`reflect/llm.lock` 仍由 `src/reflect/backends/lock.ts` 管。
 */
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import {
  RSI_DIR_MODE,
  RSI_FILE_MODE,
  RSI_LOCK_MAX_BYTES,
  RSI_LOCK_PARTIAL_GRACE_MS,
  RSI_LOCK_TTL_MS,
  RsiLockDocSchema,
  type RsiFailClosedReason,
  type RsiLockDoc,
  type RsiNotRunReason,
} from '../contracts/rsi.js';
import { ExitCode, type ExitCodeValue } from '../contracts/exit-codes.js';
import { KIT_VERSION } from '../contracts/meta.js';
import { canonicalJson } from '../io/canonical-json.js';
import type { IoContext } from '../io/paths.js';
import { lstat, readBytes, realpath } from '../io/read-fs.js';
import { chmod, createExclusive, mkdirp, remove, WriteDeniedError } from '../io/safe-fs.js';

export interface RsiLockDeps {
  /** 进程存活判据;缺省 `process.kill(pid, 0)`:成功或 `EPERM` = 存活,仅 `ESRCH` = 不存在 */
  isAlive?: (pid: number) => boolean;
  now?: () => Date;
  pid?: number;
  randomHex?: (bytes: number) => string;
  kitVersion?: string;
  /** 测试缝:已判定为陈旧、尚未复读之前调用(用来在判定与删除之间换掉锁文件,演练回收竞态) */
  beforeReclaim?: () => Promise<void> | void;
}

/** 获取 / 复核失败的分类;`toStable()` 给出契约稳定码(§20.3 R20-3.0) */
export type RsiLockErrorKind =
  | 'locked'
  | 'locked_over_ttl'
  | 'lock_lost'
  | 'state_dir_unsafe'
  | 'write_denied'
  | 'internal';

export class RsiLockError extends Error {
  readonly code = 'RSI_LOCK';
  constructor(readonly kind: RsiLockErrorKind) {
    super(`rsi/lock: ${kind}`);
  }

  /** `RSI_NOT_RUN reason=locked|locked_over_ttl`(退出 4)或 `RSI_FAIL_CLOSED reason=…`(退出 3) */
  toStable(): {
    code: 'RSI_NOT_RUN' | 'RSI_FAIL_CLOSED';
    reason: RsiNotRunReason | RsiFailClosedReason;
    exit: ExitCodeValue;
  } {
    switch (this.kind) {
      case 'locked':
      case 'locked_over_ttl':
        return { code: 'RSI_NOT_RUN', reason: this.kind, exit: ExitCode.NOT_RUN };
      default:
        return { code: 'RSI_FAIL_CLOSED', reason: this.kind, exit: ExitCode.FAIL_CLOSED };
    }
  }
}

export interface RsiLockHandle {
  readonly path: string;
  readonly nonce: string;
  /** 提交点前复核:锁文件的 nonce 仍是自己的;不是(被回收者夺走、被删、被换成链接)→ 抛 `RsiLockError('lock_lost')` */
  assertHeld(): Promise<void>;
  /** 释放:仅当锁文件仍是自己的才删;已丢失则什么也不删。幂等。 */
  release(): Promise<void>;
}

/** 本进程内已持有的锁(按真实路径);同一进程第二次获取 = 编程错误(R20-5.4) */
const heldInProcess = new Set<string>();

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
const defaultAlive = makeIsAlive((pid, sig) => process.kill(pid, sig));
const defaultRandomHex = (bytes: number): string => randomBytes(bytes).toString('hex');

/** 状态目录的真实路径(必要时先建);`rsi/` 子目录必须是真实目录,权限收紧到 0700 */
export async function rsiDir(io: IoContext): Promise<string> {
  await mkdirp(io, io.stateDir, RSI_DIR_MODE);
  const stateReal = await realpath(io.stateDir);
  const dir = path.join(stateReal, 'rsi');
  await mkdirp(io, dir, RSI_DIR_MODE);
  const st = await lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new RsiLockError('state_dir_unsafe');
  if ((st.mode & 0o077) !== 0) await chmod(io, dir, RSI_DIR_MODE);
  return dir;
}

type LockRead =
  | { state: 'absent' }
  | { state: 'unsafe' }
  | { state: 'ok'; doc: RsiLockDoc; raw: Buffer; ino: string }
  | { state: 'bad'; raw: Buffer; ino: string; mtimeMs: number };

async function readLock(file: string): Promise<LockRead> {
  let st;
  try {
    st = await lstat(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' };
    return { state: 'unsafe' };
  }
  if (st.isSymbolicLink() || !st.isFile()) return { state: 'unsafe' };
  const ino = `${st.dev}:${st.ino}`;
  let raw: Buffer;
  try {
    raw = st.size > RSI_LOCK_MAX_BYTES ? Buffer.alloc(0) : Buffer.from(await readBytes(file));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' };
    return { state: 'unsafe' };
  }
  if (st.size <= RSI_LOCK_MAX_BYTES) {
    try {
      const doc = RsiLockDocSchema.parse(JSON.parse(raw.toString('utf8')));
      return { state: 'ok', doc, raw, ino };
    } catch {
      // 落到 bad
    }
  }
  return { state: 'bad', raw, ino, mtimeMs: st.mtimeMs };
}

function sameRead(a: LockRead, b: LockRead): boolean {
  return (
    (a.state === 'ok' || a.state === 'bad') &&
    (b.state === 'ok' || b.state === 'bad') &&
    a.ino === b.ino &&
    a.raw.equals(b.raw)
  );
}

/**
 * 试锁。成功返回句柄;被占用 → `RsiLockError('locked' | 'locked_over_ttl')`;路径不安全 / 写出口拒绝 → fail-closed 类。
 * 调用方在 `finally` 里 `release()`,或直接用 {@link withRsiLock}。
 */
export async function acquireRsiLock(
  io: IoContext,
  deps: RsiLockDeps = {},
): Promise<RsiLockHandle> {
  const alive = deps.isAlive ?? defaultAlive;
  const now = deps.now ?? ((): Date => new Date());
  const dir = await rsiDir(io).catch((e: unknown) => {
    if (e instanceof WriteDeniedError) throw new RsiLockError('write_denied');
    throw e;
  });
  const file = path.join(dir, 'lock');
  if (heldInProcess.has(file)) throw new RsiLockError('internal'); // 不重入
  const doc: RsiLockDoc = {
    pid: deps.pid ?? process.pid,
    started_at: now().toISOString(),
    nonce: (deps.randomHex ?? defaultRandomHex)(8),
    kit_version: deps.kitVersion ?? KIT_VERSION,
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    let created = false;
    try {
      await createExclusive(io, file, canonicalJson(doc), RSI_FILE_MODE);
      created = true;
    } catch (e) {
      if (e instanceof WriteDeniedError) throw new RsiLockError('write_denied');
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    if (created) {
      const mine = await readLock(file);
      if (mine.state !== 'ok' || mine.doc.nonce !== doc.nonce) throw new RsiLockError('locked');
      heldInProcess.add(file);
      let released = false;
      const assertHeld = async (): Promise<void> => {
        const cur = await readLock(file);
        if (cur.state !== 'ok' || cur.doc.nonce !== doc.nonce) throw new RsiLockError('lock_lost');
      };
      return {
        path: file,
        nonce: doc.nonce,
        assertHeld,
        async release(): Promise<void> {
          if (released) return;
          released = true;
          try {
            const cur = await readLock(file);
            if (cur.state === 'ok' && cur.doc.nonce === doc.nonce) await remove(io, file);
          } finally {
            heldInProcess.delete(file);
          }
        },
      };
    }

    const cur = await readLock(file);
    if (cur.state === 'absent') continue;
    if (cur.state === 'unsafe') throw new RsiLockError('state_dir_unsafe');
    if (cur.state === 'ok') {
      if (alive(cur.doc.pid)) {
        const age = now().getTime() - Date.parse(cur.doc.started_at);
        throw new RsiLockError(age > RSI_LOCK_TTL_MS ? 'locked_over_ttl' : 'locked');
      }
    } else if (now().getTime() - cur.mtimeMs < RSI_LOCK_PARTIAL_GRACE_MS) {
      throw new RsiLockError('locked'); // 空文件 / 损坏但还很新:可能正在写
    }
    // 回收:删除前复读,逐字节相同(且仍是同一个 inode)才删
    await deps.beforeReclaim?.();
    const again = await readLock(file);
    if (!sameRead(cur, again)) continue;
    await remove(io, file);
  }
  throw new RsiLockError('locked');
}

/** 顶层写入方的便捷入口:拿锁 → 回调(传入句柄,内部服务函数只接受句柄)→ 一定释放。 */
export async function withRsiLock<T>(
  io: IoContext,
  fn: (lock: RsiLockHandle) => Promise<T>,
  deps: RsiLockDeps = {},
): Promise<T> {
  const lock = await acquireRsiLock(io, deps);
  try {
    return await fn(lock);
  } finally {
    await lock.release();
  }
}

/** 只读查看当前锁状态(`rsi status` 的 `lock:` 行用;不拿锁、不写) */
export async function peekRsiLock(
  io: IoContext,
  deps: RsiLockDeps = {},
): Promise<'free' | 'held' | 'held_over_ttl' | 'stale' | 'unknown'> {
  const alive = deps.isAlive ?? defaultAlive;
  const now = deps.now ?? ((): Date => new Date());
  let file: string;
  try {
    file = path.join(await realpath(io.stateDir), 'rsi', 'lock');
  } catch {
    return 'free';
  }
  const cur = await readLock(file);
  if (cur.state === 'absent') return 'free';
  if (cur.state === 'unsafe') return 'unknown';
  if (cur.state === 'bad') {
    return now().getTime() - cur.mtimeMs < RSI_LOCK_PARTIAL_GRACE_MS ? 'held' : 'stale';
  }
  if (!alive(cur.doc.pid)) return 'stale';
  return now().getTime() - Date.parse(cur.doc.started_at) > RSI_LOCK_TTL_MS
    ? 'held_over_ttl'
    : 'held';
}
