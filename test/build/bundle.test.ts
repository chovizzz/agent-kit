import { describe, expect, it } from 'vitest';
import {
  EXPECTED_BUNDLED,
  LICENSES_FILE,
  NO_LICENSE_FILE_MARKER,
  NO_LICENSE_FILE_OK,
  THIN_ENTRY_MAX_BYTES,
  checkBundle,
  detectBundledPackages,
  parseLicenses,
  scanSpecifiers,
  specifierAllowed,
} from '../../scripts/lib/bundle-gate.mjs';

/**
 * 打包发布闸(S7b)的纯函数夹具:一份合法产物 + 每条原因码各一个违规。
 * 每个违规用例都先断言基线零违规(正向控制组),防止「基线本来就红」让负向断言空转。
 */

const SHEBANG_ENTRY =
  '#!/usr/bin/env node\nimport { main } from "./main.js";\nprocess.exitCode = await main([]);\n';

function regionFor(name: string, version: string): string {
  const file = `node_modules/.pnpm/${name.replace('/', '+')}@${version}/node_modules/${name}/index.js`;
  return `//#region ${file}\nvar x = 1;\n//#endregion\n`;
}

const PKG_VERSIONS: Record<string, string> = {
  zod: '4.6.5',
  yaml: '2.9.1',
  'smol-toml': '1.9.0',
  sigstore: '5.0.0',
  '@sigstore/verify': '4.1.2',
  'tuf-js': '6.0.0',
};

function licenses(over: Record<string, string> = {}): string {
  return Object.entries({ ...PKG_VERSIONS, ...over })
    .map(([n, v]) => `== ${n}@${v} (MIT) ==\n\nMIT License text for ${n}\n`)
    .join('\n');
}

function validFiles(): Map<string, string> {
  const regions = Object.entries(PKG_VERSIONS)
    .map(([n, v]) => regionFor(n, v))
    .join('');
  return new Map<string, string>([
    ['dist/cli.js', SHEBANG_ENTRY],
    [
      'dist/main.js',
      `import fs from "node:fs";\nimport { a } from "./chunks/a.js";\nconst m = await import("./chunks/lazy.js");\nexport const main = () => [fs, a, m];\n${regions}`,
    ],
    ['dist/chunks/a.js', 'export const a = 1;\n'],
    ['dist/chunks/lazy.js', 'export default 2;\n'],
    [LICENSES_FILE, licenses()],
  ]);
}

const PKG = { bin: { 'agent-kit': 'dist/cli.js' } };
const codes = (v: { code: string }[]): string[] => v.map((x) => x.code);

function run(
  mut: (f: Map<string, string>) => void,
  extra: Partial<Parameters<typeof checkBundle>[0]> = {},
): { code: string; path?: string; message: string }[] {
  const files = validFiles();
  mut(files);
  return checkBundle({ pkg: PKG, files, ...extra });
}

function appendTo(file: string, text: string): (f: Map<string, string>) => void {
  return (f) => f.set(file, (f.get(file) as string) + text);
}

describe('bundle 闸:合法基线', () => {
  it('合法产物零违规', () => {
    expect(run(() => {})).toEqual([]);
  });
  it('integrity 覆盖完整、HOME 不在产物里时仍零违规', () => {
    const paths = [...validFiles().keys()];
    expect(run(() => {}, { integrityPaths: paths, homeDir: '/Users/someone-else' })).toEqual([]);
  });
});

describe('BUNDLE_DEPENDENCIES_NOT_EMPTY', () => {
  it('dependencies 非空 => 红;空对象 / 缺省 => 过', () => {
    const files = validFiles();
    const bad = checkBundle({ pkg: { ...PKG, dependencies: { zod: '4.6.5' } }, files });
    expect(codes(bad)).toEqual(['BUNDLE_DEPENDENCIES_NOT_EMPTY']);
    expect(bad[0]?.message).toContain('zod');
    expect(checkBundle({ pkg: { ...PKG, dependencies: {} }, files })).toEqual([]);
    expect(checkBundle({ pkg: PKG, files })).toEqual([]);
  });
});

