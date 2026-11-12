/**
 * 第三段的真实适配器:私有仓库移除(docs/contracts.md R21-9.1 第三段、§21.24 W0-15)。读 / 写都经 W2 的 `readPersonalFiles` / `commitPersonal`
 * (私有仓库的 git 出口只在 W2 的授权文件里,本文件不碰 git)。
 *
 * - 目标树 = 已接受 HEAD 底稿 + **显式 delete**(只限 `rec.target_paths`,且必须落在 kit 管理命名空间内、不得是 `lifecycle/`):
 *   用户在管理命名空间外或同目录下新增的文件原样保留;`lifecycle/<id>.json` 保留(权威记录由转移引擎推进)。
 * - 已不存在 = `already`(崩溃重做幂等:判据「目标路径都不在 HEAD 里」每次都从盘上重算,不信 journal)。
 * - `cas_failed`(并发提交者)不是干净失败:抛错、journal 留着,由下一次续做重来。
 * - `ownerRepoFp`:缩减入口(`rsi auto clear`)在 `[rsi]` 关闭时拿不到当前 `[rsi] repo` 的指纹,用 `head.json` 记录的那个({@link recordedOwnerFp}),
 *   所以 clear **不会**因 `[rsi] repo` 换了而被判 `personal_owner_changed`;R21-3.5 的分叉判定(情形②)照常生效(见汇报「问题」)。
 */
import { createHash } from 'node:crypto';
import {
  commitPersonal,
  KIT_MANAGED_TOP_DIRS,
  readPersonalFiles,
  TreeSpecError,
  type PersonalLocks,
  type PersonalRepoDeps,
} from './commit.js';
import { readHead, type PersonalHome } from './home-state.js';
import { txnId } from './ids.js';
import type { RepoRemoval, RepoRemovalResult } from './rollback-ports.js';

export async function recordedOwnerFp(h: PersonalHome): Promise<string | null> {
  const r = await readHead(h);
  return r.kind === 'ok' ? r.value.owner_repo_fp : null;
}

const topOf = (p: string): string => p.split('/')[0] ?? '';

export function personalRepoRemoval(deps: PersonalRepoDeps, locks: PersonalLocks): RepoRemoval {
  return {
    async remove(c, kind): Promise<RepoRemovalResult> {
      for (const p of c.target_paths) {
        const top = topOf(p);
        if (top === 'lifecycle' || !KIT_MANAGED_TOP_DIRS.includes(top)) {
          throw new TreeSpecError(`target_path 不在可删除的管理命名空间内:${p}`);
        }
      }
      const dirs = [...new Set(c.target_paths.map(topOf))];
      const r = await readPersonalFiles(deps, locks, dirs);
      if (r.status === 'absent') return { status: 'absent' };
      if (r.status === 'deferred') return { status: 'deferred', why: r.why };
      if (r.status === 'invalid') return { status: 'invalid', why: r.why };
      const have = new Set(r.files.map((f) => f.path));
      const present = c.target_paths.filter((p) => have.has(p)).sort();
      if (present.length === 0) return { status: 'already' };
      const digest = createHash('sha256').update(JSON.stringify(present)).digest('hex');
      const res = await commitPersonal(deps, locks, {
        kind,
        txnId: txnId(kind, [c.id], r.head, digest),
        candidateIds: [c.id],
        upserts: [],
        deletes: present,
      });
      switch (res.status) {
        case 'committed':
          return { status: 'committed' };
        case 'absent':
          return { status: 'absent' };
        case 'deferred':
          return { status: 'deferred', why: res.why };
        case 'invalid':
          return { status: 'invalid', why: res.why };
        case 'cas_failed':
          throw new Error('personal repo commit: cas_failed');
      }
    },
  };
}
