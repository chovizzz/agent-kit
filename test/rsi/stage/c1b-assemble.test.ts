/**
 * C1b:生产装配 `assemble-worker.ts` 的真适配器(真 `runWorker` + 真快照 / 真锁 / 真 `canary.json` 与 B 标记;假 HOME)。
 * 能力表与相位资格(`production_capability_table_matches_delivered`)、S0 真补做与静音、个人锁真持有 / 忙(另一存活 pid 持锁的模拟,同 `foreignLock` 手法)、
 * 兜底的真写集合(只允许碰 `canary.json`,对 `state.json` / 清单 / `log.jsonl` 零写)。
 * 真第二进程持 personal 锁(E3)、kill -9 崩溃点、真 dist 子进程快照(E7)见 `c1b-proc.test.ts` / `c1b-e7-dist.test.ts`(本文件里「另一存活 pid」是快速的进程内模拟,不作为真进程验收的证据)。
 */
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  RSI_ASSEMBLY_CAPS,
  RSI_PRODUCTION_WIRED_CAPS,
  PhaseCapsMissingError,
  assertPhaseCaps,
} from '../../../src/contracts/rsi-phase-caps.js';
import { RSI_AUTO_PHASE } from '../../../src/contracts/rsi.js';
import { exists, readText } from '../../../src/io/read-fs.js';
import { mkdirp, writeFile } from '../../../src/io/safe-fs.js';
import {
  PRODUCTION_CAPABILITY_TABLE,
  assembleWorkerStage,
  bindWorkerPersonal,
  wiredFromTable,
} from '../../../src/rsi/assemble-worker.js';
import { makeBreakerMarkerPort } from '../../../src/rsi/canary/pause-marker.js';
import type {
  FallbackCtx,
  PersonalCtx,
  PersonalRound,
  PersonalStage,
} from '../../../src/rsi/personal/stage/types.js';
import { RsiLockError } from '../../../src/rsi/lock-error.js';
import { runWorker, type RsiWorkerRunDeps } from '../../../src/rsi/worker.js';
import { type TickFx, loseLockOf, makeTickFx } from '../b5a-fixture.js';
import { treeOf } from '../rsi-fixture.js';
import { canaryDoc } from '../canary/w5-fixture.js';
import { NOW } from '../ro-fixture.js';

const T = Date.parse(NOW);
const ALL_CAPS = new Set<string>(RSI_ASSEMBLY_CAPS);

describe('production_capability_table_matches_delivered', () => {
  it('契约能力表:键 = RSI_ASSEMBLY_CAPS 全集;只有已交付的 worker_safety_skeleton / taint_scan 为真(C2),推出的 wired 集合与契约导出的生产集合一致', () => {
    expect(Object.keys(PRODUCTION_CAPABILITY_TABLE).sort()).toEqual([...RSI_ASSEMBLY_CAPS].sort());
    const DELIVERED = new Set(['worker_safety_skeleton', 'taint_scan']);
    for (const k of RSI_ASSEMBLY_CAPS)
      expect(PRODUCTION_CAPABILITY_TABLE[k], k).toBe(DELIVERED.has(k));
    expect([...wiredFromTable()].sort()).toEqual(['taint_scan', 'worker_safety_skeleton']);
    expect([...wiredFromTable()].sort()).toEqual([...RSI_PRODUCTION_WIRED_CAPS].sort());
  });

  it('wiredFromTable 的变异对照:把某个键置真就会出现在集合里(表是读出能力的唯一来源)', () => {
    const t = { ...PRODUCTION_CAPABILITY_TABLE, audit_sweep: true };
    expect([...wiredFromTable(t)].sort()).toEqual([
      'audit_sweep',
      'taint_scan',
      'worker_safety_skeleton',
    ]);
  });

  it('生产装配在 V1a 相位 + 契约生产集合下不 eligible:提相位的 PR 在能力齐全之前必红(assertPhaseCaps 抛)', () => {
    expect(() => assertPhaseCaps(1, wiredFromTable())).toThrow(PhaseCapsMissingError);
    expect(assembleWorkerStage({ phase: 1 }).eligible()).toBe(false);
    expect(assembleWorkerStage({ phase: 9 }).eligible()).toBe(false);
  });
});

