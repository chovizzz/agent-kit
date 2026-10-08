import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintRepo } from '../../src/atoms/lint.js';
import { readDir, readText } from '../../src/io/read-fs.js';
import { REPO_ROOT } from '../helpers/tmp.js';
import { stubRedactor } from './helpers.js';

const FIXTURES = path.join(REPO_ROOT, 'test/fixtures/atoms');

interface Expected {
  code: string;
  severity: 'error' | 'warn';
  path: string;
}
interface ExpectFile {
  diagnostics: Expected[];
  budget?: { enforce: 'warn' | 'block'; atom_max_bytes: number };
}

const key = (d: Expected): string => `${d.path}\u0000${d.code}\u0000${d.severity}`;
const sorted = (ds: Expected[]): Expected[] =>
  [...ds].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

const cases = (await readDir(FIXTURES)).filter((e) => e.isDirectory).map((e) => e.name);

async function loadExpect(name: string): Promise<ExpectFile> {
  return JSON.parse(await readText(path.join(FIXTURES, name, 'expect.json'))) as ExpectFile;
}

/** 每条规则(稳定 code)至少一个负向 fixture;删掉任一规则实现,对应 fixture 必须变红。 */
const RULE_CODES = [
  'ATOM_BODY_SECTION_DUPLICATE',
  'ATOM_BODY_SECTION_EMPTY',
  'ATOM_BODY_SECTION_MISSING',
  'ATOM_BODY_SECTION_ORDER',
  'ATOM_BODY_STRAY_TEXT',
  'ATOM_BODY_TOO_LARGE',
  'ATOM_CODEOWNERS_MISSING',
  'ATOM_EVIDENCE_REDACTION_RESIDUAL',
  'ATOM_FRONTMATTER_MISSING',
  'ATOM_FRONTMATTER_SYNTAX',
  'ATOM_ID_DUPLICATE',
  'ATOM_ID_FILENAME_MISMATCH',
  'ATOM_LAYER_DIR_MISMATCH',
  'ATOM_MODEL_NAME_IN_CORE',
  'ATOM_OWNER_NOT_IN_CODEOWNERS',
  'ATOM_PATH_LAYOUT',
  'ATOM_REF_ID_NOT_FOUND',
  'ATOM_REF_SELF',
  'ATOM_REVIEW_BEFORE_CREATED',
  'ATOM_REVIEW_TOO_FAR',
  'ATOM_UNKNOWN_FILE',
  'ATOM_VERIFIER_REF_INVALID',
  'ATOM_VERIFIER_REF_MISSING',
  'ATOM_VOLATILE_REVIEW_TOO_FAR',
  'AGENT_MODEL_NAME_IN_CORE',
  'AGENT_NAME_FILE_MISMATCH',
  'AGENT_UNKNOWN_FILE',
  'SCHEMA_INVALID',
  'SKILL_FILE_MISSING',
  'SKILL_NAME_DIR_MISMATCH',
  'SKILL_UNKNOWN_FILE',
];

describe('atoms fixtures:lint 输出与 expect.json 逐项相等(code + severity + path)', () => {
  it('fixture 目录非空,且有足够多的正向对照', () => {
    expect(cases.length).toBeGreaterThanOrEqual(60);
    expect(cases.filter((c) => c.startsWith('ok-')).length).toBeGreaterThanOrEqual(10);
  });

  it('命名约定防静默变空:ok-* 的期望必须为空;非 ok-* 的期望必须非空', async () => {
    for (const name of cases) {
      const exp = await loadExpect(name);
      if (name.startsWith('ok-')) expect(exp.diagnostics, name).toEqual([]);
      else expect(exp.diagnostics.length, name).toBeGreaterThan(0);
    }
  });

  it('每条 lint 规则的 code 都至少被一个 fixture 断言', async () => {
    const asserted = new Set<string>();
    for (const name of cases)
      for (const d of (await loadExpect(name)).diagnostics) asserted.add(d.code);
    expect(RULE_CODES.filter((c) => !asserted.has(c))).toEqual([]);
  });

  for (const name of cases) {
    it(name, async () => {
      const exp = await loadExpect(name);
      const res = await lintRepo(path.join(FIXTURES, name), {
        redactor: stubRedactor,
        ...(exp.budget ? { budget: exp.budget } : {}),
      });
      const actual: Expected[] = res.diagnostics.map((d) => ({
        code: d.code,
        severity: d.severity,
        path: d.path,
      }));
      expect(sorted(actual)).toEqual(sorted(exp.diagnostics));
    });
  }
});
