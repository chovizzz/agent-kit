/**
 * W9a 判官裁决纯判定(contracts R20-18.34 ①–⑥、W0-27):取值表逐格、失败分类(转移侧一律 none;读不出 / 来源缺失与「确实没有裁决」用 `growth` 区分)、
 * ④ 校验与 ⑤ 规则绑定的负向用例(每条带正向对照)。只用假读端口,不碰文件系统。
 */
import { describe, expect, it } from 'vitest';
import { ProposalSchema } from '../../../src/contracts/proposal.js';
import { JUDGE_IGNORE_REASONS, JudgeSeenSchema } from '../../../src/contracts/judge-signal.js';
import {
  evaluateJudgeSignal,
  growthBlockOf,
  judgeRecordSha256,
  judgeResultCode,
  judgeSeenOf,
  readJudgeVerdict,
  type JudgeEnv,
  type JudgeNone,
  type JudgeSourceRead,
} from '../../../src/rsi/personal/judge-signal.js';
import {
  LINK,
  PID,
  RULE_SHA,
  RULE_TEXT,
  RUN,
  TARGET,
  env,
  fakeSource,
  okRead,
  personalProposal,
  sessionJudged,
  spawnedJudged,
} from './judge-fixture.js';

type NoneExpect = Pick<JudgeNone, 'reason' | 'display' | 'growth' | 'why'>;

async function noneOf(read: unknown, link: unknown = LINK, e: JudgeEnv = env): Promise<JudgeNone> {
  const s = await evaluateJudgeSignal(
    link,
    fakeSource(() => read),
    e,
  );
  if (s.kind !== 'none') throw new Error(`期望 none,实际 ${s.kind}`);
  return s;
}

const pick = (n: JudgeNone): NoneExpect => ({
  reason: n.reason,
  display: n.display,
  growth: n.growth,
  why: n.why,
});

