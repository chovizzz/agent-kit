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

describe('interpretReport:按行允许的退出码(B5e)', () => {
  const rep = (cmds: unknown[]) => ({
    findings: [],
    rounds: [{ commands: [] }, { commands: cmds }],
  });
  const call = (exit: number, report: unknown) =>
    callLib('a5.mjs', 'interpretReport', [[exit, report]])[0] as { exit: number };

  it('第二轮:行内声明的码被接受(正向);声明之外的码仍 => 1;未声明的行只收 0', () => {
    expect(call(0, rep([{ cmd: 'x', code: 4, allowed_exit: [4] }])).exit).toBe(0);
    expect(call(0, rep([{ cmd: 'x', code: 0, allowed_exit: [4] }])).exit).toBe(1);
    expect(call(0, rep([{ cmd: 'x', code: 4 }])).exit).toBe(1);
    // 声明不吞 64:声明里没有 64 时,64 仍按「命令桩」归 4(不是 0)
    expect(call(0, rep([{ cmd: 'x', code: 64, allowed_exit: [0, 4] }])).exit).toBe(4);
  });
});

// ---- rsi 两环境(包形态桩 CLI:有 package.json,所以 a5 把 rsi 干跑命令与 armed 环境纳入)----
// 桩按 argv 返回 R20 干跑 / 被拒命令在 off / armed 两种环境下的退出码(与 ops/accept/lib/a5.mjs 的 RSI_DRY 表对照:不一致就红)
const RSI_TABLE = {
  tick: { off: 4, armed: 0 },
  'tick --json': { off: 4, armed: 0 },
  status: { off: 0, armed: 0 },
  'status --json': { off: 0, armed: 0 },
  projects: { off: 0, armed: 0 },
  'projects --json': { off: 0, armed: 0 },
  'projects --rebuild-index': { off: 4, armed: 4 },
  'purge --excluded': { off: 4, armed: 4 },
  'purge --resume': { off: 4, armed: 4 },
  confirm: { off: 2, armed: 2 },
};

function rsiStub(extra = ''): string {
  return `import * as fs from 'node:fs'; import * as path from 'node:path';
const a = process.argv.slice(2);
const i = a.indexOf('rsi');
if (i < 0) process.exit(0);
const cfg = path.join(process.env.HOME, '.config', 'agent-kit', 'config.toml');
const armed = fs.existsSync(cfg);
const table = ${JSON.stringify(RSI_TABLE)};
const row = table[a.slice(i + 1).join(' ')];
if (!row) process.exit(99);
${extra}
process.exit(armed ? row.armed : row.off);`;
}

async function pkgFixture(stub: string): Promise<{ fx: Fx; cli: string; home: string }> {
  const f = await fixture('process.exit(0);');
  const pkg = path.join(f.fx.dir, 'pkg');
  await safe.mkdirp(f.fx.ctx, path.join(pkg, 'dist'));
  await safe.mkdirp(f.fx.ctx, path.join(pkg, 'payload'));
  await safe.writeFile(f.fx.ctx, path.join(pkg, 'package.json'), '{"name":"stub"}\n');
  await safe.writeFile(f.fx.ctx, path.join(pkg, 'payload', 'manifest.json'), '{}\n');
  const cli = path.join(pkg, 'dist', 'cli.js');
  await safe.writeFile(f.fx.ctx, cli, `#!/usr/bin/env node\n${stub}\n`);
  await safe.chmod(f.fx.ctx, cli, 0o755);
  return { ...f, cli };
}

