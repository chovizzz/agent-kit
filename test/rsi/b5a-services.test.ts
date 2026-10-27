/**
 * R20-A2 B5a:共享服务(`services/observe.ts` / `projections.ts` / `tick-state.ts` / `index-writable.ts`)与 armed tick 的 taint 校正、配置来源一致性(§2.1 / §0.5 R10)。
 */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { exists, readText } from '../../src/io/read-fs.js';
import { mkdirp, writeFile } from '../../src/io/safe-fs.js';
import type { RsiState } from '../../src/contracts/rsi.js';
import { RsiCountsSchema } from '../../src/contracts/rsi.js';
import { buildRsiPolicy, policyFingerprint } from '../../src/rsi/config.js';
import { bindingOf, createCheckpoint, observationFrom } from '../../src/rsi/l0/binding.js';
import {
  armedCheckpoint,
  confirmedCheckpoint,
  displayFingerprint,
  observeRsi,
} from '../../src/rsi/services/observe.js';
import {
  indexWritable,
  recomputeAllCounts,
  refreshStagedUnderLock,
  stagedProjection,
  writeAllCountsUnderLock,
} from '../../src/rsi/services/projections.js';
import { defaultState, tickStateMutator } from '../../src/rsi/services/tick-state.js';
import { carryConfirm } from '../../src/rsi/l0/state-mutate.js';
import { loadRepoIdentity } from '../../src/rsi/state.js';
import { runTick } from '../../src/rsi/tick.js';
import { redactor } from './l0-run-fixture.js';
import { writeCfg } from './rsi-fixture.js';
import {
  KEY_A,
  KEY_B,
  SALT,
  SALT_FP,
  addSignals,
  countsDoc,
  ensureRsiDir,
  makeRoot,
  makeSvc,
  put,
  setRsiToml,
  stageRun,
  withLock,
  writeCountsRaw,
  writeIndex,
  type Svc,
} from './services-fixture.js';
import { cmdFxOf, runCmd } from './b5a-fixture.js';

const envOf = (s: Svc): Record<string, string> => cmdFxOf(s).env;
const stopBody = (n: string): string => `{"at":"2026-10-26T00:00:0${n}.000Z","by":"user"}`;
const stopPath = (s: Svc): string => path.join(s.rsi, 'STOP');
const rsiJson = async (s: Svc, n: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readText(path.join(s.rsi, n))) as Record<string, unknown>;

/** 写一份与当前配置 / 仓库一致的确认记录进 state.json */
async function confirmNow(s: Svc, over: Partial<RsiState> = {}): Promise<void> {
  const policy = await buildRsiPolicy(s.cfg);
  const id = await loadRepoIdentity(s.cfg, policy);
  const state: RsiState = {
    ...defaultState(),
    confirm: {
      confirmed_at: '2026-10-26T00:00:00.000Z',
      kit_major: policy.kit_major,
      agents: [...policy.agents],
      exclude_hashes: [...policy.exclude_hashes],
      repo_sha256: id.repoSha256,
      repo_dev_ino: { ...id.repoDevIno },
      overlay_sha256: policy.overlay_sha256,
      policy_fp: policyFingerprint(policy),
      baseline_pending: false,
    },
    ...over,
  };
  await ensureRsiDir(s);
  await put(s, path.join(s.rsi, 'state.json'), JSON.stringify(state));
}

