/**
 * 写命令(`rsi auto pause` / `resume` / `clear --write` / `rebase-baseline`、`rsi veto`、`rsi rollback --to --write`;contracts R21-12.2–12.7、§21.24 W0-22)的窄端口(SOLID 的 I / D)。
 * 处理函数只依赖这里的类型;具体实现在部署组装处注入(`src/rsi/auto/deps-write.ts`)。**测试假件遵守与生产实现同一份契约**:读失败 = 抛错,写失败 = 抛错,
 * 「确认不存在」才是 absent / none;假件必须通过 `test/rsi/auto/port-contract.test.ts` 的写侧套件才可用于命令测试。
 *
 * **未接线 = 字段缺失(`undefined`)**:预检({@link missingPorts})是静态判定,**绝不**靠「调一次看会不会抛」来探测(那本身就是写)。
 * 顺序固定:参数 / TTY(退 2)→ 预检(缺任一必需端口 → 退 3 `internal`,零写入)→ 取锁(锁文件也是写,所以锁也是端口)→ 业务。
 * 本文件只有类型与一个纯函数,没有 I/O。
 */
import type { RsiAutoPauseReason } from '../../../contracts/rsi.js';
import type { PersonalLifecycleRecord } from '../../../contracts/rsi-personal.js';
import type { HeldLock } from '../../canary/atomic-write.js';
import type { BreakerMarkerPort, PauseStatePort, UserMarkerPort } from '../../personal/breaker.js';
import type { RecordRead, RepoRead } from '../../personal/candidate-ports.js';
import type { ClearDeps } from '../../personal/clear.js';
import type { RollbackDeps } from '../../personal/rollback.js';
import type { RsiEarlyContext } from '../../types.js';

/** 写命令的处理函数(与 `AutoEntryDeps.write` 的值同形) */
export type WriteHandler = (ctx: RsiEarlyContext, rest: readonly string[]) => Promise<number>;

/** 持有的锁(锁序 `rsi/lock` → `personal/lock` → sync 锁;`rsi` 在缩减入口 = null) */
export interface HeldLocks {
  rsi: HeldLock | null;
  personal: HeldLock;
  syncLock: { withLock<T>(fn: () => Promise<T>): Promise<T> };
}
/** 需要的锁集合:`personal_sync` = 缩减入口(`auto clear --write`,R21-9.5);`rsi_personal_sync` = 三把锁 */
export type LockOrder = 'personal_sync' | 'rsi_personal_sync';
export interface CommandLocks {
  /** 按序取锁(试锁、不排队;拿不到抛 `RsiLockError`)→ 回调 → 一定逆序释放 */
  withLocks<T>(order: LockOrder, fn: (held: HeldLocks) => Promise<T>): Promise<T>;
}

/** 入口事件代数(`WorkerMarks.resetGen`;W0-13):幂等、单调,返回新值 */
export interface EntryMarks {
  bump(): Promise<number>;
}

/** 自动解除 / 人工解除前重查:当前条件仍成立的码(`gate_internal`、`apply_failed`、`personal_repo_invalid`、`budget_high_legacy`) */
export interface HoldFacts {
  snapshot(): Promise<ReadonlySet<RsiAutoPauseReason>>;
}

/** 黑名单解除(`rsi veto --lift`;只解除指纹黑名单,候选记录不动) */
export interface VetoLift {
  lift(id: string, contentSha256: string): Promise<'lifted' | 'absent'>;
}

/** `rebase-baseline` 的情形判定(R21-3.5;只带命令层要的信息) */
export type RebaseSituation =
  | { kind: 'ok' }
  | { kind: 'diverged'; head: string }
  | { kind: 'owner_changed'; head: string }
  | { kind: 'invalid' };
