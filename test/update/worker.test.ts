/**
 * S7c-B:后台 worker(`__update --background`)。假 HOME / 假 registry(file://)/ 假 tarball;绝不联网、不碰真实 HOME。
 * worker 自身带 KIT_LAUNCHED=1(runSelf 强制),用例的环境里都带上它,证明判开关时被正确摘掉。
 */
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import type { CommandContext } from '../../src/commands/types.js';
import { readDir, readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { createUpdateCommand } from '../../src/commands/update.js';
import { createFixtureSource, type RegistrySource } from '../../src/update/registry.js';
import { createBackgroundCommand, type WorkerDeps } from '../../src/update/worker.js';
import {
  FIXED_NOW,
  NOW_MS,
  buildPkg,
  newWorld,
  okVerifier,
  realHomeSnapshot,
  sha256,
  stateOf,
  treeOf,
  writeRegistry,
  type World,
} from './install-world.js';
import { put, putState } from './launcher-world.js';
import { newWorld as newSyncWorld, stdFixture, writePayloadFixture } from '../sync/world.js';

let realBefore: string[] = [];
beforeAll(async () => {
  realBefore = await realHomeSnapshot();
});
afterAll(async () => {
  expect(await realHomeSnapshot()).toEqual(realBefore);
});

const LOG = '.local/state/agent-kit/update/log';
const lastLog = async (w: World): Promise<string> =>
  (await readText(path.join(w.home, LOG))).trim().split(' ')[1] as string;

async function setup(version = '0.1.1'): Promise<World> {
  const w = await newWorld();
  await writeRegistry(w, { versions: [{ pkg: buildPkg(version) }], distTags: { latest: version } });
  return w;
}

async function runWorker(
  w: World,
  o: {
    argv?: string[];
    env?: Record<string, string>;
    deps?: WorkerDeps;
  } = {},
): Promise<{ code: number; err: string }> {
  const err: string[] = [];
  const ctx: CommandContext = {
    argv: o.argv ?? ['--background'],
    io: w.io,
    overlayPath: undefined,
    stdout: () => undefined,
    stderr: (t) => void err.push(t),
    env: { ...w.env, KIT_REAL_HOME_OVERRIDE: w.home, KIT_LAUNCHED: '1', ...o.env },
  };
  const code = await createBackgroundCommand({
    now: FIXED_NOW,
    verifier: okVerifier,
    noSmoke: true,
    ...o.deps,
  }).run(ctx);
  return { code, err: err.join('') };
}

describe('worker:开关', () => {
  it('正向对照:默认条件下检查并安装(worker 自带 KIT_LAUNCHED=1 也不被当成「已被启动」而跳过)', async () => {
    const w = await setup();
    const r = await runWorker(w);
    expect(r).toEqual({ code: 0, err: '' });
    expect((await stateOf(w))['installed'].version).toBe('0.1.1');
    expect(await lastLog(w)).toBe('ok');
  });

  it('stdout / stderr 都不输出(日志只有稳定码一行)', async () => {
    const w = await setup();
    const out: string[] = [];
    const ctx: CommandContext = {
      argv: ['--background'],
      io: w.io,
      overlayPath: undefined,
      stdout: (t) => void out.push(t),
      stderr: (t) => void out.push(t),
      env: { ...w.env, KIT_REAL_HOME_OVERRIDE: w.home, KIT_LAUNCHED: '1' },
    };
    await createBackgroundCommand({ now: FIXED_NOW, verifier: okVerifier, noSmoke: true }).run(ctx);
    expect(out).toEqual([]);
    expect(await readText(path.join(w.home, LOG))).toMatch(/^\S+ ok\n$/);
  });

  it('KIT_AUTO_UPDATE=0 / CI / config.auto_install=false → 跳过,不联网、不写 state', async () => {
    const envs: Record<string, string>[] = [{ KIT_AUTO_UPDATE: '0' }, { CI: 'true' }];
    for (const env of envs) {
      const w = await setup();
      const r = await runWorker(w, { env });
      expect(r.code).toBe(0);
      expect(await lastLog(w)).toBe('skipped_gate');
      expect((await treeOf(w.home)).join('\n')).not.toContain('state.json');
    }
    const w = await setup();
    await put(
      w,
      path.join(w.home, '.config/agent-kit/config.toml'),
      '[update]\nauto_install = false\n',
    );
    await runWorker(w);
    expect(await lastLog(w)).toBe('skipped_gate');
    expect((await treeOf(w.home)).join('\n')).not.toContain('state.json');
  });

  it('只接受 --background 这一个精确形状', async () => {
    const w = await setup();
    for (const argv of [[], ['--write'], ['--background', '--now']]) {
      expect((await runWorker(w, { argv })).code).toBe(ExitCode.USAGE);
    }
    expect((await treeOf(w.home)).join('\n')).not.toContain('versions/');
  });
});

describe('worker:24h 节流', () => {
  const at = (ms: number): string => new Date(ms).toISOString();

  it('24h 内不检查;满 24h 检查;时钟往回走(last_check_at 在未来)视为该检查了', async () => {
    const run = async (last: string): Promise<{ log: string; installed: boolean }> => {
      const w = await setup();
      await putState(w, '0.1.0', 'c'.repeat(64), (s) => ({ ...s, last_check_at: last }));
      // putState 记了 installed(为了拿到合法 state);去掉它,免得影响决策
      const st = JSON.parse(
        await readText(path.join(w.home, '.local/state/agent-kit/update/state.json')),
      );
      delete st.installed;
      delete st.max_seen_version;
      await put(
        w,
        path.join(w.home, '.local/state/agent-kit/update/state.json'),
        JSON.stringify(st),
      );
      await runWorker(w);
      const s2 = await stateOf(w);
      return { log: await lastLog(w), installed: s2['installed'] !== undefined };
    };
    expect(await run(at(NOW_MS - 3_600_000))).toEqual({
      log: 'skipped_throttled',
      installed: false,
    });
    expect(await run(at(NOW_MS - 25 * 3_600_000))).toEqual({ log: 'ok', installed: true });
    expect(await run(at(NOW_MS + 5 * 3_600_000))).toEqual({ log: 'ok', installed: true });
  });

  /** 带计数的假 registry:能证明「第一次访问 registry 是在拿锁之后」(file:// 夹具不经 deps.fetch,不能用 fetch 计数) */
  async function counting(w: World): Promise<{ source: RegistrySource; calls: () => number }> {
    const inner = await createFixtureSource(w.reg);
    let n = 0;
    const source: RegistrySource = {
      mirror: inner.mirror,
      packument: () => {
        n += 1;
        return inner.packument();
      },
      npmjsPackument: () => {
        n += 1;
        return inner.npmjsPackument();
      },
      attestations: (v) => inner.attestations(v),
      tarball: (u) => inner.tarball(u),
    };
    return { source, calls: () => n };
  }

  it('锁内再查一次节流:拿到锁时状态已显示刚被检查过 → 一次 registry 请求都不发,不装(对照:不拦则发请求并安装)', async () => {
    const w = await setup();
    const c = await counting(w);
    let inLock = 0;
    const r = await runWorker(w, {
      deps: {
        source: c.source,
        proceedInLock: () => {
          inLock += 1;
          return false;
        },
      },
    });
    expect(r.code).toBe(0);
    expect(inLock).toBe(1);
    expect(c.calls(), '锁优先:第一次访问 registry 必须在 proceedInLock 之后').toBe(0);
    expect((await treeOf(w.home)).join('\n')).not.toContain('versions/');
    // 对照
    const w2 = await setup();
    const c2 = await counting(w2);
    await runWorker(w2, { deps: { source: c2.source } });
    expect(c2.calls()).toBeGreaterThan(0);
    expect((await stateOf(w2))['installed'].version).toBe('0.1.1');
  });

  it('真实的锁内节流:外层判到期、进锁后时钟显示 24h 内已检查过 → 不联网', async () => {
    const w = await setup();
    await putState(w, '0.1.0', 'c'.repeat(64), (s) => ({
      ...s,
      last_check_at: new Date(NOW_MS - 25 * 3_600_000).toISOString(),
    }));
    const raw = JSON.parse(
      await readText(path.join(w.home, '.local/state/agent-kit/update/state.json')),
    );
    delete raw.installed;
    delete raw.max_seen_version;
    await put(
      w,
      path.join(w.home, '.local/state/agent-kit/update/state.json'),
      JSON.stringify(raw),
    );
    const c = await counting(w);
    let n = 0;
    // 第 1 次(worker 外层) = 现在;之后(取锁、锁内节流)= last_check_at + 1h,即 24h 内
    const now = (): Date => new Date((n += 1) <= 1 ? NOW_MS : NOW_MS - 24 * 3_600_000);
    await runWorker(w, { deps: { source: c.source, now } });
    expect(c.calls()).toBe(0);
    expect((await treeOf(w.home)).join('\n')).not.toContain('versions/');
  });
});

describe('worker:并发与锁', () => {
  it('update 锁被另一个活着的进程持有 → 静默跳过,日志 skipped_locked,state.json 不被无锁改写', async () => {
    const w = await setup();
    await put(
      w,
      path.join(w.home, '.local/state/agent-kit/update/lock'),
      JSON.stringify({
        pid: process.pid,
        started_at: FIXED_NOW().toISOString(),
        nonce: '0123456789abcdef',
      }),
      0o600,
    );
    const r = await runWorker(w);
    expect(r).toEqual({ code: 0, err: '' });
    expect(await lastLog(w)).toBe('skipped_locked');
    expect((await treeOf(w.home)).join('\n')).not.toMatch(/state\.json|versions\//);
  });
});

/** 开关会读进程环境里的 CI 类变量(CI=true 时自动更新关闭);这两个用例要测的是别的键,先把它们清掉,免得在 CI 里被开关提前挡掉。 */
function stubNoCiEnv(): void {
  for (const k of [
    'CI',
    'GITHUB_ACTIONS',
    'GITLAB_CI',
    'BUILDKITE',
    'CIRCLECI',
    'TF_BUILD',
    'JENKINS_URL',
  ]) {
    vi.stubEnv(k, '');
  }
}

describe('worker:真实入口的环境(main(argv) 不注入 env)', () => {
  it('ctx.env 缺省时从进程环境取收窄的具名键:KIT_AUTO_UPDATE=0 生效(对照:不设则照常安装)', async () => {
    const w = await setup();
    vi.stubEnv('KIT_REAL_HOME_OVERRIDE', w.home);
    // 双保险:即便被测代码丢了 KIT_REAL_HOME_OVERRIDE,os.homedir() 也只会落在假 HOME,绝不碰真实 HOME
    vi.stubEnv('HOME', w.home);
    vi.stubEnv('KIT_TMP', w.dir);
    vi.stubEnv('KIT_UPDATE_REGISTRY', `file://${w.reg}`);
    vi.stubEnv('KIT_LAUNCHED', '1');
    stubNoCiEnv();
    try {
      vi.stubEnv('KIT_AUTO_UPDATE', '0');
      const bare = async (): Promise<number> =>
        createBackgroundCommand({ now: FIXED_NOW, verifier: okVerifier, noSmoke: true }).run({
          argv: ['--background'],
          io: w.io,
          overlayPath: undefined,
          stdout: () => undefined,
          stderr: () => undefined,
        });
      expect(await bare()).toBe(0);
      expect(await lastLog(w)).toBe('skipped_gate');
      expect((await treeOf(w.home)).join('\n')).not.toContain('versions/');
      vi.stubEnv('KIT_AUTO_UPDATE', '');
      expect(await bare()).toBe(0);
      expect(await lastLog(w)).toBe('ok');
      expect((await stateOf(w))['installed'].version).toBe('0.1.1');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('KIT_UPDATE_PIN / KIT_UPDATE_REGISTRY 同样来自进程环境(非法 pin → 本次不安装)', async () => {
    const w = await setup();
    vi.stubEnv('KIT_REAL_HOME_OVERRIDE', w.home);
    // 双保险:即便被测代码丢了 KIT_REAL_HOME_OVERRIDE,os.homedir() 也只会落在假 HOME,绝不碰真实 HOME
    vi.stubEnv('HOME', w.home);
    vi.stubEnv('KIT_TMP', w.dir);
    vi.stubEnv('KIT_UPDATE_REGISTRY', `file://${w.reg}`);
    vi.stubEnv('KIT_UPDATE_PIN', '不是版本号');
    stubNoCiEnv();
    try {
      await createBackgroundCommand({ now: FIXED_NOW, verifier: okVerifier, noSmoke: true }).run({
        argv: ['--background'],
        io: w.io,
        overlayPath: undefined,
        stdout: () => undefined,
        stderr: () => undefined,
      });
      expect(await lastLog(w)).toBe('failed');
      expect((await treeOf(w.home)).join('\n')).not.toContain('versions/');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('update 命令:真实入口的环境', () => {
  it('ctx.env 缺省时 KIT_UPDATE_PIN 来自进程环境(非法 pin → 退出 3 bad_pin;对照:不设则正常干跑)', async () => {
    const w = await setup();
    const err: string[] = [];
    const run = async (): Promise<number> =>
      createUpdateCommand({ now: FIXED_NOW, verifier: okVerifier }).run({
        argv: ['--home', w.home],
        io: w.io,
        overlayPath: undefined,
        stdout: () => undefined,
        stderr: (t) => void err.push(t),
      });
    vi.stubEnv('HOME', w.home);
    vi.stubEnv('KIT_TMP', w.dir);
    vi.stubEnv('KIT_UPDATE_REGISTRY', `file://${w.reg}`);
    try {
      expect(await run()).toBe(0);
      vi.stubEnv('KIT_UPDATE_PIN', '不是版本号');
      expect(await run()).toBe(3);
      expect(err.join('')).toBe('UPDATE_FAIL_CLOSED reason=bad_pin\n');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('worker:冒烟(真执行 --version)', () => {
  it('候选版本的 dist/cli.js --version 输出不是目标版本号 → smoke 失败,不换 current,拉黑该版本', async () => {
    const w = await newWorld();
    const bad = buildPkg('0.1.1'); // 假 cli 打印 "cli 0.1.1",不等于 "0.1.1"
    await writeRegistry(w, { versions: [{ pkg: bad }], distTags: { latest: '0.1.1' } });
    const r = await runWorker(w, { deps: { noSmoke: false } });
    expect(r.code).toBe(0);
    const t = (await treeOf(w.home)).join('\n');
    expect(t).not.toMatch(/current/);
    expect(t).not.toContain('staging/st-');
    expect((await stateOf(w))['bad_versions']).toEqual(['0.1.1']);
    expect(await lastLog(w)).toBe('failed');
  });

  it('正向对照:cli.js 如实打印版本号 → 通过并切换 current', async () => {
    const w = await newWorld();
    const good = buildPkg('0.1.1', {
      edit: (files) =>
        files.map((f) =>
          f.path === 'dist/cli.js'
            ? { ...f, data: `#!/usr/bin/env node\nprocess.stdout.write('0.1.1\\n');\n` }
            : f,
        ),
    });
    await writeRegistry(w, { versions: [{ pkg: good }], distTags: { latest: '0.1.1' } });
    const r = await runWorker(w, { deps: { noSmoke: false } });
    expect(r.code).toBe(0);
    expect((await stateOf(w))['installed'].version).toBe('0.1.1');
    expect((await treeOf(w.home)).join('\n')).toContain('current -> link');
  });
});

describe('worker + 自动同步(同一把 update 锁内)', () => {
  /** 假 HOME 里已用 v1 payload 手动 sync 过;registry 里的新包(0.3.0)自带 v2 payload */
  async function scene(
    label: string,
    v2: (f: ReturnType<typeof stdFixture>) => ReturnType<typeof stdFixture> = (f) => f,
  ) {
    const sw = await newSyncWorld(label);
    await sw.setPayload(stdFixture(), { kitVersion: '0.3.0' });
    expect((await sw.run(['--write'])).code).toBe(0);
    // 用 v2 payload 造新包
    const stage = await newSyncWorld(`${label}pkg-`);
    await writePayloadFixture(stage, v2(stdFixture('v2')), { kitVersion: '0.3.0' });
    const extra: { path: string; data: string }[] = [];
    const walk = async (rel: string): Promise<void> => {
      for (const e of await readDir(path.join(stage.payloadRoot, rel))) {
        const r = `${rel}/${e.name}`;
        if (e.isDirectory) await walk(r);
        else extra.push({ path: r, data: await readText(path.join(stage.payloadRoot, r)) });
      }
    };
    await walk('payload');
    const pkg = buildPkg('0.3.0', { edit: (files) => [...files, ...extra] });
    const w: World = {
      dir: sw.dir,
      home: sw.home,
      reg: path.join(sw.dir, 'reg'),
      io: sw.io,
      fx: sw.io,
      env: {
        KIT_TMP: sw.dir,
        PATH: '/usr/bin:/bin',
        KIT_UPDATE_REGISTRY: `file://${path.join(sw.dir, 'reg')}`,
      },
    };
    await safe.mkdirp(sw.io, w.reg);
    await writeRegistry(w, { versions: [{ pkg }], distTags: { latest: '0.3.0' } });
    return { w, sw, pkg };
  }

  it('安装成功后在锁内评估并应用:技能文件更新为 v2,state.last_auto_sync=applied,可回滚', async () => {
    const { w, sw } = await scene('wk-as-ok-');
    const r = await runWorker(w);
    expect(r).toEqual({ code: 0, err: '' });
    const st = await stateOf(w);
    expect(st['installed'].version).toBe('0.3.0');
    expect(st['last_auto_sync']).toMatchObject({ outcome: 'applied' });
    expect(await sw.read('.claude/skills/commit-checklist/SKILL.md')).toContain('v2');
    const rb = await sw.run(['--write', '--rollback', st['last_auto_sync'].txn_id]);
    expect(rb.code).toBe(0);
    expect(await sw.read('.claude/skills/commit-checklist/SKILL.md')).toContain('v1');
    // 两把锁都已释放
    const t = (await treeOf(w.home)).join('\n');
    expect(t).not.toMatch(/(update|sync)\/lock/);
  });

  it('KIT_AUTO_SYNC=0 / config auto_sync=off → 安装照常、不评估、不留 last_auto_sync', async () => {
    for (const mode of ['env', 'config']) {
      const { w, sw } = await scene(`wk-as-off-${mode}-`);
      if (mode === 'config') {
        await put(
          w,
          path.join(w.home, '.config/agent-kit/config.toml'),
          '[update]\nauto_sync = "off"\n',
        );
      }
      await runWorker(w, { env: mode === 'env' ? { KIT_AUTO_SYNC: '0' } : {} });
      const st = await stateOf(w);
      expect(st['installed'].version).toBe('0.3.0');
      expect(st['last_auto_sync']).toBeUndefined();
      expect(await sw.read('.claude/skills/commit-checklist/SKILL.md')).toContain('v1');
    }
  });

  it('自动同步被拒(payload 含 must 原子)→ 安装仍成功,last_auto_sync=declined must_atom,文件不动', async () => {
    const { w, sw } = await scene('wk-as-must-', (f) =>
      f.map((x) => (x.path.endsWith('SKILL.md') ? { ...x, must: true } : x)),
    );
    await runWorker(w);
    const st = await stateOf(w);
    expect(st['installed'].version).toBe('0.3.0');
    expect(st['last_auto_sync']).toMatchObject({ outcome: 'declined', reasons: ['must_atom'] });
    expect(await sw.read('.claude/skills/commit-checklist/SKILL.md')).toContain('v1');
  });

  it('没有手动 sync 过(无登记表)→ declined not_installed,绝不首次安装', async () => {
    const { w, sw } = await scene('wk-as-first-');
    // 抹掉登记表与已装文件,模拟「从没 sync 过」
    await safe.remove(sw.io, path.join(w.home, '.local/state/agent-kit/sync/ledger.json'));
    await runWorker(w);
    expect((await stateOf(w))['last_auto_sync']).toMatchObject({
      outcome: 'declined',
      reasons: ['not_installed'],
    });
  });

  it('自动同步抛错不改变已提交的安装结果,也不 markBad', async () => {
    const { w } = await scene('wk-as-throw-');
    await runWorker(w, {
      deps: {
        sync: {
          inject: (p) => {
            if (p === 'journal-written') throw new Error('boom');
          },
        },
      },
    });
    const st = await stateOf(w);
    expect(st['installed'].version).toBe('0.3.0');
    expect(st['bad_versions']).toEqual([]);
    expect(st['last_auto_sync']).toMatchObject({ outcome: 'failed' });
  });
});

void sha256;
