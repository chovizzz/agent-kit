/**
 * R20-A2 B4a / D5:盐的共同只读原语 `readSaltFile`,以及 `loadSalt` 改用它之后的收紧(拒绝硬链接)。
 * 判据:原语与 `loadSalt` 对同一个盐文件结论相同;规则表里每一条都有反例。
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createIoContext } from '../../src/io/paths.js';
import { exists } from '../../src/io/read-fs.js';
import { chmod, hardlink, mkdirp, symlink, writeFile } from '../../src/io/safe-fs.js';
import { RSI_SALT_MAX_BYTES } from '../../src/contracts/rsi.js';
import { SaltError as StoreSaltError, loadSalt } from '../../src/signals/state-store.js';
import { SaltError, ephemeralSalt, readSaltFile } from '../../src/signals/salt-read.js';
import { REPO_ROOT, makeTempDir } from '../helpers/tmp.js';
import { mkfifo } from '../rsi/proc/helper.js';

const SALT = 'ab'.repeat(32);
const fp = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 12);

async function mk(prefix: string) {
  const { dir } = await makeTempDir(prefix);
  const state = path.join(dir, 'state');
  const io = createIoContext({
    cwd: REPO_ROOT,
    env: { KIT_TMP: dir, KIT_STATE_DIR: state, PATH: '/usr/bin:/bin' },
  });
  await mkdirp(io, state, 0o700);
  const file = path.join(state, 'salt');
  const put = async (data: string | Uint8Array, mode = 0o600): Promise<void> => {
    await writeFile(io, file, data, { mode });
    await chmod(io, file, mode);
  };
  return { dir, io, state, file, put };
}

const BAD: [string, () => string | Uint8Array, number?][] = [
  ['权限宽于 0600(0644)', () => SALT, 0o644],
  ['含可执行位(0700 > 0600)', () => SALT, 0o700],
  ['两个换行', () => `${SALT}\n\n`],
  ['CRLF', () => `${SALT}\r\n`],
  ['前导空格', () => ` ${SALT}`],
  ['尾部空格', () => `${SALT} `],
  ['大写十六进制', () => SALT.toUpperCase()],
  ['BOM', () => `﻿${SALT}`],
  ['只有换行', () => '\n'],
  ['63 位', () => SALT.slice(1)],
  ['65 位', () => `${SALT}a`],
  ['非十六进制', () => `${'g'.repeat(64)}`],
  ['超过 4KiB', () => 'a'.repeat(RSI_SALT_MAX_BYTES + 1)],
];

describe('readSaltFile', () => {
  it('合法:无换行 / 一个换行得到同一个 salt 与 saltFp(= sha256(salt) 前 12 位十六进制);0600 与 0400 都过', async () => {
    const m = await mk('salt-ok-');
    await m.put(SALT);
    const a = await readSaltFile(m.state);
    expect(a).toEqual({ kind: 'ok', salt: SALT, saltFp: fp(SALT) });
    await m.put(`${SALT}\n`);
    expect(await readSaltFile(m.state)).toEqual(a);
    await m.put(`${SALT}\n`, 0o400);
    expect(await readSaltFile(m.state)).toEqual(a);
    expect(fp(SALT)).toMatch(/^[0-9a-f]{12}$/);
  });

  it('不存在 → absent;空文件 → empty(带 mtimeMs,不等待);空文件权限过宽仍是违规', async () => {
    const m = await mk('salt-abs-');
    expect(await readSaltFile(m.state)).toEqual({ kind: 'absent' });
    await m.put('');
    const r = await readSaltFile(m.state);
    expect(r.kind).toBe('empty');
    if (r.kind === 'empty') expect(r.mtimeMs).toBeGreaterThan(0);
    await m.put('', 0o644);
    await expect(readSaltFile(m.state)).rejects.toThrow(SaltError);
  });

  for (const [name, body, mode] of BAD) {
    it(`违规:${name} → SaltError`, async () => {
      const m = await mk('salt-bad-');
      await m.put(body(), mode);
      await expect(readSaltFile(m.state)).rejects.toThrow(SaltError);
    });
  }

  it('违规:符号链接 / 硬链接 / 非普通文件(目录、FIFO)→ SaltError', async () => {
    const m = await mk('salt-link-');
    const real = path.join(m.state, 'real');
    await writeFile(m.io, real, SALT, { mode: 0o600 });
    await symlink(m.io, real, m.file);
    await expect(readSaltFile(m.state)).rejects.toThrow(SaltError);

    const h = await mk('salt-hard-');
    await h.put(SALT);
    await hardlink(h.io, h.file, path.join(h.state, 'other-name'));
    await expect(readSaltFile(h.state)).rejects.toThrow(SaltError);

    const d = await mk('salt-dir-');
    await mkdirp(d.io, d.file, 0o700);
    await expect(readSaltFile(d.state)).rejects.toThrow(SaltError);

    const q = await mk('salt-fifo-');
    mkfifo(q.file);
    await expect(readSaltFile(q.state)).rejects.toThrow(SaltError);
  });

  it('不写、不建目录:状态目录不存在 → absent,且没有被创建', async () => {
    const { dir } = await makeTempDir('salt-nodir-');
    const missing = path.join(dir, 'no-such-state');
    expect(await readSaltFile(missing)).toEqual({ kind: 'absent' });
    expect(await exists(missing)).toBe(false);
  });

  it('ephemeralSalt:64 位十六进制,两次不同;SaltError 在 state-store 与 salt-read 是同一个类', () => {
    const a = ephemeralSalt();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(ephemeralSalt()).not.toBe(a);
    expect(StoreSaltError).toBe(SaltError);
  });
});

describe('loadSalt 与原语结论相同(D5:同一个盐文件,处处相同)', () => {
  it('合法盐:原语 ok,loadSalt 返回同一个 salt(persisted)', async () => {
    const m = await mk('salt-ls-ok-');
    await m.put(`${SALT}\n`);
    const r = await readSaltFile(m.state);
    const l = await loadSalt(m.io, { create: false });
    expect(r.kind === 'ok' && l).toEqual({ salt: (r as { salt: string }).salt, persisted: true });
  });

  it('硬链接盐:loadSalt 现在拒绝(收紧,契约 R20-7.2 订正);create:true 也不静默重生成', async () => {
    const m = await mk('salt-ls-hard-');
    await m.put(SALT);
    await hardlink(m.io, m.file, path.join(m.state, 'alias'));
    await expect(loadSalt(m.io, { create: false })).rejects.toThrow(SaltError);
    await expect(loadSalt(m.io, { create: true })).rejects.toThrow(SaltError);
  });

  it('违规表:每一种违规,原语与 loadSalt 都抛 SaltError', async () => {
    for (const [name, body, mode] of BAD.slice(0, 5)) {
      const m = await mk('salt-ls-bad-');
      await m.put(body(), mode);
      await expect(readSaltFile(m.state), name).rejects.toThrow(SaltError);
      await expect(loadSalt(m.io, { create: false }), name).rejects.toThrow(SaltError);
    }
  });

  it('不存在 + create:false → 内存临时盐(不落盘);create:true → 建盐,之后原语读到同一份', async () => {
    const m = await mk('salt-ls-new-');
    const eph = await loadSalt(m.io, { create: false });
    expect(eph.persisted).toBe(false);
    expect(await readSaltFile(m.state)).toEqual({ kind: 'absent' });
    const made = await loadSalt(m.io, { create: true });
    expect(made.persisted).toBe(true);
    const r = await readSaltFile(m.state);
    expect(r).toEqual({ kind: 'ok', salt: made.salt, saltFp: fp(made.salt) });
  });

  it('空文件:loadSalt 有限等待后补上的内容能读到;一直为空 → SaltError(fail-closed)', async () => {
    const m = await mk('salt-ls-empty-');
    await m.put('');
    const p = loadSalt(m.io, { create: false });
    setTimeout(() => {
      void m.put(`${SALT}\n`);
    }, 150);
    expect((await p).salt).toBe(SALT);
    await m.put('');
    await expect(loadSalt(m.io, { create: false })).rejects.toThrow(SaltError);
  }, 10_000);
});
