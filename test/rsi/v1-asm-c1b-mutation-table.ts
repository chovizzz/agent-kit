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
const PAUSE_MARKER = 'src/rsi/canary/pause-marker.ts';
const D_GUARD = 'B 标记写点守卫';

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
      'P 摘要日志写时发现 rsi 失锁 → 上抛(普通失败才吞)。复合变异:其后 `resumeTaintWith` 的第一行(`assertLockBelongs`)与 L0 预写 attempt 的 commitState 会再次发现失锁并上抛,返回值与这里上抛相同、遮住这道内层守卫,所以同时去掉 taint 续做调用并让「L0 未到期」分支恒进入(其后只有 finish 的 catch-all,失锁时返回 skipped_throttled + recorded=false)——内层守卫被去掉时结果不再是 lock_lost',
    edits: [
      swap(
        WORKER,
        '    if (isRsiLockLost(e)) throw e;\n  }\n}\n\nexport function personalSummaryLine',
        '  }\n}\n\nexport function personalSummaryLine',
      ),
      swap(WORKER, '    await resumeTaintWith(mctx, lock, hooks);\n', ''),
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
    id: 'marker_create_guard_dropped',
    clause: 'B 标记创建:写点守卫在实际创建之前被调用(目录校验之后)',
    edits: [
      swap(PAUSE_MARKER, '      await guard();\n      // 文件与父目录', '      // 文件与父目录'),
    ],
    tests: [T_ASM],
    expectRed: [
      '端口:创建时守卫在 now() 之后',
      '装配(创建):目录校验之后',
      D_GUARD,
      'S0 的 B 写点前复核 rsi 锁(失锁 = 零写入)',
    ],
    mustKill: ['端口:创建时守卫在 now() 之后', '装配(创建):目录校验之后'],
  },
  {
    id: 'marker_remove_guard_dropped',
    clause: 'B 标记删除:unlink 之前复核',
    edits: [
      swap(
        PAUSE_MARKER,
        '      await guard();\n      await remove(io, file);\n      return true;',
        '      await remove(io, file);\n      return true;',
      ),
    ],
    tests: [T_ASM],
    expectRed: [
      '端口:删除在回读之后复核',
      '装配(删除):B 回读之后',
      D_GUARD,
      'S0 的 B 写点前复核 rsi 锁(失锁 = 零写入)',
    ],
    mustKill: ['端口:删除在回读之后复核', '装配(删除):B 回读之后'],
  },
  {
    id: 'marker_remove_guard_before_read',
    clause: 'B 标记删除:复核在回读之后(B 不存在时不取守卫)',
    edits: [
      swap(
        PAUSE_MARKER,
        '      const cur = await read();\n      if (cur === null) return false;\n      await guard();',
        '      await guard();\n      const cur = await read();\n      if (cur === null) return false;',
      ),
    ],
    tests: [T_ASM],
    expectRed: ['端口:删除在回读之后复核', D_GUARD],
    mustKill: ['端口:删除在回读之后复核'],
  },
  {
    id: 'marker_guard_not_wired_to_lock',
    clause: '装配层的 B 写适配器把写点守卫接到 rsi 锁(阶梯与完整 S0 共用)',
    edits: [
      swap(
        ASSEMBLE,
        'makeBreakerMarkerPort(io, d, c.now, undefined, () => c.lock.assertHeld());',
        'makeBreakerMarkerPort(io, d, c.now, undefined, () => Promise.resolve());',
      ),
    ],
    tests: [T_ASM],
    expectRed: [
      '装配(创建):目录校验之后',
      '装配(删除):B 回读之后',
      D_GUARD,
      ...D_ASM,
      'S0 的 B 写点前复核 rsi 锁(失锁 = 零写入)',
    ],
    mustKill: ['装配(创建):目录校验之后', '装配(删除):B 回读之后'],
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

/** 执行变异后由主代理回填(本轮新增 4 条 B 写点守卫变异后表为 34 条,旧结果已作废,留空待整表重跑) */
/** 实测结果:r21c1b-mut-i @78444b0(seal),34 条全杀;3 条旁杀已并入 expectRed */
export const V1_ASM_C1B_RESULTS: readonly V1AsmC1bResult[] = [
  {
    id: 'fallback_outcome_overrides_original',
    failed: 3,
    skipped: 0,
    killedBy: [
      '兜底合并协议(catch) recover_eio_fallback_eio_preserves_original_outcome:原 io_error;兜底自身抛错 → 日志 safety_fallback_threw;outcome 仍 io_error;finish 照常(熔断记账)',
      '兜底合并协议(catch) 兜底成功(muted):outcome 仍是原异常的 io_error;日志先 safety_fallback_muted 再 io_error',
      '兜底合并协议(catch) 兜底报告的 kind 不影响 outcome:任何报告都不改写 internal / io_error',
    ],
    restored: true,
  },
  {
    id: 'fallback_called_on_lock_lost',
    failed: 2,
    skipped: 0,
    killedBy: [
      'fallbackSkipReason(纯判定;表驱动) 原异常是 rsi lock_lost → rsi_lock_lost(优先于其余);个人失锁 / 其它 RsiLockError 不属于它',
      'runFallbackOnce(单飞协调器;永不抛) 跳过:零写入类 / rsi 失锁 / pCompleted / 无 stage / 无资格 → 不调用,返回 track.fb(null)',
    ],
    restored: true,
  },
  {
    id: 'fallback_not_guarded',
    failed: 7,
    skipped: 0,
    killedBy: [
      '相位 0 / 不 eligible:worker 与没有个人步时同行为 eligible 抛错 = 不进(fail-closed);恢复失败时也不调兜底',
      '兜底合并协议(catch) recover_rsi_lock_lost_never_calls_fallback:原异常是 rsi lock_lost → 兜底零调用,零后续写入',
      '兜底合并协议(catch) fallback_skipped_for_unrecordable_outcomes:零写入五类逐个(表驱动),兜底调用数 0,状态目录字节不变',
      '兜底合并协议(catch) P 返回之后的抛点不再调兜底(pCompleted):outcome 由该异常算出并正常记账',
      'P 违约(run 抛出非失锁错误) run 抛 rsi lock_lost:兜底零调用,outcome lock_lost、零写入',
      'P 违约(run 抛出非失锁错误) 违约抛出的原异常是 write_denied 一类:outcome 取自它(不是一律 internal),零写入五类不调兜底',
      '日志摘要(非常态才写;常态零行) 摘要日志写时发现 rsi 失锁:上抛 → outcome lock_lost、零后续写、不调兜底',
    ],
    restored: true,
  },
  {
    id: 'fallback_second_call_after_p_violation',
    failed: 2,
    skipped: 0,
    killedBy: [
      'P 违约(run 抛出非失锁错误) fallback_single_shot_after_p_contract_violation:兜底恰好一次(origin=p_contract_violation),原异常原样进 catch → outcome internal;catch 不再调兜底',
      'P 违约(run 抛出非失锁错误) p_contract_violation_fallback_loses_lock_preserves_original_and_skips_finish:兜底 aborted → outcome internal、recorded=false、状态目录零变化、兜底仍只一次',
    ],
    restored: true,
  },
  {
    id: 'aborted_still_calls_finish',
    failed: 2,
    skipped: 0,
    killedBy: [
      '兜底合并协议(catch) fallback_loses_rsi_lock_stops_all_further_writes:兜底报告 aborted → 不调 finish;原 outcome 不变;状态目录零变化',
      'P 违约(run 抛出非失锁错误) p_contract_violation_fallback_loses_lock_preserves_original_and_skips_finish:兜底 aborted → outcome internal、recorded=false、状态目录零变化、兜底仍只一次',
    ],
    restored: true,
  },
  {
    id: 'p_violation_path_drops_track_fb',
    failed: 2,
    skipped: 0,
    killedBy: [
      'P 违约(run 抛出非失锁错误) fallback_single_shot_after_p_contract_violation:兜底恰好一次(origin=p_contract_violation),原异常原样进 catch → outcome internal;catch 不再调兜底',
      'P 违约(run 抛出非失锁错误) p_contract_violation_fallback_loses_lock_preserves_original_and_skips_finish:兜底 aborted → outcome internal、recorded=false、状态目录零变化、兜底仍只一次',
    ],
    restored: true,
  },
  {
    id: 'pcompleted_not_set',
    failed: 1,
    skipped: 0,
    killedBy: [
      '兜底合并协议(catch) P 返回之后的抛点不再调兜底(pCompleted):outcome 由该异常算出并正常记账',
    ],
    restored: true,
  },
  {
    id: 'safety_line_lock_loss_ignored',
    failed: 1,
    skipped: 0,
    killedBy: [
      '兜底合并协议(catch) 兜底成功后追加安全日志时发现 rsi 失锁:停止,不调 finish(state / 清单 / 日志零写),outcome 仍是原异常的',
    ],
    restored: true,
  },
  {
    id: 'summary_lock_loss_swallowed',
    failed: 3,
    skipped: 0,
    killedBy: [
      'P:recoverUnderLock 之后恰好一次 eligible:run 恰好一次,ctx 带真实锁句柄与 updateBusy=false;在 recover 的写点之后',
      '兜底合并协议(catch) P 返回之后的抛点不再调兜底(pCompleted):outcome 由该异常算出并正常记账',
      '日志摘要(非常态才写;常态零行) 摘要日志写时发现 rsi 失锁:上抛 → outcome lock_lost、零后续写、不调兜底',
    ],
    restored: true,
  },
  {
    id: 'update_busy_early_return_always',
    failed: 1,
    skipped: 0,
    killedBy: [
      'P:recoverUnderLock 之后恰好一次 update_in_progress_still_runs_P:update/lock 被存活进程持有且个人步可用 → run 仍恰好一次(updateBusy=true),outcome skipped_update_busy 记账;L0 / purge 续做不运行',
    ],
    restored: true,
  },
  {
    id: 'p_never_runs',
    failed: 9,
    skipped: 0,
    killedBy: [
      'P:recoverUnderLock 之后恰好一次 eligible:run 恰好一次,ctx 带真实锁句柄与 updateBusy=false;在 recover 的写点之后',
      'P:recoverUnderLock 之后恰好一次 update_in_progress_still_runs_P:update/lock 被存活进程持有且个人步可用 → run 仍恰好一次(updateBusy=true),outcome skipped_update_busy 记账;L0 / purge 续做不运行',
      '兜底合并协议(catch) P 返回之后的抛点不再调兜底(pCompleted):outcome 由该异常算出并正常记账',
      'P 违约(run 抛出非失锁错误) fallback_single_shot_after_p_contract_violation:兜底恰好一次(origin=p_contract_violation),原异常原样进 catch → outcome internal;catch 不再调兜底',
      'P 违约(run 抛出非失锁错误) p_contract_violation_fallback_loses_lock_preserves_original_and_skips_finish:兜底 aborted → outcome internal、recorded=false、状态目录零变化、兜底仍只一次',
      'P 违约(run 抛出非失锁错误) run 抛 rsi lock_lost:兜底零调用,outcome lock_lost、零写入',
      'P 违约(run 抛出非失锁错误) 违约抛出的原异常是 write_denied 一类:outcome 取自它(不是一律 internal),零写入五类不调兜底',
      '日志摘要(非常态才写;常态零行) safety fault → 日志一行 failed safety_fault_*;忙 → skipped personal_locked;各至多一行',
      '日志摘要(非常态才写;常态零行) 摘要日志写时发现 rsi 失锁:上抛 → outcome lock_lost、零后续写、不调兜底',
    ],
    restored: true,
  },
  {
    id: 'eligible_ignored_by_worker',
    failed: 2,
    skipped: 0,
    killedBy: [
      '相位 0 / 不 eligible:worker 与没有个人步时同行为 eligible 为假:run / safetyFallback 调用数 0;结果与无 personal 的运行相同',
      '相位 0 / 不 eligible:worker 与没有个人步时同行为 不 eligible 时 update_busy 仍是原来的早返回(P 不跑)',
    ],
    restored: true,
  },
  {
    id: 'ladder_lock_lost_swallowed',
    failed: 3,
    skipped: 0,
    killedBy: [
      'muteDown:阶梯 ①→④ 每个写点前 assertHeld;失锁(任一点)原样抛出且之后零写端口调用',
      'runFallbackLadder(兜底:只读 state / 标记,不写 state) 永不抛:rsi 失锁 → aborted(之后零写端口调用);其它意外抛出 → threw',
      'runEnforceLadder(S0) rsi 失锁原样上抛(enforceFull 内 / 阶梯内 / 读形状时);其它错误不抛',
    ],
    restored: true,
  },
  {
    id: 'ladder_remove_skipped',
    failed: 6,
    skipped: 0,
    killedBy: [
      'muteDown:阶梯 ①→④ ② 静音抛错 → 删除 canary → removed;不建 B',
      'muteDown:阶梯 ①→④ ③ 静音与删除都抛错 → 创建 B(gate_internal)→ marker',
      'muteDown:阶梯 ①→④ ④ 三级都失败 → unreliable(不抛)',
      'muteDown:阶梯 ①→④ 每个写点前 assertHeld;失锁(任一点)原样抛出且之后零写端口调用',
      'runFallbackLadder(兜底:只读 state / 标记,不写 state) 阶梯各级结果原样报告;三级都失败 = unreliable',
      'runEnforceLadder(S0) state 非法且静音 / 删除都失败 → 才建 B(阶梯 ③);三级全败 → fault 取 mute_unreliable',
    ],
    restored: true,
  },
  {
    id: 'fallback_state_unreadable_not_muted',
    failed: 1,
    skipped: 0,
    killedBy: [
      'runFallbackLadder(兜底:只读 state / 标记,不写 state) state 暂停 → 静音;state 非法 / 读不出 / 读抛错 → fail-closed 静音',
    ],
    restored: true,
  },
  {
    id: 'fallback_marker_error_not_closed',
    failed: 1,
    skipped: 0,
    killedBy: [
      'runFallbackLadder(兜底:只读 state / 标记,不写 state) 标记读抛错也按「需要静音」(不确定时收紧)',
    ],
    restored: true,
  },
  {
    id: 'enforce_called_with_invalid_state',
    failed: 3,
    skipped: 0,
    killedBy: [
      'runEnforceLadder(S0) state_and_manifest_bytes_untouched:整份不合规 / 读不出 → 不调 enforceFull(它读写 state),直接走阶梯静音,故障 state_invalid:schema',
      'runEnforceLadder(S0) state 非法且静音 / 删除都失败 → 才建 B(阶梯 ③);三级全败 → fault 取 mute_unreliable',
      'runEnforceLadder(S0) rsi 失锁原样上抛(enforceFull 内 / 阶梯内 / 读形状时);其它错误不抛',
    ],
    restored: true,
  },
  {
    id: 'unreliable_fault_dropped',
    failed: 1,
    skipped: 0,
    killedBy: [
      'runEnforceLadder(S0) state 非法且静音 / 删除都失败 → 才建 B(阶梯 ③);三级全败 → fault 取 mute_unreliable',
    ],
    restored: true,
  },
  {
    id: 'trip_error_skips_mute',
    failed: 1,
    skipped: 0,
    killedBy: [
      'tripAndMuteGuarded:state 写抛错仍静音 trip_state_write_enospc_still_mutes:state.write 抛 ENOSPC → 阶梯静音仍被调用,原错误原样抛出',
    ],
    restored: true,
  },
  {
    id: 's0_fault_not_unsettled',
    failed: 3,
    skipped: 0,
    killedBy: [
      'S0 非净 → 本轮未决 → 增影响被拒 state 非法:faults 带 safety_fault:state_invalid:schema(step_halted + detail),本轮 unsettled=[safety_not_settled];evaluateGrowth 返回 unsettled',
      'S0 非净 → 本轮未决 → 增影响被拒 静音抛错 → 删除兜底成功:故障码仍是 state_invalid:schema(只有三级全败才改成 mute_unreliable,见 c1b-ladder)',
      'S0 非净 → 本轮未决 → 增影响被拒 S0 内部非失锁的违约抛出(端口工厂抛)→ 记 fault、本轮未决,不上抛',
    ],
    restored: true,
  },
  {
    id: 'personal_lock_not_released',
    failed: 4,
    skipped: 0,
    killedBy: [
      'run:状态机 持有:S0 一次 → 回合 open;个人锁在返回前释放恰好一次;flags / 事实字段是「未计算」的空值',
      'run:状态机 update_busy:S0 照跑,growth = denied update_busy(S3 不可达);个人锁仍释放',
      '失锁与释放 返回前复核 rsi 锁:取得个人锁后 rsi 锁丢失 → 上抛,个人锁仍释放(不靠 release 暴露失锁)',
      '失锁与释放 openRound 抛(两把锁 nonce 相同)→ 个人锁仍释放(整个 run 体在 finally 内)',
    ],
    restored: true,
  },
  {
    id: 'rsi_assert_before_return_dropped',
    failed: 1,
    skipped: 0,
    killedBy: [
      '失锁与释放 返回前复核 rsi 锁:取得个人锁后 rsi 锁丢失 → 上抛,个人锁仍释放(不靠 release 暴露失锁)',
    ],
    restored: true,
  },
  {
    id: 'stage_eligible_throw_as_true',
    failed: 1,
    skipped: 0,
    killedBy: ['eligible / safetyFallback eligible:抛错 = 假(fail-closed);非 true 的真值 = 假'],
    restored: true,
  },
  {
    id: 'eligible_ignores_capabilities',
    failed: 2,
    skipped: 0,
    killedBy: [
      'production_capability_table_matches_delivered 生产装配在 V1a 相位 + 契约生产集合下不 eligible:提相位的 PR 在能力齐全之前必红(assertPhaseCaps 抛)',
      '相位 / 能力资格 测试缝:相位 ≥ V1a 且能力齐全才 eligible;相位 0 + 能力齐全 = 假;V1a + 缺一项 = 假',
    ],
    restored: true,
  },
  {
    id: 'capability_table_claims_delivered',
    failed: 1,
    skipped: 0,
    killedBy: [
      'production_capability_table_matches_delivered 契约能力表:键 = RSI_ASSEMBLY_CAPS 全集,全部为假(C1b 没有交付任何契约能力);推出的 wired 集合为空且与契约导出的生产集合一致',
    ],
    restored: true,
  },
  {
    id: 'mute_generation_not_bumped',
    failed: 1,
    skipped: 0,
    killedBy: [
      'S0 真适配器(经真 runWorker) 个人锁取锁失败(write_denied)时 S0 仍跑完:B 在、状态无码、canary 在注入 → 补码(state 经清单提交)+ 静音;growth = denied personal_fault;L0 之后码仍在(state 接续);日志一行 personal_fault_*',
    ],
    restored: true,
  },
  {
    id: 'marker_create_guard_dropped',
    failed: 3,
    skipped: 0,
    killedBy: [
      'S0 的 B 写点前复核 rsi 锁(失锁 = 零写入) 状态有暂停码、B 缺失:失锁后 S0 不创建 B、canary 不动;outcome lock_lost,零记账',
      'B 标记写点守卫(目录校验之后、实际写之前才复核;删除在回读之后) 端口:创建时守卫在 now() 之后、写之前被调用;守卫抛错 = B 不创建(注入点是守卫本身,不靠计时)',
      'B 标记写点守卫(目录校验之后、实际写之前才复核;删除在回读之后) 装配(创建):目录校验之后、写之前失锁 → 不创建 B;对照:不注入失锁则创建',
    ],
    restored: true,
  },
  {
    id: 'marker_remove_guard_dropped',
    failed: 3,
    skipped: 0,
    killedBy: [
      'S0 的 B 写点前复核 rsi 锁(失锁 = 零写入) B 是解除残留(状态已清码且证据与 B 的 id 相等):失锁后 S0 不删 B(删 B 是放松保护,同样先复核)',
      'B 标记写点守卫(目录校验之后、实际写之前才复核;删除在回读之后) 端口:删除在回读之后复核 —— B 存在且守卫抛错 = B 保留;B 不存在 = 返回 false 且守卫不被调用(回读先于守卫)',
      'B 标记写点守卫(目录校验之后、实际写之前才复核;删除在回读之后) 装配(删除):B 回读之后、unlink 之前失锁 → 不删除 B;对照:不注入失锁则删除',
    ],
    restored: true,
  },
  {
    id: 'marker_remove_guard_before_read',
    failed: 1,
    skipped: 0,
    killedBy: [
      'B 标记写点守卫(目录校验之后、实际写之前才复核;删除在回读之后) 端口:删除在回读之后复核 —— B 存在且守卫抛错 = B 保留;B 不存在 = 返回 false 且守卫不被调用(回读先于守卫)',
    ],
    restored: true,
  },
  {
    id: 'marker_guard_not_wired_to_lock',
    failed: 4,
    skipped: 0,
    killedBy: [
      'S0 的 B 写点前复核 rsi 锁(失锁 = 零写入) 状态有暂停码、B 缺失:失锁后 S0 不创建 B、canary 不动;outcome lock_lost,零记账',
      'S0 的 B 写点前复核 rsi 锁(失锁 = 零写入) B 是解除残留(状态已清码且证据与 B 的 id 相等):失锁后 S0 不删 B(删 B 是放松保护,同样先复核)',
      'B 标记写点守卫(目录校验之后、实际写之前才复核;删除在回读之后) 装配(创建):目录校验之后、写之前失锁 → 不创建 B;对照:不注入失锁则创建',
      'B 标记写点守卫(目录校验之后、实际写之前才复核;删除在回读之后) 装配(删除):B 回读之后、unlink 之前失锁 → 不删除 B;对照:不注入失锁则删除',
    ],
    restored: true,
  },
  {
    id: 'residual_span_off_by_one',
    failed: 1,
    skipped: 0,
    killedBy: ['lock_starvation held_over_ttl / stale + ≥3 条 + 跨度 ≥ 30 分钟 → 成立'],
    restored: true,
  },
  {
    id: 'residual_heartbeat_inclusive',
    failed: 1,
    skipped: 0,
    killedBy: [
      'p_heartbeat_approx last_tick 年龄 > 24 小时 ∧ rsi on ∧ 熔断未打开 → 成立(严格大于)',
    ],
    restored: true,
  },
  {
    id: 'residual_marker_ignored',
    failed: 2,
    skipped: 0,
    killedBy: [
      'safety_breaker_inject B 或 U 在 / canary 已不注入 / canary 缺失 / 非 safety / state 读不出 → 不成立',
      'state_written_not_muted(仅「hint 读 state」未采纳时计入) 已采纳问题 1(hintReadsPauseState)/ 有标记 / canary 不注入 / state 读不出 → 不成立',
    ],
    restored: true,
  },
  {
    id: 'worker_imports_growth_module',
    failed: 2,
    skipped: 0,
    killedBy: [
      '生产惰性(C1a) 接线入口的闭包只含白名单内的 stage 模块:非白名单即禁(growth / settle / monitoring / residual / 判决槽运行时),两档分别查',
      '生产惰性(C1a) hint.ts 的源码没有提到新模块路径;worker.ts 只提到白名单内的 stage 模块(且不提 growth / judge-slot)',
    ],
    restored: true,
  },
];

/**
 * 对照表(不入必杀整表,不要求杀得掉):复合变异里「遮蔽层」那一半**单独**施加时,被它遮住的目标用例必须**不红**——证明复合变异的红来自去掉内层守卫,
 * 而不是遮蔽层本身把目标用例弄坏。执行:`mut-run.mjs <本文件> V1_ASM_C1B_AUX_CONTROLS`,看 KILLEDBY 行里没有各条 `mustStayGreen` 的用例名。
 */
export const V1_ASM_C1B_AUX_CONTROLS: readonly (V1AsmC1bMutation & {
  mustStayGreen: readonly string[];
})[] = [
  {
    id: 'aux_only_finish_rethrows_lock_loss',
    clause:
      '对照(safety_line_lock_loss_ignored 的遮蔽层单独施加):finish 上抛失锁;内层守卫仍在,目标用例必须仍绿',
    edits: [
      swap(
        WORKER,
        "  } catch {\n    return { kind: 'ran', outcome, recorded: false };\n  }\n}",
        "  } catch (e) {\n    if (isRsiLockLost(e)) throw e;\n    return { kind: 'ran', outcome, recorded: false };\n  }\n}",
      ),
    ],
    tests: [T_WORKER],
    expectRed: D_WORKER,
    mustKill: [],
    mustStayGreen: ['兜底成功后追加安全日志时发现 rsi 失锁'],
  },
  {
    id: 'aux_only_taint_resume_removed_and_l0_always_throttled',
    clause:
      '对照(summary_lock_loss_swallowed 的遮蔽层单独施加):去掉 taint 续做调用、L0 未到期分支恒进入;摘要守卫仍在,目标用例必须仍绿',
    edits: [
      swap(WORKER, '    await resumeTaintWith(mctx, lock, hooks);\n', ''),
      swap(WORKER, 'if (!l0Due(s1.prev, nowMs())) {', 'if (true) {'),
    ],
    tests: [T_WORKER],
    expectRed: D_WORKER,
    mustKill: [],
    mustStayGreen: ['摘要日志写时发现 rsi 失锁'],
  },
];
