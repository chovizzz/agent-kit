/**
 * D1a:**生产惰性**的证明(设计稿 v4 §9 D1a 行)——合并后没有任何生产入口使用新模块,新模块也不 import 任何增影响汇点:
 *  ① 生产入口的 import 闭包(运行时 / 含类型各一次)不含 `src/rsi/personal/fp/**` 与 `src/rsi/personal/facts/**`;
 *  ② 仓库里没有任何**别的**源文件 import 它们(没有 re-export 偷渡;正则扫描只是补充,完整性论证靠 ① 与「闭包内无非字面量 import / require」);
 *  ③ 新模块自身的运行时闭包不含增影响汇点(`grantCanary` / `stepAdmission` / `applyEvent` / 提交 / 建仓)与 near 草案之外的语料工具;
 *  ④ 语料工具与 near 草案计算只在 `test/tools/**`,不在任何生产入口闭包内(`near_draft_compute_not_in_production_closure`);
 *  ⑤ 相位常量仍为 0。
 * 每条都有正向对照(虚拟入口 import 新模块时同一检查必须变红)。
 */
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RSI_AUTO_PHASE } from '../../../src/contracts/rsi.js';
import { existsSync, readDir, readTextSync } from '../../../src/io/read-fs.js';
import { ROOT, closureOf } from '../closure-util.js';

vi.setConfig({ testTimeout: 120_000 });

const ENTRIES = [
  'cli.ts',
  'src/cli.ts',
  'src/commands/rsi.ts',
  'src/rsi/poke.ts',
  'src/rsi/hint.ts',
  'src/rsi/worker.ts',
  'src/rsi/auto/commands.ts',
  'src/rsi/auto/entry.ts',
  'src/rsi/auto/deps-write.ts',
  'src/rsi/personal/candidate-step.ts',
].filter((f) => existsSync(path.join(ROOT, f)));

const NEW_DIRS = ['src/rsi/personal/fp/', 'src/rsi/personal/facts/'];
const isNew = (f: string): boolean => NEW_DIRS.some((d) => f.startsWith(d));
const NEW_ENTRY_FILES = [
  'src/rsi/personal/fp/fp-ports.ts',
  'src/rsi/personal/fp/near-algo.ts',
  'src/rsi/personal/fp/near-capability.ts',
  'src/rsi/personal/fp/exact-fp.ts',
  'src/rsi/personal/fp/fp-key.ts',
  'src/rsi/personal/facts/facts-ports.ts',
  'src/rsi/personal/facts/facts-pure.ts',
  'src/rsi/personal/facts/facts-provider.ts',
];
const GROWTH_SINKS = [
  'src/rsi/canary/canary-writer.ts',
  'src/rsi/canary/admission-write.ts',
  'src/rsi/personal/candidate-apply.ts',
  'src/rsi/personal/candidate-step.ts',
  'src/rsi/personal/commit.ts',
  'src/rsi/personal/commit-journal.ts',
];

