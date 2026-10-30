/**
 * R20-A2 B5e:零写入矩阵(契约 §20.8.1;方案 §10.1)。B5 负责的命令 × 状态场景,三层证据**组合**成立,任何单层都不是保证:
 *  ① 进程内写调用审计(外部数组累计,命令内部吞异常也不影响)——恰好为 [] ;
 *  ② 前后目录树比较(假 HOME、KIT_TMP、`[rsi] repo/.state` 全在被比较的夹具目录内;内容 sha256 / 权限位 / 类型);
 *  ③ 子进程 `KIT_WRITE_ROOTS=:`(写入根集合为空,safe-fs 一律拒写)——退出码与进程内一致、没有 write_denied、树不变。
 * 每层都带正向对照:同一机制下故意写一次,判据必须报出(`rsi stop`;「建了又删」只有审计抓得到;空写入根下 stop 退 3 write_denied)。
 * 锁后拒绝(confirm 锁后 STALE、purge --write 锁后 NOT_EXCLUDED)不是严格零写入:只豁免锁基础设施——审计里**恰好**是锁文件的 createExclusive 加 remove
 * (外加对 `.state/`、`.state/rsi/` 的 mkdirp),预置的 `snapshot.json.tmp` 与未完成提交原样保留(抓「复检挪到 recover 之后」)。
 * 「被中断」:子进程在读阶段第一个 beforeStep 里挂起(握手靠它打印的 READY),父进程发 SIGTERM,树前后一致、没有遗留锁文件。
 * 范围声明:poke / hint 的零写入属 A3;status / projects(既有)的零写入见 readonly-zero-write.test.ts,本文件不重复。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../../src/cli.js';
import { createIoContext } from '../../src/io/paths.js';
import { exists, readBytes, readText } from '../../src/io/read-fs.js';
import { remove, writeFile } from '../../src/io/safe-fs.js';
import { runConfirm } from '../../src/rsi/confirm.js';
import { observeRsi } from '../../src/rsi/services/observe.js';
import { withWriteAudit } from '../helpers/write-audit.js';
import { makeTempDir } from '../helpers/tmp.js';
import { cmdFxOf, makeTickFx, overwriteRsi, runCmd, type TickFx } from './b5a-fixture.js';
import { makeSc, purge, sid, type Sc } from './b5c-fixture.js';
import { put as putSession, claudeLine, jl, uuid } from './l0-fixture.js';
import { buildHangChild, buildRoChild, runRoChild, startHang } from './proc/ro-helper.js';
import { baseState, seed, setExtra, validConfirm } from './ro-fixture.js';
import { treeOf, rsiToml, writeCfg } from './rsi-fixture.js';
import { KEY_B, put, setRsiToml, signalObj } from './services-fixture.js';
import { writePurgeJournal } from '../commands/rsi-lock-world.js';

interface At {
  env: Record<string, string>;
  dir: string;
}
interface Ran {
  code: number;
  out: string;
  err: string;
  audit: { op: string; path: string }[];
}

/** 经真实 `main()` 跑一条命令,写审计由外部数组累计 */
async function runAt(
  w: At,
  argv: string[],
  over: { isTty?: boolean; line?: string } = {},
): Promise<Ran> {
  const a = withWriteAudit();
  let out = '';
  let err = '';
  const code = await main(argv, {
    env: w.env,
    cwd: w.dir,
    writeAudit: a.hook,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    ...(over.isTty !== undefined ? { isTty: over.isTty } : {}),
    ...(over.line !== undefined ? { readLine: async () => over.line } : {}),
  });
  return { code, out, err, audit: a.calls };
}

let roScript = '';
let hangScript = '';
async function scripts(): Promise<void> {
  if (roScript !== '') return;
  const { dir } = await makeTempDir('b5e-zw-build-');
  roScript = await buildRoChild(dir);
  hangScript = await buildHangChild(dir);
}

