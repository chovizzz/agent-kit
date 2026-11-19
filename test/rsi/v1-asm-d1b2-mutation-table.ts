/**
 * §21 V1 装配块 D1b-2(增效 sink 的 GrowthPass 门 / 创建提交与创建审计恢复 / `GROWTH_SINKS` 架构门 / 钩子)必杀变异(设计稿 §9.1 I8–I15)。
 * 执行方式同 B1a / B1b / C1a / C1b / C2 / D1b-1:验证机私有检出里 cp 备份 → 按锚点替换(每个锚点在对应文件里**恰好出现一次**)→ 跑 `tests` → 失败集合非空、全部命中 `expectRed`、
 * `mustKill` 每项至少命中一个、没有 skipped → cp 还原并逐文件 sha256 核对。**不用 git checkout / stash 还原**。
 * 本文件只写表与每条变异期望红的测试名(`expectRed` = 所在测试文件的 describe 标题或精确杀手名;`mustKill` 才是精确断言);变异由主代理整表执行,结果记进 `V1_ASM_D1B2_RESULTS`(本块不执行变异,故留空)。
 * 锚点是 prettier 之后的文本。
 * 不变量对照(设计稿 §9.1):I8 = hook_*(`commit.ts`);I9 = sink 缺 pass 先拒(grant / admission / applyEvent / 创建);I10 = 事件分类;I11 = 创建取时;I12 = 观察行;
 * I13 = 创建审计派生单一来源与依赖方向;I14 = `CreationExtra` 恒拒;I15 = `GROWTH_SINKS` 门有牙。
 */
export interface Edit {
  file: string;
  anchor: string;
  replacement: string;
}

export interface V1AsmD1b2Mutation {
  id: string;
  /** 不变量 */
  clause: string;
  edits: readonly Edit[];
  /** 相对 `test/` */
  tests: readonly string[];
  expectRed: readonly string[];
  mustKill: readonly string[];
}

export interface V1AsmD1b2Result {
  id: string;
  failed: number;
  skipped: number;
  killedBy: readonly string[];
  restored: boolean;
}

const COMMIT = 'src/rsi/personal/commit.ts';
const APPLY = 'src/rsi/personal/candidate-apply.ts';
const STEP = 'src/rsi/personal/candidate-step.ts';
const RSTEP = 'src/rsi/personal/reduce-step.ts';
const EVENTS = 'src/rsi/personal/growth-events.ts';
const CAUDIT = 'src/rsi/personal/creation-audit.ts';
const CEXTRA = 'src/rsi/personal/creation-extra.ts';
const RECONCILE = 'src/rsi/store/reconcile-source.ts';
const GRANT = 'src/rsi/canary/canary-writer.ts';
const ADMISSION = 'src/rsi/canary/admission-write.ts';
const SINKS = 'src/rsi/canary/growth-sinks.ts';
const VETO = 'src/rsi/auto/write/veto.ts';
const ROLLBACK = 'src/rsi/personal/rollback.ts';
const RECOVER = 'src/rsi/personal/effects-recover.ts';
const REPO = 'src/rsi/personal/candidate-repo.ts';

const HOOK_T = 'rsi/d1b2/commit-hook.test.ts';
const APPLY_T = 'rsi/d1b2/apply-growth.test.ts';
const EVENTS_T = 'rsi/d1b2/growth-events.test.ts';
const STEP_T = 'rsi/d1b2/step-creation.test.ts';
const PASS_T = 'rsi/d1b2/sinks-pass.test.ts';
const CAUDIT_T = 'rsi/d1b2/creation-audit.test.ts';
const CEXTRA_T = 'rsi/d1b2/creation-extra.test.ts';
const ARCH_T = 'rsi/d1b2/growth-sinks-arch.test.ts';
const STAMP_T = 'rsi/asm/b-entry-stamp-arch.test.ts';
const ACC_T = 'rsi/d1b2/accept-r1.test.ts';

/** 各测试文件的 describe 标题(失败集合须 ⊆ expectRed;所以把整个 describe 记为「命中范围」) */
const D_HOOK_DENY = 'beforeRefUpdate:拒绝';
const D_HOOK_OTHER = 'beforeRefUpdate:其它错误一律传播(不当成拒绝)';
const D_HOOK_POS = 'beforeRefUpdate:位置与锁复核';
const D_AG = '增影响事件:端口缺 / 拒 / 畸形 = denied 且零写入';
const D_AG_DECIDE = 'decide_better_always_refused_as_growth / 未登记事件';
const D_EV = 'event_kind_classified:增影响分类穷举';
const D_S_CREATE =
  '创建提交先过 growth 端口(d1_sinks_refuse_without_pass / creation_commit_without_claim)';
const D_S_NOHALT = '被拒的增影响动作不阻止减影响子步骤(不 halt)';
const D_S_STAMP = '创建取时经封存区域(I11)';
const D_S_AUDIT = '创建审计经唯一派生点、带键落地(I13 的即时一半)';
const D_S_OBS = '观察行只经 appendObservation(I12)';
const D_S_LOCKS = 'StepDeps.locks 两把锁都要持(I9 的锁半)';
const D_S_AUDIT_PORT = '创建审计缺带键出口:不回落无键 append(与恢复的键去重对齐)';
const D_S_DOWNGRADE =
  'ApplyResult.denied 的降级只对已分类的增影响事件(减影响事件出现 denied = 底座违约 → halt commit_failed)';
const D_S_HOOKREAD = 'claim 返回值只读一次(校验过的值就是转交的值)';
const D_P_HAS = 'hasSinkPass:只认铸造登记';
const D_P_GRANT = 'grantCanary:pass 是第一道门';
const D_P_ADM = 'stepAdmission:pass 是第一道门';
const D_CA_ITEMS = 'creationAuditItems:唯一派生函数';
const D_CA_RECOVER = 'recoverCreationAudits:提交后崩溃的补做';
const D_CA_DIR = 'personal_does_not_import_store:依赖方向 store → personal';
const D_EX = 'd1_creation_always_refused_with_reason';
const D_ARCH = 'GROWTH_SINKS:登记表与形态校验';
const D_ARCH_SCAN = '同名扫描与写出口覆盖扫描(防漏登记)';
const D_STAMP = 'entry_time_only_via_stamp(B2 档)';
const D_ACC_TRUNC = 'creation_audit_confirmed_before_truncation(第 3 条)';
const D_ACC_SEAL = 'creation_requires_seal(第 4 条)';
const D_ACC_DENIED = 'denied_is_apply_result_branch(第 5 条)';
const D_ARCH_AUTH = '④ 权威写出口反查:调用者 ⊆ 登记汇点 ∪ 精确白名单(不看钩子、不看拼写)';
const K_ARCH_AUTH = '提交类出口调用者恰为允许集';
const K_ARCH_FLOW = '钩子数据流:claim 返回值 → 拒绝分支先于提交';
const K_ARCH_INONLY = 'applyIn 只被 applyEvent 调用';

const PASS_GATE_GRANT =
  "  if (!hasSinkPass(pass)) return { kind: 'refused', reason: 'growth_denied' };";
const PASS_GATE_ADM = "  if (!hasSinkPass(pass)) return { kind: 'blocked', why: 'growth_denied' };";

