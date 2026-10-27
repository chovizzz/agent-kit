/**
 * 暂存区(`<stateDir>/reflect/<run_id>/`、`<stateDir>/promote/<promo_id>/`)的读写原语(契约 R20-4.7 / R20-4.8;R20-A2 B3c)。
 * 只给 `taint.ts` / `immediate-gate.ts` / `attribution.ts` 用,不属于冻结接口。
 *
 * - **写**:一律经 {@link Writer.op}:`hook(before:<名>)` → `lock.assertHeld()` → 单次写操作 → `hook(after:<名>)`。assert 与写之间不做任何读取 / 计算;
 *   钩子只用于测试注入崩溃 / 丢锁,生产不传。全部走 safe-fs(写出口守卫),数据文件一律临时文件 + rename。
 * - **读**:一律不跟随符号链接(`lstat` / `O_NOFOLLOW`),目录层级逐级判断,不能安全判断就抛 fail-closed,不假装「没有」。
 * - **taint 清理采用白名单**(opus 咨询):已标 `TAINTED` 的 run 目录里只保留 `TAINTED`、`report.json`、`proposals/*.yaml`(摘录清空)与
 *   `rules/**` 下的 `*.md`(摘录清空);其余一律删除(含 `apply.patch`、`.tmp`、`.yml`、子目录里的杂项)。promote 目录只保留 `TAINTED` 与 `report.json`。
 *   无法解析 / 形状异常 / 硬链接的 `proposals/<id>.yaml` 换成**同名空文件**(临时文件 + rename):`loadUsedProposalIds` 只按文件名发号,删掉会让编号被重发。
 *   同样情形的 `rules/**` 文件直接删除。
 */
import * as path from 'node:path';
import { isMap, isSeq, parseDocument } from 'yaml';
import { parseRestrictedYaml, splitFrontmatter } from '../../atoms/frontmatter.js';
import { RunIdSchema } from '../../contracts/common.js';
import { RsiTaintMarkSchema } from '../../contracts/rsi.js';
import { canonicalJson } from '../../io/canonical-json.js';
import type { IoContext } from '../../io/paths.js';
import { lstat, readDir, readFileSafe, type DirEntry } from '../../io/read-fs.js';
import { createExclusive, remove, rename, WriteDeniedError } from '../../io/safe-fs.js';
import type { RsiLockHandle } from '../lock.js';
import { RsiFailClosedError } from '../types.js';

export type StagingKind = 'run' | 'promote';
export type TaintReason = 'exclude' | 'purge';

/** 测试缝:`point(名字)` 在每个写操作的前后各调一次(抛错 = 在该处崩溃;改锁文件 = 在该处丢锁) */
export interface ServiceHooks {
  point?: (name: string) => Promise<void> | void;
}

const MAX_STAGED_FILE_BYTES = 4 * 1024 * 1024;
const MAX_WALK_DEPTH = 8;
export const TAINT_MARK = 'TAINTED';

/** 写操作的统一出口:钩子 → assertHeld → 写 → 钩子。`WriteDeniedError` 映射为 fail-closed `write_denied` */
export class Writer {
  constructor(
    readonly io: IoContext,
    readonly lock: RsiLockHandle,
    readonly hooks: ServiceHooks = {},
  ) {}

  async op<T>(name: string, fn: () => Promise<T>): Promise<T> {
    await this.hooks.point?.(`before:${name}`);
    await this.lock.assertHeld();
    let result: T;
    try {
      result = await fn();
    } catch (e) {
      if (e instanceof WriteDeniedError) throw new RsiFailClosedError('write_denied');
      throw e;
    }
    await this.hooks.point?.(`after:${name}`);
    return result;
  }
}

export const stagingRoot = (io: IoContext, kind: StagingKind): string =>
  path.join(io.stateDir, kind === 'run' ? 'reflect' : 'promote');
export const stagingDir = (io: IoContext, kind: StagingKind, id: string): string =>
  path.join(stagingRoot(io, kind), id);

/** run / promote id:冻结的 `RunIdSchema`(拒绝 `/`、`..`、绝对路径、点开头);`reflect/cwd` 是反思器工作目录不是 run */
export function isStagingId(id: string, kind: StagingKind = 'run'): boolean {
  return RunIdSchema.safeParse(id).success && !(kind === 'run' && id === 'cwd');
}

