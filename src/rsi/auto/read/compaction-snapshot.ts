/**
 * 读者的 `gen` 双读(设计稿 v3 §D.4;§21.24 W0-26 第 7、8 条):**读压缩文件 → 读审计 → 再读压缩文件**,两次 `gen` 相同才算一致快照。
 *  - 第二次读失败 / 非法 / 不受支持 → 失败(**不回退第一次的结果**),cause = `compaction_unreadable` / `compaction_unsupported`;
 *  - 第一次读到存在(`gen ≥ 1`)而第二次缺失 → `compaction_vanished`;
 *  - `gen` 变了 → 重试,至多 3 轮,耗尽 → `busy`(调用方映射为退出 4 `RSI_SNAPSHOT_BUSY`),**不返回部分结果**;
 *  - 文件缺失 = 虚拟 `gen: 0`(合法,与存在时的 `gen` 比较,不是错误)。
 * **明确排除在承诺之外**:不检测外部把文件回滚到更小的 `gen`、整份删除后重建、或「曾存在后丢失」(没有跨运行的持久锚点;只比较同一次双读之内)。
 * 本文件只读、无 I/O 实现(经端口)、不 import 存储核(读命令的闭包不得含 `src/rsi/store/**`);schema 与 I1 判定用 `contracts/rsi-compaction.ts` 的同一份纯解码。
 */
import { parseCompactionText } from '../../../contracts/rsi-compaction.js';
import type { AutoReadPorts, RawRead } from './ports.js';

export const COMPACTION_READ_ATTEMPTS = 3;

export type CompactionFailCause =
  'compaction_unreadable' | 'compaction_unsupported' | 'compaction_vanished';

export type CompactedAudit =
  | { kind: 'ok'; audit: RawRead; through: string | null; gen: number }
  | { kind: 'fail'; cause: CompactionFailCause }
  | { kind: 'busy' };

type One =
  | { kind: 'ok'; gen: number; through: string | null }
  | { kind: 'fail'; cause: CompactionFailCause };

function readOne(raw: RawRead, today: string): One {
  if (raw.kind === 'absent') return { kind: 'ok', gen: 0, through: null };
  if (raw.kind === 'unreadable') return { kind: 'fail', cause: 'compaction_unreadable' };
  const r = parseCompactionText(raw.text, today);
  if (!r.ok) return { kind: 'fail', cause: 'compaction_unsupported' };
  return { kind: 'ok', gen: r.value.gen, through: r.value.through };
}

export async function readCompactedAudit(
  p: Pick<AutoReadPorts, 'compaction' | 'audit' | 'now'>,
): Promise<CompactedAudit> {
  for (let attempt = 0; attempt < COMPACTION_READ_ATTEMPTS; attempt += 1) {
    const today = p.now().toISOString().slice(0, 10);
    const first = readOne(await p.compaction(), today);
    if (first.kind === 'fail') return first;
    const audit = await p.audit();
    const second = readOne(await p.compaction(), today);
    if (second.kind === 'fail') return second;
    if (first.gen >= 1 && second.gen === 0) return { kind: 'fail', cause: 'compaction_vanished' };
    if (first.gen === second.gen) {
      return { kind: 'ok', audit, through: second.through, gen: second.gen };
    }
  }
  return { kind: 'busy' };
}
