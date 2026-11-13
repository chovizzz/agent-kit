/**
 * 两个暂停标记的文件实现(docs/contracts.md R21-12.2、R21-6.10、§21.24 W0-21):各有**唯一写者**,互不覆盖。
 *  - `.state/rsi/AUTO_PAUSE`(U):只归用户命令(`rsi auto pause` 独占创建 `{at, by:"user"}`,`rsi auto resume` 删除)。worker 对它**只有存在性读取**({@link UserMarkerRead},类型上无写 / 删)。
 *  - `.state/rsi/AUTO_PAUSE_BREAKER`(B):只归 worker 熔断(`{at, by:"breaker", reason}`),独占创建,**不拿锁**;`ensure` 返回前文件与父目录都已 fsync(`createExclusiveDurable`,含已存在的标记)。
 * 熔断(R21-10.1)先写 B 再写状态 / 置 canary,所以 hint 在任何崩溃窗口里都看得到。已存在的标记一律不覆盖。`user_paused` 的判据 = U 存在(含内容损坏 / 空 / 不可读)。
 */
import * as path from 'node:path';
import {
  RSI_AUTO_PAUSE_REASONS,
  RSI_FILE_MODE,
  type RsiAutoPauseReason,
} from '../../contracts/rsi.js';
import { canonicalJson } from '../../io/canonical-json.js';
import type { IoContext } from '../../io/paths.js';
import { lstatBigint, readText } from '../../io/read-fs.js';
import { createExclusiveDurable, remove } from '../../io/safe-fs.js';
import type {
  BreakerMarkerPort,
  PauseMarker,
  UserMarkerPort,
  UserMarkerToken,
} from '../personal/breaker.js';
import { CANARY_FILES } from './files.js';

const REASONS: ReadonlySet<string> = new Set(RSI_AUTO_PAUSE_REASONS);

export function parsePauseMarker(text: string): PauseMarker {
  try {
    const o = JSON.parse(text) as unknown;
    if (typeof o === 'object' && o !== null) {
      const by = (o as { by?: unknown }).by;
      const reason = (o as { reason?: unknown }).reason;
      const at = (o as { at?: unknown }).at;
      if (by === 'user') return { by: 'user', reason: null, at: null };
      if (by === 'breaker' && typeof reason === 'string' && REASONS.has(reason)) {
        // `at` 是解除证据的比较对象:只认非空且不超长的字符串,其余视为读不出(null)
        const okAt = typeof at === 'string' && at !== '' && at.length <= 64;
        return { by: 'breaker', reason: reason as RsiAutoPauseReason, at: okAt ? at : null };
      }
    }
  } catch {
    // 内容读不出:仍算存在(hint 只判存在)
  }
  return { by: 'unknown', reason: null, at: null };
}

/** `rsiDir` = 已确认安全的 `.state/rsi` 目录(与 `makePermitPort` 同一个) */
export function makeBreakerMarkerPort(
  io: IoContext,
  rsiDir: string,
  now: () => Date,
): BreakerMarkerPort {
  const file = path.join(rsiDir, CANARY_FILES.pauseBreaker);
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
      // 文件与父目录 fsync 之后才返回(调用方此后才写 state):掉电后也不会出现「状态已熔断、标记没了」;已存在的标记同样补一次 fsync
      return createExclusiveDurable(io, file, body, RSI_FILE_MODE);
    },
    async remove() {
      const cur = await read();
      if (cur === null) return false;
      await remove(io, file);
      return true;
    },
  };
}

const tokenOf = (st: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}): UserMarkerToken => ({ dev: st.dev, ino: st.ino, size: st.size, mtimeNs: st.mtimeNs });

const sameToken = (a: UserMarkerToken, b: UserMarkerToken): boolean =>
  a !== 'none' &&
  b !== 'none' &&
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs;

/**
 * 用户标记 U 的端口。`exists` = worker 唯一能用的读取(只判存在:ENOENT = false,其它读失败抛错,不返回「没有」冒充成功);
 * `ensureUser` / `snapshot` / `remove(token)` 供 W8 的 `rsi auto pause` / `resume`(本块不含命令):`remove` 只在当前实例与快照令牌逐项相等时才删
 * (令牌 `none` 永不删;`lstat` 与 `unlink` 之间仍有空窗,不提供原子 compare-and-unlink,见 verify_r21-w8 §5 的保证边界)。
 */
export function makeUserMarkerPort(io: IoContext, rsiDir: string, now: () => Date): UserMarkerPort {
  const file = path.join(rsiDir, CANARY_FILES.pause);
  const snapshot = async (): Promise<UserMarkerToken> => {
    try {
      return tokenOf(await lstatBigint(file));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'none';
      throw e;
    }
  };
  return {
    async exists() {
      return (await snapshot()) !== 'none';
    },
    snapshot,
    async ensureUser() {
      const body = canonicalJson({ at: now().toISOString(), by: 'user' });
      return createExclusiveDurable(io, file, body, RSI_FILE_MODE);
    },
    async remove(token) {
      const cur = await snapshot();
      if (cur === 'none') return 'absent';
      if (!sameToken(token, cur)) return 'changed';
      await remove(io, file);
      return 'removed';
    },
  };
}
