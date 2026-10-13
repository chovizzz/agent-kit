import { describe, expect, it } from 'vitest';
import { JudgeStateError } from '../../src/judge/errors.js';
import {
  applyJudgeFields,
  assertOnlyJudgeKeysChanged,
  writeProposal,
} from '../../src/judge/store.js';
import { newWork, proposalObject } from './helpers.js';

describe('store:judge 只能改 judge / judge_attempts 两个键', () => {
  const raw = proposalObject();

  it('applyJudgeFields 保留其它键原样;写 judge 会删 judge_attempts,反之亦然', () => {
    const a = applyJudgeFields({ ...raw, judge_attempts: [1] }, { judge: { x: 1 } });
    expect('judge_attempts' in a).toBe(false);
    expect(a['judge']).toEqual({ x: 1 });
    const b = applyJudgeFields({ ...raw, judge: { x: 1 } }, { judge_attempts: [2] });
    expect('judge' in b).toBe(false);
    expect(b['judge_attempts']).toEqual([2]);
    expect(Object.keys(a).filter((k) => k !== 'judge')).toEqual(Object.keys(raw));
  });

  it('assertOnlyJudgeKeysChanged:改了 layer / 新增 status / 删字段都抛;只动 judge 不抛(正向对照)', () => {
    expect(() => assertOnlyJudgeKeysChanged(raw, { ...raw, judge: {} })).not.toThrow();
    expect(() => assertOnlyJudgeKeysChanged(raw, { ...raw, layer: 'org' })).toThrow(
      JudgeStateError,
    );
    expect(() => assertOnlyJudgeKeysChanged(raw, { ...raw, status: 'active' })).toThrow(
      JudgeStateError,
    );
    const less: Record<string, unknown> = { ...raw };
    delete less['rationale'];
    expect(() => assertOnlyJudgeKeysChanged(raw, less)).toThrow(JudgeStateError);
  });

  it('writeProposal 写之前过 ProposalSchema:不合法的结果不落盘', async () => {
    const w = await newWork();
    const file = `${w.dir}/x.yaml`;
    await expect(writeProposal(w.io, file, { ...raw, judge_attempts: [] }, '')).rejects.toThrow(
      JudgeStateError,
    );
    await expect(writeProposal(w.io, file, { ...raw, status: 'active' }, '')).rejects.toThrow(
      JudgeStateError,
    );
  });
});
