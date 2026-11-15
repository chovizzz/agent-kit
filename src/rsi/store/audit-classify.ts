/**
 * 审计文件的分类与同键规则(**纯函数,无 I/O**;追加器与压缩 P0 共用同一个 `classifyAuditFile`,§21.24 W0-26 第 6、7 条)。
 *
 * 分类:`ok`(每个以换行结尾的行都过 `RsiAuditLineSchema`、`idem_key` 文件内唯一)/ `torn_tail`(前面都合法,末尾有无结尾换行的片段:**可恢复**,
 * 追加前由调用方用 `goodText` 修尾)/ `bad`(中间坏行、完整但 schema 非法的行、重复键:fail-closed,零修改)。
 * 同键内容规则:默认逐字段相等(含 `at`);**唯一例外**是终态空操作观察行(`kind=transition ∧ dim=lifecycle ∧ from=to ∧ to∈终态`),其比较排除 `at`。
 */
import { canonicalJsonLine } from '../../io/canonical-json.js';
import { RsiAuditLineSchema, type RsiAuditLine } from '../../contracts/rsi-personal.js';

export type AuditClass =
  | { kind: 'ok'; rows: RsiAuditLine[]; byKey: Map<string, RsiAuditLine> }
  | { kind: 'torn_tail'; rows: RsiAuditLine[]; byKey: Map<string, RsiAuditLine>; goodText: string }
  | { kind: 'bad'; cause: 'audit_bad_line' | 'audit_dup_key'; line: number; detail: string };

export type GoodAuditClass = Exclude<AuditClass, { kind: 'bad' }>;

export function classifyAuditFile(text: string): AuditClass {
  const parts = text.split('\n');
  const tail = parts[parts.length - 1] as string; // `split` 至少返回一个元素;结尾有换行时为 ''
  const complete = parts.slice(0, -1);
  const rows: RsiAuditLine[] = [];
  const byKey = new Map<string, RsiAuditLine>();
  for (let i = 0; i < complete.length; i++) {
    let raw: unknown;
    try {
      raw = JSON.parse(complete[i] as string);
    } catch {
      return { kind: 'bad', cause: 'audit_bad_line', line: i + 1, detail: 'json' };
    }
    const p = RsiAuditLineSchema.safeParse(raw);
    if (!p.success) return { kind: 'bad', cause: 'audit_bad_line', line: i + 1, detail: 'schema' };
    const key = p.data.idem_key;
    if (key !== undefined) {
      if (byKey.has(key)) return { kind: 'bad', cause: 'audit_dup_key', line: i + 1, detail: key };
      byKey.set(key, p.data);
    }
    rows.push(p.data);
  }
  if (tail === '') return { kind: 'ok', rows, byKey };
  return { kind: 'torn_tail', rows, byKey, goodText: text.slice(0, text.length - tail.length) };
}

/** 终态集合(R21-4.6;与转移引擎的终态一致) */
const TERMINAL_STATES: readonly string[] = ['rejected', 'expired', 'rolled_back', 'retired'];

/** 终态空操作观察行(R5)的判别式 */
export const isNoopObservation = (r: RsiAuditLine): boolean =>
  r.kind === 'transition' &&
  r.dim === 'lifecycle' &&
  r.from !== undefined &&
  r.from === r.to &&
  TERMINAL_STATES.includes(r.to as string);

const withoutAt = (r: RsiAuditLine): Omit<RsiAuditLine, 'at'> => {
  const copy: Partial<RsiAuditLine> = { ...r };
  delete copy.at;
  return copy as Omit<RsiAuditLine, 'at'>;
};

/** 同键两行是否「同一内容」:默认含 `at`;两行都是终态空操作行时排除 `at` */
export function sameRowForKey(a: RsiAuditLine, b: RsiAuditLine): boolean {
  if (isNoopObservation(a) && isNoopObservation(b)) {
    return canonicalJsonLine(withoutAt(a)) === canonicalJsonLine(withoutAt(b));
  }
  return canonicalJsonLine(a) === canonicalJsonLine(b);
}

/** 水位线之下的 replay 比较:`idem_key / id / at / kind / dim / from / to / reason` 全部相等(权威事件取回后与待写行逐字段比) */
export function sameSealedFields(
  source: { idem_key: string; row: RsiAuditLine },
  line: RsiAuditLine,
): boolean {
  const s = source.row;
  return (
    source.idem_key === line.idem_key &&
    s.id === line.id &&
    s.at === line.at &&
    s.kind === line.kind &&
    s.dim === line.dim &&
    s.from === line.from &&
    s.to === line.to &&
    s.reason === line.reason
  );
}
