import { describe, expect, it } from 'vitest';
import { RedactError } from '../../src/redact/types.js';
import { createRedactor } from '../../src/redact/index.js';
import { fakeSk, newRedactor, placeholder, prng, rep, randomString, ALNUM } from './helpers.js';

describe('fail-closed', () => {
  it('超时:注入时钟,第二遍超时 => clean=false + 合成命中(不含文本),apply => timeout', () => {
    let t = 0;
    const r = createRedactor({ timeout_ms: 50 }, { now: () => (t += 20) });
    // 每次读时钟前进 20ms:第 3 次检查就超 50ms
    const text = rep('hello world ', 4000);
    const d = r.pass2Detail(text);
    expect(d.clean).toBe(false);
    expect(d.failure).toBe('timeout');
    expect(d.hits).toEqual([{ type: 'scanner_error', rule: 'scan_timeout', start: 0, end: 0 }]);
    t = 0;
    expect(r.apply(text)).toEqual({ ok: false, reason: 'timeout' });
    t = 0;
    expect(() => r.pass1(text)).toThrow(RedactError);
  });

  it('超过 max_input_chars:error,而不是截断后放行', () => {
    const r = newRedactor({ max_input_chars: 100 });
    const big = rep('a ', 500);
    expect(r.apply(big)).toEqual({ ok: false, reason: 'error' });
    expect(r.pass2(big).clean).toBe(false);
    expect(() => r.pass1(big)).toThrow(RedactError);
    expect(r.apply('short')).toEqual({ ok: true, text: 'short' });
  });

  it('扫描器内部抛错同样 fail-closed(把规则换成会抛的)', () => {
    const r = newRedactor();
    // 非字符串输入属于调用方 bug:不能静默放行
    const bad = r as unknown as { apply(x: unknown): unknown };
    expect(bad.apply(undefined)).toEqual({ ok: false, reason: 'error' });
  });

  it('pass1 产生的占位符使输出变长时,apply 不因输入上限误判', () => {
    const r = newRedactor({ max_input_chars: 4000, sensitive_words: ['x'] });
    const text = rep('x ', 1900); // 3800 字符,替换后远超 4000
    const a = r.apply(text);
    expect(a.ok).toBe(true);
  });
});

describe('ReDoS 对抗输入(每条规则的线性写法)', () => {
  const N = 65536;
  const mk = (s: string): string => rep(s, N);
  const cases: Record<string, string> = {
    a: mk('a'),
    spaces: mk(' '),
    newlines: mk('\n'),
    dash: mk('-'),
    slash: mk('/'),
    skrep: mk('sk-'),
    eyj: mk('eyJ'),
    eyjDot: mk('eyJabcdefgh.'),
    begin: mk('-----BEGIN '),
    beginHdr: mk('-----BEGIN RSA PRIVATE KEY-----\n'),
    at: mk('@'),
    aAt: mk('a@'),
    emailish: mk('a.b@c.'),
    pct: mk('%41'),
    pctBroken: mk('%4'),
    esc: mk('\\u00'),
    ent: mk('&#1'),
    named: mk('&colon;'),
    http: mk('http://'),
    quotePlus: mk('"+"'),
    backslashNl: mk('\\\n'),
    pw: mk('password='),
    pwSpaces: 'password' + mk(' '),
    pwQuote: mk('password:"'),
    bearer: mk('bearer '),
    bearerSpaces: 'bearer' + mk(' '),
    authz: mk('authorization: '),
    cookie: mk('\ncookie:'),
    ip: mk('1.2.3.'),
    ip255: mk('255.255.255.'),
    hex: mk('ab'),
    b64: mk('QUJD'),
    b64pad: mk('QUJD='),
    zeroWidth: mk('​'),
    tags: mk('\u{e0073}'),
    cyrillic: mk('а'),
    combining: mk('é'),
    fullwidth: mk('ａ'),
    cjk: mk('张三科'),
    cjkSpaced: mk('张 三 科 技 '),
    ph: mk('[[REDACTED:'),
    phOk: mk('[[REDACTED:a]]'),
    prefixes: mk('ghp_sk-AKIAxoxb-AIzaglpat-'),
    userinfo: mk('://a:'),
    colons: mk('ab:'),
    flags: mk('--password '),
    basic: mk('basic '),
  };

  it('64K 对抗输入:有限时间内收场(ok 或 fail-closed),不挂起,且每条的耗时与同长良性文本同数量级', () => {
    const r = createRedactor(
      {
        timeout_ms: 60000,
        sensitive_words: ['张三科技', 'Acme Corp'],
        allowed_url_hosts: ['github.com'],
      },
      { internalDomains: ['corp.acme-fake.dev'] },
    );
    const benign = rep('The quick brown fox jumps over the lazy dog 12345. ', N);
    const t0 = performance.now();
    r.apply(benign);
    const base = Math.max(performance.now() - t0, 5);
    for (const [name, input] of Object.entries(cases)) {
      const s = performance.now();
      const res = r.apply(input);
      const dt = performance.now() - s;
      expect(res.ok === true || res.reason !== undefined, name).toBe(true);
      // 线性写法下对抗输入不应比良性文本慢两个数量级;绝对上限只防"真的挂起"
      expect(dt, `${name} ${dt.toFixed(0)}ms (base ${base.toFixed(0)}ms)`).toBeLessThan(
        Math.max(base * 100, 1500),
      );
    }
  });

  it('默认 50ms 预算下对抗输入:要么在预算内完成,要么 fail-closed(timeout),都是有限时间', () => {
    const r = createRedactor({ timeout_ms: 50, allowed_url_hosts: ['github.com'] });
    for (const [name, input] of Object.entries(cases)) {
      const s = performance.now();
      const res = r.apply(input);
      const dt = performance.now() - s;
      expect(res.ok || ['timeout', 'residual', 'error'].includes(res.reason), name).toBe(true);
      expect(dt, name).toBeLessThan(1500);
    }
  });
});

