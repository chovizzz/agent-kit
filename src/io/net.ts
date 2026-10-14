/**
 * 受控网络层(docs/contracts.md §19.5):唯一可以联网、使用全局 fetch 的文件。
 *
 * - 超时(默认 5s,可注入)、响应体上限、不跟随跨主机重定向、主机白名单、只许 https。
 * - 错误归类成稳定码并**保留原因**(cause 的 name/code/message),绝不吞成笼统的「失败」。
 * - 不读 npmrc,不读环境变量(环境由调用方以参数注入;process.env 只许出现在 paths.ts)。
 * - 代理:Node 25.2 的全局 fetch **默认忽略** HTTPS_PROXY,只有进程启动时带 NODE_USE_ENV_PROXY=1
 *   (或 --use-env-proxy)才会走代理(2026-10-14 实测,见 §19.9)。本文件无法在进程内改变这一点,
 *   `detectProxy` 只负责如实报告「配了代理但没生效」,由调用方(S7 的 worker 启动方式)保证生效。
 */
import { createHash } from 'node:crypto';

export const NPMJS_HOST = 'registry.npmjs.org';
export const DEFAULT_TIMEOUT_MS = 5000;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_TARBALL_TIMEOUT_MS = 60_000;
export const DEFAULT_TARBALL_MAX_BYTES = 50 * 1024 * 1024;
export const MAX_REDIRECTS = 3;

/** 网络层稳定码(`http_<码>` 另算);与 UPDATE_RESULT_CODES 中的网络类一一对应,host_denied 是本层多出的策略拒绝。 */
export const NET_ERROR_CODES = [
  'timeout',
  'dns',
  'connect',
  'tls',
  'proxy',
  'too_large',
  'parse',
  'host_denied',
] as const;
export type NetErrorCode = (typeof NET_ERROR_CODES)[number] | `http_${number}`;

export interface NetErrorInit {
  status?: number;
  causeName?: string;
  causeCode?: string;
  causeMessage?: string;
  hint?: string;
  location?: string;
  cause?: unknown;
}

export class NetError extends Error {
  readonly code: NetErrorCode;
  readonly status: number | undefined;
  /** 底层原因(未被吞掉):如 `ENOTFOUND`、`UND_ERR_CONNECT_TIMEOUT`、`TimeoutError` */
  readonly causeName: string | undefined;
  readonly causeCode: string | undefined;
  readonly causeMessage: string | undefined;
  /** 附加提示,如 `proxy_env_ignored` */
  readonly hint: string | undefined;
  readonly location: string | undefined;
  constructor(code: NetErrorCode, init: NetErrorInit = {}) {
    super(`net:${code}${init.causeCode ? `(${init.causeCode})` : ''}`, { cause: init.cause });
    this.name = 'NetError';
    this.code = code;
    this.status = init.status;
    this.causeName = init.causeName;
    this.causeCode = init.causeCode;
    this.causeMessage = init.causeMessage;
    this.hint = init.hint;
    this.location = init.location;
  }
}

// ---------------------------------------------------------------------------
// fetch 抽象(可注入)
// ---------------------------------------------------------------------------

export interface FetchInit {
  method: 'GET' | 'HEAD';
  headers: Record<string, string>;
  redirect: 'manual';
  signal: AbortSignal;
}
export interface FetchResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponseLike>;

export interface NetOptions {
  /** 缺省用全局 fetch(调用时才取,便于测试用探针替换) */
  fetch?: FetchLike;
  timeoutMs?: number;
  maxBytes?: number;
  /** 本次请求是否经代理(见 detectProxy);为 true 时 dns/connect 归为 proxy,原因仍保留 */
  viaProxy?: boolean;
  /** 配了代理但没生效时的提示,会挂在错误上 */
  proxyHint?: string;
  userAgent?: string;
}

export interface NetResponse {
  status: number;
  /** 最终响应所在 URL(同主机重定向后可能与请求不同) */
  url: string;
  headers: { get(name: string): string | null };
  body: Uint8Array;
}

// ---------------------------------------------------------------------------
// 代理探测
// ---------------------------------------------------------------------------

export interface ProxyStatus {
  /** 环境里配了 HTTPS_PROXY / https_proxy */
  configured: boolean;
  /** 进程按环境变量走代理(NODE_USE_ENV_PROXY 或 --use-env-proxy) */
  honored: boolean;
  /** 传给 NetOptions.viaProxy */
  viaProxy: boolean;
  /** configured && !honored 时为 `proxy_env_ignored` */
  hint: string | undefined;
}

export function detectProxy(
  env: Readonly<Record<string, string | undefined>>,
  execArgv: readonly string[] = [],
): ProxyStatus {
  const nonEmpty = (v: string | undefined): boolean => v !== undefined && v.trim() !== '';
  const configured = nonEmpty(env['HTTPS_PROXY']) || nonEmpty(env['https_proxy']);
  const flag = env['NODE_USE_ENV_PROXY'];
  const options = env['NODE_OPTIONS'] ?? '';
  const honored =
    flag === '1' ||
    flag === 'true' ||
    execArgv.includes('--use-env-proxy') ||
    /(^|\s)--use-env-proxy(\s|$)/.test(options);
  return {
    configured,
    honored,
    viaProxy: configured && honored,
    hint: configured && !honored ? 'proxy_env_ignored' : undefined,
  };
}

