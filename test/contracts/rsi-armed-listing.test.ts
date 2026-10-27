/**
 * B4-0 / D2:`RsiStateSchema` 的可选字段 `armed_listing`(首次 armed 列举的结果,绑定 policy_fp 与 agents)。
 * 老文件(没有该字段)仍合法;非法 listing 是**整份 state.json 失效**(`invalid`),不被误判成 `confirm_schema_invalid` 而放行;
 * confirm 单独不合规的既有规则不变,且 armed_listing 在其中原样保留。
 */
import { describe, expect, it } from 'vitest';
import { RsiStateSchema } from '../../src/contracts/rsi.js';
import { parseRsiStateDoc } from '../../src/rsi/state.js';

const base = {
  schema_version: 1,
  confirm: null,
  projects_ack_generation: 0,
  attempt: null,
  last_tick: null,
  consecutive_failures: 0,
  breaker: null,
};
const listing = {
  at: '2026-10-27T00:00:00.000Z',
  policy_fp: 'a'.repeat(64),
  agents: ['claude', 'pi'],
  projects: 3,
  excluded: 1,
  unknown_sessions: 4,
};
const doc = (o: object): ReturnType<typeof parseRsiStateDoc> =>
  parseRsiStateDoc(Buffer.from(JSON.stringify(o)));

describe('RsiState.armed_listing(D2)', () => {
  it('老文件(无该字段)仍合法', () => {
    expect(RsiStateSchema.safeParse(base).success).toBe(true);
    expect(doc(base)).toMatchObject({ kind: 'ok' });
  });
  it('合法 listing 原样保留', () => {
    const d = doc({ ...base, armed_listing: listing });
    expect(d.kind).toBe('ok');
    if (d.kind === 'ok') expect(d.state.armed_listing).toEqual(listing);
  });
  for (const [name, bad] of [
    ['policy_fp 不是 64 位十六进制', { ...listing, policy_fp: 'abc' }],
    ['agents 为空', { ...listing, agents: [] }],
    ['agents 未升序', { ...listing, agents: ['pi', 'claude'] }],
    ['agents 重复', { ...listing, agents: ['pi', 'pi'] }],
    ['agents 非法 id', { ...listing, agents: ['gemini'] }],
    ['计数为负', { ...listing, projects: -1 }],
    ['计数非整数', { ...listing, excluded: 1.5 }],
    ['at 不是时间戳', { ...listing, at: 'yesterday' }],
    ['缺 unknown_sessions', (({ unknown_sessions: _u, ...r }) => (void _u, r))(listing)],
    ['多余字段(路径不得混进来)', { ...listing, root: '/x' }],
    ['null(清空用删除键,不用 null)', null],
  ] as [string, unknown][]) {
    it(`非法:${name} → 整份 invalid`, () => {
      expect(RsiStateSchema.safeParse({ ...base, armed_listing: bad }).success).toBe(false);
      expect(doc({ ...base, armed_listing: bad })).toEqual({ kind: 'invalid' });
    });
  }
  it('confirm 单独不合规:仍是 confirm_schema_invalid,armed_listing 原样保留', () => {
    const d = doc({ ...base, confirm: { confirmed_at: 'yesterday' }, armed_listing: listing });
    expect(d.kind).toBe('confirm_schema_invalid');
    if (d.kind === 'confirm_schema_invalid') expect(d.state.armed_listing).toEqual(listing);
  });
  it('confirm 不合规且 listing 也非法:整份 invalid(不把别的损坏当成 confirm 失效)', () => {
    expect(
      doc({
        ...base,
        confirm: { confirmed_at: 'yesterday' },
        armed_listing: { ...listing, projects: -1 },
      }),
    ).toEqual({ kind: 'invalid' });
  });
});
