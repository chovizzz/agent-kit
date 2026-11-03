/**
 * kit 钩子区的**只读**出口(contracts §20.15 R20-15.14 / R20-15.21a;A6 R20-17.20 从 `hooks-fs.ts` 拆出)。
 *
 * 只含读取:目标 / agent 根 / 私有状态区(账本、标记、journal、备份、目录列举)的安全读取协议,**没有任何写步骤**。
 * `doctor` D17 只许 import 本文件(eslint 闸禁止 doctor import `hooks-fs.ts`);`hooks-fs.ts` 的 `HooksFs` 继承本类,读取实现只此一份。
 * 安全协议同 `hooks-fs.ts` 头注释:目标(HOME 以下每一段属主为当前 uid、非符号链接、组与其他人不可写、无 setuid / setgid;普通文件、`nlink == 1`、≤ 1 MiB;
 * `O_NOFOLLOW | O_NONBLOCK` 打开后核对 fstat 与路径 lstat 一致)与私有状态区(目录恰为 0700、文件恰为 0600 且 `nlink == 1`,读上限账本 / journal 256 KiB、备份 1 MiB)。
 * 不满足 → 对应稳定原因,**不自动 chmod 修复**。
 */
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

export type Zone = 'target' | 'ledger' | 'backup';
export const ZONE_CODE: Record<Zone, HooksFsErrorCode> = {
  target: 'hooks_target_unsafe',
  ledger: 'hooks_ledger_invalid',
  backup: 'hooks_backup_invalid',
};

export interface TargetRead {
  bytes: Buffer;
  /** 权限位(& 0o777) */
  mode: number;
}

export function isErr(e: unknown, code: string): boolean {
  return (e as NodeJS.ErrnoException | null)?.code === code;
}

/** `hooks` 目录在 {@link HOOKS_STATE_REL} 各段中的下标:从它起(含)按私有状态区规则检查 */
export const HOOKS_DIR_INDEX = HOOKS_STATE_REL.split('/').length - 1;

export interface HooksReadOptions {
  /** 真实 HOME(调用方已按 `getRealHome()` 取得;此处再 realpath 一次) */
  home: string;
  /** 测试注入:当前 uid(缺省 `process.getuid()`) */
  uid?: number;
}

export class HooksRead {
  readonly home: string;
  protected readonly uid: number | undefined;

  constructor(opts: HooksReadOptions) {
    this.home = fs.realpathSync(opts.home);
    this.uid = opts.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  }

  // -------------------------------------------------------------------------
  // 路径推导(只读固定名字;不接受外部路径)
  // -------------------------------------------------------------------------
  protected abs(...segs: string[]): string {
    return path.join(this.home, ...segs);
  }
  protected stateSegs(...sub: string[]): string[] {
    return [...HOOKS_STATE_REL.split('/'), ...sub];
  }
  protected static strictId(txnId: string, zone: Zone): void {
    if (!HOOKS_TXN_ID_RE.test(txnId)) throw new HooksFsError(ZONE_CODE[zone], 'bad txn id');
  }

  // -------------------------------------------------------------------------
  // 元数据检查
  // -------------------------------------------------------------------------
  protected ownerOk(st: fs.Stats): boolean {
    return this.uid === undefined || st.uid === this.uid;
  }

  /** HOME 以下的非叶子段 / 目录(目标侧规则):目录、属主、组与其他人不可写、无 setuid/setgid */
  protected checkPlainDir(st: fs.Stats, zone: Zone, what: string): void {
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new HooksFsError(ZONE_CODE[zone], `${what}: not a plain directory`);
    }
    if (!this.ownerOk(st)) throw new HooksFsError(ZONE_CODE[zone], `${what}: owner`);
    if ((st.mode & 0o022) !== 0)
      throw new HooksFsError(ZONE_CODE[zone], `${what}: group/other writable`);
    if ((st.mode & 0o6000) !== 0) throw new HooksFsError(ZONE_CODE[zone], `${what}: setuid/setgid`);
  }

  /** 私有状态区目录:恰为 0700 */
  protected checkPrivateDir(st: fs.Stats, zone: Zone, what: string): void {
    this.checkPlainDir(st, zone, what);
    if ((st.mode & 0o777) !== 0o700) throw new HooksFsError(ZONE_CODE[zone], `${what}: mode`);
  }

  protected async lstatOrNull(abs: string, zone: Zone): Promise<fs.Stats | null> {
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
  protected async walk(
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
  protected async readLeaf(
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
      fh = await fsp.open(
        abs,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
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
  protected async readState(sub: string[], zone: Zone, max: number): Promise<Buffer | null> {
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
    HooksRead.strictId(txnId, 'ledger');
    return this.readState(['txn', `${txnId}.json`], 'ledger', HOOKS_STATE_DOC_MAX_BYTES);
  }

  async readBackup(txnId: string, agent: RsiAgentId): Promise<Buffer | null> {
    HooksRead.strictId(txnId, 'backup');
    return this.readState(['backups', txnId, agent], 'backup', HOOKS_BACKUP_MAX_BYTES);
  }

  /** 列目录名(目录必须通过私有区检查;不存在 → 空数组) */
  protected async listState(sub: string[], zone: Zone): Promise<string[]> {
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
}
