/**
 * 解码层:秘密被编码后再放进文本时,先解码再扫。
 *  - base64 / base64url 段(>=20 字符;压缩视图上能跨行拼起来)
 *  - 纯 hex 段(>=24 个十六进制字符,解码后必须是可打印文本)
 *  - 转义序列(%XX、\uXXXX、\xXX、数字实体、几个常用命名实体):就地解码成新视图,
 *    所以口令里只有个别字符(例如 @)被编码的混合形态也能还原。
 *
 * 解码结果只有"像文本"(>=90% 可打印,无大量替换字符)才继续扫,二进制垃圾直接丢。
 */
import type { View } from './view.js';

export const MAX_SEGMENT = 16384;
export const MAX_CANDIDATES = 4096;

const BASE64_RUN = /[A-Za-z0-9+/_-]{20,}={0,2}/g;
const HEX_RUN = /(?:[0-9a-fA-F]{2}){12,}/g;

export interface Candidate {
  start: number;
  end: number;
  text: string;
}

function texty(buf: Buffer): string | null {
  if (buf.length < 6) return null;
  const s = buf.toString('utf8');
  let bad = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0xfffd || c < 9 || (c > 13 && c < 32) || c === 127) bad++;
  }
  return bad / s.length <= 0.1 ? s : null;
}

/** base64 / base64url 候选。四个起始偏移都试一次:前面多出的字符会让 4 字符对齐错位。 */
export function base64Candidates(text: string, tick: () => void): Candidate[] {
  const out: Candidate[] = [];
  if (text.length < 20) return out;
  for (const m of text.matchAll(BASE64_RUN)) {
    tick();
    const run = m[0];
    if (run.length > MAX_SEGMENT) continue;
    const idx = m.index as number;
    for (let k = 0; k < 4; k++) {
      const piece = run.slice(k);
      if (piece.length < 12) break;
      const decoded = texty(Buffer.from(piece, 'base64'));
      if (decoded !== null) {
        out.push({ start: idx, end: idx + run.length, text: decoded });
        break;
      }
    }
    if (out.length > MAX_CANDIDATES) break;
  }
  return out;
}

const BASE32_RUN = /[A-Z2-7]{32,}={0,6}|[a-z2-7]{32,}={0,6}/g;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(s: string): Buffer {
  const out: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of s.toUpperCase()) {
    const v = B32.indexOf(ch);
    if (v < 0) break;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
      acc &= (1 << bits) - 1;
    }
  }
  return Buffer.from(out);
}

export function base32Candidates(text: string, tick: () => void): Candidate[] {
  const out: Candidate[] = [];
  if (text.length < 32) return out;
  for (const m of text.matchAll(BASE32_RUN)) {
    tick();
    const run = m[0];
    if (run.length > MAX_SEGMENT) continue;
    const decoded = texty(decodeBase32(run));
    if (decoded !== null) {
      const idx = m.index as number;
      out.push({ start: idx, end: idx + run.length, text: decoded });
    }
    if (out.length > MAX_CANDIDATES) break;
  }
  return out;
}

