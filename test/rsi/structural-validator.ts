/**
 * 仅供测试的结构校验器(原 `src/rsi/snapshot.ts` 的缺省 `structuralValidator`;R20-A2 B2 起生产代码**不再有缺省校验器**,
 * `recoverSnapshot` / `inspectSnapshot` 必须传校验器,生产传 `productionSnapshotValidator`)。
 * 对缺失一律放行(「cursor / counts 被 purge 重写后仍是未完成提交」),必需文件规则由各测试自己叠加。
 */
import { RSI_SNAPSHOT_FIXED_NAMES } from '../../src/contracts/rsi.js';
import { SessionStatSchema } from '../../src/contracts/session-stat.js';
import { SignalSchema } from '../../src/contracts/signal.js';
import type { SnapshotValidator } from '../../src/rsi/snapshot.js';

export const structuralValidator: SnapshotValidator = {
  fixed(name, bytes) {
    if (bytes === null) return true;
    if (!RSI_SNAPSHOT_FIXED_NAMES.includes(name)) return false;
    try {
      const v: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
      return typeof v === 'object' && v !== null && !Array.isArray(v);
    } catch {
      return false;
    }
  },
  record(name, value) {
    const schema = name.startsWith('signals/') ? SignalSchema : SessionStatSchema;
    return schema.safeParse(value).success;
  },
};

/** 在 `base` 之上叠加固定文件的额外判定(两者都通过才算通过);记录校验沿用 base */
export function withFixed(
  base: SnapshotValidator,
  extra: (name: string, bytes: Uint8Array | null) => boolean,
): SnapshotValidator {
  return {
    fixed: (name, bytes) => base.fixed(name, bytes) && extra(name, bytes),
    record: base.record,
  };
}
