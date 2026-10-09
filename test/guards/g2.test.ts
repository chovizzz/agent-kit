import { describe, expect, it } from 'vitest';
import { ATOM_PATH, OTHER_PATH, atom } from '../fixtures/guards/atoms.js';
import { scenario, useRepoCleanup } from './helpers.js';

useRepoCleanup();

const TRANSITIONS: [string, string][] = [
  ['proposed', 'advisory'], // 合法晋升方向,但没有 kit:promotion 标签
  ['advisory', 'active'],
  ['active', 'deprecated'], // 合法退役方向,但没有 kit:retire 标签
  ['deprecated', 'retired'],
  ['advisory', 'proposed'], // 反向
  ['active', 'proposed'],
  ['retired', 'active'], // 复活
];

describe('G2:非晋升/退役 PR 不得改已有原子的 status', () => {
  it('正向控制:只改正文与标题、status 不动 → 绿', async () => {
    const s = await scenario(
      { [ATOM_PATH]: atom({ status: 'active', title: '旧标题' }) },
      {
        [ATOM_PATH]: atom({
          status: 'active',
          title: '新标题',
          body: '**做**:改了。\n**为什么**:改了。\n**怎么验**:改了。\n',
        }),
      },
    );
    expect(s.codes).toEqual([]);
  });

  it('正向控制:只改 review_by(G2 只看 status)→ 绿', async () => {
    const s = await scenario(
      { [ATOM_PATH]: atom({ status: 'active', review_by: '2027-01-08' }) },
      { [ATOM_PATH]: atom({ status: 'active', review_by: '2027-06-08' }) },
    );
    expect(s.codes).toEqual([]);
  });

  for (const [from, to] of TRANSITIONS) {
    it(`${from} → ${to}(无标签)→ GUARD_G2_STATUS_CHANGED`, async () => {
      const s = await scenario(
        { [ATOM_PATH]: atom({ status: from }) },
        { [ATOM_PATH]: atom({ status: to }) },
      );
      expect(s.codes).toEqual(['GUARD_G2_STATUS_CHANGED']);
    });
  }

  it('删掉 status 键也是一种变化 → 红', async () => {
    const s = await scenario(
      { [ATOM_PATH]: atom({ status: 'proposed' }) },
      { [ATOM_PATH]: atom({ omitStatus: true }) },
    );
    expect(s.codes).toEqual(['GUARD_G2_STATUS_CHANGED']);
  });

  it('非字符串 status 之间的变化(1 → 2、true → false)同样红(不能被归一化成 undefined 漏掉)', async () => {
    for (const [a, b] of [
      ['1', '2'],
      ['true', 'false'],
      ['[a]', '[b]'],
    ]) {
      const s = await scenario(
        { [ATOM_PATH]: atom({ status: a! }) },
        { [ATOM_PATH]: atom({ status: b! }) },
      );
      expect(s.codes, `${a}→${b}`).toEqual(['GUARD_G2_STATUS_CHANGED']);
    }
  });

  it('同一 PR 里改了两个原子,只有改 status 的那个命中', async () => {
    const s = await scenario(
      {
        [ATOM_PATH]: atom({ status: 'active' }),
        [OTHER_PATH]: atom({ id: 'other', status: 'active' }),
      },
      {
        [ATOM_PATH]: atom({ status: 'deprecated' }),
        [OTHER_PATH]: atom({ id: 'other', status: 'active', title: 'x' }),
      },
    );
    expect(s.pathsOf('GUARD_G2_STATUS_CHANGED')).toEqual([ATOM_PATH]);
  });

  it('G2 也适用于反思器标签 kit:reflector 与 kit:attest 之外的所有无晋升标签场景', async () => {
    const s = await scenario(
      { [ATOM_PATH]: atom({ status: 'proposed' }) },
      { [ATOM_PATH]: atom({ status: 'active' }) },
      { label: 'kit:reflector' },
    );
    expect(s.codes).toEqual(['GUARD_G2_STATUS_CHANGED']);
  });
});
