/**
 * 唯一读取 HOME / 环境变量 / cwd 的地方。`os.homedir()`、`process.env`、`process.cwd()` 只许出现在本文件。
 * 其它模块要路径或环境,一律从 IoContext 取。
 *
 * P0 约定:
 * - 不展开 `~/.config/<kit>`;覆盖层只经 `--overlay <path>` 显式传入。
 * - `.state/` 在仓库内(KIT_STATE_DIR 可覆盖);`~/.local/state/<kit>/` 留到 P2(Q-N13)。
 * - `home/` 是 out/ 下的路径记号,**不得**展开成真实 HOME。
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync, lstatSync, realpathSync, statSync } from './read-fs.js';

export interface IoContext {
  /** 仓库根(绝对路径):--root > 自 cwd 向上找 kit.toml > cwd */
  readonly repoRoot: string;
  readonly outDir: string;
  readonly stateDir: string;
  /** 允许写入的根目录(绝对路径,已归一化)。safe-fs 只认这个列表。 */
  readonly writeRoots: readonly string[];
  /** KIT_TMP(测试/脚本临时目录),未设置为 undefined */
  readonly tmpDir: string | undefined;
  /** 传给子进程的 PATH(exec 的默认 env 只有它,不含 HOME) */
  readonly execPath: string;
}

export interface CreateIoContextOptions {
  /** `--root`;相对路径按 cwd 解析 */
  root?: string;
  /** 注入环境(测试用);缺省读真实 process.env */
  env?: Readonly<Record<string, string | undefined>>;
  /** 注入 cwd(测试用);缺省读真实 process.cwd() */
  cwd?: string;
}

export class PathsError extends Error {
  readonly code = 'IO_PATHS_INVALID';
}

/** 真实 HOME。仅供 ops 快照工具(B17)使用;KIT_REAL_HOME_OVERRIDE 让检测器自检不碰真 HOME。 */
export function getRealHome(env?: Readonly<Record<string, string | undefined>>): string {
  const e = env ?? process.env;
  return e['KIT_REAL_HOME_OVERRIDE'] ?? os.homedir();
}

/**
 * 从真实 process.env 里只取键名匹配 `keyRe` 的那部分(拷贝,不含其它键)。
 * 给启动器 / runSelf 用:它们不能直接碰 process.env(eslint 闸),又必须看到「是否 CI」「代理变量」这类具体键。
 * 调用方应传一个收窄的正则,不要传「匹配一切」的正则。
 */
export function pickProcessEnv(keyRe: RegExp): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (keyRe.test(k)) out[k] = v;
  }
  return out;
}

