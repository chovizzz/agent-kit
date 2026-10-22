import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lintRepo } from '../../src/atoms/lint.js';
import { createGuardGit, runGuards } from '../../src/guards/index.js';
import { readDir, readText } from '../../src/io/read-fs.js';
import { runReflect } from '../../src/reflect/run.js';
import { mergeProposals, type MergedProposal } from '../../src/reflect/merge.js';
import {
  buildApplyPatch,
  filesOf,
  gitBlobOid,
  patchUnsafe,
  simulateGuards,
  stageDir,
} from '../../src/reflect/stage.js';
import { makeTestRepo, type TestRepo } from '../helpers/make-repo.js';
import {
  L1,
  L2,
  fakeKey,
  lintDraft,
  okText,
  out,
  setupEnv,
  testRedactor,
} from '../fixtures/reflect/world.js';
import { aliasFor, mergeInput, parsedDraft, worldPlan } from '../fixtures/reflect/plan.js';

const repos: TestRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.splice(0).map((r) => r.dispose()));
});

const BASE_ATOM = `---
id: existing-rule
title: 已有规则
layer: org
strength: should
kind: practice
volatility: stable
status: proposed
owner: '@tester'
created: 2026-10-01
review_by: 2027-01-01
evidence:
  - type: memory
    ref: x
    excerpt: 一条历史证据
verifier:
  type: none
---

**做**:只改必需的文件。
**为什么**:减少评审范围。
**怎么验**:看 diff。
`;

async function stagedRepo() {
  const env = await setupEnv();
  const r = await runReflect(env.deps, env.opts);
  expect(r.report.outcome).toBe('staged');
  const repo = await makeTestRepo('rl-stage-');
  repos.push(repo);
  const base = await repo.commit({
    CODEOWNERS: '* @tester\n',
    'rules/org/existing-rule.md': BASE_ATOM,
  });
  return { env, repo, base, patch: path.join(stageDir(env.w.io, 'run-test-1'), 'apply.patch') };
}

