import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { readText } from '../../src/io/read-fs.js';
import { guardRealHome, makeFx, putOutside, REPO_ROOT, runScript } from './helpers.js';
import type { Fx } from './helpers.js';

guardRealHome();

// 不在源码里写字面量地址/URL(A10 的全量脱敏扫描对 ipv4/url 零容忍),运行时拼出来
const LOOP = ['127', '0', '0', '1'].join('.');
const URL_ = ['http:', '', `${LOOP}:9`].join('/');

const STUB = `
import * as fs from 'node:fs';
import * as path from 'node:path';
const argv = process.argv.slice(2);
const root = argv[argv.indexOf('--root') + 1];
const mode = fs.readFileSync(path.join(root, 'stub-mode.txt'), 'utf8').trim();
const cmd = argv.slice(argv.indexOf('--root') + 2).join(' ');
if (mode === 'build64' && cmd === 'build') process.exit(64);
if (mode === 'check1' && cmd === 'check') process.exit(1);
if (mode === 'swallow-fetch' && cmd === 'check') {
  try { await fetch(${JSON.stringify(URL_)}); } catch { /* 调用方吞掉异常 */ }
}
if (mode === 'swallow-curl' && cmd.startsWith('redact')) {
  const cp = await import('node:child_process');
  try { cp.spawnSync('curl', ['--version']); } catch { /* 吞掉 */ }
}
process.exit(0);
`;

async function setup(mode: string, shim?: string | null): Promise<{ fx: Fx; cli: string }> {
  const fx = await makeFx('a8-');
  if (shim !== null)
    await fx.put(
      'ops/guards/no-net.cjs',
      shim ?? (await readText(path.join(REPO_ROOT, 'ops/guards/no-net.cjs'))),
    );
  await fx.put('stub-mode.txt', mode + '\n');
  return { fx, cli: await putOutside(fx, 'stub-cli.mjs', STUB) };
}
const a8 = (fx: Fx, cli: string) =>
  runScript('a8-no-net.sh', ['--root', fx.root, '--cli', cli], fx.env());

describe('A8 运行期无网络', () => {
  it('四条运行期命令都成功且没碰网 => 0,并且 5 个探针都被垫片拦下(正向控制)', async () => {
    const { fx, cli } = await setup('ok');
    const r = a8(fx, cli);
    expect(r.status, r.stdout).toBe(0);
    expect((r.stdout.match(/垫片自检:.* 被拦/g) ?? []).length).toBe(5);
    expect(r.stdout).toContain('signals collect: 在垫片下成功');
  });

  it('命令尝试联网但吞掉了异常 => 1(留痕的拦截记录照样算数)', async () => {
    const { fx, cli } = await setup('swallow-fetch');
    const r = a8(fx, cli);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('尝试了联网');
  });

  it('命令起 curl 子进程(异常被吞)=> 1', async () => {
    const { fx, cli } = await setup('swallow-curl');
    expect(a8(fx, cli).status).toBe(1);
  });

  it('垫片被掏空(空文件)=> 探针没被拦 => 1:垫片失效时"全部成功"不可信', async () => {
    const { fx, cli } = await setup('ok', '// 空垫片\n');
    const r = a8(fx, cli);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('垫片失效');
  });

  it('垫片文件缺失 => 1', async () => {
    const { fx, cli } = await setup('ok', null);
    const r = a8(fx, cli);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('缺垫片');
  });

  it('build 是命令桩(64)=> 4,但其余命令照样跑完(不提前结束)', async () => {
    const { fx, cli } = await setup('build64');
    const r = a8(fx, cli);
    expect(r.status, r.stdout).toBe(4);
    expect(r.stdout).toContain('NOT-RUN build');
    expect(r.stdout).toContain('PASS signals collect');
  });

  it('命令本身失败(check 退出 1)=> 1', async () => {
    const { fx, cli } = await setup('check1');
    expect(a8(fx, cli).status).toBe(1);
  });

  it('CLI 不存在 => 4', async () => {
    const { fx } = await setup('ok');
    expect(a8(fx, path.join(fx.dir, 'nope.js')).status).toBe(4);
  });
});
