/**
 * R20-A3:`rsi hint`(契约 R20-3.3、R20-4.6、R20-3.8.5 ③、R20-2.8、R20-1.6;A3 方案 v2 R6 / R7)。
 *  - 模板与输出条件、≤ 200 字节、无路径 / 目录名 / key;
 *  - 计数与 `rsi status --json` 同口径(对拍);写下排除后下一次 hint 即不计该项目(中间不跑 tick);
 *  - 受限读取:盐、信号库、会话根、`cursor.json` 被设为不可读时照常输出(读了就会失败 → 空串);
 *  - 去重标记是唯一写入;输出空串的调用零写入(写审计 + 目录树)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RSI_HINT_DEDUP_MS } from '../../src/contracts/rsi.js';
import { exists } from '../../src/io/read-fs.js';
import { chmod, mkdirp, writeFile } from '../../src/io/safe-fs.js';
import { buildRsiPolicy, loadRsiConfig, policyFingerprint } from '../../src/rsi/config.js';
import { runHint, type RunHintDeps } from '../../src/rsi/hint.js';
import { runStatus } from '../../src/rsi/status.js';
import { putReport } from './a6-fixture.js';
import { makeTickFx, type TickFx } from './b5a-fixture.js';
import { rsiToml, treeOf, writeCfg } from './rsi-fixture.js';
import {
  NOW,
  SALT_FP,
  baseState,
  countsOf,
  indexOf,
  key,
  mkProject,
  runDirect,
  seed,
  validConfirm,
} from './ro-fixture.js';

const NOW_MS = Date.parse(NOW);

function deps(f: TickFx, nowMs = NOW_MS): RunHintDeps {
  return {
    env: f.env,
    writeAudit: (op, p) => void f.audit.push({ op, path: p }),
    now: () => new Date(nowMs),
    clockMs: () => 0,
  };
}

async function zeroWrite(f: TickFx, run: () => Promise<string>): Promise<string> {
  const before = await treeOf(f.io.stateDir);
  f.audit.length = 0;
  const out = await run();
  expect(out).toBe('');
  expect(f.audit).toEqual([]);
  expect(await treeOf(f.io.stateDir)).toEqual(before);
  return out;
}

/** confirmed 世界:3 个项目(1 个后来可被排除),聚类 4 个达标,暂存 1 个 run(2 个提案),归属不明 2 */
async function confirmedWorld(prefix: string): Promise<{ f: TickFx; projs: string[] }> {
  const f = await makeTickFx(prefix, { noSeed: true });
  const ps = [
    await mkProject(f, 'alpha-secret'),
    await mkProject(f, 'beta'),
    await mkProject(f, 'gamma'),
  ];
  const keys = [key(1), key(2), key(3)];
  const index = indexOf(
    ps.map((p, i) => ({
      key: keys[i] as string,
      path: p.path,
      dev: p.dev,
      ino: p.ino,
      signals: 3,
      firstGen: i === 2 ? 9 : 1,
    })),
    9,
  );
  const counts = countsOf(
    {
      [keys[0] as string]: { total: 3, byDay: { '2026-10-23': 2 } },
      [keys[1] as string]: { total: 3, byDay: { '2026-10-20': 1, '2026-10-01': 5 } },
      [keys[2] as string]: { total: 3, byDay: {} },
    },
    {
      unknown: 2,
      clusterMin: 3,
      clusters: [
        { cluster_id: 'c1', evidence_by_key: { [keys[0] as string]: 3 } },
        { cluster_id: 'c2', evidence_by_key: { [keys[1] as string]: 3 } },
        { cluster_id: 'c3', evidence_by_key: { [keys[0] as string]: 2, [keys[1] as string]: 1 } },
        { cluster_id: 'c4', evidence_by_key: { [keys[0] as string]: 1, [keys[2] as string]: 2 } },
        { cluster_id: 'c5', evidence_by_key: { '?': 9 } },
      ],
      staged: [
        {
          run_id: 'r-20261020-000000-aaaaaa',
          proposals: 2,
          evidence_keys: [keys[0] as string],
          tainted: false,
        },
        {
          run_id: 'r-20261020-000000-bbbbbb',
          proposals: 7,
          evidence_keys: [keys[1] as string],
          tainted: true,
        },
      ],
    },
  );
  await seed(f, {
    state: baseState({ confirm: await validConfirm(f), projects_ack_generation: 5 }),
    index,
    counts,
  });
  // A6(R20-17.2 / R20-17.16):M 只计「待审 run」——暂存 run 须有可读的 report.json(run_id 与目录名一致)
  await putReport(f, 'r-20261020-000000-aaaaaa', 'ingest', 2);
  return { f, projs: ps.map((p) => p.path) };
}

