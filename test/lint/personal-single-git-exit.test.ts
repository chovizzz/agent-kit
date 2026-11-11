/**
 * §21.24 W0-11 / W2:私有仓库「唯一 git 出口」的机械保证——除授权文件外,`src/rsi/**` 里任何文件 import `runSync` → lint 红。
 * 三层:① 真实源码的 AST 扫描(谁在 import runSync / 命名空间 / 再导出);② eslint 违例夹具(同一份代码放进授权与非授权路径);
 * ③ W2 自己的源码与测试在真实 eslint 配置下全绿(home-fs 授权只给 personal/**,read/ 与 judge-signal.ts 收回)。
 */
import * as path from 'node:path';
import { ESLint } from 'eslint';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { readDir, readText } from '../../src/io/read-fs.js';
import { REPO_ROOT } from '../helpers/tmp.js';

const ALLOWED = [
  'src/rsi/personal/commit.ts',
  'src/rsi/personal/commit-journal.ts',
  'src/rsi/personal/repo-check.ts',
];
/** hooks 目录保持既有放行(不在自动入口闭包内,contracts §21.24 W0-11) */
const HOOKS_PREFIX = 'src/rsi/hooks/';

async function walk(rel: string, out: string[]): Promise<void> {
  for (const e of await readDir(path.join(REPO_ROOT, rel))) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory) await walk(r, out);
    else if (e.isFile && r.endsWith('.ts')) out.push(r);
  }
}

const isExecSpec = (spec: string): boolean => /(^|\/)io\/exec(\.[cm]?[jt]s)?$/.test(spec);

/** 该文件是否能拿到 `runSync`:命名导入(含别名)/ 命名空间 / 默认导入、`export * from` / `export { runSync } from`、动态 import;仅类型导入与别的命名导入(如 RUN_SELF_ENV_PICK_RE)不算 */
function importsRunSync(file: string, src: string): boolean {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let hit = false;
  const visit = (n: ts.Node): void => {
    if (
      ts.isImportDeclaration(n) &&
      ts.isStringLiteralLike(n.moduleSpecifier) &&
      isExecSpec(n.moduleSpecifier.text) &&
      n.importClause !== undefined &&
      !n.importClause.isTypeOnly
    ) {
      const b = n.importClause.namedBindings;
      if (n.importClause.name !== undefined) hit = true;
      if (b !== undefined && ts.isNamespaceImport(b)) hit = true;
      if (b !== undefined && ts.isNamedImports(b)) {
        for (const e of b.elements) {
          if (!e.isTypeOnly && (e.propertyName ?? e.name).text === 'runSync') hit = true;
        }
      }
    }
    if (
      ts.isExportDeclaration(n) &&
      n.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(n.moduleSpecifier) &&
      isExecSpec(n.moduleSpecifier.text) &&
      !n.isTypeOnly
    ) {
      const c = n.exportClause;
      if (c === undefined || ts.isNamespaceExport(c)) hit = true;
      else if (c.elements.some((e) => (e.propertyName ?? e.name).text === 'runSync')) hit = true;
    }
    if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ImportKeyword &&
      n.arguments[0] !== undefined &&
      ts.isStringLiteralLike(n.arguments[0]) &&
      isExecSpec(n.arguments[0].text)
    ) {
      hit = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hit;
}

describe('私有仓库唯一 git 出口:真实源码扫描', () => {
  it('src/rsi/** 里能拿到 runSync 的文件 ⊆ {personal/commit.ts, commit-journal.ts, repo-check.ts} ∪ hooks/**;repo-check.ts 确实在列(扫描不空转)', async () => {
    const files: string[] = [];
    await walk('src/rsi', files);
    expect(files.length).toBeGreaterThan(30);
    const touching: string[] = [];
    for (const f of files) {
      if (importsRunSync(f, await readText(path.join(REPO_ROOT, f)))) touching.push(f);
    }
    expect(touching).toContain('src/rsi/personal/repo-check.ts');
    const stray = touching.filter((f) => !ALLOWED.includes(f) && !f.startsWith(HOOKS_PREFIX));
    expect(stray).toEqual([]);
  });

  it('扫描器自检:命名导入 / 命名空间 / re-export / 动态 import 都会被认出;仅类型导入不算', () => {
    const t = (code: string): boolean => importsRunSync('x.ts', code);
    expect(t("import { runSync } from '../io/exec.js';")).toBe(true);
    expect(t("import * as e from '../../io/exec';")).toBe(true);
    expect(t("export { runSync } from '../io/exec.js';")).toBe(true);
    expect(t("export const l = () => import('../io/exec.js');")).toBe(true);
    expect(t("import type { ExecResult } from '../io/exec.js';")).toBe(false);
    expect(t("import { RUN_SELF_ENV_PICK_RE } from '../io/exec.js';")).toBe(false);
    expect(t("import { runSync as git } from '../io/exec.js';")).toBe(true);
    expect(t("import { x } from '../io/exec-other.js';")).toBe(false);
  });
});

describe('违例夹具(真实 eslint 配置)', () => {
  const eslint = new ESLint({ cwd: REPO_ROOT });
  const lintAs = async (code: string, rel: string) => {
    const [res] = await eslint.lintText(code, { filePath: path.join(REPO_ROOT, rel) });
    return res!.messages.filter((m) => m.ruleId?.startsWith('no-restricted'));
  };
  const NAMED = "import { runSync } from '../io/exec.js';\nexport const r = runSync;\n";
  const NS = "import * as exec from '../io/exec.js';\nexport const r = exec;\n";
  const REEXPORT = "export { runSync } from '../io/exec.js';\n";

  it('授权的三个文件放行(正向对照)', async () => {
    for (const f of ALLOWED) expect(await lintAs(NAMED, f), f).toEqual([]);
  });

  it('其余 src/rsi/** —— 包括 personal/ 里的 home-state / personal-lock、read/、judge-signal、gates、命令入口、worker —— import runSync 即红', async () => {
    for (const bad of [
      'src/rsi/personal/home-state.ts',
      'src/rsi/personal/personal-lock.ts',
      'src/rsi/personal/commit-extra.ts',
      'src/rsi/personal/gates/g0.ts',
      'src/rsi/personal/read/candidate-read.ts',
      'src/rsi/personal/judge-signal.ts',
      'src/rsi/auto/status.ts',
      'src/rsi/hint.ts',
      'src/rsi/worker.ts',
    ]) {
      for (const [name, code] of [
        ['named', NAMED],
        ['namespace', NS],
        ['re-export', REEXPORT],
      ] as const) {
        expect((await lintAs(code, bad)).length, `${bad}: ${name}`).toBeGreaterThan(0);
      }
    }
  });

  it('W2 的源码与测试在真实配置下 lint 全绿(home-fs 只在 personal/** 授权)', async () => {
    const results = await eslint.lintFiles(['src/rsi/personal', 'test/rsi/personal', 'test/lint']);
    expect(results.length).toBeGreaterThan(8);
    const errors = results.flatMap((r) =>
      r.messages
        .filter((m) => m.severity === 2)
        .map((m) => `${path.relative(REPO_ROOT, r.filePath)}: ${m.ruleId} ${m.message}`),
    );
    expect(errors).toEqual([]);
  });
});
