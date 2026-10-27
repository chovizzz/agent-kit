/**
 * 只读 rsi 命令的输出清洗与泄漏闸(R20-3.5.2 / R20-3.5.3 / R20-3.5.6;R20-A2 B3a)。纯函数,不碰文件系统。
 *
 * - {@link cleanName}:目录名清洗:C0 / C1 控制字符、Unicode 格式字符(含 bidi 覆盖与隔离、零宽字符)、私用区与未分配码点、
 *   孤立代理、行 / 段分隔符(U+2028 / U+2029,会让「一行一项」断行)替换为 `?`,按码点边界截到 64 字节。
 * - {@link cleanPath}:同样的替换,不截断。
 * - {@link guardOutput}:泄漏闸。输出由**可信渲染器**以行为单位构造({@link OutLine}):`head` 是不允许出现禁止值的部分,
 *   `pathValue`(只有 `rsi projects --paths` 的 `path=` 字段)是唯一豁免的部分。闸只对 `head` 检查,**不**从最终文本里重新推断字段边界,
 *   所以 `name` 里伪造的 `path=` 得不到豁免。禁止值取原样、清洗后、JSON 转义后及其组合(先清洗再转义、先转义再清洗)的表示。
 */

/** 输出的一行:`head` 之后若有 `pathValue`,整行为 `head + ' path=' + pathValue`(渲染器保证 pathValue 已清洗、不含换行) */
export interface OutLine {
  head: string;
  pathValue?: string;
}

export function renderLine(l: OutLine): string {
  return l.pathValue === undefined ? l.head : `${l.head} path=${l.pathValue}`;
}

const CTRL = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const BAD = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/u;

function replaceBad(s: string): string[] {
  const out: string[] = [];
  // for…of 按码点迭代:孤立代理会作为单个码点出现,被 \p{Cs} 命中
  for (const ch of s) out.push(BAD.test(ch) ? '?' : ch);
  return out;
}

/** 目录名清洗并按码点边界截到 64 字节;空串(如根目录的 basename)显示为 `?` */
export function cleanName(name: string, maxBytes = 64): string {
  let out = '';
  let bytes = 0;
  for (const ch of replaceBad(name)) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > maxBytes) break;
    out += ch;
    bytes += n;
  }
  return out === '' ? '?' : out;
}

/** 路径清洗(不截断) */
export function cleanPath(p: string): string {
  return replaceBad(p).join('');
}

/** 一个禁止值的全部表示(原样、清洗后、JSON 转义后);长度 ≤ 1 的值(如 `/`)不检查,否则一切输出都会命中 */
function forms(value: string): string[] {
  if (value.length <= 1) return [];
  const json = (v: string): string => JSON.stringify(v).slice(1, -1);
  const clean = cleanPath(value);
  // 原样、清洗、JSON 转义,以及它们的组合(先清洗再转义 / 先转义再清洗)
  return [...new Set([value, clean, json(value), json(clean), cleanPath(json(value))])];
}

export interface GuardResult {
  ok: boolean;
}

/** 泄漏闸:任一 `head` 含任一禁止值的任一表示 → `{ ok: false }`(整份作废,由调用方退出 3 `output_leak`) */
export function guardOutput(lines: readonly OutLine[], forbidden: readonly string[]): GuardResult {
  const all = forbidden.flatMap(forms);
  for (const l of lines) {
    // 控制字符(含换行、ESC)与 U+2028 / U+2029 不得出现在行内:既防伪造行,也防终端转义
    if (CTRL.test(l.head) || (l.pathValue !== undefined && CTRL.test(l.pathValue))) {
      return { ok: false };
    }
    if (l.pathValue !== undefined && (l.pathValue.includes('\n') || l.pathValue.includes('\r'))) {
      return { ok: false };
    }
    for (const f of all) if (l.head.includes(f)) return { ok: false };
  }
  return { ok: true };
}
