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
    // GD-1:merge 只采纳 active/advisory 声明者的边;proposed 原子的边此刻不生效,但等它晋升(kit:promotion)后会生效,
    // 那时才让 active 原子下线,而晋升 PR 并不审视这些边——所以新增时就不许带
    const edges = declaredEdgeKeys(a.head.fm);
    if (edges.length > 0) {
      out.push(
        err(
          'GUARD_G1_NEW_ATOM_HAS_EDGES',
          a.change.path,
          `新增原子不得声明 ${edges.join('/')}:这些边在声明者晋升为 active/advisory 后才生效(proposed 期间被 merge 忽略),` +
            '但生效时会绕过晋升/退役流程让既有原子从产物里消失',
        ),
      );
    }
  }
  return out;
}

/** 声明了(不论取值是否合法)的 disables/overrides 键;空数组视为未声明。 */
export function declaredEdgeKeys(fm: Readonly<Record<string, unknown>>): string[] {
  return ['disables', 'overrides'].filter((k) => {
    if (!(k in fm)) return false;
    const v = fm[k];
    return !(Array.isArray(v) && v.length === 0);
  });
}
