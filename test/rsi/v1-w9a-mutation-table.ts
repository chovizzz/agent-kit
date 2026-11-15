/**
 * §21 V1 W9a 必杀变异(判官裁决的纯判定、读端口适配器、展示映射、`rsi show` 段取值、读侧 import 闭包与 `ruleSha256` 拆分、`judge_seen` 契约;
 * contracts R20-18.34 / R20-18.35 / R20-18.37 / R20-18.38、W0-27)。
 * 执行方式同 W5 / W6 / W7 / W8:验证机私有检出里 cp 备份 → 按锚点替换(每个锚点在对应文件里**恰好出现一次**)→ 跑 `tests` → 失败集合非空、全部命中 `expectRed`、
 * `mustKill` 每项至少命中一个、没有 skipped → cp 还原并逐文件 sha256 核对。**不用 git checkout / stash 还原**。
 * `expectRed` 是杀手测试名里的字面子串:先列本变异的专属用例名,再列所在测试文件的 describe 前缀(同一源文件的改动会连带变红同文件里的其它用例,前缀让「失败集合 ⊆ expectRed」
 * 只约束到文件级;精度由 `mustKill`(专属用例必须变红)保证)。结果由主代理执行变异后回填 `V1_W9A_RESULTS`(W9a 实装块不执行变异,故留空)。变异 id 用短的下划线词。
 *
 * 契约 R20-18.39 写的并表位置(`test/judge/n4-mutation-table.ts`)不存在,N4 的表在 `test/rsi/n4-mutation-table.ts`;本表独立成文件(W0-27)。
 * 不在本表的点(如实记录):`JudgeVerdictRead` 的 provenance ↔ identity 关联是编译期性质(`@ts-expect-error` 用例由 tsc 守,变异跑的是 vitest,不进本表);`rule-hash.ts` 的归一化 / 抛错语义由 `checks-gov` 与 `test/judge/rule-hash.test.ts` 既有用例与 a24 变异守住,本表只守「拆分后闭包与再导出」;
 * 读适配器首读的属主校验(`owner`;回读的属主核对由 `recheckUnsafe` 假 stat 用例与变异覆盖)在同 UID 的测试环境里无法构造「别人的文件」,没有对应变异;一致性协议的 `dProp` / `dRules` 目录核对与文件身份核对互相冗余(任一单独删除都有另一道发现),不单列变异。
 */
export interface Edit {
  file: string;
  anchor: string;
  replacement: string;
}

export interface V1W9AMutation {
  id: string;
  /** 契约条款 / 该不变量 */
  clause: string;
  edits: readonly Edit[];
  /** 相对 `test/` */
  tests: readonly string[];
  expectRed: readonly string[];
  mustKill: readonly string[];
}

