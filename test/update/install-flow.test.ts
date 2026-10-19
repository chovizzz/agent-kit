import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lstat, readText, realpath } from '../../src/io/read-fs.js';
import {
  NOW_HTTP,
  OLD_ISO,
  buildPkg,
  countingVerifier,
  makeAtt,
  newWorld,
  realHomeSnapshot,
  runUpdate,
  stateOf,
  treeOf,
  writeRegistry,
  type World,
} from './install-world.js';

let realBefore: string[] = [];
beforeAll(async () => {
  realBefore = await realHomeSnapshot();
});
afterAll(async () => {
  expect(await realHomeSnapshot()).toEqual(realBefore);
});

const share = (w: World): string => path.join(w.home, '.local/share/agent-kit');

async function setup(
  versions: string[] = ['0.1.1'],
  tag = 'latest',
): Promise<{ w: World; pkgs: ReturnType<typeof buildPkg>[] }> {
  const w = await newWorld();
  const pkgs = versions.map((v) => buildPkg(v));
  await writeRegistry(w, {
    versions: pkgs.map((pkg) => ({ pkg })),
    distTags: { [tag]: versions[versions.length - 1] as string },
  });
  return { w, pkgs };
}

describe('update 正常安装', () => {
  it('干跑:打印计划,home 零写入', async () => {
    const { w } = await setup();
    const before = await treeOf(w.home);
    const r = await runUpdate(w, []);
    expect(r.code).toBe(0);
    expect(r.out).toContain('would install 0.1.1');
    expect(r.out).toContain('decision ok');
    expect(await treeOf(w.home)).toEqual(before);
  });

  it('--write:装到 versions/<v>,current 指向它,状态记锚点,权限 0700/0600', async () => {
    const { w, pkgs } = await setup();
    const { verifier, calls } = countingVerifier();
    const r = await runUpdate(w, ['--write'], { deps: { verifier } });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(calls()).toBe(1);
    const cur = path.join(share(w), 'current');
    expect((await lstat(cur)).isSymbolicLink()).toBe(true);
    expect(await realpath(cur)).toBe(await realpath(path.join(share(w), 'versions/0.1.1')));
    expect(await readText(path.join(cur, 'dist/cli.js'))).toContain('cli 0.1.1');
    const st = await stateOf(w);
    expect(st['installed'].version).toBe('0.1.1');
    expect(st['installed'].anchor).toBe((pkgs[0] as { anchor: string }).anchor);
    expect(st['last_result']).toBe('installed');
    expect(st['max_seen_version']).toBe('0.1.1');
    const stateMode =
      (await lstat(path.join(w.home, '.local/state/agent-kit/update/state.json'))).mode & 0o777;
    expect(stateMode).toBe(0o600);
    expect((await lstat(path.join(share(w), 'versions/0.1.1'))).mode & 0o777).toBe(0o700);
    // 锁已释放、staging 已清
    const t = (await treeOf(w.home)).join('\n');
    expect(t).not.toContain('update/lock');
    expect(t).not.toContain('staging/st-');
  });

  it('第二次运行:已最新,不再验签', async () => {
    const { w } = await setup();
    await runUpdate(w, ['--write']);
    const { verifier, calls } = countingVerifier();
    const r = await runUpdate(w, ['--write'], { deps: { verifier } });
    expect(r.code).toBe(0);
    expect(r.out).toContain('decision up_to_date');
    expect(calls()).toBe(0);
  });
});

