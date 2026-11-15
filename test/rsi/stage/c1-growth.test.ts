/**
 * C1a:增影响授权——`evaluateGrowth` 的纯判定(按 op 的检查子集、优先级、fail-closed)、`GrowthPass` 的一次性与 `gen` 失效、`requireGrowth` / `checkGrowthVeto`。
 * 每条不变量一个负向用例 + 一个正向对照;期望值由测试自己手写(不从被测的表里派生)。
 */
import { describe, expect, it } from 'vitest';
import { RsiLockError } from '../../../src/rsi/lock-error.js';
import { UNAVAILABLE_JUDGE } from '../../../src/rsi/personal/judge-slot.js';
import {
  PersonalLockLost,
  RoundInternalError,
  STALE_GROWTH_REASONS,
  StaleGrowth,
} from '../../../src/rsi/personal/stage/errors.js';
import {
  CHECK_FAILURE_CODE,
  CHECK_ORDER,
  GROWTH_DENY_CODES,
  GROWTH_OPS,
  OP_CHECK_PROFILE,
  evaluateGrowth,
  growthDenied,
  isGrowthPass,
  opOfReq,
  requireGrowth,
  checkGrowthVeto,
  sameOp,
  type GrowthOp,
  type GrowthPass,
  type GrowthReq,
  type GrowthReaders,
  type GrowthStage,
} from '../../../src/rsi/personal/stage/growth.js';
import {
  markRoundUnsettled,
  recordJudgeBlocked,
  type BothRound,
} from '../../../src/rsi/personal/stage/round.js';
import { WRITE_KINDS } from '../../../src/rsi/personal/stage/types.js';
import { STAGE_ALL, cand, openBoth, readers, rec } from './c1-fixture.js';

const reqOf = (op: GrowthReq['op'], c = cand()): GrowthReq =>
  op === 'shadow_to_canary' || op === 'grant' || op === 'deploy_inject'
    ? { op, cand: c }
    : ({ op } as GrowthReq);

async function pass(round: BothRound, req: GrowthReq, r = readers()): Promise<GrowthPass> {
  const v = await evaluateGrowth(round, req, r, STAGE_ALL);
  if (!isGrowthPass(v)) throw new Error(`expected pass, got ${JSON.stringify(v)}`);
  return v;
}
/** 铸造 + 现读外部否决事实(无否决):D 的合法写序 evaluateGrowth → checkGrowthVeto → 写(内含 requireGrowth) */
async function readyPass(round: BothRound, req: GrowthReq): Promise<GrowthPass> {
  const p = await pass(round, req);
  await checkGrowthVeto(p, round, opOfReq(req), readers());
  return p;
}
const deny = async (
  round: BothRound,
  req: GrowthReq,
  r: GrowthReaders,
  stage: GrowthStage | null = STAGE_ALL, // null = 没有 stage(传给 evaluateGrowth 的是 undefined;不能用 undefined 触发默认值)
): Promise<string> => {
  const v = await evaluateGrowth(round, req, r, stage ?? undefined);
  if (isGrowthPass(v)) return 'PASS';
  return (v as { code: string }).code;
};

describe('冻结的取值', () => {
  it('GrowthDeny 全集与顺序(v1 §8 旧码 + update_busy / taint_conflict + D v4 b5 三码)', () => {
    expect([...GROWTH_DENY_CODES]).toEqual([
      'phase',
      'growth_unwired',
      'config',
      'state_invalid',
      'paused',
      'flags',
      'safety_fault',
      'repo',
      'recovery_incomplete',
      'reconcile_incomplete',
      'store_unreadable',
      'store_full',
      'taint_pending',
      'taint_unavailable',
      'purge',
      'judge_unavailable',
      'judge_indeterminate',
      'judge_signal_pending',
      'source_unknown',
      'throttled',
      'personal_busy',
      'personal_fault',
      'unsettled',
      'admission',
      'lock_lost',
      'update_busy',
      'taint_conflict',
      'near_fp_unavailable',
      'fp_key_unavailable',
      'creation_unready',
    ]);
  });

  it('GROWTH_OPS / CHECK_ORDER / StaleGrowth 原因', () => {
    expect([...GROWTH_OPS]).toEqual([
      'bootstrap',
      'candidate_create',
      'admission',
      'shadow_to_canary',
      'grant',
      'deploy_inject',
    ]);
    expect([...CHECK_ORDER]).toEqual([
      'G1',
      'G2',
      'G3',
      'G4',
      'G5',
      'G6',
      'G7',
      'G8',
      'G9',
      'G11',
      'extra',
    ]);
    expect([...STALE_GROWTH_REASONS]).toEqual([
      'not_minted',
      'already_used',
      'nonce_mismatch',
      'round_mismatch',
      'gen_changed',
      'op_mismatch',
      'unsettled',
      'vetoed',
      'veto_unreadable',
      'veto_not_checked',
      'veto_check_in_flight',
    ]);
  });

  it('按 op 的检查子集表(D v4 §3.3)——整张逐格钉死', () => {
    const P = (
      G1: string,
      G2: string,
      G3: string,
      G4: string,
      G5: string,
      G6: string,
      G7: string,
      G8: string,
      G9: string,
      G10: string,
      G11: string,
      extra: string,
    ) => ({ G1, G2, G3, G4, G5, G6, G7, G8, G9, G10, G11, extra });
    expect(OP_CHECK_PROFILE).toEqual({
      bootstrap: P(
        'on',
        'on',
        'valid_only',
        'off',
        'off',
        'prereq',
        'prereq',
        'off',
        'off',
        'on',
        'off',
        'on',
      ),
      candidate_create: P(
        'on',
        'on',
        'full',
        'on',
        'on',
        'rescan',
        'on',
        'off',
        'implied',
        'on',
        'off',
        'on',
      ),
      shadow_to_canary: P(
        'on',
        'on',
        'full',
        'on',
        'on',
        'cand',
        'on',
        'on',
        'on',
        'on',
        'wired_only',
        'on',
      ),
      grant: P('on', 'on', 'full', 'on', 'on', 'cand', 'on', 'on', 'on', 'on', 'versions', 'on'),
      deploy_inject: P(
        'on',
        'on',
        'full',
        'on',
        'on',
        'cand',
        'on',
        'on',
        'on',
        'on',
        'versions',
        'on',
      ),
      admission: P('on', 'on', 'full', 'off', 'on', 'off', 'on', 'off', 'on', 'on', 'off', 'off'),
    });
  });

  it('读失败的 fail-closed 码逐项固定', () => {
    expect(CHECK_FAILURE_CODE).toEqual({
      G1: 'phase',
      G2: 'config',
      G3: 'state_invalid',
      G4: 'repo',
      G5: 'store_unreadable',
      G6: 'taint_unavailable',
      G7: 'purge',
      G8: 'judge_indeterminate',
      G9: 'throttled',
      G11: 'admission',
      extra: 'creation_unready',
    });
  });
});

describe('growth_stage_missing_op_growth_unwired(先于任何其它码,零 reader 调用)', () => {
  it.each(GROWTH_OPS)(
    '%s:stage 缺失 / ops 缺项 / ops 非 Set → growth_unwired,reader 零调用',
    async (op) => {
      const { round } = await openBoth();
      for (const stage of [
        null,
        { ops: new Set<never>() },
        { ops: new Set(GROWTH_OPS.filter((o) => o !== op)) },
        { ops: [...GROWTH_OPS] as unknown as ReadonlySet<never> },
      ]) {
        const r = readers({ capability: () => Promise.resolve({ ready: false }) });
        expect(await deny(round, reqOf(op), r, stage as GrowthStage | null)).toBe('growth_unwired');
        expect(r.calls).toEqual([]);
      }
      // 正向对照:ops 含本 op → 通过
      expect(await deny(round, reqOf(op), readers(), { ops: new Set([op]) })).toBe('PASS');
    },
  );

  it('D3 前的装配态:ops = {bootstrap, candidate_create} 时其余 op 仍 unwired', async () => {
    const { round } = await openBoth();
    const stage: GrowthStage = { ops: new Set(['bootstrap', 'candidate_create']) };
    expect(await deny(round, reqOf('bootstrap'), readers(), stage)).toBe('PASS');
    expect(await deny(round, reqOf('candidate_create'), readers(), stage)).toBe('PASS');
    for (const op of ['admission', 'shadow_to_canary', 'grant', 'deploy_inject'] as const) {
      expect(await deny(round, reqOf(op), readers(), stage)).toBe('growth_unwired');
    }
  });
});

