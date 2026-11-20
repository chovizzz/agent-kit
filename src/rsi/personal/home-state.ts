/**
 * 个人层的 HOME 侧状态(contracts §21.3 R21-3.2;§21.24 W0-5 / W0-9):
 *   <HOME>/.local/state/agent-kit/rsi-personal/{lock, head.json, commit-journal.json, txn/<id>.json, revocations.jsonl}(0700 目录、0600 文件)
 * 以及私有仓库的固定位置 `<HOME>/.local/share/agent-kit/personal/`(R21-3.1,不可配置,每个 HOME 唯一)。
 *
 * - 写**只经 home-fs**(`src/io/home-fs.ts`:原子写 = 临时文件 → fsync → rename → 目录 fsync;独占创建;逐段 lstat、拒链接 / 硬链接);
 *   读只经 read-fs 的句柄级安全读取(O_NOFOLLOW、nlink、属主 / 权限),并过 zod schema(跨信任边界一律运行时校验,校验后不重读)。
 * - 不依赖 `[rsi] repo`:换仓库 / 关配置后仍能找到(R21-3.2)。
 * - `home` 一律由调用方显式给(真实 HOME 或测试的假 HOME);本文件不读环境、不默认真实 HOME。
 * - `revocations.jsonl` 不新增追加原语(W0-9):持 `personal/lock` 读全文 + 整文件原子重写;**只提供追加入口**(旧行必为新文件的前缀),
 *   读取与写入都以 `RSI_REVOCATIONS_MAX_BYTES` 为界。
 */
import { createHash, randomBytes } from 'node:crypto';
import * as path from 'node:path';
import {
  PersonalCommitJournalSchema,
  PersonalHeadSchema,
  PersonalTxnSchema,
  RsiRevocationLineSchema,
  type PersonalCommitJournal,
  type PersonalHead,
  type PersonalTxn,
  type RsiRevocationLine,
} from '../../contracts/rsi-personal.js';
import { RSI_FILE_MODE, RSI_REVOCATIONS_MAX_BYTES } from '../../contracts/rsi.js';
import { canonicalJson } from '../../io/canonical-json.js';
import {
  createHomeFsContext,
  HomeExistsError,
  HomeRenameRaceError,
  HomeWriteDeniedError,
  mkdirp,
  remove,
  removeVerified,
  renameExclusive,
  settleHalfLink,
  writeFile,
  type HomeFsContext,
  type HomeFsStage,
  type RemoveVerifiedResult,
} from '../../io/home-fs.js';
import type { IoContext } from '../../io/paths.js';
import { lstat, readDir, readFileSafe, realpath, stat } from '../../io/read-fs.js';
import { RSI_FILE_OWNER } from '../lock-read.js';

/** 私有仓库(HOME 相对) */
export const PERSONAL_REPO_REL = '.local/share/agent-kit/personal';
/** HOME 侧个人层状态目录(HOME 相对) */
export const PERSONAL_STATE_REL = '.local/state/agent-kit/rsi-personal';

/** 状态目录里的固定文件名(R21-3.2) */
export const PERSONAL_STATE_FILES = Object.freeze({
  lock: 'lock',
  head: 'head.json',
  journal: 'commit-journal.json',
  txnDir: 'txn',
  revocations: 'revocations.jsonl',
  /** 封闭 git 配置要求的「空目录」(core.hooksPath / init.templateDir 指向它;永远保持为空) */
  emptyDir: 'empty-hooks',
} as const);

const READ_CAP = 256 * 1024;
const DIR_MODE = 0o700;

export class PersonalStateError extends Error {
  readonly code = 'RSI_PERSONAL_STATE';
  constructor(
    readonly kind: 'empty_dir_not_empty' | 'revocations_too_large' | 'revocations_invalid',
    detail?: string,
  ) {
    super(`personal state: ${kind}${detail === undefined ? '' : ` (${detail})`}`);
  }
}

export interface PersonalHome {
  readonly io: IoContext;
  /** 绝对路径:真实 HOME 或 KIT_TMP 严格之内的假 HOME(home-fs 自己再校验) */
  readonly home: string;
  readonly repoDir: string;
  readonly stateDir: string;
  /** 测试注入口:home-fs 原子写的各阶段(产品代码不传) */
  readonly onStage?: (stage: HomeFsStage) => void | Promise<void>;
  /** 测试注入口:墓碑名的随机部分(32 个小写十六进制字符;产品代码不传,缺省 crypto 随机)。用来造「墓碑名已被占用」 */
  readonly tombstoneHex?: () => string;
}

