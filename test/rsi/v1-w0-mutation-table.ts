/**
 * §21 V1 W0 必杀变异(契约 §21.24 W0-1 … W0-12;每条新不变量一个变异锚点):每条变异后必须有测试红,且只红该条款自己的杀手用例。
 * 执行方式同 A3 / A4 / A5 / A6:验证机私有检出里 cp 备份 → 按锚点替换(每个锚点在对应文件里**恰好出现一次**)→ 跑 `tests` →
 * 失败集合非空、全部命中 `expectRed`、`mustKill` 每项至少命中一个、没有 skipped → cp 还原并逐文件 sha256 核对。**不用 git checkout / stash 还原**。
 * 本文件只写表与每条变异期望红的测试名(`expectRed` 是杀手测试源码里的字面子串);变异由主代理在验证机上执行,结果记进 `V1_W0_RESULTS`(W0 实装块不执行变异,故留空)。
 * 后续块(W1 起)的变异另起 `v1-<块>-mutation-table.ts`,不改本表。
 */
export interface Edit {
  file: string;
  anchor: string;
  replacement: string;
}

export interface V1W0Mutation {
  id: string;
  /** 契约里的变异点原文 */
  clause: string;
  edits: readonly Edit[];
  /** 相对 `test/` */
  tests: readonly string[];
  expectRed: readonly string[];
  mustKill: readonly string[];
}

export interface V1W0Result {
  id: string;
  failed: number;
  skipped: number;
  killedBy: readonly string[];
  restored: boolean;
}

const W0 = 'contracts/r21-w0.test.ts';
const AUTO = 'rsi/auto-config.test.ts';
const STATE = 'rsi/state.test.ts';
const LINT = 'lint/violations.test.ts';
const RSI = 'src/contracts/rsi.ts';
const PERSONAL = 'src/contracts/rsi-personal.ts';

