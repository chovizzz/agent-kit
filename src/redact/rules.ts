/**
 * 第一/二遍共用的规则表。
 *
 * 设计约束(见 docs/redaction.md):
 *  - JS 的 RegExp 是回溯引擎,又不能被抢占(本仓 lint 禁 worker_threads),所以每条规则必须是**线性**写法:
 *    无嵌套量词;不用"前置 [..]* 再找关键词";失败路径的回溯量有常数上界;需要"先找锚点再向两侧有界扩展"的(email、PEM、JWT)手写扫描。
 *  - 规则的来源:自有规则为主,密钥前缀参考 gitleaks v8.30.1(blob 256f647…)的 id 与形态,正则文本自写
 *    (gitleaks 为 MIT,Copyright (c) 2019 Zachary Rice;见 docs/spikes/gitleaks.md)。
 *  - 规则 id 是变异自检的粒度:`--selftest --mutate` 逐条禁用,必须有种子变红。
 */
import { shannon } from './entropy.js';
import { buildView, safeLower } from './view.js';
import type { ResolvedConfig, Rule, ScanEnv } from './types.js';

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

/** 跑一条全局正则;零长匹配推进 lastIndex;热循环里查时钟。 */
function eachMatch(re: RegExp, text: string, env: ScanEnv, fn: (m: RegExpExecArray) => void): void {
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    env.deadline.tick();
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    fn(m);
  }
}

function groupSpan(m: RegExpExecArray): [number, number] | null {
  const ind = (m as RegExpExecArray & { indices?: Array<[number, number] | undefined> }).indices;
  if (!ind) return null;
  for (let g = 1; g < ind.length; g++) {
    const r = ind[g];
    if (r) return [r[0], r[1]];
  }
  return null;
}

const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isAlpha = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isAlnum = (c: number): boolean => isDigit(c) || isAlpha(c);

function hasDigitAndLetter(s: string): { digit: boolean; letter: boolean } {
  let digit = false;
  let letter = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isDigit(c)) digit = true;
    else if (isAlpha(c)) letter = true;
    if (digit && letter) break;
  }
  return { digit, letter };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// 已知密钥前缀表(每行一条独立规则,id = prefix_<name>)
// ---------------------------------------------------------------------------

export interface PrefixSpec {
  name: string;
  /** 前缀的正则源码(会放在左边界之后) */
  prefix: string;
  /** 体的字符类(带方括号) */
  body: string;
  min: number;
  /** 体长恰为 min(固定长度的密钥) */
  exact?: boolean;
  needDigit?: boolean;
  /** 种子生成用:一个字面前缀样例(不含体) */
  lit: string;
  /** 种子生成用:体字符样例(交替重复生成低熵体,保证只有本规则能抓) */
  sample: string;
}

