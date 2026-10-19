/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * S7c-A 测试世界:假 HOME + 假 registry(file:// 夹具)+ 在测试里现造的 tarball / attestations。
 * 全部写盘只经 safe-fs(KIT_TMP 之内),被测代码走真实的命令 / 安装器 / home-fs;绝不联网、不碰真实 HOME。
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import * as path from 'node:path';
import { createUpdateCommand, type UpdateCommandDeps } from '../../src/commands/update.js';
import type { EnvCommandContext } from '../../src/commands/reflect.js';
import { canonicalJson } from '../../src/io/canonical-json.js';
import { getRealHome } from '../../src/io/paths.js';
import { lstat, readBytes, readDir, readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import type { ProvenanceVerifier } from '../../src/update/provenance.js';
import { makeTempDir, wideCtx } from '../helpers/tmp.js';
import type { IoContext } from '../../src/io/paths.js';

export const PKG_NAME = '@chovizzz/agent-kit';
export const NOW_HTTP = 'Wed, 14 Oct 2026 12:00:00 GMT';
export const NOW_MS = Date.parse('2026-10-14T12:00:00Z');
/** 发布于「现在」前 4 天:过了默认 24h 冷却期 */
export const OLD_ISO = '2026-10-10T12:00:00.000Z';
export const OLD_SECS = Math.floor(Date.parse(OLD_ISO) / 1000);
export const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
export const sha512 = (b: Buffer | string): string => createHash('sha512').update(b).digest('hex');

// ---------------------------------------------------------------------------
// tar / tgz 构造
// ---------------------------------------------------------------------------

export interface Ent {
  name: string;
  type?: string;
  data?: Buffer | string;
  mode?: number;
  linkname?: string;
}

function oct(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function header(e: Ent, size: number): Buffer {
  const h = Buffer.alloc(512);
  Buffer.from(e.name).copy(h, 0);
  h.write(oct(e.mode ?? 0o644, 8), 100, 'latin1');
  h.write(oct(0, 8), 108, 'latin1');
  h.write(oct(0, 8), 116, 'latin1');
  h.write(oct(size, 12), 124, 'latin1');
  h.write(oct(0, 12), 136, 'latin1');
  h.write('        ', 148, 'latin1');
  h.write(e.type ?? '0', 156, 'latin1');
  if (e.linkname) h.write(e.linkname, 157, 'latin1');
  h.write('ustar\0', 257, 'latin1');
  h.write('00', 263, 'latin1');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  return h;
}

function entry(e: Ent): Buffer {
  const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '');
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header(e, data.length), data, pad]);
}

export function tgzOf(entries: Ent[]): Buffer {
  return gzipSync(Buffer.concat([...entries.map(entry), Buffer.alloc(1024)]));
}

// ---------------------------------------------------------------------------
// 包
// ---------------------------------------------------------------------------

export interface PkgFile {
  path: string;
  data: string | Buffer;
  mode?: number;
}

export interface BuildPkgOptions {
  /** 在算 integrity.json 之前改文件清单(增 / 删 / 改) */
  edit?: (files: PkgFile[]) => PkgFile[];
  /** 改 integrity 对象(算出来之后),返回 undefined 表示不放 integrity.json */
  integrity?: (o: Record<string, unknown>) => Record<string, unknown> | undefined;
  /** 在 tarball 末尾追加的原始 tar 条目(造恶意条目) */
  extraEntries?: Ent[];
  /** package.json 里的 version(默认同 version) */
  pkgVersion?: string;
  pkgName?: string;
}

export interface BuiltPkg {
  version: string;
  tgz: Buffer;
  sha512: string;
  files: PkgFile[];
  integrityBytes: Buffer;
  anchor: string;
}

