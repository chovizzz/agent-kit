import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NET_ERROR_CODES,
  NPMJS_HOST,
  NetError,
  detectProxy,
  getAttestations,
  getDateHeader,
  getPackument,
  getTarball,
  httpGet,
  packumentUrl,
} from '../../src/io/net.js';
import type { FetchInit, FetchLike, FetchResponseLike, NetErrorCode } from '../../src/io/net.js';

// 全局 fetch 换成会计数并抛错的探针:本文件的所有用例都不得碰真实网络
let probeCalls = 0;
beforeEach(() => {
  probeCalls = 0;
  vi.stubGlobal('fetch', () => {
    probeCalls++;
    throw new TypeError('probe: 测试中不得调用真实 fetch');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function res(
  status: number,
  body: string | Uint8Array = '',
  headers: Record<string, string> = {},
): FetchResponseLike {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (n) => lower[n.toLowerCase()] ?? null },
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    }),
  };
}

function fail(code: string | undefined, message = 'fetch failed', name = 'Error'): FetchLike {
  return () => {
    const cause = Object.assign(new Error(message), { name, ...(code ? { code } : {}) });
    return Promise.reject(new TypeError('fetch failed', { cause }));
  };
}

const URL_OK = 'https://registry.npmjs.org/x';
const opts = (f: FetchLike) => ({ fetch: f, allowedHosts: [NPMJS_HOST] });

async function code(p: Promise<unknown>): Promise<NetError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof NetError) return e;
    throw e;
  }
  throw new Error('expected NetError');
}

interface Fx {
  expect: NetErrorCode;
  run: () => Promise<unknown>;
  causeCode?: string;
}

const FIXTURES: Fx[] = [
  {
    expect: 'timeout',
    // 永不返回、只响应 abort:由 timeoutMs 触发
    run: () =>
      httpGet(URL_OK, {
        ...opts(
          (_u, init: FetchInit) =>
            new Promise((_r, rej) => {
              init.signal.addEventListener('abort', () =>
                rej(Object.assign(new Error('aborted'), { name: 'AbortError' })),
              );
            }),
        ),
        timeoutMs: 30,
      }),
  },
  {
    expect: 'timeout',
    causeCode: 'UND_ERR_CONNECT_TIMEOUT',
    run: () => httpGet(URL_OK, opts(fail('UND_ERR_CONNECT_TIMEOUT'))),
  },
  { expect: 'dns', causeCode: 'ENOTFOUND', run: () => httpGet(URL_OK, opts(fail('ENOTFOUND'))) },
  { expect: 'dns', causeCode: 'EAI_AGAIN', run: () => httpGet(URL_OK, opts(fail('EAI_AGAIN'))) },
  {
    expect: 'connect',
    causeCode: 'ECONNREFUSED',
    run: () => httpGet(URL_OK, opts(fail('ECONNREFUSED'))),
  },
  {
    expect: 'connect',
    causeCode: 'ECONNRESET',
    run: () => httpGet(URL_OK, opts(fail('ECONNRESET'))),
  },
  {
    expect: 'tls',
    causeCode: 'CERT_HAS_EXPIRED',
    run: () => httpGet(URL_OK, opts(fail('CERT_HAS_EXPIRED'))),
  },
  {
    expect: 'tls',
    causeCode: 'DEPTH_ZERO_SELF_SIGNED_CERT',
    run: () => httpGet(URL_OK, opts(fail('DEPTH_ZERO_SELF_SIGNED_CERT'))),
  },
  {
    expect: 'proxy',
    causeCode: 'UND_ERR_PRX_TLS',
    run: () => httpGet(URL_OK, opts(fail('UND_ERR_PRX_TLS'))),
  },
  {
    expect: 'proxy',
    run: () =>
      httpGet(URL_OK, opts(fail(undefined, 'Proxy response (407) !== 200 when HTTP Tunneling'))),
  },
  {
    // 经代理时 ECONNREFUSED 指的是代理那一跳:归 proxy,原始 code 仍保留
    expect: 'proxy',
    causeCode: 'ECONNREFUSED',
    run: () => httpGet(URL_OK, { ...opts(fail('ECONNREFUSED')), viaProxy: true }),
  },
  {
    expect: 'too_large',
    run: () =>
      httpGet(URL_OK, {
        ...opts(() => Promise.resolve(res(200, 'x', { 'content-length': '999999' }))),
        maxBytes: 100,
      }),
  },
  {
    expect: 'too_large',
    run: () =>
      httpGet(URL_OK, {
        ...opts(() => Promise.resolve(res(200, 'x'.repeat(500)))),
        maxBytes: 100,
      }),
  },
  {
    expect: 'parse',
    run: () =>
      getPackument('https://registry.npmjs.org/', '@chovizzz/agent-kit', {
        fetch: () => Promise.resolve(res(200, '<html>captive portal</html>')),
      }),
  },
  {
    expect: 'host_denied',
    run: () =>
      httpGet(
        'http://registry.npmjs.org/x',
        opts(() => Promise.resolve(res(200))),
      ),
  },
  {
    expect: 'host_denied',
    run: () =>
      httpGet(
        'https://evil.example/x',
        opts(() => Promise.resolve(res(200))),
      ),
  },
  {
    expect: 'host_denied',
    run: () =>
      httpGet(
        `https://${['u:p', 'registry.npmjs.org'].join('@')}/x`,
        opts(() => Promise.resolve(res(200))),
      ),
  },
  {
    expect: 'http_404',
    run: () =>
      httpGet(
        URL_OK,
        opts(() => Promise.resolve(res(404))),
      ),
  },
  {
    expect: 'http_429',
    run: () =>
      httpGet(
        URL_OK,
        opts(() => Promise.resolve(res(429))),
      ),
  },
  {
    expect: 'http_500',
    run: () =>
      httpGet(
        URL_OK,
        opts(() => Promise.resolve(res(500))),
      ),
  },
  {
    expect: 'http_503',
    run: () =>
      httpGet(
        URL_OK,
        opts(() => Promise.resolve(res(503))),
      ),
  },
  {
    // 跨主机重定向不跟随
    expect: 'http_302',
    run: () =>
      httpGet(
        URL_OK,
        opts(() => Promise.resolve(res(302, '', { location: 'https://evil.example/y' }))),
      ),
  },
  {
    // https → http 降级重定向不跟随
    expect: 'http_301',
    run: () =>
      httpGet(
        URL_OK,
        opts(() => Promise.resolve(res(301, '', { location: 'http://registry.npmjs.org/y' }))),
      ),
  },
];

