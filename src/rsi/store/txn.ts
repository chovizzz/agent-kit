/**
 * 单层事务协调器(设计稿 v3 §D.1 / 第 2 版 §3;§21.24 W0-26 第 12 条)。
 *
 * - `transaction(fn)`:先 `assertHeld(rsi)` 再 `assertHeld(personal)`,再跑 `fn`;`fn` 拿到**绑定本次事务 token** 的窄写端口 `{ledgerWrite, auditAppend}`:
 *   每个写 / 读方法先验 token(事务结束后捕获端口再用 = `txn_closed`),并**追踪每个已发起的写**——`fn` 返回后先等全部在途写落定,再让 token 失效,
 *   所以回调里没 await 的写不会漂到事务(与随后的 `release()`)之外。一把锁下的全部写共享一个进程内串行队列;`fn` 拒绝后队列照常继续。
 * - 串行队列、`closing`、释放 promise、事务上下文(`AsyncLocalStorage`)都在 **acquisition 的生命周期控制块**(`lock-control.ts`)里,不在本文件:
 *   同一对真实句柄装配多个 `HeldStore` 共享同一个控制块(并发事务仍串行);真实句柄自己的 `release()` 也经控制块的释放屏障(等在途事务、置 closing)。
 * - `closing`:`release()` 同步置位;此后 `transaction` 拒绝(`txn_closing`)。`release()` 等在途 / 已排队的事务完成,再**逆序**释放 personal → rsi;并发多次调用共享同一 promise。
 * - **只有发生在本 acquisition 事务回调内的 `release()` 才被拒**(`release_inside_transaction`,否则自锁);别的 acquisition 的事务回调内调用照常等待;事务内再开事务 = `txn_nested`。
 * - 威胁模型:防工程误用(旧句柄、端口逃逸、释放 / 提交竞态、错 root),**不防**同进程恶意代码(强转造假类型但 nonce 不在盘上,写必败)。
 *   跨进程残余:锁仅在持有者 pid 不存在、或内容损坏且超 10 秒时被回收,活着的持有者不被抢占;`assertHeld` 到 `rename` 之间的窗口只剩此残余(契约写明)。
 * 锁序固定 `rsi → personal → sync`:本模块不暴露任何单独取锁的函数(`LockOrder` 由命令装配的 `withLocks` 实现,B2),只在已持有的能力上工作。
 */
import { StoreError } from './errors.js';
import type { StoreBackend } from './backend.js';
import { bindCompactionPort } from './compaction-port.js';
import { acquireLockControl } from './lock-control.js';
import type { HeldStore, LockCap, TxnPorts } from './ports.js';

export interface HeldStoreDeps {
  rsi: LockCap;
  personal: LockCap;
  backend: StoreBackend;
  /** `StoreFs.root`(与 `LockCap.path` 一起验锁种类 / root 归属;测试假件两者都不给) */
  root?: string;
}

export function createHeldStore(deps: HeldStoreDeps): HeldStore {
  const control = acquireLockControl(deps.rsi, deps.personal, deps.root);

  const assertBoth = async (): Promise<void> => {
    await deps.rsi.assertHeld();
    await deps.personal.assertHeld();
  };

  const execute = async <T>(fn: (p: TxnPorts) => Promise<T>): Promise<T> => {
    const token = { alive: true, accepting: true };
    const pending = new Set<Promise<unknown>>();
    /** 事务内的读写也串行(同一事务里并发的 commit / rewrite / append 不得争用同一 `.tmp`) */
    let opTail: Promise<unknown> = Promise.resolve();

    /** 登记一个写 / 读:同步入口先验 token;链内再复核锁与 token */
    const track = <R>(op: () => Promise<R>): Promise<R> => {
      if (!token.alive || !token.accepting) return Promise.reject(new StoreError('txn_closed'));
      const run = opTail.then(async (): Promise<R> => {
        await assertBoth();
        if (!token.alive) throw new StoreError('txn_closed');
        return op();
      });
      opTail = run.then(
        () => undefined,
        () => undefined,
      );
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

    bindCompactionPort(ports, {
      read: () => track(() => deps.backend.readCompaction()),
      commit: (next) => track(() => deps.backend.writeCompaction(next, assertBoth)),
    });

    try {
      await assertBoth();
      return await fn(ports);
    } finally {
      token.accepting = false;
      // 回调里没 await 的写:等它们落定(失败不在这里上抛——发起者持有该 promise)
      while (pending.size > 0) await Promise.allSettled([...pending]);
      token.alive = false;
    }
  };

  return {
    get closing(): boolean {
      return control.closing;
    },
    transaction<T>(fn: (ports: TxnPorts) => Promise<T>): Promise<T> {
      return control.runExclusive(() => execute(fn));
    },
    release(): Promise<void> {
      return control.release();
    },
  };
}
