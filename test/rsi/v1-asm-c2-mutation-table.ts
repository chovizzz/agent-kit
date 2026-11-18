/**
 * §21 V1 装配块 C2(S1 / S2 / 污染扫描 / 压缩调度 / hint 读 state / D18 / 能力键 / 回读版凭据写)必杀变异。
 * 执行方式同 B1a / B1b / C1a / C1b:验证机私有检出里 cp 备份 → 按锚点替换(每个锚点在对应文件里**恰好出现一次**)→ 跑 `tests` → 失败集合非空、全部命中 `expectRed`、
 * `mustKill` 每项至少命中一个、没有 skipped → cp 还原并逐文件 sha256 核对。**不用 git checkout / stash 还原**。
 * 本文件只写表与每条变异期望红的测试名(`expectRed` = 所在测试文件的 describe 标题或精确杀手名;`mustKill` 才是精确断言);变异由主代理整表执行,结果记进 `V1_ASM_C2_RESULTS`(本块不执行变异,故留空)。
 * 锚点是 prettier 之后的文本。
 */
export interface Edit {
  file: string;
  anchor: string;
  replacement: string;
}

export interface V1AsmC2Mutation {
  id: string;
  /** 不变量 */
  clause: string;
  edits: readonly Edit[];
  /** 相对 `test/` */
  tests: readonly string[];
  expectRed: readonly string[];
  mustKill: readonly string[];
}

export interface V1AsmC2Result {
  id: string;
  failed: number;
  skipped: number;
  killedBy: readonly string[];
  restored: boolean;
}

