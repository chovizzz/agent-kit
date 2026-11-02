/**
 * rsi 会话入口(digest / ingest)用的脱敏器(R20-16.11 / R20-16.15 的「当前规则的 pass2」;R20-A4):规则 = 内置种子 + `[rsi] overlay` 的 `sensitive_words` / `internal_domains`。
 * 覆盖层不可用(`block = overlay_invalid`)时由调用方先行拒绝(规则不全就不能放行任何摘录),这里只在覆盖层合规时读它。
 * 只读(readFileSafe),不写任何东西。
 */
import { createHash } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import { OverlaySchema } from '../contracts/config.js';
import type { Redactor } from '../contracts/redact.js';
import { readFileSafe } from '../io/read-fs.js';
import { createRedactor } from '../redact/redactor.js';
import { RSI_OVERLAY_MAX_BYTES, type RsiConfigOn } from './config.js';
import { RsiFailClosedError } from './types.js';

/** 脱敏每遍的时间预算(与 reflect 同值:对整份文本复扫,取 5s,避免负载抖动被当成泄露) */
export const RSI_REDACT_TIMEOUT_MS = 5000;

export async function rsiRedactor(config: RsiConfigOn): Promise<Pick<Redactor, 'pass2'>> {
  try {
    let words: string[] = [];
    let domains: string[] = [];
    if (config.overlayPath !== null) {
      if (config.overlaySha256 === null) throw new RsiFailClosedError('overlay_invalid');
      const r = await readFileSafe(config.overlayPath, {
        maxBytes: RSI_OVERLAY_MAX_BYTES,
        owner: { maxPerm: 0o755 },
      });
      if (r.kind !== 'ok') throw new RsiFailClosedError('overlay_invalid');
      // 复扫规则 = 记入策略指纹的那一份:本次读到的字节必须与配置加载时的 sha256 一致(否则「按 A 授权、按 B 扫描」)
      if (createHash('sha256').update(r.bytes).digest('hex') !== config.overlaySha256) {
        throw new RsiFailClosedError('overlay_invalid');
      }
      const ov = OverlaySchema.parse(parseToml(r.bytes.toString('utf8')));
      words = ov.sensitive_words ?? [];
      domains = ov.internal_domains ?? [];
    }
    return createRedactor(
      { sensitive_words: words, timeout_ms: RSI_REDACT_TIMEOUT_MS },
      { internalDomains: domains },
    );
  } catch (e) {
    if (e instanceof RsiFailClosedError) throw e;
    throw new RsiFailClosedError('redactor_init');
  }
}