export const PREFIX_TABLE: readonly PrefixSpec[] = [
  {
    name: 'sk',
    prefix: 'sk-',
    body: '[A-Za-z0-9_-]',
    min: 20,
    needDigit: true,
    lit: 'sk-',
    sample: 'a1',
  },
  { name: 'soh', prefix: 'soh_', body: '[A-Za-z0-9]', min: 16, lit: 'soh_', sample: 'a1' },
  {
    name: 'soh_svc',
    prefix: 'soh_svc_',
    body: '[A-Za-z0-9_]',
    min: 16,
    lit: 'soh_svc_',
    sample: 'a1',
  },
  { name: 'ghp', prefix: 'ghp_', body: '[A-Za-z0-9]', min: 30, lit: 'ghp_', sample: 'a1' },
  { name: 'gho', prefix: 'gho_', body: '[A-Za-z0-9]', min: 30, lit: 'gho_', sample: 'a1' },
  { name: 'ghu', prefix: 'ghu_', body: '[A-Za-z0-9]', min: 30, lit: 'ghu_', sample: 'a1' },
  { name: 'ghs', prefix: 'ghs_', body: '[A-Za-z0-9]', min: 30, lit: 'ghs_', sample: 'a1' },
  { name: 'ghr', prefix: 'ghr_', body: '[A-Za-z0-9]', min: 30, lit: 'ghr_', sample: 'a1' },
  {
    name: 'github_pat',
    prefix: 'github_pat_',
    body: '[A-Za-z0-9_]',
    min: 50,
    lit: 'github_pat_',
    sample: 'a1',
  },
  {
    name: 'aws_akia',
    prefix: 'AKIA',
    body: '[0-9A-Z]',
    min: 16,
    exact: true,
    lit: 'AKIA',
    sample: 'A1',
  },
  {
    name: 'aws_asia',
    prefix: 'ASIA',
    body: '[0-9A-Z]',
    min: 16,
    exact: true,
    lit: 'ASIA',
    sample: 'A1',
  },
  {
    name: 'slack_xox',
    prefix: 'xox[abeprs]-',
    body: '[A-Za-z0-9-]',
    min: 10,
    lit: 'xoxb-',
    sample: 'a1',
  },
  {
    name: 'slack_xapp',
    prefix: 'xapp-',
    body: '[A-Za-z0-9-]',
    min: 10,
    lit: 'xapp-',
    sample: 'a1',
  },
  {
    name: 'google_aiza',
    prefix: 'AIza',
    body: '[0-9A-Za-z_-]',
    min: 35,
    exact: true,
    lit: 'AIza',
    sample: 'a1',
  },
  {
    name: 'google_ya29',
    prefix: 'ya29\\.',
    body: '[A-Za-z0-9_-]',
    min: 20,
    lit: 'ya29.',
    sample: 'a1',
  },
  {
    name: 'google_refresh',
    prefix: '1//0',
    body: '[A-Za-z0-9_-]',
    min: 30,
    lit: '1//0',
    sample: 'a1',
  },
  { name: 'gitlab', prefix: 'glpat-', body: '[A-Za-z0-9_-]', min: 20, lit: 'glpat-', sample: 'a1' },
  { name: 'npm', prefix: 'npm_', body: '[A-Za-z0-9]', min: 36, lit: 'npm_', sample: 'a1' },
  { name: 'pypi', prefix: 'pypi-', body: '[A-Za-z0-9_-]', min: 50, lit: 'pypi-', sample: 'a1' },
  { name: 'huggingface', prefix: 'hf_', body: '[A-Za-z]', min: 30, lit: 'hf_', sample: 'ab' },
  {
    name: 'shopify',
    prefix: 'shp(?:at|ss|ca|pa)_',
    body: '[a-f0-9]',
    min: 32,
    lit: 'shpat_',
    sample: 'a1',
  },
  {
    name: 'stripe',
    prefix: '[spr]k_(?:live|test)_',
    body: '[A-Za-z0-9]',
    min: 16,
    lit: 'rk_live_',
    sample: 'a1',
  },
  {
    name: 'stripe_whsec',
    prefix: 'whsec_',
    body: '[A-Za-z0-9]',
    min: 24,
    lit: 'whsec_',
    sample: 'a1',
  },
  {
    name: 'linear',
    prefix: 'lin_api_',
    body: '[A-Za-z0-9]',
    min: 30,
    lit: 'lin_api_',
    sample: 'a1',
  },
  { name: 'notion_ntn', prefix: 'ntn_', body: '[A-Za-z0-9]', min: 30, lit: 'ntn_', sample: 'a1' },
  {
    name: 'notion_secret',
    prefix: 'secret_',
    body: '[A-Za-z0-9]',
    min: 40,
    needDigit: true,
    lit: 'secret_',
    sample: 'a1',
  },
  {
    name: 'sendgrid',
    prefix: 'SG\\.[A-Za-z0-9_-]{16}\\.',
    body: '[A-Za-z0-9_-]',
    min: 16,
    lit: 'SG.a1a1a1a1a1a1a1a1.',
    sample: 'a1',
  },
  { name: 'twilio', prefix: 'SK', body: '[0-9a-f]', min: 32, exact: true, lit: 'SK', sample: 'a1' },
  {
    name: 'mailgun',
    prefix: 'key-',
    body: '[0-9a-f]',
    min: 32,
    exact: true,
    lit: 'key-',
    sample: 'a1',
  },
  { name: 'xai', prefix: 'xai-', body: '[A-Za-z0-9]', min: 40, lit: 'xai-', sample: 'a1' },
  { name: 'groq', prefix: 'gsk_', body: '[A-Za-z0-9]', min: 40, lit: 'gsk_', sample: 'a1' },
  { name: 'perplexity', prefix: 'pplx-', body: '[A-Za-z0-9]', min: 40, lit: 'pplx-', sample: 'a1' },
  { name: 'replicate', prefix: 'r8_', body: '[A-Za-z0-9]', min: 30, lit: 'r8_', sample: 'a1' },
  {
    name: 'firecrawl',
    prefix: 'fc-',
    body: '[a-f0-9]',
    min: 32,
    exact: true,
    lit: 'fc-',
    sample: 'a1',
  },
  {
    name: 'digitalocean',
    prefix: 'dop_v1_',
    body: '[a-f0-9]',
    min: 40,
    lit: 'dop_v1_',
    sample: 'a1',
  },
];

