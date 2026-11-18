/**
 * §21 V1 装配块 D1b-1(`openPersonalRepo` 判别联合 + 删 S1 前置守卫与 `refuseBootstrapRecovery` + 全部调用方)必杀变异。
 * 执行方式同 B1a / B1b / C1a / C1b / C2:验证机私有检出里 cp 备份 → 按锚点替换(每个锚点在对应文件里**恰好出现一次**)→ 跑 `tests` → 失败集合非空、全部命中 `expectRed`、
 * `mustKill` 每项至少命中一个、没有 skipped → cp 还原并逐文件 sha256 核对。**不用 git checkout / stash 还原**。
 * 本文件只写表与每条变异期望红的测试名(`expectRed` = 所在测试文件的 describe 标题或精确杀手名;`mustKill` 才是精确断言);变异由主代理整表执行,结果记进 `V1_ASM_D1B1_RESULTS`(本块不执行变异,故留空)。
 * 锚点是 prettier 之后的文本。
 * 去向说明:C2 表里与已删守卫绑定的 5 条(`s1_calls_open_with_bootstrap_journal` / `s1_invalid_journal_still_opens` / `asm_open_repo_with_bootstrap_option` /
 * `open_repo_recovers_bootstrap_when_refused` / `asm_repo_deps_without_refuse`)由本表取代:I1 ← `guard_kept_after_complete_only` / `s1_uses_bootstrap_mode`;
 * I5 ← `pending_mapped_to_invalid`;I6 ← `commit_personal_uses_complete_only` / `read_files_uses_bootstrap_mode` / `read_mode_recovers_bootstrap`。
 */
export interface Edit {
  file: string;
  anchor: string;
  replacement: string;
}

export interface V1AsmD1b1Mutation {
  id: string;
  /** 不变量 */
  clause: string;
  edits: readonly Edit[];
  /** 相对 `test/` */
  tests: readonly string[];
  expectRed: readonly string[];
  mustKill: readonly string[];
}

export interface V1AsmD1b1Result {
  id: string;
  failed: number;
  skipped: number;
  killedBy: readonly string[];
  restored: boolean;
}

const COMMIT = 'src/rsi/personal/commit.ts';
const JOURNAL = 'src/rsi/personal/commit-journal.ts';
const RECOVER = 'src/rsi/personal/steps/repo-recover.ts';
const ASSEMBLE = 'src/rsi/assemble-personal.ts';

const OPEN_TEST = 'rsi/d1b1/open-modes.test.ts';
const ARCH_TEST = 'rsi/d1b1/arch.test.ts';
const S1_TEST = 'rsi/c2/c2-steps-s1.test.ts';
const E2E_TEST = 'rsi/c2/c2-assemble-e2e.test.ts';
const W2_BOOT_TEST = 'rsi/personal/repo-bootstrap.test.ts';

/** 各测试文件的 describe 标题(失败集合须 ⊆ expectRed;所以把整个 describe 记为「命中范围」) */
const D_READ = 'read 模式:bootstrap 类 journal 一律不动';
const D_CO = 'complete_only:只做 committed → recorded';
const D_S1 = 'S1 端口(真 openPersonalRepo complete_only + createRepoRecovery)';
const D_AUTH = 'bootstrap 模式:授权边界与崩溃窗口';
const D_WP = '命令路径(personalRepoStore,repoDeps 与 assemble-write 同形:无任何开关)';
const D_DEF = 'D1b-1 端口纵深防御与映射';
const D_ARCH = 'D1b-1 架构钉子';
const D_MAP = 'S1 仓库恢复映射';
const D_W2 = 'W0-5 bootstrap';
const D_E2E = 'C2 生产装配(真 worker)';
const OPEN_ALL = [D_READ, D_CO, D_S1, D_AUTH, D_DEF, D_WP] as const;

