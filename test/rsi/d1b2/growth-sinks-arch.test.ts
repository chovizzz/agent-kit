/**
 * D1b-2:`GROWTH_SINKS` 架构门(AST;I9 / I15;W0-29 第 9 条 T5)。三层:
 *  ① 登记表里每个汇点按形态校验:`pass_param` = 最后一个形参 `pass: GrowthPass` 非可选 + 函数体第一条语句是 `if (!hasSinkPass(pass)) return …`(任何 await 之前);
 *     `port_claim` = 钩子经 `claim*` 取得,且先于 `store.read` / `seal.open` / `store.commit`,所有 `store.commit(` 都带 `beforeRefUpdate`;`auth_port` = `authorize` 先于 `mkdir` / `git init` / `mktree`;
 *  ② 同名扫描:`src/rsi/**` 里定义了与汇点同名的函数而不在登记文件里 = 红(防漏登记 / 拷贝出绕过版);
 *  ③ 写出口覆盖扫描:写 `canary.json` / `canary-admission.json` 的调用、带 `beforeRefUpdate` 的 `store.commit`,所在函数必须 ⊆ 登记表 ∪ 冻结的「只减影响」白名单(带理由)。
 * 每一层都有正向对照(虚拟违规源码必须被同一检查报出)。
 */
import * as path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { readDir, readTextSync } from '../../../src/io/read-fs.js';
import { GROWTH_SINKS, type GrowthSink } from '../../../src/rsi/canary/growth-sinks.js';
import { ROOT } from '../closure-util.js';

