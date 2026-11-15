/**
 * §21 装配块 D1a 端口批 a(a1 / a2):**只有类型与常量,无 I/O,不引用任何 C 段类型**(设计稿 v4 §7)。
 *  - {@link FpKeyPort}:`.state/rsi/fp.key`(0600、32 字节、首建 `createExclusive`,R21-11.2)的读取与首建;
 *  - {@link NearFpProducer}:近似指纹产生方(≤ 64 项 Hex(8);`[]` = 只做精确匹配,`exact_only`);
 *  - {@link NearFpCapability}:近似指纹能力四态(判定函数见 `near-capability.ts`)。
 * 密钥材料只经 `FpKeyPort.read()` 的 `ok` 分支出去;其余分支、错误与日志都不得带密钥内容。
 */
import type { LockCap } from '../../store/ports.js';

export type FpKeyRead =
  /** `key` 恒为 32 字节;每次调用返回独立副本(调用方改写不影响端口内部) */
  | { kind: 'ok'; key: Uint8Array }
  | { kind: 'absent' }
  /** 长度 ≠ 32 / 权限宽于 0600 / 链接 / 非普通文件 / 属主不符 / 读失败 */
  | { kind: 'invalid' };

export interface FpKeyPort {
  read(): Promise<FpKeyRead>;
  /** 持 `rsi/lock` 时首建。已存在且有效 → `'exists'`;**已存在但无效 → 抛错,绝不覆盖重建**(重建会使账里全部 `fp_hmac` 失效) */
  ensure(held: { rsi: LockCap }): Promise<'created' | 'exists'>;
}

export interface NearFpProducer {
  /** ≤ 64 项 Hex(8),升序、去重;`[]` = 文本不足 3 个 token(`exact_only`) */
  compute(text: string): readonly string[];
}

export type NearFpCapability = 'unwired' | 'key_unavailable' | 'algo_unfrozen' | 'ready';

/** 近似指纹算法常量(版本串 / 冻结位 / 匹配阈值)。`threshold` 在语料实测前是**草案值**,`frozen === false` 时能力恒不是 `ready` */
export interface NearAlgo {
  readonly version: string;
  readonly frozen: boolean;
  readonly threshold: number;
}
