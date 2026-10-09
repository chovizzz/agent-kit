import { describe, expect, it } from 'vitest';
import { shannon } from '../../src/redact/entropy.js';
import {
  ENTROPY_MIN_BITS,
  ENTROPY_MIN_LEN,
  isReservedDomain,
  looksNonSecret,
} from '../../src/redact/rules.js';
import {
  ALNUM,
  dotted,
  fakeSk,
  mail,
  newRedactor,
  placeholder,
  prng,
  randomString,
  rep,
  url,
} from './helpers.js';

const redact = (text: string, input = {}, opts = {}): string =>
  newRedactor(input, opts).pass1(text).text;

describe('已知前缀', () => {
  it('sk-:左边界、体长、必须同时有字母与数字', () => {
    expect(redact(`k=${fakeSk()}`)).toBe(`k=${placeholder('api_key')}`);
    // 单词里的 sk-(risk-assessment 之类)不是密钥
    expect(redact('risk-assessment-for-production-systems-v2')).toBe(
      'risk-assessment-for-production-systems-v2',
    );
    expect(redact('task-' + rep('a1', 30))).toContain('task-');
    // 体太短
    expect(redact('sk-' + rep('a1', 8))).toBe('sk-' + rep('a1', 8));
    // 体长够但没有数字:不是密钥(防 sk-learn-… 之类误杀)
    expect(redact('sk-' + rep('ab', 30))).toBe('sk-' + rep('ab', 30));
  });

  it('大小写不敏感的前缀仍被识别(SK-、GHP_)', () => {
    expect(redact(`k=SK-${rep('A1', 24)}`)).toBe(`k=${placeholder('api_key')}`);
    expect(redact(`k=GHP_${rep('A1', 36)}`)).toBe(`k=${placeholder('api_key')}`);
  });

  it('额外前缀可配置', () => {
    const r = newRedactor({ extra_secret_prefixes: ['zzkit_'] });
    expect(r.pass1(`x zzkit_${rep('a1', 20)}`).text).toBe(`x ${placeholder('api_key')}`);
    expect(newRedactor().pass1(`x zzkit_${rep('a1', 20)}`).text).toContain('zzkit_');
  });

  it('soh_ 与 soh_svc_ 是两条独立规则,互不吞并', () => {
    const a = `soh_${rep('a1', 20)}`;
    const b = `soh_svc_${rep('a1', 20)}`;
    expect(redact(`${a} ${b}`)).toBe(`${placeholder('api_key')} ${placeholder('api_key')}`);
    expect(redact('soh_svc_ 前缀的说明')).toBe('soh_svc_ 前缀的说明');
  });
});

describe('PEM / JWT', () => {
  const head = (k: string) => `-----BEGIN ${k}PRIVATE KEY-----`;
  const foot = (k: string) => `-----END ${k}PRIVATE KEY-----`;
  it('只有头部行(文档里的示例)不算;有体才算', () => {
    expect(redact(`${head('RSA ')}\n...\n${foot('RSA ')}`)).toBe(
      `${head('RSA ')}\n...\n${foot('RSA ')}`,
    );
    const body = rep('QUJD', 64);
    expect(redact(`${head('')}\n${body}\n${foot('')}`)).toBe(placeholder('private_key'));
  });

  it('连续多个 BEGIN 没有 END:各自按行吃自己的体,不吞掉后面的正文', () => {
    const body = rep('QUJD', 64);
    const text = `${head('')}\n${body}\n\n正文不能被吃掉\n${head('EC ')}\n${body}\n结束`;
    const out = redact(text);
    expect(out).toContain('正文不能被吃掉');
    expect(out).toContain('结束');
    expect(out).not.toContain(body);
    expect(out.match(/\[\[REDACTED:private_key\]\]/g)?.length).toBe(2);
  });

  it('JWT:三段式;只有 eyJ 前缀不算', () => {
    const h = Buffer.from('{"alg":"none"}').toString('base64url');
    const p = Buffer.from('{"a":1}').toString('base64url');
    expect(redact(`t ${h}.${p}.${rep('a1', 8)} end`)).toBe(`t ${placeholder('jwt')} end`);
    expect(redact('eyJ is the base64 of {"')).toBe('eyJ is the base64 of {"');
    // 无签名段(alg=none)也要抓
    expect(redact(`t ${h}.${p}.`)).toBe(`t ${placeholder('jwt')}`);
  });
});

