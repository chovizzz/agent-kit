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
const ERRORS = 'src/rsi/personal/stage/errors.ts';

const HOOK_T = 'rsi/d1b2/commit-hook.test.ts';
const APPLY_T = 'rsi/d1b2/apply-growth.test.ts';
const EVENTS_T = 'rsi/d1b2/growth-events.test.ts';
const STEP_T = 'rsi/d1b2/step-creation.test.ts';
const PASS_T = 'rsi/d1b2/sinks-pass.test.ts';
const CAUDIT_T = 'rsi/d1b2/creation-audit.test.ts';
const CEXTRA_T = 'rsi/d1b2/creation-extra.test.ts';
const ARCH_T = 'rsi/d1b2/growth-sinks-arch.test.ts';
const STAMP_T = 'rsi/asm/b-entry-stamp-arch.test.ts';
const FB_T = 'rsi/stage/c1-fallback.test.ts';

/** 各测试文件的 describe 标题(失败集合须 ⊆ expectRed;所以把整个 describe 记为「命中范围」) */
const D_HOOK_DENY = 'beforeRefUpdate:拒绝';
const D_HOOK_OTHER = 'beforeRefUpdate:其它错误一律传播(不当成拒绝)';
const D_HOOK_POS = 'beforeRefUpdate:位置与锁复核';
const D_AG = '增影响事件:端口缺 / 拒 / 畸形 = growth_denied 且零写入';
const D_AG_DECIDE = 'decide_better_always_refused_as_growth / 未登记事件';
const D_EV = 'event_kind_classified:增影响分类穷举';
const D_S_CREATE =
  '创建提交先过 growth 端口(d1_sinks_refuse_without_pass / creation_commit_without_claim)';
const D_S_NOHALT = '被拒的增影响动作不阻止减影响子步骤(不 halt)';
const D_S_STAMP = '创建取时经封存区域(I11)';
const D_S_AUDIT = '创建审计经唯一派生点、带键落地(I13 的即时一半)';
const D_S_OBS = '观察行只经 appendObservation(I12)';
const D_S_LOCKS = 'StepDeps.locks 两把锁都要持(I9 的锁半)';
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
const D_FB = 'classifyHalt(StepHalt 的处置;lock_lost 不能默认当个人锁)';

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
        anchor: "  if (!same || (a.phase !== 'planned' && a.phase !== 'objects_written')) return;",
        replacement: "  if (a.phase !== 'planned' && a.phase !== 'objects_written') return;",
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
          '): Promise<void> {\n  await assertLocks(ctx);\n  const cur = await readJournal(ctx.h);',
        replacement: '): Promise<void> {\n  const cur = await readJournal(ctx.h);',
      },
    ],
    tests: [HOOK_T],
    expectRed: [D_HOOK_POS, '拒绝后清理 journal 之前先复核锁'],
    mustKill: ['拒绝后清理 journal 之前先复核锁'],
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
    expectRed: [D_HOOK_DENY, 'before_ref_update_denied_ref_unchanged_journal_removed'],
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
        anchor:
          "  if (op === 'unmappable') return { kind: 'halt', halt: 'growth_denied', why: 'unmappable' };\n",
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
    id: 'apply_denied_commit_not_growth_denied',
    clause: 'I9:提交前复核拒(commit denied)= growth_denied + 原因码,不是 commit_failed',
    edits: [
      {
        file: APPLY,
        anchor:
          "  if (c.status === 'denied') return { kind: 'halt', halt: 'growth_denied', why: c.code };\n",
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
        anchor: "  if (o.ok === true && typeof o.hook === 'function') {",
        replacement: '  if (o.ok === true) {',
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
    expectRed: [D_S_CREATE, D_ARCH, '提交前复核拒(commit 返回 denied)', '每个登记汇点的实现合规'],
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
        anchor:
          "    if (r.kind === 'halt' && r.halt === 'growth_denied' && out.growthDenied !== undefined) {",
        replacement:
          "    if (r.kind === 'halt' && r.halt === 'growth_denied' && out.growthDenied === undefined) {",
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
    id: 'growth_denied_halt_class_unsettled',
    clause:
      'I9:growth_denied 的 halt 分类 = 只停本步(不使本轮 unsettled;被拒的增影响动作没有写任何东西)',
    edits: [
      {
        file: ERRORS,
        anchor: "  growth_denied: { kind: 'stop_step' },",
        replacement:
          "  growth_denied: { kind: 'stop_step_unsettled', cause: 'candidate_invalid' },",
      },
    ],
    tests: [FB_T],
    expectRed: [D_FB, '逐值钉死'],
    mustKill: ['逐值钉死'],
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
        anchor:
          '        now = region === null ? unsealedEntryTime(d.now) : region.stampFirst(d.now);',
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
    edits: [{ file: STEP, anchor: '      region?.close();', replacement: '      void 0;' }],
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
];

/** 变异执行结果:由主代理跑完整表后按 `V1_ASM_D1B2_MUTATIONS` 的顺序回填(本块不执行变异,留空) */
export const V1_ASM_D1B2_RESULTS: readonly V1AsmD1b2Result[] = [];
