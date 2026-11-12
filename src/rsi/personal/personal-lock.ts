/**
 * `personal/lock`:个人层锁(contracts §21.3 R21-3.2 / R21-3.3),协议与 `rsi/lock` 相同(R20-5.5,A1 的 `src/rsi/lock.ts`),
 * 区别只有位置与写出口:文件在 `<HOME>/.local/state/agent-kit/rsi-personal/lock`(0600,目录 0700),写走 home-fs(`createExclusive` / `remove`)。
 *
 * - 试锁、不排队;已存在时:空文件 / 内容损坏且距创建不满 10 秒 → `locked`;pid 存活 → `locked`(超过 TTL 15 分钟只报 `locked_over_ttl`,**不杀、不删**);
 *   pid 不存在(`ESRCH`),或损坏且满 10 秒 → 回收:删除前**复读,与先前读到的逐字节相同并且仍是同一个 inode** 才删,再独占创建重试一次。
 * - 每个提交点前调 `assertHeld()`:锁文件的 nonce 仍是自己的,否则 `lock_lost`,调用方立即停止、不再写。
 * - 同一进程第二次获取同一把锁 = 编程错误(`internal`,不重入)。
 * - 读锁文件复用 `lock-read.ts` 的句柄级读取(O_NOFOLLOW、nlink、属主 / 权限、有界);时钟、pid、存活判据、随机源都可注入。
 * - 锁序(R21-3.3):`rsi/lock` → `personal/lock` → sync 锁。本文件只管 `personal/lock`;反向取锁的守卫在 A1 的 `lock.ts`(不在 W2 范围,见汇报)。
 * 错误类型沿用 `RsiLockError`(同一组 kind,稳定码映射相同)。
 */
import { randomBytes } from 'node:crypto';
import { KIT_VERSION } from '../../contracts/meta.js';
import {
  RSI_FILE_MODE,
  RSI_LOCK_PARTIAL_GRACE_MS,
  RSI_LOCK_TTL_MS,
  type RsiLockDoc,
} from '../../contracts/rsi.js';
import { canonicalJson } from '../../io/canonical-json.js';
import {
  createExclusive,
  HomeExistsError,
  HomeWriteDeniedError,
  mkdirp,
  remove,
} from '../../io/home-fs.js';
import { statDirSafe } from '../../io/read-fs.js';
import { RsiLockError } from '../lock-error.js';
import { markPersonalLockHeld, unmarkPersonalLockHeld } from '../lock-order.js';
import {
  defaultAlive,
  readLock,
  RSI_DIR_OWNER,
  type LockRead,
  type RsiLockDeps,
} from '../lock-read.js';
import {
  homeFsFor,
  PERSONAL_STATE_FILES,
  PERSONAL_STATE_REL,
  statePath,
  type PersonalHome,
} from './home-state.js';

export interface PersonalLockHandle {
  readonly path: string;
  readonly nonce: string;
  /** 提交点前复核:锁文件的 nonce 仍是自己的;不是(被回收者夺走、被删、被换成链接)→ 抛 `RsiLockError('lock_lost')` */
  assertHeld(): Promise<void>;
  /** 释放:仅当锁文件仍是自己的才删;已丢失则什么也不删。幂等。 */
  release(): Promise<void>;
}

/** 本进程内已持有的锁(按路径);同一进程第二次获取同一把锁 = 编程错误 */
const heldInProcess = new Set<string>();

const defaultRandomHex = (bytes: number): string => randomBytes(bytes).toString('hex');

function sameRead(a: LockRead, b: LockRead): boolean {
  return (
    (a.state === 'ok' || a.state === 'bad') &&
    (b.state === 'ok' || b.state === 'bad') &&
    a.ino === b.ino &&
    a.raw.equals(b.raw)
  );
}

const LOCK_NAME = PERSONAL_STATE_FILES.lock;
const lockRel = `${PERSONAL_STATE_REL}/${LOCK_NAME}`;

