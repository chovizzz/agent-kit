import { parse as parseToml } from 'smol-toml';
import { OverlaySchema } from '../contracts/config.js';
import type { Overlay } from '../contracts/config.js';
import { AgentIdSchema } from '../contracts/common.js';
import type { AgentId } from '../contracts/common.js';
import { ExitCode } from '../contracts/exit-codes.js';
import { canonicalJson } from '../io/canonical-json.js';
import { MAX_LINE_BYTES, readText } from '../io/read-fs.js';
import { WriteDeniedError } from '../io/safe-fs.js';
import { createRedactor } from '../redact/redactor.js';
import { loadRsiConfig } from '../rsi/config.js';
import type { RsiConfig } from '../rsi/config.js';
import { createExcludeMatcher } from '../rsi/exclude-match.js';
import { RsiSnapshotBusyError, stableOf } from '../rsi/exit.js';
import { commitCollectUnderLock } from '../rsi/l0/commit-collect.js';
import { makeGate } from '../rsi/l0/commit.js';
import type { BeforeWrite } from '../rsi/l0/types.js';
import { RsiLockError } from '../rsi/lock.js';
import type { RsiLockHandle } from '../rsi/lock.js';
import { RsiSnapshotError } from '../rsi/snapshot-read.js';
import { recoverUnderLock } from '../rsi/services/commit.js';
import { hooksFromGate } from '../rsi/services/fixed-write.js';
import { observeRsi } from '../rsi/services/observe.js';
import { RsiStagingBlockedError } from '../rsi/services/staging.js';
import { assertNoPurgeInProgress, resumeTaintWith } from '../rsi/services/taint.js';
import { RsiFailClosedError } from '../rsi/types.js';
import type { RsiServiceCtx } from '../rsi/types.js';
import { withRsiLockIfGated } from '../rsi/with-lock.js';
import type { WithRsiLockIfGatedOptions } from '../rsi/with-lock.js';
import { DEFAULT_MAX_EVENT_BYTES } from '../signals/base-reader.js';
import { collect } from '../signals/collect.js';
import {
  createExcludePolicy,
  ExcludeConfigError,
  hasProtection,
  withSelfExclusion,
} from '../signals/exclude.js';
import type { ExcludePolicy } from '../signals/exclude.js';
import { PipelineFailClosedError } from '../signals/pipeline.js';
import { projectKeyFor } from '../signals/ids.js';
import { DEFAULT_READERS } from '../signals/readers.js';
import type { ReaderRegistry } from '../signals/readers.js';
import { readSaltFile } from '../signals/salt-read.js';
import { loadSalt, SaltError, SignalStoreError } from '../signals/state-store.js';
import { parseCliVersion } from '../signals/version.js';
import { parseDecimalUint } from './args.js';
import type { CommandContext, CommandDef } from './types.js';

/**
 * 脱敏每条每遍的时间预算。契约默认 50 ms 适合单条交互;批量采集时首次调用的规则编译与机器负载
 * 会让个别条目误超时(实测并行测试下 140 条里 2 条),而超时 = 丢整条 + 退出 3。
 * 取 250 ms:仍远低于 ReDoS 挂起的量级,又不把负载抖动当成脱敏失败。可用 --timeout-ms 覆盖。
 */
export const DEFAULT_REDACT_TIMEOUT_MS = 250;

interface Parsed {
  source: string | undefined;
  agent: AgentId | undefined;
  dry: boolean;
  allowProjects: string[];
  cliVersion: string | undefined;
  maxEventBytes: number;
  timeoutMs: number | undefined;
  error: string | undefined;
}

export { parseDecimalUint };

