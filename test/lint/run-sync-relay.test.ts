/**
 * §21 W0-11:`runSync` 的 lint 限域只拦「直接从 io/exec 导入」,这里补上静态转出:`src/io/exec.ts` 以外的模块不得把 `runSync` 再导出去,
 * 否则 `src/rsi/**` 可以经中间模块拿到它。调用 `runSync` 的函数包装不在本测试范围内(见 contracts §21.24 W0-11)。
 */
import * as path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { readDir, readText } from '../../src/io/read-fs.js';
import { REPO_ROOT } from '../helpers/tmp.js';

const EXEC = path.join(REPO_ROOT, 'src/io/exec');

const isExec = (file: string, spec: ts.Expression | undefined): boolean =>
  spec !== undefined &&
  ts.isStringLiteralLike(spec) &&
  spec.text.startsWith('.') &&
  path.resolve(path.dirname(file), spec.text).replace(/\.[cm]?[jt]s$/, '') === EXEC;

/** 返回 `file` 里转出 `runSync` 的语句文本;空数组 = 没有转出 */
export function runSyncRelays(file: string, src: string): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const named = new Set<string>();
  const namespaces = new Set<string>();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !isExec(file, s.moduleSpecifier)) continue;
    const b = s.importClause?.namedBindings;
    if (b && ts.isNamespaceImport(b)) namespaces.add(b.name.text);
    if (b && ts.isNamedImports(b)) {
      for (const e of b.elements) {
        if ((e.propertyName ?? e.name).text === 'runSync') named.add(e.name.text);
      }
    }
  }
  const isRunSyncRef = (e: ts.Expression | undefined): boolean =>
    e !== undefined &&
    ((ts.isIdentifier(e) && named.has(e.text)) ||
      (ts.isPropertyAccessExpression(e) &&
        ts.isIdentifier(e.expression) &&
        namespaces.has(e.expression.text) &&
        e.name.text === 'runSync'));
  const out: string[] = [];
  for (const s of sf.statements) {
    if (ts.isExportDeclaration(s)) {
      const c = s.exportClause;
      if (isExec(file, s.moduleSpecifier)) {
        const hit =
          c === undefined ||
          ts.isNamespaceExport(c) ||
          c.elements.some((e) => (e.propertyName ?? e.name).text === 'runSync');
        if (hit) out.push(s.getText(sf));
      } else if (s.moduleSpecifier === undefined && c !== undefined && ts.isNamedExports(c)) {
        const hit = c.elements.some((e) => {
          const local = (e.propertyName ?? e.name).text;
          return named.has(local) || namespaces.has(local);
        });
        if (hit) out.push(s.getText(sf));
      }
    } else if (ts.isExportAssignment(s) && isRunSyncRef(s.expression)) {
      out.push(s.getText(sf));
    } else if (
      ts.isVariableStatement(s) &&
      s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      s.declarationList.declarations.some((d) => isRunSyncRef(d.initializer))
    ) {
      out.push(s.getText(sf));
    }
  }
  return out;
}

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readDir(dir)) {
    const p = path.join(dir, e.name);
    if (e.isDirectory) out.push(...(await sourceFiles(p)));
    else if (e.isFile && /\.[cm]?ts$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('W0-11 runSync 不得经中间模块转出', () => {
  it('W0-11 src 里 exec.ts 以外的模块都不转出 runSync', async () => {
    const hits: string[] = [];
    const files = await sourceFiles(path.join(REPO_ROOT, 'src'));
    expect(files.length).toBeGreaterThan(50);
    for (const f of files) {
      if (f === `${EXEC}.ts`) continue;
      for (const r of runSyncRelays(f, await readText(f))) hits.push(`${f}: ${r}`);
    }
    expect(hits).toEqual([]);
  });

  it('W0-11 检测器的反向对照:各种转出写法都能识别,只导入并调用不算', () => {
    const f = path.join(REPO_ROOT, 'src/git-bridge.ts');
    const X = './io/exec.js';
    for (const bad of [
      `export { runSync } from '${X}';`,
      `export { runSync as r } from '${X}';`,
      `export * from '${X}';`,
      `export * as e from '${X}';`,
      `import { runSync } from '${X}';\nexport { runSync };`,
      `import { runSync as r } from '${X}';\nexport { r as s };`,
      `import { runSync } from '${X}';\nexport const r = runSync;`,
      `import { runSync } from '${X}';\nexport default runSync;`,
      `import * as e from '${X}';\nexport const r = e.runSync;`,
      `import * as e from '${X}';\nexport { e };`,
    ]) {
      expect(runSyncRelays(f, bad).length, bad).toBeGreaterThan(0);
    }
    for (const good of [
      `import { runSync } from '${X}';\nrunSync('git', []);`,
      `export { runSelf } from '${X}';`,
      `export { runSync } from './other.js';`,
    ]) {
      expect(runSyncRelays(f, good), good).toEqual([]);
    }
  });
});
