/**
 * §21 V1 W2 必杀变异(契约 R21-3.4 / 3.5 / 3.6 / 3.6a、§21.24 W0-5 / W0-9 / W0-11;规划稿 W2 验收点名的变异全部在表内,外加每条新不变量一个变异锚点)。
 * 执行方式同 W0 / A3 / A4 / A5 / A6:验证机私有检出里 cp 备份 → 按锚点替换(每个锚点在对应文件里**恰好出现一次**)→ 跑 `tests` →
 * 失败集合非空、全部命中 `expectRed`、`mustKill` 每项至少命中一个、没有 skipped → cp 还原并逐文件 sha256 核对。**不用 git checkout / stash 还原**。
 * **变异执行只在验证机私有检出里跑,测试一律用假 HOME(KIT_TMP 之内);`repo-closed-git.test.ts` 另在 afterAll 断言真实 HOME 顶层条目名单前后一致。**
 * 本文件只写表与每条变异期望红的测试名(`expectRed` 是杀手测试源码里的字面子串;参数化用例取 `%s` 之外的固定片段);变异由主代理执行,结果记进 `V1_W2_RESULTS`(W2 实装块不执行变异,故留空)。
 * 不改 `v1-w0-mutation-table.ts`。
 */
export interface Edit {
  file: string;
  anchor: string;
  replacement: string;
}

export interface V1W2Mutation {
  id: string;
  /** 契约 / 规划稿里的变异点原文(或该不变量) */
  clause: string;
  edits: readonly Edit[];
  /** 相对 `test/` */
  tests: readonly string[];
  expectRed: readonly string[];
  mustKill: readonly string[];
}

export interface V1W2Result {
  id: string;
  failed: number;
  skipped: number;
  killedBy: readonly string[];
  restored: boolean;
}

const P = 'src/rsi/personal/';
const CHECK = `${P}repo-check.ts`;
const JOURNAL = `${P}commit-journal.ts`;
const COMMIT = `${P}commit.ts`;
const LOCKSRC = `${P}personal-lock.ts`;
const STATE = `${P}home-state.ts`;

const CLOSED = 'rsi/personal/repo-closed-git.test.ts';
const STRUCT = 'rsi/personal/repo-structure.test.ts';
const SITU = 'rsi/personal/repo-situations.test.ts';
const BOOT = 'rsi/personal/repo-bootstrap.test.ts';
const MATRIX = 'rsi/personal/crash-matrix.test.ts';
const CAS = 'rsi/personal/crash-cas.test.ts';
const LOCK = 'rsi/personal/repo-personal-lock.test.ts';
const HOMEST = 'rsi/personal/repo-home-state.test.ts';
const COMMITT = 'rsi/personal/repo-commit.test.ts';
const LINT = 'lint/personal-single-git-exit.test.ts';
const GITFAIL = 'rsi/personal/repo-gitfail.test.ts';

const MATRIX_CASE = '恢复后一致、不出现 personal_repo_diverged';
const WINDOW_CASE = '② 切到指向同一提交的另一分支';

/** 结构校验某一项被删掉:把 `return fail(…)` 换成空语句 */
const noop = (anchor: string): readonly Edit[] => [{ file: CHECK, anchor, replacement: 'void 0;' }];

