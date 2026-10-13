import type { Diagnostic } from '../contracts/diagnostics.js';

/** git diff-tree 的变更类别(--no-renames:重命名/复制一律拆成 D + A)。 */
export type ChangeKind = 'A' | 'D' | 'M' | 'T' | 'U' | 'X';

export interface Change {
  kind: ChangeKind;
  /** git 给出的仓库相对路径(-z 输出,未转义) */
  path: string;
  /** 不存在一侧为 '000000' */
  baseMode: string;
  headMode: string;
  /** 不存在一侧为全零 oid */
  baseOid: string;
  headOid: string;
}

/** 守卫对 git 的全部需求。真实实现见 git.ts(经 src/io/exec.ts),测试也用真实实现。 */
export interface GuardGit {
  /** ref → 提交 oid;解析不了返回 undefined */
  resolveCommit(ref: string): string | undefined;
  /** base 与 head 两棵树之间的差异(无重命名检测),按 path 字节序排序 */
  changes(baseOid: string, headOid: string): Change[];
  /** 按 blob oid 取文本(utf8,保留 BOM) */
  blobText(oid: string): string;
  /** <commit>:<path> 处的文本;不存在返回 undefined */
  textAt(commitOid: string, path: string): string | undefined;
  /** 本地 `stable-*` tag 指向的提交 oid(已剥离注解 tag;非提交的 tag 忽略) */
  stableTagCommits(): string[];
  isAncestor(ancestorOid: string, descendantOid: string): boolean;
  /** L2:<commit> 树里 `dir/` 之下的全部**普通文件**路径(符号链接/子模块不列),字节序;目录不存在返回 [] */
  listFiles(commitOid: string, dir: string): string[];
  /** L2:从 <commit> 往回、改动过 `path` 的提交(新→旧),带提交者日期 YYYY-MM-DD;不跟随重命名 */
  fileHistory(commitOid: string, path: string): { commit: string; date: string }[];
}

/** 受限 YAML 解析后的 frontmatter 视图 + 归一化正文。 */
export type AtomView =
  { ok: true; fm: Readonly<Record<string, unknown>>; body: string } | { ok: false; reason: string };

/** 一个被改动的原子文件及其两侧视图(不存在的一侧为 undefined)。 */
export interface AtomChange {
  change: Change;
  base: AtomView | undefined;
  head: AtomView | undefined;
}

export type GuardLabel = 'kit:promotion' | 'kit:retire' | 'kit:attest' | 'kit:reflector';

/** 一次状态转移(G3 已确认方向在白名单内)。 */
export interface TransitionInput {
  label: 'kit:promotion' | 'kit:retire';
  path: string;
  from: string;
  to: string;
}

/**
 * G3 判据检查接口(L2 起)。判据能读基线/头部两棵树里的任意文本(原子、attest/、reports/、proposals/、lifecycle/、kit.toml)
 * 以及 git(stable tag、提交历史)。返回空数组 = 通过。
 */
export interface CriteriaInput {
  transition: TransitionInput;
  /** 头部提交里 `path` 处的文本;不存在(或不是 blob)返回 undefined */
  headView(path: string): string | undefined;
  /** 基线提交里 `path` 处的文本 */
  baseView(path: string): string | undefined;
  /** 头部/基线提交里 `dir/` 之下的普通文件路径 */
  listHead(dir: string): string[];
  listBase(dir: string): string[];
  git: GuardGit;
  baseOid: string;
  headOid: string;
}
export type CriteriaChecker = (i: CriteriaInput) => Diagnostic[];

/** checkG3 构造 CriteriaInput 所需的运行环境。 */
export interface G3Env {
  git: GuardGit;
  baseOid: string;
  headOid: string;
}

export interface GuardOptions {
  git: GuardGit;
  base: string;
  head: string;
  label: GuardLabel | undefined;
  /** 缺省 = pendingCriteria(P1 未实现 → 视为不通过) */
  criteria?: CriteriaChecker;
}

export interface GuardResult {
  diagnostics: Diagnostic[];
  baseOid: string;
  headOid: string;
  changed: number;
}
