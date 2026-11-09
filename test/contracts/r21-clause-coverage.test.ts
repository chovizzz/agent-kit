/**
 * §21.24 W0-11:条款追踪测试(R21-0.1「提前提升相位而未实现 → 验收红」的机械支撑)。
 *
 * 规则:对「首期 ≤ `RSI_AUTO_PHASE`」的每个 R21 条款(加上全部 `[V0]` 条款),要求 `test/**` 里至少有一个**非跳过、非占位、非空**的
 * `it('R21-x.y …')` / `test('R21-x.y …')` 标题,或在 {@link EXEMPT} 里带理由。W0 时相位为 0:只覆盖 R21-0.1 / R21-0.2。
 * 这是**追踪登记**:它不证明某个条款被充分测试,每条不变量仍需自己的负向用例与变异锚点;W-final 提升相位前,豁免表只能含非本期条款。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RSI_AUTO_PHASE, RSI_AUTO_PHASE_ORDER } from '../../src/contracts/rsi.js';
import { readDir, readText } from '../../src/io/read-fs.js';
import { REPO_ROOT } from '../helpers/tmp.js';
import { clausePhaseMap, clauseTags } from './r21-w0-doc.js';

/** 条款 → 豁免理由(W0:空) */
const EXEMPT: Readonly<Record<string, string>> = {};

const HERE = new URL(import.meta.url).pathname;

async function testFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readDir(dir)) {
    const p = path.join(dir, e.name);
    if (e.isDirectory) out.push(...(await testFiles(p)));
    else if (e.isFile && /\.test\.(ts|mts|js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * 从测试源码里提取「真实」的 R21 条款引用:`it(` / `test(`(不是 `.skip` / `.todo` / `.skipIf` / `.fails`)的首个字符串参数里出现条款号,
 * 且该调用的回调体不是空函数。条款号后面不得紧跟数字或字母(`R21-4.4` 不匹配 `R21-4.4a`)。
 */
export function realClauseRefs(src: string): Set<string> {
  const out = new Set<string>();
  // 注释行不算(整行 `//` / `/*` / `*` 开头)
  src = src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join('\n');
  const re =
    /(?:^|[^\w.])(?:it|test)\(\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1\s*,\s*(async\s*)?\(\s*\)\s*=>\s*(\{\s*\}|\{|[^{])/gm;
  for (const m of src.matchAll(re)) {
    const body = m[4] ?? '';
    if (/^\{\s*\}$/.test(body)) continue; // 空函数体
    for (const c of (m[2] as string).matchAll(/R21-\d+\.\d+a?(?![0-9a-z])/g)) out.add(c[0]);
  }
  return out;
}

export function uncoveredClauses(
  phase: number,
  covered: ReadonlySet<string>,
  tags: ReadonlyMap<string, string>,
  map: ReadonlyMap<string, string>,
  exempt: Readonly<Record<string, string>> = EXEMPT,
): string[] {
  const need: string[] = [];
  for (const [id, tag] of tags) {
    if (tag === 'V0') need.push(id);
    else if (tag === 'V1') {
      const first = map.get(id);
      if (first === undefined) throw new Error(`${id} 没有首期`);
      if (RSI_AUTO_PHASE_ORDER.indexOf(first as (typeof RSI_AUTO_PHASE_ORDER)[number]) <= phase)
        need.push(id);
    }
  }
  return need.filter((id) => !covered.has(id) && exempt[id] === undefined).sort();
}

describe('W0-11 条款追踪', async () => {
  const covered = new Set<string>();
  for (const f of await testFiles(path.join(REPO_ROOT, 'test'))) {
    if (f === HERE) continue; // 本文件里的合成样本不算
    for (const id of realClauseRefs(await readText(f))) covered.add(id);
  }
  const tags = clauseTags();
  const map = clausePhaseMap();

  it('R21-0.1 当前相位下每个应覆盖的条款都有真实测试(或带理由的豁免)', () => {
    expect(uncoveredClauses(RSI_AUTO_PHASE, covered, tags, map)).toEqual([]);
    expect(covered.has('R21-0.1')).toBe(true);
    expect(covered.has('R21-0.2')).toBe(true);
  });

  it('R21-0.1 提前提升相位而未实现 → 追踪测试红(模拟相位 1 / 2:应覆盖的条款集合非空)', () => {
    expect(uncoveredClauses(1, covered, tags, map).length).toBeGreaterThan(30);
    expect(uncoveredClauses(2, covered, tags, map).length).toBeGreaterThan(
      uncoveredClauses(1, covered, tags, map).length,
    );
    // 相位 1 应覆盖的条款不含 V1b 首期的条款
    expect(uncoveredClauses(1, covered, tags, map)).not.toContain('R21-6.11');
    expect(uncoveredClauses(2, covered, tags, map)).toContain('R21-6.11');
  });

  it('R21-0.1 豁免表:每项带非空理由、对应真实存在的条款;W0 为空', () => {
    for (const [id, why] of Object.entries(EXEMPT)) {
      expect(tags.has(id), id).toBe(true);
      expect(why.trim().length, id).toBeGreaterThan(0);
    }
    expect(Object.keys(EXEMPT)).toEqual([]);
  });

  it('R21-0.1 提取器的反向对照:skip / todo / 空函数体 / 非标题位置 / 条款后缀字母都不算覆盖', () => {
    const id = ['R21', '-9.9'].join('');
    const idA = ['R21', '-9.8a'].join('');
    const src = [
      `it.skip('${id} skipped', () => { expect(1).toBe(1); });`,
      `it.todo('${id} todo');`,
      `it('${id} empty', () => {});`,
      `it('${id} empty2', async () => { });`,
      `const s = "${id}";`,
      `// it('${id} in comment', () => { x(); })`,
      `it('${idA} suffix', () => { x(); });`,
    ].join('\n');
    const refs = realClauseRefs(src);
    expect(refs.has(id)).toBe(false);
    expect(refs.has(idA)).toBe(true); // 带后缀的条款只匹配自己
    expect(refs.has(['R21', '-9.8'].join(''))).toBe(false);
    const ok = realClauseRefs(
      `it('${id} real', () => { expect(1).toBe(1); });\ntest('${id} t', async () => { x(); });`,
    );
    expect(ok.has(id)).toBe(true);
  });

  it('R21-0.1 解析到的 [V1] 条款数不低于下限(防解析静默变空)', () => {
    expect([...tags.values()].filter((t) => t === 'V1').length).toBeGreaterThanOrEqual(80);
    expect(covered.size).toBeGreaterThan(0);
  });
});
