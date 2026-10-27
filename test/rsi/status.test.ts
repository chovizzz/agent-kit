/**
 * R20-A2 B3a:`rsi status`(docs/contracts.md §20.3.4 R20-3.4.1 / 3.4.2;R20-4.3 ~ 4.6)。
 * 经真实 `main()`(runEarly 路径)或直接调 `runStatus`(要注入时钟 / 探测 / 锁判据时)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chmod, mkdirp, remove, symlink, writeFile } from '../../src/io/safe-fs.js';
import { loadRsiConfig } from '../../src/rsi/config.js';
import { runProjects } from '../../src/rsi/projects.js';
import { runStatus, type RsiStatusDeps, type StatusDoc } from '../../src/rsi/status.js';
import { treeOf } from './rsi-fixture.js';
import {
  NOW,
  SALT_FP,
  baseState,
  countsOf,
  indexOf,
  key,
  makeRoFx,
  mkProject,
  runDirect,
  runMain,
  seed,
  setExtra,
  validConfirm,
  type RoFx,
} from './ro-fixture.js';

const T_NOW = new Date('2026-10-24T08:00:00.000Z');
const direct = (f: RoFx, argv: string[], deps: RsiStatusDeps = { now: () => T_NOW }) =>
  runDirect(f, runStatus, argv, deps);
const doc = (out: string): StatusDoc => JSON.parse(out) as StatusDoc;

const OFF_KEYS = [
  'agents',
  'breaker',
  'confirm',
  'counts',
  'cursor',
  'first_armed',
  'index',
  'last_tick',
  'lock',
  'overlay',
  'purge',
  'reason',
  'snapshot',
  'state',
  'stop',
  'tainted',
  'warnings',
];
const COUNT_KEYS = [
  'clusters_pending',
  'projects_collecting',
  'projects_excluded',
  'projects_new',
  'signals_new_7d',
  'signals_total',
  'staged_proposals',
  'staged_runs',
  'tainted_runs',
  'unknown_signals',
];

describe('R20-3.4.1 off 与各类配置问题:退出 0、reason 报码、键集合固定、零写入', () => {
  for (const [name, toml] of [
    ['disabled', '[rsi]\nenabled = false\n'],
    ['no_section', '[other]\nx = 1\n'],
    ['cfg_schema', '[rsi]\nenabled = true\nagents = ["kimi"]\n'],
  ] as const) {
    it(`${name}:state=off、reason=${name},键集合 / 计数键集合与契约一致,.state 与 rsi/ 都没被建`, async () => {
      const f = await makeRoFx(`st-off-${name}-`);
      await writeFile(f.fx, f.cfgFile, toml, { mode: 0o600 });
      const before = await treeOf(f.dir);
      const r = await runMain(f, ['rsi', 'status', '--json']);
      expect(r.code).toBe(0);
      expect(r.err).toBe('');
      const d = doc(r.out);
      expect(Object.keys(d).sort()).toEqual(OFF_KEYS);
      expect(Object.keys(d.counts).sort()).toEqual(COUNT_KEYS);
      expect(d).toMatchObject({
        state: 'off',
        reason: name,
        agents: [],
        tainted: [],
        lock: 'free',
      });
      expect(d.counts).toEqual(Object.fromEntries(COUNT_KEYS.map((k) => [k, 0])));
      expect(r.audit).toEqual([]);
      expect(await treeOf(f.dir)).toEqual(before);
    });
  }

  it('配置文件不存在 → off/absent;文本输出是 key=value 行', async () => {
    const f = await makeRoFx('st-off-absent-');
    await chmodRemoveCfg(f);
    const r = await runMain(f, ['rsi', 'status']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('state=off\n');
    expect(r.out).toContain('reason=absent\n');
    expect(r.out).toContain('counts.projects_collecting=0\n');
  });
});

async function chmodRemoveCfg(f: RoFx): Promise<void> {
  await remove(f.fx, f.cfgFile);
}

describe('R20-3.4.1 参数与根', () => {
  it('未知 / 重复 / --x=y / 位置参数 → 2 unknown_arg;--ack 是 B5 桩(64)', async () => {
    const f = await makeRoFx('st-args-');
    for (const argv of [['--x'], ['--json', '--json'], ['--json=1'], ['stray'], ['--ack', '--x']]) {
      const r = await runMain(f, ['rsi', 'status', ...argv]);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.err).toBe('RSI_USAGE reason=unknown_arg\n');
      expect(r.out).toBe('');
    }
    const ack = await runMain(f, ['rsi', 'status', '--ack']);
    expect(ack.code).toBe(64);
    expect(ack.err).toBe('RSI_NOT_IMPLEMENTED subcommand=status.ack\n');
  });

  it('--root 与 [rsi] repo 不符 → 2 root_mismatch,零写入、不建 rsi/', async () => {
    const f = await makeRoFx('st-root-');
    const other = path.join(f.dir, 'other');
    await mkdirp(f.fx, other, 0o755);
    const before = await treeOf(f.dir);
    const r = await runMain(f, ['--root', other, 'rsi', 'status']);
    expect(r.code).toBe(2);
    expect(r.err).toBe('RSI_USAGE reason=root_mismatch\n');
    expect(r.audit).toEqual([]);
    expect(await treeOf(f.dir)).toEqual(before);
  });
});

describe('R20-1.5a 首次 armed:无任何状态文件,零写入', () => {
  it('state=armed、first_armed=true、snapshot/index/cursor 均 absent;rsi/ 与 .state 未被建', async () => {
    const f = await makeRoFx('st-armed-');
    const before = await treeOf(f.dir);
    const r = await runMain(f, ['rsi', 'status', '--json']);
    expect(r.code).toBe(0);
    const d = doc(r.out);
    expect(d).toMatchObject({
      state: 'armed',
      reason: null,
      first_armed: true,
      snapshot: 'absent',
      index: { status: 'absent', entries: 0 },
      cursor: { status: 'absent', fingerprint_match: null },
      confirm: null,
      stop: { present: false, at: null },
      purge: { journal: 'absent' },
      lock: 'free',
      overlay: 'absent',
      warnings: ['overlay_absent'],
    });
    expect(d.agents.map((a) => a.id)).toEqual(['claude', 'codex', 'pi']);
    expect(r.audit).toEqual([]);
    expect(await treeOf(f.dir)).toEqual(before);
  });
});

/** 一个覆盖 P / X / U / new / 暂存 / taint 的完整场景 */
async function fullScenario(): Promise<{ f: RoFx; a: string; b: string }> {
  const f = await makeRoFx('st-full-');
  const a = await mkProject(f, 'a');
  const b = await mkProject(f, 'b');
  const d = await mkProject(f, 'd');
  const e = await mkProject(f, 'e');
  await setExtra(f, `exclude_dirs = [${JSON.stringify(b.path)}]\n`);
  const confirm = await validConfirm(f);
  await seed(f, {
    state: baseState({ confirm, projects_ack_generation: 3 }),
    index: indexOf([
      { key: key(1), path: a.path, dev: a.dev, ino: a.ino, firstGen: 1, signals: 10 },
      { key: key(2), path: b.path, dev: b.dev, ino: b.ino, signals: 5 },
      { key: key(3), path: path.join(f.dir, 'work', 'gone'), dev: 1, ino: 1, signals: 2 },
      { key: key(4), path: d.path, dev: d.dev, ino: d.ino, firstGen: 4, signals: 4 },
      { key: key(5), path: e.path, dev: e.dev, ino: e.ino + 12345, signals: 1 },
    ]),
    counts: countsOf(
      {
        [key(1)]: { total: 10, byDay: { '2026-10-24': 3, '2026-10-20': 4, '2026-10-10': 3 } },
        [key(2)]: { total: 5, byDay: { '2026-10-24': 5 } },
        [key(3)]: { total: 2 },
        [key(4)]: { total: 4, byDay: { '2026-10-24': 1 } },
        [key(5)]: { total: 1 },
        [key(9)]: { total: 6 },
      },
      {
        unknown: 2,
        clusters: [
          { cluster_id: 'c1', evidence_by_key: { [key(1)]: 2, [key(2)]: 5 } },
          { cluster_id: 'c2', evidence_by_key: { [key(1)]: 2, [key(4)]: 2 } },
          { cluster_id: 'c3', evidence_by_key: { [key(9)]: 10 } },
        ],
        staged: [
          { run_id: 'r-ok', proposals: 2, evidence_keys: [key(1), key(4)], tainted: false },
          { run_id: 'r-x', proposals: 9, evidence_keys: [key(1), key(2)], tainted: false },
          { run_id: 'r-mark', proposals: 9, evidence_keys: [key(1)], tainted: true },
          { run_id: 'r-u', proposals: 9, evidence_keys: [key(1), '?'], tainted: false },
        ],
      },
    ),
    tainted: { 'r-mark': JSON.stringify({ reason: 'purge', at: NOW }) },
  });
  return { f, a: a.path, b: b.path };
}

