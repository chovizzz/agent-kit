/**
 * 经 {@link RecordedReadPort} 读 `head.json` 记录的提交里的候选记录(`lifecycle/<id>.json`;只读,不持锁、不碰引用 / 索引 / 工作树)。
 * 结果分:`absent`(head.json 不存在 = 私有仓库从未建过,没有候选)、`invalid`(head.json 不合规 / 记录不合规 / 文件名与记录 id 不符;`candidate_invalid` 或 `personal_repo_invalid`)、
 * `unreadable`(适配器拒绝或读失败)、`retry`(记录提交对象已消失:交给双读协议回到开头重试)、`ok`。
 * **读失败绝不当成「没有候选」**(fail-closed)。
 */
import {
  PersonalHeadSchema,
  PersonalLifecycleRecordSchema,
} from '../../../contracts/rsi-personal.js';
import type { PersonalLifecycleRecord } from '../../../contracts/rsi-personal.js';
import type { RecordedReadPort, RecordedWhy } from '../../personal/read/recorded-port.js';

export type RecordedRecords =
  | {
      kind: 'ok';
      head: string;
      records: PersonalLifecycleRecord[];
      /** 记录提交的树里 blob 条目:仓库相对路径 → 40 位 oid(供 `rsi show` 读正文) */
      tree: ReadonlyMap<string, string>;
    }
  | { kind: 'absent' }
  | { kind: 'invalid'; why: 'head' | 'record' }
  | { kind: 'unreadable'; why: RecordedWhy }
  | { kind: 'retry' };

const RECORD_PATH_RE = /^lifecycle\/(ra_[0-9a-f]{12})\.json$/;

export async function readRecordedRecords(
  port: RecordedReadPort,
  headText: string | null,
): Promise<RecordedRecords> {
  if (headText === null) return { kind: 'absent' };
  let head: string;
  try {
    const r = PersonalHeadSchema.safeParse(JSON.parse(headText));
    if (!r.success) return { kind: 'invalid', why: 'head' };
    head = r.data.head;
  } catch {
    return { kind: 'invalid', why: 'head' };
  }
  const c = await port.readCommit(head);
  if (c.kind === 'missing') return { kind: 'retry' };
  if (c.kind === 'unreadable') return c;
  const tree = await port.listTree(head);
  if (tree.kind === 'missing') return { kind: 'retry' };
  if (tree.kind === 'unreadable') return tree;
  const records: PersonalLifecycleRecord[] = [];
  const paths = new Map<string, string>();
  for (const e of tree.value) {
    if (e.mode !== '120000') paths.set(e.path, e.oid);
    const m = RECORD_PATH_RE.exec(e.path);
    if (m === null || e.mode === '120000') continue;
    const b = await port.readBlob(e.oid);
    if (b.kind === 'missing') return { kind: 'retry' };
    if (b.kind === 'unreadable') return b;
    let rec: PersonalLifecycleRecord;
    try {
      const p = PersonalLifecycleRecordSchema.safeParse(JSON.parse(b.value));
      if (!p.success || p.data.id !== m[1]) return { kind: 'invalid', why: 'record' };
      rec = p.data;
    } catch {
      return { kind: 'invalid', why: 'record' };
    }
    records.push(rec);
  }
  records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { kind: 'ok', head, records, tree: paths };
}
