import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import * as safe from '../../src/io/safe-fs.js';
import {
  guardRealHome,
  makeFx,
  putOutside,
  REAL_CLI,
  REPO_ROOT,
  runScript,
  SAFE_PATH,
} from './helpers.js';
import type { Fx } from './helpers.js';
import { spawnSync } from 'node:child_process'; // eslint-disable-line no-restricted-imports -- 取真实 selftest 输出作为假 CLI 的底稿

guardRealHome();

const realOutput = (): string => {
  const r = spawnSync(
    process.execPath,
    [REAL_CLI, '--root', REPO_ROOT, 'redact', '--selftest', '--mutate'],
    {
      encoding: 'utf8',
      env: { PATH: SAFE_PATH },
    },
  );
  expect(r.status).toBe(0);
  return r.stdout;
};

async function stub(fx: Fx, text: string, code = 0): Promise<string> {
  await safe.writeFile(fx.ctx, path.join(fx.dir, 'out.txt'), text);
  return putOutside(
    fx,
    'stub-cli.mjs',
    `import * as fs from 'node:fs'; process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(fx.dir, 'out.txt'))}, 'utf8')); process.exit(${code});`,
  );
}

const a3 = (fx: Fx, cli: string) =>
  runScript('a3-redaction.sh', ['--root', fx.root, '--cli', cli], fx.env());

describe('A3 脱敏', () => {
  const good = realOutput();

  it('真实 CLI:种子全形态 + 变异全部被杀 => 0(正向控制)', async () => {
    const fx = await makeFx('a3-');
    const r = a3(fx, REAL_CLI);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain('变异全部被杀');
  });

  it('底稿本身(假 CLI 回放真实输出)=> 0', async () => {
    const fx = await makeFx('a3-');
    const r = a3(fx, await stub(fx, good));
    expect(r.status, r.stdout).toBe(0);
  });

  it.each<[string, (t: string) => string, number]>([
    ['缺 SELFTEST OK 末行', (t) => t.replace('SELFTEST OK', ''), 1],
    [
      '某类种子少一个',
      (t) =>
        t.replace(
          /seeds recognized: (\d+)\/(\d+)/,
          (_m, a: string, b: string) => `seeds recognized: ${Number(a) - 1}/${b}`,
        ),
      1,
    ],
    [
      'recall 不是 100%',
      (t) =>
        t.replace(
          /recall: (\d+)\/(\d+)/,
          (_m, a: string, b: string) => `recall: ${Number(a) - 1}/${b}`,
        ),
      1,
    ],
    [
      '变异没杀光',
      (t) =>
        t.replace(
          /mutation killed: (\d+)\/(\d+)/,
          (_m, a: string, b: string) => `mutation killed: ${Number(a) - 1}/${b}`,
        ),
      1,
    ],
    ['出现 FAIL 行', (t) => `FAIL plain.prefix.x\n${t}`, 1],
    ['输出被清空', () => '', 1],
  ])('故意破坏:%s => 退出 1', async (_name, mutate, code) => {
    const fx = await makeFx('a3-');
    const text = mutate(good);
    expect(text).not.toBe(good); // 变异必须真的改到了输出
    const r = a3(fx, await stub(fx, text));
    expect(r.status, r.stdout).toBe(code);
  });

  it('CLI 自己退出非 0 => 1;命令桩 64 => 4;CLI 不存在 => 4', async () => {
    const fx = await makeFx('a3-');
    expect(a3(fx, await stub(fx, good, 1)).status).toBe(1);
    expect(a3(fx, await stub(fx, good, 64)).status).toBe(4);
    expect(a3(fx, path.join(fx.dir, 'nope.js')).status).toBe(4);
  });
});
