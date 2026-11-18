/**
 * D1b-1:`openPersonalRepo` 判别联合(`read` / `complete_only` / `bootstrap`)与 S1 只用 `complete_only`(真 git、真 journal、崩溃注入)。
 * 去向:取代 C2 的 `c2-refuse-bootstrap-recovery.test.ts`(`refuseBootstrapRecovery` 开关与 S1 前置守卫一并删除,同一不变量改由端口模式保证)。
 * 「bootstrap 相关零写」:无 `git init` / `mktree` / `commit-tree` / `update-ref`(以 onStep 观测点与盘上状态判定)、journal 字节不变、仓库目录与 `.git` 不出现 / 不变、
 * ref 不变;`ensureEmptyDir` 的空钩子目录是既有行为(与 bootstrap 无关),不在断言范围内。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, readText } from '../../../src/io/read-fs.js';
import * as safe from '../../../src/io/safe-fs.js';
import { RsiLockError } from '../../../src/rsi/lock-error.js';
import {
  commitPersonal,
  openPersonalRepo,
  readPersonalFiles,
  type BootstrapAuth,
  type BootstrapStep,
  type OpenOpts,
} from '../../../src/rsi/personal/commit.js';
import {
  BootstrapDenied,
  EMPTY_TREE,
  NO_BOOTSTRAP_AUTH,
} from '../../../src/rsi/personal/commit-journal.js';
import {
  PERSONAL_STATE_FILES,
  readHead,
  readJournal,
  statePath,
  writeJournal,
} from '../../../src/rsi/personal/home-state.js';
import { personalRepoStore } from '../../../src/rsi/personal/candidate-repo.js';
import { PersonalLockLost } from '../../../src/rsi/personal/stage/errors.js';
import { createRepoRecovery, outcomeOfOpen } from '../../../src/rsi/personal/steps/repo-recover.js';
import {
  BASE_FILES,
  crashAt,
  FAKE_LOCKS,
  git,
  gitRaw,
  InjectedCrash,
  makeWorld,
  READ_OPTS,
  repoDeps,
  slowTests,
  spec,
  TEST_BOOTSTRAP_AUTH,
  withLock,
  type World,
} from '../personal/repo-helpers.js';

slowTests();

const COMPLETE_ONLY: OpenOpts = { mode: 'complete_only' };

/** 记录调用的授权假件;`deny` 命中的边界抛 `err`(缺省普通 Error) */
function spyAuth(deny?: { step: BootstrapStep; err?: Error }): {
  auth: BootstrapAuth;
  calls: BootstrapStep[];
  opts: OpenOpts;
} {
  const calls: BootstrapStep[] = [];
  const auth: BootstrapAuth = {
    authorize: async (step) => {
      calls.push(step);
      if (deny?.step === step) throw deny.err ?? new Error(`no:${step}`);
    },
  };
  return { auth, calls, opts: { mode: 'bootstrap', auth } };
}

function open(w: World, opts: OpenOpts, onStep?: (s: string) => void) {
  return withLock(w, (locks) =>
    openPersonalRepo(repoDeps(w, onStep === undefined ? {} : { onStep }), locks, opts),
  );
}

/** 起一次 bootstrap,在命名步骤点「进程死亡」 */
async function crashAtStep(w: World, step: string): Promise<void> {
  await expect(
    withLock(w, (locks) =>
      openPersonalRepo(repoDeps(w, { onStep: crashAt(step) }), locks, {
        mode: 'bootstrap',
        auth: TEST_BOOTSTRAP_AUTH,
      }),
    ),
  ).rejects.toBeInstanceOf(InjectedCrash);
}

const SCENARIOS = [
  'planned_missing', // journal planned,目录不存在
  'planned_empty', // journal planned,目录已建、尚未 init
  'planned_after_init', // git init 已成功、journal 仍 planned
  'initialized', // journal initialized,无提交
  'initialized_after_cas', // update-ref 已成功、journal 仍 initialized
  'committed',
  'recorded',
] as const;
type Scenario = (typeof SCENARIOS)[number];
/** `complete_only` 必须原样放过的(planned / initialized 两类) */
const EARLY = SCENARIOS.filter((s) => !['committed', 'recorded'].includes(s));

