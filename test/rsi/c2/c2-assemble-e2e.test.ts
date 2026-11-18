/**
 * C2 生产装配(真 `runWorker` + 真适配器 + 假 HOME):私有仓库尚未建立(生产常态)时 S1 / S2 全程无故障;
 * **bootstrap 类 journal 在场时 S1 不续建仓**(`.git` 不出现、journal 字节不变,`recovery_incomplete{bootstrap_pending}`);
 * 凭据冲突 / 缺省时间线等细节由纯编排测试(`c2-steps-*`)与 `writeRevocationDetailed` 测试覆盖。
 */
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RSI_ASSEMBLY_CAPS } from '../../../src/contracts/rsi-phase-caps.js';
import { exists, readText } from '../../../src/io/read-fs.js';
import { assembleWorkerStage, bindWorkerPersonal } from '../../../src/rsi/assemble-worker.js';
import {
  PERSONAL_REPO_REL,
  PERSONAL_STATE_FILES,
  personalHome,
  statePath,
  writeJournal,
} from '../../../src/rsi/personal/home-state.js';
import type { PersonalRound } from '../../../src/rsi/personal/stage/types.js';
import { runWorker, type RsiWorkerRunDeps } from '../../../src/rsi/worker.js';
import { type TickFx, makeTickFx } from '../b5a-fixture.js';
import { NOW } from '../ro-fixture.js';

const T = Date.parse(NOW);
const ALL_CAPS = new Set<string>(RSI_ASSEMBLY_CAPS);

async function withRealHome<T>(f: TickFx, run: () => Promise<T>): Promise<T> {
  vi.stubEnv('KIT_REAL_HOME_OVERRIDE', f.home);
  try {
    return await run();
  } finally {
    vi.unstubAllEnvs();
  }
}

async function runOnce(f: TickFx): Promise<{ rounds: PersonalRound[]; outcome: string }> {
  const real = assembleWorkerStage({ phase: 1, wired: ALL_CAPS });
  const rounds: PersonalRound[] = [];
  const stage = {
    eligible: () => real.eligible(),
    run: async (ctx: Parameters<typeof real.run>[0]) => {
      const r = await real.run(ctx);
      rounds.push(r);
      return r;
    },
    safetyFallback: (ctx: Parameters<typeof real.safetyFallback>[0]) => real.safetyFallback(ctx),
  };
  const deps: RsiWorkerRunDeps = {
    env: f.env,
    writeAudit: () => undefined,
    now: () => new Date(T),
    nowMs: () => T,
    personal: bindWorkerPersonal(stage),
  };
  const r = await withRealHome(f, () => runWorker(deps));
  return { rounds, outcome: r.kind === 'ran' ? r.outcome : r.kind };
}

describe('C2 生产装配(真 worker)', () => {
  it('私有仓库未建:S1 / S2 全程无故障,growth open,个人锁已释放,不建 .git', async () => {
    const f = await makeTickFx('c2-asm-quiet-', { confirmed: true });
    const { rounds, outcome } = await runOnce(f);
    expect(outcome).toBe('ok');
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.faults).toEqual([]);
    expect(rounds[0]?.growth.kind).toBe('open');
    expect(rounds[0]?.unsettled).toEqual([]);
    expect(await exists(path.join(f.home, PERSONAL_REPO_REL, '.git'))).toBe(false);
  });

  it('s1_never_resumes_bootstrap_without_authorization — bootstrap journal(planned / initialized / committed)→ S1 不续建仓,incomplete{bootstrap_pending};.git 不出现、journal 字节不变', async () => {
    for (const phase of ['planned', 'initialized', 'committed'] as const) {
      const f = await makeTickFx(`c2-asm-boot-${phase}-`, { confirmed: true });
      const h = personalHome(f.io, f.home);
      const j = {
        schema_version: 1 as const,
        txn_id: '0123456789abcdef',
        kind: 'bootstrap' as const,
        candidate_ids: [],
        ref: 'refs/heads/rsi' as const,
        old_head: null,
        target_tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
        new_commit: phase === 'committed' ? 'a'.repeat(40) : null,
        phase,
        at: '2026-11-10T00:00:00Z',
      };
      await withRealHome(f, () => writeJournal(h, j));
      const journalFile = statePath(h, PERSONAL_STATE_FILES.journal);
      const before = (await exists(journalFile)) ? await readText(journalFile) : null;
      const { rounds } = await runOnce(f);
      expect(rounds[0]?.faults, phase).toContainEqual({
        code: 'step_halted',
        detail: 'recovery_incomplete:bootstrap_pending',
      });
      expect(await exists(path.join(f.home, PERSONAL_REPO_REL, '.git')), phase).toBe(false);
      const after = (await exists(journalFile)) ? await readText(journalFile) : null;
      expect(after, phase).toBe(before);
    }
  });
});
