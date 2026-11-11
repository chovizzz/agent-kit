/**
 * §21.24 W0 订正的契约测试:相位闸、能力表、条款分配表(文档 ↔ 代码双向一致)、枚举 / 码表、个人层 schema 的负向用例。
 * 每条不变量:负向用例 + 正向对照 + 变异锚点(`test/rsi/v1-w0-mutation-table.ts`)。条款号出现在 `it` 标题里供 `r21-clause-coverage.test.ts` 追踪。
 */
import { describe, expect, it } from 'vitest';
import { AtomFrontmatterSchema } from '../../src/contracts/atom.js';
import {
  RSI_AUTO_LABEL,
  RSI_AUTO_PAUSE_REASONS,
  RSI_AUTO_PAUSE_REASON_PHASE,
  RSI_AUTO_PHASE,
  RSI_AUTO_PHASE_ORDER,
  RSI_CAPABILITY_PHASE,
  RSI_DECIDE_BETTER_ENABLED,
  RSI_EXIT1_CODES,
  RSI_FAIL_CLOSED_REASONS,
  RSI_LESSON_JACCARD,
  RSI_MARK_PREFIX,
  RSI_NOT_RUN_REASONS,
  RSI_USAGE_REASONS,
  RSI_EXEC_NOT_RUN,
  RsiBaseSchema,
  capabilityAvailable,
  phaseAtLeast,
  phaseIndex,
  rsiG0Reasons,
  RSI_INGEST_REJECT_REASONS,
  RSI_TERMINAL_REASONS,
  RSI_LIFECYCLE_STATES,
  type RsiAutoPhaseName,
  RSI_PROBE_SESSIONS,
} from '../../src/contracts/rsi.js';
import {
  CanaryAdmissionSchema,
  PersonalCommitJournalSchema,
  PersonalLifecycleRecordSchema,
  RsiCanaryLedgerLineSchema,
  RsiRevocationLineSchema,
  RsiTombstonesSchema,
  deployMatrixViolation,
} from '../../src/contracts/rsi-personal.js';
import { DEFAULT_LESSON_JACCARD } from '../../src/reflect/cluster.js';
import { FULL, SEC24, clausePhaseMap, clauseTags, tableAfter, ticks } from './r21-w0-doc.js';

const T = '2026-11-09T08:00:00.000Z';
const A = 'a'.repeat(64);
const ID = 'ra_0123456789ab';

describe('R21-0.1 相位闸:有序表只追加、整数 = 下标,文档表与代码双向一致', () => {
  it('R21-0.1 W0 落地时 RSI_AUTO_PHASE = 0(变异:提前提升 → 红);判定开关恒假(R21-7.9)', () => {
    expect(RSI_AUTO_PHASE).toBe(0);
    expect(RSI_DECIDE_BETTER_ENABLED).toBe(false);
  });

  it('R21-0.1 文档 §21.24 相位表 == RSI_AUTO_PHASE_ORDER(名字与整数逐行相等;枚举多一项 / 少一项 → 红)', () => {
    const rows = tableAfter(SEC24, '<!-- W0-PHASE-ORDER -->');
    expect(rows.map((r) => r[0])).toEqual([...RSI_AUTO_PHASE_ORDER]);
    expect(rows.map((r) => Number(r[1]))).toEqual(RSI_AUTO_PHASE_ORDER.map((_, i) => i));
    expect(RSI_AUTO_PHASE_ORDER.slice(0, 4)).toEqual(['V0', 'V1a', 'V1b', 'V1.5']);
  });

  it('R21-0.1 phaseAtLeast:缺省取当前相位;可注入;V1a=1、V1b=2', () => {
    expect(phaseIndex('V1a')).toBe(1);
    expect(phaseIndex('V1b')).toBe(2);
    expect(phaseAtLeast('V0')).toBe(true);
    expect(phaseAtLeast('V1a')).toBe(false); // W0:相位 0
    expect(phaseAtLeast('V1a', 1)).toBe(true);
    expect(phaseAtLeast('V1b', 1)).toBe(false);
    expect(phaseAtLeast('V1b', 2)).toBe(true);
    expect(phaseAtLeast('V3', 4)).toBe(false);
  });

  it('R21-0.2 V1a 与 V1b 是相邻的两个不同相位(各自一个 PR 提升)', () => {
    expect(phaseIndex('V1b') - phaseIndex('V1a')).toBe(1);
  });
});

