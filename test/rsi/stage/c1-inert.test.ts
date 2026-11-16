/**
 * C1a:**生产惰性**与架构边界的证明(照 B1a `inert.test.ts`)——C1a 合并后:
 *  ① 没有任何生产入口(含 `worker.ts` / `hook-entry.ts` / `hint.ts` / 命令入口)的 import 闭包含 `src/rsi/personal/stage/**` 或 `judge-slot.ts`
 *     (类型导入也不含:`includeTypes` 两档都查)——不接线、没有注入点;
 *  ② 新模块顶层无副作用(只有声明;顶层初始化只允许冻结 / 空登记表的构造),且全部为纯逻辑:无 fs 写用法、不 import 任何写出口;
 *  ③ 依赖收敛:对锁句柄具体类型 / 存储核的依赖只在 `lock-identity.ts`(且不含 `src/rsi/store/**`);不复制 W9 判决逻辑(不 import judge 逻辑模块);
 *  ④ 回合内部状态只在 stage 目录内可达(`roundInternals` / `markRoundUnsettled` 的引用面);
 *  ⑤ 相位常量仍为 0。
 * 每条检查都有正向对照(违规的虚拟文件必须被同一检查报出)。
 */
import * as path from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { RSI_AUTO_PHASE } from '../../../src/contracts/rsi.js';
import { existsSync, readDir, readTextSync } from '../../../src/io/read-fs.js';
import { ROOT, closureOf, fsWriteUses } from '../closure-util.js';

vi.setConfig({ testTimeout: 120_000 });

const STAGE_DIR = 'src/rsi/personal/stage/';
/** 本块的全部新模块(冻结清单;`stage/` 目录新增文件必须同步登记——下面的自检会对照真实目录) */
const NEW_FILES: string[] = [
  'errors.ts',
  'fallback.ts',
  'growth.ts',
  'lock-identity.ts',
  'monitoring.ts',
  'ports.ts',
  'round.ts',
  'settle.ts',
  'taint-types.ts',
  'types.ts',
]
  .map((f) => `${STAGE_DIR}${f}`)
  .concat(['src/rsi/personal/judge-slot.ts']);

const ENTRIES = [
  'cli.ts',
  'src/cli.ts',
  'src/commands/rsi.ts',
  'src/rsi/poke.ts',
  'src/rsi/hint.ts',
  'src/rsi/worker.ts',
  'src/rsi/hook-entry.ts',
  'src/rsi/auto/commands.ts',
  'src/rsi/auto/entry.ts',
  'src/rsi/auto/deps-write.ts',
  'src/rsi/personal/candidate-step.ts',
].filter((f) => existsSync(path.join(ROOT, f)));

const isNew = (f: string): boolean =>
  f.startsWith(STAGE_DIR) || f === 'src/rsi/personal/judge-slot.ts';

describe('生产惰性(C1a)', () => {
  it('新模块清单与真实目录一致(自检:不会漏扫新增文件)', async () => {
    const real = (await readDir(path.join(ROOT, STAGE_DIR)))
      .filter((e) => e.isFile && e.name.endsWith('.ts'))
      .map((e) => `${STAGE_DIR}${e.name}`)
      .sort();
    expect(real).toEqual(NEW_FILES.filter((f) => f.startsWith(STAGE_DIR)).sort());
    expect(NEW_FILES.length).toBe(11);
    expect(NEW_FILES).toContain('src/rsi/personal/stage/growth.ts');
    expect(NEW_FILES).toContain('src/rsi/personal/judge-slot.ts');
    expect(ENTRIES.length).toBeGreaterThanOrEqual(8);
  });

  it('生产入口的 import 闭包不含新模块:运行时依赖与类型依赖两档都查', () => {
    for (const includeTypes of [false, true]) {
      const c = closureOf(ENTRIES, { includeTypes });
      expect(c.files.size).toBeGreaterThan(50);
      expect([...c.files].filter(isNew), `includeTypes=${includeTypes}`).toEqual([]);
      expect(c.unresolved).toEqual([]);
    }
  });

  it('正向对照:虚拟入口 import 授权模块 / 判决槽时,同一检查报出', () => {
    const c = closureOf(['src/rsi/inert-probe.ts'], {
      virtual: {
        'src/rsi/inert-probe.ts':
          "import { evaluateGrowth } from './personal/stage/growth.js';\nimport { UNAVAILABLE_JUDGE } from './personal/judge-slot.js';\nexport const x = [evaluateGrowth, UNAVAILABLE_JUDGE];",
      },
    });
    expect([...c.files].filter(isNew)).toEqual(
      expect.arrayContaining([
        'src/rsi/personal/stage/growth.ts',
        'src/rsi/personal/judge-slot.ts',
      ]),
    );
  });

  it('worker.ts / hint.ts / hook-entry.ts 的源码没有提到新模块路径', () => {
    for (const f of ['src/rsi/worker.ts', 'src/rsi/hint.ts', 'src/rsi/hook-entry.ts']) {
      const src = readTextSync(path.join(ROOT, f));
      expect(src, f).not.toMatch(/personal\/stage|judge-slot|PersonalStage/);
    }
  });

  it('相位常量仍为 0(本块不提相位)', () => {
    expect(RSI_AUTO_PHASE).toBe(0);
  });
});

