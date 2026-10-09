/**
 * 脱敏种子集生成器(设计 §6.3 / 计划 B09 / A3 / A10)。
 *
 * 铁律:仓库里不得出现任何完整的密钥字面量。所有"假秘密"都在运行时由片段拼装:
 * 源码里只有前缀、字符表和生成规则;体由固定 seed 的 PRNG 或"低熵重复模式"产生。
 * 生成物只存在于内存(selftest 用完即弃),不写盘。
 *
 * 低熵体(`a1a1…`)是故意的:它躲过高熵检测,所以只有"对应的那条规则"能抓住它——
 * 变异自检因此能证明删掉任一条规则都会有种子变红(A3 的变异检验)。
 *
 * 种子分档(tier):
 *  - recognized  由某条具名规则(可能经归一化/解码/压缩视图)识别,第一遍后精确等于 expected
 *  - entropy_only 没有具名规则适用,只靠高熵检测兜底(拼接/未知厂商)
 *  - pass2_only  第一遍(解码深度 2)抓不到、第二遍(深度 3)才抓到;apply 因此 fail-closed
 *  - known_gap   做不到的形态。**只报告,不计入召回**,也不得写成"已支持"(见 docs/redaction.md)
 *  - benign      误杀对照:第一遍不得改动一个字符,第二遍必须干净
 *  - legit_placeholder 合法占位符:同 benign
 */
import { placeholder } from './redactor.js';
import { shannon } from './entropy.js';
import { PREFIX_TABLE } from './rules.js';

export type SeedTier =
  'recognized' | 'entropy_only' | 'pass2_only' | 'known_gap' | 'benign' | 'legit_placeholder';

/** 设计 §6.3 的 8 类 + 归一化变形(unicode_fold)+ 误杀对照(benign) */
export type SeedCategory =
  | 'plain'
  | 'adjacent_placeholder'
  | 'base64'
  | 'concat_multiline'
  | 'url_encoded'
  | 'zero_width'
  | 'cjk_name'
  | 'legit_placeholder'
  | 'unicode_fold'
  | 'benign';

export interface Seed {
  id: string;
  category: SeedCategory;
  tier: SeedTier;
  input: string;
  /** 第一遍的精确期望输出(recognized / entropy_only;benign 等于 input) */
  expected: string | undefined;
  /** 第一遍输出里不得出现的片段(被替换掉的原始秘密) */
  needles: string[];
  /** 变异自检:禁用且仅禁用这些规则/阶段之一就会让本种子变红 */
  pinned: string[];
  note: string | undefined;
}

/** 自检固定使用的配置:允许名单、敏感词、额外前缀、内部域名。 */
export const SELFTEST_CONFIG = {
  extra_secret_prefixes: ['acmekit_'],
  sensitive_words: ['张三科技', 'Acme Corp', '北极星计划'],
  allowed_url_hosts: [
    'github.com',
    'open.feishu.cn',
    'open.larksuite.com',
    'hooks.slack.com',
    'discord.com',
    'api.telegram.org',
  ],
  timeout_ms: 2000,
  max_input_chars: 65536,
};
export const SELFTEST_INTERNAL_DOMAINS = ['corp.acme-fake.dev'];

// ---------------------------------------------------------------------------
// 确定性 PRNG 与字符串工具
// ---------------------------------------------------------------------------

export const SEED = 0x5eed_b09;

