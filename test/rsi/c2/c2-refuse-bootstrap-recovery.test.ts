/**
 * C2 §8.4 的**端口级**钉子:装配层恒传 `refuseBootstrapRecovery`,`openPersonalRepo`(及所有经它的读写入口)对 bootstrap 类 journal 任一阶段都不恢复:
 * 不 `git init` / `update-ref`、不删 journal(`planned` + 目录不存在时原行为是删 journal,正是 S1 守卫之后的后续步骤会撞上的路径)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, readText } from '../../../src/io/read-fs.js';
import { openPersonalRepo, readPersonalFiles } from '../../../src/rsi/personal/commit.js';
import {
  PERSONAL_STATE_FILES,
  statePath,
  writeJournal,
} from '../../../src/rsi/personal/home-state.js';
import * as safe from '../../../src/io/safe-fs.js';
import { FAKE_LOCKS, makeWorld, repoDeps, type World } from '../personal/repo-helpers.js';

const phases = ['planned', 'initialized', 'committed'] as const;

async function plant(w: World, phase: (typeof phases)[number], emptyDir: boolean): Promise<string> {
  await writeJournal(w.h, {
    schema_version: 1,
    txn_id: '0123456789abcdef',
    kind: 'bootstrap',
    candidate_ids: [],
    ref: 'refs/heads/rsi',
    old_head: null,
    target_tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
    new_commit: phase === 'committed' ? 'a'.repeat(40) : null,
    phase,
    at: '2026-11-10T00:00:00Z',
  });
  if (emptyDir) await safe.mkdirp(w.io, w.h.repoDir, 0o700);
  return readText(statePath(w.h, PERSONAL_STATE_FILES.journal));
}

describe('C2 refuseBootstrapRecovery(bootstrap journal 任一阶段:不恢复、零写)', () => {
  for (const phase of phases) {
    for (const emptyDir of [false, true]) {
      it(`refuse_${phase}_dir_${emptyDir ? 'empty' : 'missing'} — openPersonalRepo / readPersonalFiles 返回 invalid{bootstrap_pending};journal 字节不变,.git 不出现`, async () => {
        const w = await makeWorld('c2-refuse-');
        const before = await plant(w, phase, emptyDir);
        const deps = { ...repoDeps(w), refuseBootstrapRecovery: true };
        const o = await openPersonalRepo(deps, FAKE_LOCKS, {});
        expect(o).toMatchObject({ kind: 'invalid', why: 'bootstrap_pending' });
        const r = await readPersonalFiles(deps, FAKE_LOCKS, ['lifecycle']);
        expect(r).toMatchObject({ status: 'invalid', why: 'bootstrap_pending' });
        expect(await readText(statePath(w.h, PERSONAL_STATE_FILES.journal))).toBe(before);
        expect(await exists(path.join(w.h.repoDir, '.git'))).toBe(false);
        expect(await exists(w.h.repoDir)).toBe(emptyDir);
      });
    }
  }

  it('control_without_refuse_planned_missing_dir_discards_journal — 不带开关时原行为是删 journal(开关确有作用)', async () => {
    const w = await makeWorld('c2-refuse-ctl-');
    await plant(w, 'planned', false);
    await openPersonalRepo(repoDeps(w), FAKE_LOCKS, {});
    expect(await exists(statePath(w.h, PERSONAL_STATE_FILES.journal))).toBe(false);
  });
});
