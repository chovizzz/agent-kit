/**
 * W9a「关联提案裁决」展示端口(`auto/read/judge-verdict.ts`;contracts R20-18.37、W0-27):对同一份纯判定只做展示映射。
 * 取值:无裁决 → absent(`judge=none`);读 / 解析 / 校验失败、rule_changed、未装配 → invalid(`judge=invalid`);已校验 → ok(session_confirmed 带 declared 三项,spawned 带 proven 的 vendor / model)。
 */
import { describe, expect, it } from 'vitest';
import { makeJudgeVerdictPort } from '../../../src/rsi/auto/read/judge-verdict.js';
import {
  evaluateJudgeSignal,
  type JudgeSourceRead,
} from '../../../src/rsi/personal/judge-signal.js';
import {
  LINK,
  PID,
  RULE_TEXT,
  RUN,
  TARGET,
  env,
  fakeSource,
  okRead,
  personalProposal,
  sessionJudged,
  spawnedJudged,
} from '../personal/judge-fixture.js';

const verdictOf = async (read: unknown) =>
  makeJudgeVerdictPort(read === null ? null : fakeSource(() => read), env).verdictFor(RUN, PID);

describe('W9a 展示端口:取值映射', () => {
  it('确实无裁决 → absent:无 judge 键、run_gone、run_excluded(不暴露原因)', async () => {
    expect(await verdictOf(okRead(personalProposal()))).toEqual({ kind: 'absent' });
    expect(await verdictOf({ kind: 'run_gone' })).toEqual({ kind: 'absent' });
    expect(await verdictOf({ kind: 'run_excluded' })).toEqual({ kind: 'absent' });
  });

  it('读 / 解析 / 校验失败 → invalid:unreadable、内容 invalid、校验失败、rule_changed、规则缺失、未装配;端口抛错也是 invalid', async () => {
    const tampered = JSON.parse(JSON.stringify(sessionJudged({ verdict: 'reject' }))) as {
      judge: { confirmation: { binding_sha256: string } };
    };
    tampered.judge.confirmation.binding_sha256 = 'e'.repeat(64);
    const cases: [string, unknown][] = [
      ['unreadable', { kind: 'unreadable', why: 'io' }],
      ['内容 invalid', { kind: 'invalid', why: 'yaml' }],
      ['校验失败', okRead(tampered)],
      [
        'rule_changed',
        okRead(sessionJudged({ verdict: 'reject' }), { target: TARGET, text: `${RULE_TEXT}# x\n` }),
      ],
      ['规则缺失', okRead(sessionJudged({ verdict: 'reject' }), null)],
      ['未装配', null],
      ['端口返回非法值', { kind: 'bogus' }],
    ];
    for (const [name, read] of cases)
      expect(await verdictOf(read), name).toEqual({ kind: 'invalid' });
    const throwing = makeJudgeVerdictPort(
      fakeSource(() => {
        throw new Error('x');
      }),
      env,
    );
    expect(await throwing.verdictFor(RUN, PID)).toEqual({ kind: 'invalid' });
  });

  it('已校验的 session_confirmed:字段取契约值,declared 是 agent / vendor / model 三项;accept 也显示(⑥ 不适用于展示)', async () => {
    const v = await verdictOf(okRead(sessionJudged({ verdict: 'accept' })));
    expect(v).toEqual({
      kind: 'ok',
      judge_provenance: 'session_confirmed',
      verdict: 'accept',
      overfit: 'low',
      injection: 'false',
      identity: { kind: 'declared', agent: 'codex', vendor: 'openai', model: 'gpt-example' },
    });
    const inj = await verdictOf(okRead(sessionJudged({ verdict: 'reject', injection: true })));
    expect(inj).toMatchObject({ kind: 'ok', verdict: 'reject', injection: 'true' });
  });

  it('已校验的 spawned(proven):identity 是 proven 的 vendor / model,没有 declared', async () => {
    const v = await verdictOf(okRead(spawnedJudged({ verdict: 'revise' })));
    expect(v).toMatchObject({
      kind: 'ok',
      judge_provenance: 'spawned',
      verdict: 'revise',
      identity: { kind: 'proven', vendor: 'openai', model: 'gpt-example' },
    });
    // 非 proven 的 spawned(厂商不可复算)不显示为已校验,而是 invalid
    expect(await verdictOf(okRead(spawnedJudged({ provider: 'not-the-last-hop' })))).toEqual({
      kind: 'invalid',
    });
  });

  it('展示与消费同判:对每个输入,展示为 ok ⇔ 消费侧 ①–⑤ 通过;展示 ok 且 reject / injection ⇔ 消费侧是信号', async () => {
    const reads: JudgeSourceRead[] = [
      okRead(sessionJudged({ verdict: 'reject' })),
      okRead(sessionJudged({ verdict: 'accept' })),
      okRead(spawnedJudged({ verdict: 'reject' })),
      okRead(spawnedJudged({ verdict: 'revise', injection: true })),
      okRead(personalProposal()),
      okRead(sessionJudged({ verdict: 'reject' }), null),
      { kind: 'run_gone' },
      { kind: 'unreadable', why: 'race' },
    ];
    for (const read of reads) {
      const shown = await verdictOf(read);
      const eaten = await evaluateJudgeSignal(
        LINK,
        fakeSource(() => read),
        env,
      );
      const tightening =
        shown.kind === 'ok' && (shown.verdict === 'reject' || shown.injection === 'true');
      expect(eaten.kind === 'signal', JSON.stringify(read).slice(0, 60)).toBe(tightening);
      if (shown.kind === 'ok') {
        expect(
          eaten.kind === 'signal' || (eaten.kind === 'none' && eaten.reason === 'not_tightening'),
        ).toBe(true);
      }
    }
  });
});