describe('R20-3.3.2 / R20-3.3.3 confirmed 模板与计数(与 rsi status 对拍)', () => {
  it('输出一行模板,计数等于 status --json 的对应字段', async () => {
    const { f } = await confirmedWorld('a3-hint-c-');
    const st = await runDirect(f, runStatus, ['--json'], { now: () => new Date(NOW_MS) });
    expect(st.code).toBe(0);
    const c = (JSON.parse(st.out) as { counts: Record<string, number> }).counts;
    const out = await runHint(['--agent', 'claude'], deps(f));
    expect(out).toBe(
      `agent-kit RSI: 新信号 ${c['signals_new_7d']}、待反思聚类 ${c['clusters_pending']}、待审提案 ${c['pending_proposals']}、项目 ${c['projects_collecting']}(新增 ${c['projects_new']}、排除 ${c['projects_excluded']}、归属不明 ${c['unknown_signals']})。仅在用户要求时使用技能 agent-kit-rsi。\n`,
    );
    // 期望值本身(防两边一起错):N=2+1、K=4、M=2(tainted 不计)、P=3、n=1、X=0、U=2
    expect(out).toContain('新信号 3、待反思聚类 4、待审提案 2、项目 3(新增 1、排除 0、归属不明 2)');
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(200);
  });

  it('输出不含路径、目录名、key、HOME、仓库根(植入种子目录名 alpha-secret)', async () => {
    const { f, projs } = await confirmedWorld('a3-hint-leak-');
    const out = await runHint(['--agent', 'claude'], deps(f));
    expect(out).not.toBe('');
    for (const needle of ['alpha-secret', f.home, f.repo, f.dir, ...projs, 'p_0', '/']) {
      expect(out.includes(needle), needle).toBe(false);
    }
  });

  it('写下排除后,下一次 hint 即不计该项目(中间不跑 tick;R20-4.6)', async () => {
    const { f, projs } = await confirmedWorld('a3-hint-excl-');
    await writeCfg(f, rsiToml(f, `exclude_dirs = [${JSON.stringify(projs[0])}]\n`));
    // 收紧排除不使确认失效(R20-1.5)
    const out = await runHint(['--agent', 'claude'], deps(f));
    expect(out).toContain('新信号 1、待反思聚类 1、待审提案 0、项目 2(新增 1、排除 1、归属不明 2)');
  });
});

describe('R20-3.3.4 输出条件、去重与零写入', () => {
  it('同一 agent 30 分钟内只输出一次:第二次空串且零写入;下一窗口再输出;不同 agent 各自计', async () => {
    const { f } = await confirmedWorld('a3-hint-dedup-');
    expect(await runHint(['--agent', 'claude'], deps(f))).not.toBe('');
    await zeroWrite(f, () => runHint(['--agent', 'claude'], deps(f)));
    expect(await runHint(['--agent', 'pi'], deps(f))).not.toBe('');
    expect(await runHint(['--agent', 'claude'], deps(f, NOW_MS + RSI_HINT_DEDUP_MS))).not.toBe('');
  });

  it('唯一的写入是去重标记(独占创建)', async () => {
    const { f } = await confirmedWorld('a3-hint-w-');
    f.audit.length = 0;
    await runHint(['--agent', 'codex'], deps(f));
    const ops = f.audit
      .filter((c) => c.op !== 'mkdirp' && c.op !== 'chmod')
      .map((c) => `${c.op} ${path.relative(f.io.stateDir, c.path)}`);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatch(/^createExclusive rsi\/hint\/codex-\d+$/);
  });

  it('K < 3、M = 0、n = 0 → 空串、零写入', async () => {
    const f = await makeTickFx('a3-hint-quiet-', { noSeed: true });
    const p = await mkProject(f, 'one');
    await seed(f, {
      state: baseState({ confirm: await validConfirm(f), projects_ack_generation: 9 }),
      index: indexOf([{ key: key(1), path: p.path, dev: p.dev, ino: p.ino }], 9),
      counts: countsOf({ [key(1)]: { total: 1 } }),
    });
    await zeroWrite(f, () => runHint(['--agent', 'claude'], deps(f)));
  });
});

