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
    expectRed: [
      'replay 不复活已解除的否决',
      'lift_replay_after_prune_noop',
      'replay_paths_cannot_reach_user_veto_intent:applyOnce / recoverThrough 没有 intent 参数',
    ],
    mustKill: ['replay 不复活已解除的否决'],
  },
  {
    id: 'user_veto_short_circuit',
    clause: 'W0-26 §3 user_veto 不走 already',
    edits: [swap('src/rsi/store/ledger-merge.ts', "  if (intent === 'replay') {", '  if (true) {')],
    tests: ['rsi/store/apply-once.test.ts'],
    expectRed: [
      'user_veto_skips_already_shortcircuit',
      'lift_then_new_user_veto_effective_under_clock_regress:事件时间倒退时仍按 gen 生效',
      'replay_paths_cannot_reach_user_veto_intent:applyOnce / recoverThrough 没有 intent 参数',
    ],
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
    expectRed: [
      'applied_count_full_drops_keys_not_rejects',
      'applied_retention_order_deterministic:同刻旧键按键字典序升序保留,丢最后一个',
    ],
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
    expectRed: [
      'applied_count_full_drops_keys_not_rejects',
      '字节超限丢键不拒写',
      'applied_retention_order_deterministic:同刻旧键按键字典序升序保留,丢最后一个',
    ],
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
      '墓碑同 id 异 (terminal, reason) = 冲突;同内容 = 空操作保留最早 at',
      'replay 不复活已解除的否决(含键被裁后);对照:未解除时 replay 为空操作',
      'cold_replay_cooldown_not_restarted:已过期的事件重放不插入新冷却(zero write);对照:仍 active 则插入',
      '同 (cluster_id, kind) 取更晚的 at;更早的重放 = 空操作',
      'non_key_state_over_limit_rejected:黑名单 1000 满再加新项 = not_committed(effects_full);同一项已在则 satisfied(对照)',
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
    expectRed: [
      'event_at 不是 ISO 时间戳',
      '账类效果缺 meta = effects_meta_missing(detail=meta);纯 tombstone 批缺 fp_hmac 照常(对照)',
    ],
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
    expectRed: [
      'audit_key_conflict_includes_at',
      'r5_conflict_ignores_at:终态空操作行同键异 at = already;异 reason = 冲突',
      '撕裂尾:追加前先修尾(丢弃片段),再追加;冲突时零写入(不修尾)',
    ],
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
    expectRed: [
      'audit_full:20000 行再追加',
      '审计满 + 账待提交',
      '审计满 + 账已满足:ledger=satisfied、audit=pending、cause=audit_full(审计待补,不是错误)',
    ],
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
    expectRed: [
      '撕裂尾:追加前先修尾',
      '部分写(写出一半后失败):文件留下撕裂尾;下一次追加先修尾,最终恰有一份新行、旧行不丢',
      '撕裂尾修复时 rename 失败:抛 store_io、tmp 清理、文件仍是原样(撕裂尾)',
    ],
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
    expectRed: [
      'r5_conflict_ignores_at',
      '同键内容规则:默认含 at;唯一例外是终态空操作行(排除 at);其它字段不同仍冲突',
      'r5_exception_only_for_self_loop_terminal:真正进入终态的转移(from ≠ to)不适用排除 at 的例外——同键异 at = 冲突;对照:终态空操作行(from = to)异 at 视为同一行',
    ],
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
    expectRed: [
      '中间坏行 / schema 非法行 / 空行 / 重复键',
      'audit_midfile_bad_failclosed:中间坏行 / 重复键 = fail-closed,文件逐字节不变;对照:干净文件可追加',
    ],
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
    expectRed: [
      'release_waits_inflight_txn',
      'release_inside_own_txn_rejected:本把锁事务回调内调用 release = release_inside_transaction(否则自锁)',
      'release_inside_other_lock_txn_not_rejected:别的锁的事务回调内调用本把锁的 release 照常等待并完成',
      'release 开始前已排队的事务照常执行(不是 closing 之后才进来的)',
      'concurrent_release_single_promise:并发多次 release 共享同一个 promise,底层各释放一次',
      'personal 释放失败时 rsi 仍被释放(finally)',
    ],
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
    expectRed: [
      'recover_through_rejects_event_after_W',
      'recover_through_audit_full_still_commits_ledger:审计满(20000 行)时账照样提交——不存在循环依赖',
    ],
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
    expectRed: [
      'cooldown_equal_today_inactive_and_prunable',
      '提交时裁已过期冷却;仍 active 的保留',
    ],
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
    expectRed: ['账 / 压缩文件含非法 UTF-8', '审计文件不是合法 UTF-8 = audit_bad_line(utf8)'],
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
      'raw_release_waits_for_paused_commit:提交暂停在 commitTmp 之前,外层调用原始 rsi.release() → 等事务提交完才真正释放;之后新事务 txn_closing',
      'raw_release_inside_own_txn_rejected:事务回调内调用原始 release = release_inside_transaction(锁保持);对照:事务外同一调用正常释放',
      'registry_shared_per_acquisition:同一对句柄装配两次共用同一张区域注册表(A 开的区域 B 看得见);为同一 acquisition 配另一张表 = registry_conflict 且那张表不被绑定;别的 acquisition 互不影响',
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
      'real_rsi_lock_cannot_pose_as_personal:另一个项目的真实 rsi 锁当 personal 装配 = personal_kind(锁种类是正向验证,不是「不在当前 root 下」);对照:真实 personal 句柄可装配;拒绝后两把句柄都没被挂屏障',
      'gate_install_is_atomic:personal 句柄已被别的屏障占着 → 装配被拒(release_gate_taken)且 rsi 句柄没被动过;换一个新取的 personal 后能重新装配、事务与释放正常(对照:半绑定下重试会被 rsi 句柄拒绝)',
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
      'registration_under_watermark_not_committed:事件日 ≤ 水位线的空操作批不登记(键本就会被裁)= satisfied 零写;对照:无水位线时登记',
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
    expectRed: [
      'recover_through_does_not_register',
      'recover_same_call_key_conflict_after_satisfied:同一次恢复里第一批(键 K,状态已满足)之后同键异内容的第二批 = 该批 effects_key_conflict,账字节不变;对照:同键同内容 / 异键异内容都正常',
      'recover_same_call_empty_batch_key_identity:同一次恢复里没有账类效果的批也占键身份——空批之后同键非空批、非空批之后同键空批都是 effects_key_conflict,账字节不变;对照:同键两个空批 / 空批后异键非空批都正常',
    ],
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
    // 第 3 轮起装配先经 isBoundElsewhere 预检(lock-control.acquireLockControl / adoptRegistry),bindDomain 的抛错成了第二道:
    // 单独拿掉它看不出差别,所以预检与 bindDomain 一起失效,才是「注册表不绑 acquisition」
    clause: 'W0-26 §9 注册表绑定 acquisition(M2;预检与 bindDomain 两道一起失效)',
    edits: [
      swap(
        'src/rsi/store/seal.ts',
        'if (this.domain !== null && this.domain !== identity) {',
        'if (false) {',
      ),
      swap(
        'src/rsi/store/seal.ts',
        '    return this.domain !== null && this.domain !== identity;',
        '    return false;',
      ),
    ],
    tests: ['rsi/store/review-fixes.test.ts', 'rsi/store/lock-control.test.ts'],
    expectRed: [
      'registry_bound_to_acquisition',
      'registry_foreign_first_assembly_no_binding',
      'foreign_store_region_rejected',
    ],
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
      'user_veto_maintenance_only_reports_satisfied:否决自身已满足、只有维护性写入(过期冷却被裁)= ledger:satisfied 但账确实被写(satisfied ≠ 零写盘);对照:全新否决 = committed',
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
    expectRed: [
      'recover_same_call_key_conflict_after_satisfied',
      'recover_same_call_empty_batch_key_identity:同一次恢复里没有账类效果的批也占键身份——空批之后同键非空批、非空批之后同键空批都是 effects_key_conflict,账字节不变;对照:同键两个空批 / 空批后异键非空批都正常',
    ],
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
    expectRed: [
      'recover_same_call_key_conflict_after_satisfied',
      'recover_same_call_empty_batch_key_identity:同一次恢复里没有账类效果的批也占键身份——空批之后同键非空批、非空批之后同键空批都是 effects_key_conflict,账字节不变;对照:同键两个空批 / 空批后异键非空批都正常',
    ],
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
  {
    id: 'recover_empty_batch_skips_identity',
    clause: 'W0-26 §2 recoverThrough:身份表覆盖全部批次,含没有账类效果的批(第 3 轮评审中)',
    edits: [
      swap(
        'src/rsi/store/ledger-merge.ts',
        'const empty = effects.length === 0;',
        "const empty = effects.length === 0;\n  if (empty) return 'satisfied';",
      ),
    ],
    tests: ['rsi/store/review-fixes.test.ts'],
    expectRed: ['recover_same_call_empty_batch_key_identity'],
    mustKill: ['recover_same_call_empty_batch_key_identity'],
  },
  {
    id: 'registry_foreign_checked_after_binding',
    clause: 'W0-26 §12 装配被拒零副作用:注册表不可接受时句柄不被占用(第 3 轮评审中)',
    edits: [
      swap(
        'src/rsi/store/lock-control.ts',
        "if (registry?.isBoundElsewhere(control.identity) === true) throw mismatch('registry_foreign');",
        '',
      ),
    ],
    tests: ['rsi/store/lock-control.test.ts'],
    expectRed: ['registry_foreign_first_assembly_no_binding'],
    mustKill: ['registry_foreign_first_assembly_no_binding'],
  },
];