describe('相位 / 能力资格', () => {
  it('生产缺省(不传参数):RSI_AUTO_PHASE=0 → 不 eligible', () => {
    expect(RSI_AUTO_PHASE).toBe(0);
    expect(assembleWorkerStage().eligible()).toBe(false);
  });
  it('测试缝:相位 ≥ V1a 且能力齐全才 eligible;相位 0 + 能力齐全 = 假;V1a + 缺一项 = 假', () => {
    expect(assembleWorkerStage({ phase: 1, wired: ALL_CAPS }).eligible()).toBe(true);
    expect(assembleWorkerStage({ phase: 0, wired: ALL_CAPS }).eligible()).toBe(false);
    const missing = new Set(ALL_CAPS);
    missing.delete('audit_sweep');
    expect(assembleWorkerStage({ phase: 1, wired: missing }).eligible()).toBe(false);
  });
  it('工厂求值与 eligible() 零持久写入:假 HOME 与状态目录的文件树前后逐字节相同(不建文件 / 不建目录 / 不取锁文件);个人锁目录不被建', async () => {
    const f = await makeTickFx('c1b-asm-zero-io-', { confirmed: true });
    const before = [...(await treeOf(f.home)), ...(await treeOf(f.io.stateDir))];
    const stage = assembleWorkerStage({ phase: 1, wired: ALL_CAPS });
    void stage.eligible();
    void assembleWorkerStage().eligible();
    expect([...(await treeOf(f.home)), ...(await treeOf(f.io.stateDir))]).toEqual(before);
    expect(await exists(path.join(f.home, '.local', 'state', 'agent-kit', 'rsi-personal'))).toBe(
      false,
    );
  });
});

function wd(
  f: TickFx,
  audit: { op: string; path: string }[],
  over: Omit<Partial<RsiWorkerRunDeps>, 'personal'> & { personal?: PersonalStage } = {},
): RsiWorkerRunDeps {
  const { personal, ...rest } = over;
  return {
    env: f.env,
    writeAudit: (op, p) => void audit.push({ op, path: p }),
    now: () => new Date(T),
    nowMs: () => T,
    ...rest,
    ...(personal === undefined ? {} : { personal: bindWorkerPersonal(personal) }),
  };
}

function spy(real: PersonalStage): {
  stage: PersonalStage;
  rounds: PersonalRound[];
  runCtx: PersonalCtx[];
  fbCtx: FallbackCtx[];
} {
  const rounds: PersonalRound[] = [];
  const runCtx: PersonalCtx[] = [];
  const fbCtx: FallbackCtx[] = [];
  return {
    rounds,
    runCtx,
    fbCtx,
    stage: {
      eligible: () => real.eligible(),
      run: async (ctx) => {
        runCtx.push(ctx);
        const r = await real.run(ctx);
        rounds.push(r);
        return r;
      },
      safetyFallback: (ctx) => {
        fbCtx.push(ctx);
        return real.safetyFallback(ctx);
      },
    },
  };
}

const canaryFile = (f: TickFx): string => path.join(f.rsiDir, 'canary.json');
async function seedCanary(f: TickFx): Promise<void> {
  await writeFile(f.io, canaryFile(f), JSON.stringify(canaryDoc()), { mode: 0o600 });
}
async function seedBreakerMarker(f: TickFx): Promise<void> {
  await makeBreakerMarkerPort(f.io, f.rsiDir, () => new Date(T)).ensure('gate_internal');
}
const canaryOf = async (f: TickFx): Promise<{ agents_inject: string[]; generation: number }> =>
  JSON.parse(await readText(canaryFile(f))) as { agents_inject: string[]; generation: number };

/**
 * 个人锁的写出口(home-fs)只认「真实 HOME」(`getRealHome()` 读**进程**环境的 `KIT_REAL_HOME_OVERRIDE`,与 worker 自己的 env 注入无关)或「严格位于 KIT_TMP 之内的 HOME」;
 * 后者与 `openRsiIo` 的「KIT_TMP 不得是 HOME / 仓库的祖先」冲突。夹具默认不满足前者 → 个人锁取锁得 `write_denied`(= 真实的故障路径)。
 * 要真取到 / 占用个人锁,用 `vi.stubEnv` 让进程环境的真实 HOME 指向假 HOME(用完即还原)。
 */
