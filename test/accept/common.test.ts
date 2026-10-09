import { describe, expect, it } from 'vitest';
import { callLib, evalLib, guardRealHome } from './helpers.js';

guardRealHome();

const ev = (j: unknown) =>
  callLib('common.mjs', 'evaluateVitest', [[j]])[0] as {
    ok: boolean;
    problems: string[];
  };

const green = {
  numTotalTests: 3,
  numPassedTests: 3,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  numFailedTestSuites: 0,
  success: true,
  testResults: [],
};

describe('evaluateVitest:skipped / todo / 空跑都不是通过', () => {
  it('全绿 => ok(正向控制)', () => {
    expect(ev(green).ok).toBe(true);
  });
  it.each([
    ['有失败用例', { ...green, numPassedTests: 2, numFailedTests: 1, success: false }],
    ['有 skipped', { ...green, numPassedTests: 2, numPendingTests: 1 }],
    ['有 todo', { ...green, numPassedTests: 2, numTodoTests: 1 }],
    ['total=0', { ...green, numTotalTests: 0, numPassedTests: 0 }],
    ['缺字段', { success: true }],
    ['用例数对不上', { ...green, numPassedTests: 1 }],
    ['有失败的测试文件', { ...green, numFailedTestSuites: 1 }],
  ])('%s => 不 ok', (_name, json) => {
    const r = ev(json);
    expect(r.ok).toBe(false);
    expect(r.problems.length).toBeGreaterThan(0);
  });
  it('文件加载失败(没有任何断言结果)也算问题', () => {
    const r = ev({
      ...green,
      testResults: [{ name: '/x/a.test.ts', status: 'failed', assertionResults: [] }],
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toContain('a.test.ts');
  });
});

describe('mergeExit 优先级 3 > 2 > 1 > 4 > 5 > 0', () => {
  const merge = (c: number[]) => callLib('common.mjs', 'mergeExit', [[c]])[0];
  it('逐项', () => {
    expect(merge([0, 0])).toBe(0);
    expect(merge([0, 5])).toBe(5);
    expect(merge([5, 4])).toBe(4);
    expect(merge([4, 1])).toBe(1);
    expect(merge([1, 2])).toBe(2);
    expect(merge([2, 3, 0])).toBe(3);
  });
});

describe('checkRequiredTests:证明关键文件与正向控制真的跑过', () => {
  const root = '/r';
  const t = (file: string, fullName: string, status = 'passed') => ({
    file: `${root}/${file}`,
    fullName,
    status,
  });
  const check = (titles: unknown[], spec: unknown) =>
    callLib('common.mjs', 'checkRequiredTests', [[{ titles }, root, spec]])[0] as string[];
  const spec = { files: { 'test/a.test.ts': { min: 2, controls: 1 } } };

  it('齐全 => 无问题(正向控制)', () => {
    expect(check([t('test/a.test.ts', 'x 正向控制:y'), t('test/a.test.ts', 'z')], spec)).toEqual(
      [],
    );
  });
  it('整份文件没跑(被删/被排除)=> 报问题', () => {
    expect(check([t('test/b.test.ts', 'q')], spec).join()).toContain('test/a.test.ts');
  });
  it('正向控制被删 => 报问题', () => {
    expect(check([t('test/a.test.ts', 'x'), t('test/a.test.ts', 'z')], spec).join()).toContain(
      '正向控制',
    );
  });
  it('正向控制存在但没通过 => 不计', () => {
    const r = check(
      [
        t('test/a.test.ts', 'x 正向控制', 'failed'),
        t('test/a.test.ts', 'z'),
        t('test/a.test.ts', 'w'),
      ],
      spec,
    );
    expect(r.join()).toContain('正向控制');
  });
  it('titles 要求:缺关键用例 => 报问题', () => {
    const r = check([t('test/a.test.ts', 'foo')], {
      titles: [{ file: 'test/a.test.ts', includes: 'bar' }],
    });
    expect(r.join()).toContain('bar');
  });
});

describe('parseFlags / Reporter', () => {
  it('未知选项与缺值 => UsageError', () => {
    expect(() => callLib('common.mjs', 'parseFlags', [[['--nope'], { bool: ['x'] }]])).toThrow(
      '未知选项',
    );
    expect(() => callLib('common.mjs', 'parseFlags', [[['--v'], { value: ['v'] }]])).toThrow(
      '需要一个值',
    );
    expect(() => callLib('common.mjs', 'parseFlags', [[['--b=1'], { bool: ['b'] }]])).toThrow(
      '不接受值',
    );
  });
  it('什么都没检查的 Reporter 退出 4(空跑不是通过)', () => {
    expect(evalLib('common.mjs', "(m) => new m.Reporter('X', () => {}).exit()")).toBe(4);
  });
  it('有 PASS 无其它 => 0;有 NOT-RUN 无 FAIL => 4;FAIL 压过 NOT-RUN => 1', () => {
    expect(
      evalLib(
        'common.mjs',
        "(m) => { const r = new m.Reporter('X', () => {}); r.pass('a'); return r.exit(); }",
      ),
    ).toBe(0);
    expect(
      evalLib(
        'common.mjs',
        "(m) => { const r = new m.Reporter('X', () => {}); r.pass('a'); r.notRun('b'); return r.exit(); }",
      ),
    ).toBe(4);
    expect(
      evalLib(
        'common.mjs',
        "(m) => { const r = new m.Reporter('X', () => {}); r.notRun('b'); r.fail('c'); return r.exit(); }",
      ),
    ).toBe(1);
  });
});
