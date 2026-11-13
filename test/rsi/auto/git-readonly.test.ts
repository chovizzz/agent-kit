/**
 * 受限的只读 git 适配器(W8a;contracts §21.24 W0-22 第 6 条、W0-24):三种 argv 形状、封闭 env、显式仓库、每次读取前的配置预检、返回后复核、输出 / 个数 / 字节上限。
 * 真仓库(假 HOME 下的私有仓库,真 git,经 `runGitClosed`)+ 间谍记录每次 spawn 的 argv / env / cwd。删掉任一拒绝逻辑必红,不只验 env。
 * 保证边界(写进适配器头注):零写入只在读取期间没有其它程序改仓库配置时成立;预检 + 复核只算「检测并拒收」,**不**构成零写入证明。
 */
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runGitClosed } from '../../../src/io/exec.js';
import { lstat, readDir, readText } from '../../../src/io/read-fs.js';
import * as safe from '../../../src/io/safe-fs.js';
import {
  GIT_BLOB_MAX_COUNT,
  GIT_OUTPUT_MAX_BYTES,
  GitArgvError,
  assertClosedEnv,
  assertReadOnlyGitArgv,
  closedGitEnv,
  configAcceptable,
  fixedGitArgv,
  makeGitReadonly,
  preflightRepo,
  type GitSpawn,
  type GitSpawnResult,
} from '../../../src/rsi/personal/read/git-readonly.js';
import { ID1, git, makeWorld, setupRepo, slowTests, type World } from '../personal/repo-helpers.js';

slowTests();
const GIT = '/usr/bin/git';
const OID = 'a'.repeat(40);
const GD = '/x/personal/.git';

describe('argv 形状:三种之外一律拒绝', () => {
  const fixed = fixedGitArgv(GD);
  const shapes: string[][] = [
    ['rev-parse', '--verify', '--quiet', '--end-of-options', `${OID}^{commit}`],
    ['ls-tree', '-r', '-z', '--full-tree', '--end-of-options', OID],
    ['cat-file', 'blob', OID],
  ];
  it('三种合法形状通过', () => {
    for (const t of shapes) expect(() => assertReadOnlyGitArgv([...fixed, ...t], GD)).not.toThrow();
  });

  it('非法形状:多 / 少参数、`--` 路径、非 40 位小写 oid、revision 表达式、第四种操作、形状 ① 的后缀缺失,各一例', () => {
    const bad: string[][] = [
      [...(shapes[0] as string[]), '--'],
      (shapes[0] as string[]).slice(0, 4),
      ['rev-parse', '--verify', '--quiet', '--end-of-options', OID],
      ['rev-parse', '--verify', '--quiet', '--end-of-options', `HEAD^{commit}`],
      ['rev-parse', '--verify', '--quiet', '--end-of-options', `${OID}~1^{commit}`],
      [...(shapes[1] as string[]), 'some/path'],
      ['ls-tree', '-r', '-z', '--full-tree', OID],
      ['ls-tree', '-r', '--full-tree', '--end-of-options', OID],
      ['cat-file', 'blob', OID, OID],
      ['cat-file', '-p', OID],
      ['cat-file', 'blob', OID.toUpperCase()],
      ['cat-file', 'blob', OID.slice(1)],
      ['cat-file', 'blob', `${OID}x`],
      ['log', '-1', OID],
      ['config', '--list'],
      ['fetch', 'origin'],
      ['cat-file', 'blob', '--help'],
      [],
    ];
    for (const t of bad) {
      expect(() => assertReadOnlyGitArgv([...fixed, ...t], GD), t.join(' ')).toThrow(GitArgvError);
    }
  });

  it('<FIXED> 逐项等值:缺一项 / 换值 / 换序 / 另一个仓库目录都拒绝', () => {
    const tail = shapes[2] as string[];
    expect(() => assertReadOnlyGitArgv([...fixed.slice(1), ...tail], GD)).toThrow(GitArgvError);
    const swapped = [...fixed];
    swapped[0] = fixed[1] as string;
    swapped[1] = fixed[0] as string;
    expect(() => assertReadOnlyGitArgv([...swapped, ...tail], GD)).toThrow(GitArgvError);
    const hooks = fixed.map((x) =>
      x === 'core.hooksPath=/dev/null' ? 'core.hooksPath=/tmp/h' : x,
    );
    expect(() => assertReadOnlyGitArgv([...hooks, ...tail], GD)).toThrow(GitArgvError);
    expect(() => assertReadOnlyGitArgv([...fixed, ...tail], '/other/.git')).toThrow(GitArgvError);
    // 额外的 -c 项也拒绝
    expect(() => assertReadOnlyGitArgv([...fixed, '-c', 'core.pager=cat', ...tail], GD)).toThrow(
      GitArgvError,
    );
  });
});

