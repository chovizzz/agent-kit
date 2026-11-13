/**
 * `rsi show <id>`(contracts R21-12.8、R21-1.9、N4-2、§21.24 W0-22 第 5、10 条;只读命令,零写入、不拿锁)。
 *
 * 顺序:参数(`unknown_arg`)→ TTY(无 TTY 退 2 `not_tty`)→ id 形状(`unknown_id`,退 2)→ 内容验证双读协议({@link confirmContent};经 `RecordedReadPort` 读固定 OID)→
 * 渲染 → 泄漏闸。**输出边界例外**:只有 TTY 才出正文;正文逐行清洗(控制字符 / 格式字符 / 行分隔符 → `?`)并带 `| ` 行前缀(正文不能伪造本命令的行);全程过泄漏闸
 * (命中退 3 `output_leak`,stdout 一个字节都不写);每处自动产出的正文 / 裁决段之前带 {@link RSI_AUTO_LABEL}(只引用常量,不复制字面)。
 * 一致性口径:有界一致性验证,输出带 `consistency=double-read`,**不**写「原子」「一致快照」;不稳定 → 退 4 `RSI_SNAPSHOT_BUSY`;读取失败 → 退 3。
 * `journal=`:`absent`(只表示该次读取下不存在,不推出「丢失」)/ `ok` / `invalid`(只写「按运行手册处置」,不含路径,不写「删除即可恢复」)。
 * N4-2「关联提案裁决」段:`source_proposal` 非 null 时读裁决记录,**失败只影响该段**(`unavailable`),不影响其余输出。
 */
import { ExitCode } from '../../../contracts/exit-codes.js';
import { RSI_AUTO_LABEL, RSI_SNAPSHOT_BUSY } from '../../../contracts/rsi.js';
import type { PersonalLifecycleRecord } from '../../../contracts/rsi-personal.js';
import { emitLines, type OutputSink } from '../../output.js';
import { cleanName, cleanPath, type OutLine } from '../../sanitize.js';
import { checkJournal, type JournalStatus } from './journal-check.js';
import type { AutoReadPorts, JudgeVerdictRead } from './ports.js';
import { readRecordedRecords } from './recorded-records.js';
import { CONSISTENCY_LABEL, confirmContent } from './snapshot.js';
import { journalNameOf } from './stall.js';
import { interpretView } from './view-read.js';

const ID_RE = /^ra_[0-9a-f]{12}$/;
/** 正文逐份上限(字节):超出截断并标注 */
export const SHOW_BODY_MAX_BYTES = 64 * 1024;

export interface ShowIo {
  isTty: boolean;
  sink: OutputSink;
  forbidden: readonly string[];
}

interface ShowData {
  head: string;
  record: PersonalLifecycleRecord;
  bodies: (string | null)[];
}
type ShowWork =
  | { kind: 'found'; data: ShowData }
  | { kind: 'no_candidate' }
  | { kind: 'record_invalid' }
  | { kind: 'repo_invalid' };

const usage = (sink: OutputSink, reason: string): number => {
  sink.stderr(`RSI_USAGE reason=${reason}\n`);
  return ExitCode.USAGE;
};

function bodyLines(text: string): OutLine[] {
  const cut = Buffer.byteLength(text, 'utf8') > SHOW_BODY_MAX_BYTES;
  const t = cut
    ? Buffer.from(text, 'utf8').subarray(0, SHOW_BODY_MAX_BYTES).toString('utf8')
    : text;
  const out = t.split(/\r\n|\r|\n/).map((l) => ({ head: `| ${cleanPath(l)}` }));
  if (cut) out.push({ head: '| (正文超过上限,已截断)' });
  return out;
}

function judgeLines(j: JudgeVerdictRead): OutLine[] {
  if (j.kind === 'absent') return [{ head: '关联提案裁决: none' }];
  if (j.kind === 'unavailable') return [{ head: '关联提案裁决: unavailable' }];
  const f = (s: string): string => cleanName(s);
  return [
    {
      head: `关联提案裁决: judge_provenance=${f(j.judge_provenance)} verdict=${f(j.verdict)} overfit=${f(j.overfit)} injection=${f(j.injection)}`,
    },
    ...(j.declared === null ? [] : [{ head: `declared=${f(j.declared)}` }]),
  ];
}

