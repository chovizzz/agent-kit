// B20:独立评审在零写入验收里找到的缺口(ZW-*)的复现与回归。全部在仓库外的合成 HOME / 合成仓库里跑。
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readText } from '../../src/io/read-fs.js';
import { runSync } from '../../src/io/exec.js';
import * as safe from '../../src/io/safe-fs.js';
import { makeFixture, runMain } from './helpers.js';
import type { Fixture } from './helpers.js';

interface Report {
  exit: number;
  findings: { code: string; [k: string]: unknown }[];
  notes?: string[];
  attributions?: { path: string; verdict: string }[];
}

async function zw(
  fx: Fixture,
  commands: string,
  extra: string[] = [],
): Promise<{ status: number | null; report: Report; stdout: string }> {
  const cmds = await fx.repoPut('cmds.txt', commands + '\n');
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
    path.join(fx.out, 'zw'),
    '--tmp',
    fx.dir,
    '--require-success',
    ...extra,
  ]);
  const m = /报告:(.+)/.exec(r.stdout);
  const report = m
    ? (JSON.parse(await readText(path.join(m[1] as string, 'report.json'))) as Report)
    : ({ exit: r.status ?? -1, findings: [] } as Report);
  return { status: r.status, report, stdout: r.stdout };
}
const codes = (r: { report: Report }): string[] => r.report.findings.map((f) => f.code);
/** 非 0 且不是『命令本身坏了』这种错因(防止因命令写错而假红/假绿) */
function expectDetected(r: { status: number | null; report: Report }): void {
  expect(r.status, JSON.stringify(r.report)).not.toBe(0);
  expect(codes(r)).not.toContain('COMMAND_ABNORMAL_EXIT');
  expect(r.status).not.toBe(2);
}

const MANAGED = `~/.claude/CLAUDE.md
~/.claude/skills/
~/.pi/agent/AGENTS.md
~/.pi/agent/AGENTS.override.md
~/.pi/agent/settings.json
~/.config/agent-kit/
`;
const VOLATILE = `~/.claude/projects/**
**/.DS_Store
`;

async function seed(fx: Fixture): Promise<void> {
  await fx.put('.claude/CLAUDE.md', 'a\n');
  await fx.put('.claude/skills/foo/SKILL.md', '# foo\n');
  await fx.put('.claude/skills/foo/scripts/run.py', 'aaaa');
  await fx.put('.claude/skills/foo/references/deep/x.md', 'xxxx');
  await fx.put('.pi/agent/AGENTS.md', 'p\n');
  await fx.put('.pi/agent/AGENTS.override.md', 'o\n');
  await fx.put('.pi/agent/settings.json', '{}\n');
}

describe('ZW-1:受管目录被整棵删除不能判通过', () => {
  it('rm -rf ~/.pi/agent(直接父目录一并消失)=> 非 0,且不是只写 NOTE 的 0', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    const r = await zw(fx, `/bin/sh -c "rm -rf {REALHOME}/.pi/agent"`);
    expectDetected(r);
    // 删除必须被指认到具体路径
    const all = JSON.stringify(r.report);
    expect(all).toContain('~/.pi/agent/settings.json');
  });

  it('更深一层的整棵删除(skills/foo/references/deep)同样非 0', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    const r = await zw(fx, `/bin/sh -c "rm -rf {REALHOME}/.claude/skills/foo/references"`);
    expectDetected(r);
  });

  it('正向对照:外部进程只在命令窗口之外改一个文件、ctime 可取 => 仍是 0 + NOTE(不因本修复变得处处报警)', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    // 命令什么也不写;这里只验证"没有差异"仍为 0
    const r = await zw(fx, `${process.execPath} -e "0"`, ['--two-rounds']);
    expect(r.status).toBe(0);
  });
});

describe('ZW-2:skill 目录深层文件被改写(同长度 / 写后还原)必须检出', () => {
  it('scripts/run.py 同长度改写 => 非 0', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    const r = await zw(
      fx,
      `/bin/sh -c "printf bbbb > {REALHOME}/.claude/skills/foo/scripts/run.py"`,
    );
    expectDetected(r);
  });

  it('深三层 references/deep/x.md 写后还原 => 非 0', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    const sh = await fx.repoPut(
      'restore.sh',
      'f="$1"; c=$(cat "$f"); echo changed > "$f"; printf %s "$c" > "$f"\n',
    );
    const r = await zw(fx, `/bin/sh ${sh} {REALHOME}/.claude/skills/foo/references/deep/x.md`);
    expectDetected(r);
  });

  it('只 touch 深层文件(内容不变)=> 非 0', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    const r = await zw(fx, `/bin/sh -c "touch {REALHOME}/.claude/skills/foo/scripts/run.py"`);
    expectDetected(r);
  });

  it('正向对照:不写 => 0;只写 volatile 文件(skills 内 .DS_Store)=> 0', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    expect((await zw(fx, `${process.execPath} -e "0"`, ['--two-rounds'])).status).toBe(0);
    const r = await zw(fx, `/bin/sh -c "echo x > {REALHOME}/.claude/skills/foo/scripts/.DS_Store"`);
    expect(r.status, JSON.stringify(r.report)).toBe(0);
  });
});

