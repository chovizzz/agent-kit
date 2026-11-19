/**
 * D1b-2:`GROWTH_SINKS` 架构门(AST;I9 / I15;W0-29 第 9 条 T5)。三层:
 *  ① 登记表里每个汇点按形态校验:`pass_param` = 最后一个形参 `pass: GrowthPass` 非可选 + 函数体第一条语句是 `if (!hasSinkPass(pass)) return …`(任何 await 之前);
 *     `port_claim` = 钩子经 `claim*` 取得,且先于 `store.read` / `seal.open` / `store.commit`,所有 `store.commit(` 都带 `beforeRefUpdate`;`auth_port` = `authorize` 先于 `mkdir` / `git init` / `mktree`;
 *  ② 同名扫描:`src/rsi/**` 里定义了与汇点同名的函数而不在登记文件里 = 红(防漏登记 / 拷贝出绕过版);
 *  ③ 写出口覆盖扫描:写 `canary.json` / `canary-admission.json` 的调用,所在函数必须 ⊆ 登记表 ∪ 冻结的「只减影响」白名单(带理由);
 *  ④ **权威写出口反查**(验收第 1 轮第 2 条):从权威提交出口(`commitPersonal` / `*.store.commit` / 带 `txnId` 的 `*.commit({…})`)反查**全部**调用者,**不看有没有钩子**:
 *     调用者必须是登记的 `port_claim` 汇点,或精确白名单(减影响 / 纯转发写者,带理由);新增一个未登记、无钩子的 lifecycle 写者 = 红。
 *     白名单里的 `applyIn` 另验「只被 `applyEvent` 调用」;两个 `port_claim` 汇点另验**钩子数据流**:claim 的返回值 → 拒绝分支先于提交 → 提交的 `beforeRefUpdate` 恰为 claim 得到的那个钩子。
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
  out.push(...hookFlowProblems(sf, name));
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

// ---------------------------------------------------------------------------
// ④ 钩子数据流(轻量 AST 判定):claim 返回值 → 拒绝分支先于提交 → 提交的 beforeRefUpdate 恰为 claim 得到的钩子
// ---------------------------------------------------------------------------
function findAll<T extends ts.Node>(root: ts.Node, pred: (n: ts.Node) => n is T): T[] {
  const out: T[] = [];
  const visit = (n: ts.Node): void => {
    if (pred(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}
const isCall = (n: ts.Node): n is ts.CallExpression => ts.isCallExpression(n);
const isIf = (n: ts.Node): n is ts.IfStatement => ts.isIfStatement(n);

/** `const V = await <claimFn>(…)` 的变量名 */
function claimVar(fn: ts.Node, sf: ts.SourceFile, claimFn: string): string | undefined {
  const decls = findAll(fn, (n): n is ts.VariableDeclaration => ts.isVariableDeclaration(n));
  for (const d of decls) {
    const init = d.initializer;
    if (
      init !== undefined &&
      ts.isAwaitExpression(init) &&
      ts.isCallExpression(init.expression) &&
      init.expression.expression.getText(sf) === claimFn &&
      ts.isIdentifier(d.name)
    ) {
      return d.name.text;
    }
  }
  return undefined;
}

const unparen = (e: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(e) ? unparen(e.expression) : e;

/**
 * 提交调用**实参对象的有效结构**里 `beforeRefUpdate` 的来源(不是「文本里出现过」):
 *  - 实参恰为 1 个对象字面量;顶层属性里没有计算属性名、没有除下面这一种之外的展开;
 *  - `beforeRefUpdate` 只能经两种形态之一出现、且**全对象恰一处**(不可能被后面的同名属性 / 展开覆盖):
 *      `direct`:顶层 `beforeRefUpdate: <表达式>`;
 *      `cond`:顶层展开 `...(H !== undefined ? { beforeRefUpdate: H } : {})`(条件方向是 `!== undefined` → 有钩子才带;翻成 `===` 就是「没钩子才带」)。
 * 返回问题清单与解析出的来源(`direct` 的初值文本 / `cond` 的 H 文本)。
 */
export function commitHookStructure(
  call: ts.CallExpression,
  sf: ts.SourceFile,
): { problems: string[]; direct: string | null; cond: string | null } {
  const problems: string[] = [];
  let direct: string | null = null;
  let cond: string | null = null;
  const spec = call.arguments[0];
  if (call.arguments.length !== 1 || spec === undefined || !ts.isObjectLiteralExpression(spec)) {
    return { problems: ['提交实参不是单个对象字面量'], direct, cond };
  }
  let seen = 0;
  for (const p of spec.properties) {
    if (ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name)) {
      if (p.name.getText(sf) === 'beforeRefUpdate') {
        seen++;
        direct = p.initializer.getText(sf);
      }
    } else if (ts.isShorthandPropertyAssignment(p)) {
      if (p.name.text === 'beforeRefUpdate') {
        seen++;
        direct = 'beforeRefUpdate';
      }
    } else if (ts.isSpreadAssignment(p)) {
      const e = unparen(p.expression);
      const ok =
        ts.isConditionalExpression(e) &&
        ts.isBinaryExpression(e.condition) &&
        e.condition.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
        ts.isIdentifier(e.condition.left) &&
        e.condition.right.getText(sf) === 'undefined' &&
        ts.isObjectLiteralExpression(e.whenTrue) &&
        e.whenTrue.properties.length === 1 &&
        ts.isPropertyAssignment(e.whenTrue.properties[0] as ts.ObjectLiteralElementLike) &&
        ts.isObjectLiteralExpression(e.whenFalse) &&
        e.whenFalse.properties.length === 0;
      if (!ok) {
        problems.push(`含无法静态确认的展开:${p.getText(sf)}`);
        continue;
      }
      const t = e.whenTrue.properties[0] as ts.PropertyAssignment;
      const h = (e.condition.left as ts.Identifier).text;
      if (t.name.getText(sf) !== 'beforeRefUpdate' || t.initializer.getText(sf) !== h) {
        problems.push(`条件展开不是 \`...(${h} !== undefined ? { beforeRefUpdate: ${h} } : {})\``);
        continue;
      }
      seen++;
      cond = h;
    } else if (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isAccessor(p)) {
      problems.push(`含无法静态确认的属性:${p.getText(sf).slice(0, 40)}`);
    }
  }
  if (seen > 1) problems.push(`beforeRefUpdate 出现 ${seen} 处(后者会覆盖前者)`);
  return { problems, direct, cond };
}

