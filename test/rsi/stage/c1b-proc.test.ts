/**
 * C1b 真进程验收(owner 2026-11-17「合并前补齐」a / b 两项;替代证据不收):
 *  a. 真第二进程持 `personal/lock`:子进程真取锁并保持;本进程跑真 `runWorker` + 生产装配,P 步按 `personal_busy` 处理、个人侧零业务写;
 *     杀掉持锁子进程后(同一世界)不再是 busy(负向对照);
 *  b. kill -9 崩溃点:真子进程跑真 worker(假 HOME / 真快照 / 真锁 / 真 canary.json 与 B 标记),在**第 k 次写入口被调用之前**对自己发 SIGKILL
 *     (= 第 k-1 次写完之后;不跑 finally、不释放锁),随后核对崩溃现场、再起一个干净的 worker 进程核对收敛(锁可回收、canary 恰好静音一次、B / 状态码一致、本轮正常记账)。
 *     崩溃点按写入口的真实调用序列(先有一次不崩溃的记录运行)定位:S0 写 B 标记之前 / 之后、S0 静音 canary 之前 / 之后、兜底写 canary.json 之前 / 之后、兜底追加安全日志之前 / 之后。
 * 崩溃钩子只在测试子进程入口(test/rsi/proc/c1b-entry.ts)里;生产代码与 dist 没有任何崩溃点。
 */
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RSI_ASSEMBLY_CAPS } from '../../../src/contracts/rsi-phase-caps.js';
import { exists, readText } from '../../../src/io/read-fs.js';
import { writeFile } from '../../../src/io/safe-fs.js';
import { assembleWorkerStage } from '../../../src/rsi/assemble-worker.js';
import { makeBreakerMarkerPort } from '../../../src/rsi/canary/pause-marker.js';
import { acquirePersonalLock } from '../../../src/rsi/personal/personal-lock.js';
import { personalHome } from '../../../src/rsi/personal/home-state.js';
import type { PersonalRound, PersonalStage } from '../../../src/rsi/personal/stage/types.js';
import { runWorker } from '../../../src/rsi/worker.js';
import { type TickFx, makeTickFx } from '../b5a-fixture.js';
import { canaryDoc } from '../canary/w5-fixture.js';
import { buildC1bChild, runC1b, startC1b, type C1bJob } from '../proc/c1b-helper.js';
import { treeOf } from '../rsi-fixture.js';
import { NOW } from '../ro-fixture.js';
import { makeTempDir } from '../../helpers/tmp.js';

const T = Date.parse(NOW);
const ALL_CAPS = new Set<string>(RSI_ASSEMBLY_CAPS);
let script = '';

beforeAll(async () => {
  const { dir } = await makeTempDir('c1b-proc-build-');
  script = await buildC1bChild(dir);
}, 180_000);

afterAll(() => {
  vi.unstubAllEnvs();
});

const canaryFile = (f: TickFx): string => path.join(f.rsiDir, 'canary.json');
const bFile = (f: TickFx): string => path.join(f.rsiDir, 'AUTO_PAUSE_BREAKER');
const lockFileIn = (home: string): string =>
  path.join(home, '.local', 'state', 'agent-kit', 'rsi-personal', 'lock');

async function seedCanary(f: TickFx): Promise<void> {
  await writeFile(f.io, canaryFile(f), JSON.stringify(canaryDoc()), { mode: 0o600 });
}
async function seedBreakerMarker(f: TickFx): Promise<void> {
  await makeBreakerMarkerPort(f.io, f.rsiDir, () => new Date(T)).ensure('gate_internal');
}
const canaryOf = async (f: TickFx): Promise<{ agents_inject: string[]; generation: number }> =>
  JSON.parse(await readText(canaryFile(f))) as { agents_inject: string[]; generation: number };
const stateOf = async (f: TickFx): Promise<{ auto_pause?: { reasons: string[] } }> =>
  JSON.parse(await readText(path.join(f.rsiDir, 'state.json'))) as {
    auto_pause?: { reasons: string[] };
  };