export const V1_W0_MUTATIONS: readonly V1W0Mutation[] = [
  {
    id: 'phase-promoted-early',
    clause: 'R21-0.1:把 RSI_AUTO_PHASE 提前而未实现对应条款 → 验收红',
    edits: [
      {
        file: RSI,
        anchor: 'export const RSI_AUTO_PHASE = 0;',
        replacement: 'export const RSI_AUTO_PHASE = 1;',
      },
    ],
    tests: [W0, AUTO],
    expectRed: ['W0 落地时 RSI_AUTO_PHASE = 0', 'W0 相位为 0', '能力默认拒绝', 'phaseAtLeast'],
    mustKill: ['W0 落地时 RSI_AUTO_PHASE = 0'],
  },
  {
    id: 'decide-better-default-true',
    clause: 'R21-7.9:RSI_DECIDE_BETTER_ENABLED 缺省为真 → 契约测试红',
    edits: [
      {
        file: RSI,
        anchor: 'export const RSI_DECIDE_BETTER_ENABLED = false;',
        replacement: 'export const RSI_DECIDE_BETTER_ENABLED = true;',
      },
    ],
    tests: [W0],
    expectRed: ['W0 落地时 RSI_AUTO_PHASE = 0'],
    mustKill: ['W0 落地时 RSI_AUTO_PHASE = 0'],
  },
  {
    id: 'capability-default-allow',
    clause: 'W0-1:能力表默认拒绝(不在表里 = 不可用)改为默认放行',
    edits: [
      {
        file: RSI,
        anchor: 'if (!Object.hasOwn(RSI_CAPABILITY_PHASE, key)) return false;',
        replacement: 'if (!Object.hasOwn(RSI_CAPABILITY_PHASE, key)) return true;',
      },
    ],
    tests: [W0],
    expectRed: ['能力默认拒绝'],
    mustKill: ['能力默认拒绝'],
  },
  {
    id: 'capability-proto-bypass',
    clause:
      'W0-1:能力查询只认自有键(原型链上的 toString / constructor / __proto__ 不是能力)—— 变异:去掉自有键检查与阶段解析失败检查',
    edits: [
      {
        file: RSI,
        anchor: 'if (!Object.hasOwn(RSI_CAPABILITY_PHASE, key)) return false;',
        replacement: '',
      },
      {
        file: RSI,
        anchor: 'if (need === undefined || phaseIndex(need) < 0) return false;',
        replacement: 'if (need === undefined) return false;',
      },
    ],
    tests: [W0],
    expectRed: ['能力默认拒绝'],
    mustKill: ['能力默认拒绝'],
  },
  {
    id: 'journal-new-commit-optional',
    clause: 'W0-5 / R21-3.6a:引用已更新 / 提交已生成的 journal 必须能指明提交对象',
    edits: [
      {
        file: PERSONAL,
        anchor: 'if (needsCommit && j.new_commit === null) {',
        replacement: 'if (false) {',
      },
    ],
    tests: [W0],
    expectRed: ['负向矩阵 phase × new_commit'],
    mustKill: ['负向矩阵 phase × new_commit'],
  },
  {
    id: 'enum-extra-pause-reason',
    clause: '§21.20 V0 行:枚举多一项 → 红',
    edits: [
      {
        file: RSI,
        anchor: "  'isolation_unverified',\n] as const);\nexport type RsiAutoPauseReason",
        replacement:
          "  'isolation_unverified',\n  'extra_reason',\n] as const);\nexport type RsiAutoPauseReason",
      },
    ],
    tests: [W0],
    expectRed: ['文档码表第一列'],
    mustKill: ['文档码表第一列'],
  },
  {
    id: 'enum-missing-capability',
    clause: '§21.20 V0 行:枚举少一项 → 红(能力表)',
    edits: [{ file: RSI, anchor: "  local_payload: 'V2',\n", replacement: '' }],
    tests: [W0],
    expectRed: ['能力表逐行相等'],
    mustKill: ['能力表逐行相等'],
  },
  {
    id: 'l-base-strict-again',
    clause:
      'R21-2.1:L-base 退回 strict(只放行 session)→ [rsi.auto] 写错一个键连累整个 [rsi] 变 off',
    edits: [
      {
        file: RSI,
        anchor: '  auto: z.record(z.string(), z.unknown()).optional(),\n  capability: z',
        replacement: '  capability: z',
      },
    ],
    tests: [AUTO, W0],
    expectRed: [
      '[rsi.auto] 写错一个键',
      'auto / capability / contrib 是表',
      '[rsi.auto] 合法 → ok',
      '在 L-auto 失败',
    ],
    mustKill: ['[rsi.auto] 写错一个键'],
  },
  {
    id: 'auto-enabled-coerced',
    clause: 'R21-2.1:字符串 "true" 在 L-auto 失败 —— 变异为宽松转换 → 红',
    edits: [
      {
        file: RSI,
        anchor:
          '  enabled: z.boolean().optional(),\n  profile: z.enum(RSI_AUTO_PROFILES).optional(),',
        replacement:
          '  enabled: z.coerce.boolean().optional(),\n  profile: z.enum(RSI_AUTO_PROFILES).optional(),',
      },
    ],
    tests: [AUTO],
    expectRed: ['字符串 "true" 在 L-auto 失败'],
    mustKill: ['字符串 "true" 在 L-auto 失败'],
  },
  {
    id: 'auto-schema-not-strict',
    clause: 'R21-2.1:子表内未知键拒绝(strictObject)→ 改成 object',
    edits: [
      {
        file: RSI,
        anchor: 'export const RsiAutoSchema = z.strictObject({',
        replacement: 'export const RsiAutoSchema = z.object({',
      },
    ],
    tests: [AUTO],
    expectRed: ['[rsi.auto] 写错一个键'],
    mustKill: ['[rsi.auto] 写错一个键'],
  },
  {
    id: 'auto-loop-ignores-phase',
    clause: 'R21-2.2:自动循环有效条件去掉相位一项 → 相位 0 下也生效',
    edits: [
      {
        file: 'src/rsi/auto-config.ts',
        anchor: " && phaseAtLeast('V1a', phase);",
        replacement: ';',
      },
    ],
    tests: [AUTO],
    expectRed: ['W0 相位为 0'],
    mustKill: ['W0 相位为 0'],
  },
  {
    id: 'state-auto-pause-required',
    clause: 'W0-7:auto_pause 必须是可选键(旧 state.json 照常通过)—— 变异为必填',
    edits: [
      {
        file: RSI,
        anchor: '      owner_changed: z.boolean(),\n    })\n    .optional(),\n});',
        replacement: '      owner_changed: z.boolean(),\n    }),\n});',
      },
    ],
    tests: [STATE],
    expectRed: ['旧文件(没有 auto_pause)照常通过', '⑥记录过不了 schema'],
    mustKill: ['旧文件(没有 auto_pause)照常通过'],
  },
  {
    id: 'state-auto-pause-unknown-reason-ok',
    clause: 'W0-7:非法 auto_pause 一律拒绝、不归零 —— 变异为接受任意字符串原因码',
    edits: [
      {
        file: RSI,
        anchor: '        .array(RsiAutoPauseReasonSchema)',
        replacement: '        .array(z.string())',
      },
    ],
    tests: [STATE],
    expectRed: ['非法 auto_pause'],
    mustKill: ['非法 auto_pause'],
  },
  {
    id: 'ledger-probe-refine-removed',
    clause: 'W0-3:admission_probe 是唯一 marker 非空且 candidate_id 为 null 的 excluded 行',
    edits: [
      {
        file: PERSONAL,
        anchor: 'if (probe !== (l.marker !== null && l.candidate_id === null)) {',
        replacement: 'if (false) {',
      },
    ],
    tests: [W0],
    expectRed: ['负向:探针行带 candidate_id'],
    mustKill: ['负向:探针行带 candidate_id'],
  },
  {
    id: 'probe-reason-missing-from-enum',
    clause: 'W0-3:excluded 的 reason 封闭枚举追加 admission_probe —— 变异:漏掉',
    edits: [
      {
        file: RSI,
        anchor: "  'permit_unreadable',\n  'admission_probe',\n] as const);",
        replacement: "  'permit_unreadable',\n] as const);",
      },
    ],
    tests: [W0],
    expectRed: ['正向:treat / control / 各 excluded 原因 / 探针行'],
    mustKill: ['正向:treat / control / 各 excluded 原因 / 探针行'],
  },
  {
    id: 'stop-reconciled-ref-unchecked',
    clause: 'R21-6.4:reason=revocation_reconciled 而 revocation_ref 为 null 的行过不了 schema',
    edits: [
      {
        file: PERSONAL,
        anchor: 'if (reconciled !== (l.revocation_ref !== null)) {',
        replacement: 'if (false) {',
      },
    ],
    tests: [W0],
    expectRed: ['stop 行:revocation_reconciled'],
    mustKill: ['stop 行:revocation_reconciled'],
  },
  {
    id: 'revocation-reason-by-unchecked',
    clause: 'W0-17:撤销凭据 reason 按写入方 by 约束 —— 变异:放行任意原因',
    edits: [
      {
        file: PERSONAL,
        anchor: '.refine((l) => RSI_REVOCATION_REASONS_BY[l.by].includes(l.reason), {',
        replacement: '.refine(() => true, {',
      },
    ],
    tests: [W0],
    expectRed: ['写入方与原因不符', '正常转移码、G 码、identity_changed'],
    mustKill: ['写入方与原因不符', '正常转移码、G 码、identity_changed'],
  },
  {
    id: 'matrix-codex-canary-allowed',
    clause: 'R21-4.3:canary / adopted 下 codex 恒 none —— 变异:放行',
    edits: [
      {
        file: PERSONAL,
        anchor: "if (deploy.codex !== 'none') return",
        replacement: 'if (false) return',
      },
    ],
    tests: [W0],
    expectRed: ['负向:无部署状态里有 agent 非 none'],
    mustKill: ['负向:无部署状态里有 agent 非 none'],
  },
  {
    id: 'journal-bootstrap-old-head-allowed',
    clause: 'W0-5:bootstrap 无旧引用(old_head 必须为 null)',
    edits: [
      {
        file: PERSONAL,
        anchor: 'if (boot && j.old_head !== null) {',
        replacement: 'if (false) {',
      },
    ],
    tests: [W0],
    expectRed: ['负向:bootstrap 带 old_head'],
    mustKill: ['负向:bootstrap 带 old_head'],
  },
  {
    id: 'lesson-jaccard-drift',
    clause: 'W0-2:教训类签名阈值与 cluster.ts 一致 —— 变异:改成 0.4',
    edits: [
      {
        file: RSI,
        anchor: 'export const RSI_LESSON_JACCARD = 0.5;',
        replacement: 'export const RSI_LESSON_JACCARD = 0.4;',
      },
    ],
    tests: [W0],
    expectRed: ['RSI_LESSON_JACCARD == DEFAULT_LESSON_JACCARD'],
    mustKill: ['RSI_LESSON_JACCARD == DEFAULT_LESSON_JACCARD'],
  },
  {
    id: 'terminal-priority-swapped',
    clause: 'R21-4.4a:终态理由优先级 vetoed 最高 —— 变异:judge_rejected 提到最前',
    edits: [
      {
        file: RSI,
        anchor: "  'vetoed',\n  'tainted',\n  'cleared',\n  'judge_rejected',\n",
        replacement: "  'judge_rejected',\n  'vetoed',\n  'tainted',\n  'cleared',\n",
      },
    ],
    tests: [W0],
    expectRed: ['终态理由优先级 vetoed 最高'],
    mustKill: ['终态理由优先级 vetoed 最高'],
  },
  {
    id: 'lint-runsync-unrestricted',
    clause: 'W0-11:runSync 在 src/rsi/** 内限域 —— 变异:去掉限域',
    edits: [
      {
        file: 'eslint.config.js',
        anchor: '          ...(allow.denyRunSync',
        replacement: '          ...(false && allow.denyRunSync',
      },
    ],
    tests: [LINT],
    expectRed: ['src/rsi/personal/** 是 home-fs 的授权使用方'],
    mustKill: ['src/rsi/personal/** 是 home-fs 的授权使用方'],
  },
  {
    id: 'lint-personal-read-not-carved-out',
    clause:
      'W0-11:personal/read/** 与 judge-signal.ts 后置收回 home-fs —— 变异:收回目标改成不存在的文件',
    edits: [
      {
        file: 'eslint.config.js',
        anchor: "files: [`src/rsi/personal/read/**/*.${EXT}`, 'src/rsi/personal/judge-signal.ts'],",
        replacement: "files: ['src/rsi/personal/__none__.ts'],",
      },
    ],
    tests: [LINT],
    expectRed: ['src/rsi/personal/** 是 home-fs 的授权使用方'],
    mustKill: ['src/rsi/personal/** 是 home-fs 的授权使用方'],
  },
  {
    id: 'target-paths-any-string',
    clause: 'R21-3.7:target_paths 退回任意字符串,接受绝对路径与目录穿越',
    edits: [
      {
        file: PERSONAL,
        anchor: 'z.array(RelPathSchema.max(256)).min(1).max(4)',
        replacement: 'z.array(z.string().min(1).max(256)).min(1).max(4)',
      },
    ],
    tests: [W0],
    expectRed: ['target_paths 拒绝绝对路径'],
    mustKill: ['target_paths 拒绝绝对路径'],
  },
  {
    id: 'admission-tickets-unbounded',
    clause: 'W0-3:准入文件 tickets 不再受 RSI_PROBE_SESSIONS 约束',
    edits: [
      {
        file: PERSONAL,
        anchor: 'tickets: z.literal(RSI_PROBE_SESSIONS),',
        replacement: 'tickets: NonNegInt,',
      },
    ],
    tests: [W0],
    expectRed: ['探针票数只能等于 RSI_PROBE_SESSIONS'],
    mustKill: ['探针票数只能等于 RSI_PROBE_SESSIONS'],
  },
  {
    id: 'tracker-ignores-registration',
    clause: 'W0-11:条款追踪把跳过的 suite、未注册函数里的 it 算作覆盖',
    edits: [
      {
        file: 'test/contracts/r21-clause-coverage.test.ts',
        anchor: '        inRegisteredContext(n)\n',
        replacement: '        true\n',
      },
    ],
    tests: ['contracts/r21-clause-coverage.test.ts'],
    expectRed: ['提取器的注册上下文'],
    mustKill: ['提取器的注册上下文'],
  },
  {
    id: 'runsync-relayed',
    clause: 'W0-11:exec.ts 以外的模块转出 runSync,绕开 src/rsi/** 的直接导入限域',
    edits: [
      {
        file: 'src/rsi/auto-config.ts',
        anchor: 'export function resolveAutoConfig(cfg: RsiConfig): RsiAutoConfig {',
        replacement:
          "export { runSync } from '../io/exec.js';\nexport function resolveAutoConfig(cfg: RsiConfig): RsiAutoConfig {",
      },
    ],
    tests: ['lint/run-sync-relay.test.ts'],
    expectRed: ['exec.ts 以外的模块都不转出 runSync'],
    mustKill: ['exec.ts 以外的模块都不转出 runSync'],
  },
];

