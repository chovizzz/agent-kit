/**
 * 已安装版本的**只读**视图(D-AU1 / D-AU2;docs/contracts.md §20.19 订正段;评审 H2-B / M4 / M6)。
 *
 * 从 `install.ts` 拆出来的零网络、零写入部分:状态读取、`current` 解析、完整树校验、共享判据 {@link decideCurrent}。
 * 钩子入口(`rsi poke|hint`、`__rsi --background`)经 `self-spawn.ts` 引用它做「是否转发到 `current`」的判定,所以本文件的 import 闭包
 * **不得**含 `io/net.ts`、`install.ts`、`launcher.ts`、`registry.ts`、`provenance.ts`、`tar.ts`、`io/home-fs.ts`(eslint 授权块 + `test/rsi/import-closure.test.ts` 钉死)。
 * `install.ts` 从这里 import 并 re-export 既有导出,外部调用点不变。**不含**任何写动作(`ensureControlledTmp` / `writeUpdateState` 留在 `install.ts`)。
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { truthyEnv } from '../contracts/ci-env.js';
import { SEMVER_RE } from '../contracts/common.js';
import { PayloadIntegritySchema } from '../contracts/payload.js';
import type { UpdateState } from '../contracts/update.js';
import { probePath } from '../io/probe.js';
import { lstat, readBytes, readDir, realpath } from '../io/read-fs.js';
import { compareSemver, parseSemver } from './policy.js';
import { parseUpdateState } from './state.js';

// ---------------------------------------------------------------------------
// 路径与常量
// ---------------------------------------------------------------------------

export const SHARE_REL = '.local/share/agent-kit';
export const UPDATE_STATE_DIR_REL = '.local/state/agent-kit/update';
export const UPDATE_STATE_FILE_REL = `${UPDATE_STATE_DIR_REL}/state.json`;
export const VERSIONS_REL = `${SHARE_REL}/versions`;
/**
 * `current` 链接的相对位置。与 `io/home-fs.ts` 的 `CURRENT_LINK_REL` 同值(此处不 import 它:home-fs 是写出口,不能进钩子闭包;
 * `test/update/installed.test.ts` 钉两者相等)。
 */
export const CURRENT_LINK_REL_RO = `${SHARE_REL}/current`;
/** 后台 worker 的受控 TMPDIR(同 `install.ts` 的 `UPDATE_TMP_REL`,`test/update/installed.test.ts` 钉相等) */
export const UPDATE_TMP_REL_RO = `${UPDATE_STATE_DIR_REL}/tmp`;
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_WALK_ENTRIES = 20_000;
const MAX_WALK_DEPTH = 16;

export const sha256Hex = (b: Uint8Array | string): string =>
  createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------------------
// 只读探测
// ---------------------------------------------------------------------------

/** rel 路径上任一已存在段是符号链接 / 不是目录 → true(状态目录不安全) */
export async function chainUnsafe(home: string, rel: string): Promise<boolean> {
  let cur = home;
  for (const seg of rel.split('/')) {
    cur = path.join(cur, seg);
    let st;
    try {
      st = await lstat(cur);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return false;
      return true;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return true;
  }
  return false;
}

export type StateRead =
  | { kind: 'absent' }
  | { kind: 'unsafe' }
  | { kind: 'unreadable' }
  | { kind: 'ok'; state: UpdateState };

export async function readUpdateState(home: string): Promise<StateRead> {
  if ((await chainUnsafe(home, UPDATE_STATE_DIR_REL)) || (await chainUnsafe(home, SHARE_REL))) {
    return { kind: 'unsafe' };
  }
  const p = await probePath(home, UPDATE_STATE_FILE_REL);
  if (p.entry.kind === 'missing')
    return p.entry.linkedSegment === true ? { kind: 'unsafe' } : { kind: 'absent' };
  if (
    p.entry.kind !== 'file' ||
    p.text === undefined ||
    Buffer.byteLength(p.text) > MAX_STATE_BYTES
  ) {
    return { kind: 'unreadable' };
  }
  const r = parseUpdateState(p.text);
  return r.ok ? { kind: 'ok', state: r.state } : { kind: 'unreadable' };
}

/** `current` 指向的版本(仅当它是符号链接且真实路径严格位于 versions/ 内);否则 undefined */
export async function currentVersionOf(home: string): Promise<string | undefined> {
  try {
    const link = path.join(home, ...CURRENT_LINK_REL_RO.split('/'));
    if (!(await lstat(link)).isSymbolicLink()) return undefined;
    const versions = await realpath(path.join(home, ...VERSIONS_REL.split('/')));
    const real = await realpath(link);
    const rel = path.relative(versions, real);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) {
      return undefined;
    }
    return SEMVER_RE.test(rel) ? rel : undefined;
  } catch {
    return undefined;
  }
}

export interface Walked {
  files: string[];
  dirs: string[];
  /** 链接 / 特殊文件 / 超出上限:不能当普通树处理 */
  irregular: boolean;
}

