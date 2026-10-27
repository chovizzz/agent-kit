/**
 * R20-A2 B4c2:中止规则 [A0] / [A1] 与墙钟(B4 方案 §4.1)。断言都带正向前提(先证明「会变」,再证明「没变」),避免断言静默变空。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RsiCountsSchema, RsiCursorSchema, type RsiState } from '../../src/contracts/rsi.js';
import { canonicalJson } from '../../src/io/canonical-json.js';
import { exists, readText } from '../../src/io/read-fs.js';
import { createCheckpoint } from '../../src/rsi/l0/binding.js';
import type { Checkpoint, CheckpointVerdict, CheckpointWhere } from '../../src/rsi/l0/types.js';
import { inspectSnapshot } from '../../src/rsi/snapshot.js';
import { productionSnapshotValidator } from '../../src/rsi/validators.js';
import { SALT_FP, countsDoc, put, writeCountsRaw } from './services-fixture.js';
import {
  CONT,
  dataDigest,
  emptyState,
  inputOf,
  loseLock,
  makeRunFx,
  rsiFile,
  runL0,
  type RunFx,
} from './l0-run-fixture.js';

/** 第 `n` 次以 `where` 调用时返回 abort(其余 continue) */
function abortAt(
  where: CheckpointWhere,
  n: number,
  outcome: 'stopped' | 'skipped_binding_changed' = 'stopped',
): Checkpoint {
  let seen = 0;
  return async (w): Promise<CheckpointVerdict> => {
    if (w !== where) return CONT;
    seen++;
    return seen === n ? { kind: 'abort', outcome } : CONT;
  };
}

const countsText = async (fx: RunFx): Promise<string | null> => {
  const p = path.join(fx.s.rsi, 'counts.json');
  return (await exists(p)) ? readText(p) : null;
};
const lastLog = async (fx: RunFx): Promise<{ action: string; code: string }> => {
  const lines = (await readText(path.join(fx.s.rsi, 'log.jsonl'))).trim().split('\n');
  return JSON.parse(lines[lines.length - 1] as string) as { action: string; code: string };
};
const stateOf = async (fx: RunFx): Promise<RsiState> =>
  (await rsiFile(fx.s, 'state.json')) as RsiState;

/** 已提交一轮(alpha)后再加一个新项目 beta 的会话:下一次运行有新数据可提交 */
async function primed(prefix: string): Promise<RunFx> {
  const fx = await makeRunFx(prefix);
  await fx.claude(1, await fx.work('alpha'));
  await runL0(fx);
  await fx.claude(2, await fx.work('beta'), { ts: '2026-09-15T00:00:00.000Z' });
  return fx;
}

