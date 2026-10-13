import { describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import {
  AttestSchema,
  JudgeRecordSchema,
  KitConfigSchema,
  LifecycleRecordSchema,
  OverlaySchema,
  SignalSchema,
} from '../../src/contracts/index.js';
import { readText } from '../../src/io/read-fs.js';

const KIT_TOML = new URL('../../kit.toml', import.meta.url).pathname;
const H = '0'.repeat(63) + '5';

const judge = {
  hops: [{ hop: 'codex', vendor: 'openai', model: 'm', result: 'ok' }],
  provider: 'openai',
  vendor: 'openai',
  verdict: 'accept',
  overfit_risk: 'low',
  injection_suspected: false,
  conflicts: [],
};
const signal = {
  sig_id: 'sig_0123456789abcdef',
  agent: 'claude',
  agent_version: '2.1.280',
  agent_version_source: 'session_meta',
  session_ref: 's_0123456789abcdef',
  project_key: 'p_fedcba9876543210',
  ts: '2026-10-12T00:00:00Z',
  type: 'event',
  excerpt_redacted: '',
  external_content: false,
  confidence: 1,
  loaded_rule_ids: [],
};
const attest = {
  schema_version: 1,
  rule_id: 'a-rule',
  rule_sha256: H,
  channel: 'canary',
  member: '@h',
  window_start: '2026-10-09',
  window_end: '2026-10-23',
  kit_version: '0.0.0',
  collector_versions: {},
  sessions_total: 3,
  exposure_sessions: 1,
  exposure_projects: 1,
  fired: 1,
  harmful: 0,
  recurrence: 0,
  signal_ids_digest: 'sha256:' + H,
  run_id: 'run-0001',
};
const rec = {
  schema_version: 1,
  rule_id: 'a-rule',
  kind: 'retire',
  reason: 'manual',
  from_status: 'active',
  to_status: 'deprecated',
  rule_sha256: H,
  attest_digests: [],
  kit_version: '0.1.0',
  run_id: 'run-0001',
  recorded_at: '2026-10-13',
  owner: '@h',
};
const kit = {
  kit: { name: 'x', version: '0.1.0' },
  agents: { enabled: ['claude'] },
  budget: {},
  channels: {},
};

/** 失败时返回 [path, message] 列表,用来精确断言原因。 */
function issues(r: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string; code: string }[] };
}) {
  expect(r.success).toBe(false);
  return r.error!.issues.map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message }));
}

describe('JudgeRecord.rule_sha256', () => {
  it('缺省仍合法;给 64 位小写 hex 合法', () => {
    expect(JudgeRecordSchema.safeParse(judge).success).toBe(true);
    expect(JudgeRecordSchema.parse({ ...judge, rule_sha256: H }).rule_sha256).toBe(H);
  });
  it.each(['ABC', 'A'.repeat(64), '0'.repeat(63), '0'.repeat(65), '', 5])('拒绝 %j', (v) => {
    const is = issues(JudgeRecordSchema.safeParse({ ...judge, rule_sha256: v }));
    expect(is.map((i) => i.path)).toEqual(['rule_sha256']);
  });
});

describe('Signal.event_key', () => {
  it('缺省仍合法;合法字符集通过;128 字符通过', () => {
    expect(SignalSchema.safeParse(signal).success).toBe(true);
    expect(SignalSchema.safeParse({ ...signal, event_key: 'ek_a1.b2:c3-D4' }).success).toBe(true);
    expect(SignalSchema.safeParse({ ...signal, event_key: 'a'.repeat(128) }).success).toBe(true);
  });
  it.each(['', 'a'.repeat(129), 'has space', 'a/b', 'é', 'a\n', 1])('拒绝 %j', (v) => {
    const is = issues(SignalSchema.safeParse({ ...signal, event_key: v }));
    expect(is.map((i) => i.path)).toEqual(['event_key']);
  });
});

describe('Attest.method', () => {
  it('缺省仍合法;signature_proxy_v1 合法;其它拒', () => {
    expect(AttestSchema.safeParse(attest).success).toBe(true);
    expect(AttestSchema.parse({ ...attest, method: 'signature_proxy_v1' }).method).toBe(
      'signature_proxy_v1',
    );
    const is = issues(AttestSchema.safeParse({ ...attest, method: 'other' }));
    expect(is.map((i) => i.path)).toEqual(['method']);
    expect(is[0]!.code).toBe('invalid_value');
  });
});