export function personalHome(
  io: IoContext,
  home: string,
  opts: {
    onStage?: (stage: HomeFsStage) => void | Promise<void>;
    tombstoneHex?: () => string;
  } = {},
): PersonalHome {
  if (!path.isAbsolute(home)) throw new Error('personalHome: home 必须是绝对路径');
  return {
    io,
    home,
    repoDir: path.join(home, ...PERSONAL_REPO_REL.split('/')),
    stateDir: path.join(home, ...PERSONAL_STATE_REL.split('/')),
    ...(opts.onStage !== undefined ? { onStage: opts.onStage } : {}),
    ...(opts.tombstoneHex !== undefined ? { tombstoneHex: opts.tombstoneHex } : {}),
  };
}

/** 状态目录内某文件的绝对路径 */
export const statePath = (h: PersonalHome, name: string): string => path.join(h.stateDir, name);
const stateRel = (name: string): string => `${PERSONAL_STATE_REL}/${name}`;

/** 为一组写操作建 home-fs 上下文(planScope = 本次要写的状态文件;目录只许是其祖先) */
export function homeFsFor(h: PersonalHome, names: readonly string[]): HomeFsContext {
  return createHomeFsContext({
    home: h.home,
    planScope: names.map(stateRel),
    tmpDir: h.io.tmpDir,
    ...(h.onStage !== undefined ? { onStage: h.onStage } : {}),
    ...(h.io.writeAudit !== undefined ? { writeAudit: h.io.writeAudit } : {}),
  });
}

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

export type StateRead<T> =
  | { kind: 'absent' }
  | { kind: 'ok'; value: T }
  | { kind: 'invalid'; why: 'unsafe' | 'parse' | 'schema' };

async function readJson<T>(
  file: string,
  parse: (v: unknown) => T | undefined,
): Promise<StateRead<T>> {
  const r = await readFileSafe(file, { maxBytes: READ_CAP, owner: RSI_FILE_OWNER });
  if (r.kind === 'missing') return { kind: 'absent' };
  if (r.kind === 'unsafe') return { kind: 'invalid', why: 'unsafe' };
  let raw: unknown;
  try {
    raw = JSON.parse(r.bytes.toString('utf8'));
  } catch {
    return { kind: 'invalid', why: 'parse' };
  }
  const value = parse(raw);
  return value === undefined ? { kind: 'invalid', why: 'schema' } : { kind: 'ok', value };
}

const schemaParse =
  <T>(s: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } }) =>
  (v: unknown): T | undefined => {
    const r = s.safeParse(v);
    return r.success ? r.data : undefined;
  };

export const readHead = (h: PersonalHome): Promise<StateRead<PersonalHead>> =>
  readJson(statePath(h, PERSONAL_STATE_FILES.head), schemaParse(PersonalHeadSchema));

export const readJournal = (h: PersonalHome): Promise<StateRead<PersonalCommitJournal>> =>
  readJson(statePath(h, PERSONAL_STATE_FILES.journal), schemaParse(PersonalCommitJournalSchema));

export const readTxn = (h: PersonalHome, id: string): Promise<StateRead<PersonalTxn>> =>
  readJson(
    path.join(statePath(h, PERSONAL_STATE_FILES.txnDir), `${id}.json`),
    schemaParse(PersonalTxnSchema),
  );

// ---------------------------------------------------------------------------
// 写(调用方已持 personal/lock;句柄的 assertHeld 由调用方在提交点前调)
// ---------------------------------------------------------------------------

const writeState = async (h: PersonalHome, name: string, text: string): Promise<void> => {
  await writeFile(homeFsFor(h, [name]), stateRel(name), text, {
    mode: RSI_FILE_MODE,
    dirMode: DIR_MODE,
  });
};

export const writeHead = (h: PersonalHome, head: PersonalHead): Promise<void> =>
  writeState(h, PERSONAL_STATE_FILES.head, canonicalJson(PersonalHeadSchema.parse(head)));

export const writeJournal = (h: PersonalHome, j: PersonalCommitJournal): Promise<void> =>
  writeState(h, PERSONAL_STATE_FILES.journal, canonicalJson(PersonalCommitJournalSchema.parse(j)));

export const removeJournal = (h: PersonalHome): Promise<void> =>
  remove(homeFsFor(h, [PERSONAL_STATE_FILES.journal]), stateRel(PERSONAL_STATE_FILES.journal));