const parse = (file: string, text: string): ts.SourceFile =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function findFn(sf: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  let found: ts.FunctionDeclaration | undefined;
  const visit = (n: ts.Node): void => {
    if (found === undefined && ts.isFunctionDeclaration(n) && n.name?.text === name && n.body) {
      found = n;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

interface CallInfo {
  callee: string;
  pos: number;
  node: ts.CallExpression;
}
/** 函数体内的全部调用(源码顺序),含嵌套函数 */
function callsIn(fn: ts.Node, sf: ts.SourceFile): CallInfo[] {
  const out: CallInfo[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n))
      out.push({ callee: n.expression.getText(sf), pos: n.getStart(sf), node: n });
    ts.forEachChild(n, visit);
  };
  visit(fn);
  return out.sort((a, b) => a.pos - b.pos);
}

const hasAwait = (n: ts.Node): boolean => {
  let f = false;
  const visit = (x: ts.Node): void => {
    if (ts.isAwaitExpression(x)) f = true;
    ts.forEachChild(x, visit);
  };
  visit(n);
  return f;
};

// ---------------------------------------------------------------------------
// ① 按形态校验(返回问题列表;空 = 合规)
// ---------------------------------------------------------------------------
export function passParamProblems(sf: ts.SourceFile, name: string): string[] {
  const fn = findFn(sf, name);
  if (fn?.body === undefined) return [`${name}:函数不存在`];
  const out: string[] = [];
  const last = fn.parameters[fn.parameters.length - 1];
  if (last === undefined || last.name.getText(sf) !== 'pass')
    out.push(`${name}:最后一个形参不是 pass`);
  else {
    if (last.type?.getText(sf) !== 'GrowthPass') out.push(`${name}:pass 的类型不是 GrowthPass`);
    if (last.questionToken !== undefined || last.initializer !== undefined) {
      out.push(`${name}:pass 是可选 / 带默认值`);
    }
  }
  const first = fn.body.statements[0];
  if (
    first === undefined ||
    !ts.isIfStatement(first) ||
    first.expression.getText(sf) !== '!hasSinkPass(pass)'
  ) {
    out.push(`${name}:函数体第一条语句不是 if (!hasSinkPass(pass))`);
  } else {
    const then = first.thenStatement;
    const ret = ts.isBlock(then) ? then.statements[0] : then;
    if (ret === undefined || !ts.isReturnStatement(ret)) out.push(`${name}:缺 pass 时不是 return`);
    if (hasAwait(first)) out.push(`${name}:pass 检查之前出现 await`);
  }
  return out;
}

const PORT_RULES: Readonly<
  Record<string, { claim: string; before: readonly string[]; commitsCarryHook: boolean }>
> = {
  applyEvent: {
    claim: 'claimGrowth',
    before: ['d.store.read', 'd.seal.open', 'applyIn'],
    commitsCarryHook: false,
  },
  runPersonalStep: {
    claim: 'claimGrowthPort',
    before: ['d.seal.open', 'd.store.commit'],
    commitsCarryHook: true,
  },
};

export function portClaimProblems(sf: ts.SourceFile, name: string): string[] {
  const fn = findFn(sf, name);
  const rule = PORT_RULES[name];
  if (fn === undefined || rule === undefined) return [`${name}:函数或规则不存在`];
  const calls = callsIn(fn, sf);
  const claim = calls.find((c) => c.callee === rule.claim);
  if (claim === undefined) return [`${name}:没有调用 ${rule.claim}`];
  const out: string[] = [];
  for (const c of calls) {
    if (rule.before.includes(c.callee) && c.pos < claim.pos) {
      out.push(`${name}:${c.callee} 出现在 ${rule.claim} 之前`);
    }
  }
  if (rule.commitsCarryHook) {
    for (const c of calls.filter((x) => x.callee === 'd.store.commit')) {
      if (!c.node.arguments.some((a) => a.getText(sf).includes('beforeRefUpdate'))) {
        out.push(`${name}:store.commit 不带 beforeRefUpdate`);
      }
    }
  }
  return out;
}

export function authPortProblems(sf: ts.SourceFile, name: string): string[] {
  const fn = findFn(sf, name);
  if (fn === undefined) return [`${name}:函数不存在`];
  const calls = callsIn(fn, sf);
  const auth = (step: string): CallInfo | undefined =>
    calls.find(
      (c) => c.callee === 'authorizeStep' && c.node.arguments[1]?.getText(sf) === `'${step}'`,
    );
  const init = auth('init');
  const cas = auth('cas');
  const out: string[] = [];
  if (init === undefined) out.push(`${name}:缺 authorizeStep(init)`);
  if (cas === undefined) out.push(`${name}:缺 authorizeStep(cas)`);
  const first = (pred: (c: CallInfo) => boolean): CallInfo | undefined => calls.find(pred);
  const mkdir = first((c) => c.callee === 'makeRepoDir');
  const gitInit = first((c) => c.callee.endsWith('.git.init') || c.callee === 'c.git.init');
  const mktree = first(
    (c) => c.callee === 'gitMust' && c.node.arguments[1]?.getText(sf) === `'mktree'`,
  );
  if (init !== undefined) {
    if (mkdir === undefined || mkdir.pos < init.pos)
      out.push(`${name}:authorize(init) 不在 makeRepoDir 之前`);
    if (gitInit === undefined || gitInit.pos < init.pos)
      out.push(`${name}:authorize(init) 不在 git init 之前`);
  }
  if (cas !== undefined && (mktree === undefined || mktree.pos < cas.pos)) {
    out.push(`${name}:authorize(cas) 不在 mktree 之前`);
  }
  if (init !== undefined && cas !== undefined && cas.pos < init.pos)
    out.push(`${name}:cas 先于 init`);
  return out;
}

function problemsOf(sink: GrowthSink, sf: ts.SourceFile): string[] {
  switch (sink.mode) {
    case 'pass_param':
      return passParamProblems(sf, sink.fn);
    case 'port_claim':
      return portClaimProblems(sf, sink.fn);
    case 'auth_port':
      return authPortProblems(sf, sink.fn);
  }
}

describe('GROWTH_SINKS:登记表与形态校验', () => {
  it('登记表非空、冻结、文件与函数都存在;五个汇点恰为 grantCanary / stepAdmission / applyEvent / runPersonalStep / continueBootstrap', () => {
    expect(Object.isFrozen(GROWTH_SINKS)).toBe(true);
    expect(GROWTH_SINKS.map((s) => s.fn).sort()).toEqual([
      'applyEvent',
      'continueBootstrap',
      'grantCanary',
      'runPersonalStep',
      'stepAdmission',
    ]);
    for (const s of GROWTH_SINKS) {
      const sf = parse(s.file, readTextSync(path.join(ROOT, s.file)));
      expect(findFn(sf, s.fn), `${s.file}:${s.fn}`).toBeDefined();
    }
  });

  it('每个登记汇点的实现合规(pass 形参 + 首句检查 / 端口先于副作用 / 授权先于建仓)', () => {
    const bad: string[] = [];
    for (const s of GROWTH_SINKS) {
      bad.push(...problemsOf(s, parse(s.file, readTextSync(path.join(ROOT, s.file)))));
    }
    expect(bad).toEqual([]);
  });

  it('candidate-apply.ts:所有 store.commit 带 beforeRefUpdate;applyIn 只收 applyEvent 取得的钩子', () => {
    const src = readTextSync(path.join(ROOT, 'src/rsi/personal/candidate-apply.ts'));
    const sf = parse('candidate-apply.ts', src);
    const calls = callsIn(sf, sf);
    const commits = calls.filter((c) => c.callee === 'd.store.commit');
    expect(commits).toHaveLength(1);
    expect(
      commits.every((c) => c.node.arguments.some((a) => a.getText(sf).includes('beforeRefUpdate'))),
    ).toBe(true);
    const applyInCalls = calls.filter((c) => c.callee === 'applyIn');
    expect(applyInCalls).toHaveLength(1);
    expect(applyInCalls[0]?.node.arguments.some((a) => a.getText(sf) === 'claimed.hook')).toBe(
      true,
    );
  });

  describe('正向对照:违规的虚拟实现必须被同一检查报出', () => {
    const P = (body: string): ts.SourceFile => parse('v.ts', body);
    it('pass_param:去掉形参 / 改可选 / 检查挪到 await 之后 / 首句不是检查 / 缺 pass 不 return', () => {
      const ok =
        'export async function g(d: D, pass: GrowthPass) { if (!hasSinkPass(pass)) return 1; await d.x(); }';
      expect(passParamProblems(P(ok), 'g')).toEqual([]);
      expect(
        passParamProblems(P('export async function g(d: D) { await d.x(); }'), 'g'),
      ).not.toEqual([]);
      expect(
        passParamProblems(
          P(
            'export async function g(d: D, pass?: GrowthPass) { if (!hasSinkPass(pass)) return 1; }',
          ),
          'g',
        ),
      ).not.toEqual([]);
      expect(
        passParamProblems(
          P(
            'export async function g(d: D, pass: GrowthPass) { await d.x(); if (!hasSinkPass(pass)) return 1; }',
          ),
          'g',
        ),
      ).not.toEqual([]);
      expect(
        passParamProblems(
          P(
            'export async function g(d: D, pass: GrowthPass) { if (!hasSinkPass(pass)) { await d.log(); return 1; } }',
          ),
          'g',
        ),
      ).not.toEqual([]);
      expect(
        passParamProblems(
          P(
            'export async function g(d: D, pass: GrowthPass) { if (!hasSinkPass(pass)) { d.log(); } }',
          ),
          'g',
        ),
      ).not.toEqual([]);
      expect(passParamProblems(P('export const g = 1;'), 'g')).not.toEqual([]);
    });
    it('port_claim:claim 挪到 store.read 之后 / commit 不带钩子 / 没有 claim', () => {
      const ok =
        'export async function applyEvent(d: D) { const c = await claimGrowth(d); const f = await d.store.read(1); return applyIn(d, c); }';
      expect(portClaimProblems(P(ok), 'applyEvent')).toEqual([]);
      const late =
        'export async function applyEvent(d: D) { const f = await d.store.read(1); const c = await claimGrowth(d); return c; }';
      expect(portClaimProblems(P(late), 'applyEvent')).not.toEqual([]);
      expect(
        portClaimProblems(P('export async function applyEvent(d: D) { return 1; }'), 'applyEvent'),
      ).not.toEqual([]);
      const nohook =
        'export async function runPersonalStep(d: D) { const c = await claimGrowthPort(d); await d.store.commit({ kind: 1 }); }';
      expect(portClaimProblems(P(nohook), 'runPersonalStep')).not.toEqual([]);
      const lateStep =
        'export async function runPersonalStep(d: D) { await d.store.commit({ beforeRefUpdate: 1 }); const c = await claimGrowthPort(d); }';
      expect(portClaimProblems(P(lateStep), 'runPersonalStep')).not.toEqual([]);
    });
    it('auth_port:authorize 挪到 mkdir / mktree 之后 → 报出', () => {
      const ok =
        "async function continueBootstrap(c: C) { await authorizeStep(auth, 'init'); await makeRepoDir(c); c.git.init(); await authorizeStep(auth, 'cas'); gitMust(c.git, 'mktree', []); }";
      expect(authPortProblems(P(ok), 'continueBootstrap')).toEqual([]);
      const late =
        "async function continueBootstrap(c: C) { await makeRepoDir(c); await authorizeStep(auth, 'init'); c.git.init(); await authorizeStep(auth, 'cas'); gitMust(c.git, 'mktree', []); }";
      expect(authPortProblems(P(late), 'continueBootstrap')).not.toEqual([]);
      const casLate =
        "async function continueBootstrap(c: C) { await authorizeStep(auth, 'init'); await makeRepoDir(c); c.git.init(); gitMust(c.git, 'mktree', []); await authorizeStep(auth, 'cas'); }";
      expect(authPortProblems(P(casLate), 'continueBootstrap')).not.toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// ② 同名扫描 / ③ 写出口覆盖扫描
// ---------------------------------------------------------------------------
async function walkTs(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of await readDir(dir)) {
    const p = path.join(dir, e.name);
    if (e.isDirectory) await walkTs(p, out);
    else if (e.isFile && p.endsWith('.ts')) out.push(p);
  }
  return out;
}
const rel = (abs: string): string => path.relative(ROOT, abs).split(path.sep).join('/');

const SINK_NAMES: readonly string[] = [...GROWTH_SINKS.map((s) => s.fn)];

/** 文件里**定义**的同名函数(函数声明 / `const x = (async) () =>`;再导出不算) */
export function definedSinkNames(file: string, text: string): string[] {
  const sf = parse(file, text);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name !== undefined && SINK_NAMES.includes(n.name.text)) {
      out.push(n.name.text);
    }
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      SINK_NAMES.includes(n.name.text) &&
      n.initializer !== undefined &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    ) {
      out.push(n.name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

export interface WriteExit {
  kind: 'canary_write' | 'hooked_commit';
  fn: string;
}
function enclosingFn(n: ts.Node, sf: ts.SourceFile): string {
  for (let p: ts.Node | undefined = n.parent; p !== undefined; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name !== undefined) return p.name.text;
    // 只有「函数值的变量」才算所在函数(`const c = await d.store.commit(…)` 的 `c` 不是函数)
    if (
      ts.isVariableDeclaration(p) &&
      ts.isIdentifier(p.name) &&
      p.initializer !== undefined &&
      (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))
    ) {
      return p.name.getText(sf);
    }
  }
  return '<top>';
}
/** 文件里的增影响写出口:写 / 删 canary.json 与 canary-admission.json、带 beforeRefUpdate 的提交 */
export function writeExits(file: string, text: string): WriteExit[] {
  const sf = parse(file, text);
  const out: WriteExit[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(sf);
      const args = n.arguments.map((a) => a.getText(sf)).join(' ');
      if (
        (callee === 'writeRsiFileAtomic' || callee === 'removeRsiFile') &&
        /CANARY_FILES\.(canary|admission)\b/.test(args)
      ) {
        out.push({ kind: 'canary_write', fn: enclosingFn(n, sf) });
      }
      if (callee.endsWith('.commit') && args.includes('beforeRefUpdate')) {
        out.push({ kind: 'hooked_commit', fn: enclosingFn(n, sf) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * 冻结的写出口白名单(`<文件>:<函数>:<种类>`)。登记汇点自身 + 两个**只减影响**的写者(理由随条):
 *  - `canary-mute.ts:muteCanary`:熔断 / AUTO_PAUSE 把 canary.json 置为不注入(`agents_inject = []`),只减少影响;
 *  - `canary-mute.ts:removeCanary`:撤销路径删缓存文件(只收紧);
 *  - `candidate-apply.ts:applyIn`:`applyEvent` 的内部实现,钩子只来自 `claimed.hook`(上一个用例钉住)。
 */
const REDUCING_WRITERS: readonly string[] = [
  'src/rsi/canary/canary-mute.ts:muteCanary:canary_write',
  'src/rsi/canary/canary-mute.ts:removeCanary:canary_write',
  'src/rsi/personal/candidate-apply.ts:applyIn:hooked_commit',
];
const REGISTERED_EXITS: readonly string[] = [
  'src/rsi/canary/canary-writer.ts:grantCanary:canary_write',
  'src/rsi/canary/admission-write.ts:stepAdmission:canary_write',
  'src/rsi/personal/candidate-step.ts:runPersonalStep:hooked_commit',
];

/**
 * 同名但**不是**汇点的既有定义(冻结;新增 = 改本表并写理由):
 *  - `worker.ts:runPersonalStep`:worker 的 P 点包装(调 `stage.run`,违约时调兜底),不触碰候选创建 / 提交;它不 import `candidate-step.ts`(`c1b-closure.test.ts` 钉住 worker 闭包无增影响模块)。
 */
const SAME_NAME_EXEMPT: readonly string[] = ['src/rsi/worker.ts:runPersonalStep'];

describe('同名扫描与写出口覆盖扫描(防漏登记)', () => {
  it('src/rsi/** 里汇点同名函数只定义在登记的文件里', async () => {
    const registered = new Map(GROWTH_SINKS.map((s) => [s.fn, s.file]));
    const stray: string[] = [];
    for (const f of await walkTs(path.join(ROOT, 'src/rsi'))) {
      for (const name of definedSinkNames(rel(f), readTextSync(f))) {
        if (registered.get(name) !== rel(f) && !SAME_NAME_EXEMPT.includes(`${rel(f)}:${name}`)) {
          stray.push(`${rel(f)}:${name}`);
        }
      }
    }
    expect(stray).toEqual([]);
  });

  it('src/rsi/** 的增影响写出口 ⊆ 登记汇点 ∪ 冻结的只减影响白名单;登记汇点的出口确实都在(不是空扫)', async () => {
    const found = new Set<string>();
    for (const f of await walkTs(path.join(ROOT, 'src/rsi'))) {
      for (const x of writeExits(rel(f), readTextSync(f))) found.add(`${rel(f)}:${x.fn}:${x.kind}`);
    }
    const allowed = new Set([...REGISTERED_EXITS, ...REDUCING_WRITERS]);
    expect([...found].filter((x) => !allowed.has(x))).toEqual([]);
    for (const x of REGISTERED_EXITS) expect(found.has(x), x).toBe(true);
    expect(Object.isFrozen(GROWTH_SINKS)).toBe(true);
  });

  it('正向对照:不同名函数写 canary.json / 带钩子提交 / 同名新定义 → 同一扫描报出', () => {
    const rogue =
      "import { writeRsiFileAtomic } from './atomic-write.js';\nexport async function sneakyGrant(d: D) { await writeRsiFileAtomic(d.io, d.dir, CANARY_FILES.canary, 'x', []); }";
    expect(writeExits('src/rsi/canary/rogue.ts', rogue)).toEqual([
      { kind: 'canary_write', fn: 'sneakyGrant' },
    ]);
    const rogueAdm =
      "export const foo = async (d: D) => { await writeRsiFileAtomic(d.io, d.dir, CANARY_FILES.admission, 'x', []); };";
    expect(writeExits('x.ts', rogueAdm)).toEqual([{ kind: 'canary_write', fn: 'foo' }]);
    const hooked =
      'export async function bar(d: D) { await d.store.commit({ beforeRefUpdate: h }); }';
    expect(writeExits('x.ts', hooked)).toEqual([{ kind: 'hooked_commit', fn: 'bar' }]);
    // 对照:普通提交 / 写别的文件不算增影响出口
    expect(
      writeExits(
        'x.ts',
        'export async function ok(d: D) { await d.store.commit({ kind: 1 }); await writeRsiFileAtomic(d.io, d.dir, STATE_FILE, "x", []); }',
      ),
    ).toEqual([]);
    expect(definedSinkNames('x.ts', 'export async function grantCanary() {}')).toEqual([
      'grantCanary',
    ]);
    expect(definedSinkNames('x.ts', 'export const stepAdmission = async () => 1;')).toEqual([
      'stepAdmission',
    ]);
    expect(definedSinkNames('x.ts', "export { grantCanary } from './canary-writer.js';")).toEqual(
      [],
    );
  });

  it('sink_gate_list_emptied(对照):登记表若被清空,门会因「汇点集合不符」红(上面第一条用例钉住五个名字)', () => {
    expect(GROWTH_SINKS.length).toBe(5);
  });
});
