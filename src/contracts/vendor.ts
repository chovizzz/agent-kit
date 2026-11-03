import type { JudgeRecord, Proposal } from './proposal.js';
import { judgeBindingSha256, reflectorBindingSha256 } from './judge-binding.js';

/**
 * 厂商表(R0,contracts #26)。冻结常量:`(backend, provider, model) → vendor` 由本表推导,
 * **用户不能自己声明厂商**(否则可把 claude 配成 vendor=openai 绕过 contracts #18)。
 * 例外:N4 的人工确认路径(§20.18)只产生 `self_confirmed` 层级,不进入 `proven`——它是用户在本机 TTY 亲手键入的自报,
 * 不是 kit 的证明;`vendorEvidence`(本文件)是仅有的证据函数,C5 / G3 / promote / judge 都只调用它。
 * 改本表 = 契约变更。推导不出 = `unknown`;任一边 `unknown` 即「无法证明不同厂商」,不放行。
 */

export const VENDOR_BACKENDS = ['claude', 'codex', 'pi'] as const;
export type VendorBackend = (typeof VENDOR_BACKENDS)[number];

export const UNKNOWN_VENDOR = 'unknown';

/** 内置模型族(整 token 相等才算命中;不是裸前缀,`deepseekfoo` 不属于 deepseek)。 */
export const BUILTIN_FAMILIES: Readonly<Record<string, string>> = Object.freeze({
  deepseek: 'deepseek',
  glm: 'zhipu',
  kimi: 'moonshot',
  moonshot: 'moonshot',
  gpt: 'openai',
  claude: 'anthropic',
  gemini: 'google',
  /** `o<数字>*`(o1、o3-mini…)的族 token 是 `o`,仅当后面紧跟数字时命中 */
  o: 'openai',
});
export const BUILTIN_VENDORS: readonly string[] = Object.freeze([
  ...new Set(Object.values(BUILTIN_FAMILIES)),
]);

/**
 * 第一方 provider(公开的 pi provider id)→ 厂商。**只用于一致性校验**,不参与推导:
 * provider 是第一方、且与模型族推出的厂商不一致(如 `--provider anthropic --model gpt-x`)→ unknown。
 * 聚合渠道(openrouter、各云厂商的 MaaS 等)不在表里,只看模型。表里不得出现任何私人账号/渠道。
 */
export const FIRST_PARTY_PROVIDERS: Readonly<Record<string, string>> = Object.freeze({
  anthropic: 'anthropic',
  openai: 'openai',
  deepseek: 'deepseek',
  zai: 'zhipu',
  moonshot: 'moonshot',
  'kimi-coding': 'moonshot',
  google: 'google',
});

export class VendorOverrideDeniedError extends Error {
  readonly code = 'CFG_VENDOR_OVERRIDE_DENIED';
}

const OVERRIDE_FAMILY_RE = /^[a-z]{2,32}$/;
const MODEL_CHARS_RE = /^[a-z0-9._:@+/-]+$/;

/**
 * 校验覆盖层的 `vendor_overrides`(模型族 token → 厂商 id)。覆盖层**只能追加新家族**:
 * token 不得是内置族;厂商 id 不得是 `unknown`,也不得等于任何内置厂商(防止把新家族标成别家来「制造不同厂商」)。
 * 违者 `VendorOverrideDeniedError`(`CFG_VENDOR_OVERRIDE_DENIED`)。
 */
export function assertVendorOverrides(overrides: Readonly<Record<string, string>>): void {
  for (const [family, vendor] of Object.entries(overrides)) {
    if (!OVERRIDE_FAMILY_RE.test(family)) {
      throw new VendorOverrideDeniedError(`CFG_VENDOR_OVERRIDE_DENIED: 非法的模型族 token`);
    }
    if (Object.hasOwn(BUILTIN_FAMILIES, family)) {
      throw new VendorOverrideDeniedError(
        `CFG_VENDOR_OVERRIDE_DENIED: 不能覆盖内置模型族 ${family}`,
      );
    }
    if (!VENDOR_ID_RE.test(vendor) || vendor === UNKNOWN_VENDOR) {
      throw new VendorOverrideDeniedError(`CFG_VENDOR_OVERRIDE_DENIED: ${family} 的厂商 id 非法`);
    }
    if (BUILTIN_VENDORS.includes(vendor)) {
      throw new VendorOverrideDeniedError(
        `CFG_VENDOR_OVERRIDE_DENIED: ${family} 不能映射到内置厂商 ${vendor}`,
      );
    }
  }
}

