/**
 * `agent-kit probe`(P1-01,contracts #12):预算阈值探针。
 *
 * 做什么:在真实渲染产物上量出各 agent 目标的实际字节数/行数,
 *   - 干跑(默认):只打印测量值与现状;
 *   - `--write`:**不写文件系统**,产出可直接粘贴进 kit.toml 的目标行补丁
 *     (limit_source=probed + probed_value/probed_agent_version/probed_at 三元组,contracts #12)。
 *
 * 边界(刻意):
 *   - `limit_source='documented'` 的目标是官方文档值,**探针不改写**;
 *   - `--agent-version <agent>=<x.y.z>` 缺失的目标不能写回(三元组必填,缺版本宁可报错也不编造);
 *   - 有效性探针(render 报告里的 `pendingProbes`,如 P-Q1/P-Q2)需要跑真实 agent 观察,
 *     本命令只汇总列出,不产出事实(contracts:待探针验证项不作为事实)。
 */
import { computeBudget } from '../budget/budget.js';
import type { BudgetTarget } from '../contracts/config.js';
import { ExitCode } from '../contracts/exit-codes.js';
import { prepareBudgetInputs } from './check-budget.js';
import { stubReason } from './types.js';
import type { CommandDef } from './types.js';

interface AgentVersionFlag {
  agent: string;
  version: string;
}

function parseAgentVersions(argv: readonly string[]): AgentVersionFlag[] | undefined {
  const out: AgentVersionFlag[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--agent-version') continue;
    const v = argv[i + 1];
    if (v === undefined) return undefined;
    const m = /^([a-z][a-z0-9-]+)=(\S+)$/.exec(v);
    if (!m) return undefined;
    out.push({ agent: m[1] as string, version: m[2] as string });
    i++;
  }
  return out;
}

function collectFlag(argv: readonly string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1] !== undefined) {
      out.push(argv[i + 1] as string);
      i++;
    }
  }
  return out;
}

/** 生成单条 kit.toml 目标补丁(字符串拼装仅限本文件内的 TOML 键值,值都是数字/引号包裹的受控词)。 */
function targetPatch(
  agent: string,
  t: BudgetTarget,
  measured: number,
  agentVersion: string,
  now: string,
): string {
  const lines = [`[budget.${agent}]`];
  if (t.max_bytes !== undefined) lines.push(`max_bytes = ${t.max_bytes}`);
  if (t.max_lines !== undefined) lines.push(`max_lines = ${t.max_lines}`);
  lines.push('limit_source = "probed"');
  lines.push(`probed_value = ${measured}`);
  lines.push(`probed_agent_version = "${agentVersion}"`);
  lines.push(`probed_at = "${now}"`);
  return lines.join('\n');
}

export const command: CommandDef = {
  name: 'probe',
  summary: '预算阈值探针:在真实渲染产物上测量并产出 limit_source=probed 写回补丁',
  phase: 'P1',
  ownerBlock: 'P1',
  flags: [
    { name: '--write', description: '输出 kit.toml 目标补丁(不写文件系统)' },
    {
      name: '--agent <id>',
      description: '只探指定 agent(可重复;缺省 = 全部启用了预算目标的 agent)',
    },
    {
      name: '--agent-version <id>=<x.y.z>',
      description: '--write 时该 agent 的被测版本(三元组必填;可重复)',
    },
  ],
  async run(ctx) {
    const argv = ctx.argv;
    if (argv.includes('--help')) {
      for (const f of command.flags ?? []) ctx.stdout(`${f.name}  ${f.description}\n`);
      return ExitCode.OK;
    }
    const write = argv.includes('--write');
    const onlyAgents = collectFlag(argv, '--agent');
    const versionFlag = parseAgentVersions(argv);
    if (versionFlag === undefined) {
      ctx.stderr('agent-kit probe: --agent-version 形如 <agent>=<x.y.z>\n');
      return ExitCode.USAGE;
    }

    const prepared = await prepareBudgetInputs(ctx.io.repoRoot, ctx.stdout);
    if (prepared.inputs === undefined) {
      for (const d of prepared.diagnostics) ctx.stderr(`${d.code}: ${d.message}\n`);
      return ExitCode.FAIL_CLOSED;
    }
    const { config, rendered } = prepared.inputs;
    const report = computeBudget({ outputs: rendered.files, config: config.budget });

    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const patches: string[] = [];
    const versionOf = (agent: string): string | undefined =>
      versionFlag.find((v) => v.agent === agent)?.version;

    for (const t of report.targets) {
      if (onlyAgents.length > 0 && !onlyAgents.includes(t.agent)) continue;
      const measured = t.bytes;
      if (!write) {
        ctx.stdout(
          `${t.agent}: measured bytes=${measured} lines=${t.lines} ` +
            `limit_source=${t.limit_source} max_bytes=${t.max_bytes ?? '-'} max_lines=${t.max_lines ?? '-'}` +
            (t.limit_source === 'documented'
              ? '(documented:官方值,探针不改写)'
              : ''),
        );
        continue;
      }
      if (t.limit_source === 'documented') {
        ctx.stdout(`${t.agent}: documented,跳过写回(官方值不改)\n`);
        continue;
      }
      const av = versionOf(t.agent);
      if (av === undefined) {
        ctx.stderr(
          `agent-kit probe: ${t.agent} 写回需要 --agent-version ${t.agent}=<x.y.z>(contracts #12 三元组必填)\n`,
        );
        return ExitCode.USAGE;
      }
      patches.push(targetPatch(t.agent, t as BudgetTarget, measured, av, now));
    }

    if (write) {
      if (patches.length === 0) {
        ctx.stdout('probe: 没有可写回的目标\n');
        return ExitCode.OK;
      }
      ctx.stdout('# 粘贴进 kit.toml(替换对应 [budget.<agent>] 段;探针不直接写文件系统)\n');
      for (const p of patches) ctx.stdout(`${p}\n\n`);
    }

    const pending = rendered.report.pendingProbes;
    if (pending.length > 0) {
      ctx.stdout(`--- 有效性探针待办(pendingProbes,不作为事实):${pending.length} 项 ---\n`);
      for (const p of pending) ctx.stdout(`${p.id}: ${p.description}\n`);
    }
    return ExitCode.OK;
  },
};

// 桩时代的说明保留给 --help 之外的读者(防删注释丢上下文):原桩行为见 git 历史 stubReason(command)。
void stubReason;