// ---- 静态扫描器(带正向对照) ----
function parse(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function importsOf(file: string, source: string): string[] {
  const out: string[] = [];
  for (const st of parse(file, source).statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      out.push(st.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(st) &&
      st.moduleSpecifier &&
      ts.isStringLiteral(st.moduleSpecifier)
    ) {
      out.push(st.moduleSpecifier.text);
    }
  }
  return out;
}

const CALL_ALLOW = new Set(['Object.freeze', 'Set', 'WeakMap', 'WeakSet', 'sig']);
const ALLOWED_TOP = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.ImportDeclaration,
  ts.SyntaxKind.ExportDeclaration,
  ts.SyntaxKind.VariableStatement,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
]);
/** 顶层语句只允许声明;顶层(函数体之外)的调用 / new 只允许冻结与空登记表的构造 */
function topLevelEffects(file: string, source: string): string[] {
  const sf = parse(file, source);
  const out: string[] = [];
  const text = (n: ts.Expression): string => n.getText(sf);
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionLike(n) || ts.isClassDeclaration(n)) return; // 函数体 / 类体内的调用不是顶层副作用
    if (ts.isCallExpression(n) && !CALL_ALLOW.has(text(n.expression)))
      out.push(`call:${text(n.expression)}`);
    if (ts.isNewExpression(n) && !CALL_ALLOW.has(text(n.expression)))
      out.push(`new:${text(n.expression)}`);
    ts.forEachChild(n, visit);
  };
  for (const st of sf.statements) {
    if (!ALLOWED_TOP.has(st.kind)) out.push(`stmt:${ts.SyntaxKind[st.kind]}`);
    else if (
      ts.isVariableStatement(st) &&
      !(st.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword) ?? false)
    ) {
      visit(st);
    }
  }
  return out;
}

const FORBIDDEN_SPEC = [
  /(^|\/)io\/(safe-fs|home-fs)\.js$/,
  /^node:fs(\/promises)?$/,
  /^fs(\/promises)?$/,
  /(^|\/)worker\.js$/,
  /(^|\/)hook-entry\.js$/,
  /(^|\/)judge\/ingest/,
  /(^|\/)judge-ingest\.js$/,
  /(^|\/)judge-signal\.js$/,
  /(^|\/)read\/judge-source\.js$/,
];
const STORE_SPEC = /(^|\/)store\//;
const LOCK_SPEC = /(^|\/)(lock|personal-lock)\.js$/;

function importViolations(file: string, source: string): string[] {
  const out: string[] = [];
  const isAdapter = file.endsWith('stage/lock-identity.ts');
  for (const spec of importsOf(file, source)) {
    if (FORBIDDEN_SPEC.some((re) => re.test(spec))) out.push(`forbidden:${spec}`);
    if (STORE_SPEC.test(spec)) out.push(`store:${spec}`);
    if (LOCK_SPEC.test(spec) && !isAdapter) out.push(`lock_outside_adapter:${spec}`);
  }
  return out;
}

