/**
 * 归属判定的只读原语(契约 R20-4.3 / R20-4.4 / R20-4.6;R20-A2 B3c):信号库 `sig_id → project_key` 映射、固定文件读取,
 * 以及对统一分类器(`../attribution.ts`,B3a 同一实现)的调用。每次调用现读配置给出的排除项、索引与信号库,**不缓存**。只给 `taint.ts` / `immediate-gate.ts` 用。
 *
 * 分类口径(X > U > P)只在 `../attribution.ts` 的决策表里定义一次,这里不重复。
 */
import * as path from 'node:path';
import {
  RSI_AGENT_IDS,
  RsiCountsSchema,
  RsiProjectIndexSchema,
  type RsiProjectIndex,
} from '../../contracts/rsi.js';
import type { IoContext } from '../../io/paths.js';
import { MAX_LINE_BYTES, lstat, openStreamSafe, readDir, readFileSafe } from '../../io/read-fs.js';
import { createAttributor, type Attribution } from '../attribution.js';
import type { RsiConfigOn } from '../config.js';
import { JsonlStream } from '../jsonl-stream.js';
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

/** 测试缝:每个月文件打开之前调用(演练「枚举之后、打开之前被换成链接」) */
export interface LoadSigKeysHooks {
  beforeOpen?: (file: string) => Promise<void> | void;
}

/**
 * 只读流式扫 `.state/signals/<agent>/*.jsonl`,返回 `needed` 里每个 sig_id 的 `project_key`(查不到的不在结果里)。
 * 每个月文件经 B2 的 `openStreamSafe`(`O_NOFOLLOW | O_NONBLOCK`、句柄 fstat:普通文件、`nlink == 1`)打开,同一个已校验句柄读完,
 * 喂 B2 的流式 JSONL 引擎(按字节 `\n` 切行、严格 UTF-8 / JSON、超长行 / 缺尾换行即败)。
 * 硬链接 / 末级链接 / 非普通文件 / 读错误 / 超长行 / 非 JSON / 缺 sig_id 或 project_key 的行 / 同一 sig_id 映射到不同 key → fail-closed `signal_store_corrupt`(不任选一条)。
 */
export async function loadSigKeys(
  io: IoContext,
  needed: ReadonlySet<string>,
  hooks: LoadSigKeysHooks = {},
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
      const file = path.join(dir, f.name);
      const s = await openStreamSafe(file, {
        ...(hooks.beforeOpen !== undefined ? { beforeOpen: () => hooks.beforeOpen?.(file) } : {}),
      });
      if (s.kind === 'missing') continue;
      if (s.kind === 'unsafe') throw corrupt();
      const lines = new JsonlStream(MAX_LINE_BYTES, (o) => {
        const rec = o as { sig_id?: unknown; project_key?: unknown } | null;
        if (typeof rec?.sig_id !== 'string') return false;
        if (!needed.has(rec.sig_id)) return true;
        if (typeof rec.project_key !== 'string' || rec.project_key === '') return false;
        const prev = found.get(rec.sig_id);
        if (prev !== undefined && prev !== rec.project_key) return false;
        found.set(rec.sig_id, rec.project_key);
        return true;
      });
      try {
        for await (const chunk of s.chunks()) lines.push(chunk);
        lines.end();
      } catch {
        throw corrupt();
      } finally {
        await s.close();
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// X / U / P:统一分类器(src/rsi/attribution.ts)的薄封装
// ---------------------------------------------------------------------------
export type KeyClass = Attribution;

/** 现读索引与 counts 的盐指纹,按**当前**配置建统一分类器(惰性、按 key 记忆);本文件不再有第二份分类逻辑 */
export async function classifierFor(
  io: IoContext,
  cfg: Pick<RsiConfigOn, 'excludeDirs' | 'excludeNames'>,
): Promise<(key: string) => Promise<KeyClass>> {
  const index = await readIndex(io);
  const saltFp = await readCountsSaltFp(io);
  const a = await createAttributor({
    config: cfg as RsiConfigOn,
    indexStatus: index.kind === 'ok' ? 'ok' : 'invalid',
    index: index.kind === 'ok' ? index.index : null,
    counts: saltFp === null ? null : { salt_fp: saltFp },
  });
  return (key) => a.classify(key);
}
