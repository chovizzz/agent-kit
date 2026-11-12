/**
 * 锁序守卫的进程内登记(docs/contracts.md R21-3.3、§21.24 W0-15「交给后续块」)。全局锁序 `rsi/lock` → `personal/lock` → sync 锁,不可反转:
 * 本进程已持有 `personal/lock` 时再取 `rsi/lock` = 编程错误(`acquireRsiLock` 抛 `RsiLockError('internal')`,与槽位锁 `digests/lock` 的反向守卫同口径)。
 * 单独成文件,是为了 `lock.ts`(仓库锁)与 `personal/personal-lock.ts`(HOME 锁)互不 import:二者都只依赖这里。
 */
const heldPersonalLocks = new Set<string>();

export function markPersonalLockHeld(file: string): void {
  heldPersonalLocks.add(file);
}
export function unmarkPersonalLockHeld(file: string): void {
  heldPersonalLocks.delete(file);
}
/** 本进程是否持有任一把 `personal/lock` */
export function personalLockHeldInProcess(): boolean {
  return heldPersonalLocks.size > 0;
}