/**
 * 实测结果(主代理在验证机上执行;作业 r21w0-mut2 @ 550c1df(seal),BASE 136 条全过,26/26 被杀、逐文件 sha256 还原核对通过)。
 * lint-personal-read-not-carved-out:除必杀用例外多红 1 条表外用例(lint 全量正向对照 120 秒超时,机器负载所致;单条重跑 r21w0-mut3 必杀用例同样红)。
 */
export const V1_W0_RESULTS: readonly V1W0Result[] = [
  {
    id: 'phase-promoted-early',
    failed: 4,
    skipped: 0,
    killedBy: ['W0 落地时 RSI_AUTO_PHASE = 0'],
    restored: true,
  },
  {
    id: 'decide-better-default-true',
    failed: 1,
    skipped: 0,
    killedBy: ['W0 落地时 RSI_AUTO_PHASE = 0'],
    restored: true,
  },
  {
    id: 'capability-default-allow',
    failed: 1,
    skipped: 0,
    killedBy: ['能力默认拒绝'],
    restored: true,
  },
  {
    id: 'capability-proto-bypass',
    failed: 1,
    skipped: 0,
    killedBy: ['能力默认拒绝'],
    restored: true,
  },
  {
    id: 'journal-new-commit-optional',
    failed: 1,
    skipped: 0,
    killedBy: ['负向矩阵 phase × new_commit'],
    restored: true,
  },
  {
    id: 'enum-extra-pause-reason',
    failed: 1,
    skipped: 0,
    killedBy: ['文档码表第一列'],
    restored: true,
  },
  {
    id: 'enum-missing-capability',
    failed: 1,
    skipped: 0,
    killedBy: ['能力表逐行相等'],
    restored: true,
  },
  {
    id: 'l-base-strict-again',
    failed: 4,
    skipped: 0,
    killedBy: ['[rsi.auto] 写错一个键'],
    restored: true,
  },
  {
    id: 'auto-enabled-coerced',
    failed: 1,
    skipped: 0,
    killedBy: ['字符串 "true" 在 L-auto 失败'],
    restored: true,
  },
  {
    id: 'auto-schema-not-strict',
    failed: 1,
    skipped: 0,
    killedBy: ['[rsi.auto] 写错一个键'],
    restored: true,
  },
  {
    id: 'auto-loop-ignores-phase',
    failed: 1,
    skipped: 0,
    killedBy: ['W0 相位为 0'],
    restored: true,
  },
  {
    id: 'state-auto-pause-required',
    failed: 2,
    skipped: 0,
    killedBy: ['旧文件(没有 auto_pause)照常通过'],
    restored: true,
  },
  {
    id: 'state-auto-pause-unknown-reason-ok',
    failed: 1,
    skipped: 0,
    killedBy: ['非法 auto_pause'],
    restored: true,
  },
  {
    id: 'ledger-probe-refine-removed',
    failed: 1,
    skipped: 0,
    killedBy: ['负向:探针行带 candidate_id'],
    restored: true,
  },
  {
    id: 'probe-reason-missing-from-enum',
    failed: 1,
    skipped: 0,
    killedBy: ['正向:treat / control / 各 excluded 原因 / 探针行'],
    restored: true,
  },
  {
    id: 'stop-reconciled-ref-unchecked',
    failed: 1,
    skipped: 0,
    killedBy: ['stop 行:revocation_reconciled'],
    restored: true,
  },
  {
    id: 'revocation-reason-by-unchecked',
    failed: 2,
    skipped: 0,
    killedBy: [
      'W0-17 撤销凭据:reason 按写入方 by 约束 写入方与原因不符 → 拒绝',
      'W0-17 撤销凭据:reason 按写入方 by 约束 正常转移码、G 码、identity_changed 对任何写入方都拒绝',
    ],
    restored: true,
  },
  {
    id: 'matrix-codex-canary-allowed',
    failed: 1,
    skipped: 0,
    killedBy: ['负向:无部署状态里有 agent 非 none'],
    restored: true,
  },
  {
    id: 'journal-bootstrap-old-head-allowed',
    failed: 1,
    skipped: 0,
    killedBy: ['负向:bootstrap 带 old_head'],
    restored: true,
  },
  {
    id: 'lesson-jaccard-drift',
    failed: 1,
    skipped: 0,
    killedBy: ['RSI_LESSON_JACCARD == DEFAULT_LESSON_JACCARD'],
    restored: true,
  },
  {
    id: 'terminal-priority-swapped',
    failed: 1,
    skipped: 0,
    killedBy: ['终态理由优先级 vetoed 最高'],
    restored: true,
  },
  {
    id: 'lint-runsync-unrestricted',
    failed: 1,
    skipped: 0,
    killedBy: ['src/rsi/personal/** 是 home-fs 的授权使用方'],
    restored: true,
  },
  {
    id: 'lint-personal-read-not-carved-out',
    failed: 2,
    skipped: 0,
    killedBy: ['src/rsi/personal/** 是 home-fs 的授权使用方'],
    restored: true,
  },
  {
    id: 'target-paths-any-string',
    failed: 1,
    skipped: 0,
    killedBy: ['target_paths 拒绝绝对路径'],
    restored: true,
  },
  {
    id: 'admission-tickets-unbounded',
    failed: 1,
    skipped: 0,
    killedBy: ['探针票数只能等于 RSI_PROBE_SESSIONS'],
    restored: true,
  },
  {
    id: 'tracker-ignores-registration',
    failed: 1,
    skipped: 0,
    killedBy: ['提取器的注册上下文'],
    restored: true,
  },
  {
    id: 'runsync-relayed',
    failed: 1,
    skipped: 0,
    killedBy: ['exec.ts 以外的模块都不转出 runSync'],
    restored: true,
  },
];
