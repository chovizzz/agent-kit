/**
 * 私有仓库的封闭 git 执行与只读判定(contracts §21.3 R21-3.4 结构校验、R21-3.5 HEAD 与工作树判定;§21.24 W0-11 单一 git 出口)。
 *
 * 本文件是 `src/rsi/**` 内 **三个** 允许 import `runSync` 的文件之一(另两个:`commit.ts`、`commit-journal.ts`;eslint 限域 + `test/lint`)。
 * 私有仓库的全部 git 子进程都经这里的 {@link createClosedGit}:
 *   `GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL` 指向空文件、不继承任何 `GIT_*`(runSync 不继承环境)、
 *   `-c core.hooksPath=<空目录>`、`-c core.fsmonitor=false`、`-c core.attributesFile=`、`-c protocol.allow=never`、`-c commit.gpgsign=false`,
 *   显式 `--git-dir` / `--work-tree`(不做仓库发现)。作者与提交者固定为 {@link RSI_PERSONAL_AUTHOR}(不读用户配置)。
 *   本地配置另被 R21-3.4 限为白名单、全局与系统配置被屏蔽,所以不存在可被调用的过滤器、钩子或外部程序。
 * 读判定(结构校验、情形判定)只用只读命令,并设 `GIT_OPTIONAL_LOCKS=0`(`status` 不顺手改索引)。
 */
import * as path from 'node:path';
import type { PersonalHead } from '../../contracts/rsi-personal.js';
import { runSync, type ExecResult } from '../../io/exec.js';
import { lstat, type Stats } from '../../io/read-fs.js';
import type { PersonalHome } from './home-state.js';

/** 作者 / 提交者的常量身份(R21-3.6:不含邮箱字面量,不读用户全局配置) */
export const RSI_PERSONAL_AUTHOR = Object.freeze({ name: 'agent-kit-rsi', email: '' });

/** 「空文件」:`GIT_CONFIG_GLOBAL` 指向它,全局配置读为空 */
const EMPTY_CONFIG_FILE = '/dev/null';

/** R21-3.4:仓库本地 `.git/config` 的白名单键 */
export const PERSONAL_CONFIG_WHITELIST: readonly string[] = Object.freeze([
  'core.repositoryformatversion',
  'core.filemode',
  'core.bare',
  'core.logallrefupdates',
  'core.ignorecase',
  'core.precomposeunicode',
]);

export interface GitRunOpts {
  input?: string;
  /** 只读命令:`GIT_OPTIONAL_LOCKS=0`,不让 `status` 之类顺手写索引 */
  readOnly?: boolean;
}

export interface ClosedGit {
  /** 在封闭配置下跑一条 git 命令(私有仓库;显式 `--git-dir` / `--work-tree`) */
  run(args: readonly string[], opts?: GitRunOpts): ExecResult;
  /** 建仓:`git init -b rsi`,`init.templateDir` 指向空目录(W0-5) */
  init(): ExecResult;
  readonly gitDir: string;
}

/**
 * @param emptyDir 空目录(`core.hooksPath` / `init.templateDir` 的值);调用方保证存在且为空(`ensureEmptyDir`)
 * @param now 提交时间(缺省系统时钟);测试可注入
 */