describe('按 op 的检查子集:reader 调用序列逐 op 钉死', () => {
  const SEQ: Record<GrowthReq['op'], string[]> = {
    bootstrap: ['locks', 'capability', 'config', 'state', 'taint', 'purge', 'extra', 'locks'],
    candidate_create: [
      'locks',
      'capability',
      'config',
      'state',
      'repo',
      'barrier',
      'taint',
      'purge',
      'throttle',
      'extra',
      'locks',
    ],
    shadow_to_canary: [
      'locks',
      'capability',
      'config',
      'state',
      'repo',
      'barrier',
      'taint',
      'purge',
      'judge',
      'throttle',
      'admission',
      'extra',
      'locks',
    ],
    grant: [
      'locks',
      'capability',
      'config',
      'state',
      'repo',
      'barrier',
      'taint',
      'purge',
      'judge',
      'throttle',
      'admission',
      'extra',
      'locks',
    ],
    deploy_inject: [
      'locks',
      'capability',
      'config',
      'state',
      'repo',
      'barrier',
      'taint',
      'purge',
      'judge',
      'throttle',
      'admission',
      'extra',
      'locks',
    ],
    admission: ['locks', 'capability', 'config', 'state', 'barrier', 'purge', 'throttle', 'locks'],
  };
  it.each(GROWTH_OPS)('%s', async (op) => {
    const { round } = await openBoth();
    const r = readers();
    expect(await deny(round, reqOf(op), r)).toBe('PASS');
    expect(r.calls).toEqual(SEQ[op]);
  });
});

describe('逐项拒绝码与优先级(以 grant 为例,全 ✓ 的 op)', () => {
  type Case = [string, Partial<GrowthReaders>, string];
  const CASES: Case[] = [
    ['G1 能力 / 相位', { capability: () => Promise.resolve({ ready: false }) }, 'phase'],
    [
      'G2 配置不可信',
      { config: () => Promise.resolve({ trusted: false, autoEnabled: true, confirmed: true }) },
      'config',
    ],
    [
      'G2 auto 未启用',
      { config: () => Promise.resolve({ trusted: true, autoEnabled: false, confirmed: true }) },
      'config',
    ],
    [
      'G2 未 confirmed',
      { config: () => Promise.resolve({ trusted: true, autoEnabled: true, confirmed: false }) },
      'config',
    ],
    [
      'G3 state 非法',
      {
        state: () =>
          Promise.resolve({ valid: false, paused: false, flags: false, safetyFault: false }),
      },
      'state_invalid',
    ],
    [
      'G3 暂停(auto_pause / B / U)',
      {
        state: () =>
          Promise.resolve({ valid: true, paused: true, flags: false, safetyFault: false }),
      },
      'paused',
    ],
    [
      'G3 diverged / owner_changed',
      {
        state: () =>
          Promise.resolve({ valid: true, paused: false, flags: true, safetyFault: false }),
      },
      'flags',
    ],
    [
      'G3 safety_fault',
      {
        state: () =>
          Promise.resolve({ valid: true, paused: false, flags: false, safetyFault: true }),
      },
      'safety_fault',
    ],
    ['G4 仓库', { repo: () => Promise.resolve({ ok: false, code: 'repo' }) }, 'repo'],
    [
      'G5 recovery_incomplete',
      { barrier: () => Promise.resolve({ ok: false, code: 'recovery_incomplete' }) },
      'recovery_incomplete',
    ],
    [
      'G5 reconcile_incomplete',
      { barrier: () => Promise.resolve({ ok: false, code: 'reconcile_incomplete' }) },
      'reconcile_incomplete',
    ],
    [
      'G5 store_unreadable',
      { barrier: () => Promise.resolve({ ok: false, code: 'store_unreadable' }) },
      'store_unreadable',
    ],
    [
      'G5 store_full',
      { barrier: () => Promise.resolve({ ok: false, code: 'store_full' }) },
      'store_full',
    ],
    [
      'G6 能力未装配',
      {
        taint: () =>
          Promise.resolve({
            capabilityReady: false,
            scan: 'ok',
            rescanRequired: false,
            rescanned: false,
            rescanRoundId: null,
            candidate: 'clean',
          }),
      },
      'taint_unavailable',
    ],
    [
      'G6 扫描不可用',
      {
        taint: () =>
          Promise.resolve({
            capabilityReady: true,
            scan: 'unavailable',
            rescanRequired: false,
            rescanned: false,
            rescanRoundId: null,
            candidate: 'clean',
          }),
      },
      'taint_unavailable',
    ],
    [
      'G6 凭据写失败待重试',
      {
        taint: () =>
          Promise.resolve({
            capabilityReady: true,
            scan: 'pending',
            rescanRequired: false,
            rescanned: false,
            rescanRoundId: null,
            candidate: 'clean',
          }),
      },
      'taint_pending',
    ],
    [
      'G6 due 轮未重扫',
      {
        taint: () =>
          Promise.resolve({
            capabilityReady: true,
            scan: 'ok',
            rescanRequired: true,
            rescanned: false,
            rescanRoundId: null,
            candidate: 'clean',
          }),
      },
      'taint_pending',
    ],
    [
      'G6 候选被污染',
      {
        taint: () =>
          Promise.resolve({
            capabilityReady: true,
            scan: 'ok',
            rescanRequired: false,
            rescanned: false,
            rescanRoundId: null,
            candidate: 'tainted',
          }),
      },
      'taint_pending',
    ],
    [
      'G6 凭据冲突',
      {
        taint: () =>
          Promise.resolve({
            capabilityReady: true,
            scan: 'ok',
            rescanRequired: false,
            rescanned: false,
            rescanRoundId: null,
            candidate: 'conflict',
          }),
      },
      'taint_conflict',
    ],
    [
      'G6 候选 unknown',
      {
        taint: () =>
          Promise.resolve({
            capabilityReady: true,
            scan: 'ok',
            rescanRequired: false,
            rescanned: false,
            rescanRoundId: null,
            candidate: 'unknown',
          }),
      },
      'source_unknown',
    ],
    [
      'G6 候选事实缺省',
      {
        taint: () =>
          Promise.resolve({
            capabilityReady: true,
            scan: 'ok',
            rescanRequired: false,
            rescanned: false,
            rescanRoundId: null,
          }),
      },
      'source_unknown',
    ],
    [
      'G7 purge 能力未就绪',
      { purge: () => Promise.resolve({ capabilityReady: false, journalPresent: false }) },
      'purge',
    ],
    [
      'G7 purge journal 在场',
      { purge: () => Promise.resolve({ capabilityReady: true, journalPresent: true }) },
      'purge',
    ],
    [
      'G8 judge_unavailable',
      { judge: () => Promise.resolve({ ok: false, code: 'judge_unavailable' }) },
      'judge_unavailable',
    ],
    [
      'G8 judge_indeterminate',
      { judge: () => Promise.resolve({ ok: false, code: 'judge_indeterminate' }) },
      'judge_indeterminate',
    ],
    [
      'G8 judge_signal_pending',
      { judge: () => Promise.resolve({ ok: false, code: 'judge_signal_pending' }) },
      'judge_signal_pending',
    ],
    ['G9 节流', { throttle: () => Promise.resolve({ due: false }) }, 'throttled'],
    [
      'G11 准入未装配',
      { admission: () => Promise.resolve({ wired: false, effective: true, versionsMatch: true }) },
      'admission',
    ],
    [
      'G11 准入未生效(W10b 前)',
      { admission: () => Promise.resolve({ wired: true, effective: false, versionsMatch: true }) },
      'admission',
    ],
    [
      'G11 版本不符',
      { admission: () => Promise.resolve({ wired: true, effective: true, versionsMatch: false }) },
      'admission',
    ],
    [
      'D near_fp 不可用',
      { extra: () => Promise.resolve({ ok: false, code: 'near_fp_unavailable' }) },
      'near_fp_unavailable',
    ],
    [
      'D fp.key 不可用',
      { extra: () => Promise.resolve({ ok: false, code: 'fp_key_unavailable' }) },
      'fp_key_unavailable',
    ],
    [
      'D creation_unready',
      { extra: () => Promise.resolve({ ok: false, code: 'creation_unready' }) },
      'creation_unready',
    ],
    [
      'D 来源不可解析',
      { extra: () => Promise.resolve({ ok: false, code: 'source_unknown' }) },
      'source_unknown',
    ],
  ];
  it.each(CASES)('%s → %s', async (_name, over, code) => {
    const { round } = await openBoth();
    expect(await deny(round, reqOf('grant'), readers(over))).toBe(code);
  });

  it('全绿 → 通过(正向对照)', async () => {
    const { round } = await openBoth();
    expect(await deny(round, reqOf('grant'), readers())).toBe('PASS');
  });

  it('优先级:多项同时失败 → 返回顺序上第一个(G1 > G2 > G3 > G4 > … > G11 > D 专属)', async () => {
    const { round } = await openBoth();
    const bad = {
      capability: () => Promise.resolve({ ready: false }),
      config: () => Promise.resolve({ trusted: false, autoEnabled: true, confirmed: true }),
      state: () => Promise.resolve({ valid: false, paused: true, flags: true, safetyFault: true }),
      repo: () => Promise.resolve({ ok: false as const, code: 'repo' as const }),
      barrier: () => Promise.resolve({ ok: false as const, code: 'store_full' as const }),
      purge: () => Promise.resolve({ capabilityReady: false, journalPresent: true }),
      judge: () => Promise.resolve({ ok: false as const, code: 'judge_unavailable' as const }),
      throttle: () => Promise.resolve({ due: false }),
      admission: () => Promise.resolve({ wired: false, effective: false, versionsMatch: false }),
      extra: () => Promise.resolve({ ok: false as const, code: 'creation_unready' as const }),
    } satisfies Partial<GrowthReaders>;
    const order: [keyof typeof bad, string][] = [
      ['capability', 'phase'],
      ['config', 'config'],
      ['state', 'state_invalid'],
      ['repo', 'repo'],
      ['barrier', 'store_full'],
      ['purge', 'purge'],
      ['judge', 'judge_unavailable'],
      ['throttle', 'throttled'],
      ['admission', 'admission'],
      ['extra', 'creation_unready'],
    ];
    // 依次去掉最前面的失败项:返回码必须逐级后移
    const keys = order.map(([k]) => k);
    for (let i = 0; i < order.length; i += 1) {
      const over: Partial<GrowthReaders> = {};
      for (const k of keys.slice(i)) Object.assign(over, { [k]: bad[k] });
      expect(await deny(round, reqOf('grant'), readers(over)), String(order[i]?.[0])).toBe(
        order[i]?.[1],
      );
    }
  });

  it('G3 内部优先级:state_invalid > paused > flags > safety_fault', async () => {
    const { round } = await openBoth();
    const mk = (valid: boolean, paused: boolean, flags: boolean, safetyFault: boolean) =>
      readers({ state: () => Promise.resolve({ valid, paused, flags, safetyFault }) });
    expect(await deny(round, reqOf('grant'), mk(false, true, true, true))).toBe('state_invalid');
    expect(await deny(round, reqOf('grant'), mk(true, true, true, true))).toBe('paused');
    expect(await deny(round, reqOf('grant'), mk(true, false, true, true))).toBe('flags');
    expect(await deny(round, reqOf('grant'), mk(true, false, false, true))).toBe('safety_fault');
  });
});

