/**
 * §21 V1 W1(纯转移引擎)必杀变异:每条新不变量一个变异锚点;W0-13 矩阵里归属 W1 的行(M13-1 的推进前置部分、M13-2、M13-4 的名额判定、
 * M13-5 / M13-6 / M13-7 的纯函数层)以 `M13-<n>` 开头登记 `clause`(W10b 的完整性测试按 ID 对账)。
 * 执行方式同 W0:验证机私有检出里 cp 备份 → 按锚点替换(每个锚点在对应文件里**恰好出现一次**)→ 跑 `tests` →
 * 失败集合非空、全部命中 `expectRed`、`mustKill` 每项至少命中一个、没有 skipped → cp 还原并逐文件 sha256 核对。**不用 git checkout / stash 还原**。
 * 本文件只写表与每条变异期望红的测试名(`expectRed` 是杀手测试源码里的字面子串;失败测试的完整名 = describe + it);
 * 变异由主代理在验证机上执行,结果记进 `V1_W1_RESULTS`(W1 实装块不执行变异,故留空)。
 */
export interface Edit {
  file: string;
  anchor: string;
  replacement: string;
}

export interface V1W1Mutation {
  id: string;
  /** 契约里的变异点原文 */
  clause: string;
  edits: readonly Edit[];
  /** 相对 `test/` */
  tests: readonly string[];
  expectRed: readonly string[];
  mustKill: readonly string[];
}

export interface V1W1Result {
  id: string;
  failed: number;
  skipped: number;
  killedBy: readonly string[];
  restored: boolean;
}

const TABLE = 'src/rsi/personal/transition-table.ts';
const ENGINE = 'src/rsi/personal/transition.ts';
const IDS = 'src/rsi/personal/ids.ts';
const ROWS = 'rsi/personal/transition-rows.test.ts';
const ENG = 'rsi/personal/transition-engine.test.ts';
const QUEUE = 'rsi/personal/transition-queue.test.ts';
const IDT = 'rsi/personal/transition-ids.test.ts';
const lines = (...xs: string[]): string => xs.join('\n');

/** M13-1 / M13-2 / M13-4 的「逐个删去该项检查」:锚点是 `promoteEligibilityBlocker` / `authorityBlocker` / `slotBlocker` 里独立的一行 */
function dropCheck(
  id: string,
  clause: string,
  anchor: string,
  tests: readonly string[],
  expectRed: readonly string[],
  mustKill: readonly string[],
): V1W1Mutation {
  return {
    id,
    clause,
    edits: [{ file: TABLE, anchor, replacement: '' }],
    tests,
    expectRed,
    mustKill,
  };
}

