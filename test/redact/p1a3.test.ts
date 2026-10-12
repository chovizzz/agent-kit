/**
 * P1-A.3:脱敏 §7 残余缺口清理。所有口令运行时拼装,脚本里不写完整字面量。
 *  1. --stdin 与 collect 共用同一个「先拆占位符标记」预处理;中性化标记在引擎里与合法占位符同样处理
 *  2. 授权头的值前是转义引号 / 裸引号
 *  3. `NAME = 中性化标记("口令")`
 *  4. 裸字面量断言(保持 known_gap)
 *  5. 多行三引号 / YAML 块标量 / heredoc;默认值链;pass2 的 probe_cred
 * 每个修复都带反例(真值藏进新放行形态时必须仍被脱敏)与对照(不该动的形态原样)。
 */
import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { createRedactCommand } from '../../src/commands/redact-cmd.js';
import { buildRules } from '../../src/redact/rules.js';
import {
  KNOWN_PLACEHOLDER_TYPES,
  neutralizePlaceholderMarkers,
  PLACEHOLDER_NEUTRALIZED,
  PLACEHOLDER_OPEN,
} from '../../src/redact/placeholder.js';
import { RedactionConfigSchema } from '../../src/contracts/redact.js';
import { buildSeeds } from '../../src/redact/seeds.js';
import { makeExcerpt } from '../../src/signals/pipeline.js';
import type { Redactor } from '../../src/contracts/redact.js';
import { baseCtx } from '../helpers/tmp.js';
import { newRedactor, placeholder } from './helpers.js';

const nz = neutralizePlaceholderMarkers;

const r = newRedactor();
const BS = '\\';
const PH = placeholder('credential');
const NPH = '[[ REDACTED:credential]]';
const pw = ['Kx', '7mQ', '2vL', 'p9Zt'].join('');
const SECRET = ['SEC', 'RET'].join('');
const TK = ['to', 'ken'].join('');
const KEY = ['pass', 'word'].join('');
const AZ = ['Author', 'ization'].join('');
const TPL = '$' + '{';
const esc = (s: string, n: number): string => {
  let t = s;
  for (let i = 0; i < n; i++) t = JSON.stringify(t).slice(1, -1);
  return t;
};

async function cli(argv: string[], stdin: string) {
  let out = '';
  let err = '';
  const cmd = createRedactCommand({ readStdin: async () => stdin });
  const code = await cmd.run({
    argv: [...argv, '--timeout-ms', '5000'],
    io: baseCtx(),
    overlayPath: undefined,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  });
  return { code, out, err };
}

/** apply 成功则不含口令,第二遍(含再被 JSON 转义 1 / 2 层)干净,且幂等;返回输出 */
function consistent(text: string, layers: readonly number[] = [1, 2]): string {
  const a = r.apply(text);
  expect(a.ok, `apply 失败: ${JSON.stringify(text.slice(0, 100))}`).toBe(true);
  if (!a.ok) return '';
  expect(a.text).not.toContain(pw);
  expect(r.pass2(a.text).clean).toBe(true);
  for (const n of layers) expect(r.pass2(esc(a.text, n)).clean).toBe(true);
  const b = r.apply(a.text);
  expect(b.ok && b.text === a.text).toBe(true);
  return a.text;
}