// tick 干跑输出含 duration_ms(墙钟,两次运行必然不同):比较前抹平(JSON 与 key=value 两种写法)
const norm = (t: string): string =>
  t
    .replace(/"duration_ms": \d+/g, '"duration_ms": 0')
    .replace(/^duration_ms=\d+$/gm, 'duration_ms=0');

interface Expect {
  code: number;
  /** stderr 全文;不给 = 只核对退出码 */
  err?: string;
}

/**
 * 一行矩阵:进程内审计 [] + 前后树不变 + 子进程(空写入根)同码、无 write_denied、树不变。
 * `child:false` 的行(需要 afterLock 之类的 deps 缝)只做前两层,理由写在调用处。
 */
async function proveZeroWrite(
  w: At,
  argv: string[],
  want: Expect,
  o: { isTty?: boolean; line?: string; child?: boolean; label?: string } = {},
): Promise<Ran> {
  const label = `${o.label ?? ''} ${argv.join(' ')}`.trim();
  const before = await treeOf(w.dir);
  const r = await runAt(w, argv, { isTty: o.isTty, line: o.line });
  expect(r.code, `${label}: 退出码(stderr=${r.err})`).toBe(want.code);
  if (want.err !== undefined) expect(r.err, `${label}: stderr`).toBe(want.err);
  expect(r.audit, `${label}: ① 写审计`).toEqual([]);
  expect(await treeOf(w.dir), `${label}: ② 目录树`).toEqual(before);
  if (o.child !== false) {
    await scripts();
    const child = runRoChild(roScript, {
      argv,
      env: { ...w.env, PATH: '/usr/bin:/bin', KIT_WRITE_ROOTS: ':' },
      cwd: w.dir,
      ...(o.isTty !== undefined ? { isTty: o.isTty } : {}),
      ...(o.line !== undefined ? { line: o.line } : {}),
    });
    expect(child.code, `${label}: ③ 子进程退出码`).toBe(r.code);
    expect(norm(child.out), `${label}: ③ 子进程 stdout`).toBe(norm(r.out));
    expect(child.err, `${label}: ③ 子进程 stderr`).toBe(r.err);
    expect(child.err).not.toContain('write_denied');
    expect(await treeOf(w.dir), `${label}: ③ 子进程之后目录树`).toEqual(before);
  }
  return r;
}

// ---------------------------------------------------------------------------
// 世界构造
// ---------------------------------------------------------------------------
type World =
  | 'off'
  | 'armed_first'
  | 'armed_invalidated'
  | 'confirmed'
  | 'stopped'
  | 'busy'
  | 'salt_invalid'
  | 'salted_armed';

const STOP_DOC = '{"at":"2026-10-26T00:00:00.000Z","by":"user"}';
const SALT = 'ab'.repeat(32);

async function world(kind: World): Promise<TickFx> {
  const confirmed = kind === 'confirmed' || kind === 'stopped' || kind === 'busy';
  const f = await makeTickFx(`zw-${kind}-`, {
    confirmed: confirmed || kind === 'salt_invalid',
    ...(kind === 'off' ? { noSeed: true } : {}),
  });
  switch (kind) {
    case 'off':
      await writeCfg(f, '[rsi]\nenabled = false\n');
      break;
    case 'armed_invalidated': {
      // 确认时排除了 proj1,之后去掉这条排除(放宽)→ 旧确认记录失效 → 回到 armed(记录还在,不是首次)。收紧排除 / 减少 agent 不使确认失效(R20-1.5)
      await setExtra(f, `exclude_dirs = [${JSON.stringify(path.join(f.dir, 'work', 'proj1'))}]\n`);
      await seed(f, {
        state: baseState({ confirm: { ...(await validConfirm(f)), baseline_pending: true } }),
      });
      await setExtra(f, '');
      break;
    }
    case 'stopped':
      await writeFile(f.io, path.join(f.rsiDir, 'STOP'), STOP_DOC, { mode: 0o600 });
      break;
    case 'busy':
      // 清单与文件不一致(写入方正在提交):读快照两次都对不上 → busy
      await overwriteRsi(f, 'state.json', {
        ...(baseState() as object),
        projects_ack_generation: 9,
      });
      break;
    case 'salt_invalid':
      await writeFile(f.io, path.join(f.io.stateDir, 'salt'), 'not-a-salt', { mode: 0o600 });
      break;
    case 'salted_armed':
      await writeFile(f.io, path.join(f.io.stateDir, 'salt'), SALT, { mode: 0o600 });
      break;
    default:
      break;
  }
  return f;
}

