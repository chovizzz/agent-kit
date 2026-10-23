/**
 * s10:`NAME="长一点的段"值`(引号段 >= 8 字符、收尾引号后紧贴值)的拼接。
 * 此前只有短前缀(<= 7 字符)被当作同一个词,长段时第一遍只脱敏引号段、紧贴其后的值留在输出里,apply 放行。
 * 口令全部运行时拼装;负向断言旁边钉死正向前提(占位符确实出现 / 对照组仍被脱敏)。
 */
import { describe, expect, it } from 'vitest';
import { buildSeeds } from '../../src/redact/seeds.js';
import { newRedactor } from './helpers.js';

const r = newRedactor();
const PH = '[[REDACTED:';
const PW = ['pass', 'word'].join('');
const KEY = ['API', '_TOK', 'EN'].join('');
const V = ['Kq7', 'Zr2', 'WxLm9', 'Tb'].join('');
const SEG = 'abcdefghijkl';
/** 自身就是口令的长段(足够高熵,单独出现也会被第一遍脱敏) */
const SEG2 = ['Hk3m', 'Q9xT', 'z2Lp', 'Wn'].join('');

function applyText(input: string): string {
  const a = r.apply(input);
  expect(a.ok, `apply 应放行: ${input}`).toBe(true);
  return a.ok ? a.text : '';
}

describe('s10:种子登记', () => {
  it('s10.long_segment_concat 是 recognized 种子,gap.long_segment_concat 已不存在', () => {
    const seeds = buildSeeds();
    expect(seeds.find((x) => x.id === 's10.long_segment_concat')?.tier).toBe('recognized');
    expect(seeds.some((x) => x.id === 'gap.long_segment_concat')).toBe(false);
  });
});

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

  it.each([
    ['连字符', '-'],
    ['斜杠', '/'],
  ])('收尾引号后紧贴%s再接值:并词脱敏', (_n, ch) => {
    const out = applyText(`${PW}="${SEG}"${ch}${V}`);
    expect(out).toContain(PH);
    expect(out.includes(V)).toBe(false);
  });

  it('段是普通词、后随值才是口令:值被脱敏', () => {
    const out = applyText(`${PW}="password"${V}`);
    expect(out.includes(V)).toBe(false);
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
    expect(out.includes(V)).toBe(false);
    expect(out.split(PH).length - 1).toBe(1);
    expect(out.startsWith('{"cmd":"')).toBe(true);
    expect(out.endsWith('"}')).toBe(true);
  });

  it('pass2 对原文(未经第一遍)判不干净:probe/规则仍工作', () => {
    expect(r.pass2(`${PW}="${SEG}"${V}`).clean).toBe(false);
  });

  it('原文自带占位符:占位符之后的行为不变(不把占位符当值吞掉后再泄漏)', () => {
    const ph = `${PH}credential]]`;
    const out = applyText(`${PW}="${SEG2}"${ph}`);
    expect(out).toContain(PH);
    expect(out.includes(SEG2)).toBe(false);
  });
});

describe('s10:不该被过度吞掉的形态', () => {
  const benign: Array<[string, string, string[]]> = [
    ['引号值后空格 + 注释', `${PW}="${SEG2}" # comment words`, ['# comment words']],
    ['引号值后空格 + 命令', `${PW}="${SEG2}" && echo hello`, ['&& echo hello']],
    ['多个独立引号参数', `${PW}="${SEG2}" "second arg"`, ['"second arg"']],
    ['多个独立引号参数(单引号)', `${PW}='${SEG2}' 'second'`, ["'second'"]],
    ['收尾引号后 JSON 逗号', `{"${PW}":"${SEG2}","user":"alice"}`, ['"user":"alice"']],
    ['收尾引号后 JSON 花括号', `{"${PW}":"${SEG2}"}`, ['}']],
    ['收尾引号后点号(源码方法调用)', `${PW} = "${SEG2}".trim()`, ['.trim()']],
    ['收尾引号后加号(源码拼接)', `${PW} = "${SEG2}" + suffix`, ['+ suffix']],
    ['收尾引号后紧贴加号', `${PW} = "${SEG2}"+suffix`, ['suffix']],
    ['收尾引号后右括号', `connect(${PW}="${SEG2}")`, [')']],
  ];

  it.each(benign)('%s:口令段脱敏,后文原样保留', (_n, input, keep) => {
    const out = applyText(input);
    expect(out).toContain(PH);
    expect(out.includes(SEG2)).toBe(false);
    for (const k of keep) expect(out, `应保留 ${k}`).toContain(k);
  });

  it('源码里字符串字面量的收尾引号(段含空白 / 标点)不当拼接', () => {
    // 回归:曾把 `'", R('` 当成长段、把后面的值字符吞进去
    const input = `["${PW} = '", R('${V}', 'cred')]`;
    // 该形态本来就不脱敏(源码里的字符串字面量),这里只钉「没有被新规则吞掉」
    expect(applyText(input)).toBe(input);
  });

  it('shell 里 KEY="..." 后紧贴的 "$f" 引号段(段含空白)不被整体吞掉', () => {
    const input = `grep "^FOO_${KEY}=" "$f" | cut -d= -f2-`;
    expect(r.pass1(input).text).toBe(input);
  });

  it('段含空白的长引号段(多个词)后紧贴值:不并成一个词', () => {
    const input = `${PW}="two words here"trailingword`;
    expect(applyText(input)).toContain('trailingword');
  });

  it('无键名的 shell 引号拼接不动(echo "x"y)', () => {
    const input = `echo "${SEG2}"suffixword`;
    expect(r.pass1(input).text).toBe(input);
    expect(applyText(input)).toBe(input);
  });

  it('非敏感键名的引号拼接不动', () => {
    const input = `NAME="${SEG2}"${V}`;
    expect(r.pass1(input).text).toBe(input);
  });

  it('幂等:第二遍对第一遍输出不再改动', () => {
    const input = `${PW}="${SEG2}"${V}`;
    const once = r.pass1(input).text;
    expect(r.pass1(once).text).toBe(once);
    expect(r.pass2(once).clean).toBe(true);
  });
});
