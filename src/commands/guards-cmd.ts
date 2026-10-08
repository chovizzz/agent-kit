import { ExitCode } from '../contracts/exit-codes.js';
import { hasErrors, type Diagnostic } from '../contracts/diagnostics.js';
import { createGuardGit, GitError, parseLabel, RefError, runGuards } from '../guards/index.js';
import type { CriteriaChecker } from '../guards/index.js';
import type { CheckStep } from './types.js';

export const guardsDeps = {
  /** P1 把真实的 G3 判据检查器(attest/reports)接进来;缺省 = 桩(晋升/退役 PR 在 P0 一律不通过) */
  criteria: undefined as CriteriaChecker | undefined,
};

const fmt = (d: Diagnostic): string => `${d.severity} ${d.code} ${d.path}: ${d.message}`;

/**
 * `check --guards --base <ref> --head <ref> [--label ...]` 的守卫步骤:G1–G4 + 反思器路径守卫。
 * 退出码:有 error → 1;--label 未知 / ref 解析不了 → 2;git 不可用 → 4;其它意外 → 3。
 * `--label` 是 P1 CI 版标签校验的前置模拟,见 src/guards/labels.ts。
 */
export const run: CheckStep = async (ctx, opts) => {
  const parsed = parseLabel(opts.label);
  if (!parsed.ok) {
    ctx.stderr(`agent-kit check (guards): ${parsed.diagnostic.message}\n`);
    return ExitCode.USAGE;
  }
  if (opts.base === undefined || opts.head === undefined) {
    ctx.stderr('agent-kit check (guards): 需要同时给 --base 和 --head\n');
    return ExitCode.USAGE;
  }
  try {
    const res = runGuards({
      git: createGuardGit(ctx.io),
      base: opts.base,
      head: opts.head,
      label: parsed.label,
      ...(guardsDeps.criteria ? { criteria: guardsDeps.criteria } : {}),
    });
    for (const d of res.diagnostics) ctx.stdout(`${fmt(d)}\n`);
    const errors = res.diagnostics.filter((d) => d.severity === 'error').length;
    ctx.stdout(
      `guards: base=${res.baseOid.slice(0, 12)} head=${res.headOid.slice(0, 12)} label=${parsed.label ?? '(none)'}; ` +
        `${res.changed} 个文件变更; ${errors} error, ${res.diagnostics.length - errors} warn\n`,
    );
    return hasErrors(res.diagnostics) ? ExitCode.CHECK_FAILED : ExitCode.OK;
  } catch (e) {
    if (e instanceof RefError) {
      ctx.stderr(`agent-kit check (guards): ${e.message}\n`);
      return ExitCode.USAGE;
    }
    if (e instanceof GitError && /无法启动/.test(e.message)) {
      ctx.stderr(`agent-kit check (guards): ${e.message}\n`);
      return ExitCode.NOT_RUN;
    }
    ctx.stderr(`agent-kit check (guards): 内部错误(fail-closed):${(e as Error).message}\n`);
    return ExitCode.FAIL_CLOSED;
  }
};
