/**
 * R20-A2 B4b:读阶段 `collectRead`(R20-6.7 / 6.8 / 6.9、R21-1.7)。真实 reader + 真实 pipeline + 假 HOME;读阶段零写入。
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TraceReader } from '../../src/contracts/reader.js';
import type { RsiAgentId, RsiCursor } from '../../src/contracts/rsi.js';
import { stat } from '../../src/io/read-fs.js';
import { mkdirp, writeFile } from '../../src/io/safe-fs.js';
import { createRedactor } from '../../src/redact/index.js';
import { sessionRefFor, sigIdFor } from '../../src/signals/ids.js';
import { processSession } from '../../src/signals/pipeline.js';
import { collectRead, isIncomplete, type CollectReadInput } from '../../src/rsi/l0/collect-read.js';
import { enumerateSessionFiles } from '../../src/rsi/l0/enumerate.js';
import { createRsiCollectPolicy } from '../../src/rsi/l0/collect-policy.js';
import { cursorFingerprint } from '../../src/rsi/l0/fingerprint.js';
import { buildRsiPolicy } from '../../src/rsi/config.js';
import type { Checkpoint, CheckpointVerdict, CollectBatch } from '../../src/rsi/l0/types.js';
import { createClaudeReader } from '../../src/readers/claude/index.js';
import { withWriteAudit } from '../helpers/write-audit.js';
import { claudeLine, jl, makeL0Fx, put, rootOf, uuid, type L0Fx } from './l0-fixture.js';
import { treeOf } from './rsi-fixture.js';
import { setExtra } from './ro-fixture.js';

const SALT = 'c3'.repeat(32);
const NOW = '2026-10-24T08:00:00.000Z';
const CONT: CheckpointVerdict = { kind: 'continue' };
const go: Checkpoint = async () => CONT;
const redactor = createRedactor({ timeout_ms: 5000 });

async function proj(f: L0Fx, name: string): Promise<string> {
  const p = path.join(f.dir, 'work', name);
  await mkdirp(f.fx, p, 0o755);
  return p;
}

interface Run {
  batch: CollectBatch;
  input: CollectReadInput;
}
async function run(
  f: L0Fx,
  over: Partial<CollectReadInput> = {},
  prev: RsiCursor | null = null,
  fingerprint = 'f'.repeat(64),
): Promise<Run> {
  const enumeration = await enumerateSessionFiles(f.home, f.config, false);
  const input: CollectReadInput = {
    enumeration,
    prevCursor: prev,
    fingerprint,
    salt: SALT,
    nowIso: NOW,
    policy: await createRsiCollectPolicy(f.config, f.io.stateDir),
    redactor,
    checkpoint: go,
    ...over,
  };
  return { batch: await collectRead(input), input };
}

const goodSession = (cwd: string): string => jl(claudeLine(cwd), claudeLine(cwd));

describe('读阶段:基本形态与冻结映射', () => {
  it('processed → ok(complete);映射、结果、观测、cursorNext 一致;零写入', async () => {
    const f = await makeL0Fx('cr-basic-');
    const a = await proj(f, 'alpha');
    await put(f, 'claude', `p/${uuid(1)}.jsonl`, goodSession(a));
    const before = await treeOf(f.dir);
    const audit = withWriteAudit();
    const { batch } = await run(f);
    expect(audit.calls).toEqual([]);
    expect(await treeOf(f.dir)).toEqual(before);
    expect(batch.outcomes).toHaveLength(1);
    const o = batch.outcomes[0];
    expect(o).toMatchObject({ status: 'ok', complete: true, projectRoot: await realOf(a) });
    expect(o?.projectKey).toMatch(/^p_[0-9a-f]{16}$/);
    expect(batch.results.get('claude')).toHaveLength(1);
    expect(batch.results.get('claude')?.[0]?.signals.length).toBe(2);
    expect(batch.observations).toEqual([
      expect.objectContaining({ key: o?.projectKey, path: await realOf(a) }),
    ]);
    const st = await stat(await realOf(a));
    expect(batch.observations[0]).toMatchObject({ dev: st.dev, ino: st.ino });
    expect(batch.summary).toMatchObject({
      outcome: 'ok',
      files_planned: 1,
      files_read: 1,
      limits_hit: [],
      projects: null,
      signals_new: null,
      sessions_new: null,
      unknown_signals: null,
      cursor: { fingerprint_match: null, full_scan: { epoch: 1, done: true } },
    });
    expect(batch.enumerationComplete).toBe(true);
    const ref = sessionRefFor(SALT, o?.file.path as string);
    expect(batch.cursorNext.files[ref]).toMatchObject({ status: 'ok', epoch: 1 });
    expect(batch.verdict).toEqual(CONT);
  });

  it('完整性:oversized / <malformed> / <line-too-deep> 都算不完整,status 仍是 ok;干净的会话 complete=true(正向对照)', async () => {
    const f = await makeL0Fx('cr-incomplete-');
    const a = await proj(f, 'alpha');
    await put(f, 'claude', `p/${uuid(1)}.jsonl`, goodSession(a));
    await put(f, 'claude', `p/${uuid(2)}.jsonl`, `${goodSession(a)}{not json\n`);
    const deep = `${'['.repeat(300)}${']'.repeat(300)}`;
    await put(f, 'claude', `p/${uuid(3)}.jsonl`, `${goodSession(a)}${deep}\n`);
    const { batch } = await run(f);
    const by = new Map(batch.outcomes.map((o) => [path.basename(o.file.path), o]));
    expect(by.get(`${uuid(1)}.jsonl`)).toMatchObject({ status: 'ok', complete: true });
    expect(by.get(`${uuid(2)}.jsonl`)).toMatchObject({ status: 'ok', complete: false });
    expect(by.get(`${uuid(3)}.jsonl`)).toMatchObject({ status: 'ok', complete: false });
    expect(batch.summary.limits_hit).toEqual(['RSI_LIMIT_DEPTH']);
    expect(batch.summary.outcome).toBe('ok_partial');
    const results = [...batch.results.get('claude')!];
    expect(results.map(isIncomplete).sort()).toEqual([false, true, true]);
  });

  it('排除 / 自我排除 / 相对 cwd / 无 cwd → excluded / self_state / unknown_project(索引为空也生效)', async () => {
    const f = await makeL0Fx('cr-excl-');
    const bad = await proj(f, 'secret-proj');
    const ok = await proj(f, 'fine');
    await setExtra(f, `exclude_dirs = [${JSON.stringify(bad)}]\n`);
    const cfg = (await import('../../src/rsi/config.js')).loadRsiConfig;
    const c = await cfg({ env: f.env });
    if (c.status !== 'on') throw new Error('off');
    f.config = c;
    await put(f, 'claude', `p/${uuid(1)}.jsonl`, goodSession(bad));
    await put(f, 'claude', `p/${uuid(2)}.jsonl`, goodSession(ok));
    await put(
      f,
      'claude',
      `p/${uuid(3)}.jsonl`,
      goodSession(path.join(f.io.stateDir, 'reflect', 'cwd')),
    );
    await put(f, 'claude', `p/${uuid(4)}.jsonl`, goodSession('relative/x'));
    await put(f, 'claude', `p/${uuid(5)}.jsonl`, jl({ type: 'mode' }));
    const { batch } = await run(f);
    const st = (n: number): string | undefined =>
      batch.outcomes.find((o) => path.basename(o.file.path) === `${uuid(n)}.jsonl`)?.status;
    expect([1, 2, 3, 4, 5].map(st)).toEqual([
      'excluded',
      'ok',
      'self_state',
      'unknown_project',
      'unknown_project',
    ]);
    expect(batch.summary.skipped).toMatchObject({ excluded: 1, self_state: 1, unknown_project: 2 });
    // 被排除的会话没有信号
    const sigs = [...batch.results.values()].flat().flatMap((r) => r.signals);
    expect(sigs.length).toBe(2);
  });

  it('pi:首行不是 session → 不读正文直接 unknown_project(reader 未被调用,正向对照:session 首行照读)', async () => {
    const f = await makeL0Fx('cr-pi-');
    const a = await proj(f, 'alpha');
    await put(f, 'pi', '--x--/a.jsonl', jl({ type: 'message', cwd: a }));
    await put(
      f,
      'pi',
      '--x--/b.jsonl',
      jl({ type: 'session', cwd: a }, { type: 'message', id: 'm' }),
    );
    const calls: string[] = [];
    const spy: TraceReader = {
      agent: 'pi',
      discover: async () => [],
      read: (ref, o) => {
        calls.push(path.basename(ref.path));
        void o;
        throw new Error('stop');
      },
    };
    const { batch } = await run(f, { readers: { pi: spy } });
    expect(calls).toEqual(['b.jsonl']);
    const st = (n: string): string | undefined =>
      batch.outcomes.find((o) => path.basename(o.file.path) === n)?.status;
    expect(st('a.jsonl')).toBe('unknown_project');
    expect(st('b.jsonl')).toBe('read_error');
  });
});

async function realOf(p: string): Promise<string> {
  const { realpath } = await import('../../src/io/read-fs.js');
  return realpath(p);
}

describe('检查点:行级钩子在没有事件的读取窗口里也能触发', () => {
  /** 3500 个空白行 + 一行有效内容:读取期间不产生任何事件 */
  const blanky = (cwd: string): string =>
    `${' \n'.repeat(3500)}${JSON.stringify(claudeLine(cwd))}\n`;

  it('STOP 在第 2 次 lines 检查点生效:当前文件整份丢弃、不写 cursor 条目、返回 abort', async () => {
    const f = await makeL0Fx('cr-stop-');
    const a = await proj(f, 'alpha');
    await put(f, 'claude', `p/${uuid(1)}.jsonl`, blanky(a));
    const seen: string[] = [];
    let linesCalls = 0;
    const cp: Checkpoint = async (where) => {
      seen.push(where);
      if (where === 'lines' && ++linesCalls === 2) return { kind: 'abort', outcome: 'stopped' };
      return CONT;
    };
    const { batch } = await run(f, { checkpoint: cp });
    expect(batch.verdict).toEqual({ kind: 'abort', outcome: 'stopped' });
    expect(batch.summary.outcome).toBe('stopped');
    expect(seen.filter((w) => w === 'lines')).toHaveLength(2);
    expect(batch.outcomes).toEqual([]);
    expect(Object.keys(batch.cursorNext.files)).toEqual([]);
    expect(batch.results.size).toBe(0);
    // 正向对照:不 abort 时同一文件读得完整
    const ok = await run(f, { checkpoint: go });
    expect(ok.batch.outcomes).toHaveLength(1);
    expect(ok.batch.outcomes[0]?.status).toBe('ok');
  });

  it('收紧排除(binding 变化)与墙钟在行检查点上同样触发', async () => {
    const f = await makeL0Fx('cr-bind-');
    const a = await proj(f, 'alpha');
    await put(f, 'claude', `p/${uuid(1)}.jsonl`, blanky(a));
    for (const verdict of [
      { kind: 'abort', outcome: 'skipped_binding_changed' },
      { kind: 'time_limit' },
    ] as CheckpointVerdict[]) {
      let n = 0;
      const { batch } = await run(f, {
        checkpoint: async (where) => (where === 'lines' && ++n === 1 ? verdict : CONT),
      });
      expect(batch.verdict).toEqual(verdict);
      expect(batch.outcomes).toEqual([]);
      if (verdict.kind === 'time_limit') {
        expect(batch.summary.limits_hit).toContain('RSI_LIMIT_TIME');
        expect(batch.summary.outcome).toBe('ok_partial');
      } else {
        expect(batch.summary.outcome).toBe('skipped_binding_changed');
      }
    }
  });

  it('文件边界检查点:第 2 个文件前 time_limit → 第 1 个已读的保留,其余未读且不写条目', async () => {
    const f = await makeL0Fx('cr-file-cp-');
    const a = await proj(f, 'alpha');
    for (const n of [1, 2, 3]) await put(f, 'claude', `p/${uuid(n)}.jsonl`, goodSession(a));
    let files = 0;
    const { batch } = await run(f, {
      checkpoint: async (where) =>
        where === 'file' && ++files === 2 ? { kind: 'time_limit' } : CONT,
    });
    expect(batch.outcomes).toHaveLength(1);
    expect(batch.summary).toMatchObject({ files_planned: 3, files_read: 1, outcome: 'ok_partial' });
    expect(batch.cursorNext.full_scan.done).toBe(false);
  });
});

