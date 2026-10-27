/**
 * 只读命令的静态审计工具(B3a;零写入第三层):用 TypeScript 编译器 API 取 import 传递闭包与每个文件里出现的**标识符**(不含注释)。
 * 说明符来源:静态 import / `export … from` / `import x = require()` / 动态 `import()`(字面量取说明符;非字面量记为违规 `dynamic:`)/ `require()` 调用。
 * `includeTypes = false` 只算运行时依赖(跳过 `import type` 与 `export type … from` 整句;内联 `type` 修饰的说明符不跳过——偏保守);
 * `true` 再把类型导入也算进来(更保守)。`virtual` 里的文件(键为相对仓库根的路径)用给定源码,不读盘。
 */
import * as path from 'node:path';
import ts from 'typescript';
import { existsSync, readTextSync, realpathSync } from '../../src/io/read-fs.js';
import { REPO_ROOT } from '../helpers/tmp.js';

export const ROOT = realpathSync(REPO_ROOT);

export interface Closure {
  files: Set<string>;
  externals: Set<string>;
  /** 每个文件里出现的标识符(AST Identifier,不含注释 / 字符串) */
  idents: Map<string, Set<string>>;
  /** 动态 import / require 等绕过静态闭包的写法(`<文件>:<写法>`) */
  dynamic: string[];
  unresolved: string[];
}

interface Scan {
  specs: string[];
  idents: Set<string>;
  dynamic: string[];
}

function scan(file: string, source: string, includeTypes: boolean): Scan {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specs: string[] = [];
  const idents = new Set<string>();
  const dynamic: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) idents.add(n.text);
    if (ts.isImportDeclaration(n) && ts.isStringLiteralLike(n.moduleSpecifier)) {
      if (includeTypes || !n.importClause?.isTypeOnly) specs.push(n.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(n) &&
      n.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(n.moduleSpecifier)
    ) {
      if (includeTypes || !n.isTypeOnly) specs.push(n.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(n) &&
      ts.isExternalModuleReference(n.moduleReference) &&
      ts.isStringLiteralLike(n.moduleReference.expression)
    ) {
      specs.push(n.moduleReference.expression.text);
    } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const a = n.arguments[0];
      if (a !== undefined && ts.isStringLiteralLike(a)) specs.push(a.text);
      else dynamic.push(`${file}:import()`);
    } else if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'require'
    ) {
      dynamic.push(`${file}:require()`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { specs, idents, dynamic };
}

function resolveRelative(
  fromAbs: string,
  spec: string,
  virtual: Readonly<Record<string, string>>,
): string | undefined {
  const base = path.resolve(path.dirname(fromAbs), spec);
  const cands = [base.replace(/\.js$/, '.ts'), `${base}.ts`, path.join(base, 'index.ts')];
  const relOf = (c: string): string => path.relative(ROOT, c).split(path.sep).join('/');
  return cands.find((c) => c.endsWith('.ts') && (relOf(c) in virtual || existsSync(c)));
}

export function closureOf(
  entries: readonly string[],
  opts: { includeTypes?: boolean; virtual?: Readonly<Record<string, string>> } = {},
): Closure {
  const includeTypes = opts.includeTypes ?? false;
  const virtual = opts.virtual ?? {};
  const c: Closure = {
    files: new Set(),
    externals: new Set(),
    idents: new Map(),
    dynamic: [],
    unresolved: [],
  };
  const queue = entries.map((e) => path.join(ROOT, e));
  while (queue.length > 0) {
    const abs = queue.pop() as string;
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    if (c.files.has(rel)) continue;
    c.files.add(rel);
    const s = scan(abs, virtual[rel] ?? readTextSync(abs), includeTypes);
    c.idents.set(rel, s.idents);
    c.dynamic.push(...s.dynamic.map((d) => d.replace(abs, rel)));
    for (const spec of s.specs) {
      if (spec.startsWith('.')) {
        const r = resolveRelative(abs, spec, virtual);
        if (r === undefined) c.unresolved.push(`${rel} -> ${spec}`);
        else queue.push(r);
      } else {
        c.externals.add(`${spec}\u0000${rel}`);
      }
    }
  }
  return c;
}

/** 外部说明符(去掉「谁引入的」后缀) */
export const externalSpecs = (c: Closure): string[] =>
  [...new Set([...c.externals].map((e) => e.split('\u0000')[0] as string))].sort();

/** 哪些闭包文件引入了某个外部说明符 */
export const importersOf = (c: Closure, spec: string): string[] =>
  [...c.externals]
    .filter((e) => e.startsWith(`${spec}\u0000`))
    .map((e) => e.split('\u0000')[1] as string)
    .sort();

/** 闭包里哪些文件出现了这些标识符之一(`<文件>:<标识符>`) */
export function identHits(c: Closure, names: readonly string[]): string[] {
  const out: string[] = [];
  for (const [f, ids] of c.idents) for (const n of names) if (ids.has(n)) out.push(`${f}:${n}`);
  return out.sort();
}

/** 写类 fs API 的属性名(任何对象上的这些成员调用 / 引用都算) */
const FS_WRITE_NAMES = new Set([
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'rename',
  'renameSync',
  'unlink',
  'unlinkSync',
  'rm',
  'rmSync',
  'rmdir',
  'rmdirSync',
  'mkdir',
  'mkdirSync',
  'mkdtemp',
  'mkdtempSync',
  'truncate',
  'truncateSync',
  'ftruncate',
  'ftruncateSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'symlink',
  'symlinkSync',
  'link',
  'linkSync',
  'chmod',
  'chmodSync',
  'fchmod',
  'chown',
  'chownSync',
  'utimes',
  'utimesSync',
  'futimes',
  'createWriteStream',
  'write',
  'writeSync',
  'writev',
  'writevSync',
]);
const WRITE_FLAG_RE = /O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND|O_EXCL/;

/**
 * 一个源文件里的「直接写」用法(AST):写类 fs 成员(`x.writeFile` 之类),以及 `open` / `openSync` 的 flags 里出现写标志、
 * 字符串模式(`'w'` / `'a'` / `'r+'`…)或缺少 `O_RDONLY`。返回 `<行>:<写法>` 列表。
 */
export function fsWriteUses(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const line = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n) && FS_WRITE_NAMES.has(n.name.text)) {
      out.push(`${line(n)}:.${n.name.text}`);
    }
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      (n.expression.name.text === 'open' || n.expression.name.text === 'openSync')
    ) {
      const flags = n.arguments[1];
      const text = flags?.getText(sf) ?? '';
      if (
        flags === undefined ||
        WRITE_FLAG_RE.test(text) ||
        ts.isStringLiteralLike(flags) ||
        !text.includes('O_RDONLY')
      ) {
        out.push(`${line(n)}:open(${text})`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
