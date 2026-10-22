/**
 * s10:`NAME="长一点的段"值`(引号段 >= 8 字符、收尾引号后紧贴值)的拼接。
 * 此前只有短前缀(<= 7 字符)被当作同一个词,长段时第一遍只脱敏引号段、紧贴其后的值留在输出里,apply 放行。
 * 口令全部运行时拼装;负向断言旁边钉死正向前提(占位符确实出现 / 对照组仍被脱敏)。
 */
import { describe, expect, it } from 'vitest';
import { newRedactor } from './helpers.js';

const r = newRedactor();
const PH = '[[REDACTED:';
const PW = ['pass', 'word'].join('');
const KEY = ['API', '_TOK', 'EN'].join('');
const V = ['Kq7', 'Zr2', 'WxLm9', 'Tb'].join('');
const SEG = 'abcdefghijkl';

function applyText(input: string): string {
  const a = r.apply(input);
  expect(a.ok, `apply 应放行: ${input}`).toBe(true);
  return a.ok ? a.text : '';
}

describe('s10:长引号段 + 紧贴的值', () => {
  it.each([
    ['双引号', `${PW}="${SEG}"${V}`],
    ['单引号', `${PW}='${SEG}'${V}`],
    ['export + 大写键', `export ${KEY}="${SEG}"${V}`],
    ['带分号后文', `${PW}="${SEG}"${V}; echo done`],
    ['段恰好 8 字符', `${PW}="abcdefgh"${V}`],
    ['段恰好 7 字符(短前缀路径)', `${PW}="abcdefg"${V}`],
    ['值以数字开头', `${PW}="${SEG}"7${V}`],
    ['值以下划线开头', `${PW}="${SEG}"_${V}`],
  ])('%s:值被脱敏,整个词一个占位符', (_n, input) => {
    const out = applyText(input);
    expect(out).toContain(PH);
    expect(out.includes(V)).toBe(false);
    expect(out.includes(SEG)).toBe(false);
    expect(r.pass1(input).text.includes(V)).toBe(false);
  });

  it('后随值之后还有引号段:整词(三段)都脱敏', () => {
    const input = `${PW}="${SEG}"${V}"tailpart1"`;
    const out = applyText(input);
    expect(out).toContain(PH);
    expect(out.includes(V)).toBe(false);
    expect(out.includes('tailpart1')).toBe(false);
  });

  it('转义引号(JSON 字符串里的 \\")同样脱敏', () => {
    const q = '\\"';
    const input = `{"cmd":"${PW}=${q}${SEG}${q}${V}"}`;
    const out = applyText(input);
    expect(out).toContain(PH);
    expect(out.includes(V)).toBe(false);
  });

  it('pass2 对原文(未经第一遍)判不干净:probe/规则仍工作', () => {
    expect(r.pass2(`${PW}="${SEG}"${V}`).clean).toBe(false);
  });

  it('原文自带占位符:占位符之后的行为不变(不把占位符当值吞掉后再泄漏)', () => {
    const ph = `${PH}credential]]`;
    const out = applyText(`${PW}="${SEG}"${ph}`);
    expect(out.includes(SEG)).toBe(false);
  });
});

describe('s10:不该被过度吞掉的形态', () => {
  const benign: Array<[string, string, string[]]> = [
    ['引号值后空格 + 注释', `${PW}="${SEG}" # comment words`, ['# comment words']],
    ['引号值后空格 + 命令', `${PW}="${SEG}" && echo hello`, ['&& echo hello']],
    ['多个独立引号参数', `${PW}="${SEG}" "second arg"`, ['"second arg"']],
    ['多个独立引号参数(单引号)', `${PW}='${SEG}' 'second'`, ["'second'"]],
    ['收尾引号后 JSON 逗号', `{"${PW}":"${SEG}","user":"alice"}`, ['"user":"alice"']],
    ['收尾引号后 JSON 花括号', `{"${PW}":"${SEG}"}`, ['}']],
    ['收尾引号后点号(源码方法调用)', `${PW} = "${SEG}".trim()`, ['.trim()']],
    ['收尾引号后加号(源码拼接)', `${PW} = "${SEG}" + suffix`, ['+ suffix']],
    ['收尾引号后紧贴加号', `${PW} = "${SEG}"+suffix`, ['suffix']],
    ['收尾引号后右括号', `connect(${PW}="${SEG}")`, [')']],
  ];

  it.each(benign)('%s:口令段脱敏,后文原样保留', (_n, input, keep) => {
    const out = applyText(input);
    expect(out).toContain(PH);
    expect(out.includes(SEG)).toBe(false);
    for (const k of keep) expect(out, `应保留 ${k}`).toContain(k);
  });

  it('无键名的 shell 引号拼接不动(echo "x"y)', () => {
    const input = `echo "${SEG}"suffixword`;
    expect(r.pass1(input).text).toBe(input);
    expect(applyText(input)).toBe(input);
  });

  it('非敏感键名的引号拼接不动', () => {
    const input = `NAME="${SEG}"${V}`;
    expect(r.pass1(input).text).toBe(input);
  });

  it('幂等:第二遍对第一遍输出不再改动', () => {
    const input = `${PW}="${SEG}"${V}`;
    const once = r.pass1(input).text;
    expect(r.pass1(once).text).toBe(once);
    expect(r.pass2(once).clean).toBe(true);
  });
});
