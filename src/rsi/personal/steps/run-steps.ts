/**
 * C2 个人步编排(C v2 §3 状态机;纯编排,所有 I/O 经端口):
 *  - 持两锁的回合:S2R → S1 → 压缩 → S2P → `settleSafety`;
 *  - personal 锁忙 / 故障(没有 `BothRound`):S2R → `T_rsi` → `settleSafety`;**不跑** S1 / 压缩 / S2P / 自动解除。
 * 个人锁丢失(`ended`)后立即停止余下个人步,但**仍**对已发生的写做一次扫尾尝试之前先看 rsi 锁:rsi 失锁原样上抛(`classify` 的 `rethrow`)。
 * 本模块不调用 `markRoundUnsettled`(它只在 `stage/` 内可达):返回 `unsettled` 列表,由 `stage/personal-stage.ts` 落到回合上。
 */
import type { PersonalFault } from '../stage/errors.js';
import type { Compactor, RecoveryPort, SafetyPort } from '../stage/ports.js';
import type { BothRound, RsiOnlyRound } from '../stage/round.js';
import { createRoundBudget, settleSafety } from '../stage/settle.js';
import type { TripReason, UnsettledReason } from '../stage/types.js';
import { runCompaction } from './compact-sched.js';
import { runS1, type S1Flags } from './s1-recover.js';
import { runS2P, runS2R, runTRsi } from './s2-reduce.js';
import { START_ROLLBACK_LIMIT, type S2Ports } from './steps-types.js';

export interface StepsResult {
  readonly faults: readonly PersonalFault[];
  readonly unsettled: readonly UnsettledReason[];
  /** S1 对标志的结论(`null` = 无结论);读盘上的最终值由装配层 `flags()` 给 */
  readonly flagsTarget: Partial<S1Flags> | null;
  /** 日志摘要码候选(`compact_*`);调用方按优先级取最高一行 */
  readonly logCodes: readonly string[];
  readonly storeFull: boolean;
  readonly ended: boolean;
  /** 本轮做过的步骤(顺序即执行顺序;测试与日志用) */
  readonly ran: readonly string[];
}

/** 一个回合可用的端口(装配层在持两锁之后、按本轮的 round 现建;写端口已经 `round.writeAdapter` 包装) */
export interface BothPorts {
  readonly recovery: RecoveryPort;
  readonly s2: S2Ports;
  readonly compactor?: Compactor;
}

export async function runBothSteps(a: {
  readonly ports: BothPorts;
  readonly round: BothRound;
  readonly l0DueNow: boolean;
}): Promise<StepsResult> {
  const { ports, round } = a;
  const budget = createRoundBudget(round, { startRollbackLimit: START_ROLLBACK_LIMIT });
  const faults: PersonalFault[] = [];
  const unsettled: UnsettledReason[] = [];
  const logCodes: string[] = [];
  const ran: string[] = [];
  let storeFull = false;
  let ended = false;
  let flagsTarget: Partial<S1Flags> | null = null;

  const r2 = await runS2R({ safety: ports.s2.safety, budget });
  faults.push(...r2.faults);
  unsettled.push(...r2.unsettled);
  ran.push(...r2.ran.map((x) => `s2r:${x}`));
  ended = r2.ended;

  let tripSeed: readonly TripReason[] = [];
  if (!ended) {
    const s1 = await runS1({ recovery: ports.recovery, budget });
    ran.push('s1');
    faults.push(...s1.faults);
    unsettled.push(...s1.unsettled);
    flagsTarget = s1.flagsTarget;
    tripSeed = s1.tripReasons;
    ended = s1.ended;
  }
  if (!ended) {
    const comp = await runCompaction(ports.compactor, round);
    ran.push('compact');
    if (comp.logCode !== null) logCodes.push(comp.logCode);
    if (comp.fault !== null) faults.push(comp.fault);
    // `compact_unwired` 不是故障(B1b 未装配);其余阻塞 / 失败码进 faults,摘要日志才看得见
    else if (comp.logCode !== null && comp.logCode !== 'compact_unwired') {
      faults.push({ code: 'step_halted', detail: comp.logCode });
    }
    unsettled.push(...comp.unsettled);
    storeFull = comp.storeFull;
    ended = comp.ended;
  }
  if (!ended) {
    const s2 = await runS2P({
      ports: ports.s2,
      round,
      budget,
      l0DueNow: a.l0DueNow,
      tripSeed,
    });
    ran.push(...s2.ran.map((x) => `s2p:${x}`));
    faults.push(...s2.faults);
    unsettled.push(...s2.unsettled);
    ended = s2.ended;
  }
  // 单次扫尾(失锁原样抛出;个人锁已丢则不再扫:`settleSafety` 内的 `PersonalLockLost` 由调用方 `classify`)
  if (!ended) {
    await settleSafety(round, ports.s2.safety, budget);
    ran.push('settle');
  }
  return { faults, unsettled, flagsTarget, logCodes, storeFull, ended, ran };
}

export async function runRsiOnlySteps(a: {
  readonly safety: SafetyPort;
  readonly round: RsiOnlyRound;
}): Promise<StepsResult> {
  const budget = createRoundBudget(a.round);
  const faults: PersonalFault[] = [];
  const unsettled: UnsettledReason[] = [];
  const ran: string[] = [];
  const r2 = await runS2R({ safety: a.safety, budget });
  faults.push(...r2.faults);
  unsettled.push(...r2.unsettled);
  ran.push(...r2.ran.map((x) => `s2r:${x}`));
  const tr = await runTRsi({ safety: a.safety, budget });
  faults.push(...tr.faults);
  unsettled.push(...tr.unsettled);
  ran.push(...tr.ran.map((x) => `t_rsi:${x}`));
  await settleSafety(a.round, a.safety, budget);
  ran.push('settle');
  return {
    faults,
    unsettled,
    flagsTarget: null,
    logCodes: [],
    storeFull: false,
    ended: false,
    ran,
  };
}
