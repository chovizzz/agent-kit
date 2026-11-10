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
import { createHash } from 'node:crypto';
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
  mkdirp,
  remove,
  writeFile,
  type HomeFsContext,
  type HomeFsStage,
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
}

export function personalHome(
  io: IoContext,
  home: string,
  opts: { onStage?: (stage: HomeFsStage) => void | Promise<void> } = {},
): PersonalHome {
  if (!path.isAbsolute(home)) throw new Error('personalHome: home 必须是绝对路径');
  return {
    io,
    home,
    repoDir: path.join(home, ...PERSONAL_REPO_REL.split('/')),
    stateDir: path.join(home, ...PERSONAL_STATE_REL.split('/')),
    ...(opts.onStage !== undefined ? { onStage: opts.onStage } : {}),
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
  writeState(
    h,
    PERSONAL_STATE_FILES.journal,
    canonicalJson(PersonalCommitJournalSchema.parse(j)),
  );

export const removeJournal = (h: PersonalHome): Promise<void> =>
  remove(
    homeFsFor(h, [PERSONAL_STATE_FILES.journal]),
    stateRel(PERSONAL_STATE_FILES.journal),
  );

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
    old + add.map((l) => `${JSON.stringify(sortedKeys(RsiRevocationLineSchema.parse(l)))}\n`).join('');
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
