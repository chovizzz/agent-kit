import type { Diagnostic } from '../contracts/diagnostics.js';
import { parseRestrictedYaml } from '../atoms/frontmatter.js';
import { err } from './diff.js';
import { isRegularMode } from './paths.js';
import type { Change, GuardGit } from './types.js';

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
/** D7:反思器对这些目录同样只许新增(修改 / 删除既有文件一律拒)。proposals/ 另有自己的一对码。比较不区分大小写。 */
const APPEND_ONLY_PREFIXES: readonly string[] = ['rules/', 'skills/', 'cases/'];

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
 * D7:`rules/` `skills/` `cases/` 同样只许新增:基线已有文件被删除 / 重命名旧路径 / 换成非普通文件 → GUARD_PATH_EXISTING_DELETED;
 * 被修改(含仅改权限位)→ GUARD_PATH_EXISTING_MODIFIED。
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
    const lowerPath = c.path.toLowerCase();
    if (APPEND_ONLY_PREFIXES.some((d) => lowerPath.startsWith(d)) && c.kind !== 'A') {
      if (proposalGone(c)) {
        out.push(
          err(
            'GUARD_PATH_EXISTING_DELETED',
            c.path,
            '反思器 PR 对 rules/ skills/ cases/ 只许新增文件,不得删除、移走或用非普通文件替换既有文件',
          ),
        );
      } else {
        out.push(
          err(
            'GUARD_PATH_EXISTING_MODIFIED',
            c.path,
            '反思器 PR 对 rules/ skills/ cases/ 只许新增文件,不得修改既有文件(含改正文、清空、改权限位)',
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

const REFLECTOR_BACKENDS: readonly string[] = ['claude', 'codex', 'pi'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * `kit:reflector` PR 新增的提案(`proposals/**.yaml`,头部侧新增的普通文件)的来源核验(contracts #24,CI 侧判据):
 * - `reflector.backend` 必填且为 `claude|codex|pi`(CI 才能用 provider/model 重算 `deriveVendor`)→ 缺 / 非法 GUARD_PROPOSAL_BACKEND_MISSING;
 * - `reflector.stub: true` 的提案一律拒收 → GUARD_PROPOSAL_STUB;
 * - 读不出(YAML 语法错 / 顶层非映射 / 非普通文件)→ GUARD_PROPOSAL_UNPARSEABLE(fail-closed)。
 * 只看新增文件;既有提案的修改 / 删除由 PROPOSAL_MODIFIED / DELETED 管。只在 `kit:reflector` 下调用。
 */
export function checkReflectorProposalOrigin(
  git: GuardGit,
  changes: readonly Change[],
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const c of changes) {
    const lower = c.path.toLowerCase();
    if (c.kind !== 'A' || !lower.startsWith(PROPOSALS_PREFIX)) continue;
    if (!lower.endsWith('.yaml') && !lower.endsWith('.yml')) continue;
    if (!isRegularMode(c.headMode)) {
      out.push(err('GUARD_PROPOSAL_UNPARSEABLE', c.path, '提案不是普通文件,无法核验来源'));
      continue;
    }
    const y = parseRestrictedYaml(git.blobText(c.headOid), c.path, 'GUARD_PROPOSAL_UNPARSEABLE');
    if (!y.ok || !isRecord(y.value)) {
      out.push(err('GUARD_PROPOSAL_UNPARSEABLE', c.path, '提案 YAML 读不出或顶层不是键值映射'));
      continue;
    }
    const r = y.value['reflector'];
    const backend = isRecord(r) ? r['backend'] : undefined;
    if (typeof backend !== 'string' || !REFLECTOR_BACKENDS.includes(backend)) {
      out.push(
        err(
          'GUARD_PROPOSAL_BACKEND_MISSING',
          c.path,
          '提案缺 reflector.backend(或不是 claude|codex|pi),CI 无法重算反思器厂商',
        ),
      );
    }
    if (isRecord(r) && r['stub'] === true) {
      out.push(err('GUARD_PROPOSAL_STUB', c.path, 'reflector.stub: true 的提案不得合并(桩产物)'));
    }
  }
  return out;
}
