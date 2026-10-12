import { afterEach, describe, expect, it, vi } from 'vitest';
import { budgetDeps, run } from '../../src/commands/check-budget.js';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { cmdCtx, GOOD_ATOM, makeRepo, OWNER_LINE } from '../atoms/helpers.js';

/** 清理项 3:check-budget 与 build 管线一致,合并结果出现重复原子 id 时 fail-closed(退出 3),不渲染。 */
const state = vi.hoisted(() => ({ duplicate: false }));

vi.mock('../../src/merge/merge.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/merge/merge.js')>();
  return {
    ...real,
    mergeAtoms: (...args: Parameters<typeof real.mergeAtoms>) => {
      const r = real.mergeAtoms(...args);
      // 模拟「合并不变量被破坏」:结果里同一 id 出现两次(真实 merge 无 error 时不会发生)
      return state.duplicate && r.atoms[0] ? { ...r, atoms: [...r.atoms, r.atoms[0]] } : r;
    },
  };
});

const OPTS = { guards: false, base: undefined, head: undefined, label: undefined, report: false };
const KIT_TOML = `[kit]
name = "t"
version = "0.0.0"

[agents]
enabled = ["claude"]

[budget]
enforce = "warn"

[budget.claude]
max_lines = 10
limit_source = "documented"

[channels.canary.members]

[channels.stable.members]
`;
const FILES = {
  CODEOWNERS: OWNER_LINE,
  'cases/x/case.yaml': 'name: x\n',
  'kit.toml': KIT_TOML,
  'rules/team/good-atom.md': GOOD_ATOM,
};

afterEach(() => {
  state.duplicate = false;
  delete budgetDeps.render;
});

describe('check 预算步骤:重复原子 id 预检', () => {
  it('合并结果含重复 id → 退出 3,点名重复 id,不调用渲染', async () => {
    const { root } = await makeRepo(FILES);
    const { ctx, err } = cmdCtx(root);
    let rendered = false;
    budgetDeps.render = () => {
      rendered = true;
      return {
        files: [],
        report: {
          dropped: [],
          sideEffects: [],
          shadowChecks: [],
          pendingProbes: [],
          skippedLayers: [],
        },
      };
    };
    state.duplicate = true;
    expect(await run(ctx, OPTS)).toBe(ExitCode.FAIL_CLOSED);
    expect(err.join('')).toContain('重复原子 id');
    expect(err.join('')).toContain('good-atom');
    expect(rendered).toBe(false);
  });

  it('正向对照:同一仓库、无重复 → 渲染被调用,退出 0', async () => {
    const { root } = await makeRepo(FILES);
    const { ctx } = cmdCtx(root);
    let rendered = false;
    budgetDeps.render = () => {
      rendered = true;
      return {
        files: [],
        report: {
          dropped: [],
          sideEffects: [],
          shadowChecks: [],
          pendingProbes: [],
          skippedLayers: [],
        },
      };
    };
    expect(await run(ctx, OPTS)).toBe(ExitCode.OK);
    expect(rendered).toBe(true);
  });
});