describe('observeRsi / displayFingerprint', () => {
  it('配置 off:state=off、identity=null、stop=absent;配置 on:首次 armed,identity 非空', async () => {
    const s = await makeSvc('ob-basic-');
    const on = await observeRsi(s.io, envOf(s));
    expect(on.state).toMatchObject({ state: 'armed', firstArmed: true });
    expect(on.identity).not.toBeNull();
    expect(on.stop).toBe('absent');
    await writeCfg(s.f, '[rsi]\nenabled = false\n');
    const off = await observeRsi(s.io, envOf(s));
    expect(off.state.state).toBe('off');
    expect(off.identity).toBeNull();
    expect(typeof displayFingerprint(off)).toBe('string');
  });

  it('STOP 身份含内容 sha256 与 (dev, ino):同 inode 原地改内容(同长度)→ 指纹变化;不是普通文件(目录)→ sha256 为 null;state.json 不合规 → stateInvalid', async () => {
    const s = await makeSvc('ob-stop-');
    await ensureRsiDir(s);
    await writeFile(s.io, stopPath(s), stopBody('1'), { mode: 0o600 });
    const o1 = await observeRsi(s.io, envOf(s));
    await writeFile(s.io, stopPath(s), stopBody('2'), { mode: 0o600 }); // 同长度、同 inode(原地覆写)
    const o2 = await observeRsi(s.io, envOf(s));
    if (o1.stop === 'absent' || o2.stop === 'absent') throw new Error('STOP 应在场');
    expect(o2.stop.ino).toBe(o1.stop.ino); // 只有内容不同
    expect(o2.stop.sha256).not.toBe(o1.stop.sha256);
    expect(displayFingerprint(o1)).not.toBe(displayFingerprint(o2));
    expect(o1.state.state).toBe('stopped');
    // 目录冒充 STOP
    const d = await makeSvc('ob-stop-dir-');
    await mkdirp(d.f.fx, stopPath(d), 0o700);
    const od = await observeRsi(d.io, envOf(d));
    expect(od.stop === 'absent' ? null : od.stop.sha256).toBeNull();
    expect(od.state.state).toBe('stopped');
    // 整份 state.json 不合规
    const b = await makeSvc('ob-badstate-');
    await ensureRsiDir(b);
    await put(b, path.join(b.rsi, 'state.json'), '{"nope":1}');
    expect((await observeRsi(b.io, envOf(b))).state.stateInvalid).toBe(true);
  });

  it('指纹对排除项 / agents / STOP 有反应,对无关项稳定', async () => {
    const s = await makeSvc('ob-fp-');
    const f0 = displayFingerprint(await observeRsi(s.io, envOf(s)));
    expect(displayFingerprint(await observeRsi(s.io, envOf(s)))).toBe(f0);
    await setRsiToml(s, 'agents = ["claude"]\n');
    const f1 = displayFingerprint(await observeRsi(s.io, envOf(s)));
    expect(f1).not.toBe(f0);
    await setRsiToml(s, `exclude_dirs = [${JSON.stringify(path.join(s.f.dir, 'work', 'a'))}]\n`);
    expect(displayFingerprint(await observeRsi(s.io, envOf(s)))).not.toBe(f0);
  });
});

