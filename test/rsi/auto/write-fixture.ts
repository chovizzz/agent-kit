/**
 * W8b 写命令的测试夹具:内存端口。**端口假件必须通过 `port-contract.test.ts` 的写侧套件才可用于命令测试**(SOLID 的 L):
 * 用户暂停文件(`ensureUser` 不覆盖、指纹 CAS)、`PauseStatePort`(锁持有断言)、`EntryMarks`(单调)、带键效果落地(`applyOnce` 幂等、黑名单按 `(id, sha)` 集合插入)。
 * 回滚 / 清理端口复用 W7 夹具 `world7`(同一份契约)。**不调用被测函数**;期望值由测试自己手写。
 */
import type { RsiAutoPauseReason } from '../../../src/contracts/rsi.js';
import type { RsiAuditLine } from '../../../src/contracts/rsi-personal.js';
import { makeWriteHandlers } from '../../../src/rsi/auto/write/index.js';
import type {
  CommandLocks,
  HeldLocks,
  LockOrder,
  RebasePort,
  RebaseSituation,
  WritePorts,
} from '../../../src/rsi/auto/write/ports.js';
import { runAutoFamily } from '../../../src/rsi/auto/entry.js';
import type { AutoFamily } from '../../../src/rsi/auto/route.js';
import type {
  AutoPauseState,
  PauseMarker,
  PauseStatePort,
  UserMarkerPort,
  UserMarkerStamp,
} from '../../../src/rsi/personal/breaker.js';
import type {
  KeyedEffectResult,
  KeyedEffectSink,
} from '../../../src/rsi/personal/rollback-ports.js';
import type { TransitionEffect } from '../../../src/rsi/personal/transition.js';
import { RsiLockError } from '../../../src/rsi/lock-error.js';
import type { RsiEarlyContext } from '../../../src/rsi/types.js';
import { world7, type World7 } from '../rollback/w7-fixture.js';

/** 假锁:记录取 / 放顺序;`assertInside` 供写端口做「锁持有断言」 */
export class FakeLocks implements CommandLocks {
  log: string[] = [];
  held = new Set<string>();
  /** 非 null:取锁时抛 `locked`(试锁、不排队) */
  denied: 'locked' | null = null;
  assertInside(name: string): void {
    if (!this.held.has(name)) throw new Error(`lock not held: ${name}`);
  }
  async withLocks<T>(order: LockOrder, fn: (held: HeldLocks) => Promise<T>): Promise<T> {
    if (this.denied !== null) throw new RsiLockError('locked');
    const names = order === 'personal_sync' ? ['personal', 'sync'] : ['rsi', 'personal', 'sync'];
    for (const n of names) {
      this.log.push(`acquire:${n}`);
      this.held.add(n);
    }
    const guard = (n: string) => ({ assertHeld: async () => this.assertInside(n) });
    try {
      return await fn({
        rsi: order === 'rsi_personal_sync' ? guard('rsi') : null,
        personal: guard('personal'),
        syncLock: {
          withLock: async (f) => {
            this.assertInside('sync');
            return f();
          },
        },
      });
    } finally {
      for (const n of [...names].reverse()) {
        this.log.push(`release:${n}`);
        this.held.delete(n);
      }
    }
  }
}