describe('空串情形(全部零写入)', () => {
  const variants: [string, (f: TickFx) => Promise<void>, Record<string, string>?][] = [
    ['KIT_AUTO_RSI=0', async () => {}, { KIT_AUTO_RSI: '0' }],
    ['KIT_RSI_CHILD=1', async () => {}, { KIT_RSI_CHILD: '1' }],
    ['CI', async () => {}, { CI: '1' }],
    [
      'purge journal 在场(R20-3.8.5 ③)',
      async (f) =>
        writeFile(f.io, path.join(f.rsiDir, 'purge-journal.json'), '{}', { mode: 0o600 }),
    ],
    [
      'STOP',
      async (f) =>
        writeFile(
          f.io,
          path.join(f.rsiDir, 'STOP'),
          '{"at":"2026-10-24T00:00:00.000Z","by":"user"}',
          { mode: 0o600 },
        ),
    ],
    [
      '快照清单不一致(未提交的 state.json)',
      async (f) => writeFile(f.io, path.join(f.rsiDir, 'counts.json'), '{"x":1}', { mode: 0o600 }),
    ],
    ['索引损坏', async (f) => seed(f, { raw: { 'projects.json': '{"schema_version":1}' } })],
    [
      '停止采集(exclude_names 不合规)',
      async (f) => writeCfg(f, rsiToml(f, 'exclude_names = ["a/b"]\n')),
    ],
    ['off(没有 [rsi])', async (f) => writeCfg(f, '[update]\n')],
  ];
  for (const [name, setup, env] of variants) {
    it(name, async () => {
      const { f } = await confirmedWorld('a3-hint-empty-');
      await setup(f);
      await zeroWrite(f, () =>
        runHint(['--agent', 'claude'], { ...deps(f), env: { ...f.env, ...(env ?? {}) } }),
      );
    });
  }
  for (const argv of [
    [],
    ['--agent'],
    ['--agent', 'kimi'],
    ['--agent', 'claude', '--format', 'json'],
    ['--format', 'json'],
  ]) {
    it(`参数 ${JSON.stringify(argv)} → 空串(--format 是 P1)`, async () => {
      const { f } = await confirmedWorld('a3-hint-arg-');
      await zeroWrite(f, () => runHint(argv, deps(f)));
    });
  }
  it('agent 不在 [rsi] agents', async () => {
    const { f } = await confirmedWorld('a3-hint-ag-');
    await writeCfg(f, rsiToml(f, 'agents = ["pi"]\n'));
    await zeroWrite(f, () => runHint(['--agent', 'claude'], deps(f)));
  });
});

describe('armed 模板(D2:state.armed_listing 绑定当前 policy_fp 与 agents)', () => {
  async function armedWith(listing: Record<string, unknown> | null): Promise<TickFx> {
    const f = await makeTickFx('a3-hint-armed-', { noSeed: true });
    const cfg = await loadRsiConfig({ home: f.home });
    if (cfg.status !== 'on') throw new Error('off');
    const policy = await buildRsiPolicy(cfg);
    const al =
      listing === null
        ? {}
        : {
            armed_listing: {
              at: NOW,
              policy_fp: policyFingerprint(policy),
              agents: [...policy.agents],
              projects: 12345,
              excluded: 1,
              unknown_sessions: 0,
              ...listing,
            },
          };
    await seed(f, { state: baseState(al) });
    return f;
  }
  it('绑定一致 → 第二个模板(计数 9999 封顶)', async () => {
    const f = await armedWith({});
    expect(await runHint(['--agent', 'claude'], deps(f))).toBe(
      'agent-kit RSI: 待确认,将采集 9999+ 个项目。仅在用户要求时运行 agent-kit rsi confirm。\n',
    );
  });
  it('缺失 / policy_fp 不符 / agents 不符 → 空串、零写入', async () => {
    for (const l of [null, { policy_fp: 'f'.repeat(64) }, { agents: ['pi'] }]) {
      const f = await armedWith(l);
      await zeroWrite(f, () => runHint(['--agent', 'claude'], deps(f)));
    }
  });
});

describe('受限读取集合(R20-3.3.1):盐 / 信号库 / 会话计数 / 会话根 / cursor 不可读时照常输出', () => {
  it('把这些都设为 000 权限,hint 仍输出同一行', async () => {
    const { f } = await confirmedWorld('a3-hint-ro-');
    const expected = await runHint(['--agent', 'claude'], deps(f));
    expect(expected).not.toBe('');
    const st = f.io.stateDir;
    await writeFile(f.io, path.join(st, 'salt'), 'ab'.repeat(32), { mode: 0o600 });
    await mkdirp(f.io, path.join(st, 'signals', 'claude'), 0o700);
    await writeFile(f.io, path.join(st, 'signals', 'claude', '202610.jsonl'), '{}\n', {
      mode: 0o600,
    });
    await mkdirp(f.io, path.join(st, 'sessions', 'claude'), 0o700);
    await seed(f, { cursor: { bogus: true } }); // cursor 在清单里,但 hint 只核对自己读的三个文件
    const claudeRoot = path.join(f.home, '.claude', 'projects');
    await mkdirp(f.fx, claudeRoot, 0o700);
    const locked = [
      path.join(st, 'salt'),
      path.join(st, 'signals'),
      path.join(st, 'sessions'),
      path.join(f.rsiDir, 'cursor.json'),
      claudeRoot,
    ];
    for (const p of locked) await chmod(f.fx, p, 0o000);
    try {
      expect(await runHint(['--agent', 'claude'], deps(f, NOW_MS + RSI_HINT_DEDUP_MS))).toBe(
        expected,
      );
    } finally {
      for (const p of locked) await chmod(f.fx, p, 0o700);
    }
    expect(SALT_FP).toMatch(/^[0-9a-f]{12}$/);
    expect(await exists(path.join(f.rsiDir, 'lock'))).toBe(false); // 不拿锁
  });
});
