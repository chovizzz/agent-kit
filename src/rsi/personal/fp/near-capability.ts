/**
 * 近似指纹能力四态(设计稿 v4 §4.1)。判定顺序即下表自上而下,**全函数**:
 *  - `unwired`:装配里没有 `NearFpProducer` 的真实现(持有引用:对象且 `compute` 是函数;字符串 / 空值都不算);
 *  - `key_unavailable`:`fp.key` 缺 / 无效 / 读失败;
 *  - `algo_unfrozen`:producer 与 key 都就绪,但 `NEAR_ALGO.frozen !== true`(或冻结位为真而版本串 / 阈值不合法 = `algo_invalid`,同样不放行);
 *  - `ready`:三者全满足。
 * 冻结签名 `nearFpCapability(): NearFpCapability`(同步、无参)读不了 fp.key,故拆成:纯同步判定 {@link decideNearFpCapability}(输入全显式)
 * + 装配工厂 {@link makeNearFpCapability}(先读 key 再判定)。拒绝原因与提相位清单读同一个 `{state, reason}`,不各自补例外。
 * 原因码是固定字面量,不含密钥或异常文本。
 *
 * **操作级快照**(验收评审中 3):同一套判定算法 ≠ 同一次结论——`makeNearFpCapability` 返回的函数每次调用都现读 key,两次调用之间 key 可以变。
 * 所以每个命令 / 提相位检查 / 增影响操作**只取一次** {@link NearFpCapabilitySnapshot}(`makeNearFpCapabilitySource(d).snapshot()`),
 * 把这一个值传给该操作的**所有**消费者(guard 的拒绝原因、提相位清单、近似否决落账 / deferred 判定);消费者只用纯函数
 * {@link nearFpDenial} / {@link nearFpReady} 读快照,**不得**再自行取 verdict 或读 key。快照是冻结的值对象,不是全局缓存:有效范围 = 该次操作,
 * 操作之间不复用;持久写之前由 D2 的写前复核(`requireGrowth`)另行重验,快照不替代它。D2 接线时只经 `NearFpCapabilitySource` 取快照。
 */
import { NEAR_ALGO } from './near-algo.js';
import type { FpKeyPort, NearAlgo, NearFpCapability, NearFpProducer } from './fp-ports.js';

export type NearFpCapabilityReason =
  | 'none'
  | 'producer_unwired'
  | 'key_absent'
  | 'key_invalid'
  | 'key_read_failed'
  | 'algo_unfrozen'
  | 'algo_invalid';

export interface NearFpCapabilityVerdict {
  state: NearFpCapability;
  reason: NearFpCapabilityReason;
}

export type NearKeyState = 'ok' | 'absent' | 'invalid' | 'read_failed';

export interface NearFpCapabilityInput {
  /** 装配里持有的 producer 引用;`unknown` 因为判定要在运行时校验(跨装配边界) */
  producer: unknown;
  key: NearKeyState;
  algo: { readonly version: unknown; readonly frozen: unknown; readonly threshold: unknown };
}

const hasProducer = (p: unknown): boolean =>
  typeof p === 'object' && p !== null && typeof (p as { compute?: unknown }).compute === 'function';

export function decideNearFpCapability(i: NearFpCapabilityInput): NearFpCapabilityVerdict {
  if (!hasProducer(i.producer)) return { state: 'unwired', reason: 'producer_unwired' };
  if (i.key !== 'ok') {
    const reason =
      i.key === 'absent' ? 'key_absent' : i.key === 'invalid' ? 'key_invalid' : 'key_read_failed';
    return { state: 'key_unavailable', reason };
  }
  if (i.algo.frozen !== true) return { state: 'algo_unfrozen', reason: 'algo_unfrozen' };
  const t = i.algo.threshold;
  const v = i.algo.version;
  if (
    typeof v !== 'string' ||
    v === '' ||
    typeof t !== 'number' ||
    !Number.isFinite(t) ||
    t <= 0 ||
    t > 1
  ) {
    return { state: 'algo_unfrozen', reason: 'algo_invalid' };
  }
  return { state: 'ready', reason: 'none' };
}

export interface NearFpCapabilityDeps {
  producer?: NearFpProducer | undefined;
  fpKey?: FpKeyPort | undefined;
  /** 测试缝:缺省 {@link NEAR_ALGO} */
  algo?: NearAlgo | undefined;
}

/** 装配工厂:返回的函数每次调用都现读 key(不缓存),读抛错 → `key_read_failed` */
export function makeNearFpCapability(
  d: NearFpCapabilityDeps,
): () => Promise<NearFpCapabilityVerdict> {
  return async () => {
    let key: NearKeyState = 'absent';
    if (d.fpKey !== undefined) {
      try {
        key = (await d.fpKey.read()).kind;
      } catch {
        key = 'read_failed';
      }
    }
    return decideNearFpCapability({ producer: d.producer, key, algo: d.algo ?? NEAR_ALGO });
  };
}

/** 能力判定的操作级快照:冻结的值对象(`state` / `reason` 只读且不可改写) */
export type NearFpCapabilitySnapshot = Readonly<NearFpCapabilityVerdict>;

/** 能力判定的窄端口:只有「取一次快照」。装配处注入;消费者拿到的是快照,不是这个端口 */
export interface NearFpCapabilitySource {
  snapshot(): Promise<NearFpCapabilitySnapshot>;
}

/** 把一次 verdict 固化为快照(复制并冻结:此后调用方改原对象也不影响快照) */
export function freezeNearFpCapability(v: NearFpCapabilityVerdict): NearFpCapabilitySnapshot {
  return Object.freeze({ state: v.state, reason: v.reason });
}

/** 装配工厂:每次 `snapshot()` 恰好读一次 key(内部只调用一次判定函数),返回冻结快照 */
export function makeNearFpCapabilitySource(d: NearFpCapabilityDeps): NearFpCapabilitySource {
  const decide = makeNearFpCapability(d);
  return { snapshot: async () => freezeNearFpCapability(await decide()) };
}

/** 消费者 1:是否 `ready`(提相位清单用)。只读快照,不读 key */
export const nearFpReady = (s: NearFpCapabilitySnapshot): boolean => s.state === 'ready';

/** 消费者 2:增影响 guard 的拒绝原因(`ready` → `null`)。与 {@link nearFpReady} 对同一快照恒一致;只读快照,不读 key */
export function nearFpDenial(
  s: NearFpCapabilitySnapshot,
): null | { code: 'near_fp_unavailable'; state: NearFpCapability; reason: NearFpCapabilityReason } {
  return s.state === 'ready'
    ? null
    : { code: 'near_fp_unavailable', state: s.state, reason: s.reason };
}
