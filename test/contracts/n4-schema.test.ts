/**
 * N4 ①:`JudgeRecord` 判别联合、`reflector.confirmed`、码表与 payload(docs/contracts.md R20-18.13 ~ R20-18.16、R20-18.23)。
 * 负向用例断言具体的拒绝原因(路径 / 消息),旁边放正向对照。
 */
import { describe, expect, it } from 'vitest';
import {
  JudgeRecordSchema,
  ProposalSchema,
  effectiveReflectorVendor,
} from '../../src/contracts/proposal.js';
import {
  JUDGE_FAIL_CLOSED_REASONS,
  JUDGE_INGEST_REASONS,
  JUDGE_USAGE_REASONS,
  JudgeIngestPayloadSchema,
  OUTPUT_REJECTION_TO_REASON,
  outputRejectionReason,
} from '../../src/contracts/judge-ingest.js';
import { judgeBindingSha256, reflectorBindingSha256 } from '../../src/contracts/judge-binding.js';
import { readTextSync } from '../../src/io/read-fs.js';
import {
  baseProposal,
  H,
  sessionDeclared,
  withReflectorConfirmed,
  withSessionJudge,
  withSpawnedJudge,
} from './n4-fixtures.js';

const issuesOf = (r: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string }[] };
}) => (r.error?.issues ?? []).map((i) => `${i.path.join('.')}|${i.message}`);

const spawnedRaw = (extra: Record<string, unknown> = {}) => ({
  hops: [{ hop: 'codex', vendor: 'openai', model: 'm', result: 'ok' }],
  provider: 'codex',
  vendor: 'openai',
  verdict: 'accept',
  overfit_risk: 'low',
  injection_suspected: false,
  conflicts: [],
  ...extra,
});

describe('R20-18.13 判别联合与缺省补键', () => {
  it('旧记录(无 provenance)继续合法且按 spawned 解析;显式 spawned 同样合法', () => {
    const a = JudgeRecordSchema.parse(spawnedRaw());
    expect(a.provenance).toBe('spawned');
    expect(JudgeRecordSchema.safeParse(spawnedRaw({ provenance: 'spawned' })).success).toBe(true);
  });
  it('preprocess 先于校验:显式 provenance: null / 未知值 → 拒(不被缺省补键吞掉)', () => {
    expect(JudgeRecordSchema.safeParse(spawnedRaw({ provenance: null })).success).toBe(false);
    expect(JudgeRecordSchema.safeParse(spawnedRaw({ provenance: 'bogus' })).success).toBe(false);
    expect(JudgeRecordSchema.safeParse(spawnedRaw({ provenance: 'Spawned' })).success).toBe(false);
  });
  it('session_confirmed:只收自己的键;混进 spawned 独有键(hops / provider / vendor)→ 拒', () => {
    const p = withSessionJudge(baseProposal());
    const rec = p.judge as Record<string, unknown>;
    expect(JudgeRecordSchema.safeParse(rec).success).toBe(true);
    for (const k of ['hops', 'provider', 'vendor', 'prompt_id']) {
      const bad = JudgeRecordSchema.safeParse({ ...rec, [k]: k === 'hops' ? [] : 'x' });
      expect(bad.success, k).toBe(false);
      expect(
        issuesOf(bad).some((m) => m.includes(`"${k}"`)),
        k,
      ).toBe(true);
    }
  });
  it('session_confirmed 的必填:rule_sha256 / prediction / acceptance / declared / confirmation 缺一个都拒', () => {
    const rec = withSessionJudge(baseProposal()).judge as Record<string, unknown>;
    for (const k of ['rule_sha256', 'prediction', 'acceptance', 'declared', 'confirmation']) {
      const { [k]: _omit, ...rest } = rec;
      void _omit;
      const r = JudgeRecordSchema.safeParse(rest);
      expect(r.success, k).toBe(false);
      expect(
        issuesOf(r).some((m) => m.startsWith(k)),
        k,
      ).toBe(true);
    }
  });
  it('spawned 的 superRefine 原样保留:hops 链、最后一跳 ok', () => {
    const bad = JudgeRecordSchema.safeParse(
      spawnedRaw({ hops: [{ hop: 'glm', vendor: 'zhipu', model: 'm', result: 'ok' }] }),
    );
    expect(issuesOf(bad).join(';')).toContain('hops.0.hop|hops 必须是兜底链');
  });
});

