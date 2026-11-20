import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as hfs from '../../src/io/home-fs.js';
import { HOME_DENY, HomeExistsError, HomeWriteDeniedError } from '../../src/io/home-fs.js';
import { lstat, readDir, readText, realpath } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { rawLink, rawUnlink } from '../helpers/raw-links.js';
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
    /** 带阶段注入口的上下文(`post-link` 等) */
    mkStage: (onStage: (stage: hfs.HomeFsStage) => void | Promise<void>, s = scope) =>
      hfs.createHomeFsContext({ home, planScope: s, tmpDir, onStage }),
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

describe('renameExclusive', () => {
  const A = '.local/state/agent-kit/x/a';
  const B = '.local/state/agent-kit/x/b';
  const mkdirX = (s: Awaited<ReturnType<typeof setup>>) =>
    safe.mkdirp(s.fx, path.join(s.home, '.local/state/agent-kit/x'), 0o700);

  it('目标不存在:改名成功,来源消失、内容与单一 inode 链接数(nlink=1)保持', async () => {
    const s = await setup([A, B]);
    await mkdirX(s);
    await hfs.writeFile(s.mk(), A, 'one', { mode: 0o600, dirMode: 0o700 });
    await hfs.renameExclusive(s.mk(), A, B);
    expect(await readText(path.join(s.home, B))).toBe('one');
    await expect(lstat(path.join(s.home, A))).rejects.toThrow();
    expect((await lstat(path.join(s.home, B))).nlink).toBe(1);
  });

  it('目标已存在:EEXIST,来源与目标都原样保留(不覆盖)', async () => {
    const s = await setup([A, B]);
    await mkdirX(s);
    await hfs.writeFile(s.mk(), A, 'from', { mode: 0o600, dirMode: 0o700 });
    await hfs.writeFile(s.mk(), B, 'to', { mode: 0o600, dirMode: 0o700 });
    expect(await code(hfs.renameExclusive(s.mk(), A, B))).toBe('EEXIST');
    expect(await readText(path.join(s.home, A))).toBe('from');
    expect(await readText(path.join(s.home, B))).toBe('to');
  });

  it('来源不存在:ENOENT;表外 / 计划外路径拒绝', async () => {
    const s = await setup([A, B]);
    await mkdirX(s);
    await expect(hfs.renameExclusive(s.mk(), A, B)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await code(hfs.renameExclusive(s.mk(), A, '.ssh/b'))).not.toBe('ok');
    expect(await code(hfs.renameExclusive(s.mk([A]), A, B))).toBe(HOME_DENY.OUT_OF_PLAN_SCOPE);
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

// ---------------------------------------------------------------------------
// R5:renameExclusive 的半完成态 / 回滚所有权 / 来源被换;settleHalfLink;removeVerified(绑定对象的删除)
// ---------------------------------------------------------------------------

const SD = '.local/state/agent-kit/x';
const FA = `${SD}/a`;
const FB = `${SD}/b`;

async function seed(s: Awaited<ReturnType<typeof setup>>, rel: string, text: string) {
  await hfs.writeFile(s.mk([rel]), rel, text, { mode: 0o600, dirMode: 0o700 });
}
const abs = (s: { home: string }, rel: string): string => path.join(s.home, rel);

describe('renameExclusive:半完成态与竞态(link 之后)', () => {
  it('rename_exclusive_crash_after_link_is_two_names_one_inode:link 之后「进程死亡」→ 两个名字、同 inode、nlink=2;随后 settleHalfLink 只删目标名(这里是墓碑方向:删来源名的对端)', async () => {
    const s = await setup([FA, FB]);
    await seed(s, FA, 'one');
    const boom = new Error('crash@post-link');
    await expect(
      hfs.renameExclusive(
        s.mkStage((st) => {
          if (st === 'post-link') throw boom;
        }),
        FA,
        FB,
      ),
    ).rejects.toBe(boom);
    const a = await lstat(abs(s, FA));
    const b = await lstat(abs(s, FB));
    expect([a.nlink, b.nlink]).toEqual([2, 2]);
    expect(a.ino).toBe(b.ino);
    // 收尾:删掉 FB(墓碑方向),保留 FA
    expect(await hfs.settleHalfLink(s.mk(), FB, FA)).toBe('settled');
    expect(await readText(abs(s, FA))).toBe('one');
    expect((await lstat(abs(s, FA))).nlink).toBe(1);
    await expect(lstat(abs(s, FB))).rejects.toThrow();
  });

  it('rename_exclusive_rollback_requires_own_link:unlink(来源) 失败 → 回滚只删「本次创建的那个链接」;目标名已被换成别的文件 → 不删,抛 HomeRenameRaceError', async () => {
    const s = await setup([FA, FB]);
    await seed(s, FA, 'one');
    const hook = async (st: hfs.HomeFsStage): Promise<void> => {
      if (st !== 'pre-unlink-source') return;
      await rawUnlink(abs(s, FB)); // 我们刚建的链接被拿走(此刻 nlink=2,safe-fs 守卫会拒,夹具走 raw)
      await safe.writeFile(s.fx, abs(s, FB), 'FOREIGN', { mode: 0o600 }); // 换上别人的文件
      throw new Error('unlink failed');
    };
    await expect(hfs.renameExclusive(s.mkStage(hook), FA, FB)).rejects.toBeInstanceOf(
      hfs.HomeRenameRaceError,
    );
    expect(await readText(abs(s, FB))).toBe('FOREIGN');
    expect(await readText(abs(s, FA))).toBe('one');
  });

  it('rename_exclusive_rollback_removes_own_link:unlink(来源) 失败且目标名仍是自己建的链接 → 撤销该链接并原样抛错;来源不动、nlink 回到 1', async () => {
    const s = await setup([FA, FB]);
    await seed(s, FA, 'one');
    const err = new Error('unlink failed');
    await expect(
      hfs.renameExclusive(
        s.mkStage((st) => {
          if (st === 'pre-unlink-source') throw err;
        }),
        FA,
        FB,
      ),
    ).rejects.toBe(err);
    await expect(lstat(abs(s, FB))).rejects.toThrow();
    expect(await readText(abs(s, FA))).toBe('one');
    expect((await lstat(abs(s, FA))).nlink).toBe(1);
  });

  it('rename_exclusive_rollback_keeps_target_when_source_swapped:unlink(来源) 失败进入回滚时来源名已被换成别的文件 → 不撤销目标(它是原对象仅剩的名字),抛 HomeRenameRaceError;换上的来源不动', async () => {
    const s = await setup([FA, FB]);
    await seed(s, FA, 'one');
    await expect(
      hfs.renameExclusive(
        s.mkStage(async (st) => {
          if (st !== 'pre-unlink-source') return;
          await rawUnlink(abs(s, FA)); // 来源名被拿走(此刻 FB 是原对象唯一的名字,nlink=1)
          await safe.writeFile(s.fx, abs(s, FA), 'FOREIGN', { mode: 0o600 });
          throw new Error('unlink failed');
        }),
        FA,
        FB,
      ),
    ).rejects.toBeInstanceOf(hfs.HomeRenameRaceError);
    expect(await readText(abs(s, FB))).toBe('one');
    expect(await readText(abs(s, FA))).toBe('FOREIGN');
  });

  it('rename_exclusive_rollback_keeps_target_when_source_gone:进入回滚时来源名已消失 → 不撤销目标(原对象唯一的名字),抛 HomeRenameRaceError', async () => {
    const s = await setup([FA, FB]);
    await seed(s, FA, 'one');
    await expect(
      hfs.renameExclusive(
        s.mkStage(async (st) => {
          if (st !== 'pre-unlink-source') return;
          await rawUnlink(abs(s, FA));
          throw new Error('unlink failed');
        }),
        FA,
        FB,
      ),
    ).rejects.toBeInstanceOf(hfs.HomeRenameRaceError);
    expect(await readText(abs(s, FB))).toBe('one');
    expect((await lstat(abs(s, FB))).nlink).toBe(1);
    await expect(lstat(abs(s, FA))).rejects.toThrow();
  });

  it('rename_exclusive_target_checked_before_source_unlink:link 之后目标名被换成别的文件(不抛错)→ 不删来源(它可能是最后一个有效名字),抛 HomeRenameRaceError;来源与换上的目标都原样保留', async () => {
    const s = await setup([FA, FB]);
    await seed(s, FA, 'one');
    await expect(
      hfs.renameExclusive(
        s.mkStage(async (st) => {
          if (st !== 'pre-unlink-source') return;
          await rawUnlink(abs(s, FB));
          await safe.writeFile(s.fx, abs(s, FB), 'FOREIGN', { mode: 0o600 });
        }),
        FA,
        FB,
      ),
    ).rejects.toBeInstanceOf(hfs.HomeRenameRaceError);
    expect(await readText(abs(s, FA))).toBe('one');
    expect(await readText(abs(s, FB))).toBe('FOREIGN');
  });

  it('rename_exclusive_source_swapped_not_unlinked:link 之后来源名被换成别的文件 → 不 unlink 换上者(视为移动已完成:目标名持有原对象)', async () => {
    const s = await setup([FA, FB]);
    await seed(s, FA, 'one');
    await hfs.renameExclusive(
      s.mkStage(async (st) => {
        if (st !== 'post-link') return;
        await rawUnlink(abs(s, FA));
        await safe.writeFile(s.fx, abs(s, FA), 'FOREIGN', { mode: 0o600 });
      }),
      FA,
      FB,
    );
    expect(await readText(abs(s, FA))).toBe('FOREIGN');
    expect(await readText(abs(s, FB))).toBe('one');
    expect((await lstat(abs(s, FB))).nlink).toBe(1);
  });
});

describe('settleHalfLink:只收尾确定的半完成态', () => {
  it('不同 inode(各自 nlink=1)→ not_half_state,两个文件都不动', async () => {
    const s = await setup([FA, FB]);
    await seed(s, FA, 'one');
    await seed(s, FB, 'two');
    expect(await hfs.settleHalfLink(s.mk(), FB, FA)).toBe('not_half_state');
    expect(await readText(abs(s, FA))).toBe('one');
    expect(await readText(abs(s, FB))).toBe('two');
  });

  it('settle_half_link_requires_same_inode:两个名字各自 nlink=2、但不是同一个 inode(各另有一个链接)→ not_half_state,不动', async () => {
    const s = await setup([FA, FB]);
    await seed(s, FA, 'one');
    await seed(s, FB, 'two');
    await safe.hardlink(s.fx, abs(s, FA), abs(s, `${SD}/ka`));
    await safe.hardlink(s.fx, abs(s, FB), abs(s, `${SD}/kb`));
    expect(await hfs.settleHalfLink(s.mk(), FB, FA)).toBe('not_half_state');
    expect((await lstat(abs(s, FA))).nlink).toBe(2);
    expect((await lstat(abs(s, FB))).nlink).toBe(2);
  });

  it('同 inode 但 nlink=3(另有第三个名字)→ not_half_state,不动', async () => {
    const s = await setup([FA, FB]);
    await seed(s, FA, 'one');
    await safe.hardlink(s.fx, abs(s, FA), abs(s, FB));
    await rawLink(abs(s, FA), abs(s, `${SD}/third`)); // 来源已是 nlink=2,safe-fs.hardlink 会拒
    expect(await hfs.settleHalfLink(s.mk(), FB, FA)).toBe('not_half_state');
    expect((await lstat(abs(s, FA))).nlink).toBe(3);
    expect(await readText(abs(s, FB))).toBe('one');
  });

  it('settle_half_link_rejects_same_name:保留名与删除名相同 → 守卫拒绝(同名 + 另一个硬链接会把保留名删掉),文件不动', async () => {
    const s = await setup([FA]);
    await seed(s, FA, 'one');
    await safe.hardlink(s.fx, abs(s, FA), abs(s, `${SD}/other`));
    expect(await code(hfs.settleHalfLink(s.mk(), FA, FA))).toBe(HOME_DENY.PATH_INVALID);
    expect((await lstat(abs(s, FA))).nlink).toBe(2);
    expect(await readText(abs(s, FA))).toBe('one');
  });

  it('任一名字不存在 → not_half_state;表外 / 计划外路径照常被拒', async () => {
    const s = await setup([FA, FB]);
    await seed(s, FA, 'one');
    expect(await hfs.settleHalfLink(s.mk(), FB, FA)).toBe('not_half_state');
    expect(await hfs.settleHalfLink(s.mk(), FA, FB)).toBe('not_half_state');
    expect(await code(hfs.settleHalfLink(s.mk(), '.ssh/b', FA))).not.toBe('ok');
    expect(await code(hfs.settleHalfLink(s.mk([FA]), FB, FA))).toBe(HOME_DENY.OUT_OF_PLAN_SCOPE);
  });

  it('符号链接作为其中一个名字 → 守卫拒绝,不动', async () => {
    const s = await setup([FA, FB]);
    await seed(s, FA, 'one');
    await safe.symlink(s.fx, abs(s, FA), abs(s, FB));
    expect(await code(hfs.settleHalfLink(s.mk(), FB, FA))).toBe(HOME_DENY.TARGET_SYMLINK);
    expect(await readText(abs(s, FA))).toBe('one');
  });
});

describe('removeVerified:核对的就是删除的那个对象', () => {
  const OPTS = { maxBytes: 1024, maxPerm: 0o600 } as const;

  it('核对通过 → removed;verify 收到文件全文;文件消失', async () => {
    const s = await setup([FA]);
    await seed(s, FA, 'payload');
    let seen = '';
    const r = await hfs.removeVerified(s.mk(), FA, OPTS, (b) => {
      seen = b.toString('utf8');
      return undefined;
    });
    expect(r).toEqual({ kind: 'removed' });
    expect(seen).toBe('payload');
    await expect(lstat(abs(s, FA))).rejects.toThrow();
  });

  it('verify 拒绝 → rejected(带原因),文件原样保留', async () => {
    const s = await setup([FA]);
    await seed(s, FA, 'payload');
    const r = await hfs.removeVerified(s.mk(), FA, OPTS, () => 'no');
    expect(r).toEqual({ kind: 'rejected', value: 'no' });
    expect(await readText(abs(s, FA))).toBe('payload');
  });

  it('不存在 → absent', async () => {
    const s = await setup([FA]);
    await safe.mkdirp(s.fx, path.join(s.home, SD), 0o700);
    expect(await hfs.removeVerified(s.mk(), FA, OPTS, () => undefined)).toEqual({
      kind: 'absent',
    });
  });

  it('remove_verified_path_identity_checked:核对之后、unlink 之前路径被换成别的文件 → replaced,换上者不被删', async () => {
    const s = await setup([FA]);
    await seed(s, FA, 'payload');
    const r = await hfs.removeVerified(
      s.mkStage(async (st) => {
        if (st !== 'pre-unlink-verified') return;
        await safe.writeFile(s.fx, abs(s, `${SD}/swap`), 'FOREIGN', { mode: 0o600 });
        await safe.rename(s.fx, abs(s, `${SD}/swap`), abs(s, FA));
      }),
      FA,
      OPTS,
      () => undefined,
    );
    expect(r).toEqual({ kind: 'replaced' });
    expect(await readText(abs(s, FA))).toBe('FOREIGN');
  });

  it('remove_verified_nlink_zero_checked:核对之后给对象加了第二个名字 → unlink 后 fd 的 nlink≠0 → not_removed_object(对象仍在另一个名字下)', async () => {
    const s = await setup([FA]);
    await seed(s, FA, 'payload');
    const r = await hfs.removeVerified(
      s.mkStage(async (st) => {
        if (st === 'pre-unlink-verified') {
          await safe.hardlink(s.fx, abs(s, FA), abs(s, `${SD}/extra`));
        }
      }),
      FA,
      OPTS,
      () => undefined,
    );
    expect(r).toEqual({ kind: 'not_removed_object' });
    expect(await readText(abs(s, `${SD}/extra`))).toBe('payload');
  });

  it('读取强度:硬链接 / 权限宽于上限 / 超过字节上限 → 守卫拒绝,不调用 verify、不删', async () => {
    const s = await setup([FA, FB]);
    let called = 0;
    const v = (): undefined => {
      called++;
      return undefined;
    };
    await seed(s, FA, 'payload');
    await safe.hardlink(s.fx, abs(s, FA), abs(s, FB));
    expect(await code(hfs.removeVerified(s.mk(), FA, OPTS, v))).toBe(HOME_DENY.HARDLINK);
    await rawUnlink(abs(s, FB)); // FA 此刻 nlink=2,safe-fs.remove 会拒
    await safe.chmod(s.fx, abs(s, FA), 0o644);
    expect(await code(hfs.removeVerified(s.mk(), FA, OPTS, v))).toBe(HOME_DENY.OWNER);
    await safe.chmod(s.fx, abs(s, FA), 0o600);
    expect(await code(hfs.removeVerified(s.mk(), FA, { ...OPTS, maxBytes: 3 }, v))).toBe(
      HOME_DENY.NOT_REGULAR,
    );
    expect(called).toBe(0);
    expect(await readText(abs(s, FA))).toBe('payload');
  });
});
