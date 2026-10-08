import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_SOURCE } from '../../src/contracts/redact.js';
import { buildView, compactRanges, deriveRemoving, mapSpan } from '../../src/redact/view.js';
import { dotted, fakeSk, mail, newRedactor, placeholder, prng, rep } from './helpers.js';

describe('第二遍:占位符严格格式,先剥后扫', () => {
  const r = newRedactor();

  it('合法占位符放行,且只有格式完全匹配契约正则的才算', () => {
    expect(new RegExp(`^${PLACEHOLDER_SOURCE}$`).test(placeholder('api_key'))).toBe(true);
    expect(r.pass2(`a ${placeholder('secret')} b ${placeholder('ip')}`).clean).toBe(true);
  });

  it('占位符里塞秘密:不是合法占位符,不剥离,照扫', () => {
    expect(r.pass2(`[[REDACTED:${fakeSk()}]]`).clean).toBe(false);
    expect(r.pass2(`[[REDACTED:${dotted(10, 1, 2, 3)}]]`).clean).toBe(false);
  });

  it('秘密紧贴占位符、被占位符从中间切开:剥离后拼回再扫,仍然抓得到', () => {
    const k = fakeSk();
    expect(r.pass2(`${placeholder('a')}${k}${placeholder('b')}`).clean).toBe(false);
    expect(r.pass2(`${k.slice(0, 12)}${placeholder('x')}${k.slice(12)}`).clean).toBe(false);
  });

  it('伪造变形不会被当成占位符放过:嵌套、大小写、空类型、过长类型,里面的秘密照样被抓', () => {
    const k = fakeSk();
    for (const t of [
      `[[REDACTED:[[REDACTED:jwt]]${k}]]`,
      `[[REDACTED:JWT]]${k}`,
      `[[REDACTED:]]${k}`,
      `[[REDACTED:${rep('a', 40)}]]${k}`,
      `[ [REDACTED:x] ]${k}`,
    ]) {
      expect(r.pass2(t).clean, t.slice(0, 24)).toBe(false);
    }
    // 过长类型不剥离,于是按普通文本扫(里面没秘密就是干净的;关键是没有豁免)
    const longType = `[[REDACTED:${rep('a', 40)}]]`;
    expect(r.pass2(longType).clean).toBe(true);
    expect(r.pass1(longType).text).toBe(longType);
  });

  it('零宽字符插进占位符里的伪造写法同样没有豁免', () => {
    const k = fakeSk();
    expect(r.pass2(`[[REDACTED:​x]]${k}`).clean).toBe(false);
  });

  it('命中只含类型/规则/偏移,不含命中文本', () => {
    const k = fakeSk();
    const d = r.pass2(`prefix ${k} suffix`);
    expect(d.clean).toBe(false);
    for (const h of d.hits) {
      expect(Object.keys(h).sort()).toEqual(['end', 'rule', 'start', 'type']);
      expect(JSON.stringify(h)).not.toContain(k);
    }
  });

  it('pass2 的偏移是输入文本的坐标(含零宽/归一化膨胀时也指回原文)', () => {
    const k = fakeSk();
    const text = `前缀​​ ${k.slice(0, 5)}⁠${k.slice(5)} 后缀`;
    const d = r.pass2(text);
    expect(d.clean).toBe(false);
    const h = d.hits.find((x) => x.rule === 'prefix_sk');
    expect(h).toBeDefined();
    const slice = text.slice(h!.start, h!.end);
    expect(slice.replace(/[​⁠]/g, '')).toBe(k);
  });
});

describe('pass2 独立残留探测器', () => {
  it('pass1 的规则被禁用(模拟规则 bug)时,apply 仍然 fail-closed 为 residual', () => {
    const r = newRedactor({}, { disabledRules: ['prefix_sk'] });
    expect(r.apply(`k=${fakeSk()}`)).toEqual({ ok: false, reason: 'residual' });
    expect(r.pass2(`k=${fakeSk()}`).hits.some((h) => h.rule === 'probe_sk')).toBe(true);
  });
});

