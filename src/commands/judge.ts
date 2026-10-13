/**
 * `agent-kit judge --run <run_id> [--run-llm --allow-egress] [--max-calls N]`(R4,契约 #24–#28):
 * 对 reflect 暂存的提案做跨厂商评审。
 *
 * - 默认干跑:读提案、建提示、列出每跳计划;**不调用后端、不写任何文件**。
 * - 真跑须同时给 `--run-llm` 与 `--allow-egress`(提案摘录会离开本机);缺后者退出 2。
 * - 后端经依赖注入(`createJudgeCommand(deps)`)。默认的 `command`(R5 接线)用与 reflect 同一套 `buildCliBackends`
 *   (覆盖层 `reflect.backends` → `buildBackends`),**只在 `--run-llm --allow-egress` 时构造**,干跑不构造;
 *   覆盖层须 `reflect.egress = true`,否则退出 2。没有已配置的槽位 → 真跑退出 4 并提示。
 *   本文件不 import llm-exec 与 `src/reflect/backends/**`(经 ./reflect.js 的接线辅助)。
 * - 读写只经 read-fs/safe-fs;写入限 `.state/reflect/<run_id>/proposals/` 下的 judge/judge_attempts。
 * - 退出码:0 完成(含 pending=no_cross_vendor);1 有提案 reject / injection_suspected / 没评上且出现过评审输出校验不通过;
 *   2 用法错(含 run 不存在);3 状态损坏、提示复扫残留、厂商不可证明、写出口拒绝;
 *   4 后端不可用/全部冷却/超出 --max-calls。
 */
import type { Overlay } from '../contracts/config.js';
import type { Redactor } from '../contracts/redact.js';
import { ExitCode } from '../contracts/exit-codes.js';
import { canonicalJson } from '../io/canonical-json.js';
import { WriteDeniedError } from '../io/safe-fs.js';
import {
  JudgeFailClosedError,
  JudgeProviderMismatchError,
  JudgeStateError,
} from '../judge/errors.js';
import { runJudge } from '../judge/run.js';
import type { JudgeBackends, JudgeReport, ProposalOutcome } from '../judge/run.js';
import { JudgeRunNotFoundError } from '../judge/store.js';
import { createRedactor } from '../redact/redactor.js';
import { parseDecimalUint } from './args.js';
import { buildCliBackends, loadOverlay, overlayAllowsEgress } from './reflect.js';
import type { EnvCommandContext } from './reflect.js';
import { combineExitCodes } from './types.js';
import type { CommandContext, CommandDef } from './types.js';

export const DEFAULT_MAX_CALLS = 5;
/** 与 llm-exec 的 LLM_MAX_SPAWNS 对齐 */
export const MAX_CALLS_CEILING = 10;
/** 评审提示/输出的脱敏复扫每遍时间预算(与 signals collect 同一取舍:负载抖动不应当成泄露)。 */
export const DEFAULT_JUDGE_REDACT_TIMEOUT_MS = 250;

export interface JudgeCommandDeps {
  /**
   * 后端工厂:返回「兜底链槽位 → 后端」。必须无副作用(干跑也会调用它来列计划,但不得 complete)。
   * `mode.live` = 用户同时给了 `--run-llm --allow-egress`;默认接线的工厂只在 live 时构造后端。
   * 缺省 = 没有任何可用后端。
   */
  createBackends?(
    ctx: CommandContext,
    mode: { live: boolean; maxCalls: number; overlay: Overlay | undefined },
  ): Promise<JudgeBackends> | JudgeBackends;
  /** 真跑要求覆盖层 `reflect.egress = true`。缺省 = 要求;只有注入进程内假后端的测试才传 false */
  requireOverlayEgress?: boolean;
  /** 测试注入;缺省按覆盖层建真实 Redactor */
  redactor?: Pick<Redactor, 'pass2'>;
}

interface Parsed {
  run: string | undefined;
  runLlm: boolean;
  allowEgress: boolean;
  maxCalls: number;
  error: string | undefined;
}