function familyOf(
  segment: string,
  overrides: Readonly<Record<string, string>>,
): string | undefined {
  const m = /^[a-z]+/.exec(segment);
  if (!m) return undefined;
  const family = m[0];
  if (family === 'o') return /^o\d/.test(segment) ? BUILTIN_FAMILIES['o'] : undefined;
  if (Object.hasOwn(BUILTIN_FAMILIES, family)) return BUILTIN_FAMILIES[family];
  if (Object.hasOwn(overrides, family)) return overrides[family];
  return undefined;
}

/** 由模型串推导厂商;不合规字符、没有命中、或各路径段命中的厂商互相矛盾,一律 unknown。 */
function vendorFromModel(model: string | undefined, overrides: Readonly<Record<string, string>>) {
  if (model === undefined) return UNKNOWN_VENDOR;
  const lower = model.toLowerCase();
  if (!MODEL_CHARS_RE.test(lower)) return UNKNOWN_VENDOR;
  const found = new Set<string>();
  for (const seg of lower.split('/')) {
    const v = familyOf(seg, overrides);
    if (v !== undefined) found.add(v);
  }
  return found.size === 1 ? [...found][0]! : UNKNOWN_VENDOR;
}

/** 后端固定厂商时,若给出的模型串明确属于另一厂商(或自相矛盾),说明配置与后端不一致 → 调用方应判 unknown。 */
function modelContradicts(
  model: string | undefined,
  vendor: string,
  overrides: Readonly<Record<string, string>>,
): boolean {
  if (model === undefined) return false;
  const lower = model.toLowerCase();
  if (!MODEL_CHARS_RE.test(lower)) return true;
  const v = vendorFromModel(model, overrides);
  return v !== UNKNOWN_VENDOR && v !== vendor;
}

export interface VendorInput {
  backend: string;
  provider?: string | undefined;
  model?: string | undefined;
}

/**
 * 推导厂商。
 * - `claude` CLI → anthropic;
 * - `codex`:provider 缺省或 `openai` → openai;配置了其它 provider → 按模型族;
 * - `pi`:按模型族;provider 是第一方且与模型族矛盾 → unknown(provider 不参与推导本身);
 * - 其它后端 → unknown。
 * `overrides` 先过 `assertVendorOverrides`(冲突抛 `VendorOverrideDeniedError`)。
 */
export function deriveVendor(
  input: VendorInput,
  overrides: Readonly<Record<string, string>> = {},
): string {
  assertVendorOverrides(overrides);
  switch (input.backend) {
    case 'claude':
      return modelContradicts(input.model, 'anthropic', overrides) ? UNKNOWN_VENDOR : 'anthropic';
    case 'codex':
      if (input.provider === undefined || input.provider === 'openai') {
        return modelContradicts(input.model, 'openai', overrides) ? UNKNOWN_VENDOR : 'openai';
      }
      return vendorFromModel(input.model, overrides);
    case 'pi': {
      const v = vendorFromModel(input.model, overrides);
      const p = input.provider;
      if (p !== undefined && Object.hasOwn(FIRST_PARTY_PROVIDERS, p)) {
        return FIRST_PARTY_PROVIDERS[p] === v ? v : UNKNOWN_VENDOR;
      }
      return v;
    }
    default:
      return UNKNOWN_VENDOR;
  }
}

/** 人工确认的 token 规则(R20-18.9):模型串折成小写后须满足;裁判侧 `declared.model`、反思器侧 `confirmed.model` 共用。放在本文件(叶子模块)避免与 proposal.ts 形成运行期环 */
export const CONFIRMED_MODEL_RE = /^[a-z0-9._:@+/-]{1,64}$/;

