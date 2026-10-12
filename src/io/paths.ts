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
  if (!isAncestorOrEqual(repoRoot, stateDir) && !(tmpDir && isAncestorOrEqual(tmpDir, stateDir))) {
    throw new PathsError(`KIT_STATE_DIR 必须在仓库或 KIT_TMP 之内:${stateDir}`);
  }

  const bases = [outDir, stateDir, ...(tmpDir ? [tmpDir] : [])];
  const rootsRaw = env['KIT_WRITE_ROOTS'];
  const writeRoots =
    rootsRaw !== undefined && rootsRaw !== '' ? parseWriteRoots(rootsRaw, bases, home) : bases;

  return {
    repoRoot,
    outDir,
    stateDir,
    writeRoots,
    tmpDir,
    execPath: env['PATH'] ?? '/usr/bin:/bin',
  };
}
