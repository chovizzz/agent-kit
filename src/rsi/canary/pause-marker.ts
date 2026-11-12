/**
 * `AUTO_PAUSE` 标记的文件实现(docs/contracts.md R21-12.2、R21-6.10:`.state/rsi/AUTO_PAUSE`,独占创建,**不拿锁**;hint 只判存在)。
 * 熔断(R21-10.1)先写它再写状态 / 置 canary,所以 hint 在任何崩溃窗口里都看得到。内容 `{at, by, reason?}` 只用于恢复:
 * `by=user` 是 `rsi auto pause` 写的(等价 `user_paused`),`by=breaker` 是 worker 熔断写的。已存在的标记一律不覆盖。
 */
import * as path from 'node:path';
import {
  RSI_AUTO_PAUSE_REASONS,
  RSI_FILE_MODE,
  type RsiAutoPauseReason,
} from '../../contracts/rsi.js';
import { canonicalJson } from '../../io/canonical-json.js';
import type { IoContext } from '../../io/paths.js';
import { readText } from '../../io/read-fs.js';
import { createExclusive, remove } from '../../io/safe-fs.js';
import type { PauseMarker, PauseMarkerPort } from '../personal/breaker.js';
import { CANARY_FILES } from './files.js';

const REASONS: ReadonlySet<string> = new Set(RSI_AUTO_PAUSE_REASONS);

export function parsePauseMarker(text: string): PauseMarker {
  try {
    const o = JSON.parse(text) as unknown;
    if (typeof o === 'object' && o !== null) {
      const by = (o as { by?: unknown }).by;
      const reason = (o as { reason?: unknown }).reason;
      if (by === 'user') return { by: 'user', reason: null };
      if (by === 'breaker' && typeof reason === 'string' && REASONS.has(reason)) {
        return { by: 'breaker', reason: reason as RsiAutoPauseReason };
      }
    }
  } catch {
    // 内容读不出:仍算存在(hint 只判存在)
  }
  return { by: 'unknown', reason: null };
}

/** `rsiDir` = 已确认安全的 `.state/rsi` 目录(与 `makePermitPort` 同一个) */
export function makePauseMarkerPort(
  io: IoContext,
  rsiDir: string,
  now: () => Date,
): PauseMarkerPort {
  const file = path.join(rsiDir, CANARY_FILES.pause);
  const read = async (): Promise<PauseMarker | null> => {
    let text: string;
    try {
      text = await readText(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    return parsePauseMarker(text);
  };
  return {
    read,
    async ensure(reason) {
      const body = canonicalJson({ at: now().toISOString(), by: 'breaker', reason });
      try {
        await createExclusive(io, file, body, RSI_FILE_MODE);
        return 'created';
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
        throw e;
      }
    },
    async remove(scope) {
      const cur = await read();
      if (cur === null) return false;
      if (scope === 'own' && cur.by !== 'breaker') return false;
      await remove(io, file);
      return true;
    },
  };
}