describe('W9a 判官裁决判定:来源与读失败的取值表', () => {
  it('source_proposal 为 null / 缺失 → no_link:展示 none、增影响拒绝(no_source),且根本不读端口', async () => {
    for (const link of [null, undefined]) {
      const src = fakeSource(() => okRead(sessionJudged({ verdict: 'reject' })));
      const s = await evaluateJudgeSignal(link, src, env);
      expect(s).toEqual({
        kind: 'none',
        reason: 'no_link',
        display: 'none',
        growth: 'no_source',
        why: 'null',
      });
      expect(src.calls).toHaveLength(0);
    }
    // 对照:同一份端口内容,有关联就能读到信号
    const ok = await evaluateJudgeSignal(
      LINK,
      fakeSource(() => okRead(sessionJudged({ verdict: 'reject' }))),
      env,
    );
    expect(ok.kind).toBe('signal');
  });

  it('source_proposal 损坏(多键 / 非法 run_id / 空 proposal_id / 非对象)→ invalid 但按读不出对待(indeterminate),不降级成无关联放行;端口不被调用', async () => {
    const bad: unknown[] = [
      { ...LINK, extra: 1 },
      { run_id: '../x', proposal_id: PID },
      { run_id: RUN, proposal_id: '' },
      { run_id: RUN, proposal_id: 'p1' },
      { run_id: RUN, proposal_id: '../x' },
      { run_id: RUN, proposal_id: '2026-11-09-0011' },
      { run_id: RUN },
      'run-x',
      [RUN, PID],
      7,
    ];
    for (const link of bad) {
      const src = fakeSource(() => okRead(sessionJudged({ verdict: 'reject' })));
      const s = await evaluateJudgeSignal(link, src, env);
      expect(s, JSON.stringify(link)).toEqual({
        kind: 'none',
        reason: 'invalid',
        display: 'invalid',
        growth: 'indeterminate',
        why: 'malformed_link',
      });
      expect(src.calls).toHaveLength(0);
    }
  });

  it('读端口未装配(null)→ unreadable / indeterminate(带 source_proposal 的候选不得增影响);绝不当作「无裁决」', async () => {
    const s = await evaluateJudgeSignal(LINK, null, env);
    expect(s).toEqual({
      kind: 'none',
      reason: 'unreadable',
      display: 'invalid',
      growth: 'indeterminate',
      why: 'unwired',
    });
  });

  it('端口抛错 / 返回非法形状 → unreadable(io / port_contract);永不向外抛', async () => {
    const throwing = fakeSource(() => {
      throw new Error('boom');
    });
    expect(pick((await evaluateJudgeSignal(LINK, throwing, env)) as JudgeNone)).toEqual({
      reason: 'unreadable',
      display: 'invalid',
      growth: 'indeterminate',
      why: 'io',
    });
    const garbage: unknown[] = [
      undefined,
      null,
      'ok',
      { kind: 'weird' },
      { kind: 'ok', proposal: {}, rule: 'text' },
      { kind: 'ok', proposal: {} },
      { kind: 'ok', proposal: {}, rule: { target: 1, text: 'x' } },
      // 信封不完整:缺 proposal / 缺 why / why 类型不对 = 端口违约,不是磁盘上的内容错误(不得落进不阻增影响的 invalid)
      { kind: 'ok', rule: null },
      { kind: 'invalid', why: 42 },
      { kind: 'invalid' },
      { kind: 'unreadable' },
    ];
    for (const g of garbage) {
      expect(pick(await noneOf(g)), JSON.stringify(g)).toEqual({
        reason: 'unreadable',
        display: 'invalid',
        growth: 'indeterminate',
        why: 'port_contract',
      });
    }
  });

  it('端口给出的分类原样映射:run_gone → none / source_gone;run_excluded → none / 不拦;unreadable → invalid / indeterminate;invalid → invalid / 不拦', async () => {
    const table: [JudgeSourceRead, NoneExpect][] = [
      [
        { kind: 'run_gone' },
        { reason: 'run_gone', display: 'none', growth: 'source_gone', why: 'run_gone' },
      ],
      [
        { kind: 'run_excluded' },
        { reason: 'run_excluded', display: 'none', growth: null, why: 'run_excluded' },
      ],
      [
        { kind: 'unreadable', why: 'race' },
        { reason: 'unreadable', display: 'invalid', growth: 'indeterminate', why: 'race' },
      ],
      [
        { kind: 'invalid', why: 'yaml' },
        { reason: 'invalid', display: 'invalid', growth: null, why: 'yaml' },
      ],
    ];
    for (const [read, want] of table) expect(pick(await noneOf(read)), read.kind).toEqual(want);
  });

  it('读超时 → unreadable(timeout),signal 被中止;迟到的结果不产生未处理的拒绝', async () => {
    let late!: (r: JudgeSourceRead) => void;
    let sig!: AbortSignal;
    const src = fakeSource(
      (signal) =>
        new Promise<JudgeSourceRead>((resolve) => {
          sig = signal;
          late = resolve;
        }),
    );
    const s = await evaluateJudgeSignal(LINK, src, env, { budgetMs: 20 });
    expect(pick(s as JudgeNone)).toEqual({
      reason: 'unreadable',
      display: 'invalid',
      growth: 'indeterminate',
      why: 'timeout',
    });
    expect(sig.aborted).toBe(true);
    // 迟到的「可信」结果不会改变已经返回的结论,也不会产生未处理的拒绝
    const rejections: unknown[] = [];
    const onRej = (e: unknown): void => {
      rejections.push(e);
    };
    process.on('unhandledRejection', onRej);
    late(okRead(sessionJudged({ verdict: 'reject' })));
    await new Promise((r) => setTimeout(r, 10));
    process.off('unhandledRejection', onRej);
    expect(rejections).toEqual([]);
    // 对照:预算内返回的同一结果是信号
    const quick = await evaluateJudgeSignal(
      LINK,
      fakeSource(() => okRead(sessionJudged({ verdict: 'reject' }))),
      env,
      { budgetMs: 2000 },
    );
    expect(quick.kind).toBe('signal');
  });
});

describe('W9a 判官裁决判定:墙钟预算', () => {
  it('同步工作占住事件循环、定时器来不及触发时,超预算的结论也不予采信(unreadable / timeout);预算内同一结果是信号', async () => {
    const slow = fakeSource(() => {
      const t0 = performance.now();
      while (performance.now() - t0 < 60) {
        // 故意占住事件循环,模拟同步解析 / 校验超时
      }
      return okRead(sessionJudged({ verdict: 'reject' }));
    });
    const s = await evaluateJudgeSignal(LINK, slow, env, { budgetMs: 20 });
    expect(s).toMatchObject({ kind: 'none', reason: 'unreadable', why: 'timeout' });
    const ok = await evaluateJudgeSignal(LINK, slow, env, { budgetMs: 2000 });
    expect(ok.kind).toBe('signal');
  });
});

