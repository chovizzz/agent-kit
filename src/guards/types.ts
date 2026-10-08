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

/** G3 判据检查接口(P1 实装:attest/reports 校验)。返回空数组 = 通过。 */
export interface TransitionInput {
  label: 'kit:promotion' | 'kit:retire';
  path: string;
  from: string;
  to: string;
}
export type CriteriaChecker = (t: TransitionInput) => Diagnostic[];

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