export function buildPkg(version: string, o: BuildPkgOptions = {}): BuiltPkg {
  let files: PkgFile[] = [
    {
      path: 'package.json',
      data: JSON.stringify({
        name: o.pkgName ?? PKG_NAME,
        version: o.pkgVersion ?? version,
        bin: { 'agent-kit': 'dist/cli.js' },
      }),
    },
    {
      path: 'dist/cli.js',
      data: `#!/usr/bin/env node\nconsole.log('cli ${version}');\n`,
      mode: 0o755,
    },
    { path: 'dist/main.js', data: `export const v = '${version}';\n` },
    { path: 'README.md', data: `# agent-kit ${version}\n` },
    { path: 'LICENSE', data: 'UNLICENSED\n' },
  ];
  if (o.edit !== undefined) files = o.edit(files);
  const listed = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : 1))
    .map((f) => {
      const b = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
      return { path: f.path, sha256: sha256(b), bytes: b.byteLength };
    });
  const base: Record<string, unknown> = {
    schema_version: 1,
    kit_version: version,
    algorithm: 'sha256',
    files: listed,
  };
  const integrity = o.integrity === undefined ? base : o.integrity(base);
  const integrityBytes = Buffer.from(integrity === undefined ? '' : canonicalJson(integrity));
  const entries: Ent[] = [{ name: 'package/', type: '5', mode: 0o755 }];
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  for (const d of [...dirs].sort()) entries.push({ name: `package/${d}/`, type: '5', mode: 0o755 });
  for (const f of files) {
    entries.push({ name: `package/${f.path}`, data: f.data, mode: f.mode ?? 0o644 });
  }
  if (integrity !== undefined)
    entries.push({ name: 'package/integrity.json', data: integrityBytes });
  entries.push(...(o.extraEntries ?? []));
  const tgz = tgzOf(entries);
  return {
    version,
    tgz,
    sha512: sha512(tgz),
    files,
    integrityBytes,
    anchor: sha256(integrityBytes),
  };
}

// ---------------------------------------------------------------------------
// attestations / 验证器
// ---------------------------------------------------------------------------

export interface AttOptions {
  integratedSecs?: number;
  /** 改 statement(签名不再有效;配合假验证器) */
  edit?: (st: Record<string, any>) => void;
  /** 去掉 SLSA 条目,只留 publish 条 */
  noSlsa?: boolean;
}

export function sanOf(version: string): string {
  return `https://github.com/chovizzz/agent-kit/.github/workflows/release.yml@refs/tags/v${version}`;
}

export function makeAtt(version: string, sha512Hex: string, o: AttOptions = {}): unknown {
  const st: Record<string, any> = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: `pkg:npm/%40chovizzz/agent-kit@${version}`, digest: { sha512: sha512Hex } }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: 'https://github.com/chovizzz/agent-kit',
            path: '.github/workflows/release.yml',
            ref: `refs/tags/v${version}`,
          },
        },
      },
    },
  };
  o.edit?.(st);
  const slsa = {
    predicateType: 'https://slsa.dev/provenance/v1',
    bundle: {
      mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
      verificationMaterial: {
        tlogEntries: [
          {
            integratedTime: String(o.integratedSecs ?? OLD_SECS),
            inclusionPromise: { signedEntryTimestamp: 'AAAA' },
          },
        ],
        timestampVerificationData: {},
      },
      dsseEnvelope: {
        payloadType: 'application/vnd.in-toto+json',
        payload: Buffer.from(JSON.stringify(st)).toString('base64'),
        signatures: [{ sig: 'AAAA' }],
      },
    },
  };
  const publish = {
    predicateType: 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1',
    bundle: {
      mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
      verificationMaterial: { tlogEntries: [] },
      dsseEnvelope: {
        payloadType: 'application/vnd.in-toto+json',
        payload: Buffer.from(
          JSON.stringify({
            _type: 'https://in-toto.io/Statement/v0.1',
            subject: st['subject'],
            predicateType: 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1',
            predicate: {},
          }),
        ).toString('base64'),
        signatures: [{ sig: 'AAAA' }],
      },
    },
  };
  return { attestations: o.noSlsa === true ? [publish] : [publish, slsa] };
}

