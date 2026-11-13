/**
 * 命令面入口(W8a):二级路由、`--write` 分流、能力闸(`RSI_AUTO_SUBCOMMAND_CAPS` + `capabilityAvailable`)。
 * 相位当前恒为 0:生产上全部是桩;处理函数只经注入的 `phase` 被调用。能力未到期 = 桩 64,**不解析参数、不构造端口**(未到期的命令不读任何东西)。
 */
import { describe, expect, it } from 'vitest';
import {
  RSI_AUTO_PHASE,
  RSI_AUTO_SUBCOMMAND_CAPS,
  RSI_CAPABILITY_PHASE,
  capabilityAvailable,
  phaseIndex,
} from '../../../src/contracts/rsi.js';
import { runAutoFamily } from '../../../src/rsi/auto/entry.js';
import { routeAuto, type AutoCanonical, type AutoFamily } from '../../../src/rsi/auto/route.js';
import { AutoUsageError, type AutoReadPorts } from '../../../src/rsi/auto/read/ports.js';
import type { RsiEarlyContext } from '../../../src/rsi/types.js';
import { makeSink, makeWorld, portsOf } from './auto-fixture.js';

function ctxOf(argv: string[], sink = makeSink(), isTty = true): RsiEarlyContext {
  return {
    argv,
    overlayPath: undefined,
    explicitRoot: undefined,
    env: { KIT_REAL_HOME_OVERRIDE: '/nonexistent-home-w8a' },
    cwd: '/',
    stdout: sink.stdout,
    stderr: sink.stderr,
    isTty,
  } as RsiEarlyContext;
}

describe('routeAuto(纯函数)', () => {
  it('auto 的五个二级命令;缺失 / 未知 → undefined(不回显、不猜)', () => {
    const subs: [string, AutoCanonical][] = [
      ['status', 'auto status'],
      ['pause', 'auto pause'],
      ['resume', 'auto resume'],
      ['clear', 'auto clear'],
      ['rebase-baseline', 'auto rebase-baseline'],
    ];
    for (const [sub, canonical] of subs) {
      expect(routeAuto('auto', [sub])?.canonical).toBe(canonical);
    }
    for (const bad of [
      [],
      ['nope'],
      ['STATUS'],
      ['status ', '--json'],
      ['__proto__'],
      ['constructor'],
      ['--json'],
    ]) {
      expect(routeAuto('auto', bad), bad.join(' ')).toBeUndefined();
    }
  });

  it('--write 分流:pause / resume / rebase-baseline / veto 恒为写;clear 与 rollback 仅在含精确 token `--write` 时为写;status / report / show 恒为读', () => {
    const w = (f: AutoFamily, a: string[]) => routeAuto(f, a)?.write;
    expect(w('auto', ['pause'])).toBe(true);
    expect(w('auto', ['resume'])).toBe(true);
    expect(w('auto', ['rebase-baseline'])).toBe(true);
    expect(w('veto', ['ra_aaaaaaaaaaaa'])).toBe(true);
    expect(w('veto', ['--lift', 'ra_aaaaaaaaaaaa'])).toBe(true);
    expect(w('auto', ['clear'])).toBe(false);
    expect(w('auto', ['clear', '--write'])).toBe(true);
    expect(w('auto', ['clear', '--json', '--write'])).toBe(true);
    expect(w('auto', ['clear', '--write=1'])).toBe(false); // 精确 token:不精确的写法留给参数解析判 unknown_arg
    expect(w('rollback', ['--to', '2026-11-01'])).toBe(false);
    expect(w('rollback', ['--to', '2026-11-01', '--write'])).toBe(true);
    expect(w('auto', ['status', '--write'])).toBe(false);
    expect(w('report', ['--write'])).toBe(false);
    expect(w('show', ['--write'])).toBe(false);
  });

  it('规范名恒取 RSI_AUTO_SUBCOMMAND_CAPS 的键;rollback 的规范名是 `rollback --to`;rest 是二级命令名之后的参数', () => {
    expect(routeAuto('rollback', [])?.canonical).toBe('rollback --to');
    expect(routeAuto('auto', ['clear', '--write'])?.rest).toEqual(['--write']);
    for (const c of ['veto', 'report', 'show'] as const) {
      expect(routeAuto(c, [])?.canonical).toBe(c);
    }
    for (const [canonical] of Object.entries(RSI_AUTO_SUBCOMMAND_CAPS)) {
      expect(
        RSI_CAPABILITY_PHASE[RSI_AUTO_SUBCOMMAND_CAPS[canonical as AutoCanonical]],
      ).toBeDefined();
    }
  });
});

