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
