/**
 * 归属判定的只读原语(契约 R20-4.3 / R20-4.4 / R20-4.6;R20-A2 B3c):信号库 `sig_id → project_key` 映射、项目 key 的 X / U / P 现算。
 * 每次调用现读配置给出的排除项、索引与信号库,**不缓存**。只给 `taint.ts` / `immediate-gate.ts` 用。
 *
 * 分类(每个 key 只落入一类,优先级 X > U > P):
 *  - X:索引里该 key 的任一 `roots[].path` 命中当前排除规则(`canonical()` + 折叠大小写;`exclude_dirs` = 相等或位于其下(段边界);
 *    `exclude_names` = 任一根路径的 basename 相等;另:排除目录当前存在时,根路径的任一祖先目录 `(dev, ino)` 与之相同也算命中)。根路径已不存在也照算。
 *  - U:索引缺失 / 损坏、key 不在索引里、`salt_fp` 与 `counts.json` 不符(或 counts 读不出)、最近一次见到的根路径现在的 `realpath` 与记录不逐字节相等 /
 *    不存在、或其 `(dev, ino)` 与记录不同。
 *  - P:其余。
 * X 的判定只依赖索引里的根路径,不依赖盐是否相符:X 优先级最高,宁可多 taint。
 */
import * as path from 'node:path';
import {
  RSI_AGENT_IDS,
  RsiCountsSchema,
  RsiProjectIndexSchema,
  type RsiProjectIndex,
} from '../../contracts/rsi.js';
import type { IoContext } from '../../io/paths.js';
import {
  MAX_LINE_BYTES,
  TOO_LONG_LINE,
  lstat,
  readDir,
  readFileSafe,
  readLines,
  realpath,
  stat,
} from '../../io/read-fs.js';
import { canonical } from '../../signals/exclude.js';
import type { RsiConfigOn } from '../config.js';
import { RSI_FILE_OWNER, rsiDirReadonly } from '../lock.js';
import { RsiFailClosedError } from '../types.js';

const FIXED_MAX_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// rsi 固定文件(只读)
// ---------------------------------------------------------------------------
export type FixedRead = { kind: 'ok'; bytes: Buffer } | { kind: 'missing' };

/** `.state/rsi/<name>` 的句柄级安全读取(属主 / ≤0600 / 普通文件 / nlink==1);元数据不合规 → fail-closed `state_dir_unsafe`;`rsi/` 不存在 = missing */
export async function readRsiFixed(
  io: IoContext,
  name: string,
  maxBytes = FIXED_MAX_BYTES,
): Promise<FixedRead> {
  const d = await rsiDirReadonly(io);
  if (d.kind === 'missing') return { kind: 'missing' };
  if (d.kind === 'unsafe') throw new RsiFailClosedError('state_dir_unsafe');
  const r = await readFileSafe(path.join(d.dir, name), { maxBytes, owner: RSI_FILE_OWNER });
  if (r.kind === 'ok') return { kind: 'ok', bytes: r.bytes };
  if (r.kind === 'missing') return { kind: 'missing' };
  throw new RsiFailClosedError('state_dir_unsafe');
}

export type IndexRead = { kind: 'ok'; index: RsiProjectIndex } | { kind: 'bad' };

/** 索引:缺失 / 过不了 schema = `bad`(归属闸按 U);元数据不合规照抛 */
export async function readIndex(io: IoContext): Promise<IndexRead> {
  const r = await readRsiFixed(io, 'projects.json');
  if (r.kind === 'missing') return { kind: 'bad' };
  try {
    const p = RsiProjectIndexSchema.safeParse(JSON.parse(r.bytes.toString('utf8')));
    return p.success ? { kind: 'ok', index: p.data } : { kind: 'bad' };
  } catch {
    return { kind: 'bad' };
  }
}

