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
import { existsSync } from './read-fs.js';

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

  // P0:state 只能在仓库内或 KIT_TMP 内;~/.local/state/<kit>/ 留到 P2(Q-N13),届时改这里。
  const stateRaw = env['KIT_STATE_DIR'];
  const stateDir = stateRaw ? path.resolve(repoRoot, stateRaw) : path.join(repoRoot, '.state');
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
