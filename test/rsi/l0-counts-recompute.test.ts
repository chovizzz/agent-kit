/**
 * R20-A2 B4c1:`recomputeCounts`(R20-4.5;B4 方案 §3.5)。三段(per_key / unknown_keys_signals / staged.tainted)每次都从磁盘重算:
 *  - 与「从已写好的信号库 / 会话计数库手算」的结果逐项相等(手算在测试里按数据清单独立做);
 *  - 去重后的重读(C1 之后崩溃再重跑)结果不变;`counts.json` 里陈旧的数字不被沿用(不是增量);
 *  - `staged.tainted` 每次按 `TAINTED` 的实际存在情况核实;
 *  - 库带病 fail-closed、零写入。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Signal } from '../../src/contracts/signal.js';
import type { SessionStat } from '../../src/contracts/session-stat.js';
import { exists } from '../../src/io/read-fs.js';
import { hardlink, mkdirp, symlink, writeFile } from '../../src/io/safe-fs.js';
import { recomputeCounts } from '../../src/rsi/l0/counts-recompute.js';
import { RsiSnapshotError } from '../../src/rsi/snapshot-read.js';
import { writeSessionStats } from '../../src/signals/session-stats.js';
import { writeSignals } from '../../src/signals/state-store.js';
import { createRsiIoContext } from '../../src/rsi/io.js';
import { withWriteAudit } from '../helpers/write-audit.js';
import { treeOf } from './rsi-fixture.js';
import { makeL0Fx, type L0Fx } from './l0-fixture.js';
import { countsOf, key, seed } from './ro-fixture.js';
import { signalObj } from './services-fixture.js';

const NOW = new Date('2026-10-26T12:00:00.000Z');
const hex16 = (n: number): string => n.toString(16).padStart(16, '0');
const sig = (n: number, k: string, ts: string): Signal =>
  ({ ...signalObj(hex16(n), k), ts }) as unknown as Signal;
const stat = (n: number, k: string, ts = '2026-10-20T00:00:00.000Z'): SessionStat => ({
  session_ref: `s_${hex16(n)}`,
  project_key: k,
  ts,
  external_content: false,
  counts: { user_messages: 1, tool_calls: 0, tool_failures: 0, unknown_event_types: {} },
});

const KA = key(1);
const KB = key(2);
const KC = key(3);

/** 手算口径:窗口 = NOW 所在 UTC 日及其前 7 日 */
const WINDOW = [
  '2026-10-19',
  '2026-10-20',
  '2026-10-21',
  '2026-10-22',
  '2026-10-23',
  '2026-10-24',
  '2026-10-25',
  '2026-10-26',
];

interface Model {
  signals: { k: string; ts: string }[];
  sessions: { k: string }[];
}
function handCount(m: Model): {
  perKey: Record<
    string,
    { signals_total: number; sessions: number; signals_by_day: Record<string, number> }
  >;
  unknown: number;
} {
  const perKey: Record<
    string,
    { signals_total: number; sessions: number; signals_by_day: Record<string, number> }
  > = {};
  let unknown = 0;
  const of = (k: string) => (perKey[k] ??= { signals_total: 0, sessions: 0, signals_by_day: {} });
  for (const s of m.signals) {
    if (!/^p_[0-9a-f]{16}$/.test(s.k)) {
      unknown++;
      continue;
    }
    const e = of(s.k);
    e.signals_total++;
    const day = new Date(s.ts).toISOString().slice(0, 10);
    if (WINDOW.includes(day)) e.signals_by_day[day] = (e.signals_by_day[day] ?? 0) + 1;
  }
  for (const s of m.sessions) if (/^p_[0-9a-f]{16}$/.test(s.k)) of(s.k).sessions++;
  return { perKey, unknown };
}

