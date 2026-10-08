import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintRepo } from '../../src/atoms/lint.js';
import * as safe from '../../src/io/safe-fs.js';
import { GOOD_ATOM, makeRepo, OWNER_LINE, STUB_MARKER, stubRedactor } from './helpers.js';

const BASE = { CODEOWNERS: OWNER_LINE, 'cases/x/case.yaml': 'name: x\n' };
const codes = (r: { diagnostics: { code: string }[] }): string[] =>
  r.diagnostics.map((d) => d.code);

describe('脱敏复扫的注入语义', () => {
  const leaky = GOOD_ATOM.replace('合成的证据摘录', `含 ${STUB_MARKER} 的摘录`);

  it('未注入 Redactor:不静默通过,整次运行给一条 warn', async () => {
    const { root } = await makeRepo({ ...BASE, 'rules/team/good-atom.md': leaky });
    const r = await lintRepo(root);
    expect(r.diagnostics).toEqual([
      expect.objectContaining({ code: 'ATOM_EVIDENCE_NOT_SCANNED', severity: 'warn' }),
    ]);
  });

  it('正向对照:合法原子 + 桩 Redactor = 零诊断,且 pass2 确实被调用', async () => {
    const { root } = await makeRepo({ ...BASE, 'rules/team/good-atom.md': GOOD_ATOM });
    const seen: string[] = [];
    const r = await lintRepo(root, {
      redactor: {
        pass2(t) {
          seen.push(t);
          return { clean: true, hits: [] };
        },
      },
    });
    expect(r.diagnostics).toEqual([]);
    expect(seen).toEqual(['合成的证据摘录']);
  });

  it('命中残留:error,且诊断(message/path)里不含命中的文本', async () => {
    const { root } = await makeRepo({ ...BASE, 'rules/team/good-atom.md': leaky });
    const r = await lintRepo(root, { redactor: stubRedactor });
    expect(codes(r)).toEqual(['ATOM_EVIDENCE_REDACTION_RESIDUAL']);
    expect(JSON.stringify(r.diagnostics)).not.toContain(STUB_MARKER);
    expect(r.scanErrors).toBe(0);
  });

  it('pass2 抛错:fail-closed 的 error,并计入 scanErrors(调用方据此退出 3)', async () => {
    const { root } = await makeRepo({ ...BASE, 'rules/team/good-atom.md': GOOD_ATOM });
    const r = await lintRepo(root, {
      redactor: {
        pass2() {
          throw new Error('boom: 内部细节不应进诊断');
        },
      },
    });
    expect(codes(r)).toEqual(['ATOM_EVIDENCE_SCAN_ERROR']);
    expect(r.scanErrors).toBe(1);
    expect(JSON.stringify(r.diagnostics)).not.toContain('内部细节');
  });

  it('每条证据各扫一次,path 指向对应下标', async () => {
    const two = GOOD_ATOM.replace(
      '    excerpt: 合成的证据摘录\n',
      `    excerpt: 干净\n  - type: trace\n    ref: x\n    excerpt: ${STUB_MARKER}\n`,
    );
    const { root } = await makeRepo({ ...BASE, 'rules/team/good-atom.md': two });
    const r = await lintRepo(root, { redactor: stubRedactor });
    expect(r.diagnostics.map((d) => d.path)).toEqual([
      'rules/team/good-atom.md#/evidence/1/excerpt',
    ]);
  });
});

describe('verifier.ref 的符号链接逃逸', () => {
  it('ref 指向仓库内、但经符号链接解析到仓库外 → ATOM_VERIFIER_REF_INVALID(正向对照:普通目录通过)', async () => {
    const { root, wctx } = await makeRepo({
      CODEOWNERS: OWNER_LINE,
      'rules/team/good-atom.md': GOOD_ATOM.replace('cases/x/', 'cases/link/'),
    });
    const outside = path.join(path.dirname(root), 'outside');
    await safe.mkdirp(wctx, outside);
    await safe.mkdirp(wctx, path.join(root, 'cases'));
    await safe.symlink(wctx, outside, path.join(root, 'cases/link'));
    const bad = await lintRepo(root, { redactor: stubRedactor });
    expect(codes(bad)).toEqual(['ATOM_VERIFIER_REF_INVALID']);

    await safe.remove(wctx, path.join(root, 'cases/link'));
    await safe.mkdirp(wctx, path.join(root, 'cases/link'));
    const good = await lintRepo(root, { redactor: stubRedactor });
    expect(good.diagnostics).toEqual([]);
  });
});