describe('按 op 放宽 / 收紧(每条:放宽的 op 通过、收紧的 op 拒绝)', () => {
  it('暂停:bootstrap 不看暂停 / 标志 / safety_fault(G3 只要 state 合规);创建按 G3 一并拒绝(含暂停)', async () => {
    const { round } = await openBoth();
    const paused = () =>
      readers({
        state: () => Promise.resolve({ valid: true, paused: true, flags: true, safetyFault: true }),
      });
    expect(await deny(round, reqOf('bootstrap'), paused())).toBe('PASS');
    expect(await deny(round, reqOf('candidate_create'), paused())).toBe('paused');
    // bootstrap 仍要 state 合规
    const invalid = readers({
      state: () =>
        Promise.resolve({ valid: false, paused: false, flags: false, safetyFault: false }),
    });
    expect(await deny(round, reqOf('bootstrap'), invalid)).toBe('state_invalid');
  });

  it('candidate_create_not_denied_by_admission(W10b 前):G11 不对创建生效;对 grant / deploy 恒 admission', async () => {
    const { round } = await openBoth();
    const noAdmission = () =>
      readers({
        admission: () => Promise.resolve({ wired: false, effective: false, versionsMatch: false }),
      });
    expect(await deny(round, reqOf('candidate_create'), noAdmission())).toBe('PASS');
    expect(await deny(round, reqOf('grant'), noAdmission())).toBe('admission');
    expect(await deny(round, reqOf('deploy_inject'), noAdmission())).toBe('admission');
    expect(await deny(round, reqOf('shadow_to_canary'), noAdmission())).toBe('admission');
  });

  it('G11:shadow_to_canary 只要「能力已装配」;grant / deploy 要求生效且版本逐项匹配', async () => {
    const { round } = await openBoth();
    const wiredNotEffective = () =>
      readers({
        admission: () => Promise.resolve({ wired: true, effective: false, versionsMatch: false }),
      });
    expect(await deny(round, reqOf('shadow_to_canary'), wiredNotEffective())).toBe('PASS');
    expect(await deny(round, reqOf('grant'), wiredNotEffective())).toBe('admission');
    expect(await deny(round, reqOf('deploy_inject'), wiredNotEffective())).toBe('admission');
  });

  it('G9:创建「由重扫要求蕴含」= 只在 due 轮;bootstrap 不看节流', async () => {
    const { round } = await openBoth();
    const notDue = () => readers({ throttle: () => Promise.resolve({ due: false }) });
    expect(await deny(round, reqOf('candidate_create'), notDue())).toBe('throttled');
    expect(await deny(round, reqOf('bootstrap'), notDue())).toBe('PASS');
    expect(await deny(round, reqOf('admission'), notDue())).toBe('throttled');
  });

  it('G6:bootstrap 只要「前置能力就绪」(不看扫描 / 重扫);创建要求本轮已重扫;候选类要求候选非 unknown', async () => {
    const { round } = await openBoth();
    const mk = (over: Record<string, unknown>) =>
      readers({
        taint: () =>
          Promise.resolve({
            capabilityReady: true,
            scan: 'ok',
            rescanRequired: false,
            rescanned: true,
            rescanRoundId: round.id, // 本轮已重扫的证据(创建的 G6 要求;下面的「重扫」用例逐项覆盖)
            candidate: 'clean',
            ...over,
          } as never),
      });
    const scanDown = mk({ scan: 'unavailable', rescanRequired: true, candidate: 'unknown' });
    expect(await deny(round, reqOf('bootstrap'), scanDown)).toBe('PASS');
    expect(await deny(round, reqOf('candidate_create'), scanDown)).toBe('taint_unavailable');
    // 创建不看候选(无候选),只看扫描与重扫
    const unknownCand = mk({ candidate: 'unknown' });
    expect(await deny(round, reqOf('candidate_create'), unknownCand)).toBe('PASS');
    expect(await deny(round, reqOf('grant'), unknownCand)).toBe('source_unknown');
    // 前置能力缺 → bootstrap 也拒
    expect(await deny(round, reqOf('bootstrap'), mk({ capabilityReady: false }))).toBe(
      'taint_unavailable',
    );
    // 重扫:要求但未做
    expect(
      await deny(round, reqOf('candidate_create'), mk({ rescanRequired: true, rescanned: false })),
    ).toBe('taint_pending');
    expect(
      await deny(round, reqOf('candidate_create'), mk({ rescanRequired: true, rescanned: true })),
    ).toBe('PASS');
  });

  it('G7:bootstrap 只要前置能力就绪(journal 在场不拦);其余 on', async () => {
    const { round } = await openBoth();
    const journal = () =>
      readers({ purge: () => Promise.resolve({ capabilityReady: true, journalPresent: true }) });
    expect(await deny(round, reqOf('bootstrap'), journal())).toBe('PASS');
    expect(await deny(round, reqOf('candidate_create'), journal())).toBe('purge');
    expect(await deny(round, reqOf('admission'), journal())).toBe('purge');
    const notReady = () =>
      readers({ purge: () => Promise.resolve({ capabilityReady: false, journalPresent: false }) });
    expect(await deny(round, reqOf('bootstrap'), notReady())).toBe('purge');
  });

  it('bootstrap 不看 G4 / G5 / G8 / G9 / G11;admission 不看 G4 / G6 / G8 / G11;创建不看 G8:对应 reader 即使坏了也不影响', async () => {
    const { round } = await openBoth();
    const broken = {
      repo: () => Promise.reject(new Error('x')),
      barrier: () => Promise.reject(new Error('x')),
      judge: () => Promise.reject(new Error('x')),
      throttle: () => Promise.resolve({ due: false }),
      admission: () => Promise.reject(new Error('x')),
    } as Partial<GrowthReaders>;
    expect(await deny(round, reqOf('bootstrap'), readers(broken))).toBe('PASS');
    expect(
      await deny(
        round,
        reqOf('admission'),
        readers({
          repo: broken.repo,
          judge: broken.judge,
          admission: broken.admission,
          taint: () => Promise.reject(new Error('x')),
        }),
      ),
    ).toBe('PASS');
    expect(
      await deny(
        round,
        reqOf('candidate_create'),
        readers({ judge: broken.judge, admission: broken.admission }),
      ),
    ).toBe('PASS');
    // 反向对照:同样坏的 judge 对 grant 必拒
    expect(await deny(round, reqOf('grant'), readers({ judge: broken.judge }))).toBe(
      'judge_indeterminate',
    );
  });

  it('D 专属列:admission 不调 extra;其余调', async () => {
    const { round } = await openBoth();
    const r = readers();
    await deny(round, reqOf('admission'), r);
    expect(r.calls).not.toContain('extra');
    const r2 = readers();
    await deny(round, reqOf('bootstrap'), r2);
    expect(r2.calls).toContain('extra');
  });
});

