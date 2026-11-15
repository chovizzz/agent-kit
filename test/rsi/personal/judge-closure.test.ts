/**
 * W9a 判官裁决读侧的 import 闭包闸与零写入静态证据(contracts R20-18.25 ①、R20-18.34「import 闭包」、W0-27):
 *  - `judge-signal.ts`(纯判定):只许 contracts、`io/canonical-json.ts`(纯)与 node:crypto;不得 import `src/lifecycle/**`(`ruleSha256` 经注入)、judge-ingest、TTY、judge store、任何写出口;
 *  - `read/judge-source.ts`(适配器)与 `auto/read/judge-verdict.ts`(展示映射):闭包里没有写出口 / 锁 / 子进程 / 网络 / judge store / 确认流;`node:fs` 只被 `read-fs.ts` 引入;
 *  - `lifecycle/rule-hash.ts`(`ruleSha256` 唯一实现):闭包只有它自己与 `canonical-text.ts`;对照:`checks.ts` 的闭包含写出口(这正是拆文件的理由,也证明本检查器看得见它)。
 * 每个检查都带虚拟文件的负向对照(往真实入口加一条禁用 import,检查必须红),防止「干净」是检查器漏看。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readTextSync } from '../../../src/io/read-fs.js';
import {
  ROOT,
  closureOf,
  externalSpecs,
  fsWriteUses,
  identHits,
  importersOf,
  type Closure,
} from '../closure-util.js';

const JUDGE_SIGNAL = 'src/rsi/personal/judge-signal.ts';
const JUDGE_SOURCE = 'src/rsi/personal/read/judge-source.ts';
const JUDGE_VERDICT = 'src/rsi/auto/read/judge-verdict.ts';
const RULE_HASH = 'src/lifecycle/rule-hash.ts';

/** 闭包里一个都不许有的文件(写出口 / 锁 / 子进程 / 网络 / 确认流 / judge store / lifecycle) */
const FORBIDDEN_FILES = [
  'src/io/safe-fs.ts',
  'src/io/home-fs.ts',
  'src/io/exec.ts',
  'src/io/llm-exec.ts',
  'src/io/net.ts',
  'src/io/tty.ts',
  'src/rsi/lock.ts',
  'src/rsi/with-lock.ts',
  'src/rsi/snapshot.ts',
  'src/rsi/services/commit.ts',
  'src/rsi/services/taint.ts',
  'src/rsi/personal/home-state.ts',
  'src/rsi/personal/personal-lock.ts',
  'src/rsi/personal/commit.ts',
  'src/commands/judge-ingest.ts',
  'src/judge/store.ts',
];
const FORBIDDEN_PREFIXES = ['src/judge/ingest/', 'src/lifecycle/', 'src/update/', 'src/reflect/'];
const WRITE_IDENTS = [
  'acquireRsiLock',
  'acquirePersonalLock',
  'withRsiLock',
  'commitSnapshot',
  'createExclusive',
  'appendFile',
  'mkdirp',
  'runSync',
  'runSelf',
  'runGitClosed',
  'spawnSync',
];

const bad = (c: Closure, allow: readonly string[] = []): string[] =>
  [...c.files].filter(
    (f) =>
      !allow.includes(f) &&
      (FORBIDDEN_FILES.includes(f) || FORBIDDEN_PREFIXES.some((p) => f.startsWith(p))),
  );

for (const includeTypes of [false, true]) {
  const tag = includeTypes ? '含类型依赖' : '运行时依赖';

  describe(`W9a 闭包闸(${tag})`, () => {
    it('judge-signal.ts:只有 contracts / canonical-json 与 node:crypto、zod;没有任何禁用文件,没有 src/lifecycle,没有动态 import', () => {
      const c = closureOf([JUDGE_SIGNAL], { includeTypes });
      expect(bad(c)).toEqual([]);
      expect(identHits(c, WRITE_IDENTS)).toEqual([]);
      expect(c.dynamic).toEqual([]);
      expect(c.unresolved).toEqual([]);
      expect(externalSpecs(c).filter((e) => !['node:crypto', 'zod'].includes(e))).toEqual([]);
      expect(
        [...c.files].filter((f) => f.startsWith('src/') && !f.startsWith('src/contracts/')).sort(),
      ).toEqual([JUDGE_SIGNAL, 'src/io/canonical-json.ts'].sort());
    });

    it('judge-source.ts:闭包无写出口 / 锁 / 子进程 / judge store / lifecycle;node:fs 只被 read-fs 引入;外部模块只有 node:*、zod、yaml', () => {
      const c = closureOf([JUDGE_SOURCE], { includeTypes });
      expect(bad(c)).toEqual([]);
      expect(identHits(c, WRITE_IDENTS)).toEqual([]);
      expect(c.dynamic).toEqual([]);
      expect(c.unresolved).toEqual([]);
      expect(externalSpecs(c)).not.toContain('node:child_process');
      expect(
        externalSpecs(c).filter(
          (e) =>
            !['node:crypto', 'node:fs', 'node:fs/promises', 'node:path', 'yaml', 'zod'].includes(e),
        ),
      ).toEqual(includeTypes ? ['node:os'] : []);
      // 含类型口径下的 node:os 只来自 `import type { IoContext } from io/paths`(lock-read / snapshot-read 的类型导入);运行时口径里没有
      expect(importersOf(c, 'node:os')).toEqual(includeTypes ? ['src/io/paths.ts'] : []);
      for (const spec of ['node:fs', 'node:fs/promises']) {
        expect(importersOf(c, spec).filter((f) => f !== 'src/io/read-fs.ts')).toEqual([]);
      }
      // judge-source 对 judge-signal 只有 `import type`(端口类型):运行时口径里没有它,含类型口径里才有
      expect(c.files.has(JUDGE_SIGNAL)).toBe(includeTypes);
    });

    it('judge-verdict.ts(展示映射):同样没有禁用文件;闭包含 judge-signal(展示与消费同一份判定)', () => {
      const c = closureOf([JUDGE_VERDICT], { includeTypes });
      expect(bad(c)).toEqual([]);
      expect(identHits(c, WRITE_IDENTS)).toEqual([]);
      expect(c.dynamic).toEqual([]);
      expect(c.unresolved).toEqual([]);
      expect(c.files.has(JUDGE_SIGNAL)).toBe(true);
      expect(externalSpecs(c).filter((e) => !['node:crypto', 'zod'].includes(e))).toEqual([]);
    });

    it('rule-hash.ts:闭包恰为它自己、canonical-text 与 node:crypto;checks.ts 再导出同名符号(对照:checks.ts 的闭包含 safe-fs 写出口)', () => {
      const c = closureOf([RULE_HASH], { includeTypes });
      expect([...c.files].sort()).toEqual([RULE_HASH, 'src/io/canonical-text.ts'].sort());
      expect(externalSpecs(c)).toEqual(['node:crypto']);
      const checks = closureOf(['src/lifecycle/checks.ts'], { includeTypes });
      expect(checks.files.has('src/io/safe-fs.ts')).toBe(true);
      expect(checks.files.has(RULE_HASH)).toBe(true);
    });
  });
}