describe('W0-1 能力表:默认拒绝;文档表 ↔ RSI_CAPABILITY_PHASE 双向一致', () => {
  it('R21-0.1 能力表逐行相等(键与最早期;多一项 / 少一项 / 改期 → 红)', () => {
    const rows = tableAfter(SEC24, '<!-- W0-CAPABILITY-PHASE -->');
    const doc = Object.fromEntries(rows.map((r) => [ticks(r[0] as string)[0], r[1]]));
    expect(rows.length).toBe(Object.keys(doc).length); // 无重复键
    expect(doc).toEqual({ ...RSI_CAPABILITY_PHASE });
    for (const phase of Object.values(RSI_CAPABILITY_PHASE)) {
      expect(RSI_AUTO_PHASE_ORDER).toContain(phase);
    }
  });

  it('R21-0.1 能力默认拒绝:不在表里 = 不可用;相位 0 时全部不可用;到期后只放行本期及更早', () => {
    expect(capabilityAvailable('no_such_capability', 9)).toBe(false); // 变异:缺省放行 → 红
    // 原型链上的键不是能力(普通对象查表的陷阱):toString / constructor / __proto__ 任何相位都不可用
    for (const k of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(capabilityAvailable(k, 9), k).toBe(false);
    }
    for (const k of Object.keys(RSI_CAPABILITY_PHASE))
      expect(capabilityAvailable(k), k).toBe(false);
    expect(capabilityAvailable('candidate_create', 1)).toBe(true);
    expect(capabilityAvailable('transition_shadow_to_canary', 1)).toBe(false);
    expect(capabilityAvailable('transition_shadow_to_canary', 2)).toBe(true);
    expect(capabilityAvailable('transition_canary_to_adopted', 3)).toBe(false); // V2 才开(R21-7.13)
    expect(capabilityAvailable('decide_better', 3)).toBe(false);
    expect(capabilityAvailable('decide_better', 4)).toBe(true);
  });

  it('R21-7.9 判定能力只在 V2 起存在,与恒假的判定开关同向', () => {
    expect(RSI_CAPABILITY_PHASE['decide_better']).toBe('V2');
    expect(RSI_CAPABILITY_PHASE['transition_canary_to_adopted']).toBe('V2');
  });
});

describe('W0-1 条款分配表:`[V1]` 条款一个不漏、不重复、不多', () => {
  const tags = clauseTags();
  const map = clausePhaseMap();

  it('R21-0.1 每个 [V1] 条款都在分配表里恰好一次,表里没有别的条款;首期只取 V1a / V1b', () => {
    const v1 = [...tags].filter(([, t]) => t === 'V1').map(([id]) => id);
    expect(v1.length).toBeGreaterThanOrEqual(80); // 防解析静默变空(当前 83)
    expect([...map.keys()].sort()).toEqual([...v1].sort());
    for (const phase of map.values()) expect(['V1a', 'V1b']).toContain(phase);
  });

  it('R21-0.1 分配表解析器的反向对照:重复分配 / 非法条款号 / 空表都抛错', () => {
    const dup = SEC24.replace('| R21-12.7 ', '| R21-12.7、R21-1.1 ');
    expect(() => clausePhaseMap(dup)).toThrow(/重复/);
    expect(() => clausePhaseMap(SEC24.replace('| R21-5.4 ', '| R21-5.x '))).toThrow(/格式/);
    expect(() => tableAfter('no marker', '<!-- W0-CLAUSE-PHASE -->')).toThrow(/找不到/);
  });

  it('R21-0.1 V1b 才有的能力对应的条款首期不早于 V1b(灰度 / 分组账 / 回滚条款)', () => {
    for (const id of ['R21-6.1', 'R21-6.11', 'R21-9.1', 'R21-4.2', 'R21-12.7']) {
      expect(map.get(id), id).toBe('V1b');
    }
    for (const id of ['R21-3.5', 'R21-4.3', 'R21-9.5', 'R21-12.4'])
      expect(map.get(id), id).toBe('V1a');
  });
});

