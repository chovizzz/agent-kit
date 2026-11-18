/**
 * `reconcileCaches`(从 `canary-writer.ts` **原样拆出**并由它再导出,既有 import 路径不变;照 `canary-mute.ts` 的做法):对账的缓存清理部分,只减影响、只需 `rsi/lock`。
 * 拆出的原因:worker 个人步的装配闭包(`assemble-worker.ts`)不得含 `canary-writer.ts`(授予 `grantCanary` 在那里),而 S2R 与单次扫尾都要调它。
 */
import type { RsiRevocationLine } from '../../contracts/rsi-personal.js';
import type { IoContext } from '../../io/paths.js';
import { removeCanary } from './canary-mute.js';
import { appendStopLine } from './ledger.js';
import { revocationRefOf } from './files.js';
import type { HeldLock } from './atomic-write.js';
import { readCanaryDoc } from './permit-read.js';

/** 对账的缓存清理部分(调用方持 `rsi/lock`;只需这一把):去掉 canary.json 里被凭据列出的条目(缓存不可读也移除)、补 stop 行(同 ref 不重复)。状态推进由 W3 的对账步骤做 */
export async function reconcileCaches(
  d: { io: IoContext; rsiDir: string; locks: { rsi: HeldLock } },
  lines: readonly RsiRevocationLine[],
  at: Date,
): Promise<void> {
  for (const l of lines) {
    const cur = await readCanaryDoc(d.rsiDir);
    // 不合规 / 不可读的缓存同样移除(hint 本来就不会用它;留着只会让屏障永远拒绝授予):确认不了内容时按「收紧」处理
    if (
      cur.kind === 'unreadable' ||
      (cur.kind === 'ok' &&
        cur.value.candidate_id === l.candidate_id &&
        cur.value.content_sha256 === l.content_sha256)
    ) {
      await removeCanary({ io: d.io, rsiDir: d.rsiDir, locks: { rsi: d.locks.rsi } });
    }
    await appendStopLine(d.io, d.rsiDir, d.locks.rsi, {
      kind: 'stop',
      at: `${at.toISOString().slice(0, 19)}Z`,
      candidate_id: l.candidate_id,
      reason: 'revocation_reconciled',
      revocation_ref: revocationRefOf(l),
    });
  }
}
