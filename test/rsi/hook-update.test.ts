/**
 * D-AU1 / D-AU2(contracts §20.19):钩子入口的转发与 poke 顺带调度(进程内;桥接用桩,不起真进程)。
 *  - 调度谓词 `shouldScheduleUpdateFromPoke`:noop why 全矩阵(M1);
 *  - `runPoke` 的 `scheduleUpdate`:跳过条件 / 参数不合法 / rsi off 不调度,armed / 未到期 / 已预留 / 已停止 / spawn 失败照调度;注入口缺省永不调度;抛错不影响结果;
 *  - `runHookEntry`:转发先于本地逻辑、autoSkip 先于转发(M2)、hint 与 `__rsi` 永不调度、转发成功不再跑本地(poke/hint 恒 0,worker 返回子进程码)。
 * 真实 `dist/cli.js` 子进程见 `hook-forward-dist.test.ts`。
 */
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RSI_L0_MIN_INTERVAL_MS } from '../../src/contracts/rsi.js';
import type { RunSelfOptions, RunSelfResult } from '../../src/io/exec.js';
import { getRealHome } from '../../src/io/paths.js';
import { writeFile } from '../../src/io/safe-fs.js';
import { runHookEntry, type HookBridge } from '../../src/rsi/hook-entry.js';
import {
  NO_UPDATE_SCHEDULE_WHY,
  runPoke,
  shouldScheduleUpdateFromPoke,
  type RunPokeDeps,
} from '../../src/rsi/poke.js';
import type { SpawnGateResult } from '../../src/rsi/services/spawn-gate.js';
import { makeTickFx, type TickFx } from './b5a-fixture.js';
import { treeOf, writeCfg } from './rsi-fixture.js';

const T0 = Date.parse('2026-10-24T08:00:00.000Z');

interface Spy {
  runs: RunSelfOptions[];
  updates: number;
  pokeDeps: RunPokeDeps;
}

function spy(f: TickFx, nowMs = T0, spawnResult?: RunSelfResult): Spy {
  const s: Spy = { runs: [], updates: 0, pokeDeps: {} };
  s.pokeDeps = {
    env: f.env,
    writeAudit: (op, p) => void f.audit.push({ op, path: p }),
    now: () => new Date(nowMs),
    nowMs: () => nowMs,
    clockMs: () => 0,
    spawn: {
      runSelf: (o) => {
        s.runs.push(o);
        return spawnResult ?? { spawned: true, status: null, signal: null, stdout: '' };
      },
    },
    scheduleUpdate: async () => {
      s.updates += 1;
    },
  };
  return s;
}

const lastTick = (ms: number): Record<string, unknown> => ({
  last_tick: {
    completed_at: new Date(ms).toISOString(),
    trigger: 'poke',
    outcome: 'ok',
    code: null,
    duration_ms: 1,
    files_read: 0,
    bytes_read: 0,
  },
});

async function stop(f: TickFx): Promise<void> {
  await writeFile(
    f.io,
    path.join(f.rsiDir, 'STOP'),
    '{"at":"2026-10-24T00:00:00.000Z","by":"user"}',
    { mode: 0o600 },
  );
}

describe('M1 调度谓词:noop why 全矩阵', () => {
  const noop = (why: string): SpawnGateResult => ({ kind: 'noop', why });
  // 不调度:跳过条件、参数不合法、rsi 关闭 / 配置不可用、内部错误
  const NO = ['auto_off', 'child', 'ci', 'bad_args', 'off', 'usage', 'error'];
  // 调度:rsi 开着但这次没起 worker 的各种原因 + 起了 / 起失败
  const YES = [
    'collect_blocked',
    'agent_not_enabled',
    'budget',
    'busy',
    'invalid',
    'unsafe',
    'state_invalid',
    'stopped',
    'breaker_open',
    'not_due',
    'reserved',
  ];
  it('NO 集合内的 why 不调度', () => {
    for (const why of NO) expect(shouldScheduleUpdateFromPoke(noop(why)), why).toBe(false);
    expect([...NO_UPDATE_SCHEDULE_WHY].sort()).toEqual([...NO].sort());
  });
  it('其余 noop why(L0 throttled / breaker_open / stopped / state_invalid 等)、spawned、spawn_failed 都调度', () => {
    for (const why of YES) expect(shouldScheduleUpdateFromPoke(noop(why)), why).toBe(true);
    expect(shouldScheduleUpdateFromPoke({ kind: 'spawned' })).toBe(true);
    expect(shouldScheduleUpdateFromPoke({ kind: 'spawn_failed', why: 'x' })).toBe(true);
  });
});

