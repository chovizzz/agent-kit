import { describe, expect, it } from 'vitest';
import { hasErrors } from '../../src/contracts/diagnostics.js';
import { MergeResultSchema } from '../../src/contracts/merge.js';
import { mergeAtoms } from '../../src/merge/merge.js';
import { mergeCounts, mergeReportText } from '../../src/merge/report.js';
import { atom, codes, ids } from './helpers.js';

describe('合并规则 5:personal 层', () => {
  it('personal 原子出现在合并结果里(正向控制),且被标记为不可入 core 输出', () => {
    const r = mergeAtoms([
      atom('org-rule', 'org'),
      atom('my-habit', 'personal'),
      atom('repo-rule', 'project'),
    ]);
    expect(ids(r)).toContain('my-habit');
    const mine = r.atoms.find((a) => a.atom.fm.id === 'my-habit');
    expect(mine?.layer).toBe('personal');
    expect(mine?.coreEligible).toBe(false);
    // 对照组:其它层都可入 core,否则上面的断言可能只是「全部 false」
    for (const id of ['org-rule', 'repo-rule']) {
      expect(r.atoms.find((a) => a.atom.fm.id === id)?.coreEligible).toBe(true);
    }
    expect(mergeCounts(r)).toEqual({ total: 3, core: 2, personal: 1 });
    expect(mergeReportText(r)).toContain('my-habit(personal)');
  });

  it('personal 层的 must 也照样不可入 core', () => {
    const r = mergeAtoms([atom('my-must', 'personal', { strength: 'must' })]);
    expect(r.atoms[0]?.coreEligible).toBe(false);
  });
});

describe('合并规则 1:must 由上层锁定', () => {
  it('下层对上层 must 写 overrides → MERGE_MUST_LOCKED', () => {
    const r = mergeAtoms([
      atom('lock-me', 'org', { strength: 'must' }),
      atom('sneaky', 'project', { overrides: ['lock-me'] }),
    ]);
    expect(codes(r)).toEqual(['MERGE_MUST_LOCKED']);
    expect(hasErrors(r.diagnostics)).toBe(true);
    // 出错时不替换:must 仍在
    expect(ids(r)).toContain('lock-me');
  });

  it('下层对上层 must 写 disables → MERGE_MUST_LOCKED', () => {
    const r = mergeAtoms([
      atom('lock-me', 'team', { strength: 'must' }),
      atom('sneaky', 'personal', { disables: ['lock-me'] }),
    ]);
    expect(codes(r)).toEqual(['MERGE_MUST_LOCKED']);
    expect(ids(r)).toContain('lock-me');
  });

  it('同层覆盖 must 也拒绝(保守)', () => {
    const r = mergeAtoms([
      atom('lock-me', 'team', { strength: 'must' }),
      atom('peer', 'team', { overrides: ['lock-me'] }),
    ]);
    expect(codes(r)).toEqual(['MERGE_MUST_LOCKED']);
  });

  it('正向控制:同样的下层对上层 should 写 overrides 是合法的', () => {
    const r = mergeAtoms([atom('soft', 'org'), atom('sneaky', 'project', { overrides: ['soft'] })]);
    expect(r.diagnostics).toEqual([]);
    expect(ids(r)).toEqual(['sneaky']);
  });

  it('下层可以新增 must(只能收紧)', () => {
    const r = mergeAtoms([atom('base', 'org'), atom('tighter', 'project', { strength: 'must' })]);
    expect(r.diagnostics).toEqual([]);
    expect(ids(r).sort()).toEqual(['base', 'tighter']);
  });
});

describe('合并规则 2:should 可被替换或关闭', () => {
  it('overrides:目标被剔除,覆盖者记 replaced,overridden 列出每一条', () => {
    const r = mergeAtoms([
      atom('soft', 'team'),
      atom('better', 'project', { overrides: ['soft'] }),
    ]);
    expect(ids(r)).toEqual(['better']);
    expect(r.atoms[0]?.replaced).toEqual(['soft']);
    expect(r.overridden).toEqual([
      { id: 'soft', by: 'better', kind: 'overrides', byLayer: 'project' },
    ]);
    expect(mergeReportText(r)).toContain('soft ← project 层的 better(替换)');
  });

  it('disables:personal / project 层可以关掉上层 should,目标被剔除、覆盖者不记 replaced', () => {
    for (const layer of ['personal', 'project'] as const) {
      const r = mergeAtoms([atom('soft', 'org'), atom('off', layer, { disables: ['soft'] })]);
      expect(r.diagnostics).toEqual([]);
      expect(ids(r)).toEqual(['off']);
      expect(r.atoms[0]?.replaced).toEqual([]);
      expect(r.overridden).toEqual([{ id: 'soft', by: 'off', kind: 'disables', byLayer: layer }]);
    }
  });

  it('org / team 层不能 disables → MERGE_DISABLE_NOT_ALLOWED,目标不被关闭', () => {
    for (const layer of ['org', 'team'] as const) {
      const r = mergeAtoms([atom('soft', 'org'), atom('off', layer, { disables: ['soft'] })]);
      expect(codes(r)).toEqual(['MERGE_DISABLE_NOT_ALLOWED']);
      expect(ids(r)).toContain('soft');
    }
  });

  it('同层 should 可以互相替换(就近)', () => {
    const r = mergeAtoms([
      atom('old-one', 'team'),
      atom('new-one', 'team', { overrides: ['old-one'] }),
    ]);
    expect(r.diagnostics).toEqual([]);
    expect(ids(r)).toEqual(['new-one']);
  });

  it('目标不存在 → MERGE_TARGET_MISSING', () => {
    const r = mergeAtoms([atom('lonely', 'project', { overrides: ['ghost'] })]);
    expect(codes(r)).toEqual(['MERGE_TARGET_MISSING']);
  });

  it('上层去覆盖更下层 → MERGE_OVERRIDE_DIRECTION', () => {
    const r = mergeAtoms([atom('low', 'project'), atom('high', 'org', { overrides: ['low'] })]);
    expect(codes(r)).toEqual(['MERGE_OVERRIDE_DIRECTION']);
    expect(ids(r).sort()).toEqual(['high', 'low']);
  });

  it('互相覆盖成环 → MERGE_OVERRIDE_CYCLE,两者都不被静默删除', () => {
    const r = mergeAtoms([
      atom('aaa', 'team', { overrides: ['bbb'] }),
      atom('bbb', 'team', { overrides: ['aaa'] }),
    ]);
    expect(codes(r)).toEqual(['MERGE_OVERRIDE_CYCLE', 'MERGE_OVERRIDE_CYCLE']);
    expect(ids(r).sort()).toEqual(['aaa', 'bbb']);
  });

  it('环上原子对第三方的 overrides 也作废:c 不被删除', () => {
    const r = mergeAtoms([
      atom('aaa', 'team', { overrides: ['bbb', 'ccc'] }),
      atom('bbb', 'team', { overrides: ['aaa'] }),
      atom('ccc', 'team'),
    ]);
    expect(codes(r)).toEqual(['MERGE_OVERRIDE_CYCLE', 'MERGE_OVERRIDE_CYCLE']);
    expect(ids(r).sort()).toEqual(['aaa', 'bbb', 'ccc']);
    expect(r.overridden).toEqual([]);
  });

  it('链式覆盖:C 覆盖 B、B 覆盖 A,只剩 C', () => {
    const r = mergeAtoms([
      atom('aaa', 'org'),
      atom('bbb', 'team', { overrides: ['aaa'] }),
      atom('ccc', 'project', { overrides: ['bbb'] }),
    ]);
    expect(r.diagnostics).toEqual([]);
    expect(ids(r)).toEqual(['ccc']);
    expect(r.overridden.map((o) => `${o.id}<-${o.by}`)).toEqual(['aaa<-bbb', 'bbb<-ccc']);
  });
});