async function plant(w: World, sc: Scenario): Promise<void> {
  switch (sc) {
    case 'planned_missing':
      return crashAtStep(w, 'journal:planned');
    case 'planned_empty':
      return crashAtStep(w, 'bootstrap:dir_ready');
    case 'planned_after_init': {
      await crashAtStep(w, 'journal:initialized');
      const j = await readJournal(w.h);
      if (j.kind !== 'ok') throw new Error('journal');
      await writeJournal(w.h, { ...j.value, phase: 'planned', new_commit: null });
      return;
    }
    case 'initialized':
      return crashAtStep(w, 'journal:initialized');
    case 'initialized_after_cas': {
      await crashAtStep(w, 'bootstrap:before:update-ref');
      const c = git(w, ['commit-tree', EMPTY_TREE, '-m', 'rsi: bootstrap']);
      git(w, ['update-ref', 'refs/heads/rsi', c]);
      return;
    }
    case 'committed':
      return crashAtStep(w, 'journal:committed');
    case 'recorded':
      return crashAtStep(w, 'journal:recorded');
  }
}

const journalFile = (w: World): string => statePath(w.h, PERSONAL_STATE_FILES.journal);
const objectFile = (w: World, sha: string): string =>
  path.join(w.h.repoDir, '.git', 'objects', sha.slice(0, 2), sha.slice(2));

/** 「bootstrap 相关」状态指纹:journal 字节、目录 / .git 是否存在、ref 值、head.json */
async function fingerprint(w: World) {
  const hasGit = await exists(path.join(w.h.repoDir, '.git'));
  return {
    journal: (await exists(journalFile(w))) ? await readText(journalFile(w)) : null,
    repoDir: await exists(w.h.repoDir),
    hasGit,
    ref: hasGit ? gitRaw(w, ['rev-parse', '--verify', '-q', 'refs/heads/rsi']).stdout : null,
    head: (await readHead(w.h)).kind,
  };
}

describe('read 模式:bootstrap 类 journal 一律不动', () => {
  it.each(SCENARIOS)(
    'read_mode_never_touches_bootstrap_journal_%s — bootstrap_pending;commitPersonal / readPersonalFiles = invalid{bootstrap_pending};bootstrap 相关零写',
    async (sc) => {
      const w = await makeWorld('d1b1-read-');
      await plant(w, sc);
      const before = await fingerprint(w);
      const steps: string[] = [];
      expect(await open(w, READ_OPTS, (s) => steps.push(s))).toEqual({ kind: 'bootstrap_pending' });
      expect(
        await withLock(w, (l) => readPersonalFiles(repoDeps(w), l, ['lifecycle'])),
      ).toMatchObject({
        status: 'invalid',
        why: 'bootstrap_pending',
        breaker: 'personal_repo_invalid',
      });
      expect(
        await withLock(w, (l) => commitPersonal(repoDeps(w), l, spec('9', BASE_FILES))),
      ).toMatchObject({
        status: 'invalid',
        why: 'bootstrap_pending',
        breaker: 'personal_repo_invalid',
      });
      expect(steps).toEqual([]);
      expect(await fingerprint(w)).toEqual(before);
    },
  );

  it('control_bootstrap_mode_recovers_what_read_mode_leaves — 同一个 planned + 目录缺失,bootstrap 模式续做到 ready(模式确有作用)', async () => {
    const w = await makeWorld('d1b1-ctl-');
    await plant(w, 'planned_missing');
    const a = spyAuth();
    const o = await open(w, a.opts);
    expect(o.kind).toBe('ready');
    expect(a.calls).toEqual(['init', 'cas']);
    expect(await exists(journalFile(w))).toBe(false);
  });

  it('read 模式:首次(无 journal、无仓库)→ absent,什么也不建', async () => {
    const w = await makeWorld('d1b1-read-first-');
    expect(await open(w, READ_OPTS)).toEqual({ kind: 'absent' });
    expect(await exists(w.h.repoDir)).toBe(false);
  });
});