function parseArgs(argv: readonly string[]): Parsed {
  const out: Parsed = {
    run: undefined,
    runLlm: false,
    allowEgress: false,
    maxCalls: DEFAULT_MAX_CALLS,
    error: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const value = (name: string): string | undefined => {
      if (a === name) {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) {
          out.error = `${name} 需要一个值`;
          return undefined;
        }
        i++;
        return v;
      }
      if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
      return undefined;
    };
    if (a === '--run-llm') {
      out.runLlm = true;
      continue;
    }
    if (a === '--allow-egress') {
      out.allowEgress = true;
      continue;
    }
    const run = value('--run');
    if (run !== undefined) {
      out.run = run;
      continue;
    }
    const mc = value('--max-calls');
    if (mc !== undefined) {
      const n = parseDecimalUint(mc);
      if (n === undefined || n < 1 || n > MAX_CALLS_CEILING) {
        out.error = `--max-calls 需要 1..${MAX_CALLS_CEILING} 的十进制整数`;
      } else out.maxCalls = n;
      continue;
    }
    if (out.error === undefined) out.error = `未知参数:${a}`;
  }
  if (out.error === undefined) {
    if (out.run === undefined) out.error = '缺少 --run <run_id>';
    else if (out.runLlm && !out.allowEgress) {
      out.error = '--run-llm 必须同时给 --allow-egress:提案摘录将离开本机,发送给所选评审厂商';
    }
  }
  return out;
}

function outcomeExit(o: ProposalOutcome): number {
  // 厂商不可证明导致没评上(或干跑里没有任何可调用的跳):配置问题,fail-closed
  if (
    o.vendorUnknown &&
    (o.status === 'pending' ||
      (o.status === 'planned' && !o.hops.some((h) => h.result === 'planned:call')))
  ) {
    return ExitCode.FAIL_CLOSED;
  }
  switch (o.status) {
    case 'judged':
    case 'already_judged':
      return o.verdict === 'reject' || o.injectionSuspected === true
        ? ExitCode.CHECK_FAILED
        : ExitCode.OK;
    case 'pending':
      if (o.pending === 'cooldown') return ExitCode.NOT_RUN;
      if (o.pending === 'all_failed')
        return o.invalidOutput ? ExitCode.CHECK_FAILED : ExitCode.NOT_RUN;
      return ExitCode.OK; // no_cross_vendor:单厂商环境照常出提案,晋升时机械拒绝(决策 ⑩A)
    case 'not_run':
      return ExitCode.NOT_RUN;
    case 'planned':
      return ExitCode.OK;
  }
}

export function judgeExitCode(report: JudgeReport): number {
  const codes = report.outcomes.map(outcomeExit);
  if (report.budgetExhausted) codes.push(ExitCode.NOT_RUN);
  return combineExitCodes(codes);
}

function summarize(report: JudgeReport): string {
  return canonicalJson({
    run_id: report.runId,
    dry: report.dry,
    calls_made: report.callsMade,
    calls_limit: report.callsLimit,
    budget_exhausted: report.budgetExhausted,
    proposals: report.outcomes.map((o) => ({
      id: o.proposalId,
      status: o.status,
      ...(o.verdict !== undefined ? { verdict: o.verdict } : {}),
      ...(o.injectionSuspected !== undefined ? { injection_suspected: o.injectionSuspected } : {}),
      ...(o.pending !== undefined ? { judge_pending: o.pending } : {}),
      wrote: o.wrote,
      hops: o.hops.map((h) => ({ hop: h.hop, vendor: h.vendor, model: h.model, result: h.result })),
    })),
  });
}

