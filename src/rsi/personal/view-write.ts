/**
 * `auto-view.json` 的**写端口**(契约 §21.24 W0-22 第 7 条:「worker 在 `rsi/lock` 下原子写,`rsi auto status` 只读」;D4)。
 *
 * 持 `rsi/lock`(调用方传入的 `assertHeld`,每个写点之前复核)→ 临时文件 `createExclusive`(0600)→ `rename`(提交点);读者要么看到旧视图、要么看到新视图。
 * 本端口**只写视图**:不碰权威记录 / 工作副本 / 审计;失败(丢锁、写失败、视图不合 schema)一律以返回值报告、**不外抛**;失败**不替换已有的正式视图**(临时文件可能被清理或遗留,下次写入会先清掉)
 * (旧视图保持原样 = 变陈旧;陈旧 / 缺失视图在读侧永远不恢复授权,见 `auto/read/view-read.ts`)。所以视图写失败**不得阻塞** purge / 回滚等保护写。
 *
 * 写入时机(S 阶段末、purge 之后各一次)与 worker 接线**不在本块**:留给装配 C 段(见 `verify_r21-asm-d4.md` 的接线点)。B1a 合并后本端口的锁参数应迁到 `HeldStore` 事务令牌。
 */
import {
  AutoViewSchema,
  RsiTransitionReasonSchema,
  type AutoView,
} from '../../contracts/rsi-personal.js';
import { RSI_AUTO_VIEW_FILE, RSI_LIFECYCLE_STATES } from '../../contracts/rsi.js';
import { canonicalJsonLine } from '../../io/canonical-json.js';
import type { IoContext } from '../../io/paths.js';
import { removeRsiFile, writeRsiFileAtomic, type HeldLock } from '../canary/atomic-write.js';
import { RsiLockError } from '../lock-error.js';

export interface ViewWriterDeps {
  io: IoContext;
  /** `.state/rsi` 的真实路径(调用方已按 `rsiDir()` 校验) */
  rsiDir: string;
  locks: { rsi: HeldLock };
}

export type ViewWriteWhy = 'invalid_view' | 'lock_lost' | 'write_failed';
export type ViewWrite = { ok: true } | { ok: false; why: ViewWriteWhy };

/**
 * 语义复核(M4):`AutoViewSchema` 里这几处是开放字符串(`reason` / `origin_reason` ≤ 64 字符、`states` 的键 ≤ 32 字符),
 * 「过 schema」不等于「不含路径 / 用户名」。这里按封闭枚举 / 生命周期键集合再验一次;**不改**已冻结的 schema。
 * 返回 `true` = 合格。
 */
function semanticallyClosed(v: AutoView): boolean {
  const reasons = [v.last_rollback?.reason, ...v.rolling_back.map((r) => r.origin_reason)];
  for (const r of reasons) {
    if (r !== undefined && !RsiTransitionReasonSchema.safeParse(r).success) return false;
  }
  const keys = Object.keys(v.pipeline.states);
  const states = new Set<string>(RSI_LIFECYCLE_STATES);
  return keys.length === states.size && keys.every((k) => states.has(k));
}

/** 写视图。`view` 是跨信任边界的输入(调用方构造),写前**再校验一次** schema + 封闭枚举 */
export async function writeAutoView(d: ViewWriterDeps, view: AutoView): Promise<ViewWrite> {
  let text: string;
  try {
    const parsed = AutoViewSchema.safeParse(view);
    if (!parsed.success) return { ok: false, why: 'invalid_view' };
    try {
      // 校验已通过:此后序列化 / 语义复核再出错是本端口自己的故障,不是「视图不合格」(两者原因码不同,校验被绕过时才看得出来)
      if (!semanticallyClosed(parsed.data)) return { ok: false, why: 'invalid_view' };
      text = canonicalJsonLine(parsed.data);
    } catch {
      return { ok: false, why: 'write_failed' };
    }
  } catch {
    return { ok: false, why: 'invalid_view' }; // 序列化 / 校验本身抛错(循环引用、奇异对象)也不外抛
  }
  try {
    await d.locks.rsi.assertHeld();
  } catch {
    return { ok: false, why: 'lock_lost' };
  }
  try {
    await writeRsiFileAtomic(d.io, d.rsiDir, RSI_AUTO_VIEW_FILE, text, [d.locks.rsi]);
    return { ok: true };
  } catch (e) {
    if (e instanceof RsiLockError && e.kind === 'lock_lost') return { ok: false, why: 'lock_lost' };
    // 清掉自己可能留下的临时文件(先复核锁:丢锁后临时文件可能已是别人的,不碰)
    await removeRsiFile(d.io, d.rsiDir, `${RSI_AUTO_VIEW_FILE}.tmp`, [d.locks.rsi]).catch(
      () => undefined,
    );
    return { ok: false, why: 'write_failed' };
  }
}