describe('LifecycleRecord', () => {
  it('合法样例通过(含/不含可选 note、by)', () => {
    expect(LifecycleRecordSchema.safeParse(rec).success).toBe(true);
    expect(LifecycleRecordSchema.safeParse({ ...rec, note: '备注 ok' }).success).toBe(true);
    expect(
      LifecycleRecordSchema.safeParse({ ...rec, reason: 'superseded', by: 'other-rule' }).success,
    ).toBe(true);
    expect(
      LifecycleRecordSchema.safeParse({
        ...rec,
        reason: 'rejected',
        from_status: 'proposed',
        to_status: 'retired',
      }).success,
    ).toBe(true);
  });
  it('strict:未知字段被拒(unrecognized_keys)', () => {
    const is = issues(LifecycleRecordSchema.safeParse({ ...rec, extra: 1 }));
    expect(is).toHaveLength(1);
    expect(is[0]!.code).toBe('unrecognized_keys');
  });
  it('理由码只有六个', () => {
    const is = issues(LifecycleRecordSchema.safeParse({ ...rec, reason: 'whatever' }));
    expect(is.map((i) => i.path)).toEqual(['reason']);
  });
  it.each([
    ['advisory', 'deprecated', 'manual'],
    ['active', 'deprecated', 'harmful'],
    ['active', 'deprecated', 'no_exposure'],
    ['advisory', 'deprecated', 'expired'],
    ['deprecated', 'retired', 'manual'],
    ['deprecated', 'retired', 'expired'],
    ['proposed', 'retired', 'rejected'],
  ])('合法转移 %s→%s 理由 %s 通过', (from_status, to_status, reason) => {
    expect(
      LifecycleRecordSchema.safeParse({ ...rec, from_status, to_status, reason }).success,
    ).toBe(true);
  });
  it('kind 只能是 retire', () => {
    expect(
      issues(LifecycleRecordSchema.safeParse({ ...rec, kind: 'promote' })).map((i) => i.path),
    ).toEqual(['kind']);
  });
  it.each([
    ['active', 'active'],
    ['deprecated', 'advisory'],
    ['retired', 'deprecated'],
    ['advisory', 'retired'],
    ['active', 'retired'],
    ['proposed', 'deprecated'],
  ])('转移 %s→%s 被拒', (from_status, to_status) => {
    const is = issues(LifecycleRecordSchema.safeParse({ ...rec, from_status, to_status }));
    expect(is.some((i) => i.path === 'to_status' && /不在 kit:retire/.test(i.message))).toBe(true);
  });
  it('reason 与方向的搭配', () => {
    const msg = (o: object) =>
      issues(LifecycleRecordSchema.safeParse({ ...rec, ...o })).map(
        (i) => `${i.path}|${i.message}`,
      );
    expect(msg({ reason: 'rejected' })).toEqual(['reason|reason=rejected 只用于 proposed→retired']);
    expect(msg({ from_status: 'proposed', to_status: 'retired' })).toEqual([
      'reason|proposed→retired 的理由只能是 rejected',
    ]);
    expect(msg({ reason: 'harmful', from_status: 'deprecated', to_status: 'retired' })).toEqual([
      'reason|reason=harmful 只用于退到 deprecated(deprecated→retired 不适用)',
    ]);
    expect(
      msg({ reason: 'no_exposure', from_status: 'deprecated', to_status: 'retired' }),
    ).toHaveLength(1);
  });
  it('by:superseded 必填、其它理由不得带、不得等于自己', () => {
    const msg = (o: object) =>
      issues(LifecycleRecordSchema.safeParse({ ...rec, ...o })).map(
        (i) => `${i.path}|${i.message}`,
      );
    expect(msg({ reason: 'superseded' })).toEqual(['by|reason=superseded 必须有 by']);
    expect(msg({ by: 'other-rule' })).toEqual(['by|只有 reason=superseded 可以带 by']);
    expect(msg({ reason: 'superseded', by: 'a-rule' })).toEqual(['by|by 不得等于 rule_id']);
  });
  it('owner 必须是 @handle;recorded_at 必须是真实日期;rule_sha256 形状', () => {
    for (const [k, v] of [
      ['owner', 'handle'],
      ['recorded_at', '2026-02-30'],
      ['rule_sha256', 'zz'],
      ['run_id', 'bad/id'],
    ] as const) {
      expect(
        issues(LifecycleRecordSchema.safeParse({ ...rec, [k]: v })).map((i) => i.path),
      ).toEqual([k]);
    }
  });
  it('note:空串、超 200 字、含零宽/控制/bidi 字符都被拒;200 字通过', () => {
    expect(LifecycleRecordSchema.safeParse({ ...rec, note: 'a'.repeat(200) }).success).toBe(true);
    for (const note of [
      '',
      'a'.repeat(201),
      'x​y',
      'x\u0007y',
      'a\tb',
      'a\nb',
      'a\rb',
      'x‮y',
      'x\u{e0041}y',
    ]) {
      expect(issues(LifecycleRecordSchema.safeParse({ ...rec, note })).map((i) => i.path)).toEqual([
        'note',
      ]);
    }
    const hidden = issues(LifecycleRecordSchema.safeParse({ ...rec, note: 'x​y' }));
    expect(hidden[0]!.message).toBe('note 含不可见/控制字符');
  });
});

