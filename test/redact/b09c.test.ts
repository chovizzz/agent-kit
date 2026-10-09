/**
 * B09c:值类规则的召回缺口(真实口令被原样放过)。
 * 所有口令由片段在运行时拼装;断言「输出里没有口令原文」时一律在旁边钉死正向前提
 * (输出里确有占位符 / 对照组仍被脱敏 / 引用对照组原样保留),防止负向断言静默变空。
 */
import { describe, expect, it } from 'vitest';
import { createRedactor } from '../../src/redact/redactor.js';
import { SELFTEST_CONFIG, SELFTEST_INTERNAL_DOMAINS } from '../../src/redact/seeds.js';
import { newRedactor, placeholder, prng } from './helpers.js';

const r = newRedactor();
const PH = '[[REDACTED:';

const UP = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LO = 'abcdefghijkmnpqrstuvwxyz';
const DG = '23456789';

/** 10-12 位、字母开头、含大小写与数字的低熵口令(不到 24 位,前缀规则与熵规则都抓不到) */
function pw(seed: number, len = 11): string {
  const rand = prng(0xb09c0000 + seed);
  const pick = (a: string): string => a[Math.floor(rand() * a.length)] as string;
  let s = pick(UP) + pick(LO) + pick(DG);
  while (s.length < len) s += pick(UP + LO + DG);
  return s;
}

const kw = {
  pw: ['pass', 'word'].join(''),
  PW: ['PASS', 'WORD'].join(''),
  tok: ['tok', 'en'].join(''),
  TOK: ['TOK', 'EN'].join(''),
  authz: ['Author', 'ization'].join(''),
  phrase: ['pass', 'phrase'].join(''),
};

interface Shape {
  id: string;
  build: (v: string) => string;
  /** 默认 11 位口令;需要特殊口令的形状自带 */
  value?: string;
}

function leaks(shape: Shape): { text: string; ok: boolean; out: string } {
  const v = shape.value ?? pw(shape.id.length);
  const text = shape.build(v);
  const p1 = r.pass1(text);
  const a = r.apply(text);
  return {
    text,
    ok: a.ok && !a.text.includes(v) && p1.text.includes(PH) && !p1.text.includes(v),
    out: p1.text,
  };
}

const B = '\\';

const P0: Shape[] = [
  { id: 'p0.kwarg_close_paren', build: (v) => `connect(host=h, ${kw.pw}=${v})` },
  { id: 'p0.kwarg_comma', build: (v) => `login(user, ${kw.pw}=${v}, retries=3)` },
  { id: 'p0.export_semicolon', build: (v) => `export DB_${kw.PW}=${v}; run.sh` },
  { id: 'p0.yaml_list_comma', build: (v) => `  - ${kw.pw}=${v},` },
  { id: 'p0.cli_flag_semicolon', build: (v) => `mysql --${kw.pw}=${v};` },
  { id: 'p0.authz_token_semicolon', build: (v) => `${kw.authz}: Token ${v};` },
  {
    id: 'p0.conn_string',
    build: (v) => `Server=db;Database=app;${kw.pw[0]!.toUpperCase()}${kw.pw.slice(1)}=${v};`,
  },
  { id: 'p0.colon_tail', build: (v) => `${kw.tok}=${v}:` },
  { id: 'p0.yaml_comma', build: (v) => `${kw.pw}: ${v},` },
  { id: 'p0.open_brace', build: (v) => `${kw.pw}=${v}{` },
  { id: 'p0.call_shape', build: (v) => `${kw.pw}=${v}(${pw(3, 9)})` },
  {
    id: 'p0.call_letters_only',
    value: 'Qwertyuiop',
    build: (v) => `${kw.pw}=${v}(dbhost)`,
  },
  { id: 'p0.bracket_tail', build: (v) => `x = [${kw.pw}=${v}]` },
];