function parseArgs(argv: readonly string[]): Parsed {
  const out: Parsed = {
    source: undefined,
    agent: undefined,
    dry: false,
    allowProjects: [],
    cliVersion: undefined,
    maxEventBytes: DEFAULT_MAX_EVENT_BYTES,
    timeoutMs: undefined,
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
    if (a === '--dry') {
      out.dry = true;
      continue;
    }
    const source = value('--source');
    if (source !== undefined) {
      out.source = source;
      continue;
    }
    const agent = value('--agent');
    if (agent !== undefined) {
      const p = AgentIdSchema.safeParse(agent);
      if (p.success) out.agent = p.data;
      else out.error = `未知 agent:${agent}`;
      continue;
    }
    const allow = value('--allow-project');
    if (allow !== undefined) {
      out.allowProjects.push(allow);
      continue;
    }
    const ver = value('--cli-version');
    if (ver !== undefined) {
      const parsed = parseCliVersion(ver);
      if (parsed === undefined) out.error = '--cli-version 里找不到 X.Y.Z';
      else out.cliVersion = parsed;
      continue;
    }
    const mx = value('--max-event-bytes');
    if (mx !== undefined) {
      const n = parseDecimalUint(mx);
      if (n === undefined || n <= 0) out.error = '--max-event-bytes 需要十进制正整数';
      else if (n > MAX_LINE_BYTES)
        out.error = `--max-event-bytes 不得超过单行硬上限 ${MAX_LINE_BYTES}`;
      else out.maxEventBytes = n;
      continue;
    }
    const t = value('--timeout-ms');
    if (t !== undefined) {
      const n = parseDecimalUint(t);
      if (n === undefined || n <= 0) out.error = '--timeout-ms 需要十进制正整数';
      else out.timeoutMs = n;
      continue;
    }
    if (out.error === undefined) out.error = `未知参数:${a}`;
  }
  if (out.error === undefined) {
    if (out.source === undefined) out.error = '缺少 --source <路径>';
    else if (out.agent === undefined) out.error = '缺少 --agent <claude|codex|pi|kimi|…>';
  }
  return out;
}

export interface SignalsCollectDeps {
  readers: ReaderRegistry;
  /** 测试注入:缺省 `loadRsiConfig({ env: ctx.env })`(只读,不建任何目录)。`--dry` 不读 rsi 配置。 */
  rsiConfig?: () => Promise<RsiConfig>;
  /** 透传给 `withRsiLockIfGated`(`gate` / `lock`:时钟、pid、isAlive 等) */
  lockDeps?: WithRsiLockIfGatedOptions;
  /** 测试的写点故障注入点(只在 rsi 持锁路径生效):每个写操作之前先调它,再 `assertHeld()` */
  beforeWrite?: BeforeWrite;
  /** 测试缝:锁内、复检之前调用(演练「拿锁之后改配置」) */
  afterLock?: () => Promise<void> | void;
  /** 注入时钟(counts 的 `computed_at`、索引日期、清单 `written_at`) */
  now?: () => Date;
}

/** rsi 层抛出的错误:必须穿透命令内部的 `REDACT_FAIL_CLOSED` 映射,交给外层按 `RSI_*` 稳定码报 */
function isRsiError(e: unknown): boolean {
  return (
    e instanceof RsiLockError ||
    e instanceof RsiFailClosedError ||
    e instanceof RsiSnapshotError ||
    e instanceof RsiSnapshotBusyError ||
    e instanceof RsiStagingBlockedError
  );
}