describe('来源缺失一律拒绝增影响(与 W9 的 null → ok 各自独立)', () => {
  it.each(['shadow_to_canary', 'grant', 'deploy_inject'] as const)(
    '%s:source 为 null / undefined / 缺键 → source_unknown(reader 说 clean 也拒;taint reader 不被调用);有来源 → 通过',
    async (op) => {
      const { round } = await openBoth();
      for (const source of [null, undefined]) {
        const r = readers();
        expect(await deny(round, reqOf(op, cand({ source })), r)).toBe('source_unknown');
        expect(r.calls).not.toContain('taint');
      }
      const noKey = {
        id: 'c',
        content_sha256: 'b'.repeat(64),
        lifecycle: 'shadow',
      } as unknown as ReturnType<typeof cand>;
      expect(await deny(round, reqOf(op, noKey), readers())).toBe('source_unknown');
      expect(await deny(round, reqOf(op, cand()), readers())).toBe('PASS');
    },
  );

  it('组合:UNAVAILABLE_JUDGE 对 source_proposal=null 说 ok,但 evaluateGrowth 仍因来源缺失拒绝(两项各自独立)', async () => {
    const { round } = await openBoth();
    expect(await UNAVAILABLE_JUDGE.growth.check(rec(null))).toEqual({ ok: true });
    const r = readers({
      judge: (_round, req) =>
        UNAVAILABLE_JUDGE.growth.check(
          rec(req.cand.source ? { run_id: 'r', proposal_id: 'p' } : null),
        ),
    });
    expect(await deny(round, reqOf('grant', cand({ source: null })), r)).toBe('source_unknown');
    // 带来源时,缺省实现拒绝(缺能力 = 拒绝,绝不缺省为通过)
    expect(await deny(round, reqOf('grant'), r)).toBe('judge_unavailable');
  });

  it('S2 的 blocked latch 并入 G8:同一候选被 latch 后,即使 judge reader 说 ok 也拒;其它候选不受影响', async () => {
    const { round } = await openBoth();
    recordJudgeBlocked(round, [{ id: 'cand-1', code: 'judge_signal_pending' }]);
    expect(await deny(round, reqOf('grant', cand({ id: 'cand-1' })), readers())).toBe(
      'judge_signal_pending',
    );
    expect(await deny(round, reqOf('grant', cand({ id: 'cand-2' })), readers())).toBe('PASS');
  });

  it('judge reader 返回非法值 → judge_indeterminate', async () => {
    const { round } = await openBoth();
    for (const bad of [
      undefined,
      null,
      { ok: 'yes' },
      { ok: false, code: 'whatever' },
      { ok: false },
    ]) {
      expect(
        await deny(round, reqOf('grant'), readers({ judge: () => Promise.resolve(bad as never) })),
      ).toBe('judge_indeterminate');
    }
  });
});

describe('reader 抛错 / 返回非法值 → fail-closed(绝不放行)', () => {
  const THROW_CASES: [keyof GrowthReaders, string][] = [
    ['capability', 'phase'],
    ['config', 'config'],
    ['state', 'state_invalid'],
    ['repo', 'repo'],
    ['barrier', 'store_unreadable'],
    ['taint', 'taint_unavailable'],
    ['purge', 'purge'],
    ['judge', 'judge_indeterminate'],
    ['throttle', 'throttled'],
    ['admission', 'admission'],
    ['extra', 'creation_unready'],
  ];
  it.each(THROW_CASES)('%s 抛普通错 → %s', async (name, code) => {
    const { round } = await openBoth();
    const r = readers({ [name]: () => Promise.reject(new Error('io')) } as Partial<GrowthReaders>);
    expect(await deny(round, reqOf('grant'), r)).toBe(code);
  });

  it('返回 undefined / 非法形状 → 同一组码', async () => {
    const { round } = await openBoth();
    for (const [name, code] of THROW_CASES) {
      const r = readers({
        [name]: () => Promise.resolve(undefined),
      } as unknown as Partial<GrowthReaders>);
      expect(await deny(round, reqOf('grant'), r), name).toBe(code);
    }
    expect(
      await deny(
        round,
        reqOf('grant'),
        readers({ repo: () => Promise.resolve({ ok: false, code: 'nope' } as never) }),
      ),
    ).toBe('repo');
    expect(
      await deny(
        round,
        reqOf('grant'),
        readers({ barrier: () => Promise.resolve({ ok: false, code: 'repo' } as never) }),
      ),
    ).toBe('store_unreadable');
    expect(
      await deny(
        round,
        reqOf('grant'),
        readers({ extra: () => Promise.resolve({ ok: false, code: 'throttled' } as never) }),
      ),
    ).toBe('creation_unready');
  });

  it('个人失锁(PersonalLockLost)→ lock_lost;rsi 失锁 → 原样上抛(不吞成拒绝码)', async () => {
    const { round } = await openBoth();
    expect(
      await deny(
        round,
        reqOf('grant'),
        readers({ state: () => Promise.reject(new PersonalLockLost()) }),
      ),
    ).toBe('lock_lost');
    await expect(
      evaluateGrowth(
        round,
        reqOf('grant'),
        readers({ state: () => Promise.reject(new RsiLockError('lock_lost')) }),
        STAGE_ALL,
      ),
    ).rejects.toBeInstanceOf(RsiLockError);
  });

  it('G10 前置 / 后置:locks 任何错误 → lock_lost;前置失败时其余 reader 零调用;后置失败不铸造', async () => {
    const { round } = await openBoth();
    const pre = readers({ locks: () => Promise.reject(new PersonalLockLost()) });
    expect(await deny(round, reqOf('grant'), pre)).toBe('lock_lost');
    expect(pre.calls).toEqual(['locks']);
    const generic = readers({ locks: () => Promise.reject(new Error('io')) });
    expect(await deny(round, reqOf('grant'), generic)).toBe('lock_lost');
    let n = 0;
    const post = readers({
      locks: () => (++n === 2 ? Promise.reject(new PersonalLockLost()) : Promise.resolve()),
    });
    expect(await deny(round, reqOf('grant'), post)).toBe('lock_lost');
    expect(post.calls.filter((c) => c === 'locks').length).toBe(2);
  });

  it('本轮未决 → unsettled(在逐项检查之前;只有前置锁检查)', async () => {
    const { round } = await openBoth();
    await round
      .writeAdapter('state_pause_flag', () => Promise.reject(new Error('x')))()
      .catch(() => undefined);
    const r = readers();
    expect(await deny(round, reqOf('grant'), r)).toBe('unsettled');
    expect(r.calls).toEqual(['locks']);
    // 压缩失败的未决同样拒绝
    const other = await openBoth({ rsi: 'eeee5555eeee5555', personal: 'ffff6666ffff6666' });
    markRoundUnsettled(other.round, 'compaction_failed');
    expect(await deny(other.round, reqOf('bootstrap'), readers())).toBe('unsettled');
  });
});

