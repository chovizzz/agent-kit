/**
 * 探针票的占用(docs/contracts.md §21.24 W0-3「hint 只消费窄许可」①)。
 *
 * 票是 hint 的**占用标记**,不是预建文件:对 i = 1..`tickets` 依次 `createExclusive` `.state/rsi/canary-probe/<agent>/<generation>-<i>.used`,
 * 第一个成功者得票;`EEXIST` = 这张已被占,试下一张;全部被占 → `null`(不输出)。**有限次、原子**:并发消费者至多 `tickets` 个成功,
 * 绝不重复授予同一张;旧代(`generation` 不同)的占用文件名不同,自然不计入本代。除 `EEXIST` 之外的任何错误(路径守卫拒绝、权限、I/O)都向上抛——
 * 调用方不输出(fail-closed;宁可少探)。
 */
import * as path from 'node:path';
import { RSI_DIR_MODE, RSI_FILE_MODE, type RsiAgentId } from '../../contracts/rsi.js';
import type { IoContext } from '../../io/paths.js';
import { createExclusive, mkdirp } from '../../io/safe-fs.js';
import { CANARY_FILES, probeTicketName } from './files.js';

export interface TicketGrant {
  /** 票号 `<generation>-<i>` */
  ticket: string;
  /** 占到的票所属代号(账行 `probe_generation`,W0-18) */
  generation: number;
  /** 票序 i(账行 `probe_ticket`,W0-18) */
  index: number;
}

export async function consumeProbeTicket(
  io: IoContext,
  rsiDir: string,
  agent: RsiAgentId,
  entry: { generation: number; tickets: number },
): Promise<TicketGrant | null> {
  const dir = path.join(rsiDir, CANARY_FILES.probeDir, agent);
  await mkdirp(io, dir, RSI_DIR_MODE);
  for (let i = 1; i <= entry.tickets; i++) {
    const name = probeTicketName(entry.generation, i);
    try {
      await createExclusive(io, path.join(dir, name), '', RSI_FILE_MODE);
      return { ticket: `${entry.generation}-${i}`, generation: entry.generation, index: i };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw e;
    }
  }
  return null;
}
