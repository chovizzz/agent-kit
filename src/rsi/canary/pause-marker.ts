/**
 * 两个暂停标记的文件实现(docs/contracts.md R21-12.2、R21-6.10、§21.24 W0-21):各有**唯一写者**,互不覆盖。
 *  - `.state/rsi/AUTO_PAUSE`(U):只归用户命令(`rsi auto pause` 独占创建 `{at, by:"user"}`,`rsi auto resume` 删除)。worker 对它**只有存在性读取**({@link UserMarkerRead},类型上无写 / 删)。
 *  - `.state/rsi/AUTO_PAUSE_BREAKER`(B):只归 worker 熔断(`{at, by:"breaker", reason, id}`;`id` = 创建时生成的 16 位十六进制实例标识,W0-23 解除证据的比较对象;`at` 只作展示 / 审计,不参与任何判定),独占创建,**不拿锁**;`ensure` 返回前文件与父目录都已 fsync(`createExclusiveDurable`,含已存在的标记)。
 * 熔断(R21-10.1)先写 B 再写状态 / 置 canary,所以 hint 在任何崩溃窗口里都看得到。已存在的标记一律不覆盖。`user_paused` 的判据 = U 存在(含内容损坏 / 空 / 不可读)。
 */
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { RSI_FILE_MODE } from '../../contracts/rsi.js';
import { canonicalJson } from '../../io/canonical-json.js';
import type { IoContext } from '../../io/paths.js';
import { lstatBigint, readText } from '../../io/read-fs.js';
import { createExclusiveDurable, remove } from '../../io/safe-fs.js';
import type {
  BreakerMarkerPort,
  PauseMarker,
  UserMarkerPort,
  UserMarkerStamp,
} from '../personal/breaker.js';
import { CANARY_FILES } from './files.js';
import { parsePauseMarker } from './pause-marker-read.js';

// 解析已拆到只读模块 `pause-marker-read.ts`(读侧闭包不含 safe-fs);再导出,既有调用点不变
export { parsePauseMarker } from './pause-marker-read.js';

const defaultNewId = (): string => randomBytes(8).toString('hex');

/** `rsiDir` = 已确认安全的 `.state/rsi` 目录(与 `makePermitPort` 同一个) */
export function makeBreakerMarkerPort(
  io: IoContext,
  rsiDir: string,
  now: () => Date,
  newId: () => string = defaultNewId,
  /** 写点守卫(可选):紧贴实际写操作(创建 / unlink)之前调用,抛错 = 不写;删除时在回读之后调用。端口接口不变 */
  guard: () => Promise<void> = () => Promise.resolve(),
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
      const body = canonicalJson({ at: now().toISOString(), by: 'breaker', reason, id: newId() });
      await guard();
      // 文件与父目录 fsync 之后才返回(调用方此后才写 state):掉电后也不会出现「状态已熔断、标记没了」;已存在的标记同样补一次 fsync
      return createExclusiveDurable(io, file, body, RSI_FILE_MODE);
    },
    async remove() {
      const cur = await read();
      if (cur === null) return false;
      await guard();
      await remove(io, file);
      return true;
    },
  };
}

const stampOf = (st: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}): UserMarkerStamp => ({ dev: st.dev, ino: st.ino, size: st.size, mtimeNs: st.mtimeNs });

const sameStamp = (a: UserMarkerStamp, b: UserMarkerStamp): boolean =>
  a !== 'none' &&
  b !== 'none' &&
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs;

/**
 * 用户标记 U 的端口。`exists` = worker 唯一能用的读取(只判存在:ENOENT = false,其它读失败抛错,不返回「没有」冒充成功);
 * `ensureUser` / `snapshot` / `remove(stamp)` 供 W8 的 `rsi auto pause` / `resume`(本块不含命令):`remove` 只在当前实例与快照指纹逐项相等时才删
 * (指纹 `none` 永不删;`lstat` 与 `unlink` 之间仍有空窗,不提供原子 compare-and-unlink,见 verify_r21-w8 §5 的保证边界)。
 */
export function makeUserMarkerPort(io: IoContext, rsiDir: string, now: () => Date): UserMarkerPort {
  const file = path.join(rsiDir, CANARY_FILES.pause);
  const snapshot = async (): Promise<UserMarkerStamp> => {
    try {
      return stampOf(await lstatBigint(file));
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
    async remove(stamp) {
      const cur = await snapshot();
      if (cur === 'none') return 'absent';
      if (!sameStamp(stamp, cur)) return 'changed';
      await remove(io, file);
      return 'removed';
    },
  };
}
