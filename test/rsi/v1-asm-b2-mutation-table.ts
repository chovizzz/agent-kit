/**
 * §21 V1 装配块 B2(命令接线)必杀变异:封存挂点 / 旧→新效果适配层 / 三层结果 / CommandLocks / 锁绑定端口 / 生产装配。
 * 执行方式同 B1a:验证机私有检出里 cp 备份 → 按锚点替换(每个锚点在对应文件里恰好出现一次)→ 跑 `tests` → 失败集合非空、命中 `expectRed`、`mustKill` 每项至少命中一个、没有 skipped → cp 还原并逐文件 sha256 核对。
 * 不用 git checkout / stash 还原。本文件只写表与期望红的测试名;变异由主代理整表执行,结果记进 `V1_ASM_B2_RESULTS`(本块不执行变异,故留空)。
 * 未覆盖的点(如实记录):`rewritePersonalHead` 的 HEAD 复核与 `inspectPersonalRepo` 的只读性没有命令级用例(rebase-baseline 真 git 端到端未做),故不入表。
 */
export interface Edit {
  file: string;
  anchor: string;
  replacement: string;
}

export interface V1AsmB2Mutation {
  id: string;
  clause: string;
  edits: readonly Edit[];
  /** 相对 `test/` */
  tests: readonly string[];
  expectRed: readonly string[];
  mustKill: readonly string[];
}

export interface V1AsmB2Result {
  id: string;
  failed: number;
  skipped: number;
  killedBy: readonly string[];
  restored: boolean;
}

