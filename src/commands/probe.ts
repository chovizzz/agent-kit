/**
 * `agent-kit probe`(P1-01,contracts #12):预算阈值探针。
 *
 * 做什么:
 *   - 干跑(默认):在真实渲染产物上量出各 agent 目标的字节数/行数,并打印相对上限的余量;
 *   - `--write`:**不写文件系统**,产出可直接粘贴进 kit.toml 的目标行补丁
 *     (limit_source=probed + probed_value/probed_agent_version/probed_at 三元组,contracts #12)。
 *
 * 边界(刻意):
 *   - `probed_value` 只来自人在真实 agent 上观察到的上限(`--observed <agent>=<N>`),kit 只记录、不编造;
 *     kit 自己产物的实测大小只在干跑里当「余量」打印,绝不写进 probed_value;
 *   - 任一已配维度的原 max_* 大于对应观测值的目标拒绝出补丁(PROBE_LIMIT_ABOVE_OBSERVED;双维度两个都比),probed 目标不得比观测更宽;
 *   - `limit_source='documented'` 的目标是官方文档值,**探针不改写**;
 *   - `--agent-version <agent>=<x.y.z>` 缺失的目标不能写回(三元组必填,缺版本宁可报错也不编造);
 *   - 有效性探针(render 报告里的 `pendingProbes`,如 P-Q1/P-Q2)需要跑真实 agent 观察,
 *     本命令只汇总列出,不产出事实(contracts:待探针验证项不作为事实)。
 */
import { computeBudget } from '../budget/budget.js';
import type { BudgetTargetReport } from '../contracts/budget.js';
import { SemverSchema } from '../contracts/common.js';
import { BudgetTargetSchema } from '../contracts/config.js';
import type { BudgetTarget } from '../contracts/config.js';
import { ExitCode } from '../contracts/exit-codes.js';
import { prepareBudgetInputs } from './check-budget.js';
import type { CommandDef } from './types.js';

/** 外部依赖注入点(照 check-budget 的 budgetDeps;不碰 CommandContext)。 */
export interface ProbeDeps {
  /** 时钟;缺省 = new Date() */
  now?: () => Date;
}

export const probeDeps: ProbeDeps = {};

interface AgentVersionFlag {
  agent: string;
  version: string;
}

/** `--observed` 两种写法:`<agent>=<N>`(single)或 `<agent>=bytes:<N>[,lines:<M>]`(维度形式,双维度目标要求两个都给)。 */
interface ObservedFlag {
  agent: string;
  single?: number;
  bytes?: number;
  lines?: number;
}

interface ParsedArgs {
  write: boolean;
  agents: string[];
  versions: AgentVersionFlag[];
  observed: ObservedFlag[];
}

interface ArgError {
  code: string;
  message: string;
}

/** 严格解析:未知 flag / 缺值 / 版本非 semver / 同一 agent 版本重复 都是错误(退出 2)。 */
function parseArgs(argv: readonly string[]): ParsedArgs | ArgError {
  const out: ParsedArgs = { write: false, agents: [], versions: [], observed: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--write') {
      out.write = true;
    } else if (a === '--agent') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) {
        return { code: 'PROBE_MISSING_VALUE', message: '--agent 需要一个 agent id' };
      }
      out.agents.push(v);
    } else if (a === '--agent-version') {
      const v = argv[++i];
      const m = v === undefined ? null : /^([a-z][a-z0-9-]+)=(\S+)$/.exec(v);
      if (m === null) {
        return {
          code: 'PROBE_BAD_AGENT_VERSION',
          message: '--agent-version 形如 <agent>=<x.y.z>',
        };
      }
      const agent = m[1] as string;
      const version = m[2] as string;
      if (!SemverSchema.safeParse(version).success) {
        return {
          code: 'PROBE_BAD_AGENT_VERSION',
          message: `--agent-version ${agent}=${version} 不是合法的 semver(x.y.z)`,
        };
      }
      if (out.versions.some((x) => x.agent === agent)) {
        return {
          code: 'PROBE_DUPLICATE_AGENT_VERSION',
          message: `--agent-version 对 ${agent} 重复给了多次`,
        };
      }
      out.versions.push({ agent, version });
    } else if (a === '--observed') {
      const v = argv[++i];
      const bad: ArgError = {
        code: 'PROBE_BAD_OBSERVED',
        message:
          '--observed 形如 <agent>=<N> 或 <agent>=bytes:<N>,lines:<M>(N/M 为不带前导零的正整数)',
      };
      const head = v === undefined ? null : /^([a-z][a-z0-9-]+)=(.+)$/.exec(v);
      if (head === null) return bad;
      const agent = head[1] as string;
      const rest = head[2] as string;
      const num = (x: string): number | undefined => {
        if (!/^[1-9][0-9]*$/.test(x)) return undefined;
        const n = Number(x);
        return Number.isSafeInteger(n) ? n : undefined;
      };
      const flag: ObservedFlag = { agent };
      if (/^[0-9-]/.test(rest) || !rest.includes(':')) {
        const n = num(rest);
        if (n === undefined) return bad;
        flag.single = n;
      } else {
        for (const part of rest.split(',')) {
          const pm = /^(bytes|lines):(.+)$/.exec(part);
          const n = pm === null ? undefined : num(pm[2] as string);
          if (pm === null || n === undefined) return bad;
          const dim = pm[1] as 'bytes' | 'lines';
          if (flag[dim] !== undefined) return bad;
          flag[dim] = n;
        }
      }
      if (out.observed.some((x) => x.agent === agent)) {
        return {
          code: 'PROBE_DUPLICATE_OBSERVED',
          message: `--observed 对 ${agent} 重复给了多次`,
        };
      }
      out.observed.push(flag);
    } else {
      return { code: 'PROBE_UNKNOWN_FLAG', message: `未知参数 ${a}` };
    }
  }
  return out;
}