describe('net:错误归类,原因不被吞', () => {
  for (const [i, f] of FIXTURES.entries()) {
    it(`#${i} → ${f.expect}${f.causeCode ? `(原因 ${f.causeCode} 保留)` : ''}`, async () => {
      const e = await code(f.run());
      expect(e.code).toBe(f.expect);
      if (f.causeCode !== undefined) expect(e.causeCode).toBe(f.causeCode);
      expect(probeCalls).toBe(0);
    });
  }

  it('码清单 == 夹具覆盖清单(基础码都有夹具,http_NNN 另有 4xx/5xx/3xx)', () => {
    const covered = new Set(FIXTURES.map((f) => f.expect).filter((c) => !c.startsWith('http_')));
    expect([...covered].sort()).toEqual([...NET_ERROR_CODES].sort());
    const httpCodes = FIXTURES.map((f) => f.expect).filter((c) => c.startsWith('http_'));
    expect(httpCodes.some((c) => c.startsWith('http_4'))).toBe(true);
    expect(httpCodes.some((c) => c.startsWith('http_5'))).toBe(true);
    expect(httpCodes.some((c) => c.startsWith('http_3'))).toBe(true);
  });

  it('不同原因不会被吞成同一个码', async () => {
    const seen = new Set<string>();
    for (const f of FIXTURES) seen.add((await code(f.run())).code);
    expect(seen.size).toBe(NET_ERROR_CODES.length + 6); // 8 个基础码 + http_404/429/500/503/302/301
  });

  it('没有可识别 code 的异常:不编造原因,保留原始 name / message', async () => {
    const e = await code(httpGet(URL_OK, opts(fail(undefined, 'weird failure', 'WeirdError'))));
    expect(e.code).toBe('connect');
    expect(e.causeName).toBe('WeirdError');
    expect(e.causeMessage).toBe('weird failure');
    expect(e.cause).toBeInstanceOf(TypeError);
  });

  it('跨主机重定向保留 Location,便于排查', async () => {
    const e = await code(
      httpGet(
        URL_OK,
        opts(() => Promise.resolve(res(302, '', { location: 'https://evil.example/y' }))),
      ),
    );
    expect(e.status).toBe(302);
    expect(e.location).toBe('https://evil.example/y');
  });

  it('配了代理但没生效的提示挂在错误上', async () => {
    const e = await code(
      httpGet(URL_OK, { ...opts(fail('ETIMEDOUT')), proxyHint: 'proxy_env_ignored' }),
    );
    expect(e.code).toBe('timeout');
    expect(e.hint).toBe('proxy_env_ignored');
  });
});