/** 厂商 id 的规范形。 */
export const VENDOR_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * 两个厂商 id **可证明**不同才返回 true。任一方为 unknown、空、非规范形(大小写/空白/符号),
 * 或**不是内置厂商**(来自覆盖层追加的家族——真实厂商的模型可能被标成「新厂商」,不能当证据)→ false。
 * 不做归一化:「看起来不同」不是证明(`OpenAI` vs `openai` 不会被当作不同厂商)。
 */
/**
 * 提案级的跨厂商判定(R20-16.20 ③):`reflector.provenance = session_declared` 的厂商是调用方自报、kit 证明不了,**一律视为不可证明**,
 * 与 `reflector.vendor` 写了什么无关;其余走 {@link isCrossVendor}。
 * N4(R20-18.17):**不再是口径的来源**——`vendorEvidence` 才是唯一的证据函数(它直接用 {@link isCrossVendor} 做配对,N4i-13);本函数仅为保持契约要求的签名与语义而保留导出,
 * `src/` 里没有任何调用方;签名与语义保持(`session_declared` 无确认 → false),`src/` 里除本文件外不得有任何引用(`test/contracts/n4-vendor-single-impl.test.ts` 钉住)。
 * @deprecated 仅为契约兼容保留;新代码一律走 {@link vendorEvidence}。
 */
export function isCrossVendorOf(
  reflector: { vendor: string; provenance?: string | undefined },
  judgeVendor: string,
): boolean {
  if (reflector.provenance === 'session_declared') return false;
  return isCrossVendor(reflector.vendor, judgeVendor);
}

export function isCrossVendor(a: string, b: string): boolean {
  if (!VENDOR_ID_RE.test(a) || !VENDOR_ID_RE.test(b)) return false;
  if (a === UNKNOWN_VENDOR || b === UNKNOWN_VENDOR) return false;
  if (!BUILTIN_VENDORS.includes(a) || !BUILTIN_VENDORS.includes(b)) return false;
  return a !== b;
}

// ---------------------------------------------------------------- N4:唯一的证据函数(R20-18.17)

/** 厂商证据层级(R20-18.1,封闭枚举) */
export const VENDOR_TIERS = ['proven', 'self_confirmed', 'none'] as const;
export type VendorTier = (typeof VENDOR_TIERS)[number];

/** 固定标签常量(R20-18.2):所有展示面引用同一常量,不得各写各的字面 */
export const SELF_REPORT_LABEL_JUDGE = '判官侧:人工确认的自报(kit 无法证明其厂商)';
export const SELF_REPORT_LABEL_REFLECTOR = '反思器侧:人工确认的自报(kit 无法证明其厂商)';
export const VENDOR_PROVEN_LABEL = '厂商由 kit 复算证明';

export interface SideEvidence {
  readonly tier: VendorTier;
  /** `proven`:记录的厂商(归一化);`self_confirmed`:键入 / 声明的厂商;`none`:`unknown`(无可用值) */
  readonly vendor: string;
  /** `proven`:反思器记录的 `model` / 裁判最后一跳的 `model`;`self_confirmed`:键入 / 声明值;`none`:`-` */
  readonly model: string;
}

export interface VendorIssue {
  readonly side: 'reflector' | 'judge' | 'pair';
  /** C5 词汇的原因码(`criteria.ts` 经映射表换成 CI 码) */
  readonly code: string;
}

export type VendorEvidence =
  | {
      readonly ok: true;
      readonly reflector: SideEvidence;
      readonly judge: SideEvidence;
      readonly issues: readonly [];
    }
  | {
      readonly ok: false;
      /** 第一个问题所在的一侧与码 */
      readonly side: 'reflector' | 'judge' | 'pair';
      readonly code: string;
      readonly reflector: SideEvidence;
      readonly judge: SideEvidence;
      /** 全部问题(检测顺序:反思器 → 裁判 → 配对)。C5 / CI 要「返回全部失败项」,故比契约的 `{side, code}` 多给这一列(N4i-2) */
      readonly issues: readonly VendorIssue[];
    };

