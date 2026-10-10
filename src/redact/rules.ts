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
import { PLACEHOLDER_SOURCE } from '../contracts/redact.js';
import { shannon } from './entropy.js';
import { buildView, safeLower } from './view.js';
import { MAX_PLACEHOLDER_TYPE } from './types.js';
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
  validate?: (m: RegExpExecArray, env: ScanEnv) => boolean,
  valueClass = false,
): Rule {
  return {
    id,
    type,
    prio,
    compact,
    ...(valueClass ? { valueClass } : {}),
    ...(quick ? { quick } : {}),
    scan(text, _lower, push, env) {
      eachMatch(re, text, env, (m) => {
        if (validate && !validate(m, env)) return;
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

// ---------------------------------------------------------------------------
// 「值是不是引用」判据(B09c)
//
// 脱敏是信任边界:判据是**白名单**,不匹配任何一种引用形态就当口令脱敏。引用形态必须是**整词**
// (不是前缀),并且不能同时是一个像样的口令——带数字的标识符段、混合大小写 + 数字的 `$xxx` 都不算引用。
// ---------------------------------------------------------------------------

const MASK = /^[*xX•#._-]{4,}$/;
const LITERAL = /^(?:none|null|undefined|true|false|nil)$/i;
const PLAIN_WORD = /^[a-z][a-z-]{0,11}$/;
const PH_WHOLE = /^\[\[REDACTED:[a-z_]{1,24}\]\]$/;
/** 名字段:UPPER_SNAKE(可带数字),或只含字母 / 下划线(不带数字——带数字的段更像口令)。 */
const NAME = '(?:[A-Z]+|[A-Z][A-Z0-9]*_[A-Z0-9_]*|[A-Za-z_]+)';
/** 环境变量名风格的大写名:纯大写字母,或带下划线的 UPPER_SNAKE。大写 + 数字而没有下划线的(`ABC123XYZ9`)更像口令,不算。 */
const UPPER_ENV = /^(?:[A-Z]+|[A-Z][A-Z0-9]*_[A-Z0-9_]*)$/;
/** 环境变量访问(区分大小写、整词);`[` `(` 之后可以是被引号截断的残片。 */
const ENV_ACCESS = new RegExp(
  `^(?:process\\.env|import\\.meta\\.env|Deno\\.env(?:\\.get)?|os\\.environ(?:\\.get)?|os\\.getenv|System\\.getenv|getenv|ENV(?:\\.fetch)?|environ)(?:(?:\\.${NAME})+|[\\[(](?:${NAME})?[\\])]*)?$`,
);
/** 配置对象的属性路径:`config.dbPassword` `env.DB_PASSWORD`。 */
const PROP_PATH = new RegExp(`^(?:env|config|settings|secrets|vault)(?:\\.${NAME})+$`);
const ANGLE = /^<[A-Za-z][A-Za-z_-]*>$/;
/** 以未闭合括号结尾的代码残片(`, R(` `' + rep(`):不含数字与引号,口令里不会有这种形状。 */
const OPEN_CODE = /^[A-Za-z_$.,+\-*/ ]*[({[]$/;
/** 模板串里被引号截断的表达式:`${placeholder(` `${a.b[`。 */
const OPEN_TEMPLATE = /^\$\{[A-Za-z_][A-Za-z_.]*[([]?$/;
const TEMPLATE = /^\{\{-?[A-Za-z_][A-Za-z_. |-]*-?\}\}$/;
const PERCENT = /^(?:%(?:[A-Z]+|[A-Z][A-Z0-9]*_[A-Z0-9_]*)%|%\([a-z_]+\)s|%[sd])$/;

const TYPE_BASE: ReadonlySet<string> = new Set([
  'string', 'str', 'number', 'int', 'integer', 'float', 'double', 'bool', 'boolean', 'bytes',
  'byte', 'object', 'any', 'unknown', 'void', 'never', 'Buffer', 'Record', 'Map', 'Set',
  'Array', 'Promise', 'Optional', 'List', 'Dict', 'Sequence', 'Iterable', 'SecretStr',
  'String', 'Number', 'Boolean', 'Object', 'Any', 'Secret', 'Uint8Array',
]); // prettier-ignore

/** 类型标注:`string[]` `Map<string,` `Optional[str]`。其后只允许类型括号 / 逗号 / 同集合的词,不得含数字。 */
function typeish(s: string): boolean {
  const m = /^([A-Za-z_][\w$.]*)(.*)$/s.exec(s);
  if (!m || !TYPE_BASE.has(m[1] as string)) return false;
  const rest = m[2] as string;
  if (!/^[A-Za-z_.,<>[\]?| ]*$/.test(rest)) return false;
  for (const w of rest.match(/[A-Za-z_]+/g) ?? []) {
    if (!TYPE_BASE.has(w) && !PLAIN_WORD.test(w)) return false;
  }
  return true;
}

const CALL_VERB =
  /^(?:get|read|load|fetch|resolve|lookup|find|prompt|input|ask|decrypt|generate|gen|random|make|create|build|parse|retrieve|getenv|getpass|environ)(?:[A-Z_]|$)/;
const CALL_ARG = /^(?:|\$?(?:[A-Z]+|[A-Z][A-Z0-9]*_[A-Z0-9_]*)|\$?[A-Za-z_][A-Za-z_.]*)$/;

/**
 * 调用:`X(y)` 形状**不**自动放行。callee 路径不含数字,并且:没有参数 / 未闭合(`createToken(`),
 * 或最后一段以「取值类动词」开头(getToken / read_secret / os.getenv)且参数是单个无数字标识符 / UPPER_SNAKE / `$VAR`。
 */
function harmlessCall(s: string): boolean {
  const i = s.indexOf('(');
  if (i <= 0) return false;
  const callee = s.slice(0, i);
  if (!/^[A-Za-z_$][A-Za-z_$.]*$/.test(callee)) return false;
  const args = s.slice(i + 1).replace(/\)+$/, '');
  // 无参数 / 未闭合(`createToken(` `build()`):没有口令可藏,callee 本身不带数字即可
  if (args === '') return true;
  const last = callee.slice(callee.lastIndexOf('.') + 1);
  return CALL_VERB.test(last) && CALL_ARG.test(args);
}

/**
 * 变量引用,按运算符语境:`${NAME}` 任何语境;`$UPPER_SNAKE` / `$lowerword`(只有字母下划线、无数字)/
 * `$(命令` 只在 shell 语境(`=` `:=`)——yaml / ini 里的 `$` 是字面字符。不带路径后缀(`$HOME/<口令>`)。
 */
function varRef(s: string, shell: boolean): boolean {
  if (!s.startsWith('$')) return false;
  if (/^\$\{[A-Za-z_]\w*\}$/.test(s) || OPEN_TEMPLATE.test(s)) return true;
  if (!shell) return false;
  if (/^\$[A-Za-z_]\w*$/.test(s)) {
    const name = s.slice(1);
    return UPPER_ENV.test(name) || /^[A-Za-z_]+$/.test(name);
  }
  return /^\$\([A-Za-z_][A-Za-z_./-]*\)?$/.test(s);
}

/** 旧判据(B09b 及之前),只为变异自检保留:对应阶段被禁用时退回这些宽松放行。 */
const LEGACY_NON_SECRET_START =
  /^(?:\$|<|\{\{|%|\[\[REDACTED|process\.env|os\.environ|os\.getenv|env\.|ENV\[|getenv|config\.|settings\.|secrets\.|vault|\.\.\.|None$|null$|undefined$|true$|false$)/i;
const LEGACY_CALL_CHAIN = /^[A-Za-z_$][\w$.]*\(.*\)[;,]?$/;
const LEGACY_CODE_SHAPE =
  /^[A-Za-z_$][\w$.]*\(|^[A-Za-z_$][\w$.]*(?:\[\]|<[^>]*>)?[)\];,:]+$|^[A-Za-z_$][\w$.]*(?:\[\]|<[^>]*>)[)\];,:]*$|^[A-Za-z_$][\w$.]*<[^>]*$|[({[]$/;

/**
 * 模板串里的变量展开(B09d):`${seed?.input` `${seeds[0]?.input}` `${a.b}`。只认**标识符 / 成员链 / 数字下标**:
 * 标识符只含字母下划线(带数字的段更像口令);不认任何运算符(`:-` `+` `|` `?? 'x'` 之后的部分本来就不在这个词里)、
 * 引号、括号调用。`${X:-口令}` `${'口令'}` `${a + 'x'}` 因此都不是引用。收尾的 `}` 可有可无(词可能停在空白处)。
 */
const TEMPLATE_EXPR = /^\$\{[A-Za-z_][A-Za-z_]*(?:\??\.[A-Za-z_][A-Za-z_]*|\??\[\d{1,3}\])*\}?$/;
/** 旧的宽松放行(B09c 及之前):任何以 `${` 开头的词。只为变异自检保留。 */
const LEGACY_TEMPLATE = /^\$\{/;

/**
 * zod / 类型声明里的链式构造(B09d):`z.array(z.string().min(1)).default([])`。整词必须是
 * `z.<构造>(<参数>)(.<方法>(<参数>))*`,构造与方法名取封闭集合,参数只能是 数字 / `[]` / `{}` / true|false|null|undefined /
 * 纯小写词 / 纯大写常量名 / 嵌套的同类链(深度 ≤ 3)。参数里出现数字夹字母、混合大小写、引号(引号本来就会截断这个词)
 * 都不认:`z.string().max(Zk9fQx…)` 仍是口令。
 */
const ZOD_CTOR =
  '(?:array|string|number|boolean|object|enum|literal|union|record|unknown|any|date|bigint|tuple|map|set|strictObject|looseObject|nativeEnum|lazy|optional|nullable|int|uuid|email|url|never|null|undefined)';
const ZOD_METHOD =
  '(?:min|max|length|default|optional|nullable|nullish|int|positive|negative|nonnegative|nonempty|trim|lowercase|uppercase|email|url|uuid|describe|array|or|and)';
const ZOD_ATOM =
  '(?:\\d{1,6}|\\[\\]|\\{\\}|true|false|null|undefined|[a-z][a-z_]{0,31}|[A-Z][A-Z_]{0,31})';
function zodChain(arg: string): string {
  const args = `(?:${arg}(?:,${arg})*)?`;
  return `z\\.${ZOD_CTOR}\\(${args}\\)(?:\\.${ZOD_METHOD}\\(${args}\\))*`;
}
/** 链的最后一个调用没闭合(`z.string().default(`:后面是引号,词被引号截断):参数里的字面量由「引用之后的默认值字面量」另外判。 */
function zodChainOpen(arg: string): string {
  const args = `(?:${arg}(?:,${arg})*)?`;
  return `z\\.${ZOD_CTOR}(?:\\(${args}\\)(?:\\.${ZOD_METHOD}\\(${args}\\))*\\.${ZOD_METHOD})?\\(`;
}
const ZOD_ARG = `(?:${ZOD_ATOM}|${zodChain(`(?:${ZOD_ATOM}|${zodChain(ZOD_ATOM)})`)})`;
const ZOD_CHAIN = new RegExp(`^(?=.{1,200}$)(?:${zodChain(ZOD_ARG)}|${zodChainOpen(ZOD_ARG)})$`);
/** 旧的宽松放行:`z.xxx(` 开头的任何词。只为变异自检保留。 */
const LEGACY_ZOD = /^z\.[A-Za-z]+\(/;

/** 引用核:去掉尾部标点之后剩下的部分是不是一种引用形态。 */
function refCore(s: string, shell: boolean): boolean {
  if (s === '') return true;
  return (
    MASK.test(s) ||
    LITERAL.test(s) ||
    PH_WHOLE.test(s) ||
    PLAIN_WORD.test(s) ||
    varRef(s, shell) ||
    ENV_ACCESS.test(s) ||
    PROP_PATH.test(s) ||
    typeish(s) ||
    harmlessCall(s) ||
    ANGLE.test(s) ||
    OPEN_CODE.test(s) ||
    TEMPLATE.test(s) ||
    PERCENT.test(s)
  );
}

export interface ValueVerdict {
  /** 是口令(应脱敏) */
  secret: boolean;
  /** 脱敏范围的长度:值去掉尾部标点后的核心(尾部标点留在输出里,不破坏语法) */
  coreLen: number;
}

const NO_DISABLED: ReadonlySet<string> = new Set();
export const STAGE_REF_TAIL = 'ref_tail_punct';
export const STAGE_REF_BOUNDARY = 'ref_boundary';
export const STAGE_REF_FLAG = 'ref_flag_strict';
export const STAGE_PLACEHOLDER = 'placeholder_boundary';
export const STAGE_REF_TEMPLATE = 'ref_template_strict';
export const STAGE_REF_ZOD = 'ref_zod_strict';

/**
 * 判一个无引号值。尾部标点先剥掉再判:候选 c1=去 `;,:`、c2=再去 `)]}`、c3=再去 `({[`,
 * **任一**候选是引用核就放行(`string[];` `getToken(x);`);全都不是 => 口令,脱敏 c3(核心)。
 * 引用核是封闭集合里的整词形态,标识符本身(像口令的 `Hunter2…`)不在其中,所以「口令 + 标点」不会被放行。
 */
export function judgeValue(
  v: string,
  shell: boolean,
  disabled: ReadonlySet<string> = NO_DISABLED,
): ValueVerdict {
  let e1 = v.length;
  while (e1 > 0 && ';,:\\'.includes(v[e1 - 1] as string)) e1--;
  let e2 = e1;
  while (e2 > 0 && ';,:\\)]}'.includes(v[e2 - 1] as string)) e2--;
  let e3 = e2;
  while (e3 > 0 && ';,:\\)]}({['.includes(v[e3 - 1] as string)) e3--;
  const cands = new Set<string>([v, v.slice(0, e1), v.slice(0, e2), v.slice(0, e3)]);
  for (const c of cands) {
    if (refCore(c, shell)) return { secret: false, coreLen: e3 };
    if (disabled.has(STAGE_REF_TEMPLATE) ? LEGACY_TEMPLATE.test(c) : TEMPLATE_EXPR.test(c))
      return { secret: false, coreLen: e3 };
    if (disabled.has(STAGE_REF_ZOD) ? LEGACY_ZOD.test(c) : ZOD_CHAIN.test(c))
      return { secret: false, coreLen: e3 };
  }
  if (disabled.has(STAGE_REF_TAIL) && (LEGACY_CODE_SHAPE.test(v) || LEGACY_CALL_CHAIN.test(v)))
    return { secret: false, coreLen: e3 };
  if (disabled.has(STAGE_REF_BOUNDARY) && LEGACY_NON_SECRET_START.test(v))
    return { secret: false, coreLen: e3 };
  return { secret: true, coreLen: e3 };
}

/** 值是不是"明显不是秘密"(变量引用、遮蔽、布尔、类型名、取值类调用、单个小写词)。shell 语境。 */
export function looksNonSecret(v: string): boolean {
  return !judgeValue(v, true).secret;
}

/** 运算符是 shell / makefile 的赋值(`$lowerword` `$(cmd)` 是引用),yaml / json 的 `:` 不是。 */
const isShellOp = (op: string): boolean => op === '=' || op === ':=';

const KW =
  // B09d-P1(§7 缺口收敛):补 db_pass/pw 已有、passcode/requirepass 与四个高频中文键名。
  // 中文只收四个高频词(密码/口令/密钥/令牌),且规则要求键名后紧跟操作符,误杀面有限。
  '(?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|auth[_-]?key|private[_-]?key|credentials?|db[_-]?pass(?:word)?|passcode|requirepass|密码|口令|密钥|令牌)';
/** 键名后缀(`_prod` `-v2` 或 key/id/value…)与引号 / 空白的上限:对齐排版的 `db_password      = …` 也要认。 */
const SFX = '(?:[_-][A-Za-z0-9_-]{1,40}|(?:key|id|value|secret|token|hash))?';
const SP = '[ \\t]{0,32}';

/**
 * 分组:1=操作符,2=双引号值(值长度 >= 8 由代码判),3=其中的反斜杠串(原子化用,不读),4=单引号值,5=无引号值。
 * 双引号值里的反斜杠串用「前瞻捕获 + 反向引用」模拟原子组:一次吃掉整串,不在串内回溯(二次增长)。
 * 值之前的空白允许 `key = value`;被拒绝的匹配不再吞掉后文(见 scan 里的 lastIndex 回退)。
 */
const CRED_ASSIGN_RE = new RegExp(
  `${KW}${SFX}(?:\\\\*["'])?${SP}(:=|=>|:|=)${SP}(?:\\\\*"((?:[^"\\\\\\r\\n]|(?=(\\\\+))\\3(?!"))*)(?:\\\\*")?|'([^'\\r\\n]{8,})'?|(?!\\\\+')([^\\s"'\`]+)|\\\\+'((?:[^'\\\\\\r\\n]|(?=(\\\\+))\\7(?!'))*)(?:\\\\+')?)`,
  'gid',
);

/** 引用式候选:`NAME=` 之后紧跟一个(可带转义反斜杠的)引号;键名与 `=` 之间不许有引号。是否真的是引用由 quotedNameRef 判。 */
const NAME_EQ_QUOTE_RE = new RegExp(`${KW}${SFX}=(\\\\*["'])`, 'gi');

const PLACEHOLDER_RE = new RegExp(
  PLACEHOLDER_SOURCE.replace('[a-z_]+', `[a-z_]{1,${MAX_PLACEHOLDER_TYPE}}`),
  'g',
);

/** `$VAR` / `${VAR}`(可带路径后缀)。**不是**任意以 `$` 开头的串:`$Up3r…` 这类可能是口令本身。 */
const VAR_REF = /^\$(?:\{[A-Za-z_]\w*\}|[A-Za-z_]\w*)(?:[\\/][\w.@+~\\/-]*)?$/;
/** 路径:有根标记(`/` `~/` `./` `../` `C:\` `\\`)且至少两段,每段只含 `[\w.@+~-]`。 */
const PATH_REF =
  /^(?:[A-Za-z]:[\\/]+|\\\\|~[\\/]+|\.{1,2}[\\/]+|[\\/]+)(?:[\w.@+~-]+[\\/]+)+[\w.@+~-]+[\\/]*$/;
/** 文件名:封闭的扩展名集合(`.env` 本身也算)。 */
const FILE_REF =
  /^[\w.@+~-]*\.(?:env|json|txt|ya?ml|conf|cfg|ini|log|sh|toml|pem|key|properties|secrets?|local|sample|example|bak)$|^[\w.@+~-]*\.env\.[\w-]+$/i;
/** 旧的命令行选项判据(B09b 及之前),只为变异自检保留。 */
const LEGACY_FLAG_REF = /^--?[A-Za-z][\w-]*(?:=\S*)?$/;

/**
 * 命令行选项:`-d` `--no-color` `--color=never`。长选项名只认小写 kebab(`--Hunter2…` 不算),
 * 短选项只认 1-2 个字母或 `-f2-` 形;`--x=值` 的值部分要重新判(数字 / 引用才放行)。
 */
function isFlagRef(w: string, disabled: ReadonlySet<string>): boolean {
  if (disabled.has(STAGE_REF_FLAG) && LEGACY_FLAG_REF.test(w)) return true;
  const m = /^(--?)([A-Za-z][\w-]*)(?:=([\s\S]*))?$/.exec(w);
  if (!m) return false;
  const name = m[2] as string;
  const nameOk =
    m[1] === '--'
      ? /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)
      : /^[A-Za-z]{1,2}$|^[A-Za-z]\d+-?$/.test(name);
  if (!nameOk) return false;
  const v = m[3];
  return v === undefined || v === '' || /^\d{1,6}$/.test(v) || isReferenceWord(v, disabled);
}

/**
 * 「值之前紧跟的是引用而不是值」场景下,下一个词是不是引用。**白名单**:不匹配任何一种形状就一律当值脱敏
 * (不看熵、字符类:低熵口令恰恰是最危险的)。形状 = 强上下文里本来就放行的那些(judgeValue,但以 `$` `%` `<` `{`
 * 开头的词不走宽松放行),加变量引用 / 路径 / 文件名 / 选项。
 */
export function isReferenceWord(w: string, disabled: ReadonlySet<string> = NO_DISABLED): boolean {
  if (w === '') return true;
  if (VAR_REF.test(w)) return true;
  if (PATH_REF.test(w) || FILE_REF.test(w) || isFlagRef(w, disabled)) return true;
  return !/^[$%<{]/.test(w) && !judgeValue(w, true, disabled).secret;
}

const NAME_CHAR = /[\w.^|(-]/;
const TERMINATOR = /[\s|;&<>)]/;
/** 为判断开引号的奇偶,最多回看这么多字符;回看不完就不认引用式(多脱敏的方向)。 */
const QUOTE_LOOKBACK = 4096;

interface QuotedNameRef {
  /** 收尾引号之后的位置 */
  after: number;
}

type Range = [number, number];

/** ranges 按起点升序、互不嵌套(值区间):p 是否落在某个区间里。 */
function inRanges(ranges: readonly Range[], p: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid] as Range;
    if (p < r[0]) hi = mid - 1;
    else if (p >= r[1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/** [from, end) 内、同一行里、转义反斜杠数恰为 bs 的引号 qc 的个数;excl 里的位置(将被脱敏的值内部)不计。 */
function countQuotes(
  text: string,
  from: number,
  end: number,
  qc: string,
  bs: number,
  excl: readonly Range[],
): number {
  let count = 0;
  for (let p = from; p < end; p++) {
    if (text[p] !== qc) continue;
    if (excl.length > 0 && inRanges(excl, p)) continue;
    let b = 0;
    while (p - 1 - b >= from && text.charCodeAt(p - 1 - b) === 92) b++;
    if (b === bs) count++;
  }
  return count;
}

/** 位置 i 所在行的行首;回看超过 QUOTE_LOOKBACK 返回 -1。 */
function lineStartOf(text: string, i: number): number {
  let ls = i;
  while (ls > 0 && text.charCodeAt(ls - 1) !== 10) {
    ls--;
    if (i - ls > QUOTE_LOOKBACK) return -1;
  }
  return ls;
}

/**
 * 引用式:`'^NAME='` `"^NAME="`(含 JSON 转义的 `\"^NAME=\"`)。`=` 之后紧跟的引号是**收尾**引号,
 * 它的开引号在键名之前。三个条件缺一不可,否则按赋值处理(在 `'x'NAME=` 后面
 * 再跟一段带引号的值时,`NAME` 前的引号是 `'x'` 的收尾,奇偶校验会拦下它):
 *  - 开引号与键名之间只有 `[\w.^|(-]`(无空白、无别的引号;键名与 `=` 之间也不能有引号——`"NAME"="…` 里的引号是键名自己的),且转义反斜杠数与收尾引号一致;
 *  - 同一行里该开引号之前、同种同转义深度的引号个数为偶数(**将被脱敏的值内部的引号不计**:
 *    第二遍里那些值已经是占位符,两遍的奇偶判定因此一致);
 *  - 收尾引号之后是行尾 / 空白 / `| ; & < > )`。
 */
function quotedNameRef(
  text: string,
  keyStart: number,
  opEnd: number,
  excl: readonly Range[],
  strict = true,
): QuotedNameRef | null {
  let j = opEnd;
  while (text.charCodeAt(j) === 92) j++;
  const qc = text[j];
  if (qc !== '"' && qc !== "'") return null;
  const bs = j - opEnd;
  const after = j + 1;
  const nc = text[after];
  if (strict && nc !== undefined && !TERMINATOR.test(nc) && !endsJsonString(text, after))
    return null;
  let i = keyStart - 1;
  for (let steps = 0; i >= 0 && steps < 96 && NAME_CHAR.test(text[i] as string); steps++) i--;
  if (i < 0 || text[i] !== qc) return null;
  let k = i - 1;
  let obs = 0;
  while (k >= 0 && text.charCodeAt(k) === 92) {
    obs++;
    k--;
  }
  if (obs !== bs) return null;
  if (!strict) return { after }; // 只看结构(开引号紧贴键名),不数奇偶
  // 同一行、同种同转义深度的引号在开引号之前出现偶数次
  const lineStart = lineStartOf(text, i);
  if (lineStart < 0) return null;
  return countQuotes(text, lineStart, i, qc, bs, excl) % 2 === 0 ? { after } : null;
}

/** 从 pos 起(可有若干转义反斜杠)是 JSON 字符串的收尾引号。 */
function endsJsonString(text: string, pos: number): boolean {
  let q = pos;
  while (text.charCodeAt(q) === 92) q++;
  return text[q] === '"' && jsonStringEnd(text, q);
}

/** `"` 之后是行尾 / 空白 / `, } ] :`:JSON 字符串的收尾引号(命令被整段放进 JSON 字符串的情形)。 */
function jsonStringEnd(text: string, quotePos: number): boolean {
  const c = text[quotePos + 1];
  return c === undefined || /[\s,}\]:]/.test(c);
}

/** 一段区域里最多逐个判断多少个词(再多的不判,保持线性)。 */
const MAX_UNITS = 64;
/** 单个词里最多剥这么多个外围收尾字符(每次剥都要数括号,不设上限会二次增长)。 */
const MAX_TRIM = 64;
/** 找收尾引号 / 行尾的窗口(超出的当作没找到,与旧的「<= 512 字符」一致)。 */
const UNIT_WINDOW = 513;

interface Unit {
  /** 核心区间(去掉两侧引号与转义反斜杠) */
  s: number;
  e: number;
  /** 下一个词从这里开始找 */
  next: number;
}

/**
 * 读一个词(shell 意义上的一个参数):以引号开头的取到同种引号,否则取到空白 / `| ; & < >`。
 * 返回核心区间与下一个词的起点。所有向前查找都限制在窗口 / 词内,单个词的代价与词长成正比。
 */
function readUnit(text: string, p: number): Unit {
  const n = text.length;
  let s = p;
  while (s < n && text.charCodeAt(s) === 92) s++;
  const q = text[s];
  let e: number;
  let next: number;
  if (q === '"' || q === "'") {
    s++;
    const win = text.slice(s, s + UNIT_WINDOW);
    const close = win.indexOf(q);
    const eol = win.indexOf('\n');
    if (close !== -1 && (eol === -1 || close < eol)) {
      e = s + close;
      next = e + 1;
    } else {
      e = next = wordEnd(text, s);
    }
  } else {
    s = p;
    e = wordEnd(text, s);
    // 无引号的词里碰到 JSON 字符串的收尾引号就在此截断;引号紧贴着别的字符(拼接)则不截,整词参与判断
    const dq = text.slice(s, e).indexOf('"');
    if (dq !== -1 && jsonStringEnd(text, s + dq)) e = s + dq;
    next = e;
  }
  for (let trim = 0; trim < MAX_TRIM; trim++) {
    const c = text[e - 1] as string;
    if (e <= s || !/[\\'"`),;\]}]/.test(c)) break;
    // `}` 只在没有与之配对的 `{` 时才算外围的收尾(`${NAME}` 里的不能剥)
    if (c === '}' && countChar(text, s, e, '{') >= countChar(text, s, e, '}')) break;
    e--;
  }
  while (s < e && /[\\'"`]/.test(text[s] as string)) s++;
  return { s, e, next };
}

/**
 * 引用式收尾引号之后、同一条命令(到 `| ; & < > )` / 换行 / JSON 字符串收尾为止)里的各个词。
 * 不是引用形状的词(长度 >= 8)返回其区间,由调用方脱敏。命令替换(`$(…)` 或反引号开头)不整体放行,
 * 逐个判断里面的词:`$(echo 口令)` 里的口令要脱敏,`$(cat /etc/foo/x)` 里全是引用形状才放行。
 */
function valueWordsAfter(
  text: string,
  from: number,
  disabled: ReadonlySet<string>,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const n = text.length;
  let p = from;
  for (let units = 0; units < MAX_UNITS; units++) {
    while (p < n && (text[p] === ' ' || text[p] === '\t')) p++;
    if (p >= n || /[\n\r|;&<>),}\]]/.test(text[p] as string) || endsJsonString(text, p)) break;
    const u = readUnit(text, p);
    if (u.next <= p) break;
    p = u.next;
    if (u.e - u.s < 8) continue;
    const w = text.slice(u.s, u.e);
    if (/^\$\(|^`/.test(w)) {
      for (const m of w.matchAll(/[^\s()'"`;|&<>]+/g)) {
        const tok = m[0].replace(/\\+$/, '');
        if (tok.length >= 8 && !isReferenceWord(tok, disabled)) {
          out.push([u.s + (m.index ?? 0), u.s + (m.index ?? 0) + tok.length]);
        }
      }
      continue;
    }
    if (!isReferenceWord(w, disabled)) out.push([u.s, u.e]);
  }
  return out;
}

function countChar(text: string, s: number, e: number, ch: string): number {
  let n = 0;
  for (let i = s; i < e; i++) if (text[i] === ch) n++;
  return n;
}

function wordEnd(text: string, from: number): number {
  let e = from;
  while (e < text.length && !/[\s|;&<>)]/.test(text[e] as string)) e++;
  return e;
}

/**
 * 操作符与值之间(原文里)夹着合法占位符:
 *  - 值紧贴占位符(占位符后面没有任何间隔)→ 'tight':后面的字符仍是值的一部分,按赋值处理;
 *  - 占位符与值起点之间有间隔:间隔以空白开头 → 'occupied'(值的位置被占位符占了,后面的词是别的东西:`名字=占位符 https://…`);
 *    间隔以引号开头 → 引号后面是边界(空白 / 行尾 / 分隔符)才是 'occupied'(`"NAME=占位符" && …`);引号后面紧跟值字符
 *    是拼接或新值的开引号 → 'tight',后面的值照常脱敏(第一遍可能只脱敏了拼接值的前一截:`NAME=占位符"口令"`);
 *    其余 → 'tight'(fail-closed)。
 */
function placeholderGap(
  text: string,
  env: ScanEnv,
  _keyStart: number,
  opEnd: number,
  anchor: number,
): 'none' | 'tight' | 'occupied' {
  if (anchor < opEnd) return 'none';
  const raw = env.rawSlice(opEnd - 1, anchor + 1);
  if (!raw.includes('[[')) return 'none';
  let lastEnd = -1;
  PLACEHOLDER_RE.lastIndex = 0;
  for (let m = PLACEHOLDER_RE.exec(raw); m !== null; m = PLACEHOLDER_RE.exec(raw)) {
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd === -1) return 'none';
  const gap = raw.slice(lastEnd, raw.length - 1);
  if (env.disabled.has(STAGE_PLACEHOLDER)) {
    // 旧判据(B09b):间隔多于一个字符一律 occupied
    if (raw.length - lastEnd > 1) return 'occupied';
    return /^(?:\s|\\+["'])/.test(text.slice(anchor, anchor + 12)) ? 'occupied' : 'tight';
  }
  if (gap === '') {
    // 占位符后面是空白(含视图里还原出来的 JSON 转义换行)或 JSON 转义的引号(`\\"`):行 / 字符串的边界,不是值的延续
    return /^(?:\s|\\+["'])/.test(text.slice(anchor, anchor + 12)) ? 'occupied' : 'tight';
  }
  if (/^\s/.test(gap)) return 'occupied';
  const q = /^(\\*)(["'])/.exec(gap);
  if (!q) return 'tight';
  // 引号后面紧跟边界(空白 / 行尾 / 分隔符):它是收尾引号,值的位置仍被占着;紧跟值字符:拼接或新值的开引号,按赋值处理
  return /[\s|;&<>),}\]:]/.test(text[anchor] ?? ' ') ? 'occupied' : 'tight';
}

// ---------------------------------------------------------------------------
// 引用之后的默认值字面量(取环境变量的调用参数、`|| "默认值"`)
// ---------------------------------------------------------------------------

/** 找字符串字面量的窗口:到 `;` / 行尾 / 配平的 `)` 为止,最多这么多字符。 */
const TRAILING_WINDOW = 256;
const STAGE_TRAILING = 'ref_trailing_literal';
const DEFAULT_OP = /^[ \t]*(?:\|\||\?\?|\bor\b|:-|\|)/;
/** 环境变量名本身(UPPER_SNAKE)是引用,不是口令。 */
const ENV_NAME = UPPER_ENV;

/**
 * 值被判为引用(`os.getenv(` `process.env.X` `$(echo`)之后,同一条语句里还可能有引号字面量:
 * 调用的参数(默认值)、`|| "默认"`、命令替换里的词。其中长度 >= 8 且不是引用核 / 环境变量名的一律脱敏。
 * 只在「值停在未闭合的 `(` `[`」、「后面紧跟默认值运算符」、「值是 `$(…`」三种情形下才扫,避免把无关的后文吞进来。
 */
function trailingLiterals(
  text: string,
  valEnd: number,
  val: string,
  core: string,
  shell: boolean,
  disabled: ReadonlySet<string>,
  origView = false,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const opensCall = /[(,]\\*$/.test(val) || (/\[$/.test(val) && ENV_ACCESS.test(core));
  // 模板展开 `${…` 在词里没有闭合:展开式里的字面量(`${a + '口令'}`)另外判,到配平的 `}` 为止
  const opensTemplate = val.startsWith('${') && !val.includes('}');
  let tail = text.slice(valEnd, valEnd + TRAILING_WINDOW);
  // 原视图补扫:转义的 `\n` `\r` 是语句边界
  if (origView) {
    const cut = ESC_NL.exec(tail);
    if (cut) tail = tail.slice(0, cut.index);
  }
  // 只在「值是取环境变量 / 调用 / 命令替换」或后面紧跟默认值运算符时扫:整条语句里的字面量都看(三元、`??` `or` 都算)
  if (
    !opensCall &&
    !opensTemplate &&
    !DEFAULT_OP.test(tail) &&
    !/^\$\(/.test(val) &&
    !ENV_ACCESS.test(core)
  )
    return out;
  let depth = opensCall ? 1 : 0;
  for (let i = 0; i < tail.length && out.length < 16; i++) {
    const c = tail[i] as string;
    if (c === '\n' || c === '\r' || c === ';') break;
    if (opensTemplate && c === '}') break;
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth < 0) break;
    } else if (c === '\\' && (tail[i + 1] === '"' || tail[i + 1] === "'")) {
      continue; // JSON 转义的引号:下一轮按引号处理
    } else if (c === '"' || c === "'" || c === '`') {
      const close = tail.indexOf(c, i + 1);
      const nl = tail.indexOf('\n', i + 1);
      // 字面量必须在同一行闭合:跨行的多半是源码里字符串的收尾引号
      if (close === -1 || (nl !== -1 && nl < close)) continue;
      const e = close;
      const inner = tail.slice(i + 1, e).replace(/\\+$/, '');
      if (
        inner.length >= 8 &&
        !(c === '`' && /^\s/.test(inner)) &&
        !ENV_NAME.test(inner) &&
        judgeValue(inner, shell, disabled).secret
      ) {
        out.push([valEnd + i + 1, valEnd + e]);
      }
      i = e;
    } else if (/^\$\(/.test(val) && /[^\s()'"`;|&<>]/.test(c)) {
      // 命令替换里的裸词
      let e = i;
      while (e < tail.length && /[^\s()'"`;|&<>]/.test(tail[e] as string)) e++;
      const tok = tail.slice(i, e);
      if (tok.length >= 8 && !isReferenceWord(tok, disabled)) out.push([valEnd + i, valEnd + e]);
      i = e - 1;
    }
  }
  return out;
}

const ESC_NL = /\\+[nr]/;

function cutAtEscNewline(h: AssignHit): AssignHit | null {
  const m = ESC_NL.exec(h.val);
  if (!m) return h;
  // 值本身以转义换行开头:交给引擎的「起点是转义空白就丢弃」;截断点之前不足 8 个字符:整值脱敏(fail-closed)
  if (m.index === 0) return null;
  // 引用 / 标点残片(`{` `)`):那是「值为空」,后面是下一行;像口令的短头部(`Kx8q2\nLm9pQz`):整值脱敏
  if (m.index < 8) return judgeValue(h.val.slice(0, m.index), true).secret ? h : null;
  return { ...h, val: h.val.slice(0, m.index), vr: [h.vr[0], h.vr[0] + m.index] };
}

interface AssignHit {
  keyStart: number;
  opText: string;
  op: Range;
  gi: number;
  vr: Range;
  val: string;
}

const credAssign: Rule = {
  id: 'cred_assign',
  type: 'credential',
  prio: 70,
  compact: false,
  valueClass: true,
  quick: ['pass', 'pwd', 'secret', 'token', 'key', 'credential'],
  scan(text, _lower, push, env) {
    // 引用式候选:`'^NAME='` 这类,收尾引号之后的词单独判。先只登记,等所有普通赋值处理完,再按「值内部的引号不计」判奇偶
    const cand = new Map<number, number>();
    const ref = NAME_EQ_QUOTE_RE;
    ref.lastIndex = 0;
    for (let m = ref.exec(text); m !== null; m = ref.exec(text)) {
      env.deadline.tick();
      cand.set(m.index + m[0].length - (m[1] as string).length, m.index);
    }

    const excl: Range[] = [];
    const deferred = new Map<number, AssignHit>();

    /** 判一次赋值:是口令就登记脱敏区间;是引用就看后面有没有默认值字面量。返回是否登记了值本身。 */
    /** 值停在未闭合的调用 / 取环境变量之后:同一语句里的字符串字面量(默认值、参数)另外判 */
    const trail = (h: AssignHit, shell: boolean, v: ValueVerdict): void => {
      if (env.disabled.has(STAGE_TRAILING) || h.gi !== 5) return;
      const core = h.val.slice(0, v.coreLen);
      for (const [a, b] of trailingLiterals(
        text,
        h.vr[1],
        h.val,
        core,
        shell,
        env.disabled,
        env.origView,
      ))
        push(a, b);
    };
    const decide = (h0: AssignHit): boolean => {
      // 原视图补扫里,无引号值在转义的 `\n` `\r` 处仍是边界(与真换行同口径;`\t` 则不是),否则会吞掉下一行
      const h = env.origView && h0.gi === 5 ? cutAtEscNewline(h0) : h0;
      if (h === null) return false;
      const shell = isShellOp(h.opText);
      const v = judgeValue(h.val, shell, env.disabled);
      if (!v.secret) {
        trail(h, shell, v);
        return false;
      }
      if (h.val.length < 8) {
        // 不足 8 个字符的口令不脱敏(最小长度契约);但模板展开 `${a` 之后的字面量(`${a + '口令'}`)仍要判
        if (h.gi === 5 && h.val.startsWith('${')) trail(h, shell, v);
        return false;
      }
      if (placeholderGap(text, env, h.keyStart, h.op[1], h.vr[0]) === 'occupied') return false;
      push(h.vr[0], h.gi === 5 ? h.vr[0] + v.coreLen : h.vr[1]);
      trail(h, shell, v);
      return true;
    };

    const re = CRED_ASSIGN_RE;
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      env.deadline.tick();
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const ind = (m as RegExpExecArray & { indices: Array<[number, number] | undefined> }).indices;
      const op = ind[1] as [number, number];
      const gi = m[2] !== undefined ? 2 : m[4] !== undefined ? 4 : m[6] !== undefined ? 6 : 5;
      const vr = ind[gi] as [number, number];
      const val = m[gi] as string;
      // 被放行的匹配不能把后面的文本一起吞掉(里面可能还有真值赋值):从操作符之后继续
      const release = (): void => {
        re.lastIndex = op[1];
      };
      const h: AssignHit = { keyStart: m.index, opText: m[1] as string, op, gi, vr, val };
      if (val.length < 8) {
        // 太短不是口令;但引用(`env(` `ENV[` `$(echo`)后面的默认值字面量仍要判
        if (gi === 5) decide(h);
        release();
        continue;
      }
      if (cand.has(op[1])) {
        deferred.set(op[1], h);
        release();
        continue;
      }
      excl.push(vr);
      if (!decide(h)) release();
    }

    if (cand.size === 0) return;
    if (env.origView) {
      // 原视图补扫:引用式的引号奇偶不可靠(没有真换行),引用式候选一律不判;其余当普通赋值判
      for (const [opEnd, h] of deferred) {
        // 键名前面就是同种开引号(`'^NAME='`):结构上是引用式,交给 ws 视图那一遍判
        if (quotedNameRef(text, h.keyStart, opEnd, [], false) === null) decide(h);
      }
      return;
    }
    excl.sort((a, b) => a[0] - b[0]);
    for (const [opEnd, keyStart] of cand) {
      env.deadline.tick();
      const q = quotedNameRef(text, keyStart, opEnd, excl);
      if (q) {
        for (const [a, b] of valueWordsAfter(text, q.after, env.disabled)) push(a, b);
        continue;
      }
      const h = deferred.get(opEnd);
      if (h) {
        decide(h);
        excl.push(h.vr);
        excl.sort((a, b) => a[0] - b[0]);
      }
    }
  },
};

// ---------------------------------------------------------------------------
// 值的其它写法(B09c):反引号 / 三引号 / 类型标注 / 引号拼接 / 口令短语
// ---------------------------------------------------------------------------

/**
 * 分组:1=`:=` `=>` `=`,2=`:`(无标注),3=标注之后的 `=`。标注 `: str =` 的类型部分有长度上限、不含引号。
 */
const EXT_HEAD_RE = new RegExp(
  `${KW}${SFX}(?:\\\\*["'])?${SP}(?:(:=|=>|=)|(:)(?:${SP}[A-Za-z_][\\w.\\[\\], |?]{0,40}?${SP}(=)(?!=))?)${SP}`,
  'gid',
);
const WORD_STOP = /[\s|&;<>(),\]}`]/;
const EXT_CAP = 4096;

function eolWithin(text: string, from: number): number {
  const w = text.slice(from, from + EXT_CAP);
  const i = w.search(/[\r\n]/);
  return i === -1 ? from + w.length : from + i;
}

/**
 * 从 from 起找 delim(若干反斜杠 + 引号):命中位置前面不能再有反斜杠,
 * 否则它只是更长的转义串(三个反斜杠加引号)的尾巴,不是「这一层」的引号。
 */
function indexOfExactQuote(text: string, delim: string, from: number): number {
  for (let i = text.indexOf(delim, from); i !== -1; i = text.indexOf(delim, i + 1)) {
    if (i === 0 || text.charCodeAt(i - 1) !== 92) return i;
  }
  return -1;
}

/** 无引号 + 引号段拼接成的一个词(shell 语义)。返回词的终点、拼接后的内容、段数。 */
function readGluedWord(
  text: string,
  p: number,
  eol: number,
  quoteFirstNeedsQuote = false,
): { end: number; content: string; segs: number; firstEnd: number; firstEmpty: boolean } {
  let q = p;
  let content = '';
  let segs = 0;
  let firstEnd = p;
  let firstEmpty = false;
  /** q 处:若是(带转义反斜杠的)引号,返回 [反斜杠数, 引号字符] */
  const quoteAt = (at: number): [number, string] | null => {
    let b = 0;
    while (text.charCodeAt(at + b) === 92) b++;
    const qc = text[at + b];
    return qc === '"' || qc === "'" ? [b, qc] : null;
  };
  /** 词里第一个引号的转义深度:同一个视图里,词内的引号必须同深度(JSON 字符串的收尾引号、别层的引号不是拼接) */
  let layer = -1;
  while (q < eol) {
    const c = text[q] as string;
    const qa = quoteAt(q);
    if (qa) {
      const [bs, qc] = qa;
      if (layer === -1) layer = bs;
      else if (bs !== layer) break;
      const delim = '\\'.repeat(bs) + qc;
      const close = indexOfExactQuote(text, delim, q + delim.length);
      const e = close === -1 || close >= eol ? eol : close;
      // 引号没有闭合:多半是 JSON 字符串 / 源码字符串的收尾引号,不算词的一段,词到此为止
      if (e === eol) break;
      content += text.slice(q + delim.length, e);
      segs++;
      q = e + delim.length;
      if (segs === 1) {
        firstEnd = q;
        firstEmpty = content === '';
      }
      // 以引号段开头的词:紧跟的必须还是引号段(`"ab""口令"`),否则多半是源码里字符串字面量的收尾引号
      // 例外:引号段是短的无空白前缀(`"ab"口令`),shell 里同样是一个词
      if (
        quoteFirstNeedsQuote &&
        segs === 1 &&
        quoteAt(q) === null &&
        !/^[\w.@%+-]{1,7}$/.test(content)
      )
        break;
    } else if (WORD_STOP.test(c)) {
      break;
    } else {
      const st = q;
      while (q < eol && !WORD_STOP.test(text[q] as string) && quoteAt(q) === null) q++;
      content += text.slice(st, q);
      segs++;
    }
  }
  return { end: Math.min(q, eol), content, segs, firstEnd, firstEmpty };
}

const credAssignExt: Rule = {
  id: 'cred_assign_ext',
  type: 'credential',
  prio: 70,
  compact: false,
  valueClass: true,
  quick: ['pass', 'pwd', 'secret', 'token', 'key', 'credential'],
  scan(text, _lower, push, env) {
    const re = EXT_HEAD_RE;
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      env.deadline.tick();
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const ind = (m as RegExpExecArray & { indices: Array<[number, number] | undefined> }).indices;
      const annotated = m[3] !== undefined;
      const opText = annotated ? '=' : (m[1] ?? ':');
      const opRange = (ind[1] ?? ind[3] ?? ind[2]) as [number, number];
      const opEnd = opRange[1];
      const p = m.index + m[0].length;
      if (p >= text.length) continue;
      const shell = isShellOp(opText);
      let eol = eolWithin(text, p);
      if (env.origView) {
        const cut = ESC_NL.exec(text.slice(p, eol));
        if (cut) eol = p + cut.index;
      }
      const c = text[p] as string;
      const judge = (v: string): boolean => judgeValue(v, shell, env.disabled).secret;
      /** 值的位置已经被占位符占了(第二遍复扫第一遍的输出):后面的词不是这个赋值的值 */
      const free = (anchor: number): boolean =>
        placeholderGap(text, env, m.index, opEnd, anchor) !== 'occupied';

      // 反引号值(JS 模板串 / Go 原始字符串)
      if (c === '`') {
        const close = text.indexOf('`', p + 1);
        const e = close === -1 || close > eol ? eol : close;
        const inner = text.slice(p + 1, e);
        // 必须在同一行闭合,且内容不以空白开头(否则多半是 markdown 行内代码的收尾反引号)
        if (
          close !== -1 &&
          close <= eol &&
          inner.length >= 8 &&
          !/^\s/.test(inner) &&
          judge(inner) &&
          free(p + 1)
        )
          push(p + 1, e);
        continue;
      }
      // 同行三引号值(TOML / Python)
      // 三个引号中间不能是被剥掉的占位符:第二遍剥掉占位符后,`"值"` + `""` 会拼出一个原文里不存在的 `"""`
      if (
        (text.startsWith("'''", p) || text.startsWith('"""', p)) &&
        !env.rawSlice(p, p + 3).includes('[[REDACTED')
      ) {
        const close = text.indexOf(text.slice(p, p + 3), p + 3);
        const e = close === -1 || close > eol ? eol : close;
        const inner = text.slice(p + 3, e);
        if (inner.length >= 8 && judge(inner) && free(p + 3)) push(p + 3, e);
        continue;
      }
      // 类型标注之后的值:`password: str = "…"`,任意写法
      if (annotated) {
        if (c === '"' || c === "'") {
          const w = readGluedWord(text, p, eol);
          if (w.segs === 1) {
            const e = Math.max(p + 1, w.end - (text[w.end - 1] === c ? 1 : 0));
            const inner = text.slice(p + 1, e);
            if (inner.length >= 8 && judge(inner) && free(p + 1)) push(p + 1, e);
            continue;
          }
        }
        const w = readGluedWord(text, p, eol);
        if (w.content.length >= 8 && judge(w.content) && free(p)) push(p, w.end);
        // 类型标注之后跟调用(pydantic 的 Field(default=…)):调用参数里的字面量
        if (text[w.end] === '(' && !env.disabled.has(STAGE_TRAILING)) {
          for (const [a, b] of trailingLiterals(
            text,
            w.end + 1,
            `${w.content}(`,
            w.content,
            shell,
            env.disabled,
            env.origView,
          ))
            push(a, b);
        }
        continue;
      }
      // 引号拼接:`NAME=ab"口令"`(shell 里是同一个值)。`NAME='^X='` 这种引用式候选由 cred_assign 判,这里让开
      if (opText !== ':') {
        // 键名自己的收尾引号(`'NAME='`):不是值的开引号;JSON 转义的引号(`\"`)也不是拼接
        const nameQuote =
          p === opEnd &&
          (c === '"' || c === "'") &&
          quotedNameRef(text, m.index, opEnd, [], false) !== null;
        if (!nameQuote) {
          const w = readGluedWord(text, p, eol, c === '"' || c === "'" || c === '\\');
          // 第一段是空引号对、而原文里它中间有占位符(第二遍看到的是第一遍的输出):值的位置已经被占了,
          // 后面的引号段是别的东西,不是这个值的延续
          const emptied = w.firstEmpty && env.rawSlice(p, w.firstEnd).includes('[[REDACTED');
          if (!emptied && w.segs >= 2 && w.content.length >= 8 && judge(w.content) && free(p)) {
            push(p, w.end);
            continue;
          }
        }
      }
      // 口令短语:键名含 passphrase、值是无引号的多个词(含空格)。引号里的整串由 cred_assign 覆盖
      if (
        text.slice(m.index, opEnd).toLowerCase().includes('passphrase') &&
        c !== '"' &&
        c !== "'"
      ) {
        let e = p;
        while (e < eol && text[e] !== ';') e++;
        while (e > p && /[\s,.:)\]}]/.test(text[e - 1] as string)) e--;
        const phrase = text.slice(p, e);
        const words = phrase.split(/\s+/).filter((w) => w.length > 0);
        if (words.length >= 2 && phrase.length >= 12 && judge(phrase) && free(p)) push(p, e);
      }
    }
  },
};

const CRED_CLI_FLAG_RE =
  /--(?:[A-Za-z0-9_-]{1,24}[-_])?(password|passwd|passphrase|token|secret|api-key|apikey|access-token|auth-token|client-secret|private-key)(?:=|[ \t]{1,8})(?:"([^"\r\n]{4,})"?|'([^'\r\n]{4,})'?|([^\s"'`-][^\s"'`]{3,}))/dgi;

const credCliFlag: Rule = {
  id: 'cred_cli_flag',
  type: 'credential',
  prio: 70,
  compact: false,
  valueClass: true,
  quick: ['--'],
  scan(text, _lower, push, env) {
    const re = CRED_CLI_FLAG_RE;
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      env.deadline.tick();
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const ind = (m as RegExpExecArray & { indices: Array<[number, number] | undefined> }).indices;
      const keyEnd = (ind[1] as [number, number])[1];
      const gi = m[2] !== undefined ? 2 : m[3] !== undefined ? 3 : 4;
      const vr = ind[gi] as [number, number];
      let val = m[gi] as string;
      const release = (): void => {
        re.lastIndex = keyEnd;
      };
      if (env.origView && gi === 4) {
        const cut = ESC_NL.exec(val);
        if (cut) val = val.slice(0, cut.index);
        if (val.length < 4) {
          release();
          continue;
        }
      }
      const v = judgeValue(val, true, env.disabled);
      if (!v.secret) {
        release();
        continue;
      }
      if (placeholderGap(text, env, m.index, keyEnd, vr[0]) === 'occupied') {
        release();
        continue;
      }
      push(vr[0], gi === 4 ? vr[0] + v.coreLen : vr[0] + val.length);
    }
  },
};

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
  (m, env) => {
    // 值被 JSON 转义的引号(`\\"`)截断时,末尾会剩下孤立的反斜杠:去掉再判(`Bearer \\` 只是一个scheme)
    const v = (m[1] as string).replace(/\\+$/, '');
    return v.length >= 8 && judgeValue(v, true, env.disabled).secret && !AUTH_SCHEME_ONLY.test(v);
  },
);

const credCookie = simpleRegexRule(
  'cred_cookie',
  'credential',
  70,
  false,
  ['cookie'],
  /(?:^|[\r\n])[ \t]*(?:set-)?cookie[ \t]{0,4}:[ \t]{0,4}(?![ \t])([^\r\n]{12,})/dgim,
  (m, env) => judgeValue(m[1] as string, true, env.disabled).secret,
);

const urlUserinfo = simpleRegexRule(
  'url_userinfo',
  'credential',
  65,
  false,
  ['://'],
  /:\/\/[^\s/@:]{0,64}:([^\s/@]{3,})@/dg,
  undefined,
  true,
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
    credAssignExt,
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
  'view_json_ws',
  'view_orig_union',
  STAGE_REF_TAIL,
  STAGE_REF_BOUNDARY,
  STAGE_REF_FLAG,
  STAGE_PLACEHOLDER,
  STAGE_TRAILING,
  STAGE_REF_TEMPLATE,
  STAGE_REF_ZOD,
] as const;
