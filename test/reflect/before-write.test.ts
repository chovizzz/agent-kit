/**
 * R20-A2 B3b 返工:reflect 的写前复核钩子(beforeWrite / beforeDelete)与 ReflectAbortedError 传播。
 * 非 rsi 路径缺省不传钩子,行为不变(其余 reflect 测试即证明)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, readDir } from '../../src/io/read-fs.js';
import { mkdirp, writeFile } from '../../src/io/safe-fs.js';
import { runReflectGc } from '../../src/reflect/gc.js';
import { runReflect } from '../../src/reflect/run.js';
import { ReflectAbortedError } from '../../src/reflect/types.js';
import { setupEnv } from '../fixtures/reflect/world.js';

const reflectRoot = (state: string): string => path.join(state, 'reflect');
const names = async (state: string): Promise<string[]> =>
  (await exists(reflectRoot(state))) ? (await readDir(reflectRoot(state))).map((e) => e.name) : [];

describe('runReflect:beforeWrite', () => {
  it('成功路径:记下全部写前复核点;正向对照:不传钩子同样成功暂存', async () => {
    const env = await setupEnv();
    let n = 0;
    const r = await runReflect(
      { ...env.deps, beforeWrite: async () => void n++ },
      { ...env.opts, runId: 'run-count-1' },
    );
    expect(r.report.outcome).toBe('staged');
    expect(n).toBeGreaterThan(8); // mkdir/chmod/writeFile/chmod × 各文件 + 最终 rename
    const plain = await runReflect(env.deps, { ...env.opts, runId: 'run-plain-1' });
    expect(plain.report.outcome).toBe('staged');
  });

  it('在第 k 个写点失锁(k = 1..N):抛 ReflectAbortedError,恰好停在 k,最终目录从不出现(rename 前也复核)', async () => {
    const probe = await setupEnv();
    let total = 0;
    await runReflect({ ...probe.deps, beforeWrite: async () => void total++ }, probe.opts);
    expect(total).toBeGreaterThan(8);
    for (let k = 1; k <= total; k++) {
      const env = await setupEnv();
      let n = 0;
      const lost = new Error('lost');
      const e = await runReflect(
        {
          ...env.deps,
          beforeWrite: async () => {
            if (++n === k) throw new ReflectAbortedError(lost);
          },
        },
        env.opts,
      ).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ReflectAbortedError);
      expect((e as ReflectAbortedError).inner).toBe(lost);
      expect(n).toBe(k); // 失锁之后一次写点都没再走
      expect(await exists(path.join(reflectRoot(env.w.state), env.opts.runId))).toBe(false);
    }
  });

  it('每个实际写操作(mkdirp / writeFile / chmod / rename)之前都有一次对应的复核', async () => {
    const env = await setupEnv();
    let credit = 0;
    let minCredit = 0;
    const counted = new Set(['mkdirp', 'writeFile', 'chmod', 'rename']);
    const io = {
      ...env.deps.io,
      writeAudit: (op: string) => {
        if (!counted.has(op)) return;
        credit--;
        minCredit = Math.min(minCredit, credit);
      },
    };
    const r = await runReflect(
      { ...env.deps, io, beforeWrite: async () => void credit++ },
      env.opts,
    );
    expect(r.report.outcome).toBe('staged');
    expect(minCredit).toBe(0); // 任何时刻写操作数都不超过已做的复核数
    expect(credit).toBe(0);
  });

  it('最终 rename 之前也复核:临时目录已写全后的那次复核失锁 → 最终目录不出现', async () => {
    const env = await setupEnv();
    const tmpReport = path.join(reflectRoot(env.w.state), `.tmp-${env.opts.runId}`, 'report.json');
    let afterReport = 0;
    const e = await runReflect(
      {
        ...env.deps,
        beforeWrite: async () => {
          // report.json 落盘之后依次有两次复核:chmod 之前、rename 之前;第二次(rename 前)失锁
          if ((await exists(tmpReport)) && ++afterReport === 2) {
            throw new ReflectAbortedError(new Error('lost'));
          }
        },
      },
      env.opts,
    ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ReflectAbortedError);
    expect(afterReport).toBe(2);
    expect(await exists(path.join(reflectRoot(env.w.state), env.opts.runId))).toBe(false);
  });

  it('后端失败分支(无证据的 report-only 路径)同样先复核:失锁 → 不写 report.json', async () => {
    const env = await setupEnv(() => ({ ok: false, reason: 'error' }));
    const e = await runReflect(
      {
        ...env.deps,
        beforeWrite: async () => {
          throw new ReflectAbortedError(new Error('lost'));
        },
      },
      env.opts,
    ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ReflectAbortedError);
    expect(await names(env.w.state)).toEqual([]);
    // 正向对照:不传钩子时同一后端失败会写 report.json(not_run)
    const plain = await setupEnv(() => ({ ok: false, reason: 'error' }));
    const r = await runReflect(plain.deps, plain.opts);
    expect(r.exitCode).toBe(4);
    expect(await names(plain.w.state)).toEqual([plain.opts.runId]);
  });

  it('后端抛 ReflectAbortedError:原样重抛,不当成 backend_error、不写 report.json;普通抛错照旧写 not_run 报告', async () => {
    const env = await setupEnv();
    env.backend.complete = async () => {
      throw new ReflectAbortedError(new Error('lost'));
    };
    const e = await runReflect(env.deps, env.opts).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ReflectAbortedError);
    expect(await names(env.w.state)).toEqual([]);

    const plain = await setupEnv();
    plain.backend.complete = async () => {
      throw new Error('boom');
    };
    const r = await runReflect(plain.deps, plain.opts);
    expect(r.exitCode).toBe(4);
    expect(await names(plain.w.state)).toEqual([plain.opts.runId]);
  });
});

describe('runReflectGc:beforeDelete', () => {
  const OLD = ['run-20200101T000000Z-aaaaaa', 'run-20200102T000000Z-bbbbbb'];
  const report = (id: string): string =>
    `${JSON.stringify({
      run_id: id,
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
    })}\n`;
  async function world() {
    const env = await setupEnv();
    for (const id of OLD) {
      const dir = path.join(reflectRoot(env.w.state), id);
      await mkdirp(env.w.io, dir, 0o700);
      await writeFile(env.w.io, path.join(dir, 'report.json'), report(id), { mode: 0o600 });
    }
    return env;
  }
  const NOW = new Date('2026-10-12T08:00:00Z');

  it('每次实际删除前调一次;正向对照:全部放行时两个都删', async () => {
    const env = await world();
    let n = 0;
    const r = await runReflectGc(env.w.io, NOW, {
      write: true,
      beforeDelete: async () => void n++,
    });
    expect(n).toBe(2);
    expect([...r.deleted].sort()).toEqual(OLD);
  });

  it('第 1 次复核即失锁:一个都不删,错误原样传播(不是跳过);第 2 次失锁:只删了第 1 个', async () => {
    const e1 = await world();
    const lost = new ReflectAbortedError(new Error('lost'));
    await expect(
      runReflectGc(e1.w.io, NOW, {
        write: true,
        beforeDelete: async () => {
          throw lost;
        },
      }),
    ).rejects.toBe(lost);
    expect((await names(e1.w.state)).sort()).toEqual([...OLD].sort());

    const e2 = await world();
    let n = 0;
    await expect(
      runReflectGc(e2.w.io, NOW, {
        write: true,
        beforeDelete: async () => {
          if (++n === 2) throw lost;
        },
      }),
    ).rejects.toBe(lost);
    expect((await names(e2.w.state)).length).toBe(1);
  });
});
