/**
 * 会话文件列举(R20-2.7 / 2.9、R20-6.7;B4-0 冻结签名,B4a 实现)。每层 readdir 后按名字字节序遍历;目录项(含目录)累计超过 `RSI_MAX_DIR_ENTRIES` 就停
 * (`RSI_LIMIT_ENTRIES`,`complete = false`);只收 lstat 为普通文件、名字符合该 agent 正则的项(符号链接 / FIFO / 设备计 `notRegular`);
 * 深度 claude 与 codex 为 8,pi 为 1。文件名正则复用 reader 导出的 `SESSION_FILE_RE`(claude)/ `ROLLOUT_NAME`(codex)/ `SESSION_FILE`(pi)。
 * 不调用 `reader.discover()`(pi 的 discover 会读每个文件的首行)。
 */
import type { RsiConfigOn } from '../config.js';
import type { Enumeration, L0Deps } from './types.js';

export async function enumerateSessionFiles(
  home: string,
  config: RsiConfigOn,
  piDirSet: boolean,
  deps?: L0Deps,
): Promise<Enumeration> {
  void [home, config, piDirSet, deps];
  throw new Error('not implemented');
}