describe('camelCase 键名赋值', () => {
  it('secretKey / signingToken / apiSecretKey 也会被抓', () => {
    const r = newRedactor();
    const v = 'ab12'.repeat(5);
    for (const k of ['secretKey', 'signingToken', 'apiSecretKey']) {
      expect(r.pass1(`${k} = "${v}"`).text, k).toBe(`${k} = "${placeholder('credential')}"`);
    }
  });
});

describe('apply 的语义', () => {
  const r = newRedactor();
  it('干净输入原样返回;有秘密返回脱敏文本;残留 fail-closed', () => {
    expect(r.apply('nothing here')).toEqual({ ok: true, text: 'nothing here' });
    expect(r.apply(`k=${fakeSk()}`)).toEqual({ ok: true, text: `k=${placeholder('api_key')}` });
    expect(r.apply('')).toEqual({ ok: true, text: '' });
  });
});

describe('视图映射(属性测试)', () => {
  it('随机插入零宽/全角/组合符号后,视图下标 -> 原文区间单调,且切片能还原被命中的文本', () => {
    const rand = prng(99);
    const noise = ['​', '‍', '⁠', '﻿', '­'];
    for (let n = 0; n < 200; n++) {
      const body = fakeSk(10 + Math.floor(rand() * 20));
      let text = `前缀${n} `;
      for (const ch of body)
        text += rand() < 0.3 ? ch + (noise[Math.floor(rand() * noise.length)] as string) : ch;
      text += ' 尾';
      const v = buildView(text);
      expect(v.text.includes(body), `n=${n}`).toBe(true);
      const at = v.text.indexOf(body);
      const [a, b] = mapSpan(v, at, at + body.length);
      expect(text.slice(a, b).replace(/[​‍⁠﻿­]/g, '')).toBe(body);
      if (v.starts && v.ends) {
        for (let i = 1; i < v.starts.length; i++) {
          expect(v.starts[i] as number).toBeGreaterThanOrEqual(v.starts[i - 1] as number);
          expect(v.ends[i] as number).toBeGreaterThanOrEqual(v.ends[i - 1] as number);
        }
      }
    }
  });

  it('NFKC 会膨胀的字符(㈱ -> (株))映射到同一个原文字符,不会错位', () => {
    const text = `前㈱后 ${fakeSk()}`;
    const v = buildView(text);
    expect(v.text).toContain('(株)');
    const at = v.text.indexOf('sk-');
    const [a, b] = mapSpan(v, at, at + 5);
    expect(text.slice(a, b)).toBe('sk-a1');
  });

  it('叠加视图(去占位符、压缩)后映射仍指向最初的原文', () => {
    const text = `ab ${placeholder('ip')} cd`;
    const v0 = buildView(text);
    const ph = text.indexOf('[[');
    const v1 = deriveRemoving(v0, [[ph, ph + placeholder('ip').length]]);
    expect(v1.text).toBe('ab  cd');
    const [a, b] = mapSpan(v1, 4, 6);
    expect(text.slice(a, b)).toBe('cd');
    expect(compactRanges('a "+" b')).toEqual([[1, 6]]);
    expect(compactRanges('a b')).toEqual([]);
    // 换行后的行首引用/注释标记算分隔;行中间的 > # * 不算
    expect(compactRanges('a\n> b')).toEqual([[1, 4]]);
    expect(compactRanges('a\n// b')).toEqual([[1, 5]]);
    expect(compactRanges('a > b # c')).toEqual([]);
  });
});

describe('连接 / 分行', () => {
  const r = newRedactor();
  it('JS 加号、Python 相邻字面量、反斜杠续行、裸换行', () => {
    const body = rep('a1', 22);
    for (const t of [
      `x = "sk-" + "${body}"`,
      `x = ("sk-" '${body}')`,
      `x = sk-\\\n${body}`,
      `x = sk-\n${body}`,
      `x = "sk-"\n  "${body.slice(0, 10)}"\n  "${body.slice(10)}"`,
    ]) {
      expect(r.pass2(t).clean, t).toBe(false);
      const out = r.pass1(t).text;
      expect(out, t).toContain(placeholder('api_key'));
      expect(out.includes(body.slice(0, 10)), t).toBe(false);
    }
  });

  it('普通秘密后面的单词不会被粘进替换区间', () => {
    const out = r.pass1(`sk 密钥 ${fakeSk()} 然后继续写字 and more words`).text;
    expect(out.endsWith('然后继续写字 and more words')).toBe(true);
    expect(r.pass1(`${mail('a', 'acme-fake.dev')}\nnext line stays`).text).toBe(
      `${placeholder('email')}\nnext line stays`,
    );
  });
});

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32(s: string): string {
  let bits = '';
  for (const b of Buffer.from(s)) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5)
    out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

