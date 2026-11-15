/**
 * §21 V1 装配块 B1a(存储核)必杀变异:事务协调器 / effects 账合并与容量 / 审计追加器与分类 / `SealGuard` / 码表与谓词 / 文件端口。
 * 执行方式同 W5 – W8:验证机私有检出里 cp 备份 → 按锚点替换(每个锚点在对应文件里**恰好出现一次**)→ 跑 `tests` → 失败集合非空、全部命中 `expectRed`、
 * `mustKill` 每项至少命中一个、没有 skipped → cp 还原并逐文件 sha256 核对。**不用 git checkout / stash 还原**。
 * 本文件只写表与每条变异期望红的测试名(`expectRed` 是杀手测试名里的字面子串);变异由主代理整表执行,结果记进 `V1_ASM_B1A_RESULTS`(本块不执行变异,故留空)。
 * 不在本表的点(如实记录):后端写函数里的 `guardCompaction`(纵深防御:账 / 审计写入前 `readWatermark` 已先拒绝,故无法单独杀);
 * 端口契约套件(内存假件与真实现同跑)是契约测试、不是变异;未真机演练:ENOSPC / EACCES / rename 失败 / 部分写 / fsync 失败由 `faulty` 包装注入(真实写出口拒绝用 WriteDeniedError 真跑)。
 * 变异 id 用短的下划线词。
 */
export interface Edit {
  file: string;
  anchor: string;
  replacement: string;
}

export interface V1AsmB1aMutation {
  id: string;
  /** 契约条款 / 该不变量 */
  clause: string;
  edits: readonly Edit[];
  /** 相对 `test/` */
  tests: readonly string[];
  expectRed: readonly string[];
  mustKill: readonly string[];
}