describe('字节计量与预算', () => {
  it('实际字节含预扫:没有时间戳的文件预扫读全文,实际字节 ≥ 2 倍文件大小', async () => {
    const f = await makeL0Fx('cr-bytes-');
    const a = await proj(f, 'alpha');
    const body = jl(...Array.from({ length: 50 }, () => claudeLine(a)));
    const p = await put(f, 'claude', `p/${uuid(1)}.jsonl`, body);
    const size = (await stat(p)).size;
    const { batch } = await run(f);
    expect(batch.bytesActual).toBeGreaterThanOrEqual(2 * size);
    expect(batch.bytesActual).toBeLessThan(2 * size + 64);
    expect(batch.summary.bytes_read).toBe(batch.bytesActual);
  });

  it('单文件实际字节超限(lstat 没超)→ too_large,当前文件结果丢弃;lstat 超限的文件不读也记 too_large', async () => {
    const f = await makeL0Fx('cr-toolarge-');
    const a = await proj(f, 'alpha');
    const mid = await put(
      f,
      'claude',
      `p/${uuid(1)}.jsonl`,
      jl(...Array.from({ length: 20 }, () => claudeLine(a))),
    );
    const size = (await stat(mid)).size;
    await put(
      f,
      'claude',
      `p/${uuid(2)}.jsonl`,
      jl(...Array.from({ length: 200 }, () => claudeLine(a))),
    );
    const { batch } = await run(f, { limits: { maxFileBytes: size + 10 } });
    const st = (n: number): string | undefined =>
      batch.outcomes.find((o) => path.basename(o.file.path) === `${uuid(n)}.jsonl`)?.status;
    expect(st(1)).toBe('too_large'); // 预扫 + 正文 > 上限
    expect(st(2)).toBe('too_large'); // lstat 就超
    expect(batch.summary.skipped.too_large).toBe(2);
    expect(batch.summary.limits_hit).toEqual(['RSI_FILE_TOO_LARGE']);
    expect(batch.summary.outcome).toBe('ok'); // 只有 too_large 不算 ok_partial
    expect([...batch.results.values()].flat()).toHaveLength(0);
  });

  it('累计实际字节到上限:读完当前文件后停止,其余未读(RSI_LIMIT_BYTES);最后一个文件到线不报', async () => {
    const f = await makeL0Fx('cr-tickbytes-');
    const a = await proj(f, 'alpha');
    for (const n of [1, 2, 3]) await put(f, 'claude', `p/${uuid(n)}.jsonl`, goodSession(a));
    const { batch } = await run(f, { limits: { maxBytes: 1 } });
    expect(batch.summary).toMatchObject({ files_planned: 3, files_read: 1, outcome: 'ok_partial' });
    expect(batch.summary.limits_hit).toEqual(['RSI_LIMIT_BYTES']);
    const one = await makeL0Fx('cr-tickbytes1-');
    await put(one, 'claude', `p/${uuid(1)}.jsonl`, goodSession(await proj(one, 'a')));
    const r = await run(one, { limits: { maxBytes: 1 } });
    expect(r.batch.summary.limits_hit).toEqual([]);
  });

  it('文件名额:超出的延后,RSI_LIMIT_FILES,done 不到', async () => {
    const f = await makeL0Fx('cr-files-');
    const a = await proj(f, 'alpha');
    for (const n of [1, 2, 3]) await put(f, 'claude', `p/${uuid(n)}.jsonl`, goodSession(a));
    const { batch } = await run(f, { limits: { maxFiles: 2 } });
    expect(batch.summary).toMatchObject({ files_planned: 2, files_read: 2, outcome: 'ok_partial' });
    expect(batch.summary.limits_hit).toEqual(['RSI_LIMIT_FILES']);
    expect(batch.cursorNext.full_scan.done).toBe(false);
  });
});