export function createClosedGit(
  h: PersonalHome,
  emptyDir: string,
  now: () => Date = () => new Date(),
): ClosedGit {
  const gitDir = path.join(h.repoDir, '.git');
  const baseEnv = (readOnly: boolean): Record<string, string> => {
    const date = `${Math.floor(now().getTime() / 1000)} +0000`;
    return {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: EMPTY_CONFIG_FILE,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: RSI_PERSONAL_AUTHOR.name,
      GIT_AUTHOR_EMAIL: RSI_PERSONAL_AUTHOR.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: RSI_PERSONAL_AUTHOR.name,
      GIT_COMMITTER_EMAIL: RSI_PERSONAL_AUTHOR.email,
      GIT_COMMITTER_DATE: date,
      LC_ALL: 'C',
      ...(readOnly ? { GIT_OPTIONAL_LOCKS: '0' } : {}),
    };
  };
  const closedConfig = [
    '-c',
    `core.hooksPath=${emptyDir}`,
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.attributesFile=',
    '-c',
    'protocol.allow=never',
    '-c',
    'commit.gpgsign=false',
    // 不让提交 / 合并顺手 detach 后台维护(会在 .git/objects 下短暂建删文件,干扰并发的结构校验)
    '-c',
    'gc.auto=0',
    '-c',
    'maintenance.auto=false',
  ];
  return {
    gitDir,
    run: (args, opts = {}) =>
      runSync(
        h.io,
        'git',
        ['--git-dir', gitDir, '--work-tree', h.repoDir, ...closedConfig, ...args],
        {
          cwd: h.repoDir,
          env: baseEnv(opts.readOnly === true),
          ...(opts.input !== undefined ? { input: opts.input } : {}),
        },
      ),
    init: () =>
      runSync(
        h.io,
        'git',
        [...closedConfig, '-c', `init.templateDir=${emptyDir}`, 'init', '-q', '-b', 'rsi', h.repoDir],
        { cwd: h.repoDir, env: baseEnv(false) },
      ),
  };
}

/** 成功(退出码 0)时返回去掉末尾换行的 stdout,否则 null */
export function gitOut(git: ClosedGit, args: readonly string[], opts?: GitRunOpts): string | null {
  const r = git.run(args, opts);
  return r.status === 0 ? r.stdout.replace(/\n$/, '') : null;
}

/** `rev-parse --verify -q <spec>`:存在则返回 40 位十六进制,否则 null */
export function revParse(git: ClosedGit, spec: string): string | null {
  const out = gitOut(git, ['rev-parse', '--verify', '-q', spec], { readOnly: true });
  return out !== null && /^[0-9a-f]{40}$/.test(out) ? out : null;
}

export class PersonalGitError extends Error {
  readonly code = 'RSI_PERSONAL_GIT';
  constructor(
    readonly step: string,
    r: ExecResult,
  ) {
    super(
      `git ${step} 失败(status=${r.status}${r.timedOut ? ', timeout' : ''}${r.spawnError ? `, ${r.spawnError}` : ''})`,
    );
  }
}

/** 必须成功的命令;失败抛 {@link PersonalGitError} */
export function gitMust(git: ClosedGit, step: string, args: readonly string[], opts?: GitRunOpts): string {
  const r = git.run(args, opts);
  if (r.status !== 0) throw new PersonalGitError(step, r);
  return r.stdout.replace(/\n$/, '');
}

// ---------------------------------------------------------------------------
// R21-3.4 结构校验
// ---------------------------------------------------------------------------

export type RepoInvalidWhy =
  | 'repo_missing'
  | 'repo_dir_symlink'
  | 'repo_dir_not_directory'
  | 'owner'
  | 'mode'
  | 'git_missing'
  | 'git_symlink'
  | 'git_not_directory'
  | 'worktree_link'
  | 'bare'
  | 'alternates'
  | 'config_worktree'
  | 'config_unreadable'
  | 'config_key'
  | 'remote'
  | 'tree_unreadable'
  | 'tree_gitattributes'
  | 'tree_gitmodules'
  | 'tree_symlink'
  | 'tree_gitlink'
  | 'tree_exec'
  | 'tree_mode';

export type StructureResult = { ok: true } | { ok: false; why: RepoInvalidWhy; detail?: string };

const fail = (why: RepoInvalidWhy, detail?: string): StructureResult => ({
  ok: false,
  why,
  ...(detail !== undefined ? { detail } : {}),
});

