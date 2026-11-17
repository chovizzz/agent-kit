/**
 * C1b:静态图与架构边界。
 *  - `c_closure_has_no_growth_symbols`:装配入口(`assemble-worker.ts`)的 import 闭包不含增影响汇点的符号与其所在模块(授予 / 候选推进 / 建仓 / 增长授权 / 判决槽);
 *  - 个人步闭包全静态:无动态 `import()` / `require`(P 运行期间不惰性加载安装树里的文件;C v2 §6);
 *  - `fallback_has_no_state_write_port` 的闭包钉:兜底阶梯(`ladder.ts`)的闭包不含任何写 state / 清单 / 恢复的符号;
 *  - 装配层顶层只有声明(工厂求值零 IO 的静态一半);stage 暴露的成员只有 run / safetyFallback / eligible(`all_write_ports_wrapped` 的空集守卫:C1b 的写都发生在装配适配器内,
 *    不经 `round.writeAdapter`——S0 写点见 `personal-stage.ts` 头注)。
 * 每条检查都有正向对照(违规的虚拟文件必须被同一检查报出)。
 */
import * as path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { existsSync, readTextSync } from '../../../src/io/read-fs.js';
import { assembleWorkerStage } from '../../../src/rsi/assemble-worker.js';
import { ROOT, closureOf, identHits } from '../closure-util.js';

const ENTRY = 'src/rsi/assemble-worker.ts';

const GROWTH_SINK_SYMBOLS = [
  'grantCanary',
  'runPersonalStep',
  'bootstrapRepo',
  'openPersonalRepo',
  'evaluateGrowth',
  'requireGrowth',
  'checkGrowthVeto',
  'UNAVAILABLE_JUDGE',
  'checkJudgeGrowth',
  'writeRevocation',
] as const;
const GROWTH_SINK_MODULES = [
  'src/rsi/canary/canary-writer.ts',
  'src/rsi/canary/admission-write.ts',
  'src/rsi/personal/candidate-step.ts',
  'src/rsi/personal/candidate-apply.ts',
  'src/rsi/personal/commit.ts',
  'src/rsi/personal/commit-journal.ts',
  'src/rsi/personal/revoke-write.ts',
  'src/rsi/personal/judge-slot.ts',
  'src/rsi/personal/stage/growth.ts',
  'src/rsi/personal/stage/settle.ts',
].filter((f) => existsSync(path.join(ROOT, f)));

describe('c_closure_has_no_growth_symbols', () => {
  it('装配入口的运行时闭包:无增影响符号、无增影响模块', () => {
    const c = closureOf([ENTRY], { includeTypes: false });
    expect(c.unresolved).toEqual([]);
    expect(c.files.size).toBeGreaterThan(30);
    expect(identHits(c, GROWTH_SINK_SYMBOLS)).toEqual([]);
    expect([...c.files].filter((f) => GROWTH_SINK_MODULES.includes(f))).toEqual([]);
  });

  it('类型闭包同样无增影响符号(`evaluateGrowth` 等不会经类型导入混进来)', () => {
    const c = closureOf([ENTRY], { includeTypes: true });
    expect(identHits(c, ['evaluateGrowth', 'requireGrowth', 'checkGrowthVeto'])).toEqual([]);
    expect([...c.files].filter((f) => f.endsWith('stage/growth.ts'))).toEqual([]);
  });

  it('正向对照:虚拟入口引入授予入口 / 增长授权 → 同一检查报出', () => {
    const c = closureOf(['src/rsi/probe-growth.ts'], {
      virtual: {
        'src/rsi/probe-growth.ts':
          "import { grantCanary } from './canary/canary-writer.js';\nimport { evaluateGrowth } from './personal/stage/growth.js';\nexport const x = [grantCanary, evaluateGrowth];",
      },
    });
    expect(identHits(c, GROWTH_SINK_SYMBOLS).length).toBeGreaterThan(0);
    expect([...c.files].filter((f) => GROWTH_SINK_MODULES.includes(f))).toEqual(
      expect.arrayContaining([
        'src/rsi/canary/canary-writer.ts',
        'src/rsi/personal/stage/growth.ts',
      ]),
    );
  });

  it('muteCanary / removeCanary 已拆到 canary-mute.ts 且 canary-writer.ts 原样再导出(既有 import 路径不变)', () => {
    const w = readTextSync(path.join(ROOT, 'src/rsi/canary/canary-writer.ts'));
    expect(w).toMatch(/export \{ muteCanary, removeCanary \} from '\.\/canary-mute\.js'/);
    const m = closureOf(['src/rsi/canary/canary-mute.ts']);
    expect([...m.files].filter((f) => f.endsWith('canary-writer.ts'))).toEqual([]);
  });
});