export const V1_ASM_D1B1_MUTATIONS: readonly V1AsmD1b1Mutation[] = [
  {
    id: 's1_uses_bootstrap_mode',
    clause: 'I1:S1 只用 complete_only,不用 bootstrap 模式(本期 bootstrap 模式无生产调用方)',
    edits: [
      {
        file: ASSEMBLE,
        anchor: "{ mode: 'complete_only' }",
        replacement: "{ mode: 'bootstrap', auth: { authorize: async () => undefined } }",
      },
    ],
    tests: [E2E_TEST, ARCH_TEST],
    expectRed: [
      D_E2E,
      D_ARCH,
      's1_never_resumes_bootstrap_without_authorization',
      'openPersonalRepo 的生产调用方与模式',
    ],
    mustKill: [
      's1_never_resumes_bootstrap_without_authorization',
      'openPersonalRepo 的生产调用方与模式',
    ],
  },
  {
    id: 'guard_kept_after_complete_only',
    clause: 'I1:S1 不得在 open 之前另设 bootstrap 守卫(端口自己保证;守卫不得替代端口的权威验证)',
    edits: [
      {
        file: RECOVER,
        anchor: '    let r: OpenOutcome;',
        replacement:
          "    return { kind: 'incomplete', why: 'bootstrap_pending' };\n    let r: OpenOutcome;",
      },
    ],
    tests: [S1_TEST, OPEN_TEST],
    expectRed: [
      D_MAP,
      D_S1,
      'open 结果映射',
      's1_committed_bootstrap_completes_with_matching_ref_and_tree',
    ],
    mustKill: ['open 结果映射', 's1_committed_bootstrap_completes_with_matching_ref_and_tree'],
  },
  {
    id: 'pending_mapped_to_invalid',
    clause: 'I5:bootstrap_pending 在 S1 = incomplete(不熔断),不是 invalid',
    edits: [
      {
        file: RECOVER,
        anchor: "        return { kind: 'incomplete', why: 'bootstrap_pending' };",
        replacement: "        return { kind: 'invalid' };",
      },
    ],
    tests: [S1_TEST, OPEN_TEST],
    expectRed: [D_MAP, D_S1, 'open 结果映射', 's1_planned_initialized_never_init_or_cas'],
    mustKill: ['open 结果映射', 's1_planned_initialized_never_init_or_cas'],
  },
  {
    id: 'complete_only_early_guard_removed',
    clause: 'I2:complete_only 遇 planned / initialized 返回 bootstrap_pending,不进入续做',
    edits: [
      {
        file: COMMIT,
        anchor:
          "      if (mode === 'complete_only' && early) return { kind: 'bootstrap_pending' };",
        replacement: '      void early;',
      },
    ],
    tests: [OPEN_TEST, E2E_TEST],
    expectRed: [
      ...OPEN_ALL,
      D_E2E,
      'complete_only_planned_initialized_never_init_or_cas',
      's1_planned_initialized_never_init_or_cas',
    ],
    mustKill: [
      'complete_only_planned_initialized_never_init_or_cas',
      's1_planned_initialized_never_init_or_cas',
    ],
  },
  {
    id: 'complete_only_runs_init',
    clause: 'I2:complete_only 绝不 init / CAS(早退被拿掉且授权被放行 → 真的建仓)',
    edits: [
      {
        file: COMMIT,
        anchor:
          "      if (mode === 'complete_only' && early) return { kind: 'bootstrap_pending' };",
        replacement: '      void early;',
      },
      {
        file: COMMIT,
        anchor: "      const auth = opts.mode === 'bootstrap' ? opts.auth : NO_BOOTSTRAP_AUTH;",
        replacement:
          "      const auth: BootstrapAuth =\n        opts.mode === 'bootstrap' ? opts.auth : { authorize: async () => undefined };",
      },
    ],
    tests: [OPEN_TEST, E2E_TEST],
    expectRed: [
      ...OPEN_ALL,
      D_E2E,
      'complete_only_planned_initialized_never_init_or_cas',
      's1_never_resumes_bootstrap_without_authorization',
    ],
    mustKill: [
      'complete_only_planned_initialized_never_init_or_cas',
      's1_never_resumes_bootstrap_without_authorization',
    ],
  },
  {
    id: 'no_bootstrap_auth_permissive',
    clause: 'I2 纵深:complete_only 用的授权恒拒',
    edits: [
      {
        file: JOURNAL,
        anchor: '  authorize: (step) => Promise.reject(new BootstrapDenied(step)),',
        replacement: '  authorize: () => Promise.resolve(),',
      },
    ],
    tests: [OPEN_TEST],
    expectRed: [...OPEN_ALL, 'no_bootstrap_auth_denies_every_step'],
    mustKill: ['no_bootstrap_auth_denies_every_step'],
  },
  {
    id: 'complete_only_trusts_journal_new_commit',
    clause:
      'I3:committed 先读真实 ref(不信 journal 的 new_commit);与 W2 表 :504 同锚点,本表补 complete_only 入口的杀手',
    edits: [
      {
        file: JOURNAL,
        anchor: "if (revParse(c.git, 'refs/heads/rsi') !== done) return inconsistent();",
        replacement: 'if (done !== done) return inconsistent();',
      },
    ],
    tests: [OPEN_TEST, W2_BOOT_TEST],
    expectRed: [
      ...OPEN_ALL,
      D_W2,
      'complete_only_committed_mismatched_ref_invalid_journal_kept',
      's1_committed_bootstrap_mismatched_ref_invalid_journal_kept',
    ],
    mustKill: [
      'complete_only_committed_mismatched_ref_invalid_journal_kept',
      's1_committed_bootstrap_mismatched_ref_invalid_journal_kept',
    ],
  },
  {
    id: 'read_mode_recovers_bootstrap',
    clause: 'I4:read 模式不动 bootstrap journal',
    edits: [
      {
        file: COMMIT,
        anchor: "      if (mode === 'read') return { kind: 'bootstrap_pending' };",
        replacement: '      void 0;',
      },
    ],
    tests: [OPEN_TEST],
    expectRed: [...OPEN_ALL, 'read_mode_never_touches_bootstrap_journal'],
    mustKill: ['read_mode_never_touches_bootstrap_journal'],
  },
  {
    id: 'read_mode_builds_repo',
    clause: 'I4:read / complete_only 首次(无 journal 无仓库)只返回 absent,不建仓',
    edits: [
      {
        file: COMMIT,
        anchor: "      if (opts.mode !== 'bootstrap') return { kind: 'absent' };",
        replacement: '      void 0;',
      },
    ],
    tests: [OPEN_TEST],
    expectRed: [...OPEN_ALL, 'read 模式:首次(无 journal、无仓库)→ absent'],
    mustKill: ['read 模式:首次(无 journal、无仓库)→ absent'],
  },
  {
    id: 'commit_personal_uses_complete_only',
    clause: 'I6:commitPersonal 内部写死 read 模式',
    edits: [
      {
        file: COMMIT,
        anchor:
          "): Promise<CommitResult> {\n  const open = await openPersonalRepo(deps, locks, { mode: 'read' });",
        replacement:
          "): Promise<CommitResult> {\n  const open = await openPersonalRepo(deps, locks, { mode: 'complete_only' });",
      },
    ],
    tests: [OPEN_TEST, ARCH_TEST],
    expectRed: [
      ...OPEN_ALL,
      D_ARCH,
      'read_mode_never_touches_bootstrap_journal',
      'write_path_never_resumes_bootstrap',
      'openPersonalRepo 的生产调用方与模式',
    ],
    mustKill: [
      'read_mode_never_touches_bootstrap_journal',
      'write_path_never_resumes_bootstrap',
      'openPersonalRepo 的生产调用方与模式',
    ],
  },
  {
    id: 'read_files_uses_bootstrap_mode',
    clause: 'I6:readPersonalFiles 内部写死 read 模式(不得带 bootstrap 授权)',
    edits: [
      {
        file: COMMIT,
        anchor:
          "): Promise<ReadFilesResult> {\n  const open = await openPersonalRepo(deps, locks, { mode: 'read' });",
        replacement:
          "): Promise<ReadFilesResult> {\n  const open = await openPersonalRepo(deps, locks, {\n    mode: 'bootstrap',\n    auth: { authorize: async () => undefined },\n  });",
      },
    ],
    tests: [OPEN_TEST, ARCH_TEST],
    expectRed: [
      ...OPEN_ALL,
      D_ARCH,
      'read_mode_never_touches_bootstrap_journal',
      'write_path_never_resumes_bootstrap',
      'openPersonalRepo 的生产调用方与模式',
    ],
    mustKill: [
      'read_mode_never_touches_bootstrap_journal',
      'write_path_never_resumes_bootstrap',
      'openPersonalRepo 的生产调用方与模式',
    ],
  },
  {
    id: 'commit_wrapper_ignores_pending',
    clause: 'I6:commitPersonal 把 bootstrap_pending 映射成 invalid{bootstrap_pending}',
    edits: [
      {
        file: COMMIT,
        anchor:
          "    return { status: 'invalid', why: open.why, breaker: open.breaker };\n  }\n  if (open.kind === 'bootstrap_pending' || open.kind === 'bootstrap_denied') {",
        replacement:
          "    return { status: 'invalid', why: open.why, breaker: open.breaker };\n  }\n  if (open.kind === 'bootstrap_denied') {",
      },
    ],
    tests: [OPEN_TEST],
    expectRed: [...OPEN_ALL, 'read_mode_never_touches_bootstrap_journal'],
    mustKill: ['read_mode_never_touches_bootstrap_journal'],
  },
  {
    id: 'read_wrapper_ignores_pending',
    clause: 'I6:readPersonalFiles 把 bootstrap_pending 映射成 invalid{bootstrap_pending}',
    edits: [
      {
        file: COMMIT,
        anchor:
          "  if (open.kind === 'invalid') return { status: 'invalid', why: open.why, breaker: open.breaker };\n  if (open.kind === 'bootstrap_pending' || open.kind === 'bootstrap_denied') {",
        replacement:
          "  if (open.kind === 'invalid') return { status: 'invalid', why: open.why, breaker: open.breaker };\n  if (open.kind === 'bootstrap_denied') {",
      },
    ],
    tests: [OPEN_TEST],
    expectRed: [...OPEN_ALL, 'read_mode_never_touches_bootstrap_journal'],
    mustKill: ['read_mode_never_touches_bootstrap_journal'],
  },
  {
    id: 'auth_entry_check_removed',
    clause: 'I7:bootstrap 模式在任何副作用之前校验 auth 形状',
    edits: [
      {
        file: COMMIT,
        anchor: "  if (mode === 'bootstrap' && !authShapeOk(opts)) {",
        replacement: '  if (false) {',
      },
    ],
    tests: [OPEN_TEST],
    expectRed: [...OPEN_ALL, 'bootstrap_malformed_auth_refused_before_any_write'],
    mustKill: ['bootstrap_malformed_auth_refused_before_any_write'],
  },
  {
    id: 'authorize_init_skipped',
    clause: 'I7:git init(含其前 mkdir)之前必须 authorize(init)',
    edits: [
      {
        file: JOURNAL,
        anchor: "      await authorizeStep(auth, 'init'); // 任何 mkdir / git init 之前\n",
        replacement: '',
      },
    ],
    tests: [OPEN_TEST],
    expectRed: [
      ...OPEN_ALL,
      'bootstrap_init_denied_nothing_written',
      'bootstrap_authorize_called_once_per_boundary',
    ],
    mustKill: [
      'bootstrap_init_denied_nothing_written',
      'bootstrap_authorize_called_once_per_boundary',
    ],
  },
  {
    id: 'authorize_init_after_mkdir',
    clause: 'I7:authorize(init) 在 makeRepoDir 之前(挪到之后 → 被拒时已建目录)',
    edits: [
      {
        file: JOURNAL,
        anchor: "      await authorizeStep(auth, 'init'); // 任何 mkdir / git init 之前\n",
        replacement: '',
      },
      {
        file: JOURNAL,
        anchor: "      if (dir === 'missing') await makeRepoDir(c.h);",
        replacement:
          "      if (dir === 'missing') await makeRepoDir(c.h);\n      await authorizeStep(auth, 'init');",
      },
    ],
    tests: [OPEN_TEST],
    expectRed: [...OPEN_ALL, 'bootstrap_init_denied_nothing_written'],
    mustKill: ['bootstrap_init_denied_nothing_written'],
  },
  {
    id: 'authorize_cas_skipped',
    clause: 'I7:mktree 之前必须 authorize(cas)',
    edits: [
      {
        file: JOURNAL,
        anchor:
          "      await authorizeStep(auth, 'cas'); // 任何对象写入(mktree / commit-tree)与引用写入之前\n",
        replacement: '',
      },
    ],
    tests: [OPEN_TEST],
    expectRed: [
      ...OPEN_ALL,
      'bootstrap_cas_denied_before_mktree',
      'bootstrap_authorize_called_once_per_boundary',
    ],
    mustKill: [
      'bootstrap_cas_denied_before_mktree',
      'bootstrap_authorize_called_once_per_boundary',
    ],
  },
  {
    id: 'authorize_cas_after_mktree',
    clause: 'I7:authorize(cas) 在 mktree 之前(挪到之后 → 被拒时空树对象已落盘)',
    edits: [
      {
        file: JOURNAL,
        anchor:
          "      await authorizeStep(auth, 'cas'); // 任何对象写入(mktree / commit-tree)与引用写入之前\n",
        replacement: '',
      },
      {
        file: JOURNAL,
        anchor: '      if (tree !== EMPTY_TREE) return inconsistent();\n',
        replacement:
          "      if (tree !== EMPTY_TREE) return inconsistent();\n      await authorizeStep(auth, 'cas');\n",
      },
    ],
    tests: [OPEN_TEST],
    expectRed: [...OPEN_ALL, 'bootstrap_cas_denied_before_mktree'],
    mustKill: ['bootstrap_cas_denied_before_mktree'],
  },
  {
    id: 'authorize_cas_reuses_init_call',
    clause: 'I7:cas 边界用自己的授权步骤(不复用 init)',
    edits: [
      {
        file: JOURNAL,
        anchor:
          "      await authorizeStep(auth, 'cas'); // 任何对象写入(mktree / commit-tree)与引用写入之前\n",
        replacement: "      await authorizeStep(auth, 'init');\n",
      },
    ],
    tests: [OPEN_TEST],
    expectRed: [
      ...OPEN_ALL,
      'bootstrap_authorize_called_once_per_boundary',
      'bootstrap_cas_denied_before_mktree',
    ],
    mustKill: [
      'bootstrap_authorize_called_once_per_boundary',
      'bootstrap_cas_denied_before_mktree',
    ],
  },
  {
    id: 'authorize_lock_error_mapped_to_denied',
    clause: 'I7:authorize 抛锁丢失原样上抛(不映射 denied)',
    edits: [
      {
        file: JOURNAL,
        anchor: '    if (e instanceof RsiLockError || code === PERSONAL_LOCK_LOST_CODE) throw e;',
        replacement: '    void code;',
      },
    ],
    tests: [OPEN_TEST],
    expectRed: [...OPEN_ALL, 'bootstrap_authorize_lock_lost_propagates'],
    mustKill: ['bootstrap_authorize_lock_lost_propagates'],
  },
  {
    id: 'personal_lock_lost_not_detected',
    clause: 'I7:PersonalLockLost(code 判别)同样原样上抛',
    edits: [
      {
        file: JOURNAL,
        anchor: 'code === PERSONAL_LOCK_LOST_CODE',
        replacement: 'false',
      },
    ],
    tests: [OPEN_TEST],
    expectRed: [...OPEN_ALL, 'bootstrap_authorize_lock_lost_propagates'],
    mustKill: ['bootstrap_authorize_lock_lost_propagates'],
  },
  {
    id: 'denied_mapping_removed',
    clause: 'I7:BootstrapDenied 映射成 bootstrap_denied 结果(不当异常上抛)',
    edits: [
      {
        file: COMMIT,
        anchor:
          "    if (e instanceof BootstrapDenied) return { kind: 'bootstrap_denied', step: e.step };",
        replacement: '    void e;',
      },
    ],
    tests: [OPEN_TEST],
    expectRed: [
      ...OPEN_ALL,
      'bootstrap_init_denied_nothing_written',
      'bootstrap_cas_denied_before_mktree',
    ],
    mustKill: ['bootstrap_init_denied_nothing_written', 'bootstrap_cas_denied_before_mktree'],
  },
  {
    id: 'denied_step_mislabeled',
    clause: 'I7:bootstrap_denied 带出被拒的边界(init / cas)',
    edits: [
      {
        file: COMMIT,
        anchor: "{ kind: 'bootstrap_denied', step: e.step }",
        replacement: "{ kind: 'bootstrap_denied', step: 'init' }",
      },
    ],
    tests: [OPEN_TEST],
    expectRed: [...OPEN_ALL, 'bootstrap_cas_denied_before_mktree'],
    mustKill: ['bootstrap_cas_denied_before_mktree'],
  },
  {
    id: 'outcome_denied_not_pending',
    clause: 'I5:bootstrap_denied 在 S1 同样按 incomplete 处理(不熔断)',
    edits: [
      {
        file: RECOVER,
        anchor:
          "    case 'bootstrap_pending':\n    case 'bootstrap_denied':\n      return { kind: 'bootstrap_pending' };",
        replacement:
          "    case 'bootstrap_pending':\n      return { kind: 'bootstrap_pending' };\n    case 'bootstrap_denied':\n      return { kind: 'invalid', why: 'bootstrap_denied' };",
      },
    ],
    tests: [OPEN_TEST],
    expectRed: [...OPEN_ALL, 'outcome_of_open_maps_every_kind'],
    mustKill: ['outcome_of_open_maps_every_kind'],
  },
  {
    id: 'committed_commit_tree_unchecked',
    clause: 'I3:committed / recorded 还要核对提交本身是空树根提交(不能只信 journal 与 ref 同指)',
    edits: [
      {
        file: JOURNAL,
        anchor:
          '  if (revParse(c.git, `${done}^{tree}`) !== EMPTY_TREE || revParse(c.git, `${done}^`) !== null) {',
        replacement: '  if (false) {',
      },
    ],
    tests: [OPEN_TEST, W2_BOOT_TEST],
    expectRed: [...OPEN_ALL, D_W2, 'nonempty_tree_commit_invalid_journal_kept'],
    mustKill: ['nonempty_tree_commit_invalid_journal_kept'],
  },
];

