import { isAlias, isMap, isScalar, isSeq, parseDocument, visit } from 'yaml';
import type { Diagnostic } from '../contracts/diagnostics.js';

export interface SplitResult {
  /** frontmatter 原文(不含 `---` 围栏行);无 frontmatter 时为 undefined */
  yamlText: string | undefined;
  /** 围栏之后的正文(LF 归一化) */
  body: string;
}

/** 去 BOM、CRLF/CR → LF。 */
export function normalizeNewlines(source: string): string {
  const noBom = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  return noBom.replace(/\r\n?/g, '\n');
}

/**
 * 切分 `---\n<yaml>\n---\n<body>`。首行必须恰为 `---`;结束围栏是之后第一行恰为 `---` 的行。
 * 不做 YAML 解析。
 */
export function splitFrontmatter(source: string): SplitResult {
  const text = normalizeNewlines(source);
  const lines = text.split('\n');
  if (lines[0] !== '---') return { yamlText: undefined, body: text };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      return {
        yamlText: lines.slice(1, i).join('\n'),
        body: lines.slice(i + 1).join('\n'),
      };
    }
  }
  return { yamlText: undefined, body: text };
}

export type YamlParse = { ok: true; value: unknown } | { ok: false; diagnostics: Diagnostic[] };

/**
 * 受限 YAML 解析:
 * - core schema(未加引号的 2026-10-08 保持字符串);重复键、多文档、语法错误一律拒绝;
 * - 拒绝 anchors / aliases / merge key(`<<`)/ 自定义 tag:原子与技能 frontmatter 不需要它们,
 *   且 alias 可被用来放大文档(billion-laughs)。
 * `code` 是语法类诊断的稳定码(ATOM_FRONTMATTER_SYNTAX / SKILL_FRONTMATTER_SYNTAX / AGENT_YAML_SYNTAX)。
 */
export function parseRestrictedYaml(text: string, filePath: string, code: string): YamlParse {
  const fail = (message: string): YamlParse => ({
    ok: false,
    diagnostics: [{ code, severity: 'error', path: filePath, message }],
  });
  let doc;
  try {
    doc = parseDocument(text, { uniqueKeys: true, version: '1.2', schema: 'core', merge: false });
  } catch (e) {
    return fail(`YAML 无法解析:${(e as Error).message.split('\n')[0] ?? ''}`);
  }
  if (doc.errors.length > 0) {
    return fail(`YAML 语法错误:${doc.errors[0]?.message.split('\n')[0] ?? ''}`);
  }
  if (doc.warnings.length > 0) {
    return fail(`YAML 警告按错误处理:${doc.warnings[0]?.message.split('\n')[0] ?? ''}`);
  }
  let bad: string | undefined;
  visit(doc, {
    Alias() {
      bad = '不允许 YAML 别名(*alias)';
      return visit.BREAK;
    },
    Node(_key, node) {
      if (isAlias(node)) {
        bad = '不允许 YAML 别名(*alias)';
        return visit.BREAK;
      }
      if ((isMap(node) || isSeq(node) || isScalar(node)) && node.anchor !== undefined) {
        bad = '不允许 YAML 锚点(&anchor)';
        return visit.BREAK;
      }
      if ((isMap(node) || isSeq(node) || isScalar(node)) && node.tag !== undefined) {
        bad = '不允许显式 YAML tag(!!tag)';
        return visit.BREAK;
      }
      return undefined;
    },
  });
  if (bad !== undefined) return fail(bad);
  const value: unknown = doc.toJS({ maxAliasCount: 0 });
  return { ok: true, value };
}
