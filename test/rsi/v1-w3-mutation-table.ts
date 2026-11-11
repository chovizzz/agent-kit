/**
 * §21 V1 W3 必杀变异(契约 §21.24 W0-13 的 M13-1 / 2 / 4 / 5 / 6 / 7 标 W3 的行、R21-5.1 / 5.2 / 1.5、W0-6、R21-3.8、R21-9.5 V1a 部分;
 * 每条新不变量一个变异锚点)。执行方式同 W0 / W2:验证机私有检出里 cp 备份 → 按锚点替换(每个锚点在对应文件里**恰好出现一次**)→ 跑 `tests` →
 * 失败集合非空、全部命中 `expectRed`、`mustKill` 每项至少命中一个、没有 skipped → cp 还原并逐文件 sha256 核对。**不用 git checkout / stash 还原**。
 * 本文件只写表与每条变异期望红的测试名(`expectRed` 是杀手测试名里的字面子串);变异由主代理执行,结果记进 `V1_W3_RESULTS`(W3 实装块不执行变异,故留空)。
 * 条款以 `M13-<n>` 开头的行供 W10b 按 ID 对账(每个 ID 至少一条变异、一条标题含该 ID 的负向用例)。
 */
export interface Edit {
  file: string;
  anchor: string;
  replacement: string;
}

export interface V1W3Mutation {
  id: string;
  /** 契约变异点原文(或该不变量) */
  clause: string;
  edits: readonly Edit[];
  /** 相对 `test/` */
  tests: readonly string[];
  expectRed: readonly string[];
  mustKill: readonly string[];
}

export interface V1W3Result {
  id: string;
  failed: number;
  skipped: number;
  killedBy: readonly string[];
  restored: boolean;
}

const P = 'src/rsi/personal/';
const STEP = `${P}candidate-step.ts`;
const APPLY = `${P}candidate-apply.ts`;
const GATES = `${P}gates.ts`;
const SOURCE = `${P}candidate-source.ts`;
const RECORD = `${P}candidate-record.ts`;
const REPO = `${P}candidate-repo.ts`;
const TABLE = `${P}transition-table.ts`;
const TRANS = `${P}transition.ts`;

const T_STEP = 'rsi/personal/w3-step.test.ts';
const T_GATES = 'rsi/personal/w3-gates.test.ts';
const T_SRC = 'rsi/personal/w3-source.test.ts';
const T_REPO = 'rsi/personal/w3-repo.test.ts';
const T_RECON = 'rsi/personal/w3-reconcile-event.test.ts';

const off = (file: string, anchor: string): Edit => ({ file, anchor, replacement: 'void 0;' });

