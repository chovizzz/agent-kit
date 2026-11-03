/**
 * N4(契约 §20.18 R20-18.28 必杀变异;⑩ 的 R20-18.39 变异随 §21 V1 并入,见文末注释):每条变异后必须有测试红,且只红该条款自己的杀手用例。
 * 执行方式同 A6(`a6-mutation-table.ts`):javis 私有检出里 cp 备份 → 按锚点替换(每个锚点在对应文件里**恰好出现一次**)→ 跑 `tests` →
 * 失败集合非空、全部命中 `expectRed`、`mustKill` 每项至少命中一个、没有 skipped → cp 还原并逐文件 sha256 核对。**不用 git checkout / stash 还原**。
 * 本文件只写表与每条变异期望红的测试名(`expectRed` 是杀手测试源码里的字面子串);变异由主代理在 javis 上执行,结果记进 `N4_RESULTS`(实装块不执行变异,故留空)。
 *
 * R20-18.28 的变异点与本表 id 的对应:
 *   跳过 TTY 门 / 非 TTY 仍写 → skip-tty-gate;跳过厂商名比对 / 改子串 / 与自身比 → vendor-compare-skipped、vendor-compare-substring、vendor-compare-self;
 *   不核对 rule_sha256 → rule-hash-not-checked;不核对 run_id → run-id-not-checked;不重算展示指纹 → fingerprint-not-recomputed;
 *   覆盖已有 spawned 裁决 / --replace 可替换 spawned → overwrite-existing-judge、replace-allows-spawned;
 *   未确认的自报被当作确认 → unconfirmed-reflector-passes、judge-binding-not-recomputed、reflector-binding-not-recomputed;
 *   两侧同厂商放行 → same-vendor-passes;unknown / 非内置厂商放行 → judge-unknown-vendor-passes、reflector-unknown-vendor-passes;
 *   declared_vendor_conflict 检测删除 → declared-conflict-removed;自报标记在 report.json / pr-body.md / stdout 丢失 → label-lost-judge、report-self-reported-lost;
 *   promo_id 不并入 vendor_evidence → promo-id-ignores-evidence;CI 路径比本地宽 → ci-pair-check-dropped;
 *   旧记录缺省 provenance 被拒或被当 session_confirmed → legacy-provenance-rejected、legacy-provenance-as-session;
 *   reflector.confirmed 在 spawned 提案上被接受 → confirmed-on-spawned-accepted;自动入口 import judge-ingest → auto-entry-imports-judge-ingest;
 *   键入内容被回显进输出 → typed-content-echoed;parseJudgeOutput 复用被绕过 → parse-output-bypassed;严格批次退化为逐条跳过 → strict-batch-degraded;
 *   写阶段改动 reflector 其它字段 → store-reflector-fields-modified、store-assert-disabled;确认屏含路径 / 控制字符 → screen-leak-gate-bypassed;
 *   确认屏输出到 stdout → stdout-polluted;C5 新增 reason 而 CI 未覆盖 → c5-reason-not-wired;isCrossVendorOf 在 vendor.ts 之外被引用 → cross-vendor-of-referenced-outside;
 *   自报反思器仍触发 REFLECTOR_VENDOR_MISMATCH → self-confirmed-reflector-not-suppressed(本地)、ci-unverifiable-not-suppressed(CI);
 *   session_confirmed 被计入校准账 / 不触发 CALIBRATION_SELF_REPORTED → calibration-counts-self-reported、calibration-self-reported-no-warn;
 *   C8 清单漏 declared.model / confirmed.model → c8-misses-declared-model、c8-misses-confirmed-model;superRefine 仍拿 reflector.vendor 比 judge_attempts → superrefine-uses-raw-vendor。
 * 未列入(等价变异,N4i-17):「写阶段不再重验反思器侧需要确认的条件」——展示指纹已含 layer / provenance / 确认状态,重验条件与指纹冗余,实装保留它作纵深防御,由 fingerprint-not-recomputed 覆盖。
 * ⑩ 的变异点(收紧消费被反用为放行、非 proven 的记录被消费、source_proposal 不可变等,R20-18.39 与 N4 订正 #5)随 V1 并入本表;V1 尚无候选创建实装。
 */
export interface Edit {
  file: string;
  anchor: string;
  replacement: string;
}

export interface N4Mutation {
  id: string;
  /** 契约里的变异点原文 */
  clause: string;
  edits: readonly Edit[];
  /** 相对 `test/` */
  tests: readonly string[];
  expectRed: readonly string[];
  mustKill: readonly string[];
}

export interface N4Result {
  id: string;
  failed: number;
  skipped: number;
  killedBy: readonly string[];
  restored: boolean;
}

const SERVICE = 'judge/ingest/service.test.ts';
const COMMAND = 'judge/ingest/command.test.ts';
const STORE = 'judge/ingest/store.test.ts';
const SCHEMA = 'contracts/n4-schema.test.ts';
const EVIDENCE = 'contracts/n4-vendor-evidence.test.ts';
const CALIB = 'lifecycle/n4-calibration.test.ts';
const RUNLLM = 'judge/ingest/run-llm.test.ts';
const T2 = 'guards/n4-self-reported-t2.test.ts';
const CLOSURE = 'rsi/import-closure.test.ts';
const PROMOTE = 'commands/promote.test.ts';
const ADOPT = 'commands/promote-adopt.test.ts';
const C8 = 'lifecycle/n4-c8.test.ts';

const NOOP = 'void 0;';
const OFF = 'if (false as boolean) {';