/** lstat:存在返回 Stats;ENOENT → null;其它错误 → 抛(调用方按「不可访问」处理) */
async function lstatMaybe(p: string): Promise<Stats | null> {
  try {
    return await lstat(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export interface StructureDeps {
  /** 当前 uid(缺省 `process.getuid()`;平台没有 getuid 时不校验属主) */
  uid?: number;
}

/** R21-3.4:每次操作前先做;任一不满足 → `personal_repo_invalid`(熔断)。`git` 只用只读命令。 */
export async function checkRepoStructure(
  h: PersonalHome,
  git: ClosedGit,
  deps: StructureDeps = {},
): Promise<StructureResult> {
  try {
    return await checkStructureInner(h, git, deps);
  } catch {
    // lstat 报 ENOENT 之外的错误(不可访问等):不是我们能确认的合格仓库
    return fail('repo_missing', 'lstat 失败');
  }
}

async function checkStructureInner(
  h: PersonalHome,
  git: ClosedGit,
  deps: StructureDeps,
): Promise<StructureResult> {
  const repo = await lstatMaybe(h.repoDir);
  if (repo === null) return fail('repo_missing');
  if (repo.isSymbolicLink()) return fail('repo_dir_symlink');
  if (!repo.isDirectory()) return fail('repo_dir_not_directory');
  const uid = deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  if (uid !== undefined && repo.uid !== uid) return fail('owner');
  if ((repo.mode & 0o777) !== 0o700) return fail('mode', (repo.mode & 0o777).toString(8));

  const dotGit = await lstatMaybe(git.gitDir);
  if (dotGit === null) return fail('git_missing');
  if (dotGit.isSymbolicLink()) return fail('git_symlink');
  if (!dotGit.isDirectory()) return fail('git_not_directory'); // gitdir 文件(worktree / submodule 链接)
  for (const linked of ['commondir', 'gitdir']) {
    if ((await lstatMaybe(path.join(git.gitDir, linked))) !== null) return fail('worktree_link');
  }
  if ((await lstatMaybe(path.join(git.gitDir, 'objects', 'info', 'alternates'))) !== null) {
    return fail('alternates');
  }
  if ((await lstatMaybe(path.join(git.gitDir, 'config.worktree'))) !== null) {
    return fail('config_worktree');
  }

  // 本地配置:只含白名单键(`--no-includes`:不跟随 include;出现 include.* 本身就是非白名单键)
  const cfg = path.join(git.gitDir, 'config');
  const keys = git.run(['config', '--file', cfg, '--no-includes', '--list', '--name-only', '-z'], {
    readOnly: true,
  });
  if (keys.status !== 0) return fail('config_unreadable');
  for (const k of keys.stdout.split('\0').filter((x) => x !== '')) {
    if (!PERSONAL_CONFIG_WHITELIST.includes(k)) return fail('config_key', k);
  }
  const bare = git.run(['config', '--file', cfg, '--no-includes', '--get', 'core.bare'], {
    readOnly: true,
  });
  if (bare.status === 0 && bare.stdout.trim() !== 'false') return fail('bare'); // 缺省(无该键)= 非裸

  const remotes = git.run(['remote'], { readOnly: true });
  if (remotes.status !== 0) return fail('config_unreadable', 'git remote');
  if (remotes.stdout.trim() !== '') return fail('remote', remotes.stdout.trim());

  return checkTree(git);
}

/** R21-3.1 禁止项:树中任何位置不得出现 `.gitattributes`、`.gitmodules`、符号链接、可执行位(以 `refs/heads/rsi` 的树为准;尚未建出分支则跳过) */
function checkTree(git: ClosedGit): StructureResult {
  if (revParse(git, 'refs/heads/rsi') === null) return { ok: true };
  const r = git.run(['ls-tree', '-r', '-z', '--full-tree', 'refs/heads/rsi'], { readOnly: true });
  if (r.status !== 0) return fail('tree_unreadable');
  for (const ent of r.stdout.split('\0').filter((x) => x !== '')) {
    const tab = ent.indexOf('\t');
    const meta = ent.slice(0, tab).split(' ');
    const mode = meta[0] ?? '';
    const file = ent.slice(tab + 1);
    for (const seg of file.split('/')) {
      const low = seg.toLowerCase();
      if (low === '.gitattributes') return fail('tree_gitattributes', file);
      if (low === '.gitmodules') return fail('tree_gitmodules', file);
    }
    if (mode === '120000') return fail('tree_symlink', file);
    if (mode === '160000') return fail('tree_gitlink', file);
    if (mode === '100755') return fail('tree_exec', file);
    if (mode !== '100644') return fail('tree_mode', `${mode} ${file}`);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// R21-3.5 HEAD 与工作树判定
// ---------------------------------------------------------------------------

export type DivergedWhy =
  | 'branch_not_rsi'
  | 'stash'
  | 'worktree_dirty'
  | 'head_not_descendant'
  | 'auto_output_changed';

export type InvalidSituationWhy =
  | 'record_missing'
  | 'head_unreadable'
  | 'no_common_ancestor';

export type RepoSituation =
  /** ①:接受;`head` 是当前 HEAD(可能已是记录之后的新提交),调用方据此更新记录 */
  | { situation: 1; head: string; record: string }
  /** ②:`personal_repo_diverged`(暂停新增生效,不熔断) */
  | { situation: 2; why: DivergedWhy }
  /** ③:`personal_repo_invalid`(熔断) */
  | { situation: 3; why: InvalidSituationWhy }
  /** ④:`personal_owner_changed`(暂停新增生效) */
  | { situation: 4 };

/** `status --porcelain --ignored` 的条目(`-z`、不做改名检测) */
export function statusEntries(git: ClosedGit): { xy: string; path: string }[] | null {
  const r = git.run(['status', '--porcelain=v1', '-z', '--ignored', '--no-renames'], {
    readOnly: true,
  });
  if (r.status !== 0) return null;
  return r.stdout
    .split('\0')
    .filter((x) => x !== '')
    .map((e) => ({ xy: e.slice(0, 2), path: e.slice(3) }));
}

/**
 * R21-3.5(结构校验已通过、journal 已处理之后):机械判定。
 * 顺序:记录不存在 / 不可读 → ③;`owner_repo_fp` 不同 → ④;再判 ①/②(含「无共同祖先」→ ③)。
 */
export async function classifyRepo(
  git: ClosedGit,
  record: PersonalHead,
  currentOwnerFp: string,
): Promise<RepoSituation> {
  if (revParse(git, `${record.head}^{commit}`) === null) return { situation: 3, why: 'record_missing' };
  if (record.owner_repo_fp !== currentOwnerFp) return { situation: 4 };
  const head = revParse(git, 'HEAD^{commit}');
  if (head === null) return { situation: 3, why: 'head_unreadable' };
  const base = git.run(['merge-base', record.head, head], { readOnly: true });
  if (base.status !== 0) return { situation: 3, why: 'no_common_ancestor' };

  // ②:分支不是 rsi(含 detached)
  if (gitOut(git, ['symbolic-ref', '-q', 'HEAD'], { readOnly: true }) !== 'refs/heads/rsi') {
    return { situation: 2, why: 'branch_not_rsi' };
  }
  if (revParse(git, 'refs/stash') !== null) return { situation: 2, why: 'stash' };
  const st = statusEntries(git);
  if (st === null) return { situation: 3, why: 'head_unreadable' };
  if (st.length !== 0) return { situation: 2, why: 'worktree_dirty' };
  // HEAD 必须是记录提交的后代(含相等):是记录的祖先(落后)或历史分叉都是 ②
  const desc = git.run(['merge-base', '--is-ancestor', record.head, head], { readOnly: true });
  if (desc.status !== 0) return { situation: 2, why: 'head_not_descendant' };
  if (head === record.head) return { situation: 1, head, record: record.head };

  // `记录..HEAD` 只许新增文件,不得触碰既有文件(包括全部 origin=auto_rsi 文件)与 lifecycle/**
  const diff = git.run(
    ['diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', record.head, head],
    { readOnly: true },
  );
  if (diff.status !== 0) return { situation: 3, why: 'head_unreadable' };
  const toks = diff.stdout.split('\0').filter((x) => x !== '');
  for (let i = 0; i + 1 < toks.length; i += 2) {
    const status = toks[i] as string;
    const file = toks[i + 1] as string;
    if (status !== 'A' || file === 'lifecycle' || file.startsWith('lifecycle/')) {
      return { situation: 2, why: 'auto_output_changed' };
    }
  }
  return { situation: 1, head, record: record.head };
}
