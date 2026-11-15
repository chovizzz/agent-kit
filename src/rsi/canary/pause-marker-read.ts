/**
 * B 标记(`.state/rsi/AUTO_PAUSE_BREAKER`)的**只读**一侧(装配块 A 段;`parsePauseMarker` 从 `pause-marker.ts` 原样拆出,写侧仍在那里)。
 * 读侧闭包不得含 safe-fs:本文件只 import read-fs 与纯类型。`rsiDir` = 已由 `rsiDirReadonly` 确认安全的 `.state/rsi` 目录;
 * 读语义见 {@link makeBreakerMarkerReader}:ENOENT = `null`(确认不存在),其它读错误与「路径不是普通文件」**抛错**(绝不当成「不存在」)。
 */
import * as path from 'node:path';
import { RSI_AUTO_PAUSE_REASONS, type RsiAutoPauseReason } from '../../contracts/rsi.js';
import { readFileSafe } from '../../io/read-fs.js';
import type { BreakerMarkerPort, PauseMarker } from '../personal/breaker.js';
import { RSI_FILE_OWNER } from '../lock-read.js';
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

/** 标记路径存在但不安全(符号链接 / 目录 / 非普通文件 / 硬链接 / 属主或权限不对 / 超限 / 其它读错误):读侧不跟随、不猜,抛错(调用方当「状态未知」,不是「没有标记」) */
export class MarkerUnsafeError extends Error {
  readonly code = 'RSI_MARKER_UNSAFE';
  constructor(readonly why: string = 'unsafe') {
    super(`breaker marker is not safely readable (${why})`);
  }
}

/** 标记正文的读取上限(合法内容只有几十字节;远大于它即不可信) */
const MARKER_MAX_BYTES = 64 * 1024;

/**
 * 只读的 B 标记端口(类型上只有 `read`;命令侧 `WritePorts.breaker` 与 worker 只读判定共用)。
 * **比写侧端口的 `read` 更严**:经句柄级 `readFileSafe`(`O_NOFOLLOW | O_NONBLOCK` 打开 + 对句柄 fstat:普通文件、`nlink == 1`、属主与 0600 权限、大小上限;与撤销凭据读同一入口),
 * 不再 `lstat` 后另行按路径读(检查—使用竞态:检查后被换成链接会被跟随,换成悬空链接会被读成「不存在」)。
 * 三态映射:`missing`(open 报 ENOENT,或打开后被 unlink)才是 `null`;`unsafe`(含悬空 / 有效符号链接 → ELOOP)→ 抛 {@link MarkerUnsafeError};`ok` → 解析。
 * 残余(同 `readFileSafe`):`O_NOFOLLOW` 只管末级,父目录 `rsiDir` 的安全由调用方(`rsiDirReadonly`)承担。
 * `seam.beforeOpen` 是测试缝(演练「检查之后、读取之前被替换」),生产装配不传。
 */
export function makeBreakerMarkerReader(
  rsiDir: string,
  seam: { beforeOpen?: () => Promise<void> | void } = {},
): Pick<BreakerMarkerPort, 'read'> {
  const file = path.join(rsiDir, CANARY_FILES.pauseBreaker);
  return {
    async read(): Promise<PauseMarker | null> {
      const r = await readFileSafe(file, {
        maxBytes: MARKER_MAX_BYTES,
        owner: RSI_FILE_OWNER,
        ...(seam.beforeOpen === undefined ? {} : { beforeOpen: seam.beforeOpen }),
      });
      if (r.kind === 'missing') return null;
      if (r.kind === 'unsafe') throw new MarkerUnsafeError(r.why);
      return parsePauseMarker(r.bytes.toString('utf8'));
    },
  };
}
