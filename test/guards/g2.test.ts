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

  it('GD-2:内容 PR 单独把 review_by 往后延 → GUARD_G2_REVIEW_BY_EXTENDED', async () => {
    const s = await scenario(
      { [ATOM_PATH]: atom({ status: 'active', review_by: '2027-01-08' }) },
      { [ATOM_PATH]: atom({ status: 'active', review_by: '2099-01-01' }) },
    );
    expect(s.codes).toEqual(['GUARD_G2_REVIEW_BY_EXTENDED']);
  });

  it('GD-2 对照:review_by 提前(安全方向)→ 绿', async () => {
    const s = await scenario(
      { [ATOM_PATH]: atom({ status: 'active', review_by: '2027-06-08' }) },
      { [ATOM_PATH]: atom({ status: 'active', review_by: '2027-01-08' }) },
    );
    expect(s.codes).toEqual([]);
  });

  it('GD-1/2:已有原子增删 disables/overrides、改 id/layer/strength/applies_to/paths → GUARD_G2_FIELD_LOCKED', async () => {
    const cases: [string, string[], string[]][] = [
      ['加 disables', [], ['disables: [other-atom]']],
      ['加 overrides', [], ['overrides: [other-atom]']],
      ['删 disables', ['disables: [other-atom]'], []],
      ['改 disables 取值', ['disables: [a-one]'], ['disables: [a-two]']],
      ['加 applies_to', [], ['applies_to: [claude]']],
      ['加 paths', [], ['paths: ["src/**"]']],
    ];
    for (const [name, baseLines, headLines] of cases) {
      const s = await scenario(
        { [ATOM_PATH]: atom({ status: 'active', extraLines: baseLines }) },
        { [ATOM_PATH]: atom({ status: 'active', extraLines: headLines }) },
      );
      expect(s.codes, name).toEqual(['GUARD_G2_FIELD_LOCKED']);
    }
  });

  it('GD-1 对照:改 id 去对上存量边 → 红(id 被锁)', async () => {
    const s = await scenario(
      { [ATOM_PATH]: atom({ status: 'active', id: 'sample-atom' }) },
      { [ATOM_PATH]: atom({ status: 'active', id: 'foo-target' }) },
    );
    expect(s.codes).toEqual(['GUARD_G2_FIELD_LOCKED']);
  });

  it('正向控制:owner/volatility 不在锁定集(人员交接可走内容 PR)', async () => {
    const s = await scenario(
      { [ATOM_PATH]: atom({ status: 'active' }) },
      { [ATOM_PATH]: atom({ status: 'active' }).replace("'@owner-handle'", "'@new-owner'") },
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
    // G2 仍独立生效;D7 起反思器改既有文件另出 GUARD_PATH_EXISTING_MODIFIED
    expect(s.codes).toEqual(['GUARD_G2_STATUS_CHANGED', 'GUARD_PATH_EXISTING_MODIFIED']);
  });
});

describe('GD-2 评审补充', () => {
  it('基线还是 proposed 的原子可以改结构字段(paths/applies_to),否则写错的 proposed 原子无路可走', async () => {
    const s = await scenario(
      { [ATOM_PATH]: atom({ status: 'proposed', extraLines: ['paths: ["a/**"]'] }) },
      { [ATOM_PATH]: atom({ status: 'proposed', extraLines: ['paths: ["b/**"]'] }) },
    );
    expect(s.codes).toEqual([]);
  });

  it('proposed 原子也不能动边;缺省与空数组等价(补 disables: [] 不算变化)', async () => {
    const edge = await scenario(
      { [ATOM_PATH]: atom({ status: 'proposed' }) },
      { [ATOM_PATH]: atom({ status: 'proposed', extraLines: ['disables: [x-y]'] }) },
    );
    expect(edge.codes).toEqual(['GUARD_G2_FIELD_LOCKED']);
    const empty = await scenario(
      { [ATOM_PATH]: atom({ status: 'active' }) },
      { [ATOM_PATH]: atom({ status: 'active', extraLines: ['disables: []'] }) },
    );
    expect(empty.codes).toEqual([]);
  });
});
