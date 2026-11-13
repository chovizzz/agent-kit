/**
 * 受限的只读 git 适配器(contracts §21.24 W0-22 第 6 条、W0-24;实现 {@link RecordedReadPort})。零写入审计里对 `rsi show`、`rsi auto clear` 干跑、
 * `rsi rollback --to` 干跑的**唯一**子进程出口:业务模块的闭包仍禁 exec / safe-fs / home-fs / 锁,只有本文件经注入的 spawn 起 git,且本文件自己的闭包没有任何写出口
 * (配置预检只用 `read-fs` 的只读调用)。spawn 是注入端口(生产 = `runGitClosed`,在 `src/rsi/auto/deps.ts` 装配;测试用间谍记录 argv / env / cwd)。
 *
 * 唯一允许的三种调用(argv 数组,`shell:false`,git 绝对路径由装配传入、不查 PATH;`<FIXED>` 逐项等值校验):
 *   ① `git <FIXED> rev-parse --verify --quiet --end-of-options <oid>^{commit}`
 *   ② `git <FIXED> ls-tree -r -z --full-tree --end-of-options <oid>`
 *   ③ `git <FIXED> cat-file blob <oid>`
 * `<oid>` 必须是 40 位小写十六进制;无路径参数、无 `--`、无 revision 表达式、无额外参数;**不新增第四种形状**。
 * 仓库 = 显式 `--git-dir=<ABS>`(不做隐式发现,cwd 固定为 `<ABS>`);env 从空对象构造,只含封闭清单。
 *
 * **保证边界**:零写入**只在读取期间没有其它程序修改该仓库配置时成立**。kit 自身的写者(worker 与各写命令)都持 `personal/lock` 改仓库且不改 config;
 * 只读命令不持锁,所以该保证的前提是「kit 不写 config、外部不并发改 config」。并发修改 config 不在保证范围;每次读取前的配置预检与返回后的复核
 * **只算检测并拒收结果(`unreadable`),不构成零写入证明**——本文件、契约与命令文案都不得把它表述为零写入证明。
 * `GIT_NO_LAZY_FETCH` 照设,但不是「无惰性抓取」的证明前提;不设最低 git 版本。
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { lstat, readDir, readFileSafe, realpath } from '../../../io/read-fs.js';
import type {
  RecordedRead,
  RecordedReadPort,
  RecordedTreeEntry,
  RecordedWhy,
} from './recorded-port.js';

const OID_RE = /^[0-9a-f]{40}$/;
export const GIT_CONFIG_MAX_BYTES = 64 * 1024;
export const GIT_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
export const GIT_CALL_TIMEOUT_MS = 10_000;
export const GIT_BLOB_MAX_COUNT = 512;
export const GIT_BLOB_MAX_TOTAL_BYTES = 8 * 1024 * 1024;

export interface GitSpawnOptions {
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxBufferBytes: number;
}
export interface GitSpawnResult {
  status: number | null;
  stdout: string;
  timedOut: boolean;
  spawnError?: string | undefined;
}
/** 注入的 spawn 端口(生产 = `runGitClosed`,同步;允许返回 Promise 以便测试在 spawn 期间演练「配置被改」) */
export type GitSpawn = (
  file: string,
  argv: readonly string[],
  opts: GitSpawnOptions,
) => GitSpawnResult | Promise<GitSpawnResult>;

// ---------------------------------------------------------------------------
// argv 与 env 的形状
// ---------------------------------------------------------------------------
export class GitArgvError extends Error {
  readonly code = 'RSI_GIT_ARGV';
}

/** `<FIXED>`:顺序固定、逐项等值校验 */
export function fixedGitArgv(gitDir: string): string[] {
  return [
    '--no-pager',
    '--no-replace-objects',
    `--git-dir=${gitDir}`,
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.alternateRefsCommand=',
    '-c',
    'protocol.allow=never',
    '-c',
    'core.untrackedCache=false',
  ];
}

