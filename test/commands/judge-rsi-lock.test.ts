/**
 * R20-A2 B3b:judge 的 rsi/lock 接线(契约 R20-5.1 / R20-5.2、D1、D3)。只有 `--run-llm` 拿锁,干跑不改。
 * worker × 各命令的并发组合留 A3;judge 即时闸 / privacyGate 属 B3c / B5。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createJudgeCommand, guardStoreFs } from '../../src/commands/judge.js';
import type { JudgeCommandDeps } from '../../src/commands/judge.js';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { exists, readText } from '../../src/io/read-fs.js';
import { remove, writeFile } from '../../src/io/safe-fs.js';
import { RsiFailClosedError } from '../../src/rsi/types.js';
import { RsiLockError } from '../../src/rsi/lock.js';
import type { RsiLockHandle } from '../../src/rsi/lock.js';
import type { RsiConfig } from '../../src/rsi/config.js';
import {
  RUN_ID,
  cmdCtx,
  makeStubs,
  newWork,
  redactor,
  snapshot,
  writeProposal,
} from '../judge/helpers.js';
import type { Stubs, Work } from '../judge/helpers.js';
import {
  aliasRsiState,
  lockFileOf,
  onConfig,
  startHolder,
  writePurgeJournal,
} from './rsi-lock-world.js';

const LIVE = ['--run', RUN_ID, '--run-llm', '--allow-egress'];
const OFF: RsiConfig = { status: 'off', reason: 'absent' };

interface Rig {
  w: Work;
  s: Stubs;
  factory: { n: number; lockSeen: boolean[] };
  cmd: ReturnType<typeof createJudgeCommand>;
  lockFile: string;
  /** 每次 complete 开始时 rsi/lock 是否在 */
  during: boolean[];
}

async function rig(
  o: {
    config?: RsiConfig | (() => Promise<RsiConfig>);
    alias?: boolean;
    deps?: Partial<JudgeCommandDeps>;
    beforeReturn?: (w: Work, lockFile: string) => Promise<void>;
  } = {},
): Promise<Rig> {
  const w = await newWork('judge-rl-');
  await writeProposal(w);
  const lockFile = lockFileOf(w.state);
  if (o.alias !== false) await aliasRsiState(w.io, w.dir);
  const s = makeStubs();
  const during: boolean[] = [];
  for (const b of Object.values(s.byHop)) {
    const orig = b.complete.bind(b);
    b.complete = async (req) => {
      during.push(await exists(lockFile));
      const res = await orig(req);
      await o.beforeReturn?.(w, lockFile);
      return res;
    };
  }
  const factory = { n: 0, lockSeen: [] as boolean[] };
  const config = o.config ?? onConfig(w.dir);
  const cmd = createJudgeCommand({
    createBackends: async () => {
      factory.n++;
      factory.lockSeen.push(await exists(lockFile));
      return s.backends;
    },
    redactor,
    requireOverlayEgress: false,
    rsiConfig: typeof config === 'function' ? config : async () => config,
    ...(o.deps ?? {}),
  });
  return { w, s, factory, cmd, lockFile, during };
}