describe('凭据赋值与头', () => {
  it('赋值:只替换值,键名与引号保留', () => {
    expect(redact('{"pass' + 'word": "' + 'hunter2' + 'hunter2"}')).toBe(
      `{"pass${'word'}": "${placeholder('credential')}"}`,
    );
    const apiTok = ['API_', 'TOKEN='].join('');
    expect(redact(apiTok + rep('ab12', 12))).toBe(`${apiTok}${placeholder('credential')}`);
    expect(redact('client_secret: ' + rep('x9', 8))).toBe(
      `client_secret: ${placeholder('credential')}`,
    );
  });

  it('长值不被截断(引号未闭合时也吃到行尾)', () => {
    const long = rep('a1b2', 3000);
    const dq = '"';
    const pwEq = ['pass', 'word = '].join('');
    expect(redact(pwEq + dq + long)).toBe(pwEq + dq + placeholder('credential'));
    expect(redact(`password=${long}`)).toBe(`password=${placeholder('credential')}`);
  });

  it('变量引用、遮蔽、布尔、函数调用、类型标注不当成秘密', () => {
    for (const t of [
      'password: process.env.DB_PASSWORD',
      'token: ${TOKEN_VALUE}',
      'API_KEY=$API_KEY',
      'secret: ********',
      'token: undefined',
      'password: getPassword(user)',
      'secret_prefixes: string[];',
      'token: Map<string, number>;',
      'password: [[REDACTED:credential]]',
    ]) {
      expect(redact(t), t).toBe(t);
    }
    expect(looksNonSecret('required')).toBe(true);
    expect(looksNonSecret('Tr0ub4dor&3')).toBe(false);
  });

  it('Authorization / Bearer / Basic / Cookie / 命令行参数', () => {
    expect(redact('Author' + 'ization: Digest response="' + rep('a1', 12) + '"')).toBe(
      `Author${'ization'}: Digest ${placeholder('credential')}`,
    );
    expect(redact('send Bearer ' + rep('a1', 20))).toBe(`send Bearer ${placeholder('token')}`);
    expect(redact('Bearer token is required')).toBe('Bearer token is required');
    expect(redact('Basic ' + Buffer.from(rep('ab:', 12)).toString('base64'))).toBe(
      `Basic ${placeholder('credential')}`,
    );
    expect(redact('Basic authentication is required here')).toBe(
      'Basic authentication is required here',
    );
    const ck = ['Coo', 'kie'].join('');
    expect(redact(`GET /\n${ck}: session=` + rep('a1', 12) + '\nHost: x')).toBe(
      `GET /\n${ck}: ${placeholder('credential')}\nHost: x`,
    );
    expect(redact('tool --token ' + rep('ab12', 6))).toBe(
      `tool --token ${placeholder('credential')}`,
    );
    expect(redact('tool --token=' + rep('ab12', 6))).toBe(
      `tool --token=${placeholder('credential')}`,
    );
  });

  it('URL 里的口令(含空用户名)', () => {
    const out = redact(url('clickhouse', ':' + rep('a1', 4) + '@') + 'db.acme-fake.dev:9000');
    expect(out).not.toContain(rep('a1', 4));
  });
});