describe('W9a 判官裁决判定:③ 提案校验', () => {
  const cases: [string, unknown, NoneExpect][] = [
    [
      '不过 ProposalSchema(多余键)',
      { ...sessionJudged({ verdict: 'reject' }), surprise: 1 },
      { reason: 'invalid', display: 'invalid', growth: null, why: 'schema' },
    ],
    [
      'id 不等于 proposal_id',
      sessionJudged({ verdict: 'reject' }, personalProposal({ id: '2026-11-09-002' })),
      { reason: 'invalid', display: 'invalid', growth: null, why: 'id_mismatch' },
    ],
    [
      'reflector.run_id 不等于 run_id',
      sessionJudged(
        { verdict: 'reject' },
        (() => {
          const p = personalProposal();
          return ProposalSchema.parse({ ...p, reflector: { ...p.reflector, run_id: 'run-other' } });
        })(),
      ),
      { reason: 'invalid', display: 'invalid', growth: null, why: 'run_id_mismatch' },
    ],
    [
      'team 层提案的记录不被消费',
      sessionJudged({ verdict: 'reject' }, personalProposal({ layer: 'team' })),
      { reason: 'invalid', display: 'invalid', growth: null, why: 'layer_not_personal' },
    ],
    [
      'op 不是 add',
      sessionJudged({ verdict: 'reject' }, personalProposal({ op: 'edit' })),
      { reason: 'invalid', display: 'invalid', growth: null, why: 'not_reviewable' },
    ],
    [
      'targets 不是单目标',
      sessionJudged({ verdict: 'reject' }, personalProposal({ targets: [TARGET, 'other-rule'] })),
      { reason: 'invalid', display: 'invalid', growth: null, why: 'not_reviewable' },
    ],
  ];
  it.each(cases)('%s → invalid(内容类:不阻增影响)', async (_n, proposal, want) => {
    expect(pick(await noneOf(okRead(proposal)))).toEqual(want);
  });

  it('对照:同一夹具改回合法(personal / add / 单目标 / id 与 run_id 对齐)→ 信号', async () => {
    const s = await evaluateJudgeSignal(
      LINK,
      fakeSource(() => okRead(sessionJudged({ verdict: 'reject' }))),
      env,
    );
    expect(s.kind).toBe('signal');
  });
});

