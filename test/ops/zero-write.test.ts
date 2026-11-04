import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSync } from '../../src/io/exec.js';
import { readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { GIT_NO_AUTO_ARGS, GIT_NO_AUTO_CONFIG } from '../helpers/git-quiet.js';
import { REPO_ROOT } from '../helpers/tmp.js';
import { makeFixture, runMain, runNode } from './helpers.js';
import type { Fixture } from './helpers.js';

const MANAGED = `~/.claude/CLAUDE.md
~/.claude/hooks/*.sh
~/.claude/skills/
~/.config/agent-kit/
~/.local/state/agent-kit/
`;
const VOLATILE = `~/.claude/projects/**
**/.DS_Store
`;

interface Report {
  exit: number;
  findings: { code: string }[];
  rounds?: unknown[];
}

async function seed(fx: Fixture): Promise<void> {
  await fx.put('.claude/CLAUDE.md', 'a\n');
  await fx.put('.claude/hooks/a.sh', 'echo\n');
  await fx.put('.claude/skills/s1/SKILL.md', '# s1\n');
  await fx.put('.claude/projects/p/s.jsonl', '{}\n');
}

/** 跑一遍 zero-write;命令清单写进 fixture 仓库。返回退出码与 report.json。 */
async function zw(
  fx: Fixture,
  commands: string,
  extra: string[] = [],
): Promise<{ status: number | null; report: Report; stdout: string }> {
  const cmds = await fx.repoPut('cmds.txt', commands + '\n');
  const outRoot = path.join(fx.out, 'zw');
  const r = runMain([
    '--repo',
    fx.repo,
    '--home',
    fx.home,
    '--base-ref',
    '',
    '--commands-file',
    cmds,
    '--out-root',
    outRoot,
    '--tmp',
    fx.dir,
    '--require-success',
    ...(extra.includes('--settle-ms') ? [] : ['--settle-ms', '120']),
    ...extra,
  ]);
  // report.json 在 out-root/<ts>/ 下;只有一个子目录
  const m = /报告:(.+)/.exec(r.stdout);
  const report = m
    ? (JSON.parse(await readText(path.join(m[1] as string, 'report.json'))) as Report)
    : ({ exit: r.status ?? -1, findings: [] } as Report);
  return { status: r.status, report, stdout: r.stdout };
}
const NODE0 = `${process.execPath} -e "0"`;
const codes = (r: { report: Report }): string[] => r.report.findings.map((f) => f.code);

describe('A5 主判据:假 HOME 必须为空', () => {
  it('正向对照:什么都不写 => 通过(退出 0)', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    const r = await zw(fx, NODE0);
    expect(r.status).toBe(0);
    expect(codes(r)).toEqual([]);
  });

  it('往假 HOME 写一个文件 => 报错(退出 1,FAKE_HOME_NOT_EMPTY)', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    const r = await zw(fx, `/bin/sh -c "echo x > {HOME}/leak.txt"`);
    expect(r.status).toBe(1);
    expect(codes(r)).toContain('FAKE_HOME_NOT_EMPTY');
  });

  it('隐藏缓存目录(.cache/.npm 一类)里的深层写入也报错', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    const r = await zw(
      fx,
      `/bin/sh -c "mkdir -p {HOME}/.npm/_cacache && echo x > {HOME}/.npm/_cacache/i"`,
    );
    expect(r.status).toBe(1);
    expect(codes(r)).toContain('FAKE_HOME_NOT_EMPTY');
  });

  it('例外清单里明列的路径不算残留,清单外的仍算', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    const allow = await fx.repoPut('allow.txt', '# 例外\n.allowed-cache/\n');
    const ok = await zw(
      fx,
      `/bin/sh -c "mkdir -p {HOME}/.allowed-cache && echo x > {HOME}/.allowed-cache/f"`,
      ['--allow-file', allow],
    );
    expect(ok.status).toBe(0);
    const bad = await zw(
      fx,
      `/bin/sh -c "mkdir -p {HOME}/.allowed-cache {HOME}/other && echo x > {HOME}/other/f"`,
      ['--allow-file', allow],
    );
    expect(bad.status).toBe(1);
  });

  it('命令在干净环境里跑:HOME 是假 HOME、带 KIT_WRITE_ROOTS 双保险、不继承调用方环境', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    // 检查脚本在假 HOME 之外;任何一条不成立就以非 0 退出(zw() 带 --require-success,于是整体失败)
    const chk = await fx.repoPut(
      'chk.sh',
      [
        'set -eu',
        '[ "$HOME" = "$1" ]',
        '[ -z "${KIT_OPS_NO_REAL_HOME:-}" ]  # 调用方的环境变量没有漏进来',
        '[ -z "${XDG_CACHE_HOME:-}${XDG_CONFIG_HOME:-}${CODEX_HOME:-}" ]',
        '[ -z "${NODE_OPTIONS:-}" ]',
        'case "$KIT_WRITE_ROOTS" in *"/out:"*"/.state") ;; *) exit 12 ;; esac',
        '[ -n "$KIT_TMP" ] && [ "${KIT_TMP#"$HOME"}" = "$KIT_TMP" ]  # KIT_TMP 不在假 HOME 里',
        '[ "$GIT_CONFIG_GLOBAL" = /dev/null ]',
        '',
      ].join('\n'),
    );
    const ok = await zw(fx, `/bin/sh ${chk} {HOME}`);
    expect(ok.status, JSON.stringify(ok.report.findings)).toBe(0);
    // 反向:--no-net 会设置 NODE_OPTIONS,上面那条 [ -z NODE_OPTIONS ] 随之失败 => 证明脚本在检查真东西
    const withNet = await zw(fx, `/bin/sh ${chk} {HOME}`, ['--no-net']);
    expect(withNet.status).toBe(1);
    expect(codes(withNet)).toContain('COMMAND_ABNORMAL_EXIT');
  });

  it('未知选项不会被静默吞掉(退出 2)', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    expect(runMain(['--repo', fx.repo, '--no-such-flag']).status).toBe(2);
  });
});

