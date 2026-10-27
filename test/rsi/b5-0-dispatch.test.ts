/**
 * R20-A2 B5-0:分发器按精确 token 路由(`status --ack` → status-ack.ts;`projects --rebuild-index --write` → projects-rebuild.ts),
 * 以及这两个入口(B5a 实装后恢复契约退出码;零写入)。
 * 路由是纯函数:只看 token 在不在,不判参数合法性(合法性归目标入口的 parseFlags)。
 */
import { describe, expect, it } from 'vitest';
import { main } from '../../src/cli.js';
import { RSI_SUBCOMMAND_TABLE, routeRsi } from '../../src/commands/rsi.js';
import { RSI_SUBCOMMANDS } from '../../src/contracts/rsi.js';
import { subcommand as projectsRebuild } from '../../src/rsi/projects-rebuild.js';
import { subcommand as projects } from '../../src/rsi/projects.js';
import { subcommand as statusAck } from '../../src/rsi/status-ack.js';
import { subcommand as status } from '../../src/rsi/status.js';

async function run(
  argv: string[],
): Promise<{ code: number; out: string; err: string; audit: string[] }> {
  let out = '';
  let err = '';
  const audit: string[] = [];
  const code = await main(argv, {
    env: { PATH: '/usr/bin:/bin', KIT_REAL_HOME_OVERRIDE: '/nonexistent-home-b5-0' },
    writeAudit: (op, p) => void audit.push(`${op} ${p}`),
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  });
  return { code, out, err, audit };
}

describe('routeRsi(纯函数,精确 token)', () => {
  it('正向前提:无特殊 token 时仍按表路由(两个路由目标不在表里)', () => {
    expect(RSI_SUBCOMMAND_TABLE.map((s) => s.name)).toEqual([...RSI_SUBCOMMANDS]);
    expect(RSI_SUBCOMMAND_TABLE).not.toContain(statusAck);
    expect(RSI_SUBCOMMAND_TABLE).not.toContain(projectsRebuild);
    expect(routeRsi('status', [])).toBe(status);
    expect(routeRsi('status', ['--json'])).toBe(status);
    expect(routeRsi('projects', [])).toBe(projects);
  });

  it('status:带 --ack(任意位置、可与其它参数并存)→ status-ack', () => {
    expect(routeRsi('status', ['--ack'])).toBe(statusAck);
    expect(routeRsi('status', ['--json', '--ack'])).toBe(statusAck);
    expect(routeRsi('status', ['--ack', '--bogus'])).toBe(statusAck); // 参数合法性不归路由
  });

  it('projects:--rebuild-index 与 --write 同时在才路由到 projects-rebuild;单独任一个都不路由', () => {
    expect(routeRsi('projects', ['--rebuild-index', '--write'])).toBe(projectsRebuild);
    expect(routeRsi('projects', ['--write', '--rebuild-index'])).toBe(projectsRebuild);
    expect(routeRsi('projects', ['--rebuild-index', '--json', '--write'])).toBe(projectsRebuild);
    expect(routeRsi('projects', ['--rebuild-index'])).toBe(projects); // 干跑仍在只读入口
    expect(routeRsi('projects', ['--write'])).toBe(projects);
    expect(routeRsi('projects', ['--json', '--paths'])).toBe(projects);
  });

  it('token 必须精确相等:--ack=1 / --Ack / -ack / 前后缀都不路由;--ack 只对 status、--rebuild-index 只对 projects', () => {
    for (const t of ['--ack=1', '--Ack', '-ack', '--ack ', ' --ack', '--acks', 'ack']) {
      expect(routeRsi('status', [t]), t).toBe(status);
    }
    // --rebuild-index 在场,但 --write 的写法不精确 → 不路由(留给 projects.ts 的 parseFlags 判 unknown_arg / write_requires_mode)
    for (const t of ['--write=1', '--writes', '--Write', '-write']) {
      expect(routeRsi('projects', ['--rebuild-index', t]), t).toBe(projects);
    }
    for (const t of ['--rebuild-index=1', '--rebuild_index', '--Rebuild-Index']) {
      expect(routeRsi('projects', [t, '--write']), t).toBe(projects);
    }
    expect(routeRsi('projects', ['--ack'])).toBe(projects);
    expect(routeRsi('status', ['--rebuild-index', '--write'])).toBe(status);
    expect(routeRsi('tick', ['--ack'])).toBe(RSI_SUBCOMMAND_TABLE.find((s) => s.name === 'tick'));
  });

  it('不认识的名字 / 缺省 → undefined;不修改入参', () => {
    const rest = ['--ack'];
    expect(routeRsi('nope', rest)).toBeUndefined();
    expect(routeRsi(undefined, rest)).toBeUndefined();
    expect(rest).toEqual(['--ack']);
  });
});