/** 状态目录(0700)存在;已存在则句柄级校验属主 / 权限(只读校验,不收紧)。 */
async function prepareStateDir(h: PersonalHome): Promise<void> {
  try {
    await mkdirp(homeFsFor(h, [LOCK_NAME]), PERSONAL_STATE_REL, 0o700);
  } catch (e) {
    if (e instanceof HomeWriteDeniedError) throw new RsiLockError('write_denied');
    throw e;
  }
  const r = await statDirSafe(h.stateDir, { owner: RSI_DIR_OWNER });
  if (r.kind !== 'ok') throw new RsiLockError('state_dir_unsafe');
}

/**
 * 试锁。成功返回句柄;被占用 → `RsiLockError('locked' | 'locked_over_ttl')`;路径不安全 / 写出口拒绝 → fail-closed 类。
 * 调用方在 `finally` 里 `release()`。
 */
export async function acquirePersonalLock(
  h: PersonalHome,
  deps: RsiLockDeps = {},
): Promise<PersonalLockHandle> {
  const alive = deps.isAlive ?? defaultAlive;
  const now = deps.now ?? ((): Date => new Date());
  await prepareStateDir(h);
  const file = statePath(h, LOCK_NAME);
  if (heldInProcess.has(file)) throw new RsiLockError('internal'); // 不重入
  const doc: RsiLockDoc = {
    pid: deps.pid ?? process.pid,
    started_at: now().toISOString(),
    nonce: (deps.randomHex ?? defaultRandomHex)(8),
    kit_version: deps.kitVersion ?? KIT_VERSION,
  };
  const ctx = homeFsFor(h, [LOCK_NAME]);

  for (let attempt = 0; attempt < 2; attempt++) {
    let created = false;
    try {
      await createExclusive(ctx, lockRel, canonicalJson(doc), {
        mode: RSI_FILE_MODE,
        dirMode: 0o700,
      });
      created = true;
    } catch (e) {
      if (e instanceof HomeWriteDeniedError) throw new RsiLockError('write_denied');
      if (!(e instanceof HomeExistsError)) throw e;
    }
    if (created) {
      const mine = await readLock(file, deps.beforeRead);
      if (mine.state === 'unsafe') throw new RsiLockError('state_dir_unsafe');
      if (mine.state !== 'ok' || mine.doc.nonce !== doc.nonce) throw new RsiLockError('locked');
      heldInProcess.add(file);
      markPersonalLockHeld(file);
      let released = false;
      return {
        path: file,
        nonce: doc.nonce,
        async assertHeld(): Promise<void> {
          const cur = await readLock(file, deps.beforeRead);
          if (cur.state !== 'ok' || cur.doc.nonce !== doc.nonce) {
            throw new RsiLockError('lock_lost');
          }
        },
        async release(): Promise<void> {
          if (released) return;
          released = true;
          try {
            const cur = await readLock(file, deps.beforeRead);
            if (cur.state === 'ok' && cur.doc.nonce === doc.nonce) {
              await remove(ctx, lockRel);
            }
          } finally {
            heldInProcess.delete(file);
            unmarkPersonalLockHeld(file);
          }
        },
      };
    }

    const cur = await readLock(file, deps.beforeRead);
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
    const again = await readLock(file, deps.beforeRead);
    if (!sameRead(cur, again)) continue;
    await remove(ctx, lockRel);
  }
  throw new RsiLockError('locked');
}

/** 顶层写入方的便捷入口:拿锁 → 回调 → 一定释放。 */
export async function withPersonalLock<T>(
  h: PersonalHome,
  fn: (lock: PersonalLockHandle) => Promise<T>,
  deps: RsiLockDeps = {},
): Promise<T> {
  const lock = await acquirePersonalLock(h, deps);
  try {
    return await fn(lock);
  } finally {
    await lock.release();
  }
}
