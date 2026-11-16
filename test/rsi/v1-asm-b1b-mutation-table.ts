/**
 * §21 V1 装配块 B1b(压缩与水位线)必杀变异:Compactor 编排(租约 / P1 复核 / P2 gen / P3 / P4 / compact_blocked / 清理续做)、压缩纯规划(目标 / P1 判据 / 区间计数与去重 / 汇总合并)、
 * 真 `ReconcileSource` 适配器、事务内压缩端口、report 的 gen 双读与水位线口径、能力门禁。
 * 执行方式同 B1a / W5 – W8:验证机私有检出里 cp 备份 → 按锚点替换(每个锚点在对应文件里**恰好出现一次**)→ 跑 `tests` → 失败集合非空、全部命中 `expectRed`、
 * `mustKill` 每项至少命中一个、没有 skipped → cp 还原并逐文件 sha256 核对。**不用 git checkout / stash 还原**。
 * 本文件只写表与每条变异期望红的测试名(`expectRed` 是杀手测试名里的字面子串);变异由主代理整表执行,结果记进 `V1_ASM_B1B_RESULTS`(本块不执行变异,故留空)。
 * 不在本表的点(如实记录):①崩溃矩阵里「P2 前 / 后」等逐点用例由 `compactor-crash.test.ts` 的对照世界字节比较承担,单点变异已被上面的 p2 / p3 / p4 / cleanup 条目覆盖;
 * ②`rsi-compaction.ts` 的 I1 判定(`through` 须早于今日)的变异在 B1a 表里(`src/contracts/rsi-compaction.ts` 锚点);③未真机演练:ENOSPC / EACCES / rename 失败 / 部分写 / fsync 失败由 `crashFs` 包装注入。
 * 变异 id 用短的下划线词。
 */
export interface Edit {
  file: string;
  anchor: string;
  replacement: string;
}

export interface V1AsmB1bMutation {
  id: string;
  /** 契约条款 / 该不变量 */
  clause: string;
  edits: readonly Edit[];
  /** 相对 `test/` */
  tests: readonly string[];
  expectRed: readonly string[];
  mustKill: readonly string[];
}

