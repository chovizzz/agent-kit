import { afterEach, describe, expect, it } from 'vitest';
import { guardsDeps, run } from '../../src/commands/guards-cmd.js';
import type { CheckOptions, CommandContext } from '../../src/commands/types.js';
import { ATOM_PATH, atom } from '../fixtures/guards/atoms.js';
import { makeTestRepo } from '../helpers/make-repo.js';
import type { TestRepo } from '../helpers/make-repo.js';
import { PASS } from './helpers.js';

const repos: TestRepo[] = [];
afterEach(async () => {
  guardsDeps.criteria = undefined;
  await Promise.all(repos.splice(0).map((r) => r.dispose()));
});

async function setup(baseStatus: string, headStatus: string): Promise<TestRepo> {
  const repo = await makeTestRepo();
  repos.push(repo);
  await repo.commit({ [ATOM_PATH]: atom({ status: baseStatus }) }, 'base');
  repo.tag('kit-base');
  await repo.commit({ [ATOM_PATH]: atom({ status: headStatus }) }, 'head');
  repo.tag('kit-head');
  return repo;
}

async function exec(repo: TestRepo, opts: Partial<CheckOptions>) {
  let out = '';
  let err = '';
  const ctx: CommandContext = {
    argv: [],
    io: repo.io,
    overlayPath: undefined,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  };
  const code = await run(ctx, {
    guards: true,
    base: 'kit-base',
    head: 'kit-head',
    label: undefined,
    report: false,
    ...opts,
  });
  return { code, out, err };
}

describe('check --guards(guards-cmd 子 runner)', () => {
  it('合规 → 0,并打印一行摘要;不再是桩(不输出「未实现」)', async () => {
    const repo = await setup('proposed', 'proposed');
    const r = await exec(repo, {});
    expect(r.code).toBe(0);
    expect(r.out).toMatch(
      /^guards: base=[0-9a-f]{12} head=[0-9a-f]{12} label=\(none\); \d+ 个文件变更; 0 error, 0 warn\n$/,
    );
    expect(r.err).toBe('');
  });

  it('违规 → 1,stdout 列出稳定诊断码', async () => {
    const repo = await setup('proposed', 'active');
    const r = await exec(repo, {});
    expect(r.code).toBe(1);
    expect(r.out).toContain(`error GUARD_G2_STATUS_CHANGED ${ATOM_PATH}:`);
    expect(r.out).toContain('1 error');
  });

  it('--label kit:promotion:合法方向但缺判据证据 → 1(L2 起是真判据,不再是桩);注入检查器后 → 0', async () => {
    const repo = await setup('proposed', 'advisory');
    const real = await exec(repo, { label: 'kit:promotion' });
    expect(real.code).toBe(1);
    expect(real.out).not.toContain('GUARD_G3_CRITERIA_NOT_IMPLEMENTED');
    // 夹具原子没有 origin=proposal/…:真判据按 PROPOSAL_MISSING 拒绝
    expect(real.out).toContain('GUARD_G3_PROPOSAL_MISSING');
    guardsDeps.criteria = PASS;
    const ok = await exec(repo, { label: 'kit:promotion' });
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('label=kit:promotion');
  });

  it('--label 与方向不符 → 1;未知标签 → 2(用法错误)', async () => {
    const repo = await setup('proposed', 'advisory');
    guardsDeps.criteria = PASS;
    const mismatch = await exec(repo, { label: 'kit:retire' });
    expect(mismatch.code).toBe(1);
    expect(mismatch.out).toContain('GUARD_G3_DIRECTION_NOT_ALLOWED');
    const unknown = await exec(repo, { label: 'kit:nope' });
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('未知标签');
  });

  it('ref 解析不了 → 2;缺 base/head → 2', async () => {
    const repo = await setup('proposed', 'proposed');
    const r = await exec(repo, { base: 'no-such-ref' });
    expect(r.code).toBe(2);
    expect(r.err).toContain('无法把 --base');
    expect((await exec(repo, { head: undefined })).code).toBe(2);
    expect((await exec(repo, { base: undefined })).code).toBe(2);
  });

  it('不是 git 仓库(或找不到 ref)→ 2,不会报绿', async () => {
    const repo = await setup('proposed', 'proposed');
    await repo.dispose();
    repos.length = 0;
    const tmp = await makeTestRepo();
    repos.push(tmp);
    // 删掉 .git:仓库根仍存在但不是 git 仓库
    const { remove } = await import('../../src/io/safe-fs.js');
    await remove(tmp.io, `${tmp.dir}/.git`);
    const r = await exec(tmp, {});
    expect(r.code).toBe(2);
  });
});
