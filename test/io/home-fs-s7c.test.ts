import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as hfs from '../../src/io/home-fs.js';
import { HOME_DENY, HomeExistsError, HomeWriteDeniedError } from '../../src/io/home-fs.js';
import { lstat, readDir, readText, realpath } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { makeTempDir, wideCtx } from '../helpers/tmp.js';

const SHARE = '.local/share/agent-kit';
const LOCK = '.local/state/agent-kit/update/lock';

async function setup(scope: string[]) {
  const { ctx, dir } = await makeTempDir('ak-hfs7-');
  const fx = wideCtx(dir);
  const home = path.join(dir, 'home');
  await safe.mkdirp(fx, home);
  const tmpDir = ctx.tmpDir ?? path.join(ctx.stateDir, 'test-tmp');
  return {
    dir,
    home,
    fx,
    mk: (s = scope) => hfs.createHomeFsContext({ home, planScope: s, tmpDir }),
  };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HomeWriteDeniedError) return e.code;
    if (e instanceof HomeExistsError) return 'EEXIST';
    throw e;
  }
  return 'ok';
}

describe('createExclusive', () => {
  it('创建一次;第二次 EEXIST 且原内容不变;权限按 opts', async () => {
    const s = await setup([LOCK]);
    await hfs.createExclusive(s.mk(), LOCK, 'one', { mode: 0o600, dirMode: 0o700 });
    expect(await code(hfs.createExclusive(s.mk(), LOCK, 'two'))).toBe('EEXIST');
    expect(await readText(path.join(s.home, LOCK))).toBe('one');
    expect((await lstat(path.join(s.home, LOCK))).mode & 0o777).toBe(0o600);
    expect((await lstat(path.join(s.home, '.local/state/agent-kit/update'))).mode & 0o777).toBe(
      0o700,
    );
  });

  it('目标是悬空符号链接 → 拒绝,不写到链接另一侧', async () => {
    const s = await setup([LOCK]);
    await safe.mkdirp(s.fx, path.join(s.home, '.local/state/agent-kit/update'));
    await safe.symlink(s.fx, path.join(s.dir, 'victim'), path.join(s.home, LOCK));
    expect(await code(hfs.createExclusive(s.mk(), LOCK, 'x'))).toBe(HOME_DENY.TARGET_SYMLINK);
    await expect(lstat(path.join(s.dir, 'victim'))).rejects.toThrow();
  });

  it('表外路径 / 计划外路径 / 中间段是链接 → 拒绝', async () => {
    const s = await setup([LOCK]);
    expect(() => s.mk(['.claude/CLAUDE.md'])).toThrow(/HOME_SCOPE_INVALID/);
    expect(await code(hfs.createExclusive(s.mk(), `${SHARE}/other`, 'x'))).toBe(
      HOME_DENY.OUT_OF_PLAN_SCOPE,
    );
    await safe.mkdirp(s.fx, path.join(s.home, '.local/state/agent-kit'));
    await safe.mkdirp(s.fx, path.join(s.dir, 'outside'));
    await safe.symlink(
      s.fx,
      path.join(s.dir, 'outside'),
      path.join(s.home, '.local/state/agent-kit/update'),
    );
    expect(await code(hfs.createExclusive(s.mk(), LOCK, 'x'))).toBe(HOME_DENY.INTERMEDIATE_SYMLINK);
  });
});

