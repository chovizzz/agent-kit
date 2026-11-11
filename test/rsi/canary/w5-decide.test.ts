/**
 * W5 hint `--canary` 判定顺序(R21-6.11 矩阵 + W0-3 第 2 / 2a 行):每一行一个正向用例与相邻行的负向用例。
 * 判定只读许可端口、不写盘;端口记录被读的输入,用来证明「前一行命中后不读后面的输入」。
 */
import { describe, expect, it } from 'vitest';
import {
  decideCanary,
  ROW4_ORDER,
  type DecideInput,
} from '../../../src/rsi/canary/canary-decide.js';
import {
  CID,
  OTHER_CID,
  POLICY,
  REVOKE,
  SHA,
  T0,
  adm,
  admitted,
  canaryDoc,
  fakePort,
  ok,
  probing,
  type PortState,
} from './w5-fixture.js';

type Case = [name: string, state: PortState, over: Partial<DecideInput>];

function input(
  s: PortState,
  over: Partial<DecideInput> = {},
): DecideInput & { port: ReturnType<typeof fakePort> } {
  const port = fakePort(s);
  return {
    agent: 'claude',
    autoLoopEffective: true,
    phase: 2,
    policyFp: POLICY,
    shapeVersion: 'claude-1',
    agentVersion: '2.1.0',
    nowMs: T0,
    ...over,
    port,
  };
}

/** 一个完全放行的世界:准入已过、候选在、无撤销 */
const GOOD: PortState = {
  admission: ok(adm(admitted())),
  canary: ok(canaryDoc()),
  revocations: { kind: 'absent' },
};

describe('第 2 行:自动循环 / 相位 / codex', () => {
  it('自动循环未开启 → none(2),一个输入都不读', async () => {
    const i = input(GOOD, { autoLoopEffective: false });
    expect(await decideCanary(i)).toEqual({ kind: 'none', row: 2 });
    expect(i.port.calls).toEqual([]);
  });
  it('RSI_AUTO_PHASE 为 1(< 2,未到 V1b)→ none(2),不读输入', async () => {
    const i = input(GOOD, { phase: 1 });
    expect(await decideCanary(i)).toEqual({ kind: 'none', row: 2 });
    expect(i.port.calls).toEqual([]);
  });
  it('agent 为 codex → none(2),不读输入', async () => {
    const i = input(GOOD, { agent: 'codex' });
    expect(await decideCanary(i)).toEqual({ kind: 'none', row: 2 });
    expect(i.port.calls).toEqual([]);
  });
  it('相位 2、自动循环有效、claude → 越过第 2 行(随机)', async () => {
    expect((await decideCanary(input(GOOD))).kind).toBe('randomize');
  });
});

describe('第 2a 行:探针先于候选存在性检查', () => {
  const PROBING: PortState = { admission: ok(adm(probing())) };
  it('probing 且未过期、版本一致 → probe,与候选无关(canary.json 不存在,也不被读)', async () => {
    const i = input(PROBING);
    const d = await decideCanary(i);
    expect(d.kind).toBe('probe');
    expect(i.port.calls).not.toContain('canary');
  });
  it('probing 仍然先于候选:canary.json 已存在且合法时,探针行照样命中', async () => {
    expect((await decideCanary(input({ ...PROBING, canary: ok(canaryDoc()) }))).kind).toBe('probe');
  });
  const failed = probing({
    state: 'failed',
    decided_at: '2026-11-10T00:00:00Z',
    reason: 'probe_expired',
  });
  const cases: Case[] = [
    ['AUTO_PAUSE 在场', { ...PROBING, pause: 'present' }, {}],
    ['AUTO_PAUSE 读取失败', { ...PROBING, pause: 'unreadable' }, {}],
    ['已过期(now = probe_expires_at)', PROBING, { nowMs: Date.parse('2026-11-16T00:00:00Z') }],
    ['shape_version 不一致', PROBING, { shapeVersion: 'claude-2' }],
    ['agent_version 不一致', PROBING, { agentVersion: '2.2.0' }],
    ['agent_version 现算不出(null)', PROBING, { agentVersion: null }],
    ['状态是 admitted 而非 probing', { admission: ok(adm(admitted())) }, {}],
    ['状态是 failed', { admission: ok(adm(failed)) }, {}],
    ['该 agent 没有条目', { admission: ok({ schema_version: 1, agents: {} }) }, {}],
    ['准入文件读取失败', { admission: { kind: 'unreadable' } }, {}],
  ];
  it.each(cases)('探针条件不成立(%s)→ 不是 probe,继续走第 3 行', async (_n, s, over) => {
    const d = await decideCanary(input(s, over));
    expect(d.kind).not.toBe('probe');
    expect(d).toEqual({ kind: 'none', row: 3 });
  });
  it('条目的 agent_version 为 null、现算也是 null:不放行(不因 null == null 通过)', async () => {
    const e = probing({ agent_version: null });
    const d = await decideCanary(input({ admission: ok(adm(e)) }, { agentVersion: null }));
    expect(d.kind).not.toBe('probe');
  });
  it('第 2 行优先于探针:相位 1 时即使 probing 也不探', async () => {
    expect(await decideCanary(input(PROBING, { phase: 1 }))).toEqual({ kind: 'none', row: 2 });
  });
});

