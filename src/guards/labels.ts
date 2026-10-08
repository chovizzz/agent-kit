import type { Diagnostic } from '../contracts/diagnostics.js';
import type { CriteriaChecker, GuardLabel } from './types.js';

/**
 * P0 的 `--label` 是对 P1 CI 版的前置模拟:本地传入,只做「与转移方向/改动范围一致」的比对,
 * 不读 GitHub 元数据,也不校验标签由谁添加(那是 P1 CI 的事)。
 * `kit:reflector` 不是设计 §5.2 里的 PR 标签:它是本地模拟「反思器产出的 PR」以启用路径守卫(§6.4)。
 */
export const GUARD_LABELS: readonly GuardLabel[] = [
  'kit:promotion',
  'kit:retire',
  'kit:attest',
  'kit:reflector',
];

export type ParsedLabel =
  { ok: true; label: GuardLabel | undefined } | { ok: false; diagnostic: Diagnostic };

/** 精确匹配(区分大小写、不 trim):`Kit:Promotion`、` kit:retire` 都视为未知。 */
export function parseLabel(raw: string | undefined): ParsedLabel {
  if (raw === undefined) return { ok: true, label: undefined };
  const hit = GUARD_LABELS.find((l) => l === raw);
  if (hit !== undefined) return { ok: true, label: hit };
  return {
    ok: false,
    diagnostic: {
      code: 'GUARD_LABEL_UNKNOWN',
      severity: 'error',
      path: '--label',
      message: `未知标签 ${JSON.stringify(raw)};可选:${GUARD_LABELS.join(' | ')}`,
    },
  };
}

/** 设计 §5.2:状态变更 PR 允许的转移方向白名单(from → to)。 */
export const ALLOWED_TRANSITIONS: Readonly<
  Record<'kit:promotion' | 'kit:retire', readonly (readonly [string, string])[]>
> = {
  'kit:promotion': [
    ['proposed', 'advisory'],
    ['advisory', 'active'],
  ],
  // advisory→deprecated 是回滚(设计第三轮 5)
  'kit:retire': [
    ['advisory', 'deprecated'],
    ['active', 'deprecated'],
    ['deprecated', 'retired'],
  ],
};

/**
 * G3 判据检查的 P0 桩:attest/reports 校验是 P1 的事,所以这里**不静默通过**,而是一律判不通过。
 * 含义:P0 的 CLI 上,晋升/退役 PR 永远红(结构检查的诊断仍会一并列出);P1 把真实检查器注入 `GuardOptions.criteria`。
 */
export const pendingCriteria: CriteriaChecker = (t) => [
  {
    code: 'GUARD_G3_CRITERIA_NOT_IMPLEMENTED',
    severity: 'error',
    path: t.path,
    message: `转移 ${t.from}→${t.to} 的判据检查(attest/reports)是 P1 能力,P0 视为不通过`,
  },
];