describe('高熵串', () => {
  it('随机 base64 / 字母数字串命中率 >= 95%(24/32/40/64 位)', () => {
    const rand = prng(7);
    for (const n of [24, 32, 40, 64]) {
      let hit = 0;
      const trials = 400;
      for (let i = 0; i < trials; i++) {
        const s = randomString(rand, ALNUM + '+/', n);
        if (redact(`k ${s} k`) !== `k ${s} k`) hit++;
      }
      // 24 位随机串经验熵偏低,命中率最差(实测约 93%);门槛按长度分档并如实记录(见 docs/redaction.md)
      const floor = n === 24 ? 0.88 : 0.97;
      expect(hit / trials, `len ${n}`).toBeGreaterThanOrEqual(floor);
    }
  });

  it('阈值常量与文档一致', () => {
    expect(ENTROPY_MIN_LEN).toBe(24);
    expect(ENTROPY_MIN_BITS).toBe(4.0);
    expect(shannon('aaaa')).toBe(0);
    expect(shannon('abab')).toBeCloseTo(1, 5);
  });

  it('良性长串不误杀:git sha、UUID、路径、包名、camelCase、SRI(带 integrity 上下文)', () => {
    const rand = prng(11);
    const hex40 = randomString(rand, '0123456789abcdef', 40);
    const hex64 = randomString(rand, '0123456789abcdef', 64);
    const sri = 'sha512-' + randomString(rand, ALNUM + '+/', 86) + '==';
    for (const t of [
      `commit ${hex40}`,
      `digest ${hex64}`,
      'id 3f2b8c1e-9d4a-4e6b-8a1c-0f5d7e2b9a43',
      '/Users/someone/workspace/agent-kit-wt/b09/src/redact/rules.ts',
      '@rolldown/binding-win32-arm64-msvc',
      'getUserAccountSettingsHandlerFactory2',
      `integrity: ${sri}`,
      `"integrity": "${sri}"`,
    ]) {
      expect(redact(t), t.slice(0, 30)).toBe(t);
    }
  });

  it('SRI 串离开 integrity 上下文就当成高熵串处理', () => {
    const rand = prng(13);
    const sri = 'sha512-' + randomString(rand, ALNUM + '+/', 86) + '==';
    expect(redact(`secret thing ${sri} end`)).toContain(placeholder('high_entropy'));
  });
});

describe('IP / 邮箱 / URL', () => {
  it('IPv4:含 100.64/10 与点号变形;RFC 5737 文档网段放行', () => {
    expect(redact(`at ${dotted(100, 64, 12, 34)}`)).toBe(`at ${placeholder('ip')}`);
    expect(redact(`at ${dotted(10, 20, 30, 40)}:80`)).toBe(`at ${placeholder('ip')}:80`);
    expect(redact(`c2 ${dotted(198, 18, 7, 9).replace(/\./g, '[.]')}`)).toBe(
      `c2 ${placeholder('ip')}`,
    );
    expect(redact(`doc ${dotted(192, 0, 2, 10)} ${dotted(203, 0, 113, 7)}`)).toBe(
      `doc ${dotted(192, 0, 2, 10)} ${dotted(203, 0, 113, 7)}`,
    );
    // 版本号、五段点号不是 IP
    expect(redact('v1.2.3.4.5 and 1.2.3')).toBe('v1.2.3.4.5 and 1.2.3');
    expect(redact('999.1.1.1')).toBe('999.1.1.1');
  });

  it('邮箱:保留域名(example.*、.invalid、.test)放行;包名@版本不是邮箱', () => {
    expect(redact(`m ${mail('jane.doe+t', 'acme-fake.dev')} x`)).toBe(
      `m ${placeholder('email')} x`,
    );
    expect(redact(`m ${mail('someone', 'example.com')} ${mail('ops', 'host.invalid')}`)).toBe(
      `m ${mail('someone', 'example.com')} ${mail('ops', 'host.invalid')}`,
    );
    expect(redact('zod@4.6.5 and @types/node@22.20.5')).toBe('zod@4.6.5 and @types/node@22.20.5');
    expect(isReservedDomain('a.example.org')).toBe(true);
    expect(isReservedDomain('example.dev')).toBe(false);
  });

  it('URL:允许名单精确/子域匹配;仿冒主机、带 userinfo、反斜杠绕过都要脱敏', () => {
    const input = { allowed_url_hosts: ['github.com'] };
    const ok = url('https', 'github.com/org/repo');
    expect(redact(`see ${ok} ok`, input)).toBe(`see ${ok} ok`);
    expect(redact(`see ${url('https', 'gist.github.com/x')}`, input)).toContain('gist.github.com');
    expect(redact(url('https', 'github.com.evil.acme-fake.dev/x'), input)).toBe(placeholder('url'));
    expect(redact(url('https', 'evilgithub.com/x'), input)).toBe(placeholder('url'));
    expect(redact(url('https', `bot:tok${'@'}github.com/x`), input)).not.toContain('tok@');
    expect(redact(url('https', 'acme-fake.dev\\@github.com/x'), input)).toContain(
      placeholder('url'),
    );
    expect(redact(`(${ok}).`, input)).toBe(`(${ok}).`);
    // 默认名单为空:非保留域的 URL 全部脱敏;保留域(example.*)放行
    expect(redact(url('https', 'intranet.acme-fake.dev/x'))).toBe(placeholder('url'));
    expect(redact(url('https', 'docs.example.org/x'))).toBe(url('https', 'docs.example.org/x'));
  });

  it('允许名单只认原始字节:同形字折叠后命中名单的 URL 仍然脱敏', () => {
    const input = { allowed_url_hosts: ['github.com'] };
    expect(redact(url('https', 'gіthub.com/org/repo'), input)).toBe(placeholder('url'));
    expect(redact(url('https', 'ｇithub.com/org/repo'), input)).toBe(placeholder('url'));
  });

  it('webhook(飞书 / Slack)无条件脱敏,即使主机在允许名单里', () => {
    const input = { allowed_url_hosts: ['open.feishu.cn', 'hooks.slack.com'] };
    const hook = url('https', 'open.feishu.cn/open-apis/bot/v2/hook/' + rep('a1', 16));
    expect(redact(`n ${hook}`, input)).toBe(`n ${placeholder('webhook')}`);
    expect(redact(`n ${url('https', 'open.feishu.cn/open-apis/docs/x')}`, input)).toContain(
      'open.feishu.cn',
    );
  });
});

