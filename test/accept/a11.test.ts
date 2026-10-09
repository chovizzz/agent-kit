import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import * as safe from '../../src/io/safe-fs.js';
import { callLib, guardRealHome, makeFx, putOutside, runScript } from './helpers.js';
import type { Fx } from './helpers.js';

guardRealHome();

const PKG = {
  name: 'x',
  packageManager: 'pnpm@10.33.0',
  dependencies: { zod: '4.6.5' },
  devDependencies: { vitest: '5.0.3' },
};

const manifest = (pkg: unknown) =>
  callLib('a11.mjs', 'checkManifest', [[pkg]])[0] as { problems: string[]; direct: string[] };

describe('A11 版本串', () => {
  it('精确版本 + 固定 packageManager => 无问题(正向控制)', () => {
    expect(manifest(PKG).problems).toEqual([]);
  });
  it.each([
    ['^', { dependencies: { zod: '^1.0.0' } }],
    ['~', { dependencies: { zod: '~1.0.0' } }],
    ['latest', { devDependencies: { vitest: 'latest' } }],
    ['*', { dependencies: { zod: '*' } }],
    ['区间', { dependencies: { zod: '>=1.0.0' } }],
    ['预发布', { dependencies: { zod: '1.0.0-beta.1' } }],
    ['npm: 别名', { dependencies: { zod: 'npm:other@1.0.0' } }],
    ['optional ^', { optionalDependencies: { fsevents: '^2.0.0' } }],
    ['overrides', { pnpm: { overrides: { zod: '^1.0.0' } } }],
    ['peer latest', { peerDependencies: { zod: 'latest' } }],
    ['缺 packageManager', { packageManager: undefined }],
    ['packageManager 无版本', { packageManager: 'pnpm' }],
  ])('故意破坏:%s => 有问题', (_n, patch) => {
    expect(manifest({ ...PKG, ...patch }).problems.length).toBeGreaterThan(0);
  });
});

const AUDIT = (high: number, critical: number) =>
  JSON.stringify({ metadata: { vulnerabilities: { low: 0, moderate: 1, high, critical } } });

