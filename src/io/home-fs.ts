/**
 * HOME 写出口(第三个写出口,contracts §19 / 设计稿 §1.5):sync 与自动更新写 HOME 的唯一通道。
 * 只许 src/sync/apply.ts、src/update/install.ts 及其测试 import(eslint 授权闸)。
 *
 * 每次调用,目标必须同时满足:
 *  1. 路径语法:HOME 相对、正斜杠、纯 ASCII 可见字符、无 `..` / 空段 / 反斜杠(Unicode 与控制字符一律拒);
 *  2. 在 `HOME_WRITE_TABLE` 内:file 条目精确匹配;dir 条目只能写其内部的子路径,目录本身不可写;
 *     adapter 的 dir 内部另禁点开头的路径段与 `.json` 目标(与 `isHomeWritePath` 同一判定);
 *  3. 在调用方传入的 `planScope`(本次计划的目标文件集合)内:
 *     文件操作要求精确在内;目录操作(mkdirp / removeDir)要求是某个 planScope 条目的祖先;
 *  4. HOME 只接受 `getRealHome()`,或 KIT_TMP 严格之内的目录(`--home` 假 HOME);
 *  5. 从 HOME 起逐段 lstat:任一中间段是符号链接即拒(决策 ⑩A);最后一段是符号链接 / 悬空链接 / 硬链接 /
 *     FIFO / 设备 / socket / 类型不符一律拒。
 *
 * 所有拒绝抛 `HomeWriteDeniedError`,`code` 取自 `HOME_DENY`(稳定码);消息只含码与调用方给的 HOME 相对路径。
 * 原子写 = 同目录临时文件(O_EXCL)→ fsync → 重新校验 → rename → 目录 fsync。
 *
 * 已知残余(同 contracts §5):校验与使用之间有竞态窗口(Node 没有 openat / 目录 fd 相对操作)。
 * 校验后把某个祖先目录换成符号链接,rename / unlink / rmdir / mkdir 这类按路径执行的调用可能落到链接另一侧。
 * 已缩小的部分:临时文件用 O_EXCL|O_NOFOLLOW 创建,rename 前重验目标路径并核对临时文件的 dev:ino / nlink;
 * chmod / copyFile 对打开后的 fd 复核类型与 nlink 并 fchmod;目录 chmod 走 O_NOFOLLOW|O_DIRECTORY 的 fd;
 * HOME 的目录身份在创建上下文时固定;已存在路径段还要核对目录项的确切名字(挡大小写 / Unicode 别名)。
 * 仍然是按路径的:rename、unlink、rmdir、mkdir。
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { RelPathSchema, SEMVER_RE } from '../contracts/common.js';
import { HOME_WRITE_TABLE, isHomeWritePath } from '../contracts/sync.js';
import { getRealHome, type WriteAudit } from './paths.js';

/** 稳定拒绝码。 */
export const HOME_DENY = {
  /** HOME 既不是 getRealHome() 也不在 KIT_TMP 严格之内(或无法解析) */
  BAD_HOME: 'HOME_BAD_HOME',
  /** 路径语法非法(绝对路径、`..`、空段、非 ASCII、控制字符、反斜杠、超长) */
  PATH_INVALID: 'HOME_PATH_INVALID',
  /** 不在 HOME_WRITE_TABLE 内 */
  NOT_IN_TABLE: 'HOME_NOT_IN_TABLE',
  /** 目标就是表里的目录条目本身 */
  DIR_ITSELF: 'HOME_DIR_ITSELF',
  /** adapter 目录内部出现点开头的路径段 */
  DOT_SEGMENT: 'HOME_DOT_SEGMENT',
  /** adapter 目录内部的 `.json` 目标 */
  JSON_TARGET: 'HOME_JSON_TARGET',
  /** 不在本次计划的目标集合内 */
  OUT_OF_PLAN_SCOPE: 'HOME_OUT_OF_PLAN_SCOPE',
  /** planScope 条目本身不合法(创建上下文时拒绝) */
  SCOPE_INVALID: 'HOME_SCOPE_INVALID',
  /** 中间路径段是符号链接 */
  INTERMEDIATE_SYMLINK: 'HOME_INTERMEDIATE_SYMLINK',
  /** 最后一段是符号链接(含悬空) */
  TARGET_SYMLINK: 'HOME_TARGET_SYMLINK',
  /** 目标是硬链接(nlink>1) */
  HARDLINK: 'HOME_HARDLINK',
  /** 目标是 FIFO / 设备 / socket */
  SPECIAL_FILE: 'HOME_SPECIAL_FILE',
  /** 文件操作的目标是目录,或其它非普通文件 */
  NOT_REGULAR: 'HOME_NOT_REGULAR',
  /** 路径中间段(或目录操作的目标)不是目录 */
  NOT_DIRECTORY: 'HOME_NOT_DIRECTORY',
  /** 已存在祖先的 realpath 与逐段拼出的路径不一致(别名 / 竞态 / 链接事后改指向) */
  PATH_ESCAPE: 'HOME_PATH_ESCAPE',
  /** lstat 失败(非 ENOENT) */
  STAT_FAILED: 'HOME_STAT_FAILED',
  /** 文件权限位含 rwx 之外的位(setuid 等)或不是整数 */
  BAD_MODE: 'HOME_BAD_MODE',
  /** 目标应是符号链接(current)却是别的类型 */
  NOT_SYMLINK: 'HOME_NOT_SYMLINK',
  /** 版本号语法不合法(switchCurrent) */
  BAD_VERSION: 'HOME_BAD_VERSION',
} as const;

