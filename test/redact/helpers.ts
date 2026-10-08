import { createRedactor } from '../../src/redact/redactor.js';
import type { RedactorImpl, RedactorInput, RedactorOptions } from '../../src/redact/redactor.js';

/**
 * 测试里的"假秘密"一律由片段在运行时拼装(repeat / join),源码里不出现完整字面量,
 * 否则本目录自己就会被 A10 的全量扫描命中。
 */
export const rep = (sample: string, n: number): string =>
  sample.repeat(Math.ceil(n / sample.length)).slice(0, n);

export const dotted = (...parts: Array<string | number>): string => parts.join('.');
export const mail = (local: string, domain: string): string => `${local}@${domain}`;
export const url = (scheme: string, rest: string): string => `${scheme}://${rest}`;

export const fakeSk = (n = 22): string => `sk-${rep('a1', n)}`;
export const placeholder = (type: string): string => `[[REDACTED:${type}]]`;

export function newRedactor(input: RedactorInput = {}, opts: RedactorOptions = {}): RedactorImpl {
  return createRedactor({ timeout_ms: 5000, ...input }, opts);
}

/** 确定性 PRNG,测试里需要"随机"文本时用。 */
export function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomString(rand: () => number, alphabet: string, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
  return s;
}

export const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