/** `report.json` 只有真实普通文件才在白名单内(目录 / 符号链接冒名的按非白名单条目清掉) */
const isReport = (e: DirEntry): boolean =>
  e.name === 'report.json' && e.isFile && !e.isSymbolicLink;

const errno = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;

type DirProbe = 'missing' | 'dir' | 'unsafe';
/** 不跟随链接:是真实目录 / 不存在 / 其它(链接、普通文件等) */
async function probeDir(p: string): Promise<DirProbe> {
  try {
    const st = await lstat(p);
    return st.isDirectory() && !st.isSymbolicLink() ? 'dir' : 'unsafe';
  } catch (e) {
    if (errno(e) === 'ENOENT') return 'missing';
    throw new RsiFailClosedError('state_dir_unsafe');
  }
}

async function listDir(dir: string): Promise<DirEntry[]> {
  try {
    return await readDir(dir);
  } catch {
    throw new RsiFailClosedError('state_dir_unsafe');
  }
}

/** 暂存根下的全部真实子目录 id(合法 id、非符号链接);根不存在 = 空;根本身是链接 / 非目录 = fail-closed */
export async function listStaging(io: IoContext, kind: StagingKind): Promise<string[]> {
  const root = stagingRoot(io, kind);
  const p = await probeDir(root);
  if (p === 'missing') return [];
  if (p === 'unsafe') throw new RsiFailClosedError('state_dir_unsafe');
  return (await listDir(root))
    .filter((e) => e.isDirectory && !e.isSymbolicLink && isStagingId(e.name, kind))
    .map((e) => e.name);
}

/**
 * 目标目录:`missing`(不存在)或真实目录。**逐级**不跟随链接:先查暂存根(`reflect/` / `promote/`)再查目标目录,链接 / 非目录 = fail-closed。
 * 所有读写入口都经它(或 {@link assertStagingRoot}),不依赖调用方事先 `listStaging`:`O_NOFOLLOW` / `lstat` 只管最后一级,祖先是链接时要靠这里挡。
 */
export async function probeStagingDir(
  io: IoContext,
  kind: StagingKind,
  id: string,
): Promise<'missing' | 'dir'> {
  if (!isStagingId(id, kind)) throw new RsiFailClosedError('internal');
  if ((await probeDir(stagingRoot(io, kind))) === 'unsafe') {
    throw new RsiFailClosedError('state_dir_unsafe');
  }
  const p = await probeDir(stagingDir(io, kind, id));
  if (p === 'unsafe') throw new RsiFailClosedError('state_dir_unsafe');
  return p;
}

// ---------------------------------------------------------------------------
// TAINTED 标记
// ---------------------------------------------------------------------------
export type MarkRead = { present: false } | { present: true; reason: TaintReason };

/**
 * 标记存在性用 `lstat` 判(任何类型——空文件、半个 JSON、目录、符号链接——都算「已标记」,隐私兜底);reason 读不出按 `exclude`。
 * 除 ENOENT 之外的错误不能当「没有」:抛 fail-closed。
 */
export async function readMark(io: IoContext, kind: StagingKind, id: string): Promise<MarkRead> {
  if ((await probeStagingDir(io, kind, id)) === 'missing') return { present: false };
  const file = path.join(stagingDir(io, kind, id), TAINT_MARK);
  let st;
  try {
    st = await lstat(file);
  } catch (e) {
    if (errno(e) === 'ENOENT') return { present: false };
    throw new RsiFailClosedError('state_dir_unsafe');
  }
  if (!st.isFile() || st.isSymbolicLink()) return { present: true, reason: 'exclude' };
  const r = await readFileSafe(file, { maxBytes: 4096 });
  if (r.kind !== 'ok') return { present: true, reason: 'exclude' };
  try {
    return {
      present: true,
      reason: RsiTaintMarkSchema.parse(JSON.parse(r.bytes.toString('utf8'))).reason,
    };
  } catch {
    return { present: true, reason: 'exclude' };
  }
}