describe('cursor:epoch 续跑、指纹变化重扫、4001 文件覆盖', () => {
  it('同指纹第二次不读(unchanged);指纹变化 → epoch+1 全部重读;文件变化只读变化的', async () => {
    const f = await makeL0Fx('cr-epoch-');
    const a = await proj(f, 'alpha');
    const p1 = await put(f, 'claude', `p/${uuid(1)}.jsonl`, goodSession(a));
    await put(f, 'claude', `p/${uuid(2)}.jsonl`, goodSession(a));
    const r1 = await run(f);
    expect(r1.batch.summary.files_read).toBe(2);
    const c1 = r1.batch.cursorNext;
    expect(c1.full_scan).toMatchObject({ epoch: 1, done: true });
    const r2 = await run(f, {}, c1);
    expect(r2.batch.summary).toMatchObject({
      files_read: 0,
      skipped: expect.objectContaining({ unchanged: 2 }),
      cursor: { fingerprint_match: true, full_scan: { epoch: 1, done: true } },
    });
    await writeFile(f.fx, p1, `${goodSession(a)}${JSON.stringify(claudeLine(a))}\n`, {
      mode: 0o600,
    });
    const r3 = await run(f, {}, r2.batch.cursorNext);
    expect(r3.batch.summary.files_read).toBe(1);
    const r4 = await run(f, {}, r3.batch.cursorNext, 'e'.repeat(64));
    expect(r4.batch.summary).toMatchObject({
      files_read: 2,
      cursor: { fingerprint_match: false, full_scan: { epoch: 2, done: true } },
    });
    expect(Object.values(r4.batch.cursorNext.files).every((e) => e.epoch === 2)).toBe(true);
  });

  it('4001 个文件:三次提交(2000 / 2000 / 1)后 done,每个文件在这个 epoch 只读一次', async () => {
    const f = await makeL0Fx('cr-4001-');
    const a = await proj(f, 'alpha');
    for (let n = 1; n <= 4001; n++) {
      await put(f, 'claude', `p/${uuid(n)}.jsonl`, jl(claudeLine(a)));
    }
    let cursor: RsiCursor | null = null;
    const reads: number[] = [];
    const seen = new Map<string, number>();
    for (let tick = 0; tick < 3; tick++) {
      const r: Run = await run(f, {}, cursor);
      reads.push(r.batch.summary.files_read);
      for (const o of r.batch.outcomes) seen.set(o.sessionRef, (seen.get(o.sessionRef) ?? 0) + 1);
      cursor = r.batch.cursorNext;
      if (tick < 2) expect(cursor.full_scan.done).toBe(false);
    }
    expect(reads).toEqual([2000, 2000, 1]);
    expect(cursor?.full_scan).toMatchObject({ epoch: 1, done: true });
    expect(seen.size).toBe(4001);
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
    const r4 = await run(f, {}, cursor);
    expect(r4.batch.summary.files_read).toBe(0);
  }, 120_000);
});

