/**
 * R20-A0:自动 RSI 的 import 闭包闸(contracts §20.1 R20-1.1;§20.9 第 3 条 ①)。
 *
 * R20-1.1:从 `rsi poke`、`rsi hint`、`__rsi --background`、`rsi tick|status|projects|confirm|stop|purge` 各自的入口**分别**起算的
 * import 传递闭包,不得含 `src/io/llm-exec.ts`、`src/reflect/backends/**`、`src/io/net.ts`;又因现有启动器 `launcher.ts → install.ts → net.ts`,
 * 这些入口也不得经过 `launcher.ts` / `install.ts` / `registry.ts` / `provenance.ts`(也不得引入 `sigstore` 与任何 node 网络模块)。
 *
 * rsi 的入口文件(`src/rsi/**`)由后续块(A1–A3)才建,所以这里分两层:
 *  1) 现在就生效:零网络桥接 `src/update/self-spawn.ts` 本身,以及按契约列出的 poke / hint / worker / 前台命令**会用到的构件**
 *     (用虚拟入口文件模拟各入口的 import 清单,不落盘)。
 *  2) 随块生效:`src/rsi/` 下一旦出现入口文件(见 {@link REAL_ENTRY_CANDIDATES}),自动纳入同一条断言;后续块新增入口时必须把文件名加进那张表。
 * 依赖图用 TypeScript 编译器 API 取:静态 import、`export … from`、`import type`(偏保守,一并算)、字面量动态 `import()`、`import x = require()`。
 */
import * as path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { existsSync, readTextSync, realpathSync } from '../../src/io/read-fs.js';
import { REPO_ROOT } from '../helpers/tmp.js';

const ROOT = realpathSync(REPO_ROOT);

/** 契约 R20-1.1 + 启动器链:闭包里一个都不许有(相对仓库根的路径) */
const FORBIDDEN_FILES: readonly string[] = [
  'src/io/net.ts',
  'src/io/llm-exec.ts',
  'src/update/launcher.ts',
  'src/update/install.ts',
  'src/update/registry.ts',
  'src/update/provenance.ts',
];
const FORBIDDEN_PREFIXES: readonly string[] = ['src/reflect/backends/'];
/** 网络相关的外部说明符(含 node: 前缀与子路径) */
const NET_EXTERNALS = ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'undici', 'ws'];
const FORBIDDEN_EXTERNAL = (spec: string): boolean => {
  const bare = spec.replace(/^node:/, '');
  const head = bare.split('/')[0] as string;
  return NET_EXTERNALS.includes(head) || head === 'sigstore' || spec.startsWith('@sigstore/');
};

/** 随块生效的真实入口候选(后续块建出对应文件后自动被检查) */
const REAL_ENTRY_CANDIDATES: readonly string[] = [
  'src/rsi/poke.ts',
  'src/rsi/hint.ts',
  'src/rsi/worker.ts',
  'src/rsi/tick.ts',
  'src/rsi/status.ts',
  'src/rsi/projects.ts',
  'src/rsi/confirm.ts',
  'src/rsi/stop.ts',
  'src/rsi/purge.ts',
  'src/rsi/index.ts',
  'src/commands/rsi.ts',
];

type Virtual = Readonly<Record<string, string>>;

