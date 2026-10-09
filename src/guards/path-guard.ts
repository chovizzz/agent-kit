import type { Diagnostic } from '../contracts/diagnostics.js';
import { err } from './diff.js';
import type { Change } from './types.js';

/** 设计 §6.4:反思器产出的 diff 只允许触碰这些目录(`skills/` 不含 third_party——后者是顶层目录,本来就不在清单里)。 */
export const REFLECTOR_ALLOWED_DIRS: readonly string[] = ['rules', 'skills', 'cases', 'proposals'];
/** 设计 §6.4:触碰以下任一即失败。目录以 `/` 结尾,其余是文件。比较时不区分大小写(macOS 默认大小写不敏感)。 */
export const REFLECTOR_FORBIDDEN: readonly string[] = [
  'hooks/',
  'kit.toml',
  'codeowners',
  '.github/',
  'adapters/',
  'attest/',
];

function forbiddenHit(p: string): string | undefined {
  const lower = p.toLowerCase();
  return REFLECTOR_FORBIDDEN.find((f) => (f.endsWith('/') ? lower.startsWith(f) : lower === f));
}

/**
 * 反思器路径守卫。同时检查新旧两侧路径(--no-renames 下移动 = 删除 + 新增,所以把文件移出/移入禁区都会命中)。
 * 命中禁区 → GUARD_PATH_FORBIDDEN;不在允许目录 → GUARD_PATH_OUTSIDE_ALLOWED(区分大小写:`Rules/x` 不算 `rules/`)。
 */
export function checkReflectorPaths(changes: readonly Change[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const c of changes) {
    const hit = forbiddenHit(c.path);
    if (hit !== undefined) {
      out.push(err('GUARD_PATH_FORBIDDEN', c.path, `反思器 PR 不得触碰 ${hit}`));
    } else if (!REFLECTOR_ALLOWED_DIRS.some((d) => c.path.startsWith(`${d}/`))) {
      out.push(
        err(
          'GUARD_PATH_OUTSIDE_ALLOWED',
          c.path,
          `反思器 PR 只许触碰 ${REFLECTOR_ALLOWED_DIRS.map((d) => `${d}/`).join(' ')}`,
        ),
      );
    }
  }
  return out;
}