describe('W9a 判官裁决判定:④ 记录来源与校验', () => {
  it('没有 judge 键 → not_verified,展示 none;校验失败才展示 invalid——两者信号侧同为 not_verified', async () => {
    const absent = await noneOf(okRead(personalProposal()));
    expect(pick(absent)).toEqual({
      reason: 'not_verified',
      display: 'none',
      growth: null,
      why: 'judge_absent',
    });
    // session_confirmed:binding 被改 → 校验失败
    const tampered = sessionJudged({ verdict: 'reject' }, personalProposal());
    const t = JSON.parse(JSON.stringify(tampered)) as {
      judge: { confirmation: { binding_sha256: string } };
    };
    t.judge.confirmation.binding_sha256 = 'f'.repeat(64);
    expect(pick(await noneOf(okRead(t)))).toEqual({
      reason: 'not_verified',
      display: 'invalid',
      growth: null,
      why: 'validation_failed',
    });
  });

  it('session_confirmed 的 reject 记录:binding 被改 / 声明的厂商与模型对不上 → 不消费;有效时消费(正向对照)', async () => {
    const good = sessionJudged({ verdict: 'reject' });
    expect(
      (
        await evaluateJudgeSignal(
          LINK,
          fakeSource(() => okRead(good)),
          env,
        )
      ).kind,
    ).toBe('signal');
    // 改 declared.model(binding 覆盖整条记录)
    const raw = JSON.parse(JSON.stringify(good)) as { judge: { declared: { model: string } } };
    raw.judge.declared.model = 'gpt-other';
    expect(pick(await noneOf(okRead(raw))).reason).toBe('not_verified');
    // 改 verdict:accept → reject 的篡改同样被 binding 发现
    const acc = JSON.parse(JSON.stringify(sessionJudged({ verdict: 'accept' }))) as {
      judge: { verdict: string };
    };
    acc.judge.verdict = 'reject';
    expect(pick(await noneOf(okRead(acc))).reason).toBe('not_verified');
  });

  it('spawned:非 proven(最后一跳槽位与 provider 不符 → JUDGE_* 码)不消费;proven 才消费(正向对照)', async () => {
    const unproven = spawnedJudged({ verdict: 'reject', provider: 'not-the-last-hop' });
    expect(pick(await noneOf(okRead(unproven)))).toEqual({
      reason: 'not_verified',
      display: 'invalid',
      growth: null,
      why: 'validation_failed',
    });
    const proven = spawnedJudged({ verdict: 'reject' });
    const s = await evaluateJudgeSignal(
      LINK,
      fakeSource(() => okRead(proven)),
      env,
    );
    expect(s).toMatchObject({ kind: 'signal', verdict: 'reject', judge_provenance: 'spawned' });
  });

  it('evidence 注入函数抛错 → not_verified(不向外抛,不当作通过)', async () => {
    const throwing: JudgeEnv = {
      ...env,
      judgeEvidence: () => {
        throw new Error('overrides broken');
      },
    };
    const n = await noneOf(okRead(sessionJudged({ verdict: 'reject' })), LINK, throwing);
    expect(pick(n)).toEqual({
      reason: 'not_verified',
      display: 'invalid',
      growth: null,
      why: 'evidence_threw',
    });
  });

  it('证据层级与 provenance 必须配对:注入函数给出错配层级(spawned 却 self_confirmed)→ 不消费', async () => {
    const wrongTier: JudgeEnv = {
      ...env,
      judgeEvidence: () => ({
        side: { tier: 'self_confirmed', vendor: 'openai', model: 'm' },
        issues: [],
      }),
    };
    expect(
      pick(await noneOf(okRead(spawnedJudged({ verdict: 'reject' })), LINK, wrongTier)).reason,
    ).toBe('not_verified');
    // 带 issues 的「通过」也不算
    const withIssue: JudgeEnv = {
      ...env,
      judgeEvidence: (p) => {
        const r = env.judgeEvidence(p);
        return { side: r.side, issues: [{ side: 'judge', code: 'X' }] };
      },
    };
    expect(
      pick(await noneOf(okRead(sessionJudged({ verdict: 'reject' })), LINK, withIssue)).reason,
    ).toBe('not_verified');
  });
});

describe('W9a 判官裁决判定:⑤ 规则文本与评审绑定', () => {
  it('规则文本被改(rule_sha256 不符)→ rule_changed,展示 invalid、不阻增影响;原文 → 信号(正向对照)', async () => {
    const p = sessionJudged({ verdict: 'reject' });
    expect(
      (
        await evaluateJudgeSignal(
          LINK,
          fakeSource(() => okRead(p)),
          env,
        )
      ).kind,
    ).toBe('signal');
    const edited = RULE_TEXT.replace('do: x', 'do: x edited');
    expect(pick(await noneOf(okRead(p, { target: TARGET, text: edited })))).toEqual({
      reason: 'rule_changed',
      display: 'invalid',
      growth: null,
      why: 'rule_sha_mismatch',
    });
    // 只改 status / review_by 不改哈希(ruleSha256 归一化):仍是信号
    const reviewed = RULE_TEXT.replace('review_by: 2027-01-01', 'review_by: 2028-02-02');
    expect(
      (
        await evaluateJudgeSignal(
          LINK,
          fakeSource(() => okRead(p, { target: TARGET, text: reviewed })),
          env,
        )
      ).kind,
    ).toBe('signal');
  });

  it('规则文件不存在 → rule_changed(rule_absent);不是 unreadable', async () => {
    const p = sessionJudged({ verdict: 'reject' });
    expect(pick(await noneOf(okRead(p, null)))).toEqual({
      reason: 'rule_changed',
      display: 'invalid',
      growth: null,
      why: 'rule_absent',
    });
  });

  it('spawned 记录缺 rule_sha256(schema 里可选)不算 ⑤ 通过 → rule_changed;带上匹配的哈希则消费', async () => {
    const unbound = spawnedJudged({ verdict: 'reject', ruleSha: null });
    expect(pick(await noneOf(okRead(unbound)))).toEqual({
      reason: 'rule_changed',
      display: 'invalid',
      growth: null,
      why: 'rule_sha_unbound',
    });
    const bound = spawnedJudged({ verdict: 'reject', ruleSha: RULE_SHA });
    expect(
      (
        await evaluateJudgeSignal(
          LINK,
          fakeSource(() => okRead(bound)),
          env,
        )
      ).kind,
    ).toBe('signal');
  });

  it('规则文本无法哈希(无 frontmatter)→ invalid(rule_unhashable),不抛;规则目标名与提案 targets[0] 不一致 → 端口违约(unreadable)', async () => {
    const p = sessionJudged({ verdict: 'reject' });
    expect(pick(await noneOf(okRead(p, { target: TARGET, text: 'no frontmatter\n' })))).toEqual({
      reason: 'invalid',
      display: 'invalid',
      growth: null,
      why: 'rule_unhashable',
    });
    expect(pick(await noneOf(okRead(p, { target: 'other-rule', text: RULE_TEXT })))).toEqual({
      reason: 'unreadable',
      display: 'invalid',
      growth: 'indeterminate',
      why: 'port_contract',
    });
  });
});