/** 世界的状态前提(不是靠名字,而是读回来):防止「场景其实没造出来」 */
async function stateOf(f: TickFx): Promise<string> {
  const o = await observeRsi(f.io, f.env);
  return `${o.state.state}${o.state.stateInvalid ? '+invalid' : ''}${
    o.doc.kind === 'ok' && o.doc.state.confirm !== null ? '+confirm' : ''
  }`;
}

const TICK_ROWS: [World, string | null, Expect][] = [
  ['off', 'off', { code: 4, err: 'RSI_NOT_RUN reason=off\n' }],
  ['armed_first', 'armed', { code: 0 }],
  ['armed_invalidated', 'armed+confirm', { code: 0 }],
  ['confirmed', 'confirmed+confirm', { code: 0 }],
  ['stopped', 'stopped+confirm', { code: 4, err: 'RSI_NOT_RUN reason=stopped\n' }],
  ['busy', null, { code: 4, err: 'RSI_SNAPSHOT_BUSY\n' }],
  ['salt_invalid', 'confirmed+confirm', { code: 3, err: 'RSI_FAIL_CLOSED reason=salt_invalid\n' }],
];

describe('§10.1 rsi tick(无 --write):七种状态,三层零写入', () => {
  for (const [kind, st, want] of TICK_ROWS) {
    it(`${kind}:退 ${want.code};写审计 [] + 树不变 + 子进程空写入根同码`, async () => {
      const f = await world(kind);
      if (st !== null) expect(await stateOf(f), '前提:状态').toBe(st);
      await proveZeroWrite(f, ['rsi', 'tick'], want, { label: kind });
      await proveZeroWrite(f, ['rsi', 'tick', '--json'], want, { label: kind });
    });
  }
});

const REBUILD_ROWS: [World, Expect][] = [
  ['off', { code: 4, err: 'RSI_NOT_RUN reason=off\n' }],
  ['armed_first', { code: 4, err: 'RSI_NOT_RUN reason=not_confirmed\n' }], // 无盐
  ['salted_armed', { code: 0 }],
  ['confirmed', { code: 4, err: 'RSI_NOT_RUN reason=not_confirmed\n' }], // 无盐
  ['busy', { code: 4, err: 'RSI_NOT_RUN reason=not_confirmed\n' }], // 先于快照判盐
  ['salt_invalid', { code: 3, err: 'RSI_FAIL_CLOSED reason=salt_invalid\n' }],
];

describe('§10.1 rsi projects --rebuild-index(干跑):含无盐', () => {
  for (const [kind, want] of REBUILD_ROWS) {
    it(`${kind}:退 ${want.code};三层零写入`, async () => {
      const f = await world(kind);
      await proveZeroWrite(f, ['rsi', 'projects', '--rebuild-index'], want, { label: kind });
      await proveZeroWrite(f, ['rsi', 'projects', '--rebuild-index', '--json'], want, {
        label: kind,
      });
    });
  }

  it('正向前提:有盐 + 有会话时干跑确实列出了条目(零写入不是因为什么都没发生)', async () => {
    const f = await world('salted_armed');
    const r = await runAt(f, ['rsi', 'projects', '--rebuild-index', '--json']);
    expect(r.code, r.err).toBe(0);
    expect((JSON.parse(r.out) as { entries: number }).entries).toBeGreaterThan(0);
  });
});

