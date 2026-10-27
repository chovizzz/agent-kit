/**
 * `recoverSnapshot` / `inspectSnapshot` 的生产校验器(R20-A2 B2,docs/contracts.md §20.5 R20-5.6 订正;v2 §4)。
 *
 * 固定小文件整份校验(每次 recover / inspect 都跑,含清单一致的快路径):
 *  - `state.json` → `RsiStateSchema`(仅 `confirm` 单独不合规按「确认失效」放行,见下)、`cursor.json` → `RsiCursorSchema`、`counts.json` → `RsiCountsSchema`;
 *  - `projects.json`:**D4** —— 它的 schema / 内容问题**不阻断**快照(索引另算 `invalid`,R20-2.7 / R20-6.5:继续采集、不给摘要,
 *    只能 `--rebuild-index` 替换)。链接、硬链接、权限、属主错误不在这里判,读取阶段照旧阻断(`state_dir_unsafe`)。
 * 缺失(`bytes === null`,清单有、磁盘无;D5):`projects.json` 放行(`index_absent` 不阻断);`state.json` / `cursor.json` /
 * `counts.json` 与所有月文件缺失 = 损坏(月文件只被 purge 用临时文件 + rename 重写,永不删除)。
 * 月文件逐行:`signals/…` 行过 `SignalSchema`,`sessions/…` 行过 `SessionStatSchema`。
 */
import { RsiCountsSchema, RsiCursorSchema } from '../contracts/rsi.js';
import { SessionStatSchema } from '../contracts/session-stat.js';
import { SignalSchema } from '../contracts/signal.js';
import { parseRsiStateDoc } from './state.js';
import type { SnapshotValidator } from './snapshot.js';

function parsesAs(
  schema: { safeParse(v: unknown): { success: boolean } },
  bytes: Uint8Array,
): boolean {
  try {
    return schema.safeParse(JSON.parse(Buffer.from(bytes).toString('utf8'))).success;
  } catch {
    return false;
  }
}

export const productionSnapshotValidator: SnapshotValidator = {
  fixed(name, bytes) {
    if (bytes === null) return name === 'projects.json';
    switch (name) {
      case 'state.json': {
        // 与 `parseRsiStateDoc` / `rsiStateOf` 同一判定:只有 `confirm` 过不了 schema 是**状态**(退回 armed,R20-1.5 ⑥,可重新确认),
        // 不是损坏;若在这里挡掉,恢复先于 `rsi confirm` 抛 state_invalid,用户就没有重新确认的入口。整份过不了 schema 才是损坏。
        const kind = parseRsiStateDoc(bytes).kind;
        return kind === 'ok' || kind === 'confirm_schema_invalid';
      }
      case 'cursor.json':
        return parsesAs(RsiCursorSchema, bytes);
      case 'counts.json':
        return parsesAs(RsiCountsSchema, bytes);
      case 'projects.json':
        return true; // D4
      default:
        return false; // 月文件不会以整份形式交到这里
    }
  },
  record(name, value) {
    if (name.startsWith('signals/')) return SignalSchema.safeParse(value).success;
    if (name.startsWith('sessions/')) return SessionStatSchema.safeParse(value).success;
    return false;
  },
};
