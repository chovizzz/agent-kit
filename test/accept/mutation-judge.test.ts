import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readTextSync } from '../../src/io/read-fs.js';
import { evalLib, guardRealHome, LIB } from './helpers.js';

guardRealHome();

interface AR {
  fullName: string;
  status: 'passed' | 'failed' | 'pending' | 'todo';
}
interface Verdict {
  red: boolean;
  note: string;
  credited: string[];
}

/** 用真实的 evaluateVitest 把「用例清单」折成 vitest json,再交给共享判据(和 runVitest 的返回同形)。 */
function judge(cases: AR[], redTitles: string[], extra: Record<string, unknown> = {}): Verdict {
  const count = (s: string) => cases.filter((c) => c.status === s).length;
  const json = {
    numTotalTests: cases.length,
    numPassedTests: count('passed'),
    numFailedTests: count('failed'),
    numPendingTests: count('pending'),
    numTodoTests: count('todo'),
    numFailedTestSuites: 0,
    success: count('failed') === 0,
    testResults: [{ name: '/x/a.test.ts', status: 'x', assertionResults: cases }],
    ...extra,
  };
  return evalLib(
    'common.mjs',
    `(m) => {
      const evaluation = m.evaluateVitest(${JSON.stringify(json)});
      const v = { code: evaluation.ok ? 0 : 1, evaluation, why: evaluation.problems.join('; ') };
      return m.judgeMutationRed(v, ${JSON.stringify(redTitles)});
    }`,
  ) as Verdict;
}

/** 旧判据(收紧前 a20/a24/a28 里各抄了一份):有失败 + 失败标题含任一子串 => 红。仅作对照,证明旧判据会假通过。 */
function oldJudge(cases: AR[], substrings: string[]): boolean {
  const failed = cases.filter((c) => c.status === 'failed').map((c) => c.fullName);
  return failed.length > 0 && failed.some((t) => substrings.some((r) => t.includes(r)));
}

const WANT = 'A21 生命周期 > 端到端:retire 写墓碑';
const pass = (fullName: string): AR => ({ fullName, status: 'passed' });
const fail = (fullName: string): AR => ({ fullName, status: 'failed' });