export function hexCandidates(text: string, tick: () => void): Candidate[] {
  const out: Candidate[] = [];
  if (text.length < 24) return out;
  for (const m of text.matchAll(HEX_RUN)) {
    tick();
    const run = m[0];
    if (run.length > MAX_SEGMENT) continue;
    const decoded = texty(Buffer.from(run, 'hex'));
    if (decoded !== null) {
      const idx = m.index as number;
      out.push({ start: idx, end: idx + run.length, text: decoded });
    }
    if (out.length > MAX_CANDIDATES) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 转义序列 -> 新视图
// ---------------------------------------------------------------------------

const ESCAPE_TOKEN =
  /(?:%[0-9a-fA-F]{2})+|\\u\{[0-9a-fA-F]{1,6}\}|\\[0-7]{3}|\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2}|&#[xX][0-9a-fA-F]{1,6};|&#\d{1,7};|&(?:colon|commat|sol|bsol|period|lowbar|hyphen|dash|plus|equals|excl|quest|num|lpar|rpar|lsqb|rsqb|lbrack|rbrack|comma|semi|percnt|ast|vert|tilde|grave|apos|quot|amp|lt|gt|nbsp);/g;

const NAMED: Readonly<Record<string, string>> = {
  colon: ':',
  commat: '@',
  sol: '/',
  bsol: '\\',
  period: '.',
  lowbar: '_',
  hyphen: '-',
  dash: '-',
  plus: '+',
  equals: '=',
  excl: '!',
  quest: '?',
  num: '#',
  lpar: '(',
  rpar: ')',
  lsqb: '[',
  rsqb: ']',
  lbrack: '[',
  rbrack: ']',
  comma: ',',
  semi: ';',
  percnt: '%',
  ast: '*',
  vert: '|',
  tilde: '~',
  grave: '`',
  apos: "'",
  quot: '"',
  amp: '&',
  lt: '<',
  gt: '>',
  nbsp: ' ',
};

function decodeToken(tok: string): string | null {
  if (tok.startsWith('%')) {
    const hex = tok.replace(/%/g, '');
    const buf = Buffer.from(hex, 'hex');
    const s = buf.toString('utf8');
    // 非法 UTF-8 时退回 latin1,保证 ASCII 字节一定还原
    return s.includes('�') ? buf.toString('latin1') : s;
  }
  if (tok.startsWith('\\u{')) {
    const cp = parseInt(tok.slice(3, -1), 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : null;
  }
  if (tok.startsWith('\\u')) return String.fromCharCode(parseInt(tok.slice(2), 16));
  if (/^\\[0-7]{3}$/.test(tok)) return String.fromCharCode(parseInt(tok.slice(1), 8) & 0xff);
  if (tok.startsWith('\\x')) return String.fromCharCode(parseInt(tok.slice(2), 16));
  if (tok.startsWith('&#x') || tok.startsWith('&#X')) {
    const cp = parseInt(tok.slice(3, -1), 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : null;
  }
  if (tok.startsWith('&#')) {
    const cp = parseInt(tok.slice(2, -1), 10);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : null;
  }
  if (tok.startsWith('&')) return NAMED[tok.slice(1, -1)] ?? null;
  return null;
}

/** 文本里有没有可就地解码的转义序列(廉价预检)。 */
export function hasEscapes(text: string): boolean {
  return /%[0-9a-fA-F]{2}|\\u[0-9a-fA-F{]|\\x[0-9a-fA-F]{2}|\\[0-7]{3}|&#|&[a-z]+;/.test(text);
}

/** 把所有转义序列替换成它们的字面字符;映射指向父视图。无变化返回 null。 */
export function unescapeView(v: View, tick: () => void): View | null {
  const text = v.text;
  const pieces: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let pos = 0;
  let changed = false;
  const parentStart = (i: number): number => (v.starts ? (v.starts[i] as number) : i);
  const parentEnd = (i: number): number => (v.ends ? (v.ends[i] as number) : i + 1);
  const pushPlain = (from: number, to: number): void => {
    if (to <= from) return;
    pieces.push(text.slice(from, to));
    for (let i = from; i < to; i++) {
      starts.push(parentStart(i));
      ends.push(parentEnd(i));
    }
  };
  for (const m of text.matchAll(ESCAPE_TOKEN)) {
    tick();
    const tok = m[0];
    const dec = decodeToken(tok);
    if (dec === null || dec === tok) continue;
    const at = m.index as number;
    pushPlain(pos, at);
    pieces.push(dec);
    const s = parentStart(at);
    const e = parentEnd(at + tok.length - 1);
    for (let k = 0; k < dec.length; k++) {
      starts.push(s);
      ends.push(e);
    }
    pos = at + tok.length;
    changed = true;
  }
  if (!changed) return null;
  pushPlain(pos, text.length);
  return { text: pieces.join(''), starts: Int32Array.from(starts), ends: Int32Array.from(ends) };
}
