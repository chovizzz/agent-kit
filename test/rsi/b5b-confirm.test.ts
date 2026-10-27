/**
 * R20-A2 B5b:`rsi confirm`(R20-3.6)。覆盖方案 §11 中归 B5b 的行:R20-5.1 拿锁、D2 / 锁内顺序、R20-3.6.1 TTY、R20-3.6.3 STALE / DECLINED、confirm 写入顺序、
 * §0.5 R2 判据分工、§0.5 R11 STOP 指纹(含内容)、失锁 k 遍历、崩溃矩阵、R20-4.7 taint 时机、§2.1 配置来源两个维度。
 * 全部在假 HOME / KIT_TMP 内;写审计由外部数组累计;不读真实会话根。子进程层(KIT_WRITE_ROOTS=:)见 b5b-confirm-proc.test.ts,lstat 故障注入见 b5b-confirm-stopfail.test.ts。
 */
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { main } from '../../src/cli.js';
import { exists, readBytes, readText } from '../../src/io/read-fs.js';
import { chmod, hardlink, mkdirp, rename, symlink, writeFile } from '../../src/io/safe-fs.js';
import { projectKeyFor } from '../../src/signals/ids.js';
import { listArmed } from '../../src/rsi/l0/armed-listing.js';
import { runConfirm, type RsiConfirmDeps } from '../../src/rsi/confirm.js';
import { runProjects } from '../../src/rsi/projects.js';
import { runStop } from '../../src/rsi/stop.js';
import { runTick } from '../../src/rsi/tick.js';
import { displayFingerprint, observeRsi } from '../../src/rsi/services/observe.js';
import { piDirIsSet } from '../../src/rsi/services/open.js';
import { inspectSnapshot } from '../../src/rsi/snapshot.js';
import { productionSnapshotValidator } from '../../src/rsi/validators.js';
import { treeOf, rsiToml, writeCfg } from './rsi-fixture.js';
import { baseState, setExtra, validConfirm } from './ro-fixture.js';
import {
  SALT,
  addSignals,
  makeSvc,
  setRsiToml,
  writeIndex,
  stageRun,
  type Svc,
} from './services-fixture.js';
import { claudeLine, jl, put as putSession, uuid } from './l0-fixture.js';
import {
  cmdFxOf,
  foreignLock,
  loseLockOf,
  makeTickFx,
  overwriteRsi,
  rsiJson,
  runCmd,
  type TickFx,
} from './b5a-fixture.js';

const NOW_D = (): Date => new Date('2026-10-27T01:02:03.000Z');
const NEW_AT = '2026-10-27T01:02:03.000Z';
const OLD_AT = '2026-10-24T08:00:00.000Z'; // ro-fixture.NOW:夹具里旧的有效确认记录
const STOP_DOC = '{"at":"2026-10-26T00:00:00.000Z","by":"user"}';
const STOP_DOC_B = '{"at":"2026-10-26T23:59:59.000Z","by":"user"}'; // 与 STOP_DOC 同长

type Line = string | undefined;
type Say = Awaited<ReturnType<typeof say>>;

/** 跑 confirm:isTty 缺省为真;`line` 是 readLine 的返回(可为异步回调,用来在「等待输入期间」做事);`reads` = readLine 被调用的次数 */
async function say(
  f: Pick<TickFx, 'env' | 'dir' | 'audit'>,
  line: Line | (() => Promise<Line>) = 'yes',
  deps: RsiConfirmDeps = {},
  over: { tty?: boolean; argv?: string[] } = {},
) {
  let reads = 0;
  const r = await runCmd(
    f,
    runConfirm,
    over.argv ?? [],
    { now: NOW_D, ...deps },
    {
      isTty: over.tty ?? true,
      readLine: async () => {
        reads++;
        return typeof line === 'function' ? line() : line;
      },
    },
  );
  return { ...r, reads };
}

const stopPath = (f: TickFx): string => path.join(f.rsiDir, 'STOP');
const putStop = async (f: TickFx, body = STOP_DOC): Promise<void> => {
  await writeFile(f.io, stopPath(f), body, { mode: 0o600 });
  await chmod(f.io, stopPath(f), 0o600);
};
/** 把现有 STOP 改名保留(占住旧 inode)再用新内容新建一个:身份必然不同 */
const replaceStop = async (f: TickFx, body: string): Promise<void> => {
  await rename(f.fx, stopPath(f), `${stopPath(f)}.old`);
  await putStop(f, body);
};
const stateOf = async (f: TickFx): Promise<Record<string, unknown>> =>
  (await rsiJson(f, 'state.json')) as Record<string, unknown>;
const confirmOf = async (f: TickFx): Promise<Record<string, unknown> | null> =>
  (await stateOf(f))['confirm'] as Record<string, unknown> | null;
const consistent = async (f: TickFx): Promise<boolean> =>
  (await inspectSnapshot(f.io, productionSnapshotValidator)) === 'consistent';
const stateName = async (f: TickFx): Promise<string> => (await observeRsi(f.io, f.env)).state.state;
const own = (f: TickFx): { env: Record<string, string>; dir: string; audit: [] } => ({
  env: f.env,
  dir: f.dir,
  audit: [],
});
const projPath = (f: TickFx, n: number): string => path.join(f.dir, 'work', `proj${n}`);

/** 首次 armed(无确认记录) */
const mkArmed = (prefix: string, projects = 2): Promise<TickFx> => makeTickFx(prefix, { projects });

const BREAKER = { kind: 'safety', opened_at: '2026-10-25T00:00:00.000Z', until: null };
const LAST_TICK = {
  completed_at: '2026-10-25T00:00:00.000Z',
  trigger: 'tick',
  outcome: 'io_error',
  code: 'io_error',
  duration_ms: 5,
  files_read: 1,
  bytes_read: 2,
};
const ATTEMPT = { started_at: '2026-10-25T00:00:00.000Z', nonce: '0123456789abcdef' };

