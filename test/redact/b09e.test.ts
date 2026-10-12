/**
 * B09e:真实 Claude 会话样本上两遍不一致的三类形状(合成复现)。口令运行时拼装。
 *  1. 转义换行的反斜杠被值区间吞掉(`[[..]]next`),上下两行粘连,第二遍把后一行当成值
 *  2. 占位符后面紧跟的闭合短括号实参(占位符后接 `(ab);` 再接转义换行)被第二遍当成口令
 *  3. 复扫:第一遍输出再被 JSON 转义一层后仍须干净
 * 反面:占位符旁边藏真值的形态必须仍被脱敏。
 */
import { describe, expect, it } from 'vitest';
import { newRedactor, placeholder } from './helpers.js';

const r = newRedactor();
const BS = '\\';
const PH = placeholder('credential');
const pw = ['Kx', '7mQ', '2vL', 'p9Zt'].join('');
const SECRET = ['SEC', 'RET'].join('');
const TK = ['to', 'ken'].join('');
const KEY2 = ['pass', 'word'].join('');
const AZ = ['Author', 'ization'].join('');
const TPL = '$' + '{';
/** 把文本当作 JSON 字符串内容再转义 n 层 */
const esc = (s: string, n: number): string => {
  let t = s;
  for (let i = 0; i < n; i++) t = JSON.stringify(t).slice(1, -1);
  return t;
};

function expectConsistent(text: string): string {
  const a = r.apply(text);
  expect(a.ok, `apply 失败: ${JSON.stringify(text.slice(0, 120))}`).toBe(true);
  if (!a.ok) return '';
  expect(a.text).not.toContain(pw);
  expect(r.pass2(a.text).clean).toBe(true);
  // 输出写进 JSON 文件后再被 --check 扫:多一层、两层转义都得干净
  for (const extra of [1, 2]) expect(r.pass2(esc(a.text, extra)).clean).toBe(true);
  const b = r.apply(a.text);
  expect(b.ok && b.text === a.text).toBe(true);
  return a.text;
}

describe('B09e 形状 1:占位符 + 闭合短括号实参', () => {
  for (const arg of ['ab', 'x1', 'id', '{}', '[]', '()', 'a.b', '']) {
    it(`${SECRET} 赋值为占位符 + (${arg}) 后跟转义换行:第二遍干净`, () => {
      const text = `import { a } from '../x/y.ts';${BS}nconst ${SECRET} = ${PH}(${arg});${BS}nconst z = 1;`;
      expect(r.pass2(text).clean).toBe(true);
      expectConsistent(text);
    });
  }
  it('同一行多个这样的赋值 + 前后带代码 + 双层转义换行', () => {
    const t = `const ${SECRET} = ${PH}(ab); const ${TK} = ${PH}(cd);${BS}${BS}nfoo()`;
    expect(r.pass2(t).clean).toBe(true);
  });
});

describe('B09e 形状 1 反面:占位符旁边的真值必须仍被脱敏', () => {
  const cases: Array<[string, string]> = [
    [
      '括号内 7 字符实参(头部 >= 8 个字符,按值判)',
      `const ${SECRET} = ${PH}(${pw.slice(0, 7)});${BS}nconst z = 1;`,
    ],
    ['括号内双引号长字面量', `const ${SECRET} = ${PH}("${pw}");${BS}nconst z = 1;`],
    ['括号内单引号长字面量', `const ${SECRET} = ${PH}('${pw}');${BS}nconst z = 1;`],
    ['括号内裸长值', `const ${SECRET} = ${PH}(${pw});${BS}nconst z = 1;`],
    ['短实参后接引号长字面量', `const ${SECRET} = ${PH}(ab, "${pw}");${BS}nconst z = 1;`],
    ['两段括号,第二段是长字面量', `const ${SECRET} = ${PH}(ab)("${pw}");${BS}nconst z = 1;`],
    ['占位符直接贴真值', `const ${SECRET} = ${PH}${pw};${BS}nconst z = 1;`],
    ['短括号后贴真值', `const ${SECRET} = ${PH}(ab)${pw};${BS}nconst z = 1;`],
    ['短括号分号后贴真值', `const ${SECRET} = ${PH}(ab);${pw}${BS}nconst z = 1;`],
    ['占位符贴短头部 + 转义换行 + 后半段(头部不是闭合括号实参)', `${KEY2}=${PH}Kx8q2${BS}n${pw}`],
    ['授权头里的默认值展开', `${AZ}: Bearer ${TPL}X:-${pw}}${BS}nnext`],
    ['占位符后贴 Bearer 真值', `${AZ}: Bearer ${PH}${pw}${BS}nnext`],
  ];
  for (const [name, text] of cases) {
    it(name, () => {
      const a = r.apply(text);
      expect(a.ok).toBe(true);
      if (a.ok) expect(a.text).not.toContain(pw);
    });
  }
});

