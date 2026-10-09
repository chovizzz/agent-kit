/** build 的串联:lint → 合并 → 渲染 → 预算 → (调用方负责写盘)。不碰文件系统写出口。 */
import { lintRepo } from '../atoms/lint.js';
import { budgetFailed, budgetStats, computeBudget } from '../budget/budget.js';
import type { BudgetStats } from '../budget/budget.js';
import type { BudgetReport } from '../contracts/budget.js';
import type { ChannelName, KitConfig, Overlay } from '../contracts/config.js';
import { hasErrors } from '../contracts/diagnostics.js';
import type { Diagnostic } from '../contracts/diagnostics.js';
import type { MergeResult } from '../contracts/merge.js';
import type { Manifest, RenderInput, RenderOutput } from '../contracts/render.js';
import { lintDeps } from '../commands/lint-cmd.js';
import { mergeAtoms } from '../merge/merge.js';
import { mergeCounts } from '../merge/report.js';
import { createRedactor } from '../redact/index.js';
import { RenderCoreError, renderAll } from '../render/core.js';
import { createRegistry, defaultRegistry } from '../render/registry.js';
import { buildManifest } from './manifest.js';

/** 测试注入点;缺省 = 在已启用 agent 的默认注册表上跑 renderAll。 */
export interface BuildDeps {
  render?: (input: RenderInput, enabled: readonly string[]) => RenderOutput;
}
export const buildDeps: BuildDeps = {};

function defaultRender(input: RenderInput, enabled: readonly string[]): RenderOutput {
  const registry = createRegistry(defaultRegistry.list().filter((a) => enabled.includes(a.agent)));
  return renderAll(input, registry);
}

export type PipelineOutcome =
  | { kind: 'check_failed'; diagnostics: Diagnostic[]; notes: string[] }
  | { kind: 'fail_closed'; message: string }
  | {
      kind: 'ok';
      /** lint + 合并 + 预算的诊断(含 warn) */
      diagnostics: Diagnostic[];
      rendered: RenderOutput;
      manifest: Manifest;
      merge: MergeResult;
      budget: BudgetReport;
      stats: BudgetStats;
      counts: ReturnType<typeof mergeCounts>;
      lintCounts: { atoms: number; skills: number; agents: number };
    };

export interface PipelineInput {
  root: string;
  config: KitConfig;
  overlay: Overlay | undefined;
}

/** 启用的 agent:kit.toml 的 enabled;覆盖层给了 enabled_agents 时只取交集(只会收窄,不会放大)。 */
export function effectiveAgents(config: KitConfig, overlay: Overlay | undefined): string[] {
  const base: string[] = [...config.agents.enabled];
  const only = overlay?.enabled_agents;
  return only === undefined ? base : base.filter((a) => (only as string[]).includes(a));
}

export async function runPipeline(input: PipelineInput): Promise<PipelineOutcome> {
  const { config, overlay } = input;
  let lint;
  try {
    lint = await lintRepo(input.root, {
      redactor:
        lintDeps.redactor ??
        createRedactor(
          { sensitive_words: overlay?.sensitive_words ?? [] },
          { internalDomains: overlay?.internal_domains ?? [] },
        ),
      budget: { enforce: config.budget.enforce, atom_max_bytes: config.budget.atom_max_bytes },
    });
  } catch (e) {
    return { kind: 'fail_closed', message: `读取仓库失败:${(e as Error).message}` };
  }
  if (lint.scanErrors > 0) {
    return { kind: 'fail_closed', message: `脱敏复扫自身出错 ${lint.scanErrors} 次(fail-closed)` };
  }
  if (hasErrors(lint.diagnostics)) {
    return {
      kind: 'check_failed',
      diagnostics: lint.diagnostics,
      notes: ['lint 有 error,未合并、未渲染、未写 out/'],
    };
  }

  const merge = mergeAtoms(lint.atoms);
  const diagnostics: Diagnostic[] = [...lint.diagnostics, ...merge.diagnostics];
  if (hasErrors(merge.diagnostics)) {
    return { kind: 'check_failed', diagnostics, notes: ['合并失败,未渲染、未写 out/'] };
  }

  const channel: ChannelName = overlay?.channel ?? 'canary';
  const renderInput: RenderInput = {
    resolved: merge.atoms,
    skills: lint.skills,
    agents: lint.agents,
    kitVersion: config.kit.version,
    channel,
    ...(overlay ? { overlay } : {}),
  };
  let rendered: RenderOutput;
  try {
    rendered = (buildDeps.render ?? defaultRender)(renderInput, effectiveAgents(config, overlay));
  } catch (e) {
    const code = e instanceof RenderCoreError ? `${e.code}: ` : '';
    return { kind: 'fail_closed', message: `渲染失败:${code}${(e as Error).message}` };
  }

  const budget = computeBudget({ outputs: rendered.files, config: config.budget });
  diagnostics.push(...budget.diagnostics);
  if (budgetFailed(budget)) {
    return {
      kind: 'check_failed',
      diagnostics,
      notes: ['预算阻断(enforce=block),未写 out/'],
    };
  }

  let manifest: Manifest;
  try {
    manifest = buildManifest({
      files: rendered.files,
      resolved: merge.atoms,
      report: rendered.report,
      kitVersion: config.kit.version,
      channel,
    });
  } catch (e) {
    return { kind: 'fail_closed', message: `构造 manifest 失败:${(e as Error).message}` };
  }
  return {
    kind: 'ok',
    diagnostics,
    rendered,
    manifest,
    merge,
    budget,
    stats: budgetStats(budget, rendered.files),
    counts: mergeCounts(merge),
    lintCounts: {
      atoms: lint.atoms.length,
      skills: lint.skills.length,
      agents: lint.agents.length,
    },
  };
}
