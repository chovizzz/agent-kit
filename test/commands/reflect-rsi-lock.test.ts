/**
 * R20-A2 B3b:reflect 的 rsi/lock 接线(契约 R20-5.1 / R20-5.2、D1、D3)。
 * 覆盖 `--gc --write`(闸门判 lock 才拿锁)与 `--run-llm`(构造后端之前拿锁、LLM 期间持有、返回后先 assertHeld)。
 * worker × 各命令的并发组合留 A3。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createReflectCommand } from '../../src/commands/reflect.js';
import type { ReflectCommandDeps } from '../../src/commands/reflect.js';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { exists, readDir, readText } from '../../src/io/read-fs.js';
import { mkdirp, remove, writeFile } from '../../src/io/safe-fs.js';
import type { RsiConfig } from '../../src/rsi/config.js';
import {
  StubBackend,
  lintDraft,
  okText,
  out as outJson,
  snapshot,
  testRedactor,
} from '../fixtures/reflect/world.js';
import { EGRESS_OVERLAY, ctxFor, newR5World } from './r5-world.js';
import type { R5World } from './r5-world.js';
import { aliasRsiState, lockFileOf, onConfig, startHolder } from './rsi-lock-world.js';

const CLOCK = (): Date => new Date('2026-10-12T08:00:00Z');
const LIVE = ['--run-llm', '--allow-egress', '--owner', '@tester'];
const OFF: RsiConfig = { status: 'off', reason: 'absent' };

interface Rig {
  w: R5World;
  stub: StubBackend;
  factory: { n: number; lockSeen: boolean[] };
  cmd: ReturnType<typeof createReflectCommand>;
  lockFile: string;
}

async function rig(
  o: {
    config?: RsiConfig | (() => Promise<RsiConfig>);
    respond?: ConstructorParameters<typeof StubBackend>[0];
    deps?: Partial<ReflectCommandDeps>;
    alias?: boolean;
    clock?: () => Date;
  } = {},
): Promise<Rig> {
  const w = await newR5World({ overlay: EGRESS_OVERLAY });
  const lockFile = lockFileOf(w.state);
  if (o.alias !== false) await aliasRsiState(w.io, w.parent);
  const stub = new StubBackend(o.respond ?? ((req) => okText(outJson(lintDraft(req.user)))));
  const factory = { n: 0, lockSeen: [] as boolean[] };
  const config = o.config ?? onConfig(w.parent);
  const cmd = createReflectCommand({
    clock: o.clock ?? CLOCK,
    randomHex: () => 'abc123',
    redactor: testRedactor(),
    createBackends: async () => {
      factory.n++;
      factory.lockSeen.push(await exists(lockFile)); // 构造后端时 rsi/lock 必须已在手
      return { glm: stub };
    },
    rsiConfig: typeof config === 'function' ? config : async () => config,
    ...(o.deps ?? {}),
  });
  return { w, stub, factory, cmd, lockFile };
}

const runDirs = async (w: R5World): Promise<string[]> =>
  (await exists(path.join(w.state, 'reflect')))
    ? (await readDir(path.join(w.state, 'reflect'))).map((e) => e.name).sort()
    : [];

describe('reflect --run-llm × rsi/lock', () => {
  it('闸门 lock:构造后端与 LLM 调用期间持锁,结束后已释放;正向对照:暂存成功', async () => {
    const seen: boolean[] = [];
    let lockPath = '';
    const r = await rig({
      respond: async (req) => {
        seen.push(await exists(lockPath));
        return okText(outJson(lintDraft(req.user)));
      },
    });
    lockPath = r.lockFile;
    const { ctx, out } = ctxFor(r.w, LIVE);
    expect(await r.cmd.run(ctx)).toBe(ExitCode.OK);
    expect(r.factory.n).toBe(1);
    expect(r.factory.lockSeen).toEqual([true]);
    expect(seen).toEqual([true]);
    expect(out.join('')).toContain('outcome=staged');
    expect(await exists(r.lockFile)).toBe(false); // 已释放
  });

  it('闸门 off:不建 rsi/、不建 .state 别名之外的任何东西,行为与接线前一致(正向对照:照常暂存)', async () => {
    const r = await rig({ config: OFF, alias: false });
    const { ctx, out } = ctxFor(r.w, LIVE);
    expect(await r.cmd.run(ctx)).toBe(ExitCode.OK);
    expect(r.factory.lockSeen).toEqual([false]);
    expect(out.join('')).toContain('outcome=staged');
    expect(await exists(path.join(r.w.state, 'rsi'))).toBe(false);
    expect(await exists(path.join(r.w.parent, '.state'))).toBe(false);
  });

  it('干跑:不读 rsi 配置(读就抛)、不拿锁、零写入', async () => {
    const r = await rig({
      config: async () => {
        throw new Error('rsiConfig must not be called in dry-run');
      },
    });
    const before = await snapshot(r.w.state);
    const { ctx } = ctxFor(r.w, []);
    expect(await r.cmd.run(ctx)).toBe(ExitCode.OK);
    expect(await snapshot(r.w.state)).toBe(before);
    expect(await exists(path.join(r.w.state, 'rsi'))).toBe(false);
  });

  it('另一个进程持锁:退出 4 REFLECT_NOT_RUN reason=locked,零后端构造、零调用、零写入,锁文件不变', async () => {
    const r = await rig();
    const holder = await startHolder(r.w.state, r.w.parent);
    try {
      const lockBefore = await readText(r.lockFile);
      const before = await snapshot(r.w.state);
      const { ctx, err, out } = ctxFor(r.w, LIVE);
      expect(await r.cmd.run(ctx)).toBe(ExitCode.NOT_RUN);
      expect(err.join('')).toBe('REFLECT_NOT_RUN reason=locked\n');
      expect(out).toEqual([]);
      expect(r.factory.n).toBe(0);
      expect(r.stub.calls).toBe(0);
      expect(await readText(r.lockFile)).toBe(lockBefore);
      expect(await snapshot(r.w.state)).toBe(before);
    } finally {
      await holder.stop();
    }
  });

  it('持锁方超过 TTL(locked_over_ttl):同样退出 4 且对外码为 reason=locked;不抢占、不删旧锁', async () => {
    const r = await rig({
      deps: {
        lockDeps: { lock: { now: () => new Date(Date.now() + 16 * 60_000) } },
      },
    });
    const holder = await startHolder(r.w.state, r.w.parent);
    try {
      const lockBefore = await readText(r.lockFile);
      const { ctx, err } = ctxFor(r.w, LIVE);
      expect(await r.cmd.run(ctx)).toBe(ExitCode.NOT_RUN);
      expect(err.join('')).toBe('REFLECT_NOT_RUN reason=locked\n');
      expect(r.factory.n).toBe(0);
      expect(await readText(r.lockFile)).toBe(lockBefore);
    } finally {
      await holder.stop();
    }
  });

  it('refuse(状态树与 rsi 树父子重叠):退出 3 RSI_FAIL_CLOSED reason=state_dir_unsafe,零构造零调用零写入', async () => {
    let stateOf = '';
    const r = await rig({
      config: async () => onConfig(path.join(stateOf, 'sub')),
      alias: false,
    });
    stateOf = r.w.state;
    const before = await snapshot(r.w.parent);
    const { ctx, err, out } = ctxFor(r.w, LIVE);
    expect(await r.cmd.run(ctx)).toBe(ExitCode.FAIL_CLOSED);
    expect(err.join('')).toBe('RSI_FAIL_CLOSED reason=state_dir_unsafe\n');
    expect(out).toEqual([]);
    expect(r.factory.n).toBe(0);
    expect(r.stub.calls).toBe(0);
    expect(await snapshot(r.w.parent)).toBe(before);
  });

  it('LLM 期间锁被换成别人的:退出 3 lock_lost,不写暂存区,不删别人的锁', async () => {
    let lockPath = '';
    const ref: { w?: R5World } = {};
    const r = await rig({
      respond: async (req) => {
        const w = ref.w as R5World;
        const doc = JSON.parse(await readText(lockPath)) as Record<string, unknown>;
        await remove(w.io, lockPath);
        await writeFile(w.io, lockPath, JSON.stringify({ ...doc, nonce: 'f'.repeat(32) }), {
          mode: 0o600,
        });
        return okText(outJson(lintDraft(req.user)));
      },
    });
    ref.w = r.w;
    lockPath = r.lockFile;
    const { ctx, err, out } = ctxFor(r.w, LIVE);
    expect(await r.cmd.run(ctx)).toBe(ExitCode.FAIL_CLOSED);
    expect(err.join('')).toContain('RSI_FAIL_CLOSED reason=lock_lost\n');
    expect(out).toEqual([]);
    // 没有任何提案 / apply.patch 被暂存。已知残余:runReflect 在后端失败分支仍会写一份 outcome=not_run 的 report.json(它不可注入,
    // 要拦须在 reflect/run.ts 加写前钩子 → 汇报「待主代理定夺」);这里钉死「只有 report.json」,有 proposals/ 就红
    const runs = await runDirs(r.w);
    for (const name of runs) {
      expect((await readDir(path.join(r.w.state, 'reflect', name))).map((e) => e.name)).toEqual([
        'report.json',
      ]);
      expect(await readText(path.join(r.w.state, 'reflect', name, 'report.json'))).toContain(
        '"outcome": "not_run"',
      );
    }
    expect(await readText(r.lockFile)).toContain('f'.repeat(32)); // 别人的锁还在
  });

  it('LLM 调用抛错且锁已丢:仍报 lock_lost(不被吞成 backend_error)', async () => {
    let lockPath = '';
    const ref: { w?: R5World } = {};
    const r = await rig({
      respond: async () => {
        await remove((ref.w as R5World).io, lockPath);
        throw new Error('boom');
      },
    });
    ref.w = r.w;
    lockPath = r.lockFile;
    const { ctx, err } = ctxFor(r.w, LIVE);
    expect(await r.cmd.run(ctx)).toBe(ExitCode.FAIL_CLOSED);
    expect(err.join('')).toContain('RSI_FAIL_CLOSED reason=lock_lost\n');
    expect(err.join('')).not.toContain('backend_error');
  });
});

describe('reflect --gc --write × rsi/lock', () => {
  const OLD_RUN = 'run-20200101T000000Z-aaaaaa';
  async function withOldRun(r: Rig): Promise<string> {
    const dir = path.join(r.w.state, 'reflect', OLD_RUN);
    await mkdirp(r.w.io, dir, 0o700);
    await writeFile(
      r.w.io,
      path.join(dir, 'report.json'),
      `${JSON.stringify({
        run_id: OLD_RUN,
        mode: 'llm',
        signals_loaded: 3,
        signals_dropped: { schema: 0, residual: 0, external_excerpt_forced: 0 },
        clusters: 1,
        evidence_sent: 1,
        prompt_bytes: 10,
        prompt_sha256: null,
        input_digest: null,
        backend: null,
        calls_made: 1,
        calls_limit: 1,
        outcome: 'no_proposals',
        rejected: {},
        staged: [],
        observations_n: 0,
      })}\n`,
      { mode: 0o600 },
    );
    return dir;
  }

  it('lock:整个 runReflectGc 在持锁期间(clock 在锁内被读到);结束后释放', async () => {
    const probes: Promise<boolean>[] = [];
    let lockPath = '';
    const r = await rig({
      clock: () => {
        probes.push(exists(lockPath)); // 立即发起的探测:此刻 runReflectGc 尚未开始、锁应已在手
        return CLOCK();
      },
    });
    lockPath = r.lockFile;
    const { ctx, err } = ctxFor(r.w, ['--gc', '--write']);
    expect(await r.cmd.run(ctx)).toBe(ExitCode.OK);
    expect(err).toEqual([]);
    const seen = await Promise.all(probes);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((b) => b)).toBe(true);
    expect(await exists(r.lockFile)).toBe(false);
  });

  it('另一个进程持锁:退出 4 REFLECT_NOT_RUN reason=locked,不删任何 run', async () => {
    const r = await rig();
    const dir = await withOldRun(r);
    const holder = await startHolder(r.w.state, r.w.parent);
    try {
      const before = await snapshot(r.w.state);
      const { ctx, err } = ctxFor(r.w, ['--gc', '--write']);
      expect(await r.cmd.run(ctx)).toBe(ExitCode.NOT_RUN);
      expect(err.join('')).toBe('REFLECT_NOT_RUN reason=locked\n');
      expect(await exists(dir)).toBe(true);
      expect(await snapshot(r.w.state)).toBe(before);
    } finally {
      await holder.stop();
    }
  });

  it('正向对照:锁空闲时 --gc --write 真删过期 run;off 时不建 rsi/', async () => {
    const r = await rig({ config: OFF, alias: false });
    const dir = await withOldRun(r);
    const { ctx, err } = ctxFor(r.w, ['--gc', '--write']);
    expect(await r.cmd.run(ctx)).toBe(ExitCode.OK);
    expect(err).toEqual([]);
    expect(await exists(dir)).toBe(false);
    expect(await exists(path.join(r.w.state, 'rsi'))).toBe(false);
  });

  it('refuse:退出 3 state_dir_unsafe,不删', async () => {
    let stateOf = '';
    const r = await rig({
      config: async () => onConfig(path.join(stateOf, 'sub')),
      alias: false,
    });
    stateOf = r.w.state;
    const dir = await withOldRun(r);
    const { ctx, err } = ctxFor(r.w, ['--gc', '--write']);
    expect(await r.cmd.run(ctx)).toBe(ExitCode.FAIL_CLOSED);
    expect(err.join('')).toBe('RSI_FAIL_CLOSED reason=state_dir_unsafe\n');
    expect(await exists(dir)).toBe(true);
  });

  it('--gc 干跑与 --gc --write 之外:不读 rsi 配置(读就抛)、不拿锁', async () => {
    const r = await rig({
      config: async () => {
        throw new Error('rsiConfig must not be called');
      },
    });
    const dir = await withOldRun(r);
    const { ctx } = ctxFor(r.w, ['--gc']);
    expect(await r.cmd.run(ctx)).toBe(ExitCode.OK);
    expect(await exists(dir)).toBe(true);
    expect(await exists(path.join(r.w.state, 'rsi'))).toBe(false);
  });
});