describe('KitConfig.lifecycle', () => {
  it('缺省不出现(向后兼容);给空段则套全部默认值', () => {
    expect(KitConfigSchema.parse(kit).lifecycle).toBeUndefined();
    expect(KitConfigSchema.parse({ ...kit, lifecycle: {} }).lifecycle).toEqual({
      canary_window_days: 14,
      min_members: 2,
      min_non_owner_members: 1,
      min_exposure_sessions: 10,
      max_harmful: 0,
      no_exposure_windows: 2,
    });
  });
  it('可以调严', () => {
    const r = KitConfigSchema.parse({
      ...kit,
      lifecycle: {
        canary_window_days: 30,
        min_members: 4,
        min_non_owner_members: 3,
        min_exposure_sessions: 50,
        no_exposure_windows: 3,
      },
    });
    expect(r.lifecycle?.min_members).toBe(4);
  });
  it.each([
    ['canary_window_days', 13],
    ['min_members', 1],
    ['min_non_owner_members', 0],
    ['min_exposure_sessions', 9],
    ['max_harmful', 1],
    ['no_exposure_windows', 1],
    ['canary_window_days', 14.5],
  ])('%s=%s 被拒(只能调严)', (k, v) => {
    const is = issues(KitConfigSchema.safeParse({ ...kit, lifecycle: { [k]: v } }));
    expect(is.map((i) => i.path)).toEqual([`lifecycle.${k}`]);
  });
  it('调得更严不受上限拦截', () => {
    const r = KitConfigSchema.safeParse({
      ...kit,
      lifecycle: {
        canary_window_days: 400,
        min_members: 101,
        min_non_owner_members: 101,
        no_exposure_windows: 60,
      },
    });
    expect(r.success).toBe(true);
  });
  it('strict:未知字段被拒;min_non_owner_members 不得大于 min_members', () => {
    expect(issues(KitConfigSchema.safeParse({ ...kit, lifecycle: { x: 1 } }))[0]!.code).toBe(
      'unrecognized_keys',
    );
    const is = issues(
      KitConfigSchema.safeParse({
        ...kit,
        lifecycle: { min_members: 2, min_non_owner_members: 3 },
      }),
    );
    expect(is.map((i) => `${i.path}|${i.message}`)).toEqual([
      'lifecycle.min_non_owner_members|min_non_owner_members 不得大于 min_members',
    ]);
  });
  it('覆盖层不接受 lifecycle(无论值松紧)', () => {
    for (const lifecycle of [
      {},
      { canary_window_days: 14 },
      { canary_window_days: 1 },
      { canary_window_days: 90 },
    ]) {
      const is = issues(OverlaySchema.safeParse({ lifecycle }));
      expect(is).toHaveLength(1);
      expect(is[0]!.code).toBe('unrecognized_keys');
    }
    expect(OverlaySchema.safeParse({ channel: 'canary' }).success).toBe(true);
  });
  it('kit.toml 的 [lifecycle] 段通过,且等于 schema 默认值', async () => {
    const parsed = parseToml(await readText(KIT_TOML));
    const r = KitConfigSchema.parse(parsed);
    expect(r.lifecycle).toEqual(KitConfigSchema.parse({ ...kit, lifecycle: {} }).lifecycle);
    expect((parsed as { lifecycle: object }).lifecycle).toEqual(r.lifecycle);
  });
});