describe('R21-10.2 熔断码表 ↔ 枚举;最早期', () => {
  it('R21-10.2 文档码表第一列 == RSI_AUTO_PAUSE_REASONS(多一项 / 少一项 → 红);每码有最早期', () => {
    const a = FULL.indexOf('- R21-10.2 `[V1]`');
    const b = FULL.indexOf('- R21-10.3 `[V1]`');
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    const codes = FULL.slice(a, b)
      .split('\n')
      .filter((l) => l.startsWith('| `'))
      .map((l) => ticks(l.split('|')[1] as string)[0]);
    expect(codes).toEqual([...RSI_AUTO_PAUSE_REASONS]);
    expect(Object.keys(RSI_AUTO_PAUSE_REASON_PHASE).sort()).toEqual(
      [...RSI_AUTO_PAUSE_REASONS].sort(),
    );
    expect(RSI_AUTO_PAUSE_REASON_PHASE.rollback_storm).toBe('V1b'); // W0-12:需要回滚才会触发
    expect(RSI_AUTO_PAUSE_REASON_PHASE.user_paused).toBe('V1a');
    for (const p of Object.values(RSI_AUTO_PAUSE_REASON_PHASE) as RsiAutoPhaseName[]) {
      expect(RSI_AUTO_PHASE_ORDER).toContain(p);
    }
  });
});

describe('R21-12.9 稳定码并入(W0-12)', () => {
  it('R21-12.9 USAGE / NOT_RUN / 顶层 / FAIL_CLOSED 追加项都在既有枚举里,且枚举无重复', () => {
    for (const c of ['bad_date', 'unknown_id', 'bad_marker'])
      expect(RSI_USAGE_REASONS).toContain(c);
    for (const c of [
      'not_diverged',
      'phase_not_available',
      'ticket_expired',
      'no_runtime',
      'rate_limited',
    ]) {
      expect(RSI_NOT_RUN_REASONS).toContain(c);
    }
    for (const c of ['RSI_AUTO_RESUME_BLOCKED', 'RSI_CONTRIB_DEGRADED', 'RSI_EXEC_DECLINED']) {
      expect(RSI_EXIT1_CODES).toContain(c);
    }
    expect(RSI_EXEC_NOT_RUN).toBe('RSI_EXEC_NOT_RUN');
    for (const c of [
      'personal_repo_invalid',
      'candidate_invalid',
      'ledger_line_invalid',
      'txn_invalid',
      'probe_error',
    ]) {
      expect(RSI_FAIL_CLOSED_REASONS).toContain(c);
    }
    for (const arr of [
      RSI_USAGE_REASONS,
      RSI_NOT_RUN_REASONS,
      RSI_EXIT1_CODES,
      RSI_FAIL_CLOSED_REASONS,
    ]) {
      expect(new Set(arr).size).toBe(arr.length);
    }
  });

  it('R21-12.9 G0 原因码 = g0_ + ingest 拒绝子码(A4-1);终态理由优先级 vetoed 最高(R21-4.4a)', () => {
    expect(rsiG0Reasons()).toEqual(RSI_INGEST_REJECT_REASONS.map((r) => `g0_${r}`));
    expect(RSI_TERMINAL_REASONS[0]).toBe('vetoed');
    expect(RSI_TERMINAL_REASONS.indexOf('judge_rejected')).toBeGreaterThan(
      RSI_TERMINAL_REASONS.indexOf('cleared'),
    );
    expect(RSI_TERMINAL_REASONS.indexOf('judge_rejected')).toBeLessThan(
      RSI_TERMINAL_REASONS.indexOf('auto_rollback'),
    );
  });
});

describe('R21-1.9 / R21-6.3 常量', () => {
  it('R21-1.9 标签与关联标记前缀是固定常量(非空)', () => {
    expect(RSI_AUTO_LABEL).toBe('自动产出、未经人工核验');
    expect(RSI_MARK_PREFIX.length).toBeGreaterThan(0);
  });
});

describe('W0-2 签名:教训类 Jaccard 阈值与 cluster.ts 一致', () => {
  it('R21-3.7 RSI_LESSON_JACCARD == DEFAULT_LESSON_JACCARD(变异:改成 0.4 → 红)', () => {
    expect(RSI_LESSON_JACCARD).toBe(DEFAULT_LESSON_JACCARD);
  });
});