async function mixed(f: L0Fx): Promise<Model> {
  const sigs = [
    sig(1, KA, '2026-10-26T01:00:00.000Z'),
    sig(2, KA, '2026-10-26T23:59:59.000Z'),
    sig(3, KA, '2026-10-19T00:00:00.000Z'), // 窗口最早一天
    sig(4, KA, '2026-10-18T23:59:59.000Z'), // 窗口之外:只进 total
    sig(5, KA, '2026-10-27T00:00:00.000Z'), // 未来日:只进 total
    sig(6, KA, '2026-10-19T03:00:00+08:00'), // = UTC 10-18 19:00:换算后在窗口外
    sig(7, KB, '2026-09-30T00:00:00.000Z'), // 上个月的文件
    sig(8, KB, '2026-10-22T10:00:00.000Z'),
    sig(9, 'plain-overlay-key' as string, '2026-10-22T10:00:00.000Z'), // 非 p_ 形状:并入 unknown
    sig(10, 'plain-overlay-key' as string, '2026-10-23T10:00:00.000Z'),
    sig(11, KA, '2026-10-25T20:00:00-11:00'), // = UTC 10-26 07:00:换算后落在 10-26(直接截 ts 前 10 位会算成 10-25)
  ];
  await writeSignals(f.io, 'claude', sigs.slice(0, 7));
  await writeSignals(f.io, 'pi', sigs.slice(7));
  const stats = [
    stat(1, KA),
    stat(2, KA),
    stat(3, KB, '2026-09-30T00:00:00.000Z'),
    stat(4, KC), // 只有会话、没有信号的 key
    stat(5, 'plain-overlay-key'), // 非法形状:不进 per_key
  ];
  await writeSessionStats(f.io, 'claude', stats.slice(0, 3));
  await writeSessionStats(f.io, 'codex', stats.slice(3));
  return {
    signals: sigs.map((s) => ({ k: s.project_key, ts: s.ts })),
    sessions: stats.map((s) => ({ k: s.project_key })),
  };
}

describe('recomputeCounts:per_key / unknown_keys_signals 等于从磁盘手算', () => {
  it('多 agent、多月文件、窗口边界(含未来日与带时区偏移的 ts)、非法形状 key、只有会话的 key', async () => {
    const f = await makeL0Fx('cc-mixed-');
    const m = await mixed(f);
    const r = await recomputeCounts(f.io, f.config, NOW);
    const want = handCount(m);
    expect(r.perKey).toEqual(want.perKey);
    expect(r.unknownKeysSignals).toBe(want.unknown);
    // 正向前提:手算结果确实覆盖了各个分支(断言不会静默变空)
    expect(want.unknown).toBe(2);
    expect(want.perKey[KA]?.signals_total).toBe(7);
    expect(Object.keys(want.perKey[KA]?.signals_by_day ?? {}).sort()).toEqual([
      '2026-10-19',
      '2026-10-26',
    ]);
    expect(want.perKey[KC]).toEqual({ signals_total: 0, sessions: 1, signals_by_day: {} });
    expect(r.stagedTainted.size).toBe(0);
  });

  it('空库 / 目录不存在:空结果,不报错', async () => {
    const f = await makeL0Fx('cc-empty-');
    const r = await recomputeCounts(f.io, f.config, NOW);
    expect(r).toEqual({ perKey: {}, unknownKeysSignals: 0, stagedTainted: new Map() });
  });

  it('now 换日后窗口跟着走:10-27 的窗口 = 10-20..10-27(10-19 出窗口,10-27 的未来日进窗口)', async () => {
    const f = await makeL0Fx('cc-window-');
    await mixed(f);
    const r = await recomputeCounts(f.io, f.config, new Date('2026-10-27T12:00:00.000Z'));
    expect(Object.keys(r.perKey[KA]?.signals_by_day ?? {})).toEqual(['2026-10-26', '2026-10-27']);
    expect(r.perKey[KA]?.signals_total).toBe(7);
  });

  it('不是增量:`counts.json` 里陈旧的数字(别的数、别的 key、unknown)不被沿用', async () => {
    const f = await makeL0Fx('cc-stale-');
    const m = await mixed(f);
    await seed(f, {
      counts: countsOf(
        {
          [KA]: { total: 999, sessions: 999, byDay: { '2026-10-26': 999 } },
          [key(9)]: { total: 5 },
        },
        { unknown: 77 },
      ),
    });
    const r = await recomputeCounts(f.io, f.config, NOW);
    const want = handCount(m);
    expect(r.perKey).toEqual(want.perKey);
    expect(r.perKey[key(9)]).toBeUndefined();
    expect(r.unknownKeysSignals).toBe(want.unknown);
  });

  it('提交点之后崩溃再重跑:同一批信号 / 会话计数再写一遍全部去重(新增为 0),重算结果与第一次完全相同', async () => {
    const f = await makeL0Fx('cc-redo-');
    await mixed(f);
    const first = await recomputeCounts(f.io, f.config, NOW);
    // 重读:信号库按 sig_id 去重、会话计数按 session_ref upsert
    const again = await writeSignals(f.io, 'claude', [sig(1, KA, '2026-10-26T01:00:00.000Z')]);
    expect([again.written, again.deduplicated]).toEqual([0, 1]);
    const again2 = await writeSessionStats(f.io, 'claude', [stat(1, KA)]);
    expect([again2.written, again2.updated, again2.unchanged]).toEqual([0, 0, 1]);
    const second = await recomputeCounts(f.io, f.config, NOW);
    expect(second).toEqual(first);
    // 对照:真新增一条,结果确实变(重算不是常量)
    await writeSignals(f.io, 'claude', [sig(99, KB, '2026-10-26T02:00:00.000Z')]);
    const third = await recomputeCounts(f.io, f.config, NOW);
    expect(third.perKey[KB]?.signals_total).toBe((first.perKey[KB]?.signals_total ?? 0) + 1);
  });
});