export const N4_MUTATIONS: readonly N4Mutation[] = [
  {
    id: 'skip-tty-gate',
    clause: '跳过 TTY 门 / 非 TTY 仍写',
    edits: [
      {
        file: 'src/commands/judge-ingest.ts',
        anchor: "if (handle === undefined) return usage(ctx, 'not_tty');",
        replacement: NOOP,
      },
    ],
    tests: [COMMAND],
    expectRed: ['--write 且打不开控制终端'],
    mustKill: ['--write 且打不开控制终端'],
  },
  {
    id: 'vendor-compare-skipped',
    clause: '跳过厂商名比对',
    edits: [
      {
        file: 'src/io/tty.ts',
        anchor: 'if (folded === undefined || folded !== spec.expectJudgeVendor) return decline(',
        replacement: 'if (folded === undefined) return decline(',
      },
    ],
    tests: [SERVICE],
    expectRed: ['零写入,不取锁'],
    mustKill: ['零写入,不取锁'],
  },
  {
    id: 'vendor-compare-substring',
    clause: '厂商名比对改为子串',
    edits: [
      {
        file: 'src/io/tty.ts',
        anchor: 'if (folded === undefined || folded !== spec.expectJudgeVendor) return decline(',
        replacement:
          'if (folded === undefined || !String(spec.expectJudgeVendor).includes(folded)) return decline(',
      },
    ],
    tests: [SERVICE],
    expectRed: ['零写入,不取锁'],
    mustKill: ['零写入,不取锁'],
  },
  {
    id: 'vendor-compare-self',
    clause: '比对对象改成键入值与自身比',
    edits: [
      {
        file: 'src/io/tty.ts',
        anchor: 'if (folded === undefined || folded !== spec.expectJudgeVendor) return decline(',
        replacement: 'if (folded === undefined || folded !== folded) return decline(',
      },
    ],
    tests: [SERVICE],
    expectRed: ['零写入,不取锁'],
    mustKill: ['零写入,不取锁'],
  },
  {
    id: 'rule-hash-not-checked',
    clause: '不核对 rule_sha256',
    edits: [
      {
        file: 'src/judge/ingest/plan.ts',
        anchor: "if (v.rule_sha256 !== sha) return no('rule_hash_mismatch');",
        replacement: NOOP,
      },
    ],
    tests: [SERVICE, COMMAND],
    expectRed: [
      '校验不过同样走 rejected(使 agent 能看到原因)',
      '严格批次:合法 + 非法混合 → 整批拒,零写入(合法那条也没写)',
      'run 状态类:proposal_unknown',
      '校验拒绝 → 退出 1',
    ],
    mustKill: ['run 状态类:proposal_unknown'],
  },
  {
    id: 'run-id-not-checked',
    clause: '不核对 run_id',
    edits: [
      {
        file: 'src/judge/ingest/validate.ts',
        anchor: "if (p.run_id !== runId) return no('run_mismatch');",
        replacement: NOOP,
      },
    ],
    tests: [SERVICE],
    expectRed: ['payload 形状 / 声明 / run 类'],
    mustKill: ['payload 形状 / 声明 / run 类'],
  },
  {
    id: 'fingerprint-not-recomputed',
    clause: '不重算展示指纹(STALE 失效)',
    edits: [
      {
        file: 'src/judge/ingest/service.ts',
        anchor: 'if (planFingerprint(again.plan) !== data.fingerprint) {',
        replacement: OFF,
      },
    ],
    tests: [SERVICE],
    // 规则文件被改先被锁内重读的 rule_hash 核对拦下(同样落 STALE),不经指纹;指纹的必杀是提案文件被改
    expectRed: ['规则文件在展示后被改 → STALE', '提案文件在展示后被改', '指纹不含 payload 项'],
    mustKill: ['提案文件在展示后被改'],
  },
  {
    id: 'overwrite-existing-judge',
    clause: '覆盖已有 spawned 裁决',
    edits: [
      {
        file: 'src/judge/ingest/plan.ts',
        anchor: "if (ex.kind !== 'none' && !(i.replace && ex.kind === 'session_confirmed')) {",
        replacement: OFF,
      },
    ],
    tests: [SERVICE],
    expectRed: [
      '--replace 替换既有 session_confirmed:完整确认后替换,旧 binding 消失;确认屏列出旧记录摘要;不带 --replace 则拒',
      '已有 spawned 裁决 → already_judged',
      '重放同一 payload → already_judged',
    ],
    mustKill: ['已有 spawned 裁决 → already_judged'],
  },
  {
    id: 'replace-allows-spawned',
    clause: '--replace 可替换 spawned',
    edits: [
      {
        file: 'src/judge/ingest/plan.ts',
        anchor: "if (ex.kind !== 'none' && !(i.replace && ex.kind === 'session_confirmed')) {",
        replacement: "if (ex.kind !== 'none' && !i.replace) {",
      },
    ],
    tests: [SERVICE],
    expectRed: ['已有 spawned 裁决 → already_judged'],
    mustKill: ['已有 spawned 裁决 → already_judged'],
  },
  {
    id: 'unconfirmed-reflector-passes',
    clause: '未确认的自报被当作确认(reflector.confirmed 缺失仍放行)',
    edits: [
      {
        file: 'src/contracts/vendor.ts',
        anchor: "if (c === undefined) return 'REFLECTOR_SESSION_DECLARED';",
        replacement: 'if (c === undefined) return undefined;',
      },
    ],
    tests: [EVIDENCE],
    expectRed: [
      '单侧入口:反思器压制规则——self_confirmed 时不发 BACKEND_MISSING / VENDOR_MISMATCH(A4 写的 provider=session / model=undeclared 必然命中)',
      '反思器 self_confirmed:CI 不发 REFLECTOR_UNVERIFIABLE(压制),但 session_declared 无确认时发(R20-16.20 ② 保持)',
      '穷尽性:C5 观察到的每个 reason 都在 C5_REASONS 里,C5_REASONS 的每一项都在 C5_CI_CODES 里(往 C5 加 reason 不接 CI → 红)',
      'session_declared 无确认 + proven 裁判',
    ],
    mustKill: ['session_declared 无确认 + proven 裁判'],
  },
  {
    id: 'judge-binding-not-recomputed',
    clause: 'binding_sha256 不重算(裁判侧)',
    edits: [
      {
        file: 'src/contracts/vendor.ts',
        anchor:
          "if (judgeBindingSha256(p, j) !== j.confirmation.binding_sha256) return 'JUDGE_CONFIRM_INVALID';",
        replacement: NOOP,
      },
    ],
    tests: [EVIDENCE],
    expectRed: [
      'spawned 专属码不对 session_confirmed 发出;session_confirmed 无效时只发 JUDGE_CONFIRM_INVALID',
      '裁判确认 binding 被改',
    ],
    mustKill: ['裁判确认 binding 被改'],
  },
  {
    id: 'reflector-binding-not-recomputed',
    clause: 'binding_sha256 不重算(反思器侧)',
    edits: [
      {
        file: 'src/contracts/vendor.ts',
        anchor:
          "if (reflectorBindingSha256(p) !== c.binding_sha256) return 'REFLECTOR_CONFIRM_INVALID';",
        replacement: NOOP,
      },
    ],
    tests: [EVIDENCE],
    expectRed: ['反思器确认 binding 被改'],
    mustKill: ['反思器确认 binding 被改'],
  },
  {
    id: 'same-vendor-passes',
    clause: '两侧同厂商放行',
    edits: [
      {
        file: 'src/contracts/vendor.ts',
        anchor:
          '!isCrossVendor(claimedReflectorVendor(p, r.side), claimedJudgeVendor(p, j.side)) &&',
        replacement: 'false &&',
      },
    ],
    tests: [EVIDENCE],
    expectRed: [
      '反思器确认为非内置厂商',
      '反思器确认为 unknown',
      'session_declared 无确认 + proven 裁判',
      '反思器确认 binding 被改',
      '反思器确认不合理(claude 后端却确认为 openai 厂商 + claude 模型串)',
      '裁判确认 binding 被改(verdict 被改成 accept 之外的值而 binding 不动)',
      '裁判自报 vendor=unknown',
      '裁判自报非内置厂商',
      '反思器 self_confirmed:CI 不发 REFLECTOR_UNVERIFIABLE(压制),但 session_declared 无确认时发(R20-16.20 ② 保持)',
      '同厂商:self_confirmed 反思器 openai + 自报裁判 openai',
    ],
    mustKill: ['同厂商:self_confirmed 反思器 openai + 自报裁判 openai'],
  },
  {
    id: 'judge-unknown-vendor-passes',
    clause: 'unknown / 非内置厂商放行(裁判侧)',
    edits: [
      {
        file: 'src/contracts/vendor.ts',
        anchor: 'if (!BUILTIN_VENDORS.includes(d.vendor) || d.vendor === UNKNOWN_VENDOR) {',
        replacement: OFF,
      },
    ],
    tests: [EVIDENCE],
    expectRed: ['裁判自报 vendor=unknown', '裁判自报非内置厂商'],
    mustKill: ['裁判自报 vendor=unknown'],
  },
  {
    id: 'reflector-unknown-vendor-passes',
    clause: 'unknown / 非内置厂商放行(反思器侧)',
    edits: [
      {
        file: 'src/contracts/vendor.ts',
        anchor: 'if (!BUILTIN_VENDORS.includes(c.vendor) || c.vendor === UNKNOWN_VENDOR) {',
        replacement: OFF,
      },
    ],
    tests: [SERVICE, EVIDENCE],
    expectRed: [
      '反思器侧:非内置厂商 / 模型串非法',
      '反思器确认为非内置厂商',
      '反思器确认为 unknown',
    ],
    mustKill: ['反思器确认为非内置厂商', '反思器确认为 unknown'],
  },
  {
    id: 'declared-conflict-removed',
    clause: 'declared_vendor_conflict 检测删除',
    edits: [
      {
        file: 'src/judge/ingest/validate.ts',
        anchor: 'if (derived !== UNKNOWN_VENDOR && derived !== p.declared.vendor) {',
        replacement: OFF,
      },
    ],
    tests: [SERVICE],
    expectRed: ['payload 形状 / 声明 / run 类'],
    mustKill: ['payload 形状 / 声明 / run 类'],
  },
  {
    id: 'label-lost-judge',
    clause: '自报标记在 pr-body.md / stdout 丢失(裁判侧)',
    edits: [
      {
        file: 'src/lifecycle/vendor-report.ts',
        anchor: "const judgeSelf = reports.some((r) => r.self_reported.includes('judge'));",
        replacement: 'const judgeSelf = false;',
      },
    ],
    tests: [PROMOTE, ADOPT],
    expectRed: ['裁判侧自报:SELF_REPORT_LABEL_JUDGE 出现', 'N4:裁判侧是人工确认的自报'],
    mustKill: ['裁判侧自报:SELF_REPORT_LABEL_JUDGE 出现', 'N4:裁判侧是人工确认的自报'],
  },
  {
    id: 'report-self-reported-lost',
    clause: '自报标记在 report.json 丢失',
    edits: [
      {
        file: 'src/lifecycle/vendor-report.ts',
        anchor: "if (ev.judge.tier === 'self_confirmed') self.push('judge');",
        replacement: NOOP,
      },
    ],
    tests: [PROMOTE, ADOPT],
    expectRed: ['裁判侧自报:SELF_REPORT_LABEL_JUDGE 出现', 'N4:裁判侧是人工确认的自报'],
    mustKill: ['裁判侧自报:SELF_REPORT_LABEL_JUDGE 出现'],
  },
  {
    id: 'promo-id-ignores-evidence',
    clause: 'promo_id 不并入 vendor_evidence',
    edits: [
      {
        file: 'src/lifecycle/promote-rule.ts',
        anchor: 'canonicalJson(vendorEvidence),',
        replacement: "'',",
      },
    ],
    tests: [PROMOTE],
    expectRed: ['裁判侧自报:SELF_REPORT_LABEL_JUDGE 出现'],
    mustKill: ['裁判侧自报:SELF_REPORT_LABEL_JUDGE 出现'],
  },
  {
    id: 'ci-pair-check-dropped',
    clause: 'CI 路径比本地宽(自报同厂商配对放行)',
    edits: [
      {
        file: 'src/guards/criteria.ts',
        anchor: "for (const i of ev.issues.filter((x) => x.side === 'pair')) issue(i);",
        replacement: NOOP,
      },
    ],
    tests: [EVIDENCE],
    expectRed: [
      '反思器 self_confirmed:CI 不发 REFLECTOR_UNVERIFIABLE(压制),但 session_declared 无确认时发(R20-16.20 ② 保持)',
      '本地不过 ⇒ CI 有 error',
    ],
    mustKill: ['本地不过 ⇒ CI 有 error'],
  },
  {
    id: 'legacy-provenance-rejected',
    clause: '旧记录缺省 provenance 被拒',
    edits: [
      {
        file: 'src/contracts/proposal.ts',
        anchor: "!Object.prototype.hasOwnProperty.call(v, 'provenance')",
        replacement: 'false',
      },
    ],
    tests: [SCHEMA],
    expectRed: [
      'spawned 的 superRefine 原样保留:hops 链、最后一跳 ok',
      '旧记录(无 provenance)继续合法且按 spawned 解析',
    ],
    mustKill: ['旧记录(无 provenance)继续合法且按 spawned 解析'],
  },
  {
    id: 'legacy-provenance-as-session',
    clause: '旧记录缺省 provenance 被当 session_confirmed',
    edits: [
      {
        file: 'src/contracts/proposal.ts',
        anchor: "{ ...(v as Record<string, unknown>), provenance: 'spawned' }",
        replacement: "{ ...(v as Record<string, unknown>), provenance: 'session_confirmed' }",
      },
    ],
    tests: [SCHEMA],
    expectRed: [
      'spawned 的 superRefine 原样保留:hops 链、最后一跳 ok',
      '旧记录(无 provenance)继续合法且按 spawned 解析',
    ],
    mustKill: ['旧记录(无 provenance)继续合法且按 spawned 解析'],
  },
  {
    id: 'confirmed-on-spawned-accepted',
    clause: 'reflector.confirmed 在 spawned 提案上被接受',
    edits: [
      {
        file: 'src/contracts/proposal.ts',
        anchor:
          "if (p.reflector.confirmed !== undefined && p.reflector.provenance !== 'session_declared') {",
        replacement: OFF,
      },
    ],
    tests: [SCHEMA],
    expectRed: ['只允许出现在 session_declared 提案上'],
    mustKill: ['只允许出现在 session_declared 提案上'],
  },
  {
    id: 'auto-entry-imports-judge-ingest',
    clause: '自动入口 import judge-ingest',
    edits: [
      {
        file: 'src/rsi/hint.ts',
        anchor: "import * as path from 'node:path';",
        replacement: "import '../commands/judge-ingest.js';\nimport * as path from 'node:path';",
      },
    ],
    tests: [CLOSURE],
    expectRed: ['随块生效:src/rsi/ 下已存在的真实入口文件同样要求闭包干净'],
    mustKill: ['随块生效:src/rsi/ 下已存在的真实入口文件同样要求闭包干净'],
  },
  {
    id: 'typed-content-echoed',
    clause: '用户键入内容被回显进输出',
    edits: [
      {
        file: 'src/io/tty.ts',
        anchor: 'if (folded === undefined || folded !== spec.expectJudgeVendor) return decline(',
        replacement:
          "if (folded === undefined || folded !== spec.expectJudgeVendor) return decline(`invalid:${r.kind === 'line' ? r.text : ''}` as never) ?? decline(",
      },
    ],
    tests: [COMMAND],
    expectRed: ['放弃 → 退出 1 JUDGE_CONFIRM_DECLINED'],
    mustKill: ['放弃 → 退出 1 JUDGE_CONFIRM_DECLINED'],
  },
  {
    id: 'parse-output-bypassed',
    clause: 'parseJudgeOutput 复用被绕过(超限 / 话术 / 不可见字符放行)',
    edits: [
      {
        file: 'src/judge/ingest/plan.ts',
        anchor: 'if (!parsed.ok) return no(outputRejectionReason(parsed.code));',
        replacement: NOOP,
      },
    ],
    tests: [SERVICE],
    expectRed: [
      'predicted 时 prediction 必填且形状合法(prediction_invalid);非 predicted 时 agent 给的 prediction 被丢弃',
      'output 类:映射到各自的子码',
    ],
    mustKill: ['output 类:映射到各自的子码'],
  },
  {
    id: 'strict-batch-degraded',
    clause: '严格批次退化为逐条跳过',
    edits: [
      {
        file: 'src/judge/ingest/plan.ts',
        anchor: "if (v.rule_sha256 !== sha) return no('rule_hash_mismatch');",
        replacement: 'if (v.rule_sha256 !== sha) continue;',
      },
    ],
    tests: [SERVICE],
    expectRed: [
      '校验不过同样走 rejected(使 agent 能看到原因)',
      'run 状态类:proposal_unknown / proposal_unsupported / rule_hash_mismatch / already_judged',
      '严格批次:合法 + 非法混合',
    ],
    mustKill: ['严格批次:合法 + 非法混合'],
  },
  {
    id: 'store-reflector-fields-modified',
    clause: '写阶段改动 reflector 的其它字段',
    edits: [
      {
        file: 'src/judge/store.ts',
        anchor: 'next[k] = { ...r, confirmed: fields.confirmed };',
        replacement: "next[k] = { ...r, vendor: 'openai', confirmed: fields.confirmed };",
      },
    ],
    tests: [STORE, SERVICE],
    expectRed: [
      '同 run 前提防回归:两个不同 input_digest 的 session_declared 提案 → 拒一次覆盖(schema_invalid),零写入',
      '写入只改 reflector.confirmed(judge 原样);不限层;不允许空行跳过',
      '--proposal 限定子集;不在候选里 → proposal_unknown;键入厂商与已有 judge 同厂商 → same_vendor',
      '已有 confirmed(无效的旧值)被替换',
      'confirmed:reflector 里只追加 confirmed 一个键',
      'team 提案:裁判侧 + 反思器侧都由用户键入',
    ],
    mustKill: ['confirmed:reflector 里只追加 confirmed 一个键'],
  },
  {
    id: 'store-assert-disabled',
    clause: '写原语的 reflector 其它字段不变量被拿掉',
    edits: [
      {
        file: 'src/judge/store.ts',
        anchor: 'if (JSON.stringify(strip(b as object)) !== JSON.stringify(strip(a as object))) {',
        replacement: OFF,
      },
    ],
    tests: [STORE],
    expectRed: ['vendor / model / provenance / provider / run_id / 新增键 / 删除键 → 抛'],
    mustKill: ['vendor / model / provenance / provider / run_id / 新增键 / 删除键 → 抛'],
  },
  {
    id: 'screen-leak-gate-bypassed',
    clause: '确认屏含路径 / 控制字符仍被打印(泄漏闸 / 清洗被绕过)',
    edits: [
      {
        file: 'src/judge/ingest/screen.ts',
        anchor: 'if (!guardOutput(lines, forbidden).ok) return undefined;',
        replacement: NOOP,
      },
    ],
    tests: [SERVICE],
    expectRed: ['确认屏过不了泄漏闸'],
    mustKill: ['确认屏过不了泄漏闸'],
  },
  {
    id: 'stdout-polluted',
    clause: '确认屏输出到 stdout 而非控制终端(--json 被污染)',
    edits: [
      {
        file: 'src/commands/judge-ingest.ts',
        anchor: 'ctx.stdout(json ? canonicalJson(doc) : text);',
        replacement:
          "ctx.stdout(json ? canonicalJson(doc) : text);\n  ctx.stdout('declared agent=');",
      },
    ],
    tests: [COMMAND],
    expectRed: [
      '--write 且打不开控制终端 → 退出 2 JUDGE_USAGE reason=not_tty;stdin 未读、暂存区字节不变;干跑在无 TTY 下可跑',
      '放弃 → 退出 1 JUDGE_CONFIRM_DECLINED;用户键入的内容不出现在 stdout / stderr',
      '--confirm-reflector 无候选 → 退出 0 nothing_to_confirm,零写入',
      '干跑文本输出:每条提案一行(枚举 + freeze=deferred),不含 payload 自由文本',
      '--write --json:stdout 只有固定键集合的 JSON',
    ],
    mustKill: ['--write --json:stdout 只有固定键集合的 JSON'],
  },
  {
    id: 'c5-reason-not-wired',
    clause: 'C5 新增 reason 而 judgeChecks 未覆盖(CI 静默变宽)',
    edits: [
      {
        file: 'src/lifecycle/checks.ts',
        anchor: "'JUDGE_LAST_HOP_VENDOR_MISMATCH',\n  'JUDGE_VENDOR_UNPROVEN',\n] as const;",
        replacement:
          "'JUDGE_LAST_HOP_VENDOR_MISMATCH',\n  'JUDGE_VENDOR_UNPROVEN',\n  'BRAND_NEW_REASON',\n] as const;",
      },
    ],
    tests: [EVIDENCE],
    expectRed: ['穷尽性:C5 观察到的每个 reason'],
    mustKill: ['穷尽性:C5 观察到的每个 reason'],
  },
  {
    id: 'cross-vendor-of-referenced-outside',
    clause: 'isCrossVendorOf 在 vendor.ts 之外被引用(第二个单一实现)',
    edits: [
      {
        file: 'src/guards/criteria.ts',
        anchor: 'const ev = vendorEvidence(pr);',
        replacement:
          "const ev = vendorEvidence(pr);\n  void isCrossVendorOf({ vendor: 'x' }, 'y');",
      },
      {
        file: 'src/guards/criteria.ts',
        anchor: "import { ruleSha256 } from '../lifecycle/checks.js';",
        replacement:
          "import { ruleSha256 } from '../lifecycle/checks.js';\nimport { isCrossVendorOf } from '../contracts/vendor.js';",
      },
    ],
    tests: [EVIDENCE],
    expectRed: ['import 图 / 引用扫描'],
    mustKill: ['import 图 / 引用扫描'],
  },
  {
    id: 'self-confirmed-reflector-not-suppressed',
    clause: 'self_confirmed 反思器仍触发 REFLECTOR_VENDOR_MISMATCH(已确认提案全红)',
    edits: [
      {
        file: 'src/contracts/vendor.ts',
        anchor: "if (p.reflector.provenance === 'session_declared') {",
        replacement: OFF,
      },
    ],
    tests: [EVIDENCE, RUNLLM],
    expectRed: [
      '反思器确认为非内置厂商',
      '反思器确认为 unknown',
      'self_confirmed 反思器 + proven 裁判',
      'session_declared 无确认 + proven 裁判',
      '反思器确认 binding 被改',
      '反思器确认不合理(claude 后端却确认为 openai 厂商 + claude 模型串)',
      '同厂商:self_confirmed 反思器 openai + 自报裁判 openai',
      'model:proven 取反思器记录的 model / 裁判最后一跳的 model;self_confirmed 取键入 / 声明值',
      '单侧入口:反思器压制规则——self_confirmed 时不发 BACKEND_MISSING / VENDOR_MISMATCH(A4 写的 provider=session / model=undeclared 必然命中)',
      '反思器 self_confirmed:CI 不发 REFLECTOR_UNVERIFIABLE(压制),但 session_declared 无确认时发(R20-16.20 ② 保持)',
      '确认的厂商参与同厂商判定:反思器确认为 openai → codex 跳 skipped:same-vendor,改由下一家评审',
      '全链无成功时写的 judge_attempts 以有效反思器厂商记 same-vendor 跳,自己的 schema 接受(否则确认后 judge --run-llm 的产出会被自己拒绝)',
      '既有 session_confirmed 裁决:judge --run-llm 跳过(not_measurable 口径),不调用,outcome 标注来源',
      'self_confirmed + self_confirmed(不要求至少一侧可证明',
      '行为翻转:反思器侧确认',
    ],
    mustKill: ['self_confirmed + self_confirmed(不要求至少一侧可证明'],
  },
  {
    id: 'ci-unverifiable-not-suppressed',
    clause: '自报反思器在 CI 仍触发 REFLECTOR_UNVERIFIABLE',
    edits: [
      {
        file: 'src/guards/criteria.ts',
        anchor: "if (ev.reflector.tier !== 'self_confirmed') {",
        replacement: 'if (true as boolean) {',
      },
    ],
    tests: [EVIDENCE],
    expectRed: [
      // 参数化用例(it 标题由模板拼出),取模板里的字面部分
      '本地不过 ⇒ CI 有 error;本地的每个厂商类 reason 在 CI 都有映射码',
      '反思器 self_confirmed:CI 不发 REFLECTOR_UNVERIFIABLE',
    ],
    mustKill: ['反思器 self_confirmed:CI 不发 REFLECTOR_UNVERIFIABLE'],
  },
  {
    id: 'calibration-counts-self-reported',
    clause: 'session_confirmed 记录被计入校准账',
    edits: [
      {
        file: 'src/lifecycle/calibration.ts',
        anchor: "if (j['provenance'] === 'session_confirmed') {",
        replacement: OFF,
      },
    ],
    tests: [CALIB],
    expectRed: ['历史里有 session_confirmed 记录'],
    mustKill: ['历史里有 session_confirmed 记录'],
  },
  {
    id: 'calibration-self-reported-no-warn',
    clause: '以 session_confirmed 为裁判的晋升不触发 GUARD_G3_CALIBRATION_SELF_REPORTED',
    edits: [
      {
        file: 'src/guards/criteria.ts',
        anchor: "const selfReported = judge?.provenance === 'session_confirmed';",
        replacement: 'const selfReported = false;',
      },
    ],
    tests: [T2],
    expectRed: ['session_confirmed 裁判:K4 冻结核验同形放行'],
    mustKill: ['session_confirmed 裁判:K4 冻结核验同形放行'],
  },
  {
    id: 'c8-misses-declared-model',
    clause: 'C8 清单漏 declared.model',
    edits: [
      {
        file: 'src/lifecycle/checks.ts',
        anchor: "{ path: 'judge.declared.model', text: j.declared.model },",
        replacement: '',
      },
    ],
    tests: [C8],
    expectRed: ['C8 复扫清单含 judge.declared.model'],
    mustKill: ['C8 复扫清单含 judge.declared.model'],
  },
  {
    id: 'c8-misses-confirmed-model',
    clause: 'C8 清单漏 confirmed.model',
    edits: [
      {
        file: 'src/lifecycle/checks.ts',
        anchor: "{ path: 'reflector.confirmed.model', text: rc.model },",
        replacement: '',
      },
    ],
    tests: [C8],
    expectRed: ['C8 复扫清单含 reflector.confirmed.model'],
    mustKill: ['C8 复扫清单含 reflector.confirmed.model'],
  },
  {
    id: 'superrefine-uses-raw-vendor',
    clause: 'superRefine 仍拿 reflector.vendor(unknown)比 judge_attempts',
    edits: [
      {
        file: 'src/contracts/proposal.ts',
        anchor: 'const mine = normVendor(effectiveReflectorVendor(p.reflector));',
        replacement: 'const mine = normVendor(p.reflector.vendor);',
      },
    ],
    tests: [SCHEMA, RUNLLM],
    expectRed: ['judge_attempts 的同厂商比较用有效反思器厂商', '全链无成功时写的 judge_attempts'],
    mustKill: ['judge_attempts 的同厂商比较用有效反思器厂商'],
  },
];

