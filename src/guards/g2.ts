import type { Diagnostic } from '../contracts/diagnostics.js';
import { err } from './diff.js';
import type { AtomChange } from './types.js';
import { changedKeys, statusOf } from './view.js';

/**
 * G2(设计 §5.2):非晋升、非退役 PR 中,已存在原子的 `status` 字段有任何变化(不论方向)即失败。
 * 「已存在」= 基线与头部在同一路径上都有该文件。status 缺失/非字符串也算一种取值:
 * 基线 proposed → 头部删掉 status 键,同样是变化。
 */
export function checkG2(atoms: readonly AtomChange[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const a of atoms) {
    if (a.change.kind === 'A' || a.change.kind === 'D') continue;
    if (a.base === undefined || a.head === undefined) continue; // 仅 mode 变化:内容未变
    if (!a.base.ok || !a.head.ok) continue; // 无法解析已由收集阶段报出
    // 用原始值比较(而不是 statusOf 的归一化结果):status: 1 → status: 2 也是变化
    if (changedKeys(a.base.fm, a.head.fm).includes('status')) {
      const from = statusOf(a.base);
      const to = statusOf(a.head);
      out.push(
        err(
          'GUARD_G2_STATUS_CHANGED',
          a.change.path,
          `非晋升/退役 PR 不得改 status:${JSON.stringify(from)} → ${JSON.stringify(to)}` +
            '(状态变更只能经 kit:promotion / kit:retire PR)',
        ),
      );
    }
  }
  return out;
}
