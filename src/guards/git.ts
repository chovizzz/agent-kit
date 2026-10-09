import { runSync } from '../io/exec.js';
import type { IoContext } from '../io/paths.js';
import type { Change, ChangeKind, GuardGit } from './types.js';

/** git 本身不可用或命令意外失败(不是「ref 不存在」这类预期内的否定回答)。 */
export class GitError extends Error {
  readonly code = 'GUARD_GIT_FAILED';
}

const ZERO_OID = /^0+$/;
const OID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * 守卫的 git 访问层:只用只读 plumbing(rev-parse / diff-tree / cat-file / for-each-ref / merge-base),
 * 全部经 src/io/exec.ts。
 * - diff-tree 不走 textconv / 外部 diff / 重命名检测,输出 -z,路径不被引号转义;
 * - GIT_NO_REPLACE_OBJECTS=1:`refs/replace` 不得改变我们读到的内容;
 * - GIT_OPTIONAL_LOCKS=0:只读命令不去抢 index 锁。
 * 不继承 HOME;调用方(测试 harness)需要 HOME 时通过 `extraEnv` 显式给(必须在 KIT_TMP 内)。
 */
export function createGuardGit(
  ctx: IoContext,
  cwd?: string,
  extraEnv?: Readonly<Record<string, string>>,
): GuardGit {
  const env = {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_CONFIG_COUNT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    ...extraEnv,
  };
  const git = (args: readonly string[]) =>
    runSync(ctx, 'git', args, { ...(cwd !== undefined ? { cwd } : {}), env });
  const must = (args: readonly string[]): string => {
    const r = git(args);
    if (r.spawnError !== undefined || r.timedOut || r.status !== 0) {
      const why = r.spawnError ?? (r.timedOut ? '超时' : (r.stderr.split('\n')[0] ?? ''));
      throw new GitError(`git ${args.slice(0, 2).join(' ')} 失败:${why}`);
    }
    return r.stdout;
  };

  const resolveCommit = (ref: string): string | undefined => {
    // 以 `-` 开头的 ref 会被当成选项;--end-of-options 之后才是 ref
    if (ref === '' || ref.startsWith('-')) return undefined;
    const r = git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
    if (r.spawnError !== undefined) throw new GitError(`git 无法启动:${r.spawnError}`);
    if (r.timedOut) throw new GitError('git rev-parse 超时');
    if (r.status !== 0) return undefined;
    const oid = r.stdout.trim();
    return OID_RE.test(oid) ? oid : undefined;
  };

  const changes = (baseOid: string, headOid: string): Change[] => {
    const out = must([
      'diff-tree',
      '-r',
      '--raw',
      '-z',
      '--no-renames',
      '--no-abbrev',
      '--ignore-submodules=none',
      baseOid,
      headOid,
    ]);
    const parts = out.split('\0');
    const list: Change[] = [];
    for (let i = 0; i < parts.length; i++) {
      const meta = parts[i] ?? '';
      if (meta === '') continue;
      const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(meta);
      const file = parts[i + 1];
      if (m === null || file === undefined) {
        throw new GitError(`无法解析 diff-tree 输出:${JSON.stringify(meta)}`);
      }
      i++;
      list.push({
        kind: m[5] as ChangeKind,
        path: file,
        baseMode: m[1]!,
        headMode: m[2]!,
        baseOid: m[3]!,
        headOid: m[4]!,
      });
    }
    return list.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  };

  const blobText = (oid: string): string => {
    if (!OID_RE.test(oid) || ZERO_OID.test(oid)) throw new GitError(`非法 blob oid:${oid}`);
    return must(['cat-file', 'blob', oid]);
  };

  const textAt = (commitOid: string, p: string): string | undefined => {
    const spec = `${commitOid}:${p}`;
    const t = git(['cat-file', '-t', spec]);
    if (t.spawnError !== undefined) throw new GitError(`git 无法启动:${t.spawnError}`);
    if (t.timedOut) throw new GitError('git cat-file 超时');
    if (t.status !== 0 || t.stdout.trim() !== 'blob') return undefined;
    return must(['cat-file', 'blob', spec]);
  };

  const stableTagCommits = (): string[] => {
    const out = must([
      'for-each-ref',
      '--format=%(objecttype) %(objectname) %(*objecttype) %(*objectname) %(refname)',
      'refs/tags/stable-*',
    ]);
    const commits: string[] = [];
    for (const line of out.split('\n')) {
      if (line === '') continue;
      const [t1, , t2, o2, ref] = line.split(' ');
      // 只认注解 tag(objecttype=tag,剥离后是 commit);轻量 tag(自身是 commit)不算——它连创建者都不留(GD-3)
      const commit = t1 === 'tag' && t2 === 'commit' ? o2 : undefined;
      if (commit !== undefined && ref?.startsWith('refs/tags/stable-') && OID_RE.test(commit)) {
        commits.push(commit);
      }
    }
    return [...new Set(commits)].sort();
  };

  const isAncestor = (a: string, d: string): boolean => {
    const r = git(['merge-base', '--is-ancestor', a, d]);
    if (r.spawnError !== undefined) throw new GitError(`git 无法启动:${r.spawnError}`);
    if (r.status === 0) return true;
    if (r.status === 1) return false;
    throw new GitError(`git merge-base 失败:${r.stderr.split('\n')[0] ?? ''}`);
  };

  return { resolveCommit, changes, blobText, textAt, stableTagCommits, isAncestor };
}
