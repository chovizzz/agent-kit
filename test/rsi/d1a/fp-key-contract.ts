/**
 * `FpKeyPort` 契约套件(假件与真实现**同跑**)。假件与真件遵守同一份契约,包括错误语义(无效 key 不覆盖、失锁先于任何写)。
 * 套件只用端口的公开行为:`corrupt()` 由各自的夹具把世界置为「key 存在但无效」。
 */
import { describe, expect, it } from 'vitest';
import { FpKeyInvalidError } from '../../../src/rsi/personal/fp/fp-key.js';
import type { FpKeyPort, FpKeyRead } from '../../../src/rsi/personal/fp/fp-ports.js';
import type { LockCap } from '../../../src/rsi/store/ports.js';
import { TEST_KEY, errText, leaks, leaksValue } from './d1a-fixture.js';

export interface FpKeyHarness {
  port: FpKeyPort;
  /** 持有锁的能力(`assertHeld` 通过) */
  held: { rsi: LockCap };
  /** 把世界置为「fp.key 存在但无效」(长度错) */
  corrupt(): Promise<void>;
  /** 读磁盘 / 内存里的原始字节(用于「没有被覆盖」的断言) */
  raw(): Promise<Uint8Array | null>;
  cleanup?(): Promise<void>;
}

export const heldOk = (): { rsi: LockCap } => ({
  rsi: { assertHeld: async () => undefined, release: async () => undefined },
});

export class LockLostForTest extends Error {
  constructor() {
    super('lock_lost_for_test');
  }
}
export const heldLost = (): { rsi: LockCap } => ({
  rsi: {
    assertHeld: async () => {
      throw new LockLostForTest();
    },
    release: async () => undefined,
  },
});

export function runFpKeyContract(name: string, make: () => Promise<FpKeyHarness>): void {
  describe(`FpKeyPort 契约:${name}`, () => {
    const withH = async (fn: (h: FpKeyHarness) => Promise<void>): Promise<void> => {
      const h = await make();
      try {
        await fn(h);
      } finally {
        await h.cleanup?.();
      }
    };
    const okKey = (r: FpKeyRead): Uint8Array => {
      expect(r.kind).toBe('ok');
      return (r as Extract<FpKeyRead, { kind: 'ok' }>).key;
    };

    it('空世界:read = absent;ensure 首建 = created,之后 read = ok 且恰好 32 字节;再 ensure = exists 且 key 不变', () =>
      withH(async (h) => {
        expect(await h.port.read()).toEqual({ kind: 'absent' });
        expect(await h.port.ensure(h.held)).toBe('created');
        const k1 = okKey(await h.port.read());
        expect(k1.length).toBe(32);
        expect(await h.port.ensure(h.held)).toBe('exists');
        expect(Array.from(okKey(await h.port.read()))).toEqual(Array.from(k1));
      }));

    it('read 返回独立副本:改写返回的 key 不影响后续读(正向对照:不改写时两次读相等)', () =>
      withH(async (h) => {
        await h.port.ensure(h.held);
        const a = okKey(await h.port.read());
        const snapshot = Array.from(a);
        a.fill(0);
        const b = okKey(await h.port.read());
        expect(Array.from(b)).toEqual(snapshot);
        expect(Array.from(b)).not.toEqual(Array.from(a));
      }));

    it('失锁先于任何写:ensure 的 assertHeld 抛错 → 原样抛出,世界仍是 absent;换成有锁则首建成功(正向对照)', () =>
      withH(async (h) => {
        await expect(h.port.ensure(heldLost())).rejects.toBeInstanceOf(LockLostForTest);
        expect(await h.port.read()).toEqual({ kind: 'absent' });
        expect(await h.raw()).toBeNull();
        expect(await h.port.ensure(h.held)).toBe('created');
      }));

    it('key 存在但无效:read = invalid;ensure 抛 FpKeyInvalidError 且不覆盖(原始字节不变)', () =>
      withH(async (h) => {
        await h.corrupt();
        const before = await h.raw();
        expect(before).not.toBeNull();
        expect(await h.port.read()).toEqual({ kind: 'invalid' });
        await expect(h.port.ensure(h.held)).rejects.toBeInstanceOf(FpKeyInvalidError);
        expect(await h.port.read()).toEqual({ kind: 'invalid' });
        expect(Array.from((await h.raw()) as Uint8Array)).toEqual(Array.from(before as Uint8Array));
      }));

    it('两个独立世界首建的 key 不同(随机);错误与结果文本都不含 key', () =>
      withH(async (h1) =>
        withH(async (h2) => {
          await h1.port.ensure(h1.held);
          await h2.port.ensure(h2.held);
          const k1 = okKey(await h1.port.read());
          const k2 = okKey(await h2.port.read());
          expect(Array.from(k1)).not.toEqual(Array.from(k2));
          // 无效世界的错误不含 key
          await h1.corrupt();
          let t = '';
          try {
            await h1.port.ensure(h1.held);
          } catch (e) {
            t = errText(e);
          }
          expect(t).toBe(
            'Error|RSI_FP_KEY_INVALID|fp.key exists but is invalid; refusing to overwrite',
          );
          expect(leaks(t)).toBe(false);
          expect(leaksValue(await h1.port.read())).toBe(false);
          // 正向对照:检查本身有效(测试密钥的字节展开能被识别)
          expect(leaksValue({ kind: 'ok', key: TEST_KEY })).toBe(true);
        }),
      ));
  });
}
