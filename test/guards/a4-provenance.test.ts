/**
 * R20-A4:`reflector.provenance` 与守卫(docs/contracts.md R20-16.18 ~ R20-16.20,验收 R20-16.26)。
 * CI 守卫(`lifecycleCriteria` 的 judgeChecks、`checkReflectorProposalOrigin`)与本地 promote 的 C5(`checkC5`)走同一口径,CI 不得比本地宽。
 */
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { ProposalSchema, REFLECTOR_PROVENANCE } from '../../src/contracts/proposal.js';
import { isCrossVendor, isCrossVendorOf } from '../../src/contracts/vendor.js';
import { lifecycleCriteria } from '../../src/guards/criteria.js';
import { checkC5 } from '../../src/lifecycle/checks.js';
import { COMMON_FILES } from '../fixtures/guards/atoms.js';
import {
  PATH,
  PROPOSAL_PATH,
  atomText,
  kitToml,
  proposalYaml,
  type ProposalOpts,
} from './criteria-world.js';
import { scenario, useRepoCleanup } from './helpers.js';

useRepoCleanup();
const G = (c: string): string => `GUARD_G3_${c}`;

async function t1(proposal: ProposalOpts = {}) {
  const baseAtom = atomText({ status: 'proposed' });
  const headAtom = atomText({ status: 'advisory', review_by: '2027-02-08' });
  return scenario(
    {
      ...COMMON_FILES,
      'kit.toml': kitToml(),
      [PATH]: baseAtom,
      [PROPOSAL_PATH]: proposalYaml(baseAtom, proposal),
    },
    { [PATH]: headAtom },
    { criteria: lifecycleCriteria, label: 'kit:promotion' },
  );
}
const sorted = (a: readonly string[]): string[] => [...a].sort();

describe('R20-16.18 来源字段', () => {
  it('枚举 = spawned | session_declared;可选(旧提案缺省仍合法)', () => {
    expect([...REFLECTOR_PROVENANCE]).toEqual(['spawned', 'session_declared']);
    const base = parseYaml(proposalYaml(atomText({ status: 'proposed' }))) as Record<
      string,
      unknown
    >;
    expect(ProposalSchema.safeParse(base).success).toBe(true);
    const withP = (v: unknown) => ({
      ...base,
      reflector: { ...(base['reflector'] as object), provenance: v },
    });
    expect(ProposalSchema.safeParse(withP('spawned')).success).toBe(true);
    expect(ProposalSchema.safeParse(withP('session_declared')).success).toBe(true);
    expect(ProposalSchema.safeParse(withP('Spawned')).success).toBe(false);
    expect(ProposalSchema.safeParse(withP('other')).success).toBe(false);
  });
});

describe('R20-16.20 / 16.26 CI 守卫(晋升判据)', () => {
  it('正向对照:身份完整的旧提案(无 provenance)与 spawned 行为不变 → 绿', async () => {
    expect((await t1()).codes).toEqual([]);
    expect((await t1({ provenance: 'spawned' })).codes).toEqual([]);
  });
  it('session_declared → REFLECTOR_SESSION_DECLARED;其厂商不可证明,跨厂商证明也不成立(NOT_CROSS_VENDOR)', async () => {
    expect(sorted((await t1({ provenance: 'session_declared' })).codes)).toEqual(
      sorted([G('REFLECTOR_SESSION_DECLARED'), G('NOT_CROSS_VENDOR')]),
    );
  });
  it('ingest 实际写出的形状(provider=session、model=undeclared、vendor=unknown、backend=claude)→ 三条都在', async () => {
    const codes = (
      await t1({
        provenance: 'session_declared',
        reflectorProvider: 'session',
        reflectorModel: 'undeclared',
        reflectorVendor: 'unknown',
      })
    ).codes;
    expect(sorted(codes)).toEqual(
      sorted([G('REFLECTOR_SESSION_DECLARED'), G('NOT_CROSS_VENDOR'), G('REFLECTOR_UNVERIFIABLE')]),
    );
  });
  it('把 session_declared 改成 spawned 但缺后端身份 → REFLECTOR_UNVERIFIABLE(必须红)', async () => {
    expect((await t1({ provenance: 'spawned', backend: null })).codes).toEqual([
      G('REFLECTOR_UNVERIFIABLE'),
    ]);
  });
  it('unknown 等式漏洞:vendor=unknown 且推导也是 unknown → REFLECTOR_UNVERIFIABLE(不再因「两边相等」放行)', async () => {
    const codes = (
      await t1({
        backend: 'pi',
        reflectorProvider: 'x',
        reflectorModel: 'zzz-unknown-model',
        reflectorVendor: 'unknown',
      })
    ).codes;
    expect(sorted(codes)).toEqual(sorted([G('REFLECTOR_UNVERIFIABLE'), G('NOT_CROSS_VENDOR')]));
  });
  it('非法 provenance 值:提案过不了 schema(PROPOSAL_INVALID)', async () => {
    const codes = (await t1({ provenance: 'bogus' })).codes;
    expect(codes).toContain(G('PROPOSAL_INVALID'));
  });
});

