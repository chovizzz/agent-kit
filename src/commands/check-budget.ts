import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { lintRepo } from '../atoms/lint.js';
import { budgetFailed, budgetStats, computeBudget } from '../budget/budget.js';
import type { BudgetReport } from '../contracts/budget.js';
import { KitConfigSchema } from '../contracts/config.js';
import type { KitConfig } from '../contracts/config.js';
import { hasErrors, zodIssuesToDiagnostics } from '../contracts/diagnostics.js';
import type { Diagnostic } from '../contracts/diagnostics.js';
import { ExitCode } from '../contracts/exit-codes.js';
import type { RenderInput, RenderOutput } from '../contracts/render.js';
import { canonicalJson } from '../io/canonical-json.js';
import { existsSync, readTextSync } from '../io/read-fs.js';
import { mkdirp, writeFile } from '../io/safe-fs.js';
import { mergeAtoms } from '../merge/merge.js';
import { mergeCounts } from '../merge/report.js';
import { RenderCoreError, renderAll } from '../render/core.js';
import { createRegistry, defaultRegistry } from '../render/registry.js';
import { formatDiagnostic } from './lint-cmd.js';
import type { CheckStep } from './types.js';

/** 预算子 runner 的外部依赖;测试注入,B19 集成时通常不需要动。 */
export interface BudgetDeps {
  /** 渲染入口;缺省 = 在已启用 agent 的默认注册表上跑 renderAll */
  render?: (input: RenderInput, enabled: KitConfig['agents']['enabled']) => RenderOutput;
  /** Codex 项目链(根→cwd 各层 AGENTS.md 文本);P0 只由 fixture 提供,不读真实仓库 */
  projectChain?: readonly string[];
}

export const budgetDeps: BudgetDeps = {};

function defaultRender(input: RenderInput, enabled: KitConfig['agents']['enabled']): RenderOutput {
  const registry = createRegistry(defaultRegistry.list().filter((a) => enabled.includes(a.agent)));
  return renderAll(input, registry);
}

function loadConfig(root: string): { config?: KitConfig; diagnostics: Diagnostic[] } {
  const file = path.join(root, 'kit.toml');
  if (!existsSync(file)) {
    return {
      diagnostics: [
        {
          code: 'CFG_KIT_TOML_MISSING',
          severity: 'error',
          path: 'kit.toml',
          message: '找不到 kit.toml,无法检查预算',
        },
      ],
    };
  }
  let raw: unknown;
  try {
    raw = parseToml(readTextSync(file));
  } catch (e) {
    return {
      diagnostics: [
        {
          code: 'CFG_TOML_SYNTAX',
          severity: 'error',
          path: 'kit.toml',
          message: `kit.toml 无法解析:${(e as Error).message.split('\n')[0] ?? ''}`,
        },
      ],
    };
  }
  const res = KitConfigSchema.safeParse(raw);
  if (!res.success) return { diagnostics: zodIssuesToDiagnostics(res.error, 'kit.toml') };
  return { config: res.data, diagnostics: [] };
}

function targetLine(t: BudgetReport['targets'][number]): string {
  const limit = [
    t.max_bytes !== undefined ? `max_bytes=${t.max_bytes}` : undefined,
    t.max_lines !== undefined ? `max_lines=${t.max_lines}` : undefined,
    t.hard_limit !== undefined ? `hard_limit=${t.hard_limit}` : undefined,
  ].filter((x) => x !== undefined);
  return `budget ${t.agent}: ${t.bytes} 字节 / ${t.lines} 行 [${t.level}] ${limit.join(' ')} limit_source=${t.limit_source}${t.blocking ? ' BLOCKING' : ''}`;
}

/**
 * `check` 的预算步骤:lint 取原子 → 合并 → 渲染 → computeBudget。
 * 退出码:合并/配置有 error 或有 blocking 目标 → 1;渲染/读取失败 → 3;否则 0
 * (`warn` 与 `assumed` 目标超限只告警)。`--report` 另写 `.state/reports/budget.json` 并把统计表打到 stdout。
 */
export interface BudgetInputs {
  config: KitConfig;
  rendered: RenderOutput;
  /** mergeCounts(merged) 的结果,供 check 的汇总行使用 */
  counts: { core: number; personal: number };
}

