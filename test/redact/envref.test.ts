/**
 * B09b:`cred_assign` 对「按名字读取环境变量」的误判(引用 vs 真值)、幂等、两遍一致、召回不倒退。
 * 所有样本合成;假密钥由片段在运行时拼装。
 */
import { describe, expect, it } from 'vitest';
import { cutExcerpt, makeExcerpt } from '../../src/signals/pipeline.js';
import { chunkForCheck } from '../../src/redact/chunk.js';
import { buildSeeds, SELFTEST_CONFIG, SELFTEST_INTERNAL_DOMAINS } from '../../src/redact/seeds.js';
import { createRedactor } from '../../src/redact/redactor.js';
import { ALNUM, newRedactor, placeholder, prng, randomString, rep } from './helpers.js';

const B = '\\';
const winPath = ['C:', 'Users', 'dev', '.env'].join(B);
/** 头名由片段拼成:本文件自己要过 A10 的零命中扫描 */
const authz = (v: string): string => ['-H "Author', 'ization: Bearer ', v, '"'].join('');
const glued = (v: string): string => ["'FOO_SERVICE_TOKEN='", '"', v, '"'].join('');
const r = newRedactor();

/** 引用形态:只按名字读取变量,里面没有任何密钥值。 */
function referenceSamples(): Array<[string, string]> {
  const q = '"';
  const s: Array<[string, string]> = [
    ['subst', `T=$(grep '^FOO_SERVICE_TOKEN=' "$ENVFILE" | cut -d= -f2- | tr -d '"')`],
    ['pipe', `grep '^FOO_DASHBOARD_SECRET=' "$f" | tail -1 | cut -d= -f2-`],
    ['dq_name', `grep "^FOO_API_TOKEN=" "$f" | cut -d= -f2-`],
    ['unquoted_file', `grep '^FOO_SERVICE_TOKEN=' $ENVFILE | cut -d= -f2-`],
    ['brace_var', `grep '^FOO_SERVICE_TOKEN=' "\${ENV_DIR}/prod.env" | head -1`],
    ['posix_path', `grep '^FOO_SERVICE_TOKEN=' "/home/dev/.config/foo/prod.env" | cut -d= -f2-`],
    ['posix_path_plain', `grep '^FOO_SERVICE_TOKEN=' /etc/foo/service.d/prod.env`],
    ['windows_path', `grep '^FOO_SERVICE_TOKEN=' "${winPath}" | cut -d= -f2-`],
    ['redirect', `grep '^FOO_SERVICE_TOKEN=' < "$f" > /dev/null`],
    ['semicolon', `grep '^FOO_SERVICE_TOKEN=' "$f"; echo done`],
    ['eol', `x=$(grep '^FOO_SERVICE_TOKEN='`],
    [
      'multiline',
      `set -e\nT=$(grep '^FOO_SERVICE_TOKEN=' "$ENVFILE" | cut -d= -f2-)\nS=$(grep '^FOO_DASHBOARD_SECRET=' "$ENVFILE" | cut -d= -f2-)\necho ok`,
    ],
    ['two_names', `grep -E '^(FOO_SERVICE_TOKEN|FOO_DASHBOARD_SECRET)=' "$ENVFILE" | wc -l`],
    ['empty_value', `export FOO_SERVICE_TOKEN=\nunset FOO_DASHBOARD_SECRET=`],
    [
      'placeholder_value',
      `FOO_SERVICE_TOKEN=${placeholder('credential')}\nFOO_DASHBOARD_SECRET=${placeholder('credential')}`,
    ],
  ];
  const out: Array<[string, string]> = [];
  for (const [k, v] of s) {
    out.push([k, v]);
    // 信号文件里的形态:整段作为 JSON 字符串(引号、反斜杠被转义)
    out.push([`${k}.json`, JSON.stringify(v)]);
    out.push([`${k}.json_inner`, JSON.stringify(v).slice(1, -1)]);
    out.push([`${k}.json_obj`, JSON.stringify({ cmd: v, n: q })]);
  }
  // 任务给出的转义形态原样
  out.push([
    'task_escaped',
    `${B}"grep '^FOO_SERVICE_TOKEN=' $ENVFILE | cut -d= -f2- | tr -d ${B}${B}'${B}${B}${B}"${B}${B}'${B}"`,
  ]);
  return out;
}

describe('B09b:引用形态不是凭据赋值', () => {
  for (const [k, text] of referenceSamples()) {
    it(`原样放行、无残留、与 --check 同结论:${k}`, () => {
      const p1 = r.pass1(text);
      expect(p1.hits, '第一遍不得命中').toEqual([]);
      expect(p1.text).toBe(text);
      const a = r.apply(text);
      expect(a.ok && a.text === text).toBe(true);
      expect(r.pass2(text).clean).toBe(true);
    });
  }
});

