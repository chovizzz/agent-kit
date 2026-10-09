import { describe, expect, it } from 'vitest';
import { ATOM_PATH, COMMON_FILES, OTHER_PATH, atom } from '../fixtures/guards/atoms.js';
import { scenario, useRepoCleanup } from './helpers.js';

useRepoCleanup();

describe('G1:新增原子的 status 必须是 proposed', () => {
  it('正向控制:新增 proposed 原子 → 绿', async () => {
    const s = await scenario({ 'README.md': 'x\n' }, { [ATOM_PATH]: atom({ status: 'proposed' }) });
    expect(s.codes).toEqual([]);
  });

  it('正向控制:引号写法 "proposed" 与行内注释同样是 proposed', async () => {
    const s = await scenario(
      { 'README.md': 'x\n' },
      { [ATOM_PATH]: atom({ status: '"proposed" # 新提案' }) },
    );
    expect(s.codes).toEqual([]);
  });

  for (const status of ['advisory', 'active', 'deprecated', 'retired']) {
    it(`新增原子 status=${status} → GUARD_G1_NEW_ATOM_NOT_PROPOSED`, async () => {
      const s = await scenario({ 'README.md': 'x\n' }, { [ATOM_PATH]: atom({ status }) });
      expect(s.codes).toEqual(['GUARD_G1_NEW_ATOM_NOT_PROPOSED']);
      expect(s.pathsOf('GUARD_G1_NEW_ATOM_NOT_PROPOSED')).toEqual([ATOM_PATH]);
    });
  }

  it('新增原子缺 status 键 → 红(缺失不等于 proposed)', async () => {
    const s = await scenario({ 'README.md': 'x\n' }, { [ATOM_PATH]: atom({ omitStatus: true }) });
    expect(s.codes).toEqual(['GUARD_G1_NEW_ATOM_NOT_PROPOSED']);
  });

  it('大小写不同(Proposed)或非字符串(列表)→ 红', async () => {
    const a = await scenario({ 'README.md': 'x\n' }, { [ATOM_PATH]: atom({ status: 'Proposed' }) });
    expect(a.codes).toEqual(['GUARD_G1_NEW_ATOM_NOT_PROPOSED']);
    const b = await scenario(
      { 'README.md': 'x\n' },
      { [ATOM_PATH]: atom({ status: '[proposed]' }) },
    );
    expect(b.codes).toEqual(['GUARD_G1_NEW_ATOM_NOT_PROPOSED']);
  });

  it('一个 PR 同时新增两个,一个合规一个违规 → 只有违规者命中', async () => {
    const s = await scenario(
      { 'README.md': 'x\n' },
      {
        [ATOM_PATH]: atom({ status: 'proposed' }),
        [OTHER_PATH]: atom({ id: 'other', status: 'active' }),
      },
    );
    expect(s.codes).toEqual(['GUARD_G1_NEW_ATOM_NOT_PROPOSED']);
    expect(s.pathsOf('GUARD_G1_NEW_ATOM_NOT_PROPOSED')).toEqual([OTHER_PATH]);
  });

  it('重命名 fixture:把 active 原子改名为 proposed 之外的状态 → G1 不漏判(diff 不做重命名检测)', async () => {
    const s = await scenario(
      { [ATOM_PATH]: atom({ status: 'active' }) },
      { [ATOM_PATH]: null, [OTHER_PATH]: atom({ status: 'active' }) },
    );
    // 新路径是「新增」→ G1;旧路径是「删除」→ G4(active 不能删)
    expect(s.codes).toEqual(['GUARD_G1_NEW_ATOM_NOT_PROPOSED', 'GUARD_G4_DELETE_NOT_RETIRED']);
  });

  it('重命名 + 同时把 status 洗成 proposed:G1 过,但旧路径删除被 G4 拦下', async () => {
    const s = await scenario(
      { [ATOM_PATH]: atom({ status: 'active' }) },
      { [ATOM_PATH]: null, [OTHER_PATH]: atom({ status: 'proposed' }) },
    );
    expect(s.codes).toEqual(['GUARD_G4_DELETE_NOT_RETIRED']);
  });

  it('project 层 .kit/rules/ 下的新增同样适用', async () => {
    const p = '.kit/rules/local/x.md';
    const bad = await scenario({ 'README.md': 'x\n' }, { [p]: atom({ status: 'active' }) });
    expect(bad.codes).toEqual(['GUARD_G1_NEW_ATOM_NOT_PROPOSED']);
    const ok = await scenario({ 'README.md': 'x\n' }, { [p]: atom({ status: 'proposed' }) });
    expect(ok.codes).toEqual([]);
  });

  it('大小写不敏感文件系统上的路径变体(Rules/…、扩展名 .MD)也按原子处理', async () => {
    const a = await scenario(
      { 'README.md': 'x\n' },
      { 'Rules/general/x.md': atom({ status: 'active' }) },
    );
    expect(a.codes).toEqual(['GUARD_G1_NEW_ATOM_NOT_PROPOSED']);
    const b = await scenario(
      { 'README.md': 'x\n' },
      { 'rules/general/x.MD': atom({ status: 'active' }) },
    );
    expect(b.codes).toEqual(['GUARD_G1_NEW_ATOM_NOT_PROPOSED']);
  });

  it('不是原子路径的文件不归 G1 管(正向控制,防谓词过宽)', async () => {
    const s = await scenario(
      { 'README.md': 'x\n' },
      { 'docs/not-an-atom.md': atom({ status: 'active' }), 'rules/readme.txt': 'x\n' },
    );
    expect(s.codes).toEqual([]);
  });
});

describe('GD-1:新增原子不得带 disables/overrides', () => {
  it('proposed 新原子带 disables / overrides → GUARD_G1_NEW_ATOM_HAS_EDGES', async () => {
    for (const line of ['disables: [other-atom]', 'overrides: [other-atom]', 'disables: foo']) {
      const s = await scenario(
        { ...COMMON_FILES },
        { [ATOM_PATH]: atom({ status: 'proposed', extraLines: [line] }) },
      );
      expect(s.codes, line).toEqual(['GUARD_G1_NEW_ATOM_HAS_EDGES']);
    }
  });

  it('对照:空数组 / 不带边的 proposed 新原子 → 绿', async () => {
    for (const extra of [[], ['disables: []']]) {
      const s = await scenario(
        { ...COMMON_FILES },
        { [ATOM_PATH]: atom({ status: 'proposed', extraLines: extra }) },
      );
      expect(s.codes).toEqual([]);
    }
  });
});
