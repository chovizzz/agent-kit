/**
 * R20-A3:后台 worker `__rsi --background`(契约 R20-3.9、R20-6.2 ~ R20-6.6、R20-1.6、R20-5.7;A3 方案 v2 R1 ~ R3)。
 * 进程内调用 `runWorker`(会话文件在假 HOME 的 claude 根);锁占用方 / 锁观察方是真子进程(test/rsi/proc/child-entry.ts)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RSI_BREAKER_OPEN_MS,
  RSI_L0_MIN_INTERVAL_MS,
  type RsiState,
} from '../../src/contracts/rsi.js';
import { exists, readDir, readText } from '../../src/io/read-fs.js';
import { mkdirp, remove, writeFile } from '../../src/io/safe-fs.js';
import { windowIndex } from '../../src/rsi/services/breaker.js';
import { runWorker, type RsiWorkerRunDeps } from '../../src/rsi/worker.js';
import { makeTempDir } from '../helpers/tmp.js';
import { foreignLock, makeTickFx, rsiJson, runCmd, type TickFx } from './b5a-fixture.js';
import { runTick } from '../../src/rsi/tick.js';
import { jl, put as putSession, uuid } from './l0-fixture.js';
import { buildChild, runChild } from './proc/helper.js';
import { rsiToml, treeOf, writeCfg } from './rsi-fixture.js';
import { NOW, baseState, seed } from './ro-fixture.js';

const T = Date.parse(NOW);
const iso = (ms: number): string => new Date(ms).toISOString();

function wdeps(f: TickFx, nowMs = T, over: Partial<RsiWorkerRunDeps> = {}): RsiWorkerRunDeps {
  return {
    env: f.env,
    writeAudit: (op, p) => void f.audit.push({ op, path: p }),
    now: () => new Date(nowMs),
    nowMs: () => nowMs,
    ...over,
  };
}

async function stateOf(f: TickFx): Promise<RsiState> {
  return (await rsiJson(f, 'state.json')) as unknown as RsiState;
}

async function logLines(f: TickFx): Promise<Record<string, unknown>[]> {
  const p = path.join(f.rsiDir, 'log.jsonl');
  if (!(await exists(p))) return [];
  return (await readText(p))
    .trim()
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const recent = (ms: number): Record<string, unknown> => ({
  last_tick: {
    completed_at: iso(ms),
    trigger: 'poke',
    outcome: 'ok',
    code: null,
    duration_ms: 1,
    files_read: 0,
    bytes_read: 0,
  },
});

describe('正常运行(armed / confirmed)', () => {
  it('首次 armed:只列举;state.json 记 last_tick(trigger=poke)与 armed 列举,attempt 清空;不建盐 / 信号库 / 索引(N5)', async () => {
    const f = await makeTickFx('a3-w-armed-');
    const r = await runWorker(wdeps(f));
    expect(r).toEqual({ kind: 'ran', outcome: 'ok', recorded: true });
    const s = await stateOf(f);
    expect(s.attempt).toBeNull();
    expect(s.last_tick).toMatchObject({ trigger: 'poke', outcome: 'ok', completed_at: NOW });
    for (const n of ['salt', 'signals', 'sessions', 'rsi/projects.json', 'rsi/cursor.json']) {
      expect(await exists(path.join(f.io.stateDir, n)), n).toBe(false);
    }
    expect((await logLines(f)).at(-1)).toMatchObject({
      trigger: 'poke',
      action: 'completed',
      code: 'ok',
    });
    expect(await exists(path.join(f.rsiDir, 'lock'))).toBe(false);
  });

  it('confirmed:采集信号、熔断计数清零', async () => {
    const f = await makeTickFx('a3-w-conf-', {
      confirmed: true,
      state: { consecutive_failures: 2 },
    });
    const r = await runWorker(wdeps(f));
    expect(r).toMatchObject({ kind: 'ran', outcome: 'ok' });
    expect(await exists(path.join(f.io.stateDir, 'signals', 'claude'))).toBe(true);
    const s = await stateOf(f);
    expect(s.consecutive_failures).toBe(0);
    expect(s.breaker).toBeNull();
    expect(s.attempt).toBeNull();
  });

  it('attempt 在读任何会话文件之前已落盘(读阶段第一步时 state.json 里就有;移到读之后 → 红)', async () => {
    const f = await makeTickFx('a3-w-attempt-', { confirmed: true });
    const seen: unknown[] = [];
    const r = await runWorker(
      wdeps(f, T, {
        run: {
          l0: {
            beforeStep: async () => {
              if (seen.length === 0) seen.push((await stateOf(f)).attempt);
            },
          },
        },
      }),
    );
    expect(r).toMatchObject({ kind: 'ran', outcome: 'ok' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ started_at: NOW });
  });
});

describe('R20-6.3 / R20-6.6 锁内节流与熔断', () => {
  it('不到 6h:skipped_throttled(日志一行),不写 attempt、不读会话、不建盐', async () => {
    const f = await makeTickFx('a3-w-thr-', { confirmed: true, state: recent(T) });
    const r = await runWorker(wdeps(f, T + RSI_L0_MIN_INTERVAL_MS - 1));
    expect(r).toEqual({ kind: 'ran', outcome: 'skipped_throttled', recorded: true });
    expect((await logLines(f)).at(-1)).toMatchObject({
      action: 'skipped',
      code: 'skipped_throttled',
    });
    expect((await stateOf(f)).attempt).toBeNull();
    expect(await exists(path.join(f.io.stateDir, 'salt'))).toBe(false);
  });

  it('retryable 熔断打开未到 until:日志 breaker_open,不开始新工作;last_tick 不动', async () => {
    const br = { kind: 'retryable', opened_at: iso(T), until: iso(T + RSI_BREAKER_OPEN_MS) };
    const f = await makeTickFx('a3-w-open-', { confirmed: true, state: { breaker: br } });
    const r = await runWorker(wdeps(f, T + 1000));
    expect(r).toEqual({ kind: 'refused_in_lock', why: 'breaker_open' });
    expect((await logLines(f)).at(-1)).toMatchObject({ action: 'skipped', code: 'breaker_open' });
    const s = await stateOf(f);
    expect(s.last_tick).toBeNull();
    expect(s.breaker).toEqual(br);
    expect(await exists(path.join(f.io.stateDir, 'salt'))).toBe(false);
  });

  it('safety 熔断:永不自动半开', async () => {
    const f = await makeTickFx('a3-w-safety-', {
      confirmed: true,
      state: { breaker: { kind: 'safety', opened_at: iso(T), until: null } },
    });
    expect(await runWorker(wdeps(f, T + 100 * RSI_BREAKER_OPEN_MS))).toEqual({
      kind: 'refused_in_lock',
      why: 'breaker_open',
    });
  });

  it('半开尝试成功 → 熔断关闭', async () => {
    const f = await makeTickFx('a3-w-half-ok-', {
      confirmed: true,
      state: {
        breaker: { kind: 'retryable', opened_at: iso(T), until: iso(T + RSI_BREAKER_OPEN_MS) },
      },
    });
    const r = await runWorker(wdeps(f, T + RSI_BREAKER_OPEN_MS));
    expect(r).toMatchObject({ outcome: 'ok' });
    expect((await stateOf(f)).breaker).toBeNull();
  });

  it('半开尝试失败(EIO)→ 立刻再开 24h', async () => {
    const f = await makeTickFx('a3-w-half-bad-', {
      confirmed: true,
      state: {
        breaker: { kind: 'retryable', opened_at: iso(T), until: iso(T + RSI_BREAKER_OPEN_MS) },
      },
    });
    const now = T + RSI_BREAKER_OPEN_MS;
    let armed = false;
    const r = await runWorker(
      wdeps(f, now, {
        run: {
          l0: {
            beforeStep: () => {
              armed = true;
              throw Object.assign(new Error('io'), { code: 'EIO' });
            },
          },
        },
      }),
    );
    expect(armed).toBe(true);
    expect(r).toEqual({ kind: 'ran', outcome: 'io_error', recorded: true });
    const s = await stateOf(f);
    expect(s.breaker).toEqual({
      kind: 'retryable',
      opened_at: iso(now),
      until: iso(now + RSI_BREAKER_OPEN_MS),
    });
    expect(s.attempt).toBeNull();
    expect((await logLines(f)).at(-1)).toMatchObject({ action: 'failed', code: 'io_error' });
  });

  it('连续可重试失败:第 3 次打开熔断', async () => {
    const f = await makeTickFx('a3-w-three-', {
      confirmed: true,
      state: { consecutive_failures: 2 },
    });
    const r = await runWorker(
      wdeps(f, T, {
        run: {
          l0: {
            beforeStep: () => Promise.reject(Object.assign(new Error('x'), { code: 'EMFILE' })),
          },
        },
      }),
    );
    expect(r).toMatchObject({ outcome: 'io_error', recorded: true });
    expect((await stateOf(f)).breaker?.kind).toBe('retryable');
  });

  it('残留 attempt + 已有 2 次失败:先记 crashed(第 3 次)→ 熔断打开 → 本轮不读会话文件(Pi 评审 R2)', async () => {
    const f = await makeTickFx('a3-w-residual-', {
      confirmed: true,
      state: {
        consecutive_failures: 2,
        attempt: { started_at: iso(T - 60_000), nonce: '0'.repeat(16) },
      },
    });
    let reads = 0;
    const r = await runWorker(wdeps(f, T, { run: { l0: { beforeStep: () => void reads++ } } }));
    expect(r).toEqual({ kind: 'refused_in_lock', why: 'breaker_open' });
    expect(reads).toBe(0);
    const s = await stateOf(f);
    expect(s.attempt).toBeNull();
    expect(s.breaker?.kind).toBe('retryable');
    const codes = (await logLines(f)).map((l) => l['code']);
    expect(codes.slice(-2)).toEqual(['crashed', 'breaker_open']);
    // 再跑一次:同一次崩溃不重复累计
    await runWorker(wdeps(f, T + 1));
    expect((await logLines(f)).filter((l) => l['code'] === 'crashed')).toHaveLength(1);
  });

  it('残留 attempt、此前无失败:记一次 crashed 后照常运行并成功(成功清零)', async () => {
    const f = await makeTickFx('a3-w-residual-ok-', {
      confirmed: true,
      state: { attempt: { started_at: iso(T - 60_000), nonce: '1'.repeat(16) } },
    });
    const r = await runWorker(wdeps(f));
    expect(r).toMatchObject({ outcome: 'ok' });
    const s = await stateOf(f);
    expect(s.consecutive_failures).toBe(0);
    expect((await logLines(f)).map((l) => l['code'])).toContain('crashed');
  });
});

describe('失败记账:可记录 / 不可记录', () => {
  it('安全阻断(盐损坏 → salt_invalid):熔断 kind=safety 落盘', async () => {
    const f = await makeTickFx('a3-w-salt-', { confirmed: true });
    await writeFile(f.io, path.join(f.io.stateDir, 'salt'), 'not-a-salt', { mode: 0o600 });
    const r = await runWorker(wdeps(f));
    expect(r).toEqual({ kind: 'ran', outcome: 'salt_invalid', recorded: true });
    const s = await stateOf(f);
    expect(s.breaker).toEqual({ kind: 'safety', opened_at: NOW, until: null });
    expect((await logLines(f)).at(-1)).toMatchObject({ action: 'failed', code: 'salt_invalid' });
  });

  it('失锁(lock_lost):不可记录,失锁之后零写入', async () => {
    const f = await makeTickFx('a3-w-lost-', { confirmed: true });
    let lostAt = -1;
    const r = await runWorker(
      wdeps(f, T, {
        run: {
          l0: {
            beforeStep: async () => {
              if (lostAt < 0) {
                await remove(f.fx, path.join(f.rsiDir, 'lock'));
                lostAt = f.audit.length;
              }
            },
          },
        },
      }),
    );
    expect(r).toEqual({ kind: 'ran', outcome: 'lock_lost', recorded: false });
    expect(f.audit.slice(lostAt)).toEqual([]);
    expect((await logLines(f)).some((l) => l['code'] === 'lock_lost')).toBe(false);
    expect((await stateOf(f)).breaker).toBeNull();
  });

  it('state.json 损坏:锁外预检即放弃,不拿锁、零写入', async () => {
    const f = await makeTickFx('a3-w-stbad-');
    await seed(f, { raw: { 'state.json': '{"x":1}' } });
    const before = await treeOf(f.io.stateDir);
    f.audit.length = 0;
    expect(await runWorker(wdeps(f))).toEqual({ kind: 'skipped_pre_lock', why: 'state_invalid' });
    expect(f.audit).toEqual([]);
    expect(await treeOf(f.io.stateDir)).toEqual(before);
  });
});

describe('锁外跳过(零写入)', () => {
  const cases: [string, Record<string, string>][] = [
    ['KIT_AUTO_RSI=0', { KIT_AUTO_RSI: '0' }],
    ['KIT_RSI_CHILD=1', { KIT_RSI_CHILD: '1' }],
    ['CI', { CI: 'true' }],
  ];
  for (const [n, env] of cases) {
    it(n, async () => {
      const f = await makeTickFx('a3-w-skip-', { confirmed: true });
      const before = await treeOf(f.io.stateDir);
      f.audit.length = 0;
      const r = await runWorker({ ...wdeps(f), env: { ...f.env, ...env } });
      expect(r.kind).toBe('skipped_pre_lock');
      expect(f.audit).toEqual([]);
      expect(await treeOf(f.io.stateDir)).toEqual(before);
    });
  }
  it('KIT_LAUNCHED=1 不影响 worker(runSelf 子进程恒带它)', async () => {
    const f = await makeTickFx('a3-w-launched-');
    expect(await runWorker({ ...wdeps(f), env: { ...f.env, KIT_LAUNCHED: '1' } })).toMatchObject({
      kind: 'ran',
      outcome: 'ok',
    });
  });
  it('stopped:锁外预检放弃,零写入', async () => {
    const f = await makeTickFx('a3-w-stop-', { confirmed: true });
    await writeFile(
      f.io,
      path.join(f.rsiDir, 'STOP'),
      '{"at":"2026-10-24T00:00:00.000Z","by":"user"}',
      { mode: 0o600 },
    );
    const before = await treeOf(f.io.stateDir);
    f.audit.length = 0;
    expect(await runWorker(wdeps(f))).toEqual({ kind: 'skipped_pre_lock', why: 'stopped' });
    expect(f.audit).toEqual([]);
    expect(await treeOf(f.io.stateDir)).toEqual(before);
  });
  it('锁内复检(拿锁之后才写下 STOP):释放锁、零业务写入(只有锁基础设施)', async () => {
    const f = await makeTickFx('a3-w-stop2-', { confirmed: true });
    f.audit.length = 0;
    const r = await runWorker(
      wdeps(f, T, {
        afterLock: () =>
          writeFile(
            f.fx,
            path.join(f.rsiDir, 'STOP'),
            '{"at":"2026-10-24T00:00:00.000Z","by":"user"}',
            { mode: 0o600 },
          ),
      }),
    );
    expect(r).toEqual({ kind: 'refused_in_lock', why: 'stopped' });
    const ops = f.audit
      .map((c) => `${c.op} ${path.basename(c.path)}`)
      .filter((o) => !o.startsWith('mkdirp'));
    expect(ops).toEqual(['createExclusive lock', 'remove lock']);
  });
});

describe('R20-5.7 / R20-6.2 锁占用、update 忙、预留清理', () => {
  it('另一个持锁方在:skipped_locked,只无锁追加一行日志(rsi/ 已存在且安全)', async () => {
    const f = await makeTickFx('a3-w-locked-', { confirmed: true });
    const release = await foreignLock(f);
    try {
      f.audit.length = 0;
      expect(await runWorker(wdeps(f))).toEqual({ kind: 'skipped_locked' });
      expect(
        f.audit
          .map((c) => `${c.op} ${path.basename(c.path)}`)
          .filter((o) => !o.startsWith('mkdirp')),
      ).toEqual(['createExclusive lock', 'appendFile log.jsonl']);
      expect((await logLines(f)).at(-1)).toMatchObject({
        action: 'skipped',
        code: 'skipped_locked',
      });
    } finally {
      await release();
    }
  });

  it('update/lock 持有者存活 → skipped_update_busy(不计熔断、不读会话)', async () => {
    const f = await makeTickFx('a3-w-upd-', {
      confirmed: true,
      state: { consecutive_failures: 1 },
    });
    const dir = path.join(f.home, '.local', 'state', 'agent-kit', 'update');
    await mkdirp(f.fx, dir, 0o700);
    await writeFile(f.fx, path.join(dir, 'lock'), JSON.stringify({ pid: 4242 }), { mode: 0o600 });
    const r = await runWorker(wdeps(f, T, { isAlive: (p) => p === 4242 }));
    expect(r).toEqual({ kind: 'ran', outcome: 'skipped_update_busy', recorded: true });
    expect((await stateOf(f)).consecutive_failures).toBe(1);
    expect(await exists(path.join(f.io.stateDir, 'salt'))).toBe(false);
    // 持有者已死 → 照常运行
    expect(await runWorker(wdeps(f, T, { isAlive: () => false }))).toMatchObject({ outcome: 'ok' });
  });

  it('删除早于当前窗口 2 个以上的预留标记,其余与格式不符的文件不动', async () => {
    const f = await makeTickFx('a3-w-prune-');
    const w = windowIndex(T);
    const dir = path.join(f.rsiDir, 'poke');
    await mkdirp(f.fx, dir, 0o700);
    const names = [
      `claude-${w}`,
      `claude-${w - 1}`,
      `pi-${w - 2}`,
      `codex-${w - 3}`,
      `kit-${w - 10}`,
      'notes.txt',
    ];
    for (const n of names) await writeFile(f.fx, path.join(dir, n), '{}', { mode: 0o600 });
    await runWorker(wdeps(f));
    const left = (await readDir(dir)).map((e) => e.name).sort();
    expect(left).toEqual([`claude-${w}`, `claude-${w - 1}`, `pi-${w - 2}`, 'notes.txt'].sort());
  });

  it('log.jsonl 截断到最近 200 行(R20-6.7):在本轮全部追加之后截断,结束时恰好 200 行', async () => {
    for (const [initial, over] of [
      [199, {}],
      [200, {}],
      [250, {}],
      [200, { update: true }],
    ] as [number, { update?: boolean }][]) {
      const f = await makeTickFx('a3-w-log-');
      const line = (i: number): string =>
        `${JSON.stringify({ action: 'skipped', at: iso(T - 1000 * (300 - i)), code: `c${i}`, trigger: 'poke' })}\n`;
      let body = '';
      for (let i = 0; i < initial; i++) body += line(i);
      await writeFile(f.io, path.join(f.rsiDir, 'log.jsonl'), body, { mode: 0o600 });
      if (over.update === true) {
        const dir = path.join(f.home, '.local', 'state', 'agent-kit', 'update');
        await mkdirp(f.fx, dir, 0o700);
        await writeFile(f.fx, path.join(dir, 'lock'), JSON.stringify({ pid: 4242 }), {
          mode: 0o600,
        });
      }
      await runWorker(wdeps(f, T, { isAlive: (p) => p === 4242 }));
      const lines = await logLines(f);
      const label = `${initial}${over.update === true ? '+update_busy' : ''}`;
      expect(lines.length, label).toBe(Math.min(initial + 1, 200));
      expect(lines.at(-1), label).toMatchObject({
        action: over.update === true ? 'skipped' : 'completed',
      });
      if (initial + 1 > 200) expect(lines[0]?.['code'], label).toBe(`c${initial + 1 - 200}`);
    }
  });
});

describe('Pi 代码评审修正', () => {
  it('#1 打开上下文之后、锁内观测之前收紧排除:本轮按新排除执行,不采被排除项目的会话', async () => {
    const f = await makeTickFx('a3-w-stale-', { confirmed: true });
    const r = await runWorker(
      wdeps(f, T, {
        afterLock: () =>
          writeCfg(f, rsiToml(f, `exclude_dirs = [${JSON.stringify(path.join(f.dir, 'work'))}]\n`)),
      }),
    );
    expect(r).toMatchObject({ kind: 'ran', outcome: 'ok' });
    const sig = path.join(f.io.stateDir, 'signals', 'claude');
    const files = (await exists(sig)) ? await readDir(sig) : [];
    let text = '';
    for (const e of files) text += await readText(path.join(sig, e.name));
    expect(text).toBe('');
  });

  it('#1(同一模式在 rsi tick --write 里):拿锁之后收紧排除 → 本轮按新排除执行', async () => {
    const f = await makeTickFx('a3-w-stale-tick-', { confirmed: true });
    const r = await runCmd(f, runTick, ['--write'], {
      afterLock: () =>
        writeCfg(f, rsiToml(f, `exclude_dirs = [${JSON.stringify(path.join(f.dir, 'work'))}]\n`)),
    });
    expect(r.code).toBe(0);
    const sig = path.join(f.io.stateDir, 'signals', 'claude');
    const files = (await exists(sig)) ? await readDir(sig) : [];
    let text = '';
    for (const e of files) text += await readText(path.join(sig, e.name));
    expect(text).toBe('');
  });

  it('复核 #1:拿锁前 [rsi] repo 换成另一个合法仓库 → 锁内拒绝,先于任何维护写入(残留 attempt 不被消费、不写日志)', async () => {
    const f = await makeTickFx('a3-w-repo-', {
      confirmed: true,
      state: { attempt: { started_at: iso(T - 60_000), nonce: '2'.repeat(16) } },
    });
    const other = path.join(f.dir, 'other-repo');
    await mkdirp(f.fx, other, 0o755);
    await writeFile(f.fx, path.join(other, 'kit.toml'), '[kit]\n', { mode: 0o644 });
    const stBefore = await readText(path.join(f.rsiDir, 'state.json'));
    const logBefore = await logLines(f);
    f.audit.length = 0;
    const r = await runWorker(
      wdeps(f, T, { afterLock: () => writeCfg(f, rsiToml(f, '', { repo: other })) }),
    );
    expect(r).toEqual({ kind: 'refused_in_lock', why: 'repo_changed' });
    expect(await readText(path.join(f.rsiDir, 'state.json'))).toBe(stBefore);
    expect(await logLines(f)).toEqual(logBefore);
    const ops = f.audit
      .map((c) => `${c.op} ${path.basename(c.path)}`)
      .filter((o) => !o.startsWith('mkdirp'));
    expect(ops).toEqual(['createExclusive lock', 'remove lock']);
  });

  it('复核 #2:补记 crashed 之后在复检处被 STOP 拒绝 → 仍按「本轮追加过日志」截断,结束时恰 200 行', async () => {
    const f = await makeTickFx('a3-w-crash-stop-', {
      confirmed: true,
      state: { attempt: { started_at: iso(T - 60_000), nonce: '3'.repeat(16) } },
    });
    let body = '';
    for (let i = 0; i < 200; i++) {
      body += `${JSON.stringify({ action: 'skipped', at: iso(T - 1000 * (300 - i)), code: `c${i}`, trigger: 'poke' })}\n`;
    }
    await writeFile(f.io, path.join(f.rsiDir, 'log.jsonl'), body, { mode: 0o600 });
    // 在恢复阶段的写点(`before:recover`,经 beforeWrite)写下 STOP:第一次锁内观测之后、第二次之前
    let stopped = false;
    const r = await runWorker(
      wdeps(f, T, {
        run: {
          beforeWrite: async () => {
            if (!stopped) {
              stopped = true;
              await writeFile(
                f.fx,
                path.join(f.rsiDir, 'STOP'),
                '{"at":"2026-10-24T00:00:00.000Z","by":"user"}',
                { mode: 0o600 },
              );
            }
          },
        },
      }),
    );
    expect(stopped).toBe(true);
    expect(r).toEqual({ kind: 'refused_in_lock', why: 'stopped' });
    const lines = await logLines(f);
    expect(lines.at(-1)).toMatchObject({ action: 'failed', code: 'crashed' });
    expect(lines).toHaveLength(200);
  });

  it('#2 失败记账前先全量复验:counts.json 已损坏(安全阻断)→ 不改 state.json、不写日志、不提交清单', async () => {
    const f = await makeTickFx('a3-w-corrupt-', {
      confirmed: true,
      state: { consecutive_failures: 1 },
    });
    await seed(f, { raw: { 'counts.json': '{"schema_version":1}' } });
    const before = await treeOf(f.io.stateDir);
    f.audit.length = 0;
    const r = await runWorker(wdeps(f));
    expect(r).toEqual({ kind: 'ran', outcome: 'counts_invalid', recorded: false });
    const writes = f.audit.filter((c) => c.op !== 'mkdirp' && !c.path.endsWith('/lock'));
    expect(writes).toEqual([]);
    expect(await treeOf(f.io.stateDir)).toEqual(before);
  });
});

describe('R20-2.9 PI_CODING_AGENT_DIR 已设(worker 环境 KIT_RSI_PI_DIR_SET=1)→ pi 不读', () => {
  it('pi 根里的会话不被采集', async () => {
    const f = await makeTickFx('a3-w-pi-', { confirmed: true });
    await putSession(
      f,
      'pi',
      `s/${uuid(9)}.jsonl`,
      jl({ type: 'session', id: uuid(9), cwd: path.join(f.dir, 'work', 'proj1'), timestamp: NOW }),
    );
    await runWorker({ ...wdeps(f), env: { ...f.env, KIT_RSI_PI_DIR_SET: '1' } });
    expect(await exists(path.join(f.io.stateDir, 'signals', 'pi'))).toBe(false);
    expect(await exists(path.join(f.io.stateDir, 'signals', 'claude'))).toBe(true);
  });
});

describe('worker 持锁期间,另一个进程拿不到 rsi/lock(各前台写入方服从同一把锁由 b5-lock-matrix 证明)', () => {
  it('拿锁后 / 读阶段 / 提交前三处,真子进程试锁都报 locked', async () => {
    const f = await makeTickFx('a3-w-held-', { confirmed: true });
    const { dir } = await makeTempDir('a3-w-child-');
    const script = await buildChild(dir);
    const tries: unknown[] = [];
    const probe = async (): Promise<void> => {
      tries.push(...(await runChild(script, { op: 'try', tmp: f.dir, state: f.io.stateDir })));
    };
    let stepped = false;
    let wrote = false;
    await runWorker(
      wdeps(f, T, {
        afterLock: probe,
        run: {
          l0: {
            beforeStep: async () => {
              if (!stepped) {
                stepped = true;
                await probe();
              }
            },
          },
          beforeWrite: async () => {
            if (!wrote) {
              wrote = true;
              await probe();
            }
          },
        },
      }),
    );
    expect(tries).toEqual([
      { got: false, kind: 'locked' },
      { got: false, kind: 'locked' },
      { got: false, kind: 'locked' },
    ]);
    expect(await exists(path.join(f.rsiDir, 'lock'))).toBe(false);
  });
});

describe('其它', () => {
  it('state 缺省字段:从未写过 state.json 的 armed(只有清单)也能跑', async () => {
    const f = await makeTickFx('a3-w-nostate-', { noSeed: true });
    expect(await runWorker(wdeps(f))).toMatchObject({ kind: 'ran', outcome: 'ok' });
    expect((await stateOf(f)).last_tick?.trigger).toBe('poke');
  });
  it('baseState 夹具自检', () => {
    expect(baseState().breaker).toBeNull();
  });
});