export function createSignalsCollectCommand(deps: SignalsCollectDeps): CommandDef {
  const def: CommandDef = {
    name: 'signals collect',
    summary: '只读解析会话文件,输出归一化信号(--source <路径> --dry)',
    phase: 'P0',
    ownerBlock: 'B10b',
    flags: [
      { name: '--source <路径>', description: '会话目录或文件(只读打开);必填' },
      { name: '--agent <id>', description: 'claude|codex|pi|kimi;必填(选择 reader)' },
      { name: '--dry', description: '只输出计数、报告与脱敏摘录样例,不写 .state/' },
      {
        name: '--allow-project <名字|绝对路径>',
        description:
          '(可重复)只处理 cwd 匹配的项目。名字=cwd 的目录名精确相等;P0 默认拒绝运行,须给它或带 exclude_dirs 的 --overlay',
      },
      { name: '--cli-version <版本>', description: 'agent_version 兜底(会话里取不到时用)' },
      {
        name: '--max-event-bytes <n>',
        description: '单行超过此字节数时丢事件 text(计数不变);上限 64MiB(读行硬上限)',
      },
      { name: '--timeout-ms <n>', description: '脱敏每条每遍的时间预算,默认 250' },
    ],
    async run(ctx: CommandContext): Promise<number> {
      const args = parseArgs(ctx.argv);
      if (args.error !== undefined || args.source === undefined || args.agent === undefined) {
        ctx.stderr(`agent-kit signals collect: ${args.error ?? '参数错误'}\n`);
        return ExitCode.USAGE;
      }

      let overlay: Overlay | undefined;
      if (ctx.overlayPath !== undefined) {
        try {
          overlay = OverlaySchema.parse(parseToml(await readText(ctx.overlayPath)));
        } catch {
          // 不回显覆盖层内容:它本身就是敏感词表 / 客户目录清单
          ctx.stderr('agent-kit signals collect: 覆盖层读取或校验失败\n');
          return ExitCode.USAGE;
        }
      }
      const excludeDirs = overlay?.exclude_dirs ?? [];
      if (!hasProtection({ excludeDirs, allowProjects: args.allowProjects })) {
        ctx.stderr(
          'agent-kit signals collect: 默认拒绝运行:P0 须提供带非空 exclude_dirs 的 --overlay,' +
            '或显式 --allow-project <名字|绝对路径>(真实采样只限 social-ops-hub / skills-hub)\n',
        );
        return ExitCode.USAGE;
      }
      let policy: ExcludePolicy;
      try {
        // 先判「会话在本仓 .state/ 之下」(反思器自己的会话),再交给用户策略;不影响上面的默认拒绝判定
        policy = withSelfExclusion(
          await createExcludePolicy({ excludeDirs, allowProjects: args.allowProjects }),
          ctx.io.stateDir,
        );
      } catch (e) {
        if (e instanceof ExcludeConfigError) {
          ctx.stderr(`agent-kit signals collect: ${e.message}\n`);
          return ExitCode.USAGE;
        }
        throw e;
      }

      const source = args.source;
      const makeReader = deps.readers[args.agent];
      if (makeReader === undefined) {
        ctx.stderr(`agent-kit signals collect: agent ${args.agent} 的 reader 尚未接入\n`);
        return ExitCode.NOT_RUN;
      }

      // rsi 闸门(R20-A2 B5d):只有非 --dry 才读 rsi 配置、才可能拿 `rsi/lock`;`lockGate` 判 off(没有 `[rsi]` / 未启用 / 状态树确定独立)→ 与接线前逐字节一致
      const execute = async (lock: RsiLockHandle | null): Promise<number> => {
        // ---- rsi 持锁路径的锁内前置(lock === null 时整段不执行)
        let gate: BeforeWrite | undefined;
        let sctx: RsiServiceCtx | undefined;
        if (lock !== null) {
          await deps.afterLock?.();
          // ① 无副作用复检(直读,先于 recover):配置自拿锁前以来可能变了。仍是 on 才走 rsi 路径;变成 off → 退回现有流程(持着锁但不写 rsi 状态)
          const obs = await observeRsi(ctx.io, ctx.env);
          // 只要持着锁,所有写点(含盐首建 / 信号库 / 会话计数)都经 gate 做 assertHeld——配置复检变成 off 时也一样(只是不建服务层上下文、不提交 rsi 投影)
          gate = makeGate(lock, deps.beforeWrite);
          if (obs.config.status === 'on') {
            if (obs.state.stateInvalid) throw new RsiFailClosedError('state_invalid');
            // 排除清单 / 覆盖层不可用:无法叠加 [rsi] 排除,fail-closed(不写任何东西)
            if (obs.config.block !== null) throw new RsiFailClosedError(obs.config.block);
            sctx = {
              io: ctx.io,
              config: obs.config,
              ...(deps.now !== undefined ? { now: deps.now } : {}),
            };
            const hooks = hooksFromGate(gate);
            // ② 恢复未完成的提交 → ③ purge 进行中拒绝 → ④ taint 续做
            await recoverUnderLock(sctx, lock, hooks);
            await assertNoPurgeInProgress(sctx);
            await resumeTaintWith(sctx, lock, hooks);
          }
        }

        let salt;
        let redactor;
        try {
          // 盐首建在锁内(§20.9 第 8 条):rsi 持锁路径的写点经 gate;lock === null 时与接线前同一位置、同一参数
          salt = await loadSalt(ctx.io, {
            create: !args.dry,
            ...(gate !== undefined ? { beforeWrite: gate } : {}),
          });
          redactor = createRedactor(
            {
              sensitive_words: overlay?.sensitive_words ?? [],
              timeout_ms: args.timeoutMs ?? DEFAULT_REDACT_TIMEOUT_MS,
            },
            { internalDomains: overlay?.internal_domains ?? [] },
          );
        } catch (e) {
          if (isRsiError(e)) throw e; // 失锁等:不能被映射成盐错误
          // 盐损坏 / 写出口拒绝 / 脱敏器无法构造:系统性错误,整次中止,不写任何信号
          const why =
            e instanceof SaltError ? e.code : e instanceof WriteDeniedError ? e.code : 'init';
          ctx.stderr(`REDACT_FAIL_CLOSED reason=${why}\n`);
          return ExitCode.FAIL_CLOSED;
        }

        // 拍板 Q-F:rsi 持锁路径叠加 `[rsi]` 排除(只会多排除);同时记下被处理的项目根,供索引观测
        const seenRoots = new Set<string>();
        let effective: ExcludePolicy = policy;
        if (sctx !== undefined) {
          let matcher;
          try {
            matcher = await createExcludeMatcher(sctx.config);
          } catch {
            throw new RsiFailClosedError('exclude_invalid');
          }
          const inner = policy;
          effective = {
            async decide(cwdHint) {
              const d = await inner.decide(cwdHint);
              if (d.action !== 'process') return d;
              if (d.projectRoot !== undefined && (await matcher.matchesRoot(d.projectRoot))) {
                return { action: 'skip', reason: 'excluded' };
              }
              if (d.projectRoot !== undefined) seenRoots.add(d.projectRoot);
              return d;
            },
          };
        }

        let out;
        try {
          out = await collect({
            reader: makeReader(),
            source,
            io: ctx.io,
            dry: args.dry,
            redactor,
            policy: effective,
            salt: salt.salt,
            fallbackVersion: args.cliVersion,
            maxEventBytes: args.maxEventBytes,
            ...(gate !== undefined ? { beforeWrite: gate } : {}),
          });
        } catch (e) {
          if (isRsiError(e)) throw e; // gate 的 lock_lost 等
          if (e instanceof WriteDeniedError || e instanceof SignalStoreError) {
            ctx.stderr(`REDACT_FAIL_CLOSED reason=${e.code}\n`);
            return ExitCode.FAIL_CLOSED;
          }
          if (e instanceof PipelineFailClosedError) {
            // 排除判定 / 脱敏 / 信号校验抛错:无法证明安全,fail-closed;只报阶段与类名,不带异常内容
            ctx.stderr(`REDACT_FAIL_CLOSED reason=pipeline_${e.stage} class=${e.errorClass}\n`);
            return ExitCode.FAIL_CLOSED;
          }
          // 文件系统层面读不到 source 属于用法问题;其余(含 Signal 校验失败等内部不变量破坏)按 fail-closed
          const code = (e as { code?: unknown }).code;
          if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') {
            ctx.stderr('agent-kit signals collect: source 不可读\n');
            return ExitCode.USAGE;
          }
          ctx.stderr('REDACT_FAIL_CLOSED reason=internal\n');
          return ExitCode.FAIL_CLOSED;
        }

        // 提交(索引 / counts / 清单,同一把锁内):信号与会话计数已落盘,即使本次有脱敏丢弃 / 读失败也要把投影校正到磁盘现状
        if (lock !== null && sctx !== undefined && gate !== undefined && !args.dry) {
          let sr;
          try {
            sr = await readSaltFile(ctx.io.stateDir);
          } catch (e) {
            if (e instanceof SaltError) throw new RsiFailClosedError('salt_invalid');
            throw e;
          }
          if (sr.kind !== 'ok') throw new RsiFailClosedError('salt_invalid');
          const roots = new Map<string, string>();
          for (const r of seenRoots) roots.set(projectKeyFor(salt.salt, r), r);
          await commitCollectUnderLock(sctx, lock, {
            results: out.results,
            roots,
            saltFp: sr.saltFp,
            redactor,
            gate,
          });
        }

        // stdout 由显式字段组装:**不得**把 `out` 整体序列化(`out.results` 是内部类型,不进输出;test/signals/collect-rsi-lock.test.ts 钉住键集合)
        ctx.stdout(
          canonicalJson({
            report: out.report,
            sessions: out.sessions,
            samples: out.samples,
            excluded_self_sessions: out.excludedSelfSessions,
            salt: salt.persisted ? 'persisted' : 'ephemeral',
            dry: args.dry,
            ...(out.write
              ? { written: out.write.written, deduplicated: out.write.deduplicated }
              : {}),
            ...(out.statWrite
              ? {
                  session_stats: {
                    written: out.statWrite.written,
                    updated: out.statWrite.updated,
                    unchanged: out.statWrite.unchanged,
                    skipped_no_ts: out.statsSkippedNoTs,
                  },
                }
              : {}),
          }),
        );
        if (out.report.signals_dropped_redaction > 0) {
          // 只报原因计数,不含位置与内容
          ctx.stderr(
            `REDACT_FAIL_CLOSED dropped=${out.report.signals_dropped_redaction} reasons=${JSON.stringify(out.dropReasons)}\n`,
          );
          return ExitCode.FAIL_CLOSED;
        }
        if (out.readErrors > 0) {
          ctx.stderr(
            `SESSION_READ_FAILED count=${out.readErrors} classes=${JSON.stringify(out.readErrorClasses)}\n`,
          );
          return ExitCode.CHECK_FAILED;
        }
        return ExitCode.OK;
      };

      if (args.dry) return execute(null); // --dry:不读 rsi 配置、不拿锁
      try {
        const config =
          deps.rsiConfig !== undefined
            ? await deps.rsiConfig()
            : await loadRsiConfig(ctx.env !== undefined ? { env: ctx.env } : {});
        return await withRsiLockIfGated({ io: ctx.io, config }, execute, deps.lockDeps);
      } catch (e) {
        if (e instanceof RsiLockError) {
          const st = e.toStable();
          // 占用(`locked`)与超过 TTL 的占用(`locked_over_ttl`)对命令级都报 `locked`(D3);不抢占
          if (st.code === 'RSI_NOT_RUN') {
            ctx.stderr('SIGNALS_NOT_RUN reason=locked\n');
            return ExitCode.NOT_RUN;
          }
        }
        if (e instanceof RsiStagingBlockedError) {
          ctx.stderr(`RSI_FAIL_CLOSED reason=${e.reason}\n`);
          return e.exit;
        }
        if (isRsiError(e)) {
          const stable = stableOf(e);
          ctx.stderr(`${stable.line}\n`);
          return stable.exit;
        }
        throw e;
      }
    },
  };
  return def;
}

export const command: CommandDef = createSignalsCollectCommand({ readers: DEFAULT_READERS });