describe('检查点', () => {
  const clock =
    (t: { v: number }): (() => number) =>
    () =>
      t.v;

  it('confirmedCheckpoint:continue / STOP → stopped / 收紧排除 → binding_changed / 配置 off → collect_blocked;time_limit 只在非 commit', async () => {
    const s = await makeSvc('cp-conf-');
    await confirmNow(s);
    const o = await observeRsi(s.io, envOf(s));
    if (o.identity === null) throw new Error('identity');
    const binding = bindingOf({ identity: o.identity, confirmedAt: '2026-10-26T00:00:00.000Z' });
    const t = { v: 0 };
    const mk = (): ReturnType<typeof confirmedCheckpoint> =>
      confirmedCheckpoint({ io: s.io, env: envOf(s), binding, nowMs: clock(t), startedAtMs: 0 });
    expect(await mk()('file')).toEqual({ kind: 'continue' });
    t.v = 10 * 60_000;
    expect(await mk()('file')).toEqual({ kind: 'time_limit' });
    expect(await mk()('commit')).toEqual({ kind: 'continue' });
    t.v = 0;
    await setRsiToml(s, `exclude_dirs = [${JSON.stringify(path.join(s.f.dir, 'work', 'a'))}]\n`);
    expect(await mk()('commit')).toEqual({ kind: 'abort', outcome: 'skipped_binding_changed' });
    await setRsiToml(s, '');
    await writeFile(s.io, stopPath(s), stopBody('1'), { mode: 0o600 });
    expect(await mk()('file')).toEqual({ kind: 'abort', outcome: 'stopped' });
    await writeCfg(s.f, '[rsi]\nenabled = false\n');
    expect((await mk()('file')).kind).toBe('abort');
  });

  it('armedCheckpoint:continue / STOP / stateInvalid / config.block → collect_blocked / 变 confirmed 或 agents、repo 策略变化 → binding_changed;commit 不返回 time_limit;对照:createCheckpoint 在 armed 下恒判 binding_changed', async () => {
    const s = await makeSvc('cp-armed-');
    const o = await observeRsi(s.io, envOf(s));
    if (o.identity === null) throw new Error('identity');
    const armedBinding = {
      repoSha256: o.identity.repoSha256,
      repoDevIno: { ...o.identity.repoDevIno },
      policyFp: policyFingerprint(o.identity.policy),
      agents: [...o.identity.policy.agents],
    };
    const t = { v: 0 };
    const mk = (): ReturnType<typeof armedCheckpoint> =>
      armedCheckpoint({ io: s.io, env: envOf(s), armedBinding, nowMs: clock(t), startedAtMs: 0 });
    expect(await mk()('file')).toEqual({ kind: 'continue' });
    // 对照:B4 的 createCheckpoint 在 armed 下 current === null → 恒判 binding_changed
    const ctl = createCheckpoint({
      nowMs: clock(t),
      startedAtMs: 0,
      maxMs: 120_000,
      binding: bindingOf({ identity: o.identity, confirmedAt: null }),
      observe: async () =>
        observationFrom({
          state: o.state,
          stopPresent: false,
          identity: o.identity!,
          confirm: null,
        }),
    });
    expect(await ctl('file')).toEqual({ kind: 'abort', outcome: 'skipped_binding_changed' });
    t.v = 10 * 60_000;
    expect(await mk()('file')).toEqual({ kind: 'time_limit' });
    expect(await mk()('commit')).toEqual({ kind: 'continue' });
    t.v = 0;
    await setRsiToml(s, 'agents = ["claude"]\n');
    expect(await mk()('file')).toEqual({ kind: 'abort', outcome: 'skipped_binding_changed' });
    await setRsiToml(s, 'exclude_dirs = ["relative"]\n');
    expect(await mk()('file')).toEqual({ kind: 'abort', outcome: 'skipped_collect_blocked' });
    await setRsiToml(s, '');
    await put(s, path.join(s.rsi, 'state.json'), '{"nope":1}');
    expect(await mk()('file')).toEqual({ kind: 'abort', outcome: 'skipped_collect_blocked' });
    await confirmNow(s);
    expect(await mk()('file')).toEqual({ kind: 'abort', outcome: 'skipped_binding_changed' });
    await writeFile(s.io, stopPath(s), stopBody('1'), { mode: 0o600 });
    expect(await mk()('file')).toEqual({ kind: 'abort', outcome: 'stopped' });
  });
});

