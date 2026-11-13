/**
 * `rsi rollback --to <日期>`(无 `--write`)干跑(contracts R21-12.7、§21.24 W0-22 第 4、5、6 条;零写入):候选选取见 `select-rollback.ts`
 * (严格大于;**日期不可知**候选按保守方向纳入并**单列**一节,文本小节 + `--json` 的 `date_unknown[]`,计数分开;记录自相矛盾 → 退 3 `candidate_invalid`)。
 * 顺序:参数(`unknown_arg` / `bad_date`,退 2,先于一切读取)→ `[rsi]` 关闭退 4 `RSI_NOT_RUN reason=off` 并提示改用 `rsi auto clear`(后者不依赖 `[rsi]`)→
 * 内容验证双读协议读 `head.json` 记录的提交(不稳定退 4 `RSI_SNAPSHOT_BUSY`、读失败退 3)。当前 `cmd_rollback_to` 属 V1b,相位未到时在入口就是桩。
 */
import { ExitCode } from '../../../contracts/exit-codes.js';
import { canonicalJson } from '../../../io/canonical-json.js';
import { emitLines, jsonLines, type OutputSink } from '../../output.js';
import { parseUtcDate, selectRollbackTo, type RollbackCandidate } from '../select-rollback.js';
import type { AutoReadPorts } from './ports.js';
import { readVerifiedRecords } from './records-view.js';
import { CONSISTENCY_LABEL } from './snapshot.js';

export type RollbackToArgs =
  { ok: true; date: string; json: boolean } | { ok: false; reason: 'unknown_arg' | 'bad_date' };

/** `--to <日期> [--json]`(`--write` 已在入口分流,不会到这里) */
export function parseRollbackToArgs(argv: readonly string[]): RollbackToArgs {
  let json = false;
  let to: string | null = null;
  let toSeen = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === '--json' && !json) json = true;
    else if (a === '--to' && !toSeen) {
      toSeen = true;
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) return { ok: false, reason: 'bad_date' };
      to = v;
      i += 1;
    } else return { ok: false, reason: 'unknown_arg' };
  }
  if (!toSeen) return { ok: false, reason: 'bad_date' };
  const d = parseUtcDate(to as string);
  return d === null ? { ok: false, reason: 'bad_date' } : { ok: true, date: d, json };
}

const item = (c: RollbackCandidate): string =>
  `  id=${c.id} lifecycle=${c.lifecycle} entered_on=${c.entered_on ?? 'unknown'}`;

export async function runRollbackDry(
  p: AutoReadPorts,
  argv: readonly string[],
  o: { forbidden: readonly string[] },
  sink: OutputSink,
): Promise<number> {
  const a = parseRollbackToArgs(argv);
  if (!a.ok) {
    sink.stderr(`RSI_USAGE reason=${a.reason}\n`);
    return ExitCode.USAGE;
  }
  if (!(await p.config()).rsiOn) {
    sink.stderr('RSI_NOT_RUN reason=off\n');
    sink.stdout('提示:[rsi] 关闭时请改用 rsi auto clear(它不依赖 [rsi])\n');
    return ExitCode.NOT_RUN;
  }
  const v = await readVerifiedRecords(p);
  if (v.kind === 'exit') {
    sink.stderr(v.stderr);
    return v.code;
  }
  const sel = selectRollbackTo(v.records, a.date);
  if (sel.invalid.length > 0) {
    sink.stderr('RSI_FAIL_CLOSED reason=candidate_invalid\n');
    return ExitCode.FAIL_CLOSED;
  }
  if (a.json) {
    const doc = {
      write: false,
      date: a.date,
      candidates: sel.candidates.map((c) => ({
        id: c.id,
        lifecycle: c.lifecycle,
        entered_on: c.entered_on,
      })),
      date_unknown: sel.dateUnknown.map((c) => ({ id: c.id, lifecycle: c.lifecycle })),
      record: v.head === null ? null : v.head.slice(0, 12),
      consistency: 'double-read',
    };
    return emitLines(sink, jsonLines(canonicalJson(doc)), o.forbidden);
  }
  const record = v.head === null ? 'record=absent' : `record=recorded head=${v.head.slice(0, 12)}`;
  const lines = [
    `dry-run: 将按生效逆序回滚 ${a.date} 之后(严格大于)进入 canary 的 ${sel.candidates.length} 个候选(未写入任何东西;加 --write 才执行)`,
    `${record} ${CONSISTENCY_LABEL}`,
    ...sel.candidates.map(item),
    `日期不可知,按保守方向纳入: ${sel.dateUnknown.length}`,
    ...sel.dateUnknown.map(item),
  ];
  return emitLines(
    sink,
    lines.map((head) => ({ head })),
    o.forbidden,
  );
}
