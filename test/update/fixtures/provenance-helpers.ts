import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import { readBytes, readDir, readText } from '../../../src/io/read-fs.js';
import { copyFile, mkdirp } from '../../../src/io/safe-fs.js';
import type { IoContext } from '../../../src/io/paths.js';
import type {
  ProvenanceVerifier,
  ProvenanceVerifierOptions,
  VerifyProvenanceInput,
} from '../../../src/update/provenance.js';
import { makeTempDir } from '../../helpers/tmp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = HERE;
export const TUF_CACHE_FIXTURE = path.join(HERE, 'tuf-cache', 'tuf-repo-cdn.sigstore.dev');
export const VERSION = '0.1.0-rc.0';
export const PKG = '@chovizzz/agent-kit';
export const SAN = `https://github.com/chovizzz/agent-kit/.github/workflows/release.yml@refs/tags/v${VERSION}`;
/** 夹具 tarball 的 sha512(= att-rc0.json 里已验签 statement 的 subject 摘要) */
export const RC0_SHA =
  '73ea5504f65b040622ce0d3e31a3e67b23e1c5a48766b0a3edda60abf521d98d9d1c83e4f5e103cbcca5be58e91a189152ef100b9c60ec8243fbb5d3b0e4d7df';
/** 夹具 TUF 元数据(timestamp 约 2026-10-21 过期)有效期内的固定时钟 */
export const FIXED_NOW = '2026-10-14T12:00:00Z';
/** att-rc0.json 里 SLSA bundle 的 Rekor integratedTime(秒) */
export const RC0_INTEGRATED_SECS = 1791947005;

export const SLSA = 'https://slsa.dev/provenance/v1';
export const PUBLISH = 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1';

export type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function tgzSha512(file: string): Promise<string> {
  return createHash('sha512')
    .update(await readBytes(file))
    .digest('hex');
}

export async function loadAtt(): Promise<Json> {
  return JSON.parse(await readText(path.join(HERE, 'att-rc0.json'))) as Json;
}

export function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

export function slsaOf(doc: Json): Json {
  return (doc['attestations'] as Json[]).find((a) => a['predicateType'] === SLSA) as Json;
}

export function decodeStatement(doc: Json): Json {
  return JSON.parse(
    Buffer.from(slsaOf(doc)['bundle'].dsseEnvelope.payload, 'base64').toString('utf8'),
  ) as Json;
}

/** 改 SLSA statement 并重新编码 payload(签名不再有效;配合假验证器使用) */
export function editStatement(doc: Json, fn: (st: Json) => void): Json {
  const d = clone(doc);
  const st = decodeStatement(d);
  fn(st);
  slsaOf(d)['bundle'].dsseEnvelope.payload = Buffer.from(JSON.stringify(st)).toString('base64');
  return d;
}

export function editBundle(doc: Json, fn: (bundle: Json) => void): Json {
  const d = clone(doc);
  fn(slsaOf(d)['bundle']);
  return d;
}

export async function newTempDir(prefix: string): Promise<{ ctx: IoContext; dir: string }> {
  return makeTempDir(prefix);
}

/** 把夹具里的 TUF 缓存复制到 dir/<cache>/tuf-repo-cdn.sigstore.dev;返回 cachePath(sigstore 的 tufCachePath) */
export async function seedTufCache(ctx: IoContext, dir: string, name = 'tuf'): Promise<string> {
  const cachePath = path.join(dir, name);
  const dest = path.join(cachePath, 'tuf-repo-cdn.sigstore.dev');
  await mkdirp(ctx, path.join(dest, 'targets'));
  for (const rel of ['', 'targets']) {
    for (const e of await readDir(path.join(TUF_CACHE_FIXTURE, rel))) {
      if (e.isFile) {
        await copyFile(
          ctx,
          path.join(TUF_CACHE_FIXTURE, rel, e.name),
          path.join(dest, rel, e.name),
        );
      }
    }
  }
  return cachePath;
}

export function freezeClock(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(FIXED_NOW));
}

export function baseInput(
  att: unknown,
  cachePath: string,
  over: Partial<VerifyProvenanceInput> = {},
): VerifyProvenanceInput {
  return {
    attestationsDoc: att,
    tarballSha512Hex: RC0_SHA,
    version: VERSION,
    tuf: { cachePath, forceCache: true },
    ...over,
  };
}

/** 假验证器:按配置返回 / 抛错,并记录收到的参数 */
export function fakeVerifier(
  result: Awaited<ReturnType<ProvenanceVerifier>> | Error | 'none' = {
    subjectAlternativeName: SAN,
    issuer: 'https://token.actions.githubusercontent.com',
  },
): {
  verifier: ProvenanceVerifier;
  calls: Array<{ bundle: unknown; options: ProvenanceVerifierOptions }>;
} {
  const calls: Array<{ bundle: unknown; options: ProvenanceVerifierOptions }> = [];
  const verifier: ProvenanceVerifier = async (bundle, options) => {
    calls.push({ bundle, options });
    if (result instanceof Error) throw result;
    return result === 'none' ? undefined : result;
  };
  return { verifier, calls };
}

export function namedError(name: string, message: string, extra: Json = {}): Error {
  const e = new Error(message);
  e.name = name;
  Object.assign(e, extra);
  return e;
}
