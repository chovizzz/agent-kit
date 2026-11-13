/**
 * 两套一致性协议(contracts §21.24 W0-22 第 5、7 条)。**都是有界一致性验证,不是原子快照**:读者与写者没有共同的 generation,双读相等不排除两次读之间
 * 「改了又改回」(ABA);保证仅为「两次读之间没有观察到差异」,输出带 `consistency=double-read`,文案不得写「原子」或「一致快照」。
 *
 *   - {@link confirmExistence}(`rsi auto status`,弱协议):只判 journal **存在性**,不解析内容、不跑 git:读 {事务目录名列表、撤销凭据哈希} 两遍,不等 → `moving`
 *     (调用方标 `unconfirmed:snapshot_moving`,不重试、不退 4)。不承诺内容一致。
 *   - {@link confirmContent}(`rsi show` / 干跑,内容验证协议):验证集 V = {head.json 字节哈希、事务目录名列表、撤销凭据哈希、**本次实际读取的每份 journal 的内容摘要**};
 *     读 V → 经 `work`(适配器按固定完整 OID 读)→ 再读一遍 V(重读同一批 journal 并重取目录列表)→ 全部相等才有效;有界重试 3 次,用尽 → `busy`(退 4 `RSI_SNAPSHOT_BUSY`);读取失败 → `failed`(退 3)。
 * 两个函数故意分开,互不调用:status 误用内容协议 / show 误用弱协议都是缺陷(变异表有对应行)。
 */
import { createHash } from 'node:crypto';
import type { HomeReadPort, RawRead } from './ports.js';
import type { JournalExistence } from './stall.js';

export const SNAPSHOT_MAX_TRIES = 3;
/** 输出里标注一致性口径的固定文案(不含「原子」「一致快照」) */
export const CONSISTENCY_LABEL = 'consistency=double-read';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
/** 原始读取的比较摘要:有内容 → sha256,否则取状态名 */
const rawDigest = (r: RawRead): string => (r.kind === 'ok' ? sha(r.text) : r.kind);

// ---------------------------------------------------------------------------
// 弱协议(status)
// ---------------------------------------------------------------------------
export async function confirmExistence(home: HomeReadPort): Promise<JournalExistence> {
  const once = async (): Promise<{ names: readonly string[]; rev: string } | null> => {
    const n = await home.txnNames();
    const r = await home.revocations();
    if (n.kind !== 'ok' || r.kind === 'unreadable') return null;
    return { names: n.names, rev: rawDigest(r) };
  };
  const a = await once();
  const b = await once();
  if (a === null || b === null) return { kind: 'unreadable' };
  if (
    a.rev !== b.rev ||
    a.names.length !== b.names.length ||
    a.names.some((x, i) => x !== b.names[i])
  ) {
    return { kind: 'moving' };
  }
  return { kind: 'names', names: new Set(a.names) };
}

// ---------------------------------------------------------------------------
// 内容验证协议(show / 干跑)
// ---------------------------------------------------------------------------
export interface ContentSnapshot {
  /** `head.json` 原文(`null` = 不存在);只用于交给 `work`,比较用 `headDigest` */
  headText: string | null;
  headDigest: string;
  names: readonly string[];
  revDigest: string;
  /** 本次实际读取的每份 journal 的内容摘要(键 = txn_id) */
  journals: Readonly<Record<string, string>>;
  /** 每份 journal 的原文(只给 `work` / 渲染用;不参与比较) */
  journalTexts: Readonly<Record<string, string>>;
}

export type ContentWork<T> =
  | { kind: 'ok'; value: T }
  /** 读到的对象已消失(如被 gc):回到开头重试 */
  | { kind: 'retry' }
  | { kind: 'fail'; why: string };

export type ContentOutcome<T> =
  | { kind: 'ok'; value: T; snapshot: ContentSnapshot }
  | { kind: 'busy' }
  | { kind: 'failed'; why: string };

async function takeSnapshot(
  home: HomeReadPort,
  fixed: readonly string[] | null,
): Promise<ContentSnapshot | null> {
  const head = await home.head();
  const rev = await home.revocations();
  const list = await home.txnNames();
  if (head.kind === 'unreadable' || rev.kind === 'unreadable' || list.kind !== 'ok') return null;
  const names = fixed ?? list.names;
  const journals: Record<string, string> = {};
  const journalTexts: Record<string, string> = {};
  for (const n of names) {
    const j = await home.journal(n);
    if (j.kind === 'unreadable') return null;
    journals[n] = rawDigest(j);
    if (j.kind === 'ok') journalTexts[n] = j.text;
  }
  return {
    headText: head.kind === 'ok' ? head.text : null,
    headDigest: rawDigest(head),
    names: list.names,
    revDigest: rawDigest(rev),
    journals,
    journalTexts,
  };
}

function sameSnapshot(a: ContentSnapshot, b: ContentSnapshot): boolean {
  if (a.headDigest !== b.headDigest || a.revDigest !== b.revDigest) return false;
  if (a.names.length !== b.names.length || a.names.some((x, i) => x !== b.names[i])) return false;
  const ka = Object.keys(a.journals).sort();
  const kb = Object.keys(b.journals).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => a.journals[k] === b.journals[k]);
}

export async function confirmContent<T>(
  home: HomeReadPort,
  work: (s: ContentSnapshot) => Promise<ContentWork<T>>,
  maxTries: number = SNAPSHOT_MAX_TRIES,
): Promise<ContentOutcome<T>> {
  for (let i = 0; i < maxTries; i += 1) {
    const s1 = await takeSnapshot(home, null);
    if (s1 === null) return { kind: 'failed', why: 'home_unreadable' };
    const w = await work(s1);
    if (w.kind === 'fail') return { kind: 'failed', why: w.why };
    if (w.kind === 'retry') continue;
    // 第二遍:重读同一批 journal(固定为第一遍读到的名字),目录列表照常重取
    const s2 = await takeSnapshot(home, Object.keys(s1.journals));
    if (s2 === null) return { kind: 'failed', why: 'home_unreadable' };
    if (sameSnapshot(s1, s2)) return { kind: 'ok', value: w.value, snapshot: s1 };
  }
  return { kind: 'busy' };
}