describe('生产惰性(D1a)', () => {
  it('入口闭包非空(自检);新模块文件都存在(自检)', () => {
    expect(ENTRIES.length).toBeGreaterThanOrEqual(8);
    expect(closureOf(ENTRIES).files.size).toBeGreaterThan(50);
    for (const f of NEW_ENTRY_FILES) expect(existsSync(path.join(ROOT, f)), f).toBe(true);
  });

  it('生产入口闭包(运行时与含类型两种口径)都不含 fp/ 与 facts/ 下的任何文件', () => {
    for (const includeTypes of [false, true]) {
      const c = closureOf(ENTRIES, { includeTypes });
      expect([...c.files].filter(isNew), `includeTypes=${includeTypes}`).toEqual([]);
      expect(c.unresolved).toEqual([]);
      // 非字面量的 import() / require() 会绕过静态闭包:生产入口闭包里一个都不许有
      expect(c.dynamic, `includeTypes=${includeTypes}`).toEqual([]);
    }
  });

  it('正向对照:虚拟入口 import 新模块时,闭包含它们(检查有效)', () => {
    const c = closureOf(['src/rsi/inert-probe.ts'], {
      virtual: {
        'src/rsi/inert-probe.ts':
          "import { makeFactsProvider } from './personal/facts/facts-provider.js';\nimport { makeFpKeyPort } from './personal/fp/fp-key.js';\nexport const x = [makeFactsProvider, makeFpKeyPort];",
      },
    });
    const hit = [...c.files].filter(isNew);
    expect(hit).toContain('src/rsi/personal/facts/facts-provider.ts');
    expect(hit).toContain('src/rsi/personal/fp/fp-key.ts');
    expect(hit).toContain('src/rsi/personal/fp/near-algo.ts');
  });

  it('正向对照:非字面量 import() / require() 会被记入 dynamic(绕过静态闭包的写法不会被漏掉)', () => {
    const c = closureOf(['src/rsi/inert-probe.ts'], {
      virtual: {
        'src/rsi/inert-probe.ts':
          "const p = './personal/fp/near-algo.js';\nexport const m = await import(p);\nexport const r = require(p);",
      },
    });
    expect(c.dynamic.sort()).toEqual([
      'src/rsi/inert-probe.ts:import()',
      'src/rsi/inert-probe.ts:require()',
    ]);
    expect([...c.files].filter(isNew)).toEqual([]);
  });

  it('没有别的源文件 import fp/ 或 facts/(含 re-export / 动态 import);正向对照:扫描器能识别', async () => {
    const SPEC =
      /(?:from|import)\s*\(?\s*['"]([^'"]*\/personal\/(?:fp|facts)\/[^'"]*|\.\/(?:fp|facts)\/[^'"]*)['"]/;
    const offenders = (files: Record<string, string>): string[] =>
      Object.entries(files)
        .filter(([rel]) => !isNew(rel))
        .filter(([, src]) => SPEC.test(src))
        .map(([rel]) => rel);
    const walk = async (dir: string, out: string[] = []): Promise<string[]> => {
      for (const e of await readDir(dir)) {
        const p = path.join(dir, e.name);
        if (e.isDirectory) await walk(p, out);
        else if (e.isFile && p.endsWith('.ts')) out.push(p);
      }
      return out;
    };
    const files: Record<string, string> = {};
    for (const f of [...(await walk(path.join(ROOT, 'src'))), path.join(ROOT, 'cli.ts')]) {
      files[path.relative(ROOT, f).split(path.sep).join('/')] = readTextSync(f);
    }
    expect(Object.keys(files).length).toBeGreaterThan(300);
    expect(offenders(files)).toEqual([]);
    expect(
      offenders({
        'src/rsi/personal/index.ts': "export * from './fp/near-algo.js';",
        'src/rsi/x.ts': "const m = await import('./personal/facts/facts-provider.js');",
        'src/rsi/y.ts': "import type { T } from './personal/fp/fp-ports.js';",
      }),
    ).toEqual(['src/rsi/personal/index.ts', 'src/rsi/x.ts', 'src/rsi/y.ts']);
  });

  it('新模块的运行时闭包不含任何增影响汇点;正向对照:候选步骤入口的闭包含它们', () => {
    const c = closureOf(NEW_ENTRY_FILES, { includeTypes: false });
    expect(GROWTH_SINKS.filter((s) => c.files.has(s))).toEqual([]);
    expect(c.unresolved).toEqual([]);
    expect(c.dynamic).toEqual([]);
    const probe = closureOf(['src/rsi/personal/candidate-step.ts'], { includeTypes: false });
    expect(GROWTH_SINKS.filter((s) => probe.files.has(s)).length).toBeGreaterThan(0);
  });

  it('near_draft_compute_not_in_production_closure:语料工具只在 test/tools,不在生产入口闭包', () => {
    expect(existsSync(path.join(ROOT, 'test/tools/near-fp-corpus.ts'))).toBe(true);
    for (const includeTypes of [false, true]) {
      const c = closureOf(ENTRIES, { includeTypes });
      expect([...c.files].filter((f) => f.startsWith('test/') || f.startsWith('scripts/'))).toEqual(
        [],
      );
    }
    const probe = closureOf(['test/tools/near-fp-corpus.ts']);
    expect(probe.files.has('src/rsi/personal/fp/near-algo.ts')).toBe(true);
    // 工具只依赖 near-algo(只用 node:crypto),不拖进其它运行时模块
    expect([...probe.files].filter((f) => f.startsWith('src/')).sort()).toEqual([
      'src/rsi/personal/fp/near-algo.ts',
    ]);
  });

  it('near-algo 只依赖 node:crypto(语料工具经 resolve hook 直接加载它)', () => {
    const c = closureOf(['src/rsi/personal/fp/near-algo.ts'], { includeTypes: false });
    expect([...c.files]).toEqual(['src/rsi/personal/fp/near-algo.ts']);
    expect([...c.externals].map((e) => e.split('\u0000')[0])).toEqual(['node:crypto']);
  });

  it('相位常量保持 0', () => {
    expect(RSI_AUTO_PHASE).toBe(0);
  });
});