describe('R20-4.3 ~ 4.6 现算 P / X / U 与计数口径', () => {
  it('完整场景:项目 / 信号 / 聚类 / 暂存 / tainted 计数,tainted 只列 id 与原因码', async () => {
    const { f } = await fullScenario();
    const r = await direct(f, ['--json']);
    expect(r.code).toBe(0);
    const d = doc(r.out);
    expect(d.state).toBe('confirmed');
    expect(d.counts).toEqual({
      projects_collecting: 2, // a、d(d 是新增)
      projects_excluded: 1, // b
      projects_new: 1, // d:first_indexed_generation 4 > ack 3
      unknown_signals: 11, // 计数里的 2 + key3(根不存在)2 + key5((dev,ino) 变了)1 + key9(不在索引)6
      signals_total: 30,
      signals_new_7d: 8, // key1:3+4(10-10 在窗口外),key4:1;已排除的 key2 不算
      clusters_pending: 1, // 只有 c2 在剔除 X / U 后仍 ≥ 3
      staged_runs: 1, // r-ok
      staged_proposals: 2,
      tainted_runs: 2,
    });
    expect(d.tainted).toEqual([
      { run_id: 'r-mark', reason: 'purge' }, // TAINTED 文件里的原因
      { run_id: 'r-x', reason: 'exclude' }, // 排除已写、taint 尚未落盘:现算
    ]);
    expect(d.index).toEqual({ status: 'ok', entries: 5 });
    expect(d.snapshot).toBe('ok');
    expect(d.confirm).toMatchObject({ invalid_reason: null });
    expect(r.out).not.toContain(f.dir);
    expect(r.audit).toEqual([]);
  });

  it('写下排除后的下一次调用:该项目不再计入 P / new / 7 日新增 / 聚类(中间不跑任何写入方)', async () => {
    const { f, a } = await fullScenario();
    const before = doc((await direct(f, ['--json'])).out);
    expect(before.counts.projects_collecting).toBe(2);
    // 把 a 也加进排除项(收紧排除不使确认失效)
    const cur = await loadRsiConfig({ home: f.home });
    if (cur.status !== 'on') throw new Error('off');
    await setExtra(
      f,
      `exclude_dirs = [${[...cur.excludeDirs, a].map((x) => JSON.stringify(x)).join(', ')}]\n`,
    );
    const after = doc((await direct(f, ['--json'])).out);
    expect(after.state).toBe('confirmed');
    expect(after.counts.projects_collecting).toBe(1); // 只剩 d
    expect(after.counts.projects_excluded).toBe(2);
    expect(after.counts.signals_new_7d).toBe(1); // 只剩 d 的 1
    expect(after.counts.staged_runs).toBe(0); // r-ok 的证据含 a → X
    expect(after.tainted.map((t) => t.run_id)).toEqual(['r-mark', 'r-ok', 'r-u', 'r-x']);
  });

  it('索引损坏:不阻断,index=invalid,全部信号计 U,排除后的计数不再有 P', async () => {
    const f = await makeRoFx('st-badindex-');
    const a = await mkProject(f, 'a');
    await seed(f, {
      state: baseState({ confirm: await validConfirm(f) }),
      raw: { 'projects.json': '{"not":"an index"}' },
      counts: countsOf({ [key(1)]: { total: 4 } }, { unknown: 1 }),
    });
    void a;
    const r = await direct(f, ['--json']);
    expect(r.code).toBe(0);
    const d = doc(r.out);
    expect(d.index).toEqual({ status: 'invalid', entries: 0 });
    expect(d.counts).toMatchObject({
      projects_collecting: 0,
      unknown_signals: 5,
      signals_total: 5,
    });
  });

  it('盐不符 / counts 缺失:已排除项目仍计 excluded(X 与盐无关),其余计 U;对照:盐相符时另一项目是 P', async () => {
    for (const how of ['mismatch', 'missing'] as const) {
      const f = await makeRoFx(`st-xsalt-${how}-`);
      const a = await mkProject(f, 'a');
      const b = await mkProject(f, 'b');
      await setExtra(f, `exclude_dirs = [${JSON.stringify(b.path)}]\n`);
      await seed(f, {
        state: baseState({ confirm: await validConfirm(f) }),
        index: indexOf(
          [
            { key: key(1), path: a.path, dev: a.dev, ino: a.ino },
            { key: key(2), path: b.path, dev: b.dev, ino: b.ino },
          ],
          5,
          how === 'mismatch' ? 'bbbbbbbbbbbb' : SALT_FP,
        ),
        ...(how === 'mismatch'
          ? {
              counts: countsOf(
                { [key(1)]: { total: 4 }, [key(2)]: { total: 2 } },
                { saltFp: SALT_FP },
              ),
            }
          : {}),
      });
      const d = doc((await direct(f, ['--json'])).out);
      expect(d.counts, how).toMatchObject({ projects_collecting: 0, projects_excluded: 1 });
    }
  });

  it('盐指纹与 counts 不符:整个索引不可用,所有信号计 U(含已在索引里的 key)', async () => {
    const f = await makeRoFx('st-salt-');
    const a = await mkProject(f, 'a');
    await seed(f, {
      state: baseState({ confirm: await validConfirm(f) }),
      index: indexOf([{ key: key(1), path: a.path, dev: a.dev, ino: a.ino }], 5, 'bbbbbbbbbbbb'),
      counts: countsOf({ [key(1)]: { total: 4 } }, { saltFp: SALT_FP }),
    });
    const d = doc((await direct(f, ['--json'])).out);
    expect(d.counts).toMatchObject({ projects_collecting: 0, unknown_signals: 4 });
    // 对照:盐一致则 P
    await seed(f, {
      state: baseState({ confirm: await validConfirm(f) }),
      index: indexOf([{ key: key(1), path: a.path, dev: a.dev, ino: a.ino }]),
      counts: countsOf({ [key(1)]: { total: 4 } }),
    });
    const ok = doc((await direct(f, ['--json'])).out);
    expect(ok.counts).toMatchObject({ projects_collecting: 1, unknown_signals: 0 });
  });
});

