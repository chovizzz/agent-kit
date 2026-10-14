/**
 * 打包产物(dist/)的发布闸(S7b):纯函数,输入是「相对路径 → 文本/字节」,不碰磁盘(读盘在 {@link readDist})。
 * check-publish.mjs 与 test/build/bundle*.test.ts 共用同一份实现,测试对每条原因码各有一个合法 / 违规夹具。
 *
 * 原因码(稳定,CI 日志与测试按它匹配):
 *   BUNDLE_DEPENDENCIES_NOT_EMPTY  package.json 的 dependencies 非空(运行时依赖必须全部打进 dist)
 *   BUNDLE_BARE_SPECIFIER          dist 里出现 `node:*` 与相对路径之外的 import / dynamic import / require 说明符
 *   BUNDLE_DYNAMIC_SPECIFIER       import() / require() 的参数不是字符串字面量(扫描无法判定去向)
 *   BUNDLE_PARSE_FAILED            dist 里的 .js 无法解析(无法扫描 = 不放行)
 *   BUNDLE_LICENSES_MISSING        缺 dist/THIRD_PARTY_LICENSES
 *   BUNDLE_LICENSE_UNCOVERED       产物里实际包含的第三方包没有出现在 THIRD_PARTY_LICENSES
 *   BUNDLE_LICENSE_INVALID         THIRD_PARTY_LICENSES 的条目缺许可证标识 / 正文;或包没附许可证文件、又不在已知名单里(须人工确认后加入 NO_LICENSE_FILE_OK)
 *   BUNDLE_PACKAGES_UNDETECTED     产物里识别不到应当被打包的关键依赖(region 注释被剥掉 = 许可证核对会空转)
 *   BUNDLE_NODE_MODULES            dist 里出现 node_modules 目录 / 文件路径,或符号链接
 *   BUNDLE_SOURCEMAP_LEAK          sourcemap 里有绝对路径 / 用户目录,或任何产物文本里出现 HOME 路径
 *   BUNDLE_INTEGRITY_COVERAGE      integrity.json 没覆盖 dist 下的某个文件
 *   BUNDLE_ENTRY                   bin 指向的入口缺失 / 没有 shebang / 不是薄入口
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import * as path from 'node:path';
import { parseAst } from 'vite';

export const LICENSES_FILE = 'dist/THIRD_PARTY_LICENSES';
/** 产物里一定要有的第三方包;识别不到说明 region 注释被剥掉或打包配置回退了 */
export const EXPECTED_BUNDLED = [
  'zod',
  'yaml',
  'smol-toml',
  'sigstore',
  '@sigstore/verify',
  'tuf-js',
];
/** 薄入口(S7c 启动器会替换它)的体积上限:超过说明主程序被内联进了入口 */
export const THIN_ENTRY_MAX_BYTES = 8192;

/** @param {string | Buffer | Uint8Array} x */
const asText = (x) => (typeof x === 'string' ? x : Buffer.from(x).toString('utf8'));

/** 说明符是否放行:`node:*`(且是真实内建)或相对路径(`./`、`../`) */
export function specifierAllowed(spec) {
  if (spec.startsWith('node:')) return isBuiltin(spec);
  return spec.startsWith('./') || spec.startsWith('../');
}

function walk(node, visit) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (typeof node.type === 'string') visit(node);
  for (const k of Object.keys(node)) if (k !== 'parent') walk(node[k], visit);
}

/**
 * 用 AST(不是正则)找出一份 JS 里所有的模块说明符:静态 import / export-from、import()、`require()` / `__require()`、
 * `require.resolve()` / `import.meta.resolve()`。参数不是字符串字面量时 spec 为 null(调用方按 BUNDLE_DYNAMIC_SPECIFIER 处理)。
 * @returns {{ kind: 'import' | 'export' | 'dynamic-import' | 'require', spec: string | null }[]}
 */