describe('judgeMutationRed:预期红灯精确命中,无关红灯不算数', () => {
  it('正向控制:预期的那条变红 => 红', () => {
    const v = judge([fail(WANT), pass('别的用例')], [WANT]);
    expect(v.red).toBe(true);
    expect(v.credited).toEqual([WANT]);
  });

  it('旧判据假通过的最小例子:预期用例仍绿,只有一条标题碰巧含子串的无关用例变红 => 新判据拒绝', () => {
    const cases = [pass(WANT), fail('A21 无关的格式用例(被别的原因打红)')];
    expect(oldJudge(cases, ['A21'])).toBe(true); // 旧:假通过
    const v = judge(cases, [WANT]);
    expect(v.red).toBe(false);
    expect(v.note).toContain('无关红灯不算数');
  });

  it('只有无关红灯 => 拒绝(旧判据里更宽的子串同样会被它骗过)', () => {
    const cases = [pass(WANT), fail('某个完全无关的用例')];
    expect(judge(cases, [WANT]).red).toBe(false);
  });

  it('预期标题只是失败标题的子串/前缀 => 不算命中', () => {
    const cases = [pass('X'), fail(`${WANT}(带后缀的另一条)`)];
    expect(oldJudge(cases, [WANT])).toBe(true);
    expect(() => judge(cases, [WANT])).not.toThrow();
    expect(judge(cases, [WANT]).red).toBe(false);
  });

  it('预期红灯 + 无关红灯同时出现 => 红,但只记预期的那条', () => {
    const v = judge([fail(WANT), fail('连带变红的无关用例')], [WANT]);
    expect(v.red).toBe(true);
    expect(v.credited).toEqual([WANT]);
  });

  it('变异运行里有 skipped => 拒绝(即使预期那条也红了)', () => {
    const v = judge(
      [fail(WANT), { fullName: 'beforeAll 挂掉后被跳过', status: 'pending' }],
      [WANT],
    );
    expect(v.red).toBe(false);
    expect(v.note).toContain('skipped');
  });

  it('变异运行里有 todo => 拒绝', () => {
    const v = judge([fail(WANT), { fullName: 't', status: 'todo' }], [WANT]);
    expect(v.red).toBe(false);
  });

  it('有测试文件加载失败(变异打出语法错误)=> 拒绝', () => {
    const v = judge([fail(WANT)], [WANT], {
      testResults: [
        { name: '/x/a.test.ts', status: 'x', assertionResults: [fail(WANT)] },
        { name: '/x/b.test.ts', status: 'failed', assertionResults: [] },
      ],
    });
    expect(v.red).toBe(false);
    expect(v.note).toContain('加载失败');
  });

  it('预期标题根本不在本次运行里(改名 / 文件没选上)=> 拒绝,不静默当作没命中', () => {
    const v = judge([fail('别的用例'), pass('又一条')], [WANT]);
    expect(v.red).toBe(false);
    expect(v.note).toContain('没有出现');
  });

  it('多条预期:有一条改名失效就拒绝(防止预期悄悄变少)', () => {
    const v = judge([fail(WANT)], [WANT, '已经改名的旧标题']);
    expect(v.red).toBe(false);
  });

  it('多条预期:任一条精确变红即可', () => {
    const v = judge([pass(WANT), fail('B'), pass('C')], [WANT, 'B']);
    expect(v.red).toBe(true);
    expect(v.credited).toEqual(['B']);
  });

  it('预期标题在运行里出现两次(同名用例,一过一红)=> 拒绝', () => {
    const v = judge([pass(WANT), fail(WANT)], [WANT]);
    expect(v.red).toBe(false);
    expect(v.note).toContain('出现多次');
  });

  it('vitest 进程以 0 退出(code=0)但报告里有失败 => 拒绝', () => {
    const json = {
      numTotalTests: 1,
      numPassedTests: 0,
      numFailedTests: 1,
      numPendingTests: 0,
      numTodoTests: 0,
      numFailedTestSuites: 0,
      success: false,
      testResults: [{ name: '/x/a.test.ts', status: 'failed', assertionResults: [fail(WANT)] }],
    };
    const r = evalLib(
      'common.mjs',
      `(m) => {
        const evaluation = m.evaluateVitest(${JSON.stringify(json)});
        return m.judgeMutationRed({ code: 0, evaluation, why: '' }, [${JSON.stringify(WANT)}]);
      }`,
    ) as Verdict;
    expect(r.red).toBe(false);
    expect(r.note).toContain('0 退出');
  });

  it('变异存活(全绿)=> 拒绝', () => {
    expect(judge([pass(WANT)], [WANT]).red).toBe(false);
  });

  it('redTitles 为空 / 含空串 => 拒绝', () => {
    expect(judge([fail(WANT)], []).red).toBe(false);
    expect(judge([fail(WANT)], ['']).red).toBe(false);
  });

  it('vitest 没跑起来 => 拒绝', () => {
    const r = evalLib(
      'common.mjs',
      `(m) => m.judgeMutationRed({ code: 4, why: 'boom', evaluation: null }, ['x'])`,
    ) as Verdict;
    expect(r.red).toBe(false);
    expect(r.note).toContain('没跑起来');
  });
});

describe('A20 / A24 / A28 共用同一份判据(不在三处各写一份)', () => {
  const src = (f: string) => readTextSync(path.join(LIB, f));
  it.each(['a20.mjs', 'a24.mjs', 'a28.mjs'])(
    '%s 调共享 judgeMutationRed,没有自己的子串比对',
    (f) => {
      const s = src(f);
      expect(s).toContain('judgeMutationRed(v, m.redTitles)');
      expect(s).not.toMatch(/failedTitles/);
      expect(s).not.toMatch(/redTitles\.some/);
    },
  );

  it('每处变异的 redTitles 都是非空的完整标题字符串数组', () => {
    for (const f of ['a20.mjs', 'a24.mjs', 'a28.mjs']) {
      const muts = evalLib(f, '(m) => m.MUTATIONS.map((x) => ({ id: x.id, r: x.redTitles }))') as {
        id: string;
        r: unknown;
      }[];
      expect(muts.length, f).toBeGreaterThan(0);
      for (const x of muts) {
        expect(Array.isArray(x.r) && x.r.length > 0, `${f} ${x.id}`).toBe(true);
        for (const t of x.r as unknown[]) expect(typeof t === 'string' && t !== '').toBe(true);
      }
    }
  });
});
