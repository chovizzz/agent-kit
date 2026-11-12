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
 * 写模式先续做在途 journal(上次中断留下的;缩减入口自己可重试),再枚举新候选。候选枚举:私有仓库 `deferred`(人工分叉 / 属主变化)时凭据照样要写(R21-9.3a),
 * 候选改从 `head.json` 记录的提交里只读取(`recordedRecords` 端口);两处都读不到 → `unavailable`(fail-closed:**没有处理任何新候选**,并给出原因),不会假装已清空。
 * `unavailable` 只说明「枚举不可用」:此前续做的在途 journal 可能已经做了写入,结果在 `outcomes` 里。
 * 完整命令面(帮助、退出码表、TTY / 干跑文案)归 W8:本文件只交付能被测试调用的函数入口与结构化结果。
 */
import { capabilityAvailable } from '../../contracts/rsi.js';
import type { PersonalLifecycleRecord } from '../../contracts/rsi-personal.js';
import type { RepoRead, StepEnv } from './candidate-ports.js';
import { resumeAll, startRollback, type RollbackDeps, type RollbackOutcome } from './rollback.js';
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
  /** 开始时在途的 journal(上次中断留下;写模式下先续做) */
  inFlight: string[];
  outcomes: RollbackOutcome[];
  /**
   * 仓库 `.state` 下待对账的候选(canary.json / 分组账 / `exec-enabled.json` / 工作副本 / 终态效果):**不访问**,不把访问不到的文件当作已改写。
   * worker 下次拿锁后首件事按凭据对账(R21-9.5)。
   */
  pendingReconcile: string[];
  /**
   * 撤销已完成、但记录推进 / 私有仓库移除被 R21-9.3a 推迟的候选(outcome = `revocation_complete`):journal 保留,是 HOME 侧「待补记」任务,
   * 分叉解除后 worker 首个持锁写入方(`resumeAll`)补做。缩减入口不能访问工作副本,所以**不**写 `repo_removal_deferred=true`(`workingMarked=false`)。
   */
  repoRemovalPending: string[];
  /** 非 null = 候选枚举不可用 / 相位不允许(原因码):没有处理任何新候选;此前续做的在途 journal 的结果在 `outcomes` 里 */
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
    inFlight: [],
    outcomes: [],
    pendingReconcile: [],
    repoRemovalPending: [],
    unavailable: null,
  };
  if (!capabilityAvailable('cmd_auto_clear', d.phase)) {
    report.unavailable = 'phase_not_available';
    return report;
  }
  await d.locks.personal.assertHeld();

  /** 非终态候选;读不到 → null(并在 `unavailable` 里写原因) */
  const enumerate = async (): Promise<PersonalLifecycleRecord[] | null> => {
    let all: RepoRead<PersonalLifecycleRecord[]> = await d.store.readAll();
    if (all.kind === 'deferred') {
      all =
        d.recordedRecords === undefined
          ? { kind: 'invalid', why: 'recorded_read_not_wired' }
          : await d.recordedRecords();
    }
    if (all.kind === 'invalid') {
      report.unavailable = `repo_unreadable:${all.why}`;
      return null;
    }
    if (all.kind === 'deferred') {
      report.unavailable = 'repo_unreadable:recorded_read_deferred';
      return null;
    }
    const records = (all.kind === 'ok' ? all.value : []).filter(
      (r) => !isTerminalLifecycle(r.lifecycle),
    );
    report.candidates = records.map((r) => ({ id: r.id, lifecycle: r.lifecycle }));
    return records;
  };

  report.inFlight = await d.txns.list();
  if (!opts.write) {
    await enumerate();
    return report;
  }

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
    // 先续做在途 journal(上次 clear 崩溃留下的;缩减入口自己可重试,不依赖 worker 将来修复),再枚举新候选
    report.outcomes.push(...(await resumeAll(rd)));
    const records = await enumerate();
    if (records === null) return;
    for (const rec of records) {
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
  report.repoRemovalPending = [
    ...new Set(
      report.outcomes.flatMap((o) => (o.status === 'revocation_complete' ? [o.candidate_id] : [])),
    ),
  ];
  return report;
}
