/**
 * R20-A6:doctor D17「rsi」(R20-17.19–R20-17.21;订正 ④ ⑤;负向矩阵 R20-17.25 的 D17 部分)。
 * 采集面按 §20.2 的配置结果判,钩子面经只读出口 `hooks-read.ts`;两面合成。全部在假 HOME(目录名含用户名样的 `alice`)内跑,不碰真实 HOME。
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDoctorCommand } from '../../src/commands/doctor.js';
import { DOCTOR_CHECK_IDS } from '../../src/contracts/doctor.js';
import { RSI_STAGING_MAX_RUNS } from '../../src/contracts/rsi.js';
import { checkD17, type D17Input } from '../../src/doctor/checks.js';
import { HooksRead } from '../../src/io/hooks-read.js';
import { canonicalJson } from '../../src/io/canonical-json.js';
import { createIoContext } from '../../src/io/paths.js';
import { readText } from '../../src/io/read-fs.js';
import { mkdirp, rename, symlink, writeFile } from '../../src/io/safe-fs.js';
import { inspectHooks } from '../../src/rsi/hooks/inspect.js';
import { REPO_ROOT } from '../helpers/tmp.js';
import { ROOT, closureOf, fsWriteUses } from './closure-util.js';
import { dismissedDoc, makeA6World, putReport, putRsiFile } from './a6-fixture.js';
import { baseState, makeRoFx, seed, setExtra, type RoFx } from './ro-fixture.js';
import { treeOf } from './rsi-fixture.js';

interface D17Json {
  id: string;
  status: string;
  result: string;
  counts: Record<string, number>;
  facts: Record<string, string | number | boolean | null>;
  items: string[];
}

async function doctor(
  f: RoFx,
  extra: string[] = [],
): Promise<{ code: number; out: string; err: string; d17: D17Json }> {
  let out = '';
  let err = '';
  const io = createIoContext({ cwd: REPO_ROOT, env: f.env });
  const code = await createDoctorCommand().run({
    argv: ['--json', '--only', 'D17', ...extra],
    io,
    overlayPath: undefined,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    env: f.env,
  });
  const rep = JSON.parse(out) as { checks: D17Json[] };
  return { code, out, err, d17: rep.checks[0] as D17Json };
}

const alice = (prefix: string): Promise<RoFx> => makeRoFx(`${prefix}alice-`);

const hooksDir = (f: RoFx): string => path.join(f.home, '.local', 'state', 'agent-kit', 'hooks');
const TXN = '20261101T000000Z-0123456789abcdef';

async function hooksState(
  f: RoFx,
  o: { ledger?: unknown | string; marker?: boolean; journals?: string[]; pi?: { text: string } },
): Promise<void> {
  const dir = hooksDir(f);
  await mkdirp(f.fx, path.join(dir, 'txn'), 0o700);
  if (o.pi !== undefined) {
    const ext = path.join(f.home, '.pi', 'agent', 'extensions');
    await mkdirp(f.fx, ext, 0o755);
    await writeFile(f.fx, path.join(ext, 'agent-kit-rsi.ts'), o.pi.text, { mode: 0o644 });
  }
  if (o.marker !== false)
    await writeFile(f.fx, path.join(dir, 'ledger.established'), '', { mode: 0o600 });
  if (o.ledger !== undefined) {
    const text = typeof o.ledger === 'string' ? o.ledger : JSON.stringify(o.ledger);
    await writeFile(f.fx, path.join(dir, 'ledger.json'), text, { mode: 0o600 });
  }
  for (const j of o.journals ?? [])
    await writeFile(f.fx, path.join(dir, 'txn', `${j}.json`), '{}', { mode: 0o600 });
}

const sha = (t: string): string => createHash('sha256').update(t).digest('hex');
const piLedger = (fingerprint: string): unknown => ({
  schema_version: 1,
  generation: 1,
  entries: [
    { agent: 'pi', event: 'file', fingerprint, shape_version: '1', variant: 'plain', txn_id: TXN },
  ],
  applied_txns: [],
});

describe('R20-17.19 采集面:按 §20.2 的配置结果判(不以 state 为前提)', () => {
  it('没有 [rsi] 段 → n_a / absent;enabled = false → n_a / disabled(两面都 n_a → D17 n_a)', async () => {
    const f = await alice('a6-dr-absent-');
    await writeFile(f.fx, f.cfgFile, '[other]\nx = 1\n', { mode: 0o600 });
    expect((await doctor(f)).d17).toMatchObject({ status: 'n_a', result: 'absent' });
    await writeFile(f.fx, f.cfgFile, '[rsi]\nenabled = false\n', { mode: 0o600 });
    expect((await doctor(f)).d17).toMatchObject({ status: 'n_a', result: 'disabled' });
  });

  it('使状态为 off 的配置问题(cfg_*、repo_invalid)→ fail,result 为该原因码;退出码 1,不是顶层 fail-closed 的 3', async () => {
    const f = await alice('a6-dr-cfg-');
    await writeFile(f.fx, f.cfgFile, '[rsi]\nenabled = true\nagents = ["kimi"]\n', { mode: 0o600 });
    const r = await doctor(f);
    expect(r.d17).toMatchObject({ status: 'fail', result: 'cfg_schema' });
    expect(r.code).toBe(1);
    expect(r.err).toBe('DOCTOR_CHECK_FAILED check=D17 result=cfg_schema\n');
  });

  it('collect block:confirmed + overlay_invalid / exclude_invalid → fail,result 为该原因码(不论状态)', async () => {
    for (const [extra, code] of [
      ['overlay = "/nonexistent/overlay.toml"\n', 'overlay_invalid'],
      ['exclude_dirs = ["relative/dir"]\n', 'exclude_invalid'],
    ] as const) {
      const f = await alice(`a6-dr-block-${code}-`);
      await makeA6World(f, [{ runId: 'r-1' }]);
      await setExtra(f, extra);
      const r = await doctor(f);
      expect(r.d17, code).toMatchObject({ status: 'fail', result: code });
      expect(r.code, code).toBe(1);
    }
    // armed 下的 block 同样 fail
    const g = await alice('a6-dr-block-armed-');
    await setExtra(g, 'exclude_dirs = ["relative/dir"]\n');
    expect((await doctor(g)).d17).toMatchObject({ status: 'fail', result: 'exclude_invalid' });
  });

  it('confirmed 且一切正常 → ok;facts 只含枚举 / 计数 / 布尔(pending_runs=1 等)', async () => {
    const f = await alice('a6-dr-ok-');
    await makeA6World(f, [{ runId: 'r-1', proposals: 2 }]);
    const r = await doctor(f);
    expect(r.d17).toMatchObject({ status: 'ok', result: 'ok' });
    expect(r.d17.facts).toMatchObject({
      state: 'confirmed',
      projects_collecting: 1,
      projects_excluded: 0,
      pending_runs: 1,
      pending_proposals: 2,
      staging_run_limit_reached: false,
      'hooks.claude': 'not_installed',
      'hooks.codex': 'not_installed',
      'hooks.pi': 'not_installed',
      hooks_residue: 0,
    });
    expect(r.code).toBe(0);
  });

  it('warn:stopped / armed / 暂存达到 run 上限 / unreadable_runs / dismissed_invalid / notice_invalid / run_scan_truncated', async () => {
    const cases: [string, (f: RoFx) => Promise<void>, string][] = [
      [
        'stopped',
        async (f) =>
          void (await putRsiFile(f, 'STOP', '{"at":"2026-10-24T00:00:00.000Z","by":"user"}')),
        'stopped',
      ],
      [
        'armed',
        async (f) => {
          await seed(f, { state: baseState({ confirm: null }) });
        },
        'armed',
      ],
      [
        'staging_run_limit',
        async (f) => {
          for (let i = 0; i < RSI_STAGING_MAX_RUNS; i++) {
            await mkdirp(f.io, path.join(f.io.stateDir, 'reflect', `pad-${i}`), 0o755);
          }
        },
        'staging_run_limit',
      ],
      [
        'unreadable_runs',
        async (f) => void (await putReport(f, 'r-1', 'ingest', 1, '{broken')),
        'unreadable_runs',
      ],
      [
        'dismissed_invalid',
        async (f) => void (await putRsiFile(f, 'dismissed.json', '{"x":1}')),
        'dismissed_invalid',
      ],
      [
        'notice_invalid',
        async (f) => void (await putRsiFile(f, 'notice.json', '{"x":1}')),
        'notice_invalid',
      ],
      [
        'run_scan_truncated',
        async (f) => {
          for (let i = 0; i < 1000; i++) {
            await mkdirp(
              f.io,
              path.join(f.io.stateDir, 'reflect', `pad-${String(i).padStart(4, '0')}`),
              0o755,
            );
          }
        },
        'run_scan_truncated',
      ],
    ];
    for (const [name, prep, result] of cases) {
      const f = await alice(`a6-dr-warn-${name}-`);
      await makeA6World(f, [{ runId: 'r-1' }]);
      await prep(f);
      const r = await doctor(f);
      expect(r.d17, name).toMatchObject({ status: 'warn', result });
      expect(r.code, name).toBe(0); // warn 不改退出码
    }
  }, 180_000);

  it('state / 计数读不了或 schema 不过 → fail;私有区目录不安全 → fail 且退出 1(不新增顶层 fail-closed)', async () => {
    const f = await alice('a6-dr-counts-');
    await seed(f, {
      state: baseState({ confirm: null }),
      raw: { 'counts.json': '{"schema_version":1}' },
    });
    expect((await doctor(f)).d17).toMatchObject({ status: 'fail', result: 'counts_invalid' });

    const g = await alice('a6-dr-state-');
    await seed(g, { raw: { 'state.json': '{"nope":true}' } });
    expect((await doctor(g)).d17).toMatchObject({ status: 'fail', result: 'state_invalid' });

    const h = await alice('a6-dr-unsafe-');
    await makeA6World(h, [{ runId: 'r-1' }]);
    await rename(h.io, path.join(h.io.stateDir, 'rsi'), path.join(h.io.stateDir, 'rsi-moved'));
    await symlink(h.io, path.join(h.io.stateDir, 'rsi-moved'), path.join(h.io.stateDir, 'rsi'));
    const r = await doctor(h);
    expect(r.d17).toMatchObject({ status: 'fail', result: 'state_dir_unsafe' });
    expect(r.code).toBe(1);
    expect(r.err).not.toContain('DOCTOR_FAIL_CLOSED');
  });
});

describe('R20-17.19 钩子面(与 RSI 开关无关,R20-15.4)', () => {
  const inspect = (f: RoFx) => inspectHooks(new HooksRead({ home: f.home }));

  it('私有状态区不存在 → n_a', async () => {
    const f = await alice('a6-dr-hk-none-');
    expect(await inspect(f)).toMatchObject({ status: 'n_a', residue: 0 });
  });

  it('账本合法且 pi 扩展指纹一致 → ok,pi 为 installed', async () => {
    const f = await alice('a6-dr-hk-ok-');
    const text = 'export default function () {}\n';
    await hooksState(f, { ledger: piLedger(sha(text)), pi: { text } });
    expect(await inspect(f)).toMatchObject({
      status: 'ok',
      result: 'ok',
      agents: { pi: 'installed', claude: 'not_installed' },
    });
  });

  it('pi 扩展文件 sha 与账本指纹不符 → warn hooks_drifted(只报不修:文件字节不变);扩展被删(节点已不在)同样', async () => {
    const f = await alice('a6-dr-hk-drift-');
    const text = 'export default function () {}\n';
    await hooksState(f, { ledger: piLedger(sha(text)), pi: { text: `${text}// user edit\n` } });
    const before = await treeOf(f.home);
    expect(await inspect(f)).toMatchObject({ status: 'warn', result: 'hooks_drifted' });
    expect(await treeOf(f.home)).toEqual(before);
    const g = await alice('a6-dr-hk-gone-');
    await hooksState(g, { ledger: piLedger(sha(text)) }); // 没有扩展文件
    expect(await inspect(g)).toMatchObject({ status: 'warn', result: 'hooks_drifted' });
  });

  it('claude:账本登记的节点在 settings.json 里还在 → ok;节点被删 → hooks_drifted', async () => {
    const f = await alice('a6-dr-hk-claude-');
    const wrapper = {
      hooks: [{ type: 'command', command: 'agent-kit rsi hint --agent claude', timeout: 5 }],
    };
    const fp = sha(canonicalJson({ event: 'SessionStart', entry: wrapper }));
    const ledger = {
      schema_version: 1,
      generation: 1,
      entries: [
        {
          agent: 'claude',
          event: 'SessionStart',
          fingerprint: fp,
          shape_version: '1',
          variant: 'plain',
          txn_id: TXN,
        },
      ],
      applied_txns: [],
    };
    await hooksState(f, { ledger });
    await mkdirp(f.fx, path.join(f.home, '.claude'), 0o755);
    await writeFile(
      f.fx,
      path.join(f.home, '.claude', 'settings.json'),
      `${JSON.stringify({ hooks: { SessionStart: [wrapper] } }, null, 2)}\n`,
      { mode: 0o644 },
    );
    expect(await inspect(f)).toMatchObject({ status: 'ok', agents: { claude: 'installed' } });
    await writeFile(
      f.fx,
      path.join(f.home, '.claude', 'settings.json'),
      `${JSON.stringify({ hooks: { SessionStart: [] } }, null, 2)}\n`,
      { mode: 0o644 },
    );
    expect(await inspect(f)).toMatchObject({ status: 'warn', result: 'hooks_drifted' });
  });

  it('残留 journal / tmp → warn hooks_residue,不判漂移、不清理(目录树不变)', async () => {
    const f = await alice('a6-dr-hk-residue-');
    const text = 'x\n';
    await hooksState(f, {
      ledger: piLedger(sha(text)),
      pi: { text: 'changed\n' },
      journals: [TXN],
    });
    const before = await treeOf(f.home);
    const r = await inspect(f);
    expect(r).toMatchObject({ status: 'warn', result: 'hooks_residue', residue: 1 });
    expect(await treeOf(f.home)).toEqual(before);
  });

  it('账本不安全 / schema 不过 / 账本在而标记缺 / 标记在而账本缺且无 journal → fail hooks_ledger_invalid', async () => {
    const cases: [string, Parameters<typeof hooksState>[1]][] = [
      ['schema', { ledger: '{"schema_version":1}' }],
      ['json', { ledger: '{{' }],
      ['无标记', { ledger: piLedger(sha('x')), marker: false }],
      ['账本缺', {}],
    ];
    for (const [name, st] of cases) {
      const f = await alice('a6-dr-hk-bad-');
      await hooksState(f, st);
      expect(await inspect(f), name).toMatchObject({
        status: 'fail',
        result: 'hooks_ledger_invalid',
      });
    }
    // 账本权限过宽(0644)= 不安全
    const g = await alice('a6-dr-hk-perm-');
    await hooksState(g, {});
    await writeFile(
      g.fx,
      path.join(hooksDir(g), 'ledger.json'),
      JSON.stringify(piLedger(sha('x'))),
      { mode: 0o644 },
    );
    expect(await inspect(g)).toMatchObject({ status: 'fail', result: 'hooks_ledger_invalid' });
  });

  it('经 doctor:钩子残留报 hooks_residue(不报漂移),退出码 0;facts 带 hooks_residue 数量', async () => {
    const f = await alice('a6-dr-hk-cmd-');
    await hooksState(f, { ledger: piLedger(sha('x')), journals: [TXN] });
    const r = await doctor(f);
    expect(r.d17).toMatchObject({ status: 'warn', result: 'hooks_residue' });
    expect(r.d17.facts['hooks_residue']).toBe(1);
    expect(r.out).not.toContain('hooks_drifted');
    expect(r.code).toBe(0);
  });
});

describe('R20-17.19 合成:严重度最高的一面,并列取采集面', () => {
  const base: D17Input = {
    collection: { status: 'ok', result: 'ok', items: [] },
    hooks: {
      status: 'ok',
      result: 'ok',
      agents: { claude: 'not_installed', codex: 'not_installed', pi: 'not_installed' },
      residue: 0,
    },
    facts: {
      state: 'confirmed',
      projects_collecting: 1,
      projects_excluded: 0,
      pending_runs: 0,
      pending_proposals: 0,
      staging_run_limit_reached: false,
    },
  };
  const mk = (
    c: [D17Input['collection']['status'], string],
    h: [D17Input['hooks']['status'], string],
  ): D17Input => ({
    ...base,
    collection: { status: c[0], result: c[1], items: [] },
    hooks: { ...base.hooks, status: h[0], result: h[1] },
  });
  it('两面都 n_a → n_a;n_a + ok → ok;ok + warn → warn(取钩子面原因);warn + warn → 采集面;fail > warn', () => {
    expect(checkD17(mk(['n_a', 'absent'], ['n_a', 'absent']))).toMatchObject({
      status: 'n_a',
      result: 'absent',
    });
    expect(checkD17(mk(['n_a', 'disabled'], ['ok', 'ok']))).toMatchObject({
      status: 'ok',
      result: 'ok',
    });
    expect(checkD17(mk(['ok', 'ok'], ['warn', 'hooks_drifted']))).toMatchObject({
      status: 'warn',
      result: 'hooks_drifted',
    });
    expect(checkD17(mk(['warn', 'stopped'], ['warn', 'hooks_residue']))).toMatchObject({
      status: 'warn',
      result: 'stopped',
    });
    expect(checkD17(mk(['warn', 'stopped'], ['fail', 'hooks_ledger_invalid']))).toMatchObject({
      status: 'fail',
      result: 'hooks_ledger_invalid',
    });
    expect(checkD17(mk(['fail', 'repo_invalid'], ['fail', 'hooks_ledger_invalid']))).toMatchObject({
      status: 'fail',
      result: 'repo_invalid',
    });
  });
});

describe('R20-17.20 只读、无绝对路径、不拿锁', () => {
  it('输出(text / json)不含 HOME、仓库根、KIT_TMP、状态目录的绝对路径,也不含假 HOME 里的用户名样目录名 alice', async () => {
    const f = await alice('a6-dr-leak-');
    await makeA6World(f, [{ runId: 'r-1' }]);
    await hooksState(f, { ledger: piLedger(sha('x')), journals: [TXN] });
    for (const extra of [[], ['--json']]) {
      const r = await doctor(f, extra);
      for (const needle of [f.dir, f.home, f.repo, f.io.stateDir, 'alice', 'proj']) {
        expect(r.out.includes(needle), `${needle}`).toBe(false);
      }
    }
  });

  it('零写入、不拿锁、不清理残留:目录树前后一致;另一个存活进程持锁时 D17 照常给出结论(不被锁挡住,也不回收别人的锁)', async () => {
    const f = await alice('a6-dr-ro-');
    await makeA6World(f, [{ runId: 'r-1' }]);
    await hooksState(f, { ledger: piLedger(sha('x')), journals: [TXN] });
    const lockDoc = JSON.stringify({
      pid: process.pid,
      started_at: new Date().toISOString(),
      nonce: '0123456789abcdef',
      kit_version: '0.0.0',
    });
    await putRsiFile(f, 'lock', lockDoc);
    await putRsiFile(f, 'dismissed.json', dismissedDoc(['gone-run'])); // 可清理的陈旧条目:D17 不得顺手清理
    const before = await treeOf(f.dir);
    const r = await doctor(f);
    expect(r.d17.status).not.toBe('fail');
    expect(await treeOf(f.dir)).toEqual(before);
  });

  it('D17 属于 DOCTOR_CHECK_IDS(17 项);--only D17 被接受', () => {
    expect(DOCTOR_CHECK_IDS).toHaveLength(17);
    expect(DOCTOR_CHECK_IDS[16]).toBe('D17');
  });
});

describe('R20-17.20 / 订正 ⑤ 静态:doctor 只许 import hooks-read.ts,不许 import hooks-fs.ts', () => {
  const WRITE_SIDE = [
    'src/io/hooks-fs.ts',
    'src/io/home-fs.ts',
    'src/rsi/lock.ts',
    'src/rsi/with-lock.ts',
    'src/rsi/snapshot.ts',
    'src/rsi/hooks/txn.ts',
    'src/rsi/hooks/command.ts',
  ];
  for (const includeTypes of [false, true]) {
    it(`doctor 命令的 import 闭包(${includeTypes ? '含类型' : '运行时'}):含 hooks-read.ts、不含 hooks-fs.ts 与写侧钩子 / 锁 / 快照写文件`, () => {
      const c = closureOf(['src/commands/doctor.ts'], { includeTypes });
      expect(c.unresolved).toEqual([]);
      expect(c.files.has('src/io/hooks-read.ts')).toBe(true); // 正向前提:检查器不是空跑
      expect([...c.files].filter((f) => WRITE_SIDE.includes(f))).toEqual([]);
    });
  }

  it('对照:偷偷 import hooks-fs 的虚拟 doctor 文件会被闭包检查抓到', () => {
    const p = 'src/doctor/__sim_hooks_fs.ts';
    const c = closureOf([p], {
      virtual: { [p]: "import { HooksFs } from '../io/hooks-fs.js';\nexport const x = HooksFs;\n" },
    });
    expect(c.files.has('src/io/hooks-fs.ts')).toBe(true);
  });

  it('hooks-read.ts 只含读取:没有写类 fs 调用,open 的 flags 只有 O_RDONLY 组合;不含写步骤基础设施的标识', async () => {
    const text = await readText(path.join(ROOT, 'src/io/hooks-read.ts'));
    expect(fsWriteUses('src/io/hooks-read.ts', text)).toEqual([]);
    for (const w of ['writeAudit', 'guardFn', 'targetRenamed', 'createTmpWrite', 'atomicState']) {
      expect(text.includes(w), w).toBe(false);
    }
  });

  it('对照:同一审计能报出 HooksFs(写出口)里的写类调用', async () => {
    const text = await readText(path.join(ROOT, 'src/io/hooks-fs.ts'));
    expect(fsWriteUses('src/io/hooks-fs.ts', text).length).toBeGreaterThan(0);
  });
});