describe('runPoke × scheduleUpdate', () => {
  const skips: [string, Record<string, string>][] = [
    ['KIT_AUTO_RSI=0', { KIT_AUTO_RSI: '0' }],
    ['KIT_RSI_CHILD=1', { KIT_RSI_CHILD: '1' }],
    ['CI=true', { CI: 'true' }],
  ];
  for (const [name, env] of skips) {
    it(`跳过条件 ${name}:不调度`, async () => {
      const f = await makeTickFx('au-skip-');
      const s = spy(f);
      await runPoke(['--agent', 'claude'], { ...s.pokeDeps, env: { ...f.env, ...env } });
      expect(s.updates).toBe(0);
    });
  }
  for (const argv of [[], ['--agent'], ['--agent', 'kimi'], ['--agent=claude'], ['--agent', 'claude', '--x']]) {
    it(`参数不合法 ${JSON.stringify(argv)}:不调度`, async () => {
      const f = await makeTickFx('au-arg-');
      const s = spy(f);
      await runPoke(argv, s.pokeDeps);
      expect(s.updates).toBe(0);
    });
  }
  it('rsi off(没有 [rsi])→ 不调度;零写入', async () => {
    const f = await makeTickFx('au-off-');
    await writeCfg(f, '[update]\n');
    const s = spy(f);
    const before = await treeOf(f.io.stateDir);
    await runPoke(['--agent', 'claude'], s.pokeDeps);
    expect(s.updates).toBe(0);
    expect(f.audit).toEqual([]);
    expect(await treeOf(f.io.stateDir)).toEqual(before);
  });
  it('armed 到期 → spawn rsi worker 且调度一次;同窗口再 poke(已预留)仍调度一次', async () => {
    const f = await makeTickFx('au-armed-');
    const s = spy(f);
    expect(await runPoke(['--agent', 'claude'], s.pokeDeps)).toEqual({ kind: 'spawned' });
    expect(s.updates).toBe(1);
    expect(await runPoke(['--agent', 'claude'], s.pokeDeps)).toMatchObject({ why: 'reserved' });
    expect(s.updates).toBe(2);
    expect(s.runs).toHaveLength(1);
  });
  it('L0 未到期(throttled)→ 仍调度,且 rsi 侧零写入', async () => {
    const f = await makeTickFx('au-throttled-', { state: lastTick(T0) });
    const s = spy(f, T0 + RSI_L0_MIN_INTERVAL_MS - 1);
    const before = await treeOf(f.io.stateDir);
    expect(await runPoke(['--agent', 'claude'], s.pokeDeps)).toMatchObject({ why: 'not_due' });
    expect(s.updates).toBe(1);
    expect(f.audit).toEqual([]);
    expect(await treeOf(f.io.stateDir)).toEqual(before);
  });
  it('已停止(STOP)→ 仍调度;rsi 侧零写入', async () => {
    const f = await makeTickFx('au-stopped-');
    await stop(f);
    const s = spy(f);
    const before = await treeOf(f.io.stateDir);
    f.audit.length = 0;
    await runPoke(['--agent', 'claude'], s.pokeDeps);
    expect(s.updates).toBe(1);
    expect(f.audit).toEqual([]);
    expect(await treeOf(f.io.stateDir)).toEqual(before);
  });
  it('spawn 被拒(spawn_failed)→ 仍调度', async () => {
    const f = await makeTickFx('au-spawnfail-');
    const s = spy(f, T0, { spawned: false, reason: 'current_not_link' });
    expect((await runPoke(['--agent', 'codex'], s.pokeDeps)).kind).toBe('spawn_failed');
    expect(s.updates).toBe(1);
  });
  it('没有注入 scheduleUpdate(进程内分发器 / 旧调用方)→ 永不调度、行为不变', async () => {
    const f = await makeTickFx('au-nosched-');
    const s = spy(f);
    const { scheduleUpdate: _drop, ...rest } = s.pokeDeps;
    void _drop;
    expect(await runPoke(['--agent', 'claude'], rest)).toEqual({ kind: 'spawned' });
    expect(s.updates).toBe(0);
  });
  it('scheduleUpdate 抛错 / 拒绝:吞掉,不改变 poke 的结果', async () => {
    const f = await makeTickFx('au-throw-');
    const s = spy(f);
    const r = await runPoke(['--agent', 'claude'], {
      ...s.pokeDeps,
      scheduleUpdate: async () => {
        throw new Error('boom');
      },
    });
    expect(r).toEqual({ kind: 'spawned' });
  });
});