export interface V1AsmB1aResult {
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

export const V1_ASM_B1A_MUTATIONS: readonly V1AsmB1aMutation[] = [
  {
    id: 'key_same_content_always_satisfied',
    clause: 'W0-26 §2 同键异内容冲突',
    edits: [
      swap(
        'src/rsi/store/ledger-merge.ts',
        "if (have.batch_sha256 === hash) return 'satisfied';",
        "return 'satisfied';",
      ),
    ],
    tests: ['rsi/store/ledger-plan.test.ts', 'rsi/store/apply-once.test.ts'],
    expectRed: ['同键不同内容 = effects_key_conflict', '同键不同内容 = EffectsKeyConflict'],
    mustKill: ['同键不同内容 = effects_key_conflict'],
  },
  {
    id: 'replay_clears_lifted',
    clause: 'W0-26 §3 重放不复活 lifted',
    edits: [
      swap(
        'src/rsi/store/ledger-merge.ts',
        "if (intent === 'user_veto' && item.lifted_gen !== undefined) {",
        'if (item.lifted_gen !== undefined) {',
      ),
    ],
    tests: ['rsi/store/ledger-plan.test.ts', 'rsi/store/apply-once.test.ts'],
    expectRed: ['replay 不复活已解除的否决', 'lift_replay_after_prune_noop'],
    mustKill: ['replay 不复活已解除的否决'],
  },
  {
    id: 'user_veto_short_circuit',
    clause: 'W0-26 §3 user_veto 不走 already',
    edits: [swap('src/rsi/store/ledger-merge.ts', "  if (intent === 'replay') {", '  if (true) {')],
    tests: ['rsi/store/apply-once.test.ts'],
    expectRed: ['user_veto_skips_already_shortcircuit'],
    mustKill: ['user_veto_skips_already_shortcircuit'],
  },
  {
    id: 'gen_overflow_unchecked',
    clause: 'W0-26 §3 gen 溢出拒写',
    edits: [
      swap(
        'src/rsi/store/ledger-merge.ts',
        "if (w.base.gen >= Number.MAX_SAFE_INTEGER) throw new StoreError('gen_overflow');",
        "if (false) throw new StoreError('gen_overflow');",
      ),
    ],
    tests: ['rsi/store/ledger-plan.test.ts'],
    expectRed: ['gen 到 Number.MAX_SAFE_INTEGER 时拒写'],
    mustKill: ['gen 到 Number.MAX_SAFE_INTEGER 时拒写'],
  },
  {
    id: 'cooldown_not_pruned',
    clause: 'W0-26 §5 过期冷却被裁',
    edits: [
      swap(
        'src/rsi/store/ledger-merge.ts',
        'next.cooldowns = next.cooldowns.filter((c) => cooldownActive(c, today));',
        'next.cooldowns = next.cooldowns;',
      ),
    ],
    tests: ['rsi/store/ledger-plan.test.ts'],
    expectRed: ['提交时裁已过期冷却'],
    mustKill: ['提交时裁已过期冷却'],
  },
  {
    id: 'byte_overflow_rejects',
    clause: 'W0-26 §4 字节超限丢键不拒写',
    edits: [
      swap(
        'src/rsi/store/ledger-merge.ts',
        'if (byteLen(build(kMax)) > L.bytes) {',
        "if (byteLen(build(kMax)) > L.bytes) return { kind: 'not_committed', cause: 'effects_full' };\n  if (false) {",
      ),
    ],
    tests: ['rsi/store/ledger-plan.test.ts'],
    expectRed: ['字节超限丢键不拒写'],
    mustKill: ['字节超限丢键不拒写'],
  },
  {
    id: 'count_overflow_rejects',
    clause: 'W0-26 §4 键满丢键不拒写',
    edits: [
      swap(
        'src/rsi/store/ledger-merge.ts',
        'const kMax = Math.min(candidates.length, L.applied);',
        "if (candidates.length > L.applied) return { kind: 'not_committed', cause: 'effects_full' };\n  const kMax = Math.min(candidates.length, L.applied);",
      ),
    ],
    tests: ['rsi/store/ledger-plan.test.ts'],
    expectRed: ['applied_count_full_drops_keys_not_rejects'],
    mustKill: ['applied_count_full_drops_keys_not_rejects'],
  },
  {
    id: 'old_keys_before_new',
    clause: 'W0-26 §4 新键优先保留',
    edits: [
      swap(
        'src/rsi/store/ledger-merge.ts',
        'const candidates = [...w.newKeys.filter(live), ...oldKeys];',
        'const candidates = [...oldKeys, ...w.newKeys.filter(live)];',
      ),
    ],
    tests: ['rsi/store/ledger-plan.test.ts'],
    expectRed: ['applied_count_full_drops_keys_not_rejects', '字节超限丢键不拒写'],
    mustKill: ['applied_count_full_drops_keys_not_rejects'],
  },
  {
    id: 'retention_ignores_watermark',
    clause: 'W0-26 §4 ≤W 键可裁',
    edits: [
      swap(
        'src/rsi/store/ledger-merge.ts',
        'const live = (a: RsiAppliedKey): boolean => wm === null || utcDay(a.event_at) > wm;',
        'const live = (a: RsiAppliedKey): boolean => a !== undefined;',
      ),
    ],
    tests: ['rsi/store/ledger-plan.test.ts'],
    expectRed: ['水位线之下的 applied 键提交时被裁'],
    mustKill: ['水位线之下的 applied 键提交时被裁'],
  },
  {
    id: 'cooldown_expired_inserted',
    clause: 'W0-26 §5 冷启动重放不重启冷却',
    edits: [
      swap(
        'src/rsi/store/ledger-merge.ts',
        'if (today !== undefined && !cooldownActive({ at: m.event_at, days: e.days }, today))',
        'if (false)',
      ),
    ],
    tests: ['rsi/store/ledger-plan.test.ts'],
    expectRed: ['cold_replay_cooldown_not_restarted'],
    mustKill: ['cold_replay_cooldown_not_restarted'],
  },
  {
    id: 'cooldown_older_at_wins',
    clause: 'W0-26 §1 冷却取更晚 at',
    edits: [
      swap(
        'src/rsi/store/ledger-merge.ts',
        'if (Date.parse(m.event_at) > Date.parse(item.at)) {',
        'if (Date.parse(m.event_at) !== Date.parse(item.at)) {',
      ),
    ],
    tests: ['rsi/store/ledger-plan.test.ts'],
    expectRed: ['同 (cluster_id, kind) 取更晚的 at'],
    mustKill: ['同 (cluster_id, kind) 取更晚的 at'],
  },
  {
    id: 'tombstone_conflict_ignored',
    clause: 'W0-26 §1 墓碑同 id 异内容冲突',
    edits: [
      swap(
        'src/rsi/store/ledger-merge.ts',
        'if (have !== undefined && `${have.terminal}/${have.reason}` !== sig) {',
        'if (false) {',
      ),
    ],
    tests: ['rsi/store/ledger-plan.test.ts', 'rsi/store/apply-once.test.ts'],
    expectRed: ['墓碑同 id 异 (terminal, reason) = 冲突', '墓碑冲突 / 批内同 id 异内容'],
    mustKill: ['墓碑同 id 异 (terminal, reason) = 冲突'],
  },
  {
    id: 'batch_tombstone_conflict_ignored',
    clause: 'W0-26 §2 批内同键异内容',
    edits: [
      swap(
        'src/rsi/store/ledger-merge.ts',
        'if (prior !== undefined && prior !== sig)',
        'if (false)',
      ),
    ],
    tests: ['rsi/store/ledger-plan.test.ts'],
    expectRed: ['批内同 id 异内容的墓碑 = batch_tombstone 冲突'],
    mustKill: ['批内同 id 异内容的墓碑 = batch_tombstone 冲突'],
  },
  {
    id: 'no_change_still_commits',
    clause: 'W0-26 §2 satisfied 零写',
    edits: [
      swap(
        'src/rsi/store/ledger-merge.ts',
        "if (!changed && !(unregistered && opts.registerSatisfiedKey === true)) return 'satisfied';",
        "if (false) return 'satisfied';",
      ),
    ],
    tests: ['rsi/store/ledger-plan.test.ts', 'rsi/store/apply-once.test.ts'],
    expectRed: [
      'dropped_key_replay_still_idempotent',
      'veto → committed;再 veto(未 lifted)= satisfied 且不写',
    ],
    mustKill: ['dropped_key_replay_still_idempotent'],
  },
  {
    id: 'fp_not_required',
    clause: 'W0-26 §1 黑名单必带 fp_hmac',
    edits: [
      swap(
        'src/rsi/store/ledger-merge.ts',
        'if (needsFp && (meta.fp_hmac === undefined || !/^[0-9a-f]{16}$/.test(meta.fp_hmac))) {',
        'if (false) {',
      ),
    ],
    tests: ['rsi/store/ledger-plan.test.ts'],
    expectRed: ['event_at 不是 ISO 时间戳'],
    mustKill: ['event_at 不是 ISO 时间戳'],
  },
  {
    id: 'unknown_effect_ignored',
    clause: 'W0-26 §2 跨信任边界校验',
    edits: [
      swap(
        'src/rsi/store/ledger-merge.ts',
        "throw new StoreError('unsupported_effect', `type:${String(t)}`);",
        'continue;',
      ),
    ],
    tests: ['rsi/store/ledger-plan.test.ts'],
    expectRed: ['非账类 / 未知 / 形状错误的效果 = unsupported_effect'],
    mustKill: ['非账类 / 未知 / 形状错误的效果 = unsupported_effect'],
  },
  {
    id: 'lift_twice_allowed',
    clause: 'W0-26 §3 lift 只作用于未 lifted 项',
    edits: [
      swap(
        'src/rsi/store/ledger-merge.ts',
        "if (item === undefined || item.lifted_gen !== undefined) return { kind: 'absent' };",
        "if (item === undefined) return { kind: 'absent' };",
      ),
    ],
    tests: ['rsi/store/apply-once.test.ts'],
    expectRed: ['lift → lifted;再 lift = absent'],
    mustKill: ['lift → lifted;再 lift = absent'],
  },
  {
    id: 'audit_conflict_ignored',
    clause: 'W0-26 §6 同键内容含 at',
    edits: [
      swap(
        'src/rsi/store/audit-appender.ts',
        'if (!sameRowForKey(have, line)) throw new AuditKeyConflict(key);',
        'if (false) throw new AuditKeyConflict(key);',
      ),
    ],
    tests: ['rsi/store/audit.test.ts'],
    expectRed: ['audit_key_conflict_includes_at'],
    mustKill: ['audit_key_conflict_includes_at'],
  },
  {
    id: 'first_not_sealed',
    clause: 'W0-26 §9 first 事件日 ≤ W 拒绝(先于 already)',
    edits: [
      swap(
        'src/rsi/store/audit-appender.ts',
        "if (origin.kind === 'first' && st.wm !== null && utcDay(line.at) <= st.wm) {",
        'if (false) {',
      ),
    ],
    tests: ['rsi/store/audit.test.ts'],
    expectRed: [
      'first_has_no_compacted_return',
      'first_residue_row_under_watermark_is_sealed_not_already',
    ],
    mustKill: ['first_residue_row_under_watermark_is_sealed_not_already'],
  },
  {
    id: 'replay_without_source_compacted',
    clause: 'W0-26 §9 replay 无源不得 compacted',
    edits: [
      swap(
        'src/rsi/store/audit-appender.ts',
        'if (ev === null || !sameSealedFields(ev, line)) {',
        'if (false) {',
      ),
    ],
    tests: ['rsi/store/audit.test.ts'],
    expectRed: ['already_audit_under_watermark_suppressed'],
    mustKill: ['already_audit_under_watermark_suppressed'],
  },
  {
    id: 'audit_full_unchecked',
    clause: 'W0-26 §4 审计 20000 行硬线',
    edits: [
      swap(
        'src/rsi/store/audit-appender.ts',
        'if (st.cls.rows.length + toAppend.length > RSI_AUDIT_LIMIT_LINES) {',
        'if (false) {',
      ),
    ],
    tests: ['rsi/store/audit.test.ts', 'rsi/store/apply-once.test.ts'],
    expectRed: ['audit_full:20000 行再追加', '审计满 + 账待提交'],
    mustKill: ['audit_full:20000 行再追加'],
  },
  {
    id: 'torn_tail_not_repaired',
    clause: 'W0-26 §7 撕裂尾先修再追加',
    edits: [
      swap(
        'src/rsi/store/audit-appender.ts',
        "if (st.cls.kind === 'torn_tail') await port.rewrite(st.cls.goodText);",
        ';',
      ),
    ],
    tests: ['rsi/store/audit.test.ts'],
    expectRed: ['撕裂尾:追加前先修尾'],
    mustKill: ['撕裂尾:追加前先修尾'],
  },
  {
    id: 'observation_no_clock_check',
    clause: 'W0-26 §9 无键行日 ≤ W 拒绝',
    edits: [
      swap(
        'src/rsi/store/audit-appender.ts',
        "throw new StoreError('clock_regressed', `${utcDay(line.at)}<=${st.wm}`);",
        'void 0;',
      ),
    ],
    tests: ['rsi/store/audit.test.ts'],
    expectRed: ['appendObservation:无键行追加'],
    mustKill: ['appendObservation:无键行追加'],
  },
  {
    id: 'observation_allows_keyed_kinds',
    clause: 'W0-26 §6 transition / 保护标记行必带键',
    edits: [
      swap(
        'src/rsi/store/audit-appender.ts',
        "if (line.kind === 'transition' || isProtectionMark(line)) {",
        'if (false) {',
      ),
    ],
    tests: ['rsi/store/audit.test.ts'],
    expectRed: ['appendObservation:无键行追加'],
    mustKill: ['appendObservation:无键行追加'],
  },
  {
    id: 'key_missing_allowed',
    clause: 'W0-26 §6 keyed 行必带 idem_key',
    edits: [
      swap(
        'src/rsi/store/audit-appender.ts',
        "if (key === undefined) throw new StoreError('audit_key_missing');",
        "if (false) throw new StoreError('audit_key_missing');",
      ),
    ],
    tests: ['rsi/store/audit.test.ts'],
    expectRed: ['缺 idem_key = audit_key_missing'],
    mustKill: ['缺 idem_key = audit_key_missing'],
  },
  {
    id: 'sealed_compare_skips_at',
    clause: 'W0-26 §9 replay 比较含 at',
    edits: [swap('src/rsi/store/audit-classify.ts', 's.at === line.at &&', 'true &&')],
    tests: ['rsi/store/audit.test.ts'],
    expectRed: ['already_audit_under_watermark_suppressed'],
    mustKill: ['already_audit_under_watermark_suppressed'],
  },
  {
    id: 'r5_at_not_excluded',
    clause: 'W0-26 §6 R5 例外',
    edits: [
      swap(
        'src/rsi/store/audit-classify.ts',
        'if (isNoopObservation(a) && isNoopObservation(b)) {',
        'if (false) {',
      ),
    ],
    tests: ['rsi/store/audit.test.ts'],
    expectRed: ['r5_conflict_ignores_at'],
    mustKill: ['r5_conflict_ignores_at'],
  },
  {
    id: 'r5_discriminator_widened',
    clause: 'W0-26 §6 R5 判别式',
    edits: [swap('src/rsi/store/audit-classify.ts', 'r.from === r.to &&', 'true &&')],
    tests: ['rsi/store/audit.test.ts'],
    expectRed: [
      '同键内容规则:默认含 at;唯一例外是终态空操作行',
      'r5_exception_only_for_self_loop_terminal',
    ],
    mustKill: ['r5_exception_only_for_self_loop_terminal'],
  },
  {
    id: 'dup_key_allowed',
    clause: 'W0-26 §7 重复键 fail-closed',
    edits: [
      swap(
        'src/rsi/store/audit-classify.ts',
        "if (byKey.has(key)) return { kind: 'bad', cause: 'audit_dup_key', line: i + 1, detail: key };",
        "if (false) return { kind: 'bad', cause: 'audit_dup_key', line: i + 1, detail: key };",
      ),
    ],
    tests: ['rsi/store/audit.test.ts'],
    expectRed: ['中间坏行 / schema 非法行 / 空行 / 重复键'],
    mustKill: ['中间坏行 / schema 非法行 / 空行 / 重复键'],
  },
  {
    id: 'compaction_through_unchecked',
    clause: 'W0-26 §7 水位线须早于今日',
    edits: [
      swap(
        'src/rsi/store/backend.ts',
        'if (p.data.through !== null && p.data.through >= today) {',
        'if (false) {',
      ),
    ],
    tests: ['rsi/store/apply-once.test.ts'],
    expectRed: ['压缩状态不受支持 = 账与审计的全部写入都拒'],
    mustKill: ['压缩状态不受支持 = 账与审计的全部写入都拒'],
  },
  {
    id: 'ledger_gen_not_sequential',
    clause: 'W0-26 §3 gen 每次提交 +1',
    edits: [
      swap(
        'src/rsi/store/backend.ts',
        "if (next.gen !== cur.gen + 1) throw new StoreError('state_invalid', 'gen_not_sequential');",
        '',
      ),
    ],
    tests: ['rsi/store/backend.test.ts'],
    expectRed: ['gen 必须恰为当前 + 1'],
    mustKill: ['gen 必须恰为当前 + 1'],
  },
  {
    id: 'stamp_no_watermark_check',
    clause: 'W0-26 §9 stamp 取值后校验 > W',
    edits: [
      swap(
        'src/rsi/store/seal.ts',
        'if (this.watermark !== null && utcDay(at) <= this.watermark) {',
        'if (false) {',
      ),
    ],
    tests: ['rsi/store/seal.test.ts'],
    expectRed: ['create_boundary_W_vs_W_plus_1', 'stale_now_captured_before_lock_refused'],
    mustKill: ['create_boundary_W_vs_W_plus_1'],
  },
  {
    id: 'stamp_boundary_off_by_one',
    clause: 'W0-26 §9 W 当日拒绝',
    edits: [
      swap('src/rsi/store/seal.ts', 'utcDay(at) <= this.watermark', 'utcDay(at) < this.watermark'),
    ],
    tests: ['rsi/store/seal.test.ts'],
    expectRed: ['create_boundary_W_vs_W_plus_1'],
    mustKill: ['create_boundary_W_vs_W_plus_1'],
  },
  {
    id: 'stamp_not_once',
    clause: 'W0-26 §9 每区域只取一次时',
    edits: [swap('src/rsi/store/seal.ts', 'if (this.stamp !== null) return this.stamp;', ';')],
    tests: ['rsi/store/seal.test.ts'],
    expectRed: ['stampFirst 每个区域只取一次时'],
    mustKill: ['stampFirst 每个区域只取一次时'],
  },
  {
    id: 'region_open_not_enforced',
    clause: 'W0-26 §9 region_open 互斥',
    edits: [
      swap(
        'src/rsi/store/seal.ts',
        "if (this.regions.size > 0) throw new StoreError('region_open');",
        ';',
      ),
    ],
    tests: ['rsi/store/seal.test.ts'],
    expectRed: ['compact_refused_until_first_audit_attempt_ends'],
    mustKill: ['compact_refused_until_first_audit_attempt_ends'],
  },
  {
    id: 'foreign_region_accepted',
    clause: 'W0-26 §9 区域必须由 SealGuard 创建',
    edits: [
      swap(
        'src/rsi/store/seal.ts',
        'if (!(region instanceof RegionImpl) || !registry.owns(region)) {',
        'if (false) {',
      ),
    ],
    tests: ['rsi/store/audit.test.ts'],
    expectRed: ['不是本模块创建的区域 = region_closed'],
    mustKill: ['不是本模块创建的区域 = region_closed'],
  },
  {
    id: 'audit_begin_any_state',
    clause: 'W0-26 §9 closed 后追加拒绝',
    edits: [
      swap(
        'src/rsi/store/seal.ts',
        "if (this.current !== 'stamped' && this.current !== 'source_committed') {",
        'if (false) {',
      ),
    ],
    tests: ['rsi/store/audit.test.ts'],
    expectRed: ['first_append_after_region_closed_refused'],
    mustKill: ['first_append_after_region_closed_refused'],
  },
  {
    id: 'closing_not_checked',
    clause: 'W0-26 §12 closing 后拒绝新事务',
    edits: [
      swap(
        'src/rsi/store/lock-control.ts',
        "if (closing) return Promise.reject(new StoreError('txn_closing'));",
        ';',
      ),
    ],
    tests: ['rsi/store/txn.test.ts'],
    expectRed: ['txn_after_closing_rejected'],
    mustKill: ['txn_after_closing_rejected'],
  },
  {
    id: 'release_not_waiting',
    clause: 'W0-26 §12 release 等在途事务',
    edits: [swap('src/rsi/store/lock-control.ts', 'await tail;', ';')],
    tests: ['rsi/store/lock-control.test.ts'],
    expectRed: ['release_waits_inflight_without_gate'],
    mustKill: ['release_waits_inflight_without_gate'],
  },
  {
    id: 'release_inside_allowed',
    clause: 'W0-26 §12 事务内 release 拒绝',
    edits: [
      swap(
        'src/rsi/store/lock-control.ts',
        "return Promise.reject(new StoreError('release_inside_transaction'));",
        'return Promise.resolve();',
      ),
    ],
    tests: ['rsi/store/txn.test.ts'],
    expectRed: ['release_inside_own_txn_rejected'],
    mustKill: ['release_inside_own_txn_rejected'],
  },
  {
    id: 'nested_allowed',
    clause: 'W0-26 §12 事务内再开事务拒绝',
    edits: [
      swap(
        'src/rsi/store/lock-control.ts',
        "return Promise.reject(new StoreError('txn_nested'));",
        'return Promise.resolve(undefined as never);',
      ),
    ],
    tests: ['rsi/store/txn.test.ts'],
    expectRed: ['txn_nested'],
    mustKill: ['txn_nested'],
  },
  {
    id: 'inflight_not_drained',
    clause: 'W0-26 §12 收尾前等在途写',
    edits: [
      swap(
        'src/rsi/store/txn.ts',
        'while (pending.size > 0) await Promise.allSettled([...pending]);',
        ';',
      ),
    ],
    tests: ['rsi/store/txn.test.ts'],
    expectRed: ['unawaited_write_release_race'],
    mustKill: ['unawaited_write_release_race'],
  },
  {
    id: 'token_never_expires',
    clause: 'W0-26 §12 token 绑定事务(入口与链内两道校验都去掉才失效)',
    edits: [
      swap(
        'src/rsi/store/txn.ts',
        "if (!token.alive || !token.accepting) return Promise.reject(new StoreError('txn_closed'));",
        ';',
      ),
      swap('src/rsi/store/txn.ts', "if (!token.alive) throw new StoreError('txn_closed');", ';'),
    ],
    tests: ['rsi/store/txn.test.ts'],
    expectRed: ['port_escaped_after_txn_before_release'],
    mustKill: ['port_escaped_after_txn_before_release'],
  },
  {
    id: 'personal_not_released',
    clause: 'W0-26 §12 逆序释放',
    edits: [
      swap(
        'src/rsi/store/lock-control.ts',
        'await personal.release();',
        'await Promise.resolve();',
      ),
    ],
    tests: ['rsi/store/txn.test.ts'],
    expectRed: ['release_waits_inflight_txn'],
    mustKill: ['release_waits_inflight_txn'],
  },
  {
    id: 'recover_range_unchecked',
    clause: 'W0-26 §2 recoverThrough 事件日 ≤ W',
    edits: [
      swap(
        'src/rsi/store/apply-once.ts',
        "if (utcDay(b.meta.event_at) > W) throw new StoreError('out_of_range', b.key);",
        ';',
      ),
    ],
    tests: ['rsi/store/recovery.test.ts'],
    expectRed: ['recover_through_rejects_event_after_W'],
    mustKill: ['recover_through_rejects_event_after_W'],
  },
  {
    id: 'audit_precheck_dropped',
    clause: 'W0-26 §2 审计预检先于账提交',
    edits: [swap('src/rsi/store/apply-once.ts', 'return ledgerWillCommit', 'return false')],
    tests: ['rsi/store/apply-once.test.ts', 'rsi/store/recovery.test.ts'],
    expectRed: ['审计满 + 账待提交', 'recover_through_audit_full_still_commits_ledger'],
    mustKill: ['审计满 + 账待提交'],
  },
  {
    id: 'audit_key_routes_to_ledger',
    clause: 'W0-26 §2 audit: 键不进账',
    edits: [
      swap(
        'src/rsi/store/apply-once.ts',
        "if (key.startsWith('audit:') && lef.length > 0) {",
        'if (false) {',
      ),
    ],
    tests: ['rsi/store/apply-once.test.ts'],
    expectRed: ['audit: 前缀的键只路由到审计'],
    mustKill: ['audit: 前缀的键只路由到审计'],
  },
  {
    id: 'effect_key_mismatch_ignored',
    clause: 'W0-26 §6 effect 与行键一致',
    edits: [
      swap(
        'src/rsi/store/apply-once.ts',
        'if (e.line.idem_key !== undefined && e.line.idem_key !== key) {',
        'if (false) {',
      ),
    ],
    tests: ['rsi/store/apply-once.test.ts'],
    expectRed: ['effect 的 idem_key 与行内 idem_key 不一致'],
    mustKill: ['effect 的 idem_key 与行内 idem_key 不一致'],
  },
  {
    id: 'cooldown_boundary_inclusive',
    clause: 'W0-26 §5 冷却谓词',
    edits: [
      swap(
        'src/contracts/rsi-store.ts',
        'return addUtcDays(utcDay(item.at), item.days) > today;',
        'return addUtcDays(utcDay(item.at), item.days) >= today;',
      ),
    ],
    tests: ['rsi/store/ledger-plan.test.ts'],
    expectRed: ['cooldown_equal_today_inactive_and_prunable'],
    mustKill: ['cooldown_equal_today_inactive_and_prunable'],
  },
  {
    id: 'lifted_pair_unchecked',
    clause: 'W0-26 §3 lifted 同在同缺',
    edits: [
      swap(
        'src/contracts/rsi-store.ts',
        'if ((e.lifted_at === undefined) !== (e.lifted_gen === undefined)) {',
        'if (false) {',
      ),
    ],
    tests: ['rsi/store/contract.test.ts'],
    expectRed: ['lifted_at 与 lifted_gen 同在同缺'],
    mustKill: ['lifted_at 与 lifted_gen 同在同缺'],
  },
  {
    id: 'months_sum_unchecked',
    clause: 'W0-26 §8 lines = deleted + derived_missing',
    edits: [
      swap(
        'src/contracts/rsi-store.ts',
        'if (m.lines !== m.deleted + m.derived_missing) {',
        'if (false) {',
      ),
    ],
    tests: ['rsi/store/contract.test.ts'],
    expectRed: ['合法通过;through 可为 null'],
    mustKill: ['合法通过;through 可为 null'],
  },
  {
    id: 'applied_dup_allowed',
    clause: 'W0-26 §1 键唯一',
    edits: [swap('src/contracts/rsi-store.ts', 'dup(l.applied.map((a) => a.key))', 'false')],
    tests: ['rsi/store/contract.test.ts'],
    expectRed: ['重复:黑名单'],
    mustKill: ['重复:黑名单'],
  },
  {
    id: 'fs_name_unchecked',
    clause: 'fs 端口防逃逸',
    edits: [
      swap(
        'src/rsi/store/fs-port.ts',
        "if (!NAME_RE.test(name)) throw new StoreError('store_io', 'bad_file_name');",
        ';',
      ),
    ],
    tests: ['rsi/store/backend.test.ts'],
    expectRed: ['fs_port_name_escape'],
    mustKill: ['fs_port_name_escape'],
  },
  {
    id: 'ops_not_serialized',
    clause: 'W0-26 §12 事务内读写串行',
    edits: [
      swap(
        'src/rsi/store/txn.ts',
        'const run = opTail.then(async',
        'const run = Promise.resolve().then(async',
      ),
    ],
    tests: ['rsi/store/txn.test.ts'],
    expectRed: ['ops_inside_txn_serialized'],
    mustKill: ['ops_inside_txn_serialized'],
  },
  {
    id: 'transition_sum_unchecked',
    clause: 'W0-26 §8 transition_by_to 之和 = by_kind.transition',
    edits: [
      swap(
        'src/contracts/rsi-store.ts',
        "if (sum(m.transition_by_to) !== (m.by_kind['transition'] ?? 0)) {",
        'if (false) {',
      ),
    ],
    tests: ['rsi/store/contract.test.ts'],
    expectRed: ['合法通过;through 可为 null'],
    mustKill: ['合法通过;through 可为 null'],
  },
  {
    id: 'recover_dependent_satisfied',
    clause: 'W0-26 §2 依赖未提交修改的满足不得报 satisfied',
    edits: [
      swap(
        'src/rsi/store/ledger-merge.ts',
        "if (r === 'satisfied' && anyChanged && b.effects.length > 0) {",
        'if (false) {',
      ),
    ],
    tests: ['rsi/store/recovery.test.ts'],
    expectRed: ['recover_dependent_satisfied_not_reported'],
    mustKill: ['recover_dependent_satisfied_not_reported'],
  },
  {
    id: 'compaction_write_unchecked',
    clause: 'W0-26 §7 写入与读侧同一语义',
    edits: [
      swap(
        'src/rsi/store/backend.ts',
        "decodeCompaction(Buffer.from(canonicalJson(next), 'utf8'), today());",
        ';',
      ),
    ],
    tests: ['rsi/store/backend.test.ts'],
    expectRed: ['writeCompaction 与读侧同一份语义'],
    mustKill: ['writeCompaction 与读侧同一份语义'],
  },
  {
    id: 'compaction_regress_allowed',
    clause: 'W0-26 §7 水位线不回退',
    edits: [swap('src/rsi/store/backend.ts', 'cur.through !== null &&', 'false &&')],
    tests: ['rsi/store/backend.test.ts'],
    expectRed: ['writeCompaction 与读侧同一份语义'],
    mustKill: ['writeCompaction 与读侧同一份语义'],
  },
  {
    id: 'utf8_lenient',
    clause: 'W0-26 §7 严格 UTF-8',
    edits: [
      swap(
        'src/rsi/store/backend.ts',
        "new TextDecoder('utf-8', { fatal: true }).decode(bytes);",
        "bytes.toString('utf8');",
      ),
    ],
    tests: ['rsi/store/backend.test.ts'],
    expectRed: ['账 / 压缩文件含非法 UTF-8'],
    mustKill: ['账 / 压缩文件含非法 UTF-8'],
  },
  // ---- 验收评审修复(H1 / H2 / H3 / M1 / M2 / M3)的变异锚点 ----
  {
    id: 'control_not_shared',
    clause: 'W0-26 §12 同一 acquisition 重复装配共享控制块(H1)',
    edits: [
      swap(
        'src/rsi/store/lock-control.ts',
        '    return a.control; // root 由 `rsi.path` 唯一决定(上面的身份校验已确认),同一对句柄不会换 root',
        '    return createControl(rsi, personal);',
      ),
    ],
    tests: ['rsi/store/lock-control.test.ts'],
    expectRed: [
      'same_acquisition_two_helds_serialized',
      'shared_closing_and_release',
      'real_handles_same_acquisition_serialized_and_raw_release_gated',
    ],
    mustKill: ['same_acquisition_two_helds_serialized', 'shared_closing_and_release'],
  },
  {
    id: 'rsi_gate_not_attached',
    clause: 'W0-26 §12 原始句柄 release 经释放屏障(H1)',
    edits: [swap('src/rsi/store/lock-control.ts', '  rsi.attachReleaseGate?.(gate);', '  ;')],
    tests: ['rsi/store/lock-control.test.ts'],
    expectRed: [
      'raw_release_waits_for_paused_commit',
      'raw_release_inside_own_txn_rejected',
      'real_handles_same_acquisition_serialized_and_raw_release_gated',
    ],
    mustKill: ['raw_release_waits_for_paused_commit'],
  },
  {
    id: 'raw_release_inside_txn_allowed',
    clause: 'W0-26 §12 事务回调内的原始 release 拒绝(H1)',
    edits: [
      swap(
        'src/rsi/store/lock-control.ts',
        "return Promise.reject(new StoreError('release_inside_transaction', 'raw_release'));",
        'return Promise.resolve();',
      ),
    ],
    tests: ['rsi/store/lock-control.test.ts'],
    expectRed: ['raw_release_inside_own_txn_rejected'],
    mustKill: ['raw_release_inside_own_txn_rejected'],
  },
  {
    id: 'identity_rsi_path_unchecked',
    clause: 'W0-26 §12 LockCap 校验 root 归属与锁种类(H1)',
    edits: [
      swap(
        'src/rsi/store/lock-control.ts',
        "if (rsi.path !== path.join(root, 'lock')) throw mismatch('rsi_root');",
        ';',
      ),
    ],
    tests: ['rsi/store/lock-control.test.ts'],
    expectRed: ['把槽位锁 digests/lock 当 rsi 锁', '角色互换(personal 句柄当 rsi 锁)= rsi_root'],
    mustKill: ['把槽位锁 digests/lock 当 rsi 锁'],
  },
  {
    id: 'identity_personal_kind_unchecked',
    clause: 'W0-26 §12 personal 句柄的锁种类 / 路径校验(H1)',
    edits: [
      swap(
        'src/rsi/store/lock-control.ts',
        'if (personal.path === rsi.path || personal.path.startsWith(root + path.sep)) {',
        'if (false) {',
      ),
    ],
    tests: ['rsi/store/lock-control.test.ts'],
    expectRed: ['角色互换(personal 句柄当 rsi 锁)= rsi_root;personal 路径落在 root 之下'],
    mustKill: ['角色互换(personal 句柄当 rsi 锁)= rsi_root;personal 路径落在 root 之下'],
  },
  {
    id: 'identity_half_allowed',
    clause: 'W0-26 §12 身份只给一半 = 拒绝(H1)',
    edits: [
      swap(
        'src/rsi/store/lock-control.ts',
        "if (declared.some((d) => d !== declared[0])) throw mismatch('identity_half');",
        ';',
      ),
    ],
    tests: ['rsi/store/lock-control.test.ts'],
    expectRed: ['只给一半身份 = identity_half'],
    mustKill: ['只给一半身份 = identity_half'],
  },
  {
    id: 'same_cap_allowed',
    clause: 'W0-26 §12 同一句柄不能同时当 rsi 与 personal(H1)',
    edits: [
      swap(
        'src/rsi/store/lock-control.ts',
        "if (rsi === personal) throw mismatch('same_cap');",
        ';',
      ),
    ],
    tests: ['rsi/store/lock-control.test.ts'],
    expectRed: ['同一个句柄同时当 rsi 与 personal = same_cap'],
    mustKill: ['同一个句柄同时当 rsi 与 personal = same_cap'],
  },
  {
    id: 'acquisition_conflict_allowed',
    clause: 'W0-26 §12 句柄已绑给别的组合 = 拒绝(H1)',
    edits: [
      swap(
        'src/rsi/store/lock-control.ts',
        'if (a === undefined || a !== b || a.rsi !== rsi || a.personal !== personal) {',
        'if (false) {',
      ),
    ],
    tests: ['rsi/store/lock-control.test.ts'],
    expectRed: ['acquisition_conflict:句柄已绑给别的组合'],
    mustKill: ['acquisition_conflict:句柄已绑给别的组合'],
  },
  {
    id: 'audit_read_whole_file_utf8',
    clause: 'W0-26 §7 撕裂尾按字节恢复(H2)',
    edits: [
      swap(
        'src/rsi/store/backend.ts',
        'const lf = r.bytes.lastIndexOf(0x0a);',
        'const lf = r.bytes.length - 1;',
      ),
    ],
    tests: ['rsi/store/review-fixes.test.ts'],
    expectRed: ['short_write_mid_multibyte_char_recovers', '只有尾部字节(无任何完整行)也是撕裂尾'],
    mustKill: ['short_write_mid_multibyte_char_recovers'],
  },
  {
    id: 'torn_flag_ignored',
    clause: 'W0-26 §7 后端确认的撕裂尾必须分类为 torn_tail(H2)',
    edits: [
      swap(
        'src/rsi/store/audit-classify.ts',
        "? { kind: 'torn_tail', rows, byKey, goodText: text }",
        "? { kind: 'ok', rows, byKey }",
      ),
    ],
    tests: ['rsi/store/review-fixes.test.ts'],
    expectRed: [
      'classifyAuditFile(text, tornTail)',
      'short_write_mid_multibyte_char_recovers',
      '只有尾部字节(无任何完整行)也是撕裂尾',
    ],
    mustKill: ['classifyAuditFile(text, tornTail)', 'short_write_mid_multibyte_char_recovers'],
  },
  {
    id: 'complete_lines_lenient_utf8',
    clause: 'W0-26 §7 完整行内非法 UTF-8 仍 fail-closed(H2)',
    edits: [
      swap(
        'src/rsi/store/backend.ts',
        'const text = strictUtf8(complete);',
        "const text = complete.toString('utf8');",
      ),
    ],
    tests: ['rsi/store/review-fixes.test.ts'],
    expectRed: ['complete_line_invalid_utf8_still_fail_closed'],
    mustKill: ['complete_line_invalid_utf8_still_fail_closed'],
  },
  {
    id: 'satisfied_key_not_registered',
    clause: 'W0-26 §2 状态已满足但键未登记的批登记键(H3)',
    edits: [
      swap(
        'src/rsi/store/ledger-merge.ts',
        "if (!changed && !(unregistered && opts.registerSatisfiedKey === true)) return 'satisfied';",
        "if (!changed) return 'satisfied';",
      ),
    ],
    tests: ['rsi/store/review-fixes.test.ts'],
    expectRed: [
      'registerSatisfiedKey=true 时',
      'noop_then_conflicting_content',
      'established_by_other_key_registers_identity',
      'registration_under_watermark_not_committed',
      'user_veto_noop_registers_key',
    ],
    mustKill: ['noop_then_conflicting_content', 'established_by_other_key_registers_identity'],
  },
  {
    id: 'apply_once_not_registering',
    clause: 'W0-26 §2 applyOnce 登记身份(H3)',
    edits: [
      swap(
        'src/rsi/store/apply-once.ts',
        '          watermark: wm,\n          registerSatisfiedKey: true,',
        '          watermark: wm,\n          registerSatisfiedKey: false,',
      ),
    ],
    tests: ['rsi/store/review-fixes.test.ts', 'rsi/store/apply-once.test.ts'],
    expectRed: [
      'noop_then_conflicting_content',
      'established_by_other_key_registers_identity',
      'lift_replay_after_prune_noop',
    ],
    mustKill: ['noop_then_conflicting_content'],
  },
  {
    id: 'user_veto_not_registering',
    clause: 'W0-26 §2 用户否决登记身份(H3)',
    edits: [
      swap(
        'src/rsi/store/apply-once.ts',
        '            watermark: wm,\n            registerSatisfiedKey: true,',
        '            watermark: wm,\n            registerSatisfiedKey: false,',
      ),
    ],
    tests: ['rsi/store/review-fixes.test.ts'],
    expectRed: ['user_veto_noop_registers_key'],
    mustKill: ['user_veto_noop_registers_key'],
  },
  {
    id: 'recover_registers_keys',
    clause: 'W0-26 §2 压缩前恢复不登记身份(H3 例外)',
    edits: [
      swap(
        'src/rsi/store/apply-once.ts',
        'registerSatisfiedKey: false,',
        'registerSatisfiedKey: true,',
      ),
    ],
    tests: ['rsi/store/review-fixes.test.ts'],
    expectRed: ['recover_through_does_not_register'],
    mustKill: ['recover_through_does_not_register'],
  },
  {
    id: 'capacity_before_audit_validation',
    clause: 'W0-26 §2 验证先于容量结果(M1)',
    edits: [
      swap(
        'src/rsi/store/apply-once.ts',
        'if (lines.length > 0) {',
        "if (lines.length > 0 && plan?.kind !== 'not_committed') {",
      ),
    ],
    tests: ['rsi/store/review-fixes.test.ts'],
    expectRed: [
      'capacity_masks_audit_conflict_fixed',
      '账满时,审计文件有坏行 / 重复键也先报完整性错误',
    ],
    mustKill: ['capacity_masks_audit_conflict_fixed'],
  },
  {
    id: 'stamp_binding_unchecked',
    clause: 'W0-26 §9 first 行 at 必须等于区域 stamp(M2)',
    edits: [swap('src/rsi/store/audit-appender.ts', 'assertLinesStamped(region, items);', ';')],
    tests: ['rsi/store/review-fixes.test.ts'],
    expectRed: ['first_rows_must_use_stamp_time'],
    mustKill: ['first_rows_must_use_stamp_time'],
  },
  {
    id: 'region_registry_unchecked',
    clause: 'W0-26 §9 区域必须由本域注册表创建(M2)',
    edits: [
      swap(
        'src/rsi/store/seal.ts',
        'if (!(region instanceof RegionImpl) || !registry.owns(region)) {',
        'if (!(region instanceof RegionImpl)) {',
      ),
    ],
    tests: ['rsi/store/review-fixes.test.ts'],
    expectRed: ['foreign_store_region_rejected'],
    mustKill: ['foreign_store_region_rejected'],
  },
  {
    id: 'registry_domain_unbound',
    clause: 'W0-26 §9 注册表绑定 acquisition(M2)',
    edits: [
      swap(
        'src/rsi/store/seal.ts',
        'if (this.domain !== null && this.domain !== identity) {',
        'if (false) {',
      ),
    ],
    tests: ['rsi/store/review-fixes.test.ts'],
    expectRed: ['registry_bound_to_acquisition'],
    mustKill: ['registry_bound_to_acquisition'],
  },
  {
    id: 'maintenance_prune_applied_skipped',
    clause: 'W0-26 §4 维护性提交:删水位线覆盖的 applied(M3)',
    edits: [
      swap(
        'src/rsi/store/ledger-merge.ts',
        "if (kept.length === next.applied.length) return { kind: 'satisfied' };",
        "return { kind: 'satisfied' };",
      ),
    ],
    tests: ['rsi/store/review-fixes.test.ts'],
    expectRed: ['watermark_covered_applied_pruned_by_noop_batch'],
    mustKill: ['watermark_covered_applied_pruned_by_noop_batch'],
  },
  {
    id: 'plan_batch_early_satisfied',
    clause: 'W0-26 §4 维护性提交:单批空操作也收尾(M3)',
    edits: [
      swap(
        'src/rsi/store/ledger-merge.ts',
        '  const own = applyBatch(w, key, effects, meta, intent, opts);',
        "  const own = applyBatch(w, key, effects, meta, intent, opts);\n  if (own === 'satisfied') return { kind: 'satisfied' };",
      ),
    ],
    tests: ['rsi/store/review-fixes.test.ts'],
    expectRed: [
      'expired_cooldown_pruned_by_noop_batch',
      '满账(2000 条过期冷却)上的空操作批也能腾出条数',
      'watermark_covered_applied_pruned_by_noop_batch',
      'applyOnce 同键重放(already)也做维护提交',
    ],
    mustKill: ['expired_cooldown_pruned_by_noop_batch', 'applyOnce 同键重放(already)也做维护提交'],
  },
  {
    id: 'recover_noop_no_maintenance',
    clause: 'W0-26 §4 维护性提交:恢复全部 satisfied 时也收尾(M3)',
    edits: [
      swap(
        'src/rsi/store/ledger-merge.ts',
        '    const plan = finalize(w, opts);',
        "    if (!outcomes.some((o) => o.state === 'changed')) {\n      return { outcomes, plan: null, planError: null };\n    }\n    const plan = finalize(w, opts);",
      ),
    ],
    tests: ['rsi/store/review-fixes.test.ts'],
    expectRed: ['recoverThrough 全部 satisfied 时也提交维护性变化'],
    mustKill: ['recoverThrough 全部 satisfied 时也提交维护性变化'],
  },
  {
    id: 'personal_kind_not_checked',
    clause: 'W0-26 §12 锁种类身份:另一把真实 rsi 锁不能冒充 personal(第 2 轮评审高)',
    edits: [
      swap(
        'src/rsi/store/lock-control.ts',
        "if (personal.kind !== undefined && personal.kind !== 'personal') throw mismatch('personal_kind');",
        '',
      ),
    ],
    tests: ['rsi/store/lock-control.test.ts'],
    expectRed: ['real_rsi_lock_cannot_pose_as_personal', 'kind_must_match_role'],
    mustKill: ['real_rsi_lock_cannot_pose_as_personal', 'kind_must_match_role'],
  },
  {
    id: 'real_shape_kind_not_required',
    clause: 'W0-26 §12 锁种类身份:真实形状(path / root 已声明)下句柄必须自报种类',
    edits: [
      swap(
        'src/rsi/store/lock-control.ts',
        "if (personal.kind === undefined) throw mismatch('personal_kind'); // 正向验证:真实 personal 句柄必须自报 personal",
        '',
      ),
    ],
    tests: ['rsi/store/lock-control.test.ts'],
    expectRed: ['kind_must_match_role'],
    mustKill: ['kind_must_match_role'],
  },
  {
    id: 'rsi_kind_not_checked',
    clause: 'W0-26 §12 锁种类身份:rsi 角色同样验种类',
    edits: [
      swap(
        'src/rsi/store/lock-control.ts',
        "if (rsi.kind !== undefined && rsi.kind !== 'rsi') throw mismatch('rsi_kind');",
        '',
      ),
    ],
    tests: ['rsi/store/lock-control.test.ts'],
    expectRed: ['real_rsi_lock_cannot_pose_as_personal', 'kind_must_match_role'],
    mustKill: ['kind_must_match_role'],
  },
  {
    id: 'recover_seen_table_dropped',
    clause: 'W0-26 §2 recoverThrough:本次调用内的同键异内容冲突(第 2 轮评审中)',
    edits: [
      swap(
        'src/rsi/store/ledger-merge.ts',
        'if (seen !== undefined && seen !== hash) throw new EffectsKeyConflict(`key:${key}`);',
        '',
      ),
    ],
    tests: ['rsi/store/review-fixes.test.ts'],
    expectRed: ['recover_same_call_key_conflict_after_satisfied'],
    mustKill: ['recover_same_call_key_conflict_after_satisfied'],
  },
  {
    id: 'recover_seen_table_not_shared',
    clause: 'W0-26 §2 recoverThrough:身份表覆盖全部批次(每批新建一张 = 等于没有)',
    edits: [
      swap(
        'src/rsi/store/ledger-merge.ts',
        'const callOpts: PlanOptions = { ...opts, seenKeys: opts.seenKeys ?? new Map<string, string>() };',
        'const callOpts: PlanOptions = { ...opts };',
      ),
    ],
    tests: ['rsi/store/review-fixes.test.ts'],
    expectRed: ['recover_same_call_key_conflict_after_satisfied'],
    mustKill: ['recover_same_call_key_conflict_after_satisfied'],
  },
  {
    id: 'registry_not_shared_per_acquisition',
    clause: 'W0-26 §12 区域注册表随 acquisition 共享(第 2 轮评审中)',
    edits: [
      swap(
        'src/rsi/store/lock-control.ts',
        'const chosen = registry ?? candidate ?? new SealRegistry();',
        'const chosen = candidate ?? new SealRegistry();',
      ),
    ],
    tests: ['rsi/store/lock-control.test.ts'],
    expectRed: ['registry_shared_per_acquisition'],
    mustKill: ['registry_shared_per_acquisition'],
  },
  {
    id: 'registry_conflict_not_rejected',
    clause: 'W0-26 §12 为同一 acquisition 配另一张注册表 = 拒绝',
    edits: [
      swap(
        'src/rsi/store/lock-control.ts',
        'if (candidate !== undefined && registry !== null && candidate !== registry) {',
        'if (false) {',
      ),
    ],
    tests: ['rsi/store/lock-control.test.ts'],
    expectRed: ['registry_shared_per_acquisition'],
    mustKill: ['registry_shared_per_acquisition'],
  },
  {
    id: 'gate_precheck_skipped',
    clause: 'W0-26 §12 释放屏障原子占用:先无副作用预检再挂(第 2 轮评审中)',
    edits: [
      swap('src/rsi/store/lock-control.ts', 'if (taken(rsi) || taken(personal)) {', 'if (false) {'),
    ],
    tests: ['rsi/store/lock-control.test.ts'],
    expectRed: ['gate_install_is_atomic', '句柄已挂了别的屏障 = 拒绝'],
    mustKill: ['gate_install_is_atomic'],
  },
  {
    id: 'user_veto_maintenance_reports_committed',
    clause: 'W0-26 §4 userVeto 只有维护性写入时报 satisfied(与 applyOnce 一致;第 2 轮评审中)',
    edits: [
      swap(
        'src/rsi/store/apply-once.ts',
        "ledger: plan.maintenanceOnly === true ? 'satisfied' : 'committed',\n          audit: 'not_applicable',",
        "ledger: 'committed',\n          audit: 'not_applicable',",
      ),
    ],
    tests: ['rsi/store/review-fixes.test.ts'],
    expectRed: ['user_veto_maintenance_only_reports_satisfied'],
    mustKill: ['user_veto_maintenance_only_reports_satisfied'],
  },
];

/** 由主代理整表执行变异后回填 */
export const V1_ASM_B1A_RESULTS: readonly V1AsmB1aResult[] = [];