describe('sig_id 稳定与「不传钩子逐字节不变」', () => {
  const fixture = (cwd: string): string =>
    jl(claudeLine(cwd), { type: 'mystery-event-x' }, claudeLine(cwd), claudeLine(cwd));

  it('同一夹具:sig_id 集合 = sigIdFor(salt, ref, 事件序号),事件序号含不产信号的事件(偏移回归)', async () => {
    const f = await makeL0Fx('cr-sigid-');
    const a = await proj(f, 'alpha');
    const p = await put(f, 'claude', `p/${uuid(1)}.jsonl`, fixture(a));
    const { batch } = await run(f);
    const sigs = batch.results.get('claude')?.[0]?.signals ?? [];
    const ref = sessionRefFor(SALT, p);
    expect(sigs.map((s) => s.event_index)).toEqual([0, 2, 3]);
    expect(new Set(sigs.map((s) => s.sig_id))).toEqual(
      new Set([0, 2, 3].map((i) => sigIdFor(SALT, ref, i))),
    );
    // 同版本重读:同一集合
    const again = await run(f);
    const sigs2 = again.batch.results.get('claude')?.[0]?.signals ?? [];
    expect(sigs2.map((s) => s.sig_id)).toEqual(sigs.map((s) => s.sig_id));
  });

  it('带钩子与不带钩子读同一文件:结果逐字段相同(含信号、计数、元数据)', async () => {
    const f = await makeL0Fx('cr-nohook-');
    const a = await proj(f, 'alpha');
    const p = await put(f, 'claude', `p/${uuid(1)}.jsonl`, `${fixture(a)}{bad\n\n`);
    const reader = createClaudeReader();
    const policy = await createRsiCollectPolicy(f.config, f.io.stateDir);
    const ref = {
      agent: 'claude' as RsiAgentId,
      path: p,
      session_ref: sessionRefFor(SALT, p),
      bytes: 1,
    };
    const deps = {
      redactor,
      policy,
      salt: SALT,
      fallbackVersion: undefined,
      maxEventBytes: undefined,
    };
    const plain = await processSession(reader, ref, deps);
    const run2 = async (
      every?: number,
    ): Promise<{ r: unknown; calls: [number, number, boolean][] }> => {
      const calls: [number, number, boolean][] = [];
      const hooked: TraceReader = {
        agent: 'claude',
        discover: (s) => reader.discover(s),
        read: (r, o) =>
          reader.read(r, {
            ...o,
            onLines: async (l, b, d) => {
              calls.push([l, b, d]);
            },
            ...(every !== undefined ? { onLinesEvery: every } : {}),
          }),
      };
      return { r: await processSession(hooked, ref, deps), calls };
    };
    const dflt = await run2();
    expect(dflt.r).toEqual(plain);
    // 默认间隔下行数 / 字节都没到:只有读完的那一次 done=true,携带完整累计
    expect(dflt.calls).toHaveLength(1);
    expect(dflt.calls[0]?.[2]).toBe(true);
    const fine = await run2(1);
    expect(fine.r).toEqual(plain);
    expect(fine.calls.length).toBeGreaterThan(1);
    expect(fine.calls.at(-1)?.[0]).toBe(dflt.calls[0]?.[0]);
    expect(fine.calls.at(-1)?.[1]).toBe(dflt.calls[0]?.[1]);
    for (let i = 1; i < fine.calls.length; i++) {
      expect((fine.calls[i] as [number, number, boolean])[0]).toBeGreaterThan(
        (fine.calls[i - 1] as [number, number, boolean])[0],
      );
    }
    void createHash;
    void rootOf;
    void cursorFingerprint;
    void buildRsiPolicy;
  });
});