describe('合并规则 3:同 id 重复', () => {
  it('两层同 id、没有 overrides → MERGE_DUPLICATE_ID(不允许静默覆盖)', () => {
    const r = mergeAtoms([
      atom('same-id', 'org'),
      atom('same-id', 'project', { path: 'p/same-id.md' }),
    ]);
    expect(codes(r)).toEqual(['MERGE_DUPLICATE_ID']);
    expect(hasErrors(r.diagnostics)).toBe(true);
    expect(ids(r)).toEqual(['same-id', 'same-id']);
  });

  it('正向控制:下层显式 overrides: [同 id] 则替换上层同 id', () => {
    const r = mergeAtoms([
      atom('same-id', 'org'),
      atom('same-id', 'project', { overrides: ['same-id'], path: 'p/same-id.md' }),
    ]);
    expect(r.diagnostics).toEqual([]);
    expect(r.atoms).toHaveLength(1);
    expect(r.atoms[0]?.layer).toBe('project');
    expect(r.atoms[0]?.replaced).toEqual(['same-id']);
  });

  it('三层同 id 且逐层声明 overrides:最下层胜,中间层不被误判为「覆盖更下层」', () => {
    const r = mergeAtoms([
      atom('same-id', 'org', { path: 'o/same-id.md' }),
      atom('same-id', 'team', { overrides: ['same-id'], path: 't/same-id.md' }),
      atom('same-id', 'project', { overrides: ['same-id'], path: 'p/same-id.md' }),
    ]);
    expect(r.diagnostics).toEqual([]);
    expect(r.atoms).toHaveLength(1);
    expect(r.atoms[0]?.layer).toBe('project');
  });

  it('只有一份却写 overrides: [自己的 id] → MERGE_TARGET_MISSING', () => {
    const r = mergeAtoms([atom('same-id', 'project', { overrides: ['same-id'] })]);
    expect(codes(r)).toEqual(['MERGE_TARGET_MISSING']);
    expect(ids(r)).toEqual(['same-id']);
  });

  it('同层同 id 永远报错,即使写了 overrides', () => {
    const r = mergeAtoms([
      atom('same-id', 'team', { path: 'a/same-id.md' }),
      atom('same-id', 'team', { overrides: ['same-id'], path: 'b/same-id.md' }),
    ]);
    expect(codes(r)).toContain('MERGE_DUPLICATE_ID');
  });

  it('同 id 且上层是 must:下层同 id 覆盖被锁定', () => {
    const r = mergeAtoms([
      atom('same-id', 'org', { strength: 'must' }),
      atom('same-id', 'project', { overrides: ['same-id'], path: 'p/same-id.md' }),
    ]);
    expect(codes(r)).toEqual(['MERGE_MUST_LOCKED']);
  });
});

describe('确定性与契约', () => {
  it('输出与输入顺序无关;按(层权威, id)排序', () => {
    const a = [atom('zzz', 'project'), atom('bbb', 'org'), atom('aaa', 'team'), atom('ccc', 'org')];
    const r1 = mergeAtoms(a);
    const r2 = mergeAtoms([...a].reverse());
    expect(r1).toEqual(r2);
    expect(ids(r1)).toEqual(['bbb', 'ccc', 'aaa', 'zzz']);
  });

  it('结果满足 MergeResultSchema;空输入合法', () => {
    const r = mergeAtoms([atom('x-y', 'org'), atom('z-w', 'personal')]);
    expect(MergeResultSchema.safeParse(r).success).toBe(true);
    expect(mergeAtoms([])).toEqual({ atoms: [], overridden: [], diagnostics: [] });
  });
});