describe('R21-2.1 RsiBaseSchema 放行三个子表(只验表或缺省)', () => {
  it('R21-2.1 auto / capability / contrib 是表 → 通过;不是表 → 拒;未知键仍拒', () => {
    const base = { enabled: true };
    expect(RsiBaseSchema.safeParse({ ...base, auto: { enabled: true, whatever: 1 } }).success).toBe(
      true,
    );
    expect(RsiBaseSchema.safeParse({ ...base, capability: {}, contrib: {} }).success).toBe(true);
    for (const k of ['auto', 'capability', 'contrib']) {
      expect(RsiBaseSchema.safeParse({ ...base, [k]: 5 }).success, k).toBe(false);
      expect(RsiBaseSchema.safeParse({ ...base, [k]: [1] }).success, k).toBe(false);
    }
    expect(RsiBaseSchema.safeParse({ ...base, mystery: 1 }).success).toBe(false);
  });
});

describe('R21-3.10 AtomFrontmatter 追加可选 trigger', () => {
  it('R21-3.10 trigger 可缺省;出现时非空且 ≤ 200 字符', () => {
    const t = AtomFrontmatterSchema.shape.trigger;
    expect(t.safeParse(undefined).success).toBe(true);
    expect(t.safeParse('npm test 失败后').success).toBe(true);
    expect(t.safeParse('').success).toBe(false);
    expect(t.safeParse('x'.repeat(201)).success).toBe(false);
  });
});

const baseRecord = () => ({
  schema_version: 1 as const,
  id: ID,
  category: 'rule' as const,
  lifecycle: 'shadow' as string,
  deploy: { claude: 'none', pi: 'none', codex: 'none' } as Record<string, string>,
  watch: { claude: null, pi: null, codex: null },
  rollback: null as unknown,
  target_paths: ['rules/ra_0123456789ab.md'],
  content_sha256: A,
  fp_hmac: '0123456789abcdef',
  cluster_id: 'c_1',
  case_set_sha256: null,
  blocked_from: null as string | null,
  transitions: [] as unknown[],
  transitions_dropped: 0,
  terminal_reason: null as string | null,
  overlaps_preset: false,
});
const rec = (over: Record<string, unknown>) => ({ ...baseRecord(), ...over });