/** 独占创建标记;已存在(EEXIST)= 已标记,保留原 reason。返回是否本次新建 */
export async function createMark(
  w: Writer,
  kind: StagingKind,
  id: string,
  reason: TaintReason,
  at: Date,
): Promise<boolean> {
  const file = path.join(stagingDir(w.io, kind, id), TAINT_MARK);
  const body = canonicalJson({ reason, at: at.toISOString() });
  try {
    await w.op(`mark:${kind}:${id}`, () => createExclusive(w.io, file, body, 0o600));
    return true;
  } catch (e) {
    if (errno(e) === 'EEXIST') return false;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 摘录清空
// ---------------------------------------------------------------------------
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

type Blank = { kind: 'ok'; text: string; changed: boolean } | { kind: 'bad' };

const excerptsOf = (value: unknown): string[] | undefined => {
  if (!isPlainObject(value)) return undefined;
  const ev = value['evidence'];
  if (!Array.isArray(ev) || ev.length === 0 || !ev.every(isPlainObject)) return undefined;
  return ev.map((e) => (typeof e['excerpt'] === 'string' ? e['excerpt'] : '\u0000'));
};

const stripExcerpts = (value: unknown): string => {
  const o = structuredClone(value) as Record<string, unknown>;
  for (const e of o['evidence'] as Record<string, unknown>[]) e['excerpt'] = '';
  return JSON.stringify(o);
};

/** 把 yaml 文本里 `evidence[].excerpt` 全部置空串,其余原样(`yaml` Document 就地改);整体回读核对后才返回 */
export function blankYamlExcerpts(yamlText: string): Blank {
  const parsed = parseRestrictedYaml(yamlText, 'staged', 'TAINT_YAML');
  if (!parsed.ok) return { kind: 'bad' };
  const before = excerptsOf(parsed.value);
  if (before === undefined) return { kind: 'bad' };
  if (before.every((x) => x === '')) return { kind: 'ok', text: yamlText, changed: false };
  let out: string;
  try {
    const doc = parseDocument(yamlText, {
      uniqueKeys: true,
      version: '1.2',
      schema: 'core',
      merge: false,
    });
    const seq = doc.get('evidence', true);
    if (!isSeq(seq)) return { kind: 'bad' };
    for (const item of seq.items) {
      if (!isMap(item)) return { kind: 'bad' };
      item.set('excerpt', '');
    }
    out = doc.toString({ lineWidth: 0 });
  } catch {
    return { kind: 'bad' };
  }
  const back = parseRestrictedYaml(out, 'staged', 'TAINT_YAML');
  if (!back.ok) return { kind: 'bad' };
  const after = excerptsOf(back.value);
  if (after === undefined || !after.every((x) => x === '')) return { kind: 'bad' };
  if (stripExcerpts(back.value) !== stripExcerpts(parsed.value)) return { kind: 'bad' };
  return { kind: 'ok', text: out, changed: true };
}

/** 原子 `*.md`:只改 frontmatter 的证据摘录,正文逐字保留 */
export function blankAtomExcerpts(source: string): Blank {
  const split = splitFrontmatter(source);
  if (split.yamlText === undefined || split.yamlText === '') return { kind: 'bad' };
  const r = blankYamlExcerpts(split.yamlText);
  if (r.kind === 'bad') return r;
  if (!r.changed) return { kind: 'ok', text: source, changed: false };
  const text = `---\n${r.text.endsWith('\n') ? r.text : `${r.text}\n`}---\n${split.body}`;
  // 回读:新文本的 frontmatter 仍能切出并全空
  const again = splitFrontmatter(text);
  if (again.yamlText === undefined || again.body !== split.body) return { kind: 'bad' };
  const chk = blankYamlExcerpts(again.yamlText);
  if (chk.kind !== 'ok' || chk.changed) return { kind: 'bad' };
  return { kind: 'ok', text, changed: true };
}

async function readStaged(file: string): Promise<string | undefined> {
  const r = await readFileSafe(file, { maxBytes: MAX_STAGED_FILE_BYTES });
  return r.kind === 'ok' ? r.bytes.toString('utf8') : undefined;
}

/** 临时文件 + rename;陈旧临时文件先删。三个写点各自 assertHeld */
async function writeAtomic(w: Writer, rel: string, dest: string, content: string): Promise<void> {
  const tmp = `${dest}.taint.tmp`;
  await w.op(`tmp-remove:${rel}`, () => remove(w.io, tmp));
  await w.op(`tmp-write:${rel}`, () => createExclusive(w.io, tmp, content, 0o600));
  await w.op(`rename:${rel}`, () => rename(w.io, tmp, dest));
}

interface SweepSpec {
  /** 受管文件后缀 */
  ext: '.yaml' | '.md';
  /** 是否递归子目录(`rules/<layer>/…`);`proposals/` 是平的 */
  recursive: boolean;
  /** 无法解析的受管文件:`placeholder` = 同名空文件(提案编号保留),`delete` = 删除 */
  onBad: 'placeholder' | 'delete';
}

async function sweepTree(
  w: Writer,
  abs: string,
  rel: string,
  spec: SweepSpec,
  depth: number,
): Promise<boolean> {
  if (depth > MAX_WALK_DEPTH) throw new RsiFailClosedError('state_dir_unsafe');
  let changed = false;
  const entries = await listDir(abs);
  if (spec.onBad === 'placeholder') {
    // 崩溃恢复:上次在「先写占位临时文件、再删异常条目、最后 rename」之间死掉 → 原名不在了、只剩 `<id>.yaml.taint.tmp`。
    // 临时文件内容不可信(也可能是别人预置的),所以不 rename 它,而是按同名补一个空占位,编号因此不丢
    const names = new Set(entries.map((x) => x.name));
    for (const e of entries) {
      const base = e.name.endsWith('.taint.tmp')
        ? e.name.slice(0, -'.taint.tmp'.length)
        : undefined;
      if (base !== undefined && base.endsWith(spec.ext) && !names.has(base)) {
        await writeAtomic(w, `${rel}/${base}`, path.join(abs, base), '');
        changed = true;
      }
    }
  }
  for (const e of entries) {
    const p = path.join(abs, e.name);
    const r = `${rel}/${e.name}`;
    const keepsId = spec.onBad === 'placeholder' && e.name.endsWith(spec.ext);
    if (e.isDirectory && !e.isSymbolicLink) {
      if (spec.recursive) {
        changed = (await sweepTree(w, p, r, spec, depth + 1)) || changed;
      } else if (keepsId) {
        // 名为 `<id>.yaml` 的目录:rename 覆盖不了目录。先落占位临时文件(保住编号),再删目录,最后 rename;中途崩溃由上面的恢复步骤补占位
        const tmp = `${p}.taint.tmp`;
        await w.op(`tmp-remove:${r}`, () => remove(w.io, tmp));
        await w.op(`tmp-write:${r}`, () => createExclusive(w.io, tmp, '', 0o600));
        await w.op(`remove:${r}`, () => remove(w.io, p));
        await w.op(`rename:${r}`, () => rename(w.io, tmp, p));
        changed = true;
      } else {
        await w.op(`remove:${r}`, () => remove(w.io, p));
        changed = true;
      }
      continue;
    }
    const managed = e.isFile && !e.isSymbolicLink && e.name.endsWith(spec.ext);
    if (!managed) {
      // 链接 / 非普通文件 / 其它后缀(含 `.tmp`、`.yml`):不读、不跟随。proposals 里的 `<id>.yaml` 是链接 / 异常类型时用「临时文件 + rename」直接覆盖该目录项
      // (rename 换的是目录项本身,不跟随链接;不先删,免得崩在中间丢编号);其余直接删
      if (keepsId) await writeAtomic(w, r, p, '');
      else await w.op(`remove:${r}`, () => remove(w.io, p));
      changed = true;
      continue;
    }
    const text = await readStaged(p);
    const res =
      text === undefined
        ? ({ kind: 'bad' } as const)
        : spec.ext === '.yaml'
          ? blankYamlExcerpts(text)
          : blankAtomExcerpts(text);
    if (res.kind === 'bad') {
      if (spec.onBad === 'placeholder') {
        // 已是空文件 = 此前的占位,不是变化
        if (text !== '') {
          await writeAtomic(w, r, p, '');
          changed = true;
        }
      } else {
        await w.op(`remove:${r}`, () => remove(w.io, p));
        changed = true;
      }
      continue;
    }
    if (res.changed) {
      await writeAtomic(w, r, p, res.text);
      changed = true;
    }
  }
  return changed;
}

/**
 * run 目录的 taint 清理(动作 ②③,标记由调用方先落):② 清空 `proposals/*.yaml` 与 `rules/**\/*.md` 的全部摘录 → ③ 删 `apply.patch` 及其它非白名单条目。
 * 幂等:已清理的目录不再有写操作。返回「本次是否改动了任何东西」。完成后做只读复核,仍有摘录 / 杂项则抛 `internal`(不宣称完成)。
 */
export async function cleanRunDir(w: Writer, id: string): Promise<boolean> {
  const dir = stagingDir(w.io, 'run', id);
  if ((await probeStagingDir(w.io, 'run', id)) === 'missing') return false;
  let changed = false;
  const top = await listDir(dir);
  // ② 摘录
  for (const [name, spec] of [
    ['proposals', { ext: '.yaml', recursive: false, onBad: 'placeholder' }],
    ['rules', { ext: '.md', recursive: true, onBad: 'delete' }],
  ] as const) {
    const e = top.find((x) => x.name === name);
    if (e === undefined) continue;
    if (e.isDirectory && !e.isSymbolicLink) {
      changed = (await sweepTree(w, path.join(dir, name), `${id}/${name}`, spec, 0)) || changed;
    }
    // 链接 / 普通文件冒充目录:留给下面的白名单清扫(整个条目删掉)
  }
  // ③ 其余一律删(apply.patch、临时文件、杂项);白名单:TAINTED、report.json、proposals/、rules/
  for (const e of top) {
    const keep =
      e.name === TAINT_MARK ||
      isReport(e) ||
      ((e.name === 'proposals' || e.name === 'rules') && e.isDirectory && !e.isSymbolicLink);
    if (keep) continue;
    await w.op(`remove:${id}/${e.name}`, () => remove(w.io, path.join(dir, e.name)));
    changed = true;
  }
  await verifyRunClean(w.io, id);
  return changed;
}

/** promote 目录的 taint 清理:只保留 `TAINTED` 与 `report.json`(删 `promote.patch`、`pr-body.md` 及其它) */
export async function cleanPromoteDir(w: Writer, id: string): Promise<boolean> {
  const dir = stagingDir(w.io, 'promote', id);
  if ((await probeStagingDir(w.io, 'promote', id)) === 'missing') return false;
  let changed = false;
  for (const e of await listDir(dir)) {
    if (e.name === TAINT_MARK || isReport(e)) continue;
    await w.op(`remove:promote/${id}/${e.name}`, () => remove(w.io, path.join(dir, e.name)));
    changed = true;
  }
  const left = (await listDir(dir)).filter(
    (e) => e.name !== TAINT_MARK && e.name !== 'report.json',
  );
  if (left.length > 0) throw new RsiFailClosedError('internal');
  return changed;
}

async function verifyTree(abs: string, spec: SweepSpec, depth: number): Promise<void> {
  if (depth > MAX_WALK_DEPTH) throw new RsiFailClosedError('state_dir_unsafe');
  for (const e of await listDir(abs)) {
    const p = path.join(abs, e.name);
    if (e.isDirectory && !e.isSymbolicLink && spec.recursive) {
      await verifyTree(p, spec, depth + 1);
      continue;
    }
    if (!(e.isFile && !e.isSymbolicLink && e.name.endsWith(spec.ext))) {
      throw new RsiFailClosedError('internal');
    }
    const text = await readStaged(p);
    if (text === undefined) throw new RsiFailClosedError('internal');
    if (text === '' && spec.onBad === 'placeholder') continue;
    const r = spec.ext === '.yaml' ? blankYamlExcerpts(text) : blankAtomExcerpts(text);
    if (r.kind !== 'ok' || r.changed) throw new RsiFailClosedError('internal');
  }
}

/** 只读复核:run 目录里没有非白名单条目,所有受管文件的摘录都是空串 */
export async function verifyRunClean(io: IoContext, id: string): Promise<void> {
  const dir = stagingDir(io, 'run', id);
  for (const e of await listDir(dir)) {
    if (e.name === TAINT_MARK || isReport(e)) continue;
    if (e.name === 'proposals' && e.isDirectory && !e.isSymbolicLink) {
      await verifyTree(
        path.join(dir, e.name),
        { ext: '.yaml', recursive: false, onBad: 'placeholder' },
        0,
      );
    } else if (e.name === 'rules' && e.isDirectory && !e.isSymbolicLink) {
      await verifyTree(path.join(dir, e.name), { ext: '.md', recursive: true, onBad: 'delete' }, 0);
    } else {
      throw new RsiFailClosedError('internal');
    }
  }
}

// ---------------------------------------------------------------------------
// promote → run 的关联
// ---------------------------------------------------------------------------
/** promote 目录的 `report.json.run_id`;读不出 / 不合法 = `undefined`(无法关联,调用方保守处理) */
export async function promoteRunId(io: IoContext, id: string): Promise<string | undefined> {
  if ((await probeStagingDir(io, 'promote', id)) === 'missing') return undefined;
  const file = path.join(stagingDir(io, 'promote', id), 'report.json');
  const r = await readFileSafe(file, { maxBytes: MAX_STAGED_FILE_BYTES });
  if (r.kind !== 'ok') return undefined;
  try {
    const v: unknown = JSON.parse(r.bytes.toString('utf8'));
    const rid = isPlainObject(v) ? v['run_id'] : undefined;
    return typeof rid === 'string' && isStagingId(rid, 'run') ? rid : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 证据读取(只读;给归属闸与 exclude taint 用)
// ---------------------------------------------------------------------------
export interface RunEvidence {
  /** 目录是否存在 */
  exists: boolean;
  /** 读到的证据 sig(提案 `evidence[].sig` 与原子 `evidence[].ref` 中 `type === 'trace'` 的) */
  sigs: Set<string>;
  /** 有文件读不出 / 无法解析 / 形状异常 / 不安全:证据集合不完整,不能把它当「没有证据」 */
  unknown: boolean;
}

async function walkFiles(
  abs: string,
  ext: string,
  recursive: boolean,
  depth: number,
): Promise<{ files: string[]; unknown: boolean }> {
  const out: string[] = [];
  let unknown = false;
  let entries: DirEntry[];
  try {
    entries = await readDir(abs);
  } catch {
    return { files: out, unknown: true };
  }
  for (const e of entries) {
    const p = path.join(abs, e.name);
    if (e.isSymbolicLink) {
      unknown = true;
    } else if (e.isDirectory) {
      if (recursive && depth < MAX_WALK_DEPTH) {
        const sub = await walkFiles(p, ext, recursive, depth + 1);
        out.push(...sub.files);
        unknown = unknown || sub.unknown;
      } else unknown = true;
    } else if (e.isFile) {
      if (e.name.endsWith(ext)) out.push(p);
      else if (e.name.endsWith('.tmp')) unknown = true;
    } else unknown = true;
  }
  return { files: out, unknown };
}

export async function readRunEvidence(io: IoContext, id: string): Promise<RunEvidence> {
  if (!isStagingId(id, 'run')) throw new RsiFailClosedError('internal');
  const dir = stagingDir(io, 'run', id);
  // 暂存根与 run 目录逐级不跟随链接;链接 = fail-closed(闸报 state_dir_unsafe),不会读到链接目标里的「合法证据」
  if ((await probeStagingDir(io, 'run', id)) === 'missing') {
    return { exists: false, sigs: new Set(), unknown: false };
  }
  const ev: RunEvidence = { exists: true, sigs: new Set(), unknown: false };
  for (const [sub, ext, recursive] of [
    ['proposals', '.yaml', false],
    ['rules', '.md', true],
  ] as const) {
    const sd = path.join(dir, sub);
    const ps = await probeDir(sd);
    if (ps === 'missing') continue;
    if (ps === 'unsafe') {
      ev.unknown = true;
      continue;
    }
    const w = await walkFiles(sd, ext, recursive, 0);
    ev.unknown = ev.unknown || w.unknown;
    for (const file of w.files) {
      const text = await readStaged(file);
      if (text === undefined) {
        ev.unknown = true;
        continue;
      }
      const yamlText = ext === '.yaml' ? text : splitFrontmatter(text).yamlText;
      const parsed =
        yamlText === undefined ? undefined : parseRestrictedYaml(yamlText, 'staged', 'TAINT_YAML');
      if (parsed === undefined || !parsed.ok || !isPlainObject(parsed.value)) {
        // 已被清成空占位的提案不含证据,不是「未知」
        if (!(ext === '.yaml' && text === '')) ev.unknown = true;
        continue;
      }
      const items = parsed.value['evidence'];
      if (!Array.isArray(items) || items.length === 0 || !items.every(isPlainObject)) {
        ev.unknown = true;
        continue;
      }
      for (const item of items) {
        if (ext === '.yaml') {
          const sig = item['sig'];
          if (typeof sig === 'string' && sig !== '') ev.sigs.add(sig);
          else ev.unknown = true;
        } else {
          // 原子证据契约:`type`(开放字符串)与 `ref` 都是非空字符串;形状不合规 = 无法判定归属,不是「没有证据」。只有 `trace` 的 ref 是信号 id
          const type = item['type'];
          const ref = item['ref'];
          if (typeof type !== 'string' || type === '' || typeof ref !== 'string' || ref === '') {
            ev.unknown = true;
          } else if (type === 'trace') {
            ev.sigs.add(ref);
          }
        }
      }
    }
  }
  return ev;
}