/** 三种形状之外一律抛 {@link GitArgvError}(含:`<FIXED>` 不等值、oid 非 40 位小写十六进制、多 / 少参数、第四种操作) */
export function assertReadOnlyGitArgv(argv: readonly string[], gitDir: string): void {
  const fixed = fixedGitArgv(gitDir);
  if (argv.length <= fixed.length || fixed.some((f, i) => argv[i] !== f)) {
    throw new GitArgvError('fixed_prefix_mismatch');
  }
  const t = argv.slice(fixed.length);
  const oidAt = (s: string | undefined, suffix = ''): boolean =>
    s !== undefined && s.endsWith(suffix) && OID_RE.test(s.slice(0, s.length - suffix.length));
  const ok =
    (t.length === 5 &&
      t[0] === 'rev-parse' &&
      t[1] === '--verify' &&
      t[2] === '--quiet' &&
      t[3] === '--end-of-options' &&
      oidAt(t[4], '^{commit}')) ||
    (t.length === 6 &&
      t[0] === 'ls-tree' &&
      t[1] === '-r' &&
      t[2] === '-z' &&
      t[3] === '--full-tree' &&
      t[4] === '--end-of-options' &&
      oidAt(t[5])) ||
    (t.length === 3 && t[0] === 'cat-file' && t[1] === 'blob' && oidAt(t[2]));
  if (!ok) throw new GitArgvError('shape_mismatch');
}

export const GIT_DEFAULT_PATH = '/usr/bin:/bin';

/** 封闭 env:从空对象构造,恰好这 12 个键 */
export function closedGitEnv(
  gitDir: string,
  pathValue: string = GIT_DEFAULT_PATH,
): Record<string, string> {
  return {
    PATH: pathValue,
    HOME: gitDir,
    LC_ALL: 'C',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_ALLOW_PROTOCOL: '',
  };
}

/** env 必须与封闭清单逐键逐值相等(多一键 / 缺一键 / 值不同都抛) */
export function assertClosedEnv(
  env: Readonly<Record<string, string>>,
  gitDir: string,
  pathValue: string = GIT_DEFAULT_PATH,
): void {
  const want = closedGitEnv(gitDir, pathValue);
  const a = Object.keys(env).sort();
  const b = Object.keys(want).sort();
  if (a.length !== b.length || a.some((k, i) => k !== b[i] || env[k] !== want[k])) {
    throw new GitArgvError('env_mismatch');
  }
}

// ---------------------------------------------------------------------------
// 配置预检(文件读取,非 git 子进程;每次读取前执行)
// ---------------------------------------------------------------------------
const CONFIG_SECTIONS = new Set([
  'core',
  'remote',
  'branch',
  'gc',
  'pack',
  'user',
  'init',
  'extensions',
]);
const REJECT_SECTIONS = new Set(['include', 'includeif']);
const REJECT_KEYS = new Set(['promisor', 'partialclonefilter']);
const SECTION_RE = /^\[([A-Za-z][A-Za-z0-9-]*)(?: "([^\\"]*)")?\]$/;
const KEY_RE = /^([A-Za-z][A-Za-z0-9-]*)[ \t]*=(.*)$/;