describe('runHookEntry:转发 / 调度', () => {
  afterEach(() => vi.restoreAllMocks());

  interface Bridge extends HookBridge {
    forwards: { argv: readonly string[]; home: string; timeoutMs?: number | null }[];
    schedules: { home: string }[];
  }
  const bridge = (
    fwd: { forwarded: true; code: number } | { forwarded: false } | 'throw',
  ): Bridge => {
    const b: Bridge = {
      forwards: [],
      schedules: [],
      forward: async (i) => {
        b.forwards.push({
          argv: i.argv,
          home: i.home,
          ...(i.timeoutMs !== undefined ? { timeoutMs: i.timeoutMs } : {}),
        });
        if (fwd === 'throw') throw new Error('x');
        return fwd;
      },
      scheduleUpdate: async (i) => {
        b.schedules.push({ home: i.home });
      },
    };
    return b;
  };
  const stdout = (): { writes: string[] } => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((t: string | Uint8Array) => {
      writes.push(String(t));
      return true;
    });
    return { writes };
  };
  const POKE = ['rsi', 'poke', '--agent', 'claude'];
  const HINT = ['rsi', 'hint', '--agent', 'claude'];
  const WORKER = ['__rsi', '--background'];

  it('poke / hint 转发成功:恒 0、不再跑本地逻辑(零写入、不调度、无输出),home = getRealHome(env)', async () => {
    const f = await makeTickFx('au-fwd-');
    const out = stdout();
    for (const argv of [POKE, HINT]) {
      const b = bridge({ forwarded: true, code: 7 });
      const before = await treeOf(f.io.stateDir);
      f.audit.length = 0;
      expect(await runHookEntry(argv, { env: f.env, bridge: b }), argv.join(' ')).toBe(0);
      expect(b.forwards).toEqual([{ argv, home: getRealHome(f.env) }]);
      expect(b.schedules).toEqual([]);
      expect(await treeOf(f.io.stateDir)).toEqual(before);
    }
    expect(out.writes).toEqual([]);
  });

  it('`__rsi --background` 转发成功:返回子进程码(不设超时);hint / poke 的超时用桥接缺省', async () => {
    const f = await makeTickFx('au-fwd-w-');
    const b = bridge({ forwarded: true, code: 9 });
    expect(await runHookEntry(WORKER, { env: f.env, bridge: b })).toBe(9);
    expect(b.forwards).toEqual([{ argv: WORKER, home: getRealHome(f.env), timeoutMs: null }]);
    expect(b.schedules).toEqual([]);
  });

  it('M2:autoSkip 先于转发——KIT_AUTO_RSI=0 / KIT_RSI_CHILD / CI 下三种钩子都不调桥接', async () => {
    const f = await makeTickFx('au-skip-first-');
    for (const env of [{ KIT_AUTO_RSI: '0' }, { KIT_RSI_CHILD: '1' }, { CI: 'true' }]) {
      for (const argv of [POKE, HINT, WORKER]) {
        const b = bridge({ forwarded: true, code: 7 });
        expect(await runHookEntry(argv, { env: { ...f.env, ...env }, bridge: b })).toBe(0);
        expect(b.forwards, `${JSON.stringify(env)} ${argv.join(' ')}`).toEqual([]);
        expect(b.schedules).toEqual([]);
      }
    }
  });

  it('带全局选项的 poke / hint 空操作、不转发;`__rsi` 参数不合法退 2、不转发', async () => {
    const f = await makeTickFx('au-global-');
    for (const argv of [
      ['--root', f.repo, ...POKE],
      ['--version', ...HINT],
    ]) {
      const b = bridge({ forwarded: true, code: 7 });
      expect(await runHookEntry(argv, { env: f.env, bridge: b })).toBe(0);
      expect(b.forwards).toEqual([]);
    }
    for (const argv of [['__rsi'], ['__rsi', '--background', '--x'], ['--root', '/x', ...WORKER]]) {
      const b = bridge({ forwarded: true, code: 7 });
      expect(await runHookEntry(argv, { env: f.env, bridge: b })).toBe(2);
      expect(b.forwards).toEqual([]);
    }
  });

  it('没转发 + poke:本地逻辑跑完后经桥接调度恰好一次(STOP 世界:rsi 侧无写入也无 spawn)', async () => {
    const f = await makeTickFx('au-local-poke-');
    await stop(f);
    const b = bridge({ forwarded: false });
    const before = await treeOf(f.io.stateDir);
    expect(await runHookEntry(POKE, { env: f.env, bridge: b })).toBe(0);
    expect(b.forwards).toHaveLength(1);
    expect(b.schedules).toEqual([{ home: getRealHome(f.env) }]);
    expect(await treeOf(f.io.stateDir)).toEqual(before);
  });

  it('没转发 + hint / `__rsi`:永不调度', async () => {
    const f = await makeTickFx('au-local-hint-');
    await stop(f);
    const out = stdout();
    for (const argv of [HINT, WORKER]) {
      const b = bridge({ forwarded: false });
      expect(await runHookEntry(argv, { env: f.env, bridge: b }), argv.join(' ')).toBe(0);
      expect(b.forwards).toHaveLength(1);
      expect(b.schedules, argv.join(' ')).toEqual([]);
    }
    expect(out.writes).toEqual([]);
  });

  it('桥接抛错:钩子仍退 0(`__rsi` 同样不暴露失败)', async () => {
    const f = await makeTickFx('au-throw-');
    for (const argv of [POKE, HINT, WORKER]) {
      expect(await runHookEntry(argv, { env: f.env, bridge: bridge('throw') })).toBe(0);
    }
  });
});