// ---------------------------------------------------------------------------
// 错误归类
// ---------------------------------------------------------------------------

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA', 'EAI_NONAME']);
const CONNECT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'ECONNABORTED',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
]);
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const TLS_CODE_RE =
  /^(CERT_|ERR_TLS_|ERR_SSL_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_(VERIFY_LEAF_SIGNATURE|GET_ISSUER_CERT)|HOSTNAME_MISMATCH|ERR_OSSL)/;

interface Causal {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  cause?: unknown;
}

/** 沿 cause 链找第一个带 code 的原因(undici 把真实错误放在 TypeError.cause);都没有 code 时取最深的一层,不丢信息 */
function rootCause(e: unknown): { name?: string; code?: string; message?: string } {
  let cur: unknown = e;
  let deepest: { name?: string; code?: string; message?: string } = {};
  for (let i = 0; i < 5 && cur !== null && typeof cur === 'object'; i++) {
    const c = cur as Causal;
    const entry = {
      name: typeof c.name === 'string' ? c.name : undefined,
      code: typeof c.code === 'string' ? c.code : undefined,
      message: typeof c.message === 'string' ? c.message : undefined,
    };
    if (entry.code !== undefined) return entry;
    deepest = entry;
    cur = c.cause;
  }
  return deepest;
}

/** 把 fetch 抛出的异常归成稳定码(原因保留在 NetError 上)。timedOut:我们自己的计时器触发。 */
export function classifyFetchError(
  e: unknown,
  ctx: { timedOut: boolean; viaProxy?: boolean; proxyHint?: string },
): NetError {
  const rc = rootCause(e);
  const init: NetErrorInit = {
    causeName: rc.name,
    causeCode: rc.code,
    causeMessage: rc.message,
    hint: ctx.proxyHint,
    cause: e,
  };
  if (
    ctx.timedOut ||
    rc.name === 'TimeoutError' ||
    (rc.code !== undefined && TIMEOUT_CODES.has(rc.code))
  ) {
    return new NetError('timeout', init);
  }
  const code = rc.code ?? '';
  const msg = (rc.message ?? '').toLowerCase();
  if (code.startsWith('UND_ERR_PRX') || /proxy response|proxy authentication/.test(msg)) {
    return new NetError('proxy', init);
  }
  if (TLS_CODE_RE.test(code)) return new NetError('tls', init);
  if (DNS_CODES.has(code)) return new NetError(ctx.viaProxy ? 'proxy' : 'dns', init);
  if (CONNECT_CODES.has(code)) return new NetError(ctx.viaProxy ? 'proxy' : 'connect', init);
  // 没有可识别的 code:不能编造原因。归 connect 并保留原始 name/message,由日志显示
  return new NetError(ctx.viaProxy ? 'proxy' : 'connect', init);
}

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

function parseHttps(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new NetError('host_denied', { causeMessage: 'invalid_url' });
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') {
    throw new NetError('host_denied', { causeMessage: 'scheme_or_userinfo' });
  }
  return u;
}

export interface GetOptions extends NetOptions {
  accept?: string;
  /** 允许的主机名(小写完全匹配) */
  allowedHosts: readonly string[];
}

/** 不需要的响应体显式取消,不依赖 GC 释放连接;清理失败不覆盖原始错误 */
async function discard(res: FetchResponseLike): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // 忽略
  }
}

async function readBody(
  res: FetchResponseLike,
  maxBytes: number,
  abort: () => void,
): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    abort();
    throw new NetError('too_large', { status: res.status, causeMessage: 'content-length' });
  }
  if (res.body === null) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      abort();
      throw new NetError('too_large', { status: res.status, causeMessage: 'body' });
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * GET。2xx 返回;3xx 同主机(https)最多跟 3 跳,跨主机不跟随 → 抛 http_3NN(保留 Location);
 * 4xx/5xx 抛 http_NNN。超时覆盖「连接 + 响应头 + 读完 body」整个过程。
 */
