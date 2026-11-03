/**
 * R20-A4:会话授权 `[rsi.session]` 的两阶段判定与策略指纹(docs/contracts.md R20-16.1 ~ R20-16.4;夹具矩阵 R20-16.22 第一行)。
 * 纯判定用构造出来的 `RsiConfigOn`;文件层(分层失败:L0 照常)用真实配置 / 真实状态。
 */
import { describe, expect, it } from 'vitest';
import { RsiBaseSchema, RsiSessionSchema } from '../../src/contracts/rsi.js';
import type { RsiConfigOn } from '../../src/rsi/config.js';
import { judgeSession, normalizedSession, sessionPolicyFp } from '../../src/rsi/session.js';
import { observeSessionFacts, stateGate } from '../../src/rsi/session-facts.js';
import { closureOf } from './closure-util.js';
import { SESSION_OK, makeA4World, rewriteCfg } from './a4-fixture.js';

const TODAY = '2026-10-26';

function cfg(
  session: Record<string, unknown> | undefined,
  agents: RsiConfigOn['agents'] = ['claude', 'codex', 'pi'],
): RsiConfigOn {
  return {
    status: 'on',
    repo: '/repo',
    overlayPath: null,
    overlaySha256: null,
    agents,
    excludeDirs: [],
    excludeNames: [],
    block: null,
    warnings: [],
    ...(session !== undefined ? { session } : {}),
  };
}
const good = { enabled: true, agents: ['claude', 'codex'], expires: '2026-12-31' };
const judge = (
  s: Record<string, unknown> | undefined,
  agent: 'claude' | 'codex' | 'pi' = 'claude',
  today = TODAY,
  agents?: RsiConfigOn['agents'],
) => {
  const j = judgeSession(cfg(s, agents), agent, today);
  return j.kind === 'ok' ? 'ok' : j.reason;
};

describe('R20-16.2 RsiSessionSchema(静态校验)', () => {
  it('合法值通过,auto 缺省 s1;L-base 的 session 占位保持「表或缺省」(不严格校验内容)', () => {
    const p = RsiSessionSchema.parse(good);
    expect(p.auto).toBe('s1');
    expect(RsiSessionSchema.parse({ ...good, auto: 's2' }).auto).toBe('s2');
    // L-base 不校验 session 的内部字段
    expect(RsiBaseSchema.safeParse({ session: { enabled: 'yes', whatever: 1 } }).success).toBe(
      true,
    );
    expect(RsiBaseSchema.safeParse({ session: 5 }).success).toBe(false);
  });
  for (const [name, v] of [
    ['enabled 非布尔', { ...good, enabled: 'yes' }],
    ['缺 enabled', { agents: good.agents, expires: good.expires }],
    ['缺 agents', { enabled: true, expires: good.expires }],
    ['agents 为空', { ...good, agents: [] }],
    ['agents 重复', { ...good, agents: ['claude', 'claude'] }],
    ['agents 含未知 agent', { ...good, agents: ['kimi'] }],
    ['日期格式非法', { ...good, expires: '2026/12/31' }],
    ['日期不是真实日历日', { ...good, expires: '2026-02-30' }],
    ['缺 expires', { enabled: true, agents: good.agents }],
    ['auto 非法', { ...good, auto: 's3' }],
    ['未知字段', { ...good, scope: 'all' }],
  ] as [string, unknown][]) {
    it(`静态拒绝:${name}`, () => expect(RsiSessionSchema.safeParse(v).success).toBe(false));
  }
});

describe('R20-16.3 判定(按顺序取第一个命中)', () => {
  it('① 表缺失 / enabled 恰为 false → off(其余字段不校验)', () => {
    expect(judge(undefined)).toBe('off');
    expect(judge({ enabled: false })).toBe('off');
    expect(judge({ enabled: false, agents: 'garbage', expires: 5, extra: 1 })).toBe('off');
    // 对照:enabled 不是 false 的非法值走 ②
    expect(judge({ enabled: 0 })).toBe('invalid');
  });
  it('② schema 不过 → invalid(含 enabled 非布尔、日期非法、未知字段)', () => {
    expect(judge({ ...good, enabled: 'true' })).toBe('invalid');
    expect(judge({ ...good, expires: '2026-13-01' })).toBe('invalid');
    expect(judge({ ...good, bogus: 1 })).toBe('invalid');
  });
  it('③ agents 不是 [rsi] agents 的子集 → invalid(早于过期判定)', () => {
    expect(
      judge({ ...good, agents: ['claude', 'pi'], expires: '2020-01-01' }, 'claude', TODAY, [
        'claude',
      ]),
    ).toBe('invalid');
    // 对照:是子集则继续往下判
    expect(judge({ ...good, agents: ['claude'] }, 'claude', TODAY, ['claude'])).toBe('ok');
  });
  it('④ 今天 < expires ≤ 今天 + 90 天,否则 expired(边界:今天、昨天、+90、+91)', () => {
    expect(judge({ ...good, expires: TODAY })).toBe('expired');
    expect(judge({ ...good, expires: '2026-10-25' })).toBe('expired');
    expect(judge({ ...good, expires: '2026-10-27' })).toBe('ok');
    expect(judge({ ...good, expires: '2027-01-24' })).toBe('ok');
    expect(judge({ ...good, expires: '2027-01-25' })).toBe('expired');
  });
  it('⑤ 声明的 agent 不在 agents → agent_not_authorized;⑥ 否则 ok', () => {
    expect(judge(good, 'pi')).toBe('agent_not_authorized');
    expect(judge(good, 'codex')).toBe('ok');
    const j = judgeSession(cfg(good), 'claude', TODAY);
    expect(j.kind === 'ok' && j.session.auto).toBe('s1');
  });
});

