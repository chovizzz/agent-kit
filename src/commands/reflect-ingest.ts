/**
 * `agent-kit reflect --ingest - --digest <id> --agent <a> --owner @h [--json]`(docs/contracts.md §20.16-3,R20-16.14 ~ R20-16.17;R20-A4)的命令层。
 *
 * 命令层只做:严格参数(与其它 reflect 模式互斥)→ 读 stdin(> 64KiB 退出 1 `RSI_INGEST_TOO_LARGE`,**不拿锁、不动 digest、不占名额**)→ `openRsiIo`
 * (rsi 的权威状态树恒取 `[rsi] repo`;**不**用「锁闸判独立就当 off」的旧写入方口径)→ 只读预检(拒绝路径零写入)→ 取 `rsi/lock`(试锁,拿不到 `locked`)→ `runIngest`。
 * 输出:`--json` 键集合固定 `{result: ok|rejected|not_run, reason, run_id, proposals}`(`run_id` 与 `proposals` 只在 `ok` 时非空);stderr 只有稳定码。
 */
import { ExitCode } from '../contracts/exit-codes.js';
import {
  RSI_AGENT_IDS,
  RSI_INGEST_MAX_STDIN_BYTES,
  type RsiAgentId,
  type RsiIngestRejectReason,
} from '../contracts/rsi.js';
import { canonicalJson } from '../io/canonical-json.js';
import { failExit } from '../rsi/exit.js';
import { ownerOk, runIngest, type IngestDeps, type IngestOutcome } from '../rsi/ingest.js';
import { RsiLockError, withRsiLock } from '../rsi/lock.js';
import { utcToday } from '../rsi/session.js';
import { observeSessionFacts, stateGate } from '../rsi/session-facts.js';
import { invalidateForFacts } from '../rsi/session-invalidate.js';
import { openRsiIo } from '../rsi/services/open.js';
import type { OpenRsiIoDeps } from '../rsi/services/open.js';
import { resolveReadStdin, type CommandContext } from './types.js';

/** 命令层从 reflect 的参数解析里拿到的 ingest 形状 */
export interface IngestArgs {
  /** `--ingest` 的值(契约只接受 `-`) */
  ingestValue: string;
  digest: string | undefined;
  agents: readonly string[];
  owner: string | undefined;
  json: boolean;
  /** 出现过与 ingest 互斥的参数(`--run-llm` / `--gc` / `--since` …) */
  conflict: boolean;
}

/** 测试注入点 */
export interface IngestCommandDeps {
  clock?: () => Date;
  open?: OpenRsiIoDeps;
  /** 透传给 `runIngest` 的注入(时钟以外):脱敏器、探测、槽位 / 名额 / 服务钩子、确定性钩子 */
  ingest?: Partial<Omit<IngestDeps, 'io' | 'lock' | 'env' | 'now' | 'teamProjectKeys'>>;
  /** 覆盖层 `reflect.team_project_keys`(层判定白名单;命令层读 `--overlay` 后传入) */
  teamProjectKeys?: ReadonlySet<string>;
  lockDeps?: Parameters<typeof withRsiLock>[2];
}

const usage = (ctx: CommandContext, reason: string): number => {
  ctx.stderr(`RSI_USAGE reason=${reason}\n`);
  return ExitCode.USAGE;
};

interface JsonDoc {
  result: 'ok' | 'rejected' | 'not_run';
  reason: string | null;
  run_id: string | null;
  proposals: string[];
}

function emit(ctx: CommandContext, json: boolean, doc: JsonDoc): void {
  if (json) ctx.stdout(canonicalJson(doc));
  else if (doc.result === 'ok') {
    ctx.stdout(
      `reflect ingest: ok run=${doc.run_id ?? '-'} proposals=${doc.proposals.join(',')}\n`,
    );
  }
}

function report(ctx: CommandContext, json: boolean, o: IngestOutcome): number {
  switch (o.kind) {
    case 'ok':
      emit(ctx, json, { result: 'ok', reason: null, run_id: o.runId, proposals: o.proposals });
      return ExitCode.OK;
    case 'rejected':
      ctx.stderr(`RSI_INGEST_REJECTED reason=${o.reason}\n`);
      emit(ctx, json, { result: 'rejected', reason: o.reason, run_id: null, proposals: [] });
      return ExitCode.CHECK_FAILED;
    case 'not_run':
      ctx.stderr(
        o.code === 'RSI_STAGING_FULL' ? 'RSI_STAGING_FULL\n' : `${o.code} reason=${o.reason}\n`,
      );
      emit(ctx, json, { result: 'not_run', reason: o.reason, run_id: null, proposals: [] });
      return o.exit;
  }
}

