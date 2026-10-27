/**
 * cursor 指纹(R20-6.9;B4-0 冻结签名,B4b 实现):`sha256(canonicalJson({kitVersion, policy, overlayRedactionSha256, saltFp}))`(D9-A:完整 `KIT_VERSION`,
 * 采集器 / reader / 脱敏规则版本都随它走;policy 含 agents、排除哈希、kit 主版本)。
 * `overlayRedactionSha256` = overlay 里与脱敏有关字段(`sensitive_words`、`internal_domains`,各自排序去重)的 canonical JSON 的 sha256;没有 overlay = null。
 * `currentCursorFingerprint` 给 `rsi status` 的 `fingerprint_match`:盐不存在 / 读不到 / overlay 不可用 → `null`(不比较)。只读,不建盐。
 */
import { createHash } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import { OverlaySchema } from '../../contracts/config.js';
import { KIT_VERSION } from '../../contracts/meta.js';
import { canonicalJson } from '../../io/canonical-json.js';
import type { IoContext } from '../../io/paths.js';
import { readFileSafe } from '../../io/read-fs.js';
import { readSaltFile } from '../../signals/salt-read.js';
import { RSI_OVERLAY_MAX_BYTES, buildRsiPolicy, type RsiConfigOn } from '../config.js';
import type { CursorFingerprintInput } from './types.js';

const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

export function cursorFingerprint(input: CursorFingerprintInput): string {
  return sha256Hex(
    canonicalJson({
      kitVersion: input.kitVersion,
      policy: input.policy,
      overlayRedactionSha256: input.overlayRedactionSha256,
      saltFp: input.saltFp,
    }),
  );
}

const sortedUnique = (a: readonly string[] | undefined): string[] => [...new Set(a ?? [])].sort();

/** overlay 的脱敏相关字段哈希;读不到 / 不合规 → `undefined`(调用方按「不可比」处理) */
export async function overlayRedactionSha256Of(
  overlayPath: string | null,
): Promise<string | null | undefined> {
  if (overlayPath === null) return null;
  try {
    const r = await readFileSafe(overlayPath, { maxBytes: RSI_OVERLAY_MAX_BYTES });
    if (r.kind !== 'ok') return undefined;
    const parsed = OverlaySchema.safeParse(parseToml(r.bytes.toString('utf8')));
    if (!parsed.success) return undefined;
    return sha256Hex(
      canonicalJson({
        internal_domains: sortedUnique(parsed.data.internal_domains),
        sensitive_words: sortedUnique(parsed.data.sensitive_words),
      }),
    );
  } catch {
    return undefined;
  }
}

export async function currentCursorFingerprint(
  io: IoContext,
  config: RsiConfigOn,
): Promise<string | null> {
  let salt;
  try {
    salt = await readSaltFile(io.stateDir);
  } catch {
    return null;
  }
  if (salt.kind !== 'ok') return null;
  if (config.overlayPath !== null && config.overlaySha256 === null) return null;
  const ov = await overlayRedactionSha256Of(config.overlayPath);
  if (ov === undefined) return null;
  return cursorFingerprint({
    kitVersion: KIT_VERSION,
    policy: await buildRsiPolicy(config),
    overlayRedactionSha256: ov,
    saltFp: salt.saltFp,
  });
}
