/**
 * 装配块 B2:`entry_time_only_via_stamp` 架构测试 **B2 档**(设计稿 v3 §C.2 第 4 条、§F B2 ⑥)。
 * 规则:构造 lifecycle 条目事件日的位置(`candidate-apply.ts`、`src/rsi/auto/write/**`)里**不得调用时钟**——不得 `X.now()` / 裸 `now()` / `Date.now()` / 无参 `new Date()`;
 * 取时只经 `entry-stamp.ts`(`stampFirst(d.now)` 把 `d.now` 当**引用**传是允许的)。用 TS AST 判定调用(注释 / 字符串 / 引用不算),不用正则。
 * 全量档:D1b-2 起创建条目取时已改经 `stampFirst`(`candidate-step.ts` 创建分支),`seal_stamp_all_producers` 能力置真仍归 D3;这里**钉住**余下直接取时的数量(`full_tier_remaining_clock_calls_pinned`)并断言创建区间无直接取时:
 * C 改掉它时这条必须同步改,所以它是绊线,不是跳过。每条规则都有正向对照(虚拟违规源码必须被报出)与负向对照(合规写法不报)。
 * 另核 `rollback.ts` 的 `.now()` 取点全部是 journal / 凭据 / 阶段时间(不是审计事件日),条目一律经 `applyEvent`(统一出口)。
 */
import * as path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { readDir, readTextSync } from '../../../src/io/read-fs.js';
import { ROOT } from '../closure-util.js';

/** 源码里的时钟调用点(`<行>:<文本>`) */
export function clockCalls(file: string, src: string): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const at = (n: ts.Node): string =>
    `${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}:${n.getText(sf).replace(/\s+/g, ' ').slice(0, 60)}`;
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      if (ts.isPropertyAccessExpression(e) && e.name.text === 'now') out.push(at(n));
      else if (ts.isIdentifier(e) && e.text === 'now') out.push(at(n));
    } else if (
      ts.isNewExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'Date' &&
      (n.arguments === undefined || n.arguments.length === 0)
    ) {
      out.push(at(n));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

async function walkTs(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of await readDir(dir)) {
    const p = path.join(dir, e.name);
    if (e.isDirectory) await walkTs(p, out);
    else if (e.isFile && p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const rel = (abs: string): string => path.relative(ROOT, abs).split(path.sep).join('/');

describe('entry_time_only_via_stamp(B2 档)', () => {
  it('扫描范围非空(自检):candidate-apply.ts 与 auto/write 下全部 ts', async () => {
    const files = [
      path.join(ROOT, 'src/rsi/personal/candidate-apply.ts'),
      ...(await walkTs(path.join(ROOT, 'src/rsi/auto/write'))),
    ];
    expect(files.length).toBeGreaterThanOrEqual(10);
    expect(files.map(rel)).toContain('src/rsi/auto/write/veto.ts');
  });

  it('candidate-apply.ts 与 src/rsi/auto/write/** 没有任何时钟调用', async () => {
    const files = [
      path.join(ROOT, 'src/rsi/personal/candidate-apply.ts'),
      ...(await walkTs(path.join(ROOT, 'src/rsi/auto/write'))),
    ];
    const hits: Record<string, string[]> = {};
    for (const f of files) {
      const c = clockCalls(f, readTextSync(f));
      if (c.length > 0) hits[rel(f)] = c;
    }
    expect(hits).toEqual({});
  });

  it('取时点只在 entry-stamp.ts(unsealedEntryTime)与 SealRegion.stampFirst', () => {
    const stamp = clockCalls(
      'entry-stamp.ts',
      readTextSync(path.join(ROOT, 'src/rsi/personal/entry-stamp.ts')),
    );
    expect(stamp).toHaveLength(1);
    // 命中的是 `now()` 这个调用节点本身(外层 `.toISOString()` 不是时钟调用):必须是裸调用形态,不是 `X.now()`
    expect(stamp[0]).toMatch(/^\d+:now\(\)$/);
    const seal = clockCalls('seal.ts', readTextSync(path.join(ROOT, 'src/rsi/store/seal.ts')));
    expect(seal.some((c) => c.includes('now()'))).toBe(true);
  });

  it('正向对照:各种直接取时的写法都被报出;把 now 当引用传、注释与字符串不报', () => {
    const bad = clockCalls(
      'x.ts',
      [
        'const a = d.now();',
        'const b = new Date();',
        'const c = Date.now();',
        'const e = now();',
        'const f = deps.clock.now().toISOString();',
      ].join('\n'),
    );
    expect(bad).toHaveLength(5);
    const ok = clockCalls(
      'y.ts',
      [
        '// d.now() 与 new Date() 在注释里',
        'const s = "d.now()";',
        'const t = region.stampFirst(d.now);',
        'const u = new Date(x);',
        'const v = { now: d.now };',
      ].join('\n'),
    );
    expect(ok).toEqual([]);
  });

  it('rollback.ts 的 .now() 只有三处(journal 首次落盘 / 阶段推进 / 撤销凭据),条目一律经 applyEvent', () => {
    const src = readTextSync(path.join(ROOT, 'src/rsi/personal/rollback.ts'));
    const calls = clockCalls('rollback.ts', src);
    expect(calls).toHaveLength(3);
    // 三处的所在语句:newJournal(...)、阶段推进 `t = {...}`、`revoker.write({...})`
    expect(src).toMatch(/newJournal\(req, d\.now\(\)\.toISOString\(\)\)/);
    expect(src).toMatch(/t = \{ \.\.\.t, phase: next, at: d\.now\(\)\.toISOString\(\) \}/);
    expect(src).toMatch(/await d\.revoker\.write\(\{\s*at: d\.now\(\)\.toISOString\(\)/);
    // 记录转移只有 applyOne → applyEvent 一个出口:rollback.ts 里没有直接调用 transition(
    expect(src).not.toMatch(/\btransition\(/);
  });

  it('full_tier_remaining_clock_calls_pinned:candidate-step.ts 恰有 5 处直接取时(D1b-2:创建取时已改经 stampFirst,6 → 5;改掉时同步改本条)', () => {
    const src = readTextSync(path.join(ROOT, 'src/rsi/personal/candidate-step.ts'));
    const calls = clockCalls('candidate-step.ts', src);
    // 余下 5 处:重建工作副本的日期(`utcDay(d.now()…)`)、重建 / 清零的观察行 `at`(无键观察行,走 appendObservation,不入本规则)、闸 / shadow 步的判定上下文取时(不落条目)
    expect(calls).toHaveLength(5);
  });

  it('D1b-2 收紧:创建分支经 stampFirst 取时(封存区域),区间内没有任何直接时钟调用', () => {
    const src = readTextSync(path.join(ROOT, 'src/rsi/personal/candidate-step.ts'));
    expect(src).toContain('region.stampFirst(d.now)');
    expect(src).toContain('unsealedEntryTime(d.now)');
    const lineOf = (needle: string): number => src.slice(0, src.indexOf(needle)).split('\n').length;
    const from = lineOf("claimGrowthPort(d.growth, 'candidate_create'");
    const to = lineOf('region?.close();');
    expect(to).toBeGreaterThan(from);
    const inside = clockCalls('candidate-step.ts', src).filter((c) => {
      const ln = Number(c.split(':')[0]);
      return ln >= from && ln <= to;
    });
    expect(inside).toEqual([]);
  });
});