describe('net:正常路径', () => {
  it('同主机重定向最多跟随 3 跳', async () => {
    let n = 0;
    const f: FetchLike = () => {
      n++;
      return Promise.resolve(n <= 3 ? res(301, '', { location: `/hop${n}` }) : res(200, 'done'));
    };
    const r = await httpGet(URL_OK, opts(f));
    expect(new TextDecoder().decode(r.body)).toBe('done');
    expect(r.url).toBe('https://registry.npmjs.org/hop3');
    n = 0;
    const loop: FetchLike = () => Promise.resolve(res(301, '', { location: '/again' }));
    expect((await code(httpGet(URL_OK, opts(loop)))).code).toBe('http_301');
  });

  it('getPackument:请求完整 packument(application/json,不是 install-v1),取 Date 头', async () => {
    const seen: { url: string; accept: string | undefined; redirect: string }[] = [];
    const f: FetchLike = (url, init) => {
      seen.push({ url, accept: init.headers['accept'], redirect: init.redirect });
      return Promise.resolve(
        res(200, JSON.stringify({ name: 'x', 'dist-tags': {} }), {
          date: 'Wed, 14 Oct 2026 07:24:51 GMT',
        }),
      );
    };
    const r = await getPackument('https://registry.npmjs.org/', '@chovizzz/agent-kit', {
      fetch: f,
    });
    expect(seen).toEqual([
      {
        url: 'https://registry.npmjs.org/@chovizzz%2fagent-kit',
        accept: 'application/json',
        redirect: 'manual',
      },
    ]);
    expect(r.dateHeader).toBe('Wed, 14 Oct 2026 07:24:51 GMT');
    expect(r.host).toBe('registry.npmjs.org');
    expect(probeCalls).toBe(0);
  });

  it('packumentUrl 对带 / 不带尾斜杠的镜像地址一致', () => {
    expect(packumentUrl('https://m.example/npm', '@a/b')).toBe('https://m.example/npm/@a%2fb');
    expect(packumentUrl('https://m.example/npm/', '@a/b')).toBe('https://m.example/npm/@a%2fb');
  });

  it('getDateHeader:缺失或空白 → undefined', () => {
    expect(getDateHeader({ headers: { get: () => null } })).toBeUndefined();
    expect(getDateHeader({ headers: { get: () => '  ' } })).toBeUndefined();
    expect(getDateHeader({ headers: { get: () => 'x' } })).toBe('x');
  });

  it('getAttestations:主机固定 npmjs;404 → absent;5xx / 超时仍抛(不被吞成 absent)', async () => {
    const urls: string[] = [];
    const ok: FetchLike = (u) => {
      urls.push(u);
      return Promise.resolve(res(200, '{"attestations":[]}'));
    };
    const r = await getAttestations('@chovizzz/agent-kit', '0.1.0-rc.0', { fetch: ok });
    expect(r.kind).toBe('ok');
    expect(urls[0]).toBe(
      'https://registry.npmjs.org/-/npm/v1/attestations/@chovizzz%2fagent-kit@0.1.0-rc.0',
    );
    expect(
      await getAttestations('@chovizzz/agent-kit', '0.0.0-stage', {
        fetch: () => Promise.resolve(res(404, '{"error":"Not found"}')),
      }),
    ).toEqual({ kind: 'absent' });
    expect(
      (
        await code(
          getAttestations('@chovizzz/agent-kit', '1.0.0', {
            fetch: () => Promise.resolve(res(503)),
          }),
        )
      ).code,
    ).toBe('http_503');
    expect(
      (await code(getAttestations('@chovizzz/agent-kit', '1.0.0', { fetch: fail('ENOTFOUND') })))
        .code,
    ).toBe('dns');
  });

  it('getTarball:算出 sha512(hex 与 SRI 两种写法),主机必须在白名单内', async () => {
    const bytes = new TextEncoder().encode('tarball-bytes');
    const want = createHash('sha512').update(bytes);
    const t = await getTarball('https://mirror.example/pkg.tgz', ['mirror.example', NPMJS_HOST], {
      fetch: () => Promise.resolve(res(200, bytes)),
    });
    expect(t.sha512Hex).toBe(want.copy().digest('hex'));
    expect(t.integrity).toBe(`sha512-${want.digest('base64')}`);
    expect(
      (
        await code(
          getTarball('https://attacker.example/pkg.tgz', ['mirror.example'], {
            fetch: () => Promise.resolve(res(200, bytes)),
          }),
        )
      ).code,
    ).toBe('host_denied');
  });
});

