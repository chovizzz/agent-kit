import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SLSA_PREDICATE,
  expectedSubjectName,
  parseAttestations,
  verifyTarballBinding,
} from '../../src/update/policy.js';
import type { AttestationFetch, BindingResult } from '../../src/update/policy.js';

const NAME = '@chovizzz/agent-kit';
const VERSION = '0.2.1';
const TARBALL = Buffer.from('tarball-bytes');
const SHA_HEX = createHash('sha512').update(TARBALL).digest('hex');
const INTEGRITY = `sha512-${createHash('sha512').update(TARBALL).digest('base64')}`;
const OTHER_HEX = createHash('sha512').update('evil').digest('hex');

function statement(
  subjectName: string,
  sha: string,
  predicateType: string,
  inner: string = predicateType,
): unknown {
  return {
    predicateType,
    bundle: {
      dsseEnvelope: {
        payload: Buffer.from(
          JSON.stringify({
            predicateType: inner,
            subject: [{ name: subjectName, digest: { sha512: sha } }],
          }),
        ).toString('base64'),
      },
    },
  };
}

function attJson(sha: string = SHA_HEX, subject = expectedSubjectName(NAME, VERSION)): unknown {
  return {
    attestations: [
      statement(subject, sha, 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1'),
      statement(subject, sha, SLSA_PREDICATE),
    ],
  };
}

function run(
  attestations: AttestationFetch,
  over: { mirror?: boolean; distIntegrity?: string | undefined } = {},
): BindingResult {
  return verifyTarballBinding({
    name: NAME,
    version: VERSION,
    tarballSha512Hex: SHA_HEX,
    tarballIntegrity: INTEGRITY,
    distIntegrity: 'distIntegrity' in over ? over.distIntegrity : INTEGRITY,
    mirror: over.mirror ?? false,
    attestations,
  });
}

describe('verifyTarballBinding(⑭B)', () => {
  it('预期的 subject 名与 npm 真实形状一致', () => {
    expect(expectedSubjectName(NAME, '0.1.0-rc.0')).toBe(
      'pkg:npm/%40chovizzz/agent-kit@0.1.0-rc.0',
    );
  });

  it('非镜像:摘要一致且 dist.integrity 一致 → ok', () => {
    expect(run({ kind: 'ok', json: attJson() })).toEqual({ ok: true });
  });

  it('镜像:摘要等于 npmjs attestation → ok,镜像给的 dist.integrity 只作提示(不一致也不据此拒)', () => {
    expect(
      run({ kind: 'ok', json: attJson() }, { mirror: true, distIntegrity: 'sha512-AAAA' }),
    ).toEqual({
      ok: true,
    });
  });

  it('非镜像:dist.integrity 与实际 tarball 不一致 → integrity', () => {
    expect(run({ kind: 'ok', json: attJson() }, { distIntegrity: 'sha512-AAAA' })).toEqual({
      ok: false,
      code: 'verify_failed',
      reason: 'integrity',
    });
  });

  it('镜像:tarball 与 npmjs attestation 摘要不符(镜像投毒)→ integrity,即使镜像的 dist.integrity 与它自己的 tarball 自洽', () => {
    expect(run({ kind: 'ok', json: attJson(OTHER_HEX) }, { mirror: true })).toEqual({
      ok: false,
      code: 'verify_failed',
      reason: 'integrity',
    });
  });

  it('镜像:取不到 npmjs attestations → attestations_unreachable(不装),原因保留', () => {
    expect(run({ kind: 'unreachable', cause: 'timeout' }, { mirror: true })).toEqual({
      ok: false,
      code: 'attestations_unreachable',
      reason: 'attestations_unreachable',
      cause: 'timeout',
    });
    expect(run({ kind: 'unreachable', cause: 'http_503' }, { mirror: true })).toMatchObject({
      code: 'attestations_unreachable',
      cause: 'http_503',
    });
  });

  it('npmjs 明确 404(没有 attestation)→ provenance_missing,与 unreachable 不是同一个码', () => {
    expect(run({ kind: 'absent' }, { mirror: true })).toEqual({
      ok: false,
      code: 'verify_failed',
      reason: 'provenance_missing',
    });
  });

  it('只有 publish attestation、没有 SLSA provenance → provenance_missing', () => {
    const json = {
      attestations: [
        statement(
          expectedSubjectName(NAME, VERSION),
          SHA_HEX,
          'https://github.com/npm/attestation/tree/main/specs/publish/v0.1',
        ),
      ],
    };
    expect(run({ kind: 'ok', json })).toMatchObject({ reason: 'provenance_missing' });
  });

  it('subject 名对不上(别的包 / 别的版本的 attestation 被拿来冒充)→ bundle', () => {
    expect(
      run({ kind: 'ok', json: attJson(SHA_HEX, expectedSubjectName(NAME, '0.2.0')) }),
    ).toMatchObject({ reason: 'bundle' });
    expect(
      run({ kind: 'ok', json: attJson(SHA_HEX, expectedSubjectName('@evil/pkg', VERSION)) }),
    ).toMatchObject({ reason: 'bundle' });
  });

  it('形状坏了 → bundle', () => {
    for (const json of [
      null,
      {},
      { attestations: 'x' },
      { attestations: [{}] },
      { attestations: [{ predicateType: 'p', bundle: {} }] },
    ]) {
      expect(run({ kind: 'ok', json })).toMatchObject({ ok: false, reason: 'bundle' });
    }
  });

  it('同名 subject 有多个、只要有一个摘要不符就拒', () => {
    const subj = expectedSubjectName(NAME, VERSION);
    const json = {
      attestations: [
        statement(subj, SHA_HEX, SLSA_PREDICATE),
        statement(subj, OTHER_HEX, 'https://example.test/other'),
      ],
    };
    expect(run({ kind: 'ok', json })).toMatchObject({ reason: 'integrity' });
  });

  it('摘要大小写不敏感', () => {
    expect(run({ kind: 'ok', json: attJson(SHA_HEX.toUpperCase()) })).toEqual({ ok: true });
  });
});

describe('SLSA provenance 与 tarball 绑定在同一条 statement 上(评审 P1)', () => {
  const mine = expectedSubjectName(NAME, VERSION);
  const PUBLISH = 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1';

  it('跨条拼接:publish 点名本包、SLSA 点名别的包 → 拒', () => {
    const json = {
      attestations: [
        statement(mine, SHA_HEX, PUBLISH),
        statement(expectedSubjectName('@other/pkg', '9.9.9'), OTHER_HEX, SLSA_PREDICATE),
      ],
    };
    expect(run({ kind: 'ok', json })).toMatchObject({ ok: false, reason: 'provenance_missing' });
  });

  it('跨条拼接:SLSA 点名同包的别的版本 → 拒', () => {
    const json = {
      attestations: [
        statement(mine, SHA_HEX, PUBLISH),
        statement(expectedSubjectName(NAME, '0.2.0'), SHA_HEX, SLSA_PREDICATE),
      ],
    };
    expect(run({ kind: 'ok', json })).toMatchObject({ ok: false, reason: 'provenance_missing' });
  });

  it('外层 predicateType 写成 SLSA、payload 内却不是 → 不算 SLSA statement', () => {
    const json = {
      attestations: [statement(mine, SHA_HEX, SLSA_PREDICATE, 'https://example.test/other')],
    };
    expect(run({ kind: 'ok', json })).toMatchObject({ ok: false, reason: 'provenance_missing' });
  });

  it('SLSA statement 自己点名本包但摘要不符 → integrity', () => {
    const json = {
      attestations: [statement(mine, SHA_HEX, PUBLISH), statement(mine, OTHER_HEX, SLSA_PREDICATE)],
    };
    expect(run({ kind: 'ok', json })).toMatchObject({ ok: false, reason: 'integrity' });
  });
});

describe('parseAttestations', () => {
  it('解出各 statement 的 subject 与 predicateType;不验签', () => {
    const p = parseAttestations(attJson());
    expect(p?.statements.map((x) => x.predicateType)).toContain(SLSA_PREDICATE);
    expect(p?.statements[1]).toMatchObject({
      predicateType: SLSA_PREDICATE,
      innerPredicateType: SLSA_PREDICATE,
    });
    expect(p?.statements[0]?.subjects[0]).toEqual({
      name: expectedSubjectName(NAME, VERSION),
      sha512: SHA_HEX,
    });
  });
});
