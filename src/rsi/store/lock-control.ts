/**
 * 锁 acquisition 的**生命周期控制块**(§21.24 W0-26 第 12 条;评审 H1)。
 *
 * 一次真实 acquisition = 一对 `rsi + personal` 句柄。互斥与释放屏障绑定在**这对句柄**上,不绑在某个 `HeldStore` 实例上:
 *  - 同一对句柄重复装配 → **复用同一个控制块**(共享串行队列、`closing`、释放 promise),所以两个 `HeldStore` 的并发事务仍串行;
 *    任一句柄已绑给**别的**控制块 / 角色互换 / root 或锁种类对不上 → 拒绝(`lock_cap_mismatch`,零副作用);
 *  - 装配时把**释放屏障**挂到两个真实句柄上:句柄自己的 `release()` 也先 `closing` + 等在途事务;屏障在本控制块的事务回调内被调用 → 拒绝(`release_inside_transaction`,锁保持)。
 * 身份:`LockCap.path` 与 `StoreFs.root` 要么都给(真实装配:`rsi.path === <root>/lock`,`personal.path` 不在 root 之下且不等于 rsi 路径,即锁种类与 root 归属可验)、
 * 要么都不给(测试假件);只给一半 = 拒绝。威胁模型同 txn.ts:防工程误用,不防同进程恶意代码。
 * 本模块不导出取锁函数(锁序由命令装配的 `LockOrder` 保证)。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import * as path from 'node:path';
import { StoreError } from './errors.js';
import type { LockCap } from './ports.js';

interface TxnContext {
  lock: symbol;
  txn: number;
}

export interface LockControl {
  readonly closing: boolean;
  /** 串行执行 `body`(整个 acquisition 一条队列);事务内再入 = `txn_nested`;closing 后 = `txn_closing`。`body` 收到本次事务序号 */
  runExclusive<T>(body: (txnId: number) => Promise<T>): Promise<T>;
  /** 置 closing → 等在途 / 已排队的事务 → 逆序释放 personal → rsi;并发多次共享同一 promise */
  release(): Promise<void>;
  /** 同一 acquisition 的身份令牌(`SealRegistry` 绑定用) */
  readonly identity: symbol;
}

interface Binding {
  control: LockControl;
  rsi: LockCap;
  personal: LockCap;
}
const bindingOf = new WeakMap<object, Binding>();

const mismatch = (detail: string): StoreError => new StoreError('lock_cap_mismatch', detail);

function checkIdentity(rsi: LockCap, personal: LockCap, root: string | undefined): void {
  if (rsi === personal) throw mismatch('same_cap');
  const declared = [rsi.path !== undefined, personal.path !== undefined, root !== undefined];
  if (declared.some((d) => d !== declared[0])) throw mismatch('identity_half');
  if (rsi.path === undefined || personal.path === undefined || root === undefined) return;
  if (rsi.path !== path.join(root, 'lock')) throw mismatch('rsi_root');
  if (personal.path === rsi.path || personal.path.startsWith(root + path.sep)) {
    throw mismatch('personal_kind');
  }
  if (rsi.attachReleaseGate === undefined || personal.attachReleaseGate === undefined) {
    throw mismatch('no_release_gate'); // 真实句柄必须能挂屏障,否则原始 release 可绕过
  }
}

export function acquireLockControl(
  rsi: LockCap,
  personal: LockCap,
  root: string | undefined,
): LockControl {
  checkIdentity(rsi, personal, root);
  const a = bindingOf.get(rsi);
  const b = bindingOf.get(personal);
  if (a !== undefined || b !== undefined) {
    if (a === undefined || a !== b || a.rsi !== rsi || a.personal !== personal) {
      throw mismatch('acquisition_conflict');
    }
    return a.control; // root 由 `rsi.path` 唯一决定(上面的身份校验已确认),同一对句柄不会换 root
  }
  const control = createControl(rsi, personal);
  const binding: Binding = { control, rsi, personal };
  // 先挂屏障(可能因已有别的屏障而抛),成功后再登记,避免半绑定
  const gate = { beforeRelease: () => drain(control) };
  rsi.attachReleaseGate?.(gate);
  personal.attachReleaseGate?.(gate);
  bindingOf.set(rsi, binding);
  bindingOf.set(personal, binding);
  return control;
}

interface Internals {
  drain(): Promise<void>;
}
const internals = new WeakMap<LockControl, Internals>();
const drain = (c: LockControl): Promise<void> => (internals.get(c) as Internals).drain();

function createControl(rsi: LockCap, personal: LockCap): LockControl {
  const identity = Symbol('rsi-lock-control');
  const als = new AsyncLocalStorage<TxnContext>();
  let closing = false;
  let tail: Promise<void> = Promise.resolve();
  let releasing: Promise<void> | null = null;
  let seq = 0;

  const insideOwnTxn = (): boolean => als.getStore()?.lock === identity;

  const drainImpl = (): Promise<void> => {
    if (insideOwnTxn()) {
      return Promise.reject(new StoreError('release_inside_transaction', 'raw_release'));
    }
    closing = true;
    return tail;
  };

  const control: LockControl = {
    identity,
    get closing(): boolean {
      return closing;
    },
    runExclusive<T>(body: (txnId: number) => Promise<T>): Promise<T> {
      if (insideOwnTxn()) return Promise.reject(new StoreError('txn_nested'));
      if (closing) return Promise.reject(new StoreError('txn_closing'));
      const id = ++seq;
      const run = tail.then(() => als.run({ lock: identity, txn: id }, () => body(id)));
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    release(): Promise<void> {
      if (insideOwnTxn()) return Promise.reject(new StoreError('release_inside_transaction'));
      if (releasing === null) {
        closing = true;
        releasing = (async (): Promise<void> => {
          await tail;
          try {
            await personal.release();
          } finally {
            await rsi.release();
          }
        })();
      }
      return releasing;
    },
  };
  internals.set(control, { drain: drainImpl });
  return control;
}