describe('tickStateMutator / defaultState', () => {
  const summary = (outcome: string): never =>
    ({ outcome, duration_ms: 12, files_read: 3, bytes_read: 40 }) as never;
  const now = (): Date => new Date('2026-10-26T12:00:00.000Z');
  const confirm = {
    confirmed_at: '2026-10-25T00:00:00.000Z',
    kit_major: 0,
    agents: ['claude'],
    exclude_hashes: [],
    repo_sha256: 'a'.repeat(64),
    repo_dev_ino: { dev: 1, ino: 1 },
    overlay_sha256: null,
    policy_fp: 'b'.repeat(64),
    baseline_pending: true,
  } as never;
  const prev: RsiState = {
    ...defaultState(),
    confirm,
    projects_ack_generation: 9,
    attempt: { started_at: '2026-10-26T00:00:00.000Z', nonce: 'c'.repeat(16) },
    breaker: { kind: 'safety', opened_at: '2026-10-26T00:00:00.000Z', until: null },
    consecutive_failures: 4,
    armed_listing: {
      at: '2026-10-26T00:00:00.000Z',
      policy_fp: 'd'.repeat(64),
      agents: ['claude'],
      projects: 1,
      excluded: 0,
      unknown_sessions: 0,
    },
  };

  it('读-改-写:展开 prev(confirm / ack / armed_listing 原样);attempt → null;last_tick 填充', () => {
    const m = tickStateMutator({ trigger: 'tick', now });
    const out = m(prev, summary('ok_partial'));
    expect(out.confirm).toEqual(prev.confirm);
    expect(out.projects_ack_generation).toBe(9);
    expect(out.armed_listing).toEqual(prev.armed_listing);
    expect(out.attempt).toBeNull();
    expect(out.last_tick).toEqual({
      completed_at: '2026-10-26T12:00:00.000Z',
      trigger: 'tick',
      outcome: 'ok_partial',
      code: null,
      duration_ms: 12,
      files_read: 3,
      bytes_read: 40,
    });
    expect(m(null, summary('ok')).confirm).toBeNull(); // prev 为空 → defaultState
  });

  it('成功清熔断与连续失败;skip 类原样不动', () => {
    const m = tickStateMutator({ trigger: 'tick', now });
    for (const o of ['ok', 'ok_partial']) {
      const r = m(prev, summary(o));
      expect([r.breaker, r.consecutive_failures]).toEqual([null, 0]);
    }
    for (const o of ['stopped', 'skipped_collect_blocked', 'skipped_binding_changed']) {
      const r = m(prev, summary(o));
      expect([r.breaker, r.consecutive_failures, r.last_tick?.code]).toEqual([prev.breaker, 4, o]);
    }
  });

  it('carryConfirm 是第二道保险:即便 mutator 篡改 confirm,carryConfirm 换回磁盘值', () => {
    const evil = {
      ...tickStateMutator({ trigger: 'tick', now })(prev, summary('ok')),
      confirm: null,
    };
    expect(carryConfirm(prev, evil).confirm).toEqual(prev.confirm);
  });
});

describe('indexWritable(D7)', () => {
  it('索引 ok 且盐指纹一致,或索引缺失且 cursor 也缺失 → 可写;其余不可写', () => {
    const rows: [Parameters<typeof indexWritable>[0], boolean, boolean][] = [
      [{ status: 'ok', saltFp: 'aaa' }, false, true],
      [{ status: 'ok', saltFp: 'aaa' }, true, true],
      [{ status: 'ok', saltFp: 'bbb' }, false, false],
      [{ status: 'absent' }, false, true],
      [{ status: 'absent' }, true, false],
      [{ status: 'invalid' }, false, false],
      [{ status: 'invalid' }, true, false],
    ];
    for (const [prev, cursor, want] of rows) {
      expect(indexWritable(prev, cursor, 'aaa'), JSON.stringify([prev, cursor])).toBe(want);
    }
  });
});