const P11: Shape[] = [
  {
    id: 'p1_1.tab_head_short',
    value: ['Xy', 'Abcdefgh9Qz'].join(`${B}t`),
    build: (v) => `${kw.pw}=${v}`,
  },
  {
    id: 'p1_1.json_double_backslash',
    value: ['Q7', 'Lm2Pq9Zx'].join(`${B}${B}t`),
    build: (v) => `{"cmd":"export ${kw.PW}=${v}"}`,
  },
  {
    id: 'p1_1.tail_after_tab',
    value: ['Abcdefgh1', 'Xyz12345'].join(`${B}t`),
    build: (v) => `${kw.pw}=${v}`,
  },
  {
    id: 'p1_1.quoted_newline',
    value: ['Xy', 'Abcdefgh9'].join(`${B}n`),
    build: (v) => `${kw.pw}="${v}"`,
  },
  {
    id: 'p1_1.cli_flag',
    value: ['Xy', 'Abcdefgh9'].join(`${B}t`),
    build: (v) => `tool --${kw.tok} ${v}`,
  },
  { id: 'p1_1.cr', value: ['Ab1Cd2', 'Ef3Gh4Jk5'].join(`${B}r`), build: (v) => `${kw.TOK}='${v}'` },
];

const P12: Shape[] = [
  { id: 'p1_2.half_then_quoted', build: (v) => `${kw.TOK}=abcdefgh123"${v}"` },
  { id: 'p1_2.half_then_squoted', build: (v) => `${kw.TOK}=abcdefgh123'${v}'` },
  {
    id: 'p1_2.existing_placeholder_then_quoted',
    build: (v) => `${kw.TOK}=${placeholder('credential')}"${v}"`,
  },
];

const P13: Shape[] = [
  { id: 'p1_3.env_dot', build: (v) => `${kw.pw}=env.${v}` },
  { id: 'p1_3.yaml_dollar', build: (v) => `${kw.pw}: $${v}` },
  { id: 'p1_3.ellipsis', build: (v) => `${kw.pw}=...${v}` },
  { id: 'p1_3.yaml_dollar_upper', value: 'HUNTERXYZABC', build: (v) => `${kw.pw}: $${v}` },
  { id: 'p1_3.angle', build: (v) => `${kw.pw}=<${v}` },
  { id: 'p1_3.percent', build: (v) => `${kw.pw}=%${v}` },
  { id: 'p1_3.vault_prefix', value: ['Vault', pw(7, 8)].join(''), build: (v) => `${kw.pw}=${v}` },
  { id: 'p1_3.config_dot', build: (v) => `${kw.pw}=config.${v}` },
  {
    id: 'p1_3.ref_next_word_vault',
    value: ['vault', pw(8, 8)].join(''),
    build: (v) => `grep '^${kw.TOK}=' ${v}`,
  },
  { id: 'p1_3.ref_next_word_config', build: (v) => `grep '^${kw.TOK}=' config.${v}` },
  { id: 'p1_3.flag_with_value', build: (v) => `env '${kw.TOK}=' --${v}` },
  { id: 'p1_3.flag_eq_value', build: (v) => `env '${kw.TOK}=' --x=${v}` },
  { id: 'p1_3.call_shape_next_word', build: (v) => `printf '${kw.TOK}=' ${v}(x)` },
];

const P14: Shape[] = [
  { id: 'p1_4.js_template', build: (v) => `const ${kw.pw} = \`${v}\`;` },
  { id: 'p1_4.go_raw', build: (v) => `${kw.pw} := \`${v}\`` },
  { id: 'p1_4.triple_single', build: (v) => `${kw.pw} = '''${v}'''` },
  { id: 'p1_4.triple_double', build: (v) => `${kw.pw} = """${v}"""` },
  { id: 'p1_4.py_annotation', build: (v) => `${kw.pw}: str = "${v}"` },
  { id: 'p1_4.py_annotation_optional', build: (v) => `${kw.pw}: Optional[str] = '${v}'` },
  { id: 'p1_4.ts_annotation', build: (v) => `const ${kw.pw}: string = "${v}";` },
  { id: 'p1_4.glued_short_prefix', build: (v) => `${kw.PW}=ab"${v}"` },
  { id: 'p1_4.glued_two_quoted', build: (v) => `${kw.PW}="ab""${v}"` },
  {
    id: 'p1_4.phrase_quoted',
    value: 'correct horse battery staple',
    build: (v) => `${kw.pw} = "${v}"`,
  },
  {
    id: 'p1_4.phrase_unquoted',
    value: 'zebra quartz mango plume',
    build: (v) => `${kw.phrase} = ${v}`,
  },
];