/** stopped + 旧的有效确认记录(confirmed_at 与新记录不同)+ 熔断 / 失败计数 / armed_listing / last_tick / attempt / ack 基线,用来检验「清什么、留什么」,并让「先删 STOP」这个变异真的变红 */
async function mkStopped(prefix: string): Promise<TickFx> {
  const f = await makeTickFx(prefix, {
    confirmed: true,
    state: {
      breaker: BREAKER,
      consecutive_failures: 3,
      projects_ack_generation: 4,
      last_tick: LAST_TICK,
      attempt: ATTEMPT,
      armed_listing: {
        at: '2026-10-25T00:00:00.000Z',
        policy_fp: 'a'.repeat(64),
        agents: ['claude'],
        projects: 1,
        excluded: 0,
        unknown_sessions: 0,
      },
    },
  });
  await putStop(f);
  return f;
}

/** 零写入断言:外部写审计为空 + 前后目录树不变(`before` 在副作用之后取,避免把测试自己的造数据算进去) */
async function zeroWrites<T>(f: TickFx, body: () => Promise<T>): Promise<T> {
  const a0 = f.audit.length;
  const before = await treeOf(f.dir);
  const r = await body();
  expect(f.audit.slice(a0), '写审计').toEqual([]);
  expect(await treeOf(f.dir), '目录树').toEqual(before);
  return r;
}

describe('R20-3.6.1 前置:参数 / TTY / off / 状态(全部零写入,不调 readLine)', () => {
  it('未知参数 → 2 unknown_arg;非 TTY → 2 not_tty(先于任何读:状态不合规时也是 2,不是 3)', async () => {
    const f = await mkArmed('cf-tty-');
    await zeroWrites(f, async () => {
      const a = await say(f, 'yes', {}, { argv: ['--x'] });
      expect([a.code, a.err, a.out, a.reads]).toEqual([2, 'RSI_USAGE reason=unknown_arg\n', '', 0]);
      const b = await say(f, 'yes', {}, { tty: false });
      expect([b.code, b.err, b.out, b.reads]).toEqual([2, 'RSI_USAGE reason=not_tty\n', '', 0]);
    });
    await overwriteRsi(f, 'state.json', '{"nope":1}');
    await zeroWrites(f, async () => {
      const c = await say(f, 'yes', {}, { tty: false });
      expect([c.code, c.err, c.reads]).toEqual([2, 'RSI_USAGE reason=not_tty\n', 0]);
    });
  });

  it('配置 off → 4 off,不建任何目录', async () => {
    const f = await mkArmed('cf-off-');
    await writeCfg(f, '[rsi]\nenabled = false\n');
    await zeroWrites(f, async () => {
      const r = await say(f);
      expect([r.code, r.err, r.out, r.reads]).toEqual([4, 'RSI_NOT_RUN reason=off\n', '', 0]);
    });
  });

  it('state.json 整份不合规 → 3 state_invalid;已是 confirmed → 0 `confirm already`(不展示、不读输入)', async () => {
    const f = await mkArmed('cf-stinv-');
    await overwriteRsi(f, 'state.json', '{"nope":1}');
    await zeroWrites(f, async () => {
      const r = await say(f);
      expect([r.code, r.err, r.out, r.reads]).toEqual([
        3,
        'RSI_FAIL_CLOSED reason=state_invalid\n',
        '',
        0,
      ]);
    });
    const g = await makeTickFx('cf-already-', { confirmed: true });
    await zeroWrites(g, async () => {
      const r = await say(g);
      expect([r.code, r.out, r.err, r.reads]).toEqual([0, 'confirm already\n', '', 0]);
    });
  });

  it('Q-H 停止采集(collect_blocked)→ 3 RSI_FAIL_CLOSED reason=<block>:exclude_invalid / overlay_invalid,armed 与 stopped 下都一样', async () => {
    for (const [extra, reason] of [
      ['exclude_dirs = ["relative"]\n', 'exclude_invalid'],
      [`overlay = "${path.join('/nonexistent-b5b', 'overlay.toml')}"\n`, 'overlay_invalid'],
    ] as const) {
      for (const stopped of [false, true]) {
        const f = await mkArmed(`cf-block-${reason.slice(0, 3)}-${stopped}-`);
        if (stopped) await putStop(f);
        await setExtra(f, extra);
        await zeroWrites(f, async () => {
          const r = await say(f);
          expect([r.code, r.err, r.out, r.reads], `${reason} ${stopped}`).toEqual([
            3,
            `RSI_FAIL_CLOSED reason=${reason}\n`,
            '',
            0,
          ]);
        });
      }
    }
  });

  it('STOP 无法确认身份(过大 / 符号链接 / 目录)→ 3 state_dir_unsafe,零写入(假身份不能当作「没变」)', async () => {
    const mk = async (kind: 'big' | 'link' | 'dir'): Promise<TickFx> => {
      const f = await mkArmed(`cf-stopbad-${kind}-`);
      if (kind === 'big') await putStop(f, 'x'.repeat(5000));
      if (kind === 'link') await symlink(f.fx, path.join(f.dir, 'nowhere'), stopPath(f));
      if (kind === 'dir') await mkdirp(f.io, stopPath(f), 0o700);
      return f;
    };
    for (const kind of ['big', 'link', 'dir'] as const) {
      const f = await mk(kind);
      await zeroWrites(f, async () => {
        const r = await say(f);
        expect([r.code, r.err, r.out, r.reads], kind).toEqual([
          3,
          'RSI_FAIL_CLOSED reason=state_dir_unsafe\n',
          '',
          0,
        ]);
      });
    }
  });
});

describe('R20-3.6.3 DECLINED:输入必须精确等于 yes,否则零写入', () => {
  for (const [name, line] of [
    ['no', 'no'],
    ['YES', 'YES'],
    ['前导空格', ' yes'],
    ['尾随空格', 'yes '],
    ['y', 'y'],
    ['空行', ''],
    ['EOF', () => Promise.resolve(undefined)],
  ] as const) {
    it(`${name} → 1 RSI_CONFIRM_DECLINED;清单已展示(正向前提),readLine 恰好调用一次,零写入`, async () => {
      const f = await mkArmed(`cf-decl-${name.length}-${name.charCodeAt(0)}-`);
      await zeroWrites(f, async () => {
        const r = await say(f, line);
        expect([r.code, r.err, r.reads]).toEqual([1, 'RSI_CONFIRM_DECLINED\n', 1]);
        expect(r.out).toContain('status=pending');
      });
      expect(await confirmOf(f)).toBeNull();
    });
  }

  it('`yes\\r`(只去行尾 \\r)被接受', async () => {
    const f = await mkArmed('cf-cr-');
    const r = await say(f, 'yes\r');
    expect([r.code, r.err]).toEqual([0, '']);
    expect(r.out.endsWith('confirm ok\n')).toBe(true);
  });
});

