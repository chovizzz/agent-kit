/**
 * registry 访问的统一接口(S7c-A;docs/contracts.md §19.5):命令与安装器只依赖 {@link RegistrySource},
 * 不关心数据来自真实 registry 还是测试夹具。
 *
 * - `createNetSource`:包 `src/io/net.ts`(唯一联网出口)。packument 取自配置的 registry;镜像时 npmjs 的 packument
 *   另取一次(冷却期的时间来源与候选版本的权威,决策 ⑭B);attestations 主机固定 npmjs;tarball 主机 = 配置 registry 的主机。
 * - `createFixtureSource`:`KIT_UPDATE_REGISTRY=file://<目录>` 的假 registry(决策 ⑦),**仅当目录真实路径严格位于 KIT_TMP 内**才启用。
 *   目录布局(全部可选,缺失按「registry 没有这个东西」处理):
 *     packument.json            配置 registry 的 packument(缺失 → http_404)
 *     packument.date            该响应的 Date 头原文(缺失 → 无 Date 头,冷却期 fail-closed)
 *     npmjs/packument.json      存在 `npmjs/` 目录 = 镜像模式;其下 packument.json / packument.date 是 npmjs 的响应
 *     npmjs/unreachable         存在 = 镜像模式下取不到 npmjs
 *     attestations/<版本>.json  该版本的 attestations 响应(缺失 → absent,即 npmjs 404)
 *     attestations/<版本>.unreachable  存在 = 取不到 attestations
 *     其它文件                  tarball;packument 里的 `dist.tarball` 写相对本目录的路径(或 file:// URL),
 *                               真实路径必须仍在本目录内(符号链接逃逸 → host_denied),缺失 → http_404
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NPMJS_REGISTRY, PACKAGE_NAME } from '../contracts/update.js';
import {
  NPMJS_HOST,
  NetError,
  detectProxy,
  getAttestations,
  getPackument,
  getTarball,
  type FetchLike,
  type TarballResult,
} from '../io/net.js';
import { lstat, readBytes, realpath } from '../io/read-fs.js';
import type { AttestationFetch } from './policy.js';

export interface PackumentFetch {
  json: unknown;
  /** 响应 Date 头原文 */
  dateHeader: string | undefined;
}

export type NpmjsPackumentFetch =
  ({ kind: 'ok' } & PackumentFetch) | { kind: 'unreachable'; cause: string };

export type AttestationsFetch =
  | { kind: 'ok'; json: unknown; dateHeader: string | undefined }
  | { kind: 'absent' }
  | { kind: 'unreachable'; cause: string };

export interface RegistrySource {
  /** 配置的 registry 是否是 npmjs 之外的镜像 */
  readonly mirror: boolean;
  /** 配置 registry 的 packument;失败抛 NetError */
  packument(): Promise<PackumentFetch>;
  /** npmjs 的 packument(非镜像时就是 packument() 的同一份) */
  npmjsPackument(): Promise<NpmjsPackumentFetch>;
  attestations(version: string): Promise<AttestationsFetch>;
  /** 失败抛 NetError;`url` 取自 packument 的 dist.tarball */
  tarball(url: string): Promise<TarballResult>;
}

/** 给 decideUpdate 用的形状(去掉 Date 头) */
export function toPolicyAttestations(a: AttestationsFetch): AttestationFetch {
  if (a.kind === 'ok') return { kind: 'ok', json: a.json };
  return a;
}

function causeOf(e: unknown): string {
  return e instanceof NetError ? e.code : 'connect';
}

// ---------------------------------------------------------------------------
// 真实 registry
// ---------------------------------------------------------------------------

export interface NetSourceOptions {
  env: Readonly<Record<string, string | undefined>>;
  /** 测试注入 */
  fetch?: FetchLike;
}

