/**
 * `agent-kit reflect`(R5,契约 #27–#29、docs/contracts.md §17):从信号库生成提案(暂存区 + apply.patch)。
 *
 * - **默认干跑**:装载/分类/聚类/构造提示并打印计划;**不构造后端、不调用后端、不写任何文件**。
 *   `--show-prompt` 只在干跑下把提示打到 stdout(不落盘);与 `--json`、`--run-llm` 互斥。
 * - **真跑**须同时:`--run-llm`、`--allow-egress`、覆盖层 `reflect.egress = true`、`--owner @handle`。
 *   缺 `--allow-egress` / 覆盖层未同意 / 缺 `--owner` → 退出 2,零调用零写入。
 * - 后端只经 `src/reflect/backends/index.ts` 的 `buildBackends`(本文件不 import llm-exec);
 *   工厂只在真跑时被调用。任何 CLI 参数集仍是 `verified:false`,默认拒绝真跑(R6 前)。
 * - 退出码:0 完成;1 输出被拒/整批不暂存;2 用法错;3 fail-closed(信号库损坏、提示复扫残留、
 *   厂商 unknown、写出口拒绝、未知异常);4 后端不可用/未配置/超出 --max-calls。多个结果走 `combineExitCodes`。
 * - stdout 只含计数、枚举、id、哈希(`--json` 为 canonical JSON);stderr 只含稳定码,不回显异常消息或任何文本。
 * - 数字参数一律 `parseDecimalUint`。
 */
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { computeBudget } from '../budget/budget.js';
import { AgentIdSchema, IsoDateSchema } from '../contracts/common.js';
import type { AgentId } from '../contracts/common.js';
import { OverlaySchema } from '../contracts/config.js';
import type { Overlay, ReflectBackendBinding } from '../contracts/config.js';
import { ExitCode } from '../contracts/exit-codes.js';
import { JUDGE_HOP_CHAIN, JudgeHopIdSchema } from '../contracts/proposal.js';
import type { JudgeHopId } from '../contracts/proposal.js';
import type { Redactor } from '../contracts/redact.js';
import { KIT_VERSION } from '../contracts/meta.js';
import { canonicalJson } from '../io/canonical-json.js';
import { getRealHome } from '../io/paths.js';
import { readText, realpathSync, statSync } from '../io/read-fs.js';
import { WriteDeniedError } from '../io/safe-fs.js';
import { createRedactor } from '../redact/redactor.js';
import { loadExistingAtoms, loadStagedAtoms, loadUsedProposalIds } from '../reflect/atoms-index.js';
import type { LlmBackend } from '../reflect/backend-iface.js';
import { buildBackends, createSpawnBudget } from '../reflect/backends/index.js';
import { runReflect } from '../reflect/run.js';
import type { RunDeps, RunOpts, RunResult } from '../reflect/run.js';
import {
  ReflectCallLimitError,
  ReflectFailClosedError,
  ReflectUsageError,
} from '../reflect/types.js';
import { SignalStoreError } from '../signals/state-store.js';
import { parseDecimalUint } from './args.js';
import { prepareBudgetInputs } from './check-budget.js';
import { combineExitCodes } from './types.js';
import type { CommandContext, CommandDef } from './types.js';

export const DEFAULT_REFLECT_MAX_CALLS = 1;
export const REFLECT_HARD_MAX_CALLS = 3;
export const REFLECT_MAX_PROPOSALS = 5;
/** 脱敏每条每遍的时间预算:反思器要对整份提示复扫,取 5s(可经 deps 注入),避免负载抖动被当成泄露。 */
export const DEFAULT_REFLECT_REDACT_TIMEOUT_MS = 5000;
/** 干跑且未给 --owner 时的占位(runReflect 总要校验 owner;干跑不写任何文件,占位不会落盘)。 */
export const DRY_RUN_OWNER = '@dry-run';

/** 命令层额外拿到的宿主环境(由 `src/cli.ts` 的 `main(argv, env)` 注入;命令层不读 process.env)。 */
export type EnvCommandContext = CommandContext & {
  env?: Readonly<Record<string, string | undefined>>;
};

export type CliBackends = Readonly<Partial<Record<JudgeHopId, LlmBackend>>>;

// ---------------------------------------------------------------------------
// 与 judge 共用的接线辅助
// ---------------------------------------------------------------------------

