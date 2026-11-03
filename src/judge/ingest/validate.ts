/**
 * `judge --ingest` payload 的纯校验(R20-18.9 ④;不读盘、不拿锁、无 IO)。
 * 校验按序,首个不过 → 整批拒(严格批次);拒绝原因只有 {@link JUDGE_INGEST_REASONS} 里的封闭子码,不回显 payload 内容。
 * 与运行状态相关的检查(run 里有没有这条提案、规则哈希、已存在裁决、同厂商、conflicts 是否为真实原子 id、prediction 是否必填)在 `plan.ts`。
 *
 * 顺序(N4i-7 登记):input_too_large → not_json_object → hidden_chars_in_output(整份原文)→ schema_invalid → run_mismatch →
 * declared_invalid → declared_vendor_conflict。`output` 逐条复用 `parseJudgeOutput`,在 `plan.ts` 里按提案顺序做。
 */
import { createHash } from 'node:crypto';
import {
  JudgeIngestPayloadSchema,
  MAX_INGEST_INPUT_BYTES,
  type JudgeIngestPayload,
  type JudgeIngestReason,
} from '../../contracts/judge-ingest.js';
import {
  CONFIRMED_MODEL_RE,
  BUILTIN_VENDORS,
  UNKNOWN_VENDOR,
  deriveVendor,
} from '../../contracts/vendor.js';
import { findInvisibleRanges } from '../../lifecycle/invisible.js';
import { hasInvisible } from '../../reflect/text.js';

/** hasInvisible 尚未覆盖的字符(与 `criteria.ts` 的 EXTRA_INVISIBLE_RE 同一集合) */
const EXTRA_INVISIBLE_RE = /[\u{E0100}-\u{E01EF}؜︀-️ㅤᅟᅠﾠ]/u;

/** 任何不可见 / 隐藏字符(C1b 口径) */
export function hasHiddenChars(text: string): boolean {
  return (
    hasInvisible(text) || EXTRA_INVISIBLE_RE.test(text) || findInvisibleRanges(text).length > 0
  );
}

export interface ValidatedPayload {
  readonly payload: JudgeIngestPayload;
  readonly sha256: string;
  /** 折成小写后的声明模型串(落盘值) */
  readonly declaredModel: string;
}

export type Validation =
  | { readonly ok: true; readonly value: ValidatedPayload }
  | { readonly ok: false; readonly reason: JudgeIngestReason };

export function validatePayload(text: string, runId: string): Validation {
  const no = (reason: JudgeIngestReason): Validation => ({ ok: false, reason });
  if (Buffer.byteLength(text, 'utf8') > MAX_INGEST_INPUT_BYTES) return no('input_too_large');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return no('not_json_object');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return no('not_json_object');
  if (hasHiddenChars(text)) return no('hidden_chars_in_output');
  const parsed = JudgeIngestPayloadSchema.safeParse(raw);
  if (!parsed.success) return no('schema_invalid');
  const p = parsed.data;
  if (new Set(p.verdicts.map((v) => v.id)).size !== p.verdicts.length) return no('schema_invalid');
  if (p.run_id !== runId) return no('run_mismatch');
  const model = p.declared.model.toLowerCase();
  if (
    !BUILTIN_VENDORS.includes(p.declared.vendor) ||
    p.declared.vendor === UNKNOWN_VENDOR ||
    !CONFIRMED_MODEL_RE.test(model)
  ) {
    return no('declared_invalid');
  }
  // 合理性检查(廉价的矛盾检测;推不出矛盾不代表可信)
  const derived = deriveVendor({ backend: p.declared.agent, model });
  if (derived !== UNKNOWN_VENDOR && derived !== p.declared.vendor) {
    return no('declared_vendor_conflict');
  }
  return {
    ok: true,
    value: {
      payload: p,
      sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      declaredModel: model,
    },
  };
}

/** 递归收集所有字符串(键与值),供对 `output` 做不可见字符 / 话术复扫 */
export function collectStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out);
  else if (typeof v === 'object' && v !== null) {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      collectStrings(x, out);
    }
  }
  return out;
}
