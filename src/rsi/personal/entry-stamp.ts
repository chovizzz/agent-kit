/**
 * 转移条目事件时刻的**唯一取点**(设计稿 v3 §C.2;§21.24 W0-26 第 9 条;架构测试 `entry_time_only_via_stamp` B2 档:
 * `candidate-apply.ts` 与 `src/rsi/auto/write/` 里不得直接调用 `d.now()` / `new Date()`,取时只经本文件)。
 *
 * 两种取法:
 *  - **封存区域**(`EntrySeal`):`applyEvent` 在持 personal 锁时开区域(读水位线 W 一次),**取值之后**校验 `utcDay(at) > W`,
 *    否则 `sealed_interval`(**源提交之前**拒绝,零写入);区域覆盖到本次落地(审计 / 效果)结束,由 `applyEvent` 在 `finally` 里关闭;
 *  - **无封存**({@link unsealedEntryTime}):只给没有 `.state` 访问权的缩减入口(`rsi auto clear`:只持 personal → sync 锁,R21-9.5 不访问仓库 `.state`)
 *    与既有单测;**生产命令装配必须给 `seal`**(`test/rsi/asm/b-routing.test.ts` 逐个入口断言)。缩减入口因此**不受 W 校验**——见交付汇报「问题」。
 *
 * 本文件**不得在运行时 import 存储核**(`src/rsi/store/**`、`contracts/rsi-store.ts`):`candidate-apply.ts` 在 worker / `candidate-step.ts` 的闭包里,
 * 它们的运行时闭包不得含存储核(`test/rsi/store/inert.test.ts`)。区域形状用结构类型,错误识别用 `code` 字段。
 */

/** 封存区域的结构类型(`store/ports.ts` 的 `SealRegion` 的子集) */
export interface StampRegion {
  /** 先于 `now()` 已读好 W;取值后校验 `utcDay(at) > W`,否则抛 `code = 'sealed_interval'` 的错误;每个区域只取一次时 */
  stampFirst(now: () => Date): string;
  /** 源(私有仓库)提交成功后调用 */
  markSourceCommitted(): void;
  /** 释放(幂等) */
  close(): void;
}

/** 区域的开启端口(生产 = 存储核的 `SealGuard` 绑定到本次持有的 personal 锁) */
export interface EntrySeal {
  open(): Promise<StampRegion>;
}

/** 无封存的取时:本文件是 B2 档架构测试里**唯一**允许直接调用时钟的位置之一(另一个是 `SealRegion.stampFirst` 自己) */
export function unsealedEntryTime(now: () => Date): string {
  return now().toISOString();
}

/** 封存拒绝(`StoreError` / `AuditSealedError` 的 `code`;按字段识别,不 import 错误类) */
export function isSealedInterval(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { name?: unknown }).name === 'AuditSealedError' &&
    (e as { code?: unknown }).code === 'sealed_interval'
  );
}
