import type { Diagnostic } from '../contracts/diagnostics.js';
import { err } from './diff.js';
import { isRegularMode, isUnderDir } from './paths.js';
import type { Change } from './types.js';

/** attest PR(kit:attest,设计 §5.2/§6.6):只允许新增 `attest/**` 普通文件,不改 status,不经过 G3。 */
export function checkAttestScope(changes: readonly Change[]): Diagnostic[] {
  return changes
    .filter((c) => !(c.kind === 'A' && isRegularMode(c.headMode) && isUnderDir(c.path, 'attest')))
    .map((c) =>
      err(
        'GUARD_ATTEST_SCOPE',
        c.path,
        `kit:attest PR 只许新增 attest/** 普通文件,此处是 ${c.kind}`,
      ),
    );
}
