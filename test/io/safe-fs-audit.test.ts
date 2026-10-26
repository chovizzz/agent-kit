import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../../src/cli.js';
import { PassThrough } from 'node:stream';
import { createLineReader, resolveIsTty, resolveReadLine } from '../../src/commands/types.js';
import { createIoContext, deriveIoContext } from '../../src/io/paths.js';
import type { IoContext } from '../../src/io/paths.js';
import { exists, readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { WriteDeniedError } from '../../src/io/safe-fs.js';
import { REPO_ROOT, makeTempDir, narrowCtx } from '../helpers/tmp.js';
import { withWriteAudit } from '../helpers/write-audit.js';
import { fullFiles, makeSandbox, outTree, runBuild, writeRepo } from '../build/helpers.js';

interface Case {
  name: string;
  /** 期望记录(相对 dir 的路径;顺序即记录顺序) */
  expected: readonly (readonly [op: string, rel: string])[];
  ok(ctx: IoContext, dir: string): Promise<unknown>;
  /** 被守卫拒绝的调用(目标在写入根 dir/allowed 之外) */
  denied(ctx: IoContext, dir: string): Promise<unknown>;
  deniedExpected: readonly (readonly [op: string, rel: string])[];
}

const A = 'allowed';
const cases: Case[] = [
  {
    name: 'writeFile',
    expected: [['writeFile', `${A}/w.txt`]],
    ok: (c, d) => safe.writeFile(c, path.join(d, A, 'w.txt'), 'x'),
    denied: (c, d) => safe.writeFile(c, path.join(d, 'outside.txt'), 'x'),
    deniedExpected: [['writeFile', 'outside.txt']],
  },
  {
    name: 'appendFile',
    expected: [['appendFile', `${A}/ap.txt`]],
    ok: (c, d) => safe.appendFile(c, path.join(d, A, 'ap.txt'), 'x'),
    denied: (c, d) => safe.appendFile(c, path.join(d, 'outside.txt'), 'x'),
    deniedExpected: [['appendFile', 'outside.txt']],
  },
  {
    name: 'createExclusive',
    expected: [['createExclusive', `${A}/lock`]],
    ok: (c, d) => safe.createExclusive(c, path.join(d, A, 'lock'), 'x', 0o600),
    denied: (c, d) => safe.createExclusive(c, path.join(d, 'lock'), 'x', 0o600),
    deniedExpected: [['createExclusive', 'lock']],
  },
  {
    name: 'mkdirp',
    expected: [['mkdirp', `${A}/sub/deep`]],
    ok: (c, d) => safe.mkdirp(c, path.join(d, A, 'sub/deep')),
    denied: (c, d) => safe.mkdirp(c, path.join(d, 'nope')),
    deniedExpected: [['mkdirp', 'nope']],
  },
  {
    name: 'remove',
    expected: [['remove', `${A}/gone`]],
    ok: (c, d) => safe.remove(c, path.join(d, A, 'gone')),
    denied: (c, d) => safe.remove(c, path.join(d, 'x')),
    deniedExpected: [['remove', 'x']],
  },
  {
    name: 'copyFile(来源 + 目标各一条)',
    expected: [
      ['copyFile.from', `${A}/src.txt`],
      ['copyFile', `${A}/dst.txt`],
    ],
    ok: async (c, d) => {
      await safe.writeFile(c, path.join(d, A, 'src.txt'), 's');
      return safe.copyFile(c, path.join(d, A, 'src.txt'), path.join(d, A, 'dst.txt'));
    },
    denied: (c, d) => safe.copyFile(c, path.join(d, A, 'src.txt'), path.join(d, 'dst.txt')),
    deniedExpected: [
      ['copyFile.from', `${A}/src.txt`],
      ['copyFile', 'dst.txt'],
    ],
  },
  {
    name: 'rename(来源 + 目标各一条)',
    expected: [
      ['rename.from', `${A}/r1`],
      ['rename', `${A}/r2`],
    ],
    ok: async (c, d) => {
      await safe.writeFile(c, path.join(d, A, 'r1'), 's');
      return safe.rename(c, path.join(d, A, 'r1'), path.join(d, A, 'r2'));
    },
    denied: (c, d) => safe.rename(c, path.join(d, A, 'r1'), path.join(d, 'r2')),
    deniedExpected: [
      ['rename.from', `${A}/r1`],
      ['rename', 'r2'],
    ],
  },
  {
    name: 'chmod',
    expected: [['chmod', `${A}/m.txt`]],
    ok: async (c, d) => {
      await safe.writeFile(c, path.join(d, A, 'm.txt'), 's');
      return safe.chmod(c, path.join(d, A, 'm.txt'), 0o600);
    },
    denied: (c, d) => safe.chmod(c, path.join(d, 'm.txt'), 0o600),
    deniedExpected: [['chmod', 'm.txt']],
  },
  {
    name: 'mkdtemp(记 parent)',
    expected: [['mkdtemp', A]],
    ok: (c, d) => safe.mkdtemp(c, path.join(d, A), 'pre-'),
    denied: (c, d) => safe.mkdtemp(c, path.join(d, 'outside'), 'pre-'),
    deniedExpected: [['mkdtemp', 'outside']],
  },
  {
    name: 'symlink(只记链接位置)',
    expected: [['symlink', `${A}/ln`]],
    ok: async (c, d) => {
      await safe.writeFile(c, path.join(d, A, 'tgt'), 's');
      return safe.symlink(c, 'tgt', path.join(d, A, 'ln'));
    },
    denied: (c, d) => safe.symlink(c, 'tgt', path.join(d, 'ln')),
    deniedExpected: [['symlink', 'ln']],
  },
  {
    name: 'hardlink(来源 + 目标各一条)',
    expected: [
      ['hardlink.from', `${A}/h1`],
      ['hardlink', `${A}/h2`],
    ],
    ok: async (c, d) => {
      await safe.writeFile(c, path.join(d, A, 'h1'), 's');
      return safe.hardlink(c, path.join(d, A, 'h1'), path.join(d, A, 'h2'));
    },
    denied: (c, d) => safe.hardlink(c, path.join(d, A, 'h1'), path.join(d, 'h2')),
    deniedExpected: [
      ['hardlink.from', `${A}/h1`],
      ['hardlink', 'h2'],
    ],
  },
];

async function setup(): Promise<{
  dir: string;
  audit: ReturnType<typeof withWriteAudit>;
  ctx: IoContext;
}> {
  const { dir } = await makeTempDir('safefs-audit-');
  const audit = withWriteAudit();
  const ctx = narrowCtx(dir, A, audit.hook);
  await safe.mkdirp(narrowCtx(dir, A), path.join(dir, A));
  return { dir, audit, ctx };
}

const abs = (dir: string, rel: string): string => path.join(dir, rel);

describe('写审计:每个导出写函数调用一次记一次', () => {
  for (const c of cases) {
    it(`${c.name}:成功调用的 op 与路径正确`, async () => {
      const { dir, audit, ctx } = await setup();
      audit.reset();
      await c.ok(ctx, dir);
      // ok() 里为造来源文件可能多记了 writeFile 前置:只比较最后 expected.length 条,其余必须全是 writeFile
      const tail = audit.calls.slice(-c.expected.length);
      expect(tail.map((x) => [x.op, x.path])).toEqual(
        c.expected.map(([op, rel]) => [op, abs(dir, rel)]),
      );
      for (const extra of audit.calls.slice(0, audit.calls.length - c.expected.length)) {
        expect(extra.op).toBe('writeFile');
      }
    });

    it(`${c.name}:被守卫拒绝的调用也被记下,且仍抛 WriteDeniedError`, async () => {
      const { dir, audit, ctx } = await setup();
      audit.reset();
      await expect(c.denied(ctx, dir)).rejects.toBeInstanceOf(WriteDeniedError);
      expect(audit.calls.map((x) => [x.op, x.path])).toEqual(
        c.deniedExpected.map(([op, rel]) => [op, abs(dir, rel)]),
      );
    });
  }

  it('mkdtemp 带路径分隔符 / .. 的 prefix:提前拒绝,仍被记下', async () => {
    const { dir, audit, ctx } = await setup();
    for (const prefix of ['a/b-', '..x', 'a\\b']) {
      audit.reset();
      await expect(safe.mkdtemp(ctx, path.join(dir, A), prefix)).rejects.toBeInstanceOf(
        WriteDeniedError,
      );
      expect(audit.calls).toEqual([{ op: 'mkdtemp', path: abs(dir, A) }]);
    }
  });

  it('一个 API 内部多次物理写只记一次(mkdirp 递归建多级目录、mkdtemp 先建 parent 再建临时目录)', async () => {
    const { dir, audit, ctx } = await setup();
    audit.reset();
    await safe.mkdirp(ctx, path.join(dir, A, 'a/b/c/d'));
    expect(audit.calls).toHaveLength(1);
    audit.reset();
    await safe.mkdtemp(ctx, path.join(dir, A, 'newparent'), 'p-');
    expect(audit.calls).toHaveLength(1);
  });

  it('相对路径按 repoRoot 解析后记录', async () => {
    const { dir } = await makeTempDir('safefs-audit-rel-');
    const audit = withWriteAudit();
    const ctx = createIoContext({
      cwd: REPO_ROOT,
      env: { KIT_TMP: dir, PATH: '/usr/bin:/bin' },
      writeAudit: audit.hook,
    });
    await safe.mkdirp(ctx, 'out/audit-rel-test').catch(() => undefined);
    expect(audit.calls[0]).toEqual({
      op: 'mkdirp',
      path: path.join(ctx.repoRoot, 'out/audit-rel-test'),
    });
    await safe.remove(ctx, 'out/audit-rel-test').catch(() => undefined);
  });
});

describe('写审计:未设置时与今天一致', () => {
  it('不设钩子:ctx 上没有 writeAudit 键,写入行为不变', async () => {
    const { dir } = await makeTempDir('safefs-audit-off-');
    const ctx = narrowCtx(dir, A);
    expect('writeAudit' in ctx).toBe(false);
    expect('writeAudit' in deriveIoContext(ctx, { writeRoots: ctx.writeRoots })).toBe(false);
    await safe.mkdirp(ctx, path.join(dir, A));
    await safe.writeFile(ctx, path.join(dir, A, 'f'), 'hi');
    expect(await readText(path.join(dir, A, 'f'))).toBe('hi');
    await expect(safe.writeFile(ctx, path.join(dir, 'o'), 'x')).rejects.toBeInstanceOf(
      WriteDeniedError,
    );
  });

  it('设钩子不改变写入结果(同样的写序列,文件内容一致)', async () => {
    const { dir } = await makeTempDir('safefs-audit-same-');
    const audit = withWriteAudit();
    const on = narrowCtx(dir, A, audit.hook);
    const off = narrowCtx(dir, A);
    await safe.mkdirp(off, path.join(dir, A));
    await safe.writeFile(on, path.join(dir, A, 'on'), 'same', { mode: 0o600 });
    await safe.writeFile(off, path.join(dir, A, 'off'), 'same', { mode: 0o600 });
    expect(await readText(path.join(dir, A, 'on'))).toBe(await readText(path.join(dir, A, 'off')));
  });
});

describe('写审计:外部累计,命令吞异常也不丢', () => {
  it('内部 try/catch 吞掉 WriteDeniedError,calls 仍记着那次写', async () => {
    const { dir, audit, ctx } = await setup();
    audit.reset();
    // 模拟「命令吞异常」:调用方自己把守卫的拒绝吞了、返回成功码
    const swallowingCommand = async (): Promise<number> => {
      try {
        await safe.writeFile(ctx, path.join(dir, 'escaped.txt'), 'x');
      } catch {
        // 吞掉
      }
      return 0;
    };
    expect(await swallowingCommand()).toBe(0);
    expect(await exists(path.join(dir, 'escaped.txt'))).toBe(false);
    expect(audit.calls).toEqual([{ op: 'writeFile', path: abs(dir, 'escaped.txt') }]);
  });
});

describe('写审计:派生上下文保留钩子', () => {
  it('deriveIoContext 派生出的上下文触发同一个钩子(收窄根后仍在)', async () => {
    const { dir, audit, ctx } = await setup();
    const sub = path.join(dir, A, 'inner');
    await safe.mkdirp(ctx, sub);
    audit.reset();
    const derived = deriveIoContext(ctx, { writeRoots: [sub] });
    expect(derived.writeAudit).toBe(audit.hook);
    await safe.writeFile(derived, path.join(sub, 'f'), 'x');
    await expect(safe.writeFile(derived, path.join(dir, A, 'g'), 'x')).rejects.toBeInstanceOf(
      WriteDeniedError,
    );
    expect(audit.calls.map((x) => x.op)).toEqual(['writeFile', 'writeFile']);
    // 二次派生同样保留
    const again = deriveIoContext(derived, { writeRoots: [sub] });
    await safe.writeFile(again, path.join(sub, 'h'), 'x');
    expect(audit.calls).toHaveLength(3);
  });

  it('overrides 不能替换或清掉钩子', async () => {
    const { audit, ctx } = await setup();
    const other = withWriteAudit();
    const sneaky = deriveIoContext(ctx, { writeAudit: other.hook } as never);
    expect(sneaky.writeAudit).toBe(audit.hook);
  });

  it('base 没有钩子时派生也没有', async () => {
    const { dir } = await makeTempDir('safefs-audit-derive-off-');
    expect(deriveIoContext(narrowCtx(dir, A)).writeAudit).toBeUndefined();
  });

  it('build 命令内部 narrowTo 派生的上下文也带钩子:经 main 的 build 写 out/ 时记录里有 out/ 路径', async () => {
    const sb = await makeSandbox('audit-build-derive-');
    const root = await writeRepo(sb, 'repo', await fullFiles());
    const audit = withWriteAudit();
    const code = await main(['--root', root, 'build'], {
      env: { PATH: '/usr/bin:/bin', KIT_REAL_HOME_OVERRIDE: sb.home, HOME: sb.home },
      cwd: REPO_ROOT,
      stdout: () => undefined,
      stderr: () => undefined,
      ...audit.mainEnv,
    });
    expect(code).toBe(0);
    const outWrites = audit.calls.filter((c) =>
      c.path.startsWith(path.join(root, 'out') + path.sep),
    );
    expect(outWrites.length).toBeGreaterThan(0);
    expect(outWrites.some((c) => c.op === 'writeFile')).toBe(true);
  });
});

describe('写审计:main() 真入口', () => {
  it('MainEnv 注入 writeAudit 后跑 build:calls 非空,路径在 repo 的 out/ 内', async () => {
    const sb = await makeSandbox('audit-main-');
    const root = await writeRepo(sb, 'repo', await fullFiles());
    const audit = withWriteAudit();
    const code = await main(['--root', root, 'build'], {
      env: { PATH: '/usr/bin:/bin', KIT_REAL_HOME_OVERRIDE: sb.home, HOME: sb.home },
      cwd: REPO_ROOT,
      stdout: () => undefined,
      stderr: () => undefined,
      ...audit.mainEnv,
    });
    expect(code).toBe(0);
    expect(audit.calls.length).toBeGreaterThan(0);
    expect(audit.calls.some((c) => c.path.startsWith(path.join(root, 'out')))).toBe(true);
  });

  it('不注入:与注入时产物逐字节一致(钩子无副作用),且只读命令(--help / --version)零记录', async () => {
    const sb = await makeSandbox('audit-main-same-');
    const a = await writeRepo(sb, 'repo-a', await fullFiles());
    const b = await writeRepo(sb, 'repo-b', await fullFiles());
    const plain = await runBuild(sb, a);
    const audit = withWriteAudit();
    const code = await main(['--root', b, 'build'], {
      env: { PATH: '/usr/bin:/bin', KIT_REAL_HOME_OVERRIDE: sb.home, HOME: sb.home },
      cwd: REPO_ROOT,
      stdout: () => undefined,
      stderr: () => undefined,
      ...audit.mainEnv,
    });
    expect(plain.code).toBe(0);
    expect(code).toBe(0);
    expect([...(await outTree(a))]).toEqual([...(await outTree(b))]);
    audit.reset();
    for (const argv of [['--help'], ['--version'], ['build', '--help']]) {
      await main(argv, {
        env: { PATH: '/usr/bin:/bin' },
        cwd: REPO_ROOT,
        stdout: () => undefined,
        stderr: () => undefined,
        ...audit.mainEnv,
      });
    }
    expect(audit.calls).toEqual([]);
  });
});

describe('写审计:双路径函数来源被拒也要记(入口审计早于来源校验)', () => {
  for (const [op, call] of [
    [
      'rename',
      (c: IoContext, d: string) => safe.rename(c, path.join(d, 'src-out'), path.join(d, A, 'dst')),
    ],
    [
      'copyFile',
      (c: IoContext, d: string) =>
        safe.copyFile(c, path.join(d, 'src-out'), path.join(d, A, 'dst')),
    ],
    [
      'hardlink',
      (c: IoContext, d: string) =>
        safe.hardlink(c, path.join(d, 'src-out'), path.join(d, A, 'dst')),
    ],
  ] as const) {
    it(`${op}:来源在根外、目标在根内 → 抛错,来源与目标两条都已记录`, async () => {
      const { dir, audit, ctx } = await setup();
      audit.reset();
      await expect(call(ctx, dir)).rejects.toBeInstanceOf(WriteDeniedError);
      expect(audit.calls.map((x) => [x.op, x.path])).toEqual([
        [`${op}.from`, abs(dir, 'src-out')],
        [op, abs(dir, `${A}/dst`)],
      ]);
    });
  }
});

describe('默认 readLine(createLineReader)', () => {
  it('同一 chunk 里的多行分次读出;\\r\\n 去掉回车;EOF 后返回剩余再返回 undefined,且不会挂起', async () => {
    const s = new PassThrough();
    const rl = createLineReader(s);
    s.write('yes\nno\r\npartial');
    expect(await rl()).toBe('yes');
    expect(await rl()).toBe('no');
    s.end();
    expect(await rl()).toBe('partial');
    expect(await rl()).toBeUndefined();
    expect(await rl()).toBeUndefined();
  });

  it('等待期间到达的数据与 EOF', async () => {
    const s = new PassThrough();
    const rl = createLineReader(s);
    const p = rl();
    s.write('a');
    s.write('b\n');
    expect(await p).toBe('ab');
    const q = rl();
    s.end();
    expect(await q).toBeUndefined();
  });
});

describe('CommandContext 的 isTty / readLine 注入点', () => {
  it('注入优先于默认', async () => {
    expect(resolveIsTty({ isTty: true })).toBe(true);
    expect(resolveIsTty({ isTty: false })).toBe(false);
    const rl = resolveReadLine({ readLine: async () => 'yes' });
    expect(await rl()).toBe('yes');
  });

  it('未注入:isTty 取 stdin 与 stdout 的组合,readLine 回落到默认实现', () => {
    expect(resolveIsTty({})).toBe(process.stdout.isTTY === true && process.stdin.isTTY === true);
    expect(typeof resolveReadLine({})).toBe('function');
  });
});