describe('第 3 行:没有合法候选', () => {
  const rows: [string, PortState['canary']][] = [
    ['canary.json 不存在', { kind: 'absent' }],
    ['canary.json 读取 / 解析失败', { kind: 'unreadable' }],
    [
      'content_sha12 与 content_sha256 前 12 位不符',
      ok(canaryDoc({ content_sha12: 'f'.repeat(12) })),
    ],
    ['在 agents_inject 里的 agent 没有 p', ok(canaryDoc({ p_by_agent: {} }))],
    [
      'p_by_agent 有不在 agents_inject 里的项',
      ok(canaryDoc({ p_by_agent: { claude: 0.5, pi: 0.5 } })),
    ],
    [
      '正文含关联标记前缀',
      ok(canaryDoc({ body: '做:x\nagent-kit RSI 关联标记: rsm_0000000000000000' })),
    ],
    ['treat 输出超过 1536 字节', ok(canaryDoc({ body: '中'.repeat(520) }))],
  ];
  it.each(rows)('%s → none(3),不读撤销凭据', async (_n, canary) => {
    const i = input({ ...GOOD, ...(canary === undefined ? {} : { canary }) });
    expect(await decideCanary(i)).toEqual({ kind: 'none', row: 3 });
    expect(i.port.calls).not.toContain('revocations');
  });
});

