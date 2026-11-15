/**
 * `SealGuard` 区域注册表与 `stampFirst`(设计稿 v3 §C.2;§21.24 W0-26 第 9 条)。
 *
 * 区域状态机 `open → stamped → source_committed → audit_attempted → closed`:区域**覆盖到首次审计追加尝试结束**(追加器在 `first` 来源的尝试结束后自动 `close`),
 * 期间 `Compactor` 一律 `region_open`(`SealRegistry.assertNoOpenRegion`,B1b 消费);`closed` 后再用该区域追加 = `region_closed`。区域在进程内(崩溃即消失;
 * 崩溃后源条目已提交而审计未落的收敛靠派生扫描的 `replay`,不属于本模块)。
 * `stampFirst(now)`:W 在 `open` 时已读好,**先于**调用 `now()`;取值后校验 `utcDay(at) > W`,否则 `sealed_interval`;校验通过后不再重读 W。
 * 函数形式本身不是安全依据(`() => captured` 仍可传入),安全由「取值后校验」与「区域互斥」保证。每个区域只取一次时(同一次转移的多个条目共用一个 stamp)。
 */
import type { IsoTimestamp } from '../../contracts/common.js';
import { utcDay, type UtcDay } from '../../contracts/rsi-store.js';
import { AuditSealedError, StoreError } from './errors.js';
import type { SealGuard, SealRegion, SealRegionState, Watermark } from './ports.js';

export class SealRegistry {
  private readonly regions = new Set<RegionImpl>();
  private compacting = false;
  /** 压缩租约的获取 / 释放各加一:`SealGuard.open` 用它识别「读水位线期间发生过一次完整压缩」(ABA) */
  private epochN = 0;
  /**
   * 压缩租约(B1b):`Compactor.compact` 在整个运行期间持有。**已有未 close 的区域 → 抛 `region_open`**;租约期间 `SealGuard.open` 也拒绝(`region_open`),
   * 否则「检查之后、P2 rename 之前」才打开的区域仍持旧 W,它的首次创建事件可能落进新 W 之下而 P1 没数到(破坏 I6)。
   * 同一时刻只允许一个压缩:已有租约 = 返回 `'busy'`(调用方转成 `compact_blocked` 返回值,不抛)。
   */
  acquireCompactionLease(): (() => void) | 'busy' {
    this.assertNoOpenRegion();
    if (this.compacting) return 'busy';
    this.compacting = true;
    this.epochN += 1;
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      this.compacting = false;
      this.epochN += 1;
    };
  }
  isCompacting(): boolean {
    return this.compacting;
  }
  epoch(): number {
    return this.epochN;
  }
  hasOpenRegion(): boolean {
    return this.regions.size > 0;
  }
  /** `Compactor.compact` 入口调用:存在未 close 的区域 → `region_open` */
  assertNoOpenRegion(): void {
    if (this.regions.size > 0) throw new StoreError('region_open');
  }
  /** @internal 仅本文件的 `RegionImpl` 使用 */
  track(r: RegionImpl): void {
    this.regions.add(r);
  }
  /** @internal */
  untrack(r: RegionImpl): void {
    this.regions.delete(r);
  }
}

class RegionImpl implements SealRegion {
  private current: SealRegionState = 'open';
  private stamp: IsoTimestamp | null = null;
  constructor(
    readonly watermark: UtcDay | null,
    private readonly registry: SealRegistry,
  ) {
    registry.track(this);
  }
  get state(): SealRegionState {
    return this.current;
  }
  stampFirst(now: () => Date): IsoTimestamp {
    if (this.current === 'closed') throw new AuditSealedError('region_closed', 'stamp');
    if (this.stamp !== null) return this.stamp;
    const d = now();
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
      throw new StoreError('clock_regressed', 'invalid_now');
    }
    const at = d.toISOString();
    if (this.watermark !== null && utcDay(at) <= this.watermark) {
      throw new AuditSealedError('sealed_interval', `stamp:${utcDay(at)}<=${this.watermark}`);
    }
    this.stamp = at;
    this.current = 'stamped';
    return at;
  }
  markSourceCommitted(): void {
    if (this.current !== 'stamped')
      throw new AuditSealedError('region_closed', `source:${this.current}`);
    this.current = 'source_committed';
  }
  /** @internal 追加器:首次审计追加尝试开始 */
  beginAudit(): void {
    if (this.current !== 'stamped' && this.current !== 'source_committed') {
      throw new AuditSealedError('region_closed', `audit:${this.current}`);
    }
    this.current = 'audit_attempted';
  }
  close(): void {
    this.current = 'closed';
    this.registry.untrack(this);
  }
}

/** 追加器对 `first` 来源的入口:区域必须已 stamp 且未关闭(不是本模块创建的区域 = 拒绝) */
export function beginAuditAttempt(region: SealRegion): void {
  if (!(region instanceof RegionImpl))
    throw new AuditSealedError('region_closed', 'foreign_region');
  region.beginAudit();
}

export interface SealGuardDeps {
  registry: SealRegistry;
  /** 读 compaction 文件一次(不受支持 → 抛,不登记区域) */
  readWatermark: () => Promise<Watermark>;
}

export function createSealGuard(deps: SealGuardDeps): SealGuard {
  return {
    async open(held) {
      // 任何 await 之前:记下租约纪元;读水位线期间若发生过一次完整压缩(获取 + 释放),读到的 W 已过期(ABA),不能登记
      const epoch = deps.registry.epoch();
      if (deps.registry.isCompacting()) throw new StoreError('region_open', 'compacting');
      await held.assertHeld();
      const wm = await deps.readWatermark();
      // 登记前同步复核(中间没有 await):正在压缩,或读取期间纪元变过 = 拒绝
      if (deps.registry.isCompacting()) throw new StoreError('region_open', 'compacting');
      if (deps.registry.epoch() !== epoch) {
        throw new StoreError('region_open', 'compaction_during_open');
      }
      return new RegionImpl(wm.through, deps.registry);
    },
  };
}
