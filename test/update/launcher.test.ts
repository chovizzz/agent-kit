import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { runSelf } from '../../src/io/exec.js';
import { lstat, readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { launchCurrent, scheduleBackground, smokeCandidate } from '../../src/update/launcher.js';
import { newWorld, realHomeSnapshot, type World } from './install-world.js';
import {
  SHARE,
  STATE_DIR,
  installFake,
  lay,
  link,
  markers,
  put,
  putState,
} from './launcher-world.js';

void ExitCode;

const OWN = '0.1.0-rc.0';

async function launch(
  w: World,
  o: { env?: Record<string, string>; own?: string; run?: typeof runSelf } = {},
): Promise<{ r: Awaited<ReturnType<typeof launchCurrent>>; err: string }> {
  let err = '';
  const r = await launchCurrent(
    {
      argv: ['sync', '--json'],
      home: w.home,
      env: { KIT_TMP: w.dir, PATH: '/usr/bin:/bin', ...o.env },
    },
    { ownVersion: o.own ?? OWN, ...(o.run !== undefined ? { runSelf: o.run } : {}) },
    (t) => void (err += t),
  );
  return { r, err };
}

describe('launcher:启动 current', () => {
  it('current 有效、更高、同 major、锚点一致 → 以 KIT_LAUNCHED=1 启动并返回子进程退出码(正向对照)', async () => {
    const before = await realHomeSnapshot();
    const w = await newWorld();
    await installFake(w, '0.2.0');
    const { r, err } = await launch(w);
    expect(r).toEqual({ launched: true, code: 7 });
    expect(err).toBe('');
    const m = await markers(w);
    expect(m).toHaveLength(1);
    expect(m[0]?.argv).toEqual(['sync', '--json']);
    expect(m[0]?.env['KIT_LAUNCHED']).toBe('1');
    expect(await realHomeSnapshot()).toEqual(before);
  });

  it('子进程已启动后,即使退出码非零也不回退到自身(只启动一次)', async () => {
    const w = await newWorld();
    await installFake(w, '0.2.0');
    const { r } = await launch(w);
    expect(r).toMatchObject({ launched: true, code: 7 });
    expect(await markers(w)).toHaveLength(1);
  });

  it('递归防护:KIT_LAUNCHED 已设时不再启动(同一世界不设该变量则会启动)', async () => {
    const w = await newWorld();
    await installFake(w, '0.2.0');
    const { r, err } = await launch(w, { env: { KIT_LAUNCHED: '1' } });
    expect(r).toEqual({ launched: false });
    expect(err).toBe('');
    expect(await markers(w)).toHaveLength(0);
    expect((await launch(w)).r.launched).toBe(true);
  });

  it('KIT_LAUNCHED=0 / 空串按未设处理(仍会启动)', async () => {
    const w = await newWorld();
    await installFake(w, '0.2.0');
    expect((await launch(w, { env: { KIT_LAUNCHED: '0' } })).r.launched).toBe(true);
  });

  it('版本比较:相等 / 更低 / 跨 major 都不启动且不报损坏;更高同 major 才启动', async () => {
    const w = await newWorld();
    await installFake(w, '0.2.0');
    for (const own of ['0.2.0', '0.3.0', '1.0.0']) {
      const { r, err } = await launch(w, { own });
      expect(r).toEqual({ launched: false });
      expect(err).toBe('');
    }
    expect((await launch(w, { own: '0.1.9' })).r.launched).toBe(true);
    const w2 = await newWorld();
    await installFake(w2, '2.0.0');
    expect(await launch(w2, { own: '1.9.9' })).toMatchObject({ r: { launched: false } });
    expect(await markers(w2)).toHaveLength(0);
  });

  it('没有 state / 没有 installed → 静默用自己', async () => {
    const w = await newWorld();
    expect(await launch(w)).toEqual({ r: { launched: false }, err: '' });
    await lay(w, '0.2.0');
    await link(w, '0.2.0');
    expect(await launch(w)).toEqual({ r: { launched: false }, err: '' });
  });

  it('state.installed.version 与 current 解析出的版本不符 → 退回自身并报 UPDATE_CURRENT_BROKEN', async () => {
    const w = await newWorld();
    const a = await installFake(w, '0.2.0');
    await lay(w, '0.2.1');
    await putState(w, '0.2.1', a.pkg.anchor);
    const { r, err } = await launch(w);
    expect(r).toEqual({ launched: false, broken: 'version_mismatch' });
    expect(err).toBe('UPDATE_CURRENT_BROKEN reason=version_mismatch\n');
    expect(await markers(w)).toHaveLength(0);
  });

  it('锚点不符(state 记的 anchor 不是 current/integrity.json 的 sha256)→ 退回自身', async () => {
    const w = await newWorld();
    await installFake(w, '0.2.0');
    await putState(w, '0.2.0', 'a'.repeat(64));
    const { r, err } = await launch(w);
    expect(r).toEqual({ launched: false, broken: 'anchor' });
    expect(err).toBe('UPDATE_CURRENT_BROKEN reason=anchor\n');
    expect(await markers(w)).toHaveLength(0);
  });

  it('「自洽损坏」:integrity.json 与文件一起被换成另一套自洽内容,锚点不符 → 退回自身', async () => {
    const w = await newWorld();
    const a = await installFake(w, '0.2.0');
    const evil = await lay(w, '0.2.0', '#!/usr/bin/env node\nconsole.log("evil")\n');
    expect(evil.pkg.anchor).not.toBe(a.pkg.anchor);
    const { r } = await launch(w);
    expect(r).toEqual({ launched: false, broken: 'anchor' });
  });

  it('树内文件被改(integrity.json 没动,锚点仍对)→ 退回自身', async () => {
    const w = await newWorld();
    const a = await installFake(w, '0.2.0');
    await safe.writeFile(w.fx, path.join(a.root, 'dist/main.js'), 'export const evil = 1;\n');
    const { r, err } = await launch(w);
    expect(r).toEqual({ launched: false, broken: 'tree' });
    expect(err).toBe('UPDATE_CURRENT_BROKEN reason=tree\n');
    expect(await markers(w)).toHaveLength(0);
  });

  it('dist/cli.js 被换成符号链接 → 退回自身', async () => {
    const w = await newWorld();
    const a = await installFake(w, '0.2.0');
    await safe.remove(w.fx, path.join(a.root, 'dist/cli.js'));
    await safe.symlink(w.fx, path.join(a.root, 'dist/main.js'), path.join(a.root, 'dist/cli.js'));
    const { r } = await launch(w);
    expect(r.launched).toBe(false);
    expect(await markers(w)).toHaveLength(0);
  });

  it('current 悬空(版本目录被删)→ 退回自身', async () => {
    const w = await newWorld();
    const a = await installFake(w, '0.2.0');
    await safe.rename(w.fx, a.root, path.join(w.dir, 'moved-away'));
    const { r, err } = await launch(w);
    expect(r).toEqual({ launched: false, broken: 'current' });
    expect(err).toContain('UPDATE_CURRENT_BROKEN');
  });

  it('current 逃逸到 versions/ 之外 → 退回自身', async () => {
    const w = await newWorld();
    const a = await installFake(w, '0.2.0');
    const outside = path.join(w.dir, 'outside');
    await safe.mkdirp(w.fx, outside);
    for (const f of a.pkg.files) {
      await put(w, path.join(outside, f.path), f.data, f.mode ?? 0o644);
    }
    await put(w, path.join(outside, 'integrity.json'), a.pkg.integrityBytes);
    const l = path.join(w.home, SHARE, 'current');
    await safe.remove(w.fx, l);
    await safe.symlink(w.fx, outside, l);
    const { r } = await launch(w);
    expect(r).toEqual({ launched: false, broken: 'current' });
    expect(await markers(w)).toHaveLength(0);
  });

  it('状态文件损坏 → 退回自身并报 state;spawn 失败 → 退回自身并报原因', async () => {
    const w = await newWorld();
    await installFake(w, '0.2.0');
    await put(w, path.join(w.home, STATE_DIR, 'state.json'), '{');
    expect(await launch(w)).toMatchObject({ r: { launched: false, broken: 'state' } });
    const w2 = await newWorld();
    await installFake(w2, '0.2.0');
    const { r } = await launch(w2, {
      run: () => ({ spawned: false, reason: 'spawn_failed' }),
    });
    expect(r).toEqual({ launched: false, broken: 'spawn_failed' });
  });

  it('runSelf 在 spawn 前抛错:按没能启动处理,退回自身(不吞掉、不二次执行)', async () => {
    const w = await newWorld();
    await installFake(w, '0.2.0');
    const { r, err } = await launch(w, {
      run: () => {
        throw new Error('precondition');
      },
    });
    expect(r).toEqual({ launched: false, broken: 'spawn_failed' });
    expect(err).toBe('UPDATE_CURRENT_BROKEN reason=spawn_failed\n');
    expect(await markers(w)).toHaveLength(0);
  });

  it('把启动参数原样交给 runSelf,并绑定 current 版本(target.version)', async () => {
    const w = await newWorld();
    await installFake(w, '0.2.0');
    const calls: Parameters<typeof runSelf>[0][] = [];
    await launch(w, {
      run: (o) => {
        calls.push(o);
        return { spawned: true, status: 0, signal: null, stdout: '' };
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.target).toEqual({ kind: 'current', version: '0.2.0' });
    expect(calls[0]?.args).toEqual(['sync', '--json']);
    expect(calls[0]?.home).toBe(w.home);
  });
});

describe('launcher:冒烟(InstallDeps.smoke 的真实现)', () => {
  async function candidate(w: World, version: string, cli: string): Promise<string> {
    const inst = await lay(w, version, cli);
    const stg = path.join(w.home, SHARE, 'staging', 'st-abc123');
    await safe.mkdirp(w.fx, path.dirname(stg));
    await safe.rename(w.fx, inst.root, stg);
    return stg;
  }

  it('退出 0 且 stdout 恰为目标版本号 → 通过;版本号不符 / 非零退出 / 候选不在 staging → 失败', async () => {
    const w = await newWorld();
    const good = `#!/usr/bin/env node\nprocess.stdout.write('0.2.0\\n');\n`;
    const stg = await candidate(w, '0.2.0', good);
    expect(smokeCandidate({ home: w.home, stagingAbs: stg, version: '0.2.0' })).toBe(true);
    // 负向:同一候选,期望另一个版本号
    expect(smokeCandidate({ home: w.home, stagingAbs: stg, version: '0.2.1' })).toBe(false);

    const w2 = await newWorld();
    const bad = await candidate(
      w2,
      '0.2.0',
      `#!/usr/bin/env node\nprocess.stdout.write('0.2.0');process.exit(3);\n`,
    );
    expect(smokeCandidate({ home: w2.home, stagingAbs: bad, version: '0.2.0' })).toBe(false);

    const w3 = await newWorld();
    const inst = await lay(w3, '0.2.0', good);
    await safe.mkdirp(w3.fx, path.join(w3.home, SHARE, 'staging'));
    expect(smokeCandidate({ home: w3.home, stagingAbs: inst.root, version: '0.2.0' })).toBe(false);
  });
});

describe('launcher:后台调度', () => {
  const TTY = { isTTY: true, now: () => new Date('2026-10-14T12:00:00Z') };
  const base = (w: World, argv: string[], env: Record<string, string> = {}) => ({
    argv,
    home: w.home,
    env: { KIT_TMP: w.dir, PATH: '/usr/bin:/bin', ...env },
  });

  it('TTY、非 CI、节流到期 → 起 worker(自带受控 TMPDIR、background);其它情形各自不起', async () => {
    const w = await newWorld();
    const calls: Parameters<typeof runSelf>[0][] = [];
    const run = (o: Parameters<typeof runSelf>[0]) => {
      calls.push(o);
      return { spawned: true as const, status: null, signal: null, stdout: '' };
    };
    const s = await scheduleBackground(base(w, ['sync']), { ...TTY, runSelf: run });
    expect(s).toEqual({ scheduled: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(['__update', '--background']);
    expect(calls[0]?.background).toBe(true);
    expect(calls[0]?.target).toEqual({ kind: 'self' });
    expect(calls[0]?.tmpDir).toBe(path.join(w.home, STATE_DIR, 'tmp'));
    expect((await lstat(calls[0]?.tmpDir as string)).mode & 0o777).toBe(0o700);

    const none = async (argv: string[], env: Record<string, string>, extra = {}) =>
      (await scheduleBackground(base(w, argv, env), { ...TTY, runSelf: run, ...extra })).scheduled;
    expect(await none(['sync'], { KIT_AUTO_UPDATE: '0' })).toBe(false);
    expect(await none(['sync'], { CI: 'true' })).toBe(false);
    expect(await none(['sync'], { KIT_LAUNCHED: '1' })).toBe(false);
    expect(await none(['sync'], {}, { isTTY: false })).toBe(false);
    expect(await none(['check'], {})).toBe(false);
    expect(await none(['build'], {})).toBe(false);
    expect(await none(['__update', '--background'], {})).toBe(false);
    expect(await none(['--version'], {})).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('节流:24h 内不起;满 24h 起;时钟往回走视为到期', async () => {
    const w = await newWorld();
    await installFake(w, '0.2.0');
    const calls: unknown[] = [];
    const run = () => {
      calls.push(1);
      return { spawned: true as const, status: null, signal: null, stdout: '' };
    };
    const at = async (last: string, now: string) => {
      await putState(w, '0.2.0', await installedAnchor(w), (s) => ({ ...s, last_check_at: last }));
      return (
        await scheduleBackground(base(w, ['sync']), {
          isTTY: true,
          now: () => new Date(now),
          runSelf: run,
        })
      ).scheduled;
    };
    expect(await at('2026-10-14T00:00:00.000Z', '2026-10-14T12:00:00Z')).toBe(false);
    expect(await at('2026-10-13T11:59:00.000Z', '2026-10-14T12:00:00Z')).toBe(true);
    expect(await at('2026-10-15T00:00:00.000Z', '2026-10-14T12:00:00Z')).toBe(true);
  });

  it('有有效 current 时由 current 起 worker;锚点不符时退到 self', async () => {
    const w = await newWorld();
    await installFake(w, '0.2.0');
    const targets: unknown[] = [];
    const run = (o: Parameters<typeof runSelf>[0]) => {
      targets.push(o.target);
      return { spawned: true as const, status: null, signal: null, stdout: '' };
    };
    await scheduleBackground(base(w, ['sync']), { ...TTY, runSelf: run });
    await putState(w, '0.2.0', 'b'.repeat(64));
    await scheduleBackground(base(w, ['sync']), { ...TTY, runSelf: run });
    expect(targets).toEqual([{ kind: 'current', version: '0.2.0' }, { kind: 'self' }]);
  });
});

async function installedAnchor(w: World): Promise<string> {
  const { sha256 } = await import('./install-world.js');
  return sha256(
    Buffer.from(await readText(path.join(w.home, SHARE, 'versions/0.2.0/integrity.json'))),
  );
}
