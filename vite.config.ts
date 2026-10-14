import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

/**
 * 第三方 CJS 包里的 `require('path')` / `import 'fs'` 一律改写成 `node:` 形态并保持 external,
 * 这样 dist 里的 specifier 只剩 `node:*` 与相对路径(发布闸 BUNDLE_BARE_SPECIFIER 的判据)。
 */
const nodePrefixBuiltins: Plugin = {
  name: 'agent-kit:node-prefix-builtins',
  enforce: 'pre',
  resolveId(id) {
    if (id.startsWith('node:')) return { id, external: true };
    if (builtinModules.includes(id)) return { id: `node:${id}`, external: true };
    return null;
  },
};

/**
 * 依赖树里「在 try/catch 里可选 require」的包(`debug` 的 supports-color):不打进来、也不能留成运行期按用户机器
 * node_modules 解析的裸 specifier。固定解析成一个空模块,行为等同「没装」(只影响调试日志的颜色档位)。
 */
const ABSENT_OPTIONAL = new Set(['supports-color']);
const absentOptional: Plugin = {
  name: 'agent-kit:absent-optional',
  enforce: 'pre',
  resolveId(id) {
    return ABSENT_OPTIONAL.has(id) ? `\0absent-optional:${id}` : null;
  },
  load(id) {
    return id.startsWith('\0absent-optional:') ? 'export default {};' : null;
  },
};

/**
 * 发布产物打包(S7b;docs/contracts.md §19.9)。`vite build` 走 SSR/library 模式(rolldown),
 * 把全部运行时依赖(zod / yaml / smol-toml / 完整 sigstore 依赖树)打进 dist,发布包 `dependencies` 为空。
 *
 * 产物结构:
 *  - `dist/cli.js`   薄入口(bin;shebang;只 `import` 主程序)。S7c 的启动器替换的就是它。
 *  - `dist/main.js`  主程序 chunk(src/cli.ts 及其静态依赖)。启动时由 cli.js 一次性静态加载,不做惰性 import
 *                    (老进程跑着时它所在的版本目录可能被 gc,惰性 import 会 ENOENT;备忘录 §3)。
 *  - `dist/chunks/*` 动态 `import('sigstore')` 拆出的 chunk:验签前不加载,不拖慢冷启动,但已打进产物(没有裸 specifier)。
 *  - `dist/THIRD_PARTY_LICENSES` 由 scripts/gen-third-party-licenses.mjs 生成。
 *
 * 不压缩(可审计、可读栈);不产 sourcemap(体积;发布闸仍会扫描 dist 里出现的任何 .map)。
 * 确定性:rolldown 单次构建输出与输入顺序无关,同输入两次产物字节相同(test/build/bundle.test.ts 钉死)。
 */
export default defineConfig({
  logLevel: 'warn',
  plugins: [nodePrefixBuiltins, absentOptional],
  build: {
    ssr: true,
    outDir: 'dist',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: false,
    copyPublicDir: false,
    rollupOptions: {
      input: { cli: 'cli.ts', main: 'src/cli.ts', provenance: 'src/update/provenance.ts' },
      output: {
        format: 'esm',
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
  ssr: {
    // 一个第三方包都不留在 node_modules 里:除 node:* 内建外全部打进 dist
    noExternal: true,
    target: 'node',
  },
});
