import type { Diagnostic } from '../contracts/diagnostics.js';
import { fileStem } from '../atoms/parse.js';
import { err } from './diff.js';
import { ALLOWED_TRANSITIONS, pendingCriteria } from './labels.js';
import { isRegularMode, isUnderDir } from './paths.js';
import type { AtomChange, Change, CriteriaChecker, G3Env, GuardLabel } from './types.js';
import { changedKeys, statusOf } from './view.js';

/** 状态变更 PR 里允许被改动的 frontmatter 字段。 */
export const G3_MUTABLE_FIELDS: readonly string[] = ['status', 'review_by'];
/** 状态变更 PR 里允许**新增**(不许改、不许删)的目录。 */
export const G3_ADD_ONLY_DIRS: readonly string[] = ['attest', 'reports', 'lifecycle'];

/**
 * G3(设计 §5.2,P0 本地版 = 结构性检查):晋升 PR(kit:promotion)与退役 PR(kit:retire)。
 *
 * 改动白名单:
 *  - 已存在原子的 `status`、`review_by` 两个字段(正文、其它字段、文件 mode 都不许动);
 *  - 新增 `attest/**`、`reports/**` 下的普通文件(只增不改:改、删、符号链接都不行);
 *  - 其余任何改动(新增/删除原子、改别的文件)一律失败。
 * 方向白名单:晋升只许 proposed→advisory、advisory→active;
 * 退役只许 advisory→deprecated(回滚)、active→deprecated、deprecated→retired、proposed→retired(被否决的提案,③A)。
 * 方向与标签不符即失败。`lifecycle/**`(退役审计记录)只在 kit:retire PR 里可新增。
 * 额外(比设计更窄):`review_by` 只许跟随 status 转移一起改——单独延长 review_by 等于绕开到期退役。
 * 判据(attest/reports/lifecycle/judge 校验)由 `criteria` 承担(真判据 = lifecycleCriteria);缺省 pendingCriteria = 一律不通过,绝不静默放行。
 */
export function checkG3(
  label: Extract<GuardLabel, 'kit:promotion' | 'kit:retire'>,
  changes: readonly Change[],
  atoms: readonly AtomChange[],
  criteria: CriteriaChecker = pendingCriteria,
  env: G3Env,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const atomByPath = new Map(atoms.map((a) => [a.change.path, a]));
  const allowed = ALLOWED_TRANSITIONS[label];

  for (const c of changes) {
    const a = atomByPath.get(c.path);
    if (a === undefined) {
      const addOnly =
        c.kind === 'A' &&
        isRegularMode(c.headMode) &&
        G3_ADD_ONLY_DIRS.some(
          (d) => isUnderDir(c.path, d) && (d !== 'lifecycle' || label === 'kit:retire'),
        );
      if (!addOnly) {
        out.push(
          err(
            'GUARD_G3_FORBIDDEN_CHANGE',
            c.path,
            `${label} PR 只许改原子的 ${G3_MUTABLE_FIELDS.join('/')} 与新增 ${G3_ADD_ONLY_DIRS.map((d) => `${d}/**`).join('、')} 普通文件;` +
              `此处是 ${c.kind}`,
          ),
        );
      }
      continue;
    }

    // 原子文件
    if (c.kind !== 'M') {
      out.push(
        err(
          'GUARD_G3_FORBIDDEN_CHANGE',
          c.path,
          `${label} PR 不得新增/删除/改类型原子文件(${c.kind});新增走内容 PR,删除受 G4 约束`,
        ),
      );
      continue;
    }
    if (c.baseMode !== c.headMode) {
      out.push(
        err('GUARD_G3_FORBIDDEN_CHANGE', c.path, `不得改文件 mode(${c.baseMode} → ${c.headMode})`),
      );
    }
    if (a.base === undefined || a.head === undefined) continue; // 仅 mode 变化,已在上面报告
    if (!a.base.ok || !a.head.ok) continue; // 无法解析已由收集阶段报出

    const keys = changedKeys(a.base.fm, a.head.fm);
    const illegal = keys.filter((k) => !G3_MUTABLE_FIELDS.includes(k));
    if (illegal.length > 0) {
      out.push(
        err(
          'GUARD_G3_FIELD_NOT_ALLOWED',
          c.path,
          `${label} PR 只许改 ${G3_MUTABLE_FIELDS.join('/')},实际还改了:${illegal.join(', ')}`,
        ),
      );
    }
    if (a.base.body !== a.head.body) {
      out.push(err('GUARD_G3_FIELD_NOT_ALLOWED', c.path, `${label} PR 不得改正文`));
    }

    const from = statusOf(a.base);
    const to = statusOf(a.head);
    const statusChanged = keys.includes('status');
    if (statusChanged) {
      if (
        from === undefined ||
        to === undefined ||
        !allowed.some(([f, t]) => f === from && t === to)
      ) {
        out.push(
          err(
            'GUARD_G3_DIRECTION_NOT_ALLOWED',
            c.path,
            `${label} 不允许转移 ${JSON.stringify(from)} → ${JSON.stringify(to)};` +
              `允许:${allowed.map(([f, t]) => `${f}→${t}`).join('、')}`,
          ),
        );
      } else {
        out.push(
          ...criteria({
            transition: { label, path: c.path, from, to },
            headView: (p) => env.git.textAt(env.headOid, p),
            baseView: (p) => env.git.textAt(env.baseOid, p),
            listHead: (d) => env.git.listFiles(env.headOid, d),
            listBase: (d) => env.git.listFiles(env.baseOid, d),
            git: env.git,
            baseOid: env.baseOid,
            headOid: env.headOid,
          }),
        );
      }
    } else if (keys.includes('review_by')) {
      out.push(
        err(
          'GUARD_G3_REVIEW_BY_WITHOUT_TRANSITION',
          c.path,
          'review_by 只许随 status 转移一起改(单独延期会绕开到期退役)',
        ),
      );
    }
  }

  // 孤儿 lifecycle 记录:新增的记录必须落在 lifecycle/<id>/ 下,且本 PR 里确有 id 为 <id> 的原子发生了状态转移
  // (否则可以凭空占用别人的 id 墓碑 / 伪造「已退役」的审计记录)
  if (label === 'kit:retire') {
    const transitioned = new Set<string>();
    for (const a of atoms) {
      if (a.change.kind === 'M' && a.base !== undefined && a.head !== undefined) {
        const from = statusOf(a.base);
        const to = statusOf(a.head);
        if (from !== to) transitioned.add(fileStem(a.change.path));
      }
    }
    for (const c of changes) {
      const m = /^lifecycle\/([^/]+)\/[^/]+$/.exec(c.path);
      if (
        c.kind === 'A' &&
        isUnderDir(c.path, 'lifecycle') &&
        (m === null || !transitioned.has(m[1]!))
      ) {
        out.push(
          err(
            'GUARD_G3_LIFECYCLE_ORPHAN',
            c.path,
            'lifecycle 记录必须位于 lifecycle/<rule-id>/ 下,且本 PR 里该 id 的原子确有状态转移',
          ),
        );
      }
    }
  }
  return out;
}