describe('R21-4.3 合法组合矩阵(非法一律拒绝 = candidate_invalid)', () => {
  const none = { claude: 'none', pi: 'none', codex: 'none' };
  it('R21-4.3 正向对照:每个状态各一个合法组合', () => {
    const ok: [string, Record<string, string>, Record<string, unknown>][] = [
      ['proposed', none, {}],
      ['shadow', none, {}],
      ['blocked', none, { blocked_from: 'shadow' }],
      ['canary', { claude: 'injected', pi: 'injected', codex: 'none' }, {}],
      ['adopted', { claude: 'injected', pi: 'none', codex: 'none' }, {}],
      ['stable', { claude: 'static', pi: 'withdraw_pending', codex: 'static_pending' }, {}],
      [
        'rolling_back',
        { claude: 'removal_pending', pi: 'none', codex: 'none' },
        {
          rollback: {
            phase: 'rollback_requested',
            reason: 'vetoed',
            target_terminal: 'rolled_back',
          },
        },
      ],
      [
        'retiring',
        { claude: 'removal_pending', pi: 'none', codex: 'none' },
        { rollback: { phase: 'rollback_requested', reason: 'no_hit', target_terminal: 'retired' } },
      ],
      ['rejected', none, { terminal_reason: 'vetoed' }],
      ['expired', none, { terminal_reason: 'auto_expired' }],
      ['rolled_back', none, { terminal_reason: 'auto_rollback' }],
      ['retired', none, { terminal_reason: 'no_hit' }],
    ];
    expect(ok.length).toBe(RSI_LIFECYCLE_STATES.length);
    for (const [lifecycle, deploy, extra] of ok) {
      const r = PersonalLifecycleRecordSchema.safeParse(rec({ lifecycle, deploy, ...extra }));
      expect(r.success, `${lifecycle}: ${r.success ? '' : JSON.stringify(r.error.issues)}`).toBe(
        true,
      );
    }
  });

  it('R21-4.3 负向:无部署状态里有 agent 非 none;canary / adopted 里 codex 非 none 或出现 static;rolling_back 里 injected', () => {
    const bad: [string, Record<string, string>, Record<string, unknown>][] = [
      ['proposed', { ...none, claude: 'injected' }, {}],
      ['shadow', { ...none, pi: 'removal_pending' }, {}],
      ['rejected', { ...none, claude: 'injected' }, { terminal_reason: 'vetoed' }],
      ['canary', { claude: 'injected', pi: 'none', codex: 'injected' }, {}],
      ['canary', { claude: 'static', pi: 'none', codex: 'none' }, {}],
      ['adopted', { claude: 'none', pi: 'removal_pending', codex: 'none' }, {}],
      [
        'rolling_back',
        { claude: 'injected', pi: 'none', codex: 'none' },
        {
          rollback: {
            phase: 'rollback_requested',
            reason: 'vetoed',
            target_terminal: 'rolled_back',
          },
        },
      ],
    ];
    for (const [lifecycle, deploy, extra] of bad) {
      expect(
        PersonalLifecycleRecordSchema.safeParse(rec({ lifecycle, deploy, ...extra })).success,
        `${lifecycle} ${JSON.stringify(deploy)}`,
      ).toBe(false);
    }
    expect(
      deployMatrixViolation('canary', { claude: 'none', pi: 'none', codex: 'injected' }),
    ).not.toBeNull();
    expect(
      deployMatrixViolation('canary', { claude: 'injected', pi: 'injected', codex: 'none' }),
    ).toBeNull();
  });

  it('R21-3.7 终态必须带终态理由、非终态不得带;rolling_back 必须带 rollback;blocked_from 仅 blocked;未知键拒(strict)', () => {
    expect(PersonalLifecycleRecordSchema.safeParse(rec({ lifecycle: 'rejected' })).success).toBe(
      false,
    );
    expect(
      PersonalLifecycleRecordSchema.safeParse(rec({ terminal_reason: 'vetoed' })).success,
    ).toBe(false);
    expect(
      PersonalLifecycleRecordSchema.safeParse(
        rec({ lifecycle: 'rolling_back', deploy: { claude: 'none', pi: 'none', codex: 'none' } }),
      ).success,
    ).toBe(false);
    expect(PersonalLifecycleRecordSchema.safeParse(rec({ blocked_from: 'shadow' })).success).toBe(
      false,
    );
    expect(PersonalLifecycleRecordSchema.safeParse(rec({ lifecycle: 'blocked' })).success).toBe(
      false,
    );
    expect(PersonalLifecycleRecordSchema.safeParse(rec({ surprise: 1 })).success).toBe(false); // 旧版读到未知键 → 拒
  });

  it('R21-3.7 转移原因码是封闭枚举;source_proposal 与 cluster_signature 可缺省(旧记录合法)', () => {
    const t = (reason: string) => ({
      dim: 'lifecycle',
      from: 'proposed',
      to: 'shadow',
      at: T,
      reason,
      idem_key: '0123456789abcdef',
    });
    expect(
      PersonalLifecycleRecordSchema.safeParse(rec({ transitions: [t('gates_passed')] })).success,
    ).toBe(true);
    expect(
      PersonalLifecycleRecordSchema.safeParse(rec({ transitions: [t('g0_schema_invalid')] }))
        .success,
    ).toBe(true);
    expect(
      PersonalLifecycleRecordSchema.safeParse(rec({ transitions: [t('because')] })).success,
    ).toBe(false);
    expect(PersonalLifecycleRecordSchema.safeParse(rec({ source_proposal: null })).success).toBe(
      true,
    );
    expect(
      PersonalLifecycleRecordSchema.safeParse(
        rec({ transitions: Array.from({ length: 257 }, () => t('gates_passed')) }),
      ).success,
    ).toBe(false);
  });
});

