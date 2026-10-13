/**
 * 受控 LLM 出口(R0,contracts #28)。与 `src/io/exec.ts` 的 git 白名单**分开**:
 * 那边 env 只有 PATH、HOME 必须在 KIT_TMP 内;而 LLM CLI 要用真实 HOME 里的登录态,并且会把提示发给第三方。
 * 所以这里是一个独立的、更窄的出口,**只在调用方显式传入 `allowEgress: true` 时可用**。
 *
 * 约束(每一条都有测试,也有变异):
 * - 不经 shell(`shell:false`),参数是数组;二进制只能是 `claude` / `codex` / `pi`(裸名按 PATH 解析,
 *   或同名绝对路径),解析结果不得落在仓库内(防仓库里埋一个假 `claude`;`KIT_TMP` 内除外,给测试的假二进制用);
 * - env 走**名字白名单**,不继承整个环境;本模块**不读**进程环境(那只许经 paths.ts),调用方传入 `envSource`,
 *   这里只挑白名单里的名字。key/token 类变量默认不传,只能由 `passEnv` 点名(且必须是 `*_API_KEY` 形状);
 * - cwd 固定为 `<state>/reflect/cwd/`(空目录,权限 0700;运行前必须为空,运行后清掉子进程留下的东西),
 *   调用方无法指定 cwd——防止 CLI 自动发现 CLAUDE.md / AGENTS.md;
 * - 超时(SIGKILL 整个进程组)、stdout 上限 32KiB(超出即杀并标 `stdoutTruncated`)、stdin 上限 64KiB;
 * - 最大 spawn 次数由 `LlmSpawnBudget` 计数,超过即抛 `IO_LLM_SPAWN_LIMIT`,不 spawn。
 *
 * 已知残余(写进 contracts §12):真实 HOME 由 CLI 自己写它的会话日志等,不在 A5 零写入覆盖内;
 * 子进程若 `setsid` 脱离进程组则杀不到。**本文件不接任何真实 LLM CLI**,具体参数由 R3 的后端给。
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import type { IoContext } from './paths.js';
import { existsSync, readDir, realpathSync, statSync } from './read-fs.js';
import { mkdirp, remove } from './safe-fs.js';

export const LLM_BINARIES: readonly string[] = Object.freeze(['claude', 'codex', 'pi']);
export const LLM_STDOUT_MAX_BYTES = 32 * 1024;
export const LLM_STDERR_KEEP_BYTES = 4 * 1024;
export const LLM_STDIN_MAX_BYTES = 64 * 1024;
export const LLM_MAX_TIMEOUT_MS = 600_000;
export const LLM_MAX_SPAWNS = 10;
const MAX_ARGS = 64;
const MAX_ARG_BYTES = 8 * 1024;
const MAX_ENV_VALUE_BYTES = 4 * 1024;
const KILL_GRACE_MS = 500;

export type LlmExecDeniedCode =
  | 'IO_LLM_EGRESS_DENIED'
  | 'IO_LLM_BINARY_DENIED'
  | 'IO_LLM_ARGS_DENIED'
  | 'IO_LLM_ENV_DENIED'
  | 'IO_LLM_CWD_DENIED'
  | 'IO_LLM_SPAWN_LIMIT';

export class LlmExecDeniedError extends Error {
  readonly code: LlmExecDeniedCode;
  constructor(code: LlmExecDeniedCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// env 名字白名单
// ---------------------------------------------------------------------------

/** 能到达子进程的变量名(固定集合)。故意没有:任何 *_KEY / *_TOKEN / *_SECRET、*_BASE_URL、*_HOME 类路由变量、NODE_OPTIONS、LD_*、TERM。 */
export const LLM_ENV_ALLOW: readonly string[] = Object.freeze([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'TZ',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
]);
const LC_RE = /^LC_[A-Z_]{1,32}$/;
/** `passEnv` 只接受 `<NAME>_API_KEY` 形状;这样路由类变量(`*_BASE_URL`、`CODEX_HOME`…)与加载器类变量天然进不来。 */
const PASS_ENV_RE = /^[A-Z][A-Z0-9_]{0,48}_API_KEY$/;

function validValue(v: string): boolean {
  return !v.includes('\0') && Buffer.byteLength(v, 'utf8') <= MAX_ENV_VALUE_BYTES;
}

/**
 * 从 `source` 里按名字白名单挑变量,再加固定的 `NO_COLOR=1`。纯函数,不读进程环境。
 * `passEnv` 里的名字必须形如 `<NAME>_API_KEY`(由调用方在代码里写死,不来自配置)。
 */
export function filterLlmEnv(
  source: Readonly<Record<string, string | undefined>>,
  passEnv: readonly string[] = [],
  fallbackPath = '',
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || !(LLM_ENV_ALLOW.includes(name) || LC_RE.test(name))) continue;
    if (!validValue(value)) continue;
    out[name] = value;
  }
  for (const name of passEnv) {
    if (!PASS_ENV_RE.test(name)) {
      throw new LlmExecDeniedError('IO_LLM_ENV_DENIED', `passEnv 不接受该变量名:${name}`);
    }
    const v = source[name];
    if (v !== undefined && validValue(v)) out[name] = v;
  }
  if (out['HOME'] !== undefined && !path.isAbsolute(out['HOME'])) {
    throw new LlmExecDeniedError('IO_LLM_ENV_DENIED', 'HOME 必须是绝对路径');
  }
  if (out['PATH'] === undefined && fallbackPath !== '') out['PATH'] = fallbackPath;
  out['NO_COLOR'] = '1';
  return out;
}