describe('R20-3.6.2 展示:与 rsi projects 首次 armed 的清单逐行相同;Q-I 列举不完整的提示', () => {
  it('真实 listArmed(不经注入缝)+ 含一个已排除项目:confirm 的清单与汇总行 = rsi projects 的输出;说明与提示符在其后;stdout 不含路径', async () => {
    const f = await mkArmed('cf-render-', 3);
    await setExtra(f, `exclude_dirs = [${JSON.stringify(projPath(f, 2))}]\n`);
    const proj = await runCmd(f, runProjects, [], {});
    expect(proj.code, proj.err).toBe(0);
    const want = proj.out.trimEnd().split('\n');
    expect(want.length).toBe(4); // 3 个项目行 + 汇总行(正向前提)
    expect(want.filter((l) => l.includes('status=excluded')).length).toBe(1);
    const r = await say(f, 'no');
    const got = r.out.trimEnd().split('\n');
    expect(got.slice(0, want.length)).toEqual(want);
    expect(got.slice(want.length)).toHaveLength(4); // 3 行说明 + 提示符;没有 armed_list=incomplete
    expect(r.out).not.toContain('armed_list=incomplete');
    for (const p of [f.dir, f.home, f.repo, f.tmp]) expect(r.out).not.toContain(p);
  });

  it('Q-I:列举不完整 → 允许 confirm,但输出 `armed_list=incomplete` 与固定提示「未列出的项目同样会被读取」(不带路径);完整时没有这两行', async () => {
    const f = await mkArmed('cf-incomplete-');
    const inject = (complete: boolean): RsiConfirmDeps => ({
      listArmed: async () => ({
        rows: [{ name: 'only', sessions: 1, path: path.join(f.dir, 'x'), excluded: false }],
        unknownSessions: 2,
        complete,
      }),
    });
    const a = await say(f, 'no', inject(true));
    expect(a.out).not.toContain('armed_list=incomplete');
    expect(a.out).not.toContain('未列出的项目同样会被读取');
    const b = await say(f, 'yes', inject(false));
    expect([b.code, b.err]).toEqual([0, '']);
    expect(b.out).toContain('armed_list=incomplete\n');
    expect(b.out).toContain('未列出的项目同样会被读取');
    expect(b.out).not.toContain(f.dir);
    expect(await confirmOf(f)).not.toBeNull(); // 同意建立在不完整的清单上(Q-I = A)
  });
});

describe('泄漏闸:清单里出现禁止的绝对路径', () => {
  it('目录名里带着仓库根路径 → 整份作废:3 output_leak,stdout 为空,不读输入,零写入', async () => {
    const f = await mkArmed('cf-leak-');
    await zeroWrites(f, async () => {
      const r = await say(f, 'yes', {
        listArmed: async () => ({
          rows: [{ name: f.repo, sessions: 1, path: f.repo, excluded: false }],
          unknownSessions: 0,
          complete: true,
        }),
      });
      expect([r.code, r.err, r.out, r.reads]).toEqual([
        3,
        'RSI_FAIL_CLOSED reason=output_leak\n',
        '',
        0,
      ]);
    });
  });
});

describe('R20-3.6.3 STALE(锁前:列举期间 / 等待输入期间)', () => {
  type Mut = (f: TickFx) => Promise<void>;
  const mutations: [string, Mut][] = [
    ['agents', (f) => writeCfg(f, rsiToml(f, 'agents = ["claude"]\n'))],
    [
      '排除项',
      (f) => writeCfg(f, rsiToml(f, `exclude_dirs = [${JSON.stringify(projPath(f, 1))}]\n`)),
    ],
    [
      'overlay',
      async (f) => {
        const ov = path.join(f.dir, 'overlay.toml');
        await writeFile(f.fx, ov, 'internal_domains = ["corp.example"]\n', { mode: 0o600 });
        await writeCfg(f, rsiToml(f, `overlay = ${JSON.stringify(ov)}\n`));
      },
    ],
    [
      'repo(旧目录改名保留 + 新建:realpath 不变,(dev, ino) 变)',
      async (f) => {
        await rename(f.fx, f.repo, `${f.repo}-old`);
        await mkdirp(f.fx, f.repo, 0o755);
        await chmod(f.fx, f.repo, 0o755);
        await writeFile(f.fx, path.join(f.repo, 'kit.toml'), '[kit]\n', { mode: 0o644 });
      },
    ],
    [
      '另开终端 rsi stop(新出现的 STOP 必须判 STALE,免得 confirm 删掉它)',
      async (f) => void (await runCmd(own(f), runStop, [], {})),
    ],
  ];

  for (const [name, mut] of mutations) {
    it(`等待输入期间改 ${name} → 1 RSI_CONFIRM_STALE,零写入(不拿锁)`, async () => {
      const f = await mkArmed(`cf-stale-${name.length}-${name.charCodeAt(0)}-`);
      let tree: string[] = [];
      const r = await say(f, async () => {
        await mut(f);
        tree = await treeOf(f.dir);
        return 'yes';
      });
      expect([r.code, r.err, r.reads]).toEqual([1, 'RSI_CONFIRM_STALE\n', 1]);
      expect(f.audit).toEqual([]);
      expect(await treeOf(f.dir)).toEqual(tree);
      if (name.startsWith('另开终端')) {
        expect(await exists(stopPath(f))).toBe(true);
        expect(await confirmOf(f)).toBeNull();
      }
    });

    it(`列举期间改 ${name} → 1 STALE,不展示、不读输入`, async () => {
      const f = await mkArmed(`cf-stalel-${name.length}-${name.charCodeAt(0)}-`);
      const r = await say(f, 'yes', {
        listArmed: async (io, c) => {
          const l = await listArmed(io, c, { piDirSet: piDirIsSet(f.env) });
          await mut(f);
          return l;
        },
      });
      expect([r.code, r.err, r.out, r.reads]).toEqual([1, 'RSI_CONFIRM_STALE\n', '', 0]);
      expect(f.audit).toEqual([]);
    });
  }

  it('STOP 被替换成同长度、不同内容的新标记(stopped 夹具)→ STALE;STOP 仍是新内容', async () => {
    const f = await mkStopped('cf-stale-stopswap-');
    const r = await say(f, async () => {
      await replaceStop(f, STOP_DOC_B);
      return 'yes';
    });
    expect([r.code, r.err]).toEqual([1, 'RSI_CONFIRM_STALE\n']);
    expect(f.audit).toEqual([]);
    expect(await readText(stopPath(f))).toBe(STOP_DOC_B);
    expect((await confirmOf(f))?.['confirmed_at']).toBe(OLD_AT);
  });

  it('等待输入期间另一个 confirm 抢先完成 → 每个观测点统一 0 `confirm already`;本次零写入,先到者的记录原样保留', async () => {
    const f = await mkArmed('cf-race-');
    const r = await say(f, async () => {
      const inner = await say(own(f), 'yes', { now: () => new Date('2026-10-26T00:00:00.000Z') });
      expect(inner.code, inner.err).toBe(0);
      return 'yes';
    });
    expect([r.code, r.err]).toEqual([0, '']);
    expect(r.out.endsWith('confirm already\n')).toBe(true);
    expect(f.audit).toEqual([]);
    expect((await confirmOf(f))?.['confirmed_at']).toBe('2026-10-26T00:00:00.000Z');
  });

  it('判定序:obs0 有效 STOP,之后被换成目录(假身份)——obs1 / 锁前 / 锁内各报 3 state_dir_unsafe,不是 1 STALE', async () => {
    const swapToDir = async (f: TickFx): Promise<void> => {
      await rename(f.fx, stopPath(f), `${stopPath(f)}.old`);
      await mkdirp(f.io, stopPath(f), 0o700);
    };
    const unsafe = 'RSI_FAIL_CLOSED reason=state_dir_unsafe\n';
    const a = await mkStopped('cf-order-l-');
    const ra = await say(a, 'yes', {
      listArmed: async (io, c) => {
        const l = await listArmed(io, c, { piDirSet: piDirIsSet(a.env) });
        await swapToDir(a);
        return l;
      },
    });
    expect([ra.code, ra.err, ra.reads]).toEqual([3, unsafe, 0]);
    const b = await mkStopped('cf-order-p-');
    const rb = await say(b, async () => {
      await swapToDir(b);
      return 'yes';
    });
    expect([rb.code, rb.err]).toEqual([3, unsafe]);
    expect(b.audit).toEqual([]);
    const c = await mkStopped('cf-order-k-');
    const rc = await say(c, 'yes', { afterLock: () => swapToDir(c) });
    expect([rc.code, rc.err]).toEqual([3, unsafe]);
    expect((await confirmOf(c))?.['confirmed_at']).toBe(OLD_AT);
  });
});

