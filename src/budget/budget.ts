/**
 * 预算计算(设计 §3.6;口径见 docs/contracts.md 第 6 节)。
 * 输入是渲染后的 `OutFile[]`(不是源文件),所以 B07/B08 完成前用夹具测试,集成在 B19。
 */
import { RENDER_AGENT_IDS } from '../contracts/common.js';
import type { RenderAgentId } from '../contracts/common.js';
import type { BudgetConfig, BudgetTarget } from '../contracts/config.js';
import { hasErrors, sortDiagnostics } from '../contracts/diagnostics.js';
import type { Diagnostic } from '../contracts/diagnostics.js';
import type { BudgetInputs, BudgetReport, BudgetTargetReport } from '../contracts/budget.js';
import type { OutFile } from '../contracts/render.js';
import { countsTowardBudget, measure } from './targets.js';

type Level = BudgetTargetReport['level'];

/** 是否达到 near:bytes×100 ≥ max×threshold(整数运算,比较符 ≥,恰好 90% 即 near)。 */
export function isNear(value: number, max: number, thresholdPercent: number): boolean {
  return value * 100 >= max * thresholdPercent;
}

function dimLevel(value: number, max: number | undefined, threshold: number): Level {
  if (max === undefined) return 'ok';
  if (value > max) return 'over'; // 严格大于:恰好等于 max 不算超
  return isNear(value, max, threshold) ? 'near' : 'ok';
}

const worst = (a: Level, b: Level): Level =>
  a === 'over' || b === 'over' ? 'over' : a === 'near' || b === 'near' ? 'near' : 'ok';

/**
 * `hard_limit` 是 agent 静默截断的硬上限,按**字节**比较(与目标配没配 max_bytes 无关;
 * 行数型硬上限目前无法表达,见 docs/contracts.md 待办)。数字且被超过 ⇒ 视为 over;
 * `"unknown"` 不参与任何比较、不出诊断。
 */
function hardLimitHit(t: BudgetTarget, bytes: number): number | undefined {
  if (typeof t.hard_limit !== 'number') return undefined;
  return bytes > t.hard_limit ? t.hard_limit : undefined;
}

export function computeBudget(input: BudgetInputs): BudgetReport {
  const { config, projectChain } = input;
  const outputs = input.outputs.filter(countsTowardBudget);
  const diagnostics: Diagnostic[] = [];
  const targets: BudgetTargetReport[] = [];

  for (const agent of RENDER_AGENT_IDS) {
    const t = config[agent];
    if (t === undefined) {
      if (outputs.some((f) => f.agent === agent)) {
        diagnostics.push({
          code: 'BUDGET_NO_TARGET',
          severity: 'warn',
          path: `kit.toml#/budget/${agent}`,
          message: `${agent} 有渲染产物但 kit.toml 没有 [budget.${agent}],这些产物没有被预算覆盖`,
        });
      }
      continue;
    }
    const files = outputs.filter((f) => f.agent === agent);
    const m = measure(files, agent === 'codex' ? (projectChain ?? []) : []);
    const maxLevel = worst(
      dimLevel(m.bytes, t.max_bytes, config.threshold_percent),
      dimLevel(m.lines, t.max_lines, config.threshold_percent),
    );
    const hard = hardLimitHit(t, m.bytes);
    // 超过硬上限也算 over(即便没超 max);但只有真的超 max 才出 BUDGET_OVER_LIMIT
    const level: Level = hard !== undefined ? 'over' : maxLevel;
    const blocking = level === 'over' && config.enforce === 'block' && t.limit_source !== 'assumed';
    const severity = blocking ? 'error' : 'warn';
    const path = `kit.toml#/budget/${agent}`;
    const usage = `${m.bytes} 字节 / ${m.lines} 行`;
    const limits = [
      t.max_bytes !== undefined ? `max_bytes=${t.max_bytes}` : undefined,
      t.max_lines !== undefined ? `max_lines=${t.max_lines}` : undefined,
    ]
      .filter((x) => x !== undefined)
      .join(', ');
    if (maxLevel === 'over') {
      const tail =
        t.limit_source === 'assumed'
          ? '(limit_source=assumed:只告警,不阻断)'
          : config.enforce === 'block'
            ? '(enforce=block:阻断)'
            : '(enforce=warn:只告警)';
      diagnostics.push({
        code: 'BUDGET_OVER_LIMIT',
        severity,
        path,
        message: `${agent} 目标 ${usage},超过 ${limits}${tail}`,
      });
    } else if (maxLevel === 'near' && level !== 'over') {
      diagnostics.push({
        code: 'BUDGET_NEAR_LIMIT',
        severity: 'warn',
        path,
        message: `${agent} 目标 ${usage},已达 ${limits} 的 ${config.threshold_percent}%:新增原子须同 PR 带 merge 或 retire(一进一出)`,
      });
    }
    if (hard !== undefined) {
      diagnostics.push({
        code: 'BUDGET_OVER_HARD_LIMIT',
        severity,
        path,
        message: `${agent} 目标 ${usage},超过 agent 静默截断的硬上限 ${hard}`,
      });
    }
    targets.push({
      agent,
      bytes: m.bytes,
      lines: m.lines,
      ...(t.max_bytes !== undefined ? { max_bytes: t.max_bytes } : {}),
      ...(t.max_lines !== undefined ? { max_lines: t.max_lines } : {}),
      ...(t.hard_limit !== undefined ? { hard_limit: t.hard_limit } : {}),
      limit_source: t.limit_source,
      level,
      blocking,
      files: m.files,
      deduped_atom_ids: m.dedupedAtomIds,
    });
  }

  diagnostics.push(...atomSizeDiagnostics(outputs, config));
  diagnostics.push(...projectDiagnostics(outputs, config));
  return { enforce: config.enforce, targets, diagnostics: sortDiagnostics(diagnostics) };
}

