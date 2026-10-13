/**
 * 厂商表(R0,contracts #26)。冻结常量:`(backend, provider, model) → vendor` 由本表推导,
 * **用户不能自己声明厂商**(否则可把 claude 配成 vendor=openai 绕过 contracts #18)。
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

/** 厂商 id 的规范形。 */
export const VENDOR_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * 两个厂商 id **可证明**不同才返回 true。任一方为 unknown、空、非规范形(大小写/空白/符号),
 * 或**不是内置厂商**(来自覆盖层追加的家族——真实厂商的模型可能被标成「新厂商」,不能当证据)→ false。
 * 不做归一化:「看起来不同」不是证明(`OpenAI` vs `openai` 不会被当作不同厂商)。
 */
export function isCrossVendor(a: string, b: string): boolean {
  if (!VENDOR_ID_RE.test(a) || !VENDOR_ID_RE.test(b)) return false;
  if (a === UNKNOWN_VENDOR || b === UNKNOWN_VENDOR) return false;
  if (!BUILTIN_VENDORS.includes(a) || !BUILTIN_VENDORS.includes(b)) return false;
  return a !== b;
}