describe('缺口 1:--stdin 与 collect 共用占位符标记预处理', () => {
  it('neutralizePlaceholderMarkers:只拆标记、幂等、结果里不再有合法标记', () => {
    const t = `a ${PH} b ${PH}${PH} [[REDACTED:x]] [[ REDACTED:y]]`;
    const n = neutralizePlaceholderMarkers(t);
    expect(n).not.toContain(PLACEHOLDER_OPEN);
    expect(n.split(PLACEHOLDER_NEUTRALIZED).length - 1).toBe(4 + 1);
    expect(neutralizePlaceholderMarkers(n)).toBe(n);
    expect(neutralizePlaceholderMarkers('no marker')).toBe('no marker');
  });

  it('不与 signals 的预处理漂移:makeExcerpt 传给 apply 的字符串 === 共享函数的输出', () => {
    const seen: string[] = [];
    const spy: Redactor = {
      pass1: (t) => ({ text: t, hits: [] }),
      pass2: () => ({ clean: true, hits: [] }),
      apply: (t) => {
        seen.push(t);
        return { ok: true, text: t };
      },
    };
    const inputs = [
      `${SECRET}=${PH}${pw}`,
      `x ${PH}(ab);${BS}n${pw}`,
      `${PH}${PH} [[REDACTED:a]] plain`,
      'no marker at all',
    ];
    for (const t of inputs) {
      makeExcerpt(spy, t, false);
      expect(seen.pop()).toBe(neutralizePlaceholderMarkers(t));
    }
  });

  it('性质:短输入上 makeExcerpt 的摘录 === apply(neutralize(x)) 的输出(与 --stdin 同视图)', () => {
    const inputs = [
      `${SECRET}=${PH}${pw}`,
      `${SECRET} = ${PH}("${pw}")`,
      `${KEY}=${PH}(ab);${BS}n${pw}`,
      `${AZ}: Bearer ${PH}${pw}`,
    ];
    for (const t of inputs) {
      const ex = makeExcerpt(r, t, false);
      const a = r.apply(neutralizePlaceholderMarkers(t));
      expect(ex.ok).toBe(a.ok);
      if (ex.ok && a.ok) expect(ex.excerpt).toBe(a.text);
    }
  });

  it('--stdin:输入里的占位符标记被拆开(输出是中性化标记),紧贴的口令照脱敏并连同标记一起被吞', async () => {
    const res = await cli(['--stdin'], `${SECRET}=${PH}${pw}\n`);
    expect(res.code).toBe(ExitCode.OK);
    expect(res.out).toBe(`${SECRET}=${PH}\n`);
    const alone = await cli(['--stdin'], `x ${PH} y\n`);
    expect(alone.out).toBe(`x ${NPH} y\n`);
  });

  it('--check 不拆标记(复扫 collect 的输出,里面的合法占位符按占位符看):干净输出退出 0,占位符旁边的真值退出 1', async () => {
    const clean = await cli(['--stdin', '--check'], `${SECRET}=${PH}\nnext line\n`);
    expect(clean.code).toBe(ExitCode.OK);
    const dirty = await cli(['--stdin', '--check'], `${SECRET}=${PH}${pw}\n`);
    expect(dirty.code).toBe(ExitCode.CHECK_FAILED);
    expect(dirty.err).not.toContain(pw);
  });

  it('差分:合法占位符形态与中性化形态在 128 种拼接形状上结论一致(--stdin 与 collect 同视图),且口令紧贴时不漏', () => {
    const pre = [
      `${SECRET}=`,
      `${SECRET} = `,
      `${SECRET}: `,
      `const ${SECRET} = `,
      `"${SECRET}": `,
    ];
    const mid = ['(ab)', '(ab);', '()', ''];
    const con = ['', `${BS}t`, ' '];
    const post = [pw, `"${pw}"`];
    const leak = (t: string): boolean => {
      const a = r.apply(neutralizePlaceholderMarkers(t));
      return a.ok && a.text.includes(pw);
    };
    const leakRaw = (t: string): boolean => {
      const a = r.apply(t);
      return a.ok && a.text.includes(pw);
    };
    let n = 0;
    for (const a of pre)
      for (const m of mid)
        for (const c of con)
          for (const p of post) {
            const withPh = `${a}${PH}${m}${c}${p}`;
            const withNph = `${a}${NPH}${m}${c}${p}`;
            // 拆开后的 stdin 视图 === collect 视图(都对中性化文本 apply)
            expect(leak(withPh), JSON.stringify(withPh)).toBe(leakRaw(withNph));
            n++;
          }
    expect(n).toBe(5 * 4 * 3 * 2);
    // 紧贴 / 紧贴引号的口令必须不漏(无分隔的两类;带分隔的 `(ab) "口令"` 是无键名的独立字面量,见 §3.4)
    for (const a of pre) {
      expect(leak(`${a}${PH}${pw}`), a).toBe(false);
      expect(leak(`${a}${PH}"${pw}"`), a).toBe(false);
      expect(leakRaw(`${a}${NPH}${pw}`), a).toBe(false);
      expect(leakRaw(`${a}${NPH}"${pw}"`), a).toBe(false);
    }
  });

  it('原缺口形状:占位符 + 短括号实参 + 转义换行 + 后半段——--stdin 拆开标记后整值脱敏(后半段不再漏);真占位符的尾巴按设计放行', async () => {
    const t = `const ${SECRET} = ${PH}(ab);${BS}n${pw}`;
    const via = await cli(['--stdin'], t);
    expect(via.code).toBe(ExitCode.OK);
    expect(via.out).not.toContain(pw);
    // 与 collect 同视图
    const viaCollect = r.apply(t.replaceAll(PLACEHOLDER_OPEN, PLACEHOLDER_NEUTRALIZED));
    expect(viaCollect.ok && viaCollect.text).toBe(via.out);
    // 真占位符(pass1 自己的输出形态)后面的短括号尾巴仍是「值为空」:第二遍不把它当口令
    const own = r.apply(t);
    expect(own.ok && own.text.includes(pw)).toBe(true);
  });
});