describe('状态:stopped / confirmed 失效 / 熔断', () => {
  it('STOP 在场 → stopped,stop.at 来自标记;STOP 是目录也算在场(at=null)', async () => {
    const f = await makeRoFx('st-stop-');
    await seed(f, {
      state: baseState({ confirm: await validConfirm(f) }),
      side: { STOP: JSON.stringify({ at: NOW, by: 'user' }) },
    });
    const d = doc((await direct(f, ['--json'])).out);
    expect(d).toMatchObject({
      state: 'stopped',
      stop: { present: true, at: NOW },
      first_armed: false,
    });
    const g = await makeRoFx('st-stop-dir-');
    await seed(g, { state: baseState({ confirm: await validConfirm(g) }) });
    await mkdirp(g.io, path.join(g.io.stateDir, 'rsi', 'STOP'), 0o700);
    expect(doc((await direct(g, ['--json'])).out)).toMatchObject({
      state: 'stopped',
      stop: { present: true, at: null },
    });
  });

  it('确认被放宽失效 → armed(非首次),confirm.invalid_reason 报原因', async () => {
    const f = await makeRoFx('st-inval-');
    const confirm = await validConfirm(f);
    await seed(f, {
      state: baseState({ confirm: { ...confirm, kit_major: confirm.kit_major + 1 } }),
    });
    const d = doc((await direct(f, ['--json'])).out);
    expect(d).toMatchObject({ state: 'armed', first_armed: false });
    expect(d.confirm).toMatchObject({ invalid_reason: 'kit_major' });
  });

  it('熔断只现算:closed / open(retryable 未到点)/ half_open(到点)/ open(safety 无 until);open 报 breaker_open', async () => {
    const f = await makeRoFx('st-breaker-');
    const confirm = await validConfirm(f);
    const run = async (breaker: unknown, failures = 2): Promise<StatusDoc> => {
      await seed(f, { state: baseState({ confirm, breaker, consecutive_failures: failures }) });
      return doc((await direct(f, ['--json'])).out);
    };
    expect((await run(null, 0)).breaker).toEqual({
      state: 'closed',
      kind: null,
      consecutive_failures: 0,
      until: null,
    });
    const until = '2026-10-24T09:00:00.000Z';
    const open = await run({ kind: 'retryable', opened_at: NOW, until });
    expect(open.breaker).toEqual({
      state: 'open',
      kind: 'retryable',
      consecutive_failures: 2,
      until,
    });
    expect(open.warnings).toContain('breaker_open');
    const half = await run({
      kind: 'retryable',
      opened_at: NOW,
      until: '2026-10-24T07:00:00.000Z',
    });
    expect(half.breaker.state).toBe('half_open');
    expect(half.warnings).not.toContain('breaker_open');
    const safety = await run({ kind: 'safety', opened_at: NOW, until: null });
    expect(safety.breaker).toMatchObject({ state: 'open', kind: 'safety', until: null });
  });

  it('last_tick 映射:completed_at → at', async () => {
    const f = await makeRoFx('st-tick-');
    await seed(f, {
      state: baseState({
        confirm: await validConfirm(f),
        last_tick: {
          completed_at: NOW,
          trigger: 'poke',
          outcome: 'ok',
          code: null,
          duration_ms: 12,
          files_read: 3,
          bytes_read: 400,
        },
      }),
    });
    expect(doc((await direct(f, ['--json'])).out).last_tick).toEqual({
      at: NOW,
      trigger: 'poke',
      outcome: 'ok',
      code: null,
      duration_ms: 12,
      files_read: 3,
      bytes_read: 400,
    });
  });
});