// ---------------------------------------------------------------------------
// 拒绝后清理 journal 用的墓碑(同目录;名字 = 固定前缀 + 本次生成的 crypto 随机数,**不含 txn_id、不可从 journal 内容推导**):
// journal 先不覆盖地改名到墓碑 → 经 fd 核对内容与身份 → 对同一对象 unlink(见 `removeVerified`)。
// 保证的边界(分三类,契约 §21 同文):
//  - 已验证:墓碑被换成别的文件时,unlink 之前的 lstat 比对 dev:ino、unlink 之后的 fd nlink 检查都会发现并返回 invalid(不报普通 denied);
//  - 未验证的残留:改名完成后、核对前进程死亡 → 状态目录里留下一个孤立墓碑(内容未核对,不被任何读取路径当作 journal;恢复不碰它);
//  - 半完成态:改名 / 改回是 link+unlink,死在 link 之后 = 原名与墓碑同 inode、nlink=2 —— `openPersonalRepo` 持锁读 journal 之前自动收尾({@link settleHalfMovedJournal})。
// lstat 与 unlink 之间的按路径窗口仍是 home-fs 文件头已声明的残余,不在此处消除。
// ---------------------------------------------------------------------------

const TOMBSTONE_PREFIX = `${PERSONAL_STATE_FILES.journal}.denied-`;
/** 墓碑文件名的唯一形态(恢复入口只认它) */
const TOMBSTONE_RE = /^commit-journal\.json\.denied-[0-9a-f]{32}$/;
export const isTombstoneName = (name: string): boolean => TOMBSTONE_RE.test(name);

/** 生成本次清理唯一的墓碑名:crypto 随机,不含 txn_id;注入值不合形态即抛(fail-closed) */
export function newTombstoneName(h: PersonalHome): string {
  const name = `${TOMBSTONE_PREFIX}${h.tombstoneHex?.() ?? randomBytes(16).toString('hex')}`;
  if (!isTombstoneName(name))
    throw new Error('tombstone name: 随机部分必须是 32 个小写十六进制字符');
  return name;
}

/**
 * journal → 墓碑(**不覆盖**:`renameExclusive`)。`'absent'` = 原路径上没有文件;`'occupied'` = 墓碑名已被占用 / 守卫拒绝 / 目标被换(原路径与来源都不动或保留现场);其它错误向上抛。
 */
export async function moveJournalToTombstone(
  h: PersonalHome,
  tombName: string,
): Promise<'moved' | 'absent' | 'occupied'> {
  const from = PERSONAL_STATE_FILES.journal;
  try {
    await renameExclusive(homeFsFor(h, [from, tombName]), stateRel(from), stateRel(tombName));
  } catch (e) {
    if (isOccupied(e)) return 'occupied';
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw e;
  }
  return 'moved';
}

/** 目标名已被占用(含「link 之后目标名被换」):现场保留。守卫拒绝(`HomeWriteDeniedError`)不在此列——它可能是来源不可信,各调用方自己决定 */
const isOccupied = (e: unknown): boolean =>
  e instanceof HomeExistsError || e instanceof HomeRenameRaceError;

/** 对墓碑做「经 fd 核对 → 删除同一对象」;`verify` 返回 `undefined` = 接受。读取强度同 `readJson`(O_NOFOLLOW、nlink、属主 / 权限、字节上限) */
export const removeVerifiedTombstone = <T>(
  h: PersonalHome,
  tombName: string,
  verify: (bytes: Buffer) => T | undefined | Promise<T | undefined>,
): Promise<RemoveVerifiedResult<T>> =>
  removeVerified(
    homeFsFor(h, [tombName]),
    stateRel(tombName),
    { maxBytes: READ_CAP, maxPerm: RSI_FILE_MODE },
    verify,
  );

/**
 * 墓碑 → 原名(不覆盖):`'occupied'` = 原路径已被别人占用,或改回途中目标被换成别的东西(墓碑 / 别人的内容都不删);`'absent'` = 墓碑不在。
 * 原名上已有东西:普通文件(EEXIST)或 home-fs 守卫拒绝的异类(链接 / 目录 / 硬链接)——一律当作被占用,墓碑原样保留。
 * 残余(已知,不消除):改回按**路径**取墓碑,没有延续核对时 fd 的身份——核对与改回之间墓碑被换成别的文件时,换上者会被放回原名。
 * 原名在此之前就可被同权限的对抗者直接写入,这不增加其能力;只是「改回的就是刚核对过的那个对象」不在保证范围内。
 */