describe('中性化标记在引擎里:与合法占位符同样处理,但只认封闭类型 + 原文逐字节如此', () => {
  it('KNOWN_PLACEHOLDER_TYPES 与规则表里实际产出的类型一致(新增规则类型时这里会红)', () => {
    const cfg = {
      ...RedactionConfigSchema.parse({
        sensitive_words: ['abc'],
        extra_secret_prefixes: ['zz_'],
        allowed_url_hosts: [],
      }),
      internal_domains: ['x.example'],
    };
    const types = [...new Set(buildRules(cfg).map((x) => x.type))].sort();
    expect(types).toEqual([...KNOWN_PLACEHOLDER_TYPES].sort());
  });

  it('全角括号 / 同形字写成的「占位符」归一化后才像标记:不剥、不放行,类型位里的数据脱敏', () => {
    const full = `${KEY}=［［REDACTED：aqzxwvutsrqponm］］`;
    const a = r.apply(full);
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.text).not.toContain('aqzxwvutsrqponm');
    // 西里尔字母 А(U+0410)冒充 A
    const cyr = `${KEY}=[[REDАCTED:aqzxwvutsrqponm]]`;
    const b = r.apply(cyr);
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.text).not.toContain('aqzxwvutsrqponm');
    // \u 转义写成的标记同理
    const uni = `${KEY}=${BS}u005b${BS}u005bREDACTED:aqzxwvutsrqponm]]`;
    const c = r.apply(uni);
    if (c.ok) expect(c.text).not.toContain('aqzxwvutsrqponm');
  });

  it('对照:合法占位符与封闭类型的中性化标记单独出现时原样放行', () => {
    for (const t of [`${SECRET}=${PH}\nnext\n`, `${SECRET}=${NPH}\nnext\n`]) {
      const a = r.apply(t);
      expect(a).toEqual({ ok: true, text: t });
      expect(r.pass2(t).clean).toBe(true);
    }
  });

  it('中性化标记把一个秘密从中间切开:剥掉后拼回照样命中', () => {
    const sk = 'sk-' + 'a1'.repeat(22);
    const t = `${sk.slice(0, 12)}${NPH}${sk.slice(12)}`;
    expect(r.pass2(t).clean).toBe(false);
  });
});

