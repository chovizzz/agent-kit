/**
 * readCompanionText(Kimi 的 state.json 等伴随小文件)走安全打开:O_NOFOLLOW | O_NONBLOCK + 同句柄 fstat。
 * 拒绝时按既有口径返回 undefined(调用方当「取不到」),不阻塞、不抛错、不读出目标内容。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hardlink, symlink, writeFile } from '../../src/io/safe-fs.js';
import { readCompanionText } from '../../src/signals/open-readonly.js';
import { mkfifo } from '../rsi/proc/helper.js';
import { newWork } from './helpers.js';

/** 修复被还原时读 FIFO 会永远挂住:让它以「超时」红,而不是拖死整个套件。 */
async function within<T>(ms: number, p: Promise<T>): Promise<T | 'TIMEOUT'> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<'TIMEOUT'>((res) => {
    t = setTimeout(() => res('TIMEOUT'), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (t) clearTimeout(t);
  }
}

describe('readCompanionText:安全打开', () => {
  it('正向对照:普通文件、硬链接读得到;不存在返回 undefined', async () => {
    const w = await newWork('companion-ok-');
    const f = path.join(w.dir, 'state.json');
    await writeFile(w.io, f, '{"cwd":"/work/a"}');
    expect(await readCompanionText(f)).toBe('{"cwd":"/work/a"}');
    const h = path.join(w.dir, 'state-hard.json');
    await hardlink(w.io, f, h);
    expect(await readCompanionText(h)).toBe('{"cwd":"/work/a"}');
    expect(await readCompanionText(path.join(w.dir, 'nope.json'))).toBeUndefined();
  });

  it('最终路径是符号链接 → undefined,目标内容不被读出', async () => {
    const w = await newWork('companion-link-');
    const real = path.join(w.dir, 'real.json');
    await writeFile(w.io, real, '{"cwd":"/secret/place"}');
    const link = path.join(w.dir, 'state.json');
    await symlink(w.io, real, link);
    expect(await readCompanionText(real)).toContain('/secret/place'); // 对照:目标本身可读
    expect(await readCompanionText(link)).toBeUndefined();
  });

  it('FIFO → 不阻塞,undefined', async () => {
    const w = await newWork('companion-fifo-');
    const fifo = path.join(w.dir, 'state.json');
    mkfifo(fifo);
    expect(await within(3000, readCompanionText(fifo))).toBeUndefined();
  });

  it('超过 maxBytes → undefined(恰好等于上限仍读得到)', async () => {
    const w = await newWork('companion-big-');
    const f = path.join(w.dir, 'state.json');
    await writeFile(w.io, f, 'x'.repeat(100));
    expect(await readCompanionText(f, 100)).toBe('x'.repeat(100));
    expect(await readCompanionText(f, 99)).toBeUndefined();
  });
});