describe('ZW-3:符号链接要跟随到(HOME 内的)目标', () => {
  it('skill 目录是指向 HOME 内 dotfiles 的链接:通过链接改 SKILL.md => 非 0', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    await fx.put('dotfiles/bar/SKILL.md', '# bar\n');
    await fx.put('dotfiles/bar/scripts/s.sh', 'echo 1');
    await fx.link('.claude/skills/bar', path.join(fx.home, 'dotfiles/bar'));
    const r = await zw(
      fx,
      `/bin/sh -c "printf '# BAR\\n' > {REALHOME}/.claude/skills/bar/SKILL.md"`,
    );
    expectDetected(r);
    const r2 = await zw(
      fx,
      `/bin/sh -c "printf 'echo 2' > {REALHOME}/.claude/skills/bar/scripts/s.sh"`,
    );
    expectDetected(r2);
  });

  it('字面受管文件是链接:通过链接写目标 => 非 0', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    await fx.remove('.claude/CLAUDE.md');
    await fx.put('dotfiles/CLAUDE.md', 'AAAA');
    await fx.link('.claude/CLAUDE.md', path.join(fx.home, 'dotfiles/CLAUDE.md'));
    const r = await zw(fx, `/bin/sh -c "printf BBBB > {REALHOME}/.claude/CLAUDE.md"`);
    expectDetected(r);
  });

  it('链接指向 HOME 之外 => 不读内容(报告里没有目标内容),只披露盲区 NOTE;经链接写目标仍检出', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    await fx.remove('.claude/CLAUDE.md');
    const outside = path.join(fx.dir, 'outside-home');
    await fx.repoPut('../outside-home/CLAUDE.md', 'SECRET-LOOKING');
    await fx.link('.claude/CLAUDE.md', path.join(outside, 'CLAUDE.md'));
    const r = await zw(fx, `${process.execPath} -e "0"`, ['--settle-ms', '100']);
    expect(r.status, JSON.stringify(r.report)).toBe(0);
    expect((r.report.notes ?? []).join('\n')).toContain('~/.claude/CLAUDE.md');
    expect(r.stdout).not.toContain('SECRET-LOOKING');
    const w = await zw(fx, `/bin/sh -c "printf SECRET-LOOKINX > {REALHOME}/.claude/CLAUDE.md"`);
    expectDetected(w);
  });

  it('正向对照:链接指向 HOME 内且无人写 => 0', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    await fx.put('dotfiles/bar/SKILL.md', '# bar\n');
    await fx.link('.claude/skills/bar', path.join(fx.home, 'dotfiles/bar'));
    const r = await zw(fx, `${process.execPath} -e "0"`, ['--two-rounds']);
    expect(r.status, JSON.stringify(r.report)).toBe(0);
  });
});

describe('ZW-4:命令退出之后的延迟写入', () => {
  it('detached 后台进程在命令返回后才写受管文件 => 非 0(静置复查抓得到)', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    const r = await zw(
      fx,
      `/bin/sh -c "(sleep 0.4; echo late > {REALHOME}/.claude/CLAUDE.md) >/dev/null 2>&1 &"`,
      ['--settle-ms', '2500'],
    );
    expectDetected(r);
  });

  it('detached 后台进程延迟写假 HOME => 退出 1(FAKE_HOME_NOT_EMPTY)', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    const r = await zw(
      fx,
      `/bin/sh -c "(sleep 0.4; echo late > {HOME}/leak.txt) >/dev/null 2>&1 &"`,
      ['--settle-ms', '2500'],
    );
    expect(r.status, JSON.stringify(r.report)).toBe(1);
    expect(codes(r)).toContain('FAKE_HOME_NOT_EMPTY');
  });

  it('正向对照:无后台进程 => 0', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    expect((await zw(fx, `${process.execPath} -e "0"`, ['--settle-ms', '200'])).status).toBe(0);
  });
});