/** 执行后由主代理回填(本块不执行变异) */
export const V1_ASM_D1B1_RESULTS: readonly V1AsmD1b1Result[] = [
  {
    id: 's1_uses_bootstrap_mode',
    failed: 3,
    skipped: 0,
    killedBy: [
      'C2 生产装配(真 worker) 私有仓库未建:S1 / S2 全程无故障,growth open,个人锁已释放,不建 .git',
      'C2 生产装配(真 worker) s1_never_resumes_bootstrap_without_authorization — bootstrap journal(planned / initialized)→ S1 不续建仓,incomplete{bootstrap_pending};.git 不出现、journal 字节不变',
      'D1b-1 架构钉子 openPersonalRepo 的生产调用方与模式:assemble-personal = [complete_only];commit.ts = [read, read];其余文件无调用',
    ],
    restored: true,
  },
  {
    id: 'guard_kept_after_complete_only',
    failed: 5,
    skipped: 0,
    killedBy: [
      'S1 仓库恢复映射(createRepoRecovery:open 结果 → RepoRecovery) open 结果映射:absent / ready / invalid / deferred(两个原因)/ bootstrap_pending(incomplete,不熔断);open 恒被调用',
      'S1 仓库恢复映射(createRepoRecovery:open 结果 → RepoRecovery) git 读失败(open 抛非锁错误)= 仓库不可用 invalid;锁错误 / 失锁原样上抛',
      'S1 端口(真 openPersonalRepo complete_only + createRepoRecovery) s1_committed_bootstrap_completes_with_matching_ref_and_tree — judged at_record;journal 已删、head.json 已写',
      'S1 端口(真 openPersonalRepo complete_only + createRepoRecovery) s1_committed_bootstrap_mismatched_ref_invalid_journal_kept — 熔断(invalid);journal 保留,不写 head.json',
      'S1 端口(真 openPersonalRepo complete_only + createRepoRecovery) s1_invalid_journal_is_invalid — journal 不合规 → invalid(由端口自己判,不再有前置守卫)',
    ],
    restored: true,
  },
  {
    id: 'pending_mapped_to_invalid',
    failed: 6,
    skipped: 0,
    killedBy: [
      'S1 仓库恢复映射(createRepoRecovery:open 结果 → RepoRecovery) open 结果映射:absent / ready / invalid / deferred(两个原因)/ bootstrap_pending(incomplete,不熔断);open 恒被调用',
      'S1 端口(真 openPersonalRepo complete_only + createRepoRecovery) s1_planned_initialized_never_init_or_cas_planned_missing — incomplete{bootstrap_pending}(不熔断);零步骤点,journal 字节与仓库状态不变',
      'S1 端口(真 openPersonalRepo complete_only + createRepoRecovery) s1_planned_initialized_never_init_or_cas_planned_empty — incomplete{bootstrap_pending}(不熔断);零步骤点,journal 字节与仓库状态不变',
      'S1 端口(真 openPersonalRepo complete_only + createRepoRecovery) s1_planned_initialized_never_init_or_cas_planned_after_init — incomplete{bootstrap_pending}(不熔断);零步骤点,journal 字节与仓库状态不变',
      'S1 端口(真 openPersonalRepo complete_only + createRepoRecovery) s1_planned_initialized_never_init_or_cas_initialized — incomplete{bootstrap_pending}(不熔断);零步骤点,journal 字节与仓库状态不变',
      'S1 端口(真 openPersonalRepo complete_only + createRepoRecovery) s1_planned_initialized_never_init_or_cas_initialized_after_cas — incomplete{bootstrap_pending}(不熔断);零步骤点,journal 字节与仓库状态不变',
    ],
    restored: true,
  },
  {
    id: 'complete_only_early_guard_removed',
    failed: 9,
    skipped: 0,
    killedBy: [
      'C2 生产装配(真 worker) s1_never_resumes_bootstrap_without_authorization — bootstrap journal(planned / initialized)→ S1 不续建仓,incomplete{bootstrap_pending};.git 不出现、journal 字节不变',
      'complete_only:只做 committed → recorded complete_only_planned_initialized_never_init_or_cas_planned_missing — bootstrap_pending;无任何步骤点、journal 字节与仓库状态不变',
      'complete_only:只做 committed → recorded complete_only_planned_initialized_never_init_or_cas_planned_empty — bootstrap_pending;无任何步骤点、journal 字节与仓库状态不变',
      'complete_only:只做 committed → recorded complete_only_planned_initialized_never_init_or_cas_planned_after_init — bootstrap_pending;无任何步骤点、journal 字节与仓库状态不变',
      'complete_only:只做 committed → recorded complete_only_planned_initialized_never_init_or_cas_initialized — bootstrap_pending;无任何步骤点、journal 字节与仓库状态不变',
      'complete_only:只做 committed → recorded complete_only_planned_initialized_never_init_or_cas_initialized_after_cas — bootstrap_pending;无任何步骤点、journal 字节与仓库状态不变',
      'S1 端口(真 openPersonalRepo complete_only + createRepoRecovery) s1_planned_initialized_never_init_or_cas_planned_missing — incomplete{bootstrap_pending}(不熔断);零步骤点,journal 字节与仓库状态不变',
      'S1 端口(真 openPersonalRepo complete_only + createRepoRecovery) s1_planned_initialized_never_init_or_cas_planned_after_init — incomplete{bootstrap_pending}(不熔断);零步骤点,journal 字节与仓库状态不变',
      'S1 端口(真 openPersonalRepo complete_only + createRepoRecovery) s1_planned_initialized_never_init_or_cas_initialized_after_cas — incomplete{bootstrap_pending}(不熔断);零步骤点,journal 字节与仓库状态不变',
    ],
    restored: true,
  },
  {
    id: 'complete_only_runs_init',
    failed: 11,
    skipped: 0,
    killedBy: [
      'C2 生产装配(真 worker) s1_never_resumes_bootstrap_without_authorization — bootstrap journal(planned / initialized)→ S1 不续建仓,incomplete{bootstrap_pending};.git 不出现、journal 字节不变',
      'complete_only:只做 committed → recorded complete_only_planned_initialized_never_init_or_cas_planned_missing — bootstrap_pending;无任何步骤点、journal 字节与仓库状态不变',
      'complete_only:只做 committed → recorded complete_only_planned_initialized_never_init_or_cas_planned_empty — bootstrap_pending;无任何步骤点、journal 字节与仓库状态不变',
      'complete_only:只做 committed → recorded complete_only_planned_initialized_never_init_or_cas_planned_after_init — bootstrap_pending;无任何步骤点、journal 字节与仓库状态不变',
      'complete_only:只做 committed → recorded complete_only_planned_initialized_never_init_or_cas_initialized — bootstrap_pending;无任何步骤点、journal 字节与仓库状态不变',
      'complete_only:只做 committed → recorded complete_only_planned_initialized_never_init_or_cas_initialized_after_cas — bootstrap_pending;无任何步骤点、journal 字节与仓库状态不变',
      'S1 端口(真 openPersonalRepo complete_only + createRepoRecovery) s1_planned_initialized_never_init_or_cas_planned_missing — incomplete{bootstrap_pending}(不熔断);零步骤点,journal 字节与仓库状态不变',
      'S1 端口(真 openPersonalRepo complete_only + createRepoRecovery) s1_planned_initialized_never_init_or_cas_planned_empty — incomplete{bootstrap_pending}(不熔断);零步骤点,journal 字节与仓库状态不变',
      'S1 端口(真 openPersonalRepo complete_only + createRepoRecovery) s1_planned_initialized_never_init_or_cas_planned_after_init — incomplete{bootstrap_pending}(不熔断);零步骤点,journal 字节与仓库状态不变',
      'S1 端口(真 openPersonalRepo complete_only + createRepoRecovery) s1_planned_initialized_never_init_or_cas_initialized — incomplete{bootstrap_pending}(不熔断);零步骤点,journal 字节与仓库状态不变',
      'S1 端口(真 openPersonalRepo complete_only + createRepoRecovery) s1_planned_initialized_never_init_or_cas_initialized_after_cas — incomplete{bootstrap_pending}(不熔断);零步骤点,journal 字节与仓库状态不变',
    ],
    restored: true,
  },
  {
    id: 'no_bootstrap_auth_permissive',
    failed: 1,
    skipped: 0,
    killedBy: [
      'D1b-1 端口纵深防御与映射 no_bootstrap_auth_denies_every_step — complete_only 用的授权恒拒(BootstrapDenied,带 step)',
    ],
    restored: true,
  },
  {
    id: 'complete_only_trusts_journal_new_commit',
    failed: 3,
    skipped: 0,
    killedBy: [
      'complete_only:只做 committed → recorded complete_only_committed_mismatched_ref_invalid_journal_kept — ref 被改成别的值 → invalid{bootstrap_inconsistent};journal 保留,不写 head.json',
      'S1 端口(真 openPersonalRepo complete_only + createRepoRecovery) s1_committed_bootstrap_mismatched_ref_invalid_journal_kept — 熔断(invalid);journal 保留,不写 head.json',
      'W0-5 bootstrap 崩溃恢复(四个 phase 之间各注入一次) committed 之后引用被改成别的值 → personal_repo_invalid,保留 journal',
    ],
    restored: true,
  },
  {
    id: 'read_mode_recovers_bootstrap',
    failed: 10,
    skipped: 0,
    killedBy: [
      'read 模式:bootstrap 类 journal 一律不动 read_mode_never_touches_bootstrap_journal_planned_missing — bootstrap_pending;commitPersonal / readPersonalFiles = invalid{bootstrap_pending};bootstrap 相关零写',
      'read 模式:bootstrap 类 journal 一律不动 read_mode_never_touches_bootstrap_journal_planned_empty — bootstrap_pending;commitPersonal / readPersonalFiles = invalid{bootstrap_pending};bootstrap 相关零写',
      'read 模式:bootstrap 类 journal 一律不动 read_mode_never_touches_bootstrap_journal_planned_after_init — bootstrap_pending;commitPersonal / readPersonalFiles = invalid{bootstrap_pending};bootstrap 相关零写',
      'read 模式:bootstrap 类 journal 一律不动 read_mode_never_touches_bootstrap_journal_initialized — bootstrap_pending;commitPersonal / readPersonalFiles = invalid{bootstrap_pending};bootstrap 相关零写',
      'read 模式:bootstrap 类 journal 一律不动 read_mode_never_touches_bootstrap_journal_initialized_after_cas — bootstrap_pending;commitPersonal / readPersonalFiles = invalid{bootstrap_pending};bootstrap 相关零写',
      'read 模式:bootstrap 类 journal 一律不动 read_mode_never_touches_bootstrap_journal_committed — bootstrap_pending;commitPersonal / readPersonalFiles = invalid{bootstrap_pending};bootstrap 相关零写',
      'read 模式:bootstrap 类 journal 一律不动 read_mode_never_touches_bootstrap_journal_recorded — bootstrap_pending;commitPersonal / readPersonalFiles = invalid{bootstrap_pending};bootstrap 相关零写',
      '命令路径(personalRepoStore,repoDeps 与 assemble-write 同形:无任何开关) write_path_never_resumes_bootstrap_planned_missing — readAll / commit 遇 bootstrap journal = invalid{bootstrap_pending};零步骤点,journal 与仓库状态不变',
      '命令路径(personalRepoStore,repoDeps 与 assemble-write 同形:无任何开关) write_path_never_resumes_bootstrap_initialized — readAll / commit 遇 bootstrap journal = invalid{bootstrap_pending};零步骤点,journal 与仓库状态不变',
      '命令路径(personalRepoStore,repoDeps 与 assemble-write 同形:无任何开关) write_path_never_resumes_bootstrap_committed — readAll / commit 遇 bootstrap journal = invalid{bootstrap_pending};零步骤点,journal 与仓库状态不变',
    ],
    restored: true,
  },
  {
    id: 'read_mode_builds_repo',
    failed: 2,
    skipped: 0,
    killedBy: [
      'read 模式:bootstrap 类 journal 一律不动 read 模式:首次(无 journal、无仓库)→ absent,什么也不建',
      'complete_only:只做 committed → recorded complete_only:首次(无 journal、无仓库)→ absent,不建仓',
    ],
    restored: true,
  },
  {
    id: 'commit_personal_uses_complete_only',
    failed: 4,
    skipped: 0,
    killedBy: [
      'D1b-1 架构钉子 openPersonalRepo 的生产调用方与模式:assemble-personal = [complete_only];commit.ts = [read, read];其余文件无调用',
      'read 模式:bootstrap 类 journal 一律不动 read_mode_never_touches_bootstrap_journal_committed — bootstrap_pending;commitPersonal / readPersonalFiles = invalid{bootstrap_pending};bootstrap 相关零写',
      'read 模式:bootstrap 类 journal 一律不动 read_mode_never_touches_bootstrap_journal_recorded — bootstrap_pending;commitPersonal / readPersonalFiles = invalid{bootstrap_pending};bootstrap 相关零写',
      '命令路径(personalRepoStore,repoDeps 与 assemble-write 同形:无任何开关) write_path_never_resumes_bootstrap_committed — readAll / commit 遇 bootstrap journal = invalid{bootstrap_pending};零步骤点,journal 与仓库状态不变',
    ],
    restored: true,
  },
  {
    id: 'read_files_uses_bootstrap_mode',
    failed: 11,
    skipped: 0,
    killedBy: [
      'D1b-1 架构钉子 openPersonalRepo 的生产调用方与模式:assemble-personal = [complete_only];commit.ts = [read, read];其余文件无调用',
      'read 模式:bootstrap 类 journal 一律不动 read_mode_never_touches_bootstrap_journal_planned_missing — bootstrap_pending;commitPersonal / readPersonalFiles = invalid{bootstrap_pending};bootstrap 相关零写',
      'read 模式:bootstrap 类 journal 一律不动 read_mode_never_touches_bootstrap_journal_planned_empty — bootstrap_pending;commitPersonal / readPersonalFiles = invalid{bootstrap_pending};bootstrap 相关零写',
      'read 模式:bootstrap 类 journal 一律不动 read_mode_never_touches_bootstrap_journal_planned_after_init — bootstrap_pending;commitPersonal / readPersonalFiles = invalid{bootstrap_pending};bootstrap 相关零写',
      'read 模式:bootstrap 类 journal 一律不动 read_mode_never_touches_bootstrap_journal_initialized — bootstrap_pending;commitPersonal / readPersonalFiles = invalid{bootstrap_pending};bootstrap 相关零写',
      'read 模式:bootstrap 类 journal 一律不动 read_mode_never_touches_bootstrap_journal_initialized_after_cas — bootstrap_pending;commitPersonal / readPersonalFiles = invalid{bootstrap_pending};bootstrap 相关零写',
      'read 模式:bootstrap 类 journal 一律不动 read_mode_never_touches_bootstrap_journal_committed — bootstrap_pending;commitPersonal / readPersonalFiles = invalid{bootstrap_pending};bootstrap 相关零写',
      'read 模式:bootstrap 类 journal 一律不动 read_mode_never_touches_bootstrap_journal_recorded — bootstrap_pending;commitPersonal / readPersonalFiles = invalid{bootstrap_pending};bootstrap 相关零写',
      '命令路径(personalRepoStore,repoDeps 与 assemble-write 同形:无任何开关) write_path_never_resumes_bootstrap_planned_missing — readAll / commit 遇 bootstrap journal = invalid{bootstrap_pending};零步骤点,journal 与仓库状态不变',
      '命令路径(personalRepoStore,repoDeps 与 assemble-write 同形:无任何开关) write_path_never_resumes_bootstrap_initialized — readAll / commit 遇 bootstrap journal = invalid{bootstrap_pending};零步骤点,journal 与仓库状态不变',
      '命令路径(personalRepoStore,repoDeps 与 assemble-write 同形:无任何开关) write_path_never_resumes_bootstrap_committed — readAll / commit 遇 bootstrap journal = invalid{bootstrap_pending};零步骤点,journal 与仓库状态不变',
    ],
    restored: true,
  },
  {
    id: 'commit_wrapper_ignores_pending',
    failed: 10,
    skipped: 0,
    killedBy: [
      'read 模式:bootstrap 类 journal 一律不动 read_mode_never_touches_bootstrap_journal_planned_missing — bootstrap_pending;commitPersonal / readPersonalFiles = invalid{bootstrap_pending};bootstrap 相关零写',
      'read 模式:bootstrap 类 journal 一律不动 read_mode_never_touches_bootstrap_journal_planned_empty — bootstrap_pending;commitPersonal / readPersonalFiles = invalid{bootstrap_pending};bootstrap 相关零写',
      'read 模式:bootstrap 类 journal 一律不动 read_mode_never_touches_bootstrap_journal_planned_after_init — bootstrap_pending;commitPersonal / readPersonalFiles = invalid{bootstrap_pending};bootstrap 相关零写',
      'read 模式:bootstrap 类 journal 一律不动 read_mode_never_touches_bootstrap_journal_initialized — bootstrap_pending;commitPersonal / readPersonalFiles = invalid{bootstrap_pending};bootstrap 相关零写',
      'read 模式:bootstrap 类 journal 一律不动 read_mode_never_touches_bootstrap_journal_initialized_after_cas — bootstrap_pending;commitPersonal / readPersonalFiles = invalid{bootstrap_pending};bootstrap 相关零写',
      'read 模式:bootstrap 类 journal 一律不动 read_mode_never_touches_bootstrap_journal_committed — bootstrap_pending;commitPersonal / readPersonalFiles = invalid{bootstrap_pending};bootstrap 相关零写',
      'read 模式:bootstrap 类 journal 一律不动 read_mode_never_touches_bootstrap_journal_recorded — bootstrap_pending;commitPersonal / readPersonalFiles = invalid{bootstrap_pending};bootstrap 相关零写',
      '命令路径(personalRepoStore,repoDeps 与 assemble-write 同形:无任何开关) write_path_never_resumes_bootstrap_planned_missing — readAll / commit 遇 bootstrap journal = invalid{bootstrap_pending};零步骤点,journal 与仓库状态不变',
      '命令路径(personalRepoStore,repoDeps 与 assemble-write 同形:无任何开关) write_path_never_resumes_bootstrap_initialized — readAll / commit 遇 bootstrap journal = invalid{bootstrap_pending};零步骤点,journal 与仓库状态不变',
      '命令路径(personalRepoStore,repoDeps 与 assemble-write 同形:无任何开关) write_path_never_resumes_bootstrap_committed — readAll / commit 遇 bootstrap journal = invalid{bootstrap_pending};零步骤点,journal 与仓库状态不变',
    ],
    restored: true,
  },
  {
    id: 'read_wrapper_ignores_pending',
    failed: 10,
    skipped: 0,
    killedBy: [
      'read 模式:bootstrap 类 journal 一律不动 read_mode_never_touches_bootstrap_journal_planned_missing — bootstrap_pending;commitPersonal / readPersonalFiles = invalid{bootstrap_pending};bootstrap 相关零写',
      'read 模式:bootstrap 类 journal 一律不动 read_mode_never_touches_bootstrap_journal_planned_empty — bootstrap_pending;commitPersonal / readPersonalFiles = invalid{bootstrap_pending};bootstrap 相关零写',
      'read 模式:bootstrap 类 journal 一律不动 read_mode_never_touches_bootstrap_journal_planned_after_init — bootstrap_pending;commitPersonal / readPersonalFiles = invalid{bootstrap_pending};bootstrap 相关零写',
      'read 模式:bootstrap 类 journal 一律不动 read_mode_never_touches_bootstrap_journal_initialized — bootstrap_pending;commitPersonal / readPersonalFiles = invalid{bootstrap_pending};bootstrap 相关零写',
      'read 模式:bootstrap 类 journal 一律不动 read_mode_never_touches_bootstrap_journal_initialized_after_cas — bootstrap_pending;commitPersonal / readPersonalFiles = invalid{bootstrap_pending};bootstrap 相关零写',
      'read 模式:bootstrap 类 journal 一律不动 read_mode_never_touches_bootstrap_journal_committed — bootstrap_pending;commitPersonal / readPersonalFiles = invalid{bootstrap_pending};bootstrap 相关零写',
      'read 模式:bootstrap 类 journal 一律不动 read_mode_never_touches_bootstrap_journal_recorded — bootstrap_pending;commitPersonal / readPersonalFiles = invalid{bootstrap_pending};bootstrap 相关零写',
      '命令路径(personalRepoStore,repoDeps 与 assemble-write 同形:无任何开关) write_path_never_resumes_bootstrap_planned_missing — readAll / commit 遇 bootstrap journal = invalid{bootstrap_pending};零步骤点,journal 与仓库状态不变',
      '命令路径(personalRepoStore,repoDeps 与 assemble-write 同形:无任何开关) write_path_never_resumes_bootstrap_initialized — readAll / commit 遇 bootstrap journal = invalid{bootstrap_pending};零步骤点,journal 与仓库状态不变',
      '命令路径(personalRepoStore,repoDeps 与 assemble-write 同形:无任何开关) write_path_never_resumes_bootstrap_committed — readAll / commit 遇 bootstrap journal = invalid{bootstrap_pending};零步骤点,journal 与仓库状态不变',
    ],
    restored: true,
  },
  {
    id: 'auth_entry_check_removed',
    failed: 4,
    skipped: 0,
    killedBy: [
      'bootstrap 模式:授权边界与崩溃窗口 bootstrap_malformed_auth_refused_before_any_write — 缺 auth → bootstrap_denied{entry};未建任何目录 / journal',
      'bootstrap 模式:授权边界与崩溃窗口 bootstrap_malformed_auth_refused_before_any_write — auth 为空对象 → bootstrap_denied{entry};未建任何目录 / journal',
      'bootstrap 模式:授权边界与崩溃窗口 bootstrap_malformed_auth_refused_before_any_write — auth 为 null → bootstrap_denied{entry};未建任何目录 / journal',
      'bootstrap 模式:授权边界与崩溃窗口 bootstrap_malformed_auth_refused_before_any_write — authorize 非函数 → bootstrap_denied{entry};未建任何目录 / journal',
    ],
    restored: true,
  },
  {
    id: 'authorize_init_skipped',
    failed: 6,
    skipped: 0,
    killedBy: [
      'read 模式:bootstrap 类 journal 一律不动 control_bootstrap_mode_recovers_what_read_mode_leaves — 同一个 planned + 目录缺失,bootstrap 模式续做到 ready(模式确有作用)',
      'bootstrap 模式:授权边界与崩溃窗口 bootstrap_init_denied_nothing_written — authorize(init) 抛 → bootstrap_denied{init};journal 停在 planned,无目录 / 无 .git',
      'bootstrap 模式:授权边界与崩溃窗口 bootstrap_cas_denied_before_mktree — authorize(cas) 抛 → bootstrap_denied{cas};无 mktree / commit-tree / update-ref;journal 停在 initialized',
      'bootstrap 模式:授权边界与崩溃窗口 bootstrap_authorize_called_once_per_boundary — 全新建仓:init 一次、cas 一次,顺序 init < cas',
      'bootstrap 模式:授权边界与崩溃窗口 bootstrap_authorize_lock_lost_propagates — authorize 抛锁丢失 → 原样上抛(不映射 denied),journal 停在 planned',
      'bootstrap 模式:授权边界与崩溃窗口 bootstrap_planned_missing_dir_discards_then_rebuilds — 对照原 C2 control:planned + 目录缺失在 bootstrap 模式丢弃 journal 后按首次重建',
    ],
    restored: true,
  },
  {
    id: 'authorize_init_after_mkdir',
    failed: 1,
    skipped: 0,
    killedBy: [
      'bootstrap 模式:授权边界与崩溃窗口 bootstrap_init_denied_nothing_written — authorize(init) 抛 → bootstrap_denied{init};journal 停在 planned,无目录 / 无 .git',
    ],
    restored: true,
  },
  {
    id: 'authorize_cas_skipped',
    failed: 5,
    skipped: 0,
    killedBy: [
      'read 模式:bootstrap 类 journal 一律不动 control_bootstrap_mode_recovers_what_read_mode_leaves — 同一个 planned + 目录缺失,bootstrap 模式续做到 ready(模式确有作用)',
      'bootstrap 模式:授权边界与崩溃窗口 bootstrap_cas_denied_before_mktree — authorize(cas) 抛 → bootstrap_denied{cas};无 mktree / commit-tree / update-ref;journal 停在 initialized',
      'bootstrap 模式:授权边界与崩溃窗口 bootstrap_authorize_called_once_per_boundary — 全新建仓:init 一次、cas 一次,顺序 init < cas',
      'bootstrap 模式:授权边界与崩溃窗口 bootstrap_crash_after_init_before_initialized_resumes_without_second_init — git init 已成功、journal 仍 planned:不再 authorize(init)、不再 init,只剩 cas',
      'bootstrap 模式:授权边界与崩溃窗口 bootstrap_planned_missing_dir_discards_then_rebuilds — 对照原 C2 control:planned + 目录缺失在 bootstrap 模式丢弃 journal 后按首次重建',
    ],
    restored: true,
  },
  {
    id: 'authorize_cas_after_mktree',
    failed: 1,
    skipped: 0,
    killedBy: [
      'bootstrap 模式:授权边界与崩溃窗口 bootstrap_cas_denied_before_mktree — authorize(cas) 抛 → bootstrap_denied{cas};无 mktree / commit-tree / update-ref;journal 停在 initialized',
    ],
    restored: true,
  },
  {
    id: 'authorize_cas_reuses_init_call',
    failed: 5,
    skipped: 0,
    killedBy: [
      'read 模式:bootstrap 类 journal 一律不动 control_bootstrap_mode_recovers_what_read_mode_leaves — 同一个 planned + 目录缺失,bootstrap 模式续做到 ready(模式确有作用)',
      'bootstrap 模式:授权边界与崩溃窗口 bootstrap_cas_denied_before_mktree — authorize(cas) 抛 → bootstrap_denied{cas};无 mktree / commit-tree / update-ref;journal 停在 initialized',
      'bootstrap 模式:授权边界与崩溃窗口 bootstrap_authorize_called_once_per_boundary — 全新建仓:init 一次、cas 一次,顺序 init < cas',
      'bootstrap 模式:授权边界与崩溃窗口 bootstrap_crash_after_init_before_initialized_resumes_without_second_init — git init 已成功、journal 仍 planned:不再 authorize(init)、不再 init,只剩 cas',
      'bootstrap 模式:授权边界与崩溃窗口 bootstrap_planned_missing_dir_discards_then_rebuilds — 对照原 C2 control:planned + 目录缺失在 bootstrap 模式丢弃 journal 后按首次重建',
    ],
    restored: true,
  },
  {
    id: 'authorize_lock_error_mapped_to_denied',
    failed: 1,
    skipped: 0,
    killedBy: [
      'bootstrap 模式:授权边界与崩溃窗口 bootstrap_authorize_lock_lost_propagates — authorize 抛锁丢失 → 原样上抛(不映射 denied),journal 停在 planned',
    ],
    restored: true,
  },
  {
    id: 'personal_lock_lost_not_detected',
    failed: 1,
    skipped: 0,
    killedBy: [
      'bootstrap 模式:授权边界与崩溃窗口 bootstrap_authorize_lock_lost_propagates — authorize 抛锁丢失 → 原样上抛(不映射 denied),journal 停在 planned',
    ],
    restored: true,
  },
  {
    id: 'denied_mapping_removed',
    failed: 2,
    skipped: 0,
    killedBy: [
      'bootstrap 模式:授权边界与崩溃窗口 bootstrap_init_denied_nothing_written — authorize(init) 抛 → bootstrap_denied{init};journal 停在 planned,无目录 / 无 .git',
      'bootstrap 模式:授权边界与崩溃窗口 bootstrap_cas_denied_before_mktree — authorize(cas) 抛 → bootstrap_denied{cas};无 mktree / commit-tree / update-ref;journal 停在 initialized',
    ],
    restored: true,
  },
  {
    id: 'denied_step_mislabeled',
    failed: 1,
    skipped: 0,
    killedBy: [
      'bootstrap 模式:授权边界与崩溃窗口 bootstrap_cas_denied_before_mktree — authorize(cas) 抛 → bootstrap_denied{cas};无 mktree / commit-tree / update-ref;journal 停在 initialized',
    ],
    restored: true,
  },
  {
    id: 'outcome_denied_not_pending',
    failed: 1,
    skipped: 0,
    killedBy: [
      'D1b-1 端口纵深防御与映射 outcome_of_open_maps_every_kind — bootstrap_pending / bootstrap_denied 都映射为 bootstrap_pending(不熔断);其余一一对应',
    ],
    restored: true,
  },
  {
    id: 'committed_commit_tree_unchecked',
    failed: 2,
    skipped: 0,
    killedBy: [
      'complete_only:只做 committed → recorded complete_only_committed_nonempty_tree_commit_invalid_journal_kept — journal 与 ref 同指一个带文件的提交(索引 / 工作树与之一致)→ invalid{bootstrap_inconsistent}',
      'complete_only:只做 committed → recorded complete_only_recorded_nonempty_tree_commit_invalid_journal_kept — journal 与 ref 同指一个带文件的提交(索引 / 工作树与之一致)→ invalid{bootstrap_inconsistent}',
    ],
    restored: true,
  },
];