export async function httpGet(url: string, opts: GetOptions): Promise<NetResponse> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const allowed = new Set(opts.allowedHosts.map((h) => h.toLowerCase()));
  const startHost = parseHttps(url).hostname.toLowerCase();
  if (!allowed.has(startHost)) {
    throw new NetError('host_denied', { causeMessage: 'host_not_allowed' });
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const headers: Record<string, string> = {
    'user-agent': opts.userAgent ?? 'agent-kit-update',
  };
  if (opts.accept !== undefined) headers['accept'] = opts.accept;
  const doFetch: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i) as Promise<FetchResponseLike>);
  const ctx = { viaProxy: opts.viaProxy, proxyHint: opts.proxyHint };
  try {
    let current = url;
    for (let hop = 0; ; hop++) {
      let res: FetchResponseLike;
      try {
        res = await doFetch(current, {
          method: 'GET',
          headers,
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (e) {
        throw classifyFetchError(e, { ...ctx, timedOut });
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        let next: URL | undefined;
        try {
          next = loc === null ? undefined : new URL(loc, current);
        } catch {
          next = undefined;
        }
        // 每一跳与入口同一套策略:https、无 userinfo、同主机同端口
        const sameHost =
          next !== undefined &&
          next.protocol === 'https:' &&
          next.username === '' &&
          next.password === '' &&
          next.host.toLowerCase() === new URL(current).host.toLowerCase();
        if (!sameHost || next === undefined || hop >= MAX_REDIRECTS) {
          await discard(res);
          throw new NetError(`http_${res.status}`, {
            status: res.status,
            location: loc ?? undefined,
            hint: ctx.proxyHint,
          });
        }
        await discard(res);
        current = next.toString();
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        await discard(res);
        throw new NetError(`http_${res.status}`, { status: res.status, hint: ctx.proxyHint });
      }
      let body: Uint8Array;
      try {
        body = await readBody(res, maxBytes, () => controller.abort());
      } catch (e) {
        if (e instanceof NetError) throw e;
        throw classifyFetchError(e, { ...ctx, timedOut });
      }
      return { status: res.status, url: current, headers: res.headers, body };
    }
  } finally {
    clearTimeout(timer);
  }
}

function decodeJson(res: NetResponse): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(res.body)) as unknown;
  } catch (e) {
    throw new NetError('parse', {
      status: res.status,
      causeName: e instanceof Error ? e.name : undefined,
      causeMessage: 'not_json',
      cause: e,
    });
  }
}

/** 从响应取 `Date` 头(原文;缺失为 undefined)。解析与「缺失/不可解析按未满冷却期」在 policy.ts。 */
export function getDateHeader(res: Pick<NetResponse, 'headers'>): string | undefined {
  const v = res.headers.get('date');
  return v === null || v.trim() === '' ? undefined : v;
}

export function packumentUrl(registry: string, name: string): string {
  const base = registry.endsWith('/') ? registry : `${registry}/`;
  return `${base}${name.replace('/', '%2f')}`;
}

export interface PackumentResponse {
  json: unknown;
  /** 响应 Date 头原文 */
  dateHeader: string | undefined;
  host: string;
}

/**
 * 取完整 packument。必须用 `application/json`:精简的 install-v1 没有 `time`,冷却期无从判断(2026-10-14 实测)。
 * 允许的主机 = 该 registry 的主机(+ npmjs,当 registry 为镜像时由调用方另调一次取 npmjs 的)。
 */
export async function getPackument(
  registry: string,
  name: string,
  opts: NetOptions = {},
): Promise<PackumentResponse> {
  const url = packumentUrl(registry, name);
  const host = new URL(url).hostname.toLowerCase();
  const res = await httpGet(url, { ...opts, accept: 'application/json', allowedHosts: [host] });
  return { json: decodeJson(res), dateHeader: getDateHeader(res), host };
}

export type AttestationsResult =
  | { kind: 'ok'; json: unknown; dateHeader: string | undefined }
  /** npmjs 明确返回 404:该版本没有 attestation(= provenance_missing,不是 unreachable) */
  | { kind: 'absent' };

/** attestations 主机固定 npmjs,不可配(决策 ⑭B)。404 → absent;其它失败抛 NetError。 */
export async function getAttestations(
  name: string,
  version: string,
  opts: NetOptions = {},
): Promise<AttestationsResult> {
  const url = `https://${NPMJS_HOST}/-/npm/v1/attestations/${name.replace('/', '%2f')}@${encodeURIComponent(version)}`;
  try {
    const res = await httpGet(url, { ...opts, allowedHosts: [NPMJS_HOST] });
    return { kind: 'ok', json: decodeJson(res), dateHeader: getDateHeader(res) };
  } catch (e) {
    if (e instanceof NetError && e.code === 'http_404') return { kind: 'absent' };
    throw e;
  }
}

export interface TarballResult {
  bytes: Uint8Array;
  /** 小写十六进制 sha512,与 attestation subject 摘要同形 */
  sha512Hex: string;
  /** `sha512-<base64>`,与 packument 的 dist.integrity 同形 */
  integrity: string;
}

/** 下载 tarball。主机必须在 allowedHosts 内(镜像 packument 给的 tarball 地址指向别处 → host_denied)。 */
export async function getTarball(
  url: string,
  allowedHosts: readonly string[],
  opts: NetOptions = {},
): Promise<TarballResult> {
  const res = await httpGet(url, {
    ...opts,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TARBALL_TIMEOUT_MS,
    maxBytes: opts.maxBytes ?? DEFAULT_TARBALL_MAX_BYTES,
    allowedHosts,
  });
  const h = createHash('sha512').update(res.body);
  const digest = h.digest();
  return {
    bytes: res.body,
    sha512Hex: Buffer.from(digest).toString('hex'),
    integrity: `sha512-${Buffer.from(digest).toString('base64')}`,
  };
}