/** 覆盖层 `reflect` 段里用户**显式写了**的 core 上限键(schema 默认值不算):用来分清「覆盖层的值」和「默认值」。 */
export type ExplicitLimit = 'max_calls' | 'max_proposals' | 'timeout_ms';
export type OverlayLoad =
  { ok: true; overlay: Overlay | undefined; explicit: ReadonlySet<ExplicitLimit> } | { ok: false };

/** 读覆盖层(只经 `--overlay` 显式传入)。失败不回显内容:覆盖层本身就是敏感词表。 */
export async function loadOverlay(ctx: CommandContext): Promise<OverlayLoad> {
  if (ctx.overlayPath === undefined) return { ok: true, overlay: undefined, explicit: new Set() };
  try {
    const raw = parseToml(await readText(ctx.overlayPath));
    const section = (raw as { reflect?: Record<string, unknown> }).reflect;
    const explicit = new Set<ExplicitLimit>(
      (['max_calls', 'max_proposals', 'timeout_ms'] as const).filter(
        (k) => section !== undefined && typeof section === 'object' && k in section,
      ),
    );
    return { ok: true, overlay: OverlaySchema.parse(raw), explicit };
  } catch {
    return { ok: false };
  }
}

/** 覆盖层 `reflect.egress`:缺省/缺覆盖层 = false(摘录不得离开本机)。 */
export function overlayAllowsEgress(overlay: Overlay | undefined): boolean {
  return overlay?.reflect?.egress === true;
}

/**
 * 子进程环境的来源。命令层不能读 `process.env`(eslint:只许 `src/io/paths.ts`):
 * 有注入的环境就用它;PATH 缺省取 `IoContext.execPath`,HOME 缺省取 `getRealHome()`(CLI 要读自己的登录态)。
 * (待主代理:`IoContext` 增可选 `hostEnv` 后改为直接取它,见 contracts §12.4 ④。)
 */
