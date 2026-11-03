/**
 * 晋升账里的「厂商证据」(N4,docs/contracts.md §20.18,R20-18.20):`report.json` / `pr-body.md` / `promote` 的 stdout 与 `--json` 共用同一份形状与同一组固定标签。
 * 只从 `vendorEvidence`(唯一的证据函数)派生,不自己判层级;标签文本只来自 `vendor.ts` 的常量(R20-18.2)。纯函数。
 */
import type { Proposal } from '../contracts/proposal.js';
import {
  SELF_REPORT_LABEL_JUDGE,
  SELF_REPORT_LABEL_REFLECTOR,
  VENDOR_PROVEN_LABEL,
  vendorEvidence,
  type VendorTier,
} from '../contracts/vendor.js';

export interface VendorEvidenceReport {
  reflector: { tier: VendorTier; vendor: string; model: string };
  judge: { tier: VendorTier; vendor: string; model: string };
  /** 升序;可为空 */
  self_reported: ('judge' | 'reflector')[];
}

/** 证据不成立(C5 本应已拦下)→ undefined,调用方 fail-closed */
export function vendorEvidenceReport(
  p: Proposal,
  vendorOverrides: Readonly<Record<string, string>> = {},
): VendorEvidenceReport | undefined {
  const ev = vendorEvidence(p, vendorOverrides);
  if (!ev.ok) return undefined;
  const self: ('judge' | 'reflector')[] = [];
  if (ev.judge.tier === 'self_confirmed') self.push('judge');
  if (ev.reflector.tier === 'self_confirmed') self.push('reflector');
  return {
    reflector: { tier: ev.reflector.tier, vendor: ev.reflector.vendor, model: ev.reflector.model },
    judge: { tier: ev.judge.tier, vendor: ev.judge.vendor, model: ev.judge.model },
    self_reported: self,
  };
}

/**
 * PR 描述里**始终出现**的证据声明行:两侧均 `proven` → `VENDOR_PROVEN_LABEL`;任一侧自报 → 对应的 `SELF_REPORT_LABEL_*`(两侧都自报则两行)。
 * 多条入库提案时取并集(任何一条的哪一侧自报,就出对应的行)。无采纳项 → 空数组(N4i-4:没有可声明的层级,调用方写固定的「无采纳项」行)。
 */
export function evidenceLabels(reports: readonly VendorEvidenceReport[]): string[] {
  if (reports.length === 0) return [];
  const judgeSelf = reports.some((r) => r.self_reported.includes('judge'));
  const reflectorSelf = reports.some((r) => r.self_reported.includes('reflector'));
  if (!judgeSelf && !reflectorSelf) return [VENDOR_PROVEN_LABEL];
  return [
    ...(judgeSelf ? [SELF_REPORT_LABEL_JUDGE] : []),
    ...(reflectorSelf ? [SELF_REPORT_LABEL_REFLECTOR] : []),
  ];
}

/** 无采纳项时 PR 描述里的固定行(N4i-4) */
export const NO_VENDOR_EVIDENCE_LINE = '厂商证据:无采纳项,无可声明的证据层级';
