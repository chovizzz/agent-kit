/**
 * §21 V1 W7 必杀变异(回滚四段与 journal、撤销凭据写入方、缩减入口 clear、熔断、效果续做、反向取锁守卫、harm 串接;契约 R21-3.3 / R21-9.1 / 9.2 / 9.3a /
 * 9.5 / 9.6 / R21-10、§21.24 W0-15 / W0-16 / W0-17)。
 * 执行方式同 W5 / W6:验证机私有检出里 cp 备份 → 按锚点替换(每个锚点在对应文件里**恰好出现一次**)→ 跑 `tests` → 失败集合非空、全部命中 `expectRed`、
 * `mustKill` 每项至少命中一个、没有 skipped → cp 还原并逐文件 sha256 核对。**不用 git checkout / stash 还原**。
 * 本文件只写表与每条变异期望红的测试名(`expectRed` 是杀手测试名里的字面子串,参数化用例只取 `%s` 之外的固定片段);变异由主代理执行,
 * 结果记进 `V1_W7_RESULTS`(W7 实装块不执行变异,故留空)。变异 id 用短的下划线词。
 *
 * 不可变异的点(如实记录):`rollbackTxnId` 里 kind 常量(只影响 id 的哈希值,不影响任何可见行为);journal 写入的 `at` 时间戳;
 * `appendRevocations` 的整文件原子重写由 W2 的用例钉住(本块不改)。
 */
export interface Edit {
  file: string;
  anchor: string;
  replacement: string;
}

export interface V1W7Mutation {
  id: string;
  /** 契约条款 / 该不变量 */
  clause: string;
  edits: readonly Edit[];
  /** 相对 `test/` */
  tests: readonly string[];
  expectRed: readonly string[];
  mustKill: readonly string[];
}

export interface V1W7Result {
  id: string;
  failed: number;
  skipped: number;
  killedBy: readonly string[];
  restored: boolean;
}

const P = 'src/rsi/personal/';
const RB = `${P}rollback.ts`;
const RW = `${P}revoke-write.ts`;
const BR = `${P}breaker.ts`;
const CL = `${P}clear.ts`;
const RR = `${P}rollback-repo.ts`;
const RP = `${P}rollback-ports.ts`;
const ER = `${P}effects-recover.ts`;
const HC = `${P}harm-chain.ts`;
const LK = 'src/rsi/lock.ts';
const PL = `${P}personal-lock.ts`;
const PM = 'src/rsi/canary/pause-marker.ts';

const T_RB = 'rsi/rollback/w7-rollback.test.ts';
const T_CR = 'rsi/rollback/w7-crash.test.ts';
const T_CL = 'rsi/rollback/w7-clear.test.ts';
const T_CU = 'rsi/rollback/w7-clear-unit.test.ts';
const T_BR = 'rsi/rollback/w7-breaker.test.ts';
const T_EF = 'rsi/rollback/w7-effects.test.ts';
const T_RW = 'rsi/rollback/w7-revoke-write.test.ts';
const T_HC = 'rsi/rollback/w7-harm-chain.test.ts';
const T_LK = 'rsi/rollback/w7-lock-order.test.ts';
const T_JN = 'rsi/rollback/w7-journal.test.ts';
const T_PM = 'rsi/rollback/w7-pause-marker.test.ts';

const swap = (file: string, anchor: string, replacement: string): Edit => ({
  file,
  anchor,
  replacement,
});

