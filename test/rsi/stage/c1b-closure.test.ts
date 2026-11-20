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

/**
 * **C2 订正(W0-29 / C v1 §2「写能力边界」口径)**:C1b 的守卫把 `openPersonalRepo` / `writeRevocation` / `bootstrapRepo` 与 commit.ts / commit-journal.ts / revoke-write.ts /
 * candidate-apply.ts / settle.ts / judge-slot.ts 也算作「增影响」整体禁入;C2 的设计(S1 调 `openPersonalRepo`、污染写凭据、reduce-step 经 `applyEvent` 对账、W9 槽 4b)
 * 必须引入它们。所以这里分两层:
 *  ① 真正的增影响汇点(授予 / 增长授权 / 候选推进入口)与其模块——**仍然整体禁入**;
 *  ② 被 C2 认领的写能力符号——不再禁入,但**调用点收敛**:每个符号只许出现在列出的文件里(见 `CALL_SITES`),新增调用点 = 红;bootstrap 类 journal 的处置另有运行期用例(`c2-steps-s1.test.ts` / `d1b1/` 下的 complete_only 用例)。
 */
const GROWTH_SINK_SYMBOLS = [
  'grantCanary',
  'runPersonalStep',
  'evaluateGrowth',
  'requireGrowth',
  'checkGrowthVeto',
  // D1b-2(只增不减):pass 存在性检查与汇点登记表也只在增影响一侧
  'hasSinkPass',
  'GROWTH_SINKS',
] as const;
const GROWTH_SINK_MODULES = [
  'src/rsi/canary/canary-writer.ts',
  'src/rsi/canary/admission-write.ts',
  'src/rsi/canary/growth-sinks.ts',
  'src/rsi/personal/candidate-step.ts',
  'src/rsi/personal/stage/growth.ts',
].filter((f) => existsSync(path.join(ROOT, f)));

/** ② 写能力符号的调用点收敛(闭包内出现该标识符的文件必须 ⊆ 允许集合;定义处与既有使用方在内) */
const CALL_SITES: Readonly<Record<string, readonly string[]>> = {
  openPersonalRepo: ['src/rsi/assemble-personal.ts', 'src/rsi/personal/commit.ts'],
  bootstrapRepo: ['src/rsi/personal/commit-journal.ts', 'src/rsi/personal/commit.ts'],
  writeRevocationDetailed: ['src/rsi/assemble-personal.ts', 'src/rsi/personal/revoke-write.ts'],
  writeRevocation: ['src/rsi/personal/revoke-write.ts', 'src/rsi/personal/rollback-ports.ts'],
  applyEvent: [
    'src/rsi/personal/candidate-apply.ts',
    'src/rsi/personal/reduce-step.ts',
    'src/rsi/personal/rollback.ts',
  ],
  UNAVAILABLE_JUDGE: ['src/rsi/personal/judge-slot.ts'],
  checkJudgeGrowth: ['src/rsi/personal/judge-slot.ts'],
};
const callSiteViolations = (c: ReturnType<typeof closureOf>): string[] =>
  identHits(c, Object.keys(CALL_SITES)).filter((h) => {
    const i = h.lastIndexOf(':');
    const f = h.slice(0, i);
    const sym = h.slice(i + 1);
    return !(CALL_SITES[sym] ?? []).includes(f);
  });

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

  it('C2:写能力符号的调用点收敛(运行时闭包与类型闭包);新增调用点必红', () => {
    for (const includeTypes of [false, true]) {
      const c = closureOf([ENTRY], { includeTypes });
      expect(callSiteViolations(c), `includeTypes=${includeTypes}`).toEqual([]);
    }
    // 正向对照:虚拟文件里多一个 `openPersonalRepo` 调用点 → 报出
    const bad = closureOf(['src/rsi/probe-callsite.ts'], {
      virtual: {
        'src/rsi/probe-callsite.ts':
          "import { openPersonalRepo } from './personal/commit.js';\nexport const x = openPersonalRepo;",
      },
    });
    expect(callSiteViolations(bad)).toContain('src/rsi/probe-callsite.ts:openPersonalRepo');
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

describe('D1b-2:applyEvent 经注入端口取增影响钩子,pass 没有被拖进 worker 闭包(owner Q1)', () => {
  const APPLY = 'src/rsi/personal/candidate-apply.ts';
  const PASS_HOLDERS = [
    'hasSinkPass',
    'GROWTH_SINKS',
    'isGrowthPass',
    'evaluateGrowth',
    'requireGrowth',
  ];
  it('candidate-apply.ts 的运行时与类型闭包都不含 stage 模块 / growth-sinks;端口类型 GrowthClaimPort 在其中', () => {
    for (const includeTypes of [false, true]) {
      const c = closureOf([APPLY], { includeTypes });
      expect(c.unresolved).toEqual([]);
      expect(
        [...c.files].filter((f) => f.includes('/stage/') || f.endsWith('growth-sinks.ts')),
      ).toEqual([]);
      expect(identHits(c, PASS_HOLDERS), `includeTypes=${includeTypes}`).toEqual([]);
    }
    const t = closureOf([APPLY], { includeTypes: true });
    expect(identHits(t, ['GrowthClaimPort']).length).toBeGreaterThan(0);
  });
  it('正向对照:虚拟文件里 applyEvent 同类入口 import growth-sinks → 同一检查报出', () => {
    const c = closureOf(['src/rsi/probe-apply.ts'], {
      virtual: {
        'src/rsi/probe-apply.ts':
          "import { hasSinkPass } from './canary/growth-sinks.js';\nexport const x = hasSinkPass;",
      },
    });
    expect([...c.files].filter((f) => f.endsWith('growth-sinks.ts'))).toHaveLength(1);
    expect(identHits(c, PASS_HOLDERS).length).toBeGreaterThan(0);
  });
});

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