describe('顶层目录本身是符号链接', () => {
  it('rules / skills / agents 是指向仓库外的符号链接 → error,且不读取链接目标里的内容', async () => {
    const { root, wctx } = await makeRepo({ CODEOWNERS: OWNER_LINE });
    const ext = path.join(path.dirname(root), 'external');
    await safe.mkdirp(wctx, path.join(ext, 'rules/team'));
    await safe.mkdirp(wctx, path.join(ext, 'skills/my-skill'));
    await safe.mkdirp(wctx, path.join(ext, 'agents'));
    await safe.writeFile(wctx, path.join(ext, 'rules/team/good-atom.md'), GOOD_ATOM);
    await safe.writeFile(
      wctx,
      path.join(ext, 'skills/my-skill/SKILL.md'),
      '---\nname: my-skill\ndescription: x\n---\n',
    );
    await safe.writeFile(wctx, path.join(ext, 'agents/a.yaml'), 'name: a\n');
    await safe.symlink(wctx, path.join(ext, 'rules'), path.join(root, 'rules'));
    await safe.symlink(wctx, path.join(ext, 'skills'), path.join(root, 'skills'));
    await safe.symlink(wctx, path.join(ext, 'agents'), path.join(root, 'agents'));
    const r = await lintRepo(root, { redactor: stubRedactor });
    expect(r.diagnostics.map((d) => [d.code, d.path])).toEqual([
      ['AGENT_SYMLINK_NOT_ALLOWED', 'agents'],
      ['ATOM_SYMLINK_NOT_ALLOWED', 'rules'],
      ['SKILL_SYMLINK_NOT_ALLOWED', 'skills'],
    ]);
    expect(r.atoms).toEqual([]);
    expect(r.skills).toEqual([]);
  });

  it('agents/ 下的符号链接文件是 error(不是被忽略的 warn)', async () => {
    const { root, wctx } = await makeRepo({
      'agents/real.yaml':
        'name: real\ndescription: d\nprompt: p\ntools: [read]\nmodel_tier: judge\n',
    });
    await safe.symlink(
      wctx,
      path.join(root, 'agents/real.yaml'),
      path.join(root, 'agents/alias.yaml'),
    );
    const r = await lintRepo(root);
    expect(r.diagnostics.map((d) => [d.code, d.severity, d.path])).toEqual([
      ['AGENT_SYMLINK_NOT_ALLOWED', 'error', 'agents/alias.yaml'],
    ]);
  });
});

describe('规则文件内的符号链接与隐藏文件', () => {
  it('规则目录里的符号链接被拒,点文件被忽略', async () => {
    const { root, wctx } = await makeRepo({
      ...BASE,
      'rules/team/good-atom.md': GOOD_ATOM,
      'rules/team/.DS_Store': 'x',
    });
    await safe.symlink(
      wctx,
      path.join(root, 'rules/team/good-atom.md'),
      path.join(root, 'rules/team/alias.md'),
    );
    const r = await lintRepo(root, { redactor: stubRedactor });
    expect(r.diagnostics.map((d) => [d.code, d.path])).toEqual([
      ['ATOM_SYMLINK_NOT_ALLOWED', 'rules/team/alias.md'],
    ]);
  });
});

describe('技能目录', () => {
  const skillMd = '---\nname: my-skill\ndescription: 示例技能。\n---\n\n正文。\n';

  it('files 递归列出、按路径字节序、带字节数与 sha256;SKILL.md 正文去掉 frontmatter', async () => {
    const { root } = await makeRepo({
      'skills/my-skill/SKILL.md': skillMd,
      'skills/my-skill/scripts/b.sh': 'echo b\n',
      'skills/my-skill/scripts/a.sh': 'echo a\n',
      'skills/my-skill/assets/x.txt': 'x',
    });
    const r = await lintRepo(root);
    expect(r.diagnostics).toEqual([]);
    const s = r.skills[0]!;
    expect(s.sourceDir).toBe('skills/my-skill');
    expect(s.files.map((f) => f.relPath)).toEqual([
      'SKILL.md',
      'assets/x.txt',
      'scripts/a.sh',
      'scripts/b.sh',
    ]);
    expect(s.files.find((f) => f.relPath === 'assets/x.txt')).toMatchObject({
      bytes: 1,
      sha256: '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881',
    });
    expect(s.body.trim()).toBe('正文。');
  });

  it('技能目录内的符号链接被拒', async () => {
    const { root, wctx } = await makeRepo({ 'skills/my-skill/SKILL.md': skillMd });
    await safe.symlink(
      wctx,
      path.join(root, 'skills/my-skill/SKILL.md'),
      path.join(root, 'skills/my-skill/link.md'),
    );
    const r = await lintRepo(root);
    expect(r.diagnostics.map((d) => [d.code, d.path])).toEqual([
      ['SKILL_SYMLINK_NOT_ALLOWED', 'skills/my-skill/link.md'],
    ]);
  });
});

describe('扫描顺序确定', () => {
  it('同一仓库连跑两次,诊断序列逐字相同', async () => {
    const { root } = await makeRepo({
      ...BASE,
      'rules/team/b-rule.md': GOOD_ATOM.replace('good-atom', 'a-rule'),
      'rules/team/a-rule.md': GOOD_ATOM.replace('good-atom', 'zzz'),
    });
    const a = await lintRepo(root, { redactor: stubRedactor });
    const b = await lintRepo(root, { redactor: stubRedactor });
    expect(a.diagnostics).toEqual(b.diagnostics);
    expect(a.diagnostics.length).toBe(2);
  });
});