function specifiersOf(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteralLike(n.moduleSpecifier)) {
      out.push(n.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(n) &&
      n.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(n.moduleSpecifier)
    ) {
      out.push(n.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(n) &&
      ts.isExternalModuleReference(n.moduleReference) &&
      ts.isStringLiteralLike(n.moduleReference.expression)
    ) {
      out.push(n.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ImportKeyword &&
      n.arguments[0] !== undefined &&
      ts.isStringLiteralLike(n.arguments[0])
    ) {
      out.push(n.arguments[0].text);
    } else if (
      ts.isImportTypeNode(n) &&
      ts.isLiteralTypeNode(n.argument) &&
      ts.isStringLiteralLike(n.argument.literal)
    ) {
      out.push(n.argument.literal.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function resolveRelative(fromAbs: string, spec: string): string | undefined {
  const base = path.resolve(path.dirname(fromAbs), spec);
  const cands = [base.replace(/\.js$/, '.ts'), `${base}.ts`, path.join(base, 'index.ts')];
  return cands.find((c) => c.endsWith('.ts') && existsSync(c));
}

interface Closure {
  files: Set<string>;
  externals: Set<string>;
  unresolved: string[];
}

/** 传递闭包。`virtual` 里的文件(键为相对仓库根的路径)用给定源码,不读盘。 */
function closureOf(entries: readonly string[], virtual: Virtual = {}): Closure {
  const files = new Set<string>();
  const externals = new Set<string>();
  const unresolved: string[] = [];
  const queue = entries.map((e) => path.join(ROOT, e));
  while (queue.length > 0) {
    const abs = queue.pop() as string;
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    if (files.has(rel)) continue;
    files.add(rel);
    const source = virtual[rel] ?? readTextSync(abs);
    for (const spec of specifiersOf(abs, source)) {
      if (spec.startsWith('.')) {
        const r = resolveRelative(abs, spec);
        if (r === undefined) unresolved.push(`${rel} -> ${spec}`);
        else queue.push(r);
      } else {
        externals.add(spec);
      }
    }
  }
  return { files, externals, unresolved };
}

function violations(c: Closure): string[] {
  const bad: string[] = [];
  for (const f of c.files) {
    if (FORBIDDEN_FILES.includes(f) || FORBIDDEN_PREFIXES.some((p) => f.startsWith(p))) {
      bad.push(`file:${f}`);
    }
  }
  for (const e of c.externals) if (FORBIDDEN_EXTERNAL(e)) bad.push(`external:${e}`);
  return bad.sort();
}

/** 用若干 import 行拼一个虚拟入口(放在 src/rsi/ 下,相对说明符与未来真实入口一致) */
function entry(name: string, imports: readonly string[]): { path: string; source: string } {
  return {
    path: `src/rsi/__sim_${name}.ts`,
    source: `${imports.map((i, k) => `import * as m${k} from '${i}';`).join('\n')}\nexport const x = [${imports
      .map((_, k) => `m${k}`)
      .join(',')}];\n`,
  };
}

const IO = ['../io/paths.js', '../io/read-fs.js', '../io/safe-fs.js', '../io/canonical-json.js'];
const BRIDGE = '../update/self-spawn.js';
const COLLECT = [
  '../signals/collect.js',
  '../signals/pipeline.js',
  '../signals/readers.js',
  '../signals/state-store.js',
  '../signals/exclude.js',
  '../redact/index.js',
  '../readers/claude/index.js',
  '../readers/codex/index.js',
  '../readers/pi/index.js',
];

/** 契约 R20-1.1 点名的各入口会用到的构件(poke / hint 只需桥接与 io;worker / 前台还要采集与脱敏) */
const SIMULATED = {
  'rsi poke': entry('poke', [BRIDGE, ...IO, '../contracts/exit-codes.js', '../contracts/rsi.js']),
  'rsi hint': entry('hint', [...IO, '../contracts/rsi.js']),
  '__rsi --background': entry('worker', [...IO, ...COLLECT, BRIDGE]),
  'rsi tick|status|projects|confirm|stop|purge': entry('front', [
    ...IO,
    ...COLLECT,
    '../commands/types.js',
    '../contracts/exit-codes.js',
  ]),
} as const;

describe('R20-1.1 import 闭包:零网络桥接', () => {
  it('src/update/self-spawn.ts 的闭包不含 net / install / registry / provenance / launcher / llm-exec / reflect 后端,也不含网络与 sigstore 外部模块', () => {
    const c = closureOf(['src/update/self-spawn.ts']);
    expect(c.unresolved).toEqual([]);
    expect(violations(c)).toEqual([]);
    // 正向:确实走到了 runSelf 所在的 io/exec(闭包不是空的)
    expect(c.files.has('src/io/exec.ts')).toBe(true);
    expect(c.files.has('src/update/self-spawn.ts')).toBe(true);
  });

  it('桥接不引用 home-fs(HOME 写出口)—— 它只 spawn,不写', () => {
    expect(closureOf(['src/update/self-spawn.ts']).files.has('src/io/home-fs.ts')).toBe(false);
  });
});

describe('R20-1.1 import 闭包:从各入口分别起算', () => {
  for (const [name, e] of Object.entries(SIMULATED)) {
    it(`${name}:模拟入口的闭包干净`, () => {
      const c = closureOf([e.path], { [e.path]: e.source });
      expect(c.unresolved).toEqual([]);
      expect(violations(c), name).toEqual([]);
      // 每个模拟入口都真的拉进了它声明的构件(防止空跑)
      expect(c.files.size).toBeGreaterThan(5);
    });
  }

  it('随块生效:src/rsi/ 下已存在的真实入口文件同样要求闭包干净', () => {
    const present = REAL_ENTRY_CANDIDATES.filter((f) => existsSync(path.join(ROOT, f)));
    for (const f of present) {
      const c = closureOf([f]);
      expect(c.unresolved, f).toEqual([]);
      expect(violations(c), f).toEqual([]);
    }
  });
});

describe('闭包检查器自身的对照(证明上面的"干净"不是检查器漏看)', () => {
  it('现有启动器入口的闭包确实含 net / install / registry / provenance(正向对照)', () => {
    const bad = violations(closureOf(['src/update/launcher.ts']));
    for (const f of [
      'file:src/io/net.ts',
      'file:src/update/install.ts',
      'file:src/update/registry.ts',
      'file:src/update/provenance.ts',
    ]) {
      expect(bad).toContain(f);
    }
    expect(bad).toContain('external:sigstore');
  });

  it('根 CLI 入口 src/cli.ts 的闭包含 llm-exec 与 reflect 后端(这就是 rsi 入口不能经过它的原因)', () => {
    const bad = violations(closureOf(['src/cli.ts']));
    expect(bad).toContain('file:src/io/llm-exec.ts');
    expect(bad.some((b) => b.startsWith('file:src/reflect/backends/'))).toBe(true);
  });

  const SNEAK: Record<string, [string[], string]> = {
    '静态 import net.ts': [[`import * as n from '../io/net.js';`], 'file:src/io/net.ts'],
    'export * from net.ts': [[`export * from '../io/net.js';`], 'file:src/io/net.ts'],
    '字面量动态 import() net.ts': [
      [`export const l = () => import('../io/net.js');`],
      'file:src/io/net.ts',
    ],
    经启动器间接引入: [
      [`import { launchCurrent } from '../update/launcher.js';`],
      'file:src/io/net.ts',
    ],
    '经 install.ts 间接引入': [
      [`import { SHARE_REL } from '../update/install.js';`],
      'file:src/io/net.ts',
    ],
    '引入 llm-exec': [[`import { runLlm } from '../io/llm-exec.js';`], 'file:src/io/llm-exec.ts'],
    '引入 reflect 后端': [
      [`import * as b from '../reflect/backends/index.js';`],
      'file:src/reflect/backends/index.ts',
    ],
    'node:https': [[`import { request } from 'node:https';`], 'external:node:https'],
    'node:net 子路径写法': [[`import { x } from 'dns/promises';`], 'external:dns/promises'],
    sigstore: [[`import { verify } from 'sigstore';`], 'external:sigstore'],
    'import type 也算': [[`import type { X } from '../io/net.js';`], 'file:src/io/net.ts'],
  };
  for (const [name, [lines, expected]] of Object.entries(SNEAK)) {
    it(`抓得到:${name}`, () => {
      const src = `${lines.join('\n')}\n`;
      const p = 'src/rsi/__sim_sneak.ts';
      const c = closureOf([p], { [p]: src });
      expect(violations(c)).toContain(expected);
    });
  }

  it('注释与字符串里的路径不算 import(不误报)', () => {
    const p = 'src/rsi/__sim_comment.ts';
    const src = `// import '../io/net.js'\n/* import('../io/net.js') */\nexport const s = "import x from '../io/net.js'";\n`;
    const c = closureOf([p], { [p]: src });
    expect(violations(c)).toEqual([]);
    expect(c.files.size).toBe(1);
  });
});