/** `if (V.kind === 'halt' || V.kind === 'denied') return V`:条件恰为这两个严格比较的析取;then 分支**直接**(不在嵌套函数 / 子块里)返回 V */
export function isDenyGuard(i: ts.IfStatement, v: string, sf: ts.SourceFile): boolean {
  const operands: string[] = [];
  const flat = (e: ts.Expression): void => {
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      flat(e.left);
      flat(e.right);
    } else operands.push(e.getText(sf));
  };
  flat(i.expression);
  const want = [`${v}.kind === 'halt'`, `${v}.kind === 'denied'`];
  if ([...operands].sort().join('|') !== [...want].sort().join('|')) return false;
  const isRet = (s: ts.Statement): boolean =>
    ts.isReturnStatement(s) && s.expression?.getText(sf) === v;
  const t = i.thenStatement;
  return isRet(t) || (ts.isBlock(t) && t.statements.some(isRet));
}

/** 分支内有 continue / return(不算嵌套函数里的:那是别的函数的出口) */
function stmtExits(n: ts.Node): boolean {
  let found = false;
  const visit = (x: ts.Node): void => {
    if (ts.isFunctionLike(x) && x !== n) return;
    if (ts.isContinueStatement(x) || ts.isReturnStatement(x)) found = true;
    ts.forEachChild(x, visit);
  };
  visit(n);
  return found;
}

/**
 * 两个 `port_claim` 汇点的钩子数据流:
 *  - `runPersonalStep`:`const V = await claimGrowthPort(…)`;提交前有 `if (!V.ok) {… continue / return}`;每个 `d.store.commit({…})` 的 `beforeRefUpdate` 初值恰为 `V.hook`;
 *  - `applyEvent`:`const V = await claimGrowth(…)`;`applyIn(…)` 之前有 `if (V.kind === …) return V`(拒绝不往下走);`applyIn` 的实参含 `V.hook`;
 *  - `applyIn`:它唯一的 `d.store.commit({…})` 的 `beforeRefUpdate` 初值恰为形参 `hook`;且 `applyIn` 只被 `applyEvent` 调用。
 */
