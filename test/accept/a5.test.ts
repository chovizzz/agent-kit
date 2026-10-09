import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import {
  callLib,
  commitAll,
  guardRealHome,
  makeFx,
  putOutside,
  REPO_ROOT,
  runScript,
} from './helpers.js';
import type { Fx } from './helpers.js';

guardRealHome();

const COPY = [
  'ops/zero-write-check.sh',
  'ops/lib/lists.mjs',
  'ops/lib/main.mjs',
  'ops/lib/selftest.mjs',
  'ops/lib/snapshot.mjs',
  'ops/lib/zero-write.mjs',
  'ops/lib/fake-home-allow.txt',
  'ops/guards/no-net.cjs',
];

async function fixture(cliBody: string): Promise<{ fx: Fx; cli: string; home: string }> {
  const fx = await makeFx('a5-');
  for (const f of COPY)
    await fx.put(f, await readText(path.join(REPO_ROOT, f)), f.endsWith('.sh') ? 0o755 : undefined);
  await fx.put('ops/managed-paths.txt', '~/.claude/CLAUDE.md\n~/.claude/skills/\n');
  await fx.put('ops/volatile-paths.txt', '~/.claude/projects/**\n');
  await fx.put('kit.toml', '[kit]\nname = "x"\n');
  const home = path.join(fx.dir, 'real-home');
  await safe.mkdirp(fx.ctx, path.join(home, '.claude'));
  await safe.writeFile(fx.ctx, path.join(home, '.claude', 'CLAUDE.md'), 'mine\n');
  await commitAll(fx);
  const cli = await putOutside(fx, 'stub-cli.mjs', cliBody);
  return { fx, cli, home };
}

const a5 = (f: { fx: Fx; cli: string; home: string }, extra: string[] = ['--base-ref', 'HEAD']) =>
  runScript(
    'a5-zero-write.sh',
    ['--root', f.fx.root, '--cli', f.cli, '--home', f.home, ...extra],
    f.fx.env(),
  );

describe('A5 零写入(封装)', () => {
  it('什么都不写的 CLI => 0,且两轮都跑了(正向控制)', async () => {
    const f = await fixture('process.exit(0);');
    const r = a5(f);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('"rounds":2');
  }, 60_000);

  it('往假 HOME 写文件的 CLI => 1', async () => {
    const f = await fixture(
      `import * as fs from 'node:fs'; import * as path from 'node:path'; fs.writeFileSync(path.join(process.env.HOME, 'leak.txt'), 'x'); process.exit(0);`,
    );
    const r = a5(f);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain('FAKE_HOME_NOT_EMPTY');
  }, 60_000);

  it('命令桩(退出 64)=> 4,不是 1 也不是 0', async () => {
    const f = await fixture('process.exit(64);');
    const r = a5(f);
    expect(r.status, r.stdout + r.stderr).toBe(4);
    expect(r.stdout).toContain('命令桩');
  }, 60_000);

  it('命令真失败(退出 1)=> 1', async () => {
    const f = await fixture('process.exit(1);');
    expect(a5(f).status).toBe(1);
  }, 60_000);

  it('基线 ref 不可解析(默认 origin/main 在无远端的仓库里不存在)=> 4,不静默跳过基线比较', async () => {
    const f = await fixture('process.exit(0);');
    const r = a5(f, []);
    expect(r.status, r.stdout).toBe(4);
    expect(r.stdout).toContain('不可解析');
  }, 60_000);

  it('CLI 不存在 => 4', async () => {
    const f = await fixture('process.exit(0);');
    const r = runScript(
      'a5-zero-write.sh',
      [
        '--root',
        f.fx.root,
        '--cli',
        path.join(f.fx.dir, 'nope.js'),
        '--home',
        f.home,
        '--base-ref',
        'HEAD',
      ],
      f.fx.env(),
    );
    expect(r.status).toBe(4);
  });

  it('开跑前工作树有未提交改动 => 1(--require-clean-tree 生效)', async () => {
    const f = await fixture('process.exit(0);');
    await f.fx.put('dirty.txt', 'x\n');
    const r = a5(f);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('GIT_TREE_DIRTY_BEFORE');
  }, 60_000);
});

describe('interpretReport:补查 B17 没查的第二轮', () => {
  const rep = (r2: Record<string, unknown> | undefined, findings: unknown[] = []) => ({
    findings,
    rounds: r2 === undefined ? [{ commands: [] }] : [{ commands: [] }, r2],
  });
  const call = (exit: number, report: unknown) =>
    callLib('a5.mjs', 'interpretReport', [[exit, report]])[0] as {
      exit: number;
      reasons: string[];
    };

  it('两轮都干净 => 0(正向控制)', () => {
    const r = call(
      0,
      rep({
        commands: [{ cmd: 'x', code: 0 }],
        git_tree: { available: true, added: [], removed: [] },
        fake_home_leftovers: [],
      }),
    );
    expect(r.exit).toBe(0);
  });
  it('第二轮命令退出非 0 => 1;全是 64 => 4', () => {
    expect(call(0, rep({ commands: [{ cmd: 'x y z', code: 2 }] })).exit).toBe(1);
    expect(call(0, rep({ commands: [{ cmd: 'x y z', code: 64 }] })).exit).toBe(4);
  });
  it('第二轮 git 树变化 / 假 HOME 残留 => 1', () => {
    expect(
      call(0, rep({ commands: [], git_tree: { available: true, added: ['?? a'], removed: [] } }))
        .exit,
    ).toBe(1);
    expect(call(0, rep({ commands: [], fake_home_leftovers: ['x'] })).exit).toBe(1);
  });
  it('没有第二轮结果 => 1(--two-rounds 没生效不能当通过)', () => {
    expect(call(0, rep(undefined)).exit).toBe(1);
  });
  it('第一轮只有 64 的 COMMAND_ABNORMAL_EXIT => 4;混着别的 finding 或真失败 => 仍是 1', () => {
    const only64 = [
      { code: 'COMMAND_ABNORMAL_EXIT', commands: [{ cmd: 'a b c d', code: 64, abnormal: false }] },
    ];
    expect(call(1, rep(undefined, only64)).exit).toBe(4);
    const mixed = [...only64, { code: 'FAKE_HOME_NOT_EMPTY' }];
    expect(call(1, rep(undefined, mixed)).exit).toBe(1);
    const real = [
      {
        code: 'COMMAND_ABNORMAL_EXIT',
        commands: [
          { cmd: 'a', code: 64, abnormal: false },
          { cmd: 'b', code: 1, abnormal: false },
        ],
      },
    ];
    expect(call(1, rep(undefined, real)).exit).toBe(1);
  });
});