describe('A5 副判据:受管路径快照', () => {
  it('往受管文件写 => 报错(退出 1)', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    const r = await zw(fx, `/bin/sh -c "echo $$ > {REALHOME}/.claude/CLAUDE.md"`);
    expect(r.status).toBe(1);
    expect(codes(r)).toContain('MANAGED_PATH_WRITTEN_DURING_RUN');
  });

  it('往受管目录里新增文件 / 新增 glob 匹配 / 创建套件自己的位置 => 报错', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    for (const cmd of [
      `/bin/sh -c "echo $$ > {REALHOME}/.claude/skills/s1/extra.md"`,
      `/bin/sh -c "echo $$ > {REALHOME}/.claude/hooks/b.sh"`,
      `/bin/sh -c "mkdir -p {REALHOME}/.config/agent-kit && echo $$ > {REALHOME}/.config/agent-kit/state"`,
    ]) {
      const r = await zw(fx, cmd);
      expect(r.status, cmd).toBe(1);
      expect(codes(r), cmd).toContain('MANAGED_PATH_WRITTEN_DURING_RUN');
      await fx.remove('.config');
      await fx.remove('.claude/hooks/b.sh');
      await fx.remove('.claude/skills/s1/extra.md');
    }
  });

  it('内容不变的 touch 也抓得到(退出 1);mv 旧文件进受管路径不被静默放过', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    const touch = await zw(fx, `/bin/sh -c "touch {REALHOME}/.claude/CLAUDE.md"`);
    expect(touch.status).toBe(1);
    expect(codes(touch)).toContain('MANAGED_PATH_WRITTEN_DURING_RUN');
    await fx.repoPut('old.txt', 'old\n');
    const mv = await zw(
      fx,
      `/bin/sh -c "if [ -e {REPO}/old.txt ]; then mv {REPO}/old.txt {REALHOME}/.claude/CLAUDE.md; fi"`,
    );
    expect(mv.status).not.toBe(0);
    expect(codes(mv)).toContain('ATTRIBUTION_REQUIRED');
  });

  it('只在第二次调用才写的命令:默认不跑第二轮会漏,--two-rounds 抓得到', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    const cmd = `/bin/sh -c "if [ -e {REPO}/marker ]; then echo $$ >> {REALHOME}/.claude/CLAUDE.md; else touch {REPO}/marker; fi"`;
    const without = await zw(fx, cmd);
    expect(without.status).toBe(0); // 已知局限:单轮看不出来,所以验收要带 --two-rounds
    await fx.remove('../repo/marker');
    const withTwo = await zw(fx, cmd, ['--two-rounds']);
    expect(withTwo.status).not.toBe(0);
  });

  it('只写 volatile 路径 => 不报(退出 0)', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    const r = await zw(
      fx,
      `/bin/sh -c "echo $$ >> {REALHOME}/.claude/projects/p/s.jsonl; echo x > {REALHOME}/.claude/skills/.DS_Store"`,
    );
    expect(r.status).toBe(0);
  });

  it('"只在第一轮写"的 create-once 不会被静默放过(退出 5 待人工归因)', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    const r = await zw(
      fx,
      `/bin/sh -c "[ -e {REALHOME}/.claude/hooks/once.sh ] || echo x > {REALHOME}/.claude/hooks/once.sh"`,
    );
    expect(r.status).toBe(5);
    expect(codes(r)).toContain('ATTRIBUTION_REQUIRED');
  });

  it('套件自己的位置事先存在 => 报错,除非显式允许', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    await fx.put('.local/state/agent-kit/x', '1');
    expect((await zw(fx, NODE0)).status).toBe(1);
    expect((await zw(fx, NODE0, ['--allow-kit-paths-present'])).status).toBe(0);
  });

  it('被测命令异常退出不被当作通过', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    const r = await zw(fx, `/bin/sh -c "exit 3"`);
    expect(r.status).toBe(1);
    expect(codes(r)).toContain('COMMAND_ABNORMAL_EXIT');
    // 默认接受 64(未实现桩),--require-success 时不接受
    const stub = await zw(fx, `/bin/sh -c "exit 64"`, []);
    expect(stub.status).toBe(1); // zw() 已带 --require-success
  });

  it('未预期异常(--tmp 指向普通文件,建临时目录失败)=> 退出 4(未执行),不落成 node 默认的 1(违规)', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    const notDir = await fx.repoPut('not-a-dir', 'x\n');
    const bad = await zw(fx, NODE0, ['--tmp', notDir]);
    expect(bad.status).toBe(4);
    expect(bad.stdout).toBe('');
    // 正向对照:同样的输入换成真目录就是正常通过(0),说明上面的 4 来自那个异常而不是别的
    expect((await zw(fx, NODE0)).status).toBe(0);
  });

  it('缺 dist/cli.js 且用默认命令 => 退出 4(未执行),不当作通过', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    const r = runMain([
      '--repo',
      fx.repo,
      '--home',
      fx.home,
      '--base-ref',
      '',
      '--out-root',
      path.join(fx.out, 'zw'),
      '--tmp',
      fx.dir,
    ]);
    expect(r.status).toBe(4);
    expect(r.stdout).toContain('DIST_MISSING');
  });
});

