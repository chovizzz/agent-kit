import { createHash } from 'node:crypto';
import {
  AtomBodySchema,
  AtomFrontmatterSchema,
  type Atom,
  type AtomBody,
  type AtomFrontmatter,
} from '../contracts/atom.js';
import { zodIssuesToDiagnostics, type Diagnostic } from '../contracts/diagnostics.js';
import { canonicalText } from '../io/canonical-text.js';
import { parseRestrictedYaml, splitFrontmatter } from './frontmatter.js';

export interface ParseAtomResult {
  /** 仅当 frontmatter 与正文都通过 schema 与结构检查时才有 */
  atom: Atom | undefined;
  /** 解析阶段的诊断(语法、schema、正文结构);lint 规则在 lint.ts */
  diagnostics: Diagnostic[];
}

const err = (code: string, path: string, message: string): Diagnostic => ({
  code,
  severity: 'error',
  path,
  message,
});

type SectionKey = keyof AtomBody;

const SECTION_MARKERS: readonly { key: SectionKey; label: string }[] = [
  { key: 'do', label: '做' },
  { key: 'why', label: '为什么' },
  { key: 'verify', label: '怎么验' },
];
const MARKER_RE = /^\*\*(做|为什么|怎么验)\*\*[:\uFF1A]/;

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

function labelToKey(label: string): SectionKey {
  const hit = SECTION_MARKERS.find((m) => m.label === label);
  /* c8 ignore next */
  if (!hit) throw new Error(`未知段标记:${label}`);
  return hit.key;
}

export interface BodyParse {
  body: AtomBody | undefined;
  /** 从第一个标记行起到结尾,trim 后的原文(LF);无标记时为 '' */
  bodyText: string;
  diagnostics: Diagnostic[];
}

/**
 * 解析正文三段。标记必须出现在行首:`**做**:` `**为什么**:` `**怎么验**:`(半角或全角冒号)。
 * 要求:各出现恰好一次、顺序固定(做 → 为什么 → 怎么验)、每段非空、第一个标记前无游离文本。
 * 段内容 = 标记之后到下一个标记之前的全部文本(含冒号后同一行),trim。
 */
export function parseBody(bodyRaw: string, filePath: string): BodyParse {
  const diagnostics: Diagnostic[] = [];
  const lines = bodyRaw.split('\n');
  const found: { key: SectionKey; line: number; label: string }[] = [];
  // 代码围栏(``` 或 ~~~)内的行不参与段标记匹配:正文里用代码块展示原子模板是合法写法
  let fence: string | undefined;
  lines.forEach((line, i) => {
    const f = FENCE_RE.exec(line);
    if (f?.[1] !== undefined) {
      const mark = f[1].charAt(0);
      if (fence === undefined) fence = mark;
      else if (fence === mark) fence = undefined;
      return;
    }
    if (fence !== undefined) return;
    const m = MARKER_RE.exec(line);
    if (m?.[1] !== undefined) found.push({ key: labelToKey(m[1]), line: i, label: m[1] });
  });

  if (found.length > 0) {
    const first = found[0]!;
    const stray = lines.slice(0, first.line).join('\n').trim();
    if (stray !== '') {
      diagnostics.push(
        err('ATOM_BODY_STRAY_TEXT', filePath, '第一个段标记之前不允许有正文文本(会被静默丢弃)'),
      );
    }
  }

  const seen = new Set<SectionKey>();
  for (const f of found) {
    if (seen.has(f.key)) {
      diagnostics.push(
        err(
          'ATOM_BODY_SECTION_DUPLICATE',
          `${filePath}#/body/${f.key}`,
          `段「${f.label}」出现多次`,
        ),
      );
    }
    seen.add(f.key);
  }
  for (const m of SECTION_MARKERS) {
    if (!seen.has(m.key)) {
      diagnostics.push(
        err(
          'ATOM_BODY_SECTION_MISSING',
          `${filePath}#/body/${m.key}`,
          `缺少正文段「**${m.label}**:」`,
        ),
      );
    }
  }
  if (diagnostics.length === 0) {
    const order = found.map((f) => f.key).join(',');
    if (order !== 'do,why,verify') {
      diagnostics.push(
        err('ATOM_BODY_SECTION_ORDER', filePath, '正文段顺序必须是 做 → 为什么 → 怎么验'),
      );
    }
  }

  const sections: Partial<Record<SectionKey, string>> = {};
  found.forEach((f, idx) => {
    const end = found[idx + 1]?.line ?? lines.length;
    const firstLine = (lines[f.line] ?? '').replace(MARKER_RE, '');
    const text = [firstLine, ...lines.slice(f.line + 1, end)].join('\n').trim();
    if (sections[f.key] === undefined) sections[f.key] = text;
    if (text === '') {
      diagnostics.push(
        err('ATOM_BODY_SECTION_EMPTY', `${filePath}#/body/${f.key}`, `正文段「${f.label}」为空`),
      );
    }
  });

  const bodyText = found.length > 0 ? lines.slice(found[0]!.line).join('\n').trim() : '';
  if (diagnostics.length > 0) return { body: undefined, bodyText, diagnostics };
  const parsed = AtomBodySchema.safeParse(sections);
  if (!parsed.success) {
    return {
      body: undefined,
      bodyText,
      diagnostics: zodIssuesToDiagnostics(parsed.error, filePath),
    };
  }
  return { body: parsed.data, bodyText, diagnostics };
}

