/**
 * C1a:**生产惰性**与架构边界的证明(照 B1a `inert.test.ts`)——C1a 合并后:
 *  ① 没有任何生产入口(含 `worker.ts` / `hook-entry.ts` / `hint.ts` / 命令入口)的 import 闭包含 `src/rsi/personal/stage/**` 或 `judge-slot.ts`
 *     (类型导入也不含:`includeTypes` 两档都查)——不接线、没有注入点;
 *  **C1b 订正(接线后,依赖倒置)**:`worker.ts` 只依赖叶子端口 `worker-personal-port.ts`(只有类型),`hook-entry.ts` 不认识装配——这两个文件的闭包(含 `import type`)里 stage 模块为**零**(严格档);
 *  个人步的真实装配只在 `assemble-worker.ts` / `worker-entry.ts`(只被根入口 `cli.ts` / `src/cli.ts` 经动态 `import()` 加载)。所以 ① 对「接线入口」细分为**两档白名单**:运行时闭包只允许 `RUNTIME_WIRED`(纯逻辑的 P 骨架;C2 起含 settle / monitoring / residual),
 *  类型闭包另允许 `TYPE_ONLY_WIRED`(只被 `import type` 引用);**其余一切 stage 模块**(`growth.ts` 增影响授权、判决槽 `judge-slot.ts` 的运行时)
 *  在任一档的生产闭包里仍然禁止;`hint.ts` 与命令入口(只读 / 前台)仍是全禁。这不是删闸:被允许的模块逐个是纯逻辑(见下面的纯度检查),且禁区覆盖面按「非白名单即禁」计。
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
  'ladder.ts',
  'lock-identity.ts',
  'monitoring.ts',
  'personal-stage.ts',
  'ports.ts',
  'residual.ts',
  'round.ts',
  'settle.ts',
  'taint-types.ts',
  'types.ts',
]
  .map((f) => `${STAGE_DIR}${f}`)
  .concat(['src/rsi/personal/judge-slot.ts']);

/**
 * 接线入口:闭包里允许出现白名单内的 stage 模块(`cli.ts` / `src/cli.ts` 经动态 `import()` 加载 worker-entry,所以也在内)。
 * 注意:`worker.ts` / `hook-entry.ts` 不在此列(它们在下面的严格档:stage 模块为零)。
 */
const WIRED_ENTRIES = [
  'cli.ts',
  'src/cli.ts',
  'src/rsi/assemble-worker.ts',
  'src/rsi/worker-entry.ts',
].filter((f) => existsSync(path.join(ROOT, f)));
/** 运行时生产闭包里允许出现的 stage 模块(C1b 接线所需的纯逻辑) */
const RUNTIME_WIRED: readonly string[] = [
  'errors.ts',
  'fallback.ts',
  'ladder.ts',
  'lock-identity.ts',
  'personal-stage.ts',
  'round.ts',
  'types.ts',
  // C2 订正(W0-29):S1 / S2 编排用 `settleSafety` / `RoundBudget`;D18 doctor 检查(根入口经命令表进入闭包)用判定内核 `residual.ts` 及其常量 `monitoring.ts`。
  // 三者都是纯逻辑(下面的纯度检查逐文件覆盖);`growth.ts`(增影响授权)与判决槽运行时仍禁。
  'monitoring.ts',
  'residual.ts',
  'settle.ts',
].map((f) => `${STAGE_DIR}${f}`);
/** 仅类型闭包另允许(只被 `import type` 引用;没有运行时代码) */
const TYPE_ONLY_WIRED: readonly string[] = [
  `${STAGE_DIR}ports.ts`,
  `${STAGE_DIR}taint-types.ts`,
  'src/rsi/personal/judge-slot.ts',
];

