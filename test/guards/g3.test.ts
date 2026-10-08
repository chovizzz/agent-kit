import { describe, expect, it } from 'vitest';
import { ATOM_PATH, OTHER_PATH, COMMON_FILES, atom } from '../fixtures/guards/atoms.js';
import { PASS, scenario, useRepoCleanup } from './helpers.js';

useRepoCleanup();

const BASE = { ...COMMON_FILES };
const ATTEST = 'attest/sample-atom/m1-2026-10-08-run1.json';
const REPORT = 'reports/case-1/abc-run1.json';

describe('G3 晋升 PR(kit:promotion)', () => {
  it('合法对照:proposed→advisory + review_by + 新增 attest/reports,判据通过 → 绿', async () => {
    const s = await scenario(
      { ...BASE, [ATOM_PATH]: atom({ status: 'proposed', review_by: '2027-01-08' }) },
      {
        [ATOM_PATH]: atom({ status: 'advisory', review_by: '2027-02-08' }),
        [ATTEST]: '{}\n',
        [REPORT]: '{}\n',
      },
      { label: 'kit:promotion', criteria: PASS },
    );
    expect(s.codes).toEqual([]);
  });

  it('合法对照:advisory→active,多个原子各走各的合法方向 → 绿', async () => {
    const s = await scenario(
      {
        ...BASE,
        [ATOM_PATH]: atom({ status: 'advisory' }),
        [OTHER_PATH]: atom({ id: 'other', status: 'proposed' }),
      },
      {
        [ATOM_PATH]: atom({ status: 'active' }),
        [OTHER_PATH]: atom({ id: 'other', status: 'advisory' }),
      },
      { label: 'kit:promotion', criteria: PASS },
    );
    expect(s.codes).toEqual([]);
  });

  it('判据 stub:缺省检查器一律不通过(而不是静默放行),结构诊断为空', async () => {
    const s = await scenario(
      { ...BASE, [ATOM_PATH]: atom({ status: 'proposed' }) },
      { [ATOM_PATH]: atom({ status: 'advisory' }) },
      { label: 'kit:promotion' },
    );
    expect(s.codes).toEqual(['GUARD_G3_CRITERIA_NOT_IMPLEMENTED']);
  });

  it('非法 1a:多改了别的字段(title)→ GUARD_G3_FIELD_NOT_ALLOWED', async () => {
    const s = await scenario(
      { ...BASE, [ATOM_PATH]: atom({ status: 'proposed' }) },
      { [ATOM_PATH]: atom({ status: 'advisory', title: '偷偷改标题' }) },
      { label: 'kit:promotion', criteria: PASS },
    );
    expect(s.codes).toEqual(['GUARD_G3_FIELD_NOT_ALLOWED']);
  });

  it('非法 1b:多改了正文 / 新增了字段 / 删掉了字段 → GUARD_G3_FIELD_NOT_ALLOWED', async () => {
    const body = await scenario(
      { ...BASE, [ATOM_PATH]: atom({ status: 'proposed' }) },
      { [ATOM_PATH]: atom({ status: 'advisory', body: '**做**:a\n**为什么**:b\n**怎么验**:c\n' }) },
      { label: 'kit:promotion', criteria: PASS },
    );
    expect(body.codes).toEqual(['GUARD_G3_FIELD_NOT_ALLOWED']);
    const added = await scenario(
      { ...BASE, [ATOM_PATH]: atom({ status: 'proposed' }) },
      { [ATOM_PATH]: atom({ status: 'advisory', extraLines: ['escalation_level: 2'] }) },
      { label: 'kit:promotion', criteria: PASS },
    );
    expect(added.codes).toEqual(['GUARD_G3_FIELD_NOT_ALLOWED']);
    const removed = await scenario(
      { ...BASE, [ATOM_PATH]: atom({ status: 'proposed', extraLines: ['escalation_level: 2'] }) },
      { [ATOM_PATH]: atom({ status: 'advisory' }) },
      { label: 'kit:promotion', criteria: PASS },
    );
    expect(removed.codes).toEqual(['GUARD_G3_FIELD_NOT_ALLOWED']);
  });

  it('非法 1c:改了别的文件(kit.toml)/ 新增原子 / 删除原子 / 改已有 attest → GUARD_G3_FORBIDDEN_CHANGE', async () => {
    const mk = (head: Record<string, string | null>) =>
      scenario(
        {
          ...BASE,
          [ATOM_PATH]: atom({ status: 'proposed' }),
          [OTHER_PATH]: atom({ id: 'other' }),
          [ATTEST]: '{}\n',
        },
        { [ATOM_PATH]: atom({ status: 'advisory' }), ...head },
        { label: 'kit:promotion', criteria: PASS },
      );
    expect((await mk({ 'kit.toml': '[kit]\nname = "evil"\n' })).codes).toEqual([
      'GUARD_G3_FORBIDDEN_CHANGE',
    ]);
    expect((await mk({ [ATTEST]: '{"changed":true}\n' })).codes).toEqual([
      'GUARD_G3_FORBIDDEN_CHANGE',
    ]);
    expect((await mk({ [ATTEST]: null })).codes).toEqual(['GUARD_G3_FORBIDDEN_CHANGE']);
    // 原子的新增/删除:断言文案,防止被「mode 变化」这条同码诊断碰巧顶替
    const added = await mk({ 'rules/general/new.md': atom({ id: 'new' }) });
    expect(added.codes).toEqual(['GUARD_G3_FORBIDDEN_CHANGE']);
    expect(added.result.diagnostics[0]?.message).toContain('不得新增/删除/改类型原子文件');
    const deleted = await mk({ [OTHER_PATH]: null });
    expect(deleted.codes).toContain('GUARD_G3_FORBIDDEN_CHANGE');
    expect(deleted.result.diagnostics.map((d) => d.message).join('\n')).toContain(
      '不得新增/删除/改类型原子文件',
    );
  });

  it('非法 2:方向与标签不符(晋升标签 + 退役方向 / 跳级 / 反向)→ GUARD_G3_DIRECTION_NOT_ALLOWED', async () => {
    for (const [from, to] of [
      ['active', 'deprecated'],
      ['deprecated', 'retired'],
      ['advisory', 'deprecated'],
      ['proposed', 'active'],
      ['advisory', 'proposed'],
    ] as const) {
      const s = await scenario(
        { ...BASE, [ATOM_PATH]: atom({ status: from }) },
        { [ATOM_PATH]: atom({ status: to }) },
        { label: 'kit:promotion', criteria: PASS },
      );
      expect(s.codes, `${from}→${to}`).toEqual(['GUARD_G3_DIRECTION_NOT_ALLOWED']);
    }
  });

  it('一个原子合法、另一个方向不合法 → 只有后者命中', async () => {
    const s = await scenario(
      {
        ...BASE,
        [ATOM_PATH]: atom({ status: 'proposed' }),
        [OTHER_PATH]: atom({ id: 'other', status: 'active' }),
      },
      {
        [ATOM_PATH]: atom({ status: 'advisory' }),
        [OTHER_PATH]: atom({ id: 'other', status: 'retired' }),
      },
      { label: 'kit:promotion', criteria: PASS },
    );
    expect(s.codes).toEqual(['GUARD_G3_DIRECTION_NOT_ALLOWED']);
    expect(s.pathsOf('GUARD_G3_DIRECTION_NOT_ALLOWED')).toEqual([OTHER_PATH]);
  });

  it('review_by 单独变动(无 status 转移)→ GUARD_G3_REVIEW_BY_WITHOUT_TRANSITION', async () => {
    const s = await scenario(
      { ...BASE, [ATOM_PATH]: atom({ status: 'advisory', review_by: '2027-01-08' }) },
      { [ATOM_PATH]: atom({ status: 'advisory', review_by: '2030-01-08' }) },
      { label: 'kit:promotion', criteria: PASS },
    );
    expect(s.codes).toEqual(['GUARD_G3_REVIEW_BY_WITHOUT_TRANSITION']);
  });

  it('文件 mode 变化(0644→0755)→ GUARD_G3_FORBIDDEN_CHANGE', async () => {
    const s = await scenario(
      { ...BASE, [ATOM_PATH]: atom({ status: 'proposed' }) },
      { [ATOM_PATH]: { content: atom({ status: 'advisory' }), exec: true } },
      { label: 'kit:promotion', criteria: PASS },
    );
    expect(s.codes).toEqual(['GUARD_G3_FORBIDDEN_CHANGE']);
  });

  it('attest/ 下新增符号链接 → 红(只许普通文件)', async () => {
    const s = await scenario(
      { ...BASE, [ATOM_PATH]: atom({ status: 'proposed' }) },
      { [ATOM_PATH]: atom({ status: 'advisory' }), [ATTEST]: { link: 'x' } },
      { label: 'kit:promotion', criteria: PASS },
    );
    expect(s.codes).toEqual(['GUARD_G3_FORBIDDEN_CHANGE']);
  });

  it('attest/ 的大小写变体(Attest/…)不在白名单 → 红', async () => {
    const s = await scenario(
      { ...BASE, [ATOM_PATH]: atom({ status: 'proposed' }) },
      { [ATOM_PATH]: atom({ status: 'advisory' }), 'Attest/x.json': '{}\n' },
      { label: 'kit:promotion', criteria: PASS },
    );
    expect(s.codes).toEqual(['GUARD_G3_FORBIDDEN_CHANGE']);
  });

  it('只改行尾(LF→CRLF),语义不变 → 不算改动,无转移 → 绿', async () => {
    const s = await scenario(
      { ...BASE, [ATOM_PATH]: atom({ status: 'advisory' }) },
      { [ATOM_PATH]: atom({ status: 'advisory', eol: '\r\n' }) },
      { label: 'kit:promotion', criteria: PASS },
    );
    expect(s.codes).toEqual([]);
  });
});