export function createJudgeCommand(deps: JudgeCommandDeps = {}): CommandDef {
  const def: CommandDef = {
    name: 'judge',
    summary: '裁判:对 reflect 暂存的提案做跨厂商评审',
    phase: 'P1',
    ownerBlock: 'P1',
    flags: [
      { name: '--run <run_id>', description: '.state/reflect/<run_id>/ 下的 reflect 运行;必填' },
      { name: '--run-llm', description: '真跑:调用评审后端(须同时给 --allow-egress);缺省干跑' },
      { name: '--allow-egress', description: '同意把提案摘录发送给评审厂商' },
      { name: '--max-calls <n>', description: '本次最多调用后端次数,默认 5,上限 10' },
    ],
    async run(ctx: CommandContext): Promise<number> {
      const args = parseArgs(ctx.argv);
      if (args.error !== undefined || args.run === undefined) {
        ctx.stderr(`agent-kit judge: ${args.error ?? '参数错误'}\n`);
        return ExitCode.USAGE;
      }

      const live = args.runLlm && args.allowEgress;
      const loadedOverlay = await loadOverlay(ctx);
      if (!loadedOverlay.ok) {
        ctx.stderr('agent-kit judge: 覆盖层读取或校验失败\n'); // 不回显覆盖层内容
        return ExitCode.USAGE;
      }
      const overlay = loadedOverlay.overlay;
      if (live && deps.requireOverlayEgress !== false && !overlayAllowsEgress(overlay)) {
        ctx.stderr(
          'agent-kit judge: 覆盖层未同意外发(reflect.egress = true 才允许提案摘录离开本机);未调用、未写入\n',
        );
        return ExitCode.USAGE;
      }

      let redactor = deps.redactor;
      if (redactor === undefined) {
        try {
          redactor = createRedactor(
            {
              sensitive_words: overlay?.sensitive_words ?? [],
              timeout_ms: DEFAULT_JUDGE_REDACT_TIMEOUT_MS,
            },
            { internalDomains: overlay?.internal_domains ?? [] },
          );
        } catch {
          ctx.stderr('REDACT_FAIL_CLOSED reason=init\n');
          return ExitCode.FAIL_CLOSED;
        }
      }

      let backends: JudgeBackends;
      try {
        backends =
          (await deps.createBackends?.(ctx, { live, maxCalls: args.maxCalls, overlay })) ?? {};
      } catch {
        ctx.stderr('JUDGE_FAIL_CLOSED reason=internal\n');
        return ExitCode.FAIL_CLOSED;
      }
      if (args.runLlm && Object.keys(backends).length === 0) {
        ctx.stderr(
          'agent-kit judge: 没有可用的评审后端(本命令不自带后端,须由接线块注入);未调用、未写入\n',
        );
        return ExitCode.NOT_RUN;
      }

      let report: JudgeReport;
      const done: ProposalOutcome[] = [];
      const partial = (): void => {
        if (done.length === 0) return;
        ctx.stdout(
          summarize({
            runId: args.run as string,
            dry: !args.runLlm,
            callsMade: 0,
            callsLimit: args.maxCalls,
            budgetExhausted: false,
            outcomes: done,
          }),
        );
      };
      try {
        report = await runJudge(
          { io: ctx.io, redactor, backends, onOutcome: (o) => done.push(o) },
          { runId: args.run, dry: !args.runLlm, maxCalls: args.maxCalls },
        );
      } catch (e) {
        partial(); // 中途失败时仍告诉用户哪些提案已处理(已写盘)
        if (e instanceof JudgeRunNotFoundError) {
          ctx.stderr(`agent-kit judge: ${e.code}\n`);
          return ExitCode.USAGE;
        }
        if (
          e instanceof JudgeStateError ||
          e instanceof JudgeFailClosedError ||
          e instanceof JudgeProviderMismatchError ||
          e instanceof WriteDeniedError
        ) {
          // 只报稳定码:异常消息里不放任何提案/评审文本
          ctx.stderr(`JUDGE_FAIL_CLOSED reason=${e.code}\n`);
          return ExitCode.FAIL_CLOSED;
        }
        ctx.stderr('JUDGE_FAIL_CLOSED reason=internal\n');
        return ExitCode.FAIL_CLOSED;
      }

      ctx.stdout(summarize(report));
      for (const o of report.outcomes) {
        if (o.pending !== undefined) {
          ctx.stderr(`JUDGE_PENDING proposal=${o.proposalId} reason=${o.pending}\n`);
        }
        if (o.injectionSuspected === true) {
          ctx.stderr(`JUDGE_INJECTION_SUSPECTED proposal=${o.proposalId}\n`);
        }
      }
      return judgeExitCode(report);
    },
  };
  return def;
}

/** 默认接线:只在 live(--run-llm --allow-egress)时按覆盖层构造真实 CLI 后端;干跑返回 {}(不构造)。 */
function defaultCreateBackends(
  ctx: CommandContext,
  mode: { live: boolean; maxCalls: number; overlay: Overlay | undefined },
): JudgeBackends {
  if (!mode.live) return {};
  return buildCliBackends({
    ctx: ctx as EnvCommandContext,
    overlay: mode.overlay,
    now: () => new Date(),
    maxSpawns: mode.maxCalls,
  });
}

export const command: CommandDef = createJudgeCommand({ createBackends: defaultCreateBackends });
