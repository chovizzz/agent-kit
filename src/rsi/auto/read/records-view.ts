/**
 * 干跑命令(`rsi auto clear` / `rsi rollback --to`)共用:在内容验证双读协议({@link confirmContent})之下,经 `RecordedReadPort` 读 `head.json` 记录的提交里的全部候选记录。
 * 失败映射(与 `rsi show` 一致):不稳定 → 退 4 `RSI_SNAPSHOT_BUSY`;读取失败 / head 不合规 → 退 3 `personal_repo_invalid`;记录不合规 → 退 3 `candidate_invalid`。
 * head.json 不存在 = 私有仓库从未建过 = 没有候选(`head: null`)。读失败**绝不**当成「没有候选」。
 */
import { ExitCode } from '../../../contracts/exit-codes.js';
import { RSI_SNAPSHOT_BUSY } from '../../../contracts/rsi.js';
import type { PersonalLifecycleRecord } from '../../../contracts/rsi-personal.js';
import type { AutoReadPorts } from './ports.js';
import { readRecordedRecords } from './recorded-records.js';
import { confirmContent, type ContentSnapshot } from './snapshot.js';

export type VerifiedRecords =
  | {
      kind: 'ok';
      head: string | null;
      records: PersonalLifecycleRecord[];
      snapshot: ContentSnapshot;
    }
  | { kind: 'exit'; code: number; stderr: string };

type Work =
  | { ok: true; head: string | null; records: PersonalLifecycleRecord[] }
  | { ok: false; reason: string };

export async function readVerifiedRecords(p: AutoReadPorts): Promise<VerifiedRecords> {
  const o = await confirmContent<Work>(p.home, async (snap) => {
    const rr = await readRecordedRecords(p.recorded, snap.headText);
    if (rr.kind === 'retry') return { kind: 'retry' };
    if (rr.kind === 'unreadable') return { kind: 'fail', why: rr.why };
    if (rr.kind === 'absent') return { kind: 'ok', value: { ok: true, head: null, records: [] } };
    if (rr.kind === 'invalid') {
      return {
        kind: 'ok',
        value: {
          ok: false,
          reason: rr.why === 'head' ? 'personal_repo_invalid' : 'candidate_invalid',
        },
      };
    }
    return { kind: 'ok', value: { ok: true, head: rr.head, records: rr.records } };
  });
  if (o.kind === 'busy') {
    return { kind: 'exit', code: ExitCode.NOT_RUN, stderr: `${RSI_SNAPSHOT_BUSY}\n` };
  }
  if (o.kind === 'failed') {
    return {
      kind: 'exit',
      code: ExitCode.FAIL_CLOSED,
      stderr: 'RSI_FAIL_CLOSED reason=personal_repo_invalid\n',
    };
  }
  if (!o.value.ok) {
    return {
      kind: 'exit',
      code: ExitCode.FAIL_CLOSED,
      stderr: `RSI_FAIL_CLOSED reason=${o.value.reason}\n`,
    };
  }
  return { kind: 'ok', head: o.value.head, records: o.value.records, snapshot: o.snapshot };
}