const NONE_SIDE: SideEvidence = Object.freeze({ tier: 'none', vendor: UNKNOWN_VENDOR, model: '-' });
const normVendorId = (v: string): string => v.trim().toLowerCase();

type Overrides = Readonly<Record<string, string>>;
type Spawned = Extract<JudgeRecord, { provenance: 'spawned' }>;

/** 反思器侧:`reflector.confirmed` 的「有效确认」判定(R20-18.18 ①–⑤;① 由 schema 保证,这里重核 ②–⑤) */
function reflectorConfirmedIssue(p: Proposal, overrides: Overrides): string | undefined {
  const c = p.reflector.confirmed;
  if (c === undefined) return 'REFLECTOR_SESSION_DECLARED';
  if (!BUILTIN_VENDORS.includes(c.vendor) || c.vendor === UNKNOWN_VENDOR) {
    return 'REFLECTOR_CONFIRM_INVALID';
  }
  if (!CONFIRMED_MODEL_RE.test(c.model.toLowerCase())) return 'REFLECTOR_CONFIRM_INVALID';
  try {
    // 合理性(④):backend 缺省时只看模型族
    const derived = deriveVendor(
      { backend: p.reflector.backend ?? 'pi', model: c.model },
      overrides,
    );
    if (derived !== UNKNOWN_VENDOR && derived !== c.vendor) return 'REFLECTOR_CONFIRM_INVALID';
  } catch {
    return 'VENDOR_OVERRIDES_INVALID';
  }
  if (reflectorBindingSha256(p) !== c.binding_sha256) return 'REFLECTOR_CONFIRM_INVALID';
  return undefined;
}

/**
 * 反思器侧证据(单侧入口;`judge --run-llm` 的同厂商判定与 `assertReflectorVendor` 也只经它)。
 * `spawned` / 缺省 → 现有口径(`backend` 必填,`deriveVendor` 复算等于记录的 `vendor` 且 ≠ unknown)→ `proven`;
 * `session_declared` 且确认有效 → `self_confirmed`(厂商取 `confirmed.vendor`);无确认 → `none` + `REFLECTOR_SESSION_DECLARED`;确认无效 → `none` + `REFLECTOR_CONFIRM_INVALID`。
 * **压制**(R20-18.19 ①):`self_confirmed` 时不发 `REFLECTOR_BACKEND_MISSING` / `REFLECTOR_VENDOR_MISMATCH`(它们对 A4 写的 `provider = session` / `model = undeclared` 必然命中)。
 */
export function reflectorEvidence(
  p: Proposal,
  vendorOverrides: Overrides = {},
): { side: SideEvidence; issues: VendorIssue[] } {
  const issues: VendorIssue[] = [];
  const add = (code: string): void => {
    issues.push({ side: 'reflector', code });
  };
  if (p.reflector.provenance === 'session_declared') {
    const bad = reflectorConfirmedIssue(p, vendorOverrides);
    if (bad !== undefined) {
      add(bad);
      return { side: NONE_SIDE, issues };
    }
    const c = p.reflector.confirmed!;
    return { side: { tier: 'self_confirmed', vendor: c.vendor, model: c.model }, issues };
  }
  if (p.reflector.backend === undefined) {
    add('REFLECTOR_BACKEND_MISSING');
    return { side: NONE_SIDE, issues };
  }
  try {
    const derived = deriveVendor(
      { backend: p.reflector.backend, provider: p.reflector.provider, model: p.reflector.model },
      vendorOverrides,
    );
    if (derived === UNKNOWN_VENDOR || derived !== normVendorId(p.reflector.vendor)) {
      add('REFLECTOR_VENDOR_MISMATCH');
      return { side: NONE_SIDE, issues };
    }
  } catch {
    add('VENDOR_OVERRIDES_INVALID');
    return { side: NONE_SIDE, issues };
  }
  return {
    side: { tier: 'proven', vendor: normVendorId(p.reflector.vendor), model: p.reflector.model },
    issues,
  };
}