const PR: Shape[] = [
  { id: 'pr.laravel_env_default', build: (v) => `'${kw.pw}' => env('DB_${kw.PW}', '${v}'),` },
  { id: 'pr.decouple_default', build: (v) => `${kw.PW} = config('X', default='${v}')` },
  { id: 'pr.ruby_env_or', build: (v) => `${kw.pw} = ENV['X'] || '${v}'` },
  { id: 'pr.php_elvis', build: (v) => `$${kw.pw} = getenv('X') ?: '${v}';` },
  { id: 'pr.shell_subst_echo', build: (v) => `${kw.PW}=$(echo ${v})` },
  { id: 'pr.call_literal_arg', build: (v) => `${kw.pw} = hash("${v}")` },
  { id: 'pr.getattr_default', build: (v) => `${kw.pw} = getattr(settings, "X", "${v}")` },
  { id: 'pr.digit_callee_arg', build: (v) => `${kw.pw} = base64decode("${v}")` },
  { id: 'pr.pydantic_field_default', build: (v) => `${kw.pw}: SecretStr = Field(default="${v}")` },
  {
    id: 'pr.pydantic_field_positional',
    build: (v) => `${kw.pw}: str = Field("${v}", min_length=8)`,
  },
  { id: 'pr.js_ternary', build: (v) => `${kw.pw} = process.env.X ? process.env.X : "${v}"` },
  { id: 'pr.js_nullish_backtick', build: (v) => `${kw.pw} = process.env.X ?? \`${v}\`` },
  {
    id: 'pr.getenv_upper_digit_default',
    value: 'KAB3CD4EF5G',
    build: (v) => `${kw.pw} = os.getenv("X", "${v}")`,
  },
  { id: 'pr.quote_first_short_prefix', build: (v) => `${kw.PW}="ab"${v}` },
  { id: 'pr.dollar_upper_digits', value: 'KAB3CD4EF5G', build: (v) => `${kw.pw}=$${v}` },
  { id: 'pr.dollar_upper_digits_quoted', value: 'KAB3CD4EF5G', build: (v) => `${kw.pw} = "$${v}"` },
  { id: 'pr.env_dot_upper_digits', value: 'KAB3CD4EF5G', build: (v) => `${kw.pw}=env.${v}` },
  {
    id: 'pr.short_head_before_escaped_newline',
    value: 'Kx8q2' + B + 'nLm9pQz',
    build: (v) => `{"c":"${kw.pw}=${v}"}`,
  },
];

const ALL: Shape[] = [...P0, ...P11, ...P12, ...P13, ...P14, ...PR];

describe('B09c:每个形状的输出都不含口令原文(且确有占位符)', () => {
  for (const s of ALL) {
    it(s.id, () => {
      const res = leaks(s);
      expect(res.ok, `输出=${res.out.replaceAll(s.value ?? '', '<PW>')}`).toBe(true);
    });
  }
});

describe('B09c:短语形状逐词核对(每个词都不得残留)', () => {
  it('unquoted passphrase', () => {
    const words = ['zebra', 'quartz', 'mango', 'plume'];
    const text = `${kw.phrase} = ${words.join(' ')}`;
    const p1 = r.pass1(text);
    expect(p1.text).toContain(PH);
    for (const w of words) expect(p1.text.includes(w), w).toBe(false);
  });
  it('quoted phrase', () => {
    const words = ['correct', 'horse', 'battery', 'staple'];
    const p1 = r.pass1(`${kw.pw} = "${words.join(' ')}"`);
    expect(p1.text).toContain(PH);
    for (const w of words) expect(p1.text.includes(w), w).toBe(false);
  });
});

describe('B09c:JSON 信号文件里的转义形态', () => {
  // 已知缺口:转义引号包裹的三引号 / 双引号拼接不识别(docs/redaction.md)
  const skipJson = new Set(['p1_4.triple_double', 'p1_4.glued_two_quoted']);
  for (const s of ALL.filter((x) => !x.id.startsWith('p1_1.') && !skipJson.has(x.id))) {
    it(`JSON 字符串形态:${s.id}`, () => {
      const v = s.value ?? pw(s.id.length);
      const file = JSON.stringify({ cmd: s.build(v) });
      const a = r.apply(file);
      expect(a.ok && !a.text.includes(v) && a.text.includes(PH), s.id).toBe(true);
    });
  }
});

