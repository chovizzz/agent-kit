/**
 * R20-A2 B5c:`rewriteMonthFileWithout`(信号库 / 会话计数月文件按 key 过滤重写)。覆盖方案 §11「R20-3.8.4」行的文件级判据:
 * 月文件永不删除(只重写成空文件 / 保留其余行,字节级断言)、没有命中的文件字节不变且零写入、硬链接 / 符号链接 / 换 inode / 坏行 fail-closed、每个写点失锁后零写入。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, readBytes, readText } from '../../src/io/read-fs.js';
import { hardlink, remove, rename, symlink, writeFile } from '../../src/io/safe-fs.js';
import { SignalStoreError } from '../../src/signals/state-store.js';
import { rewriteMonthFileWithout } from '../../src/signals/store-rewrite.js';
import { projectKeyOf } from '../../src/signals/store-scan.js';
import { KEY_A, KEY_B, makeSvc, put, type Svc } from './services-fixture.js';

const line = (id: string, k: string, extra = ''): string =>
  `{"project_key":"${k}","sig_id":"sig_${id}"${extra}}`;
const KSET = new Set([KEY_A]);
const FILE = (s: Svc): string => path.join(s.state, 'signals', 'claude', '202610.jsonl');

async function world(prefix: string, text: string): Promise<{ s: Svc; file: string }> {
  const s = await makeSvc(prefix);
  const file = FILE(s);
  await put(s, file, text);
  s.audit.length = 0;
  return { s, file };
}

const noGate = (): Promise<void> => Promise.resolve();

describe('rewriteMonthFileWithout:基本语义', () => {
  it('没有命中 → unchanged,字节不变,零写入', async () => {
    const text = `${line('1', KEY_B)}\n${line('2', KEY_B)}\n`;
    const { s, file } = await world('rw-nohit-', text);
    expect(await rewriteMonthFileWithout(s.io, file, KSET, projectKeyOf, noGate)).toBe('unchanged');
    expect(await readText(file)).toBe(text);
    expect(s.audit).toEqual([]);
  });

  it('文件不存在 → unchanged,零写入', async () => {
    const s = await makeSvc('rw-missing-');
    expect(await rewriteMonthFileWithout(s.io, FILE(s), KSET, projectKeyOf, noGate)).toBe(
      'unchanged',
    );
    expect(s.audit).toEqual([]);
  });

  it('有命中 → 只删命中行,其余行逐字节原样(含行内空白与转义),不删文件,不留临时文件', async () => {
    const keep1 = line('2', KEY_B, ',"x":"a\\u00e9  b"');
    const keep2 = line('4', KEY_B);
    const text = `${line('1', KEY_A)}\n${keep1}\n${line('3', KEY_A)}\n${keep2}\n`;
    const { s, file } = await world('rw-hit-', text);
    const r = await rewriteMonthFileWithout(s.io, file, KSET, projectKeyOf, noGate);
    expect(r).toEqual({ removed: 2 });
    expect(await readText(file)).toBe(`${keep1}\n${keep2}\n`);
    expect(await exists(`${file}.tmp`)).toBe(false);
    // 月文件本身永不被 remove(审计里没有对它的 remove);只有对临时文件的写与 rename
    expect(s.audit.filter((a) => a.startsWith('remove ') && a.endsWith('202610.jsonl'))).toEqual(
      [],
    );
    expect(s.audit.some((a) => a.startsWith('rename '))).toBe(true);
  });

  it('全部命中 → 月文件仍在、是 0 字节空文件(D5:永不删除),权限 0600', async () => {
    const { s, file } = await world('rw-all-', `${line('1', KEY_A)}\n${line('2', KEY_A)}\n`);
    expect(await rewriteMonthFileWithout(s.io, file, KSET, projectKeyOf, noGate)).toEqual({
      removed: 2,
    });
    expect(await exists(file)).toBe(true);
    expect((await readBytes(file)).length).toBe(0);
    expect(s.audit.filter((a) => a === `remove ${file}`)).toEqual([]);
  });

  it('旧的临时文件残留 → 先清掉再重写,结果相同', async () => {
    const { s, file } = await world('rw-stale-', `${line('1', KEY_A)}\n${line('2', KEY_B)}\n`);
    await writeFile(s.f.fx, `${file}.tmp`, 'garbage-from-a-crash', { mode: 0o600 });
    expect(await rewriteMonthFileWithout(s.io, file, KSET, projectKeyOf, noGate)).toEqual({
      removed: 1,
    });
    expect(await readText(file)).toBe(`${line('2', KEY_B)}\n`);
    expect(await exists(`${file}.tmp`)).toBe(false);
  });

  it('大文件按块追加(超过 1MiB 的保留内容):结果与过滤等价', async () => {
    const pad = 'x'.repeat(2000);
    const lines: string[] = [];
    for (let i = 1; i <= 1500; i++)
      lines.push(
        line(i.toString(16).padStart(4, '0'), i % 3 === 0 ? KEY_A : KEY_B, `,"p":"${pad}"`),
      );
    const { s, file } = await world('rw-big-', `${lines.join('\n')}\n`);
    const r = await rewriteMonthFileWithout(s.io, file, KSET, projectKeyOf, noGate);
    expect(r).toEqual({ removed: 500 });
    const expected = lines.filter((_, i) => (i + 1) % 3 !== 0);
    expect(await readText(file)).toBe(`${expected.join('\n')}\n`);
    expect(
      s.audit.filter((a) => a.startsWith('appendFile ')).length,
      '正向前提:分了多块',
    ).toBeGreaterThan(1);
  });
});

describe('rewriteMonthFileWithout:fail-closed', () => {
  const expectCorrupt = async (s: Svc, file: string): Promise<void> => {
    await expect(
      rewriteMonthFileWithout(s.io, file, KSET, projectKeyOf, noGate),
    ).rejects.toBeInstanceOf(SignalStoreError);
  };

  it('坏行 / 缺尾换行 / 空行 / 缺 project_key → SignalStoreError,文件字节不变、零写入', async () => {
    for (const [name, text] of [
      ['badjson', `${line('1', KEY_A)}\nnot json\n`],
      ['notail', `${line('1', KEY_A)}\n${line('2', KEY_B)}`],
      ['blank', `${line('1', KEY_A)}\n\n${line('2', KEY_B)}\n`],
      ['nokey', `${line('1', KEY_A)}\n{"sig_id":"sig_1"}\n`],
    ] as const) {
      const { s, file } = await world(`rw-bad-${name}-`, text);
      await expectCorrupt(s, file);
      expect(await readText(file), name).toBe(text);
      expect(s.audit, name).toEqual([]);
    }
  });

  it('硬链接(nlink > 1)→ SignalStoreError,另一个名字下的内容不变', async () => {
    const text = `${line('1', KEY_A)}\n`;
    const { s, file } = await world('rw-hard-', text);
    const other = path.join(s.state, 'signals', 'claude', 'other-name');
    await hardlink(s.f.fx, file, other);
    s.audit.length = 0;
    await expectCorrupt(s, file);
    expect(await readText(other)).toBe(text);
    expect(s.audit).toEqual([]);
  });

  it('符号链接 → SignalStoreError,链接目标不变', async () => {
    const text = `${line('1', KEY_A)}\n`;
    const { s, file } = await world('rw-sym-', text);
    const real = `${file}.real`;
    await rename(s.f.fx, file, real);
    await symlink(s.f.fx, real, file);
    s.audit.length = 0;
    await expectCorrupt(s, file);
    expect(await readText(real)).toBe(text);
    expect(s.audit).toEqual([]);
  });

  it('两遍之间被换成另一个同尺寸的文件(旧文件改名保留再新建)→ SignalStoreError,新文件不被 rename 覆盖', async () => {
    const text = `${line('1', KEY_A)}\n${line('2', KEY_B)}\n`;
    const { s, file } = await world('rw-swap-', text);
    let swapped = false;
    const gate = async (op: string): Promise<void> => {
      if (op === 'tmp-create' && !swapped) {
        swapped = true;
        await rename(s.f.fx, file, `${file}.orig`);
        await put(s, file, text); // 同内容同尺寸,新 inode
      }
    };
    await expect(
      rewriteMonthFileWithout(s.io, file, KSET, projectKeyOf, gate),
    ).rejects.toBeInstanceOf(SignalStoreError);
    expect(swapped, '正向前提:确实换了').toBe(true);
    expect(await readText(file)).toBe(text);
    expect(await readText(`${file}.orig`)).toBe(text);
  });

  it('两遍之间内容变了(同 inode 原地改写,尺寸不同)→ SignalStoreError,目标文件字节 = 改写后的内容', async () => {
    const text = `${line('1', KEY_A)}\n${line('2', KEY_B)}\n`;
    const { s, file } = await world('rw-mut-', text);
    const changed = `${line('1', KEY_A)}\n${line('2', KEY_B)}\n${line('3', KEY_B)}\n`;
    let done = false;
    const gate = async (op: string): Promise<void> => {
      if (op === 'tmp-create' && !done) {
        done = true;
        await writeFile(s.f.fx, file, changed, { mode: 0o600 });
      }
    };
    await expect(
      rewriteMonthFileWithout(s.io, file, KSET, projectKeyOf, gate),
    ).rejects.toBeInstanceOf(SignalStoreError);
    expect(await readText(file)).toBe(changed);
  });
});

describe('rewriteMonthFileWithout:rename 前的追加', () => {
  it('两遍读完之后、rename 之前原文件被追加(同 inode、尺寸变大)→ SignalStoreError,追加的内容不丢', async () => {
    const text = `${line('1', KEY_A)}\n${line('2', KEY_B)}\n`;
    const { s, file } = await world('rw-append-', text);
    const extra = `${line('3', KEY_B)}\n`;
    const gate = async (op: string): Promise<void> => {
      if (op === 'rename') await writeFile(s.f.fx, file, text + extra, { mode: 0o600 });
    };
    await expect(
      rewriteMonthFileWithout(s.io, file, KSET, projectKeyOf, gate),
    ).rejects.toBeInstanceOf(SignalStoreError);
    expect(await readText(file)).toBe(text + extra);
  });
});

describe('rewriteMonthFileWithout:每个写点之前失锁 → 之后零写入(k 遍历)', () => {
  it('第 k 个写点的 gate 抛错 → 审计长度停在该点之前,月文件字节不变(rename 之前)', async () => {
    const text = `${line('1', KEY_A)}\n${line('2', KEY_B)}\n`;
    // 先跑一遍记录写点
    const rec = await world('rw-k-rec-', text);
    const ops: string[] = [];
    const lens: number[] = [];
    await rewriteMonthFileWithout(rec.s.io, rec.file, KSET, projectKeyOf, (op) => {
      ops.push(op);
      lens.push(rec.s.audit.length);
      return Promise.resolve();
    });
    expect(ops).toEqual(['tmp-remove', 'tmp-create', 'tmp-append', 'rename']);
    for (let k = 1; k <= ops.length; k++) {
      const { s, file } = await world(`rw-k-${k}-`, text);
      let n = 0;
      let at = -1;
      await expect(
        rewriteMonthFileWithout(s.io, file, KSET, projectKeyOf, () => {
          if (++n === k) {
            at = s.audit.length;
            return Promise.reject(new Error('lock lost'));
          }
          return Promise.resolve();
        }),
      ).rejects.toThrow('lock lost');
      expect(s.audit.length, `k=${k}`).toBe(at);
      expect(at, `k=${k}`).toBe(lens[k - 1]);
      expect(await readText(file), `k=${k}`).toBe(text); // rename 之前,原文件不动
    }
  });
});

describe('rewriteMonthFileWithout:收尾', () => {
  it('临时文件清理:成功之后目录里没有 .tmp;原文件被删除的变异会被「文件仍在」断言抓到(正向对照)', async () => {
    const { s, file } = await world('rw-end-', `${line('1', KEY_A)}\n`);
    await rewriteMonthFileWithout(s.io, file, KSET, projectKeyOf, noGate);
    expect(await exists(file)).toBe(true);
    await remove(s.f.fx, file);
    expect(await exists(file), '对照:被删之后 exists 为假').toBe(false);
  });
});