function spawnedJudgeEvidence(
  j: Spawned,
  overrides: Overrides,
): { side: SideEvidence; issues: VendorIssue[] } {
  const issues: VendorIssue[] = [];
  const add = (code: string): void => {
    issues.push({ side: 'judge', code });
  };
  const last = j.hops[j.hops.length - 1];
  if (last === undefined || last.result !== 'ok') {
    add('JUDGE_LAST_HOP_NOT_OK');
  } else {
    if (j.provider !== last.hop) add('JUDGE_PROVIDER_MISMATCH');
    if (normVendorId(last.vendor) !== normVendorId(j.vendor)) add('JUDGE_LAST_HOP_VENDOR_MISMATCH');
    // 记录里的 vendor 是自报值:再用最后一跳的模型串按厂商表复算(只看模型族);推不出或不一致都拒
    try {
      const derived = deriveVendor({ backend: 'pi', model: last.model }, overrides);
      if (derived === UNKNOWN_VENDOR || derived !== normVendorId(j.vendor)) {
        add('JUDGE_VENDOR_UNPROVEN');
      }
    } catch {
      add('VENDOR_OVERRIDES_INVALID');
    }
  }
  if (issues.length > 0 || last === undefined) return { side: NONE_SIDE, issues };
  return { side: { tier: 'proven', vendor: normVendorId(j.vendor), model: last.model }, issues };
}

function sessionConfirmedJudgeIssue(
  p: Proposal,
  j: Extract<JudgeRecord, { provenance: 'session_confirmed' }>,
  overrides: Overrides,
): string | undefined {
  const d = j.declared;
  if (!BUILTIN_VENDORS.includes(d.vendor) || d.vendor === UNKNOWN_VENDOR) {
    return 'JUDGE_CONFIRM_INVALID';
  }
  if (!CONFIRMED_MODEL_RE.test(d.model.toLowerCase())) return 'JUDGE_CONFIRM_INVALID';
  try {
    const derived = deriveVendor({ backend: d.agent, model: d.model }, overrides);
    if (derived !== UNKNOWN_VENDOR && derived !== d.vendor) return 'JUDGE_CONFIRM_INVALID';
  } catch {
    return 'VENDOR_OVERRIDES_INVALID';
  }
  if (judgeBindingSha256(p, j) !== j.confirmation.binding_sha256) return 'JUDGE_CONFIRM_INVALID';
  return undefined;
}

/**
 * 裁判侧证据。`spawned` → 现有 C5 的全部检查 → `proven`;`session_confirmed` 且确认有效 → `self_confirmed`(厂商取 `declared.vendor`);
 * 无效 → `none` + `JUDGE_CONFIRM_INVALID`。`judge` 缺省 → `none` + `JUDGE_PENDING`(有 `judge_attempts`)/ `JUDGE_MISSING`。
 * `spawned` 专属的码(`JUDGE_HOP_*` 等)不会对 `session_confirmed` 发出。
 */
export function judgeEvidence(
  p: Proposal,
  vendorOverrides: Overrides = {},
): { side: SideEvidence; issues: VendorIssue[] } {
  const j = p.judge;
  if (j === undefined) {
    return {
      side: NONE_SIDE,
      issues: [
        { side: 'judge', code: p.judge_attempts !== undefined ? 'JUDGE_PENDING' : 'JUDGE_MISSING' },
      ],
    };
  }
  if (j.provenance === 'spawned') return spawnedJudgeEvidence(j, vendorOverrides);
  const bad = sessionConfirmedJudgeIssue(p, j, vendorOverrides);
  if (bad !== undefined) return { side: NONE_SIDE, issues: [{ side: 'judge', code: bad }] };
  return {
    side: { tier: 'self_confirmed', vendor: j.declared.vendor, model: j.declared.model },
    issues: [],
  };
}

/** 反思器侧「声称的」厂商(即使无证明):配对检查用它保持 `VENDOR_NOT_CROSS` 与改造前逐码一致 */
function claimedReflectorVendor(p: Proposal, side: SideEvidence): string {
  if (side.tier !== 'none') return side.vendor;
  return p.reflector.provenance === 'session_declared'
    ? UNKNOWN_VENDOR
    : normVendorId(p.reflector.vendor);
}