describe('快照协议与失败码:不吞错', () => {
  it('清单与文件两次都不一致 → 4 RSI_SNAPSHOT_BUSY,stdout 空', async () => {
    const f = await makeRoFx('st-busy-');
    await seed(f, { state: baseState(), counts: countsOf({}) });
    // 提交之后改 counts.json(不重提交):清单与文件永远对不上
    await writeFile(f.io, path.join(f.io.stateDir, 'rsi', 'counts.json'), '{}', { mode: 0o600 });
    const r = await direct(f, ['--json']);
    expect(r.code).toBe(4);
    expect(r.err).toBe('RSI_SNAPSHOT_BUSY\n');
    expect(r.out).toBe('');
  });

  it('rsi/ 目录权限宽于 0700 → 3 state_dir_unsafe(不自动收紧)', async () => {
    const f = await makeRoFx('st-unsafe-');
    await seed(f, { state: baseState() });
    await chmod(f.io, path.join(f.io.stateDir, 'rsi'), 0o755);
    const r = await direct(f, ['--json']);
    expect(r.code).toBe(3);
    expect(r.err).toBe('RSI_FAIL_CLOSED reason=state_dir_unsafe\n');
    expect(r.out).toBe('');
    expect(r.audit).toEqual([]);
  });

  it('state.json / counts.json / cursor.json 整份不合规 → 3 对应码;stdout 空', async () => {
    for (const [name, code] of [
      ['state.json', 'state_invalid'],
      ['counts.json', 'counts_invalid'],
      ['cursor.json', 'cursor_invalid'],
    ] as const) {
      const f = await makeRoFx(`st-bad-${name}-`);
      await seed(f, { state: baseState(), raw: { [name]: '{"bad":true}' } });
      const r = await direct(f, ['--json']);
      expect(r.code, name).toBe(3);
      expect(r.err).toBe(`RSI_FAIL_CLOSED reason=${code}\n`);
      expect(r.out).toBe('');
    }
  });

  it('清单自身损坏 → 3 snapshot_invalid', async () => {
    const f = await makeRoFx('st-badsnap-');
    await seed(f, { state: baseState() });
    await writeFile(f.io, path.join(f.io.stateDir, 'rsi', 'snapshot.json'), 'not json', {
      mode: 0o600,
    });
    const r = await direct(f, ['--json']);
    expect(r.code).toBe(3);
    expect(r.err).toBe('RSI_FAIL_CLOSED reason=snapshot_invalid\n');
  });

  it('TAINTED 标记:内容不合规 → 3 state_invalid;是符号链接 → 3 state_dir_unsafe;缺失 → 按 journal 回退', async () => {
    const mk = async (tainted?: Record<string, string>, journal = false): Promise<RoFx> => {
      const f = await makeRoFx('st-taint-');
      const a = await mkProject(f, 'a');
      await seed(f, {
        state: baseState({ confirm: await validConfirm(f) }),
        index: indexOf([{ key: key(1), path: a.path, dev: a.dev, ino: a.ino }]),
        counts: countsOf(
          { [key(1)]: { total: 1 } },
          { staged: [{ run_id: 'r1', proposals: 1, evidence_keys: [key(1)], tainted: true }] },
        ),
        ...(tainted !== undefined ? { tainted } : {}),
        ...(journal ? { side: { 'purge-journal.json': '{}' } } : {}),
      });
      return f;
    };
    const bad = await mk({ r1: '{"reason":"nope"}' });
    expect((await direct(bad, ['--json'])).err).toBe('RSI_FAIL_CLOSED reason=state_invalid\n');
    const link = await mk();
    const d = path.join(link.io.stateDir, 'reflect', 'r1');
    await mkdirp(link.io, d, 0o755);
    await writeFile(
      link.fx,
      path.join(link.dir, 'real'),
      JSON.stringify({ reason: 'purge', at: NOW }),
      {
        mode: 0o600,
      },
    );
    await symlink(link.fx, path.join(link.dir, 'real'), path.join(d, 'TAINTED'));
    const rl = await direct(link, ['--json']);
    expect(rl.code).toBe(3);
    expect(rl.err).toBe('RSI_FAIL_CLOSED reason=state_dir_unsafe\n');
    const none = await mk();
    expect(doc((await direct(none, ['--json'])).out).tainted).toEqual([
      { run_id: 'r1', reason: 'exclude' },
    ]);
    const withJournal = await mk(undefined, true);
    const wj = doc((await direct(withJournal, ['--json'])).out);
    expect(wj.purge).toEqual({ journal: 'present' });
    expect(wj.tainted).toEqual([{ run_id: 'r1', reason: 'purge' }]);
  });
});

