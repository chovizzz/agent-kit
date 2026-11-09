/**
 * §21.24 W0-11:条款追踪测试(R21-0.1「提前提升相位而未实现 → 验收红」的机械支撑)。
 *
 * 规则:对「首期 ≤ `RSI_AUTO_PHASE`」的每个 R21 条款(加上全部 `[V0]` 条款),要求 `test/**` 里至少有一个**在 AST 中真实注册**的
 * `it('R21-x.y …')` / `test('R21-x.y …')`:调用名是裸标识符 `it` / `test`(不是 `.skip` / `.todo`、不在字符串或注释里)、回调体含至少一次调用
 * (非空、非纯 `return`)、不在 `if (false)` 分支里;或在 {@link EXEMPT} 里带理由。W0 时相位为 0:只覆盖 R21-0.1 / R21-0.2。
 * 这是**追踪登记**:无法机械证明「语义上非占位」,它不证明某个条款被充分测试,每条不变量仍需自己的负向用例与变异锚点;
 * W-final 提升相位前,豁免表只能含非本期条款。
 */
import * as path from 'node:path';
import ts from 'typescript';
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

const CLAUSE_RE = /R21-\d+\.\d+a?(?![0-9a-z])/g;

const containsCall = (n: ts.Node): boolean => {
  let found = false;
  const visit = (x: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(x) || ts.isNewExpression(x)) found = true;
    else ts.forEachChild(x, visit);
  };
  visit(n);
  return found;
};

/** 祖先里有 `if (false)` / `if (0)` 的 then 分支 */
const inDeadBranch = (n: ts.Node): boolean => {
  for (let p: ts.Node | undefined = n.parent, child: ts.Node = n; p; child = p, p = p.parent) {
    if (ts.isIfStatement(p) && p.thenStatement === child) {
      const c = p.expression;
      if (c.kind === ts.SyntaxKind.FalseKeyword) return true;
      if (ts.isNumericLiteral(c) && c.text === '0') return true;
    }
  }
  return false;
};

/**
 * AST 提取「真实」的 R21 条款引用。条款号后面不得紧跟数字或字母(`R21-4.4` 不匹配 `R21-4.4a`)。
 */
export function realClauseRefs(src: string): Set<string> {
  const out = new Set<string>();
  const sf = ts.createSourceFile('x.test.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      (n.expression.text === 'it' || n.expression.text === 'test')
    ) {
      const [title, cb] = n.arguments;
      if (
        title !== undefined &&
        ts.isStringLiteralLike(title) &&
        cb !== undefined &&
        (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) &&
        containsCall(cb.body) &&
        !inDeadBranch(n)
      ) {
        for (const c of title.text.matchAll(CLAUSE_RE)) out.add(c[0]);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
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
      const idx = RSI_AUTO_PHASE_ORDER.indexOf(first as (typeof RSI_AUTO_PHASE_ORDER)[number]);
      if (idx < 0) throw new Error(`${id} 的首期 ${first} 不在相位表里`);
      if (idx <= phase) need.push(id);
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

  it('R21-0.1 追踪器能阻止提前提升相位(合成输入:缺哪条就报哪条;V1b 首期条款在相位 1 不要求)', () => {
    const synTags = new Map([
      ['R21-0.1', 'V0'],
      ['R21-1.1', 'V1'],
      ['R21-6.1', 'V1'],
      ['R21-8.1', 'V2'],
    ]);
    const synMap = new Map([
      ['R21-1.1', 'V1a'],
      ['R21-6.1', 'V1b'],
    ]);
    const none = new Set<string>();
    expect(uncoveredClauses(0, none, synTags, synMap, {})).toEqual(['R21-0.1']);
    expect(uncoveredClauses(1, none, synTags, synMap, {})).toEqual(['R21-0.1', 'R21-1.1']);
    expect(uncoveredClauses(2, none, synTags, synMap, {})).toEqual([
      'R21-0.1',
      'R21-1.1',
      'R21-6.1',
    ]);
    // 补齐一条 → 只剩其余;豁免带理由才生效
    expect(uncoveredClauses(2, new Set(['R21-0.1', 'R21-1.1']), synTags, synMap, {})).toEqual([
      'R21-6.1',
    ]);
    expect(
      uncoveredClauses(2, new Set(['R21-0.1', 'R21-1.1']), synTags, synMap, { 'R21-6.1': '理由' }),
    ).toEqual([]);
    // 缺首期的 V1 条款 → 抛错(不静默放过)
    expect(() => uncoveredClauses(1, none, new Map([['R21-9.9', 'V1']]), new Map(), {})).toThrow(
      /没有首期/,
    );
  });

  it('R21-0.1 豁免表:每项带非空理由、对应真实存在的条款;W0 为空', () => {
    for (const [id, why] of Object.entries(EXEMPT)) {
      expect(tags.has(id), id).toBe(true);
      expect(why.trim().length, id).toBeGreaterThan(0);
    }
    expect(Object.keys(EXEMPT)).toEqual([]);
  });

  it('R21-0.1 提取器的反向对照:skip / todo / 空体 / 纯 return / 字符串里 / 注释里 / if(false) / 非调用回调都不算覆盖', () => {
    const id = ['R21', '-9.9'].join('');
    const idA = ['R21', '-9.8a'].join('');
    const src = [
      `it.skip('${id} skipped', () => { expect(1).toBe(1); });`,
      `it.todo('${id} todo');`,
      `it('${id} empty', () => {});`,
      `it('${id} empty2', async () => { });`,
      `it('${id} only return', () => { return; });`,
      `const s = "it('${id} fake', () => { x(); });";`,
      `// it('${id} in comment', () => { x(); })`,
      `if (false) { it('${id} dead', () => { x(); }); }`,
      `it('${idA} suffix', () => { x(); });`,
      `describe('${id}', () => { y(); });`,
    ].join('\n');
    const refs = realClauseRefs(src);
    expect(refs.has(id)).toBe(false);
    expect(refs.has(idA)).toBe(true); // 带后缀的条款只匹配自己
    expect(refs.has(['R21', '-9.8'].join(''))).toBe(false);
    const ok = realClauseRefs(
      `it('${id} real', () => { expect(1).toBe(1); });\ntest('${id} t', async () => { x(); });`,
    );
    expect(ok.has(id)).toBe(true);
    // 表达式体回调(含调用)同样算
    expect(realClauseRefs(`it('${id} expr', () => expect(1).toBe(1));`).has(id)).toBe(true);
  });

  it('R21-0.1 解析到的 [V1] 条款数不低于下限(防解析静默变空)', () => {
    expect([...tags.values()].filter((t) => t === 'V1').length).toBeGreaterThanOrEqual(80);
    expect(covered.size).toBeGreaterThan(0);
  });
});
