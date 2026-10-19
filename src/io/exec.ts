/**
 * 唯一允许 import child_process 的文件。
 * - 不经 shell(execFile 语义):参数是数组,不拼接命令串。
 * - 默认 env 只有 PATH,**不继承 HOME**、不继承 XDG_* / CODEX_HOME 等;需要的变量由调用方在 opts.env 显式给。
 * - 二进制白名单:P0 只有 `git`。要加别的二进制 = 契约变更(主代理评审),不要在块内自己放开。
 * - env 键白名单:GIT_* / HOME / LANG / LC_* / TZ;HOME 的值必须在 KIT_TMP 之内(防指向真实 HOME)。
 * - 同步执行(确定性、测试好写)。
 * - `runSelf`(S7c-B,docs/contracts.md §19.7):独立导出,只 spawn 当前 `process.execPath` 去跑一份**已定位的本套件 `dist/cli.js`**,
 *   不是通用二进制放行;eslint 闸限定只有 `src/update/launcher.ts` 与 `test/update/launcher*.test.ts` 能引用它。
 */
import { spawn, spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEMVER_RE } from '../contracts/common.js';
import type { IoContext } from './paths.js';
import { existsSync, lstatSync, realpathSync } from './read-fs.js';

export const EXEC_ALLOWLIST: readonly string[] = ['git'];
const ENV_KEY_RE = /^(GIT_[A-Z0-9_]+|HOME|LANG|LC_[A-Z_]+|TZ)$/;

export class ExecDeniedError extends Error {
  readonly code = 'IO_EXEC_DENIED';
}

function assertExecAllowed(
  ctx: IoContext,
  file: string,
  env: Readonly<Record<string, string>>,
): void {
  if (!EXEC_ALLOWLIST.includes(file)) {
    throw new ExecDeniedError(`不在可执行白名单内:${file}(白名单:${EXEC_ALLOWLIST.join(', ')})`);
  }
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_KEY_RE.test(k)) throw new ExecDeniedError(`不允许传给子进程的环境变量:${k}`);
    if (k === 'HOME') {
      const home = path.resolve(v);
      const tmp = ctx.tmpDir;
      const rel = tmp === undefined ? undefined : path.relative(tmp, home);
      if (rel === undefined || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new ExecDeniedError('子进程的 HOME 必须指向 KIT_TMP 之内的目录');
      }
    }
  }
}

export interface ExecOptions {
  cwd?: string;
  /** 显式追加的环境变量;不会被默认值覆盖 */
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  input?: string;
  maxBufferBytes?: number;
}

export interface ExecResult {
  /** 进程退出码;被信号杀死或超时为 null */
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** 启动失败(如 ENOENT)的错误信息 */
  spawnError?: string;
}