describe('TAINTED 读取的父目录链:reflect/ 与 reflect/<run_id>/ 必须是真实目录', () => {
  const mk = async (): Promise<RoFx> => {
    const f = await makeRoFx('st-taintparent-');
    const a = await mkProject(f, 'a');
    await seed(f, {
      state: baseState({ confirm: await validConfirm(f) }),
      index: indexOf([{ key: key(1), path: a.path, dev: a.dev, ino: a.ino }]),
      counts: countsOf(
        { [key(1)]: { total: 1 } },
        { staged: [{ run_id: 'r1', proposals: 1, evidence_keys: [key(1)], tainted: true }] },
      ),
    });
    return f;
  };
  const outside = async (f: RoFx): Promise<string> => {
    // 一个「状态目录之外」的真实 run 目录,里面有合规的 TAINTED
    const o = path.join(f.dir, 'outside', 'r1');
    await mkdirp(f.fx, o, 0o755);
    await writeFile(f.fx, path.join(o, 'TAINTED'), JSON.stringify({ reason: 'purge', at: NOW }), {
      mode: 0o600,
    });
    return o;
  };

  it('reflect/<run_id> 是符号链接 → 3 state_dir_unsafe,不读目录外的 TAINTED', async () => {
    const f = await mk();
    const o = await outside(f);
    await mkdirp(f.io, path.join(f.io.stateDir, 'reflect'), 0o755);
    await symlink(f.fx, o, path.join(f.io.stateDir, 'reflect', 'r1'));
    const r = await direct(f, ['--json']);
    expect([r.code, r.err, r.out]).toEqual([3, 'RSI_FAIL_CLOSED reason=state_dir_unsafe\n', '']);
  });

  it('reflect 本身是符号链接 → 3 state_dir_unsafe', async () => {
    const f = await mk();
    await outside(f);
    await symlink(f.fx, path.join(f.dir, 'outside'), path.join(f.io.stateDir, 'reflect'));
    const r = await direct(f, ['--json']);
    expect([r.code, r.err]).toEqual([3, 'RSI_FAIL_CLOSED reason=state_dir_unsafe\n']);
  });

  it('对照:真实目录链 + 合规 TAINTED → 读到原因;链路上缺目录 → 按 journal 回退', async () => {
    const f = await mk();
    await mkdirp(f.io, path.join(f.io.stateDir, 'reflect', 'r1'), 0o755);
    await writeFile(
      f.io,
      path.join(f.io.stateDir, 'reflect', 'r1', 'TAINTED'),
      JSON.stringify({ reason: 'purge', at: NOW }),
      { mode: 0o600 },
    );
    expect(doc((await direct(f, ['--json'])).out).tainted).toEqual([
      { run_id: 'r1', reason: 'purge' },
    ]);
    const g = await mk();
    expect(doc((await direct(g, ['--json'])).out).tainted).toEqual([
      { run_id: 'r1', reason: 'exclude' },
    ]);
  });
});

