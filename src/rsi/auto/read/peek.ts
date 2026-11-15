/**
 * 写命令的「无锁预读」只读适配器(装配块 A 段;B 段把它们接进 `WritePorts.peekRecord` / `peekRecords` 与 `RollbackDeps.recordedSha`)。
 * 建在 `readVerifiedRecords`(内容验证双读协议 + 受限只读 git 的 `RecordedReadPort`)之上,**没有任何写出口、不持锁、不碰引用 / 索引 / 工作树**。
 *
 * 映射规则(fail-closed;测试钉住):
 *  - `head.json` 不存在 = 私有仓库从未建过 = `absent`;
 *  - 读失败 / 不稳定(busy)/ head 或记录不合规 = `invalid`(**绝不**映射成 `missing` / `absent`:否则 `veto` 会把「读不出」误判成 `unknown_id`);
 *  - 只有读成功且列表里确实没有该 id 才是 `missing`;
 *  - 本适配器**产出不了** `deferred`(人工分叉 / 属主变化要现算仓库分类,那是 `RebasePort.classify` 的事,B 段);调用方在持锁后仍须重读,锁外这次不作数。
 */
import { RSI_SNAPSHOT_BUSY } from '../../../contracts/rsi.js';
import type { PersonalLifecycleRecord } from '../../../contracts/rsi-personal.js';
import type { RecordRead, RepoRead } from '../../personal/candidate-port-types.js';
import type { AutoReadPorts } from './ports.js';
import { readVerifiedRecords } from './records-view.js';

type Src = Pick<AutoReadPorts, 'home' | 'recorded'>;

const reasonOf = (stderr: string): string => /reason=([a-z_]+)/.exec(stderr)?.[1] ?? 'unreadable';

export function makePeekRecords(p: Src): () => Promise<RepoRead<PersonalLifecycleRecord[]>> {
  return async () => {
    let v;
    try {
      v = await readVerifiedRecords(p);
    } catch {
      return { kind: 'invalid', why: 'unreadable' };
    }
    if (v.kind === 'exit') {
      return {
        kind: 'invalid',
        why: v.stderr.startsWith(RSI_SNAPSHOT_BUSY) ? 'snapshot_busy' : reasonOf(v.stderr),
      };
    }
    if (v.head === null) return { kind: 'absent' };
    return { kind: 'ok', head: v.head, value: v.records };
  };
}

export function makePeekRecord(p: Src): (id: string) => Promise<RecordRead> {
  const all = makePeekRecords(p);
  return async (id) => {
    const r = await all();
    if (r.kind !== 'ok') return r;
    const rec = r.value.find((x) => x.id === id);
    return rec === undefined
      ? { kind: 'missing', head: r.head }
      : { kind: 'ok', head: r.head, record: rec };
  };
}

/**
 * `RollbackDeps.recordedSha` 的只读实现:从 `head.json` 记录的提交里取该候选的 `content_sha256`(与写侧 `recordedShaReader` 同一契约:
 * 读不到 / 记录不合规 / 候选不在 = `null`,执行器当 `content_unknown`、本段未完成)。
 */
export function makeRecordedShaRead(p: Src): (candidateId: string) => Promise<string | null> {
  const all = makePeekRecords(p);
  return async (id) => {
    const r = await all();
    if (r.kind !== 'ok') return null;
    return r.value.find((x) => x.id === id)?.content_sha256 ?? null;
  };
}