/** 假用户暂停文件:与生产 `makeUserMarkerPort` 同一份契约(独占创建不覆盖;`remove` 只删与快照指纹逐项相等的那个实例,`none` 永不删) */
export class FakeUser implements UserMarkerPort {
  file: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint } | null = null;
  nextIno = 1n;
  creates = 0;
  removes = 0;
  /** 非 null:`snapshot` 抛该错误(模拟 `lstat` 非 ENOENT 失败) */
  snapshotError: Error | null = null;
  async exists(): Promise<boolean> {
    return (await this.snapshot()) !== 'none';
  }
  async snapshot(): Promise<UserMarkerStamp> {
    if (this.snapshotError !== null) throw this.snapshotError;
    return this.file === null ? 'none' : { ...this.file };
  }
  async ensureUser(): Promise<'created' | 'exists'> {
    if (this.file !== null) return 'exists';
    this.file = { dev: 1n, ino: this.nextIno, size: 30n, mtimeNs: this.nextIno * 1000n };
    this.nextIno += 1n;
    this.creates += 1;
    return 'created';
  }
  async remove(stamp: UserMarkerStamp): Promise<'removed' | 'changed' | 'absent'> {
    const cur = this.file;
    if (cur === null) return 'absent';
    if (
      stamp === 'none' ||
      stamp.dev !== cur.dev ||
      stamp.ino !== cur.ino ||
      stamp.size !== cur.size ||
      stamp.mtimeNs !== cur.mtimeNs
    ) {
      return 'changed';
    }
    this.file = null;
    this.removes += 1;
    return 'removed';
  }
  /** 模拟「模型外动作」:换一个新实例(手工 rm 再 pause) */
  replace(): void {
    this.file = null;
    void this.ensureUser();
  }
}

export class FakePauseState implements PauseStatePort {
  state: AutoPauseState = { reasons: [], diverged: false, owner_changed: false };
  writes: AutoPauseState[] = [];
  constructor(
    private readonly locks: FakeLocks,
    private readonly events: string[],
  ) {}
  async read(): Promise<AutoPauseState> {
    return structuredClone(this.state);
  }
  async write(s: AutoPauseState): Promise<void> {
    this.locks.assertInside('rsi');
    this.events.push('state.write');
    this.writes.push(structuredClone(s));
    this.state = structuredClone(s);
  }
}

export class FakeMarks {
  gen = 0;
  /** 每次 bump 之后(代数已加一)的钩子 */
  after: (() => void) | null = null;
  fail: Error | null = null;
  constructor(
    private readonly locks: FakeLocks,
    private readonly events: string[],
  ) {}
  async bump(): Promise<number> {
    this.locks.assertInside('rsi');
    if (this.fail !== null) throw this.fail;
    this.events.push('marks.bump');
    this.gen += 1;
    this.after?.();
    return this.gen;
  }
}

/** 假的带键效果落地:`applyOnce` 同键幂等;`blacklist_veto` 按 `(id, sha)` 集合插入(重复为空操作,计数不重复);`protection_mark` 与批次同一步骤落一行审计 */
export class FakeKeyedSink implements KeyedEffectSink {
  keys = new Set<string>();
  blacklist = new Set<string>();
  /** 黑名单附带计数:只在集合真正新增成员时 +1 */
  blacklistCount = 0;
  audits: RsiAuditLine[] = [];
  others: TransitionEffect[] = [];
  deferred = false;
  async applyOnce(key: string, effects: readonly TransitionEffect[]): Promise<KeyedEffectResult> {
    if (this.deferred) return 'deferred';
    if (this.keys.has(key)) return 'already';
    this.keys.add(key);
    for (const e of effects) {
      if (e.type === 'blacklist_veto') {
        const m = `${e.id}:${e.content_sha256}`;
        if (!this.blacklist.has(m)) {
          this.blacklist.add(m);
          this.blacklistCount += 1;
        }
      } else if (e.type === 'protection_mark') this.audits.push(e.line);
      else this.others.push(e);
    }
    return 'applied';
  }
}

export class FakeRebase implements RebasePort {
  situation: RebaseSituation = { kind: 'diverged', head: 'a'.repeat(40) };
  paths: string[] = ['rules/new-1.md', 'rules/new-2.md'];
  headWrites: ['baseline' | 'owner', string][] = [];
  classifyHook: ((n: number) => void) | null = null;
  classifyCalls = 0;
  async classify(): Promise<RebaseSituation> {
    this.classifyCalls += 1;
    this.classifyHook?.(this.classifyCalls);
    return structuredClone(this.situation);
  }
  async changedPaths(): Promise<readonly string[]> {
    return [...this.paths];
  }
  async rewriteHead(kind: 'baseline' | 'owner', head: string): Promise<void> {
    this.headWrites.push([kind, head]);
  }
}