function claimedJudgeVendor(p: Proposal, side: SideEvidence): string {
  if (side.tier !== 'none') return side.vendor;
  const j = p.judge;
  return j !== undefined && j.provenance === 'spawned' ? normVendorId(j.vendor) : UNKNOWN_VENDOR;
}

/**
 * **唯一的证据函数**(R20-18.17,纯函数,无 IO):`checkC5`、`criteria.ts` 的 `judgeChecks`、`promote` 的本地判据、
 * `judge --run-llm` 的同厂商判定、`judge --ingest` 的 `same_vendor` 全部只调用它(或它导出的单侧入口),**CI 不得比本地宽**。
 * 配对:两侧都有层级(`proven` 或 `self_confirmed`)、两厂商都在 `BUILTIN_VENDORS`、都不是 `unknown`、可证明地不同 → 通过;
 * 否则 `VENDOR_NOT_CROSS`。任何层级组合都可通过(`proven + proven`、`proven + self_confirmed`、`self_confirmed + self_confirmed`),
 * **不要求至少一侧可证明**(用户决定 ③,Q-N4-2 = A)。
 */
export function vendorEvidence(p: Proposal, vendorOverrides: Overrides = {}): VendorEvidence {
  const r = reflectorEvidence(p, vendorOverrides);
  const j = judgeEvidence(p, vendorOverrides);
  const issues: VendorIssue[] = [...r.issues, ...j.issues];
  if (
    !isCrossVendor(claimedReflectorVendor(p, r.side), claimedJudgeVendor(p, j.side)) &&
    // `judge` 缺省时还没有「配对」可言:只报 JUDGE_PENDING / JUDGE_MISSING(与改造前一致)
    p.judge !== undefined
  ) {
    issues.push({ side: 'pair', code: 'VENDOR_NOT_CROSS' });
  }
  // 两侧有层级但厂商不可证明不同的情形已由上面的 isCrossVendor 覆盖;层级为 none 的一侧必有自己的 issue
  if (issues.length === 0 && r.side.tier !== 'none' && j.side.tier !== 'none') {
    return { ok: true, reflector: r.side, judge: j.side, issues: [] };
  }
  const first = issues[0] ?? { side: 'pair' as const, code: 'VENDOR_NOT_CROSS' };
  return {
    ok: false,
    side: first.side,
    code: first.code,
    reflector: r.side,
    judge: j.side,
    issues: issues.length > 0 ? issues : [first],
  };
}

/** 反思器侧证据与一个候选裁判厂商「可证明地不同」(`judge --run-llm` 的逐跳判定用;`none` 层级恒为 false) */
export function isProvablyCrossVendor(reflector: SideEvidence, judgeVendor: string): boolean {
  return reflector.tier !== 'none' && isCrossVendor(reflector.vendor, normVendorId(judgeVendor));
}

/**
 * `judge --run-llm` 的逐跳判定用的「反思器厂商」(R20-18.21):`session_declared` 提案 → 仅当反思器侧 `self_confirmed` 时 `usable`,厂商取 `confirmed.vendor`
 * (参与「与裁判同厂商 → `skipped:same-vendor`」的保守判断);无有效确认 → `usable = false`(调用方 fail-closed `JUDGE_VENDOR_UNKNOWN`)。
 * 其余提案保持改造前的口径(厂商取记录值;缺 `backend` 的旧提案不在这里拒绝,由调用方既有的复算检查负责),不改变既有行为。
 */
export function judgeHopReflectorVendor(
  p: Proposal,
  vendorOverrides: Overrides = {},
): { readonly vendor: string; readonly usable: boolean } {
  if (p.reflector.provenance !== 'session_declared') {
    return { vendor: p.reflector.vendor, usable: true };
  }
  const side = reflectorEvidence(p, vendorOverrides).side;
  return side.tier === 'self_confirmed'
    ? { vendor: side.vendor, usable: true }
    : { vendor: p.reflector.vendor, usable: false };
}