describe('R20-5.1 拿锁(只在 yes 之后);锁后的拒绝与 D2 / §0.5 R2 判据分工', () => {
  it('另一个进程持锁 → 4 RSI_NOT_RUN reason=locked;state / STOP 都不动,没有任何数据写', async () => {
    const f = await mkStopped('cf-locked-');
    const release = await foreignLock(f);
    const before = await treeOf(f.dir);
    const r = await say(f);
    expect([r.code, r.err]).toEqual([4, 'RSI_NOT_RUN reason=locked\n']);
    expect(f.audit.every((c) => c.path.endsWith('/rsi/lock') || c.op === 'mkdirp')).toBe(true);
    expect(await treeOf(f.dir)).toEqual(before);
    expect(await exists(stopPath(f))).toBe(true);
    await release();
  });

  it('DECLINED / 锁前 STALE 不拿锁:此时有人持锁也照样是 1(不会变成 4)', async () => {
    const f = await mkArmed('cf-nolock-');
    const release = await foreignLock(f);
    expect((await say(f, 'no')).code).toBe(1);
    await release();
  });

  /** 锁内、复检之前:改配置(让复检判 STALE)、造「清单与文件不一致」与 `.tmp`;真正的 recover 会补写清单并删 `.tmp` */
  async function lockedStale(
    prefix: string,
    mode: 'unfinished' | 'corrupt',
    withStale: boolean,
  ): Promise<{ f: TickFx; r: Say; manifest: Uint8Array; tmpBefore: Uint8Array }> {
    const f = await mkArmed(prefix);
    const manifest = path.join(f.rsiDir, 'snapshot.json');
    const tmp = `${manifest}.tmp`;
    let m0: Uint8Array = new Uint8Array();
    let t0: Uint8Array = new Uint8Array();
    const r = await say(f, 'yes', {
      afterLock: async () => {
        if (mode === 'unfinished') {
          await overwriteRsi(f, 'state.json', {
            ...(baseState() as object),
            projects_ack_generation: 9,
          });
        } else {
          await writeFile(f.io, manifest, 'not json', { mode: 0o600 });
        }
        await writeFile(f.io, tmp, 'junk', { mode: 0o600 });
        if (withStale) await writeCfg(f, rsiToml(f, 'agents = ["claude"]\n'));
        m0 = await readBytes(manifest);
        t0 = await readBytes(tmp);
      },
    });
    return { f, r, manifest: m0, tmpBefore: t0 };
  }
  const lockOnly = (f: TickFx): string[] =>
    f.audit.filter((c) => c.op !== 'mkdirp').map((c) => c.op);

  it('锁后 STALE + 未完成的提交 + 预置 .tmp:退 1,写审计恰好是锁文件的 createExclusive 与 remove,.tmp 仍在,snapshot.json 字节不变(抓「复检挪到 recover 之后」)', async () => {
    const { f, r, manifest, tmpBefore } = await lockedStale('cf-d2-un-', 'unfinished', true);
    expect([r.code, r.err]).toEqual([1, 'RSI_CONFIRM_STALE\n']);
    expect(lockOnly(f)).toEqual(['createExclusive', 'remove']);
    expect(
      f.audit.filter((c) => c.op !== 'mkdirp').every((c) => c.path.endsWith('/rsi/lock')),
    ).toBe(true);
    expect(await readBytes(path.join(f.rsiDir, 'snapshot.json.tmp'))).toEqual(tmpBefore);
    expect(await readBytes(path.join(f.rsiDir, 'snapshot.json'))).toEqual(manifest);
    expect(await confirmOf(f)).toBeNull();
  });

  it('同一夹具、不被拒绝 → recover 会处理未完成的提交,confirm 成功(正向对照:上面的「零写入」不是因为什么都不会写)', async () => {
    const { f, r } = await lockedStale('cf-d2-ok-', 'unfinished', false);
    expect([r.code, r.err]).toEqual([0, '']);
    expect(await consistent(f)).toBe(true);
    expect(await exists(path.join(f.rsiDir, 'snapshot.json.tmp'))).toBe(false);
  });

  it('清单本身损坏 + 拒绝 → 仍是 1 STALE(拒绝先于快照检查);不被拒绝 → 3 snapshot_invalid,同样只有锁文件写', async () => {
    const a = await lockedStale('cf-d2-cor-a-', 'corrupt', true);
    expect([a.r.code, a.r.err]).toEqual([1, 'RSI_CONFIRM_STALE\n']);
    expect(lockOnly(a.f)).toEqual(['createExclusive', 'remove']);
    const b = await lockedStale('cf-d2-cor-b-', 'corrupt', false);
    expect([b.r.code, b.r.err]).toEqual([3, 'RSI_FAIL_CLOSED reason=snapshot_invalid\n']);
    expect(lockOnly(b.f)).toEqual(['createExclusive', 'remove']);
    expect(await confirmOf(b.f)).toBeNull();
  });

  it('锁内复检的另外几个拒绝:配置 off → 4;state.json 不合规 → 3;他人先 confirm → 0 already;都只有锁文件写', async () => {
    const off = await mkArmed('cf-lk-off-');
    const a = await say(off, 'yes', { afterLock: () => writeCfg(off, '[rsi]\nenabled = false\n') });
    expect([a.code, a.err]).toEqual([4, 'RSI_NOT_RUN reason=off\n']);
    expect(lockOnly(off)).toEqual(['createExclusive', 'remove']);
    const bad = await mkArmed('cf-lk-bad-');
    const b = await say(bad, 'yes', {
      afterLock: () => overwriteRsi(bad, 'state.json', '{"nope":1}'),
    });
    expect([b.code, b.err]).toEqual([3, 'RSI_FAIL_CLOSED reason=state_invalid\n']);
    expect(lockOnly(bad)).toEqual(['createExclusive', 'remove']);
    const race = await mkArmed('cf-lk-race-');
    const c = await say(race, 'yes', {
      // 另一个 confirm 在 obs2 与拿锁之间完成:直接落一份有效记录(此时锁在本命令手里,真正的 confirm 进不来)
      afterLock: async () =>
        overwriteRsi(race, 'state.json', baseState({ confirm: await validConfirm(race) })),
    });
    expect([c.code, c.out.endsWith('confirm already\n')]).toEqual([0, true]);
    expect(lockOnly(race)).toEqual(['createExclusive', 'remove']);
  });
});