describe('缺口 2:授权头里 Bearer 后直接跟引号', () => {
  const cases: Array<[string, string]> = [
    ['转义双引号', `${AZ}: Bearer ${BS}"${pw}${BS}"`],
    ['转义单引号', `${AZ}: Bearer ${BS}'${pw}${BS}'`],
    ['两层转义', `${AZ}: Bearer ${BS}${BS}"${pw}${BS}${BS}"`],
    ['裸双引号', `${AZ}: Bearer "${pw}"`],
    ['裸单引号', `${AZ}: Bearer '${pw}'`],
    ['无 scheme 的转义引号', `${AZ}: ${BS}"${pw}${BS}"`],
    [
      'curl -H 整串转义',
      `curl -H ${BS}"${AZ}: Bearer ${BS}${BS}${BS}"${pw}${BS}${BS}${BS}"${BS}" x`,
    ],
  ];
  for (const [name, text] of cases) {
    for (const layers of [0, 1]) {
      it(`${name} / ${layers} 层:脱敏、两遍一致、幂等`, () => {
        const out = consistent(esc(text, layers));
        expect(out).toContain(PH);
      });
    }
  }
  it('收尾的转义引号保持完整(反斜杠留在区间外),JSON 不被破坏', () => {
    const a = r.apply(`${AZ}: Bearer ${BS}"${pw}${BS}"`);
    expect(a.ok && a.text).toBe(`${AZ}: Bearer ${BS}"${PH}${BS}"`);
  });
  it('没有 Authorization 关键字的 `Bearer \\"口令\\"` 也脱敏', () => {
    const tok = pw + 'abcde';
    const a = r.apply(`curl -H x Bearer ${BS}"${tok}${BS}"`);
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.text).not.toContain(tok);
  });
  it('对照:引用形态与过短的值原样', () => {
    for (const t of [
      `${AZ}: Bearer ${BS}"$TOKEN${BS}"`,
      `${AZ}: Bearer ${BS}"${TPL}TOKEN}${BS}"`,
      `${AZ}: Bearer "$TOKEN"`,
      `${AZ}: Bearer ${BS}"short${BS}"`,
    ]) {
      expect(r.apply(t), t).toEqual({ ok: true, text: t });
    }
  });
  it('B09e 的边界不变:`Bearer 伪值\\"口令\\"` 要么 fail-closed,要么不含口令', () => {
    for (const q of ['"', "'"]) {
      const a = r.apply(`${AZ}: Bearer x${BS}${q}${pw}${BS}${q}`);
      if (a.ok) expect(a.text).not.toContain(pw);
    }
  });
  it("源码里 `Bearer '` 后面跟代码(不是值)不误脱敏:引号后必须紧跟字母数字才算开引号", () => {
    const t = `h('${AZ}: Bearer ', R(rep(x, 20)))`;
    expect(r.apply(t)).toEqual({ ok: true, text: t });
  });
});

describe('缺口 3:NAME = 中性化标记("口令")', () => {
  for (const [name, text] of [
    ['双引号字面量', `${SECRET} = ${NPH}("${pw}")`],
    ['单引号字面量', `${SECRET} = ${NPH}('${pw}')`],
    ['短实参后接字面量', `${SECRET} = ${NPH}(ab, "${pw}")`],
    ['两段括号', `${SECRET} = ${NPH}(ab)("${pw}")`],
    ['紧贴口令', `${SECRET}=${NPH}${pw}`],
    ['括号内裸长值', `${SECRET} = ${NPH}(${pw});`],
  ] as const) {
    it(name, () => {
      // 两段括号的 2 层转义复扫在合法占位符下也会报残留(旧行为,已登记在 §3.4),这里只验 1 层
      const out = consistent(text, name === '两段括号' ? [1] : [1, 2]);
      // 值紧贴标记时标记随值一起被吞;否则标记原样保留
      if (name !== '紧贴口令' && name !== '括号内裸长值') expect(out).toContain(NPH);
    });
  }
  it('合法占位符版本结论相同', () => {
    for (const t of [`${SECRET} = ${PH}("${pw}")`, `${SECRET} = ${PH}(ab, "${pw}")`]) consistent(t);
  });
});

describe('缺口 4:裸字面量断言保持 known_gap', () => {
  it('键名只在被断言的表达式里、口令是另一个调用的裸字面量:不脱敏(如实记为已知缺口)', () => {
    const t = `expect(u.${KEY}).toBe("${pw}")`;
    const a = r.apply(t);
    expect(a.ok && a.text.includes(pw)).toBe(true);
    expect(buildSeeds().some((s) => s.id === 'gap.bare_literal_assert')).toBe(true);
  });
  it('同一形态一旦有「键名 + 运算符」的赋值结构就照常脱敏(缺口只限无赋值结构的断言)', () => {
    for (const t of [`u.${KEY} = "${pw}"`, `expect({ ${KEY}: "${pw}" })`, `${KEY}="${pw}"`]) {
      const a = r.apply(t);
      expect(a.ok && a.text.includes(pw), t).toBe(false);
    }
  });
});