export const V1_W2_MUTATIONS: readonly V1W2Mutation[] = [
  // ---- R21-3.6 封闭 git 配置:规划稿点名的四个变异 ----
  {
    id: 'hookspath-override-removed',
    clause: 'R21-3.6 变异:去掉 core.hooksPath 覆盖',
    edits: [
      { file: CHECK, anchor: '`core.hooksPath=${emptyDir}`,', replacement: "'core.abbrev=auto'," },
    ],
    tests: [CLOSED],
    expectRed: ['仓库自带的 .git/hooks 钩子不执行'],
    mustKill: ['仓库自带的 .git/hooks 钩子不执行'],
  },
  {
    id: 'global-config-leaks',
    clause:
      'R21-3.6:全局配置(用户 ~/.gitconfig)进入封闭环境(GIT_CONFIG_GLOBAL 不再指向空文件,且无 hooksPath 覆盖)→ 全局钩子执行',
    edits: [
      {
        file: CHECK,
        anchor: 'GIT_CONFIG_GLOBAL: EMPTY_CONFIG_FILE,',
        replacement: "GIT_CONFIG_GLOBAL: path.join(h.home, '.gitconfig'),",
      },
      { file: CHECK, anchor: '`core.hooksPath=${emptyDir}`,', replacement: "'core.abbrev=auto'," },
    ],
    tests: [CLOSED],
    expectRed: [
      '用户全局钩子(~/.gitconfig 的 core.hooksPath)不执行',
      '仓库自带的 .git/hooks 钩子不执行',
    ],
    mustKill: ['用户全局钩子(~/.gitconfig 的 core.hooksPath)不执行'],
  },
  {
    id: 'local-filter-allowed',
    clause: 'R21-3.6 变异:放行本地 filter.*',
    edits: [
      {
        file: CHECK,
        anchor: 'if (!PERSONAL_CONFIG_WHITELIST.includes(k)) return',
        replacement:
          "if (!PERSONAL_CONFIG_WHITELIST.includes(k) && !k.startsWith('filter.')) return",
      },
    ],
    tests: [CLOSED, STRUCT],
    expectRed: ['本地过滤器 filter.*', '本地配置含非白名单键'],
    mustKill: ['本地过滤器 filter.*'],
  },
  {
    id: 'include-allowed',
    clause: 'R21-3.6 变异:放行 include.*',
    edits: [
      {
        file: CHECK,
        anchor: 'if (!PERSONAL_CONFIG_WHITELIST.includes(k)) return',
        replacement:
          "if (!PERSONAL_CONFIG_WHITELIST.includes(k) && !k.startsWith('include.')) return",
      },
    ],
    tests: [CLOSED, STRUCT],
    expectRed: ['include 链', '本地配置含非白名单键'],
    mustKill: ['include 链'],
  },
  {
    id: 'read-tree-reset',
    clause: 'R21-3.6 变异:改回 read-tree --reset(会抹掉用户未提交改动)',
    edits: [
      {
        file: JOURNAL,
        anchor: "['read-tree', '-m', '-u', oldHead, newCommit]",
        replacement: "['read-tree', '--reset', '-u', newCommit]",
      },
    ],
    tests: [CLOSED],
    expectRed: ['工作树里与目标冲突的用户未提交改动', '工作树里与目标无关的用户未提交改动'],
    mustKill: ['工作树里与目标冲突的用户未提交改动', '工作树里与目标无关的用户未提交改动'],
  },
  {
    id: 'author-from-caller',
    clause: 'R21-3.6:作者 / 提交者固定为常量身份 RSI_PERSONAL_AUTHOR(不读用户配置)',
    edits: [
      {
        file: CHECK,
        anchor: 'GIT_AUTHOR_NAME: RSI_PERSONAL_AUTHOR.name,',
        replacement: "GIT_AUTHOR_NAME: 'user',",
      },
    ],
    tests: [COMMITT, CLOSED],
    expectRed: [
      '作者与提交者是常量身份 agent-kit-rsi',
      '用户全局钩子(~/.gitconfig 的 core.hooksPath)不执行',
    ],
    mustKill: ['作者与提交者是常量身份 agent-kit-rsi'],
  },

  // ---- R21-3.4 结构校验七项:每项删掉对应检查 → 红夹具变绿 ----
  {
    id: 'struct-git-symlink-unchecked',
    clause: 'R21-3.4 ①:.git 不得是符号链接',
    edits: noop("return fail('git_symlink');"),
    tests: [STRUCT],
    expectRed: ['① .git 是符号链接'],
    mustKill: ['① .git 是符号链接'],
  },
  {
    id: 'struct-bare-unchecked',
    clause: 'R21-3.4 ①:非裸仓库',
    edits: noop("return fail('bare');"),
    tests: [STRUCT],
    expectRed: ['① 裸仓库'],
    mustKill: ['① 裸仓库'],
  },
  {
    id: 'struct-alternates-unchecked',
    clause: 'R21-3.4 ②:无 objects/info/alternates',
    edits: noop("return fail('alternates');"),
    tests: [STRUCT],
    expectRed: ['② objects/info/alternates'],
    mustKill: ['② objects/info/alternates'],
  },
  {
    id: 'struct-config-worktree-unchecked',
    clause: 'R21-3.4 ③:无 config.worktree',
    edits: noop("return fail('config_worktree');"),
    tests: [STRUCT],
    expectRed: ['③ config.worktree'],
    mustKill: ['③ config.worktree'],
  },
  {
    id: 'struct-remote-unchecked',
    clause: 'R21-3.4 ⑤:git remote 为空',
    edits: noop("return fail('remote', legacy);"),
    tests: [STRUCT],
    expectRed: ['⑤ 有 remote'],
    mustKill: ['⑤ 有 remote'],
  },
  {
    id: 'struct-mode-unchecked',
    clause: 'R21-3.4 ⑥:权限恰为 0700',
    edits: noop("return fail('mode', (repo.mode & 0o777).toString(8));"),
    tests: [STRUCT],
    expectRed: ['⑥ 目录权限不是 0700'],
    mustKill: ['⑥ 目录权限不是 0700'],
  },
  {
    id: 'struct-owner-unchecked',
    clause: 'R21-3.4 ⑥:属主为当前 uid',
    edits: noop("return fail('owner');"),
    tests: [STRUCT],
    expectRed: ['⑥ 目录属主不是当前 uid'],
    mustKill: ['⑥ 目录属主不是当前 uid'],
  },
  {
    id: 'struct-tree-gitattributes-unchecked',
    clause: 'R21-3.4 ⑦ / R21-3.1:树里不得有 .gitattributes',
    edits: noop("return fail('tree_gitattributes', file);"),
    tests: [STRUCT],
    expectRed: ['⑦ 树里有 .gitattributes'],
    mustKill: ['⑦ 树里有 .gitattributes'],
  },
  {
    id: 'struct-tree-symlink-unchecked',
    clause: 'R21-3.4 ⑦ / R21-3.1:树里不得有符号链接',
    edits: noop("return fail('tree_symlink', file);"),
    tests: [STRUCT],
    expectRed: ['⑦ 树里有符号链接'],
    mustKill: ['⑦ 树里有符号链接'],
  },
  {
    id: 'struct-tree-exec-unchecked',
    clause: 'R21-3.4 ⑦ / R21-3.1:树里不得有可执行位',
    edits: noop("return fail('tree_exec', file);"),
    tests: [STRUCT],
    expectRed: ['⑦ 树里有可执行位'],
    mustKill: ['⑦ 树里有可执行位'],
  },

  // ---- R21-3.5 四种情形与情形①的边界 ----
  {
    id: 'situ-add-only-weakened',
    clause: 'R21-3.5 ①:`记录..HEAD` 只新增文件(改 / 删自动产出 → ②)',
    edits: [{ file: CHECK, anchor: "status !== 'A' || ", replacement: '' }],
    tests: [SITU],
    expectRed: ['改了 rules/ 下的自动产出文件', '删了自动产出文件'],
    mustKill: ['改了 rules/ 下的自动产出文件', '删了自动产出文件'],
  },
  {
    id: 'situ-lifecycle-unchecked',
    clause: 'R21-3.5 ①:不触碰 lifecycle/**(改了 lifecycle/** → ②)',
    edits: [
      {
        file: CHECK,
        anchor: " || file === 'lifecycle' || file.startsWith('lifecycle/')",
        replacement: '',
      },
    ],
    tests: [SITU],
    expectRed: ['在 lifecycle/ 下新增文件'],
    mustKill: ['在 lifecycle/ 下新增文件'],
  },
  {
    id: 'situ-branch-unchecked',
    clause: 'R21-3.5 ②:分支不是 rsi(含 detached)',
    edits: [{ file: CHECK, anchor: "!== 'refs/heads/rsi') {", replacement: "=== '__never__') {" }],
    tests: [SITU],
    expectRed: ['分支不是 rsi', 'detached HEAD'],
    mustKill: ['分支不是 rsi'],
  },
  {
    id: 'situ-stash-unchecked',
    clause: 'R21-3.5 ②:有 stash',
    edits: [
      { file: CHECK, anchor: "return { situation: 2, why: 'stash' };", replacement: 'void 0;' },
    ],
    tests: [SITU],
    expectRed: ['有 stash'],
    mustKill: ['有 stash'],
  },
  {
    id: 'situ-dirty-unchecked',
    clause: 'R21-3.5 ②:工作树不干净(status --porcelain --ignored 非空)',
    edits: [{ file: CHECK, anchor: 'if (st.length !== 0)', replacement: 'if (st.length < 0)' }],
    tests: [SITU],
    expectRed: ['工作树不干净(已跟踪文件被改)', '工作树不干净(未跟踪文件)'],
    mustKill: ['工作树不干净(已跟踪文件被改)', '工作树不干净(未跟踪文件)'],
  },
  {
    id: 'situ-descendant-unchecked',
    clause: 'R21-3.5 ②:HEAD 是记录的祖先 / 历史分叉',
    edits: [
      {
        file: CHECK,
        anchor: "return { situation: 2, why: 'head_not_descendant' };",
        replacement: 'void 0;',
      },
    ],
    tests: [SITU],
    expectRed: ['HEAD 是记录的祖先', '历史分叉'],
    mustKill: ['HEAD 是记录的祖先'],
  },
  {
    id: 'situ-record-missing-unchecked',
    clause: 'R21-3.5 ③:记录提交不存在 → personal_repo_invalid',
    edits: [
      {
        file: CHECK,
        anchor: "return { situation: 3, why: 'record_missing' };",
        replacement: 'void 0;',
      },
    ],
    tests: [SITU],
    expectRed: ['记录提交不存在'],
    mustKill: ['记录提交不存在'],
  },
  {
    id: 'situ-no-common-ancestor-unchecked',
    clause: 'R21-3.5 ③:历史无共同祖先 → personal_repo_invalid',
    edits: [
      {
        file: CHECK,
        anchor: "return { situation: 3, why: 'no_common_ancestor' };",
        replacement: 'void 0;',
      },
    ],
    tests: [SITU],
    expectRed: ['历史无共同祖先'],
    mustKill: ['历史无共同祖先'],
  },
  {
    id: 'situ-owner-unchecked',
    clause: 'R21-3.5 ④:owner_repo_fp 不同 → personal_owner_changed',
    edits: [{ file: CHECK, anchor: 'return { situation: 4 };', replacement: 'void 0;' }],
    tests: [SITU, MATRIX],
    expectRed: ['owner_repo_fp 与当前 [rsi] repo 不同', '换了 [rsi] repo 再来'],
    mustKill: ['owner_repo_fp 与当前 [rsi] repo 不同'],
  },

  // ---- R21-3.6a 提交 journal 与恢复:规划稿点名的三个变异 + 其余不变量 ----
  {
    id: 'recovery-head-json-only',
    clause: 'R21-3.6a 变异:恢复时只看 head.json(不读五个观测值)',
    edits: [
      {
        file: JOURNAL,
        anchor: 'const act = decideRecovery(observeRepo(c.git, j), j);',
        replacement:
          "const hj = await readHead(c.h);\n  const act: RecoveryAction = hj.kind === 'ok' && hj.value.head === j.new_commit ? 'record' : 'discard';",
      },
    ],
    tests: [MATRIX],
    expectRed: [
      MATRIX_CASE,
      WINDOW_CASE,
      '① 改工作树文件',
      '③ detached HEAD',
      '④ 只改索引',
      '⑤ 加未跟踪文件',
    ],
    mustKill: [MATRIX_CASE, WINDOW_CASE],
  },
  {
    id: 'recovery-only-discard-continues',
    clause: 'R21-3.6a 变异:只允许一种组合继续(b:引用已更新、工作树未同步,被判 diverged)',
    edits: [
      {
        file: JOURNAL,
        anchor: "if (o.indexIsOld && clean) return 'resync';",
        replacement: '// b) 组合被禁用',
      },
    ],
    tests: [MATRIX],
    expectRed: [MATRIX_CASE, '对照:没有用户改动时同样三个窗口都能恢复'],
    mustKill: [MATRIX_CASE],
  },
  {
    id: 'recovery-record-combination-disabled',
    clause: 'R21-3.6a 变异:只允许一种组合继续(c:只差记录,被判 diverged)',
    edits: [
      {
        file: JOURNAL,
        anchor: "if (o.indexIsNew && clean) return 'record';",
        replacement: '// c) 组合被禁用',
      },
    ],
    tests: [MATRIX],
    expectRed: [MATRIX_CASE, '换了 [rsi] repo 再来', '恢复先把 journal 持久化到 recorded'],
    mustKill: [MATRIX_CASE],
  },
  {
    id: 'recovery-discard-combination-disabled',
    clause: 'R21-3.6a 变异:只允许一种组合继续(a:提交未生效,被判 diverged)',
    edits: [
      {
        file: JOURNAL,
        anchor: "if (o.ref === j.old_head && o.indexIsOld && clean) return 'discard';",
        replacement: '// a) 组合被禁用',
      },
    ],
    tests: [MATRIX],
    expectRed: [MATRIX_CASE],
    mustKill: [MATRIX_CASE],
  },
  {
    id: 'head-json-before-recorded',
    clause: 'R21-3.6a 变异:head.json 先于 recorded 写',
    edits: [
      {
        file: COMMIT,
        anchor: "await ctx.onStep?.('after:update-ref');",
        replacement:
          "await ctx.onStep?.('after:update-ref');\n  await writeHead(ctx.h, { schema_version: 1, head: commit, owner_repo_fp: ctx.ownerRepoFp });",
      },
    ],
    tests: [MATRIX],
    expectRed: [MATRIX_CASE, '恢复先把 journal 持久化到 recorded'],
    mustKill: [MATRIX_CASE],
  },
  {
    id: 'recovery-skipped-before-classification',
    clause:
      'R21-3.6a / R21-3.5 第 0 步:journal 恢复必须先于 HEAD 判定(否则 kit 自己未完成的提交被当成人工分叉)',
    edits: [
      {
        file: COMMIT,
        anchor: 'const rr = await recoverCommitJournal(c, journal);',
        replacement: "const rr = { outcome: 'discarded' as const };",
      },
    ],
    tests: [MATRIX],
    expectRed: [
      MATRIX_CASE,
      WINDOW_CASE,
      '对照:没有用户改动时同样三个窗口都能恢复',
      '换了 [rsi] repo 再来',
      '恢复先把 journal 持久化到 recorded',
    ],
    mustKill: [MATRIX_CASE],
  },
  {
    id: 'recovery-adopts-new-owner',
    clause: 'R21-3.6a:恢复发生在 R21-3.5 ④ 之前,不得借机改写 owner_repo_fp',
    edits: [
      {
        file: JOURNAL,
        anchor: "const fp = cur.kind === 'ok' ? cur.value.owner_repo_fp : c.ownerRepoFp;",
        replacement: 'const fp = c.ownerRepoFp;',
      },
    ],
    tests: [MATRIX],
    expectRed: ['换了 [rsi] repo 再来'],
    mustKill: ['换了 [rsi] repo 再来'],
  },
  {
    id: 'cas-without-expected-old',
    clause:
      'R21-3.6:update-ref 带期望旧值(原子比较交换)—— 去掉期望旧值,并发的第二个提交者会覆盖第一个',
    edits: [
      {
        file: COMMIT,
        anchor: "['update-ref', 'refs/heads/rsi', commit, oldHead]",
        replacement: "['update-ref', 'refs/heads/rsi', commit]",
      },
    ],
    tests: [CAS],
    expectRed: ['并发的第二个提交者', '引用被第三方挪走'],
    mustKill: ['并发的第二个提交者'],
  },
  {
    id: 'lock-not-rechecked-before-update-ref',
    clause: 'R20-5.5:每个提交点前 assertHeld(update-ref 之前不复核 → lock_lost 后仍写)',
    edits: [
      {
        file: COMMIT,
        anchor: 'await assertLocks(ctx); // update-ref 之前复核锁(lock_lost 时立即停止)',
        replacement: '// 不复核',
      },
    ],
    tests: [CAS],
    expectRed: ['update-ref 之前锁丢了'],
    mustKill: ['update-ref 之前锁丢了'],
  },

  // ---- W0-5 bootstrap ----
  {
    id: 'first-time-proof-weak',
    clause: 'W0-5:首次证明要求全部 ENOENT;其它 lstat 错误(ENOTDIR、不可访问)不得当成「不存在」',
    edits: [
      {
        file: STATE,
        anchor: "if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return 'not_first';",
        replacement: 'continue;',
      },
    ],
    tests: [BOOT],
    expectRed: ['lstat 报 ENOENT 以外的错误'],
    mustKill: ['lstat 报 ENOENT 以外的错误'],
  },
  {
    id: 'bootstrap-ref-mismatch-ignored',
    clause: 'W0-5:bootstrap 恢复遇到不一致的引用值 → personal_repo_invalid(保留 journal)',
    edits: [
      {
        file: JOURNAL,
        anchor: "if (revParse(c.git, 'refs/heads/rsi') !== done) return inconsistent();",
        replacement: 'void 0;',
      },
    ],
    tests: [BOOT],
    expectRed: ['committed 之后引用被改成别的值'],
    mustKill: ['committed 之后引用被改成别的值'],
  },

  // ---- R21-3.1 目标树约束 ----
  {
    id: 'tree-dot-names-allowed',
    clause: 'R21-3.1:树中任何位置不得出现 .gitattributes / .gitmodules(路径段必须以字母数字开头)',
    edits: [
      {
        file: COMMIT,
        anchor: 'const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;',
        replacement: 'const SEGMENT_RE = /^[A-Za-z0-9._-]{1,128}$/;',
      },
    ],
    tests: [COMMITT],
    expectRed: [
      '.gitmodules',
      '隐藏文件',
      '路径逃逸 ..',
      '.git 目录里',
      '试图 delete 非管理路径或畸形路径',
    ],
    mustKill: ['.gitmodules'],
  },
  {
    id: 'tree-top-level-files-allowed',
    clause: 'R21-3.1:顶层不许放文件(包括与布局目录同名的顶层文件,如 pitfalls)',
    edits: [
      {
        file: COMMIT,
        anchor: 'if (segs.length < 2) throw',
        replacement: 'if (segs.length < 1) throw',
      },
    ],
    tests: [COMMITT],
    expectRed: ['与布局目录同名的顶层文件'],
    mustKill: ['与布局目录同名的顶层文件'],
  },
  {
    id: 'tree-layout-dirs-unchecked',
    clause: 'R21-3.1:顶层目录必须在布局内',
    edits: [{ file: COMMIT, anchor: '!TOP_DIRS.has(segs[0] as string)', replacement: 'false' }],
    tests: [COMMITT],
    expectRed: ['不在布局内的顶层目录'],
    mustKill: ['不在布局内的顶层目录'],
  },
  {
    id: 'tree-duplicate-paths-allowed',
    clause: 'R21-3.1:同一路径重复必须拒绝',
    edits: [
      { file: COMMIT, anchor: "kind === 'file' && seen.src === 'upsert'", replacement: 'false' },
    ],
    tests: [COMMITT],
    expectRed: ['同一路径重复'],
    mustKill: ['同一路径重复'],
  },
  {
    id: 'tree-case-variants-allowed',
    clause:
      'R21-3.1:树按不区分大小写的命名空间校验(大小写不同的同名路径在大小写不敏感的卷上无法检出)',
    edits: [
      { file: COMMIT, anchor: 'if (seen.exact !== prefix)', replacement: 'if (false as boolean)' },
    ],
    tests: [COMMITT],
    expectRed: ['rules/A 与 rules/a:大小写不敏感的同名路径一律拒绝'],
    mustKill: ['rules/A 与 rules/a:大小写不敏感的同名路径一律拒绝'],
  },

  // ---- W0-9 revocations.jsonl ----
  {
    id: 'revocations-old-lines-dropped',
    clause: 'W0-9:revocations.jsonl 整文件原子重写,只增不删(旧行必为新文件的前缀)',
    edits: [
      {
        file: STATE,
        anchor: "const old = cur.kind === 'ok' ? cur.value.text : '';",
        replacement: "const old = '';",
      },
    ],
    tests: [HOMEST],
    expectRed: ['追加:旧行原样保留为新文件的前缀', '重写中途失败(任一 home-fs 阶段)', '超过 1 MiB'],
    mustKill: ['追加:旧行原样保留为新文件的前缀'],
  },
  {
    id: 'revocations-cap-unchecked',
    clause: 'W0-9:RSI_REVOCATIONS_MAX_BYTES = 1 MiB 上限',
    edits: [
      {
        file: STATE,
        anchor: "if (Buffer.byteLength(text, 'utf8') > RSI_REVOCATIONS_MAX_BYTES) {",
        replacement: 'if (false as boolean) {',
      },
    ],
    tests: [HOMEST],
    expectRed: ['超过 1 MiB'],
    mustKill: ['超过 1 MiB'],
  },
  {
    id: 'revocations-corrupt-overwritten',
    clause: 'W0-9 / R21-6.11 第 4a 行:现有文件损坏按读取失败处理,不覆盖(不丢凭据)',
    edits: [
      {
        file: STATE,
        anchor:
          "if (cur.kind === 'invalid') throw new PersonalStateError('revocations_invalid', cur.why);",
        replacement: 'void 0;',
      },
    ],
    tests: [HOMEST],
    expectRed: ['现有文件损坏'],
    mustKill: ['现有文件损坏'],
  },
  {
    id: 'owner-fp-ignores-inode',
    clause: 'R21-3.2:owner_repo_fp = sha256(realpath, dev, ino)(目录被换掉必须可识别)',
    edits: [{ file: STATE, anchor: '\\n${st.dev}\\n${st.ino}', replacement: '' }],
    tests: [HOMEST],
    expectRed: ['目录被换掉(inode 变)也不同'],
    mustKill: ['目录被换掉(inode 变)也不同'],
  },
  {
    id: 'empty-dir-content-ignored',
    clause: 'R21-3.6:core.hooksPath 指向的空目录必须保持为空(被塞内容 → 拒绝)',
    edits: [
      {
        file: STATE,
        anchor:
          "if ((await readDir(dir)).length !== 0) throw new PersonalStateError('empty_dir_not_empty');",
        replacement: 'void readDir;',
      },
    ],
    tests: [HOMEST],
    expectRed: ['ensureEmptyDir:建 0700 空目录'],
    mustKill: ['ensureEmptyDir:建 0700 空目录'],
  },

  // ---- personal/lock(R20-5.5 协议) ----
  {
    id: 'lock-reclaim-without-reread',
    clause: 'R20-5.5:回收前复读,逐字节相同(且同一 inode)才删',
    edits: [
      { file: LOCKSRC, anchor: 'if (!sameRead(cur, again)) continue;', replacement: 'void again;' },
    ],
    tests: [LOCK],
    expectRed: ['回收前复读'],
    mustKill: ['回收前复读'],
  },
  {
    id: 'lock-assert-held-always-true',
    clause: 'R20-5.5:assertHeld 复核 nonce(恒真则 lock_lost 无法发现)',
    edits: [
      {
        file: LOCKSRC,
        anchor: "if (cur.state !== 'ok' || cur.doc.nonce !== doc.nonce) {",
        replacement: 'if (false as boolean) {',
      },
    ],
    tests: [LOCK],
    expectRed: ['lock_lost:nonce 被换'],
    mustKill: ['lock_lost:nonce 被换'],
  },
  {
    id: 'lock-release-deletes-foreign',
    clause: 'R20-5.5:release 只在锁文件仍是自己的时才删',
    edits: [
      {
        file: LOCKSRC,
        anchor: "if (cur.state === 'ok' && cur.doc.nonce === doc.nonce) {",
        replacement: "if (cur.state === 'ok') {",
      },
    ],
    tests: [LOCK],
    expectRed: ['lock_lost:nonce 被换'],
    mustKill: ['lock_lost:nonce 被换'],
  },
  {
    id: 'lock-over-ttl-reclaimed',
    clause: 'R20-5.5:持有者存活但超 TTL 只报 locked_over_ttl,不杀、不删',
    edits: [
      {
        file: LOCKSRC,
        anchor: "throw new RsiLockError(age > RSI_LOCK_TTL_MS ? 'locked_over_ttl' : 'locked');",
        replacement: 'await remove(ctx, lockRel);\n        continue;',
      },
    ],
    tests: [LOCK],
    expectRed: [
      'locked_over_ttl:持有者存活但超过 15 分钟',
      'locked:持有者进程存活且未超 TTL',
      '回收前复读',
    ],
    mustKill: ['locked_over_ttl:持有者存活但超过 15 分钟'],
  },
  {
    id: 'lock-state-dir-unsafe-ignored',
    clause: 'R21-3.2:rsi-personal/ 必须是属主为当前用户的 0700 真实目录(不安全 → fail-closed)',
    edits: [
      {
        file: LOCKSRC,
        anchor: "if (r.kind !== 'ok') throw new RsiLockError('state_dir_unsafe');",
        replacement: 'void r;',
      },
    ],
    tests: [LOCK],
    expectRed: ['状态目录权限宽于 0700'],
    mustKill: ['状态目录权限宽于 0700'],
  },

  // ---- 评审(Pi R1)后追加的不变量 ----
  {
    id: 'recovery-record-skips-recorded-phase',
    clause: 'R21-3.6a:head.json 只在 journal 到达 recorded 后写(恢复的「只差记录」分支同样遵守)',
    edits: [
      {
        file: JOURNAL,
        anchor: "await recordHeadAndFinish(c, await writePhase(c, j, { phase: 'recorded' }));",
        replacement: "await recordHeadAndFinish(c, { ...j, phase: 'recorded' });",
      },
    ],
    tests: [MATRIX],
    expectRed: ['恢复先把 journal 持久化到 recorded'],
    mustKill: ['恢复先把 journal 持久化到 recorded'],
  },
  {
    id: 'bootstrap-structure-check-skipped',
    clause:
      'R21-3.4 先于一切:bootstrap 恢复(initialized / committed / recorded)读引用、写记录之前先做结构校验',
    edits: [
      {
        file: JOURNAL,
        anchor: "if (!repoCheck.ok) return { status: 'invalid', why: repoCheck.why };",
        replacement: 'void repoCheck;',
      },
    ],
    tests: [BOOT],
    expectRed: ['结构校验先行'],
    mustKill: ['结构校验先行'],
  },
  {
    id: 'bootstrap-observation-skipped',
    clause:
      'W0-5:任何不一致的组合 → personal_repo_invalid(保留 journal);bootstrap 恢复同样核对 HEAD / 索引 / 工作树,不只看引用值',
    edits: [
      {
        file: JOURNAL,
        anchor: 'if (!bootstrapObserved(c, commit)) return inconsistent();',
        replacement: 'void 0;',
      },
      {
        file: JOURNAL,
        anchor: 'if (!bootstrapObserved(c, done)) return inconsistent();',
        replacement: 'void 0;',
      },
    ],
    tests: [BOOT],
    expectRed: ['→ bootstrap_inconsistent,journal 保留,不记录'],
    mustKill: ['→ bootstrap_inconsistent,journal 保留,不记录'],
  },
  {
    id: 'bootstrap-update-ref-lock-unchecked',
    clause: 'R20-5.5:每个提交点前 assertHeld(bootstrap 写正式引用之前同样复核)',
    edits: [
      {
        file: JOURNAL,
        anchor: 'await assertLocks(c); // 正式引用被写之前复核锁',
        replacement: '// 不复核',
      },
    ],
    tests: [BOOT],
    expectRed: ['正式引用被写之前丢锁'],
    mustKill: ['正式引用被写之前丢锁'],
  },
  {
    id: 'index-flags-ignored-recovery',
    clause:
      'R21-3.6a:assume-unchanged / skip-worktree 会让 status 看不见改动,恢复不得据此判「干净」',
    edits: [
      {
        file: JOURNAL,
        anchor: 'indexFlagged: indexFlagged(git),',
        replacement: 'indexFlagged: false,',
      },
    ],
    tests: [MATRIX],
    expectRed: ['之后又改了文件 → diverged'],
    mustKill: ['之后又改了文件 → diverged'],
  },
  {
    id: 'index-flags-ignored-situation',
    clause: 'R21-3.5 ①:工作树干净的判定不得被索引标志蒙混',
    edits: [
      {
        file: CHECK,
        anchor: "if (indexFlagged(git)) return { situation: 2, why: 'index_flags' };",
        replacement: 'void 0;',
      },
    ],
    tests: [SITU],
    expectRed: ['索引标志(assume-unchanged)藏起了工作树改动'],
    mustKill: ['索引标志(assume-unchanged)藏起了工作树改动'],
  },

  // ---- 独立评审后追加(底稿提交、init 之前校验、info/attributes、替换对象、先锁后写、读取三态) ----
  {
    id: 'tree-whole-replacement',
    clause: 'R21-3.6:提交以已接受 HEAD 的树为底稿(整棵替换会删掉情形①接受的用户文件)',
    edits: [
      {
        file: COMMIT,
        anchor: 'const base = readBaseTree(git, oldHead);',
        replacement: 'const base: { path: string; sha: string }[] = [];',
      },
    ],
    tests: [COMMITT],
    expectRed: ['情形①接受的用户新增文件', '显式 delete 管理路径内的文件生效', '正向对照:合法路径'],
    mustKill: ['情形①接受的用户新增文件'],
  },
  {
    id: 'delete-unmanaged-allowed',
    clause: 'R21-3.6:delete 只许落在 kit 管理的命名空间内(非管理路径被改 / 删 → 拒绝提交)',
    edits: [
      {
        file: COMMIT,
        anchor: 'dsegs.length < 2 || !TOP_DIRS.has(dsegs[0] as string)',
        replacement: 'false',
      },
    ],
    tests: [COMMITT],
    expectRed: ['试图 delete 非管理路径或畸形路径'],
    mustKill: ['试图 delete 非管理路径或畸形路径'],
  },
  {
    id: 'bootstrap-preinit-gate-removed',
    clause: 'W0-5:git init 之前校验目录(链接 / 属主 / 权限 / 祖先 / 为空),不满足不 init',
    edits: [
      {
        file: JOURNAL,
        anchor: "if (bad !== null) return { status: 'invalid', why: bad };",
        replacement: 'void bad;',
      },
    ],
    tests: [BOOT],
    expectRed: [
      '目录被换成指向外部空目录的符号链接',
      '祖先目录(.local/share/agent-kit)被换成符号链接',
      '祖先 lstat 读取失败',
      '祖先是普通文件',
      '目录权限被放宽(0755)',
      '目录属主不是当前 uid',
    ],
    mustKill: ['目录被换成指向外部空目录的符号链接'],
  },
  {
    id: 'preinit-dir-symlink-unchecked',
    clause: 'W0-5:init 之前目录自身不得是符号链接',
    edits: [{ file: JOURNAL, anchor: "return 'repo_dir_symlink';", replacement: 'void 0;' }],
    tests: [BOOT],
    expectRed: ['目录被换成指向外部空目录的符号链接'],
    mustKill: ['目录被换成指向外部空目录的符号链接'],
  },
  {
    id: 'preinit-ancestor-symlink-unchecked',
    clause: 'W0-5:init 之前祖先目录不得有符号链接',
    edits: [{ file: JOURNAL, anchor: "return 'ancestor_symlink';", replacement: 'void 0;' }],
    tests: [BOOT],
    expectRed: ['祖先目录(.local/share/agent-kit)被换成符号链接'],
    mustKill: ['祖先目录(.local/share/agent-kit)被换成符号链接'],
  },
  {
    id: 'preinit-ancestor-read-failure-swallowed',
    clause: 'W0-5:init 之前祖先 lstat 读取失败 → invalid(不吞错)',
    edits: [
      {
        file: JOURNAL,
        anchor: "if (a === null) return 'ancestor_unreadable';",
        replacement: 'void 0;',
      },
    ],
    tests: [BOOT],
    expectRed: ['祖先 lstat 读取失败(上级目录不可搜索)'],
    mustKill: ['祖先 lstat 读取失败(上级目录不可搜索)'],
  },
  {
    id: 'preinit-ancestor-not-dir-unchecked',
    clause: 'W0-5:init 之前祖先必须是目录',
    edits: [
      {
        file: JOURNAL,
        anchor: "if (!a.isDirectory()) return 'ancestor_not_dir';",
        replacement: 'void 0;',
      },
    ],
    tests: [BOOT],
    expectRed: ['祖先是普通文件(不是目录)'],
    mustKill: ['祖先是普通文件(不是目录)'],
  },
  {
    id: 'preinit-mode-unchecked',
    clause: 'W0-5:init 之前目录权限恰为 0700',
    edits: [{ file: JOURNAL, anchor: "return 'mode';", replacement: 'void 0;' }],
    tests: [BOOT],
    expectRed: ['目录权限被放宽(0755)'],
    mustKill: ['目录权限被放宽(0755)'],
  },
  {
    id: 'preinit-owner-unchecked',
    clause: 'W0-5:init 之前目录属主为当前 uid',
    edits: [{ file: JOURNAL, anchor: "return 'owner';", replacement: 'void 0;' }],
    tests: [BOOT],
    expectRed: ['目录属主不是当前 uid'],
    mustKill: ['目录属主不是当前 uid'],
  },
  {
    id: 'struct-info-attributes-unchecked',
    clause: 'R21-3.4 补充:.git/info/attributes 存在(任何形态)→ personal_repo_invalid',
    edits: noop("return fail('info_attributes');"),
    tests: [STRUCT],
    expectRed: ['.git/info/attributes 是符号链接(哪怕悬空)', '→ info_attributes'],
    mustKill: ['.git/info/attributes 是符号链接(哪怕悬空)'],
  },
  {
    id: 'struct-grafts-unchecked',
    clause: 'R21-3.4 补充:.git/info/grafts 存在 → personal_repo_invalid',
    edits: noop("return fail('grafts');"),
    tests: [STRUCT],
    expectRed: ['.git/info/grafts → grafts'],
    mustKill: ['.git/info/grafts → grafts'],
  },
  {
    id: 'struct-shallow-unchecked',
    clause: 'R21-3.4 补充:.git/shallow 存在 → personal_repo_invalid',
    edits: noop("return fail('shallow');"),
    tests: [STRUCT],
    expectRed: ['.git/shallow → shallow'],
    mustKill: ['.git/shallow → shallow'],
  },
  {
    id: 'struct-replace-refs-unchecked',
    clause: 'R21-3.4 补充:refs/replace/* 存在 → personal_repo_invalid',
    edits: noop("return fail('replace_refs');"),
    tests: [STRUCT],
    expectRed: ['refs/replace/* 存在 → replace_refs'],
    mustKill: ['refs/replace/* 存在 → replace_refs'],
  },
  {
    id: 'no-replace-objects-env-removed',
    clause: 'R21-3.6 补充:封闭 git 调用设 GIT_NO_REPLACE_OBJECTS=1',
    edits: [{ file: CHECK, anchor: "GIT_NO_REPLACE_OBJECTS: '1',", replacement: '// 不设置' }],
    tests: [CLOSED],
    expectRed: ['封闭执行不读替换对象'],
    mustKill: ['封闭执行不读替换对象'],
  },
  {
    id: 'lock-checked-after-init-writes',
    clause: 'R20-5.5:先复核锁,再做任何写入初始化(丢锁 → 不创建任何目录)',
    edits: [
      {
        file: COMMIT,
        anchor:
          'await assertLockHandles(locks); // 先复核锁,再做任何写入初始化(丢锁 → 不创建任何目录)',
        replacement: '// 不复核',
      },
    ],
    tests: [BOOT],
    expectRed: ['锁已丢 → 抛 lock_lost,没有创建任何目录'],
    mustKill: ['锁已丢 → 抛 lock_lost,没有创建任何目录'],
  },
  {
    id: 'git-read-failure-as-absent',
    clause: '读取失败 ≠ 不存在:revParse / gitOut 三态,读取失败抛错',
    edits: [
      {
        file: CHECK,
        anchor: "throw new PersonalGitError(args[0] ?? 'git', r);",
        replacement: 'return null;',
      },
    ],
    tests: [GITFAIL],
    expectRed: ['git 启动失败(PATH 里没有 git)'],
    mustKill: ['git 启动失败(PATH 里没有 git)'],
  },

  // ---- 单一 git 出口(W0-11):源码里多出一个 runSync 引用 → 红 ----
  {
    id: 'runsync-in-home-state',
    clause: 'W0-11:除三个授权文件外,src/rsi/** 里任何文件 import runSync → lint 红',
    edits: [
      {
        file: STATE,
        anchor: "import type { IoContext } from '../../io/paths.js';",
        replacement:
          "import type { IoContext } from '../../io/paths.js';\nimport { runSync } from '../../io/exec.js';\nexport const leakedGitExit = runSync;",
      },
    ],
    tests: [LINT],
    expectRed: ['能拿到 runSync 的文件', 'W2 的源码与测试在真实配置下 lint 全绿'],
    mustKill: ['能拿到 runSync 的文件', 'W2 的源码与测试在真实配置下 lint 全绿'],
  },
  {
    id: 'runsync-in-personal-lock',
    clause: 'W0-11:personal-lock.ts 不是 git 出口,不得 import runSync',
    edits: [
      {
        file: LOCKSRC,
        anchor: "import { statDirSafe } from '../../io/read-fs.js';",
        replacement:
          "import { statDirSafe } from '../../io/read-fs.js';\nimport * as leakedExec from '../../io/exec.js';\nexport const leakedGitExit = leakedExec;",
      },
    ],
    tests: [LINT],
    expectRed: ['能拿到 runSync 的文件', 'W2 的源码与测试在真实配置下 lint 全绿'],
    mustKill: ['能拿到 runSync 的文件'],
  },
];

/** 实测结果(主代理在验证机上执行变异后填写;W2 实装块不执行,故留空) */
export const V1_W2_RESULTS: readonly V1W2Result[] = [];