describe('第 4 行:已知候选的排除原因(固定顺序)', () => {
  const reasonOf = async (s: PortState, over: Partial<DecideInput> = {}): Promise<string> => {
    const d = await decideCanary(input(s, over));
    if (d.kind !== 'excluded') throw new Error(`期望 excluded,实际 ${d.kind}`);
    return `${d.row}:${d.reason}`;
  };
  it('AUTO_PAUSE 在场 → paused', async () => {
    expect(await reasonOf({ ...GOOD, pause: 'present' })).toBe('4:paused');
  });
  it('准入文件不存在 / 该 agent 无条目 / 非 admitted / 版本不一致 → not_admitted', async () => {
    expect(await reasonOf({ ...GOOD, admission: { kind: 'absent' } })).toBe('4:not_admitted');
    expect(await reasonOf({ ...GOOD, admission: ok({ schema_version: 1, agents: {} }) })).toBe(
      '4:not_admitted',
    );
    expect(await reasonOf({ ...GOOD, admission: ok(adm(probing())) })).toBe('4:not_admitted');
    expect(await reasonOf(GOOD, { shapeVersion: 'claude-9' })).toBe('4:not_admitted');
    expect(await reasonOf(GOOD, { agentVersion: '9.9.9' })).toBe('4:not_admitted');
    expect(await reasonOf(GOOD, { agentVersion: null })).toBe('4:not_admitted');
  });
  it('policy_fp 与现算不等 → policy_mismatch(排除写下后下一次 hint 即停)', async () => {
    expect(await reasonOf(GOOD, { policyFp: 'c'.repeat(64) })).toBe('4:policy_mismatch');
  });
  it('agent 不在 agents_inject → agent_not_injected', async () => {
    const canary = ok(canaryDoc({ agents_inject: ['pi'], p_by_agent: { pi: 0.5 } }));
    expect(await reasonOf({ ...GOOD, canary })).toBe('4:agent_not_injected');
  });
  it('撤销凭据含 (candidate_id, content_sha256) → revoked', async () => {
    expect(await reasonOf({ ...GOOD, revocations: ok([REVOKE()]) })).toBe('4:revoked');
  });
  it('撤销凭据只命中 id 不命中 content_sha256、或只命中 sha 不命中 id → 不算撤销(负向)', async () => {
    const a = await decideCanary(
      input({ ...GOOD, revocations: ok([REVOKE(CID, 'd'.repeat(64))]) }),
    );
    expect(a.kind).toBe('randomize');
    const b = await decideCanary(input({ ...GOOD, revocations: ok([REVOKE(OTHER_CID, SHA)]) }));
    expect(b.kind).toBe('randomize');
  });
  it('多个原因同时成立时按固定顺序取第一个', async () => {
    expect([...ROW4_ORDER]).toEqual([
      'paused',
      'not_admitted',
      'policy_mismatch',
      'agent_not_injected',
      'revoked',
    ]);
    const bad = 'c'.repeat(64);
    const all: PortState = {
      pause: 'present',
      admission: { kind: 'absent' },
      canary: ok(canaryDoc({ agents_inject: ['pi'], p_by_agent: { pi: 0.5 } })),
      revocations: ok([REVOKE()]),
    };
    expect(await reasonOf(all, { policyFp: bad })).toBe('4:paused');
    expect(await reasonOf({ ...all, pause: 'absent' }, { policyFp: bad })).toBe('4:not_admitted');
    const adm1 = { ...all, pause: 'absent' as const, admission: ok(adm(admitted())) };
    expect(await reasonOf(adm1, { policyFp: bad })).toBe('4:policy_mismatch');
    expect(await reasonOf(adm1)).toBe('4:agent_not_injected');
  });
});

describe('第 4a 行:读不到 ≠ 不存在', () => {
  const unread = { kind: 'unreadable' } as const;
  it('撤销凭据读取失败(含超过 1MiB)→ permit_unreadable,不是「没有撤销」', async () => {
    const d = await decideCanary(input({ ...GOOD, revocations: unread }));
    expect(d).toMatchObject({ kind: 'excluded', row: '4a', reason: 'permit_unreadable' });
  });
  it('准入文件读取失败 → permit_unreadable,不是 not_admitted', async () => {
    const d = await decideCanary(input({ ...GOOD, admission: unread }));
    expect(d).toMatchObject({ kind: 'excluded', row: '4a', reason: 'permit_unreadable' });
  });
  it('AUTO_PAUSE 读取失败 → permit_unreadable,不是 paused 也不是「无暂停」', async () => {
    const d = await decideCanary(input({ ...GOOD, pause: 'unreadable' }));
    expect(d).toMatchObject({ kind: 'excluded', row: '4a', reason: 'permit_unreadable' });
  });
  it('已确证的第 4 行原因优先于 4a:准入读不到但 policy 不符 → policy_mismatch', async () => {
    const d = await decideCanary(
      input({ ...GOOD, admission: unread }, { policyFp: 'c'.repeat(64) }),
    );
    expect(d).toMatchObject({ kind: 'excluded', row: 4, reason: 'policy_mismatch' });
  });
});

describe('随机之前的最后一道', () => {
  it('全部放行 → randomize,带候选与该 agent 的 p', async () => {
    const d = await decideCanary(input(GOOD));
    expect(d).toMatchObject({ kind: 'randomize', p: 0.5 });
    if (d.kind === 'randomize') expect(d.doc.candidate_id).toBe(CID);
  });
});