describe('R20-18.14 reflector.confirmed', () => {
  it('只允许出现在 session_declared 提案上;出现在 spawned / 缺省提案上 → schema 失败', () => {
    const ok = withReflectorConfirmed(sessionDeclared(), {
      vendor: 'openai',
      model: 'gpt-example',
    });
    expect(ok.reflector.confirmed?.vendor).toBe('openai');
    // 正向对照:同一份 confirmed 放在 spawned 提案上 → 拒,原因指向 reflector.confirmed
    const raw = JSON.parse(JSON.stringify(ok)) as { reflector: Record<string, unknown> };
    for (const prov of ['spawned', undefined]) {
      const r = ProposalSchema.safeParse({
        ...raw,
        reflector: {
          ...raw.reflector,
          ...(prov === undefined ? { provenance: undefined } : { provenance: prov }),
        },
      });
      expect(r.success, String(prov)).toBe(false);
      expect(issuesOf(r)).toContain(
        'reflector.confirmed|reflector.confirmed 只允许出现在 provenance=session_declared 的提案上',
      );
    }
  });
  it('confirmed 的 strictObject:未知键 / 非规范厂商 id / 非法模型串 / 坏 binding → 拒', () => {
    const ok = withReflectorConfirmed(sessionDeclared(), {
      vendor: 'openai',
      model: 'gpt-example',
    });
    const raw = JSON.parse(JSON.stringify(ok)) as {
      reflector: { confirmed: Record<string, unknown> };
    };
    const mut = (c: Record<string, unknown>) =>
      ProposalSchema.safeParse({
        ...raw,
        reflector: { ...raw.reflector, confirmed: { ...raw.reflector.confirmed, ...c } },
      });
    expect(mut({}).success).toBe(true);
    expect(mut({ extra: 1 }).success).toBe(false);
    expect(mut({ vendor: 'OpenAI' }).success).toBe(false);
    expect(mut({ model: 'Has Space' }).success).toBe(false);
    expect(mut({ binding_sha256: 'zz' }).success).toBe(false);
    expect(mut({ method: 'typed' }).success).toBe(false);
  });
  it('judge_attempts 的同厂商比较用有效反思器厂商(confirmed.vendor),否则确认后写出的 judge_attempts 会被自己的 schema 拒绝', () => {
    const p = withReflectorConfirmed(sessionDeclared(), { vendor: 'openai', model: 'gpt-example' });
    expect(effectiveReflectorVendor(p.reflector)).toBe('openai');
    expect(effectiveReflectorVendor(sessionDeclared().reflector)).toBe('unknown');
    const attempts = (sameVendorResult: string) => [
      { hop: 'codex', vendor: 'openai', model: 'gpt-example', result: sameVendorResult },
      { hop: 'maas-deepseek', vendor: 'deepseek', model: 'd', result: 'error:not_configured' },
      { hop: 'glm', vendor: 'zhipu', model: 'g', result: 'error:not_configured' },
      { hop: 'kimi', vendor: 'moonshot', model: 'k', result: 'error:not_configured' },
      { hop: 'official-deepseek', vendor: 'deepseek', model: 'd', result: 'error:not_configured' },
    ];
    const withAttempts = (r: string) =>
      ProposalSchema.safeParse({ ...JSON.parse(JSON.stringify(p)), judge_attempts: attempts(r) });
    expect(withAttempts('skipped:same-vendor').success).toBe(true);
    const bad = withAttempts('error:not_configured');
    expect(issuesOf(bad)).toContain(
      'judge_attempts.0.result|与反思器同厂商的跳必须记为 skipped:same-vendor',
    );
  });
  it('session_confirmed 分支不适用 hops / vendor 的 superRefine(不因缺 hops 抛错)', () => {
    expect(() =>
      withSessionJudge(
        withReflectorConfirmed(sessionDeclared(), { vendor: 'anthropic', model: 'claude-x' }),
      ),
    ).not.toThrow();
  });
});

describe('R20-18.15 binding_sha256', () => {
  it('judge 侧:改任一语义字段而不改 binding → 重算不等;搬到别的提案 / run 上 → 不等', () => {
    const p = withSessionJudge(baseProposal());
    const j = p.judge as Extract<NonNullable<typeof p.judge>, { provenance: 'session_confirmed' }>;
    expect(judgeBindingSha256(p, j)).toBe(j.confirmation.binding_sha256);
    expect(judgeBindingSha256(p, { ...j, verdict: 'reject' })).not.toBe(
      j.confirmation.binding_sha256,
    );
    expect(
      judgeBindingSha256(p, { ...j, declared: { ...j.declared, vendor: 'anthropic' } }),
    ).not.toBe(j.confirmation.binding_sha256);
    expect(judgeBindingSha256(p, { ...j, rule_sha256: H(99) })).not.toBe(
      j.confirmation.binding_sha256,
    );
    expect(judgeBindingSha256({ ...p, id: '2026-10-12-002' }, j)).not.toBe(
      j.confirmation.binding_sha256,
    );
    expect(
      judgeBindingSha256({ ...p, reflector: { ...p.reflector, run_id: 'run-0002' } }, j),
    ).not.toBe(j.confirmation.binding_sha256);
    // binding 自身不在原像里:换掉它不影响重算
    expect(
      judgeBindingSha256(p, { ...j, confirmation: { ...j.confirmation, binding_sha256: H(1) } }),
    ).toBe(j.confirmation.binding_sha256);
  });
  it('反思器侧:改 confirmed 的值或 reflector 的其它字段 → 不等;没有 confirmed → undefined', () => {
    const p = withReflectorConfirmed(sessionDeclared(), { vendor: 'openai', model: 'gpt-example' });
    const b = p.reflector.confirmed!.binding_sha256;
    expect(reflectorBindingSha256(p)).toBe(b);
    expect(
      reflectorBindingSha256({
        ...p,
        reflector: { ...p.reflector, confirmed: { ...p.reflector.confirmed!, vendor: 'google' } },
      }),
    ).not.toBe(b);
    expect(
      reflectorBindingSha256({ ...p, reflector: { ...p.reflector, backend: 'codex' } }),
    ).not.toBe(b);
    expect(reflectorBindingSha256(sessionDeclared())).toBeUndefined();
  });
});