export function hookFlowProblems(sf: ts.SourceFile, name: string): string[] {
  const out: string[] = [];
  const fn = findFn(sf, name);
  if (fn === undefined) return [`${name}:函数不存在`];
  const calls = findAll(fn, isCall);
  const commits = calls.filter((c) => c.expression.getText(sf) === 'd.store.commit');
  if (name === 'runPersonalStep' || name === 'applyEvent') {
    const claimFn = name === 'runPersonalStep' ? 'claimGrowthPort' : 'claimGrowth';
    const v = claimVar(fn, sf, claimFn);
    if (v === undefined) return [`${name}:没有 const v = await ${claimFn}(…)`];
    if (name === 'runPersonalStep') {
      if (commits.length === 0) out.push(`${name}:没有 store.commit(创建提交缺失?)`);
      for (const c of commits) {
        const h = commitHookStructure(c, sf);
        out.push(...h.problems.map((x) => `${name}:${x}`));
        if (h.direct !== `${v}.hook` || h.cond !== null) {
          out.push(
            `${name}:store.commit 的有效 beforeRefUpdate 不是顶层 \`beforeRefUpdate: ${v}.hook\`(direct=${h.direct} cond=${h.cond})`,
          );
        }
        const guard = findAll(fn, isIf).find(
          (i) =>
            i.expression.getText(sf) === `!${v}.ok` &&
            i.getStart(sf) < c.getStart(sf) &&
            stmtExits(i.thenStatement),
        );
        if (guard === undefined) out.push(`${name}:提交之前没有 if (!${v}.ok) {…continue/return}`);
      }
    } else {
      const inCalls = calls.filter((c) => c.expression.getText(sf) === 'applyIn');
      if (inCalls.length !== 1) out.push(`${name}:applyIn 调用数 ${inCalls.length} ≠ 1`);
      for (const c of inCalls) {
        if (!c.arguments.some((a) => a.getText(sf) === `${v}.hook`)) {
          out.push(`${name}:applyIn 的实参里没有 ${v}.hook`);
        }
        // 位置:`V.hook` 必须落在 applyIn 的 `hook` 形参那个位置(只「出现」不够:换到别的形参位置 = 钩子被当成别的东西)
        const inFn = findFn(sf, 'applyIn');
        const at = inFn?.parameters.findIndex((p) => p.name.getText(sf) === 'hook') ?? -1;
        if (inFn !== undefined && (at < 0 || c.arguments[at]?.getText(sf) !== `${v}.hook`)) {
          out.push(`${name}:${v}.hook 不在 applyIn 的 hook 形参位置(${at})`);
        }
        const guard = findAll(fn, isIf).find(
          (i) => i.getStart(sf) < c.getStart(sf) && isDenyGuard(i, v, sf),
        );
        if (guard === undefined) {
          out.push(
            `${name}:applyIn 之前没有 if (${v}.kind === 'halt' || … === 'denied') return ${v}`,
          );
        }
      }
    }
  } else if (name === 'applyIn') {
    if (!fn.parameters.some((p) => p.name.getText(sf) === 'hook'))
      out.push(`${name}:没有形参 hook`);
    if (commits.length !== 1) out.push(`${name}:store.commit 数 ${commits.length} ≠ 1`);
    for (const c of commits) {
      const h = commitHookStructure(c, sf);
      out.push(...h.problems.map((x) => `${name}:${x}`));
      if (h.cond !== 'hook' || h.direct !== null) {
        out.push(
          `${name}:store.commit 的有效 beforeRefUpdate 不是 \`...(hook !== undefined ? { beforeRefUpdate: hook } : {})\`(direct=${h.direct} cond=${h.cond})`,
        );
      }
    }
  } else {
    out.push(`${name}:没有钩子数据流规则`);
  }
  return out;
}

/** `name` 作为标识符的**非调用、非声明**引用(`const f = applyIn` / 当参数传):这些引用让「只被 applyEvent 调用」的反查失效 */
export function applyInValueRefs(sf: ts.SourceFile, name: string): string[] {
  return findAll(sf, (n): n is ts.Identifier => ts.isIdentifier(n) && n.text === name)
    .filter((id) => {
      const p = id.parent;
      if (ts.isFunctionDeclaration(p) && p.name === id) return false;
      if (ts.isCallExpression(p) && p.expression === id) return false;
      return true;
    })
    .map((id) => `${enclosingFn(id, sf)}:${id.getText(sf)}`);
}

/** `personalRepoRemoval` 的提交实参(第 3 个):顶层对象字面量、无展开 / 计算属性、`upserts` 恰为 `[]`、有 `deletes`、无 `beforeRefUpdate` */
export function removalSpecProblems(call: ts.CallExpression, sf: ts.SourceFile): string[] {
  const spec = call.arguments[2];
  if (spec === undefined || !ts.isObjectLiteralExpression(spec))
    return ['第 3 个实参不是对象字面量'];
  const out: string[] = [];
  const names = new Map<string, string>();
  for (const p of spec.properties) {
    if (ts.isSpreadAssignment(p)) out.push('含展开');
    else if (ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name)) {
      names.set(p.name.getText(sf), p.initializer.getText(sf));
    } else if (ts.isShorthandPropertyAssignment(p)) names.set(p.name.text, p.name.text);
    else out.push('含无法静态确认的属性');
  }
  if (names.get('upserts') !== '[]') out.push('upserts 不是 []');
  if (!names.has('deletes')) out.push('没有 deletes');
  if (names.has('beforeRefUpdate')) out.push('带 beforeRefUpdate');
  return out;
}

