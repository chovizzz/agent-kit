import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lstat, readDir, realpath } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import {
  buildPkg,
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

async function install(w: World, v: string): Promise<void> {
  await writeRegistry(w, { versions: [{ pkg: buildPkg(v) }], distTags: { latest: v } });
  const r = await runUpdate(w, ['--write']);
  expect(r.code, r.err).toBe(0);
}

async function currentTarget(w: World): Promise<string> {
  return path.basename(await realpath(path.join(share(w), 'current')));
}

describe('回滚', () => {
  it('切回上一版本,当前版本进 bad_versions,max_seen 不降,之后不会自动装回', async () => {
    const w = await newWorld();
    await install(w, '0.1.1');
    await install(w, '0.1.2');
    expect(await currentTarget(w)).toBe('0.1.2');
    const r = await runUpdate(w, ['--rollback', '--write']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('did rollback from=0.1.2 to=0.1.1');
    expect(await currentTarget(w)).toBe('0.1.1');
    const st = await stateOf(w);
    expect(st['installed'].version).toBe('0.1.1');
    expect(st['previous']).toBeUndefined();
    expect(st['bad_versions']).toEqual(['0.1.2']);
    expect(st['max_seen_version']).toBe('0.1.2');
    // registry 的 latest 仍是 0.1.2:不再自动装回
    const again = await runUpdate(w, ['--write']);
    expect(again.out).toContain('decision verify_failed');
    expect(await currentTarget(w)).toBe('0.1.1');
  });

  it('没有 previous → UPDATE_NOT_RUN reason=no_previous,退出 4,current 不变', async () => {
    const w = await newWorld();
    await install(w, '0.1.1');
    const r = await runUpdate(w, ['--rollback', '--write']);
    expect(r.code).toBe(4);
    expect(r.err).toContain('reason=no_previous');
    expect(await currentTarget(w)).toBe('0.1.1');
  });

  it('上一版本目录被篡改 → 不切(完整树校验),退出 3,current 仍指向当前版本', async () => {
    const w = await newWorld();
    await install(w, '0.1.1');
    await install(w, '0.1.2');
    // 不动 integrity.json(锚点仍然匹配),只改另一个文件
    await safe.writeFile(w.fx, path.join(share(w), 'versions/0.1.1/dist/main.js'), 'tampered');
    const r = await runUpdate(w, ['--rollback', '--write']);
    expect(r.code).toBe(3);
    expect(r.err).toContain('UPDATE_CURRENT_BROKEN');
    expect(r.err).toContain('reason=previous_invalid');
    expect(await currentTarget(w)).toBe('0.1.2');
    expect((await stateOf(w))['installed'].version).toBe('0.1.2');
  });

  it('上一版本目录里多了文件 → 同样拒绝', async () => {
    const w = await newWorld();
    await install(w, '0.1.1');
    await install(w, '0.1.2');
    await safe.writeFile(w.fx, path.join(share(w), 'versions/0.1.1/extra.js'), 'x');
    const r = await runUpdate(w, ['--rollback', '--write']);
    expect(r.code).toBe(3);
    expect(r.err).toContain('reason=previous_invalid');
  });

  it('上一版本目录不存在 → 退出 4 previous_missing', async () => {
    const w = await newWorld();
    await install(w, '0.1.1');
    await install(w, '0.1.2');
    await safe.remove(w.fx, path.join(share(w), 'versions/0.1.1'));
    const r = await runUpdate(w, ['--rollback', '--write']);
    expect(r.code).toBe(4);
    expect(r.err).toContain('reason=previous_missing');
  });

  it('回滚零网络:registry 目录不存在也能回滚', async () => {
    const w = await newWorld();
    await install(w, '0.1.1');
    await install(w, '0.1.2');
    const r = await runUpdate(w, ['--rollback', '--write'], {
      env: { KIT_UPDATE_REGISTRY: `file://${path.join(w.dir, 'does-not-exist')}` },
    });
    expect(r.code).toBe(0);
  });
});

describe('current 与状态的一致性', () => {
  it('写状态失败 → current 切回原版本,退出 3,新版本不被登记', async () => {
    const w = await newWorld();
    await install(w, '0.1.1');
    await writeRegistry(w, {
      versions: [{ pkg: buildPkg('0.1.2') }],
      distTags: { latest: '0.1.2' },
    });
    const r = await runUpdate(w, ['--write'], {
      deps: {
        inject: (p) => {
          if (p === 'before-state-write') throw new Error('disk full');
        },
      },
    });
    expect(r.code).toBe(3);
    expect(r.err).toContain('UPDATE_FAIL_CLOSED reason=io_error');
    expect(await currentTarget(w)).toBe('0.1.1');
    expect((await stateOf(w))['installed'].version).toBe('0.1.1');
    // 正向对照:同一份 registry,不注入故障则正常升级
    const ok = await runUpdate(w, ['--write']);
    expect(ok.code).toBe(0);
    expect(await currentTarget(w)).toBe('0.1.2');
  });

  it('切换瞬间临时链接被换成指向 versions 之外:切换后复核发现,current 切回原版本,退出 3', async () => {
    const w = await newWorld();
    await install(w, '0.1.1');
    await writeRegistry(w, {
      versions: [{ pkg: buildPkg('0.1.2') }],
      distTags: { latest: '0.1.2' },
    });
    await safe.mkdirp(w.fx, path.join(w.dir, 'outside'));
    let fired = false; // 只攻击第一次切换;回切不再被破坏
    const r = await runUpdate(w, ['--write'], {
      deps: {
        onStage: async () => {
          if (fired) return;
          const tmp = (await readDir(share(w))).find((e) => e.name.startsWith('.current.tmp-'));
          if (tmp === undefined) return;
          fired = true;
          const abs = path.join(share(w), tmp.name);
          await safe.remove(w.fx, abs);
          await safe.symlink(w.fx, path.join(w.dir, 'outside'), abs);
        },
      },
    });
    expect(r.code).toBe(3);
    expect(r.err).toContain('UPDATE_FAIL_CLOSED reason=write_denied');
    expect(await currentTarget(w)).toBe('0.1.1');
    expect((await stateOf(w))['installed'].version).toBe('0.1.1');
  });

  it('首次安装写状态失败 → current 被撤掉(不留未登记的版本)', async () => {
    const w = await newWorld();
    await writeRegistry(w, {
      versions: [{ pkg: buildPkg('0.1.1') }],
      distTags: { latest: '0.1.1' },
    });
    const r = await runUpdate(w, ['--write'], {
      deps: {
        inject: (p) => {
          if (p === 'before-state-write') throw new Error('disk full');
        },
      },
    });
    expect(r.code).toBe(3);
    await expect(lstat(path.join(share(w), 'current'))).rejects.toThrow();
  });

  it('崩溃残留的 staging 在下一次安装时被清掉', async () => {
    const w = await newWorld();
    await writeRegistry(w, {
      versions: [{ pkg: buildPkg('0.1.1') }],
      distTags: { latest: '0.1.1' },
    });
    const crash = await runUpdate(w, ['--write'], {
      deps: {
        inject: (p) => {
          if (p === 'after-staging-write') throw new Error('killed');
        },
      },
    });
    expect(crash.code).toBe(3);
    // 失败路径自己也会清;再手工造一个残留,验证"下一次安装"清理
    await safe.mkdirp(w.fx, path.join(share(w), 'staging/st-deadbeef/dist'));
    await safe.writeFile(w.fx, path.join(share(w), 'staging/st-deadbeef/dist/x.js'), 'x');
    const ok = await runUpdate(w, ['--write']);
    expect(ok.code).toBe(0);
    expect((await treeOf(share(w))).join('\n')).not.toContain('st-deadbeef');
  });

  it('versions/<v> 有同名残留(不是 current)→ 清掉后正常安装', async () => {
    const w = await newWorld();
    await safe.mkdirp(w.fx, path.join(share(w), 'versions/0.1.1'));
    await safe.writeFile(w.fx, path.join(share(w), 'versions/0.1.1/junk'), 'junk');
    await writeRegistry(w, {
      versions: [{ pkg: buildPkg('0.1.1') }],
      distTags: { latest: '0.1.1' },
    });
    const r = await runUpdate(w, ['--write']);
    expect(r.code, r.err).toBe(0);
    expect((await treeOf(share(w))).join('\n')).not.toContain('versions/0.1.1/junk');
  });

  it('current 已是指向 versions 之外的符号链接 → 被覆盖成合法目标(自愈)', async () => {
    const w = await newWorld();
    await safe.mkdirp(w.fx, share(w));
    await safe.mkdirp(w.fx, path.join(w.dir, 'outside'));
    await safe.symlink(w.fx, path.join(w.dir, 'outside'), path.join(share(w), 'current'));
    await writeRegistry(w, {
      versions: [{ pkg: buildPkg('0.1.1') }],
      distTags: { latest: '0.1.1' },
    });
    const r = await runUpdate(w, ['--write']);
    expect(r.code, r.err).toBe(0);
    expect(await currentTarget(w)).toBe('0.1.1');
  });

  it('current 是普通目录 → 拒绝(不覆盖),退出 3', async () => {
    const w = await newWorld();
    await safe.mkdirp(w.fx, path.join(share(w), 'current'));
    await writeRegistry(w, {
      versions: [{ pkg: buildPkg('0.1.1') }],
      distTags: { latest: '0.1.1' },
    });
    const r = await runUpdate(w, ['--write']);
    expect(r.code).toBe(3);
    expect((await lstat(path.join(share(w), 'current'))).isDirectory()).toBe(true);
  });

  it('versions 本身是符号链接 → 拒绝,退出 3,链接另一侧什么都没写', async () => {
    const w = await newWorld();
    const outside = path.join(w.dir, 'outside');
    await safe.mkdirp(w.fx, outside);
    await safe.mkdirp(w.fx, share(w));
    await safe.symlink(w.fx, outside, path.join(share(w), 'versions'));
    await writeRegistry(w, {
      versions: [{ pkg: buildPkg('0.1.1') }],
      distTags: { latest: '0.1.1' },
    });
    const r = await runUpdate(w, ['--write']);
    expect(r.code).toBe(3);
    expect(await treeOf(outside)).toEqual([]);
  });
});