async function withRealHome<T>(f: TickFx, run: () => Promise<T>): Promise<T> {
  vi.stubEnv('KIT_REAL_HOME_OVERRIDE', f.home);
  try {
    return await run();
  } finally {
    vi.unstubAllEnvs();
  }
}
const lockFileIn = (home: string): string =>
  path.join(home, '.local', 'state', 'agent-kit', 'rsi-personal', 'lock');

describe('S0 真适配器(经真 runWorker)', () => {
  it('个人锁取锁失败(write_denied)时 S0 仍跑完:B 在、状态无码、canary 在注入 → 补码(state 经清单提交)+ 静音;growth = denied personal_fault;L0 之后码仍在(state 接续);日志一行 personal_fault_*', async () => {
    const f = await makeTickFx('c1b-asm-repair-', { confirmed: true });
    await seedCanary(f);
    await seedBreakerMarker(f);
    const s = spy(assembleWorkerStage({ phase: 1, wired: ALL_CAPS }));
    const r = await runWorker(wd(f, [], { personal: s.stage }));
    expect(r).toMatchObject({ kind: 'ran', outcome: 'ok' });
    expect(s.rounds).toHaveLength(1);
    expect(s.rounds[0]?.faults).toEqual([{ code: 'personal_lock_error:write_denied' }]);
    expect(s.rounds[0]?.growth).toEqual({ kind: 'denied', code: 'personal_fault' });
    const c = await canaryOf(f);
    expect(c.agents_inject).toEqual([]);
    expect(c.generation).toBe(2);
    const st = JSON.parse(await readText(path.join(f.rsiDir, 'state.json'))) as {
      auto_pause?: { reasons: string[] };
    };
    expect(st.auto_pause?.reasons).toEqual(['gate_internal']);
    const log = await readText(path.join(f.rsiDir, 'log.jsonl'));
    expect(
      log.split('\n').filter((l) => l.includes('personal_fault_personal_lock_error_write_denied')),
    ).toHaveLength(1);
  });

  it('个人锁取得并释放(HOME 在 KIT_TMP 之内):growth = open、faults 空、锁文件已不在;S0 同样补码 + 静音', async () => {
    const f = await makeTickFx('c1b-asm-held-', { confirmed: true });
    await seedCanary(f);
    await seedBreakerMarker(f);
    const s = spy(assembleWorkerStage({ phase: 1, wired: ALL_CAPS }));
    const r = await withRealHome(f, () => runWorker(wd(f, [], { personal: s.stage })));
    expect(r.kind).toBe('ran');
    expect(s.rounds[0]?.faults).toEqual([]);
    expect(s.rounds[0]?.growth.kind).toBe('open');
    expect((await canaryOf(f)).agents_inject).toEqual([]);
    expect(await exists(lockFileIn(f.home))).toBe(false); // 个人锁已释放
  });

  it('无熔断(无 B / 无码 / 无 U):canary 与 B 都不被碰;没有 safety_fault 行', async () => {
    const f = await makeTickFx('c1b-asm-quiet-', { confirmed: true });
    await seedCanary(f);
    const s = spy(assembleWorkerStage({ phase: 1, wired: ALL_CAPS }));
    const r = await withRealHome(f, () => runWorker(wd(f, [], { personal: s.stage })));
    expect(r.kind).toBe('ran');
    expect(s.rounds[0]?.faults).toEqual([]);
    expect((await canaryOf(f)).agents_inject).toEqual(['claude']);
    expect(await exists(path.join(f.rsiDir, 'AUTO_PAUSE_BREAKER'))).toBe(false);
    const log = await readText(path.join(f.rsiDir, 'log.jsonl'));
    expect(log).not.toMatch(/safety_fault|personal_locked|personal_fault/);
  });

  it('个人锁被另一存活 pid 持有:S0 照跑(canary 已静音)、growth = denied personal_busy、日志一行 personal_locked、对方的锁文件完好', async () => {
    const f = await makeTickFx('c1b-asm-busy-', { confirmed: true });
    await seedCanary(f);
    await seedBreakerMarker(f);
    const lockFile = lockFileIn(f.home);
    await mkdirp(f.fx, path.dirname(lockFile), 0o700);
    const doc = JSON.stringify({
      pid: process.ppid,
      started_at: new Date().toISOString(),
      nonce: 'e'.repeat(16),
      kit_version: '0.0.0',
    });
    await writeFile(f.fx, lockFile, doc, { mode: 0o600 });
    const s = spy(assembleWorkerStage({ phase: 1, wired: ALL_CAPS }));
    const r = await withRealHome(f, () => runWorker(wd(f, [], { personal: s.stage })));
    expect(r.kind).toBe('ran');
    expect(s.rounds[0]?.faults).toEqual([]);
    expect(s.rounds[0]?.growth).toEqual({ kind: 'denied', code: 'personal_busy' });
    expect((await canaryOf(f)).agents_inject).toEqual([]);
    const log = (await readText(path.join(f.rsiDir, 'log.jsonl'))).split('\n');
    expect(log.filter((l) => l.includes('"personal_locked"'))).toHaveLength(1);
    expect(await readText(lockFile)).toBe(doc);
  });
});

