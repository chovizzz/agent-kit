/**
 * 展示指纹与确认屏(R20-18.6 第 1 / 4 步;R20-18.11)。
 *
 * - 确认屏**由 kit 从校验后的枚举值构造**,不引用 payload 里的任何自由文本(`notes` 已丢弃);只含枚举、id、哈希前 12 位、计数,以及
 *   token 字符集的 `declared.*`(规范厂商名 / `^[a-z0-9._:@+/-]{1,64}$` 模型串)。整份输出过 R20-3.5.2 同口径的控制字符 / bidi 清洗与泄漏闸。
 * - 展示指纹 = sha256(canonical JSON:`run_id`、payload 的 sha256、每条提案 `{id, 提案文件字节 sha256, 规则文件字节 sha256, 层, 现有 judge 状态, reflector 确认状态}`、`declared`)。
 *   `--confirm-reflector` 的指纹去掉 payload 项与 `declared` 项。用户键入的反思器值不在指纹里(它在展示之后才产生)。
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../io/canonical-json.js';
import { guardOutput, type OutLine } from '../../rsi/sanitize.js';
import { SELF_REPORT_LABEL_JUDGE, SELF_REPORT_LABEL_REFLECTOR } from '../../contracts/vendor.js';
import type { Plan, PlanEntry } from './plan.js';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

function judgeState(e: PlanEntry): unknown {
  switch (e.existing.kind) {
    case 'none':
      return 'none';
    case 'spawned':
      return 'spawned';
    case 'session_confirmed':
      return { kind: 'session_confirmed', binding: e.existing.record.confirmation.binding_sha256 };
  }
}

function reflectorState(e: PlanEntry): unknown {
  const c = e.loaded.proposal.reflector.confirmed;
  return {
    provenance: e.loaded.proposal.reflector.provenance ?? 'spawned',
    confirmed: c === undefined ? null : c.binding_sha256,
    tier: e.reflectorTier,
  };
}

export function planFingerprint(plan: Plan): string {
  const body: Record<string, unknown> = {
    run_id: plan.runId,
    proposals: plan.entries.map((e) => ({
      id: e.id,
      proposal_sha256: sha(e.loaded.text),
      rule_sha256: sha(e.loaded.ruleText),
      layer: e.layer,
      judge: judgeState(e),
      reflector: reflectorState(e),
    })),
  };
  if (plan.mode === 'ingest' && plan.payload !== undefined) {
    body['payload_sha256'] = plan.payload.sha256;
    body['declared'] = plan.payload.payload.declared;
  }
  return sha(canonicalJson(body));
}

function reflectorLine(e: PlanEntry): string {
  if (e.reflectorTier === 'proven')
    return `reflector proposal=${e.id} proven vendor=${e.reflectorVendor}`;
  if (e.reflectorTier === 'self_confirmed') {
    return `reflector proposal=${e.id} self_confirmed vendor=${e.reflectorVendor}`;
  }
  return e.loaded.proposal.reflector.provenance === 'session_declared'
    ? `reflector proposal=${e.id} session_declared UNCONFIRMED`
    : `reflector proposal=${e.id} unverified`;
}

/** 确认屏的行(尚未过泄漏闸) */
export function screenLines(plan: Plan): OutLine[] {
  const lines: OutLine[] = [];
  const head = (h: string): void => {
    lines.push({ head: h });
  };
  if (plan.mode === 'ingest' && plan.payload !== undefined) {
    const d = plan.payload.payload.declared;
    head(SELF_REPORT_LABEL_JUDGE);
    head(
      `run=${plan.runId} proposals=${plan.entries.length} payload=${plan.payload.sha256.slice(0, 12)}`,
    );
    for (const e of plan.entries) {
      const o = e.output;
      if (o === undefined) continue;
      head(
        `proposal=${e.id} layer=${e.layer} verdict=${o.verdict} overfit=${o.overfit_risk} injection=${String(o.injection_suspected)} conflicts=${o.conflicts.length} prediction=${e.status === 'predicted' ? 'required' : 'not_required'}`,
      );
    }
    head(`declared agent=${d.agent} vendor=${d.vendor} model=${plan.payload.declaredModel}`);
    for (const e of plan.entries) {
      head(reflectorLine(e));
      if (plan.replace && e.existing.kind === 'session_confirmed') {
        const r = e.existing.record;
        head(
          `replace proposal=${e.id} old_verdict=${r.verdict} old_overfit=${r.overfit_risk} old_injection=${String(r.injection_suspected)} old_vendor=${r.declared.vendor} old_model=${r.declared.model} old_confirmed_at=${r.confirmation.confirmed_at}`,
        );
      }
    }
  } else {
    head(SELF_REPORT_LABEL_REFLECTOR);
    head(`run=${plan.runId} proposals=${plan.entries.length}`);
    for (const e of plan.entries) {
      head(
        `${reflectorLine(e)} backend=${e.loaded.proposal.reflector.backend ?? 'undeclared'} layer=${e.layer}`,
      );
    }
  }
  return lines;
}

/** 过泄漏闸并拼成文本;命中 → undefined(调用方退出 3 `JUDGE_FAIL_CLOSED reason=output_leak`,不读输入) */
export function guardedScreen(
  lines: readonly OutLine[],
  forbidden: readonly string[],
): string | undefined {
  if (!guardOutput(lines, forbidden).ok) return undefined;
  return lines.map((l) => `${l.head}\n`).join('');
}
