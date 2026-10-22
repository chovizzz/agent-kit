/**
 * 后端身份与厂商证明。厂商只认后端**自己**暴露的 `cli`/`provider`/`model`(contracts §12.4/§16/§17,#18/#26),
 * 不再由命令层回头去覆盖层里反查 CLI。注入的后端与默认接线走同一条复算路径。
 */
import { FIRST_PARTY_PROVIDERS, UNKNOWN_VENDOR, deriveVendor } from '../contracts/vendor.js';
import { REAL_BACKEND_CLIS } from './backend-iface.js';
import type { LlmBackend, RealBackendCli } from './backend-iface.js';

/**
 * 由绑定推导厂商。在 `deriveVendor` 之上多一条保守规则:codex 配了第一方 provider 却与模型族推出的厂商矛盾
 * (如 `--provider deepseek` + `claude-*` 模型)→ unknown。
 */
export function deriveBackendVendor(
  cli: RealBackendCli,
  provider: string | undefined,
  model: string | undefined,
  overrides: Readonly<Record<string, string>>,
): string {
  const v = deriveVendor({ backend: cli, provider, model }, overrides);
  if (
    cli === 'codex' &&
    provider !== undefined &&
    Object.hasOwn(FIRST_PARTY_PROVIDERS, provider) &&
    FIRST_PARTY_PROVIDERS[provider] !== v
  ) {
    return UNKNOWN_VENDOR;
  }
  return v;
}

export function isRealCli(cli: unknown): cli is RealBackendCli {
  return typeof cli === 'string' && (REAL_BACKEND_CLIS as readonly string[]).includes(cli);
}

/** 身份字段的运行时形状:`provider` 键必须存在(值为 undefined 或字符串),`model` 为字符串。 */
export function identityShapeValid(b: LlmBackend): boolean {
  if (!('provider' in b)) return false;
  if (b.provider !== undefined && typeof b.provider !== 'string') return false;
  return typeof b.model === 'string';
}

/**
 * 从后端自己的 `cli`/`provider`/`model` 复算厂商。运行时校验(不信任类型):`cli` 不是真实 CLI(含 `stub`/
 * `unconfigured`/缺失)、没有 `provider` 键、`provider`/`model` 不是字符串 → unknown。不依赖后端自报的 `vendor`。
 */
export function provenVendorOf(b: LlmBackend): string {
  if (!isRealCli(b.cli)) return UNKNOWN_VENDOR;
  if (!identityShapeValid(b)) return UNKNOWN_VENDOR;
  try {
    return deriveBackendVendor(b.cli, b.provider, b.model, {});
  } catch {
    return UNKNOWN_VENDOR;
  }
}