describe('renameDir', () => {
  const FROM = `${SHARE}/staging/st-1`;
  const TO = `${SHARE}/versions/1.0.0`;
  const scope = [`${FROM}/a.txt`, `${TO}/.s`];

  it('改名成功:内容随之,来源消失,上级目录隐式创建', async () => {
    const s = await setup(scope);
    await hfs.writeFile(s.mk(), `${FROM}/a.txt`, 'hello', { dirMode: 0o700 });
    await hfs.renameDir(s.mk(), FROM, TO);
    expect(await readText(path.join(s.home, TO, 'a.txt'))).toBe('hello');
    await expect(lstat(path.join(s.home, FROM))).rejects.toThrow();
  });

  it('目标已存在 → EEXIST,双方原样', async () => {
    const s = await setup(scope);
    await hfs.writeFile(s.mk(), `${FROM}/a.txt`, 'hello');
    await safe.mkdirp(s.fx, path.join(s.home, TO));
    expect(await code(hfs.renameDir(s.mk(), FROM, TO))).toBe('EEXIST');
    expect(await readText(path.join(s.home, FROM, 'a.txt'))).toBe('hello');
  });

  it('来源是符号链接 → 拒绝;目录条目本身(表里的 dir)不可改名', async () => {
    const s = await setup(scope);
    await safe.mkdirp(s.fx, path.join(s.home, SHARE, 'staging'));
    await safe.mkdirp(s.fx, path.join(s.dir, 'real'));
    await safe.symlink(s.fx, path.join(s.dir, 'real'), path.join(s.home, FROM));
    expect(await code(hfs.renameDir(s.mk(), FROM, TO))).toBe(HOME_DENY.TARGET_SYMLINK);
    expect(await code(hfs.renameDir(s.mk(), SHARE, `${SHARE}-x`))).not.toBe('ok');
  });
});