describe('complete_only:只做 committed → recorded', () => {
  it.each(EARLY)(
    'complete_only_planned_initialized_never_init_or_cas_%s — bootstrap_pending;无任何步骤点、journal 字节与仓库状态不变',
    async (sc) => {
      const w = await makeWorld('d1b1-co-early-');
      await plant(w, sc);
      const before = await fingerprint(w);
      const steps: string[] = [];
      expect(await open(w, COMPLETE_ONLY, (s) => steps.push(s))).toEqual({
        kind: 'bootstrap_pending',
      });
      expect(steps).toEqual([]);
      expect(await fingerprint(w)).toEqual(before);
    },
  );

  it('complete_only:首次(无 journal、无仓库)→ absent,不建仓', async () => {
    const w = await makeWorld('d1b1-co-first-');
    expect(await open(w, COMPLETE_ONLY)).toEqual({ kind: 'absent' });
    expect(await exists(w.h.repoDir)).toBe(false);
  });

  it('complete_only_committed_completes_with_matching_ref_and_tree — 真实 ref 与树吻合 → recorded、写 head.json、删 journal;不 init / 不 CAS', async () => {
    const w = await makeWorld('d1b1-co-committed-');
    await plant(w, 'committed');
    const steps: string[] = [];
    const o = await open(w, COMPLETE_ONLY, (s) => steps.push(s));
    if (o.kind !== 'ready') throw new Error(JSON.stringify(o));
    expect(steps).toContain('journal:recorded');
    for (const never of [
      'journal:initialized',
      'bootstrap:dir_ready',
      'bootstrap:before:update-ref',
    ]) {
      expect(steps).not.toContain(never);
    }
    expect(git(w, ['rev-parse', 'refs/heads/rsi'])).toBe(o.head);
    expect(await readHead(w.h)).toMatchObject({ kind: 'ok', value: { head: o.head } });
    expect(await exists(journalFile(w))).toBe(false);
  });

  it('complete_only_recorded_finishes_head — recorded(head.json 未写)→ 写 head.json、删 journal', async () => {
    const w = await makeWorld('d1b1-co-recorded-');
    await plant(w, 'recorded');
    expect(await readHead(w.h)).toEqual({ kind: 'absent' });
    const o = await open(w, COMPLETE_ONLY);
    if (o.kind !== 'ready') throw new Error(JSON.stringify(o));
    expect(await readHead(w.h)).toMatchObject({ kind: 'ok', value: { head: o.head } });
    expect(await exists(journalFile(w))).toBe(false);
  });

  it('complete_only_committed_mismatched_ref_invalid_journal_kept — ref 被改成别的值 → invalid{bootstrap_inconsistent};journal 保留,不写 head.json', async () => {
    const w = await makeWorld('d1b1-co-tamper-');
    await plant(w, 'committed');
    const other = git(w, ['commit-tree', EMPTY_TREE, '-m', 'someone else']);
    git(w, ['update-ref', 'refs/heads/rsi', other]);
    const o = await open(w, COMPLETE_ONLY);
    expect(o).toMatchObject({ kind: 'invalid', why: 'bootstrap_inconsistent' });
    expect(await readText(journalFile(w))).toContain('"committed"');
    expect(await readHead(w.h)).toEqual({ kind: 'absent' });
  });

  it.each(['committed', 'recorded'] as const)(
    'complete_only_%s_nonempty_tree_commit_invalid_journal_kept — journal 与 ref 同指一个带文件的提交(索引 / 工作树与之一致)→ invalid{bootstrap_inconsistent}',
    async (sc) => {
      const w = await makeWorld('d1b1-co-tree-');
      await plant(w, sc);
      const blob = git(w, ['hash-object', '-w', '--stdin'], { input: 'x\n' });
      const tree = git(w, ['mktree'], { input: `100644 blob ${blob}\tf.txt\n` });
      const c = git(w, ['commit-tree', tree, '-m', 'not bootstrap']);
      git(w, ['update-ref', 'refs/heads/rsi', c]);
      git(w, ['reset', '--hard', '-q', c]);
      const j = await readJournal(w.h);
      if (j.kind !== 'ok') throw new Error('journal');
      await writeJournal(w.h, { ...j.value, new_commit: c });
      expect(await open(w, COMPLETE_ONLY)).toMatchObject({
        kind: 'invalid',
        why: 'bootstrap_inconsistent',
      });
      expect(await exists(journalFile(w))).toBe(true);
      expect(await readHead(w.h)).toEqual({ kind: 'absent' });
    },
  );

  it('complete_only_committed_dirty_worktree_invalid_journal_kept — 工作树多了未跟踪文件(树不符)→ invalid{bootstrap_inconsistent}', async () => {
    const w = await makeWorld('d1b1-co-dirty-');
    await plant(w, 'committed');
    await safe.writeFile(w.io, path.join(w.h.repoDir, 'scratch.txt'), 'x\n');
    expect(await open(w, COMPLETE_ONLY)).toMatchObject({
      kind: 'invalid',
      why: 'bootstrap_inconsistent',
    });
    expect(await exists(journalFile(w))).toBe(true);
    expect(await readHead(w.h)).toEqual({ kind: 'absent' });
  });
});