/** 文件里的动态 `import()` / `require(` 调用(AST;注释不算) */
function dynamicLoads(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword) out.push(`${file}:import()`);
      else if (ts.isIdentifier(n.expression) && n.expression.text === 'require')
        out.push(`${file}:require`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe('个人步闭包全静态(update_in_progress_still_runs_P 的静态一半)', () => {
  it('assemble-worker.ts 与 worker.ts 的闭包里没有任何动态 import() / require', () => {
    for (const entry of [ENTRY, 'src/rsi/worker.ts']) {
      const c = closureOf([entry]);
      expect(c.dynamic, entry).toEqual([]);
      for (const f of c.files) {
        expect(dynamicLoads(f, readTextSync(path.join(ROOT, f))), `${entry} → ${f}`).toEqual([]);
      }
    }
  });
  it('正向对照:含动态 import / require 的源码被报出', () => {
    expect(dynamicLoads('v.ts', "export const f = () => import('./x.js');")).toEqual([
      'v.ts:import()',
    ]);
    expect(dynamicLoads('v.ts', "const r = require('x');")).toEqual(['v.ts:require']);
    expect(dynamicLoads('v.ts', '// import() 只在注释里\nexport const a = 1;')).toEqual([]);
  });
});

describe('兜底阶梯的闭包不含写 state / 清单 / 恢复的符号', () => {
  const STATE_WRITERS = [
    'writeStateFile',
    'commitUnderLockWith',
    'commitUnderLock',
    'recoverUnderLock',
    'recoverSnapshot',
    'readStateForWrite',
    'commitSnapshot',
  ] as const;
  it('ladder.ts(兜底与 S0 阶梯的唯一实现)运行时闭包无状态写者', () => {
    const c = closureOf(['src/rsi/personal/stage/ladder.ts']);
    expect(identHits(c, STATE_WRITERS)).toEqual([]);
  });
  it('正向对照', () => {
    const c = closureOf(['src/rsi/probe-fb.ts'], {
      virtual: {
        'src/rsi/probe-fb.ts':
          "import { writeStateFile } from './services/fixed-write.js';\nexport const x = writeStateFile;",
      },
    });
    expect(identHits(c, STATE_WRITERS).length).toBeGreaterThan(0);
  });
});

/** 顶层(函数体之外)的调用 / new 只允许冻结与空登记表的构造 */
function topLevelCalls(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionLike(n) || ts.isClassDeclaration(n)) return;
    if (ts.isCallExpression(n) && n.expression.getText(sf) !== 'Object.freeze')
      out.push(`call:${n.expression.getText(sf)}`);
    if (ts.isNewExpression(n)) out.push(`new:${n.expression.getText(sf)}`);
    ts.forEachChild(n, visit);
  };
  for (const st of sf.statements) {
    if (
      ts.isImportDeclaration(st) ||
      ts.isExportDeclaration(st) ||
      ts.isInterfaceDeclaration(st) ||
      ts.isTypeAliasDeclaration(st) ||
      ts.isFunctionDeclaration(st)
    )
      continue;
    if (ts.isVariableStatement(st)) visit(st);
    else out.push(`stmt:${ts.SyntaxKind[st.kind]}`);
  }
  return out;
}

describe('工厂零 IO 的静态一半 / stage 的成员', () => {
  it('assemble-worker.ts 顶层只有声明与 Object.freeze', () => {
    expect(topLevelCalls(ENTRY, readTextSync(path.join(ROOT, ENTRY)))).toEqual([]);
    expect(topLevelCalls('v.ts', "export const a = fs.readFileSync('x');")).toEqual([
      'call:fs.readFileSync',
    ]);
    expect(topLevelCalls('v.ts', 'export const a = new Map();')).toEqual(['new:Map']);
    expect(topLevelCalls('v.ts', "console.log('x');")).toEqual(['stmt:ExpressionStatement']);
  });
  it('assembleWorkerStage() 暴露的成员恰好是 run / safetyFallback / eligible(没有任何未包装的写端口)', () => {
    expect(Object.keys(assembleWorkerStage()).sort()).toEqual([
      'eligible',
      'run',
      'safetyFallback',
    ]);
  });
});
