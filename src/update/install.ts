/**
 * 自动更新的安装器(S7c-A;docs/contracts.md §19.5 / §19.7)。**本文件是 update 模块里唯一引用 `src/io/home-fs.ts` 的文件**
 * (eslint 授权闸):安装目录 `~/.local/share/agent-kit/` 与状态目录 `~/.local/state/agent-kit/update/` 的所有写入都从这里经 home-fs。
 *
 * 信任链(任一环失败即停,fail-closed):
 *   tarball 字节(内存)→ sha512 对 dist.integrity(镜像时只作提示)→ 同一份 attestations 文档先做未验签预检(仅早退)
 *   → {@link verifyProvenance}(**它的返回值是唯一信任源**:Fulcio/Rekor/DSSE 验签,身份钉死,subject 摘要 = 这份内存字节)
 *   → 验签通过后才 `readTgz` 解包 → 包内 `integrity.json`:解出的文件集合必须与它列出的集合严格相等,逐文件 sha256 + 字节数,
 *   `kit_version` / `package.json` 的名字与版本等于目标 → 其原始字节的 sha256 记为外部锚点 `installed.anchor`
 *   → 经 home-fs 写入 staging、读回复核 → 静态冒烟 → 改名为 `versions/<v>` → 原子切换 `current` → 写状态 → gc。
 * 全程不执行包内任何代码、不跑 lifecycle 脚本。
 *
 * 不进 `bad_versions`(问题不在该版本):trust_root_stale / tuf_unreachable / attestations_unreachable / 网络类 / 本机 IO 错误 /
 * 写出口拒绝 / 镜像模式下 tarball 摘要与已验签 subject 不符 / 不认识的异常(internal)/ 刚发布不久(< 24h)时的 provenance_missing。
 *
 * 已知残余:home-fs 的校验与使用之间有竞态窗口(Node 无 openat);tuf-js 联网刷新会在 os.tmpdir() 建临时目录(见 provenance.ts),
 * 本文件不改 TMPDIR(process.env 只许 paths.ts 触碰),S7c-B 的后台 worker 以子进程方式启动时由启动器传受控 TMPDIR。
 */
