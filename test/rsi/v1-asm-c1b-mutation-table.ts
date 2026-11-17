/**
 * §21 V1 装配块 C1b(worker 个人步:fallback 阶梯 / S0 / P 注入点 / catch 协议 / 装配 / 监测判定内核)必杀变异。
 * 执行方式同 B1a / B1b / C1a:验证机私有检出里 cp 备份 → 按锚点替换(每个锚点在对应文件里**恰好出现一次**)→ 跑 `tests` → 失败集合非空、全部命中 `expectRed`、
 * `mustKill` 每项至少命中一个、没有 skipped → cp 还原并逐文件 sha256 核对。**不用 git checkout / stash 还原**。
 * 本文件只写表与每条变异期望红的测试名(`expectRed` = 精确杀手名 + 所在测试文件的 describe 标题;`mustKill` 才是精确断言);变异由主代理整表执行,结果记进 `V1_ASM_C1B_RESULTS`(本块不执行变异,故留空)。
 * 注意:`stage/fallback.ts`(C1a 冻结文件)里的锚点只在**临时副本**里被替换,不改仓库里的文件。锚点是 prettier 之后的文本。
 */
export interface Edit {
  file: string;
  anchor: string;
  replacement: string;
}

export interface V1AsmC1bMutation {
  id: string;
  /** 不变量 */
  clause: string;
  edits: readonly Edit[];
  /** 相对 `test/` */
  tests: readonly string[];
  expectRed: readonly string[];
  mustKill: readonly string[];
}

export interface V1AsmC1bResult {
  id: string;
  failed: number;
  skipped: number;
  killedBy: readonly string[];
  restored: boolean;
}

const swap = (file: string, anchor: string, replacement: string): Edit => ({
  file,
  anchor,
  replacement,
});

const WORKER = 'src/rsi/worker.ts';
const FALLBACK = 'src/rsi/personal/stage/fallback.ts';
const LADDER = 'src/rsi/personal/stage/ladder.ts';
const PSTAGE = 'src/rsi/personal/stage/personal-stage.ts';
const ASSEMBLE = 'src/rsi/assemble-worker.ts';
const RESIDUAL = 'src/rsi/personal/stage/residual.ts';
const MUTE = 'src/rsi/canary/canary-mute.ts';

const T_WORKER = 'rsi/stage/c1b-worker.test.ts';
const T_FALLBACK = 'rsi/stage/c1-fallback.test.ts';
const T_LADDER = 'rsi/stage/c1b-ladder.test.ts';
const T_PSTAGE = 'rsi/stage/c1b-personal-stage.test.ts';
const T_ASM = 'rsi/stage/c1b-assemble.test.ts';
const T_RES = 'rsi/stage/c1b-residual.test.ts';
const T_INERT = 'rsi/stage/c1-inert.test.ts';

const D_WORKER = [
  '相位 0 / 不 eligible',
  'P:recoverUnderLock 之后恰好一次',
  '兜底合并协议(catch)',
  'P 违约(run 抛出非失锁错误)',
  '日志摘要(非常态才写',
];
const D_LADDER = [
  'muteDown:阶梯',
  'runFallbackLadder(兜底',
  'runEnforceLadder(S0)',
  'tripAndMuteGuarded:',
];
const D_PSTAGE = [
  'run:状态机',
  'S0 非净 → 本轮未决 → 增影响被拒',
  '失锁与释放',
  'eligible / safetyFallback',
];
const D_ASM = [
  'production_capability_table_matches_delivered',
  '相位 / 能力资格',
  'S0 真适配器(经真 runWorker)',
  '兜底真适配器(recover 失败 → safetyFallback)',
];
const D_RES = [
  'lock_starvation',
  'safety_breaker_inject',
  'p_heartbeat_approx',
  'state_written_not_muted',
];
const D_INERT = ['生产惰性(C1a)', '新模块是纯逻辑、无副作用、依赖收敛', '回合内部状态的引用面'];