/** 主代理在 javis 上执行变异后填写(实装块不执行,故留空) */
// 2026-11-03 javis 私有检出 @ 864451e:基线 226 例全绿、0 skipped;40 条变异全部被杀、无 skipped / 套件错误,每条还原后检出干净;javis HOME 的 agent 配置与 kit 状态前后不变。
// 首轮(@ 8c03095)22/37 通过:judge-/reflector-unknown-vendor-passes 存活(夹具被合理性检查先拦,内置厂商校验测不到 → 改用 pi + 无法归族模型串,并新增反思器侧 2 条夹具);
// fingerprint-not-recomputed 的必杀改为提案文件被改(规则文件被改先由 rule_hash 核对落 STALE);其余 14 条只是多红了表外相关用例(已补登 expectRed)。
export const N4_RESULTS: readonly N4Result[] = [
  {
    id: 'skip-tty-gate',
    failed: 1,
    skipped: 0,
    killedBy: [
      'TTY 门(R20-18.5) > --write 且打不开控制终端 → 退出 2 JUDGE_USAGE reason=not_tty;stdin 未读、暂存区字节不变;干跑在无 TTY 下可跑',
    ],
    restored: true,
  },
  {
    id: 'vendor-compare-skipped',
    failed: 5,
    skipped: 0,
    killedBy: [
      'R20-18.6 第 2 步:厂商名比对(单次机会、逐字节全等) > 前缀 → 放弃(invalid),零写入,不取锁',
      'R20-18.6 第 2 步:厂商名比对(单次机会、逐字节全等) > 子串 → 放弃(invalid),零写入,不取锁',
      'R20-18.6 第 2 步:厂商名比对(单次机会、逐字节全等) > y → 放弃(invalid),零写入,不取锁',
      'R20-18.6 第 2 步:厂商名比对(单次机会、逐字节全等) > yes → 放弃(invalid),零写入,不取锁',
      'R20-18.6 第 2 步:厂商名比对(单次机会、逐字节全等) > 内部空白 → 放弃(invalid),零写入,不取锁',
    ],
    restored: true,
  },
  {
    id: 'vendor-compare-substring',
    failed: 2,
    skipped: 0,
    killedBy: [
      'R20-18.6 第 2 步:厂商名比对(单次机会、逐字节全等) > 前缀 → 放弃(invalid),零写入,不取锁',
      'R20-18.6 第 2 步:厂商名比对(单次机会、逐字节全等) > 子串 → 放弃(invalid),零写入,不取锁',
    ],
    restored: true,
  },
  {
    id: 'vendor-compare-self',
    failed: 5,
    skipped: 0,
    killedBy: [
      'R20-18.6 第 2 步:厂商名比对(单次机会、逐字节全等) > 前缀 → 放弃(invalid),零写入,不取锁',
      'R20-18.6 第 2 步:厂商名比对(单次机会、逐字节全等) > 子串 → 放弃(invalid),零写入,不取锁',
      'R20-18.6 第 2 步:厂商名比对(单次机会、逐字节全等) > y → 放弃(invalid),零写入,不取锁',
      'R20-18.6 第 2 步:厂商名比对(单次机会、逐字节全等) > yes → 放弃(invalid),零写入,不取锁',
      'R20-18.6 第 2 步:厂商名比对(单次机会、逐字节全等) > 内部空白 → 放弃(invalid),零写入,不取锁',
    ],
    restored: true,
  },
  {
    id: 'rule-hash-not-checked',
    failed: 4,
    skipped: 0,
    killedBy: [
      '输出通道与退出码(R20-18.22) > 校验拒绝 → 退出 1 JUDGE_INGEST_REJECTED reason=<子码>;stderr 不回显 payload / 异常文本',
      'R20-18.4 默认干跑:不要求 TTY、零写入 > 校验不过同样走 rejected(使 agent 能看到原因)',
      'R20-18.9 payload 校验:每个子码一个夹具(严格批次,零写入) > run 状态类:proposal_unknown / proposal_unsupported / rule_hash_mismatch / already_judged',
      'R20-18.9 payload 校验:每个子码一个夹具(严格批次,零写入) > 严格批次:合法 + 非法混合 → 整批拒,零写入(合法那条也没写)',
    ],
    restored: true,
  },
  {
    id: 'run-id-not-checked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R20-18.9 payload 校验:每个子码一个夹具(严格批次,零写入) > payload 形状 / 声明 / run 类',
    ],
    restored: true,
  },
  {
    id: 'fingerprint-not-recomputed',
    failed: 2,
    skipped: 0,
    killedBy: [
      'R20-18.6 第 4 步:锁内指纹复核(STALE,零写入) > 提案文件在展示后被改(含 judge 被并发写入)→ STALE',
      'R20-18.11 --confirm-reflector > 指纹不含 payload 项:展示后改提案 → STALE',
    ],
    restored: true,
  },
  {
    id: 'overwrite-existing-judge',
    failed: 3,
    skipped: 0,
    killedBy: [
      'R20-18.8 覆盖规则 > 重放同一 payload → already_judged(不做幂等「成功」)',
      'R20-18.8 覆盖规则 > 已有 spawned 裁决 → already_judged,--replace 也拒(绝不覆盖可证明的裁决)',
      'R20-18.8 覆盖规则 > --replace 替换既有 session_confirmed:完整确认后替换,旧 binding 消失;确认屏列出旧记录摘要;不带 --replace 则拒',
    ],
    restored: true,
  },
  {
    id: 'replace-allows-spawned',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R20-18.8 覆盖规则 > 已有 spawned 裁决 → already_judged,--replace 也拒(绝不覆盖可证明的裁决)',
    ],
    restored: true,
  },
  {
    id: 'unconfirmed-reflector-passes',
    failed: 5,
    skipped: 0,
    killedBy: [
      'R20-18.17 vendorEvidence 真值表 > session_declared 无确认 + proven 裁判',
      'R20-18.17 vendorEvidence 真值表 > 单侧入口:反思器压制规则——self_confirmed 时不发 BACKEND_MISSING / VENDOR_MISMATCH(A4 写的 provider=session / model=undeclared 必然命中)',
      'R20-18.19 CI(judgeChecks)与本地(checkC5)同口径:CI 不比本地宽 > session_declared 无确认 + proven 裁判:本地不过 ⇒ CI 有 error;本地的每个厂商类 reason 在 CI 都有映射码',
      'R20-18.19 CI(judgeChecks)与本地(checkC5)同口径:CI 不比本地宽 > 反思器 self_confirmed:CI 不发 REFLECTOR_UNVERIFIABLE(压制),但 session_declared 无确认时发(R20-16.20 ② 保持)',
      'R20-18.19 CI(judgeChecks)与本地(checkC5)同口径:CI 不比本地宽 > 穷尽性:C5 观察到的每个 reason 都在 C5_REASONS 里,C5_REASONS 的每一项都在 C5_CI_CODES 里(往 C5 加 reason 不接 CI → 红)',
    ],
    restored: true,
  },
  {
    id: 'judge-binding-not-recomputed',
    failed: 2,
    skipped: 0,
    killedBy: [
      'R20-18.17 vendorEvidence 真值表 > 裁判确认 binding 被改(verdict 被改成 accept 之外的值而 binding 不动)',
      'R20-18.17 vendorEvidence 真值表 > spawned 专属码不对 session_confirmed 发出;session_confirmed 无效时只发 JUDGE_CONFIRM_INVALID',
    ],
    restored: true,
  },
  {
    id: 'reflector-binding-not-recomputed',
    failed: 1,
    skipped: 0,
    killedBy: ['R20-18.17 vendorEvidence 真值表 > 反思器确认 binding 被改'],
    restored: true,
  },
  {
    id: 'same-vendor-passes',
    failed: 10,
    skipped: 0,
    killedBy: [
      'R20-18.17 vendorEvidence 真值表 > session_declared 无确认 + proven 裁判',
      'R20-18.17 vendorEvidence 真值表 > 反思器确认 binding 被改',
      'R20-18.17 vendorEvidence 真值表 > 反思器确认不合理(claude 后端却确认为 openai 厂商 + claude 模型串)',
      'R20-18.17 vendorEvidence 真值表 > 裁判确认 binding 被改(verdict 被改成 accept 之外的值而 binding 不动)',
      'R20-18.17 vendorEvidence 真值表 > 裁判自报 vendor=unknown',
      'R20-18.17 vendorEvidence 真值表 > 裁判自报非内置厂商',
      'R20-18.17 vendorEvidence 真值表 > 反思器确认为非内置厂商(pi 后端 + 无法归族的模型串)',
      'R20-18.17 vendorEvidence 真值表 > 反思器确认为 unknown(pi 后端 + 无法归族的模型串)',
      'R20-18.17 vendorEvidence 真值表 > 同厂商:self_confirmed 反思器 openai + 自报裁判 openai',
      'R20-18.19 CI(judgeChecks)与本地(checkC5)同口径:CI 不比本地宽 > 反思器 self_confirmed:CI 不发 REFLECTOR_UNVERIFIABLE(压制),但 session_declared 无确认时发(R20-16.20 ② 保持)',
    ],
    restored: true,
  },
  {
    id: 'judge-unknown-vendor-passes',
    failed: 2,
    skipped: 0,
    killedBy: [
      'R20-18.17 vendorEvidence 真值表 > 裁判自报 vendor=unknown',
      'R20-18.17 vendorEvidence 真值表 > 裁判自报非内置厂商',
    ],
    restored: true,
  },
  {
    id: 'reflector-unknown-vendor-passes',
    failed: 2,
    skipped: 0,
    killedBy: [
      'R20-18.17 vendorEvidence 真值表 > 反思器确认为非内置厂商(pi 后端 + 无法归族的模型串)',
      'R20-18.17 vendorEvidence 真值表 > 反思器确认为 unknown(pi 后端 + 无法归族的模型串)',
    ],
    restored: true,
  },
  {
    id: 'declared-conflict-removed',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R20-18.9 payload 校验:每个子码一个夹具(严格批次,零写入) > payload 形状 / 声明 / run 类',
    ],
    restored: true,
  },
  {
    id: 'label-lost-judge',
    failed: 2,
    skipped: 0,
    killedBy: [
      'promote --run:端到端 > N4:裁判侧是人工确认的自报 → 四处标注 SELF_REPORT_LABEL_JUDGE、不出现 VENDOR_PROVEN_LABEL;promo_id 随层级变化;同一证据重跑同 id',
      'N4 vendor_evidence(promote --rule) > 裁判侧自报:SELF_REPORT_LABEL_JUDGE 出现、VENDOR_PROVEN_LABEL 不出现;self_reported = [judge];promo_id 与 proven 世界不同',
    ],
    restored: true,
  },
  {
    id: 'report-self-reported-lost',
    failed: 2,
    skipped: 0,
    killedBy: [
      'promote --run:端到端 > N4:裁判侧是人工确认的自报 → 四处标注 SELF_REPORT_LABEL_JUDGE、不出现 VENDOR_PROVEN_LABEL;promo_id 随层级变化;同一证据重跑同 id',
      'N4 vendor_evidence(promote --rule) > 裁判侧自报:SELF_REPORT_LABEL_JUDGE 出现、VENDOR_PROVEN_LABEL 不出现;self_reported = [judge];promo_id 与 proven 世界不同',
    ],
    restored: true,
  },
  {
    id: 'promo-id-ignores-evidence',
    failed: 1,
    skipped: 0,
    killedBy: [
      'N4 vendor_evidence(promote --rule) > 裁判侧自报:SELF_REPORT_LABEL_JUDGE 出现、VENDOR_PROVEN_LABEL 不出现;self_reported = [judge];promo_id 与 proven 世界不同',
    ],
    restored: true,
  },
  {
    id: 'ci-pair-check-dropped',
    failed: 10,
    skipped: 0,
    killedBy: [
      'R20-18.19 CI(judgeChecks)与本地(checkC5)同口径:CI 不比本地宽 > session_declared 无确认 + proven 裁判:本地不过 ⇒ CI 有 error;本地的每个厂商类 reason 在 CI 都有映射码',
      'R20-18.19 CI(judgeChecks)与本地(checkC5)同口径:CI 不比本地宽 > 反思器确认 binding 被改:本地不过 ⇒ CI 有 error;本地的每个厂商类 reason 在 CI 都有映射码',
      'R20-18.19 CI(judgeChecks)与本地(checkC5)同口径:CI 不比本地宽 > 反思器确认不合理(claude 后端却确认为 openai 厂商 + claude 模型串):本地不过 ⇒ CI 有 error;本地的每个厂商类 reason 在 CI 都有映射码',
      'R20-18.19 CI(judgeChecks)与本地(checkC5)同口径:CI 不比本地宽 > 裁判确认 binding 被改(verdict 被改成 accept 之外的值而 binding 不动):本地不过 ⇒ CI 有 error;本地的每个厂商类 reason 在 CI 都有映射码',
      'R20-18.19 CI(judgeChecks)与本地(checkC5)同口径:CI 不比本地宽 > 裁判自报 vendor=unknown:本地不过 ⇒ CI 有 error;本地的每个厂商类 reason 在 CI 都有映射码',
      'R20-18.19 CI(judgeChecks)与本地(checkC5)同口径:CI 不比本地宽 > 裁判自报非内置厂商:本地不过 ⇒ CI 有 error;本地的每个厂商类 reason 在 CI 都有映射码',
      'R20-18.19 CI(judgeChecks)与本地(checkC5)同口径:CI 不比本地宽 > 反思器确认为非内置厂商(pi 后端 + 无法归族的模型串):本地不过 ⇒ CI 有 error;本地的每个厂商类 reason 在 CI 都有映射码',
      'R20-18.19 CI(judgeChecks)与本地(checkC5)同口径:CI 不比本地宽 > 反思器确认为 unknown(pi 后端 + 无法归族的模型串):本地不过 ⇒ CI 有 error;本地的每个厂商类 reason 在 CI 都有映射码',
      'R20-18.19 CI(judgeChecks)与本地(checkC5)同口径:CI 不比本地宽 > 同厂商:self_confirmed 反思器 openai + 自报裁判 openai:本地不过 ⇒ CI 有 error;本地的每个厂商类 reason 在 CI 都有映射码',
      'R20-18.19 CI(judgeChecks)与本地(checkC5)同口径:CI 不比本地宽 > 反思器 self_confirmed:CI 不发 REFLECTOR_UNVERIFIABLE(压制),但 session_declared 无确认时发(R20-16.20 ② 保持)',
    ],
    restored: true,
  },
  {
    id: 'legacy-provenance-rejected',
    failed: 2,
    skipped: 0,
    killedBy: [
      'R20-18.13 判别联合与缺省补键 > 旧记录(无 provenance)继续合法且按 spawned 解析;显式 spawned 同样合法',
      'R20-18.13 判别联合与缺省补键 > spawned 的 superRefine 原样保留:hops 链、最后一跳 ok',
    ],
    restored: true,
  },
  {
    id: 'legacy-provenance-as-session',
    failed: 2,
    skipped: 0,
    killedBy: [
      'R20-18.13 判别联合与缺省补键 > 旧记录(无 provenance)继续合法且按 spawned 解析;显式 spawned 同样合法',
      'R20-18.13 判别联合与缺省补键 > spawned 的 superRefine 原样保留:hops 链、最后一跳 ok',
    ],
    restored: true,
  },
  {
    id: 'confirmed-on-spawned-accepted',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R20-18.14 reflector.confirmed > 只允许出现在 session_declared 提案上;出现在 spawned / 缺省提案上 → schema 失败',
    ],
    restored: true,
  },
  {
    id: 'auto-entry-imports-judge-ingest',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R20-1.1 import 闭包:从各入口分别起算 > 随块生效:src/rsi/ 下已存在的真实入口文件同样要求闭包干净',
    ],
    restored: true,
  },
  {
    id: 'typed-content-echoed',
    failed: 1,
    skipped: 0,
    killedBy: [
      '输出通道与退出码(R20-18.22) > 放弃 → 退出 1 JUDGE_CONFIRM_DECLINED;用户键入的内容不出现在 stdout / stderr',
    ],
    restored: true,
  },
  {
    id: 'parse-output-bypassed',
    failed: 2,
    skipped: 0,
    killedBy: [
      'R20-18.9 payload 校验:每个子码一个夹具(严格批次,零写入) > output 类:映射到各自的子码',
      'R20-18.9 payload 校验:每个子码一个夹具(严格批次,零写入) > predicted 时 prediction 必填且形状合法(prediction_invalid);非 predicted 时 agent 给的 prediction 被丢弃',
    ],
    restored: true,
  },
  {
    id: 'strict-batch-degraded',
    failed: 3,
    skipped: 0,
    killedBy: [
      'R20-18.4 默认干跑:不要求 TTY、零写入 > 校验不过同样走 rejected(使 agent 能看到原因)',
      'R20-18.9 payload 校验:每个子码一个夹具(严格批次,零写入) > run 状态类:proposal_unknown / proposal_unsupported / rule_hash_mismatch / already_judged',
      'R20-18.9 payload 校验:每个子码一个夹具(严格批次,零写入) > 严格批次:合法 + 非法混合 → 整批拒,零写入(合法那条也没写)',
    ],
    restored: true,
  },
  {
    id: 'store-reflector-fields-modified',
    failed: 6,
    skipped: 0,
    killedBy: [
      'R20-18.6 / 18.8 写入:happy path > team 提案:裁判侧 + 反思器侧都由用户键入;只改 judge 与 reflector.confirmed;judge_attempts 不存在;其余字节不变',
      'R20-18.6 第 2 步:厂商名比对(单次机会、逐字节全等) > 同 run 前提防回归:两个不同 input_digest 的 session_declared 提案 → 拒一次覆盖(schema_invalid),零写入',
      'R20-18.11 --confirm-reflector > 写入只改 reflector.confirmed(judge 原样);不限层;不允许空行跳过',
      'R20-18.11 --confirm-reflector > --proposal 限定子集;不在候选里 → proposal_unknown;键入厂商与已有 judge 同厂商 → same_vendor',
      'applyIngestFields > confirmed:reflector 里只追加 confirmed 一个键,其余字段与键序原样;judge_attempts 保留',
      'applyIngestFields > 已有 confirmed(无效的旧值)被替换',
    ],
    restored: true,
  },
  {
    id: 'store-assert-disabled',
    failed: 1,
    skipped: 0,
    killedBy: [
      'assertOnlyIngestKeysChanged:reflector 其余字段改动即抛(具体原因) > vendor / model / provenance / provider / run_id / 新增键 / 删除键 → 抛',
    ],
    restored: true,
  },
  {
    id: 'screen-leak-gate-bypassed',
    failed: 1,
    skipped: 0,
    killedBy: ['R20-18.7 锁与闸 > 确认屏过不了泄漏闸(含禁止值)→ output_leak,不读输入'],
    restored: true,
  },
  {
    id: 'stdout-polluted',
    failed: 5,
    skipped: 0,
    killedBy: [
      'TTY 门(R20-18.5) > --write 且打不开控制终端 → 退出 2 JUDGE_USAGE reason=not_tty;stdin 未读、暂存区字节不变;干跑在无 TTY 下可跑',
      '输出通道与退出码(R20-18.22) > --write --json:stdout 只有固定键集合的 JSON;确认屏全在终端句柄;stderr 为空;退出 0',
      '输出通道与退出码(R20-18.22) > 放弃 → 退出 1 JUDGE_CONFIRM_DECLINED;用户键入的内容不出现在 stdout / stderr',
      '输出通道与退出码(R20-18.22) > --confirm-reflector 无候选 → 退出 0 nothing_to_confirm,零写入',
      '输出通道与退出码(R20-18.22) > 干跑文本输出:每条提案一行(枚举 + freeze=deferred),不含 payload 自由文本',
    ],
    restored: true,
  },
  {
    id: 'c5-reason-not-wired',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R20-18.19 CI(judgeChecks)与本地(checkC5)同口径:CI 不比本地宽 > 穷尽性:C5 观察到的每个 reason 都在 C5_REASONS 里,C5_REASONS 的每一项都在 C5_CI_CODES 里(往 C5 加 reason 不接 CI → 红)',
    ],
    restored: true,
  },
  {
    id: 'cross-vendor-of-referenced-outside',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R20-18.17 单一实现:isCrossVendorOf 除 vendor.ts 外 src/ 与 cli.ts 里不再有引用 > import 图 / 引用扫描',
    ],
    restored: true,
  },
  {
    id: 'self-confirmed-reflector-not-suppressed',
    failed: 15,
    skipped: 0,
    killedBy: [
      'R20-18.17 vendorEvidence 真值表 > self_confirmed 反思器 + proven 裁判',
      'R20-18.17 vendorEvidence 真值表 > self_confirmed + self_confirmed(不要求至少一侧可证明,Q-N4-2 = A)',
      'R20-18.17 vendorEvidence 真值表 > session_declared 无确认 + proven 裁判',
      'R20-18.17 vendorEvidence 真值表 > 反思器确认 binding 被改',
      'R20-18.17 vendorEvidence 真值表 > 反思器确认不合理(claude 后端却确认为 openai 厂商 + claude 模型串)',
      'R20-18.17 vendorEvidence 真值表 > 反思器确认为非内置厂商(pi 后端 + 无法归族的模型串)',
      'R20-18.17 vendorEvidence 真值表 > 反思器确认为 unknown(pi 后端 + 无法归族的模型串)',
      'R20-18.17 vendorEvidence 真值表 > 同厂商:self_confirmed 反思器 openai + 自报裁判 openai',
      'R20-18.17 vendorEvidence 真值表 > model:proven 取反思器记录的 model / 裁判最后一跳的 model;self_confirmed 取键入 / 声明值',
      'R20-18.17 vendorEvidence 真值表 > 单侧入口:反思器压制规则——self_confirmed 时不发 BACKEND_MISSING / VENDOR_MISMATCH(A4 写的 provider=session / model=undeclared 必然命中)',
      'R20-18.19 CI(judgeChecks)与本地(checkC5)同口径:CI 不比本地宽 > 反思器 self_confirmed:CI 不发 REFLECTOR_UNVERIFIABLE(压制),但 session_declared 无确认时发(R20-16.20 ② 保持)',
      'R20-18.21 judge --run-llm 接入 > 行为翻转:反思器侧确认(anthropic)后可评审;产出 spawned,磁盘上显式带 provenance: spawned;证据 = self_confirmed 反思器 + proven 裁判',
      'R20-18.21 judge --run-llm 接入 > 确认的厂商参与同厂商判定:反思器确认为 openai → codex 跳 skipped:same-vendor,改由下一家评审',
      'R20-18.21 judge --run-llm 接入 > 全链无成功时写的 judge_attempts 以有效反思器厂商记 same-vendor 跳,自己的 schema 接受(否则确认后 judge --run-llm 的产出会被自己拒绝)',
      'R20-18.21 judge --run-llm 接入 > 既有 session_confirmed 裁决:judge --run-llm 跳过(not_measurable 口径),不调用,outcome 标注来源',
    ],
    restored: true,
  },
  {
    id: 'ci-unverifiable-not-suppressed',
    failed: 3,
    skipped: 0,
    killedBy: [
      'R20-18.19 CI(judgeChecks)与本地(checkC5)同口径:CI 不比本地宽 > self_confirmed 反思器 + proven 裁判:本地不过 ⇒ CI 有 error;本地的每个厂商类 reason 在 CI 都有映射码',
      'R20-18.19 CI(judgeChecks)与本地(checkC5)同口径:CI 不比本地宽 > self_confirmed + self_confirmed(不要求至少一侧可证明,Q-N4-2 = A):本地不过 ⇒ CI 有 error;本地的每个厂商类 reason 在 CI 都有映射码',
      'R20-18.19 CI(judgeChecks)与本地(checkC5)同口径:CI 不比本地宽 > 反思器 self_confirmed:CI 不发 REFLECTOR_UNVERIFIABLE(压制),但 session_declared 无确认时发(R20-16.20 ② 保持)',
    ],
    restored: true,
  },
  {
    id: 'calibration-counts-self-reported',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R20-18.19 ④ 校准账排除自报记录 > 历史里有 session_confirmed 记录:不进任何键、不产生 unreadable / unavailable、seen 为空',
    ],
    restored: true,
  },
  {
    id: 'calibration-self-reported-no-warn',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R20-18.19 ③④ 自报裁决的 T2(advisory → active) > session_confirmed 裁判:K4 冻结核验同形放行(无 ACCEPTANCE_*),但发 CALIBRATION_SELF_REPORTED(warn),有效块数 +STRICT_EXTRA_TILES → THRESHOLD_TILES',
    ],
    restored: true,
  },
  {
    id: 'c8-misses-declared-model',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R20-18.19 ⑤ C8 复扫清单 > C8 复扫清单含 judge.declared.model:声明的模型串里带口令 → REDACTION_RESIDUAL,字段指向 judge.declared.model',
    ],
    restored: true,
  },
  {
    id: 'c8-misses-confirmed-model',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R20-18.19 ⑤ C8 复扫清单 > C8 复扫清单含 reflector.confirmed.model:用户键入的反思器模型串里带口令 → 字段指向 reflector.confirmed.model',
    ],
    restored: true,
  },
  {
    id: 'superrefine-uses-raw-vendor',
    failed: 2,
    skipped: 0,
    killedBy: [
      'R20-18.14 reflector.confirmed > judge_attempts 的同厂商比较用有效反思器厂商(confirmed.vendor),否则确认后写出的 judge_attempts 会被自己的 schema 拒绝',
      'R20-18.21 judge --run-llm 接入 > 全链无成功时写的 judge_attempts 以有效反思器厂商记 same-vendor 跳,自己的 schema 接受(否则确认后 judge --run-llm 的产出会被自己拒绝)',
    ],
    restored: true,
  },
];