describe('缺口 5a:多行值(三引号 / YAML 块标量 / heredoc)', () => {
  const tpl = TPL;
  it('多行三引号:正文逐行脱敏', () => {
    const out = consistent(`${KEY} = """\n${pw}\n"""\nprint(1)\n`);
    expect(out).toContain(`"""\n${PH}\n"""`);
  });
  it('多行三引号 / 单引号三引号 / 首行有内容', () => {
    consistent(`${KEY} = '''\n${pw}\nmore text here\n'''`);
    consistent(`${KEY} = '''${pw}\nsecond'''`); // 开引号同一行有内容:只判本行
  });
  it('没有收尾的三引号(摘录被截断):已看到的行照脱敏', () => {
    consistent(`${KEY} = """\n${pw}\n`);
  });
  it('YAML 块标量:缩进更深的行是值;缩进回退即结束', () => {
    const out = consistent(`app:\n  ${KEY}: |\n    ${pw}\n  other: 1\n`);
    expect(out).toContain('  other: 1');
    for (const head of ['|', '|-', '>', '>-', '|+', '|2'])
      consistent(`${KEY}: ${head}\n  ${pw}\nnext: x\n`);
    consistent(esc(`app:\n  ${KEY}: |\n    ${pw}\n`, 1));
  });
  it('YAML 块标量:多行都脱敏;块外的行不动', () => {
    const second = ['Zk', '9fQ', 'x2L', 'm7Rt'].join('');
    const a = r.apply(`${KEY}: |\n  ${pw}\n  ${second}\nnext_key: some value text\n`);
    expect(a.ok).toBe(true);
    if (a.ok) {
      expect(a.text).not.toContain(second);
      expect(a.text).toContain('next_key: some value text');
    }
  });
  it('heredoc:从头行到终止符的正文脱敏;终止符不动', () => {
    const out = consistent(`export ${TK.toUpperCase()}=$(cat <<'EOF'\n${pw}\nEOF\n)`);
    expect(out).toContain(`\n${PH}\nEOF\n)`);
    consistent(`${TK.toUpperCase()}=$(cat <<-EOF\n\t${pw}\n\tEOF\n)`);
    consistent(`export ${TK.toUpperCase()}=$(cat <<"EOT"\n${pw}\nEOT\n)`);
    consistent(`${TK.toUpperCase()}=$(cat <<EOF\n${pw}\n`); // 未终止:到文本末尾
  });
  it('heredoc 里的 `键: 值` 一直由普通赋值规则覆盖', () => {
    consistent(`cat <<EOF\n${KEY}: ${pw}\nEOF`);
  });
  it('对照:键名不含关键词的块、没有正文的块、引用行都原样', () => {
    for (const t of [
      'description: |\n  some longer text here\n',
      `${KEY}: |\nnext_key: value\n`,
      `${KEY} = """\n${tpl}ENV_VALUE}\n"""\n`,
      `${KEY} = """\n"""\n`,
      `${KEY}: |\n  short\nnext: 1\n`,
    ]) {
      expect(r.apply(t), t).toEqual({ ok: true, text: t });
    }
  });
  it('块头 `|` 不当口令:JSON 转义形态的复扫也干净(原视图补扫不再把 `|` 整值脱敏)', () => {
    const t = `${KEY}: |\nnext_key: value\n`;
    expect(r.pass2(esc(t, 1)).clean).toBe(true);
  });
  it('上限:正文超过 40 行,要么 fail-closed(第二遍在剩余行上命中),要么不含口令;不会静默放过', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `${pw}${i}`);
    const a = r.apply(`${KEY}: |\n${lines.map((l) => `  ${l}`).join('\n')}\n`);
    if (a.ok) for (const l of lines) expect(a.text).not.toContain(l);
    else expect(a.reason).toBe('residual');
  });
});