describe('ZW-5:volatile 不能挖空受管目录之下', () => {
  const lc = (fx: Fixture): { status: number | null; stdout: string } =>
    runMain(['lists-check', '--repo', fx.repo, '--home', fx.home, '--base-ref', '']);

  it('受管目录之下加 volatile 行 => 退出 3', async () => {
    for (const extra of [
      '~/.claude/skills/*\n',
      '**/SKILL.md\n',
      '~/.claude/skills/**/scripts/**\n',
      '~/.claude/*/foo/**\n',
    ]) {
      const fx = await makeFixture(MANAGED, VOLATILE + extra);
      const r = lc(fx);
      expect(r.status, extra).toBe(3);
      expect(r.stdout, extra).toContain('VOLATILE_UNDER_MANAGED_DIR');
    }
  });

  it('正向对照:不相交的 volatile(含 **/.DS_Store)通过', async () => {
    const fx = await makeFixture(
      MANAGED,
      VOLATILE + '~/.claude/projects/**\n~/.codex/sessions/**\n',
    );
    expect(lc(fx).status).toBe(0);
  });

  it('.DS_Store 豁免只限文件形态:目录形态 `**/.DS_Store/` 被拒', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE + '**/.DS_Store/\n');
    expect(lc(fx).status).toBe(3);
  });

  it('名叫 .DS_Store 的目录不会被当作 volatile 藏内容:其中的改动仍检出', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    await fx.put('.claude/skills/foo/.DS_Store/evil.sh', 'aaaa');
    const r = await zw(
      fx,
      `/bin/sh -c "printf bbbb > {REALHOME}/.claude/skills/foo/.DS_Store/evil.sh"`,
    );
    expectDetected(r);
  });

  it('基线比较:新增的 volatile 行落在受管目录之下 => VOLATILE_ADDED_UNDER_MANAGED', async () => {
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
        ...args,
      ]);
      expect(r.status, r.stderr).toBe(0);
    };
    git(['init', '-q']);
    git(['add', 'ops']);
    git(['commit', '-q', '-m', 'base']);
    const ok = runMain(['lists-check', '--repo', fx.repo, '--home', fx.home, '--base-ref', 'HEAD']);
    expect(ok.status).toBe(0);
    await safe.writeFile(
      fx.ctx,
      path.join(fx.repo, 'ops/volatile-paths.txt'),
      VOLATILE + '**/SKILL.md\n',
    );
    const r = runMain(['lists-check', '--repo', fx.repo, '--home', fx.home, '--base-ref', 'HEAD']);
    expect(r.status).toBe(3);
    expect(r.stdout).toContain('VOLATILE_ADDED_UNDER_MANAGED');
  });
});

describe('ZW-6/8:小修', () => {
  it('命令清单为空(只有注释)=> 退出 4,不当通过', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    const r = await zw(fx, '# 没有命令');
    expect(r.status).toBe(4);
    expect(r.stdout).toContain('NO_COMMANDS');
  });

  it('diff 子命令读不了快照 => 退出 4(不是 node 默认的 1)', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    const bad = await fx.repoPut('bad.json', '{not json');
    const r = runMain(['diff', bad, bad]);
    expect(r.status).toBe(4);
  });
});

describe('对抗评审补洞(B1/B2/B3/F3)', () => {
  it('B2:指向 HOME 之外的目录链接,原地改写其中文件仍检出(只比元数据,不读内容)', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    await fx.repoPut('../outside-skill/x/SKILL.md', 'aaaa');
    await fx.link('.claude/skills/x', path.join(fx.dir, 'outside-skill/x'));
    const w = await zw(fx, `/bin/sh -c "printf bbbb > {REALHOME}/.claude/skills/x/SKILL.md"`);
    expectDetected(w);
  });

  it('B3:名叫 .DS_Store 的符号链接不被当作 volatile 剔除(出现在名字表里 => 新增被检出)', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    await fx.put('dotfiles/evil/SKILL.md', 'x');
    const r = await zw(
      fx,
      `/bin/sh -c "ln -s {REALHOME}/dotfiles/evil {REALHOME}/.claude/skills/.DS_Store"`,
    );
    expectDetected(r);
  });

  it('F3:链到凭据目录里的文件不读内容(报告里没有内容,也没有它的哈希)', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    await fx.put('.ssh/id_synthetic', 'PRIVATE-MATERIAL');
    await fx.link('.claude/skills/key', path.join(fx.home, '.ssh'));
    const o = path.join(fx.out, 'f3');
    runMain(['snap', '--repo', fx.repo, '--home', fx.home, '--base-ref', '', '--out-root', o]);
    const text = await readText(path.join(o, 'snapshot.json'));
    expect(text).not.toContain('PRIVATE-MATERIAL');
    expect(text).toContain('"outside": true');
  });

  it('F3:链到 HOME 本身(凭据目录的祖先)不跟随', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    await fx.link('.claude/skills/all', fx.home);
    const o = path.join(fx.out, 'f3b');
    runMain(['snap', '--repo', fx.repo, '--home', fx.home, '--base-ref', '', '--out-root', o]);
    const j = JSON.parse(await readText(path.join(o, 'snapshot.json'))) as {
      outside_links: string[];
    };
    expect(j.outside_links).toContain('~/.claude/skills/all');
  });

  it('B1:在链接目标的真实路径上写 volatile 行,不能把被跟随的内容剔除', async () => {
    const hub = '~/workspace/skills-hub/**\n';
    const fx = await makeFixture(MANAGED, VOLATILE + hub);
    await seed(fx);
    await fx.put('workspace/skills-hub/foo/SKILL.md', 'aaaa');
    await fx.link('.claude/skills/foo2', path.join(fx.home, 'workspace/skills-hub/foo'));
    const w = await zw(fx, `/bin/sh -c "printf bbbb > {REALHOME}/.claude/skills/foo2/SKILL.md"`);
    expectDetected(w);
  });

  it('F2:被跟随目录里读不了的内容不触发预算误累加;正常不写 => 0', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await seed(fx);
    await fx.put('dotfiles/ok/SKILL.md', 'x');
    await fx.link('.claude/skills/ok', path.join(fx.home, 'dotfiles/ok'));
    expect((await zw(fx, `${process.execPath} -e "0"`, ['--two-rounds'])).status).toBe(0);
  });
});
