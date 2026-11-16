/**
 * 精确指纹 `fp_hmac`(R21-11.2):`HMAC-SHA256(fp.key, 规范化正文)` 前 16 位小写十六进制。
 * 返回值正是 `candidate-source.ts` 的 `BuildDraftDeps.fingerprint` 需要的同步函数(调用方先 `FpKeyPort.read()` 再构造)。
 * 规范化正文由调用方给(`${do}\n${why}\n${verify}`,同 `buildDraft`);本函数不再变换。
 */
import { createHmac } from 'node:crypto';

export class FpKeyShapeError extends Error {
  readonly code = 'RSI_FP_KEY_SHAPE';
  constructor() {
    super('fp key must be exactly 32 bytes');
  }
}

export function makeFingerprint(key: Uint8Array): (canonicalBody: string) => string {
  if (!(key instanceof Uint8Array) || key.length !== 32) throw new FpKeyShapeError();
  const k = Uint8Array.from(key);
  return (canonicalBody) =>
    createHmac('sha256', k).update(canonicalBody, 'utf8').digest('hex').slice(0, 16);
}
