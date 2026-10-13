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
import { DEFAULT_MAX_EVENT_BYTES } from '../signals/base-reader.js';
import { collect } from '../signals/collect.js';
import {
  createExcludePolicy,
  ExcludeConfigError,
  hasProtection,
  withSelfExclusion,
} from '../signals/exclude.js';
import { PipelineFailClosedError } from '../signals/pipeline.js';
import { DEFAULT_READERS } from '../signals/readers.js';
import type { ReaderRegistry } from '../signals/readers.js';
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
      let policy;
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

      const makeReader = deps.readers[args.agent];
      if (makeReader === undefined) {
        ctx.stderr(`agent-kit signals collect: agent ${args.agent} 的 reader 尚未接入\n`);
        return ExitCode.NOT_RUN;
      }

      let salt;
      let redactor;
      try {
        salt = await loadSalt(ctx.io, { create: !args.dry });
        redactor = createRedactor(
          {
            sensitive_words: overlay?.sensitive_words ?? [],
            timeout_ms: args.timeoutMs ?? DEFAULT_REDACT_TIMEOUT_MS,
          },
          { internalDomains: overlay?.internal_domains ?? [] },
        );
      } catch (e) {
        // 盐损坏 / 写出口拒绝 / 脱敏器无法构造:系统性错误,整次中止,不写任何信号
        const why =
          e instanceof SaltError ? e.code : e instanceof WriteDeniedError ? e.code : 'init';
        ctx.stderr(`REDACT_FAIL_CLOSED reason=${why}\n`);
        return ExitCode.FAIL_CLOSED;
      }

      let out;
      try {
        out = await collect({
          reader: makeReader(),
          source: args.source,
          io: ctx.io,
          dry: args.dry,
          redactor,
          policy,
          salt: salt.salt,
          fallbackVersion: args.cliVersion,
          maxEventBytes: args.maxEventBytes,
        });
      } catch (e) {
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
    },
  };
  return def;
}

export const command: CommandDef = createSignalsCollectCommand({ readers: DEFAULT_READERS });