describe('缺口 5b:模板默认值链', () => {
  const T = TPL;
  it('`${X:-$(echo 口令)}` 与嵌套展开、各种运算符', () => {
    for (const op of [':-', '-', ':=', '=', ':+', '+']) {
      const out = consistent(`${KEY}=${T}X${op}$(echo ${pw})}`);
      expect(out).toContain(')}');
    }
    consistent(`export ${TK.toUpperCase()}=${T}X:-$(printf %s ${pw})}`);
    consistent(`${KEY}: ${T}X:-$(echo ${pw})}`);
    consistent(esc(`${KEY}=${T}X:-$(echo ${pw})}`, 1));
  });
  it('简单默认值(原有覆盖)与引号默认值不回退', () => {
    consistent(`${KEY}=${T}X:-${pw}}`);
    consistent(`${KEY}=${T}X:-"${pw}"}`);
    consistent(`${KEY}=${T}X:=${pw}}`);
  });
  it('对照:默认值链里只有短词 / 引用词时,脱敏不超出这几个词', () => {
    const a = r.apply(`${KEY}=${T}X:-$(echo ${T}Y})}`);
    expect(a.ok).toBe(true);
  });
});

describe('缺口 5c:pass2 的 cred 残留探测器(probe_cred)', () => {
  const noCred = (): ReturnType<typeof newRedactor> =>
    newRedactor({}, { disabledRules: ['cred_assign', 'cred_assign_ext', 'cred_cli_flag'] });
  const mixed = ['Zk9', 'fQx', '2Lm', '7Rt', 'b4N', 'wQ8', 'vYc'].join('');
  it('禁用全部 cred_* 赋值规则后,引号包裹的混合大小写 + 数字长值仍被 apply 拦下(residual)', () => {
    const rr = noCred();
    for (const t of [
      `${KEY} = "${mixed}"`,
      `${KEY}: '${mixed}'`,
      `{"${TK}":"${mixed}"}`,
      `${SECRET}='${mixed}'`,
    ]) {
      const a = rr.apply(t);
      expect(a, t).toEqual({ ok: false, reason: 'residual' });
      expect(rr.pass2Detail(t).hits.some((h) => h.rule === 'probe_cred')).toBe(true);
    }
  });
  it('对照(误杀面):引用 / 低熵 / 单一字符类 / 带符号 / 过短的值不命中', () => {
    const rr = noCred();
    for (const v of [
      'a1'.repeat(12), // 低熵
      mixed.toLowerCase(), // 无大写
      mixed.toUpperCase(), // 无小写
      mixed.replace(/[0-9]/g, 'k'), // 无数字
      `${mixed}_x`, // 带符号
      mixed.slice(0, 15), // 过短
    ]) {
      expect(rr.pass2(`${KEY} = "${v}"`).clean, v).toBe(true);
    }
    expect(rr.pass2(`${KEY} = ${mixed}`).clean).toBe(true); // 无引号不探
  });
  it('性质:种子集里 probe_cred 的命中都被 pass1 的命中覆盖(探测器不比规则更宽);pass1 输出上零命中', () => {
    for (const s of buildSeeds()) {
      const hits = r.pass2Detail(s.input).hits.filter((h) => h.rule === 'probe_cred');
      if (hits.length === 0) continue;
      const p1 = r.pass1(s.input).hits;
      for (const h of hits)
        expect(
          p1.some((x) => x.start <= h.start && x.end >= h.end),
          s.id,
        ).toBe(true);
      expect(
        r.pass2Detail(r.pass1(s.input).text).hits.filter((h) => h.rule === 'probe_cred'),
      ).toEqual([]);
    }
  });
  it('正常规则开启时 probe_cred 不改变任何已有结论(apply 成功的不变)', () => {
    const a = r.apply(`${KEY} = "${mixed}"`);
    expect(a).toEqual({ ok: true, text: `${KEY} = "${PH}"` });
  });
});

