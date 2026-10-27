/**
 * rsi 共享类型与错误(R20-A2 B3-0 冻结;B3a / B3b / B3c 三路并行只往各自文件里填实现,**不得**再各自加共享类型,要加改这里并告知主代理)。
 *
 * 目录约定:
 *  - 入口文件 `src/rsi/<子命令>.ts`(各导出 `subcommand: RsiSubcommand`),分发器 `src/commands/rsi.ts`;
 *  - 服务层 `src/rsi/services/*`:只接受 `RsiServiceCtx` 与 `RsiLockHandle`,**自己绝不拿锁**;
 *  - 锁接线 `src/rsi/with-lock.ts`(`withRsiLockIfGated`)。
 *
 * 两条冻结的调用顺序(deny / refuse 之前:不建上下文、不建 `rsi/`、不拿锁、不恢复快照、不写任何东西):
 *  1. **rsi 自己的子命令**(tick/status/projects/confirm/stop/purge/poke/hint):`main()` 在通用 `createIoContext` 之前把 `rsi` 分流给
 *     `runEarly`(v2 §5)→ 分发器解析子命令(纯函数)→ `subcommand.run(early)` → `openRsiIo(early)`:`loadRsiConfig`(只读)→
 *     `off` 则返回 off(由子命令决定输出,不猜、不回退到通用上下文)→ `on` 才 `createRsiIoContext`(`explicitRoot` 与 `[rsi] repo` 不符 = 退出 2 `root_mismatch`)→
 *     (写入方)`withRsiLockIfGated` → 锁内 `recoverSnapshot(productionSnapshotValidator)` → `resumeTaint` → 业务(新 taint 经 `taintNewlyExcluded`)→
 *     `writeCountsProjection` → state / cursor → `commitUnderLock`(最后一步)。
 *  2. **现有写入方 reflect/judge/gc/promote**(沿用 `main()` 的通用 `ctx.io`):`loadRsiConfig` → `privacyGate`(judge / promote 才查;deny → 退出 3,此前零副作用)→
 *     `lockGate`(经 `withRsiLockIfGated`;refuse → 退出 3 `state_dir_unsafe`;off → 行为逐字节不变)→ 锁内 `recoverSnapshot` →
 *     `resumeTaint` → 即时闸 `immediateGate`(读暂存区前)→ 业务 → 每个外发 / 落盘 / 输出点前再过一次即时闸 →
 *     `writeCountsProjection` → `commitUnderLock`(最后一步)。
 */
import type { ExitCodeValue } from '../contracts/exit-codes.js';
import { ExitCode } from '../contracts/exit-codes.js';
import type {
  RSI_TRIGGERS,
  RsiCounts,
  RsiFailClosedReason,
  RsiLogLine,
  RsiPurgeJournal,
} from '../contracts/rsi.js';
import type { EarlyCommandContext } from '../commands/types.js';
import type { IoContext } from '../io/paths.js';
import type { RsiConfigOn, RsiOffReason } from './config.js';

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
/** 分发器交给子命令的上下文:`EarlyCommandContext`,`argv` 已去掉子命令名。**没有** `io`:子命令经 `openRsiIo` 自己建。 */
export type RsiEarlyContext = EarlyCommandContext;

