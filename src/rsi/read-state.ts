/**
 * 只读命令(`rsi status` / `rsi projects`)读 `.state/rsi/` 的唯一入口(R20-5.6,R20-A2 B3a):不拿锁、不建目录、不恢复快照、不写。
 *
 * 一次 `readVerified`(快照协议)取四个固定文件的**核对过的**字节,只解析这份字节,不再自行重读。
 * 结果映射(R20-3.4.1 / R20-3.5.6):
 *  - 清单与文件两次都不一致 → 抛 `RsiSnapshotBusyError`(退出 4 `RSI_SNAPSHOT_BUSY`);
 *  - `rsi/` 或固定文件元数据不合规 → `state_dir_unsafe`;清单自身损坏 → `snapshot_invalid`(退出 3);
 *  - `state.json` 整份过不了 schema → `state_invalid`;`counts.json` → `counts_invalid`;`cursor.json` → `cursor_invalid`(退出 3);
 *  - `projects.json` 的内容问题**不阻断**(D4):`index.status = invalid`,调用方把全部信号计 U;缺失 = `absent`;
 *  - 清单缺失(从未提交过)= 四个文件都当不存在,`snapshot = absent`。
 * STOP / purge journal 只探测「在不在」(`lstat`,不读内容以外的东西):任何类型的对象都算在场(宁可当成已停止 / 有未完成的 purge)。
 */
import * as path from 'node:path';
import {
  RsiCountsSchema,
  RsiCursorSchema,
  RsiProjectIndexSchema,
  RsiStopMarkSchema,
  type RsiCounts,
  type RsiCursor,
  type RsiProjectIndex,
} from '../contracts/rsi.js';
import type { IoContext } from '../io/paths.js';
import { lstat, readFileSafe } from '../io/read-fs.js';
import { RsiSnapshotBusyError } from './exit.js';
import { RSI_FILE_OWNER, rsiDirReadonly } from './lock-read.js';
import { RsiSnapshotError, readVerified, type SnapshotReadHooks } from './snapshot-read.js';
import { parseRsiStateDoc, type RsiStateDoc } from './state.js';
import type { IndexStatus } from './attribution.js';

export const RSI_READ_NAMES = [
  'state.json',
  'projects.json',
  'cursor.json',
  'counts.json',
] as const;

export interface RsiReadData {
  snapshot: 'ok' | 'absent';
  stateDoc: RsiStateDoc;
  index: { status: IndexStatus; value: RsiProjectIndex | null };
  counts: RsiCounts | null;
  cursor: { status: 'ok' | 'absent'; value: RsiCursor | null };
  stop: { present: boolean; at: string | null };
  journalPresent: boolean;
  /** `.state/rsi/` 的真实路径(不存在 = null);给 TAINTED 读取推出 `.state` 用 */
  rsiDir: string | null;
}

async function present(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return true; // 无法确认 = 当作在场(保守)
  }
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
}

export async function readRsiState(
  io: IoContext,
  hooks: SnapshotReadHooks = {},
): Promise<RsiReadData> {
  const v = await readVerified(io, RSI_READ_NAMES, hooks);
  if (v.status === 'busy') throw new RsiSnapshotBusyError();
  if (v.status === 'unsafe') throw new RsiSnapshotError('state_dir_unsafe');
  if (v.status === 'invalid') throw new RsiSnapshotError('snapshot_invalid');
  const files = v.status === 'ok' ? v.files : new Map<string, Buffer | null>();
  const get = (n: string): Buffer | null => files.get(n) ?? null;

  const stateDoc = parseRsiStateDoc(get('state.json'));
  if (stateDoc.kind === 'invalid') throw new RsiSnapshotError('state_invalid');

  const idxBytes = get('projects.json');
  let index: RsiReadData['index'] = { status: 'absent', value: null };
  if (idxBytes !== null) {
    const p = RsiProjectIndexSchema.safeParse(parseJson(idxBytes));
    index = p.success ? { status: 'ok', value: p.data } : { status: 'invalid', value: null };
  }

  const cntBytes = get('counts.json');
  let counts: RsiCounts | null = null;
  if (cntBytes !== null) {
    const p = RsiCountsSchema.safeParse(parseJson(cntBytes));
    if (!p.success) throw new RsiSnapshotError('counts_invalid');
    counts = p.data;
  }

  const curBytes = get('cursor.json');
  let cursor: RsiReadData['cursor'] = { status: 'absent', value: null };
  if (curBytes !== null) {
    const p = RsiCursorSchema.safeParse(parseJson(curBytes));
    if (!p.success) throw new RsiSnapshotError('cursor_invalid');
    cursor = { status: 'ok', value: p.data };
  }

  // STOP / journal:rsi/ 不存在 = 都不在场;存在则只 lstat
  const d = await rsiDirReadonly(io);
  let stop: RsiReadData['stop'] = { present: false, at: null };
  let journalPresent = false;
  let rsiDir: string | null = null;
  if (d.kind === 'unsafe') throw new RsiSnapshotError('state_dir_unsafe');
  if (d.kind === 'ok') {
    rsiDir = d.dir;
    const stopFile = path.join(d.dir, 'STOP');
    if (await present(stopFile)) {
      let at: string | null = null;
      const r = await readFileSafe(stopFile, { maxBytes: 4096, owner: RSI_FILE_OWNER });
      if (r.kind === 'ok') {
        const m = RsiStopMarkSchema.safeParse(parseJson(r.bytes));
        if (m.success) at = m.data.at;
      }
      stop = { present: true, at };
    }
    journalPresent = await present(path.join(d.dir, 'purge-journal.json'));
  }
  return {
    snapshot: v.status === 'ok' ? 'ok' : 'absent',
    stateDoc,
    index,
    counts,
    cursor,
    stop,
    journalPresent,
    rsiDir,
  };
}