export type HomeDenyCode = (typeof HOME_DENY)[keyof typeof HOME_DENY];

export class HomeWriteDeniedError extends Error {
  readonly code: HomeDenyCode;
  /** 调用方给的 HOME 相对路径(截断;可能为空) */
  readonly rel: string | undefined;
  constructor(code: HomeDenyCode, rel?: string) {
    super(rel === undefined ? code : `${code} path=${JSON.stringify(rel.slice(0, 200))}`);
    this.name = 'HomeWriteDeniedError';
    this.code = code;
    this.rel = rel;
  }
}

/** 独占创建 / 目录改名的目标已存在(S7c;锁用它判断「被别人先拿了」)。 */
export class HomeExistsError extends Error {
  readonly code = 'EEXIST';
  readonly rel: string;
  constructor(rel: string) {
    super(`EEXIST path=${JSON.stringify(rel.slice(0, 200))}`);
    this.name = 'HomeExistsError';
    this.rel = rel;
  }
}

/** 原子写的各阶段;`onStage` 抛错即模拟该阶段失败(测试注入口,产品代码不传)。 */
export type HomeFsStage = 'temp-created' | 'temp-written' | 'temp-synced' | 'pre-rename';

export interface HomeFsContext {
  /** 传入的 HOME(字面) */
  readonly home: string;
  /** 本次计划的目标文件集合(HOME 相对,已校验;冻结副本。授权判定读模块私有状态,改这个数组无效) */
  readonly planScope: readonly string[];
  readonly tmpDir: string | undefined;
  readonly onStage: ((stage: HomeFsStage) => void | Promise<void>) | undefined;
  /**
   * 可选写审计钩子(R20-A2 B2;与 safe-fs 的 `IoContext.writeAudit` 同一约定,类型共用 `WriteAudit`):每个导出写函数**入口第一行**、
   * 任何校验之前调用一次 `(op, 绝对路径)`。记录的是**写尝试**(被守卫拒绝的也记,它不替代任何安全检查),路径是 `path.resolve(home, rel)` 的
   * 字面结果(不碰磁盘、不抛错;逃逸 / 绝对路径照记)。一个导出函数只记一次(内部共享的 `atomicWrite` 等不记);op 名带 `home.` 前缀,
   * 与 safe-fs 的 op 区分。钩子只许记录、不得抛错。未设置 = 键不存在,行为与引入前逐字节一致。
   */
  readonly writeAudit?: WriteAudit;
}

export interface CreateHomeFsContextOptions {
  /** 绝对路径:getRealHome() 或 KIT_TMP 严格之内的假 HOME */
  home: string;
  /** 本次计划的目标文件(HOME 相对);每一项都必须是表内的文件路径 */
  planScope: readonly string[];
  /** IoContext.tmpDir */
  tmpDir?: string | undefined;
  /** 注入环境给 getRealHome(测试用) */
  env?: Readonly<Record<string, string | undefined>>;
  /** 测试注入口 */
  onStage?: (stage: HomeFsStage) => void | Promise<void>;
  /** 写审计钩子,见 `HomeFsContext.writeAudit`;缺省不审计 */
  writeAudit?: WriteAudit;
}

// ---------------------------------------------------------------------------
// 纯字符串判定
// ---------------------------------------------------------------------------

function assertSyntax(rel: string): void {
  // 纯 ASCII 可见字符:Unicode(含 NFD / 同形字 / 零宽 / 双向控制)与控制字符一律拒;大小写变体靠表的精确匹配拒
  if (
    typeof rel !== 'string' ||
    !RelPathSchema.safeParse(rel).success ||
    !/^[\x21-\x7e]+(?:\/[\x21-\x7e]+)*$/.test(rel)
  ) {
    throw new HomeWriteDeniedError(HOME_DENY.PATH_INVALID, typeof rel === 'string' ? rel : '');
  }
}

/**
 * 模块加载时对 HOME_WRITE_TABLE 取不可变快照:契约里的数组只有 TS 层面的 readonly,运行期被人追加条目
 * 不应让写出口的授权来源跟着变。所有判定用快照,文件目标另要求同时通过契约的 `isHomeWritePath`。
 */
const TABLE = Object.freeze(
  HOME_WRITE_TABLE.map((e) => Object.freeze({ ...e, agents: Object.freeze([...e.agents]) })),
);

function inSnapshot(rel: string): boolean {
  return TABLE.some((e) => {
    if (e.kind === 'file') return rel === e.path;
    if (!rel.startsWith(e.path) || rel.length <= e.path.length) return false;
    if (e.owner !== 'adapter') return true;
    const rest = rel.slice(e.path.length);
    // `.json` 按大小写不敏感判(大小写不敏感的卷上 `x.JSON` 与 `x.json` 是同一个文件;契约的判定大小写敏感)
    return !rest.split('/').some((x) => x.startsWith('.')) && !rest.toLowerCase().endsWith('.json');
  });
}

