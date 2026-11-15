/**
 * 近似指纹算法草案 `rsi-near-v1`(设计稿 v4 §4;docs/contracts.md W0-28 条目草案)。**纯函数、确定性、无 I/O**。
 * 只依赖 `node:crypto`(语料工具经 resolve hook 直接加载本文件,所以不得 import 其它运行时模块)。
 *
 * 算法:
 *  1. 规范化:NFKC → `toLowerCase()`;
 *  2. token:显式码点区间内的 CJK 表意 / 假名**每字一个 token**;其余按 `\p{L}\p{N}` 连续段成词;其它字符是分隔符;
 *  3. shingle:相邻 3 个 token,以 `U+001F` 连接(token 里不可能出现);token 不足 3 个 → 空集;
 *  4. 带密钥哈希:`HMAC-SHA256(fp.key, "rsi-near-v1" ‖ 0x00 ‖ shingle)` 取前 4 字节 = 8 位小写十六进制;
 *  5. 被否决内容的 `near_fp` = 全部哈希去重、升序后的**最小 64 个**(bottom-k 草图);
 *  6. 候选侧用**完整**哈希集合;`coverage = |near_fp ∩ 候选集合| / |near_fp|`(不对称),`≥ threshold` 视为命中;`near_fp = []` 只做精确匹配。
 * 它只是启发式防线:抓扩写与前后缀,抓不住改写。阈值是**显式参数**,本文件不读 `NEAR_ALGO.threshold`。
 * 待 W0-28 冻结:阈值;`\p{L}\p{N}` 与 NFKC 依赖运行时 Unicode 版本(跨 Node 版本的一致性须在冻结时钉住或改为显式表)。
 */
import { createHmac } from 'node:crypto';
import type { NearAlgo, NearFpProducer } from './fp-ports.js';

export const NEAR_VERSION = 'rsi-near-v1';
export const NEAR_SHINGLE_TOKENS = 3;
export const NEAR_SKETCH_SIZE = 64;
/** 输入上限(码元数):超过即抛 {@link NearFpInputError}(fail-closed,避免无界计算) */
export const NEAR_MAX_INPUT_CHARS = 262_144;
const NEAR_DOMAIN = `${NEAR_VERSION}\u0000`;
const SHINGLE_JOIN = '\u001f';
const KEY_BYTES = 32;

/** 草案常量:`frozen = false`;`threshold = 0.5` 只是草案值,由 D3-nf 依语料实测后冻结 */
export const NEAR_ALGO: NearAlgo = Object.freeze({
  version: NEAR_VERSION,
  frozen: false,
  threshold: 0.5,
});

export class NearFpKeyError extends Error {
  readonly code = 'RSI_NEAR_KEY';
  constructor() {
    super('near_fp key must be exactly 32 bytes');
  }
}
export class NearFpInputError extends Error {
  readonly code = 'RSI_NEAR_INPUT';
  constructor(why: 'too_long' | 'not_string') {
    super(`near_fp input rejected: ${why}`);
  }
}

const isCjk = (cp: number): boolean =>
  (cp >= 0x3040 && cp <= 0x30ff) ||
  (cp >= 0x3400 && cp <= 0x4dbf) ||
  (cp >= 0x4e00 && cp <= 0x9fff) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0x20000 && cp <= 0x2ffff);
const WORD_CHAR = /^[\p{L}\p{N}]$/u;

export function nearTokens(text: string): string[] {
  if (typeof text !== 'string') throw new NearFpInputError('not_string');
  if (text.length > NEAR_MAX_INPUT_CHARS) throw new NearFpInputError('too_long');
  const out: string[] = [];
  let cur = '';
  for (const ch of text.normalize('NFKC').toLowerCase()) {
    const cp = ch.codePointAt(0) as number;
    if (isCjk(cp)) {
      if (cur !== '') {
        out.push(cur);
        cur = '';
      }
      out.push(ch);
    } else if (WORD_CHAR.test(ch)) {
      cur += ch;
    } else if (cur !== '') {
      out.push(cur);
      cur = '';
    }
  }
  if (cur !== '') out.push(cur);
  return out;
}

/** 全部 3-token shingle(去重,首次出现序) */
export function nearShingles(text: string): string[] {
  const t = nearTokens(text);
  const seen = new Set<string>();
  for (let i = 0; i + NEAR_SHINGLE_TOKENS <= t.length; i++) {
    seen.add(t.slice(i, i + NEAR_SHINGLE_TOKENS).join(SHINGLE_JOIN));
  }
  return [...seen];
}

const copyKey = (key: Uint8Array): Uint8Array => {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) throw new NearFpKeyError();
  return Uint8Array.from(key);
};

/** 单个 shingle 的 8 位哈希(黄金值用例直接钉它) */
export function nearHash8(key: Uint8Array, shingle: string): string {
  return createHmac('sha256', copyKey(key))
    .update(NEAR_DOMAIN, 'utf8')
    .update(shingle, 'utf8')
    .digest()
    .subarray(0, 4)
    .toString('hex');
}

/** 候选侧:完整哈希集合(不截断) */
export function nearHashSet(key: Uint8Array, text: string): Set<string> {
  const k = copyKey(key);
  return new Set(nearShingles(text).map((s) => nearHash8(k, s)));
}

/** 被否决内容侧:最小 64 个哈希(升序;不足 3 个 token → `[]`) */
export function nearSketch(key: Uint8Array, text: string): string[] {
  return [...nearHashSet(key, text)].sort().slice(0, NEAR_SKETCH_SIZE);
}

export function makeNearFpProducer(key: Uint8Array): NearFpProducer {
  const k = copyKey(key);
  return Object.freeze({ compute: (text: string): readonly string[] => nearSketch(k, text) });
}

export interface NearHasher {
  hashes(text: string): ReadonlySet<string>;
}
export function makeNearHasher(key: Uint8Array): NearHasher {
  const k = copyKey(key);
  return Object.freeze({ hashes: (text: string): ReadonlySet<string> => nearHashSet(k, text) });
}

/** `|near ∩ cand| / |near|`;`near` 为空 → `null`(无近似信息,只能精确匹配) */
export function nearCoverage(near: readonly string[], cand: ReadonlySet<string>): number | null {
  if (near.length === 0) return null;
  let hit = 0;
  for (const h of near) if (cand.has(h)) hit++;
  return hit / near.length;
}

/** 阈值必须是 (0, 1] 内的有限数;0 / NaN / 超界会让任何候选被命中或永不命中,一律拒绝 */
export function assertNearThreshold(t: unknown): asserts t is number {
  if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0 || t > 1) {
    throw new RangeError('near_fp threshold must be a finite number in (0, 1]');
  }
}

/** 命中判定:`near = []` 恒 false(只做精确匹配);其余 `coverage ≥ threshold` */
export function nearMatches(
  near: readonly string[],
  cand: ReadonlySet<string>,
  threshold: number,
): boolean {
  assertNearThreshold(threshold);
  const c = nearCoverage(near, cand);
  return c !== null && c >= threshold;
}