describe('lock / agents / warnings', () => {
  it('lock:free;被存活进程占着 = held;占着超过 TTL = held_over_ttl;pid 已死 = stale;锁文件不安全 = unsafe', async () => {
    const f = await makeRoFx('st-lock-');
    await seed(f, { state: baseState() });
    const lockFile = path.join(f.io.stateDir, 'rsi', 'lock');
    const put = async (startedAt: string, mode = 0o600): Promise<void> => {
      await remove(f.io, lockFile);
      await writeFile(
        f.io,
        lockFile,
        JSON.stringify({
          pid: 4242,
          started_at: startedAt,
          nonce: '0123456789abcdef',
          kit_version: '0.1.0',
        }),
        { mode },
      );
    };
    const lockOf = async (alive: boolean): Promise<string> =>
      doc(
        (
          await direct(f, ['--json'], {
            now: () => T_NOW,
            lock: { isAlive: () => alive, now: () => T_NOW },
          })
        ).out,
      ).lock;
    expect(await lockOf(true)).toBe('free');
    await put('2026-10-24T07:59:00.000Z');
    expect(await lockOf(true)).toBe('held');
    await put('2026-10-24T07:00:00.000Z');
    expect(await lockOf(true)).toBe('held_over_ttl');
    expect(await lockOf(false)).toBe('stale');
    await put('2026-10-24T07:59:00.000Z', 0o644);
    expect(await lockOf(true)).toBe('unsafe');
  });

  it('agents:会话根链上有符号链接 → not_evaluated/root_symlink;pi 且 PI_CODING_AGENT_DIR 已设 → pi_dir_override;其余 ok', async () => {
    const f = await makeRoFx('st-agents-');
    await mkdirp(f.fx, path.join(f.dir, 'elsewhere'), 0o755);
    await symlink(f.fx, path.join(f.dir, 'elsewhere'), path.join(f.home, '.claude'));
    await mkdirp(f.fx, path.join(f.home, '.codex'), 0o755);
    await writeFile(f.fx, path.join(f.home, '.codex', 'sessions'), 'file', { mode: 0o600 });
    const r = doc(
      (await runMain(f, ['rsi', 'status', '--json'], { env: { PI_CODING_AGENT_DIR: '' } })).out,
    );
    expect(r.agents).toEqual([
      { id: 'claude', status: 'not_evaluated', reason: 'root_symlink' },
      { id: 'codex', status: 'not_evaluated', reason: 'root_not_dir' },
      { id: 'pi', status: 'not_evaluated', reason: 'pi_dir_override' },
    ]);
    const g = await makeRoFx('st-agents-ok-');
    expect(
      doc((await runMain(g, ['rsi', 'status', '--json'])).out).agents.map((a) => a.status),
    ).toEqual(['ok', 'ok', 'ok']);
  });

  it('warnings:overlay_absent / cloud_sync_suspected(只按路径段启发式,路径不输出)', async () => {
    const f = await makeRoFx('st-warn-');
    const d = doc((await runMain(f, ['rsi', 'status', '--json'])).out);
    expect(d.warnings).toEqual(['overlay_absent']);
    const g = await makeRoFx('st-warn-cloud-');
    const cloud = path.join(g.dir, 'Dropbox', 'repo2');
    await mkdirp(g.fx, cloud, 0o755);
    await writeFile(g.fx, path.join(cloud, 'kit.toml'), '[kit]\n', { mode: 0o644 });
    await chmod(g.fx, cloud, 0o755);
    await chmod(g.fx, path.join(g.dir, 'Dropbox'), 0o755);
    await writeFile(g.fx, g.cfgFile, `[rsi]\nenabled = true\nrepo = ${JSON.stringify(cloud)}\n`, {
      mode: 0o600,
    });
    const r = await runMain(g, ['rsi', 'status', '--json']);
    expect(doc(r.out).warnings).toEqual(['overlay_absent', 'cloud_sync_suspected']);
    expect(r.out).not.toContain('Dropbox');
  });
});

