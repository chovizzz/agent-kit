import type { Diagnostic } from '../contracts/diagnostics.js';
import { isAtomPath, isRegularMode, isUnsafePath } from './paths.js';
import type { AtomChange, AtomView, Change, GuardGit } from './types.js';
import { viewAtom } from './view.js';

export const err = (code: string, path: string, message: string): Diagnostic => ({
  code,
  severity: 'error',
  path,
  message,
});

function readView(
  git: GuardGit,
  path: string,
  side: '基线' | '头部',
  mode: string,
  oid: string,
  out: Diagnostic[],
): AtomView {
  if (!isRegularMode(mode)) {
    const v: AtomView = { ok: false, reason: `${side}侧不是普通文件(mode ${mode})` };
    out.push(err('GUARD_FRONTMATTER_UNPARSEABLE', path, `${side}版本无法比较:${v.reason}`));
    return v;
  }
  const v = viewAtom(git.blobText(oid), path);
  if (!v.ok) {
    out.push(err('GUARD_FRONTMATTER_UNPARSEABLE', path, `${side}版本无法比较:${v.reason}`));
  }
  return v;
}

/** 变更里路径本身不合法(手工构造的树)→ 逐条报错。 */
export function unsafePathDiagnostics(changes: readonly Change[]): Diagnostic[] {
  return changes
    .filter((c) => isUnsafePath(c.path))
    .map((c) => err('GUARD_PATH_UNSAFE', c.path, '路径含空段、`.`/`..`、反斜杠或 NUL,拒绝比较'));
}

/**
 * 为每个被改动的原子文件取出两侧的 frontmatter 视图。
 * 无法解析(包含重复键、别名、缺 frontmatter、符号链接等)→ 一条 GUARD_FRONTMATTER_UNPARSEABLE,
 * 对应的视图 ok:false,各守卫据此 fail-closed(不会因为「读不出来」而放行)。
 * 仅改 mode、内容 oid 不变的 M 不解析(没有任何字段可能变化)。
 */
export function collectAtomChanges(
  git: GuardGit,
  changes: readonly Change[],
): { atoms: AtomChange[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const atoms: AtomChange[] = [];
  for (const c of changes) {
    if (!isAtomPath(c.path) || isUnsafePath(c.path)) continue;
    const hasBase = c.kind !== 'A';
    const hasHead = c.kind !== 'D';
    if (c.baseOid === c.headOid && hasBase && hasHead) {
      atoms.push({ change: c, base: undefined, head: undefined });
      continue;
    }
    atoms.push({
      change: c,
      base: hasBase ? readView(git, c.path, '基线', c.baseMode, c.baseOid, diagnostics) : undefined,
      head: hasHead ? readView(git, c.path, '头部', c.headMode, c.headOid, diagnostics) : undefined,
    });
  }
  return { atoms, diagnostics };
}
