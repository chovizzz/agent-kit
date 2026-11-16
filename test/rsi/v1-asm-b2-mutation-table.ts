/**
 * §21 V1 装配块 B2(命令接线)必杀变异:封存挂点 / 旧→新效果适配层 / 三层结果 / CommandLocks / 锁绑定端口 / 生产装配。
 * 执行方式同 B1a:验证机私有检出里 cp 备份 → 按锚点替换(每个锚点在对应文件里恰好出现一次)→ 跑 `tests` → 失败集合非空、命中 `expectRed`、`mustKill` 每项至少命中一个、没有 skipped → cp 还原并逐文件 sha256 核对。
 * 不用 git checkout / stash 还原。本文件只写表与期望红的测试名;变异由主代理整表执行,结果记进 `V1_ASM_B2_RESULTS`(本块不执行变异,故留空)。
 * 未覆盖的点(如实记录):`inspectPersonalRepo` 的只读性没有命令级用例,rebase-baseline 真 git 命令级端到端未做(`rewritePersonalHead` 的 HEAD 复核 / 让出点由 b-rewrite-head-order 真 git 用例钉住,写后复核由 b-rebase-recheck 钉住),故这两项不入表。
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
    expectRed: [
      '正向对照:时刻在水位线之后',
      'create_boundary_W_vs_W_plus_1',
      'stale_now_captured_before_lock_refused',
      'compaction_between_stamp_and_commit_refused',
      'protective_veto_lands_under_sealed_clock(引擎层)',
      'noop_row_sealed_dropped_with_report',
      '封存拒绝只对终态记录降级为 noop',
      'transition_entry_under_watermark_refused_before_commit',
    ],
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
    expectRed: [
      'transition_entry_under_watermark_refused_before_commit',
      'compaction_between_stamp_and_commit_refused',
      'protective_veto_lands_under_sealed_clock(引擎层)',
      '每个分支之后区域都已关闭',
      '正向对照:时刻在水位线之后',
    ],
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
    expectRed: [
      'terminal: 键:event_at = 终态条目时间',
      'user_veto 路由:veto: 键上单项 blacklist_veto 走 userVeto',
      'user_veto 路由',
    ],
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
    expectRed: [
      'toLegacyResult:映射规则逐格',
      '三层信息不塌缩:收集器保留完整',
      'toLegacyResult:映射规则逐格',
    ],
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
    expectRed: [
      '试锁失败(',
      'rsi_personal_sync:rsi → personal → sync 取',
      'fn 抛错也逆序释放',
      'fn 成功而释放失败',
      'rsi → personal → sync 取',
    ],
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
    expectRed: [
      '试锁失败(',
      'rsi_personal_sync:rsi → personal → sync 取',
      'personal_sync(缩减入口)不取 rsi',
      'fn 抛错也逆序释放',
      'fn 成功而释放失败',
      'rsi → personal → sync 取',
    ],
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
      {
        file: 'src/rsi/canary/state-port.ts',
        anchor: "dir === null || doc.kind !== 'ok'",
        replacement: 'false',
      },
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
    expectRed: [
      'shadow 候选:记录 rejected、黑名单经新端口落账',
      'protective_veto_lands_under_sealed_clock:取时落在水位线之内',
      'veto_routed_to_new_sink',
      'veto_routed_to_new_sink',
      '第三次 veto:黑名单项不再是 lifted',
    ],
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
  {
    id: 'veto_noop_ensure_removed',
    clause:
      '评审 R1 ①:终态重复 veto(引擎 noop + 空 effects)由命令补调用户否决端口,lift 之后再 veto 重新生效',
    edits: [
      {
        file: 'src/rsi/auto/write/veto.ts',
        anchor: 'const extra = await guard.ensure();',
        replacement: 'const extra = null as KeyedEffectResult | null;',
      },
    ],
    tests: ['rsi/asm/b-veto-relanding.test.ts', 'rsi/asm/b-commands-real.test.ts'],
    expectRed: [
      'veto → lift → veto:黑名单重新生效',
      '对照:连续两次 veto(中间没有 lift)',
      '第三次 veto:黑名单项不再是 lifted',
      '终态路径补调 deferred',
    ],
    mustKill: ['veto → lift → veto:黑名单重新生效', '第三次 veto:黑名单项不再是 lifted'],
  },
  {
    id: 'veto_rollback_ensure_removed',
    clause:
      '评审 R1 ①:回滚路径同样补调用户否决端口。可达状态 = 在途回滚的记录已吃过 veto 事件(idem 条目已在,rollback.ts lateEventStatus / driveRecord 两处施加全是 duplicate_idem_key 空操作,E1 不再出),且本次回滚没走到终态(走到终态时 E2 的 blacklist_veto 经 veto: 键再落,补调冗余);夹具 = 一次崩在 after:record_event + 最后一次 veto 在 repoMode=deferred 下',
    edits: [
      {
        file: 'src/rsi/auto/write/veto.ts',
        anchor: "const extra = out.status !== 'refused' ? await guard.ensure() : null;",
        replacement: 'const extra = null as KeyedEffectResult | null;',
      },
    ],
    tests: ['rsi/asm/b-veto-relanding.test.ts'],
    expectRed: ['回滚路径(两把键都在、E1 不再出)', '回滚路径补调 deferred', '回滚路径:在途回滚'],
    mustKill: ['回滚路径(两把键都在、E1 不再出)'],
  },
  {
    id: 'veto_rollback_deferred_not_nonzero',
    clause: '验收评审 R2 ①:回滚分支补调返回 deferred → 退 1 + 未落地提示(不依赖可选的 p.layers)',
    edits: [
      {
        file: 'src/rsi/auto/write/veto.ts',
        anchor: "const unlanded = extra === 'deferred';",
        replacement: 'const unlanded = false as boolean;',
      },
    ],
    tests: ['rsi/asm/b-veto-relanding.test.ts'],
    expectRed: ['回滚路径补调 deferred'],
    mustKill: ['回滚路径补调 deferred'],
  },
  {
    id: 'veto_direct_ensure_deferred_exempt',
    clause:
      '验收评审 R2 ①(核对 directVeto):终态 noop 补调 deferred 时,「原理由 vetoed」的豁免不适用(恢复推不出 lift 之后的用户意图)→ 退 1',
    edits: [
      {
        file: 'src/rsi/auto/write/veto.ts',
        anchor: "(rec.terminal_reason !== 'vetoed' || ensureDeferred)",
        replacement: "(rec.terminal_reason !== 'vetoed')",
      },
    ],
    tests: ['rsi/asm/b-veto-relanding.test.ts'],
    expectRed: ['终态路径补调 deferred'],
    mustKill: ['终态路径补调 deferred'],
  },
  {
    id: 'rebase_post_write_check_removed',
    clause:
      '评审 R1 ②:head.json 写后、清暂停标志前复核情形;非 ok 保持暂停、不报完成(退 1 RSI_CONFIRM_STALE)',
    edits: [
      {
        file: 'src/rsi/auto/write/rebase.ts',
        anchor: "if ((await rb.classify()).kind !== 'ok') {",
        replacement: 'if (false as boolean) {',
      },
    ],
    tests: ['rsi/asm/b-rebase-recheck.test.ts'],
    expectRed: ['baseline:写入之后 HEAD 又变', 'owner(--adopt-owner):写入之后仓库前提不成立'],
    mustKill: ['baseline:写入之后 HEAD 又变', 'owner(--adopt-owner):写入之后仓库前提不成立'],
  },
  {
    id: 'rewrite_head_check_removed',
    clause: '评审 R1 ②:rewritePersonalHead 复核时 HEAD 已变 → 抛 head_changed、head.json 不动',
    edits: [
      {
        file: 'src/rsi/personal/commit.ts',
        anchor:
          "if (revParse(git, 'HEAD^{commit}') !== expectHead) throw new Error('head_changed');",
        replacement: 'void 0;',
      },
    ],
    tests: ['rsi/asm/b-rewrite-head-order.test.ts'],
    expectRed: ['rewrite_head_recheck_after_lock_await'],
    mustKill: ['rewrite_head_recheck_after_lock_await'],
  },
  {
    id: 'rewrite_head_yield_before_write',
    clause:
      '评审 R1 ②:最后一次 HEAD 复核与 head.json 写入之间没有让出点(旧实现的复核后还 await 一次锁复核;变异 = 在复核与写入之间再插一次锁复核)',
    edits: [
      {
        file: 'src/rsi/personal/commit.ts',
        anchor: 'await writeHead(deps.h, next);',
        replacement: 'await assertLockHandles(locks);\n  await writeHead(deps.h, next);',
      },
    ],
    tests: ['rsi/asm/b-rewrite-head-order.test.ts'],
    expectRed: [
      'rewrite_head_no_yield_between_check_and_write',
      'rewrite_head_lock_lost_during_read',
    ],
    mustKill: ['rewrite_head_no_yield_between_check_and_write'],
  },
  {
    id: 'rewrite_head_post_read_lock_recheck_removed',
    clause:
      '验收评审 R2 ②:readHead 之后、HEAD 复核与写入之前必有一次锁复核(读期间丢锁 → lock_lost、head.json 零写入)',
    edits: [
      {
        file: 'src/rsi/personal/commit.ts',
        anchor:
          'await assertLockHandles(locks); // 读后锁复核:读 head.json 期间丢锁 → lock_lost,零写入',
        replacement: 'void 0;',
      },
    ],
    tests: ['rsi/asm/b-rewrite-head-order.test.ts'],
    expectRed: [
      'rewrite_head_lock_lost_during_read',
      'rewrite_head_no_yield_between_check_and_write',
    ],
    mustKill: ['rewrite_head_lock_lost_during_read'],
  },
  {
    id: 'holds_repo_invalid_folds_absent',
    clause: '评审 R1 ③:HoldFacts 只有 invalid 才算 personal_repo_invalid;从未建仓(absent)不成立',
    edits: [
      {
        file: 'src/rsi/assemble-write.ts',
        anchor:
          "repoInvalid: async () => (await inspectPersonalRepo(repoDeps)).kind === 'invalid',",
        replacement:
          "repoInvalid: async () => (await inspectPersonalRepo(repoDeps)).kind !== 'ok',",
      },
    ],
    tests: ['rsi/asm/b-commands-real.test.ts'],
    expectRed: ['从未建仓 → 快照不含 personal_repo_invalid'],
    mustKill: ['从未建仓 → 快照不含 personal_repo_invalid'],
  },
];

/** 由主代理整表执行变异后回填 */
/** 实测结果:r21b2-mut-7b @188f92b(javis):34 条全部被杀 */
export const V1_ASM_B2_RESULTS: readonly V1AsmB2Result[] = [
  {
    id: 'stamp_check_removed',
    failed: 8,
    skipped: 0,
    killedBy: [
      'SealGuard 挂点:applyEvent 的取时与封存校验 正向对照:时刻在水位线之后 → 转移提交,条目 at = 注入时钟,区域已关闭',
      'SealGuard 挂点:applyEvent 的取时与封存校验 transition_entry_under_watermark_refused_before_commit:时刻 ≤ W → halt sealed_interval,仓库零提交、零审计、零效果',
      'SealGuard 挂点:applyEvent 的取时与封存校验 create_boundary_W_vs_W_plus_1:W 当日拒、W+1 日过',
      'SealGuard 挂点:applyEvent 的取时与封存校验 stale_now_captured_before_lock_refused:传入「锁外预取」的旧时刻(压缩推进后落在 ≤ W)也被拒,仓库不变',
      'SealGuard 挂点:applyEvent 的取时与封存校验 compaction_between_stamp_and_commit_refused:stamp 之后、源提交期间压缩被 region_open 拒绝;结束后可压缩',
      '终态记录上的空操作 × 封存区间:保护写不被阻断 protective_veto_lands_under_sealed_clock(引擎层):终态 veto 在封存时钟下仍产出 E1,无审计行,结果 noop',
      '终态记录上的空操作 × 封存区间:保护写不被阻断 noop_row_sealed_dropped_with_report:终态记录上的 clear 空操作:封存时丢弃无键审计行并报 observationRowSealed',
      '终态记录上的空操作 × 封存区间:保护写不被阻断 封存拒绝只对终态记录降级为 noop;非终态仍整体拒绝(不会因降级产生条目)',
    ],
    restored: true,
  },
  {
    id: 'region_not_closed',
    failed: 7,
    skipped: 0,
    killedBy: [
      'SealGuard 挂点:applyEvent 的取时与封存校验 正向对照:时刻在水位线之后 → 转移提交,条目 at = 注入时钟,区域已关闭',
      'SealGuard 挂点:applyEvent 的取时与封存校验 transition_entry_under_watermark_refused_before_commit:时刻 ≤ W → halt sealed_interval,仓库零提交、零审计、零效果',
      'SealGuard 挂点:applyEvent 的取时与封存校验 compaction_between_stamp_and_commit_refused:stamp 之后、源提交期间压缩被 region_open 拒绝;结束后可压缩',
      'SealGuard 挂点:applyEvent 的取时与封存校验 每个分支之后区域都已关闭:提交后抛错(commit 拒绝)',
      'SealGuard 挂点:applyEvent 的取时与封存校验 每个分支之后区域都已关闭:提交失败(commit_failed)',
      'SealGuard 挂点:applyEvent 的取时与封存校验 每个分支之后区域都已关闭:引擎拒绝 / 记录已变(stale)',
      '终态记录上的空操作 × 封存区间:保护写不被阻断 protective_veto_lands_under_sealed_clock(引擎层):终态 veto 在封存时钟下仍产出 E1,无审计行,结果 noop',
    ],
    restored: true,
  },
  {
    id: 'sealed_noop_keeps_r5_row',
    failed: 1,
    skipped: 0,
    killedBy: [
      '终态记录上的空操作 × 封存区间:保护写不被阻断 noop_row_sealed_dropped_with_report:终态记录上的 clear 空操作:封存时丢弃无键审计行并报 observationRowSealed',
    ],
    restored: true,
  },
  {
    id: 'sealed_nonterminal_downgrade',
    failed: 2,
    skipped: 0,
    killedBy: [
      'SealGuard 挂点:applyEvent 的取时与封存校验 transition_entry_under_watermark_refused_before_commit:时刻 ≤ W → halt sealed_interval,仓库零提交、零审计、零效果',
      '终态记录上的空操作 × 封存区间:保护写不被阻断 封存拒绝只对终态记录降级为 noop;非终态仍整体拒绝(不会因降级产生条目)',
    ],
    restored: true,
  },
  {
    id: 'veto_seal_dropped',
    failed: 1,
    skipped: 0,
    killedBy: [
      'veto 命令级(真 git + 假 HOME + 真存储核) protective_veto_lands_under_sealed_clock:取时落在水位线之内 → 退 3 audit_invalid + 已提交待处理信息行;记录与 HEAD 不变,E1 黑名单已落;时钟恢复后重跑幂等完成',
    ],
    restored: true,
  },
  {
    id: 'protective_e1_dropped',
    failed: 1,
    skipped: 0,
    killedBy: [
      'veto 命令级(真 git + 假 HOME + 真存储核) protective_veto_lands_under_sealed_clock:取时落在水位线之内 → 退 3 audit_invalid + 已提交待处理信息行;记录与 HEAD 不变,E1 黑名单已落;时钟恢复后重跑幂等完成',
    ],
    restored: true,
  },
  {
    id: 'consumer_unwired_ignored',
    failed: 3,
    skipped: 0,
    killedBy: [
      'veto_consumer_unwired_not_success 终态候选(只写黑名单):账已提交但消费方未接线 → 退 1,stdout 含 consumer=unwired;对照:已接线退 0',
      'veto_consumer_unwired_not_success 未部署候选(直接 rejected):账已提交但消费方未接线 → 退 1,stdout 含 consumer=unwired;对照:已接线退 0',
      'veto_consumer_unwired_not_success 已部署候选(回滚):账已提交但消费方未接线 → 退 1,stdout 含 consumer=unwired;对照:已接线退 0',
    ],
    restored: true,
  },
  {
    id: 'layers_no_upgrade',
    failed: 1,
    skipped: 0,
    killedBy: [
      'veto 命令级(真 git + 假 HOME + 真存储核) protective_veto_lands_under_sealed_clock:取时落在水位线之内 → 退 3 audit_invalid + 已提交待处理信息行;记录与 HEAD 不变,E1 黑名单已落;时钟恢复后重跑幂等完成',
    ],
    restored: true,
  },
  {
    id: 'meta_event_at_now',
    failed: 1,
    skipped: 0,
    killedBy: [
      '元信息:持锁读记录现算,绝不取 now terminal: 键:event_at = 终态条目时间,fp_hmac = 记录的,near_fp = [];走 sink(replay)',
    ],
    restored: true,
  },
  {
    id: 'user_veto_never',
    failed: 1,
    skipped: 0,
    killedBy: [
      '元信息:持锁读记录现算,绝不取 now user_veto 路由:veto: 键上单项 blacklist_veto 走 userVeto;同样的 effect 放在 terminal: 键里走 sink(对照)',
    ],
    restored: true,
  },
  {
    id: 'user_veto_for_terminal_too',
    failed: 2,
    skipped: 0,
    killedBy: [
      '元信息:持锁读记录现算,绝不取 now terminal: 键:event_at = 终态条目时间,fp_hmac = 记录的,near_fp = [];走 sink(replay)',
      '元信息:持锁读记录现算,绝不取 now user_veto 路由:veto: 键上单项 blacklist_veto 走 userVeto;同样的 effect 放在 terminal: 键里走 sink(对照)',
    ],
    restored: true,
  },
  {
    id: 'meta_missing_swallowed',
    failed: 1,
    skipped: 0,
    killedBy: [
      '元信息:持锁读记录现算,绝不取 now 读不到 / 对不上 = 抛 effects_meta_missing(不映射成 deferred,零调用):记录不存在',
    ],
    restored: true,
  },
  {
    id: 'audit_pending_collapsed',
    failed: 2,
    skipped: 0,
    killedBy: [
      'toLegacyResult:映射规则逐格 ledger=committed audit=pending → applied',
      '三层信息不塌缩:收集器保留完整 {ledger, audit, cause} 账已提交而审计待补 → 旧枚举 applied(不是 deferred),收集器记 audit=pending',
    ],
    restored: true,
  },
  {
    id: 'recorder_not_recorded',
    failed: 2,
    skipped: 0,
    killedBy: [
      '三层信息不塌缩:收集器保留完整 {ledger, audit, cause} 账未提交(effects_full)→ 旧枚举 deferred,收集器记 reason=effects_full',
      '三层信息不塌缩:收集器保留完整 {ledger, audit, cause} 账已提交而审计待补 → 旧枚举 applied(不是 deferred),收集器记 audit=pending',
    ],
    restored: true,
  },
  {
    id: 'lock_order_reversed',
    failed: 6,
    skipped: 0,
    killedBy: [
      'CommandLocks:顺序 / 试锁 / 逆序释放 rsi_personal_sync:rsi → personal → sync 取,sync → personal → rsi 放',
      'CommandLocks:顺序 / 试锁 / 逆序释放 试锁失败(rsi):fn 不执行,已拿到的逆序释放,错误原样抛出(RsiLockError locked)',
      'CommandLocks:顺序 / 试锁 / 逆序释放 试锁失败(personal):fn 不执行,已拿到的逆序释放,错误原样抛出(RsiLockError locked)',
      'CommandLocks:顺序 / 试锁 / 逆序释放 试锁失败(sync):fn 不执行,已拿到的逆序释放,错误原样抛出(RsiLockError locked)',
      'CommandLocks:顺序 / 试锁 / 逆序释放 fn 抛错也逆序释放;释放失败不遮盖 fn 的错误(三把都尝试)',
      'CommandLocks:顺序 / 试锁 / 逆序释放 fn 成功而释放失败:抛释放错误(不假装干净),其余仍释放',
    ],
    restored: true,
  },
  {
    id: 'acquire_fail_leaks',
    failed: 2,
    skipped: 0,
    killedBy: [
      'CommandLocks:顺序 / 试锁 / 逆序释放 试锁失败(personal):fn 不执行,已拿到的逆序释放,错误原样抛出(RsiLockError locked)',
      'CommandLocks:顺序 / 试锁 / 逆序释放 试锁失败(sync):fn 不执行,已拿到的逆序释放,错误原样抛出(RsiLockError locked)',
    ],
    restored: true,
  },
  {
    id: 'release_forward_order',
    failed: 5,
    skipped: 0,
    killedBy: [
      'CommandLocks:顺序 / 试锁 / 逆序释放 rsi_personal_sync:rsi → personal → sync 取,sync → personal → rsi 放',
      'CommandLocks:顺序 / 试锁 / 逆序释放 personal_sync(缩减入口)不取 rsi;held.rsi = null',
      'CommandLocks:顺序 / 试锁 / 逆序释放 试锁失败(sync):fn 不执行,已拿到的逆序释放,错误原样抛出(RsiLockError locked)',
      'CommandLocks:顺序 / 试锁 / 逆序释放 fn 抛错也逆序释放;释放失败不遮盖 fn 的错误(三把都尝试)',
      'CommandLocks:顺序 / 试锁 / 逆序释放 fn 成功而释放失败:抛释放错误(不假装干净),其余仍释放',
    ],
    restored: true,
  },
  {
    id: 'outside_lock_allowed',
    failed: 1,
    skipped: 0,
    killedBy: [
      '锁绑定断言:assertInsideLocks 锁外 = 抛 RsiLockError internal;持锁期内(含 await 之后)可见当前持有者并复核两把锁',
    ],
    restored: true,
  },
  {
    id: 'state_write_creates_missing',
    failed: 1,
    skipped: 0,
    killedBy: [
      '锁绑定端口与路由 PauseStatePort:读改写保留其它键、整份过 schema;state.json 缺失时拒写(不凭空创建);不合规 = state_invalid 拒写',
    ],
    restored: true,
  },
  {
    id: 'bump_not_monotone',
    failed: 1,
    skipped: 0,
    killedBy: ['锁绑定端口与路由 EntryMarks.bump 单调 +1;文件不合规 = state_invalid 且不覆盖'],
    restored: true,
  },
  {
    id: 'hold_snapshot_empty',
    failed: 1,
    skipped: 0,
    killedBy: ['HoldFacts 没有数据源的三个码恒在快照里;仓库合法时 personal_repo_invalid 不在'],
    restored: true,
  },
  {
    id: 'store_not_registered',
    failed: 4,
    skipped: 0,
    killedBy: [
      'veto 命令级(真 git + 假 HOME + 真存储核) shadow 候选:记录 rejected、黑名单经新端口落账;消费方未接线 → 退 1 consumer=unwired;对照:已接线退 0',
      'veto 命令级(真 git + 假 HOME + 真存储核) protective_veto_lands_under_sealed_clock:取时落在水位线之内 → 退 3 audit_invalid + 已提交待处理信息行;记录与 HEAD 不变,E1 黑名单已落;时钟恢复后重跑幂等完成',
      '锁绑定端口与路由 veto_routed_to_new_sink:rollbackDeps 的带键出口落到存储核的账(不是旧 deferred),seal 已接;同一次持有里存储核可取',
      'veto → lift → veto 重新生效(真存储核;评审第 1 轮 ①) 第三次 veto:黑名单项不再是 lifted(vetoed_gen 前进),输出 effects=applied;对照:连续两次 veto 第二次是 already 且账不变',
    ],
    restored: true,
  },
  {
    id: 'sealed_event_not_recorded',
    failed: 1,
    skipped: 0,
    killedBy: [
      'veto 命令级(真 git + 假 HOME + 真存储核) protective_veto_lands_under_sealed_clock:取时落在水位线之内 → 退 3 audit_invalid + 已提交待处理信息行;记录与 HEAD 不变,E1 黑名单已落;时钟恢复后重跑幂等完成',
    ],
    restored: true,
  },
  {
    id: 'git_wired_in_production',
    failed: 1,
    skipped: 0,
    killedBy: [
      'veto 命令级(真 git + 假 HOME + 真存储核) 生产未装配 git 路径:锁外预读恒 invalid(不是 unknown_id),veto 退 3 且零写入',
    ],
    restored: true,
  },
  {
    id: 'stub_gate_removed_probe',
    failed: 7,
    skipped: 0,
    killedBy: [
      '生产惰性(相位 0) inert_at_phase0_pause:真入口退 64 桩,世界逐字节不变',
      '生产惰性(相位 0) inert_at_phase0_resume:真入口退 64 桩,世界逐字节不变',
      '生产惰性(相位 0) inert_at_phase0_clear_write:真入口退 64 桩,世界逐字节不变',
      '生产惰性(相位 0) inert_at_phase0_rebase_baseline:真入口退 64 桩,世界逐字节不变',
      '生产惰性(相位 0) inert_at_phase0_veto:真入口退 64 桩,世界逐字节不变',
      '生产惰性(相位 0) inert_at_phase0_veto_lift:真入口退 64 桩,世界逐字节不变',
      '生产惰性(相位 0) inert_at_phase0_rollback_to:真入口退 64 桩,世界逐字节不变',
    ],
    restored: true,
  },
  {
    id: 'veto_noop_ensure_removed',
    failed: 4,
    skipped: 0,
    killedBy: [
      'veto → lift → veto 重新生效(真存储核;评审第 1 轮 ①) 第三次 veto:黑名单项不再是 lifted(vetoed_gen 前进),输出 effects=applied;对照:连续两次 veto 第二次是 already 且账不变',
      'veto_relands_after_lift 终态(经引擎 veto 进 rejected):veto → lift → veto:黑名单重新生效,输出 effects=applied(不是 already)',
      'veto_relands_after_lift 对照:连续两次 veto(中间没有 lift)→ 第二次确实是已满足:effects=already,黑名单仍生效',
      'veto_relands_after_lift 终态路径补调 deferred(layers 缺省):lift 后再 veto,补调推迟 → 退 1 + 提示,黑名单仍 lifted(原理由即 vetoed 也不豁免);对照:补调正常 → 退 0 effects=applied',
    ],
    restored: true,
  },
  {
    id: 'veto_rollback_ensure_removed',
    failed: 3,
    skipped: 0,
    killedBy: [
      'veto_relands_after_lift 回滚路径:在途回滚(记录 rolling_back,veto 条目与 E1 已落)被 lift 后再 veto → 黑名单重新生效',
      'veto_relands_after_lift 回滚路径(两把键都在、E1 不再出):lift 后再 veto → 只靠补调重新生效,恰多一次用户意图调用,退 0',
      'veto_relands_after_lift 回滚路径补调 deferred(layers 缺省、consumers 已接线):退 1 且有「否决未落地」提示,黑名单仍是 lifted;对照:补调 applied(上一条)/ already → 退 0',
    ],
    restored: true,
  },
  {
    id: 'veto_rollback_deferred_not_nonzero',
    failed: 1,
    skipped: 0,
    killedBy: [
      'veto_relands_after_lift 回滚路径补调 deferred(layers 缺省、consumers 已接线):退 1 且有「否决未落地」提示,黑名单仍是 lifted;对照:补调 applied(上一条)/ already → 退 0',
    ],
    restored: true,
  },
  {
    id: 'veto_direct_ensure_deferred_exempt',
    failed: 1,
    skipped: 0,
    killedBy: [
      'veto_relands_after_lift 终态路径补调 deferred(layers 缺省):lift 后再 veto,补调推迟 → 退 1 + 提示,黑名单仍 lifted(原理由即 vetoed 也不豁免);对照:补调正常 → 退 0 effects=applied',
    ],
    restored: true,
  },
  {
    id: 'rebase_post_write_check_removed',
    failed: 2,
    skipped: 0,
    killedBy: [
      'rebase_post_write_recheck baseline:写入之后 HEAD 又变(情形回到分叉)→ 退 1 RSI_CONFIRM_STALE,diverged 标志保持,不报 done;对照:没变 → 退 0 且清标志',
      'rebase_post_write_recheck owner(--adopt-owner):写入之后仓库前提不成立(检视 invalid)→ 同样退 1 RSI_CONFIRM_STALE,owner_changed 标志保持',
    ],
    restored: true,
  },
  {
    id: 'rewrite_head_check_removed',
    failed: 1,
    skipped: 0,
    killedBy: [
      'rewritePersonalHead:复核紧贴写入 rewrite_head_recheck_after_lock_await:锁复核期间 HEAD 变了 → 抛 head_changed,head.json 不动',
    ],
    restored: true,
  },
  {
    id: 'rewrite_head_yield_before_write',
    failed: 2,
    skipped: 0,
    killedBy: [
      'rewritePersonalHead:复核紧贴写入 rewrite_head_no_yield_between_check_and_write:复核通过后不再让出,写入的就是复核时的 HEAD(head.json = 当前 HEAD)',
      'rewritePersonalHead:复核紧贴写入 rewrite_head_lock_lost_during_read:读 head.json 期间句柄丢失 → 抛 lock_lost,head.json 零写入;对照:句柄一直有效 → 写入成功(锁复核恰 2 次:读前、读后)',
    ],
    restored: true,
  },
  {
    id: 'rewrite_head_post_read_lock_recheck_removed',
    failed: 2,
    skipped: 0,
    killedBy: [
      'rewritePersonalHead:复核紧贴写入 rewrite_head_no_yield_between_check_and_write:复核通过后不再让出,写入的就是复核时的 HEAD(head.json = 当前 HEAD)',
      'rewritePersonalHead:复核紧贴写入 rewrite_head_lock_lost_during_read:读 head.json 期间句柄丢失 → 抛 lock_lost,head.json 零写入;对照:句柄一直有效 → 写入成功(锁复核恰 2 次:读前、读后)',
    ],
    restored: true,
  },
  {
    id: 'holds_repo_invalid_folds_absent',
    failed: 1,
    skipped: 0,
    killedBy: [
      'HoldFacts 装配级(评审第 1 轮 ③):absent 与 invalid 分开 从未建仓 → 快照不含 personal_repo_invalid;对照:head.json 损坏 → 含',
    ],
    restored: true,
  },
];