/** `counts.json` 的 `salt_fp`;缺失 / 损坏 = null */
export async function readCountsSaltFp(io: IoContext): Promise<string | null> {
  const r = await readRsiFixed(io, 'counts.json');
  if (r.kind === 'missing') return null;
  try {
    const p = RsiCountsSchema.safeParse(JSON.parse(r.bytes.toString('utf8')));
    return p.success ? p.data.salt_fp : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 信号库映射
// ---------------------------------------------------------------------------
const MONTH_RE = /^\d{6}\.jsonl$/;
const corrupt = (): RsiFailClosedError => new RsiFailClosedError('signal_store_corrupt');

async function realDirOrMissing(p: string): Promise<boolean> {
  try {
    const st = await lstat(p);
    if (st.isSymbolicLink() || !st.isDirectory()) throw corrupt();
    return true;
  } catch (e) {
    if (e instanceof RsiFailClosedError) throw e;
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw corrupt();
  }
}

/**
 * 只读流式扫 `.state/signals/<agent>/*.jsonl`,返回 `needed` 里每个 sig_id 的 `project_key`(查不到的不在结果里)。
 * 链接 / 非普通文件 / 超长行 / 非 JSON / 缺 sig_id 的行 / 同一 sig_id 映射到不同 key → fail-closed `signal_store_corrupt`(不任选一条)。
 */
export async function loadSigKeys(
  io: IoContext,
  needed: ReadonlySet<string>,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (needed.size === 0) return found;
  const root = path.join(io.stateDir, 'signals');
  if (!(await realDirOrMissing(root))) return found;
  for (const agent of RSI_AGENT_IDS) {
    const dir = path.join(root, agent);
    if (!(await realDirOrMissing(dir))) continue;
    let entries;
    try {
      entries = await readDir(dir);
    } catch {
      throw corrupt();
    }
    for (const f of entries) {
      if (!MONTH_RE.test(f.name)) continue;
      if (!f.isFile || f.isSymbolicLink) throw corrupt();
      try {
        for await (const line of readLines(path.join(dir, f.name), MAX_LINE_BYTES)) {
          if (line === '') continue;
          if (line === TOO_LONG_LINE) throw corrupt();
          let o: unknown;
          try {
            o = JSON.parse(line);
          } catch {
            throw corrupt();
          }
          const id = (o as { sig_id?: unknown } | null)?.sig_id;
          if (typeof id !== 'string') throw corrupt();
          if (!needed.has(id)) continue;
          const key = (o as { project_key?: unknown }).project_key;
          if (typeof key !== 'string' || key === '') throw corrupt();
          const prev = found.get(id);
          if (prev !== undefined && prev !== key) throw corrupt();
          found.set(id, key);
        }
      } catch (e) {
        if (e instanceof RsiFailClosedError) throw e;
        throw corrupt();
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// 排除匹配
// ---------------------------------------------------------------------------
const fold = (s: string): string => s.toLowerCase();

function within(dir: string, child: string): boolean {
  if (child === dir) return true;
  return child.startsWith(dir.endsWith('/') ? dir : `${dir}/`);
}

export interface ExcludeMatcher {
  matches(rootPath: string): Promise<boolean>;
}

/** 由**当前**配置(调用方刚重读的)现建;`exclude_dirs` 里的相对路径(`block = exclude_invalid`)不会走到这里 */
export async function buildExcludeMatcher(
  cfg: Pick<RsiConfigOn, 'excludeDirs' | 'excludeNames'>,
): Promise<ExcludeMatcher> {
  const dirs: { folded: string; id: string | undefined }[] = [];
  for (const d of cfg.excludeDirs) {
    const c = await canonical(d);
    let id: string | undefined;
    try {
      const st = await stat(c);
      id = `${st.dev}:${st.ino}`;
    } catch {
      id = undefined;
    }
    dirs.push({ folded: fold(c), id });
  }
  const names = cfg.excludeNames.map(fold);
  const ids = dirs.map((d) => d.id).filter((x): x is string => x !== undefined);
  return {
    async matches(rootPath: string): Promise<boolean> {
      const c = await canonical(rootPath);
      const f = fold(c);
      if (dirs.some((d) => within(d.folded, f))) return true;
      if (names.includes(fold(path.basename(c)))) return true;
      if (ids.length > 0) {
        for (let a = c; ; a = path.dirname(a)) {
          try {
            const st = await stat(a);
            if (ids.includes(`${st.dev}:${st.ino}`)) return true;
          } catch {
            // 不存在的祖先:按字面前缀已判过
          }
          if (path.dirname(a) === a) break;
        }
      }
      return false;
    },
  };
}

// ---------------------------------------------------------------------------
// X / U / P
// ---------------------------------------------------------------------------
export type KeyClass = 'X' | 'U' | 'P';

export interface ClassifyInputs {
  index: IndexRead;
  countsSaltFp: string | null;
  matcher: ExcludeMatcher;
}

export function createClassifier(inputs: ClassifyInputs): (key: string) => Promise<KeyClass> {
  const memo = new Map<string, KeyClass>();
  const index = inputs.index.kind === 'ok' ? inputs.index.index : undefined;
  const byKey = new Map(index?.entries.map((e) => [e.key, e]));
  const saltOk =
    index !== undefined && inputs.countsSaltFp !== null && index.salt_fp === inputs.countsSaltFp;
  return async (key: string): Promise<KeyClass> => {
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const entry = byKey.get(key);
    let cls: KeyClass;
    if (entry === undefined) cls = 'U';
    else {
      let excluded = false;
      for (const r of entry.roots) {
        if (await inputs.matcher.matches(r.path)) {
          excluded = true;
          break;
        }
      }
      if (excluded) cls = 'X';
      else if (!saltOk) cls = 'U';
      else cls = (await rootsStillMatch(entry.roots)) ? 'P' : 'U';
    }
    memo.set(key, cls);
    return cls;
  };
}

/** 最近一次见到(`last_seen` 最大,并列取靠后)的根路径:`realpath` 与记录逐字节相等且 `(dev, ino)` 相同 */
async function rootsStillMatch(
  roots: RsiProjectIndex['entries'][number]['roots'],
): Promise<boolean> {
  let latest = roots[0];
  for (const r of roots) if (latest === undefined || r.last_seen >= latest.last_seen) latest = r;
  if (latest === undefined) return false;
  try {
    const real = await realpath(latest.path);
    if (real !== latest.path) return false;
    const st = await stat(real);
    return st.dev === latest.dev && st.ino === latest.ino;
  } catch {
    return false;
  }
}
