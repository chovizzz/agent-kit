/**
 * 装配块 A 段(L2):import 闭包工具 `closureOf` 自身的虚拟负向夹具。
 * 读侧闭包断言(`a-zero-write.test.ts`)只有在工具能识别每一种引入模块的写法时才有意义:
 * 这里对每种语法各造一个虚拟入口,让它指向真实存在的写出口 `src/io/safe-fs.ts`,断言工具把它报出来(或在应当跳过的口径下不报);
 * 并带「没有引入」的正向对照,证明命中来自这个写法本身。
 */
import { describe, expect, it } from 'vitest';
import { closureOf } from '../closure-util.js';

const ENTRY = 'src/rsi/__l2_entry.ts';
const MID = 'src/rsi/__l2_mid.ts';
const SAFE_FS = 'src/io/safe-fs.ts';
const SPEC = "'../io/safe-fs.js'";

const runtimeHas = (src: string): boolean =>
  closureOf([ENTRY], { virtual: { [ENTRY]: src } }).files.has(SAFE_FS);
const typesHas = (src: string): boolean =>
  closureOf([ENTRY], { includeTypes: true, virtual: { [ENTRY]: src } }).files.has(SAFE_FS);

describe('closureOf:每种引入模块的语法都被识别', () => {
  it('对照:没有任何引入的入口,两种口径都不含 safe-fs', () => {
    expect(runtimeHas('export const x = 1;\n')).toBe(false);
    expect(typesHas('export const x = 1;\n')).toBe(false);
  });

  it('运行时依赖:静态 import / 副作用 import / export { } from / export * from / import x = require() 都进闭包', () => {
    for (const src of [
      `import { writeFile } from ${SPEC};\nexport const x = writeFile;\n`,
      `import ${SPEC};\nexport const x = 1;\n`,
      `export { writeFile } from ${SPEC};\n`,
      `export * from ${SPEC};\n`,
      `export * as fsw from ${SPEC};\n`,
      `import fsw = require(${SPEC});\nexport const x = fsw;\n`,
      `const m = await import(${SPEC});\nexport const x = m;\n`,
    ]) {
      expect(runtimeHas(src), src).toBe(true);
      expect(typesHas(src), src).toBe(true);
    }
  });

  it('仅类型依赖:import type / export type { } from / export type * from / 类型位置的 import("…") 只在含类型口径进闭包(运行时口径不含)', () => {
    for (const src of [
      `import type { writeFile } from ${SPEC};\nexport type X = typeof writeFile;\n`,
      `export type { writeFile } from ${SPEC};\n`,
      `export type * from ${SPEC};\n`,
      `export type X = import(${SPEC}).Stats;\n`,
    ]) {
      expect(runtimeHas(src), src).toBe(false);
      expect(typesHas(src), src).toBe(true);
    }
  });

  it('经中间模块的传递:入口 → export * from 中间文件 → 中间文件 import 写出口,两种口径都报出', () => {
    const virtual = {
      [ENTRY]: "export * from './__l2_mid.js';\n",
      [MID]: `import { writeFile } from ${SPEC};\nexport const w = writeFile;\n`,
    };
    for (const includeTypes of [false, true]) {
      const c = closureOf([ENTRY], { includeTypes, virtual });
      expect(c.files.has(MID)).toBe(true);
      expect(c.files.has(SAFE_FS)).toBe(true);
    }
    // 对照:中间文件不引入写出口 → 不含
    const clean = closureOf([ENTRY], {
      virtual: { [ENTRY]: virtual[ENTRY], [MID]: 'export const w = 1;\n' },
    });
    expect(clean.files.has(SAFE_FS)).toBe(false);
  });

  it('绕过静态闭包的写法被记为 dynamic(而不是静默放过):非字面量 import()、require()、module.require()、createRequire(…)(…);字面量 import() 不算(已进闭包)', () => {
    for (const [why, src] of [
      ['非字面量 import()', 'export const m = (n: string) => import(n);\n'],
      ['模板字面量带替换', 'export const m = (n: string) => import(`./${n}.js`);\n'],
      ['require()', "export const r = require('node:fs');\n"],
      ['成员 require()', "export const r = module.require('node:fs');\n"],
      ['createRequire(…)(…)', "export const r = createRequire(import.meta.url)('node:fs');\n"],
    ] as const) {
      const c = closureOf([ENTRY], { virtual: { [ENTRY]: src } });
      expect(c.dynamic.length, why).toBe(1);
      expect(c.dynamic[0], why).toContain(ENTRY);
    }
    expect(
      closureOf([ENTRY], { virtual: { [ENTRY]: `export const m = import(${SPEC});\n` } }).dynamic,
    ).toEqual([]);
    expect(closureOf([ENTRY], { virtual: { [ENTRY]: 'export const x = 1;\n' } }).dynamic).toEqual(
      [],
    );
  });

  it('相对说明符解析不到 → unresolved(不是静默放过)', () => {
    const c = closureOf([ENTRY], { virtual: { [ENTRY]: "export * from './__l2_nowhere.js';\n" } });
    expect(c.unresolved).toEqual([`${ENTRY} -> ./__l2_nowhere.js`]);
  });
});