describe('成功路径:记录内容、清什么留什么、写入顺序、STOP', () => {
  it('首次 armed:记录字段 / baseline_pending:true / 日志 confirmed / 快照一致 / 状态变 confirmed;第一次成功 tick 之后 baseline 翻成 false(R20-4.2a)', async () => {
    const f = await mkArmed('cf-ok-');
    const r = await say(f);
    expect([r.code, r.err]).toEqual([0, '']);
    expect(r.out.endsWith('confirm ok\n')).toBe(true);
    const c = await confirmOf(f);
    expect(c).toMatchObject({
      confirmed_at: NEW_AT,
      baseline_pending: true,
      agents: ['claude', 'codex', 'pi'],
      overlay_sha256: null,
    });
    expect(Object.keys(c ?? {}).sort()).toEqual(
      [
        'agents',
        'baseline_pending',
        'confirmed_at',
        'exclude_hashes',
        'kit_major',
        'overlay_sha256',
        'policy_fp',
        'repo_dev_ino',
        'repo_sha256',
      ].sort(),
    );
    expect(await stateName(f)).toBe('confirmed');
    expect(await consistent(f)).toBe(true);
    const log = (await readText(path.join(f.rsiDir, 'log.jsonl'))).trim().split('\n');
    expect(JSON.parse(log[log.length - 1] as string)).toMatchObject({
      trigger: 'confirm',
      action: 'confirmed',
      code: 'ok',
      at: NEW_AT,
    });
    const t = await runCmd(f, runTick, ['--write'], {});
    expect(t.code, t.err).toBe(0);
    expect((await confirmOf(f))?.['baseline_pending']).toBe(false); // confirm 写的新记录能被 ackBaseline 翻转
  });

  it('stopped + 旧有效确认:新记录覆盖旧记录;清熔断 / 失败计数 / armed_listing;保留 projects_ack_generation / last_tick / attempt;删 STOP;快照仍 consistent(STOP 不在清单里)', async () => {
    const f = await mkStopped('cf-ok-stopped-');
    expect(await stateName(f)).toBe('stopped');
    const r = await say(f);
    expect([r.code, r.err]).toEqual([0, '']);
    expect(await exists(stopPath(f))).toBe(false);
    const st = await stateOf(f);
    expect((st['confirm'] as Record<string, unknown>)['confirmed_at']).toBe(NEW_AT);
    expect((st['confirm'] as Record<string, unknown>)['baseline_pending']).toBe(true);
    expect(st['breaker']).toBeNull();
    expect(st['consecutive_failures']).toBe(0);
    expect('armed_listing' in st).toBe(false);
    expect(st['projects_ack_generation']).toBe(4);
    expect(st['last_tick']).toEqual(LAST_TICK);
    expect(st['attempt']).toEqual(ATTEMPT);
    expect(await stateName(f)).toBe('confirmed');
    expect(await consistent(f)).toBe(true);
  });

  it('坏的旧 confirm(只有 confirm 不合规)被新记录覆盖,不透传', async () => {
    const f = await mkArmed('cf-ok-badconf-');
    await overwriteRsi(f, 'state.json', { ...(baseState() as object), confirm: { bogus: 1 } });
    const r = await say(f);
    expect([r.code, r.err]).toEqual([0, '']);
    expect((await confirmOf(f))?.['confirmed_at']).toBe(NEW_AT);
  });

  it('写点顺序:recover → state rename → log-append → snapshot-rename → stop-remove(最后);之前 STOP 一直在', async () => {
    const f = await mkStopped('cf-order-');
    const ops: { op: string; stop: boolean }[] = [];
    const r = await say(f, 'yes', {
      beforeWrite: async (op) => void ops.push({ op, stop: await exists(stopPath(f)) }),
    });
    expect(r.code, r.err).toBe(0);
    const names = ops.map((o) => o.op);
    const at = (n: string): number => names.indexOf(n);
    expect(at('recover')).toBe(0);
    expect(at('rename:state.json')).toBeGreaterThan(at('recover'));
    expect(at('log-append')).toBeGreaterThan(at('rename:state.json'));
    expect(at('snapshot-rename')).toBeGreaterThan(at('log-append'));
    expect(names[names.length - 1]).toBe('stop-remove');
    expect(at('stop-remove')).toBeGreaterThan(at('snapshot-rename'));
    expect(ops.every((o) => o.stop)).toBe(true); // 每个写点之前 STOP 都还在(含 stop-remove 之前)
  });

  it('STOP 窗口:commit 之前被换成新普通文件 / 目录 → 不删,保留;记录已写入;退 4 RSI_NOT_RUN reason=stopped,stdout `confirm recorded` + `stop=kept`', async () => {
    for (const kind of ['file', 'dir'] as const) {
      const f = await mkStopped(`cf-win-${kind}-`);
      let done = false;
      const r = await say(f, 'yes', {
        beforeWrite: async (op) => {
          if (op !== 'snapshot-rename' || done) return;
          done = true;
          await rename(f.fx, stopPath(f), `${stopPath(f)}.old`);
          if (kind === 'file') await putStop(f, STOP_DOC_B);
          else await mkdirp(f.io, stopPath(f), 0o700);
        },
      });
      expect([r.code, r.err], kind).toEqual([4, 'RSI_NOT_RUN reason=stopped\n']);
      expect(r.out.endsWith('confirm recorded\nstop=kept\n')).toBe(true);
      expect(await exists(stopPath(f))).toBe(true);
      if (kind === 'file') expect(await readText(stopPath(f))).toBe(STOP_DOC_B);
      expect((await confirmOf(f))?.['confirmed_at']).toBe(NEW_AT);
      expect(await stateName(f)).toBe('stopped');
      expect(await consistent(f)).toBe(true);
    }
  });

  it('复检时没有 STOP、commit 之前才出现(另开终端 stop)→ 不删,同样 kept / 4', async () => {
    const f = await mkArmed('cf-win-new-');
    let done = false;
    const r = await say(f, 'yes', {
      beforeWrite: async (op) => {
        if (op !== 'snapshot-rename' || done) return;
        done = true;
        await putStop(f);
      },
    });
    expect([r.code, r.err]).toEqual([4, 'RSI_NOT_RUN reason=stopped\n']);
    expect(await readText(stopPath(f))).toBe(STOP_DOC);
    expect(await stateName(f)).toBe('stopped');
  });

  it('STOP 删除失败(state 已提交)→ 3,STOP 仍在、记录已是新的;重跑 confirm 幂等(此时 stopped + 有效 confirm),结果与一次成功相同', async () => {
    const f = await mkStopped('cf-stopfail-');
    const r1 = await say(f, 'yes', {
      beforeWrite: async (op) => {
        if (op === 'stop-remove') throw new Error('boom');
      },
    });
    expect([r1.code, r1.err]).toEqual([3, 'RSI_FAIL_CLOSED reason=internal\n']);
    expect(r1.out.endsWith('confirm recorded\n')).toBe(true); // commit 之后的失败要让用户知道记录已写入
    expect(await exists(stopPath(f))).toBe(true);
    expect((await confirmOf(f))?.['confirmed_at']).toBe(NEW_AT);
    expect(await stateName(f)).toBe('stopped');
    expect(await consistent(f)).toBe(true);
    const r2 = await say(f, 'yes', { now: () => new Date('2026-10-27T05:00:00.000Z') });
    expect([r2.code, r2.err]).toEqual([0, '']);
    expect(r2.out).toContain('status='); // 重跑会重新展示清单
    expect(await exists(stopPath(f))).toBe(false);
    expect((await confirmOf(f))?.['confirmed_at']).toBe('2026-10-27T05:00:00.000Z');
    expect(await stateName(f)).toBe('confirmed');
    expect(await consistent(f)).toBe(true);
  });

  it('STOP 是硬链接(nlink 2):锁前就拒(3 state_dir_unsafe,零写入,不读输入),不会走到 commit 之后才失败再循环;STOP 仍在、状态仍是 stopped', async () => {
    const f = await mkArmed('cf-hard-');
    await putStop(f);
    await hardlink(f.fx, stopPath(f), path.join(f.dir, 'work', 'stop-link'));
    await zeroWrites(f, async () => {
      const r = await say(f);
      expect([r.code, r.err, r.out, r.reads]).toEqual([
        3,
        'RSI_FAIL_CLOSED reason=state_dir_unsafe\n',
        '',
        0,
      ]);
    });
    expect(await exists(stopPath(f))).toBe(true);
    expect(await stateName(f)).toBe('stopped');
    expect(await confirmOf(f)).toBeNull();
  });
});