describe('B09c:引用形态仍原样放行(正向对照)', () => {
  const benign: Array<[string, string]> = [
    ['type_array', `${kw.pw}_prefixes: string[];`],
    ['type_generic', `${kw.tok}: Map<string, number>;`],
    ['call_getter_semicolon', `${kw.tok} = getToken(user);`],
    ['call_getter_empty', `${kw.tok}=getToken();`],
    ['env_access', `${kw.pw}: process.env.DB_${kw.PW}`],
    ['env_access_semicolon', `${kw.pw} = process.env.DB_${kw.PW};`],
    ['shell_var', `${kw.TOK}=$API_${kw.TOK}`],
    ['shell_var_semicolon', `export ${kw.TOK}=$API_${kw.TOK}; run.sh`],
    ['brace_var_comma', `${kw.pw}: \${DB_${kw.PW}},`],
    ['kwarg_var', `connect(host=h, ${kw.pw}=$DB_${kw.PW})`],
    ['dotted_config', `${kw.pw}=config.dbPassword`],
    ['placeholder', `${kw.pw}: ${placeholder('credential')}`],
    ['mask', `${kw.pw}: ********`],
    ['python_getenv', `${kw.pw} = os.getenv(`],
    ['angle_placeholder', `${kw.pw}=<your-${kw.pw}>`],
    ['word_required', `secret: required`],
  ];
  for (const [k, text] of benign) {
    it(k, () => {
      const p1 = r.pass1(text);
      expect(p1.hits, '第一遍不得命中').toEqual([]);
      expect(p1.text).toBe(text);
      expect(r.pass2(text).clean).toBe(true);
    });
  }
});

describe('B09c:真值紧邻引用形态(互不干扰)', () => {
  const ref = `grep '^${kw.TOK}=' "$ENVFILE"`;
  const refVar = `${kw.TOK}=$API_${kw.TOK}`;
  const refType = `${kw.tok}: string[];`;
  const cases: Array<[string, (v: string) => string]> = [
    ['ref_then_kwarg', (v) => `${ref}; connect(${kw.pw}=${v})`],
    ['kwarg_then_ref', (v) => `connect(${kw.pw}=${v}); ${ref}`],
    ['var_then_semicolon_value', (v) => `${refVar}; export DB_${kw.PW}=${v};`],
    ['value_then_var', (v) => `export DB_${kw.PW}=${v}; ${refVar}`],
    ['type_then_value', (v) => `${refType} ${kw.pw}=${v};`],
    ['value_then_type', (v) => `${kw.pw}=${v}; ${refType}`],
    ['ref_then_backtick', (v) => `${ref} && ${kw.pw} = \`${v}\``],
    ['backtick_then_ref', (v) => `${kw.pw} = \`${v}\`; ${ref}`],
    ['ref_then_annotation', (v) => `${ref}\n${kw.pw}: str = "${v}"`],
    ['annotation_then_ref', (v) => `${kw.pw}: str = "${v}"\n${ref}`],
    ['ref_then_glued', (v) => `${ref}; ${kw.PW}=ab"${v}"`],
    ['glued_then_ref', (v) => `${kw.PW}=ab"${v}"; ${ref}`],
    ['env_ref_then_value', (v) => `${kw.pw}=env.dbPassword ${kw.TOK}=${v};`],
    ['value_then_env_ref', (v) => `${kw.TOK}=${v}; ${kw.pw}=env.dbPassword`],
  ];
  for (const [k, f] of cases) {
    it(k, () => {
      const v = pw(k.length * 3, 12);
      const text = f(v);
      const p1 = r.pass1(text);
      expect(p1.text.includes(PH), '必须命中').toBe(true);
      expect(p1.text.includes(v), '真值不得残留').toBe(false);
      const a = r.apply(text);
      expect(a.ok && !a.text.includes(v)).toBe(true);
      // 引用部分原样保留(对照:没有把引用也一起吞掉)
      if (text.includes(ref)) expect(p1.text.includes(ref)).toBe(true);
      if (text.includes(refVar)) expect(p1.text.includes(refVar)).toBe(true);
      if (text.includes(refType)) expect(p1.text.includes(refType)).toBe(true);
    });
  }
});

describe('B09c:剥尾部标点只剥尾部', () => {
  it('口令中间的标点保留在值里(整体脱敏)', () => {
    const v = ['Ab1;Cd2', ',Ef3Gh4'].join('');
    const p1 = r.pass1(`${kw.pw}=${v}`);
    expect(p1.text).toBe(`${kw.pw}=${placeholder('credential')}`);
  });
  it('尾部标点留在输出里,语法不被破坏', () => {
    const v = pw(21);
    expect(r.pass1(`connect(${kw.pw}=${v})`).text).toBe(
      `connect(${kw.pw}=${placeholder('credential')})`,
    );
    expect(r.pass1(`export ${kw.PW}=${v}; run`).text).toBe(
      `export ${kw.PW}=${placeholder('credential')}; run`,
    );
  });
});