export function scanSpecifiers(code, filename = 'x.js') {
  const ast = parseAst(code, { lang: 'js', sourceType: 'module' }, filename);
  const out = [];
  const lit = (n) => (n && n.type === 'Literal' && typeof n.value === 'string' ? n.value : null);
  walk(ast, (n) => {
    if (n.type === 'ImportDeclaration') out.push({ kind: 'import', spec: lit(n.source) });
    else if (n.type === 'ExportAllDeclaration' || n.type === 'ExportNamedDeclaration') {
      if (n.source) out.push({ kind: 'export', spec: lit(n.source) });
    } else if (n.type === 'ImportExpression') {
      out.push({ kind: 'dynamic-import', spec: lit(n.source) });
    } else if (n.type === 'CallExpression') {
      const c = n.callee;
      // createRequire(import.meta.url)('zod') —— 以 createRequire 的返回值当 require 用
      const viaCreateRequire =
        c.type === 'CallExpression' &&
        c.callee.type === 'Identifier' &&
        c.callee.name === 'createRequire';
      const isModuleRequire =
        c.type === 'MemberExpression' &&
        c.object.type === 'Identifier' &&
        c.object.name === 'module' &&
        c.property.type === 'Identifier' &&
        c.property.name === 'require';
      const isReq =
        viaCreateRequire ||
        isModuleRequire ||
        (c.type === 'Identifier' && (c.name === 'require' || c.name === '__require')) ||
        (c.type === 'MemberExpression' &&
          c.object.type === 'Identifier' &&
          (c.object.name === 'require' || c.object.name === '__require') &&
          c.property.type === 'Identifier' &&
          c.property.name === 'resolve') ||
        (c.type === 'MemberExpression' &&
          c.object.type === 'MetaProperty' &&
          c.property.type === 'Identifier' &&
          c.property.name === 'resolve');
      if (isReq) out.push({ kind: 'require', spec: lit(n.arguments[0]) });
    }
  });
  return out;
}

/**
 * 从产物里的 `//#region <path>` 注释找出被打进来的第三方包(rolldown 不压缩时保留;压缩 / 剥注释会让它空转,
 * 所以另有 BUNDLE_PACKAGES_UNDETECTED 兜底)。返回 Map<"name@version", 包目录相对路径>。
 * 版本取自 pnpm 路径里的 `name@version`;非 pnpm 布局取不到版本时用 `name@?`,由生成器读 package.json 补全。
 * @param {Iterable<string>} texts
 */