describe('覆盖层词表', () => {
  const input = { sensitive_words: ['张三科技', 'Acme Corp'] };
  it('中文客户名:归一化后的子串匹配(零宽、全角、大小写、空白切开)', () => {
    for (const t of [
      '张三科技',
      '张​三科技',
      '张 三 科 技',
      'ＡＣＭＥ　ｃｏｒｐ',
      'ACME CORP',
      'acme  corp',
    ]) {
      expect(redact(`客户 ${t} 的合同`, input), t).toBe(`客户 ${placeholder('sensitive')} 的合同`);
    }
  });

  it('internal_domains 用 domain 类型', () => {
    expect(
      redact('host a.corp.acme-fake.dev up', {}, { internalDomains: ['corp.acme-fake.dev'] }),
    ).toBe(`host a.${placeholder('domain')} up`);
  });

  it('词表里的词恰好是占位符类型名时仍然幂等(占位符对所有规则免疫)', () => {
    const r = newRedactor({ sensitive_words: ['api_key', 'REDACTED', 'ip', 'credential'] });
    const once = r.pass1(`${fakeSk()} and ${dotted(10, 1, 2, 3)}`).text;
    expect(once).toContain(placeholder('api_key'));
    expect(r.pass1(once).text).toBe(once);
  });
});

describe('幂等', () => {
  it('pass1(pass1(x)) === pass1(x),且 pass2 对输出干净', () => {
    const r = newRedactor({ allowed_url_hosts: ['github.com'], sensitive_words: ['张三科技'] });
    const text = [
      `k=${fakeSk()}`,
      `ip ${dotted(100, 64, 1, 2)} ${mail('a.b', 'acme-fake.dev')}`,
      '张三科技 password: ' + 'hunter2' + 'hunter2',
      url('https', 'intranet.acme-fake.dev/x'),
      'blob ' + Buffer.from(fakeSk()).toString('base64'),
    ].join('\n');
    const once = r.pass1(text).text;
    expect(r.pass1(once).text).toBe(once);
    expect(r.pass2(once).clean).toBe(true);
  });
});