export function runSync(
  ctx: IoContext,
  file: string,
  args: readonly string[],
  opts: ExecOptions = {},
): ExecResult {
  assertExecAllowed(ctx, file, opts.env ?? {});
  const r = spawnSync(file, [...args], {
    cwd: opts.cwd ?? ctx.repoRoot,
    // HOME 缺失时 git 会经 passwd 回退读真实 ~/.gitconfig,所以默认显式屏蔽全局/系统配置(调用方可覆盖)
    env: {
      PATH: ctx.execPath,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      ...opts.env,
    },
    input: opts.input,
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 60_000,
    maxBuffer: opts.maxBufferBytes ?? 16 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  return {
    status: r.status,
    signal: r.signal,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    timedOut,
    ...(r.error && !timedOut ? { spawnError: r.error.message } : {}),
  };
}

// ---------------------------------------------------------------------------
// runSelf:启动器专用(S7c-B)
// ---------------------------------------------------------------------------

/** 相对 HOME 的安装目录(与 home-fs 的 CURRENT_LINK_REL / install.ts 的 SHARE_REL 同一位置;此处不 import 它们,避免 exec 依赖写出口) */
const SHARE_REL_SEGS = ['.local', 'share', 'agent-kit'] as const;

/**
 * runSelf 子进程环境的**具名**白名单(不含 NODE_OPTIONS / NODE_PATH / LD_* / DYLD_* 等能注入代码的变量,也不用 `KIT_*` 前缀通配)。
 * `HOME` 不从调用方 env 取,强制等于已校验的 `home`;`KIT_LAUNCHED` 强制为 `1`;`TMPDIR` 在给了受控目录时以受控目录为准。
 */
export const RUN_SELF_ENV_KEYS: readonly string[] = [
  'PATH',
  'LANG',
  'TZ',
  'TMPDIR',
  'KIT_TMP',
  'KIT_STATE_DIR',
  'KIT_WRITE_ROOTS',
  'KIT_REAL_HOME_OVERRIDE',
  'KIT_PAYLOAD_DIR',
  'KIT_AUTO_UPDATE',
  'KIT_AUTO_SYNC',
  'KIT_UPDATE_REGISTRY',
  'KIT_UPDATE_PIN',
  'CI',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'BUILDKITE',
  'CIRCLECI',
  'TF_BUILD',
  'JENKINS_URL',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'NODE_USE_ENV_PROXY',
];
const RUN_SELF_ENV_RE = /^(LC_[A-Z_]+|GIT_[A-Z0-9_]+)$/;

/** 哪些键值得让启动器从 process.env 取一份(给 pickProcessEnv 用) */
export const RUN_SELF_ENV_PICK_RE = new RegExp(
  `^(${RUN_SELF_ENV_KEYS.join('|')}|KIT_LAUNCHED|HOME|LC_[A-Z_]+|GIT_[A-Z0-9_]+)$`,
);

export type SelfTarget =
  /** 用户命令:跑 `<home>/.local/share/agent-kit/current` 解析出的版本目录里的 dist/cli.js;`version` 给了就必须等于目录名(启动器已按它验过锚点) */
  | { kind: 'current'; version?: string }
  /** 引导版本(npm 全局安装的那份):本模块所在包的 dist/cli.js;只用来起后台 worker,信任不高于当前进程自己 */
  | { kind: 'self' }
  /** 安装冒烟:`<home>/.local/share/agent-kit/staging/st-<hex>` 里的 dist/cli.js,参数固定 `--version` */
  | { kind: 'candidate'; stagingAbs: string };

export interface RunSelfOptions {
  /** 已通过校验的 HOME(真实 HOME 或测试的假 HOME);current / candidate 的位置都由它推出,调用方不能指定脚本路径 */
  home: string;
  target: SelfTarget;
  /** 传给 dist/cli.js 的参数;candidate 模式忽略(固定 `--version`) */
  args: readonly string[];
  /** 环境来源(只取 {@link RUN_SELF_ENV_KEYS} 里的键与 LC_* / GIT_*);缺省空 */
  env?: Readonly<Record<string, string | undefined>>;
  /** 受控 TMPDIR(调用方已创建并验证);给了就覆盖 env 里的 TMPDIR */
  tmpDir?: string;
  /** 后台:detached、stdio 丢弃、不等待 */
  background?: boolean;
  timeoutMs?: number;
  /** 测试注入:Node 版本(判断 --use-env-proxy) */
  nodeVersion?: string;
}

export type RunSelfResult =
  | { spawned: false; reason: RunSelfRefusal }
  | { spawned: true; status: number | null; signal: string | null; stdout: string };

export type RunSelfRefusal =
  | 'current_not_link'
  | 'current_escape'
  | 'version_mismatch'
  | 'entry_invalid'
  | 'candidate_invalid'
  | 'self_invalid'
  | 'spawn_failed';

export class RunSelfDeniedError extends ExecDeniedError {}

/** `--use-env-proxy` 要 Node ≥ 24.5;代理变量存在(且 NODE_USE_ENV_PROXY 不是显式关闭)时才加 */
export function useEnvProxyFlag(
  env: Readonly<Record<string, string | undefined>>,
  nodeVersion: string,
): string[] {
  const m = /^(\d+)\.(\d+)\./.exec(nodeVersion);
  if (m === null) return [];
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (!(major > 24 || (major === 24 && minor >= 5))) return [];
  const off = env['NODE_USE_ENV_PROXY']?.trim().toLowerCase();
  if (off === '0' || off === 'false') return [];
  const hasProxy = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some(
    (k) => (env[k] ?? '') !== '',
  );
  return hasProxy || off === '1' || off === 'true' ? ['--use-env-proxy'] : [];
}

function isRegularFileNoLink(abs: string): boolean {
  try {
    const st = lstatSync(abs);
    return st.isFile() && !st.isSymbolicLink() && realpathSync(abs) === abs;
  } catch {
    return false;
  }
}

function inside(parentReal: string, childReal: string): string | undefined {
  const rel = path.relative(parentReal, childReal);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) {
    return undefined;
  }
  return rel;
}

function resolveEntry(opts: RunSelfOptions): { entry: string } | { reason: RunSelfRefusal } {
  const home = opts.home;
  if (!path.isAbsolute(home)) throw new RunSelfDeniedError('runSelf 的 home 必须是绝对路径');
  const base = path.join(home, ...SHARE_REL_SEGS);
  const t = opts.target;
  if (t.kind === 'current') {
    const link = path.join(base, 'current');
    let real: string;
    let versionsReal: string;
    try {
      if (!lstatSync(link).isSymbolicLink()) return { reason: 'current_not_link' };
      versionsReal = realpathSync(path.join(base, 'versions'));
      real = realpathSync(link);
    } catch {
      return { reason: 'current_escape' };
    }
    const name = inside(versionsReal, real);
    if (name === undefined || !SEMVER_RE.test(name)) return { reason: 'current_escape' };
    if (t.version !== undefined && t.version !== name) return { reason: 'version_mismatch' };
    const entry = path.join(real, 'dist', 'cli.js');
    return isRegularFileNoLink(entry) ? { entry } : { reason: 'entry_invalid' };
  }
  if (t.kind === 'candidate') {
    let stagingReal: string;
    let candReal: string;
    try {
      stagingReal = realpathSync(path.join(base, 'staging'));
      candReal = realpathSync(t.stagingAbs);
    } catch {
      return { reason: 'candidate_invalid' };
    }
    const name = inside(stagingReal, candReal);
    if (name === undefined || !/^st-[0-9a-f]{6,32}$/.test(name)) {
      return { reason: 'candidate_invalid' };
    }
    const entry = path.join(candReal, 'dist', 'cli.js');
    return isRegularFileNoLink(entry) ? { entry } : { reason: 'entry_invalid' };
  }
  // self:本模块所在包(dev = 仓库根,安装后 = 版本目录或 npm 全局目录)的 dist/cli.js
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6 && !existsSync(path.join(dir, 'package.json')); i++) {
    dir = path.dirname(dir);
  }
  let rootReal: string;
  try {
    rootReal = realpathSync(dir);
  } catch {
    return { reason: 'self_invalid' };
  }
  const entry = path.join(rootReal, 'dist', 'cli.js');
  return isRegularFileNoLink(entry) ? { entry } : { reason: 'self_invalid' };
}

