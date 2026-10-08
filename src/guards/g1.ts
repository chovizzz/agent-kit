import type { Diagnostic } from '../contracts/diagnostics.js';
import { err } from './diff.js';
import type { AtomChange } from './types.js';
import { statusOf } from './view.js';

/**
 * G1(设计 §5.2):内容 PR **新增**的原子文件,`status` 必须为 `proposed`。
 * 「新增」按路径判定,且 diff 不做重命名检测:把存量原子改名/移动 = 旧路径删除 + 新路径新增,
 * 新路径照样要过 G1(旧路径的删除另由 G4 管)。头部版本无法解析时 GUARD_FRONTMATTER_UNPARSEABLE 已由收集阶段报出。
 */
export function checkG1(atoms: readonly AtomChange[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const a of atoms) {
    if (a.change.kind !== 'A' || a.head === undefined || !a.head.ok) continue;
    const s = statusOf(a.head);
    if (s !== 'proposed') {
      out.push(
        err(
          'GUARD_G1_NEW_ATOM_NOT_PROPOSED',
          a.change.path,
          `新增原子的 status 必须是 proposed,实际为 ${s === undefined ? '(缺失或非字符串)' : JSON.stringify(s)}`,
        ),
      );
    }
  }
  return out;
}