describe('清单卫生:禁止把 managed 路径挪进 volatile', () => {
  it('volatile 覆盖 managed 字面文件 / 目录 / 通配 => 拒绝(退出 3)', async () => {
    for (const extra of [
      '~/.claude/CLAUDE.md\n',
      '~/.claude/skills/\n',
      '~/.claude/**\n',
      '~/.claude/hooks/*.sh\n',
      '~/.claude/hooks/**\n',
    ]) {
      const fx = await makeFixture(MANAGED, VOLATILE + extra);
      await seed(fx);
      const r = runMain(['lists-check', '--repo', fx.repo, '--home', fx.home, '--base-ref', '']);
      expect(r.status, extra).toBe(3);
      expect(r.stdout, extra).toContain('MANAGED_COVERED_BY_VOLATILE');
    }
  });

  it('正向对照:合法清单(volatile 与 managed 不重叠)通过', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    const r = runMain(['lists-check', '--repo', fx.repo, '--home', fx.home, '--base-ref', '']);
    expect(r.status).toBe(0);
  });

  it('清单被拒时 zero-write 不运行任何命令(退出 3)', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE + '~/.claude/CLAUDE.md\n');
    await seed(fx);
    const r = await zw(fx, `/bin/sh -c "echo x > {HOME}/leak"`);
    expect(r.status).toBe(3);
    expect(r.stdout).toContain('MANAGED_COVERED_BY_VOLATILE');
  });

  it('对照 git 基线:managed 行被删并挪进 volatile => 拒绝;单纯删除也拒绝,除非显式允许', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    const git = (args: string[]): void => {
      const r = runSync(fx.ctx, 'git', [
        '-C',
        fx.repo,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...GIT_NO_AUTO_ARGS,
        ...args,
      ]);
      expect(r.status, r.stderr).toBe(0);
    };
    git(['init', '-q']);
    for (const [k, v] of GIT_NO_AUTO_CONFIG) git(['config', k, v]);
    git(['add', 'ops']);
    git(['commit', '-q', '-m', 'base']);
    // 基线 == 现状 => 通过
    expect(
      runMain(['lists-check', '--repo', fx.repo, '--home', fx.home, '--base-ref', 'HEAD']).status,
    ).toBe(0);
    // 把 managed 里的 settings 行挪到 volatile
    const withSettings = MANAGED + '~/.claude/settings.json\n';
    await safe.writeFile(fx.ctx, path.join(fx.repo, 'ops/managed-paths.txt'), withSettings);
    git(['add', 'ops']);
    git(['commit', '-q', '-m', 'add settings']);
    await safe.writeFile(fx.ctx, path.join(fx.repo, 'ops/managed-paths.txt'), MANAGED);
    await safe.writeFile(
      fx.ctx,
      path.join(fx.repo, 'ops/volatile-paths.txt'),
      VOLATILE + '~/.claude/settings.json\n',
    );
    const moved = runMain([
      'lists-check',
      '--repo',
      fx.repo,
      '--home',
      fx.home,
      '--base-ref',
      'HEAD',
    ]);
    expect(moved.status).toBe(3);
    expect(moved.stdout).toContain('MANAGED_MOVED_TO_VOLATILE');
    // 单纯删除(volatile 不动)
    await safe.writeFile(fx.ctx, path.join(fx.repo, 'ops/volatile-paths.txt'), VOLATILE);
    const removed = runMain([
      'lists-check',
      '--repo',
      fx.repo,
      '--home',
      fx.home,
      '--base-ref',
      'HEAD',
    ]);
    expect(removed.status).toBe(3);
    expect(removed.stdout).toContain('MANAGED_REMOVED');
    expect(
      runMain([
        'lists-check',
        '--repo',
        fx.repo,
        '--home',
        fx.home,
        '--base-ref',
        'HEAD',
        '--allow-managed-removal',
      ]).status,
    ).toBe(0);
  });
});

