import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { readText } from '../../src/io/read-fs.js';
import {
  guardRealHome,
  makeFx,
  putFakeVitest,
  putOutside,
  REPO_ROOT,
  runScript,
  vitestJson,
} from './helpers.js';
import type { Fx } from './helpers.js';

guardRealHome();

const CHECK_OK = `
const lines = ['claude','codex','pi','kimi','opencode'].map((a) => 'budget ' + a + ': 0 字节 / 0 行 [ok] max_lines=200');
process.stdout.write('lint: 0 个原子\\n' + lines.join('\\n') + '\\n');
`;

async function setup(
  opts: {
    matrix?: (m: { cells: Record<string, unknown>[] }) => unknown;
    kit?: string;
    checkBody?: string;
  } = {},
) {
  const fx = await makeFx('a2-');
  const real = JSON.parse(
    await readText(path.join(REPO_ROOT, 'test/fixtures/budget/matrix.json')),
  ) as { cells: Record<string, unknown>[] };
  const matrix = opts.matrix ? opts.matrix(structuredClone(real)) : real;
  await fx.put('test/fixtures/budget/matrix.json', JSON.stringify(matrix));
  await fx.put('kit.toml', opts.kit ?? '[budget]\nenforce = "warn"\n');
  const cli = await putOutside(fx, 'stub-cli.mjs', opts.checkBody ?? CHECK_OK);
  return { fx, cli };
}

const run = (fx: Fx, cli: string, extra: string[] = ['--no-vitest']) =>
  runScript('a2-budget.sh', ['--root', fx.root, '--cli', cli, ...extra], fx.env());

describe('A2 预算', () => {
  it('真实 matrix.json + warn + 5 个目标行 => 退出 0(正向控制)', async () => {
    const { fx, cli } = await setup();
    const r = run(fx, cli);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain('12 格');
  });

  it('矩阵里有一格的 exit 被改错 => 1', async () => {
    const { fx, cli } = await setup({
      matrix: (m) => {
        const c = m.cells.find(
          (x) => x.limit_source === 'assumed' && x.enforce === 'block' && x.over === true,
        );
        expect(c).toBeDefined();
        (c as { exit: number }).exit = 1; // assumed 不论 enforce 都只告警,退出必须是 0
        return m;
      },
    });
    const r = run(fx, cli);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('assumed/block/true');
  });
  it('删掉一格 / 重复一格 => 1', async () => {
    const dropped = await setup({ matrix: (m) => ({ cells: m.cells.slice(1) }) });
    const r1 = run(dropped.fx, dropped.cli);
    expect(r1.status).toBe(1);
    expect(r1.stdout).toMatch(/格数应为 12|缺格/);
    const dup = await setup({ matrix: (m) => ({ cells: [...m.cells.slice(1), m.cells[1]] }) });
    const r2 = run(dup.fx, dup.cli);
    expect(r2.status).toBe(1);
    expect(r2.stdout).toContain('重复格');
  });
  it('超限格没有告警诊断 / 严重度不对 => 1', async () => {
    const noDiag = await setup({
      matrix: (m) => {
        const c = m.cells.find(
          (x) => x.limit_source === 'documented' && x.enforce === 'block' && x.over === true,
        ) as Record<string, unknown>;
        c.diagnostic = null;
        return m;
      },
    });
    expect(run(noDiag.fx, noDiag.cli).status).toBe(1);
    const sev = await setup({
      matrix: (m) => {
        const c = m.cells.find(
          (x) => x.limit_source === 'documented' && x.enforce === 'block' && x.over === true,
        ) as { diagnostic: { severity: string } };
        c.diagnostic.severity = 'warn';
        return m;
      },
    });
    const r = run(sev.fx, sev.cli);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('严重度');
  });
  it('matrix.json 缺失 / 不是 JSON => 1', async () => {
    const { fx, cli } = await setup();
    await fx.put('test/fixtures/budget/matrix.json', '{ not json');
    expect(run(fx, cli).status).toBe(1);
  });

  it('kit.toml 默认 enforce 不是 warn(决策 ②:P0 只告警)=> 1', async () => {
    const { fx, cli } = await setup({ kit: '[budget]\nenforce = "block"\n' });
    const r = run(fx, cli);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('必须是 "warn"');
  });

  it('check 没打印 5 个目标 / 退出非 0 => 1;命令桩 64 => 4', async () => {
    const few = await setup({
      checkBody: "process.stdout.write('budget claude: 0 字节 / 0 行\\n');",
    });
    const r1 = run(few.fx, few.cli);
    expect(r1.status).toBe(1);
    expect(r1.stdout).toContain('5 个目标');
    const bad = await setup({ checkBody: 'process.exit(1);' });
    expect(run(bad.fx, bad.cli).status).toBe(1);
    const stub = await setup({ checkBody: 'process.exit(64);' });
    const r3 = run(stub.fx, stub.cli);
    expect(r3.status).toBe(4);
    expect(r3.stdout).toContain('命令桩');
  });

  describe('vitest 步骤(假 vitest 提供结果)', () => {
    it('全绿 => 0;skipped=1 => 1;没有产出 => 4', async () => {
      const { fx, cli } = await setup();
      const good = await putFakeVitest(
        fx,
        vitestJson(fx.root, {
          'test/budget/matrix.test.ts': Array.from({ length: 12 }, (_, i) => `c${i}`),
        }),
      );
      const r1 = runScript(
        'a2-budget.sh',
        ['--root', fx.root, '--cli', cli, '--vitest-bin', good],
        fx.env(),
      );
      expect(r1.status, r1.stdout).toBe(0);

      const skipped = await putFakeVitest(
        fx,
        vitestJson(
          fx.root,
          { 'test/budget/a.test.ts': ['x', 'y'] },
          { numPassedTests: 1, numPendingTests: 1 },
        ),
      );
      const r2 = runScript(
        'a2-budget.sh',
        ['--root', fx.root, '--cli', cli, '--vitest-bin', skipped],
        fx.env(),
      );
      expect(r2.status, r2.stdout).toBe(1);
      expect(r2.stdout).toContain('skipped');

      const noMatrix = await putFakeVitest(
        fx,
        vitestJson(fx.root, { 'test/budget/other.test.ts': ['a', 'b'] }),
      );
      const r4 = runScript(
        'a2-budget.sh',
        ['--root', fx.root, '--cli', cli, '--vitest-bin', noMatrix],
        fx.env(),
      );
      expect(r4.status, r4.stdout).toBe(1);
      expect(r4.stdout).toContain('matrix.test.ts');

      const redExit = await putFakeVitest(
        fx,
        vitestJson(fx.root, {
          'test/budget/matrix.test.ts': Array.from({ length: 12 }, (_, i) => `c${i}`),
        }),
        1,
      );
      const r5 = runScript(
        'a2-budget.sh',
        ['--root', fx.root, '--cli', cli, '--vitest-bin', redExit],
        fx.env(),
      );
      expect(r5.status, r5.stdout).toBe(1);
      expect(r5.stdout).toContain('进程退出 1');

      const none = await putFakeVitest(fx, null);
      const r3 = runScript(
        'a2-budget.sh',
        ['--root', fx.root, '--cli', cli, '--vitest-bin', none],
        fx.env(),
      );
      expect(r3.status, r3.stdout).toBe(4);
    });
  });
});