async function setup(pkg: unknown = PKG, withNm = true): Promise<Fx> {
  const fx = await makeFx('a11-');
  await fx.put('package.json', JSON.stringify(pkg));
  await fx.put('pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
  if (withNm) {
    await fx.put(
      'node_modules/.pnpm/zod@4.6.5/node_modules/zod/package.json',
      JSON.stringify({ name: 'zod', version: '4.6.5', license: 'MIT' }),
    );
  }
  return fx;
}
const pnpmStub = (fx: Fx, audit: string, code = 0) =>
  putOutside(fx, 'pnpm', `process.stdout.write(${JSON.stringify(audit)}); process.exit(${code});`);
const a11 = (fx: Fx, pnpm: string, extra: string[] = []) =>
  runScript(
    'a11-supply-chain.sh',
    ['--root', fx.root, '--pnpm', pnpm, '--skip-install', ...extra],
    fx.env(),
  );

describe('A11 脚本', () => {
  it('干净 + audit 无 high/critical + 许可证 OK => 0,且清单落盘(正向控制)', async () => {
    const fx = await setup();
    await fx.put('x', ''); // 保持目录非空
    const r = a11(fx, await pnpmStub(fx, AUDIT(0, 0)));
    // lockfile 未被 git 跟踪(临时目录不是仓库)=> 4;其余全部 PASS
    expect(r.status, r.stdout).toBe(4);
    expect(r.stdout).toContain('NOT-RUN 不是 git 仓库');
    expect(r.stdout).toContain('无 high/critical');
    expect(r.stdout).toContain('许可证清单 1 个包落盘');
  });

  it('package.json 里有 ^1.0.0 => 1(任务点名的负向用例)', async () => {
    const fx = await setup({ ...PKG, dependencies: { zod: '^1.0.0' } });
    const r = a11(fx, await pnpmStub(fx, AUDIT(0, 0)));
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('dependencies.zod');
  });

  it('audit 报 high 或 critical => 1', async () => {
    const fx = await setup();
    expect(a11(fx, await pnpmStub(fx, AUDIT(1, 0))).status).toBe(1);
    expect(a11(fx, await pnpmStub(fx, AUDIT(0, 2))).stdout).toContain('critical=2');
  });

  it('audit 拿不到可解析结果(无网络)=> 4,不静默通过;审计工具不存在 => 4', async () => {
    const fx = await setup(PKG);
    const r = a11(fx, await pnpmStub(fx, 'ERR_PNPM_AUDIT_BAD_RESPONSE', 1));
    expect(r.stdout).toContain('NOT-RUN pnpm audit 没有给出可解析结果');
    const none = a11(fx, '/nonexistent/pnpm');
    expect(none.stdout).toContain('NOT-RUN pnpm audit');
    expect(none.status).not.toBe(0);
  });

  it('copyleft 许可证 => 1;没有 node_modules => 4', async () => {
    const fx = await setup();
    await fx.put(
      'node_modules/.pnpm/gpl@1.0.0/node_modules/gpl/package.json',
      JSON.stringify({ name: 'gpl', version: '1.0.0', license: 'GPL-3.0-only' }),
    );
    const r = a11(fx, await pnpmStub(fx, AUDIT(0, 0)));
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('禁用许可证');
    const bare = await setup(PKG, false);
    expect(a11(bare, await pnpmStub(bare, AUDIT(0, 0))).stdout).toContain(
      'NOT-RUN node_modules 不存在',
    );
  });

  it('直接依赖 > 12 且 docs/deps.md 缺说明 => 1;补齐后该条通过', async () => {
    const deps = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`pkg${i}`, '1.0.0']));
    const fx = await setup({ ...PKG, dependencies: deps, devDependencies: {} });
    const pnpm = await pnpmStub(fx, AUDIT(0, 0));
    const r1 = a11(fx, pnpm);
    expect(r1.status).toBe(1);
    expect(r1.stdout).toContain('docs/deps.md 缺');
    await fx.put(
      'docs/deps.md',
      Object.keys(deps)
        .map((d) => `\`${d}\``)
        .join('\n'),
    );
    expect(a11(fx, pnpm).stdout).toContain('已逐个说明');
  });

  it('缺 package.json => 3;缺 lockfile => 1', async () => {
    const fx = await makeFx('a11-');
    expect(
      runScript(
        'a11-supply-chain.sh',
        ['--root', fx.root, '--skip-install', '--skip-audit'],
        fx.env(),
      ).status,
    ).toBe(3);
    const nolock = await setup();
    await safe.remove(nolock.ctx, path.join(nolock.root, 'pnpm-lock.yaml'));
    const r = runScript(
      'a11-supply-chain.sh',
      ['--root', nolock.root, '--skip-install', '--skip-audit'],
      nolock.env(),
    );
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('缺 pnpm-lock.yaml');
  });

  it('许可证扫描看的是刚装出来的依赖树:源 node_modules 干净、安装结果含 GPL => 1', async () => {
    const fx = await setup();
    const pnpm = await putOutside(
      fx,
      'pnpm',
      `import * as fs from 'node:fs';
if (process.argv[2] === 'install') {
  fs.mkdirSync('node_modules/.pnpm/gpl@1.0.0/node_modules/gpl', { recursive: true });
  fs.writeFileSync('node_modules/.pnpm/gpl@1.0.0/node_modules/gpl/package.json', JSON.stringify({ name: 'gpl', version: '1.0.0', license: 'GPL-3.0-only' }));
  process.exit(0);
}
process.stdout.write(${JSON.stringify(AUDIT(0, 0))});`,
    );
    const r = runScript('a11-supply-chain.sh', ['--root', fx.root, '--pnpm', pnpm], fx.env());
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('禁用许可证');
    expect(r.stdout).toContain('gpl@1.0.0');
  });
});