async function logText(f: TickFx): Promise<string> {
  const p = path.join(f.rsiDir, 'log.jsonl');
  return (await exists(p)) ? readText(p) : '';
}

const jobOf = (f: TickFx, over: Partial<C1bJob> = {}): C1bJob => ({
  op: 'worker',
  repo: f.repo,
  cwd: f.dir,
  home: f.home,
  env: f.env,
  nowMs: T,
  ...over,
});

/** 个人锁的写出口只认进程环境的 `KIT_REAL_HOME_OVERRIDE`(见 c1b-assemble.test.ts):本进程里用 stubEnv 指向假 HOME */
async function withRealHome<R>(f: TickFx, run: () => Promise<R>): Promise<R> {
  vi.stubEnv('KIT_REAL_HOME_OVERRIDE', f.home);
  try {
    return await run();
  } finally {
    vi.unstubAllEnvs();
  }
}

function spyStage(): { stage: PersonalStage; rounds: PersonalRound[] } {
  const real = assembleWorkerStage({ phase: 1, wired: ALL_CAPS });
  const rounds: PersonalRound[] = [];
  return {
    rounds,
    stage: {
      eligible: () => real.eligible(),
      run: async (ctx) => {
        const r = await real.run(ctx);
        rounds.push(r);
        return r;
      },
      safetyFallback: (ctx) => real.safetyFallback(ctx),
    },
  };
}

describe('a. 真第二进程持 personal 锁(E3)', () => {
  it('子进程真持锁:本进程 P 步 = denied personal_busy,S0 照跑,个人侧目录零变化;杀掉持锁进程后同一世界不再 busy', async () => {
    const f = await makeTickFx('c1b-proc-busy-', { confirmed: true });
    await seedCanary(f);
    await seedBreakerMarker(f);
    const holder = startC1b(script, jobOf(f, { op: 'hold_personal' }));
    try {
      const first = JSON.parse(await holder.firstLine()) as { held?: boolean; pid: number };
      expect(first.held).toBe(true);
      expect(first.pid).not.toBe(process.pid);
      const lockDoc = JSON.parse(await readText(lockFileIn(f.home))) as { pid: number };
      expect(lockDoc.pid).toBe(first.pid); // 持锁者是那个子进程
      // 防假绿:本进程在同一世界直接试锁 → 被拒(证明子进程持的就是 worker 要取的那把锁)
      await withRealHome(f, async () => {
        await expect(acquirePersonalLock(personalHome(f.io, f.home))).rejects.toMatchObject({
          kind: 'locked',
        });
      });
      const personalDir = path.join(f.home, '.local', 'state', 'agent-kit');
      const before = await treeOf(personalDir);
      const s = spyStage();
      const r = await withRealHome(f, () =>
        runWorker({
          env: f.env,
          now: () => new Date(T),
          nowMs: () => T,
          personal: s.stage,
        }),
      );
      expect(r.kind).toBe('ran');
      expect(s.rounds).toHaveLength(1);
      expect(s.rounds[0]?.faults).toEqual([]);
      expect(s.rounds[0]?.growth).toEqual({ kind: 'denied', code: 'personal_busy' });
      expect((await canaryOf(f)).agents_inject).toEqual([]); // S0 只需 rsi 锁:照跑
      expect(
        (await logText(f)).split('\n').filter((l) => l.includes('"personal_locked"')),
      ).toHaveLength(1);
      expect(await treeOf(personalDir)).toEqual(before); // 个人侧零业务写(持锁者的锁文件也完好)

      // 负向对照:杀掉持锁子进程(只杀自己起的 pid),同一世界里不再是 busy
      holder.child.kill('SIGKILL');
      const ex = await holder.exited;
      expect(ex.signal).toBe('SIGKILL');
      const s2 = spyStage();
      const r2 = await withRealHome(f, () =>
        runWorker({ env: f.env, now: () => new Date(T), nowMs: () => T, personal: s2.stage }),
      );
      expect(r2.kind).toBe('ran');
      expect(s2.rounds[0]?.growth.kind).toBe('open');
      expect(await exists(lockFileIn(f.home))).toBe(false); // 死 pid 的锁被回收,本轮用完已释放
    } finally {
      holder.child.kill('SIGKILL');
      await holder.exited;
    }
  }, 180_000);
});