function prefixRule(spec: PrefixSpec): Rule {
  const quant = spec.exact ? `{${spec.min}}(?![A-Za-z0-9])` : `{${spec.min},}`;
  const re = new RegExp(`(?<![A-Za-z0-9])${spec.prefix}${spec.body}${quant}`, 'gi');
  const quickLit = spec.lit.toLowerCase();
  return {
    id: `prefix_${spec.name}`,
    type: 'api_key',
    prio: 80,
    compact: true,
    quick: [quickLit.slice(0, Math.min(quickLit.length, 3))],
    scan(text, _lower, push, env) {
      eachMatch(re, text, env, (m) => {
        if (spec.needDigit) {
          const body = m[0].slice(spec.lit.length);
          if (!hasDigitAndLetter(body).digit) return;
        }
        push(m.index, m.index + m[0].length);
      });
    },
  };
}

function extraPrefixRule(prefix: string, idx: number): Rule {
  const re = new RegExp(`(?<![A-Za-z0-9])${escapeRe(prefix)}[A-Za-z0-9_-]{12,}`, 'gi');
  return {
    id: `prefix_extra_${idx}`,
    type: 'api_key',
    prio: 80,
    compact: true,
    quick: [prefix.toLowerCase().slice(0, 3)],
    scan(text, _lower, push, env) {
      eachMatch(re, text, env, (m) => push(m.index, m.index + m[0].length));
    },
  };
}

// ---------------------------------------------------------------------------
// PEM / JWT(手写扫描,避免 [\s\S]*? 与长 run 上的二次回溯)
// ---------------------------------------------------------------------------