describe('judge --run-llm × rsi/lock', () => {
  it('闸门 lock:构造后端与每次 LLM 调用期间持锁,结束后已释放;正向对照:评审成功', async () => {
    const r = await rig();
    const { ctx, out } = cmdCtx(r.w, LIVE);
    expect(await r.cmd.run(ctx)).toBe(ExitCode.OK);
    expect(r.factory.lockSeen).toEqual([true]);
    expect(r.during.length).toBeGreaterThan(0);
    expect(r.during.every((b) => b)).toBe(true);
    expect(r.s.totalCalls()).toBeGreaterThan(0);
    expect(out.join('')).toContain('judged');
    expect(await exists(r.lockFile)).toBe(false);
  });

  it('闸门 off:不建 rsi/、行为照旧(正向对照:照常评审)', async () => {
    const r = await rig({ config: OFF, alias: false });
    const { ctx, out } = cmdCtx(r.w, LIVE);
    expect(await r.cmd.run(ctx)).toBe(ExitCode.OK);
    expect(r.factory.lockSeen).toEqual([false]);
    expect(out.join('')).toContain('judged');
    expect(await exists(path.join(r.w.state, 'rsi'))).toBe(false);
    expect(await exists(path.join(r.w.dir, '.state'))).toBe(false);
  });

  it('干跑:不读 rsi 配置(读就抛)、不拿锁、零写入', async () => {
    const r = await rig({
      config: async () => {
        throw new Error('rsiConfig must not be called in dry-run');
      },
    });
    const before = await snapshot(r.w.runDir);
    const { ctx } = cmdCtx(r.w, ['--run', RUN_ID]);
    expect(await r.cmd.run(ctx)).toBe(ExitCode.OK);
    expect(await snapshot(r.w.runDir)).toEqual(before);
    expect(await exists(path.join(r.w.state, 'rsi'))).toBe(false);
  });

  it('另一个进程持锁:退出 4 JUDGE_NOT_RUN reason=locked,零构造零调用零写入,锁文件不变', async () => {
    const r = await rig();
    const holder = await startHolder(r.w.state, r.w.dir);
    try {
      const lockBefore = await readText(r.lockFile);
      const before = await snapshot(r.w.runDir);
      const { ctx, err, out } = cmdCtx(r.w, LIVE);
      expect(await r.cmd.run(ctx)).toBe(ExitCode.NOT_RUN);
      expect(err.join('')).toBe('JUDGE_NOT_RUN reason=locked\n');
      expect(out).toEqual([]);
      expect(r.factory.n).toBe(0);
      expect(r.s.totalCalls()).toBe(0);
      expect(await readText(r.lockFile)).toBe(lockBefore);
      expect(await snapshot(r.w.runDir)).toEqual(before);
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
    const before = await snapshot(r.w.runDir);
    const { ctx, err, out } = cmdCtx(r.w, LIVE);
    expect(await r.cmd.run(ctx)).toBe(ExitCode.FAIL_CLOSED);
    expect(err.join('')).toBe('RSI_FAIL_CLOSED reason=state_dir_unsafe\n');
    expect(out).toEqual([]);
    expect(r.factory.n).toBe(0);
    expect(r.s.totalCalls()).toBe(0);
    expect(await snapshot(r.w.runDir)).toEqual(before);
    expect(await exists(path.join(r.w.state, 'rsi'))).toBe(false);
  });

  it('LLM 返回时锁已被换成别人的:退出 3 lock_lost,提案文件不变,别人的锁还在', async () => {
    const r = await rig({
      beforeReturn: async (w, lockFile) => {
        const doc = JSON.parse(await readText(lockFile)) as Record<string, unknown>;
        await remove(w.io, lockFile);
        await writeFile(w.io, lockFile, JSON.stringify({ ...doc, nonce: 'f'.repeat(32) }), {
          mode: 0o600,
        });
      },
    });
    const before = await snapshot(r.w.runDir);
    const { ctx, err } = cmdCtx(r.w, LIVE);
    expect(await r.cmd.run(ctx)).toBe(ExitCode.FAIL_CLOSED);
    expect(err.join('')).toContain('RSI_FAIL_CLOSED reason=lock_lost\n');
    expect(await snapshot(r.w.runDir)).toEqual(before); // 没写 judge,也没写 judge_attempts
    expect(await readText(r.lockFile)).toContain('f'.repeat(32));
  });

  it('失锁后不再发起下一次外发(第一次返回后锁没了,总调用数为 1)', async () => {
    const r = await rig({
      beforeReturn: async (w, lockFile) => {
        await remove(w.io, lockFile);
      },
    });
    const { ctx } = cmdCtx(r.w, LIVE);
    expect(await r.cmd.run(ctx)).toBe(ExitCode.FAIL_CLOSED);
    expect(r.s.totalCalls()).toBe(1);
  });
});

describe('judge --run-llm × assertNoPurge(缺省 = taint.ts 真实实现)', () => {
  it('真 purge journal 存在:退出 3 purge_incomplete,零后端构造、零调用、提案不变、journal 原样', async () => {
    const r = await rig();
    const jf = await writePurgeJournal(r.w.io, r.w.state);
    const jBefore = await readText(jf);
    const before = await snapshot(r.w.runDir);
    const { ctx, err } = cmdCtx(r.w, LIVE);
    expect(await r.cmd.run(ctx)).toBe(ExitCode.FAIL_CLOSED);
    expect(err.join('')).toBe('RSI_FAIL_CLOSED reason=purge_incomplete\n');
    expect(r.factory.n).toBe(0);
    expect(r.s.totalCalls()).toBe(0);
    expect(await snapshot(r.w.runDir)).toEqual(before);
    expect(await readText(jf)).toBe(jBefore);
  });

  it('journal 不合规 → journal_invalid;删除后同一命令放行(对照:journal absent 不影响)', async () => {
    const r = await rig();
    const jf = await writePurgeJournal(r.w.io, r.w.state, '{broken');
    const { ctx, err } = cmdCtx(r.w, LIVE);
    expect(await r.cmd.run(ctx)).toBe(ExitCode.FAIL_CLOSED);
    expect(err.join('')).toBe('RSI_FAIL_CLOSED reason=journal_invalid\n');
    expect(r.s.totalCalls()).toBe(0);
    await remove(r.w.io, jf);
    const again = cmdCtx(r.w, LIVE);
    expect(await r.cmd.run(again.ctx)).toBe(ExitCode.OK);
  });

  it('assertNoPurge 在锁内被调用(注入替身,验证调用点仍在拿锁之后、改提案之前)', async () => {
    const seen: boolean[] = [];
    const ref: { lock: string } = { lock: '' };
    const r = await rig({
      deps: {
        assertNoPurge: async () => {
          seen.push(await exists(ref.lock));
          throw new RsiFailClosedError('purge_incomplete');
        },
      },
    });
    ref.lock = r.lockFile;
    const { ctx } = cmdCtx(r.w, LIVE);
    expect(await r.cmd.run(ctx)).toBe(ExitCode.FAIL_CLOSED);
    expect(seen).toEqual([true]);
    expect(r.factory.n).toBe(0);
  });

  it('闸门 off:即使有 journal 也不检查、不受影响', async () => {
    const r = await rig({ config: OFF, alias: false });
    await writePurgeJournal(r.w.io, r.w.state);
    const { ctx } = cmdCtx(r.w, LIVE);
    expect(await r.cmd.run(ctx)).toBe(ExitCode.OK);
  });
});

describe('guardStoreFs:每次写前复核锁', () => {
  const handle = (ok: boolean): RsiLockHandle => ({
    path: '/x',
    nonce: 'n',
    async assertHeld() {
      if (!ok) throw new RsiLockError('lock_lost');
    },
    async release() {},
  });

  it('失锁:writeFile / chmod / rename / remove 全部抛并记入 loss,底层一概不动;正向对照:持锁时放行', async () => {
    const w = await newWork('judge-gs-');
    const target = path.join(w.dir, 'x.txt');
    const lossBad = { lost: undefined as RsiLockError | undefined };
    const fsBad = guardStoreFs(handle(false), lossBad);
    await expect(fsBad.writeFile(w.io, target, 'a', { mode: 0o600 })).rejects.toBeInstanceOf(
      RsiLockError,
    );
    expect(lossBad.lost?.kind).toBe('lock_lost');
    expect(await exists(target)).toBe(false);
    await writeFile(w.io, target, 'seed', { mode: 0o600 });
    await expect(fsBad.remove(w.io, target)).rejects.toBeInstanceOf(RsiLockError);
    await expect(fsBad.rename(w.io, target, `${target}.2`)).rejects.toBeInstanceOf(RsiLockError);
    await expect(fsBad.chmod(w.io, target, 0o644)).rejects.toBeInstanceOf(RsiLockError);
    expect(await readText(target)).toBe('seed');
    expect(await exists(`${target}.2`)).toBe(false);

    const lossOk = { lost: undefined as RsiLockError | undefined };
    const fsOk = guardStoreFs(handle(true), lossOk);
    await fsOk.writeFile(w.io, `${target}.3`, 'b', { mode: 0o600 });
    expect(await readText(`${target}.3`)).toBe('b');
    expect(lossOk.lost).toBeUndefined();
  });
});
