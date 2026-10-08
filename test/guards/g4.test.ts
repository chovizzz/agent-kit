import { describe, expect, it } from 'vitest';
import { ATOM_PATH, COMMON_FILES, atom } from '../fixtures/guards/atoms.js';
import { scenario, useRepoCleanup } from './helpers.js';

useRepoCleanup();

const retired = atom({ status: 'retired' });
const BASE = { ...COMMON_FILES };

describe('G4:删除原子文件的前提是 retired 已在 stable tag 里出现过', () => {
  it('合法对照:retired 已在 stable-1.0(基线祖先)里 → 删除放行', async () => {
    const s = await scenario(
      { ...BASE },
      { [ATOM_PATH]: null },
      { history: [{ files: { ...BASE, [ATOM_PATH]: retired }, tag: 'stable-1.0' }] },
    );
    expect(s.codes).toEqual([]);
  });

  it('合法对照:注解 tag 同样有效', async () => {
    const s = await scenario(
      { ...BASE },
      { [ATOM_PATH]: null },
      { history: [{ files: { ...BASE, [ATOM_PATH]: retired }, tag: 'stable-2', annotated: true }] },
    );
    expect(s.codes).toEqual([]);
  });

  it('负 1:删除 active 原子 → GUARD_G4_DELETE_NOT_RETIRED', async () => {
    const s = await scenario(
      { ...BASE, [ATOM_PATH]: atom({ status: 'active' }) },
      { [ATOM_PATH]: null },
    );
    expect(s.codes).toEqual(['GUARD_G4_DELETE_NOT_RETIRED']);
  });

  it('负 2:基线已是 retired,但没有任何 stable tag → GUARD_G4_NOT_IN_STABLE_TAG', async () => {
    const s = await scenario({ ...BASE, [ATOM_PATH]: retired }, { [ATOM_PATH]: null });
    expect(s.codes).toEqual(['GUARD_G4_NOT_IN_STABLE_TAG']);
  });

  it('负 3:stable tag 里该原子还是 deprecated(retired 尚未发布)→ 红', async () => {
    const s = await scenario(
      { ...BASE, [ATOM_PATH]: retired },
      { [ATOM_PATH]: null },
      {
        history: [
          { files: { ...BASE, [ATOM_PATH]: atom({ status: 'deprecated' }) }, tag: 'stable-1.0' },
        ],
      },
    );
    expect(s.codes).toEqual(['GUARD_G4_NOT_IN_STABLE_TAG']);
  });

  it('负 4:tag 名不以 stable- 开头(v1.0 / Stable-1 / stable)→ 不算 stable tag', async () => {
    for (const tag of ['v1.0', 'Stable-1', 'stable', 'unstable-1']) {
      const s = await scenario(
        { ...BASE, [ATOM_PATH]: retired },
        { [ATOM_PATH]: null },
        { history: [{ files: { ...BASE, [ATOM_PATH]: retired }, tag }] },
      );
      expect(s.codes, tag).toEqual(['GUARD_G4_NOT_IN_STABLE_TAG']);
    }
  });

  it('负 5a:stable tag 打在 head 提交上(PR 自带的提交,不是基线祖先)→ 红', async () => {
    const s = await scenario(
      { ...BASE, [ATOM_PATH]: retired },
      { [ATOM_PATH]: null },
      { afterHead: (r) => r.tag('stable-late', 'kit-head') },
    );
    expect(s.codes).toEqual(['GUARD_G4_NOT_IN_STABLE_TAG']);
  });

  it('负 5b:stable tag 打在含 retired 的旁支提交上(不在基线历史里)→ 红', async () => {
    const s = await scenario(
      { ...BASE, [ATOM_PATH]: atom({ status: 'deprecated' }) },
      { [ATOM_PATH]: null },
      {
        afterHead: async (r) => {
          r.branch('side', 'kit-base');
          await r.commit({ [ATOM_PATH]: retired }, 'side retired');
          r.tag('stable-side');
        },
      },
    );
    // 基线里是 deprecated,所以先被 DELETE_NOT_RETIRED 拦下;旁支 tag 不能把它变成合法
    expect(s.codes).toEqual(['GUARD_G4_DELETE_NOT_RETIRED']);
  });

  it('负 5c:基线是 retired,tag 在旁支(非祖先)里也是 retired → 仍红', async () => {
    const s = await scenario(
      { ...BASE, [ATOM_PATH]: retired },
      { [ATOM_PATH]: null },
      {
        afterHead: async (r) => {
          r.branch('side', 'kit-base');
          await r.commit({ 'side.txt': 'x\n' }, 'side');
          r.tag('stable-side');
        },
      },
    );
    expect(s.codes).toEqual(['GUARD_G4_NOT_IN_STABLE_TAG']);
  });

  it('负 6:retired 同时在基线被改成 retired(同一 PR 内 retired 还没发布)→ 红', async () => {
    const s = await scenario(
      { ...BASE, [ATOM_PATH]: atom({ status: 'deprecated' }) },
      { [ATOM_PATH]: null },
    );
    expect(s.codes).toEqual(['GUARD_G4_DELETE_NOT_RETIRED']);
  });

  it('不删除就不受 G4 约束(保留 retired 文件)→ 绿', async () => {
    const s = await scenario({ ...BASE, [ATOM_PATH]: retired }, { 'README.md': 'x\n' });
    expect(s.codes).toEqual([]);
  });
});