describe('[A0] 首次数据提交之前中止:四类数据文件字节不变', () => {
  for (const [name, where, n] of [
    ['读阶段(第一个文件开始前)abort', 'file', 2],
    ['#0 权威复检 abort', 'commit', 1],
  ] as const) {
    it(`${name}:信号库 / 会话计数 / 索引 / cursor 逐字节不变;state 与清单已提交;日志记 stopped`, async () => {
      const fx = await primed(`l0a0-${where}-`);
      const before = await dataDigest(fx.s);
      expect(before.length).toBeGreaterThan(0); // 正向前提:确有数据
      const countsBefore = await countsText(fx);
      const r = await runL0(fx, inputOf({ checkpoint: abortAt(where, n) }));
      expect(r).toMatchObject({
        outcome: 'stopped',
        stage: 'a0',
        indexWritten: false,
        cursorWritten: false,
      });
      expect(await dataDigest(fx.s)).toEqual(before);
      expect(await countsText(fx)).toBe(countsBefore); // staged 没有变化 → counts.json 也不重写
      expect((await stateOf(fx)).last_tick?.outcome).toBe('stopped');
      expect(await lastLog(fx)).toMatchObject({ action: 'stopped', code: 'stopped' });
      expect(await inspectSnapshot(fx.s.io, productionSnapshotValidator)).toBe('consistent');
      // 对照:同一份磁盘状态下不中止,数据确实会变(证明上面的「不变」不是空对空)
      const ok = await runL0(fx);
      expect(ok.signalsNew).toBeGreaterThan(0);
      expect(await dataDigest(fx.s)).not.toEqual(before);
    });
  }

  it('#pre abort 且盐还没建:不建盐、不建信号库目录;state 与日志仍写', async () => {
    const fx = await makeRunFx('l0a0-pre-', { salt: false });
    await fx.claude(1, await fx.work('alpha'));
    const r = await runL0(fx, inputOf({ checkpoint: abortAt('file', 1) }));
    expect(r).toMatchObject({ outcome: 'stopped', stage: 'a0' });
    expect(await exists(path.join(fx.s.state, 'salt'))).toBe(false);
    expect(await exists(path.join(fx.s.state, 'signals'))).toBe(false);
    expect((await stateOf(fx)).last_tick?.outcome).toBe('stopped');
    expect(await lastLog(fx)).toMatchObject({ action: 'stopped' });
  });

  it('[A0] 仍校正 staged.tainted(只改这一段):TAINTED 在场 → true;其余段(per_key / clusters)逐字节不变', async () => {
    const fx = await primed('l0a0-staged-');
    const s = fx.s;
    const c0 = RsiCountsSchema.parse(await rsiFile(s, 'counts.json'));
    await writeCountsRaw(
      s,
      countsDoc(c0.salt_fp, {
        per_key: c0.per_key,
        staged: [{ run_id: 'run-y', proposals: 2, evidence_keys: [], tainted: false }],
        generation: c0.generation,
      }),
    );
    await put(
      s,
      path.join(s.state, 'reflect', 'run-y', 'TAINTED'),
      '{"reason":"purge","at":"2026-10-26T00:00:00.000Z"}\n',
    );
    await runL0(fx, inputOf({ checkpoint: abortAt('file', 2) }));
    const c1 = RsiCountsSchema.parse(await rsiFile(s, 'counts.json'));
    expect(c1.staged).toEqual([
      { run_id: 'run-y', proposals: 2, evidence_keys: [], tainted: true },
    ]);
    expect(c1.per_key).toEqual(c0.per_key);
    expect(c1.clusters).toEqual(c0.clusters);
    expect(c1.unknown_keys_signals).toBe(c0.unknown_keys_signals);
    expect(SALT_FP).toBe(c1.salt_fp); // 夹具前提:盐指纹一致,校正才允许
  });
});

describe('[A0] 的 staged 校正也在写点前复核锁', () => {
  it('校正写 counts.json 的每个写点之前失锁 → lock_lost,之后零写入;counts.json 仍是旧值', async () => {
    const mk = async (prefix: string): Promise<RunFx> => {
      const fx = await primed(prefix);
      const c0 = RsiCountsSchema.parse(await rsiFile(fx.s, 'counts.json'));
      await writeCountsRaw(
        fx.s,
        countsDoc(c0.salt_fp, {
          per_key: c0.per_key,
          staged: [{ run_id: 'run-z', proposals: 1, evidence_keys: [], tainted: false }],
          generation: c0.generation,
        }),
      );
      await put(
        fx.s,
        path.join(fx.s.state, 'reflect', 'run-z', 'TAINTED'),
        '{"reason":"purge","at":"2026-10-26T00:00:00.000Z"}\n',
      );
      return fx;
    };
    const rec = await mk('l0a0-lost-rec-');
    const names: string[] = [];
    await runL0(rec, inputOf({ checkpoint: abortAt('file', 2) }), {
      beforeWrite: async (op) => void names.push(op),
    });
    expect(names.slice(0, 3)).toEqual([
      'tmp-remove:counts.json',
      'tmp-write:counts.json',
      'rename:counts.json',
    ]);
    for (let k = 1; k <= 3; k++) {
      const fx = await mk(`l0a0-lost-${k}-`);
      const before = await countsText(fx);
      let seen = 0;
      let atHook = -1;
      await expect(
        runL0(fx, inputOf({ checkpoint: abortAt('file', 2) }), {
          beforeWrite: async () => {
            if (++seen !== k) return;
            atHook = fx.s.audit.length;
            await loseLock(fx.s);
          },
        }),
      ).rejects.toMatchObject({ kind: 'lock_lost' });
      expect(fx.s.audit.length).toBe(atHook);
      expect(await countsText(fx)).toBe(before);
    }
  });

  it('#pre abort 且盐已存在:staged 校正照常做(盐指纹一致才校正);盐不存在则跳过且不报错', async () => {
    const fx = await primed('l0a0-pre-staged-');
    const c0 = RsiCountsSchema.parse(await rsiFile(fx.s, 'counts.json'));
    await writeCountsRaw(
      fx.s,
      countsDoc(c0.salt_fp, {
        per_key: c0.per_key,
        staged: [{ run_id: 'run-q', proposals: 1, evidence_keys: [], tainted: false }],
        generation: c0.generation,
      }),
    );
    await put(
      fx.s,
      path.join(fx.s.state, 'reflect', 'run-q', 'TAINTED'),
      '{"reason":"purge","at":"2026-10-26T00:00:00.000Z"}\n',
    );
    await runL0(fx, inputOf({ checkpoint: abortAt('file', 1) }));
    expect(RsiCountsSchema.parse(await rsiFile(fx.s, 'counts.json')).staged[0]?.tainted).toBe(true);
  });
});