describe('BUNDLE_BARE_SPECIFIER / BUNDLE_DYNAMIC_SPECIFIER(AST 扫描)', () => {
  it.each([
    ['静态 import', 'import z from "zod";\n'],
    ['静态 import 副作用', 'import "yaml";\n'],
    ['export-from', 'export { parse } from "smol-toml";\n'],
    ['export-all', 'export * from "sigstore";\n'],
    ['动态 import', 'const s = await import("sigstore");\n'],
    ['require', 'const z = require("zod");\n'],
    ['__require(rolldown 运行时)', 'const z = __require("zod");\n'],
    ['require.resolve', 'const z = require.resolve("zod");\n'],
    ['import.meta.resolve', 'const z = import.meta.resolve("zod");\n'],
    ['无 node: 前缀的内建', 'import fs from "fs";\n'],
    ['node: 前缀但不是内建', 'import z from "node:zod";\n'],
    ['createRequire(...)(x)', 'const z = createRequire(import.meta.url)("zod");\n'],
    ['module.require', 'const z = module.require("zod");\n'],
    ['绝对路径', 'import x from "/etc/x.js";\n'],
  ])('%s => BUNDLE_BARE_SPECIFIER', (_n, code) => {
    expect(codes(run(() => {}))).toEqual([]); // 正向控制
    const v = run(appendTo('dist/chunks/a.js', code));
    expect(codes(v)).toEqual(['BUNDLE_BARE_SPECIFIER']);
    expect(v[0]?.path).toBe('dist/chunks/a.js');
  });

  it('参数不是字符串字面量 => BUNDLE_DYNAMIC_SPECIFIER', () => {
    for (const code of ['import(name);\n', 'require(name);\n', 'import(`./x-${n}.js`);\n']) {
      const v = run(appendTo('dist/chunks/a.js', code));
      expect(codes(v)).toEqual(['BUNDLE_DYNAMIC_SPECIFIER']);
    }
  });

  it('node:* 与相对路径放行;注释 / 字符串 / 正则里的 `from "zod"` 不误报', () => {
    const v = run(
      appendTo(
        'dist/chunks/a.js',
        [
          'import os from "node:os";',
          'import b from "../chunks/lazy.js";',
          '// import z from "zod"; require("yaml")',
          '/* export * from "sigstore" */',
          "export const s = \"import x from 'zod'; require('yaml')\";",
          'export const r = /from "zod"/;',
          'export const t = `require("zod")`;',
          '',
        ].join('\n'),
      ),
    );
    expect(v).toEqual([]);
  });

  it('specifierAllowed 的边界', () => {
    expect(specifierAllowed('node:fs/promises')).toBe(true);
    expect(specifierAllowed('node:test')).toBe(true);
    expect(specifierAllowed('node:zod')).toBe(false);
    expect(specifierAllowed('./a.js')).toBe(true);
    expect(specifierAllowed('../a.js')).toBe(true);
    for (const s of ['fs', 'zod', '@sigstore/verify', '/abs.js', 'file:///x.js', 'nodefs'])
      expect(specifierAllowed(s)).toBe(false);
  });

  it('scanSpecifiers 返回各形态的 kind', () => {
    const r = scanSpecifiers(
      'import a from "./a.js"; export * from "./b.js"; await import("./c.js"); __require("node:fs");',
    );
    expect(r.map((x) => x.kind)).toEqual(['import', 'export', 'dynamic-import', 'require']);
  });

  it('产物不是合法 JS => BUNDLE_PARSE_FAILED(无法扫描 = 不放行)', () => {
    const v = run(appendTo('dist/chunks/a.js', 'import from from from;\n'));
    expect(codes(v)).toEqual(['BUNDLE_PARSE_FAILED']);
  });
});

