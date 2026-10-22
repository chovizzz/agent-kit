export interface LlmCompleteRequest {
  readonly system: string;
  readonly user: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}
export type LlmCompleteResult =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      readonly reason: 'not_installed' | 'not_configured' | 'rate_limited' | 'timeout' | 'error';
      readonly detail?: string;
    };
/** 真实 CLI 种类(与 `reflector.backend` / 覆盖层 `cli` 同一枚举) */
export const REAL_BACKEND_CLIS = ['claude', 'codex', 'pi'] as const;
export type RealBackendCli = (typeof REAL_BACKEND_CLIS)[number];
/**
 * 后端自报的 CLI 种类。除真实 CLI 外两个标记:`stub`(进程内假后端,产出的提案必须带 `reflector.stub: true`,
 * 厂商不可证明)、`unconfigured`(槽位占位,厂商恒 unknown)。后两者都不是 `reflector.backend` 的合法取值。
 */
export type LlmBackendCli = RealBackendCli | 'stub' | 'unconfigured';

export interface LlmBackend {
  readonly slot: string;
  readonly vendor: string;
  readonly model: string;
  /** 必填:厂商由 `cli`+`provider`+`model` 复算(`provenVendorOf`),缺失或非法 → 厂商不可证明 → fail-closed */
  readonly cli: LlmBackendCli;
  /** 必填键(值可为 undefined = 未指定 provider);缺这个键同样视为不可证明 */
  readonly provider: string | undefined;
  complete(req: LlmCompleteRequest): Promise<LlmCompleteResult>;
}