export const V1_W3_MUTATIONS: readonly V1W3Mutation[] = [
  // ---- M13-1 前置任一不成立不推进 ----
  {
    id: 'm13-1-facts-forced-true',
    clause: 'M13-1:逐个删去该项检查(配置 / enabled / 授权 / taint 事实被强制为成立)',
    edits: [
      {
        file: STEP,
        anchor: 'const facts = { ...pf, slot_occupied: evaluationSlotOccupied(others) };',
        replacement:
          'const facts = { ...pf, config_valid: true, enabled: true, authorized: true, tainted: false, slot_occupied: evaluationSlotOccupied(others) };',
      },
      {
        file: STEP,
        anchor: '...pf2,',
        replacement: '...pf2, config_valid: true, enabled: true, authorized: true, tainted: false,',
      },
    ],
    tests: [T_STEP],
    expectRed: ['M13-1 前置不成立不推进'],
    mustKill: ['M13-1 前置不成立不推进'],
  },
  {
    id: 'm13-1-auto-loop-ctx-true',
    clause: 'M13-1 / R21-2.2:自动循环无效或暂停仍推进(两处上下文都被强制为有效)',
    edits: [
      {
        file: STEP,
        anchor: 'auto_loop_effective: env.autoLoopEffective,',
        replacement: 'auto_loop_effective: true,',
      },
      { file: STEP, anchor: 'auto_paused: env.autoPaused,', replacement: 'auto_paused: false,' },
      {
        file: APPLY,
        anchor: 'auto_loop_effective: env.autoLoopEffective,',
        replacement: 'auto_loop_effective: true,',
      },
      { file: APPLY, anchor: 'auto_paused: env.autoPaused,', replacement: 'auto_paused: false,' },
    ],
    tests: [T_STEP],
    expectRed: ['M13-1 自动循环无效 / 暂停:不推进'],
    mustKill: ['M13-1 自动循环无效 / 暂停:不推进'],
  },
  // ---- M13-2 权威终态重读 ----
  {
    id: 'm13-2-authoritative-reread-removed',
    clause: 'M13-2:删去权威终态重读(旧副本仍是 shadow 就推进)',
    edits: [
      {
        file: APPLY,
        anchor: 'authoritative_lifecycle: fresh.record.lifecycle,',
        replacement: 'authoritative_lifecycle: rec.lifecycle,',
      },
      {
        file: APPLY,
        anchor: 'if (fresh.record.lifecycle !== rec.lifecycle) {',
        replacement: 'if (false as boolean) {',
      },
      {
        file: APPLY,
        anchor: 'if (canonicalJson(fresh.record) !== canonicalJson(rec)) {',
        replacement: 'if (false as boolean) {',
      },
    ],
    tests: [T_STEP],
    expectRed: ['M13-2 权威记录在列出之后已是终态'],
    mustKill: ['M13-2 权威记录在列出之后已是终态'],
  },
  // ---- M13-4 全局名额互斥 ----
  {
    id: 'm13-4-slot-check-removed',
    clause: 'M13-4:名额检查去掉(两处)',
    edits: [
      {
        file: STEP,
        anchor: 'slot_occupied: evaluationSlotOccupied(others) }',
        replacement: 'slot_occupied: false }',
      },
      {
        file: STEP,
        anchor: 'slot_occupied: evaluationSlotOccupied(fresh.filter((o) => o.id !== frec.id))',
        replacement: 'slot_occupied: false',
      },
    ],
    tests: [T_STEP],
    expectRed: ['M13-4 全局名额:已有 canary 占用时 shadow 不推进'],
    mustKill: ['M13-4 全局名额:已有 canary 占用时 shadow 不推进'],
  },
  {
    id: 'm13-4-slot-check-outside-final-reread',
    clause: 'M13-4:名额检查移到锁外(推进前不在锁内重判:只用锁外的判定)',
    edits: [
      {
        file: STEP,
        anchor: 'slot_occupied: evaluationSlotOccupied(fresh.filter((o) => o.id !== frec.id))',
        replacement: 'slot_occupied: false',
      },
      {
        file: STEP,
        anchor: '(wc.shadow.queued_since ?? today)',
        replacement: 'wc.shadow.queued_since',
      },
    ],
    tests: [T_STEP],
    expectRed: ['M13-4 两个候选同时具备资格'],
    mustKill: ['M13-4 两个候选同时具备资格'],
  },
  // ---- M13-5 排队只数 G7 等待 / 入口清零 ----
  {
    id: 'm13-5-entry-reset-removed',
    clause: 'M13-5:去掉入口清零',
    edits: [
      {
        file: STEP,
        anchor: 'if (entryReset(await d.marks.read(), cur)) {',
        replacement: 'if (false as boolean) {',
      },
    ],
    tests: [T_STEP],
    expectRed: ['M13-5 pause 之后第一个持锁步清空 queued_since', '撤销凭据数量增加也是入口事件'],
    mustKill: ['M13-5 pause 之后第一个持锁步清空 queued_since'],
  },
  {
    id: 'm13-5-entry-reset-pause-dropped',
    clause: 'M13-5:入口事件之一(pause / resume)不触发清零',
    edits: [{ file: STEP, anchor: 'prev.paused !== cur.paused ||', replacement: '' }],
    tests: [T_STEP],
    expectRed: ['entryReset:各入口事件各自成立'],
    mustKill: ['entryReset:各入口事件各自成立'],
  },
  {
    id: 'm13-5-entry-reset-first-run-skipped',
    clause: 'M13-5:无标记(首次)不清零',
    edits: [
      {
        file: STEP,
        anchor: 'if (prev === null) return true;',
        replacement: 'if (prev === null) return false;',
      },
    ],
    tests: [T_STEP],
    expectRed: ['entryReset:各入口事件各自成立'],
    mustKill: ['entryReset:各入口事件各自成立'],
  },
  // ---- M13-6 到期先于推进 ----
  {
    id: 'm13-5-entry-reset-generation-dropped',
    clause: 'M13-5 / W0-13:pause→resume 来回(最终布尔值不变)也是入口事件',
    edits: [{ file: STEP, anchor: 'cur.resetGen > prev.resetGen ||', replacement: '' }],
    tests: [T_STEP],
    expectRed: ['两次 tick 之间 pause → resume', 'entryReset:各入口事件各自成立'],
    mustKill: ['两次 tick 之间 pause → resume'],
  },
  {
    id: 'post-commit-lock-lost-continues',
    clause: 'R21-3.6 / W0-15:提交之后发现丢锁也立即结束步骤',
    edits: [
      { file: STEP, anchor: 'if (r.lockLost === true) {', replacement: 'if (false as boolean) {' },
    ],
    tests: [T_STEP],
    expectRed: ['提交之后工作副本写入丢锁'],
    mustKill: ['提交之后工作副本写入丢锁'],
  },
  {
    id: 'terminal-veto-blacklist-skipped',
    clause: 'R21-4.4a ②:终态上的 veto 仍写黑名单',
    edits: [
      {
        file: STEP,
        anchor: "if (line.reason === 'vetoed') {",
        replacement: 'if (false as boolean) {',
      },
    ],
    tests: [T_STEP],
    expectRed: ['终态候选 + 匹配的 vetoed 凭据'],
    mustKill: ['终态候选 + 匹配的 vetoed 凭据'],
  },
  {
    id: 'gate-facts-lock-lost-as-internal',
    clause: 'R21-3.6:闸事实读取丢锁不是 gate_internal,而是立即中止',
    edits: [
      {
        file: STEP,
        anchor:
          "if (e instanceof RsiLockError && e.kind === 'lock_lost') return halt('lock_lost');\n      outcome = {",
        replacement: 'outcome = {',
      },
    ],
    tests: [T_STEP],
    expectRed: ['闸事实读取时丢锁'],
    mustKill: ['闸事实读取时丢锁'],
  },
  {
    id: 'm13-5-nonhead-keeps-old-queue',
    clause: 'M13-5 / W0-13:名额空闲时非队首的旧 queued_since 清零(不累计)',
    edits: [
      {
        file: STEP,
        anchor: 'patchShadow({ canary_ready_since: x.ready, queued_since: null })(x.wc);',
        replacement:
          'patchShadow({ canary_ready_since: x.ready, queued_since: x.wc.shadow.queued_since })(x.wc);',
      },
    ],
    tests: [T_STEP],
    expectRed: ['名额已释放、队首复核失败'],
    mustKill: ['名额已释放、队首复核失败'],
  },
  {
    id: 'm13-5-tail-queues-on-any-blocker',
    clause: 'M13-5 / W0-13:尾部只有重判结果确为 slot_occupied 才设排队日期',
    edits: [{ file: STEP, anchor: "step3.blocker === 'slot_occupied'", replacement: 'true' }],
    tests: [T_STEP],
    expectRed: ['尾部重判资格失败'],
    mustKill: ['尾部重判资格失败'],
  },
  {
    id: 'm13-5-tail-facts-unavailable-queues',
    clause: 'M13-5:尾部事实不可得仍设排队日期',
    edits: [
      {
        file: STEP,
        anchor: "await clearQueue(cur, wc, 'promote_facts_unavailable');\n        continue;",
        replacement:
          '{\n          const q = patchShadow({ canary_ready_since: wc.shadow.canary_ready_since, queued_since: wc.shadow.queued_since ?? today })(wc);\n          if (q !== undefined) { await d.working.put(q); working.set(cur.id, q); }\n        }\n        continue;',
      },
    ],
    tests: [T_STEP],
    expectRed: ['尾部事实不可得'],
    mustKill: ['尾部事实不可得'],
  },
  {
    id: 'g5-targets-set-unchecked',
    clause: 'R21-5.3:必须检查的目标集合(缺失 / 重复 → internal)',
    edits: [
      {
        file: GATES,
        anchor:
          "if (seen.size !== QUOTA_REQUIRED_TARGETS.length) throw new GateUnavailableError('budget.targets');",
        replacement: 'void 0;',
      },
    ],
    tests: [T_GATES],
    expectRed: ['目标集合必须恰好是 claude / pi / codex 各一次'],
    mustKill: ['目标集合必须恰好是 claude / pi / codex 各一次'],
  },
  {
    id: 'g5-budget-red-before-validation',
    clause: 'R21-5.3:无效配额事实归 internal,不被 g5_budget 红灯掩盖(主代理验收第 3 轮)',
    edits: [
      {
        file: GATES,
        anchor:
          "const targets = validatedQuotaTargets(b.targets);\n  if (!b.renderLevelOk) return red('g5_budget');",
        replacement:
          "if (!b.renderLevelOk) return red('g5_budget');\n  const targets = validatedQuotaTargets(b.targets);",
      },
    ],
    tests: [T_GATES],
    expectRed: ['配额事实无效时即使渲染 level 不是 ok 也归 internal'],
    mustKill: ['配额事实无效时即使渲染 level 不是 ok 也归 internal'],
  },
  {
    id: 'g5-collector-budget-trusted',
    clause: 'R21-5.3:固定预算与单位由 target 派生,不信任收集器',
    edits: [
      {
        file: GATES,
        anchor: 'if (t.unit !== fixed.unit || t.total !== fixed.total) {',
        replacement: 'if (false as boolean) {',
      },
    ],
    tests: [T_GATES],
    expectRed: ['total / unit 必须等于由 target 派生的固定值'],
    mustKill: ['total / unit 必须等于由 target 派生的固定值'],
  },
  {
    id: 'g5-counts-unvalidated',
    clause: 'R21-5.3:数量必须是有限非负整数',
    edits: [
      {
        file: GATES,
        anchor: "typeof n === 'number' && Number.isInteger(n) && n >= 0;",
        replacement: "typeof n === 'number';",
      },
    ],
    tests: [T_GATES],
    expectRed: ['数量必须是有限非负整数'],
    mustKill: ['数量必须是有限非负整数'],
  },
  {
    id: 'reconcile-incomplete-still-grants',
    clause: 'R21-9.5:对账未完成前不做增加影响的转移',
    edits: [
      {
        file: STEP,
        anchor: 'const noGrant = out.breaker !== null || out.reconcileIncomplete;',
        replacement: 'const noGrant = out.breaker !== null;',
      },
    ],
    tests: [T_STEP],
    expectRed: ['对账未完成'],
    mustKill: ['对账未完成'],
  },
  {
    id: 'm13-6-expiry-skipped',
    clause: 'M13-6:判定顺序对调(排队到期不被处理,名额空闲就推进)',
    edits: [
      {
        file: STEP,
        anchor: 'if (queueExpired(wc.shadow.queued_since, today)) {',
        replacement: 'if (false as boolean) {',
      },
      {
        file: STEP,
        anchor: "if (step.action === 'expire' && step.event !== undefined) {",
        replacement: 'if (false as boolean) {',
      },
    ],
    tests: [T_STEP],
    expectRed: ['M13-6 排队第 30 日名额恰好空闲'],
    mustKill: ['M13-6 排队第 30 日名额恰好空闲'],
  },
  // ---- M13-7 canary_ready_since 只排序 ----
  {
    id: 'm13-7-expiry-reads-ready-since',
    clause: 'M13-7:到期判断读 canary_ready_since',
    edits: [
      {
        file: STEP,
        anchor: `      facts,
      shadow: {
        canary_ready_since: wc.shadow.canary_ready_since,
        queued_since: wc.shadow.queued_since,`,
        replacement: `      facts,
      shadow: {
        canary_ready_since: wc.shadow.canary_ready_since,
        queued_since: wc.shadow.canary_ready_since ?? wc.shadow.queued_since,`,
      },
    ],
    tests: [T_STEP],
    expectRed: ['M13-7 canary_ready_since 很久以前但没有在排队'],
    mustKill: ['M13-7 canary_ready_since 很久以前但没有在排队'],
  },
  {
    id: 'm13-7-head-by-id-only',
    clause: 'M13-7:队首排序忽略 canary_ready_since(只按 id)',
    edits: [
      {
        file: STEP,
        anchor: 'canary_ready_since: x.ready }))',
        replacement: 'canary_ready_since: null }))',
      },
    ],
    tests: [T_STEP],
    expectRed: ['M13-7 队首按 (canary_ready_since, id) 升序'],
    mustKill: ['M13-7 队首按 (canary_ready_since, id) 升序'],
  },
  // ---- R21-5.2 / R21-1.5 闸运行器 ----
  {
    id: 'gate-exception-passes',
    clause: 'R21-1.5 变异:任一判定函数在异常时返回「通过」',
    edits: [
      {
        file: GATES,
        anchor: `return {
        kind: 'internal',
        gate,
        detail: e instanceof Error ? e.message : 'non-error thrown',
      };`,
        replacement: 'void e;\n      continue;',
      },
    ],
    tests: [T_GATES, T_STEP],
    expectRed: [
      '事实不可用 → internal',
      '闸实现抛任意错误 → internal',
      '闸内部错误 → gate_internal 熔断',
    ],
    mustKill: ['事实不可用 → internal', '闸内部错误 → gate_internal 熔断'],
  },
  {
    id: 'gate-unavailable-fact-defaults',
    clause: 'R21-1.5:事实不可用按默认值处理而不是抛',
    edits: [
      {
        file: GATES,
        anchor: 'if (v === null) throw new GateUnavailableError(fact);',
        replacement: 'if (v === null) return undefined as T;',
      },
    ],
    tests: [T_GATES],
    expectRed: ['第二遍不可用(null)'],
    mustKill: ['第二遍不可用(null)'],
  },
  {
    id: 'gate-order-reversed',
    clause: 'R21-5.2:G0–G7 按编号顺序',
    edits: [
      {
        file: GATES,
        anchor: 'for (const gate of GATE_ORDER) {',
        replacement: 'for (const gate of [...GATE_ORDER].reverse()) {',
      },
    ],
    tests: [T_GATES],
    expectRed: ['多个闸同时红:只报编号最小的'],
    mustKill: ['多个闸同时红:只报编号最小的'],
  },
  {
    id: 'gate-first-red-not-stop',
    clause: 'R21-5.2:首个红即停',
    edits: [
      {
        file: GATES,
        anchor: "if ('red' in v) return { kind: 'red', gate, reason: v.red };",
        replacement: "if ('red' in v) continue;",
      },
    ],
    tests: [T_GATES],
    expectRed: ['多个闸同时红:只报编号最小的', '全绿'],
    mustKill: ['多个闸同时红:只报编号最小的'],
  },
  {
    id: 'gate-internal-recorded-nothing',
    clause: 'R21-5.2:闸内部错误不触发 gate_internal 熔断(候选照旧不动但无熔断)',
    edits: [{ file: STEP, anchor: "out.breaker = 'gate_internal';", replacement: 'void 0;' }],
    tests: [T_STEP],
    expectRed: ['闸内部错误 → gate_internal 熔断', '同样 gate_internal'],
    mustKill: ['闸内部错误 → gate_internal 熔断'],
  },
  {
    id: 'g7-queue-not-applied',
    clause: 'R21-5.1 G7:同聚类同时一个非终态候选',
    edits: [
      { file: GATES, anchor: "? { queued: 'g7_queued' } : null", replacement: '? null : null' },
    ],
    tests: [T_GATES],
    expectRed: ['G7:同聚类已有别的非终态候选'],
    mustKill: ['G7:同聚类已有别的非终态候选'],
  },
  {
    id: 'g7-busy-ignores-other-states',
    clause: 'R21-5.1 G7:步骤里的 busy 判定不看别的候选',
    edits: [
      {
        file: STEP,
        anchor: "(o.lifecycle !== 'proposed' || o.id < rec.id),",
        replacement: 'false,',
      },
    ],
    tests: [T_STEP],
    expectRed: ['G7:同聚类已有非终态候选'],
    mustKill: ['G7:同聚类已有非终态候选'],
  },
  // ---- 闸判据 ----
  {
    id: 'g0-excerpt-copy-unchecked',
    clause: 'R21-5.1 G0:摘录机械复制',
    edits: [off(GATES, "if (e.excerpt !== e.signal.excerpt) return red('g0_schema_invalid');")],
    tests: [T_GATES],
    expectRed: ['摘录与信号库不一致'],
    mustKill: ['摘录与信号库不一致'],
  },
  {
    id: 'g0-stale-evidence-unchecked',
    clause: 'R21-5.1 G0:证据已不在信号库',
    edits: [off(GATES, "if (e.signal === null) return red('g0_evidence_stale');")],
    tests: [T_GATES],
    expectRed: ['证据已不在信号库'],
    mustKill: ['证据已不在信号库'],
  },
  {
    id: 'g3-min-sessions-relaxed',
    clause: 'R21-5.1 G3:证据 ≥ 2 个会话',
    edits: [
      {
        file: GATES,
        anchor: 'GATE_MIN_EVIDENCE_SESSIONS = 2;',
        replacement: 'GATE_MIN_EVIDENCE_SESSIONS = 1;',
      },
    ],
    tests: [T_GATES],
    expectRed: ['只有 1 个会话 → g3_sessions'],
    mustKill: ['只有 1 个会话 → g3_sessions'],
  },
  {
    id: 'g4-strength-unchecked',
    clause: 'R21-5.1 G4:strength=should',
    edits: [off(GATES, "if (fm.strength !== 'should') return red('g4_strength');")],
    tests: [T_GATES],
    expectRed: ['strength 不是 should'],
    mustKill: ['strength 不是 should'],
  },
  {
    id: 'g6-upper-bound-inclusive',
    clause: 'R21-5.1 G6:命中会话数 ≤ 0.5 × 同期会话数(边界恰好通过)',
    edits: [
      {
        file: GATES,
        anchor: 'if (r.hitSessions > GATE_REPLAY_MAX_SHARE * r.totalSessions)',
        replacement: 'if (r.hitSessions >= GATE_REPLAY_MAX_SHARE * r.totalSessions)',
      },
    ],
    tests: [T_GATES],
    expectRed: ['G6 边界'],
    mustKill: ['G6 边界'],
  },
  {
    id: 'apply-snapshot-overwrite',
    clause: 'R21-3.8 / 锁内重读:同生命周期但快照已变时不得用旧快照覆盖',
    edits: [
      {
        file: APPLY,
        anchor: 'if (canonicalJson(fresh.record) !== canonicalJson(rec)) {',
        replacement: 'if (false as boolean) {',
      },
    ],
    tests: [T_STEP],
    expectRed: ['同生命周期但快照已变'],
    mustKill: ['同生命周期但快照已变'],
  },
  {
    id: 'lock-lost-swallowed',
    clause: 'R21-3.6 / W0-15:丢锁立即中止',
    edits: [
      {
        file: STEP,
        anchor: "if (e instanceof RsiLockError && e.kind === 'lock_lost') {",
        replacement: 'if (false as boolean) {',
      },
    ],
    tests: [T_STEP],
    expectRed: ['提交时丢锁(lock_lost)'],
    mustKill: ['提交时丢锁(lock_lost)'],
  },
  {
    id: 'noop-effects-dropped',
    clause: 'R21-4.4a ②:终态上的 veto 仍写黑名单(空操作不丢效果)',
    edits: [
      {
        file: APPLY,
        anchor: "await landEffects(d, res.effects);\n    return { kind: 'noop' };",
        replacement: "return { kind: 'noop' };",
      },
    ],
    tests: [T_STEP],
    expectRed: ['终态上的终止事件是空操作'],
    mustKill: ['终态上的终止事件是空操作'],
  },
  {
    id: 'gate-internal-still-grants',
    clause: 'R21-5.2 / B2:gate_internal 在同一步立即停止授予影响',
    edits: [{ file: STEP, anchor: 'if (noGrant) continue;', replacement: 'void 0;' }],
    tests: [T_STEP],
    expectRed: ['gate_internal 熔断在同一步立即生效'],
    mustKill: ['gate_internal 熔断在同一步立即生效'],
  },
  {
    id: 'm13-5-facts-unavailable-keeps-queue',
    clause: 'M13-5 / W0-13:推进事实不可得时 queued_since 必须清零',
    edits: [
      {
        file: STEP,
        anchor: "await clearQueue(rec, wc, 'promote_facts_unavailable');",
        replacement: 'void 0;',
      },
    ],
    tests: [T_STEP],
    expectRed: ['M13-5 推进事实不可得'],
    mustKill: ['M13-5 推进事实不可得'],
  },
  {
    id: 'm13-5-final-facts-unavailable-keeps-queue',
    clause: 'M13-5 / W0-13:队首二次读取事实不可得时同样清零',
    edits: [
      {
        file: STEP,
        anchor: "await clearQueue(frec, wc2, 'promote_facts_unavailable');",
        replacement: 'void 0;',
      },
    ],
    tests: [T_STEP],
    expectRed: ['M13-5 队首二次读取事实不可得'],
    mustKill: ['M13-5 队首二次读取事实不可得'],
  },
  {
    id: 'create-id-collision-skipped',
    clause: 'W0-6:48 位 id 碰撞而内容哈希不同 → candidate_invalid',
    edits: [
      {
        file: STEP,
        anchor: "if (knownSha !== draft.contentSha256) return halt('candidate_invalid');",
        replacement: 'void 0;',
      },
    ],
    tests: [T_STEP],
    expectRed: ['候选 id 碰撞而内容哈希不同'],
    mustKill: ['候选 id 碰撞而内容哈希不同'],
  },
  {
    id: 'm13-4-queue-before-head-commit',
    clause: 'M13-4 / W0-13:非队首排队日期要等队首提交成功后按重读的权威记录再设',
    edits: [
      {
        file: STEP,
        anchor: 'slot_occupied: evaluationSlotOccupied(after.filter((o) => o.id !== cur.id)),',
        replacement: 'slot_occupied: true,',
      },
      { file: STEP, anchor: 'let headPromoted = false;', replacement: 'let headPromoted = true;' },
    ],
    tests: [T_STEP],
    expectRed: ['M13-4 非队首的 queued_since 要等队首提交成功后才设'],
    mustKill: ['M13-4 非队首的 queued_since 要等队首提交成功后才设'],
  },
  {
    id: 'rebuild-ready-since-null',
    clause: 'W0-13:重建无法重算 → 当日 + ready_since_rebuilt 审计',
    edits: [
      {
        file: STEP,
        anchor: "const readyToday = rec.lifecycle === 'shadow' && recovered === null;",
        replacement: 'const readyToday = false;',
      },
    ],
    tests: [T_STEP],
    expectRed: ['缺工作副本的 shadow:无法重算'],
    mustKill: ['缺工作副本的 shadow:无法重算'],
  },
  {
    id: 'g5-category-share-unchecked',
    clause: 'R21-5.3:规则 / 踩坑 / 技能分类份额',
    edits: [
      {
        file: GATES,
        anchor: "if (t.used[cls] + t.add > quota * AUTO_QUOTA_SHARE[cls]) return red('g5_quota');",
        replacement: 'void 0;',
      },
    ],
    tests: [T_GATES],
    expectRed: ['分类份额'],
    mustKill: ['分类份额'],
  },
  {
    id: 'g5-lite-factor-removed',
    clause: 'W0-10:lite / medium 配额 12.5%',
    edits: [{ file: GATES, anchor: "(profile === 'heavy' ? 1 : 0.5)", replacement: '1' }],
    tests: [T_GATES],
    expectRed: ['claude 按行'],
    mustKill: ['claude 按行'],
  },
  {
    id: 'g5-only-first-target',
    clause: 'R21-5.3:每个渲染目标都要判',
    edits: [
      {
        file: GATES,
        anchor: 'for (const t of targets) {',
        replacement: 'for (const t of targets.slice(0, 1)) {',
      },
    ],
    tests: [T_GATES],
    expectRed: ['任一目标超额即红'],
    mustKill: ['任一目标超额即红'],
  },
  {
    id: 'g5-pairing-unchecked',
    clause: 'R21-5.3:占用 ≥ 80% 必须配对退役',
    edits: [
      {
        file: GATES,
        anchor: 'if (usedAll + t.add >= GATE_QUOTA_PAIRING_RATIO * quota && !b.pairedRetirement) {',
        replacement: 'if (false as boolean) {',
      },
    ],
    tests: [T_GATES],
    expectRed: ['占用越过 80% 且无配对退役'],
    mustKill: ['占用越过 80% 且无配对退役'],
  },
  {
    id: 'reconcile-unmapped-defaults-to-clear',
    clause: 'R21-9.5:对账不兜底 clear',
    edits: [
      {
        file: STEP,
        anchor: 'const basis = RECONCILE_BASIS[line.reason];',
        replacement: "const basis = RECONCILE_BASIS[line.reason] ?? 'clear';",
      },
    ],
    tests: [T_STEP],
    expectRed: ['无法映射的凭据原因不兜底成 clear'],
    mustKill: ['无法映射的凭据原因不兜底成 clear'],
  },
  {
    id: 'reconcile-terminal-always-cleared',
    clause: 'R21-9.5:终态理由按凭据依据映射',
    edits: [
      {
        file: TABLE,
        anchor: 'terminal: (e) => RECONCILE_TERMINAL[e.basis],',
        replacement: "terminal: () => 'cleared',",
      },
    ],
    tests: [T_RECON],
    expectRed: ['→ rejected,原因 revocation_reconciled,终态理由'],
    mustKill: ['→ rejected,原因 revocation_reconciled,终态理由'],
  },
  {
    id: 'reconcile-reason-wrong',
    clause: 'R21-9.5:对账转移原因 revocation_reconciled',
    edits: [
      {
        file: TABLE,
        anchor: "reason: () => 'revocation_reconciled',",
        replacement: "reason: () => 'cleared',",
      },
    ],
    tests: [T_RECON],
    expectRed: ['→ rejected,原因 revocation_reconciled,终态理由'],
    mustKill: ['→ rejected,原因 revocation_reconciled,终态理由'],
  },
  {
    id: 'reconcile-veto-no-blacklist',
    clause: 'R21-11.3:veto 依据仍写黑名单',
    edits: [
      {
        file: TRANS,
        anchor: "event.kind === 'revocation_reconcile' && event.basis === 'veto'",
        replacement: 'false',
      },
    ],
    tests: [T_RECON],
    expectRed: ['veto 依据仍写指纹黑名单效果'],
    mustKill: ['veto 依据仍写指纹黑名单效果'],
  },
  // ---- W0-6 候选来源 / 创建行 ----
  {
    id: 'source-selectable-all',
    clause: 'W0-6:仅 layer=personal ∧ op=add ∧ 单目标成为候选',
    edits: [
      {
        file: SOURCE,
        anchor: "return p.layer === 'personal' && p.op === 'add' && p.targets.length === 1;",
        replacement: 'return true;',
      },
    ],
    tests: [T_SRC, T_STEP],
    expectRed: ['只有 layer=personal ∧ op=add ∧ 单目标', '不是候选来源的提案'],
    mustKill: ['只有 layer=personal ∧ op=add ∧ 单目标'],
  },
  {
    id: 'source-pitfall-ignores-volatility',
    clause: 'W0-6:pitfall 判据 volatility=volatile',
    edits: [
      { file: SOURCE, anchor: "stored.fm.volatility === 'volatile' &&", replacement: 'true &&' },
    ],
    tests: [T_SRC],
    expectRed: ['类别机械判'],
    mustKill: ['类别机械判'],
  },
  {
    id: 'source-id-ignores-content',
    clause: 'W0-6:候选 id 含 content_sha256',
    edits: [
      {
        file: SOURCE,
        anchor: 'const id = candidateId(runId, proposal.id, contentSha256);',
        replacement: "const id = candidateId(runId, proposal.id, 'x'.repeat(64));",
      },
    ],
    tests: [T_SRC],
    expectRed: ['候选 id = W1 的 candidateId'],
    mustKill: ['候选 id = W1 的 candidateId'],
  },
  {
    id: 'source-origin-not-rewritten',
    clause: 'R21-3.10:origin=auto_rsi',
    edits: [
      {
        file: SOURCE,
        anchor: "if (idx >= 0) lines[idx] = 'origin: auto_rsi';",
        replacement: 'if (idx >= 0) void 0;',
      },
    ],
    tests: [T_SRC],
    expectRed: ['存放的原子文件 origin=auto_rsi'],
    mustKill: ['存放的原子文件 origin=auto_rsi'],
  },
  {
    id: 'record-creation-reason-wrong',
    clause: 'R21-4.1:(无) → proposed 的原因是 ingested',
    edits: [
      {
        file: RECORD,
        anchor: `reason: 'ingested',
        idem_key: creationIdemKey(d),`,
        replacement: `reason: 'gates_passed',
        idem_key: creationIdemKey(d),`,
      },
    ],
    tests: [T_SRC, T_STEP],
    expectRed: ['记录合法、proposed、全 none、一条 ingested 转移'],
    mustKill: ['记录合法、proposed、全 none、一条 ingested 转移'],
  },
  // ---- 撤销对账(V1a)与权威 / 工作副本 ----
  {
    id: 'revocation-unreadable-continues',
    clause: 'R21-9.5 / R21-6.11 第 4a 行:凭据读不到不得授予任何影响',
    edits: [off(STEP, "if (rv0.kind === 'invalid') return halt('revocations_invalid');")],
    tests: [T_STEP],
    expectRed: ['凭据读不到 → 中止且不授予任何影响'],
    mustKill: ['凭据读不到 → 中止且不授予任何影响'],
  },
  {
    id: 'revocation-ignores-content-hash',
    clause: 'R21-9.5:凭据绑定(候选 id, 内容哈希)',
    edits: [
      { file: STEP, anchor: 'r.content_sha256 === line.content_sha256', replacement: 'true' },
    ],
    tests: [T_STEP],
    expectRed: ['凭据的内容哈希不是该候选当前内容'],
    mustKill: ['凭据的内容哈希不是该候选当前内容'],
  },
  {
    id: 'repo-invalid-no-breaker',
    clause: 'R21-3.4:仓库结构无效 → personal_repo_invalid 熔断',
    edits: [off(STEP, "if (all.kind === 'invalid') out.breaker = 'personal_repo_invalid';")],
    tests: [T_STEP],
    expectRed: ['不创建、不推进'],
    mustKill: ['不创建、不推进'],
  },
  {
    id: 'repo-bad-record-skipped',
    clause: 'R21-4.3 / R21-3.8:坏记录 = candidate_invalid 整体阻断,不跳过',
    edits: [
      {
        file: REPO,
        anchor:
          "if (!p.success || p.data.id !== m[1]) return { kind: 'invalid', why: 'candidate_invalid' };",
        replacement: "if (!p.success) return { kind: 'invalid', why: 'candidate_invalid' };",
      },
    ],
    tests: [T_REPO],
    expectRed: ['lifecycle 下有坏记录'],
    mustKill: ['lifecycle 下有坏记录'],
  },
];

/** 变异结果(由主代理在验证机执行后回填;W3 实装块不执行变异) */
export const V1_W3_RESULTS: readonly V1W3Result[] = [];
