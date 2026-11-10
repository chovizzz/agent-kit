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
      '标记了一个提交不涉及的文件、又改了它',
      '对照:没有用户改动时同样三个窗口都能恢复',
      '换了 [rsi] repo 再来',
      '恢复先把 journal 持久化到 recorded',
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
      '.gitattributes',
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
/** 实测结果:r21w2-mutfinal2 @ claw,de8cf48,75/75 KILLED,problems=0 */
export const V1_W2_RESULTS: readonly V1W2Result[] = [
  {
    id: 'hookspath-override-removed',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R21-3.6 封闭 git 配置 R21-3.6 仓库自带的 .git/hooks 钩子不执行(core.hooksPath 被覆盖为空目录)',
    ],
    restored: true,
  },
  {
    id: 'global-config-leaks',
    failed: 2,
    skipped: 0,
    killedBy: [
      'R21-3.6 封闭 git 配置 R21-3.6 用户全局钩子(~/.gitconfig 的 core.hooksPath)不执行',
      'R21-3.6 封闭 git 配置 R21-3.6 仓库自带的 .git/hooks 钩子不执行(core.hooksPath 被覆盖为空目录)',
    ],
    restored: true,
  },
  {
    id: 'local-filter-allowed',
    failed: 2,
    skipped: 0,
    killedBy: [
      'R21-3.6 封闭 git 配置 本地过滤器 filter.*:被结构校验拒绝,clean / smudge 都不执行',
      'R21-3.4 结构校验 ④ 本地配置含非白名单键 filter.evil.clean',
    ],
    restored: true,
  },
  {
    id: 'include-allowed',
    failed: 2,
    skipped: 0,
    killedBy: [
      'R21-3.6 封闭 git 配置 include 链(include.path 指向带过滤器的文件):被结构校验拒绝,过滤器不执行',
      'R21-3.4 结构校验 ④ 本地配置含非白名单键 include.path',
    ],
    restored: true,
  },
  {
    id: 'read-tree-reset',
    failed: 2,
    skipped: 0,
    killedBy: [
      'R21-3.6 封闭 git 配置 R21-3.6 工作树里与目标冲突的用户未提交改动:git 拒绝覆盖,改动保留,按 personal_repo_diverged 处理(不是 read-tree --reset)',
      'R21-3.6 封闭 git 配置 工作树里与目标无关的用户未提交改动:两树合并保留它,提交照常完成(--reset 会抹掉它)',
    ],
    restored: true,
  },
  {
    id: 'author-from-caller',
    failed: 2,
    skipped: 0,
    killedBy: [
      'R21-3.6 封闭 git 配置 R21-3.6 用户全局钩子(~/.gitconfig 的 core.hooksPath)不执行',
      'R21-3.6 commitPersonal 作者与提交者是常量身份 agent-kit-rsi,时间取注入的时钟;提交信息含 kind 与 txn_id',
    ],
    restored: true,
  },
  {
    id: 'struct-git-symlink-unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R21-3.4 结构校验 ① .git 是符号链接',
    ],
    restored: true,
  },
  {
    id: 'struct-bare-unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R21-3.4 结构校验 ① 裸仓库(core.bare = true)',
    ],
    restored: true,
  },
  {
    id: 'struct-alternates-unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R21-3.4 结构校验 R21-3.4 ② objects/info/alternates',
    ],
    restored: true,
  },
  {
    id: 'struct-config-worktree-unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R21-3.4 结构校验 R21-3.4 ③ config.worktree',
    ],
    restored: true,
  },
  {
    id: 'struct-remote-unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R21-3.4 结构校验 R21-3.4 ⑤ 有 remote(旧式 .git/remotes/ 定义,不经 config 键)',
    ],
    restored: true,
  },
  {
    id: 'struct-mode-unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R21-3.4 结构校验 ⑥ 目录权限不是 0700',
    ],
    restored: true,
  },
  {
    id: 'struct-owner-unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R21-3.4 结构校验 ⑥ 目录属主不是当前 uid',
    ],
    restored: true,
  },
  {
    id: 'struct-tree-gitattributes-unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R21-3.4 结构校验 R21-3.4 ⑦ 树里有 .gitattributes(任意层级)',
    ],
    restored: true,
  },
  {
    id: 'struct-tree-symlink-unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R21-3.4 结构校验 ⑦ 树里有符号链接(120000)',
    ],
    restored: true,
  },
  {
    id: 'struct-tree-exec-unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R21-3.4 结构校验 ⑦ 树里有可执行位(100755)',
    ],
    restored: true,
  },
  {
    id: 'situ-add-only-weakened',
    failed: 2,
    skipped: 0,
    killedBy: [
      'R21-3.5 情形①的边界:记录..HEAD 改 / 删了自动产出,或触碰 lifecycle/** → ② 改了 rules/ 下的自动产出文件',
      'R21-3.5 情形①的边界:记录..HEAD 改 / 删了自动产出,或触碰 lifecycle/** → ② 删了自动产出文件',
    ],
    restored: true,
  },
  {
    id: 'situ-lifecycle-unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R21-3.5 情形①的边界:记录..HEAD 改 / 删了自动产出,或触碰 lifecycle/** → ② 在 lifecycle/ 下新增文件(即使只是新增也算触碰 lifecycle/**)',
    ],
    restored: true,
  },
  {
    id: 'situ-branch-unchecked',
    failed: 2,
    skipped: 0,
    killedBy: [
      'R21-3.5 情形②:personal_repo_diverged(暂停新增生效,不碰仓库) R21-3.5 分支不是 rsi',
      'R21-3.5 情形②:personal_repo_diverged(暂停新增生效,不碰仓库) detached HEAD',
    ],
    restored: true,
  },
  {
    id: 'situ-stash-unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R21-3.5 情形②:personal_repo_diverged(暂停新增生效,不碰仓库) 有 stash',
    ],
    restored: true,
  },
  {
    id: 'situ-dirty-unchecked',
    failed: 2,
    skipped: 0,
    killedBy: [
      'R21-3.5 情形②:personal_repo_diverged(暂停新增生效,不碰仓库) 工作树不干净(已跟踪文件被改)',
      'R21-3.5 情形②:personal_repo_diverged(暂停新增生效,不碰仓库) 工作树不干净(未跟踪文件)',
    ],
    restored: true,
  },
  {
    id: 'situ-descendant-unchecked',
    failed: 2,
    skipped: 0,
    killedBy: [
      'R21-3.5 情形②:personal_repo_diverged(暂停新增生效,不碰仓库) HEAD 是记录的祖先(用户把分支退回去了)',
      'R21-3.5 情形②:personal_repo_diverged(暂停新增生效,不碰仓库) 历史分叉(用户在旧提交上另起提交,记录提交不是 HEAD 的祖先)',
    ],
    restored: true,
  },
  {
    id: 'situ-record-missing-unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R21-3.5 情形③:personal_repo_invalid(熔断) R21-3.5 记录提交不存在',
    ],
    restored: true,
  },
  {
    id: 'situ-no-common-ancestor-unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R21-3.5 情形③:personal_repo_invalid(熔断) 历史无共同祖先(rsi 被指到一个无关的根提交)',
    ],
    restored: true,
  },
  {
    id: 'situ-owner-unchecked',
    failed: 2,
    skipped: 0,
    killedBy: [
      '恢复先于 R21-3.5 判定,且不借机改归属 R21-3.5 崩溃在 recorded 之后、head.json 之前,换了 [rsi] repo 再来:恢复沿用 head.json 原有的 owner_repo_fp,随后判 personal_owner_changed',
      'R21-3.5 情形④:personal_owner_changed R21-3.5 owner_repo_fp 与当前 [rsi] repo 不同:deferred,不碰仓库;相同则 ready(对照)',
    ],
    restored: true,
  },
  {
    id: 'recovery-head-json-only',
    failed: 26,
    skipped: 0,
    killedBy: [
      'R21-3.6a 崩溃矩阵:五个 phase 之间各注入一次崩溃 崩溃于 after:update-ref → 恢复后一致、不出现 personal_repo_diverged',
      'R21-3.6a 崩溃矩阵:五个 phase 之间各注入一次崩溃 崩溃于 journal:ref_updated → 恢复后一致、不出现 personal_repo_diverged',
      'R21-3.6a 崩溃矩阵:五个 phase 之间各注入一次崩溃 崩溃于 before:read-tree → 恢复后一致、不出现 personal_repo_diverged',
      'R21-3.6a 崩溃矩阵:五个 phase 之间各注入一次崩溃 崩溃于 after:read-tree → 恢复后一致、不出现 personal_repo_diverged',
      'R21-3.6a 崩溃矩阵:五个 phase 之间各注入一次崩溃 崩溃于 journal:worktree_synced → 恢复后一致、不出现 personal_repo_diverged',
      'R21-3.6a 崩溃矩阵:五个 phase 之间各注入一次崩溃 崩溃于 journal:recorded → 恢复后一致、不出现 personal_repo_diverged',
      'R21-3.6a 崩溃窗口里的用户改动:保留、diverged、journal 仍在 窗口 journal:objects_written:① 改工作树文件',
      'R21-3.6a 崩溃窗口里的用户改动:保留、diverged、journal 仍在 窗口 journal:objects_written:② 切到指向同一提交的另一分支',
      'R21-3.6a 崩溃窗口里的用户改动:保留、diverged、journal 仍在 窗口 journal:objects_written:③ detached HEAD',
      'R21-3.6a 崩溃窗口里的用户改动:保留、diverged、journal 仍在 窗口 journal:objects_written:④ 只改索引',
      'R21-3.6a 崩溃窗口里的用户改动:保留、diverged、journal 仍在 窗口 journal:objects_written:⑤ 加未跟踪文件',
      'R21-3.6a 崩溃窗口里的用户改动:保留、diverged、journal 仍在 窗口 journal:ref_updated:① 改工作树文件',
      'R21-3.6a 崩溃窗口里的用户改动:保留、diverged、journal 仍在 窗口 journal:ref_updated:② 切到指向同一提交的另一分支',
      'R21-3.6a 崩溃窗口里的用户改动:保留、diverged、journal 仍在 窗口 journal:ref_updated:③ detached HEAD',
      'R21-3.6a 崩溃窗口里的用户改动:保留、diverged、journal 仍在 窗口 journal:ref_updated:④ 只改索引',
      'R21-3.6a 崩溃窗口里的用户改动:保留、diverged、journal 仍在 窗口 journal:ref_updated:⑤ 加未跟踪文件',
      'R21-3.6a 崩溃窗口里的用户改动:保留、diverged、journal 仍在 窗口 journal:worktree_synced:① 改工作树文件',
      'R21-3.6a 崩溃窗口里的用户改动:保留、diverged、journal 仍在 窗口 journal:worktree_synced:② 切到指向同一提交的另一分支',
      'R21-3.6a 崩溃窗口里的用户改动:保留、diverged、journal 仍在 窗口 journal:worktree_synced:③ detached HEAD',
      'R21-3.6a 崩溃窗口里的用户改动:保留、diverged、journal 仍在 窗口 journal:worktree_synced:④ 只改索引',
      'R21-3.6a 崩溃窗口里的用户改动:保留、diverged、journal 仍在 窗口 journal:worktree_synced:⑤ 加未跟踪文件',
      'R21-3.6a 崩溃窗口里的用户改动:保留、diverged、journal 仍在 对照:没有用户改动时同样三个窗口都能恢复(见上一组),用户改动才是 diverged 的原因',
      '恢复先于 R21-3.5 判定,且不借机改归属 R21-3.5 崩溃在 recorded 之后、head.json 之前,换了 [rsi] repo 再来:恢复沿用 head.json 原有的 owner_repo_fp,随后判 personal_owner_changed',
      'R21-3.6a 恢复同样遵守「head.json 只在 journal 到达 recorded 后写」 R21-3.6a 崩溃在工作树同步之后(journal 仍是 ref_updated)→ 恢复先把 journal 持久化到 recorded,再写 head.json,最后删 journal',
      'R21-3.6a 索引标志(assume-unchanged / skip-worktree)让 status 看不见改动:不当成「干净」 窗口 journal:ref_updated:update-index --assume-unchanged 标记了一个提交不涉及的文件、又改了它 → diverged,改动与 journal 原样保留(之后又改了文件 → diverged)',
      'R21-3.6a 索引标志(assume-unchanged / skip-worktree)让 status 看不见改动:不当成「干净」 窗口 journal:ref_updated:update-index --skip-worktree 标记了一个提交不涉及的文件、又改了它 → diverged,改动与 journal 原样保留(之后又改了文件 → diverged)',
    ],
    restored: true,
  },
  {
    id: 'recovery-only-discard-continues',
    failed: 4,
    skipped: 0,
    killedBy: [
      'R21-3.6a 崩溃矩阵:五个 phase 之间各注入一次崩溃 崩溃于 after:update-ref → 恢复后一致、不出现 personal_repo_diverged',
      'R21-3.6a 崩溃矩阵:五个 phase 之间各注入一次崩溃 崩溃于 journal:ref_updated → 恢复后一致、不出现 personal_repo_diverged',
      'R21-3.6a 崩溃矩阵:五个 phase 之间各注入一次崩溃 崩溃于 before:read-tree → 恢复后一致、不出现 personal_repo_diverged',
      'R21-3.6a 崩溃窗口里的用户改动:保留、diverged、journal 仍在 对照:没有用户改动时同样三个窗口都能恢复(见上一组),用户改动才是 diverged 的原因',
    ],
    restored: true,
  },
  {
    id: 'recovery-record-combination-disabled',
    failed: 6,
    skipped: 0,
    killedBy: [
      'R21-3.6a 崩溃矩阵:五个 phase 之间各注入一次崩溃 崩溃于 after:read-tree → 恢复后一致、不出现 personal_repo_diverged',
      'R21-3.6a 崩溃矩阵:五个 phase 之间各注入一次崩溃 崩溃于 journal:worktree_synced → 恢复后一致、不出现 personal_repo_diverged',
      'R21-3.6a 崩溃矩阵:五个 phase 之间各注入一次崩溃 崩溃于 journal:recorded → 恢复后一致、不出现 personal_repo_diverged',
      'R21-3.6a 崩溃矩阵:五个 phase 之间各注入一次崩溃 崩溃于 after:head → 恢复后一致、不出现 personal_repo_diverged',
      '恢复先于 R21-3.5 判定,且不借机改归属 R21-3.5 崩溃在 recorded 之后、head.json 之前,换了 [rsi] repo 再来:恢复沿用 head.json 原有的 owner_repo_fp,随后判 personal_owner_changed',
      'R21-3.6a 恢复同样遵守「head.json 只在 journal 到达 recorded 后写」 R21-3.6a 崩溃在工作树同步之后(journal 仍是 ref_updated)→ 恢复先把 journal 持久化到 recorded,再写 head.json,最后删 journal',
    ],
    restored: true,
  },
  {
    id: 'recovery-discard-combination-disabled',
    failed: 3,
    skipped: 0,
    killedBy: [
      'R21-3.6a 崩溃矩阵:五个 phase 之间各注入一次崩溃 崩溃于 journal:planned → 恢复后一致、不出现 personal_repo_diverged',
      'R21-3.6a 崩溃矩阵:五个 phase 之间各注入一次崩溃 崩溃于 journal:objects_written → 恢复后一致、不出现 personal_repo_diverged',
      'R21-3.6a 崩溃矩阵:五个 phase 之间各注入一次崩溃 崩溃于 before:update-ref → 恢复后一致、不出现 personal_repo_diverged',
    ],
    restored: true,
  },
  {
    id: 'head-json-before-recorded',
    failed: 6,
    skipped: 0,
    killedBy: [
      'R21-3.6a 崩溃矩阵:五个 phase 之间各注入一次崩溃 崩溃于 journal:ref_updated → 恢复后一致、不出现 personal_repo_diverged',
      'R21-3.6a 崩溃矩阵:五个 phase 之间各注入一次崩溃 崩溃于 before:read-tree → 恢复后一致、不出现 personal_repo_diverged',
      'R21-3.6a 崩溃矩阵:五个 phase 之间各注入一次崩溃 崩溃于 after:read-tree → 恢复后一致、不出现 personal_repo_diverged',
      'R21-3.6a 崩溃矩阵:五个 phase 之间各注入一次崩溃 崩溃于 journal:worktree_synced → 恢复后一致、不出现 personal_repo_diverged',
      'R21-3.6a 崩溃矩阵:五个 phase 之间各注入一次崩溃 崩溃于 journal:recorded → 恢复后一致、不出现 personal_repo_diverged',
      'R21-3.6a 恢复同样遵守「head.json 只在 journal 到达 recorded 后写」 R21-3.6a 崩溃在工作树同步之后(journal 仍是 ref_updated)→ 恢复先把 journal 持久化到 recorded,再写 head.json,最后删 journal',
    ],
    restored: true,
  },
  {
    id: 'recovery-skipped-before-classification',
    failed: 13,
    skipped: 0,
    killedBy: [
      'R21-3.6a 崩溃矩阵:五个 phase 之间各注入一次崩溃 崩溃于 journal:planned → 恢复后一致、不出现 personal_repo_diverged',
      'R21-3.6a 崩溃矩阵:五个 phase 之间各注入一次崩溃 崩溃于 journal:objects_written → 恢复后一致、不出现 personal_repo_diverged',
      'R21-3.6a 崩溃矩阵:五个 phase 之间各注入一次崩溃 崩溃于 before:update-ref → 恢复后一致、不出现 personal_repo_diverged',
      'R21-3.6a 崩溃矩阵:五个 phase 之间各注入一次崩溃 崩溃于 after:update-ref → 恢复后一致、不出现 personal_repo_diverged',
      'R21-3.6a 崩溃矩阵:五个 phase 之间各注入一次崩溃 崩溃于 journal:ref_updated → 恢复后一致、不出现 personal_repo_diverged',
      'R21-3.6a 崩溃矩阵:五个 phase 之间各注入一次崩溃 崩溃于 before:read-tree → 恢复后一致、不出现 personal_repo_diverged',
      'R21-3.6a 崩溃矩阵:五个 phase 之间各注入一次崩溃 崩溃于 after:read-tree → 恢复后一致、不出现 personal_repo_diverged',
      'R21-3.6a 崩溃矩阵:五个 phase 之间各注入一次崩溃 崩溃于 journal:worktree_synced → 恢复后一致、不出现 personal_repo_diverged',
      'R21-3.6a 崩溃矩阵:五个 phase 之间各注入一次崩溃 崩溃于 journal:recorded → 恢复后一致、不出现 personal_repo_diverged',
      'R21-3.6a 崩溃矩阵:五个 phase 之间各注入一次崩溃 崩溃于 after:head → 恢复后一致、不出现 personal_repo_diverged',
      'R21-3.6a 崩溃窗口里的用户改动:保留、diverged、journal 仍在 对照:没有用户改动时同样三个窗口都能恢复(见上一组),用户改动才是 diverged 的原因',
      '恢复先于 R21-3.5 判定,且不借机改归属 R21-3.5 崩溃在 recorded 之后、head.json 之前,换了 [rsi] repo 再来:恢复沿用 head.json 原有的 owner_repo_fp,随后判 personal_owner_changed',
      'R21-3.6a 恢复同样遵守「head.json 只在 journal 到达 recorded 后写」 R21-3.6a 崩溃在工作树同步之后(journal 仍是 ref_updated)→ 恢复先把 journal 持久化到 recorded,再写 head.json,最后删 journal',
    ],
    restored: true,
  },
  {
    id: 'recovery-adopts-new-owner',
    failed: 1,
    skipped: 0,
    killedBy: [
      '恢复先于 R21-3.5 判定,且不借机改归属 R21-3.5 崩溃在 recorded 之后、head.json 之前,换了 [rsi] repo 再来:恢复沿用 head.json 原有的 owner_repo_fp,随后判 personal_owner_changed',
    ],
    restored: true,
  },
  {
    id: 'cas-without-expected-old',
    failed: 2,
    skipped: 0,
    killedBy: [
      'R21-3.6 update-ref 带期望旧值 R21-3.6 并发的第二个提交者(在 A 的 update-ref 之前先完成了一次提交)→ A 得到 cas_failed,B 的结果完好',
      'R21-3.6 update-ref 带期望旧值 引用被第三方挪走(不经 kit)→ A 得到 cas_failed;journal 保留,下一次恢复判 diverged,不动引用',
    ],
    restored: true,
  },
  {
    id: 'lock-not-rechecked-before-update-ref',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R20-5.5 lock_lost:提交点前复核锁,丢锁立即停止、不再写 update-ref 之前锁丢了 → 抛 lock_lost,引用 / 工作树没动;下一次恢复把未生效的提交丢弃',
    ],
    restored: true,
  },
  {
    id: 'first-time-proof-weak',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W0-5 首次建仓证明 lstat 报 ENOENT 以外的错误(rsi-personal 被一个普通文件占位 → ENOTDIR)→ 不是首次',
    ],
    restored: true,
  },
  {
    id: 'bootstrap-ref-mismatch-ignored',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W0-5 bootstrap 崩溃恢复(四个 phase 之间各注入一次) committed 之后引用被改成别的值 → personal_repo_invalid,保留 journal',
    ],
    restored: true,
  },
  {
    id: 'tree-dot-names-allowed',
    failed: 6,
    skipped: 0,
    killedBy: [
      'R21-3.6 commitPersonal 目标树约束(R21-3.1):违规一律 TreeSpecError,仓库原样 .gitattributes',
      'R21-3.6 commitPersonal 目标树约束(R21-3.1):违规一律 TreeSpecError,仓库原样 .gitmodules',
      'R21-3.6 commitPersonal 目标树约束(R21-3.1):违规一律 TreeSpecError,仓库原样 .git 目录里',
      'R21-3.6 commitPersonal 目标树约束(R21-3.1):违规一律 TreeSpecError,仓库原样 隐藏文件',
      'R21-3.6 commitPersonal 目标树约束(R21-3.1):违规一律 TreeSpecError,仓库原样 路径逃逸 ..',
      'R21-3.1 / R21-3.6 kit 管理路径:以 HEAD 树为底稿,用户文件保留,delete 只能落在管理命名空间内 试图 delete 非管理路径或畸形路径(rules/../notes/x.md)→ TreeSpecError,什么都没动',
    ],
    restored: true,
  },
  {
    id: 'tree-top-level-files-allowed',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R21-3.6 commitPersonal 目标树约束(R21-3.1):违规一律 TreeSpecError,仓库原样 与布局目录同名的顶层文件',
    ],
    restored: true,
  },
  {
    id: 'tree-layout-dirs-unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R21-3.6 commitPersonal 目标树约束(R21-3.1):违规一律 TreeSpecError,仓库原样 不在布局内的顶层目录',
    ],
    restored: true,
  },
  {
    id: 'tree-duplicate-paths-allowed',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R21-3.6 commitPersonal 目标树约束(R21-3.1):违规一律 TreeSpecError,仓库原样 同一路径重复(不区分大小写)/ 文件与目录同名 / 非法 txn_id',
    ],
    restored: true,
  },
  {
    id: 'tree-case-variants-allowed',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R21-3.6 commitPersonal 目标树约束(R21-3.1):违规一律 TreeSpecError,仓库原样 rules/A 与 rules/a:大小写不敏感的同名路径一律拒绝(大小写不敏感的卷上无法检出)',
    ],
    restored: true,
  },
  {
    id: 'revocations-old-lines-dropped',
    failed: 3,
    skipped: 0,
    killedBy: [
      'W0-9 revocations.jsonl:整文件原子重写,只增不删 追加:旧行原样保留为新文件的前缀,顺序保持',
      'W0-9 revocations.jsonl:整文件原子重写,只增不删 重写中途失败(任一 home-fs 阶段):旧版原样可读,没有残留临时文件;随后正常追加成功',
      'W0-9 revocations.jsonl:整文件原子重写,只增不删 超过 1 MiB:追加抛 revocations_too_large 且不写;文件本身 > 1 MiB 读取失败',
    ],
    restored: true,
  },
  {
    id: 'revocations-cap-unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W0-9 revocations.jsonl:整文件原子重写,只增不删 超过 1 MiB:追加抛 revocations_too_large 且不写;文件本身 > 1 MiB 读取失败',
    ],
    restored: true,
  },
  {
    id: 'revocations-corrupt-overwritten',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W0-9 revocations.jsonl:整文件原子重写,只增不删 现有文件损坏 → 追加抛 revocations_invalid,不覆盖(不丢凭据)',
    ],
    restored: true,
  },
  {
    id: 'owner-fp-ignores-inode',
    failed: 1,
    skipped: 0,
    killedBy: [
      'owner_repo_fp 与封闭配置的空目录 owner_repo_fp:16 位十六进制;同目录稳定,不同目录不同,目录被换掉(inode 变)也不同',
    ],
    restored: true,
  },
  {
    id: 'empty-dir-content-ignored',
    failed: 1,
    skipped: 0,
    killedBy: [
      'owner_repo_fp 与封闭配置的空目录 ensureEmptyDir:建 0700 空目录;里面有东西 → 抛 empty_dir_not_empty(钩子目录不能被塞内容)',
    ],
    restored: true,
  },
  {
    id: 'lock-reclaim-without-reread',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R20-5.5 协议(personal/lock) 回收前复读:判定陈旧之后锁文件被别人换掉 → 不删(逐字节相同才删)',
    ],
    restored: true,
  },
  {
    id: 'lock-assert-held-always-true',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R20-5.5 协议(personal/lock) lock_lost:nonce 被换(或锁被删)→ assertHeld 抛 lock_lost;release 不删别人的锁',
    ],
    restored: true,
  },
  {
    id: 'lock-release-deletes-foreign',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R20-5.5 协议(personal/lock) lock_lost:nonce 被换(或锁被删)→ assertHeld 抛 lock_lost;release 不删别人的锁',
    ],
    restored: true,
  },
  {
    id: 'lock-over-ttl-reclaimed',
    failed: 3,
    skipped: 0,
    killedBy: [
      'R20-5.5 协议(personal/lock) locked:持有者进程存活且未超 TTL → locked,锁文件不动',
      'R20-5.5 协议(personal/lock) locked_over_ttl:持有者存活但超过 15 分钟 → 只报 locked_over_ttl,不杀、不删',
      'R20-5.5 协议(personal/lock) 回收前复读:判定陈旧之后锁文件被别人换掉 → 不删(逐字节相同才删)',
    ],
    restored: true,
  },
  {
    id: 'lock-state-dir-unsafe-ignored',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R20-5.5 协议(personal/lock) 状态目录权限宽于 0700 → state_dir_unsafe(fail-closed,不自动收紧);目录是符号链接 → write_denied',
    ],
    restored: true,
  },
  {
    id: 'recovery-record-skips-recorded-phase',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R21-3.6a 恢复同样遵守「head.json 只在 journal 到达 recorded 后写」 R21-3.6a 崩溃在工作树同步之后(journal 仍是 ref_updated)→ 恢复先把 journal 持久化到 recorded,再写 head.json,最后删 journal',
    ],
    restored: true,
  },
  {
    id: 'bootstrap-structure-check-skipped',
    failed: 3,
    skipped: 0,
    killedBy: [
      'W0-5 bootstrap 恢复:结构校验先行、观测核对、丢锁即停 崩溃于 journal:initialized 之后仓库配置被改成不合格(本地 core.sshCommand)→ 结构校验先行:personal_repo_invalid,journal 保留,没有写 head.json',
      'W0-5 bootstrap 恢复:结构校验先行、观测核对、丢锁即停 崩溃于 journal:committed 之后仓库配置被改成不合格(本地 core.sshCommand)→ 结构校验先行:personal_repo_invalid,journal 保留,没有写 head.json',
      'W0-5 bootstrap 恢复:结构校验先行、观测核对、丢锁即停 崩溃于 journal:recorded 之后仓库配置被改成不合格(本地 core.sshCommand)→ 结构校验先行:personal_repo_invalid,journal 保留,没有写 head.json',
    ],
    restored: true,
  },
  {
    id: 'bootstrap-observation-skipped',
    failed: 8,
    skipped: 0,
    killedBy: [
      'W0-5 bootstrap 恢复:结构校验先行、观测核对、丢锁即停 崩溃于 journal:initialized 之后:切到另一个分支 → bootstrap_inconsistent,journal 保留,不记录',
      'W0-5 bootstrap 恢复:结构校验先行、观测核对、丢锁即停 崩溃于 journal:initialized 之后:detached HEAD → bootstrap_inconsistent,journal 保留,不记录',
      'W0-5 bootstrap 恢复:结构校验先行、观测核对、丢锁即停 崩溃于 journal:initialized 之后:加了未跟踪文件 → bootstrap_inconsistent,journal 保留,不记录',
      'W0-5 bootstrap 恢复:结构校验先行、观测核对、丢锁即停 崩溃于 journal:initialized 之后:只改索引 → bootstrap_inconsistent,journal 保留,不记录',
      'W0-5 bootstrap 恢复:结构校验先行、观测核对、丢锁即停 崩溃于 journal:committed 之后:切到另一个分支 → bootstrap_inconsistent,journal 保留,不记录',
      'W0-5 bootstrap 恢复:结构校验先行、观测核对、丢锁即停 崩溃于 journal:committed 之后:detached HEAD → bootstrap_inconsistent,journal 保留,不记录',
      'W0-5 bootstrap 恢复:结构校验先行、观测核对、丢锁即停 崩溃于 journal:committed 之后:加了未跟踪文件 → bootstrap_inconsistent,journal 保留,不记录',
      'W0-5 bootstrap 恢复:结构校验先行、观测核对、丢锁即停 崩溃于 journal:committed 之后:只改索引 → bootstrap_inconsistent,journal 保留,不记录',
    ],
    restored: true,
  },
  {
    id: 'bootstrap-update-ref-lock-unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W0-5 bootstrap 恢复:结构校验先行、观测核对、丢锁即停 正式引用被写之前丢锁(lock_lost)→ 立即停止:refs/heads/rsi 未被创建;之后持好锁再来可续做',
    ],
    restored: true,
  },
  {
    id: 'index-flags-ignored-recovery',
    failed: 2,
    skipped: 0,
    killedBy: [
      'R21-3.6a 索引标志(assume-unchanged / skip-worktree)让 status 看不见改动:不当成「干净」 窗口 journal:ref_updated:update-index --assume-unchanged 标记了一个提交不涉及的文件、又改了它 → diverged,改动与 journal 原样保留(之后又改了文件 → diverged)',
      'R21-3.6a 索引标志(assume-unchanged / skip-worktree)让 status 看不见改动:不当成「干净」 窗口 journal:ref_updated:update-index --skip-worktree 标记了一个提交不涉及的文件、又改了它 → diverged,改动与 journal 原样保留(之后又改了文件 → diverged)',
    ],
    restored: true,
  },
  {
    id: 'index-flags-ignored-situation',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R21-3.5 情形②:personal_repo_diverged(暂停新增生效,不碰仓库) 索引标志(assume-unchanged)藏起了工作树改动:status 为空也判 diverged',
    ],
    restored: true,
  },
  {
    id: 'tree-whole-replacement',
    failed: 3,
    skipped: 0,
    killedBy: [
      'R21-3.6 commitPersonal 目标树约束(R21-3.1):违规一律 TreeSpecError,仓库原样 正向对照:合法路径(含深层目录、点与连字符)通过,且全部是 100644',
      'R21-3.1 / R21-3.6 kit 管理路径:以 HEAD 树为底稿,用户文件保留,delete 只能落在管理命名空间内 情形①接受的用户新增文件(管理命名空间之内 rules/user.md、之外 notes/x.md)在下一次 kit 提交后原样保留(树、工作树、状态都干净)',
      'R21-3.1 / R21-3.6 kit 管理路径:以 HEAD 树为底稿,用户文件保留,delete 只能落在管理命名空间内 显式 delete 管理路径内的文件生效;删一个不存在的路径视为已删(幂等)',
    ],
    restored: true,
  },
  {
    id: 'delete-unmanaged-allowed',
    failed: 3,
    skipped: 0,
    killedBy: [
      'R21-3.1 / R21-3.6 kit 管理路径:以 HEAD 树为底稿,用户文件保留,delete 只能落在管理命名空间内 试图 delete 非管理路径或畸形路径(notes/x.md)→ TreeSpecError,什么都没动',
      'R21-3.1 / R21-3.6 kit 管理路径:以 HEAD 树为底稿,用户文件保留,delete 只能落在管理命名空间内 试图 delete 非管理路径或畸形路径(README.md)→ TreeSpecError,什么都没动',
      'R21-3.1 / R21-3.6 kit 管理路径:以 HEAD 树为底稿,用户文件保留,delete 只能落在管理命名空间内 试图 delete 非管理路径或畸形路径(rules)→ TreeSpecError,什么都没动',
    ],
    restored: true,
  },
  {
    id: 'bootstrap-preinit-gate-removed',
    failed: 6,
    skipped: 0,
    killedBy: [
      'W0-5 git init 之前的校验(planned + 目录缺失 / 为空):不满足就不 init 目录被换成指向外部空目录的符号链接 → personal_repo_invalid,外部目录里没有 .git',
      'W0-5 git init 之前的校验(planned + 目录缺失 / 为空):不满足就不 init 祖先目录(.local/share/agent-kit)被换成符号链接 → ancestor_symlink,不 init',
      'W0-5 git init 之前的校验(planned + 目录缺失 / 为空):不满足就不 init 祖先 lstat 读取失败(上级目录不可搜索)→ ancestor_unreadable,不 init',
      'W0-5 git init 之前的校验(planned + 目录缺失 / 为空):不满足就不 init 祖先是普通文件(不是目录)→ ancestor_not_dir,不 init',
      'W0-5 git init 之前的校验(planned + 目录缺失 / 为空):不满足就不 init 目录权限被放宽(0755)→ mode,不 init',
      'W0-5 git init 之前的校验(planned + 目录缺失 / 为空):不满足就不 init 目录属主不是当前 uid → owner,不 init',
    ],
    restored: true,
  },
  {
    id: 'preinit-dir-symlink-unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W0-5 git init 之前的校验(planned + 目录缺失 / 为空):不满足就不 init 目录被换成指向外部空目录的符号链接 → personal_repo_invalid,外部目录里没有 .git',
    ],
    restored: true,
  },
  {
    id: 'preinit-ancestor-symlink-unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W0-5 git init 之前的校验(planned + 目录缺失 / 为空):不满足就不 init 祖先目录(.local/share/agent-kit)被换成符号链接 → ancestor_symlink,不 init',
    ],
    restored: true,
  },
  {
    id: 'preinit-ancestor-read-failure-swallowed',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W0-5 git init 之前的校验(planned + 目录缺失 / 为空):不满足就不 init 祖先 lstat 读取失败(上级目录不可搜索)→ ancestor_unreadable,不 init',
    ],
    restored: true,
  },
  {
    id: 'preinit-ancestor-not-dir-unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W0-5 git init 之前的校验(planned + 目录缺失 / 为空):不满足就不 init 祖先是普通文件(不是目录)→ ancestor_not_dir,不 init',
    ],
    restored: true,
  },
  {
    id: 'preinit-mode-unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W0-5 git init 之前的校验(planned + 目录缺失 / 为空):不满足就不 init 目录权限被放宽(0755)→ mode,不 init',
    ],
    restored: true,
  },
  {
    id: 'preinit-owner-unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W0-5 git init 之前的校验(planned + 目录缺失 / 为空):不满足就不 init 目录属主不是当前 uid → owner,不 init',
    ],
    restored: true,
  },
  {
    id: 'struct-info-attributes-unchecked',
    failed: 3,
    skipped: 0,
    killedBy: [
      'R21-3.4 之外同样能改变 git 行为的文件:属性、嫁接、浅克隆、替换对象 .git/info/attributes(文件)→ info_attributes',
      'R21-3.4 之外同样能改变 git 行为的文件:属性、嫁接、浅克隆、替换对象 .git/info/attributes(空文件)→ info_attributes',
      'R21-3.4 之外同样能改变 git 行为的文件:属性、嫁接、浅克隆、替换对象 .git/info/attributes 是符号链接(哪怕悬空)→ info_attributes',
    ],
    restored: true,
  },
  {
    id: 'struct-grafts-unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R21-3.4 之外同样能改变 git 行为的文件:属性、嫁接、浅克隆、替换对象 .git/info/grafts → grafts',
    ],
    restored: true,
  },
  {
    id: 'struct-shallow-unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R21-3.4 之外同样能改变 git 行为的文件:属性、嫁接、浅克隆、替换对象 .git/shallow → shallow',
    ],
    restored: true,
  },
  {
    id: 'struct-replace-refs-unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R21-3.4 之外同样能改变 git 行为的文件:属性、嫁接、浅克隆、替换对象 refs/replace/* 存在 → replace_refs',
    ],
    restored: true,
  },
  {
    id: 'no-replace-objects-env-removed',
    failed: 1,
    skipped: 0,
    killedBy: [
      'R21-3.6 封闭 git 配置 R21-3.6 封闭执行不读替换对象(GIT_NO_REPLACE_OBJECTS):refs/replace 对它不生效',
    ],
    restored: true,
  },
  {
    id: 'lock-checked-after-init-writes',
    failed: 1,
    skipped: 0,
    killedBy: [
      '先复核锁,再做任何写入初始化 锁已丢 → 抛 lock_lost,没有创建任何目录(状态目录、空钩子目录、私有仓库目录)',
    ],
    restored: true,
  },
  {
    id: 'git-read-failure-as-absent',
    failed: 1,
    skipped: 0,
    killedBy: [
      'git 读取三态 git 启动失败(PATH 里没有 git)→ revParse / gitOut 抛 PersonalGitError,不当成「不存在」',
    ],
    restored: true,
  },
  {
    id: 'runsync-in-home-state',
    failed: 2,
    skipped: 0,
    killedBy: [
      '私有仓库唯一 git 出口:真实源码扫描 src/rsi/** 里能拿到 runSync 的文件 ⊆ {personal/commit.ts, commit-journal.ts, repo-check.ts} ∪ hooks/**;repo-check.ts 确实在列(扫描不空转)',
      '违例夹具(真实 eslint 配置) W2 的源码与测试在真实配置下 lint 全绿(home-fs 只在 personal/** 授权)',
    ],
    restored: true,
  },
  {
    id: 'runsync-in-personal-lock',
    failed: 2,
    skipped: 0,
    killedBy: [
      '私有仓库唯一 git 出口:真实源码扫描 src/rsi/** 里能拿到 runSync 的文件 ⊆ {personal/commit.ts, commit-journal.ts, repo-check.ts} ∪ hooks/**;repo-check.ts 确实在列(扫描不空转)',
      '违例夹具(真实 eslint 配置) W2 的源码与测试在真实配置下 lint 全绿(home-fs 只在 personal/** 授权)',
    ],
    restored: true,
  },
];