describe('S0 的 B 写点前复核 rsi 锁(失锁 = 零写入)', () => {
  const B_ID = '0123456789abcdef';
  const losing = (f: TickFx, real: PersonalStage): PersonalStage => ({
    ...real,
    run: async (ctx) => {
      await loseLockOf(f); // S0 开始之前锁就没了
      return real.run(ctx);
    },
  });

  it('状态有暂停码、B 缺失:失锁后 S0 不创建 B、canary 不动;outcome lock_lost,零记账', async () => {
    const f = await makeTickFx('c1b-asm-bloss-create-', {
      confirmed: true,
      state: { auto_pause: { reasons: ['gate_internal'], diverged: false, owner_changed: false } },
    });
    await seedCanary(f);
    const stage = losing(f, assembleWorkerStage({ phase: 1, wired: ALL_CAPS }));
    const r = await runWorker(wd(f, [], { personal: stage }));
    expect(r).toEqual({ kind: 'ran', outcome: 'lock_lost', recorded: false });
    expect(await exists(path.join(f.rsiDir, 'AUTO_PAUSE_BREAKER'))).toBe(false);
    expect((await canaryOf(f)).agents_inject).toEqual(['claude']);
  });

  it('B 是解除残留(状态已清码且证据与 B 的 id 相等):失锁后 S0 不删 B(删 B 是放松保护,同样先复核)', async () => {
    const f = await makeTickFx('c1b-asm-bloss-remove-', {
      confirmed: true,
      state: {
        auto_pause: {
          reasons: [],
          diverged: false,
          owner_changed: false,
          released_marker_id: B_ID,
        },
      },
    });
    await makeBreakerMarkerPort(
      f.io,
      f.rsiDir,
      () => new Date(T),
      () => B_ID,
    ).ensure('gate_internal');
    const stage = losing(f, assembleWorkerStage({ phase: 1, wired: ALL_CAPS }));
    const r = await runWorker(wd(f, [], { personal: stage }));
    expect(r).toEqual({ kind: 'ran', outcome: 'lock_lost', recorded: false });
    expect(await exists(path.join(f.rsiDir, 'AUTO_PAUSE_BREAKER'))).toBe(true);
  });

  it('正向对照:锁在手时同一残留 B 被删除(证明上一条的「没删」来自失锁而非夹具)', async () => {
    const f = await makeTickFx('c1b-asm-bloss-control-', {
      confirmed: true,
      state: {
        auto_pause: {
          reasons: [],
          diverged: false,
          owner_changed: false,
          released_marker_id: B_ID,
        },
      },
    });
    await makeBreakerMarkerPort(
      f.io,
      f.rsiDir,
      () => new Date(T),
      () => B_ID,
    ).ensure('gate_internal');
    const s = spy(assembleWorkerStage({ phase: 1, wired: ALL_CAPS }));
    await runWorker(wd(f, [], { personal: s.stage }));
    expect(await exists(path.join(f.rsiDir, 'AUTO_PAUSE_BREAKER'))).toBe(false);
  });
});

