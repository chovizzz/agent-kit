/**
 * R20-A6:提醒一次(R20-17.11–R20-17.15;负向矩阵 R20-17.25 的「提醒」「notice_full」部分)。
 * 直接调 `runRsiNotice`(带注入的 TTY / 时钟 / 锁判据 / 检查点),假 HOME / KIT_TMP 内的真实目录;写审计由外部数组累计。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, existsSync, readBytes } from '../../src/io/read-fs.js';
import { chmod, mkdirp, remove, symlink, writeFile } from '../../src/io/safe-fs.js';
import { RsiLogLineSchema, type RsiLogLine } from '../../src/contracts/rsi.js';
import {
  runRsiNotice,
  isHookCommand,
  logNoticeGiveUp,
  type NoticeDeps,
  type NoticeOutcome,
} from '../../src/rsi/notice.js';
import { runStatus, type StatusDoc } from '../../src/rsi/status.js';
import type { AuditCall } from '../helpers/write-audit.js';
import {
  PROJECT_NAME,
  auditRel,
  makeA6World,
  noticeDoc,
  putReport,
  putRsiFile,
  rsiFilePath,
  type StagedSpec,
} from './a6-fixture.js';
import { treeOf } from './rsi-fixture.js';
import {
  NOW,
  baseState,
  countsOf,
  indexOf,
  key,
  makeRoFx,
  mkProject,
  runDirect,
  seed,
  setExtra,
  validConfirm,
  type RoFx,
} from './ro-fixture.js';

const LINE_RE =
  /^RSI_(COLLECTION_STARTED projects=\d+ excluded=\d+|PROPOSALS_READY runs=\d+ proposals=\d+)\n$/;

interface Run {
  outcome: NoticeOutcome;
  err: string[];
  audit: AuditCall[];
  reads: number;
}

async function notice(
  f: RoFx,
  o: {
    argv?: string[];
    isTty?: boolean;
    env?: Record<string, string | undefined>;
    deps?: NoticeDeps;
    stderr?: (t: string) => void;
  } = {},
): Promise<Run> {
  const err: string[] = [];
  const audit: AuditCall[] = [];
  let reads = 0;
  const userPoint = o.deps?.point;
  const outcome = await runRsiNotice(
    {
      argv: o.argv ?? ['status'],
      env: { ...f.env, ...o.env },
      isTty: o.isTty ?? true,
      stderr: o.stderr ?? ((t) => void err.push(t)),
      writeAudit: (op, p) => void audit.push({ op, path: p }),
    },
    {
      now: () => new Date(NOW),
      clockMs: () => 0,
      ...o.deps,
      point: (n) => {
        if (n === 'read_reflect') reads++;
        userPoint?.(n);
      },
    },
  );
  return { outcome, err, audit, reads };
}

const noticeFile = (f: RoFx): string => rsiFilePath(f, 'notice.json');
const readNoticeDoc = async (
  f: RoFx,
): Promise<{
  schema_version: number;
  proposals_notified: string[];
  collection_started_for: string | null;
}> => JSON.parse(Buffer.from(await readBytes(noticeFile(f))).toString('utf8'));
/** `log.jsonl` 里 `trigger=notice` 的行(逐行过 RsiLogLineSchema;文件不存在 = 空) */
async function noticeLogLines(f: RoFx): Promise<RsiLogLine[]> {
  const file = rsiFilePath(f, 'log.jsonl');
  if (!(await exists(file))) return [];
  return Buffer.from(await readBytes(file))
    .toString('utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => RsiLogLineSchema.parse(JSON.parse(l)))
    .filter((l) => l.trigger === 'notice');
}
const noticeLogCodes = async (f: RoFx): Promise<string[]> =>
  (await noticeLogLines(f)).map((l) => l.code);
const lockedBy = async (f: RoFx): Promise<NoticeDeps['lock']> => {
  await putRsiFile(
    f,
    'lock',
    JSON.stringify({ pid: 4242, started_at: NOW, nonce: '0123456789abcdef', kit_version: '0.0.0' }),
  );
  return { isAlive: () => true, now: () => new Date(NOW) };
};

const dataWrites = (r: Run, f: RoFx): string[] =>
  auditRel(f, r.audit).filter((p) => p !== 'rsi/lock');

async function world(
  prefix: string,
  runs: StagedSpec[] = [{ runId: 'r-1' }],
  o: Parameters<typeof makeA6World>[2] = {},
) {
  const f = await makeRoFx(prefix);
  const w = await makeA6World(f, runs, o);
  return { f, w };
}

describe('R20-17.13 两行提示、R20-17.14 先写后印与至多一次', () => {
  it('首次:先采集、后提案各一行(格式固定,无路径 / run_id / 提案正文);记账 notice.json(0600);再跑零输出零写入', async () => {
    const { f, w } = await world('a6-nt-once-');
    const r = await notice(f);
    expect(r.outcome.kind).toBe('printed');
    expect(r.err).toEqual([
      'RSI_COLLECTION_STARTED projects=1 excluded=0\n',
      'RSI_PROPOSALS_READY runs=1 proposals=1\n',
    ]);
    for (const l of r.err) expect(l).toMatch(LINE_RE);
    for (const l of r.err)
      for (const needle of [f.dir, 'r-1', PROJECT_NAME]) expect(l).not.toContain(needle);
    expect(await readNoticeDoc(f)).toEqual({
      schema_version: 1,
      proposals_notified: ['r-1'],
      collection_started_for: w.confirmedAt,
    });
    const again = await notice(f);
    expect([again.outcome.kind, again.err, again.audit]).toEqual(['nothing', [], []]);
    expect((await readNoticeDoc(f)).proposals_notified).toEqual(['r-1']);
  });

  it('新 run 出现 → 只出提案行(采集开始行不重复);baseline_pending = true → 没有采集开始行', async () => {
    const { f } = await world('a6-nt-new-');
    await notice(f);
    await putReport(f, 'r-2', 'ingest', 3);
    await seedStaged(f, ['r-1', 'r-2'], { 'r-2': 3 });
    const r = await notice(f);
    expect(r.err).toEqual(['RSI_PROPOSALS_READY runs=1 proposals=3\n']);

    const { f: g } = await world('a6-nt-baseline-', [{ runId: 'r-1' }], { baselinePending: true });
    const s = await notice(g);
    expect(s.err).toEqual(['RSI_PROPOSALS_READY runs=1 proposals=1\n']);
    expect((await readNoticeDoc(g)).collection_started_for).toBeNull();
  });

  it('重新 rsi confirm(确认时刻变了)→ 下一次再提示一次采集开始', async () => {
    const { f } = await world('a6-nt-reconfirm-');
    await notice(f);
    const c = await validConfirm(f);
    await seed(f, {
      state: baseState({
        confirm: { ...c, confirmed_at: '2026-10-25T00:00:00.000Z', baseline_pending: false },
        projects_ack_generation: 1,
      }),
    });
    const r = await notice(f);
    expect(r.err).toEqual(['RSI_COLLECTION_STARTED projects=1 excluded=0\n']);
    expect((await readNoticeDoc(f)).collection_started_for).toBe('2026-10-25T00:00:00.000Z');
    expect((await notice(f)).err).toEqual([]);
  });

  it('只计待通知 run:手动 --run-llm(mode=llm)、已忽略、已通知的都不提醒', async () => {
    const { f } = await world(
      'a6-nt-filter-',
      [{ runId: 'r-llm', mode: 'llm' }, { runId: 'r-dis' }, { runId: 'r-seen' }],
      { baselinePending: true },
    );
    await putRsiFile(
      f,
      'dismissed.json',
      JSON.stringify({ schema_version: 1, runs: [{ run_id: 'r-dis', at: NOW }] }),
    );
    await putRsiFile(f, 'notice.json', noticeDoc(['r-seen']));
    const r = await notice(f);
    expect([r.outcome.kind, r.err, r.audit]).toEqual(['nothing', [], []]);
  });

  it('先写后印:第一次 stderr 写入发生时 notice.json 已落盘且 rsi/lock 已释放', async () => {
    const { f } = await world('a6-nt-order-');
    const seen: { notice: boolean; lock: boolean }[] = [];
    const r = await notice(f, {
      stderr: (t) => {
        void t;
        seen.push({ notice: existsSync(noticeFile(f)), lock: existsSync(rsiFilePath(f, 'lock')) });
      },
    });
    expect(r.outcome.kind).toBe('printed');
    expect(seen).toEqual([
      { notice: true, lock: false },
      { notice: true, lock: false },
    ]);
  });

  it('写完后 stderr 写失败 → 漏提示但不重复:下一次不再提示(至多一次尝试展示)', async () => {
    const { f } = await world('a6-nt-atmost-');
    const r = await notice(f, {
      stderr: () => {
        throw new Error('EPIPE');
      },
    });
    expect(r.outcome.kind).toBe('skipped');
    expect((await readNoticeDoc(f)).proposals_notified).toEqual(['r-1']);
    expect((await notice(f)).err).toEqual([]);
  });
});

async function seedStaged(
  f: RoFx,
  runs: string[],
  proposals: Record<string, number> = {},
): Promise<void> {
  const proj = await mkProject(f, PROJECT_NAME);
  await seed(f, {
    index: indexOf([{ key: key(1), path: proj.path, dev: proj.dev, ino: proj.ino }]),
    counts: countsOf(
      { [key(1)]: { total: 3 } },
      {
        staged: runs.map((run_id) => ({
          run_id,
          proposals: proposals[run_id] ?? 1,
          evidence_keys: [key(1)],
          tainted: false,
        })),
      },
    ),
  });
}

describe('R20-17.12 触发条件:不满足 → 零读 reflect/、零写入、不拿锁', () => {
  const cases: [string, (f: RoFx) => Promise<Parameters<typeof notice>[1]>, string][] = [
    ['非 TTY', async () => ({ isTty: false }), 'not_tty'],
    ['KIT_AUTO_RSI=0', async () => ({ env: { KIT_AUTO_RSI: '0' } }), 'auto_skip'],
    ['CI=true', async () => ({ env: { CI: 'true' } }), 'auto_skip'],
    ['KIT_RSI_CHILD=1', async () => ({ env: { KIT_RSI_CHILD: '1' } }), 'auto_skip'],
    ['rsi poke', async () => ({ argv: ['rsi', 'poke', '--agent', 'claude'] }), 'hook_command'],
    ['rsi hint', async () => ({ argv: ['--root', '/x', 'rsi', 'hint'] }), 'hook_command'],
    ['__rsi 钩子入口', async () => ({ argv: ['__rsi', '--background'] }), 'hook_command'],
    [
      'stopped',
      async (f) => (
        await putRsiFile(f, 'STOP', '{"at":"2026-10-24T00:00:00.000Z","by":"user"}'),
        {}
      ),
      'not_eligible',
    ],
    [
      'purge journal 在场',
      async (f) => (await putRsiFile(f, 'purge-journal.json', '{}'), {}),
      'not_eligible',
    ],
    [
      'collect block(exclude_invalid)',
      async (f) => (await setExtra(f, 'exclude_dirs = ["relative/dir"]\n'), {}),
      'not_eligible',
    ],
  ];
  for (const [name, prep, why] of cases) {
    it(`${name}`, async () => {
      const { f } = await world('a6-nt-skip-');
      const o = await prep(f);
      const before = await readdirTree(f);
      const r = await notice(f, o);
      expect(r.outcome, name).toEqual({ kind: 'skipped', why });
      expect([r.err, r.audit, r.reads], name).toEqual([[], [], 0]);
      expect(await readdirTree(f)).toEqual(before);
    });
  }

  it('armed(无确认记录)一律不提醒', async () => {
    const f = await makeRoFx('a6-nt-armed-');
    await makeA6World(f, [{ runId: 'r-1' }], { confirm: false });
    const r = await notice(f);
    expect([r.outcome, r.err, r.audit, r.reads]).toEqual([
      { kind: 'skipped', why: 'not_eligible' },
      [],
      [],
      0,
    ]);
  });

  it('正向对照:同一个世界、条件齐备时确实提醒(上面的「零读」不是因为世界本来就没东西)', async () => {
    const { f } = await world('a6-nt-control-');
    const r = await notice(f);
    expect([r.outcome.kind, r.reads]).toEqual(['printed', 2]); // 锁外一次、锁内一次
  });

  it('isHookCommand:精确识别钩子形状(跳过带值的全局选项),普通命令与 rsi status 不是', () => {
    expect(isHookCommand(['rsi', 'poke'])).toBe(true);
    expect(isHookCommand(['--overlay', 'x', 'rsi', 'hint'])).toBe(true);
    expect(isHookCommand(['__rsi'])).toBe(true);
    for (const a of [['rsi', 'status'], ['rsi'], ['build'], [], ['--root', 'rsi', 'status']]) {
      expect(isHookCommand(a), a.join(' ')).toBe(false);
    }
  });
});

async function readdirTree(f: RoFx): Promise<string[]> {
  return treeOf(f.dir);
}

describe('R20-17.14 锁与损坏', () => {
  it('锁被占(另一个存活进程)→ 不提示、不记账;放锁后恢复', async () => {
    const { f } = await world('a6-nt-locked-');
    const lockDoc = JSON.stringify({
      pid: 4242,
      started_at: NOW,
      nonce: '0123456789abcdef',
      kit_version: '0.0.0',
    });
    await putRsiFile(f, 'lock', lockDoc);
    const lock = { isAlive: () => true, now: () => new Date(NOW) };
    const r = await notice(f, { deps: { lock } });
    expect(r.outcome).toEqual({ kind: 'not_recorded', why: 'locked' });
    expect(r.err).toEqual([]);
    expect(await exists(noticeFile(f))).toBe(false);
    // 试锁失败不记账、不删除别人的锁;唯一的写入是 A6 订正 #1 的一行放弃日志(无锁追加)
    expect(
      r.audit
        .filter((a) => a.op !== 'mkdirp')
        .map((a) => `${a.op} ${path.relative(f.io.stateDir, a.path)}`)
        .filter((o) => !o.endsWith(' rsi/lock')), // 试锁本身(createExclusive 失败)不算数据写入
    ).toEqual(['appendFile rsi/log.jsonl']);
    expect(await noticeLogCodes(f)).toEqual(['locked']);
    await remove(f.io, rsiFilePath(f, 'lock'));
    expect((await notice(f)).err).toHaveLength(2);
  });

  it('notice.json 损坏(schema / JSON / 权限)→ 不覆盖、不重建、不提醒;status 报 notice_invalid', async () => {
    for (const [name, text, mode] of [
      [
        'schema',
        '{"schema_version":1,"proposals_notified":"x","collection_started_for":null}',
        0o600,
      ],
      ['json', '{{', 0o600],
      ['perm', noticeDoc([]), 0o644],
    ] as const) {
      const { f } = await world(`a6-nt-bad-${name}-`);
      await putRsiFile(f, 'notice.json', text, mode);
      const bytes = Buffer.from(await readBytes(noticeFile(f)));
      const r = await notice(f);
      expect([r.outcome.kind, r.err, r.audit], name).toEqual(['skipped', [], []]);
      expect(Buffer.from(await readBytes(noticeFile(f))).equals(bytes), name).toBe(true);
      const st = JSON.parse(
        (await runDirect(f, runStatus, ['--json'], { now: () => new Date(NOW) })).out,
      ) as StatusDoc;
      expect(st.warnings, name).toContain('notice_invalid');
    }
  });
});

describe('R20-17.14a notice_full(默认扫描上限下不可达,用放宽上限的测试缝构造三种情形)', () => {
  const many = (n: number): string[] =>
    Array.from({ length: n }, (_, i) => `d-${String(i).padStart(4, '0')}`);
  async function fullWorld(prefix: string, existing: number, notified: string[], started: boolean) {
    const { f, w } = await world(prefix, [{ runId: 'r-new' }]);
    for (const id of many(existing))
      await mkdirp(f.io, path.join(f.io.stateDir, 'reflect', id), 0o755);
    await putRsiFile(f, 'notice.json', noticeDoc(notified, started ? w.confirmedAt : null));
    return f;
  }
  const lim = { scanLimits: { maxEntries: 5000 } };

  it('原文件 1500 条但仍存在的只有 300 个、有 1 个新增 → 不是 full:提示发出,记账清理成「仍存在 ∪ 新增」', async () => {
    const f = await fullWorld('a6-nt-full-a-', 300, [...many(1500)], true);
    const r = await notice(f, { deps: lim });
    expect(r.err).toEqual(['RSI_PROPOSALS_READY runs=1 proposals=1\n']);
    expect((await readNoticeDoc(f)).proposals_notified).toEqual([...many(300), 'r-new'].sort());
  });

  it('恰好 1000 条仍存在且无新增 → 不是 full、也无事可报:零输出零写入', async () => {
    const f = await fullWorld('a6-nt-full-b-', 1000, many(1000), true);
    // 已通知 = 999 个旧目录 + r-new,共 1000 条且目录都在;没有新增、采集开始也已记过
    await putRsiFile(
      f,
      'notice.json',
      noticeDoc([...many(999), 'r-new'], (await readNoticeDoc(f)).collection_started_for),
      0o600,
    );
    const before = Buffer.from(await readBytes(noticeFile(f)));
    const r = await notice(f, { deps: lim });
    expect([r.outcome.kind, r.err, r.audit]).toEqual(['nothing', [], []]);
    expect(Buffer.from(await readBytes(noticeFile(f))).equals(before)).toBe(true);
  }, 120_000);

  it('1000 条仍存在 + 1 个新增 → full:提案提示不发、不新增任何 run_id;采集开始提示不受影响,仍先记账后打印', async () => {
    const f = await fullWorld('a6-nt-full-c-', 1000, many(1000), false);
    const r = await notice(f, { deps: lim });
    expect(r.err).toEqual(['RSI_COLLECTION_STARTED projects=1 excluded=0\n']);
    const d = await readNoticeDoc(f);
    expect(d.proposals_notified).toEqual(many(1000)); // 只清理(这里没有可清理的),没有新增
    expect(d.proposals_notified).not.toContain('r-new');
    expect(d.collection_started_for).not.toBeNull();
  }, 120_000);
});

describe('R20-17.15 预算:一个截止时间贯穿锁前 / 锁内 / 每个写点;超时后零写入', () => {
  async function timed(checkpoint: string, extra: Partial<NoticeDeps> = {}) {
    const { f } = await world(`a6-nt-time-${checkpoint.replace(/\W/g, '')}-`);
    let t = 0;
    const r = await notice(f, {
      deps: {
        clockMs: () => t,
        point: (n) => {
          if (n === checkpoint) t += 1000;
        },
        ...extra,
      },
    });
    return { f, r };
  }

  it('入口之后立刻超时:不读 reflect/、不拿锁、零写入、无输出', async () => {
    const { f, r } = await timed('first_eval');
    expect([r.outcome.kind, r.err, r.audit, r.reads]).toEqual(['skipped', [], [], 0]);
    expect(await exists(noticeFile(f))).toBe(false);
  });

  it('拿到锁之后超时:不重算、不写 notice.json;只有锁文件的创建与释放(释放自己的锁不算记账写入)', async () => {
    const { f, r } = await timed('locked');
    expect(r.outcome).toEqual({ kind: 'not_recorded', why: 'over_budget' });
    expect(r.err).toEqual([]);
    // 零记账写入;唯一例外是放锁之后的一行放弃日志(A6 订正 #1 ②)
    expect(dataWrites(r, f)).toEqual(['rsi/log.jsonl']);
    expect(await noticeLogCodes(f)).toEqual(['over_budget']);
    expect(await exists(noticeFile(f))).toBe(false);
    expect(await exists(rsiFilePath(f, 'lock'))).toBe(false); // 锁已释放
  });

  it('锁内重算之后、首个写点之前超时:零记账写入(没有 notice.json 也没有 .tmp),无输出', async () => {
    const { f, r } = await timed('second_eval');
    expect(r.outcome).toEqual({ kind: 'not_recorded', why: 'over_budget' });
    expect(r.err).toEqual([]);
    expect(dataWrites(r, f).filter((p) => p.startsWith('rsi/notice'))).toEqual([]);
    expect(await exists(noticeFile(f))).toBe(false);
  });

  it('assertHeld 之后、tmp 创建之前 / rename 之前超时:不创建 tmp / 不 rename,无输出,notice.json 不产生', async () => {
    for (const stepName of ['before:tmp-write:notice.json', 'before:rename:notice.json']) {
      let t = 0;
      const { f } = await world(`a6-nt-step-${stepName.length}-`);
      const r = await notice(f, {
        deps: {
          clockMs: () => t,
          hooks: {
            point: async (n) => {
              if (n === stepName) t += 1000;
            },
          },
        },
      });
      expect(r.outcome, stepName).toEqual({ kind: 'not_recorded', why: 'over_budget' });
      expect(r.err, stepName).toEqual([]);
      expect(await exists(noticeFile(f)), stepName).toBe(false);
      const ops = r.audit.map((a) => `${a.op} ${path.relative(f.io.stateDir, a.path)}`);
      if (stepName.includes('tmp-write')) {
        expect(
          ops.some((o) => o.startsWith('createExclusive rsi/notice.json')),
          stepName,
        ).toBe(false);
      }
      expect(
        ops.some((o) => o.startsWith('rename')),
        stepName,
      ).toBe(false);
    }
  });

  it('正向对照:预算内同样的世界会落盘并打印', async () => {
    const { f, r } = await timed('never-fires');
    expect(r.outcome.kind).toBe('printed');
    expect(await exists(noticeFile(f))).toBe(true);
  });
});

describe('A6 订正 #1:提醒放弃时写一行 log.jsonl(去重、只读校验、跳过分支不写)', () => {
  it('行形状:{at, trigger:notice, action:skipped, code},过 RsiLogLineSchema;不含路径 / run_id / 项目名', async () => {
    const { f } = await world('a6-nt-log-shape-');
    await notice(f, { deps: { lock: await lockedBy(f) } });
    const lines = await noticeLogLines(f);
    expect(lines).toEqual([{ at: NOW, trigger: 'notice', action: 'skipped', code: 'locked' }]);
    const raw = Buffer.from(await readBytes(rsiFilePath(f, 'log.jsonl'))).toString('utf8');
    for (const needle of [f.dir, 'r-1', PROJECT_NAME]) expect(raw).not.toContain(needle);
  });

  it('去重:30 分钟内同码只记一行;过了窗口再记;不同码各记一行', async () => {
    const { f } = await world('a6-nt-log-dedup-');
    const lock = await lockedBy(f);
    const at = (min: number) => () => new Date(Date.parse(NOW) + min * 60_000);
    await notice(f, { deps: { lock, now: at(0) } });
    await notice(f, { deps: { lock, now: at(10) } });
    await notice(f, { deps: { lock, now: at(29) } });
    expect(await noticeLogCodes(f)).toEqual(['locked']);
    await notice(f, { deps: { lock, now: at(31) } });
    expect(await noticeLogCodes(f)).toEqual(['locked', 'locked']);
    // 换一个码(锁放开、拿锁后超时):与 locked 互不去重
    await remove(f.io, rsiFilePath(f, 'lock'));
    let t = 0;
    await notice(f, {
      deps: { now: at(32), clockMs: () => t, point: (n) => void (n === 'locked' && (t += 1000)) },
    });
    expect(await noticeLogCodes(f)).toEqual(['locked', 'locked', 'over_budget']);
  });

  it('写入失败(notice.json 位置被目录占住)→ code=write_failed', async () => {
    const { f } = await world('a6-nt-log-wf-');
    const r = await notice(f, {
      deps: {
        hooks: {
          point: async (n) => {
            if (n === 'before:rename:notice.json') throw new Error('injected');
          },
        },
      },
    });
    expect(r.outcome).toEqual({ kind: 'not_recorded', why: 'write_failed' });
    expect(await noticeLogCodes(f)).toEqual(['write_failed']);
  });

  it('跳过分支与「没有要说的」不写日志(不建 log.jsonl):非 TTY、KIT_AUTO_RSI=0、钩子命令、armed、notice.json 损坏、已提醒过', async () => {
    const cases: [string, (f: RoFx) => Promise<Parameters<typeof notice>[1]>][] = [
      ['非 TTY', async () => ({ isTty: false })],
      ['KIT_AUTO_RSI=0', async () => ({ env: { KIT_AUTO_RSI: '0' } })],
      ['钩子命令', async () => ({ argv: ['rsi', 'hint'] })],
      ['notice.json 损坏', async (f) => (await putRsiFile(f, 'notice.json', '{'), {})],
    ];
    for (const [name, prep] of cases) {
      const { f } = await world(`a6-nt-log-skip-${cases.findIndex((c) => c[0] === name)}-`);
      const o = await prep(f);
      const r = await notice(f, o);
      expect(r.outcome.kind, name).toBe('skipped');
      expect(
        r.audit.some((a) => a.path.endsWith('log.jsonl')),
        name,
      ).toBe(false);
      expect(await noticeLogCodes(f), name).toEqual([]);
    }
    const g = await makeRoFx('a6-nt-log-armed-');
    await makeA6World(g, [{ runId: 'r-1' }], { confirm: false });
    const ra = await notice(g);
    expect(ra.audit.some((a) => a.path.endsWith('log.jsonl'))).toBe(false);
    const { f: h } = await world('a6-nt-log-nothing-');
    expect((await notice(h)).outcome.kind).toBe('printed');
    const again = await notice(h);
    expect(again.outcome.kind).toBe('nothing');
    expect(again.audit).toEqual([]);
    expect(await noticeLogCodes(h)).toEqual([]);
  });

  it('只读校验:rsi/ 不存在不建、不写;log.jsonl 是符号链接 / 权限过宽 → 不写;正向对照:合规时写', async () => {
    const f0 = await makeRoFx('a6-nt-log-nodir-');
    await logNoticeGiveUp(f0.io, 'locked', new Date(NOW));
    expect(existsSync(path.join(f0.io.stateDir, 'rsi'))).toBe(false);

    const { f } = await world('a6-nt-log-link-');
    const target = path.join(f.dir, 'elsewhere.log');
    await writeFile(f.fx, target, '', { mode: 0o600 });
    const log = rsiFilePath(f, 'log.jsonl');
    if (await exists(log)) await remove(f.io, log);
    await symlink(f.fx, target, log);
    await logNoticeGiveUp(f.io, 'locked', new Date(NOW));
    expect(Buffer.from(await readBytes(target)).toString('utf8')).toBe('');

    const { f: g } = await world('a6-nt-log-perm-');
    const glog = rsiFilePath(g, 'log.jsonl');
    await writeFile(g.io, glog, '', { mode: 0o600 });
    await chmod(g.io, glog, 0o644);
    await logNoticeGiveUp(g.io, 'locked', new Date(NOW));
    expect(await noticeLogCodes(g)).toEqual([]);
    await chmod(g.io, glog, 0o600);
    await logNoticeGiveUp(g.io, 'locked', new Date(NOW));
    expect(await noticeLogCodes(g)).toEqual(['locked']);
  });

  it('日志写失败(log.jsonl 只读)不改变提醒结果、不抛、不输出', async () => {
    const { f } = await world('a6-nt-log-ro-');
    const log = rsiFilePath(f, 'log.jsonl');
    if (!(await exists(log))) await writeFile(f.io, log, '', { mode: 0o600 });
    await chmod(f.io, log, 0o400);
    const r = await notice(f, { deps: { lock: await lockedBy(f) } });
    expect(r.outcome).toEqual({ kind: 'not_recorded', why: 'locked' });
    expect(r.err).toEqual([]);
    await chmod(f.io, log, 0o600);
    expect(await noticeLogCodes(f)).toEqual([]);
  });
});

describe('隔离异常', () => {
  it('配置读取 / 上下文构造抛错:不抛、不输出、零写入', async () => {
    const { f } = await world('a6-nt-iso-');
    const r = await notice(f, {
      deps: {
        open: {
          createContext: () => {
            throw new Error('boom');
          },
        },
      },
    });
    expect([r.outcome.kind, r.err, r.audit]).toEqual(['skipped', [], []]);
  });

  it('配置 off(从未配置)→ skipped,零读零写', async () => {
    const f = await makeRoFx('a6-nt-off-');
    await writeFile(f.fx, f.cfgFile, '[rsi]\nenabled = false\n', { mode: 0o600 });
    const r = await notice(f);
    expect([r.outcome, r.err, r.audit, r.reads]).toEqual([
      { kind: 'skipped', why: 'config' },
      [],
      [],
      0,
    ]);
  });
});
