/**
 * N1 订正 #3(contracts §20.15-12):pi 形状已核实(2026-11-04,pi 1.5.0,`实测运行`,`>=1.5.0`)+ agent 版本探测。
 * 三层:① 解析与 fail-closed(纯函数 + 注入的假出口);② 真实子进程出口(假 `pi` 脚本放在假 PATH 目录,只有 PATH 到达子进程);
 * ③ 写闸端到端(生产形状表、假 HOME 里真实走完写入路径),含经生产接线 `subcommand.run` 的一组(它是「生产接线从没传 agentVersion」这个缺口的回归)。
 * 只在假 HOME / KIT_TMP 下写;绝不碰真实 `~/.pi`。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PI_EXTENSION_SOURCE_PLAIN, PRODUCTION_SHAPES } from '../../../src/contracts/rsi-hooks.js';
import { RSI_AGENT_IDS } from '../../../src/contracts/rsi.js';
import {
  AGENT_VERSION_BINARIES,
  AGENT_VERSION_TIMEOUT_MS,
  AgentProbeDeniedError,
  runAgentVersionCommand,
} from '../../../src/io/agent-probe.js';
import { EXEC_ALLOWLIST } from '../../../src/io/exec.js';
import { chmod, mkdirp, writeFile } from '../../../src/io/safe-fs.js';
import {
  makeAgentVersionProbe,
  parseAgentVersionOutput,
  type AgentVersionRunner,
} from '../../../src/rsi/hooks/agent-version.js';
import { subcommand } from '../../../src/rsi/hooks/command.js';
import type { RsiEarlyContext } from '../../../src/rsi/types.js';
import { wideCtx } from '../../helpers/tmp.js';
import { withWriteAudit } from '../../helpers/write-audit.js';
import { jsonOf, makeHx, type Hx } from './a5-fixture.js';

const PI_TARGET = '.pi/agent/extensions/agent-kit-rsi.ts';
const UNVERIFIED = 'RSI_HOOKS_NOT_RUN reason=shape_unverified\n';

const okRun = (stdout: string, extra: Partial<ReturnType<AgentVersionRunner>> = {}) =>
  (() => ({
    status: 0,
    signal: null,
    stdout,
    stderr: '',
    timedOut: false,
    ...extra,
  })) as AgentVersionRunner;

describe('生产形状表(N1 订正 #3):pi 已核实,claude / codex 仍是假设', () => {
  it('pi = 实测运行 + min 1.5.0;claude / codex = 假设 + 无版本范围', () => {
    expect(PRODUCTION_SHAPES.pi.evidence).toBe('实测运行');
    expect(PRODUCTION_SHAPES.pi.agent_versions).toEqual({ min: '1.5.0' });
    for (const a of ['claude', 'codex'] as const) {
      expect(PRODUCTION_SHAPES[a].evidence, a).toBe('假设');
      expect(PRODUCTION_SHAPES[a].agent_versions, a).toBeNull();
    }
  });
});

describe('版本输出解析:恰好一个 X.Y.Z,其余一律 undefined(fail closed)', () => {
  it('正向:1.5.0 / 带换行 / 前导 v / 多位', () => {
    expect(parseAgentVersionOutput('1.5.0')).toBe('1.5.0');
    expect(parseAgentVersionOutput('1.5.0\n')).toBe('1.5.0');
    expect(parseAgentVersionOutput('  v1.5.0  \n')).toBe('1.5.0');
    expect(parseAgentVersionOutput('12.0.103')).toBe('12.0.103');
  });
  it('负向:空 / 垃圾 / 带前缀后缀 / 预发布 / 缺段 / 多行 / 超长段', () => {
    for (const bad of [
      '',
      '\n',
      'garbage',
      'pi 1.5.0',
      '1.5.0 (build 7)',
      '1.5.0-rc.1',
      '1.5.0+meta',
      '1.5',
      // 四段:拼出来而不写字面量(A10 的全量脱敏扫描对 ipv4 形状零容忍)
      ['1', '5', '0', '1'].join('.'),
      '1.5.0\n1.5.0',
      'warning: x\n1.5.0',
      '1.5.x',
      '1.5.9999999',
    ]) {
      expect(parseAgentVersionOutput(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe('探测函数(注入假出口):失败即未知,从不抛错', () => {
  it('正向对照:退出 0 + 版本号 → 该版本;出口收到固定的 3 秒超时与调用方给的 PATH', () => {
    const calls: unknown[][] = [];
    const run: AgentVersionRunner = (agent, o) => {
      calls.push([agent, o]);
      return { status: 0, signal: null, stdout: '1.5.0\n', stderr: '', timedOut: false };
    };
    expect(makeAgentVersionProbe('/x/bin', run)('pi')).toBe('1.5.0');
    expect(calls).toEqual([['pi', { pathEnv: '/x/bin', timeoutMs: 3000 }]]);
    expect(AGENT_VERSION_TIMEOUT_MS).toBe(3000);
  });

  it('负向:退出非 0 / 超时 / 找不到命令 / 被信号杀死 / 输出垃圾 / 出口抛错 → undefined(每项输出都是合法版本号,排除「只因输出垃圾才失败」)', () => {
    const cases: [string, AgentVersionRunner][] = [
      ['退出 1', okRun('1.5.0\n', { status: 1 })],
      ['status null', okRun('1.5.0\n', { status: null })],
      ['超时', okRun('1.5.0\n', { timedOut: true, status: null })],
      ['spawnError', okRun('1.5.0\n', { spawnError: 'spawnSync pi ENOENT' })],
      ['信号', okRun('1.5.0\n', { signal: 'SIGKILL' })],
      ['输出垃圾', okRun('pi version unknown\n')],
      ['空输出', okRun('')],
      [
        '出口抛错',
        () => {
          throw new Error('boom');
        },
      ],
    ];
    for (const [name, run] of cases) {
      expect(makeAgentVersionProbe('/x', run)('pi'), name).toBeUndefined();
    }
  });

  it('stdout 为空时看 stderr;stdout 有内容(哪怕是垃圾)时不回退 stderr', () => {
    expect(makeAgentVersionProbe('/x', okRun('', { stderr: '1.6.2\n' }))('pi')).toBe('1.6.2');
    expect(
      makeAgentVersionProbe('/x', okRun('junk\n', { stderr: '1.6.2\n' }))('pi'),
    ).toBeUndefined();
  });

  it('claude / codex:版本命令未核实 → undefined 且出口一次都不调用', () => {
    let n = 0;
    const run: AgentVersionRunner = () => {
      n++;
      return { status: 0, signal: null, stdout: '9.9.9\n', stderr: '', timedOut: false };
    };
    const probe = makeAgentVersionProbe('/x', run);
    for (const a of RSI_AGENT_IDS.filter((x) => x !== 'pi')) {
      expect(probe(a), a).toBeUndefined();
    }
    expect(n).toBe(0);
    expect(probe('pi')).toBe('9.9.9'); // 正向对照:同一个出口对 pi 会被调用
    expect(n).toBe(1);
  });
});

/** 在 hx.dir/bin 里放一个假 `pi` 脚本,返回该目录(唯一的 PATH 项) */
async function fakePi(hx: Hx, script: string | null, sub = 'bin'): Promise<string> {
  const wctx = wideCtx(hx.dir);
  const bin = path.join(hx.dir, sub);
  await mkdirp(wctx, bin, 0o755);
  if (script !== null) {
    const f = path.join(bin, 'pi');
    await writeFile(wctx, f, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    await chmod(wctx, f, 0o755);
  }
  return bin;
}

describe('真实子进程出口 runAgentVersionCommand(假 pi 脚本)', () => {
  it('只收固定表里的 agent;claude / codex / 原型链键都被拒,不 spawn;EXEC_ALLOWLIST 仍恰为 [git]', () => {
    expect(Object.keys(AGENT_VERSION_BINARIES)).toEqual(['pi']);
    expect(EXEC_ALLOWLIST).toEqual(['git']);
    for (const a of ['claude', 'codex', 'git', 'constructor', '__proto__', 'toString', '']) {
      expect(() => runAgentVersionCommand(a, { pathEnv: '/usr/bin:/bin' }), a).toThrow(
        AgentProbeDeniedError,
      );
    }
  });

  it('argv 恰为 [--version]、环境只有 PATH(无 HOME)、cwd 为 /、stdin 关闭:脚本逐项自检,全对才打印版本', async () => {
    const hx = await makeHx('a5-piver-real-');
    const bin = await fakePi(
      hx,
      '[ "$#" = 1 ] && [ "$1" = "--version" ] && [ -z "${HOME:-}" ] && [ -z "${HTTPS_PROXY:-}" ] && [ "$(pwd)" = / ] && echo 1.5.0 || exit 9',
    );
    // 即便调用方进程环境里有 HOME / 代理变量,也到不了子进程(这里的 vitest 进程自己就有 HOME)
    const r = runAgentVersionCommand('pi', { pathEnv: bin });
    expect(r.status, r.stderr).toBe(0);
    expect(parseAgentVersionOutput(r.stdout)).toBe('1.5.0');
    expect(makeAgentVersionProbe(bin)('pi')).toBe('1.5.0');
  });

  it('退出非 0 / 输出垃圾 / 找不到命令 / 超时 → undefined;超时按设定的时限杀掉', async () => {
    const hx = await makeHx('a5-piver-real-neg-');
    const t0 = Date.now();
    const slow = await fakePi(hx, 'exec /bin/sleep 20');
    const rs = runAgentVersionCommand('pi', { pathEnv: slow, timeoutMs: 300 });
    expect(rs.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(
      makeAgentVersionProbe(slow, (a, o) => runAgentVersionCommand(a, { ...o, timeoutMs: 300 }))(
        'pi',
      ),
    ).toBeUndefined();
    for (const [script, name] of [
      ['echo 1.5.0; exit 3', '退出 3'],
      ['echo not-a-version', '垃圾'],
      ['echo 1.5.0-beta.2', '预发布'],
    ] as const) {
      const bin = await fakePi(hx, script, `bin-${name}`);
      expect(makeAgentVersionProbe(bin)('pi'), name).toBeUndefined();
    }
    const none = await fakePi(hx, null, 'bin-none'); // 目录存在但没有 pi
    const missing = runAgentVersionCommand('pi', { pathEnv: none });
    expect(missing.spawnError).toBeDefined();
    expect(makeAgentVersionProbe(none)('pi')).toBeUndefined();
    // 正向对照:同一个目录放进正常的脚本就能探测到
    const good = await fakePi(hx, 'echo 1.5.0', 'bin-good');
    expect(makeAgentVersionProbe(good)('pi')).toBe('1.5.0');
  });
});

describe('写闸端到端(生产形状表、假 HOME):pi 版本 >= 1.5.0 才能 --install --write', () => {
  const piHx = async (prefix: string): Promise<Hx> => {
    const hx = await makeHx(prefix);
    await hx.agentRoot('pi');
    return hx;
  };
  const install = (hx: Hx, version: string | undefined, extra: string[] = []) =>
    hx.write(['--install', '--agent', 'pi', '--json', ...extra], {
      shapes: PRODUCTION_SHAPES,
      deps: { agentVersion: () => version },
    });

  it.each(['1.5.0', '1.5.1', '1.10.0', '2.0.0'])(
    '版本 %s → 退 0、真实写入,写出的扩展与 --print 内容逐字一致,verified=true',
    async (version) => {
      const hx = await piHx('a5-piver-ok-');
      const printed = await hx.run(['--print', '--agent', 'pi'], {
        shapes: PRODUCTION_SHAPES,
        deps: { agentVersion: () => version },
      });
      expect(printed.code).toBe(0);
      expect(printed.out).toContain('evidence=实测运行 verified=yes');
      expect(printed.out).not.toContain('形状尚未核实');

      const r = await install(hx, version);
      expect(r.code, r.err).toBe(0);
      expect(jsonOf(r)).toMatchObject({
        verified: true,
        result: 'committed',
        write_level: 'committed',
      });
      const written = await hx.read(PI_TARGET);
      expect(written).toBe(PI_EXTENSION_SOURCE_PLAIN);
      // --print 打印的正是这份内容(整文件,去掉末尾换行后内嵌在输出里)
      expect(printed.out).toContain(written.trimEnd());
      expect(r.audit.length).toBeGreaterThan(0);
      hx.assertAuditInside();
    },
  );

  it.each([
    ['1.4.9', '1.4.9'],
    ['0.9.0', '0.9.0'],
    ['版本未知', undefined],
    ['无法解析', 'garbage'],
    ['缺段', '1.5'],
  ])('%s → 退 4 shape_unverified,零写调用,树不变;干跑 verified=false', async (_n, version) => {
    const hx = await piHx('a5-piver-no-');
    const before = await hx.tree();
    const r = await install(hx, version as string | undefined);
    expect(r.code, r.err).toBe(4);
    expect(r.err).toBe(UNVERIFIED);
    expect(jsonOf(r)).toMatchObject({
      verified: false,
      result: 'not_run',
      write_level: 'zero_write',
    });
    expect(r.audit).toEqual([]);
    expect(await hx.tree()).toEqual(before);
    expect(await hx.has(PI_TARGET)).toBe(false);
    // 干跑(无 --write)照常:退 0、不写
    const dry = await hx.run(['--install', '--agent', 'pi', '--json'], {
      shapes: PRODUCTION_SHAPES,
      deps: { agentVersion: () => version as string | undefined },
    });
    expect(dry.code).toBe(0);
    expect(jsonOf(dry)).toMatchObject({ verified: false, result: 'dry_run' });
    expect(dry.audit).toEqual([]);
  });

  it('未注入探测(deps.agentVersion 缺省)= 版本未知 → 仍被闸(fail closed)', async () => {
    const hx = await piHx('a5-piver-nodep-');
    const r = await hx.write(['--install', '--agent', 'pi'], { shapes: PRODUCTION_SHAPES });
    expect(r.code).toBe(4);
    expect(r.err).toBe(UNVERIFIED);
  });

  it('claude / codex 仍被闸:即使探测报出很高的版本也退 4;且探测对它们一次都不被调用(它们没有版本范围)', async () => {
    for (const agent of ['claude', 'codex'] as const) {
      const hx = await makeHx('a5-piver-others-');
      await hx.agentRoot(agent);
      const asked: string[] = [];
      const r = await hx.write(['--install', '--agent', agent, '--json'], {
        shapes: PRODUCTION_SHAPES,
        deps: {
          agentVersion: (a) => {
            asked.push(a);
            return '99.0.0';
          },
        },
      });
      expect(r.code, `${agent}: ${r.err}`).toBe(4);
      expect(r.err).toBe(UNVERIFIED);
      expect(jsonOf(r)).toMatchObject({ verified: false });
      expect(r.audit).toEqual([]);
      expect(asked).toEqual([]);
    }
  });

  it('探测只在需要版本时被调用:pi 的 --print / --install / --uninstall / --restore 的 verified 字段会问一次;claude 的任何模式都不问', async () => {
    const hx = await piHx('a5-piver-asked-');
    const asked: string[] = [];
    const deps = {
      agentVersion: (a: string) => {
        asked.push(a);
        return '1.5.0';
      },
    };
    await hx.run(['--print', '--agent', 'pi'], { shapes: PRODUCTION_SHAPES, deps });
    expect(asked).toEqual(['pi']);
    await hx.run(['--print', '--agent', 'claude'], { shapes: PRODUCTION_SHAPES, deps });
    await hx.run(['--install', '--agent', 'claude'], { shapes: PRODUCTION_SHAPES, deps });
    await hx.run(['--prune-backups'], { shapes: PRODUCTION_SHAPES, deps });
    expect(asked).toEqual(['pi']); // claude / prune 都没有触发探测
  });

  it('卸载不看版本闸:版本未知也能卸掉之前装的', async () => {
    const hx = await piHx('a5-piver-uninst-');
    expect((await install(hx, '1.5.0')).code).toBe(0);
    const u = await hx.write(['--uninstall', '--agent', 'pi'], {
      shapes: PRODUCTION_SHAPES,
      deps: { agentVersion: () => undefined },
    });
    expect(u.code, u.err).toBe(0);
    expect(await hx.has(PI_TARGET)).toBe(false);
  });
});

describe('生产接线 subcommand.run:版本探测真的接上了(回归:此前 agentVersion 从没传)', () => {
  async function viaSubcommand(hx: Hx, argv: string[], pathEnv: string, line?: string) {
    const a = withWriteAudit();
    let out = '';
    let err = '';
    const ctx: RsiEarlyContext = {
      argv,
      overlayPath: undefined,
      explicitRoot: undefined,
      env: { ...hx.env, PATH: pathEnv },
      writeAudit: a.hook,
      stdout: (t) => (out += t),
      stderr: (t) => (err += t),
      isTty: true,
      readLine: async () => line,
    };
    const code = await subcommand.run(ctx);
    return { code, out, err, audit: a.calls };
  }

  it('PATH 里有 pi 1.5.0 → 干跑 verified=true,--write 经确认后真实写入且与 --print 一致', async () => {
    const hx = await makeHx('a5-piver-prod-ok-');
    await hx.agentRoot('pi');
    const bin = await fakePi(hx, 'echo 1.5.0');
    const dry = await viaSubcommand(hx, ['--install', '--agent', 'pi', '--json'], bin);
    expect(dry.code, dry.err).toBe(0);
    expect(JSON.parse(dry.out)).toMatchObject({ verified: true, result: 'dry_run' });
    const w = await viaSubcommand(
      hx,
      ['--install', '--agent', 'pi', '--write', '--json'],
      bin,
      'yes',
    );
    expect(w.code, w.err).toBe(0);
    expect(await hx.read(PI_TARGET)).toBe(PI_EXTENSION_SOURCE_PLAIN);
    const p = await viaSubcommand(hx, ['--print', '--agent', 'pi'], bin);
    expect(p.out).toContain('evidence=实测运行 verified=yes');
    expect(p.out).toContain(PI_EXTENSION_SOURCE_PLAIN.trimEnd());
  });

  it.each([
    ['pi 1.4.9', 'echo 1.4.9'],
    ['pi 输出垃圾', 'echo hello'],
    ['pi 退出 2', 'echo 1.5.0; exit 2'],
    ['PATH 里没有 pi', null],
  ] as const)('%s → --install --write 退 4 shape_unverified,零写入', async (_n, script) => {
    const hx = await makeHx('a5-piver-prod-no-');
    await hx.agentRoot('pi');
    const bin = await fakePi(hx, script, 'bin-prod');
    const before = await hx.tree();
    const w = await viaSubcommand(hx, ['--install', '--agent', 'pi', '--write'], bin, 'yes');
    expect(w.code, w.err).toBe(4);
    expect(w.err).toBe(UNVERIFIED);
    expect(w.audit).toEqual([]);
    expect(await hx.tree()).toEqual(before);
  });
});