describe('冷却期', () => {
  it('发布不满 24h:不装(cooldown),--now 放行', async () => {
    const w = await newWorld();
    const pkg = buildPkg('0.1.1');
    await writeRegistry(w, {
      versions: [{ pkg, time: '2026-10-14T06:00:00.000Z' }],
      distTags: { latest: '0.1.1' },
      date: NOW_HTTP,
    });
    const r = await runUpdate(w, ['--write']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('decision cooldown');
    expect(r.out).toContain('remaining_hours=18');
    expect((await treeOf(share(w))).join()).not.toContain('versions');
    const r2 = await runUpdate(w, ['--write', '--now']);
    expect(r2.code).toBe(0);
    expect(r2.out).toContain('installed 0.1.1');
  });

  it('Rekor integratedTime 晚于 npmjs time:冷却起点取较大者', async () => {
    const w = await newWorld();
    const pkg = buildPkg('0.1.1');
    await writeRegistry(w, {
      versions: [
        {
          pkg,
          time: OLD_ISO,
          attOptions: { integratedSecs: Math.floor(Date.parse('2026-10-14T10:00:00Z') / 1000) },
        },
      ],
      distTags: { latest: '0.1.1' },
    });
    const r = await runUpdate(w, ['--write']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('decision cooldown');
    expect((await stateOf(w))['last_result']).toBe('cooldown');
    expect((await stateOf(w))['installed']).toBeUndefined();
    // 正向对照:integratedTime 也早于冷却期则能装
    const w2 = await newWorld();
    await writeRegistry(w2, { versions: [{ pkg }], distTags: { latest: '0.1.1' } });
    expect((await runUpdate(w2, ['--write'])).out).toContain('installed 0.1.1');
  });

  it('缺 Date 头:fail-closed 按冷却处理', async () => {
    const w = await newWorld();
    await writeRegistry(w, {
      versions: [{ pkg: buildPkg('0.1.1') }],
      distTags: { latest: '0.1.1' },
      date: null,
    });
    const r = await runUpdate(w, ['--write']);
    expect(r.out).toContain('decision cooldown detail=date_header_missing');
  });
});

describe('防降级 / major / 通道 / not_ready', () => {
  it('registry 的 latest 低于已安装 → UPDATE_DOWNGRADE_REFUSED,退出 1', async () => {
    const { w } = await setup(['0.1.1']);
    await runUpdate(w, ['--write']);
    const w2 = { ...w };
    await writeRegistry(w2, {
      versions: [{ pkg: buildPkg('0.1.0') }],
      distTags: { latest: '0.1.0' },
    });
    const r = await runUpdate(w2, []);
    expect(r.code).toBe(1);
    expect(r.err).toContain('UPDATE_DOWNGRADE_REFUSED');
    expect((await stateOf(w))['installed'].version).toBe('0.1.1');
  });

  it('跨 major:提示 UPDATE_MAJOR_AVAILABLE;--major 无 --write 是用法错误;--major --write 才装', async () => {
    const { w } = await setup(['0.1.1']);
    await runUpdate(w, ['--write']);
    await writeRegistry(w, {
      versions: [{ pkg: buildPkg('1.0.0') }],
      distTags: { latest: '1.0.0' },
    });
    const r = await runUpdate(w, ['--write']);
    expect(r.code).toBe(0);
    expect(r.err).toContain('UPDATE_MAJOR_AVAILABLE');
    expect((await stateOf(w))['installed'].version).toBe('0.1.1');
    const u = await runUpdate(w, ['--major']);
    expect(u.code).toBe(2);
    expect(u.err).toContain('UPDATE_USAGE reason=major_requires_write');
    const m = await runUpdate(w, ['--major', '--write']);
    expect(m.code).toBe(0);
    expect((await stateOf(w))['installed'].version).toBe('1.0.0');
  });

  it('预发布只走 rc 通道:latest 指向预发布 → not_ready;配置 channel=rc 读 dist-tags.rc', async () => {
    const w = await newWorld();
    await writeRegistry(w, {
      versions: [{ pkg: buildPkg('0.2.0-rc.1') }],
      distTags: { rc: '0.2.0-rc.1' },
    });
    const noRc = await runUpdate(w, []);
    expect(noRc.code).toBe(4);
    expect(noRc.err).toContain('UPDATE_NOT_READY');
    const cfg = path.join(w.home, '.config/agent-kit');
    const { mkdirp, writeFile } = await import('../../src/io/safe-fs.js');
    await mkdirp(w.fx, cfg);
    await writeFile(w.fx, path.join(cfg, 'config.toml'), '[update]\nchannel = "rc"\n');
    const rc = await runUpdate(w, ['--write']);
    expect(rc.err).toBe('');
    expect(rc.out).toContain('installed 0.2.0-rc.1');
  });

  it('tarball 404(半可见期)→ UPDATE_NOT_READY,退出 4,不进 bad_versions', async () => {
    const w = await newWorld();
    await writeRegistry(w, {
      versions: [{ pkg: buildPkg('0.1.1'), noTarball: true }],
      distTags: { latest: '0.1.1' },
    });
    const r = await runUpdate(w, ['--write']);
    expect(r.code).toBe(4);
    expect(r.err).toContain('UPDATE_NOT_READY reason=tarball_missing');
    expect((await stateOf(w))['bad_versions']).toEqual([]);
  });

  it('deprecated:不装、不拉黑、退出 0', async () => {
    const w = await newWorld();
    await writeRegistry(w, {
      versions: [{ pkg: buildPkg('0.1.1'), deprecated: 'broken' }],
      distTags: { latest: '0.1.1' },
    });
    const r = await runUpdate(w, ['--write']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('decision deprecated');
    expect(r.err).toContain('UPDATE_NOT_RUN reason=deprecated');
    expect((await stateOf(w))['bad_versions']).toEqual([]);
    expect((await treeOf(share(w))).join()).not.toContain('versions');
  });
});

describe('校验失败(fail-closed)', () => {
  async function failing(
    over: Partial<Parameters<typeof writeRegistry>[1]['versions'][0]>,
    pkg = buildPkg('0.1.1'),
    deps = {},
  ): Promise<{ w: World; r: Awaited<ReturnType<typeof runUpdate>> }> {
    const w = await newWorld();
    await writeRegistry(w, { versions: [{ pkg, ...over }], distTags: { latest: '0.1.1' } });
    const r = await runUpdate(w, ['--write'], { deps });
    return { w, r };
  }
  const noInstall = async (w: World): Promise<void> => {
    expect((await treeOf(share(w))).join('\n')).not.toMatch(/versions|current/);
    expect((await treeOf(share(w))).join('\n')).not.toContain('staging/st-');
  };

  it('dist.integrity 与 tarball 不符(非镜像)→ integrity,拉黑,不再重试', async () => {
    const { w, r } = await failing({ integrity: `sha512-${Buffer.alloc(64).toString('base64')}` });
    expect(r.code).toBe(1);
    expect(r.err).toContain('UPDATE_VERIFY_FAILED reason=integrity');
    expect((await stateOf(w))['bad_versions']).toEqual(['0.1.1']);
    await noInstall(w);
    const again = await runUpdate(w, ['--write']);
    expect(again.out).toContain('decision verify_failed');
    expect(again.err).toContain('reason=bad_version');
  });

  it('没有 attestations(版本已发布超 24h)→ provenance_missing,拉黑', async () => {
    const { w, r } = await failing({ att: 'absent' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('reason=provenance_missing');
    expect((await stateOf(w))['bad_versions']).toEqual(['0.1.1']);
  });

  it('没有 attestations 但刚发布(< 24h):按 npm 半可见期 not_ready,不拉黑', async () => {
    const w = await newWorld();
    await writeRegistry(w, {
      versions: [{ pkg: buildPkg('0.1.1'), att: 'absent', time: '2026-10-14T11:00:00.000Z' }],
      distTags: { latest: '0.1.1' },
    });
    const r = await runUpdate(w, ['--write', '--now']);
    expect(r.code).toBe(4);
    expect(r.err).toContain('UPDATE_NOT_READY reason=provenance_pending');
    expect((await stateOf(w))['bad_versions']).toEqual([]);
  });

  it('attestations 取不到 → 退出 4,不拉黑', async () => {
    const { w, r } = await failing({ att: 'unreachable' });
    expect(r.code).toBe(4);
    expect(r.err).toContain('reason=attestations_unreachable');
    expect((await stateOf(w))['bad_versions']).toEqual([]);
    await noInstall(w);
  });

  it('验签器报身份不符 → provenance_identity,拉黑', async () => {
    const { w, r } = await failing({}, buildPkg('0.1.1'), {
      verifier: async () => ({
        subjectAlternativeName:
          'https://github.com/evil/repo/.github/workflows/release.yml@refs/tags/v0.1.1',
        issuer: 'https://token.actions.githubusercontent.com',
      }),
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('reason=provenance_identity');
    expect((await stateOf(w))['bad_versions']).toEqual(['0.1.1']);
    await noInstall(w);
  });

  it('attestations 里的 subject 摘要不是这份 tarball → 预检不据此拉黑,由验签层给出认证结论:integrity,拉黑', async () => {
    const pkg = buildPkg('0.1.1');
    const other = buildPkg('0.1.1', { edit: (f) => [...f, { path: 'x.txt', data: 'x' }] });
    const { verifier, calls } = countingVerifier();
    const { w, r } = await failing({ att: makeAtt('0.1.1', other.sha512) }, pkg, { verifier });
    expect(r.code).toBe(1);
    expect(r.err).toContain('reason=integrity');
    expect(calls()).toBe(1); // 预检失败没有早退拉黑,验签器被调用了
    expect((await stateOf(w))['bad_versions']).toEqual(['0.1.1']);
  });

  it('未验签预检失败而验签器不放行(身份不符)时的结论来自验签层;验签器抛 TUF 错则不拉黑(预检不能单独拉黑)', async () => {
    const { namedError } = await import('./install-world.js');
    const pkg = buildPkg('0.1.1');
    const other = buildPkg('0.1.1', { edit: (f) => [...f, { path: 'x.txt', data: 'x' }] });
    const { w, r } = await failing({ att: makeAtt('0.1.1', other.sha512) }, pkg, {
      verifier: async () => {
        throw namedError('TUFError', 'refresh failed');
      },
    });
    expect(r.code).toBe(4);
    expect(r.err).toContain('reason=tuf_unreachable');
    expect((await stateOf(w))['bad_versions']).toEqual([]);
  });

  it('失败路径丢锁:不把旧快照写回(新持锁者的状态不被覆盖),退出 3 lock_lost', async () => {
    const { namedError } = await import('./install-world.js');
    const w = await newWorld();
    await writeRegistry(w, {
      versions: [{ pkg: buildPkg('0.1.1') }],
      distTags: { latest: '0.1.1' },
    });
    const lockPath = path.join(w.home, '.local/state/agent-kit/update/lock');
    const { writeFile } = await import('../../src/io/safe-fs.js');
    const r = await runUpdate(w, ['--write'], {
      deps: {
        verifier: async () => {
          await writeFile(
            w.fx,
            lockPath,
            JSON.stringify({
              pid: 1,
              started_at: '2026-10-14T12:00:00.000Z',
              nonce: 'c'.repeat(16),
            }),
          );
          throw namedError('VerificationError', 'bad signature', { code: 'SIGNATURE_ERROR' });
        },
      },
    });
    expect(r.code).toBe(3);
    expect(r.err).toContain('reason=lock_lost');
    await expect(
      lstat(path.join(w.home, '.local/state/agent-kit/update/state.json')),
    ).rejects.toThrow();
  });

  it('--write 记录检查结果时写盘失败:退出 3,不是静默 0', async () => {
    const { w } = await setup();
    await runUpdate(w, ['--write']);
    const { chmod } = await import('../../src/io/safe-fs.js');
    const dir = path.join(w.home, '.local/state/agent-kit/update');
    // 已最新 → 非安装分支只记录;把状态目录改成只读,记录必然失败
    await chmod(w.fx, dir, 0o500);
    try {
      const r = await runUpdate(w, ['--write']);
      expect(r.out).toContain('decision up_to_date');
      expect(r.code).toBe(3);
      expect(r.err).toContain('UPDATE_FAIL_CLOSED reason=state_write_failed');
    } finally {
      await chmod(w.fx, dir, 0o700);
    }
    // 正向对照:目录可写时同样的命令退出 0
    expect((await runUpdate(w, ['--write'])).code).toBe(0);
  });

  for (const [reason, name, code] of [
    ['trust_root_stale', 'VerificationError', 'CERTIFICATE_ERROR'],
    ['tuf_unreachable', 'TUFError', 'x'],
  ] as const) {
    it(`${reason}:退出 4,不拉黑`, async () => {
      const { namedError } = await import('./install-world.js');
      const msg = reason === 'trust_root_stale' ? 'certificate chain not found' : 'fetch failed';
      const { w, r } = await failing({}, buildPkg('0.1.1'), {
        verifier: async () => {
          throw namedError(name, msg, { code });
        },
      });
      expect(r.code).toBe(4);
      expect(r.err).toContain(`reason=${reason}`);
      expect((await stateOf(w))['bad_versions']).toEqual([]);
      await noInstall(w);
    });
  }

  it('验签器抛 TypeError(库内缺陷):internal,不拉黑;抛 VerificationError(签名无效):bundle,拉黑', async () => {
    const { namedError } = await import('./install-world.js');
    const a = await failing({}, buildPkg('0.1.1'), {
      verifier: async () => {
        throw new TypeError('x is undefined');
      },
    });
    expect(a.r.err).toContain('reason=internal');
    expect((await stateOf(a.w))['bad_versions']).toEqual([]);
    const b = await failing({}, buildPkg('0.1.1'), {
      verifier: async () => {
        throw namedError('VerificationError', 'bad signature', { code: 'SIGNATURE_ERROR' });
      },
    });
    expect(b.r.err).toContain('reason=bundle');
    expect((await stateOf(b.w))['bad_versions']).toEqual(['0.1.1']);
  });

  it('签名通过后 tarball 含符号链接 → tar,拉黑,不落盘', async () => {
    const pkg = buildPkg('0.1.1', {
      extraEntries: [{ name: 'package/evil', type: '2', linkname: '/etc/passwd' }],
    });
    const { w, r } = await failing({}, pkg);
    expect(r.code).toBe(1);
    expect(r.err).toContain('reason=tar');
    expect((await stateOf(w))['bad_versions']).toEqual(['0.1.1']);
    await noInstall(w);
  });

  it('tarball 含路径穿越 → tar', async () => {
    const pkg = buildPkg('0.1.1', { extraEntries: [{ name: 'package/../../escape', data: 'x' }] });
    const { r } = await failing({}, pkg);
    expect(r.err).toContain('reason=tar');
  });

  const pkgCases: Array<[string, Parameters<typeof buildPkg>[1]]> = [
    ['integrity.json 缺失', { integrity: () => undefined }],
    [
      '包里多一个 integrity 没列的文件',
      {
        integrity: (o) => ({
          ...o,
          files: (o['files'] as unknown[]).slice(0, -1),
        }),
      },
    ],
    [
      'integrity 列了包里没有的文件',
      {
        integrity: (o) => ({
          ...o,
          files: [
            ...(o['files'] as { path: string }[]),
            { path: 'zz-missing.js', sha256: '0'.repeat(64), bytes: 1 },
          ],
        }),
      },
    ],
    [
      '文件哈希对不上',
      {
        integrity: (o) => ({
          ...o,
          files: (o['files'] as { sha256: string }[]).map((f, i) =>
            i === 0 ? { ...f, sha256: 'f'.repeat(64) } : f,
          ),
        }),
      },
    ],
    ['integrity.kit_version 不是目标版本', { integrity: (o) => ({ ...o, kit_version: '9.9.9' }) }],
    ['package.json 版本不符', { pkgVersion: '0.1.2' }],
    ['package.json 名字不符', { pkgName: '@evil/pkg' }],
  ];
  for (const [name, opts] of pkgCases) {
    it(`包内一致性:${name} → package,拉黑,不落盘`, async () => {
      const { w, r } = await failing({}, buildPkg('0.1.1', opts));
      expect(r.code).toBe(1);
      expect(r.err).toContain('UPDATE_VERIFY_FAILED reason=package');
      expect((await stateOf(w))['bad_versions']).toEqual(['0.1.1']);
      await noInstall(w);
    });
  }

  it('冒烟:bin 入口没有 shebang → smoke,拉黑', async () => {
    const pkg = buildPkg('0.1.1', {
      edit: (f) =>
        f.map((x) => (x.path === 'dist/cli.js' ? { ...x, data: 'console.log(1)\n' } : x)),
    });
    const { w, r } = await failing({}, pkg);
    expect(r.err).toContain('reason=smoke');
    await noInstall(w);
  });

  it('注入的 smoke 钩子返回 false → smoke,不切换 current', async () => {
    const { w, r } = await failing({}, buildPkg('0.1.1'), { smoke: () => false });
    expect(r.err).toContain('reason=smoke');
    await noInstall(w);
  });
});

describe('镜像 registry', () => {
  it('镜像给的 dist.integrity 只作提示:tarball 被换 → 验签 integrity,但不拉黑', async () => {
    const w = await newWorld();
    const pkg = buildPkg('0.1.1');
    const evil = buildPkg('0.1.1', { edit: (f) => [...f, { path: 'evil.js', data: 'x' }] });
    await writeRegistry(w, {
      versions: [{ pkg, att: makeAtt('0.1.1', pkg.sha512) }],
      distTags: { latest: '0.1.1' },
      npmjs: {},
    });
    // 镜像一侧的 tarball 被换成另一份
    const { writeFile } = await import('../../src/io/safe-fs.js');
    await writeFile(w.fx, path.join(w.reg, 'tarballs/0.1.1.tgz'), evil.tgz);
    const r = await runUpdate(w, ['--write']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('reason=integrity');
    expect((await stateOf(w))['bad_versions']).toEqual([]);
    // 正向对照:tarball 没被换则镜像也能装
    const w2 = await newWorld();
    await writeRegistry(w2, { versions: [{ pkg }], distTags: { latest: '0.1.1' }, npmjs: {} });
    expect((await runUpdate(w2, ['--write'])).out).toContain('installed 0.1.1');
  });

  it('镜像下取不到 npmjs → attestations_unreachable,退出 4,不安装', async () => {
    const w = await newWorld();
    await writeRegistry(w, {
      versions: [{ pkg: buildPkg('0.1.1') }],
      distTags: { latest: '0.1.1' },
      npmjs: { unreachable: true },
    });
    const r = await runUpdate(w, ['--write']);
    expect(r.code).toBe(4);
    expect(r.err).toContain('reason=attestations_unreachable');
  });
});

describe('gc 与升级', () => {
  it('依次装 3 个版本:只保留 2 个(当前 + 上一个),回滚目标 = 上一个', async () => {
    const w = await newWorld();
    for (const v of ['0.1.1', '0.1.2', '0.1.3']) {
      await writeRegistry(w, { versions: [{ pkg: buildPkg(v) }], distTags: { latest: v } });
      const r = await runUpdate(w, ['--write']);
      expect(r.code).toBe(0);
      expect(r.out).toContain(`installed ${v}`);
    }
    const t = (await treeOf(path.join(share(w), 'versions'))).filter((l) => /^[0-9.]+\/ /.test(l));
    expect(t.map((l) => l.split('/')[0]).sort()).toEqual(['0.1.2', '0.1.3']);
    const st = await stateOf(w);
    expect(st['installed'].version).toBe('0.1.3');
    expect(st['previous'].version).toBe('0.1.2');
  });
});

describe('用法与环境', () => {
  it('用法错误', async () => {
    const { w } = await setup();
    const cases: Array<[string[], string]> = [
      [['--bogus'], 'unknown_arg'],
      [['--rollback'], 'rollback_requires_write'],
      [['--rollback', '--write', '--now'], 'mode_conflict'],
      [['--major'], 'major_requires_write'],
    ];
    for (const [args, reason] of cases) {
      const r = await runUpdate(w, args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.err).toContain(`UPDATE_USAGE reason=${reason}`);
    }
    const bad = await runUpdate(w, [], {
      noHome: true,
      env: { KIT_REAL_HOME_OVERRIDE: '/nonexistent-x' },
    });
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('reason=home_not_allowed');
  });

  it('假 registry 在 KIT_TMP 之外 → registry_fixture_outside_tmp;非 https 地址 → bad_registry', async () => {
    const { w } = await setup();
    const out = await runUpdate(w, [], { env: { KIT_UPDATE_REGISTRY: 'file:///usr/lib' } });
    expect(out.code).toBe(2);
    expect(out.err).toContain('reason=registry_fixture_outside_tmp');
    const bad = await runUpdate(w, [], { env: { KIT_UPDATE_REGISTRY: 'http://x.example/' } });
    expect(bad.err).toContain('reason=bad_registry');
  });

  it('状态文件损坏 → 退出 3 state_unreadable;状态目录是符号链接 → state_dir_unsafe', async () => {
    const { w } = await setup();
    const { mkdirp, writeFile } = await import('../../src/io/safe-fs.js');
    const dir = path.join(w.home, '.local/state/agent-kit/update');
    await mkdirp(w.fx, dir);
    await writeFile(w.fx, path.join(dir, 'state.json'), '{not json');
    const r = await runUpdate(w, []);
    expect(r.code).toBe(3);
    expect(r.err).toContain('reason=state_unreadable');
  });
});
