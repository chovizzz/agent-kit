/**
 * R20-A2 B5d:`signals collect`(非 --dry)接 rsi/lock(契约 §20.9 第 8 条;方案 §7)。
 * 全部用假 HOME(`KIT_REAL_HOME_OVERRIDE`)与临时仓库(`makeSvc`:`.state` 就在 `[rsi] repo` 之下,闸门判 lock);不读任何真实会话根,不碰真实 HOME。
 * 每条负向断言旁边都有正向对照(同世界、条件翻转后确实发生)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createSignalsCollectCommand,
  type SignalsCollectDeps,
} from '../../src/commands/signals-collect.js';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { createIoContext } from '../../src/io/paths.js';
import type { IoContext } from '../../src/io/paths.js';
import { exists, readText } from '../../src/io/read-fs.js';
import { remove, symlink, writeFile } from '../../src/io/safe-fs.js';
import type { BeforeWrite } from '../../src/rsi/l0/types.js';
import { observeRsi } from '../../src/rsi/services/observe.js';
import { inspectSnapshot } from '../../src/rsi/snapshot.js';
import { productionSnapshotValidator } from '../../src/rsi/validators.js';
import { collect } from '../../src/signals/collect.js';
import { createExcludePolicy } from '../../src/signals/exclude.js';
import { projectKeyFor } from '../../src/signals/ids.js';
import { createRedactor } from '../../src/redact/redactor.js';
import { startHolder } from '../commands/rsi-lock-world.js';
import { genClaude } from '../fixtures/sessions/gen-claude.js';
import { ReferenceClaudeReader } from '../fixtures/sessions/reference-reader.js';
import { treeOf } from '../rsi/rsi-fixture.js';
import {
  EXCERPT_MARK,
  SALT,
  ensureRsiDir,
  listFiles,
  makeRoot,
  makeSvc,
  put,
  runDirOf,
  setRsiToml,
  stageRun,
  allText,
} from '../rsi/services-fixture.js';
import type { Svc } from '../rsi/services-fixture.js';

interface CW {
  s: Svc;
  projA: string;
  sessions: string;
  env: Record<string, string>;
  argv: string[];
}

async function world(o: { salt?: boolean; rsi?: boolean } = {}): Promise<CW> {
  const s = await makeSvc('b5d-col-', { salt: o.salt });
  const projA = await makeRoot(s, 'A');
  const sessions = path.join(s.f.dir, 'sessions');
  await genClaude(s.f.fx, {
    root: sessions,
    cwd: projA,
    id: 's1',
    userTexts: ['你好,帮我看看这个'],
    toolCalls: 2,
    failedResults: 1,
    version: '2.1.294',
  });
  if (o.rsi === false) await remove(s.f.fx, s.f.cfgFile); // 没有 [rsi] 配置:闸门判 off
  const env = {
    KIT_TMP: s.f.repo,
    KIT_REAL_HOME_OVERRIDE: s.f.home,
    PATH: '/usr/bin:/bin',
  };
  const argv = [
    '--source',
    sessions,
    '--agent',
    'claude',
    '--timeout-ms',
    '5000',
    '--allow-project',
    projA,
  ];
  s.audit.length = 0;
  return { s, projA, sessions, env, argv };
}

interface Run {
  code: number;
  out: string;
  err: string;
}

async function runIn(
  c: CW,
  over: { argv?: string[]; deps?: Partial<SignalsCollectDeps>; io?: IoContext } = {},
): Promise<Run> {
  let out = '';
  let err = '';
  const cmd = createSignalsCollectCommand({
    readers: { claude: () => new ReferenceClaudeReader() },
    now: () => new Date(c.s.clock.t),
    ...(over.deps ?? {}),
  });
  const code = await cmd.run({
    argv: over.argv ?? c.argv,
    io: over.io ?? c.s.io,
    env: c.env,
    overlayPath: undefined,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  });
  return { code, out, err };
}

const lockPath = (s: Svc): string => path.join(s.rsi, 'lock');
const keyOf = async (c: CW): Promise<string> =>
  projectKeyFor((await readText(path.join(c.s.state, 'salt'))).trim(), c.projA);

describe('signals collect × rsi/lock:接线', () => {
  it('闸门 lock(armed 状态):信号库 / 会话计数 / 索引 / counts / 清单都更新;cursor、state、日志不写;锁已释放;清单自洽', async () => {
    const c = await world();
    const obs = await observeRsi(c.s.io, c.env);
    expect(obs.state.state, '前提:armed(未确认)').toBe('armed');
    const r = await runIn(c);
    expect(r.code, r.err).toBe(ExitCode.OK);
    const key = await keyOf(c);
    const files = await listFiles(c.s.rsi);
    expect(files.sort()).toEqual(['counts.json', 'projects.json', 'snapshot.json']);
    // 拍板 Q-E / Q-L:不写 cursor、不写 state.json、不追加日志行
    expect(await exists(path.join(c.s.rsi, 'cursor.json'))).toBe(false);
    expect(await exists(path.join(c.s.rsi, 'state.json'))).toBe(false);
    expect(await exists(path.join(c.s.rsi, 'log.jsonl'))).toBe(false);
    const index = JSON.parse(await readText(path.join(c.s.rsi, 'projects.json'))) as {
      entries: { key: string; roots: { path: string }[]; signals: number; sessions: number }[];
    };
    expect(index.entries.map((e) => e.key)).toEqual([key]);
    expect(index.entries[0]?.roots[0]?.path).toBe(c.projA); // allow 路径作为项目根原样保留
    expect(index.entries[0]?.signals).toBeGreaterThan(0);
    const counts = JSON.parse(await readText(path.join(c.s.rsi, 'counts.json'))) as {
      per_key: Record<string, { signals_total: number; sessions: number }>;
    };
    expect(counts.per_key[key]?.signals_total).toBe(index.entries[0]?.signals);
    expect(counts.per_key[key]?.sessions).toBe(1);
    expect(await inspectSnapshot(c.s.io, productionSnapshotValidator)).toBe('consistent');
    expect(await exists(lockPath(c.s))).toBe(false);
    // 写审计:除 rsi/ 与 salt / signals / sessions 外没有别的路径(没有 cursor / state / log)
    const stray = c.s.audit.filter(
      (l) =>
        !l.includes(`${path.sep}rsi${path.sep}`) &&
        !l.includes(`${path.sep}signals`) &&
        !l.includes(`${path.sep}sessions`) &&
        !l.endsWith(`${path.sep}.state`) &&
        !l.endsWith(`${path.sep}.state${path.sep}rsi`), // 建目录(幂等)
    );
    expect(stray).toEqual([]);
    expect(c.s.audit.some((l) => l.includes('cursor.json') || l.includes('state.json'))).toBe(
      false,
    );
  });

  it('闸门 off(没有 [rsi] 配置):照常采集,不建 rsi/、不拿锁;正向对照:同世界有配置时会建 rsi/', async () => {
    const off = await world({ rsi: false });
    const r = await runIn(off);
    expect(r.code, r.err).toBe(ExitCode.OK);
    expect(await exists(path.join(off.s.state, 'rsi'))).toBe(false);
    expect(off.s.audit.filter((l) => l.includes(`${path.sep}rsi`))).toEqual([]);
    expect((await listFiles(path.join(off.s.state, 'signals'))).length).toBeGreaterThan(0);
    expect(await exists(path.join(off.s.state, 'salt'))).toBe(true);
    const on = await world();
    expect((await runIn(on)).code).toBe(ExitCode.OK);
    expect(await exists(path.join(on.s.state, 'rsi'))).toBe(true);
  });

  it('--dry:不读 rsi 配置(读就抛)、不拿锁、零写入;盐不落盘', async () => {
    const c = await world({ salt: false });
    const before = await treeOf(c.s.state);
    const r = await runIn(c, {
      argv: [...c.argv, '--dry'],
      deps: {
        rsiConfig: async () => {
          throw new Error('rsiConfig must not be called in --dry');
        },
      },
    });
    expect(r.code, r.err).toBe(ExitCode.OK);
    expect(JSON.parse(r.out)).toMatchObject({ dry: true, salt: 'ephemeral' });
    expect(c.s.audit).toEqual([]);
    expect(await treeOf(c.s.state)).toEqual(before);
    expect(await exists(path.join(c.s.state, 'rsi'))).toBe(false);
  });

  it('--json 形状不变:results 不进输出(lock 与 off 两条路径键集合相同),且 results 本身非空(正向前提)', async () => {
    const on = await world();
    const off = await world({ rsi: false });
    const a = JSON.parse((await runIn(on)).out) as Record<string, unknown>;
    const b = JSON.parse((await runIn(off)).out) as Record<string, unknown>;
    const expected = [
      'deduplicated',
      'dry',
      'excluded_self_sessions',
      'report',
      'salt',
      'samples',
      'session_stats',
      'sessions',
      'written',
    ];
    expect(Object.keys(a).sort()).toEqual(expected);
    expect(Object.keys(b).sort()).toEqual(expected);
    expect(a).not.toHaveProperty('results');
    expect(JSON.stringify(a)).not.toContain('"results"');
    // 正向前提:库入口的 CollectOutput.results 确实有内容(否则上面的「不泄漏」是空断言)
    const lib = await collect({
      reader: new ReferenceClaudeReader(),
      source: on.sessions,
      io: on.s.io,
      dry: true,
      redactor: createRedactor({ timeout_ms: 5000 }),
      policy: await createExcludePolicy({ excludeDirs: [], allowProjects: [on.projA] }),
      salt: SALT,
      fallbackVersion: undefined,
      maxEventBytes: undefined,
    });
    expect(lib.results.length).toBeGreaterThan(0);
    expect(lib.results[0]?.status).toBe('processed');
  });

  it('另一个进程持锁:退 4 SIGNALS_NOT_RUN reason=locked,零写入(盐也不建);正向对照:放锁后同命令成功并建盐', async () => {
    const c = await world({ salt: false });
    await ensureRsiDir(c.s);
    const holder = await startHolder(c.s.state, c.s.f.dir);
    try {
      const before = await treeOf(c.s.state);
      const r = await runIn(c);
      expect(r.code).toBe(ExitCode.NOT_RUN);
      expect(r.err).toBe('SIGNALS_NOT_RUN reason=locked\n');
      expect(r.out).toBe('');
      expect(await treeOf(c.s.state)).toEqual(before);
      expect(await exists(path.join(c.s.state, 'salt'))).toBe(false);
      expect(await exists(path.join(c.s.state, 'signals'))).toBe(false);
    } finally {
      await holder.stop();
    }
    await remove(c.s.f.fx, lockPath(c.s)); // 子进程被 SIGKILL 后留下的锁文件
    const ok = await runIn(c);
    expect(ok.code, ok.err).toBe(ExitCode.OK);
    expect(await exists(path.join(c.s.state, 'salt'))).toBe(true);
  });

  it('盐首建在锁内:写审计里锁文件的 createExclusive 先于 salt 的 createExclusive', async () => {
    const c = await world({ salt: false });
    const r = await runIn(c);
    expect(r.code, r.err).toBe(ExitCode.OK);
    const iLock = c.s.audit.findIndex(
      (l) => l.startsWith('createExclusive ') && l.endsWith(`${path.sep}rsi${path.sep}lock`),
    );
    const iSalt = c.s.audit.findIndex(
      (l) => l.startsWith('createExclusive ') && l.endsWith(`${path.sep}salt`),
    );
    expect(iLock).toBeGreaterThanOrEqual(0);
    expect(iSalt).toBeGreaterThan(iLock);
  });

  it('refuse(平台 / 状态目录无法证明安全):退 3 RSI_FAIL_CLOSED reason=state_dir_unsafe,零写入;正向对照:不 refuse 时成功', async () => {
    const c = await world({ salt: false });
    const r = await runIn(c, { deps: { lockDeps: { gate: { platformSupported: false } } } });
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r.err).toBe('RSI_FAIL_CLOSED reason=state_dir_unsafe\n');
    expect(r.out).toBe('');
    expect(c.s.audit).toEqual([]);
    expect((await runIn(c)).code).toBe(ExitCode.OK);
  });

  it('状态目录来源:io.stateDir 与 [rsi] repo/.state 是两棵独立的树 → 闸门 off,逐字节走旧流程,repo/.state 下没有 rsi/', async () => {
    const c = await world({ salt: false });
    const other = path.join(c.s.f.dir, 'other-state');
    const audit: string[] = [];
    const io = createIoContext({
      cwd: c.s.f.repo,
      root: c.s.f.repo,
      env: { KIT_TMP: c.s.f.dir, KIT_STATE_DIR: other, PATH: '/usr/bin:/bin' },
      writeAudit: (op, p) => void audit.push(`${op} ${p}`),
    });
    const r = await runIn(c, { io });
    expect(r.code, r.err).toBe(ExitCode.OK);
    expect(await exists(path.join(other, 'salt'))).toBe(true);
    expect(await exists(path.join(other, 'rsi'))).toBe(false);
    expect(await exists(path.join(c.s.state, 'rsi'))).toBe(false);
    expect(audit.filter((l) => l.includes(`${path.sep}rsi`))).toEqual([]);
  });
});

describe('signals collect × rsi/lock:错误映射(盐错误保持 REDACT_FAIL_CLOSED)', () => {
  it('锁内盐错误(权限过宽):REDACT_FAIL_CLOSED reason=SIGNALS_SALT_INVALID 退 3,不写任何信号 / 索引;正向对照:盐合规时成功', async () => {
    const c = await world();
    await put(c.s, path.join(c.s.state, 'salt'), SALT, 0o644); // 权限宽于 0600
    const r = await runIn(c);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r.err).toBe('REDACT_FAIL_CLOSED reason=SIGNALS_SALT_INVALID\n');
    expect(await exists(path.join(c.s.state, 'signals'))).toBe(false);
    expect(await exists(path.join(c.s.rsi, 'projects.json'))).toBe(false);
    expect(await exists(lockPath(c.s))).toBe(false);
    await put(c.s, path.join(c.s.state, 'salt'), SALT, 0o600);
    expect((await runIn(c)).code).toBe(ExitCode.OK);
  });

  it('登记的预期变更:锁被占用 + 盐损坏 → 先报 SIGNALS_NOT_RUN reason=locked(盐错误不再先于锁判定)', async () => {
    const c = await world();
    await put(c.s, path.join(c.s.state, 'salt'), SALT, 0o644);
    await ensureRsiDir(c.s);
    const holder = await startHolder(c.s.state, c.s.f.dir);
    try {
      const r = await runIn(c);
      expect(r.code).toBe(ExitCode.NOT_RUN);
      expect(r.err).toBe('SIGNALS_NOT_RUN reason=locked\n');
    } finally {
      await holder.stop();
    }
  });

  it('有 purge journal(含不合规):退 3 purge_incomplete / journal_invalid,信号库未被碰;正向对照:没有 journal 时成功', async () => {
    const c = await world();
    await ensureRsiDir(c.s);
    const journal = path.join(c.s.rsi, 'purge-journal.json');
    const good = JSON.stringify({
      schema_version: 1,
      created_at: '2026-10-26T00:00:00.000Z',
      phase: 'signals_rewritten',
      keys: ['p_aaaaaaaaaaaaaaaa'],
      taint_targets: { runs: [], promotes: [] },
    });
    await put(c.s, journal, good);
    const r1 = await runIn(c);
    expect(r1.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r1.err).toBe('RSI_FAIL_CLOSED reason=purge_incomplete\n');
    await put(c.s, journal, 'not json');
    const r2 = await runIn(c);
    expect(r2.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r2.err).toBe('RSI_FAIL_CLOSED reason=journal_invalid\n');
    expect(await exists(path.join(c.s.state, 'signals'))).toBe(false);
    await remove(c.s.f.fx, journal);
    expect((await runIn(c)).code).toBe(ExitCode.OK);
  });

  it('坏数据在写任何东西之前就抛(锁内第一步 recover 的 inspect):counts 损坏后又来了新会话 → 退 3,信号库 / 会话计数逐字节不变(新会话的信号没写);正向对照:修好后同一命令把新会话写进去', async () => {
    const c = await world();
    expect((await runIn(c)).code).toBe(ExitCode.OK);
    await genClaude(c.s.f.fx, {
      root: c.sessions,
      cwd: c.projA,
      id: 's2',
      userTexts: ['再来一个会话'],
      toolCalls: 1,
      failedResults: 1,
      version: '2.1.294',
    });
    const goodCounts = await readText(path.join(c.s.rsi, 'counts.json'));
    await put(c.s, path.join(c.s.rsi, 'counts.json'), '{"not":"counts"}');
    const before = await treeOf(path.join(c.s.state, 'signals'));
    const beforeSess = await treeOf(path.join(c.s.state, 'sessions'));
    const r = await runIn(c);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r.err).toMatch(/^RSI_FAIL_CLOSED reason=\w+\n$/);
    expect(await treeOf(path.join(c.s.state, 'signals'))).toEqual(before);
    expect(await treeOf(path.join(c.s.state, 'sessions'))).toEqual(beforeSess);
    // 正向对照:恢复 counts 后新会话被写入(信号库变了)
    await put(c.s, path.join(c.s.rsi, 'counts.json'), goodCounts);
    expect((await runIn(c)).code).toBe(ExitCode.OK);
    expect(await treeOf(path.join(c.s.state, 'signals'))).not.toEqual(before);
  });
});

describe('signals collect × rsi:排除(Q-F)与状态(Q-F2)', () => {
  it('Q-F:[rsi] exclude_dirs 命中的项目不被手动 collect 处理(会话计为 excluded,不入库);正向对照:未排除时被处理', async () => {
    const c = await world();
    await setRsiToml(c.s, `exclude_dirs = [${JSON.stringify(c.projA)}]\n`);
    const r = await runIn(c);
    expect(r.code, r.err).toBe(ExitCode.OK);
    const rep = (JSON.parse(r.out) as { report: Record<string, number> }).report;
    expect(rep['sessions_skipped_excluded']).toBe(1);
    expect(rep['sessions_read']).toBe(0);
    expect(await listFiles(path.join(c.s.state, 'signals'))).toEqual([]);
    const idx = JSON.parse(await readText(path.join(c.s.rsi, 'projects.json'))) as {
      entries: unknown[];
    };
    expect(idx.entries).toEqual([]);
    // 正向对照
    await setRsiToml(c.s, '');
    const ok = await runIn(c);
    const rep2 = (JSON.parse(ok.out) as { report: Record<string, number> }).report;
    expect(rep2['sessions_read']).toBe(1);
  });

  it('配置来源(排除项维度):排除用的是拿锁之后复检重读的那份配置——拿锁前未排除、拿锁后才写入排除 → 仍被排除', async () => {
    const c = await world();
    const r = await runIn(c, {
      deps: {
        afterLock: async () => {
          await setRsiToml(c.s, `exclude_dirs = [${JSON.stringify(c.projA)}]\n`);
        },
      },
    });
    expect(r.code, r.err).toBe(ExitCode.OK);
    const rep = (JSON.parse(r.out) as { report: Record<string, number> }).report;
    expect(rep['sessions_skipped_excluded']).toBe(1);
    expect(rep['sessions_read']).toBe(0);
  });

  it('配置不可用(exclude_invalid):无法叠加排除 → 退 3 RSI_FAIL_CLOSED reason=exclude_invalid,零数据写入', async () => {
    const c = await world();
    await setRsiToml(c.s, 'exclude_dirs = ["relative"]\n');
    const r = await runIn(c);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r.err).toBe('RSI_FAIL_CLOSED reason=exclude_invalid\n');
    expect(await exists(path.join(c.s.state, 'signals'))).toBe(false);
  });

  it('Q-F2:stopped(有 STOP)下手动 collect 照常运行;正向前提:状态确实是 stopped', async () => {
    const c = await world();
    await ensureRsiDir(c.s);
    await put(c.s, path.join(c.s.rsi, 'STOP'), '{"at":"2026-10-26T00:00:00.000Z","by":"user"}\n');
    expect((await observeRsi(c.s.io, c.env)).state.state).toBe('stopped');
    const r = await runIn(c);
    expect(r.code, r.err).toBe(ExitCode.OK);
    expect((JSON.parse(r.out) as { written: number }).written).toBeGreaterThan(0);
    expect(await exists(path.join(c.s.rsi, 'STOP'))).toBe(true); // 不动 STOP
  });
});

describe('signals collect × rsi:暂存区有无法处理的条目', () => {
  it('TAINTED run 里有悬空符号链接 → 退 3 RSI_FAIL_CLOSED reason=staging_unsafe_entry(稳定码,不是裸异常),信号库未写;正向对照:去掉链接后成功', async () => {
    const c = await world();
    await stageRun(c.s, 'run-u', ['0123456789abcdef']);
    const dir = runDirOf(c.s, 'run-u');
    await put(c.s, path.join(dir, 'TAINTED'), '{"at":"2026-10-26T00:00:00.000Z","reason":"purge"}');
    const link = path.join(dir, 'proposals', 'evil');
    await symlink(c.s.f.fx, path.join(c.s.f.dir, 'no-such-target'), link);
    const r = await runIn(c);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r.err).toBe('RSI_FAIL_CLOSED reason=staging_unsafe_entry\n');
    expect(await exists(path.join(c.s.state, 'signals'))).toBe(false);
    // 正向对照:同样的 TAINTED run、没有悬空链接 → 成功(链接本身 safe-fs 不允许删,所以另起一个世界)
    const ok = await world();
    await stageRun(ok.s, 'run-u', ['0123456789abcdef']);
    await put(
      ok.s,
      path.join(runDirOf(ok.s, 'run-u'), 'TAINTED'),
      '{"at":"2026-10-26T00:00:00.000Z","reason":"purge"}',
    );
    expect((await runIn(ok)).code).toBe(ExitCode.OK);
  });
});

describe('signals collect × rsi:拿锁之后配置复检变成 off', () => {
  it('退回现有流程(不提交 rsi 投影),但持锁期间的写点仍经 gate:失锁 → lock_lost 之后零写入;不失锁 → 照常采集', async () => {
    const dropCfg = (c: CW) => async (): Promise<void> => {
      await remove(c.s.f.fx, c.s.f.cfgFile);
    };
    const ok = await world();
    const r = await runIn(ok, { deps: { afterLock: dropCfg(ok) } });
    expect(r.code, r.err).toBe(ExitCode.OK);
    expect((await listFiles(path.join(ok.s.state, 'signals'))).length).toBeGreaterThan(0);
    expect(await exists(path.join(ok.s.rsi, 'projects.json'))).toBe(false);
    expect(await exists(path.join(ok.s.rsi, 'counts.json'))).toBe(false);
    for (const k of [1, 2]) {
      const c = await world({ salt: false });
      const inj = injector(c, k, 'lose');
      const res = await runIn(c, { deps: { afterLock: dropCfg(c), beforeWrite: inj.hook } });
      expect(inj.at(), `k=${k}`).toBeDefined();
      expect(res.code, `k=${k}`).toBe(ExitCode.FAIL_CLOSED);
      expect(res.err).toBe('RSI_FAIL_CLOSED reason=lock_lost\n');
      expect(c.s.audit.slice(inj.at()?.audit ?? 0), `k=${k} 失锁之后零写入`).toEqual([]);
    }
  });
});

describe('signals collect × rsi:锁内 recover / taint 续做', () => {
  it('锁内先 resumeTaint:已有 TAINTED 但摘录没清的暂存 run,collect 之后摘录被清空(标记保留);正向前提:之前摘录在', async () => {
    const c = await world();
    await stageRun(c.s, 'run-t', ['0123456789abcdef']);
    const dir = runDirOf(c.s, 'run-t');
    await put(c.s, path.join(dir, 'TAINTED'), '{"at":"2026-10-26T00:00:00.000Z","reason":"purge"}');
    expect(await allText(dir)).toContain(EXCERPT_MARK);
    const r = await runIn(c);
    expect(r.code, r.err).toBe(ExitCode.OK);
    expect(await allText(dir)).not.toContain(EXCERPT_MARK);
    expect(await exists(path.join(dir, 'TAINTED'))).toBe(true);
  });
});

/** 写点故障注入:第 k 个写点之前换掉锁文件的 nonce(失锁)或抛错(崩溃);`k = Infinity` = 只计数 */
function injector(
  c: CW,
  k: number,
  mode: 'lose' | 'crash',
): { hook: BeforeWrite; calls: () => number; at: () => { op: string; audit: number } | undefined } {
  let n = 0;
  let hit: { op: string; audit: number } | undefined;
  return {
    hook: async (op) => {
      n++;
      if (n !== k || hit !== undefined) return;
      hit = { op, audit: c.s.audit.length };
      if (mode === 'crash') throw new Error('injected crash');
      await writeFile(
        c.s.f.fx,
        lockPath(c.s),
        JSON.stringify({
          pid: 1,
          started_at: '2026-10-26T00:00:00.000Z',
          nonce: 'f'.repeat(16),
          kit_version: '0.1.0',
        }),
        { mode: 0o600 },
      );
    },
    calls: () => n,
    at: () => hit,
  };
}