export const V1_ASM_C2_MUTATIONS: readonly V1AsmC2Mutation[] = [
  {
    id: 's1_open_lock_error_swallowed',
    clause: 'open 抛锁错误 / 失锁必须原样上抛(不得被当成仓库 invalid)',
    edits: [
      {
        file: 'src/rsi/personal/steps/repo-recover.ts',
        anchor:
          'if (isRsiLockLost(e) || e instanceof PersonalLockLost || e instanceof RsiLockError) throw e;',
        replacement: 'void 0;',
      },
    ],
    tests: ['rsi/c2/c2-steps-s1.test.ts'],
    expectRed: [
      'S1 仓库恢复映射',
      'git 读失败(open 抛非锁错误)= 仓库不可用 invalid;锁错误 / 失锁原样上抛',
    ],
    mustKill: ['git 读失败(open 抛非锁错误)= 仓库不可用 invalid;锁错误 / 失锁原样上抛'],
  },
  {
    id: 's1_deferred_reason_mixed',
    clause: 'deferred 的两个原因分别映射 diverged / owner_changed',
    edits: [
      {
        file: 'src/rsi/personal/steps/repo-recover.ts',
        anchor: "judgement: r.reason === 'personal_repo_diverged' ? 'diverged' : 'owner_changed',",
        replacement: "judgement: 'diverged',",
      },
    ],
    tests: ['rsi/c2/c2-steps-s1.test.ts'],
    expectRed: ['S1 仓库恢复映射', 'open 结果映射'],
    mustKill: ['open 结果映射'],
  },
  {
    id: 's1_flag_diverged_also_clears_owner',
    clause: '② 只置 diverged,不动 owner_changed',
    edits: [
      {
        file: 'src/rsi/personal/steps/s1-recover.ts',
        anchor: "else if (r.judgement === 'diverged') flagsTarget = { diverged: true };",
        replacement:
          "else if (r.judgement === 'diverged') flagsTarget = { diverged: true, owner_changed: false };",
      },
    ],
    tests: ['rsi/c2/c2-steps-s1.test.ts'],
    expectRed: ['runS1', '标志重算:① 清两标志;② 只置 diverged'],
    mustKill: ['标志重算:① 清两标志;② 只置 diverged'],
  },
  {
    id: 's1_repo_invalid_not_reported',
    clause: '仓库不可用 → tripReasons 并入 S2P 单次 trip',
    edits: [
      {
        file: 'src/rsi/personal/steps/s1-recover.ts',
        anchor: "tripReasons.push('personal_repo_invalid');",
        replacement: 'void 0;',
      },
    ],
    tests: ['rsi/c2/c2-steps-s1.test.ts'],
    expectRed: ['runS1', '仓库 invalid → 不在 S1 里 trip'],
    mustKill: ['仓库 invalid → 不在 S1 里 trip'],
  },
  {
    id: 's1_step_failure_stops_rest',
    clause: '某项抛错记故障后继续下一项(不挡下一项)',
    edits: [
      {
        file: 'src/rsi/personal/steps/s1-recover.ts',
        anchor: '      faults.push(c.fault);\n      return true;',
        replacement: '      faults.push(c.fault);\n      return false;',
      },
    ],
    tests: ['rsi/c2/c2-steps-s1.test.ts'],
    expectRed: ['runS1', '某项抛错 → 记故障、继续下一项'],
    mustKill: ['某项抛错 → 记故障、继续下一项'],
  },
  {
    id: 's1_halt_prefix_ignored',
    clause: '适配器编码的 StepHalt(仓库完整性)→ 本轮未决',
    edits: [
      {
        file: 'src/rsi/personal/steps/s1-recover.ts',
        anchor:
          "if (h.kind === 'stop_step_unsettled') unsettled.push(`step_integrity:${h.cause}`);",
        replacement: "if (h.kind === 'stop_step_unsettled') void 0;",
      },
    ],
    tests: ['rsi/c2/c2-steps-s1.test.ts'],
    expectRed: ['runS1', '某项抛错 → 记故障、继续下一项'],
    mustKill: ['某项抛错 → 记故障、继续下一项'],
  },
  {
    id: 's1_personal_lock_loss_continues',
    clause:
      '个人锁丢失 → 结束个人轮,余下步骤不调(复合:单改返回值是等价变异——ended 已让后续步骤跳过;同时去掉 ended 才可观测)',
    edits: [
      {
        file: 'src/rsi/personal/steps/s1-recover.ts',
        anchor: '        ended = true;\n        return false;',
        replacement: '        return true;',
      },
    ],
    tests: ['rsi/c2/c2-steps-s1.test.ts'],
    expectRed: ['runS1', '个人锁丢失 → 结束个人轮'],
    mustKill: ['个人锁丢失 → 结束个人轮'],
  },
  {
    id: 'taint_run_dir_missing_as_clean',
    clause: 'run 目录不存在 = unknown(不当 clean)',
    edits: [
      {
        file: 'src/rsi/personal/steps/taint-scan.ts',
        anchor: "else if (st === 'missing') unknown.push({ id: c.id, why: 'run_dir_missing' });",
        replacement: "else if (st === 'missing') void 0;",
      },
    ],
    tests: ['rsi/c2/c2-steps-s2.test.ts'],
    expectRed: ['污染扫描器(TaintScanner)', 'unknown 三态不当 clean、不当 tainted'],
    mustKill: ['unknown 三态不当 clean、不当 tainted'],
  },
  {
    id: 'taint_journal_not_read',
    clause: 'purge journal 不合规 / 读不出 → unavailable;journal 目标命中 → tainted',
    edits: [
      {
        file: 'src/rsi/personal/steps/taint-scan.ts',
        anchor: 'const j = await facts.journal();',
        replacement: "const j = { kind: 'absent' as const };",
      },
    ],
    tests: ['rsi/c2/c2-steps-s2.test.ts'],
    expectRed: [
      '污染扫描器(TaintScanner)',
      'journal invalid / unreadable、暂存区超限 / 不可信 → unavailable',
    ],
    mustKill: ['journal invalid / unreadable、暂存区超限 / 不可信 → unavailable'],
  },
  {
    id: 'taint_source_null_not_unknown',
    clause: '来源缺失 = unknown{source_missing}',
    edits: [
      {
        file: 'src/rsi/personal/steps/taint-scan.ts',
        anchor: 'if (s === null || s === undefined) {',
        replacement: 'if (false as boolean) {',
      },
    ],
    tests: ['rsi/c2/c2-steps-s2.test.ts'],
    expectRed: ['污染扫描器(TaintScanner)', 'unknown 三态不当 clean、不当 tainted'],
    mustKill: ['unknown 三态不当 clean、不当 tainted'],
  },
  {
    id: 'taint_journal_target_ignored',
    clause: 'journal 命中的 run 先判 tainted(目录已被清走也是)',
    edits: [
      {
        file: 'src/rsi/personal/steps/taint-scan.ts',
        anchor: 'if (targets.has(s.run_id)) {',
        replacement: 'if (false as boolean) {',
      },
    ],
    tests: ['rsi/c2/c2-steps-s2.test.ts'],
    expectRed: ['污染扫描器(TaintScanner)', '标记命中 → tainted;journal 目标命中 → tainted'],
    mustKill: ['标记命中 → tainted;journal 目标命中 → tainted'],
  },
  {
    id: 's2_rescan_every_round',
    clause: 'exclude_rescan_only_when_due:非 due 轮不重扫',
    edits: [
      {
        file: 'src/rsi/personal/steps/s2-reduce.ts',
        anchor: 'if (p.l0DueNow) {',
        replacement: 'if (true as boolean) {',
      },
    ],
    tests: ['rsi/c2/c2-steps-s2.test.ts'],
    expectRed: ['runS2P 顺序与「唯一一次」', 'exclude_rescan_only_when_due'],
    mustKill: ['exclude_rescan_only_when_due'],
  },
  {
    id: 's2_trip_not_merged',
    clause: 'S1 的 personal_repo_invalid 与触发评估的码合并成一次 trip',
    edits: [
      {
        file: 'src/rsi/personal/steps/s2-reduce.ts',
        anchor: 'const merged = [...new Set<TripReason>([...p.tripSeed, ...(evald ?? [])])];',
        replacement: 'const merged = [...(evald ?? [])];',
      },
    ],
    tests: ['rsi/c2/c2-steps-s2.test.ts'],
    expectRed: [
      'runS2P 顺序与「唯一一次」',
      'S1 的 personal_repo_invalid 与触发评估的码合并成**一次** tripAndMute',
    ],
    mustKill: ['S1 的 personal_repo_invalid 与触发评估的码合并成**一次** tripAndMute'],
  },
  {
    id: 's2_unknown_canary_not_stopped',
    clause: 'unknown 来源的 canary → 只停注入',
    edits: [
      {
        file: 'src/rsi/personal/steps/s2-reduce.ts',
        anchor: 'if (scan.unknown.some((u) => canary.has(u.id))) {',
        replacement: 'if (false as boolean) {',
      },
    ],
    tests: ['rsi/c2/c2-steps-s2.test.ts'],
    expectRed: ['runS2P 顺序与「唯一一次」', '命中污染 → applyTaint'],
    mustKill: ['命中污染 → applyTaint'],
  },
  {
    id: 's2_analysis_without_canary',
    clause: '无 canary 记录 → 不跑分析链',
    edits: [
      {
        file: 'src/rsi/personal/steps/s2-reduce.ts',
        anchor: 'if (listing.canaryIds.length > 0) {',
        replacement: 'if (true as boolean) {',
      },
    ],
    tests: ['rsi/c2/c2-steps-s2.test.ts'],
    expectRed: ['runS2P 顺序与「唯一一次」', '无 canary 记录 → 不跑分析链'],
    mustKill: ['无 canary 记录 → 不跑分析链'],
  },
  {
    id: 's2_rsi_lock_loss_swallowed',
    clause: 'rsi 锁丢失原样上抛(不降级成故障)',
    edits: [
      {
        file: 'src/rsi/personal/steps/s2-reduce.ts',
        anchor: "if (c.kind === 'rethrow') throw e;",
        replacement: 'void 0;',
      },
    ],
    tests: ['rsi/c2/c2-steps-s2.test.ts'],
    expectRed: ['runS2P 顺序与「唯一一次」', '隔离:某步抛错'],
    mustKill: ['隔离:某步抛错'],
  },
  {
    id: 'compact_full_unsettles',
    clause: 'audit_full / effects_full 只记 storeFull,不使本轮未决',
    edits: [
      {
        file: 'src/rsi/personal/steps/compact-sched.ts',
        anchor: "unsettled: full ? [] : ['compaction_failed'],",
        replacement: "unsettled: ['compaction_failed'],",
      },
    ],
    tests: ['rsi/c2/c2-steps-s2.test.ts'],
    expectRed: ['压缩调度', 'noop / compacted 无事;audit_full / effects_full'],
    mustKill: ['noop / compacted 无事;audit_full / effects_full'],
  },
  {
    id: 'compact_unwired_is_fault',
    clause: 'compactor 缺省 = compact_unwired,不是故障、不未决',
    edits: [
      {
        file: 'src/rsi/personal/steps/compact-sched.ts',
        anchor: "if (compactor === undefined) return { ...CLEAN, logCode: 'compact_unwired' };",
        replacement:
          "if (compactor === undefined) return { ...CLEAN, logCode: 'compact_unwired', unsettled: ['compaction_failed'] };",
      },
    ],
    tests: ['rsi/c2/c2-steps-s2.test.ts'],
    expectRed: ['压缩调度', '缺省(B1b 未装配)= compact_unwired'],
    mustKill: ['缺省(B1b 未装配)= compact_unwired'],
  },
  {
    id: 'compact_throw_not_unsettled',
    clause: '压缩抛错 → 未决 compaction_failed(S2 照跑)',
    edits: [
      {
        file: 'src/rsi/personal/steps/compact-sched.ts',
        anchor:
          "return { ...CLEAN, logCode: 'compact_threw', fault: c.fault, unsettled: ['compaction_failed'] };",
        replacement: "return { ...CLEAN, logCode: 'compact_threw', fault: c.fault };",
      },
    ],
    tests: ['rsi/c2/c2-steps-s2.test.ts'],
    expectRed: ['压缩调度', 'noop / compacted 无事;audit_full / effects_full'],
    mustKill: ['noop / compacted 无事;audit_full / effects_full'],
  },
  {
    id: 'stage_busy_runs_s1',
    clause: '忙 / 故障轮没有 BothRound:S1 / 压缩 / S2P 不可达',
    edits: [
      {
        file: 'src/rsi/personal/stage/personal-stage.ts',
        anchor: "if (open.kind === 'both') {",
        replacement: 'if (true as boolean) {',
      },
    ],
    tests: ['rsi/c2/c2-run-steps.test.ts'],
    expectRed: ['忙 / 故障轮(没有 BothRound)', '只跑 S2R + T_rsi + 扫尾'],
    mustKill: ['只跑 S2R + T_rsi + 扫尾'],
  },
  {
    id: 'stage_factory_throw_not_unsettled',
    clause: '端口工厂抛错 → 本轮未决',
    edits: [
      {
        file: 'src/rsi/personal/stage/personal-stage.ts',
        anchor:
          "            markRoundUnsettled(open.round, 'safety_not_settled');\n            if (c.kind === 'end_personal_round') lockLost = true;",
        replacement: "            if (c.kind === 'end_personal_round') lockLost = true;",
      },
    ],
    tests: ['rsi/c2/c2-run-steps.test.ts'],
    expectRed: ['持两锁的回合', '端口工厂抛错 → 记故障 + 本轮未决'],
    mustKill: ['端口工厂抛错 → 记故障 + 本轮未决'],
  },
  {
    id: 'hint_ignores_reasons',
    clause: 'hint 读已提交 state:reasons 非空 → 无 canary 部分',
    edits: [
      {
        file: 'src/rsi/hint.ts',
        anchor:
          'return ap !== undefined && (ap.reasons.length > 0 || ap.diverged || ap.owner_changed);',
        replacement: 'return ap !== undefined && (ap.diverged || ap.owner_changed);',
      },
    ],
    tests: ['rsi/c2/c2-hint-state.test.ts'],
    expectRed: ['hint 读已提交 state.json 的暂停事实', 'reasons 非空'],
    mustKill: ['reasons 非空'],
  },
  {
    id: 'hint_ignores_diverged',
    clause: 'hint 读已提交 state:diverged → 无 canary 部分',
    edits: [
      {
        file: 'src/rsi/hint.ts',
        anchor:
          'return ap !== undefined && (ap.reasons.length > 0 || ap.diverged || ap.owner_changed);',
        replacement: 'return ap !== undefined && (ap.reasons.length > 0 || ap.owner_changed);',
      },
    ],
    tests: ['rsi/c2/c2-hint-state.test.ts'],
    expectRed: ['hint 读已提交 state.json 的暂停事实', 'diverged'],
    mustKill: ['diverged'],
  },
  {
    id: 'hint_ignores_owner_changed',
    clause: 'hint 读已提交 state:owner_changed → 无 canary 部分',
    edits: [
      {
        file: 'src/rsi/hint.ts',
        anchor:
          'return ap !== undefined && (ap.reasons.length > 0 || ap.diverged || ap.owner_changed);',
        replacement: 'return ap !== undefined && (ap.reasons.length > 0 || ap.diverged);',
      },
    ],
    tests: ['rsi/c2/c2-hint-state.test.ts'],
    expectRed: ['hint 读已提交 state.json 的暂停事实', 'owner_changed'],
    mustKill: ['owner_changed'],
  },
  {
    id: 'revoke_detailed_wrong_existing',
    clause: '回读版返回已有行的 by / reason(不是请求的)',
    edits: [
      {
        file: 'src/rsi/personal/revoke-write.ts',
        anchor: 'existing: { by: same.by, reason: same.reason }',
        replacement: 'existing: { by: want.by, reason: want.reason }',
      },
    ],
    tests: ['rsi/c2/c2-revoke-detailed.test.ts'],
    expectRed: ['writeRevocationDetailed', '同键、已有凭据来源不同'],
    mustKill: ['同键、已有凭据来源不同'],
  },
  {
    id: 'revoke_detailed_ignores_sha',
    clause: '幂等键含 content_sha256:内容变了 = 新键',
    edits: [
      {
        file: 'src/rsi/personal/revoke-write.ts',
        anchor: 'a.candidate_id === b.candidate_id && a.content_sha256 === b.content_sha256;',
        replacement: 'a.candidate_id === b.candidate_id;',
      },
    ],
    tests: ['rsi/c2/c2-revoke-detailed.test.ts'],
    expectRed: ['writeRevocationDetailed', '内容 sha 不同 = 新键'],
    mustKill: ['内容 sha 不同 = 新键'],
  },
  {
    id: 'd18_marker_ignored',
    clause: 'B / U 标记在 → 信号不成立',
    edits: [
      {
        file: 'src/doctor/rsi-residual.ts',
        anchor: 'markers: { B: b, U: u },',
        replacement: 'markers: { B: false, U: false },',
      },
    ],
    tests: ['rsi/c2/c2-doctor-d18.test.ts'],
    expectRed: ['collectD18(真夹具;只读)', 'B 标记在 → 同一夹具不再成立'],
    mustKill: ['B 标记在 → 同一夹具不再成立'],
  },
  {
    id: 'd18_tail_counts_other_rows',
    clause: '只数末尾连续的 skipped_locked',
    edits: [
      {
        file: 'src/doctor/rsi-residual.ts',
        anchor:
          "if (!row.success || row.data.action !== 'skipped' || row.data.code !== 'skipped_locked') break;",
        replacement: 'if (!row.success) break;',
      },
    ],
    tests: ['rsi/c2/c2-doctor-d18.test.ts'],
    expectRed: ['skippedLockedTailOf', '尾部有别的行 / 不合规行'],
    mustKill: ['尾部有别的行 / 不合规行'],
  },
  {
    id: 'd18_unreadable_ok',
    clause: '读不到 → warn / unreadable',
    edits: [
      {
        file: 'src/doctor/checks.ts',
        anchor: "if (i.unreadable) return result('D18', 'warn', 'unreadable', { facts });",
        replacement: 'void 0;',
      },
    ],
    tests: ['rsi/c2/c2-doctor-d18.test.ts'],
    expectRed: ['checkD18(纯展示合成)', '不适用 → n_a / absent'],
    mustKill: ['不适用 → n_a / absent'],
  },
  {
    id: 'cap_taint_scan_claimed_false',
    clause: 'taint_scan 交付后能力表为真(与契约生产集合一致)',
    edits: [
      {
        file: 'src/rsi/assemble-worker.ts',
        anchor: 'taint_scan: true,',
        replacement: 'taint_scan: false,',
      },
    ],
    tests: ['rsi/stage/c1b-assemble.test.ts'],
    expectRed: [
      'production_capability_table_matches_delivered',
      '契约能力表:键 = RSI_ASSEMBLY_CAPS 全集',
    ],
    mustKill: ['契约能力表:键 = RSI_ASSEMBLY_CAPS 全集'],
  },
  {
    id: 's1_repo_lock_loss_not_ended',
    clause: 'recoverRepo(S1 第 1 项)抛个人失锁 → ended,压缩 / S2P / 扫尾零调用',
    edits: [
      {
        file: 'src/rsi/personal/steps/s1-recover.ts',
        anchor:
          '      ended = true; // 与 `guarded` 同:个人失锁必须让调用方(压缩 / S2P / 扫尾)看见 `ended`',
        replacement: '      void 0;',
      },
    ],
    tests: ['rsi/c2/c2-steps-s1.test.ts', 'rsi/c2/c2-run-steps.test.ts'],
    expectRed: [
      'runS1',
      '失锁与日志 / 扫尾细项(验收评审修复)',
      'recoverRepo(第 1 项)抛个人失锁',
      'recoverRepo 抛 PersonalLockLost',
    ],
    mustKill: ['recoverRepo(第 1 项)抛个人失锁', 'recoverRepo 抛 PersonalLockLost'],
  },
  {
    id: 'judge_lock_loss_not_resolved',
    clause:
      'W9 槽 halted=lock_lost:personal-stage 先 resolveLockLoss,rsi 已丢 = 原样上抛(不走读标志)',
    edits: [
      {
        file: 'src/rsi/personal/stage/personal-stage.ts',
        anchor:
          "              if ((await resolveLockLoss(ctx.lock, held)) === 'rsi') await ctx.lock.assertHeld();",
        replacement: '              void resolveLockLoss;',
      },
    ],
    tests: ['rsi/c2/c2-run-steps.test.ts'],
    expectRed: ['失锁与日志 / 扫尾细项(验收评审修复)', 'W9 槽 halted=lock_lost 且 rsi 锁实际已丢'],
    mustKill: ['W9 槽 halted=lock_lost 且 rsi 锁实际已丢'],
  },
  {
    id: 'taint_apply_failed_generic',
    clause: 'applyTaint 失败 → 稳定码 taint_apply_failed + 候选 id(不是 step_threw)',
    edits: [
      {
        file: 'src/rsi/personal/steps/s2-reduce.ts',
        anchor: 'if (!(e instanceof TaintApplyFailed)) throw e;',
        replacement: 'if (e !== undefined) throw e;',
      },
    ],
    tests: ['rsi/c2/c2-steps-s2.test.ts'],
    expectRed: ['taint_apply_failed(凭据 / 回滚写失败)', 'applyTaint 抛 TaintApplyFailed'],
    mustKill: ['applyTaint 抛 TaintApplyFailed'],
  },
  {
    id: 'settle_faults_dropped',
    clause: '扫尾细项(settleSafety 的 faults)进回合 faults,不丢',
    edits: [
      {
        file: 'src/rsi/personal/steps/run-steps.ts',
        anchor:
          "    if (sw.kind === 'unsettled') faults.push(...sw.faults); // 扫尾细项进日志摘要(unsettled 标记已由 settleSafety 落到回合上)",
        replacement: '    void sw;',
      },
    ],
    tests: ['rsi/c2/c2-run-steps.test.ts'],
    expectRed: ['失锁与日志 / 扫尾细项(验收评审修复)', '扫尾细项不丢'],
    mustKill: ['扫尾细项不丢'],
  },
  {
    id: 'asm_compactor_without_source',
    clause: '真压缩器必须带权威记录来源(否则 compact_unwired 抛错 = 每轮故障)',
    edits: [
      {
        file: 'src/rsi/assemble-personal.ts',
        anchor: '        source: createReconcileSource({ records: k.auth }),\n',
        replacement: '',
      },
    ],
    tests: ['rsi/c2/c2-assemble-e2e.test.ts'],
    expectRed: ['C2 生产装配(真 worker)', '私有仓库未建'],
    mustKill: ['私有仓库未建'],
  },
  {
    id: 's2_halt_lock_lost_not_ended',
    clause: 'S2 步骤返回 halt:lock_lost(归属未明)→ 未决并结束个人轮,余下步骤零调用',
    edits: [
      {
        file: 'src/rsi/personal/steps/s2-reduce.ts',
        anchor: '        this.ended = true;\n      }\n    }\n    const f = faultOfOutcome',
        replacement: '      }\n    }\n    const f = faultOfOutcome',
      },
    ],
    tests: ['rsi/c2/c2-steps-s2.test.ts'],
    expectRed: ['runS2P 顺序与「唯一一次」', 'halt 前缀:lock_lost(归属未明)'],
    mustKill: ['halt 前缀:lock_lost(归属未明)'],
  },
];