export const V1_ASM_D1B2_MUTATIONS: readonly V1AsmD1b2Mutation[] = [
  // ---------------- I8:beforeRefUpdate 钩子与 denied ----------------
  {
    id: 'hook_removed',
    clause: 'I8:钩子在 update-ref 之前被调用(拒绝才有机会生效)',
    edits: [
      { file: COMMIT, anchor: '      await spec.beforeRefUpdate();', replacement: '      void 0;' },
    ],
    tests: [HOOK_T],
    expectRed: [
      D_HOOK_DENY,
      D_HOOK_OTHER,
      D_HOOK_POS,
      'before_ref_update_denied_ref_unchanged_journal_removed',
    ],
    mustKill: ['before_ref_update_denied_ref_unchanged_journal_removed'],
  },
  {
    id: 'hook_any_error_maps_to_denied',
    clause: 'I8:只认 BeforeRefUpdateDenied;其它错误(含 RsiLockError)原样传播,不当成拒绝',
    edits: [
      {
        file: COMMIT,
        anchor: '      if (!(e instanceof BeforeRefUpdateDenied)) throw e;',
        replacement: '      void 0;',
      },
    ],
    tests: [HOOK_T],
    expectRed: [
      D_HOOK_OTHER,
      D_HOOK_DENY,
      D_HOOK_POS,
      'before_ref_update_lock_lost_propagates_no_cleanup',
    ],
    mustKill: ['before_ref_update_lock_lost_propagates_no_cleanup'],
  },
  {
    id: 'hook_before_last_assertlocks',
    clause: 'I8:钩子之前必须有一次锁复核(钩子不在丢锁后被调用)',
    edits: [
      {
        file: COMMIT,
        anchor:
          '  await assertLocks(ctx); // update-ref 之前复核锁(lock_lost 时立即停止)\n  if (spec.beforeRefUpdate !== undefined) {',
        replacement: '  if (spec.beforeRefUpdate !== undefined) {',
      },
    ],
    tests: [HOOK_T],
    expectRed: [D_HOOK_POS, 'hook_before_last_assertlocks'],
    mustKill: ['hook_before_last_assertlocks'],
  },
  {
    id: 'hook_without_post_assertlocks',
    clause: 'I8:钩子是 async 现读,它之后到 update-ref 之间不得丢锁(再复核一次)',
    edits: [
      {
        file: COMMIT,
        anchor: '    await assertLocks(ctx); // 钩子是 async 现读:它之后到 update-ref 之间不得丢锁',
        replacement: '    void 0;',
      },
    ],
    tests: [HOOK_T],
    expectRed: [D_HOOK_POS, 'hook_without_post_assertlocks'],
    mustKill: ['hook_without_post_assertlocks'],
  },
  {
    id: 'denied_cleanup_without_ownership_check',
    clause: 'I8:拒绝后只删自己的 journal(盘上 journal 与本次写下的逐字段全等才删)',
    edits: [
      {
        file: COMMIT,
        anchor: "  if (!same) return { kind: 'journal_unverified', why: 'journal_not_mine' };\n",
        replacement: '',
      },
    ],
    tests: [HOOK_T],
    expectRed: [
      D_HOOK_DENY,
      'before_ref_update_denied_foreign_journal_untouched',
      'before_ref_update_denied_same_txn_different_content_untouched',
    ],
    mustKill: [
      'before_ref_update_denied_foreign_journal_untouched',
      'before_ref_update_denied_same_txn_different_content_untouched',
    ],
  },
  {
    id: 'denied_cleanup_compares_txn_id_only',
    clause: 'I8:所有权核对不能只比 txn_id(同 txn 不同内容的 journal 不删)',
    edits: [
      {
        file: COMMIT,
        anchor:
          '    a.kind === mine.kind &&\n    a.old_head === mine.old_head &&\n    a.target_tree === mine.target_tree &&\n    a.new_commit === mine.new_commit &&\n    a.phase === mine.phase &&\n    a.candidate_ids.length === mine.candidate_ids.length &&\n    a.candidate_ids.every((id, i) => id === mine.candidate_ids[i]);',
        replacement: '    true;',
      },
    ],
    tests: [HOOK_T],
    expectRed: [D_HOOK_DENY, 'before_ref_update_denied_same_txn_different_content_untouched'],
    mustKill: ['before_ref_update_denied_same_txn_different_content_untouched'],
  },
  {
    id: 'denied_cleanup_skips_lock_check',
    clause: 'I8:拒绝后清理 journal 之前先复核锁(丢锁则传播、journal 不动)',
    edits: [
      {
        file: COMMIT,
        anchor:
          '): Promise<DiscardResult> {\n  await assertLocks(ctx);\n  const cur = await readJournal(ctx.h);',
        replacement: '): Promise<DiscardResult> {\n  const cur = await readJournal(ctx.h);',
      },
    ],
    tests: [HOOK_T],
    expectRed: [
      D_HOOK_POS,
      '拒绝后清理 journal 之前先复核锁',
      'denied_cleanup_skips_remove_lock_check',
    ],
    mustKill: ['denied_cleanup_skips_remove_lock_check'],
  },
  {
    id: 'denied_journal_never_removed',
    clause: 'I8:拒绝后自己的 journal 被删(不留残留挡路)',
    edits: [
      { file: COMMIT, anchor: '    await removeJournal(ctx.h);', replacement: '    void 0;' },
    ],
    tests: [HOOK_T],
    expectRed: [
      D_HOOK_DENY,
      'before_ref_update_denied_ref_unchanged_journal_removed',
      'denied 之后同一仓库可以正常再提交',
    ],
    mustKill: ['before_ref_update_denied_ref_unchanged_journal_removed'],
  },
  {
    id: 'denied_result_dropped',
    clause: 'I8:钩子拒绝 → 提交返回 denied{code}(不继续 update-ref)',
    edits: [
      {
        file: COMMIT,
        anchor: "      return { status: 'denied', code: e.code };",
        replacement: '      throw e;',
      },
    ],
    tests: [HOOK_T],
    expectRed: [
      D_HOOK_DENY,
      'denied_cleanup_skips_remove_lock_check',
      'before_ref_update_denied_ref_unchanged_journal_removed',
    ],
    mustKill: ['before_ref_update_denied_ref_unchanged_journal_removed'],
  },

  // ---------------- I9:sink 缺 pass 先拒 ----------------
  {
    id: 'grant_check_after_lock_assert',
    clause: 'I9:grantCanary 的 pass 检查先于任何锁断言 / 读写',
    edits: [
      {
        file: GRANT,
        anchor: `${PASS_GATE_GRANT}\n  await d.locks.rsi.assertHeld();`,
        replacement: `  await d.locks.rsi.assertHeld();\n${PASS_GATE_GRANT}`,
      },
    ],
    tests: [PASS_T, ARCH_T],
    expectRed: [D_P_GRANT, D_ARCH, 'd1_sinks_refuse_without_pass', '每个登记汇点的实现合规'],
    mustKill: ['d1_sinks_refuse_without_pass', '每个登记汇点的实现合规'],
  },
  {
    id: 'grant_pass_check_removed',
    clause: 'I9:grantCanary 缺 / 伪 pass 必拒',
    edits: [{ file: GRANT, anchor: PASS_GATE_GRANT, replacement: '  void 0;' }],
    tests: [PASS_T, ARCH_T],
    expectRed: [D_P_GRANT, D_ARCH, 'd1_sinks_refuse_without_pass', '每个登记汇点的实现合规'],
    mustKill: ['d1_sinks_refuse_without_pass', '每个登记汇点的实现合规'],
  },
  {
    id: 'admission_check_removed',
    clause: 'I9:stepAdmission 缺 / 伪 pass 必拒',
    edits: [{ file: ADMISSION, anchor: PASS_GATE_ADM, replacement: '  void 0;' }],
    tests: [PASS_T, ARCH_T],
    expectRed: [D_P_ADM, D_ARCH, 'd1_sinks_refuse_without_pass', '每个登记汇点的实现合规'],
    mustKill: ['d1_sinks_refuse_without_pass', '每个登记汇点的实现合规'],
  },
  {
    id: 'admission_check_after_lock_assert',
    clause: 'I9:stepAdmission 的 pass 检查先于任何锁断言 / 读写',
    edits: [
      {
        file: ADMISSION,
        anchor: `${PASS_GATE_ADM}\n  await d.locks.rsi.assertHeld();`,
        replacement: `  await d.locks.rsi.assertHeld();\n${PASS_GATE_ADM}`,
      },
    ],
    tests: [PASS_T, ARCH_T],
    expectRed: [D_P_ADM, D_ARCH, 'd1_sinks_refuse_without_pass', '每个登记汇点的实现合规'],
    mustKill: ['d1_sinks_refuse_without_pass', '每个登记汇点的实现合规'],
  },
  {
    id: 'apply_growth_unwired_falls_through',
    clause: 'I9:applyEvent / runPersonalStep 缺 growth 端口 = 拒绝(缺则拒,不放行)',
    edits: [
      {
        file: APPLY,
        anchor: "  if (port === undefined) return { ok: false, code: 'unwired' };",
        replacement: '  if (port === undefined) return { ok: true, hook: async () => undefined };',
      },
    ],
    tests: [APPLY_T, STEP_T],
    expectRed: [
      D_AG,
      D_S_CREATE,
      D_S_NOHALT,
      'd1_sinks_refuse_without_pass',
      'd1_creation_always_refused_with_reason',
    ],
    mustKill: ['d1_sinks_refuse_without_pass', 'd1_creation_always_refused_with_reason'],
  },
  {
    id: 'apply_claim_skipped',
    clause: 'I9:增影响事件不得绕过 claim(分类为增影响却不调端口)',
    edits: [
      {
        file: APPLY,
        anchor: '  const r = await claimGrowthPort(d.growth, op, cand);\n  return r.ok',
        replacement:
          '  const r = { ok: true as const, hook: async () => undefined };\n  return r.ok',
      },
    ],
    tests: [APPLY_T],
    expectRed: [D_AG, 'd1_sinks_refuse_without_pass', 'apply_growth_claim_denied_zero_write'],
    mustKill: ['d1_sinks_refuse_without_pass', 'apply_growth_claim_denied_zero_write'],
  },
  {
    id: 'apply_unmappable_falls_through',
    clause: 'I9 / I10:decide_better 与未登记事件恒拒(unmappable),不走端口放行',
    edits: [
      {
        file: APPLY,
        anchor: "  if (op === 'unmappable') return { kind: 'denied', why: 'unmappable' };\n",
        replacement: '',
      },
    ],
    tests: [APPLY_T],
    expectRed: [D_AG_DECIDE, 'decide_better_always_refused_as_growth', '未登记的事件 kind'],
    mustKill: ['decide_better_always_refused_as_growth', '未登记的事件 kind'],
  },
  {
    id: 'apply_hook_not_forwarded',
    clause: 'I9:claim 取得的钩子必须进 commit 的 beforeRefUpdate(否则最终复核不执行)',
    edits: [
      {
        file: APPLY,
        anchor: '    ...(hook !== undefined ? { beforeRefUpdate: hook } : {}),',
        replacement: '',
      },
    ],
    tests: [APPLY_T, ARCH_T],
    expectRed: [
      D_ARCH_AUTH,
      D_AG,
      D_ARCH,
      '放行:钩子进 commit 的 beforeRefUpdate',
      '提交前复核拒',
      'candidate-apply.ts:所有 store.commit 带 beforeRefUpdate',
    ],
    mustKill: [
      '放行:钩子进 commit 的 beforeRefUpdate',
      'candidate-apply.ts:所有 store.commit 带 beforeRefUpdate',
    ],
  },
  {
    id: 'apply_denied_commit_not_denied_branch',
    clause: 'I9:提交前复核拒(commit denied)= ApplyResult.denied + 原因码,不是 commit_failed',
    edits: [
      {
        file: APPLY,
        anchor: "  if (c.status === 'denied') return { kind: 'denied', why: c.code };\n",
        replacement: '',
      },
    ],
    tests: [APPLY_T],
    expectRed: [D_AG, '提交前复核拒(commit 返回 denied)'],
    mustKill: ['提交前复核拒(commit 返回 denied)'],
  },
  {
    id: 'claim_malformed_accepted',
    clause: 'I9:跨端口边界只认 {ok:true, hook:function};畸形一律拒绝',
    edits: [
      {
        file: APPLY,
        anchor:
          "  if (ok === true && typeof hook === 'function') return { ok: true, hook: hook as BeforeRefUpdate };",
        replacement: '  if (ok === true) return { ok: true, hook: hook as BeforeRefUpdate };',
      },
    ],
    tests: [APPLY_T, STEP_T],
    expectRed: [D_AG, D_S_CREATE, 'claim 返回畸形'],
    mustKill: ['claim 返回畸形'],
  },
  {
    id: 'creation_commit_without_claim',
    clause: 'I9:创建提交必须先 claim(缺端口 / 拒 → 零写入)',
    edits: [
      {
        file: STEP,
        anchor: "    const claim = await claimGrowthPort(d.growth, 'candidate_create', null);",
        replacement: '    const claim = { ok: true as const, hook: async () => undefined };',
      },
    ],
    tests: [STEP_T, ARCH_T],
    expectRed: [
      D_S_HOOKREAD,
      D_ARCH_AUTH,
      D_S_CREATE,
      D_S_NOHALT,
      D_ARCH,
      'd1_creation_always_refused_with_reason',
      '每个登记汇点的实现合规',
    ],
    mustKill: ['d1_creation_always_refused_with_reason', '每个登记汇点的实现合规'],
  },
  {
    id: 'creation_hook_not_forwarded',
    clause: 'I9:创建提交的钩子必须进 commit(提交前最终复核)',
    edits: [{ file: STEP, anchor: '        beforeRefUpdate: claim.hook,', replacement: '' }],
    tests: [STEP_T, ARCH_T],
    expectRed: [
      D_S_HOOKREAD,
      D_ARCH_SCAN,
      D_ARCH_AUTH,
      D_S_CREATE,
      D_ARCH,
      '提交前复核拒(commit 返回 denied)',
      '每个登记汇点的实现合规',
    ],
    mustKill: ['提交前复核拒(commit 返回 denied)', '每个登记汇点的实现合规'],
  },
  {
    id: 'creation_denied_commit_not_recorded',
    clause: 'I9:创建提交被钩子拒(denied)→ growthDenied 记录,不是 halt(减影响子步骤照常)',
    edits: [
      {
        file: STEP,
        anchor:
          "      if (c.status === 'denied') {\n        creationDenied = true;\n        out.growthDenied.push({ op: 'candidate_create', code: c.code });\n        continue;\n      }\n",
        replacement: '',
      },
    ],
    tests: [STEP_T],
    expectRed: [D_S_CREATE, '提交前复核拒(commit 返回 denied)'],
    mustKill: ['提交前复核拒(commit 返回 denied)'],
  },
  {
    id: 'creation_denial_halts_step',
    clause: 'I9:claim 被拒不 halt 整步(只记 growthDenied;减影响子步骤照常)',
    edits: [
      {
        file: STEP,
        anchor:
          "      out.growthDenied.push({ op: 'candidate_create', code: claim.code });\n      continue;",
        replacement:
          "      out.growthDenied.push({ op: 'candidate_create', code: claim.code });\n      return halt('commit_failed');",
      },
    ],
    tests: [STEP_T],
    expectRed: [D_S_CREATE, D_S_NOHALT, 'd1_creation_always_refused_with_reason'],
    mustKill: ['d1_creation_always_refused_with_reason'],
  },
  {
    id: 'creation_retry_per_candidate',
    clause: 'I9:同一轮创建被拒后不再逐个候选重试 claim(拒绝原因是回合级的)',
    edits: [{ file: STEP, anchor: '    if (creationDenied) continue;\n', replacement: '' }],
    tests: [STEP_T],
    expectRed: [D_S_CREATE, 'claim 拒 → growthDenied 带原因码'],
    mustKill: ['claim 拒 → growthDenied 带原因码'],
  },
  {
    id: 'runner_growth_denied_halts',
    clause: 'I9:被拒的增影响动作经运行器记录而不中止(gates_passed 被拒后 shadow 到期照常)',
    edits: [
      {
        file: RSTEP,
        anchor: '      if (out.growthDenied !== undefined && growthOp !== null) {\n',
        replacement: '      if (out.growthDenied === undefined && growthOp !== null) {\n',
      },
    ],
    tests: [STEP_T],
    expectRed: [D_S_NOHALT, 'gates_passed 缺端口被拒', 'gates_passed 的 claim 拒'],
    mustKill: ['gates_passed 缺端口被拒', 'gates_passed 的 claim 拒'],
  },
  {
    id: 'step_rsi_lock_not_asserted',
    clause: 'I9:runPersonalStep 入口断言 rsi 锁(两把锁都要持)',
    edits: [{ file: STEP, anchor: '  await d.locks.rsi.assertHeld();\n', replacement: '' }],
    tests: [STEP_T],
    expectRed: [D_S_LOCKS, 'rsi 锁丢失:入口 assertHeld 抛'],
    mustKill: ['rsi 锁丢失:入口 assertHeld 抛'],
  },
  {
    id: 'claim_hook_reread',
    clause: 'I9:校验过的 claim 返回值就是转交的值(每个字段只读一次;不重读同一个对象)',
    edits: [
      {
        file: APPLY,
        anchor:
          "  if (ok === true && typeof hook === 'function') return { ok: true, hook: hook as BeforeRefUpdate };",
        replacement:
          "  if (ok === true && typeof hook === 'function') return { ok: true, hook: (r as { hook: BeforeRefUpdate }).hook };",
      },
    ],
    tests: [APPLY_T, STEP_T],
    expectRed: [D_AG, D_S_HOOKREAD, 'claim_hook_reread', 'claim 返回值只读一次'],
    mustKill: ['claim_hook_reread', 'claim 返回值只读一次'],
  },
  {
    id: 'denied_cleanup_skips_remove_lock_check',
    clause: 'I8:清理在读盘并核对所有权之后、删除之前再复核一次锁(逐字段全等只证明那一刻的快照)',
    edits: [
      {
        file: COMMIT,
        anchor:
          '  await assertLocks(ctx); // 读盘与比较之后、删除之前再复核一次(逐字段全等只证明那一刻的快照;丢锁则传播,不进下面吞 IO 错误的 catch)',
        replacement: '  void 0;',
      },
    ],
    tests: [HOOK_T],
    expectRed: [D_HOOK_POS, 'denied_cleanup_skips_remove_lock_check'],
    mustKill: ['denied_cleanup_skips_remove_lock_check'],
  },
  {
    id: 'creation_audit_falls_back_to_append',
    clause: 'I13:创建审计缺带键出口时不回落无键 append(无键行不参与键去重,即时 + 恢复会重复)',
    edits: [
      {
        file: STEP,
        anchor: '          out.effectsFailed.push(`${draft.id}:creation_audit_port_missing`);',
        replacement: '          await d.audit.append(items.map((i) => i.line));',
      },
    ],
    tests: [STEP_T],
    expectRed: [
      D_S_AUDIT_PORT,
      'creation_audit_without_keyed_port_not_appended_via_keyless_append',
    ],
    mustKill: ['creation_audit_without_keyed_port_not_appended_via_keyless_append'],
  },
  {
    id: 'runner_downgrades_reducing_denied',
    clause:
      'I9 / 验收第 5 条:denied 只对已分类的增影响事件降级为记录;减影响事件出现 = 底座违约 → halt commit_failed(fail-closed)',
    edits: [
      {
        file: RSTEP,
        anchor: '      if (out.growthDenied !== undefined && growthOp !== null) {\n',
        replacement: '      if (out.growthDenied !== undefined) {\n',
      },
    ],
    tests: [STEP_T],
    expectRed: [D_S_DOWNGRADE, 'runner_downgrades_reducing_denied'],
    mustKill: ['runner_downgrades_reducing_denied'],
  },
  {
    id: 'runner_denied_unclassified_continues',
    clause:
      '验收第 5 条:无法处理的 denied(减影响事件 / 无记录端)映射 commit_failed 并停本步,不得当成普通结果继续',
    edits: [
      {
        file: RSTEP,
        anchor:
          "      out.halted = 'commit_failed';\n      return 'halt';\n    }\n    if (r.kind === 'halt') {",
        replacement: "      return 'other';\n    }\n    if (r.kind === 'halt') {",
      },
    ],
    tests: [STEP_T, ACC_T],
    expectRed: [D_S_DOWNGRADE, 'runner_downgrades_reducing_denied', D_ACC_DENIED],
    mustKill: ['runner_downgrades_reducing_denied'],
  },
  {
    id: 'veto_denied_treated_as_success',
    clause: '验收第 5 条:veto(减影响)遇到 denied = 底座违约,退 3 internal(fail-closed),不当成成功',
    edits: [
      {
        file: VETO,
        anchor: "  if (r.kind === 'denied') return failClosed(ctx, 'internal');\n",
        replacement: '',
      },
    ],
    tests: [ACC_T],
    expectRed: [D_ACC_DENIED, 'veto(减影响)遇到 denied'],
    mustKill: ['veto(减影响)遇到 denied'],
  },

  // ---------------- I10:事件分类 ----------------
  {
    id: 'gates_passed_classified_reduce',
    clause: 'I10:gates_passed 归增影响(owner Q3;否则暂停期间闸仍会推进)',
    edits: [
      {
        file: EVENTS,
        anchor: "  gates_passed: 'candidate_create',",
        replacement: '  gates_passed: null,',
      },
    ],
    tests: [EVENTS_T, APPLY_T],
    expectRed: [
      D_EV,
      D_AG,
      '增影响类:gates_passed → candidate_create',
      'd1_sinks_refuse_without_pass',
    ],
    mustKill: ['增影响类:gates_passed → candidate_create'],
  },
  {
    id: 'shadow_promote_classified_reduce',
    clause: 'I10:shadow_promote 归增影响',
    edits: [
      {
        file: EVENTS,
        anchor: "  shadow_promote: 'shadow_to_canary',",
        replacement: '  shadow_promote: null,',
      },
    ],
    tests: [EVENTS_T, APPLY_T],
    expectRed: [
      D_EV,
      D_AG,
      '增影响类:gates_passed → candidate_create',
      'd1_sinks_refuse_without_pass',
    ],
    mustKill: ['增影响类:gates_passed → candidate_create'],
  },
  {
    id: 'deploy_inject_classified_reduce',
    clause: 'I10:deploy_inject 归增影响',
    edits: [
      {
        file: EVENTS,
        anchor: "  deploy_inject: 'deploy_inject',",
        replacement: '  deploy_inject: null,',
      },
    ],
    tests: [EVENTS_T, APPLY_T],
    expectRed: [
      D_EV,
      D_AG,
      '增影响类:gates_passed → candidate_create',
      'deploy_inject 同样先过端口',
    ],
    mustKill: ['增影响类:gates_passed → candidate_create'],
  },
  {
    id: 'decide_better_classified_reduce',
    clause: 'I10:decide_better 无对应 op = unmappable 恒拒',
    edits: [
      {
        file: EVENTS,
        anchor: "  decide_better: 'unmappable',",
        replacement: '  decide_better: null,',
      },
    ],
    tests: [EVENTS_T, APPLY_T],
    expectRed: [
      D_EV,
      D_AG_DECIDE,
      'decide_better 无对应 op',
      'decide_better_always_refused_as_growth',
    ],
    mustKill: ['decide_better 无对应 op', 'decide_better_always_refused_as_growth'],
  },
  {
    id: 'growth_event_unclassified',
    clause: 'I10:未登记 / 脏 kind 按 unmappable 拒绝(绝不当成减影响放行)',
    edits: [
      {
        file: EVENTS,
        anchor:
          "  if (typeof kind !== 'string' || !Object.hasOwn(GROWTH_EVENT_CLASS, kind)) return 'unmappable';",
        replacement:
          "  if (typeof kind !== 'string' || !Object.hasOwn(GROWTH_EVENT_CLASS, kind)) return null;",
      },
    ],
    tests: [EVENTS_T, APPLY_T],
    expectRed: [D_EV, D_AG_DECIDE, 'growth_event_unclassified', '未登记的事件 kind'],
    mustKill: ['growth_event_unclassified', '未登记的事件 kind'],
  },
  {
    id: 'event_kind_unclassified',
    clause: 'I10:新增事件未分类 = 红(分类表键恰等于 schema 的全部 kind)',
    edits: [{ file: EVENTS, anchor: '  compensation_done: null,\n', replacement: '' }],
    tests: [EVENTS_T],
    expectRed: [D_EV, '分类表的键恰等于 schema 的全部事件 kind'],
    mustKill: ['分类表的键恰等于 schema 的全部事件 kind'],
  },

  // ---------------- I11:创建取时经 stampFirst ----------------
  {
    id: 'creation_now_direct',
    clause: 'I11:创建条目取时只经封存区域(不直接调时钟)',
    edits: [
      {
        file: STEP,
        anchor: '        now = region.stampFirst(d.now);',
        replacement: '        now = d.now().toISOString();',
      },
    ],
    tests: [STEP_T, STAMP_T],
    expectRed: [
      D_S_STAMP,
      D_STAMP,
      'creation_stamp_sealed_interval_refused_before_commit',
      'D1b-2 收紧:创建分支经 stampFirst 取时',
    ],
    mustKill: [
      'creation_stamp_sealed_interval_refused_before_commit',
      'D1b-2 收紧:创建分支经 stampFirst 取时',
    ],
  },
  {
    id: 'creation_region_not_closed',
    clause: 'I11:封存区域在创建落地结束后关闭(任何分支)',
    edits: [{ file: STEP, anchor: '      region.close();', replacement: '      void 0;' }],
    tests: [STEP_T],
    expectRed: [D_S_CREATE, '提交前复核拒(commit 返回 denied)'],
    mustKill: ['提交前复核拒(commit 返回 denied)'],
  },

  // ---------------- I12:观察行只经 appendObservation ----------------
  {
    id: 'observation_falls_back_to_append',
    clause:
      'I12:缺 appendObservation 端口时不回落无键 append(生产带键出口对无键行抛 audit_key_missing)',
    edits: [
      {
        file: STEP,
        anchor:
          '      out.effectsFailed.push(`${row.id}:observation_port_missing`);\n      return;',
        replacement: '      await d.audit.append([row]);\n      return;',
      },
    ],
    tests: [STEP_T],
    expectRed: [
      D_S_OBS,
      'observation_row_without_port_not_appended_via_keyless_append',
      '排队清零的观察行',
    ],
    mustKill: ['observation_row_without_port_not_appended_via_keyless_append'],
  },
  {
    id: 'observation_failure_not_recorded',
    clause: 'I12:观察行因缺端口没落 → 记 effectsFailed(不静默丢)',
    edits: [
      {
        file: STEP,
        anchor: '      out.effectsFailed.push(`${row.id}:observation_port_missing`);',
        replacement: '      void 0;',
      },
    ],
    tests: [STEP_T],
    expectRed: [
      D_S_OBS,
      'observation_row_without_port_not_appended_via_keyless_append',
      '排队清零的观察行',
    ],
    mustKill: ['observation_row_without_port_not_appended_via_keyless_append'],
  },

  // ---------------- I13:创建审计派生单一来源 / 依赖方向 ----------------
  {
    id: 'creation_derivation_duplicated',
    clause: 'I13:B1b 对账源的创建行派生与即时落地 / 补做共用同一个函数(不各自实现一份)',
    edits: [
      {
        file: RECONCILE,
        anchor: "import { creationAuditItems } from '../personal/creation-audit.js';\n",
        replacement: '',
      },
      {
        file: RECONCILE,
        anchor: 'new Map(creationAuditItems(rec).map(',
        replacement: 'new Map([].map(',
      },
    ],
    tests: [CAUDIT_T],
    expectRed: [D_CA_DIR, 'reconcile-source.ts import creation-audit'],
    mustKill: ['reconcile-source.ts import creation-audit'],
  },
  {
    id: 'creation_audit_imports_store',
    clause:
      'I13:依赖方向 store → personal;creation-audit 反向 import store = 存储核进入 candidate-step 的运行时闭包',
    edits: [
      {
        file: CAUDIT,
        anchor: "import { RsiLockError } from '../lock-error.js';",
        replacement:
          "import { RsiLockError } from '../lock-error.js';\nimport { createReconcileSource as probeStoreImport } from '../store/reconcile-source.js';\nexport const probeStoreImportUse = probeStoreImport;",
      },
    ],
    tests: [CAUDIT_T],
    expectRed: [
      D_CA_DIR,
      'creation-audit.ts 的闭包',
      'candidate-step.ts 的运行时闭包含 creation-audit',
    ],
    mustKill: ['creation-audit.ts 的闭包', 'candidate-step.ts 的运行时闭包含 creation-audit'],
  },
  {
    id: 'creation_audit_uses_now_not_record_at',
    clause: 'I13:补做的创建审计行用记录里的 at(不是补做时刻)',
    edits: [
      {
        file: CAUDIT,
        anchor: 'line: auditOf(e, rec.id),',
        replacement: 'line: { ...auditOf(e, rec.id), at: new Date().toISOString() },',
      },
    ],
    tests: [CAUDIT_T, STEP_T],
    expectRed: [
      D_CA_ITEMS,
      D_CA_RECOVER,
      D_S_AUDIT,
      'creation_row_derivation_single_source',
      'creation_audit_replay_uses_record_at',
    ],
    mustKill: ['creation_row_derivation_single_source', 'creation_audit_replay_uses_record_at'],
  },
  {
    id: 'creation_audit_key_not_event_identity',
    clause: 'I13:创建审计的稳定键 = audit:<候选>:<条目 idem_key>(事件身份,与回滚路径同一键空间)',
    edits: [
      {
        file: CAUDIT,
        anchor: 'key: auditKeyOf(rec.id, e.idem_key)',
        replacement: 'key: auditKeyOf(rec.id, rec.content_sha256)',
      },
    ],
    tests: [CAUDIT_T],
    expectRed: [
      D_CA_ITEMS,
      D_CA_RECOVER,
      'creation_row_derivation_single_source',
      'creation_audit_replay_uses_record_at',
    ],
    mustKill: ['creation_row_derivation_single_source'],
  },
  {
    id: 'creation_audit_index_assumed',
    clause: 'I13:按内容识别创建行(256 条窗口截断后 transitions[0] 可能不是创建行)',
    edits: [
      {
        file: CAUDIT,
        anchor: '  if (e === undefined || !isCreationEntry(e)) return [];',
        replacement: '  if (e === undefined) return [];',
      },
    ],
    tests: [CAUDIT_T],
    expectRed: [
      D_CA_ITEMS,
      D_CA_RECOVER,
      'transitions[0] 不是创建行',
      '非创建记录(没有创建行)不产生任何调用',
    ],
    mustKill: ['transitions[0] 不是创建行'],
  },
  {
    id: 'recover_lock_lost_swallowed',
    clause: 'I13:补做遇丢锁立即上抛(不吞成单条失败)',
    edits: [
      {
        file: CAUDIT,
        anchor: "        if (e instanceof RsiLockError && e.kind === 'lock_lost') throw e;",
        replacement: '        void 0;',
      },
    ],
    tests: [CAUDIT_T],
    expectRed: [D_CA_RECOVER, '单个候选落地失败不挡其余'],
    mustKill: ['单个候选落地失败不挡其余'],
  },
  {
    id: 'recover_failure_aborts_all',
    clause: 'I13:单个候选落地失败不挡其余候选(记 failed,下次再来)',
    edits: [
      {
        file: CAUDIT,
        anchor:
          "        out.failed.push({ id: rec.id, why: e instanceof Error ? e.message : 'error' });\n        continue;",
        replacement: '        throw e;',
      },
    ],
    tests: [CAUDIT_T],
    expectRed: [D_CA_RECOVER, '单个候选落地失败不挡其余'],
    mustKill: ['单个候选落地失败不挡其余'],
  },
  {
    id: 'recover_unreadable_store_as_empty',
    clause: 'I13:权威副本读不到 → skipped(不当成「没有缺行」)',
    edits: [{ file: CAUDIT, anchor: '    out.skipped = all.kind;', replacement: '    void 0;' }],
    tests: [CAUDIT_T],
    expectRed: [D_CA_RECOVER, '权威副本读不到'],
    mustKill: ['权威副本读不到'],
  },

  // ---------------- I14:CreationExtra 恒拒 ----------------
  {
    id: 'creation_extra_default_ok',
    clause: 'I14:CreationExtra 默认实现恒拒(creation_unready);D3 前创建不得通过',
    edits: [
      {
        file: CEXTRA,
        anchor: "Promise.resolve({ ok: false, code: 'creation_unready' }),",
        replacement: 'Promise.resolve({ ok: true }),',
      },
    ],
    tests: [CEXTRA_T],
    expectRed: [D_EX, 'REFUSING_CREATION_EXTRA 恒返回', '接进 GrowthReaders.extra'],
    mustKill: ['REFUSING_CREATION_EXTRA 恒返回', '接进 GrowthReaders.extra'],
  },

  // ---------------- I15:GROWTH_SINKS 门有牙 / pass 品牌 ----------------
  {
    id: 'sink_gate_list_emptied',
    clause: 'I15:登记表被清空 / 少登记汇点 → 门红(汇点集合不符)',
    edits: [
      {
        file: SINKS,
        anchor:
          "  { file: 'src/rsi/canary/canary-writer.ts', fn: 'grantCanary', mode: 'pass_param' },\n",
        replacement: '',
      },
    ],
    tests: [ARCH_T],
    expectRed: [
      D_ARCH,
      D_ARCH_SCAN,
      '登记表非空、冻结、文件与函数都存在',
      'sink_gate_list_emptied',
      '同名扫描',
      '写出口覆盖',
    ],
    mustKill: ['登记表非空、冻结、文件与函数都存在', 'sink_gate_list_emptied'],
  },
  {
    id: 'sink_pass_param_made_optional',
    clause: 'I15:pass 形参被改成可选 → 门红',
    edits: [
      {
        file: GRANT,
        anchor: '  pass: GrowthPass,\n): Promise<GrantResult> {',
        replacement: '  pass?: GrowthPass,\n): Promise<GrantResult> {',
      },
    ],
    tests: [ARCH_T],
    expectRed: [D_ARCH, '每个登记汇点的实现合规'],
    mustKill: ['每个登记汇点的实现合规'],
  },
  {
    id: 'has_sink_pass_accepts_object_without_brand',
    clause: 'I15 / I9:pass 必须是铸造登记过的对象(强转克隆、拒绝值不算)',
    edits: [
      {
        file: SINKS,
        anchor: "  return typeof x === 'object' && x !== null && isGrowthPass(x as GrowthVerdict);",
        replacement: "  return typeof x === 'object' && x !== null;",
      },
    ],
    tests: [PASS_T],
    expectRed: [
      D_P_HAS,
      D_P_GRANT,
      D_P_ADM,
      'sink_rejects_forged_and_null_pass',
      'd1_sinks_refuse_without_pass',
    ],
    mustKill: ['sink_rejects_forged_and_null_pass', 'd1_sinks_refuse_without_pass'],
  },
  {
    id: 'has_sink_pass_null_throws',
    clause: 'I15 / I9:null / 非对象 pass 不得抛(isGrowthPass 对 null 会抛,必须先挡住)',
    edits: [
      {
        file: SINKS,
        anchor: "  return typeof x === 'object' && x !== null && isGrowthPass(x as GrowthVerdict);",
        replacement: '  return isGrowthPass(x as GrowthVerdict);',
      },
    ],
    tests: [PASS_T],
    expectRed: [
      D_P_HAS,
      D_P_GRANT,
      D_P_ADM,
      'sink_rejects_forged_and_null_pass',
      'd1_sinks_refuse_without_pass',
    ],
    mustKill: ['sink_rejects_forged_and_null_pass'],
  },
  {
    id: 'sink_registry_entry_renamed',
    clause: 'I15:登记表条目与实现的函数名脱节(改名后门找不到汇点)→ 红',
    edits: [
      {
        file: SINKS,
        anchor: "fn: 'continueBootstrap', mode: 'auth_port'",
        replacement: "fn: 'continueBootstrapRenamed', mode: 'auth_port'",
      },
    ],
    tests: [ARCH_T],
    expectRed: [
      D_ARCH,
      D_ARCH_SCAN,
      '登记表非空、冻结、文件与函数都存在',
      '每个登记汇点的实现合规',
      'sink_gate_list_emptied',
    ],
    mustKill: ['登记表非空、冻结、文件与函数都存在'],
  },

  // ---------------- 验收第 1 轮(R1)返工 ----------------
  // 第 1 条:钩子拒绝后清理结果可区分,不确认 = 不降级为普通 denied
  {
    id: 'denied_cleanup_unreadable_journal_silent',
    clause: 'R1-1:journal 读不出(被别人删)时不能静默当作干净清理(保留现场,走完整性失败路径)',
    edits: [
      {
        file: COMMIT,
        anchor:
          "  if (cur.kind !== 'ok') return { kind: 'journal_unverified', why: `journal_${cur.kind}` };",
        replacement: "  if (cur.kind !== 'ok') return { kind: 'clean' };",
      },
    ],
    tests: [HOOK_T],
    expectRed: [D_HOOK_DENY, 'denied_cleanup_journal_gone_not_plain_denied'],
    mustKill: ['denied_cleanup_journal_gone_not_plain_denied'],
  },
  {
    id: 'denied_cleanup_ref_moved_silent',
    clause: 'R1-1:refs/heads/rsi 已被别人推进时不能返回普通 denied(完整性不明,保留现场)',
    edits: [
      {
        file: COMMIT,
        anchor: "  if (actual !== oldHead) return { kind: 'ref_moved', actual };\n",
        replacement: '',
      },
    ],
    tests: [HOOK_T],
    expectRed: [D_HOOK_DENY, 'denied_cleanup_ref_moved_not_plain_denied'],
    mustKill: ['denied_cleanup_ref_moved_not_plain_denied'],
  },
  {
    id: 'denied_unverified_result_mapped_to_denied',
    clause: 'R1-1:清理结果为「journal 不能确认」时 commitPersonal 不得返回普通 denied',
    edits: [
      {
        file: COMMIT,
        anchor:
          "      if (d.kind === 'journal_unverified') {\n        return { status: 'invalid', why: d.why, breaker: PERSONAL_REPO_INVALID };\n      }\n",
        replacement: '',
      },
    ],
    tests: [HOOK_T],
    expectRed: [
      D_HOOK_DENY,
      'before_ref_update_denied_foreign_journal_untouched',
      'before_ref_update_denied_same_txn_different_content_untouched',
      'denied_cleanup_journal_gone_not_plain_denied',
    ],
    mustKill: [
      'before_ref_update_denied_foreign_journal_untouched',
      'denied_cleanup_journal_gone_not_plain_denied',
    ],
  },
  {
    id: 'denied_ref_moved_result_mapped_to_denied',
    clause: 'R1-1:清理结果为「ref 已移动」时 commitPersonal 不得返回普通 denied',
    edits: [
      {
        file: COMMIT,
        anchor:
          "      if (d.kind === 'ref_moved') {\n        return {\n          status: 'deferred',\n          reason: 'personal_repo_diverged',\n          why: 'ref_moved_after_denied',\n        };\n      }\n",
        replacement: '',
      },
    ],
    tests: [HOOK_T],
    expectRed: [D_HOOK_DENY, 'denied_cleanup_ref_moved_not_plain_denied'],
    mustKill: ['denied_cleanup_ref_moved_not_plain_denied'],
  },
  // 第 2 条:架构门反查权威写出口 + 钩子数据流
  {
    id: 'unregistered_hookless_writer_added',
    clause: 'R1-2:新增一个未登记、无钩子的权威提交写者(store.commit)→ 反查红',
    edits: [
      {
        file: RSTEP,
        anchor: '/** 对账的结果(`StepResult` 的结构化子集) */',
        replacement:
          "export async function rogueWriter(d: ApplyDeps): Promise<void> {\n  await d.store.commit({ kind: 'transition', txnId: 'x', candidateIds: [], upserts: [] });\n}\n\n/** 对账的结果(`StepResult` 的结构化子集) */",
      },
    ],
    tests: [ARCH_T],
    expectRed: [D_ARCH_AUTH, K_ARCH_AUTH],
    mustKill: [K_ARCH_AUTH],
  },
  {
    id: 'unregistered_aliased_writer_added',
    clause: 'R1-2:别名后的提交(const s = d.store; s.commit({txnId…}))也被反查到',
    edits: [
      {
        file: RSTEP,
        anchor: '/** 对账的结果(`StepResult` 的结构化子集) */',
        replacement:
          "export async function rogueAlias(d: ApplyDeps): Promise<void> {\n  const s = d.store;\n  await s.commit({ kind: 'transition', txnId: 'x', candidateIds: [], upserts: [] });\n}\n\n/** 对账的结果(`StepResult` 的结构化子集) */",
      },
    ],
    tests: [ARCH_T],
    expectRed: [D_ARCH_AUTH, K_ARCH_AUTH],
    mustKill: [K_ARCH_AUTH],
  },
  {
    id: 'creation_commit_hook_replaced_by_noop',
    clause: 'R1-2:创建提交保留 claim 但丢掉它给的钩子(换成空钩子)→ 钩子数据流红',
    edits: [
      {
        file: STEP,
        anchor: '        beforeRefUpdate: claim.hook,',
        replacement: '        beforeRefUpdate: async () => undefined,',
      },
    ],
    tests: [ARCH_T],
    expectRed: [D_ARCH, D_ARCH_AUTH, K_ARCH_FLOW, '每个登记汇点的实现合规'],
    mustKill: [K_ARCH_FLOW, '每个登记汇点的实现合规'],
  },
  {
    id: 'creation_commit_hook_removed',
    clause: 'R1-2:删掉创建提交的 hook 转交 → 钩子数据流红',
    edits: [{ file: STEP, anchor: '        beforeRefUpdate: claim.hook,\n', replacement: '' }],
    tests: [ARCH_T],
    expectRed: [
      D_ARCH_AUTH,
      D_ARCH_SCAN,
      D_ARCH,
      D_ARCH_AUTH,
      K_ARCH_FLOW,
      '每个登记汇点的实现合规',
    ],
    mustKill: [K_ARCH_FLOW, '每个登记汇点的实现合规'],
  },
  {
    id: 'apply_commit_hook_replaced_by_noop',
    clause: 'R1-2:applyIn 的提交保留条件展开但钩子换成空钩子 → 钩子数据流红',
    edits: [
      {
        file: APPLY,
        anchor: '    ...(hook !== undefined ? { beforeRefUpdate: hook } : {}),',
        replacement:
          '    ...(hook !== undefined ? { beforeRefUpdate: async () => undefined } : {}),',
      },
    ],
    tests: [ARCH_T],
    expectRed: [D_ARCH_AUTH, D_ARCH, K_ARCH_FLOW, '每个登记汇点的实现合规'],
    mustKill: [K_ARCH_FLOW],
  },
  {
    id: 'apply_event_claim_hook_dropped',
    clause: 'R1-2:applyEvent 保留 claim 但不把钩子转交 applyIn → 红',
    edits: [
      {
        file: APPLY,
        anchor: 'region, wcAfter, wc, claimed.hook);',
        replacement: 'region, wcAfter, wc, undefined);',
      },
    ],
    tests: [ARCH_T, APPLY_T],
    expectRed: [
      D_ARCH_AUTH,
      D_ARCH,
      K_ARCH_FLOW,
      'candidate-apply.ts:所有 store.commit 带 beforeRefUpdate',
      '放行:钩子进 commit 的 beforeRefUpdate',
      D_AG,
    ],
    mustKill: [K_ARCH_FLOW],
  },
  {
    id: 'apply_event_rejection_not_returned',
    clause: 'R1-2:applyEvent 被拒后不得继续往下(拒绝分支先于 applyIn)',
    edits: [
      {
        file: APPLY,
        anchor: "  if (claimed.kind === 'halt' || claimed.kind === 'denied') return claimed;\n",
        replacement: '',
      },
    ],
    tests: [ARCH_T, APPLY_T],
    expectRed: [
      D_ARCH_AUTH,
      D_ARCH,
      K_ARCH_FLOW,
      D_AG,
      D_AG_DECIDE,
      'apply_growth_claim_denied_zero_write',
      'd1_sinks_refuse_without_pass',
    ],
    mustKill: [K_ARCH_FLOW, 'apply_growth_claim_denied_zero_write'],
  },
  {
    id: 'applyin_second_caller_added',
    clause: 'R1-2:applyIn 出现第二个调用者(绕过 applyEvent 的 claim)→ 反查红',
    edits: [
      {
        file: APPLY,
        anchor: 'async function applyIn(\n  d: ApplyDeps,',
        replacement:
          "export async function backdoor(d: ApplyDeps, rec: PersonalLifecycleRecord, event: TransitionEvent, fresh: Fresh, rv: RevRead, env: Awaited<ReturnType<EnvReader['read']>>): Promise<ApplyResult> {\n  return applyIn(d, rec, event, fresh, rv, env, null);\n}\n\nasync function applyIn(\n  d: ApplyDeps,",
      },
    ],
    tests: [ARCH_T],
    expectRed: [
      D_ARCH_AUTH,
      K_ARCH_INONLY,
      'candidate-apply.ts:所有 store.commit 带 beforeRefUpdate',
    ],
    mustKill: [K_ARCH_INONLY],
  },
  // 第 3 条:创建审计的截断边界
  {
    id: 'truncation_without_creation_audit_confirm',
    clause: 'R1-3:截断创建条目之前不确认创建审计(整段确认被删)',
    edits: [
      {
        file: APPLY,
        anchor:
          '  const unconfirmed = await confirmCreationAuditBeforeTruncation(d, rec, res.next);\n  if (unconfirmed !== null) return unconfirmed;\n',
        replacement: '',
      },
    ],
    tests: [ACC_T],
    expectRed: [
      D_ACC_TRUNC,
      '截断创建条目的转移:先经带键端口落创建审计',
      'truncation_refused_when_creation_audit_unconfirmed',
    ],
    mustKill: [
      '截断创建条目的转移:先经带键端口落创建审计',
      'truncation_refused_when_creation_audit_unconfirmed',
    ],
  },
  {
    id: 'truncation_confirm_failure_swallowed',
    clause: 'R1-3:确认失败不得放行截断(失败 = 拒绝该转移)',
    edits: [
      {
        file: APPLY,
        anchor:
          "    return {\n      kind: 'halt',\n      halt: 'commit_failed',\n      why: `creation_audit_unconfirmed:${e instanceof Error ? e.message : 'error'}`,\n    };",
        replacement: '    return null;',
      },
    ],
    tests: [ACC_T],
    expectRed: [D_ACC_TRUNC, 'truncation_refused_when_creation_audit_unconfirmed'],
    mustKill: ['truncation_refused_when_creation_audit_unconfirmed'],
  },
  {
    id: 'truncation_confirm_port_missing_proceeds',
    clause: 'R1-3:缺 appendKeyed 端口时不得放行截断',
    edits: [
      {
        file: APPLY,
        anchor:
          "    return { kind: 'halt', halt: 'commit_failed', why: 'creation_audit_unconfirmed:port_missing' };",
        replacement: '    return null;',
      },
    ],
    tests: [ACC_T],
    expectRed: [D_ACC_TRUNC, '缺 appendKeyed 端口 → 拒绝截断'],
    mustKill: ['缺 appendKeyed 端口 → 拒绝截断'],
  },
  // 已删除 truncation_confirm_always(去掉 `next.transitions_dropped <= rec.transitions_dropped` 一支):等价变异。
  // 创建条目恒在 transitions[0](creationAuditItems 只在首条是创建条目时非空),转移引擎只从头部截(transition.ts 先追加再 `next.transitions_dropped += excess`),
  // 所以「创建条目离开窗口」⇔「transitions_dropped 增加」;去掉这一支后,下一行「next.transitions 仍含创建键 → return null」在 dropped 未增时必然成立(条目没被截),
  // 两者对任何可达输入给出同一结果,无可观测差别(确认端口失败 / 缺失 / deferred 在窗口内同样不被触达)。为它加断言只会钉实现细节,不反映契约。
  {
    id: 'truncation_confirm_lock_lost_swallowed',
    clause: 'R1-3:确认期间丢锁原样传播,不吞成 halt',
    edits: [
      {
        file: APPLY,
        anchor:
          "    if (e instanceof RsiLockError && e.kind === 'lock_lost') throw e;\n    if (isSealedInterval(e)) return null;\n",
        replacement: '    if (isSealedInterval(e)) return null;\n',
      },
    ],
    tests: [ACC_T],
    expectRed: [D_ACC_TRUNC, '丢锁原样传播'],
    mustKill: ['丢锁原样传播'],
  },
  {
    id: 'truncation_confirm_sealed_blocks',
    clause: 'R1-3:创建日已封存(sealed_interval)视为已确认,不得永久阻塞转移',
    edits: [
      {
        file: APPLY,
        anchor: '    if (isSealedInterval(e)) return null;\n    return {',
        replacement: '    return {',
      },
    ],
    tests: [ACC_T],
    expectRed: [D_ACC_TRUNC, '创建日已封存'],
    mustKill: ['创建日已封存'],
  },
  // 第 4 条:创建没有无封存退路
  {
    id: 'creation_seal_missing_allowed',
    clause: 'R1-4:缺 seal 时不得创建(恢复「无封存退路」→ 红)',
    edits: [
      {
        file: STEP,
        anchor: '    if (seal === undefined) {\n      creationDenied = true;',
        replacement: '    if ((seal as unknown) === 0) {\n      creationDenied = true;',
      },
      {
        file: STEP,
        anchor: '    const region = await seal.open();',
        replacement:
          '    const region =\n      seal === undefined\n        ? { stampFirst: (n: () => Date) => n().toISOString(), markSourceCommitted: () => undefined, close: () => undefined }\n        : await seal.open();',
      },
    ],
    tests: [ACC_T],
    expectRed: [D_ACC_SEAL, '放行的 claim + 不装 seal'],
    mustKill: ['放行的 claim + 不装 seal'],
  },
  {
    id: 'creation_seal_check_after_claim',
    clause: 'R1-4:缺 seal 的拒绝先于 claim(claim 不被调用)',
    edits: [
      {
        file: STEP,
        anchor: "      out.growthDenied.push({ op: 'candidate_create', code: 'seal_missing' });\n",
        replacement:
          "      out.growthDenied.push({ op: 'candidate_create', code: 'seal_missing' });\n      await claimGrowthPort(d.growth, 'candidate_create', null);\n",
      },
    ],
    tests: [ACC_T],
    expectRed: [D_ACC_SEAL, '放行的 claim + 不装 seal'],
    mustKill: ['放行的 claim + 不装 seal'],
  },
  {
    id: 'truncation_confirm_deferred_accepted',
    clause: 'R1-3:appendKeyed 返回 deferred(行没落地)不是确认,不得放行截断',
    edits: [
      {
        file: APPLY,
        anchor: "    if (landed === 'deferred') {",
        replacement: '    if ((landed as unknown) === 0) {',
      },
    ],
    tests: [ACC_T],
    expectRed: [D_ACC_TRUNC, '减影响事件(veto)', 'appendKeyed 返回 deferred'],
    mustKill: ['appendKeyed 返回 deferred'],
  },
  {
    id: 'keyed_audit_sink_drops_deferred',
    clause: 'R1-3:keyedAuditSink 把底层 applyOnce 的 deferred 如实上报(不丢)',
    edits: [
      {
        file: RECOVER,
        anchor: "    return deferred ? 'deferred' : undefined;",
        replacement: '    return undefined;',
      },
    ],
    tests: [ACC_T],
    expectRed: [D_ACC_TRUNC, 'appendKeyed 返回 deferred'],
    mustKill: ['appendKeyed 返回 deferred'],
  },
  {
    id: 'rollback_denied_falls_through',
    clause: 'R1-5:回滚路径遇到 denied 记为未推进(note),不落入推进成功的正常路径',
    edits: [
      {
        file: ROLLBACK,
        anchor: "    } else if (r.kind === 'denied') {",
        replacement: "    } else if ((r.kind as string) === 'never') {",
      },
    ],
    tests: [ACC_T],
    expectRed: [D_ACC_DENIED, '回滚路径:记录推进被 denied'],
    mustKill: ['回滚路径:记录推进被 denied'],
  },
  {
    id: 'commit_personal_import_aliased',
    clause: 'R1-2:commitPersonal 改名 import 会让按调用名的反查漏掉 → 红',
    edits: [
      { file: REPO, anchor: '  commitPersonal,\n', replacement: '  commitPersonal as cp,\n' },
    ],
    tests: [ARCH_T],
    expectRed: [D_ARCH_AUTH, 'commitPersonal 只被两个允许的文件 import'],
    mustKill: ['commitPersonal 只被两个允许的文件 import'],
  },
  {
    id: 'repo_store_forward_modified',
    clause: 'R1-2:personalRepoStore 必须原样转发 spec(不得自己改写 / 覆盖钩子)',
    edits: [
      {
        file: REPO,
        anchor: 'commit: (spec) => commitPersonal(deps, locks, spec),',
        replacement:
          'commit: (spec) => commitPersonal(deps, locks, { ...spec, beforeRefUpdate: undefined }),',
      },
    ],
    tests: [ARCH_T],
    expectRed: [D_ARCH_AUTH, '白名单写者的形状'],
    mustKill: ['白名单写者的形状'],
  },
];

/** 变异执行结果:由主代理跑完整表后按 `V1_ASM_D1B2_MUTATIONS` 的顺序回填(本块不执行变异,留空) */
export const V1_ASM_D1B2_RESULTS: readonly V1AsmD1b2Result[] = [];
