/**
 * `judge --ingest` / `--confirm-reflector`(N4,docs/contracts.md §20.18)服务层的端口与结果类型。
 * 服务只依赖这些端口(依赖倒置):终端、锁、即时闸、时钟都由命令入口(`src/commands/judge-ingest.ts`)在装配处注入。
 */
import type {
  JudgeIngestReason,
  JudgeFailClosedReason,
  JudgeUsageReason,
} from '../../contracts/judge-ingest.js';
import type { Redactor } from '../../contracts/redact.js';
import type { TtyPort, TtyHandle, ConfirmDeclineReason } from '../../io/tty.js';
import type { IoContext } from '../../io/paths.js';
import type { StoreFs } from '../store.js';

export type IngestMode = 'ingest' | 'confirm_reflector';

export interface IngestRequest {
  readonly mode: IngestMode;
  readonly runId: string;
  readonly write: boolean;
  /** 只与 `ingest --write` 同用 */
  readonly replace: boolean;
  /** 只与 `confirm_reflector` 同用;空 = 该 run 内所有候选 */
  readonly proposalFilter: readonly string[];
  /** `ingest` 的 stdin 文本;`confirm_reflector` 无 */
  readonly payloadText: string | undefined;
}

/** 即时闸 / 输出闸的退出:退出码 + 完整 stderr 行 */
export interface IngestExit {
  readonly exit: number;
  readonly stderr: string;
}

/** 锁内会话(命令入口把 `rsi/lock` 句柄与 B5d 的 recover / taint / settle 包装成这几个动作;未拿锁 → 全部 no-op) */
export interface LockedSession {
  /** 锁内、业务之前:`assertNoPurgeInProgress` → `recoverUnderLock` → `resumeTaint`;purge 进行中抛 {@link IngestPurgePendingError} */
  enter(): Promise<void>;
  /** 每个写出口前复核;失锁抛 {@link IngestLockLostError} */
  assertHeld(): Promise<void>;
  /** 即时闸(锁内再过一次);非 allow → 退出 */
  gate(): Promise<IngestExit | null>;
  /** 写完之后同一把锁内刷新 `counts.staged`;失败 → 退出 */
  settle(wrote: boolean): Promise<IngestExit | undefined>;
}

export class IngestPurgePendingError extends Error {
  constructor() {
    super('judge_ingest_purge_pending');
  }
}
export class IngestLockLostError extends Error {
  constructor() {
    super('judge_ingest_lock_lost');
  }
}

export interface IngestDeps {
  readonly io: IoContext;
  readonly redactor: Pick<Redactor, 'pass2'>;
  readonly tty: TtyPort;
  /** 写模式下命令入口已打开的控制终端句柄(TTY 门先于一切读取);干跑为 undefined */
  readonly ttyHandle?: TtyHandle | undefined;
  readonly now: () => Date;
  readonly kitVersion: string;
  /** 输出泄漏闸的禁止值(HOME / KIT_TMP / 状态目录 / 仓库根及其 realpath) */
  readonly forbidden: readonly string[];
  /** 即时闸(锁外,读暂存区):非 allow → 退出;`[rsi]` 未启用时恒 null */
  readonly gate: () => Promise<IngestExit | null>;
  /** 取 `rsi/lock`(try-lock,条件同 `judge --run-llm` 的 lockGate)并在持有期间运行 `fn`;拿不到 → 抛(命令层映射 `JUDGE_NOT_RUN reason=locked`) */
  readonly underLock: <T>(fn: (s: LockedSession) => Promise<T>) => Promise<T>;
  readonly resolveHead?: () => string | undefined;
  readonly storeFs?: StoreFs;
  /** 测试缝:确认屏已展示、用户键入之前 / 之后(用来模拟「展示之后文件被改」的并发写) */
  readonly hooks?: {
    readonly afterConfirm?: () => Promise<void> | void;
  };
}

export interface PlanView {
  readonly id: string;
  readonly layer: 'team' | 'personal';
  readonly verdict: 'accept' | 'revise' | 'reject';
  readonly overfit: 'low' | 'medium' | 'high';
  readonly injection: boolean;
  readonly conflicts: number;
  readonly prediction: 'required' | 'not_required';
  readonly needsReflectorConfirm: boolean;
}

export type IngestOutcome =
  | {
      readonly kind: 'dry';
      readonly runId: string;
      readonly plan: readonly PlanView[];
      readonly nothingToConfirm: boolean;
    }
  | {
      readonly kind: 'written';
      readonly runId: string;
      readonly partial: boolean;
      readonly proposals: readonly string[];
      readonly reflectorConfirmed: readonly string[];
      readonly written: number;
      readonly total: number;
      readonly replaced: number;
      readonly reflectorUnconfirmed: number;
      readonly failure: JudgeFailClosedReason | undefined;
    }
  | { readonly kind: 'rejected'; readonly reason: JudgeIngestReason }
  | { readonly kind: 'declined'; readonly reason: ConfirmDeclineReason | 'stale' }
  | { readonly kind: 'usage'; readonly reason: JudgeUsageReason }
  | { readonly kind: 'fail_closed'; readonly reason: JudgeFailClosedReason }
  | { readonly kind: 'not_run'; readonly code: 'RSI_NOT_RUN'; readonly reason: 'purge_pending' }
  | { readonly kind: 'exit'; readonly exit: IngestExit };