describe('net:重定向策略与响应体释放(评审 P2)', () => {
  function tracked(status: number, headers: Record<string, string> = {}) {
    let cancelled = 0;
    const r: FetchResponseLike = {
      status,
      headers: { get: (n) => headers[n.toLowerCase()] ?? null },
      body: new ReadableStream<Uint8Array>({
        pull() {
          return new Promise(() => undefined); // 永远挂住的响应体
        },
        cancel() {
          cancelled++;
        },
      }),
    };
    return { r, cancelled: () => cancelled };
  }

  it('同主机但带 userinfo(仅用户名 / 仅口令 / 两者)的重定向不跟随,不触发第二次 fetch', async () => {
    for (const loc of [
      `https://${['user', 'registry.npmjs.org'].join('@')}/next`,
      `https://${[':pw', 'registry.npmjs.org'].join('@')}/next`,
      `https://${['user:pw', 'registry.npmjs.org'].join('@')}/next`,
    ]) {
      let calls = 0;
      const t = tracked(302, { location: loc });
      const e = await code(
        httpGet(
          URL_OK,
          opts(() => {
            calls++;
            return Promise.resolve(t.r);
          }),
        ),
      );
      expect(e.code).toBe('http_302');
      expect(calls).toBe(1);
      expect(t.cancelled()).toBe(1);
    }
  });

  it('同主机但换端口的重定向不跟随', async () => {
    const e = await code(
      httpGet(
        URL_OK,
        opts(() =>
          Promise.resolve(res(302, '', { location: 'https://registry.npmjs.org:8443/y' })),
        ),
      ),
    );
    expect(e.code).toBe('http_302');
  });

  it('4xx / 5xx / 拒绝的重定向 / 被跟随的重定向,响应体都被取消', async () => {
    for (const status of [404, 503]) {
      const t = tracked(status);
      await code(
        httpGet(
          URL_OK,
          opts(() => Promise.resolve(t.r)),
        ),
      );
      expect(t.cancelled()).toBe(1);
    }
    const rejected = tracked(302, { location: 'https://evil.example/y' });
    await code(
      httpGet(
        URL_OK,
        opts(() => Promise.resolve(rejected.r)),
      ),
    );
    expect(rejected.cancelled()).toBe(1);
    const hop = tracked(301, { location: '/next' });
    let n = 0;
    const r = await httpGet(
      URL_OK,
      opts(() => Promise.resolve(n++ === 0 ? hop.r : res(200, 'ok'))),
    );
    expect(new TextDecoder().decode(r.body)).toBe('ok');
    expect(hop.cancelled()).toBe(1);
  });
});

describe('net:代理探测(Node 25.2 全局 fetch 默认忽略 HTTPS_PROXY,2026-10-14 实测)', () => {
  it('配了代理但没开 NODE_USE_ENV_PROXY → 提示 proxy_env_ignored,不经代理', () => {
    expect(detectProxy({ HTTPS_PROXY: 'http://p:1' })).toEqual({
      configured: true,
      honored: false,
      viaProxy: false,
      hint: 'proxy_env_ignored',
    });
  });
  it('NODE_USE_ENV_PROXY=1 / --use-env-proxy / NODE_OPTIONS → 经代理', () => {
    expect(detectProxy({ https_proxy: 'http://p:1', NODE_USE_ENV_PROXY: '1' }).viaProxy).toBe(true);
    expect(detectProxy({ HTTPS_PROXY: 'http://p:1' }, ['--use-env-proxy']).viaProxy).toBe(true);
    expect(
      detectProxy({
        HTTPS_PROXY: 'http://p:1',
        NODE_OPTIONS: '--max-old-space-size=1 --use-env-proxy',
      }).viaProxy,
    ).toBe(true);
  });
  it('没配代理 → 一切为 false', () => {
    expect(detectProxy({ NODE_USE_ENV_PROXY: '1' })).toEqual({
      configured: false,
      honored: true,
      viaProxy: false,
      hint: undefined,
    });
    expect(detectProxy({ HTTPS_PROXY: '  ' }).configured).toBe(false);
  });
});

describe('net:探针', () => {
  it('正向对照:不注入 fetch 时确实会走全局 fetch(探针被触发),说明上面「调用 0 次」不是空判据', async () => {
    const e = await code(httpGet(URL_OK, { allowedHosts: [NPMJS_HOST] }));
    expect(probeCalls).toBe(1);
    expect(e.code).toBe('connect');
    expect(e.causeMessage).toContain('probe');
  });
});