export const V1_ASM_B2_MUTATIONS: readonly V1AsmB2Mutation[] = [
  {
    id: 'stamp_check_removed',
    clause: 'W0-26 §9 取值后校验 utcDay(at) > W',
    edits: [
      {
        file: 'src/rsi/personal/candidate-apply.ts',
        anchor: 'now = region === null ? unsealedEntryTime(d.now) : region.stampFirst(d.now);',
        replacement: 'now = unsealedEntryTime(d.now);',
      },
    ],
    tests: ['rsi/asm/b-stamp-apply.test.ts'],
    expectRed: ['transition_entry_under_watermark_refused_before_commit'],
    mustKill: ['transition_entry_under_watermark_refused_before_commit'],
  },
  {
    id: 'region_not_closed',
    clause: '区域覆盖到落地结束后关闭(任何分支)',
    edits: [
      {
        file: 'src/rsi/personal/candidate-apply.ts',
        anchor: 'region?.close();',
        replacement: 'void 0;',
      },
    ],
    tests: ['rsi/asm/b-stamp-apply.test.ts'],
    expectRed: ['每个分支之后区域都已关闭', '正向对照:时刻在水位线之后'],
    mustKill: ['每个分支之后区域都已关闭'],
  },
  {
    id: 'sealed_noop_keeps_r5_row',
    clause: '封存时丢弃无键观察行',
    edits: [
      {
        file: 'src/rsi/personal/candidate-apply.ts',
        anchor: "!(e.type === 'append_audit' && e.idem_key === undefined)",
        replacement: 'true',
      },
    ],
    tests: ['rsi/asm/b-stamp-apply.test.ts'],
    expectRed: ['noop_row_sealed_dropped_with_report'],
    mustKill: ['noop_row_sealed_dropped_with_report'],
  },
  {
    id: 'sealed_nonterminal_downgrade',
    clause: '封存拒绝只对终态记录降级',
    edits: [
      {
        file: 'src/rsi/personal/candidate-apply.ts',
        anchor: 'if (!isTerminalLifecycle(rec.lifecycle)) {',
        replacement: 'if (false) {',
      },
    ],
    tests: ['rsi/asm/b-stamp-apply.test.ts'],
    expectRed: [
      '封存拒绝只对终态记录降级为 noop',
      'transition_entry_under_watermark_refused_before_commit',
    ],
    mustKill: ['封存拒绝只对终态记录降级为 noop'],
  },
  {
    id: 'veto_seal_dropped',
    clause: 'veto 直接路径带 seal',
    edits: [
      {
        file: 'src/rsi/auto/write/veto.ts',
        anchor: '...(d.seal !== undefined ? { seal: d.seal } : {}),',
        replacement: '',
      },
    ],
    tests: ['rsi/asm/b-commands-real.test.ts'],
    expectRed: ['protective_veto_lands_under_sealed_clock'],
    mustKill: ['protective_veto_lands_under_sealed_clock'],
  },
  {
    id: 'protective_e1_dropped',
    clause: '保护写不被封存阻断',
    edits: [
      {
        file: 'src/rsi/auto/write/veto.ts',
        anchor: "if (r.halt === 'sealed_interval') await protectiveE1(d, rec);",
        replacement: '',
      },
    ],
    tests: ['rsi/asm/b-commands-real.test.ts'],
    expectRed: ['protective_veto_lands_under_sealed_clock'],
    mustKill: ['protective_veto_lands_under_sealed_clock'],
  },
  {
    id: 'consumer_unwired_ignored',
    clause: '消费方未接线不报完整成功',
    edits: [
      {
        file: 'src/rsi/auto/write/veto.ts',
        anchor: 'p.consumers === undefined',
        replacement: 'false',
      },
    ],
    tests: ['rsi/asm/b-veto-consumer.test.ts'],
    expectRed: ['veto_consumer_unwired_not_success'],
    mustKill: ['veto_consumer_unwired_not_success'],
  },
  {
    id: 'layers_no_upgrade',
    clause: '三层:后继失败升级退 3',
    edits: [
      {
        file: 'src/rsi/auto/write/outcome-output.ts',
        anchor: 'if (pending.length === 0 && !sealed) return exit;',
        replacement: 'return exit;',
      },
    ],
    tests: ['rsi/asm/b-commands-real.test.ts'],
    expectRed: ['protective_veto_lands_under_sealed_clock'],
    mustKill: ['protective_veto_lands_under_sealed_clock'],
  },
  {
    id: 'meta_event_at_now',
    clause: 'event_at 取记录条目不取 now',
    edits: [
      {
        file: 'src/rsi/personal/effects-adapter.ts',
        anchor: "event_at: which === 'veto' ? vetoEventAt(r.record) : terminalEventAt(r.record),",
        replacement: 'event_at: new Date().toISOString(),',
      },
    ],
    tests: ['rsi/asm/b-effects-adapter.test.ts'],
    expectRed: ['terminal: 键:event_at = 终态条目时间'],
    mustKill: ['terminal: 键:event_at = 终态条目时间'],
  },
  {
    id: 'user_veto_never',
    clause: 'veto: 键走 user_veto 意图',
    edits: [
      {
        file: 'src/rsi/personal/effects-adapter.ts',
        anchor: 'd.userVeto !== undefined &&',
        replacement: 'false &&',
      },
    ],
    tests: ['rsi/asm/b-effects-adapter.test.ts'],
    expectRed: ['user_veto 路由'],
    mustKill: ['user_veto 路由'],
  },
  {
    id: 'user_veto_for_terminal_too',
    clause: '仅 veto: 键走 user_veto',
    edits: [
      {
        file: 'src/rsi/personal/effects-adapter.ts',
        anchor: "which === 'veto' &&",
        replacement: 'true &&',
      },
    ],
    tests: ['rsi/asm/b-effects-adapter.test.ts'],
    expectRed: ['user_veto 路由'],
    mustKill: ['user_veto 路由'],
  },
  {
    id: 'meta_missing_swallowed',
    clause: '读不到记录 fail-closed 不吞',
    edits: [
      {
        file: 'src/rsi/personal/effects-adapter.ts',
        anchor: "if (r.kind !== 'ok') throw missing(`record_${r.kind}`);",
        replacement:
          "if (r.kind !== 'ok') return { event_at: '1970-01-01T00:00:00.000Z', fp_hmac: '0123456789abcdef', near_fp: [] };",
      },
    ],
    tests: ['rsi/asm/b-effects-adapter.test.ts'],
    expectRed: ['读不到 / 对不上 = 抛 effects_meta_missing'],
    mustKill: ['读不到 / 对不上 = 抛 effects_meta_missing'],
  },
  {
    id: 'audit_pending_collapsed',
    clause: '审计待补不塌缩成 deferred',
    edits: [
      {
        file: 'src/rsi/personal/effects-adapter.ts',
        anchor: "if (r.ledger === 'committed') return 'applied';",
        replacement:
          "if (r.ledger === 'committed') return r.audit === 'pending' ? 'deferred' : 'applied';",
      },
    ],
    tests: ['rsi/asm/b-effects-adapter.test.ts'],
    expectRed: ['toLegacyResult:映射规则逐格'],
    mustKill: ['toLegacyResult:映射规则逐格'],
  },
  {
    id: 'recorder_not_recorded',
    clause: '完整层信息记进收集器',
    edits: [
      {
        file: 'src/rsi/personal/effects-adapter.ts',
        anchor: 'd.recorder.record({',
        replacement: 'void ({',
      },
    ],
    tests: ['rsi/asm/b-effects-adapter.test.ts'],
    expectRed: ['三层信息不塌缩'],
    mustKill: ['三层信息不塌缩'],
  },
  {
    id: 'lock_order_reversed',
    clause: '锁序 rsi → personal → sync',
    edits: [
      {
        file: 'src/rsi/auto/write/command-locks.ts',
        anchor: "rsi_personal_sync: Object.freeze(['rsi', 'personal', 'sync'] as const),",
        replacement: "rsi_personal_sync: Object.freeze(['personal', 'rsi', 'sync'] as const),",
      },
    ],
    tests: ['rsi/asm/b-command-locks.test.ts'],
    expectRed: ['rsi → personal → sync 取'],
    mustKill: ['rsi → personal → sync 取'],
  },
  {
    id: 'acquire_fail_leaks',
    clause: '试锁失败先逆序释放',
    edits: [
      {
        file: 'src/rsi/auto/write/command-locks.ts',
        anchor: 'await releaseAll(); // 试锁失败:先逆序释放已拿到的,再原样抛出',
        replacement: '',
      },
    ],
    tests: ['rsi/asm/b-command-locks.test.ts'],
    expectRed: ['试锁失败'],
    mustKill: ['试锁失败'],
  },
  {
    id: 'release_forward_order',
    clause: '逆序释放',
    edits: [
      {
        file: 'src/rsi/auto/write/command-locks.ts',
        anchor: 'for (const t of [...taken].reverse()) {',
        replacement: 'for (const t of [...taken]) {',
      },
    ],
    tests: ['rsi/asm/b-command-locks.test.ts'],
    expectRed: ['rsi → personal → sync 取'],
    mustKill: ['rsi → personal → sync 取'],
  },
  {
    id: 'outside_lock_allowed',
    clause: '锁绑定端口锁外拒绝',
    edits: [
      {
        file: 'src/rsi/auto/write/command-locks.ts',
        anchor: 'h === undefined ||',
        replacement: 'false ||',
      },
    ],
    tests: ['rsi/asm/b-command-locks.test.ts'],
    expectRed: ['锁外 = 抛 RsiLockError internal'],
    mustKill: ['锁外 = 抛 RsiLockError internal'],
  },
  {
    id: 'state_write_creates_missing',
    clause: 'state.json 缺失 / 不合规拒写',
    edits: [
      { file: 'src/rsi/canary/state-port.ts', anchor: "doc.kind !== 'ok'", replacement: 'false' },
    ],
    tests: ['rsi/asm/b-commands-real.test.ts'],
    expectRed: ['PauseStatePort:读改写保留其它键'],
    mustKill: ['PauseStatePort:读改写保留其它键'],
  },
  {
    id: 'bump_not_monotone',
    clause: '入口代单调',
    edits: [
      {
        file: 'src/rsi/canary/state-port.ts',
        anchor: 'const gen = cur + 1;',
        replacement: 'const gen = 1;',
      },
    ],
    tests: ['rsi/asm/b-commands-real.test.ts'],
    expectRed: ['EntryMarks.bump 单调 +1'],
    mustKill: ['EntryMarks.bump 单调 +1'],
  },
  {
    id: 'hold_snapshot_empty',
    clause: '无数据源按仍成立处理',
    edits: [
      {
        file: 'src/rsi/personal/hold-facts.ts',
        anchor: 'const out = new Set<RsiAutoPauseReason>(HOLDS_WITHOUT_SOURCE);',
        replacement: 'const out = new Set<RsiAutoPauseReason>();',
      },
    ],
    tests: ['rsi/asm/b-hold-facts.test.ts'],
    expectRed: ['没有数据源的三个码恒在快照里'],
    mustKill: ['没有数据源的三个码恒在快照里'],
  },
  {
    id: 'store_not_registered',
    clause: '存储核按本次持有登记',
    edits: [
      {
        file: 'src/rsi/assemble-write.ts',
        anchor: 'storeByHeld.set(held, store);',
        replacement: '',
      },
    ],
    tests: ['rsi/asm/b-commands-real.test.ts'],
    expectRed: ['veto_routed_to_new_sink'],
    mustKill: ['veto_routed_to_new_sink'],
  },
  {
    id: 'sealed_event_not_recorded',
    clause: '封存拒绝记进收集器',
    edits: [
      {
        file: 'src/rsi/assemble-write.ts',
        anchor: "if (isSealedInterval(e)) layers.sealed({ cause: 'sealed_interval' });",
        replacement: '',
      },
    ],
    tests: ['rsi/asm/b-commands-real.test.ts'],
    expectRed: ['protective_veto_lands_under_sealed_clock'],
    mustKill: ['protective_veto_lands_under_sealed_clock'],
  },
  {
    id: 'git_wired_in_production',
    clause: '生产不装配 git 路径(归 D)',
    edits: [
      {
        file: 'src/rsi/assemble-write.ts',
        anchor: 'return g === null || d.gitSpawn === undefined',
        replacement: 'return false',
      },
    ],
    tests: ['rsi/asm/b-commands-real.test.ts'],
    expectRed: ['生产未装配 git 路径'],
    mustKill: ['生产未装配 git 路径'],
  },
  {
    id: 'stub_gate_removed_probe',
    clause: '相位 0 入口恒桩',
    edits: [
      {
        file: 'src/rsi/auto/entry.ts',
        anchor: 'if (!capabilityAvailable(RSI_AUTO_SUBCOMMAND_CAPS[route.canonical], phase)) {',
        replacement: 'if (false) {',
      },
    ],
    tests: ['rsi/asm/b-inert.test.ts'],
    expectRed: ['inert_at_phase0_'],
    mustKill: ['inert_at_phase0_'],
  },
];

/** 由主代理整表执行变异后回填 */
export const V1_ASM_B2_RESULTS: readonly V1AsmB2Result[] = [];
