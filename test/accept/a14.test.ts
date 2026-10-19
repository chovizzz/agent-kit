import { describe, expect, it } from 'vitest';
import { guardRealHome, makeFx, putOutside, runScript } from './helpers.js';
import type { Fx } from './helpers.js';

guardRealHome();

const PHASES: [string, string][] = [
  ['build', 'P0'],
  ['check', 'P0'],
  ['redact', 'P0'],
  ['signals collect', 'P0'],
  ['inventory', 'P1'],
  ['probe', 'P1'],
  ['reflect', 'P1'],
  ['judge', 'P1'],
  ['attest', 'P1'],
  ['promote', 'P1'],
  ['retire', 'P1'],
  ['sync', 'P2'],
  ['doctor', 'P2'],
  ['update', 'P2'],
];

/** 假 CLI:行为由 <cwd>/../mode 无法传递,故用 argv 里的 --root 目录下 mode.txt(空仓库根)。 */
const stub = (mode: string) => `
const argv = process.argv.slice(2);
const mode = ${JSON.stringify(mode)};
const table = ${JSON.stringify(PHASES)};
if (argv.includes('--help') || argv.includes('-h')) {
  if (argv.length === 1) {
    const rows = table.map(([n, p]) => '  ' + n.padEnd(16) + ' [' + (mode === 'wrong-phase' && n === 'probe' ? 'P0' : p) + '] x');
    process.stdout.write(['命令:', ...rows, ''].join('\\n'));
  } else process.stdout.write('agent-kit help\\n');
  process.exit(0);
}
const rest = argv.filter((a, i) => a !== '--root' && argv[i - 1] !== '--root');
const name = rest.join(' ');
const ent = table.find(([n]) => n === name);
if (!ent) process.exit(2);
if (ent[1] === 'P0') process.exit(mode === 'p0-stub' && name === 'build' ? 64 : mode === 'p0-notrun' && name === 'check' ? 4 : 2);
// probe / reflect / judge / attest / promote / retire 已实装(a14 的 IMPLEMENTED_LATER_PHASE):正常模式下必须非桩、非 4。
if (mode === 'silent-stub' && name === 'inventory') process.exit(64);
if (['probe', 'reflect', 'judge', 'attest', 'promote', 'retire', 'sync', 'doctor'].includes(name)) process.exit(mode === 'p1-stub-regression' ? 64 : 0);
if (name === 'update') {
  if (mode === 'update-usage') process.exit(2);
  if (mode !== 'update-no-code') process.stderr.write('UPDATE_CHECK_FAILED reason=http_404\\n');
  process.exit(mode === 'p1-stub-regression' ? 64 : 4);
}
process.stderr.write('未实现 — ' + ent[1] + ' 才实现\\n');
process.exit(64);
`;

const DELIVERABLES = [
  'kit.toml',
  'ops/zero-write-check.sh',
  'ops/managed-paths.txt',
  'ops/volatile-paths.txt',
  'ops/guards/no-net.cjs',
  'ops/accept-p0.sh',
  'ops/accept/a13-mutation.md',
  'ops/reader-oracle/run.sh',
  'inventory/claude-md-sections.md',
  'inventory/skills-dirs.md',
  'inventory/memory-counts.md',
  'inventory/hooks-and-agents-md.md',
  'inventory/commands.sh',
  'inventory/reader-samples.txt',
  'docs/contracts.md',
  'docs/architecture-p0.md',
  'docs/block-boundaries.md',
  'docs/reader-counting-spec.md',
  'docs/redaction.md',
  'docs/deps.md',
  'docs/release-checklist.md',
];
const NAMES = [
  'a1-x.sh',
  'a2-x.sh',
  'a3-x.sh',
  'a4-x.sh',
  'a5-x.sh',
  'a6-x.sh',
  'a7-x.sh',
  'a8-x.sh',
  'a9-x.sh',
  'a10-x.sh',
  'a11-x.sh',
  'a12-x.sh',
  'a13-x.md',
  'a14-x.sh',
  'a15-x.sh',
];

async function setup(
  mode: string,
  skip: string[] = [],
  skipAccept: string[] = [],
): Promise<{ fx: Fx; cli: string }> {
  const fx = await makeFx('a14-');
  for (const f of DELIVERABLES.filter((d) => !skip.includes(d)))
    await fx.put(f, '#\n', f.endsWith('.sh') ? 0o755 : undefined);
  for (const n of NAMES.filter((x) => !skipAccept.includes(x)))
    await fx.put(`ops/accept/${n}`, '#\n');
  return { fx, cli: await putOutside(fx, 'stub-cli.mjs', stub(mode)) };
}
const a14 = (s: { fx: Fx; cli: string }) =>
  runScript('a14-deliverables.sh', ['--root', s.fx.root, '--cli', s.cli], s.fx.env());

describe('A14 交付物齐全', () => {
  it('文件齐全、帮助标记正确、P0 命令不是桩、P1/P2 桩退出 64 并说明阶段 => 0(正向控制)', async () => {
    const r = a14(await setup('ok'));
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain('14 个命令都在 --help 里');
  });
  it('缺一个交付物文件 / 缺一个 aN 脚本 => 1', async () => {
    const r1 = a14(await setup('ok', ['inventory/commands.sh']));
    expect(r1.status).toBe(1);
    expect(r1.stdout).toContain('inventory/commands.sh');
    const r2 = a14(await setup('ok', [], ['a7-x.sh']));
    expect(r2.status).toBe(1);
    expect(r2.stdout).toContain('缺 ops/accept/a7-');
  });
  it('帮助里阶段标记不符 => 1', async () => {
    const r = a14(await setup('wrong-phase'));
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('probe(应为 P1');
  });
  it('已实装的 P1 命令仍以桩退出 64 => 1;桩没说明阶段 => 1', async () => {
    const r = a14(await setup('p1-stub-regression'));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('已实装却仍以桩退出 64');
    const r2 = a14(await setup('silent-stub'));
    expect(r2.status).toBe(1);
    expect(r2.stdout).toContain('没有说明 P1');
  });
  it('update 在假 registry 下必须退出 4 并报 UPDATE_CHECK_FAILED:用法错误(2)/ 没有稳定码 => 1', async () => {
    const ok = a14(await setup('ok'));
    expect(ok.stdout).toContain('update: [P2] 已实装(假 registry 下退出 4 UPDATE_CHECK_FAILED)');
    for (const mode of ['update-usage', 'update-no-code']) {
      const r = a14(await setup(mode));
      expect(r.status, mode).toBe(1);
      expect(r.stdout, mode).toContain('假 registry 下应退出 4');
    }
  });
  it('P0 命令仍是桩 => 4(半成品不得判通过)', async () => {
    const r = a14(await setup('p0-stub'));
    expect(r.status, r.stdout).toBe(4);
    expect(r.stdout).toContain('[P0] 命令仍是桩');
  });
  it('P0 命令自报未执行(退出 4)=> 4,不是 PASS', async () => {
    const r = a14(await setup('p0-notrun'));
    expect(r.status, r.stdout).toBe(4);
    expect(r.stdout).toContain('自报未执行');
  });
  it('CLI 不存在 => 4', async () => {
    const s = await setup('ok');
    expect(
      runScript(
        'a14-deliverables.sh',
        ['--root', s.fx.root, '--cli', '/nonexistent/cli.js'],
        s.fx.env(),
      ).status,
    ).toBe(4);
  });
});
