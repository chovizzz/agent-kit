/**
 * R20-A0:`runSelf` 的 RSI 前置修订(contracts §20.9 第 2、3 条 ②)与零网络桥接 `src/update/self-spawn.ts`(第 3 条 ①)。
 * 条款:R20-1.1(桥接零网络)、R20-2.9(`PI_CODING_AGENT_DIR` 只传「已设置」)、R20-3.2.2(worker 的 cwd 固定为仓库根)、R20-1.6(RSI 具名环境键)。
 * 子进程测试用 `current` 目标 + 记录 cwd / env 的假 cli.js(假 HOME、不联网);桥接的参数形状用注入的 runSelf 钉。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUN_SELF_ENV_KEYS, RunSelfDeniedError, runSelf } from '../../src/io/exec.js';
import { RSI_WORKER_ARGS, spawnRsiWorker } from '../../src/update/self-spawn.js';
import * as safe from '../../src/io/safe-fs.js';
import { realpath } from '../../src/io/read-fs.js';
import { REPO_ROOT } from '../helpers/tmp.js';
import { newWorld } from './install-world.js';
import { installFake, markers } from './launcher-world.js';

const REC_CLI = `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
writeFileSync(process.env.KIT_TMP + '/marker-' + process.pid + '.json',
  JSON.stringify({ argv: process.argv.slice(2), env: process.env, execArgv: process.execArgv, cwd: process.cwd() }));
process.exit(7);
`;

type Marker = Awaited<ReturnType<typeof markers>>[number] & { cwd: string };

async function run(
  o: { env?: Record<string, string | undefined>; cwd?: string; background?: boolean } = {},
): Promise<{
  w: Awaited<ReturnType<typeof newWorld>>;
  res: ReturnType<typeof runSelf>;
  m: () => Promise<Marker[]>;
}> {
  const w = await newWorld();
  await installFake(w, '0.2.0', REC_CLI);
  const res = runSelf({
    home: w.home,
    target: { kind: 'current' },
    args: ['x'],
    env: { PATH: '/usr/bin:/bin', KIT_TMP: w.dir, ...o.env },
    ...(o.cwd !== undefined ? { cwd: o.cwd } : {}),
    ...(o.background === true ? { background: true } : {}),
  });
  return { w, res, m: async () => (await markers(w)) as Marker[] };
}

describe('R20-A0 §20.9#2 RUN_SELF_ENV_KEYS 追加 RSI 具名键', () => {
  it('KIT_AUTO_RSI / KIT_RSI_CHILD / KIT_RSI_PI_DIR_SET 在白名单里,且是具名而不是 KIT_* 通配', () => {
    for (const k of ['KIT_AUTO_RSI', 'KIT_RSI_CHILD', 'KIT_RSI_PI_DIR_SET']) {
      expect(RUN_SELF_ENV_KEYS, k).toContain(k);
    }
    expect(RUN_SELF_ENV_KEYS).not.toContain('PI_CODING_AGENT_DIR');
    expect(RUN_SELF_ENV_KEYS.every((k) => !k.includes('*'))).toBe(true);
  });

  it('KIT_AUTO_RSI 与 KIT_RSI_CHILD 原样到达子进程;其它 KIT_RSI_* 未列名的不传(正向对照 + 负向)', async () => {
    const { m } = await run({
      env: { KIT_AUTO_RSI: '0', KIT_RSI_CHILD: '1', KIT_RSI_OTHER: 'x', KIT_RSI_PI_DIR: '/leak' },
    });
    const env = (await m())[0]?.env as Record<string, string>;
    expect(env['KIT_AUTO_RSI']).toBe('0');
    expect(env['KIT_RSI_CHILD']).toBe('1');
    expect(env['KIT_RSI_OTHER']).toBeUndefined();
    expect(env['KIT_RSI_PI_DIR']).toBeUndefined();
  });
});

describe('R20-A0 §20.9#3 / R20-2.9:PI_CODING_AGENT_DIR 只传「已设置」', () => {
  const PI_PATH = '/some/secret/pi-dir';

  it('已设置 → 子进程得到 KIT_RSI_PI_DIR_SET=1,且拿不到 PI_CODING_AGENT_DIR 本身(也不含其路径)', async () => {
    const { m } = await run({ env: { PI_CODING_AGENT_DIR: PI_PATH } });
    const mk = (await m())[0] as Marker;
    expect(mk.env['KIT_RSI_PI_DIR_SET']).toBe('1');
    expect(mk.env['PI_CODING_AGENT_DIR']).toBeUndefined();
    expect(JSON.stringify(mk.env)).not.toContain(PI_PATH);
  });

  it('空字符串也算「已设置」(偏安全:宁可让 pi 记 not_evaluated)', async () => {
    const { m } = await run({ env: { PI_CODING_AGENT_DIR: '' } });
    expect(((await m())[0] as Marker).env['KIT_RSI_PI_DIR_SET']).toBe('1');
  });

  it('未设置 → 不出现该标志;调用方自带的 KIT_RSI_PI_DIR_SET=0/空/垃圾值被丢弃,不被透传', async () => {
    for (const v of [undefined, '0', '', 'yes', '/path']) {
      const { m } = await run({ env: v === undefined ? {} : { KIT_RSI_PI_DIR_SET: v } });
      expect(((await m())[0] as Marker).env['KIT_RSI_PI_DIR_SET'], String(v)).toBeUndefined();
    }
  });

  it('上一跳已折成 1(经启动器转发的前台进程再起 worker)→ 保持 1', async () => {
    const { m } = await run({ env: { KIT_RSI_PI_DIR_SET: '1' } });
    expect(((await m())[0] as Marker).env['KIT_RSI_PI_DIR_SET']).toBe('1');
  });
});

describe('R20-A0 §20.9#3 ② RunSelfOptions.cwd(R20-3.2.2)', () => {
  it('给了合规的 cwd → 子进程的工作目录就是它(前台)', async () => {
    const w = await newWorld();
    await installFake(w, '0.2.0', REC_CLI);
    const repo = path.join(await realpath(w.dir), 'repo');
    await safe.mkdirp(w.fx, repo);
    const real = await realpath(repo);
    const res = runSelf({
      home: w.home,
      target: { kind: 'current' },
      args: [],
      env: { PATH: '/usr/bin:/bin', KIT_TMP: w.dir },
      cwd: real,
    });
    expect(res).toMatchObject({ spawned: true, status: 7 });
    expect(((await markers(w)) as Marker[])[0]?.cwd).toBe(real);
  });

  it('后台模式同样生效', async () => {
    const w = await newWorld();
    await installFake(w, '0.2.0', REC_CLI);
    const repo = await realpath(w.dir);
    const res = runSelf({
      home: w.home,
      target: { kind: 'current' },
      args: [],
      env: { PATH: '/usr/bin:/bin', KIT_TMP: w.dir },
      cwd: repo,
      background: true,
    });
    expect(res).toMatchObject({ spawned: true });
    for (let i = 0; i < 100 && (await markers(w)).length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(((await markers(w)) as Marker[])[0]?.cwd).toBe(repo);
  });

  it('不给 cwd → 继承调用方工作目录(update 的既有行为不变)', async () => {
    const { m } = await run();
    expect(((await m())[0] as Marker).cwd).toBe(await realpath(REPO_ROOT));
  });

  it('相对路径 → 抛 RunSelfDeniedError(编程错误),不 spawn', async () => {
    const w = await newWorld();
    await installFake(w, '0.2.0', REC_CLI);
    expect(() =>
      runSelf({
        home: w.home,
        target: { kind: 'current' },
        args: [],
        env: { KIT_TMP: w.dir },
        cwd: 'relative/dir',
      }),
    ).toThrow(RunSelfDeniedError);
    expect(await markers(w)).toEqual([]);
  });

  it('不存在 / 是文件 / 符号链接(哪怕指向真实目录)/ 非规范路径(含 ..)→ cwd_invalid,不 spawn', async () => {
    const w = await newWorld();
    await installFake(w, '0.2.0', REC_CLI);
    const base = await realpath(w.dir);
    const repo = path.join(base, 'repo');
    await safe.mkdirp(w.fx, repo);
    await safe.writeFile(w.fx, path.join(base, 'afile'), 'x');
    await safe.symlink(w.fx, repo, path.join(base, 'link-to-repo'));
    const cases = [
      path.join(base, 'nope'),
      path.join(base, 'afile'),
      path.join(base, 'link-to-repo'),
      `${base}/repo/../repo`, // 字符串拼接:path.join 会把 .. 吃掉
      `${repo}/`,
    ];
    for (const cwd of cases) {
      const res = runSelf({
        home: w.home,
        target: { kind: 'current' },
        args: [],
        env: { PATH: '/usr/bin:/bin', KIT_TMP: w.dir },
        cwd,
      });
      expect(res, cwd).toEqual({ spawned: false, reason: 'cwd_invalid' });
    }
    expect(await markers(w)).toEqual([]);
    // 正向对照:同一个 repo 的规范写法能 spawn,说明上面的拒绝来自 cwd 而不是别的前置条件
    const ok = runSelf({
      home: w.home,
      target: { kind: 'current' },
      args: [],
      env: { PATH: '/usr/bin:/bin', KIT_TMP: w.dir },
      cwd: repo,
    });
    expect(ok).toMatchObject({ spawned: true });
  });
});

describe('R20-A0 §20.9#3 ① 零网络桥接 spawnRsiWorker', () => {
  const REPO = '/abs/repo';
  type Call = Parameters<typeof runSelf>[0];

  it('以固定形状调用 runSelf:self 目标、__rsi --background、后台、cwd=repo,环境原样交给 runSelf 过滤', () => {
    const calls: Call[] = [];
    const r = spawnRsiWorker(
      { home: '/abs/home', repo: REPO, env: { KIT_AUTO_RSI: '1', PI_CODING_AGENT_DIR: '/p' } },
      {
        runSelf: (o) => {
          calls.push(o);
          return { spawned: true, status: null, signal: null, stdout: '' };
        },
      },
    );
    expect(r).toEqual({ spawned: true });
    expect(calls).toHaveLength(1);
    const c = calls[0] as Call;
    expect(c.target).toEqual({ kind: 'self' });
    expect(c.args).toEqual(['__rsi', '--background']);
    expect([...RSI_WORKER_ARGS]).toEqual(['__rsi', '--background']);
    expect(c.background).toBe(true);
    expect(c.cwd).toBe(REPO);
    expect(c.home).toBe('/abs/home');
    expect(c.env).toEqual({ KIT_AUTO_RSI: '1', PI_CODING_AGENT_DIR: '/p' });
    // worker 不读 stdin、不带 tmpDir:桥接不传别的东西
    expect(Object.keys(c).sort()).toEqual(['args', 'background', 'cwd', 'env', 'home', 'target']);
  });

  it('runSelf 拒绝(含 cwd_invalid)→ 原因透传;抛 RunSelfDeniedError → denied;其它异常 → threw;都不向外抛', () => {
    const refuse = spawnRsiWorker(
      { home: '/h', repo: REPO, env: {} },
      { runSelf: () => ({ spawned: false, reason: 'cwd_invalid' }) },
    );
    expect(refuse).toEqual({ spawned: false, why: 'cwd_invalid' });
    const denied = spawnRsiWorker(
      { home: '/h', repo: REPO, env: {} },
      {
        runSelf: () => {
          throw new RunSelfDeniedError('x');
        },
      },
    );
    expect(denied).toEqual({ spawned: false, why: 'denied' });
    const threw = spawnRsiWorker(
      { home: '/h', repo: REPO, env: {} },
      {
        runSelf: () => {
          throw new Error('boom');
        },
      },
    );
    expect(threw).toEqual({ spawned: false, why: 'threw' });
  });

  it('真 runSelf + 相对 repo:不抛错,返回 denied(调用方静默放弃)', () => {
    expect(spawnRsiWorker({ home: '/abs/home', repo: 'rel', env: {} })).toEqual({
      spawned: false,
      why: 'denied',
    });
  });
});