describe('[A1] C1 之后中止:cursor 不推进,按步骤跳过剩余数据步骤', () => {
  for (const k of [1, 2, 3, 4, 5]) {
    it(`#${k} abort:cursor.json 字节不变;信号库已写;${k <= 1 ? '会话计数 / ' : ''}${k <= 2 ? '索引 / ' : ''}被跳过的数据步骤确实没写;重跑去重后追平`, async () => {
      const fx = await primed(`l0a1-${k}-`);
      const s = fx.s;
      const cursorBefore = await readText(path.join(s.rsi, 'cursor.json'));
      const before = await dataDigest(fx.s);
      const sigPart = (d: string[]): string[] => d.filter((l) => l.startsWith('signals/'));
      const sessPart = (d: string[]): string[] => d.filter((l) => l.startsWith('sessions/'));
      const idxBefore = await readText(path.join(s.rsi, 'projects.json'));
      const r = await runL0(fx, inputOf({ checkpoint: abortAt('commit', k + 1) }));
      expect(r).toMatchObject({ outcome: 'stopped', stage: 'a1', cursorWritten: false });
      expect(await readText(path.join(s.rsi, 'cursor.json'))).toBe(cursorBefore);
      const after = await dataDigest(fx.s);
      expect(sigPart(after)).not.toEqual(sigPart(before)); // C1 已提交
      if (k <= 1)
        expect(sessPart(after)).toEqual(sessPart(before)); // C2 被跳过
      else expect(sessPart(after)).not.toEqual(sessPart(before));
      const idxAfter = await readText(path.join(s.rsi, 'projects.json'));
      if (k <= 2)
        expect(idxAfter).toBe(idxBefore); // C3 被跳过
      else expect(idxAfter).not.toBe(idxBefore);
      // C4 照做(三段从磁盘重算):新项目的信号已经在 per_key 里
      const c = RsiCountsSchema.parse(await rsiFile(s, 'counts.json'));
      expect(
        Object.values(c.per_key)
          .map((v) => v.signals_total)
          .sort(),
      ).toEqual([2, 2]);
      expect(await lastLog(fx)).toMatchObject({ action: 'stopped', code: 'stopped' });
      if (k < 5) expect((await stateOf(fx)).last_tick?.outcome).toBe('stopped');
      else expect((await stateOf(fx)).last_tick?.outcome).toBe('ok'); // 残余(已登记):#5 在 state 写之后,日志才是真实 outcome
      expect(await inspectSnapshot(s.io, productionSnapshotValidator)).toBe('consistent');
      // 重跑:信号已入库 → 去重为 0;cursor 追平(含 beta 的会话);会话计数与索引补齐
      const again = await runL0(fx);
      expect(again).toMatchObject({ outcome: 'ok', signalsNew: 0, cursorWritten: true });
      const cur = RsiCursorSchema.parse(await rsiFile(s, 'cursor.json'));
      expect(Object.keys(cur.files)).toHaveLength(2);
      const c2 = RsiCountsSchema.parse(await rsiFile(s, 'counts.json'));
      expect(Object.values(c2.per_key).map((v) => [v.signals_total, v.sessions])).toEqual([
        [2, 1],
        [2, 1],
      ]);
    });
  }
});