describe('B 标记写点守卫(目录校验之后、实际写之前才复核;删除在回读之后)', () => {
  const B_ID = '0123456789abcdef';
  const lostErr = (): RsiLockError => new RsiLockError('lock_lost');

  it('端口:创建时守卫在 now() 之后、写之前被调用;守卫抛错 = B 不创建(注入点是守卫本身,不靠计时)', async () => {
    const f = await makeTickFx('c1b-asm-bguard-create-', { confirmed: true });
    const order: string[] = [];
    const port = makeBreakerMarkerPort(
      f.io,
      f.rsiDir,
      () => {
        order.push('now');
        return new Date(T);
      },
      () => B_ID,
      async () => {
        order.push(`guard:B=${String(await exists(path.join(f.rsiDir, 'AUTO_PAUSE_BREAKER')))}`);
        throw lostErr();
      },
    );
    await expect(port.ensure('gate_internal')).rejects.toBeInstanceOf(RsiLockError);
    expect(order).toEqual(['now', 'guard:B=false']);
    expect(await exists(path.join(f.rsiDir, 'AUTO_PAUSE_BREAKER'))).toBe(false);
  });

  it('端口正向对照:守卫放行时同一调用创建 B', async () => {
    const f = await makeTickFx('c1b-asm-bguard-create-ok-', { confirmed: true });
    const port = makeBreakerMarkerPort(
      f.io,
      f.rsiDir,
      () => new Date(T),
      () => B_ID,
      () => Promise.resolve(),
    );
    await port.ensure('gate_internal');
    expect(await exists(path.join(f.rsiDir, 'AUTO_PAUSE_BREAKER'))).toBe(true);
  });

  it('端口:删除在回读之后复核 —— B 存在且守卫抛错 = B 保留;B 不存在 = 返回 false 且守卫不被调用(回读先于守卫)', async () => {
    const f = await makeTickFx('c1b-asm-bguard-remove-', { confirmed: true });
    let calls = 0;
    const guard = (): Promise<void> => {
      calls += 1;
      return Promise.reject(lostErr());
    };
    const mk = (g: () => Promise<void>) =>
      makeBreakerMarkerPort(
        f.io,
        f.rsiDir,
        () => new Date(T),
        () => B_ID,
        g,
      );
    await expect(mk(guard).remove()).resolves.toBe(false);
    expect(calls).toBe(0);
    await mk(() => Promise.resolve()).ensure('gate_internal');
    await expect(mk(guard).remove()).rejects.toBeInstanceOf(RsiLockError);
    expect(calls).toBe(1);
    expect(await exists(path.join(f.rsiDir, 'AUTO_PAUSE_BREAKER'))).toBe(true);
  });

  it('端口正向对照:守卫放行时同一残留 B 被删除', async () => {
    const f = await makeTickFx('c1b-asm-bguard-remove-ok-', { confirmed: true });
    const p = makeBreakerMarkerPort(
      f.io,
      f.rsiDir,
      () => new Date(T),
      () => B_ID,
    );
    await p.ensure('gate_internal');
    await expect(p.remove()).resolves.toBe(true);
    expect(await exists(path.join(f.rsiDir, 'AUTO_PAUSE_BREAKER'))).toBe(false);
  });

  /** 锁在 S0 开始时是好的、也能通过所有别处的复核;只有从 B 标记适配器写点(调用栈含 pause-marker)发起的复核才报失锁 = 「目录校验之后失锁」 */
  const lostAtMarkerWrite = (real: PersonalStage, armed: boolean): PersonalStage => ({
    ...real,
    run: (ctx) =>
      real.run({
        ...ctx,
        lock: {
          ...ctx.lock,
          assertHeld: () =>
            armed && (new Error().stack ?? '').includes('pause-marker')
              ? Promise.reject(lostErr())
              : ctx.lock.assertHeld(),
        },
      }),
  });
  const createCase = async (tag: string, armed: boolean) => {
    const f = await makeTickFx(tag, {
      confirmed: true,
      state: { auto_pause: { reasons: ['gate_internal'], diverged: false, owner_changed: false } },
    });
    await seedCanary(f);
    const stage = lostAtMarkerWrite(assembleWorkerStage({ phase: 1, wired: ALL_CAPS }), armed);
    const r = await runWorker(wd(f, [], { personal: stage }));
    return { r, b: await exists(path.join(f.rsiDir, 'AUTO_PAUSE_BREAKER')) };
  };
  const removeCase = async (tag: string, armed: boolean) => {
    const f = await makeTickFx(tag, {
      confirmed: true,
      state: {
        auto_pause: {
          reasons: [],
          diverged: false,
          owner_changed: false,
          released_marker_id: B_ID,
        },
      },
    });
    await makeBreakerMarkerPort(
      f.io,
      f.rsiDir,
      () => new Date(T),
      () => B_ID,
    ).ensure('gate_internal');
    const stage = lostAtMarkerWrite(assembleWorkerStage({ phase: 1, wired: ALL_CAPS }), armed);
    const r = await runWorker(wd(f, [], { personal: stage }));
    return { r, b: await exists(path.join(f.rsiDir, 'AUTO_PAUSE_BREAKER')) };
  };

  it('装配(创建):目录校验之后、写之前失锁 → 不创建 B;对照:不注入失锁则创建', async () => {
    const lost = await createCase('c1b-asm-bwin-create-', true);
    expect(lost.r).toEqual({ kind: 'ran', outcome: 'lock_lost', recorded: false });
    expect(lost.b).toBe(false);
    const ok = await createCase('c1b-asm-bwin-create-ok-', false);
    expect(ok.b).toBe(true);
  });

  it('装配(删除):B 回读之后、unlink 之前失锁 → 不删除 B;对照:不注入失锁则删除', async () => {
    const lost = await removeCase('c1b-asm-bwin-remove-', true);
    expect(lost.r).toEqual({ kind: 'ran', outcome: 'lock_lost', recorded: false });
    expect(lost.b).toBe(true);
    const ok = await removeCase('c1b-asm-bwin-remove-ok-', false);
    expect(ok.b).toBe(false);
  });
});