/** 列出 root 下的普通文件与目录(相对路径,POSIX);遇到符号链接 / 特殊文件 / 超限置 irregular */
export async function walkTree(root: string): Promise<Walked> {
  const out: Walked = { files: [], dirs: [], irregular: false };
  let budget = MAX_WALK_ENTRIES;
  const visit = async (rel: string, depth: number): Promise<void> => {
    if (depth > MAX_WALK_DEPTH) {
      out.irregular = true;
      return;
    }
    const entries = await readDir(rel === '' ? root : path.join(root, ...rel.split('/')));
    for (const e of entries) {
      if (--budget < 0) {
        out.irregular = true;
        return;
      }
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isSymbolicLink) out.irregular = true;
      else if (e.isDirectory) {
        out.dirs.push(r);
        await visit(r, depth + 1);
      } else if (e.isFile) out.files.push(r);
      else out.irregular = true;
    }
  };
  await visit('', 0);
  return out;
}

export type TreeCheck =
  | { ok: true; anchor: string }
  | {
      ok: false;
      reason:
        | 'integrity_missing'
        | 'integrity_invalid'
        | 'anchor_mismatch'
        | 'version_mismatch'
        | 'irregular'
        | 'file_set'
        | 'file_mismatch'
        | 'bin_mode';
    };

/**
 * 磁盘上一棵已安装版本树的完整校验(回滚前、staging 写完后复核用):
 * integrity.json 是普通文件(非链接、nlink=1)→ 其 sha256 等于 `anchor`(给了的话)→ 过 schema、`kit_version` 等于 `version`(给了的话)
 * → 树里没有符号链接 / 特殊文件,文件集合与 integrity.files ∪ {integrity.json} 严格相等 → 逐文件 sha256 + 字节数。
 * `want.binExecutable`(包根相对路径,只有安装器读回 staging 时给):该文件的权限必须恰为 0755(D-AU3:bin 在 staging 里统一设为 0755);
 * 回滚 / 启动器 / 自动同步校验已安装版本时不给,不对权限提额外要求。
 */
export async function verifyInstalledTree(
  rootAbs: string,
  want: { anchor?: string; version?: string; binExecutable?: string } = {},
): Promise<TreeCheck> {
  const ipath = path.join(rootAbs, 'integrity.json');
  let ibytes: Uint8Array;
  try {
    const st = await lstat(ipath);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink > 1 || st.size > MAX_STATE_BYTES) {
      return { ok: false, reason: 'integrity_missing' };
    }
    ibytes = await readBytes(ipath);
  } catch {
    return { ok: false, reason: 'integrity_missing' };
  }
  const anchor = sha256Hex(ibytes);
  if (want.anchor !== undefined && want.anchor !== anchor)
    return { ok: false, reason: 'anchor_mismatch' };
  let files: { path: string; sha256: string; bytes: number }[];
  try {
    const parsed = PayloadIntegritySchema.parse(JSON.parse(Buffer.from(ibytes).toString('utf8')));
    if (want.version !== undefined && parsed.kit_version !== want.version) {
      return { ok: false, reason: 'version_mismatch' };
    }
    files = parsed.files;
  } catch {
    return { ok: false, reason: 'integrity_invalid' };
  }
  let walked: Walked;
  try {
    walked = await walkTree(rootAbs);
  } catch {
    return { ok: false, reason: 'irregular' };
  }
  if (walked.irregular) return { ok: false, reason: 'irregular' };
  const listed = new Set([...files.map((f) => f.path), 'integrity.json']);
  if (walked.files.length !== listed.size || !walked.files.every((f) => listed.has(f))) {
    return { ok: false, reason: 'file_set' };
  }
  for (const f of files) {
    const abs = path.join(rootAbs, ...f.path.split('/'));
    try {
      const st = await lstat(abs);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink > 1)
        return { ok: false, reason: 'file_mismatch' };
      const b = await readBytes(abs);
      if (b.byteLength !== f.bytes || sha256Hex(b) !== f.sha256)
        return { ok: false, reason: 'file_mismatch' };
    } catch {
      return { ok: false, reason: 'file_mismatch' };
    }
  }
  if (want.binExecutable !== undefined) {
    try {
      const st = await lstat(path.join(rootAbs, ...want.binExecutable.split('/')));
      if (!st.isFile() || (st.mode & 0o777) !== 0o755) return { ok: false, reason: 'bin_mode' };
    } catch {
      return { ok: false, reason: 'bin_mode' };
    }
  }
  return { ok: true, anchor };
}

/**
 * 只读版的受控 TMPDIR 检查(评审 H2-B):`~/.local/state/agent-kit/update/tmp` 必须已存在,链上无符号链接、是目录、
 * 属主是自己、权限不含 group/other 位;任何一步不满足返回 undefined。**从不创建**——创建由 `install.ts` 的
 * `ensureControlledTmp` 在前台命令里完成(已存在则零写入)。
 */
