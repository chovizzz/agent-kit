/**
 * kit 钩子写出口(第四个写出口,contracts §20.15 R20-15.6;A5)。**只许 `src/rsi/hooks/**` 与对应测试 import**(eslint 授权闸)。
 *
 * 与 `home-fs.ts` 的分工:通用 home-fs 对 `kit-hooks` 条目一律拒绝(三个 agent 目标 + 整个 `hooks/` 私有状态子树),
 * 只有本文件能写它们。本文件**不收调用方的路径**:目标路径由固定 agent 推导(`.claude/settings.json`、`.codex/hooks.json`、
 * `.pi/agent/extensions/agent-kit-rsi.ts`),状态区路径由固定名字与严格格式的 `txn_id` 推导。
 *
 * 安全协议:
 *  - 目标(R20-15.14):HOME 本身及其祖先按 `getRealHome()` 信任协议(调用方传入真实 HOME);**HOME 以下**每一段:属主为当前 uid、不是符号链接、
 *    组与其他人不可写、无 setuid / setgid;目标为普通文件、`nlink == 1`、≤ 1 MiB;以 `O_NOFOLLOW | O_NONBLOCK` 打开后核对 fstat 与路径 lstat 一致
 *    (dev、ino、mode、uid),读上限在读时强制。
 *  - 私有状态区(R20-15.21a):`~/.local/state/agent-kit/hooks/` 及其下:非符号链接、属主为当前 uid、目录恰为 0700、文件恰为 0600 且 `nlink == 1`,
 *    读上限(账本 / journal 256 KiB、备份 1 MiB);不满足 → 对应稳定原因,**不自动 chmod 修复**。
 *  - 每个会改变磁盘的步骤(mkdir / 创建 tmp / 写 / chmod / rename / unlink / rmdir / fsync)之前先 `await guard()`(引擎传 `lock.assertHeld`),
 *    再记写审计(`hooks.<op>`)与 `trace`(测试用它证明 fsync / rename 的顺序)。失锁后 `guard` 抛错,不再有后继写尝试。
 *
 * 已知残余(同 contracts §5 / R20-15.20,不弱化):按路径的 rename / unlink / mkdir 在校验与执行之间有竞态窗口;sync 锁不与 agent 自己改写配置互斥,
 * 最后一次复核到 rename 之间被改写会丢失更新(只缩小窗口,不是 CAS)。
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  HOOKS_BACKUP_MAX_BYTES,
  HOOKS_STATE_DOC_MAX_BYTES,
  HOOKS_STATE_REL,
  HOOKS_TARGET_MAX_BYTES,
  HOOKS_TXN_ID_RE,
} from '../contracts/rsi-hooks.js';
import type { RsiAgentId } from '../contracts/rsi.js';
import type { WriteAudit } from './paths.js';

/** 固定写对象(R20-15.2):与 `HOME_WRITE_TABLE` 的 `kit-hooks` 三条逐项相等(测试钉住) */
export const HOOKS_TARGET_RELS: Readonly<Record<RsiAgentId, string>> = Object.freeze({
  claude: '.claude/settings.json',
  codex: '.codex/hooks.json',
  pi: '.pi/agent/extensions/agent-kit-rsi.ts',
});
/** agent 根目录(kit 不替 agent 建根目录,R20-15.14) */
export const HOOKS_AGENT_ROOT_RELS: Readonly<Record<RsiAgentId, string>> = Object.freeze({
  claude: '.claude',
  codex: '.codex',
  pi: '.pi/agent',
});
/** 目标所在目录里 kit 可以(在 agent 根已存在时)建的缺失最后几段 */
const TARGET_PARENT_DIRS: Readonly<Record<RsiAgentId, readonly string[]>> = Object.freeze({
  claude: [],
  codex: [],
  pi: ['extensions'],
});
/** 只读的「本地覆盖」文件(R20-15.27):仅 claude */
const AUX_RELS: Readonly<Partial<Record<RsiAgentId, string>>> = Object.freeze({
  claude: '.claude/settings.local.json',
});

export type HooksFsErrorCode =
  | 'hooks_target_unsafe'
  | 'hooks_ledger_invalid'
  | 'hooks_backup_invalid'
  | 'io'
  /** 目标在读写之间被改(内容 / 存在性与预期不符) */
  | 'target_changed';

export class HooksFsError extends Error {
  readonly code: HooksFsErrorCode;
  constructor(code: HooksFsErrorCode, detail = '') {
    super(detail === '' ? code : `${code}: ${detail}`);
    this.name = 'HooksFsError';
    this.code = code;
  }
}

type Zone = 'target' | 'ledger' | 'backup';
const ZONE_CODE: Record<Zone, HooksFsErrorCode> = {
  target: 'hooks_target_unsafe',
  ledger: 'hooks_ledger_invalid',
  backup: 'hooks_backup_invalid',
};

const O_NOFOLLOW_RO = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const O_DIR_RO = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const O_EXCL_W =
  fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;

export interface HooksFsOptions {
  /** 真实 HOME(调用方已按 `getRealHome()` 取得;此处再 realpath 一次) */
  home: string;
  writeAudit?: WriteAudit;
  /** 每个改变磁盘 / 持久化的步骤的事件(`<op>:<label>`),测试用 */
  trace?: (event: string) => void;
  /** 每个写步骤之前调用(引擎传 `lock.assertHeld`);抛错即停止 */
  guard?: () => Promise<void>;
  /** 测试注入:当前 uid(缺省 `process.getuid()`) */
  uid?: number;
}