describe('R20-16.4 session_policy_fp', () => {
  const dev = { dev: 1, ino: 2 };
  const fp = async (c: RsiConfigOn, d = dev): Promise<string> =>
    sessionPolicyFp(c, normalizedSession(c), d);
  it('授权 / [rsi] agents / 排除项 / repo 身份 / auto 任一变化,指纹变;agents 顺序不影响', async () => {
    const base = await fp(cfg(good));
    expect(await fp(cfg({ ...good, agents: ['codex', 'claude'] }))).toBe(base);
    expect(await fp(cfg({ ...good, expires: '2026-12-30' }))).not.toBe(base);
    expect(await fp(cfg({ ...good, auto: 's2' }))).not.toBe(base);
    expect(await fp(cfg({ ...good, enabled: false }))).not.toBe(base);
    expect(await fp(cfg(good, ['claude', 'codex']))).not.toBe(base);
    expect(await fp({ ...cfg(good), excludeDirs: ['/a'] })).not.toBe(base);
    expect(await fp({ ...cfg(good), excludeNames: ['n'] })).not.toBe(base);
    expect(await fp({ ...cfg(good), overlaySha256: 'a'.repeat(64) })).not.toBe(base);
    expect(await fp(cfg(good), { dev: 1, ino: 3 })).not.toBe(base);
    expect(await fp(cfg(good))).toBe(base); // 确定性
  });
});

describe('分层失败(R20-16.1 / R20-16.22):会话授权的任何非 ok 都只禁用会话授权,[rsi] 配置与状态机照常', () => {
  const variants: [string, string | null, string][] = [
    ['缺表', null, 'off'],
    [
      'enabled=false',
      '[rsi.session]\nenabled = false\nagents = ["claude"]\nexpires = "2026-12-31"\n',
      'off',
    ],
    [
      'schema 错',
      '[rsi.session]\nenabled = true\nagents = ["claude"]\nexpires = "soon"\n',
      'invalid',
    ],
    [
      'agents 非子集',
      '[rsi.session]\nenabled = true\nagents = ["claude", "pi"]\nexpires = "2026-12-31"\n',
      'invalid',
    ],
    [
      '已过期',
      '[rsi.session]\nenabled = true\nagents = ["claude"]\nexpires = "2026-10-01"\n',
      'expired',
    ],
    [
      '超过 90 天',
      '[rsi.session]\nenabled = true\nagents = ["claude"]\nexpires = "2027-06-01"\n',
      'expired',
    ],
    [
      'agent 未授权',
      '[rsi.session]\nenabled = true\nagents = ["pi"]\nexpires = "2026-12-31"\n',
      'agent_not_authorized',
    ],
  ];
  for (const [name, session, want] of variants) {
    it(`${name} → ${want};配置仍是 on,状态仍是 confirmed(L0 的入口条件不变)`, async () => {
      const w = await makeA4World('a4-sess-', {
        session,
        // agents 非子集:让 [rsi] agents 不含 pi
        ...(name === 'agents 非子集' ? { rsiExtra: 'agents = ["claude", "codex"]\n' } : {}),
      });
      const f = await observeSessionFacts(w.s.io, w.env, 'claude', '2026-10-26');
      expect(f.config.status).toBe('on');
      expect(f.state?.state).toBe('confirmed');
      expect(stateGate(f)).toBeNull();
      expect(f.judgement).toEqual({ kind: 'denied', reason: want });
    });
  }
  it('正向对照:合法授权 → ok;改回合法后再读即恢复(不缓存)', async () => {
    const w = await makeA4World('a4-sess-ok-', { session: null });
    expect((await observeSessionFacts(w.s.io, w.env, 'claude', '2026-10-26')).judgement).toEqual({
      kind: 'denied',
      reason: 'off',
    });
    await rewriteCfg(w, { session: SESSION_OK });
    const f = await observeSessionFacts(w.s.io, w.env, 'claude', '2026-10-26');
    expect(f.judgement?.kind).toBe('ok');
  });
  it('静态:L0 入口(tick / 采集)的 import 闭包不含会话授权判定与 digest(分层失败的结构保证)', () => {
    const c = closureOf(['src/rsi/tick.ts']);
    expect(c.files.has('src/rsi/tick.ts')).toBe(true); // 正向前提:闭包确实算出来了
    expect(c.files.has('src/rsi/session.ts')).toBe(false);
    expect(c.files.has('src/rsi/digest.ts')).toBe(false);
  });
});
