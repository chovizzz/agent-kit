/**
 * `CommandLocks` 的真实现(设计稿 v3 §F B2 ⑤;`write/ports.ts` 的契约):**按序试锁、不排队、逆序释放**。
 * 取锁函数由装配注入(SOLID 的 D:本文件不 import 任何锁实现 / I/O),所以顺序 / 试锁 / 释放语义可以用假取锁器逐条证明,真取锁器由 `assemble-write.ts` 给。
 *
 * 语义:
 *  - 锁序固定 `rsi → personal → sync`;`personal_sync` = 缩减入口(**不取 rsi**);**不暴露任何单独取锁函数**,所以无法表达逆序(`HeldLocks` 只有回调参数);
 *  - 试锁:任一把拿不到(取锁器抛错,典型是 `RsiLockError('locked')`)→ **先逆序释放已拿到的**再原样抛出(`fn` 不执行);
 *  - 一定逆序释放(sync → personal → rsi),`fn` 抛错也释放;释放失败不遮盖 `fn` 的错误(三把都尝试释放);`fn` 成功而释放失败 → 抛释放错误(不假装干净);
 *  - sync 锁在 `rsi_personal_sync` 与 `personal_sync` 下**都在 `fn` 之前就持有**(契约:三把锁 / 缩减入口两把锁);`HeldLocks.syncLock.withLock(f)` = 复核仍持有后执行 `f`,**不再取第二次**(同一把锁不重入);
 *  - 当前持有者经 {@link CommandLockContext.current} 暴露(`AsyncLocalStorage`,只在 `fn` 的异步调用链内可见):锁绑定的端口(`PauseStatePort.write`、`EntryMarks.bump`、`VetoLift.lift`、`RebasePort.rewriteHead`)
 *    在**取锁之前**就装配好了,写入时用它断言「正处于一次持锁期内」——锁外调用 = 抛 `RsiLockError('internal')`,零写入。
 *  - 装配可挂 `around`(生产:在持有真实句柄之后、`fn` 之前装配存储核;存储核把释放屏障挂到真实句柄上,所以本文件逆序 `release()` 自动经生命周期控制块)。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { RsiLockError } from '../../lock-error.js';
import type { CommandLocks, HeldLocks, LockOrder } from './ports.js';

/** 取到的一把锁(真实句柄 / 假件) */
export interface AcquiredLock {
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}

/** 三个取锁器:各自试锁、不排队;拿不到抛错(`RsiLockError`) */
export interface LockAcquirers {
  rsi(): Promise<AcquiredLock>;
  personal(): Promise<AcquiredLock>;
  sync(): Promise<AcquiredLock>;
}

/** 本次持有的全部真实句柄(给装配的 `around` 用) */
export interface AcquiredSet {
  order: LockOrder;
  rsi: AcquiredLock | null;
  personal: AcquiredLock;
  sync: AcquiredLock;
}

export interface CommandLockOptions {
  /** 持有三(两)把锁、构造好 `HeldLocks` 之后调用;返回值 = `fn` 的结果。生产:装配存储核并登记到本次 `HeldLocks` */
  around?<T>(set: AcquiredSet, held: HeldLocks, run: () => Promise<T>): Promise<T>;
}

export interface CommandLockContext extends CommandLocks {
  /** 当前异步调用链里的持有者;不在 `withLocks` 回调内 = `undefined` */
  current(): HeldLocks | undefined;
}

const SEQUENCE: Readonly<Record<LockOrder, readonly ('rsi' | 'personal' | 'sync')[]>> =
  Object.freeze({
    personal_sync: Object.freeze(['personal', 'sync'] as const),
    rsi_personal_sync: Object.freeze(['rsi', 'personal', 'sync'] as const),
  });

export function makeCommandLocks(
  acquirers: LockAcquirers,
  opts: CommandLockOptions = {},
): CommandLockContext {
  const als = new AsyncLocalStorage<HeldLocks>();
  return {
    current: () => als.getStore(),
    async withLocks<T>(order: LockOrder, fn: (held: HeldLocks) => Promise<T>): Promise<T> {
      const taken: { name: 'rsi' | 'personal' | 'sync'; lock: AcquiredLock }[] = [];
      const releaseAll = async (): Promise<unknown> => {
        let first: unknown;
        for (const t of [...taken].reverse()) {
          try {
            await t.lock.release();
          } catch (e) {
            first ??= e;
          }
        }
        taken.length = 0;
        return first;
      };
      try {
        for (const name of SEQUENCE[order]) {
          taken.push({ name, lock: await acquirers[name]() });
        }
      } catch (e) {
        await releaseAll(); // 试锁失败:先逆序释放已拿到的,再原样抛出
        throw e;
      }
      const by = (n: 'rsi' | 'personal' | 'sync'): AcquiredLock | null =>
        taken.find((t) => t.name === n)?.lock ?? null;
      const rsi = by('rsi');
      const personal = by('personal') as AcquiredLock;
      const sync = by('sync') as AcquiredLock;
      const held: HeldLocks = {
        rsi: rsi === null ? null : { assertHeld: () => rsi.assertHeld() },
        personal: { assertHeld: () => personal.assertHeld() },
        syncLock: {
          withLock: async <R>(f: () => Promise<R>): Promise<R> => {
            await sync.assertHeld();
            return f();
          },
        },
      };
      const run = (): Promise<T> => als.run(held, () => fn(held));
      let out: T;
      try {
        out = await (opts.around === undefined
          ? run()
          : opts.around({ order, rsi, personal, sync }, held, run));
      } catch (e) {
        await releaseAll(); // 释放失败不遮盖业务错误
        throw e;
      }
      const relErr = await releaseAll();
      if (relErr !== undefined) throw relErr;
      return out;
    },
  };
}

/** 锁绑定端口的断言:必须处于一次持锁期内(`needRsi` = 还要持有 `rsi/lock`);否则 `RsiLockError('internal')`,零写入 */
export async function assertInsideLocks(
  ctx: Pick<CommandLockContext, 'current'>,
  needRsi: boolean,
): Promise<HeldLocks> {
  const h = ctx.current();
  if (h === undefined || (needRsi && h.rsi === null)) throw new RsiLockError('internal');
  if (h.rsi !== null) await h.rsi.assertHeld();
  await h.personal.assertHeld();
  return h;
}