describe('reflect/stage apply.patch', () => {
  it('能被 git apply 干净应用;应用后 kit:reflector 守卫与原子 lint 全绿', async () => {
    const { repo, base, patch } = await stagedRepo();
    repo.git(['apply', '--check', patch]);
    repo.git(['apply', patch]);
    const head = await repo.commit({}, 'apply reflect patch');
    const res = runGuards({
      git: createGuardGit(repo.io, repo.dir, repo.gitEnv),
      base,
      head,
      label: 'kit:reflector',
    });
    // stub 反思器的提案无 backend / 带 stub:true:CI 侧来源核验(contracts #24)必须拒收,这是唯一允许的红灯;
    // 路径守卫 / G1 / G2 / G4 零诊断。
    expect(res.diagnostics.map((d) => d.code).sort()).toEqual([
      'GUARD_PROPOSAL_BACKEND_MISSING',
      'GUARD_PROPOSAL_STUB',
    ]);
    expect(res.changed).toBe(2);
    const lint = await lintRepo(repo.dir, { redactor: testRedactor() });
    expect(lint.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(lint.atoms.map((a) => a.fm.id).sort()).toEqual([
      'existing-rule',
      'run-lint-before-commit',
    ]);
    const added = lint.atoms.find((a) => a.fm.id === 'run-lint-before-commit')!;
    expect(added.fm.status).toBe('proposed');
    // 暂存的文件与补丁应用出来的文件逐字节相同
    const staged = await readText(
      path.join(path.dirname(patch), 'rules/team/run-lint-before-commit.md'),
    );
    expect(await readText(path.join(repo.dir, 'rules/team/run-lint-before-commit.md'))).toBe(
      staged,
    );
  });

  it('autocrlf=true、apply.whitespace=error 下同样干净应用', async () => {
    const { repo, patch } = await stagedRepo();
    repo.git([
      '-c',
      'core.autocrlf=true',
      '-c',
      'apply.whitespace=error',
      'apply',
      '--check',
      patch,
    ]);
    repo.git(['-c', 'apply.whitespace=error', 'apply', patch]);
  });

  it('补丁生成的边界:CR / 缺结尾换行 / 行尾空白 / 空文件 / 不安全路径都拒', () => {
    expect(patchUnsafe('a\n')).toBeUndefined();
    expect(patchUnsafe('a\r\n')).toBe('含 CR');
    expect(patchUnsafe('a')).toBe('缺结尾换行');
    expect(patchUnsafe('a \n')).toBe('含行尾空白');
    expect(patchUnsafe('')).toBe('文件为空');
    expect(() => buildApplyPatch([{ path: '../x.md', content: 'a\n' }])).toThrow();
    expect(() => buildApplyPatch([{ path: 'rules/Team/X.md', content: 'a\n' }])).toThrow();
    // blob oid 按 UTF-8 字节计算,与 git 一致
    expect(gitBlobOid('中\n')).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('reflect/stage 模拟守卫', () => {
  async function merged() {
    const plan = await worldPlan();
    const e = [aliasFor(plan.pack, L1), aliasFor(plan.pack, L2)];
    const ms = mergeProposals(mergeInput(plan, [parsedDraft({ evidence: e })]));
    return ms;
  }
  const simOpts = {
    redactor: testRedactor(),
    atomMaxBytes: 600,
    existingAtomIds: new Set<string>(),
  };
  const codes = (ds: { code: string }[]): string[] => [...new Set(ds.map((d) => d.code))].sort();

  it('正向对照:合并器的原样产物零红灯', async () => {
    const ms = await merged();
    expect(simulateGuards(ms, filesOf(ms), simOpts)).toEqual([]);
  });

  it('各类红灯各自被挡:status、disables、禁区路径、id 重名、模型名、证据残留', async () => {
    const [m] = await merged();
    const mut = (f: (t: string) => string, over: Partial<MergedProposal> = {}): string[] => {
      const mm = { ...m!, atomText: f(m!.atomText), ...over };
      return codes(simulateGuards([mm], filesOf([mm]), simOpts));
    };
    expect(mut((t) => t.replace('status: proposed', 'status: active'))).toContain(
      'GUARD_G1_NEW_ATOM_NOT_PROPOSED',
    );
    expect(
      mut((t) => t.replace('verifier:', 'disables:\n  - some-other-rule\nverifier:')),
    ).toContain('GUARD_G1_NEW_ATOM_HAS_EDGES');
    expect(mut((t) => t, { atomPath: 'hooks/run-lint-before-commit.md' })).toContain(
      'GUARD_PATH_FORBIDDEN',
    );
    expect(
      codes(
        simulateGuards([m!], filesOf([m!]), { ...simOpts, existingAtomIds: new Set([m!.atomId]) }),
      ),
    ).toContain('ATOM_ID_DUPLICATE');
    expect(mut((t) => t.replace('提交前先运行', '用 gpt-5.6-terra 提交前先运行'))).toContain(
      'ATOM_MODEL_NAME_IN_CORE',
    );
    expect(
      mut((t) => t.replace(/excerpt: .*CANARY_UM_ok.*/, `excerpt: 登录用 ${fakeKey('s')}`)),
    ).toContain('ATOM_EVIDENCE_REDACTION_RESIDUAL');
    expect(mut((t) => t.replace('做**:', '做**:  \r'))).toContain('STAGE_PATCH_UNSAFE');
  });

  it('有红灯整批不暂存:模型名混进正文 → output_rejected,只有 report.json', async () => {
    const env = await setupEnv((req) =>
      okText(out(lintDraft(req.user, { do: '用 gpt-5.6-terra 评审后再提交。' }))),
    );
    const r = await runReflect(env.deps, env.opts);
    expect(r.report.outcome).toBe('output_rejected');
    expect(r.report.rejected['ATOM_MODEL_NAME_IN_CORE']).toBe(1);
    expect(r.staged).toBeUndefined();
    const dir = stageDir(env.w.io, 'run-test-1');
    expect((await readDir(dir)).map((e) => e.name)).toEqual(['report.json']);
  });
});