describe('铸造的前提:单飞与评估期间无写', () => {
  it('mint_allowed_in_flight 的反面:写进行中调 evaluateGrowth → RoundInternalError(不是拒绝码),reader 零调用', async () => {
    const { round } = await openBoth();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = round.writeAdapter('effects', () => gate);
    const p = w();
    const r = readers();
    await expect(evaluateGrowth(round, reqOf('grant'), r, STAGE_ALL)).rejects.toThrow(
      /mint_while_write_in_flight/,
    );
    expect(r.calls).toEqual([]);
    release();
    await p;
    expect(await deny(round, reqOf('grant'), readers())).toBe('PASS'); // 空闲后正常
  });

  it('评估期间发生了写(事实已过时)→ RoundInternalError write_during_evaluate,不铸造', async () => {
    const { round } = await openBoth();
    const r = readers({
      state: async () => {
        await round.writeAdapter('audit_append', () => Promise.resolve())();
        return { valid: true, paused: false, flags: false, safetyFault: false };
      },
    });
    await expect(evaluateGrowth(round, reqOf('grant'), r, STAGE_ALL)).rejects.toThrow(
      /write_during_evaluate/,
    );
  });

  it('评估期间写使本轮未决 → 同样不铸造(先报 write_during_evaluate 或 unsettled,绝不通过)', async () => {
    const { round } = await openBoth();
    const r = readers({
      state: async () => {
        await round
          .writeAdapter('trip', () => Promise.reject(new Error('x')))()
          .catch(() => undefined);
        return { valid: true, paused: false, flags: false, safetyFault: false };
      },
    });
    const out = await evaluateGrowth(round, reqOf('grant'), r, STAGE_ALL).then(
      (v) => (isGrowthPass(v) ? 'PASS' : 'DENY'),
      () => 'THROW',
    );
    expect(out).not.toBe('PASS');
  });

  it('畸形请求(JS 调用方)→ RoundInternalError bad_request,不是拒绝码', async () => {
    const { round } = await openBoth();
    for (const bad of [
      null,
      undefined,
      {},
      { op: 'nope' },
      { op: 'grant' },
      { op: 'grant', cand: { id: '', content_sha256: 'x' } },
      { op: 'deploy_inject', cand: { id: 'x' } },
    ]) {
      await expect(evaluateGrowth(round, bad as never, readers(), STAGE_ALL)).rejects.toThrow(
        /bad_request/,
      );
    }
    await expect(
      evaluateGrowth(round, { op: 'grant' } as never, readers(), STAGE_ALL),
    ).rejects.toBeInstanceOf(RoundInternalError);
  });

  it('不是本模块开的回合 / 伪造的 rsi-only 回合 → RoundInternalError', async () => {
    const { round } = await openBoth();
    const fake = { ...round } as unknown as BothRound;
    await expect(evaluateGrowth(fake, reqOf('grant'), readers(), STAGE_ALL)).rejects.toThrow(
      /round_not_opened_here/,
    );
  });
});

describe('铸造的 pass 与 op 提取', () => {
  it('pass 绑定两把 nonce、gen、op;候选只留 (id, content_sha256);冻结', async () => {
    const { round } = await openBoth();
    await round.writeAdapter('effects', () => Promise.resolve())(); // gen = 1
    const p = await pass(round, reqOf('grant', cand({ id: 'k', content_sha256: 'c'.repeat(64) })));
    expect(p.rsiNonce).toBe('aaaa1111aaaa1111');
    expect(p.personalNonce).toBe('bbbb2222bbbb2222');
    expect(p.gen).toBe(1);
    expect(p.op).toEqual({ cap: 'grant', cand: { id: 'k', content_sha256: 'c'.repeat(64) } });
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.op)).toBe(true);
    const q = await pass(round, reqOf('bootstrap'));
    expect(q.op).toEqual({ cap: 'bootstrap' });
  });

  it('growthDenied 是冻结的拒绝值;isGrowthPass 只认铸造的 pass', async () => {
    const d = growthDenied('personal_busy');
    expect(d).toEqual({ ok: false, code: 'personal_busy' });
    expect(Object.isFrozen(d)).toBe(true);
    expect(isGrowthPass(d)).toBe(false);
    const { round } = await openBoth();
    const p = await pass(round, reqOf('bootstrap'));
    expect(isGrowthPass(p)).toBe(true);
    expect(isGrowthPass({ ...p } as unknown as GrowthPass)).toBe(false);
  });

  it('opOfReq / sameOp:候选类比较 (id, sha) 两项;能力名不同必不等', () => {
    const a = opOfReq(reqOf('grant', cand()));
    expect(sameOp(a, opOfReq(reqOf('grant', cand())))).toBe(true);
    expect(sameOp(a, opOfReq(reqOf('grant', cand({ id: 'other' }))))).toBe(false);
    expect(sameOp(a, opOfReq(reqOf('grant', cand({ content_sha256: 'd'.repeat(64) }))))).toBe(
      false,
    );
    expect(sameOp(a, opOfReq(reqOf('deploy_inject', cand())))).toBe(false);
    expect(sameOp({ cap: 'bootstrap' }, { cap: 'candidate_create' })).toBe(false);
    expect(sameOp({ cap: 'admission' }, { cap: 'admission' })).toBe(true);
    // 候选类与非候选类即使 cap 碰巧相等也不会混:cap 不同
    expect(sameOp({ cap: 'bootstrap' }, a)).toBe(false);
  });
});

describe('requireGrowth:一次性、gen 失效、op / nonce / 回合绑定', () => {
  const CREATE: GrowthOp = { cap: 'candidate_create' };

  it('合法一次消费;同一 pass 第二次 → already_used(一个 pass 至多服务一次写)', async () => {
    const { round } = await openBoth();
    const p = await readyPass(round, reqOf('candidate_create'));
    expect(() => requireGrowth(p, round, CREATE)).not.toThrow();
    expect(() => requireGrowth(p, round, CREATE)).toThrow(StaleGrowth);
    try {
      requireGrowth(p, round, CREATE);
    } catch (e) {
      expect((e as StaleGrowth).reason).toBe('already_used');
    }
  });

  const reasonOf = (f: () => void): string => {
    try {
      f();
    } catch (e) {
      return e instanceof StaleGrowth ? e.reason : `OTHER:${String(e)}`;
    }
    return 'NO_THROW';
  };

  it('stale_pass_other_round_refused:另一个回合(不同 nonce)→ nonce_mismatch;同 nonce 另开的回合对象 → round_mismatch', async () => {
    const a = await openBoth();
    const p = await pass(a.round, reqOf('candidate_create'));
    const b = await openBoth({ rsi: 'cccc3333cccc3333', personal: 'dddd4444dddd4444' });
    expect(reasonOf(() => requireGrowth(p, b.round, CREATE))).toBe('nonce_mismatch');
    const again = await openBoth(); // 同一组 nonce,不同回合对象
    const p2 = await pass(a.round, reqOf('candidate_create'));
    expect(reasonOf(() => requireGrowth(p2, again.round, CREATE))).toBe('round_mismatch');
    const p3 = await readyPass(a.round, reqOf('candidate_create'));
    expect(reasonOf(() => requireGrowth(p3, a.round, CREATE))).toBe('NO_THROW'); // 正向对照
  });

  it.each(WRITE_KINDS)(
    'pass_after_any_write_refused:铸造之后任何一种写(%s)→ gen_changed',
    async (kind) => {
      const { round } = await openBoth();
      const p = await pass(round, reqOf('candidate_create'));
      await round.writeAdapter(kind, () => Promise.resolve())();
      expect(reasonOf(() => requireGrowth(p, round, CREATE))).toBe('gen_changed');
    },
  );

  it('写失败(抛错)同样使旧 pass 失效', async () => {
    const { round } = await openBoth();
    const p = await pass(round, reqOf('candidate_create'));
    await round
      .writeAdapter('effects', () => Promise.reject(new Error('x')))()
      .catch(() => undefined);
    expect(reasonOf(() => requireGrowth(p, round, CREATE))).toBe('gen_changed');
  });

  it('op_mismatch_refused:换候选 id / 换 sha / 换能力 / 候选类 pass 换成非候选 op', async () => {
    const { round } = await openBoth();
    const mk = (): Promise<GrowthPass> => readyPass(round, reqOf('grant', cand()));
    const base = { cap: 'grant', cand: { id: 'cand-1', content_sha256: 'a'.repeat(64) } } as const;
    for (const wrong of [
      { cap: 'grant', cand: { id: 'cand-2', content_sha256: 'a'.repeat(64) } },
      { cap: 'grant', cand: { id: 'cand-1', content_sha256: 'b'.repeat(64) } },
      { cap: 'deploy_inject', cand: { id: 'cand-1', content_sha256: 'a'.repeat(64) } },
      { cap: 'shadow_to_canary', cand: { id: 'cand-1', content_sha256: 'a'.repeat(64) } },
      { cap: 'candidate_create' },
      { cap: 'bootstrap' },
    ] as GrowthOp[]) {
      const p = await mk();
      expect(
        reasonOf(() => requireGrowth(p, round, wrong)),
        JSON.stringify(wrong),
      ).toBe('op_mismatch');
    }
    const ok = await mk();
    expect(reasonOf(() => requireGrowth(ok, round, base))).toBe('NO_THROW'); // 正向对照
  });

  it('bootstrap_pass_not_accepted_as_create / create pass 不能当 bootstrap', async () => {
    const { round } = await openBoth();
    const b = await pass(round, reqOf('bootstrap'));
    expect(reasonOf(() => requireGrowth(b, round, { cap: 'candidate_create' }))).toBe(
      'op_mismatch',
    );
    const c = await pass(round, reqOf('candidate_create'));
    expect(reasonOf(() => requireGrowth(c, round, { cap: 'bootstrap' }))).toBe('op_mismatch');
  });

  it('强转 / 展开拷贝造出的 pass → not_minted(登记表只认本模块铸造的对象)', async () => {
    const { round } = await openBoth();
    const real = await readyPass(round, reqOf('candidate_create'));
    const forged = {
      rsiNonce: round.rsiNonce,
      personalNonce: round.personalNonce,
      gen: round.gen(),
      op: CREATE,
    } as unknown as GrowthPass;
    expect(reasonOf(() => requireGrowth(forged, round, CREATE))).toBe('not_minted');
    expect(reasonOf(() => requireGrowth({ ...real } as unknown as GrowthPass, round, CREATE))).toBe(
      'not_minted',
    );
    expect(
      reasonOf(() =>
        requireGrowth(Object.freeze({ ...real }) as unknown as GrowthPass, round, CREATE),
      ),
    ).toBe('not_minted');
    expect(reasonOf(() => requireGrowth(real, round, CREATE))).toBe('NO_THROW'); // 正向对照
  });

  it('失败也使 pass 作废:op 不等失败之后,用对的 op 再来 → already_used', async () => {
    const { round } = await openBoth();
    const p = await pass(round, reqOf('candidate_create'));
    expect(reasonOf(() => requireGrowth(p, round, { cap: 'bootstrap' }))).toBe('op_mismatch');
    expect(reasonOf(() => requireGrowth(p, round, CREATE))).toBe('already_used');
  });

  it('铸造之后回合变未决(无写)→ unsettled(gen 没变也拒)', async () => {
    const { round } = await openBoth();
    const p = await pass(round, reqOf('candidate_create'));
    markRoundUnsettled(round, 'safety_not_settled');
    expect(round.gen()).toBe(0);
    expect(reasonOf(() => requireGrowth(p, round, CREATE))).toBe('unsettled');
  });

  it('legit_authorized_write_not_self_invalidated:授权写内 requireGrowth 成功,写完 gen 前进;同一 pass 不能服务第二次写;新写需新 pass', async () => {
    const { round } = await openBoth();
    const p = await readyPass(round, reqOf('candidate_create'));
    const written: string[] = [];
    const write = round.writeAdapter('candidate_record', async () => {
      requireGrowth(p, round, CREATE); // 适配器内、紧贴提交边界:gen 仍是铸造时的值
      await Promise.resolve();
      written.push('w1');
    });
    await write();
    expect(written).toEqual(['w1']);
    expect(round.gen()).toBe(1);
    // 第二次写复用同一 pass → 拒(写内抛 StaleGrowth;写适配器按「不确定」未决——这正是 D 必须每写各自重新 evaluateGrowth 的原因)
    const second = round.writeAdapter('candidate_record', async () => {
      requireGrowth(p, round, CREATE);
      written.push('w2');
    });
    await expect(second()).rejects.toBeInstanceOf(StaleGrowth);
    expect(written).toEqual(['w1']);
    // 新 pass 对应新 gen(需先确认本轮没有被第二次写失败置为未决:此处用另一回合演示合法的第二次授权写)
    const w2 = await openBoth({ rsi: 'cccc3333cccc3333', personal: 'dddd4444dddd4444' });
    const q1 = await readyPass(w2.round, reqOf('candidate_create'));
    await w2.round.writeAdapter('candidate_record', async () =>
      requireGrowth(q1, w2.round, CREATE),
    )();
    const q2 = await readyPass(w2.round, reqOf('candidate_create'));
    expect(q2.gen).toBe(1);
    await w2.round.writeAdapter('candidate_record', async () =>
      requireGrowth(q2, w2.round, CREATE),
    )();
    expect(w2.round.gen()).toBe(2);
    expect(reasonOf(() => requireGrowth(q1, w2.round, CREATE))).toBe('already_used');
  });
});