describe('§10.1 rsi purge(无 --write,含 --resume)', () => {
  async function sc(prefix: string): Promise<Sc> {
    return makeSc(prefix, { state: 'confirmed' });
  }
  const at = (s: Sc): At => ({ env: cmdFxOf(s.s).env, dir: s.s.f.dir });

  it('--excluded(有已排除项目):退 0,报告有计数(正向前提);三层零写入', async () => {
    const s = await sc('zw-pg-ex-');
    const r = await proveZeroWrite(at(s), ['rsi', 'purge', '--excluded', '--json'], { code: 0 });
    expect(JSON.parse(r.out)).toMatchObject({ mode: 'dry', done: false });
    expect((JSON.parse(r.out) as { keys: number }).keys).toBeGreaterThan(0);
  });

  it('NOT_EXCLUDED:--project 指向未排除的项目 → 1;对照:指向已排除的项目 → 0', async () => {
    const s = await sc('zw-pg-nx-');
    await proveZeroWrite(at(s), ['rsi', 'purge', '--project', s.roots.ok], {
      code: 1,
      err: 'RSI_PURGE_NOT_EXCLUDED\n',
    });
    await proveZeroWrite(at(s), ['rsi', 'purge', '--project', s.roots.ex], { code: 0 });
  });

  it('K 空(没有任何已排除项目):退 0,全 0 计数', async () => {
    const s = await sc('zw-pg-k0-');
    await setRsiToml(s.s, ''); // 去掉排除项
    const r = await proveZeroWrite(at(s), ['rsi', 'purge', '--excluded', '--json'], { code: 0 });
    expect((JSON.parse(r.out) as { keys: number }).keys).toBe(0);
  });

  it('journal 在场:--resume 干跑报告阶段(退 0);新 purge 遇 journal → 3 purge_incomplete', async () => {
    const s = await sc('zw-pg-jr-');
    await writePurgeJournal(s.s.io, s.s.state);
    const r = await proveZeroWrite(at(s), ['rsi', 'purge', '--resume', '--json'], { code: 0 });
    expect((JSON.parse(r.out) as { phase: string }).phase).toBe('signals_rewritten');
    await proveZeroWrite(at(s), ['rsi', 'purge', '--excluded'], {
      code: 3,
      err: 'RSI_FAIL_CLOSED reason=purge_incomplete\n',
    });
  });

  it('journal invalid:--resume 干跑报告 phase=invalid(不触碰任何东西);新 purge → 3 purge_incomplete', async () => {
    const s = await sc('zw-pg-inv-');
    await writePurgeJournal(s.s.io, s.s.state, 'not json at all');
    const r = await proveZeroWrite(at(s), ['rsi', 'purge', '--resume', '--json'], { code: 0 });
    expect((JSON.parse(r.out) as { phase: string }).phase).toBe('invalid');
    await proveZeroWrite(at(s), ['rsi', 'purge', '--excluded'], {
      code: 3,
      err: 'RSI_FAIL_CLOSED reason=purge_incomplete\n',
    });
  });
});