export async function restoreJournalFromTombstone(
  h: PersonalHome,
  tombName: string,
): Promise<'restored' | 'occupied' | 'absent'> {
  const to = PERSONAL_STATE_FILES.journal;
  try {
    await renameExclusive(homeFsFor(h, [to, tombName]), stateRel(tombName), stateRel(to));
  } catch (e) {
    // 原名上是链接 / 目录 / 硬链接等异类时守卫抛 HomeWriteDeniedError:同样当作被占用(墓碑保留)
    if (isOccupied(e) || e instanceof HomeWriteDeniedError) return 'occupied';
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw e;
  }
  return 'restored';
}

/**
 * 收尾改名 / 改回死在 `link` 之后的**确定半完成态**:状态目录里每个墓碑名文件,若与 `commit-journal.json` 同 dev:ino 且 nlink 恰为 2 → 只删墓碑名,保留原名。
 * 调用方须持 `personal/lock`(`openPersonalRepo` 在读 journal 之前调)。其它形态(孤立墓碑、墓碑与原名不同 inode、原名与非墓碑文件的硬链接)一律不动。
 * 单个墓碑的守卫拒绝 / IO 失败被吞(留给随后的 journal 读取按既有口径 fail-closed);状态目录不存在 = 没有可收尾的。返回收尾的个数。
 */
export async function settleHalfMovedJournal(h: PersonalHome): Promise<number> {
  let names: string[];
  try {
    names = (await readDir(h.stateDir)).map((e) => e.name).filter(isTombstoneName);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw e;
  }
  let n = 0;
  for (const name of names) {
    try {
      const r = await settleHalfLink(
        homeFsFor(h, [PERSONAL_STATE_FILES.journal, name]),
        stateRel(name),
        stateRel(PERSONAL_STATE_FILES.journal),
      );
      if (r === 'settled') n++;
    } catch {
      // 守卫拒绝 / IO 失败:不动,随后读 journal 时 fail-closed
    }
  }
  return n;
}

export const writeTxn = (h: PersonalHome, t: PersonalTxn): Promise<void> => {
  const parsed = PersonalTxnSchema.parse(t);
  return writeState(
    h,
    `${PERSONAL_STATE_FILES.txnDir}/${parsed.txn_id}.json`,
    canonicalJson(parsed),
  );
};

export const removeTxn = (h: PersonalHome, id: string): Promise<void> => {
  const name = `${PERSONAL_STATE_FILES.txnDir}/${id}.json`;
  return remove(homeFsFor(h, [name]), stateRel(name));
};

// ---------------------------------------------------------------------------
// revocations.jsonl:整文件原子重写,只增不删(W0-9)
// ---------------------------------------------------------------------------

async function readRevocationsRaw(
  h: PersonalHome,
): Promise<StateRead<{ text: string; lines: RsiRevocationLine[] }>> {
  const r = await readFileSafe(statePath(h, PERSONAL_STATE_FILES.revocations), {
    maxBytes: RSI_REVOCATIONS_MAX_BYTES,
    owner: RSI_FILE_OWNER,
  });
  if (r.kind === 'missing') return { kind: 'absent' };
  if (r.kind === 'unsafe') return { kind: 'invalid', why: 'unsafe' };
  const lines: RsiRevocationLine[] = [];
  const text = r.bytes.toString('utf8');
  if (text !== '' && !text.endsWith('\n')) return { kind: 'invalid', why: 'parse' };
  for (const line of text === '' ? [] : text.slice(0, -1).split('\n')) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return { kind: 'invalid', why: 'parse' };
    }
    const p = RsiRevocationLineSchema.safeParse(raw);
    if (!p.success) return { kind: 'invalid', why: 'schema' };
    lines.push(p.data);
  }
  return { kind: 'ok', value: { text, lines } };
}

export async function readRevocations(h: PersonalHome): Promise<StateRead<RsiRevocationLine[]>> {
  const r = await readRevocationsRaw(h);
  return r.kind === 'ok' ? { kind: 'ok', value: r.value.lines } : r;
}

/**
 * 追加撤销凭据:读全文 → 旧文本**原样**保留为新文件的前缀 → 追加新行 → 整文件原子重写(读者要么看到旧版要么新版)。
 * 超过 `RSI_REVOCATIONS_MAX_BYTES` 或现有文件不可读 / 不合法 → 抛错、**不写**(R21-6.11 第 4a 行按读取失败处理)。
 */
