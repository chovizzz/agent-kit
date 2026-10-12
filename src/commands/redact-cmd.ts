import { parse as parseToml } from 'smol-toml';
import { ExitCode } from '../contracts/exit-codes.js';
import { OverlaySchema } from '../contracts/config.js';
import type { Overlay } from '../contracts/config.js';
import { readText } from '../io/read-fs.js';
import { chunkForCheck } from '../redact/chunk.js';
import { neutralizePlaceholderMarkers } from '../redact/placeholder.js';
import { createRedactor } from '../redact/redactor.js';
import type { RedactorInput } from '../redact/redactor.js';
import { runSelftest } from '../redact/selftest.js';
import type { CommandContext, CommandDef } from './types.js';

/** `--stdin` 单次最多读多少字节;超过一律 fail-closed(不是截断后继续)。 */
export const STDIN_LIMIT_BYTES = 16 * 1024 * 1024;

export interface RedactCommandDeps {
  readStdin(limitBytes: number): Promise<string>;
}

async function defaultReadStdin(limitBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > limitBytes) throw new StdinTooLarge();
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

class StdinTooLarge extends Error {}

interface Parsed {
  selftest: boolean;
  mutate: boolean;
  stdin: boolean;
  check: boolean;
  allowHosts: string[];
  timeoutMs: number | undefined;
  error: string | undefined;
}

function parseArgs(argv: readonly string[]): Parsed {
  const out: Parsed = {
    selftest: false,
    mutate: false,
    stdin: false,
    check: false,
    allowHosts: [],
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
    if (a === '--selftest') out.selftest = true;
    else if (a === '--mutate') out.mutate = true;
    else if (a === '--stdin') out.stdin = true;
    else if (a === '--check') out.check = true;
    else {
      const host = value('--allow-host');
      if (host !== undefined) {
        out.allowHosts.push(host);
        continue;
      }
      const t = value('--timeout-ms');
      if (t !== undefined) {
        const n = Number(t);
        if (!Number.isInteger(n) || n <= 0) out.error = '--timeout-ms 需要正整数';
        else out.timeoutMs = n;
        continue;
      }
      if (out.error === undefined) out.error = `未知参数:${a}`;
    }
  }
  if (out.error === undefined) {
    if (!out.selftest && !out.stdin) out.error = '需要 --selftest 或 --stdin 之一';
    else if (out.selftest && out.stdin) out.error = '--selftest 与 --stdin 不能同时用';
    else if (out.mutate && !out.selftest) out.error = '--mutate 只能与 --selftest 一起用';
    else if (out.check && !out.stdin) out.error = '--check 只能与 --stdin 一起用';
  }
  return out;
}

async function loadOverlay(path: string): Promise<Overlay> {
  const raw = await readText(path);
  return OverlaySchema.parse(parseToml(raw));
}

export function createRedactCommand(deps: RedactCommandDeps): CommandDef {
  const def: CommandDef = {
    name: 'redact',
    summary: '脱敏:--selftest 跑种子集,--stdin 处理输入',
    phase: 'P0',
    ownerBlock: 'B09',
    flags: [
      { name: '--selftest', description: '跑种子集自检(第一遍替换 + 第二遍复扫),失败退出 1' },
      { name: '--mutate', description: '与 --selftest 合用:逐条禁用规则,断言恰有声明过的种子变红' },
      { name: '--stdin', description: '从标准输入读文本,输出脱敏结果;残留/异常/超时退出 3' },
      { name: '--check', description: '与 --stdin 合用:只复扫不输出;干净 0,有命中 1,异常/超时 3' },
      { name: '--allow-host <host>', description: '(可重复)URL 主机允许名单,精确或子域匹配' },
      { name: '--timeout-ms <n>', description: '每条输入每一遍的时间预算,默认 50' },
    ],
    async run(ctx: CommandContext): Promise<number> {
      const args = parseArgs(ctx.argv);
      if (args.error !== undefined) {
        ctx.stderr(`agent-kit redact: ${args.error}\n`);
        return ExitCode.USAGE;
      }

      if (args.selftest) {
        const res = runSelftest({ mutate: args.mutate });
        ctx.stdout(`${res.lines.join('\n')}\n`);
        return res.exitCode;
      }

      // --stdin
      let overlay: Overlay | undefined;
      if (ctx.overlayPath !== undefined) {
        try {
          overlay = await loadOverlay(ctx.overlayPath);
        } catch {
          // 不回显任何覆盖层内容:它本身就是敏感词表
          ctx.stderr('agent-kit redact: 覆盖层读取或校验失败\n');
          return ExitCode.USAGE;
        }
      }
      const input: RedactorInput = {
        sensitive_words: overlay?.sensitive_words ?? [],
        allowed_url_hosts: args.allowHosts,
        ...(args.timeoutMs !== undefined ? { timeout_ms: args.timeoutMs } : {}),
      };
      const redactor = createRedactor(input, { internalDomains: overlay?.internal_domains ?? [] });

      let text: string;
      try {
        text = await deps.readStdin(STDIN_LIMIT_BYTES);
      } catch {
        ctx.stderr('REDACT_FAIL_CLOSED reason=error (stdin 读取失败或超过上限)\n');
        return ExitCode.FAIL_CLOSED;
      }

      if (args.check) {
        let code: number = ExitCode.OK;
        const chunks = chunkForCheck(text, 65536, 2048);
        for (const [n, c] of chunks.entries()) {
          const d = redactor.pass2Detail(c.text);
          if (d.failure !== undefined) {
            ctx.stderr(`REDACT_FAIL_CLOSED reason=${d.failure} chunk=${n}\n`);
            return ExitCode.FAIL_CLOSED;
          }
          for (const h of d.hits) {
            code = ExitCode.CHECK_FAILED;
            ctx.stderr(`REDACT_HIT rule=${h.rule} type=${h.type} offset=${c.start + h.start}\n`);
          }
        }
        return code;
      }

      // 与 `signals collect` 的 makeExcerpt 同一步预处理:原文里的占位符标记先拆开,当普通文本扫描
      // (--check 不拆:它复扫的是 collect 的输出,里面的合法占位符须按占位符看,与 collect 末尾的 pass2 同视图)
      const res = redactor.apply(neutralizePlaceholderMarkers(text));
      if (!res.ok) {
        ctx.stderr(`REDACT_FAIL_CLOSED reason=${res.reason}\n`);
        return ExitCode.FAIL_CLOSED;
      }
      ctx.stdout(res.text);
      return ExitCode.OK;
    },
  };
  return def;
}

export const command: CommandDef = createRedactCommand({ readStdin: defaultReadStdin });
