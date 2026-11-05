import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBytes } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import {
  binEntryOf,
  checkPackage,
  sriMatches,
  staticSmoke,
  verifyInstalledTree,
} from '../../src/update/install.js';
import { readTgz, type TarListing } from '../../src/update/tar.js';
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
    // D-AU3:权限位不是判据——npm pack 出来的 bin 是 0644,真实发布版必须能通过(此前要求 0755 → 每个真实版本被误拉黑)
    const notExec = buildPkg('1.2.3', {
      edit: (f) => f.map((x) => (x.path === 'dist/cli.js' ? { ...x, mode: 0o644 } : x)),
    });
    expect(staticSmoke(readTgz(notExec.tgz))).toEqual({ ok: true });
    const noShebang = buildPkg('1.2.3', {
      edit: (f) =>
        f.map((x) => (x.path === 'dist/cli.js' ? { ...x, data: "console.log('x');\n" } : x)),
    });
    expect(staticSmoke(readTgz(noShebang.tgz))).toEqual({ ok: false, detail: 'bin_shebang' });
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

  it('binExecutable(D-AU3):bin 不是 0755 → bin_mode;不给该选项时不看权限', async () => {
    const { p, root } = await laidOut(); // laidOut 以默认 0644 写文件
    expect(await verifyInstalledTree(root, { anchor: p.anchor })).toMatchObject({ ok: true });
    expect(
      await verifyInstalledTree(root, { anchor: p.anchor, binExecutable: 'dist/cli.js' }),
    ).toEqual({ ok: false, reason: 'bin_mode' });
    expect(
      await verifyInstalledTree(root, { anchor: p.anchor, binExecutable: 'dist/missing.js' }),
    ).toEqual({ ok: false, reason: 'bin_mode' });
  });

  it('binExecutable:掩码是 0o7777,精确等于 0755;04755 / 02755 / 01755 / 0775 / 0700 都不合格', async () => {
    const { w, p, root } = await laidOut();
    const bin = path.join(root, 'dist/cli.js');
    const check = (): ReturnType<typeof verifyInstalledTree> =>
      verifyInstalledTree(root, { anchor: p.anchor, binExecutable: 'dist/cli.js' });
    await safe.chmod(w.fx, bin, 0o755);
    expect(await check()).toEqual({ ok: true, anchor: p.anchor }); // 正向对照
    for (const mode of [0o4755, 0o2755, 0o1755, 0o775, 0o700, 0o644]) {
      await safe.chmod(w.fx, bin, mode);
      expect(await check(), mode.toString(8)).toEqual({ ok: false, reason: 'bin_mode' });
    }
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

describe('binEntryOf(D-AU3:静态冒烟与 staging 提权共用的 bin 入口判定)', () => {
  const listingOf = (pkgJson: string | undefined): TarListing => ({
    files:
      pkgJson === undefined
        ? []
        : [{ path: 'package.json', mode: 0o644, bytes: Buffer.from(pkgJson) }],
    dirs: [],
  });
  const withBin = (bin: unknown): string =>
    JSON.stringify({ name: '@chovizzz/agent-kit', version: '1.2.3', bin });

  const CASES: [string, string | undefined, string | undefined][] = [
    ['字符串形态', withBin('dist/cli.js'), 'dist/cli.js'],
    ['对象形态(agent-kit 键)', withBin({ 'agent-kit': 'dist/cli.js' }), 'dist/cli.js'],
    ['对象形态,子目录', withBin({ 'agent-kit': 'dist/bin/run.js' }), 'dist/bin/run.js'],
    ['对象缺 agent-kit 键', withBin({ other: 'dist/cli.js' }), undefined],
    ['没有 bin 字段', JSON.stringify({ name: 'x' }), undefined],
    ['bin 为 null', withBin(null), undefined],
    ['bin 为数组', withBin(['dist/cli.js']), undefined],
    ['bin 为数字', withBin(1), undefined],
    ['值不是字符串', withBin({ 'agent-kit': 5 }), undefined],
    ['越界路径 ../x', withBin({ 'agent-kit': '../x' }), undefined],
    ['含 .. 段', withBin({ 'agent-kit': 'dist/../x.js' }), undefined],
    ['不在 dist/ 下', withBin('src/cli.js'), undefined],
    ['绝对路径', withBin('/etc/passwd'), undefined],
    ['含空格(非可见 ASCII)', withBin('dist/a b.js'), undefined],
    ['package.json 不是合法 JSON', '{', undefined],
    ['package.json 是 null', 'null', undefined],
    ['没有 package.json', undefined, undefined],
  ];

  it.each(CASES)('%s', (_name, pkgJson, want) => {
    expect(binEntryOf(listingOf(pkgJson))).toBe(want);
  });

  it('静态冒烟用的就是这个入口:入口文件缺失 → bin_missing;形态非法 → bin_entry;合法且有 shebang → 通过', () => {
    const files = (pkgJson: string, extra: { path: string; data: string }[]): TarListing => ({
      files: [
        { path: 'package.json', mode: 0o644, bytes: Buffer.from(pkgJson) },
        ...extra.map((e) => ({ path: e.path, mode: 0o644 as const, bytes: Buffer.from(e.data) })),
      ],
      dirs: [],
    });
    const ok = files(withBin({ 'agent-kit': 'dist/alt.js' }), [
      { path: 'dist/alt.js', data: '#!/usr/bin/env node\n' },
      { path: 'dist/cli.js', data: 'no shebang' },
    ]);
    expect(binEntryOf(ok)).toBe('dist/alt.js');
    expect(staticSmoke(ok)).toEqual({ ok: true }); // 判的是 alt.js(cli.js 没有 shebang 也不影响)
    expect(staticSmoke(files(withBin('dist/alt.js'), []))).toEqual({
      ok: false,
      detail: 'bin_missing',
    });
    expect(staticSmoke(files(withBin('../x'), []))).toEqual({ ok: false, detail: 'bin_entry' });
  });
});