describe('两个入口(经真实 main();B5a 已实装,不再是桩)', () => {
  it('入口形状:owner B5,name 沿用目标命令名', () => {
    expect(statusAck.name).toBe('status');
    expect(statusAck.owner).toBe('B5');
    expect(projectsRebuild.name).toBe('projects');
    expect(projectsRebuild.owner).toBe('B5');
  });

  it('rsi status --ack:路由到 status-ack.ts,按它自己的 parseFlags 判参数;非 TTY → 2 not_tty;零写入', async () => {
    for (const [extra, err] of [
      [[], 'RSI_USAGE reason=not_tty\n'],
      [['--json'], 'RSI_USAGE reason=not_tty\n'],
      [['--bogus'], 'RSI_USAGE reason=unknown_arg\n'],
      [['--x'], 'RSI_USAGE reason=unknown_arg\n'],
    ] as const) {
      const r = await run(['rsi', 'status', '--ack', ...extra]);
      expect(r.code, extra.join(' ')).toBe(2);
      expect(r.err).toBe(err);
      expect(r.out).toBe('');
      expect(r.audit).toEqual([]);
    }
    // 对照:不带 --ack 时走真实的 status(假 HOME 下配置 absent → 退 0 有输出),说明上面的结果确实来自路由
    const plain = await run(['rsi', 'status']);
    expect(plain.code).toBe(0);
    expect(plain.out).toContain('state=off');
  });

  it('rsi projects --rebuild-index --write:路由到 projects-rebuild.ts;--paths → 2 mode_conflict;配置 absent → 4 off;零写入', async () => {
    const paths = await run(['rsi', 'projects', '--rebuild-index', '--write', '--paths']);
    expect([paths.code, paths.err]).toEqual([2, 'RSI_USAGE reason=mode_conflict\n']);
    for (const extra of [[], ['--json']]) {
      const r = await run(['rsi', 'projects', '--rebuild-index', '--write', ...extra]);
      expect(r.code, extra.join(' ')).toBe(4);
      expect(r.err).toBe('RSI_NOT_RUN reason=off\n');
      expect(r.out).toBe('');
      expect(r.audit).toEqual([]);
    }
  });

  it('rsi projects --rebuild-index(干跑,无 --write)仍落在 projects.ts:配置 absent → 4 off,零写入', async () => {
    const r = await run(['rsi', 'projects', '--rebuild-index']);
    expect(r.code).toBe(4);
    expect(r.err).toBe('RSI_NOT_RUN reason=off\n');
    expect(r.out).toBe('');
    expect(r.audit).toEqual([]);
  });

  it('未被路由的参数组合仍由 status / projects 自己的 parseFlags 判(--write 单独 → 2 write_requires_mode)', async () => {
    const w = await run(['rsi', 'projects', '--write']);
    expect(w.code).toBe(2);
    expect(w.err).toBe('RSI_USAGE reason=write_requires_mode\n');
    const x = await run(['rsi', 'status', '--bogus']);
    expect(x.code).toBe(2);
    expect(x.err).toBe('RSI_USAGE reason=unknown_arg\n');
  });
});