describe('返工 C:pi 的 notASession 预判与 PiReader 同口径(真实 reader 作对照)', () => {
  it('首行为空行、第二行才是非 session 对象:L0 与 reader.discover 一致排除;session / 畸形首行都放行', async () => {
    const f = await makeL0Fx('cr-pi-blank-');
    const a = await proj(f, 'alpha');
    const files: Record<string, string> = {
      'blank-then-msg.jsonl': `\n  \n${JSON.stringify({ type: 'not-a-session' })}\n`,
      'msg.jsonl': jl({ type: 'message', cwd: a }),
      'blank-then-session.jsonl': `\n${JSON.stringify({ type: 'session', cwd: a })}\n`,
      'plain.jsonl': jl({ type: 'session', cwd: a }, { type: 'message', id: 'm' }),
      'garbage.jsonl': 'not json\n',
      'blank-then-garbage-then-msg.jsonl': `\nnot json\n${JSON.stringify({ type: 'message' })}\n`,
      'no-type.jsonl': jl({ cwd: a }),
    };
    for (const [n, text] of Object.entries(files)) await put(f, 'pi', `--x--/${n}`, text);
    // 对照:reader.discover 对目录源会排除「明显不是 Pi 会话」的文件
    const { createPiReader } = await import('../../src/readers/pi/index.js');
    const kept = new Set(
      (await createPiReader().discover(rootOf(f, 'pi'))).map((r) => path.basename(r.path)),
    );
    const readerExcluded = Object.keys(files).filter((n) => !kept.has(n));
    expect(readerExcluded.sort()).toEqual(['blank-then-msg.jsonl', 'msg.jsonl']); // 前提:对照确实排除了两个
    const spy: TraceReader = {
      agent: 'pi',
      discover: async () => [],
      read: (ref) => {
        readCalls.push(path.basename(ref.path));
        throw new Error('stop');
      },
    };
    const readCalls: string[] = [];
    const { batch } = await run(f, { readers: { pi: spy } });
    const skippedByL0 = batch.outcomes
      .filter((o) => o.status === 'unknown_project')
      .map((o) => path.basename(o.file.path));
    expect(skippedByL0.sort()).toEqual(readerExcluded.sort());
    expect(readCalls.sort()).toEqual([...kept].sort()); // 其余都交给 reader 读(spy 抛错 → read_error)
  });
});

