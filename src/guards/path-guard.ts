import type { Diagnostic } from '../contracts/diagnostics.js';
import { err } from './diff.js';
import { isRegularMode } from './paths.js';
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

/** 提案账本目录。前缀比较不区分大小写(同禁区;macOS 默认大小写不敏感,`Proposals/x` 与 `proposals/x` 是同一个文件)。 */
const PROPOSALS_PREFIX = 'proposals/';

/** 基线侧存在、头部侧不再是普通文件:删除(`--no-renames` 下重命名的旧路径也是 D)、类型变更(T)、被替换成符号链接/子模块。 */
function proposalGone(c: Change): boolean {
  if (c.kind === 'A') return false;
  return c.kind === 'D' || !isRegularMode(c.headMode);
}

function forbiddenHit(p: string): string | undefined {
  const lower = p.toLowerCase();
  return REFLECTOR_FORBIDDEN.find((f) => (f.endsWith('/') ? lower.startsWith(f) : lower === f));
}

/**
 * 反思器路径守卫。同时检查新旧两侧路径(--no-renames 下移动 = 删除 + 新增,所以把文件移出/移入禁区都会命中)。
 * 命中禁区 → GUARD_PATH_FORBIDDEN;不在允许目录 → GUARD_PATH_OUTSIDE_ALLOWED(区分大小写:`Rules/x` 不算 `rules/`)。
 * 提案是只增的证据账本:基线里已有的 `proposals/**` 文件被删除(含重命名的旧路径)或被换成非普通文件(符号链接/子模块)
 * → GUARD_PATH_PROPOSAL_DELETED;已有文件被修改(内容、清空、仅改权限位)→ GUARD_PATH_PROPOSAL_MODIFIED(与上两个码独立,可同时出现;proposals/ 对反思器只许新增)。
 */
export function checkReflectorPaths(changes: readonly Change[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const c of changes) {
    if (c.path.toLowerCase().startsWith(PROPOSALS_PREFIX)) {
      if (proposalGone(c)) {
        out.push(
          err(
            'GUARD_PATH_PROPOSAL_DELETED',
            c.path,
            '反思器 PR 不得删除、移走或用非普通文件替换已有提案',
          ),
        );
      } else if (c.kind !== 'A') {
        out.push(
          err(
            'GUARD_PATH_PROPOSAL_MODIFIED',
            c.path,
            '反思器 PR 对 proposals/ 只许新增文件,不得修改已有提案(含清空、改内容、改权限位)',
          ),
        );
      }
    }
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

/**
 * 无任何 `kit:*` 标签的内容 PR:不得删除(含重命名的旧路径、换成非普通文件)基线里已有的 `proposals/**`。
 * 提案是只增的证据账本,删掉失手提案会让它退出校准账(contracts §18.10 残余缺口「删除」)。
 * 只管删除:新增与修改提案内容不因本判据报错;带标签的 PR 走各自的守卫,不经过这里。
 */
export function checkUnlabeledProposalDeletes(changes: readonly Change[]): Diagnostic[] {
  return changes
    .filter((c) => c.path.toLowerCase().startsWith(PROPOSALS_PREFIX) && proposalGone(c))
    .map((c) =>
      err(
        'GUARD_PROPOSAL_DELETED_UNLABELED',
        c.path,
        '无 kit:* 标签的 PR 不得删除或移走已有提案(proposals/ 是只增的证据账本)',
      ),
    );
}