/**
 * 装载 kit.toml + lint + 合并 + 渲染(check 与 probe 共用的前半段)。
 * 失败时返回 diagnostics(severity=error);调用方负责输出与退出码。
 */
export async function prepareBudgetInputs(
  repoRoot: string,
  stdout: (t: string) => void,
): Promise<{
  inputs?: BudgetInputs;
  diagnostics: Diagnostic[];
  failure?: 'config' | 'repo' | 'render';
}> {
  const loaded = loadConfig(repoRoot);
  if (loaded.config === undefined) return { diagnostics: loaded.diagnostics, failure: 'config' };
  const config = loaded.config;
  let lint;
  try {
    lint = await lintRepo(repoRoot);
  } catch (e) {
    return {
      failure: 'repo',
      diagnostics: [
        {
          code: 'PROBE_REPO_READ_FAILED',
          severity: 'error',
          path: 'kit.toml',
          message: `读取仓库失败:${(e as Error).message}`,
        },
      ],
    };
  }
  const merged = mergeAtoms(lint.atoms);
  if (hasErrors(merged.diagnostics)) {
    stdout('budget: 合并失败,未计算预算\n');
    return { diagnostics: merged.diagnostics };
  }
  try {
    const render = budgetDeps.render ?? defaultRender;
    const rendered = render(
      {
        resolved: merged.atoms,
        skills: lint.skills,
        agents: lint.agents,
        kitVersion: config.kit.version,
        // TODO(B19):渠道由覆盖层/参数决定;预算按 canary 渲染,stable 成员尚不单独检查
        channel: 'canary',
      },
      config.agents.enabled,
    );
    return {
      inputs: { config, rendered, counts: mergeCounts(merged) },
      diagnostics: merged.diagnostics,
    };
  } catch (e) {
    const code = e instanceof RenderCoreError ? `${e.code}: ` : '';
    return {
      failure: 'render',
      diagnostics: [
        {
          code: 'PROBE_RENDER_FAILED',
          severity: 'error',
          path: 'kit.toml',
          message: `渲染失败:${code}${(e as Error).message}`,
        },
      ],
    };
  }
}

export const run: CheckStep = async (ctx, opts) => {
  const io = ctx.io;
  const emit = (ds: readonly Diagnostic[]): void => {
    for (const d of ds) ctx.stdout(`${formatDiagnostic(d)}\n`);
  };
  const prepared = await prepareBudgetInputs(io.repoRoot, ctx.stdout);
  emit(prepared.diagnostics);
  if (prepared.inputs === undefined) {
    if (prepared.failure === 'repo' || prepared.failure === 'render') {
      // 原语义:读仓库/渲染失败走 stderr 的 fail-closed 文案(测试钉住「渲染失败」字样)。
      ctx.stderr(
        `agent-kit check (budget): ${prepared.failure === 'repo' ? '读取仓库' : '渲染'}失败\n`,
      );
      return ExitCode.FAIL_CLOSED;
    }
    return ExitCode.CHECK_FAILED;
  }
  const { config, rendered } = prepared.inputs;
  const report = computeBudget({
    outputs: rendered.files,
    config: config.budget,
    ...(budgetDeps.projectChain ? { projectChain: budgetDeps.projectChain } : {}),
  });
  for (const t of report.targets) ctx.stdout(`${targetLine(t)}\n`);
  emit(report.diagnostics);
  ctx.stdout(
    `budget: ${report.targets.length} 个目标, ${prepared.inputs.counts.core} 个原子可入 core 输出, ${prepared.inputs.counts.personal} 个 personal 原子不入(enforce=${report.enforce})\n`,
  );

  if (opts.report) {
    const stats = canonicalJson(budgetStats(report, rendered.files));
    const dir = path.join(io.stateDir, 'reports');
    try {
      await mkdirp(io, dir, 0o700);
      await writeFile(io, path.join(dir, 'budget.json'), stats, { mode: 0o600 });
    } catch (e) {
      ctx.stderr(`agent-kit check (budget): 写 budget.json 失败:${(e as Error).message}\n`);
      return ExitCode.FAIL_CLOSED;
    }
    ctx.stdout(`--- budget report (.state/reports/budget.json) ---\n${stats}`);
  }
  return budgetFailed(report) ? ExitCode.CHECK_FAILED : ExitCode.OK;
};
