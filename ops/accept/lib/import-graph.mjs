// 静态 import 图(A22 用):从入口出发取传递闭包,只看仓库内的相对 import 与 node: / 裸模块说明符。
// 识别:`import … from 'x'`、`import 'x'`、`export … from 'x'`、`export * from 'x'`、动态 `import('x')`(字面量)。
// 先去掉注释与字符串外的行注释/块注释,避免把文档注释里的路径当成 import。
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 去掉行注释与块注释。已知局限:不识别正则字面量(`/\/\//` 这类含 `//` 的正则会被当成行注释吞掉本行后半截),
 * 这会让紧随其后、同一行上的 import 漏检(偏松)。三条命令的闭包里没有这种写法;新增此类写法时 A22 的对照 b 不会替你发现,
 * 需要人工留意。字符串里的 // 按字符串处理,不当注释。
 */
export function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const ch = src[i];
    const nx = src[i + 1];
    if (quote !== null) {
      out += ch;
      if (ch === '\\') {
        out += src[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '/' && nx === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && nx === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    out += ch;
    i++;
  }
  return out;
}

const SPEC_RES = [
  /\bimport\s+(?:type\s+)?[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})(?:\s+as\s+\w+)?\s*from\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** 一个文件里的全部 import 说明符(去重、保持出现顺序无关) */
export function specifiersOf(src) {
  const text = stripComments(src);
  const out = new Set();
  for (const re of SPEC_RES) for (const m of text.matchAll(re)) out.add(m[1]);
  return [...out].sort();
}

/** 相对说明符 -> 仓库内 .ts 文件的绝对路径(`./x.js` -> `./x.ts`;目录 -> index.ts);找不到返回 undefined */
export function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const cands = [base.replace(/\.js$/, '.ts'), `${base}.ts`, path.join(base, 'index.ts'), base];
  return cands.find((c) => c.endsWith('.ts') && fs.existsSync(c));
}

/**
 * 传递闭包。返回 { files: 相对 root 的 .ts 文件集合, externals: Map<说明符, 引用它的文件[]>, unresolved: [{from,spec}] }。
 * unresolved = 相对说明符解析不到仓库内文件(应为空;非空说明图不完整,调用方按失败处理)。
 */
export function closure(root, entries) {
  const files = new Set();
  const externals = new Map();
  const unresolved = [];
  const queue = entries.map((e) => path.resolve(root, e));
  while (queue.length > 0) {
    const f = queue.pop();
    const rel = path.relative(root, f).split(path.sep).join('/');
    if (files.has(rel)) continue;
    files.add(rel);
    const src = fs.readFileSync(f, 'utf8');
    for (const spec of specifiersOf(src)) {
      if (spec.startsWith('.')) {
        const r = resolveRelative(f, spec);
        if (r === undefined) unresolved.push({ from: rel, spec });
        else queue.push(r);
      } else {
        const arr = externals.get(spec) ?? [];
        arr.push(rel);
        externals.set(spec, arr);
      }
    }
  }
  return { files, externals, unresolved };
}

/** 网络 / 子进程相关的外部模块说明符(含 node: 前缀与裸写法) */
export const NET_MODULES = ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'undici', 'ws'];
export const CHILD_MODULES = ['child_process', 'cluster'];

const bare = (spec) => spec.replace(/^node:/, '');
export const isNetSpec = (spec) => NET_MODULES.includes(bare(spec).split('/')[0]);
export const isChildSpec = (spec) => CHILD_MODULES.includes(bare(spec));

/** 全局网络 API 的使用(fetch / WebSocket / XMLHttpRequest / EventSource)——源码级粗扫,偏保守 */
export function globalNetUses(src) {
  const text = stripComments(src);
  const hits = [];
  for (const m of text.matchAll(/(?<![\w.$])(fetch|WebSocket|XMLHttpRequest|EventSource)\s*\(/g))
    hits.push(m[1]);
  for (const m of text.matchAll(/\bnew\s+(WebSocket|XMLHttpRequest|EventSource)\b/g))
    hits.push(m[1]);
  return [...new Set(hits)];
}

/**
 * 对一组入口做 A22 的静态判据。返回问题数组(空 = 通过)与闭包:
 *  - 闭包不得含 forbiddenFiles 中的文件,或以 forbiddenPrefixes 之一开头的文件;
 *  - 闭包里 import child_process 的文件集合必须恰好等于 childAllow;
 *  - 闭包里不得 import 网络模块,不得使用全局网络 API;
 *  - 相对 import 必须全部解析得到。
 */
export function checkClosure(root, entries, opts) {
  const c = closure(root, entries);
  const problems = [];
  for (const f of c.files) {
    if (opts.forbiddenFiles.includes(f)) problems.push(`闭包含禁止文件 ${f}`);
    for (const p of opts.forbiddenPrefixes)
      if (f.startsWith(p)) problems.push(`闭包含禁止目录下的文件 ${f}`);
  }
  const child = new Set();
  for (const [spec, froms] of c.externals) {
    if (isChildSpec(spec)) for (const f of froms) child.add(f);
    if (isNetSpec(spec))
      problems.push(`闭包 import 了网络模块 ${spec}(${[...new Set(froms)].join(',')})`);
  }
  const got = [...child].sort();
  const want = [...opts.childAllow].sort();
  if (got.length !== want.length || got.some((x, i) => x !== want[i]))
    problems.push(`import child_process 的文件应恰为 [${want}],实际 [${got}]`);
  for (const f of c.files) {
    const uses = globalNetUses(fs.readFileSync(path.join(root, f), 'utf8'));
    if (uses.length > 0) problems.push(`${f} 使用了全局网络 API:${uses.join(',')}`);
  }
  for (const u of c.unresolved)
    problems.push(`${u.from} 的相对 import ${u.spec} 解析不到仓库内文件`);
  return { problems, files: c.files };
}
