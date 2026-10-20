import { describe, expect, it } from 'vitest';
import { ATOM_PATH, COMMON_FILES, atom } from '../fixtures/guards/atoms.js';
import { checkReflectorPaths } from '../../src/guards/path-guard.js';
import type { Change } from '../../src/guards/types.js';
import type { FileMap } from '../helpers/make-repo.js';
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
    const run = (head: FileMap, label = 'kit:reflector' as const) =>
      scenario(PBASE, head, { label });

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
      // 对照:纯新增不命中任何提案码;普通文件的修改只命中 MODIFIED(不是 DELETED),大小写变体同样
      expect(
        checkReflectorPaths([{ ...mk('proposals/n.yaml', 'A', '100644'), baseMode: '000000' }]),
      ).toEqual([]);
      for (const p of ['proposals/m.yaml', 'Proposals/m.yaml']) {
        expect(checkReflectorPaths([mk(p, 'M', '100644')]).map((x) => x.code)).toEqual([
          'GUARD_PATH_PROPOSAL_MODIFIED',
          ...(p.startsWith('P') ? ['GUARD_PATH_OUTSIDE_ALLOWED'] : []),
        ]);
      }
    });

    it('把提案文件换成符号链接(类型变更)→ 命中', async () => {
      const s = await run({ 'proposals/p1.yaml': { link: '../cases/x/case.yaml' } });
      expect(s.codes).toEqual(['GUARD_PATH_PROPOSAL_DELETED']);
    });

    it('用目录顶替提案文件(proposals/p1.yaml → proposals/p1.yaml/x)→ 命中', async () => {
      const s = await run({ 'proposals/p1.yaml': null, 'proposals/p1.yaml/x': 'id: x\n' });
      expect(s.codes).toEqual(['GUARD_PATH_PROPOSAL_DELETED']);
    });

    it('只许新增:追加、改内容、清空成空文件、仅改权限位 → GUARD_PATH_PROPOSAL_MODIFIED(不是 DELETED)', async () => {
      for (const [name, head] of <[string, FileMap][]>[
        ['追加', { 'proposals/p1.yaml': 'id: p1\nbody: a\nextra: b\n' }],
        ['改内容', { 'proposals/p1.yaml': 'id: p1\nbody: b\n' }],
        ['清空', { 'proposals/p1.yaml': '' }],
        [
          '仅改权限位',
          { 'proposals/p1.yaml': { content: 'id: p1\nbody: a\n', exec: true as const } },
        ],
      ]) {
        const s = await run(head);
        expect(s.codes, name).toEqual(['GUARD_PATH_PROPOSAL_MODIFIED']);
        expect(s.pathsOf('GUARD_PATH_PROPOSAL_MODIFIED'), name).toEqual(['proposals/p1.yaml']);
      }
    });

    it('对照(不误伤):新增提案、改别的目录 → 绿', async () => {
      const add = await run({ 'proposals/p9.yaml': 'id: p9\n' });
      expect(add.codes).toEqual([]);
    });

    it('对照:无标签的内容 PR 不触发反思器路径守卫的两个提案码(改走下面的无标签判据)', async () => {
      const del = await scenario(PBASE, { 'proposals/p1.yaml': null });
      expect(del.codes).not.toContain('GUARD_PATH_PROPOSAL_DELETED');
      const mod = await scenario(PBASE, { 'proposals/p1.yaml': 'id: p1\nbody: b\n' });
      expect(mod.codes).toEqual([]);
    });
  });

  describe('无标签内容 PR 不得删提案(K6)', () => {
    const PBASE = { ...BASE, 'proposals/p1.yaml': 'id: p1\nbody: a\n' };

    it('无标签删除 / 重命名旧路径 / 换成符号链接 → GUARD_PROPOSAL_DELETED_UNLABELED', async () => {
      for (const head of <FileMap[]>[
        { 'proposals/p1.yaml': null },
        { 'proposals/p1.yaml': null, 'proposals/p2.yaml': 'id: p1\nbody: a\n' },
        { 'proposals/p1.yaml': { link: '../cases/x/case.yaml' } },
      ]) {
        const s = await scenario(PBASE, head);
        expect(s.codes).toEqual(['GUARD_PROPOSAL_DELETED_UNLABELED']);
        expect(s.pathsOf('GUARD_PROPOSAL_DELETED_UNLABELED')).toEqual(['proposals/p1.yaml']);
      }
    });

    it('对照(不因此拒):无标签新增提案、修改提案内容(含清空)→ 绿', async () => {
      for (const head of <FileMap[]>[
        { 'proposals/p9.yaml': 'id: p9\n' },
        { 'proposals/p1.yaml': 'id: p1\nbody: b\n' },
        { 'proposals/p1.yaml': '' },
      ]) {
        expect((await scenario(PBASE, head)).codes).toEqual([]);
      }
    });

    it('其他标签行为不变:kit:attest 删提案按既有范围判(GUARD_ATTEST_SCOPE),不出现无标签码', async () => {
      const s = await scenario(PBASE, { 'proposals/p1.yaml': null }, { label: 'kit:attest' });
      expect(s.codes).toEqual(['GUARD_ATTEST_SCOPE']);
    });

    it('kit:promotion / kit:retire 下删提案按各自守卫判(不出现无标签码)', async () => {
      for (const label of ['kit:promotion', 'kit:retire'] as const) {
        const s = await scenario(PBASE, { 'proposals/p1.yaml': null }, { label });
        expect(s.codes, label).not.toContain('GUARD_PROPOSAL_DELETED_UNLABELED');
        expect(s.codes, label).toContain('GUARD_G3_FORBIDDEN_CHANGE');
      }
    });

    it('反思器标签下删提案只出反思器码,不重复出无标签码', async () => {
      const s = await scenario(PBASE, { 'proposals/p1.yaml': null }, { label: 'kit:reflector' });
      expect(s.codes).toEqual(['GUARD_PATH_PROPOSAL_DELETED']);
    });
  });

  it('对照:无标签的普通内容 PR 改 kit.toml 不触发路径守卫(守卫只对反思器 PR 生效)', async () => {
    const s = await scenario({ ...BASE }, { 'kit.toml': '[kit]\nname = "ok"\n' });
    expect(s.codes).toEqual([]);
  });
});
