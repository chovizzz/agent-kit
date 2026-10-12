import { describe, expect, it } from 'vitest';
import { hasErrors } from '../../src/contracts/diagnostics.js';
import { MergeResultSchema } from '../../src/contracts/merge.js';
import { mergeAtoms } from '../../src/merge/merge.js';
import { atom, codes, ids } from './helpers.js';

/** 清理项 6(GD-1 根因):只采纳 active/advisory 声明者的 overrides/disables;其余状态只校验、不应用。 */
const ADOPTED = ['active', 'advisory'] as const;
const NOT_ADOPTED = ['proposed', 'deprecated', 'retired'] as const;

describe('GD-1:声明者 status 决定边是否生效', () => {
  it('正向对照:active / advisory 声明者的 overrides、disables 照常生效并记入 overridden', () => {
    for (const status of ADOPTED) {
      const o = mergeAtoms([
        atom('soft', 'team'),
        atom('better', 'project', { overrides: ['soft'], status }),
      ]);
      expect(ids(o), status).toEqual(['better']);
      expect(o.atoms[0]?.replaced, status).toEqual(['soft']);
      expect(o.overridden, status).toEqual([
        { id: 'soft', by: 'better', kind: 'overrides', byLayer: 'project' },
      ]);
      const d = mergeAtoms([
        atom('soft', 'org'),
        atom('off', 'project', { disables: ['soft'], status }),
      ]);
      expect(ids(d), status).toEqual(['off']);
      expect(d.overridden, status).toHaveLength(1);
    }
  });

  it('proposed / deprecated / retired 声明者:overrides 不剔除目标、不记 replaced、不进 overridden', () => {
    for (const status of NOT_ADOPTED) {
      const r = mergeAtoms([
        atom('soft', 'team'),
        atom('better', 'project', { overrides: ['soft'], status }),
      ]);
      expect(r.diagnostics, status).toEqual([]);
      expect(ids(r).sort(), status).toEqual(['better', 'soft']);
      expect(r.atoms.find((a) => a.atom.fm.id === 'better')?.replaced, status).toEqual([]);
      expect(r.overridden, status).toEqual([]);
    }
  });

  it('proposed / deprecated / retired 声明者:disables 不关闭目标、不进 overridden', () => {
    for (const status of NOT_ADOPTED) {
      const r = mergeAtoms([
        atom('soft', 'org'),
        atom('off', 'project', { disables: ['soft'], status }),
      ]);
      expect(r.diagnostics, status).toEqual([]);
      expect(ids(r).sort(), status).toEqual(['off', 'soft']);
      expect(r.overridden, status).toEqual([]);
    }
  });

  it('preview 视图同样遵守 status(personal 的边在 preview 生效,但 proposed 的 personal 边仍不生效)', () => {
    const live = mergeAtoms(
      [atom('soft', 'team'), atom('mine', 'personal', { disables: ['soft'], status: 'active' })],
      { view: 'preview' },
    );
    expect(ids(live)).toEqual(['mine']);
    const prop = mergeAtoms(
      [atom('soft', 'team'), atom('mine', 'personal', { disables: ['soft'], status: 'proposed' })],
      { view: 'preview' },
    );
    expect(ids(prop).sort()).toEqual(['mine', 'soft']);
  });

  it('不采纳的边仍做全部校验:MUST_LOCKED / TARGET_MISSING / DIRECTION / DISABLE_NOT_ALLOWED 照报 error', () => {
    const must = mergeAtoms([
      atom('lock', 'org', { strength: 'must' }),
      atom('x', 'project', { overrides: ['lock'], status: 'proposed' }),
    ]);
    expect(codes(must)).toEqual(['MERGE_MUST_LOCKED']);
    expect(hasErrors(must.diagnostics)).toBe(true);
    expect(
      codes(mergeAtoms([atom('x', 'project', { disables: ['nope'], status: 'retired' })])),
    ).toEqual(['MERGE_TARGET_MISSING']);
    expect(
      codes(
        mergeAtoms([
          atom('low', 'project'),
          atom('up', 'org', { overrides: ['low'], status: 'deprecated' }),
        ]),
      ),
    ).toEqual(['MERGE_OVERRIDE_DIRECTION']);
    expect(
      codes(
        mergeAtoms([atom('t', 'org'), atom('y', 'team', { disables: ['t'], status: 'proposed' })]),
      ),
    ).toEqual(['MERGE_DISABLE_NOT_ALLOWED']);
  });

  it('不采纳的边仍参与环检测:环上的 proposed 原子报 MERGE_OVERRIDE_CYCLE,不静默放过', () => {
    const r = mergeAtoms([
      atom('a-one', 'project', { overrides: ['b-two'], status: 'proposed' }),
      atom('b-two', 'project', { overrides: ['a-one'] }),
    ]);
    expect(codes(r)).toContain('MERGE_OVERRIDE_CYCLE');
    expect(ids(r).sort()).toEqual(['a-one', 'b-two']);
  });

  it('链式:C(proposed)覆盖 B、B(active)覆盖 A → A 被 B 剔除,B 保留(C 的边不生效)', () => {
    const r = mergeAtoms([
      atom('a-one', 'org'),
      atom('b-two', 'team', { overrides: ['a-one'], status: 'active' }),
      atom('c-three', 'project', { overrides: ['b-two'], status: 'proposed' }),
    ]);
    expect(ids(r).sort()).toEqual(['b-two', 'c-three']);
    expect(r.overridden.map((o) => `${o.id}<-${o.by}`)).toEqual(['a-one<-b-two']);
  });

  it('同 id 替换件是 proposed:不报重复 id,上层原子胜出,替换件不进 resolved(不会两份同 id 一起渲染)', () => {
    for (const status of NOT_ADOPTED) {
      const r = mergeAtoms([
        atom('same-id', 'team'),
        atom('same-id', 'project', { overrides: ['same-id'], status, path: 'p/same-id.md' }),
      ]);
      // 被丢弃的替换不能静默:给一条 warn(契约里没有 info 档),不是 error,放行语义不变
      expect(r.diagnostics, status).toEqual([
        {
          code: 'MERGE_REPLACEMENT_INERT',
          severity: 'warn',
          path: 'p/same-id.md#/overrides',
          message: expect.stringContaining(`status 为 ${status}`),
        },
      ]);
      expect(hasErrors(r.diagnostics), status).toBe(false);
      expect(
        r.atoms.map((a) => `${a.layer}/${a.atom.fm.id}`),
        status,
      ).toEqual(['team/same-id']);
      expect(r.overridden, status).toEqual([]);
    }
    // 对照:同样的写法,advisory 的替换件生效,替换掉 team 原子
    const ok = mergeAtoms([
      atom('same-id', 'team'),
      atom('same-id', 'project', { overrides: ['same-id'], path: 'p/same-id.md' }),
    ]);
    expect(ok.atoms.map((a) => a.layer)).toEqual(['project']);
    expect(ok.diagnostics).toEqual([]); // 生效的替换不报
  });

  it('不同 id 的 overrides 不生效时不报 MERGE_REPLACEMENT_INERT(诊断只针对被丢弃的同 id 替换)', () => {
    const r = mergeAtoms([
      atom('soft', 'team'),
      atom('better', 'project', { overrides: ['soft'], status: 'proposed' }),
    ]);
    expect(codes(r)).not.toContain('MERGE_REPLACEMENT_INERT');
  });

  it('G1/G2/B2 不回归:personal 的边在 core 视图仍不生效(无论 status);结果满足 schema', () => {
    for (const status of ADOPTED) {
      const r = mergeAtoms([
        atom('soft', 'team'),
        atom('mine', 'personal', { disables: ['soft'], status }),
      ]);
      expect(ids(r).sort(), status).toEqual(['mine', 'soft']);
      if (status === 'advisory') expect(MergeResultSchema.safeParse(r).success).toBe(true); // active 的合成原子没有 signature
    }
  });
});