export async function runReflectIngest(
  ctx: CommandContext,
  a: IngestArgs,
  deps: IngestCommandDeps = {},
): Promise<number> {
  if (a.conflict) return usage(ctx, 'mode_conflict');
  if (a.ingestValue !== '-') return usage(ctx, 'unknown_arg');
  if (a.digest === undefined) return usage(ctx, 'missing:--digest');
  if (a.agents.length === 0) return usage(ctx, 'missing:--agent');
  if (a.agents.length > 1) return usage(ctx, 'unknown_arg');
  const agent = a.agents[0] as string;
  if (!(RSI_AGENT_IDS as readonly string[]).includes(agent)) return usage(ctx, 'bad_agent');
  if (a.owner === undefined) return usage(ctx, 'missing:--owner');
  if (!ownerOk(a.owner)) return usage(ctx, 'unknown_arg');
  const agentId = agent as RsiAgentId;

  // 先读 stdin;> 64KiB → 退出 1,不拿锁、不动 digest、不占名额
  const stdin = await resolveReadStdin(ctx)(RSI_INGEST_MAX_STDIN_BYTES);
  if (stdin.tooLarge) {
    ctx.stderr('RSI_INGEST_TOO_LARGE\n');
    emit(ctx, a.json, {
      result: 'rejected',
      reason: 'output_too_large' satisfies RsiIngestRejectReason,
      run_id: null,
      proposals: [],
    });
    return ExitCode.CHECK_FAILED;
  }

  const clock = deps.clock ?? ((): Date => new Date());
  try {
    const open = await openRsiIo(
      {
        argv: [],
        overlayPath: undefined,
        explicitRoot: undefined,
        ...(ctx.env !== undefined ? { env: ctx.env } : {}),
        ...(ctx.io.writeAudit !== undefined ? { writeAudit: ctx.io.writeAudit } : {}),
        stdout: () => undefined,
        stderr: () => undefined,
      },
      deps.open,
    );
    if (open.kind === 'off') return report(ctx, a.json, notRun('off'));
    if (open.kind === 'usage') return usage(ctx, open.reason);
    const { io } = open.ctx;

    // 只读预检:拒绝路径零写入(拿锁会建 rsi/ 与锁文件)。权威判定在锁内的 runIngest 第 1 步重做
    const today = utcToday(clock());
    const pre = await observeSessionFacts(io, ctx.env, agentId, today);
    const gate = stateGate(pre);
    if (gate !== null) return report(ctx, a.json, notRun(gate));
    if (pre.judgement?.kind === 'denied') {
      await invalidateForFacts(io, pre, agentId, deps.ingest?.slots ?? {});
      return report(ctx, a.json, {
        kind: 'not_run',
        code: 'RSI_SESSION_DENIED',
        reason: pre.judgement.reason,
        exit: 4,
      });
    }
    if (pre.journalPresent) return report(ctx, a.json, notRun('purge_pending'));

    const outcome = await withRsiLock(
      io,
      (lock) =>
        runIngest(
          {
            digestId: a.digest as string,
            agent: agentId,
            owner: a.owner as string,
            raw: stdin.text,
          },
          {
            ...(deps.ingest ?? {}),
            io,
            lock,
            env: ctx.env,
            now: clock,
            ...(deps.teamProjectKeys !== undefined
              ? { teamProjectKeys: deps.teamProjectKeys }
              : {}),
          },
        ),
      deps.lockDeps,
    );
    return report(ctx, a.json, outcome);
  } catch (e) {
    // 锁被占是常见的预期拒绝(退出 4):同样给出 --json 的固定结果对象;其它异常只有 stderr 稳定码
    if (e instanceof RsiLockError && (e.kind === 'locked' || e.kind === 'locked_over_ttl')) {
      return report(ctx, a.json, notRun('locked'));
    }
    return failExit(ctx.stderr, e);
  }
}

const notRun = (reason: string): IngestOutcome => ({
  kind: 'not_run',
  code: 'RSI_NOT_RUN',
  reason,
  exit: 4,
});