function childEnv(opts: RunSelfOptions): Record<string, string> {
  const out: Record<string, string> = {};
  const src = opts.env ?? {};
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue;
    if (RUN_SELF_ENV_KEYS.includes(k) || RUN_SELF_ENV_RE.test(k)) out[k] = v;
  }
  out['HOME'] = opts.home;
  out['KIT_LAUNCHED'] = '1';
  if (opts.tmpDir !== undefined) out['TMPDIR'] = opts.tmpDir;
  return out;
}

/**
 * 启动器专用:用 `process.execPath` 跑一份本套件的 `dist/cli.js`。脚本路径由本函数按 target 解析并 realpath 校验
 * (版本目录必须是 `versions/` 的直接子目录且名字是 semver、dist/cli.js 是普通文件且路径链无符号链接;冒烟候选必须是
 * `staging/st-<hex>` 的直接子目录),spawn 的是解析后的真实路径而不是 `current` 链接。
 * 不经 shell、不继承 execArgv / NODE_OPTIONS;环境见 {@link RUN_SELF_ENV_KEYS}。
 * 前台:stdio 继承,同步等待;后台:detached + stdio 丢弃,立即返回;candidate:stdio 管道、固定 `--version`、有超时。
 */
export function runSelf(opts: RunSelfOptions): RunSelfResult {
  const resolved = resolveEntry(opts);
  if ('reason' in resolved) return { spawned: false, reason: resolved.reason };
  const env = childEnv(opts);
  const nodeVersion = opts.nodeVersion ?? process.versions.node;
  const execArgv = useEnvProxyFlag(opts.env ?? {}, nodeVersion);
  const t = opts.target;
  const args = t.kind === 'candidate' ? ['--version'] : [...opts.args];
  if (opts.background === true) {
    try {
      const child = spawn(process.execPath, [...execArgv, resolved.entry, ...args], {
        env,
        stdio: 'ignore',
        detached: true,
        shell: false,
        windowsHide: true,
      });
      child.on('error', () => undefined);
      child.unref();
      return { spawned: true, status: null, signal: null, stdout: '' };
    } catch {
      return { spawned: false, reason: 'spawn_failed' };
    }
  }
  const r = spawnSync(process.execPath, [...execArgv, resolved.entry, ...args], {
    env,
    shell: false,
    windowsHide: true,
    ...(t.kind === 'candidate'
      ? {
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: opts.timeoutMs ?? 15_000,
          maxBuffer: 65_536,
        }
      : { stdio: 'inherit', ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}) }),
    encoding: 'utf8',
  });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (r.error !== undefined && code !== 'ETIMEDOUT')
    return { spawned: false, reason: 'spawn_failed' };
  return {
    spawned: true,
    status: code === 'ETIMEDOUT' ? null : r.status,
    signal: r.signal,
    stdout: typeof r.stdout === 'string' ? r.stdout : '',
  };
}