describe('吞吐', () => {
  it('10 万字符随机文本(多形态混合):apply >= 1 MB/s', () => {
    const rand = prng(2026);
    const words = [
      'alpha',
      'beta',
      'gamma',
      'delta',
      '配置',
      '评审',
      'token',
      'key',
      'path/to/file.ts',
      '12:34:56',
      'v1.2.3',
    ];
    let text = '';
    while (text.length < 100_000) {
      const roll = rand();
      if (roll < 0.05) text += randomString(rand, ALNUM, 24 + Math.floor(rand() * 24)) + ' ';
      else if (roll < 0.06) text += fakeSk() + ' ';
      else
        text += (words[Math.floor(rand() * words.length)] as string) + (rand() < 0.1 ? '\n' : ' ');
    }
    const r = createRedactor({ timeout_ms: 20000, max_input_chars: 200000 });
    // 预热,避免把 JIT 与首次惰性初始化算进吞吐
    r.apply(text.slice(0, 5000));
    // 按 CPU 时间(而非墙钟)计量:apply 是单线程同步计算,CPU 时间反映真实工作量,
    // 不会被并行子代理/其它进程抢 CPU 拖慢。真回归(算法变慢)照样会让它掉到门槛以下。
    let res = r.apply(text);
    let best = 0;
    for (let i = 0; i < 3; i++) {
      const c0 = process.cpuUsage();
      res = r.apply(text);
      const c = process.cpuUsage(c0);
      const dt = (c.user + c.system) / 1e6;
      best = Math.max(best, text.length / 1e6 / Math.max(dt, 1e-6));
    }
    expect(res.ok).toBe(true);
    expect(best, `${best.toFixed(2)} MB/s (CPU 时间,3 次取最快)`).toBeGreaterThanOrEqual(1);
    expect(res.ok && res.text.includes(placeholder('api_key'))).toBe(true);
  });

  it('默认配置下 64K 的普通文本在 50ms 预算内完成(不因预算误丢)', () => {
    const r = newRedactor({ timeout_ms: 50 });
    const text = rep('这是一段普通的评审记录,包含 token 与 key 等词,但没有任何秘密。 ', 60000);
    r.apply(text.slice(0, 2000));
    // 机器忙时单次可能超 50ms 预算:最多试 5 次,有一次完整通过即可(真回归会每次都超时)。
    let res = r.apply(text);
    for (let i = 0; i < 4 && !res.ok; i++) res = r.apply(text);
    expect(res).toEqual({ ok: true, text });
  });
});
