/**
 * cursor 指纹(R20-6.9;B4-0 冻结签名,B4b 实现):`sha256(canonicalJson({kitVersion, policy, overlayRedactionSha256, saltFp}))`(D9-A:完整 `KIT_VERSION`)。
 * `currentCursorFingerprint` 给 `rsi status` 的 `fingerprint_match`:盐不存在(或读不到)→ `null`。
 */
import type { IoContext } from '../../io/paths.js';
import type { RsiConfigOn } from '../config.js';
import type { CursorFingerprintInput } from './types.js';

export function cursorFingerprint(input: CursorFingerprintInput): string {
  void [input];
  throw new Error('not implemented');
}

export async function currentCursorFingerprint(
  io: IoContext,
  config: RsiConfigOn,
): Promise<string | null> {
  void [io, config];
  throw new Error('not implemented');
}
