import { describe, expect, it } from 'vitest';
import { ATOM_PATH, COMMON_FILES, atom } from '../fixtures/guards/atoms.js';
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

  it('对照:无标签的普通内容 PR 改 kit.toml 不触发路径守卫(守卫只对反思器 PR 生效)', async () => {
    const s = await scenario({ ...BASE }, { 'kit.toml': '[kit]\nname = "ok"\n' });
    expect(s.codes).toEqual([]);
  });
});