describe('命令路径(personalRepoStore,repoDeps 与 assemble-write 同形:无任何开关)', () => {
  it.each(['planned_missing', 'initialized', 'committed'] as const)(
    'write_path_never_resumes_bootstrap_%s — readAll / commit 遇 bootstrap journal = invalid{bootstrap_pending};零步骤点,journal 与仓库状态不变',
    async (sc) => {
      const w = await makeWorld('d1b1-wpath-');
      await plant(w, sc);
      const before = await fingerprint(w);
      const steps: string[] = [];
      const out = await withLock(w, async (locks) => {
        const store = personalRepoStore(repoDeps(w, {
            onStep: (s) => {
              steps.push(s);
            },
          }), locks);
        return { read: await store.readAll(), commit: await store.commit(spec('9', BASE_FILES)) };
      });
      expect(out.read).toEqual({ kind: 'invalid', why: 'bootstrap_pending' });
      expect(out.commit).toMatchObject({ status: 'invalid', why: 'bootstrap_pending' });
      expect(steps).toEqual([]);
      expect(await fingerprint(w)).toEqual(before);
    },
  );
});

describe('S1 端口(真 openPersonalRepo complete_only + createRepoRecovery)', () => {
  const s1 = (w: World, onStep?: (s: string) => void) =>
    createRepoRecovery({
      open: async () => outcomeOfOpen(await open(w, COMPLETE_ONLY, onStep)),
    })();

  it.each(EARLY)(
    's1_planned_initialized_never_init_or_cas_%s — incomplete{bootstrap_pending}(不熔断);零步骤点,journal 字节与仓库状态不变',
    async (sc) => {
      const w = await makeWorld('d1b1-s1-early-');
      await plant(w, sc);
      const before = await fingerprint(w);
      const steps: string[] = [];
      expect(await s1(w, (s) => steps.push(s))).toEqual({
        kind: 'incomplete',
        why: 'bootstrap_pending',
      });
      expect(steps).toEqual([]);
      expect(await fingerprint(w)).toEqual(before);
    },
  );

  it('s1_committed_bootstrap_completes_with_matching_ref_and_tree — judged at_record;journal 已删、head.json 已写', async () => {
    const w = await makeWorld('d1b1-s1-committed-');
    await plant(w, 'committed');
    expect(await s1(w)).toEqual({ kind: 'judged', judgement: 'at_record' });
    expect(await exists(journalFile(w))).toBe(false);
    expect(await readHead(w.h)).toMatchObject({ kind: 'ok' });
  });

  it('s1_committed_bootstrap_mismatched_ref_invalid_journal_kept — 熔断(invalid);journal 保留,不写 head.json', async () => {
    const w = await makeWorld('d1b1-s1-tamper-');
    await plant(w, 'committed');
    const other = git(w, ['commit-tree', EMPTY_TREE, '-m', 'someone else']);
    git(w, ['update-ref', 'refs/heads/rsi', other]);
    expect(await s1(w)).toEqual({ kind: 'invalid' });
    expect(await readText(journalFile(w))).toContain('"committed"');
    expect(await readHead(w.h)).toEqual({ kind: 'absent' });
  });

  it('s1_invalid_journal_is_invalid — journal 不合规 → invalid(由端口自己判,不再有前置守卫)', async () => {
    const w = await makeWorld('d1b1-s1-badjournal-');
    await plant(w, 'planned_missing');
    await safe.writeFile(w.io, journalFile(w), '{not json', { mode: 0o600 });
    expect(await s1(w)).toEqual({ kind: 'invalid' });
  });
});

