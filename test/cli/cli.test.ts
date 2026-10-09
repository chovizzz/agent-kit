import { describe, expect, it } from 'vitest';
import { COMMANDS, helpText, main } from '../../src/cli.js';
import { combineExitCodes } from '../../src/commands/types.js';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { KIT_VERSION } from '../../src/contracts/meta.js';
import { readText } from '../../src/io/read-fs.js';
import { REPO_ROOT } from '../helpers/tmp.js';

async function run(args: string[]) {
  let out = '';
  let err = '';
  const code = await main(args, {
    env: { PATH: '/usr/bin:/bin' },
    cwd: REPO_ROOT,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  });
  return { code, out, err };
}

describe('命令表', () => {
  it('命令名唯一,且全部出现在 --help 和 docs/contracts.md 里', async () => {
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(12);
    const help = (await run(['--help'])).out;
    const doc = await readText(new URL('../../docs/contracts.md', import.meta.url).pathname);
    for (const n of names) {
      expect(help, `--help 缺 ${n}`).toContain(n);
      expect(doc, `docs/contracts.md 缺 ${n}`).toContain(`\`${n}\``);
    }
    expect(help).toBe(helpText());
  });

  it('设计 §10 P0 交付物 build/check/redact/signals collect 与全部 P1+ 命令都已注册', () => {
    const names = COMMANDS.map((c) => c.name);
    for (const n of [
      'build',
      'check',
      'redact',
      'signals collect',
      'inventory',
      'probe',
      'reflect',
      'attest',
      'promote',
      'retire',
      'sync',
      'doctor',
    ]) {
      expect(names).toContain(n);
    }
  });
});

// 已实装的命令不再是桩。新增块合入时在这里登记(避免『桩断言』误伤已实装命令,也避免漏掉仍是桩的命令)。
const IMPLEMENTED_COMMANDS = new Set(['redact', 'signals collect', 'check']);

describe('命令桩:每个命令退出 64 并说明原因(绝不静默成功)', () => {
  for (const def of COMMANDS.filter((d) => !IMPLEMENTED_COMMANDS.has(d.name))) {
    it(`agent-kit ${def.name} → 64`, async () => {
      const r = await run(def.name.split(' '));
      expect(r.code).toBe(ExitCode.NOT_IMPLEMENTED);
      expect(r.err).toContain('未实现');
      // 桩不得有任何 stdout。
      expect(r.out).toBe('');
    });
  }

  it('inventory 的提示说明「P1 才进 CLI」', async () => {
    expect((await run(['inventory'])).err).toContain('P1 才进 CLI');
  });

  it('check:lint 与 budget 已实装(退出 0),只有 --guards 仍是桩', async () => {
    const r = await run(['check']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('lint:');
    expect(r.out).toContain('budget claude:');
    expect(r.err).not.toContain('(lint)');
    expect(r.err).not.toContain('(budget)');
    expect(r.err).not.toContain('(guards)');
    const g = await run(['check', '--guards', '--base', 'a', '--head', 'b']);
    expect(g.err).toContain('(guards)');
  });
});

describe('用法错误退出 2', () => {
  it('未知命令、无命令、子命令不全、缺值', async () => {
    expect((await run(['nope'])).code).toBe(2);
    expect((await run([])).code).toBe(2);
    expect((await run(['signals'])).code).toBe(2);
    expect((await run(['--root'])).code).toBe(2);
  });

  it('check:--guards 缺 base/head、未知 flag', async () => {
    expect((await run(['check', '--guards'])).code).toBe(2);
    expect((await run(['check', '--guards', '--base', 'a'])).code).toBe(2);
    expect((await run(['check', '--bogus'])).code).toBe(2);
  });

  it('未知命令的退出码不是 64(桩与用法错误可区分)', async () => {
    expect((await run(['nope'])).code).not.toBe(ExitCode.NOT_IMPLEMENTED);
  });
});

describe('help / version', () => {
  it('--help 退出 0,列出退出码约定与全局选项', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('--root');
    expect(r.out).toContain('64 未实现');
  });

  it('<命令> --help 退出 0 并列出 flag(不执行命令)', async () => {
    const r = await run(['check', '--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('--guards');
    expect(r.err).toBe('');
  });

  it('--version 与 package.json 一致', async () => {
    const pkg = JSON.parse(await readText(`${REPO_ROOT}/package.json`)) as { version: string };
    const r = await run(['--version']);
    expect(r.out.trim()).toBe(pkg.version);
    expect(KIT_VERSION).toBe(pkg.version);
  });
});

describe('全局选项位置', () => {
  it('--root / --overlay 可放在命令前后,不影响桩的退出码', async () => {
    expect((await run(['--root', REPO_ROOT, 'build'])).code).toBe(64);
    expect((await run(['build', '--root', REPO_ROOT, '--overlay', 'x.toml'])).code).toBe(64);
  });

  it('KIT_WRITE_ROOTS 配置非法 → fail-closed 退出 3', async () => {
    let err = '';
    const code = await main(['build'], {
      env: { PATH: '/usr/bin:/bin', KIT_WRITE_ROOTS: '/' },
      cwd: REPO_ROOT,
      stdout: () => undefined,
      stderr: (t) => (err += t),
    });
    expect(code).toBe(3);
    expect(err).toContain('KIT_WRITE_ROOTS');
  });
});

describe('combineExitCodes 优先级 3 > 2 > 1 > 4 > 64 > 0', () => {
  it('逐档', () => {
    expect(combineExitCodes([0, 0])).toBe(0);
    expect(combineExitCodes([0, 64])).toBe(64);
    expect(combineExitCodes([64, 4])).toBe(4);
    expect(combineExitCodes([4, 1, 64])).toBe(1);
    expect(combineExitCodes([1, 2, 64])).toBe(2);
    expect(combineExitCodes([1, 2, 3, 64])).toBe(3);
    expect(combineExitCodes([])).toBe(0);
  });
});