export const V1_ASM_C1B_MUTATIONS: readonly V1AsmC1bMutation[] = [
  // ---------- H1:catch 协议(worker.ts + 协调器) ----------
  {
    id: 'fallback_outcome_overrides_original',
    clause: '兜底的结果永不改写原异常算出的 outcome',
    edits: [
      swap(
        WORKER,
        'return finish(mctx, lock, plan.outcome, halfOpen, now, track, true);',
        "return finish(mctx, lock, fb === null ? plan.outcome : 'internal', halfOpen, now, track, true);",
      ),
    ],
    tests: [T_WORKER],
    expectRed: ['recover_eio_fallback_eio_preserves_original_outcome', ...D_WORKER],
    mustKill: ['recover_eio_fallback_eio_preserves_original_outcome'],
  },
  {
    id: 'fallback_called_on_lock_lost',
    clause:
      '原异常是 rsi lock_lost → 不调兜底。真 worker 路径上这道判据被下一行 `SKIP_SET`(lock_lost ∈ UNRECORDABLE)遮住(rsi lock_lost 只能是 RsiLockError,其 outcome 恒为 lock_lost),所以杀手是 C1a 的纯判定用例(同 C1a 表同名条目);worker 用例留在 expectRed 里作旁证(不要求它红)',
    edits: [swap(FALLBACK, "if (isRsiLockLost(input.original)) return 'rsi_lock_lost';", '')],
    tests: [T_WORKER, T_FALLBACK],
    expectRed: [
      '原异常是 rsi lock_lost → rsi_lock_lost(优先于其余',
      'classify',
      'classifyHalt(StepHalt 的处置;lock_lost 不能默认当个人锁)',
      'classifyHalt 只认自有属性(原型链键不是合法分类)',
      'resolveLockLoss:StepHalt=lock_lost 查明是哪把锁',
      '兜底跳过集合 = worker 既有的零写入契约 UNRECORDABLE',
      'fallbackSkipReason(纯判定;表驱动)',
      'runFallbackOnce(单飞协调器;永不抛)',
      'planAfterFallback(原异常的 outcome 永不被替换)',
      ...D_WORKER,
    ],
    mustKill: ['原异常是 rsi lock_lost → rsi_lock_lost(优先于其余'],
  },
  {
    id: 'fallback_not_guarded',
    clause: '零写入五类 / pCompleted / 已试 / 无 stage / 不 eligible 一律不调兜底',
    edits: [
      swap(
        FALLBACK,
        'if (fallbackSkipReason(input) !== null || stage === undefined) return track.fb;',
        'if (stage === undefined) return track.fb;',
      ),
    ],
    tests: [T_WORKER],
    expectRed: ['fallback_skipped_for_unrecordable_outcomes', ...D_WORKER],
    mustKill: ['fallback_skipped_for_unrecordable_outcomes'],
  },
  {
    id: 'fallback_second_call_after_p_violation',
    clause: '兜底单飞:P 违约包装层与 catch 共用,至多调一次',
    edits: [
      swap(FALLBACK, 'if (track.fallbackTried) return track.pending ?? track.fb;', ''),
      swap(FALLBACK, "if (input.track.fallbackTried) return 'already_tried';", ''),
    ],
    tests: [T_WORKER],
    expectRed: ['fallback_single_shot_after_p_contract_violation', ...D_WORKER],
    mustKill: ['fallback_single_shot_after_p_contract_violation'],
  },
  {
    id: 'aborted_still_calls_finish',
    clause: '兜底中途失锁(aborted)→ 不调 finish,零后续写入',
    edits: [
      swap(
        WORKER,
        "if (!plan.callFinish) return { kind: 'ran', outcome: plan.outcome, recorded: false };",
        '',
      ),
    ],
    tests: [T_WORKER],
    expectRed: ['fallback_loses_rsi_lock_stops_all_further_writes', ...D_WORKER],
    mustKill: ['fallback_loses_rsi_lock_stops_all_further_writes'],
  },
  {
    id: 'p_violation_path_drops_track_fb',
    clause: 'P 违约路径与 catch 共用同一个 track(`track.fb` / `fallbackTried` 不丢)',
    edits: [
      swap(
        WORKER,
        '    await runFallbackOnce({\n      track,\n      stage,\n      ctx: {\n        sctx: ctx.sctx,',
        '    await runFallbackOnce({\n      track: newFallbackTrack(),\n      stage,\n      ctx: {\n        sctx: ctx.sctx,',
      ),
    ],
    tests: [T_WORKER],
    expectRed: [
      'p_contract_violation_fallback_loses_lock_preserves_original_and_skips_finish',
      'fallback_single_shot_after_p_contract_violation',
      ...D_WORKER,
    ],
    mustKill: ['fallback_single_shot_after_p_contract_violation'],
  },
  {
    id: 'pcompleted_not_set',
    clause: 'P 返回之后的抛点不再调兜底(pCompleted)',
    edits: [swap(WORKER, '  track.pCompleted = true;\n', '')],
    tests: [T_WORKER],
    expectRed: ['P 返回之后的抛点不再调兜底(pCompleted)', ...D_WORKER],
    mustKill: ['P 返回之后的抛点不再调兜底(pCompleted)'],
  },
  {
    id: 'safety_line_lock_loss_ignored',
    clause:
      '追加安全日志时发现 rsi 失锁 → 停止,不调 finish。复合变异:`finish` 自己的 catch-all(失锁时返回 recorded=false)会遮住这道内层守卫(两者返回值相同),所以同时让 finish 把失锁上抛——这样「内层守卫被去掉」才可观测(finish 被调到 = runWorker 抛出)',
    edits: [
      swap(
        WORKER,
        "if (isRsiLockLost(err)) return { kind: 'ran', outcome: plan.outcome, recorded: false };",
        '',
      ),
      swap(
        WORKER,
        "  } catch {\n    return { kind: 'ran', outcome, recorded: false };\n  }\n}",
        "  } catch (e) {\n    if (isRsiLockLost(e)) throw e;\n    return { kind: 'ran', outcome, recorded: false };\n  }\n}",
      ),
    ],
    tests: [T_WORKER],
    expectRed: ['兜底成功后追加安全日志时发现 rsi 失锁', ...D_WORKER],
    mustKill: ['兜底成功后追加安全日志时发现 rsi 失锁'],
  },
  {
    id: 'summary_lock_loss_swallowed',
    clause:
      'P 摘要日志写时发现 rsi 失锁 → 上抛(普通失败才吞)。复合变异:其后第一个写点(L0 预写 attempt 的 commitState)会再次发现失锁并上抛,返回值与上抛相同、遮住这道内层守卫,所以同时让「L0 未到期」分支恒进入(其后只有 finish 的 catch-all,失锁时返回 skipped_throttled + recorded=false)——内层守卫被去掉时结果不再是 lock_lost',
    edits: [
      swap(
        WORKER,
        '    if (isRsiLockLost(e)) throw e;\n  }\n}\n\nexport function personalSummaryLine',
        '  }\n}\n\nexport function personalSummaryLine',
      ),
      swap(WORKER, 'if (!l0Due(s1.prev, nowMs())) {', 'if (true) {'),
    ],
    tests: [T_WORKER],
    expectRed: ['摘要日志写时发现 rsi 失锁', ...D_WORKER],
    mustKill: ['摘要日志写时发现 rsi 失锁'],
  },
  // ---------- 注入点 / update_busy / 相位 ----------
  {
    id: 'update_busy_early_return_always',
    clause: '个人步可用时 update_busy 不再早返回:P 先于 skipped_update_busy',
    edits: [swap(WORKER, 'if (busy && !personalOn) {', 'if (busy) {')],
    tests: [T_WORKER],
    expectRed: ['update_in_progress_still_runs_P', ...D_WORKER],
    mustKill: ['update_in_progress_still_runs_P'],
  },
  {
    id: 'p_never_runs',
    clause: '个人步 eligible 时 P 恰好运行一次(在 recover 之后)',
    edits: [
      swap(
        WORKER,
        'const personalOn = stage !== undefined && stageEligible(stage);',
        'const personalOn = false;',
      ),
    ],
    tests: [T_WORKER],
    expectRed: ['eligible:run 恰好一次', ...D_WORKER],
    mustKill: ['eligible:run 恰好一次'],
  },
  {
    id: 'eligible_ignored_by_worker',
    clause: '不 eligible(相位 0 / 能力缺项)→ worker 不进 P、不调兜底',
    edits: [
      swap(
        WORKER,
        'const personalOn = stage !== undefined && stageEligible(stage);',
        'const personalOn = stage !== undefined;',
      ),
    ],
    tests: [T_WORKER],
    expectRed: ['eligible 为假:run / safetyFallback 调用数 0', ...D_WORKER],
    mustKill: ['eligible 为假:run / safetyFallback 调用数 0'],
  },
  // ---------- 阶梯(ladder.ts) ----------
  {
    id: 'ladder_lock_lost_swallowed',
    clause: '静音写点失锁 → 立即停写,不降级到删除 / 建 B',
    edits: [
      swap(
        LADDER,
        "return (await p.muteCanary()) ? 'muted' : 'nothing';\n  } catch (e) {\n    if (isRsiLockLost(e)) throw e;\n  }",
        "return (await p.muteCanary()) ? 'muted' : 'nothing';\n  } catch {\n    // swallowed\n  }",
      ),
    ],
    tests: [T_LADDER],
    expectRed: ['每个写点前 assertHeld;失锁', ...D_LADDER],
    mustKill: ['每个写点前 assertHeld;失锁'],
  },
  {
    id: 'ladder_remove_skipped',
    clause: '阶梯 ②:静音失败后删除 canary',
    edits: [swap(LADDER, '    await p.removeCanary();\n', '')],
    tests: [T_LADDER],
    expectRed: ['② 静音抛错 → 删除 canary', ...D_LADDER],
    mustKill: ['② 静音抛错 → 删除 canary'],
  },
  {
    id: 'fallback_state_unreadable_not_muted',
    clause: 'state 非法 / 读不出 → fail-closed 静音',
    edits: [
      swap(LADDER, "need = s.kind !== 'ok' || s.paused;", "need = s.kind === 'ok' && s.paused;"),
    ],
    tests: [T_LADDER],
    expectRed: ['state 暂停 → 静音;state 非法', ...D_LADDER],
    mustKill: ['state 暂停 → 静音;state 非法'],
  },
  {
    id: 'fallback_marker_error_not_closed',
    clause: '标记读失败按「需要静音」(不确定时收紧)',
    edits: [
      swap(
        LADDER,
        'need = m.B || m.U;\n    } catch (e) {\n      if (isRsiLockLost(e)) throw e;\n      need = true;',
        'need = m.B || m.U;\n    } catch (e) {\n      if (isRsiLockLost(e)) throw e;\n      need = false;',
      ),
    ],
    tests: [T_LADDER],
    expectRed: ['标记读抛错也按「需要静音」', ...D_LADDER],
    mustKill: ['标记读抛错也按「需要静音」'],
  },
  {
    id: 'enforce_called_with_invalid_state',
    clause: 'state 整份不合规 / 读不出 → 不调 enforceFull,state / 清单字节不变',
    edits: [
      swap(
        LADDER,
        "if (k1 === 'schema' || k1 === 'unreadable') return viaLadder('state_invalid:schema');",
        '',
      ),
    ],
    tests: [T_LADDER],
    expectRed: ['state_and_manifest_bytes_untouched', ...D_LADDER],
    mustKill: ['state_and_manifest_bytes_untouched'],
  },
  {
    id: 'unreliable_fault_dropped',
    clause: '三级静音全败 → fault = mute_unreliable',
    edits: [
      swap(
        LADDER,
        "return { mute, fault: mute === 'unreliable' ? 'mute_unreliable' : fault };",
        'return { mute, fault };',
      ),
    ],
    tests: [T_LADDER],
    expectRed: ['state 非法且静音 / 删除都失败', ...D_LADDER],
    mustKill: ['state 非法且静音 / 删除都失败'],
  },
  {
    id: 'trip_error_skips_mute',
    clause: 'tripAndMute 的 state 写抛错仍静音',
    edits: [
      swap(
        LADDER,
        '  const mute = await muteDown(ladder);\n  if (failed) throw first;',
        '  if (failed) throw first;\n  const mute = await muteDown(ladder);',
      ),
    ],
    tests: [T_LADDER],
    expectRed: ['trip_state_write_enospc_still_mutes', ...D_LADDER],
    mustKill: ['trip_state_write_enospc_still_mutes'],
  },
  // ---------- 个人步(personal-stage.ts) ----------
  {
    id: 's0_fault_not_unsettled',
    clause: 'S0 非净 → 本轮未决(evaluateGrowth 拒绝)',
    edits: [
      swap(PSTAGE, "if (!s0Clean) markRoundUnsettled(open.round, 'safety_not_settled');", ''),
    ],
    tests: [T_PSTAGE],
    expectRed: ['state 非法:faults 带 safety_fault', ...D_PSTAGE],
    mustKill: ['state 非法:faults 带 safety_fault'],
  },
  {
    id: 'personal_lock_not_released',
    clause: '个人锁在 run 返回前释放(含抛错路径)',
    edits: [swap(PSTAGE, 'if (held !== null) await held.release().catch(() => undefined);', '')],
    tests: [T_PSTAGE],
    expectRed: ['个人锁在返回前释放恰好一次', ...D_PSTAGE],
    mustKill: ['个人锁在返回前释放恰好一次'],
  },
  {
    id: 'rsi_assert_before_return_dropped',
    clause: '返回前显式复核 rsi 锁(不靠 release 暴露失锁)',
    edits: [swap(PSTAGE, '        await ctx.lock.assertHeld();\n', '')],
    tests: [T_PSTAGE],
    expectRed: ['返回前复核 rsi 锁', ...D_PSTAGE],
    mustKill: ['返回前复核 rsi 锁'],
  },
  {
    id: 'stage_eligible_throw_as_true',
    clause: 'eligible 抛错 = 假(fail-closed)',
    edits: [
      swap(
        PSTAGE,
        'return deps.eligible() === true;\n      } catch {\n        return false;',
        'return deps.eligible() === true;\n      } catch {\n        return true;',
      ),
    ],
    tests: [T_PSTAGE],
    expectRed: ['eligible:抛错 = 假', ...D_PSTAGE],
    mustKill: ['eligible:抛错 = 假'],
  },
  // ---------- 装配(assemble-worker.ts / canary-mute.ts) ----------
  {
    id: 'eligible_ignores_capabilities',
    clause: '能力缺项 = 不 eligible(提相位的 PR 在能力齐全之前必红)',
    edits: [
      swap(
        ASSEMBLE,
        "phaseAtLeast('V1a', phase) && missingPhaseCaps(phase, wired).length === 0",
        "phaseAtLeast('V1a', phase)",
      ),
    ],
    tests: [T_ASM],
    expectRed: ['生产装配在 V1a 相位 + 契约生产集合下不 eligible', ...D_ASM],
    mustKill: ['生产装配在 V1a 相位 + 契约生产集合下不 eligible'],
  },
  {
    id: 'capability_table_claims_delivered',
    clause: '契约能力表只在真交付时为真(C1b 全假)',
    edits: [swap(ASSEMBLE, 'audit_sweep: false,', 'audit_sweep: true,')],
    tests: [T_ASM],
    expectRed: ['契约能力表:键 = RSI_ASSEMBLY_CAPS 全集', ...D_ASM],
    mustKill: ['契约能力表:键 = RSI_ASSEMBLY_CAPS 全集'],
  },
  {
    id: 'mute_generation_not_bumped',
    clause: '静音 canary 时 generation + 1',
    edits: [
      swap(MUTE, 'generation: cur.value.generation + 1,', 'generation: cur.value.generation,'),
    ],
    tests: [T_ASM],
    expectRed: ['补码(state 经清单提交)+ 静音', ...D_ASM],
    mustKill: ['补码(state 经清单提交)+ 静音'],
  },
  {
    id: 'marker_create_without_lock_check',
    clause: 'S0 完整路径:B 的创建写点前复核 rsi 锁',
    edits: [
      swap(
        ASSEMBLE,
        '          await c.lock.assertHeld();\n          return withDir(io, (d) => makeBreakerMarkerPort(io, d, c.now).ensure(reason));',
        '          return withDir(io, (d) => makeBreakerMarkerPort(io, d, c.now).ensure(reason));',
      ),
    ],
    tests: [T_ASM],
    expectRed: ['状态有暂停码、B 缺失:失锁后 S0 不创建 B', ...D_ASM, 'S0 的 B 写点前复核 rsi 锁'],
    mustKill: ['状态有暂停码、B 缺失:失锁后 S0 不创建 B'],
  },
  {
    id: 'marker_remove_without_lock_check',
    clause: 'S0 完整路径:B 的删除写点前复核 rsi 锁(删 B 是放松保护)',
    edits: [
      swap(
        ASSEMBLE,
        '          await c.lock.assertHeld();\n          return withDir(io, (d) => makeBreakerMarkerPort(io, d, c.now).remove());',
        '          return withDir(io, (d) => makeBreakerMarkerPort(io, d, c.now).remove());',
      ),
    ],
    tests: [T_ASM],
    expectRed: ['B 是解除残留(状态已清码', ...D_ASM, 'S0 的 B 写点前复核 rsi 锁'],
    mustKill: ['B 是解除残留(状态已清码'],
  },
  // ---------- 监测判定内核 ----------
  {
    id: 'residual_span_off_by_one',
    clause: '锁饿死:首尾跨度 ≥ 30 分钟(含边界)',
    edits: [
      swap(
        RESIDUAL,
        'tail.lastAtMs - tail.firstAtMs >= t.skippedLockedMinSpanMs',
        'tail.lastAtMs - tail.firstAtMs > t.skippedLockedMinSpanMs',
      ),
    ],
    tests: [T_RES],
    expectRed: ['held_over_ttl / stale + ≥3 条', ...D_RES],
    mustKill: ['held_over_ttl / stale + ≥3 条'],
  },
  {
    id: 'residual_heartbeat_inclusive',
    clause: '心跳近似:年龄严格大于 24 小时',
    edits: [
      swap(
        RESIDUAL,
        'f.nowMs - f.state.lastTickCompletedAtMs > t.lastTickMaxAgeMs',
        'f.nowMs - f.state.lastTickCompletedAtMs >= t.lastTickMaxAgeMs',
      ),
    ],
    tests: [T_RES],
    expectRed: ['last_tick 年龄 > 24 小时', ...D_RES],
    mustKill: ['last_tick 年龄 > 24 小时'],
  },
  {
    id: 'residual_marker_ignored',
    clause: 'B / U 在 = 不成立(安全熔断下注入 / 状态已写未静音)',
    edits: [
      swap(RESIDUAL, 'const noMarker = !f.markers.B && !f.markers.U;', 'const noMarker = true;'),
    ],
    tests: [T_RES],
    expectRed: ['B 或 U 在 / canary 已不注入', ...D_RES],
    mustKill: ['B 或 U 在 / canary 已不注入'],
  },
  // ---------- 闭包 / 惰性 ----------
  {
    id: 'worker_imports_growth_module',
    clause: '接线入口的闭包只含白名单内的 stage 模块(growth / settle / 判决槽仍禁)',
    edits: [
      swap(
        WORKER,
        "import type { PersonalCtx, PersonalRound, PersonalStage } from './personal/stage/types.js';",
        "import type { PersonalCtx, PersonalRound, PersonalStage } from './personal/stage/types.js';\nimport { settleSafety } from './personal/stage/settle.js';\nexport const mutantSettle = settleSafety;",
      ),
    ],
    tests: [T_INERT],
    expectRed: ['接线入口的闭包只含白名单内的 stage 模块', ...D_INERT],
    mustKill: ['接线入口的闭包只含白名单内的 stage 模块'],
  },
];

/** 执行变异后由主代理回填(本块不执行变异,留空) */
export const V1_ASM_C1B_RESULTS: readonly V1AsmC1bResult[] = [];
