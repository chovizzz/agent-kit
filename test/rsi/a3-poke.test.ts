/**
 * R20-A3:`rsi poke`(契约 R20-3.2、R20-6.1 ~ R20-6.3、R20-1.6、R20-3.2.3)与顺带调度共用闸。进程内调用,spawn 经 `runSelf` 注入,不起真进程。
 * 零写入 = 外部写审计为空 + `.state` 树前后一致(R20-1.10 / §20.8.1 两层判据)。全部在假 HOME / KIT_TMP 内。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RSI_BREAKER_OPEN_MS,
  RSI_L0_MIN_INTERVAL_MS,
  RSI_POKE_WINDOW_MS,
} from '../../src/contracts/rsi.js';
import type { RunSelfOptions, RunSelfResult } from '../../src/io/exec.js';
import { exists, readText } from '../../src/io/read-fs.js';
import { writeFile } from '../../src/io/safe-fs.js';
import { windowIndex } from '../../src/rsi/services/breaker.js';
import { runPoke, type RunPokeDeps } from '../../src/rsi/poke.js';
import { scheduleRsiAfterCommand } from '../../src/rsi/kit-schedule.js';
import { makeTickFx, type TickFx } from './b5a-fixture.js';
import { treeOf, rsiToml, writeCfg } from './rsi-fixture.js';
import { baseState, seed } from './ro-fixture.js';

const T0 = Date.parse('2026-10-24T08:00:00.000Z');

interface Spy {
  calls: RunSelfOptions[];
  deps: RunPokeDeps;
}

function spy(
  f: TickFx,
  nowMs = T0,
  result: RunSelfResult = { spawned: true, status: null, signal: null, stdout: '' },
): Spy {
  const calls: RunSelfOptions[] = [];
  return {
    calls,
    deps: {
      env: f.env,
      writeAudit: (op, p) => void f.audit.push({ op, path: p }),
      now: () => new Date(nowMs),
      nowMs: () => nowMs,
      clockMs: () => 0,
      spawn: {
        runSelf: (o) => {
          calls.push(o);
          return result;
        },
      },
    },
  };
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

async function zeroWrite(f: TickFx, run: () => Promise<unknown>): Promise<void> {
  const before = await treeOf(f.io.stateDir);
  f.audit.length = 0;
  await run();
  expect(f.audit).toEqual([]);
  expect(await treeOf(f.io.stateDir)).toEqual(before);
}

const marker = (f: TickFx, agent: string, ms = T0): string =>
  path.join(f.rsiDir, 'poke', `${agent}-${windowIndex(ms)}`);

describe('R20-1.6 跳过条件 × 状态:零写入、不 spawn', () => {
  const skips: [string, Record<string, string>][] = [
    ['KIT_AUTO_RSI=0', { KIT_AUTO_RSI: '0' }],
    ['KIT_RSI_CHILD=1', { KIT_RSI_CHILD: '1' }],
    ['CI=true', { CI: 'true' }],
    ['GITHUB_ACTIONS=true', { GITHUB_ACTIONS: 'true' }],
  ];
  for (const st of ['armed', 'confirmed', 'stopped'] as const) {
    for (const [name, env] of skips) {
      it(`${st} × ${name}`, async () => {
        const f = await makeTickFx('a3-poke-skip-', { confirmed: st === 'confirmed' });
        if (st === 'stopped')
          await writeFile(
            f.io,
            path.join(f.rsiDir, 'STOP'),
            '{"at":"2026-10-24T00:00:00.000Z","by":"user"}',
            { mode: 0o600 },
          );
        const s = spy(f);
        await zeroWrite(f, () =>
          runPoke(['--agent', 'claude'], { ...s.deps, env: { ...f.env, ...env } }),
        );
        expect(s.calls).toEqual([]);
      });
    }
  }
  it('off(没有 [rsi])× 无跳过变量:零写入', async () => {
    const f = await makeTickFx('a3-poke-off-');
    await writeCfg(f, '[update]\n');
    const s = spy(f);
    await zeroWrite(f, () => runPoke(['--agent', 'claude'], s.deps));
    expect(s.calls).toEqual([]);
  });
  it('KIT_AUTO_RSI=1 与未设相同(只能关不能开):照常 spawn', async () => {
    const f = await makeTickFx('a3-poke-on1-');
    const s = spy(f);
    const r = await runPoke(['--agent', 'claude'], {
      ...s.deps,
      env: { ...f.env, KIT_AUTO_RSI: '1' },
    });
    expect(r).toEqual({ kind: 'spawned' });
    expect(s.calls).toHaveLength(1);
  });
});

describe('R20-3.2.4 参数:缺失 / 非法 / 不在 [rsi] agents → 空操作(零写入、不报错)', () => {
  const bad: string[][] = [
    [],
    ['--agent'],
    ['--agent', 'kimi'],
    ['--agent=claude'],
    ['--agent', 'claude', '--x'],
    ['--format', 'json'],
  ];
  for (const argv of bad) {
    it(JSON.stringify(argv), async () => {
      const f = await makeTickFx('a3-poke-arg-');
      const s = spy(f);
      await zeroWrite(f, () => runPoke(argv, s.deps));
      expect(s.calls).toEqual([]);
    });
  }
  it('agent 不在 [rsi] agents 里', async () => {
    const f = await makeTickFx('a3-poke-agents-', { extra: 'agents = ["pi"]\n' });
    const s = spy(f);
    await zeroWrite(f, () => runPoke(['--agent', 'claude'], s.deps));
    expect(s.calls).toEqual([]);
  });
});

describe('R20-3.2.2 / R20-6.2 到期 → 预留 → spawn;每 agent 每窗口至多一个', () => {
  it('首次:写预留标记 + 日志一行(trigger=poke、agent、spawned),spawn 一次,参数固定、cwd = [rsi] repo', async () => {
    const f = await makeTickFx('a3-poke-go-');
    const s = spy(f);
    f.audit.length = 0;
    expect(await runPoke(['--agent', 'claude'], s.deps)).toEqual({ kind: 'spawned' });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]).toMatchObject({
      args: ['__rsi', '--background'],
      background: true,
      cwd: f.repo,
      home: f.home,
      target: { kind: 'self' },
    });
    expect(await exists(marker(f, 'claude'))).toBe(true);
    const log = (await readText(path.join(f.rsiDir, 'log.jsonl')))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(log.at(-1)).toEqual({
      at: new Date(T0).toISOString(),
      trigger: 'poke',
      agent: 'claude',
      action: 'spawned',
      code: 'spawned',
    });
    // 写入只有:目录准备、预留标记(独占创建)、日志追加
    const ops = f.audit.map((c) => `${c.op} ${path.relative(f.io.stateDir, c.path)}`);
    expect(ops.filter((o) => !o.startsWith('mkdirp') && !o.startsWith('chmod'))).toEqual([
      `createExclusive ${path.relative(f.io.stateDir, marker(f, 'claude'))}`,
      'appendFile rsi/log.jsonl',
    ]);
  });
  it('同一窗口的第二个 poke:EEXIST → 空操作、不 spawn、零写入(去掉预留检查 → 两个都 spawn → 红)', async () => {
    const f = await makeTickFx('a3-poke-dup-');
    const s = spy(f);
    await runPoke(['--agent', 'claude'], s.deps);
    const s2 = spy(f, T0 + RSI_POKE_WINDOW_MS - (T0 % RSI_POKE_WINDOW_MS) - 1);
    await zeroWrite(f, () => runPoke(['--agent', 'claude'], s2.deps));
    expect(s2.calls).toEqual([]);
  });
  it('不同 agent 各自预留;下一个窗口可再起', async () => {
    const f = await makeTickFx('a3-poke-agents2-');
    const a = spy(f);
    await runPoke(['--agent', 'claude'], a.deps);
    await runPoke(['--agent', 'pi'], a.deps);
    expect(a.calls).toHaveLength(2);
    const b = spy(f, T0 + RSI_POKE_WINDOW_MS);
    await runPoke(['--agent', 'claude'], b.deps);
    expect(b.calls).toHaveLength(1);
  });
  it('spawn 被拒 → 日志 spawn_failed(预留已占,不重试)', async () => {
    const f = await makeTickFx('a3-poke-fail-');
    const s = spy(f, T0, { spawned: false, reason: 'current_not_link' });
    const r = await runPoke(['--agent', 'codex'], s.deps);
    expect(r.kind).toBe('spawn_failed');
    const last = (await readText(path.join(f.rsiDir, 'log.jsonl')))
      .trim()
      .split('\n')
      .at(-1) as string;
    expect(JSON.parse(last)).toMatchObject({ action: 'spawn_failed', agent: 'codex' });
  });
  it('从未建过 .state 的首次 armed:允许建 .state/rsi/poke(armed 行允许的写),不建 signals / sessions / salt / 索引 / cursor(N5)', async () => {
    const f = await makeTickFx('a3-poke-fresh-', { noSeed: true });
    const s = spy(f);
    expect(await runPoke(['--agent', 'claude'], s.deps)).toEqual({ kind: 'spawned' });
    for (const n of [
      'signals',
      'sessions',
      'salt',
      'rsi/projects.json',
      'rsi/cursor.json',
      'rsi/state.json',
    ]) {
      expect(await exists(path.join(f.io.stateDir, n)), n).toBe(false);
    }
  });
});

describe('R20-6.3 L0 间隔与熔断(锁外,零写入)', () => {
  it('上次完成不足 6h → 空操作;恰 6h → spawn;时钟回拨 → spawn', async () => {
    const f = await makeTickFx('a3-poke-due-', { state: lastTick(T0) });
    const s1 = spy(f, T0 + RSI_L0_MIN_INTERVAL_MS - 1);
    await zeroWrite(f, () => runPoke(['--agent', 'claude'], s1.deps));
    expect(s1.calls).toEqual([]);
    const s2 = spy(f, T0 + RSI_L0_MIN_INTERVAL_MS);
    expect((await runPoke(['--agent', 'claude'], s2.deps)).kind).toBe('spawned');
    const g = await makeTickFx('a3-poke-back-', { state: lastTick(T0) });
    const s3 = spy(g, T0 - 1000);
    expect((await runPoke(['--agent', 'claude'], s3.deps)).kind).toBe('spawned');
  });
  it('retryable 熔断未到 until → 空操作;到 until(半开)→ spawn;safety → 永远空操作', async () => {
    const open = {
      breaker: {
        kind: 'retryable',
        opened_at: new Date(T0).toISOString(),
        until: new Date(T0 + RSI_BREAKER_OPEN_MS).toISOString(),
      },
    };
    const f = await makeTickFx('a3-poke-brk-', { state: open });
    const s1 = spy(f, T0 + RSI_BREAKER_OPEN_MS - 1);
    await zeroWrite(f, () => runPoke(['--agent', 'claude'], s1.deps));
    const s2 = spy(f, T0 + RSI_BREAKER_OPEN_MS);
    expect((await runPoke(['--agent', 'claude'], s2.deps)).kind).toBe('spawned');
    const g = await makeTickFx('a3-poke-safety-', {
      state: { breaker: { kind: 'safety', opened_at: new Date(T0).toISOString(), until: null } },
    });
    const s3 = spy(g, T0 + 100 * RSI_BREAKER_OPEN_MS);
    await zeroWrite(g, () => runPoke(['--agent', 'claude'], s3.deps));
    expect(s3.calls).toEqual([]);
  });
  it('停止采集(exclude 不合规)/ state.json 损坏 / 清单不一致 → 空操作、零写入', async () => {
    const a = await makeTickFx('a3-poke-blk-', { extra: 'exclude_dirs = ["rel"]\n' });
    await zeroWrite(a, () => runPoke(['--agent', 'claude'], spy(a).deps));
    const b = await makeTickFx('a3-poke-bad-');
    await seed(b, { raw: { 'state.json': '{"x":1}' } });
    await zeroWrite(b, () => runPoke(['--agent', 'claude'], spy(b).deps));
    const c = await makeTickFx('a3-poke-busy-');
    await writeFile(
      c.io,
      path.join(c.rsiDir, 'state.json'),
      JSON.stringify(baseState({ consecutive_failures: 1 })),
      { mode: 0o600 },
    );
    await zeroWrite(c, () => runPoke(['--agent', 'claude'], spy(c).deps));
  });
  it('超出 1s 尽力预算 → 空操作、零写入、不 spawn', async () => {
    const f = await makeTickFx('a3-poke-budget-');
    const s = spy(f);
    let t = 0;
    await zeroWrite(f, () =>
      runPoke(['--agent', 'claude'], { ...s.deps, clockMs: () => (t += 600) }),
    );
    expect(s.calls).toEqual([]);
  });
});

describe('R20-1.7 顺带调度:与 poke 同一套闸,预留 kit-<窗口>,日志不带 agent', () => {
  it('TTY + 白名单命令 → spawn;非 TTY / KIT_LAUNCHED / 非白名单 → 零写入', async () => {
    const f = await makeTickFx('a3-kit-');
    const s = spy(f);
    const d = { now: s.deps.now!, nowMs: s.deps.nowMs!, spawn: s.deps.spawn! };
    for (const [argv, tty, env] of [
      [['build'], false, {}],
      [['build'], true, { KIT_LAUNCHED: '1' }],
      [['doctor'], true, {}],
      [['reflect', '--run-llm'], true, {}],
    ] as [string[], boolean, Record<string, string>][]) {
      await zeroWrite(f, () =>
        scheduleRsiAfterCommand(
          { argv, env: { ...f.env, ...env }, isTty: tty, writeAudit: s.deps.writeAudit! },
          d,
        ),
      );
    }
    expect(s.calls).toEqual([]);
    expect(await scheduleRsiAfterCommand({ argv: ['check'], env: f.env, isTty: true }, d)).toEqual({
      kind: 'spawned',
    });
    expect(await exists(marker(f, 'kit'))).toBe(true);
    const last = (await readText(path.join(f.rsiDir, 'log.jsonl')))
      .trim()
      .split('\n')
      .at(-1) as string;
    expect(JSON.parse(last)).toEqual({
      at: new Date(T0).toISOString(),
      trigger: 'kit',
      action: 'spawned',
      code: 'spawned',
    });
  });
  it('配置读取失败(权限过宽)→ 不调度、零写入', async () => {
    const f = await makeTickFx('a3-kit-cfg-');
    await writeCfg(f, rsiToml(f), 0o666);
    const s = spy(f);
    await zeroWrite(f, () =>
      scheduleRsiAfterCommand(
        { argv: ['build'], env: f.env, isTty: true, writeAudit: s.deps.writeAudit! },
        { now: s.deps.now!, spawn: s.deps.spawn! },
      ),
    );
    expect(s.calls).toEqual([]);
  });
});