export async function runShow(
  p: AutoReadPorts,
  argv: readonly string[],
  io: ShowIo,
): Promise<number> {
  const id = argv[0];
  if (argv.length !== 1 || id === undefined || id.startsWith('-')) {
    return usage(io.sink, 'unknown_arg');
  }
  if (!io.isTty) return usage(io.sink, 'not_tty');
  if (!ID_RE.test(id)) return usage(io.sink, 'unknown_id');

  const outcome = await confirmContent<ShowWork>(p.home, async (snap) => {
    const rr = await readRecordedRecords(p.recorded, snap.headText);
    if (rr.kind === 'retry') return { kind: 'retry' };
    if (rr.kind === 'unreadable') return { kind: 'fail', why: rr.why };
    if (rr.kind === 'absent') return { kind: 'ok', value: { kind: 'no_candidate' } };
    if (rr.kind === 'invalid') {
      return { kind: 'ok', value: { kind: rr.why === 'head' ? 'repo_invalid' : 'record_invalid' } };
    }
    const record = rr.records.find((r) => r.id === id);
    if (record === undefined) return { kind: 'ok', value: { kind: 'no_candidate' } };
    const bodies: (string | null)[] = [];
    for (const path of record.target_paths) {
      const oid = rr.tree.get(path);
      if (oid === undefined) {
        bodies.push(null);
        continue;
      }
      const b = await p.recorded.readBlob(oid);
      if (b.kind === 'missing') return { kind: 'retry' };
      if (b.kind === 'unreadable') return { kind: 'fail', why: b.why };
      bodies.push(b.value);
    }
    return { kind: 'ok', value: { kind: 'found', data: { head: rr.head, record, bodies } } };
  });

  if (outcome.kind === 'busy') {
    io.sink.stderr(`${RSI_SNAPSHOT_BUSY}\n`);
    return ExitCode.NOT_RUN;
  }
  if (outcome.kind === 'failed') {
    io.sink.stderr('RSI_FAIL_CLOSED reason=personal_repo_invalid\n');
    return ExitCode.FAIL_CLOSED;
  }
  const w = outcome.value;
  if (w.kind === 'repo_invalid') {
    io.sink.stderr('RSI_FAIL_CLOSED reason=personal_repo_invalid\n');
    return ExitCode.FAIL_CLOSED;
  }
  if (w.kind === 'record_invalid') {
    io.sink.stderr('RSI_FAIL_CLOSED reason=candidate_invalid\n');
    return ExitCode.FAIL_CLOSED;
  }
  if (w.kind === 'no_candidate') return usage(io.sink, 'unknown_id');

  const { record, head, bodies } = w.data;
  const jtext = outcome.snapshot.journalTexts[journalNameOf(record.id, record.content_sha256)];
  const jstatus: JournalStatus = checkJournal(jtext, record.id, record.content_sha256);
  const view = interpretView(await p.view(), p.now());
  const marks =
    view.state === 'fresh' || view.state === 'stale'
      ? view.view.protection_marks.filter((m) => m.id === record.id)
      : [];

  const lines: OutLine[] = [
    {
      head: `id=${record.id} lifecycle=${record.lifecycle} terminal_reason=${record.terminal_reason ?? 'none'} content_sha12=${record.content_sha256.slice(0, 12)}`,
    },
    { head: `record=recorded head=${head.slice(0, 12)} ${CONSISTENCY_LABEL}` },
    {
      head: `deploy: claude=${record.deploy.claude} pi=${record.deploy.pi} codex=${record.deploy.codex}`,
    },
    { head: `journal=${jstatus}` },
  ];
  if (jstatus === 'invalid') lines.push({ head: '按运行手册处置' });
  for (const m of marks) lines.push({ head: `protection_mark=${m.mark} at=${m.at}` });
  bodies.forEach((body, i) => {
    lines.push({ head: RSI_AUTO_LABEL });
    lines.push({ head: `正文 ${i + 1}/${bodies.length}` });
    if (body === null) lines.push({ head: '| (记录提交里没有该文件)' });
    else lines.push(...bodyLines(body));
  });
  if (record.source_proposal !== null && record.source_proposal !== undefined) {
    lines.push({ head: RSI_AUTO_LABEL });
    let j: JudgeVerdictRead;
    try {
      j = await p.judge.verdictFor(
        record.source_proposal.run_id,
        record.source_proposal.proposal_id,
      );
    } catch {
      j = { kind: 'unavailable' };
    }
    lines.push(...judgeLines(j));
  }
  return emitLines(io.sink, lines, io.forbidden);
}
