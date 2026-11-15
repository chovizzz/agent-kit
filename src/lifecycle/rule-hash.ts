/**
 * 规则文本哈希(C6,供 L3/L4 与 N4-2 的 `judge-signal` 复用)的**唯一实现**。
 * 独立成文件的原因(W0-27):`checks.ts` 的 import 闭包经 `reflect/stage.ts` 含 `safe-fs` 写出口,
 * 读侧(判官裁决只读协议,R20-18.34)不能 import 它;本文件只依赖 `node:crypto` 与纯函数 `io/canonical-text.ts`。
 * `checks.ts` 再导出同名符号,既有调用方(retire / attest-count / 测试)的 import 路径不变。
 */
import { createHash } from 'node:crypto';
import { canonicalText } from '../io/canonical-text.js';

export class RuleHashError extends Error {
  readonly code = 'RULE_TEXT_UNHASHABLE';
}

const NORMALIZED = '__NORMALIZED__';
/**
 * 顶层 `status:` / `review_by:` 行:只把**值**换成占位符,值后面的内容(行尾注释等)原样保留并参与哈希,
 * 所以评审后往这两行追加注释不会让哈希不变。值只接受简单标量(字母数字、`-`、`_`、`.`,可带引号);
 * 块标量(`|` `>`)、流式写法、带引号的键等一律不匹配 → 计数不是恰好一行 → 抛 `RuleHashError`(fail-closed)。
 */
const SCALAR_LINE_RE = /^((?:status|review_by))(\s*:\s*)(['"]?[A-Za-z0-9._-]+['"]?)((?:\s.*)?)$/;

/**
 * 规则文本哈希(C6,供 L3/L4 复用):把 frontmatter 顶层的 `status:` 与 `review_by:` 两行的值归一化后,
 * 对 `canonicalText(全文)` 取 sha256(hex)。否则晋升 PR 改这两行就会改哈希。
 * 这里的哈希**不等于** `Atom.sha256`(那是未归一化的整文件哈希),也不是契约注释里的「渲染内容哈希」(未核实,见汇报)。
 * frontmatter 缺失,或 `status` / `review_by` 不是恰好各出现一次 → 抛 `RuleHashError`(不猜)。
 */
export function ruleSha256(atomText: string): string {
  const lf = atomText.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = lf.split('\n');
  if (lines[0] !== '---') throw new RuleHashError('RULE_TEXT_UNHASHABLE: 缺 frontmatter');
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new RuleHashError('RULE_TEXT_UNHASHABLE: frontmatter 未闭合');
  let status = 0;
  let review = 0;
  for (let i = 1; i < end; i++) {
    const line = lines[i] as string;
    const sm = SCALAR_LINE_RE.exec(line);
    if (sm === null) continue;
    if (sm[1] === 'status') {
      lines[i] = `${sm[1]}${sm[2]}${NORMALIZED}${sm[4]}`;
      status++;
    } else if (sm[1] === 'review_by') {
      lines[i] = `${sm[1]}${sm[2]}${NORMALIZED}${sm[4]}`;
      review++;
    }
  }
  if (status !== 1 || review !== 1) {
    throw new RuleHashError('RULE_TEXT_UNHASHABLE: status/review_by 不是恰好各一行');
  }
  return createHash('sha256')
    .update(canonicalText(lines.join('\n')), 'utf8')
    .digest('hex');
}
