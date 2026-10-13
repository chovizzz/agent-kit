// R2/R3 约定的后端接口(两块必须逐字一致)。
// 注意:R0 的 src/contracts/vendor.ts 没有导出名为 `Vendor` 的类型(厂商在契约里一律是 string,
// 由 deriveVendor() 推导),所以这里用 `string`;合并时若 R3 取了别的写法,以主代理统一为准。
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
export interface LlmBackend {
  readonly slot: string;
  readonly vendor: string;
  readonly model: string;
  complete(req: LlmCompleteRequest): Promise<LlmCompleteResult>;
}
