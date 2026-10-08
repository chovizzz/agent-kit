import { readTextSync, existsSync } from '../io/read-fs.js';
import { parse as parseToml } from 'smol-toml';
import * as path from 'node:path';
import { DEFAULT_LINT_BUDGET, lintRepo } from '../atoms/lint.js';
import type { LintOptions } from '../atoms/lint.js';
import { KitConfigSchema } from '../contracts/config.js';
import { hasErrors, zodIssuesToDiagnostics, type Diagnostic } from '../contracts/diagnostics.js';
import { ExitCode } from '../contracts/exit-codes.js';
import type { Redactor } from '../contracts/redact.js';
import type { CheckStep } from './types.js';

/** lint 子 runner 的外部依赖。B19 把真实 Redactor(B09)接进 `lintDeps.redactor`。 */
export interface LintDeps {
  redactor?: Pick<Redactor, 'pass2'>;
}

export const lintDeps: LintDeps = {};

function loadBudget(root: string, out: Diagnostic[]): LintOptions['budget'] {
  const file = path.join(root, 'kit.toml');
  if (!existsSync(file)) return { ...DEFAULT_LINT_BUDGET };
  let raw: unknown;
  try {
    raw = parseToml(readTextSync(file));
  } catch (e) {
    out.push({
      code: 'CFG_TOML_SYNTAX',
      severity: 'error',
      path: 'kit.toml',
      message: `kit.toml 无法解析:${(e as Error).message.split('\n')[0] ?? ''}`,
    });
    return { ...DEFAULT_LINT_BUDGET };
  }
  const res = KitConfigSchema.safeParse(raw);
  if (!res.success) {
    out.push(...zodIssuesToDiagnostics(res.error, 'kit.toml'));
    return { ...DEFAULT_LINT_BUDGET };
  }
  return { enforce: res.data.budget.enforce, atom_max_bytes: res.data.budget.atom_max_bytes };
}

export function formatDiagnostic(d: Diagnostic): string {
  return `${d.severity} ${d.code} ${d.path}: ${d.message}`;
}

/**
 * `check` 的 lint 步骤:原子 / 技能 / 子代理。
 * 退出码:有 error → 1;脱敏复扫自身抛错(fail-closed)→ 3;否则 0(warn 不影响)。
 */
export const run: CheckStep = async (ctx) => {
  const cfgDiags: Diagnostic[] = [];
  let result;
  let budget;
  try {
    budget = loadBudget(ctx.io.repoRoot, cfgDiags);
    result = await lintRepo(ctx.io.repoRoot, {
      ...(lintDeps.redactor ? { redactor: lintDeps.redactor } : {}),
      ...(budget ? { budget } : {}),
    });
  } catch (e) {
    ctx.stderr(`agent-kit check (lint): 读取仓库失败:${(e as Error).message}\n`);
    return ExitCode.FAIL_CLOSED;
  }
  const all = [...cfgDiags, ...result.diagnostics];
  for (const d of all) ctx.stdout(`${formatDiagnostic(d)}\n`);
  const errors = all.filter((d) => d.severity === 'error').length;
  const warns = all.length - errors;
  ctx.stdout(
    `lint: ${result.atoms.length} 个原子, ${result.skills.length} 个技能, ${result.agents.length} 个子代理; ${errors} error, ${warns} warn\n`,
  );
  if (result.scanErrors > 0) return ExitCode.FAIL_CLOSED;
  return hasErrors(all) ? ExitCode.CHECK_FAILED : ExitCode.OK;
};
