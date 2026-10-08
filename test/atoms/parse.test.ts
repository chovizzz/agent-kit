import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileStem, parseAtom, parseBody } from '../../src/atoms/parse.js';
import { parseRestrictedYaml, splitFrontmatter } from '../../src/atoms/frontmatter.js';
import { canonicalText } from '../../src/io/canonical-text.js';
import { readText } from '../../src/io/read-fs.js';
import { REPO_ROOT } from '../helpers/tmp.js';

const DESIGN_PATH = 'rules/team/negative-assertion-needs-positive-control.md';
const FIXTURE = path.join(REPO_ROOT, 'test/fixtures/atoms/ok-design-example', DESIGN_PATH);
const design = await readText(FIXTURE);

describe('parseAtom:设计 §3.4 示例原子', () => {
  it('解析通过,字段齐全', () => {
    const r = parseAtom(design, DESIGN_PATH);
    expect(r.diagnostics).toEqual([]);
    const a = r.atom!;
    expect(a.fm.id).toBe('negative-assertion-needs-positive-control');
    expect(a.fm.layer).toBe('team');
    expect(a.fm.applies_to).toEqual(['all']);
    expect(a.fm.created).toBe('2026-10-08');
    expect(a.fm.review_by).toBe('2027-01-08');
    expect(a.body.do).toContain('先断言一个必然成立的正向前提');
    expect(a.body.why).toContain('静默变空');
    expect(a.body.verify).toContain('必须变红');
    expect(a.sourcePath).toBe(DESIGN_PATH);
  });

  it('bodyBytes = 从第一个段标记起、trim 后正文的 UTF-8 字节数(中文 3 字节)', () => {
    const a = parseAtom(design, DESIGN_PATH).atom!;
    const body = design.slice(design.indexOf('**做**'));
    expect(a.bodyBytes).toBe(Buffer.byteLength(body.trim(), 'utf8'));
    expect(a.bodyBytes).toBeGreaterThan(a.body.do.length + a.body.why.length);
  });

  it('sha256 = canonicalText(整个源文件) 的哈希:CRLF / BOM / 末尾空行不改变它,内容变化会改变它', () => {
    const base = parseAtom(design, DESIGN_PATH).atom!.sha256;
    expect(base).toBe(createHash('sha256').update(canonicalText(design)).digest('hex'));
    expect(parseAtom(design.replace(/\n/g, '\r\n'), DESIGN_PATH).atom!.sha256).toBe(base);
    expect(parseAtom('﻿' + design, DESIGN_PATH).atom!.sha256).toBe(base);
    expect(parseAtom(design + '\n\n\n', DESIGN_PATH).atom!.sha256).toBe(base);
    expect(parseAtom(design.replace('必须变红', '必须变绿'), DESIGN_PATH).atom!.sha256).not.toBe(
      base,
    );
  });

  it('CRLF 与 BOM 源文件解析结果与 LF 完全相同(含 bodyBytes)', () => {
    const lf = parseAtom(design, DESIGN_PATH).atom!;
    const crlf = parseAtom(design.replace(/\n/g, '\r\n'), DESIGN_PATH).atom!;
    const bom = parseAtom('﻿' + design, DESIGN_PATH).atom!;
    expect(crlf).toEqual(lf);
    expect(bom).toEqual(lf);
  });

  it('applies_to 显式给出时保持原值', () => {
    const src = design.replace('applies_to: [all]', 'applies_to: [claude, codex]');
    expect(parseAtom(src, DESIGN_PATH).atom!.fm.applies_to).toEqual(['claude', 'codex']);
  });

  it('未加引号的 YAML 日期保持字符串,不被解析成 Date', () => {
    expect(typeof parseAtom(design, DESIGN_PATH).atom!.fm.created).toBe('string');
  });
});

describe('parseAtom:frontmatter 边界', () => {
  const fm = (extra: string): string =>
    design.replace('\nescalation_level: 1', `\nescalation_level: 1\n${extra}`);

  it('YAML 合并键 `<<` 不作为合并解析:落成未知键,被 strictObject 拒', () => {
    const r = parseAtom(fm('<<: {id: x}'), DESIGN_PATH);
    expect(r.atom).toBeUndefined();
    expect(r.diagnostics.map((d) => d.code)).toEqual(['SCHEMA_INVALID']);
  });

  it('`...` 提前结束文档后的内容落在正文里,被当作游离文本拒绝', () => {
    const r = parseAtom(fm('...\n---\nid: second'), DESIGN_PATH);
    expect(r.atom).toBeUndefined();
    expect(r.diagnostics.map((d) => d.code)).toEqual(['ATOM_BODY_STRAY_TEXT']);
  });

  it('frontmatter 文本里出现第二个文档被拒', () => {
    const r = parseRestrictedYaml('a: 1\n---\nb: 2\n', 'f.md', 'ATOM_FRONTMATTER_SYNTAX');
    expect(r.ok).toBe(false);
  });

  it('YAML 警告按错误处理(未知 %指令)', () => {
    const r = parseAtom(`---\n%FOO bar\nid: x\n---\n`, DESIGN_PATH);
    expect(r.atom).toBeUndefined();
    expect(r.diagnostics[0]?.code).toBe('ATOM_FRONTMATTER_SYNTAX');
  });

  it('正向对照:同一份源文件不加这些东西则零诊断', () => {
    expect(parseAtom(design, DESIGN_PATH).diagnostics).toEqual([]);
  });

  it('结束围栏必须独占一行:`--- ` 带尾空格不算围栏', () => {
    expect(splitFrontmatter('---\na: 1\n--- \nbody').yamlText).toBeUndefined();
    expect(splitFrontmatter('---\na: 1\n---\nbody')).toEqual({ yamlText: 'a: 1', body: 'body' });
  });

  it('fileStem 去掉 .md 与目录', () => {
    expect(fileStem('rules/team/a-b.md')).toBe('a-b');
    expect(fileStem('x.yaml')).toBe('x.yaml');
  });
});

describe('parseBody:三段结构', () => {
  const ok = '**做**:A\n**为什么**:B\n**怎么验**:C\n';

  it('半角与全角冒号都可作标记;同行内容与续行都算进该段', () => {
    const r = parseBody('**做**:A1\nA2\n**为什么**：B\n\n**怎么验**: C\n', 'f.md');
    expect(r.diagnostics).toEqual([]);
    expect(r.body).toEqual({ do: 'A1\nA2', why: 'B', verify: 'C' });
  });

  it('标记必须在行首:行内出现的 **做**: 不算段标记', () => {
    const r = parseBody('说明 **做**:A\n**为什么**:B\n**怎么验**:C\n', 'f.md');
    expect(r.diagnostics.map((d) => d.code).sort()).toEqual([
      'ATOM_BODY_SECTION_MISSING',
      'ATOM_BODY_STRAY_TEXT',
    ]);
  });

  it('标记后面不带冒号不算标记', () => {
    const r = parseBody('**做** A\n**为什么**:B\n**怎么验**:C\n', 'f.md');
    expect(r.body).toBeUndefined();
    expect(r.diagnostics.some((d) => d.code === 'ATOM_BODY_SECTION_MISSING')).toBe(true);
  });

  it('只含空白的段算空', () => {
    const r = parseBody('**做**:   \n**为什么**:B\n**怎么验**:C\n', 'f.md');
    expect(r.diagnostics.map((d) => d.code)).toEqual(['ATOM_BODY_SECTION_EMPTY']);
  });

  it('正向对照:合法三段零诊断', () => {
    expect(parseBody(ok, 'f.md').diagnostics).toEqual([]);
  });
});