describe('B09c:两遍一致与幂等', () => {
  it('apply 输出再 apply 不变、过 --check(P0/P1 各形状)', () => {
    for (const s of ALL) {
      const v = s.value ?? pw(s.id.length);
      const text = s.build(v);
      const a = r.apply(text);
      expect(a.ok, s.id).toBe(true);
      if (!a.ok) continue;
      expect(a.text.includes(v), s.id).toBe(false);
      const b = r.apply(a.text);
      expect(b.ok && b.text === a.text, `${s.id} 不幂等`).toBe(true);
      expect(r.pass2(a.text).clean, `${s.id} check 不干净`).toBe(true);
    }
  });

  it('P1-2:pass1 只脱敏了一半的结果交给 pass2 必须判不干净(或 pass1 已整体吃掉)', () => {
    const v = pw(31);
    const half = `${kw.TOK}=${placeholder('credential')}"${v}"`;
    const d = r.pass2Detail(half);
    expect(d.clean).toBe(false);
    // 对照:纯占位符不误判
    expect(r.pass2(`${kw.TOK}=${placeholder('credential')}`).clean).toBe(true);
    expect(r.pass2(`"${kw.TOK}=${placeholder('credential')}" && echo hello world`).clean).toBe(
      true,
    );
  });

  it('P2-3:引号奇偶两遍一致(pass1 脱敏掉值里的引号后 pass2 不翻转)', () => {
    const v = ['Ab', "'", 'cdefgh12'].join('');
    const text = `${kw.pw}="${v}" x' '${kw.TOK}=' file.env`;
    const a = r.apply(text);
    expect(a.ok, '不得因奇偶翻转落到 residual').toBe(true);
    if (a.ok) {
      expect(a.text.includes('cdefgh12')).toBe(false);
      expect(a.text.includes(PH)).toBe(true);
    }
    const p1 = r.pass1(text).text;
    expect(r.pass1(p1).text).toBe(p1);
  });
});

describe('B09c:线性时间(宽松 CPU 预算,不依赖墙钟毫秒)', () => {
  const cpuMs = (fn: () => void): number => {
    const t = process.cpuUsage();
    fn();
    const d = process.cpuUsage(t);
    return (d.user + d.system) / 1000;
  };
  const N = 65536;
  const slow = createRedactor({ timeout_ms: 5000 });

  it('64K 个反斜杠(双引号值分支)在 5000ms 预算内完成且不 timeout', () => {
    const text = `${kw.pw}="` + B.repeat(N);
    let res: ReturnType<typeof slow.apply> | undefined;
    const ms = cpuMs(() => {
      res = slow.apply(text);
    });
    expect(res && (res.ok || res.reason !== 'timeout')).toBe(true);
    // 线性:远低于二次增长(旧实现约 2300ms)。CPU 时间,放宽到 1500ms
    expect(ms).toBeLessThan(1500);
  });

  it('引用式重复 64KiB 不换行(readUnit 逐词扫到行尾)', () => {
    const text = `'${kw.TOK}=' `.repeat(Math.floor(N / (kw.TOK.length + 5)));
    let res: ReturnType<typeof slow.apply> | undefined;
    const ms = cpuMs(() => {
      res = slow.apply(text);
    });
    expect(res && (res.ok || res.reason !== 'timeout')).toBe(true);
    expect(ms).toBeLessThan(1500);
  });

  it('长行里大量反斜杠分段与引号混排', () => {
    const text = (`${kw.pw}="a` + B.repeat(40) + `b `).repeat(1500);
    const ms = cpuMs(() => void slow.apply(text.slice(0, N)));
    expect(ms).toBeLessThan(1500);
  });
});

describe('B09c:自检配置下同样成立', () => {
  const st = createRedactor(SELFTEST_CONFIG, { internalDomains: SELFTEST_INTERNAL_DOMAINS });
  it('几个代表形状', () => {
    for (const s of [P0[0]!, P0[2]!, P11[2]!, P12[0]!, P14[0]!, P14[4]!, P14[7]!]) {
      const v = s.value ?? pw(s.id.length);
      const a = st.apply(s.build(v));
      expect(a.ok && !a.text.includes(v) && a.text.includes(PH), s.id).toBe(true);
    }
  });
});
