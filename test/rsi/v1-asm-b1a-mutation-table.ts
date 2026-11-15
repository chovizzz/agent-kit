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
        "if (!changed) return 'satisfied';",
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
    mustKill: ['first_has_no_compacted_return'],
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
    expectRed: ['同键内容规则:默认含 at;唯一例外是终态空操作行'],
    mustKill: ['同键内容规则:默认含 at;唯一例外是终态空操作行'],
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
    edits: [swap('src/rsi/store/seal.ts', 'if (!(region instanceof RegionImpl))', 'if (false)')],
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
        'src/rsi/store/txn.ts',
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
    edits: [swap('src/rsi/store/txn.ts', 'await tail;', ';')],
    tests: ['rsi/store/txn.test.ts'],
    expectRed: ['release_waits_inflight_txn'],
    mustKill: ['release_waits_inflight_txn'],
  },
  {
    id: 'release_inside_allowed',
    clause: 'W0-26 §12 事务内 release 拒绝',
    edits: [
      swap(
        'src/rsi/store/txn.ts',
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
        'src/rsi/store/txn.ts',
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
      swap('src/rsi/store/txn.ts', 'await deps.personal.release();', 'await Promise.resolve();'),
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
    edits: [
      swap(
        'src/rsi/store/backend.ts',
        'if (cur?.through != null && (next.through === null || next.through < cur.through)) {',
        'if (false) {',
      ),
    ],
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
];

/** 由主代理整表执行变异后回填 */
export const V1_ASM_B1A_RESULTS: readonly V1AsmB1aResult[] = [];
