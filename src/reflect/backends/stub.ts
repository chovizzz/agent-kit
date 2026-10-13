/**
 * 进程内假后端(测试用)。不 spawn、不联网;记录收到的请求与调用次数,可预置返回/失败。
 * 生产路径不得能通过命令行/配置选到它:`buildBackends` 不会产出它,只有代码显式 `new StubBackend()` 才有。
 */
import type { LlmBackend, LlmCompleteRequest, LlmCompleteResult } from '../backend-iface.js';

export type StubScript = LlmCompleteResult | ((req: LlmCompleteRequest) => LlmCompleteResult);

export interface StubOptions {
  readonly slot?: string;
  readonly vendor?: string;
  readonly model?: string;
  /** 预置的返回;数组时按调用顺序取,取完后重复最后一项 */
  readonly results?: StubScript | readonly StubScript[];
}

export class StubBackend implements LlmBackend {
  readonly slot: string;
  readonly vendor: string;
  readonly model: string;
  readonly requests: LlmCompleteRequest[] = [];
  #scripts: readonly StubScript[];

  constructor(opts: StubOptions = {}) {
    this.slot = opts.slot ?? 'codex';
    this.vendor = opts.vendor ?? 'stub';
    this.model = opts.model ?? 'stub-model';
    const r = opts.results ?? { ok: true as const, text: '{"proposals":[]}' };
    this.#scripts = Array.isArray(r) ? (r as readonly StubScript[]) : [r as StubScript];
  }

  get calls(): number {
    return this.requests.length;
  }

  complete(req: LlmCompleteRequest): Promise<LlmCompleteResult> {
    const idx = Math.min(this.requests.length, this.#scripts.length - 1);
    this.requests.push(req);
    const script = this.#scripts[idx];
    if (script === undefined)
      return Promise.resolve({ ok: false, reason: 'error', detail: 'stub_empty' });
    return Promise.resolve(typeof script === 'function' ? script(req) : script);
  }
}
