import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { budgetFailed, computeBudget } from '../../src/budget/budget.js';
import { budgetDeps, run } from '../../src/commands/check-budget.js';
import { LimitSourceSchema, EnforceSchema } from '../../src/contracts/config.js';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { readText } from '../../src/io/read-fs.js';
import { cmdCtx, makeRepo } from '../atoms/helpers.js';
import { REPO_ROOT } from '../helpers/tmp.js';
import { ascii, cfg, out } from './helpers.js';

interface Cell {
  limit_source: 'documented' | 'probed' | 'assumed';
  enforce: 'warn' | 'block';
  over: boolean;
  exit: number;
  diagnostic: { code: string; severity: 'warn' | 'error' } | null;
}

const MATRIX = JSON.parse(
  await readText(path.join(REPO_ROOT, 'test/fixtures/budget/matrix.json')),
) as { cells: Cell[] };

const PROBED = {
  probed_value: 100,
  probed_agent_version: '1.0.0',
  probed_at: '2026-10-08T00:00:00Z',
};
const MAX = 100;
const OVER_BYTES = 150;
const OK_BYTES = 40;

const budgetToml = (c: Cell): string => `[kit]
name = "t"
version = "0.0.0"

[agents]
enabled = ["codex"]

[budget]
enforce = "${c.enforce}"

[budget.codex]
max_bytes = ${MAX}
limit_source = "${c.limit_source}"
${c.limit_source === 'probed' ? 'probed_value = 100\nprobed_agent_version = "1.0.0"\nprobed_at = "2026-10-08T00:00:00Z"\n' : ''}
[channels.canary.members]

[channels.stable.members]
`;

afterEach(() => {
  delete budgetDeps.render;
  delete budgetDeps.projectChain;
});

describe('A2 矩阵:limit_source × enforce × 超/不超,共 12 格逐格写死', () => {
  it('夹具本身完整:12 个互不相同的格子,覆盖全部取值;恰有 2 格退出 1', () => {
    expect(MATRIX.cells).toHaveLength(12);
    const keys = new Set(MATRIX.cells.map((c) => `${c.limit_source}/${c.enforce}/${c.over}`));
    expect(keys.size).toBe(12);
    for (const s of LimitSourceSchema.options) {
      for (const e of EnforceSchema.options) {
        for (const over of [true, false]) expect(keys.has(`${s}/${e}/${over}`)).toBe(true);
      }
    }
    // 防变空:恰好 documented/probed × block × 超 这两格会阻断
    const blocking = MATRIX.cells.filter((c) => c.exit === 1);
    expect(blocking.map((c) => `${c.limit_source}/${c.enforce}/${c.over}`).sort()).toEqual([
      'documented/block/true',
      'probed/block/true',
    ]);
    // assumed + block + 超:退出 0 且有告警(D 3.6 硬规则:enforce 对 assumed 无效)
    const a = MATRIX.cells.find(
      (c) => c.limit_source === 'assumed' && c.enforce === 'block' && c.over,
    );
    expect(a).toMatchObject({ exit: 0, diagnostic: { severity: 'warn' } });
  });

  for (const c of MATRIX.cells) {
    const name = `${c.limit_source} / enforce=${c.enforce} / ${c.over ? '超' : '不超'}`;
    const outputs = [out('codex', 'AGENTS.md', ascii(c.over ? OVER_BYTES : OK_BYTES))];

    it(`computeBudget:${name}`, () => {
      const config = cfg({
        enforce: c.enforce,
        codex: {
          max_bytes: MAX,
          limit_source: c.limit_source,
          ...(c.limit_source === 'probed' ? PROBED : {}),
        },
      });
      const r = computeBudget({ outputs, config });
      // 精确数值:防止 max 配得过大导致「超」格恒不触发而测试空转
      expect(r.targets).toHaveLength(1);
      expect(r.targets[0]).toMatchObject({
        agent: 'codex',
        bytes: c.over ? OVER_BYTES : OK_BYTES,
        lines: 1,
        max_bytes: MAX,
        limit_source: c.limit_source,
        files: ['AGENTS.md'],
        deduped_atom_ids: [],
      });
      expect(r.targets[0]?.level).toBe(c.over ? 'over' : 'ok');
      expect(r.targets[0]?.blocking).toBe(c.exit === 1);
      expect(budgetFailed(r)).toBe(c.exit === 1);
      expect(r.diagnostics.map((d) => d.code)).toEqual(c.diagnostic ? [c.diagnostic.code] : []);
      const budgetDiags = r.diagnostics.filter((d) => d.code.startsWith('BUDGET_'));
      if (c.diagnostic === null) expect(budgetDiags).toEqual([]);
      else {
        expect(budgetDiags).toHaveLength(1);
        expect(budgetDiags[0]).toMatchObject(c.diagnostic);
      }
    });

    it(`check 退出码:${name} → ${c.exit}`, async () => {
      const { root } = await makeRepo({ 'kit.toml': budgetToml(c) });
      budgetDeps.render = () => ({
        files: outputs,
        report: {
          dropped: [],
          sideEffects: [],
          shadowChecks: [],
          pendingProbes: [],
          skippedLayers: [],
        },
      });
      const { ctx, out: stdout } = cmdCtx(root);
      const code = await run(ctx, {
        guards: false,
        base: undefined,
        head: undefined,
        label: undefined,
        report: false,
      });
      expect(code).toBe(c.exit);
      const text = stdout.join('');
      // 每个目标的字节/行数总是打印(warn 下也要看到)
      expect(text).toContain(`budget codex: ${c.over ? OVER_BYTES : OK_BYTES} 字节 / 1 行`);
      if (c.diagnostic === null) expect(text).not.toContain('BUDGET_');
      else
        expect(text).toContain(
          `${c.diagnostic.severity} ${c.diagnostic.code} kit.toml#/budget/codex`,
        );
    });
  }
});

describe('assumed 目标的其它违规同样不论 enforce 都不阻断', () => {
  it('assumed + block + 超 hard_limit:退出 0', async () => {
    const c: Cell = {
      limit_source: 'assumed',
      enforce: 'block',
      over: true,
      exit: 0,
      diagnostic: null,
    };
    const { root } = await makeRepo({
      'kit.toml': budgetToml(c).replace('max_bytes = 100', 'max_bytes = 100\nhard_limit = 120'),
    });
    budgetDeps.render = () => ({
      files: [out('codex', 'AGENTS.md', ascii(OVER_BYTES))],
      report: {
        dropped: [],
        sideEffects: [],
        shadowChecks: [],
        pendingProbes: [],
        skippedLayers: [],
      },
    });
    const { ctx, out: stdout } = cmdCtx(root);
    const code = await run(ctx, {
      guards: false,
      base: undefined,
      head: undefined,
      label: undefined,
      report: false,
    });
    expect(code).toBe(ExitCode.OK);
    expect(stdout.join('')).toContain('warn BUDGET_OVER_HARD_LIMIT');
  });
});