describe('§10.1 rsi confirm:DECLINED、锁前 STALE、非 TTY', () => {
  const at = (f: TickFx): At => ({ env: f.env, dir: f.dir });

  it('DECLINED(输入 no):1,三层零写入(含子进程模拟 TTY + 输入 no);EOF 同样算拒绝', async () => {
    const f = await world('armed_first');
    await proveZeroWrite(
      at(f),
      ['rsi', 'confirm'],
      { code: 1, err: 'RSI_CONFIRM_DECLINED\n' },
      { isTty: true, line: 'no' },
    );
    // 对照:同一夹具输入 yes → 会写(状态变成 confirmed),证明上面的零写入来自拒绝而不是命令什么都不会写
    const g = await world('armed_first');
    const ok = await runAt(at(g), ['rsi', 'confirm'], { isTty: true, line: 'yes' });
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out.endsWith('confirm ok\n')).toBe(true);
    expect(ok.audit.length).toBeGreaterThan(0);
  });

  it('非 TTY:2 not_tty(先于任何读),三层零写入', async () => {
    const f = await world('armed_first');
    await proveZeroWrite(at(f), ['rsi', 'confirm'], {
      code: 2,
      err: 'RSI_USAGE reason=not_tty\n',
    });
  });

  it('锁前 STALE(等待输入期间改配置):1 RSI_CONFIRM_STALE,写审计为 0(不拿锁);对照:不改配置 → 成功', async () => {
    const f = await world('armed_first');
    const a0 = f.audit.length;
    const r = await runCmd(
      f,
      runConfirm,
      [],
      {},
      {
        isTty: true,
        readLine: async () => {
          await writeCfg(f, rsiToml(f, 'agents = ["claude"]\n')); // 展示之后、输入返回之前
          return 'yes';
        },
      },
    );
    expect([r.code, r.err]).toEqual([1, 'RSI_CONFIRM_STALE\n']);
    expect(f.audit.slice(a0), '锁前 STALE:零写调用').toEqual([]);
    expect(await exists(path.join(f.rsiDir, 'lock'))).toBe(false);
    expect(await exists(path.join(f.rsiDir, 'STOP'))).toBe(false);
  });
});

describe('§10.1 锁后拒绝:审计恰好是锁文件的 createExclusive + remove', () => {
  /** 审计里除对 `.state/`、`.state/rsi/` 的 mkdirp 之外,必须恰好是锁文件的建与删 */
  function onlyLock(audit: { op: string; path: string }[], stateDir: string): void {
    const mk = audit.filter((c) => c.op === 'mkdirp').map((c) => c.path);
    for (const p of mk) expect([stateDir, path.join(stateDir, 'rsi')], `mkdirp ${p}`).toContain(p);
    const rest = audit.filter((c) => c.op !== 'mkdirp');
    expect(rest.map((c) => c.op)).toEqual(['createExclusive', 'remove']);
    expect(rest.every((c) => c.path === path.join(stateDir, 'rsi', 'lock'))).toBe(true);
  }

  it('confirm 锁后 STALE + 未完成的提交 + 预置 snapshot.json.tmp:退 1;.tmp 与清单字节不变;对照:不被拒绝时 recover 会处理(.tmp 被删)', async () => {
    const run = async (stale: boolean): Promise<{ f: TickFx; code: number; err: string }> => {
      const f = await world('armed_first');
      const manifest = path.join(f.rsiDir, 'snapshot.json');
      const r = await runCmd(
        f,
        runConfirm,
        [],
        {
          afterLock: async () => {
            await overwriteRsi(f, 'state.json', {
              ...(baseState() as object),
              projects_ack_generation: 9,
            }); // 未完成的提交:state.json 合法但与清单不一致
            await writeFile(f.io, `${manifest}.tmp`, 'junk', { mode: 0o600 });
            if (stale) await writeCfg(f, rsiToml(f, 'agents = ["claude"]\n'));
          },
        },
        { isTty: true, readLine: async () => 'yes' },
      );
      return { f, code: r.code, err: r.err };
    };
    const a = await run(true);
    expect([a.code, a.err]).toEqual([1, 'RSI_CONFIRM_STALE\n']);
    onlyLock(a.f.audit, a.f.io.stateDir);
    expect(await readText(path.join(a.f.rsiDir, 'snapshot.json.tmp'))).toBe('junk');
    const manifestBytes = await readBytes(path.join(a.f.rsiDir, 'snapshot.json'));
    expect(manifestBytes.length).toBeGreaterThan(0);
    const b = await run(false);
    expect(b.code, b.err).toBe(0);
    expect(await exists(path.join(b.f.rsiDir, 'snapshot.json.tmp'))).toBe(false); // recover 清了它
    expect(b.f.audit.filter((c) => c.op !== 'mkdirp').length).toBeGreaterThan(2);
  });

  it('purge --write 锁后 NOT_EXCLUDED + 预置 snapshot.json.tmp 与未完成提交:退 1;审计恰好是锁文件;.tmp 保留', async () => {
    const s = await makeSc('zw-pw-nx-', { state: 'confirmed' });
    await put(s.s, path.join(s.s.rsi, 'snapshot.json.tmp'), 'leftover');
    // 未完成提交:信号库多了一行而清单没跟上
    const sigFile = path.join(s.s.state, 'signals', 'claude', '202610.jsonl');
    await put(
      s.s,
      sigFile,
      (await readText(sigFile)) + `${JSON.stringify(signalObj(sid(8), KEY_B))}\n`,
    );
    const manifestBefore = await readBytes(path.join(s.s.rsi, 'snapshot.json'));
    const r = await purge(s, ['--project', s.roots.ex, '--write'], {
      afterLock: () => setRsiToml(s.s, ''), // 去掉排除项:ex 现在不是 X
    });
    expect([r.code, r.err]).toEqual([1, 'RSI_PURGE_NOT_EXCLUDED\n']);
    onlyLock(s.cf.audit, s.s.state);
    expect(await readText(path.join(s.s.rsi, 'snapshot.json.tmp'))).toBe('leftover');
    expect(await readBytes(path.join(s.s.rsi, 'snapshot.json'))).toEqual(manifestBefore);
    // 对照:同样的预置、不去掉排除项 → 会真的写(不止锁文件)
    const t = await makeSc('zw-pw-ok-', { state: 'confirmed' });
    const ok = await purge(t, ['--project', t.roots.ex, '--write']);
    expect(ok.code, ok.err).toBe(0);
    expect(t.cf.audit.filter((c) => c.op !== 'mkdirp').length).toBeGreaterThan(2);
  });
});