function mulberry32(a: number): () => number {
  let s = a >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const B64URL = `${ALNUM}-_`;
const HEXL = '0123456789abcdef';

function rep(sample: string, n: number): string {
  return sample.repeat(Math.ceil(n / sample.length)).slice(0, n);
}

type Gen = {
  pick(alphabet: string, n: number): string;
  /** 抽样直到熵不低于 minBits(保证"高熵"种子不会因运气掉线) */
  entropic(alphabet: string, n: number, minBits?: number): string;
};

function makeGen(rand: () => number): Gen {
  const pick = (alphabet: string, n: number): string => {
    let s = '';
    for (let i = 0; i < n; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
    return s;
  };
  return {
    pick,
    entropic(alphabet, n, minBits = 4.2) {
      for (let k = 0; k < 1000; k++) {
        const s = pick(alphabet, n);
        if (/[0-9]/.test(s) && /[A-Za-z]/.test(s) && shannon(s) >= minBits) return s;
      }
      throw new Error('seed generator: cannot reach requested entropy');
    },
  };
}

/** 假 IP / 邮箱 / URL 也由片段拼装:仓库里不出现完整的 IP、邮箱、非保留域 URL 字面量(A10)。 */
const dot = (...p: Array<string | number>): string => p.join('.');
const at = (local: string, domain: string): string => `${local}@${domain}`;
const web = (scheme: string, rest: string): string => `${scheme}://${rest}`;

/** 头名由片段拼成:本文件自己要过 A10 的零命中扫描(转义换行后的行首头名会被还原成真行首) */
const AZ = ['Author', 'ization'].join('');
/** 名字由片段拼成:本文件自己要过 A10 的零命中扫描 */
const FST = 'FOO_SERVICE_' + 'TOKEN';
const FPW = 'FOO_PASS' + 'WORD';
const FDS = 'FOO_DASHBOARD_' + 'SECRET';
const CK = ['Coo', 'kie'].join('');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32 = (s: string): string => {
  let bits = '';
  for (const b of Buffer.from(s, 'utf8')) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5)
    out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
};

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const b64url = (s: string): string =>
  Buffer.from(s, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const pct = (s: string): string =>
  [...Buffer.from(s, 'utf8')]
    .map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`)
    .join('');

// ---------------------------------------------------------------------------
// 构造器
// ---------------------------------------------------------------------------

type Part = string | { s: string; t: string };
const R = (s: string, t: string): Part => ({ s, t });

function make(
  id: string,
  category: SeedCategory,
  tier: SeedTier,
  parts: Part[],
  pinned: string[],
  extraNeedles: string[] = [],
  note?: string,
): Seed {
  const input = parts.map((p) => (typeof p === 'string' ? p : p.s)).join('');
  const expected = parts.map((p) => (typeof p === 'string' ? p : placeholder(p.t))).join('');
  const needles = [
    ...parts.filter((p): p is { s: string; t: string } => typeof p !== 'string').map((p) => p.s),
    ...extraNeedles,
  ];
  return { id, category, tier, input, expected, needles, pinned, note };
}

function unchanged(id: string, category: SeedCategory, tier: SeedTier, input: string): Seed {
  return { id, category, tier, input, expected: input, needles: [], pinned: [], note: undefined };
}

function gap(
  id: string,
  category: SeedCategory,
  input: string,
  needles: string[],
  why: string,
): Seed {
  return {
    id,
    category,
    tier: 'known_gap',
    input,
    expected: undefined,
    needles,
    pinned: [],
    note: why,
  };
}

// ---------------------------------------------------------------------------
// 种子集
// ---------------------------------------------------------------------------

export function buildSeeds(seed: number = SEED): Seed[] {
  const g = makeGen(mulberry32(seed));
  const out: Seed[] = [];
  const add = (...s: Seed[]): void => void out.push(...s);

  // ---- plain:前缀表里每条规则一个低熵种子(只有该规则能抓) ----
  for (const spec of PREFIX_TABLE) {
    const n = spec.exact ? spec.min : spec.min + 2;
    const body = rep(spec.sample, n);
    add(
      make(
        `plain.prefix.${spec.name}`,
        'plain',
        'recognized',
        ['use ', R(`${spec.lit}${body}`, 'api_key'), ' here'],
        [`prefix_${spec.name}`],
      ),
    );
  }
  // 额外前缀(配置可加)
  add(
    make(
      'plain.prefix.extra',
      'plain',
      'recognized',
      ['k ', R(`acmekit_${rep('a1', 14)}`, 'api_key')],
      ['prefix_extra_0'],
    ),
  );
  // 真实形态的高熵密钥:类型由前缀规则决定(prio 80 > 熵 20),所以前缀规则被禁用时输出会变
  {
    const sk = `sk-proj-${g.entropic(B64URL, 48)}`;
    const ghp = `ghp_${g.entropic(ALNUM, 36)}`;
    const akia = `AKIA${g.pick('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 16)}`;
    add(
      make(
        'plain.real.sk',
        'plain',
        'recognized',
        ['OPENAI_KEY=', R(sk, 'api_key'), '\n'],
        ['prefix_sk'],
      ),
      make(
        'plain.real.ghp',
        'plain',
        'recognized',
        ['token ', R(ghp, 'api_key'), ' ok'],
        ['prefix_ghp'],
      ),
      make(
        'plain.real.akia',
        'plain',
        'recognized',
        ['aws ', R(akia, 'api_key'), ' ok'],
        ['prefix_aws_akia'],
      ),
    );
  }

  // PEM:低熵体(只有 PEM 规则能抓)、截断无页脚、随机体
  const pemHead = (kind: string): string => `-----BEGIN ${kind}PRIVATE KEY-----`;
  const pemFoot = (kind: string): string => `-----END ${kind}PRIVATE KEY-----`;
  const pemBody = (lines: number, fill: string): string =>
    Array.from({ length: lines }, () => rep(fill, 64)).join('\n');
  for (const [k, kind] of [
    ['rsa', 'RSA '],
    ['ec', 'EC '],
    ['openssh', 'OPENSSH '],
    ['plain', ''],
  ] as const) {
    const blob = `${pemHead(kind)}\n${pemBody(3, 'QUJD')}\n${pemFoot(kind)}`;
    add(
      make(
        `plain.pem.${k}`,
        'plain',
        'recognized',
        ['key:\n', R(blob, 'private_key'), '\nend'],
        ['pem_private_key'],
      ),
    );
  }
  add(
    make(
      'plain.pem.truncated',
      'plain',
      'recognized',
      ['key:\n', R(`${pemHead('RSA ')}\n${pemBody(2, 'QUJD')}`, 'private_key'), '\n\nrest of log'],
      ['pem_private_key'],
    ),
    make(
      'plain.pem.random',
      'plain',
      'recognized',
      [
        'k:\n',
        R(
          `${pemHead('')}\n${Array.from({ length: 3 }, () => g.pick(`${ALNUM}+/`, 64)).join('\n')}\n${pemFoot('')}`,
          'private_key',
        ),
        '\n',
      ],
      ['pem_private_key'],
    ),
  );

  // JWT:各段 <24 字符的短 JWT(熵规则看不到,只有 jwt 规则能抓)+ 长随机 JWT
  const jwtHead = b64url('{"alg":"none"}');
  for (const [k, payload] of [
    ['short1', '{"a":1}'],
    ['short2', '{"sub":"x"}'],
    ['short3', '{"n":"abc"}'],
  ] as const) {
    add(
      make(
        `plain.jwt.${k}`,
        'plain',
        'recognized',
        ['auth ', R(`${jwtHead}.${b64url(payload)}.a1a1a1a1`, 'jwt'), ' end'],
        ['jwt'],
      ),
    );
  }
  add(
    make(
      'plain.jwt.long',
      'plain',
      'recognized',
      [
        'jwt=',
        R(
          `${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url(`{"sub":"${g.pick(ALNUM, 12)}","exp":1893456000}`)}.${g.pick(B64URL, 43)}`,
          'jwt',
        ),
        ' ',
      ],
      ['jwt'],
    ),
  );

  // webhook:主机在允许名单里,所以只有 webhook 规则能抓
  add(
    make(
      'plain.webhook.feishu_v2',
      'plain',
      'recognized',
      [
        'notify ',
        R(web('https', `open.feishu.cn/open-apis/bot/v2/hook/${rep('a1', 32)}`), 'webhook'),
        ' now',
      ],
      ['webhook_feishu'],
    ),
    make(
      'plain.webhook.feishu_lark',
      'plain',
      'recognized',
      [
        'hook=',
        R(web('https', `open.larksuite.com/open-apis/bot/v2/hook/${rep('b2', 24)}`), 'webhook'),
      ],
      ['webhook_feishu'],
    ),
    make(
      'plain.webhook.slack',
      'plain',
      'recognized',
      [
        'post ',
        R(
          web('https', `hooks.slack.com/services/T${rep('0', 8)}/B${rep('0', 8)}/${rep('a1', 12)}`),
          'webhook',
        ),
        '.',
      ],
      ['webhook_slack'],
    ),
    make(
      'plain.webhook.discord',
      'plain',
      'recognized',
      [
        'd ',
        R(web('https', `discord.com/api/webhooks/${rep('1', 18)}/${rep('a1', 34)}`), 'webhook'),
      ],
      ['webhook_discord'],
    ),
    make(
      'plain.webhook.telegram',
      'plain',
      'recognized',
      ['t ', R(web('https', `api.telegram.org/bot${rep('1', 9)}:${rep('a1', 34)}`), 'webhook')],
      ['webhook_telegram'],
    ),
  );

  // 飞书 ID / token
  add(
    make(
      'plain.feishu.oc',
      'plain',
      'recognized',
      ['群 ', R(`oc_${rep('a1', 32)}`, 'feishu_id'), ' 的消息'],
      ['feishu_id'],
    ),
    make(
      'plain.feishu.ou',
      'plain',
      'recognized',
      ['user ', R(`ou_${rep('b2', 32)}`, 'feishu_id')],
      ['feishu_id'],
    ),
    make(
      'plain.feishu.on',
      'plain',
      'recognized',
      ['union ', R(`on_${rep('c3', 32)}`, 'feishu_id')],
      ['feishu_id'],
    ),
    make(
      'plain.feishu.cli',
      'plain',
      'recognized',
      ['app ', R(`cli_${rep('a1', 16)}`, 'feishu_id')],
      ['feishu_id'],
    ),
    make(
      'plain.feishu.t',
      'plain',
      'recognized',
      ['tenant ', R(`t-${rep('a1', 32)}`, 'token'), ' ok'],
      ['feishu_token'],
    ),
    make(
      'plain.feishu.u',
      'plain',
      'recognized',
      ['user ', R(`u-${rep('a1', 32)}`, 'token'), ' ok'],
      ['feishu_token'],
    ),
    make(
      'plain.feishu.a',
      'plain',
      'recognized',
      ['app ', R(`a-${rep('a1', 32)}`, 'token'), ' ok'],
      ['feishu_token'],
    ),
    make(
      'plain.zhipu',
      'plain',
      'recognized',
      ['glm ', R(`${rep('a1', 32)}.${rep('a1', 16)}`, 'api_key')],
      ['zhipu_key'],
    ),
    make(
      'plain.telegram_bot',
      'plain',
      'recognized',
      ['bot ', R(`${rep('1', 9)}:${rep('a1', 35)}`, 'api_key')],
      ['telegram_bot_token'],
    ),
  );

  // 凭据赋值与头
  add(
    make(
      'plain.cred.json',
      'plain',
      'recognized',
      ['{"pass' + 'word": "', R('hunter2hunter2', 'credential'), '"}'],
      ['cred_assign'],
    ),
    make(
      'plain.cred.env',
      'plain',
      'recognized',
      ['API_TOKEN=', R('abc123def456ghi', 'credential'), '\n'],
      ['cred_assign'],
    ),
    make(
      'plain.cred.yaml',
      'plain',
      'recognized',
      ['db:\n  client_secret: ', R('s3cr3t-value-9', 'credential'), '\n'],
      ['cred_assign'],
    ),
    make(
      'plain.cred.py',
      'plain',
      'recognized',
      ["passwd = '", R('P@ssw0rd!2024', 'credential'), "'"],
      ['cred_assign'],
    ),
    make(
      'plain.cred.flag_space',
      'plain',
      'recognized',
      ['mysql --password ', R('hunter2hunter2', 'credential'), ' -h db'],
      ['cred_cli_flag'],
    ),
    make(
      'plain.cred.flag_auth',
      'plain',
      'recognized',
      ['tool --auth-token ', R('abc123def456', 'credential')],
      ['cred_cli_flag'],
    ),
    make(
      'plain.cred.bearer',
      'plain',
      'recognized',
      ['send Bearer ', R(rep('a1', 20), 'token'), ' now'],
      ['cred_bearer'],
    ),
    make(
      'plain.cred.bearer_header',
      'plain',
      'recognized',
      ['Authorization: Bearer ', R(rep('a1', 20), 'credential')],
      ['cred_authz'],
    ),
    make(
      'plain.cred.basic',
      'plain',
      'recognized',
      ['auth Basic ', R(b64(rep('ab:', 12)), 'credential'), ' end'],
      ['cred_basic'],
    ),
    make(
      'plain.cred.authz_digest',
      'plain',
      'recognized',
      ['Authorization: Digest ', R('response="a1a1a1a1a1a1a1a1"', 'credential')],
      ['cred_authz'],
    ),
    make(
      'plain.cred.authz_aws',
      'plain',
      'recognized',
      [
        'Authorization: AWS4-HMAC-SHA256 ',
        R('Credential=x/y/z, Signature=a1a1a1a1a1a1a1a1', 'credential'),
      ],
      ['cred_authz'],
    ),
    make(
      'plain.cred.cookie',
      'plain',
      'recognized',
      [`GET /\n${CK}: `, R('session=a1a1a1a1a1a1a1a1', 'credential'), '\nHost: x'],
      ['cred_cookie'],
    ),
    make(
      'plain.cred.set_cookie',
      'plain',
      'recognized',
      [`HTTP/1.1 200\nSet-${CK}: `, R('sid=b2b2b2b2b2b2b2b2; Path=/', 'credential'), '\n'],
      ['cred_cookie'],
    ),
    make(
      'plain.cred.userinfo',
      'plain',
      'recognized',
      ['neo4j://neo:', R(at('a1a1a1a1', 'db.acme-fake.dev'), 'credential'), ':7687'],
      ['url_userinfo', 'email'],
    ),
    make(
      'plain.cred.userinfo_empty_user',
      'plain',
      'recognized',
      ['clickhouse://:', R(at('a1a1a1a1', 'db.acme-fake.dev'), 'credential'), ':9000'],
      ['url_userinfo', 'email'],
    ),
  );

  // 高熵兜底(无具名规则):未知厂商的随机密钥
  add(
    make(
      'entropy.alnum32',
      'plain',
      'entropy_only',
      ['secret thing ', R(g.entropic(ALNUM, 32), 'high_entropy'), ' end'],
      ['high_entropy'],
    ),
    make(
      'entropy.b64_40',
      'plain',
      'entropy_only',
      ['blob: ', R(g.entropic(`${ALNUM}+/`, 40), 'high_entropy')],
      ['high_entropy'],
    ),
    make(
      'entropy.urlsafe43',
      'plain',
      'entropy_only',
      ['k=', R(g.entropic(B64URL, 43), 'high_entropy'), '\n'],
      ['high_entropy'],
    ),
    make(
      'entropy.unknown_vendor_concat',
      'concat_multiline',
      'entropy_only',
      ['const a = "zz-" + "', R(g.entropic(ALNUM, 40), 'high_entropy'), '";'],
      ['high_entropy'],
      [],
      '前缀未知的拼接:只靠熵抓后半段',
    ),
  );

  // IP / 邮箱 / URL
  add(
    make(
      'plain.ip.tailscale',
      'plain',
      'recognized',
      ['ssh ', R(dot(100, 64, 12, 34), 'ip'), ' ok'],
      ['ipv4'],
    ),
    make(
      'plain.ip.private',
      'plain',
      'recognized',
      ['at ', R(dot(10, 20, 30, 40), 'ip'), ':5432'],
      ['ipv4'],
    ),
    make(
      'plain.ip.public',
      'plain',
      'recognized',
      ['from ', R(dot(198, 18, 7, 9), 'ip'), '.'],
      ['ipv4'],
    ),
    make(
      'plain.ip.defanged',
      'plain',
      'recognized',
      ['c2 ', R(dot(198, 18, 7, 9).replace(/\./g, '[.]'), 'ip')],
      ['ipv4'],
    ),
    make(
      'plain.ip6.full',
      'plain',
      'recognized',
      ['v6 ', R(['2001', 'db8', '1', '2', '3', '4', '5', '6'].join(':'), 'ip')],
      ['ipv6'],
    ),
    make(
      'plain.ip6.ula',
      'plain',
      'recognized',
      ['ts ', R(['fd7a', '115c', 'a1e0', '', '1'].join(':'), 'ip')],
      ['ipv6'],
    ),
    make(
      'plain.email.1',
      'plain',
      'recognized',
      ['mail ', R(at('jane.doe+tag', 'acme-fake.dev'), 'email'), ' now'],
      ['email'],
    ),
    make(
      'plain.email.2',
      'plain',
      'recognized',
      ['<', R(at('ops_team', 'mail.acme-fake.dev'), 'email'), '>'],
      ['email'],
    ),
    make(
      'plain.email.3',
      'plain',
      'recognized',
      ['git ', R(at('git', 'gitlab.acme-fake.dev'), 'email'), ':org/repo.git'],
      ['email'],
    ),
    make(
      'plain.url.1',
      'plain',
      'recognized',
      ['see ', R(web('https', 'intranet.acme-fake.dev/wiki/x?id=1'), 'url'), ' ok'],
      ['url'],
    ),
    make(
      'plain.url.2',
      'plain',
      'recognized',
      ['(', R(web('http', 'build.acme-fake.dev:8080/job'), 'url'), ')'],
      ['url'],
    ),
    make(
      'plain.url.userinfo_allowed_host',
      'plain',
      'recognized',
      ['git clone ', R(web('https', `bot:tok${'@'}github.com/org/repo.git`), 'credential')],
      ['url', 'url_userinfo'],
    ),
    make(
      'plain.url.lookalike_host',
      'plain',
      'recognized',
      ['go ', R(web('https', 'github.com.evil.acme-fake.dev/x'), 'url')],
      ['url'],
    ),
  );

  // 中文客户名 / 内部域名(覆盖层词表)
  add(
    make(
      'cjk.plain',
      'cjk_name',
      'recognized',
      ['客户 ', R('张三科技', 'sensitive'), ' 的合同'],
      ['sensitive_words'],
    ),
    make(
      'cjk.two',
      'cjk_name',
      'recognized',
      [R('张三科技', 'sensitive'), ' 与 ', R('北极星计划', 'sensitive'), ' 立项'],
      ['sensitive_words'],
    ),
    make(
      'cjk.spaced',
      'cjk_name',
      'recognized',
      ['客户 ', R('张 三 科 技', 'sensitive'), ' 的合同'],
      ['sensitive_words'],
    ),
    make(
      'cjk.zero_width',
      'cjk_name',
      'recognized',
      ['客户 ', R('张\u200b三\u2060科技', 'sensitive'), ' 的合同'],
      ['sensitive_words', 'view_normalize'],
      [],
      '零宽字符插在词中间',
    ),
    make(
      'cjk.fullwidth_case',
      'cjk_name',
      'recognized',
      ['co ', R('ＡＣＭＥ　ｃｏｒｐ', 'sensitive'), ' ltd'],
      ['sensitive_words', 'view_normalize'],
      [],
      '全角 + 大小写',
    ),
    make(
      'cjk.case',
      'cjk_name',
      'recognized',
      ['co ', R('ACME CORP', 'sensitive'), ' ltd'],
      ['sensitive_words'],
    ),
    make(
      'cjk.domain.1',
      'cjk_name',
      'recognized',
      ['host a.', R('corp.acme-fake.dev', 'domain'), ' up'],
      ['internal_domains'],
    ),
    make(
      'cjk.domain.2',
      'cjk_name',
      'recognized',
      ['dns ', R('CORP.ACME-FAKE.DEV', 'domain')],
      ['internal_domains'],
    ),
  );

  // ---- 零宽 / 不可见 ----
  const skBody = rep('a1', 22);
  const skFull = `sk-${skBody}`;
  const zw = (s: string, ch: string, at: number): string => s.slice(0, at) + ch + s.slice(at);
  add(
    make(
      'zw.zwsp_in_prefix',
      'zero_width',
      'recognized',
      ['k=', R(zw(skFull, '\u200b', 1), 'api_key')],
      ['prefix_sk', 'view_normalize'],
    ),
    make(
      'zw.zwj_wj_in_body',
      'zero_width',
      'recognized',
      ['k=', R(zw(zw(skFull, '\u200d', 8), '\u2060', 20), 'api_key')],
      ['prefix_sk', 'view_normalize'],
    ),
    make(
      'zw.bom_soft_hyphen',
      'zero_width',
      'recognized',
      ['k=', R(zw(zw(skFull, '\ufeff', 4), '\u00ad', 12), 'api_key')],
      ['prefix_sk', 'view_normalize'],
    ),
    make(
      'zw.bidi',
      'zero_width',
      'recognized',
      ['k=', R(zw(zw(skFull, '\u202e', 2), '\u200f', 10), 'api_key')],
      ['prefix_sk', 'view_normalize'],
    ),
    make(
      'zw.tag_chars',
      'zero_width',
      'recognized',
      [
        '看起来是空的:',
        R(
          [...skFull].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join(''),
          'api_key',
        ),
        ' 结束',
      ],
      ['prefix_sk', 'view_normalize'],
      [],
      'Unicode tag 字符把 ASCII 藏成不可见串',
    ),
  );

  // ---- unicode 折叠:全角、同形字、大小写 ----
  const fullwidth = (s: string): string =>
    [...s]
      .map((c) => (c >= '!' && c <= '~' ? String.fromCodePoint(c.charCodeAt(0) + 0xfee0) : c))
      .join('');
  add(
    make(
      'fold.fullwidth',
      'unicode_fold',
      'recognized',
      ['k=', R(fullwidth(skFull), 'api_key')],
      ['prefix_sk', 'view_normalize'],
    ),
    make(
      'fold.cyrillic_s',
      'unicode_fold',
      'recognized',
      ['k=', R(`\u0455k-${skBody}`, 'api_key')],
      ['prefix_sk', 'view_normalize'],
    ),
    make(
      'fold.greek_k',
      'unicode_fold',
      'recognized',
      ['k=', R(`s\u03ba-${skBody}`, 'api_key')],
      ['prefix_sk', 'view_normalize'],
    ),
    make(
      'fold.upper_prefix',
      'unicode_fold',
      'recognized',
      ['k=', R(`SK-${skBody.toUpperCase()}`, 'api_key')],
      ['prefix_sk'],
    ),
    make(
      'fold.combining_mark',
      'unicode_fold',
      'recognized',
      ['k=', R(`s\u0301k-${skBody}`, 'api_key')],
      ['prefix_sk', 'view_normalize'],
    ),
    make(
      'fold.url_allowlist_homoglyph',
      'unicode_fold',
      'recognized',
      ['go ', R(web('https', 'g\u0456thub.com/org/repo'), 'url')],
      ['url'],
      [],
      '同形字折叠后会命中允许名单:允许名单只认原始字节,所以仍要脱敏(去掉原始字节检查,这个种子会红)',
    ),
  );

  // ---- base64 / hex / 嵌套 ----
  const b64Std = b64(skFull);
  add(
    make(
      'b64.std',
      'base64',
      'recognized',
      ['blob ', R(b64Std, 'api_key'), ' end'],
      ['decode_base64', 'prefix_sk'],
    ),
    make(
      'b64.offset',
      'base64',
      'recognized',
      ['blob ', R(`xy${b64('z:' + skFull)}`, 'api_key'), ' end'],
      ['decode_base64', 'prefix_sk'],
      [],
      '前面多出字符使 4 字符对齐错位',
    ),
    make(
      'b64.wrapped16',
      'base64',
      'recognized',
      [
        'blob: ',
        R(
          b64(skFull)
            .match(/.{1,16}/g)
            ?.join('\n') ?? '',
          'api_key',
        ),
        '\nend',
      ],
      ['decode_base64', 'view_compact', 'prefix_sk'],
      [],
      '折行后每行都不足 20 字符,只有压缩视图能拼回去',
    ),
    make(
      'b64.hex',
      'base64',
      'recognized',
      ['hex ', R(Buffer.from(skFull).toString('hex'), 'api_key')],
      ['decode_hex', 'prefix_sk'],
    ),
    make(
      'b64.nested2',
      'base64',
      'recognized',
      ['blob ', R(b64(b64Std), 'api_key')],
      ['decode_base64', 'prefix_sk'],
      [],
      '两层嵌套:第一遍(深度 2)恰好够',
    ),
    make(
      'b64.base32',
      'base64',
      'recognized',
      ['otp ', R(b32(skFull), 'api_key'), ' end'],
      ['decode_base32', 'prefix_sk'],
    ),
    make(
      'b64.jwt_in_b64',
      'base64',
      'recognized',
      ['blob ', R(b64(`${jwtHead}.${b64url('{"a":1}')}.a1a1a1a1`), 'jwt')],
      ['decode_base64', 'jwt'],
    ),
  );

  // ---- URL 编码 / 转义 ----
  add(
    make(
      'enc.pct_all',
      'url_encoded',
      'recognized',
      ['q=', R(pct(skFull), 'api_key')],
      ['decode_escape', 'prefix_sk'],
    ),
    make(
      'enc.pct_partial',
      'url_encoded',
      'recognized',
      ['q=', R(`sk%2D${skBody}`, 'api_key')],
      ['decode_escape', 'prefix_sk'],
    ),
    make(
      'enc.pct_double',
      'url_encoded',
      'recognized',
      ['q=', R(`sk%252D${skBody}`, 'api_key')],
      ['decode_escape', 'prefix_sk'],
      [],
      '双重编码:%25 解一层变 %2D',
    ),
    make(
      'enc.unicode_escape',
      'url_encoded',
      'recognized',
      ['{"k":"', R(`\\u0073k-${skBody}`, 'api_key'), '"}'],
      ['decode_escape', 'prefix_sk'],
    ),
    make(
      'enc.html_entity',
      'url_encoded',
      'recognized',
      ['<p>', R(`&#115;k-${skBody}`, 'api_key'), '</p>'],
      ['decode_escape', 'prefix_sk'],
    ),
    make(
      'enc.unicode_brace',
      'url_encoded',
      'recognized',
      ['{"k":"', R(`\\u{73}k-${skBody}`, 'api_key'), '"}'],
      ['decode_escape', 'prefix_sk'],
    ),
    make(
      'enc.octal',
      'url_encoded',
      'recognized',
      ['printf "', R(`\\163\\153-${skBody}`, 'api_key'), '"'],
      ['decode_escape', 'prefix_sk'],
    ),
    make(
      'enc.named_entity',
      'url_encoded',
      'recognized',
      ['<p>', R(`sk&#45;${skBody}`, 'api_key'), '</p>'],
      ['decode_escape', 'prefix_sk'],
    ),
  );

  // ---- 分行 / 拼接 ----
  add(
    make(
      'cc.js_plus',
      'concat_multiline',
      'recognized',
      ['const k = "', R(`sk-" + "${skBody.slice(0, 11)}" + "${skBody.slice(11)}`, 'api_key'), '";'],
      ['view_compact', 'prefix_sk'],
    ),
    make(
      'cc.py_adjacent',
      'concat_multiline',
      'recognized',
      ["k = ('", R(`sk-' '${skBody.slice(0, 8)}' '${skBody.slice(8)}`, 'api_key'), "')"],
      ['view_compact', 'prefix_sk'],
    ),
    make(
      'cc.newline',
      'concat_multiline',
      'recognized',
      ['k=', R(`sk-\n${skBody}`, 'api_key'), '\n'],
      ['view_compact', 'prefix_sk'],
    ),
    make(
      'cc.backslash_continuation',
      'concat_multiline',
      'recognized',
      ['k=', R(`sk-\\\n${skBody.slice(0, 9)}\\\n${skBody.slice(9)}`, 'api_key'), '\n'],
      ['view_compact', 'prefix_sk'],
    ),
    make(
      'cc.markdown_quote',
      'concat_multiline',
      'recognized',
      ['> ', R(`sk-\n> ${skBody}`, 'api_key')],
      ['view_compact', 'prefix_sk'],
      [],
      '每行前带引用符的折行',
    ),
    make(
      'cc.hash_comment',
      'concat_multiline',
      'recognized',
      ['# ', R(`sk-\n# ${skBody}`, 'api_key')],
      ['view_compact', 'prefix_sk'],
    ),
    make(
      'cc.slash_comment',
      'concat_multiline',
      'recognized',
      ['// ', R(`sk-\n// ${skBody}`, 'api_key')],
      ['view_compact', 'prefix_sk'],
    ),
    make(
      'cc.array_join',
      'concat_multiline',
      'recognized',
      ['k = ["', R(`sk-", "${skBody}`, 'api_key'), '"].join("")'],
      ['view_compact', 'prefix_sk'],
    ),
    make(
      'cc.pem_split_comment_free',
      'concat_multiline',
      'recognized',
      ['x\n', R(`${pemHead('')}\n${pemBody(2, 'QUJD')}\n${pemFoot('')}`, 'private_key')],
      ['pem_private_key'],
    ),
  );

  // ---- 紧贴 / 内嵌占位符 ----
  add(
    make(
      'ph.adjacent_both',
      'adjacent_placeholder',
      'recognized',
      ['x [[REDACTED:ip]]', R(skFull, 'api_key'), '[[REDACTED:email]] y'],
      ['prefix_sk'],
    ),
    make(
      'ph.inside_pair',
      'adjacent_placeholder',
      'recognized',
      ['[[REDACTED:a]]', R(skFull, 'api_key'), '[[REDACTED:b]]'],
      ['prefix_sk'],
    ),
    make(
      'ph.split_by_placeholder',
      'adjacent_placeholder',
      'recognized',
      ['k=', R(`sk-${skBody.slice(0, 8)}[[REDACTED:x]]${skBody.slice(8)}`, 'api_key')],
      ['prefix_sk'],
      [],
      '秘密被占位符从中间切开:剥离后拼回再扫',
    ),
    make(
      'ph.secret_in_type',
      'adjacent_placeholder',
      'recognized',
      ['[[REDACTED:', R(skFull, 'api_key'), ']]'],
      ['prefix_sk'],
      [],
      '类型位里塞秘密:不是合法占位符,不剥离',
    ),
    make(
      'ph.nested_forged',
      'adjacent_placeholder',
      'recognized',
      ['[[REDACTED:[[REDACTED:ip]]', R(skFull, 'api_key'), ']]'],
      ['prefix_sk'],
    ),
    make(
      'ph.uppercase_forged',
      'adjacent_placeholder',
      'recognized',
      ['[[REDACTED:SECRET]] ', R(skFull, 'api_key')],
      ['prefix_sk'],
    ),
  );

  // ---- 第二遍深度兜底 ----
  {
    // 三层百分号编码:第一遍(转义解码深度 2)还原不到 `sk-`,第二遍(深度 3)可以
    const nested3 = `sk%25252D${skBody}`;
    add({
      id: 'pass2.pct_nested3',
      category: 'url_encoded',
      tier: 'pass2_only',
      input: `q=${nested3} end`,
      expected: undefined,
      needles: [nested3],
      pinned: [],
      note: '三层编码:第一遍(深度 2)漏,第二遍(深度 3)抓;apply 因此 fail-closed(丢整条)',
    });
  }

  // ---- 合法占位符:必须零误杀 ----
  for (const [k, text] of [
    ['single', '运行 [[REDACTED:secret]] 失败'],
    ['multi', 'a [[REDACTED:api_key]] b [[REDACTED:email]] c [[REDACTED:ip]]'],
    ['adjacent', '[[REDACTED:ip]][[REDACTED:email]]'],
    ['in_code', 'const x = "[[REDACTED:url]]"; // [[REDACTED:credential]]'],
    ['underscore_type', 'p [[REDACTED:high_entropy]] q [[REDACTED:feishu_id]]'],
  ] as const) {
    add(unchanged(`legit.${k}`, 'legit_placeholder', 'legit_placeholder', text));
  }

  // ---- 误杀对照:这些都是普通文本,一个字符都不许动 ----
  const sha = g.pick(HEXL, 40);
  const sha256 = g.pick(HEXL, 64);
  const sri = `sha512-${g.pick(`${ALNUM}+/`, 86)}==`;
  for (const [k, text] of [
    [
      'prose_en',
      'The quick brown fox jumps over the lazy dog. Version 2.3.1 shipped on 2026-10-08 at 12:34:56Z.',
    ],
    ['prose_zh', '本轮评审把规则覆盖、占位符绕过和解码深度逐项过了一遍,没有发现需要回退的改动。'],
    ['path', 'edit /Users/someone/workspace/agent-kit-wt/b09/src/redact/rules.ts line 120'],
    ['path_rel', 'see src/redact/engine.ts and test/redact/seeds.test.ts for details'],
    ['git_sha', `commit ${sha} on main`],
    ['sha256_hex', `digest ${sha256}`],
    ['uuid', 'id 3f2b8c1e-9d4a-4e6b-8a1c-0f5d7e2b9a43 created'],
    ['semver', 'upgrade zod 4.6.5 and vitest 5.0.3, node >=22.0.0'],
    ['kebab_slug', 'branch feature/redact-module-implementation-plan-review-round-3'],
    ['package_scope', 'import { x } from "@scope/package-name"; pnpm add @types/node'],
    ['camel', 'call getUserAccountSettingsHandlerFactory and parseResponseBody2'],
    ['sri', `lockfile entry integrity: ${sri}`],
    ['alphabet', `const ALPHABET = '${ALNUM}'; const URLSAFE = '${B64URL}';`],
    ['cli_flags', 'run vitest --run --reporter verbose --timeout 20000 --no-color'],
    ['md_table', '| name | value |\n| --- | --- |\n| tokens | 4096 |\n| max_tokens | 8192 |'],
    ['allowed_url', 'repo https://github.com/anthropics/claude-code/issues/123 is fine'],
    ['reserved_mail', 'contact someone@example.com or ops@host.invalid'],
    ['doc_ip', 'range 192.0.2.10 and 203.0.113.7 are documentation addresses'],
    ['pem_header_only', `the file starts with ${pemHead('RSA ')} and ends with ${pemFoot('RSA ')}`],
    ['jwt_prefix_only', 'tokens start with eyJ and have three dot-separated parts'],
    ['key_names', 'set the api_key and password fields; token: string; secret: required'],
    ['env_ref', 'API_TOKEN=${API_TOKEN} password: process.env.DB_PASSWORD token: $TOKEN'],
    ['code_types', 'interface X { secret_prefixes: string[]; token: Map<string, number>; }'],
  ] as const) {
    add(unchanged(`benign.${k}`, 'benign', 'benign', text));
  }

  // ---- B09b:按名字读取变量(引用)与真值赋值并存 ----
  // 独立的 PRNG:不扰动前面种子的取值
  {
    const gb = makeGen(mulberry32((seed ^ 0xb09b) >>> 0));
    const a = gb.entropic(ALNUM, 24);
    const b = gb.entropic(ALNUM, 32);
    const c = gb.entropic(ALNUM, 40);
    const d = gb.entropic(ALNUM, 28);
    const f = gb.entropic(ALNUM, 26);
    const e = gb.entropic(ALNUM, 36);
    const g = gb.entropic(ALNUM, 30);
    const h = gb.entropic(ALNUM, 34);
    const refName = 'grep \'^FOO_SERVICE_TOKEN=\' "$ENVFILE" | cut -d= -f2-';
    add(
      make(
        'b09b.val.env_random24',
        'plain',
        'recognized',
        ['FOO_SERVICE_TOKEN=', R(a, 'credential'), '\n'],
        ['cred_assign'],
      ),
      make(
        'b09b.val.dquoted',
        'plain',
        'recognized',
        [FDS + '="', R(b, 'credential'), '"'],
        ['cred_assign'],
      ),
      make(
        'b09b.val.json_escaped_quotes',
        'plain',
        'recognized',
        ['"' + FST + '=\\"', R(c, 'credential'), '\\" && run"'],
        ['cred_assign'],
        [],
        'JSON 转义形态:值两侧是 \\" ,替换不能吞掉转义反斜杠',
      ),
      make(
        'b09b.val.export',
        'plain',
        'recognized',
        ['export FOO_SERVICE_TOKEN=', R(d, 'credential')],
        ['cred_assign'],
      ),
      make(
        'b09b.val.authz_bearer_header',
        'plain',
        'recognized',
        ['curl -H "Authorization: Bearer ', R(e, 'credential'), '" https://x.invalid/'],
        ['cred_authz'],
      ),
      make(
        'b09b.val.cli_token_eq',
        'plain',
        'recognized',
        ['tool --' + 'token=', R(f, 'credential'), ' --verbose'],
        [],
        [],
        'cred_assign 与 cred_cli_flag 对 `--token=` 重叠,单独禁用任一条都不变红,所以不钉死规则',
      ),
      make(
        'b09b.val.after_reference_same_line',
        'plain',
        'recognized',
        [`${refName} && export FOO_DASHBOARD_SECRET=`, R(g, 'credential')],
        ['cred_assign'],
        [],
        '同一行先有引用后有真值:引用不豁免后面的真值',
      ),
      make(
        'b09b.val.before_reference_same_line',
        'plain',
        'recognized',
        [FDS + '="', R(h, 'credential'), `"; ${refName}`],
        ['cred_assign'],
      ),
      make(
        'b09b.val.low_entropy_after_name_quote',
        'plain',
        'recognized',
        ["cfg = '^" + FPW + "=' '", R(rep('Ab1', 12), 'credential'), "'"],
        ['cred_assign'],
        [],
        '`^NAME=` 的收尾引号之后是带引号的低熵真值:下一个词不是引用形状,必须脱敏',
      ),
      make(
        'b09b.val.glued_after_name_quote',
        'plain',
        'recognized',
        ["x = 'password='", R(`"${rep('Ab1', 12)}"`, 'credential')],
        ['cred_assign'],
        [],
        '收尾引号紧贴下一段(拼接):不算引用',
      ),
      make(
        'b09b.val.json_newline_boundary',
        'plain',
        'recognized',
        ['API_TOKEN=', R('abc123def456ghi', 'credential'), '\\nnext line'],
        ['cred_assign', 'view_json_ws'],
        [],
        '转义换行(字面反斜杠 n)是值的边界:与真换行同口径',
      ),
    );
    // 引用形态:一个字符都不许动
    for (const [k, text] of [
      ['subst', "T=$(grep '^FOO_SERVICE_TOKEN=' \"$ENVFILE\" | cut -d= -f2- | tr -d '\"')"],
      ['pipe', refName.replace('$ENVFILE', '$f') + ' | tail -1'],
      ['json_escaped', JSON.stringify(refName)],
      [
        'task_escaped',
        "\\\"grep '^FOO_SERVICE_TOKEN=' $ENVFILE | cut -d= -f2- | tr -d \\\\'\\\\\\\"\\\\'\\\"",
      ],
      ['posix_path', "grep '^FOO_SERVICE_TOKEN=' /etc/foo/service.d/prod.env"],
      [
        'placeholder_value',
        'FOO_SERVICE_TOKEN=[[REDACTED:credential]]\nFOO_DASHBOARD_SECRET=[[REDACTED:credential]]',
      ],
      ['placeholder_then_text', 'tool --token=[[REDACTED:credential]] https://x.invalid/'],
      ['placeholder_flag_space', 'tool --token [[REDACTED:credential]] something-else here'],
    ] as const) {
      add(unchanged(`b09b.ref.${k}`, 'benign', 'benign', text));
    }
  }

  // ---- 做不到的形态(只报告,不计入召回) ----
  const hex32 = g.pick(HEXL, 32);
  const lower36 = (() => {
    for (let k = 0; k < 5000; k++) {
      const c = g.pick('abcdefghijklmnopqrstuvwxyz0123456789', 24);
      if (/[0-9]/.test(c) && /[a-z]/.test(c) && shannon(c) < 3.9) return c;
    }
    throw new Error('seed generator: cannot build low-entropy sample');
  })();
  const wrappedChars = [...skFull].map((c) => `<b>${c}</b>`).join('');
  const shards = g.entropic(ALNUM, 36).match(/.{1,6}/g) ?? [];
  const rot = (s: string): string =>
    s.replace(/[a-z]/gi, (c) => {
      const base = c <= 'Z' ? 65 : 97;
      return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
    });
  add(
    gap(
      'gap.bare_hex32',
      'plain',
      `key ${hex32} end`,
      [hex32],
      '裸 32/64 位十六进制与 git sha 无法区分;靠上下文规则(赋值/头)抓,不靠熵',
    ),
    gap(
      'gap.lower36_24',
      'plain',
      `k ${lower36} end`,
      [lower36],
      '24 位小写字母数字随机串的熵常低于 4.0,抓不到(见 docs/redaction.md §8)',
    ),
    gap(
      'gap.shards6',
      'concat_multiline',
      `parts: ${shards.map((s) => `"${s}"`).join(' ')}`,
      shards,
      '任意切碎(每片 <24 字符且无前缀)只能靠熵,而每片熵不够',
    ),
    gap('gap.rot13', 'plain', `k ${rot(skFull)}`, [rot(skFull)], '换位/移位编码不解码'),
    gap(
      'gap.reversed',
      'plain',
      `k ${[...skFull].reverse().join('')}`,
      [[...skFull].reverse().join('')],
      '反序不识别',
    ),
    gap(
      'gap.concat_call',
      'concat_multiline',
      `k = 'sk-'.concat('${skBody}')`,
      [skBody],
      '函数调用式拼接(.concat( / format):压缩视图只认引号、加号、逗号、反斜杠和换行',
    ),
    gap(
      'gap.template_interp',
      'concat_multiline',
      `k = \`\${'sk-'}\${'${skBody}'}\``,
      [skBody],
      '模板字符串插值拼接',
    ),
    gap(
      'gap.spaced_b64_groups',
      'base64',
      `blob ${(b64(skFull).match(/.{1,4}/g) ?? []).join(' ')}`,
      [],
      'base64 按 4 字符一组用空格隔开:空格不属于压缩视图的分隔串',
    ),
    gap(
      'gap.char_codes',
      'plain',
      `codes ${[...skFull].map((c) => c.charCodeAt(0)).join(',')}`,
      [],
      '十进制字符码序列(fromCharCode 列表)不解码',
    ),
    gap(
      'gap.tag_wrapped_chars',
      'concat_multiline',
      `k ${wrappedChars}`,
      [wrappedChars],
      '字符间夹着标记/注释等非空白字符,压缩视图拼不回',
    ),
    gap(
      'gap.word_after_name_quote',
      'plain',
      "cfg = '^" + FPW + "=' 'correcthorse'",
      ['correcthorse'],
      '`NAME=` 收尾引号之后的纯小写单词(<=12 字符)按引用放行,与 gap.word_password 同源',
    ),
    gap(
      'gap.authz_value_ends_with_brace',
      'plain',
      `${AZ}: Digest response="${rep('a1', 8)}" {`,
      [rep('a1', 8)],
      'cred_authz 的值以 `{` `(` `[` 结尾时按代码形状放行(B09b 之前就存在,未改动)',
    ),
    gap(
      'gap.word_password',
      'plain',
      'password: correcthorse',
      ['correcthorse'],
      '纯小写单词口令(<=12 字符)被当成普通单词放行',
    ),
    gap(
      'gap.pct_nested4',
      'url_encoded',
      `q=sk%2525252D${skBody}`,
      [],
      '四层编码超出第二遍的深度上限(3)',
    ),
    gap(
      'gap.obfuscated_at',
      'plain',
      'mail jane dot doe at acme-fake dot dev',
      [],
      '"at/dot" 文字化的邮箱不识别',
    ),
  );
  return out;
}

export const SEED_CATEGORIES: readonly SeedCategory[] = [
  'plain',
  'adjacent_placeholder',
  'base64',
  'concat_multiline',
  'url_encoded',
  'zero_width',
  'cjk_name',
  'legit_placeholder',
  'unicode_fold',
  'benign',
];