describe('projections', () => {
  async function staged(s: Svc): Promise<void> {
    const root = await makeRoot(s, 'a');
    await writeIndex(s, [{ key: KEY_A, root }]);
    await addSignals(s, [
      { id: 'aaaa000000000001', key: KEY_A },
      { id: 'bbbb000000000002', key: KEY_B },
    ]);
    await stageRun(s, 'r-one', ['aaaa000000000001']);
    await stageRun(s, 'r-two', ['bbbb000000000002', 'aaaa000000000001'], { proposals: 2 });
    await stageRun(s, 'r-unmapped', ['cccc000000000003']); // 信号库里没有 → 映射不到 → '?'
    await mkdirp(s.f.fx, path.join(s.state, 'reflect', 'r-noprop'), 0o755); // 没有 proposals/:不进 staged
    await put(
      s,
      path.join(s.state, 'reflect', 'r-one', 'TAINTED'),
      '{"reason":"exclude","at":"2026-10-26T00:00:00.000Z"}',
    );
  }

  it('stagedProjection:只列含 proposals/ 的 run;proposals 个数;evidence_keys 映射 / "?" / 升序去重;tainted 取 TAINTED 文件事实;按 run_id 升序', async () => {
    const s = await makeSvc('pj-staged-');
    await staged(s);
    expect(await stagedProjection(s.io)).toEqual([
      { run_id: 'r-one', proposals: 1, evidence_keys: [KEY_A], tainted: true },
      { run_id: 'r-two', proposals: 2, evidence_keys: [KEY_A, KEY_B], tainted: false },
      { run_id: 'r-unmapped', proposals: 1, evidence_keys: ['?'], tainted: false },
    ]);
  });

  it('refreshStagedUnderLock:盐缺失 → skipped_no_salt(零写入);counts 缺失 → written_full;counts 在且盐相符 → 只写 staged(其余段保持现值);盐不符 → written_full', async () => {
    const none = await makeSvc('pj-ref-nosalt-', { salt: false });
    await ensureRsiDir(none);
    const before = none.audit.length;
    expect(await withLock(none, (l) => refreshStagedUnderLock(none.ctx, l, redactor))).toBe(
      'skipped_no_salt',
    );
    expect(
      none.audit.slice(before).filter((a) => !a.startsWith('mkdirp') && !/\/lock$/.test(a)),
    ).toEqual([]);

    const s = await makeSvc('pj-ref-');
    await staged(s);
    expect(await withLock(s, (l) => refreshStagedUnderLock(s.ctx, l, redactor))).toBe(
      'written_full',
    );
    const c1 = RsiCountsSchema.parse(await rsiJson(s, 'counts.json'));
    expect(c1.staged.map((e) => e.run_id)).toEqual(['r-one', 'r-two', 'r-unmapped']);
    expect(Object.keys(c1.per_key).sort()).toEqual([KEY_A, KEY_B].sort());
    // 只写 staged:先把 per_key 手改成哨兵,再 refresh,哨兵必须还在
    await writeCountsRaw(s, { ...c1, per_key: {}, unknown_keys_signals: 77, staged: [] });
    expect(await withLock(s, (l) => refreshStagedUnderLock(s.ctx, l, redactor))).toBe(
      'written_staged',
    );
    const c2 = RsiCountsSchema.parse(await rsiJson(s, 'counts.json'));
    expect(c2.unknown_keys_signals).toBe(77);
    expect(c2.per_key).toEqual({});
    expect(c2.staged.length).toBe(3);
    // 盐不符:四段全量
    await writeCountsRaw(s, countsDoc('bbbbbbbbbbbb', { unknown_keys_signals: 55 }));
    expect(await withLock(s, (l) => refreshStagedUnderLock(s.ctx, l, redactor))).toBe(
      'written_full',
    );
    const c3 = RsiCountsSchema.parse(await rsiJson(s, 'counts.json'));
    expect(c3.salt_fp).toBe(SALT_FP);
    expect(c3.unknown_keys_signals).toBe(0);
    expect(Object.keys(c3.per_key).length).toBe(2);
  });

  it('writeAllCountsUnderLock:四段全量(per_key / clusters / staged / unknown),并与 recomputeAllCounts 一致', async () => {
    const s = await makeSvc('pj-all-');
    await staged(s);
    await withLock(s, (l) => writeAllCountsUnderLock(s.ctx, l, redactor));
    const c = RsiCountsSchema.parse(await rsiJson(s, 'counts.json'));
    const want = await recomputeAllCounts(s.ctx, redactor);
    expect(c.per_key).toEqual(want.perKey);
    expect(c.staged).toEqual(want.staged);
    expect(c.clusters).toEqual(want.clusters);
    expect(c.unknown_keys_signals).toBe(want.unknownKeysSignals);
    expect(c.salt_fp).toBe(createHash('sha256').update(SALT).digest('hex').slice(0, 12));
  });
});