describe('封闭 env', () => {
  it('恰好 12 个键,值等于清单;多一键 / 缺一键 / 值不同都拒绝;从不含 GIT_DIR 等危险键', () => {
    const env = closedGitEnv(GD);
    expect(Object.keys(env).sort()).toEqual(
      [
        'PATH',
        'HOME',
        'LC_ALL',
        'GIT_CONFIG_GLOBAL',
        'GIT_CONFIG_SYSTEM',
        'GIT_CONFIG_NOSYSTEM',
        'GIT_OPTIONAL_LOCKS',
        'GIT_TERMINAL_PROMPT',
        'GIT_NO_REPLACE_OBJECTS',
        'GIT_NO_LAZY_FETCH',
        'GIT_ATTR_NOSYSTEM',
        'GIT_ALLOW_PROTOCOL',
      ].sort(),
    );
    expect(env['HOME']).toBe(GD);
    expect(env['GIT_ALLOW_PROTOCOL']).toBe('');
    expect(() => assertClosedEnv(env, GD)).not.toThrow();
    expect(() => assertClosedEnv({ ...env, GIT_DIR: GD }, GD)).toThrow(GitArgvError);
    const { GIT_NO_LAZY_FETCH: _drop, ...less } = env;
    void _drop;
    expect(() => assertClosedEnv(less, GD)).toThrow(GitArgvError);
    expect(() => assertClosedEnv({ ...env, GIT_CONFIG_NOSYSTEM: '0' }, GD)).toThrow(GitArgvError);
    expect(() => assertClosedEnv({ ...env, HOME: '/home/other' }, GD)).toThrow(GitArgvError);
  });

  it('runGitClosed 自身的守卫:相对路径 / 文件名不是 git / env 键越界 / cwd 非绝对 → 抛错(不 spawn)', () => {
    const o = { cwd: '/', env: {}, timeoutMs: 1000, maxBufferBytes: 1024 };
    expect(() => runGitClosed('git', ['--version'], o)).toThrow();
    expect(() => runGitClosed('/bin/sh', ['-c', 'true'], o)).toThrow();
    expect(() => runGitClosed(GIT, ['--version'], { ...o, env: { NODE_OPTIONS: 'x' } })).toThrow();
    expect(() => runGitClosed(GIT, ['--version'], { ...o, cwd: 'rel' })).toThrow();
  });
});

describe('配置预检的严格子集解析(纯函数)', () => {
  const ok =
    '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n# c\n; c\n\n[extensions]\n\tobjectformat = sha1\n';
  it('典型本地 config 通过;空行 / 注释 / 缩进都允许', () => {
    expect(configAcceptable(ok)).toBe(true);
    expect(configAcceptable('')).toBe(true);
    expect(configAcceptable('[remote "origin"]\n\turl = x\n')).toBe(true);
  });
  const rejected: [string, string][] = [
    ['include', '[include]\n\tpath = /tmp/x\n'],
    ['includeIf', '[includeIf "gitdir:/x"]\n\tpath = /tmp/x\n'],
    ['INCLUDE(大小写不敏感)', '[Include]\n\tpath = /tmp/x\n'],
    ['extensions.partialClone', '[extensions]\n\tpartialClone = origin\n'],
    ['extensions 白名单外的键', '[extensions]\n\tworktreeConfig = true\n'],
    ['remote.promisor', '[remote "origin"]\n\tpromisor = true\n'],
    ['remote.partialclonefilter', '[remote "origin"]\n\tpartialclonefilter = blob:none\n'],
    ['任一段内的 promisor 键', '[core]\n\tPromisor = true\n'],
    ['旧式段头 [remote.foo]', '[remote.foo]\n\turl = x\n'],
    ['续行 \\', '[core]\n\tfilemode = tr\\\nue\n'],
    ['value 含引号', '[core]\n\tfilemode = "true"\n'],
    ['value 含反引号', '[core]\n\tfilemode = `x`\n'],
    ['白名单外的段', '[alias]\n\tx = y\n'],
    ['段外的键', 'bare = false\n'],
    ['无法解析的行(布尔省略写法)', '[core]\n\tbare\n'],
    ['段名含非法字符', '[co re]\n'],
    ['CR 行尾', '[core]\r\n\tbare = false\r\n'],
  ];
  for (const [name, text] of rejected) {
    it(`拒绝:${name}`, () => expect(configAcceptable(text)).toBe(false));
  }
});

