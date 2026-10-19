import { describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import {
  ATTEST_METHODS,
  AcceptanceProtocolSchema,
  AttestSchema,
  CALIBRATION_GAP,
  CALIBRATION_MIN_N,
  JudgeOutputSchema,
  JudgePredictionSchema,
  JudgeRecordSchema,
  KitConfigSchema,
  OverlaySchema,
  PREDICTION_CONFIDENCES,
  PREDICTION_MAX_GRID_SPAN,
  PREDICTION_SHAPE_REASONS,
  ProposalSchema,
  RATIO_GRID,
  STRICT_EXTRA_TILES,
  validatePredictionShape,
} from '../../src/contracts/index.js';
import { readText } from '../../src/io/read-fs.js';

/**
 * K1:预测账 + 验收协议冻结的契约测试。每个负向断言旁边都有正向对照组(防「全拒」也算绿)。
 */

const H = (n: number) => n.toString(16).padStart(64, '0');
const KIT_TOML = new URL('../../kit.toml', import.meta.url).pathname;

const hop = { hop: 'codex', vendor: 'openai', model: 'm', result: 'ok' };
const baseJudge = {
  hops: [hop],
  provider: 'openai',
  vendor: 'openai',
  verdict: 'accept',
  overfit_risk: 'low',
  injection_suspected: false,
  conflicts: [],
};
const goodPrediction = {
  schema_version: 1,
  metric: 'exposure_rate',
  status: 'predicted',
  direction: 'down',
  ratio_lo: 0.25,
  ratio_hi: 0.8,
  confidence: 0.7,
  acceptance_sha256: H(9),
};
const goodAcceptance = {
  schema_version: 1,
  method: 'signature_proxy_v1',
  rule_sha256: H(7),
  signature_sha256: H(8),
  guidance_until: '2026-10-14T03:12:00Z',
  baseline_sha256: H(10),
  judged_at_head: 'a'.repeat(40),
  frozen_at: '2026-10-14T05:40:00Z',
  anchor_min: '2026-10-15',
  tile_days: 7,
  max_tiles: 4,
  sha256: H(9),
};
const goodOutput = {
  verdict: 'accept',
  overfit_risk: 'low',
  generality: 'high',
  volatile: false,
  conflicts: [],
  injection_suspected: false,
  notes: 'n',
};
const baseProposal = {
  id: '2026-10-14-001',
  op: 'add',
  targets: ['a-rule'],
  layer: 'personal',
  rationale: 'r',
  evidence: [{ sig: 'sig_0123456789abcdef', project_key: 'p_fedcba9876543210', excerpt: 'e' }],
  budget_delta_bytes: 10,
  paired_retirements: [],
  cases: [],
  reflector: { provider: 'anthropic', vendor: 'anthropic', model: 'm', run_id: 'run-1' },
};
const goodGuidance = {
  since: '2026-09-01',
  until: '2026-10-14T03:12:00Z',
  baseline: { sessions_total: 412, exposure_sessions: 37, fired: 51 },
};
const kit = {
  kit: { name: 'x', version: '0.1.0' },
  agents: { enabled: ['claude'] },
  budget: {},
  channels: {},
};
const attest = {
  schema_version: 1,
  rule_id: 'a-rule',
  rule_sha256: H(5),
  channel: 'canary',
  member: '@h',
  window_start: '2026-10-15',
  window_end: '2026-10-21',
  kit_version: '0.0.0',
  collector_versions: {},
  sessions_total: 3,
  exposure_sessions: 1,
  exposure_projects: 1,
  fired: 1,
  harmful: 0,
  recurrence: 0,
  signal_ids_digest: 'sha256:' + H(6),
  run_id: 'run-0001',
};

/** 去掉一个键(避免 `const { [k]: _x, ...rest }` 触发 no-unused-vars) */
const omit = (o: Record<string, unknown>, k: string) =>
  Object.fromEntries(Object.entries(o).filter(([key]) => key !== k));

const judgeWith = (extra: Record<string, unknown>) =>
  JudgeRecordSchema.safeParse({ ...baseJudge, ...extra });
const predWith = (extra: Record<string, unknown>) =>
  JudgePredictionSchema.safeParse({ ...goodPrediction, ...extra });
const msgs = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.success ? [] : r.error!.issues.map((i) => i.message);

describe('常量', () => {
  it('网格、置信度、跨度上限与设计一致', () => {
    expect([...RATIO_GRID]).toEqual([0, 0.1, 0.25, 0.5, 0.8, 1.25, 2, 4, 'inf']);
    expect([...PREDICTION_CONFIDENCES]).toEqual([0.5, 0.7, 0.9]);
    expect(PREDICTION_MAX_GRID_SPAN).toBe(3);
  });
  it('校准/加严常量(代码常量,不在 kit.toml 里)', async () => {
    expect(STRICT_EXTRA_TILES).toBe(1);
    expect(CALIBRATION_MIN_N).toBe(10);
    expect(CALIBRATION_GAP).toBe(0.2);
    const toml = await readText(KIT_TOML);
    expect(toml).not.toMatch(/STRICT_EXTRA_TILES|CALIBRATION|strict_extra/i);
  });
  it('acceptance.method 字面量与 ATTEST_METHODS 一致(proposal.ts 不能 import attest.ts,靠本测试钉住)', () => {
    expect([...ATTEST_METHODS]).toEqual(['signature_proxy_v1']);
    for (const m of ATTEST_METHODS) {
      expect(AcceptanceProtocolSchema.safeParse({ ...goodAcceptance, method: m }).success).toBe(
        true,
      );
    }
    expect(
      AcceptanceProtocolSchema.safeParse({ ...goodAcceptance, method: 'other_v1' }).success,
    ).toBe(false);
  });
});

describe('validatePredictionShape', () => {
  const v = (direction: string, lo: unknown, hi: unknown) =>
    validatePredictionShape({ direction, ratio_lo: lo, ratio_hi: hi, confidence: 0.7 });

  it('合法区间返回空数组(正向对照)', () => {
    expect(v('down', 0.25, 0.8)).toEqual([]);
    expect(v('up', 1.25, 'inf')).toEqual([]);
    expect(v('flat', 0.8, 1.25)).toEqual([]);
    expect(v('down', 0, 0.5)).toEqual([]);
  });
  it('跨度:下标差 3 合法,4 非法(边界两侧)', () => {
    // 0.1(1) → 1.25(5) 差 4;0.1(1) → 0.8(4) 差 3
    expect(v('down', 0.1, 0.8)).toEqual([]);
    expect(v('down', 0, 0.8)).toEqual(['span']);
    expect(v('down', 0.25, 2)).toEqual(['span']); // 0.25(2) → 2(6) 差 4
    expect(v('down', 0.25, 1.25)).toEqual([]); // 0.25(2) → 1.25(5) 差 3
  });
  it('lo < hi:lo == hi 与 lo > hi 都是 order', () => {
    expect(v('down', 0.25, 0.5)).toEqual([]);
    expect(v('down', 0.5, 0.5)).toEqual(['order']);
    expect(v('down', 0.5, 0.25)).toEqual(['order']);
  });
  it('离网格:lo/hi 各一例;字符串数字、null、undefined 也算离网格', () => {
    expect(v('down', 0.3, 0.8)).toEqual(['lo_off_grid']);
    expect(v('down', 0.25, 0.7)).toEqual(['hi_off_grid']);
    expect(v('down', '0.25', 0.8)).toEqual(['lo_off_grid']);
    expect(v('down', null, 0.8)).toEqual(['lo_off_grid']);
    expect(v('down', 0.25, undefined)).toEqual(['hi_off_grid']);
  });
  it("'inf' 只能当 hi,不能当 lo;下标比较不会产生 NaN", () => {
    expect(v('up', 4, 'inf')).toEqual([]);
    const r = v('up', 'inf', 'inf');
    expect(r).toContain('lo_inf');
    expect(r).toContain('order');
    expect(v('up', 'inf', 4)).toContain('lo_inf');
  });
  it('方向一致性:down ⇒ lo<0.8(0.8 恰好不行,0.5 行)', () => {
    expect(v('down', 0.5, 'inf')).toEqual(['span']); // 0.5(3)→inf(8) 差 5,仅为凑出对照:方向本身没错
    expect(v('down', 0.5, 1.25)).toEqual([]);
    expect(v('down', 0.8, 1.25)).toEqual(['direction_down']);
    expect(v('down', 0.8, 2)).toEqual(['direction_down']);
  });
  it('方向一致性:up ⇒ hi>1.25(1.25 恰好不行,2 行)', () => {
    expect(v('up', 0.8, 2)).toEqual([]);
    expect(v('up', 0.5, 1.25)).toEqual(['direction_up']);
    expect(v('up', 0.25, 1.25)).toEqual(['direction_up']);
  });
  it('方向一致性:flat ⇒ 闭区间与 [0.8,1.25] 相交(端点相碰算相交)', () => {
    expect(v('flat', 0.5, 0.8)).toEqual([]); // 在 0.8 相碰
    expect(v('flat', 1.25, 2)).toEqual([]); // 在 1.25 相碰
    expect(v('flat', 0.25, 0.5)).toEqual(['direction_flat']);
    expect(v('flat', 2, 4)).toEqual(['direction_flat']);
  });
  it('收集全部违反项,不提前返回', () => {
    // up + lo>hi:order 与 direction_up 同时出现
    const r = v('up', 1.25, 0.5);
    expect(r).toEqual(expect.arrayContaining(['order', 'direction_up']));
    // 未知方向本身是一个原因码(不能整条放行);区间类规则照常
    expect(v('sideways', 0.25, 0.5)).toEqual(['direction_unknown']);
    expect(v('down', 0.25, 0.5)).toEqual([]);
    expect(v(undefined as unknown as string, 0.25, 0.5)).toEqual(['direction_unknown']);
  });
  it('置信度不在枚举:给了就校验,缺省(undefined)不校验', () => {
    const w = (c: unknown) =>
      validatePredictionShape({ direction: 'down', ratio_lo: 0.25, ratio_hi: 0.8, confidence: c });
    expect(w(0.7)).toEqual([]);
    expect(w(0.6)).toEqual(['confidence_off_grid']);
    expect(w('0.7')).toEqual(['confidence_off_grid']);
    expect(w(undefined)).toEqual([]);
  });
  it('flat 居中/贴边的合法区间(正向覆盖,防 direction_flat 的比较被改松/改紧)', () => {
    expect(v('flat', 0.25, 0.8)).toEqual([]);
    expect(v('flat', 0.5, 1.25)).toEqual([]);
    expect(v('flat', 0.8, 1.25)).toEqual([]);
    expect(v('flat', 0.8, 2)).toEqual([]);
    expect(v('flat', 0.5, 2)).toEqual([]);
  });
  it('返回的原因码都在登记的枚举里', () => {
    const all = [
      v('down', 0.3, 0.7),
      v('up', 'inf', 0.5),
      v('flat', 2, 4),
      v('down', 0, 0.8),
      v('down', 0.8, 2),
      v('sideways', 0.25, 0.5),
      validatePredictionShape({ direction: 'down', ratio_lo: 0.25, ratio_hi: 0.8, confidence: 1 }),
    ].flat();
    expect(all.length).toBeGreaterThan(0);
    for (const r of all) expect(PREDICTION_SHAPE_REASONS).toContain(r);
  });
});

describe('JudgeOutput.prediction', () => {
  const good = { direction: 'down', ratio_lo: 0.25, ratio_hi: 0.8, confidence: 0.7 };
  const out = (p: unknown) => JudgeOutputSchema.safeParse({ ...goodOutput, prediction: p });

  it('旧输出(无 prediction)仍通过;合法 prediction 通过', () => {
    expect(JudgeOutputSchema.safeParse(goodOutput).success).toBe(true);
    expect(out(good).success).toBe(true);
    expect(out({ direction: 'up', ratio_lo: 1.25, ratio_hi: 'inf', confidence: 0.9 }).success).toBe(
      true,
    );
  });
  it.each([
    ['置信度 0.6', { confidence: 0.6 }],
    ['置信度 1', { confidence: 1 }],
    ['离网格 lo', { ratio_lo: 0.3 }],
    ['离网格 hi', { ratio_hi: 0.9 }],
    ['lo>=hi', { ratio_lo: 0.5, ratio_hi: 0.5 }],
    ['跨度 4', { ratio_lo: 0, ratio_hi: 0.8 }],
    ['方向矛盾', { direction: 'up' }],
    ['方向不在枚举', { direction: 'sideways' }],
    ["lo='inf'", { direction: 'up', ratio_lo: 'inf', ratio_hi: 'inf' }],
    ['ratio 用 Infinity', { direction: 'up', ratio_lo: 1.25, ratio_hi: Infinity }],
    ['未知键', { extra: 1 }],
  ])('非法被拒:%s', (_n, patch) => {
    expect(out({ ...good, ...patch }).success).toBe(false);
  });
  it('缺任一必填键被拒', () => {
    for (const k of Object.keys(good)) {
      const rest = omit(good as Record<string, unknown>, k);
      expect(out(rest).success, k).toBe(false);
    }
  });
  it('形状错误的消息带 prediction_invalid:<原因码>', () => {
    const r = out({ ...good, ratio_lo: 0, ratio_hi: 0.8 });
    expect(msgs(r)).toContain('prediction_invalid:span');
  });
  it('issue.path 指向真正出错的字段', () => {
    const paths = (p: unknown) => {
      const r = out(p);
      return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
    };
    // 离网格的 hi 不能被记到 ratio_lo 上(LLM 重试提示要按字段指路)
    expect(paths({ ...good, ratio_hi: 0.7 }).filter((x) => x.startsWith('prediction'))).toEqual([
      'prediction.ratio_hi',
    ]);
    expect(paths({ ...good, ratio_lo: 'inf', ratio_hi: 'inf', direction: 'up' })).toContain(
      'prediction.ratio_lo',
    );
    expect(paths({ ...good, ratio_lo: 0, ratio_hi: 0.8 })).toEqual(['prediction.ratio_hi']); // span
    expect(paths({ ...good, direction: 'up' })).toEqual(['prediction.direction']);
    expect(paths(good)).toEqual([]);
  });
  it('网格点与置信度的 zod 字面量联合与导出常量逐项一致(防两处写漏)', () => {
    const lo = (g: unknown) =>
      JudgeOutputSchema.safeParse({
        ...goodOutput,
        prediction: { direction: 'down', ratio_lo: g, ratio_hi: 'inf', confidence: 0.5 },
      });
    // 逐个网格点作为 lo:除 'inf' 外,schema 层都不应因「不是网格点」而拒(其余规则另说,看 path 即可)
    for (const g of RATIO_GRID) {
      const r = lo(g);
      const offGrid =
        !r.success &&
        r.error.issues.some(
          (i) => i.code !== 'custom' && i.path.join('.') === 'prediction.ratio_lo',
        );
      expect(offGrid, String(g)).toBe(false);
    }
    expect(lo(0.3).success).toBe(false);
    for (const c of PREDICTION_CONFIDENCES) {
      expect(
        JudgePredictionSchema.safeParse({ ...goodPrediction, confidence: c }).success,
        String(c),
      ).toBe(true);
    }
    expect(JudgePredictionSchema.safeParse({ ...goodPrediction, confidence: 0.8 }).success).toBe(
      false,
    );
  });
  it('外层仍是 strictObject', () => {
    expect(JudgeOutputSchema.safeParse({ ...goodOutput, extra: 1 }).success).toBe(false);
  });
});

describe('JudgeRecord.prediction', () => {
  it('旧记录(无 prediction/acceptance)仍通过;带 predicted 记录通过', () => {
    expect(judgeWith({}).success).toBe(true);
    expect(judgeWith({ prediction: goodPrediction }).success).toBe(true);
  });
  it('status=predicted 缺任一预测值被拒(逐键)', () => {
    for (const k of ['direction', 'ratio_lo', 'ratio_hi', 'confidence']) {
      const rest = omit(goodPrediction as Record<string, unknown>, k);
      const r = JudgePredictionSchema.safeParse(rest);
      expect(r.success, k).toBe(false);
      expect(msgs(r), k).toContain(`prediction_invalid:missing_${k}`);
    }
  });
  it.each(['baseline_insufficient', 'not_measurable'])(
    'status=%s:四值缺省合法;带任一值被拒(逐键)',
    (status) => {
      const bare = { schema_version: 1, metric: 'exposure_rate', status, acceptance_sha256: H(9) };
      expect(JudgePredictionSchema.safeParse(bare).success).toBe(true);
      const vals = { direction: 'down', ratio_lo: 0.25, ratio_hi: 0.8, confidence: 0.7 };
      for (const [k, val] of Object.entries(vals)) {
        const r = JudgePredictionSchema.safeParse({ ...bare, [k]: val });
        expect(r.success, k).toBe(false);
        expect(msgs(r), k).toContain(`prediction_invalid:unexpected_${k}`);
      }
    },
  );
  it.each(['baseline_insufficient', 'not_measurable'])(
    'status=%s 同时带齐四个值也被拒(LLM 值必须被丢弃而非落盘)',
    (status) => {
      expect(predWith({ status }).success).toBe(false);
      expect(predWith({ status: 'predicted' }).success).toBe(true);
    },
  );
  it('predicted 时形状非法被拒(跨度 4 / 方向矛盾);合法对照通过', () => {
    expect(predWith({ ratio_lo: 0, ratio_hi: 0.8 }).success).toBe(false);
    expect(predWith({ direction: 'up' }).success).toBe(false);
    expect(predWith({}).success).toBe(true);
  });
  it('schema_version 只能是 1、metric 只能是 exposure_rate、status 在枚举内', () => {
    expect(predWith({ schema_version: 2 }).success).toBe(false);
    expect(predWith({ schema_version: 1 }).success).toBe(true);
    expect(predWith({ metric: 'harmful_rate' }).success).toBe(false);
    expect(predWith({ status: 'maybe' }).success).toBe(false);
  });
  it('acceptance_sha256 必填且是 64 位小写 hex', () => {
    const rest = omit(goodPrediction, 'acceptance_sha256');
    expect(JudgePredictionSchema.safeParse(rest).success).toBe(false);
    expect(predWith({ acceptance_sha256: 'ABC' }).success).toBe(false);
    expect(predWith({ acceptance_sha256: 'A'.repeat(64) }).success).toBe(false);
    expect(predWith({ acceptance_sha256: H(1) }).success).toBe(true);
  });
  it('strictObject:prediction 里的未知键被拒;对照:不带未知键通过', () => {
    expect(judgeWith({ prediction: { ...goodPrediction, extra: 1 } }).success).toBe(false);
    expect(judgeWith({ prediction: goodPrediction }).success).toBe(true);
  });
  it('跨字段(prediction.acceptance_sha256 ≠ acceptance.sha256)schema 层不拦,留给 G3', () => {
    const r = judgeWith({
      prediction: { ...goodPrediction, acceptance_sha256: H(1) },
      acceptance: { ...goodAcceptance, sha256: H(2) },
    });
    expect(r.success).toBe(true);
  });
});

describe('JudgeRecord.acceptance', () => {
  const acc = (extra: Record<string, unknown>) =>
    AcceptanceProtocolSchema.safeParse({ ...goodAcceptance, ...extra });

  it('合法协议通过;挂在 JudgeRecord 上也通过', () => {
    expect(acc({}).success).toBe(true);
    expect(judgeWith({ acceptance: goodAcceptance, prediction: goodPrediction }).success).toBe(
      true,
    );
  });
  it('每个字段缺失都被拒(逐键)', () => {
    for (const k of Object.keys(goodAcceptance)) {
      const rest = omit(goodAcceptance as Record<string, unknown>, k);
      expect(AcceptanceProtocolSchema.safeParse(rest).success, k).toBe(false);
    }
  });
  it.each([
    ['schema_version 2', { schema_version: 2 }],
    ['method 未知', { method: 'other' }],
    ['rule_sha256 大写', { rule_sha256: 'A'.repeat(64) }],
    ['signature_sha256 短', { signature_sha256: 'abc' }],
    ['baseline_sha256 非 hex', { baseline_sha256: 'g'.repeat(64) }],
    ['judged_at_head 39 位', { judged_at_head: 'a'.repeat(39) }],
    ['judged_at_head 41 位', { judged_at_head: 'a'.repeat(41) }],
    ['judged_at_head 大写', { judged_at_head: 'A'.repeat(40) }],
    ['guidance_until 不是时间戳', { guidance_until: '2026-10-14' }],
    ['frozen_at 不是时间戳', { frozen_at: 'yesterday' }],
    ['anchor_min 带时间', { anchor_min: '2026-10-15T00:00:00Z' }],
    ['anchor_min 非日期', { anchor_min: '2026-13-99' }],
    ['tile_days 6', { tile_days: 6 }],
    ['tile_days 7.5', { tile_days: 7.5 }],
    ['max_tiles 1', { max_tiles: 1 }],
    ['max_tiles 9', { max_tiles: 9 }],
    ['sha256 大写', { sha256: 'A'.repeat(64) }],
    ['未知键', { extra: 1 }],
  ])('非法被拒:%s', (_n, patch) => {
    expect(acc(patch).success).toBe(false);
  });
  it('边界合法:tile_days=7、max_tiles=2 与 8、tile_days 很大', () => {
    expect(acc({ tile_days: 7 }).success).toBe(true);
    expect(acc({ max_tiles: 2 }).success).toBe(true);
    expect(acc({ max_tiles: 8 }).success).toBe(true);
    expect(acc({ tile_days: 60 }).success).toBe(true);
  });
  it('时钟/锚点一致性 schema 层不拦,留给 G3(guidance_until 晚于 frozen_at 仍可解析)', () => {
    expect(acc({ guidance_until: '2026-10-20T00:00:00Z' }).success).toBe(true);
  });
});

describe('Proposal.reflector.guidance', () => {
  const withG = (g: unknown) =>
    ProposalSchema.safeParse({
      ...baseProposal,
      reflector: { ...baseProposal.reflector, guidance: g },
    });
  it('旧提案(无 guidance)仍通过;合法 guidance 通过;since=null 通过', () => {
    expect(ProposalSchema.safeParse(baseProposal).success).toBe(true);
    expect(withG(goodGuidance).success).toBe(true);
    expect(withG({ ...goodGuidance, since: null }).success).toBe(true);
  });
  it('since 缺省(undefined)被拒:要么日期要么显式 null', () => {
    const rest = omit(goodGuidance, 'since');
    expect(withG(rest).success).toBe(false);
  });
  it.each([
    ['since 带时间', { since: '2026-09-01T00:00:00Z' }],
    ['until 只有日期', { until: '2026-10-14' }],
    ['基线负数', { baseline: { sessions_total: -1, exposure_sessions: 0, fired: 0 } }],
    ['基线小数', { baseline: { sessions_total: 1.5, exposure_sessions: 0, fired: 0 } }],
    ['基线缺 fired', { baseline: { sessions_total: 1, exposure_sessions: 0 } }],
    ['基线多键', { baseline: { sessions_total: 1, exposure_sessions: 0, fired: 0, harmful: 0 } }],
    ['未知键', { extra: 1 }],
  ])('非法被拒:%s', (_n, patch) => {
    expect(withG({ ...goodGuidance, ...patch }).success).toBe(false);
  });
  it('基线自洽(exposure > total)schema 层不拦,留给 G3', () => {
    expect(
      withG({
        ...goodGuidance,
        baseline: { sessions_total: 1, exposure_sessions: 5, fired: 0 },
      }).success,
    ).toBe(true);
  });
  it('reflector 仍是 strictObject;整份提案带全部新字段通过', () => {
    expect(
      ProposalSchema.safeParse({
        ...baseProposal,
        reflector: { ...baseProposal.reflector, nope: 1 },
      }).success,
    ).toBe(false);
    const full = ProposalSchema.safeParse({
      ...baseProposal,
      reflector: { ...baseProposal.reflector, guidance: goodGuidance },
      judge: {
        ...baseJudge,
        vendor: 'openai',
        rule_sha256: H(7),
        prediction: goodPrediction,
        acceptance: goodAcceptance,
      },
    });
    expect(full.success, JSON.stringify(full)).toBe(true);
  });
});

describe('Attest.acceptance_sha256', () => {
  const a = (extra: Record<string, unknown>) => AttestSchema.safeParse({ ...attest, ...extra });
  it('旧文件(无该字段)仍通过;合法 hex 通过', () => {
    expect(a({}).success).toBe(true);
    expect(a({ acceptance_sha256: H(9) }).success).toBe(true);
  });
  it.each([
    ['大写', 'A'.repeat(64)],
    ['太短', 'abc'],
    ['63 位', 'a'.repeat(63)],
    ['65 位', 'a'.repeat(65)],
    ['sha256: 前缀', 'sha256:' + H(9)],
    ['非 hex', 'g'.repeat(64)],
  ])('非法被拒:%s', (_n, val) => {
    expect(a({ acceptance_sha256: val }).success).toBe(false);
  });
  it('仍是 strictObject:未知键被拒', () => {
    expect(a({ acceptance_sha256x: H(9) }).success).toBe(false);
  });
});

describe('KitConfig.lifecycle 的 acceptance_tile_days / acceptance_max_tiles', () => {
  const cfg = (lifecycle: Record<string, unknown>) =>
    KitConfigSchema.safeParse({ ...kit, lifecycle });

  it('缺省:lifecycle 不出现 / 空段 / 不写新键,都合法且默认 7 / 4', () => {
    expect(KitConfigSchema.safeParse(kit).success).toBe(true);
    const r = KitConfigSchema.parse({ ...kit, lifecycle: {} });
    expect(r.lifecycle?.acceptance_tile_days).toBe(7);
    expect(r.lifecycle?.acceptance_max_tiles).toBe(4);
    expect(cfg({ canary_window_days: 14, min_members: 3 }).success).toBe(true);
  });
  it('旧 kit.toml(无新键)仍通过', async () => {
    const parsed = parseToml(await readText(KIT_TOML));
    const r = KitConfigSchema.safeParse(parsed);
    expect(r.success, JSON.stringify(r)).toBe(true);
  });
  it('refine 边界:14/7/4 合法(2+1≤4);21/7/4 合法(3+1≤4);22/7/4 与 28/7/4 非法', () => {
    expect(
      cfg({ canary_window_days: 14, acceptance_tile_days: 7, acceptance_max_tiles: 4 }).success,
    ).toBe(true);
    expect(
      cfg({ canary_window_days: 21, acceptance_tile_days: 7, acceptance_max_tiles: 4 }).success,
    ).toBe(true);
    for (const days of [22, 28]) {
      const r = cfg({
        canary_window_days: days,
        acceptance_tile_days: 7,
        acceptance_max_tiles: 4,
      });
      expect(r.success, String(days)).toBe(false);
      expect(r.error!.issues.map((i) => i.path.join('.'))).toEqual([
        'lifecycle.acceptance_max_tiles',
      ]);
    }
  });
  it('refine 用默认值也生效:只写 canary_window_days=28 同样非法', () => {
    expect(cfg({ canary_window_days: 28 }).success).toBe(false);
    expect(cfg({ canary_window_days: 21 }).success).toBe(true);
  });
  it('调大 tile 或 max_tiles 可让长 canary 窗口合法', () => {
    expect(
      cfg({ canary_window_days: 28, acceptance_tile_days: 7, acceptance_max_tiles: 5 }).success,
    ).toBe(true);
    expect(
      cfg({ canary_window_days: 28, acceptance_tile_days: 14, acceptance_max_tiles: 4 }).success,
    ).toBe(true);
    expect(
      cfg({ canary_window_days: 28, acceptance_tile_days: 7, acceptance_max_tiles: 4 }).success,
    ).toBe(false);
  });
  it('max_tiles 取 8 的极限:ceil(49/7)+1=8 合法,ceil(50/7)+1=9 非法', () => {
    expect(
      cfg({ canary_window_days: 49, acceptance_tile_days: 7, acceptance_max_tiles: 8 }).success,
    ).toBe(true);
    expect(
      cfg({ canary_window_days: 50, acceptance_tile_days: 7, acceptance_max_tiles: 8 }).success,
    ).toBe(false);
  });
  it.each([
    ['acceptance_tile_days', 6],
    ['acceptance_tile_days', 7.5],
    ['acceptance_max_tiles', 1],
    ['acceptance_max_tiles', 9],
    ['acceptance_max_tiles', 4.5],
  ])('%s=%s 被拒(下界/上界/整数)', (k, v) => {
    const r = cfg({ [k]: v });
    expect(r.success).toBe(false);
    // 拒因必须是这个键本身(拼错的键会因 strictObject 而假绿)
    expect([...new Set(r.error!.issues.map((i) => i.path.join('.')))]).toEqual([`lifecycle.${k}`]);
  });
  it('边界值本身合法:tile_days=7、max_tiles=2(14 天窗口下 2+1>2 → 与 refine 联动被拒)与 3、8', () => {
    expect(cfg({ acceptance_tile_days: 7 }).success).toBe(true);
    expect(cfg({ acceptance_max_tiles: 2 }).success).toBe(false); // 默认 canary=14 ⇒ 需要 3
    expect(cfg({ acceptance_max_tiles: 3 }).success).toBe(true);
    expect(cfg({ acceptance_max_tiles: 8 }).success).toBe(true);
  });
  it('既有校验不受影响:未知键被拒、min_non_owner_members > min_members 被拒;覆盖层仍不接受 lifecycle', () => {
    expect(cfg({ x: 1 }).success).toBe(false);
    expect(cfg({ min_members: 2, min_non_owner_members: 3 }).success).toBe(false);
    expect(cfg({ min_members: 3, min_non_owner_members: 2 }).success).toBe(true);
    expect(OverlaySchema.safeParse({ lifecycle: { acceptance_tile_days: 7 } }).success).toBe(false);
    expect(OverlaySchema.safeParse({ channel: 'canary' }).success).toBe(true);
  });
  it('refine 用的就是 STRICT_EXTRA_TILES:边界 14/7 的 max_tiles 下限 = ceil(14/7)+常量', () => {
    const need = Math.ceil(14 / 7) + STRICT_EXTRA_TILES;
    expect(cfg({ acceptance_max_tiles: need }).success).toBe(true);
    expect(cfg({ acceptance_max_tiles: need - 1 }).success).toBe(false);
  });
});
