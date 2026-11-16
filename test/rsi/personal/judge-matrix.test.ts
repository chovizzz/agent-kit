/**
 * W9a 验收矩阵(contracts R20-18.38、W0-27):{provenance 5} × {verdict 3} × {injection 2} × {layer 2} × {关联 3} × {run 6} × {候选状态 9} = 9720 格。
 * 判定部分(provenance / verdict / injection / layer / 关联 / run)由纯判定逐格断言,期望值来自本文件手写的独立决策表(不调用被测函数推导);
 * 候选状态部分由现有转移引擎断言:有信号时 proposed / shadow → rejected、canary → rolling_back、rolling_back 自环、终态空操作,
 * blocked / adopted / stable / retiring 本期无转移行 → 引擎拒绝 `phase_not_available`(W0-27:断言「拒绝、worker 不中断」所对应的纯判定与引擎部分);无信号时零转移。
 * 不可达 / 特殊格在表里列出并计数:无转移行的 4 个状态(预期拒绝)与终态(预期空操作)。端到端(worker 挂点、真 git)属 W9b,不在这里。
 */
import { describe, expect, it } from 'vitest';
import { evaluateJudgeSignal } from '../../../src/rsi/personal/judge-signal.js';
import { isRefusal, transition } from '../../../src/rsi/personal/transition.js';
import { E, UNIMPLEMENTED, ctxFor, rec } from './transition-fixture.js';
import {
  LINK,
  env,
  fakeSource,
  okRead,
  personalProposal,
  sessionJudged,
  spawnedJudged,
} from './judge-fixture.js';

const PROVENANCE = [
  'spawned_proven',
  'spawned_unproven',
  'session_valid',
  'session_invalid',
  'absent',
] as const;
const VERDICTS = ['accept', 'revise', 'reject'] as const;
const INJECTION = [true, false] as const;
const LAYERS = ['personal', 'team'] as const;
const LINKS = ['present', 'null', 'legacy_no_key'] as const;
const RUNS = ['normal', 'X', 'U', 'purged', 'tainted', 'missing'] as const;
const STATES = [
  'proposed',
  'shadow',
  'blocked',
  'canary',
  'adopted',
  'stable',
  'rolling_back',
  'retiring',
  'rejected',
] as const;

type Prov = (typeof PROVENANCE)[number];
type Layer = (typeof LAYERS)[number];

function proposalFor(
  prov: Prov,
  verdict: (typeof VERDICTS)[number],
  injection: boolean,
  layer: Layer,
): unknown {
  const base = personalProposal(layer === 'team' ? { layer: 'team' } : {});
  switch (prov) {
    case 'spawned_proven':
      return spawnedJudged({ verdict, injection }, base);
    case 'spawned_unproven':
      return spawnedJudged({ verdict, injection, provider: 'not-the-last-hop' }, base);
    case 'session_valid':
      return sessionJudged({ verdict, injection }, base);
    case 'session_invalid': {
      const raw = JSON.parse(JSON.stringify(sessionJudged({ verdict, injection }, base))) as {
        judge: { confirmation: { binding_sha256: string } };
      };
      raw.judge.confirmation.binding_sha256 = 'd'.repeat(64);
      return raw;
    }
    case 'absent':
      return base;
  }
}

/** 独立决策表:期望的 none 原因 / 信号(与实现的分支顺序无关,只按契约 ①–⑥ 的语义写) */
function expected(
  prov: Prov,
  verdict: string,
  injection: boolean,
  layer: Layer,
  link: string,
  run: string,
): { kind: 'signal'; verdict: 'reject' | 'injection' } | { kind: 'none'; reason: string } {
  if (link !== 'present') return { kind: 'none', reason: 'no_link' };
  if (run === 'purged' || run === 'missing') return { kind: 'none', reason: 'run_gone' };
  if (run !== 'normal') return { kind: 'none', reason: 'run_excluded' };
  if (layer === 'team') return { kind: 'none', reason: 'invalid' };
  if (prov !== 'spawned_proven' && prov !== 'session_valid') {
    return { kind: 'none', reason: 'not_verified' };
  }
  if (injection) return { kind: 'signal', verdict: 'injection' };
  if (verdict === 'reject') return { kind: 'signal', verdict: 'reject' };
  return { kind: 'none', reason: 'not_tightening' };
}

/** 引擎对「有信号」的期望(按候选状态) */
const ENGINE: Record<(typeof STATES)[number], string> = {
  proposed: 'transitioned:rejected',
  shadow: 'transitioned:rejected',
  canary: 'transitioned:rolling_back',
  rolling_back: 'transitioned:rolling_back',
  rejected: 'noop:rejected',
  blocked: 'refused:phase_not_available',
  adopted: 'refused:phase_not_available',
  stable: 'refused:phase_not_available',
  retiring: 'refused:phase_not_available',
};