export const V1_W1_MUTATIONS: readonly V1W1Mutation[] = [
  // ---------------------------------------------------------------- R21-4.5 守卫 / 幂等
  {
    id: 'guard-inverted',
    clause: 'R21-4.5:守卫取反(proposed → shadow 的「G0–G7 全过」)→ 守卫为假不转移 / 正向链红',
    edits: [
      {
        file: TABLE,
        anchor: "if (!e.gates_green) return 'gates_not_green';",
        replacement: "if (e.gates_green) return 'gates_not_green';",
      },
    ],
    tests: [ROWS, ENG],
    expectRed: ['proposed_to_shadow', '正向合法链', '幂等先于查行', 'transitions 满 256 条'],
    mustKill: ['proposed_to_shadow', '正向合法链'],
  },
  {
    id: 'idem-check-removed',
    clause: 'R21-4.5:幂等检查去掉 → 同一 idem_key 执行两次只转移一次红(第二次不再是 noop)',
    edits: [{ file: ENGINE, anchor: 'if (seen.has(key)) {', replacement: 'if (false) {' }],
    tests: [ROWS, ENG],
    expectRed: ['同一 idem_key 执行两次只转移一次', '同一个 veto 事件重复到达', '幂等先于查行'],
    mustKill: ['同一 idem_key 执行两次只转移一次', '幂等先于查行'],
  },
  {
    id: 'unimplemented-state-allowed',
    clause:
      'R21-4.1:blocked / adopted / stable / retiring 本期无行 → 默认 phase_not_available;去掉该闸 → 红',
    edits: [
      {
        file: ENGINE,
        anchor: 'if (isUnimplementedLifecycle(record.lifecycle)) {',
        replacement: 'if (false) {',
      },
    ],
    tests: [ENG, 'rsi/personal/transition-matrix.test.ts'],
    expectRed: [
      '(V2 / V3 状态)收到',
      'R21-4.5 judge_reject:每个有行的非终态各一个',
      '未实现状态先于终态',
      'V2 的 stable 组合合法',
    ],
    mustKill: ['(V2 / V3 状态)收到'],
  },
  // ---------------------------------------------------------------- R21-4.4 / 4.4a
  {
    id: 'target-terminal-downgrade',
    clause: 'R21-4.4a:target_terminal 降级(只升不降被改成后来者直接覆盖)→ 红',
    edits: [
      {
        file: ENGINE,
        anchor: lines(
          '      if (targetPriority(newTarget) < targetPriority(rb.target_terminal))',
          '        rb.target_terminal = newTarget;',
        ),
        replacement: '      rb.target_terminal = newTarget;',
      },
    ],
    tests: [ENG],
    expectRed: ['target_terminal 只升不降'],
    mustKill: ['target_terminal 只升不降'],
  },
  {
    id: 'veto-on-terminal-advances-state',
    clause: 'R21-4.4a ②:已在终态的 veto 在终态推进状态(应只写黑名单)→ 红',
    edits: [
      {
        file: ENGINE,
        anchor:
          "return { outcome: 'noop', noop_reason: 'terminal_state', next: record, entries: [], effects };",
        replacement:
          "return { outcome: 'transitioned', next: { ...record, lifecycle: 'expired' }, entries: [], effects };",
      },
    ],
    tests: [ENG],
    expectRed: ['终态收到', '终态 veto 的三件事', 'proposed 上 judge_reject 与 veto'],
    mustKill: ['终态 veto 的三件事'],
  },
  {
    id: 'judge-rejected-above-vetoed',
    clause: 'R21-4.4a / N4-2:judge_rejected 优先级高于 vetoed → 红',
    edits: [
      {
        file: TABLE,
        anchor:
          'return t === undefined ? RSI_TERMINAL_REASONS.length : RSI_TERMINAL_REASONS.indexOf(t);',
        replacement:
          "return t === undefined ? RSI_TERMINAL_REASONS.length : t === 'judge_rejected' ? -1 : RSI_TERMINAL_REASONS.indexOf(t);",
      },
    ],
    tests: [ENG],
    expectRed: ['veto 与 judge_reject 两种到达顺序', '完整优先级链'],
    mustKill: ['veto 与 judge_reject 两种到达顺序'],
  },
  {
    id: 'repeat-resets-rollback-phase',
    clause: 'R21-4.4a ①:重复终止事件重置已完成的补偿阶段 → 红',
    edits: [
      {
        file: ENGINE,
        anchor: "add('lifecycle', 'rolling_back', 'rolling_back', reason);",
        replacement: lines(
          "rb.phase = 'rollback_requested';",
          "      add('lifecycle', 'rolling_back', 'rolling_back', reason);",
        ),
      },
    ],
    tests: [ROWS, ENG],
    expectRed: ['时再收到 veto', '追加自环条目', 'rolling_back_repeat_'],
    mustKill: ['时再收到 veto'],
  },
  {
    id: 'rollback-skip-allowed',
    clause: 'R21-9.1:rollback 阶段只能顺序前进一步;去掉 `to` 过滤 → 跳段 / 逆序被受理 → 红',
    edits: [
      { file: TABLE, anchor: 'applies: (e) => e.to === to,', replacement: 'applies: () => true,' },
    ],
    tests: [ENG],
    expectRed: ['rollback 阶段只能顺序前进一步'],
    mustKill: ['rollback 阶段只能顺序前进一步'],
  },
  // ---------------------------------------------------------------- 能力相位(W0-1)
  {
    id: 'capability-default-allow',
    clause: 'W0-1:能力判定改为默认放行(转移函数自己的调用行)→ 未到期的转移被放行 → 红',
    edits: [
      {
        file: ENGINE,
        anchor:
          "if (!capabilityAvailable(key, ctx.phase)) return refuse('phase_not_available', undefined, key);",
        replacement: "if (false) return refuse('phase_not_available', undefined, key);",
      },
    ],
    tests: [ROWS, ENG],
    expectRed: [
      '守卫为假不转移',
      '能力相位逐行对照',
      '能力先于守卫',
      'category=exec 在本期没有能力键',
      'canary → adopted 在相位 2 仍拒',
    ],
    mustKill: ['能力相位逐行对照', 'canary → adopted 在相位 2 仍拒'],
  },
  {
    id: 'terminal-capability-ignored',
    clause: 'W0-1:终态收到终止事件也走能力判定;去掉 → 相位 0 仍受理 → 红',
    edits: [
      {
        file: ENGINE,
        anchor: "if (!capabilityAvailable('transition_to_rejected', ctx.phase)) {",
        replacement: 'if (false) {',
      },
    ],
    tests: [ENG],
    expectRed: ['终态收到终止事件也受能力相位约束'],
    mustKill: ['终态收到终止事件也受能力相位约束'],
  },
  {
    id: 'exec-capability-key-removed',
    clause: 'W0-1:category=exec 本期没有能力键(默认拒绝);去掉 exec_admission → 红',
    edits: [
      {
        file: TABLE,
        anchor: "'transition_shadow_to_canary', 'exec_admission'",
        replacement: "'transition_shadow_to_canary'",
      },
    ],
    tests: [ROWS, ENG],
    expectRed: ['category=exec 在本期没有能力键', '能力键:除两个有意不登记的键'],
    mustKill: ['category=exec 在本期没有能力键'],
  },
  {
    id: 'g8-capability-key-removed',
    clause: 'R21-5.1:G8 属 V3(能力表里没有 → 默认拒绝);去掉 gate_g8 → 红',
    edits: [
      {
        file: TABLE,
        anchor: "[...CAPS_REJECT, 'gate_g8']",
        replacement: 'CAPS_REJECT',
      },
    ],
    tests: [ROWS],
    expectRed: ['proposed_to_rejected_gate', '能力键:除两个有意不登记的键'],
    mustKill: ['proposed_to_rejected_gate'],
  },
  {
    id: 'g7-queued-rejects',
    clause: 'R21-5.1 G7:g7_queued 是排队不是拒绝;改成拒绝 → 红',
    edits: [
      {
        file: TABLE,
        anchor: "e.gate_reason === 'g7_queued' ? 'g7_queued_is_not_rejection' : null",
        replacement: 'null',
      },
    ],
    tests: [ROWS],
    expectRed: ['proposed_to_rejected_gate'],
    mustKill: ['proposed_to_rejected_gate'],
  },
  {
    id: 'codex-injected-allowed',
    clause: 'R21-4.2:codex 恒不进入注入;去掉守卫 → 红',
    edits: [
      {
        file: TABLE,
        anchor: "if (e.agent === 'codex') return 'codex_not_participating';",
        replacement: '',
      },
    ],
    tests: [ROWS],
    expectRed: ['deploy_none_to_injected'],
    mustKill: ['deploy_none_to_injected'],
  },
  {
    id: 'queue-expiry-guard-removed',
    clause: 'W0-13:shadow_queue_expired 守卫(满 30 个 UTC 日)去掉 → 红',
    edits: [
      {
        file: TABLE,
        anchor: "queueExpired(e.queued_since, utcDay(ctx.now)) ? null : 'queue_not_expired',",
        replacement: 'null,',
      },
    ],
    tests: [ROWS, QUEUE],
    expectRed: ['shadow_to_expired_queue', 'M13-6 引擎守卫'],
    mustKill: ['shadow_to_expired_queue', 'M13-6 引擎守卫'],
  },
  dropCheck(
    'R21-2.2-auto-paused',
    'R21-2.2:auto_paused 时「增加影响」的转移被禁止 —— 删去暂停检查',
    "if (ctx.auto_paused) return 'auto_paused';",
    [QUEUE, ROWS, ENG],
    [
      '暂停中(auto_paused)',
      'shadow_to_canary',
      'deploy_none_to_injected',
      'R21-2.2 暂停 / 自动循环无效下',
    ],
    ['R21-2.2 暂停 / 自动循环无效下'],
  ),
  dropCheck(
    'R21-2.2-auto-loop-not-effective',
    'R21-2.2:自动循环有效条件不成立时「增加影响」的转移被禁止 —— 删去该检查',
    "if (!ctx.auto_loop_effective) return 'auto_loop_not_effective';",
    [QUEUE, ROWS, ENG],
    [
      '自动循环有效条件不成立',
      'shadow_to_canary',
      'deploy_none_to_injected',
      'R21-2.2 暂停 / 自动循环无效下',
    ],
    ['R21-2.2 暂停 / 自动循环无效下'],
  ),
  {
    id: 'exec-deploy-capability-key-removed',
    clause: 'R21-4.2 / W0-1:category=exec 经 deploy_inject 也走默认拒绝;去掉 exec_admission → 红',
    edits: [
      {
        file: TABLE,
        anchor: "'deploy_none_to_injected', 'exec_admission'",
        replacement: "'deploy_none_to_injected'",
      },
    ],
    tests: [ROWS, ENG],
    expectRed: ['deploy_none_to_injected', 'R21-4.2 category=exec 的 canary 经 deploy_inject'],
    mustKill: ['R21-4.2 category=exec 的 canary 经 deploy_inject'],
  },
  {
    id: 'terminal-veto-extra-effects',
    clause: 'R21-4.4a ②:终态 veto 只写黑名单(effects 恰为 [黑名单]);多出别的 effect → 红',
    edits: [
      {
        file: ENGINE,
        anchor:
          "? [{ type: 'blacklist_veto', id: record.id, content_sha256: record.content_sha256 }]",
        replacement:
          "? [{ type: 'blacklist_veto', id: record.id, content_sha256: record.content_sha256 }, { type: 'commit_lifecycle', id: record.id }]",
      },
    ],
    tests: [ENG],
    expectRed: ['终态收到', '终态 veto 的三件事'],
    mustKill: ['终态 veto 的三件事'],
  },
  {
    id: 'M13-6-promote-guard-expiry-removed',
    clause: 'M13-6:到期先于推进是转移入口的不变量 —— 去掉 shadow_to_canary 守卫里的排队到期检查',
    edits: [{ file: TABLE, anchor: 'queueExpiryBlocker(e.queued_since, ctx) ??', replacement: '' }],
    tests: [QUEUE, ROWS],
    expectRed: ['M13-6 直接投 shadow_promote', 'shadow_to_canary'],
    mustKill: ['M13-6 直接投 shadow_promote'],
  },
  {
    id: 'window-replay-reason-downgrade',
    clause: 'R21-4.4a:窗口外重放不得降级终态理由(优先级只升不降)—— 去掉理由优先级比较',
    edits: [
      {
        file: ENGINE,
        anchor: 'if (terminalPriority(reason) < terminalPriority(rb.reason)) rb.reason = reason;',
        replacement: 'rb.reason = reason;',
      },
    ],
    tests: [ENG],
    expectRed: [
      '幂等窗口外的重放',
      '完整优先级链',
      'veto 与 judge_reject 两种到达顺序',
      'judge_reject 与 harm 的两种顺序',
      '并列保留先到者',
    ],
    mustKill: ['幂等窗口外的重放'],
  },
  {
    id: 'table-rows-unfrozen',
    clause: 'W1:转移表行对象冻结 —— 去掉 Object.freeze',
    edits: [{ file: TABLE, anchor: 'return Object.freeze(out);', replacement: 'return out;' }],
    tests: [ENG],
    expectRed: ['转移表不可变'],
    mustKill: ['转移表不可变'],
  },
  // ---------------------------------------------------------------- M13-1 前置逐项(「逐个删去该项检查」)
  dropCheck(
    'M13-1-phase',
    'M13-1:推进前置「相位」不成立不推进 —— 删去相位检查',
    "if (!capabilityAvailable('transition_shadow_to_canary', ctx.phase)) return 'phase_not_available';",
    [QUEUE],
    ['相位 1(V1b', 'M13-5 相位未到等待', 'M13-7 canary_ready_since 首次达标日'],
    ['相位 1(V1b'],
  ),
  dropCheck(
    'M13-1-config',
    'M13-1:推进前置「配置无效」—— 删去该项检查',
    "if (!f.config_valid) return 'config_invalid';",
    [QUEUE, ROWS],
    ['配置无效', 'shadow_to_canary'],
    ['配置无效'],
  ),
  dropCheck(
    'M13-1-enabled',
    'M13-1:推进前置「enabled 假」—— 删去该项检查',
    "if (!f.enabled) return 'auto_disabled';",
    [QUEUE],
    ['enabled 为假', 'M13-5 排队只数 G7'],
    ['enabled 为假'],
  ),
  dropCheck(
    'M13-1-authorized',
    'M13-1:推进前置「授权缺」—— 删去该项检查',
    "if (!f.authorized) return 'not_authorized';",
    [QUEUE],
    ['授权缺'],
    ['授权缺'],
  ),
  dropCheck(
    'M13-1-tainted',
    'M13-1:推进前置「taint」—— 删去该项检查',
    "if (f.tainted) return 'tainted';",
    [QUEUE],
    ['taint 命中', 'M13-5 其他条件不满足的等待'],
    ['taint 命中'],
  ),
  dropCheck(
    'M13-1-cooldown',
    'M13-1:推进前置「冷却」—— 删去该项检查',
    "if (f.cooldown_active) return 'cooldown_active';",
    [QUEUE],
    ['冷却中'],
    ['冷却中'],
  ),
  dropCheck(
    'M13-1-tombstone',
    'M13-1:推进前置「墓碑」—— 删去该项检查',
    "if (f.tombstoned) return 'tombstoned';",
    [QUEUE],
    ['墓碑命中'],
    ['墓碑命中'],
  ),
  dropCheck(
    'M13-1-blacklist',
    'M13-1:推进前置「黑名单」—— 删去该项检查',
    "if (f.blacklisted) return 'veto_blacklisted';",
    [QUEUE],
    ['黑名单命中'],
    ['黑名单命中'],
  ),
  dropCheck(
    'M13-1-content-changed',
    'M13-1:推进前置「内容变」—— 删去该项检查',
    "if (f.current_content_sha256 !== record.content_sha256) return 'content_changed';",
    [QUEUE],
    ['内容变(content_sha256)'],
    ['内容变(content_sha256)'],
  ),
  {
    id: 'M13-1-signature-changed',
    clause: 'M13-1:推进前置「签名变」—— 删去该项检查',
    edits: [
      {
        file: TABLE,
        anchor: lines(
          '  if (',
          '    f.current_cluster_signature === null ||',
          '    canonicalJson(f.current_cluster_signature) !== canonicalJson(record.cluster_signature)',
          '  ) {',
          "    return 'signature_changed';",
          '  }',
        ),
        replacement: '',
      },
    ],
    tests: [QUEUE],
    expectRed: ['签名变', '签名不可得'],
    mustKill: ['签名变'],
  },
  dropCheck(
    'M13-1-evidence-invalid',
    'M13-1:推进前置「证据失效」—— 删去该项检查',
    "if (!f.evidence_valid) return 'evidence_invalid';",
    [QUEUE],
    ['证据失效'],
    ['证据失效'],
  ),
  dropCheck(
    'M13-1-sessions',
    'M13-1:推进前置「≥ 20 有观测会话」—— 删去该项检查',
    "if (f.sessions < RSI_SHADOW_MIN_SESSIONS) return 'shadow_sessions_short';",
    [QUEUE],
    ['会话不足 20'],
    ['会话不足 20'],
  ),
  dropCheck(
    'M13-1-hits',
    'M13-1:推进前置「签名命中 ≥ 2」—— 删去该项检查',
    "if (f.hits < RSI_SHADOW_MIN_HITS) return 'shadow_hits_short';",
    [QUEUE],
    ['命中不足 2'],
    ['命中不足 2'],
  ),
  dropCheck(
    'M13-1-revocation',
    'M13-1:推进前置「撤销凭据列出」(R21-9.5 对账先于授予)—— 删去该项检查',
    "if (ctx.revocation_listed) return 'revoked';",
    [QUEUE, ROWS],
    ['撤销凭据列出', 'proposed_to_shadow', 'deploy_none_to_injected'],
    ['撤销凭据列出'],
  ),
  dropCheck(
    'M13-1-no-signature',
    'M13-1 / W0-2:旧版记录无 cluster_signature 永不推进 —— 删去该项检查',
    "if (record.cluster_signature === undefined) return 'no_cluster_signature';",
    [QUEUE],
    ['旧版记录无 cluster_signature'],
    ['旧版记录无 cluster_signature'],
  ),
  dropCheck(
    'M13-1-exec-category',
    'M13-1:category=exec 不经 shadow → canary(E1 准入属 V6a)—— 删去该项检查',
    "if (record.category === 'exec') return 'category_exec_unsupported';",
    [QUEUE],
    ['category=exec(E1 准入'],
    ['category=exec(E1 准入'],
  ),
  dropCheck(
    'M13-1-g8-fail-closed',
    'M13-1 / R21-4.1:相位 ≥ V3 而 G8 未实现 → 拒绝(fail-closed)—— 删去该项检查',
    "if (phaseAtLeast('V3', ctx.phase)) return 'g8_not_implemented';",
    [QUEUE],
    ['相位 ≥ V3 而 G8 未实现'],
    ['相位 ≥ V3 而 G8 未实现'],
  ),
  dropCheck(
    'M13-2-authority-mismatch',
    'M13-2:权威终态不被旧工作副本推进 —— 删去「权威副本与手里副本状态一致」重读检查',
    "if (ctx.authoritative_lifecycle !== record.lifecycle) return 'authority_mismatch';",
    [QUEUE, ROWS],
    ['M13-2 权威终态不被旧工作副本推进', 'proposed_to_shadow'],
    ['M13-2 权威终态不被旧工作副本推进'],
  ),
  // ---------------------------------------------------------------- M13-4 / 5 / 6 / 7(纯函数层)
  dropCheck(
    'M13-4-slot-check-removed',
    'M13-4:全局名额互斥 —— 名额检查去掉',
    "return f.slot_occupied ? 'slot_occupied' : null;",
    [QUEUE, ROWS],
    ['M13-4 名额被占', 'M13-4 两个候选同时具备资格', 'shadow_to_canary'],
    ['M13-4 名额被占', 'M13-4 两个候选同时具备资格'],
  ),
  {
    id: 'M13-5-queue-start-from-ready',
    clause: 'M13-5:排队只数 G7 等待 —— queued_since 起算改用 canary_ready_since',
    edits: [
      {
        file: ENGINE,
        anchor: 'queued_since: shadow.queued_since ?? today',
        replacement: 'queued_since: ready ?? today',
      },
    ],
    tests: [QUEUE],
    expectRed: ['M13-4 名额被占', 'M13-5 相位未到等待', 'M13-7 canary_ready_since 很早'],
    mustKill: ['M13-5 相位未到等待'],
  },
  {
    id: 'M13-5-queue-not-cleared',
    clause: 'M13-5:资格任一条件不成立 → queued_since 清零 —— 去掉清零',
    edits: [
      {
        file: ENGINE,
        anchor: 'patch: { canary_ready_since: ready, queued_since: null }, blocker };',
        replacement:
          'patch: { canary_ready_since: ready, queued_since: shadow.queued_since }, blocker };',
      },
    ],
    tests: [QUEUE],
    expectRed: ['decideShadowStep 不推进、queued_since 清零', 'M13-5 其他条件不满足的等待'],
    mustKill: ['M13-5 其他条件不满足的等待'],
  },
  {
    id: 'M13-6-expiry-after-slot',
    clause: 'M13-6:到期先于推进 —— 判定顺序对调(先看名额再看到期)',
    edits: [
      {
        file: ENGINE,
        anchor: 'if (queueExpired(shadow.queued_since, today)) {',
        replacement: 'if (queueExpired(shadow.queued_since, today) && facts.slot_occupied) {',
      },
    ],
    tests: [QUEUE],
    expectRed: ['M13-6 排队第 30 日名额恰好释放', 'M13-6 已满 30 日而资格同时失效'],
    mustKill: ['M13-6 排队第 30 日名额恰好释放'],
  },
  {
    id: 'M13-6-expiry-after-eligibility',
    clause: 'M13-6:到期先于推进 —— 判定顺序对调(先看资格再看到期)',
    edits: [
      {
        file: ENGINE,
        anchor: 'if (queueExpired(shadow.queued_since, today)) {',
        replacement:
          'if (queueExpired(shadow.queued_since, today) && promoteEligibilityBlocker(record, facts, ctx) === null) {',
      },
    ],
    tests: [QUEUE],
    expectRed: ['M13-6 已满 30 日而资格同时失效'],
    mustKill: ['M13-6 已满 30 日而资格同时失效'],
  },
  {
    id: 'M13-7-expiry-reads-canary-ready-since',
    clause: 'M13-7:canary_ready_since 只排序 —— 到期判断读 canary_ready_since',
    edits: [
      {
        file: ENGINE,
        anchor: 'if (queueExpired(shadow.queued_since, today)) {',
        replacement: 'if (queueExpired(ready, today)) {',
      },
    ],
    tests: [QUEUE],
    expectRed: [
      'M13-5 相位未到等待',
      'M13-5 其他条件不满足的等待',
      'M13-6 排队第 30 日名额恰好释放',
      'M13-6 已满 30 日而资格同时失效',
      'M13-6 已满 30 日而名额仍被占',
      'M13-7 重建后日期变化',
      'M13-7 canary_ready_since 很早',
    ],
    mustKill: ['M13-7 重建后日期变化', 'M13-7 canary_ready_since 很早'],
  },
  // ---------------------------------------------------------------- ids
  {
    id: 'ids-idem-agent-null-as-empty',
    clause: 'R21-4:idem_key 编码(agent 缺省为 null)被改 → 金向量红',
    edits: [{ file: IDS, anchor: 'p.agent ?? null', replacement: "p.agent ?? ''" }],
    tests: [IDT],
    expectRed: ['金向量'],
    mustKill: ['金向量'],
  },
  {
    id: 'ids-candidate-id-version-bumped',
    clause: 'W0-6:候选 id 派生串(v1 前缀)被改 → 金向量红',
    edits: [{ file: IDS, anchor: 'v1|${runId}', replacement: 'v2|${runId}' }],
    tests: [IDT],
    expectRed: ['金向量'],
    mustKill: ['金向量'],
  },
  {
    id: 'ids-txn-ids-unsorted',
    clause: '规划稿 §2.4:txn_id 的候选 id 先排序 —— 去掉排序 → 红',
    edits: [
      {
        file: IDS,
        anchor: 'const ids = [...candidateIds].sort();',
        replacement: 'const ids = [...candidateIds];',
      },
    ],
    tests: [IDT],
    expectRed: ['候选 id 先排序'],
    mustKill: ['候选 id 先排序'],
  },
];

/** 变异实测结果(主代理在验证机上执行后填写;W1 实装块不执行变异) */
export const V1_W1_RESULTS: readonly V1W1Result[] = [];
