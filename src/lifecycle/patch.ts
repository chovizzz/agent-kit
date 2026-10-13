/**
 * 修改型补丁生成器(L4,设计稿 §3.1-6):晋升 PR 只改原子 frontmatter 的 `status:` 一行和(T2 时)`review_by:` 一行。
 *
 * - 手工生成带上下文的 unified diff(3 行上下文),`index` 行写 HEAD blob 的 oid;**不调 `git diff`**
 *   (要先把新内容写成 blob 会写 `.git/`,不在写入根里)。
 * - 纯函数:不读盘、不写盘。输入是 HEAD 里的原文,输出是新文本与补丁文本。
 * - 保守取向:`status` / `review_by` 必须在 frontmatter 里恰好各出现一次、值是简单标量;文本含 CR、BOM、缺结尾换行、
 *   或新行带行尾空白(`git apply --whitespace=error` 会拒)一律报 `PatchError`(调用方 fail-closed),不猜。
 */
import { gitBlobOid } from '../reflect/stage.js';

/** 路径逐段检查:不许有空段、`.`、`..`(字符白名单挡不住 `a/../x`)。 */
function hasBadSegment(filePath: string): boolean {
  return filePath.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

export class PatchError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface FrontmatterEdit {
  status: string;
  /** 只有 T2 才给;缺省 = 不动 `review_by` 行 */
  reviewBy?: string;
}

/** 顶层 `status:` / `review_by:` 行;只接受简单标量(可带引号),值后面的行尾注释原样保留。 */
const LINE_RE = /^(status|review_by)(\s*:\s*)(['"]?)([A-Za-z0-9._-]+)(['"]?)((?:\s.*)?)$/;

/**
 * 只改 `status:`(以及可选的 `review_by:`)两行的值,其余字节一概不动。
 * 返回新全文;任何不确定都抛 `PatchError`(稳定码)。
 */
export function rewriteFrontmatter(text: string, edit: FrontmatterEdit): string {
  if (text.startsWith('﻿')) throw new PatchError('PATCH_BOM');
  if (text.includes('\r')) throw new PatchError('PATCH_CR');
  if (!text.endsWith('\n')) throw new PatchError('PATCH_NO_FINAL_NEWLINE');
  const lines = text.slice(0, -1).split('\n');
  if (lines[0] !== '---') throw new PatchError('PATCH_NO_FRONTMATTER');
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new PatchError('PATCH_FRONTMATTER_UNCLOSED');
  const idx: Record<'status' | 'review_by', number[]> = { status: [], review_by: [] };
  for (let i = 1; i < end; i++) {
    const m = LINE_RE.exec(lines[i] as string);
    if (m !== null) idx[m[1] as 'status' | 'review_by'].push(i);
  }
  const set = (key: 'status' | 'review_by', value: string): void => {
    const at = idx[key];
    if (at.length !== 1) throw new PatchError(`PATCH_${key.toUpperCase()}_LINE_COUNT`);
    const m = LINE_RE.exec(lines[at[0] as number] as string) as RegExpExecArray;
    if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new PatchError('PATCH_VALUE_UNSAFE');
    lines[at[0] as number] = `${m[1]}${m[2]}${m[3]}${value}${m[5]}${m[6]}`;
  };
  set('status', edit.status);
  if (edit.reviewBy !== undefined) set('review_by', edit.reviewBy);
  else if (idx.review_by.length !== 1) throw new PatchError('PATCH_REVIEW_BY_LINE_COUNT');
  return `${lines.join('\n')}\n`;
}

const CONTEXT = 3;

/**
 * 同一文件、行数不变的修改补丁(`git apply --check --whitespace=error` 可直接用)。
 * `oldText` 必须就是 HEAD 里的 blob 原文(index 行用它的 git blob oid)。两侧行数必须相等。
 */
export function buildModifyPatch(filePath: string, oldText: string, newText: string): string {
  if (!/^[a-z0-9][a-z0-9/._-]*$/.test(filePath) || hasBadSegment(filePath)) {
    throw new PatchError('PATCH_PATH_UNSAFE');
  }
  if (oldText === newText) throw new PatchError('PATCH_EMPTY');
  if (newText.includes('\r') || oldText.includes('\r')) throw new PatchError('PATCH_CR');
  if (!oldText.endsWith('\n') || !newText.endsWith('\n')) {
    throw new PatchError('PATCH_NO_FINAL_NEWLINE');
  }
  const a = oldText.slice(0, -1).split('\n');
  const b = newText.slice(0, -1).split('\n');
  if (a.length !== b.length) throw new PatchError('PATCH_LINE_COUNT_CHANGED');
  const changed: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changed.push(i);
  for (const i of changed) {
    if (/[ \t]$/.test(b[i] as string)) throw new PatchError('PATCH_TRAILING_WHITESPACE');
  }
  // 变更行按「间隔 ≤ 2*CONTEXT 就并成一个 hunk」分组(git 的做法:上下文重叠即合并)
  const groups: number[][] = [];
  for (const i of changed) {
    const g = groups[groups.length - 1];
    if (g !== undefined && i - (g[g.length - 1] as number) <= 2 * CONTEXT) g.push(i);
    else groups.push([i]);
  }
  const parts: string[] = [
    `diff --git a/${filePath} b/${filePath}\n`,
    `index ${gitBlobOid(oldText).slice(0, 12)}..${gitBlobOid(newText).slice(0, 12)} 100644\n`,
    `--- a/${filePath}\n`,
    `+++ b/${filePath}\n`,
  ];
  for (const g of groups) {
    const from = Math.max(0, (g[0] as number) - CONTEXT);
    const to = Math.min(a.length - 1, (g[g.length - 1] as number) + CONTEXT);
    const n = to - from + 1;
    parts.push(`@@ -${from + 1},${n} +${from + 1},${n} @@\n`);
    // 与 git 的写法一致:连续的变更行先列全部删除行,再列全部新增行
    for (let i = from; i <= to;) {
      if (a[i] === b[i]) {
        parts.push(` ${a[i] as string}\n`);
        i++;
        continue;
      }
      let j = i;
      while (j <= to && a[j] !== b[j]) j++;
      for (let k = i; k < j; k++) parts.push(`-${a[k] as string}\n`);
      for (let k = i; k < j; k++) parts.push(`+${b[k] as string}\n`);
      i = j;
    }
  }
  return parts.join('');
}

/**
 * 新增文件补丁(L6:retire 的 `lifecycle/<rule-id>/<recorded_at>-<run_id>.json`)。`git apply --check --whitespace=error` 可直接用。
 * 保守取向同上:内容必须非空、以 LF 结尾、不含 CR、行尾无空白,路径必须过安全正则;否则 `PatchError`。
 */
export function buildAddFilePatch(filePath: string, content: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9/._-]*$/.test(filePath) || hasBadSegment(filePath)) {
    throw new PatchError('PATCH_PATH_UNSAFE');
  }
  if (content === '' || !content.endsWith('\n')) throw new PatchError('PATCH_NO_FINAL_NEWLINE');
  if (content.includes('\r')) throw new PatchError('PATCH_CR');
  const lines = content.slice(0, -1).split('\n');
  for (const l of lines) if (/[ \t]$/.test(l)) throw new PatchError('PATCH_TRAILING_WHITESPACE');
  return [
    `diff --git a/${filePath} b/${filePath}\n`,
    'new file mode 100644\n',
    `index 0000000..${gitBlobOid(content).slice(0, 12)}\n`,
    '--- /dev/null\n',
    `+++ b/${filePath}\n`,
    `@@ -0,0 +1,${lines.length} @@\n`,
    ...lines.map((l) => `+${l}\n`),
  ].join('');
}