function engineOutcome(state: (typeof STATES)[number], kind: 'reject' | 'injection'): string {
  const r = rec(state === 'canary' ? 'canary' : state, {
    ...(state === 'canary' ? { deploy: { claude: 'injected', pi: 'none', codex: 'none' } } : {}),
  });
  const ev =
    kind === 'injection'
      ? E.judge('j', { injection_suspected: true, verdict_reject: false })
      : E.judge('j');
  const res = transition(r, ev, ctxFor(r));
  if (isRefusal(res)) return `refused:${res.refused}`;
  return `${res.outcome}:${res.next.lifecycle}`;
}

describe('W9a 验收矩阵(R20-18.38):纯判定 × 引擎,9720 格', () => {
  it('引擎部分:每个候选状态对 reject / injection 信号的结果(无转移行的 4 个状态一律拒绝 phase_not_available,终态空操作)', () => {
    for (const s of STATES) {
      for (const k of ['reject', 'injection'] as const) {
        expect(engineOutcome(s, k), `${s}/${k}`).toBe(ENGINE[s]);
      }
    }
    expect([...UNIMPLEMENTED].sort()).toEqual(['adopted', 'blocked', 'retiring', 'stable']);
  });

  it('逐格:判定结果等于独立决策表;有信号时按状态得到引擎结果,无信号时零转移(格数 = 9720,各类格数与模型一致)', async () => {
    let cells = 0;
    let signalCells = 0;
    let refusedCells = 0;
    let noopCells = 0;
    let zeroTransitionCells = 0;
    let modelSignal = 0;
    for (const prov of PROVENANCE) {
      for (const verdict of VERDICTS) {
        for (const injection of INJECTION) {
          for (const layer of LAYERS) {
            const proposal = proposalFor(prov, verdict, injection, layer);
            for (const link of LINKS) {
              for (const run of RUNS) {
                const linkArg = link === 'present' ? LINK : link === 'null' ? null : undefined;
                const read =
                  run === 'normal'
                    ? okRead(proposal)
                    : run === 'purged' || run === 'missing'
                      ? { kind: 'run_gone' }
                      : { kind: 'run_excluded' };
                const got = await evaluateJudgeSignal(
                  linkArg,
                  fakeSource(() => read),
                  env,
                );
                const want = expected(prov, verdict, injection, layer, link, run);
                const label = [prov, verdict, injection, layer, link, run].join('/');
                if (want.kind === 'signal') {
                  expect(got, label).toMatchObject({ kind: 'signal', verdict: want.verdict });
                } else {
                  expect(got, label).toMatchObject({ kind: 'none', reason: want.reason });
                }
                for (const state of STATES) {
                  cells++;
                  if (got.kind !== 'signal') {
                    zeroTransitionCells++;
                    continue;
                  }
                  signalCells++;
                  const out = engineOutcome(state, got.verdict);
                  expect(out, `${label}/${state}`).toBe(ENGINE[state]);
                  if (out.startsWith('refused:')) refusedCells++;
                  if (out.startsWith('noop:')) noopCells++;
                }
                if (want.kind === 'signal') modelSignal += STATES.length;
              }
            }
          }
        }
      }
    }
    expect(cells).toBe(5 * 3 * 2 * 2 * 3 * 6 * 9);
    expect(cells).toBe(9720);
    expect(signalCells).toBe(modelSignal);
    // 信号格里:4 个无转移行状态各占一份拒绝,终态占一份空操作
    expect(refusedCells).toBe((signalCells / STATES.length) * UNIMPLEMENTED.length);
    expect(noopCells).toBe(signalCells / STATES.length);
    expect(signalCells + zeroTransitionCells).toBe(cells);
    // 防空转:确有信号格与无信号格
    expect(signalCells).toBeGreaterThan(0);
    expect(zeroTransitionCells).toBeGreaterThan(0);
  }, 120_000);

  it('accept / revise 记录存在与否:判定结果(原因除外)都是零转移,转移侧与「无记录」同为 none', async () => {
    for (const prov of ['spawned_proven', 'session_valid'] as const) {
      for (const verdict of ['accept', 'revise'] as const) {
        const withRec = await evaluateJudgeSignal(
          LINK,
          fakeSource(() => okRead(proposalFor(prov, verdict, false, 'personal'))),
          env,
        );
        const noRec = await evaluateJudgeSignal(
          LINK,
          fakeSource(() => okRead(personalProposal())),
          env,
        );
        expect(withRec.kind).toBe('none');
        expect(noRec.kind).toBe('none');
        // 忽略原因不同(not_tightening vs not_verified),这正是 Q5 把观察行排除在逐字节比较域之外的原因
        expect([withRec, noRec].map((x) => (x.kind === 'none' ? x.reason : ''))).toEqual([
          'not_tightening',
          'not_verified',
        ]);
      }
    }
  });
});
