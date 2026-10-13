import { describe, expect, it } from 'vitest';
import type { LlmBackend } from '../../../src/reflect/backend-iface.js';
import { StubBackend, buildBackends } from '../../../src/reflect/backends/index.js';
import { REQ, fixture } from './_fixture.js';

describe('R3 StubBackend', () => {
  it('记录请求与调用次数;默认返回合法的空提案 JSON', async () => {
    const s = new StubBackend();
    expect(s.calls).toBe(0);
    expect(await s.complete(REQ)).toEqual({ ok: true, text: '{"proposals":[]}' });
    expect(s.calls).toBe(1);
    expect(s.requests[0]).toEqual(REQ);
  });

  it('预置序列:按调用顺序返回,取完重复最后一项;函数式脚本可读请求', async () => {
    const s = new StubBackend({
      results: [
        { ok: false, reason: 'rate_limited', detail: 'x' },
        (req) => ({ ok: true, text: req.user }),
      ],
    });
    expect(await s.complete(REQ)).toMatchObject({ reason: 'rate_limited' });
    expect(await s.complete({ ...REQ, user: 'U1' })).toEqual({ ok: true, text: 'U1' });
    expect(await s.complete({ ...REQ, user: 'U2' })).toEqual({ ok: true, text: 'U2' });
    expect(s.calls).toBe(3);
  });

  it('符合 LlmBackend 接口;生产工厂产出的后端里没有 Stub', async () => {
    const s: LlmBackend = new StubBackend({ slot: 'glm', vendor: 'zhipu', model: 'm' });
    expect([s.slot, s.vendor, s.model]).toEqual(['glm', 'zhipu', 'm']);
    const f = await fixture('stub-factory-');
    const list = buildBackends({}, f.deps());
    expect(list.some((b) => b instanceof StubBackend)).toBe(false);
  });
});