function findUp(start: string, marker: string): string | undefined {
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, marker))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function isAncestorOrEqual(ancestor: string, p: string): boolean {
  const rel = path.relative(ancestor, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 只读版「最深已存在祖先 realpath + 剩余段」(与 safe-fs 的校验同一思路):目标不存在时仍能得到
 * 它落盘后的真实位置。悬空/不可解析的符号链接无法判断落点,抛 PathsError(fail-closed)。
 */
function realResolve(abs: string, what: string): string {
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    let exists = true;
    try {
      lstatSync(cur);
    } catch {
      exists = false;
    }
    if (exists) {
      let real: string;
      try {
        real = realpathSync(cur);
      } catch {
        throw new PathsError(
          `${what} 经过悬空或不可解析的符号链接,无法判断是否位于 out/ 之下:${abs}`,
        );
      }
      return rest.length === 0 ? real : path.join(real, ...rest.reverse());
    }
    const parent = path.dirname(cur);
    if (parent === cur) return abs;
    rest.push(path.basename(cur));
    cur = parent;
  }
}

/**
 * KIT_STATE_DIR / KIT_TMP 不得等于或位于 out/ 之下:build 只许写 out/,状态与临时文件落进去会污染交付物。
 * 字面路径和解析后的真实路径(out 是链接、上级是链接、目标经链接指进 out/)各比一遍,任一命中即拒。
 * out/ 自身无法解析(悬空链接)时只能比字面路径,build 写入时 safe-fs 仍会拒绝悬空链接。
 */
function assertNotUnderOut(p: string, outDir: string, what: string): void {
  const bad = (): never => {
    throw new PathsError(`${what} 不得位于 out/ 之下(按真实路径判断):${p}`);
  };
  // macOS 默认大小写不敏感,JS realpath 不规范化大小写:比较时统一小写,宁可多拒(OUT/x 等价于 out/x)
  const norm = (x: string): string => x.normalize('NFC').toLowerCase();
  const under = (a: string, b: string): boolean => isAncestorOrEqual(norm(a), norm(b));
  if (under(outDir, p)) bad();
  const realP = realResolve(p, what);
  let realOut: string | undefined;
  try {
    realOut = realResolve(outDir, 'out/');
  } catch {
    realOut = undefined;
  }
  if (realOut !== undefined && under(realOut, realP)) bad();
  if (under(outDir, realP)) bad();
  // 同一目录的另一种写法(firmlink、Unicode NFD)字符串比较认不出:再按文件身份(dev,ino)比一遍
  const ident = (x: string): string | undefined => {
    try {
      const st = statSync(x);
      return `${st.dev}:${st.ino}`;
    } catch {
      return undefined;
    }
  };
  const outId = ident(outDir);
  const repoId = ident(path.dirname(outDir));
  let child: string | undefined;
  for (let cur = realP; ; cur = path.dirname(cur)) {
    const id = ident(cur);
    if (id !== undefined) {
      if (outId !== undefined && id === outId) bad();
      if (id === repoId && child !== undefined && norm(child) === 'out') bad();
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    child = path.basename(cur);
  }
}

/**
 * KIT_STATE_DIR 不得等于或是 out/ 的上级(含仓库根与仓库的上级):它是默认写入根,
 * 一旦覆盖 out/ 的上级,写入根就扩大到整棵仓库(src/、kit.toml 都可写),形同取消写出口。
 * 字面、真实路径、文件身份(dev,ino)各比一遍,与 assertNotUnderOut 同一思路;大小写不敏感。
 * KIT_TMP 不在此列:测试与 CI 把仓库建在 KIT_TMP 之下是现有的合法用法(其是否也应收紧待主代理定夺)。
 */
function assertNotAncestorOfOut(p: string, outDir: string, what: string): void {
  const bad = (): never => {
    throw new PathsError(`${what} 不得是 out/ 的上级(含仓库根),否则写入根会扩大到 out/ 之外:${p}`);
  };
  const norm = (x: string): string => x.normalize('NFC').toLowerCase();
  const above = (a: string, b: string): boolean => isAncestorOrEqual(norm(a), norm(b));
  if (above(p, outDir)) bad();
  const realP = realResolve(p, what);
  let realOut: string | undefined;
  try {
    realOut = realResolve(outDir, 'out/');
  } catch {
    realOut = undefined;
  }
  if (above(realP, outDir)) bad();
  if (realOut !== undefined && above(realP, realOut)) bad();
  const ident = (x: string): string | undefined => {
    try {
      const st = statSync(x);
      return `${st.dev}:${st.ino}`;
    } catch {
      return undefined;
    }
  };
  const pId = ident(realP) ?? ident(p);
  if (pId !== undefined) {
    for (let cur = realOut ?? outDir; ; cur = path.dirname(cur)) {
      if (ident(cur) === pId) bad();
      const parent = path.dirname(cur);
      if (parent === cur) break;
    }
  }
}

/** (dev,ino) 身份;不存在返回 undefined。 */
function identOf(x: string): string | undefined {
  try {
    const st = statSync(x);
    return `${st.dev}:${st.ino}`;
  } catch {
    return undefined;
  }
}

/**
 * candidate(已 realResolve)是否位于 scope(已 realResolve)之内或等于它。
 * 放行条件,所以字符串比较**大小写精确**(区分大小写的卷上 State 与 state 是两个目录);
 * 另沿 candidate 的祖先链比 (dev,ino),认出大小写不敏感卷 / NFD / firmlink 写法的同一目录。
 */
function insideByIdentity(candidate: string, scope: string): boolean {
  if (isAncestorOrEqual(scope, candidate)) return true;
  const sid = identOf(scope);
  if (sid === undefined) return false;
  for (let cur = candidate; ; cur = path.dirname(cur)) {
    if (identOf(cur) === sid) return true;
    const parent = path.dirname(cur);
    if (parent === cur) return false;
  }
}

/**
 * 有效写入根(realpath 之后)的包含检查,createIoContext 与 safe-fs 的每次写入共用:
 * - (a) 每个 writeRoots 项的真实位置必须位于真实的仓库根或 KIT_TMP 之内;
 * - (b) 且位于真实的 out/、state、KIT_TMP 之一之内(KIT_WRITE_ROOTS 只能收窄,经符号链接也不例外)。
 * 悬空 / 不可解析的链接无法判断落点,一律算违规(fail-closed)。返回违规描述,无违规返回 undefined。
 * 已知不覆盖:仓库本身位于 KIT_TMP 之下时,指向仓库的链接仍落在 KIT_TMP 这个默认根内(KIT_TMP 范围未决,保持现状)。
 */
export function findWriteRootEscape(
  ctx: Pick<IoContext, 'repoRoot' | 'outDir' | 'stateDir' | 'tmpDir' | 'writeRoots'>,
  home: string = getRealHome(),
): string | undefined {
  try {
    // out/ 与 state 的最后一段不得是指向别处的链接(指向仓库内其它目录会把 base 一并带偏,如 out -> src)
    const ownPlace = (x: string, what: string): string => {
      const real = realResolve(x, what);
      let isLink = false;
      try {
        isLink = lstatSync(x).isSymbolicLink();
      } catch {
        // 尚不存在:没有链接问题
      }
      if (isLink) throw new PathsError(`${what} 是符号链接,拒绝作为写入根:${x}`);
      return real;
    };
    // 真实 HOME(及其上级、文件系统根)不得成为写入范围:KIT_TMP 等字面路径过了 HOME 守卫,链接解析后可能落进去
    const homes = [home];
    try {
      homes.push(realResolve(home, 'HOME'));
    } catch {
      // HOME 不可解析:只比字面路径
    }
    const notHome = (r: string, what: string): string => {
      if (r === path.parse(r).root || homes.some((h) => isAncestorOrEqual(r, h))) {
        throw new PathsError(`${what} 的真实位置(符号链接解析后)是 HOME 或其上级:${r}`);
      }
      return r;
    };
    const scopes = [notHome(realResolve(ctx.repoRoot, '仓库根'), '仓库根')];
    const bases = [ownPlace(ctx.outDir, 'out/'), ownPlace(ctx.stateDir, 'state')];
    if (ctx.tmpDir !== undefined) {
      const t = notHome(realResolve(ctx.tmpDir, 'KIT_TMP'), 'KIT_TMP');
      scopes.push(t);
      bases.push(t);
    }
    for (const root of ctx.writeRoots) {
      const r = notHome(realResolve(root, '写入根'), '写入根');
      if (!scopes.some((s) => insideByIdentity(r, s))) {
        return `写入根的真实位置(符号链接解析后)逃出仓库 / KIT_TMP:${root}`;
      }
      if (!bases.some((b) => insideByIdentity(r, b))) {
        return `写入根的真实位置不在 out/、state、KIT_TMP 之内(符号链接绕过收窄):${root}`;
      }
    }
    return undefined;
  } catch (e) {
    if (e instanceof PathsError) return e.message;
    throw e;
  }
}

function assertNotHomeOrAncestor(p: string, home: string, what: string): void {
  if (p === path.parse(p).root) throw new PathsError(`${what} 不得是文件系统根 /`);
  if (isAncestorOrEqual(p, home)) {
    throw new PathsError(`${what} 不得是 HOME 本身或其上级:${p}`);
  }
}

/**
 * KIT_WRITE_ROOTS 只能**收窄**:每一项必须落在默认根(out/、state、KIT_TMP)之内。
 * 否则 `KIT_WRITE_ROOTS=$HOME` 这类设置会让整个写出口形同虚设。
 */
function parseWriteRoots(raw: string, bases: readonly string[], home: string): string[] {
  const roots: string[] = [];
  for (const piece of raw.split(path.delimiter)) {
    if (piece === '') continue;
    if (!path.isAbsolute(piece)) {
      throw new PathsError(`KIT_WRITE_ROOTS 只接受绝对路径,收到相对路径:${piece}`);
    }
    const root = path.resolve(piece);
    assertNotHomeOrAncestor(root, home, 'KIT_WRITE_ROOTS 的条目');
    if (!bases.some((b) => isAncestorOrEqual(b, root))) {
      throw new PathsError(
        `KIT_WRITE_ROOTS 只能收窄到默认根(out/、state、KIT_TMP)之内,越界:${root}`,
      );
    }
    roots.push(root);
  }
  return roots;
}

export function createIoContext(opts: CreateIoContextOptions = {}): IoContext {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const home = getRealHome(env);
  const repoRoot = opts.root
    ? path.resolve(cwd, opts.root)
    : (findUp(cwd, 'kit.toml') ?? path.resolve(cwd));
  assertNotHomeOrAncestor(repoRoot, home, '仓库根');
  const outDir = path.join(repoRoot, 'out');

  const tmpRaw = env['KIT_TMP'];
  const tmpDir = tmpRaw ? path.resolve(tmpRaw) : undefined;
  if (tmpDir !== undefined) assertNotHomeOrAncestor(tmpDir, home, 'KIT_TMP');
  if (tmpDir !== undefined) assertNotUnderOut(tmpDir, outDir, 'KIT_TMP');

  // P0:state 只能在仓库内或 KIT_TMP 内;~/.local/state/<kit>/ 留到 P2(Q-N13),届时改这里。
  const stateRaw = env['KIT_STATE_DIR'];
  const stateDir = stateRaw ? path.resolve(repoRoot, stateRaw) : path.join(repoRoot, '.state');
  assertNotUnderOut(stateDir, outDir, 'KIT_STATE_DIR');
  assertNotAncestorOfOut(stateDir, outDir, 'KIT_STATE_DIR');
  if (!isAncestorOrEqual(repoRoot, stateDir) && !(tmpDir && isAncestorOrEqual(tmpDir, stateDir))) {
    throw new PathsError(`KIT_STATE_DIR 必须在仓库或 KIT_TMP 之内:${stateDir}`);
  }

  const bases = [outDir, stateDir, ...(tmpDir ? [tmpDir] : [])];
  const rootsRaw = env['KIT_WRITE_ROOTS'];
  const writeRoots =
    rootsRaw !== undefined && rootsRaw !== '' ? parseWriteRoots(rootsRaw, bases, home) : bases;

  const ctx: IoContext = {
    repoRoot,
    outDir,
    stateDir,
    writeRoots,
    tmpDir,
    execPath: env['PATH'] ?? '/usr/bin:/bin',
  };
  // 字面路径通过不够:按 realpath(含最长已存在前缀)再判一遍,符号链接不得让有效写入根逃出允许范围
  const escape = findWriteRootEscape(ctx, home);
  if (escape !== undefined) throw new PathsError(escape);
  return ctx;
}