describe('真仓库(假 HOME 下的私有仓库,真 git)', () => {
  let w: World;
  let gitDir: string;
  let head: string;
  let originalConfig: string;
  beforeAll(async () => {
    w = await makeWorld('w8a-git-');
    await setupRepo(w);
    gitDir = path.join(w.h.repoDir, '.git');
    head = git(w, ['rev-parse', 'HEAD']);
    originalConfig = await readText(path.join(gitDir, 'config'));
  });

  const cfgFile = (): string => path.join(gitDir, 'config');
  const restore = async (): Promise<void> => {
    await safe.remove(w.io, path.join(gitDir, 'config.worktree'));
    await safe.remove(w.io, path.join(gitDir, '.gitconfig'));
    await safe.remove(w.io, path.join(gitDir, '.config'));
    await safe.remove(w.io, path.join(gitDir, 'objects', 'pack', 'x.promisor'));
    await safe.remove(w.io, path.join(gitDir, 'objects', 'info', 'alternates'));
    await safe.remove(w.io, path.join(gitDir, 'info', 'grafts'));
    // config 可能被换成目录 / 符号链接 / 0000 的文件:先整个删掉再按原内容重建
    await safe.remove(w.io, cfgFile());
    await safe.writeFile(w.io, cfgFile(), originalConfig, { mode: 0o600 });
  };

  interface Spy {
    calls: { file: string; argv: readonly string[]; env: Record<string, string>; cwd: string }[];
    spawn: GitSpawn;
  }
  const spy = (inner?: GitSpawn): Spy => {
    const s: Spy = {
      calls: [],
      spawn: (file, argv, o) => {
        s.calls.push({ file, argv, env: { ...o.env }, cwd: o.cwd });
        return (inner ?? ((f, a, x) => runGitClosed(f, a, x)))(file, argv, o);
      },
    };
    return s;
  };
  const port = (s: Spy, over: { uid?: number } = {}) =>
    makeGitReadonly({ gitPath: GIT, gitDir, spawn: s.spawn, ...over });

  it('三种读取都成功;每次 spawn 的 argv 通过形状校验、env 恰为封闭清单、cwd = 仓库目录、git 是绝对路径', async () => {
    await restore();
    const s = spy();
    const p = port(s);
    const c = await p.readCommit(head);
    expect(c).toEqual({ kind: 'ok', value: { oid: head } });
    const t = await p.listTree(head);
    expect(t.kind).toBe('ok');
    const entries = t.kind === 'ok' ? t.value : [];
    const f = entries.find((e) => e.path === `lifecycle/${ID1}.json`);
    expect(f?.mode).toBe('100644');
    const b = await p.readBlob(f?.oid as string);
    expect(b).toEqual({ kind: 'ok', value: '{"id":"ra_aaaaaaaaaaaa"}\n' });
    expect(s.calls).toHaveLength(3);
    for (const call of s.calls) {
      expect(call.file).toBe(GIT);
      expect(() => assertReadOnlyGitArgv(call.argv, gitDir)).not.toThrow();
      expect(() => assertClosedEnv(call.env, gitDir)).not.toThrow();
      expect(call.cwd).toBe(gitDir);
    }
  });

  it('提交不存在 → missing(不是 unreadable);非 40 位小写十六进制的 oid → bad_oid 且 spawn = 0', async () => {
    await restore();
    const s = spy();
    const p = port(s);
    expect(await p.readCommit('f'.repeat(40))).toEqual({ kind: 'missing' });
    expect(s.calls).toHaveLength(1);
    for (const bad of [
      'HEAD',
      head.toUpperCase(),
      head.slice(1),
      '--help',
      `${head}^{commit}`,
      '',
    ]) {
      for (const m of ['readCommit', 'listTree', 'readBlob'] as const) {
        expect(await p[m](bad), `${m}(${bad})`).toEqual({ kind: 'unreadable', why: 'bad_oid' });
      }
    }
    expect(s.calls).toHaveLength(1);
  });

  const configCases: [string, () => Promise<void>][] = [
    [
      'include 引入 promisor',
      () => safe.writeFile(w.io, cfgFile(), `${originalConfig}\n[include]\n\tpath = /tmp/evil\n`),
    ],
    [
      'includeIf',
      () =>
        safe.writeFile(
          w.io,
          cfgFile(),
          `${originalConfig}\n[includeIf "gitdir:/"]\n\tpath = /tmp/evil\n`,
        ),
    ],
    [
      'extensions.partialClone',
      () =>
        safe.writeFile(
          w.io,
          cfgFile(),
          `${originalConfig}\n[extensions]\n\tpartialClone = origin\n`,
        ),
    ],
    [
      'remote.origin.promisor',
      () =>
        safe.writeFile(
          w.io,
          cfgFile(),
          `${originalConfig}\n[remote "origin"]\n\tpromisor = true\n`,
        ),
    ],
    [
      'partialclonefilter',
      () =>
        safe.writeFile(
          w.io,
          cfgFile(),
          `${originalConfig}\n[remote "origin"]\n\tpartialclonefilter = blob:none\n`,
        ),
    ],
    [
      '续行 \\',
      () => safe.writeFile(w.io, cfgFile(), `${originalConfig}\n[core]\n\tfilemode = tr\\\nue\n`),
    ],
    [
      '旧式段头 [remote.foo]',
      () => safe.writeFile(w.io, cfgFile(), `${originalConfig}\n[remote.foo]\n\turl = x\n`),
    ],
    [
      'config 超过 64 KiB',
      () => safe.writeFile(w.io, cfgFile(), `${originalConfig}\n# ${'x'.repeat(65 * 1024)}\n`),
    ],
    ['config 权限 0000(读不出)', () => safe.chmod(w.io, cfgFile(), 0)],
    [
      'config 是目录',
      async () => {
        await safe.remove(w.io, cfgFile());
        await safe.mkdirp(w.io, cfgFile(), 0o700);
      },
    ],
    [
      'config 是符号链接',
      async () => {
        await safe.remove(w.io, cfgFile());
        await safe.symlink(w.io, path.join(w.dir, 'elsewhere'), cfgFile());
      },
    ],
    [
      'config.worktree 存在',
      () => safe.writeFile(w.io, path.join(gitDir, 'config.worktree'), '[core]\n'),
    ],
    ['.gitconfig 存在', () => safe.writeFile(w.io, path.join(gitDir, '.gitconfig'), '[core]\n')],
    ['.config/git 存在', () => safe.mkdirp(w.io, path.join(gitDir, '.config', 'git'), 0o700)],
    [
      'objects/pack/x.promisor',
      async () => {
        await safe.mkdirp(w.io, path.join(gitDir, 'objects', 'pack'), 0o755);
        await safe.writeFile(w.io, path.join(gitDir, 'objects', 'pack', 'x.promisor'), '');
      },
    ],
    [
      'objects/info/alternates',
      async () => {
        await safe.mkdirp(w.io, path.join(gitDir, 'objects', 'info'), 0o755);
        await safe.writeFile(
          w.io,
          path.join(gitDir, 'objects', 'info', 'alternates'),
          '/elsewhere/objects\n',
        );
      },
    ],
    [
      'info/grafts',
      async () => {
        await safe.mkdirp(w.io, path.join(gitDir, 'info'), 0o755);
        await safe.writeFile(w.io, path.join(gitDir, 'info', 'grafts'), '');
      },
    ],
  ];
  for (const [name, mutate] of configCases) {
    it(`预检拒绝:${name} → unreadable 且 spawn 次数 = 0(含「假旧版 git:忽略 GIT_NO_LAZY_FETCH 并对缺失对象尝试抓取」的场景)`, async () => {
      await restore();
      await mutate();
      let fetched = 0;
      // 假 git:模拟旧版忽略 GIT_NO_LAZY_FETCH、对缺失对象去抓取;预检必须在它被调用之前拒绝
      const s = spy(() => {
        fetched += 1;
        return { status: 0, stdout: '', timedOut: false };
      });
      const p = port(s);
      for (const r of [
        await p.readCommit(head),
        await p.listTree(head),
        await p.readBlob('f'.repeat(40)),
      ]) {
        expect(r.kind).toBe('unreadable');
      }
      expect([s.calls.length, fetched]).toEqual([0, 0]);
      await restore();
    });
  }

  it('仓库目录本身不安全 → unreadable 且 spawn = 0:相对路径、符号链接、非本人属主、可被组 / 他人写', async () => {
    await restore();
    const s = spy();
    expect(
      await makeGitReadonly({ gitPath: GIT, gitDir: '.git', spawn: s.spawn }).readCommit(head),
    ).toEqual({
      kind: 'unreadable',
      why: 'repo_unsafe',
    });
    const link = path.join(w.dir, 'gitlink');
    await safe.symlink(w.io, gitDir, link);
    expect(
      (await makeGitReadonly({ gitPath: GIT, gitDir: link, spawn: s.spawn }).readCommit(head)).kind,
    ).toBe('unreadable');
    const otherUid = (process.getuid?.() ?? 1000) + 1;
    expect((await port(s, { uid: otherUid }).readCommit(head)).kind).toBe('unreadable');
    const mode = (await lstat(gitDir)).mode & 0o777;
    await safe.chmod(w.io, gitDir, 0o777);
    try {
      expect(await preflightRepo(gitDir)).toEqual({ ok: false, why: 'repo_unsafe' });
    } finally {
      await safe.chmod(w.io, gitDir, mode);
    }
    expect(s.calls).toHaveLength(0);
    expect((await preflightRepo(gitDir)).ok).toBe(true);
  });

  it('每次读取前都预检:装配时 / 第一次读取通过不能替代第二次读取前的检查(第二次读取前改 config 必须被拒)', async () => {
    await restore();
    const s = spy();
    const p = port(s);
    expect((await p.readCommit(head)).kind).toBe('ok');
    await safe.writeFile(
      w.io,
      cfgFile(),
      `${originalConfig}\n[remote "origin"]\n\tpromisor = true\n`,
    );
    expect(await p.readCommit(head)).toEqual({ kind: 'unreadable', why: 'config_rejected' });
    expect(s.calls).toHaveLength(1);
    await restore();
  });

  it('预检通过后、git 读取之前(spawn 期间)config 被改 → 结果被丢弃并拒收(changed_during_read)。注:此情形只检测并拒收,不保证零写入', async () => {
    await restore();
    const s = spy(async (f, a, o) => {
      await safe.writeFile(w.io, cfgFile(), `${originalConfig}\n# changed during read\n`);
      return runGitClosed(f, a, o);
    });
    expect(await port(s).readCommit(head)).toEqual({
      kind: 'unreadable',
      why: 'changed_during_read',
    });
    expect(s.calls).toHaveLength(1);
    await restore();
  });

  it('存在性集合在 spawn 期间变化(出现 .promisor 文件)同样拒收', async () => {
    await restore();
    const s = spy(async (f, a, o) => {
      await safe.mkdirp(w.io, path.join(gitDir, 'objects', 'pack'), 0o755);
      await safe.writeFile(w.io, path.join(gitDir, 'objects', 'pack', 'x.promisor'), '');
      return runGitClosed(f, a, o);
    });
    expect((await port(s).readCommit(head)).kind).toBe('unreadable');
    await restore();
  });

  const fake = (r: Partial<GitSpawnResult>): Spy =>
    spy(() => ({ status: 0, stdout: '', timedOut: false, ...r }));

  it('git 异常退出码 → unreadable(stderr 不进输出);超时 / 启动失败 / 输出超 4 MiB 各自映射;形状 ① 的退出码 1 才是 missing', async () => {
    await restore();
    expect(await port(fake({ status: 128 })).listTree(head)).toEqual({
      kind: 'unreadable',
      why: 'nonzero_exit',
    });
    expect(await port(fake({ status: 1 })).listTree(head)).toEqual({
      kind: 'unreadable',
      why: 'nonzero_exit',
    });
    expect(await port(fake({ status: 1 })).readCommit(head)).toEqual({ kind: 'missing' });
    expect(await port(fake({ status: 2 })).readCommit(head)).toEqual({
      kind: 'unreadable',
      why: 'nonzero_exit',
    });
    expect(await port(fake({ status: null, timedOut: true })).readBlob(OID)).toEqual({
      kind: 'unreadable',
      why: 'timeout',
    });
    expect(await port(fake({ status: null, spawnError: 'ENOENT' })).readBlob(OID)).toEqual({
      kind: 'unreadable',
      why: 'spawn_failed',
    });
    const big = fake({ stdout: 'x'.repeat(GIT_OUTPUT_MAX_BYTES + 1) });
    expect(await port(big).readBlob(OID)).toEqual({ kind: 'unreadable', why: 'output_limit' });
    expect(await port(fake({ stdout: 'not a sha' })).readCommit(head)).toEqual({
      kind: 'unreadable',
      why: 'bad_output',
    });
    expect(await port(fake({ stdout: 'garbage' })).listTree(head)).toEqual({
      kind: 'unreadable',
      why: 'bad_output',
    });
  });

  it('blob 个数上限 512、总字节上限 8 MiB:超限即 unreadable(output_limit)', async () => {
    await restore();
    const small = port(fake({ stdout: 'x' }));
    for (let i = 0; i < GIT_BLOB_MAX_COUNT; i += 1) {
      expect((await small.readBlob(OID)).kind, String(i)).toBe('ok');
    }
    expect(await small.readBlob(OID)).toEqual({ kind: 'unreadable', why: 'output_limit' });
    const bytes = port(fake({ stdout: 'y'.repeat(3 * 1024 * 1024) }));
    expect((await bytes.readBlob(OID)).kind).toBe('ok');
    expect((await bytes.readBlob(OID)).kind).toBe('ok');
    expect(await bytes.readBlob(OID)).toEqual({ kind: 'unreadable', why: 'output_limit' });
  });

  it('gitPath 必须是文件名为 git 的绝对路径(装配错误直接抛,不静默降级)', () => {
    for (const bad of ['git', '/usr/bin/env', 'rel/git']) {
      expect(() =>
        makeGitReadonly({
          gitPath: bad,
          gitDir,
          spawn: () => ({ status: 0, stdout: '', timedOut: false }),
        }),
      ).toThrow(TypeError);
    }
  });

  it('前后整目录快照(逐文件字节 + 目录项)逐字节相同:三种读取不改仓库', async () => {
    await restore();
    const listing = async (dir: string, rel = ''): Promise<string[]> => {
      const out: string[] = [];
      for (const e of await readDir(path.join(dir, rel))) {
        const r = rel === '' ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory) out.push(`${r}/`, ...(await listing(dir, r)));
        else
          out.push(
            `${r} ${await readText(path.join(dir, r))
              .then((t) => t.length)
              .catch(() => -1)}`,
          );
      }
      return out.sort();
    };
    const before = await listing(w.h.repoDir);
    const p = port(spy());
    const t = await p.listTree(head);
    await p.readCommit(head);
    if (t.kind === 'ok') for (const e of t.value) await p.readBlob(e.oid);
    expect(await listing(w.h.repoDir)).toEqual(before);
  });
});
