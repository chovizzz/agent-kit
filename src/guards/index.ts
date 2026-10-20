import { sortDiagnostics, type Diagnostic } from '../contracts/diagnostics.js';
import { checkAttestScope } from './attest.js';
import { collectAtomChanges, unsafePathDiagnostics } from './diff.js';
import { checkG1 } from './g1.js';
import { checkG2 } from './g2.js';
import { checkG3 } from './g3.js';
import { checkG4 } from './g4.js';
import { checkReflectorPaths, checkUnlabeledProposalDeletes } from './path-guard.js';
import type { GuardOptions, GuardResult } from './types.js';

export { createGuardGit, GitError } from './git.js';
export { parseLabel, pendingCriteria, GUARD_LABELS } from './labels.js';
export { lifecycleCriteria, normalizedRuleSha256 } from './criteria.js';
export type * from './types.js';

export class RefError extends Error {
  readonly code = 'GUARD_REF_UNRESOLVED';
}

/**
 * 对 base..head 做机械比较。哪些守卫生效由 `label` 决定(P0 本地模拟 PR 标签):
 *  - 无标签(内容 PR):G1 + G2 + G4 + 提案不可删(GUARD_PROPOSAL_DELETED_UNLABELED,K6)
 *  - kit:promotion / kit:retire:G3(+ G4)
 *  - kit:attest:仅允许新增 attest/**(+ G4)
 *  - kit:reflector:路径守卫 + G1 + G2 + G4(设计 §6.4)
 * 比较的是 base 与 head 两棵树本身(不取 merge-base):CI 若要 PR 语义,自行传 merge-base 作 base。
 * ref 解析不了抛 RefError;git 异常抛 GitError;诊断里的 error 非空 = 守卫判红。
 */
export function runGuards(opts: GuardOptions): GuardResult {
  const { git, label } = opts;
  const baseOid = git.resolveCommit(opts.base);
  if (baseOid === undefined)
    throw new RefError(`无法把 --base ${JSON.stringify(opts.base)} 解析成提交`);
  const headOid = git.resolveCommit(opts.head);
  if (headOid === undefined)
    throw new RefError(`无法把 --head ${JSON.stringify(opts.head)} 解析成提交`);

  const changes = git.changes(baseOid, headOid);
  const collected = collectAtomChanges(git, changes);
  const diagnostics: Diagnostic[] = [...unsafePathDiagnostics(changes), ...collected.diagnostics];
  const { atoms } = collected;

  if (label === 'kit:promotion' || label === 'kit:retire') {
    diagnostics.push(...checkG3(label, changes, atoms, opts.criteria, { git, baseOid, headOid }));
  } else if (label === 'kit:attest') {
    diagnostics.push(...checkAttestScope(changes));
  } else {
    if (label === 'kit:reflector') diagnostics.push(...checkReflectorPaths(changes));
    else diagnostics.push(...checkUnlabeledProposalDeletes(changes));
    diagnostics.push(...checkG1(atoms), ...checkG2(atoms));
  }
  diagnostics.push(...checkG4(git, baseOid, atoms));

  // 去重(同一 code+path+message 只留一条),确定性排序
  const seen = new Set<string>();
  const uniq = diagnostics.filter((d) => {
    const k = `${d.code}\0${d.path}\0${d.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { diagnostics: sortDiagnostics(uniq), baseOid, headOid, changed: changes.length };
}