describe('bootstrap 模式:授权边界与崩溃窗口', () => {
  it.each([
    ['缺 auth', { mode: 'bootstrap' }],
    ['auth 为空对象', { mode: 'bootstrap', auth: {} }],
    ['auth 为 null', { mode: 'bootstrap', auth: null }],
    ['authorize 非函数', { mode: 'bootstrap', auth: { authorize: 'yes' } }],
  ])(
    'bootstrap_malformed_auth_refused_before_any_write — %s → bootstrap_denied{entry};未建任何目录 / journal',
    async (_n, bad) => {
      const w = await makeWorld('d1b1-badauth-');
      const o = await openPersonalRepo(repoDeps(w), FAKE_LOCKS, bad as unknown as OpenOpts);
      expect(o).toEqual({ kind: 'bootstrap_denied', step: 'entry' });
      expect(await exists(path.join(w.home, '.local'))).toBe(false);
    },
  );

  it('opts.mode 缺失 / 未知 → 抛错(opts 必填,没有默认)', async () => {
    const w = await makeWorld('d1b1-nomode-');
    for (const bad of [undefined, {}, { mode: 'x' }, { bootstrap: true }]) {
      await expect(
        openPersonalRepo(repoDeps(w), FAKE_LOCKS, bad as unknown as OpenOpts),
      ).rejects.toThrow(/opts\.mode/);
    }
    expect(await exists(path.join(w.home, '.local'))).toBe(false);
  });

  it('bootstrap_init_denied_nothing_written — authorize(init) 抛 → bootstrap_denied{init};journal 停在 planned,无目录 / 无 .git', async () => {
    const w = await makeWorld('d1b1-initdeny-');
    const a = spyAuth({ step: 'init' });
    expect(await open(w, a.opts)).toEqual({ kind: 'bootstrap_denied', step: 'init' });
    expect(a.calls).toEqual(['init']);
    expect(await readJournal(w.h)).toMatchObject({ kind: 'ok', value: { phase: 'planned' } });
    expect(await exists(w.h.repoDir)).toBe(false);
  });

  it('bootstrap_cas_denied_before_mktree — authorize(cas) 抛 → bootstrap_denied{cas};无 mktree / commit-tree / update-ref;journal 停在 initialized', async () => {
    const w = await makeWorld('d1b1-casdeny-');
    const a = spyAuth({ step: 'cas' });
    const steps: string[] = [];
    expect(await open(w, a.opts, (s) => steps.push(s))).toEqual({
      kind: 'bootstrap_denied',
      step: 'cas',
    });
    expect(a.calls).toEqual(['init', 'cas']);
    expect(steps).not.toContain('bootstrap:before:update-ref');
    expect(await exists(objectFile(w, EMPTY_TREE))).toBe(false); // mktree 没跑(空树对象未落盘)
    expect(gitRaw(w, ['rev-parse', '--verify', '-q', 'refs/heads/rsi']).status).not.toBe(0);
    expect(await readJournal(w.h)).toMatchObject({ kind: 'ok', value: { phase: 'initialized' } });
  });

  it('bootstrap_authorize_called_once_per_boundary — 全新建仓:init 一次、cas 一次,顺序 init < cas', async () => {
    const w = await makeWorld('d1b1-once-');
    const a = spyAuth();
    const o = await open(w, a.opts);
    expect(o.kind).toBe('ready');
    expect(a.calls).toEqual(['init', 'cas']);
    expect(await exists(objectFile(w, EMPTY_TREE))).toBe(true); // 对照:放行时 mktree 确实跑了
  });

  it('bootstrap_authorize_lock_lost_propagates — authorize 抛锁丢失 → 原样上抛(不映射 denied),journal 停在 planned', async () => {
    const w = await makeWorld('d1b1-authlock-');
    await expect(
      open(w, spyAuth({ step: 'init', err: new RsiLockError('lock_lost') }).opts),
    ).rejects.toMatchObject({ kind: 'lock_lost' });
    await expect(
      open(w, spyAuth({ step: 'init', err: new PersonalLockLost() }).opts),
    ).rejects.toBeInstanceOf(PersonalLockLost);
    expect(await readJournal(w.h)).toMatchObject({ kind: 'ok', value: { phase: 'planned' } });
  });

  it('bootstrap_crash_after_init_before_initialized_resumes_without_second_init — git init 已成功、journal 仍 planned:不再 authorize(init)、不再 init,只剩 cas', async () => {
    const w = await makeWorld('d1b1-aftinit-');
    await plant(w, 'planned_after_init');
    const a = spyAuth();
    const steps: string[] = [];
    const o = await open(w, a.opts, (s) => steps.push(s));
    expect(o.kind).toBe('ready');
    expect(a.calls).toEqual(['cas']);
    expect(steps).not.toContain('bootstrap:dir_ready');
  });

  it('bootstrap_crash_after_cas_before_committed_resumes_without_second_cas — update-ref 已成功、journal 仍 initialized:不再 authorize(cas)、不再 CAS,补写 committed', async () => {
    const w = await makeWorld('d1b1-aftcas-');
    await plant(w, 'initialized_after_cas');
    const refBefore = git(w, ['rev-parse', 'refs/heads/rsi']);
    const a = spyAuth();
    const steps: string[] = [];
    const o = await open(w, a.opts, (s) => steps.push(s));
    if (o.kind !== 'ready') throw new Error(JSON.stringify(o));
    expect(a.calls).toEqual([]);
    expect(steps).not.toContain('bootstrap:before:update-ref');
    expect(o.head).toBe(refBefore);
  });

  it('bootstrap_planned_missing_dir_discards_then_rebuilds — 对照原 C2 control:planned + 目录缺失在 bootstrap 模式丢弃 journal 后按首次重建', async () => {
    const w = await makeWorld('d1b1-discard-');
    await plant(w, 'planned_missing');
    const a = spyAuth();
    expect((await open(w, a.opts)).kind).toBe('ready');
    expect(a.calls).toEqual(['init', 'cas']);
  });
});