/** 文件目标:语法 + 表。返回时保证快照与 `isHomeWritePath(rel)` 都放行。 */
function assertFileInTable(rel: string): void {
  assertSyntax(rel);
  if (inSnapshot(rel) && isHomeWritePath(rel)) return;
  for (const e of TABLE) {
    if (e.kind !== 'dir') continue;
    if (rel === e.path.slice(0, -1)) throw new HomeWriteDeniedError(HOME_DENY.DIR_ITSELF, rel);
    if (rel.startsWith(e.path) && e.owner === 'adapter') {
      const rest = rel.slice(e.path.length);
      if (rest.split('/').some((s) => s.startsWith('.'))) {
        throw new HomeWriteDeniedError(HOME_DENY.DOT_SEGMENT, rel);
      }
      if (rest.toLowerCase().endsWith('.json'))
        throw new HomeWriteDeniedError(HOME_DENY.JSON_TARGET, rel);
    }
  }
  throw new HomeWriteDeniedError(HOME_DENY.NOT_IN_TABLE, rel);
}

/** 目录目标:语法 + 严格位于某个 dir 条目内部(adapter 内部另禁点开头段)。 */
function assertDirInTable(rel: string): void {
  assertSyntax(rel);
  for (const e of TABLE) {
    if (e.kind !== 'dir') continue;
    if (rel === e.path.slice(0, -1)) throw new HomeWriteDeniedError(HOME_DENY.DIR_ITSELF, rel);
    if (rel.startsWith(e.path)) {
      if (
        e.owner === 'adapter' &&
        rel
          .slice(e.path.length)
          .split('/')
          .some((s) => s.startsWith('.'))
      ) {
        throw new HomeWriteDeniedError(HOME_DENY.DOT_SEGMENT, rel);
      }
      return;
    }
  }
  throw new HomeWriteDeniedError(HOME_DENY.NOT_IN_TABLE, rel);
}

/** 模块私有授权状态:调用方拿到的 ctx 只是句柄,无法事后改 planScope / env / 已固定的 HOME 身份。 */
interface PrivateState {
  readonly scope: ReadonlySet<string>;
  readonly env: Readonly<Record<string, string | undefined>> | undefined;
  /** 创建时固定的 HOME 目录身份 dev:ino;之后 HOME 被换成别的目录即拒 */
  readonly homeIdent: string;
}
const STATES = new WeakMap<HomeFsContext, PrivateState>();

function stateOf(ctx: HomeFsContext): PrivateState {
  const st = STATES.get(ctx);
  if (st === undefined) throw new HomeWriteDeniedError(HOME_DENY.SCOPE_INVALID);
  return st;
}

function assertFileInScope(ctx: HomeFsContext, rel: string): void {
  if (!stateOf(ctx).scope.has(rel)) {
    throw new HomeWriteDeniedError(HOME_DENY.OUT_OF_PLAN_SCOPE, rel);
  }
}

function assertDirInScope(ctx: HomeFsContext, rel: string): void {
  const prefix = `${rel}/`;
  for (const s of stateOf(ctx).scope) if (s.startsWith(prefix)) return;
  throw new HomeWriteDeniedError(HOME_DENY.OUT_OF_PLAN_SCOPE, rel);
}

function assertMode(mode: number): void {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
    throw new HomeWriteDeniedError(HOME_DENY.BAD_MODE);
  }
}

/** 叶子类型分类(导出供测试:FIFO / 设备 / socket 无法在测试里造,用桩 Stats 覆盖)。 */
export function classifyLeaf(
  st: Pick<
    fs.Stats,
    | 'isSymbolicLink'
    | 'isFile'
    | 'isDirectory'
    | 'isFIFO'
    | 'isCharacterDevice'
    | 'isBlockDevice'
    | 'isSocket'
    | 'nlink'
  >,
  want: 'file' | 'dir',
): HomeDenyCode | undefined {
  if (st.isSymbolicLink()) return HOME_DENY.TARGET_SYMLINK;
  if (st.isFIFO() || st.isCharacterDevice() || st.isBlockDevice() || st.isSocket()) {
    return HOME_DENY.SPECIAL_FILE;
  }
  if (want === 'dir') return st.isDirectory() ? undefined : HOME_DENY.NOT_DIRECTORY;
  if (!st.isFile()) return HOME_DENY.NOT_REGULAR;
  if (st.nlink > 1) return HOME_DENY.HARDLINK;
  return undefined;
}

// ---------------------------------------------------------------------------
// HOME 与逐段检查
// ---------------------------------------------------------------------------

function realpathOrUndefined(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}

function strictlyInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function identOf(p: string): string | undefined {
  try {
    const st = fs.statSync(p);
    return `${st.dev}:${st.ino}`;
  } catch {
    return undefined;
  }
}

/**
 * 校验 HOME 并返回其 realpath(此后逐段检查都从这个真实路径起算)。
 * `pinned` 给出时,还要求 HOME 的目录身份(dev:ino)与创建上下文时固定的一致。
 */
