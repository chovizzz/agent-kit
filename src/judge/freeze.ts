/**
 * 预测账与验收协议冻结的确定性计算(K3,RSI 借鉴 §1.2 / §2.3;契约见 docs/contracts.md §18.8)。
 * 全部由 kit 计算,LLM 只提供 direction / ratio_lo / ratio_hi / confidence 四个值。纯函数,不读盘、不联网。
 *
 * 哈希口径(K4 的 G3 须用同一口径重算):`sha256(canonicalJson(对象)) `的小写 hex,其中 canonicalJson 是
 * `src/io/canonical-json.ts`(键按码元序排序、2 空格缩进、LF、末尾一个换行)对**UTF-8 字符串**的整体哈希。
 * - 自哈希 `acceptance.sha256`:对象 = acceptance 去掉 `sha256` 键后的**全部**其余字段(不挑字段,将来加字段自动覆盖)。
 * - `signature_sha256`:对象 = `{type, pattern?}`(pattern 缺省则不带该键);原子没有 signature 时对象 = `null`。
 * - `baseline_sha256`:对象 = `reflector.guidance` 原样;提案没有 guidance(旧暂存提案)时对象 = `null`。
 */
import { createHash } from 'node:crypto';
import { addDays } from '../atoms/dates.js';
import type {
  AcceptanceProtocol,
  JudgePrediction,
  PredictionValues,
  ReflectorGuidance,
} from '../contracts/proposal.js';
import { canonicalJson } from '../io/canonical-json.js';
import { JudgeStateError } from './errors.js';

/** 引导窗口会话数下界:低于它(或曝光会话 < 3)不要求预测 */
export const BASELINE_MIN_SESSIONS = 20;
export const BASELINE_MIN_EXPOSURE_SESSIONS = 3;

export type FreezeStatus = JudgePrediction['status'];

export function sha256OfCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function signatureSha256(
  sig: { readonly type: string; readonly pattern?: string | undefined } | undefined,
): string {
  if (sig === undefined) return sha256OfCanonical(null);
  return sha256OfCanonical({
    type: sig.type,
    ...(sig.pattern !== undefined ? { pattern: sig.pattern } : {}),
  });
}

export function guidanceSha256(guidance: ReflectorGuidance | undefined): string {
  return sha256OfCanonical(guidance === undefined ? null : guidance);
}

/** 自哈希:去掉 `sha256` 键后的全部字段的 canonical JSON 哈希。 */
export function acceptanceSha256(
  a: Omit<AcceptanceProtocol, 'sha256'> | AcceptanceProtocol,
): string {
  const { sha256: _self, ...rest } = a as AcceptanceProtocol;
  void _self;
  return sha256OfCanonical(rest);
}

/**
 * 预测状态,由 kit 决定(设计 §1.2):
 * - not_measurable:没有签名,或签名是 `path` / `always` 型(attest 本来就退出 4 / 曝光率恒为 1);
 * - baseline_insufficient:没有引导窗口落账(旧暂存提案),或 sessions_total < 20,或 exposure_sessions < 3;
 * - 否则 predicted。
 * not_measurable 优先于 baseline_insufficient。
 */
export function decidePredictionStatus(
  signature: { readonly type: string } | undefined,
  guidance: ReflectorGuidance | undefined,
): FreezeStatus {
  if (signature === undefined || signature.type === 'path' || signature.type === 'always') {
    return 'not_measurable';
  }
  if (
    guidance === undefined ||
    guidance.baseline.sessions_total < BASELINE_MIN_SESSIONS ||
    guidance.baseline.exposure_sessions < BASELINE_MIN_EXPOSURE_SESSIONS
  ) {
    return 'baseline_insufficient';
  }
  return 'predicted';
}

/** 去掉毫秒的 UTC 时间戳(`2026-10-14T05:40:00Z`) */
export function isoSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export interface FreezeInput {
  readonly ruleSha256: string;
  readonly signature: { readonly type: string; readonly pattern?: string | undefined } | undefined;
  readonly guidance: ReflectorGuidance | undefined;
  /** judge 运行时仓库 HEAD 的提交 oid */
  readonly headOid: string;
  readonly now: Date;
  readonly tileDays: number;
  readonly maxTiles: number;
}

/**
 * 组装冻结的验收协议。
 * - `guidance_until`:取 `reflector.guidance.until`;旧暂存提案没有 guidance 时取 `frozen_at`(此时 status 必为
 *   baseline_insufficient,基线哈希对应 `null`);
 * - `anchor_min` = max(guidance_until, frozen_at) 的 UTC 日 + 1 天(与引导期不共享任何一天);
 * - judge 时钟早于 guidance_until(时钟回拨/偏斜)→ 抛 JudgeStateError(退出 3),
 *   不写一份 G3 必然判 ACCEPTANCE_CLOCK_INCONSISTENT 的冻结记录。
 */
export function buildAcceptance(i: FreezeInput): AcceptanceProtocol {
  const frozenAt = isoSeconds(i.now);
  const guidanceUntil = i.guidance?.until ?? frozenAt;
  const untilMs = Date.parse(guidanceUntil);
  const frozenMs = Date.parse(frozenAt);
  if (Number.isNaN(untilMs) || untilMs > frozenMs) {
    throw new JudgeStateError('JUDGE_STATE_INVALID: guidance.until 晚于 judge 时钟,拒绝冻结');
  }
  const latest = new Date(Math.max(untilMs, frozenMs)).toISOString().slice(0, 10);
  const body: Omit<AcceptanceProtocol, 'sha256'> = {
    schema_version: 1,
    method: 'signature_proxy_v1',
    rule_sha256: i.ruleSha256,
    signature_sha256: signatureSha256(i.signature),
    guidance_until: guidanceUntil,
    baseline_sha256: guidanceSha256(i.guidance),
    judged_at_head: i.headOid,
    frozen_at: frozenAt,
    anchor_min: addDays(latest, 1),
    tile_days: i.tileDays,
    max_tiles: i.maxTiles,
  };
  return { ...body, sha256: acceptanceSha256(body) };
}

/** 落进 `judge.prediction` 的记录:`predicted` 带 LLM 的四个值,其余 status 四值缺省。 */
export function buildPrediction(
  status: FreezeStatus,
  values: PredictionValues | undefined,
  acceptance: AcceptanceProtocol,
): JudgePrediction {
  const base = {
    schema_version: 1 as const,
    metric: 'exposure_rate' as const,
    status,
  };
  if (status !== 'predicted') return { ...base, acceptance_sha256: acceptance.sha256 };
  if (values === undefined) throw new JudgeStateError('JUDGE_STATE_INVALID: predicted 缺少预测值');
  return {
    ...base,
    direction: values.direction,
    ratio_lo: values.ratio_lo,
    ratio_hi: values.ratio_hi,
    confidence: values.confidence,
    acceptance_sha256: acceptance.sha256,
  };
}