const isArgError = (x: ParsedArgs | ArgError): x is ArgError => 'code' in x;

/**
 * 单维度目标的探针维度:只配了 max_lines → 行;只配 max_bytes → 字节;`--observed <agent>=<N>` 的 N 按该单位解释。
 * 干跑的单行余量也用它(双维度目标另外打印 headroom_bytes / headroom_lines);--write 时双维度目标两个维度都与观测值比。
 */
function probeDimension(t: BudgetTargetReport): 'bytes' | 'lines' {
  return t.max_bytes === undefined && t.max_lines !== undefined ? 'lines' : 'bytes';
}

/** 构造补丁对象(未校验)。 */
function buildPatch(
  t: BudgetTargetReport,
  observed: number,
  agentVersion: string,
  now: string,
): BudgetTarget {
  return {
    ...(t.max_bytes !== undefined ? { max_bytes: t.max_bytes } : {}),
    ...(t.max_lines !== undefined ? { max_lines: t.max_lines } : {}),
    ...(t.hard_limit !== undefined ? { hard_limit: t.hard_limit } : {}),
    limit_source: 'probed',
    probed_value: observed,
    probed_agent_version: agentVersion,
    probed_at: now,
  };
}

/** 把已通过 BudgetTargetSchema 的补丁渲染成 kit.toml 段(值都是数字/受控词)。 */
function patchToToml(agent: string, p: BudgetTarget): string {
  const lines = [`[budget.${agent}]`];
  if (p.max_bytes !== undefined) lines.push(`max_bytes = ${p.max_bytes}`);
  if (p.max_lines !== undefined) lines.push(`max_lines = ${p.max_lines}`);
  if (p.hard_limit !== undefined) {
    lines.push(
      `hard_limit = ${typeof p.hard_limit === 'number' ? p.hard_limit : `"${p.hard_limit}"`}`,
    );
  }
  lines.push('limit_source = "probed"');
  lines.push(`probed_value = ${p.probed_value}`);
  lines.push(`probed_agent_version = "${p.probed_agent_version}"`);
  lines.push(`probed_at = "${p.probed_at}"`);
  return lines.join('\n');
}

