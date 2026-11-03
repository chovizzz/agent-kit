/**
 * N4 ③(R20-18.19 ⑤):C8 复扫清单追加 `judge.declared.model` / `judge.declared.vendor` / `judge.confirmation.kit_version` /
 * `reflector.confirmed.vendor` / `.model` / `.kit_version`——用户键入值与声明值是新的自由文本通道,不得绕过 pass2。
 * 假口令运行时拼装(仓库里不存在完整字面量);小写 + 数字 + `-` 落在 token 字符集内,所以它能通过 schema 却必须被 C8 抓到。
 */
import { describe, expect, it } from 'vitest';
import { ProposalSchema, type Proposal } from '../../src/contracts/proposal.js';
import { checkC8 } from '../../src/lifecycle/checks.js';
import { createRedactor } from '../../src/redact/index.js';
import {
  baseProposal,
  sessionDeclared,
  withReflectorConfirmed,
  withSessionJudge,
} from '../contracts/n4-fixtures.js';
import { makeAtom } from './fixtures.js';

const redactor = createRedactor({ timeout_ms: 5000 });
const KEY = `sk-${'a1'.repeat(22)}`;
const atom = makeAtom();
const c8 = (p: Proposal) => checkC8({ atom, proposal: p, redactor });

describe('R20-18.19 ⑤ C8 复扫清单', () => {
  it('正向对照:正常的自报裁决 / 确认通过 C8', () => {
    expect(c8(withSessionJudge(baseProposal())).ok).toBe(true);
    expect(
      c8(withReflectorConfirmed(sessionDeclared(), { vendor: 'anthropic', model: 'claude-x' })).ok,
    ).toBe(true);
  });
  it('C8 复扫清单含 judge.declared.model:声明的模型串里带口令 → REDACTION_RESIDUAL,字段指向 judge.declared.model', () => {
    const p = withSessionJudge(baseProposal(), { model: KEY });
    const r = c8(p);
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('REDACTION_RESIDUAL');
    expect(r.fields).toContain('judge.declared.model');
  });
  it('C8 复扫清单含 reflector.confirmed.model:用户键入的反思器模型串里带口令 → 字段指向 reflector.confirmed.model', () => {
    const p = withReflectorConfirmed(sessionDeclared(), { vendor: 'anthropic', model: KEY });
    const r = c8(p);
    expect(r.ok).toBe(false);
    expect(r.fields).toContain('reflector.confirmed.model');
  });
  it('清单里的其余字段(vendor / kit_version)同样进入复扫', () => {
    const base = withSessionJudge(baseProposal());
    const raw = JSON.parse(JSON.stringify(base)) as {
      judge: { confirmation: { kit_version: string }; declared: { vendor: string } };
    };
    raw.judge.confirmation.kit_version = `0.2.0-${KEY}`;
    const p = ProposalSchema.parse(raw);
    expect(c8(p).fields).toContain('judge.confirmation.kit_version');
  });
});