export function createNetSource(registry: string, opts: NetSourceOptions): RegistrySource {
  const host = new URL(registry).hostname.toLowerCase();
  const mirror = host !== NPMJS_HOST;
  const proxy = detectProxy(opts.env);
  const net = {
    viaProxy: proxy.viaProxy,
    ...(proxy.hint !== undefined ? { proxyHint: proxy.hint } : {}),
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
  };
  const source: RegistrySource = {
    mirror,
    async packument() {
      const r = await getPackument(registry, PACKAGE_NAME, net);
      return { json: r.json, dateHeader: r.dateHeader };
    },
    async npmjsPackument(): Promise<NpmjsPackumentFetch> {
      try {
        const r = mirror
          ? await getPackument(NPMJS_REGISTRY, PACKAGE_NAME, net)
          : await getPackument(registry, PACKAGE_NAME, net);
        return { kind: 'ok', json: r.json, dateHeader: r.dateHeader };
      } catch (e) {
        return { kind: 'unreachable', cause: causeOf(e) };
      }
    },
    async attestations(version) {
      try {
        const r = await getAttestations(PACKAGE_NAME, version, net);
        return r.kind === 'absent'
          ? { kind: 'absent' }
          : { kind: 'ok', json: r.json, dateHeader: r.dateHeader };
      } catch (e) {
        return { kind: 'unreachable', cause: causeOf(e) };
      }
    },
    tarball(url) {
      return getTarball(url, [host], net);
    },
  };
  return source;
}

// ---------------------------------------------------------------------------
// file:// 夹具
// ---------------------------------------------------------------------------

function within(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function readFixtureFile(dir: string, rel: string): Promise<Uint8Array | undefined> {
  const abs = path.join(dir, rel);
  let st;
  try {
    st = await lstat(abs);
  } catch {
    return undefined;
  }
  if (!st.isFile() || st.isSymbolicLink()) throw new NetError('host_denied');
  const real = await realpath(abs);
  if (!within(dir, real)) throw new NetError('host_denied');
  return readBytes(abs);
}

async function fixtureExists(dir: string, rel: string): Promise<boolean> {
  try {
    await lstat(path.join(dir, rel));
    return true;
  } catch {
    return false;
  }
}

async function fixturePackument(dir: string, sub: string): Promise<PackumentFetch> {
  const prefix = sub === '' ? '' : `${sub}/`;
  const body = await readFixtureFile(dir, `${prefix}packument.json`);
  if (body === undefined) throw new NetError('http_404', { status: 404 });
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(body).toString('utf8')) as unknown;
  } catch {
    throw new NetError('parse', { causeMessage: 'not_json' });
  }
  const date = await readFixtureFile(dir, `${prefix}packument.date`);
  const text = date === undefined ? undefined : Buffer.from(date).toString('utf8').trim();
  return { json, dateHeader: text === '' ? undefined : text };
}