describe('R21-3.6a 提交 journal:bootstrap 是单列状态机', () => {
  const j = (over: Record<string, unknown>) => ({
    schema_version: 1,
    txn_id: '0123456789abcdef',
    kind: 'transition',
    candidate_ids: [ID],
    ref: 'refs/heads/rsi',
    old_head: '1'.repeat(40),
    target_tree: '3'.repeat(40),
    new_commit: null,
    phase: 'planned',
    at: T,
    ...over,
  });
  it('R21-3.6a 正向:五 phase 各一;bootstrap 四 phase 且 old_head=null', () => {
    for (const phase of [
      'planned',
      'objects_written',
      'ref_updated',
      'worktree_synced',
      'recorded',
    ]) {
      // 提交对象在 objects_written(commit-tree)时已存在:此后的 journal 必须带 new_commit(planned 可为 null)
      const new_commit = phase === 'planned' ? null : '2'.repeat(40);
      expect(PersonalCommitJournalSchema.safeParse(j({ phase, new_commit })).success, phase).toBe(
        true,
      );
    }
    for (const phase of ['planned', 'initialized', 'committed', 'recorded']) {
      expect(
        PersonalCommitJournalSchema.safeParse(
          j({
            kind: 'bootstrap',
            old_head: null,
            candidate_ids: [],
            phase,
            new_commit: phase === 'committed' || phase === 'recorded' ? '2'.repeat(40) : null,
          }),
        ).success,
        phase,
      ).toBe(true);
    }
  });
  it('R21-3.6a 负向:bootstrap 带 old_head / 用了五 phase 的 phase;非 bootstrap 缺 old_head / 用了 bootstrap 的 phase;ref 不是 rsi 分支', () => {
    expect(
      PersonalCommitJournalSchema.safeParse(j({ kind: 'bootstrap', phase: 'planned' })).success,
    ).toBe(false);
    expect(
      PersonalCommitJournalSchema.safeParse(
        j({ kind: 'bootstrap', old_head: null, phase: 'ref_updated' }),
      ).success,
    ).toBe(false);
    expect(PersonalCommitJournalSchema.safeParse(j({ old_head: null })).success).toBe(false);
    expect(PersonalCommitJournalSchema.safeParse(j({ phase: 'initialized' })).success).toBe(false);
    expect(PersonalCommitJournalSchema.safeParse(j({ ref: 'refs/heads/main' })).success).toBe(
      false,
    );
  });
  it('R21-3.6a 负向矩阵 phase × new_commit:引用已更新 / 提交已生成却不指明提交对象 → 拒;planned 可为 null', () => {
    for (const phase of ['objects_written', 'ref_updated', 'worktree_synced', 'recorded']) {
      expect(PersonalCommitJournalSchema.safeParse(j({ phase })).success, phase).toBe(false);
    }
    for (const phase of ['committed', 'recorded']) {
      expect(
        PersonalCommitJournalSchema.safeParse(
          j({ kind: 'bootstrap', old_head: null, candidate_ids: [], phase }),
        ).success,
        `bootstrap ${phase}`,
      ).toBe(false);
    }
    expect(PersonalCommitJournalSchema.safeParse(j({ phase: 'planned' })).success).toBe(true);
    expect(
      PersonalCommitJournalSchema.safeParse(
        j({ kind: 'bootstrap', old_head: null, candidate_ids: [], phase: 'initialized' }),
      ).success,
    ).toBe(true);
  });
});