describe('D1b-1 端口纵深防御与映射', () => {
  it('no_bootstrap_auth_denies_every_step — complete_only 用的授权恒拒(BootstrapDenied,带 step)', async () => {
    for (const step of ['init', 'cas'] as const) {
      await expect(NO_BOOTSTRAP_AUTH.authorize(step)).rejects.toMatchObject({ step });
      await expect(NO_BOOTSTRAP_AUTH.authorize(step)).rejects.toBeInstanceOf(BootstrapDenied);
    }
  });

  it('outcome_of_open_maps_every_kind — bootstrap_pending / bootstrap_denied 都映射为 bootstrap_pending(不熔断);其余一一对应', () => {
    expect(outcomeOfOpen({ kind: 'bootstrap_pending' })).toEqual({ kind: 'bootstrap_pending' });
    expect(outcomeOfOpen({ kind: 'bootstrap_denied' })).toEqual({ kind: 'bootstrap_pending' });
    expect(outcomeOfOpen({ kind: 'ready' })).toEqual({ kind: 'ready' });
    expect(outcomeOfOpen({ kind: 'absent' })).toEqual({ kind: 'absent' });
    expect(outcomeOfOpen({ kind: 'invalid', why: 'w' })).toEqual({ kind: 'invalid', why: 'w' });
    expect(outcomeOfOpen({ kind: 'deferred', reason: 'personal_owner_changed' })).toEqual({
      kind: 'deferred',
      reason: 'personal_owner_changed',
    });
  });
});
