/**
 * D-AU1 / D-AU2(contracts §20.19):零网络桥接 `self-spawn.ts` 的两个新出口。文件名 `self-spawn*.test.ts` 命中 eslint 的桥接测试块
 * (只多放行 runSelf,不放行 net / 启动器)。真实 `dist/cli.js` 子进程验收见 `test/rsi/hook-forward-dist.test.ts`。
 *  - `forwardHookToCurrent`:转发的调用形状、超时 / 信号折算(H4)、拒绝 / 抛错 → 不转发、判据来自 `decideCurrent`;
 *  - `spawnUpdateWorker`:调度谓词矩阵(H3)、零写入(H2-B)、目标选择、24h 节流下的幂等(M5)、从不抛。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunSelfDeniedError, type RunSelfOptions, type RunSelfResult } from '../../src/io/exec.js';
import * as safe from '../../src/io/safe-fs.js';
import {
  HOOK_FORWARD_TIMEOUT_MS,
  UPDATE_WORKER_ARGS,
  forwardHookToCurrent,
  spawnUpdateWorker,
} from '../../src/update/self-spawn.js';
import { treeOf } from '../rsi/rsi-fixture.js';
import { newWorld, type World } from './install-world.js';
import { STATE_DIR, installFake, put, putState } from './launcher-world.js';

const HOME_ENV = { KIT_TMP: '/x', PATH: '/usr/bin:/bin' };
const TMP_REL = `${STATE_DIR}/tmp`;
const NOW = Date.parse('2026-11-04T12:00:00Z');
const iso = (ms: number): string => new Date(ms).toISOString();

interface Rec {
  calls: RunSelfOptions[];
  run: (o: RunSelfOptions) => RunSelfResult;
}
const rec = (
  result: RunSelfResult | (() => RunSelfResult) = {
    spawned: true,
    status: 0,
    signal: null,
    stdout: '',
  },
): Rec => {
  const calls: RunSelfOptions[] = [];
  return {
    calls,
    run: (o) => {
      calls.push(o);
      return typeof result === 'function' ? result() : result;
    },
  };
};

async function mkTmp(w: World, mode = 0o700): Promise<string> {
  const abs = path.join(w.home, ...TMP_REL.split('/'));
  await safe.mkdirp(w.fx, abs, mode);
  await safe.chmod(w.fx, abs, mode);
  return abs;
}

async function writeConfig(w: World, text: string): Promise<void> {
  const dir = path.join(w.home, '.config', 'agent-kit');
  await safe.mkdirp(w.fx, dir);
  await safe.writeFile(w.fx, path.join(dir, 'config.toml'), text, { mode: 0o600 });
}

describe('forwardHookToCurrent', () => {
  const argv = ['rsi', 'hint', '--agent', 'claude'];

  it('更高同 major 且树校验过 → runSelf(target current、原样 argv、带超时),返回子进程码', async () => {
    const w = await newWorld();
    await installFake(w, '0.2.0');
    const r = rec({ spawned: true, status: 7, signal: null, stdout: '' });
    const out = await forwardHookToCurrent(
      { argv, home: w.home, env: HOME_ENV },
      { runSelf: r.run, ownVersion: '0.1.0' },
    );
    expect(out).toEqual({ forwarded: true, code: 7 });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({
      home: w.home,
      target: { kind: 'current', version: '0.2.0' },
      args: argv,
      env: HOME_ENV,
      timeoutMs: HOOK_FORWARD_TIMEOUT_MS,
    });
    expect(r.calls[0]?.background).toBeUndefined();
  });

  it('timeoutMs: null(`__rsi` 用)→ 不给超时;给数值照传', async () => {
    const w = await newWorld();
    await installFake(w, '0.2.0');
    const a = rec();
    await forwardHookToCurrent(
      { argv: ['__rsi', '--background'], home: w.home, env: HOME_ENV, timeoutMs: null },
      { runSelf: a.run, ownVersion: '0.1.0' },
    );
    expect(a.calls[0] !== undefined && 'timeoutMs' in a.calls[0]).toBe(false);
    const b = rec();
    await forwardHookToCurrent(
      { argv, home: w.home, env: HOME_ENV, timeoutMs: 1234 },
      { runSelf: b.run, ownVersion: '0.1.0' },
    );
    expect(b.calls[0]?.timeoutMs).toBe(1234);
  });

  it('H4:超时 / 被信号终止(status:null)也算已转发,折成 128+signo,不回退本地', async () => {
    const w = await newWorld();
    await installFake(w, '0.2.0');
    for (const [signal, code] of [
      ['SIGTERM', 143],
      ['SIGKILL', 137],
      [null, 129],
    ] as const) {
      const r = rec({ spawned: true, status: null, signal, stdout: '' });
      expect(
        await forwardHookToCurrent(
          { argv, home: w.home, env: HOME_ENV },
          { runSelf: r.run, ownVersion: '0.1.0' },
        ),
        String(signal),
      ).toEqual({ forwarded: true, code });
      expect(r.calls).toHaveLength(1);
    }
  });

  it('不转发的情形 runSelf 一次都不调:相同 / 更低 / 跨 major / 损坏 / 无状态 / KIT_LAUNCHED', async () => {
    const mk = async (v: string): Promise<World> => {
      const w = await newWorld();
      await installFake(w, v);
      return w;
    };
    const cases: [string, World, string, Record<string, string>][] = [
      ['same', await mk('0.2.0'), '0.2.0', {}],
      ['lower', await mk('0.2.0'), '0.3.0', {}],
      ['major', await mk('1.0.0'), '0.9.0', {}],
      ['launched', await mk('0.2.0'), '0.1.0', { KIT_LAUNCHED: '1' }],
      ['absent', await newWorld(), '0.1.0', {}],
    ];
    const broken = await mk('0.2.0');
    await putState(broken, '0.2.0', 'd'.repeat(64));
    cases.push(['broken', broken, '0.1.0', {}]);
    for (const [name, w, own, env] of cases) {
      const r = rec();
      expect(
        await forwardHookToCurrent(
          { argv, home: w.home, env: { ...HOME_ENV, ...env } },
          { runSelf: r.run, ownVersion: own },
        ),
        name,
      ).toEqual({ forwarded: false });
      expect(r.calls, name).toHaveLength(0);
    }
  });

  it('runSelf 拒绝(spawned:false)/ 抛错 → 不转发(从不抛)', async () => {
    const w = await newWorld();
    await installFake(w, '0.2.0');
    const refused = rec({ spawned: false, reason: 'entry_invalid' });
    expect(
      await forwardHookToCurrent(
        { argv, home: w.home, env: HOME_ENV },
        { runSelf: refused.run, ownVersion: '0.1.0' },
      ),
    ).toEqual({ forwarded: false });
    expect(
      await forwardHookToCurrent(
        { argv, home: w.home, env: HOME_ENV },
        {
          runSelf: () => {
            throw new RunSelfDeniedError('x');
          },
          ownVersion: '0.1.0',
        },
      ),
    ).toEqual({ forwarded: false });
  });

  it('判据只来自 decideCurrent:注入的校验器说不过就不转发(不自行比较版本)', async () => {
    const w = await newWorld();
    await installFake(w, '0.2.0');
    const r = rec();
    const out = await forwardHookToCurrent(
      { argv, home: w.home, env: HOME_ENV },
      {
        runSelf: r.run,
        ownVersion: '0.1.0',
        decide: { verifyTree: async () => ({ ok: false, reason: 'file_mismatch' }) },
      },
    );
    expect(out).toEqual({ forwarded: false });
    expect(r.calls).toHaveLength(0);
  });
});

describe('spawnUpdateWorker:谓词矩阵 / 零写入 / 目标选择', () => {
  /** 一个「该调度」的世界:有效 current、受控 tmp、状态里上次检查在 25h 前(`null` = 从未检查) */
  async function dueWorld(last: number | null = NOW - 25 * 3_600_000): Promise<World> {
    const w = await newWorld();
    const inst = await installFake(w, '0.2.0');
    await putState(w, '0.2.0', inst.pkg.anchor, (s) => ({
      ...s,
      ...(last !== null ? { last_check_at: iso(last) } : {}),
    }));
    await mkTmp(w);
    Object.assign(w, { anchor: inst.pkg.anchor });
    return w;
  }
  const anchorOf = (w: World): string => (w as World & { anchor: string }).anchor;
  const input = (
    w: World,
    env: Record<string, string> = {},
  ): { home: string; env: Record<string, string> } => ({
    home: w.home,
    env: { ...HOME_ENV, ...env },
  });
  const now = (): Date => new Date(NOW);

  it('该调度:恰好一次 detached 的 __update --background;目标 current、TMPDIR=受控目录;全程零写入', async () => {
    const w = await dueWorld();
    const before = await treeOf(w.dir);
    const r = rec();
    expect(await spawnUpdateWorker(input(w), { runSelf: r.run, now })).toEqual({ scheduled: true });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({
      home: w.home,
      target: { kind: 'current', version: '0.2.0' },
      args: ['__update', '--background'],
      background: true,
      tmpDir: path.join(w.home, ...TMP_REL.split('/')),
    });
    expect(UPDATE_WORKER_ARGS).toEqual(['__update', '--background']);
    expect(await treeOf(w.dir)).toEqual(before);
  });

  it('KIT_LAUNCHED=1(poke 跑在被转发的 current 里)不挡调度', async () => {
    const w = await dueWorld();
    const r = rec();
    expect(
      await spawnUpdateWorker(input(w, { KIT_LAUNCHED: '1' }), { runSelf: r.run, now }),
    ).toEqual({ scheduled: true });
  });

  it('H3 开关:KIT_AUTO_UPDATE 关(0/false/off/no)、CI、auto_install=false → 不调度', async () => {
    const off = ['0', 'false', 'off', 'no'];
    for (const v of off) {
      const w = await dueWorld();
      const r = rec();
      expect(
        await spawnUpdateWorker(input(w, { KIT_AUTO_UPDATE: v }), { runSelf: r.run, now }),
        v,
      ).toEqual({ scheduled: false, why: 'gate' });
      expect(r.calls).toHaveLength(0);
    }
    for (const ci of ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE']) {
      const w = await dueWorld();
      const r = rec();
      expect(
        await spawnUpdateWorker(input(w, { [ci]: 'true' }), { runSelf: r.run, now }),
        ci,
      ).toEqual({ scheduled: false, why: 'gate' });
      expect(r.calls).toHaveLength(0);
    }
    const w = await dueWorld();
    await writeConfig(w, '[update]\nauto_install = false\n');
    const r = rec();
    expect(await spawnUpdateWorker(input(w), { runSelf: r.run, now })).toEqual({
      scheduled: false,
      why: 'gate',
    });
    expect(r.calls).toHaveLength(0);
  });

  it('H3 fail-closed:config.toml 读不出 / 解析失败 → 不调度(why=config)', async () => {
    const w = await dueWorld();
    await writeConfig(w, '[update\n');
    const r = rec();
    expect(await spawnUpdateWorker(input(w), { runSelf: r.run, now })).toEqual({
      scheduled: false,
      why: 'config',
    });
    expect(r.calls).toHaveLength(0);
  });

  it('24h 节流:23h59m 不调度;恰 24h、从未检查、时钟回拨 → 调度', async () => {
    const h = 3_600_000;
    for (const [last, want] of [
      [NOW - 23 * h - 59 * 60_000, false],
      [NOW - 24 * h, true],
      [null, true],
      [NOW + 5 * h, true],
    ] as const) {
      const w = await dueWorld(last);
      const r = rec();
      const out = await spawnUpdateWorker(input(w), { runSelf: r.run, now });
      expect(out.scheduled, String(last)).toBe(want);
      expect(r.calls.length, String(last)).toBe(want ? 1 : 0);
      if (!want) expect(out).toEqual({ scheduled: false, why: 'throttled' });
    }
  });

  it('状态不可读 / 不安全 → 不调度(why=state)', async () => {
    const garbage = await newWorld();
    await put(garbage, path.join(garbage.home, STATE_DIR, 'state.json'), '{nope');
    await mkTmp(garbage);
    const r = rec();
    expect(await spawnUpdateWorker(input(garbage), { runSelf: r.run, now })).toEqual({
      scheduled: false,
      why: 'state',
    });
    expect(r.calls).toHaveLength(0);
  });

  it('H2-B:受控 tmp 不存在 / 权限过宽 → 不调度且不创建它(why=tmp)', async () => {
    const missing = await newWorld();
    await installFake(missing, '0.2.0');
    const before = await treeOf(missing.dir);
    const r = rec();
    expect(await spawnUpdateWorker(input(missing), { runSelf: r.run, now })).toEqual({
      scheduled: false,
      why: 'tmp',
    });
    expect(r.calls).toHaveLength(0);
    expect(await treeOf(missing.dir)).toEqual(before);

    const loose = await dueWorld();
    await mkTmp(loose, 0o755);
    const r2 = rec();
    expect(await spawnUpdateWorker(input(loose), { runSelf: r2.run, now })).toEqual({
      scheduled: false,
      why: 'tmp',
    });
    expect(r2.calls).toHaveLength(0);
  });

  it('目标:current 校验不过(锚点不符)→ self;没有任何状态(首次安装)→ self 且仍调度', async () => {
    const bad = await dueWorld();
    await putState(bad, '0.2.0', 'e'.repeat(64), (s) => ({
      ...s,
      last_check_at: iso(NOW - 48 * 3_600_000),
    }));
    const r = rec();
    expect(await spawnUpdateWorker(input(bad), { runSelf: r.run, now })).toEqual({
      scheduled: true,
    });
    expect(r.calls[0]?.target).toEqual({ kind: 'self' });

    const fresh = await newWorld();
    await mkTmp(fresh);
    const r2 = rec();
    expect(await spawnUpdateWorker(input(fresh), { runSelf: r2.run, now })).toEqual({
      scheduled: true,
    });
    expect(r2.calls[0]?.target).toEqual({ kind: 'self' });
  });

  it('runSelf 拒绝 / 抛错 → scheduled:false(why 为拒绝原因 / denied / threw),从不抛', async () => {
    const w = await dueWorld();
    expect(
      await spawnUpdateWorker(input(w), {
        runSelf: rec({ spawned: false, reason: 'spawn_failed' }).run,
        now,
      }),
    ).toEqual({ scheduled: false, why: 'spawn_failed' });
    expect(
      await spawnUpdateWorker(input(w), {
        runSelf: () => {
          throw new RunSelfDeniedError('x');
        },
        now,
      }),
    ).toEqual({ scheduled: false, why: 'denied' });
    expect(
      await spawnUpdateWorker(input(w), {
        runSelf: () => {
          throw new Error('boom');
        },
        now,
      }),
    ).toEqual({ scheduled: false, why: 'threw' });
  });

  it('M5:worker 一旦写下 last_check_at,紧接着的第二次 poke 不再调度(并发窗口内多起的 worker 由 worker 锁 / 锁内复查节流消化)', async () => {
    const w = await dueWorld();
    let spawned = 0;
    const run = (): RunSelfResult => {
      spawned += 1;
      return { spawned: true, status: null, signal: null, stdout: '' };
    };
    const t = { now: (): Date => new Date(NOW) };
    expect((await spawnUpdateWorker(input(w), { runSelf: run, ...t })).scheduled).toBe(true);
    // 模拟 worker 已经写下检查时间
    await putState(w, '0.2.0', anchorOf(w), (s) => ({ ...s, last_check_at: iso(NOW) }));
    expect((await spawnUpdateWorker(input(w), { runSelf: run, ...t })).scheduled).toBe(false);
    expect(spawned).toBe(1);
  });
});
