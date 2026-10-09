import type { Diagnostic } from '../contracts/diagnostics.js';
import { err } from './diff.js';
import type { AtomChange } from './types.js';
import { changedKeys, deepEqual, statusOf } from './view.js';

/** 内容 PR 里不得改的治理字段(改了会改变生效面或生命周期);要改只能走晋升/退役,或新建新 id 的原子。 */
export const G2_LOCKED_FIELDS: readonly string[] = [
  'id',
  'layer',
  'strength',
  'applies_to',
  'paths',
  'overrides',
  'disables',
];

/**
 * G2(设计 §5.2):非晋升、非退役 PR 中,已存在原子的治理字段有任何变化即失败。
 *  - `status`:不论方向;缺失/非字符串也算一种取值(用原始值比较,`status: 1` → `2` 也是变化)。
 *  - `review_by`:不得往后延(与 G3 的『单独延期会绕开到期退役』一致);提前到期是安全方向,放行。
 *    无法比较(非 ISO 字符串)按延期处理。
 *  - G2_LOCKED_FIELDS:`id`/`layer`/`strength`/`applies_to`/`paths`/`overrides`/`disables`。
 *    `overrides`/`disables` 的增与删都算(删边会让被压掉的原子复活);`id` 被锁是因为边按 id 解析,
 *    改 id 可以让存量边指向另一个 active 原子。
 * `owner`/`volatility` 不锁(lint 已约束其取值,锁死会让人员交接无路可走)。
 * 「已存在」= 基线与头部在同一路径上都有该文件。
 */
export function checkG2(atoms: readonly AtomChange[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const a of atoms) {
    if (a.change.kind === 'A' || a.change.kind === 'D') continue;
    if (a.base === undefined || a.head === undefined) continue; // 仅 mode 变化:内容未变
    if (!a.base.ok || !a.head.ok) continue; // 无法解析已由收集阶段报出
    const keys = changedKeys(a.base.fm, a.head.fm);
    if (keys.includes('status')) {
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
    if (keys.includes('review_by')) {
      const from = a.base.fm['review_by'];
      const to = a.head.fm['review_by'];
      const earlier = typeof from === 'string' && typeof to === 'string' && to < from;
      if (!earlier) {
        out.push(
          err(
            'GUARD_G2_REVIEW_BY_EXTENDED',
            a.change.path,
            `非晋升/退役 PR 不得延长或改写 review_by:${JSON.stringify(from)} → ${JSON.stringify(to)}` +
              '(只允许提前;延期会绕开到期退役)',
          ),
        );
      }
    }
    // 基线还是 proposed 的原子(尚未生效、不渲染)可以改结构字段,否则写错 paths 的 proposed 原子既改不了也删不掉;
    // 边(overrides/disables)不论状态一律锁定(merge 不看声明者 status)。缺省与 [] 视为相同。
    const baseProposed = statusOf(a.base) === 'proposed';
    const norm = (v: unknown): unknown => (v === undefined ? [] : v);
    const locked = keys.filter((k) => {
      if (!G2_LOCKED_FIELDS.includes(k)) return false;
      if (k === 'overrides' || k === 'disables')
        return !deepEqual(
          norm(a.base?.ok ? a.base.fm[k] : undefined),
          norm(a.head?.ok ? a.head.fm[k] : undefined),
        );
      return !baseProposed;
    });
    if (locked.length > 0) {
      out.push(
        err(
          'GUARD_G2_FIELD_LOCKED',
          a.change.path,
          `非晋升/退役 PR 不得改已有原子的 ${locked.join(', ')}(改变生效面);` +
            '如需调整,新建一个新 id 的原子并走退役流程',
        ),
      );
    }
  }
  return out;
}