export interface V1AsmB1bResult {
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

export const V1_ASM_B1B_MUTATIONS: readonly V1AsmB1bMutation[] = [
  {
    id: 'unwired_check_dropped',
    clause: 'compact_unwired:未接线一律拒绝(任何读写之前)',
    edits: [
      swap(
        'src/rsi/store/compactor.ts',
        "if (reconcile === unwiredReconcileSource) throw new StoreError('compact_unwired');",
        '',
      ),
    ],
    tests: ['rsi/store/compactor.test.ts'],
    expectRed: [
      'compact_unwired:未接线',
      'Compactor 推进(',
      'compact_blocked 与零写入拒绝(',
      '压缩租约(P2 期间不许新开区域)',
      'compact_recovery_audit_full_ledger_pending_advances(内存世界;20000 行)',
      '旧批次重放安全(',
    ],
    mustKill: ['compact_unwired:未接线'],
  },
  {
    id: 'lease_skipped',
    clause: '压缩租约:区域占用 / 租约期间不许新开区域',
    edits: [
      swap(
        'src/rsi/store/compactor.ts',
        'const release = deps.registry.acquireCompactionLease();',
        'const release = (): void => undefined;',
      ),
    ],
    tests: ['rsi/store/compactor.test.ts'],
    expectRed: [
      'region_open:有未关闭的区域',
      'compaction_lease_blocks_region_open_during_p2',
      'Compactor 推进(',
      'compact_blocked 与零写入拒绝(',
      '压缩租约(P2 期间不许新开区域)',
      'compact_recovery_audit_full_ledger_pending_advances(内存世界;20000 行)',
      '旧批次重放安全(',
    ],
    mustKill: ['region_open:有未关闭的区域'],
  },
  {
    id: 'lease_open_not_blocked',
    clause: '租约期间 SealGuard.open 拒绝',
    edits: [
      swap(
        'src/rsi/store/seal.ts',
        "if (deps.registry.isCompacting()) throw new StoreError('region_open', 'compacting');\n      await held.assertHeld();",
        'await held.assertHeld();',
      ),
      swap(
        'src/rsi/store/seal.ts',
        "// 登记前同步复核(中间没有 await):正在压缩,或读取期间纪元变过 = 拒绝\n      if (deps.registry.isCompacting()) throw new StoreError('region_open', 'compacting');",
        '',
      ),
    ],
    tests: ['rsi/store/compactor.test.ts'],
    expectRed: [
      'compaction_lease_blocks_region_open_during_p2',
      'Compactor 推进(',
      'compact_blocked 与零写入拒绝(',
      '压缩租约(P2 期间不许新开区域)',
      'compact_recovery_audit_full_ledger_pending_advances(内存世界;20000 行)',
      '旧批次重放安全(',
    ],
    mustKill: ['compaction_lease_blocks_region_open_during_p2'],
  },
  {
    id: 'lease_not_released',
    clause: '租约必须释放(含失败)',
    edits: [swap('src/rsi/store/seal.ts', 'this.compacting = false;', 'void 0;')],
    tests: ['rsi/store/compactor.test.ts'],
    expectRed: [
      'compaction_lease_blocks_region_open_during_p2',
      '压缩失败时租约也释放',
      'Compactor 推进(',
      'compact_blocked 与零写入拒绝(',
      '压缩租约(P2 期间不许新开区域)',
      'compact_recovery_audit_full_ledger_pending_advances(内存世界;20000 行)',
      '旧批次重放安全(',
    ],
    mustKill: ['compaction_lease_blocks_region_open_during_p2'],
  },
  {
    id: 'concurrent_compaction_allowed',
    clause: '同一时刻只允许一个压缩',
    edits: [swap('src/rsi/store/seal.ts', "if (this.compacting) return 'busy';", '')],
    tests: ['rsi/store/compactor.test.ts'],
    expectRed: [
      'compaction_lease_blocks_region_open_during_p2',
      'Compactor 推进(',
      'compact_blocked 与零写入拒绝(',
      '压缩租约(P2 期间不许新开区域)',
      'compact_recovery_audit_full_ledger_pending_advances(内存世界;20000 行)',
      '旧批次重放安全(',
    ],
    mustKill: ['compaction_lease_blocks_region_open_during_p2'],
  },
  {
    id: 'lease_ignores_open_region',
    clause: '已有未关闭区域 = region_open',
    edits: [swap('src/rsi/store/seal.ts', 'this.assertNoOpenRegion();', '')],
    tests: ['rsi/store/compactor.test.ts'],
    expectRed: [
      'region_open:有未关闭的区域',
      'Compactor 推进(',
      'compact_blocked 与零写入拒绝(',
      '压缩租约(P2 期间不许新开区域)',
      'compact_recovery_audit_full_ledger_pending_advances(内存世界;20000 行)',
      '旧批次重放安全(',
    ],
    mustKill: ['region_open:有未关闭的区域'],
  },
  {
    id: 'p1_recheck_skipped',
    clause: 'P1 在 txn2 复核(恢复之后同一纯判据)',
    edits: [
      swap(
        'src/rsi/store/compactor.ts',
        'if (failed.length > 0) return blocked((failed[0] as { cause: StoreCause }).cause, failed);',
        '',
      ),
    ],
    tests: ['rsi/store/compactor.test.ts'],
    expectRed: [
      'p1_recheck_after_recovery_blocks_lying_recovery',
      'Compactor 推进(',
      'compact_blocked 与零写入拒绝(',
      '压缩租约(P2 期间不许新开区域)',
      'compact_recovery_audit_full_ledger_pending_advances(内存世界;20000 行)',
      '旧批次重放安全(',
    ],
    mustKill: ['p1_recheck_after_recovery_blocks_lying_recovery'],
  },
  {
    id: 'blocked_ignored_after_recovery',
    clause: '任一 ledger_not_committed = 不推进并返回 compact_blocked',
    edits: [swap('src/rsi/store/compactor.ts', 'if (bad.length > 0) {', 'if (bad.length > 99) {')],
    tests: ['rsi/store/compactor.test.ts', 'rsi/store/compactor-crash.test.ts'],
    expectRed: [
      'compact_recovery_ledger_not_committed_blocks',
      '账永久硬线满',
      '压缩前恢复的账提交 ENOSPC',
      'Compactor 推进(',
      'compact_blocked 与零写入拒绝(',
      '压缩租约(P2 期间不许新开区域)',
      'compact_recovery_audit_full_ledger_pending_advances(内存世界;20000 行)',
      '旧批次重放安全(',
      'P0 / P1 前:读故障与恢复提交失败(',
      'P2 提交点之前失败(',
      'P2 之后、P3 之前(rename 已落进程死)(',
      'P3 失败:提交点已过,不抛,记入 cleanup(',
      'P4 失败:记入 cleanup,惰性续做(',
      '崩溃重入:同一输入连续两次故障再收敛(',
    ],
    mustKill: ['compact_recovery_ledger_not_committed_blocks'],
  },
  {
    id: 'blocked_thrown',
    clause: 'compact_blocked 是返回值不是异常',
    edits: [
      swap(
        'src/rsi/store/compactor.ts',
        'return blocked((rows[0] as { cause: StoreCause }).cause, rows);',
        "throw new StoreError('compact_blocked');",
      ),
    ],
    tests: ['rsi/store/compactor.test.ts', 'rsi/store/compactor-crash.test.ts'],
    expectRed: [
      'compact_recovery_ledger_not_committed_blocks',
      '压缩前恢复的账提交 ENOSPC',
      'Compactor 推进(',
      'compact_blocked 与零写入拒绝(',
      '压缩租约(P2 期间不许新开区域)',
      'compact_recovery_audit_full_ledger_pending_advances(内存世界;20000 行)',
      '旧批次重放安全(',
      'P0 / P1 前:读故障与恢复提交失败(',
      'P2 提交点之前失败(',
      'P2 之后、P3 之前(rename 已落进程死)(',
      'P3 失败:提交点已过,不抛,记入 cleanup(',
      'P4 失败:记入 cleanup,惰性续做(',
      '崩溃重入:同一输入连续两次故障再收敛(',
    ],
    mustKill: ['compact_recovery_ledger_not_committed_blocks'],
  },
  {
    id: 'recovery_for_all_batches',
    clause: '只对 P1 判据未满足的批次调恢复',
    edits: [
      swap(
        'src/rsi/store/compactor.ts',
        'const unsatisfied = batches.filter((b) => !checkBatch(snap.ledger, b, today).ok);',
        'const unsatisfied = [...batches];',
      ),
    ],
    tests: ['rsi/store/compactor-crash.test.ts'],
    expectRed: [
      '压缩文件不存在、审计字节不变、tmp 已清',
      'P0 / P1 前:读故障与恢复提交失败(',
      'P2 提交点之前失败(',
      'P2 之后、P3 之前(rename 已落进程死)(',
      'P3 失败:提交点已过,不抛,记入 cleanup(',
      'P4 失败:记入 cleanup,惰性续做(',
      '崩溃重入:同一输入连续两次故障再收敛(',
    ],
    mustKill: ['压缩文件不存在、审计字节不变、tmp 已清'],
  },
  {
    id: 'p2_gen_not_incremented',
    clause: 'P2 gen + 1',
    edits: [swap('src/rsi/store/compactor.ts', 'gen: (cur?.gen ?? 0) + 1,', 'gen: cur?.gen ?? 1,')],
    tests: ['rsi/store/compactor.test.ts'],
    expectRed: [
      'months_interval_disjoint_across_runs',
      'Compactor 推进(',
      'compact_blocked 与零写入拒绝(',
      '压缩租约(P2 期间不许新开区域)',
      'compact_recovery_audit_full_ledger_pending_advances(内存世界;20000 行)',
      '旧批次重放安全(',
    ],
    mustKill: ['months_interval_disjoint_across_runs'],
  },
  {
    id: 'p2_through_wrong',
    clause: 'P2 写 through = 新 W',
    edits: [
      swap(
        'src/rsi/store/compactor.ts',
        'gen: (cur?.gen ?? 0) + 1,\n        through: target,',
        "gen: (cur?.gen ?? 0) + 1,\n        through: wOld ?? '1970-01-01',",
      ),
    ],
    tests: ['rsi/store/compactor.test.ts'],
    expectRed: [
      'P1–P4 端到端',
      'Compactor 推进(',
      'compact_blocked 与零写入拒绝(',
      '压缩租约(P2 期间不许新开区域)',
      'compact_recovery_audit_full_ledger_pending_advances(内存世界;20000 行)',
      '旧批次重放安全(',
    ],
    mustKill: ['P1–P4 端到端'],
  },
  {
    id: 'months_not_merged',
    clause: '汇总增量并入既有 months',
    edits: [
      swap(
        'src/rsi/store/compactor.ts',
        'months: mergeMonths(cur?.months ?? {}, count.months),',
        'months: mergeMonths({}, count.months),',
      ),
    ],
    tests: ['rsi/store/compactor.test.ts'],
    expectRed: [
      'months_interval_disjoint_across_runs',
      'Compactor 推进(',
      'compact_blocked 与零写入拒绝(',
      '压缩租约(P2 期间不许新开区域)',
      'compact_recovery_audit_full_ledger_pending_advances(内存世界;20000 行)',
      '旧批次重放安全(',
    ],
    mustKill: ['months_interval_disjoint_across_runs'],
  },
  {
    id: 'p3_skipped',
    clause: 'P3 去掉 ≤ W 的行',
    edits: [
      swap(
        'src/rsi/store/compactor.ts',
        'await p.auditAppend.rewrite(keepAfter(au.lines, au.cls.rows, w));',
        'void 0;',
      ),
    ],
    tests: ['rsi/store/compactor.test.ts'],
    expectRed: [
      'P1–P4 端到端',
      'Compactor 推进(',
      'compact_blocked 与零写入拒绝(',
      '压缩租约(P2 期间不许新开区域)',
      'compact_recovery_audit_full_ledger_pending_advances(内存世界;20000 行)',
      '旧批次重放安全(',
    ],
    mustKill: ['P1–P4 端到端'],
  },
  {
    id: 'p3_keeps_w_day',
    clause: 'P3 删除日 ≤ W(含 W 当日)',
    edits: [
      swap(
        'src/rsi/store/compact-plan.ts',
        'dayOf(rows[i] as RsiAuditLine) > w',
        'dayOf(rows[i] as RsiAuditLine) >= w',
      ),
    ],
    tests: ['rsi/store/compact-plan.test.ts'],
    expectRed: [
      'keepAfter:日 == W 的行被删',
      'pickTarget(目标选择)',
      'checkBatch(P1 账判据:按状态判,不按键判)',
      'countInterval(区间完备证明里的计数与去重)',
      'mergeMonths / keepAfter / pruneLedger',
    ],
    mustKill: ['keepAfter:日 == W 的行被删'],
  },
  {
    id: 'p4_skipped',
    clause: 'P4 裁过期冷却与 ≤ W 的键',
    edits: [
      swap(
        'src/rsi/store/compactor.ts',
        'const next = pruneLedger(await p.ledgerWrite.read(), today, w);',
        'const next: ReturnType<typeof pruneLedger> = null;',
      ),
    ],
    tests: ['rsi/store/compactor.test.ts'],
    expectRed: [
      'P1–P4 端到端',
      'Compactor 推进(',
      'compact_blocked 与零写入拒绝(',
      '压缩租约(P2 期间不许新开区域)',
      'compact_recovery_audit_full_ledger_pending_advances(内存世界;20000 行)',
      '旧批次重放安全(',
    ],
    mustKill: ['P1–P4 端到端'],
  },
  {
    id: 'p4_ignores_watermark',
    clause: 'P4 裁 ≤ W 的 applied 键',
    edits: [
      swap(
        'src/rsi/store/compact-plan.ts',
        'finalize(beginWorking(base), { today, watermark: w })',
        'finalize(beginWorking(base), { today, watermark: null })',
      ),
    ],
    tests: ['rsi/store/compact-plan.test.ts'],
    expectRed: [
      'pruneLedger:裁过期冷却',
      'pickTarget(目标选择)',
      'checkBatch(P1 账判据:按状态判,不按键判)',
      'countInterval(区间完备证明里的计数与去重)',
      'mergeMonths / keepAfter / pruneLedger',
    ],
    mustKill: ['pruneLedger:裁过期冷却'],
  },
  {
    id: 'cleanup_errors_thrown',
    clause: 'P2 之后 P3 / P4 失败不抛、记入 cleanup',
    edits: [swap('src/rsi/store/compactor.ts', 'out.cause ??= causeOf(e);', 'throw e;')],
    tests: ['rsi/store/compactor-crash.test.ts'],
    expectRed: [
      '审计残留行原样;重启后续删且 months / gen 不变',
      'P0 / P1 前:读故障与恢复提交失败(',
      'P2 提交点之前失败(',
      'P2 之后、P3 之前(rename 已落进程死)(',
      'P3 失败:提交点已过,不抛,记入 cleanup(',
      'P4 失败:记入 cleanup,惰性续做(',
      '崩溃重入:同一输入连续两次故障再收敛(',
    ],
    mustKill: ['审计残留行原样;重启后续删且 months / gen 不变'],
  },
  {
    id: 'lock_error_swallowed',
    clause: '锁丢失必须上抛',
    edits: [swap('src/rsi/store/compactor.ts', 'if (e instanceof RsiLockError) throw e;', '')],
    tests: ['rsi/store/compactor.test.ts'],
    expectRed: [
      'lock_lost_after_p2_propagates',
      'Compactor 推进(',
      'compact_blocked 与零写入拒绝(',
      '压缩租约(P2 期间不许新开区域)',
      'compact_recovery_audit_full_ledger_pending_advances(内存世界;20000 行)',
      '旧批次重放安全(',
    ],
    mustKill: ['lock_lost_after_p2_propagates'],
  },
  {
    id: 'noop_cleanup_dropped',
    clause: '无新目标时仍续做 P3 / P4',
    edits: [
      swap(
        'src/rsi/store/compactor.ts',
        'const cleanup = await deps.held.transaction((p) => cleanupSteps(p, wOld, today));',
        "const cleanup: CompactCleanup = { audit: 'none', ledger: 'none' };",
      ),
    ],
    tests: ['rsi/store/compactor.test.ts', 'rsi/store/compactor-crash.test.ts'],
    expectRed: [
      'cold_replay_cooldown_not_restarted',
      '压缩文件已是 gen 1 而审计 / 账仍未清',
      'Compactor 推进(',
      'compact_blocked 与零写入拒绝(',
      '压缩租约(P2 期间不许新开区域)',
      'compact_recovery_audit_full_ledger_pending_advances(内存世界;20000 行)',
      '旧批次重放安全(',
      'P0 / P1 前:读故障与恢复提交失败(',
      'P2 提交点之前失败(',
      'P2 之后、P3 之前(rename 已落进程死)(',
      'P3 失败:提交点已过,不抛,记入 cleanup(',
      'P4 失败:记入 cleanup,惰性续做(',
      '崩溃重入:同一输入连续两次故障再收敛(',
    ],
    mustKill: ['cold_replay_cooldown_not_restarted'],
  },
  {
    id: 'torn_tail_resume_dropped',
    clause: '撕裂尾由续做路径去掉',
    edits: [swap('src/rsi/store/compactor.ts', "au.cls.kind === 'torn_tail' || ", '')],
    tests: ['rsi/store/compactor.test.ts'],
    expectRed: [
      'torn_tail_resume_without_residual',
      'Compactor 推进(',
      'compact_blocked 与零写入拒绝(',
      '压缩租约(P2 期间不许新开区域)',
      'compact_recovery_audit_full_ledger_pending_advances(内存世界;20000 行)',
      '旧批次重放安全(',
    ],
    mustKill: ['torn_tail_resume_without_residual'],
  },
  {
    id: 'explicit_target_ignored',
    clause: '显式目标',
    edits: [
      swap(
        'src/rsi/store/compactor.ts',
        'const target = pickTarget(snap.au.cls.rows, wOld, today, opts.through);',
        'const target = pickTarget(snap.au.cls.rows, wOld, today);',
      ),
    ],
    tests: ['rsi/store/compactor.test.ts'],
    expectRed: [
      'P1–P4 端到端',
      'Compactor 推进(',
      'compact_blocked 与零写入拒绝(',
      '压缩租约(P2 期间不许新开区域)',
      'compact_recovery_audit_full_ledger_pending_advances(内存世界;20000 行)',
      '旧批次重放安全(',
    ],
    mustKill: ['P1–P4 端到端'],
  },
  {
    id: 'target_age_strict',
    clause: '年龄触发含边界当日',
    edits: [
      swap(
        'src/rsi/store/compact-plan.ts',
        '(days[0] as string) <= cutoff',
        '(days[0] as string) < cutoff',
      ),
    ],
    tests: ['rsi/store/compact-plan.test.ts'],
    expectRed: [
      '年龄触发:存在日 ≤ 今日 − 365',
      'pickTarget(目标选择)',
      'checkBatch(P1 账判据:按状态判,不按键判)',
      'countInterval(区间完备证明里的计数与去重)',
      'mergeMonths / keepAfter / pruneLedger',
    ],
    mustKill: ['年龄触发:存在日 ≤ 今日 − 365'],
  },
  {
    id: 'target_capacity_gte',
    clause: '容量触发 > 18000',
    edits: [
      swap(
        'src/rsi/store/compact-plan.ts',
        'if (days.length > RSI_COMPACT_POLICY.highLines) {',
        'if (days.length >= RSI_COMPACT_POLICY.highLines) {',
      ),
    ],
    tests: ['rsi/store/compact-plan.test.ts'],
    expectRed: [
      '容量触发:恰好 18000 行不触发',
      'pickTarget(目标选择)',
      'checkBatch(P1 账判据:按状态判,不按键判)',
      'countInterval(区间完备证明里的计数与去重)',
      'mergeMonths / keepAfter / pruneLedger',
    ],
    mustKill: ['容量触发:恰好 18000 行不触发'],
  },
  {
    id: 'target_not_before_today',
    clause: '目标须严格早于今日且大于 W',
    edits: [
      swap(
        'src/rsi/store/compact-plan.ts',
        'if (target === null || !(target < today) || !beyondW(target)) return null;',
        'if (target === null) return null;',
      ),
    ],
    tests: ['rsi/store/compact-plan.test.ts'],
    expectRed: [
      '目标须严格早于今日',
      '目标须严格大于现有 W',
      'pickTarget(目标选择)',
      'checkBatch(P1 账判据:按状态判,不按键判)',
      'countInterval(区间完备证明里的计数与去重)',
      'mergeMonths / keepAfter / pruneLedger',
    ],
    mustKill: ['目标须严格早于今日'],
  },
  {
    id: 'target_explicit_today_ok',
    clause: '显式目标须早于今日',
    edits: [
      swap(
        'src/rsi/store/compact-plan.ts',
        "if (!(explicit < today)) throw new StoreError('out_of_range', `target:${explicit}`);",
        '',
      ),
    ],
    tests: ['rsi/store/compact-plan.test.ts', 'rsi/store/compactor.test.ts'],
    expectRed: [
      '显式目标:≥ 今日 = out_of_range',
      '显式目标 ≥ 今日 = out_of_range',
      'pickTarget(目标选择)',
      'checkBatch(P1 账判据:按状态判,不按键判)',
      'countInterval(区间完备证明里的计数与去重)',
      'mergeMonths / keepAfter / pruneLedger',
      'Compactor 推进(',
      'compact_blocked 与零写入拒绝(',
      '压缩租约(P2 期间不许新开区域)',
      'compact_recovery_audit_full_ledger_pending_advances(内存世界;20000 行)',
      '旧批次重放安全(',
    ],
    mustKill: ['显式目标:≥ 今日 = out_of_range'],
  },
  {
    id: 'target_explicit_regress',
    clause: '显式目标须大于 W',
    edits: [
      swap(
        'src/rsi/store/compact-plan.ts',
        'return beyondW(explicit) ? explicit : null;',
        'return explicit;',
      ),
    ],
    tests: ['rsi/store/compact-plan.test.ts'],
    expectRed: [
      '显式目标:≥ 今日 = out_of_range',
      'pickTarget(目标选择)',
      'checkBatch(P1 账判据:按状态判,不按键判)',
      'countInterval(区间完备证明里的计数与去重)',
      'mergeMonths / keepAfter / pruneLedger',
    ],
    mustKill: ['显式目标:≥ 今日 = out_of_range'],
  },
  {
    id: 'target_counts_residual',
    clause: '≤ W 的残留行不参与目标选择',
    edits: [
      swap(
        'src/rsi/store/compact-plan.ts',
        'const days = rows.map(dayOf).filter(beyondW).sort();',
        'const days = rows.map(dayOf).sort();',
      ),
    ],
    tests: ['rsi/store/compact-plan.test.ts'],
    expectRed: [
      '目标须严格大于现有 W',
      'pickTarget(目标选择)',
      'checkBatch(P1 账判据:按状态判,不按键判)',
      'countInterval(区间完备证明里的计数与去重)',
      'mergeMonths / keepAfter / pruneLedger',
    ],
    mustKill: ['目标须严格大于现有 W'],
  },
  {
    id: 'dedup_derived_counted_twice',
    clause: '文件已有同键行的派生事件不再计 derived_missing',
    edits: [swap('src/rsi/store/compact-plan.ts', 'if (i.byKey.has(key)) continue;', '')],
    tests: ['rsi/store/compact-plan.test.ts', 'rsi/store/compactor.test.ts'],
    expectRed: [
      'months_dedup_file_row_and_derived_same_key_counts_once',
      'months_dedup:文件里已有创建行',
      'pickTarget(目标选择)',
      'checkBatch(P1 账判据:按状态判,不按键判)',
      'countInterval(区间完备证明里的计数与去重)',
      'mergeMonths / keepAfter / pruneLedger',
      'Compactor 推进(',
      'compact_blocked 与零写入拒绝(',
      '压缩租约(P2 期间不许新开区域)',
      'compact_recovery_audit_full_ledger_pending_advances(内存世界;20000 行)',
      '旧批次重放安全(',
    ],
    mustKill: ['months_dedup_file_row_and_derived_same_key_counts_once'],
  },
  {
    id: 'conflict_unchecked',
    clause: '同键整行比较(含 at),不等 = AuditKeyConflict',
    edits: [
      swap(
        'src/rsi/store/compact-plan.ts',
        'if (have !== undefined && !sameRowForKey(have, d.row)) throw new AuditKeyConflict(key);',
        '',
      ),
    ],
    tests: ['rsi/store/compact-plan.test.ts', 'rsi/store/compactor.test.ts'],
    expectRed: [
      'e_d_content_mismatch_refuses_advance',
      '同键内容不等 = audit_key_conflict',
      'pickTarget(目标选择)',
      'checkBatch(P1 账判据:按状态判,不按键判)',
      'countInterval(区间完备证明里的计数与去重)',
      'mergeMonths / keepAfter / pruneLedger',
      'Compactor 推进(',
      'compact_blocked 与零写入拒绝(',
      '压缩租约(P2 期间不许新开区域)',
      'compact_recovery_audit_full_ledger_pending_advances(内存世界;20000 行)',
      '旧批次重放安全(',
    ],
    mustKill: ['e_d_content_mismatch_refuses_advance'],
  },
  {
    id: 'interval_includes_old',
    clause: '区间 (W_old, W_new]',
    edits: [
      swap(
        'src/rsi/store/compact-plan.ts',
        'const inInterval = (d: UtcDay): boolean => d <= i.wNew && (i.wOld === null || d > i.wOld);',
        'const inInterval = (d: UtcDay): boolean => d <= i.wNew;',
      ),
    ],
    tests: ['rsi/store/compact-plan.test.ts', 'rsi/store/compactor.test.ts'],
    expectRed: [
      'months_interval_disjoint_across_runs:只数',
      'months_interval_disjoint_across_runs:第二次只数',
      'pickTarget(目标选择)',
      'checkBatch(P1 账判据:按状态判,不按键判)',
      'countInterval(区间完备证明里的计数与去重)',
      'mergeMonths / keepAfter / pruneLedger',
      'Compactor 推进(',
      'compact_blocked 与零写入拒绝(',
      '压缩租约(P2 期间不许新开区域)',
      'compact_recovery_audit_full_ledger_pending_advances(内存世界;20000 行)',
      '旧批次重放安全(',
    ],
    mustKill: ['months_interval_disjoint_across_runs:只数'],
  },
  {
    id: 'interval_excludes_w_day',
    clause: 'W 当日计入区间',
    edits: [swap('src/rsi/store/compact-plan.ts', 'd <= i.wNew &&', 'd < i.wNew &&')],
    tests: ['rsi/store/compact-plan.test.ts'],
    expectRed: [
      'months_interval_disjoint_across_runs:只数',
      'pickTarget(目标选择)',
      'checkBatch(P1 账判据:按状态判,不按键判)',
      'countInterval(区间完备证明里的计数与去重)',
      'mergeMonths / keepAfter / pruneLedger',
    ],
    mustKill: ['months_interval_disjoint_across_runs:只数'],
  },
  {
    id: 'unkeyed_rows_not_counted',
    clause: '无键行在文件里按行计 deleted',
    edits: [
      swap(
        'src/rsi/store/compact-plan.ts',
        "for (const r of i.rows) if (inInterval(dayOf(r))) bump(r, 'deleted');",
        "for (const r of i.rows) if (r.idem_key !== undefined && inInterval(dayOf(r))) bump(r, 'deleted');",
      ),
    ],
    tests: ['rsi/store/compact-plan.test.ts', 'rsi/store/compactor.test.ts'],
    expectRed: [
      '无键行(R8)只属文件侧',
      'r5_r8_lost_never_counted',
      'pickTarget(目标选择)',
      'checkBatch(P1 账判据:按状态判,不按键判)',
      'countInterval(区间完备证明里的计数与去重)',
      'mergeMonths / keepAfter / pruneLedger',
      'Compactor 推进(',
      'compact_blocked 与零写入拒绝(',
      '压缩租约(P2 期间不许新开区域)',
      'compact_recovery_audit_full_ledger_pending_advances(内存世界;20000 行)',
      '旧批次重放安全(',
    ],
    mustKill: ['无键行(R8)只属文件侧'],
  },
  {
    id: 'transition_unknown_bucket_dropped',
    clause: '缺 to 的 transition 行落固定桶 unknown',
    edits: [
      swap(
        'src/rsi/store/compact-plan.ts',
        "const to = r.to ?? 'unknown';",
        "const to = r.to ?? '';",
      ),
    ],
    tests: ['rsi/store/compact-plan.test.ts'],
    expectRed: [
      '缺 to 的 transition 行落入固定桶 unknown',
      'pickTarget(目标选择)',
      'checkBatch(P1 账判据:按状态判,不按键判)',
      'countInterval(区间完备证明里的计数与去重)',
      'mergeMonths / keepAfter / pruneLedger',
    ],
    mustKill: ['缺 to 的 transition 行落入固定桶 unknown'],
  },
  {
    id: 'merge_lines_not_sum',
    clause: 'lines = deleted + derived_missing',
    edits: [
      swap(
        'src/rsi/store/compact-plan.ts',
        'm.lines = m.deleted + m.derived_missing;',
        'm.lines += d.deleted;',
      ),
    ],
    tests: ['rsi/store/compact-plan.test.ts'],
    expectRed: [
      'mergeMonths:逐月累加',
      'pickTarget(目标选择)',
      'checkBatch(P1 账判据:按状态判,不按键判)',
      'countInterval(区间完备证明里的计数与去重)',
      'mergeMonths / keepAfter / pruneLedger',
    ],
    mustKill: ['mergeMonths:逐月累加'],
  },
  {
    id: 'entry_without_derived_ignored',
    clause: '每个 lifecycle 条目必须有派生行',
    edits: [
      swap(
        'src/rsi/store/compact-plan.ts',
        "if (!byKey.has(e.idem_key))\n      throw new StoreError('compact_blocked', `entry_not_derived:${e.id}`);",
        '',
      ),
    ],
    tests: ['rsi/store/compact-plan.test.ts', 'rsi/store/compactor.test.ts'],
    expectRed: [
      '权威侧跨信任边界',
      '权威源不自洽',
      'pickTarget(目标选择)',
      'checkBatch(P1 账判据:按状态判,不按键判)',
      'countInterval(区间完备证明里的计数与去重)',
      'mergeMonths / keepAfter / pruneLedger',
      'Compactor 推进(',
      'compact_blocked 与零写入拒绝(',
      '压缩租约(P2 期间不许新开区域)',
      'compact_recovery_audit_full_ledger_pending_advances(内存世界;20000 行)',
      '旧批次重放安全(',
    ],
    mustKill: ['权威侧跨信任边界'],
  },
  {
    id: 'derived_dup_key_ignored',
    clause: '派生键唯一',
    edits: [
      swap(
        'src/rsi/store/compact-plan.ts',
        "if (byKey.has(d.idem_key)) throw new StoreError('audit_dup_key', `derived:${d.idem_key}`);",
        '',
      ),
    ],
    tests: ['rsi/store/compact-plan.test.ts'],
    expectRed: [
      '权威侧跨信任边界',
      'pickTarget(目标选择)',
      'checkBatch(P1 账判据:按状态判,不按键判)',
      'countInterval(区间完备证明里的计数与去重)',
      'mergeMonths / keepAfter / pruneLedger',
    ],
    mustKill: ['权威侧跨信任边界'],
  },
  {
    id: 'derived_beyond_w_ignored',
    clause: '派生行日期 ≤ W_new',
    edits: [
      swap(
        'src/rsi/store/compact-plan.ts',
        "if (dayOf(p.data) > i.wNew) throw new StoreError('out_of_range', `derived:${d.idem_key}`);",
        '',
      ),
    ],
    tests: ['rsi/store/compact-plan.test.ts'],
    expectRed: [
      '权威侧跨信任边界',
      'pickTarget(目标选择)',
      'checkBatch(P1 账判据:按状态判,不按键判)',
      'countInterval(区间完备证明里的计数与去重)',
      'mergeMonths / keepAfter / pruneLedger',
    ],
    mustKill: ['权威侧跨信任边界'],
  },
  {
    id: 'derived_row_unvalidated',
    clause: '派生行跨信任边界校验',
    edits: [
      swap(
        'src/rsi/store/compact-plan.ts',
        'if (!p.success || p.data.idem_key !== d.idem_key) {',
        'if (false as boolean) {',
      ),
    ],
    tests: ['rsi/store/compact-plan.test.ts'],
    expectRed: [
      '权威侧跨信任边界',
      'pickTarget(目标选择)',
      'checkBatch(P1 账判据:按状态判,不按键判)',
      'countInterval(区间完备证明里的计数与去重)',
      'mergeMonths / keepAfter / pruneLedger',
    ],
    mustKill: ['权威侧跨信任边界'],
  },
  {
    id: 'resolve_locator_unchecked',
    clause: 'resolve 校验 locator 种类',
    edits: [
      swap(
        'src/rsi/store/reconcile-source.ts',
        "if (!LOCATOR_KINDS.includes(locator.kind) || locator.ref === '') return null;",
        '',
      ),
    ],
    tests: ['rsi/store/reconcile-source.test.ts'],
    expectRed: [
      '按 idem_key 取回条目行与保护标记行',
      'derivedThrough(R1–R4 条目行 + R7 保护标记行)',
      'entriesThrough',
      'batchesThrough(E2 终态批次 / E1 即时否决)',
      'event_time_missing:有账效果却没有权威事件时间 = fail-closed(不跳过、不拿 now 补)',
      'resolve(权威事件取回:每次重读,不缓存)',
      '读失败 / 记录不合规:一律抛,不得以空集通过',
    ],
    mustKill: ['按 idem_key 取回条目行与保护标记行'],
  },
  {
    id: 'derived_skips_marks',
    clause: 'R7 保护标记行来自终态记录',
    edits: [
      swap(
        'src/rsi/store/reconcile-source.ts',
        "if (e.type !== 'protection_mark') continue;",
        'continue;',
      ),
    ],
    tests: ['rsi/store/reconcile-source.test.ts'],
    expectRed: [
      'R7:终态记录的保护标记行',
      'derivedThrough(R1–R4 条目行 + R7 保护标记行)',
      'entriesThrough',
      'batchesThrough(E2 终态批次 / E1 即时否决)',
      'event_time_missing:有账效果却没有权威事件时间 = fail-closed(不跳过、不拿 now 补)',
      'resolve(权威事件取回:每次重读,不缓存)',
      '读失败 / 记录不合规:一律抛,不得以空集通过',
    ],
    mustKill: ['R7:终态记录的保护标记行'],
  },
  {
    id: 'derived_ignores_w',
    clause: '派生行只含日期 ≤ W',
    edits: [
      swap(
        'src/rsi/store/reconcile-source.ts',
        'for (const d of derivedOf(rec)) if (utcDay(d.row.at) <= W) out.push(d);',
        'for (const d of derivedOf(rec)) out.push(d);',
      ),
    ],
    tests: ['rsi/store/reconcile-source.test.ts'],
    expectRed: [
      '终态记录:每个条目一行',
      'derivedThrough(R1–R4 条目行 + R7 保护标记行)',
      'entriesThrough',
      'batchesThrough(E2 终态批次 / E1 即时否决)',
      'event_time_missing:有账效果却没有权威事件时间 = fail-closed(不跳过、不拿 now 补)',
      'resolve(权威事件取回:每次重读,不缓存)',
      '读失败 / 记录不合规:一律抛,不得以空集通过',
    ],
    mustKill: ['终态记录:每个条目一行'],
  },
  {
    id: 'entries_ignore_w',
    clause: '条目只含日期 ≤ W',
    edits: [
      swap(
        'src/rsi/store/reconcile-source.ts',
        'if (utcDay(e.at) <= W) out.push({ id: rec.id, idem_key: e.idem_key, at: e.at });',
        'out.push({ id: rec.id, idem_key: e.idem_key, at: e.at });',
      ),
    ],
    tests: ['rsi/store/reconcile-source.test.ts'],
    expectRed: [
      '留存条目 {id, idem_key, at}',
      'derivedThrough(R1–R4 条目行 + R7 保护标记行)',
      'entriesThrough',
      'batchesThrough(E2 终态批次 / E1 即时否决)',
      'event_time_missing:有账效果却没有权威事件时间 = fail-closed(不跳过、不拿 now 补)',
      'resolve(权威事件取回:每次重读,不缓存)',
      '读失败 / 记录不合规:一律抛,不得以空集通过',
    ],
    mustKill: ['留存条目 {id, idem_key, at}'],
  },
  {
    id: 'batches_ignore_w',
    clause: '批次只含事件日 ≤ W(否则 recoverThrough 整个拒绝)',
    edits: [
      swap(
        'src/rsi/store/reconcile-source.ts',
        'if (effects.length > 0 && at !== undefined && utcDay(at) <= W) {',
        'if (effects.length > 0 && at !== undefined) {',
      ),
    ],
    tests: ['rsi/store/reconcile-source.test.ts'],
    expectRed: [
      'E2:键 terminal:<id>:<sha>',
      'derivedThrough(R1–R4 条目行 + R7 保护标记行)',
      'entriesThrough',
      'batchesThrough(E2 终态批次 / E1 即时否决)',
      'event_time_missing:有账效果却没有权威事件时间 = fail-closed(不跳过、不拿 now 补)',
      'resolve(权威事件取回:每次重读,不缓存)',
      '读失败 / 记录不合规:一律抛,不得以空集通过',
    ],
    mustKill: ['E2:键 terminal:<id>:<sha>'],
  },
  {
    id: 'e1_ignores_reason',
    clause: 'E1 只对 vetoed 的 rolling_back',
    edits: [
      swap(
        'src/rsi/store/reconcile-source.ts',
        "rec.lifecycle === 'rolling_back' && rec.rollback?.reason === 'vetoed'",
        "rec.lifecycle === 'rolling_back'",
      ),
    ],
    tests: ['rsi/store/reconcile-source.test.ts'],
    expectRed: [
      'E1:rolling_back 且原因 vetoed',
      'derivedThrough(R1–R4 条目行 + R7 保护标记行)',
      'entriesThrough',
      'batchesThrough(E2 终态批次 / E1 即时否决)',
      'event_time_missing:有账效果却没有权威事件时间 = fail-closed(不跳过、不拿 now 补)',
      'resolve(权威事件取回:每次重读,不缓存)',
      '读失败 / 记录不合规:一律抛,不得以空集通过',
    ],
    mustKill: ['E1:rolling_back 且原因 vetoed'],
  },
  {
    id: 'records_error_swallowed',
    clause: '读失败 / 记录读不到 = 抛',
    edits: [
      swap(
        'src/rsi/store/reconcile-source.ts',
        "if (r.kind !== 'ok') throw new StoreError('store_io', `records_${r.kind}`);",
        '',
      ),
    ],
    tests: ['rsi/store/reconcile-source.test.ts'],
    expectRed: [
      '读不到(kind != ok)= store_io',
      'derivedThrough(R1–R4 条目行 + R7 保护标记行)',
      'entriesThrough',
      'batchesThrough(E2 终态批次 / E1 即时否决)',
      'event_time_missing:有账效果却没有权威事件时间 = fail-closed(不跳过、不拿 now 补)',
      'resolve(权威事件取回:每次重读,不缓存)',
      '读失败 / 记录不合规:一律抛,不得以空集通过',
    ],
    mustKill: ['读不到(kind != ok)= store_io'],
  },
  {
    id: 'record_invalid_skipped',
    clause: '记录不合规 = state_invalid',
    edits: [
      swap(
        'src/rsi/store/reconcile-source.ts',
        "if (!p.success) throw new StoreError('state_invalid', 'record_invalid');",
        'if (!p.success) continue;',
      ),
    ],
    tests: ['rsi/store/reconcile-source.test.ts'],
    expectRed: [
      '读不到(kind != ok)= store_io',
      'derivedThrough(R1–R4 条目行 + R7 保护标记行)',
      'entriesThrough',
      'batchesThrough(E2 终态批次 / E1 即时否决)',
      'event_time_missing:有账效果却没有权威事件时间 = fail-closed(不跳过、不拿 now 补)',
      'resolve(权威事件取回:每次重读,不缓存)',
      '读失败 / 记录不合规:一律抛,不得以空集通过',
    ],
    mustKill: ['读不到(kind != ok)= store_io'],
  },
  {
    id: 'compaction_port_untracked',
    clause: '压缩端口绑定事务 token',
    edits: [
      swap(
        'src/rsi/store/txn.ts',
        'commit: (next) => track(() => deps.backend.writeCompaction(next, assertBoth)),',
        'commit: (next) => deps.backend.writeCompaction(next, assertBoth),',
      ),
    ],
    tests: ['rsi/store/compactor.test.ts'],
    expectRed: [
      'compaction_port_escape_after_txn_refused',
      'Compactor 推进(',
      'compact_blocked 与零写入拒绝(',
      '压缩租约(P2 期间不许新开区域)',
      'compact_recovery_audit_full_ledger_pending_advances(内存世界;20000 行)',
      '旧批次重放安全(',
    ],
    mustKill: ['compaction_port_escape_after_txn_refused'],
  },
  {
    id: 'store_compactor_foreign_registry',
    clause: 'compactor 与 seal 共用注册表',
    edits: [
      swap(
        'src/rsi/store/compactor.ts',
        "import type { SealRegistry } from './seal.js';",
        "import { SealRegistry } from './seal.js';",
      ),
      swap(
        'src/rsi/store/compactor.ts',
        '    registry: store.registry,',
        '    registry: new SealRegistry(),',
      ),
    ],
    tests: ['rsi/store/compactor.test.ts'],
    expectRed: [
      'compactorOf 造的 compactor',
      'compactorOf 装配完整性(',
      'Compactor 推进(',
      'compact_blocked 与零写入拒绝(',
      '压缩租约(P2 期间不许新开区域)',
      'compact_recovery_audit_full_ledger_pending_advances(内存世界;20000 行)',
      '旧批次重放安全(',
    ],
    mustKill: ['compactorOf 造的 compactor'],
  },
  {
    id: 'report_residual_not_filtered',
    clause: 'P2 与 P3 之间残留行(≤ W)不计',
    edits: [
      swap(
        'src/rsi/auto/read/report.ts',
        'lines: parsed.lines.filter((l) => utcDay(new Date(Date.parse(l.at))) > through),',
        'lines: parsed.lines,',
      ),
    ],
    tests: ['rsi/auto/report-compaction.test.ts'],
    expectRed: ['report_between_p2_p3_no_double_count', '压缩后的审计口径', 'gen 双读'],
    mustKill: ['report_between_p2_p3_no_double_count'],
  },
  {
    id: 'report_prior_with_watermark',
    clause: '压缩后审计为空 / 缺失不误退 3',
    edits: [
      swap('src/rsi/auto/read/report.ts', 'if (through === null) {', 'if (true as boolean) {'),
    ],
    tests: ['rsi/auto/report-compaction.test.ts'],
    expectRed: ['report_empty_after_compaction_exit0', '压缩后的审计口径', 'gen 双读'],
    mustKill: ['report_empty_after_compaction_exit0'],
  },
  {
    id: 'report_before_flag_dropped',
    clause: '区间起点不晚于 W → request_before_observed',
    edits: [
      swap(
        'src/rsi/auto/read/report.ts',
        "if (r.kind === 'ok' && through !== null && range.from <= through) {",
        'if (false as boolean) {',
      ),
    ],
    tests: ['rsi/auto/report-compaction.test.ts'],
    expectRed: ['区间起点不晚于 W', '压缩后的审计口径', 'gen 双读'],
    mustKill: ['区间起点不晚于 W'],
  },
  {
    id: 'report_busy_exit3',
    clause: 'gen 重试耗尽退 4',
    edits: [
      swap(
        'src/rsi/auto/read/report.ts',
        'return ExitCode.NOT_RUN;',
        'return ExitCode.FAIL_CLOSED;',
      ),
    ],
    tests: ['rsi/auto/report-compaction.test.ts'],
    expectRed: ['report_retry_exhausted_exit4', '压缩后的审计口径', 'gen 双读'],
    mustKill: ['report_retry_exhausted_exit4'],
  },
  {
    id: 'report_fail_ignored',
    clause: '压缩读失败退 3',
    edits: [
      swap('src/rsi/auto/read/report.ts', "if (snap.kind === 'fail') {", 'if (false as boolean) {'),
    ],
    tests: ['rsi/auto/report-compaction.test.ts'],
    expectRed: ['report_second_read_fails_not_fallback', '压缩后的审计口径', 'gen 双读'],
    mustKill: ['report_second_read_fails_not_fallback'],
  },
  {
    id: 'snapshot_second_fail_ignored',
    clause: '第二次读失败不回退第一次',
    edits: [
      swap(
        'src/rsi/auto/read/compaction-snapshot.ts',
        "if (second.kind === 'fail') return second;",
        '',
      ),
    ],
    tests: ['rsi/auto/report-compaction.test.ts'],
    expectRed: ['report_second_read_fails_not_fallback', '压缩后的审计口径', 'gen 双读'],
    mustKill: ['report_second_read_fails_not_fallback'],
  },
  {
    id: 'snapshot_first_fail_ignored',
    clause: '第一次读失败即失败',
    edits: [
      swap(
        'src/rsi/auto/read/compaction-snapshot.ts',
        "if (first.kind === 'fail') return first;",
        '',
      ),
    ],
    tests: ['rsi/auto/report-compaction.test.ts'],
    expectRed: ['第一次读就失败', '压缩后的审计口径', 'gen 双读'],
    mustKill: ['第一次读就失败'],
  },
  {
    id: 'snapshot_vanished_dropped',
    clause: '第一次存在第二次缺失 = vanished',
    edits: [
      swap(
        'src/rsi/auto/read/compaction-snapshot.ts',
        "if (first.gen >= 1 && second.gen === 0) return { kind: 'fail', cause: 'compaction_vanished' };",
        '',
      ),
    ],
    tests: ['rsi/auto/report-compaction.test.ts'],
    expectRed: ['report_compaction_vanished_between_reads_exit3', '压缩后的审计口径', 'gen 双读'],
    mustKill: ['report_compaction_vanished_between_reads_exit3'],
  },
  {
    id: 'snapshot_single_attempt',
    clause: 'gen 变化重试 ≤ 3 轮',
    edits: [
      swap(
        'src/rsi/auto/read/compaction-snapshot.ts',
        'export const COMPACTION_READ_ATTEMPTS = 3;',
        'export const COMPACTION_READ_ATTEMPTS = 1;',
      ),
    ],
    tests: ['rsi/auto/report-compaction.test.ts'],
    expectRed: ['report_cross_generation_retry', '压缩后的审计口径', 'gen 双读'],
    mustKill: ['report_cross_generation_retry'],
  },
  {
    id: 'snapshot_gen_unchecked',
    clause: '两次 gen 相同才一致',
    edits: [
      swap(
        'src/rsi/auto/read/compaction-snapshot.ts',
        'if (first.gen === second.gen) {',
        'if (true as boolean) {',
      ),
    ],
    tests: ['rsi/auto/report-compaction.test.ts'],
    expectRed: [
      'report_cross_generation_retry',
      'report_retry_exhausted_exit4',
      '压缩后的审计口径',
      'gen 双读',
    ],
    mustKill: ['report_cross_generation_retry'],
  },
  {
    id: 'phase_caps_v1a_empty',
    clause: 'V1a 起要求全部能力',
    edits: [swap('src/contracts/rsi-phase-caps.ts', 'V1a: RSI_ASSEMBLY_CAPS,', 'V1a: [],')],
    tests: ['rsi/store/b1b-gate.test.ts'],
    expectRed: [
      '表覆盖每个相位名',
      'phase_raise_blocked_without_near_fp_producer',
      'RSI_PHASE_REQUIRES(相位 → 必备能力)',
      'near_fp_empty_valid_until_producer_wired',
      'B1b 合并后的生产惰性',
    ],
    mustKill: ['表覆盖每个相位名'],
  },
  {
    id: 'phase_caps_invalid_allowed',
    clause: '非整数 / 越界相位默认拒绝',
    edits: [
      swap(
        'src/contracts/rsi-phase-caps.ts',
        'if (!Number.isInteger(phase) || phase < 0 || phase >= RSI_AUTO_PHASE_ORDER.length) {',
        'if (false as boolean) {',
      ),
    ],
    tests: ['rsi/store/b1b-gate.test.ts'],
    expectRed: [
      '非整数 / 越界相位',
      'RSI_PHASE_REQUIRES(相位 → 必备能力)',
      'near_fp_empty_valid_until_producer_wired',
      'B1b 合并后的生产惰性',
    ],
    mustKill: ['非整数 / 越界相位'],
  },
  {
    id: 'phase_caps_not_cumulative',
    clause: '相位要求累计',
    edits: [swap('src/contracts/rsi-phase-caps.ts', 'if (i <= phase) for', 'if (i === phase) for')],
    tests: ['rsi/store/b1b-gate.test.ts'],
    expectRed: [
      '能力齐全才放行',
      'RSI_PHASE_REQUIRES(相位 → 必备能力)',
      'near_fp_empty_valid_until_producer_wired',
      'B1b 合并后的生产惰性',
    ],
    mustKill: ['能力齐全才放行'],
  },
  {
    id: 'phase_wired_preset',
    clause: '生产装配未注入任何能力',
    edits: [
      swap(
        'src/contracts/rsi-phase-caps.ts',
        'ReadonlySet<RsiAssemblyCap> = new Set<RsiAssemblyCap>();',
        'ReadonlySet<RsiAssemblyCap> = new Set<RsiAssemblyCap>(RSI_ASSEMBLY_CAPS);',
      ),
    ],
    tests: ['rsi/store/b1b-gate.test.ts'],
    expectRed: [
      '生产惰性:相位常量 0',
      'RSI_PHASE_REQUIRES(相位 → 必备能力)',
      'near_fp_empty_valid_until_producer_wired',
      'B1b 合并后的生产惰性',
    ],
    mustKill: ['生产惰性:相位常量 0'],
  },
  {
    id: 'busy_thrown',
    clause: '并发压缩 = 返回 compact_blocked(同一个码不兼作异常)',
    edits: [
      swap(
        'src/rsi/store/compactor.ts',
        "if (release === 'busy') return blocked('compact_blocked', []);",
        "if (release === 'busy') throw new StoreError('compact_blocked', 'concurrent_compaction');",
      ),
    ],
    tests: ['rsi/store/compactor.test.ts'],
    expectRed: [
      'compaction_lease_blocks_region_open_during_p2',
      'Compactor 推进(',
      'compact_blocked 与零写入拒绝(',
      '压缩租约(P2 期间不许新开区域)',
      'compact_recovery_audit_full_ledger_pending_advances(内存世界;20000 行)',
      '旧批次重放安全(',
    ],
    mustKill: ['compaction_lease_blocks_region_open_during_p2'],
  },
  {
    id: 'lease_epoch_ignored',
    clause: 'open 读水位线期间发生过一次完整压缩(ABA)= 拒绝',
    edits: [
      swap(
        'src/rsi/store/seal.ts',
        'if (deps.registry.epoch() !== epoch) {',
        'if (false as boolean) {',
      ),
    ],
    tests: ['rsi/store/compactor.test.ts'],
    expectRed: [
      'lease_epoch_open_straddling_compaction_refused',
      'Compactor 推进(',
      'compact_blocked 与零写入拒绝(',
      '压缩租约(P2 期间不许新开区域)',
      'compact_recovery_audit_full_ledger_pending_advances(内存世界;20000 行)',
      '旧批次重放安全(',
    ],
    mustKill: ['lease_epoch_open_straddling_compaction_refused'],
  },
  {
    id: 'event_time_missing_skipped',
    clause: '有账效果却没有权威事件时间 = fail-closed(E2)',
    edits: [
      swap(
        'src/rsi/store/reconcile-source.ts',
        "if (effects.length > 0 && at === undefined) {\n            throw new StoreError('state_invalid', 'event_time_missing');\n          }",
        '',
      ),
    ],
    tests: ['rsi/store/reconcile-source.test.ts'],
    expectRed: [
      '终态记录 transitions 为空 → batchesThrough 抛 state_invalid',
      'derivedThrough(R1–R4 条目行 + R7 保护标记行)',
      'entriesThrough',
      'batchesThrough(E2 终态批次 / E1 即时否决)',
      'event_time_missing:有账效果却没有权威事件时间 = fail-closed(不跳过、不拿 now 补)',
      'resolve(权威事件取回:每次重读,不缓存)',
      '读失败 / 记录不合规:一律抛,不得以空集通过',
    ],
    mustKill: ['终态记录 transitions 为空 → batchesThrough 抛 state_invalid'],
  },
  {
    id: 'event_time_missing_e1_skipped',
    clause: '有账效果却没有权威事件时间 = fail-closed(E1)',
    edits: [
      swap(
        'src/rsi/store/reconcile-source.ts',
        "if (at === undefined) throw new StoreError('state_invalid', 'event_time_missing');",
        '',
      ),
    ],
    tests: ['rsi/store/reconcile-source.test.ts'],
    expectRed: [
      'rolling_back + vetoed 而 transitions 为空',
      'derivedThrough(R1–R4 条目行 + R7 保护标记行)',
      'entriesThrough',
      'batchesThrough(E2 终态批次 / E1 即时否决)',
      'event_time_missing:有账效果却没有权威事件时间 = fail-closed(不跳过、不拿 now 补)',
      'resolve(权威事件取回:每次重读,不缓存)',
      '读失败 / 记录不合规:一律抛,不得以空集通过',
    ],
    mustKill: ['rolling_back + vetoed 而 transitions 为空'],
  },
  {
    id: 'deps_compaction_lenient_utf8',
    clause: '读侧压缩文件严格 UTF-8',
    edits: [
      swap(
        'src/rsi/auto/deps.ts',
        "new TextDecoder('utf-8', { fatal: true }).decode(b)",
        "b.toString('utf8')",
      ),
    ],
    tests: ['rsi/auto/deps-compaction.test.ts'],
    expectRed: ['端到端 rsi report:非法 UTF-8 的压缩文件', 'compaction 读端口:严格 UTF-8'],
    mustKill: ['端到端 rsi report:非法 UTF-8 的压缩文件'],
  },
  {
    id: 'check_batch_tombstone_absent_ok',
    clause: 'P1 判据:墓碑不在 = 不满足',
    edits: [
      swap(
        'src/rsi/store/compact-plan.ts',
        "if (t === undefined) return 'compact_blocked';",
        "if (t === undefined) return 'ok';",
      ),
    ],
    tests: ['rsi/store/compact-plan.test.ts'],
    expectRed: [
      '同 id 墓碑已在 = 满足',
      'pickTarget(目标选择)',
      'checkBatch(P1 账判据:按状态判,不按键判)',
      'countInterval(区间完备证明里的计数与去重)',
      'mergeMonths / keepAfter / pruneLedger',
    ],
    mustKill: ['同 id 墓碑已在 = 满足'],
  },
  {
    id: 'check_batch_tombstone_conflict_ok',
    clause: 'P1 判据:同 id 异内容墓碑 = 冲突',
    edits: [
      swap(
        'src/rsi/store/compact-plan.ts',
        "return t.terminal === e.terminal && t.reason === e.reason ? 'ok' : 'effects_key_conflict';",
        "return 'ok';",
      ),
    ],
    tests: ['rsi/store/compact-plan.test.ts', 'rsi/store/compactor.test.ts'],
    expectRed: [
      '同 id 异内容的墓碑 = 不满足并带 effects_key_conflict',
      'compact_recovery_ledger_not_committed_blocks',
      'pickTarget(目标选择)',
      'checkBatch(P1 账判据:按状态判,不按键判)',
      'countInterval(区间完备证明里的计数与去重)',
      'mergeMonths / keepAfter / pruneLedger',
      'Compactor 推进(',
      'compact_blocked 与零写入拒绝(',
      '压缩租约(P2 期间不许新开区域)',
      'compact_recovery_audit_full_ledger_pending_advances(内存世界;20000 行)',
      '旧批次重放安全(',
    ],
    mustKill: ['同 id 异内容的墓碑 = 不满足并带 effects_key_conflict'],
  },
  {
    id: 'check_batch_veto_any_ok',
    clause: 'P1 判据:黑名单按 (id, sha) 判',
    edits: [
      swap(
        'src/rsi/store/compact-plan.ts',
        '(x) => x.candidate_id === e.id && x.content_sha256 === e.content_sha256,',
        '() => true,',
      ),
    ],
    tests: ['rsi/store/compact-plan.test.ts'],
    expectRed: [
      '黑名单:已 lifted 的项也算满足',
      'pickTarget(目标选择)',
      'checkBatch(P1 账判据:按状态判,不按键判)',
      'countInterval(区间完备证明里的计数与去重)',
      'mergeMonths / keepAfter / pruneLedger',
    ],
    mustKill: ['黑名单:已 lifted 的项也算满足'],
  },
  {
    id: 'check_batch_cooldown_expiry_ignored',
    clause: 'P1 判据:已过期被裁的冷却 = 满足',
    edits: [
      swap(
        'src/rsi/store/compact-plan.ts',
        "if (!cooldownActive({ at: m.event_at, days: e.days }, today)) return 'ok';",
        '',
      ),
    ],
    tests: ['rsi/store/compact-plan.test.ts', 'rsi/store/compactor.test.ts'],
    expectRed: [
      '冷却:at + days ≤ 今日',
      'P1–P4 端到端',
      'pickTarget(目标选择)',
      'checkBatch(P1 账判据:按状态判,不按键判)',
      'countInterval(区间完备证明里的计数与去重)',
      'mergeMonths / keepAfter / pruneLedger',
      'Compactor 推进(',
      'compact_blocked 与零写入拒绝(',
      '压缩租约(P2 期间不许新开区域)',
      'compact_recovery_audit_full_ledger_pending_advances(内存世界;20000 行)',
      '旧批次重放安全(',
    ],
    mustKill: ['冷却:at + days ≤ 今日'],
  },
  {
    id: 'check_batch_cooldown_at_ignored',
    clause: 'P1 判据:冷却项 at / days 不小于批内',
    edits: [
      swap(
        'src/rsi/store/compact-plan.ts',
        'Date.parse(c.at) >= Date.parse(m.event_at) && c.days >= e.days',
        'true',
      ),
    ],
    tests: ['rsi/store/compact-plan.test.ts'],
    expectRed: [
      '冷却:账里的项 at 更晚且 days 不小',
      'pickTarget(目标选择)',
      'checkBatch(P1 账判据:按状态判,不按键判)',
      'countInterval(区间完备证明里的计数与去重)',
      'mergeMonths / keepAfter / pruneLedger',
    ],
    mustKill: ['冷却:账里的项 at 更晚且 days 不小'],
  },
  {
    id: 'check_batch_meta_errors_satisfied',
    clause: 'P1 判据:不合规 = 不满足并带 cause',
    edits: [
      swap(
        'src/rsi/store/compact-plan.ts',
        'if (e instanceof StoreError) return { ok: false, cause: e.code };',
        'if (e instanceof StoreError) return { ok: true };',
      ),
    ],
    tests: ['rsi/store/compact-plan.test.ts'],
    expectRed: [
      '元信息 / 效果形状不合规 = 不满足并带 cause',
      'pickTarget(目标选择)',
      'checkBatch(P1 账判据:按状态判,不按键判)',
      'countInterval(区间完备证明里的计数与去重)',
      'mergeMonths / keepAfter / pruneLedger',
    ],
    mustKill: ['元信息 / 效果形状不合规 = 不满足并带 cause'],
  },
  {
    id: 'compactor_assembly_check_dropped',
    clause:
      'compactor 的注册表 / 恢复端口必须取自协调器所属 acquisition 的私有装配,不信调用方拼装的字段(两处校验都去掉)',
    edits: [
      swap(
        'src/rsi/store/compactor.ts',
        'checkCompactorAssembly(store.held, store.registry, store.recovery);',
        '',
      ),
      swap('src/rsi/store/compactor.ts', 'checkCompactorAssembly(deps.held, deps.registry);', ''),
    ],
    tests: ['rsi/store/compactor.test.ts'],
    expectRed: [
      'compactor_assembly_replaced_registry_refused',
      'compactor_assembly_mixed_acquisitions_refused',
    ],
    mustKill: [
      'compactor_assembly_replaced_registry_refused',
      'compactor_assembly_mixed_acquisitions_refused',
    ],
  },
  {
    id: 'compactor_of_assembly_check_dropped',
    clause:
      'compactorOf 自己校验三件套同源(只去掉它;createCompactor 仍验注册表,但混用的恢复端口只有 compactorOf 能拦)',
    edits: [
      swap(
        'src/rsi/store/compactor.ts',
        'checkCompactorAssembly(store.held, store.registry, store.recovery);',
        '',
      ),
    ],
    tests: ['rsi/store/compactor.test.ts'],
    expectRed: ['compactor_assembly_mixed_acquisitions_refused'],
    mustKill: ['compactor_assembly_mixed_acquisitions_refused'],
  },
  {
    id: 'compactor_assembly_registry_compare_dropped',
    clause: '装配校验:注册表必须与协调器绑定的那一张是同一对象',
    edits: [
      swap(
        'src/rsi/store/compaction-port.ts',
        'if (a.registry !== registry)',
        'if (a.registry === undefined)',
      ),
    ],
    tests: ['rsi/store/compactor.test.ts'],
    expectRed: [
      'compactor_assembly_replaced_registry_refused',
      'compactor_assembly_mixed_acquisitions_refused',
    ],
    mustKill: [
      'compactor_assembly_replaced_registry_refused',
      'compactor_assembly_mixed_acquisitions_refused',
    ],
  },
  {
    id: 'compactor_assembly_recovery_compare_dropped',
    clause: '装配校验:恢复端口必须是协调器所属装配的那一个(混用另一 acquisition 的恢复端口 = 拒绝)',
    edits: [
      swap(
        'src/rsi/store/compaction-port.ts',
        'if (recovery !== undefined && a.recovery !== recovery) {',
        'if (recovery === null) {',
      ),
    ],
    tests: ['rsi/store/compactor.test.ts'],
    expectRed: ['compactor_assembly_mixed_acquisitions_refused'],
    mustKill: ['compactor_assembly_mixed_acquisitions_refused'],
  },
  {
    id: 'compaction_write_size_check_dropped',
    clause: 'P2 前检查压缩文件字节数不超过读取上限(去掉写前检查 → 提交出读不回的文件)',
    edits: [
      swap(
        'src/rsi/store/backend.ts',
        'if (bytes.length > COMPACTION_READ_MAX)',
        'if (bytes.length < 0)',
      ),
    ],
    tests: ['rsi/store/backend.test.ts', 'rsi/store/compactor.test.ts'],
    expectRed: [
      'compaction_write_one_byte_over_limit_refused',
      'compaction_incremental_merge_over_limit_refused',
    ],
    mustKill: [
      'compaction_write_one_byte_over_limit_refused',
      'compaction_incremental_merge_over_limit_refused',
    ],
  },
  {
    id: 'compaction_write_size_check_off_by_one',
    clause: '写前检查的边界:恰好等于读取上限仍可写(与读侧 `> max` 拒绝同一口径)',
    edits: [
      swap(
        'src/rsi/store/backend.ts',
        'if (bytes.length > COMPACTION_READ_MAX)',
        'if (bytes.length >= COMPACTION_READ_MAX)',
      ),
    ],
    tests: ['rsi/store/backend.test.ts'],
    expectRed: ['compaction_write_at_read_limit'],
    mustKill: ['compaction_write_at_read_limit'],
  },
];

/** 由主代理整表执行变异后回填(新增 6 条后整表重跑) */
export const V1_ASM_B1B_RESULTS: readonly V1AsmB1bResult[] = [];