const PEM_HEADER = /-----BEGIN (?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?-----/y;
const PEM_FOOTER = /-----END (?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?-----/y;
const PEM_MAX_BODY = 16384;
const PEM_MIN_B64 = 32;

function isB64(c: number): boolean {
  return isAlnum(c) || c === 43 || c === 47;
}

const pemRule: Rule = {
  id: 'pem_private_key',
  type: 'private_key',
  prio: 100,
  compact: true,
  quick: ['-----begin'],
  scan(text, _lower, push, env) {
    const n = text.length;
    let from = 0;
    let noFooterAfter = Infinity; // 此位置之后已确认没有 -----END
    for (;;) {
      const i = text.indexOf('-----BEGIN', from);
      if (i === -1) return;
      env.deadline.tick();
      PEM_HEADER.lastIndex = i;
      const h = PEM_HEADER.exec(text);
      if (!h) {
        from = i + 10;
        continue;
      }
      const bodyStart = i + h[0].length;
      let footerAt = -1;
      if (bodyStart < noFooterAfter) {
        footerAt = text.indexOf('-----END', bodyStart);
        if (footerAt === -1) noFooterAfter = bodyStart;
      }
      let end: number;
      let b64 = 0;
      if (footerAt !== -1 && footerAt - bodyStart <= PEM_MAX_BODY) {
        for (let k = bodyStart; k < footerAt; k++) if (isB64(text.charCodeAt(k))) b64++;
        PEM_FOOTER.lastIndex = footerAt;
        const f = PEM_FOOTER.exec(text);
        end = footerAt + (f ? f[0].length : 8);
      } else if (env.compactView) {
        // 压缩视图里没有行结构,无页脚的截断块只在原视图里按行识别
        from = i + 10;
        continue;
      } else {
        // 没有页脚(被截断):头部行之后按行吃 base64 行(及紧跟头部的 `Key: value` 字段行),
        // 遇到第一行不是 base64 的就停,不能把后面的正文吃掉
        const nl = text.indexOf('\n', bodyStart);
        let k = nl === -1 ? n : nl + 1;
        let last = bodyStart;
        let fields = 0;
        const cap = Math.min(n, bodyStart + PEM_MAX_BODY);
        while (k < cap) {
          let lineEnd = text.indexOf('\n', k);
          if (lineEnd === -1) lineEnd = n;
          let stop = lineEnd;
          if (stop > k && text.charCodeAt(stop - 1) === 13) stop--;
          const line = text.slice(k, stop);
          if (/^[A-Za-z0-9+/=]{4,}$/.test(line)) {
            b64 += line.length;
            last = k + line.length;
          } else if (b64 === 0 && fields < 3 && /^[A-Za-z][A-Za-z-]{2,20}: /.test(line)) {
            fields++;
          } else if (!(b64 === 0 && line === '')) break;
          k = lineEnd + 1;
        }
        end = last;
      }
      if (b64 >= PEM_MIN_B64) {
        push(i, end);
        from = Math.max(end, i + 10);
      } else {
        from = i + 10; // 只有头部行(文档里的示例):不算
      }
    }
  },
};

function isB64Url(c: number): boolean {
  return isAlnum(c) || c === 45 || c === 95;
}

const jwtRule: Rule = {
  id: 'jwt',
  type: 'jwt',
  prio: 90,
  compact: true,
  quick: ['eyj'],
  scan(text, _lower, push, env) {
    const n = text.length;
    let from = 0;
    for (;;) {
      const i = text.indexOf('eyJ', from);
      if (i === -1) return;
      env.deadline.tick();
      let j = i + 3;
      while (j < n && isB64Url(text.charCodeAt(j))) j++;
      // 头部 run 在 j 结束;run 内部任何位置的 eyJ 也会在同一个 j 结束,所以整段跳过
      if (text.charCodeAt(j) === 46 && j - i >= 11) {
        let k = j + 1;
        while (k < n && isB64Url(text.charCodeAt(k))) k++;
        if (k - (j + 1) >= 8) {
          let end = k;
          if (text.charCodeAt(k) === 46) {
            end = k + 1;
            while (end < n && isB64Url(text.charCodeAt(end))) end++;
          }
          push(i, end);
          from = end;
          continue;
        }
      }
      from = j;
    }
  },
};

// ---------------------------------------------------------------------------
// webhook / 飞书
// ---------------------------------------------------------------------------

function simpleRegexRule(
  id: string,
  type: string,
  prio: number,
  compact: boolean,
  quick: readonly string[] | undefined,
  re: RegExp,
  validate?: (m: RegExpExecArray) => boolean,
): Rule {
  return {
    id,
    type,
    prio,
    compact,
    ...(quick ? { quick } : {}),
    scan(text, _lower, push, env) {
      eachMatch(re, text, env, (m) => {
        if (validate && !validate(m)) return;
        const g = re.hasIndices ? groupSpan(m) : null;
        if (g) push(g[0], g[1]);
        else push(m.index, m.index + m[0].length);
      });
    },
  };
}

const webhookFeishu = simpleRegexRule(
  'webhook_feishu',
  'webhook',
  85,
  false,
  ['open-apis/bot'],
  /https?:\/\/open\.(?:feishu\.cn|larksuite\.com|larksuite\.cn|feishu-boe\.cn)\/open-apis\/bot\/(?:v2\/)?hook\/[A-Za-z0-9-]{8,}/gi,
);
const webhookSlack = simpleRegexRule(
  'webhook_slack',
  'webhook',
  85,
  false,
  ['hooks.slack.com'],
  /https?:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9/_-]{8,}/gi,
);
const webhookDiscord = simpleRegexRule(
  'webhook_discord',
  'webhook',
  85,
  false,
  ['/webhooks/'],
  /https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[A-Za-z0-9_-]{16,}/gi,
);
const webhookTelegram = simpleRegexRule(
  'webhook_telegram',
  'webhook',
  85,
  false,
  ['api.telegram.org'],
  /https?:\/\/api\.telegram\.org\/bot\d{6,}:[A-Za-z0-9_-]{20,}/gi,
);
const feishuId = simpleRegexRule(
  'feishu_id',
  'feishu_id',
  75,
  true,
  ['oc_', 'ou_', 'on_', 'cli_'],
  /(?<![A-Za-z0-9])(?:o[cun]_[0-9a-f]{32}|cli_[0-9a-z]{16})(?![A-Za-z0-9])/g,
);
const feishuToken = simpleRegexRule(
  'feishu_token',
  'token',
  75,
  true,
  undefined,
  /(?<![A-Za-z0-9])[tua]-[A-Za-z0-9]{30,}/g,
  (m) => {
    const h = hasDigitAndLetter(m[0].slice(2));
    return h.digit && h.letter;
  },
);
const zhipuKey = simpleRegexRule(
  'zhipu_key',
  'api_key',
  80,
  true,
  undefined,
  /(?<![0-9a-f])[0-9a-f]{32}\.[A-Za-z0-9]{16}(?![A-Za-z0-9])/g,
);
const telegramBot = simpleRegexRule(
  'telegram_bot_token',
  'api_key',
  80,
  true,
  undefined,
  /(?<![A-Za-z0-9])\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g,
);

// ---------------------------------------------------------------------------
// 凭据赋值 / 头
// ---------------------------------------------------------------------------

const NON_SECRET_START =
  /^(?:\$|<|\{\{|%|\[\[REDACTED|process\.env|os\.environ|os\.getenv|env\.|ENV\[|getenv|config\.|settings\.|secrets\.|vault|\.\.\.|None$|null$|undefined$|true$|false$)/i;
const MASK = /^[*xX•#._-]{4,}$/;
const CALL_CHAIN = /^[A-Za-z_$][\w$.]*\(.*\)[;,]?$/;
const PLAIN_WORD = /^[a-z][a-z-]{0,11}$/;
/** `string[];` `string):` `Record<string,string>,` 这类类型标注/形参残片 */
const CODE_SHAPE =
  /^[A-Za-z_$][\w$.]*\(|^[A-Za-z_$][\w$.]*(?:\[\]|<[^>]*>)?[)\];,:]+$|^[A-Za-z_$][\w$.]*(?:\[\]|<[^>]*>)[)\];,:]*$|^[A-Za-z_$][\w$.]*<[^>]*$|[({[]$/;

/** 值是不是"明显不是秘密"(变量引用、遮蔽、布尔、函数调用、单个小写词)。 */
export function looksNonSecret(v: string): boolean {
  return (
    NON_SECRET_START.test(v) ||
    MASK.test(v) ||
    CALL_CHAIN.test(v) ||
    PLAIN_WORD.test(v) ||
    CODE_SHAPE.test(v)
  );
}

const KW =
  '(?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|auth[_-]?key|private[_-]?key|credentials?)';
const credAssign = simpleRegexRule(
  'cred_assign',
  'credential',
  70,
  false,
  ['pass', 'pwd', 'secret', 'token', 'key', 'credential'],
  new RegExp(
    `${KW}(?:[_-][A-Za-z0-9_-]{1,16}|(?:key|id|value|secret|token|hash))?["']?[ \\t]{0,8}(?::=|=>|:|=)[ \\t]{0,8}(?:"([^"\\r\\n]{8,})"?|'([^'\\r\\n]{8,})'?|([^\\s"'\`]{8,}))`,
    'gid',
  ),
  (m) => !looksNonSecret((m[1] ?? m[2] ?? m[3]) as string),
);

const credCliFlag = simpleRegexRule(
  'cred_cli_flag',
  'credential',
  70,
  false,
  ['--'],
  /--(?:password|passwd|passphrase|token|secret|api-key|apikey|access-token|auth-token|client-secret|private-key)(?:=|[ \t]{1,8})(?:"([^"\r\n]{4,})"?|'([^'\r\n]{4,})'?|([^\s"'`-][^\s"'`]{3,}))/dgi,
  (m) => !looksNonSecret((m[1] ?? m[2] ?? m[3]) as string),
);

const credBearer = simpleRegexRule(
  'cred_bearer',
  'token',
  70,
  false,
  ['bearer'],
  /bearer[ \t]{1,8}([A-Za-z0-9._~+/=-]{16,})/dgi,
  (m) => {
    const v = m[1] as string;
    return hasDigitAndLetter(v).digit || shannon(v) >= 4.0;
  },
);

const credBasic = simpleRegexRule(
  'cred_basic',
  'credential',
  70,
  false,
  ['basic'],
  /basic[ \t]{1,8}([A-Za-z0-9+/]{12,}={0,2})/dgi,
  (m) => {
    try {
      const d = Buffer.from(m[1] as string, 'base64').toString('latin1');
      return d.includes(':') && /^[\x20-\x7e]+$/.test(d);
    } catch {
      return false;
    }
  },
);

const AUTH_SCHEME_ONLY = /^(?:bearer|basic|token|digest|negotiate|aws4-hmac-sha256)\s*$/i;

const credAuthz = simpleRegexRule(
  'cred_authz',
  'credential',
  70,
  false,
  ['authorization'],
  /authorization["']?[ \t]{0,8}[:=][ \t]{0,8}["']?(?:(?:bearer|basic|token|digest|negotiate|aws4-hmac-sha256)[ \t]+)?(?![ \t])((?:=(?:"[^"\r\n]*"|'[^'\r\n]*')|[^\r\n"']){8,})/dgi,
  (m) => !looksNonSecret(m[1] as string) && !AUTH_SCHEME_ONLY.test(m[1] as string),
);

const credCookie = simpleRegexRule(
  'cred_cookie',
  'credential',
  70,
  false,
  ['cookie'],
  /(?:^|[\r\n])[ \t]*(?:set-)?cookie[ \t]{0,4}:[ \t]{0,4}(?![ \t])([^\r\n]{12,})/dgim,
  (m) => !looksNonSecret(m[1] as string),
);

const urlUserinfo = simpleRegexRule(
  'url_userinfo',
  'credential',
  65,
  false,
  ['://'],
  /:\/\/[^\s/@:]{0,64}:([^\s/@]{3,})@/dg,
);

// ---------------------------------------------------------------------------
// 高熵串
// ---------------------------------------------------------------------------

const SRI_LEN: Readonly<Record<string, number>> = { sha1: 28, sha256: 44, sha384: 64, sha512: 88 };
const SRI = /^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/i;
const INTEGRITY_BEFORE = /integrity["']?[ \t]{0,4}[:=][ \t]{0,4}["']?$/i;

export const ENTROPY_MIN_LEN = 24;
export const ENTROPY_MIN_BITS = 4.0;

/** 路径/包名:`scope/package-name`、`a/b/c/d`。每段都是小写词+连字符的才算。 */
function pathLike(token: string): boolean {
  if (!token.includes('/')) return false;
  const segs = token.split('/').filter((s) => s.length > 0);
  if (segs.length < 2) return false;
  let wordy = 0;
  for (const s of segs) if (/^[a-z][a-z0-9_.-]+$/.test(s) && !/[0-9]{3,}/.test(s)) wordy++;
  return segs.length === 2 ? wordy === 2 : wordy / segs.length >= 0.6;
}

/** 纯十六进制(git sha、md5、32/64 位 hex):与密钥无法区分,靠上下文规则(赋值/头)抓,不靠熵。 */
const HEX_ONLY = /^[0-9a-fA-F]+$/;
/** lowerCamel / PascalCase 标识符(可带尾部数字) */
const CAMEL = /^(?:[a-z]+(?:[A-Z][a-z]+)+|(?:[A-Z][a-z]+)+)[0-9]*$/;

/** 字母表/连号序列(abc…xyz、ABC…、0123…):相邻字符多数是"前一个 +1"。随机串里这种相邻对只有约 1/62。 */
function sequential(token: string): boolean {
  let up = 0;
  for (let i = 1; i < token.length; i++)
    if (token.charCodeAt(i) - token.charCodeAt(i - 1) === 1) up++;
  return up / (token.length - 1) >= 0.6;
}

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);

/** 用连字符/下划线/点拼起来的英文词(slug、包名、标识符):多数字母落在"像单词"的小写片段里。 */
function proseLike(token: string): boolean {
  const pieces = token.split(/[-_./]/);
  if (pieces.length < 3) return false;
  let total = 0;
  let wordy = 0;
  for (const p of pieces) {
    const letters = p.replace(/[0-9]/g, '');
    total += letters.length;
    if (letters.length < 3 || /[A-Z]/.test(letters)) continue;
    let v = 0;
    for (const ch of letters) if (VOWELS.has(ch)) v++;
    if (v / letters.length >= 0.25) wordy += letters.length;
  }
  return total > 0 && wordy / total >= 0.6;
}

const highEntropy: Rule = {
  id: 'high_entropy',
  type: 'high_entropy',
  prio: 20,
  compact: false,
  scan(text, _lower, push, env) {
    eachMatch(/[A-Za-z0-9+/_-]{24,}={0,2}/g, text, env, (m) => {
      const token = m[0];
      const { digit, letter } = hasDigitAndLetter(token);
      if (!digit || !letter) return;
      if (shannon(token) < ENTROPY_MIN_BITS) return;
      if (HEX_ONLY.test(token) || CAMEL.test(token) || sequential(token)) return;
      if (pathLike(token) || proseLike(token)) return;
      const sri = SRI.exec(token);
      if (sri && (SRI_LEN[(sri[1] as string).toLowerCase()] ?? -1) === (sri[2] as string).length) {
        if (INTEGRITY_BEFORE.test(text.slice(Math.max(0, m.index - 24), m.index))) return;
      }
      push(m.index, m.index + token.length);
    });
  },
};

// ---------------------------------------------------------------------------
// IP / 邮箱 / URL
// ---------------------------------------------------------------------------

const OCT = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const DOT = '(?:\\.|\\[\\.\\]|\\(\\.\\)|\\[dot\\])';
const ipv4 = simpleRegexRule(
  'ipv4',
  'ip',
  50,
  false,
  undefined,
  new RegExp(`(?<![\\d.])${OCT}(?:${DOT}${OCT}){3}(?!\\d|\\.\\d)`, 'gi'),
  // RFC 5737 文档专用网段不可能是真实主机
  (m) => !/^(?:192\.0\.2|198\.51\.100|203\.0\.113)\./.test(m[0]),
);
const ipv6 = simpleRegexRule(
  'ipv6',
  'ip',
  50,
  false,
  [':'],
  /(?<![\w:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:fe80|fd[0-9a-f]{2}):(?:[0-9a-f]{0,4}:){1,6}[0-9a-f]{0,4})(?![\w:])/gi,
);

/** RFC 2606 / 6761 保留名:不可能是真实地址,文档与测试里可以放心出现。 */
export function isReservedDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return (
    d === 'example.com' ||
    d === 'example.org' ||
    d === 'example.net' ||
    d.endsWith('.example.com') ||
    d.endsWith('.example.org') ||
    d.endsWith('.example.net') ||
    d === 'localhost' ||
    /(?:^|\.)(?:invalid|test|example|localhost)$/.test(d)
  );
}

const isLocalChar = (c: number): boolean =>
  isAlnum(c) || c === 46 || c === 95 || c === 37 || c === 43 || c === 45;
const isDomainChar = (c: number): boolean => isAlnum(c) || c === 46 || c === 45;
const DOMAIN_OK = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const TLD_OK = /^[A-Za-z]{2,}$/;

const emailRule: Rule = {
  id: 'email',
  type: 'email',
  prio: 50,
  compact: false,
  quick: ['@'],
  scan(text, _lower, push, env) {
    const n = text.length;
    for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
      env.deadline.tick();
      let s = at;
      while (s > 0 && at - s < 64 && isLocalChar(text.charCodeAt(s - 1))) s--;
      if (s === at) continue;
      let e = at + 1;
      while (e < n && e - at < 256 && isDomainChar(text.charCodeAt(e))) e++;
      while (e > at + 1 && (text.charCodeAt(e - 1) === 46 || text.charCodeAt(e - 1) === 45)) e--;
      const domain = text.slice(at + 1, e);
      if (!DOMAIN_OK.test(domain)) continue;
      const tld = domain.slice(domain.lastIndexOf('.') + 1);
      if (!TLD_OK.test(tld)) continue;
      if (isReservedDomain(domain)) continue;
      push(s, e);
    }
  },
};

const URL_RE =
  /(?:https?|wss?|s?ftp|ssh|git|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?|smb|ldaps?):\/\/[^\s<>"'`^|{}\\]+/gi;
const TRAIL = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}', '>', '*']);

/** 从 URL 文本里取主机(小写、去端口与结尾点);带 userinfo 返回 null 表示"不可信"。 */
export function urlHost(url: string): { host: string; userinfo: boolean } | null {
  const i = url.indexOf('://');
  if (i === -1) return null;
  let rest = url.slice(i + 3);
  const cut = rest.search(/[/?#\\]/);
  if (cut !== -1) rest = rest.slice(0, cut);
  const userinfo = rest.includes('@');
  if (userinfo) rest = rest.slice(rest.lastIndexOf('@') + 1);
  let host = rest;
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    host = close === -1 ? host : host.slice(0, close + 1);
  } else {
    const colon = host.lastIndexOf(':');
    if (colon !== -1 && /^\d*$/.test(host.slice(colon + 1))) host = host.slice(0, colon);
  }
  try {
    host = decodeURIComponent(host);
  } catch {
    /* 保留原样 */
  }
  host = host.toLowerCase().replace(/\.+$/, '');
  return { host, userinfo };
}

export function normalizeAllowedHost(h: string): string {
  return buildView(h.trim())
    .text.toLowerCase()
    .replace(/^\*?\./, '')
    .replace(/\.+$/, '');
}

function hostAllowed(host: string, allowed: readonly string[]): boolean {
  for (const a of allowed) if (host === a || host.endsWith(`.${a}`)) return true;
  return false;
}

function urlRule(cfg: ResolvedConfig): Rule {
  const allowed = cfg.allowed_url_hosts.map(normalizeAllowedHost).filter((h) => h.length > 0);
  return {
    id: 'url',
    type: 'url',
    prio: 40,
    compact: false,
    quick: ['://'],
    scan(text, _lower, push, env) {
      eachMatch(URL_RE, text, env, (m) => {
        let url = m[0];
        while (url.length > 0 && TRAIL.has(url[url.length - 1] as string)) url = url.slice(0, -1);
        const parsed = urlHost(url);
        if (!parsed || parsed.host === '') return;
        if (!parsed.userinfo && isReservedDomain(parsed.host)) return;
        const start = m.index;
        const end = m.index + url.length;
        let ok = !parsed.userinfo && hostAllowed(parsed.host, allowed);
        // 允许名单只认原始字节:归一化折叠(同形字、全角、零宽)改变过这个 URL 的,一律不放行
        if (ok && env.rawSlice(start, end) !== url) ok = false;
        if (!ok) push(start, end);
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 覆盖层词表(敏感词、内部域名)
// ---------------------------------------------------------------------------

const WS_AND_JOIN = /[\s"'`+\\,|]+/g;

export function foldWord(w: string): string {
  return safeLower(buildView(w).text);
}

function wordsRule(id: string, type: string, words: readonly string[]): Rule | null {
  const normal: string[] = [];
  const compact: string[] = [];
  for (const w of words) {
    const f = foldWord(w);
    if (f.length === 0) continue;
    normal.push(f);
    const c = f.replace(WS_AND_JOIN, '');
    if (c.length > 0) compact.push(c);
  }
  if (normal.length === 0) return null;

  const search = (
    hay: string,
    list: readonly string[],
    map: Int32Array | null,
    push: (s: number, e: number) => void,
    env: ScanEnv,
  ): void => {
    for (const w of list) {
      env.deadline.check();
      for (let i = hay.indexOf(w); i !== -1; i = hay.indexOf(w, i + w.length)) {
        env.deadline.tick();
        const e = i + w.length;
        if (map) push(map[i] as number, (map[e - 1] as number) + 1);
        else push(i, e);
      }
    }
  };

  return {
    id,
    type,
    prio: 60,
    compact: true,
    scan(_text, lower, push, env) {
      if (env.compactView) {
        search(lower, compact, null, push, env);
        return;
      }
      search(lower, normal, null, push, env);
      // 词被空白切开("张 三 科 技"):在去掉全部空白的副本上再找一遍,命中区间映射回视图坐标
      if (/\s/.test(lower)) {
        const idx: number[] = [];
        const kept: string[] = [];
        for (let k = 0; k < lower.length; k++) {
          const c = lower.charCodeAt(k);
          if (c === 32 || (c >= 9 && c <= 13) || c === 0xa0) continue;
          kept.push(lower[k] as string);
          idx.push(k);
        }
        search(kept.join(''), compact, Int32Array.from(idx), push, env);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 规则表
// ---------------------------------------------------------------------------

export function buildRules(cfg: ResolvedConfig): Rule[] {
  const rules: Rule[] = [
    pemRule,
    jwtRule,
    ...PREFIX_TABLE.map(prefixRule),
    ...cfg.extra_secret_prefixes.map((p, i) => extraPrefixRule(p, i)),
    webhookFeishu,
    webhookSlack,
    webhookDiscord,
    webhookTelegram,
    feishuId,
    feishuToken,
    zhipuKey,
    telegramBot,
    credAssign,
    credCliFlag,
    credBearer,
    credBasic,
    credAuthz,
    credCookie,
    urlUserinfo,
    highEntropy,
    ipv4,
    ipv6,
    emailRule,
    urlRule(cfg),
  ];
  const words = wordsRule('sensitive_words', 'sensitive', cfg.sensitive_words);
  if (words) rules.push(words);
  const domains = wordsRule('internal_domains', 'domain', cfg.internal_domains);
  if (domains) rules.push(domains);
  const seen = new Set<string>();
  for (const r of rules) {
    if (seen.has(r.id)) throw new Error(`duplicate rule id ${r.id}`);
    seen.add(r.id);
  }
  return rules;
}

/** 阶段(不是规则,但同样可被变异自检禁用)。 */
export const STAGE_IDS = [
  'view_normalize',
  'view_compact',
  'decode_base64',
  'decode_base32',
  'decode_hex',
  'decode_escape',
] as const;