export interface V1W9AResult {
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

export const V1_W9A_MUTATIONS: readonly V1W9AMutation[] = [
  {
    id: 'nolink_not_blocked',
    clause: 'W0-27 来源缺失:source_proposal 为 null 拒绝增影响(no_source)',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        "return none('no_link', 'none', 'no_source', 'null');",
        "return none('no_link', 'none', null, 'null');",
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: [
      'source_proposal 为 null / 缺失 → no_link',
      'judgeResultCode / judgeSeenOf / growthBlockOf 的取值表',
      'W9a 判官裁决判定',
    ],
    mustKill: ['source_proposal 为 null / 缺失 → no_link'],
  },
  {
    id: 'link_corrupt_not_indeterminate',
    clause: 'W0-27 损坏不得降级成放行',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        "if (l === null) return none('invalid', 'invalid', 'indeterminate', 'malformed_link');",
        "if (l === null) return none('invalid', 'invalid', null, 'malformed_link');",
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: ['source_proposal 损坏(多键 / 非法 run_id', 'W9a 判官裁决判定'],
    mustKill: ['source_proposal 损坏(多键 / 非法 run_id'],
  },
  {
    id: 'unwired_as_no_verdict',
    clause: 'W0-27 端口未装配 = 读不出',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        "if (source === null) return unreadable('unwired');",
        "if (source === null) return none('no_link', 'none', null, 'unwired');",
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: ['读端口未装配(null)→ unreadable', 'W9a 判官裁决判定'],
    mustKill: ['读端口未装配(null)→ unreadable'],
  },
  {
    id: 'run_gone_not_blocking',
    clause: 'W0-27 来源缺失:run_gone 拒绝增影响(source_gone)',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        "return none('run_gone', 'none', 'source_gone', 'run_gone');",
        "return none('run_gone', 'none', null, 'run_gone');",
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: [
      '端口给出的分类原样映射',
      'judgeResultCode / judgeSeenOf / growthBlockOf 的取值表',
      'W9a 判官裁决判定',
    ],
    mustKill: ['端口给出的分类原样映射'],
  },
  {
    id: 'unreadable_not_indeterminate',
    clause: 'W0-27 读不出拒绝增影响(indeterminate)',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        "none('unreadable', 'invalid', 'indeterminate', why);",
        "none('unreadable', 'invalid', null, why);",
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: [
      '读端口未装配(null)→ unreadable',
      '端口抛错 / 返回非法形状 → unreadable',
      '端口给出的分类原样映射',
      '读超时 → unreadable(timeout)',
      'judgeResultCode / judgeSeenOf / growthBlockOf 的取值表',
      'W9a 判官裁决判定',
    ],
    mustKill: ['读端口未装配(null)→ unreadable'],
  },
  {
    id: 'port_throw_as_excluded',
    clause: 'R20-18.34 端口抛错不得当作无裁决',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        "return unreadable('io');",
        "return none('run_excluded', 'none', null, 'io');",
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: ['端口抛错 / 返回非法形状 → unreadable', 'W9a 判官裁决判定'],
    mustKill: ['端口抛错 / 返回非法形状 → unreadable'],
  },
  {
    id: 'port_shape_unchecked',
    clause: '跨信任边界运行时校验',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        "return shapeOf(raw) ?? unreadable('port_contract');",
        'return raw as JudgeSourceRead;',
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: ['端口抛错 / 返回非法形状 → unreadable', 'W9a 判官裁决判定'],
    mustKill: ['端口抛错 / 返回非法形状 → unreadable'],
  },
  {
    id: 'timeout_no_abort',
    // 末尾的整次评估核对(M1)也会中止 controller,单独拿掉定时器里的中止看不出差别:两层一起拿掉,才是「超时不中止」
    clause: 'W0-27 2 秒预算经 AbortSignal 传给端口(定时器层与末尾核对两层都不中止)',
    edits: [
      swap('src/rsi/personal/judge-signal.ts', '      ctl.abort();\n', ''),
      swap(
        'src/rsi/personal/judge-signal.ts',
        "    clock.ctl.abort();\n    return unreadable('timeout');\n  }\n  return v;",
        "    return unreadable('timeout');\n  }\n  return v;",
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: [
      '读超时 → unreadable(timeout)',
      '端口立即返回,但同步的 ruleSha256 耗时超预算',
      'judgeEvidence 同步耗时超预算',
      '同步工作占住事件循环、定时器来不及触发时',
      'W9a 判官裁决判定',
    ],
    mustKill: ['读超时 → unreadable(timeout)'],
  },
  {
    id: 'timeout_as_no_verdict',
    // 末尾的整次评估核对(M1)会把超预算的任何结论改回 unreadable(timeout),单独变异定时器层看不出差别:连同末尾核对一起失效
    clause: 'W0-27 超时 = unreadable(定时器层给出「无裁决」且末尾核对失效)',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        "resolve(unreadable('timeout'));",
        "resolve(none('not_verified', 'none', null, 'timeout'));",
      ),
      swap(
        'src/rsi/personal/judge-signal.ts',
        '  if (elapsed(clock) > clock.budgetMs) {\n',
        '  if (elapsed(clock) > clock.budgetMs * 1e9) {\n',
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: [
      '读超时 → unreadable(timeout)',
      '端口立即返回,但同步的 ruleSha256 耗时超预算',
      'judgeEvidence 同步耗时超预算',
      '同步工作占住事件循环、定时器来不及触发时',
      'W9a 判官裁决判定',
    ],
    mustKill: ['读超时 → unreadable(timeout)'],
  },
  {
    id: 'schema_failure_as_no_verdict',
    clause: 'R20-18.34 ③ ProposalSchema',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        "if (!parsed.success) return invalid('schema');",
        "if (!parsed.success) return none('not_verified', 'none', null, 'judge_absent');",
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: ['不过 ProposalSchema(多余键)', 'W9a 判官裁决判定'],
    mustKill: ['不过 ProposalSchema(多余键)'],
  },
  {
    id: 'layer_check_dropped',
    clause: 'R20-18.34 ③ layer = personal(team 层记录不被消费)',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        "  if (p.layer !== 'personal') return invalid('layer_not_personal');\n",
        '',
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: ['team 层提案的记录不被消费', 'W9a 判官裁决判定'],
    mustKill: ['team 层提案的记录不被消费'],
  },
  {
    id: 'id_check_dropped',
    clause: 'R20-18.34 ③ id 等于 proposal_id',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        "  if (p.id !== l.proposal_id) return invalid('id_mismatch');\n",
        '',
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: ['id 不等于 proposal_id', 'W9a 判官裁决判定'],
    mustKill: ['id 不等于 proposal_id'],
  },
  {
    id: 'run_id_check_dropped',
    clause: 'R20-18.34 ③ reflector.run_id 等于 run_id(记录被搬到别的 run)',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        "  if (p.reflector.run_id !== l.run_id) return invalid('run_id_mismatch');\n",
        '',
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: ['reflector.run_id 不等于 run_id', 'W9a 判官裁决判定'],
    mustKill: ['reflector.run_id 不等于 run_id'],
  },
  {
    id: 'op_check_dropped',
    clause: 'R20-18.34 ⑤ 评审装载约束 op = add、单目标',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        "  if (p.op !== 'add' || p.targets.length !== 1) return invalid('not_reviewable');\n",
        '',
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: ['op 不是 add', 'targets 不是单目标', 'W9a 判官裁决判定'],
    mustKill: ['op 不是 add'],
  },
  {
    id: 'evidence_check_skipped',
    clause: 'R20-18.34 ④ 跳过校验仍消费(binding 不重算 / 非 proven)',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        'if (ev.side.tier !== wantTier || ev.issues.length > 0) {',
        'if (false) {',
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: [
      '没有 judge 键 → not_verified',
      'session_confirmed 的 reject 记录:binding 被改',
      'spawned:非 proven',
      'W9a 判官裁决判定',
    ],
    mustKill: ['没有 judge 键 → not_verified'],
  },
  {
    id: 'evidence_issues_ignored',
    clause: 'R20-18.34 ④ 带 issues 的「通过」不算',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        'if (ev.side.tier !== wantTier || ev.issues.length > 0) {',
        'if (ev.side.tier !== wantTier) {',
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: ['证据层级与 provenance 必须配对', 'W9a 判官裁决判定'],
    mustKill: ['证据层级与 provenance 必须配对'],
  },
  {
    id: 'evidence_tier_ignored',
    clause: 'R20-18.34 ④ 证据层级与 provenance 配对',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        'if (ev.side.tier !== wantTier || ev.issues.length > 0) {',
        'if (ev.issues.length > 0) {',
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: ['证据层级与 provenance 必须配对', 'W9a 判官裁决判定'],
    mustKill: ['证据层级与 provenance 必须配对'],
  },
  {
    id: 'evidence_throw_escapes',
    clause: 'R20-18.34 永不抛错',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        "  } catch {\n    return none('not_verified', 'invalid', null, 'evidence_threw');",
        '  } catch (x) {\n    throw x;',
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: ['evidence 注入函数抛错', 'W9a 判官裁决判定'],
    mustKill: ['evidence 注入函数抛错'],
  },
  {
    id: 'judge_absent_shown_invalid',
    clause: 'R20-18.37 无 judge 键 = judge=none',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        "return none('not_verified', 'none', null, 'judge_absent');",
        "return none('not_verified', 'invalid', null, 'judge_absent');",
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: ['没有 judge 键 → not_verified', 'W9a 判官裁决判定'],
    mustKill: ['没有 judge 键 → not_verified'],
  },
  {
    id: 'validation_failed_shown_none',
    clause: 'R20-18.37 校验失败 = judge=invalid',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        "return none('not_verified', 'invalid', null, 'validation_failed');",
        "return none('not_verified', 'none', null, 'validation_failed');",
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: ['没有 judge 键 → not_verified', 'spawned:非 proven', 'W9a 判官裁决判定'],
    mustKill: ['没有 judge 键 → not_verified'],
  },
  {
    id: 'rule_unbound_passes',
    clause: 'R20-18.34 ⑤ spawned 缺 rule_sha256 不算通过',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        "  if (judge.rule_sha256 === undefined)\n    return none('rule_changed', 'invalid', null, 'rule_sha_unbound');\n",
        '  if (judge.rule_sha256 === undefined) {\n    // mutated\n  }\n',
      ),
      swap(
        'src/rsi/personal/judge-signal.ts',
        "if (now !== judge.rule_sha256) return none('rule_changed', 'invalid', null, 'rule_sha_mismatch');",
        "if (judge.rule_sha256 !== undefined && now !== judge.rule_sha256) return none('rule_changed', 'invalid', null, 'rule_sha_mismatch');",
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: ['spawned 记录缺 rule_sha256', 'W9a 判官裁决判定'],
    mustKill: ['spawned 记录缺 rule_sha256'],
  },
  {
    id: 'rule_hash_not_compared',
    clause: 'R20-18.34 ⑤ rule_sha256 不核对',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        "  if (now !== judge.rule_sha256) return none('rule_changed', 'invalid', null, 'rule_sha_mismatch');\n",
        '',
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: ['规则文本被改(rule_sha256 不符)→ rule_changed', 'W9a 判官裁决判定'],
    mustKill: ['规则文本被改(rule_sha256 不符)→ rule_changed'],
  },
  {
    id: 'rule_absent_as_no_verdict',
    clause: 'R20-18.34 ⑤ 规则文件缺失 = rule_changed',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        "if (r.rule === null) return none('rule_changed', 'invalid', null, 'rule_absent');",
        "if (r.rule === null) return none('not_verified', 'none', null, 'rule_absent');",
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: ['规则文件不存在 → rule_changed(rule_absent)', 'W9a 判官裁决判定'],
    mustKill: ['规则文件不存在 → rule_changed(rule_absent)'],
  },
  {
    id: 'rule_unhashable_escapes',
    clause: 'R20-18.34 永不抛错',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        "    return invalid('rule_unhashable');",
        "    throw new Error('unhashable');",
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: ['规则文本无法哈希(无 frontmatter)', 'W9a 判官裁决判定'],
    mustKill: ['规则文本无法哈希(无 frontmatter)'],
  },
  {
    id: 'binding_spawned_wrong',
    clause: 'R20-18.32a spawned 幂等键 = 整条记录内容哈希',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        ': judgeRecordSha256(judge),',
        ": judge.rule_sha256 ?? '',",
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: ['binding_sha256:session 取', 'W9a 判官裁决判定'],
    mustKill: ['binding_sha256:session 取'],
  },
  {
    id: 'injection_not_preferred',
    clause: 'R20-18.35 injection 与 reject 同时成立取 injection',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        "verdict: judge.injection_suspected ? 'injection' : 'reject',",
        "verdict: judge.verdict === 'reject' ? 'reject' : 'injection',",
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: ['reject → reject;injection_suspected → injection', 'W9a 判官裁决判定'],
    mustKill: ['reject → reject;injection_suspected → injection'],
  },
  {
    id: 'accept_is_signal',
    clause: 'R20-18.32 accept / revise 零影响(收紧被反用)',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        "if (judge.injection_suspected || judge.verdict === 'reject') {",
        'if (true) {',
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: ['accept / revise(无 injection)→ not_tightening', 'W9a 判官裁决判定'],
    mustKill: ['accept / revise(无 injection)→ not_tightening'],
  },
  {
    id: 'injection_flag_ignored',
    clause: 'R20-18.34 ⑥ injection_suspected 单独成信号',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        "if (judge.injection_suspected || judge.verdict === 'reject') {",
        "if (judge.verdict === 'reject') {",
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: ['reject → reject;injection_suspected → injection', 'W9a 判官裁决判定'],
    mustKill: ['reject → reject;injection_suspected → injection'],
  },
  {
    id: 'seen_indeterminate_dropped',
    clause: 'W0-27 judge_seen.indeterminate',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        "indeterminate: s.kind === 'none' && s.growth === 'indeterminate',",
        'indeterminate: false,',
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: ['judgeResultCode / judgeSeenOf / growthBlockOf 的取值表', 'W9a 判官裁决判定'],
    mustKill: ['judgeResultCode / judgeSeenOf / growthBlockOf 的取值表'],
  },
  {
    id: 'growth_signal_not_blocking',
    clause: 'W0-27 有信号时增影响拒绝',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        "return s.kind === 'signal' ? 'signal' : s.growth;",
        "return s.kind === 'signal' ? null : s.growth;",
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: ['judgeResultCode / judgeSeenOf / growthBlockOf 的取值表', 'W9a 判官裁决判定'],
    mustKill: ['judgeResultCode / judgeSeenOf / growthBlockOf 的取值表'],
  },
  {
    id: 'taint_marker_ignored',
    clause: 'R20-18.34 ① TAINTED 的 run 不消费',
    edits: [
      swap(
        'src/rsi/personal/read/judge-source.ts',
        "        if (t.kind === 'ok') return 'excluded';\n",
        '',
      ),
    ],
    tests: ['rsi/personal/judge-source.test.ts'],
    expectRed: ['TAINTED 标记存在 → run_excluded', 'W9a 读适配器', '端口契约套件'],
    mustKill: ['TAINTED 标记存在 → run_excluded'],
  },
  {
    id: 'taint_unsafe_as_clean',
    clause: 'W0-27 标记读不出 = 读不出',
    edits: [
      swap(
        'src/rsi/personal/read/judge-source.ts',
        "        if (t.kind === 'unsafe') return bad(`taint_marker_${t.why}`);\n",
        '',
      ),
    ],
    tests: ['rsi/personal/judge-source.test.ts'],
    expectRed: ['TAINTED 标记存在 → run_excluded', 'W9a 读适配器', '端口契约套件'],
    mustKill: ['TAINTED 标记存在 → run_excluded'],
  },
  {
    id: 'attribution_error_as_consumable',
    clause: 'W0-27 归属读不出 = unreadable',
    edits: [
      swap(
        'src/rsi/personal/read/judge-source.ts',
        "return bad('attribution');",
        "return 'consumable';",
      ),
    ],
    tests: ['rsi/personal/judge-source.test.ts'],
    expectRed: ['归属现算:counts 里没有该 run', 'W9a 读适配器', '端口契约套件'],
    mustKill: ['归属现算:counts 里没有该 run'],
  },
  {
    id: 'attribution_not_applied',
    clause: 'R20-18.34 ① 归属按当前排除与索引现算',
    edits: [
      swap(
        'src/rsi/personal/read/judge-source.ts',
        "          ? 'consumable'\n          : 'excluded';",
        "          ? 'consumable'\n          : 'consumable';",
      ),
    ],
    tests: ['rsi/personal/judge-source.test.ts'],
    expectRed: ['归属现算:counts 里没有该 run', 'W9a 读适配器', '端口契约套件'],
    mustKill: ['归属现算:counts 里没有该 run'],
  },
  {
    id: 'run_missing_as_excluded',
    clause: 'R20-18.34 ① run 目录不存在 = run_gone',
    edits: [
      swap(
        'src/rsi/personal/read/judge-source.ts',
        "if (dRun.kind === 'missing') return { kind: 'run_gone' };",
        "if (dRun.kind === 'missing') return { kind: 'run_excluded' };",
      ),
    ],
    tests: ['rsi/personal/judge-source.test.ts'],
    expectRed: ['run 目录不存在 / reflect 目录不存在 → run_gone', 'W9a 读适配器', '端口契约套件'],
    mustKill: ['run 目录不存在 / reflect 目录不存在 → run_gone'],
  },
  {
    id: 'reflect_missing_as_excluded',
    clause: 'R20-18.34 ① reflect 目录不存在 = run_gone',
    edits: [
      swap(
        'src/rsi/personal/read/judge-source.ts',
        "if (dReflect.kind === 'missing') return { kind: 'run_gone' };",
        "if (dReflect.kind === 'missing') return { kind: 'run_excluded' };",
      ),
    ],
    tests: ['rsi/personal/judge-source.test.ts'],
    expectRed: ['run 目录不存在 / reflect 目录不存在 → run_gone', 'W9a 读适配器', '端口契约套件'],
    mustKill: ['run 目录不存在 / reflect 目录不存在 → run_gone'],
  },
  {
    id: 'run_dir_link_followed',
    clause: 'R20-18.34 ① 真实目录(不跟随符号链接)',
    edits: [
      swap(
        'src/rsi/personal/read/judge-source.ts',
        "      if (dRun.kind === 'unsafe') return bad(`run_dir_${dRun.why}`);\n",
        '',
      ),
    ],
    tests: ['rsi/personal/judge-source.test.ts'],
    expectRed: ['run 目录 / reflect 目录是符号链接 → unreadable', 'W9a 读适配器', '端口契约套件'],
    mustKill: ['run 目录 / reflect 目录是符号链接 → unreadable'],
  },
  {
    id: 'proposal_missing_as_invalid',
    clause: 'W0-27 采集中的 run 缺提案 = 读不出',
    edits: [
      swap(
        'src/rsi/personal/read/judge-source.ts',
        "if (pr.kind === 'missing') return bad('proposal_missing');",
        "if (pr.kind === 'missing') return { kind: 'invalid', why: 'proposal_missing' };",
      ),
    ],
    tests: ['rsi/personal/judge-source.test.ts'],
    expectRed: ['采集中的 run 里提案目录 / 文件缺失 → unreadable', 'W9a 读适配器', '端口契约套件'],
    mustKill: ['采集中的 run 里提案目录 / 文件缺失 → unreadable'],
  },
  {
    id: 'proposal_unsafe_ignored',
    clause: 'R20-18.34 ② 安全读取器(链接 / nlink)',
    edits: [
      swap(
        'src/rsi/personal/read/judge-source.ts',
        "      if (pr.kind === 'unsafe') return bad(`proposal_${pr.why}`);\n",
        '',
      ),
    ],
    tests: ['rsi/personal/judge-source.test.ts'],
    expectRed: ['提案是符号链接 / 硬链接', 'W9a 读适配器', '端口契约套件'],
    mustKill: ['提案是符号链接 / 硬链接'],
  },
  {
    id: 'max_bytes_widened',
    clause: 'R20-18.34 ② ≤ 64 KiB',
    edits: [
      swap(
        'src/rsi/personal/read/judge-source.ts',
        'export const JUDGE_SOURCE_MAX_BYTES = 64 * 1024;',
        'export const JUDGE_SOURCE_MAX_BYTES = 1024 * 1024;',
      ),
    ],
    tests: ['rsi/personal/judge-source.test.ts'],
    expectRed: ['64 KiB 上限', 'W9a 读适配器', '端口契约套件'],
    mustKill: ['64 KiB 上限'],
  },
  {
    id: 'proposal_id_shape_unchecked',
    clause: '路径穿越:proposal_id 形状',
    edits: [
      swap(
        'src/rsi/personal/read/judge-source.ts',
        "      if (!PROPOSAL_ID_RE.test(proposalId)) return bad('proposal_id_shape');\n",
        '',
      ),
    ],
    tests: ['rsi/personal/judge-source.test.ts'],
    expectRed: ['提案 id 形状不对(含 ../ 穿越)', 'W9a 读适配器', '端口契约套件'],
    mustKill: ['提案 id 形状不对(含 ../ 穿越)'],
  },
  {
    id: 'yaml_error_as_unreadable',
    clause: '内容类失败 = invalid',
    edits: [
      swap(
        'src/rsi/personal/read/judge-source.ts',
        "fail = { kind: 'invalid', why: 'yaml' };",
        "fail = bad('yaml');",
      ),
    ],
    tests: ['rsi/personal/judge-source.test.ts'],
    expectRed: ['YAML 无法解析 / 不是对象 → invalid', 'W9a 读适配器', '端口契约套件'],
    mustKill: ['YAML 无法解析 / 不是对象 → invalid'],
  },
  {
    id: 'rule_unsafe_ignored',
    clause: 'R20-18.34 ② 规则文件同样走安全读取器',
    edits: [
      swap(
        'src/rsi/personal/read/judge-source.ts',
        "          if (rr.kind === 'unsafe') return bad(`rule_${rr.why}`);\n",
        '',
      ),
    ],
    tests: ['rsi/personal/judge-source.test.ts'],
    expectRed: ['规则:文件不存在 / rules 目录不存在 → rule = null', 'W9a 读适配器', '端口契约套件'],
    mustKill: ['规则:文件不存在 / rules 目录不存在 → rule = null'],
  },
  {
    id: 'race_proposal_unchecked',
    clause: 'W0-27 一致性协议:提案身份重核',
    edits: [
      swap(
        'src/rsi/personal/read/judge-source.ts',
        '      if (!fileSame(propIdent, propNow)) return racy();\n',
        '',
      ),
    ],
    tests: ['rsi/personal/judge-source.test.ts'],
    expectRed: ['提案在读与核对之间被改写', '提案被换成另一个文件', 'W9a 读适配器', '端口契约套件'],
    mustKill: ['提案在读与核对之间被改写'],
  },
  {
    id: 'race_rule_unchecked',
    clause: 'W0-27 一致性协议:规则身份重核',
    edits: [
      swap(
        'src/rsi/personal/read/judge-source.ts',
        '        if (!fileSame(ruleIdent, ruleNow)) return racy();\n',
        '',
      ),
    ],
    tests: ['rsi/personal/judge-source.test.ts'],
    expectRed: ['规则被改写 / 规则被删 / 规则被新建', 'W9a 读适配器', '端口契约套件'],
    mustKill: ['规则被改写 / 规则被删 / 规则被新建'],
  },
  {
    id: 'race_run_dir_unchecked',
    clause: 'W0-27 一致性协议:run 目录身份重核',
    edits: [
      swap(
        'src/rsi/personal/read/judge-source.ts',
        '      if (!dirSame(dRun, await again(runDir), true)) return racy();\n',
        '',
      ),
    ],
    tests: ['rsi/personal/judge-source.test.ts'],
    expectRed: ['目录被整体换走、子项原样挪回', 'W9a 读适配器', '端口契约套件'],
    mustKill: ['目录被整体换走、子项原样挪回'],
  },
  {
    id: 'race_reflect_dir_unchecked',
    clause: 'W0-27 一致性协议:reflect 目录身份重核',
    edits: [
      swap(
        'src/rsi/personal/read/judge-source.ts',
        '      if (!dirSame(dReflect, await again(reflect), false)) return racy();\n',
        '',
      ),
    ],
    tests: ['rsi/personal/judge-source.test.ts'],
    expectRed: ['目录被整体换走、子项原样挪回', 'W9a 读适配器', '端口契约套件'],
    mustKill: ['目录被整体换走、子项原样挪回'],
  },
  {
    id: 'attribution_recheck_dropped',
    clause: 'W0-27 一致性协议:归属重做',
    edits: [
      swap(
        'src/rsi/personal/read/judge-source.ts',
        '      const second = await attribute();',
        "      const second = 'consumable' as const;",
      ),
    ],
    tests: ['rsi/personal/judge-source.test.ts'],
    expectRed: ['归属在读期间变化', 'W9a 读适配器', '端口契约套件'],
    mustKill: ['归属在读期间变化'],
  },
  {
    id: 'attribution_flip_ignored',
    clause: 'W0-27 读后归属变化 = race',
    edits: [
      swap(
        'src/rsi/personal/read/judge-source.ts',
        "if (second !== 'consumable') return second === 'excluded' ? racy() : second;",
        "if (second !== 'consumable' && second !== 'excluded') return second;",
      ),
    ],
    tests: ['rsi/personal/judge-source.test.ts'],
    expectRed: ['归属在读期间变化', 'W9a 读适配器', '端口契约套件'],
    mustKill: ['归属在读期间变化'],
  },
  {
    id: 'abort_ignored',
    clause: 'W0-27 2 秒预算:signal 已中止 → unreadable',
    edits: [
      swap(
        'src/rsi/personal/read/judge-source.ts',
        "      if (aborted()) return bad('timeout');\n      // ① 目录",
        '      // ① 目录',
      ),
      swap(
        'src/rsi/personal/read/judge-source.ts',
        "      await deps.seam?.afterReads?.();\n      if (aborted()) return bad('timeout');\n",
        '      await deps.seam?.afterReads?.();\n',
      ),
      swap(
        'src/rsi/personal/read/judge-source.ts',
        "      if (aborted()) return bad('timeout');\n\n      return fail ?? { kind: 'ok', proposal: value, rule };",
        "      return fail ?? { kind: 'ok', proposal: value, rule };",
      ),
    ],
    tests: ['rsi/personal/judge-source.test.ts'],
    expectRed: ['预算:signal 已中止', 'W9a 读适配器', '端口契约套件'],
    mustKill: ['预算:signal 已中止'],
  },
  {
    id: 'display_none_as_invalid',
    clause: 'R20-18.37 无裁决 = judge=none',
    edits: [
      swap(
        'src/rsi/auto/read/judge-verdict.ts',
        "if (v.kind === 'none') return { kind: v.display === 'none' ? 'absent' : 'invalid' };",
        "if (v.kind === 'none') return { kind: 'invalid' };",
      ),
    ],
    tests: ['rsi/auto/judge-verdict.test.ts'],
    expectRed: ['确实无裁决 → absent', 'W9a 展示端口'],
    mustKill: ['确实无裁决 → absent'],
  },
  {
    id: 'display_invalid_as_none',
    clause: 'R20-18.37 失败 = judge=invalid',
    edits: [
      swap(
        'src/rsi/auto/read/judge-verdict.ts',
        "if (v.kind === 'none') return { kind: v.display === 'none' ? 'absent' : 'invalid' };",
        "if (v.kind === 'none') return { kind: 'absent' };",
      ),
    ],
    tests: ['rsi/auto/judge-verdict.test.ts'],
    expectRed: ['读 / 解析 / 校验失败 → invalid', 'W9a 展示端口'],
    mustKill: ['读 / 解析 / 校验失败 → invalid'],
  },
  {
    id: 'display_proven_identity_lost',
    clause: 'R20-18.37 spawned 显示 vendor / model',
    edits: [
      swap(
        'src/rsi/auto/read/judge-verdict.ts',
        ": { kind: 'proven', vendor: side.vendor, model: side.model },",
        ": { kind: 'declared', agent: 'claude', vendor: side.vendor, model: side.model },",
      ),
    ],
    tests: ['rsi/auto/judge-verdict.test.ts'],
    expectRed: ['已校验的 spawned(proven)', 'W9a 展示端口'],
    mustKill: ['已校验的 spawned(proven)'],
  },
  {
    id: 'display_injection_flag_lost',
    clause: 'R20-18.37 injection 取值',
    edits: [
      swap(
        'src/rsi/auto/read/judge-verdict.ts',
        "injection: judge.injection_suspected ? 'true' : 'false',",
        "injection: 'false',",
      ),
    ],
    tests: ['rsi/auto/judge-verdict.test.ts'],
    expectRed: ['已校验的 session_confirmed:字段取契约值', 'W9a 展示端口'],
    mustKill: ['已校验的 session_confirmed:字段取契约值'],
  },
  {
    id: 'show_self_label_dropped',
    clause: 'R20-18.37 自报标记(SELF_REPORT_LABEL_JUDGE)',
    edits: [
      swap(
        'src/rsi/auto/read/show.ts',
        "{ head: id.kind === 'declared' ? SELF_REPORT_LABEL_JUDGE : VENDOR_PROVEN_LABEL },",
        '{ head: VENDOR_PROVEN_LABEL },',
      ),
    ],
    tests: ['rsi/auto/show.test.ts'],
    expectRed: [
      '自报记录带 SELF_REPORT_LABEL_JUDGE 而不带 VENDOR_PROVEN_LABEL',
      'N4-2 关联提案裁决段(失败只影响该段)',
    ],
    mustKill: ['自报记录带 SELF_REPORT_LABEL_JUDGE 而不带 VENDOR_PROVEN_LABEL'],
  },
  {
    id: 'show_proven_label_swapped',
    clause: 'R20-18.37 spawned 带 VENDOR_PROVEN_LABEL',
    edits: [
      swap(
        'src/rsi/auto/read/show.ts',
        "{ head: id.kind === 'declared' ? SELF_REPORT_LABEL_JUDGE : VENDOR_PROVEN_LABEL },",
        '{ head: SELF_REPORT_LABEL_JUDGE },',
      ),
    ],
    tests: ['rsi/auto/show.test.ts'],
    expectRed: [
      '自报记录带 SELF_REPORT_LABEL_JUDGE 而不带 VENDOR_PROVEN_LABEL',
      'N4-2 关联提案裁决段(失败只影响该段)',
    ],
    mustKill: ['自报记录带 SELF_REPORT_LABEL_JUDGE 而不带 VENDOR_PROVEN_LABEL'],
  },
  {
    id: 'show_unavailable_not_invalid',
    clause: 'R20-18.37 读不出显示 judge=invalid(不另造 unavailable)',
    edits: [
      swap(
        'src/rsi/auto/read/show.ts',
        "if (j.kind === 'invalid' || j.kind === 'unavailable') {",
        "if (j.kind === 'invalid') {",
      ),
    ],
    tests: ['rsi/auto/show.test.ts'],
    expectRed: [
      '裁决读取不可用 / 抛错 → 只有该段是 unavailable',
      'N4-2 关联提案裁决段(失败只影响该段)',
    ],
    mustKill: ['裁决读取不可用 / 抛错 → 只有该段是 unavailable'],
  },
  {
    id: 'show_declared_collapsed',
    clause: 'R20-18.37 declared = agent / vendor / model',
    edits: [
      swap(
        'src/rsi/auto/read/show.ts',
        '? { head: `declared agent=${f(id.agent)} vendor=${f(id.vendor)} model=${f(id.model)}` }',
        '? { head: `declared=${f(id.vendor)}` }',
      ),
    ],
    tests: ['rsi/auto/show.test.ts'],
    expectRed: [
      '有裁决记录 → 段内容带标签与清洗后的字段;自报记录带 declared',
      'N4-2 关联提案裁决段(失败只影响该段)',
    ],
    mustKill: ['有裁决记录 → 段内容带标签与清洗后的字段;自报记录带 declared'],
  },
  {
    id: 'show_none_text_old',
    clause: 'R20-18.37 judge=none 文案',
    edits: [
      swap(
        'src/rsi/auto/read/show.ts',
        "{ head: '关联提案裁决: judge=none' }",
        "{ head: '关联提案裁决: none' }",
      ),
    ],
    tests: ['rsi/auto/show.test.ts'],
    expectRed: [
      '裁决读取不可用 / 抛错 → 只有该段是 unavailable',
      'N4-2 关联提案裁决段(失败只影响该段)',
    ],
    mustKill: ['裁决读取不可用 / 抛错 → 只有该段是 unavailable'],
  },
  {
    id: 'show_judge_fields_unsanitized',
    clause: 'R20-18.37 控制字符清洗',
    edits: [
      swap(
        'src/rsi/auto/read/show.ts',
        'const f = (s: string): string => cleanName(s);',
        'const f = (s: string): string => s;',
      ),
    ],
    tests: ['rsi/auto/show.test.ts'],
    expectRed: [
      '有裁决记录 → 段内容带标签与清洗后的字段;自报记录带 declared',
      'N4-2 关联提案裁决段(失败只影响该段)',
    ],
    mustKill: ['有裁决记录 → 段内容带标签与清洗后的字段;自报记录带 declared'],
  },
  {
    id: 'closure_signal_imports_lifecycle',
    clause: 'R20-18.34 import 闭包:judge-signal 不 import src/lifecycle/**',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        "import { canonicalJson } from '../../io/canonical-json.js';",
        "import { canonicalJson } from '../../io/canonical-json.js';\nimport { ruleSha256 as ruleShaDirect } from '../../lifecycle/checks.js';\nvoid ruleShaDirect;",
      ),
    ],
    tests: ['rsi/personal/judge-closure.test.ts'],
    expectRed: ['judge-signal.ts:只有 contracts', 'W9a 闭包闸', 'W9a 零写入静态证据'],
    mustKill: ['judge-signal.ts:只有 contracts'],
  },
  {
    id: 'closure_source_imports_store',
    clause: 'R20-18.34 import 闭包:适配器不用 judge store 读写原语',
    edits: [
      swap(
        'src/rsi/personal/read/judge-source.ts',
        "import { parseRestrictedYaml } from '../../../atoms/frontmatter.js';",
        "import { parseRestrictedYaml } from '../../../atoms/frontmatter.js';\nimport { loadRunEntries as loadDirect } from '../../../judge/store.js';\nvoid loadDirect;",
      ),
    ],
    tests: ['rsi/personal/judge-closure.test.ts'],
    expectRed: ['judge-source.ts:闭包无写出口', 'W9a 闭包闸', 'W9a 零写入静态证据'],
    mustKill: ['judge-source.ts:闭包无写出口'],
  },
  {
    id: 'closure_rule_hash_imports_safe_fs',
    clause: 'W0-27 rule-hash.ts 闭包只有 canonical-text',
    edits: [
      swap(
        'src/lifecycle/rule-hash.ts',
        "import { createHash } from 'node:crypto';",
        "import { createHash } from 'node:crypto';\nimport { writeFile as writeDirect } from '../io/safe-fs.js';\nvoid writeDirect;",
      ),
    ],
    tests: ['rsi/personal/judge-closure.test.ts'],
    expectRed: ['rule-hash.ts:闭包恰为它自己', 'W9a 闭包闸', 'W9a 零写入静态证据'],
    mustKill: ['rule-hash.ts:闭包恰为它自己'],
  },
  {
    id: 'checks_reexport_dropped',
    clause: 'W0-27 checks.ts 再导出 ruleSha256(调用方路径不变)',
    edits: [
      swap(
        'src/lifecycle/checks.ts',
        'export { RuleHashError, ruleSha256 };',
        'export { RuleHashError };',
      ),
    ],
    tests: ['judge/rule-hash.test.ts'],
    expectRed: [
      'judge 成功后记录带 rule_sha256,且等于规则文件当前的 ruleSha256',
      'judge 记录里的 rule_sha256',
    ],
    mustKill: ['judge 成功后记录带 rule_sha256,且等于规则文件当前的 ruleSha256'],
  },
  {
    id: 'judge_seen_key_dropped',
    clause: 'W0-27 工作副本可选键 judge_seen',
    edits: [
      swap('src/contracts/rsi-personal.ts', '  judge_seen: JudgeSeenSchema.optional(),\n', ''),
    ],
    tests: ['contracts/w9a-judge-signal.test.ts'],
    expectRed: ['可选键:缺失合法(旧工作副本);带合法取值合法', 'W0-27 judge_seen', 'W0-27 订正正文'],
    mustKill: ['可选键:缺失合法(旧工作副本);带合法取值合法'],
  },
  {
    id: 'judge_seen_required',
    clause: 'W0-27 judge_seen 可选(旧工作副本合法)',
    edits: [
      swap(
        'src/contracts/rsi-personal.ts',
        'judge_seen: JudgeSeenSchema.optional(),',
        'judge_seen: JudgeSeenSchema,',
      ),
    ],
    tests: ['contracts/w9a-judge-signal.test.ts'],
    expectRed: ['可选键:缺失合法(旧工作副本);带合法取值合法', 'W0-27 judge_seen', 'W0-27 订正正文'],
    mustKill: ['可选键:缺失合法(旧工作副本);带合法取值合法'],
  },
  {
    id: 'judge_seen_binding_loose',
    clause: 'W0-27 judge_seen.binding = 完整 64 位小写十六进制',
    edits: [
      swap(
        'src/contracts/judge-signal.ts',
        'binding: Sha256Schema.nullable(),',
        'binding: z.string().nullable(),',
      ),
    ],
    tests: ['contracts/w9a-judge-signal.test.ts'],
    expectRed: ['负向:未知结果码', 'W0-27 judge_seen', 'W0-27 订正正文'],
    mustKill: ['负向:未知结果码'],
  },
  {
    id: 'judge_reasons_extended',
    clause: 'R20-18.34 忽略原因是封闭集合(不新增码)',
    edits: [
      swap(
        'src/contracts/judge-signal.ts',
        "  'not_tightening',\n] as const);\nexport type JudgeIgnoreReason",
        "  'not_tightening',\n  'judge_expired',\n] as const);\nexport type JudgeIgnoreReason",
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts', 'contracts/w9a-judge-signal.test.ts'],
    expectRed: [
      'JUDGE_IGNORE_REASONS 恰为契约的 8 个原因',
      'JudgeSeenSchema 的 result 恰为 8 个忽略原因',
      'W9a 判官裁决判定',
      'W0-27 judge_seen',
      'W0-27 订正正文',
    ],
    mustKill: ['JUDGE_IGNORE_REASONS 恰为契约的 8 个原因'],
  },
  {
    id: 'link_proposal_id_shape_unchecked',
    clause: 'W0-27 来源链接损坏(proposal_id 不是 YYYY-MM-DD-NNN)= 读不出,阻增影响',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        "typeof pid !== 'string' || !PROPOSAL_ID_RE.test(pid)",
        "typeof pid !== 'string' || pid.length < 1",
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: ['source_proposal 损坏(多键 / 非法 run_id', 'W9a 判官裁决判定'],
    mustKill: ['source_proposal 损坏(多键 / 非法 run_id'],
  },
  {
    id: 'port_envelope_proposal_unchecked',
    clause: 'W0-27 端口返回非法值 = unreadable(缺 proposal 的 ok 信封)',
    edits: [
      swap('src/rsi/personal/judge-signal.ts', "      if (!('proposal' in r)) return null;\n", ''),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: ['端口抛错 / 返回非法形状 → unreadable', 'W9a 判官裁决判定'],
    mustKill: ['端口抛错 / 返回非法形状 → unreadable'],
  },
  {
    id: 'port_envelope_why_unchecked',
    clause: 'W0-27 端口返回非法值 = unreadable(why 缺失 / 类型不对)',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        "return typeof r['why'] === 'string' ? { kind: r['kind'], why: r['why'] } : null;",
        "return { kind: r['kind'], why: String(r['why']) };",
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: ['端口抛错 / 返回非法形状 → unreadable', 'W9a 判官裁决判定'],
    mustKill: ['端口抛错 / 返回非法形状 → unreadable'],
  },
  {
    id: 'budget_clock_unchecked',
    clause: 'W0-27 2 秒预算:同步工作超预算的结论不予采信(整次评估的末尾核对)',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        '  if (elapsed(clock) > clock.budgetMs) {\n',
        '  if (elapsed(clock) > clock.budgetMs * 1e9) {\n',
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: [
      '同步工作占住事件循环、定时器来不及触发时',
      '端口立即返回,但同步的 ruleSha256 耗时超预算',
      'judgeEvidence 同步耗时超预算',
      'W9a 判官裁决判定',
    ],
    mustKill: [
      '同步工作占住事件循环、定时器来不及触发时',
      '端口立即返回,但同步的 ruleSha256 耗时超预算',
      'judgeEvidence 同步耗时超预算',
    ],
  },
  {
    id: 'budget_timeout_no_abort',
    clause: 'W0-27 2 秒预算:读后校验超时路径同时中止 controller',
    edits: [
      swap(
        'src/rsi/personal/judge-signal.ts',
        "    clock.ctl.abort();\n    return unreadable('timeout');\n  }\n  return v;",
        "    return unreadable('timeout');\n  }\n  return v;",
      ),
    ],
    tests: ['rsi/personal/judge-signal.test.ts'],
    expectRed: ['端口立即返回,但同步的 ruleSha256 耗时超预算', 'W9a 判官裁决判定'],
    mustKill: ['端口立即返回,但同步的 ruleSha256 耗时超预算'],
  },
  {
    id: 'recheck_hardlink_unchecked',
    clause: 'W0-27 末次回读:nlink = 1(读期间新增硬链接不改身份元数据)',
    edits: [
      swap(
        'src/rsi/personal/read/judge-source.ts',
        "  if (st.nlink !== 1) return 'hardlink';\n",
        "  if (st.nlink < 1) return 'hardlink';\n",
      ),
    ],
    tests: ['rsi/personal/judge-source.test.ts'],
    expectRed: [
      '读期间提案被硬链接到 run 目录树之外',
      '读期间规则被硬链接到 run 目录树之外',
      'recheckUnsafe 逐项',
      'W9a 读适配器',
    ],
    mustKill: [
      '读期间提案被硬链接到 run 目录树之外',
      '读期间规则被硬链接到 run 目录树之外',
      'recheckUnsafe 逐项',
    ],
  },
  {
    id: 'recheck_owner_unchecked',
    clause: 'W0-27 末次回读:属主 = 当前 uid(与首读 OWNER 策略相同)',
    edits: [
      swap(
        'src/rsi/personal/read/judge-source.ts',
        "  if (uid !== undefined && st.uid !== uid) return 'owner';\n",
        '',
      ),
    ],
    tests: ['rsi/personal/judge-source.test.ts'],
    expectRed: ['recheckUnsafe 逐项', 'W9a 读适配器'],
    mustKill: ['recheckUnsafe 逐项'],
  },
  {
    id: 'recheck_size_unchecked',
    clause: 'W0-27 末次回读:大小不超 64 KiB 上限',
    edits: [
      swap(
        'src/rsi/personal/read/judge-source.ts',
        "  if (st.size > maxBytes) return 'too_large';\n",
        '',
      ),
    ],
    tests: ['rsi/personal/judge-source.test.ts'],
    expectRed: ['recheckUnsafe 逐项', 'W9a 读适配器'],
    mustKill: ['recheckUnsafe 逐项'],
  },
  {
    id: 'recheck_regular_unchecked',
    clause: 'W0-27 末次回读:必须是普通文件',
    edits: [
      swap(
        'src/rsi/personal/read/judge-source.ts',
        "  if (!st.isFile()) return 'not_regular';\n",
        '',
      ),
    ],
    tests: ['rsi/personal/judge-source.test.ts'],
    expectRed: ['recheckUnsafe 逐项', 'W9a 读适配器'],
    mustKill: ['recheckUnsafe 逐项'],
  },
  {
    id: 'recheck_unsafe_ignored',
    clause: 'W0-27 末次回读:安全属性不合格 → unreadable(recheck_unsafe),不得当作「没变」',
    edits: [
      swap(
        'src/rsi/personal/read/judge-source.ts',
        "          if (recheckUnsafe(s, wantUid, JUDGE_SOURCE_MAX_BYTES) !== null) return 'unsafe';\n",
        '',
      ),
    ],
    tests: ['rsi/personal/judge-source.test.ts'],
    expectRed: [
      '读期间提案被硬链接到 run 目录树之外',
      '读期间规则被硬链接到 run 目录树之外',
      'W9a 读适配器',
    ],
    mustKill: ['读期间提案被硬链接到 run 目录树之外', '读期间规则被硬链接到 run 目录树之外'],
  },
  {
    id: 'recheck_unsafe_prop_branch_dropped',
    clause: 'W0-27 末次回读:提案的不安全结论映射成 recheck_unsafe(不折叠成 race)',
    edits: [
      swap(
        'src/rsi/personal/read/judge-source.ts',
        "      if (propNow === 'unsafe') return bad('recheck_unsafe');\n",
        '',
      ),
    ],
    tests: ['rsi/personal/judge-source.test.ts'],
    expectRed: ['读期间提案被硬链接到 run 目录树之外', 'W9a 读适配器'],
    mustKill: ['读期间提案被硬链接到 run 目录树之外'],
  },
  {
    id: 'recheck_unsafe_rule_branch_dropped',
    clause: 'W0-27 末次回读:规则的不安全结论映射成 recheck_unsafe(不折叠成 race)',
    edits: [
      swap(
        'src/rsi/personal/read/judge-source.ts',
        "        if (ruleNow === 'unsafe') return bad('recheck_unsafe');\n",
        '',
      ),
    ],
    tests: ['rsi/personal/judge-source.test.ts'],
    expectRed: ['读期间规则被硬链接到 run 目录树之外', 'W9a 读适配器'],
    mustKill: ['读期间规则被硬链接到 run 目录树之外'],
  },
  {
    id: 'run_id_shape_unchecked',
    clause: 'W0-27 来源链接损坏(run_id 路径穿越)在任何读取之前拒绝',
    edits: [
      swap(
        'src/rsi/personal/read/judge-source.ts',
        "      if (!RunIdSchema.safeParse(runId).success) return bad('run_id_shape');\n",
        '',
      ),
    ],
    tests: ['rsi/personal/judge-source.test.ts'],
    expectRed: ['提案 id 形状不对(含 ../ 穿越)', 'W9a 读适配器', '端口契约套件'],
    mustKill: ['提案 id 形状不对(含 ../ 穿越)'],
  },
  {
    id: 'invalid_content_skips_recheck',
    clause: 'W0-27 一致性协议:内容类失败路径同样读后核对',
    edits: [
      swap(
        'src/rsi/personal/read/judge-source.ts',
        "fail = { kind: 'invalid', why: 'yaml' };",
        "return { kind: 'invalid', why: 'yaml' };",
      ),
    ],
    tests: ['rsi/personal/judge-source.test.ts'],
    expectRed: ['内容类失败路径同样做读后核对', 'W9a 读适配器', '端口契约套件'],
    mustKill: ['内容类失败路径同样做读后核对'],
  },
  {
    id: 'recheck_io_as_missing',
    clause: 'W0-27 一致性协议:复核时 lstat 失败(非 ENOENT)= 读不出',
    edits: [
      swap(
        'src/rsi/personal/read/judge-source.ts',
        "return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'error';",
        'return null;',
      ),
    ],
    tests: ['rsi/personal/judge-source.test.ts'],
    expectRed: ['复核时文件 lstat 失败不是 ENOENT', 'W9a 读适配器', '端口契约套件'],
    mustKill: ['复核时文件 lstat 失败不是 ENOENT'],
  },
];

/** 结果(由主代理整表重跑后回填,必须与 `V1_W9A_MUTATIONS` 同序;实装块留空) */
/** 实测结果:r21w9a-mut-f4 @0374c97(dolphin):83 条全部被杀 */
export const V1_W9A_RESULTS: readonly V1W9AResult[] = [
  {
    id: 'nolink_not_blocked',
    failed: 2,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:来源与读失败的取值表 source_proposal 为 null / 缺失 → no_link:展示 none、增影响拒绝(no_source),且根本不读端口',
      'W9a 判官裁决判定:结果代码、judge_seen 与增影响输入 no_link 只在增影响一侧被拦(no_source),转移侧与「无裁决」同为 none',
    ],
    restored: true,
  },
  {
    id: 'link_corrupt_not_indeterminate',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:来源与读失败的取值表 source_proposal 损坏(多键 / 非法 run_id / 空 proposal_id / 非对象)→ invalid 但按读不出对待(indeterminate),不降级成无关联放行;端口不被调用',
    ],
    restored: true,
  },
  {
    id: 'unwired_as_no_verdict',
    failed: 2,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:来源与读失败的取值表 读端口未装配(null)→ unreadable / indeterminate(带 source_proposal 的候选不得增影响);绝不当作「无裁决」',
      'W9a 判官裁决判定:结果代码、judge_seen 与增影响输入 judgeResultCode / judgeSeenOf / growthBlockOf 的取值表;judgeSeenOf 的输出总能过 JudgeSeenSchema',
    ],
    restored: true,
  },
  {
    id: 'run_gone_not_blocking',
    failed: 2,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:来源与读失败的取值表 端口给出的分类原样映射:run_gone → none / source_gone;run_excluded → none / 不拦;unreadable → invalid / indeterminate;invalid → invalid / 不拦',
      'W9a 判官裁决判定:结果代码、judge_seen 与增影响输入 judgeResultCode / judgeSeenOf / growthBlockOf 的取值表;judgeSeenOf 的输出总能过 JudgeSeenSchema',
    ],
    restored: true,
  },
  {
    id: 'unreadable_not_indeterminate',
    failed: 7,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:来源与读失败的取值表 读端口未装配(null)→ unreadable / indeterminate(带 source_proposal 的候选不得增影响);绝不当作「无裁决」',
      'W9a 判官裁决判定:来源与读失败的取值表 端口抛错 / 返回非法形状 → unreadable(io / port_contract);永不向外抛',
      'W9a 判官裁决判定:来源与读失败的取值表 端口给出的分类原样映射:run_gone → none / source_gone;run_excluded → none / 不拦;unreadable → invalid / indeterminate;invalid → invalid / 不拦',
      'W9a 判官裁决判定:来源与读失败的取值表 读超时 → unreadable(timeout),signal 被中止;迟到的结果不产生未处理的拒绝',
      'W9a 判官裁决判定:墙钟预算覆盖读后校验(M1) 端口立即返回,但同步的 ruleSha256 耗时超预算(哈希仍正确)→ unreadable / timeout / indeterminate,controller 被中止;对照:不超时同输入 = not_tightening',
      'W9a 判官裁决判定:⑤ 规则文本与评审绑定 规则文本无法哈希(无 frontmatter)→ invalid(rule_unhashable),不抛;规则目标名与提案 targets[0] 不一致 → 端口违约(unreadable)',
      'W9a 判官裁决判定:结果代码、judge_seen 与增影响输入 judgeResultCode / judgeSeenOf / growthBlockOf 的取值表;judgeSeenOf 的输出总能过 JudgeSeenSchema',
    ],
    restored: true,
  },
  {
    id: 'port_throw_as_excluded',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:来源与读失败的取值表 端口抛错 / 返回非法形状 → unreadable(io / port_contract);永不向外抛',
    ],
    restored: true,
  },
  {
    id: 'port_shape_unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:来源与读失败的取值表 端口抛错 / 返回非法形状 → unreadable(io / port_contract);永不向外抛',
    ],
    restored: true,
  },
  {
    id: 'timeout_no_abort',
    failed: 2,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:来源与读失败的取值表 读超时 → unreadable(timeout),signal 被中止;迟到的结果不产生未处理的拒绝',
      'W9a 判官裁决判定:墙钟预算覆盖读后校验(M1) 端口立即返回,但同步的 ruleSha256 耗时超预算(哈希仍正确)→ unreadable / timeout / indeterminate,controller 被中止;对照:不超时同输入 = not_tightening',
    ],
    restored: true,
  },
  {
    id: 'timeout_as_no_verdict',
    failed: 4,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:来源与读失败的取值表 读超时 → unreadable(timeout),signal 被中止;迟到的结果不产生未处理的拒绝',
      'W9a 判官裁决判定:墙钟预算 同步工作占住事件循环、定时器来不及触发时,超预算的结论也不予采信(unreadable / timeout);预算内同一结果是信号',
      'W9a 判官裁决判定:墙钟预算覆盖读后校验(M1) 端口立即返回,但同步的 ruleSha256 耗时超预算(哈希仍正确)→ unreadable / timeout / indeterminate,controller 被中止;对照:不超时同输入 = not_tightening',
      'W9a 判官裁决判定:墙钟预算覆盖读后校验(M1) judgeEvidence 同步耗时超预算同样不采信(校验类结论也不能越过预算);对照:预算内 = 校验通过',
    ],
    restored: true,
  },
  {
    id: 'schema_failure_as_no_verdict',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:③ 提案校验 不过 ProposalSchema(多余键) → invalid(内容类:不阻增影响)',
    ],
    restored: true,
  },
  {
    id: 'layer_check_dropped',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:③ 提案校验 team 层提案的记录不被消费 → invalid(内容类:不阻增影响)',
    ],
    restored: true,
  },
  {
    id: 'id_check_dropped',
    failed: 1,
    skipped: 0,
    killedBy: ['W9a 判官裁决判定:③ 提案校验 id 不等于 proposal_id → invalid(内容类:不阻增影响)'],
    restored: true,
  },
  {
    id: 'run_id_check_dropped',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:③ 提案校验 reflector.run_id 不等于 run_id → invalid(内容类:不阻增影响)',
    ],
    restored: true,
  },
  {
    id: 'op_check_dropped',
    failed: 2,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:③ 提案校验 op 不是 add → invalid(内容类:不阻增影响)',
      'W9a 判官裁决判定:③ 提案校验 targets 不是单目标 → invalid(内容类:不阻增影响)',
    ],
    restored: true,
  },
  {
    id: 'evidence_check_skipped',
    failed: 4,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:④ 记录来源与校验 没有 judge 键 → not_verified,展示 none;校验失败才展示 invalid——两者信号侧同为 not_verified',
      'W9a 判官裁决判定:④ 记录来源与校验 session_confirmed 的 reject 记录:binding 被改 / 声明的厂商与模型对不上 → 不消费;有效时消费(正向对照)',
      'W9a 判官裁决判定:④ 记录来源与校验 spawned:非 proven(最后一跳槽位与 provider 不符 → JUDGE_* 码)不消费;proven 才消费(正向对照)',
      'W9a 判官裁决判定:④ 记录来源与校验 证据层级与 provenance 必须配对:注入函数给出错配层级(spawned 却 self_confirmed)→ 不消费',
    ],
    restored: true,
  },
  {
    id: 'evidence_issues_ignored',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:④ 记录来源与校验 证据层级与 provenance 必须配对:注入函数给出错配层级(spawned 却 self_confirmed)→ 不消费',
    ],
    restored: true,
  },
  {
    id: 'evidence_tier_ignored',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:④ 记录来源与校验 证据层级与 provenance 必须配对:注入函数给出错配层级(spawned 却 self_confirmed)→ 不消费',
    ],
    restored: true,
  },
  {
    id: 'evidence_throw_escapes',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:④ 记录来源与校验 evidence 注入函数抛错 → not_verified(不向外抛,不当作通过)',
    ],
    restored: true,
  },
  {
    id: 'judge_absent_shown_invalid',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:④ 记录来源与校验 没有 judge 键 → not_verified,展示 none;校验失败才展示 invalid——两者信号侧同为 not_verified',
    ],
    restored: true,
  },
  {
    id: 'validation_failed_shown_none',
    failed: 2,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:④ 记录来源与校验 没有 judge 键 → not_verified,展示 none;校验失败才展示 invalid——两者信号侧同为 not_verified',
      'W9a 判官裁决判定:④ 记录来源与校验 spawned:非 proven(最后一跳槽位与 provider 不符 → JUDGE_* 码)不消费;proven 才消费(正向对照)',
    ],
    restored: true,
  },
  {
    id: 'rule_unbound_passes',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:⑤ 规则文本与评审绑定 spawned 记录缺 rule_sha256(schema 里可选)不算 ⑤ 通过 → rule_changed;带上匹配的哈希则消费',
    ],
    restored: true,
  },
  {
    id: 'rule_hash_not_compared',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:⑤ 规则文本与评审绑定 规则文本被改(rule_sha256 不符)→ rule_changed,展示 invalid、不阻增影响;原文 → 信号(正向对照)',
    ],
    restored: true,
  },
  {
    id: 'rule_absent_as_no_verdict',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:⑤ 规则文本与评审绑定 规则文件不存在 → rule_changed(rule_absent);不是 unreadable',
    ],
    restored: true,
  },
  {
    id: 'rule_unhashable_escapes',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:⑤ 规则文本与评审绑定 规则文本无法哈希(无 frontmatter)→ invalid(rule_unhashable),不抛;规则目标名与提案 targets[0] 不一致 → 端口违约(unreadable)',
    ],
    restored: true,
  },
  {
    id: 'binding_spawned_wrong',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:⑥ 信号与二进制取值 binding_sha256:session 取 confirmation.binding_sha256;spawned 取解析后整条记录的规范 JSON 哈希,显式写与缺省写 provenance 一致',
    ],
    restored: true,
  },
  {
    id: 'injection_not_preferred',
    failed: 2,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:⑥ 信号与二进制取值 reject → reject;injection_suspected → injection;两者同时成立取 injection(accept + injection 也是 injection)',
      'W9a 判官裁决判定:结果代码、judge_seen 与增影响输入 judgeResultCode / judgeSeenOf / growthBlockOf 的取值表;judgeSeenOf 的输出总能过 JudgeSeenSchema',
    ],
    restored: true,
  },
  {
    id: 'accept_is_signal',
    failed: 3,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:墙钟预算覆盖读后校验(M1) 端口立即返回,但同步的 ruleSha256 耗时超预算(哈希仍正确)→ unreadable / timeout / indeterminate,controller 被中止;对照:不超时同输入 = not_tightening',
      'W9a 判官裁决判定:⑥ 信号与二进制取值 accept / revise(无 injection)→ not_tightening,零影响:展示按已校验显示,增影响不拦',
      'W9a 判官裁决判定:结果代码、judge_seen 与增影响输入 judgeResultCode / judgeSeenOf / growthBlockOf 的取值表;judgeSeenOf 的输出总能过 JudgeSeenSchema',
    ],
    restored: true,
  },
  {
    id: 'injection_flag_ignored',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:⑥ 信号与二进制取值 reject → reject;injection_suspected → injection;两者同时成立取 injection(accept + injection 也是 injection)',
    ],
    restored: true,
  },
  {
    id: 'seen_indeterminate_dropped',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:结果代码、judge_seen 与增影响输入 judgeResultCode / judgeSeenOf / growthBlockOf 的取值表;judgeSeenOf 的输出总能过 JudgeSeenSchema',
    ],
    restored: true,
  },
  {
    id: 'growth_signal_not_blocking',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:结果代码、judge_seen 与增影响输入 judgeResultCode / judgeSeenOf / growthBlockOf 的取值表;judgeSeenOf 的输出总能过 JudgeSeenSchema',
    ],
    restored: true,
  },
  {
    id: 'taint_marker_ignored',
    failed: 2,
    skipped: 0,
    killedBy: [
      'W9a 读适配器:归属(R20-18.34 ①) TAINTED 标记存在 → run_excluded;标记不安全(是目录 / 符号链接)→ unreadable(读不出标记不得当作没被污染);无标记 → 可读',
      '端口契约套件:生产适配器 run 不在 → run_gone;被 taint / 不在采集中 → run_excluded;二者都不会是 ok',
    ],
    restored: true,
  },
  {
    id: 'taint_unsafe_as_clean',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 读适配器:归属(R20-18.34 ①) TAINTED 标记存在 → run_excluded;标记不安全(是目录 / 符号链接)→ unreadable(读不出标记不得当作没被污染);无标记 → 可读',
    ],
    restored: true,
  },
  {
    id: 'attribution_error_as_consumable',
    failed: 2,
    skipped: 0,
    killedBy: [
      'W9a 读适配器:归属(R20-18.34 ①) 归属现算:counts 里没有该 run / 标 tainted / 证据有 X 或 U → run_excluded;全 P → 可读;归属读取抛错 → unreadable',
      'W9a 读适配器:一致性协议与预算(读期间被换 → unreadable,绝不降为无裁决) 归属在读期间变化(第二次判定不再是采集中 / 读不出)→ 不返回 ok:前者 race,后者 attribution',
    ],
    restored: true,
  },
  {
    id: 'attribution_not_applied',
    failed: 3,
    skipped: 0,
    killedBy: [
      'W9a 读适配器:归属(R20-18.34 ①) 归属现算:counts 里没有该 run / 标 tainted / 证据有 X 或 U → run_excluded;全 P → 可读;归属读取抛错 → unreadable',
      'W9a 读适配器:一致性协议与预算(读期间被换 → unreadable,绝不降为无裁决) 归属在读期间变化(第二次判定不再是采集中 / 读不出)→ 不返回 ok:前者 race,后者 attribution',
      '端口契约套件:生产适配器 run 不在 → run_gone;被 taint / 不在采集中 → run_excluded;二者都不会是 ok',
    ],
    restored: true,
  },
  {
    id: 'run_missing_as_excluded',
    failed: 3,
    skipped: 0,
    killedBy: [
      'W9a 读适配器:归属(R20-18.34 ①) run 目录不存在 / reflect 目录不存在 → run_gone(gc 之后);同名普通文件不是目录 → unreadable',
      '端口契约套件:生产适配器 run 不在 → run_gone;被 taint / 不在采集中 → run_excluded;二者都不会是 ok',
      '端口契约套件:生产适配器 同一份返回值经纯判定得到同一个结论(信号 / none 原因)',
    ],
    restored: true,
  },
  {
    id: 'reflect_missing_as_excluded',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 读适配器:归属(R20-18.34 ①) run 目录不存在 / reflect 目录不存在 → run_gone(gc 之后);同名普通文件不是目录 → unreadable',
    ],
    restored: true,
  },
  {
    id: 'run_dir_link_followed',
    failed: 2,
    skipped: 0,
    killedBy: [
      'W9a 读适配器:归属(R20-18.34 ①) run 目录不存在 / reflect 目录不存在 → run_gone(gc 之后);同名普通文件不是目录 → unreadable',
      'W9a 读适配器:归属(R20-18.34 ①) run 目录 / reflect 目录是符号链接 → unreadable(不跟随);对照:换回真实目录即可读',
    ],
    restored: true,
  },
  {
    id: 'proposal_missing_as_invalid',
    failed: 3,
    skipped: 0,
    killedBy: [
      'W9a 读适配器:安全读取与失败分类(R20-18.34 ②) 采集中的 run 里提案目录 / 文件缺失 → unreadable(无从判断是否曾有 reject),不是 invalid',
      '端口契约套件:生产适配器 采集中的 run 缺提案文件 → unreadable;YAML 损坏 → invalid(两类不得互换)',
      '端口契约套件:生产适配器 同一份返回值经纯判定得到同一个结论(信号 / none 原因)',
    ],
    restored: true,
  },
  {
    id: 'proposal_unsafe_ignored',
    failed: 2,
    skipped: 0,
    killedBy: [
      'W9a 读适配器:安全读取与失败分类(R20-18.34 ②) 提案是符号链接 / 硬链接(nlink > 1)→ unreadable;对照:普通文件可读',
      'W9a 读适配器:安全读取与失败分类(R20-18.34 ②) 64 KiB 上限:恰好 65536 字节可读,多 1 字节 → unreadable(too_large);规则文件同口径',
    ],
    restored: true,
  },
  {
    id: 'max_bytes_widened',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 读适配器:安全读取与失败分类(R20-18.34 ②) 64 KiB 上限:恰好 65536 字节可读,多 1 字节 → unreadable(too_large);规则文件同口径',
    ],
    restored: true,
  },
  {
    id: 'proposal_id_shape_unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 读适配器:安全读取与失败分类(R20-18.34 ②) YAML 无法解析 / 不是对象 → invalid(内容类);提案 id 形状不对(含 ../ 穿越)→ unreadable(来源链接损坏),在任何读取之前拒绝(归属没被调用)',
    ],
    restored: true,
  },
  {
    id: 'yaml_error_as_unreadable',
    failed: 3,
    skipped: 0,
    killedBy: [
      'W9a 读适配器:安全读取与失败分类(R20-18.34 ②) YAML 无法解析 / 不是对象 → invalid(内容类);提案 id 形状不对(含 ../ 穿越)→ unreadable(来源链接损坏),在任何读取之前拒绝(归属没被调用)',
      'W9a 读适配器:一致性协议与预算(读期间被换 → unreadable,绝不降为无裁决) 内容类失败路径同样做读后核对:坏 YAML / 非对象在读期间被换 → race(不是稳定的 invalid);不换仍是 invalid(正向对照)',
      '端口契约套件:生产适配器 采集中的 run 缺提案文件 → unreadable;YAML 损坏 → invalid(两类不得互换)',
    ],
    restored: true,
  },
  {
    id: 'rule_unsafe_ignored',
    failed: 2,
    skipped: 0,
    killedBy: [
      'W9a 读适配器:安全读取与失败分类(R20-18.34 ②) 64 KiB 上限:恰好 65536 字节可读,多 1 字节 → unreadable(too_large);规则文件同口径',
      'W9a 读适配器:安全读取与失败分类(R20-18.34 ②) 规则:文件不存在 / rules 目录不存在 → rule = null(由 ⑤ 判 rule_changed);规则是链接 / rules 目录是链接 → unreadable',
    ],
    restored: true,
  },
  {
    id: 'race_proposal_unchecked',
    failed: 3,
    skipped: 0,
    killedBy: [
      'W9a 读适配器:一致性协议与预算(读期间被换 → unreadable,绝不降为无裁决) 提案在读与核对之间被改写(同路径、内容不同)→ race',
      'W9a 读适配器:一致性协议与预算(读期间被换 → unreadable,绝不降为无裁决) 内容类失败路径同样做读后核对:坏 YAML / 非对象在读期间被换 → race(不是稳定的 invalid);不换仍是 invalid(正向对照)',
      'W9a 读适配器:一致性协议与预算(读期间被换 → unreadable,绝不降为无裁决) 经纯判定:读期间被换 → none / unreadable / indeterminate(增影响拒绝),不是 not_verified 也不是信号',
    ],
    restored: true,
  },
  {
    id: 'race_rule_unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 读适配器:一致性协议与预算(读期间被换 → unreadable,绝不降为无裁决) 规则被改写 / 规则被删 / 规则被新建(读时不存在)→ race',
    ],
    restored: true,
  },
  {
    id: 'race_run_dir_unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 读适配器:一致性协议与预算(读期间被换 → unreadable,绝不降为无裁决) 目录被整体换走、子项原样挪回(子项身份不变)→ race:只有目录自身的身份核对能发现(run 目录 / reflect 目录各一)',
    ],
    restored: true,
  },
  {
    id: 'race_reflect_dir_unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 读适配器:一致性协议与预算(读期间被换 → unreadable,绝不降为无裁决) 目录被整体换走、子项原样挪回(子项身份不变)→ race:只有目录自身的身份核对能发现(run 目录 / reflect 目录各一)',
    ],
    restored: true,
  },
  {
    id: 'attribution_recheck_dropped',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 读适配器:一致性协议与预算(读期间被换 → unreadable,绝不降为无裁决) 归属在读期间变化(第二次判定不再是采集中 / 读不出)→ 不返回 ok:前者 race,后者 attribution',
    ],
    restored: true,
  },
  {
    id: 'attribution_flip_ignored',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 读适配器:一致性协议与预算(读期间被换 → unreadable,绝不降为无裁决) 归属在读期间变化(第二次判定不再是采集中 / 读不出)→ 不返回 ok:前者 race,后者 attribution',
    ],
    restored: true,
  },
  {
    id: 'abort_ignored',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 读适配器:一致性协议与预算(读期间被换 → unreadable,绝不降为无裁决) 预算:signal 已中止 → unreadable(timeout),且不读文件;读完后才中止同样 timeout',
    ],
    restored: true,
  },
  {
    id: 'display_none_as_invalid',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 展示端口:取值映射 确实无裁决 → absent:无 judge 键、run_gone、run_excluded(不暴露原因)',
    ],
    restored: true,
  },
  {
    id: 'display_invalid_as_none',
    failed: 2,
    skipped: 0,
    killedBy: [
      'W9a 展示端口:取值映射 读 / 解析 / 校验失败 → invalid:unreadable、内容 invalid、校验失败、rule_changed、规则缺失、未装配;端口抛错也是 invalid',
      'W9a 展示端口:取值映射 已校验的 spawned(proven):identity 是 proven 的 vendor / model,没有 declared',
    ],
    restored: true,
  },
  {
    id: 'display_proven_identity_lost',
    failed: 2,
    skipped: 0,
    killedBy: [
      'W9a 展示端口:取值映射 已校验的 spawned(proven):identity 是 proven 的 vendor / model,没有 declared',
      'W9a 展示端口:provenance 与身份标签在类型层关联(L1) spawned ↔ proven、session_confirmed ↔ declared 不可拆开(编译期:矛盾组合必须报错;运行期:映射出的两种分支标签一致)',
    ],
    restored: true,
  },
  {
    id: 'display_injection_flag_lost',
    failed: 2,
    skipped: 0,
    killedBy: [
      'W9a 展示端口:取值映射 已校验的 session_confirmed:字段取契约值,declared 是 agent / vendor / model 三项;accept 也显示(⑥ 不适用于展示)',
      'W9a 展示端口:取值映射 展示与消费同判:对每个输入,展示为 ok ⇔ 消费侧 ①–⑤ 通过;展示 ok 且 reject / injection ⇔ 消费侧是信号',
    ],
    restored: true,
  },
  {
    id: 'show_self_label_dropped',
    failed: 1,
    skipped: 0,
    killedBy: [
      'N4-2 关联提案裁决段(失败只影响该段) 自报记录带 SELF_REPORT_LABEL_JUDGE 而不带 VENDOR_PROVEN_LABEL;spawned 且 proven 反之,只显示 vendor / model(没有 declared)',
    ],
    restored: true,
  },
  {
    id: 'show_proven_label_swapped',
    failed: 1,
    skipped: 0,
    killedBy: [
      'N4-2 关联提案裁决段(失败只影响该段) 自报记录带 SELF_REPORT_LABEL_JUDGE 而不带 VENDOR_PROVEN_LABEL;spawned 且 proven 反之,只显示 vendor / model(没有 declared)',
    ],
    restored: true,
  },
  {
    id: 'show_unavailable_not_invalid',
    failed: 1,
    skipped: 0,
    killedBy: [
      'N4-2 关联提案裁决段(失败只影响该段) 裁决读取不可用 / 抛错 → 只有该段是 unavailable,其余输出与退出码不变',
    ],
    restored: true,
  },
  {
    id: 'show_declared_collapsed',
    failed: 1,
    skipped: 0,
    killedBy: [
      'N4-2 关联提案裁决段(失败只影响该段) 有裁决记录 → 段内容带标签与清洗后的字段;自报记录带 declared',
    ],
    restored: true,
  },
  {
    id: 'show_none_text_old',
    failed: 1,
    skipped: 0,
    killedBy: [
      'N4-2 关联提案裁决段(失败只影响该段) 裁决读取不可用 / 抛错 → 只有该段是 unavailable,其余输出与退出码不变',
    ],
    restored: true,
  },
  {
    id: 'show_judge_fields_unsanitized',
    failed: 1,
    skipped: 0,
    killedBy: [
      'N4-2 关联提案裁决段(失败只影响该段) 有裁决记录 → 段内容带标签与清洗后的字段;自报记录带 declared',
    ],
    restored: true,
  },
  {
    id: 'closure_signal_imports_lifecycle',
    failed: 7,
    skipped: 0,
    killedBy: [
      'W9a 闭包闸(运行时依赖) judge-signal.ts:只有 contracts / canonical-json 与 node:crypto、zod;没有任何禁用文件,没有 src/lifecycle,没有动态 import',
      'W9a 闭包闸(运行时依赖) judge-verdict.ts(展示映射):同样没有禁用文件;闭包含 judge-signal(展示与消费同一份判定)',
      'W9a 闭包闸(含类型依赖) judge-signal.ts:只有 contracts / canonical-json 与 node:crypto、zod;没有任何禁用文件,没有 src/lifecycle,没有动态 import',
      'W9a 闭包闸(含类型依赖) judge-source.ts:闭包无写出口 / 锁 / 子进程 / judge store / lifecycle;node:fs 只被 read-fs 引入;外部模块只有 node:*、zod、yaml',
      'W9a 闭包闸(含类型依赖) judge-verdict.ts(展示映射):同样没有禁用文件;闭包含 judge-signal(展示与消费同一份判定)',
      'W9a 闭包闸:负向对照(往真实入口加一条禁用 import,检查必须红) judge-signal.ts / judge-source.ts:每种禁用 import 都让闭包检查变红',
      'W9a 闭包闸:负向对照(往真实入口加一条禁用 import,检查必须红) 动态 import / require 绕过也被看见',
    ],
    restored: true,
  },
  {
    id: 'closure_source_imports_store',
    failed: 3,
    skipped: 0,
    killedBy: [
      'W9a 闭包闸(运行时依赖) judge-source.ts:闭包无写出口 / 锁 / 子进程 / judge store / lifecycle;node:fs 只被 read-fs 引入;外部模块只有 node:*、zod、yaml',
      'W9a 闭包闸(含类型依赖) judge-source.ts:闭包无写出口 / 锁 / 子进程 / judge store / lifecycle;node:fs 只被 read-fs 引入;外部模块只有 node:*、zod、yaml',
      'W9a 闭包闸:负向对照(往真实入口加一条禁用 import,检查必须红) judge-signal.ts / judge-source.ts:每种禁用 import 都让闭包检查变红',
    ],
    restored: true,
  },
  {
    id: 'closure_rule_hash_imports_safe_fs',
    failed: 2,
    skipped: 0,
    killedBy: [
      'W9a 闭包闸(运行时依赖) rule-hash.ts:闭包恰为它自己、canonical-text 与 node:crypto;checks.ts 再导出同名符号(对照:checks.ts 的闭包含 safe-fs 写出口)',
      'W9a 闭包闸(含类型依赖) rule-hash.ts:闭包恰为它自己、canonical-text 与 node:crypto;checks.ts 再导出同名符号(对照:checks.ts 的闭包含 safe-fs 写出口)',
    ],
    restored: true,
  },
  {
    id: 'checks_reexport_dropped',
    failed: 1,
    skipped: 0,
    killedBy: [
      'judge 记录里的 rule_sha256 judge 成功后记录带 rule_sha256,且等于规则文件当前的 ruleSha256(正向对照:改一个字就对不上)',
    ],
    restored: true,
  },
  {
    id: 'judge_seen_key_dropped',
    failed: 1,
    skipped: 0,
    killedBy: ['W0-27 judge_seen(订正 R21-3.8) 可选键:缺失合法(旧工作副本);带合法取值合法'],
    restored: true,
  },
  {
    id: 'judge_seen_required',
    failed: 2,
    skipped: 0,
    killedBy: [
      'W0-27 judge_seen(订正 R21-3.8) 可选键:缺失合法(旧工作副本);带合法取值合法',
      'W0-27 judge_seen(订正 R21-3.8) 负向:未知结果码 / binding 不是 64 位小写十六进制 / 缺键 / 多键 / indeterminate 非布尔 / judge_seen 为 null → 工作副本不合规',
    ],
    restored: true,
  },
  {
    id: 'judge_seen_binding_loose',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W0-27 judge_seen(订正 R21-3.8) 负向:未知结果码 / binding 不是 64 位小写十六进制 / 缺键 / 多键 / indeterminate 非布尔 / judge_seen 为 null → 工作副本不合规',
    ],
    restored: true,
  },
  {
    id: 'judge_reasons_extended',
    failed: 4,
    skipped: 0,
    killedBy: [
      'W0-27 judge_seen(订正 R21-3.8) 负向:未知结果码 / binding 不是 64 位小写十六进制 / 缺键 / 多键 / indeterminate 非布尔 / judge_seen 为 null → 工作副本不合规',
      'W0-27 judge_seen(订正 R21-3.8) JudgeSeenSchema 的 result 恰为 8 个忽略原因 + judge_reject / judge_injection',
      'W0-27 订正正文 W0-27 正文写明:读不出与三种来源缺失拒绝增影响、内容类不阻、judge_seen 不参与安全判定、ruleSha256 搬到 rule-hash.ts、未接线',
      'W9a 判官裁决判定:结果代码、judge_seen 与增影响输入 JUDGE_IGNORE_REASONS 恰为契约的 8 个原因(不新增码)',
    ],
    restored: true,
  },
  {
    id: 'link_proposal_id_shape_unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:来源与读失败的取值表 source_proposal 损坏(多键 / 非法 run_id / 空 proposal_id / 非对象)→ invalid 但按读不出对待(indeterminate),不降级成无关联放行;端口不被调用',
    ],
    restored: true,
  },
  {
    id: 'port_envelope_proposal_unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:来源与读失败的取值表 端口抛错 / 返回非法形状 → unreadable(io / port_contract);永不向外抛',
    ],
    restored: true,
  },
  {
    id: 'port_envelope_why_unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:来源与读失败的取值表 端口抛错 / 返回非法形状 → unreadable(io / port_contract);永不向外抛',
    ],
    restored: true,
  },
  {
    id: 'budget_clock_unchecked',
    failed: 3,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:墙钟预算 同步工作占住事件循环、定时器来不及触发时,超预算的结论也不予采信(unreadable / timeout);预算内同一结果是信号',
      'W9a 判官裁决判定:墙钟预算覆盖读后校验(M1) 端口立即返回,但同步的 ruleSha256 耗时超预算(哈希仍正确)→ unreadable / timeout / indeterminate,controller 被中止;对照:不超时同输入 = not_tightening',
      'W9a 判官裁决判定:墙钟预算覆盖读后校验(M1) judgeEvidence 同步耗时超预算同样不采信(校验类结论也不能越过预算);对照:预算内 = 校验通过',
    ],
    restored: true,
  },
  {
    id: 'budget_timeout_no_abort',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 判官裁决判定:墙钟预算覆盖读后校验(M1) 端口立即返回,但同步的 ruleSha256 耗时超预算(哈希仍正确)→ unreadable / timeout / indeterminate,controller 被中止;对照:不超时同输入 = not_tightening',
    ],
    restored: true,
  },
  {
    id: 'recheck_hardlink_unchecked',
    failed: 3,
    skipped: 0,
    killedBy: [
      'W9a 读适配器:末次回读的安全属性(M2) 读期间提案被硬链接到 run 目录树之外(身份 / 内容元数据不变)→ unreadable(recheck_unsafe);对照:不动 = ok',
      'W9a 读适配器:末次回读的安全属性(M2) 读期间规则被硬链接到 run 目录树之外 → unreadable(recheck_unsafe);对照:不动 = ok',
      'W9a 读适配器:末次回读的安全属性(M2) recheckUnsafe 逐项(假 stat):普通文件、nlink = 1、属主、大小上限各一条负向,边界与对照合格',
    ],
    restored: true,
  },
  {
    id: 'recheck_owner_unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 读适配器:末次回读的安全属性(M2) recheckUnsafe 逐项(假 stat):普通文件、nlink = 1、属主、大小上限各一条负向,边界与对照合格',
    ],
    restored: true,
  },
  {
    id: 'recheck_size_unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 读适配器:末次回读的安全属性(M2) recheckUnsafe 逐项(假 stat):普通文件、nlink = 1、属主、大小上限各一条负向,边界与对照合格',
    ],
    restored: true,
  },
  {
    id: 'recheck_regular_unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 读适配器:末次回读的安全属性(M2) recheckUnsafe 逐项(假 stat):普通文件、nlink = 1、属主、大小上限各一条负向,边界与对照合格',
    ],
    restored: true,
  },
  {
    id: 'recheck_unsafe_ignored',
    failed: 2,
    skipped: 0,
    killedBy: [
      'W9a 读适配器:末次回读的安全属性(M2) 读期间提案被硬链接到 run 目录树之外(身份 / 内容元数据不变)→ unreadable(recheck_unsafe);对照:不动 = ok',
      'W9a 读适配器:末次回读的安全属性(M2) 读期间规则被硬链接到 run 目录树之外 → unreadable(recheck_unsafe);对照:不动 = ok',
    ],
    restored: true,
  },
  {
    id: 'recheck_unsafe_prop_branch_dropped',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 读适配器:末次回读的安全属性(M2) 读期间提案被硬链接到 run 目录树之外(身份 / 内容元数据不变)→ unreadable(recheck_unsafe);对照:不动 = ok',
    ],
    restored: true,
  },
  {
    id: 'recheck_unsafe_rule_branch_dropped',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 读适配器:末次回读的安全属性(M2) 读期间规则被硬链接到 run 目录树之外 → unreadable(recheck_unsafe);对照:不动 = ok',
    ],
    restored: true,
  },
  {
    id: 'run_id_shape_unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 读适配器:安全读取与失败分类(R20-18.34 ②) YAML 无法解析 / 不是对象 → invalid(内容类);提案 id 形状不对(含 ../ 穿越)→ unreadable(来源链接损坏),在任何读取之前拒绝(归属没被调用)',
    ],
    restored: true,
  },
  {
    id: 'invalid_content_skips_recheck',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 读适配器:一致性协议与预算(读期间被换 → unreadable,绝不降为无裁决) 内容类失败路径同样做读后核对:坏 YAML / 非对象在读期间被换 → race(不是稳定的 invalid);不换仍是 invalid(正向对照)',
    ],
    restored: true,
  },
  {
    id: 'recheck_io_as_missing',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W9a 读适配器:一致性协议与预算(读期间被换 → unreadable,绝不降为无裁决) 复核时文件 lstat 失败不是 ENOENT(EACCES)→ unreadable(recheck_io),不折叠成「没变」;规则确实缺失时仍是 rule = null(正向对照)',
    ],
    restored: true,
  },
];