describe('编码', () => {
  const r = newRedactor();
  const sk = fakeSk();
  it('base64(含错位、折行)/ hex / 百分号 / \\u 转义 / 实体', () => {
    const cases = [
      Buffer.from(sk).toString('base64'),
      `xy${Buffer.from('z:' + sk).toString('base64')}`,
      (
        Buffer.from(sk)
          .toString('base64')
          .match(/.{1,16}/g) ?? []
      ).join('\n'),
      Buffer.from(sk).toString('hex'),
      [...Buffer.from(sk)].map((b) => `%${b.toString(16)}`).join(''),
      '\\u0073' + sk.slice(1),
      '&#115;' + sk.slice(1),
      '\\u{73}' + sk.slice(1),
      '\\163\\153' + sk.slice(2),
      b32(sk),
      'sk&#45;' + sk.slice(3),
    ];
    for (const c of cases) {
      expect(r.pass2(c).clean, c.slice(0, 20)).toBe(false);
      const out = r.pass1(c).text;
      expect(out.includes(sk.slice(3)), c.slice(0, 20)).toBe(false);
    }
  });

  it('混合部分编码的口令(只有 @ 被编码)', () => {
    const t = 'ssh' + '://admin:P%40ss' + 'w0rd' + '@' + 'db.acme-fake.dev/x';
    expect(r.pass2(t).clean).toBe(false);
    expect(r.pass1(t).text).not.toContain('P%40ss');
  });

  it('命名实体(&colon; &commat;)解码后的 userinfo', () => {
    const t = 'ssh' + '://admin&colon;hunter2' + 'hunter2&commat;' + 'db.acme-fake.dev/x';
    expect(r.pass2(t).clean).toBe(false);
  });

  it('二进制垃圾 base64 不会被当成文本解码出命中', () => {
    const rand = prng(5);
    let junk = '';
    for (let i = 0; i < 64; i++) junk += String.fromCharCode(Math.floor(rand() * 256));
    const blob = Buffer.from(junk, 'latin1').toString('base64');
    // 没有高熵之外的命中理由;只要求不抛、不超时
    expect(() => r.pass2(`x ${blob} y`)).not.toThrow();
  });

  it('深度:二层 base64 第一遍就抓;三层 base64 靠第二遍(此处也被熵规则兜住,所以用百分号验证深度)', () => {
    const two = Buffer.from(Buffer.from(sk).toString('base64')).toString('base64');
    expect(r.pass1(`x ${two}`).text).toContain(placeholder('api_key'));
    const pct3 = `sk%25252D${rep('a1', 22)}`;
    expect(r.pass1(pct3).text).toBe(pct3);
    expect(r.pass2(pct3).clean).toBe(false);
    expect(r.apply(pct3)).toEqual({ ok: false, reason: 'residual' });
    const pct4 = `sk%2525252D${rep('a1', 22)}`;
    expect(r.pass2(pct4).clean).toBe(true); // 四层:已知上限,见 docs/redaction.md
  });
});

describe('不可见字符与同形字', () => {
  const r = newRedactor();
  it('tag 字符把 ASCII 藏成不可见串', () => {
    const hidden = [...fakeSk()]
      .map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0)))
      .join('');
    expect(r.pass2(`看起来是空的:${hidden}`).clean).toBe(false);
    expect(r.pass1(`看起来是空的:${hidden}`).text).toBe(`看起来是空的:${placeholder('api_key')}`);
  });

  it('同形字母 / 全角 / 组合符号', () => {
    const body = rep('a1', 22);
    for (const p of ['ѕk-', 'sκ-', 'ｓｋ-', 'śk-', 'S​K-']) {
      expect(r.pass2(`k=${p}${body}`).clean, JSON.stringify(p)).toBe(false);
    }
  });
});
