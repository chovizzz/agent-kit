import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NetError, type FetchLike } from '../../src/io/net.js';
import * as safe from '../../src/io/safe-fs.js';
import { createNetSource, isDeprecated, openRegistrySource } from '../../src/update/registry.js';
import { buildPkg, newWorld, writeRegistry } from './install-world.js';

describe('fixture registry', () => {
  it('KIT_TMP 之外 / 没有 KIT_TMP / 非 file:// 写法 → registry_fixture_outside_tmp', async () => {
    const w = await newWorld();
    expect(await openRegistrySource('file:///usr', w.dir, { env: {} })).toEqual({
      ok: false,
      reason: 'registry_fixture_outside_tmp',
    });
    expect(await openRegistrySource(`file://${w.reg}`, undefined, { env: {} })).toEqual({
      ok: false,
      reason: 'registry_fixture_outside_tmp',
    });
    expect(await openRegistrySource('file:/usr', w.dir, { env: {} })).toMatchObject({ ok: false });
    // 正向对照
    expect(await openRegistrySource(`file://${w.reg}`, w.dir, { env: {} })).toMatchObject({
      ok: true,
    });
  });

  it('夹具目录经符号链接指到 KIT_TMP 之外 → 拒绝', async () => {
    const w = await newWorld();
    await safe.symlink(w.fx, '/usr', path.join(w.dir, 'link')).catch(() => undefined);
    const r = await openRegistrySource(`file://${path.join(w.dir, 'link')}`, w.dir, { env: {} });
    expect(r).toMatchObject({ ok: false });
  });

  it('tarball 路径逃逸 / 绝对路径 / 符号链接 → host_denied;缺失 → http_404', async () => {
    const w = await newWorld();
    await writeRegistry(w, {
      versions: [{ pkg: buildPkg('1.0.0') }],
      distTags: { latest: '1.0.0' },
    });
    const r = await openRegistrySource(`file://${w.reg}`, w.dir, { env: {} });
    if (!r.ok) throw new Error('x');
    const code = async (u: string): Promise<string> => {
      try {
        await r.source.tarball(u);
      } catch (e) {
        return (e as NetError).code;
      }
      return 'ok';
    };
    expect(await code('tarballs/1.0.0.tgz')).toBe('ok');
    expect(await code('../packument.json')).toBe('host_denied');
    expect(await code('/etc/passwd')).toBe('host_denied');
    expect(await code('https://evil.example/x.tgz')).toBe('host_denied');
    expect(await code('tarballs/none.tgz')).toBe('http_404');
    await safe.symlink(
      w.fx,
      path.join(w.dir, 'reg/packument.json'),
      path.join(w.reg, 'tarballs/ln.tgz'),
    );
    expect(await code('tarballs/ln.tgz')).toBe('host_denied');
  });
});

describe('net registry', () => {
  it('https 以外 / 带用户信息 / 带查询 → bad_registry;镜像判定', async () => {
    for (const bad of [
      'http://r.example/',
      'https://u:p@r.example/',
      'https://r.example/?x=1',
      'nonsense',
    ]) {
      expect(await openRegistrySource(bad, undefined, { env: {} })).toEqual({
        ok: false,
        reason: 'bad_registry',
      });
    }
    const m = await openRegistrySource('https://mirror.example/', undefined, { env: {} });
    expect(m).toMatchObject({ ok: true, mirror: true });
    const n = await openRegistrySource('https://registry.npmjs.org/', undefined, { env: {} });
    expect(n).toMatchObject({ ok: true, mirror: false });
  });

  it('packument 请求带 Accept: application/json;镜像时 npmjs 另取一次;attestations 固定 npmjs 主机', async () => {
    const seen: Array<{ url: string; accept: string | undefined }> = [];
    const fetch: FetchLike = async (url, init) => {
      seen.push({ url, accept: init.headers['accept'] });
      return {
        status: url.includes('attestations') ? 404 : 200,
        headers: { get: () => null },
        body: new Response('{"dist-tags":{},"versions":{}}').body,
      };
    };
    const src = createNetSource('https://mirror.example/', { env: {}, fetch });
    await src.packument();
    await src.npmjsPackument();
    expect(await src.attestations('1.0.0')).toEqual({ kind: 'absent' });
    expect(seen.map((s) => new URL(s.url).host)).toEqual([
      'mirror.example',
      'registry.npmjs.org',
      'registry.npmjs.org',
    ]);
    expect(seen[0]?.accept).toBe('application/json');
    expect(seen[0]?.url).toBe('https://mirror.example/@chovizzz%2fagent-kit');
  });

  it('tarball 地址指向镜像之外的主机 → host_denied', async () => {
    const src = createNetSource('https://mirror.example/', {
      env: {},
      fetch: async () => {
        throw new Error('no');
      },
    });
    await expect(src.tarball('https://evil.example/x.tgz')).rejects.toMatchObject({
      code: 'host_denied',
    });
  });
});

describe('isDeprecated', () => {
  it('非空字符串才算;空串 / 缺失 / 别的版本不算', () => {
    const p = {
      versions: { '1.0.0': { deprecated: 'x' }, '1.0.1': { deprecated: '' }, '1.0.2': {} },
    };
    expect(isDeprecated(p, '1.0.0')).toBe(true);
    expect(isDeprecated(p, '1.0.1')).toBe(false);
    expect(isDeprecated(p, '1.0.2')).toBe(false);
    expect(isDeprecated(p, '9.9.9')).toBe(false);
    expect(isDeprecated(null, '1.0.0')).toBe(false);
  });
});
