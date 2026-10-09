import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { guardRealHome, makeFx, putOutside, runScript } from './helpers.js';
import type { Fx } from './helpers.js';

guardRealHome();

/** 受控的假 CLI:行为由 <root>/stub-mode.txt 决定,便于在副本里制造各种不确定性。 */
const STUB = `
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const argv = process.argv.slice(2);
const root = argv[argv.indexOf('--root') + 1];
const mode = fs.readFileSync(path.join(root, 'stub-mode.txt'), 'utf8').trim();
if (mode === 'stub') { process.stderr.write('agent-kit build: 未实现\\n'); process.exit(64); }
if (mode === 'fail') process.exit(1);
const out = path.join(root, 'out');
fs.mkdirSync(path.join(out, 'claude'), { recursive: true });
if (mode === 'empty') process.exit(0);
let body = 'rule one\\n';
if (mode === 'tz') body += 'tz=' + process.env.TZ + '\\n';
if (mode === 'lang') body += 'lang=' + process.env.LANG + '\\n';
if (mode === 'cwd') body += 'cwd=' + path.basename(process.cwd()) + '\\n';
if (mode === 'abs') body += 'root=' + root + '\\n';
if (mode === 'ts') body += 'built=' + new Date().toISOString() + '\\n';
if (mode === 'user') body += 'by=' + os.userInfo().username + '\\n';
if (mode === 'home') body += 'p=/Users/x/y\\n';
fs.writeFileSync(path.join(out, 'claude', 'CLAUDE.md'), body);
`;

async function setup(mode: string): Promise<{ fx: Fx; cli: string }> {
  const fx = await makeFx('a1-');
  await fx.put('kit.toml', '[kit]\nname = "x"\n');
  await fx.put('src/rule.md', 'hello\n');
  await fx.put('stub-mode.txt', mode + '\n');
  const cli = await putOutside(fx, 'stub-cli.mjs', STUB);
  return { fx, cli };
}

const a1 = (fx: Fx, cli: string) =>
  runScript('a1-determinism.sh', ['--root', fx.root, '--cli', cli], fx.env());

describe('A1 确定性', () => {
  it('确定性的构建 => 退出 0(正向控制),且做了 5 次构建', async () => {
    const { fx, cli } = await setup('ok');
    const r = a1(fx, cli);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain('树哈希全等');
    expect(r.stdout).toMatch(/default.*\n.*tz-shanghai/s);
  });
  it.each([
    ['tz', '树哈希不一致'],
    ['lang', '树哈希不一致'],
    ['cwd', '树哈希不一致'],
    ['ts', '时间戳'],
    ['abs', '禁用串'],
    ['user', '禁用串'],
    ['home', '禁用串'],
  ])('故意制造不确定性:%s => 退出 1', async (mode, msg) => {
    const { fx, cli } = await setup(mode);
    const r = a1(fx, cli);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain(msg);
  });
  it('空 out/ 不能证明确定性 => 退出 1', async () => {
    const { fx, cli } = await setup('empty');
    const r = a1(fx, cli);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('空的');
  });
  it('build 是命令桩(64)=> 退出 4(未执行,不是通过)', async () => {
    const { fx, cli } = await setup('stub');
    const r = a1(fx, cli);
    expect(r.status, r.stdout).toBe(4);
    expect(r.stdout).toContain('命令桩');
  });
  it('build 失败 => 退出 1', async () => {
    const { fx, cli } = await setup('fail');
    expect(a1(fx, cli).status).toBe(1);
  });
  it('CLI 不存在 => 退出 4', async () => {
    const { fx } = await setup('ok');
    const r = a1(fx, path.join(fx.dir, 'nope.js'));
    expect(r.status).toBe(4);
  });
  it('未知选项 => 退出 2', async () => {
    const { fx, cli } = await setup('ok');
    const r = runScript(
      'a1-determinism.sh',
      ['--root', fx.root, '--cli', cli, '--bogus'],
      fx.env(),
    );
    expect(r.status).toBe(2);
  });
});