describe('失锁 k 遍历 / 崩溃矩阵(stopped + 旧有效确认;armed)', () => {
  const variants: ['stopped' | 'armed', (p: string) => Promise<TickFx>][] = [
    ['stopped', mkStopped],
    ['armed', (p) => mkArmed(p)],
  ];
  for (const [name, mk] of variants) {
    it(`${name}:每个写点之前失锁 → 3 lock_lost,失锁之后写审计为 0;STOP 在则一直在`, async () => {
      const rec = await mk(`cf-lost-rec-${name}-`);
      const ops: { op: string; audit: number }[] = [];
      expect(
        (
          await say(rec, 'yes', {
            beforeWrite: async (op) => void ops.push({ op, audit: rec.audit.length }),
          })
        ).code,
      ).toBe(0);
      expect(ops.length).toBeGreaterThanOrEqual(name === 'stopped' ? 7 : 6);
      for (let k = 1; k <= ops.length; k++) {
        const f = await mk(`cf-lost-${name}-${k}-`);
        let seen = 0;
        let at = -1;
        const base = f.audit.length;
        const r = await say(f, 'yes', {
          beforeWrite: async () => {
            if (++seen !== k) return;
            at = f.audit.length;
            await loseLockOf(f);
          },
        });
        expect([r.code, r.err], `k=${k} ${ops[k - 1]?.op}`).toEqual([
          3,
          'RSI_FAIL_CLOSED reason=lock_lost\n',
        ]);
        expect(at - base, `k=${k} 与记录的写点流一致`).toBe(ops[k - 1]?.audit);
        expect(f.audit.length - at, `k=${k} ${ops[k - 1]?.op}:失锁之后零写入`).toBe(0);
        if (name === 'stopped') expect(await exists(stopPath(f)), `k=${k}`).toBe(true);
      }
    }, 240_000);

    it(`${name}:每个写点之前崩溃(抛错)→ 不变量成立,重跑 confirm 成功、快照一致、STOP 已清`, async () => {
      const rec = await mk(`cf-crash-rec-${name}-`);
      let n = 0;
      expect((await say(rec, 'yes', { beforeWrite: async () => void n++ })).code).toBe(0);
      for (let k = 1; k <= n; k++) {
        const f = await mk(`cf-crash-${name}-${k}-`);
        let seen = 0;
        const first = await say(f, 'yes', {
          beforeWrite: async () => {
            if (++seen === k) throw new Error('crash');
          },
        });
        expect(first.code, `k=${k}`).toBe(3);
        const hasStop = await exists(stopPath(f));
        if (name === 'stopped') {
          // 崩溃永远停在 stopped 一侧:STOP 在场;「STOP 不在 ⇒ 磁盘上是新记录且快照一致」是同一不变量的逆否
          expect(hasStop, `k=${k} STOP 在场`).toBe(true);
          if (!hasStop) expect((await confirmOf(f))?.['confirmed_at']).toBe(NEW_AT);
          expect(await stateName(f), `k=${k}`).toBe('stopped');
        }
        const second = await say(f, 'yes');
        expect(second.code, `k=${k} 重跑:${second.err}`).toBe(0);
        expect(await exists(stopPath(f)), `k=${k}`).toBe(false);
        expect(await stateName(f), `k=${k}`).toBe('confirmed');
        // 重跑之后(含「state 已写、commit 之前」崩溃留下的未完成提交):下一个写入方(tick)恢复快照,最终一致
        if (!(await consistent(f))) {
          const t = await runCmd(f, runTick, ['--write'], {});
          expect(t.code, `k=${k} tick:${t.err}`).toBe(0);
        }
        expect(await consistent(f), `k=${k} 快照一致`).toBe(true);
      }
    }, 240_000);
  }

  it('stopped:「state 已写、commit 之前」崩溃后,重跑不被 RSI_SNAPSHOT_BUSY 卡住(锁前不走快照协议,锁内 recover)', async () => {
    const f = await mkStopped('cf-nobusy-');
    const first = await say(f, 'yes', {
      beforeWrite: async (op) => {
        if (op === 'log-append') throw new Error('crash'); // state 已 rename,清单尚未更新
      },
    });
    expect(first.code).toBe(3);
    expect(await consistent(f)).toBe(false); // 正向前提:确实留下了未完成的提交
    const second = await say(f);
    expect([second.code, second.err]).toEqual([0, '']);
    expect(await consistent(f)).toBe(true);
  });
});