describe('返工 D:读阶段中止不剪除条目', () => {
  it('abort 时保留本次没列举到的旧条目(正向对照:正常结束时同一条目被剪除)', async () => {
    const f = await makeL0Fx('cr-noprune-');
    const a = await proj(f, 'alpha');
    const p1 = await put(f, 'claude', `p/${uuid(1)}.jsonl`, goodSession(a));
    await put(f, 'claude', `p/${uuid(2)}.jsonl`, goodSession(a));
    const r1 = await run(f);
    const ref1 = sessionRefFor(SALT, p1);
    expect(r1.batch.cursorNext.files[ref1]).toBeDefined();
    // 文件 1 从磁盘消失(经 safe-fs 的 unlink 不可用时改名到根外:这里直接用 rename 搬走)
    const { rename } = await import('../../src/io/safe-fs.js');
    await mkdirp(f.fx, path.join(f.dir, 'aside'), 0o755);
    await rename(f.fx, p1, path.join(f.dir, 'aside', 'moved.jsonl'));
    await put(f, 'claude', `p/${uuid(3)}.jsonl`, goodSession(a)); // 新文件,让本次有东西可读
    const aborted = await run(
      f,
      { checkpoint: async (w) => (w === 'file' ? { kind: 'abort', outcome: 'stopped' } : CONT) },
      r1.batch.cursorNext,
    );
    expect(aborted.batch.verdict.kind).toBe('abort');
    expect(aborted.batch.cursorNext.files[ref1]).toBeDefined(); // 没剪
    const normal = await run(f, {}, r1.batch.cursorNext);
    expect(normal.batch.cursorNext.files[ref1]).toBeUndefined(); // 正常结束:剪除
  });
});