interface Scenario {
  name: string;
  state?: Record<string, unknown>;
  seed: (f: TickFx) => Promise<void>;
  failRecover: boolean;
}

const B_CREATE: Scenario = {
  name: 'b_create',
  state: { auto_pause: { reasons: ['gate_internal'], diverged: false, owner_changed: false } },
  seed: seedCanary,
  failRecover: false,
};
const FALLBACK: Scenario = {
  name: 'fallback',
  seed: async (f) => {
    await seedCanary(f);
    await seedBreakerMarker(f);
  },
  failRecover: true,
};

async function worldOf(sc: Scenario): Promise<TickFx> {
  const f = await makeTickFx(`c1b-proc-${sc.name}-`, {
    confirmed: true,
    ...(sc.state !== undefined ? { state: sc.state } : {}),
  });
  await sc.seed(f);
  return f;
}

const idxOf = (trace: readonly string[], needle: string): number =>
  trace.findIndex((t) => t.includes(needle));
const lastIdxOf = (trace: readonly string[], needle: string): number =>
  trace.map((t) => t.includes(needle)).lastIndexOf(true);

/** 不崩溃的记录运行:拿到真实的写入口调用序列 */
async function recordTrace(sc: Scenario): Promise<string[]> {
  const f = await worldOf(sc);
  const r = await runC1b(script, jobOf(f, { failRecover: sc.failRecover }));
  expect(r.err).toBe('');
  expect(r.done, '记录运行必须跑完').toBeDefined();
  return r.done?.trace ?? [];
}

interface Point {
  name: string;
  /** 在哪一次写入口调用之前自杀(由记录序列算出;-1 = 序列里找不到,用例直接红) */
  index: (trace: readonly string[]) => number;
  /** 崩溃现场(杀掉之后、重启之前)的断言 */
  scene: (f: TickFx) => Promise<void>;
}

async function crashAndRestart(sc: Scenario, trace: readonly string[], p: Point): Promise<void> {
  const k = p.index(trace);
  expect(k, `${p.name}:记录序列里找不到该写点`).toBeGreaterThanOrEqual(0);
  expect(k, `${p.name}:该点之后必须还有写(否则没有「写后崩」)`).toBeLessThan(trace.length);
  const f = await worldOf(sc);
  const killed = await runC1b(script, jobOf(f, { failRecover: sc.failRecover, crashBefore: k }));
  expect(killed.signal, `${p.name}:子进程必须是被 SIGKILL 杀掉的`).toBe('SIGKILL');
  expect(killed.done, `${p.name}:被杀的进程不会有完成行`).toBeUndefined();
  await p.scene(f);
  // 崩溃留下死 pid 的 rsi 锁;重启一个干净的 worker(无故障注入)
  expect(await exists(path.join(f.rsiDir, 'lock')), `${p.name}:kill -9 不释放锁`).toBe(true);
  const again = await runC1b(script, jobOf(f));
  expect(again.err).toBe('');
  expect(again.done?.result.kind, `${p.name}:重启后 worker 正常运行`).toBe('ran');
  expect(again.done?.result.recorded, `${p.name}:重启后本轮正常记账`).toBe(true);
  // 收敛:canary 恰好静音一次(generation 2:崩在静音后则重启时 muteCanary 空操作,不重复写)、B 在、状态码一致、锁都已回收释放
  const c = await canaryOf(f);
  expect(c.agents_inject, p.name).toEqual([]);
  expect(c.generation, `${p.name}:静音恰好一次`).toBe(2);
  expect(await exists(bFile(f)), p.name).toBe(true);
  expect((await stateOf(f)).auto_pause?.reasons, p.name).toEqual(['gate_internal']);
  expect(await exists(path.join(f.rsiDir, 'lock')), p.name).toBe(false);
  expect(await exists(lockFileIn(f.home)), p.name).toBe(false);
}