/** 严格子集解析:`true` = 可接受。只允许空行、注释、白名单段头、`key = value`(value 不含 `\`、引号、反引号) */
export function configAcceptable(text: string): boolean {
  let section: string | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[')) {
      const m = SECTION_RE.exec(line);
      if (m === null) return false;
      const name = (m[1] as string).toLowerCase();
      if (REJECT_SECTIONS.has(name) || !CONFIG_SECTIONS.has(name)) return false;
      section = name;
      continue;
    }
    const k = KEY_RE.exec(line);
    if (k === null || section === null) return false;
    const key = (k[1] as string).toLowerCase();
    const value = k[2] as string;
    if (/[\\"`]/.test(value) || value.includes('\r')) return false;
    if (REJECT_KEYS.has(key)) return false;
    if (section === 'extensions' && key !== 'objectformat') return false;
  }
  return true;
}

export type Preflight = { ok: true; digest: string } | { ok: false; why: RecordedWhy };

const EXISTENCE_REJECT = [
  'config.worktree',
  '.gitconfig',
  '.config/git',
  'objects/info/alternates',
  'info/grafts',
  'commondir',
];

async function present(p: string): Promise<boolean | 'error'> {
  try {
    await lstat(p);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? false : 'error';
  }
}

/**
 * 预检:显式仓库目录(绝对、realpath 等于自身、目录且非符号链接、属主为当前 uid;本身不可被组 / 他人写,父目录权限不宽于 0700——对契约字面的偏离见 W8a 状态文件)→ `config` 以 O_NOFOLLOW 句柄读(常规文件、属主、≤ 64 KiB、`nlink == 1`)
 * 并按严格子集解析 → 存在性检查(`config.worktree`、`.gitconfig`、`.config/git`、`objects/pack/*.promisor`、alternates / grafts / commondir)。
 * 通过则返回 config 字节摘要(spawn 前取 c1、返回后重取 c2,不等 → 拒收)。拒绝一律不 spawn。
 */
export async function preflightRepo(gitDir: string, uid?: number): Promise<Preflight> {
  const unsafe: Preflight = { ok: false, why: 'repo_unsafe' };
  const rejected: Preflight = { ok: false, why: 'config_rejected' };
  if (!path.isAbsolute(gitDir)) return unsafe;
  const want = uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  try {
    const st = await lstat(gitDir);
    if (st.isSymbolicLink() || !st.isDirectory()) return unsafe;
    if (want !== undefined && st.uid !== want) return unsafe;
    // 偏离契约字面「权限不宽于 0700」(见 W8a 状态文件):`git init` 建出的 `.git` 通常是 0755,字面照做会让生产读取必拒。
    // 这里要求:仓库目录本身不可被组 / 他人写(& 0o022 == 0),且它的父目录(私有仓库根,R21-3.4 结构校验已要求 0700)权限不宽于 0700、属主为当前 uid。
    if ((st.mode & 0o022) !== 0) return unsafe;
    const parent = await lstat(path.dirname(gitDir));
    if (parent.isSymbolicLink() || !parent.isDirectory()) return unsafe;
    if (want !== undefined && parent.uid !== want) return unsafe;
    if ((parent.mode & 0o077) !== 0) return unsafe;
    if ((await realpath(gitDir)) !== gitDir) return unsafe;
  } catch {
    return unsafe;
  }
  const cfg = await readFileSafe(path.join(gitDir, 'config'), {
    maxBytes: GIT_CONFIG_MAX_BYTES,
    owner: { maxPerm: 0o777, ...(want !== undefined ? { uid: want } : {}) },
  });
  if (cfg.kind !== 'ok') return rejected;
  if (!configAcceptable(cfg.bytes.toString('utf8'))) return rejected;
  for (const rel of EXISTENCE_REJECT) {
    if ((await present(path.join(gitDir, rel))) !== false) return rejected;
  }
  try {
    const packs = await readDir(path.join(gitDir, 'objects', 'pack'));
    if (packs.some((e) => e.name.endsWith('.promisor'))) return rejected;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return rejected;
  }
  return { ok: true, digest: createHash('sha256').update(cfg.bytes).digest('hex') };
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------
export interface GitReadonlyOptions {
  /** git 可执行文件的绝对路径(部署组装传入,不查 PATH) */
  gitPath: string;
  /** 私有仓库的 git 目录(绝对;由 homeDir + 固定相对名现算,不来自用户输入) */
  gitDir: string;
  spawn: GitSpawn;
  pathValue?: string;
  uid?: number;
}

type Raw =
  { kind: 'ok'; stdout: string } | { kind: 'missing' } | { kind: 'unreadable'; why: RecordedWhy };

/** 解析 `ls-tree -r -z --full-tree` 输出:`<mode> SP <type> SP <oid> TAB <path>\0`;任一项形状不符 → `null` */
export function parseLsTreeZ(out: string): RecordedTreeEntry[] | null {
  const entries: RecordedTreeEntry[] = [];
  for (const rec of out.split('\0')) {
    if (rec === '') continue;
    const m = /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40})\t([\s\S]+)$/.exec(rec);
    if (m === null) return null;
    entries.push({ mode: m[1] as string, oid: m[3] as string, path: m[4] as string });
  }
  return entries;
}