/** 验证器按 bundle 里 statement 的 workflow.ref 回报签名者(= 签名有效、身份由 CI 决定) */
export const okVerifier: ProvenanceVerifier = async (bundle) => {
  const b = bundle as { dsseEnvelope: { payload: string } };
  const st = JSON.parse(Buffer.from(b.dsseEnvelope.payload, 'base64').toString('utf8')) as {
    predicate: { buildDefinition: { externalParameters: { workflow: { ref: string } } } };
  };
  const ref = st.predicate.buildDefinition.externalParameters.workflow.ref;
  return {
    subjectAlternativeName: `https://github.com/chovizzz/agent-kit/.github/workflows/release.yml@${ref}`,
    issuer: 'https://token.actions.githubusercontent.com',
  };
};

export function namedError(
  name: string,
  message: string,
  extra: Record<string, unknown> = {},
): Error {
  const e = new Error(message);
  e.name = name;
  Object.assign(e, extra);
  return e;
}

export function countingVerifier(inner: ProvenanceVerifier = okVerifier): {
  verifier: ProvenanceVerifier;
  calls: () => number;
} {
  let n = 0;
  return {
    verifier: async (b, o) => {
      n += 1;
      return inner(b, o);
    },
    calls: () => n,
  };
}

// ---------------------------------------------------------------------------
// 假 registry
// ---------------------------------------------------------------------------

export interface RegVersion {
  pkg: BuiltPkg;
  /** 发布时间(npmjs time[v]) */
  time?: string;
  deprecated?: string;
  /** 不放 tarball 文件(npm 202 半可见期) */
  noTarball?: boolean;
  /** 不给 dist.integrity */
  noIntegrity?: boolean;
  /** dist.integrity 写成这个值 */
  integrity?: string;
  /** 'absent' = 没有 attestations;'unreachable' = 取不到;对象 = 自定义文档;缺省 = 合法文档 */
  att?: 'absent' | 'unreachable' | unknown;
  attOptions?: AttOptions;
}

export interface RegistrySpec {
  versions: RegVersion[];
  distTags: Record<string, string>;
  /** 响应 Date 头(缺省 NOW_HTTP;null = 不写) */
  date?: string | null;
  /** 镜像模式:npmjs 一侧的 packument(同一份 versions 但可改 distTags / 时间),或 'unreachable' */
  npmjs?: { distTags?: Record<string, string>; unreachable?: boolean };
}

export interface World {
  dir: string;
  home: string;
  reg: string;
  io: IoContext;
  fx: IoContext;
  env: Record<string, string>;
}

export async function newWorld(): Promise<World> {
  const { dir } = await makeTempDir('ak-upd-');
  const fx = wideCtx(dir);
  const home = path.join(dir, 'home');
  const reg = path.join(dir, 'reg');
  await safe.mkdirp(fx, home);
  await safe.mkdirp(fx, reg);
  const env = {
    KIT_TMP: dir,
    PATH: '/usr/bin:/bin',
    KIT_UPDATE_REGISTRY: `file://${reg}`,
  };
  return { dir, home, reg, io: fx, fx, env };
}

function packumentOf(
  spec: RegistrySpec,
  distTags: Record<string, string>,
): Record<string, unknown> {
  const versions: Record<string, unknown> = {};
  const time: Record<string, string> = {};
  for (const v of spec.versions) {
    const dist: Record<string, string> = { tarball: `tarballs/${v.pkg.version}.tgz` };
    if (v.noIntegrity !== true) {
      dist['integrity'] =
        v.integrity ?? `sha512-${Buffer.from(v.pkg.sha512, 'hex').toString('base64')}`;
    }
    versions[v.pkg.version] = {
      name: PKG_NAME,
      version: v.pkg.version,
      dist,
      ...(v.deprecated !== undefined ? { deprecated: v.deprecated } : {}),
    };
    time[v.pkg.version] = v.time ?? OLD_ISO;
  }
  return { name: PKG_NAME, 'dist-tags': distTags, versions, time };
}

