import { beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyProvenance } from '../../src/update/provenance.js';
import { SAN, baseInput, loadAtt } from './fixtures/provenance-helpers.js';
import type { Json } from './fixtures/provenance-helpers.js';
import { readText } from '../../src/io/read-fs.js';

const verify = vi.hoisted(() => vi.fn());
vi.mock('sigstore', () => ({ verify }));

describe('默认验证器(sigstore.verify 被替换成间谍,看 provenance.ts 实际传了什么)', () => {
  let att: Json;
  beforeEach(async () => {
    att = await loadAtt();
    verify.mockReset();
    verify.mockResolvedValue({
      identity: {
        subjectAlternativeName: SAN,
        extensions: { issuer: 'https://token.actions.githubusercontent.com' },
      },
    });
  });

  it('传给 sigstore.verify 的选项:恰好这几个键,没有 timestampThreshold / tsaThreshold,身份正则锚定', async () => {
    const r = await verifyProvenance(
      baseInput(att, '/cache/dir', { tuf: { cachePath: '/cache/dir', forceCache: true } }),
    );
    expect(r.ok).toBe(true);
    expect(verify).toHaveBeenCalledTimes(1);
    const [bundle, options] = verify.mock.calls[0] as [Json, Json];
    expect(bundle.dsseEnvelope.payloadType).toBe('application/vnd.in-toto+json');
    expect(Object.keys(options).sort()).toEqual(
      [
        'certificateIdentityURI',
        'certificateIssuer',
        'retry',
        'timeout',
        'tufCachePath',
        'tufForceCache',
        'tufMirrorURL',
      ].sort(),
    );
    expect(options['certificateIdentityURI']).toMatch(/^\^.*\$$/);
    expect(options['tufCachePath']).toBe('/cache/dir');
    expect(options['tufMirrorURL']).toBe('https://tuf-repo-cdn.sigstore.dev');
    expect(options['tufForceCache']).toBe(true);
  });

  it('sigstore 返回的 identity 缺 SAN → provenance_identity(默认验证器同样要求可复核)', async () => {
    verify.mockResolvedValue({ identity: {} });
    expect((await verifyProvenance(baseInput(att, '/c'))).reason).toBe('provenance_identity');
  });

  it('sigstore 抛 TUFError → tuf_unreachable', async () => {
    const e = new Error('error refreshing TUF metadata');
    e.name = 'TUFError';
    verify.mockRejectedValue(e);
    expect((await verifyProvenance(baseInput(att, '/c'))).reason).toBe('tuf_unreachable');
  });

  it('源码级回归:provenance.ts 的非注释行里不出现 timestampThreshold / tsaThreshold', async () => {
    const src = await readText(new URL('../../src/update/provenance.ts', import.meta.url).pathname);
    const code = src
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\/?\*)/.test(l))
      .join('\n');
    expect(code.length).toBeGreaterThan(1000);
    expect(code).not.toMatch(/timestampThreshold|tsaThreshold/);
  });

  it('源码级:sigstore 只在 provenance.ts 里被引用(其余 src 文件的 import 语句不含 sigstore)', async () => {
    const { readDir } = await import('../../src/io/read-fs.js');
    const root = new URL('../../src/', import.meta.url).pathname;
    const hits: string[] = [];
    const walk = async (rel: string): Promise<void> => {
      for (const e of await readDir(`${root}${rel}`)) {
        const r = rel === '' ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory) await walk(r);
        else if (
          r.endsWith('.ts') &&
          /(from|import)\s*\(?\s*['"]@?sigstore/.test(await readText(`${root}${r}`))
        )
          hits.push(r);
      }
    };
    await walk('');
    expect(hits).toEqual(['update/provenance.ts']);
  });
});