describe('R20-4.7 taint 时机:刚写下的排除在 confirm 时立即生效', () => {
  async function withRun(prefix: string, excluded: boolean): Promise<{ s: Svc; runDir: string }> {
    const s = await makeSvc(prefix);
    const proj = path.join(s.f.dir, 'proj', 'x');
    await mkdirp(s.f.fx, proj, 0o755);
    const kx = projectKeyFor(SALT, proj);
    await putSession(
      s.f,
      'claude',
      `p/${uuid(1)}.jsonl`,
      jl(
        claudeLine(proj, { timestamp: '2026-10-01T00:00:00.000Z' }),
        claudeLine(proj, { timestamp: '2026-10-01T00:00:01.000Z' }),
      ),
    );
    await addSignals(s, [{ id: 'aaaa000000000001', key: kx }]);
    await writeIndex(s, [{ key: kx, root: proj }]);
    await stageRun(s, 'rx', ['aaaa000000000001']);
    if (excluded) await setRsiToml(s, `exclude_dirs = [${JSON.stringify(proj)}]\n`);
    return { s, runDir: path.join(s.state, 'reflect', 'rx') };
  }

  it('命中已排除项目的暂存 run:摘录清空、TAINTED 在场、counts.staged 标 tainted;未排除时不动(正向对照)', async () => {
    const a = await withRun('cf-taint-a-', true);
    const ra = await say(cmdFxOf(a.s), 'yes');
    expect([ra.code, ra.err]).toEqual([0, '']);
    expect(await exists(path.join(a.runDir, 'TAINTED'))).toBe(true);
    expect(await readText(path.join(a.runDir, 'proposals', '2026-10-26-001.yaml'))).not.toContain(
      'SECRET-EXCERPT',
    );
    const counts = JSON.parse(await readText(path.join(a.s.rsi, 'counts.json'))) as {
      staged: { run_id: string; tainted: boolean }[];
    };
    expect(counts.staged).toEqual([expect.objectContaining({ run_id: 'rx', tainted: true })]);
    const b = await withRun('cf-taint-b-', false);
    const rb = await say(cmdFxOf(b.s), 'yes');
    expect([rb.code, rb.err]).toEqual([0, '']);
    expect(await exists(path.join(b.runDir, 'TAINTED'))).toBe(false);
    expect(await readText(path.join(b.runDir, 'proposals', '2026-10-26-001.yaml'))).toContain(
      'SECRET-EXCERPT',
    );
  });

  it('等待输入期间改排除 → STALE,run 不被 taint(taint 只在复检通过之后)', async () => {
    const { s, runDir } = await withRun('cf-taint-stale-', false);
    const proj = path.join(s.f.dir, 'proj', 'x');
    const cf = cmdFxOf(s);
    const r = await say(cf, async () => {
      await setRsiToml(s, `exclude_dirs = [${JSON.stringify(proj)}]\n`);
      return 'yes';
    });
    expect([r.code, r.err]).toEqual([1, 'RSI_CONFIRM_STALE\n']);
    expect(await exists(path.join(runDir, 'TAINTED'))).toBe(false);
    expect(cf.audit).toEqual([]);
  });
});