describe('W9a 闭包闸:负向对照(往真实入口加一条禁用 import,检查必须红)', () => {
  const inject = (entry: string, line: string): Record<string, string> => ({
    [entry]: `${line}\n${readTextSync(path.join(ROOT, entry))}`,
  });
  const banned: [string, string][] = [
    ['写出口 safe-fs', "import { writeFile } from '../../io/safe-fs.js';"],
    ['lifecycle(含 checks.ts)', "import { ruleSha256 } from '../../lifecycle/checks.js';"],
    ['judge store', "import { loadRunEntries } from '../../judge/store.js';"],
    ['确认流 tty', "import { x } from '../../io/tty.js';"],
  ];
  it('judge-signal.ts / judge-source.ts:每种禁用 import 都让闭包检查变红', () => {
    for (const [name, line] of banned) {
      const sigLine = line.replace(/\.\.\/\.\.\//g, '../../');
      const c1 = closureOf([JUDGE_SIGNAL], { virtual: inject(JUDGE_SIGNAL, sigLine) });
      expect(bad(c1).length, `signal:${name}`).toBeGreaterThan(0);
      const srcLine = line.replace(/\.\.\/\.\.\//g, '../../../');
      const c2 = closureOf([JUDGE_SOURCE], { virtual: inject(JUDGE_SOURCE, srcLine) });
      expect(bad(c2).length, `source:${name}`).toBeGreaterThan(0);
    }
    // 对照:不注入则干净
    expect(bad(closureOf([JUDGE_SIGNAL]))).toEqual([]);
    expect(bad(closureOf([JUDGE_SOURCE]))).toEqual([]);
  });

  it('动态 import / require 绕过也被看见', () => {
    // 字面量 `import('…')`:工具把它当静态说明符解析,禁用文件进入闭包 → bad() 变红
    const lit = inject(JUDGE_SIGNAL, "export const lazy = () => import('../../io/safe-fs.js');");
    expect(bad(closureOf([JUDGE_SIGNAL], { virtual: lit })).length).toBeGreaterThan(0);
    // 非字面量 `import(x)` / 任意 `require()`:无法静态解析 → 记入 dynamic → 闭包检查变红
    const nonLit = inject(JUDGE_SIGNAL, 'export const lazy2 = (m: string) => import(m);');
    expect(closureOf([JUDGE_SIGNAL], { virtual: nonLit }).dynamic.length).toBeGreaterThan(0);
    const req = inject(JUDGE_SIGNAL, "export const lazy3 = () => require('../../io/safe-fs.js');");
    expect(closureOf([JUDGE_SIGNAL], { virtual: req }).dynamic.length).toBeGreaterThan(0);
    // 对照:不注入则两项都干净
    const clean = closureOf([JUDGE_SIGNAL]);
    expect(clean.dynamic).toEqual([]);
    expect(bad(clean)).toEqual([]);
  });
});

describe('W9a 零写入静态证据', () => {
  it('三个读侧文件自身没有写类 fs 成员(AST 扫描);对照:扫描器能识别写用法', () => {
    for (const f of [JUDGE_SIGNAL, JUDGE_SOURCE, JUDGE_VERDICT, RULE_HASH]) {
      expect(fsWriteUses(f, readTextSync(path.join(ROOT, f))), f).toEqual([]);
    }
    expect(
      fsWriteUses('x.ts', "import * as fs from 'node:fs'; fs.writeFile('a', 'b', () => {});")
        .length,
    ).toBe(1);
  });
});
