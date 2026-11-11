/**
 * W1 转移引擎测试夹具:合法记录 / 上下文 / 事件构造器。**不调用被测引擎**(夹具里的期望由测试自己手写)。
 */
import type { PersonalLifecycleRecord } from '../../../src/contracts/rsi-personal.js';
import type { RsiLifecycleState } from '../../../src/contracts/rsi.js';
import type {
  PromoteBase,
  TransitionCtx,
  TransitionEvent,
} from '../../../src/rsi/personal/transition-table.js';

export const ID = 'ra_0123456789ab';
export const NOW = '2026-11-10T12:00:00Z';
export const TODAY = '2026-11-10';
export const SHA = 'a'.repeat(64);
export const SIG = { kind: 'tool', tool_name: 'Bash' } as const;
export const OTHER_SIG = { kind: 'tool', tool_name: 'Edit' } as const;

export const TERMINALS = ['rejected', 'expired', 'rolled_back', 'retired'] as const;
export const UNIMPLEMENTED = ['blocked', 'adopted', 'stable', 'retiring'] as const;

export type Deploy = PersonalLifecycleRecord['deploy'];
export const NONE: Deploy = { claude: 'none', pi: 'none', codex: 'none' };

/** 进入 canary 的时刻(`canaryDays` 从它起算) */
export const CANARY_AT = '2026-11-01T00:00:00Z';

/** 一条合法的 transitions 条目(夹具用;键唯一) */
export function entry(
  i: number,
  to = 'proposed',
  at = '2026-10-01T00:00:00Z',
): PersonalLifecycleRecord['transitions'][number] {
  return {
    dim: 'lifecycle',
    from: 'proposed',
    to,
    at,
    reason: 'ingested',
    idem_key: i.toString(16).padStart(16, '0'),
  };
}

export function rec(
  lifecycle: RsiLifecycleState,
  o: Partial<PersonalLifecycleRecord> = {},
): PersonalLifecycleRecord {
  const terminal = (TERMINALS as readonly string[]).includes(lifecycle);
  const base: PersonalLifecycleRecord = {
    schema_version: 1,
    id: ID,
    category: 'rule',
    lifecycle,
    deploy: { ...NONE },
    watch: { claude: null, pi: null, codex: null },
    rollback:
      lifecycle === 'rolling_back' || lifecycle === 'retiring'
        ? { phase: 'rollback_requested', reason: 'vetoed', target_terminal: 'rolled_back' }
        : null,
    target_paths: ['rules/ra_0123456789ab.md'],
    content_sha256: SHA,
    fp_hmac: '0123456789abcdef',
    cluster_id: 'cluster-1',
    case_set_sha256: null,
    blocked_from: lifecycle === 'blocked' ? 'shadow' : null,
    transitions:
      lifecycle === 'canary' || lifecycle === 'rolling_back'
        ? [entry(1), entry(2, 'canary', CANARY_AT)]
        : [entry(1)],
    transitions_dropped: 0,
    terminal_reason: terminal ? 'rejected_gate' : null,
    overlaps_preset: false,
    source_proposal: null,
    cluster_signature: { ...SIG },
  };
  return { ...base, ...o };
}

export function ctxFor(
  r: Pick<PersonalLifecycleRecord, 'lifecycle'>,
  o: Partial<TransitionCtx> = {},
): TransitionCtx {
  return {
    phase: 2,
    now: NOW,
    revocation_listed: false,
    authoritative_lifecycle: r.lifecycle,
    auto_loop_effective: true,
    auto_paused: false,
    ...o,
  };
}

type Ev<K extends TransitionEvent['kind']> = Extract<TransitionEvent, { kind: K }>;
const ev = <K extends TransitionEvent['kind']>(
  kind: K,
  rest: Omit<Ev<K>, 'kind' | 'evidence'>,
  evidence: string,
): Ev<K> => ({ kind, evidence, ...rest }) as Ev<K>;

/** 推进事实(全部成立、名额空闲、会话与命中刚好达标) */
export function FACTS(o: Partial<PromoteBase> = {}): PromoteBase {
  return {
    config_valid: true,
    enabled: true,
    authorized: true,
    tainted: false,
    cooldown_active: false,
    tombstoned: false,
    blacklisted: false,
    evidence_valid: true,
    sessions: 20,
    hits: 2,
    current_content_sha256: SHA,
    current_cluster_signature: { ...SIG },
    slot_occupied: false,
    ...o,
  };
}

export const E = {
  gatesPassed: (evidence = 'g1', o: Partial<Ev<'gates_passed'>> = {}): Ev<'gates_passed'> =>
    ev('gates_passed', { gates_green: true, ...o }, evidence),
  gateRed: (gate_reason = 'g1_phrase', evidence = 'r1'): Ev<'gate_red'> =>
    ev('gate_red', { gate_reason }, evidence),
  noHit: (evidence = 'nh1', o: Partial<Ev<'shadow_no_hit'>> = {}): Ev<'shadow_no_hit'> =>
    ev('shadow_no_hit', { sessions: 20, hits: 1, ...o }, evidence),
  queueExpired: (
    queued_since: string | null = '2026-10-11',
    evidence = 'q1',
  ): Ev<'shadow_queue_expired'> => ev('shadow_queue_expired', { queued_since }, evidence),
  promote: (evidence = 'p1', o: Partial<Ev<'shadow_promote'>> = {}): Ev<'shadow_promote'> =>
    ev('shadow_promote', { ...FACTS(), queued_since: null, ...o }, evidence),
  veto: (evidence = 'v1'): Ev<'veto'> => ev('veto', {}, evidence),
  taint: (evidence = 't1'): Ev<'taint'> => ev('taint', {}, evidence),
  clear: (evidence = 'c1'): Ev<'clear'> => ev('clear', {}, evidence),
  judge: (evidence = 'j1', o: Partial<Ev<'judge_reject'>> = {}): Ev<'judge_reject'> =>
    ev(
      'judge_reject',
      { validated: true, verdict_reject: true, injection_suspected: false, ...o },
      evidence,
    ),
  harm: (evidence = 'h1', o: Partial<Ev<'harm'>> = {}): Ev<'harm'> =>
    ev('harm', { metric: 'c1', worse: true, ...o }, evidence),
  limit: (evidence = 'l1', max_arm_sessions = 120): Ev<'canary_limit'> =>
    ev('canary_limit', { max_arm_sessions }, evidence),
  decide: (evidence = 'd1'): Ev<'decide_better'> => ev('decide_better', {}, evidence),
  inject: (
    agent: 'claude' | 'pi' | 'codex' = 'claude',
    evidence = 'i1',
    admitted = true,
  ): Ev<'deploy_inject'> => ev('deploy_inject', { agent, admitted }, evidence),
  advance: (
    to: Ev<'rollback_advance'>['to'],
    evidence = 'a1',
    current_completed = true,
  ): Ev<'rollback_advance'> => ev('rollback_advance', { to, current_completed }, evidence),
  removal: (
    agent: 'claude' | 'pi' | 'codex' = 'claude',
    evidence = 'rm1',
    criterion_met = true,
  ): Ev<'removal_done'> => ev('removal_done', { agent, criterion_met }, evidence),
  done: (evidence = 'cd1', completion_met = true): Ev<'compensation_done'> =>
    ev('compensation_done', { completion_met }, evidence),
};

/** 深冻结(验证引擎不改入参) */
export function deepFreeze<T>(x: T): T {
  if (x !== null && typeof x === 'object' && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x as Record<string, unknown>)) deepFreeze(v);
  }
  return x;
}