describe('checkGrowthVeto:消费前现读外部否决事实(requireGrowth 的前置;同步入口绕不过现读)', () => {
  const CREATE: GrowthOp = { cap: 'candidate_create' };
  const reasonOfAsync = async (f: () => Promise<void>): Promise<string> => {
    try {
      await f();
    } catch (e) {
      return e instanceof StaleGrowth ? e.reason : `OTHER:${(e as Error).name}`;
    }
    return 'NO_THROW';
  };
  const reasonOfSync = (f: () => void): string => {
    try {
      f();
    } catch (e) {
      return e instanceof StaleGrowth ? e.reason : `OTHER:${String(e)}`;
    }
    return 'NO_THROW';
  };

  it('require_without_veto_check_refused:铸造后没经 checkGrowthVeto 就消费 → veto_not_checked(并作废);经过现读 → 通过(正向对照)', async () => {
    const { round } = await openBoth();
    const raw = await pass(round, reqOf('candidate_create'));
    expect(reasonOfSync(() => requireGrowth(raw, round, CREATE))).toBe('veto_not_checked');
    expect(reasonOfSync(() => requireGrowth(raw, round, CREATE))).toBe('already_used');
    const ready = await readyPass(round, reqOf('candidate_create'));
    expect(reasonOfSync(() => requireGrowth(ready, round, CREATE))).toBe('NO_THROW');
  });

  it('外部事实在 pass 铸造之后才出现(无持久写,gen 不变)→ 现读命中,消费被拒:同步入口无法绕过', async () => {
    const { round } = await openBoth();
    const p = await pass(round, reqOf('candidate_create'));
    const vetoed = readers({
      externalVeto: () => Promise.resolve({ vetoed: true, why: 'marker' }),
    });
    expect(await reasonOfAsync(() => checkGrowthVeto(p, round, CREATE, vetoed))).toBe('vetoed');
    expect(reasonOfSync(() => requireGrowth(p, round, CREATE))).toBe('already_used');
  });

  it('无否决 → 记录现读通过;读到的 pass 仍只能消费一次', async () => {
    const { round } = await openBoth();
    const p = await pass(round, reqOf('candidate_create'));
    const r = readers();
    expect(await reasonOfAsync(() => checkGrowthVeto(p, round, CREATE, r))).toBe('NO_THROW');
    expect(r.calls).toEqual(['externalVeto']);
    expect(reasonOfSync(() => requireGrowth(p, round, CREATE))).toBe('NO_THROW');
    expect(reasonOfSync(() => requireGrowth(p, round, CREATE))).toBe('already_used');
  });

  it('铸造 pass 后出现 B/U / 暂停 / 凭据命中 → vetoed 且 pass 作废', async () => {
    const { round } = await openBoth();
    for (const why of ['marker', 'auto_pause', 'flags', 'credential'] as const) {
      const p = await pass(round, reqOf('candidate_create'));
      const r = readers({ externalVeto: () => Promise.resolve({ vetoed: true, why }) });
      expect(await reasonOfAsync(() => checkGrowthVeto(p, round, CREATE, r)), why).toBe('vetoed');
      expect(await reasonOfAsync(() => checkGrowthVeto(p, round, CREATE, readers()))).toBe(
        'already_used',
      );
    }
  });

  it('读不出(抛错 / 非法值)→ veto_unreadable 且作废;失锁类错误原样上抛(同样作废)', async () => {
    const { round } = await openBoth();
    for (const bad of [
      () => Promise.reject(new Error('io')),
      () => Promise.resolve(undefined),
      () => Promise.resolve({ vetoed: 'no' }),
    ]) {
      const p = await pass(round, reqOf('candidate_create'));
      const r = readers({ externalVeto: bad as never });
      expect(await reasonOfAsync(() => checkGrowthVeto(p, round, CREATE, r))).toBe(
        'veto_unreadable',
      );
    }
    const p = await pass(round, reqOf('candidate_create'));
    const lost = readers({ externalVeto: () => Promise.reject(new PersonalLockLost()) });
    expect(await reasonOfAsync(() => checkGrowthVeto(p, round, CREATE, lost))).toBe('OTHER:Error');
    expect(reasonOfSync(() => requireGrowth(p, round, CREATE))).toBe('already_used');
  });

  it('已经 stale(gen 变了)→ 不读否决事实(同步校验先失败),作废', async () => {
    const { round } = await openBoth();
    const p = await pass(round, reqOf('candidate_create'));
    await round.writeAdapter('audit_append', () => Promise.resolve())();
    const r = readers();
    expect(await reasonOfAsync(() => checkGrowthVeto(p, round, CREATE, r))).toBe('gen_changed');
    expect(r.calls).toEqual([]);
  });

  it('现读通过之后、消费之前发生了写 → 消费时 gen_changed(现读不能掩盖其后的写)', async () => {
    const { round } = await openBoth();
    const p = await pass(round, reqOf('candidate_create'));
    await checkGrowthVeto(p, round, CREATE, readers());
    await round.writeAdapter('audit_append', () => Promise.resolve())();
    expect(reasonOfSync(() => requireGrowth(p, round, CREATE))).toBe('gen_changed');
  });

  it('现读期间发生了写 → 消费时 gen_changed(现读标记绑定读时的 gen)', async () => {
    const { round } = await openBoth();
    const p = await pass(round, reqOf('candidate_create'));
    const r = readers({
      externalVeto: async () => {
        await round.writeAdapter('audit_append', () => Promise.resolve())();
        return { vetoed: false as const };
      },
    });
    // 读期间 gen 前进:pass 已过时,现读本身就拒(不盖章),消费同样拒
    expect(await reasonOfAsync(() => checkGrowthVeto(p, round, CREATE, r))).toBe('gen_changed');
    expect(reasonOfSync(() => requireGrowth(p, round, CREATE))).toBe('already_used');
  });
});