export const V1_W7_MUTATIONS: readonly V1W7Mutation[] = [
  // ---- R21-9.1 四段与 journal ----
  {
    id: 'rev_criterion_trusted',
    clause: 'R21-9.1 第二段判据:凭据已在盘上(重读,不信写入返回值)',
    edits: [
      swap(
        RB,
        'if (!rv.lines.some((l) => l.candidate_id === t.candidate_id && l.content_sha256 === sha)) {',
        'if (false) {',
      ),
    ],
    tests: [T_RB],
    expectRed: ['第二段判据:凭据从盘上重读'],
    mustKill: ['第二段判据:凭据从盘上重读'],
  },
  {
    id: 'journal_not_advanced',
    clause: 'R21-9.1 / 9.6 journal 的 phase 是执行器进度依据:每段完成后推进',
    edits: [
      swap(
        RB,
        'await d.txns.write(t);\n      await step(d, `journal:${next}`);',
        'await step(d, `journal:${next}`);',
      ),
    ],
    tests: [T_CR, T_RB],
    expectRed: ['journal 领先于记录', '记录领先于 journal'],
    mustKill: ['journal 领先于记录', '记录领先于 journal'],
  },
  {
    id: 'deferred_ignored',
    clause: 'R21-9.3a deferred 下第三段判据改为「本机 payload 已不含该候选」',
    edits: [swap(RB, '    if (!(await d.payload.absent(t.candidate_id))) {', '    if (false) {')],
    tests: [T_RB],
    expectRed: ['deferred 且撤销路径之后 payload 仍含该候选'],
    mustKill: ['deferred 且撤销路径之后 payload 仍含该候选'],
  },
  {
    id: 'record_note_ignored',
    clause: 'R21-9.1 记录没能推进时不删仓库文件(记录仍在生效状态)',
    edits: [
      swap(
        RB,
        "if (part.repo === 'ok' && part.note !== undefined) return { ok: false, why: part.note };",
        '',
      ),
    ],
    tests: [T_RB],
    expectRed: ['V1a 没有 rollback_four_phase'],
    mustKill: ['V1a 没有 rollback_four_phase'],
  },
  {
    id: 'advance_one_step',
    clause: 'R21-9.1 记录的 rollback.phase 逐步追上 journal(落后多段时逐段推进)',
    edits: [
      swap(
        RB,
        'for (const p of PHASES.slice(from + 1, phaseIdx(to) + 1)) {',
        'for (const p of PHASES.slice(from + 1, from + 2)) {',
      ),
    ],
    tests: [T_RB, T_CR],
    expectRed: ['canary + harm → 四段全部完成', '→ resumeAll 续做到终态'],
    mustKill: ['canary + harm → 四段全部完成'],
  },
  {
    id: 'payload_own_only',
    clause: 'R21-9.3a / 9.5 撤销路径目标 = 上次已同步版本减去凭据所列的全部候选',
    edits: [
      swap(
        RB,
        'return [...new Set([...rv.lines.map((l) => l.candidate_id), t.candidate_id])].sort();',
        'return [t.candidate_id];',
      ),
    ],
    tests: [T_RB],
    expectRed: ['第四段:撤销路径的目标'],
    mustKill: ['第四段:撤销路径的目标'],
  },
  {
    id: 'effects_not_landed',
    clause: 'W0-16 终态效果在删 journal 之前经带键落地',
    edits: [
      swap(RB, 'effects = await landTerminalEffects(d.keyedEffects, rec);', "effects = 'none';"),
    ],
    tests: [T_RB, T_EF],
    expectRed: ['canary + harm → 四段全部完成', '回滚执行器:效果落地失败'],
    mustKill: ['canary + harm → 四段全部完成', '回滚执行器:效果落地失败'],
  },
  {
    id: 'step_table_short',
    clause: 'R21-9.6 崩溃注入点表覆盖四个子状态与收尾',
    edits: [swap(RB, "'after:effects',", '')],
    tests: [T_CR],
    expectRed: ['步骤点表覆盖四个子状态与收尾'],
    mustKill: ['步骤点表覆盖四个子状态与收尾'],
  },
  {
    id: 'finish_no_removal_check',
    clause: 'R21-9.3a 分叉期间被推迟的仓库移除在收尾重新检查并补做',
    edits: [
      swap(
        RB,
        "if (rem.status === 'deferred') return deferredDone(`repo_deferred:${rem.why}`);",
        '',
      ),
    ],
    tests: [T_RB],
    expectRed: ['记录可读但仓库提交 deferred'],
    mustKill: ['记录可读但仓库提交 deferred'],
  },
  {
    id: 'late_event_dropped',
    clause: 'R21-4.4a ① 复用在途 txn 时较晚到达的终止事件先于动作施加到权威记录',
    edits: [
      swap(
        RB,
        'const lateWhy = await lateEventStatus(d, event, req.candidate_id);',
        'const lateWhy = null;',
      ),
    ],
    tests: [T_RB],
    expectRed: ['权威记录读不到(deferred):撤销事务照常运行'],
    mustKill: ['权威记录读不到(deferred):撤销事务照常运行'],
  },
  {
    id: 'late_event_failure_ignored',
    clause: '较晚终止事件施加失败(halt / stale / refused)→ 如实标记、不以旧理由静默完成',
    edits: [
      swap(RB, "if (r.kind === 'transitioned' || r.kind === 'noop') return null;", 'return null;'),
    ],
    tests: [T_RB],
    expectRed: ['提交失败(commit_failed):不以旧理由进终态'],
    mustKill: ['提交失败(commit_failed):不以旧理由进终态'],
  },
  {
    id: 'late_event_flag_dropped',
    clause: '较晚终止事件没施加时结果带 lateEventNotApplied(调用方据此重试)',
    edits: [swap(RB, 'return { ...out, lateEventNotApplied: lateWhy };', 'return out;')],
    tests: [T_RB],
    expectRed: ['journal 停在第一段、仓库 deferred 时收到较晚事件', '记录已终态:不再施加'],
    mustKill: ['journal 停在第一段、仓库 deferred 时收到较晚事件'],
  },
  {
    id: 'clear_report_unavailable_only',
    clause: 'R21-9.5 缩减入口先续做在途 journal,报告同时给出续做结果与枚举不可用',
    edits: [swap(CL, 'report.outcomes.push(...(await resumeAll(rd)));', '')],
    tests: [T_CU],
    expectRed: ['有在途 journal 而候选全集读不到'],
    mustKill: ['有在途 journal 而候选全集读不到'],
  },
  {
    id: 'lock_lost_ignored',
    clause: '丢锁(applyEvent 返回 lockLost)后立即停止,不继续任何写出口',
    edits: [
      swap(
        RB,
        "if (r.kind === 'transitioned' && r.lockLost === true) throw new RsiLockError('lock_lost');",
        '',
      ),
    ],
    tests: [T_RB],
    expectRed: ['第三段记录提交后发现丢锁'],
    mustKill: ['第三段记录提交后发现丢锁'],
  },
  {
    id: 'deferred_no_revoke',
    clause: 'R21-9.3a deferred 下第三段动作含「重渲染本机 payload」(先清再验缺席,不死锁)',
    edits: [
      swap(
        RB,
        '    const r = await d.payload.revoke(ids);',
        "    const r = { status: 'done' } as const;",
      ),
    ],
    tests: [T_RB],
    expectRed: ['deferred 下第三段先经撤销路径清 payload'],
    mustKill: ['deferred 下第三段先经撤销路径清 payload'],
  },
  {
    id: 'clear_no_resume',
    clause: 'R21-9.5 / 9.6 缩减入口先续做在途 journal(自己可重试)',
    edits: [swap(CL, 'report.outcomes.push(...(await resumeAll(rd)));', '')],
    tests: [T_CL],
    expectRed: ['再跑一次 clear 先续做在途 journal'],
    mustKill: ['再跑一次 clear 先续做在途 journal'],
  },
  // ---- W0-17 来源保留 ----
  {
    id: 'source_fallthrough_worker',
    clause: 'W0-17 journal 恢复保留来源(veto / exec_event 由原因还原)',
    edits: [swap(RB, '  return byFromReason(t.reason);', "  return 'worker';")],
    // 新 journal 自带 `by`,续做不走兜底;兜底只由旧格式 journal 的用例覆盖
    tests: [T_JN],
    expectRed: ['旧 journal 原因'],
    mustKill: ['旧 journal 原因'],
  },
  {
    id: 'source_clear_kind_lost',
    clause: 'W0-17 journal 恢复保留来源(kind=clear → by=clear)',
    edits: [
      swap(
        RB,
        "if (t.kind === 'clear') return 'clear';",
        "if (t.kind === 'clear') return 'worker';",
      ),
    ],
    tests: [T_JN],
    expectRed: ['旧 journal 原因'],
    mustKill: ['旧 journal 原因'],
  },
  {
    id: 'reuse_by_request',
    clause: 'W0-17 复用在途 txn 时来源一律取 journal 的',
    edits: [
      swap(
        RB,
        'const out = await drive(d, cur.value, { hint: event, sha: req.content_sha256 });',
        'const out = await drive(d, { ...cur.value, by: req.by, kind: req.kind, reason: req.reason }, { hint: event, sha: req.content_sha256 });',
      ),
    ],
    tests: [T_RB, T_CR],
    expectRed: ['崩溃后再次发起同一请求', 'rollback_to 的 txn 在途时 clear 再来'],
    mustKill: ['崩溃后再次发起同一请求', 'rollback_to 的 txn 在途时 clear 再来'],
  },
  {
    id: 'rollback_to_source_lost',
    clause: 'W0-17 journal 恢复保留 rollback_to 来源(kind=rollback ∧ reason=cleared)',
    edits: [
      swap(RB, "if (t.kind === 'rollback' && t.reason === 'cleared') return 'rollback_to';", ''),
    ],
    tests: [T_JN],
    expectRed: ['旧 journal 原因'],
    mustKill: ['旧 journal 原因'],
  },
  {
    id: 'rollback_to_gate_off',
    clause:
      'W0-17 入口闸:rollback_to ⇔ (kind=rollback ∧ reason=cleared),来源才能从 journal 唯一还原',
    edits: [
      swap(
        RB,
        "if ((by === 'rollback_to') !== (kind === 'rollback' && reason === 'cleared')) {",
        'if (false) {',
      ),
    ],
    tests: [T_RB],
    expectRed: ['rollback_to ⇔ (kind=rollback ∧ reason=cleared)'],
    mustKill: ['rollback_to ⇔ (kind=rollback ∧ reason=cleared)'],
  },
  {
    id: 'txn_id_ignores_content',
    clause: 'R21-9.1 / W0-17 txn_id 绑定内容:换内容 = 新 txn、新凭据',
    edits: [
      swap(
        RB,
        "txnId('rollback', [candidateId], null, contentSha256)",
        "txnId('rollback', [candidateId], null, '')",
      ),
    ],
    tests: [T_RB],
    expectRed: ['txn_id 绑定内容'],
    mustKill: ['txn_id 绑定内容'],
  },
  {
    id: 'rev_dedupe_ignores_content',
    clause: 'W0-17 幂等键 = (candidate_id, content_sha256)',
    edits: [
      swap(
        RW,
        'l.candidate_id === line.data.candidate_id && l.content_sha256 === line.data.content_sha256,',
        'l.candidate_id === line.data.candidate_id,',
      ),
    ],
    tests: [T_RW],
    expectRed: ['内容变了必须写新凭据'],
    mustKill: ['内容变了必须写新凭据'],
  },
  {
    id: 'rollback_to_unrestricted',
    clause: 'W0-17 rollback_to 本块只产出 cleared(收窄)',
    edits: [
      swap(
        RW,
        "if (by === 'rollback_to' && !ROLLBACK_TO_REASONS.includes(reason)) return 'reason_not_allowed';",
        '',
      ),
    ],
    tests: [T_RW, T_RB],
    expectRed: ['rollback_to 只产出 cleared', '被拒:RevocationWriteError'],
    mustKill: ['rollback_to 只产出 cleared'],
  },
  {
    id: 'identity_gets_revocation',
    clause: 'R21-9.1 identity_changed 永不写凭据',
    edits: [swap(RW, "if (reason === 'identity_changed') return 'identity_changed';", '')],
    tests: [T_RW],
    expectRed: ['identity_changed 永远不写凭据'],
    mustKill: ['identity_changed 永远不写凭据'],
  },
  {
    id: 'by_veto_lost',
    clause: 'W0-17 来源还原:vetoed → veto',
    edits: [swap(RW, "    case 'vetoed':\n      return 'veto';\n", '')],
    tests: [T_RW, T_JN],
    expectRed: ['byFromReason', '旧 journal 原因'],
    mustKill: ['byFromReason'],
  },
  // ---- R21-9.5 缩减入口 ----
  {
    id: 'clear_cache_touched',
    clause: 'R21-9.5 缩减入口不访问仓库 .state(缓存清理恒 pending)',
    edits: [
      swap(
        CL,
        '    cache: pendingCacheCleanup,',
        '    cache: (d as unknown as RollbackDeps).cache,',
      ),
    ],
    tests: [T_CL],
    expectRed: ['shadow 候选:凭据 by=clear'],
    mustKill: ['shadow 候选:凭据 by=clear'],
  },
  {
    id: 'clear_no_phase_gate',
    clause: 'W0-1 cmd_auto_clear 能力闸',
    edits: [swap(CL, "if (!capabilityAvailable('cmd_auto_clear', d.phase)) {", 'if (false) {')],
    tests: [T_CL],
    expectRed: ['能力闸:相位早于 V1a'],
    mustKill: ['能力闸:相位早于 V1a'],
  },
  {
    id: 'clear_dry_run_writes',
    clause: 'R21-12.1 干跑零写入',
    edits: [swap(CL, '  if (!opts.write) {', '  if (false) {')],
    tests: [T_CL],
    expectRed: ['干跑(无 --write)'],
    mustKill: ['干跑(无 --write)'],
  },
  {
    id: 'clear_effects_applied',
    clause: 'R21-9.5 缩减入口的终态效果只记待对账',
    edits: [
      swap(
        CL,
        '    keyedEffects: deferredKeyedEffects,',
        '    keyedEffects: (d as unknown as RollbackDeps).keyedEffects,',
      ),
    ],
    tests: [T_CL],
    expectRed: ['canary 候选(V1b):走四段'],
    mustKill: ['canary 候选(V1b):走四段'],
  },
  {
    id: 'removal_lifecycle_ok',
    clause: 'W0-15 第三段不得删除 lifecycle/ 权威记录',
    edits: [
      swap(
        RR,
        "if (top === 'lifecycle' || !KIT_MANAGED_TOP_DIRS.includes(top)) {",
        'if (!KIT_MANAGED_TOP_DIRS.includes(top)) {',
      ),
    ],
    tests: [T_CL],
    expectRed: ['target_path 指向 lifecycle/ 或管理命名空间之外'],
    mustKill: ['target_path 指向 lifecycle/ 或管理命名空间之外'],
  },
  {
    id: 'removal_any_dir',
    clause: 'W0-15 第三段只删 kit 管理命名空间内的路径',
    edits: [swap(RR, '|| !KIT_MANAGED_TOP_DIRS.includes(top)) {', '|| false) {')],
    tests: [T_CL],
    expectRed: ['target_path 指向 lifecycle/ 或管理命名空间之外'],
    mustKill: ['target_path 指向 lifecycle/ 或管理命名空间之外'],
  },
  {
    id: 'payload_v1_always',
    clause: 'R21-9.2 V1 恒真实现在 local_payload 能力可用时自己 fail-closed',
    edits: [
      swap(RP, "if (capabilityAvailable('local_payload', phase)) return unwiredPayloadSync;", ''),
    ],
    tests: [T_RB],
    expectRed: ['R21-9.2:V1 的第四段判据恒真'],
    mustKill: ['R21-9.2:V1 的第四段判据恒真'],
  },
  // ---- W0-16 效果 ----
  {
    id: 'effects_no_blacklist',
    clause: 'R21-11.3 vetoed 终态带否决黑名单',
    edits: [swap(ER, "if (tr === 'vetoed') {", 'if (false) {')],
    tests: [T_EF, T_RB],
    expectRed: [
      '引擎效果(去掉 commit / 审计)== 由终态记录推出的效果',
      'journal 无、记录在 rolling_back',
    ],
    mustKill: ['引擎效果(去掉 commit / 审计)== 由终态记录推出的效果'],
  },
  {
    id: 'effects_cooldown_always',
    clause: 'R21-11.1 冷却只对 auto_rollback / expired',
    edits: [swap(ER, "} else if (rec.lifecycle === 'expired') {", '} else if (true) {')],
    tests: [T_EF],
    expectRed: ['人工终态没有冷却'],
    mustKill: ['人工终态没有冷却'],
  },
  {
    id: 'effects_key_no_sha',
    clause: 'W0-16 效果键 = 候选 id + 内容哈希',
    edits: [swap(ER, '`terminal:${rec.id}:${rec.content_sha256}`', '`terminal:${rec.id}`')],
    tests: [T_EF],
    expectRed: ['键 = 候选 id + 内容哈希'],
    mustKill: ['键 = 候选 id + 内容哈希'],
  },
  // ---- R21-10 熔断 ----
  {
    id: 'storm_window_31',
    clause: 'R21-10.2 rollback_storm 30 个 UTC 日窗口',
    edits: [
      swap(
        BR,
        'export const ROLLBACK_STORM_WINDOW_DAYS = 30;',
        'export const ROLLBACK_STORM_WINDOW_DAYS = 31;',
      ),
    ],
    tests: [T_BR],
    expectRed: ['rollback_storm:30 个 UTC 日内自动回滚'],
    mustKill: ['rollback_storm:30 个 UTC 日内自动回滚'],
  },
  {
    id: 'storm_threshold_2',
    clause: 'R21-10.2 rollback_storm 自动回滚 ≥ 3 次',
    edits: [
      swap(
        BR,
        'export const ROLLBACK_STORM_AUTO_ROLLBACKS = 3;',
        'export const ROLLBACK_STORM_AUTO_ROLLBACKS = 2;',
      ),
    ],
    tests: [T_BR],
    expectRed: ['rollback_storm:30 个 UTC 日内自动回滚'],
    mustKill: ['rollback_storm:30 个 UTC 日内自动回滚'],
  },
  {
    id: 'veto_window_8',
    clause: 'R21-10.2 user_vetoes 7 个 UTC 日窗口',
    edits: [
      swap(
        BR,
        'export const USER_VETOES_WINDOW_DAYS = 7;',
        'export const USER_VETOES_WINDOW_DAYS = 8;',
      ),
    ],
    tests: [T_BR],
    expectRed: ['user_vetoes:7 个 UTC 日内 veto'],
    mustKill: ['user_vetoes:7 个 UTC 日内 veto'],
  },
  {
    id: 'noobs_gt',
    clause: 'R21-10.2 no_observation 满 7 个 UTC 日触发(差 7 即触发)',
    edits: [
      swap(
        BR,
        'utcDayDiff(f.today, f.lastObservedDay) >= NO_OBSERVATION_DAYS',
        'utcDayDiff(f.today, f.lastObservedDay) > NO_OBSERVATION_DAYS',
      ),
    ],
    tests: [T_BR],
    expectRed: ['no_observation:7 个 UTC 日无观测'],
    mustKill: ['no_observation:7 个 UTC 日无观测'],
  },
  {
    id: 'budget_ignores_loop',
    clause: 'R21-10.2 budget_high_legacy 不是本代循环造成',
    edits: [
      swap(
        BR,
        'f.budgetUsedPct >= BUDGET_HIGH_LEGACY_PCT && !f.budgetCausedByThisLoop',
        'f.budgetUsedPct >= BUDGET_HIGH_LEGACY_PCT',
      ),
    ],
    tests: [T_BR],
    expectRed: ['budget_high_legacy:占用 ≥ 90%'],
    mustKill: ['budget_high_legacy:占用 ≥ 90%'],
  },
  {
    id: 'trip_no_phase_filter',
    clause: 'R21-10.2 按期过滤(V2 / V6b 的码本期不发)',
    edits: [
      swap(BR, 'if (!phaseAtLeast(RSI_AUTO_PAUSE_REASON_PHASE[reason], phase)) {', 'if (false) {'),
    ],
    tests: [T_BR],
    expectRed: ['本期不发的码:apply_failed(V2)'],
    mustKill: ['本期不发的码:apply_failed(V2)'],
  },
  {
    id: 'paused_ignores_flags',
    clause: 'R21-10.3 diverged / owner_changed 同样只阻挡增加影响',
    edits: [
      swap(
        BR,
        'autoPauseMarker || s.reasons.length > 0 || s.diverged || s.owner_changed',
        'autoPauseMarker || s.reasons.length > 0',
      ),
    ],
    tests: [T_BR],
    expectRed: ['四种来源各自成立'],
    mustKill: ['四种来源各自成立'],
  },
  {
    id: 'release_clears_manual',
    clause: 'R21-10.4 自动解除只清自动码',
    edits: [swap(BR, 'RSI_AUTO_RELEASE_REASONS.has(r) && !stillHolds(r)', '!stillHolds(r)')],
    tests: [T_BR],
    expectRed: ['worker 自动解除'],
    mustKill: ['worker 自动解除'],
  },
  {
    id: 'resume_clears_auto',
    clause: 'R21-10.4 resume 只清人工码',
    edits: [swap(BR, 'if (RSI_AUTO_RELEASE_REASONS.has(code)) continue;', '')],
    tests: [T_BR],
    expectRed: ['resume 只清人工码'],
    mustKill: ['resume 只清人工码'],
  },
  {
    id: 'resume_no_recheck',
    clause: 'R21-10.2 / 10.4 resume 重查条件,仍成立的码保留',
    edits: [
      swap(
        BR,
        'const holding = RSI_RESUME_RECHECK[code].find((c) => stillHolds(c));',
        'const holding = undefined as RsiAutoPauseReason | undefined;',
      ),
    ],
    tests: [T_BR],
    expectRed: ['resume:rollback_storm / gate_internal 重查四项'],
    mustKill: ['resume:rollback_storm / gate_internal 重查四项'],
  },
  {
    id: 'trip_no_write',
    clause: 'R21-10.1 触发 = 写熔断码,先写状态再置 canary',
    edits: [swap(BR, "if (r.kind === 'tripped') await d.state.write(r.state);", '')],
    tests: [T_BR],
    expectRed: ['触发:marker.ensure 先于 state.write 先于 canary.mute'],
    mustKill: ['触发:marker.ensure 先于 state.write 先于 canary.mute'],
  },
  {
    id: 'enforce_no_mute',
    clause: 'R21-10.1 崩溃后每次 worker 步骤补做 canary 置位',
    edits: [swap(BR, 'return d.canary.mute();', 'return false;')],
    tests: [T_BR],
    expectRed: ['状态已写、mute 崩溃'],
    mustKill: ['状态已写、mute 崩溃'],
  },
  // ---- 锁序 ----
  {
    id: 'lock_guard_off',
    clause: 'R21-3.3 / W0-15 反向取锁守卫(personal/lock 持有时不得再拿 rsi/lock)',
    edits: [
      swap(
        LK,
        "if (target.sub === undefined && personalLockHeldInProcess()) throw new RsiLockError('internal');",
        '',
      ),
    ],
    tests: [T_LK],
    expectRed: ['先 personal 后 rsi → internal'],
    mustKill: ['先 personal 后 rsi → internal'],
  },
  {
    id: 'lock_mark_missing',
    clause: 'R21-3.3 personal 锁获取成功后登记',
    edits: [swap(PL, '      markPersonalLockHeld(file);\n', '')],
    tests: [T_LK],
    expectRed: ['先 personal 后 rsi → internal'],
    mustKill: ['先 personal 后 rsi → internal'],
  },
  {
    id: 'lock_unmark_missing',
    clause: 'R21-3.3 释放后注销登记(守卫不残留)',
    edits: [swap(PL, '            unmarkPersonalLockHeld(file);\n', '')],
    tests: [T_LK],
    expectRed: ['正向顺序 rsi → personal 允许'],
    mustKill: ['正向顺序 rsi → personal 允许'],
  },
  // ---- harm 串接 ----
  {
    id: 'chain_no_phase_gate',
    clause: 'W0-1 rollback_four_phase 能力闸',
    edits: [
      swap(HC, "if (!capabilityAvailable('rollback_four_phase', env.phase)) {", 'if (false) {'),
    ],
    tests: [T_HC],
    expectRed: ['能力闸:相位未到 V1b'],
    mustKill: ['能力闸:相位未到 V1b'],
  },
  {
    id: 'chain_any_state',
    clause: 'R21-4.4 只有 canary / rolling_back 的候选走 harm 回滚',
    edits: [
      swap(
        HC,
        "if (rec.lifecycle !== 'canary' && rec.lifecycle !== 'rolling_back') {",
        'if (false) {',
      ),
    ],
    tests: [T_HC],
    expectRed: ['候选不在 canary / rolling_back'],
    mustKill: ['候选不在 canary / rolling_back'],
  },
  {
    id: 'chain_by_clear',
    clause: 'W0-17 worker 自身伤害判定用 by=worker',
    edits: [swap(HC, "by: 'worker',", "by: 'clear',")],
    tests: [T_HC],
    expectRed: ['harm 结论 → 候选走完四段'],
    mustKill: ['harm 结论 → 候选走完四段'],
  },
  // ---- W0-20 journal 自带恢复事实(H1 / M4)与入口校验 ----
  {
    id: 'journal_no_sha',
    clause: 'W0-20 journal 首次落盘带 content_sha256(续做不依赖仓库 / 权威记录可读)',
    edits: [
      swap(RB, '    content_sha256: req.content_sha256,\n    by: req.by,', '    by: req.by,'),
    ],
    tests: [T_JN],
    expectRed: ['盘上 journal 带齐三项', '崩于凭据落盘前'],
    mustKill: ['盘上 journal 带齐三项', '崩于凭据落盘前'],
  },
  {
    id: 'journal_no_by',
    clause: 'W0-20 journal 首次落盘带 by(来源保留)',
    edits: [
      swap(RB, '    by: req.by,\n    ...(event !== undefined', '    ...(event !== undefined'),
    ],
    tests: [T_JN],
    expectRed: ['盘上 journal 带齐三项'],
    mustKill: ['盘上 journal 带齐三项'],
  },
  {
    id: 'journal_no_event',
    clause: 'W0-20 journal 首次落盘带 terminal_event(limit_reached 等无法由原因还原的事件)',
    edits: [swap(RB, '    ...(event !== undefined ? { terminal_event: event } : {}),', '')],
    tests: [T_JN],
    expectRed: ['盘上 journal 带齐三项', '崩于凭据落盘后'],
    mustKill: ['盘上 journal 带齐三项', '崩于凭据落盘后'],
  },
  {
    id: 'event_schema_skipped',
    clause: 'W0-20 入口:事件在写 journal 之前过转移引擎的事件 schema',
    edits: [
      swap(
        RB,
        "if (!p.success) return { status: 'refused', txn: null, why: 'event_invalid' };",
        '',
      ),
    ],
    tests: [T_JN],
    expectRed: ['事件不合规 → refused event_invalid'],
    mustKill: ['事件不合规 → refused event_invalid'],
  },
  {
    id: 'event_required_off',
    clause: 'W0-20 入口:需要记录转移而无法还原事件的原因必须带事件',
    edits: [swap(RB, "return { status: 'refused', txn: null, why: 'event_required' };", '')],
    tests: [T_JN],
    expectRed: ['需要记录转移而又无法由原因还原事件'],
    mustKill: ['需要记录转移而又无法由原因还原事件'],
  },
  {
    id: 'journal_event_unchecked',
    clause: 'W0-20 续做:terminal_event 过不了事件 schema = txn_invalid(fail-closed)',
    edits: [swap(RB, "if (!p.success) return 'txn_invalid';", '')],
    tests: [T_JN],
    expectRed: ['terminal_event 过不了转移引擎的事件 schema'],
    mustKill: ['terminal_event 过不了转移引擎的事件 schema'],
  },
  {
    id: 'journal_sha_unchecked',
    clause: 'W0-20 续做:content_sha256 必须与 txn_id 对得上',
    edits: [swap(RB, 'rollbackTxnId(t.candidate_id, t.content_sha256) !== t.txn_id', 'false')],
    tests: [T_JN],
    expectRed: ['content_sha256 与 txn_id 对不上'],
    mustKill: ['content_sha256 与 txn_id 对不上'],
  },
  {
    id: 'journal_by_unchecked',
    clause: 'W0-20 续做:by 必须与 (kind, reason) 相容',
    edits: [
      swap(RB, "if (sourceProblem(t.by, t.kind, t.reason) !== null) return 'txn_invalid';", ''),
    ],
    tests: [T_JN],
    expectRed: ['by 与 (kind, reason) 不相容'],
    mustKill: ['by 与 (kind, reason) 不相容'],
  },
  // ---- M5 identity_changed(V6a)本期拒绝 ----
  {
    id: 'identity_runs',
    clause: 'M5 identity_changed 入口拒绝(不写 journal、不部分执行)',
    edits: [
      swap(
        RB,
        "if (identity) return { status: 'refused', txn: null, why: 'identity_not_available_before_v6a' };",
        '',
      ),
    ],
    tests: [T_RB],
    expectRed: ['入口 refused identity_not_available_before_v6a'],
    mustKill: ['入口 refused identity_not_available_before_v6a'],
  },
  {
    id: 'identity_journal_runs',
    clause: 'M5 读到旧的 identity_change journal 不动',
    edits: [
      swap(RB, "if (t.kind === 'identity_change') return 'identity_not_available_before_v6a';", ''),
    ],
    tests: [T_RB],
    expectRed: ['读到旧的 identity_change journal'],
    mustKill: ['读到旧的 identity_change journal'],
  },
  // ---- H2 分叉下撤销完成 ----
  {
    id: 'deferred_incomplete',
    clause: 'H2 记录读不到(分叉)时撤销四段完成即 revocation_complete',
    edits: [
      swap(
        RB,
        'return deferredDone(`repo_deferred:${rd.why}`);',
        'return inc(`repo_deferred:${rd.why}`);',
      ),
    ],
    tests: [T_RB, T_CU],
    expectRed: ['私有仓库 deferred:凭据照样落盘', 'clear 遇人工分叉'],
    mustKill: ['私有仓库 deferred:凭据照样落盘', 'clear 遇人工分叉'],
  },
  {
    id: 'deferred_rem_incomplete',
    clause: 'H2 仓库提交 deferred 时撤销四段完成即 revocation_complete',
    edits: [
      swap(
        RB,
        'return deferredDone(`repo_deferred:${rem.why}`);',
        'return inc(`repo_deferred:${rem.why}`);',
      ),
    ],
    tests: [T_RB],
    expectRed: ['记录可读但仓库提交 deferred'],
    mustKill: ['记录可读但仓库提交 deferred'],
  },
  {
    id: 'deferral_mark_skipped',
    clause: 'H2 worker 路径写 repo_removal_deferred 标记(deferralMark)',
    edits: [swap(RB, 'await d.deferralMark.mark(t.candidate_id);', '')],
    tests: [T_CU],
    expectRed: ['worker 路径(装配 deferralMark)'],
    mustKill: ['worker 路径(装配 deferralMark)'],
  },
  {
    id: 'marked_always',
    clause: 'H2 没有 deferralMark 端口时不宣称已写工作副本(workingMarked=false)',
    edits: [swap(RB, 'let marked = false;', 'let marked = true;')],
    tests: [T_CU, T_RB],
    expectRed: ['clear 遇人工分叉', '私有仓库 deferred:凭据照样落盘'],
    mustKill: ['clear 遇人工分叉'],
  },
  {
    id: 'clear_pending_lost',
    clause: 'H2 clear 报告列出 repoRemovalPending',
    edits: [swap(CL, "(o.status === 'revocation_complete' ? [o.candidate_id] : [])", '[]')],
    tests: [T_CU],
    expectRed: ['clear 遇人工分叉'],
    mustKill: ['clear 遇人工分叉'],
  },
  // ---- H3 AUTO_PAUSE 标记先于状态 ----
  {
    id: 'marker_after_state',
    clause: 'H3 熔断先写 AUTO_PAUSE 标记,再写状态,后 mute',
    edits: [
      swap(BR, '  await d.marker.ensure(reason);\n', ''),
      swap(
        BR,
        '  await d.canary.mute();\n  return r;',
        '  await d.marker.ensure(reason);\n  await d.canary.mute();\n  return r;',
      ),
    ],
    tests: [T_BR, T_PM],
    expectRed: [
      '触发:marker.ensure 先于 state.write 先于 canary.mute',
      'state.write 崩溃:hint 的许可端口读到',
    ],
    mustKill: [
      '触发:marker.ensure 先于 state.write 先于 canary.mute',
      'state.write 崩溃:hint 的许可端口读到',
    ],
  },
  {
    id: 'enforce_marker_missing',
    clause: 'H3 有码缺标记:enforceMute 补标记',
    edits: [
      swap(BR, 'if (marker === null && first !== undefined) await d.marker.ensure(first);', ''),
    ],
    tests: [T_BR, T_PM],
    expectRed: ['有码而没有标记', '有码缺标记:enforceMute 补标记'],
    mustKill: ['有码而没有标记'],
  },
  {
    id: 'enforce_code_restore_skipped',
    clause: 'H3 有标记缺码:enforceMute 由标记补码(不删标记)',
    edits: [swap(BR, 'if (code !== null && !cur.reasons.includes(code)) {', 'if (false) {')],
    tests: [T_BR, T_PM],
    expectRed: ['状态写入崩溃:标记已在盘上', '崩溃后下一次 enforceMute:由标记补码'],
    mustKill: ['状态写入崩溃:标记已在盘上'],
  },
  {
    id: 'marker_overwrite',
    clause: 'H3 标记独占创建、不覆盖用户写的标记',
    edits: [
      swap(
        PM,
        'import { createExclusive, remove } from',
        'import { createExclusive, remove, writeFile } from',
      ),
      swap(
        PM,
        'createExclusive(io, file, body, RSI_FILE_MODE)',
        'writeFile(io, file, body, { mode: RSI_FILE_MODE })',
      ),
    ],
    tests: [T_PM],
    expectRed: ['ensure 遇到用户写的标记'],
    mustKill: ['ensure 遇到用户写的标记'],
  },
  {
    id: 'release_keeps_marker',
    clause: 'H3 自动解除:无剩余码时删 worker 写的标记',
    edits: [swap(BR, "if (r.clearMarker) await d.marker.remove('own');", '')],
    tests: [T_BR, T_PM],
    expectRed: [
      '自动解除:先写状态、后删 worker 写的标记',
      '自动解除:仍有码 → 标记保留;清空 → 删 worker 写的标记',
    ],
    mustKill: ['自动解除:先写状态、后删 worker 写的标记'],
  },
  {
    id: 'release_removes_any',
    clause: 'H3 自动解除只删 worker 写的标记,不删用户标记',
    edits: [
      swap(
        BR,
        "if (r.clearMarker) await d.marker.remove('own');",
        "if (r.clearMarker) await d.marker.remove('any');",
      ),
    ],
    tests: [T_BR, T_PM],
    expectRed: ['自动解除:先写状态、后删 worker 写的标记', '自动解除不删用户标记'],
    mustKill: ['自动解除:先写状态、后删 worker 写的标记'],
  },
  {
    id: 'release_marker_early',
    clause: 'H3 自动解除:仍有剩余码时标记保留',
    edits: [
      swap(
        BR,
        'clearMarker: released.length > 0 && reasons.length === 0,',
        'clearMarker: released.length > 0,',
      ),
    ],
    tests: [T_BR],
    expectRed: ['自动解除:先写状态、后删 worker 写的标记'],
    mustKill: ['自动解除:先写状态、后删 worker 写的标记'],
  },
  {
    id: 'resume_marker_early',
    clause: 'H3 人工 resume:仍有剩余码时标记保留(hint 继续停注入)',
    edits: [
      swap(
        BR,
        'clearMarker: cleared.length > 0 && reasons.length === 0,',
        'clearMarker: cleared.length > 0,',
      ),
    ],
    tests: [T_BR],
    expectRed: ['人工 resume:没有剩余码时删任何标记'],
    mustKill: ['人工 resume:没有剩余码时删任何标记'],
  },
  // ---- M6 审计行按键落地 ----
  {
    id: 'audit_not_keyed',
    clause: 'M6 审计行经带键端口落地(同一行只落一次)',
    edits: [
      swap(
        RB,
        "await d.keyedEffects.applyOnce(auditKeyOf(l), [{ type: 'append_audit', line: l }]);",
        'await d.audit.append([l]);',
      ),
    ],
    tests: [T_JN],
    expectRed: ['审计键集合固定'],
    mustKill: ['审计键集合固定'],
  },
  {
    id: 'audit_no_finish',
    clause: 'M6 收尾按记录补做审计行(落地失败 / 提交后崩溃不丢)',
    edits: [swap(RB, 'await landAuditEffects(d.keyedEffects, rec);', '')],
    tests: [T_JN],
    expectRed: ['审计落地失败(提交之后)'],
    mustKill: ['审计落地失败(提交之后)'],
  },
  {
    id: 'audit_no_recover',
    clause: 'M6 recoverTerminalEffects 对执行器终态补审计',
    edits: [swap(ER, 'await landAuditEffects(d.effects, rec);', '')],
    tests: [T_JN],
    expectRed: ['recoverTerminalEffects 对执行器终态补审计'],
    mustKill: ['recoverTerminalEffects 对执行器终态补审计'],
  },
  {
    id: 'audit_recover_all',
    clause: 'M6 只补执行器终态理由的审计(其余的审计行是转移当时直接追加的)',
    edits: [
      swap(
        ER,
        'if (rec.terminal_reason !== null && EXECUTOR_TERMINAL_REASONS.has(rec.terminal_reason)) {',
        'if (true) {',
      ),
    ],
    tests: [T_JN],
    expectRed: ['非执行器终态理由'],
    mustKill: ['非执行器终态理由'],
  },
  {
    id: 'audit_key_no_hash',
    clause: 'M6 审计键含行哈希(不同条目不同键)',
    edits: [swap(ER, ".digest('hex').slice(0, 16)}`", ".digest('hex').slice(0, 0)}`")],
    tests: [T_JN],
    expectRed: ['审计键集合固定'],
    mustKill: ['审计键集合固定'],
  },
];

/** 变异整表的执行结果(由主代理执行后回填;W7 实装块留空) */
export const V1_W7_RESULTS: readonly V1W7Result[] = [];