/** 执行后由主代理回填(本块不执行变异) */
/** 历史实测:39 条 @46469b8(r21c2-mut-f)+ 2 条修正后 @7a1bdf7(r21c2-mut2-g),其间仅改表内这两条;全部 KILLED。**D1b-1 删去 5 条(守卫类)并同序删其结果条目、重命名 S1 映射测试(killedBy 文本同步);剩余条目待主代理在 D1b-1 合并树上重跑受影响锚点** */
export const V1_ASM_C2_RESULTS: readonly V1AsmC2Result[] = [
  {
    id: 's1_open_lock_error_swallowed',
    failed: 1,
    skipped: 0,
    killedBy: [
      'S1 仓库恢复映射(createRepoRecovery:open 结果 → RepoRecovery) git 读失败(open 抛非锁错误)= 仓库不可用 invalid;锁错误 / 失锁原样上抛',
    ],
    restored: true,
  },
  {
    id: 's1_deferred_reason_mixed',
    failed: 1,
    skipped: 0,
    killedBy: [
      'S1 仓库恢复映射(createRepoRecovery:open 结果 → RepoRecovery) open 结果映射:absent / ready / invalid / deferred(两个原因)/ bootstrap_pending(incomplete,不熔断);open 恒被调用',
    ],
    restored: true,
  },
  {
    id: 's1_flag_diverged_also_clears_owner',
    failed: 1,
    skipped: 0,
    killedBy: [
      'runS1 标志重算:① 清两标志;② 只置 diverged;④ 只置 owner_changed;③ / absent 不动(flag_not_cleared_on_unreadable)',
    ],
    restored: true,
  },
  {
    id: 's1_repo_invalid_not_reported',
    failed: 1,
    skipped: 0,
    killedBy: [
      'runS1 仓库 invalid → 不在 S1 里 trip(预算每轮 ≤1),而是返回 tripReasons 并入 S2P 的单次 trip',
    ],
    restored: true,
  },
  {
    id: 's1_step_failure_stops_rest',
    failed: 1,
    skipped: 0,
    killedBy: ['runS1 某项抛错 → 记故障、继续下一项;incomplete 的 halt 前缀进 unsettled'],
    restored: true,
  },
  {
    id: 's1_halt_prefix_ignored',
    failed: 1,
    skipped: 0,
    killedBy: ['runS1 某项抛错 → 记故障、继续下一项;incomplete 的 halt 前缀进 unsettled'],
    restored: true,
  },
  {
    id: 's1_personal_lock_loss_continues',
    failed: 1,
    skipped: 0,
    killedBy: ['runS1 个人锁丢失 → 结束个人轮(余下步骤不调);rsi 锁丢失 → 原样上抛'],
    restored: true,
  },
  {
    id: 'taint_run_dir_missing_as_clean',
    failed: 1,
    skipped: 0,
    killedBy: [
      '污染扫描器(TaintScanner) unknown 三态不当 clean、不当 tainted:来源缺失 / run 目录不存在 / 标记读不出',
    ],
    restored: true,
  },
  {
    id: 'taint_journal_not_read',
    failed: 2,
    skipped: 0,
    killedBy: [
      '污染扫描器(TaintScanner) 标记命中 → tainted;journal 目标命中 → tainted(目录已被清走也是);clean 不入',
      '污染扫描器(TaintScanner) journal invalid / unreadable、暂存区超限 / 不可信 → unavailable(不臆测任何候选干净)',
    ],
    restored: true,
  },
  {
    id: 'taint_source_null_not_unknown',
    failed: 1,
    skipped: 0,
    killedBy: [
      '污染扫描器(TaintScanner) unknown 三态不当 clean、不当 tainted:来源缺失 / run 目录不存在 / 标记读不出',
    ],
    restored: true,
  },
  {
    id: 'taint_journal_target_ignored',
    failed: 1,
    skipped: 0,
    killedBy: [
      '污染扫描器(TaintScanner) 标记命中 → tainted;journal 目标命中 → tainted(目录已被清走也是);clean 不入',
    ],
    restored: true,
  },
  {
    id: 's2_rescan_every_round',
    failed: 2,
    skipped: 0,
    killedBy: [
      'runS2P 顺序与「唯一一次」 顺序:污染 → 分析(有 canary)→ 到期 → 对账 → 触发 → 解除;触发评估 / 自动解除各恰一次',
      'runS2P 顺序与「唯一一次」 exclude_rescan_only_when_due:仅 l0DueNow 的轮在扫描前先重扫',
    ],
    restored: true,
  },
  {
    id: 's2_trip_not_merged',
    failed: 2,
    skipped: 0,
    killedBy: [
      'runS2P 顺序与「唯一一次」 S1 的 personal_repo_invalid 与触发评估的码合并成**一次** tripAndMute;无码不调',
      'runS2P 顺序与「唯一一次」 隔离:某步抛错 → 记故障、后面照跑;个人失锁 → ended 且后面不跑;rsi 失锁原样上抛',
    ],
    restored: true,
  },
  {
    id: 's2_unknown_canary_not_stopped',
    failed: 1,
    skipped: 0,
    killedBy: [
      'runS2P 顺序与「唯一一次」 命中污染 → applyTaint(凭据先于转移的实现在端口里);unknown 的 canary → 只停注入(不转移)',
    ],
    restored: true,
  },
  {
    id: 's2_analysis_without_canary',
    failed: 1,
    skipped: 0,
    killedBy: ['runS2P 顺序与「唯一一次」 无 canary 记录 → 不跑分析链'],
    restored: true,
  },
  {
    id: 's2_rsi_lock_loss_swallowed',
    failed: 1,
    skipped: 0,
    killedBy: [
      'runS2P 顺序与「唯一一次」 隔离:某步抛错 → 记故障、后面照跑;个人失锁 → ended 且后面不跑;rsi 失锁原样上抛',
    ],
    restored: true,
  },
  {
    id: 'compact_full_unsettles',
    failed: 1,
    skipped: 0,
    killedBy: [
      '压缩调度 noop / compacted 无事;audit_full / effects_full → storeFull(不未决、不停 S2);region_open / store_io / 非法 / 抛错 → 未决 compaction_failed',
    ],
    restored: true,
  },
  {
    id: 'compact_unwired_is_fault',
    failed: 1,
    skipped: 0,
    killedBy: ['压缩调度 缺省(B1b 未装配)= compact_unwired,不是故障、不未决'],
    restored: true,
  },
  {
    id: 'compact_throw_not_unsettled',
    failed: 1,
    skipped: 0,
    killedBy: [
      '压缩调度 noop / compacted 无事;audit_full / effects_full → storeFull(不未决、不停 S2);region_open / store_io / 非法 / 抛错 → 未决 compaction_failed',
    ],
    restored: true,
  },
  {
    id: 'stage_busy_runs_s1',
    failed: 1,
    skipped: 0,
    killedBy: [
      '忙 / 故障轮(没有 BothRound) 只跑 S2R + T_rsi + 扫尾:S1 / 压缩 / S2P 零调用;verdict personal_busy;命中码经 tripAndMute',
    ],
    restored: true,
  },
  {
    id: 'stage_factory_throw_not_unsettled',
    failed: 1,
    skipped: 0,
    killedBy: ['持两锁的回合 端口工厂抛错 → 记故障 + 本轮未决;个人锁仍释放;不崩'],
    restored: true,
  },
  {
    id: 'hint_ignores_reasons',
    failed: 1,
    skipped: 0,
    killedBy: [
      'hint 读已提交 state.json 的暂停事实(canary 部分) reasons 非空 → 本次没有 canary 部分(无关联标记、不落账);计数行不受影响',
    ],
    restored: true,
  },
  {
    id: 'hint_ignores_diverged',
    failed: 1,
    skipped: 0,
    killedBy: [
      'hint 读已提交 state.json 的暂停事实(canary 部分) diverged → 本次没有 canary 部分(无关联标记、不落账);计数行不受影响',
    ],
    restored: true,
  },
  {
    id: 'hint_ignores_owner_changed',
    failed: 1,
    skipped: 0,
    killedBy: [
      'hint 读已提交 state.json 的暂停事实(canary 部分) owner_changed → 本次没有 canary 部分(无关联标记、不落账);计数行不受影响',
    ],
    restored: true,
  },
  {
    id: 'revoke_detailed_wrong_existing',
    failed: 1,
    skipped: 0,
    killedBy: [
      'writeRevocationDetailed 同键、已有凭据来源不同(veto / cleared):返回已有归因,字节不变(不覆盖、不追加)',
    ],
    restored: true,
  },
  {
    id: 'revoke_detailed_ignores_sha',
    failed: 1,
    skipped: 0,
    killedBy: ['writeRevocationDetailed 内容 sha 不同 = 新键 → written(两行)'],
    restored: true,
  },
  {
    id: 'd18_marker_ignored',
    failed: 1,
    skipped: 0,
    killedBy: ['collectD18(真夹具;只读) B 标记在 → 同一夹具不再成立(正向对照)'],
    restored: true,
  },
  {
    id: 'd18_tail_counts_other_rows',
    failed: 1,
    skipped: 0,
    killedBy: ['skippedLockedTailOf 尾部有别的行 / 不合规行 → 0 条;中间夹别的行只数其后'],
    restored: true,
  },
  {
    id: 'd18_unreadable_ok',
    failed: 1,
    skipped: 0,
    killedBy: [
      'checkD18(纯展示合成) 不适用 → n_a / absent;读不到 → warn / unreadable;无信号 → ok;有信号 → warn,result 取首个、items 列全部',
    ],
    restored: true,
  },
  {
    id: 'cap_taint_scan_claimed_false',
    failed: 2,
    skipped: 0,
    killedBy: [
      'production_capability_table_matches_delivered 契约能力表:键 = RSI_ASSEMBLY_CAPS 全集;只有已交付的 worker_safety_skeleton / taint_scan 为真(C2),推出的 wired 集合与契约导出的生产集合一致',
      'production_capability_table_matches_delivered wiredFromTable 的变异对照:把某个键置真就会出现在集合里(表是读出能力的唯一来源)',
    ],
    restored: true,
  },
  {
    id: 's1_repo_lock_loss_not_ended',
    failed: 2,
    skipped: 0,
    killedBy: [
      '失锁与日志 / 扫尾细项(验收评审修复) recoverRepo 抛 PersonalLockLost → 压缩 / S2P / 扫尾零调用;回合 unsettled 且 growth = lock_lost;个人锁仍释放一次',
      'runS1 recoverRepo(第 1 项)抛个人失锁 → ended = true、余下四项零调用(与 guarded 路径同)',
    ],
    restored: true,
  },
  {
    id: 'judge_lock_loss_not_resolved',
    failed: 1,
    skipped: 0,
    killedBy: [
      '失锁与日志 / 扫尾细项(验收评审修复) W9 槽 halted=lock_lost 且 rsi 锁实际已丢 → 原样上抛(resolveLockLoss 解析),S2P 余下步骤(触发 / 解除)不跑;个人锁仍释放一次',
    ],
    restored: true,
  },
  {
    id: 'taint_apply_failed_generic',
    failed: 1,
    skipped: 0,
    killedBy: [
      'taint_apply_failed(凭据 / 回滚写失败) applyTaint 抛 TaintApplyFailed → faults 含稳定码 taint_apply_failed 与失败候选 id,不是 step_threw;后续步骤照跑',
    ],
    restored: true,
  },
  {
    id: 'settle_faults_dropped',
    failed: 1,
    skipped: 0,
    killedBy: [
      '失锁与日志 / 扫尾细项(验收评审修复) 扫尾细项不丢:扫尾 enforceMute 抛错 → faults 含 step_threw,回合 safety_not_settled',
    ],
    restored: true,
  },
  {
    id: 'asm_compactor_without_source',
    failed: 1,
    skipped: 0,
    killedBy: [
      'C2 生产装配(真 worker) 私有仓库未建:S1 / S2 全程无故障,growth open,个人锁已释放,不建 .git',
    ],
    restored: true,
  },
  {
    id: 's2_halt_lock_lost_not_ended',
    failed: 1,
    skipped: 0,
    killedBy: [
      'runS2P 顺序与「唯一一次」 halt 前缀:lock_lost(归属未明)→ 未决 lock_loss_unresolved 且结束个人轮:余下步骤(对账 / 触发 / 解除)零调用',
    ],
    restored: true,
  },
];