function resolveHome(
  ctx: HomeFsContext,
  env: Readonly<Record<string, string | undefined>> | undefined,
  pinned?: string,
): string {
  const canon = resolveHomeUnpinned(ctx, env);
  if (pinned !== undefined && identOf(canon) !== pinned) {
    throw new HomeWriteDeniedError(HOME_DENY.BAD_HOME);
  }
  return canon;
}

function resolveHomeUnpinned(
  ctx: HomeFsContext,
  env: Readonly<Record<string, string | undefined>> | undefined,
): string {
  const bad = (): never => {
    throw new HomeWriteDeniedError(HOME_DENY.BAD_HOME);
  };
  if (!path.isAbsolute(ctx.home)) return bad();
  const canon = realpathOrUndefined(ctx.home);
  if (canon === undefined) return bad();
  const real = getRealHome(env);
  if (path.isAbsolute(real)) {
    if (path.resolve(real) === path.resolve(ctx.home)) return canon;
    const realCanon = realpathOrUndefined(real);
    if (realCanon !== undefined && realCanon === canon) return canon;
  }
  if (ctx.tmpDir !== undefined) {
    const tmpCanon = realpathOrUndefined(ctx.tmpDir);
    if (tmpCanon !== undefined && strictlyInside(tmpCanon, canon)) return canon;
  }
  return bad();
}

interface Inspected {
  readonly home: string;
  readonly abs: string;
  readonly parentAbs: string;
  /** 叶子的 lstat;不存在为 undefined */
  readonly leaf: fs.Stats | undefined;
  /** 第一个不存在的段下标(全部存在为 -1) */
  readonly missingFrom: number;
  readonly segments: readonly string[];
}

function lstatOrMissing(p: string, rel: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new HomeWriteDeniedError(HOME_DENY.STAT_FAILED, rel);
  }
}

/** 目录里是否有恰好这个名字(大小写 / Unicode 规范化不同的别名在大小写不敏感卷上 lstat 得到,但这里查不到)。 */
function hasExactName(dir: string, name: string, rel: string): boolean {
  try {
    return fs.readdirSync(dir).includes(name);
  } catch {
    throw new HomeWriteDeniedError(HOME_DENY.STAT_FAILED, rel);
  }
}

function inspect(
  ctx: HomeFsContext,
  rel: string,
  want: 'file' | 'dir',
  allowLeafSymlink = false,
): Inspected {
  const state = stateOf(ctx);
  const home = resolveHome(ctx, state.env, state.homeIdent);
  const segments = rel.split('/');
  let cur = home;
  let missingFrom = -1;
  let leaf: fs.Stats | undefined;
  for (let i = 0; i < segments.length; i++) {
    const next = path.join(cur, segments[i] as string);
    const st = lstatOrMissing(next, rel);
    if (st === undefined) {
      missingFrom = i;
      break;
    }
    if (!hasExactName(cur, segments[i] as string, rel)) {
      throw new HomeWriteDeniedError(HOME_DENY.PATH_ESCAPE, rel);
    }
    const last = i === segments.length - 1;
    if (last) {
      if (allowLeafSymlink && st.isSymbolicLink()) {
        leaf = st; // 仅 switchCurrent 的 current 链接:调用方自己核对它是链接
      } else {
        const bad = classifyLeaf(st, want);
        if (bad !== undefined) throw new HomeWriteDeniedError(bad, rel);
        leaf = st;
      }
    } else {
      if (st.isSymbolicLink()) throw new HomeWriteDeniedError(HOME_DENY.INTERMEDIATE_SYMLINK, rel);
      if (!st.isDirectory()) throw new HomeWriteDeniedError(HOME_DENY.NOT_DIRECTORY, rel);
    }
    cur = next;
  }
  // 纵深防御:最深的已存在目录,其 realpath 必须等于逐段拼出的路径(别名 / 事后改指向 / 竞态都会让两者分叉)
  const deepestDir = leaf !== undefined && want === 'file' ? path.dirname(cur) : cur;
  const r = realpathOrUndefined(deepestDir);
  if (r === undefined || r !== deepestDir) {
    throw new HomeWriteDeniedError(HOME_DENY.PATH_ESCAPE, rel);
  }
  const abs = path.join(home, ...segments);
  return { home, abs, parentAbs: path.dirname(abs), leaf, missingFrom, segments };
}

function checkFile(ctx: HomeFsContext, rel: string): Inspected {
  assertFileInTable(rel);
  assertFileInScope(ctx, rel);
  return inspect(ctx, rel, 'file');
}

function checkDir(ctx: HomeFsContext, rel: string): Inspected {
  assertDirInTable(rel);
  assertDirInScope(ctx, rel);
  return inspect(ctx, rel, 'dir');
}

// ---------------------------------------------------------------------------
// 上下文
// ---------------------------------------------------------------------------