describe('adapter 元数据取并集(合成 managed-targets.json,L-4)', () => {
  const targets = (list: string[]): string =>
    JSON.stringify({ agent: 'claude', tested_versions: [], managed_targets: list });

  it('手写清单没登记的 adapter 落点被报出(退出 3);登记后通过', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await fx.repoPut(
      'adapters/claude/managed-targets.json',
      targets(['~/.claude/rules/agent-kit/core.md', '~/.claude/CLAUDE.md', 'AGENTS.md']),
    );
    const r = runMain(['lists-check', '--repo', fx.repo, '--home', fx.home, '--base-ref', '']);
    expect(r.status).toBe(3);
    expect(r.stdout).toContain('ADAPTER_TARGET_UNREGISTERED');
    expect(r.stdout).toContain('~/.claude/rules/agent-kit/core.md');
    expect(r.stdout).not.toContain('"managed":"~/.claude/CLAUDE.md"'); // 已被手写清单覆盖
    expect(r.stdout).not.toContain('"managed":"AGENTS.md"'); // 项目级相对路径不在 HOME 快照范围
    await safe.writeFile(
      fx.ctx,
      path.join(fx.repo, 'ops/managed-paths.txt'),
      MANAGED + '~/.claude/rules/\n',
    );
    expect(
      runMain(['lists-check', '--repo', fx.repo, '--home', fx.home, '--base-ref', '']).status,
    ).toBe(0);
  });

  it('adapter 清单存在但解析失败 / 形状不对 => 清单错误(退出 3,ADAPTER_MANIFEST_INVALID),不再悄悄跳过', async () => {
    const bad: [string, string, string][] = [
      ['坏 JSON', '{ not json', 'invalid_json'],
      [
        'managed_targets 缺失',
        JSON.stringify({ agent: 'claude' }),
        'managed_targets_not_string_array',
      ],
      [
        'managed_targets 不是数组',
        JSON.stringify({ managed_targets: '~/.claude/' }),
        'managed_targets_not_string_array',
      ],
      [
        '含非字符串元素',
        JSON.stringify({ managed_targets: ['~/.claude/CLAUDE.md', 7] }),
        'managed_targets_not_string_array',
      ],
      ['顶层是 null', 'null', 'managed_targets_not_string_array'],
    ];
    for (const [name, body, reason] of bad) {
      const fx = await makeFixture(MANAGED, VOLATILE);
      await fx.repoPut('adapters/claude/managed-targets.json', body);
      const r = runMain(['lists-check', '--repo', fx.repo, '--home', fx.home, '--base-ref', '']);
      expect(r.status, name).toBe(3);
      expect(r.stdout, name).toContain('ADAPTER_MANIFEST_INVALID');
      expect(r.stdout, name).toContain(reason);
      // 完整的零写入流程同样拒绝(不是只有 lists-check)
      const z = runMain([
        '--repo',
        fx.repo,
        '--home',
        fx.home,
        '--base-ref',
        '',
        '--commands-file',
        await fx.repoPut('cmds.txt', NODE0 + '\n'),
        '--out-root',
        path.join(fx.out, 'zw'),
        '--tmp',
        fx.dir,
      ]);
      expect(z.status, name).toBe(3);
    }
  });

  it('snap 是诊断命令不退出 3,但清单坏了要在 stderr 留一行 WARN(不能零痕迹)', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await fx.repoPut('adapters/claude/managed-targets.json', '{ nope');
    const r = runMain(['snap', '--repo', fx.repo, '--home', fx.home, '--base-ref', '']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('ADAPTER_MANIFEST_INVALID');
  });

  it('snap 遇坏清单:快照 JSON 自描述不完整(stats.adapter_manifest_* + notes);好清单的快照没有这些字段', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await fx.repoPut('adapters/claude/managed-targets.json', targets(['~/.claude/CLAUDE.md']));
    const good = runMain(['snap', '--repo', fx.repo, '--home', fx.home, '--base-ref', '']);
    expect(good.status).toBe(0);
    const g = JSON.parse(good.stdout) as { stats: Record<string, unknown>; notes?: string[] };
    expect(g.stats['adapter_manifest_invalid']).toBeUndefined();
    expect(g.notes).toBeUndefined();
    await fx.repoPut('adapters/codex/managed-targets.json', '{ nope');
    const bad = runMain(['snap', '--repo', fx.repo, '--home', fx.home, '--base-ref', '']);
    expect(bad.status).toBe(0);
    const b = JSON.parse(bad.stdout) as { stats: Record<string, unknown>; notes?: string[] };
    expect(b.stats['adapter_manifest_invalid']).toBe(1);
    expect(b.stats['adapter_manifest_errors']).toEqual([
      { adapter: 'codex', reason: 'invalid_json' },
    ]);
    expect(b.notes?.[0]).toContain('ADAPTER_MANIFEST_INVALID');
  });

  it('每份零写入报告固定带「只保证窗口结束时受管路径无残留写入」的 NOTE(B17 盲区 ①)', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    const r = await zw(fx, NODE0);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('NOTE 零写入检查只保证窗口结束时受管路径无残留写入');
  });

  it('ops/accept 的调用方(real-home-guard / a19 / a22)经 adapterTargetsChecked:坏清单 => FAIL 或抛错,好清单 => 照常取 targets', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    const script = `
      const g = await import(${JSON.stringify(path.join(REPO_ROOT, 'ops/accept/lib/real-home-guard.mjs'))});
      const snap = await import(${JSON.stringify(path.join(REPO_ROOT, 'ops/lib/snapshot.mjs'))});
      const fails = [];
      const R = { fail: (m) => fails.push(m) };
      const targets = g.adapterTargetsChecked(snap, ${JSON.stringify(fx.repo)}, R);
      let thrown = null;
      try { g.adapterTargetsChecked(snap, ${JSON.stringify(fx.repo)}); } catch (e) { thrown = String(e.message); }
      process.stdout.write(JSON.stringify({ targets, fails, thrown }));
    `;
    const run = (): { targets: string[]; fails: string[]; thrown: string | null } => {
      const r = runNode(['--input-type=module', '-e', script]);
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(r.stdout) as { targets: string[]; fails: string[]; thrown: string | null };
    };
    await fx.repoPut('adapters/claude/managed-targets.json', targets(['~/.claude/CLAUDE.md']));
    expect(run()).toEqual({ targets: ['~/.claude/CLAUDE.md'], fails: [], thrown: null });
    await fx.repoPut('adapters/codex/managed-targets.json', '{ nope');
    const bad = run();
    expect(bad.fails).toHaveLength(1);
    expect(bad.fails[0]).toContain('ADAPTER_MANIFEST_INVALID');
    expect(bad.thrown).toContain('ADAPTER_MANIFEST_INVALID');
    // 三个调用方都必须经它(不再直接取 .targets)
    for (const f of ['real-home-guard.mjs', 'a19.mjs', 'a22.mjs']) {
      const src = await readText(path.join(REPO_ROOT, 'ops/accept/lib', f));
      expect(src, f).toContain('adapterTargetsChecked(');
      expect(src, f).not.toMatch(/readAdapterTargets\([^)]*\)\.targets/);
    }
  });

  it('adapters/ 下出现普通文件(ENOTDIR)=> 清单错误,退出 3;点文件(.DS_Store)不算;正向对照:adapter 目录正常', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await fx.repoPut('adapters/claude/managed-targets.json', targets(['~/.claude/CLAUDE.md']));
    await fx.repoPut('adapters/.DS_Store', 'junk');
    const ok = runMain(['lists-check', '--repo', fx.repo, '--home', fx.home, '--base-ref', '']);
    expect(ok.status, ok.stdout).toBe(0);
    await fx.repoPut('adapters/stray-file', 'not a directory');
    const bad = runMain(['lists-check', '--repo', fx.repo, '--home', fx.home, '--base-ref', '']);
    expect(bad.status).toBe(3);
    expect(bad.stdout).toContain('ADAPTER_MANIFEST_INVALID');
    expect(bad.stdout).toContain('adapter_entry_not_directory');
  });

  it('正向对照:adapter 清单文件不存在(目录里没有 managed-targets.json)=> 仍跳过,退出 0', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await fx.repoPut('adapters/claude/index.ts', '// no manifest\n');
    await fx.repoPut('adapters/codex/managed-targets.json', targets(['~/.claude/CLAUDE.md']));
    const r = runMain(['lists-check', '--repo', fx.repo, '--home', fx.home, '--base-ref', '']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('ADAPTER_MANIFEST_INVALID');
  });

  it('adapter 落点参与快照(取并集),标注来源', async () => {
    const fx = await makeFixture(MANAGED + '~/.claude/rules/\n', VOLATILE);
    await fx.repoPut('adapters/codex/managed-targets.json', targets(['~/.codex/agents/']));
    const o = path.join(fx.out, 'u');
    expect(
      runMain(['snap', '--repo', fx.repo, '--home', fx.home, '--base-ref', '', '--out-root', o])
        .status,
    ).toBe(0);
    const s = JSON.parse(await readText(path.join(o, 'snapshot.json'))) as {
      paths: Record<string, unknown>;
      sources: Record<string, string[]>;
    };
    expect(s.paths['~/.codex/agents']).toEqual({ t: 'absent' });
    expect(s.sources['~/.codex/agents']).toEqual(['adapter']);
    // 之后该落点被写入 => 差异可见
    await fx.put('.codex/agents/x.toml', 'a');
    const o2 = path.join(fx.out, 'u2');
    runMain(['snap', '--repo', fx.repo, '--home', fx.home, '--base-ref', '', '--out-root', o2]);
    expect(
      runMain(['diff', path.join(o, 'snapshot.json'), path.join(o2, 'snapshot.json')]).status,
    ).toBe(1);
  });
});

