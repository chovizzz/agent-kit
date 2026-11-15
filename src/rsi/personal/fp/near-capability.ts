/**
 * 近似指纹能力四态(设计稿 v4 §4.1)。判定顺序即下表自上而下,**全函数**:
 *  - `unwired`:装配里没有 `NearFpProducer` 的真实现(持有引用:对象且 `compute` 是函数;字符串 / 空值都不算);
 *  - `key_unavailable`:`fp.key` 缺 / 无效 / 读失败;
 *  - `algo_unfrozen`:producer 与 key 都就绪,但 `NEAR_ALGO.frozen !== true`(或冻结位为真而版本串 / 阈值不合法 = `algo_invalid`,同样不放行);
 *  - `ready`:三者全满足。
 * 冻结签名 `nearFpCapability(): NearFpCapability`(同步、无参)读不了 fp.key,故拆成:纯同步判定 {@link decideNearFpCapability}(输入全显式)
 * + 装配工厂 {@link makeNearFpCapability}(先读 key 再判定)。拒绝原因与提相位清单读同一个 `{state, reason}`,不各自补例外。
 * 原因码是固定字面量,不含密钥或异常文本。
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