describe('展示层:状态文件复制到输出的字符串字段(last_tick.code)只许稳定码字符集', () => {
  const withCode = async (code: string): Promise<RoFx> => {
    const f = await makeRoFx('st-code-');
    await seed(f, {
      state: baseState({
        confirm: await validConfirm(f),
        last_tick: {
          completed_at: NOW,
          trigger: 'poke',
          outcome: 'ok',
          code,
          duration_ms: 1,
          files_read: 0,
          bytes_read: 0,
        },
      }),
    });
    return f;
  };

  it('含换行 / ESC / U+2028 / U+2029 / 斜杠 / 空格的 code → 3 state_invalid,stdout 空(文本与 --json 都是)', async () => {
    for (const bad of [
      'ok\nstate=confirmed',
      'ok\u001b[31m',
      'a\u2028b',
      'a\u2029b',
      'a/b',
      'a b',
      'tab\there',
    ]) {
      const f = await withCode(bad);
      for (const argv of [[], ['--json']]) {
        const r = await direct(f, argv);
        expect([r.code, r.out, r.err], JSON.stringify(bad)).toEqual([
          3,
          '',
          'RSI_FAIL_CLOSED reason=state_invalid\n',
        ]);
      }
    }
  });

  it('对照:合规稳定码照常输出;code 为 null 也行', async () => {
    const f = await withCode('RSI_NOT_RUN:locked.1=x-y');
    expect(doc((await direct(f, ['--json'])).out).last_tick?.code).toBe('RSI_NOT_RUN:locked.1=x-y');
    expect((await direct(f, [])).out).toContain('last_tick.code=RSI_NOT_RUN:locked.1=x-y\n');
  });
});

