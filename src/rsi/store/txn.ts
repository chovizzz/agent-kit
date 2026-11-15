/**
 * 单层事务协调器(设计稿 v3 §D.1 / 第 2 版 §3;§21.24 W0-26 第 12 条)。
 *
 * - `transaction(fn)`:先 `assertHeld(rsi)` 再 `assertHeld(personal)`,再跑 `fn`;`fn` 拿到**绑定本次事务 token** 的窄写端口 `{ledgerWrite, auditAppend}`:
 *   每个写 / 读方法先验 token(事务结束后捕获端口再用 = `txn_closed`),并**追踪每个已发起的写**——`fn` 返回后先等全部在途写落定,再让 token 失效,
 *   所以回调里没 await 的写不会漂到事务(与随后的 `release()`)之外。一把锁下的全部写共享一个进程内串行队列;`fn` 拒绝后队列照常继续。
 * - `closing`:`release()` 同步置位;此后 `transaction` 拒绝(`txn_closing`)。`release()` 等在途 / 已排队的事务完成,再**逆序**释放 personal → rsi;并发多次调用共享同一 promise。
 * - 事务上下文用 `AsyncLocalStorage` 存 `{lockIdentity, txnId}`:**只有发生在本把锁事务回调内的 `release()` 才被拒**(`release_inside_transaction`,否则自锁);
 *   别的锁的事务回调内调用本把锁的 `release()` 照常等待;事务内再开本把锁的事务 = `txn_nested`(串行队列上会自锁)。
 * - 威胁模型:防工程误用(旧句柄、端口逃逸、释放 / 提交竞态、错 root),**不防**同进程恶意代码(强转造假类型但 nonce 不在盘上,写必败)。
 *   跨进程残余:锁仅在持有者 pid 不存在、或内容损坏且超 10 秒时被回收,活着的持有者不被抢占;`assertHeld` 到 `rename` 之间的窗口只剩此残余(契约写明)。
 * 锁序固定 `rsi → personal → sync`:本模块不暴露任何单独取锁的函数(`LockOrder` 由命令装配的 `withLocks` 实现,B2),只在已持有的能力上工作。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { StoreError } from './errors.js';
import type { StoreBackend } from './backend.js';
import type { HeldStore, LockCap, TxnPorts } from './ports.js';

interface TxnContext {
  lock: symbol;
  txn: number;
}
const txnContext = new AsyncLocalStorage<TxnContext>();

export interface HeldStoreDeps {
  rsi: LockCap;
  personal: LockCap;
  backend: StoreBackend;
}

export function createHeldStore(deps: HeldStoreDeps): HeldStore {
  const lockIdentity = Symbol('rsi-held-store');
  let closing = false;
  let tail: Promise<void> = Promise.resolve();
  let releasing: Promise<void> | null = null;
  let seq = 0;

  const assertBoth = async (): Promise<void> => {
    await deps.rsi.assertHeld();
    await deps.personal.assertHeld();
  };

  const execute = async <T>(fn: (p: TxnPorts) => Promise<T>): Promise<T> => {
    const id = ++seq;
    const token = { alive: true, accepting: true };
    const pending = new Set<Promise<unknown>>();

    /** 登记一个写 / 读:同步入口先验 token;链内再复核锁与 token */
    const track = <R>(op: () => Promise<R>): Promise<R> => {
      if (!token.alive || !token.accepting) return Promise.reject(new StoreError('txn_closed'));
      const run = (async (): Promise<R> => {
        await assertBoth();
        if (!token.alive) throw new StoreError('txn_closed');
        return op();
      })();
      pending.add(run);
      const forget = (): void => {
        pending.delete(run);
      };
      run.then(forget, forget);
      return run;
    };

    const ports: TxnPorts = {
      ledgerWrite: {
        read: () => track(() => deps.backend.readLedger()),
        commit: (next) => track(() => deps.backend.commitLedger(next, assertBoth)),
      },
      auditAppend: {
        readAudit: () => track(() => deps.backend.readAudit()),
        readWatermark: () => track(() => deps.backend.readWatermark()),
        append: (text) => track(() => deps.backend.appendAudit(text, assertBoth)),
        rewrite: (text) => track(() => deps.backend.rewriteAudit(text, assertBoth)),
      },
    };

    try {
      await assertBoth();
      return await txnContext.run({ lock: lockIdentity, txn: id }, () => fn(ports));
    } finally {
      token.accepting = false;
      // 回调里没 await 的写:等它们落定(失败不在这里上抛——发起者持有该 promise)
      while (pending.size > 0) await Promise.allSettled([...pending]);
      token.alive = false;
    }
  };

  return {
    get closing(): boolean {
      return closing;
    },
    transaction<T>(fn: (ports: TxnPorts) => Promise<T>): Promise<T> {
      if (txnContext.getStore()?.lock === lockIdentity) {
        return Promise.reject(new StoreError('txn_nested'));
      }
      if (closing) return Promise.reject(new StoreError('txn_closing'));
      const run = tail.then(() => execute(fn));
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    release(): Promise<void> {
      if (txnContext.getStore()?.lock === lockIdentity) {
        return Promise.reject(new StoreError('release_inside_transaction'));
      }
      if (releasing === null) {
        closing = true;
        releasing = (async (): Promise<void> => {
          await tail;
          try {
            await deps.personal.release();
          } finally {
            await deps.rsi.release();
          }
        })();
      }
      return releasing;
    },
  };
}