describe('checkGrowthVeto 的跨 await 身份与重入', () => {
  const CREATE: GrowthOp = { cap: 'candidate_create' };
  const reasonOfAsync = async (f: () => Promise<void>): Promise<string> => {
    try {
      await f();
    } catch (e) {
      return e instanceof StaleGrowth ? e.reason : `OTHER:${(e as Error).name}`;
    }
    return 'NO_THROW';
  };
  const reasonOfSync = (f: () => void): string => {
    try {
      f();
    } catch (e) {
      return e instanceof StaleGrowth ? e.reason : `OTHER:${String(e)}`;
    }
    return 'NO_THROW';
  };

  it('veto_reader_gets_frozen_pass_op:读的是冻结的 pass.op,调用方在 await 期间改写自己持有的 op 不影响读的对象', async () => {
    const { round } = await openBoth();
    const p = await pass(round, reqOf('grant'));
    const op = { cap: 'grant', cand: { id: 'cand-1', content_sha256: 'a'.repeat(64) } } as {
      cap: 'grant';
      cand: { id: string; content_sha256: string };
    };
    let seen: GrowthOp | null = null;
    const r = readers({
      externalVeto: async (_r, o) => {
        op.cand.id = 'cand-B'; // 调用方的可变别名在 await 期间被改写
        seen = o;
        await Promise.resolve();
        return { vetoed: false as const };
      },
    });
    await checkGrowthVeto(
      p,
      round,
      { cap: 'grant', cand: { id: 'cand-1', content_sha256: 'a'.repeat(64) } },
      r,
    );
    expect(seen).toBe(p.op);
    expect(Object.isFrozen(seen)).toBe(true);
    expect((seen as unknown as { cand: { id: string } }).cand.id).toBe('cand-1');
    // 被改写的 op(cand-B)消费 → op 不等
    expect(reasonOfSync(() => requireGrowth(p, round, op))).toBe('op_mismatch');
  });

  it('veto_recheck_invalidates_old_mark:第二次现读进行期间旧标记失效(不可消费);第二次最终 veto → 作废', async () => {
    const { round } = await openBoth();
    const p = await pass(round, reqOf('candidate_create'));
    await checkGrowthVeto(p, round, CREATE, readers()); // 第一次:通过,盖章
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = readers({
      externalVeto: async () => {
        await gate;
        return { vetoed: true as const, why: 'marker' as const };
      },
    });
    const second = checkGrowthVeto(p, round, CREATE, slow);
    // 第二次悬而未决时,旧标记已撤销:此刻消费被拒(并作废)
    expect(reasonOfSync(() => requireGrowth(p, round, CREATE))).toBe('veto_not_checked');
    release();
    expect(await reasonOfAsync(() => second)).toBe('vetoed');
    expect(reasonOfSync(() => requireGrowth(p, round, CREATE))).toBe('already_used');
  });

  it('veto_check_in_flight:并发的两次现读 → 第二次拒绝并作废;第一次随后也因 pass 已作废而拒(绝不盖章)', async () => {
    const { round } = await openBoth();
    const p = await pass(round, reqOf('candidate_create'));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = readers({
      externalVeto: async () => {
        await gate;
        return { vetoed: false as const };
      },
    });
    const first = checkGrowthVeto(p, round, CREATE, slow);
    expect(await reasonOfAsync(() => checkGrowthVeto(p, round, CREATE, readers()))).toBe(
      'veto_check_in_flight',
    );
    release();
    expect(await reasonOfAsync(() => first)).toBe('already_used');
    expect(reasonOfSync(() => requireGrowth(p, round, CREATE))).toBe('already_used');
  });
});

describe('请求快照:检查对象与获准对象不可分叉', () => {
  it('评估期间调用方改写原请求对象(换候选 / 改 id / 改来源)→ reader 看到的与 pass 绑定的都是调用时的快照', async () => {
    const { round } = await openBoth();
    const original = cand({ id: 'cand-A', content_sha256: 'a'.repeat(64) });
    const req = { op: 'grant', cand: original } as { op: 'grant'; cand: ReturnType<typeof cand> };
    const seen: string[] = [];
    const r = readers({
      locks: async () => {
        // 等待锁检查期间,调用方通过可变别名把请求换成候选 B 并改写来源
        req.cand = cand({ id: 'cand-B', content_sha256: 'b'.repeat(64) });
        (original as { id: string }).id = 'cand-MUTATED';
        (original as { source: unknown }).source = null;
        await Promise.resolve();
      },
      taint: (_r, q) => {
        seen.push(`taint:${(q as { cand: { id: string } }).cand.id}`);
        return Promise.resolve({
          capabilityReady: true,
          scan: 'ok' as const,
          rescanRequired: false,
          rescanned: false,
          rescanRoundId: null,
          candidate: 'clean' as const,
        });
      },
      judge: (_r, q) => {
        seen.push(`judge:${q.cand.id}`);
        return Promise.resolve({ ok: true as const });
      },
    });
    const v = await evaluateGrowth(round, req, r, STAGE_ALL);
    expect(isGrowthPass(v)).toBe(true);
    expect(seen).toEqual(['taint:cand-A', 'judge:cand-A']);
    if (isGrowthPass(v)) {
      expect(v.op).toEqual({
        cap: 'grant',
        cand: { id: 'cand-A', content_sha256: 'a'.repeat(64) },
      });
    }
  });

  it('reader 收到的请求是冻结的快照(不能被 reader 改写)', async () => {
    const { round } = await openBoth();
    let frozen = false;
    const r = readers({
      judge: (_r, q) => {
        frozen = Object.isFrozen(q) && Object.isFrozen(q.cand);
        return Promise.resolve({ ok: true as const });
      },
    });
    await evaluateGrowth(round, reqOf('grant'), r, STAGE_ALL);
    expect(frozen).toBe(true);
  });

  it('畸形的来源(非对象)按「来源缺失」处理 → source_unknown', async () => {
    const { round } = await openBoth();
    const bad = cand({ source: 'oops' as never });
    expect(await deny(round, reqOf('grant', bad), readers())).toBe('source_unknown');
  });
});

describe('G6 对畸形事实 fail-closed(逐字段)', () => {
  const base = {
    capabilityReady: true,
    scan: 'ok',
    rescanRequired: false,
    rescanned: false,
    rescanRoundId: null,
    candidate: 'clean',
  };
  const mk = (over: Record<string, unknown>) =>
    readers({ taint: () => Promise.resolve({ ...base, ...over } as never) });
  it('G6 事实非布尔 / 缺键 / 非法枚举 → 拒绝(不被解释成「不要求重扫」)', async () => {
    const { round } = await openBoth();
    for (const [name, over, code] of [
      ['rescanRequired 非布尔', { rescanRequired: 'yes' }, 'taint_unavailable'],
      ['rescanRequired 缺键', { rescanRequired: undefined }, 'taint_unavailable'],
      ['rescanned 非布尔', { rescanned: 1 }, 'taint_unavailable'],
      ['rescanned 缺键', { rescanned: undefined }, 'taint_unavailable'],
      ['rescanRoundId 非字符串', { rescanRoundId: 5 }, 'taint_unavailable'],
      ['rescanRoundId 缺键', { rescanRoundId: undefined }, 'taint_unavailable'],
      ['scan 非法枚举', { scan: 'maybe' }, 'taint_unavailable'],
      ['capabilityReady 非布尔', { capabilityReady: 'true' }, 'taint_unavailable'],
      ['candidate 非法枚举', { candidate: 'fine' }, 'source_unknown'],
    ] as const) {
      expect(await deny(round, reqOf('grant'), mk(over)), name).toBe(code);
      if (!name.startsWith('candidate')) {
        // 创建不消费候选字段,只消费扫描 / 重扫字段
        expect(await deny(round, reqOf('candidate_create'), mk(over)), `create:${name}`).not.toBe(
          'PASS',
        );
      }
    }
    // 正向对照:合法事实通过
    expect(await deny(round, reqOf('grant'), mk({}))).toBe('PASS');
  });
});

