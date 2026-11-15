/**
 * B1a 架构测试(替代设计稿的「eslint 限制 import」——后写的 `no-restricted-imports` 会整条覆盖 `restrictions()` 的既有配置,故用静态扫描):
 *  - 合并内部函数 / 意图(`ledger-merge.ts`)与原始读写后端(`backend.ts`)只许 `src/rsi/store/**` 与 `test/rsi/store/**` import;
 *  - 事务协调器 / 账存储不暴露裸写:`store.ts` 的导出面里没有后端与合并函数。
 * 每条规则带正向对照(虚拟文件违规时扫描器必须报出)。
 */
import * as path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { readDir, readTextSync } from '../../../src/io/read-fs.js';
import { ROOT } from '../closure-util.js';

const INTERNAL = ['rsi/store/ledger-merge', 'rsi/store/backend'];
const ALLOWED_PREFIXES = ['src/rsi/store/', 'test/rsi/store/'];

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of await readDir(dir)) {
    const p = path.join(dir, e.name);
    if (e.isDirectory) {
      if (e.name === 'node_modules' || e.name === 'fixtures') continue;
      await walk(p, out);
    } else if (e.isFile && p.endsWith('.ts')) out.push(p);
  }
  return out;
}

function specsOf(file: string, src: string): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteralLike(n.moduleSpecifier))
      out.push(n.moduleSpecifier.text);
    else if (
      ts.isExportDeclaration(n) &&
      n.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(n.moduleSpecifier)
    )
      out.push(n.moduleSpecifier.text);
    else if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ImportKeyword &&
      n.arguments[0] !== undefined &&
      ts.isStringLiteralLike(n.arguments[0])
    )
      out.push(n.arguments[0].text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** 违规 = 文件不在允许目录却引用了内部模块(按解析后的相对路径匹配,不看 `../` 层数) */
function violations(files: Record<string, string>): string[] {
  const bad: string[] = [];
  for (const [rel, src] of Object.entries(files)) {
    if (ALLOWED_PREFIXES.some((p) => rel.startsWith(p))) continue;
    for (const s of specsOf(rel, src)) {
      if (!s.startsWith('.')) continue;
      const resolved = path.posix
        .normalize(path.posix.join(path.posix.dirname(rel), s))
        .replace(/\.js$/, '')
        .replace(/\.ts$/, '');
      if (INTERNAL.some((i) => resolved.endsWith(i))) bad.push(`${rel} -> ${s}`);
    }
  }
  return bad;
}

describe('存储核内部模块的 import 范围', () => {
  it('全仓扫描:除 src/rsi/store/** 与 test/rsi/store/** 外没有文件 import ledger-merge / backend', async () => {
    const abs = [
      ...(await walk(path.join(ROOT, 'src'))),
      ...(await walk(path.join(ROOT, 'test'))),
      ...(await walk(path.join(ROOT, 'adapters'))),
    ];
    const files: Record<string, string> = {};
    for (const f of abs) files[path.relative(ROOT, f).split(path.sep).join('/')] = readTextSync(f);
    expect(Object.keys(files).length).toBeGreaterThan(100);
    expect(violations(files)).toEqual([]);
  });

  it('正向对照:虚拟文件引用内部模块时扫描器报出(含 re-export / 动态 import / 不同层数写法)', () => {
    const hits = violations({
      'src/rsi/personal/x.ts': "import { applyBatch } from '../store/ledger-merge.js';",
      'src/rsi/auto/y.ts': "export { createBackend } from '../store/backend.js';",
      'src/commands/z.ts': "export const f = () => import('../rsi/store/ledger-merge.js');",
      'src/rsi/store/ok.ts': "import { applyBatch } from './ledger-merge.js';",
      'test/rsi/store/ok.test.ts':
        "import { applyBatch } from '../../../src/rsi/store/ledger-merge.js';",
    });
    expect(hits).toEqual([
      'src/rsi/personal/x.ts -> ../store/ledger-merge.js',
      'src/rsi/auto/y.ts -> ../store/backend.js',
      'src/commands/z.ts -> ../rsi/store/ledger-merge.js',
    ]);
  });
});

describe('导出面', () => {
  it('store.ts 只导出装配函数;ledger-plan.ts 只导出 planLedgerBatch(意图与合并内部函数不外露)', async () => {
    expect(Object.keys(await import('../../../src/rsi/store/store.js'))).toEqual([
      'assembleRsiStore',
    ]);
    expect(Object.keys(await import('../../../src/rsi/store/ledger-plan.js'))).toEqual([
      'planLedgerBatch',
    ]);
  });
  it('ports.ts 只有类型(运行期无导出);reconcile.ts 只导出未接线实现', async () => {
    expect(Object.keys(await import('../../../src/rsi/store/ports.js'))).toEqual([]);
    expect(Object.keys(await import('../../../src/rsi/store/reconcile.js'))).toEqual([
      'unwiredReconcileSource',
    ]);
  });
  it('装配出的端口对象没有后端 / 合并函数 / intent', async () => {
    const { makeWorld } = await import('./store-fixture.js');
    const w = await makeWorld('mem');
    expect(Object.keys(w.store).sort()).toEqual([
      'appender',
      'held',
      'recovery',
      'registry',
      'seal',
      'sink',
      'userVeto',
    ]);
    expect(Object.keys(w.store.held).sort()).toEqual(['closing', 'release', 'transaction']);
  });
});
