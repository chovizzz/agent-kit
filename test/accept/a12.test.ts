import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { commitAll, guardRealHome, makeFx, putOutside, runScript } from './helpers.js';
import type { Fx } from './helpers.js';

guardRealHome();

/** 假 pnpm:按 <root 外>/mode.txt 决定哪一步失败;exec vitest 时写假的 JSON 结果。 */
const PNPM = (modeFile: string) => `
import * as fs from 'node:fs';
const args = process.argv.slice(2);
const mode = fs.readFileSync(${JSON.stringify(modeFile)}, 'utf8').trim();
const step = args[0] === 'run' ? args[1] : args[0];
if (mode === 'fail-' + step) process.exit(1);
if (args[0] === 'exec') {
  const out = args.find((a) => a.startsWith('--outputFile=')).slice('--outputFile='.length);
  const pend = mode === 'skipped' ? 1 : 0;
  const j = { numTotalTests: 3, numPassedTests: 3 - pend, numFailedTests: 0, numPendingTests: pend, numTodoTests: 0, numFailedTestSuites: 0, success: true, testResults: [] };
  if (mode !== 'no-json') fs.writeFileSync(out, JSON.stringify(j));
}
process.exit(0);
`;

async function setup(mode: string): Promise<{ fx: Fx; pnpm: string; modeFile: string }> {
  const fx = await makeFx('a12-');
  await fx.put('package.json', '{"name":"x"}\n');
  await commitAll(fx);
  const modeFile = path.join(fx.dir, 'mode.txt');
  await fx.put('../mode.txt', mode + '\n');
  const pnpm = await putOutside(fx, 'pnpm', PNPM(modeFile));
  return { fx, pnpm, modeFile };
}
const a12 = (s: { fx: Fx; pnpm: string }, extra: string[] = []) =>
  runScript('a12-green.sh', ['--root', s.fx.root, '--pnpm', s.pnpm, ...extra], s.fx.env());

describe('A12 干净克隆里的全量绿灯', () => {
  it('全部步骤通过 => 0,并报告被验提交(正向控制)', async () => {
    const s = await setup('ok');
    const r = a12(s);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/被验提交:[0-9a-f]{40}/);
    expect(r.stdout).toContain('skipped=0');
  }, 60_000);

  it.each(['typecheck', 'build', 'lint', 'format:check'])(
    '%s 失败 => 1',
    async (step) => {
      const s = await setup('fail-' + step);
      const r = a12(s);
      expect(r.status, r.stdout).toBe(1);
      expect(r.stdout).toContain(step);
    },
    60_000,
  );

  it('install 失败 => 1,且后续步骤不再跑', async () => {
    const s = await setup('fail-install');
    const r = a12(s);
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain('PASS typecheck');
  }, 60_000);

  it('有 skipped 用例 => 1;vitest 没产出结果 => 4', async () => {
    const sk = await setup('skipped');
    const r1 = a12(sk);
    expect(r1.status, r1.stdout).toBe(1);
    expect(r1.stdout).toContain('skipped/pending');
    const nj = await setup('no-json');
    expect(a12(nj).status).toBe(4);
  }, 60_000);

  it('不是 git 仓库 => 4;嵌套(KIT_A12_ACTIVE=1)=> 2;脏树 + --require-clean-tree => 3', async () => {
    const s = await setup('ok');
    const plain = await makeFx('a12-');
    expect(
      runScript('a12-green.sh', ['--root', plain.root, '--pnpm', s.pnpm], plain.env()).status,
    ).toBe(4);
    expect(
      runScript(
        'a12-green.sh',
        ['--root', s.fx.root, '--pnpm', s.pnpm],
        s.fx.env({ KIT_A12_ACTIVE: '1' }),
      ).status,
    ).toBe(2);
    await s.fx.put('dirty.txt', 'x\n');
    const r = a12(s, ['--require-clean-tree']);
    expect(r.status, r.stdout).toBe(3);
    // 默认只提示,仍只验提交
    const soft = a12(s);
    expect(soft.stdout).toContain('未提交改动');
  }, 120_000);
});