export function createHomeFsContext(opts: CreateHomeFsContextOptions): HomeFsContext {
  const scope = new Set<string>();
  for (const s of opts.planScope) {
    try {
      assertFileInTable(s);
    } catch (e) {
      if (e instanceof HomeWriteDeniedError) {
        throw new HomeWriteDeniedError(HOME_DENY.SCOPE_INVALID, s);
      }
      throw e;
    }
    scope.add(s);
  }
  const ctx: HomeFsContext = Object.freeze({
    home: opts.home,
    planScope: Object.freeze([...scope]),
    tmpDir: opts.tmpDir,
    onStage: opts.onStage,
    ...(opts.writeAudit !== undefined ? { writeAudit: opts.writeAudit } : {}),
  });
  const env = opts.env === undefined ? undefined : Object.freeze({ ...opts.env });
  const canon = resolveHome(ctx, env); // HOME 不合格就在创建时失败;之后每次操作还会再验一遍
  const homeIdent = identOf(canon);
  if (homeIdent === undefined) throw new HomeWriteDeniedError(HOME_DENY.BAD_HOME);
  STATES.set(ctx, { scope, env, homeIdent });
  return ctx;
}

// ---------------------------------------------------------------------------
// 写原语
// ---------------------------------------------------------------------------

async function syncDir(dir: string): Promise<void> {
  try {
    const fh = await fsp.open(dir, fs.constants.O_RDONLY);
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    // 尽力而为:目录 fsync 失败(含不支持、I/O 错误)不改变已完成的 rename / unlink 结果,也不对持久化作保证
  }
}

function audit(ctx: HomeFsContext, op: string, rel: string): void {
  ctx.writeAudit?.(`home.${op}`, path.resolve(ctx.home, String(rel)));
}

export interface HomeWriteOptions {
  /** 缺省 0o644;kit 状态文件应传 0o600 */
  mode?: number;
  /** 隐式创建缺失父目录时的权限,缺省 0o755;kit 状态目录应传 0o700 */
  dirMode?: number;
}

const NOFOLLOW_RO = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

function enoent(): Error {
  return Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
}

/** 打开已校验的文件做 fd 级操作:O_NOFOLLOW + O_NONBLOCK(FIFO 不会卡住),再对 fd 复核类型与 nlink。 */
async function openChecked(abs: string, rel: string, expected: fs.Stats): Promise<fsp.FileHandle> {
  let fh: fsp.FileHandle;
  try {
    fh = await fsp.open(abs, NOFOLLOW_RO);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') throw new HomeWriteDeniedError(HOME_DENY.TARGET_SYMLINK, rel);
    throw e;
  }
  const st = await fh.stat();
  // 打开的必须还是校验时看到的那个文件:检查后祖先被换成链接、路径指向别的文件,dev:ino 会不同
  const bad =
    st.ino !== expected.ino || st.dev !== expected.dev
      ? HOME_DENY.PATH_ESCAPE
      : classifyLeaf(st, 'file');
  if (bad !== undefined) {
    await fh.close();
    throw new HomeWriteDeniedError(bad, rel);
  }
  return fh;
}

/** 从第 `from` 段起创建缺失目录,直到(不含)第 `until` 段;建好后对 fd 做 chmod(O_NOFOLLOW|O_DIRECTORY,不跟随事后换上的链接)。 */
async function makeDirs(info: Inspected, rel: string, until: number, mode: number): Promise<void> {
  if (info.missingFrom === -1) return;
  let cur = info.home;
  for (let i = 0; i < until; i++) {
    cur = path.join(cur, info.segments[i] as string);
    if (i < info.missingFrom) continue;
    let created = true;
    try {
      await fsp.mkdir(cur, { mode });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      created = false;
    }
    let fh: fsp.FileHandle;
    try {
      fh = await fsp.open(
        cur,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
      );
    } catch {
      throw new HomeWriteDeniedError(HOME_DENY.INTERMEDIATE_SYMLINK, rel);
    }
    try {
      if (created) await fh.chmod(mode);
    } finally {
      await fh.close();
    }
  }
}

/**
 * 原子写:同目录临时文件(O_EXCL|O_NOFOLLOW)→ fsync → 重新校验目标与临时文件身份 → rename。
 * 任一步失败都会清掉临时文件,目标保持原样。缺失的父目录(含文件型条目的 `.codex` 等)隐式创建,
 * 所以干净 HOME 上的首次安装不需要别的写通道。
 */
export async function writeFile(
  ctx: HomeFsContext,
  rel: string,
  data: string | Uint8Array,
  opts: HomeWriteOptions = {},
): Promise<void> {
  audit(ctx, 'writeFile', rel);
  const mode = opts.mode ?? 0o644;
  const dirMode = opts.dirMode ?? 0o755;
  assertMode(mode);
  assertMode(dirMode);
  const info = checkFile(ctx, rel);
  await atomicWrite(ctx, rel, info, data, mode, dirMode);
}