/** 文件里 `applyIn(…)` 调用所在的函数名(反查调用者) */
export function callersOfIn(sf: ts.SourceFile, callee: string): string[] {
  return findAll(sf, isCall)
    .filter((c) => c.expression.getText(sf) === callee)
    .map((c) => enclosingFn(c, sf));
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
        "export async function applyEvent(d: D) { const c = await claimGrowth(d); if (c.kind === 'halt' || c.kind === 'denied') return c; const f = await d.store.read(1); return applyIn(d, c.hook); }";
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

// ---------------------------------------------------------------------------
// ④ 权威写出口反查(不看钩子、不看拼写)
// ---------------------------------------------------------------------------
export interface AuthExit {
  kind: 'commit' | 'commit_personal';
  fn: string;
}
/**
 * 提交类出口:`commitPersonal(…)` / `X.commitPersonal(…)`、**任何** `*.commit(…)` / 裸 `commit(…)` 调用;返回每个调用所在的函数。
 * 故意**不**按 `store.commit` 拼写或 `txnId` 字面量筛(别名、`const s = d.store; s.commit(spec)` 都逃不掉):`src/rsi/**` 里每一个提交类调用都必须在下面的允许集里登记,新增 = 红。
 * **不看 `beforeRefUpdate`**——「不带钩子的增效提交」正是这条要抓的。
 */
export function authoritativeExits(file: string, text: string): AuthExit[] {
  const sf = parse(file, text);
  const out: AuthExit[] = [];
  for (const n of findAll(sf, isCall)) {
    const callee = n.expression.getText(sf);
    if (callee === 'commitPersonal' || callee.endsWith('.commitPersonal')) {
      out.push({ kind: 'commit_personal', fn: enclosingFn(n, sf) });
    } else if (callee === 'commit' || callee.endsWith('.commit')) {
      out.push({ kind: 'commit', fn: enclosingFn(n, sf) });
    }
  }
  return out;
}

const PROTECTED_MEMBERS: readonly string[] = ['commit', 'commitPersonal'];
const isProtectedLiteral = (e: ts.Expression): boolean =>
  (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) &&
  PROTECTED_MEMBERS.includes(e.text);

/**
 * 受保护写能力的**引用**(不只是调用表达式):只放行「`x.commit(…)` / `x.commitPersonal(…)` / 裸 `commitPersonal(…)` 的直接调用」(这些由 `authoritativeExits` 按调用点计数);
 * 其余形态一律报出,格式 `<所在函数>:<形态>:<源码文本>`:
 *  - `value`:`x.commit` / `x.commitPersonal` 当值用(别名赋值、当参数、`.call` / `.bind`、括号包裹后调用);
 *  - `element`:`x['commit']`(括号 / 字面量访问);
 *  - `destructure`:`const { commit } = store` / `{ commit: c }`(含参数解构);
 *  - `bare`:`commitPersonal` 标识符不是直接被调用(别名 / 当值传递 / 再导出 / `typeof`);import 说明符与函数声明名不算(import 另由 `commitPersonalImports` 钉住);
 *  - `shorthand`:对象字面量里的 `{ commitPersonal }` 简写。
 * 声明位置(接口成员、方法、`commit: …` 属性名)不是引用。不做通用跨函数数据流:`x[k]`(非字面量键)读不出,不在本扫描范围。
 */
export function protectedRefs(file: string, text: string): string[] {
  const sf = parse(file, text);
  const out: string[] = [];
  const add = (n: ts.Node, form: string): void => {
    out.push(`${enclosingFn(n, sf)}:${form}:${n.getText(sf).replace(/\s+/g, ' ')}`);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n) && PROTECTED_MEMBERS.includes(n.name.text)) {
      const p = n.parent;
      if (!(ts.isCallExpression(p) && p.expression === n)) add(n, 'value');
    } else if (ts.isElementAccessExpression(n) && isProtectedLiteral(n.argumentExpression)) {
      add(n, 'element');
    } else if (
      ts.isBindingElement(n) &&
      ts.isObjectBindingPattern(n.parent) &&
      PROTECTED_MEMBERS.includes((n.propertyName ?? n.name).getText(sf))
    ) {
      add(n, 'destructure');
    } else if (ts.isShorthandPropertyAssignment(n) && n.name.text === 'commitPersonal') {
      add(n, 'shorthand');
    } else if (ts.isIdentifier(n) && n.text === 'commitPersonal') {
      const p = n.parent;
      const decl =
        ts.isImportSpecifier(p) ||
        (ts.isFunctionDeclaration(p) && p.name === n) ||
        (ts.isPropertyAccessExpression(p) && p.name === n) || // 上面 value 分支已覆盖
        ((ts.isPropertyAssignment(p) ||
          ts.isMethodDeclaration(p) ||
          ts.isMethodSignature(p) ||
          ts.isPropertySignature(p) ||
          ts.isPropertyDeclaration(p)) &&
          p.name === n) ||
        (ts.isBindingElement(p) && ts.isObjectBindingPattern(p.parent)) || // destructure 分支已覆盖
        ts.isShorthandPropertyAssignment(p);
      const directCall = ts.isCallExpression(p) && p.expression === n;
      if (!decl && !directCall) add(n, 'bare');
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** `commitPersonal` 的 import 说明符(含别名:`import { commitPersonal as cp }`);返回 `[文件, 是否别名]` */
export function commitPersonalImports(file: string, text: string): { alias: boolean }[] {
  const sf = parse(file, text);
  return findAll(
    sf,
    (n): n is ts.ImportSpecifier =>
      ts.isImportSpecifier(n) && (n.propertyName ?? n.name).text === 'commitPersonal',
  ).map((n) => ({ alias: n.propertyName !== undefined }));
}

/**
 * 提交类出口的允许集(`<文件>:<函数>:<种类>`,理由随条;新增 = 改本表并写理由):
 *  登记的 `port_claim` 汇点 / 其内部实现:
 *  - `candidate-step.ts:runPersonalStep`:创建提交(钩子数据流另验);
 *  - `candidate-apply.ts:applyIn`:`applyEvent` 的内部实现,只被 `applyEvent` 调用(下面反查),钩子只来自 `applyEvent` 的 claim(减影响事件无钩子);
 *  精确白名单(不是增影响汇点):
 *  - `candidate-repo.ts:personalRepoStore`:`AuthoritativeStore.commit` 的适配器,原样转发调用方的 spec(含钩子,下面验实参就是 `spec`),自己不构造提交;
 *  - `rollback-repo.ts:personalRepoRemoval`:撤销路径的仓库文件移除:`upserts: []` + `deletes`,只删 kit 命名空间内非 lifecycle 的文件(`lifecycle` 顶层会抛 `TreeSpecError`),只收紧;
 *  - `store/apply-once.ts` / `store/compactor.ts` 的 `ledgerWrite.commit` / `cp.commit`:效果账与审计的存储核提交,与私有仓库的 lifecycle 权威记录无关(不写 `refs/heads/rsi`)。
 */
const AUTH_EXITS_ALLOWED: readonly string[] = [
  'src/rsi/personal/candidate-step.ts:runPersonalStep:commit',
  'src/rsi/personal/candidate-apply.ts:applyIn:commit',
  'src/rsi/personal/candidate-repo.ts:personalRepoStore:commit_personal',
  'src/rsi/personal/rollback-repo.ts:personalRepoRemoval:commit_personal',
  'src/rsi/store/apply-once.ts:createKeyedEffectSink:commit',
  'src/rsi/store/apply-once.ts:createLedgerRecovery:commit',
  'src/rsi/store/apply-once.ts:createUserVetoPort:commit',
  'src/rsi/store/apply-once.ts:createUserVetoPort:commit', // 该函数内两处(多重集按调用点计)
  'src/rsi/store/compactor.ts:cleanupSteps:commit',
  'src/rsi/store/compactor.ts:run:commit',
];
/** 允许 import `commitPersonal` 的文件(非别名) */
const COMMIT_PERSONAL_IMPORTERS: readonly string[] = [
  'src/rsi/personal/candidate-repo.ts',
  'src/rsi/personal/rollback-repo.ts',
];

/**
 * 受保护写能力**引用**的精确允许集(`<文件>:<函数>:<形态>:<源码文本>`,理由随条):
 *  - `candidate-step.ts:runPersonalStep:value:c.commit`:读 `CommitResult.commit`(提交后的新 HEAD 哈希,结果对象的字段,不是写能力)。
 */
const AUTH_REFS_ALLOWED: readonly string[] = [
  'src/rsi/personal/candidate-step.ts:runPersonalStep:value:c.commit',
];

describe('④ 权威写出口反查:调用者 ⊆ 登记汇点 ∪ 精确白名单(不看钩子、不看拼写)', () => {
  it('src/rsi/** 的提交类出口调用者恰为允许集(多一个 = 红);允许集里每一项都真实存在(不是空扫);登记的 port_claim 汇点都在其中', async () => {
    const foundList: string[] = [];
    for (const f of await walkTs(path.join(ROOT, 'src/rsi'))) {
      for (const x of authoritativeExits(rel(f), readTextSync(f))) {
        foundList.push(`${rel(f)}:${x.fn}:${x.kind}`);
      }
    }
    // 按调用点计数(多重集):已白名单函数里再加第二笔提交也是红
    expect([...foundList].sort()).toEqual([...AUTH_EXITS_ALLOWED].sort());
    const found = new Set(foundList);
    // 登记的 port_claim 汇点:runPersonalStep 直接提交;applyEvent 经 applyIn(下一条钉住)
    for (const s of GROWTH_SINKS.filter((x) => x.mode === 'port_claim')) {
      expect(
        s.fn === 'runPersonalStep'
          ? found.has(`${s.file}:${s.fn}:commit`)
          : callersOfIn(parse(s.file, readTextSync(path.join(ROOT, s.file))), 'applyIn').includes(
              s.fn,
            ),
        s.fn,
      ).toBe(true);
    }
  });

  it('受保护写能力的引用(别名 / 括号访问 / 解构 / 当值传递 / 命名空间取值)恰为精确允许集:不止盯调用表达式', async () => {
    const found: string[] = [];
    for (const f of await walkTs(path.join(ROOT, 'src/rsi'))) {
      for (const x of protectedRefs(rel(f), readTextSync(f))) found.push(`${rel(f)}:${x}`);
    }
    expect([...found].sort()).toEqual([...AUTH_REFS_ALLOWED].sort());
  });

  it('commitPersonal 只被两个允许的文件 import,且不得改名 import(别名会让反查按调用名漏掉)', async () => {
    const importers: string[] = [];
    for (const f of await walkTs(path.join(ROOT, 'src/rsi'))) {
      const imps = commitPersonalImports(rel(f), readTextSync(f));
      expect(
        imps.filter((i) => i.alias),
        rel(f),
      ).toEqual([]);
      if (imps.length > 0) importers.push(rel(f));
    }
    expect(importers.sort()).toEqual([...COMMIT_PERSONAL_IMPORTERS].sort());
  });

  it('白名单写者的形状:personalRepoStore 原样转发 spec;personalRepoRemoval 只删(upserts 为空数组、带 deletes)', () => {
    const repo = parse(
      'candidate-repo.ts',
      readTextSync(path.join(ROOT, 'src/rsi/personal/candidate-repo.ts')),
    );
    const fwd = findAll(repo, isCall).filter(
      (c) => c.expression.getText(repo) === 'commitPersonal',
    );
    expect(fwd).toHaveLength(1);
    expect(fwd[0]?.arguments[2]?.getText(repo)).toBe('spec');
    const rem = parse(
      'rollback-repo.ts',
      readTextSync(path.join(ROOT, 'src/rsi/personal/rollback-repo.ts')),
    );
    const calls = findAll(rem, isCall).filter(
      (c) => c.expression.getText(rem) === 'commitPersonal',
    );
    expect(calls).toHaveLength(1);
    expect(removalSpecProblems(calls[0] as ts.CallExpression, rem)).toEqual([]);
  });

  it('applyIn 只被 applyEvent 调用,且没有被当成值引用(赋给变量 / 当参数传)', () => {
    const sf = parse(
      'candidate-apply.ts',
      readTextSync(path.join(ROOT, 'src/rsi/personal/candidate-apply.ts')),
    );
    expect(callersOfIn(sf, 'applyIn')).toEqual(['applyEvent']);
    expect(applyInValueRefs(sf, 'applyIn')).toEqual([]);
  });

  it('钩子数据流:claim 返回值 → 拒绝分支先于提交 → beforeRefUpdate 恰为 claim 得到的钩子(applyEvent / applyIn / runPersonalStep)', () => {
    const apply = parse(
      'candidate-apply.ts',
      readTextSync(path.join(ROOT, 'src/rsi/personal/candidate-apply.ts')),
    );
    const step = parse(
      'candidate-step.ts',
      readTextSync(path.join(ROOT, 'src/rsi/personal/candidate-step.ts')),
    );
    expect(hookFlowProblems(apply, 'applyEvent')).toEqual([]);
    expect(hookFlowProblems(apply, 'applyIn')).toEqual([]);
    expect(hookFlowProblems(step, 'runPersonalStep')).toEqual([]);
  });

  describe('正向对照:违规的虚拟源码必须被同一检查报出', () => {
    const exits = (src: string): string[] =>
      authoritativeExits('v.ts', src).map((x) => `${x.fn}:${x.kind}`);
    it('不带钩子的 lifecycle 写者 / 别名提交 / 变量传参提交 / commitPersonal 直调与命名空间调用 → 都被反查到', () => {
      expect(
        exits(
          'export async function sneaky(d: D) { await d.store.commit({ kind: 1, txnId: 1 }); }',
        ),
      ).toEqual(['sneaky:commit']);
      expect(
        exits('export async function alias(d: D) { const s = d.repo; await s.commit(spec); }'),
      ).toEqual(['alias:commit']);
      expect(
        exits('export async function raw(d: D) { await commitPersonal(d.deps, d.locks, spec); }'),
      ).toEqual(['raw:commit_personal']);
      expect(
        exits('export async function ns(d: D) { await personal.commitPersonal(a, b, spec); }'),
      ).toEqual(['ns:commit_personal']);
      expect(exits('export async function bare(d: D) { await commit(spec); }')).toEqual([
        'bare:commit',
      ]);
      // 对照:不是提交的调用不算
      expect(
        exits('export async function ok(p: P) { await p.save(plan.next); foo({ txnId: 1 }); }'),
      ).toEqual([]);
    });
    it('commitPersonal 改名 import → 报出别名', () => {
      expect(
        commitPersonalImports('v.ts', "import { commitPersonal as cp } from './commit.js';"),
      ).toEqual([{ alias: true }]);
      expect(
        commitPersonalImports('v.ts', "import { commitPersonal } from './commit.js';"),
      ).toEqual([{ alias: false }]);
      expect(commitPersonalImports('v.ts', "import { other } from './commit.js';")).toEqual([]);
    });
    it('引用扫描:方法别名 / 括号访问 / 解构 / 当值传递 / 命名空间取值改名 / .bind → 都报出;已知直接调用与声明位置不报', () => {
      const refs = (src: string): string[] => protectedRefs('v.ts', src);
      expect(refs('function f(d: D) { const c = d.store.commit; return c(spec); }')).toEqual([
        'f:value:d.store.commit',
      ]);
      expect(refs("function f(d: D) { return d.store['commit'](spec); }")).toEqual([
        "f:element:d.store['commit']",
      ]);
      expect(refs('function f(d: D) { const { commit } = d.store; return commit(spec); }')).toEqual(
        ['f:destructure:commit'],
      );
      expect(refs('function f(d: D) { const { commit: c } = d.store; return c(spec); }')).toEqual([
        'f:destructure:commit: c',
      ]);
      expect(refs('function f(d: D) { return run(commitPersonal); }')).toEqual([
        'f:bare:commitPersonal',
      ]);
      expect(refs('function f() { return { commitPersonal }; }')).toEqual([
        'f:shorthand:commitPersonal',
      ]);
      expect(refs('function f(ns: N) { const cp = ns.commitPersonal; return cp(a); }')).toEqual([
        'f:value:ns.commitPersonal',
      ]);
      expect(refs('function f(d: D) { return d.store.commit.bind(d.store)(spec); }')).toEqual([
        'f:value:d.store.commit',
      ]);
      expect(refs('function f(d: D) { return (d.store.commit)(spec); }')).toEqual([
        'f:value:d.store.commit',
      ]);
      // 对照:已知的直接调用形态与声明位置不报(它们由 authoritativeExits 按调用点计数)
      expect(
        refs(
          'function f(d: D, ns: N) { d.store.commit(a); ns.commitPersonal(b); commitPersonal(c); return { commit: async (s: S) => 1 }; } interface I { commit(s: S): Promise<R>; }',
        ),
      ).toEqual([]);
    });
    const P = (body: string): ts.SourceFile => parse('v.ts', body);
    it('提交实参的有效结构:条件方向翻转 / 钩子被后面的同名属性或展开覆盖 / 钩子放进嵌套对象 / 非对象字面量实参 → 报出', () => {
      const flow = (src: string, fn: string): string[] => hookFlowProblems(P(src), fn);
      const okIn =
        'async function applyIn(d: D, hook?: H) { return d.store.commit({ txnId: 1, ...(hook !== undefined ? { beforeRefUpdate: hook } : {}) }); }';
      expect(flow(okIn, 'applyIn')).toEqual([]);
      // 条件方向翻成 ===:没钩子才带(语义相反),旧的「属性初值文本」检查看不出
      expect(flow(okIn.replace('hook !== undefined', 'hook === undefined'), 'applyIn')).not.toEqual(
        [],
      );
      // 后面的展开 / 同名属性覆盖钩子
      expect(flow(okIn.replace('txnId: 1,', 'txnId: 1, ...extra,'), 'applyIn')).not.toEqual([]);
      expect(
        flow(okIn.replace('} : {}) })', '} : {}), beforeRefUpdate: undefined })'), 'applyIn'),
      ).not.toEqual([]);
      // 钩子被挪进嵌套对象(不在提交对象顶层)
      expect(
        flow(
          'async function applyIn(d: D, hook?: H) { return d.store.commit({ txnId: 1, meta: { beforeRefUpdate: hook } }); }',
          'applyIn',
        ),
      ).not.toEqual([]);
      // 实参不是对象字面量
      expect(
        flow(
          'async function applyIn(d: D, hook?: H) { return d.store.commit(buildSpec(hook)); }',
          'applyIn',
        ),
      ).not.toEqual([]);
      const okStep =
        'export async function runPersonalStep(d: D) { for (const x of xs) { const claim = await claimGrowthPort(d.growth); if (!claim.ok) { continue; } await d.store.commit({ txnId: 1, beforeRefUpdate: claim.hook }); } }';
      expect(flow(okStep, 'runPersonalStep')).toEqual([]);
      expect(
        flow(
          okStep.replace('beforeRefUpdate: claim.hook }', 'beforeRefUpdate: claim.hook, ...o }'),
          'runPersonalStep',
        ),
      ).not.toEqual([]);
      expect(
        flow(
          okStep.replace(
            'beforeRefUpdate: claim.hook }',
            '...(claim.hook !== undefined ? { beforeRefUpdate: claim.hook } : {}) }',
          ),
          'runPersonalStep',
        ),
      ).not.toEqual([]);
      // applyEvent:`V.hook` 出现但不在 applyIn 的 hook 形参位置
      const okApply =
        "async function applyEvent(d: D) { const claimed = await claimGrowth(d); if (claimed.kind === 'halt' || claimed.kind === 'denied') return claimed; return applyIn(d, rec, claimed.hook); } async function applyIn(d: D, rec: R, hook?: H) { return 1; }";
      expect(flow(okApply, 'applyEvent')).toEqual([]);
      expect(
        flow(
          okApply.replace('applyIn(d, rec, claimed.hook)', 'applyIn(d, claimed.hook, rec)'),
          'applyEvent',
        ),
      ).not.toEqual([]);
    });
    it('hook 数据流:丢掉 claim 的钩子(换成别的函数)/ 没有拒绝分支 / 拒绝分支不退出(含只在嵌套函数里 return)/ 拒绝分支漏掉 denied / applyIn 不转交', () => {
      const okStep =
        'export async function runPersonalStep(d: D) { for (const x of xs) { const claim = await claimGrowthPort(d.growth); if (!claim.ok) { continue; } await d.store.commit({ txnId: 1, beforeRefUpdate: claim.hook }); } }';
      expect(hookFlowProblems(P(okStep), 'runPersonalStep')).toEqual([]);
      expect(
        hookFlowProblems(
          P(okStep.replace('claim.hook', 'async () => undefined')),
          'runPersonalStep',
        ),
      ).not.toEqual([]);
      expect(
        hookFlowProblems(P(okStep.replace('if (!claim.ok) { continue; }', '')), 'runPersonalStep'),
      ).not.toEqual([]);
      expect(
        hookFlowProblems(P(okStep.replace('continue;', 'log();')), 'runPersonalStep'),
      ).not.toEqual([]);
      expect(
        hookFlowProblems(
          P(okStep.replace('continue;', 'const f = () => { return 1; }; f();')),
          'runPersonalStep',
        ),
      ).not.toEqual([]);
      expect(
        hookFlowProblems(P(okStep.replace(', beforeRefUpdate: claim.hook', '')), 'runPersonalStep'),
      ).not.toEqual([]);
      const okApply =
        "export async function applyEvent(d: D) { const claimed = await claimGrowth(d); if (claimed.kind === 'halt' || claimed.kind === 'denied') return claimed; return applyIn(d, claimed.hook); }";
      expect(hookFlowProblems(P(okApply), 'applyEvent')).toEqual([]);
      expect(
        hookFlowProblems(P(okApply.replace('claimed.hook', 'undefined')), 'applyEvent'),
      ).not.toEqual([]);
      expect(
        hookFlowProblems(
          P(
            okApply.replace(
              "if (claimed.kind === 'halt' || claimed.kind === 'denied') return claimed;",
              '',
            ),
          ),
          'applyEvent',
        ),
      ).not.toEqual([]);
      expect(
        hookFlowProblems(P(okApply.replace(" || claimed.kind === 'denied'", '')), 'applyEvent'),
      ).not.toEqual([]);
      const okIn =
        'async function applyIn(d: D, hook?: H) { return d.store.commit({ txnId: 1, ...(hook !== undefined ? { beforeRefUpdate: hook } : {}) }); }';
      expect(hookFlowProblems(P(okIn), 'applyIn')).toEqual([]);
      expect(
        hookFlowProblems(
          P(okIn.replace('beforeRefUpdate: hook', 'beforeRefUpdate: async () => undefined')),
          'applyIn',
        ),
      ).not.toEqual([]);
      expect(
        hookFlowProblems(
          P(okIn.replace('...(hook !== undefined ? { beforeRefUpdate: hook } : {})', '')),
          'applyIn',
        ),
      ).not.toEqual([]);
    });
    it('guard 语义:|| 换成 && / 缺 denied / return 在嵌套函数里 → 报出;removalSpec:展开覆盖 upserts → 报出', () => {
      const g = (cond: string, body: string): boolean => {
        const sf = P(`function f(claimed: C) { if (${cond}) ${body} }`);
        const i = findAll(sf, isIf)[0] as ts.IfStatement;
        return isDenyGuard(i, 'claimed', sf);
      };
      const both = "claimed.kind === 'halt' || claimed.kind === 'denied'";
      expect(g(both, 'return claimed;')).toBe(true);
      expect(g(both.replace('||', '&&'), 'return claimed;')).toBe(false);
      expect(g("claimed.kind === 'halt'", 'return claimed;')).toBe(false);
      expect(g(both, '{ const h = () => { return claimed; }; h(); }')).toBe(false);
      const spec = (body: string): string[] => {
        const sf = P(`const x = commitPersonal(a, b, ${body});`);
        return removalSpecProblems(findAll(sf, isCall)[0] as ts.CallExpression, sf);
      };
      expect(spec('{ upserts: [], deletes: present }')).toEqual([]);
      expect(spec('{ ...{ upserts: [], deletes: present }, upserts: files }')).not.toEqual([]);
      expect(spec('{ upserts: files, deletes: present }')).not.toEqual([]);
    });
    it('多重集:已白名单函数里新增第二笔提交 → 计数多一 = 与允许集不等', () => {
      const one = authoritativeExits('v.ts', 'function g(p: P) { p.ledgerWrite.commit(a); }');
      const two = authoritativeExits(
        'v.ts',
        'function g(p: P) { p.ledgerWrite.commit(a); other.commit(spec); }',
      );
      expect(one).toHaveLength(1);
      expect(two).toHaveLength(2);
    });
    it('callersOfIn / applyInValueRefs:applyIn 出现在第二个函数里、或被当值引用 → 报出', () => {
      const src =
        'async function applyEvent(d: D) { return applyIn(d); } async function backdoor(d: D) { return applyIn(d); }';
      expect(callersOfIn(P(src), 'applyIn')).toEqual(['applyEvent', 'backdoor']);
      expect(
        applyInValueRefs(
          P('async function applyEvent(d: D) { const f = applyIn; return f(d); }'),
          'applyIn',
        ),
      ).toHaveLength(1);
      expect(
        applyInValueRefs(
          P(
            'async function applyIn(d: D) { return 1; } async function applyEvent(d: D) { return applyIn(d); }',
          ),
          'applyIn',
        ),
      ).toEqual([]);
    });
  });
});
