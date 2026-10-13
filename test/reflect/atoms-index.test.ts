import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mkdirp, writeFile } from '../../src/io/safe-fs.js';
import {
  loadExistingAtoms,
  loadStagedAtoms,
  loadUsedProposalIds,
} from '../../src/reflect/atoms-index.js';
import { runReflect } from '../../src/reflect/run.js';
import { setupEnv } from '../fixtures/reflect/world.js';

describe('reflect/atoms-index', () => {
  it('读仓库已有原子;暂存区的原子与提案编号在运行后可见,再次运行会把它们当作「已有」', async () => {
    const env = await setupEnv();
    const repoAtoms = await loadExistingAtoms(env.w.io);
    expect(repoAtoms.map((a) => a.id)).toContain('keep-changes-minimal');
    expect(await loadStagedAtoms(env.w.io)).toEqual([]);
    expect([...(await loadUsedProposalIds(env.w.io))]).toEqual([]);

    await runReflect(env.deps, env.opts);
    const staged = await loadStagedAtoms(env.w.io);
    expect(staged.map((a) => a.id)).toEqual(['run-lint-before-commit']);
    expect([...(await loadUsedProposalIds(env.w.io))]).toEqual(['2026-10-12-001']);

    // 第二次运行:同样的回复因为与暂存区里的提案重复(id 冲突)而被丢
    const again = await runReflect(
      { ...env.deps, stagedAtoms: staged, usedProposalIds: await loadUsedProposalIds(env.w.io) },
      { ...env.opts, runId: 'run-test-2' },
    );
    expect(again.report.outcome).toBe('output_rejected');
    expect(again.report.rejected['id_conflict']).toBe(1);
  });
});

describe('reflect 暂存原子性', () => {
  it('没有 report.json 的半成品目录不算有效暂存;遗留临时目录使下一次写入明确失败', async () => {
    const env = await setupEnv();
    const half = path.join(env.w.io.stateDir, 'reflect', 'half-done');
    await mkdirp(env.w.io, path.join(half, 'rules', 'team'), 0o700);
    await writeFile(env.w.io, path.join(half, 'rules', 'team', 'x.md'), 'x', { mode: 0o600 });
    await mkdirp(env.w.io, path.join(half, 'proposals'), 0o700);
    await writeFile(env.w.io, path.join(half, 'proposals', '2026-10-12-007.yaml'), 'x', {
      mode: 0o600,
    });
    expect(await loadStagedAtoms(env.w.io)).toEqual([]);
    expect([...(await loadUsedProposalIds(env.w.io))]).toEqual([]);
    // 正向对照:补上 report.json 后目录才被认
    await writeFile(env.w.io, path.join(half, 'report.json'), '{}', { mode: 0o600 });
    expect([...(await loadUsedProposalIds(env.w.io))]).toEqual(['2026-10-12-007']);

    const tmp = path.join(env.w.io.stateDir, 'reflect', '.tmp-run-test-1');
    await mkdirp(env.w.io, tmp, 0o700);
    await expect(runReflect(env.deps, env.opts)).rejects.toMatchObject({
      code: 'STAGE_TMP_EXISTS',
    });
  });
});