export async function writeRegistry(w: World, spec: RegistrySpec): Promise<void> {
  const put = async (rel: string, data: string | Buffer): Promise<void> => {
    await safe.writeFile(w.fx, path.join(w.reg, rel), data);
  };
  await safe.mkdirp(w.fx, path.join(w.reg, 'tarballs'));
  await safe.mkdirp(w.fx, path.join(w.reg, 'attestations'));
  await put('packument.json', JSON.stringify(packumentOf(spec, spec.distTags)));
  if (spec.date !== null) await put('packument.date', spec.date ?? NOW_HTTP);
  if (spec.npmjs !== undefined) {
    await safe.mkdirp(w.fx, path.join(w.reg, 'npmjs'));
    if (spec.npmjs.unreachable === true) await put('npmjs/unreachable', '');
    else {
      await put(
        'npmjs/packument.json',
        JSON.stringify(packumentOf(spec, spec.npmjs.distTags ?? spec.distTags)),
      );
      await put('npmjs/packument.date', spec.date ?? NOW_HTTP);
    }
  }
  for (const v of spec.versions) {
    if (v.noTarball !== true) await put(`tarballs/${v.pkg.version}.tgz`, v.pkg.tgz);
    const ver = v.pkg.version;
    if (v.att === 'absent') continue;
    if (v.att === 'unreachable') await put(`attestations/${ver}.unreachable`, '');
    else {
      const doc = v.att ?? makeAtt(ver, v.pkg.sha512, v.attOptions);
      await put(`attestations/${ver}.json`, JSON.stringify(doc));
    }
  }
}

// ---------------------------------------------------------------------------
// 运行命令
// ---------------------------------------------------------------------------

export interface Run {
  code: number;
  out: string;
  err: string;
}

export const FIXED_NOW = (): Date => new Date(NOW_MS);

export async function runUpdate(
  w: World,
  args: string[],
  o: { deps?: UpdateCommandDeps; env?: Record<string, string>; noHome?: boolean } = {},
): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const env = { ...w.env, ...o.env };
  const ctx: EnvCommandContext = {
    argv: [...(o.noHome === true ? [] : ['--home', w.home]), ...args],
    io: w.io,
    overlayPath: undefined,
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    env,
  };
  const deps: UpdateCommandDeps = { now: FIXED_NOW, verifier: okVerifier, ...o.deps };
  const code = await createUpdateCommand(deps).run(ctx);
  return { code, out: out.join(''), err: err.join('') };
}

// ---------------------------------------------------------------------------
// 树快照 / 真实 HOME 守卫
// ---------------------------------------------------------------------------

/** 递归列出 root 下所有条目(相对路径 + 类型 + 权限 + 内容哈希);不存在返回 ['<absent>'] */
export async function treeOf(root: string, rel = ''): Promise<string[]> {
  const abs = rel === '' ? root : path.join(root, rel);
  let entries;
  try {
    entries = await readDir(abs);
  } catch {
    return rel === '' ? ['<absent>'] : [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const r = rel === '' ? e.name : `${rel}/${e.name}`;
    const st = await lstat(path.join(root, r));
    const mode = (st.mode & 0o777).toString(8);
    if (e.isSymbolicLink) out.push(`${r} -> link ${mode}`);
    else if (e.isDirectory) {
      out.push(`${r}/ ${mode}`);
      out.push(...(await treeOf(root, r)));
    } else {
      out.push(
        `${r} ${mode} ${sha256(Buffer.from(await readBytes(path.join(root, r)))).slice(0, 12)}`,
      );
    }
  }
  return out;
}

/** 真实 HOME 里与本套件相关的两个目录的快照(测试前后对比,证明没写真实 HOME) */
export async function realHomeSnapshot(): Promise<string[]> {
  const home = getRealHome();
  return [
    ...(await treeOf(path.join(home, '.local/share/agent-kit'))).map((l) => `share:${l}`),
    ...(await treeOf(path.join(home, '.local/state/agent-kit'))).map((l) => `state:${l}`),
  ];
}

export async function stateOf(w: World): Promise<Record<string, any>> {
  return JSON.parse(
    await readText(path.join(w.home, '.local/state/agent-kit/update/state.json')),
  ) as Record<string, any>;
}
