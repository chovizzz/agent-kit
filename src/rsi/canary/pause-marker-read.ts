/**
 * B 标记(`.state/rsi/AUTO_PAUSE_BREAKER`)的**只读**一侧(装配块 A 段;`parsePauseMarker` 从 `pause-marker.ts` 原样拆出,写侧仍在那里)。
 * 读侧闭包不得含 safe-fs:本文件只 import read-fs 与纯类型。`rsiDir` = 已由 `rsiDirReadonly` 确认安全的 `.state/rsi` 目录;
 * 读语义与写侧端口的 `read` 完全一致:ENOENT = `null`(确认不存在),其它读错误**抛错**(绝不当成「不存在」)。
 */
import * as path from 'node:path';
import { RSI_AUTO_PAUSE_REASONS, type RsiAutoPauseReason } from '../../contracts/rsi.js';
import { readText } from '../../io/read-fs.js';
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

/** 只读的 B 标记端口(类型上只有 `read`;命令侧 `WritePorts.breaker` 与 worker 只读判定共用) */
export function makeBreakerMarkerReader(rsiDir: string): Pick<BreakerMarkerPort, 'read'> {
  const file = path.join(rsiDir, CANARY_FILES.pauseBreaker);
  return {
    async read(): Promise<PauseMarker | null> {
      let text: string;
      try {
        text = await readText(file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
      return parsePauseMarker(text);
    },
  };
}
