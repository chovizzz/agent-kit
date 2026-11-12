/**
 * 缩减入口 `rsi auto clear [--write]`(docs/contracts.md R21-9.5 的「缩减入口」、R21-3.3、R21-9.3a;§21.24 W0-17)的入口函数。
 * **只读写 HOME 侧**(登记表、`rsi-personal/`、私有仓库、本机 payload),**只拿 `personal/lock` → sync 锁**(调用方已持 `personal/lock`,这里在其内取 sync 锁),不取 `rsi/lock`。
 *
 * 结构性保证「不访问仓库 `.state`」:本函数**不接受**调用方的 `cache` / `working` / `audit` / `effects` / `env` 端口,自己装配
 * `pendingCacheCleanup`(恒 `pending`,记待对账)、无写的工作副本与审计、`deferredKeyedEffects`(终态效果记待对账)与常量环境(相位 + 非自动循环)。
 * 所以 `[rsi]` 不可用、原仓库已不存在时它照样能完成(R21-9.5 验收②:退出 0 且没有创建任何仓库 `.state` 文件)。
 *
 * 每个非终态候选走一遍回滚四段(txn `kind=clear`,凭据 `by=clear` / `reason=cleared`):第二段凭据落盘 → 第三段私有仓库(干净则提交,否则 `deferred`,R21-9.3a)→
 * 第四段经撤销路径清理 HOME。权威记录由转移引擎的 `clear` 事件推进(proposed / shadow → 终态 `cleared`,canary → `rolling_back` 再走四段)。
 * 候选枚举:私有仓库 `deferred`(人工分叉 / 属主变化)时凭据照样要写(R21-9.3a),候选改从 `head.json` 记录的提交里只读取(`recordedRecords` 端口);两处都读不到 → `unavailable`
 * (fail-closed,不写任何东西,并给出原因),不会假装已清空。
 * 完整命令面(帮助、退出码表、TTY / 干跑文案)归 W8:本文件只交付能被测试调用的函数入口与结构化结果。
 */
import { capabilityAvailable } from '../../contracts/rsi.js';
import type { PersonalLifecycleRecord } from '../../contracts/rsi-personal.js';
import type { RepoRead, StepEnv } from './candidate-ports.js';
import { startRollback, type RollbackDeps, type RollbackOutcome } from './rollback.js';
import { deferredKeyedEffects, pendingCacheCleanup } from './rollback-ports.js';
import { isTerminalLifecycle } from './transition-table.js';

export interface ClearDeps extends Pick<
  RollbackDeps,
  | 'store'
  | 'revocations'
  | 'locks'
  | 'txns'
  | 'revoker'
  | 'repo'
  | 'payload'
  | 'now'
  | 'recordedSha'
  | 'onStep'
> {
  /** `RSI_AUTO_PHASE`(整数);`cmd_auto_clear` 的能力闸 */
  phase: number;
  /** sync 锁(§19.5):在 `personal/lock` 之内取;拿不到抛 `RsiLockError` */
  syncLock: { withLock<T>(fn: () => Promise<T>): Promise<T> };
  /** 私有仓库 `deferred` 时的只读候选列表(`head.json` 记录的提交);缺省 = 读不到 */
  recordedRecords?: () => Promise<RepoRead<PersonalLifecycleRecord[]>>;
}

export interface ClearReport {
  write: boolean;
  /** 待清候选(非终态) */
  candidates: { id: string; lifecycle: string }[];
  outcomes: RollbackOutcome[];
  /**
   * 仓库 `.state` 下待对账的候选(canary.json / 分组账 / `exec-enabled.json` / 工作副本 / 终态效果):**不访问**,不把访问不到的文件当作已改写。
   * worker 下次拿锁后首件事按凭据对账(R21-9.5)。
   */
  pendingReconcile: string[];
  /** 非 null = 没有做任何写入(原因码) */
  unavailable: string | null;
}

/** 常量环境:不读 `.state/rsi/state.json`;`clear` 事件是缩减影响的终止事件,不依赖自动循环 / 暂停状态 */
const constEnv = (phase: number): StepEnv => ({
  phase,
  autoLoopEffective: false,
  autoPaused: false,
  marks: { enabled: false, paused: false, policyFp: '', resetGen: 0 },
});

export async function rsiAutoClear(d: ClearDeps, opts: { write: boolean }): Promise<ClearReport> {
  const report: ClearReport = {
    write: opts.write,
    candidates: [],
    outcomes: [],
    pendingReconcile: [],
    unavailable: null,
  };
  if (!capabilityAvailable('cmd_auto_clear', d.phase)) {
    report.unavailable = 'phase_not_available';
    return report;
  }
  await d.locks.personal.assertHeld();
  let all: RepoRead<PersonalLifecycleRecord[]> = await d.store.readAll();
  if (all.kind === 'deferred') {
    all =
      d.recordedRecords === undefined
        ? { kind: 'invalid', why: 'recorded_read_not_wired' }
        : await d.recordedRecords();
  }
  if (all.kind === 'invalid') {
    report.unavailable = `repo_unreadable:${all.why}`;
    return report;
  }
  if (all.kind === 'deferred') {
    report.unavailable = 'repo_unreadable:recorded_read_deferred';
    return report;
  }
  const records = all.kind === 'ok' ? all.value : [];
  report.candidates = records
    .filter((r) => !isTerminalLifecycle(r.lifecycle))
    .map((r) => ({ id: r.id, lifecycle: r.lifecycle }));
  if (!opts.write) return report;

  // 只拿 personal/lock(调用方已持)→ sync 锁;不取 rsi/lock
  const rd: RollbackDeps = {
    store: d.store,
    working: { list: async () => [], put: async () => undefined },
    revocations: d.revocations,
    audit: { append: async () => undefined },
    effects: { apply: async () => undefined },
    env: { read: async () => constEnv(d.phase) },
    now: d.now,
    locks: d.locks,
    txns: d.txns,
    revoker: d.revoker,
    cache: pendingCacheCleanup,
    repo: d.repo,
    payload: d.payload,
    keyedEffects: deferredKeyedEffects,
    ...(d.recordedSha !== undefined ? { recordedSha: d.recordedSha } : {}),
    ...(d.onStep !== undefined ? { onStep: d.onStep } : {}),
  };
  await d.syncLock.withLock(async () => {
    for (const rec of records) {
      if (isTerminalLifecycle(rec.lifecycle)) continue;
      report.outcomes.push(
        await startRollback(rd, {
          candidate_id: rec.id,
          content_sha256: rec.content_sha256,
          kind: 'clear',
          reason: 'cleared',
          by: 'clear',
          target_terminal: 'rolled_back',
          event: { kind: 'clear', evidence: 'rsi auto clear' },
        }),
      );
      report.pendingReconcile.push(rec.id);
    }
  });
  return report;
}