describe('armed tick 的 taint 校正(D3)与配置来源一致性(§2.1 / R10)', () => {
  /** 一个 run 的证据属于 KEY_A;索引里 KEY_A 的根是 root;counts 里该 run 尚未标 tainted */
  async function arrangeExcludable(prefix: string): Promise<{ s: Svc; root: string }> {
    const s = await makeSvc(prefix);
    const root = await makeRoot(s, 'a');
    await writeIndex(s, [{ key: KEY_A, root }]);
    await addSignals(s, [{ id: 'aaaa000000000001', key: KEY_A }]);
    await stageRun(s, 'rx', ['aaaa000000000001']);
    await writeCountsRaw(
      s,
      countsDoc(SALT_FP, {
        staged: [{ run_id: 'rx', proposals: 1, evidence_keys: [KEY_A], tainted: false }],
        per_key: { [KEY_A]: { signals_total: 1, sessions: 1, signals_by_day: {} } },
        unknown_keys_signals: 3,
      }),
    );
    return { s, root };
  }
  const taintedOnDisk = (s: Svc): Promise<boolean> =>
    exists(path.join(s.state, 'reflect', 'rx', 'TAINTED'));

  it('armed + 配置排除了该项目:tick --write 给 run 落 TAINTED、清摘录,并只校正 counts.staged[].tainted(其余段不变;D3);没有排除时不动', async () => {
    const { s, root } = await arrangeExcludable('at-taint-');
    // 对照:没有排除 → 不 taint、counts 不变
    const cf0 = cmdFxOf(s);
    expect((await runCmd(cf0, runTick, ['--write'], {})).code).toBe(0);
    expect(await taintedOnDisk(s)).toBe(false);
    const c0 = RsiCountsSchema.parse(await rsiJson(s, 'counts.json'));
    expect(c0.staged[0]?.tainted).toBe(false);
    await setRsiToml(s, `exclude_dirs = [${JSON.stringify(root)}]\n`);
    const r = await runCmd(cmdFxOf(s), runTick, ['--write'], {});
    expect(r.code, r.err).toBe(0);
    expect(await taintedOnDisk(s)).toBe(true);
    const c1 = RsiCountsSchema.parse(await rsiJson(s, 'counts.json'));
    expect(c1.staged).toEqual([expect.objectContaining({ run_id: 'rx', tainted: true })]);
    expect(c1.per_key).toEqual(c0.per_key);
    expect(c1.unknown_keys_signals).toBe(3);
    expect(c1.clusters).toEqual(c0.clusters);
    expect(await exists(path.join(s.state, 'salt'))).toBe(true); // 夹具自带的盐;armed 没有改它
  });

  it('R10-a:KIT_REAL_HOME_OVERRIDE 与 HOME 指向不同目录、各放一份相反的配置——命令侧与 taint 侧读的是同一份(跟随 KIT_REAL_HOME_OVERRIDE),两个方向都跑', async () => {
    for (const strictAsOverride of [true, false]) {
      const { s, root } = await arrangeExcludable(`at-home-${strictAsOverride}-`);
      // decoy:另一个假 HOME,配置相反
      const decoy = await makeSvc(`at-home-decoy-${strictAsOverride}-`);
      const strict = `exclude_dirs = [${JSON.stringify(root)}]\n`;
      await setRsiToml(s, strictAsOverride ? strict : '');
      await writeCfg(
        decoy.f,
        `[rsi]\nenabled = true\nrepo = ${JSON.stringify(s.f.repo)}\n${strictAsOverride ? '' : strict}`,
      );
      const cf = cmdFxOf(s);
      const r = await runCmd(cf, runTick, ['--write'], {}, { env: { HOME: decoy.f.home } });
      expect(r.code, `${strictAsOverride}: ${r.err}`).toBe(0);
      expect(await taintedOnDisk(s), `override=${strictAsOverride ? '严格' : '宽松'}`).toBe(
        strictAsOverride,
      );
    }
  });

  it('R10-b:env 带 KIT_STATE_DIR 指向别处(且没有 KIT_TMP)——taint / 状态读写仍在 [rsi] repo/.state,没有碰 KIT_STATE_DIR', async () => {
    const { s, root } = await arrangeExcludable('at-statedir-');
    await setRsiToml(s, `exclude_dirs = [${JSON.stringify(root)}]\n`);
    const elsewhere = path.join(s.f.dir, 'elsewhere-state');
    const cf = cmdFxOf(s);
    const r = await runCmd(
      cf,
      runTick,
      ['--write'],
      {},
      { env: { KIT_STATE_DIR: elsewhere, KIT_TMP: undefined } },
    );
    expect(r.code, r.err).toBe(0);
    expect(await taintedOnDisk(s)).toBe(true);
    expect(await exists(elsewhere)).toBe(false);
    expect(cf.audit.every((c) => !c.path.startsWith(elsewhere))).toBe(true);
    expect(cf.audit.every((c) => c.path.startsWith(s.state))).toBe(true);
  });
});