describe('「被中断」:读阶段挂起 + SIGTERM', () => {
  it('tick 干跑(首次 armed):停在头部读取后发 SIGTERM → 进程被信号终止,目录树前后一致,没有遗留锁文件', async () => {
    await scripts();
    const f = await world('armed_first');
    const before = await treeOf(f.dir);
    const h = await startHang(hangScript, {
      kind: 'tick',
      argv: [],
      env: { ...f.env, KIT_WRITE_ROOTS: ':' },
      cwd: f.dir,
    });
    expect(h.child.pid, '前提:子进程已到达读阶段的 beforeStep(READY 握手)').toBeDefined();
    expect(h.child.exitCode, '前提:READY 之后子进程仍活着(保活,不是自己退出)').toBeNull();
    expect(h.child.kill('SIGTERM')).toBe(true);
    const ex = await h.exited;
    expect(ex.signal).toBe('SIGTERM');
    expect(ex.code).toBeNull();
    expect((await h.lines).some((l) => l.startsWith('DONE'))).toBe(false);
    expect(await treeOf(f.dir)).toEqual(before);
    expect(await exists(path.join(f.rsiDir, 'lock'))).toBe(false);
  });

  it('projects --rebuild-index 干跑(有盐):同样的中断 → 树不变', async () => {
    await scripts();
    const f = await world('salted_armed');
    const before = await treeOf(f.dir);
    const h = await startHang(hangScript, {
      kind: 'rebuild',
      argv: ['--rebuild-index'],
      env: { ...f.env, KIT_WRITE_ROOTS: ':' },
      cwd: f.dir,
    });
    expect(h.child.exitCode, '前提:READY 之后子进程仍活着').toBeNull();
    expect(h.child.kill('SIGTERM')).toBe(true);
    expect((await h.exited).signal).toBe('SIGTERM');
    expect(await treeOf(f.dir)).toEqual(before);
    expect(await exists(path.join(f.rsiDir, 'lock'))).toBe(false);
  });

  it('对照:同一世界里 tick --write 会改变目录树(中断判据不是对只读世界恒成立)', async () => {
    const f = await world('armed_first');
    const before = await treeOf(f.dir);
    const r = await runAt(f, ['rsi', 'tick', '--write']);
    expect(r.code, r.err).toBe(0);
    expect(await treeOf(f.dir)).not.toEqual(before);
  });
});