describe('第三方许可证:BUNDLE_LICENSES_MISSING / UNCOVERED / INVALID / PACKAGES_UNDETECTED', () => {
  it('缺 THIRD_PARTY_LICENSES => BUNDLE_LICENSES_MISSING', () => {
    expect(codes(run(() => {}))).toEqual([]);
    expect(codes(run((f) => f.delete(LICENSES_FILE)))).toEqual(['BUNDLE_LICENSES_MISSING']);
  });

  it('产物包含的包没出现在许可证里 => BUNDLE_LICENSE_UNCOVERED(点名)', () => {
    const v = run(appendTo('dist/main.js', regionFor('left-pad', '1.3.0')));
    expect(codes(v)).toEqual(['BUNDLE_LICENSE_UNCOVERED']);
    expect(v[0]?.message).toContain('left-pad@1.3.0');
  });

  it('同名不同版本也要各自覆盖', () => {
    const v = run(appendTo('dist/main.js', regionFor('zod', '3.0.0')));
    expect(codes(v)).toEqual(['BUNDLE_LICENSE_UNCOVERED']);
    expect(v[0]?.message).toContain('zod@3.0.0');
  });

  it('许可证里的条目缺标识 / 缺正文 => BUNDLE_LICENSE_INVALID', () => {
    const noId = run((f) =>
      f.set(LICENSES_FILE, licenses().replace('zod@4.6.5 (MIT)', 'zod@4.6.5 (UNKNOWN)')),
    );
    expect(codes(noId)).toEqual(['BUNDLE_LICENSE_INVALID']);
    const noBody = run((f) => f.set(LICENSES_FILE, licenses() + '\n== extra@1.0.0 (MIT) ==\n\n'));
    expect(codes(noBody)).toEqual(['BUNDLE_LICENSE_INVALID']);
  });

  it('包没附许可证文件(只有 package.json 声明):名单内放行,名单外 => BUNDLE_LICENSE_INVALID', () => {
    const noFile = (n: string, v: string): string =>
      `\n== ${n}@${v} (Apache-2.0) ==\n\n${NO_LICENSE_FILE_MARKER};以下取自其 package.json)\nlicense: Apache-2.0\n`;
    const known = NO_LICENSE_FILE_OK[0] as string;
    const okV = run((f) => {
      f.set('dist/main.js', (f.get('dist/main.js') as string) + regionFor(known, '1.0.0'));
      f.set(LICENSES_FILE, licenses() + noFile(known, '1.0.0'));
    });
    expect(okV).toEqual([]);
    const bad = run((f) => {
      f.set('dist/main.js', (f.get('dist/main.js') as string) + regionFor('left-pad', '1.3.0'));
      f.set(LICENSES_FILE, licenses() + noFile('left-pad', '1.3.0'));
    });
    expect(codes(bad)).toEqual(['BUNDLE_LICENSE_INVALID']);
    expect(bad[0]?.message).toContain('left-pad@1.3.0');
  });

  it('region 注释被剥掉(识别不到关键依赖)=> BUNDLE_PACKAGES_UNDETECTED,而不是空转通过', () => {
    const v = run((f) =>
      f.set('dist/main.js', (f.get('dist/main.js') as string).replace(/\/\/#region .*/g, '')),
    );
    expect(codes(v)).toContain('BUNDLE_PACKAGES_UNDETECTED');
    expect(v.filter((x) => x.code === 'BUNDLE_PACKAGES_UNDETECTED')).toHaveLength(
      EXPECTED_BUNDLED.length,
    );
  });

  it('detectBundledPackages / parseLicenses 的解析', () => {
    const m = detectBundledPackages([
      regionFor('@sigstore/verify', '4.1.2') + regionFor('zod', '4.6.5') + '//#region src/cli.ts\n',
    ]);
    expect([...m.keys()].sort()).toEqual(['@sigstore/verify@4.1.2', 'zod@4.6.5']);
    expect(parseLicenses(licenses()).map((e) => e.id)).toContain('tuf-js@6.0.0');
  });
});

describe('BUNDLE_NODE_MODULES', () => {
  it('dist 内出现 node_modules 路径 / 符号链接 => 红', () => {
    expect(codes(run(() => {}))).toEqual([]);
    const a = run((f) => f.set('dist/node_modules/zod/index.js', 'export {};\n'));
    expect(codes(a)).toEqual(['BUNDLE_NODE_MODULES']);
    const b = run(() => {}, { symlinks: ['dist/link.js'] });
    expect(codes(b)).toEqual(['BUNDLE_NODE_MODULES']);
  });
});

describe('BUNDLE_SOURCEMAP_LEAK', () => {
  const map = (sources: string[], extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ version: 3, sources, mappings: '', ...extra });

  it('相对路径的 sourcemap 放行', () => {
    expect(run((f) => f.set('dist/main.js.map', map(['../src/cli.ts'])))).toEqual([]);
  });
  it.each([
    ['绝对 sources(POSIX)', map(['/Users/alice/work/agent-kit/src/cli.ts'])],
    ['绝对 sources(/home)', map(['/home/bob/x/src/cli.ts'])],
    ['file: URL', map(['file:///Users/alice/x.ts'])],
    ['sourceRoot', map(['a.ts'], { sourceRoot: '/Users/alice/work' })],
    ['Windows 路径', map(['C:\\Users\\alice\\x.ts'])],
  ])('%s => BUNDLE_SOURCEMAP_LEAK', (_n, body) => {
    const v = run((f) => f.set('dist/main.js.map', body));
    expect(codes(v)).toEqual(['BUNDLE_SOURCEMAP_LEAK']);
  });
  it('任何产物文本里的用户目录(不依赖 homeDir)=> 红;合成占位 /Users/someone 放行', () => {
    expect(run(appendTo('dist/chunks/a.js', '// seed /Users/someone/x\n'))).toEqual([]);
    for (const p of ['/home/runner/work', '/Users/alice/work']) {
      const v = run(appendTo('dist/chunks/a.js', `// built in ${p}\n`));
      expect(codes(v)).toEqual(['BUNDLE_SOURCEMAP_LEAK']);
    }
  });
  it('sourcemap 不是合法 JSON => 红(无法核对)', () => {
    expect(codes(run((f) => f.set('dist/main.js.map', '{oops')))).toEqual([
      'BUNDLE_SOURCEMAP_LEAK',
    ]);
  });
  it('sourceMappingURL 指向绝对路径 / HOME 出现在任何产物文本里 => 红', () => {
    expect(
      codes(run(appendTo('dist/chunks/a.js', '//# sourceMappingURL=/Users/alice/a.js.map\n'))),
    ).toEqual(['BUNDLE_SOURCEMAP_LEAK']);
    // 非 /Users|/home 形态的 HOME(例如 /var/lib/builder)只有 homeDir 子串检查能抓到
    const v = run(appendTo('dist/chunks/a.js', '// built in /var/lib/builder/work\n'), {
      homeDir: '/var/lib/builder',
    });
    expect(codes(v)).toEqual(['BUNDLE_SOURCEMAP_LEAK']);
  });
});

describe('BUNDLE_INTEGRITY_COVERAGE', () => {
  it('integrity.json 缺 dist 下任一文件 => 红(点名)', () => {
    const all = [...validFiles().keys()];
    expect(run(() => {}, { integrityPaths: all })).toEqual([]);
    const v = run(() => {}, { integrityPaths: all.filter((p) => p !== 'dist/chunks/lazy.js') });
    expect(codes(v)).toEqual(['BUNDLE_INTEGRITY_COVERAGE']);
    expect(v[0]?.path).toBe('dist/chunks/lazy.js');
  });
});

describe('BUNDLE_ENTRY(薄入口,为 S7c 启动器预留)', () => {
  it('入口缺失 / 无 shebang / 过大(内联了主程序)/ 没有 bin => 红', () => {
    expect(codes(run((f) => f.delete('dist/cli.js')))).toEqual(['BUNDLE_ENTRY']);
    expect(codes(run((f) => f.set('dist/cli.js', 'import "./main.js";\n')))).toEqual([
      'BUNDLE_ENTRY',
    ]);
    expect(
      codes(
        run((f) => f.set('dist/cli.js', SHEBANG_ENTRY + '//' + 'x'.repeat(THIN_ENTRY_MAX_BYTES))),
      ),
    ).toEqual(['BUNDLE_ENTRY']);
    expect(codes(checkBundle({ pkg: {}, files: validFiles() }))).toEqual(['BUNDLE_ENTRY']);
  });
});
