import { describe, expect, it } from 'vitest';
import { ATOM_PATH, COMMON_FILES, atom } from '../fixtures/guards/atoms.js';
import { checkReflectorPaths } from '../../src/guards/path-guard.js';
import type { Change } from '../../src/guards/types.js';
import { scenario, useRepoCleanup } from './helpers.js';

useRepoCleanup();

const BASE = { ...COMMON_FILES };

describe('反思器路径守卫(kit:reflector;设计 §6.4)', () => {
  it('合法对照:只触碰 rules/ skills/ cases/ proposals/ → 绿', async () => {
    const s = await scenario(
      { ...BASE },
      {
        [ATOM_PATH]: atom({ status: 'proposed' }),
        'skills/demo/SKILL.md': '---\nname: demo\n---\n改了\n',
        'cases/x/case.yaml': 'id: x2\n',
        'proposals/p2.yaml': 'id: p2\n',
      },
      { label: 'kit:reflector' },
    );
    expect(s.codes).toEqual([]);
  });

  const FORBIDDEN: [string, Record<string, string | null>][] = [
    ['hooks/', { 'hooks/h1/hook.yaml': 'id: evil\n' }],
    ['kit.toml', { 'kit.toml': '[kit]\nname = "evil"\n' }],
    ['CODEOWNERS', { CODEOWNERS: '* @attacker\n' }],
    ['.github/', { '.github/workflows/ci.yml': 'name: evil\n' }],
    ['adapters/', { 'adapters/claude/index.ts': 'export const x = 1;\n' }],
    ['attest/', { 'attest/a/b.json': '{}\n' }],
  ];
  for (const [name, head] of FORBIDDEN) {
    it(`触碰 ${name} → GUARD_PATH_FORBIDDEN`, async () => {
      const s = await scenario({ ...BASE }, head, { label: 'kit:reflector' });
      expect(s.codes).toEqual(['GUARD_PATH_FORBIDDEN']);
    });
  }

  it('删除禁区里的文件同样命中', async () => {
    const s = await scenario(
      { ...BASE },
      { 'hooks/h1/hook.yaml': null },
      { label: 'kit:reflector' },
    );
    expect(s.codes).toEqual(['GUARD_PATH_FORBIDDEN']);
  });

  it('把允许区的文件移进禁区(删旧 + 增新)→ 命中禁区那一侧', async () => {
    const s = await scenario(
      { ...BASE },
      { 'cases/x/case.yaml': null, 'hooks/h1/case.yaml': 'id: x\n' },
      { label: 'kit:reflector' },
    );
    expect(s.codes).toEqual(['GUARD_PATH_FORBIDDEN']);
    expect(s.pathsOf('GUARD_PATH_FORBIDDEN')).toEqual(['hooks/h1/case.yaml']);
  });

  it('大小写变体(HOOKS/、KIT.TOML、codeowners、.GitHub/)不能绕过', async () => {
    for (const p of [
      'HOOKS/x.sh',
      'KIT.TOML',
      'codeowners',
      '.GitHub/workflows/a.yml',
      'Adapters/a.ts',
    ]) {
      const s = await scenario({ ...BASE }, { [p]: 'x\n' }, { label: 'kit:reflector' });
      expect(s.codes, p).toEqual(['GUARD_PATH_FORBIDDEN']);
    }
  });

  it('不在允许目录也不在禁区(src/、docs/、third_party/、reports/、根文件)→ GUARD_PATH_OUTSIDE_ALLOWED', async () => {
    for (const p of [
      'src/x.ts',
      'docs/a.md',
      'third_party/a@1/x',
      'reports/c/r.json',
      'README.md',
    ]) {
      const s = await scenario({ ...BASE }, { [p]: 'x\n' }, { label: 'kit:reflector' });
      expect(s.codes, p).toEqual(['GUARD_PATH_OUTSIDE_ALLOWED']);
    }
  });

  it('Rules/(大小写不同于 rules/)不在允许目录;它又是原子路径,内容合法时只报路径', async () => {
    const s = await scenario(
      { ...BASE },
      { 'Rules/general/x.md': atom({ status: 'proposed' }) },
      { label: 'kit:reflector' },
    );
    expect(s.codes).toEqual(['GUARD_PATH_OUTSIDE_ALLOWED']);
  });

  it('反思器 PR 同样受 G1/G2 约束(触碰 status 字段)', async () => {
    const s = await scenario(
      { ...BASE, [ATOM_PATH]: atom({ status: 'proposed' }) },
      { [ATOM_PATH]: atom({ status: 'advisory' }) },
      { label: 'kit:reflector' },
    );
    expect(s.codes).toEqual(['GUARD_G2_STATUS_CHANGED']);
  });

  describe('proposals/ 只增:删除守卫(K6)', () => {
    const PBASE = { ...BASE, 'proposals/p1.yaml': 'id: p1\nbody: a\n' };
    const run = (
      head: Record<string, string | null | { link: string }>,
      label = 'kit:reflector' as const,
    ) => scenario(PBASE, head, { label });

    it('删除已有提案 → GUARD_PATH_PROPOSAL_DELETED(仅此一码)', async () => {
      const s = await run({ 'proposals/p1.yaml': null });
      expect(s.codes).toEqual(['GUARD_PATH_PROPOSAL_DELETED']);
      expect(s.pathsOf('GUARD_PATH_PROPOSAL_DELETED')).toEqual(['proposals/p1.yaml']);
    });

    it('重命名(旧路径视为删除)→ 命中旧路径,新路径不报', async () => {
      const s = await run({ 'proposals/p1.yaml': null, 'proposals/p2.yaml': 'id: p1\nbody: a\n' });
      expect(s.codes).toEqual(['GUARD_PATH_PROPOSAL_DELETED']);
      expect(s.pathsOf('GUARD_PATH_PROPOSAL_DELETED')).toEqual(['proposals/p1.yaml']);
    });

    it('移出 proposals/(到 cases/)同样命中', async () => {
      const s = await run({ 'proposals/p1.yaml': null, 'cases/x/p1.yaml': 'id: p1\n' });
      expect(s.codes).toEqual(['GUARD_PATH_PROPOSAL_DELETED']);
    });

    it('大小写路径变体(直接喂 Change,不依赖本机文件系统是否区分大小写)', () => {
      const mk = (path: string, kind: Change['kind'], headMode = '000000'): Change => ({
        kind,
        path,
        baseMode: '100644',
        headMode,
        baseOid: 'a'.repeat(40),
        headOid: '0'.repeat(40),
      });
      for (const p of ['Proposals/x.yaml', 'PROPOSALS/x.yaml', 'proposals/X.YAML']) {
        const d = checkReflectorPaths([mk(p, 'D')]);
        expect(
          d.map((x) => x.code),
          p,
        ).toContain('GUARD_PATH_PROPOSAL_DELETED');
      }
      // 大小写-only 重命名在 --no-renames 下是 D(旧)+ A(新):旧路径命中
      const ren = checkReflectorPaths([
        mk('proposals/p1.yaml', 'D'),
        { ...mk('Proposals/p1.yaml', 'A', '100644'), baseMode: '000000' },
      ]);
      expect(
        ren.filter((x) => x.code === 'GUARD_PATH_PROPOSAL_DELETED').map((x) => x.path),
      ).toEqual(['proposals/p1.yaml']);
      // 对照:纯新增、普通文件的修改不命中
      expect(
        checkReflectorPaths([{ ...mk('proposals/n.yaml', 'A', '100644'), baseMode: '000000' }]),
      ).toEqual([]);
      expect(checkReflectorPaths([mk('proposals/m.yaml', 'M', '100644')])).toEqual([]);
    });

    it('把提案文件换成符号链接(类型变更)→ 命中', async () => {
      const s = await run({ 'proposals/p1.yaml': { link: '../cases/x/case.yaml' } });
      expect(s.codes).toEqual(['GUARD_PATH_PROPOSAL_DELETED']);
    });

    it('用目录顶替提案文件(proposals/p1.yaml → proposals/p1.yaml/x)→ 命中', async () => {
      const s = await run({ 'proposals/p1.yaml': null, 'proposals/p1.yaml/x': 'id: x\n' });
      expect(s.codes).toEqual(['GUARD_PATH_PROPOSAL_DELETED']);
    });

    it('对照(不误伤):追加内容、改内容、清空内容、新增提案 → 不报本码', async () => {
      const append = await run({ 'proposals/p1.yaml': 'id: p1\nbody: a\nextra: b\n' });
      expect(append.codes).toEqual([]);
      const empty = await run({ 'proposals/p1.yaml': '' });
      expect(empty.codes).not.toContain('GUARD_PATH_PROPOSAL_DELETED');
      const add = await run({ 'proposals/p9.yaml': 'id: p9\n' });
      expect(add.codes).toEqual([]);
    });

    it('对照:无标签的内容 PR 删提案不触发本守卫(守卫只对反思器 PR 生效)', async () => {
      const s = await scenario(PBASE, { 'proposals/p1.yaml': null });
      expect(s.codes).not.toContain('GUARD_PATH_PROPOSAL_DELETED');
    });
  });

  it('对照:无标签的普通内容 PR 改 kit.toml 不触发路径守卫(守卫只对反思器 PR 生效)', async () => {
    const s = await scenario({ ...BASE }, { 'kit.toml': '[kit]\nname = "ok"\n' });
    expect(s.codes).toEqual([]);
  });
});