export function hostEnvOf(ctx: EnvCommandContext): Record<string, string | undefined> {
  const src = ctx.env ?? {};
  return {
    ...src,
    PATH: src['PATH'] ?? ctx.io.execPath,
    HOME: src['HOME'] ?? getRealHome(ctx.env),
  };
}

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** `child` 是否在 `parent` 之内(大小写与 Unicode 形式折叠后比较,宁可多拒)。 */
function isInside(parent: string, child: string): boolean {
  const fold = (x: string): string => x.normalize('NFC').toLowerCase();
  const rel = path.relative(fold(parent), fold(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 在 PATH 的绝对项里找 `<cli>` 的可执行常规文件。与后端同一规则:相对项、指进仓库的项(KIT_TMP 内除外)一律跳过,
 * 这样放行清单里不会出现仓库里的二进制。
 */
function resolveBinary(
  cli: string,
  pathEnv: string,
  io: { repoRoot: string; tmpDir: string | undefined },
): string | undefined {
  const repo = realOrSelf(io.repoRoot);
  const tmp = io.tmpDir === undefined ? undefined : realOrSelf(io.tmpDir);
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir === '' || !path.isAbsolute(dir)) continue;
    const real = realOrSelf(dir);
    if (isInside(repo, real) && !(tmp !== undefined && isInside(tmp, real))) continue;
    const c = path.join(dir, cli);
    try {
      const st = statSync(c);
      if (st.isFile() && (st.mode & 0o111) !== 0) return c;
    } catch {
      // 下一项
    }
  }
  return undefined;
}

export interface BuildCliBackendsInput {
  readonly ctx: EnvCommandContext;
  readonly overlay: Overlay | undefined;
  readonly now: () => Date;
  /** spawn 预算上限(≤10) */
  readonly maxSpawns: number;
}

/**
 * 真实后端接线:覆盖层 → `buildBackends`。**只在 `--run-llm --allow-egress` 时调用**(干跑不构造)。
 * - 返回的只含**已绑定**的槽位(未绑定的占位后端被剔除,调用方据此判断「没有可用后端」);
 * - 同一 state 目录进程内只能创建一次 spawn 预算(`createSpawnBudget`),重复创建会抛错;
 * - `allow_unverified` 是**逐槽位**的:分两组各调一次 `buildBackends`,只有显式写了 `allow_unverified = true`
 *   的槽位所在那组拿到 `allowUnverified` 清单(其 CLI 二进制的绝对路径),其余槽位的清单恒为空;
 * - `allowEgress: true` 由调用方保证(用户同时给了 `--run-llm --allow-egress` 且覆盖层同意)。
 */
export function buildCliBackends(input: BuildCliBackendsInput): CliBackends {
  const { ctx, overlay, now, maxSpawns } = input;
  const bindings = overlay?.reflect?.backends ?? [];
  if (bindings.length === 0) return {};
  const budget = createSpawnBudget(ctx.io, maxSpawns);
  const envSource = hostEnvOf(ctx);
  const out: Partial<Record<JudgeHopId, LlmBackend>> = {};
  for (const allow of [false, true]) {
    const group: ReflectBackendBinding[] = bindings.filter(
      (b) => (b.allow_unverified === true) === allow,
    );
    if (group.length === 0) continue;
    const allowUnverified = allow
      ? group
          .map((b) => resolveBinary(b.cli, envSource['PATH'] ?? '', ctx.io))
          .filter((p): p is string => p !== undefined)
      : [];
    const chain = buildBackends(
      {
        backends: group,
        reset_tz: overlay?.reflect?.reset_tz ?? 'UTC',
        vendor_overrides: overlay?.reflect?.vendor_overrides ?? {},
      },
      { ctx: ctx.io, now, budget, envSource, allowEgress: true, allowUnverified },
    );
    for (const b of group) {
      const hop = JUDGE_HOP_CHAIN.indexOf(b.slot);
      const backend = chain[hop];
      if (backend !== undefined && out[b.slot] === undefined) out[b.slot] = backend;
    }
  }
  return out;
}

/**
 * `team_project_keys` 是白名单,而 `runReflect` 的 `personalProjectKeys` 是黑名单(has 为真 → 降为 personal)。
 * 在命令层取反:`has(k) = !team.has(k)`,所以缺省(空白名单)时**所有**项目都是 personal。
 * 只支持 `has()`;其余成员(size、迭代、forEach…)一律抛错,免得将来有人迭代它得到悄悄放行的空集。
 */
export function personalKeysFromTeamWhitelist(team: readonly string[]): ReadonlySet<string> {
  const whitelist = new Set(team);
  return new Proxy(new Set<string>(), {
    get(_t, prop) {
      if (prop === 'has') return (k: string) => !whitelist.has(k);
      throw new TypeError(`personalProjectKeys 视图只支持 has()(访问了 ${String(prop)})`);
    },
  }) as ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

interface Parsed {
  agents: AgentId[];
  since: string | undefined;
  maxProposals: number | undefined;
  runLlm: boolean;
  allowEgress: boolean;
  backend: JudgeHopId | undefined;
  maxCalls: number | undefined;
  timeoutMs: number | undefined;
  owner: string | undefined;
  showPrompt: boolean;
  json: boolean;
  error: string | undefined;
}

function parseArgs(argv: readonly string[]): Parsed {
  const out: Parsed = {
    agents: [],
    since: undefined,
    maxProposals: undefined,
    runLlm: false,
    allowEgress: false,
    backend: undefined,
    maxCalls: undefined,
    timeoutMs: undefined,
    owner: undefined,
    showPrompt: false,
    json: false,
    error: undefined,
  };
  const fail = (m: string): void => {
    if (out.error === undefined) out.error = m;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const value = (name: string): string | undefined => {
      if (a === name) {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) {
          fail(`${name} 需要一个值`);
          return undefined;
        }
        i++;
        return v;
      }
      if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
      return undefined;
    };
    if (a === '--run-llm') out.runLlm = true;
    else if (a === '--allow-egress') out.allowEgress = true;
    else if (a === '--show-prompt') out.showPrompt = true;
    else if (a === '--json') out.json = true;
    else {
      const agent = value('--agent');
      if (agent !== undefined) {
        const p = AgentIdSchema.safeParse(agent);
        if (p.success) out.agents.push(p.data);
        else fail(`未知 agent:${agent}`);
        continue;
      }
      const since = value('--since');
      if (since !== undefined) {
        if (IsoDateSchema.safeParse(since).success) out.since = since;
        else fail('--since 需要 YYYY-MM-DD');
        continue;
      }
      const mp = value('--max-proposals');
      if (mp !== undefined) {
        const n = parseDecimalUint(mp);
        if (n === undefined || n < 1 || n > REFLECT_MAX_PROPOSALS) {
          fail(`--max-proposals 需要 1..${REFLECT_MAX_PROPOSALS} 的十进制整数`);
        } else out.maxProposals = n;
        continue;
      }
      const mc = value('--max-calls');
      if (mc !== undefined) {
        const n = parseDecimalUint(mc);
        if (n === undefined || n < 1 || n > REFLECT_HARD_MAX_CALLS) {
          fail(`--max-calls 需要 1..${REFLECT_HARD_MAX_CALLS} 的十进制整数`);
        } else out.maxCalls = n;
        continue;
      }
      const tm = value('--timeout-ms');
      if (tm !== undefined) {
        const n = parseDecimalUint(tm);
        if (n === undefined || n < 1000 || n > 600_000) {
          fail('--timeout-ms 需要 1000..600000 的十进制整数');
        } else out.timeoutMs = n;
        continue;
      }
      const backend = value('--backend');
      if (backend !== undefined) {
        const p = JudgeHopIdSchema.safeParse(backend);
        if (p.success) out.backend = p.data;
        else fail(`未知后端槽位:${backend}`);
        continue;
      }
      const owner = value('--owner');
      if (owner !== undefined) {
        out.owner = owner;
        continue;
      }
      fail(`未知参数:${a}`);
    }
  }
  if (out.error === undefined) {
    if (out.showPrompt && out.runLlm) out.error = '--show-prompt 只在干跑下可用(与 --run-llm 互斥)';
    else if (out.showPrompt && out.json)
      out.error = '--show-prompt 与 --json 互斥(--json 摘要绝不含任何文本)';
    else if (out.runLlm && !out.allowEgress) {
      out.error = '--run-llm 必须同时给 --allow-egress:已脱敏的摘录将离开本机,发送给所选后端的厂商';
    } else if (out.runLlm && out.owner === undefined) {
      out.error = '--run-llm 需要 --owner @handle(暂存的原子要有负责人)';
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

export interface ReflectCommandDeps {
  /** 时钟;缺省真实时间 */
  clock?: () => Date;
  /** 随机源:返回 n 字节的十六进制串(run_id 后缀);缺省 node:crypto */
  randomHex?: (bytes: number) => string;
  /** 缺省 `runReflect` */
  runReflect?: (deps: RunDeps, opts: RunOpts) => Promise<RunResult>;
  /**
   * 后端工厂。**只在真跑(--run-llm --allow-egress 且覆盖层同意)时调用**;返回「槽位 → 后端」,只含已配置的槽位。
   * 缺省 = 按覆盖层的 `reflect.backends` 经 `buildBackends` 构造真实 CLI 后端。
   */
  createBackends?(
    ctx: EnvCommandContext,
    input: { overlay: Overlay | undefined; maxCalls: number; now: () => Date },
  ): CliBackends | Promise<CliBackends>;
  /** 测试注入;缺省按覆盖层建真实 Redactor */
  redactor?: Pick<Redactor, 'pass2'>;
  redactTimeoutMs?: number;
  /** 测试用:把提案标成 stub 产物(命令行没有对应开关) */
  stub?: boolean;
}

const SAFE_ENUM_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const safeEnum = (s: string | undefined): string | undefined =>
  s !== undefined && SAFE_ENUM_RE.test(s) ? s : undefined;

/** 退出码映射。`ReflectUsageError`→2;`ReflectFailClosedError`/`SignalStoreError`/`WriteDeniedError`→3;`ReflectCallLimitError`→4;其余未知异常→3。 */
export function reflectErrorExit(e: unknown): { code: number; reason: string } {
  if (e instanceof ReflectUsageError) return { code: ExitCode.USAGE, reason: e.code };
  if (e instanceof ReflectCallLimitError) return { code: ExitCode.NOT_RUN, reason: e.code };
  if (e instanceof ReflectFailClosedError) return { code: ExitCode.FAIL_CLOSED, reason: e.code };
  if (e instanceof SignalStoreError) return { code: ExitCode.FAIL_CLOSED, reason: 'SIGNAL_STORE' };
  if (e instanceof WriteDeniedError) return { code: ExitCode.FAIL_CLOSED, reason: e.code };
  return { code: ExitCode.FAIL_CLOSED, reason: 'internal' };
}

type BudgetState = 'ok' | 'full' | 'unknown';

function newRunId(now: Date, rnd: (bytes: number) => string): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `run-${stamp}-${rnd(3)}`;
}

function summaryOf(
  r: RunResult,
  extra: { budget: BudgetState; plannedBackend: string | null; exit: number },
): Record<string, unknown> {
  const rep = r.report;
  return {
    run_id: rep.run_id,
    mode: rep.mode,
    outcome: rep.outcome,
    exit_code: extra.exit,
    signals: {
      loaded: rep.signals_loaded,
      dropped_schema: rep.signals_dropped.schema,
      dropped_residual: rep.signals_dropped.residual,
      external_excerpt_forced: rep.signals_dropped.external_excerpt_forced,
      structure_unknown: r.plan.structure_unknown,
    },
    plan: {
      clusters: r.plan.clusters,
      evidence: r.plan.evidence,
      evidence_truncated: r.plan.evidence_truncated,
      batches: r.plan.batches,
      calls_needed: r.plan.calls_needed,
      exceeds_call_limit: r.plan.exceeds_call_limit,
    },
    prompt: { bytes: rep.prompt_bytes, sha256: rep.prompt_sha256, input_digest: rep.input_digest },
    backend: rep.backend,
    planned_backend: extra.plannedBackend,
    calls: { made: rep.calls_made, limit: rep.calls_limit },
    budget: extra.budget,
    rejected: rep.rejected,
    staged: rep.staged,
    duplicates: r.duplicates.length,
    observations: rep.observations_n,
    guardrail_mentions: r.guardrailMentions,
  };
}

function humanLines(s: Record<string, unknown>): string {
  const g = <T>(k: string): T => s[k] as T;
  const sig = g<Record<string, number>>('signals');
  const plan = g<Record<string, number | boolean>>('plan');
  const prompt = g<Record<string, unknown>>('prompt');
  const calls = g<Record<string, number>>('calls');
  const backend = g<{ slot: string; vendor: string; model: string } | null>('backend');
  const rejected = Object.entries(g<Record<string, number>>('rejected'))
    .map(([k, n]) => `${k}=${n}`)
    .join(',');
  return (
    [
      `reflect: run=${String(s['run_id'])} mode=${String(s['mode'])} outcome=${String(s['outcome'])} exit=${String(s['exit_code'])}`,
      `signals: loaded=${sig['loaded']} dropped_schema=${sig['dropped_schema']} dropped_residual=${sig['dropped_residual']} external_excerpt_forced=${sig['external_excerpt_forced']} structure_unknown=${sig['structure_unknown']}`,
      `plan: clusters=${plan['clusters']} evidence=${plan['evidence']} truncated=${plan['evidence_truncated']} batches=${plan['batches']} calls_needed=${plan['calls_needed']} exceeds_call_limit=${String(plan['exceeds_call_limit'])}`,
      `prompt: bytes=${String(prompt['bytes'])} sha256=${String(prompt['sha256'])}`,
      `backend: ${backend === null ? `none planned=${String(s['planned_backend'])}` : `slot=${backend.slot} vendor=${backend.vendor} model=${backend.model}`}`,
      `calls: made=${calls['made']} limit=${calls['limit']} budget=${String(s['budget'])}`,
      `staged: ${g<string[]>('staged').join(',') || '-'}`,
      `rejected: ${rejected || '-'}`,
    ].join('\n') + '\n'
  );
}

export function createReflectCommand(deps: ReflectCommandDeps = {}): CommandDef {
  const clock = deps.clock ?? ((): Date => new Date());
  const randomHex = deps.randomHex ?? ((n: number): string => randomBytes(n).toString('hex'));
  const doReflect = deps.runReflect ?? runReflect;
  const def: CommandDef = {
    name: 'reflect',
    summary: '反思器:从信号生成提案(默认干跑;暂存区 + apply.patch)',
    phase: 'P1',
    ownerBlock: 'P1',
    flags: [
      { name: '--agent <id>', description: '(可重复)只处理该 agent 的信号;缺省 = 全部' },
      { name: '--since <YYYY-MM-DD>', description: '只处理该日期及之后的信号' },
      { name: '--max-proposals <n>', description: '本批提案数上限,1..5,默认 5' },
      {
        name: '--run-llm',
        description:
          '真跑:调用后端(须同时给 --allow-egress 与 --owner,且覆盖层 reflect.egress=true);缺省干跑',
      },
      { name: '--allow-egress', description: '同意把已脱敏摘录发送给所选后端的厂商' },
      { name: '--backend <slot>', description: '后端槽位;已配置多个槽位时必填' },
      { name: '--max-calls <n>', description: '本次最多调用后端次数,默认 1,上限 3' },
      { name: '--timeout-ms <n>', description: '单次调用超时,1000..600000,默认 180000' },
      { name: '--owner <@handle>', description: '暂存原子的负责人;--run-llm 必填' },
      { name: '--show-prompt', description: '仅干跑:把提示打到 stdout(不落盘);与 --json 互斥' },
      { name: '--json', description: '输出 canonical JSON 摘要(只含计数、枚举、id、哈希)' },
    ],
    async run(rawCtx: CommandContext): Promise<number> {
      const ctx = rawCtx as EnvCommandContext;
      const args = parseArgs(ctx.argv);
      if (args.error !== undefined) {
        ctx.stderr(`agent-kit reflect: ${args.error}\n`);
        return ExitCode.USAGE;
      }
      const live = args.runLlm && args.allowEgress;

      const loaded = await loadOverlay(ctx);
      if (!loaded.ok) {
        ctx.stderr('agent-kit reflect: 覆盖层读取或校验失败\n'); // 不回显覆盖层内容
        return ExitCode.USAGE;
      }
      const overlay = loaded.overlay;
      if (live && !overlayAllowsEgress(overlay)) {
        ctx.stderr(
          'agent-kit reflect: 覆盖层未同意外发(reflect.egress = true 才允许摘录离开本机);未调用、未写入\n',
        );
        return ExitCode.USAGE;
      }

      let redactor = deps.redactor;
      if (redactor === undefined) {
        try {
          redactor = createRedactor(
            {
              sensitive_words: overlay?.sensitive_words ?? [],
              timeout_ms: deps.redactTimeoutMs ?? DEFAULT_REFLECT_REDACT_TIMEOUT_MS,
            },
            { internalDomains: overlay?.internal_domains ?? [] },
          );
        } catch {
          ctx.stderr('REFLECT_FAIL_CLOSED reason=redactor_init\n');
          return ExitCode.FAIL_CLOSED;
        }
      }

      // 预算(budgetFull):算不出来时,干跑只标 unknown;真跑 fail-closed(不知道预算就不暂存)
      let budget: BudgetState = 'unknown';
      let kitReflect: { max_calls?: number; max_proposals?: number; timeout_ms?: number } = {};
      try {
        const prepared = await prepareBudgetInputs(ctx.io.repoRoot, () => undefined);
        if (prepared.inputs !== undefined) {
          const report = computeBudget({
            outputs: prepared.inputs.rendered.files,
            config: prepared.inputs.config.budget,
          });
          budget = report.targets.some((t) => t.level !== 'ok') ? 'full' : 'ok';
          kitReflect = prepared.inputs.config.reflect ?? {};
        }
      } catch {
        budget = 'unknown';
      }
      if (live && budget === 'unknown') {
        ctx.stderr('REFLECT_FAIL_CLOSED reason=budget_unavailable\n');
        return ExitCode.FAIL_CLOSED;
      }

      // 优先级:命令行 > 覆盖层里显式写的值 > kit.toml 的 [reflect] > 内置默认。
      // (覆盖层 schema 给这三项套了默认值,不看「是否显式写过」就会盖掉 kit.toml 的上限。)
      const ov = overlay?.reflect;
      const explicit = loaded.explicit;
      const maxCalls =
        args.maxCalls ??
        (explicit.has('max_calls') ? ov?.max_calls : undefined) ??
        kitReflect.max_calls ??
        DEFAULT_REFLECT_MAX_CALLS;
      const maxProposals =
        args.maxProposals ??
        (explicit.has('max_proposals') ? ov?.max_proposals : undefined) ??
        kitReflect.max_proposals ??
        REFLECT_MAX_PROPOSALS;
      const timeoutMs =
        args.timeoutMs ??
        (explicit.has('timeout_ms') ? ov?.timeout_ms : undefined) ??
        kitReflect.timeout_ms;

      // 预算已满:真跑不必调用后端(调用了摘录也白发一次,结果还是整批不暂存)
      if (live && budget === 'full') {
        ctx.stderr('REFLECT_BUDGET_FULL: 目标预算已满,不调用后端、未写入\n');
        return ExitCode.CHECK_FAILED;
      }

      try {
        const now = clock();
        let backend: LlmBackend | undefined;
        let backendCli: RunDeps['backendCli'];
        if (live) {
          const backends = await (deps.createBackends ?? defaultCreateBackends)(ctx, {
            overlay,
            maxCalls,
            now: clock,
          });
          const bound = JUDGE_HOP_CHAIN.filter((h) => backends[h] !== undefined);
          let slot: JudgeHopId | undefined = args.backend;
          if (slot === undefined) {
            if (bound.length > 1) {
              ctx.stderr(
                `agent-kit reflect: 已配置 ${bound.length} 个后端槽位,须用 --backend <slot> 指定(不自动挑选:摘录将发给所选厂商)\n`,
              );
              return ExitCode.USAGE;
            }
            slot = bound[0];
          }
          backend = slot === undefined ? undefined : backends[slot];
          if (backend === undefined) {
            ctx.stderr('REFLECT_NOT_RUN reason=backend_not_configured\n'); // 未调用、未写入
            return ExitCode.NOT_RUN;
          }
          backendCli = overlay?.reflect?.backends.find((b) => b.slot === slot)?.cli;
          ctx.stderr(
            `REFLECT_EGRESS slot=${safeEnum(backend.slot) ?? '?'} vendor=${safeEnum(backend.vendor) ?? '?'}\n`,
          );
        }

        const runDeps: RunDeps = {
          io: ctx.io,
          redactor,
          clock,
          ...(backend !== undefined ? { backend } : {}),
          backendCli,
          existingAtoms: await loadExistingAtoms(ctx.io),
          stagedAtoms: await loadStagedAtoms(ctx.io),
          usedProposalIds: await loadUsedProposalIds(ctx.io),
          kitVersion: KIT_VERSION,
        };
        const result = await doReflect(runDeps, {
          mode: live ? (deps.stub === true ? 'stub' : 'llm') : 'dry',
          runId: newRunId(now, randomHex),
          owner: args.owner ?? DRY_RUN_OWNER,
          since: args.since,
          agents: args.agents.length > 0 ? args.agents : undefined,
          maxProposals,
          maxCalls,
          timeoutMs,
          allowEgress: live,
          personalProjectKeys: personalKeysFromTeamWhitelist(ov?.team_project_keys ?? []),
          budgetFull: budget === 'full',
          includePrompt: args.showPrompt,
        });

        const exit = combineExitCodes([result.exitCode]);
        const bindings = overlay?.reflect?.backends ?? [];
        const planned =
          args.backend !== undefined
            ? bindings.find((b) => b.slot === args.backend)
            : bindings.length === 1
              ? bindings[0]
              : undefined;
        const summary = summaryOf(result, {
          budget,
          plannedBackend: live || planned === undefined ? null : `${planned.slot}/${planned.cli}`,
          exit,
        });
        if (args.json) ctx.stdout(canonicalJson(summary));
        else ctx.stdout(humanLines(summary));
        if (args.showPrompt) {
          // 仅干跑;提示文本只到 stdout,不落盘
          for (const p of result.prompts ?? []) ctx.stdout(`${p.system}\n\n${p.user}\n`);
        }
        const failure = safeEnum(result.backendFailure);
        if (failure !== undefined) ctx.stderr(`REFLECT_NOT_RUN reason=backend_${failure}\n`);
        return exit;
      } catch (e) {
        const { code, reason } = reflectErrorExit(e);
        const tag =
          code === ExitCode.USAGE ? 'USAGE' : code === ExitCode.NOT_RUN ? 'NOT_RUN' : 'FAIL_CLOSED';
        ctx.stderr(`REFLECT_${tag} reason=${reason}\n`); // 只报稳定码,不带异常消息
        return combineExitCodes([code]);
      }
    },
  };
  return def;
}

function defaultCreateBackends(
  ctx: EnvCommandContext,
  input: { overlay: Overlay | undefined; maxCalls: number; now: () => Date },
): CliBackends {
  return buildCliBackends({
    ctx,
    overlay: input.overlay,
    now: input.now,
    maxSpawns: input.maxCalls,
  });
}

export const command: CommandDef = createReflectCommand();
