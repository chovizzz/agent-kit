/**
 * D1a `FactsProvider` 测试世界:一份「全绿」的暂存提案 / 信号 / 草稿 / 记录 / 工作副本,以及按名字可注入故障的内存读端口。
 * 读端口遵守同一份契约:读失败抛普通错误(组合层须映射为 `null`),`lock_lost` 抛 `RsiLockError`(须原样传播)。
 * 期望值由本文件手写(`expectedGate` / `expectedPromote`),不调用被测组合层。
 */
import type {
  CandidateWorkingCopy,
  PersonalLifecycleRecord,
} from '../../../src/contracts/rsi-personal.js';
import type { RsiEffectsLedger } from '../../../src/contracts/rsi-store.js';
import type { Signal } from '../../../src/contracts/signal.js';
import { RsiLockError } from '../../../src/rsi/lock-error.js';
import { newRecord, newWorkingCopy } from '../../../src/rsi/personal/candidate-record.js';
import { buildDraft, type StagedProposal } from '../../../src/rsi/personal/candidate-source.js';
import type { CandidateDraft } from '../../../src/rsi/personal/gate-types.js';
import { makeFingerprint } from '../../../src/rsi/personal/fp/exact-fp.js';
import type { FactsReaders } from '../../../src/rsi/personal/facts/facts-ports.js';
import {
  DEFAULT_SIGNALS,
  NOW,
  goodFacts,
  staged,
  type StagedOpts,
} from '../personal/w3-fixture.js';
import { TEST_KEY } from './d1a-fixture.js';

export type ReaderName =
  | 'staged'
  | 'signals'
  | 'presets'
  | 'head'
  | 'ledger'
  | 'classifier'
  | 'taint'
  | 'policy'
  | 'context';

/** 每个方法依赖哪些读端口(契约的一部分;真件与假件都按它判定「读失败 → null」) */
export const DEPENDS: Record<'gate' | 'promote', readonly ReaderName[]> = {
  gate: ['staged', 'signals', 'presets', 'ledger', 'classifier', 'context'],
  promote: ['staged', 'signals', 'head', 'ledger', 'classifier', 'taint', 'policy'],
};

export type Failure = { reader: ReaderName; mode: 'error' | 'lock_lost' } | null;

export const emptyLedger = (): RsiEffectsLedger => ({
  schema_version: 1,
  gen: 0,
  blacklist: [],
  tombstones: [],
  cooldowns: [],
  applied: [],
});

export interface FactsWorld {
  sp: StagedProposal;
  signals: Signal[];
  draft: CandidateDraft;
  rec: PersonalLifecycleRecord;
  wc: CandidateWorkingCopy;
  headText: string | null;
  ledger: RsiEffectsLedger;
  runTainted: boolean;
  purgePresent: boolean;
  verdicts: Map<string, { excluded: boolean; attribution: 'collecting' | 'other' | 'unknown' }>;
  policy: { config_valid: boolean; enabled: boolean; authorized: boolean };
  /** 记录端口被调用的痕迹(用于「没调用不该调的端口」断言) */
  calls: { triggers: string[]; signalAsks: string[][]; runTaintAsks: string[] };
}

export const fingerprintOf = makeFingerprint(TEST_KEY);

export function makeWorld(o: StagedOpts = {}): FactsWorld {
  const sp = staged(o);
  const signals = o.signals ?? DEFAULT_SIGNALS;
  const r = buildDraft(sp, signals, { fingerprint: fingerprintOf });
  if (r.kind !== 'draft') throw new Error(`夹具草稿应成功:${r.reason}`);
  return {
    sp,
    signals: [...signals],
    draft: r.draft,
    rec: newRecord(r.draft, NOW.toISOString(), false),
    wc: newWorkingCopy(r.draft, signals),
    headText: r.draft.content,
    ledger: emptyLedger(),
    runTainted: false,
    purgePresent: false,
    verdicts: new Map(),
    policy: { config_valid: true, enabled: true, authorized: true },
    calls: { triggers: [], signalAsks: [], runTaintAsks: [] },
  };
}

export function readersOf(w: FactsWorld, failure: Failure = null): FactsReaders {
  const boom = (name: ReaderName): void => {
    if (failure?.reader !== name) return;
    if (failure.mode === 'lock_lost') throw new RsiLockError('lock_lost');
    throw new Error(`injected read failure: ${name}`);
  };
  const g = goodFacts(w.draft);
  const { existing, budget, replay } = g;
  if (existing === null || budget === null || replay === null)
    throw new Error('夹具错误:全绿闸事实不应含 null');
  const existingNoPresets = {
    atoms: existing.atoms,
    stableCandidates: existing.stableCandidates,
    frameworkIds: existing.frameworkIds,
    safetyAtomIds: existing.safetyAtomIds,
    projectNames: existing.projectNames,
  };
  return {
    staged: {
      list: async () => {
        boom('staged');
        return [w.sp];
      },
    },
    signals: {
      getMany: async (sigs) => {
        boom('signals');
        w.calls.signalAsks.push([...sigs]);
        return w.signals.filter((s) => sigs.includes(s.sig_id));
      },
    },
    presets: {
      presets: async () => {
        boom('presets');
        return [];
      },
    },
    head: {
      read: async () => {
        boom('head');
        return w.headText;
      },
    },
    ledger: {
      read: async () => {
        boom('ledger');
        return structuredClone(w.ledger);
      },
    },
    classifier: {
      classify: async (s) => {
        boom('classifier');
        return w.verdicts.get(s.sig_id) ?? { excluded: false, attribution: 'collecting' };
      },
    },
    taint: {
      runTainted: async (runId) => {
        boom('taint');
        w.calls.runTaintAsks.push(runId);
        return w.runTainted;
      },
      purgeJournalPresent: async () => {
        boom('taint');
        return w.purgePresent;
      },
    },
    policy: {
      read: async () => {
        boom('policy');
        return { ...w.policy };
      },
    },
    context: {
      failureTriggerHits: async (trigger) => {
        boom('context');
        w.calls.triggers.push(trigger);
        return 3;
      },
      existing: async () => {
        boom('context');
        return existingNoPresets;
      },
      budget: async () => {
        boom('context');
        return budget;
      },
      replay: async () => {
        boom('context');
        return replay;
      },
      pass2Clean: async () => {
        boom('context');
        return true;
      },
    },
  };
}

/** 手写的期望(默认世界,规则类别) */
export function expectedGate(w: FactsWorld) {
  const g = goodFacts(w.draft);
  return {
    draft: w.draft,
    evidence: w.signals.map((s) => ({
      sig: s.sig_id,
      excerpt: s.excerpt_redacted,
      signal: {
        excerpt: s.excerpt_redacted,
        sessionRef: s.session_ref,
        day: s.ts.slice(0, 10),
        excluded: false,
        attribution: 'collecting' as const,
      },
    })),
    failureTriggerHits: 0,
    pass2Clean: true,
    existing: g.existing,
    tombstoned: false,
    cooldownActive: false,
    budget: g.budget,
    replay: g.replay,
  };
}

export function expectedPromote(w: FactsWorld) {
  return {
    config_valid: true,
    enabled: true,
    authorized: true,
    tainted: false,
    cooldown_active: false,
    tombstoned: false,
    blacklisted: false,
    evidence_valid: true,
    sessions: 0,
    hits: 0,
    current_content_sha256: w.rec.content_sha256,
    current_cluster_signature: w.rec.cluster_signature ?? null,
  };
}