/** 一个 rsi 子命令。`name` 即命令行里的第二个词;`owner` 写后续负责实装的块(桩说明与交接用)。 */
export interface RsiSubcommand {
  readonly name: string;
  readonly owner: 'B3a' | 'B3b' | 'B3c' | 'B4' | 'B5' | 'A3';
  run(ctx: RsiEarlyContext): Promise<number>;
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------
/** 稳定码 + 退出码的统一载体(`RSI_FAIL_CLOSED reason=…`,退出 3)。拿锁失败仍用 `RsiLockError`(自带 `toStable()`)。 */
export class RsiFailClosedError extends Error {
  readonly code = 'RSI_FAIL_CLOSED';
  readonly exit: ExitCodeValue = ExitCode.FAIL_CLOSED;
  constructor(readonly reason: RsiFailClosedReason) {
    super(`rsi: fail-closed ${reason}`);
  }
  toStable(): { code: 'RSI_FAIL_CLOSED'; reason: RsiFailClosedReason; exit: ExitCodeValue } {
    return { code: this.code, reason: this.reason, exit: this.exit };
  }
}

// ---------------------------------------------------------------------------
// 服务层上下文
// ---------------------------------------------------------------------------
/**
 * 服务层上下文。`config` 必为 `on`(`off` 时不应走到服务层:调用方在 `withRsiLockIfGated` 拿到 `null` 句柄、或 `openRsiIo` 返回 off 时就分流了)。
 * `io` 是调用方当前使用的上下文:rsi 子命令用 `createRsiIoContext` 的结果,现有写入方用 `main()` 的通用上下文。
 * `now` 可注入(R20-6.10:时间只经注入)。
 */
export interface RsiServiceCtx {
  readonly io: IoContext;
  readonly config: RsiConfigOn;
  readonly now?: () => Date;
}

// ---------------------------------------------------------------------------
// openRsiIo(B3a 实装;B3b / B3c 复用结果类型)
// ---------------------------------------------------------------------------
export type RsiOpenResult =
  /** 配置为 off(含全部 cfg_* / repo_invalid):不建任何上下文;子命令按自己的契约输出(status 报 reason,写入方退 4 `off` 等) */
  | { kind: 'off'; reason: RsiOffReason }
  /** 配置 on,rsi 专用上下文已建好(只建了对象,没有创建任何目录、没有拿锁) */
  | { kind: 'ready'; ctx: RsiServiceCtx }
  /** `--root` 与 `[rsi] repo` 不一致等用法错误:退出 2 */
  | { kind: 'usage'; code: 'RSI_USAGE'; reason: 'root_mismatch'; exit: 2 };

// ---------------------------------------------------------------------------
// taint / journal(B3c)
// ---------------------------------------------------------------------------
/**
 * purge journal 的只读探测结果(R20-3.8.5)。「读不出」与「不存在」必须分开:`unreadable` 一律按 `purge_incomplete` 之类 fail-closed 处理,
 * **不得**当成 `absent`。`invalid` = 能读但过不了 `RsiPurgeJournalSchema`。
 */
export type PurgeJournalProbe =
  | { state: 'absent' }
  | { state: 'present'; phase: RsiPurgeJournal['phase'] }
  | { state: 'invalid' }
  | { state: 'unreadable' };

/** 锁内 taint 续做的结果(R20-4.7):计数只含整数 */
export interface TaintResumeOutcome {
  /** 本次补完了清理的带 `TAINTED` 的暂存 run / promote 产物个数 */
  runsCompleted: number;
  promotesCompleted: number;
  /** 续做了 purge journal 的哪个阶段起点(没有 journal = null) */
  journalResumedFrom: RsiPurgeJournal['phase'] | null;
}

/** 锁内「发现并标记新 taint」的结果(R20-4.7 时机 / 动作):计数只含整数 */
export interface TaintScanOutcome {
  /** 本次新创建 `TAINTED` 并清理完成的暂存 run / promote 产物个数 */
  runsMarked: number;
  promotesMarked: number;
}

/** 新 taint 的来源:`exclude` = 按当前配置与索引现算已排除的 key;`purge` = 按 journal 里**已记下**的目标集合(不重新推导) */
export type TaintScanSource = { source: 'exclude' } | { source: 'purge'; journal: RsiPurgeJournal };

// ---------------------------------------------------------------------------
// 即时闸(B3c 实装;B3b 的 judge / promote 接线调用)
// ---------------------------------------------------------------------------
/** 即时闸检查的对象:`kind` 决定码的写法(judge 的 `JUDGE_*` 前缀等由调用方映射),`runId` 是被读的暂存 run */
export interface ImmediateGateScope {
  readonly kind: 'judge' | 'promote';
  readonly runId: string;
}

/**
 * R20-4.8 的结果。**非 allow 必须短路**:不得继续外发 / 落盘 / 打印(调用方自己拿退出码与稳定码,不另行解释)。
 *  - `tainted`:有 `TAINTED` 或证据归属属于 X(`reason`:`exclude` | `purge`)→ `RSI_RUN_TAINTED`,退出 1;
 *  - `attribution_unknown`:证据归属属于 U → `RSI_RUN_ATTRIBUTION_UNKNOWN`,退出 1;
 *  - `fail_closed`:purge journal 存在(`purge_incomplete`)或 `[rsi]` 配置不可用(`cfg_*` / `repo_invalid` / `overlay_invalid` / `exclude_invalid`)→ 退出 3。
 * 每次调用现算,**不缓存**(契约:排除写下后的下一次调用即生效):实现必须**重新读取**当前配置与索引,不能只用 `RsiServiceCtx.config` 的快照
 * (配置来源取 `io.hostEnv`,不需要新增共享字段)。
 */
export type ImmediateGateResult =
  | { kind: 'allow' }
  | {
      kind: 'tainted';
      code: 'RSI_RUN_TAINTED';
      runId: string;
      reason: 'exclude' | 'purge';
      exit: 1;
    }
  | {
      kind: 'attribution_unknown';
      code: 'RSI_RUN_ATTRIBUTION_UNKNOWN';
      runId: string;
      exit: 1;
    }
  | { kind: 'fail_closed'; code: 'RSI_FAIL_CLOSED'; reason: RsiFailClosedReason; exit: 3 };

export type ImmediateGateCheck = () => Promise<ImmediateGateResult>;

/**
 * judge 服务层接受的三个回调(v2 §6):每次**外发前**、每次**落盘前**、**异常分支打印部分结果前**各调一次,各自现算。
 * 任何一个返回非 `allow` → 立即停止、不外发 / 不落盘 / 不打印。`beforePersist` 须在持有 `rsi/lock` 期间调用(它与 `commitUnderLock` 之间不得释放锁)。
 */
export interface JudgeGateCallbacks {
  readonly beforeExternalCall: ImmediateGateCheck;
  readonly beforePersist: ImmediateGateCheck;
  readonly beforeOutput: ImmediateGateCheck;
}

// ---------------------------------------------------------------------------
// 持锁提交(B3c 实装;所有 counts 写入方共用)
// ---------------------------------------------------------------------------
type RsiTrigger = (typeof RSI_TRIGGERS)[number];
type StagedEntry = RsiCounts['staged'][number];

/**
 * `counts.json` 的统一投影输入(R20-4.5)。**目标值语义**(不是增量):给了哪一段就整段替换该段,没给的段保留磁盘上的现值;
 * `generation` / `computed_at` / `salt_fp` / `cluster_min` 由服务自己填。重复提交同一份输入**不会重复累加**;
 * **不承诺字节级幂等**(`generation` / `computed_at` 随每次写入推进)。
 * 谁写暂存 run(reflect `--run-llm` 新建、judge 改写提案、taint 之后)谁在同一把锁内给出 `staged`。
 */
export interface CountsProjectionInput {
  readonly staged?: readonly StagedEntry[];
  readonly clusters?: RsiCounts['clusters'];
  readonly perKey?: RsiCounts['per_key'];
  readonly unknownKeysSignals?: number;
}

/**
 * 最终提交的计划(R20-5.6 / R20-6.9)。**提交顺序由调用方与服务共同固定**,调用方依次做:
 * 信号库 / 会话计数 / 索引 → `writeCountsProjection`(counts.json)→ state.json → cursor.json → `commitUnderLock`(日志 + 快照清单,**最后一步**)。
 * `commitUnderLock` 不写 counts / state / cursor,只追加日志并重算清单;它调用之后不得再写任何受清单管辖的文件。
 */
export interface RsiCommitPlan {
  readonly trigger: RsiTrigger;
  /** 日志行不含 `at`(由服务按注入时钟填);字段规则见 R20-7.1。不给 = 不追加日志 */
  readonly log?: Pick<RsiLogLine, 'action' | 'code' | 'agent' | 'counts' | 'duration_ms'>;
}

/** 失败一律抛(`RsiLockError('lock_lost')` / `RsiSnapshotError` / `RsiFailClosedError`),不返回部分完成 */
export type RsiCommitResult = { kind: 'committed'; generation: number };