export interface WriteFx {
  ports: WritePorts;
  locks: FakeLocks;
  user: FakeUser;
  pause: FakePauseState;
  marks: FakeMarks;
  rebase: FakeRebase;
  sink: FakeKeyedSink;
  w7: World7;
  /** 跨端口的发生顺序 */
  events: string[];
  holds: Set<RsiAutoPauseReason>;
  breaker: { marker: PauseMarker | null };
  rsiOn: { value: boolean };
  lifts: string[];
  /** 非 null:`peekRecord` 用它代替权威读(演练「锁外读与持锁后重读不一致」) */
  peek: { override: WritePorts['peekRecord'] | null; calls: number };
}

export const B_MARKER = (id = 'b'.repeat(16)): PauseMarker => ({
  by: 'breaker',
  reason: 'gate_internal',
  at: '2026-11-12T00:00:00.000Z',
  id,
});

export function makeFx(w7: World7 = world7()): WriteFx {
  const events: string[] = [];
  const locks = new FakeLocks();
  const user = new FakeUser();
  const sink = new FakeKeyedSink();
  const rebase = new FakeRebase();
  const holds = new Set<RsiAutoPauseReason>();
  const breaker: WriteFx['breaker'] = { marker: null };
  const rsiOn = { value: true };
  const lifts: string[] = [];
  const peek: WriteFx['peek'] = { override: null, calls: 0 };
  const pause = new FakePauseState(locks, events);
  const marks = new FakeMarks(locks, events);
  const origRemove = user.remove.bind(user);
  user.remove = async (s) => {
    events.push('user.remove');
    return origRemove(s);
  };
  const ports: WritePorts = {
    config: async () => ({ rsiOn: rsiOn.value }),
    locks,
    userMarker: async () => user,
    breaker: { read: async () => breaker.marker },
    pauseState: pause,
    holds: { snapshot: async () => new Set(holds) },
    marks,
    rollbackDeps: (held) => ({ ...w7.d, locks: { personal: held.personal }, keyedEffects: sink }),
    clearDeps: (held) => ({
      store: w7.d.store,
      revocations: w7.d.revocations,
      locks: { personal: held.personal },
      txns: w7.d.txns,
      revoker: w7.d.revoker,
      repo: w7.d.repo,
      payload: w7.d.payload,
      now: w7.d.now,
      phase: 2,
      syncLock: held.syncLock,
    }),
    peekRecord: async (id) => {
      peek.calls += 1;
      return peek.override !== null ? peek.override(id) : w7.store.read(id);
    },
    vetoLift: {
      lift: async (id) => {
        lifts.push(id);
        return 'lifted';
      },
    },
    rebase,
    outputForbidden: [],
  };
  return {
    ports,
    locks,
    user,
    pause,
    marks,
    rebase,
    sink,
    w7,
    events,
    holds,
    breaker,
    rsiOn,
    lifts,
    peek,
  };
}

export interface RunResult {
  code: number;
  out: string;
  err: string;
}

/** 经入口 `runAutoFamily` 跑写命令(相位 2;写处理函数表的端口 = `fx.ports`;`ports` 工厂被调用的次数记在 `built`) */
export async function runWrite(
  family: AutoFamily,
  argv: string[],
  fx: WriteFx,
  o: { tty?: boolean; input?: (string | undefined)[]; ports?: WritePorts } = {},
): Promise<RunResult & { built: number }> {
  let out = '';
  let err = '';
  let built = 0;
  const input = [...(o.input ?? [])];
  const ctx = {
    argv,
    overlayPath: undefined,
    explicitRoot: undefined,
    env: { KIT_REAL_HOME_OVERRIDE: '/nonexistent-home-w8b' },
    cwd: '/',
    stdout: (t: string) => void (out += t),
    stderr: (t: string) => void (err += t),
    isTty: o.tty ?? true,
    readLine: async () => input.shift(),
  } as RsiEarlyContext;
  const write = makeWriteHandlers(async () => {
    built += 1;
    return o.ports ?? fx.ports;
  });
  const code = await runAutoFamily(family, ctx, { phase: 2, write });
  return { code, out, err, built };
}