import { createHash, randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { z } from 'zod';
import { SEMVER_RE } from '../contracts/common.js';
import { PayloadIntegritySchema } from '../contracts/payload.js';
import {
  PACKAGE_NAME,
  UPDATE_KEEP_VERSIONS,
  UPDATE_LOCK_TTL_MINUTES,
} from '../contracts/update.js';
import type { UpdateState } from '../contracts/update.js';
import { canonicalJson } from '../io/canonical-json.js';
import { NetError } from '../io/net.js';
import {
  CURRENT_LINK_REL,
  HOME_DENY,
  HomeExistsError,
  HomeWriteDeniedError,
  createExclusive,
  createHomeFsContext,
  mkdirp,
  remove,
  removeDir,
  renameDir,
  switchCurrent,
  writeFile,
  type HomeFsContext,
  type HomeFsStage,
} from '../io/home-fs.js';
import { lstat, readBytes, readDir, realpath } from '../io/read-fs.js';
import { probePath } from '../sync/snapshot.js';
import {
  markBad,
  markInstalled,
  markNotified,
  parseUpdateState,
  recordCheck,
  serializeUpdateState,
} from './state.js';
import { verifyTarballBinding } from './policy.js';
import { verifyProvenance, type ProvenanceVerifier } from './provenance.js';
import { toPolicyAttestations, type RegistrySource } from './registry.js';
import { TarError, readTgz, type TarListing } from './tar.js';

// ---------------------------------------------------------------------------
// 路径与常量
// ---------------------------------------------------------------------------

export const SHARE_REL = '.local/share/agent-kit';
export const UPDATE_STATE_DIR_REL = '.local/state/agent-kit/update';
export const UPDATE_STATE_FILE_REL = `${UPDATE_STATE_DIR_REL}/state.json`;
export const UPDATE_LOCK_REL = `${UPDATE_STATE_DIR_REL}/lock`;
const VERSIONS_REL = `${SHARE_REL}/versions`;
const STAGING_REL = `${SHARE_REL}/staging`;
const TUF_REL = `${SHARE_REL}/tuf`;
/** 后台 worker 的受控 TMPDIR(tuf-js 联网刷新在 os.tmpdir() 下建临时目录) */
export const UPDATE_TMP_REL = `${UPDATE_STATE_DIR_REL}/tmp`;
export const UPDATE_LOG_REL = `${UPDATE_STATE_DIR_REL}/log`;
const SENTINEL = '.rm-sentinel';

export const UPDATE_LOCK_TTL_MS = UPDATE_LOCK_TTL_MINUTES * 60 * 1000;
/** 锁文件解析失败但创建不满这么久:视为「正在写」,按被持有处理 */
export const LOCK_PARTIAL_GRACE_MS = 10_000;
/** 刚发布不到这么久就取不到 provenance:按 npm 半可见期处理(not_ready),不拉黑 */
export const PROVENANCE_GRACE_HOURS = 24;
const STATE_FILE_MODE = 0o600;
const STATE_DIR_MODE = 0o700;
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_WALK_ENTRIES = 20_000;
const MAX_WALK_DEPTH = 16;

const defaultRandomHex = (bytes: number): string => randomBytes(bytes).toString('hex');
const sha256Hex = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

export interface InstallDeps {
  now?: () => Date;
  randomHex?: (bytes: number) => string;
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
  /** 验签器(缺省用 sigstore);测试注入 */
  verifier?: ProvenanceVerifier;
  /**
   * 冒烟的真执行钩子(S7c-B:`src/update/launcher.ts` 的 `smokeCandidate`,经 runSelf 跑 `staging/st-<hex>/dist/cli.js --version`)。
   * 默认只做静态冒烟;传入时在静态冒烟与读回复核之后、改名之前调用,返回 false / 抛错都算冒烟失败。
   * 参数:HOME、staging 目录的绝对路径、目标版本。
   */
  smoke?: (c: { home: string; stagingAbs: string; version: string }) => boolean | Promise<boolean>;
  /** 测试注入口:在命名点抛错,模拟崩溃 / IO 错误。产品代码不传。 */
  inject?: (point: string) => void | Promise<void>;
  onStage?: (stage: HomeFsStage) => void | Promise<void>;
}

export interface InstallEnv {
  /** 已通过 resolveAllowedHome 的 HOME 真实路径 */
  home: string;
  tmpDir: string | undefined;
  env: Readonly<Record<string, string | undefined>> | undefined;
  deps: InstallDeps;
}

function mkCtx(env: InstallEnv, scope: readonly string[]): HomeFsContext {
  return createHomeFsContext({
    home: env.home,
    planScope: scope,
    tmpDir: env.tmpDir,
    ...(env.env !== undefined ? { env: env.env } : {}),
    ...(env.deps.onStage !== undefined ? { onStage: env.deps.onStage } : {}),
  });
}

const nowOf = (env: InstallEnv): Date => (env.deps.now ?? ((): Date => new Date()))();
const inject = async (env: InstallEnv, point: string): Promise<void> => {
  await env.deps.inject?.(point);
};

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
    const link = path.join(home, ...CURRENT_LINK_REL.split('/'));
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

interface Walked {
  files: string[];
  dirs: string[];
  /** 链接 / 特殊文件 / 超出上限:不能当普通树处理 */
  irregular: boolean;
}

/** 列出 root 下的普通文件与目录(相对路径,POSIX);遇到符号链接 / 特殊文件 / 超限置 irregular */
async function walkTree(root: string): Promise<Walked> {
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
        | 'file_mismatch';
    };

/**
 * 磁盘上一棵已安装版本树的完整校验(回滚前、staging 写完后复核用):
 * integrity.json 是普通文件(非链接、nlink=1)→ 其 sha256 等于 `anchor`(给了的话)→ 过 schema、`kit_version` 等于 `version`(给了的话)
 * → 树里没有符号链接 / 特殊文件,文件集合与 integrity.files ∪ {integrity.json} 严格相等 → 逐文件 sha256 + 字节数。
 */
export async function verifyInstalledTree(
  rootAbs: string,
  want: { anchor?: string; version?: string } = {},
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
  return { ok: true, anchor };
}

// ---------------------------------------------------------------------------
// 状态写入
// ---------------------------------------------------------------------------

export async function writeUpdateState(env: InstallEnv, state: UpdateState): Promise<void> {
  const ctx = mkCtx(env, [UPDATE_STATE_FILE_REL]);
  await writeFile(ctx, UPDATE_STATE_FILE_REL, serializeUpdateState(state), {
    mode: STATE_FILE_MODE,
    dirMode: STATE_DIR_MODE,
  });
}

/**
 * 后台 worker / 冒烟用的受控 TMPDIR:`~/.local/state/agent-kit/update/tmp`(0700)。spawn 之前创建并复核
 * (链上无符号链接、是目录、属主是自己、权限不含 group/other 位);任何一步不满足返回 undefined(调用方不启动后台任务)。
 */
export async function ensureControlledTmp(env: InstallEnv): Promise<string | undefined> {
  try {
    if (await chainUnsafe(env.home, UPDATE_STATE_DIR_REL)) return undefined;
    const ctx = mkCtx(env, [`${UPDATE_TMP_REL}/${SENTINEL}`]);
    await mkdirp(ctx, UPDATE_TMP_REL, STATE_DIR_MODE);
    const abs = path.join(env.home, ...UPDATE_TMP_REL.split('/'));
    const st = await lstat(abs);
    if (st.isSymbolicLink() || !st.isDirectory()) return undefined;
    if ((st.mode & 0o077) !== 0) return undefined;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return undefined;
    return abs;
  } catch {
    return undefined;
  }
}

/** worker 的稳定码日志(只此一行:最近一次结果;不含异常消息 / 路径)。写失败吞掉——日志不能影响更新本身。 */
export async function writeWorkerLog(env: InstallEnv, code: string): Promise<void> {
  if (!/^[a-z_]{1,40}$/.test(code)) return;
  try {
    if (await chainUnsafe(env.home, UPDATE_STATE_DIR_REL)) return;
    const ctx = mkCtx(env, [UPDATE_LOG_REL]);
    await writeFile(ctx, UPDATE_LOG_REL, `${nowOf(env).toISOString()} ${code}\n`, {
      mode: STATE_FILE_MODE,
      dirMode: STATE_DIR_MODE,
    });
  } catch {
    // 尽力而为
  }
}

// ---------------------------------------------------------------------------
// 锁(`update/lock`)
// ---------------------------------------------------------------------------

export type LockDetail = 'held' | 'held_over_ttl' | 'lost_race' | 'unsafe' | 'lost';

export class UpdateLockError extends Error {
  constructor(readonly detail: LockDetail) {
    super(`UPDATE_LOCK ${detail}`);
    this.name = 'UpdateLockError';
  }
}

const LockDocSchema = z.strictObject({
  pid: z.number().int().positive(),
  started_at: z.string().max(40),
  nonce: z.string().regex(/^[0-9a-f]{16}$/),
});
type LockDoc = z.infer<typeof LockDocSchema>;

export interface UpdateLock {
  /** 提交点前复核:锁文件里的 nonce 仍是自己的;不是 → 抛 UpdateLockError('lost') */
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}

function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

type LockRead =
  | { state: 'absent' }
  | { state: 'unsafe' }
  | { state: 'bad'; ageMs: number }
  | { state: 'ok'; doc: LockDoc };

async function readLock(env: InstallEnv): Promise<LockRead> {
  const p = await probePath(env.home, UPDATE_LOCK_REL);
  if (p.entry.kind === 'missing')
    return p.entry.linkedSegment === true ? { state: 'unsafe' } : { state: 'absent' };
  if (p.entry.kind !== 'file') return { state: 'unsafe' };
  if (p.text !== undefined && Buffer.byteLength(p.text) <= 4096) {
    try {
      return { state: 'ok', doc: LockDocSchema.parse(JSON.parse(p.text)) };
    } catch {
      // 落到 bad
    }
  }
  let mtimeMs = 0;
  try {
    mtimeMs = (await lstat(path.join(env.home, ...UPDATE_LOCK_REL.split('/')))).mtimeMs;
  } catch {
    return { state: 'absent' };
  }
  return { state: 'bad', ageMs: nowOf(env).getTime() - mtimeMs };
}

/**
 * 取锁:`createExclusive`(O_EXCL)。已存在时:
 *  - 持锁 pid 仍在 → 报被持有(超过 TTL 15 分钟也只报不杀,detail=held_over_ttl);
 *  - 内容解析失败但创建不满 {@link LOCK_PARTIAL_GRACE_MS} → 视为正在写,按被持有;
 *  - pid 已不在,或内容损坏且已过宽限期 → 回收:复读确认仍是同一把(nonce 相同 / 仍损坏)→ 删除 → 重试一次。
 * 回收有残余竞态(两个回收者先后删除);关键提交点前另有 {@link UpdateLock.assertHeld} 复核。
 */
export async function acquireUpdateLock(env: InstallEnv): Promise<UpdateLock> {
  const alive = env.deps.isPidAlive ?? defaultAlive;
  const doc: LockDoc = {
    pid: env.deps.pid ?? process.pid,
    started_at: nowOf(env).toISOString(),
    nonce: (env.deps.randomHex ?? defaultRandomHex)(8),
  };
  const ctx = (): HomeFsContext => mkCtx(env, [UPDATE_LOCK_REL]);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await createExclusive(ctx(), UPDATE_LOCK_REL, canonicalJson(doc), {
        mode: STATE_FILE_MODE,
        dirMode: STATE_DIR_MODE,
      });
      const mine = await readLock(env);
      if (mine.state !== 'ok' || mine.doc.nonce !== doc.nonce)
        throw new UpdateLockError('lost_race');
      return {
        async assertHeld() {
          const cur = await readLock(env);
          if (cur.state !== 'ok' || cur.doc.nonce !== doc.nonce) throw new UpdateLockError('lost');
        },
        async release() {
          const cur = await readLock(env);
          if (cur.state === 'ok' && cur.doc.nonce === doc.nonce)
            await remove(ctx(), UPDATE_LOCK_REL);
        },
      };
    } catch (e) {
      if (!(e instanceof HomeExistsError)) throw e;
    }
    const cur = await readLock(env);
    if (cur.state === 'absent') continue;
    if (cur.state === 'unsafe') throw new UpdateLockError('unsafe');
    if (cur.state === 'ok') {
      if (alive(cur.doc.pid)) {
        const age = nowOf(env).getTime() - Date.parse(cur.doc.started_at);
        throw new UpdateLockError(age > UPDATE_LOCK_TTL_MS ? 'held_over_ttl' : 'held');
      }
    } else if (cur.ageMs < LOCK_PARTIAL_GRACE_MS) {
      throw new UpdateLockError('held');
    }
    // 回收:删除前复读,确认还是刚才判定为陈旧的那把
    const again = await readLock(env);
    const same =
      cur.state === 'ok'
        ? again.state === 'ok' && again.doc.nonce === cur.doc.nonce
        : again.state === 'bad';
    if (!same) continue;
    await remove(ctx(), UPDATE_LOCK_REL);
  }
  throw new UpdateLockError('lost_race');
}

