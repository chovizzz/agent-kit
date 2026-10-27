/**
 * R20-A2 B5g:`writeStateOut` 的可选 `beforeWrite`(方案 §0.5 R12)。每个写操作之前恰好复核一次;不传时行为不变(retire 共用,正向对照)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StateOutError, writeStateOut } from '../../src/commands/state-out.js';
import { createIoContext } from '../../src/io/paths.js';
import { exists, readText } from '../../src/io/read-fs.js';
import { REPO_ROOT, makeTempDir } from '../helpers/tmp.js';

const FILES = { 'a.txt': 'A', 'b.txt': 'B', 'c.txt': 'C' };
/** 入口 1 + 每文件 4 步 × 3 + rename 1 */
const POINTS = 14;

async function world(): Promise<{
  io: ReturnType<typeof createIoContext>;
  ops: string[];
  dir: string;
}> {
  const { dir } = await makeTempDir('state-out-gate-');
  const ops: string[] = [];
  const io = createIoContext({
    cwd: REPO_ROOT,
    root: path.join(dir, 'repo'),
    env: { KIT_TMP: dir, KIT_STATE_DIR: path.join(dir, 'state'), PATH: '/usr/bin:/bin' },
    writeAudit: (op) => void ops.push(op),
  });
  return { io, ops, dir };
}

describe('writeStateOut beforeWrite', () => {
  it('不传:行为不变,写出三个文件(正向对照)', async () => {
    const w = await world();
    expect(await writeStateOut(w.io, 'promote', 'id-1', FILES, 'X')).toEqual({
      wrote: true,
      existing: false,
    });
    expect(await readText(path.join(w.io.stateDir, 'promote', 'id-1', 'b.txt'))).toBe('B');
  });

  it('每个写点之前恰好调用一次:调用与写操作严格交替(入口一次,之后 call/op 成对)', async () => {
    const w = await world();
    const seq: string[] = [];
    const io = createIoContext({
      cwd: REPO_ROOT,
      root: path.join(w.dir, 'repo'),
      env: { KIT_TMP: w.dir, KIT_STATE_DIR: path.join(w.dir, 'state2'), PATH: '/usr/bin:/bin' },
      writeAudit: (op) => {
        if (op !== 'rename.from') seq.push(`op:${op}`); // rename 的审计有 rename.from / rename 两行,算一次
      },
    });
    await writeStateOut(io, 'promote', 'id-1', FILES, 'X', {
      beforeWrite: async () => void seq.push('gate'),
    });
    expect(seq.filter((s) => s === 'gate')).toHaveLength(POINTS);
    expect(seq[0]).toBe('gate');
    // 每个写操作紧邻之前都是一次复核;复核之后紧跟的要么是写操作、要么是下一次复核(入口那次)
    seq.forEach((e, i) => {
      if (e.startsWith('op:')) expect(seq[i - 1], `位置 ${i}`).toBe('gate');
    });
    expect(seq.filter((s) => s.startsWith('op:'))).toHaveLength(POINTS - 1);
  });

  for (let k = 1; k <= POINTS; k++) {
    it(`第 ${k} 次复核失败:此前恰好 ${Math.max(0, k - 2)} 个写操作,此后零写入,无正式目录`, async () => {
      const w = await world();
      let n = 0;
      await expect(
        writeStateOut(w.io, 'promote', 'id-1', FILES, 'X', {
          beforeWrite: async () => {
            if (++n === k) throw new Error('lost');
          },
        }),
      ).rejects.toThrow('lost');
      expect(w.ops).toHaveLength(Math.max(0, k - 2));
      expect(await exists(path.join(w.io.stateDir, 'promote', 'id-1'))).toBe(false);
    });
  }

  it('已存在且一致:入口复核仍执行,失败则不报 existing(失锁不被伪装成无需写入)', async () => {
    const w = await world();
    await writeStateOut(w.io, 'promote', 'id-1', FILES, 'X');
    await expect(
      writeStateOut(w.io, 'promote', 'id-1', FILES, 'X', {
        beforeWrite: async () => {
          throw new Error('lost');
        },
      }),
    ).rejects.toThrow('lost');
    expect(await writeStateOut(w.io, 'promote', 'id-1', FILES, 'X')).toEqual({
      wrote: false,
      existing: true,
    });
    expect(new StateOutError('r').reason).toBe('r');
  });
});