describe('自检(--selftest)与真实仓库清单', () => {
  it('--selftest 全部 28 项符合预期(检测器会红也会绿)', () => {
    const r = runMain(['--selftest', '--tmp', path.join(REPO_ROOT, '.state', 'test-tmp')]);
    expect(r.stdout).not.toContain('FAIL');
    expect(r.stdout).toMatch(/selftest: 28\/28/);
    expect(r.status).toBe(0);
  }, 120_000); // 自检 28 项各跑一遍(含静置),全仓并行时可能超过默认 20s

  it('仓库自带的 managed/volatile 清单通过卫生检查(不重叠),且内容符合设计初始值', async () => {
    const fx = await makeFixture('', '');
    const r = runMain([
      'lists-check',
      '--repo',
      fx.repo,
      '--home',
      fx.home,
      '--base-ref',
      '',
      '--managed',
      path.join(REPO_ROOT, 'ops/managed-paths.txt'),
      '--volatile',
      path.join(REPO_ROOT, 'ops/volatile-paths.txt'),
    ]);
    expect(r.status, r.stdout).toBe(0);
    const managed = await readText(path.join(REPO_ROOT, 'ops/managed-paths.txt'));
    const volatile = await readText(path.join(REPO_ROOT, 'ops/volatile-paths.txt'));
    for (const must of [
      '~/.claude/CLAUDE.md',
      '~/.claude/hooks/*.sh',
      '~/.agents/skills/',
      '~/.config/agent-kit/',
      '~/.local/state/agent-kit/',
      '~/workspace/AGENTS.md',
    ]) {
      expect(managed).toContain(must);
    }
    for (const must of [
      '~/.claude/projects/**',
      '~/.codex/sessions/**',
      '~/.codex/memories*',
      '**/.DS_Store',
    ]) {
      expect(volatile).toContain(must);
    }
    // 没有任何 managed 条目字面出现在 volatile 里
    const mLines = managed.split('\n').filter((l) => l && !l.startsWith('#'));
    const vLines = new Set(volatile.split('\n').filter((l) => l && !l.startsWith('#')));
    expect(mLines.filter((l) => vLines.has(l))).toEqual([]);
  });
});