/**
 * 解析一个原子文件。
 * - `relPath` 是仓库相对路径(正斜杠),原样写入 `Atom.sourcePath` 与诊断 path。
 * - `applies_to` 缺省补 `['all']`(契约 §8-3)。
 * - `bodyBytes` = 正文(从第一个段标记起、trim 后、LF)的 UTF-8 字节数。
 * - `sha256` = sha256(canonicalText(整个源文件)),所以 CRLF/末尾空行不影响哈希。
 */
export function parseAtom(source: string, relPath: string): ParseAtomResult {
  const { yamlText, body: bodyRaw } = splitFrontmatter(source);
  if (yamlText === undefined) {
    return {
      atom: undefined,
      diagnostics: [
        err('ATOM_FRONTMATTER_MISSING', relPath, '文件必须以 `---` 开头的 YAML frontmatter 起始'),
      ],
    };
  }
  const yamlRes = parseRestrictedYaml(yamlText, relPath, 'ATOM_FRONTMATTER_SYNTAX');
  if (!yamlRes.ok) return { atom: undefined, diagnostics: yamlRes.diagnostics };

  const diagnostics: Diagnostic[] = [];
  const fmRes = AtomFrontmatterSchema.safeParse(yamlRes.value);
  let fm: AtomFrontmatter | undefined;
  if (fmRes.success) {
    fm = fmRes.data.applies_to === undefined ? { ...fmRes.data, applies_to: ['all'] } : fmRes.data;
  } else {
    diagnostics.push(...zodIssuesToDiagnostics(fmRes.error, relPath));
  }

  const bodyRes = parseBody(bodyRaw, relPath);
  diagnostics.push(...bodyRes.diagnostics);
  if (fm === undefined || bodyRes.body === undefined) return { atom: undefined, diagnostics };

  const atom: Atom = {
    fm,
    body: bodyRes.body,
    bodyBytes: Buffer.byteLength(bodyRes.bodyText, 'utf8'),
    sha256: createHash('sha256')
      .update(canonicalText(source.replace(/^﻿/, '')))
      .digest('hex'),
    sourcePath: relPath,
  };
  return { atom, diagnostics };
}

/** 文件名(不含 `.md`)。 */
export function fileStem(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  return base.endsWith('.md') ? base.slice(0, -3) : base;
}
