/** B2:`HoldFacts`:没有数据源的码恒视为仍成立(拒绝解除);仓库检视读不出 = 仍成立;检视合法才不成立(正向对照)。 */
import { describe, expect, it } from 'vitest';
import { HOLDS_WITHOUT_SOURCE, makeHoldFacts } from '../../../src/rsi/personal/hold-facts.js';

describe('HoldFacts', () => {
  it('没有数据源的三个码恒在快照里;仓库合法时 personal_repo_invalid 不在', async () => {
    const s = await makeHoldFacts({ repoInvalid: async () => false }).snapshot();
    expect([...s].sort()).toEqual([...HOLDS_WITHOUT_SOURCE].sort());
    expect(s.has('personal_repo_invalid')).toBe(false);
  });
  it('仓库 invalid / 检视抛错 → personal_repo_invalid 仍成立', async () => {
    expect(
      (await makeHoldFacts({ repoInvalid: async () => true }).snapshot()).has(
        'personal_repo_invalid',
      ),
    ).toBe(true);
    const thrower = makeHoldFacts({
      repoInvalid: async () => {
        throw new Error('io');
      },
    });
    expect((await thrower.snapshot()).has('personal_repo_invalid')).toBe(true);
  });
});