describe('switchCurrent', () => {
  const LINK = `${SHARE}/current`;
  const ver = (v: string) => `${SHARE}/versions/${v}`;

  async function withVersions(vs: string[]) {
    const s = await setup([LINK]);
    for (const v of vs) await safe.mkdirp(s.fx, path.join(s.home, ver(v)));
    return s;
  }

  it('首次创建、再次切换:链接串是相对的 versions/<v>,realpath 在 versions 内', async () => {
    const s = await withVersions(['1.0.0', '1.1.0']);
    await hfs.switchCurrent(s.mk(), '1.0.0');
    const link = path.join(s.home, LINK);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await realpath(link)).toBe(await realpath(path.join(s.home, ver('1.0.0'))));
    await hfs.switchCurrent(s.mk(), '1.1.0');
    expect(await realpath(link)).toBe(await realpath(path.join(s.home, ver('1.1.0'))));
    const names = (await readDir(path.join(s.home, SHARE))).map((e) => e.name);
    expect(names.filter((n) => n.startsWith('.current.tmp'))).toEqual([]);
  });

  it('版本号语法非法(路径穿越等)→ BAD_VERSION,current 不变', async () => {
    const s = await withVersions(['1.0.0']);
    await hfs.switchCurrent(s.mk(), '1.0.0');
    for (const bad of ['../x', '1.0', 'latest', '1.0.0/../..', '']) {
      expect(await code(hfs.switchCurrent(s.mk(), bad)), bad).toBe(HOME_DENY.BAD_VERSION);
    }
    expect(await realpath(path.join(s.home, LINK))).toBe(
      await realpath(path.join(s.home, ver('1.0.0'))),
    );
  });

  it('目标版本目录不存在 → ENOENT,current 不变;目标是符号链接 → 拒绝', async () => {
    const s = await withVersions(['1.0.0']);
    await hfs.switchCurrent(s.mk(), '1.0.0');
    await expect(hfs.switchCurrent(s.mk(), '2.0.0')).rejects.toMatchObject({ message: 'ENOENT' });
    await safe.mkdirp(s.fx, path.join(s.dir, 'elsewhere'));
    await safe.symlink(s.fx, path.join(s.dir, 'elsewhere'), path.join(s.home, ver('3.0.0')));
    expect(await code(hfs.switchCurrent(s.mk(), '3.0.0'))).toBe(HOME_DENY.TARGET_SYMLINK);
    expect(await realpath(path.join(s.home, LINK))).toBe(
      await realpath(path.join(s.home, ver('1.0.0'))),
    );
  });

  it('versions 本身是符号链接 → 拒绝;current 是普通目录 → 拒绝', async () => {
    const s = await setup([LINK]);
    await safe.mkdirp(s.fx, path.join(s.dir, 'outside/1.0.0'));
    await safe.mkdirp(s.fx, path.join(s.home, SHARE));
    await safe.symlink(s.fx, path.join(s.dir, 'outside'), path.join(s.home, SHARE, 'versions'));
    expect(await code(hfs.switchCurrent(s.mk(), '1.0.0'))).toBe(HOME_DENY.INTERMEDIATE_SYMLINK);
    const t = await withVersions(['1.0.0']);
    await safe.mkdirp(t.fx, path.join(t.home, LINK));
    expect(await code(hfs.switchCurrent(t.mk(), '1.0.0'))).toBe(HOME_DENY.NOT_REGULAR);
    // 普通文件同样拒绝,且内容不被覆盖
    const u = await withVersions(['1.0.0']);
    await safe.writeFile(u.fx, path.join(u.home, LINK), 'file');
    expect(await code(hfs.switchCurrent(u.mk(), '1.0.0'))).toBe(HOME_DENY.NOT_SYMLINK);
    expect(await readText(path.join(u.home, LINK))).toBe('file');
  });

  it('检查与 rename 之间目标版本目录被换成别的目录(身份变了)→ PATH_ESCAPE,current 不变', async () => {
    const s = await withVersions(['1.0.0', '2.0.0']);
    await hfs.switchCurrent(s.mk(), '1.0.0');
    const oldIno = (await lstat(path.join(s.home, ver('2.0.0')))).ino;
    const swap = hfs.createHomeFsContext({
      home: s.home,
      planScope: [LINK],
      tmpDir: s.dir,
      onStage: async () => {
        // 先把旧目录挪到一旁、新目录建好之后才删旧的:旧 inode 在新目录创建时仍被占用,
        // 否则 ext4/tmpfs 会把刚释放的 inode 号立刻复用给新目录,身份(dev+ino)没变,竞态就测不出来
        const v = path.join(s.home, ver('2.0.0'));
        const aside = path.join(s.dir, 'aside-2.0.0');
        await safe.rename(s.fx, v, aside);
        await safe.mkdirp(s.fx, v);
        await safe.remove(s.fx, aside);
        // 前提断言:换进来的必须真是另一个 inode,否则用例没在测"身份变了"(静默通过比失败更糟)
        expect((await lstat(v)).ino).not.toBe(oldIno);
      },
    });
    expect(await code(hfs.switchCurrent(swap, '2.0.0'))).toBe(HOME_DENY.PATH_ESCAPE);
    expect(await realpath(path.join(s.home, LINK))).toBe(
      await realpath(path.join(s.home, ver('1.0.0'))),
    );
  });

  it('rename 前临时链接被换成指向 versions 之外 → 切换后复核发现(readlink / realpath),抛 PATH_ESCAPE', async () => {
    const s = await withVersions(['1.0.0']);
    await safe.mkdirp(s.fx, path.join(s.dir, 'outside'));
    const evil = hfs.createHomeFsContext({
      home: s.home,
      planScope: [LINK],
      tmpDir: s.dir,
      onStage: async () => {
        const tmp = (await readDir(path.join(s.home, SHARE))).find((e) =>
          e.name.startsWith('.current.tmp-'),
        );
        if (tmp === undefined) return;
        const abs = path.join(s.home, SHARE, tmp.name);
        await safe.remove(s.fx, abs);
        await safe.symlink(s.fx, path.join(s.dir, 'outside'), abs);
      },
    });
    expect(await code(hfs.switchCurrent(evil, '1.0.0'))).toBe(HOME_DENY.PATH_ESCAPE);
  });

  it('链接位置固定:planScope 里没有 current 就拒绝;version=null 撤掉链接(不存在也成功)', async () => {
    const s = await withVersions(['1.0.0']);
    expect(await code(hfs.switchCurrent(s.mk([`${SHARE}/other`]), '1.0.0'))).toBe(
      HOME_DENY.OUT_OF_PLAN_SCOPE,
    );
    await hfs.switchCurrent(s.mk(), '1.0.0');
    await hfs.switchCurrent(s.mk(), null);
    await expect(lstat(path.join(s.home, LINK))).rejects.toThrow();
    await hfs.switchCurrent(s.mk(), null);
  });
});