/** 由主代理整表执行变异后回填 */
/** 实测结果:r21b1a-mut-h5 @6ab767e(javis):92 条全部被杀(recover_range_unchecked 另红了同文件一条审计满用例,已并入 expectRed) */
export const V1_ASM_B1A_RESULTS: readonly V1AsmB1aResult[] = [
  {
    id: 'key_same_content_always_satisfied',
    failed: 3,
    skipped: 0,
    killedBy: [
      'applyOnce 契约(mem) 同键不同内容 = EffectsKeyConflict(零写入:账字节不变、无 tmp 残留);对照:换键提交',
      'applyOnce 契约(real) 同键不同内容 = EffectsKeyConflict(零写入:账字节不变、无 tmp 残留);对照:换键提交',
      'planLedgerBatch:基本提交与幂等 同键不同内容 = effects_key_conflict(零写),detail 钉在 key;对照:换键则正常提交',
    ],
    restored: true,
  },
  {
    id: 'replay_clears_lifted',
    failed: 5,
    skipped: 0,
    killedBy: [
      'UserVetoPort 与 lift 语义(mem) lift_replay_after_prune_noop:lift 之后 replay(键在 / 键已丢)都不复活',
      'UserVetoPort 与 lift 语义(mem) replay_paths_cannot_reach_user_veto_intent:applyOnce / recoverThrough 没有 intent 参数',
      'UserVetoPort 与 lift 语义(real) lift_replay_after_prune_noop:lift 之后 replay(键在 / 键已丢)都不复活',
      'UserVetoPort 与 lift 语义(real) replay_paths_cannot_reach_user_veto_intent:applyOnce / recoverThrough 没有 intent 参数',
      'planLedgerBatch:gen 与 lift 语义 replay 不复活已解除的否决(含键被裁后);对照:未解除时 replay 为空操作',
    ],
    restored: true,
  },
  {
    id: 'user_veto_short_circuit',
    failed: 6,
    skipped: 0,
    killedBy: [
      'UserVetoPort 与 lift 语义(mem) user_veto_skips_already_shortcircuit:同键已记,lift 后用户再 veto 仍生效(清 lifted、vetoed_gen = 新 gen)',
      'UserVetoPort 与 lift 语义(mem) lift_then_new_user_veto_effective_under_clock_regress:事件时间倒退时仍按 gen 生效',
      'UserVetoPort 与 lift 语义(mem) replay_paths_cannot_reach_user_veto_intent:applyOnce / recoverThrough 没有 intent 参数',
      'UserVetoPort 与 lift 语义(real) user_veto_skips_already_shortcircuit:同键已记,lift 后用户再 veto 仍生效(清 lifted、vetoed_gen = 新 gen)',
      'UserVetoPort 与 lift 语义(real) lift_then_new_user_veto_effective_under_clock_regress:事件时间倒退时仍按 gen 生效',
      'UserVetoPort 与 lift 语义(real) replay_paths_cannot_reach_user_veto_intent:applyOnce / recoverThrough 没有 intent 参数',
    ],
    restored: true,
  },
  {
    id: 'gen_overflow_unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'planLedgerBatch:gen 与 lift 语义 gen 到 Number.MAX_SAFE_INTEGER 时拒写(gen_overflow,不回绕);对照:再小一档可写',
    ],
    restored: true,
  },
  {
    id: 'cooldown_not_pruned',
    failed: 1,
    skipped: 0,
    killedBy: ['冷却谓词与裁剪 提交时裁已过期冷却;仍 active 的保留'],
    restored: true,
  },
  {
    id: 'byte_overflow_rejects',
    failed: 1,
    skipped: 0,
    killedBy: [
      '容量:非键状态硬线与 applied 保留子集 字节超限丢键不拒写:旧键不会把合法效果变成 effects_full,新键与新效果都保留',
    ],
    restored: true,
  },
  {
    id: 'count_overflow_rejects',
    failed: 2,
    skipped: 0,
    killedBy: [
      '容量:非键状态硬线与 applied 保留子集 applied_count_full_drops_keys_not_rejects:20000 键满仍提交,新键在前,丢最旧的旧键',
      '容量:非键状态硬线与 applied 保留子集 applied_retention_order_deterministic:同刻旧键按键字典序升序保留,丢最后一个',
    ],
    restored: true,
  },
  {
    id: 'old_keys_before_new',
    failed: 3,
    skipped: 0,
    killedBy: [
      '容量:非键状态硬线与 applied 保留子集 applied_count_full_drops_keys_not_rejects:20000 键满仍提交,新键在前,丢最旧的旧键',
      '容量:非键状态硬线与 applied 保留子集 applied_retention_order_deterministic:同刻旧键按键字典序升序保留,丢最后一个',
      '容量:非键状态硬线与 applied 保留子集 字节超限丢键不拒写:旧键不会把合法效果变成 effects_full,新键与新效果都保留',
    ],
    restored: true,
  },
  {
    id: 'retention_ignores_watermark',
    failed: 1,
    skipped: 0,
    killedBy: [
      '容量:非键状态硬线与 applied 保留子集 水位线之下的 applied 键提交时被裁、新键事件日 ≤ W 不记;之后的保留',
    ],
    restored: true,
  },
  {
    id: 'cooldown_expired_inserted',
    failed: 1,
    skipped: 0,
    killedBy: [
      '冷却谓词与裁剪 cold_replay_cooldown_not_restarted:已过期的事件重放不插入新冷却(zero write);对照:仍 active 则插入',
    ],
    restored: true,
  },
  {
    id: 'cooldown_older_at_wins',
    failed: 1,
    skipped: 0,
    killedBy: ['冷却谓词与裁剪 同 (cluster_id, kind) 取更晚的 at;更早的重放 = 空操作'],
    restored: true,
  },
  {
    id: 'tombstone_conflict_ignored',
    failed: 3,
    skipped: 0,
    killedBy: [
      'applyOnce 契约(mem) 墓碑冲突 / 批内同 id 异内容:零写入',
      'applyOnce 契约(real) 墓碑冲突 / 批内同 id 异内容:零写入',
      'planLedgerBatch:基本提交与幂等 墓碑同 id 异 (terminal, reason) = 冲突;同内容 = 空操作保留最早 at',
    ],
    restored: true,
  },
  {
    id: 'batch_tombstone_conflict_ignored',
    failed: 1,
    skipped: 0,
    killedBy: [
      'planLedgerBatch:基本提交与幂等 批内同 id 异内容的墓碑 = batch_tombstone 冲突;对照:同 id 同内容合并为一项',
    ],
    restored: true,
  },
  {
    id: 'no_change_still_commits',
    failed: 6,
    skipped: 0,
    killedBy: [
      'planLedgerBatch:基本提交与幂等 墓碑同 id 异 (terminal, reason) = 冲突;同内容 = 空操作保留最早 at',
      'planLedgerBatch:gen 与 lift 语义 replay 不复活已解除的否决(含键被裁后);对照:未解除时 replay 为空操作',
      '冷却谓词与裁剪 cold_replay_cooldown_not_restarted:已过期的事件重放不插入新冷却(zero write);对照:仍 active 则插入',
      '冷却谓词与裁剪 同 (cluster_id, kind) 取更晚的 at;更早的重放 = 空操作',
      '容量:非键状态硬线与 applied 保留子集 non_key_state_over_limit_rejected:黑名单 1000 满再加新项 = not_committed(effects_full);同一项已在则 satisfied(对照)',
      '容量:非键状态硬线与 applied 保留子集 dropped_key_replay_still_idempotent:键被丢后同批重放 = 状态已满足,零写',
    ],
    restored: true,
  },
  {
    id: 'fp_not_required',
    failed: 2,
    skipped: 0,
    killedBy: [
      'planLedgerBatch:跨信任边界的校验 账类效果缺 meta = effects_meta_missing(detail=meta);纯 tombstone 批缺 fp_hmac 照常(对照)',
      'planLedgerBatch:跨信任边界的校验 event_at 不是 ISO 时间戳 / fp_hmac 不是 16 位十六进制 / near_fp 项不是 8 位 = effects_meta_missing',
    ],
    restored: true,
  },
  {
    id: 'unknown_effect_ignored',
    failed: 1,
    skipped: 0,
    killedBy: [
      'planLedgerBatch:跨信任边界的校验 非账类 / 未知 / 形状错误的效果 = unsupported_effect(不静默忽略);审计类效果被账规划忽略(对照)',
    ],
    restored: true,
  },
  {
    id: 'lift_twice_allowed',
    failed: 2,
    skipped: 0,
    killedBy: [
      'UserVetoPort 与 lift 语义(mem) veto → committed;再 veto(未 lifted)= satisfied 且不写;lift → lifted;再 lift = absent',
      'UserVetoPort 与 lift 语义(real) veto → committed;再 veto(未 lifted)= satisfied 且不写;lift → lifted;再 lift = absent',
    ],
    restored: true,
  },
  {
    id: 'audit_conflict_ignored',
    failed: 6,
    skipped: 0,
    killedBy: [
      'appendKeyed replay / appendObservation(mem) audit_key_conflict_includes_at:同键 at 不同 = AuditKeyConflict,零写入;对照:同键同内容 already',
      'appendKeyed replay / appendObservation(mem) r5_conflict_ignores_at:终态空操作行同键异 at = already;异 reason = 冲突',
      'appendKeyed replay / appendObservation(mem) 撕裂尾:追加前先修尾(丢弃片段),再追加;冲突时零写入(不修尾)',
      'appendKeyed replay / appendObservation(real) audit_key_conflict_includes_at:同键 at 不同 = AuditKeyConflict,零写入;对照:同键同内容 already',
      'appendKeyed replay / appendObservation(real) r5_conflict_ignores_at:终态空操作行同键异 at = already;异 reason = 冲突',
      'appendKeyed replay / appendObservation(real) 撕裂尾:追加前先修尾(丢弃片段),再追加;冲突时零写入(不修尾)',
    ],
    restored: true,
  },
  {
    id: 'first_not_sealed',
    failed: 2,
    skipped: 0,
    killedBy: [
      'appendKeyed first(mem) first_residue_row_under_watermark_is_sealed_not_already:文件里仍有 ≤ W 的残留同键行时,first 仍是 sealed_interval(封存检查先于 already)',
      'appendKeyed first(real) first_residue_row_under_watermark_is_sealed_not_already:文件里仍有 ≤ W 的残留同键行时,first 仍是 sealed_interval(封存检查先于 already)',
    ],
    restored: true,
  },
  {
    id: 'replay_without_source_compacted',
    failed: 2,
    skipped: 0,
    killedBy: [
      'appendKeyed replay / appendObservation(mem) already_audit_under_watermark_suppressed:水位线之下的 replay —— 无源 / 源缺失 / 源内容不符 = sealed_unknown_event(零写入);源逐字段相等才 compacted',
      'appendKeyed replay / appendObservation(real) already_audit_under_watermark_suppressed:水位线之下的 replay —— 无源 / 源缺失 / 源内容不符 = sealed_unknown_event(零写入);源逐字段相等才 compacted',
    ],
    restored: true,
  },
  {
    id: 'audit_full_unchecked',
    failed: 6,
    skipped: 0,
    killedBy: [
      'applyOnce 契约(mem) 审计满 + 账待提交:账不提交(账后只剩 I/O 失败),cause=audit_full;审计文件与账均不变',
      'applyOnce 契约(mem) 审计满 + 账已满足:ledger=satisfied、audit=pending、cause=audit_full(审计待补,不是错误)',
      'applyOnce 契约(real) 审计满 + 账待提交:账不提交(账后只剩 I/O 失败),cause=audit_full;审计文件与账均不变',
      'applyOnce 契约(real) 审计满 + 账已满足:ledger=satisfied、audit=pending、cause=audit_full(审计待补,不是错误)',
      'appendKeyed replay / appendObservation(mem) audit_full:20000 行再追加 = audit_full(reason=audit_full),文件不变;已存在的键仍 already(对照)',
      'appendKeyed replay / appendObservation(real) audit_full:20000 行再追加 = audit_full(reason=audit_full),文件不变;已存在的键仍 already(对照)',
    ],
    restored: true,
  },
  {
    id: 'torn_tail_not_repaired',
    failed: 6,
    skipped: 0,
    killedBy: [
      'appendKeyed replay / appendObservation(mem) 撕裂尾:追加前先修尾(丢弃片段),再追加;冲突时零写入(不修尾)',
      'appendKeyed replay / appendObservation(real) 撕裂尾:追加前先修尾(丢弃片段),再追加;冲突时零写入(不修尾)',
      '审计追加的故障注入(mem) 部分写(写出一半后失败):文件留下撕裂尾;下一次追加先修尾,最终恰有一份新行、旧行不丢',
      '审计追加的故障注入(mem) 撕裂尾修复时 rename 失败:抛 store_io、tmp 清理、文件仍是原样(撕裂尾)',
      '审计追加的故障注入(real) 部分写(写出一半后失败):文件留下撕裂尾;下一次追加先修尾,最终恰有一份新行、旧行不丢',
      '审计追加的故障注入(real) 撕裂尾修复时 rename 失败:抛 store_io、tmp 清理、文件仍是原样(撕裂尾)',
    ],
    restored: true,
  },
  {
    id: 'observation_no_clock_check',
    failed: 2,
    skipped: 0,
    killedBy: [
      'appendKeyed replay / appendObservation(mem) appendObservation:无键行追加;带键 / transition / 保护标记行被拒;日 ≤ W = clock_regressed(日 == W+1 通过)',
      'appendKeyed replay / appendObservation(real) appendObservation:无键行追加;带键 / transition / 保护标记行被拒;日 ≤ W = clock_regressed(日 == W+1 通过)',
    ],
    restored: true,
  },
  {
    id: 'observation_allows_keyed_kinds',
    failed: 2,
    skipped: 0,
    killedBy: [
      'appendKeyed replay / appendObservation(mem) appendObservation:无键行追加;带键 / transition / 保护标记行被拒;日 ≤ W = clock_regressed(日 == W+1 通过)',
      'appendKeyed replay / appendObservation(real) appendObservation:无键行追加;带键 / transition / 保护标记行被拒;日 ≤ W = clock_regressed(日 == W+1 通过)',
    ],
    restored: true,
  },
  {
    id: 'key_missing_allowed',
    failed: 2,
    skipped: 0,
    killedBy: [
      'appendKeyed replay / appendObservation(mem) 批内:同键同内容 = 第二项 already;同键异内容 = 冲突且整批零写入;缺 idem_key = audit_key_missing',
      'appendKeyed replay / appendObservation(real) 批内:同键同内容 = 第二项 already;同键异内容 = 冲突且整批零写入;缺 idem_key = audit_key_missing',
    ],
    restored: true,
  },
  {
    id: 'sealed_compare_skips_at',
    failed: 2,
    skipped: 0,
    killedBy: [
      'appendKeyed replay / appendObservation(mem) already_audit_under_watermark_suppressed:水位线之下的 replay —— 无源 / 源缺失 / 源内容不符 = sealed_unknown_event(零写入);源逐字段相等才 compacted',
      'appendKeyed replay / appendObservation(real) already_audit_under_watermark_suppressed:水位线之下的 replay —— 无源 / 源缺失 / 源内容不符 = sealed_unknown_event(零写入);源逐字段相等才 compacted',
    ],
    restored: true,
  },
  {
    id: 'r5_at_not_excluded',
    failed: 4,
    skipped: 0,
    killedBy: [
      'classifyAuditFile(纯函数) 同键内容规则:默认含 at;唯一例外是终态空操作行(排除 at);其它字段不同仍冲突',
      'classifyAuditFile(纯函数) r5_exception_only_for_self_loop_terminal:真正进入终态的转移(from ≠ to)不适用排除 at 的例外——同键异 at = 冲突;对照:终态空操作行(from = to)异 at 视为同一行',
      'appendKeyed replay / appendObservation(mem) r5_conflict_ignores_at:终态空操作行同键异 at = already;异 reason = 冲突',
      'appendKeyed replay / appendObservation(real) r5_conflict_ignores_at:终态空操作行同键异 at = already;异 reason = 冲突',
    ],
    restored: true,
  },
  {
    id: 'r5_discriminator_widened',
    failed: 1,
    skipped: 0,
    killedBy: [
      'classifyAuditFile(纯函数) r5_exception_only_for_self_loop_terminal:真正进入终态的转移(from ≠ to)不适用排除 at 的例外——同键异 at = 冲突;对照:终态空操作行(from = to)异 at 视为同一行',
    ],
    restored: true,
  },
  {
    id: 'dup_key_allowed',
    failed: 3,
    skipped: 0,
    killedBy: [
      'classifyAuditFile(纯函数) 中间坏行 / schema 非法行 / 空行 / 重复键 = bad,带行号与具体原因',
      'appendKeyed replay / appendObservation(mem) audit_midfile_bad_failclosed:中间坏行 / 重复键 = fail-closed,文件逐字节不变;对照:干净文件可追加',
      'appendKeyed replay / appendObservation(real) audit_midfile_bad_failclosed:中间坏行 / 重复键 = fail-closed,文件逐字节不变;对照:干净文件可追加',
    ],
    restored: true,
  },
  {
    id: 'compaction_through_unchecked',
    failed: 2,
    skipped: 0,
    killedBy: [
      'applyOnce 契约(mem) 压缩状态不受支持 = 账与审计的全部写入都拒(compaction_unsupported),零写入;缺失 / 受支持(对照)照常',
      'applyOnce 契约(real) 压缩状态不受支持 = 账与审计的全部写入都拒(compaction_unsupported),零写入;缺失 / 受支持(对照)照常',
    ],
    restored: true,
  },
  {
    id: 'ledger_gen_not_sequential',
    failed: 1,
    skipped: 0,
    killedBy: ['后端 commitLedger gen 必须恰为当前 + 1(gen_not_sequential);对照:+1 通过'],
    restored: true,
  },
  {
    id: 'stamp_no_watermark_check',
    failed: 4,
    skipped: 0,
    killedBy: [
      'SealGuard(mem) create_boundary_W_vs_W_plus_1:W 当日拒绝(sealed_interval),W+1 日通过',
      'SealGuard(mem) stale_now_captured_before_lock_refused:函数形式不是安全依据——预取旧值落在 ≤ W 照样被拒',
      'SealGuard(real) create_boundary_W_vs_W_plus_1:W 当日拒绝(sealed_interval),W+1 日通过',
      'SealGuard(real) stale_now_captured_before_lock_refused:函数形式不是安全依据——预取旧值落在 ≤ W 照样被拒',
    ],
    restored: true,
  },
  {
    id: 'stamp_boundary_off_by_one',
    failed: 2,
    skipped: 0,
    killedBy: [
      'SealGuard(mem) create_boundary_W_vs_W_plus_1:W 当日拒绝(sealed_interval),W+1 日通过',
      'SealGuard(real) create_boundary_W_vs_W_plus_1:W 当日拒绝(sealed_interval),W+1 日通过',
    ],
    restored: true,
  },
  {
    id: 'stamp_not_once',
    failed: 2,
    skipped: 0,
    killedBy: [
      'SealGuard(mem) stampFirst 每个区域只取一次时:再次调用返回同一时刻、不再调用 now;无效 now = clock_regressed',
      'SealGuard(real) stampFirst 每个区域只取一次时:再次调用返回同一时刻、不再调用 now;无效 now = clock_regressed',
    ],
    restored: true,
  },
  {
    id: 'region_open_not_enforced',
    failed: 2,
    skipped: 0,
    killedBy: [
      'SealGuard(mem) compact_refused_until_first_audit_attempt_ends:区域存续期间 assertNoOpenRegion = region_open;追加尝试结束(成功或失败)后放行',
      'SealGuard(real) compact_refused_until_first_audit_attempt_ends:区域存续期间 assertNoOpenRegion = region_open;追加尝试结束(成功或失败)后放行',
    ],
    restored: true,
  },
  {
    id: 'foreign_region_accepted',
    failed: 2,
    skipped: 0,
    killedBy: [
      'appendKeyed first(mem) 不是本模块创建的区域 = region_closed(foreign_region)',
      'appendKeyed first(real) 不是本模块创建的区域 = region_closed(foreign_region)',
    ],
    restored: true,
  },
  {
    id: 'audit_begin_any_state',
    failed: 2,
    skipped: 0,
    killedBy: [
      'appendKeyed first(mem) first_append_after_region_closed_refused:关闭后再用同一区域 = region_closed;未 stamp 的区域同样拒绝',
      'appendKeyed first(real) first_append_after_region_closed_refused:关闭后再用同一区域 = region_closed;未 stamp 的区域同样拒绝',
    ],
    restored: true,
  },
  {
    id: 'closing_not_checked',
    failed: 1,
    skipped: 0,
    killedBy: [
      '事务协调器 txn_after_closing_rejected:release 开始后新事务 = txn_closing;对照:release 前的事务正常',
    ],
    restored: true,
  },
  {
    id: 'release_not_waiting',
    failed: 1,
    skipped: 0,
    killedBy: [
      'H1 没有释放屏障的句柄(无 path / root 的最小形状):HeldStore.release 自己等在途事务 release_waits_inflight_without_gate:只有 control.release 的等待可用时仍先等事务、再逆序释放;对照:事务结束后的 release 立即完成',
    ],
    restored: true,
  },
  {
    id: 'release_inside_allowed',
    failed: 1,
    skipped: 0,
    killedBy: [
      '事务协调器 release_inside_own_txn_rejected:本把锁事务回调内调用 release = release_inside_transaction(否则自锁)',
    ],
    restored: true,
  },
  {
    id: 'nested_allowed',
    failed: 1,
    skipped: 0,
    killedBy: ['事务协调器 txn_nested:事务内再开本把锁的事务 = txn_nested(不会自锁)'],
    restored: true,
  },
  {
    id: 'inflight_not_drained',
    failed: 1,
    skipped: 0,
    killedBy: [
      '事务协调器 unawaited_write_release_race:回调里没 await 的写在事务收尾前落定,不漂到事务 / release 之外',
    ],
    restored: true,
  },
  {
    id: 'token_never_expires',
    failed: 1,
    skipped: 0,
    killedBy: [
      '事务协调器 port_escaped_after_txn_before_release:事务结束后捕获的端口再用 = txn_closed(与 nonce 无关,锁仍持有)',
    ],
    restored: true,
  },
  {
    id: 'personal_not_released',
    failed: 6,
    skipped: 0,
    killedBy: [
      '事务协调器 release_waits_inflight_txn / external_release_waits_not_rejected:事务外 release 等在途事务完成,再逆序释放 personal → rsi',
      '事务协调器 release_inside_own_txn_rejected:本把锁事务回调内调用 release = release_inside_transaction(否则自锁)',
      '事务协调器 release_inside_other_lock_txn_not_rejected:别的锁的事务回调内调用本把锁的 release 照常等待并完成',
      '事务协调器 release 开始前已排队的事务照常执行(不是 closing 之后才进来的)',
      '事务协调器 concurrent_release_single_promise:并发多次 release 共享同一个 promise,底层各释放一次',
      '事务协调器 personal 释放失败时 rsi 仍被释放(finally)',
    ],
    restored: true,
  },
  {
    id: 'recover_range_unchecked',
    failed: 3,
    skipped: 0,
    killedBy: [
      'recoverThrough 契约(mem) recover_through_rejects_event_after_W:任一批事件日 > W → 整个调用 out_of_range,零写入;事件日 == W 通过(边界对照)',
      'recoverThrough 契约(real) recover_through_rejects_event_after_W:任一批事件日 > W → 整个调用 out_of_range,零写入;事件日 == W 通过(边界对照)',
      'recoverThrough 契约(real) recover_through_audit_full_still_commits_ledger:审计满(20000 行)时账照样提交——不存在循环依赖',
    ],
    restored: true,
  },
  {
    id: 'audit_precheck_dropped',
    failed: 4,
    skipped: 0,
    killedBy: [
      'applyOnce 契约(mem) 审计满 + 账待提交:账不提交(账后只剩 I/O 失败),cause=audit_full;审计文件与账均不变',
      'applyOnce 契约(real) 审计满 + 账待提交:账不提交(账后只剩 I/O 失败),cause=audit_full;审计文件与账均不变',
      'recoverThrough 契约(mem) recover_through_audit_full_still_commits_ledger:审计满(20000 行)时账照样提交——不存在循环依赖',
      'recoverThrough 契约(real) recover_through_audit_full_still_commits_ledger:审计满(20000 行)时账照样提交——不存在循环依赖',
    ],
    restored: true,
  },
  {
    id: 'audit_key_routes_to_ledger',
    failed: 2,
    skipped: 0,
    killedBy: [
      'applyOnce 契约(mem) audit: 前缀的键只路由到审计、不进账;带账类效果 = unsupported_effect',
      'applyOnce 契约(real) audit: 前缀的键只路由到审计、不进账;带账类效果 = unsupported_effect',
    ],
    restored: true,
  },
  {
    id: 'effect_key_mismatch_ignored',
    failed: 2,
    skipped: 0,
    killedBy: [
      'applyOnce 契约(mem) effect 的 idem_key 与行内 idem_key 不一致 = audit_key_conflict;append_audit 无键 = audit_key_missing',
      'applyOnce 契约(real) effect 的 idem_key 与行内 idem_key 不一致 = audit_key_conflict;append_audit 无键 = audit_key_missing',
    ],
    restored: true,
  },
  {
    id: 'cooldown_boundary_inclusive',
    failed: 2,
    skipped: 0,
    killedBy: [
      '冷却谓词与裁剪 cooldown_equal_today_inactive_and_prunable:at+days == 今日 → 非 active;前一天仍 active',
      '冷却谓词与裁剪 提交时裁已过期冷却;仍 active 的保留',
    ],
    restored: true,
  },
  {
    id: 'lifted_pair_unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'RsiEffectsLedger schema lifted_at 与 lifted_gen 同在同缺;lifted_gen 必须 > vetoed_gen 且 ≤ gen;vetoed_gen ≤ gen',
    ],
    restored: true,
  },
  {
    id: 'months_sum_unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'RsiAuditCompaction schema 合法通过;through 可为 null;lines ≠ deleted + derived_missing / by_kind 和 ≠ lines = 不合规;月键格式;gen ≥ 1;非真实日期',
    ],
    restored: true,
  },
  {
    id: 'applied_dup_allowed',
    failed: 1,
    skipped: 0,
    killedBy: [
      'RsiEffectsLedger schema 重复:黑名单 (id,sha)、墓碑 id、冷却 (cluster,kind)、applied key 各自重复 = duplicate;对照:不同键不算',
    ],
    restored: true,
  },
  {
    id: 'fs_name_unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      '真实文件端口 safeStoreFs fs_port_name_escape:文件名含路径分隔符 / 上跳 = store_io(bad_file_name)',
    ],
    restored: true,
  },
  {
    id: 'ops_not_serialized',
    failed: 1,
    skipped: 0,
    killedBy: [
      '事务协调器 ops_inside_txn_serialized:同一事务内并发的 commit 被串行——第二个在第一个提交后读到新 gen 而被拒,不争用 .tmp',
    ],
    restored: true,
  },
  {
    id: 'transition_sum_unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'RsiAuditCompaction schema 合法通过;through 可为 null;lines ≠ deleted + derived_missing / by_kind 和 ≠ lines = 不合规;月键格式;gen ≥ 1;非真实日期',
    ],
    restored: true,
  },
  {
    id: 'recover_dependent_satisfied',
    failed: 2,
    skipped: 0,
    killedBy: [
      'recoverThrough 契约(mem) recover_dependent_satisfied_not_reported:依赖本次未提交修改的「满足」不得报成 satisfied;提交成功时同批一起 committed(对照)',
      'recoverThrough 契约(real) recover_dependent_satisfied_not_reported:依赖本次未提交修改的「满足」不得报成 satisfied;提交成功时同批一起 committed(对照)',
    ],
    restored: true,
  },
  {
    id: 'compaction_write_unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      '后端 compaction 读写 writeCompaction 与读侧同一份语义:through ≥ 今日 / 水位线回退 = compaction_unsupported(不写出读不回的文件)',
    ],
    restored: true,
  },
  {
    id: 'compaction_regress_allowed',
    failed: 1,
    skipped: 0,
    killedBy: [
      '后端 compaction 读写 writeCompaction 与读侧同一份语义:through ≥ 今日 / 水位线回退 = compaction_unsupported(不写出读不回的文件)',
    ],
    restored: true,
  },
  {
    id: 'utf8_lenient',
    failed: 2,
    skipped: 0,
    killedBy: [
      '后端 compaction 读写 账 / 压缩文件含非法 UTF-8 = 严格解码失败(utf8),不静默替换后被覆盖',
      '后端 compaction 读写 审计文件不是合法 UTF-8 = audit_bad_line(utf8)',
    ],
    restored: true,
  },
  {
    id: 'control_not_shared',
    failed: 6,
    skipped: 0,
    killedBy: [
      'H1 同一 acquisition 重复装配共享控制块 same_acquisition_two_helds_serialized:同一组句柄装配两个 HeldStore,并发事务仍串行;对照:两个不同 acquisition 可并行',
      'H1 同一 acquisition 重复装配共享控制块 shared_closing_and_release:一个 HeldStore release 后,同一 acquisition 的另一个 HeldStore 也 closing(txn_closing),release 共享同一 promise、底层各释放一次',
      'H1 真实句柄的 release 也经释放屏障 raw_release_waits_for_paused_commit:提交暂停在 commitTmp 之前,外层调用原始 rsi.release() → 等事务提交完才真正释放;之后新事务 txn_closing',
      'H1 真实句柄的 release 也经释放屏障 raw_release_inside_own_txn_rejected:事务回调内调用原始 release = release_inside_transaction(锁保持);对照:事务外同一调用正常释放',
      'H1 真实句柄的 release 也经释放屏障 real_handles_same_acquisition_serialized_and_raw_release_gated:真实句柄:重复装配串行;原始 release 等在途事务,锁文件在事务结束后才删',
      'R2 真实句柄的锁种类身份 / 屏障原子占用 / 区域注册表随 acquisition 共享 registry_shared_per_acquisition:同一对句柄装配两次共用同一张区域注册表(A 开的区域 B 看得见);为同一 acquisition 配另一张表 = registry_conflict 且那张表不被绑定;别的 acquisition 互不影响',
    ],
    restored: true,
  },
  {
    id: 'rsi_gate_not_attached',
    failed: 5,
    skipped: 0,
    killedBy: [
      'H1 真实句柄的 release 也经释放屏障 raw_release_waits_for_paused_commit:提交暂停在 commitTmp 之前,外层调用原始 rsi.release() → 等事务提交完才真正释放;之后新事务 txn_closing',
      'H1 真实句柄的 release 也经释放屏障 raw_release_inside_own_txn_rejected:事务回调内调用原始 release = release_inside_transaction(锁保持);对照:事务外同一调用正常释放',
      'H1 真实句柄的 release 也经释放屏障 real_handles_same_acquisition_serialized_and_raw_release_gated:真实句柄:重复装配串行;原始 release 等在途事务,锁文件在事务结束后才删',
      'R2 真实句柄的锁种类身份 / 屏障原子占用 / 区域注册表随 acquisition 共享 real_rsi_lock_cannot_pose_as_personal:另一个项目的真实 rsi 锁当 personal 装配 = personal_kind(锁种类是正向验证,不是「不在当前 root 下」);对照:真实 personal 句柄可装配;拒绝后两把句柄都没被挂屏障',
      'R2 真实句柄的锁种类身份 / 屏障原子占用 / 区域注册表随 acquisition 共享 gate_install_is_atomic:personal 句柄已被别的屏障占着 → 装配被拒(release_gate_taken)且 rsi 句柄没被动过;换一个新取的 personal 后能重新装配、事务与释放正常(对照:半绑定下重试会被 rsi 句柄拒绝)',
    ],
    restored: true,
  },
  {
    id: 'raw_release_inside_txn_allowed',
    failed: 1,
    skipped: 0,
    killedBy: [
      'H1 真实句柄的 release 也经释放屏障 raw_release_inside_own_txn_rejected:事务回调内调用原始 release = release_inside_transaction(锁保持);对照:事务外同一调用正常释放',
    ],
    restored: true,
  },
  {
    id: 'identity_rsi_path_unchecked',
    failed: 2,
    skipped: 0,
    killedBy: [
      'H1 LockCap 的 root / 锁种类 / acquisition 校验 rsi 路径不是 <root>/lock(例如把槽位锁 digests/lock 当 rsi 锁)= rsi_root',
      'H1 LockCap 的 root / 锁种类 / acquisition 校验 角色互换(personal 句柄当 rsi 锁)= rsi_root;personal 路径落在 root 之下 / 等于 rsi 路径 = personal_kind',
    ],
    restored: true,
  },
  {
    id: 'identity_personal_kind_unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'H1 LockCap 的 root / 锁种类 / acquisition 校验 角色互换(personal 句柄当 rsi 锁)= rsi_root;personal 路径落在 root 之下 / 等于 rsi 路径 = personal_kind',
    ],
    restored: true,
  },
  {
    id: 'identity_half_allowed',
    failed: 1,
    skipped: 0,
    killedBy: [
      'H1 LockCap 的 root / 锁种类 / acquisition 校验 只给一半身份 = identity_half(锁带 path 而 fs 没有 root,或相反,或只有一把锁带 path);对照:都不给(测试假件)可装配',
    ],
    restored: true,
  },
  {
    id: 'same_cap_allowed',
    failed: 1,
    skipped: 0,
    killedBy: [
      'H1 LockCap 的 root / 锁种类 / acquisition 校验 同一个句柄同时当 rsi 与 personal = same_cap',
    ],
    restored: true,
  },
  {
    id: 'acquisition_conflict_allowed',
    failed: 1,
    skipped: 0,
    killedBy: [
      'H1 LockCap 的 root / 锁种类 / acquisition 校验 acquisition_conflict:句柄已绑给别的组合(换搭档 / 角色互换)= 拒绝且不给新句柄挂屏障;对照:原组合照常可用',
    ],
    restored: true,
  },
  {
    id: 'audit_read_whole_file_utf8',
    failed: 6,
    skipped: 0,
    killedBy: [
      'H2 撕裂尾按字节恢复(短写停在多字节 UTF-8 字符内部) (mem) short_write_mid_multibyte_char_recovers:尾部停在字符第 1 个字节,读侧报撕裂尾(不整文件解码失败),下一次追加先修尾再写,旧行不丢',
      'H2 撕裂尾按字节恢复(短写停在多字节 UTF-8 字符内部) (mem) short_write_mid_multibyte_char_recovers:尾部停在字符第 2 个字节,读侧报撕裂尾(不整文件解码失败),下一次追加先修尾再写,旧行不丢',
      'H2 撕裂尾按字节恢复(短写停在多字节 UTF-8 字符内部) (mem) 对照:完整文件(含多字节字符、以换行结尾)不报撕裂尾;只有尾部字节(无任何完整行)也是撕裂尾,goodText 为空',
      'H2 撕裂尾按字节恢复(短写停在多字节 UTF-8 字符内部) (real) short_write_mid_multibyte_char_recovers:尾部停在字符第 1 个字节,读侧报撕裂尾(不整文件解码失败),下一次追加先修尾再写,旧行不丢',
      'H2 撕裂尾按字节恢复(短写停在多字节 UTF-8 字符内部) (real) short_write_mid_multibyte_char_recovers:尾部停在字符第 2 个字节,读侧报撕裂尾(不整文件解码失败),下一次追加先修尾再写,旧行不丢',
      'H2 撕裂尾按字节恢复(短写停在多字节 UTF-8 字符内部) (real) 对照:完整文件(含多字节字符、以换行结尾)不报撕裂尾;只有尾部字节(无任何完整行)也是撕裂尾,goodText 为空',
    ],
    restored: true,
  },
  {
    id: 'torn_flag_ignored',
    failed: 7,
    skipped: 0,
    killedBy: [
      'H2 撕裂尾按字节恢复(短写停在多字节 UTF-8 字符内部) classifyAuditFile(text, tornTail):后端确认有尾部字节时,完整行之后即撕裂尾(goodText = 完整行);默认仍为 ok',
      'H2 撕裂尾按字节恢复(短写停在多字节 UTF-8 字符内部) (mem) short_write_mid_multibyte_char_recovers:尾部停在字符第 1 个字节,读侧报撕裂尾(不整文件解码失败),下一次追加先修尾再写,旧行不丢',
      'H2 撕裂尾按字节恢复(短写停在多字节 UTF-8 字符内部) (mem) short_write_mid_multibyte_char_recovers:尾部停在字符第 2 个字节,读侧报撕裂尾(不整文件解码失败),下一次追加先修尾再写,旧行不丢',
      'H2 撕裂尾按字节恢复(短写停在多字节 UTF-8 字符内部) (mem) 对照:完整文件(含多字节字符、以换行结尾)不报撕裂尾;只有尾部字节(无任何完整行)也是撕裂尾,goodText 为空',
      'H2 撕裂尾按字节恢复(短写停在多字节 UTF-8 字符内部) (real) short_write_mid_multibyte_char_recovers:尾部停在字符第 1 个字节,读侧报撕裂尾(不整文件解码失败),下一次追加先修尾再写,旧行不丢',
      'H2 撕裂尾按字节恢复(短写停在多字节 UTF-8 字符内部) (real) short_write_mid_multibyte_char_recovers:尾部停在字符第 2 个字节,读侧报撕裂尾(不整文件解码失败),下一次追加先修尾再写,旧行不丢',
      'H2 撕裂尾按字节恢复(短写停在多字节 UTF-8 字符内部) (real) 对照:完整文件(含多字节字符、以换行结尾)不报撕裂尾;只有尾部字节(无任何完整行)也是撕裂尾,goodText 为空',
    ],
    restored: true,
  },
  {
    id: 'complete_lines_lenient_utf8',
    failed: 2,
    skipped: 0,
    killedBy: [
      'H2 撕裂尾按字节恢复(短写停在多字节 UTF-8 字符内部) (mem) complete_line_invalid_utf8_still_fail_closed:完整行里的非法 UTF-8 仍 fail-closed(audit_bad_line / utf8),即使末尾同时有撕裂尾;文件字节不动',
      'H2 撕裂尾按字节恢复(短写停在多字节 UTF-8 字符内部) (real) complete_line_invalid_utf8_still_fail_closed:完整行里的非法 UTF-8 仍 fail-closed(audit_bad_line / utf8),即使末尾同时有撕裂尾;文件字节不动',
    ],
    restored: true,
  },
  {
    id: 'satisfied_key_not_registered',
    failed: 9,
    skipped: 0,
    killedBy: [
      'H3 状态无变化的批登记身份 planLedgerBatch:registerSatisfiedKey=true 时「状态已满足、键未登记」= commit 且键入 applied;缺省(恢复路径)= satisfied 零写',
      'H3 状态无变化的批登记身份 applyOnce(mem) noop_then_conflicting_content:空操作(已过期冷却不插入)也登记键;同键异内容随后 = effects_key_conflict 且零写入;对照:同键同内容 = satisfied',
      'H3 状态无变化的批登记身份 applyOnce(mem) established_by_other_key_registers_identity:对象已由别的键建立,本批状态空操作 → 登记并提交;随后同键异内容 = 冲突',
      'H3 状态无变化的批登记身份 applyOnce(mem) registration_under_watermark_not_committed:事件日 ≤ 水位线的空操作批不登记(键本就会被裁)= satisfied 零写;对照:无水位线时登记',
      'H3 状态无变化的批登记身份 applyOnce(mem) user_veto_noop_registers_key:否决项已由别的键建立时,用户否决登记 veto: 键并提交;再否决 = satisfied 零写',
      'H3 状态无变化的批登记身份 applyOnce(real) noop_then_conflicting_content:空操作(已过期冷却不插入)也登记键;同键异内容随后 = effects_key_conflict 且零写入;对照:同键同内容 = satisfied',
      'H3 状态无变化的批登记身份 applyOnce(real) established_by_other_key_registers_identity:对象已由别的键建立,本批状态空操作 → 登记并提交;随后同键异内容 = 冲突',
      'H3 状态无变化的批登记身份 applyOnce(real) registration_under_watermark_not_committed:事件日 ≤ 水位线的空操作批不登记(键本就会被裁)= satisfied 零写;对照:无水位线时登记',
      'H3 状态无变化的批登记身份 applyOnce(real) user_veto_noop_registers_key:否决项已由别的键建立时,用户否决登记 veto: 键并提交;再否决 = satisfied 零写',
    ],
    restored: true,
  },
  {
    id: 'apply_once_not_registering',
    failed: 8,
    skipped: 0,
    killedBy: [
      'UserVetoPort 与 lift 语义(mem) lift_replay_after_prune_noop:lift 之后 replay(键在 / 键已丢)都不复活',
      'UserVetoPort 与 lift 语义(real) lift_replay_after_prune_noop:lift 之后 replay(键在 / 键已丢)都不复活',
      'H3 状态无变化的批登记身份 applyOnce(mem) noop_then_conflicting_content:空操作(已过期冷却不插入)也登记键;同键异内容随后 = effects_key_conflict 且零写入;对照:同键同内容 = satisfied',
      'H3 状态无变化的批登记身份 applyOnce(mem) established_by_other_key_registers_identity:对象已由别的键建立,本批状态空操作 → 登记并提交;随后同键异内容 = 冲突',
      'H3 状态无变化的批登记身份 applyOnce(mem) registration_under_watermark_not_committed:事件日 ≤ 水位线的空操作批不登记(键本就会被裁)= satisfied 零写;对照:无水位线时登记',
      'H3 状态无变化的批登记身份 applyOnce(real) noop_then_conflicting_content:空操作(已过期冷却不插入)也登记键;同键异内容随后 = effects_key_conflict 且零写入;对照:同键同内容 = satisfied',
      'H3 状态无变化的批登记身份 applyOnce(real) established_by_other_key_registers_identity:对象已由别的键建立,本批状态空操作 → 登记并提交;随后同键异内容 = 冲突',
      'H3 状态无变化的批登记身份 applyOnce(real) registration_under_watermark_not_committed:事件日 ≤ 水位线的空操作批不登记(键本就会被裁)= satisfied 零写;对照:无水位线时登记',
    ],
    restored: true,
  },
  {
    id: 'user_veto_not_registering',
    failed: 2,
    skipped: 0,
    killedBy: [
      'H3 状态无变化的批登记身份 applyOnce(mem) user_veto_noop_registers_key:否决项已由别的键建立时,用户否决登记 veto: 键并提交;再否决 = satisfied 零写',
      'H3 状态无变化的批登记身份 applyOnce(real) user_veto_noop_registers_key:否决项已由别的键建立时,用户否决登记 veto: 键并提交;再否决 = satisfied 零写',
    ],
    restored: true,
  },
  {
    id: 'recover_registers_keys',
    failed: 6,
    skipped: 0,
    killedBy: [
      'H3 状态无变化的批登记身份 applyOnce(mem) recover_through_does_not_register:压缩前恢复只按状态判 satisfied、不登记身份(事件日 ≤ 即将推进的 W);账字节不变',
      'H3 状态无变化的批登记身份 applyOnce(real) recover_through_does_not_register:压缩前恢复只按状态判 satisfied、不登记身份(事件日 ≤ 即将推进的 W);账字节不变',
      'R2 recoverThrough 同次调用内的同键冲突 / userVeto 维护性写入(mem) recover_same_call_key_conflict_after_satisfied:同一次恢复里第一批(键 K,状态已满足)之后同键异内容的第二批 = 该批 effects_key_conflict,账字节不变;对照:同键同内容 / 异键异内容都正常',
      'R2 recoverThrough 同次调用内的同键冲突 / userVeto 维护性写入(mem) recover_same_call_empty_batch_key_identity:同一次恢复里没有账类效果的批也占键身份——空批之后同键非空批、非空批之后同键空批都是 effects_key_conflict,账字节不变;对照:同键两个空批 / 空批后异键非空批都正常',
      'R2 recoverThrough 同次调用内的同键冲突 / userVeto 维护性写入(real) recover_same_call_key_conflict_after_satisfied:同一次恢复里第一批(键 K,状态已满足)之后同键异内容的第二批 = 该批 effects_key_conflict,账字节不变;对照:同键同内容 / 异键异内容都正常',
      'R2 recoverThrough 同次调用内的同键冲突 / userVeto 维护性写入(real) recover_same_call_empty_batch_key_identity:同一次恢复里没有账类效果的批也占键身份——空批之后同键非空批、非空批之后同键空批都是 effects_key_conflict,账字节不变;对照:同键两个空批 / 空批后异键非空批都正常',
    ],
    restored: true,
  },
  {
    id: 'capacity_before_audit_validation',
    failed: 4,
    skipped: 0,
    killedBy: [
      'M1 审计内容校验先于容量结果(mem) capacity_masks_audit_conflict_fixed:账满时,与文件内同键异内容的审计行 = audit_key_conflict(不被 effects_full 掩盖);对照:无冲突时才返回 effects_full',
      'M1 审计内容校验先于容量结果(mem) 账满时,审计文件有坏行 / 重复键也先报完整性错误(audit_bad_line / audit_dup_key);对照:干净文件 → effects_full',
      'M1 审计内容校验先于容量结果(real) capacity_masks_audit_conflict_fixed:账满时,与文件内同键异内容的审计行 = audit_key_conflict(不被 effects_full 掩盖);对照:无冲突时才返回 effects_full',
      'M1 审计内容校验先于容量结果(real) 账满时,审计文件有坏行 / 重复键也先报完整性错误(audit_bad_line / audit_dup_key);对照:干净文件 → effects_full',
    ],
    restored: true,
  },
  {
    id: 'stamp_binding_unchecked',
    failed: 2,
    skipped: 0,
    killedBy: [
      'M2 SealRegion 绑定 acquisition 与 stamp(mem) first_rows_must_use_stamp_time:行 at 与区域 stamp 不一致 = stamp_mismatch,零写入、区域仍被关闭;对照:一致则 appended',
      'M2 SealRegion 绑定 acquisition 与 stamp(real) first_rows_must_use_stamp_time:行 at 与区域 stamp 不一致 = stamp_mismatch,零写入、区域仍被关闭;对照:一致则 appended',
    ],
    restored: true,
  },
  {
    id: 'region_registry_unchecked',
    failed: 2,
    skipped: 0,
    killedBy: [
      'M2 SealRegion 绑定 acquisition 与 stamp(mem) foreign_store_region_rejected:别的存储域(另一 acquisition)创建的区域 = region_closed(foreign_region),该区域状态不被改动;对照:本域区域可用',
      'M2 SealRegion 绑定 acquisition 与 stamp(real) foreign_store_region_rejected:别的存储域(另一 acquisition)创建的区域 = region_closed(foreign_region),该区域状态不被改动;对照:本域区域可用',
    ],
    restored: true,
  },
  {
    id: 'registry_domain_unbound',
    failed: 3,
    skipped: 0,
    killedBy: [
      'H1 LockCap 的 root / 锁种类 / acquisition 校验 registry_foreign_first_assembly_no_binding:首次装配传入别的 acquisition 的注册表 = registry_foreign,且两把句柄都没被占用(rsi 换搭档仍可装配、personal 释放不经屏障);对照:同样的句柄不传注册表可装配',
      'M2 SealRegion 绑定 acquisition 与 stamp(mem) registry_bound_to_acquisition:别的 acquisition 的注册表不能用于本域装配(lock_cap_mismatch / registry_foreign);对照:同一 acquisition 共享注册表可装配',
      'M2 SealRegion 绑定 acquisition 与 stamp(real) registry_bound_to_acquisition:别的 acquisition 的注册表不能用于本域装配(lock_cap_mismatch / registry_foreign);对照:同一 acquisition 共享注册表可装配',
    ],
    restored: true,
  },
  {
    id: 'maintenance_prune_applied_skipped',
    failed: 1,
    skipped: 0,
    killedBy: [
      'M3 没有新状态的批也能裁过期冷却 / 水位线覆盖的 applied watermark_covered_applied_pruned_by_noop_batch:被水位线覆盖的 applied 键在空操作批里删除;对照:无水位线 = satisfied',
    ],
    restored: true,
  },
  {
    id: 'plan_batch_early_satisfied',
    failed: 7,
    skipped: 0,
    killedBy: [
      'M3 没有新状态的批也能裁过期冷却 / 水位线覆盖的 applied expired_cooldown_pruned_by_noop_batch:状态已满足的批提交时裁掉过期冷却(gen +1,其余字段不变);对照:冷却仍 active 时 = satisfied 零写',
      'M3 没有新状态的批也能裁过期冷却 / 水位线覆盖的 applied 满账(2000 条过期冷却)上的空操作批也能腾出条数;对照:全部仍 active 则不动',
      'M3 没有新状态的批也能裁过期冷却 / 水位线覆盖的 applied watermark_covered_applied_pruned_by_noop_batch:被水位线覆盖的 applied 键在空操作批里删除;对照:无水位线 = satisfied',
      'M3 没有新状态的批也能裁过期冷却 / 水位线覆盖的 applied 经 applyOnce / recoverThrough(mem) applyOnce 同键重放(already)也做维护提交:过期冷却被裁、gen +1,结果仍报批次自己的结论 satisfied(与 recoverThrough 一致);随后再重放 = satisfied 零写',
      'M3 没有新状态的批也能裁过期冷却 / 水位线覆盖的 applied 经 applyOnce / recoverThrough(real) applyOnce 同键重放(already)也做维护提交:过期冷却被裁、gen +1,结果仍报批次自己的结论 satisfied(与 recoverThrough 一致);随后再重放 = satisfied 零写',
      'R2 recoverThrough 同次调用内的同键冲突 / userVeto 维护性写入(mem) user_veto_maintenance_only_reports_satisfied:否决自身已满足、只有维护性写入(过期冷却被裁)= ledger:satisfied 但账确实被写(satisfied ≠ 零写盘);对照:全新否决 = committed',
      'R2 recoverThrough 同次调用内的同键冲突 / userVeto 维护性写入(real) user_veto_maintenance_only_reports_satisfied:否决自身已满足、只有维护性写入(过期冷却被裁)= ledger:satisfied 但账确实被写(satisfied ≠ 零写盘);对照:全新否决 = committed',
    ],
    restored: true,
  },
  {
    id: 'recover_noop_no_maintenance',
    failed: 2,
    skipped: 0,
    killedBy: [
      'M3 没有新状态的批也能裁过期冷却 / 水位线覆盖的 applied 经 applyOnce / recoverThrough(mem) recoverThrough 全部 satisfied 时也提交维护性变化(结果仍是 satisfied);对照:无过期冷却 = 账字节不变',
      'M3 没有新状态的批也能裁过期冷却 / 水位线覆盖的 applied 经 applyOnce / recoverThrough(real) recoverThrough 全部 satisfied 时也提交维护性变化(结果仍是 satisfied);对照:无过期冷却 = 账字节不变',
    ],
    restored: true,
  },
  {
    id: 'personal_kind_not_checked',
    failed: 2,
    skipped: 0,
    killedBy: [
      'R2 真实句柄的锁种类身份 / 屏障原子占用 / 区域注册表随 acquisition 共享 real_rsi_lock_cannot_pose_as_personal:另一个项目的真实 rsi 锁当 personal 装配 = personal_kind(锁种类是正向验证,不是「不在当前 root 下」);对照:真实 personal 句柄可装配;拒绝后两把句柄都没被挂屏障',
      'R2 真实句柄的锁种类身份 / 屏障原子占用 / 区域注册表随 acquisition 共享 kind_must_match_role:带 path / root 的真实形状里锁种类缺失 = rsi_kind / personal_kind;声明了但与角色不符 = 同码;假件(无 path / root)声明了错的种类也拒绝',
    ],
    restored: true,
  },
  {
    id: 'real_shape_kind_not_required',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R2 真实句柄的锁种类身份 / 屏障原子占用 / 区域注册表随 acquisition 共享 kind_must_match_role:带 path / root 的真实形状里锁种类缺失 = rsi_kind / personal_kind;声明了但与角色不符 = 同码;假件(无 path / root)声明了错的种类也拒绝',
    ],
    restored: true,
  },
  {
    id: 'rsi_kind_not_checked',
    failed: 2,
    skipped: 0,
    killedBy: [
      'R2 真实句柄的锁种类身份 / 屏障原子占用 / 区域注册表随 acquisition 共享 real_rsi_lock_cannot_pose_as_personal:另一个项目的真实 rsi 锁当 personal 装配 = personal_kind(锁种类是正向验证,不是「不在当前 root 下」);对照:真实 personal 句柄可装配;拒绝后两把句柄都没被挂屏障',
      'R2 真实句柄的锁种类身份 / 屏障原子占用 / 区域注册表随 acquisition 共享 kind_must_match_role:带 path / root 的真实形状里锁种类缺失 = rsi_kind / personal_kind;声明了但与角色不符 = 同码;假件(无 path / root)声明了错的种类也拒绝',
    ],
    restored: true,
  },
  {
    id: 'recover_seen_table_dropped',
    failed: 4,
    skipped: 0,
    killedBy: [
      'R2 recoverThrough 同次调用内的同键冲突 / userVeto 维护性写入(mem) recover_same_call_key_conflict_after_satisfied:同一次恢复里第一批(键 K,状态已满足)之后同键异内容的第二批 = 该批 effects_key_conflict,账字节不变;对照:同键同内容 / 异键异内容都正常',
      'R2 recoverThrough 同次调用内的同键冲突 / userVeto 维护性写入(mem) recover_same_call_empty_batch_key_identity:同一次恢复里没有账类效果的批也占键身份——空批之后同键非空批、非空批之后同键空批都是 effects_key_conflict,账字节不变;对照:同键两个空批 / 空批后异键非空批都正常',
      'R2 recoverThrough 同次调用内的同键冲突 / userVeto 维护性写入(real) recover_same_call_key_conflict_after_satisfied:同一次恢复里第一批(键 K,状态已满足)之后同键异内容的第二批 = 该批 effects_key_conflict,账字节不变;对照:同键同内容 / 异键异内容都正常',
      'R2 recoverThrough 同次调用内的同键冲突 / userVeto 维护性写入(real) recover_same_call_empty_batch_key_identity:同一次恢复里没有账类效果的批也占键身份——空批之后同键非空批、非空批之后同键空批都是 effects_key_conflict,账字节不变;对照:同键两个空批 / 空批后异键非空批都正常',
    ],
    restored: true,
  },
  {
    id: 'recover_seen_table_not_shared',
    failed: 4,
    skipped: 0,
    killedBy: [
      'R2 recoverThrough 同次调用内的同键冲突 / userVeto 维护性写入(mem) recover_same_call_key_conflict_after_satisfied:同一次恢复里第一批(键 K,状态已满足)之后同键异内容的第二批 = 该批 effects_key_conflict,账字节不变;对照:同键同内容 / 异键异内容都正常',
      'R2 recoverThrough 同次调用内的同键冲突 / userVeto 维护性写入(mem) recover_same_call_empty_batch_key_identity:同一次恢复里没有账类效果的批也占键身份——空批之后同键非空批、非空批之后同键空批都是 effects_key_conflict,账字节不变;对照:同键两个空批 / 空批后异键非空批都正常',
      'R2 recoverThrough 同次调用内的同键冲突 / userVeto 维护性写入(real) recover_same_call_key_conflict_after_satisfied:同一次恢复里第一批(键 K,状态已满足)之后同键异内容的第二批 = 该批 effects_key_conflict,账字节不变;对照:同键同内容 / 异键异内容都正常',
      'R2 recoverThrough 同次调用内的同键冲突 / userVeto 维护性写入(real) recover_same_call_empty_batch_key_identity:同一次恢复里没有账类效果的批也占键身份——空批之后同键非空批、非空批之后同键空批都是 effects_key_conflict,账字节不变;对照:同键两个空批 / 空批后异键非空批都正常',
    ],
    restored: true,
  },
  {
    id: 'registry_not_shared_per_acquisition',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R2 真实句柄的锁种类身份 / 屏障原子占用 / 区域注册表随 acquisition 共享 registry_shared_per_acquisition:同一对句柄装配两次共用同一张区域注册表(A 开的区域 B 看得见);为同一 acquisition 配另一张表 = registry_conflict 且那张表不被绑定;别的 acquisition 互不影响',
    ],
    restored: true,
  },
  {
    id: 'registry_conflict_not_rejected',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R2 真实句柄的锁种类身份 / 屏障原子占用 / 区域注册表随 acquisition 共享 registry_shared_per_acquisition:同一对句柄装配两次共用同一张区域注册表(A 开的区域 B 看得见);为同一 acquisition 配另一张表 = registry_conflict 且那张表不被绑定;别的 acquisition 互不影响',
    ],
    restored: true,
  },
  {
    id: 'gate_precheck_skipped',
    failed: 2,
    skipped: 0,
    killedBy: [
      'H1 LockCap 的 root / 锁种类 / acquisition 校验 句柄已挂了别的屏障 = 拒绝(同一句柄只接受同一个屏障;预检先于占用,不静默覆盖),原因钉在 release_gate_taken;对照:屏障槽空的假件可装配',
      'R2 真实句柄的锁种类身份 / 屏障原子占用 / 区域注册表随 acquisition 共享 gate_install_is_atomic:personal 句柄已被别的屏障占着 → 装配被拒(release_gate_taken)且 rsi 句柄没被动过;换一个新取的 personal 后能重新装配、事务与释放正常(对照:半绑定下重试会被 rsi 句柄拒绝)',
    ],
    restored: true,
  },
  {
    id: 'user_veto_maintenance_reports_committed',
    failed: 2,
    skipped: 0,
    killedBy: [
      'R2 recoverThrough 同次调用内的同键冲突 / userVeto 维护性写入(mem) user_veto_maintenance_only_reports_satisfied:否决自身已满足、只有维护性写入(过期冷却被裁)= ledger:satisfied 但账确实被写(satisfied ≠ 零写盘);对照:全新否决 = committed',
      'R2 recoverThrough 同次调用内的同键冲突 / userVeto 维护性写入(real) user_veto_maintenance_only_reports_satisfied:否决自身已满足、只有维护性写入(过期冷却被裁)= ledger:satisfied 但账确实被写(satisfied ≠ 零写盘);对照:全新否决 = committed',
    ],
    restored: true,
  },
  {
    id: 'recover_empty_batch_skips_identity',
    failed: 2,
    skipped: 0,
    killedBy: [
      'R2 recoverThrough 同次调用内的同键冲突 / userVeto 维护性写入(mem) recover_same_call_empty_batch_key_identity:同一次恢复里没有账类效果的批也占键身份——空批之后同键非空批、非空批之后同键空批都是 effects_key_conflict,账字节不变;对照:同键两个空批 / 空批后异键非空批都正常',
      'R2 recoverThrough 同次调用内的同键冲突 / userVeto 维护性写入(real) recover_same_call_empty_batch_key_identity:同一次恢复里没有账类效果的批也占键身份——空批之后同键非空批、非空批之后同键空批都是 effects_key_conflict,账字节不变;对照:同键两个空批 / 空批后异键非空批都正常',
    ],
    restored: true,
  },
  {
    id: 'registry_foreign_checked_after_binding',
    failed: 1,
    skipped: 0,
    killedBy: [
      'H1 LockCap 的 root / 锁种类 / acquisition 校验 registry_foreign_first_assembly_no_binding:首次装配传入别的 acquisition 的注册表 = registry_foreign,且两把句柄都没被占用(rsi 换搭档仍可装配、personal 释放不经屏障);对照:同样的句柄不传注册表可装配',
    ],
    restored: true,
  },
];