describe('recomputeCounts:signals_by_day 窗口', () => {
  it('窗口必须覆盖 8 个 UTC 日(契约 R20-4.5;读侧 last7Days 只取其中 7 日,不得把窗口改成 7)', async () => {
    const f = await makeL0Fx('cc-win8-');
    const days = WINDOW; // 10-19..10-26
    expect(days).toHaveLength(8);
    await writeSignals(
      f.io,
      'claude',
      days.map((d, i) => sig(100 + i, KA, `${d}T06:00:00.000Z`)),
    );
    const r = await recomputeCounts(f.io, f.config, NOW);
    expect(Object.keys(r.perKey[KA]?.signals_by_day ?? {}).sort()).toEqual(days);
  });
});

describe('recomputeCounts:staged.tainted 每次按 TAINTED 的实际存在情况核实', () => {
  const stagedItem = (run: string, tainted: boolean): Record<string, unknown> => ({
    run_id: run,
    proposals: 1,
    evidence_keys: [KA],
    tainted,
  });

  it('记录与事实不一致时以事实为准(记录说 true 但没有 TAINTED → false;记录说 false 但有 → true);只有 TAINTED 的 run 才是 true', async () => {
    const f = await makeL0Fx('cc-taint-');
    await seed(f, {
      counts: countsOf(
        {},
        {
          staged: [
            stagedItem('run-a', true), // 记录 true、无 reflect 目录
            stagedItem('run-b', false), // 记录 false、有 TAINTED
            stagedItem('run-c', false), // 有目录无 TAINTED
            stagedItem('run-d', true), // 记录 true、有 TAINTED
          ] as never,
        },
      ),
      tainted: { 'run-b': '{"reason":"exclude"}', 'run-d': '{"reason":"purge"}' },
    });
    await mkdirp(f.io, path.join(f.io.stateDir, 'reflect', 'run-c'), 0o755);
    const r = await recomputeCounts(f.io, f.config, NOW);
    expect([...r.stagedTainted]).toEqual([
      ['run-a', false],
      ['run-b', true],
      ['run-c', false],
      ['run-d', true],
    ]);
  });

  it('补完 taint 之后没有任何「新增」也照样校正:同一份 counts.json,TAINTED 出现 / 消失,下一次重算跟着变', async () => {
    const f = await makeL0Fx('cc-taint-flip-');
    await seed(f, { counts: countsOf({}, { staged: [stagedItem('run-x', false)] as never }) });
    const dir = path.join(f.io.stateDir, 'reflect', 'run-x');
    expect((await recomputeCounts(f.io, f.config, NOW)).stagedTainted.get('run-x')).toBe(false);
    await mkdirp(f.io, dir, 0o755);
    await writeFile(f.io, path.join(dir, 'TAINTED'), '{"reason":"exclude"}', { mode: 0o600 });
    expect((await recomputeCounts(f.io, f.config, NOW)).stagedTainted.get('run-x')).toBe(true);
    // 再算一次(没有新增 taint):仍是 true
    expect((await recomputeCounts(f.io, f.config, NOW)).stagedTainted.get('run-x')).toBe(true);
  });

  it('TAINTED 不是普通文件(目录 / 符号链接)也按在场算(宁可当成被污染);reflect/<run> 是符号链接 → fail-closed state_dir_unsafe', async () => {
    const f = await makeL0Fx('cc-taint-odd-');
    await seed(f, {
      counts: countsOf(
        {},
        { staged: [stagedItem('run-dir', false), stagedItem('run-ln', false)] as never },
      ),
    });
    const base = path.join(f.io.stateDir, 'reflect');
    await mkdirp(f.io, path.join(base, 'run-dir', 'TAINTED'), 0o755);
    const r = await recomputeCounts(f.io, f.config, NOW);
    expect(r.stagedTainted.get('run-dir')).toBe(true);
    // run-ln:真实目录的对照已在上面;现在把它换成链接
    await mkdirp(f.fx, path.join(f.dir, 'elsewhere'), 0o755);
    await symlink(f.fx, path.join(f.dir, 'elsewhere'), path.join(base, 'run-ln'));
    await expect(recomputeCounts(f.io, f.config, NOW)).rejects.toMatchObject({
      code: 'RSI_FAIL_CLOSED',
      reason: 'state_dir_unsafe',
    });
  });

  it('reflect/ 本身是符号链接 → state_dir_unsafe(父目录链只核对一次也照样 fail-closed);缺失 → 全部不在场', async () => {
    const f = await makeL0Fx('cc-taint-reflect-');
    await seed(f, {
      counts: countsOf(
        {},
        { staged: [stagedItem('run-a', false), stagedItem('run-b', false)] as never },
      ),
    });
    const base = path.join(f.io.stateDir, 'reflect');
    expect([...(await recomputeCounts(f.io, f.config, NOW)).stagedTainted.values()]).toEqual([
      false,
      false,
    ]);
    await mkdirp(f.fx, path.join(f.dir, 'elsewhere2'), 0o755);
    await symlink(f.fx, path.join(f.dir, 'elsewhere2'), base);
    await expect(recomputeCounts(f.io, f.config, NOW)).rejects.toMatchObject({
      reason: 'state_dir_unsafe',
    });
  });

  it('counts.json 缺失 → staged 为空;损坏 → counts_invalid', async () => {
    const f = await makeL0Fx('cc-taint-bad-');
    expect((await recomputeCounts(f.io, f.config, NOW)).stagedTainted.size).toBe(0);
    await seed(f, { raw: { 'counts.json': '{"not":"counts"}' } });
    await expect(recomputeCounts(f.io, f.config, NOW)).rejects.toMatchObject({
      code: 'RSI_FAIL_CLOSED',
      reason: 'counts_invalid',
    });
  });

  it('staged.run_id 含路径穿越(../x)→ counts_invalid,不会去 lstat 状态目录之外的路径', async () => {
    const f = await makeL0Fx('cc-taint-trav-');
    const base = countsOf({}) as Record<string, unknown>;
    const doc = {
      ...base,
      staged: [{ run_id: '../x', proposals: 1, evidence_keys: [], tainted: false }],
    };
    await seed(f, { raw: { 'counts.json': JSON.stringify(doc) } });
    await expect(recomputeCounts(f.io, f.config, NOW)).rejects.toMatchObject({
      reason: 'counts_invalid',
    });
    // 对照:合法 run_id 的同形文件通过
    const ok = {
      ...base,
      staged: [{ run_id: 'x', proposals: 1, evidence_keys: [], tainted: false }],
    };
    await seed(f, { raw: { 'counts.json': JSON.stringify(ok) } });
    expect((await recomputeCounts(f.io, f.config, NOW)).stagedTainted.get('x')).toBe(false);
  });
});