async function runSafe(c: CW, deps: Partial<SignalsCollectDeps>): Promise<Run | 'threw'> {
  try {
    return await runIn(c, { deps });
  } catch {
    return 'threw';
  }
}

describe('signals collect × rsi:每个写点失锁 / 崩溃', () => {
  it('每个写点之前失锁(k 遍历):退 3 lock_lost,该点之后零写入;遍历到的写点数 > 10(正向前提:覆盖盐 / 信号 / 会话 / 索引 / counts / 清单)', async () => {
    const probe = await world({ salt: false });
    const count = injector(probe, Number.POSITIVE_INFINITY, 'lose');
    expect((await runIn(probe, { deps: { beforeWrite: count.hook } })).code).toBe(ExitCode.OK);
    const total = count.calls();
    expect(total).toBeGreaterThan(10);
    const ops = new Set<string>();
    for (let k = 1; k <= total; k++) {
      const c = await world({ salt: false });
      const inj = injector(c, k, 'lose');
      const r = await runSafe(c, { beforeWrite: inj.hook });
      const hit = inj.at();
      expect(hit, `k=${k} 的注入必须触发`).toBeDefined();
      ops.add(hit?.op ?? '');
      expect(r, `k=${k} op=${hit?.op}`).not.toBe('threw');
      const run = r as Run;
      expect(run.code, `k=${k} op=${hit?.op}`).toBe(ExitCode.FAIL_CLOSED);
      expect(run.err, `k=${k} op=${hit?.op}`).toBe('RSI_FAIL_CLOSED reason=lock_lost\n');
      expect(run.out).toBe('');
      expect(c.s.audit.slice(hit?.audit ?? 0), `k=${k} op=${hit?.op} 失锁之后零写入`).toEqual([]);
    }
    expect(ops.has('salt-create')).toBe(true);
    expect([...ops].some((o) => o.startsWith('rename:counts.json'))).toBe(true);
    expect([...ops].some((o) => o.startsWith('rename:projects.json'))).toBe(true);
  });

  it('每个写点崩溃后重跑(k 遍历):收敛到干净运行的同一结果(信号 / 会话 / 索引条目 / counts / 清单),再跑一次字节不变', async () => {
    const canon = async (c: CW): Promise<Record<string, unknown>> => {
      const rd = async (rel: string): Promise<unknown> =>
        JSON.parse(await readText(path.join(c.s.rsi, rel)));
      const idx = (await rd('projects.json')) as { entries: unknown; salt_fp: string };
      const cnt = (await rd('counts.json')) as Record<string, unknown>;
      delete cnt['generation'];
      delete cnt['computed_at'];
      return {
        idx: { entries: idx.entries, salt_fp: idx.salt_fp },
        cnt,
        signals: await treeOf(path.join(c.s.state, 'signals')),
        sessions: await treeOf(path.join(c.s.state, 'sessions')),
        snapshot: await inspectSnapshot(c.s.io, productionSnapshotValidator),
      };
    };
    const wipe = async (c: CW): Promise<void> => {
      for (const rel of await listFiles(c.s.state)) {
        if (rel !== 'salt') await remove(c.s.f.fx, path.join(c.s.state, rel));
      }
    };
    const probe = await world();
    const count = injector(probe, Number.POSITIVE_INFINITY, 'crash');
    expect((await runIn(probe, { deps: { beforeWrite: count.hook } })).code).toBe(ExitCode.OK);
    const total = count.calls();
    expect(total).toBeGreaterThan(8);
    for (let k = 1; k <= total; k++) {
      const c = await world(); // 盐预置:同一个 SALT,session_ref 取决于路径,所以同世界内比较(崩溃 → 重跑 → 清空重跑)
      const inj = injector(c, k, 'crash');
      await runSafe(c, { beforeWrite: inj.hook });
      expect(inj.at(), `k=${k}`).toBeDefined();
      const again = await runIn(c);
      expect(again.code, `k=${k} 重跑:${again.err}`).toBe(ExitCode.OK);
      const afterRerun = await canon(c);
      expect(afterRerun['snapshot'], `k=${k}`).toBe('consistent');
      const sigBefore = await treeOf(path.join(c.s.state, 'signals'));
      expect((await runIn(c)).code).toBe(ExitCode.OK);
      expect(await treeOf(path.join(c.s.state, 'signals')), `k=${k} 幂等`).toEqual(sigBefore);
      await wipe(c);
      expect((await runIn(c)).code).toBe(ExitCode.OK);
      expect(await canon(c), `k=${k} 崩溃重跑 = 干净运行`).toEqual(afterRerun);
    }
  });
});
