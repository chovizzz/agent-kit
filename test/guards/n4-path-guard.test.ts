/**
 * N4 ④:`checkReflectorProposalOrigin` 对 `reflector.confirmed` / `judge.provenance` 的结构校验(R20-18.16、R20-18.19 ⑥):
 * 非法 → `GUARD_PROPOSAL_CONFIRM_INVALID`;`session_declared` 提案连同确认可随 `kit:reflector` PR 进入 proposals/(它只是证据)。
 */
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { COMMON_FILES } from '../fixtures/guards/atoms.js';
import {
  baseProposal,
  sessionDeclared,
  withReflectorConfirmed,
  withSessionJudge,
} from '../contracts/n4-fixtures.js';
import { scenario, useRepoCleanup } from './helpers.js';

useRepoCleanup();
const CODE = 'GUARD_PROPOSAL_CONFIRM_INVALID';
const run = (doc: unknown) =>
  scenario(
    { ...COMMON_FILES },
    { 'proposals/n.yaml': stringify(JSON.parse(JSON.stringify(doc))) },
    { label: 'kit:reflector' },
  );
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试里按路径改写任意嵌套字段
const clone = (v: unknown): Record<string, any> => JSON.parse(JSON.stringify(v));

describe('GUARD_PROPOSAL_CONFIRM_INVALID', () => {
  it('正向对照:session_declared + 有效 confirmed、session_confirmed 裁决、旧提案 → 绿', async () => {
    const confirmed = withReflectorConfirmed(sessionDeclared(), {
      vendor: 'openai',
      model: 'gpt-example',
    });
    expect((await run(confirmed)).codes).toEqual([]);
    expect((await run(withSessionJudge(baseProposal()))).codes).toEqual([]);
    expect((await run(baseProposal())).codes).toEqual([]);
  });
  it('confirmed 出现在 spawned / 缺省 provenance 的提案上 → CONFIRM_INVALID', async () => {
    const good = clone(
      withReflectorConfirmed(sessionDeclared(), { vendor: 'openai', model: 'gpt-example' }),
    );
    for (const prov of ['spawned', undefined]) {
      const doc = clone(good);
      if (prov === undefined) delete doc.reflector.provenance;
      else doc.reflector.provenance = prov;
      const s = await run(doc);
      expect(s.codes, String(prov)).toEqual([CODE]);
      expect(s.pathsOf(CODE)).toEqual(['proposals/n.yaml']);
    }
  });
  it('confirmed 结构非法(未知键 / 非规范厂商 / 坏 binding)→ CONFIRM_INVALID', async () => {
    const good = clone(
      withReflectorConfirmed(sessionDeclared(), { vendor: 'openai', model: 'gpt-example' }),
    );
    for (const patch of [
      { extra: 1 },
      { vendor: 'OpenAI' },
      { binding_sha256: 'x' },
      { model: 'Has Space' },
    ]) {
      const doc = clone(good);
      Object.assign(doc.reflector.confirmed, patch);
      expect((await run(doc)).codes, JSON.stringify(patch)).toEqual([CODE]);
    }
  });
  it('judge.provenance 取值非法 / session_confirmed 形状非法 → CONFIRM_INVALID', async () => {
    const good = clone(withSessionJudge(baseProposal()));
    const bogus = clone(good);
    bogus.judge.provenance = 'bogus';
    expect((await run(bogus)).codes).toEqual([CODE]);
    const nullProv = clone(good);
    nullProv.judge.provenance = null;
    expect((await run(nullProv)).codes).toEqual([CODE]);
    const mixed = clone(good);
    mixed.judge.hops = [];
    expect((await run(mixed)).codes).toEqual([CODE]);
    const noConfirmation = clone(good);
    delete noConfirmation.judge.confirmation;
    expect((await run(noConfirmation)).codes).toEqual([CODE]);
  });
});