describe('兜底真适配器(recover 失败 → safetyFallback)', () => {
  const failRecover: NonNullable<RsiWorkerRunDeps['run']> = {
    beforeWrite: (op) =>
      op === 'recover'
        ? Promise.reject(Object.assign(new Error('eio'), { code: 'EIO' }))
        : Promise.resolve(),
  };

  it('B 在 + canary 注入:兜底静音(只写 canary.json);兜底阶段对 state.json / 清单 / log.jsonl 零写入;outcome 仍 io_error', async () => {
    const f = await makeTickFx('c1b-asm-fb-', { confirmed: true });
    await seedCanary(f);
    await seedBreakerMarker(f);
    const audit: { op: string; path: string }[] = [];
    const real = assembleWorkerStage({ phase: 1, wired: ALL_CAPS });
    const during: { op: string; path: string }[] = [];
    const stage: PersonalStage = {
      eligible: () => real.eligible(),
      run: (c) => real.run(c),
      safetyFallback: async (c) => {
        const from = audit.length;
        const rep = await real.safetyFallback(c);
        during.push(...audit.slice(from));
        return rep;
      },
    };
    const r = await runWorker(wd(f, audit, { personal: stage, run: failRecover }));
    expect(r).toEqual({ kind: 'ran', outcome: 'io_error', recorded: true });
    expect((await canaryOf(f)).agents_inject).toEqual([]);
    const touched = [...new Set(during.map((c) => path.basename(c.path)))].sort();
    expect(touched.every((n) => n.startsWith('canary.json'))).toBe(true);
    expect(touched).not.toContain('state.json');
    expect(touched).not.toContain('log.jsonl');
    expect(touched).not.toContain('snapshot.json');
    const log = await readText(path.join(f.rsiDir, 'log.jsonl'));
    expect(log).toMatch(/safety_fallback_muted/);
  });

  it('无熔断:兜底 nothing,canary 不动(不在不必要时收紧)', async () => {
    const f = await makeTickFx('c1b-asm-fb-quiet-', { confirmed: true });
    await seedCanary(f);
    const s = spy(assembleWorkerStage({ phase: 1, wired: ALL_CAPS }));
    const r = await runWorker(wd(f, [], { personal: s.stage, run: failRecover }));
    expect(r).toEqual({ kind: 'ran', outcome: 'io_error', recorded: true });
    expect(s.fbCtx).toHaveLength(1);
    expect((await canaryOf(f)).agents_inject).toEqual(['claude']);
    expect(await readText(path.join(f.rsiDir, 'log.jsonl'))).toMatch(/safety_fallback_nothing/);
  });
});