describe('M1:candidate_create 要求「本轮」已完成重扫的证据(不由 rescanRequired 解除)', () => {
  const taint = (over: Record<string, unknown>) =>
    readers({
      taint: () =>
        Promise.resolve({
          capabilityReady: true,
          scan: 'ok',
          rescanRequired: false,
          rescanned: false,
          rescanRoundId: null,
          candidate: 'clean',
          ...over,
        } as never),
      throttle: () => Promise.resolve({ due: true }),
    });
  it('评审复现:rescanRequired=false 且 rescanned=false、due=true → 创建被拒 taint_pending(G9 不能替代重扫证据)', async () => {
    const { round } = await openBoth();
    expect(await deny(round, reqOf('candidate_create'), taint({}))).toBe('taint_pending');
    // 正向对照:同一组事实但证据属于本轮 → PASS
    expect(
      await deny(
        round,
        reqOf('candidate_create'),
        taint({ rescanned: true, rescanRoundId: round.id }),
      ),
    ).toBe('PASS');
  });
  it('证据不属于本轮(别的回合 id / null / 空串)→ taint_pending;rescanned 为假但带本轮 id 也拒', async () => {
    const { round } = await openBoth();
    for (const over of [
      { rescanned: true, rescanRoundId: 'other-round' },
      { rescanned: true, rescanRoundId: null },
      { rescanned: true, rescanRoundId: '' },
      { rescanned: false, rescanRoundId: round.id },
    ]) {
      expect(await deny(round, reqOf('candidate_create'), taint(over)), JSON.stringify(over)).toBe(
        'taint_pending',
      );
    }
  });
  it('不 due 仍由 G9 拒绝(重扫证据齐全也不放行);非创建的候选类只在 rescanRequired 时要求本轮证据', async () => {
    const { round } = await openBoth();
    const done = { rescanned: true, rescanRoundId: round.id };
    const notDue = readers({
      taint: () =>
        Promise.resolve({
          capabilityReady: true,
          scan: 'ok',
          rescanRequired: false,
          rescanned: true,
          rescanRoundId: round.id,
          candidate: 'clean',
        } as never),
      throttle: () => Promise.resolve({ due: false }),
    });
    expect(await deny(round, reqOf('candidate_create'), notDue)).toBe('throttled');
    // grant:不要求重扫 → 无证据也 PASS;要求重扫而证据属于别轮 → taint_pending;本轮证据 → PASS
    expect(await deny(round, reqOf('grant'), taint({}))).toBe('PASS');
    expect(
      await deny(
        round,
        reqOf('grant'),
        taint({ rescanRequired: true, rescanned: true, rescanRoundId: 'other-round' }),
      ),
    ).toBe('taint_pending');
    expect(await deny(round, reqOf('grant'), taint({ rescanRequired: true, ...done }))).toBe(
      'PASS',
    );
  });
});

describe('M2:候选来源逐字段校验(缺字段 = 来源缺失 = source_unknown,与 reader 无关)', () => {
  it('来源为 {} / 缺任一键 / 空串 / 非字符串 → source_unknown,且不调用任何 reader', async () => {
    const { round } = await openBoth();
    const bads: unknown[] = [
      {},
      { run_id: 'run-1' },
      { proposal_id: 'p-1' },
      { run_id: '', proposal_id: 'p-1' },
      { run_id: 'run-1', proposal_id: '' },
      { run_id: 1, proposal_id: 'p-1' },
      { run_id: 'run-1', proposal_id: null },
      [],
    ];
    for (const source of bads) {
      const r = readers();
      expect(
        await deny(round, reqOf('grant', cand({ source: source as never })), r),
        JSON.stringify(source),
      ).toBe('source_unknown');
      // G1 .. G5 是前序检查(可读);来源缺失在 G6 内先于 taint reader 判定
      expect(r.calls, JSON.stringify(source)).not.toContain('taint');
    }
    // 正向对照:合法来源通过,且 pass 绑定的仍是候选 id / 内容哈希
    expect(await deny(round, reqOf('grant', cand()), readers())).toBe('PASS');
  });
  it('所有候选类 op 都一样;创建 / bootstrap / admission 不看来源', async () => {
    const { round } = await openBoth();
    const bad = cand({ source: {} as never });
    for (const op of ['shadow_to_canary', 'grant', 'deploy_inject'] as const) {
      expect(await deny(round, reqOf(op, bad), readers()), op).toBe('source_unknown');
    }
    expect(await deny(round, reqOf('candidate_create'), readers())).toBe('PASS');
  });
});

describe('L1:GrowthStage.ops 按声明的 ReadonlySet 形状验证(不要求原生 Set)', () => {
  const wrapper = (ops: readonly string[]): GrowthStage => {
    const inner = new Set<string>(ops);
    return {
      ops: {
        has: (v: unknown) => inner.has(v as string),
        size: inner.size,
        forEach: () => undefined,
        entries: () => inner.entries(),
        keys: () => inner.keys(),
        values: () => inner.values(),
        [Symbol.iterator]: () => inner.values(),
      } as unknown as GrowthStage['ops'],
    };
  };
  it('非原生的 ReadonlySet 包装对象:含 op → 正常评估;不含 → growth_unwired(零 reader 调用)', async () => {
    const { round } = await openBoth();
    const r1 = readers();
    expect(await deny(round, reqOf('grant'), r1, wrapper(['grant']))).toBe('PASS');
    const r2 = readers();
    expect(await deny(round, reqOf('grant'), r2, wrapper(['bootstrap']))).toBe('growth_unwired');
    expect(r2.calls).toEqual([]);
  });
  it('畸形 ops(数组 / 无 has / has 抛错 / has 返回非 true)→ growth_unwired(fail-closed),零 reader 调用', async () => {
    const { round } = await openBoth();
    const bads: unknown[] = [
      ['grant'],
      {},
      null,
      { has: 1 },
      {
        has: () => {
          throw new Error('boom');
        },
      },
      { has: () => 'yes' },
      { has: () => 1 },
    ];
    for (const ops of bads) {
      const r = readers();
      expect(
        await deny(round, reqOf('grant'), r, { ops } as unknown as GrowthStage),
        JSON.stringify(ops),
      ).toBe('growth_unwired');
      expect(r.calls).toEqual([]);
    }
  });
});

describe('M2b:来源快照每个字段只读一次(校验对象 = 快照对象)', () => {
  it('getter 首次合法、再读非法:快照取首次读到的值,且每个字段只读一次', async () => {
    const { round } = await openBoth();
    const reads = { run_id: 0, proposal_id: 0 };
    const source = {
      get run_id(): string {
        reads.run_id += 1;
        return reads.run_id === 1 ? 'run-1' : '';
      },
      get proposal_id(): string {
        reads.proposal_id += 1;
        return reads.proposal_id === 1 ? 'p-1' : '';
      },
    };
    const seen: unknown[] = [];
    const r = readers({
      judge: (_r, q) => {
        seen.push(q.cand.source);
        return Promise.resolve({ ok: true as const });
      },
    });
    expect(await deny(round, reqOf('grant', cand({ source })), r)).toBe('PASS');
    expect(reads).toEqual({ run_id: 1, proposal_id: 1 });
    expect(seen).toEqual([{ run_id: 'run-1', proposal_id: 'p-1' }]);
  });
  it('getter 抛错 / Proxy 陷阱抛错 → 来源缺失 → source_unknown(不是异常);首次非法即缺失', async () => {
    const { round } = await openBoth();
    const throwing = {
      get run_id(): string {
        throw new Error('boom');
      },
      proposal_id: 'p-1',
    };
    const proxy = new Proxy(
      {},
      {
        get(): never {
          throw new Error('trap');
        },
      },
    );
    for (const source of [throwing, proxy]) {
      expect(await deny(round, reqOf('grant', cand({ source: source as never })), readers())).toBe(
        'source_unknown',
      );
    }
  });
  it('候选 id / 内容哈希取校验后的值:getter 二次读取变化不进入快照与 pass', async () => {
    const { round } = await openBoth();
    let n = 0;
    const c = {
      get id(): string {
        n += 1;
        return n === 1 ? 'cand-A' : 'cand-B';
      },
      content_sha256: 'a'.repeat(64),
      lifecycle: 'shadow',
      source: { run_id: 'run-1', proposal_id: 'p-1' },
    };
    const v = await evaluateGrowth(round, { op: 'grant', cand: c as never }, readers(), STAGE_ALL);
    expect(isGrowthPass(v)).toBe(true);
    if (isGrowthPass(v))
      expect(v.op).toEqual({
        cap: 'grant',
        cand: { id: 'cand-A', content_sha256: 'a'.repeat(64) },
      });
    expect(n).toBe(1);
  });
});