describe('正向对照:三层判据确实报得出', () => {
  it('① rsi stop 在同一审计钩子下记到 createExclusive;② 树变化;③ 空写入根下退 3 write_denied,默认写入根下成功', async () => {
    const f = await world('armed_first');
    const before = await treeOf(f.dir);
    await scripts();
    const denied = runRoChild(roScript, {
      argv: ['rsi', 'stop'],
      env: { ...f.env, PATH: '/usr/bin:/bin', KIT_WRITE_ROOTS: ':' },
      cwd: f.dir,
    });
    expect(denied.code).toBe(3);
    expect(denied.err).toBe('RSI_FAIL_CLOSED reason=write_denied\n');
    expect(await treeOf(f.dir)).toEqual(before);
    const r = await runAt(f, ['rsi', 'stop']);
    expect(r.code).toBe(0);
    expect(r.audit.some((a) => a.op === 'createExclusive' && a.path.endsWith('/rsi/STOP'))).toBe(
      true,
    );
    expect(await treeOf(f.dir)).not.toEqual(before);
  });

  it('「建了又删」:前后树一致但写审计非空——所以审计层不能省(树比较抓不到)', async () => {
    const f = await world('armed_first');
    const a = withWriteAudit();
    const io = createIoContext({
      cwd: f.dir,
      root: f.repo,
      env: f.env,
      writeAudit: a.hook,
    });
    const before = await treeOf(f.dir);
    const p = path.join(io.stateDir, 'rsi', 'ghost');
    await writeFile(io, p, 'x');
    await remove(io, p);
    expect(await treeOf(f.dir)).toEqual(before);
    expect(a.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('树比较自己报得出:往世界里写一个文件后 treeOf 不再相等', async () => {
    const f = await world('armed_first');
    const before = await treeOf(f.dir);
    await putSession(
      f,
      'claude',
      `p/${uuid(99)}.jsonl`,
      jl(claudeLine(path.join(f.dir, 'work', 'proj1'), { timestamp: '2026-10-09T00:00:00.000Z' })),
    );
    expect(await treeOf(f.dir)).not.toEqual(before);
  });
});

describe('B5 --write 的写入范围(订正登记):审计只落在 .state/{rsi,signals,sessions,salt} 与 taint 改写的暂存目录', () => {
  it('tick --write(confirmed,有会话):所有写审计路径都在 allowlist 内;正向前提:确实写了信号库', async () => {
    const f = await world('confirmed');
    await writeFile(f.io, path.join(f.io.stateDir, 'salt'), SALT, { mode: 0o600 });
    const r = await runAt(f, ['rsi', 'tick', '--write']);
    expect(r.code, r.err).toBe(0);
    const state = f.io.stateDir;
    const allowed = ['rsi', 'signals', 'sessions', 'salt', 'reflect', 'promote'].map((n) =>
      path.join(state, n),
    );
    const outside = r.audit.filter(
      (c) =>
        c.path !== state &&
        !allowed.some((a) => c.path === a || c.path.startsWith(`${a}${path.sep}`)),
    );
    expect(outside).toEqual([]);
    expect(r.audit.some((c) => c.path.includes(`${path.sep}signals${path.sep}`))).toBe(true);
    // 对照:本命令的 reflect / promote 目录这里没有暂存,所以没有任何落在其内的写(taint 才会写它们,见 b5a/b5b/b5c 的 taint 用例)
    expect(r.audit.some((c) => c.path.includes(`${path.sep}reflect${path.sep}`))).toBe(false);
  });
});