describe('相邻的已知缺口如实保留', () => {
  it('`call(ab)"口令"`(无赋值意义的函数调用后贴引号字面量):不脱敏,与是否有占位符无关', () => {
    for (const t of [`${SECRET}=foo(ab)"${pw}"`, `${SECRET}=${PH}(ab)"${pw}"`]) {
      const a = r.apply(t);
      expect(a.ok && a.text.includes(pw), t).toBe(true);
    }
    expect(buildSeeds().some((s) => s.id === 'gap.call_then_quoted')).toBe(true);
  });
});

describe('opus 对抗评审后补的回归', () => {
  const tk = pw + 'Wq4';
  it('伪造的中性化标记不占位:标记后面隔着空白 / 制表 / 引号拼接的口令照样脱敏(collect 视图)', () => {
    for (const t of [
      `${KEY}="${NPH} ${tk}"`,
      `${KEY}='${NPH}\t${tk}'`,
      `${KEY} = "[[ REDACTED:token]]""${tk}"`,
      `${KEY}=${NPH} ${tk}`,
      `${KEY}=${NPH}${tk}`,
    ]) {
      const a = r.apply(nz(t));
      expect(a.ok, t).toBe(true);
      if (a.ok) expect(a.text, t).not.toContain(tk);
    }
  });
  it('真占位符的既有语义不变:值的位置被占住时,后面的词不是这个值(第二遍复扫第一遍的输出)', () => {
    const t = `${KEY}=${PH} next words here`;
    expect(r.apply(t)).toEqual({ ok: true, text: t });
  });
  it('值紧贴中性化标记时标记随值一起被吞:输出里没有拆开的标记残片', () => {
    const a = r.apply(`${KEY}=${NPH}${tk}`);
    expect(a.ok && a.text).toBe(`${KEY}=${PH}`);
  });
  it('摘录在标记附近被截断(collect 的 300 码点):扫过所有截断点都不丢信号、不泄漏', () => {
    let drops = 0;
    for (let n = 120; n <= 320; n++) {
      for (const mid of ['', ' ']) {
        const t = 'w '.repeat(Math.floor(n / 2)) + `${KEY}="${PH}${mid}${tk}`;
        const e = makeExcerpt(r, t, false);
        if (!e.ok) drops++;
        else expect(e.excerpt).not.toContain(tk);
      }
    }
    expect(drops).toBe(0);
  });
  it('块头带注释、管道形式的 heredoc、非 $ 起头的默认值链、授权头开引号后是 token 字符', () => {
    consistent(`${KEY}: |  # note\n  ${tk}\n`);
    consistent(`${TK.toUpperCase()}=$(cat <<EOF | tr a b\n${tk}\nEOF\n)`);
    consistent(`${KEY}=a${TPL}X:-$(echo ${tk})}`);
    for (const lead of ['+', '_', '/', '.']) consistent(`${AZ}: Basic "${lead}${tk}"`);
  });
  it('对抗输入线性:大量重复的 heredoc 头 / 递增缩进的 YAML 块头 / 未收尾三引号在宽预算下正常完成', () => {
    const hd = `${['TOK', 'EN'].join('')}=<${'<'}EOF\n`;
    const triple = `${KEY} = ${'"'.repeat(3)}\n`;
    const chain = `${KEY}=${TPL}X:-$(echo a)} `;
    const inputs = [
      hd.repeat(5000),
      Array.from({ length: 3000 }, (_, i) => `${' '.repeat(i % 40)}${KEY}:${' '}${'|'}`).join('\n'),
      triple.repeat(4000),
      chain.repeat(3000),
    ];
    for (const t of inputs) {
      const out = r.pass1(t.slice(0, 65000));
      expect(out.text.length).toBeGreaterThan(0);
    }
  });
  it('已知缺口如实保留:类型位不在封闭集合的中性化标记(纯小写字母数据)', () => {
    const a = r.apply(`${KEY}=[[ REDACTED:aqzxwvutsrqponm]]`);
    expect(a.ok && a.text.includes('aqzxwvutsrqponm')).toBe(true);
    expect(buildSeeds().some((x) => x.id === 'gap.neutral_open_type')).toBe(true);
  });
});