export async function appendRevocations(
  h: PersonalHome,
  assertHeld: () => Promise<void>,
  add: readonly RsiRevocationLine[],
): Promise<void> {
  const cur = await readRevocationsRaw(h);
  if (cur.kind === 'invalid') throw new PersonalStateError('revocations_invalid', cur.why);
  const old = cur.kind === 'ok' ? cur.value.text : '';
  const text =
    old +
    add.map((l) => `${JSON.stringify(sortedKeys(RsiRevocationLineSchema.parse(l)))}\n`).join('');
  if (Buffer.byteLength(text, 'utf8') > RSI_REVOCATIONS_MAX_BYTES) {
    throw new PersonalStateError('revocations_too_large');
  }
  await assertHeld();
  await writeState(h, PERSONAL_STATE_FILES.revocations, text);
}

function sortedKeys(o: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// ---------------------------------------------------------------------------
// 仓库位置、首次建仓证明、封闭配置的空目录
// ---------------------------------------------------------------------------

/**
 * `owner_repo_fp`(R21-3.2):`sha256(realpath([rsi] repo) ⏎ dev ⏎ ino)` 前 16 位十六进制。
 * 契约未规定三项的拼接格式,这里取换行分隔(路径里不会出现换行以外的歧义分隔符问题:换行本身出现在路径里时 `realpath` 之后仍唯一对应该目录身份)。
 */
export async function ownerRepoFingerprint(repoPath: string): Promise<string> {
  const real = await realpath(repoPath);
  const st = await stat(real);
  return createHash('sha256').update(`${real}\n${st.dev}\n${st.ino}`).digest('hex').slice(0, 16);
}

/**
 * W0-5 首次建仓证明:对 `personal` 目录、`.git`、`head.json`、`commit-journal.json`、`txn/`、`revocations.jsonl` 逐个 `lstat`,
 * **全部确为 ENOENT** 才是 `first`;任一存在(含悬空链接)、不可访问或报其它错误 → `not_first`。调用方须已持 `personal/lock`。
 */
export async function probeFirstTime(h: PersonalHome): Promise<'first' | 'not_first'> {
  const targets = [
    h.repoDir,
    path.join(h.repoDir, '.git'),
    statePath(h, PERSONAL_STATE_FILES.head),
    statePath(h, PERSONAL_STATE_FILES.journal),
    statePath(h, PERSONAL_STATE_FILES.txnDir),
    statePath(h, PERSONAL_STATE_FILES.revocations),
  ];
  for (const t of targets) {
    try {
      await lstat(t);
      return 'not_first';
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return 'not_first';
    }
  }
  return 'first';
}

/** 建私有仓库目录(0700);已存在则不动。git init 之前调用。 */
export async function makeRepoDir(h: PersonalHome): Promise<void> {
  const ctx = createHomeFsContext({
    home: h.home,
    // 只为让 mkdirp 的「目录必须是计划目标的祖先」判定通过;这个文件永远不会被写
    planScope: [`${PERSONAL_REPO_REL}/.git/HEAD`],
    tmpDir: h.io.tmpDir,
    ...(h.onStage !== undefined ? { onStage: h.onStage } : {}),
    ...(h.io.writeAudit !== undefined ? { writeAudit: h.io.writeAudit } : {}),
  });
  await mkdirp(ctx, PERSONAL_REPO_REL, DIR_MODE);
}

/** 确保封闭 git 配置用的空目录存在且仍为空(`core.hooksPath` / `init.templateDir` 指向它);返回其绝对路径。 */
export async function ensureEmptyDir(h: PersonalHome): Promise<string> {
  const rel = stateRel(PERSONAL_STATE_FILES.emptyDir);
  const ctx = createHomeFsContext({
    home: h.home,
    planScope: [`${rel}/.keep`], // 只为 mkdirp 的祖先判定;永不写入
    tmpDir: h.io.tmpDir,
    ...(h.io.writeAudit !== undefined ? { writeAudit: h.io.writeAudit } : {}),
  });
  await mkdirp(ctx, rel, DIR_MODE);
  const dir = statePath(h, PERSONAL_STATE_FILES.emptyDir);
  if ((await readDir(dir)).length !== 0) throw new PersonalStateError('empty_dir_not_empty');
  return dir;
}