describe('counts.json 缺失:回退索引条目的 signals(与 projects 同口径,不读信号库)', () => {
  it('未排除项目 signals=17、counts 缺失:status 的 signals_total / unknown_signals 与 projects 一致', async () => {
    const f = await makeRoFx('st-nocounts-');
    const a = await mkProject(f, 'a');
    const g = path.join(f.dir, 'work', 'gone');
    await seed(f, {
      state: baseState({ confirm: await validConfirm(f) }),
      index: indexOf([
        { key: key(1), path: a.path, dev: a.dev, ino: a.ino, signals: 17 },
        { key: key(2), path: g, dev: 1, ino: 1, signals: 4 },
      ]),
    });
    const st = doc((await direct(f, ['--json'])).out);
    expect(st.counts.signals_total).toBe(21);
    // 统一归属(R20-4.3):counts 缺失 → 盐无法核对 → 非 X 的 key 一律 U,所以 17 与 4 都计入未知
    expect(st.counts.unknown_signals).toBe(21);
    const pj = JSON.parse((await runDirect(f, runProjects, ['--json'], {})).out) as {
      rows: { signals: number; status: string }[];
      summary: { unknown_signals: number };
    };
    expect(pj.rows.map((r) => r.signals)).toEqual([17, 4]);
    expect(pj.summary.unknown_signals).toBe(st.counts.unknown_signals);
    expect(pj.rows.reduce((n, r) => n + r.signals, 0)).toBe(st.counts.signals_total);
  });
});