/** 单原子正文上限:与 lint 的 ATOM_BODY_TOO_LARGE 同口径(跟 enforce:block→error,否则 warn),不看 limit_source。 */
function atomSizeDiagnostics(outputs: readonly OutFile[], config: BudgetConfig): Diagnostic[] {
  const worstSeen = new Map<string, { bytes: number; where: string }>();
  for (const f of outputs) {
    for (const id of f.atomIds) {
      const bytes = f.atomBytes[id] ?? 0;
      const prev = worstSeen.get(id);
      if (prev === undefined || bytes > prev.bytes) {
        worstSeen.set(id, { bytes, where: `${f.agent}/${f.target}/${f.relPath}` });
      }
    }
  }
  const out: Diagnostic[] = [];
  for (const [id, { bytes, where }] of worstSeen) {
    if (bytes <= config.atom_max_bytes) continue;
    out.push({
      code: 'BUDGET_ATOM_TOO_LARGE',
      severity: config.enforce === 'block' ? 'error' : 'warn',
      path: `${where}#/atomBytes/${id}`,
      message: `原子「${id}」正文 ${bytes} 字节,超过单原子上限 ${config.atom_max_bytes};应拆成技能`,
    });
  }
  return out;
}

/** 项目层预算(Q-N3 未决):project 落点跨 agent 按原子 id 去重求和;P0 只告警、永不阻断。 */
function projectDiagnostics(outputs: readonly OutFile[], config: BudgetConfig): Diagnostic[] {
  const max = config.project_max_bytes;
  if (max === undefined) return [];
  const { bytes } = measure(outputs.filter((f) => f.target === 'project'));
  const path = 'kit.toml#/budget/project_max_bytes';
  if (bytes > max) {
    return [
      {
        code: 'BUDGET_PROJECT_OVER',
        severity: 'warn',
        path,
        message: `项目层产物合计 ${bytes} 字节,超过 project_max_bytes=${max}(P0 只告警)`,
      },
    ];
  }
  if (isNear(bytes, max, config.threshold_percent)) {
    return [
      {
        code: 'BUDGET_NEAR_LIMIT',
        severity: 'warn',
        path,
        message: `项目层产物合计 ${bytes} 字节,已达 project_max_bytes=${max} 的 ${config.threshold_percent}%`,
      },
    ];
  }
  return [];
}

/** `check` 是否应退出 1:存在 error 诊断(blocking 目标必带 error)。 */
export function budgetFailed(report: BudgetReport): boolean {
  return report.targets.some((t) => t.blocking) || hasErrors(report.diagnostics);
}

export interface BudgetStatsRow {
  agent: RenderAgentId;
  bytes: number;
  lines: number;
  max_bytes: number | null;
  max_lines: number | null;
  hard_limit: number | 'unknown' | null;
  limit_source: BudgetTargetReport['limit_source'];
  status: Level;
  blocking: boolean;
  files: string[];
  deduped_atom_ids: string[];
}

export interface BudgetStats {
  schema_version: 1;
  enforce: BudgetReport['enforce'];
  targets: BudgetStatsRow[];
  totals: {
    /** 各目标字节之和(已按目标内原子 id 去重) */
    target_bytes: number;
    /** 全部输出里不同原子 id 的个数,及各原子正文字节(取最大值)之和 */
    distinct_atoms: number;
    distinct_atom_bytes: number;
  };
}

/** `check --report` 的统计表(供 S-3 脚本消费;键序固定,便于 diff)。 */
export function budgetStats(report: BudgetReport, outputs: readonly OutFile[]): BudgetStats {
  const atoms = measure(outputs.filter(countsTowardBudget)).atomBytes;
  let atomBytes = 0;
  for (const b of atoms.values()) atomBytes += b;
  return {
    schema_version: 1,
    enforce: report.enforce,
    targets: report.targets.map((t) => ({
      agent: t.agent,
      bytes: t.bytes,
      lines: t.lines,
      max_bytes: t.max_bytes ?? null,
      max_lines: t.max_lines ?? null,
      hard_limit: t.hard_limit ?? null,
      limit_source: t.limit_source,
      status: t.level,
      blocking: t.blocking,
      files: t.files,
      deduped_atom_ids: t.deduped_atom_ids,
    })),
    totals: {
      target_bytes: report.targets.reduce((s, t) => s + t.bytes, 0),
      distinct_atoms: atoms.size,
      distinct_atom_bytes: atomBytes,
    },
  };
}