describe('G3 退役 PR(kit:retire)', () => {
  for (const [from, to] of [
    ['active', 'deprecated'],
    ['deprecated', 'retired'],
    ['advisory', 'deprecated'], // 回滚
  ] as const) {
    it(`合法对照:${from} → ${to},判据通过 → 绿`, async () => {
      const s = await scenario(
        { ...BASE, [ATOM_PATH]: atom({ status: from }) },
        { [ATOM_PATH]: atom({ status: to }), [REPORT]: '{}\n' },
        { label: 'kit:retire', criteria: PASS },
      );
      expect(s.codes).toEqual([]);
    });
  }

  it('判据 stub:缺省检查器 → 不通过', async () => {
    const s = await scenario(
      { ...BASE, [ATOM_PATH]: atom({ status: 'active' }) },
      { [ATOM_PATH]: atom({ status: 'deprecated' }) },
      { label: 'kit:retire' },
    );
    expect(s.codes).toEqual(['GUARD_G3_CRITERIA_NOT_IMPLEMENTED']);
  });

  it('非法 1:多改了字段(owner / signature)→ GUARD_G3_FIELD_NOT_ALLOWED', async () => {
    const s = await scenario(
      { ...BASE, [ATOM_PATH]: atom({ status: 'active' }) },
      { [ATOM_PATH]: atom({ status: 'deprecated', extraLines: ['origin: p-9'] }) },
      { label: 'kit:retire', criteria: PASS },
    );
    expect(s.codes).toEqual(['GUARD_G3_FIELD_NOT_ALLOWED']);
  });

  it('非法 2:方向与标签不符(退役标签 + 晋升方向 / active→retired 跳级 / 复活)', async () => {
    for (const [from, to] of [
      ['proposed', 'advisory'],
      ['advisory', 'active'],
      ['active', 'retired'],
      ['retired', 'active'],
      ['deprecated', 'active'],
    ] as const) {
      const s = await scenario(
        { ...BASE, [ATOM_PATH]: atom({ status: from }) },
        { [ATOM_PATH]: atom({ status: to }) },
        { label: 'kit:retire', criteria: PASS },
      );
      expect(s.codes, `${from}→${to}`).toEqual(['GUARD_G3_DIRECTION_NOT_ALLOWED']);
    }
  });

  it('非法 3:顺手删除原子文件 → G3 FORBIDDEN_CHANGE(且 G4 也拦)', async () => {
    const s = await scenario(
      { ...BASE, [ATOM_PATH]: atom({ status: 'retired' }) },
      { [ATOM_PATH]: null },
      { label: 'kit:retire', criteria: PASS },
    );
    expect(s.codes).toEqual(['GUARD_G3_FORBIDDEN_CHANGE', 'GUARD_G4_NOT_IN_STABLE_TAG']);
  });
});

describe('kit:attest PR:只许新增 attest/**', () => {
  it('合法对照:只新增 attest 文件 → 绿', async () => {
    const s = await scenario(
      { ...BASE },
      { [ATTEST]: '{}\n', 'attest/b/c.json': '{}\n' },
      { label: 'kit:attest' },
    );
    expect(s.codes).toEqual([]);
  });

  it('改 status / 改原子 / 新增 reports / 改已有 attest / 改 kit.toml → GUARD_ATTEST_SCOPE', async () => {
    const base = { ...BASE, [ATOM_PATH]: atom({ status: 'proposed' }), [ATTEST]: '{}\n' };
    const heads: Record<string, string>[] = [
      { [ATOM_PATH]: atom({ status: 'advisory' }) },
      { [ATOM_PATH]: atom({ status: 'proposed', title: 'x' }) },
      { [REPORT]: '{}\n' },
      { [ATTEST]: '{"changed":1}\n' },
      { 'kit.toml': 'x = 1\n' },
    ];
    for (const head of heads) {
      const s = await scenario(base, head, { label: 'kit:attest' });
      expect(s.codes, JSON.stringify(Object.keys(head))).toEqual(['GUARD_ATTEST_SCOPE']);
    }
  });
});