describe('A5 rsi 干跑命令:off / armed 两环境,每个环境两轮', () => {
  it('正向:桩按表返回 => 0;两个环境都跑(各自两轮),rsi 命令行带逐行 exit 声明', async () => {
    const f = await pkgFixture(rsiStub());
    const r = a5(f);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('zero-write-check(off)');
    expect(r.stdout).toContain('zero-write-check(armed)');
    expect(r.stdout.match(/"rounds":2/g)?.length).toBeGreaterThanOrEqual(2);
    expect(r.stdout).toContain('armed 环境:被测仓库');
  }, 120_000);

  it('off 环境某条命令的退出码偏离声明(tick 在 off 下退 0 而不是 4)=> 1(逐行声明,不全局放开);对照:正向用例同一桩未偏离 => 0', async () => {
    const f = await pkgFixture(
      rsiStub("if (!armed && a.slice(i + 1).join(' ') === 'tick') process.exit(0);"),
    );
    const r = a5(f);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('COMMAND_ABNORMAL_EXIT');
  }, 120_000);

  it('armed 环境命令偏离声明(projects --rebuild-index 退 0)=> 1', async () => {
    const f = await pkgFixture(
      rsiStub(
        "if (armed && a.slice(i + 1).join(' ') === 'projects --rebuild-index') process.exit(0);",
      ),
    );
    const r = a5(f);
    expect(r.status, r.stdout).toBe(1);
  }, 120_000);

  it('预置的 config.toml 被改写 => 1 SEEDED_PATH_CHANGED(预置不是白名单);对照:正向用例里它存在且不变', async () => {
    const f = await pkgFixture(rsiStub("if (armed) fs.appendFileSync(cfg, '# touched\\n');"));
    const r = a5(f);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('SEEDED_PATH_CHANGED');
  }, 120_000);

  it('off 环境往 .config/agent-kit/config.toml 写 => 1 FAKE_HOME_NOT_EMPTY(没有预置的轮不放宽)', async () => {
    const f = await pkgFixture(
      rsiStub(
        "if (!armed) { fs.mkdirSync(path.dirname(cfg), { recursive: true }); fs.writeFileSync(cfg, 'x'); }",
      ),
    );
    const r = a5(f);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('FAKE_HOME_NOT_EMPTY');
  }, 120_000);

  it('armed 环境的干跑命令创建了 .state/rsi => 1;被测仓库事先就有 .state/rsi => 4(读到的不是首次 armed)', async () => {
    const f = await pkgFixture(
      rsiStub(
        "if (armed) { const d = path.join(process.argv[process.argv.indexOf('--root') + 1], '.state', 'rsi'); fs.mkdirSync(d, { recursive: true }); }",
      ),
    );
    const bad = a5(f);
    expect(bad.status, bad.stdout).toBe(1);
    expect(bad.stdout).toContain('创建了 rsi 状态');
    const g = await pkgFixture(rsiStub());
    await safe.mkdirp(g.fx.ctx, path.join(g.fx.root, '.state', 'rsi'));
    const pre = a5(g);
    expect(pre.status, pre.stdout).toBe(4);
    expect(pre.stdout).toContain('事先不存在');
  }, 120_000);

  it('悬空符号链接也算创建了状态树(lstat,不是 existsSync):armed 环境里干跑命令留下 .state/rsi -> 不存在的目标 => 1;事先就有悬空链接 => 4', async () => {
    const link =
      "const root = process.argv[process.argv.indexOf('--root') + 1]; fs.mkdirSync(path.join(root, '.state'), { recursive: true }); fs.symlinkSync('/nonexistent-b5e-target', path.join(root, '.state', 'rsi'));";
    const f = await pkgFixture(rsiStub(`if (armed) { ${link} }`));
    const bad = a5(f);
    expect(bad.status, bad.stdout).toBe(1);
    expect(bad.stdout).toContain('创建了 rsi 状态');
    const g = await pkgFixture(rsiStub());
    await safe.mkdirp(g.fx.ctx, path.join(g.fx.root, '.state'));
    await safe.symlink(
      g.fx.ctx,
      path.join(g.fx.dir, 'nowhere-b5e'),
      path.join(g.fx.root, '.state', 'rsi'),
    ); // 目标不存在:悬空链接
    const pre = a5(g);
    expect(pre.status, pre.stdout).toBe(4);
    expect(pre.stdout).toContain('事先不存在');
  }, 120_000);

  it('off 环境的命令创建了状态树 => 1(违规),不是被归成「检出不干净」的 4,也不再跑 armed 环境', async () => {
    const f = await pkgFixture(
      rsiStub(
        "if (!armed) { const root = process.argv[process.argv.indexOf('--root') + 1]; fs.mkdirSync(path.join(root, '.state', 'rsi'), { recursive: true }); }",
      ),
    );
    const r = a5(f);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('off 环境的命令创建了 rsi 状态');
    expect(r.stdout).not.toContain('zero-write-check(armed)');
  }, 120_000);

  it('COPY 清单覆盖 a5 依赖的 ops 脚本:每个文件在仓库里存在(新增 ops/lib 文件必须同步进 COPY)', async () => {
    for (const rel of COPY) {
      expect(await readText(path.join(REPO_ROOT, rel)), rel).not.toBe('');
    }
    // zero-write.mjs 的 import 全部在 COPY 里(不漏复制导致夹具里「找不到模块」)
    const src = await readText(path.join(REPO_ROOT, 'ops/lib/zero-write.mjs'));
    for (const m of src.matchAll(/from '\.\/([a-z-]+\.mjs)'/g)) {
      expect(COPY).toContain(`ops/lib/${m[1]}`);
    }
  });
});