describe('中止不 ack、坏库不写', () => {
  it('确认后的第一次运行在 #3(索引已写)被中止:baseline_pending 仍为 true、ack 不动;下一次成功的运行才 ack', async () => {
    const fx = await makeRunFx('l0noack-');
    await fx.claude(1, await fx.work('alpha'));
    const confirm = {
      confirmed_at: '2026-10-20T00:00:00.000Z',
      kit_major: 0,
      agents: ['claude', 'codex', 'pi'],
      exclude_hashes: [],
      repo_sha256: 'a'.repeat(64),
      repo_dev_ino: { dev: 1, ino: 1 },
      overlay_sha256: null,
      policy_fp: 'b'.repeat(64),
      baseline_pending: true,
    };
    await put(fx.s, path.join(fx.s.rsi, 'state.json'), canonicalJson({ ...emptyState(), confirm }));
    const r = await runL0(fx, inputOf({ checkpoint: abortAt('commit', 4) }));
    expect(r).toMatchObject({ stage: 'a1', indexWritten: true });
    expect((await stateOf(fx)).confirm?.baseline_pending).toBe(true);
    expect((await stateOf(fx)).projects_ack_generation).toBe(0);
    await runL0(fx);
    expect((await stateOf(fx)).confirm?.baseline_pending).toBe(false);
    expect((await stateOf(fx)).projects_ack_generation).toBeGreaterThan(0);
  });

  it('提交前的无副作用复检:信号库带病(坏行)→ fail-closed signal_store_corrupt,提交开始之后零写入(写审计),数据文件不变', async () => {
    const fx = await makeRunFx('l0corrupt-');
    await fx.claude(1, await fx.work('alpha'));
    await runL0(fx);
    await put(fx.s, path.join(fx.s.state, 'signals', 'claude', '202610.jsonl'), '{not json\n');
    await fx.claude(2, await fx.work('beta'), { ts: '2026-10-05T00:00:00.000Z' });
    const before = await dataDigest(fx.s);
    const audit0 = fx.s.audit.length;
    await expect(runL0(fx)).rejects.toMatchObject({ reason: 'signal_store_corrupt' });
    expect(fx.s.audit.length).toBeGreaterThan(audit0); // 正向前提:审计确实在记录(锁的写)
    // 锁的获取 / 释放(mkdirp .state[/rsi]、lock 的创建与删除)之外,没有任何写
    const writes = fx.s.audit
      .slice(audit0)
      .filter((l) => !/(mkdirp .*\.state(\/rsi)?|\/rsi\/lock)$/.test(l));
    expect(writes).toEqual([]); // 复检在写任何东西之前就抛
    expect(await dataDigest(fx.s)).toEqual(before);
  });
});

describe('墙钟:提交阶段不阻断已经开始的有序提交', () => {
  const binding = inputOf().binding;
  const real = (clock: { t: number }): Checkpoint =>
    createCheckpoint({
      nowMs: () => clock.t,
      startedAtMs: 0,
      maxMs: 120_000,
      binding,
      observe: async () => ({ stopPresent: false, collectBlocked: false, current: binding }),
    });

  it('读阶段结束后时钟越过 120 秒(第一个写点之前):C1..C7 照样走完;提交阶段的检查点永不返回 time_limit', async () => {
    const fx = await makeRunFx('l0wall-commit-');
    await fx.claude(1, await fx.work('alpha'));
    const clock = { t: 0 };
    const commitVerdicts: string[] = [];
    const inner = real(clock);
    const r = await runL0(
      fx,
      inputOf({
        checkpoint: async (w) => {
          const v = await inner(w);
          if (w === 'commit') commitVerdicts.push(v.kind);
          return v;
        },
      }),
      {
        beforeWrite: async (op) => {
          if (op === 'write-tmp') clock.t = 500_000; // C1 开始之前时钟已过期
        },
      },
    );
    expect(r).toMatchObject({ outcome: 'ok', stage: 'full', cursorWritten: true });
    expect(commitVerdicts.length).toBeGreaterThanOrEqual(5);
    expect(new Set(commitVerdicts)).toEqual(new Set(['continue']));
    // 正向对照:同样的过期时钟在读阶段(where='file')确实返回 time_limit
    expect(await inner('file')).toEqual({ kind: 'time_limit' });
  });

  it('检查点桩在 commit 位置返回 time_limit:提交阶段按 continue 处理,仍走完(防御冻结规则被违反)', async () => {
    const fx = await makeRunFx('l0wall-stub-');
    await fx.claude(1, await fx.work('alpha'));
    const r = await runL0(
      fx,
      inputOf({ checkpoint: async (w) => (w === 'commit' ? { kind: 'time_limit' } : CONT) }),
    );
    expect(r).toMatchObject({ outcome: 'ok', stage: 'full', cursorWritten: true });
  });

  it('读阶段墙钟到期:ok_partial + RSI_LIMIT_TIME,已读的部分正常提交(0 个文件也走完 state / 日志 / 清单)', async () => {
    const fx = await makeRunFx('l0wall-read-');
    await fx.claude(1, await fx.work('alpha'));
    const r = await runL0(fx, inputOf({ checkpoint: real({ t: 500_000 }) }));
    expect(r.outcome).toBe('ok_partial');
    expect(r.summary.limits_hit).toContain('RSI_LIMIT_TIME');
    expect(r.summary.files_read).toBe(0);
    expect(r.stage).toBe('full');
    expect((await stateOf(fx)).last_tick?.outcome).toBe('ok_partial');
  });
});