export interface RebasePort {
  /** 现算情形;`head` = 当前 HEAD(完整 OID,展示与持锁复核都比它) */
  classify(): Promise<RebaseSituation>;
  /** `记录..HEAD` 的相对路径清单(未清洗;读不出抛错) */
  changedPaths(): Promise<readonly string[]>;
  /** 改写 `head.json`:`baseline` = 记录提交换成 `expectHead`;`owner` = `owner_repo_fp` 换成当前 `[rsi] repo` 的指纹。持 `personal/lock` */
  rewriteHead(kind: 'baseline' | 'owner', expectHead: string): Promise<void>;
  /**
   * 「本命令已完成 head 改写」的可验证事实(只读):`baseline` = `head.json` 记录的提交等于当前 HEAD;`owner` = 记录的 `owner_repo_fp` 等于当前 `[rsi] repo` 的指纹。
   * 与状态里仍留着对应标志合起来,才是「改写已完成、标志没清完」的收尾依据(W0-25);读不出抛错。
   */
  headRewritten(kind: 'baseline' | 'owner'): Promise<boolean>;
}

/** 端口装配(惰性):参数 / TTY 校验先于装配,坏参数不会先去读配置 */
export type WritePortsGetter = () => Promise<WritePorts>;

/** 写命令的全部端口;**字段缺失 = 未接线**(预检 fail-closed) */
export interface WritePorts {
  /** `[rsi]` 是否可用(合法关闭 = false;配置不可信由装配抛 fail-closed,不会走到这里) */
  config?: () => Promise<{ rsiOn: boolean }>;
  locks?: CommandLocks;
  /** 用户暂停文件 U:惰性打开(打开可能建 `.state/rsi`,所以只在真要用时才调) */
  userMarker?: () => Promise<UserMarkerPort>;
  breaker?: Pick<BreakerMarkerPort, 'read'>;
  pauseState?: PauseStatePort;
  holds?: HoldFacts;
  marks?: EntryMarks;
  /** 持锁后构造执行器依赖(锁句柄、sync 锁来自 `held`) */
  rollbackDeps?: (held: HeldLocks) => RollbackDeps;
  clearDeps?: (held: HeldLocks) => ClearDeps;
  /** 无锁读一条记录(`rsi veto` 在取锁前判 `unknown_id`;持锁后仍要重读) */
  peekRecord?: (id: string) => Promise<RecordRead>;
  /** 无锁读全部记录(`rollback --to --write` 在取锁前展示两节清单用;持锁后仍要重读,锁外那次不作数) */
  peekRecords?: () => Promise<RepoRead<PersonalLifecycleRecord[]>>;
  vetoLift?: VetoLift;
  rebase?: RebasePort;
  /** 输出泄漏闸的额外禁止值(装配解析;HOME / `KIT_TMP` 由 `forbiddenPaths` 自己收) */
  outputForbidden?: readonly string[];
}

export type WritePortName = Exclude<keyof WritePorts, 'outputForbidden'>;

/** 每个命令必需的端口(预检依据;`config` 一律必需,除 `auto clear --write`——缩减入口不依赖 `[rsi]`) */
export const REQUIRED_PORTS = Object.freeze({
  'auto pause': ['config', 'userMarker'],
  'auto resume': ['config', 'locks', 'userMarker', 'breaker', 'pauseState', 'holds', 'marks'],
  'auto clear': ['locks', 'clearDeps'],
  'auto rebase-baseline': ['config', 'locks', 'rebase', 'pauseState'],
  veto: ['config', 'locks', 'rollbackDeps', 'peekRecord'],
  'rollback --to': ['config', 'locks', 'rollbackDeps', 'peekRecords'],
} as const satisfies Record<string, readonly WritePortName[]>);

/** 缺失(未接线)的必需端口名;空 = 通过。静态判定,不调用任何端口 */
export function missingPorts(p: WritePorts, need: readonly WritePortName[]): WritePortName[] {
  return need.filter((n) => p[n] === undefined);
}

/** `veto` 的无锁读 / 持锁读共同使用的记录判别:只有 `ok` 带记录;`missing` 才可能是 `unknown_id`;其余(含 deferred / invalid)读不出 ≠ 不存在 */
export function recordOf(r: RecordRead): PersonalLifecycleRecord | null {
  return r.kind === 'ok' ? r.record : null;
}