describe('B09b:collect 的摘录流水线(makeExcerpt)与信号文件复扫一致', () => {
  for (const [k, text] of referenceSamples()) {
    it(`摘录不丢、不改写,写成 JSON 后 --check 同样干净:${k}`, () => {
      const res = makeExcerpt(r, text, false);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      // 原文里形如占位符的串会被 makeExcerpt 先拆开(不给伪造占位符开后门),所以这一类样本不要求逐字相等
      if (!k.startsWith('placeholder_value')) expect(res.excerpt).toBe(text);
      // 信号文件里是 JSON 序列化后的形态;外部 --check 复扫这份文本
      const file = JSON.stringify({ excerpt_redacted: res.excerpt });
      expect(r.pass2(file).clean).toBe(true);
    });
  }
});

describe('B09b:真值赋值仍被拦(召回不倒退)', () => {
  const val = (n: number, seed: number): string => randomString(prng(seed), ALNUM, n);
  const cases: Array<[string, (v: string) => string]> = [
    ['env_line', (v) => `FOO_SERVICE_TOKEN=${v}\n`],
    ['export', (v) => `export FOO_SERVICE_TOKEN=${v}`],
    ['dq', (v) => `FOO_SERVICE_TOKEN="${v}"`],
    ['sq', (v) => `FOO_DASHBOARD_SECRET='${v}'`],
    ['json', (v) => `{"foo_api_token": "${v}"}`],
    ['json_escaped', (v) => JSON.stringify(`FOO_SERVICE_TOKEN="${v}" && run`)],
    ['yaml', (v) => `foo:\n  client_secret: ${v}\n`],
    ['cli_flag_eq', (v) => `curl --token=${v} https://x.invalid/`],
    ['cli_flag_space', (v) => `tool --password ${v}`],
    ['bearer_header', (v) => `curl ${authz(v)} https://x.invalid/`],
    ['grep_value', (v) => `grep '^FOO_SERVICE_TOKEN=${v}' "$f"`],
    ['concat_py', (v) => `cfg = "token=" + "${v}"`],
    ['inline_after_ref', (v) => `grep '^FOO_SERVICE_TOKEN=' "$f"; export FOO_SERVICE_TOKEN=${v}`],
    [
      'ref_then_value_same_quote',
      (v) =>
        `T=$(grep '^FOO_SERVICE_TOKEN=' "$f" | cut -d= -f2- | tr -d 'x'); export FOO_DASHBOARD_SECRET=${v}`,
    ],
    [
      'value_after_ref_word_boundary',
      (v) => `grep '^FOO_SERVICE_TOKEN=' "$f" && FOO_DASHBOARD_SECRET="${v}"`,
    ],
    ['adjacent_ref_value', glued],
    ['weak_ctx_literal_concat', (v) => `x = "token=" "${v}"`],
    ['weak_ctx_single_literals', (v) => `x = 'password=' '${v}'`],
  ];
  for (const [k, f] of cases) {
    for (const n of [24, 40]) {
      it(`${k}/${n}`, () => {
        const v = val(n, n * 7 + k.length);
        const text = f(v);
        const p1 = r.pass1(text);
        expect(p1.hits.length, '必须命中').toBeGreaterThan(0);
        expect(p1.text.includes(v), '真值不得残留').toBe(false);
        const a = r.apply(text);
        expect(a.ok).toBe(true);
        if (a.ok) expect(a.text.includes(v)).toBe(false);
      });
    }
  }

  it('引号奇偶:`NAME` 前的引号若是上一个词的收尾引号,就不是引用式(路径形状的值也要脱敏)', () => {
    const text = ["echo 'a'", 'FOO_PASS', "WORD=' /etc/foo/bar.env'"].join('');
    const p1 = r.pass1(text);
    expect(p1.hits.length).toBeGreaterThan(0);
    expect(p1.text.includes('bar.env')).toBe(false);
  });

  it('引用后面同一行的低熵真值:放行引用不能吞掉后面的赋值', () => {
    const v = rep('Ab1', 12);
    const ref = ["grep '^", 'FOO_SERVICE_', 'TOKEN', '=\' "$f"; '].join('');
    const text = [ref, 'export FOO_DASHBOARD_', 'SECRET', '=', v].join('');
    const p1 = r.pass1(text);
    expect(p1.text.includes(v)).toBe(false);
    expect(p1.text.startsWith(`${ref}export`)).toBe(true);
  });

  it('引用式的下一个词不是引用形状时只脱敏那个词(低熵、带引号)', () => {
    const v = rep('Ab1', 12);
    const text = ["cfg = '^", 'FOO_PASS', "WORD=' '", v, "'"].join('');
    expect(r.pass1(text).text).toBe(
      ["cfg = '^", 'FOO_PASS', "WORD=' '", placeholder('credential'), "'"].join(''),
    );
  });

  it('键名自己的引号(键名与等号之间有引号)不当引用式:整个引号值都要脱敏,不止第一个词', () => {
    const text = ['"', 'FOO_API_', 'TOKEN', '"=" ', rep('Ab1', 6), ' extra tail words"'].join('');
    const p1 = r.pass1(text);
    expect(p1.text.includes('extra')).toBe(false);
    expect(p1.text.includes('Ab1')).toBe(false);
  });

  it('JSON 转义的引号截断 Authorization 值后剩下的孤立反斜杠不算值', () => {
    const hdr = ['Author', 'ization: Bearer '].join('');
    const file = JSON.stringify(`curl -H "${hdr}${placeholder('credential')}" https://x.invalid/`);
    expect(r.pass2(file).clean).toBe(true);
  });

  it('同一行里先有引用后有真值:真值仍被拦,引用部分原样保留', () => {
    const v = val(32, 99);
    const ref = `grep '^FOO_SERVICE_TOKEN=' "$ENVFILE"`;
    const text = `${ref} && export FOO_DASHBOARD_SECRET=${v}`;
    const a = r.apply(text);
    expect(a.ok).toBe(true);
    if (a.ok) {
      expect(a.text.startsWith(ref)).toBe(true);
      expect(a.text.includes(v)).toBe(false);
    }
  });
});

