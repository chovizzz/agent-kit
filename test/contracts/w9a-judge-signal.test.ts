/**
 * W0-27(契约订正)落地:`judge_seen` 工作副本可选键、判官裁决结果的封闭取值、订正正文在 contracts.md 里的位置与关键口径。
 * 带标记的合法 / 错误示例由 `examples.test.ts` 自动覆盖;这里补它覆盖不到的负向取值与「订正正文没有丢」的检查。
 */
import { describe, expect, it } from 'vitest';
import {
  JUDGE_IGNORE_REASONS,
  JUDGE_SIGNAL_RESULTS,
  JudgeSeenSchema,
} from '../../src/contracts/judge-signal.js';
import { CandidateWorkingCopySchema } from '../../src/contracts/rsi-personal.js';
import { FULL, SEC24 } from './r21-w0-doc.js';

const H = (c: string): string => c.repeat(64);

const COPY = {
  schema_version: 1,
  id: 'ra_0123456789ab',
  cluster_signature: { kind: 'lesson', rep_tokens: ['fixture', 'read', 'test'] },
  source: { run_id: 'run-20261109-01', proposal_id: '2026-11-09-001' },
  shadow: { sessions: 12, hits: 1, canary_ready_since: null, queued_since: null },
  evidence: { sessions: ['s_0123456789abcdef'], days: ['2026-11-08'] },
  stats: { sessions_observed: 12, sessions_treat: 0, sessions_control: 0, bytes_injected: 0 },
  repo_removal_deferred: false,
};

describe('W0-27 judge_seen(订正 R21-3.8)', () => {
  it('可选键:缺失合法(旧工作副本);带合法取值合法', () => {
    expect(CandidateWorkingCopySchema.safeParse(COPY).success).toBe(true);
    for (const seen of [
      { result: 'not_tightening', binding: null, indeterminate: false },
      { result: 'unreadable', binding: null, indeterminate: true },
      { result: 'judge_reject', binding: H('a'), indeterminate: false },
      { result: 'judge_injection', binding: H('0'), indeterminate: false },
    ]) {
      expect(
        CandidateWorkingCopySchema.safeParse({ ...COPY, judge_seen: seen }).success,
        JSON.stringify(seen),
      ).toBe(true);
    }
  });

  it('负向:未知结果码 / binding 不是 64 位小写十六进制 / 缺键 / 多键 / indeterminate 非布尔 / judge_seen 为 null → 工作副本不合规', () => {
    const bad: unknown[] = [
      { result: 'judge_expired', binding: null, indeterminate: false },
      { result: 'judge_reject', binding: 'a'.repeat(63), indeterminate: false },
      { result: 'judge_reject', binding: 'A'.repeat(64), indeterminate: false },
      { result: 'judge_reject', binding: undefined, indeterminate: false },
      { result: 'judge_reject', binding: null },
      { binding: null, indeterminate: false },
      { result: 'judge_reject', binding: null, indeterminate: false, extra: 1 },
      { result: 'judge_reject', binding: null, indeterminate: 'no' },
      null,
    ];
    for (const seen of bad) {
      expect(
        CandidateWorkingCopySchema.safeParse({ ...COPY, judge_seen: seen }).success,
        JSON.stringify(seen),
      ).toBe(false);
    }
    // 对照:同一份工作副本去掉 judge_seen 仍合法
    expect(CandidateWorkingCopySchema.safeParse({ ...COPY }).success).toBe(true);
  });

  it('JudgeSeenSchema 的 result 恰为 8 个忽略原因 + judge_reject / judge_injection', () => {
    expect([...JUDGE_SIGNAL_RESULTS]).toEqual([
      ...JUDGE_IGNORE_REASONS,
      'judge_reject',
      'judge_injection',
    ]);
    expect(JUDGE_SIGNAL_RESULTS).toHaveLength(10);
    for (const r of JUDGE_SIGNAL_RESULTS) {
      expect(
        JudgeSeenSchema.safeParse({ result: r, binding: null, indeterminate: false }).success,
      ).toBe(true);
    }
  });
});

describe('W0-27 订正正文', () => {
  const bullet = (key: string): string => {
    const i = FULL.indexOf(key);
    expect(i, key).toBeGreaterThan(0);
    return FULL.slice(i, FULL.indexOf('\n- ', i + 10));
  };

  it('§21.24 有 W0-27 小节;五处冻结条款后各有一条「冻结后订正 W0-27」引文(冻结原文没被改)', () => {
    expect(SEC24).toContain('#### W0-27 W9 判官裁决读判定与读失败语义订正');
    expect(FULL.split('冻结后订正 W0-27').length - 1).toBe(5);
    for (const key of [
      '- R20-18.34 **自动入口读取该记录的只读协议**',
      '- R20-18.35a **与 R21-2.2 的关系**',
      '- R20-18.37 **展示(Q-N4-4 = B)**',
      '- R20-18.38 **验收(N4-2)**',
      '- R21-3.8 `[V1]` **权威副本与工作副本**',
    ]) {
      expect(bullet(key), key).toContain('冻结后订正 W0-27');
    }
    // 冻结原文保持:R20-18.34 的原句仍在(只新增订正,不改原文)
    expect(bullet('- R20-18.34 **自动入口读取该记录的只读协议**')).toContain(
      '读取失败 / 超时 / 不可读一律视为 `none`',
    );
  });

  it('W0-27 正文写明:读不出与三种来源缺失拒绝增影响、内容类不阻、judge_seen 不参与安全判定、ruleSha256 搬到 rule-hash.ts、未接线', () => {
    const i = SEC24.indexOf('#### W0-27');
    const body = SEC24.slice(i, SEC24.indexOf('#### W0 订正的合法 / 错误示例'));
    for (const must of [
      '`source_proposal` 为 `null` / 缺失',
      '`run_gone`',
      '`TAINTED` 标记读不出',
      '本 tick 不得增影响',
      '`src/lifecycle/rule-hash.ts`',
      '`no_source`',
      '`source_gone`',
      '`indeterminate`',
      '不接进',
      '`RSI_AUTO_PHASE` 保持 0',
    ]) {
      expect(body, must).toContain(must);
    }
    // 8 个忽略原因都出现在 R20-18.34 的原文里(取值表与契约一致)
    const r34 = bullet('- R20-18.34 **自动入口读取该记录的只读协议**');
    for (const r of JUDGE_IGNORE_REASONS) expect(r34, r).toContain(r);
  });
});
