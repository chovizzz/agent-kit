import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { budgetDeps, run } from '../../src/commands/check-budget.js';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import type { RenderInput } from '../../src/contracts/render.js';
import { createIoContext } from '../../src/io/paths.js';
import { readText } from '../../src/io/read-fs.js';
import { cmdCtx, GOOD_ATOM, makeRepo, OWNER_LINE } from '../atoms/helpers.js';
import { REPO_ROOT } from '../helpers/tmp.js';
import { ascii, out } from './helpers.js';

const OPTS = { guards: false, base: undefined, head: undefined, label: undefined, report: false };
const EMPTY_REPORT = {
  dropped: [],
  sideEffects: [],
  shadowChecks: [],
  pendingProbes: [],
  skippedLayers: [],
};

const KIT_TOML = (enforce = 'warn'): string => `[kit]
name = "t"
version = "0.0.0"

[agents]
enabled = ["claude", "codex"]

[budget]
enforce = "${enforce}"

[budget.claude]
max_lines = 10
limit_source = "documented"

[budget.codex]
max_bytes = 1000
limit_source = "documented"

[channels.canary.members]

[channels.stable.members]
`;

const atomFile = (id: string, layer: string, extra = ''): string =>
  GOOD_ATOM.replace('id: good-atom', `id: ${id}`)
    .replace('layer: team', `layer: ${layer}`)
    .replace('verifier:', `${extra}verifier:`);

const BASE = { CODEOWNERS: OWNER_LINE, 'cases/x/case.yaml': 'name: x\n' };

afterEach(() => {
  delete budgetDeps.render;
  delete budgetDeps.projectChain;
});

describe('check 的预算步骤(默认渲染路径 = 当前的适配器桩)', () => {
  it('真实形状的仓库:warn 下退出 0,并打印各目标字节/行数(桩适配器 ⇒ 0)', async () => {
    const { root } = await makeRepo({ ...BASE, 'kit.toml': KIT_TOML() });
    const { ctx, out: o } = cmdCtx(root);
    expect(await run(ctx, OPTS)).toBe(ExitCode.OK);
    const text = o.join('');
    expect(text).toContain('budget claude: 0 字节 / 0 行 [ok] max_lines=10');
    expect(text).toContain('budget codex: 0 字节 / 0 行 [ok] max_bytes=1000');
  });

  it('personal 原子:合并结果里有、被标记为不可入 core(摘要里可见)', async () => {
    const { root } = await makeRepo({
      ...BASE,
      'kit.toml': KIT_TOML(),
      'rules/team/team-rule.md': atomFile('team-rule', 'team'),
      'rules/personal/my-habit.md': atomFile('my-habit', 'personal'),
    });
    const { ctx, out: o } = cmdCtx(root);
    let seen: RenderInput | undefined;
    budgetDeps.render = (input) => {
      seen = input;
      return { files: [], report: EMPTY_REPORT };
    };
    expect(await run(ctx, OPTS)).toBe(ExitCode.OK);
    expect(seen?.resolved.map((r) => [r.atom.fm.id, r.coreEligible])).toEqual([
      ['team-rule', true],
      ['my-habit', false],
    ]);
    expect(o.join('')).toContain('1 个原子可入 core 输出, 1 个 personal 原子不入');
  });

  it('合并出错(同层同 id 之类)→ 退出 1,不计算预算', async () => {
    const { root } = await makeRepo({
      ...BASE,
      'kit.toml': KIT_TOML(),
      'rules/team/soft-one.md': atomFile('soft-one', 'team'),
      'rules/team/off-one.md': atomFile('off-one', 'team', 'disables:\n  - soft-one\n'),
    });
    const { ctx, out: o } = cmdCtx(root);
    expect(await run(ctx, OPTS)).toBe(ExitCode.CHECK_FAILED);
    expect(o.join('')).toContain('error MERGE_DISABLE_NOT_ALLOWED');
    expect(o.join('')).toContain('合并失败,未计算预算');
    expect(o.join('')).not.toContain('budget claude:');
  });

  it('渲染抛错 → 退出 3(fail-closed)', async () => {
    const { root } = await makeRepo({ ...BASE, 'kit.toml': KIT_TOML() });
    const { ctx, err } = cmdCtx(root);
    budgetDeps.render = () => {
      throw new Error('boom');
    };
    expect(await run(ctx, OPTS)).toBe(ExitCode.FAIL_CLOSED);
    expect(err.join('')).toContain('渲染失败');
  });

  it('缺 kit.toml / kit.toml 非法 → 退出 1 且说明原因', async () => {
    const a = await makeRepo({ ...BASE });
    const ca = cmdCtx(a.root);
    expect(await run(ca.ctx, OPTS)).toBe(ExitCode.CHECK_FAILED);
    expect(ca.out.join('')).toContain('CFG_KIT_TOML_MISSING');
    const b = await makeRepo({ ...BASE, 'kit.toml': 'not = [valid' });
    const cb = cmdCtx(b.root);
    expect(await run(cb.ctx, OPTS)).toBe(ExitCode.CHECK_FAILED);
    expect(cb.out.join('')).toContain('CFG_TOML_SYNTAX');
  });

  it('只渲染已启用的 agent(disabled 的 agent 不进预算)', async () => {
    const { root } = await makeRepo({ ...BASE, 'kit.toml': KIT_TOML() });
    const { ctx } = cmdCtx(root);
    let enabled: readonly string[] = [];
    budgetDeps.render = (_i, e) => {
      enabled = e;
      return { files: [], report: EMPTY_REPORT };
    };
    await run(ctx, OPTS);
    expect(enabled).toEqual(['claude', 'codex']);
  });
});

