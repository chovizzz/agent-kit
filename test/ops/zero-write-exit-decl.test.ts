/**
 * R20-A2 B5e(契约 §20.9 第 16 条):零写入清单的「按行允许退出码」(行尾 `# exit=0,4`)与 `--home-seed` 预置。
 * 判据:声明只对**本行**生效、替换默认集合、不放过信号 / spawn 错误;不合法的声明 = 清单违规(退出 4),不静默当成无声明;
 * 预置路径只在预置的那一轮允许存在,并逐项核对前后不变。A3 复用这套语法,不再改解析器。
 * 每条负向断言旁边都有正向对照(同一夹具下去掉一个条件后判据确实报出)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { makeFixture, runMain } from './helpers.js';
import type { Fixture } from './helpers.js';

const MANAGED = '~/.claude/CLAUDE.md\n~/.config/agent-kit/\n~/.local/state/agent-kit/\n';
const VOLATILE = '~/.claude/projects/**\n';

interface Report {
  exit: number;
  findings: { code: string; [k: string]: unknown }[];
  rounds?: { commands: { cmd: string; code: number | null; allowed_exit?: number[] }[] }[];
}

async function zw(
  fx: Fixture,
  commands: string,
  extra: string[] = [],
  requireSuccess = true,
): Promise<{ status: number | null; report: Report; stdout: string }> {
  await fx.put('.claude/CLAUDE.md', 'a\n');
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
    ...(requireSuccess ? ['--require-success'] : []),
    '--settle-ms',
    '120',
    ...extra,
  ]);
  const m = /报告:(.+)/.exec(r.stdout);
  const report = m
    ? (JSON.parse(await readText(path.join(m[1] as string, 'report.json'))) as Report)
    : ({ exit: r.status ?? -1, findings: [] } as Report);
  return { status: r.status, report, stdout: r.stdout };
}
const codes = (r: { report: Report }): string[] => r.report.findings.map((f) => f.code);
const sh = (script: string): string => `/bin/sh -c "${script}"`;

describe('按行声明的允许退出码', () => {
  it('正向:`exit 4 # exit=0,4` 在 --require-success 下通过,命令记录带 allowed_exit;对照:同一命令不带声明 => 1 COMMAND_ABNORMAL_EXIT', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    const ok = await zw(fx, `${sh('exit 4')} # exit=0,4`);
    expect(ok.status, ok.stdout).toBe(0);
    expect(ok.report.rounds?.[0]?.commands[0]?.allowed_exit).toEqual([0, 4]);
    expect(ok.report.rounds?.[0]?.commands[0]?.code).toBe(4);
    const fx2 = await makeFixture(MANAGED, VOLATILE);
    const bad = await zw(fx2, sh('exit 4'));
    expect(bad.status).toBe(1);
    expect(codes(bad)).toContain('COMMAND_ABNORMAL_EXIT');
  });

  it('只对本行生效:前一行声明不污染后一行(后一行无声明的 exit 4 仍然违规)', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    const r = await zw(fx, `${sh('exit 4')} # exit=4\n${sh('exit 4')}`);
    expect(r.status).toBe(1);
    const abnormal = r.report.findings.find(
      (f) => f.code === 'COMMAND_ABNORMAL_EXIT',
    ) as unknown as {
      commands: { cmd: string; allowed_exit?: number[] }[];
    };
    expect(abnormal.commands).toHaveLength(1);
    expect(abnormal.commands[0]?.allowed_exit).toBeUndefined();
    // 对照:第一行(带声明)确实跑了并且是被接受的那条
    expect(r.report.rounds?.[0]?.commands[0]?.allowed_exit).toEqual([4]);
  });

  it('声明替换默认集合:`# exit=4` 的命令退 0 也违规(不是在默认集合上追加);对照:`# exit=0,4` 退 0 通过', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    const bad = await zw(fx, `${sh('exit 0')} # exit=4`);
    expect(bad.status).toBe(1);
    expect(codes(bad)).toContain('COMMAND_ABNORMAL_EXIT');
    const fx2 = await makeFixture(MANAGED, VOLATILE);
    expect((await zw(fx2, `${sh('exit 0')} # exit=0,4`)).status).toBe(0);
  });

  it('未声明的行保持原语义:非 --require-success 时 64 被接受;声明了 `# exit=0` 的 64 被拒(声明不吞 64)', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    const dflt = await zw(fx, sh('exit 64'), [], false);
    expect(dflt.status, dflt.stdout).toBe(0);
    const fx2 = await makeFixture(MANAGED, VOLATILE);
    const declared = await zw(fx2, `${sh('exit 64')} # exit=0`, [], false);
    expect(declared.status).toBe(1);
    expect(codes(declared)).toContain('COMMAND_ABNORMAL_EXIT');
  });

  it('引号里的 `# exit=…` 不是声明:行尾是引号时按无声明处理(exit 4 违规)', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    const r = await zw(fx, sh('exit 4 # exit=0,4'));
    expect(r.status).toBe(1);
    expect(r.report.rounds?.[0]?.commands[0]?.allowed_exit).toBeUndefined();
  });

  it('不合法的声明 = 清单违规(退出 4 COMMAND_LIST_INVALID,一条命令都没跑);对照:合法声明正常跑', async () => {
    for (const bad of [
      '# exit=',
      '# exit=x',
      '# exit=0,0',
      '# exit=300',
      '# exit=0,,4',
      '# exit =4x',
    ]) {
      const fx = await makeFixture(MANAGED, VOLATILE);
      const r = await zw(fx, `${sh('exit 0')} ${bad}`);
      expect(r.status, bad).toBe(4);
      expect(r.stdout, bad).toContain('COMMAND_LIST_INVALID'); // 早退不写 report.json:看 stdout 的 FINDING 行
      expect(r.stdout, bad).not.toContain('报告:'); // 一条命令都没跑
    }
    const fx = await makeFixture(MANAGED, VOLATILE);
    expect((await zw(fx, `${sh('exit 0')} # exit=0`)).status).toBe(0);
  });

  it('声明了也不放过:命令不存在(spawn 错误)/ 被信号杀死 => 仍然违规;退出码不在声明里 => 违规', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    const missing = await zw(fx, '/nonexistent/bin/x # exit=0,4');
    expect(missing.status).toBe(1);
    expect(codes(missing)).toContain('COMMAND_ABNORMAL_EXIT');
    const fx2 = await makeFixture(MANAGED, VOLATILE);
    const sig = await zw(fx2, `${sh('kill -TERM $$')} # exit=0,4,143`);
    expect(sig.status).toBe(1);
    const fx3 = await makeFixture(MANAGED, VOLATILE);
    const other = await zw(fx3, `${sh('exit 3')} # exit=0,4`);
    expect(other.status).toBe(1);
  });

  it('不掩盖写入:声明了退出码的命令往假 HOME 写文件,照样 FAKE_HOME_NOT_EMPTY', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    const r = await zw(fx, `${sh('echo x > {HOME}/leak.txt; exit 4')} # exit=0,4`);
    expect(r.status).toBe(1);
    expect(codes(r)).toContain('FAKE_HOME_NOT_EMPTY');
    expect(codes(r)).not.toContain('COMMAND_ABNORMAL_EXIT'); // 退出码本身被接受;失败来自写入
  });

  it('命令环境带 KIT_AUTO_RSI=0(R20-1.6:自动入口在零写入窗口里空操作)', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    const r = await zw(fx, sh('[ x$KIT_AUTO_RSI = x0 ]'));
    expect(r.status, r.stdout).toBe(0);
    // 对照:探针确实会红(换成期望 1)
    const fx2 = await makeFixture(MANAGED, VOLATILE);
    expect((await zw(fx2, sh('[ x$KIT_AUTO_RSI = x1 ]'))).status).toBe(1);
  });
});

describe('--home-seed 预置', () => {
  async function seedDir(fx: Fixture): Promise<string> {
    const dir = path.join(fx.dir, 'seed');
    const cfg = path.join(dir, '.config', 'agent-kit');
    await safe.mkdirp(fx.ctx, cfg, 0o755);
    await safe.chmod(fx.ctx, path.join(dir, '.config'), 0o755);
    await safe.chmod(fx.ctx, cfg, 0o755);
    await safe.writeFile(fx.ctx, path.join(cfg, 'config.toml'), '[rsi]\nenabled = true\n', {
      mode: 0o600,
    });
    await safe.chmod(fx.ctx, path.join(cfg, 'config.toml'), 0o600);
    return dir;
  }

  it('正向:预置的文件存在且命令不碰它 => 通过(两轮都预置);对照:同一命令往另一个路径写 => FAKE_HOME_NOT_EMPTY', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    const seed = await seedDir(fx);
    const ok = await zw(fx, sh('test -f {HOME}/.config/agent-kit/config.toml'), [
      '--home-seed',
      seed,
    ]);
    expect(ok.status, ok.stdout).toBe(0);
    const fx2 = await makeFixture(MANAGED, VOLATILE);
    const seed2 = await seedDir(fx2);
    const bad = await zw(fx2, sh('echo x > {HOME}/.config/agent-kit/other.txt'), [
      '--home-seed',
      seed2,
    ]);
    expect(bad.status).toBe(1);
    expect(codes(bad)).toContain('FAKE_HOME_NOT_EMPTY');
  });

  it('写后还原 / 同字节覆盖 / 原子替换 / 特殊位 / 目录里建了又删子项:最终内容不变也报 SEEDED_PATH_CHANGED(快照含 ino、ctime,不只比内容)', async () => {
    const cfg = '{HOME}/.config/agent-kit/config.toml';
    for (const [name, script] of [
      [
        '写后还原',
        `cp ${cfg} {HOME}/bak; echo more >> ${cfg}; cat {HOME}/bak > ${cfg}; rm {HOME}/bak`,
      ],
      ['同字节覆盖', `cat ${cfg} > {HOME}/same; cat {HOME}/same > ${cfg}; rm {HOME}/same`],
      ['原子替换', `cp ${cfg} {HOME}/new; mv {HOME}/new ${cfg}`],
      ['目录加 sticky 位', 'chmod +t {HOME}/.config/agent-kit'],
      ['目录里建了又删', 'touch {HOME}/.config/agent-kit/ghost; rm {HOME}/.config/agent-kit/ghost'],
    ] as const) {
      const fx = await makeFixture(MANAGED, VOLATILE);
      const seed = await seedDir(fx);
      const r = await zw(fx, sh(script), ['--home-seed', seed]);
      expect(r.status, name).toBe(1);
      expect(codes(r), name).toContain('SEEDED_PATH_CHANGED');
      expect(codes(r), name).not.toContain('FAKE_HOME_NOT_EMPTY'); // 终态里没有多出文件:只有预置快照能抓到
    }
  });

  it('预置文件被改写(内容)/ 改权限 / 删除 => SEEDED_PATH_CHANGED;三者各自单独报出', async () => {
    for (const [name, script] of [
      ['内容', 'echo changed > {HOME}/.config/agent-kit/config.toml'],
      ['权限位', 'chmod 644 {HOME}/.config/agent-kit/config.toml'],
      ['删除', 'rm {HOME}/.config/agent-kit/config.toml'],
    ] as const) {
      const fx = await makeFixture(MANAGED, VOLATILE);
      const seed = await seedDir(fx);
      const r = await zw(fx, sh(script), ['--home-seed', seed]);
      expect(r.status, name).toBe(1);
      expect(codes(r), name).toContain('SEEDED_PATH_CHANGED');
    }
  });

  it('不放宽没有预置的轮:没有 --home-seed 时,同样往 .config/agent-kit/config.toml 写 => FAKE_HOME_NOT_EMPTY', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    const r = await zw(
      fx,
      sh('mkdir -p {HOME}/.config/agent-kit; echo x > {HOME}/.config/agent-kit/config.toml'),
    );
    expect(r.status).toBe(1);
    expect(codes(r)).toContain('FAKE_HOME_NOT_EMPTY');
  });
});
