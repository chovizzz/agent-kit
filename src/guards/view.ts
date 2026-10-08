import { parseRestrictedYaml, splitFrontmatter } from '../atoms/frontmatter.js';
import type { AtomView } from './types.js';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * 与 lint / 渲染器**同一套**切分与受限 YAML 解析(src/atoms/frontmatter.ts):
 * BOM、CRLF/CR、重复键、别名/锚点/tag、多文档的处理与下游一致,不留「守卫看到 A、渲染器看到 B」的差异。
 * 解析不了一律返回 ok:false(调用方 fail-closed)。
 */
export function viewAtom(text: string, filePath: string): AtomView {
  const { yamlText, body } = splitFrontmatter(text);
  if (yamlText === undefined) return { ok: false, reason: '缺少以 `---` 起止的 frontmatter' };
  const y = parseRestrictedYaml(yamlText, filePath, 'GUARD_FRONTMATTER_UNPARSEABLE');
  if (!y.ok) return { ok: false, reason: y.diagnostics[0]?.message ?? 'YAML 无法解析' };
  if (!isPlainObject(y.value)) return { ok: false, reason: 'frontmatter 顶层不是键值映射' };
  return { ok: true, fm: y.value, body };
}

/** status 字段;缺失或非字符串返回 undefined(调用方按「不合规」处理)。 */
export function statusOf(v: AtomView | undefined): string | undefined {
  if (v === undefined || !v.ok) return undefined;
  const s = v.fm['status'];
  return typeof s === 'string' ? s : undefined;
}

/** 结构化深比较(基本类型用 Object.is,所以 `.nan` 等于自身、`-0` 不等于 `0`)。 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

/** 两版 frontmatter 中值不同(或只在一侧出现)的顶层键,字节序。 */
export function changedKeys(
  base: Readonly<Record<string, unknown>>,
  head: Readonly<Record<string, unknown>>,
): string[] {
  const keys = new Set([...Object.keys(base), ...Object.keys(head)]);
  return [...keys]
    .filter((k) => !(k in base && k in head && deepEqual(base[k], head[k])))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
