/**
 * C1a 测试夹具:假锁句柄(与真实 `RsiLockHandle` / `PersonalLockHandle` 同一契约:`assertHeld` 丢锁 = `RsiLockError('lock_lost')`)、回合构造、
 * 全绿的 `GrowthReaders`(逐项可覆盖、记录调用顺序)。**不调用被测的判定函数**:期望值由测试自己手写。
 */
import type { PersonalLifecycleRecord } from '../../../src/contracts/rsi-personal.js';
import { RsiLockError } from '../../../src/rsi/lock-error.js';
import type { PersonalLockHandle } from '../../../src/rsi/personal/personal-lock.js';
import {
  attemptPersonal,
  type HeldPersonal,
  type HeldRsi,
} from '../../../src/rsi/personal/stage/lock-identity.js';
import {
  GROWTH_OPS,
  type GrowthReaders,
  type GrowthStage,
} from '../../../src/rsi/personal/stage/growth.js';
import {
  openRound,
  type BothRound,
  type RoundOpen,
  type RsiOnlyRound,
} from '../../../src/rsi/personal/stage/round.js';
import type { TaintCandidate } from '../../../src/rsi/personal/stage/taint-types.js';

export const RSI_NONCE = 'aaaa1111aaaa1111';
export const PERSONAL_NONCE = 'bbbb2222bbbb2222';

export interface FakeLock {
  readonly nonce: string;
  held: boolean;
  releases: number;
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}
export function fakeLock(nonce: string): FakeLock {
  const l: FakeLock = {
    nonce,
    held: true,
    releases: 0,
    assertHeld: () => (l.held ? Promise.resolve() : Promise.reject(new RsiLockError('lock_lost'))),
    release: () => {
      l.releases += 1;
      return Promise.resolve();
    },
  };
  return l;
}
export const asRaw = (l: FakeLock): PersonalLockHandle =>
  ({ ...l, path: '/x/personal/lock' }) as unknown as PersonalLockHandle;

export interface World {
  rsi: FakeLock;
  personalRaw: FakeLock;
  held: HeldRsi;
  personal: HeldPersonal;
  round: BothRound;
}
export async function openBoth(
  nonces: { rsi?: string; personal?: string } = {},
  newId?: () => string,
): Promise<World> {
  const rsi = fakeLock(nonces.rsi ?? RSI_NONCE);
  const personalRaw = fakeLock(nonces.personal ?? PERSONAL_NONCE);
  const attempt = await attemptPersonal(() => Promise.resolve(asRaw(personalRaw)));
  const o = openRound(rsi, attempt, newId === undefined ? {} : { newId });
  if (o.kind !== 'both') throw new Error('fixture: expected both');
  return { rsi, personalRaw, held: rsi, personal: o.personal, round: o.round };
}
export async function openBusy(): Promise<{ rsi: FakeLock; round: RsiOnlyRound; open: RoundOpen }> {
  const rsi = fakeLock(RSI_NONCE);
  const attempt = await attemptPersonal(() => Promise.reject(new RsiLockError('locked')));
  const open = openRound(rsi, attempt);
  if (open.kind !== 'rsi_only') throw new Error('fixture: expected rsi_only');
  return { rsi, round: open.round, open };
}

export const STAGE_ALL: GrowthStage = { ops: new Set(GROWTH_OPS) };

export const cand = (over: Partial<TaintCandidate> = {}): TaintCandidate => ({
  id: 'cand-1',
  content_sha256: 'a'.repeat(64),
  lifecycle: 'shadow',
  source: { run_id: 'run-1', proposal_id: 'p-1' },
  ...over,
});

export const rec = (source: PersonalLifecycleRecord['source_proposal']): PersonalLifecycleRecord =>
  ({ id: 'cand-1', source_proposal: source }) as unknown as PersonalLifecycleRecord;

export interface RecordedReaders extends GrowthReaders {
  readonly calls: string[];
}
/** 全绿读端口;`over` 逐项覆盖;`calls` 记录调用顺序(用于「按 op 的检查子集」钉死) */
export function readers(over: Partial<GrowthReaders> = {}): RecordedReaders {
  const calls: string[] = [];
  const wrap =
    <A extends unknown[], R>(name: string, f: (...a: A) => Promise<R>) =>
    (...a: A): Promise<R> => {
      calls.push(name);
      return f(...a);
    };
  const base: GrowthReaders = {
    capability: wrap('capability', () => Promise.resolve({ ready: true })),
    config: wrap('config', () =>
      Promise.resolve({ trusted: true, autoEnabled: true, confirmed: true }),
    ),
    state: wrap('state', () =>
      Promise.resolve({ valid: true, paused: false, flags: false, safetyFault: false }),
    ),
    repo: wrap('repo', () => Promise.resolve({ ok: true as const })),
    barrier: wrap('barrier', () => Promise.resolve({ ok: true as const })),
    // 默认:本轮已完成重扫的证据(`rescanRoundId` 取自收到的 round,创建操作的 G6 才能通过)
    taint: wrap('taint', (round: BothRound) =>
      Promise.resolve({
        capabilityReady: true,
        scan: 'ok' as const,
        rescanRequired: false,
        rescanned: true,
        rescanRoundId: round.id as string | null,
        candidate: 'clean' as const,
      }),
    ),
    purge: wrap('purge', () => Promise.resolve({ capabilityReady: true, journalPresent: false })),
    judge: wrap('judge', () => Promise.resolve({ ok: true as const })),
    throttle: wrap('throttle', () => Promise.resolve({ due: true })),
    locks: wrap('locks', () => Promise.resolve()),
    admission: wrap('admission', () =>
      Promise.resolve({ wired: true, effective: true, versionsMatch: true }),
    ),
    extra: wrap('extra', () => Promise.resolve({ ok: true as const })),
    externalVeto: wrap('externalVeto', () => Promise.resolve({ vetoed: false as const })),
  };
  const merged: GrowthReaders = { ...base, ...over };
  // 覆盖项也记录调用
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(merged) as (keyof GrowthReaders)[]) {
    const f = merged[k] as (...a: unknown[]) => Promise<unknown>;
    out[k] = over[k] === undefined ? f : wrap(k, f);
  }
  return Object.assign(out as unknown as GrowthReaders, { calls });
}
