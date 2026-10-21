/**
 * A28/S2 的靶子:回滚时备份里的写前全文必须核对 sha256(登记在事务 journal / 副本里的写前 sha)。
 * 备份内容被改(磁盘损坏、有人动过 backups/)时,整次拒绝 SYNC_ROLLBACK_MISMATCH,工作树与登记表一字不动。
 * 正向对照:同一世界备份没被改则回滚成功、用户文件逐字节还原。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { PI_MD, STATE_PREFIX, isState, newWorld, stdFixture, treeOf, type World } from './world.js';

const USER_PI = '# 用户自己的 pi 规则\n- 保持简短\n';

async function installed(label: string): Promise<{ w: World; id: string }> {
  const w = await newWorld(label);
  await w.setPayload(stdFixture());
  await w.put(PI_MD, USER_PI); // 写前存在 => 备份里有它的写前全文
  const r = await w.run(['--write']);
  expect(r.code, r.err).toBe(0);
  const id = /^txn (\S+)$/m.exec(r.out)?.[1] as string;
  expect(id).toMatch(/^txn-/);
  return { w, id };
}

const managed = async (w: World): Promise<string[]> =>
  [...(await treeOf(w.home, isState)).files].map(([k, v]) => `${k} ${v}`).sort();

describe('sync --rollback:备份内容必须核对 sha', () => {
  it('正向对照:备份完好 => 回滚成功,用户文件逐字节还原', async () => {
    const { w, id } = await installed('rb-sha-ok-');
    const r = await w.run(['--write', '--rollback', id]);
    expect(r.code, r.err).toBe(0);
    expect(await w.read(PI_MD)).toBe(USER_PI);
  });

  it('备份内容被改(sha 对不上)=> SYNC_ROLLBACK_MISMATCH,整次不写', async () => {
    const { w, id } = await installed('rb-sha-bad-');
    const backup = path.join(w.home, STATE_PREFIX, 'sync', 'backups', id, 'files', PI_MD);
    expect(await readText(backup)).toBe(USER_PI); // 备份确实存在且是写前全文
    await safe.writeFile(w.io, backup, '# 被篡改的备份\n');
    const before = await managed(w);
    const r = await w.run(['--write', '--rollback', id]);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r.err).toBe('SYNC_FAIL_CLOSED reason=SYNC_ROLLBACK_MISMATCH\n');
    expect(await managed(w)).toEqual(before);
    expect(await w.read(PI_MD)).not.toBe('# 被篡改的备份\n');
  });
});