/** 严格入口:闭包里一个 stage 模块都不许有(只读 / 前台 / 候选步入口;C1b 起含 worker 与钩子入口——个人步经端口注入,不静态依赖) */
const ENTRIES = [
  'src/rsi/worker.ts',
  'src/rsi/hook-entry.ts',
  'src/rsi/worker-personal-port.ts',
  'src/commands/rsi.ts',
  'src/rsi/poke.ts',
  'src/rsi/hint.ts',
  'src/commands/rsi.ts-placeholder',
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
    expect(NEW_FILES.length).toBe(14);
    expect(NEW_FILES).toContain('src/rsi/personal/stage/growth.ts');
    expect(NEW_FILES).toContain('src/rsi/personal/judge-slot.ts');
    expect(ENTRIES.length).toBeGreaterThanOrEqual(9);
    expect(WIRED_ENTRIES.length).toBe(4);
  });

  it('严格入口(只读 / 前台 / 候选步)的 import 闭包不含任何新模块:运行时依赖与类型依赖两档都查', () => {
    for (const includeTypes of [false, true]) {
      const c = closureOf(ENTRIES, { includeTypes });
      expect(c.files.size).toBeGreaterThan(50);
      expect([...c.files].filter(isNew), `includeTypes=${includeTypes}`).toEqual([]);
      expect(c.unresolved).toEqual([]);
    }
  });

  it('接线入口的闭包只含白名单内的 stage 模块:非白名单即禁(growth / settle / monitoring / residual / 判决槽运行时),两档分别查', () => {
    const rt = closureOf(WIRED_ENTRIES, { includeTypes: false });
    expect([...rt.files].filter(isNew).sort(), 'runtime').toEqual([...RUNTIME_WIRED].sort());
    const ty = closureOf(WIRED_ENTRIES, { includeTypes: true });
    expect([...ty.files].filter(isNew).sort(), 'types').toEqual(
      [...RUNTIME_WIRED, ...TYPE_ONLY_WIRED].sort(),
    );
    expect(rt.unresolved).toEqual([]);
    // 每个单入口也逐一核对(不靠并集掩盖某个入口多拉了模块)
    for (const e of WIRED_ENTRIES) {
      const one = closureOf([e], { includeTypes: false });
      for (const f of [...one.files].filter(isNew))
        expect(RUNTIME_WIRED, `${e} → ${f}`).toContain(f);
    }
  });

  it('worker.ts / hook-entry.ts / 端口叶子文件逐个:闭包(含 import type)里 stage 模块为零,也不含个人层写出口 home-fs', () => {
    for (const e of [
      'src/rsi/worker.ts',
      'src/rsi/hook-entry.ts',
      'src/rsi/worker-personal-port.ts',
    ]) {
      expect(existsSync(path.join(ROOT, e)), e).toBe(true);
      const c = closureOf([e], { includeTypes: true });
      expect([...c.files].filter(isNew), e).toEqual([]);
      expect(c.files.has('src/io/home-fs.ts'), e).toBe(false);
      expect(c.files.has('src/rsi/personal/personal-lock.ts'), e).toBe(false);
      expect(c.unresolved).toEqual([]);
    }
  });

  it('正向对照:worker 若重新 import type 任一 stage 模块,同一检查必红(类型导入也把个人层写出口拖进闭包)', () => {
    for (const spec of ['types', 'errors']) {
      const c = closureOf(['src/rsi/inert-probe-worker.ts'], {
        includeTypes: true,
        virtual: {
          'src/rsi/inert-probe-worker.ts': `import type * as S from './personal/stage/${spec}.js';\nexport type X = typeof S;`,
        },
      });
      expect([...c.files].filter(isNew), spec).toContain(`${STAGE_DIR}${spec}.ts`);
      expect(c.files.has('src/io/home-fs.ts'), spec).toBe(true);
    }
  });

  it('assemble-worker.ts 的闭包确实带着个人层写出口(端口隔离不是空跑:被隔离的那一侧真有东西)', () => {
    const c = closureOf(['src/rsi/assemble-worker.ts'], { includeTypes: true });
    expect(c.files.has('src/io/home-fs.ts')).toBe(true);
    expect(c.files.has('src/rsi/personal/stage/fallback.ts')).toBe(true);
  });

  it('正向对照:接线入口若多拉 growth.ts / 判决槽运行时,白名单检查必红(settle / monitoring / residual 自 C2 起在白名单内)', () => {
    const c = closureOf(['src/rsi/inert-probe-wired.ts'], {
      includeTypes: false,
      virtual: {
        'src/rsi/inert-probe-wired.ts':
          "import { evaluateGrowth } from './personal/stage/growth.js';\nimport { UNAVAILABLE_JUDGE } from './personal/judge-slot.js';\nexport const x = [evaluateGrowth, UNAVAILABLE_JUDGE];",
      },
    });
    const extra = [...c.files].filter(isNew).filter((f) => !RUNTIME_WIRED.includes(f));
    expect(extra).toEqual(
      expect.arrayContaining([
        'src/rsi/personal/stage/growth.ts',
        'src/rsi/personal/judge-slot.ts',
      ]),
    );
    for (const ok of ['settle.ts', 'monitoring.ts', 'residual.ts'])
      expect(RUNTIME_WIRED).toContain(`${STAGE_DIR}${ok}`);
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

  it('hint.ts 的源码没有提到新模块路径;worker.ts 的源码不提任何 stage 模块路径(只经端口)', () => {
    const hint = readTextSync(path.join(ROOT, 'src/rsi/hint.ts'));
    expect(hint).not.toMatch(/personal\/stage|judge-slot|PersonalStage/);
    const worker = readTextSync(path.join(ROOT, 'src/rsi/worker.ts'));
    expect(worker).not.toMatch(/personal\/stage|judge-slot/);
    expect(importsOf('worker.ts', worker)).toContain('./worker-personal-port.js');
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