describe('§2.1 / §0.5 R10 配置来源一致性(排除项、状态目录两个维度)', () => {
  it('排除项:KIT_REAL_HOME_OVERRIDE 与进程 HOME 各放一份相反的配置,两个方向 taint 都跟随命令侧(openRsiIo)读到的那份', async () => {
    for (const commandExcludes of [true, false]) {
      const s = await makeSvc(`cf-r10a-${commandExcludes}-`);
      const proj = path.join(s.f.dir, 'proj', 'x');
      await mkdirp(s.f.fx, proj, 0o755);
      const kx = projectKeyFor(SALT, proj);
      await addSignals(s, [{ id: 'aaaa000000000001', key: kx }]);
      await writeIndex(s, [{ key: kx, root: proj }]);
      await stageRun(s, 'rx', ['aaaa000000000001']);
      const excl = `exclude_dirs = [${JSON.stringify(proj)}]\n`;
      // S:命令侧(env.KIT_REAL_HOME_OVERRIDE = s.f.home)
      await setRsiToml(s, commandExcludes ? excl : '');
      // L:进程 HOME 另一份,取相反的排除
      const other = path.join(s.f.dir, 'otherhome');
      const cfgDir = path.join(other, '.config', 'agent-kit');
      await mkdirp(s.f.fx, cfgDir, 0o755);
      await chmod(s.f.fx, path.join(other, '.config'), 0o755);
      await chmod(s.f.fx, cfgDir, 0o755);
      await writeFile(
        s.f.fx,
        path.join(cfgDir, 'config.toml'),
        rsiToml(s.f, commandExcludes ? '' : excl),
        { mode: 0o600 },
      );
      vi.stubEnv('HOME', other);
      try {
        const r = await say(cmdFxOf(s), 'yes');
        expect([r.code, r.err], `命令侧${commandExcludes ? '排除' : '不排除'}`).toEqual([0, '']);
        expect(await exists(path.join(s.state, 'reflect', 'rx', 'TAINTED'))).toBe(commandExcludes);
      } finally {
        vi.unstubAllEnvs();
      }
    }
  });

  it('状态目录:env 带 KIT_STATE_DIR / KIT_WRITE_ROOTS 指向别处,confirm 读写的仍是 [rsi] repo/.state,没有碰那两个位置', async () => {
    const f = await mkArmed('cf-r10b-');
    const elsewhere = path.join(f.dir, 'elsewhere');
    await mkdirp(f.fx, elsewhere, 0o755);
    const r = await runCmd(
      f,
      runConfirm,
      [],
      { now: NOW_D },
      {
        isTty: true,
        readLine: async () => 'yes',
        // 没有 KIT_TMP = 真实使用环境:rsi 入口忽略这两个变量(设了 KIT_TMP 是测试夹具,它们会生效)
        env: { KIT_TMP: undefined, KIT_STATE_DIR: elsewhere, KIT_WRITE_ROOTS: elsewhere },
      },
    );
    expect([r.code, r.err]).toEqual([0, '']);
    expect((await confirmOf(f))?.['confirmed_at']).toBe(NEW_AT);
    expect(await treeOf(elsewhere)).toEqual([]);
  });
});

describe('展示指纹(R20-3.6.2;STOP 身份含内容 sha256)', () => {
  it('每一项都进指纹:repo / agents / 排除哈希 / overlay / kit 主版本 / STOP(在场、ino、size、内容 sha256);相同观测相同指纹', async () => {
    const f = await mkArmed('cf-fp-');
    await putStop(f);
    const o = await observeRsi(f.io, f.env);
    const fp = displayFingerprint(o);
    expect(displayFingerprint({ ...o })).toBe(fp);
    const id = o.identity;
    const st = o.stop;
    if (id === null || st === 'absent') throw new Error('夹具');
    const withId = (patch: Partial<typeof id>): string =>
      displayFingerprint({ ...o, identity: { ...id, ...patch } });
    const withPolicy = (patch: Partial<typeof id.policy>): string =>
      displayFingerprint({ ...o, identity: { ...id, policy: { ...id.policy, ...patch } } });
    const withStop = (patch: Partial<typeof st>): string =>
      displayFingerprint({ ...o, stop: { ...st, ...patch } });
    const variants: Record<string, string> = {
      repo_sha256: withId({ repoSha256: 'f'.repeat(64) }),
      repo_dev_ino: withId({ repoDevIno: { dev: id.repoDevIno.dev, ino: id.repoDevIno.ino + 1 } }),
      agents: withPolicy({ agents: ['claude'] }),
      exclude_hashes: withPolicy({ exclude_hashes: ['e'.repeat(64)] }),
      overlay: withPolicy({ overlay_sha256: 'd'.repeat(64) }),
      kit_major: withPolicy({ kit_major: id.policy.kit_major + 1 }),
      stop_absent: displayFingerprint({ ...o, stop: 'absent' }),
      stop_ino: withStop({ ino: st.ino + 1 }),
      stop_size: withStop({ size: st.size + 1 }),
      stop_sha256: withStop({ sha256: 'c'.repeat(64) }),
    };
    for (const [k, v] of Object.entries(variants)) expect(v, k).not.toBe(fp);
    expect(new Set(Object.values(variants)).size).toBe(Object.keys(variants).length);
  });
});

describe('真实 main() 路径', () => {
  it('rsi confirm 经 main():isTty / readLine 注入;yes → 0,写审计只落在 .state 内;非 TTY → 2', async () => {
    const f = await mkArmed('cf-main-');
    const audit: string[] = [];
    let out = '';
    let err = '';
    const code = await main(['rsi', 'confirm'], {
      env: f.env,
      cwd: f.dir,
      writeAudit: (op, p) => void audit.push(`${op} ${p}`),
      stdout: (t) => (out += t),
      stderr: (t) => (err += t),
      isTty: true,
      readLine: async () => 'yes',
    });
    expect([code, err]).toEqual([0, '']);
    expect(out.endsWith('confirm ok\n')).toBe(true);
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((l) => l.split(' ')[1]?.startsWith(path.join(f.repo, '.state')))).toBe(true);
    const g = await mkArmed('cf-main-tty-');
    let err2 = '';
    const code2 = await main(['rsi', 'confirm'], {
      env: g.env,
      cwd: g.dir,
      stdout: () => undefined,
      stderr: (t) => (err2 += t),
      isTty: false,
    });
    expect([code2, err2]).toEqual([2, 'RSI_USAGE reason=not_tty\n']);
  });
});