export const command: CommandDef = {
  name: 'probe',
  summary:
    '预算阈值探针:干跑量余量;--write 记录人在真实 agent 上观察到的上限(--observed),产出 limit_source=probed 补丁',
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
    {
      name: '--observed <id>=<N>|bytes:<N>,lines:<M>',
      description:
        '--write 时该 agent 在真实环境观察到的上限(非 documented 目标必填;kit 只记录)。单维度目标 <id>=<N>(N 单位=该维度);同时配 max_bytes 与 max_lines 的目标 <id>=bytes:<N>,lines:<M>(两个维度都和观测值比,probed_value 记 bytes);写法与目标不符 → PROBE_OBSERVED_DIM_MISMATCH',
    },
  ],
  async run(ctx) {
    const argv = ctx.argv;
    if (argv.includes('--help')) {
      for (const f of command.flags ?? []) ctx.stdout(`${f.name}  ${f.description}\n`);
      return ExitCode.OK;
    }
    const parsed = parseArgs(argv);
    if (isArgError(parsed)) {
      ctx.stderr(`agent-kit probe: ${parsed.code}: ${parsed.message}\n`);
      return ExitCode.USAGE;
    }
    const { write, agents: onlyAgents, versions: versionFlag, observed: observedFlag } = parsed;

    const prepared = await prepareBudgetInputs(ctx.io.repoRoot, ctx.stdout);
    if (prepared.inputs === undefined) {
      for (const d of prepared.diagnostics) ctx.stderr(`${d.code}: ${d.message}\n`);
      return ExitCode.FAIL_CLOSED;
    }
    const { config, rendered } = prepared.inputs;
    const enabled: readonly string[] = config.agents.enabled;
    for (const a of [
      ...onlyAgents,
      ...versionFlag.map((v) => v.agent),
      ...observedFlag.map((v) => v.agent),
    ]) {
      if (!enabled.includes(a)) {
        ctx.stderr(`agent-kit probe: PROBE_AGENT_NOT_ENABLED: ${a} 不在 agents.enabled 里\n`);
        return ExitCode.USAGE;
      }
    }
    const report = computeBudget({ outputs: rendered.files, config: config.budget });

    const d = (probeDeps.now ?? (() => new Date()))();
    const now = Number.isNaN(d.getTime())
      ? 'invalid-time'
      : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const patches: string[] = [];
    const versionOf = (agent: string): string | undefined =>
      versionFlag.find((v) => v.agent === agent)?.version;

    const observedOf = (agent: string): ObservedFlag | undefined =>
      observedFlag.find((v) => v.agent === agent);

    for (const t of report.targets) {
      if (onlyAgents.length > 0 && !onlyAgents.includes(t.agent)) continue;
      const dim = probeDimension(t);
      const measured = dim === 'lines' ? t.lines : t.bytes;
      if (!write) {
        const max = dim === 'lines' ? t.max_lines : t.max_bytes;
        ctx.stdout(
          `${t.agent}: measured bytes=${t.bytes} lines=${t.lines} ` +
            `limit_source=${t.limit_source} max_bytes=${t.max_bytes ?? '-'} max_lines=${t.max_lines ?? '-'} ` +
            `headroom(${dim})=${max === undefined ? '-' : max - measured}` +
            (t.max_bytes !== undefined && t.max_lines !== undefined
              ? ` headroom_bytes=${t.max_bytes - t.bytes} headroom_lines=${t.max_lines - t.lines}`
              : '') +
            (t.limit_source === 'documented' ? '(documented:官方值,探针不改写)' : '') +
            '\n',
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
      const ob = observedOf(t.agent);
      if (ob === undefined) {
        ctx.stderr(
          `agent-kit probe: PROBE_OBSERVED_REQUIRED: ${t.agent} 写回需要 --observed ${t.agent}=<N>(双维度目标 bytes:<N>,lines:<M>;在真实 agent 上观察到的上限;kit 不编造)\n`,
        );
        return ExitCode.USAGE;
      }
      const dual = t.max_bytes !== undefined && t.max_lines !== undefined;
      if (dual ? ob.bytes === undefined || ob.lines === undefined : ob.single === undefined) {
        ctx.stderr(
          `agent-kit probe: PROBE_OBSERVED_DIM_MISMATCH agent=${t.agent}: ` +
            (dual
              ? '同时配了 max_bytes 与 max_lines 的目标必须给 --observed <agent>=bytes:<N>,lines:<M>(两个维度都和观测值比)'
              : `该目标只配了一个维度(${dim}),--observed 只能写 <agent>=<N>,不接受 bytes:/lines: 形式`) +
            '\n',
        );
        return ExitCode.USAGE;
      }
      const checks: [string, number | undefined, number][] = dual
        ? [
            ['bytes', t.max_bytes, ob.bytes as number],
            ['lines', t.max_lines, ob.lines as number],
          ]
        : [[dim, dim === 'lines' ? t.max_lines : t.max_bytes, ob.single as number]];
      for (const [cd, mx, obv] of checks) {
        if (mx !== undefined && mx > obv) {
          ctx.stderr(
            `agent-kit probe: PROBE_LIMIT_ABOVE_OBSERVED agent=${t.agent}: 原 max_${cd}=${mx} 大于观测值 ${obv},不出补丁(先把 max 降到不超过观测值)\n`,
          );
          return ExitCode.USAGE;
        }
      }
      // probed_value 沿用 schema 单字段:双维度记 bytes 观测值(lines 观测值只参与比较、不落盘)
      const recorded = dual ? (ob.bytes as number) : (ob.single as number);
      const patch = BudgetTargetSchema.safeParse(buildPatch(t, recorded, av, now));
      if (!patch.success) {
        ctx.stderr(
          `agent-kit probe: PROBE_PATCH_INVALID agent=${t.agent}: ${patch.error.issues.map((i) => i.message).join('; ')}\n`,
        );
        return ExitCode.FAIL_CLOSED;
      }
      patches.push(patchToToml(t.agent, patch.data));
    }

    if (write) {
      if (patches.length === 0) {
        ctx.stdout('probe: 没有可写回的目标\n');
      } else {
        ctx.stdout('# 粘贴进 kit.toml(替换对应 [budget.<agent>] 段;探针不直接写文件系统)\n');
        for (const p of patches) ctx.stdout(`${p}\n\n`);
      }
    }

    const pending = rendered.report.pendingProbes;
    if (pending.length > 0) {
      ctx.stdout(`--- 有效性探针待办(pendingProbes,不作为事实):${pending.length} 项 ---\n`);
      for (const p of pending) ctx.stdout(`${p.id}: ${p.description}\n`);
    }
    return ExitCode.OK;
  },
};