describe('R20-18.23 码表与 payload', () => {
  const doc = readTextSync(new URL('../../docs/contracts.md', import.meta.url).pathname);
  const sectionOf = (): string => {
    const i = doc.indexOf('- R20-18.23 **`JUDGE_INGEST_REJECTED` 子码封闭集合**');
    return doc.slice(i, doc.indexOf('\n', i));
  };
  it('JUDGE_INGEST_REASONS 与文档逐项对拍(不多不少)', () => {
    const line = sectionOf();
    const documented = [...line.matchAll(/`([a-z_]+)`/g)]
      .map((m) => m[1] as string)
      .filter((x) => (JUDGE_INGEST_REASONS as readonly string[]).includes(x));
    expect(new Set(documented)).toEqual(new Set(JUDGE_INGEST_REASONS));
    expect(JUDGE_INGEST_REASONS.length).toBe(19);
  });
  it('§20.18-5 表的 usage / fail-closed 词表与枚举一致', () => {
    const start = doc.indexOf('JUDGE_USAGE reason=<码>');
    const t = doc.slice(start, doc.indexOf('多结果合并走 `combineExitCodes`', start));
    expect(t.length).toBeGreaterThan(100);
    for (const r of JUDGE_USAGE_REASONS) expect(t, r).toContain(r);
    for (const r of JUDGE_FAIL_CLOSED_REASONS) expect(t, r).toContain(r);
  });
  it('parseJudgeOutput 的全部拒绝码都在映射表里,映射值都属于本枚举;未登记值兜底 schema_invalid', () => {
    const codes = [
      'too_large',
      'not_json',
      'not_object',
      'schema',
      'prediction_invalid',
      'notes_too_long',
      'conflicts_invalid',
      'placeholder',
      'residual',
    ];
    for (const c of codes) {
      expect(Object.keys(OUTPUT_REJECTION_TO_REASON), c).toContain(c);
      expect(JUDGE_INGEST_REASONS as readonly string[]).toContain(outputRejectionReason(c));
    }
    expect(Object.keys(OUTPUT_REJECTION_TO_REASON).sort()).toEqual([...codes].sort());
    expect(outputRejectionReason('brand_new_code')).toBe('schema_invalid');
    expect(outputRejectionReason('__proto__')).toBe('schema_invalid');
  });
  it('payload 信封:strictObject;verdicts 1..5 条;id / hash 格式', () => {
    const ok = {
      schema: 'judge-ingest-v1',
      run_id: 'run-0001',
      declared: { agent: 'codex', vendor: 'openai', model: 'm' },
      verdicts: [{ id: '2026-10-12-001', rule_sha256: H(7), output: {} }],
    };
    expect(JudgeIngestPayloadSchema.safeParse(ok).success).toBe(true);
    expect(JudgeIngestPayloadSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(JudgeIngestPayloadSchema.safeParse({ ...ok, verdicts: [] }).success).toBe(false);
    expect(
      JudgeIngestPayloadSchema.safeParse({
        ...ok,
        verdicts: Array.from({ length: 6 }, () => ok.verdicts[0]),
      }).success,
    ).toBe(false);
    expect(
      JudgeIngestPayloadSchema.safeParse({
        ...ok,
        verdicts: [{ ...ok.verdicts[0], rule_sha256: 'ABC' }],
      }).success,
    ).toBe(false);
    expect(JudgeIngestPayloadSchema.safeParse({ ...ok, schema: 'judge-ingest-v2' }).success).toBe(
      false,
    );
  });
});

describe('旧记录兼容(R20-18.16)', () => {
  it('spawned 提案经 withSpawnedJudge 构造,provenance 被补成 spawned', () => {
    expect(withSpawnedJudge(baseProposal()).judge?.provenance).toBe('spawned');
  });
});