describe('返工 E:无变化时 cursor 字节不变(无写放大)', () => {
  it('含 excluded / too_large / unknown_project 条目:同 epoch 再跑一次,cursorNext 与上次逐字节相同,且这些文件不被重读', async () => {
    const f = await makeL0Fx('cr-stable-');
    const bad = await proj(f, 'excl');
    const ok = await proj(f, 'fine');
    await setExtra(f, `exclude_dirs = [${JSON.stringify(bad)}]\n`);
    const c = await (await import('../../src/rsi/config.js')).loadRsiConfig({ env: f.env });
    if (c.status !== 'on') throw new Error('off');
    f.config = c;
    await put(f, 'claude', `p/${uuid(1)}.jsonl`, goodSession(bad));
    await put(f, 'claude', `p/${uuid(2)}.jsonl`, goodSession(ok));
    await put(
      f,
      'claude',
      `p/${uuid(3)}.jsonl`,
      jl(...Array.from({ length: 300 }, () => claudeLine(ok))),
    );
    await put(f, 'claude', `p/${uuid(4)}.jsonl`, jl({ type: 'mode' }));
    const small = { limits: { maxFileBytes: 20_000 } };
    const r1 = await run(f, small);
    const st = (b: CollectBatch): string[] => b.outcomes.map((o) => o.status).sort();
    expect(st(r1.batch)).toEqual(['excluded', 'ok', 'too_large', 'unknown_project']); // 前提:四种状态都出现
    expect(r1.batch.cursorNext.full_scan.done).toBe(true);
    const r2 = await run(f, small, r1.batch.cursorNext);
    expect(r2.batch.summary.files_read).toBe(0);
    expect(r2.batch.outcomes).toEqual([]);
    expect(r2.batch.summary.skipped.unchanged).toBe(4);
    expect(JSON.stringify(r2.batch.cursorNext)).toBe(JSON.stringify(r1.batch.cursorNext));
    // 进行中(未 done)的 cursor 同样:不推进就不变
    const r3 = await run(f, { ...small, limits: { maxFileBytes: 20_000, maxFiles: 1 } });
    expect(r3.batch.cursorNext.full_scan.done).toBe(false);
    const r4 = await run(f, { limits: { maxFileBytes: 20_000, maxFiles: 0 } }, r3.batch.cursorNext);
    expect(r4.batch.summary.files_read).toBe(0);
    expect(JSON.stringify(r4.batch.cursorNext)).toBe(JSON.stringify(r3.batch.cursorNext));
  });

  it('被排除文件的读取代价:命中排除时 reader 在首个带 cwd 的事件处停,不读完整个文件', async () => {
    const f = await makeL0Fx('cr-exclcost-');
    const bad = await proj(f, 'excl');
    await setExtra(f, `exclude_dirs = [${JSON.stringify(bad)}]\n`);
    const c = await (await import('../../src/rsi/config.js')).loadRsiConfig({ env: f.env });
    if (c.status !== 'on') throw new Error('off');
    f.config = c;
    const lines = jl(...Array.from({ length: 6000 }, () => claudeLine(bad)));
    const p = await put(f, 'claude', `p/${uuid(1)}.jsonl`, lines);
    const size = (await stat(p)).size;
    const { batch } = await run(f);
    expect(batch.outcomes[0]?.status).toBe('excluded');
    // 预扫读全文(无时间戳)一遍 + 正文读到第一个事件即停:远小于 2 倍文件大小
    expect(batch.bytesActual).toBeGreaterThanOrEqual(size);
    expect(batch.bytesActual).toBeLessThan(size + 2000);
  });
});