// ---------------------------------------------------------------------------
// 目录树清理(只经 home-fs:逐文件 remove、自底向上 removeDir)
// ---------------------------------------------------------------------------

/** 删除 `dirRel` 下整棵树(含自身)。树里有符号链接 / 特殊文件 → 抛错,什么都不删。 */
export async function removeTree(env: InstallEnv, dirRel: string): Promise<void> {
  const abs = path.join(env.home, ...dirRel.split('/'));
  const walked = await walkTree(abs);
  if (walked.irregular) throw new HomeWriteDeniedError(HOME_DENY.NOT_REGULAR, dirRel);
  const dirs = ['', ...walked.dirs];
  const scope = [
    ...walked.files.map((f) => `${dirRel}/${f}`),
    ...dirs.map((d) => (d === '' ? `${dirRel}/${SENTINEL}` : `${dirRel}/${d}/${SENTINEL}`)),
  ];
  const ctx = mkCtx(env, scope);
  for (const f of walked.files) await remove(ctx, `${dirRel}/${f}`);
  for (const d of [...walked.dirs].sort((a, b) => b.length - a.length)) {
    await removeDir(ctx, `${dirRel}/${d}`);
  }
  await removeDir(ctx, dirRel);
}

// ---------------------------------------------------------------------------
// 包内一致性
// ---------------------------------------------------------------------------