export function detectBundledPackages(texts) {
  const found = new Map();
  for (const text of texts) {
    for (const m of text.matchAll(/^\/\/#region (.+)$/gm)) {
      const p = m[1];
      const idx = p.lastIndexOf('node_modules/');
      if (idx < 0) continue;
      const rest = p.slice(idx + 'node_modules/'.length).split('/');
      const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
      if (!name || name.startsWith('.')) continue;
      const dir = p.slice(0, idx) + 'node_modules/' + name;
      const pnpm = /node_modules\/\.pnpm\/([^/]+)\/node_modules\//.exec(dir);
      let version = '?';
      if (pnpm) {
        const enc = pnpm[1].split('_')[0]; // 去掉 peer 后缀
        const at = enc.lastIndexOf('@');
        if (at > 0) version = enc.slice(at + 1);
      }
      found.set(`${name}@${version}`, dir);
    }
  }
  return found;
}

/** 解析 THIRD_PARTY_LICENSES:返回 [{ id: 'name@version', license, body }] */
export function parseLicenses(text) {
  const out = [];
  const re = /^== (\S+@\S+) \(([^)\n]*)\) ==$/gm;
  const heads = [...text.matchAll(re)];
  heads.forEach((h, i) => {
    const start = h.index + h[0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index : text.length;
    out.push({ id: h[1], license: h[2].trim(), body: text.slice(start, end).trim() });
  });
  return out;
}

/**
 * 已知「npm 发布物不带 LICENSE 文件」的包:生成器退而记录其 package.json 的声明(见 gen-third-party-licenses.mjs)。
 * 名单外的包出现同样情况会红 —— 要人工确认其许可证后才能加进来,而不是默默用元数据顶替许可证原文。
 */
export const NO_LICENSE_FILE_OK = ['@npmcli/agent', '@sigstore/verify', 'proxy-agent-negotiate'];
export const NO_LICENSE_FILE_MARKER = '(该包的 npm 发布物未附带许可证文件';

const ABS_PATH_RE = /^(?:\/|file:|[A-Za-z]:[\\/]|\\\\)/;
const HOME_LIKE_RE = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[A-Za-z0-9._-]+/;

/**
 * 跑全部静态闸。
 * @param {{
 *   pkg: { dependencies?: Record<string, string>; bin?: string | Record<string, string> };
 *   files: Map<string, string | Uint8Array>;   // 键 = 包根相对路径(`dist/…`),只放 dist 下的文件
 *   symlinks?: string[];                        // dist 下的符号链接(相对路径)
 *   integrityPaths?: Iterable<string>;          // integrity.json 的 files[].path;不传 = 不核对覆盖(由调用方保证 integrity 存在)
 *   homeDir?: string;
 * }} input
 * @returns {{ code: string; path?: string; message: string }[]}
 */
export function checkBundle(input) {
  const v = [];
  const add = (code, message, p) =>
    v.push(p === undefined ? { code, message } : { code, path: p, message });
  const { pkg, files } = input;

  // 1) dependencies 必须为空
  const deps = Object.keys(pkg.dependencies ?? {});
  if (deps.length > 0)
    add(
      'BUNDLE_DEPENDENCIES_NOT_EMPTY',
      `dependencies 必须为空(全部打进 dist),现有:${deps.join(', ')}`,
    );

  const texts = new Map();
  for (const [rel, content] of files) texts.set(rel, asText(content));

  // 2) 路径形态:node_modules / 符号链接
  for (const rel of files.keys())
    if (rel.split('/').includes('node_modules'))
      add('BUNDLE_NODE_MODULES', 'dist 内出现 node_modules 路径', rel);
  for (const rel of input.symlinks ?? []) add('BUNDLE_NODE_MODULES', 'dist 内出现符号链接', rel);

  // 3) 说明符扫描(AST)
  for (const [rel, text] of texts) {
    if (!/\.(?:m?js|cjs)$/.test(rel)) continue;
    let specs;
    try {
      specs = scanSpecifiers(text, rel);
    } catch (e) {
      add('BUNDLE_PARSE_FAILED', `无法解析:${e instanceof Error ? e.message : String(e)}`, rel);
      continue;
    }
    for (const s of specs) {
      if (s.spec === null) add('BUNDLE_DYNAMIC_SPECIFIER', `${s.kind} 的参数不是字符串字面量`, rel);
      else if (!specifierAllowed(s.spec))
        add('BUNDLE_BARE_SPECIFIER', `${s.kind} '${s.spec}' 既不是 node:* 也不是相对路径`, rel);
    }
  }

  // 4) 许可证
  const licText = texts.get(LICENSES_FILE);
  const jsTexts = [...texts].filter(([rel]) => /\.(?:m?js|cjs)$/.test(rel)).map(([, t]) => t);
  const bundled = detectBundledPackages(jsTexts);
  const names = new Set([...bundled.keys()].map((k) => k.slice(0, k.lastIndexOf('@'))));
  for (const need of EXPECTED_BUNDLED)
    if (!names.has(need)) add('BUNDLE_PACKAGES_UNDETECTED', `产物里识别不到应被打包的 ${need}`);
  if (licText === undefined) {
    add('BUNDLE_LICENSES_MISSING', `缺 ${LICENSES_FILE}`);
  } else {
    const entries = parseLicenses(licText);
    const have = new Set(entries.map((e) => e.id));
    for (const id of bundled.keys()) {
      const nameOnly = id.slice(0, id.lastIndexOf('@'));
      const ok = id.endsWith('@?')
        ? entries.some((e) => e.id.startsWith(`${nameOnly}@`))
        : have.has(id);
      if (!ok)
        add(
          'BUNDLE_LICENSE_UNCOVERED',
          `产物包含 ${id},但 THIRD_PARTY_LICENSES 没有它`,
          LICENSES_FILE,
        );
    }
    for (const e of entries) {
      if (e.license === '' || /^(?:UNKNOWN|UNLICENSED)$/i.test(e.license))
        add('BUNDLE_LICENSE_INVALID', `${e.id} 缺许可证标识`, LICENSES_FILE);
      if (e.body === '') add('BUNDLE_LICENSE_INVALID', `${e.id} 缺许可证正文`, LICENSES_FILE);
      else if (
        e.body.startsWith(NO_LICENSE_FILE_MARKER) &&
        !NO_LICENSE_FILE_OK.includes(e.id.slice(0, e.id.lastIndexOf('@')))
      )
        add(
          'BUNDLE_LICENSE_INVALID',
          `${e.id} 没有许可证原文(只有 package.json 声明),且不在已确认名单里`,
          LICENSES_FILE,
        );
    }
  }

  // 5) sourcemap / HOME 泄漏(每个文件只报第一条原因,避免同一处泄漏被多个检查重复计数)
  for (const [rel, text] of texts) {
    let leaked = false;
    const leak = (message) => {
      if (leaked) return;
      leaked = true;
      add('BUNDLE_SOURCEMAP_LEAK', message, rel);
    };
    if (rel.endsWith('.map')) {
      let map;
      try {
        map = JSON.parse(text);
      } catch {
        leak('sourcemap 不是合法 JSON,无法核对');
        continue;
      }
      const paths = [...(Array.isArray(map.sources) ? map.sources : []), map.sourceRoot, map.file];
      for (const p of paths)
        if (typeof p === 'string' && (ABS_PATH_RE.test(p) || HOME_LIKE_RE.test(p)))
          leak(`sourcemap 含绝对路径 / 用户目录:${p}`);
    }
    const m = /\/\/# sourceMappingURL=(\S+)/.exec(text);
    if (m && (ABS_PATH_RE.test(m[1]) || HOME_LIKE_RE.test(m[1])))
      leak(`sourceMappingURL 含绝对路径:${m[1]}`);
    // 任何产物文本里的用户目录(合成占位 /Users/someone 是脱敏种子夹具,放行;与 check-publish 的绝对路径扫描同口径,并补上 /home/)
    for (const hm of text.matchAll(/\/(?:Users|home)\/([A-Za-z0-9._-]+)/g))
      if (hm[1] !== 'someone') {
        leak(`用户目录路径出现在产物里:${hm[0]}`);
        break;
      }
    if (input.homeDir && input.homeDir.length > 3 && text.includes(input.homeDir))
      leak('HOME 路径出现在产物里');
  }

  // 6) integrity 覆盖
  if (input.integrityPaths !== undefined) {
    const covered = new Set(input.integrityPaths);
    for (const rel of files.keys())
      if (!covered.has(rel)) add('BUNDLE_INTEGRITY_COVERAGE', 'integrity.json 没有覆盖该文件', rel);
  }

  // 7) bin 入口:存在、有 shebang、是薄入口
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['agent-kit'];
  if (bin === undefined) {
    add('BUNDLE_ENTRY', 'package.json 没有 bin.agent-kit');
  } else {
    const norm = bin.replace(/^\.\//, '');
    const entry = texts.get(norm);
    if (entry === undefined) add('BUNDLE_ENTRY', `bin 指向的 ${norm} 不在产物里`);
    else {
      if (!entry.startsWith('#!')) add('BUNDLE_ENTRY', '入口缺少 shebang', norm);
      if (Buffer.byteLength(entry) > THIN_ENTRY_MAX_BYTES)
        add(
          'BUNDLE_ENTRY',
          `入口超过 ${THIN_ENTRY_MAX_BYTES}B,不是薄入口(主程序应在另一个 chunk)`,
          norm,
        );
    }
  }
  return v;
}

/** 递归读 dist:返回 { files(相对包根,`dist/…`), symlinks } */
export function readDist(root, distRel = 'dist') {
  const files = new Map();
  const symlinks = [];
  const visit = (relDir) => {
    for (const name of readdirSync(path.join(root, relDir)).sort()) {
      const rel = `${relDir}/${name}`;
      const st = lstatSync(path.join(root, rel));
      if (st.isSymbolicLink()) symlinks.push(rel);
      else if (st.isDirectory()) visit(rel);
      else if (st.isFile()) files.set(rel, readFileSync(path.join(root, rel)));
    }
  };
  visit(distRel);
  return { files, symlinks };
}
