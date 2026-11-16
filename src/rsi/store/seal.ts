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
  private domain: symbol | null = null;
  /**
   * 绑定到一次 acquisition(`LockControl.identity`):装配时调用;同一注册表绑给**另一次** acquisition = 拒绝(`lock_cap_mismatch`),
   * 所以别的存储域创建的区域 / 注册表不能被本域追加器接受(评审 M2)。同一 acquisition 重复绑定幂等。
   */
  bindDomain(identity: symbol): void {
    if (this.domain !== null && this.domain !== identity) {
      throw new StoreError('lock_cap_mismatch', 'registry_foreign');
    }
    this.domain = identity;
  }
  /** 无副作用预检:已绑给**另一次** acquisition?(`bindDomain` 会抛的同一条件) */
  isBoundElsewhere(identity: symbol): boolean {
    return this.domain !== null && this.domain !== identity;
  }
  /** @internal */
  owns(r: RegionImpl): boolean {
    return r.registry === this;
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
    readonly registry: SealRegistry,
  ) {
    registry.track(this);
  }
  /** @internal 本区域 stamp 出的事件时刻(未 stamp = null) */
  get stampedAt(): IsoTimestamp | null {
    return this.stamp;
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

/**
 * 追加器对 `first` 来源的入口:区域必须是**本存储域的注册表**创建的(别处创建 / 别的 acquisition 的区域 = `region_closed:foreign_region`,不改任何状态)、
 * 已 stamp 且未关闭;通过后进入 `audit_attempted`,返回区域供 {@link assertLinesStamped} 与收尾 `close()` 使用。
 */
export function beginAuditAttempt(region: SealRegion, registry: SealRegistry): SealRegion {
  if (!(region instanceof RegionImpl) || !registry.owns(region)) {
    throw new AuditSealedError('region_closed', 'foreign_region');
  }
  region.beginAudit();
  return region;
}

/** `first` 的每一行 `at` 必须**逐字等于**本区域 stamp 的时刻(stamp 与实际事件绑定;否则 `stamp_mismatch`,零写入) */
export function assertLinesStamped(region: SealRegion, items: readonly unknown[]): void {
  const stamped = region instanceof RegionImpl ? region.stampedAt : null;
  const atOf = (i: unknown): unknown =>
    typeof i === 'object' && i !== null ? (i as { at?: unknown }).at : undefined;
  if (stamped === null || items.some((i) => atOf(i) !== stamped)) {
    throw new StoreError('stamp_mismatch');
  }
}

export interface SealGuardDeps {
  registry: SealRegistry;
  /** 读 compaction 文件一次(不受支持 → 抛,不登记区域) */
  readWatermark: () => Promise<Watermark>;
}

export function createSealGuard(deps: SealGuardDeps): SealGuard {
  return {
    async open(held) {
      await held.assertHeld();
      const wm = await deps.readWatermark();
      return new RegionImpl(wm.through, deps.registry);
    },
  };
}
