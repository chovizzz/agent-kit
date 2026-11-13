/**
 * `rsi auto clear`(无 `--write`)干跑(contracts R21-12.1 / R21-12.4、§21.24 W0-22 第 3、5、6 条;零写入):**自己枚举**——不调 `rsiAutoClear({ write: false })`
 * (它所在模块的闭包带回滚写出口)。候选来自 `head.json` 记录的提交({@link readVerifiedRecords},内容验证双读协议),在途 journal 来自事务目录;不依赖 `[rsi]`、
 * 不要求仓库可达之外的任何东西,不拿任何锁。输出只含 id / 枚举 / 计数,带 `record=recorded head=<oid 前 12> consistency=double-read`(**不**写「原子」「一致快照」)。
 * 退出码:0;不稳定 → 4 `RSI_SNAPSHOT_BUSY`;读失败 → 3 `personal_repo_invalid` / `candidate_invalid`。
 */
import { canonicalJson } from '../../../io/canonical-json.js';
import { emitLines, jsonLines, type OutputSink } from '../../output.js';
import { checkJournal } from './journal-check.js';
import type { AutoReadPorts } from './ports.js';
import { readVerifiedRecords } from './records-view.js';
import { CONSISTENCY_LABEL } from './snapshot.js';
import { journalNameOf } from './stall.js';

const TERMINAL = new Set(['rejected', 'expired', 'rolled_back', 'retired']);

export interface ClearDryItem {
  id: string;
  lifecycle: string;
  journal: 'absent' | 'ok' | 'invalid';
}

export async function runClearDry(
  p: AutoReadPorts,
  o: { json: boolean; forbidden: readonly string[] },
  sink: OutputSink,
): Promise<number> {
  const v = await readVerifiedRecords(p);
  if (v.kind === 'exit') {
    sink.stderr(v.stderr);
    return v.code;
  }
  const items: ClearDryItem[] = v.records
    .filter((r) => !TERMINAL.has(r.lifecycle))
    .map((r) => ({
      id: r.id,
      lifecycle: r.lifecycle,
      journal: checkJournal(
        v.snapshot.journalTexts[journalNameOf(r.id, r.content_sha256)],
        r.id,
        r.content_sha256,
      ),
    }));
  const record = v.head === null ? 'record=absent' : `record=recorded head=${v.head.slice(0, 12)}`;
  if (o.json) {
    const doc = {
      write: false,
      candidates: items,
      in_flight: v.snapshot.names.length,
      record: v.head === null ? null : v.head.slice(0, 12),
      consistency: 'double-read',
    };
    return emitLines(sink, jsonLines(canonicalJson(doc)), o.forbidden);
  }
  const lines = [
    `dry-run: 将处理 ${items.length} 个非终态候选(未写入任何东西;加 --write 才执行)`,
    `${record} ${CONSISTENCY_LABEL}`,
    `in_flight_journals: ${v.snapshot.names.length}`,
    ...items.map((i) => `  id=${i.id} lifecycle=${i.lifecycle} journal=${i.journal}`),
    ...(items.some((i) => i.journal === 'invalid')
      ? ['journal=invalid 的候选:按运行手册处置']
      : []),
  ];
  return emitLines(
    sink,
    lines.map((head) => ({ head })),
    o.forbidden,
  );
}
