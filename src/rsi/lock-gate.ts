/**
 * 锁句柄的**释放屏障**槽位(§21.24 W0-26 第 12 条;`rsi/lock.ts`、`personal/personal-lock.ts` 共用):
 * 存储核的生命周期控制块在装配时把屏障挂到真实句柄上,此后**句柄自己的 `release()`** 也先等屏障(等在途事务、置 closing),
 * 屏障拒绝(如事务回调内释放)则 `release()` 拒绝且不释放锁。
 * 向后兼容:没挂屏障时 `release()` 行为不变;同一句柄只能挂**同一个**屏障(换一个 = 编程错误 `internal`,不静默覆盖)。
 */
import { RsiLockError } from './lock-error.js';

export interface ReleaseGate {
  /** 句柄 `release()` 真正动手前调用;拒绝 = 本次释放被拒(锁保持) */
  beforeRelease(): Promise<void>;
}

export interface ReleaseGateSlot {
  attach(gate: ReleaseGate): void;
  /** 释放路径调用:无屏障 = 立即返回 */
  wait(): Promise<void>;
}

export function createReleaseGateSlot(): ReleaseGateSlot {
  let current: ReleaseGate | undefined;
  return {
    attach(gate) {
      if (current !== undefined && current !== gate) throw new RsiLockError('internal');
      current = gate;
    },
    async wait() {
      if (current !== undefined) await current.beforeRelease();
    },
  };
}
