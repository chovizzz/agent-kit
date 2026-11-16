/**
 * §21 V1 装配块 C1a——**对 B1a / 锁层的唯一适配点**:从两把真实句柄取 nonce / 身份,并做个人锁的试锁分类。
 *
 * 本文件是 C1a 里**仅有的**依赖锁句柄具体类型的地方(`RsiLockHandle` / `PersonalLockHandle` 两个类型 + `RsiLockError`)。
 * 它只用句柄上早于 B1a 就存在的成员(`nonce`、`assertHeld`、`release`),**不 import `src/rsi/store/**`**(包括 B1a 的 `LockControl` / `LockCap`):
 * 本块的授权绑定的是「锁文件 nonce」(盘上可验的 acquisition 身份),与存储核事务互斥的控制块无关。B1a 之后若锁句柄形状变化,只改本文件。
 *
 * 试锁结果是判别联合:`busy` / `fault` 分支**不带个人锁句柄**——这是「rsi-only 轮次造不出 `BothRound` / `GrowthPass`」的类型根据之一(见 `round.ts`)。
 */
import { randomBytes } from 'node:crypto';
import { RsiLockError } from '../../lock-error.js';
import type { RsiLockHandle } from '../../lock.js';
import type { PersonalLockHandle } from '../personal-lock.js';
import { PersonalLockLost, isRsiLockLost, type PersonalFault } from './errors.js';

/** 一把已持有的锁在本块里需要的全部能力:盘上 nonce + 提交点前复核 */
export interface HeldLock {
  readonly nonce: string;
  assertHeld(): Promise<void>;
}
/** rsi 锁:真实 `RsiLockHandle` 可直接赋给它(类型测试钉住) */
export type HeldRsi = HeldLock & Pick<RsiLockHandle, 'nonce' | 'assertHeld'>;
/**
 * 个人锁:**包装后**的句柄(`wrapPersonalLock`)。`kind: 'personal'` 是名义标记,所以 rsi 句柄不能冒充个人句柄;
 * `assertHeld` 的 `lock_lost` 已转型为 `PersonalLockLost`(非 `RsiLockError`)。
 */
export interface HeldPersonal extends HeldLock {
  readonly kind: 'personal';
  release(): Promise<void>;
}

/** 个人锁句柄包装(个人写端口在构造时就收被包装的句柄,适配器内抛出的 `lock_lost` 也已转型) */
export function wrapPersonalLock(
  raw: Pick<PersonalLockHandle, 'nonce' | 'assertHeld' | 'release'>,
): HeldPersonal {
  return Object.freeze({
    kind: 'personal' as const,
    nonce: raw.nonce,
    async assertHeld(): Promise<void> {
      try {
        await raw.assertHeld();
      } catch (e) {
        if (isRsiLockLost(e)) throw new PersonalLockLost();
        throw e;
      }
    },
    release: (): Promise<void> => raw.release(),
  });
}

declare const attemptBrand: unique symbol;
/** 个人锁试锁结果。只能由 `attemptPersonal` 产生(`openRound` 运行期校验) */
export type PersonalAttempt = { readonly [attemptBrand]: true } & (
  | { readonly kind: 'held'; readonly personal: HeldPersonal }
  /** 持有者存活(`locked` / `locked_over_ttl`):没有个人锁句柄,S1 / 压缩 / S2P 跳过,verdict = `personal_busy` */
  | { readonly kind: 'busy' }
  /** 其它一切(目录不安全、写出口拒绝、I/O、非 `RsiLockError`……):拒绝增影响,verdict = `personal_fault` */
  | { readonly kind: 'fault'; readonly fault: PersonalFault }
);

const produced = new WeakSet<object>();
export const isProducedAttempt = (a: unknown): boolean =>
  typeof a === 'object' && a !== null && produced.has(a);

function make<T extends object>(v: T): PersonalAttempt {
  const o = Object.freeze(v);
  produced.add(o);
  return o as unknown as PersonalAttempt;
}

/**
 * 试锁并分类(C v1 §2:「锁忙」只认 `locked` / `locked_over_ttl`,其余 `RsiLockError` 一律是故障 `personal_lock_error:<kind>`,拒绝增影响,不算跳过)。
 * 永不抛。`acquire` 由 C2 装配(`acquirePersonalLock`);本块不取锁。
 */
export async function attemptPersonal(
  acquire: () => Promise<PersonalLockHandle>,
): Promise<PersonalAttempt> {
  try {
    const raw = await acquire();
    return make({ kind: 'held', personal: wrapPersonalLock(raw) });
  } catch (e) {
    if (e instanceof RsiLockError) {
      if (e.kind === 'locked' || e.kind === 'locked_over_ttl') return make({ kind: 'busy' });
      return make({ kind: 'fault', fault: { code: `personal_lock_error:${e.kind}` } });
    }
    return make({ kind: 'fault', fault: { code: 'personal_lock_error:internal' } });
  }
}

export const newRoundId = (): string => randomBytes(8).toString('hex');