export interface TargetRead {
  bytes: Buffer;
  /** 权限位(& 0o777) */
  mode: number;
}

export interface TargetExpect {
  exists: boolean;
  sha256: string | null;
}

function isErr(e: unknown, code: string): boolean {
  return (e as NodeJS.ErrnoException | null)?.code === code;
}

function sha256Hex(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

/** `hooks` 目录在 {@link HOOKS_STATE_REL} 各段中的下标:从它起(含)按私有状态区规则检查 */
const HOOKS_DIR_INDEX = HOOKS_STATE_REL.split('/').length - 1;

export class HooksFs {
  readonly home: string;
  private readonly uid: number | undefined;
  private readonly audit: WriteAudit | undefined;
  private readonly trace: ((e: string) => void) | undefined;
  private guardFn: (() => Promise<void>) | undefined;
  /** 已发出的写步骤数(会改变磁盘的步骤,不含 fsync);引擎据此判断「残留处理是否写过东西」(R20-15.24a 第 ③ 级) */
  writes = 0;
  /** 目标 rename(或受保护删除)已完成但 `replaceTarget` 还没返回(其后的目录 fsync 可能失败):引擎据此区分写入承诺的第 ④ / ⑤ 级 */
  targetRenamed = false;

  constructor(opts: HooksFsOptions) {
    this.home = fs.realpathSync(opts.home);
    this.uid = opts.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
    this.audit = opts.writeAudit;
    this.trace = opts.trace;
    this.guardFn = opts.guard;
  }

  /** 拿到锁之后才设置(拿锁本身不经本类) */
  setGuard(g: (() => Promise<void>) | undefined): void {
    this.guardFn = g;
  }

  // -------------------------------------------------------------------------
  // 路径推导(只读固定名字;不接受外部路径)
  // -------------------------------------------------------------------------
  private abs(...segs: string[]): string {
    return path.join(this.home, ...segs);
  }
  private stateSegs(...sub: string[]): string[] {
    return [...HOOKS_STATE_REL.split('/'), ...sub];
  }
  private static strictId(txnId: string, zone: Zone): void {
    if (!HOOKS_TXN_ID_RE.test(txnId)) throw new HooksFsError(ZONE_CODE[zone], 'bad txn id');
  }

  // -------------------------------------------------------------------------
  // 元数据检查
  // -------------------------------------------------------------------------
  private ownerOk(st: fs.Stats): boolean {
    return this.uid === undefined || st.uid === this.uid;
  }

  /** HOME 以下的非叶子段 / 目录(目标侧规则):目录、属主、组与其他人不可写、无 setuid/setgid */
  private checkPlainDir(st: fs.Stats, zone: Zone, what: string): void {
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new HooksFsError(ZONE_CODE[zone], `${what}: not a plain directory`);
    }
    if (!this.ownerOk(st)) throw new HooksFsError(ZONE_CODE[zone], `${what}: owner`);
    if ((st.mode & 0o022) !== 0)
      throw new HooksFsError(ZONE_CODE[zone], `${what}: group/other writable`);
    if ((st.mode & 0o6000) !== 0) throw new HooksFsError(ZONE_CODE[zone], `${what}: setuid/setgid`);
  }

  /** 私有状态区目录:恰为 0700 */
  private checkPrivateDir(st: fs.Stats, zone: Zone, what: string): void {
    this.checkPlainDir(st, zone, what);
    if ((st.mode & 0o777) !== 0o700) throw new HooksFsError(ZONE_CODE[zone], `${what}: mode`);
  }

  private async lstatOrNull(abs: string, zone: Zone): Promise<fs.Stats | null> {
    try {
      return await fsp.lstat(abs);
    } catch (e) {
      if (isErr(e, 'ENOENT')) return null;
      if (isErr(e, 'ENOTDIR')) throw new HooksFsError(ZONE_CODE[zone], 'ENOTDIR');
      throw new HooksFsError('io', 'lstat');
    }
  }

  /**
   * 逐段检查 `segs`(HOME 相对)直到第一个不存在的段。非叶子段按 `plain` 规则(`privateFrom` 起的段按私有状态区规则)。
   * 返回已存在的最深段数量与叶子的 lstat(叶子存在时)。
   */
  private async walk(
    segs: readonly string[],
    zone: Zone,
    privateFrom: number,
  ): Promise<{ present: number; leaf: fs.Stats | null }> {
    let cur = this.home;
    for (let i = 0; i < segs.length; i++) {
      cur = path.join(cur, segs[i] as string);
      const st = await this.lstatOrNull(cur, zone);
      if (st === null) return { present: i, leaf: null };
      if (st.isSymbolicLink())
        throw new HooksFsError(ZONE_CODE[zone], `${segs.slice(0, i + 1).join('/')}: symlink`);
      if (i === segs.length - 1) return { present: segs.length, leaf: st };
      if (i >= privateFrom) this.checkPrivateDir(st, zone, segs.slice(0, i + 1).join('/'));
      else this.checkPlainDir(st, zone, segs.slice(0, i + 1).join('/'));
    }
    return { present: segs.length, leaf: null };
  }

  /** 读一个已通过 walk 的叶子:fd 级核对 */
  private async readLeaf(
    segs: readonly string[],
    zone: Zone,
    opts: { max: number; privateFile: boolean },
  ): Promise<TargetRead | null> {
    const privateFrom = opts.privateFile ? HOOKS_DIR_INDEX : Number.MAX_SAFE_INTEGER;
    const w = await this.walk(segs, zone, privateFrom);
    if (w.leaf === null) return null;
    const abs = this.abs(...segs);
    const pre = w.leaf;
    if (!pre.isFile()) throw new HooksFsError(ZONE_CODE[zone], 'not a regular file');
    let fh: fsp.FileHandle;
    try {
      fh = await fsp.open(abs, O_NOFOLLOW_RO);
    } catch (e) {
      if (isErr(e, 'ELOOP')) throw new HooksFsError(ZONE_CODE[zone], 'symlink');
      if (isErr(e, 'ENOENT')) throw new HooksFsError('target_changed', 'vanished');
      throw new HooksFsError('io', 'open');
    }
    try {
      const st = await fh.stat();
      const again = await this.lstatOrNull(abs, zone);
      if (again === null) throw new HooksFsError('target_changed', 'vanished');
      if (
        !st.isFile() ||
        st.nlink !== 1 ||
        !this.ownerOk(st) ||
        (st.mode & 0o6000) !== 0 ||
        st.dev !== again.dev ||
        st.ino !== again.ino ||
        st.mode !== again.mode ||
        st.uid !== again.uid ||
        st.dev !== pre.dev ||
        st.ino !== pre.ino
      ) {
        throw new HooksFsError(ZONE_CODE[zone], 'file identity/metadata');
      }
      if (zone === 'target' && (st.mode & 0o022) !== 0) {
        throw new HooksFsError(ZONE_CODE[zone], 'group/other writable');
      }
      if (opts.privateFile && (st.mode & 0o777) !== 0o600) {
        throw new HooksFsError(ZONE_CODE[zone], 'mode');
      }
      if (st.size > opts.max) throw new HooksFsError(ZONE_CODE[zone], 'too large');
      // 上限在读时强制:多读 1 字节判超
      const buf = Buffer.alloc(opts.max + 1);
      let n = 0;
      for (;;) {
        const r = await fh.read(buf, n, buf.length - n, n);
        if (r.bytesRead === 0) break;
        n += r.bytesRead;
        if (n > opts.max) throw new HooksFsError(ZONE_CODE[zone], 'too large');
      }
      return { bytes: Buffer.from(buf.subarray(0, n)), mode: st.mode & 0o777 };
    } finally {
      await fh.close();
    }
  }

  // -------------------------------------------------------------------------
  // 目标与 agent 根(只读)
  // -------------------------------------------------------------------------
  /** agent 根是否存在(不存在 → false;存在但不是普通目录 / 链接 / 属主不符 → `hooks_target_unsafe`) */
  async agentRootExists(agent: RsiAgentId): Promise<boolean> {
    const segs = HOOKS_AGENT_ROOT_RELS[agent].split('/');
    const w = await this.walk(segs, 'target', Number.MAX_SAFE_INTEGER);
    if (w.leaf === null) return false;
    this.checkPlainDir(w.leaf, 'target', segs.join('/'));
    return true;
  }

  /** 读目标;不存在 → null。安全条件不满足 → `hooks_target_unsafe` */
  async readTarget(agent: RsiAgentId): Promise<TargetRead | null> {
    return this.readLeaf(HOOKS_TARGET_RELS[agent].split('/'), 'target', {
      max: HOOKS_TARGET_MAX_BYTES,
      privateFile: false,
    });
  }

  /** 读「本地覆盖」文件(R20-15.27);该 agent 没有则 null */
  async readAux(agent: RsiAgentId): Promise<TargetRead | null> {
    const rel = AUX_RELS[agent];
    if (rel === undefined) return null;
    return this.readLeaf(rel.split('/'), 'target', {
      max: HOOKS_TARGET_MAX_BYTES,
      privateFile: false,
    });
  }

  // -------------------------------------------------------------------------
  // 私有状态区(只读)
  // -------------------------------------------------------------------------
  private async readState(sub: string[], zone: Zone, max: number): Promise<Buffer | null> {
    const r = await this.readLeaf(this.stateSegs(...sub), zone, { max, privateFile: true });
    return r === null ? null : r.bytes;
  }

  async readLedger(): Promise<Buffer | null> {
    return this.readState(['ledger.json'], 'ledger', HOOKS_STATE_DOC_MAX_BYTES);
  }

  async ledgerMarkerExists(): Promise<boolean> {
    return (await this.readState(['ledger.established'], 'ledger', 0)) !== null;
  }

  async readJournal(txnId: string): Promise<Buffer | null> {
    HooksFs.strictId(txnId, 'ledger');
    return this.readState(['txn', `${txnId}.json`], 'ledger', HOOKS_STATE_DOC_MAX_BYTES);
  }

  async readBackup(txnId: string, agent: RsiAgentId): Promise<Buffer | null> {
    HooksFs.strictId(txnId, 'backup');
    return this.readState(['backups', txnId, agent], 'backup', HOOKS_BACKUP_MAX_BYTES);
  }

  /** 列目录名(目录必须通过私有区检查;不存在 → 空数组) */
  private async listState(sub: string[], zone: Zone): Promise<string[]> {
    const segs = this.stateSegs(...sub);
    const w = await this.walk(segs, zone, HOOKS_DIR_INDEX);
    if (w.leaf === null) return [];
    this.checkPrivateDir(w.leaf, zone, segs.join('/'));
    try {
      return (await fsp.readdir(this.abs(...segs))).sort();
    } catch {
      throw new HooksFsError('io', 'readdir');
    }
  }

  /** `txn/` 下的 journal 的 `txn_id`(升序)与残留 `*.tmp` 的名字;出现任何别的名字 → `hooks_ledger_invalid` */
  async listTxnDir(): Promise<{ journals: string[]; tmps: string[] }> {
    const names = await this.listState(['txn'], 'ledger');
    const journals: string[] = [];
    const tmps: string[] = [];
    for (const n of names) {
      const m = /^(.+)\.json$/.exec(n);
      if (m !== null && HOOKS_TXN_ID_RE.test(m[1] as string)) journals.push(m[1] as string);
      else if (/^.+\.json\.tmp$/.test(n)) tmps.push(n);
      else throw new HooksFsError('hooks_ledger_invalid', 'unexpected entry in txn/');
    }
    return { journals, tmps };
  }

  /** 是否有残留的 tmp(`txn/*.tmp` 或 `ledger.json.tmp`):幂等命令的快捷返回据此仍进入锁内清理 */
  async hasStrayTmps(): Promise<boolean> {
    if ((await this.listTxnDir()).tmps.length > 0) return true;
    const lt = this.abs(...this.stateSegs('ledger.json.tmp'));
    return (await this.lstatOrNull(lt, 'ledger')) !== null;
  }

  /** `backups/` 下的备份目录 `txn_id`(升序);别的名字 → `hooks_backup_invalid` */
  async listBackupIds(): Promise<string[]> {
    const names = await this.listState(['backups'], 'backup');
    for (const n of names) {
      if (!HOOKS_TXN_ID_RE.test(n))
        throw new HooksFsError('hooks_backup_invalid', 'unexpected entry');
    }
    return names;
  }

  async stateDirExists(): Promise<boolean> {
    const w = await this.walk(this.stateSegs(), 'ledger', HOOKS_DIR_INDEX);
    return w.leaf !== null;
  }

  // -------------------------------------------------------------------------
  // 写步骤基础设施
  // -------------------------------------------------------------------------
  private async step<T>(
    op: string,
    label: string,
    abs: string,
    fn: () => Promise<T>,
    audited = true,
  ): Promise<T> {
    if (this.guardFn !== undefined) await this.guardFn();
    if (audited) {
      this.writes++;
      this.audit?.(`hooks.${op}`, abs);
    }
    this.trace?.(`${op}:${label}`);
    return fn();
  }

  private label(segs: readonly string[]): string {
    const st = HOOKS_STATE_REL.split('/');
    if (segs.length >= st.length && st.every((s, i) => segs[i] === s)) {
      return segs.length === st.length ? 'state' : `state/${segs.slice(st.length).join('/')}`;
    }
    return segs.join('/');
  }

  private async fsyncPath(abs: string, label: string, dir: boolean): Promise<void> {
    await this.step(
      dir ? 'fsync-dir' : 'fsync-file',
      label,
      abs,
      async () => {
        const fh = await fsp.open(
          abs,
          dir ? O_DIR_RO : fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        );
        try {
          await fh.sync();
        } finally {
          await fh.close();
        }
      },
      false,
    );
  }

  /** 创建一个缺失的私有目录(0700,不跟随链接),fchmod 保证不受 umask 影响;fsync 新目录与其父 */
  private async mkdirPrivate(segs: readonly string[], zone: Zone): Promise<void> {
    const abs = this.abs(...segs);
    let created = true;
    try {
      await this.step('mkdir', this.label(segs), abs, () => fsp.mkdir(abs, { mode: 0o700 }));
    } catch (e) {
      if (!isErr(e, 'EEXIST')) throw e;
      created = false;
    }
    const st = await this.lstatOrNull(abs, zone);
    if (st === null) throw new HooksFsError(ZONE_CODE[zone], 'vanished');
    if (created) {
      await this.step('chmod', this.label(segs), abs, async () => {
        const fh = await fsp.open(abs, O_DIR_RO);
        try {
          await fh.chmod(0o700);
        } finally {
          await fh.close();
        }
      });
      const after = await this.lstatOrNull(abs, zone);
      if (after === null) throw new HooksFsError(ZONE_CODE[zone], 'vanished');
      this.checkPrivateDir(after, zone, segs.join('/'));
      await this.fsyncPath(abs, this.label(segs), true);
      await this.fsyncPath(path.dirname(abs), this.label(segs.slice(0, -1)), true);
    } else {
      this.checkPrivateDir(st, zone, segs.join('/'));
    }
  }

  /** 保证 `hooks/<sub…>` 目录链存在(缺失的各级一并创建并 fsync) */
  private async ensureStateDirs(sub: readonly string[], zone: Zone): Promise<void> {
    const base = HOOKS_STATE_REL.split('/');
    const all = [...base, ...sub];
    const w = await this.walk(all, zone, HOOKS_DIR_INDEX);
    const full = w.leaf !== null ? all.length : w.present;
    if (w.leaf !== null) {
      this.checkPrivateDir(w.leaf, zone, all.join('/'));
      return;
    }
    for (let i = full; i < all.length; i++) {
      await this.mkdirPrivate(all.slice(0, i + 1), zone);
    }
  }

  /** 原子替换 `hooks/<dir…>/<name>`:`<name>.tmp`(O_EXCL, 0600)→ 写 → fsync 文件 → rename → fsync 目录 */
  private async atomicState(
    dirSub: readonly string[],
    name: string,
    tmpName: string,
    bytes: Buffer | string,
    zone: Zone,
  ): Promise<void> {
    // 写出也要守读取上限(评审采纳):写成读不回来的状态比拒绝更糟
    const len = typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.length;
    if (len > HOOKS_STATE_DOC_MAX_BYTES)
      throw new HooksFsError(ZONE_CODE[zone], 'too large to read back');
    await this.ensureStateDirs(dirSub, zone);
    const dirSegs = this.stateSegs(...dirSub);
    const tmp = this.abs(...dirSegs, tmpName);
    const dst = this.abs(...dirSegs, name);
    const lbl = this.label([...dirSegs, name]);
    // 目标若已存在必须是安全的普通文件(替换前核对,避免 rename 覆盖一个链接 / 宽权限文件)
    const cur = await this.lstatOrNull(dst, zone);
    if (
      cur !== null &&
      (!cur.isFile() || cur.nlink !== 1 || !this.ownerOk(cur) || (cur.mode & 0o777) !== 0o600)
    ) {
      throw new HooksFsError(ZONE_CODE[zone], `${lbl}: unsafe existing file`);
    }
    await this.createTmpWrite(tmp, `${lbl}.tmp`, bytes, 0o600, zone, true);
    await this.step('rename', lbl, dst, () => fsp.rename(tmp, dst));
    await this.fsyncPath(path.dirname(dst), this.label(dirSegs), true);
  }

  /** 创建 tmp(O_EXCL|O_NOFOLLOW,0600)→ 写 → fsync。已存在的陈旧 tmp(同名,仅 `retryStale`)先删再建一次 */
  private async createTmpWrite(
    tmp: string,
    lbl: string,
    bytes: Buffer | string,
    mode: number,
    zone: Zone,
    retryStale: boolean,
  ): Promise<fs.Stats> {
    let fh: fsp.FileHandle;
    const open = (): Promise<fsp.FileHandle> =>
      this.step('create-tmp', lbl, tmp, () => fsp.open(tmp, O_EXCL_W, mode));
    try {
      fh = await open();
    } catch (e) {
      if (!isErr(e, 'EEXIST') || !retryStale) throw e;
      const st = await this.lstatOrNull(tmp, zone);
      if (st !== null && !st.isDirectory()) {
        await this.step('unlink', lbl, tmp, () => fsp.unlink(tmp));
      }
      fh = await open();
    }
    try {
      const ident = await fh.stat();
      // umask 把创建权限收得比 `mode` 更严时,最终权限不是预期值(读取端要求状态区文件恰为 0600):单独一步、先 guard 再 fchmod
      await this.fixFdMode(fh, ident, mode, lbl, tmp);
      await this.step('write-tmp', lbl, tmp, () => fh.writeFile(bytes));
      await this.step('fsync-file', lbl, tmp, () => fh.sync(), false);
      return ident;
    } finally {
      await fh.close().catch(() => undefined);
    }
  }

  /** 句柄上的文件权限不是 `mode`(受 umask 影响)→ 单独的、先 guard 的 chmod 步骤;正常情况下不产生任何步骤 */
  private async fixFdMode(
    fh: fsp.FileHandle,
    st: fs.Stats,
    mode: number,
    lbl: string,
    abs: string,
  ): Promise<void> {
    if ((st.mode & 0o777) === mode) return;
    await this.step('chmod', lbl, abs, () => fh.chmod(mode));
  }

  // -------------------------------------------------------------------------
  // journal / 账本 / 标记 / 备份(写)
  // -------------------------------------------------------------------------
  /** `writeJournal`:journal 的创建与每次状态变更的唯一出口(R20-15.21):`<txn_id>.json.tmp` → fsync → rename → fsync `txn/` */
  async writeJournal(txnId: string, bytes: Buffer | string): Promise<void> {
    HooksFs.strictId(txnId, 'ledger');
    await this.atomicState(['txn'], `${txnId}.json`, `${txnId}.json.tmp`, bytes, 'ledger');
  }

  /** 删 journal 并 fsync `txn/`(不存在视为成功) */
  async deleteJournal(txnId: string): Promise<void> {
    HooksFs.strictId(txnId, 'ledger');
    const segs = this.stateSegs('txn', `${txnId}.json`);
    const abs = this.abs(...segs);
    const st = await this.lstatOrNull(abs, 'ledger');
    if (st === null) return;
    if (!st.isFile() || st.nlink !== 1 || !this.ownerOk(st)) {
      throw new HooksFsError('hooks_ledger_invalid', 'unsafe journal');
    }
    await this.step('unlink', this.label(segs), abs, () => fsp.unlink(abs));
    await this.fsyncPath(path.dirname(abs), this.label(segs.slice(0, -1)), true);
  }

  /** 删 `txn/` 下的 `*.tmp`(它们从未生效)与陈旧的 `ledger.json.tmp`;返回删了几个 */
  async removeStrayTmps(): Promise<number> {
    let n = 0;
    const { tmps } = await this.listTxnDir();
    for (const t of tmps) {
      const segs = this.stateSegs('txn', t);
      const abs = this.abs(...segs);
      const st = await this.lstatOrNull(abs, 'ledger');
      if (st === null) continue;
      if (st.isDirectory() || !this.ownerOk(st)) {
        throw new HooksFsError('hooks_ledger_invalid', 'unsafe tmp');
      }
      await this.step('unlink', this.label(segs), abs, () => fsp.unlink(abs));
      n++;
    }
    if (n > 0) await this.fsyncPath(this.abs(...this.stateSegs('txn')), 'state/txn', true);
    const lt = this.abs(...this.stateSegs('ledger.json.tmp'));
    const lst = await this.lstatOrNull(lt, 'ledger');
    if (lst !== null) {
      if (lst.isDirectory() || !this.ownerOk(lst)) {
        throw new HooksFsError('hooks_ledger_invalid', 'unsafe ledger tmp');
      }
      await this.step('unlink', 'state/ledger.json.tmp', lt, () => fsp.unlink(lt));
      await this.fsyncPath(this.abs(...this.stateSegs()), 'state', true);
      n++;
    }
    return n;
  }

  /** 备份原文件到 `backups/<txn_id>/<agent>`(0600 / 目录 0700),fsync 文件与新建目录 */
  async writeBackup(txnId: string, agent: RsiAgentId, bytes: Buffer): Promise<void> {
    HooksFs.strictId(txnId, 'backup');
    await this.atomicStateBackup(txnId, agent, bytes);
  }

  private async atomicStateBackup(txnId: string, agent: RsiAgentId, bytes: Buffer): Promise<void> {
    if (bytes.length > HOOKS_BACKUP_MAX_BYTES) {
      throw new HooksFsError('hooks_backup_invalid', 'too large to read back');
    }
    const sub = ['backups', txnId];
    await this.ensureStateDirs(sub, 'backup');
    const dirSegs = this.stateSegs(...sub);
    const tmp = this.abs(...dirSegs, `${agent}.tmp`);
    const dst = this.abs(...dirSegs, agent);
    const lbl = this.label([...dirSegs, agent]);
    await this.createTmpWrite(tmp, `${lbl}.tmp`, bytes, 0o600, 'backup', true);
    await this.step('rename', lbl, dst, () => fsp.rename(tmp, dst));
    await this.fsyncPath(path.dirname(dst), this.label(dirSegs), true);
  }

  /** 残留处理:按 txn_id 与固定 agent 清理备份写入时遗留的 `<agent>.tmp`(从未生效);备份目录不存在 → false */
  async removeBackupTmp(txnId: string, agent: RsiAgentId): Promise<boolean> {
    HooksFs.strictId(txnId, 'backup');
    const dirSegs = this.stateSegs('backups', txnId);
    const w = await this.walk(dirSegs, 'backup', HOOKS_DIR_INDEX);
    if (w.leaf === null) return false;
    this.checkPrivateDir(w.leaf, 'backup', dirSegs.join('/'));
    const segs = [...dirSegs, `${agent}.tmp`];
    const abs = this.abs(...segs);
    const st = await this.lstatOrNull(abs, 'backup');
    if (st === null) return false;
    if (st.isDirectory() || !this.ownerOk(st)) {
      throw new HooksFsError('hooks_backup_invalid', 'unsafe backup tmp');
    }
    await this.step('unlink', this.label(segs), abs, () => fsp.unlink(abs));
    await this.fsyncPath(path.dirname(abs), this.label(dirSegs), true);
    return true;
  }

  /** 删备份目录(先文件后目录),并 fsync `backups/`;不存在视为成功。`onProgress` 在每次 unlink / rmdir 成功之后调用(引擎据此记 `maintenance=partial`) */
  async deleteBackupDir(txnId: string, onProgress?: () => void): Promise<void> {
    HooksFs.strictId(txnId, 'backup');
    const segs = this.stateSegs('backups', txnId);
    const w = await this.walk(segs, 'backup', HOOKS_DIR_INDEX);
    if (w.leaf === null) return;
    this.checkPrivateDir(w.leaf, 'backup', segs.join('/'));
    const dirAbs = this.abs(...segs);
    const names = await fsp.readdir(dirAbs);
    for (const n of names) {
      const ok =
        n === 'claude' || n === 'codex' || n === 'pi' || /^(claude|codex|pi)\.tmp$/.test(n);
      if (!ok) throw new HooksFsError('hooks_backup_invalid', 'unexpected entry in backup dir');
      const fAbs = path.join(dirAbs, n);
      const st = await this.lstatOrNull(fAbs, 'backup');
      if (st === null) continue;
      if (!st.isFile() || !this.ownerOk(st))
        throw new HooksFsError('hooks_backup_invalid', 'unsafe backup file');
      await this.step('unlink', this.label([...segs, n]), fAbs, () => fsp.unlink(fAbs));
      onProgress?.();
    }
    await this.step('rmdir', this.label(segs), dirAbs, () => fsp.rmdir(dirAbs));
    onProgress?.();
    await this.fsyncPath(path.dirname(dirAbs), 'state/backups', true);
  }

  /** `ledger.established`:空文件,0600,独占创建,fsync 文件与 `hooks/`(R20-15.21 标记) */
  async createLedgerMarker(): Promise<void> {
    await this.ensureStateDirs([], 'ledger');
    const segs = this.stateSegs('ledger.established');
    const abs = this.abs(...segs);
    let fh: fsp.FileHandle;
    try {
      fh = await this.step('create-excl', this.label(segs), abs, () =>
        fsp.open(abs, O_EXCL_W, 0o600),
      );
    } catch (e) {
      if (isErr(e, 'EEXIST')) return;
      throw e;
    }
    try {
      await this.fixFdMode(fh, await fh.stat(), 0o600, this.label(segs), abs);
      await this.step('fsync-file', this.label(segs), abs, () => fh.sync(), false);
    } finally {
      await fh.close();
    }
    await this.fsyncPath(this.abs(...this.stateSegs()), 'state', true);
  }

  /** `commitLedger`:账本的唯一写出口:`ledger.json.tmp` 写完 fsync 文件 → rename → fsync 父目录(R20-15.21) */
  async commitLedger(bytes: Buffer | string): Promise<void> {
    await this.atomicState([], 'ledger.json', 'ledger.json.tmp', bytes, 'ledger');
  }

  /** `ensureLedgerDurable`:fsync 账本文件与其父目录(删除任何 journal 之前一律调用,R20-15.21) */
  async ensureLedgerDurable(): Promise<void> {
    const segs = this.stateSegs('ledger.json');
    const w = await this.walk(segs, 'ledger', HOOKS_DIR_INDEX);
    if (w.leaf === null) return;
    await this.fsyncPath(this.abs(...segs), this.label(segs), false);
    await this.fsyncPath(this.abs(...this.stateSegs()), 'state', true);
  }

  // -------------------------------------------------------------------------
  // 目标(写)——hooksApply 的底层
  // -------------------------------------------------------------------------
  private async checkExpect(agent: RsiAgentId, expect: TargetExpect): Promise<TargetRead | null> {
    const cur = await this.readTarget(agent);
    const curSha = cur === null ? null : sha256Hex(cur.bytes);
    if ((cur !== null) !== expect.exists || curSha !== expect.sha256) {
      throw new HooksFsError('target_changed', 'content or existence differs from expected');
    }
    return cur;
  }

  /** 目标 tmp 的名字(由 txn_id 推导,残留处理据此清理) */
  private targetTmp(agent: RsiAgentId, txnId: string): { abs: string; label: string } {
    const rel = HOOKS_TARGET_RELS[agent];
    const dir = path.posix.dirname(rel);
    const base = path.posix.basename(rel);
    const name = `.${base}.${txnId}.tmp`;
    return { abs: this.abs(...dir.split('/'), name), label: `target/${agent}.tmp` };
  }

  /** 缺失的目标父目录(pi 的 `extensions/`)按 0700 不跟随链接逐段创建;agent 根必须已存在 */
  private async ensureTargetParents(agent: RsiAgentId): Promise<void> {
    const rootSegs = HOOKS_AGENT_ROOT_RELS[agent].split('/');
    const rw = await this.walk(rootSegs, 'target', Number.MAX_SAFE_INTEGER);
    if (rw.leaf === null) throw new HooksFsError('hooks_target_unsafe', 'agent root missing');
    this.checkPlainDir(rw.leaf, 'target', rootSegs.join('/'));
    let segs = [...rootSegs];
    for (const d of TARGET_PARENT_DIRS[agent]) {
      segs = [...segs, d];
      const abs = this.abs(...segs);
      const st = await this.lstatOrNull(abs, 'target');
      if (st === null) {
        await this.step('mkdir', `target/${agent}:${d}`, abs, () =>
          fsp.mkdir(abs, { mode: 0o700 }),
        );
        await this.step('chmod', `target/${agent}:${d}`, abs, async () => {
          const fh = await fsp.open(abs, O_DIR_RO);
          try {
            await fh.chmod(0o700);
          } finally {
            await fh.close();
          }
        });
        const after = await this.lstatOrNull(abs, 'target');
        if (after === null) throw new HooksFsError('hooks_target_unsafe', 'vanished');
        this.checkPlainDir(after, 'target', segs.join('/'));
        await this.fsyncPath(abs, `target/${agent}:${d}`, true);
        await this.fsyncPath(path.dirname(abs), `target/${agent}:parent`, true);
      } else {
        this.checkPlainDir(st, 'target', segs.join('/'));
      }
    }
  }

  /**
   * 目标事务的唯一写入口(`hooksApply` 的底层;R20-15.21 ③④):
   *  ③ 提交前复核(R20-15.14 全部安全条件 + 存在性 + 内容哈希仍是 `expect`)——不符 → `target_changed`(此时尚未创建 tmp);
   *  `produce(before)` 由调用方给出,返回新字节或 `null`(= 删除目标;删前再复核哈希,「受保护的删除」);
   *  ④ 同目录 tmp(0600,O_EXCL)写完 fsync → rename 之前把 tmp 权限设为 `finalMode`(≠ 0600 时,并再 fsync 一次以持久化权限元数据)→
   *     **rename 前再复核一次目标与 tmp 身份** → rename → fsync 目标目录。
   * 出错时(含失锁)尽力删除自己的 tmp——失锁后 `guard` 会拒绝 unlink,tmp 留给 R20-15.22 的残留处理按 txn_id 清理。
   */
  async replaceTarget(
    agent: RsiAgentId,
    txnId: string,
    expect: TargetExpect,
    finalMode: number,
    produce: (before: Buffer | null) => Promise<Buffer | null> | Buffer | null,
  ): Promise<void> {
    HooksFs.strictId(txnId, 'target');
    const before = await this.checkExpect(agent, expect);
    const out = await produce(before === null ? null : before.bytes);
    const targetSegs = HOOKS_TARGET_RELS[agent].split('/');
    const targetAbs = this.abs(...targetSegs);
    if (out === null) {
      // 受保护的删除:删前复核哈希仍是 expect
      await this.checkExpect(agent, expect);
      await this.step('unlink', `target/${agent}`, targetAbs, () => fsp.unlink(targetAbs));
      this.targetRenamed = true;
      await this.fsyncPath(path.dirname(targetAbs), `target/${agent}:dir`, true);
      return;
    }
    if (out.length > HOOKS_TARGET_MAX_BYTES) {
      throw new HooksFsError('hooks_target_unsafe', 'after too large to read back');
    }
    await this.ensureTargetParents(agent);
    const t = this.targetTmp(agent, txnId);
    let ident: fs.Stats;
    try {
      ident = await this.createTmpWrite(t.abs, t.label, out, 0o600, 'target', false);
      if (finalMode !== 0o600) {
        await this.step('chmod', t.label, t.abs, async () => {
          const fh = await fsp.open(t.abs, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
          try {
            await fh.chmod(finalMode);
          } finally {
            await fh.close();
          }
        });
        // 权限元数据也要持久化(评审采纳:契约顺序是「fsync → 设权限 → rename」,这里在设权限后再 fsync 一次)
        await this.fsyncPath(t.abs, t.label, false);
      }
      // rename 紧前再复核(缩小窗口,不是 CAS)
      await this.checkExpect(agent, expect);
      const tst = await this.lstatOrNull(t.abs, 'target');
      if (
        tst === null ||
        !tst.isFile() ||
        tst.nlink !== 1 ||
        tst.dev !== ident.dev ||
        tst.ino !== ident.ino ||
        !this.ownerOk(tst) ||
        (tst.mode & 0o777) !== finalMode
      ) {
        throw new HooksFsError('hooks_target_unsafe', 'tmp identity/metadata');
      }
      await this.step('rename', `target/${agent}`, targetAbs, () => fsp.rename(t.abs, targetAbs));
      this.targetRenamed = true;
    } catch (e) {
      try {
        await this.step('unlink', t.label, t.abs, () => fsp.unlink(t.abs));
      } catch {
        // 失锁 / tmp 不存在:留给残留处理
      }
      throw e;
    }
    await this.fsyncPath(path.dirname(targetAbs), `target/${agent}:dir`, true);
  }

  /** 残留处理:按 txn_id 清理目标 tmp(只删自己名字的普通文件 / 链接本身;目录 → 不安全) */
  async removeTargetTmp(agent: RsiAgentId, txnId: string): Promise<boolean> {
    HooksFs.strictId(txnId, 'target');
    const t = this.targetTmp(agent, txnId);
    // 评审采纳:先按目标安全协议逐段校验祖先(父目录是链接 / 他人所有 / 组可写 → hooks_target_unsafe,不沿链接删);父目录不存在则无需清理
    const dirSegs = path.posix.dirname(HOOKS_TARGET_RELS[agent]).split('/');
    const w = await this.walk(dirSegs, 'target', Number.MAX_SAFE_INTEGER);
    if (w.leaf === null) return false;
    this.checkPlainDir(w.leaf, 'target', dirSegs.join('/'));
    const st = await this.lstatOrNull(t.abs, 'target');
    if (st === null) return false;
    if (st.isDirectory() || !this.ownerOk(st))
      throw new HooksFsError('hooks_target_unsafe', 'unsafe tmp');
    await this.step('unlink', t.label, t.abs, () => fsp.unlink(t.abs));
    await this.fsyncPath(path.dirname(t.abs), `target/${agent}:dir`, true);
    return true;
  }

  /** 残留处理:目标权限与 journal 记的最终权限不符时,在锁内补设(fd 级,不跟随链接) */
  async ensureTargetMode(agent: RsiAgentId, finalMode: number): Promise<boolean> {
    const cur = await this.readTarget(agent);
    if (cur === null) return false;
    if (cur.mode === finalMode) return false;
    const abs = this.abs(...HOOKS_TARGET_RELS[agent].split('/'));
    await this.step('chmod', `target/${agent}`, abs, async () => {
      const fh = await fsp.open(abs, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
      try {
        await fh.chmod(finalMode);
      } finally {
        await fh.close();
      }
    });
    await this.fsyncPath(abs, `target/${agent}`, false);
    return true;
  }

  /** 目标目录 fsync(残留处理 `= after` 分支) */
  async fsyncTargetDir(agent: RsiAgentId): Promise<void> {
    const abs = path.dirname(this.abs(...HOOKS_TARGET_RELS[agent].split('/')));
    await this.fsyncPath(abs, `target/${agent}:dir`, true);
  }
}