const VISIBLE_PATH_RE = /^[\x21-\x7e]+$/;

export type PackageCheck =
  { ok: true; anchor: string; integrityFiles: number } | { ok: false; detail: string };

/** 已验签的 tarball 解包结果 vs 包内 integrity.json / package.json(见文件头) */
export function checkPackage(listing: TarListing, version: string): PackageCheck {
  const byPath = new Map<string, Buffer>();
  for (const f of listing.files) byPath.set(f.path, f.bytes);
  for (const p of [...byPath.keys(), ...listing.dirs]) {
    if (!VISIBLE_PATH_RE.test(p)) return { ok: false, detail: 'path_not_ascii' };
  }
  const ib = byPath.get('integrity.json');
  if (ib === undefined) return { ok: false, detail: 'integrity_missing' };
  let integrity;
  try {
    integrity = PayloadIntegritySchema.parse(JSON.parse(ib.toString('utf8')));
  } catch {
    return { ok: false, detail: 'integrity_invalid' };
  }
  if (integrity.kit_version !== version) return { ok: false, detail: 'integrity_version' };
  const listed = new Set(integrity.files.map((f) => f.path));
  if (byPath.size !== listed.size + 1) return { ok: false, detail: 'file_set' };
  for (const f of integrity.files) {
    const b = byPath.get(f.path);
    if (b === undefined) return { ok: false, detail: 'file_set' };
    if (b.byteLength !== f.bytes || sha256Hex(b) !== f.sha256)
      return { ok: false, detail: 'file_mismatch' };
  }
  const pj = byPath.get('package.json');
  if (pj === undefined) return { ok: false, detail: 'package_json_missing' };
  let pkg: unknown;
  try {
    pkg = JSON.parse(pj.toString('utf8'));
  } catch {
    return { ok: false, detail: 'package_json_invalid' };
  }
  if (typeof pkg !== 'object' || pkg === null) return { ok: false, detail: 'package_json_invalid' };
  const rec = pkg as Record<string, unknown>;
  if (rec['name'] !== PACKAGE_NAME) return { ok: false, detail: 'package_name' };
  if (rec['version'] !== version) return { ok: false, detail: 'package_version' };
  return { ok: true, anchor: sha256Hex(ib), integrityFiles: integrity.files.length };
}