describe('check --report:统计表', () => {
  it('写 .state/reports/budget.json,并把同一份统计表打到 stdout', async () => {
    const { root } = await makeRepo({ ...BASE, 'kit.toml': KIT_TOML() });
    const { ctx, out: o } = cmdCtx(root);
    budgetDeps.render = () => ({
      files: [
        out('claude', 'org.md', 'a\nb\n', { atoms: { 'shared-one': 2 } }),
        out('claude', 'project.md', 'a\nb\n', { atoms: { 'shared-one': 2 }, target: 'project' }),
        out('codex', 'AGENTS.md', ascii(2000)),
      ],
      report: EMPTY_REPORT,
    });
    const code = await run(ctx, { ...OPTS, report: true });
    expect(code).toBe(ExitCode.OK); // warn 下超限也退出 0
    const file = JSON.parse(await readText(path.join(root, '.state/reports/budget.json'))) as {
      targets: { agent: string; bytes: number; status: string; deduped_atom_ids: string[] }[];
      totals: { distinct_atoms: number };
    };
    expect(file.targets.map((t) => [t.agent, t.bytes, t.status])).toEqual([
      ['claude', 4 + 4 - 2, 'ok'],
      ['codex', 2000, 'over'],
    ]);
    expect(file.targets[0]?.deduped_atom_ids).toEqual(['shared-one']);
    expect(file.totals.distinct_atoms).toBe(1);
    expect(o.join('')).toContain('"status": "over"');
  });

  it('写 budget.json 被写根拒绝 → 退出 3', async () => {
    const { root } = await makeRepo({ ...BASE, 'kit.toml': KIT_TOML() });
    const io = createIoContext({
      root,
      cwd: REPO_ROOT,
      env: { PATH: '/usr/bin:/bin', KIT_WRITE_ROOTS: path.join(root, '.state', 'other') },
    });
    const err: string[] = [];
    const code = await run(
      { argv: [], io, overlayPath: undefined, stdout: () => undefined, stderr: (t) => err.push(t) },
      { ...OPTS, report: true },
    );
    expect(code).toBe(ExitCode.FAIL_CLOSED);
    expect(err.join('')).toContain('写 budget.json 失败');
  });

  it('不带 --report 不写文件', async () => {
    const { root } = await makeRepo({ ...BASE, 'kit.toml': KIT_TOML() });
    const { ctx } = cmdCtx(root);
    await run(ctx, OPTS);
    await expect(readText(path.join(root, '.state/reports/budget.json'))).rejects.toThrow();
  });
});

describe('Codex 项目链经 budgetDeps 注入', () => {
  it('项目链把 codex 推过上限:warn 下仍退出 0 但出告警', async () => {
    const { root } = await makeRepo({ ...BASE, 'kit.toml': KIT_TOML() });
    const { ctx, out: o } = cmdCtx(root);
    budgetDeps.render = () => ({
      files: [out('codex', 'AGENTS.md', ascii(900))],
      report: EMPTY_REPORT,
    });
    budgetDeps.projectChain = [ascii(300)];
    expect(await run(ctx, OPTS)).toBe(ExitCode.OK);
    expect(o.join('')).toContain('budget codex: 1200 字节');
    expect(o.join('')).toContain('warn BUDGET_OVER_LIMIT');
  });
});
