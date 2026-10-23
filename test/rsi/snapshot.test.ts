/**
 * R20 A1(docs/contracts.md §20.5 R20-5.6):快照清单的写、读核对、未完成提交的恢复与损坏的阻断。
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Signal } from '../../src/contracts/signal.js';
import { exists, lstat, readBytes, readText } from '../../src/io/read-fs.js';
import { mkdirp, remove, symlink, writeFile } from '../../src/io/safe-fs.js';
import { acquireRsiLock, type RsiLockHandle } from '../../src/rsi/lock.js';
import {
  RsiSnapshotError,
  commitSnapshot,
  readSnapshot,
  readVerified,
  recoverSnapshot,
} from '../../src/rsi/snapshot.js';
import { signalLine } from '../../src/signals/state-store.js';
import { newWork, type Work } from '../signals/helpers.js';

const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');
const rsiFile = (w: Work, n: string): string => path.join(w.state, 'rsi', n);
const snapFile = (w: Work): string => rsiFile(w, 'snapshot.json');

function sig(id: string): Signal {
  return {
    sig_id: `sig_${id.padStart(16, '0')}`,
    agent: 'claude',
    agent_version: '1.0.0',
    agent_version_source: 'session_meta',
    session_ref: 's_0123456789abcdef',
    project_key: 'p_0123456789abcdef',
    ts: '2026-10-01T00:00:00.000Z',
    type: 'event',
    excerpt_redacted: 'hello',
    external_content: false,
    confidence: 1,
    loaded_rule_ids: [],
  };
}

async function put(w: Work, rel: string, text: string): Promise<void> {
  const abs = rel.includes('/') ? path.join(w.state, rel) : rsiFile(w, rel);
  await mkdirp(w.io, path.dirname(abs), 0o700);
  await writeFile(w.io, abs, text, { mode: 0o600 });
}

async function withLock<T>(w: Work, fn: (l: RsiLockHandle) => Promise<T>): Promise<T> {
  const l = await acquireRsiLock(w.io);
  try {
    return await fn(l);
  } finally {
    await l.release();
  }
}

const STATE = JSON.stringify({ schema_version: 1 });

describe('R20-5.6 commitSnapshot', () => {
  it('按当前白名单文件重算清单:name 升序、sha256 / bytes 与磁盘一致,0600;generation 1,2,3 只增', async () => {
    const w = await newWork('rs-commit-');
    await put(w, 'state.json', STATE);
    await put(w, 'counts.json', '{}');
    await put(w, 'signals/claude/202610.jsonl', `${signalLine(sig('1'))}\n`);
    await put(w, 'sessions/pi/202609.jsonl', '');
    const s1 = await withLock(w, (l) => commitSnapshot(w.io, l));
    expect(s1.generation).toBe(1);
    expect(s1.files.map((f) => f.name)).toEqual([
      'counts.json',
      'sessions/pi/202609.jsonl',
      'signals/claude/202610.jsonl',
      'state.json',
    ]);
    const sig1 = s1.files.find((f) => f.name === 'signals/claude/202610.jsonl');
    const raw = await readBytes(path.join(w.state, 'signals/claude/202610.jsonl'));
    expect(sig1).toEqual({
      name: 'signals/claude/202610.jsonl',
      sha256: sha(raw),
      bytes: raw.length,
    });
    expect((await lstat(snapFile(w))).mode & 0o777).toBe(0o600);
    expect(await exists(`${snapFile(w)}.tmp`)).toBe(false);
    expect((await withLock(w, (l) => commitSnapshot(w.io, l))).generation).toBe(2);
    await put(w, 'cursor.json', '{}');
    const s3 = await withLock(w, (l) => commitSnapshot(w.io, l));
    expect(s3.generation).toBe(3);
    expect(s3.files.map((f) => f.name)).toContain('cursor.json');
    expect((await readSnapshot(w.io)).kind).toBe('ok');
  });

  it('白名单外的文件不进清单(未知 agent 目录、非 6 位月份、其它 rsi 文件、log.jsonl)', async () => {
    const w = await newWork('rs-whitelist-');
    await put(w, 'state.json', STATE);
    await put(w, 'signals/kimi/202610.jsonl', '');
    await put(w, 'signals/claude/2026.jsonl', '');
    await put(w, 'signals/claude/202610.jsonl.tmp', '');
    await put(w, 'log.jsonl', '{}\n');
    await put(w, 'other.json', '{}');
    await put(w, 'sessions/claude/202610.jsonl', '');
    expect((await withLock(w, (l) => commitSnapshot(w.io, l))).files.map((f) => f.name)).toEqual([
      'sessions/claude/202610.jsonl',
      'state.json',
    ]);
  });

  it('提交点前 assertHeld:锁已丢失 → lock_lost,清单不被改写', async () => {
    const w = await newWork('rs-lost-');
    await put(w, 'state.json', STATE);
    const l = await acquireRsiLock(w.io);
    await commitSnapshot(w.io, l);
    const before = await readText(snapFile(w));
    await put(w, 'counts.json', '{}');
    await writeFile(
      w.io,
      rsiFile(w, 'lock'),
      JSON.stringify({
        pid: 99991,
        started_at: new Date().toISOString(),
        nonce: '1'.repeat(16),
        kit_version: '0.1.0',
      }),
      { mode: 0o600 },
    );
    await expect(commitSnapshot(w.io, l)).rejects.toMatchObject({ kind: 'lock_lost' });
    expect(await readText(snapFile(w))).toBe(before);
    await l.release();
  });

  it('rename 是提交点:临时清单写好后锁才丢失 → lock_lost,旧清单原样保留(变异:去掉 rename 前的 assertHeld → 红)', async () => {
    const w = await newWork('rs-lost-rename-');
    await put(w, 'state.json', STATE);
    const l = await acquireRsiLock(w.io);
    await commitSnapshot(w.io, l);
    const before = await readText(snapFile(w));
    await put(w, 'counts.json', '{}');
    await expect(
      commitSnapshot(w.io, l, {
        beforeRename: async () => {
          await writeFile(
            w.io,
            rsiFile(w, 'lock'),
            JSON.stringify({
              pid: 99991,
              started_at: new Date().toISOString(),
              nonce: '2'.repeat(16),
              kit_version: '0.1.0',
            }),
            { mode: 0o600 },
          );
        },
      }),
    ).rejects.toMatchObject({ kind: 'lock_lost' });
    expect(await readText(snapFile(w))).toBe(before);
    await l.release();
  });

  it('现有清单损坏 → commit 抛 snapshot_invalid,不覆盖', async () => {
    const w = await newWork('rs-badsnap-');
    await put(w, 'state.json', STATE);
    await put(w, 'snapshot.json', '{"nope"');
    await expect(withLock(w, (l) => commitSnapshot(w.io, l))).rejects.toMatchObject({
      reason: 'snapshot_invalid',
    });
    expect(await readText(snapFile(w))).toBe('{"nope"');
  });
});

describe('R20-5.6 只读方 readVerified', () => {
  it('核对通过 → ok,返回核对过的字节;清单与磁盘都没有的文件为 null', async () => {
    const w = await newWork('rs-read-');
    await put(w, 'state.json', STATE);
    await withLock(w, (l) => commitSnapshot(w.io, l));
    const r = await readVerified(w.io, ['state.json', 'counts.json']);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.generation).toBe(1);
    expect(r.files.get('state.json')?.toString('utf8')).toBe(STATE);
    expect(r.files.get('counts.json')).toBeNull();
  });

  it('清单缺失 = 从未提交过(no_snapshot,不是错误);清单损坏 = invalid', async () => {
    const w = await newWork('rs-nosnap-');
    await put(w, 'state.json', STATE);
    expect(await readVerified(w.io, ['state.json'])).toEqual({ status: 'no_snapshot' });
    await put(w, 'snapshot.json', 'x');
    expect(await readVerified(w.io, ['state.json'])).toEqual({ status: 'invalid' });
  });

  it('文件被改(sha 或字节数不符)/ 清单有文件已不在 / 磁盘多出清单没有的文件 → 重读一次后仍不一致 = busy', async () => {
    const w = await newWork('rs-busy-');
    await put(w, 'state.json', STATE);
    await put(w, 'counts.json', '{}');
    await withLock(w, (l) => commitSnapshot(w.io, l));
    await put(w, 'state.json', JSON.stringify({ schema_version: 2 }));
    expect(await readVerified(w.io, ['state.json'])).toEqual({ status: 'busy' });
    // 同字节数、内容不同:靠 sha256 抓
    await put(w, 'state.json', STATE.replace('1', '2'));
    expect(STATE.length).toBe(STATE.replace('1', '2').length);
    expect(await readVerified(w.io, ['state.json'])).toEqual({ status: 'busy' });
    await put(w, 'state.json', STATE);
    expect((await readVerified(w.io, ['state.json'])).status).toBe('ok'); // 对照:还原后通过
    await remove(w.io, rsiFile(w, 'counts.json'));
    expect(await readVerified(w.io, ['counts.json'])).toEqual({ status: 'busy' });
    await put(w, 'cursor.json', '{}');
    expect(await readVerified(w.io, ['cursor.json'])).toEqual({ status: 'busy' });
    // 只核对自己读的文件:state.json 没问题,即使 cursor / counts 不一致
    expect((await readVerified(w.io, ['state.json'])).status).toBe('ok');
  });

  it('第一次不一致、重新取清单后一致 → ok(变异:不重读 → 红)', async () => {
    const w = await newWork('rs-retry-');
    await put(w, 'state.json', STATE);
    await withLock(w, (l) => commitSnapshot(w.io, l));
    const next = JSON.stringify({ schema_version: 1, n: 2 });
    await put(w, 'state.json', next); // 写入方写完数据、还没替换清单
    const r = await readVerified(w.io, ['state.json'], {
      // 两次尝试之间,写入方完成了清单替换
      onMismatch: async () => {
        await withLock(w, (l) => commitSnapshot(w.io, l));
      },
    });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.generation).toBe(2);
      expect(r.files.get('state.json')?.toString('utf8')).toBe(next);
    }
  });

  it('读取方只按白名单拼路径:白名单外的 name 是编程错误,不读任何文件', async () => {
    const w = await newWork('rs-readname-');
    await put(w, 'state.json', STATE);
    await withLock(w, (l) => commitSnapshot(w.io, l));
    for (const bad of ['../x', 'signals/kimi/202610.jsonl', '/etc/passwd', 'lock', 'salt']) {
      await expect(readVerified(w.io, [bad])).rejects.toBeInstanceOf(RsiSnapshotError);
    }
  });
});

describe('R20-5.6 未完成提交 vs 损坏', () => {
  it('每个提交步骤注入崩溃:下一次持锁写入方都能恢复,且不改任何数据文件(变异:未完成提交当成损坏 → 红)', async () => {
    type Step = {
      name: string;
      crash: (w: Work, l: RsiLockHandle) => Promise<void>;
    };
    const steps: Step[] = [
      {
        name: '数据文件已提交一半(只写了 state.json),清单未替换',
        crash: async (w) => {
          await put(w, 'state.json', JSON.stringify({ schema_version: 1, n: 2 }));
        },
      },
      {
        name: '全部数据文件已提交,清单未替换',
        crash: async (w) => {
          await put(w, 'state.json', JSON.stringify({ schema_version: 1, n: 2 }));
          await put(w, 'counts.json', '{"a":1}');
          await put(w, 'signals/claude/202610.jsonl', `${signalLine(sig('2'))}\n`);
          await put(w, 'sessions/codex/202610.jsonl', '');
        },
      },
      {
        name: '临时清单已写好、rename 之前崩溃',
        crash: async (w, l) => {
          await put(w, 'counts.json', '{"a":2}');
          await expect(
            commitSnapshot(w.io, l, {
              beforeRename: () => {
                throw new Error('crash');
              },
            }),
          ).rejects.toThrow('crash');
          expect(await exists(`${snapFile(w)}.tmp`)).toBe(true);
        },
      },
      {
        name: '数据文件被整体删除(purge 重写)而清单仍列着它',
        crash: async (w) => {
          await remove(w.io, rsiFile(w, 'cursor.json'));
        },
      },
    ];
    for (const step of steps) {
      const w = await newWork('rs-crash-');
      await put(w, 'state.json', STATE);
      await put(w, 'cursor.json', '{}');
      const gen1 = await withLock(w, (l) => commitSnapshot(w.io, l));
      await withLock(w, async (l) => {
        await step.crash(w, l);
      });
      const dataBefore = new Map<string, string>();
      for (const n of ['state.json', 'counts.json', 'cursor.json']) {
        if (await exists(rsiFile(w, n))) dataBefore.set(n, sha(await readBytes(rsiFile(w, n))));
      }
      const outcome = await withLock(w, (l) => recoverSnapshot(w.io, l));
      expect(outcome, step.name).toBe('rebuilt');
      for (const [n, h] of dataBefore) {
        expect(sha(await readBytes(rsiFile(w, n))), `${step.name}:${n}`).toBe(h); // 数据文件未被改动
      }
      const after = await readSnapshot(w.io);
      expect(after.kind === 'ok' && after.snapshot.generation, step.name).toBe(gen1.generation + 1);
      expect(await exists(`${snapFile(w)}.tmp`), step.name).toBe(false);
      const r = await readVerified(w.io, ['state.json', 'counts.json', 'cursor.json']);
      expect(r.status, step.name).toBe('ok');
      expect(await withLock(w, (l) => recoverSnapshot(w.io, l))).toBe('consistent');
    }
  });

  it('损坏 → 安全阻断(各文件对应原因码),清单与数据文件都不被改写', async () => {
    const cases: { file: string; bad: string; reason: string }[] = [
      { file: 'state.json', bad: '{"x"', reason: 'state_invalid' },
      { file: 'projects.json', bad: '[]', reason: 'index_invalid' },
      { file: 'cursor.json', bad: 'nope', reason: 'cursor_invalid' },
      { file: 'counts.json', bad: '"s"', reason: 'counts_invalid' },
      {
        file: 'signals/claude/202610.jsonl',
        bad: `${signalLine(sig('3'))}\n{"half"`,
        reason: 'signal_store_corrupt',
      },
      { file: 'signals/pi/202610.jsonl', bad: '{"a":1}\n', reason: 'signal_store_corrupt' },
      { file: 'sessions/codex/202610.jsonl', bad: 'not json\n', reason: 'signal_store_corrupt' },
    ];
    for (const c of cases) {
      const w = await newWork('rs-corrupt-');
      await put(w, 'state.json', STATE);
      await withLock(w, (l) => commitSnapshot(w.io, l));
      const snapBefore = await readText(snapFile(w));
      await put(w, c.file, c.bad);
      const e = await withLock(w, (l) => recoverSnapshot(w.io, l)).catch((x: unknown) => x);
      expect(e, c.file).toBeInstanceOf(RsiSnapshotError);
      expect((e as RsiSnapshotError).reason, c.file).toBe(c.reason);
      expect((e as RsiSnapshotError).code).toBe('RSI_FAIL_CLOSED');
      expect(await readText(snapFile(w)), c.file).toBe(snapBefore);
      const dest = c.file.includes('/') ? path.join(w.state, c.file) : rsiFile(w, c.file);
      expect(await readText(dest), c.file).toBe(c.bad);
    }
  });

  it('清单本身损坏 → snapshot_invalid(阻断);清单缺失 → absent(不是错误);一致 → consistent', async () => {
    const w = await newWork('rs-manifest-');
    await put(w, 'state.json', STATE);
    expect(await withLock(w, (l) => recoverSnapshot(w.io, l))).toBe('absent');
    await withLock(w, (l) => commitSnapshot(w.io, l));
    expect(await withLock(w, (l) => recoverSnapshot(w.io, l))).toBe('consistent');
    await put(
      w,
      'snapshot.json',
      '{"schema_version":1,"generation":0,"written_at":"x","files":[]}',
    );
    await expect(withLock(w, (l) => recoverSnapshot(w.io, l))).rejects.toMatchObject({
      reason: 'snapshot_invalid',
    });
  });

  it('符号链接冒充数据文件 → 视为损坏,不跟随', async () => {
    const w = await newWork('rs-link-');
    await put(w, 'state.json', STATE);
    await withLock(w, (l) => commitSnapshot(w.io, l));
    await put(w, 'real.json', '{}');
    await remove(w.io, rsiFile(w, 'state.json'));
    await symlink(w.io, rsiFile(w, 'real.json'), rsiFile(w, 'state.json'));
    await expect(withLock(w, (l) => recoverSnapshot(w.io, l))).rejects.toMatchObject({
      reason: 'state_invalid',
    });
    expect(await readVerified(w.io, ['state.json'])).toEqual({ status: 'invalid' });
  });
});
