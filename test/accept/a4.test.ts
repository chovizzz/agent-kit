import { describe, expect, it } from 'vitest';
import { guardRealHome, makeFx, putFakeVitest, runScript, vitestJson } from './helpers.js';
import type { Fx } from './helpers.js';

guardRealHome();

/** 与 ops/accept/lib/a4.mjs 的 SPEC 对应的一份"齐全"结果。 */
const FULL: Record<string, string[]> = {
  'test/merge/merge.test.ts': [
    ...Array.from({ length: 12 }, (_, i) => `规则 ${i}`),
    '正向控制:a',
    '正向控制:b',
  ],
  'test/guards/g1.test.ts': ['a', 'b', '正向控制:c'],
  'test/guards/g2.test.ts': ['a', 'b', '正向控制:c'],
  'test/guards/g3.test.ts': ['合法对照:晋升', 'x'],
  'test/guards/g4.test.ts': ['a'],
  'test/guards/evasion.test.ts': ['a', 'b', '正向控制:BOM'],
  'test/guards/path-guard.test.ts': ['a'],
};

async function setup(files: Record<string, string[]>, extra: Record<string, unknown> = {}) {
  const fx = await makeFx('a4-');
  // 磁盘上也要有这些测试文件(A4 会枚举 test/merge、test/guards 下的 *.test.ts)
  for (const f of Object.keys(FULL)) await fx.put(f, '// placeholder\n');
  const bin = await putFakeVitest(fx, vitestJson(fx.root, files, extra));
  return { fx, bin };
}
const a4 = (fx: Fx, bin: string) =>
  runScript('a4-merge-guards.sh', ['--root', fx.root, '--vitest-bin', bin], fx.env());

describe('A4 冲突/守卫 fixture', () => {
  it('关键文件与正向控制齐全 => 0(正向控制)', async () => {
    const { fx, bin } = await setup(FULL);
    const r = a4(fx, bin);
    expect(r.status, r.stdout).toBe(0);
  });
  it('整份 g2 测试没跑(被删/被排除)=> 1', async () => {
    const files = { ...FULL };
    delete files['test/guards/g2.test.ts'];
    const { fx, bin } = await setup(files);
    const r = a4(fx, bin);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('test/guards/g2.test.ts');
  });
  it('正向控制标题被删光 => 1(负向断言可能静默变空)', async () => {
    const files = { ...FULL, 'test/guards/g1.test.ts': ['a', 'b', 'c'] };
    const { fx, bin } = await setup(files);
    const r = a4(fx, bin);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('正向控制');
  });
  it('磁盘上多出的新测试文件没出现在结果里 => 1', async () => {
    const { fx, bin } = await setup(FULL);
    await fx.put('test/guards/new-guard.test.ts', '// placeholder\n');
    const r = a4(fx, bin);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('new-guard.test.ts');
  });
  it('结果 JSON 全绿但 vitest 进程退出 1(崩溃/被杀)=> 1', async () => {
    const fx = await makeFx('a4-');
    for (const f of Object.keys(FULL)) await fx.put(f, '// placeholder\n');
    const bin = await putFakeVitest(fx, vitestJson(fx.root, FULL), 1);
    const r = a4(fx, bin);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('进程退出 1');
  });
  it('有失败用例 / skipped => 1;vitest 没产出结果 => 4', async () => {
    const failing = await setup(FULL, { numFailedTests: 1, numPassedTests: 0, success: false });
    expect(a4(failing.fx, failing.bin).status).toBe(1);
    const skip = await setup(FULL, { numPendingTests: 2 });
    expect(a4(skip.fx, skip.bin).status).toBe(1);
    const none = await makeFx('a4-');
    const bin = await putFakeVitest(none, null);
    expect(a4(none, bin).status).toBe(4);
  });
});