export async function checkControlledTmp(home: string): Promise<string | undefined> {
  try {
    if (await chainUnsafe(home, UPDATE_STATE_DIR_REL)) return undefined;
    const abs = path.join(home, ...UPDATE_TMP_REL_RO.split('/'));
    const st = await lstat(abs);
    if (st.isSymbolicLink() || !st.isDirectory()) return undefined;
    if ((st.mode & 0o077) !== 0) return undefined;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return undefined;
    return abs;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 共享判据:是否转发到 current(启动器与钩子入口共用同一份实现)
// ---------------------------------------------------------------------------

export const versionRootOf = (home: string, version: string): string =>
  `${home}/${SHARE_REL}/versions/${version}`;

const majorOf = (v: string): string => v.split(/[.-]/)[0] ?? '';

/** 「没启动但算损坏」的原因(启动器据此向 stderr 报 `UPDATE_CURRENT_BROKEN reason=…`;钩子一律静默) */
export type CurrentBroken =
  'state' | 'current' | 'version_mismatch' | 'version' | 'anchor' | 'tree';

export type CurrentDecision =
  /** 用自己:没有可转发的 current,且不算损坏(KIT_LAUNCHED / 无状态 / 无 installed / 相同或更低或跨 major) */
  | { launch: false }
  /** 用自己:安装状态与磁盘对不上 */
  | { launch: false; broken: CurrentBroken }
  /** 转发到 `current` 里的这个版本(树已校验,调用方 spawn `target: { kind: 'current', version }`) */
  | { launch: true; version: string };

export interface DecideCurrentDeps {
  readState?: typeof readUpdateState;
  readCurrent?: typeof currentVersionOf;
  verifyTree?: typeof verifyInstalledTree;
}

/**
 * 是否转发到 `current`(契约 §19.5 启动器、§20.19 D-AU1;启动器 `launchCurrent` 与钩子 `forwardHookToCurrent` 共用)。
 * 短路顺序固定(评审 M4,最便宜的先判):KIT_LAUNCHED(truthy 口径,`0` 视为未设)→ state → current 版本 → installed 对齐 →
 * semver / 严格更高且同 major → 完整树校验(最贵,最后)。state 三态(评审 M6):absent / 无 installed → 静默用自己;
 * unsafe / unreadable → broken('state')。只读、从不抛(读取层的异常按「对不上」处理)。
 */
export async function decideCurrent(
  input: { home: string; env: Readonly<Record<string, string | undefined>>; own: string },
  deps: DecideCurrentDeps = {},
): Promise<CurrentDecision> {
  if (truthyEnv(input.env['KIT_LAUNCHED'])) return { launch: false };
  const state = await (deps.readState ?? readUpdateState)(input.home);
  if (state.kind === 'absent') return { launch: false };
  if (state.kind !== 'ok') return { launch: false, broken: 'state' };
  const installed = state.state.installed;
  if (installed === undefined) return { launch: false };

  const cur = await (deps.readCurrent ?? currentVersionOf)(input.home);
  if (cur === undefined) return { launch: false, broken: 'current' };
  if (cur !== installed.version) return { launch: false, broken: 'version_mismatch' };

  const a = parseSemver(cur);
  const b = parseSemver(input.own);
  if (a === undefined || b === undefined) return { launch: false, broken: 'version' };
  // 只有「更高且同 major」才转发:相同 / 更低 / 跨 major 都用自己,且不算损坏
  if (compareSemver(a, b) <= 0 || majorOf(cur) !== majorOf(input.own)) return { launch: false };

  const tree = await (deps.verifyTree ?? verifyInstalledTree)(versionRootOf(input.home, cur), {
    anchor: installed.anchor,
    version: cur,
  });
  if (!tree.ok)
    return { launch: false, broken: tree.reason === 'anchor_mismatch' ? 'anchor' : 'tree' };
  return { launch: true, version: cur };
}

/**
 * 后台 update worker 由谁来跑:`current` 通过「安装记录对齐 + 完整树校验」就由 current 起(最新代码),否则用本进程所在的包(引导版本)——
 * 信任不高于当前进程自己。不要求 current 更高(与既有 `scheduleBackground` 同口径)。
 */
export async function pickWorkerTarget(
  home: string,
  st: StateRead,
  deps: Pick<DecideCurrentDeps, 'readCurrent' | 'verifyTree'> = {},
): Promise<{ kind: 'current'; version: string } | { kind: 'self' }> {
  const installed = st.kind === 'ok' ? st.state.installed : undefined;
  const cur = await (deps.readCurrent ?? currentVersionOf)(home);
  if (cur === undefined || installed === undefined || cur !== installed.version) {
    return { kind: 'self' };
  }
  const tree = await (deps.verifyTree ?? verifyInstalledTree)(versionRootOf(home, cur), {
    anchor: installed.anchor,
    version: cur,
  });
  return tree.ok ? { kind: 'current', version: cur } : { kind: 'self' };
}
