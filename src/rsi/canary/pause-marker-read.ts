/**
 * B 标记(`.state/rsi/AUTO_PAUSE_BREAKER`)的**只读**一侧(装配块 A 段;`parsePauseMarker` 从 `pause-marker.ts` 原样拆出,写侧仍在那里)。
 * 读侧闭包不得含 safe-fs:本文件只 import read-fs 与纯类型。`rsiDir` = 已由 `rsiDirReadonly` 确认安全的 `.state/rsi` 目录;
 * 读语义见 {@link makeBreakerMarkerReader}:ENOENT = `null`(确认不存在),其它读错误与「路径不是普通文件」**抛错**(绝不当成「不存在」)。
 */
import * as path from 'node:path';
import { RSI_AUTO_PAUSE_REASONS, type RsiAutoPauseReason } from '../../contracts/rsi.js';
import { lstat, readText } from '../../io/read-fs.js';
import type { BreakerMarkerPort, PauseMarker } from '../personal/breaker.js';
import { CANARY_FILES } from './files.js';

const REASONS: ReadonlySet<string> = new Set(RSI_AUTO_PAUSE_REASONS);
/** B 的实例标识格式:16 位小写十六进制 */
const MARKER_ID_RE = /^[0-9a-f]{16}$/;

export function parsePauseMarker(text: string): PauseMarker {
  try {
    const o = JSON.parse(text) as unknown;
    if (typeof o === 'object' && o !== null) {
      const by = (o as { by?: unknown }).by;
      const reason = (o as { reason?: unknown }).reason;
      const at = (o as { at?: unknown }).at;
      if (by === 'user') return { by: 'user', reason: null, at: null, id: null };
      if (by === 'breaker' && typeof reason === 'string' && REASONS.has(reason)) {
        // `at` 只作展示 / 审计(不参与判定);`id` 是解除证据的比较对象:只认 16 位小写十六进制,缺失 / 格式不对 = 无 id(null)
        const okAt = typeof at === 'string' && at !== '' && at.length <= 64;
        const id = (o as { id?: unknown }).id;
        const okId = typeof id === 'string' && MARKER_ID_RE.test(id);
        return {
          by: 'breaker',
          reason: reason as RsiAutoPauseReason,
          at: okAt ? at : null,
          id: okId ? id : null,
        };
      }
    }
  } catch {
    // 内容读不出:仍算存在(hint 只判存在)
  }
  return { by: 'unknown', reason: null, at: null, id: null };
}

/** 标记路径存在但不是普通文件(符号链接 / 目录 / 其它):读侧不跟随、不猜,抛错(调用方当「状态未知」,不是「没有标记」) */
export class MarkerUnsafeError extends Error {
  readonly code = 'RSI_MARKER_UNSAFE';
  constructor() {
    super('breaker marker is not a regular file');
  }
}

/**
 * 只读的 B 标记端口(类型上只有 `read`;命令侧 `WritePorts.breaker` 与 worker 只读判定共用)。
 * **比写侧端口的 `read` 更严**:先 `lstat`——确认不存在(ENOENT)才是 `null`;存在但是符号链接(含悬空链接:跟随读会报 ENOENT,不能据此说「没有标记」)/ 目录 / 非普通文件 → 抛错;
 * 其它 `lstat` / 读错误照抛。`lstat` 成功后到读取之间文件被删(读报 ENOENT)= 确认不存在 → `null`。
 */
export function makeBreakerMarkerReader(rsiDir: string): Pick<BreakerMarkerPort, 'read'> {
  const file = path.join(rsiDir, CANARY_FILES.pauseBreaker);
  return {
    async read(): Promise<PauseMarker | null> {
      let text: string;
      try {
        const st = await lstat(file);
        if (!st.isFile() || st.isSymbolicLink()) throw new MarkerUnsafeError();
        text = await readText(file);
      } catch (e) {
        if (!(e instanceof MarkerUnsafeError) && (e as NodeJS.ErrnoException).code === 'ENOENT') {
          return null;
        }
        throw e;
      }
      return parsePauseMarker(text);
    },
  };
}