describe('R21-6.4 分组账行:探针行是唯一 marker 非空且 candidate_id 为 null 的 excluded 行', () => {
  const base = {
    at: T,
    agent: 'claude',
    background_fp: '0'.repeat(16),
    background_fp_ex: '0'.repeat(16),
    policy_fp: A,
    case_set_sha256: null,
    overlaps_preset: false,
    hint_version: 1,
    probe_generation: null,
    probe_ticket: null,
  };
  const assign = (over: Record<string, unknown>) => ({
    ...base,
    kind: 'assign',
    marker: 'rsm_0123456789abcdef',
    candidate_id: ID,
    arm: 'treat',
    reason: null,
    p: 0.5,
    ...over,
  });
  it('R21-6.4 正向:treat / control / 各 excluded 原因 / 探针行', () => {
    expect(RsiCanaryLedgerLineSchema.safeParse(assign({})).success).toBe(true);
    expect(RsiCanaryLedgerLineSchema.safeParse(assign({ arm: 'control' })).success).toBe(true);
    for (const reason of [
      'paused',
      'not_admitted',
      'policy_mismatch',
      'agent_not_injected',
      'revoked',
      'rng_error',
      'permit_unreadable',
    ]) {
      expect(
        RsiCanaryLedgerLineSchema.safeParse(assign({ arm: 'excluded', reason, p: 0, marker: null }))
          .success,
        reason,
      ).toBe(true);
    }
    expect(
      RsiCanaryLedgerLineSchema.safeParse(
        assign({
          arm: 'excluded',
          reason: 'admission_probe',
          p: 0,
          candidate_id: null,
          probe_generation: 1,
          probe_ticket: 1,
        }),
      ).success,
    ).toBe(true);
  });
  it('W0-18 探针行绑定代号与票号:探针行必带、其余行必空、票号 1..RSI_PROBE_SESSIONS', () => {
    const probe = (over: Record<string, unknown>) =>
      assign({
        arm: 'excluded',
        reason: 'admission_probe',
        p: 0,
        candidate_id: null,
        probe_generation: 2,
        probe_ticket: 3,
        ...over,
      });
    expect(RsiCanaryLedgerLineSchema.safeParse(probe({})).success).toBe(true);
    expect(RsiCanaryLedgerLineSchema.safeParse(probe({ probe_generation: null })).success).toBe(
      false,
    );
    expect(RsiCanaryLedgerLineSchema.safeParse(probe({ probe_ticket: null })).success).toBe(false);
    expect(RsiCanaryLedgerLineSchema.safeParse(probe({ probe_ticket: 0 })).success).toBe(false);
    expect(RsiCanaryLedgerLineSchema.safeParse(probe({ probe_ticket: 4 })).success).toBe(false);
    expect(
      RsiCanaryLedgerLineSchema.safeParse(assign({ probe_generation: 1, probe_ticket: 1 })).success,
    ).toBe(false);
    expect(
      RsiCanaryLedgerLineSchema.safeParse(
        assign({ arm: 'excluded', reason: 'paused', p: 0, marker: null, probe_ticket: 1 }),
      ).success,
    ).toBe(false);
  });
  it('R21-6.4 负向:探针行带 candidate_id / 无 marker;非探针 excluded 带 marker;treat 缺 marker、p=0;excluded p≠0;codex 不参与分组', () => {
    expect(
      RsiCanaryLedgerLineSchema.safeParse(
        assign({ arm: 'excluded', reason: 'admission_probe', p: 0 }),
      ).success,
    ).toBe(false);
    expect(
      RsiCanaryLedgerLineSchema.safeParse(
        assign({
          arm: 'excluded',
          reason: 'admission_probe',
          p: 0,
          candidate_id: null,
          marker: null,
        }),
      ).success,
    ).toBe(false);
    expect(
      RsiCanaryLedgerLineSchema.safeParse(assign({ arm: 'excluded', reason: 'paused', p: 0 }))
        .success,
    ).toBe(false);
    expect(RsiCanaryLedgerLineSchema.safeParse(assign({ marker: null })).success).toBe(false);
    expect(RsiCanaryLedgerLineSchema.safeParse(assign({ p: 0 })).success).toBe(false);
    expect(
      RsiCanaryLedgerLineSchema.safeParse(
        assign({ arm: 'excluded', reason: 'paused', p: 0.5, marker: null }),
      ).success,
    ).toBe(false);
    expect(RsiCanaryLedgerLineSchema.safeParse(assign({ agent: 'codex' })).success).toBe(false);
    expect(
      RsiCanaryLedgerLineSchema.safeParse(assign({ arm: 'treat', reason: 'paused' })).success,
    ).toBe(false);
  });
  it('R21-6.4 stop 行:revocation_reconciled ⇔ revocation_ref 必填;普通 stop 行 ref 为 null', () => {
    const stop = (reason: string, revocation_ref: string | null) => ({
      kind: 'stop',
      at: T,
      candidate_id: ID,
      reason,
      revocation_ref,
    });
    expect(
      RsiCanaryLedgerLineSchema.safeParse(stop('revocation_reconciled', '0123456789abcdef'))
        .success,
    ).toBe(true);
    expect(RsiCanaryLedgerLineSchema.safeParse(stop('auto_rollback' as string, null)).success).toBe(
      false,
    ); // auto_rollback 是终态理由不是转移原因码
    expect(RsiCanaryLedgerLineSchema.safeParse(stop('harm_c1', null)).success).toBe(true);
    expect(RsiCanaryLedgerLineSchema.safeParse(stop('revocation_reconciled', null)).success).toBe(
      false,
    );
    expect(RsiCanaryLedgerLineSchema.safeParse(stop('harm_c1', '0123456789abcdef')).success).toBe(
      false,
    );
  });
});