describe('R20-16.20 ③ 本地 promote(checkC5)与 isCrossVendor', () => {
  const proposalOf = (o: ProposalOpts) =>
    ProposalSchema.parse(parseYaml(proposalYaml(atomText({ status: 'proposed' }), o)));
  it('session_declared → C5 不过(REFLECTOR_SESSION_DECLARED + VENDOR_NOT_CROSS),即使自报厂商是内置厂商', () => {
    const r = checkC5({ proposal: proposalOf({ provenance: 'session_declared' }) });
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(
      expect.arrayContaining(['REFLECTOR_SESSION_DECLARED', 'VENDOR_NOT_CROSS']),
    );
  });
  it('正向对照:同一提案去掉 provenance 或写 spawned → C5 过', () => {
    expect(checkC5({ proposal: proposalOf({}) }).ok).toBe(true);
    expect(checkC5({ proposal: proposalOf({ provenance: 'spawned' }) }).ok).toBe(true);
  });
  it('isCrossVendorOf:session_declared 一律不可证明;其余等同 isCrossVendor', () => {
    expect(isCrossVendor('anthropic', 'openai')).toBe(true);
    expect(isCrossVendorOf({ vendor: 'anthropic', provenance: 'session_declared' }, 'openai')).toBe(
      false,
    );
    expect(isCrossVendorOf({ vendor: 'anthropic', provenance: 'spawned' }, 'openai')).toBe(true);
    expect(isCrossVendorOf({ vendor: 'anthropic' }, 'openai')).toBe(true);
    expect(isCrossVendorOf({ vendor: 'unknown' }, 'openai')).toBe(false);
  });
});

describe('R20-16.20 ④ kit:reflector PR 的来源核验', () => {
  const yaml = (provenance: string | null): string =>
    `id: p-new\nbody: a\nreflector:\n  provider: session\n  vendor: unknown\n  model: undeclared\n  run_id: run-1\n  backend: claude\n${provenance === null ? '' : `  provenance: ${provenance}\n`}`;
  const run = (p: string | null) =>
    scenario({ ...COMMON_FILES }, { 'proposals/n.yaml': yaml(p) }, { label: 'kit:reflector' });
  it('枚举内(含 session_declared)与缺省 → 绿:session_declared 的提案可以随 kit:reflector PR 进入 proposals/', async () => {
    for (const p of [null, 'spawned', 'session_declared'])
      expect((await run(p)).codes, String(p)).toEqual([]);
  });
  it('存在但不在枚举内 → GUARD_PROPOSAL_PROVENANCE_INVALID(含大小写、空值、数字)', async () => {
    for (const p of ['bogus', 'Spawned', '5', '""']) {
      const s = await run(p);
      expect(s.codes, p).toEqual(['GUARD_PROPOSAL_PROVENANCE_INVALID']);
      expect(s.pathsOf('GUARD_PROPOSAL_PROVENANCE_INVALID')).toEqual(['proposals/n.yaml']);
    }
  });
});