/** `dir` 必须是已 realpath 的绝对目录路径(调用方先确认它严格位于 KIT_TMP 内)。 */
export async function createFixtureSource(dir: string): Promise<RegistrySource> {
  const mirror = await fixtureExists(dir, 'npmjs');
  return {
    mirror,
    packument: () => fixturePackument(dir, ''),
    async npmjsPackument() {
      if (!mirror) {
        try {
          return { kind: 'ok', ...(await fixturePackument(dir, '')) };
        } catch (e) {
          return { kind: 'unreachable', cause: causeOf(e) };
        }
      }
      if (await fixtureExists(dir, 'npmjs/unreachable')) {
        return { kind: 'unreachable', cause: 'connect' };
      }
      try {
        return { kind: 'ok', ...(await fixturePackument(dir, 'npmjs')) };
      } catch (e) {
        return { kind: 'unreachable', cause: causeOf(e) };
      }
    },
    async attestations(version) {
      if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) return { kind: 'absent' };
      if (await fixtureExists(dir, `attestations/${version}.unreachable`)) {
        return { kind: 'unreachable', cause: 'connect' };
      }
      let body: Uint8Array | undefined;
      try {
        body = await readFixtureFile(dir, `attestations/${version}.json`);
      } catch (e) {
        return { kind: 'unreachable', cause: causeOf(e) };
      }
      if (body === undefined) return { kind: 'absent' };
      try {
        return {
          kind: 'ok',
          json: JSON.parse(Buffer.from(body).toString('utf8')) as unknown,
          dateHeader: undefined,
        };
      } catch {
        return { kind: 'unreachable', cause: 'parse' };
      }
    },
    async tarball(url) {
      let rel: string;
      if (url.startsWith('file://')) {
        let abs: string;
        try {
          abs = fileURLToPath(url);
        } catch {
          throw new NetError('host_denied');
        }
        const r = path.relative(dir, abs);
        if (r === '' || r.startsWith('..') || path.isAbsolute(r)) throw new NetError('host_denied');
        rel = r;
      } else if (/^[\x21-\x7e]+$/.test(url) && !url.includes(':') && !path.isAbsolute(url)) {
        rel = url;
      } else {
        throw new NetError('host_denied');
      }
      if (rel.split(path.sep).includes('..')) throw new NetError('host_denied');
      const bytes = await readFixtureFile(dir, rel);
      if (bytes === undefined) throw new NetError('http_404', { status: 404 });
      const digest = createHash('sha512').update(bytes).digest();
      return {
        bytes,
        sha512Hex: Buffer.from(digest).toString('hex'),
        integrity: `sha512-${Buffer.from(digest).toString('base64')}`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 选择来源
// ---------------------------------------------------------------------------

export type OpenSourceResult =
  | { ok: true; source: RegistrySource; mirror: boolean }
  | { ok: false; reason: 'bad_registry' | 'registry_fixture_outside_tmp' };

/**
 * `spec` 是 `file://…`(夹具)或 https registry 根地址。夹具只在其真实路径严格位于 `tmpDir`(KIT_TMP)内才启用,
 * 没有 KIT_TMP 时一律拒绝。
 */
export async function openRegistrySource(
  spec: string,
  tmpDir: string | undefined,
  net: NetSourceOptions,
): Promise<OpenSourceResult> {
  if (spec.startsWith('file:')) {
    if (!spec.startsWith('file://') || tmpDir === undefined) {
      return { ok: false, reason: 'registry_fixture_outside_tmp' };
    }
    let dir: string;
    try {
      dir = await realpath(fileURLToPath(spec));
    } catch {
      return { ok: false, reason: 'registry_fixture_outside_tmp' };
    }
    let tmpReal: string;
    try {
      tmpReal = await realpath(tmpDir);
    } catch {
      return { ok: false, reason: 'registry_fixture_outside_tmp' };
    }
    if (!within(tmpReal, dir)) return { ok: false, reason: 'registry_fixture_outside_tmp' };
    const source = await createFixtureSource(dir);
    return { ok: true, source, mirror: source.mirror };
  }
  let u: URL;
  try {
    u = new URL(spec);
  } catch {
    return { ok: false, reason: 'bad_registry' };
  }
  if (
    u.protocol !== 'https:' ||
    u.username !== '' ||
    u.password !== '' ||
    u.search !== '' ||
    u.hash !== '' ||
    u.hostname === ''
  ) {
    return { ok: false, reason: 'bad_registry' };
  }
  const source = createNetSource(spec, net);
  return { ok: true, source, mirror: source.mirror };
}

/** packument 里该版本是否被 deprecate(`deprecated` 为非空字符串) */
export function isDeprecated(packument: unknown, version: string): boolean {
  if (typeof packument !== 'object' || packument === null) return false;
  const versions = (packument as Record<string, unknown>)['versions'];
  if (typeof versions !== 'object' || versions === null) return false;
  const v = (versions as Record<string, unknown>)[version];
  if (typeof v !== 'object' || v === null) return false;
  const d = (v as Record<string, unknown>)['deprecated'];
  return typeof d === 'string' && d.trim() !== '';
}