describe('recomputeCounts:库带病 fail-closed(signal_store_corrupt),不任选一条、不跳过', () => {
  const sigDir = (f: L0Fx, agent = 'claude'): string => path.join(f.io.stateDir, 'signals', agent);
  const bad = async (p: Promise<unknown>): Promise<void> => {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RsiSnapshotError);
    expect((err as RsiSnapshotError).reason).toBe('signal_store_corrupt');
  };

  it('正向对照:同一个库不带病 → 正常', async () => {
    const f = await makeL0Fx('cc-ok-');
    await mixed(f);
    await expect(recomputeCounts(f.io, f.config, NOW)).resolves.toBeDefined();
  });

  it('同一月文件内重复 sig_id → corrupt;跨月文件的同一 sig_id 不判重(与写入方的去重范围一致);正向对照', async () => {
    const f = await makeL0Fx('cc-dupsig-');
    const line = JSON.stringify(signalObj(hex16(1), KA));
    await mkdirp(f.io, sigDir(f), 0o700);
    await writeFile(f.io, path.join(sigDir(f), '202610.jsonl'), `${line}\n`, { mode: 0o600 });
    await writeFile(f.io, path.join(sigDir(f), '202609.jsonl'), `${line}\n`, { mode: 0o600 });
    expect((await recomputeCounts(f.io, f.config, NOW)).perKey[KA]?.signals_total).toBe(2);
    await writeFile(f.io, path.join(sigDir(f), '202610.jsonl'), `${line}\n${line}\n`, {
      mode: 0o600,
    });
    await bad(recomputeCounts(f.io, f.config, NOW));
  });

  it('坏行 / 缺 sig_id / 缺 project_key / 非法时间戳 / 空行 / 缺尾换行 → corrupt', async () => {
    const lines: Record<string, string> = {
      坏JSON: 'not json\n',
      缺sig_id: `${JSON.stringify({ project_key: KA, ts: '2026-10-26T00:00:00.000Z' })}\n`,
      缺project_key: `${JSON.stringify({ sig_id: 'sig_1', ts: '2026-10-26T00:00:00.000Z' })}\n`,
      非法时间戳: `${JSON.stringify({ sig_id: 'sig_1', project_key: KA, ts: 'yesterday' })}\n`,
      空行: `${JSON.stringify(signalObj(hex16(1), KA))}\n\n`,
      缺尾换行: JSON.stringify(signalObj(hex16(1), KA)),
    };
    for (const [name, body] of Object.entries(lines)) {
      const f = await makeL0Fx('cc-badline-');
      await mkdirp(f.io, sigDir(f), 0o700);
      await writeFile(f.io, path.join(sigDir(f), '202610.jsonl'), body, { mode: 0o600 });
      const err = await recomputeCounts(f.io, f.config, NOW).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, name).toBeInstanceOf(RsiSnapshotError);
      expect((err as RsiSnapshotError).reason, name).toBe('signal_store_corrupt');
    }
  });

  it('月文件是符号链接 / 硬链接、signals/<agent> 是符号链接 → corrupt;名字不像月文件的(.tmp / 别的)被忽略', async () => {
    const f1 = await makeL0Fx('cc-ln-');
    await mixed(f1);
    await mkdirp(f1.fx, path.join(f1.dir, 'x'), 0o755);
    await writeFile(f1.fx, path.join(f1.dir, 'x', 'real.jsonl'), '', { mode: 0o600 });
    await symlink(
      f1.fx,
      path.join(f1.dir, 'x', 'real.jsonl'),
      path.join(sigDir(f1), '209901.jsonl'),
    );
    await bad(recomputeCounts(f1.io, f1.config, NOW));

    const f2 = await makeL0Fx('cc-hl-');
    await mixed(f2);
    await mkdirp(f2.fx, path.join(f2.dir, 'x'), 0o755);
    await hardlink(f2.fx, path.join(sigDir(f2), '202610.jsonl'), path.join(f2.dir, 'x', 'h.jsonl'));
    await bad(recomputeCounts(f2.io, f2.config, NOW));

    const f3 = await makeL0Fx('cc-dirln-');
    await mixed(f3);
    await mkdirp(f3.fx, path.join(f3.dir, 'x'), 0o755);
    await symlink(f3.fx, path.join(f3.dir, 'x'), path.join(f3.io.stateDir, 'signals', 'codex'));
    await bad(recomputeCounts(f3.io, f3.config, NOW));

    const f4 = await makeL0Fx('cc-ignored-');
    const m = await mixed(f4);
    await writeFile(f4.io, path.join(sigDir(f4), '202610.jsonl.tmp'), 'garbage', { mode: 0o600 });
    await writeFile(f4.io, path.join(sigDir(f4), 'notes.jsonl'), 'garbage', { mode: 0o600 });
    expect((await recomputeCounts(f4.io, f4.config, NOW)).perKey).toEqual(handCount(m).perKey);
  });

  it('会话计数库:重复 session_ref / 缺字段 → corrupt', async () => {
    const f = await makeL0Fx('cc-sess-');
    const dir = path.join(f.io.stateDir, 'sessions', 'claude');
    await mkdirp(f.io, dir, 0o700);
    const row = JSON.stringify({ session_ref: `s_${hex16(1)}`, project_key: KA });
    await writeFile(f.io, path.join(dir, '202610.jsonl'), `${row}\n`, { mode: 0o600 });
    expect((await recomputeCounts(f.io, f.config, NOW)).perKey[KA]?.sessions).toBe(1);
    await writeFile(f.io, path.join(dir, '202610.jsonl'), `${row}\n${row}\n`, { mode: 0o600 });
    await bad(recomputeCounts(f.io, f.config, NOW));
    // 唯一性按 agent 目录各自算(与写入方一致):同一 session_ref 出现在另一个 agent 目录 → 不算重复
    await writeFile(f.io, path.join(dir, '202610.jsonl'), `${row}\n`, { mode: 0o600 });
    const other = path.join(f.io.stateDir, 'sessions', 'codex');
    await mkdirp(f.io, other, 0o700);
    await writeFile(f.io, path.join(other, '202610.jsonl'), `${row}\n`, { mode: 0o600 });
    expect((await recomputeCounts(f.io, f.config, NOW)).perKey[KA]?.sessions).toBe(2);
    await writeFile(f.io, path.join(dir, '202610.jsonl'), `${row}\n${row}\n`, { mode: 0o600 });
    await writeFile(
      f.io,
      path.join(dir, '202610.jsonl'),
      `${JSON.stringify({ project_key: KA })}\n`,
      {
        mode: 0o600,
      },
    );
    await bad(recomputeCounts(f.io, f.config, NOW));
  });
});