describe('b. kill -9 崩溃点(真子进程 + 重启恢复)', () => {
  const POINTS_B_CREATE: Point[] = [
    {
      name: 'S0 写 B 标记之前',
      index: (t) => idxOf(t, 'AUTO_PAUSE_BREAKER'),
      scene: async (f) => {
        expect(await exists(bFile(f))).toBe(false);
        expect((await canaryOf(f)).agents_inject).toEqual(['claude']);
      },
    },
    {
      name: 'S0 写 B 标记之后',
      index: (t) => lastIdxOf(t, 'AUTO_PAUSE_BREAKER') + 1,
      scene: async (f) => {
        expect(await exists(bFile(f))).toBe(true);
      },
    },
    {
      name: 'S0 静音 canary 之前',
      index: (t) => idxOf(t, 'canary.json'),
      scene: async (f) => {
        expect((await canaryOf(f)).agents_inject).toEqual(['claude']);
      },
    },
    {
      name: 'S0 静音 canary 之后',
      index: (t) => lastIdxOf(t, 'canary.json') + 1,
      scene: async (f) => {
        const c = await canaryOf(f);
        expect(c.agents_inject).toEqual([]);
        expect(c.generation).toBe(2);
      },
    },
  ];

  const POINTS_FALLBACK: Point[] = [
    {
      name: '兜底写 canary.json 之前',
      index: (t) => idxOf(t, 'canary.json'),
      scene: async (f) => {
        expect((await canaryOf(f)).agents_inject).toEqual(['claude']);
        expect(await logText(f)).not.toContain('safety_fallback');
      },
    },
    {
      name: '兜底写 canary.json 之后(追加安全日志之前)',
      index: (t) => lastIdxOf(t, 'canary.json') + 1,
      scene: async (f) => {
        const c = await canaryOf(f);
        expect(c.agents_inject).toEqual([]);
        expect(c.generation).toBe(2);
        expect(await logText(f)).not.toContain('safety_fallback_muted');
      },
    },
    {
      name: '兜底追加安全日志之前',
      index: (t) => idxOf(t, 'log.jsonl'),
      scene: async (f) => {
        expect(await logText(f)).not.toContain('safety_fallback_muted');
      },
    },
    {
      name: '兜底追加安全日志之后(清单提交之前)',
      index: (t) => idxOf(t, 'log.jsonl') + 1,
      scene: async (f) => {
        expect(await logText(f)).toContain('safety_fallback_muted');
      },
    },
  ];

  it('S0 阶梯(状态有暂停码、B 缺失、canary 在注入):B / 静音各写点前后崩溃,重启后收敛', async () => {
    const trace = await recordTrace(B_CREATE);
    for (const p of POINTS_B_CREATE) await crashAndRestart(B_CREATE, trace, p);
  }, 600_000);

  it('兜底(recover 写点 EIO → safetyFallback):写 canary.json / 追加安全日志各点前后崩溃,重启后收敛', async () => {
    const trace = await recordTrace(FALLBACK);
    for (const p of POINTS_FALLBACK) await crashAndRestart(FALLBACK, trace, p);
  }, 600_000);

  it('记录序列自检(防空对空):两个场景的写入口序列都含各自要杀的写点,且崩溃点互不相同', async () => {
    const tb = await recordTrace(B_CREATE);
    const tf = await recordTrace(FALLBACK);
    for (const [sc, tr, pts] of [
      [B_CREATE, tb, POINTS_B_CREATE],
      [FALLBACK, tf, POINTS_FALLBACK],
    ] as const) {
      const idx = pts.map((p) => p.index(tr));
      expect(
        idx.every((i) => i >= 0),
        sc.name,
      ).toBe(true);
      expect(new Set(idx).size, `${sc.name}:四个崩溃点互不相同`).toBe(idx.length);
    }
  }, 300_000);
});