describe('能力闸', () => {
  const CASES: [AutoFamily, string[], AutoCanonical][] = [
    ['auto', ['status'], 'auto status'],
    ['auto', ['pause'], 'auto pause'],
    ['auto', ['resume'], 'auto resume'],
    ['auto', ['clear'], 'auto clear'],
    ['auto', ['clear', '--write'], 'auto clear'],
    ['auto', ['rebase-baseline'], 'auto rebase-baseline'],
    ['veto', ['ra_aaaaaaaaaaaa'], 'veto'],
    ['rollback', ['--to', '2026-11-01'], 'rollback --to'],
    ['rollback', ['--to', '2026-11-01', '--write'], 'rollback --to'],
    ['report', [], 'report'],
    ['show', ['ra_aaaaaaaaaaaa'], 'show'],
  ];

  it('生产相位恒为 0:全部是桩;规范名取表里的键', async () => {
    expect(RSI_AUTO_PHASE).toBe(0);
    for (const [family, argv, canonical] of CASES) {
      const s = makeSink();
      const code = await runAutoFamily(family, ctxOf(argv, s));
      expect([code, s.text()], `${family} ${argv.join(' ')}`).toEqual([
        64,
        { out: '', err: `RSI_NOT_IMPLEMENTED subcommand=${canonical}\n` },
      ]);
    }
  });

  it('未到期的命令不构造端口、不解析参数(坏参数照样是桩)、不调用写处理函数', async () => {
    let built = 0;
    let wrote = 0;
    const deps = {
      phase: 0,
      ports: async (): Promise<AutoReadPorts> => {
        built += 1;
        return portsOf(makeWorld());
      },
      write: { 'auto pause': async () => ((wrote += 1), 0) },
    };
    for (const [family, argv] of CASES) {
      await runAutoFamily(family, ctxOf([...argv, '--bogus']), deps);
    }
    expect([built, wrote]).toEqual([0, 0]);
  });

  it('逐能力的相位边界:cmd_* 为 V1a 的命令在相位 1 起可用;cmd_rollback_to 为 V1b,相位 1 仍是桩、相位 2 起可用;不在表里的键恒拒绝', () => {
    for (const [canonical, cap] of Object.entries(RSI_AUTO_SUBCOMMAND_CAPS)) {
      const need = canonical === 'rollback --to' ? 'V1b' : 'V1a';
      expect(RSI_CAPABILITY_PHASE[cap], canonical).toBe(need);
      expect(capabilityAvailable(cap, phaseIndex(need) - 1), canonical).toBe(false);
      expect(capabilityAvailable(cap, phaseIndex(need)), canonical).toBe(true);
    }
    expect(capabilityAvailable('cmd_not_in_table', 99)).toBe(false);
  });

  it('相位够了:读命令跑到处理函数(端口只构造一次);写命令仍接到「未实现」桩(W8b 替换),不构造端口', async () => {
    let built = 0;
    const deps = {
      phase: 2,
      ports: async (): Promise<AutoReadPorts> => {
        built += 1;
        return portsOf(makeWorld());
      },
    };
    const s = makeSink();
    expect(await runAutoFamily('auto', ctxOf(['status', '--json'], s), deps)).toBe(0);
    expect(built).toBe(1);
    expect(JSON.parse(s.text().out)).toHaveProperty('auto.view_state', 'missing');
    for (const [family, argv, canonical] of CASES.filter(
      ([f, a]) => routeAuto(f, a)?.write === true,
    )) {
      const w = makeSink();
      expect(await runAutoFamily(family, ctxOf(argv, w), deps), `${family} ${argv.join(' ')}`).toBe(
        64,
      );
      expect(w.text().err).toBe(`RSI_NOT_IMPLEMENTED subcommand=${canonical}\n`);
    }
    expect(built).toBe(1);
  });

  it('写处理函数的接缝:注入后按规范名调用,参数是二级命令名之后的 rest(W8b 只需替换处理函数)', async () => {
    const seen: string[][] = [];
    const code = await runAutoFamily('auto', ctxOf(['clear', '--write', '--x']), {
      phase: 1,
      write: {
        'auto clear': async (_c, rest) => {
          seen.push([...rest]);
          return 7;
        },
      },
    });
    expect([code, seen]).toEqual([7, [['--write', '--x']]]);
  });

  it('参数先于能力闸的只有二级路由:`rsi auto` 缺 / 未知二级命令 → 2 unknown_subcommand;其余先判能力', async () => {
    const s = makeSink();
    expect(await runAutoFamily('auto', ctxOf([], s), { phase: 0 })).toBe(2);
    expect(s.text().err).toBe('RSI_USAGE reason=unknown_subcommand\n');
  });

  it('坏参数 / 非 TTY 先于端口装配:status / clear / report / show / rollback 的参数错误都不构造端口(不会因读配置失败而退 3)', async () => {
    let built = 0;
    const deps = {
      phase: 2,
      ports: async (): Promise<AutoReadPorts> => {
        built += 1;
        return portsOf(makeWorld());
      },
    };
    const cases: [AutoFamily, string[], boolean, string][] = [
      ['auto', ['status', '--bogus'], true, 'unknown_arg'],
      ['auto', ['clear', '--bogus'], true, 'unknown_arg'],
      ['report', ['--since', '2026-02-30'], true, 'bad_date'],
      ['report', ['--week', '--since', '2026-11-01'], true, 'mode_conflict'],
      ['show', ['ra_0123456789ab'], false, 'not_tty'],
      ['show', ['ra_xyz'], true, 'unknown_id'],
      ['show', [], true, 'unknown_arg'],
      ['rollback', [], true, 'bad_date'],
      ['rollback', ['--to', '2026-13-01'], true, 'bad_date'],
      ['rollback', ['--to', '2026-11-01', '--bogus'], true, 'unknown_arg'],
    ];
    for (const [family, argv, tty, reason] of cases) {
      const s = makeSink();
      expect(
        await runAutoFamily(family, ctxOf(argv, s, tty), deps),
        `${family} ${argv.join(' ')}`,
      ).toBe(2);
      expect(s.text().err).toBe(`RSI_USAGE reason=${reason}\n`);
    }
    expect(built).toBe(0);
  });

  it('端口装配阶段的用法错误(root_mismatch)映射为退 2,不回显消息', async () => {
    const s = makeSink();
    const code = await runAutoFamily('auto', ctxOf(['status'], s), {
      phase: 2,
      ports: async () => {
        throw new AutoUsageError('root_mismatch');
      },
    });
    expect([code, s.text()]).toEqual([2, { out: '', err: 'RSI_USAGE reason=root_mismatch\n' }]);
  });

  it('读命令的参数错误:未知参数 → 2 unknown_arg(相位够时);show 无 TTY → 2 not_tty;report 坏日期 → 2 bad_date;异常 → 3 internal', async () => {
    const w = makeWorld();
    const deps = { phase: 2, ports: async () => portsOf(w) };
    const run = async (f: AutoFamily, argv: string[], tty = true) => {
      const s = makeSink();
      const code = await runAutoFamily(f, ctxOf(argv, s, tty), deps);
      return [code, s.text().err];
    };
    expect(await run('auto', ['status', '--bogus'])).toEqual([2, 'RSI_USAGE reason=unknown_arg\n']);
    expect(await run('auto', ['clear', '--bogus'])).toEqual([2, 'RSI_USAGE reason=unknown_arg\n']);
    expect(await run('show', ['ra_0123456789ab'], false)).toEqual([
      2,
      'RSI_USAGE reason=not_tty\n',
    ]);
    expect(await run('report', ['--since', '2026-02-30'])).toEqual([
      2,
      'RSI_USAGE reason=bad_date\n',
    ]);
    expect(await run('report', ['--week', '--since', '2026-11-01'])).toEqual([
      2,
      'RSI_USAGE reason=mode_conflict\n',
    ]);
    const boom = makeSink();
    const code = await runAutoFamily('auto', ctxOf(['status'], boom), {
      phase: 2,
      ports: async () => {
        throw new Error('port exploded: /secret/path');
      },
    });
    expect([code, boom.text()]).toEqual([3, { out: '', err: 'RSI_FAIL_CLOSED reason=internal\n' }]);
  });
});