describe('W0-17 撤销凭据:reason 按写入方 by 约束', () => {
  const line = (by: string, reason: string) =>
    RsiRevocationLineSchema.safeParse({
      at: T,
      candidate_id: ID,
      content_sha256: 'a'.repeat(64),
      identity12: null,
      reason,
      by,
    }).success;
  it('各写入方的合法原因通过', () => {
    expect(line('clear', 'cleared')).toBe(true);
    expect(line('veto', 'vetoed')).toBe(true);
    expect(line('exec_event', 'exec_post_check_failed')).toBe(true);
    expect(line('exec_event', 'exec_timeout_unclean')).toBe(true);
    for (const r of [
      'harm_c1',
      'harm_c6',
      'limit_reached',
      'tainted',
      'judge_reject',
      'judge_injection',
    ]) {
      expect(line('worker', r), r).toBe(true);
    }
    expect(line('rollback_to', 'harm_c2')).toBe(true);
  });
  it('写入方与原因不符 → 拒绝', () => {
    expect(line('clear', 'harm_c1')).toBe(false);
    expect(line('clear', 'vetoed')).toBe(false);
    expect(line('veto', 'cleared')).toBe(false);
    expect(line('worker', 'cleared')).toBe(false);
    expect(line('worker', 'vetoed')).toBe(false);
    expect(line('exec_event', 'harm_c1')).toBe(false);
  });
  it('正常转移码、G 码、identity_changed 对任何写入方都拒绝', () => {
    for (const by of ['worker', 'clear', 'rollback_to', 'veto', 'exec_event']) {
      expect(line(by, 'ingested'), by).toBe(false);
      expect(line(by, 'revocation_reconciled'), by).toBe(false);
      expect(line(by, 'g4_conflict'), by).toBe(false);
      expect(line(by, 'identity_changed'), by).toBe(false);
    }
  });
});

describe('W0-3 准入文件', () => {
  const entry = (over: Record<string, unknown>) => ({
    state: 'probing',
    shape_version: 'claude-1',
    agent_version: null,
    generation: 1,
    armed_at: T,
    probe_expires_at: T,
    tickets: 3,
    decided_at: null,
    reason: null,
    ...over,
  });
  it('W0-3 状态与 decided_at / reason 的配对:probing 无决定时间;failed 必带原因;admitted 无原因', () => {
    const ok = (e: unknown) =>
      CanaryAdmissionSchema.safeParse({ schema_version: 1, agents: { claude: e } }).success;
    expect(ok(entry({}))).toBe(true);
    expect(ok(entry({ state: 'admitted', decided_at: T }))).toBe(true);
    expect(ok(entry({ state: 'failed', decided_at: T, reason: 'multi_marker' }))).toBe(true);
    expect(ok(entry({ state: 'failed', decided_at: T }))).toBe(false);
    expect(ok(entry({ state: 'admitted' }))).toBe(false);
    expect(ok(entry({ state: 'admitted', decided_at: T, reason: 'multi_marker' }))).toBe(false);
    expect(
      CanaryAdmissionSchema.safeParse({ schema_version: 1, agents: { codex: entry({}) } }).success,
    ).toBe(false);
  });
  it('W0-3 探针票数只能等于 RSI_PROBE_SESSIONS,超额或为零的准入文件不合法', () => {
    const ok = (tickets: unknown) =>
      CanaryAdmissionSchema.safeParse({
        schema_version: 1,
        agents: { claude: entry({ tickets }) },
      }).success;
    expect(ok(RSI_PROBE_SESSIONS)).toBe(true);
    for (const bad of [0, 2, 4, 1000000]) expect(ok(bad), String(bad)).toBe(false);
  });
});

describe('R21-3.7 target_paths 只收私有仓库相对路径', () => {
  it('R21-3.7 target_paths 拒绝绝对路径、目录穿越、NUL 与反斜杠,普通相对路径通过', () => {
    const ok = (p: string) =>
      PersonalLifecycleRecordSchema.safeParse(rec({ target_paths: [p] })).success;
    expect(ok('rules/ra_0123456789ab.md')).toBe(true);
    for (const bad of [
      '/tmp/outside.md',
      '../outside.md',
      'rules/../../outside.md',
      'rules\\x.md',
      'rules/\0x.md',
      'rules//x.md',
      '~/x.md',
      `rules/${'x'.repeat(260)}.md`,
    ]) {
      expect(ok(bad), bad).toBe(false);
    }
  });
});

describe('R21-11.4 墓碑 id 不得重复', () => {
  it('R21-11.4 重复 id → 拒;不同 id → 通过', () => {
    const e = (id: string) => ({ id, terminal: 'rejected', reason: 'vetoed', at: T });
    expect(
      RsiTombstonesSchema.safeParse({ schema_version: 1, entries: [e(ID), e('ra_ffffffffffff')] })
        .success,
    ).toBe(true);
    expect(
      RsiTombstonesSchema.safeParse({ schema_version: 1, entries: [e(ID), e(ID)] }).success,
    ).toBe(false);
  });
});