describe('B09b:幂等与两遍一致', () => {
  const seeds = buildSeeds();
  const red = createRedactor(SELFTEST_CONFIG, { internalDomains: SELFTEST_INTERNAL_DOMAINS });

  /** 合成「引用」「真值」「普通文本」「种子」的混合文本。 */
  function mixed(rand: () => number, sepOverride?: string[]): string {
    const refs = referenceSamples().map(([, t]) => t);
    const vals = [
      (v: string) => `export FOO_SERVICE_TOKEN=${v}`,
      (v: string) => `FOO_DASHBOARD_SECRET="${v}"`,
      (v: string) => JSON.stringify(`password: ${v}`),
      (v: string) => `--token=${v}`,
    ];
    const noise = ['ok', 'echo hi', "'", '"', '\\', '[[REDACTED:credential]]', '||', ' ', '$HOME'];
    const parts: string[] = [];
    const n = 2 + Math.floor(rand() * 6);
    for (let i = 0; i < n; i++) {
      const c = rand();
      if (c < 0.35) parts.push(refs[Math.floor(rand() * refs.length)] as string);
      else if (c < 0.55) {
        const f = vals[Math.floor(rand() * vals.length)] as (v: string) => string;
        parts.push(f(randomString(rand, ALNUM, 24 + Math.floor(rand() * 20))));
      } else if (c < 0.8) {
        const sd = seeds[Math.floor(rand() * seeds.length)];
        // 已知缺口种子按定义抓不到,不参与「apply 输出必须干净」的性质
        if (sd && sd.tier !== 'pass2_only' && sd.tier !== 'known_gap') parts.push(sd.input);
      } else parts.push(noise[Math.floor(rand() * noise.length)] as string);
    }
    // 事件之间一律换行分隔(与真实会话一致);相邻拼接会制造出现实里不存在的新语法
    if (sepOverride)
      return parts.join(sepOverride[Math.floor(rand() * sepOverride.length)] as string);
    return parts.join('\n');
  }

  it('apply 幂等:apply(apply(x)) == apply(x),且输出过 check', () => {
    const rand = prng(0xb09b);
    let okCount = 0;
    for (let i = 0; i < 400; i++) {
      const x = mixed(rand);
      const a = red.apply(x);
      if (!a.ok) continue; // fail-closed 丢弃的不在幂等范围内
      okCount++;
      const b = red.apply(a.text);
      expect(b.ok, `#${i} 二次 apply 失败`).toBe(true);
      if (b.ok) expect(b.text, `#${i} 不幂等`).toBe(a.text);
      expect(red.pass1(a.text).text, `#${i} pass1 不幂等`).toBe(a.text);
      expect(red.pass2(a.text).clean, `#${i} check(apply(x)) 不干净`).toBe(true);
    }
    expect(okCount).toBeGreaterThan(300);
  });

  it('任意拼接(无分隔、空格、竖线)也幂等:apply 成功则二次 apply 不变、输出过 check', () => {
    const rand = prng(0xadd);
    const bad: string[] = [];
    let okCount = 0;
    for (let i = 0; i < 600; i++) {
      const x = mixed(rand, ['', ' ', ' | ', '; ']);
      const a = red.apply(x);
      if (!a.ok) continue;
      okCount++;
      const b = red.apply(a.text);
      if (!b.ok || b.text !== a.text)
        bad.push(`#${i} 不幂等 ${JSON.stringify(a.text.slice(0, 200))}`);
    }
    expect(okCount).toBeGreaterThan(300);
    expect(bad).toEqual([]);
  });

  it('已有占位符绝不再触发 cred_assign:名字=占位符 + 任意后缀', () => {
    for (const tail of ['', ' ', "'", '"', ')', `'"')`, ' | cut -d= -f2-', '\' "$f" | tail']) {
      for (const head of [
        'FOO_SERVICE_TOKEN=',
        "'^FOO_SERVICE_TOKEN='",
        'password: ',
        'api_key = "',
      ]) {
        const t = `${head}${placeholder('credential')}${tail}`;
        const d = red.pass2(t);
        expect(
          d.hits.filter((h) => h.rule === 'cred_assign'),
          t,
        ).toEqual([]);
        expect(red.pass1(t).text, t).toBe(t);
      }
    }
  });

  it('check(apply(x)) 对 apply 输出的 JSON 转义形态、词边界处截断也干净(模拟信号文件与 collect 的 300 字截断)', () => {
    const rand = prng(0x5eed);
    const bad: string[] = [];
    for (let i = 0; i < 300; i++) {
      const a = red.apply(mixed(rand));
      if (!a.ok) continue;
      const esc = JSON.stringify(a.text);
      const eh = red.pass2(esc).hits;
      if (eh.length > 0) {
        bad.push(
          `#${i} 转义形态 ${eh.map((h) => h.rule).join(',')} ${JSON.stringify(esc.slice(Math.max(0, eh[0]!.start - 40), eh[0]!.end + 10))}`,
        );
      }
      const chars = Array.from(a.text);
      for (let cut = 1; cut < chars.length; cut += 1 + Math.floor(rand() * 9)) {
        // 切点落在词边界上(下一个字符是空白 / 引号 / 管道 / 分号):词中间截断见 docs 已知缺口
        if (!/[\s'"|;&]/.test(chars[cut] as string)) continue;
        // 与 collect 同一个截断函数(切点落在占位符中间则退到占位符开头)
        const p = cutExcerpt(a.text, cut);
        const ph = red.pass2(p).hits;
        if (ph.length > 0)
          bad.push(
            `#${i} 截断 ${cut} ${ph.map((h) => h.rule).join(',')} ${JSON.stringify(p.slice(Math.max(0, ph[0]!.start - 40), ph[0]!.end + 10))}`,
          );
      }
    }
    expect(bad).toEqual([]);
  });

  it('按行脱敏与整文件分块(64KiB,重叠 2KiB)脱敏结论一致', () => {
    const rand = prng(0xc0de);
    const lines: string[] = [];
    for (let i = 0; i < 160; i++) lines.push(mixed(rand).replaceAll('\n', ' '));
    const kept: string[] = [];
    for (const l of lines) {
      const a = red.apply(l);
      if (a.ok) kept.push(a.text);
    }
    const whole = kept.join('\n');
    // 整文件(在 64KiB 内)一次 check
    expect(red.pass2(whole).clean).toBe(true);
    // 放大到跨多个分块,并让引用样本恰好落在块边界附近
    const big = Array.from({ length: Math.ceil(150000 / (whole.length + 1)) }, () => whole).join(
      '\n',
    );
    expect(big.length).toBeGreaterThan(65536 * 2);
    for (const [n, c] of chunkForCheck(big, 65536, 2048).entries()) {
      const d = red.pass2Detail(c.text);
      expect(d.clean, `块 ${n}`).toBe(true);
    }
  });

  it('collect 内部 pass2(对 apply 输出)与外部 --check(对同一文本)结论相同', () => {
    const rand = prng(0xface);
    for (let i = 0; i < 200; i++) {
      const x = mixed(rand);
      const a = red.apply(x);
      if (!a.ok) continue;
      const internal = red.pass2Detail(a.text, true).clean;
      const external = red.pass2Detail(a.text).clean;
      expect(internal).toBe(external);
      expect(external).toBe(true);
    }
  });
});