async function atomicWrite(
  ctx: HomeFsContext,
  rel: string,
  info: Inspected,
  data: string | Uint8Array,
  mode: number,
  dirMode: number,
): Promise<void> {
  await makeDirs(info, rel, info.segments.length - 1, dirMode);
  const tmp = path.join(
    info.parentAbs,
    `.${path.basename(info.abs)}.tmp-${randomBytes(6).toString('hex')}`,
  );
  try {
    const fh = await fsp.open(
      tmp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      mode,
    );
    let ident: fs.Stats;
    try {
      ident = await fh.stat();
      await ctx.onStage?.('temp-created');
      await fh.writeFile(data);
      await ctx.onStage?.('temp-written');
      await fh.chmod(mode);
      await fh.sync();
      await ctx.onStage?.('temp-synced');
    } finally {
      await fh.close();
    }
    // rename 前重新校验(缩小校验与使用之间的窗口):目标路径,以及临时文件仍是我们创建的那个普通文件
    await ctx.onStage?.('pre-rename');
    const again = checkFile(ctx, rel);
    const now = fs.lstatSync(tmp);
    if (now.isSymbolicLink()) throw new HomeWriteDeniedError(HOME_DENY.TARGET_SYMLINK, rel);
    if (!now.isFile() || now.ino !== ident.ino || now.dev !== ident.dev) {
      throw new HomeWriteDeniedError(HOME_DENY.PATH_ESCAPE, rel);
    }
    if (now.nlink !== 1) throw new HomeWriteDeniedError(HOME_DENY.HARDLINK, rel);
    await fsp.rename(tmp, again.abs);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
  await syncDir(info.parentAbs);
}

/** 递归建目录(目录权限缺省 0o755)。目标须严格位于 dir 条目内部、且是计划目标的祖先;缺失的上级(含条目目录本身)隐式创建。 */
export async function mkdirp(ctx: HomeFsContext, rel: string, mode = 0o755): Promise<void> {
  audit(ctx, 'mkdirp', rel);
  assertMode(mode);
  const info = checkDir(ctx, rel);
  await makeDirs(info, rel, info.segments.length, mode);
}

/** 删除一个普通文件;不存在视为成功。目录、链接、硬链接一律拒。 */
export async function remove(ctx: HomeFsContext, rel: string): Promise<void> {
  audit(ctx, 'remove', rel);
  const info = checkFile(ctx, rel);
  if (info.leaf === undefined) return;
  await fsp.unlink(info.abs);
  await syncDir(info.parentAbs);
}

/** 删除一个空目录(rmdir,非空即失败,不会连带删用户文件);条目目录本身不可删。不存在视为成功。 */
export async function removeDir(ctx: HomeFsContext, rel: string): Promise<void> {
  audit(ctx, 'removeDir', rel);
  const info = checkDir(ctx, rel);
  if (info.leaf === undefined) return;
  await fsp.rmdir(info.abs);
  await syncDir(info.parentAbs);
}

/** 两端都必须是表内、计划内的文件路径;目标的父目录须已存在。 */
export async function rename(ctx: HomeFsContext, fromRel: string, toRel: string): Promise<void> {
  audit(ctx, 'rename.from', fromRel);
  audit(ctx, 'rename', toRel);
  const from = checkFile(ctx, fromRel);
  const to = checkFile(ctx, toRel);
  if (from.leaf === undefined) throw enoent();
  await fsp.rename(from.abs, to.abs);
  await syncDir(to.parentAbs);
  if (from.parentAbs !== to.parentAbs) await syncDir(from.parentAbs);
}

/** 对已校验文件的 fd 做 fchmod(不跟随检查后换上的链接)。 */
export async function chmod(ctx: HomeFsContext, rel: string, mode: number): Promise<void> {
  audit(ctx, 'chmod', rel);
  assertMode(mode);
  const info = checkFile(ctx, rel);
  if (info.leaf === undefined) throw enoent();
  const fh = await openChecked(info.abs, rel, info.leaf);
  try {
    await fh.chmod(mode);
  } finally {
    await fh.close();
  }
}

/**
 * 备份 / 回滚用的拷贝:两端都必须是表内、计划内的文件路径(来源同样做链接 / 硬链接检查,并对打开后的 fd 复核)。
 * 目标按原子写落盘(缺失父目录隐式创建,权限 0o755),文件权限沿用来源。
 */
export async function copyFile(ctx: HomeFsContext, fromRel: string, toRel: string): Promise<void> {
  audit(ctx, 'copyFile.from', fromRel);
  audit(ctx, 'copyFile', toRel);
  const from = checkFile(ctx, fromRel);
  const to = checkFile(ctx, toRel);
  if (from.leaf === undefined) throw enoent();
  const fh = await openChecked(from.abs, fromRel, from.leaf);
  let bytes: Buffer;
  let srcMode: number;
  try {
    srcMode = (await fh.stat()).mode & 0o777;
    bytes = await fh.readFile();
  } finally {
    await fh.close();
  }
  await atomicWrite(ctx, toRel, to, bytes, srcMode, 0o755);
}

// ---------------------------------------------------------------------------
// S7c-A 追加:独占创建(锁)、目录改名(staging → versions/<v>)、current 链接切换
// ---------------------------------------------------------------------------

/**
 * 独占创建:O_CREAT|O_EXCL|O_NOFOLLOW 直接创建目标(表内、计划内的文件路径),已存在 → `HomeExistsError`。
 * 不走「临时文件 + rename」:rename 会覆盖别人已经拿到的锁。代价是读者可能读到空文件 / 半写内容,
 * 调用方(锁)要自己处理;写入中途失败时把自己刚建的文件删掉。缺失的父目录隐式创建(dirMode 缺省 0o755)。
 */
export async function createExclusive(
  ctx: HomeFsContext,
  rel: string,
  data: string | Uint8Array,
  opts: HomeWriteOptions = {},
): Promise<void> {
  audit(ctx, 'createExclusive', rel);
  const mode = opts.mode ?? 0o644;
  const dirMode = opts.dirMode ?? 0o755;
  assertMode(mode);
  assertMode(dirMode);
  const info = checkFile(ctx, rel);
  if (info.leaf !== undefined) throw new HomeExistsError(rel);
  await makeDirs(info, rel, info.segments.length - 1, dirMode);
  let fh: fsp.FileHandle;
  try {
    fh = await fsp.open(
      info.abs,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      mode,
    );
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new HomeExistsError(rel);
    if (code === 'ELOOP') throw new HomeWriteDeniedError(HOME_DENY.TARGET_SYMLINK, rel);
    throw e;
  }
  try {
    await fh.writeFile(data);
    await fh.chmod(mode);
    await fh.sync();
  } catch (e) {
    await fh.close().catch(() => undefined);
    await fsp.rm(info.abs, { force: true }).catch(() => undefined);
    throw e;
  }
  await fh.close();
  await syncDir(info.parentAbs);
}

/**
 * 目录改名(staging/<id> → versions/<v>):两端都必须是 dir 条目内部的目录路径、且是计划目标的祖先;
 * 来源须为真实目录(非链接),目标必须不存在(已存在 → `HomeExistsError`)。⚠️ 检查与 rename 之间有竞态窗口:POSIX 的目录 rename
 * 会覆盖一个**空的**目标目录,Node 没有 no-replace 选项,所以「绝不覆盖」只对调用方串行化(update 锁)的场景成立。
 * 改名前后核对目录身份(dev:ino):目标必须就是刚才校验过的那个来源目录。缺失的目标上级隐式创建(dirMode 缺省 0o700)。
 */
export async function renameDir(
  ctx: HomeFsContext,
  fromRel: string,
  toRel: string,
  dirMode = 0o700,
): Promise<void> {
  audit(ctx, 'renameDir.from', fromRel);
  audit(ctx, 'renameDir', toRel);
  assertMode(dirMode);
  const from = checkDir(ctx, fromRel);
  const to = checkDir(ctx, toRel);
  if (from.leaf === undefined) throw enoent();
  if (to.leaf !== undefined) throw new HomeExistsError(toRel);
  await makeDirs(to, toRel, to.segments.length - 1, dirMode);
  const again = checkDir(ctx, fromRel);
  if (
    again.leaf === undefined ||
    again.leaf.ino !== from.leaf.ino ||
    again.leaf.dev !== from.leaf.dev
  ) {
    throw new HomeWriteDeniedError(HOME_DENY.PATH_ESCAPE, fromRel);
  }
  const dest = checkDir(ctx, toRel);
  if (dest.leaf !== undefined) throw new HomeExistsError(toRel);
  try {
    await fsp.rename(again.abs, dest.abs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOTEMPTY' || code === 'EEXIST') throw new HomeExistsError(toRel);
    throw e;
  }
  const after = fs.lstatSync(dest.abs);
  if (!after.isDirectory() || after.ino !== from.leaf.ino || after.dev !== from.leaf.dev) {
    throw new HomeWriteDeniedError(HOME_DENY.PATH_ESCAPE, toRel);
  }
  await syncDir(dest.parentAbs);
  if (from.parentAbs !== dest.parentAbs) await syncDir(from.parentAbs);
}

/** current 链接的 HOME 相对路径(固定,调用方不能指定别的链接位置)。 */
export const CURRENT_LINK_REL = '.local/share/agent-kit/current';
const VERSIONS_REL = '.local/share/agent-kit/versions';

/**
 * 原子切换 `current`:链接位置固定为 CURRENT_LINK_REL(须在 planScope 内),目标由本函数按版本号拼成相对串
 * `versions/<version>`(调用方不能传路径);`version` 必须是合法 semver,`versions/<version>` 必须是真实目录
 * (versions 本身与各上级不得是链接)。流程:同目录建临时符号链接 → 重验目标 → rename 覆盖 → 用 readlink 精确比对
 * 链接串,并核对 realpath(current) 严格位于 realpath(versions) 之内;不符抛 PATH_ESCAPE(调用方负责回切)。
 * 既有 `current` 必须是符号链接(含悬空 / 指向别处的:覆盖它即自愈),是普通文件 / 目录则拒。
 * `version = null`:删除 current 链接(首次安装失败时回退用);不存在视为成功。
 * 已知残余:校验与 rename 之间按路径执行,见文件头。
 */
export async function switchCurrent(ctx: HomeFsContext, version: string | null): Promise<void> {
  audit(ctx, 'switchCurrent', CURRENT_LINK_REL);
  assertFileInTable(CURRENT_LINK_REL);
  assertFileInScope(ctx, CURRENT_LINK_REL);
  const link = inspect(ctx, CURRENT_LINK_REL, 'file', true);
  if (link.leaf !== undefined && !link.leaf.isSymbolicLink()) {
    throw new HomeWriteDeniedError(HOME_DENY.NOT_SYMLINK, CURRENT_LINK_REL);
  }
  if (version === null) {
    if (link.leaf === undefined) return;
    await fsp.unlink(link.abs);
    await syncDir(link.parentAbs);
    return;
  }
  if (typeof version !== 'string' || !SEMVER_RE.test(version)) {
    throw new HomeWriteDeniedError(HOME_DENY.BAD_VERSION, CURRENT_LINK_REL);
  }
  const targetRel = `${VERSIONS_REL}/${version}`;
  assertDirInTable(targetRel);
  const checkTarget = (): Inspected => {
    const t = inspect(ctx, targetRel, 'dir');
    if (t.leaf === undefined) throw enoent();
    return t;
  };
  const target = checkTarget();
  const linkText = `versions/${version}`;
  let tmp = '';
  for (let i = 0; ; i++) {
    tmp = path.join(link.parentAbs, `.current.tmp-${randomBytes(6).toString('hex')}`);
    try {
      fs.symlinkSync(linkText, tmp);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || i >= 3) throw e;
    }
  }
  try {
    await ctx.onStage?.('pre-rename');
    const t2 = checkTarget();
    if (t2.leaf?.ino !== target.leaf?.ino || t2.leaf?.dev !== target.leaf?.dev) {
      throw new HomeWriteDeniedError(HOME_DENY.PATH_ESCAPE, targetRel);
    }
    const l2 = inspect(ctx, CURRENT_LINK_REL, 'file', true);
    if (l2.leaf !== undefined && !l2.leaf.isSymbolicLink()) {
      throw new HomeWriteDeniedError(HOME_DENY.NOT_SYMLINK, CURRENT_LINK_REL);
    }
    await fsp.rename(tmp, l2.abs);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
  await syncDir(link.parentAbs);
  const verifiedText = fs.readlinkSync(link.abs);
  const versionsReal = realpathOrUndefined(path.join(link.home, ...VERSIONS_REL.split('/')));
  const currentReal = realpathOrUndefined(link.abs);
  const targetReal = realpathOrUndefined(target.abs);
  if (
    verifiedText !== linkText ||
    versionsReal === undefined ||
    currentReal === undefined ||
    currentReal !== targetReal ||
    !strictlyInside(versionsReal, currentReal)
  ) {
    throw new HomeWriteDeniedError(HOME_DENY.PATH_ESCAPE, CURRENT_LINK_REL);
  }
}

// ---------------------------------------------------------------------------
// 状态目录收紧(contracts §19.3 D14 / §19.2 的一处写入例外)
// ---------------------------------------------------------------------------

const KIT_STATE_DIR_REL = '.local/state/agent-kit';

export type TightenStateDirResult =
  | { result: 'absent' }
  | { result: 'ok' }
  /** 宽于 0700:`applied=false` 是干跑(只报「将收紧」) */
  | { result: 'tightened'; applied: boolean; from: number }
  /** 不改:任一段是符号链接 / 非目录 */
  | { result: 'skipped_unsafe' }
  /** 不改:属主不是当前用户 */
  | { result: 'skipped_foreign_owner' };

/**
 * 把 kit 自己的状态目录(`~/.local/state/agent-kit`,仅这一层)收紧到 0700。
 * 只在权限宽于 0700(组 / 其他位有任一权限)时动;链上有符号链接、非目录、属主不是当前用户一律不改。
 * 目录 chmod 走 O_NOFOLLOW|O_DIRECTORY 的 fd,并核对 dev:ino 与 lstat 一致。`apply=false` 不写。
 */
export async function tightenKitStateDir(
  ctx: HomeFsContext,
  apply: boolean,
): Promise<TightenStateDirResult> {
  if (apply) audit(ctx, 'tightenKitStateDir', KIT_STATE_DIR_REL); // 干跑不写,不记
  // 复用 inspect:HOME 身份固定、逐段 lstat、精确目录名(挡大小写别名)、链接 / 非目录、realpath 复核
  let info: Inspected;
  try {
    info = inspect(ctx, KIT_STATE_DIR_REL, 'dir');
  } catch (e) {
    if (e instanceof HomeWriteDeniedError && e.code !== HOME_DENY.BAD_HOME) {
      return { result: 'skipped_unsafe' };
    }
    throw e;
  }
  const st = info.leaf;
  if (st === undefined) return { result: 'absent' };
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid === undefined || st.uid !== uid) return { result: 'skipped_foreign_owner' };
  const mode = st.mode & 0o777;
  if ((mode & 0o077) === 0) return { result: 'ok' };
  if (!apply) return { result: 'tightened', applied: false, from: mode };
  let fh: fsp.FileHandle;
  try {
    fh = await fsp.open(
      info.abs,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
  } catch {
    return { result: 'skipped_unsafe' };
  }
  try {
    const fst = await fh.stat();
    if (fst.ino !== st.ino || fst.dev !== st.dev) return { result: 'skipped_unsafe' };
    if (fst.uid !== uid) return { result: 'skipped_foreign_owner' };
    // 以打开后的 fd 为准再判一次:这期间若已被别人收窄,不再改
    const now = fst.mode & 0o777;
    if ((now & 0o077) === 0) return { result: 'ok' };
    await fh.chmod(0o700);
    return { result: 'tightened', applied: true, from: now };
  } finally {
    await fh.close();
  }
}