describe('新模块是纯逻辑、无副作用、依赖收敛', () => {
  it('顶层只有声明(正向对照:console.log / 顶层 await / 非白名单调用会被报出)', () => {
    for (const f of NEW_FILES) {
      expect(topLevelEffects(f, readTextSync(path.join(ROOT, f))), f).toEqual([]);
    }
    expect(topLevelEffects('v.ts', "console.log('x');\nexport const a = 1;")).toEqual([
      'stmt:ExpressionStatement',
    ]);
    expect(topLevelEffects('v.ts', 'export const a = doSomething();')).toEqual([
      'call:doSomething',
    ]);
    expect(topLevelEffects('v.ts', 'export const a = new Map();')).toEqual(['new:Map']);
    expect(topLevelEffects('v.ts', 'export const a = Object.freeze({ b: new Set() });')).toEqual(
      [],
    );
  });

  it('无 fs 写用法;不 import 任何写出口 / worker / 判决逻辑模块 / 存储核', () => {
    for (const f of NEW_FILES) {
      const src = readTextSync(path.join(ROOT, f));
      expect(fsWriteUses(f, src), f).toEqual([]);
      expect(importViolations(f, src), f).toEqual([]);
    }
    // 正向对照
    expect(
      fsWriteUses('v.ts', "import fs from 'node:fs';\nfs.writeFileSync('x', 'y');").length,
    ).toBeGreaterThan(0);
    expect(
      importViolations(
        'src/rsi/personal/stage/x.ts',
        "import { w } from '../../../io/safe-fs.js';",
      ),
    ).toEqual(['forbidden:../../../io/safe-fs.js']);
    expect(
      importViolations('src/rsi/personal/stage/x.ts', "import { w } from '../../store/store.js';"),
    ).toEqual(['store:../../store/store.js']);
    expect(
      importViolations('src/rsi/personal/stage/x.ts', "import { w } from '../judge-signal.js';"),
    ).toEqual(['forbidden:../judge-signal.js']);
    expect(
      importViolations('src/rsi/personal/stage/x.ts', "import type { H } from '../../lock.js';"),
    ).toEqual(['lock_outside_adapter:../../lock.js']);
  });

  it('对锁句柄具体类型的依赖只在 lock-identity.ts(B1a 适配点):其余文件不 import lock.js / personal-lock.js;适配点本身不 import store/**', () => {
    const adapter = readTextSync(path.join(ROOT, 'src/rsi/personal/stage/lock-identity.ts'));
    const specs = importsOf('lock-identity.ts', adapter);
    expect(specs.filter((s) => LOCK_SPEC.test(s)).sort()).toEqual([
      '../../lock.js',
      '../personal-lock.js',
    ]);
    expect(specs.filter((s) => STORE_SPEC.test(s))).toEqual([]);
    for (const f of NEW_FILES.filter((x) => !x.endsWith('stage/lock-identity.ts'))) {
      expect(
        importsOf(f, readTextSync(path.join(ROOT, f))).filter((s) => LOCK_SPEC.test(s)),
        f,
      ).toEqual([]);
    }
  });

  it('不复制 W9 判决逻辑:judge-slot.ts 只 import 类型与 StepHalt', () => {
    const specs = importsOf(
      'judge-slot.ts',
      readTextSync(path.join(ROOT, 'src/rsi/personal/judge-slot.ts')),
    );
    expect(specs.sort()).toEqual(['../../contracts/rsi-personal.js', './candidate-ports.js']);
  });
});

describe('回合内部状态的引用面', () => {
  async function walk(dir: string, out: string[] = []): Promise<string[]> {
    for (const e of await readDir(dir)) {
      const p = path.join(dir, e.name);
      if (e.isDirectory) {
        if (e.name === 'node_modules') continue;
        await walk(p, out);
      } else if (e.isFile && p.endsWith('.ts')) out.push(p);
    }
    return out;
  }
  const offenders = (files: Record<string, string>): string[] =>
    Object.entries(files)
      .filter(([rel]) => !rel.startsWith(STAGE_DIR))
      .filter(([, src]) => /\b(roundInternals|markRoundUnsettled)\b/.test(src))
      .map(([rel]) => rel);

  it('roundInternals / markRoundUnsettled 只在 stage 目录内被引用(src 全树)', async () => {
    const files: Record<string, string> = {};
    for (const f of await walk(path.join(ROOT, 'src'))) {
      files[path.relative(ROOT, f).split(path.sep).join('/')] = readTextSync(f);
    }
    expect(Object.keys(files).length).toBeGreaterThan(200);
    expect(offenders(files)).toEqual([]);
    // 正向对照
    expect(
      offenders({
        'src/rsi/other.ts': "import { roundInternals } from './personal/stage/round.js';",
      }),
    ).toEqual(['src/rsi/other.ts']);
  });

  it('GrowthPass 的铸造点只在 growth.ts:其它新模块没有 pass 登记表 / mint 的踪影', () => {
    for (const f of NEW_FILES.filter((x) => !x.endsWith('stage/growth.ts'))) {
      expect(readTextSync(path.join(ROOT, f)), f).not.toMatch(/\bmint\(|\bminted\b/);
    }
    expect(readTextSync(path.join(ROOT, 'src/rsi/personal/stage/growth.ts'))).toMatch(
      /function mint\(/,
    );
  });
});