describe('W9a 判官裁决判定:⑥ 信号与二进制取值', () => {
  const signalOf = async (p: unknown) =>
    evaluateJudgeSignal(
      LINK,
      fakeSource(() => okRead(p)),
      env,
    );

  it('reject → reject;injection_suspected → injection;两者同时成立取 injection(accept + injection 也是 injection)', async () => {
    expect(await signalOf(sessionJudged({ verdict: 'reject' }))).toMatchObject({
      kind: 'signal',
      verdict: 'reject',
    });
    expect(await signalOf(sessionJudged({ verdict: 'reject', injection: true }))).toMatchObject({
      kind: 'signal',
      verdict: 'injection',
    });
    expect(await signalOf(sessionJudged({ verdict: 'accept', injection: true }))).toMatchObject({
      kind: 'signal',
      verdict: 'injection',
    });
    expect(await signalOf(spawnedJudged({ verdict: 'reject', injection: true }))).toMatchObject({
      kind: 'signal',
      verdict: 'injection',
      judge_provenance: 'spawned',
    });
  });

  it('accept / revise(无 injection)→ not_tightening,零影响:展示按已校验显示,增影响不拦', async () => {
    for (const verdict of ['accept', 'revise'] as const) {
      for (const make of [sessionJudged, spawnedJudged]) {
        const s = await signalOf(make({ verdict }));
        expect(pick(s as JudgeNone), `${verdict}`).toEqual({
          reason: 'not_tightening',
          display: 'none',
          growth: null,
          why: 'not_tightening',
        });
        // 同一份输入的 ①–⑤ 结果是 verified(展示端用它,⑥ 不适用)
        const v = await readJudgeVerdict(
          LINK,
          fakeSource(() => okRead(make({ verdict }))),
          env,
        );
        expect(v.kind).toBe('verified');
      }
    }
  });

  it('binding_sha256:session 取 confirmation.binding_sha256;spawned 取解析后整条记录的规范 JSON 哈希,显式写与缺省写 provenance 一致', async () => {
    const sess = sessionJudged({ verdict: 'reject' });
    const s = (await signalOf(sess)) as { binding_sha256: string };
    expect(s.binding_sha256).toBe(
      (sess.judge as { confirmation: { binding_sha256: string } }).confirmation.binding_sha256,
    );
    const sp = spawnedJudged({ verdict: 'reject' });
    const explicit = (await signalOf(sp)) as { binding_sha256: string };
    expect(explicit.binding_sha256).toBe(judgeRecordSha256(sp.judge as never));
    // 缺省写:从原始对象里删掉 provenance 键,解析后补上,哈希相同
    const raw = JSON.parse(JSON.stringify(sp)) as { judge: Record<string, unknown> };
    delete raw.judge['provenance'];
    const implicit = (await signalOf(raw)) as { binding_sha256: string };
    expect(implicit.binding_sha256).toBe(explicit.binding_sha256);
    // 对照:记录内容变了哈希就变(--replace 产生新 binding)
    const other = (await signalOf(spawnedJudged({ verdict: 'reject', injection: true }))) as {
      binding_sha256: string;
    };
    expect(other.binding_sha256).not.toBe(explicit.binding_sha256);
    expect(explicit.binding_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('readJudgeVerdict 与 evaluateJudgeSignal 共用 ①–⑤:对每个输入,verified ⇔ (signal | not_tightening);其余两者给出同一个 none', async () => {
    const inputs: unknown[] = [
      okRead(sessionJudged({ verdict: 'reject' })),
      okRead(sessionJudged({ verdict: 'accept' })),
      okRead(spawnedJudged({ verdict: 'revise' })),
      okRead(personalProposal()),
      okRead(sessionJudged({ verdict: 'reject' }), null),
      { kind: 'run_gone' },
      { kind: 'unreadable', why: 'x' },
      { kind: 'bogus' },
    ];
    for (const read of inputs) {
      const v = await readJudgeVerdict(
        LINK,
        fakeSource(() => read),
        env,
      );
      const s = await evaluateJudgeSignal(
        LINK,
        fakeSource(() => read),
        env,
      );
      if (v.kind === 'verified') {
        expect(['signal', 'none']).toContain(s.kind);
        if (s.kind === 'none') expect(s.reason).toBe('not_tightening');
      } else {
        expect(s).toEqual(v);
      }
    }
  });
});

describe('W9a 判官裁决判定:结果代码、judge_seen 与增影响输入', () => {
  it('JUDGE_IGNORE_REASONS 恰为契约的 8 个原因(不新增码)', () => {
    expect([...JUDGE_IGNORE_REASONS]).toEqual([
      'no_link',
      'run_gone',
      'run_excluded',
      'unreadable',
      'invalid',
      'rule_changed',
      'not_verified',
      'not_tightening',
    ]);
  });

  it('judgeResultCode / judgeSeenOf / growthBlockOf 的取值表;judgeSeenOf 的输出总能过 JudgeSeenSchema', async () => {
    const rows: [string, unknown, string, string | null, boolean, string | null][] = [
      // 名称,读结果(null = 未装配),result,binding,indeterminate,growth
      ['未装配', null, 'unreadable', null, true, 'indeterminate'],
      ['run_gone', { kind: 'run_gone' }, 'run_gone', null, false, 'source_gone'],
      ['run_excluded', { kind: 'run_excluded' }, 'run_excluded', null, false, null],
      ['内容 invalid', { kind: 'invalid', why: 'yaml' }, 'invalid', null, false, null],
      ['读不出', { kind: 'unreadable', why: 'io' }, 'unreadable', null, true, 'indeterminate'],
      ['无 judge', okRead(personalProposal()), 'not_verified', null, false, null],
      ['accept', okRead(sessionJudged({ verdict: 'accept' })), 'not_tightening', null, false, null],
    ];
    for (const [name, read, result, binding, indet, growth] of rows) {
      const s = await evaluateJudgeSignal(LINK, read === null ? null : fakeSource(() => read), env);
      expect(judgeResultCode(s), name).toBe(result);
      const seen = judgeSeenOf(s);
      expect(seen, name).toEqual({ result, binding, indeterminate: indet });
      expect(JudgeSeenSchema.safeParse(seen).success, name).toBe(true);
      expect(growthBlockOf(s), name).toBe(growth);
    }
    const rej = await evaluateJudgeSignal(
      LINK,
      fakeSource(() => okRead(sessionJudged({ verdict: 'reject' }))),
      env,
    );
    expect(judgeResultCode(rej)).toBe('judge_reject');
    expect(growthBlockOf(rej)).toBe('signal');
    const seen = judgeSeenOf(rej);
    expect(seen.binding).toMatch(/^[0-9a-f]{64}$/);
    expect(JudgeSeenSchema.safeParse(seen).success).toBe(true);
    const inj = await evaluateJudgeSignal(
      LINK,
      fakeSource(() => okRead(sessionJudged({ verdict: 'reject', injection: true }))),
      env,
    );
    expect(judgeResultCode(inj)).toBe('judge_injection');
  });

  it('no_link 只在增影响一侧被拦(no_source),转移侧与「无裁决」同为 none', async () => {
    const s = await evaluateJudgeSignal(null, null, env);
    expect(s.kind).toBe('none');
    expect(growthBlockOf(s)).toBe('no_source');
    expect(judgeResultCode(s)).toBe('no_link');
  });
});
