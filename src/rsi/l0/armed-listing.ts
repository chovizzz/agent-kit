/**
 * armed 列举(R20-1.4 / 1.5a / 1.11、R20-6.7;B4-0 冻结签名,B4a 实现):只列举和读头部(每个文件**一次**偏移 0、≤ `RSI_ARMED_HEAD_BYTES` 的物理读取),
 * 不建盐、不读正文、不写数据文件、不调 `reader.read()` / `Redactor`。头部读取至多 `RSI_ARMED_MAX_FILES` 个文件,按 mtime 降序取(D4),超出的计入 `unknownSessions`
 * 并报 `RSI_LIMIT_FILES`。盐不存在(首次 armed)时 `rows[].path` 仍给出、key 不计算(`projects.ts` 的 `key8` 为 null)。
 * `listArmed` 沿用 `projects.ts` 的 `RsiProjectsDeps.listArmed` 形状(`(io, config) => Promise<ArmedListing>`)。
 */
import type { IoContext } from '../../io/paths.js';
import type { RsiConfigOn } from '../config.js';
import type { ArmedListing, ArmedListingDetailed, L0Deps } from './types.js';

export async function listArmed(
  io: IoContext,
  config: RsiConfigOn,
  deps?: L0Deps,
): Promise<ArmedListing> {
  void [io, config, deps];
  throw new Error('not implemented');
}

export async function listArmedDetailed(
  io: IoContext,
  config: RsiConfigOn,
  deps?: L0Deps,
): Promise<ArmedListingDetailed> {
  void [io, config, deps];
  throw new Error('not implemented');
}