export function makeGitReadonly(o: GitReadonlyOptions): RecordedReadPort {
  if (!path.isAbsolute(o.gitPath) || path.basename(o.gitPath) !== 'git') {
    throw new TypeError('makeGitReadonly: gitPath 必须是文件名为 git 的绝对路径');
  }
  const pathValue = o.pathValue ?? GIT_DEFAULT_PATH;
  let blobs = 0;
  let blobBytes = 0;

  const run = async (tail: readonly string[], missingOnStatus1: boolean): Promise<Raw> => {
    const pre = await preflightRepo(o.gitDir, o.uid);
    if (!pre.ok) return { kind: 'unreadable', why: pre.why };
    const argv = [...fixedGitArgv(o.gitDir), ...tail];
    const env = closedGitEnv(o.gitDir, pathValue);
    try {
      assertReadOnlyGitArgv(argv, o.gitDir);
      assertClosedEnv(env, o.gitDir, pathValue);
    } catch {
      return { kind: 'unreadable', why: 'bad_oid' };
    }
    const r = await o.spawn(o.gitPath, argv, {
      cwd: o.gitDir,
      env,
      timeoutMs: GIT_CALL_TIMEOUT_MS,
      maxBufferBytes: GIT_OUTPUT_MAX_BYTES,
    });
    // 返回后复核:配置摘要 / 存在性集合变了 → 丢弃结果(只算检测并拒收,不是零写入证明)
    const post = await preflightRepo(o.gitDir, o.uid);
    if (!post.ok || post.digest !== pre.digest) {
      return { kind: 'unreadable', why: 'changed_during_read' };
    }
    if (r.timedOut) return { kind: 'unreadable', why: 'timeout' };
    if (r.spawnError !== undefined) return { kind: 'unreadable', why: 'spawn_failed' };
    if (Buffer.byteLength(r.stdout, 'utf8') > GIT_OUTPUT_MAX_BYTES) {
      return { kind: 'unreadable', why: 'output_limit' };
    }
    if (r.status === 0) return { kind: 'ok', stdout: r.stdout };
    if (r.status === 1 && missingOnStatus1) return { kind: 'missing' };
    return { kind: 'unreadable', why: 'nonzero_exit' };
  };
  const bad = <T>(): RecordedRead<T> => ({ kind: 'unreadable', why: 'bad_oid' });

  return {
    async readCommit(oid) {
      if (!OID_RE.test(oid)) return bad();
      const r = await run(
        ['rev-parse', '--verify', '--quiet', '--end-of-options', `${oid}^{commit}`],
        true,
      );
      if (r.kind !== 'ok') return r;
      const got = r.stdout.trim();
      return OID_RE.test(got)
        ? { kind: 'ok', value: { oid: got } }
        : { kind: 'unreadable', why: 'bad_output' };
    },
    async listTree(oid) {
      if (!OID_RE.test(oid)) return bad();
      const r = await run(['ls-tree', '-r', '-z', '--full-tree', '--end-of-options', oid], false);
      if (r.kind !== 'ok') return r;
      const entries = parseLsTreeZ(r.stdout);
      return entries === null
        ? { kind: 'unreadable', why: 'bad_output' }
        : { kind: 'ok', value: entries };
    },
    async readBlob(oid) {
      if (!OID_RE.test(oid)) return bad();
      if (blobs + 1 > GIT_BLOB_MAX_COUNT) return { kind: 'unreadable', why: 'output_limit' };
      const r = await run(['cat-file', 'blob', oid], false);
      if (r.kind !== 'ok') return r;
      blobs += 1;
      blobBytes += Buffer.byteLength(r.stdout, 'utf8');
      if (blobBytes > GIT_BLOB_MAX_TOTAL_BYTES) return { kind: 'unreadable', why: 'output_limit' };
      return { kind: 'ok', value: r.stdout };
    },
  };
}
