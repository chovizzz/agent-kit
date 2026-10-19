import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBytes } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import {
  checkPackage,
  sriMatches,
  staticSmoke,
  verifyInstalledTree,
} from '../../src/update/install.js';
import { readTgz } from '../../src/update/tar.js';
import { buildPkg, newWorld, sha512 } from './install-world.js';

describe('sriMatches', () => {
  const hex = sha512('x');
  const b64 = Buffer.from(hex, 'hex').toString('base64');
  it('单个 / 多个 sha512 摘要都必须等于 tarball;没有 sha512 摘要不算通过', () => {
    expect(sriMatches(`sha512-${b64}`, hex)).toBe(true);
    expect(sriMatches(`sha1-AAAA sha512-${b64}`, hex)).toBe(true);
    expect(sriMatches(`sha512-${b64} sha512-${Buffer.alloc(64).toString('base64')}`, hex)).toBe(
      false,
    );
    expect(sriMatches(`sha512-${Buffer.alloc(64).toString('base64')}`, hex)).toBe(false);
    expect(sriMatches('sha1-AAAA', hex)).toBe(false);
    expect(sriMatches(undefined, hex)).toBe(false);
    expect(sriMatches('sha512-!!!', hex)).toBe(false);
  });
});

describe('checkPackage / staticSmoke', () => {
  it('合法包通过,anchor = integrity.json 原字节的 sha256', () => {
    const p = buildPkg('1.2.3');
    const r = checkPackage(readTgz(p.tgz), '1.2.3');
    expect(r).toMatchObject({ ok: true, anchor: p.anchor });
    expect(staticSmoke(readTgz(p.tgz))).toEqual({ ok: true });
  });

  it('文件名含空格 / 非 ASCII → path_not_ascii', () => {
    const p = buildPkg('1.2.3', { edit: (f) => [...f, { path: 'a b.txt', data: 'x' }] });
    expect(checkPackage(readTgz(p.tgz), '1.2.3')).toEqual({ ok: false, detail: 'path_not_ascii' });
  });

  it('integrity.json 自身字节被改一位(内容仍合法)→ anchor 随之改变,而不是沿用旧值', () => {
    const a = buildPkg('1.2.3');
    const b = buildPkg('1.2.3', { integrity: (o) => ({ ...o }) });
    expect(a.anchor).toBe(b.anchor);
    const c = buildPkg('1.2.3', { edit: (f) => [...f, { path: 'z.txt', data: 'z' }] });
    expect(c.anchor).not.toBe(a.anchor);
  });

  it('bin 缺失 / 不可执行 / 指向 dist 之外', () => {
    const noBin = buildPkg('1.2.3', {
      edit: (f) =>
        f.map((x) =>
          x.path === 'package.json'
            ? { ...x, data: '{"name":"@chovizzz/agent-kit","version":"1.2.3"}' }
            : x,
        ),
    });
    expect(staticSmoke(readTgz(noBin.tgz))).toEqual({ ok: false, detail: 'bin_entry' });
    const notExec = buildPkg('1.2.3', {
      edit: (f) => f.map((x) => (x.path === 'dist/cli.js' ? { ...x, mode: 0o644 } : x)),
    });
    expect(staticSmoke(readTgz(notExec.tgz))).toEqual({ ok: false, detail: 'bin_not_executable' });
    const outside = buildPkg('1.2.3', {
      edit: (f) =>
        f.map((x) =>
          x.path === 'package.json'
            ? {
                ...x,
                data: '{"name":"@chovizzz/agent-kit","version":"1.2.3","bin":{"agent-kit":"../x"}}',
              }
            : x,
        ),
    });
    expect(staticSmoke(readTgz(outside.tgz))).toEqual({ ok: false, detail: 'bin_entry' });
  });
});

describe('verifyInstalledTree', () => {
  async function laidOut() {
    const w = await newWorld();
    const p = buildPkg('1.2.3');
    const root = path.join(w.dir, 'tree');
    for (const f of readTgz(p.tgz).files) {
      await safe.mkdirp(w.fx, path.dirname(path.join(root, f.path)));
      await safe.writeFile(w.fx, path.join(root, f.path), f.bytes);
    }
    return { w, p, root };
  }

  it('完整的树通过;锚点不符 / 版本不符被拒(正向对照在前)', async () => {
    const { p, root } = await laidOut();
    expect(await verifyInstalledTree(root, { anchor: p.anchor, version: '1.2.3' })).toEqual({
      ok: true,
      anchor: p.anchor,
    });
    expect(await verifyInstalledTree(root, { anchor: '0'.repeat(64) })).toMatchObject({
      reason: 'anchor_mismatch',
    });
    expect(await verifyInstalledTree(root, { version: '9.9.9' })).toMatchObject({
      reason: 'version_mismatch',
    });
  });

  it('改文件 / 多文件 / 少文件 / 符号链接 / integrity.json 缺失', async () => {
    const a = await laidOut();
    await safe.writeFile(a.w.fx, path.join(a.root, 'dist/main.js'), 'tampered');
    expect(await verifyInstalledTree(a.root)).toMatchObject({ reason: 'file_mismatch' });
    const b = await laidOut();
    await safe.writeFile(b.w.fx, path.join(b.root, 'extra.js'), 'x');
    expect(await verifyInstalledTree(b.root)).toMatchObject({ reason: 'file_set' });
    const c = await laidOut();
    await safe.remove(c.w.fx, path.join(c.root, 'LICENSE'));
    expect(await verifyInstalledTree(c.root)).toMatchObject({ reason: 'file_set' });
    const d = await laidOut();
    await safe.symlink(d.w.fx, path.join(d.root, 'README.md'), path.join(d.root, 'link'));
    expect(await verifyInstalledTree(d.root)).toMatchObject({ reason: 'irregular' });
    const e = await laidOut();
    await safe.remove(e.w.fx, path.join(e.root, 'integrity.json'));
    expect(await verifyInstalledTree(e.root)).toMatchObject({ reason: 'integrity_missing' });
    expect((await readBytes(path.join(a.root, 'package.json'))).byteLength).toBeGreaterThan(0);
  });
});
