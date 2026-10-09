import type { Diagnostic } from '../contracts/diagnostics.js';
import { err } from './diff.js';
import type { AtomChange, GuardGit } from './types.js';
import { statusOf, viewAtom } from './view.js';

/**
 * G4(设计 §5.2):删除原子文件的前提是它的 `status=retired` 已经在至少一个 stable tag 里存在过。
 * P0 的 stable tag = 本地**注解** tag,名字以 `stable-` 开头(区分大小写)。判定三条同时成立:
 *  1. 基线版本的 status 是 retired(删除本身不能顺带「退役」);
 *  2. 存在某个 stable tag,其提交是基线的**严格**祖先(指向基线本身的不算)——PR 自己造的 tag/提交不算;
 *  3. 该 tag 的同一路径文件 status 就是 retired。
 * 🔴 已知缺口(P0 只是结构模拟):没有签名/创建者校验——任何能在本地打注解 tag 的人,都能在基线的任一祖先
 * (退役提交之后、基线之前)上补一个 `stable-*` tag 满足本条。P1 CI 必须改用服务端受保护 tag 或 verify-tag 验签,
 * 不得信任仓库内可写的 tag。
 * 基线版本无法解析 → 不放行(收集阶段已报 UNPARSEABLE)。重命名 = 删除 + 新增,所以改名同样要过 G4。
 */
export function checkG4(
  git: GuardGit,
  baseOid: string,
  atoms: readonly AtomChange[],
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const deleted = atoms.filter((a) => a.change.kind === 'D');
  if (deleted.length === 0) return out;
  // 严格祖先:tag 指向基线提交本身的不算(在基线上现打一个 tag 就能满足『出现过』,GD-3)
  const tags = git.stableTagCommits().filter((t) => t !== baseOid && git.isAncestor(t, baseOid));
  for (const a of deleted) {
    const p = a.change.path;
    if (a.base === undefined || !a.base.ok) continue;
    if (statusOf(a.base) !== 'retired') {
      out.push(
        err(
          'GUARD_G4_DELETE_NOT_RETIRED',
          p,
          `只能删除 status=retired 的原子,基线版本的 status 是 ${JSON.stringify(statusOf(a.base))}`,
        ),
      );
      continue;
    }
    const seen = tags.some((t) => {
      const text = git.textAt(t, p);
      return text !== undefined && statusOf(viewAtom(text, p)) === 'retired';
    });
    if (!seen) {
      out.push(
        err(
          'GUARD_G4_NOT_IN_STABLE_TAG',
          p,
          '该原子的 retired 状态尚未出现在任何(基线祖先上的)stable-* tag 里,不能删除文件',
        ),
      );
    }
  }
  return out;
}
