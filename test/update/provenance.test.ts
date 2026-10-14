import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FULCIO_ISSUER_GITHUB_ACTIONS,
  classifyVerifyError,
  escapeRegExp,
  verifyProvenance,
} from '../../src/update/provenance.js';
import type { ProvenanceResult } from '../../src/update/provenance.js';
import {
  PUBLISH,
  RC0_INTEGRATED_SECS,
  RC0_SHA,
  SAN,
  SLSA,
  VERSION,
  baseInput,
  clone,
  decodeStatement,
  editBundle,
  editStatement,
  fakeVerifier,
  freezeClock,
  loadAtt,
  namedError,
  newTempDir,
  seedTufCache,
  slsaOf,
} from './fixtures/provenance-helpers.js';
import type { Json } from './fixtures/provenance-helpers.js';

function reason(r: ProvenanceResult): string {
  return r.reason;
}

describe('verifyProvenance(假验证器,验证 provenance.ts 自己的判定逻辑)', () => {
  let att: Json;
  beforeEach(async () => {
    att = await loadAtt();
  });

  it('正向控制组:假验证器返回正确身份 → ok,带 SAN 与 integratedTime(毫秒)', async () => {
    const { verifier, calls } = fakeVerifier();
    const r = await verifyProvenance(baseInput(att, '/c', { verifier }));
    expect(r).toEqual({
      ok: true,
      reason: 'ok',
      subjectAlternativeName: SAN,
      integratedTimeMs: RC0_INTEGRATED_SECS * 1000,
    });
    expect(calls).toHaveLength(1);
  });

  describe('传给验证器的策略', () => {
    it('身份正则被锚定并转义:^…$,点号 / 斜杠 / 连字符都转义,issuer 钉死 GitHub Actions', async () => {
      const { verifier, calls } = fakeVerifier();
      await verifyProvenance(baseInput(att, '/c', { verifier }));
      const o = calls[0]!.options;
      expect(o.certificateIdentityURI).toBe(`^${escapeRegExp(SAN)}$`);
      expect(o.certificateIdentityURI.startsWith('^')).toBe(true);
      expect(o.certificateIdentityURI.endsWith('$')).toBe(true);
      // 转义后的正则只匹配 SAN 本身:前缀 / 后缀 / 点号通配都不行
      const re = new RegExp(o.certificateIdentityURI);
      expect(re.test(SAN)).toBe(true);
      expect(re.test(`${SAN}1`)).toBe(false);
      expect(re.test(`x${SAN}`)).toBe(false);
      expect(re.test(SAN.replace('v0.1.0-rc.0', 'v0x1x0-rc.0'))).toBe(false);
      expect(re.test(SAN.replace('chovizzz', 'chovizzy'))).toBe(false);
      expect(o.certificateIssuer).toBe(FULCIO_ISSUER_GITHUB_ACTIONS);
    });

    it('🔴 timestampThreshold 旧漏洞回归:不得向验证器传 timestampThreshold / tsaThreshold(传 0 会让无时间戳 bundle 通过)', async () => {
      const { verifier, calls } = fakeVerifier();
      await verifyProvenance(baseInput(att, '/c', { verifier }));
      const keys = Object.keys(calls[0]!.options).sort();
      expect(keys).toEqual(
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
      expect(JSON.stringify(calls[0]!.options)).not.toMatch(/timestampThreshold|tsaThreshold/);
    });

    it('验证器收到的是被选中的那条 SLSA bundle 的深拷贝(不是 publish 条、不是原对象)', async () => {
      const { verifier, calls } = fakeVerifier();
      await verifyProvenance(baseInput(att, '/c', { verifier }));
      expect(calls[0]!.bundle).toEqual(slsaOf(att)['bundle']);
      expect(calls[0]!.bundle).not.toBe(slsaOf(att)['bundle']);
    });

    it('TUF 配置原样传递(缓存目录 / mirror / forceCache / 超时 / 重试)', async () => {
      const { verifier, calls } = fakeVerifier();
      await verifyProvenance(
        baseInput(att, '/c', {
          verifier,
          tuf: {
            cachePath: '/cache/x',
            mirrorURL: 'https://m.example',
            forceCache: true,
            timeoutMs: 1234,
            retries: 3,
          },
        }),
      );
      expect(calls[0]!.options).toMatchObject({
        tufCachePath: '/cache/x',
        tufMirrorURL: 'https://m.example',
        tufForceCache: true,
        timeout: 1234,
        retry: 3,
      });
    });
  });

  describe('身份(provenance_identity)', () => {
    const wrong: Array<[string, string | undefined]> = [
      [
        '别的仓库',
        'https://github.com/evil/agent-kit/.github/workflows/release.yml@refs/tags/v0.1.0-rc.0',
      ],
      [
        '别的 workflow',
        'https://github.com/chovizzz/agent-kit/.github/workflows/other.yml@refs/tags/v0.1.0-rc.0',
      ],
      [
        '别的 tag',
        'https://github.com/chovizzz/agent-kit/.github/workflows/release.yml@refs/tags/v9.9.9',
      ],
      ['SAN 多一个后缀', `${SAN}x`],
      ['SAN 缺失', undefined],
    ];
    for (const [label, san] of wrong) {
      it(`验证器放行但返回的 SAN 不等于钉死值(${label})→ provenance_identity`, async () => {
        const { verifier } = fakeVerifier({
          subjectAlternativeName: san,
          issuer: FULCIO_ISSUER_GITHUB_ACTIONS,
        });
        expect(reason(await verifyProvenance(baseInput(att, '/c', { verifier })))).toBe(
          'provenance_identity',
        );
      });
    }

    it('issuer 不是 GitHub Actions / 缺失 → provenance_identity', async () => {
      for (const issuer of ['https://accounts.google.com', undefined]) {
        const { verifier } = fakeVerifier({ subjectAlternativeName: SAN, issuer });
        expect(reason(await verifyProvenance(baseInput(att, '/c', { verifier })))).toBe(
          'provenance_identity',
        );
      }
    });

    it('验证器返回 undefined(无法复核身份)→ provenance_identity,不放行', async () => {
      const { verifier } = fakeVerifier('none');
      expect(reason(await verifyProvenance(baseInput(att, '/c', { verifier })))).toBe(
        'provenance_identity',
      );
    });

    it('statement 的 subject 名不是本包本版本(换版本重放)→ provenance_identity', async () => {
      const { verifier } = fakeVerifier();
      const d = editStatement(att, (st) => {
        st['subject'][0].name = 'pkg:npm/%40chovizzz/agent-kit@0.0.9';
      });
      expect(reason(await verifyProvenance(baseInput(d, '/c', { verifier })))).toBe(
        'provenance_identity',
      );
      // 包名不符同理
      const { verifier: v2 } = fakeVerifier();
      expect(
        reason(
          await verifyProvenance(baseInput(att, '/c', { verifier: v2, pkgName: '@other/pkg' })),
        ),
      ).toBe('provenance_identity');
    });

    for (const key of ['repository', 'path', 'ref'] as const) {
      it(`predicate.workflow.${key} 与 SAN 不一致 → provenance_identity`, async () => {
        const { verifier } = fakeVerifier();
        const d = editStatement(att, (st) => {
          st['predicate'].buildDefinition.externalParameters.workflow[key] += 'X';
        });
        expect(reason(await verifyProvenance(baseInput(d, '/c', { verifier })))).toBe(
          'provenance_identity',
        );
      });
    }
  });

  describe('摘要(integrity)', () => {
    it('tarball 摘要与已验签 statement 的 sha512 不符 → integrity', async () => {
      const { verifier } = fakeVerifier();
      const bad = '00' + RC0_SHA.slice(2);
      expect(
        reason(await verifyProvenance(baseInput(att, '/c', { verifier, tarballSha512Hex: bad }))),
      ).toBe('integrity');
    });

    it('statement 里的摘要被改(假验证器模拟「签名没验出来」时仍由摘要比对兜住)→ integrity', async () => {
      const { verifier } = fakeVerifier();
      const d = editStatement(att, (st) => {
        st['subject'][0].digest.sha512 = '11' + RC0_SHA.slice(2);
      });
      expect(reason(await verifyProvenance(baseInput(d, '/c', { verifier })))).toBe('integrity');
    });

    it('大写十六进制的 tarball 摘要也能比对', async () => {
      const { verifier } = fakeVerifier();
      const r = await verifyProvenance(
        baseInput(att, '/c', { verifier, tarballSha512Hex: RC0_SHA.toUpperCase() }),
      );
      expect(r.ok).toBe(true);
    });

    it('同名 subject 出现两次,只要有一个摘要不符 → integrity(不能靠多塞一条放行)', async () => {
      const { verifier } = fakeVerifier();
      const d = editStatement(att, (st) => {
        st['subject'].push({
          name: st['subject'][0].name,
          digest: { sha512: '22' + RC0_SHA.slice(2) },
        });
      });
      expect(reason(await verifyProvenance(baseInput(d, '/c', { verifier })))).toBe('integrity');
    });
  });

  describe('statement 选择(provenance_missing / bundle)', () => {
    it('只有 publish v0.1 条、没有 SLSA 条 → provenance_missing', async () => {
      const { verifier, calls } = fakeVerifier();
      const d = clone(att);
      d['attestations'] = d['attestations'].filter((a: Json) => a['predicateType'] === PUBLISH);
      expect(reason(await verifyProvenance(baseInput(d, '/c', { verifier })))).toBe(
        'provenance_missing',
      );
      expect(calls).toHaveLength(0);
    });

    it('attestations 为空数组 → provenance_missing', async () => {
      const { verifier } = fakeVerifier();
      expect(
        reason(await verifyProvenance(baseInput({ attestations: [] }, '/c', { verifier }))),
      ).toBe('provenance_missing');
    });

    it('外层 predicateType 被改成别的 / payloadType 不是 in-toto → provenance_missing(不会拿别的条顶替)', async () => {
      const { verifier } = fakeVerifier();
      const d1 = clone(att);
      slsaOf(d1)['predicateType'] = 'https://example.com/other';
      expect(reason(await verifyProvenance(baseInput(d1, '/c', { verifier })))).toBe(
        'provenance_missing',
      );
      const d2 = editBundle(att, (b) => {
        b.dsseEnvelope.payloadType = 'text/plain';
      });
      expect(reason(await verifyProvenance(baseInput(d2, '/c', { verifier })))).toBe(
        'provenance_missing',
      );
    });

    it('用 publish 条的 bundle 冒充 SLSA 条(外层谎报 predicateType)→ 被验证器拒(假验证器模拟其签名者不符)', async () => {
      const d = clone(att);
      const publish = d['attestations'].find((a: Json) => a['predicateType'] === PUBLISH) as Json;
      publish['predicateType'] = SLSA;
      d['attestations'] = [publish];
      // publish 条的 payload 里 predicateType 是 publish v0.1,statement 类型核对必须挡住它,即使验证器(假)放行
      const { verifier } = fakeVerifier();
      expect(reason(await verifyProvenance(baseInput(d, '/c', { verifier })))).toBe('bundle');
    });

    it('两条 SLSA 条(含一条恶意的)→ bundle,不挑一条放行', async () => {
      const { verifier, calls } = fakeVerifier();
      const d = clone(att);
      d['attestations'].push(clone(slsaOf(att)));
      expect(reason(await verifyProvenance(baseInput(d, '/c', { verifier })))).toBe('bundle');
      expect(calls).toHaveLength(0);
    });

    it('文档结构不对(缺 attestations / 元素不是对象)→ bundle', async () => {
      const { verifier } = fakeVerifier();
      for (const doc of [null, 'x', {}, { attestations: 'x' }, { attestations: [1] }]) {
        expect(reason(await verifyProvenance(baseInput(doc, '/c', { verifier })))).toBe('bundle');
      }
    });

    it('payload 不是合法 JSON statement / _type 不对 / 没有 subject → bundle', async () => {
      const { verifier } = fakeVerifier();
      const junk = clone(att);
      slsaOf(junk)['bundle'].dsseEnvelope.payload = Buffer.from('not json').toString('base64');
      expect(reason(await verifyProvenance(baseInput(junk, '/c', { verifier })))).toBe('bundle');
      for (const edit of [
        (st: Json) => {
          st['_type'] = 'https://example.com/Statement';
        },
        (st: Json) => {
          st['predicateType'] = PUBLISH;
        },
        (st: Json) => {
          st['subject'] = [];
        },
        (st: Json) => {
          delete st['predicate'];
        },
      ]) {
        expect(
          reason(await verifyProvenance(baseInput(editStatement(att, edit), '/c', { verifier }))),
        ).toBe('bundle');
      }
    });
  });

  describe('时间戳证据(bundle)', () => {
    it('删掉所有 inclusionPromise(SET)且无 RFC3161 → bundle,验证器根本不被调用', async () => {
      const { verifier, calls } = fakeVerifier();
      const d = editBundle(att, (b) => {
        for (const t of b.verificationMaterial.tlogEntries) delete t.inclusionPromise;
      });
      expect(reason(await verifyProvenance(baseInput(d, '/c', { verifier })))).toBe('bundle');
      expect(calls).toHaveLength(0);
    });

    it('删掉 tlogEntries 整个字段 / 改成空数组 → bundle', async () => {
      const { verifier } = fakeVerifier();
      for (const edit of [
        (b: Json) => {
          delete b.verificationMaterial.tlogEntries;
        },
        (b: Json) => {
          b.verificationMaterial.tlogEntries = [];
        },
        (b: Json) => {
          delete b.verificationMaterial;
        },
      ]) {
        expect(
          reason(await verifyProvenance(baseInput(editBundle(att, edit), '/c', { verifier }))),
        ).toBe('bundle');
      }
    });

    it('integratedTime 不是正整数字符串的条目不算时间戳证据', async () => {
      const { verifier } = fakeVerifier();
      for (const bad of ['0', '-5', 'abc', '']) {
        const d = editBundle(att, (b) => {
          b.verificationMaterial.tlogEntries[0].integratedTime = bad;
        });
        expect(reason(await verifyProvenance(baseInput(d, '/c', { verifier })))).toBe('bundle');
      }
    });

    it('只有 RFC3161 时间戳(没有 SET)→ 放行但 integratedTimeMs 为 undefined(没有 SET 背书就不报时间)', async () => {
      const { verifier } = fakeVerifier();
      const d = editBundle(att, (b) => {
        for (const t of b.verificationMaterial.tlogEntries) delete t.inclusionPromise;
        b.verificationMaterial.timestampVerificationData = {
          rfc3161Timestamps: [{ signedTimestamp: 'AA==' }],
        };
      });
      const r = await verifyProvenance(baseInput(d, '/c', { verifier }));
      expect(r).toMatchObject({ ok: true, integratedTimeMs: undefined });
    });
  });

  describe('库抛错的归类(稳定原因码)', () => {
    const table: Array<[string, Error, string]> = [
      [
        'TUFError(网络)',
        namedError('TUFError', 'error refreshing TUF metadata', {
          code: 'TUF_REFRESH_METADATA_ERROR',
          cause: new Error('fetch failed'),
        }),
        'tuf_unreachable',
      ],
      [
        'TUFError(元数据过期)→ 信任根陈旧',
        namedError('TUFError', 'error refreshing TUF metadata', {
          code: 'TUF_REFRESH_METADATA_ERROR',
          cause: new Error('Final timestamp.json is expired'),
        }),
        'trust_root_stale',
      ],
      [
        'TUFError(缺种子 root)',
        namedError('TUFError', 'No root.json found for mirror: x', {
          code: 'TUF_INIT_CACHE_ERROR',
        }),
        'tuf_unreachable',
      ],
      [
        '缓存目录不可写(ENOSPC)',
        Object.assign(new Error('no space'), { code: 'ENOSPC' }),
        'tuf_unreachable',
      ],
      [
        '缓存目录不可写(EACCES)',
        Object.assign(new Error('denied'), { code: 'EACCES' }),
        'tuf_unreachable',
      ],
      [
        'PolicyError',
        namedError('PolicyError', 'certificate identity error', { code: 'UNTRUSTED_SIGNER_ERROR' }),
        'provenance_identity',
      ],
      [
        'VerificationError UNTRUSTED_SIGNER_ERROR',
        namedError('VerificationError', 'x', { code: 'UNTRUSTED_SIGNER_ERROR' }),
        'provenance_identity',
      ],
      [
        'VerificationError 证书链无受信路径 → 信任根陈旧',
        namedError('VerificationError', 'Failed to verify certificate chain', {
          code: 'CERTIFICATE_ERROR',
          cause: new Error('no trusted certificate path found'),
        }),
        'trust_root_stale',
      ],
      [
        'VerificationError 签名错',
        namedError('VerificationError', 'signature verification failed', {
          code: 'SIGNATURE_ERROR',
        }),
        'bundle',
      ],
      [
        'VerificationError 缺时间戳',
        namedError('VerificationError', 'expected 1 timestamps, got 0', {
          code: 'TIMESTAMP_ERROR',
        }),
        'bundle',
      ],
      [
        'VerificationError tlog 体不符',
        namedError('VerificationError', 'DSSE payload hash mismatch', { code: 'TLOG_BODY_ERROR' }),
        'bundle',
      ],
      [
        'VerificationError 证书有效期',
        namedError(
          'VerificationError',
          'certificate is not valid or expired at the specified date',
          { code: 'CERTIFICATE_ERROR' },
        ),
        'bundle',
      ],
      [
        'ValidationError(bundle 校验)',
        namedError('ValidationError', 'invalid v0.2 bundle', { code: 'x' }),
        'bundle',
      ],
      [
        'TypeError(bundle 残缺)',
        new TypeError("Cannot read properties of undefined (reading 'tlogEntries')"),
        'bundle',
      ],
      ['未知异常', new Error('boom'), 'bundle'],
    ];
    for (const [label, err, expected] of table) {
      it(`${label} → ${expected}`, async () => {
        const { verifier } = fakeVerifier(err);
        const r = await verifyProvenance(baseInput(att, '/c', { verifier }));
        expect(r.ok).toBe(false);
        expect(reason(r)).toBe(expected);
      });
    }

    it('非 Error 的抛出值(字符串)→ bundle,不崩', () => {
      expect(classifyVerifyError('weird').reason).toBe('bundle');
      expect(classifyVerifyError(undefined).reason).toBe('bundle');
    });

    it('TUF 失败 + fail-closed:fallbackToCache 默认关,失败就是失败,不会重试成放行', async () => {
      const { verifier, calls } = fakeVerifier(
        namedError('TUFError', 'x', {
          code: 'TUF_REFRESH_METADATA_ERROR',
          cause: new Error('fetch failed'),
        }),
      );
      const r = await verifyProvenance(
        baseInput(att, '/c', { verifier, tuf: { cachePath: '/c' } }),
      );
      expect(reason(r)).toBe('tuf_unreachable');
      expect(calls).toHaveLength(1);
    });

    it('fallbackToCache 打开:首轮 TUF 失败 → 第二轮 forceCache 重试;重试成功才放行,且第一轮不是 forceCache', async () => {
      const calls: boolean[] = [];
      const verifier = async (_b: unknown, o: { tufForceCache: boolean }) => {
        calls.push(o.tufForceCache);
        if (!o.tufForceCache) {
          throw namedError('TUFError', 'x', {
            code: 'TUF_REFRESH_METADATA_ERROR',
            cause: new Error('fetch failed'),
          });
        }
        return { subjectAlternativeName: SAN, issuer: FULCIO_ISSUER_GITHUB_ACTIONS };
      };
      const r = await verifyProvenance(
        baseInput(att, '/c', { verifier, tuf: { cachePath: '/c', fallbackToCache: true } }),
      );
      expect(r.ok).toBe(true);
      expect(calls).toEqual([false, true]);
    });

    it('fallbackToCache 打开但回退也失败 → 仍然拒绝(用第二次的原因)', async () => {
      const verifier = async (_b: unknown, o: { tufForceCache: boolean }) => {
        throw namedError('TUFError', 'x', {
          code: 'TUF_REFRESH_METADATA_ERROR',
          cause: new Error(o.tufForceCache ? 'Final timestamp.json is expired' : 'fetch failed'),
        });
      };
      const r = await verifyProvenance(
        baseInput(att, '/c', { verifier, tuf: { cachePath: '/c', fallbackToCache: true } }),
      );
      expect(reason(r)).toBe('trust_root_stale');
    });

    it('回退只针对 tuf_unreachable:验签类失败(bundle)不会触发回退重试', async () => {
      const { verifier, calls } = fakeVerifier(
        namedError('VerificationError', 'signature verification failed', {
          code: 'SIGNATURE_ERROR',
        }),
      );
      await verifyProvenance(
        baseInput(att, '/c', { verifier, tuf: { cachePath: '/c', fallbackToCache: true } }),
      );
      expect(calls).toHaveLength(1);
    });
  });

  describe('入参校验(调用方 bug 直接抛,不返回结果)', () => {
    it('非法 version / 非法摘要 / 缺 cachePath → TypeError', async () => {
      const { verifier } = fakeVerifier();
      await expect(
        verifyProvenance(baseInput(att, '/c', { verifier, version: '1.0.0/../x' })),
      ).rejects.toThrow(TypeError);
      await expect(
        verifyProvenance(baseInput(att, '/c', { verifier, tarballSha512Hex: 'abcd' })),
      ).rejects.toThrow(TypeError);
      await expect(
        verifyProvenance(baseInput(att, '/c', { verifier, tuf: { cachePath: '' } })),
      ).rejects.toThrow(TypeError);
    });
  });
});

describe('verifyProvenance(真实 sigstore 验证器 + 夹具里的 TUF 缓存,全程离线)', () => {
  let att: Json;
  let cachePath: string;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    freezeClock();
    att = await loadAtt();
    const { ctx, dir } = await newTempDir('prov-real-');
    cachePath = await seedTufCache(ctx, dir);
    // 任何联网尝试都会被记录并失败:forceCache 路径不应该碰网络
    fetchSpy = vi.fn(async () => {
      throw new Error('network is forbidden in tests');
    });
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const run = (doc: unknown, over: Parameters<typeof baseInput>[2] = {}) =>
    verifyProvenance(baseInput(doc, cachePath, over));

  it('正确身份 + 真实 rc.0 bundle → ok;integratedTime 来自 SET 背书;没碰网络', async () => {
    const r = await run(att);
    expect(r).toEqual({
      ok: true,
      reason: 'ok',
      subjectAlternativeName: SAN,
      integratedTimeMs: RC0_INTEGRATED_SECS * 1000,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  const identities: Array<
    [string, Partial<{ repository: string; workflow: string; ref: string }>]
  > = [
    ['别的仓库', { repository: 'https://github.com/evil/agent-kit' }],
    ['别的 workflow', { workflow: '.github/workflows/other.yml' }],
    ['别的 tag', { ref: 'refs/tags/v9.9.9' }],
    ['tag 是真实 tag 的前缀(未锚定正则会放行)', { ref: 'refs/tags/v0.1.0' }],
    ['tag 是真实 tag 的子串', { ref: 'refs/tags/v0.1.0-rc.' }],
  ];
  for (const [label, over] of identities) {
    it(`钉死的身份换成「${label}」→ provenance_identity`, async () => {
      const r = await run(att, {
        identity: {
          repository: 'https://github.com/chovizzz/agent-kit',
          workflow: '.github/workflows/release.yml',
          ref: `refs/tags/v${VERSION}`,
          ...over,
        },
      });
      expect(reason(r)).toBe('provenance_identity');
    });
  }

  it('版本号换成别的(SAN 随之变)→ provenance_identity', async () => {
    expect(reason(await run(att, { version: '0.1.0-rc.1' }))).toBe('provenance_identity');
  });

  it('改 payload(statement 里的摘要)→ bundle(库验出 DSSE 摘要与 tlog 不符),而不是放行', async () => {
    const d = editStatement(att, (st) => {
      st['subject'][0].digest.sha512 = '00' + RC0_SHA.slice(2);
    });
    const r = await run(d, { tarballSha512Hex: '00' + RC0_SHA.slice(2) });
    expect(reason(r)).toBe('bundle');
  });

  it('改 DSSE 签名 → bundle', async () => {
    const d = editBundle(att, (b) => {
      const sig = Buffer.from(b.dsseEnvelope.signatures[0].sig, 'base64');
      sig[sig.length - 1] = sig[sig.length - 1]! ^ 1;
      b.dsseEnvelope.signatures[0].sig = sig.toString('base64');
    });
    expect(reason(await run(d))).toBe('bundle');
  });

  it('删掉时间戳证明(SET)→ bundle', async () => {
    const d = editBundle(att, (b) => {
      for (const t of b.verificationMaterial.tlogEntries) delete t.inclusionPromise;
    });
    expect(reason(await run(d))).toBe('bundle');
  });

  it('改 SET 签名 → bundle', async () => {
    const d = editBundle(att, (b) => {
      const t = b.verificationMaterial.tlogEntries[0];
      const s = Buffer.from(t.inclusionPromise.signedEntryTimestamp, 'base64');
      s[10] = s[10]! ^ 1;
      t.inclusionPromise.signedEntryTimestamp = s.toString('base64');
    });
    expect(reason(await run(d))).toBe('bundle');
  });

  it('删掉 tlogEntries / 证书链 → bundle(库抛 TypeError 也归 bundle)', async () => {
    expect(
      reason(
        await run(
          editBundle(att, (b) => {
            delete b.verificationMaterial.tlogEntries;
          }),
        ),
      ),
    ).toBe('bundle');
    expect(
      reason(
        await run(
          editBundle(att, (b) => {
            delete b.verificationMaterial.x509CertificateChain;
          }),
        ),
      ),
    ).toBe('bundle');
  });

  it('换成别人的证书(把 SLSA bundle 的证书替换为 publish 条的公钥材料)→ 不放行', async () => {
    const d = clone(att);
    const publish = d['attestations'].find((a: Json) => a['predicateType'] === PUBLISH) as Json;
    slsaOf(d)['bundle'].verificationMaterial = publish['bundle'].verificationMaterial;
    expect(await run(d)).toMatchObject({ ok: false });
  });

  it('tarball 摘要不符(statement 与签名都是真的)→ integrity', async () => {
    expect(reason(await run(att, { tarballSha512Hex: '00' + RC0_SHA.slice(2) }))).toBe('integrity');
  });

  it('只有 publish v0.1 条 → provenance_missing', async () => {
    const d = clone(att);
    d['attestations'] = d['attestations'].filter((a: Json) => a['predicateType'] === PUBLISH);
    expect(reason(await run(d))).toBe('provenance_missing');
  });

  it('把 publish 条的 bundle 放到 SLSA 外层冒充 → 不放行', async () => {
    const d = clone(att);
    const publish = d['attestations'].find((a: Json) => a['predicateType'] === PUBLISH) as Json;
    publish['predicateType'] = SLSA;
    d['attestations'] = [publish];
    expect(await run(d)).toMatchObject({ ok: false });
  });

  it('包名不符(真 bundle,别的包名)→ provenance_identity', async () => {
    expect(reason(await run(att, { pkgName: '@chovizzz/other' }))).toBe('provenance_identity');
  });

  it('夹具自洽:statement 的 subject 名 / digest / workflow 与测试常量一致', () => {
    const st = decodeStatement(att);
    expect(st['subject'][0].digest.sha512).toBe(RC0_SHA);
    expect(st['predicate'].buildDefinition.externalParameters.workflow.ref).toBe(
      `refs/tags/v${VERSION}`,
    );
  });
});