describe('B09e 形状 2:授权头的值后面的转义换行不被吞', () => {
  const tok = ['Zk', '9fQ', 'x2L', 'm7Rt', 'b4Nw'].join('');
  it('注释里的 Bearer 值(收尾反引号)+ 下一行 Bearer ${secret}:\\n 原样保留、两遍一致', () => {
    const text = `}));${BS}n  // 无 token 会带 \`${AZ}: Bearer ${tok}\`${BS}n  if (req.headers.${AZ.toLowerCase()} !== \`Bearer ${TPL}secret}\`) {${BS}n    return`;
    const out = expectConsistent(text);
    expect(out).not.toContain(tok);
    expect(out).toContain(`${PH}${BS}n  if (req`); // 反斜杠没有被吞
    expect(out).toContain(`Bearer ${TPL}secret}`);
  });
  for (const layers of [0, 1, 2, 3]) {
    it(`${layers} 层转义:授权头的值不吞转义换行`, () => {
      const text = esc(`x\n${AZ}: Bearer ${tok}\nnext line\n`, layers);
      const out = expectConsistent(text);
      expect(out).not.toContain(tok);
    });
  }
});

describe('B09e 形状 3:shell 里 `NAME=` 引用式 + 路径 / 引号词 + 转义换行', () => {
  const name = ['MY', 'SERVICE', 'API', 'TOKEN', 'VALUE'].join('_');
  const words = ['/tmp/x/.env', '"$f"', '$ENVF', '.env.local', '$HOME/.config/a.env'];
  for (const w of words) {
    for (const layers of [1, 2]) {
      it(`grep '^${'NAME'}=' ${w}(${layers} 层)`, () => {
        const raw = `v=$(grep '^${name}='${w} | cut -d= -f2)\nnext line`;
        expectConsistent(esc(raw, layers));
        const spaced = `v=$(grep '^${name}=' ${w}; echo)\nnext line`;
        expectConsistent(esc(spaced, layers));
      });
    }
  }
  it('值尾是转义引号:不收缩(收缩会让 `Bearer 伪值\\"口令\\"` 一类写法的口令失去锚点而漏掉)', () => {
    // 无论 apply 成功还是 fail-closed,输出都不得含口令原文
    for (const q of ['"', "'"]) {
      const a = r.apply(`${AZ}: Bearer x${BS}${q}${pw}${BS}${q}`);
      if (a.ok) expect(a.text).not.toContain(pw);
    }
    const b = r.apply(`${AZ}: Basic = ${BS}"${pw}${BS}"`);
    if (b.ok) expect(b.text).not.toContain(pw);
  });
});

describe('B09e 收缩只针对转义序列', () => {
  it('值尾的反斜杠后面不是转义字符:不额外收缩(规则自己对尾部反斜杠的处理不变)', () => {
    const a = r.apply(`export ${TK.toUpperCase()}=${pw}${BS} and more`);
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.text).toBe(`export ${TK.toUpperCase()}=${PH}${BS} and more`);
  });
  it('值尾是转义换行:反斜杠留在区间外', () => {
    for (const e of ['n', 'r']) {
      const a = r.apply(`export ${TK.toUpperCase()}=${pw}${BS}${e}next`);
      expect(a.ok).toBe(true);
      if (a.ok) expect(a.text).toBe(`export ${TK.toUpperCase()}=${PH}${BS}${e}next`);
    }
  });
});

describe('B09e 收缩边界:只在紧随转义换行时收缩', () => {
  const tk = ['Zk', '9fQ', 'x2L', 'm7Rt', 'b4Nw'].join('');
  it('授权头的值以反斜杠结尾、后面是真换行(不是转义):反斜杠仍随值脱敏', () => {
    const a = r.apply(`${AZ}: Bearer ${tk}${BS}\nnext`);
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.text).toBe(`${AZ}: Bearer ${PH}\nnext`);
  });
});

describe('B09e 复扫:带转义引号的赋值 + 多层嵌套', () => {
  const key = ['pass', 'word'].join('');
  const bodies = [
    `p = (raw) => { const u = new URL(raw); u.${key} = "${pw}"; u.username = p; return u; }`,
    `u.${key} = "${pw}"; v.${key} = "${pw}2"; w.${key} = '${pw}3';`,
    `  u.${key} = "${pw}";\n  const a = { ${key}: "${pw}", user: "x" };`,
    `r.apply('u.${key} = "${pw}"');\n`,
    `expected: u.${key} = "${PH}";\n received: u.${key} = "${pw}";\n`,
    `{"${key}":"${pw}","n":1}`,
  ];
  for (const [i, b] of bodies.entries()) {
    for (const layers of [0, 1, 2, 3]) {
      it(`正文 ${i} / ${layers} 层:脱敏、复扫(+1/+2 层)干净、幂等`, () => {
        expectConsistent(esc(b, layers));
      });
    }
  }
});
