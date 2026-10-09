import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lintRepo } from '../../src/atoms/lint.js';
import { findModelNames } from '../../src/atoms/model-names.js';
import { parseAtom } from '../../src/atoms/parse.js';
import { lintDeps } from '../../src/commands/lint-cmd.js';
import { hasErrors } from '../../src/contracts/diagnostics.js';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { ManifestSchema } from '../../src/contracts/render.js';
import { createRedactor } from '../../src/redact/index.js';
import { readDir, readText } from '../../src/io/read-fs.js';
import { REPO_ROOT } from '../helpers/tmp.js';
import { outTree, resetBuildDeps, runBuild, makeSandbox, writeRepo } from '../build/helpers.js';

afterEach(() => {
  resetBuildDeps();
  delete lintDeps.redactor;
});

/** 真实仓库里与种子相关的文件(相对路径 → 文本):kit.toml、CODEOWNERS、rules/**、cases/**。 */
async function seedFiles(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (rel: string): Promise<void> => {
    for (const e of await readDir(path.join(REPO_ROOT, rel))) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory) await walk(r);
      else out[r] = await readText(path.join(REPO_ROOT, r));
    }
  };
  await walk('rules');
  await walk('skills');
  await walk('cases');
  out['kit.toml'] = await readText(path.join(REPO_ROOT, 'kit.toml'));
  out['CODEOWNERS'] = await readText(path.join(REPO_ROOT, 'CODEOWNERS'));
  return out;
}

const redactor = () => createRedactor({ sensitive_words: [] }, { internalDomains: [] });
const ruleKeys = (f: Record<string, string>): string[] =>
  Object.keys(f)
    .filter((k) => k.startsWith('rules/org/') && k.endsWith('.md'))
    .sort();

describe('真实仓库种子', () => {
  it('种子原子全部是 proposed(G1),至少有 2 条 org 层种子,且没有 personal 层文件', async () => {
    const f = await seedFiles();
    expect(ruleKeys(f).length).toBeGreaterThanOrEqual(2);
    for (const k of ruleKeys(f)) expect(f[k], k).toMatch(/^status: proposed$/m);
    expect(Object.keys(f).filter((k) => k.startsWith('rules/personal/'))).toEqual([]);
    expect(
      Object.keys(f).filter((k) => k.startsWith('rules/') && !k.startsWith('rules/org/')),
    ).toEqual([]);
  });

  it('① 用真实仓库根跑 lintRepo:0 error、0 warn', async () => {
    const r = await lintRepo(REPO_ROOT, { redactor: redactor() });
    expect(r.scanErrors).toBe(0);
    expect(r.diagnostics).toEqual([]);
    expect(r.atoms.length).toBeGreaterThanOrEqual(2);
    expect(r.skills.length).toBeGreaterThanOrEqual(1);
    expect(r.atoms.every((a) => a.fm.layer === 'org')).toBe(true);
  });

  it('② 真实仓库(副本)build 到仓库外:manifest 非空、通过 schema、无 personal、无 /Users/', async () => {
    const sb = await makeSandbox('seeds-');
    const root = await writeRepo(sb, 'repo', await seedFiles());
    const r = await runBuild(sb, root);
    expect(r.code).toBe(ExitCode.OK);
    const tree = await outTree(root);
    const m = ManifestSchema.parse(JSON.parse(tree.get('manifest.json') ?? 'null'));
    expect(m.files.length).toBeGreaterThan(0);
    // 种子原子是 proposed(G1:新增原子只能 proposed),不渲染;out/ 非空靠示例技能
    expect(m.files.some((f) => f.path.includes('commit-checklist'))).toBe(true);
    expect(m.files.flatMap((f) => f.atoms).every((a) => a.layer !== 'personal')).toBe(true);
    expect(m.skippedLayers.some((s) => s.layer === 'personal')).toBe(true);
    for (const [p, text] of tree) {
      expect(text, p).not.toContain('/Users/');
      expect(text, p).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    }
  });

  it('③ 每条种子正文 ≤600 字节,且整个文件不含 URL / 邮箱 / IP / 具体模型名', async () => {
    const f = await seedFiles();
    for (const k of ruleKeys(f)) {
      const text = f[k]!;
      const { atom, diagnostics } = parseAtom(text, k);
      expect(diagnostics, k).toEqual([]);
      expect(atom!.bodyBytes, k).toBeLessThanOrEqual(600);
      expect(text, k).not.toMatch(/https?:\/\/|www\./i);
      expect(text, k).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
      expect(text, k).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
      expect(findModelNames(text), k).toEqual([]);
    }
  });
});

/** 每个变异:对第一条种子的文本做一次替换,先断言匹配次数 == 1;变异在内存与临时副本里完成,真实文件不动。 */
interface Mutation {
  name: string;
  find: RegExp;
  replace: string;
}
const MUTATIONS: Mutation[] = [
  {
    name: '删掉 evidence 块',
    find: /^evidence:\n(?:  .*\n)+?(?=verifier:)/gm,
    replace: '',
  },
  {
    name: '删掉 verifier 块',
    find: /^verifier:\n(?:  .*\n)+/gm,
    replace: '',
  },
  {
    name: 'verifier.ref 指向不存在的目录',
    find: /^  ref: cases\/[\w-]+\/$/gm,
    replace: '  ref: cases/does-not-exist/',
  },
  {
    name: 'owner 改成 CODEOWNERS 里没有的人',
    find: /^owner: '@chovizzz'$/gm,
    replace: "owner: '@nobody-else'",
  },
  {
    name: '去掉「怎么验」段',
    find: /^\*\*怎么验\*\*:.*$/gm,
    replace: '',
  },
];

describe('种子变异:缺 evidence / verifier 等必须让 lint 变红', () => {
  it('基线:未变异的副本 lint 全绿(变异前的正向控制)', async () => {
    const sb = await makeSandbox('seeds-mut-');
    const root = await writeRepo(sb, 'repo', await seedFiles());
    const r = await lintRepo(root, { redactor: redactor() });
    expect(hasErrors(r.diagnostics)).toBe(false);
    expect(r.atoms.length).toBeGreaterThanOrEqual(2);
  });

  for (const mu of MUTATIONS) {
    it(`变异(逐条种子):${mu.name}`, async () => {
      const keys = ruleKeys(await seedFiles());
      expect(keys.length).toBeGreaterThanOrEqual(2);
      for (const key of keys) {
        const files = await seedFiles();
        const before = files[key]!;
        expect([...before.matchAll(mu.find)].length).toBe(1);
        const after = before.replace(mu.find, mu.replace);
        expect(after).not.toBe(before);
        files[key] = after;
        const sb = await makeSandbox('seeds-mut-');
        const root = await writeRepo(sb, 'repo', files);
        const r = await lintRepo(root, { redactor: redactor() });
        expect(hasErrors(r.diagnostics), `${mu.name} @ ${key}`).toBe(true);
      }
    });
  }

  it('变异:删掉 CODEOWNERS 让 lint 变红', async () => {
    const files = await seedFiles();
    expect(Object.keys(files).filter((k) => k === 'CODEOWNERS').length).toBe(1);
    delete files['CODEOWNERS'];
    const sb = await makeSandbox('seeds-mut-');
    const root = await writeRepo(sb, 'repo', files);
    const r = await lintRepo(root, { redactor: redactor() });
    expect(hasErrors(r.diagnostics)).toBe(true);
  });
});