// ---------------------------------------------------------------------------
// spawn 次数预算
// ---------------------------------------------------------------------------

/** 一次运行的 spawn 预算。`runLlm` 在每次 spawn 之前先消耗一次;耗尽即拒绝。 */
export class LlmSpawnBudget {
  readonly max: number;
  #used = 0;
  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1 || max > LLM_MAX_SPAWNS) {
      throw new LlmExecDeniedError(
        'IO_LLM_SPAWN_LIMIT',
        `spawn 预算必须是 1..${LLM_MAX_SPAWNS} 的整数`,
      );
    }
    this.max = max;
  }
  get used(): number {
    return this.#used;
  }
  consume(): void {
    if (this.#used >= this.max) {
      throw new LlmExecDeniedError('IO_LLM_SPAWN_LIMIT', `已达 spawn 次数上限 ${this.max}`);
    }
    this.#used++;
  }
}

// ---------------------------------------------------------------------------
// 二进制解析
// ---------------------------------------------------------------------------

function isExecutableFile(p: string): boolean {
  try {
    const st = statSync(p);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function within(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 名字叫 claude 却实际指向这些的符号链接一律拒 */
const SHELL_LIKE = [
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'env',
  'busybox',
  'python',
  'python3',
  'perl',
  'ruby',
];

function resolveBinary(ctx: IoContext, file: string, pathEnv: string): string {
  const deny = (m: string) => new LlmExecDeniedError('IO_LLM_BINARY_DENIED', m);
  if (file.includes('\0')) throw deny('二进制名含 NUL');
  let candidate: string | undefined;
  if (file.includes('/')) {
    if (!path.isAbsolute(file)) throw deny(`二进制必须是裸名或绝对路径:${file}`);
    if (!LLM_BINARIES.includes(path.basename(file))) {
      throw deny(`二进制不在白名单内:${path.basename(file)}(白名单:${LLM_BINARIES.join(', ')})`);
    }
    candidate = file;
  } else {
    if (!LLM_BINARIES.includes(file)) {
      throw deny(`二进制不在白名单内:${file}(白名单:${LLM_BINARIES.join(', ')})`);
    }
    for (const dir of pathEnv.split(path.delimiter)) {
      if (dir === '' || !path.isAbsolute(dir)) continue; // 空项/相对项 = 当前目录,不走
      const c = path.join(dir, file);
      if (isExecutableFile(c)) {
        candidate = c;
        break;
      }
    }
  }
  if (candidate === undefined || !isExecutableFile(candidate)) {
    throw deny(`找不到可执行的 ${file}`);
  }
  const real = realpathSync(candidate);
  if (SHELL_LIKE.includes(path.basename(real))) {
    throw deny(`二进制实际指向 ${path.basename(real)},拒绝`);
  }
  if (
    !LLM_BINARIES.includes(path.basename(real)) &&
    !LLM_BINARIES.includes(path.basename(candidate))
  ) {
    throw deny('二进制解析结果不在白名单内');
  }
  const inRepo = within(realpathSync(ctx.repoRoot), real);
  const inTmp =
    ctx.tmpDir !== undefined && existsSync(ctx.tmpDir) && within(realpathSync(ctx.tmpDir), real);
  if (inRepo && !inTmp) throw deny('二进制位于仓库内(只允许系统/用户安装位置;KIT_TMP 内除外)');
  // spawn 用解析出的路径(保持 argv[0] 语义,如包装脚本);落点与仓库的关系上面已按 realpath 判过
  return candidate;
}

// ---------------------------------------------------------------------------
// cwd
// ---------------------------------------------------------------------------

export function llmCwd(ctx: IoContext): string {
  return path.join(ctx.stateDir, 'reflect', 'cwd');
}

async function prepareCwd(ctx: IoContext): Promise<string> {
  const cwd = llmCwd(ctx);
  await mkdirp(ctx, cwd, 0o700);
  const entries = await readDir(cwd);
  if (entries.length > 0) {
    throw new LlmExecDeniedError(
      'IO_LLM_CWD_DENIED',
      `${cwd} 必须为空目录(现有 ${entries.length} 项)`,
    );
  }
  return realpathSync(cwd);
}

async function purgeCwd(ctx: IoContext): Promise<number> {
  const cwd = llmCwd(ctx);
  const entries = await readDir(cwd);
  for (const e of entries) await remove(ctx, path.join(cwd, e.name));
  return entries.length;
}

// ---------------------------------------------------------------------------
// runLlm
// ---------------------------------------------------------------------------

export interface LlmRequest {
  /** 必须是字面量 `true`。真跑路径由命令层在用户同时给 `--run-llm --allow-egress` 后才会置 true。 */
  allowEgress: true;
  /** `claude` / `codex` / `pi`(裸名,或同名绝对路径) */
  file: string;
  args: readonly string[];
  /** 经 stdin 传入(提示走这里,不走 argv),≤64KiB */
  input?: string;
  /** 可供挑选的环境变量来源(通常是 IoContext 提供的宿主环境);只有白名单里的名字会到达子进程 */
  envSource: Readonly<Record<string, string | undefined>>;
  /** 额外点名的 `<NAME>_API_KEY`,由调用方在代码里写死 */
  passEnv?: readonly string[];
  timeoutMs: number;
  budget: LlmSpawnBudget;
}

export interface LlmResult {
  status: number | null;
  signal: string | null;
  stdout: string;
  /** 只保留前 4KiB */
  stderr: string;
  timedOut: boolean;
  /** stdout 超过 32KiB:进程已被杀,stdout 只含前 32KiB,调用方应视为失败 */
  stdoutTruncated: boolean;
  /** 启动失败(如 ENOENT)的错误信息 */
  spawnError?: string;
  /** 运行后从固定 cwd 里清掉的、子进程留下的条目数 */
  cwdResidue: number;
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已经退出
    }
  }
}

export async function runLlm(ctx: IoContext, req: LlmRequest): Promise<LlmResult> {
  // 1) 出口开关:必须是显式的布尔 true(字符串 "true"、1 都不算)
  if ((req as { allowEgress?: unknown }).allowEgress !== true) {
    throw new LlmExecDeniedError('IO_LLM_EGRESS_DENIED', '未传 allowEgress:true,拒绝对外调用 LLM');
  }
  // 2) 参数与输入
  const timeoutMs = req.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > LLM_MAX_TIMEOUT_MS) {
    throw new LlmExecDeniedError('IO_LLM_ARGS_DENIED', `timeoutMs 必须是 1..${LLM_MAX_TIMEOUT_MS}`);
  }
  if (req.args.length > MAX_ARGS) {
    throw new LlmExecDeniedError('IO_LLM_ARGS_DENIED', `参数超过 ${MAX_ARGS} 个`);
  }
  for (const a of req.args) {
    if (typeof a !== 'string' || a.includes('\0') || Buffer.byteLength(a, 'utf8') > MAX_ARG_BYTES) {
      throw new LlmExecDeniedError('IO_LLM_ARGS_DENIED', '参数含 NUL、超长或不是字符串');
    }
  }
  const input = req.input;
  if (input !== undefined && Buffer.byteLength(input, 'utf8') > LLM_STDIN_MAX_BYTES) {
    throw new LlmExecDeniedError('IO_LLM_ARGS_DENIED', `stdin 超过 ${LLM_STDIN_MAX_BYTES} 字节`);
  }
  // 3) env 与二进制
  const env = filterLlmEnv(req.envSource, req.passEnv ?? [], ctx.execPath);
  const bin = resolveBinary(ctx, req.file, env['PATH'] ?? '');
  // 4) 固定 cwd
  const cwd = await prepareCwd(ctx);
  // 5) 预算:紧挨着 spawn 之前消耗
  req.budget.consume();

  const result = await new Promise<Omit<LlmResult, 'cwdResidue'>>((resolve) => {
    let child;
    try {
      child = spawn(bin, [...req.args], {
        cwd,
        env,
        shell: false,
        detached: true, // 独立进程组,超时/收尾时整组杀掉
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      resolve({
        status: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        stdoutTruncated: false,
        spawnError: (e as Error).message,
      });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    let spawnError: string | undefined;
    let exitStatus: number | null = null;
    let exitSignal: string | null = null;
    let settled = false;
    let grace: NodeJS.Timeout | undefined;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace !== undefined) clearTimeout(grace);
      killGroup(child.pid);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({
        status: exitStatus,
        signal: exitSignal,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
        stdoutTruncated: truncated,
        ...(spawnError !== undefined ? { spawnError } : {}),
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      const room = LLM_STDOUT_MAX_BYTES - outBytes;
      if (chunk.length > room) {
        if (room > 0) out.push(chunk.subarray(0, room));
        outBytes = LLM_STDOUT_MAX_BYTES;
        if (!truncated) {
          truncated = true;
          killGroup(child.pid);
        }
        return;
      }
      out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const room = LLM_STDERR_KEEP_BYTES - errBytes;
      if (room <= 0) return;
      err.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
      errBytes += Math.min(chunk.length, room);
    });
    child.stdin.on('error', () => {
      // 子进程没读完 stdin 就退出(EPIPE):不是我们的错误,结果由退出码体现
    });
    child.on('error', (e) => {
      spawnError = e.message;
      finish();
    });
    child.on('exit', (code, signal) => {
      exitStatus = code;
      exitSignal = signal;
      // 立刻杀整组收拾遗留的孙进程;管道里已有的数据仍可读完,再等 close(或宽限期)
      killGroup(child.pid);
      child.on('close', finish);
      grace = setTimeout(finish, KILL_GRACE_MS);
    });
    child.stdin.end(input ?? '');
  });

  const cwdResidue = await purgeCwd(ctx);
  return { ...result, cwdResidue };
}