describe('recomputeCounts:规划侧零写入(三层之二;之一见 l0-closure)', () => {
  it('写审计 0 次;目录树前后一致;正向对照:读了真实数据,且同一审计钩子下的写入会被记到', async () => {
    const f = await makeL0Fx('cc-zw-');
    await mixed(f);
    await seed(f, {
      counts: countsOf(
        {},
        {
          staged: [{ run_id: 'run-a', proposals: 1, evidence_keys: [KA], tainted: false }] as never,
        },
      ),
    });
    const audit = withWriteAudit();
    const io = createRsiIoContext({ repo: f.repo, env: f.env, cwd: f.dir, writeAudit: audit.hook });
    const before = await treeOf(f.dir);
    const r = await recomputeCounts(io, f.config, NOW);
    expect(r.perKey[KA]?.signals_total).toBe(7); // 正向前提:确实读了库
    expect(r.stagedTainted.has('run-a')).toBe(true);
    expect(audit.calls).toEqual([]);
    expect(await treeOf(f.dir)).toEqual(before);
    expect(await exists(path.join(io.stateDir, 'salt'))).toBe(false);
    await writeFile(io, path.join(f.dir, 'tmp', 'probe'), 'x');
    expect(audit.calls.map((c) => c.op)).toEqual(['writeFile']);
  });
});
