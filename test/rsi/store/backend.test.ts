/**
 * B1a:原始后端与文件端口的直接用例——gen 连续、字节上限、无效提交、文件名防逃逸、不安全 / 不存在的读语义、真实写出口被拒(WriteDenied)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_EFFECTS_LEDGER, RSI_EFFECTS_LIMITS } from '../../../src/contracts/rsi-store.js';
import { createIoContext } from '../../../src/io/paths.js';
import { rsiDir } from '../../../src/rsi/rsi-dir.js';
import { safeStoreFs } from '../../../src/rsi/store/fs-port.js';
import { StoreError } from '../../../src/rsi/store/errors.js';
import { baseCtx, makeTempDir, REPO_ROOT } from '../../helpers/tmp.js';
import { FILES, MemFs, makeWorld, meta, tomb } from './store-fixture.js';

const noop = async (): Promise<void> => undefined;
const code = async (p: Promise<unknown>): Promise<[string, string | undefined]> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof StoreError) return [e.code, e.detail];
    throw e;
  }
  throw new Error('expected rejection');
};

describe('后端 commitLedger', () => {
  it('gen 必须恰为当前 + 1(gen_not_sequential);对照:+1 通过', async () => {
    const w = await makeWorld('mem');
    const next = { ...structuredClone(EMPTY_EFFECTS_LEDGER), gen: 2 };
    expect(await code(w.backend.commitLedger(next, noop))).toEqual([
      'state_invalid',
      'gen_not_sequential',
    ]);
    expect(await w.bytes(FILES.effects)).toBeNull();
    await w.backend.commitLedger({ ...next, gen: 1 }, noop);
    expect((await w.backend.readLedger()).gen).toBe(1);
    expect(await code(w.backend.commitLedger({ ...next, gen: 1 }, noop))).toEqual([
      'state_invalid',
      'gen_not_sequential',
    ]);
  });

  it('不合规的新账 = commit_invalid;超过 8 MiB = effects_full(bytes),文件不变', async () => {
    const w = await makeWorld('mem');
    const bad = { ...structuredClone(EMPTY_EFFECTS_LEDGER), gen: 1, schema_version: 2 } as never;
    expect(await code(w.backend.commitLedger(bad, noop))).toEqual([
      'state_invalid',
      'commit_invalid',
    ]);
    const big = {
      ...structuredClone(EMPTY_EFFECTS_LEDGER),
      gen: 1,
      applied: Array.from({ length: RSI_EFFECTS_LIMITS.applied }, (_, i) => ({
        key: `${String(i).padStart(6, '0')}${'x'.repeat(250)}`,
        event_at: '2026-11-15T08:00:00.000Z',
        batch_sha256: 'a'.repeat(64),
      })),
    };
    // 2 万个 256 字符键仍 < 8 MiB:先垫一个超大的非键部分
    const filler = Array.from({ length: 1000 }, (_, i) => ({
      candidate_id: `ra_${i.toString(16).padStart(12, '0')}`,
      content_sha256: 'a'.repeat(64),
      fp_hmac: '0123456789abcdef',
      near_fp: Array.from({ length: 64 }, (_, j) => (i * 64 + j).toString(16).padStart(8, '0')),
      at: '2026-11-15T08:00:00.000Z',
      vetoed_gen: 1,
    }));
    const r = await code(w.backend.commitLedger({ ...big, blacklist: filler }, noop));
    expect(r).toEqual(['effects_full', 'bytes']);
    expect(await w.bytes(FILES.effects)).toBeNull();
  });

  it('写失败时临时文件被清理,目标不变;丢锁(assertHeld 抛)= 原样上抛', async () => {
    const w = await makeWorld('mem');
    const next = { ...structuredClone(EMPTY_EFFECTS_LEDGER), gen: 1 };
    await expect(
      w.backend.commitLedger(next, async () => {
        throw new Error('lock gone');
      }),
    ).rejects.toThrow('lock gone');
    expect(await w.bytes(FILES.effects)).toBeNull();
    expect(await w.tmpFiles()).toEqual([]);
  });
});

describe('后端 compaction 读写', () => {
  it('writeCompaction:gen 连续、schema 合法;读回一致;缺失 = 虚拟 gen 0', async () => {
    const w = await makeWorld('mem');
    expect(await w.backend.readWatermark()).toEqual({ through: null, gen: 0 });
    const doc = { schema_version: 1 as const, gen: 1, through: '2026-11-01', months: {} };
    await w.backend.writeCompaction(doc, noop);
    expect(await w.backend.readWatermark()).toEqual({ through: '2026-11-01', gen: 1 });
    expect(await code(w.backend.writeCompaction({ ...doc, gen: 3 }, noop))).toEqual([
      'compaction_unsupported',
      'gen_not_sequential',
    ]);
    expect(await code(w.backend.writeCompaction({ ...doc, gen: 2, through: 'bad' }, noop))).toEqual(
      ['compaction_unsupported', 'commit_invalid'],
    );
  });

  it('读不出 = compaction_unreadable(不当作缺失);链接 / 超限 = unsafe', async () => {
    const w = await makeWorld('mem');
    (w.raw as MemFs).unsafe.add(FILES.compaction);
    expect(await code(w.backend.readCompaction())).toEqual([
      'compaction_unreadable',
      'unsafe:link',
    ]);
    (w.raw as MemFs).unsafe.delete(FILES.compaction);
    (w.raw as MemFs).unsafe.add(FILES.effects);
    expect(await code(w.backend.readLedger())).toEqual(['state_invalid', 'unsafe:link']);
    (w.raw as MemFs).unsafe.add(FILES.audit);
    expect(await code(w.backend.readAudit())).toEqual(['audit_bad_line', 'unsafe:link']);
  });

  it('审计文件不是合法 UTF-8 = audit_bad_line(utf8)', async () => {
    const w = await makeWorld('mem');
    (w.raw as MemFs).files.set(FILES.audit, Buffer.from([0xff, 0xfe, 0x0a]));
    expect(await code(w.backend.readAudit())).toEqual(['audit_bad_line', 'utf8']);
  });
});

describe('真实文件端口 safeStoreFs', () => {
  it('fs_port_name_escape:文件名含路径分隔符 / 上跳 = store_io(bad_file_name)', async () => {
    const { dir } = await makeTempDir('rsi-fsport-');
    const io = createIoContext({
      cwd: REPO_ROOT,
      env: { KIT_TMP: dir, KIT_STATE_DIR: path.join(dir, 'state'), PATH: baseCtx().execPath },
    });
    const fs = safeStoreFs(io, await rsiDir(io));
    for (const bad of ['../x', 'a/b', '', 'X.json']) {
      expect(await code(fs.read(bad, 10))).toEqual(['store_io', 'bad_file_name']);
    }
    expect(await fs.read('effects.json', 10)).toEqual({ kind: 'missing' });
  });

  it('真实写出口拒绝(写根之外):writeTmp 抛 WriteDeniedError → 经后端归一为 store_io(detail = IO_WRITE_DENIED),目标不变', async () => {
    const { dir } = await makeTempDir('rsi-denied-');
    const wide = createIoContext({
      cwd: REPO_ROOT,
      env: { KIT_TMP: dir, KIT_STATE_DIR: path.join(dir, 'state'), PATH: baseCtx().execPath },
    });
    const rsi = await rsiDir(wide);
    const narrow = createIoContext({
      cwd: REPO_ROOT,
      env: { KIT_TMP: dir, KIT_WRITE_ROOTS: path.join(dir, 'elsewhere'), PATH: baseCtx().execPath },
    });
    const { createBackend } = await import('../../../src/rsi/store/backend.js');
    const backend = createBackend(safeStoreFs(narrow, rsi), () => new Date('2026-11-15T12:00:00Z'));
    const r = await code(
      backend.commitLedger({ ...structuredClone(EMPTY_EFFECTS_LEDGER), gen: 1 }, noop),
    );
    expect(r[0]).toBe('store_io');
    expect(r[1]).toBe('IO_WRITE_DENIED');
    expect(await safeStoreFs(wide, rsi).read('effects.json', 10)).toEqual({ kind: 'missing' });
  });
});

describe('事务端口的元信息校验沿用同一份规划(对照)', () => {
  it('meta()/tomb() 夹具自检', () => {
    expect(meta().event_at).toBe('2026-11-15T08:00:00.000Z');
    expect(tomb().type).toBe('write_tombstone');
  });
});