/** 静态冒烟:bin 入口存在、是 dist/ 下的普通文件、带可执行位与 shebang。不执行任何代码。 */
export function staticSmoke(listing: TarListing): { ok: true } | { ok: false; detail: string } {
  const pj = listing.files.find((f) => f.path === 'package.json');
  if (pj === undefined) return { ok: false, detail: 'package_json_missing' };
  let bin: unknown;
  try {
    bin = (JSON.parse(pj.bytes.toString('utf8')) as Record<string, unknown>)['bin'];
  } catch {
    return { ok: false, detail: 'package_json_invalid' };
  }
  const entry =
    typeof bin === 'string'
      ? bin
      : typeof bin === 'object' && bin !== null
        ? (bin as Record<string, unknown>)['agent-kit']
        : undefined;
  if (typeof entry !== 'string' || !/^dist\/[\x21-\x7e]+$/.test(entry) || entry.includes('..')) {
    return { ok: false, detail: 'bin_entry' };
  }
  const f = listing.files.find((x) => x.path === entry);
  if (f === undefined) return { ok: false, detail: 'bin_missing' };
  if (f.mode !== 0o755) return { ok: false, detail: 'bin_not_executable' };
  if (f.bytes.subarray(0, 2).toString('latin1') !== '#!')
    return { ok: false, detail: 'bin_shebang' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 安装
// ---------------------------------------------------------------------------

export type VerifyReason =
  | 'integrity'
  | 'provenance_missing'
  | 'provenance_identity'
  | 'bundle'
  | 'attestations_unreachable'
  | 'trust_root_stale'
  | 'tuf_unreachable'
  | 'tar'
  | 'package'
  | 'smoke'
  | 'host_denied'
  | 'internal';

export type InstallFailure =
  | { kind: 'verify_failed'; reason: VerifyReason; bad: boolean; detail?: string }
  | { kind: 'not_ready'; detail: string }
  | { kind: 'cooldown'; detail: string }
  | { kind: 'net'; code: string }
  | { kind: 'fail_closed'; reason: string };

export interface InstallInput {
  version: string;
  distTarball: string;
  distIntegrity: string | undefined;
  source: RegistrySource;
  mirror: boolean;
  /** 已持有的锁(installVersion 在提交点前复核) */
  lock: UpdateLock;
  /** 锁内重读的最新状态 */
  state: UpdateState;
  cooldown: {
    skip: boolean;
    hours: number;
    /** npmjs 响应 Date 头解析出的「现在」 */
    nowMs: number | undefined;
    /** npmjs time[v] */
    publishedMs: number | undefined;
  };
}

export type InstallResult =
  | {
      ok: true;
      version: string;
      anchor: string;
      state: UpdateState;
      gc: { removed: string[]; failed: number };
    }
  | { ok: false; failure: InstallFailure };

/** `sha512-<b64>`(可多个,空白分隔)里的所有 sha512 摘要都等于 tarball 的;一个 sha512 摘要都没有 → false */
export function sriMatches(integrity: string | undefined, sha512Hex: string): boolean {
  if (integrity === undefined) return false;
  const want = sha512Hex.toLowerCase();
  const tokens = integrity.split(/\s+/).filter((t) => t.startsWith('sha512-'));
  if (tokens.length === 0) return false;
  return tokens.every((t) => {
    const b64 = t.slice('sha512-'.length).split('?')[0] ?? '';
    return (
      /^[A-Za-z0-9+/]+={0,2}$/.test(b64) && Buffer.from(b64, 'base64').toString('hex') === want
    );
  });
}

function failVerify(reason: VerifyReason, bad: boolean, detail?: string): InstallResult {
  return {
    ok: false,
    failure: { kind: 'verify_failed', reason, bad, ...(detail !== undefined ? { detail } : {}) },
  };
}

function classifyFailure(e: unknown): InstallFailure {
  if (e instanceof HomeWriteDeniedError) return { kind: 'fail_closed', reason: 'write_denied' };
  if (e instanceof HomeExistsError) return { kind: 'fail_closed', reason: 'target_exists' };
  if (e instanceof UpdateLockError) return { kind: 'fail_closed', reason: 'lock_lost' };
  return { kind: 'fail_closed', reason: 'io_error' };
}

/**
 * 校验 → 落盘 → 切换 → 记状态 → gc。调用方必须已持有锁、并已在锁内重读 state / packument 重新做过策略决定。
 * 不抛错:全部失败都以 {@link InstallResult} 返回;`bad` 为真的失败由调用方 `markBad`。
 */
export async function installVersion(env: InstallEnv, input: InstallInput): Promise<InstallResult> {
  const { version, source, lock } = input;
  const staging = `${STAGING_REL}/st-${(env.deps.randomHex ?? defaultRandomHex)(6)}`;
  let stagingCreated = false;
  try {
    // 1. 下载(内存)+ sha512
    let tgz;
    try {
      tgz = await source.tarball(input.distTarball);
    } catch (e) {
      if (e instanceof NetError) {
        if (e.code === 'http_404')
          return { ok: false, failure: { kind: 'not_ready', detail: 'tarball_missing' } };
        if (e.code === 'host_denied') return failVerify('host_denied', false);
        return { ok: false, failure: { kind: 'net', code: e.code } };
      }
      throw e;
    }
    if (!input.mirror && !sriMatches(input.distIntegrity, tgz.sha512Hex)) {
      return failVerify('integrity', true, 'dist_integrity');
    }

    // 2. attestations → 预检(仅早退)→ 验签(信任源)
    const att = await source.attestations(version);
    const ageMs =
      input.cooldown.nowMs !== undefined && input.cooldown.publishedMs !== undefined
        ? input.cooldown.nowMs - input.cooldown.publishedMs
        : undefined;
    const young = ageMs === undefined || ageMs < PROVENANCE_GRACE_HOURS * 3_600_000;
    const missing = (): InstallResult =>
      young
        ? { ok: false, failure: { kind: 'not_ready', detail: 'provenance_pending' } }
        : failVerify('provenance_missing', true);
    if (att.kind === 'unreachable') return failVerify('attestations_unreachable', false, att.cause);
    if (att.kind === 'absent') return missing();
    const binding = verifyTarballBinding({
      name: PACKAGE_NAME,
      version,
      tarballSha512Hex: tgz.sha512Hex,
      distIntegrity: input.distIntegrity,
      tarballIntegrity: tgz.integrity,
      mirror: input.mirror,
      attestations: toPolicyAttestations(att),
    });
    // 预检只解析未验签的 JSON:只用来对「没有 attestations / 取不到」早退。其余失败(subject 摘要不符、形状不对)
    // 不据此停止、更不据此拉黑——交给下面的 verifyProvenance 给出经过认证的结论。
    if (!binding.ok) {
      if (binding.reason === 'provenance_missing') return missing();
      if (binding.reason === 'attestations_unreachable')
        return failVerify('attestations_unreachable', false);
    }
    const ctxTuf = mkCtx(env, [`${TUF_REL}/${SENTINEL}`]);
    await mkdirp(ctxTuf, TUF_REL, STATE_DIR_MODE);
    const prov = await verifyProvenance({
      attestationsDoc: att.json,
      tarballSha512Hex: tgz.sha512Hex,
      version,
      tuf: { cachePath: path.join(env.home, ...TUF_REL.split('/')) },
      ...(env.deps.verifier !== undefined ? { verifier: env.deps.verifier } : {}),
    });
    if (!prov.ok) {
      switch (prov.reason) {
        case 'trust_root_stale':
        case 'tuf_unreachable':
          return failVerify(prov.reason, false);
        case 'provenance_missing':
          return missing();
        case 'integrity':
          return failVerify('integrity', !input.mirror, 'subject_sha512');
        case 'provenance_identity':
          return failVerify('provenance_identity', true);
        default: {
          // bundle:库内抛出的 TypeError / RangeError 等不是「bundle 残缺」的证据,更像我们或依赖自己的缺陷 → internal,不拉黑
          const internal = /^(TypeError|RangeError|ReferenceError)\b/.test(prov.cause ?? '');
          return internal ? failVerify('internal', false) : failVerify('bundle', true);
        }
      }
    }

    // 3. 冷却起点 = max(npmjs time[v], 已验签 Rekor integratedTime)(决策 ㉔)。--now 整体豁免。
    if (!input.cooldown.skip) {
      const { nowMs, publishedMs, hours } = input.cooldown;
      if (nowMs === undefined || publishedMs === undefined) {
        return { ok: false, failure: { kind: 'cooldown', detail: 'time_unavailable' } };
      }
      const start = Math.max(publishedMs, prov.integratedTimeMs ?? 0);
      const age = nowMs - start;
      if (age < 0) return { ok: false, failure: { kind: 'cooldown', detail: 'negative_age' } };
      if (age < hours * 3_600_000)
        return { ok: false, failure: { kind: 'cooldown', detail: 'not_elapsed' } };
    }

    // 4. 验签通过后才解包
    let listing: TarListing;
    try {
      listing = readTgz(tgz.bytes);
    } catch (e) {
      if (e instanceof TarError) return failVerify('tar', true, e.code);
      throw e;
    }
    const pkg = checkPackage(listing, version);
    if (!pkg.ok) return failVerify('package', true, pkg.detail);
    const smoke = staticSmoke(listing);
    if (!smoke.ok) return failVerify('smoke', true, smoke.detail);

    // 5. 写 staging(清掉上次崩溃留下的残余——持锁,没有别的安装器在写)
    await lock.assertHeld();
    await cleanStaging(env);
    const finalRel = `${VERSIONS_REL}/${version}`;
    const files = listing.files.map((f) => f.path);
    const scope = [
      ...files.map((f) => `${staging}/${f}`),
      `${staging}/${SENTINEL}`,
      `${finalRel}/${SENTINEL}`,
      ...listing.dirs.map((d) => `${staging}/${d}/${SENTINEL}`),
    ];
    const ctx = mkCtx(env, scope);
    stagingCreated = true;
    await mkdirp(ctx, staging, STATE_DIR_MODE);
    for (const f of listing.files) {
      await writeFile(ctx, `${staging}/${f.path}`, f.bytes, {
        mode: f.mode,
        dirMode: STATE_DIR_MODE,
      });
    }
    await inject(env, 'after-staging-write');
    const stagingAbs = path.join(env.home, ...staging.split('/'));
    const back = await verifyInstalledTree(stagingAbs, { anchor: pkg.anchor, version });
    if (!back.ok)
      return { ok: false, failure: { kind: 'fail_closed', reason: 'staging_mismatch' } };
    if (env.deps.smoke !== undefined) {
      let smokeOk = false;
      try {
        smokeOk = (await env.deps.smoke({ home: env.home, stagingAbs, version })) === true;
      } catch {
        smokeOk = false;
      }
      if (!smokeOk) return failVerify('smoke', true, 'exec');
    }

    // 6. 改名为 versions/<v>(同名残留先清:持锁,且它不是 current)→ 切换 current → 写状态
    await lock.assertHeld();
    const before = await currentVersionOf(env.home);
    if (before === version)
      return { ok: false, failure: { kind: 'fail_closed', reason: 'target_is_current' } };
    if (await dirExists(env.home, finalRel)) await removeTree(env, finalRel);
    await renameDir(ctx, staging, finalRel, STATE_DIR_MODE);
    stagingCreated = false;
    await inject(env, 'after-rename');
    await lock.assertHeld();
    const linkCtx = mkCtx(env, [CURRENT_LINK_REL]);
    try {
      await switchCurrent(linkCtx, version);
    } catch (e) {
      await switchBack(linkCtx, before);
      throw e;
    }
    await inject(env, 'after-switch');
    const nowMs = nowOf(env).getTime();
    const next = recordCheck(markInstalled(input.state, { version, anchor: pkg.anchor, nowMs }), {
      nowMs,
      result: 'installed',
      latestSeen: version,
    });
    try {
      await lock.assertHeld();
      await inject(env, 'before-state-write');
      await writeUpdateState(env, next);
    } catch (e) {
      const reverted = await switchBack(linkCtx, before);
      if (!reverted)
        return { ok: false, failure: { kind: 'fail_closed', reason: 'current_broken' } };
      throw e;
    }
    const gc = await gcVersions(env, next);
    return { ok: true, version, anchor: pkg.anchor, state: next, gc };
  } catch (e) {
    return { ok: false, failure: classifyFailure(e) };
  } finally {
    if (stagingCreated) await removeTree(env, staging).catch(() => undefined);
  }
}

async function switchBack(ctx: HomeFsContext, before: string | undefined): Promise<boolean> {
  try {
    await switchCurrent(ctx, before ?? null);
    return true;
  } catch {
    return false;
  }
}

async function dirExists(home: string, rel: string): Promise<boolean> {
  try {
    return (await lstat(path.join(home, ...rel.split('/')))).isDirectory();
  } catch {
    return false;
  }
}

async function cleanStaging(env: InstallEnv): Promise<void> {
  let entries;
  try {
    entries = await readDir(path.join(env.home, ...STAGING_REL.split('/')));
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory && !e.isSymbolicLink && /^st-[0-9a-f]+$/.test(e.name)) {
      await removeTree(env, `${STAGING_REL}/${e.name}`);
    }
  }
}

/**
 * 只保留 `UPDATE_KEEP_VERSIONS` 个版本:新装的 + 切换前的 installed(= state.previous)。
 * 只清理名字是合法 semver 的普通目录;单个版本清不掉不让安装失败,计入 failed。
 */
export async function gcVersions(
  env: InstallEnv,
  state: UpdateState,
): Promise<{ removed: string[]; failed: number }> {
  // 保留 UPDATE_KEEP_VERSIONS(2)个:installed(新装的)与 previous(回滚目标);current 指向的版本无论如何不删
  const keep = new Set<string>(
    [state.installed?.version, state.previous?.version]
      .filter((v): v is string => v !== undefined)
      .slice(0, UPDATE_KEEP_VERSIONS),
  );
  const cur = await currentVersionOf(env.home);
  if (cur !== undefined) keep.add(cur);
  const removed: string[] = [];
  let failed = 0;
  let entries;
  try {
    entries = await readDir(path.join(env.home, ...VERSIONS_REL.split('/')));
  } catch {
    return { removed, failed };
  }
  for (const e of entries) {
    if (!e.isDirectory || e.isSymbolicLink || !SEMVER_RE.test(e.name) || keep.has(e.name)) continue;
    try {
      await removeTree(env, `${VERSIONS_REL}/${e.name}`);
      removed.push(e.name);
    } catch {
      failed += 1;
    }
  }
  return { removed, failed };
}

// ---------------------------------------------------------------------------
// 回滚
// ---------------------------------------------------------------------------

export type RollbackResult =
  | { ok: true; from: string | undefined; to: string; state: UpdateState }
  | {
      ok: false;
      reason:
        | 'no_previous'
        | 'previous_missing'
        | 'previous_invalid'
        | 'switch_failed'
        | 'current_broken'
        | 'lock_lost'
        | 'write_denied'
        | 'io_error';
    };

/**
 * 把 `current` 切回保留的上一版本(只能切到本地保留的版本,零网络):
 * `state.previous` 必须存在,`versions/<previous>` 必须通过完整树校验(anchor、逐文件、文件集合),否则不切。
 * 成功后 installed ← previous、previous 清空、被回滚的版本进 bad_versions;`max_seen_version` 不降。
 * 调用方已持锁。
 */
export async function rollbackInstalled(
  env: InstallEnv,
  input: { state: UpdateState; lock: UpdateLock },
): Promise<RollbackResult> {
  const { state, lock } = input;
  const prev = state.previous;
  if (prev === undefined) return { ok: false, reason: 'no_previous' };
  const rel = `${VERSIONS_REL}/${prev.version}`;
  if (!(await dirExists(env.home, rel))) return { ok: false, reason: 'previous_missing' };
  if (await chainUnsafe(env.home, rel)) return { ok: false, reason: 'previous_invalid' };
  const check = await verifyInstalledTree(path.join(env.home, ...rel.split('/')), {
    anchor: prev.anchor,
    version: prev.version,
  });
  if (!check.ok) return { ok: false, reason: 'previous_invalid' };
  try {
    await lock.assertHeld();
    const before = await currentVersionOf(env.home);
    const linkCtx = mkCtx(env, [CURRENT_LINK_REL]);
    try {
      await switchCurrent(linkCtx, prev.version);
    } catch {
      await switchBack(linkCtx, before);
      return { ok: false, reason: 'switch_failed' };
    }
    const from = state.installed?.version;
    const base: UpdateState = { ...state, installed: prev };
    delete base.previous;
    const next = from !== undefined ? markBad(base, from) : base;
    try {
      await lock.assertHeld();
      await writeUpdateState(env, {
        ...next,
        last_check_at: nowOf(env).toISOString(),
        last_result: 'rolled_back',
      });
    } catch {
      const reverted = await switchBack(linkCtx, before);
      return { ok: false, reason: reverted ? 'write_denied' : 'current_broken' };
    }
    return {
      ok: true,
      from,
      to: prev.version,
      state: { ...next, last_check_at: nowOf(env).toISOString(), last_result: 'rolled_back' },
    };
  } catch (e) {
    if (e instanceof UpdateLockError) return { ok: false, reason: 'lock_lost' };
    if (e instanceof HomeWriteDeniedError) return { ok: false, reason: 'write_denied' };
    return { ok: false, reason: 'io_error' };
  }
}

/**
 * 前台 TTY 提示过「自动同步被拒」之后,在锁内把 `last_notice_at` 记下(同一条记录只提示一次)。
 * 拿不到锁 / 状态不可读 / 写失败一律吞掉:最坏是下次再提示一次。
 */
export async function markNoticeShown(env: InstallEnv): Promise<void> {
  let lock: UpdateLock;
  try {
    lock = await acquireUpdateLock(env);
  } catch {
    return;
  }
  try {
    const r = await readUpdateState(env.home);
    if (r.kind !== 'ok') return;
    await lock.assertHeld();
    await writeUpdateState(env, markNotified(r.state, nowOf(env).getTime()));
  } catch {
    // 尽力而为
  } finally {
    await lock.release().catch(() => undefined);
  }
}
