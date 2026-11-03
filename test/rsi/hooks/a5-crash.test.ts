/**
 * A5(contracts §20.15-6 / §20.15-7):事务的崩溃 / 失锁 / 交错矩阵。
 *
 * - 「新进程」= 再跑一次命令(每次命令都新建 HooksFs / 引擎状态;模拟崩溃用注入点抛 Crash,模拟失锁用「前 n 次 assertHeld 通过」的锁句柄)。
 * - 失锁循环:对事务的**每一个写步骤**依次让锁在该步骤之前失效,断言:退 3 `lock_lost`、之后零后继写步骤(trace 长度恰为 n)、写入承诺等级与实际阶段一致,
 *   并且下一次正常运行必然收敛到完整、一致的状态(目标、账本、无 journal、无 tmp 残留)。
 * - 写入承诺等级(R20-15.24a)按执行阶段逐分支断言,不只看最终树。fsync 顺序用计数桩证明(真实掉电不在验收范围,如实登记)。
 */
import { describe, expect, it } from 'vitest';
import { acquireLock, ApplyError, type LockHandle } from '../../../src/sync/apply.js';
import type { HooksDeps } from '../../../src/rsi/hooks/command.js';
import {
  STATE_REL,
  canon,
  jsonOf,
  lstat,
  makeHx,
  userSettings,
  type Hx,
  type R,
} from './a5-fixture.js';

const SS = {
  matcher: 'startup',
  hooks: [
    {
      type: 'command',
      command: 'agent-kit rsi hint --agent claude --format claude-json',
      timeout: 5,
    },
  ],
};
const SE = {
  hooks: [{ type: 'command', command: 'agent-kit rsi poke --agent claude', timeout: 5 }],
};
const FRESH_DOC = { hooks: { SessionEnd: [SE], SessionStart: [SS] } };

const lastLine = (t: string): string => t.trimEnd().split('\n').pop() as string;

/** 前 n 次 assertHeld 通过,第 n+1 次起失锁(真实锁照常获取与释放) */
function lockAfter(n: number): NonNullable<HooksDeps['acquireLock']> {
  return async (aenv): Promise<LockHandle> => {
    const real = await acquireLock(aenv);
    let calls = 0;
    return {
      assertHeld: async (): Promise<void> => {
        if (calls++ >= n) throw new Error('lost');
        await real.assertHeld();
      },
      release: () => real.release(),
    };
  };
}

async function claudeHx(prefix: string, settings?: string): Promise<Hx> {
  const hx = await makeHx(prefix);
  await hx.agentRoot('claude');
  if (settings !== undefined) await hx.put('.claude/settings.json', settings, 0o644);
  return hx;
}

const INSTALL = ['--install', '--agent', 'claude', '--json'];
const UNINSTALL = ['--uninstall', '--agent', 'claude', '--json'];

/** 收敛后的一致性:无 journal、txn/ 里无 tmp、目标目录无 tmp、账本与标记同在 */
async function expectConsistent(hx: Hx, label: string): Promise<void> {
  expect(await hx.journals(), `${label}: journals`).toEqual([]);
  expect(await hx.names(`${STATE_REL}/txn`), `${label}: txn/`).toEqual([]);
  expect(await hx.names('.claude'), `${label}: .claude`).toEqual(['settings.json']);
  expect(await hx.has(`${STATE_REL}/ledger.json.tmp`), `${label}: ledger tmp`).toBe(false);
  expect(await hx.has(`${STATE_REL}/ledger.json`), `${label}: ledger`).toBe(true);
  expect(await hx.has(`${STATE_REL}/ledger.established`), `${label}: marker`).toBe(true);
}

describe('失锁循环:每个写步骤之前失锁 → lock_lost、零后继写、等级正确、下一次运行收敛', () => {
  const scenarios: [string, string | undefined][] = [
    ['新建(文件不存在)', undefined],
    ['合并(已有用户配置 + 备份)', userSettings()],
  ];
  for (const [name, settings] of scenarios) {
    it(`安装:${name}`, async () => {
      const base = await claudeHx('a5-lockloop-base-', settings);
      const baseline = await base.write(INSTALL);
      expect(baseline.code, baseline.err).toBe(0);
      const T = baseline.trace.length;
      const J = baseline.trace.findIndex((e) => e.startsWith('rename:state/txn/'));
      const R_ = baseline.trace.indexOf('rename:target/claude');
      expect(T).toBeGreaterThan(25);
      expect(J).toBeGreaterThan(0);
      expect(R_).toBeGreaterThan(J);
      const expectedDoc = JSON.parse(await base.read('.claude/settings.json')) as unknown;

      for (let n = 0; n < T; n++) {
        const hx = await claudeHx('a5-lockloop-', settings);
        const r = await hx.write(INSTALL, { deps: { acquireLock: lockAfter(n) } });
        const tag = `${name} n=${n}/${T}`;
        expect(r.code, `${tag}: ${r.err}`).toBe(3);
        expect(lastLine(r.err), tag).toBe('RSI_FAIL_CLOSED reason=lock_lost');
        // 失锁后不再有任何写步骤:被放行的 n 次检查恰好对应 trace 里的 n 个步骤
        expect(r.trace.length, tag).toBe(n);
        const level =
          n <= J ? 'lock_only' : n <= R_ ? 'target_unwritten' : 'target_written_pending';
        expect(jsonOf(r), tag).toMatchObject({ result: 'fail_closed', write_level: level });
        if (n <= R_) {
          // 目标要么没动,要么(n == R_ 以内)保持写前内容
          expect(await hx.has('.claude/settings.json'), tag).toBe(settings !== undefined);
        }
        // 下一次正常运行收敛
        const again = await hx.write(INSTALL);
        expect(again.code, `${tag}: recover: ${again.err}`).toBe(0);
        expect(JSON.parse(await hx.read('.claude/settings.json')), tag).toEqual(expectedDoc);
        await expectConsistent(hx, tag);
        const ledger = (await hx.ledger()) as { entries: unknown[] };
        expect(ledger.entries, tag).toHaveLength(2);
        const third = await hx.write(INSTALL);
        expect(jsonOf(third), tag).toMatchObject({ result: 'unchanged' });
        hx.assertAuditInside();
      }
    }, 120_000);
  }

  it('卸载:同样的矩阵,收敛后账本归属为空、目标里没有 kit 节点', async () => {
    const mk = async (): Promise<Hx> => {
      const hx = await claudeHx('a5-lockloop-un-', userSettings());
      expect((await hx.write(INSTALL)).code).toBe(0);
      return hx;
    };
    const base = await mk();
    const baseline = await base.write(UNINSTALL);
    expect(baseline.code, baseline.err).toBe(0);
    const T = baseline.trace.length;
    const expectedDoc = JSON.parse(await base.read('.claude/settings.json')) as unknown;
    for (let n = 0; n < T; n++) {
      const hx = await mk();
      const r = await hx.write(UNINSTALL, { deps: { acquireLock: lockAfter(n) } });
      expect(r.code, `n=${n}: ${r.err}`).toBe(3);
      expect(r.trace.length).toBe(n);
      const again = await hx.write(UNINSTALL);
      expect(again.code, `n=${n}: ${again.err}`).toBe(0);
      expect(JSON.parse(await hx.read('.claude/settings.json')), `n=${n}`).toEqual(expectedDoc);
      expect(((await hx.ledger()) as { entries: unknown[] }).entries, `n=${n}`).toEqual([]);
      expect(await hx.journals(), `n=${n}`).toEqual([]);
      expect(await hx.names('.claude'), `n=${n}`).toEqual(['settings.json']);
    }
  }, 120_000);
});

describe('崩溃注入点:每个提交点崩溃后,新进程的恢复有确定出口', () => {
  const points: [string, 'target_unwritten' | 'target_written_pending' | 'committed'][] = [
    ['journal_written', 'target_unwritten'],
    ['backup_written', 'target_unwritten'],
    ['target_before_write', 'target_unwritten'],
    ['target_renamed', 'target_written_pending'],
    ['ledger_marker_created', 'target_written_pending'],
    ['ledger_committed', 'target_written_pending'],
    ['journal_deleted', 'committed'],
  ];
  for (const [point, level] of points) {
    it(`崩溃于 ${point} → 写入承诺 ${level};恢复后收敛、幂等`, async () => {
      const hx = await claudeHx('a5-crashpt-', userSettings());
      const r = await hx.write(INSTALL, { crashAt: point });
      expect(r.crashed).toBe(true);
      expect(r.code).toBe(3);
      expect(jsonOf(r)).toMatchObject({ write_level: level });
      if (point !== 'journal_deleted') expect(await hx.journals()).toHaveLength(1);
      const again = await hx.write(INSTALL);
      expect(again.code, again.err).toBe(0);
      await expectConsistent(hx, point);
      const doc = JSON.parse(await hx.read('.claude/settings.json')) as {
        hooks: Record<string, unknown>;
      };
      expect(doc.hooks['SessionStart']).toEqual([SS]);
      expect(doc.hooks['SessionEnd']).toEqual([SE]);
      expect(((await hx.ledger()) as { entries: unknown[] }).entries).toHaveLength(2);
    });
  }

  it('账本已提交、journal 未删(崩溃于 ledger_committed)→ 恢复时先 ensureLedgerDurable(fsync 账本文件与目录)再删 journal;不重写账本', async () => {
    const hx = await claudeHx('a5-durable-', userSettings());
    await hx.write(INSTALL, { crashAt: 'ledger_committed' });
    const gen = ((await hx.ledger()) as { generation: number }).generation;
    expect(gen).toBe(1);
    const r = await hx.write(INSTALL);
    expect(r.code, r.err).toBe(0);
    expect(r.trace.some((e) => e.startsWith('rename:state/ledger.json'))).toBe(false);
    const durable = r.trace.indexOf('fsync-file:state/ledger.json');
    const unlink = r.trace.findIndex((e) => e.startsWith('unlink:state/txn/'));
    expect(durable).toBeGreaterThanOrEqual(0);
    expect(durable).toBeLessThan(unlink);
    expect(r.trace[durable + 1]).toBe('fsync-dir:state');
    // 同一 txn_id 的账本记录只生效一次(generation 不再增长)
    expect(((await hx.ledger()) as { generation: number }).generation).toBe(gen);
  });

  it('残留的 journal tmp / 账本 tmp / 目标 tmp 都有出口:恢复时按 txn_id 与固定名字清理', async () => {
    // 在 create-tmp 之后、rename 之前失锁:journal tmp、目标 tmp、账本 tmp 各留一份
    const base = await claudeHx('a5-tmp-base-', userSettings());
    const baseline = await base.write(INSTALL);
    const tmpSteps = baseline.trace
      .map((e, i) => (e.startsWith('write-tmp:') ? i : -1))
      .filter((i) => i >= 0);
    expect(tmpSteps).toHaveLength(4); // journal、备份、目标、账本
    for (const i of tmpSteps) {
      const h = await claudeHx('a5-tmp-', userSettings());
      const r = await h.write(INSTALL, { deps: { acquireLock: lockAfter(i + 2) } }); // 写完 + fsync 之后、rename 之前
      expect(r.code).toBe(3);
      const rec = await h.write(INSTALL);
      expect(rec.code, `tmp@${i}: ${rec.err}`).toBe(0);
      await expectConsistent(h, `tmp@${i}`);
      // 备份目录里的 tmp 也不留
      for (const b of await h.backups()) {
        for (const n of await h.names(`${STATE_REL}/backups/${b}`))
          expect(n.endsWith('.tmp')).toBe(false);
      }
    }
  });
});

describe('首次建账本(bootstrap)窗口:标记 ledger.established × 账本 × journal 状态 × 目标', () => {
  /** 造出「标记在、账本缺、journal 进行中、目标 = after」 */
  async function bootstrapCrash(): Promise<{ hx: Hx; id: string }> {
    const hx = await claudeHx('a5-boot-');
    const r = await hx.write(INSTALL, { crashAt: 'ledger_marker_created' });
    expect(r.crashed).toBe(true);
    const ids = await hx.journals();
    expect(ids).toHaveLength(1);
    expect(await hx.has(`${STATE_REL}/ledger.established`)).toBe(true);
    expect(await hx.has(`${STATE_REL}/ledger.json`)).toBe(false);
    return { hx, id: ids[0] as string };
  }
  const journalPath = (id: string): string => `${STATE_REL}/txn/${id}.json`;
  const PRUNE = ['--prune-backups'];

  it('进行中 + 目标 = after → 提交 journal 里的账本变更,删 journal', async () => {
    const { hx, id } = await bootstrapCrash();
    const r = await hx.write(INSTALL);
    expect(r.code, r.err).toBe(0);
    const ledger = (await hx.ledger()) as {
      generation: number;
      entries: unknown[];
      applied_txns: { txn_id: string }[];
    };
    expect(ledger.generation).toBe(1);
    expect(ledger.entries).toHaveLength(2);
    expect(ledger.applied_txns.map((t) => t.txn_id)).toContain(id);
    await expectConsistent(hx, 'after');
  });

  it('进行中 + 目标 = before → 先改记 aborted,再提交只记 aborted 的空账本,然后才删 journal;之后正常安装', async () => {
    const { hx, id } = await bootstrapCrash();
    await hx.rm('.claude/settings.json'); // 目标回到写前(不存在)
    const r = await hx.write(INSTALL);
    expect(r.code, r.err).toBe(0);
    const ledger = (await hx.ledger()) as { generation: number; entries: unknown[] };
    expect(ledger.generation).toBe(1);
    expect(ledger.entries).toHaveLength(2);
    expect(await hx.journals()).toEqual([]);
    expect(await hx.has(journalPath(id))).toBe(false);
    await expectConsistent(hx, 'before');
  });

  it('改记 aborted 之后、空账本提交之前再次崩溃 → 再下一次恢复照常:空账本只记 aborted(无归属、generation 不动)', async () => {
    const { hx, id } = await bootstrapCrash();
    await hx.rm('.claude/settings.json');
    const crash = await hx.write(PRUNE, { crashAt: 'residue:journal_aborted' });
    expect(crash.crashed).toBe(true);
    const j = JSON.parse(await hx.read(journalPath(id))) as {
      state: string;
      bootstraps_ledger: boolean;
    };
    expect(j).toMatchObject({ state: 'aborted', bootstraps_ledger: true });
    expect(await hx.has(`${STATE_REL}/ledger.json`)).toBe(false);
    const r = await hx.write([...PRUNE, '--json']);
    expect(r.code, r.err).toBe(0);
    const ledger = (await hx.ledger()) as {
      generation: number;
      entries: unknown[];
      applied_txns: { txn_id: string; status: string }[];
    };
    expect(ledger.generation).toBe(0);
    expect(ledger.entries).toEqual([]);
    expect(ledger.applied_txns).toEqual([
      expect.objectContaining({ txn_id: id, status: 'aborted' }),
    ]);
    expect(await hx.journals()).toEqual([]);
  });

  it('进行中 + 目标是第三种值 → 退 4 txn_residue_unknown,不建账本、不动目标,journal 原样保留(等级 lock_only)', async () => {
    const { hx, id } = await bootstrapCrash();
    const third = canon({ somebody: 'else' });
    await hx.put('.claude/settings.json', third);
    const journalBefore = await hx.read(journalPath(id));
    const r = await hx.write(INSTALL);
    expect(r.code).toBe(4);
    expect(lastLine(r.err)).toBe('RSI_HOOKS_NOT_RUN reason=txn_residue_unknown');
    expect(jsonOf(r)).toMatchObject({ write_level: 'lock_only', result: 'not_run' });
    expect(await hx.read('.claude/settings.json')).toBe(third);
    expect(await hx.read(journalPath(id))).toBe(journalBefore);
    expect(await hx.has(`${STATE_REL}/ledger.json`)).toBe(false);
    // 唯一出口:--discard-residue
    const d = await hx.write(['--discard-residue', id, '--agent', 'claude', '--json']);
    expect(d.code, d.err).toBe(0);
    expect(jsonOf(d)).toMatchObject({
      result: 'maintenance_done',
      maintenance: 'done',
      maintenance_kind: 'discard',
      write_level: null,
    });
    const ledger = (await hx.ledger()) as {
      generation: number;
      entries: unknown[];
      applied_txns: { txn_id: string; status: string }[];
    };
    expect(ledger.generation).toBe(1);
    expect(ledger.entries).toEqual([]);
    expect(ledger.applied_txns).toEqual([
      expect.objectContaining({ txn_id: id, status: 'discarded' }),
    ]);
    expect(await hx.journals()).toEqual([]);
    expect(await hx.read('.claude/settings.json')).toBe(third);
    // 此后该事务的 --restore 不可用
    const rs = await hx.run(['--restore', id, '--agent', 'claude']);
    expect(rs.err).toBe('RSI_HOOKS_NOT_RUN reason=restore_not_latest\n');
  });

  it('discarding(--discard-residue 在 journal 改记后崩溃)→ 下一次任何 --write 补完:只提交 discarded 记录,不提交原计划归属', async () => {
    const { hx, id } = await bootstrapCrash();
    await hx.put('.claude/settings.json', canon({ somebody: 'else' }));
    const crash = await hx.write(['--discard-residue', id, '--agent', 'claude', '--json'], {
      crashAt: 'discard:journal_discarding',
    });
    expect(crash.crashed).toBe(true);
    expect(jsonOf(crash)).toMatchObject({
      maintenance: 'partial',
      maintenance_kind: 'discard',
      write_level: null,
    });
    expect(JSON.parse(await hx.read(journalPath(id)))).toMatchObject({ state: 'discarding' });
    expect(await hx.has(`${STATE_REL}/ledger.json`)).toBe(false);
    const r = await hx.write(PRUNE);
    expect(r.code, r.err).toBe(0);
    const ledger = (await hx.ledger()) as {
      generation: number;
      entries: unknown[];
      applied_txns: { status: string }[];
    };
    expect(ledger.entries).toEqual([]); // 原计划的两条归属没有生效
    expect(ledger.generation).toBe(1);
    expect(ledger.applied_txns.map((t) => t.status)).toEqual(['discarded']);
    expect(await hx.journals()).toEqual([]);
  });

  it('aborted 的 bootstrap journal(标记在、账本缺)→ 提交只记 aborted 的空账本,再删 journal', async () => {
    const { hx, id } = await bootstrapCrash();
    const j = JSON.parse(await hx.read(journalPath(id))) as Record<string, unknown>;
    await hx.put(journalPath(id), canon({ ...j, state: 'aborted' }), 0o600);
    const r = await hx.write(PRUNE);
    expect(r.code, r.err).toBe(0);
    const ledger = (await hx.ledger()) as {
      generation: number;
      entries: unknown[];
      applied_txns: { status: string }[];
    };
    expect(ledger.generation).toBe(0);
    expect(ledger.entries).toEqual([]);
    expect(ledger.applied_txns.map((t) => t.status)).toEqual(['aborted']);
    expect(await hx.journals()).toEqual([]);
  });

  it('账本「从未建立」(无标记):aborted / 目标仍为 before 的 journal 只被清理,不建账本也不建标记', async () => {
    const hx = await claudeHx('a5-never-');
    const crash = await hx.write(INSTALL, { crashAt: 'journal_written' });
    expect(crash.crashed).toBe(true);
    expect(await hx.has(`${STATE_REL}/ledger.established`)).toBe(false);
    const r = await hx.write(PRUNE);
    expect(r.code, r.err).toBe(0);
    expect(await hx.journals()).toEqual([]);
    expect(await hx.has(`${STATE_REL}/ledger.json`)).toBe(false);
    expect(await hx.has(`${STATE_REL}/ledger.established`)).toBe(false);
  });

  it('标记在、账本缺、没有 bootstrap journal → 退 3 hooks_ledger_invalid(不重建、不猜);账本在而标记缺同样', async () => {
    const hx = await claudeHx('a5-lost-');
    await hx.write(INSTALL);
    await hx.rm(`${STATE_REL}/ledger.json`);
    const r = await hx.run(['--install', '--agent', 'claude']);
    expect(r.code).toBe(3);
    expect(r.err).toBe('RSI_FAIL_CLOSED reason=hooks_ledger_invalid\n');
    expect(r.audit).toEqual([]);
    expect(await hx.has(`${STATE_REL}/ledger.json`)).toBe(false);

    const hy = await claudeHx('a5-nomarker-');
    await hy.write(INSTALL);
    await hy.rm(`${STATE_REL}/ledger.established`);
    const r2 = await hy.run(['--install', '--agent', 'claude']);
    expect(r2.code).toBe(3);
    expect(r2.err).toBe('RSI_FAIL_CLOSED reason=hooks_ledger_invalid\n');
  });

  it('--discard-residue 只接管所选的那一个;非「第三种值」/ 不存在 / 别的 agent 的 journal → 退 4 residue_not_discardable,不记 discarded', async () => {
    const { hx, id } = await bootstrapCrash(); // 目标 = after,不是第三种值
    const j1 = await hx.write(['--discard-residue', id, '--agent', 'claude']);
    expect(j1.code).toBe(4);
    expect(lastLine(j1.err)).toBe('RSI_HOOKS_NOT_RUN reason=residue_not_discardable');
    const dry = await hx.run(['--discard-residue', id, '--agent', 'claude']);
    expect(dry.err).toBe('RSI_HOOKS_NOT_RUN reason=residue_not_discardable\n');
    expect(dry.audit).toEqual([]);
    const none = await hx.run([
      '--discard-residue',
      '20260101T000000Z-0000000000000001',
      '--agent',
      'claude',
    ]);
    expect(none.err).toBe('RSI_HOOKS_NOT_RUN reason=residue_not_discardable\n');
    const other = await hx.run(['--discard-residue', id, '--agent', 'codex']);
    expect(other.err).toBe('RSI_HOOKS_NOT_RUN reason=residue_not_discardable\n');
    expect(await hx.journals()).toEqual([id]);
  });
});

describe('写入承诺等级(R20-15.24a)按实际到达的阶段逐分支断言', () => {
  it('① 零写调用:确认前的一切拒绝与 DECLINED(见 a5-install.test.ts)', async () => {
    const hx = await claudeHx('a5-lvl1-');
    await hx.put('.claude/settings.json', 'not json');
    const r = await hx.write(INSTALL);
    expect(jsonOf(r)).toMatchObject({ write_level: 'zero_write' });
    expect(r.audit).toEqual([]);
  });

  it('② 仅锁基础设施:拿锁失败(locked)与锁内、残留处理未写任何东西时的 stale_plan', async () => {
    const hx = await claudeHx('a5-lvl2-');
    const locked = await hx.write(INSTALL, {
      deps: {
        acquireLock: async () => {
          throw new ApplyError('SYNC_LOCKED', 'held');
        },
      },
    });
    expect(locked.code).toBe(4);
    expect(lastLine(locked.err)).toBe('RSI_HOOKS_NOT_RUN reason=locked');
    expect(jsonOf(locked)).toMatchObject({ write_level: 'lock_only' });
    expect(locked.audit.filter((c) => c.op.startsWith('hooks.'))).toEqual([]);

    // 确认之后、锁内重读之前,目标被改(模拟 agent / 用户改写)→ stale_plan,不静默重规划后执行
    const mutate: NonNullable<HooksDeps['acquireLock']> = async (aenv) => {
      const real = await acquireLock(aenv);
      await hx.put('.claude/settings.json', canon({ model: 'changed-after-confirm' }));
      return real;
    };
    const stale = await hx.write(INSTALL, { deps: { acquireLock: mutate } });
    expect(stale.code).toBe(4);
    expect(lastLine(stale.err)).toBe('RSI_HOOKS_NOT_RUN reason=stale_plan');
    expect(jsonOf(stale)).toMatchObject({ write_level: 'lock_only', result: 'not_run' });
    expect(stale.trace).toEqual([]); // 没有任何 HooksFs 写步骤
    expect(await hx.journals()).toEqual([]);
    expect(JSON.parse(await hx.read('.claude/settings.json'))).toEqual({
      model: 'changed-after-confirm',
    });
  });

  it('③ 仅既有事务的恢复:残留处理写过东西,随后本次计划被拒(stale_plan)', async () => {
    const hx = await claudeHx('a5-lvl3-');
    await hx.write(INSTALL, { crashAt: 'journal_written' }); // 留下进行中的 journal(目标 = before)
    const r = await hx.write(INSTALL, {
      deps: {
        inject: async (p) => {
          if (p === 'residue:journal_deleted') {
            await hx.put('.claude/settings.json', canon({ model: 'x' })); // 残留处理之后、重读之前
          }
        },
      },
    });
    expect(r.code).toBe(4);
    expect(lastLine(r.err)).toBe('RSI_HOOKS_NOT_RUN reason=stale_plan');
    expect(jsonOf(r)).toMatchObject({ write_level: 'recovery_only' });
    expect(await hx.journals()).toEqual([]); // 残留已处理
  });

  it('④ 本次目标未提交:提交前被改(config_changed_during_write)→ journal 记 aborted、备份保留、临时文件已删、对方的改动不丢', async () => {
    for (const point of ['backup_written', 'target_before_write']) {
      const hx = await claudeHx('a5-lvl4-', userSettings());
      const changed = canon({ model: 'changed-by-agent' });
      const r = await hx.write(INSTALL, {
        deps: {
          inject: async (p) => {
            if (p === point) await hx.put('.claude/settings.json', changed);
          },
        },
      });
      expect(r.code, point).toBe(4);
      expect(lastLine(r.err)).toBe('RSI_HOOKS_NOT_RUN reason=config_changed_during_write');
      expect(jsonOf(r)).toMatchObject({ write_level: 'target_unwritten', result: 'not_run' });
      expect(await hx.read('.claude/settings.json')).toBe(changed);
      expect(await hx.names('.claude')).toEqual(['settings.json']);
      const ids = await hx.journals();
      expect(ids).toHaveLength(1);
      expect(JSON.parse(await hx.read(`${STATE_REL}/txn/${ids[0]}.json`))).toMatchObject({
        state: 'aborted',
      });
      expect(await hx.backups()).toEqual(ids); // 备份保留到修剪
      expect(await hx.has(`${STATE_REL}/ledger.json`)).toBe(false);
      // 下一次运行清理 aborted journal,并基于新内容正常安装
      const again = await hx.write(INSTALL);
      expect(again.code, again.err).toBe(0);
      expect(await hx.journals()).toEqual([]);
    }
  });

  it('⑤ 目标已提交、事务待恢复:rename 之后失败(账本 / journal 清理未完成)→ 目标已是 after,下一次 --write 补完', async () => {
    const hx = await claudeHx('a5-lvl5-');
    const r = await hx.write(INSTALL, { crashAt: 'target_renamed' });
    expect(jsonOf(r)).toMatchObject({ write_level: 'target_written_pending' });
    expect(JSON.parse(await hx.read('.claude/settings.json'))).toEqual(FRESH_DOC);
    expect(await hx.has(`${STATE_REL}/ledger.json`)).toBe(false);
    const again = await hx.write(INSTALL);
    expect(again.code, again.err).toBe(0);
    expect(((await hx.ledger()) as { entries: unknown[] }).entries).toHaveLength(2);
  });
});

describe('备份保留与修剪(R20-15.24)', () => {
  const cycle = async (hx: Hx, n: number): Promise<void> => {
    for (let i = 0; i < n; i++) {
      const argv = i % 2 === 0 ? INSTALL : UNINSTALL;
      const r = await hx.write(argv);
      expect(r.code, `cycle ${i}: ${r.err}`).toBe(0);
    }
  };

  it('受保护备份(每个目标最新一个已提交事务)不计入、不受 10 份上限约束;其余最多 10 份', async () => {
    const hx = await claudeHx('a5-prune-count-');
    await cycle(hx, 13); // 第 1 次新建无备份;第 2..13 次各一份备份
    const backups = await hx.backups();
    expect(backups).toHaveLength(11); // 10 份 + 1 份受保护
    const ledger = (await hx.ledger()) as {
      applied_txns: { backup: string }[];
      generation: number;
    };
    expect(ledger.generation).toBe(13);
    // 账本只留有用的记录:最新的 + 备份尚未修剪的
    expect(ledger.applied_txns).toHaveLength(11);
    expect(ledger.applied_txns.every((t) => t.backup === 'present')).toBe(true);
  }, 120_000);

  it('目标事务已完成而顺带修剪失败 → 仍 committed、退 0,stderr 一行 RSI_HOOKS_WARN,maintenance=partial;下次修剪按无害方向补完', async () => {
    const hx = await claudeHx('a5-prune-warn-');
    await cycle(hx, 12);
    const r = await hx.write(INSTALL, { crashAt: 'prune:ledger_committed' });
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain('RSI_HOOKS_WARN reason=prune_incomplete\n');
    expect(jsonOf(r)).toMatchObject({
      result: 'committed',
      write_level: 'committed',
      maintenance: 'partial',
      maintenance_kind: 'prune',
    });
    // 账本已记 pruned,目录还在
    const before = await hx.backups();
    expect(before).toHaveLength(12);
    const dry = await hx.run(['--prune-backups']);
    expect(dry.code).toBe(0);
    expect(dry.out).toMatch(/would prune txn=/);
    // 账本无需再改、只剩删目录:第一步 unlink 之前失锁 → maintenance=none;unlink 成功之后失锁 → partial(目录里的文件已经没了)
    const l0 = await hx.write(['--prune-backups', '--json'], {
      deps: { acquireLock: lockAfter(0) },
    });
    expect(l0.code).toBe(3);
    expect(jsonOf(l0)).toMatchObject({
      maintenance: 'none',
      maintenance_kind: null,
      write_level: null,
    });
    const l1 = await hx.write(['--prune-backups', '--json'], {
      deps: { acquireLock: lockAfter(1) },
    });
    expect(l1.code).toBe(3);
    expect(jsonOf(l1)).toMatchObject({
      maintenance: 'partial',
      maintenance_kind: 'prune',
      write_level: null,
    });
    expect(await hx.backups()).toHaveLength(12); // 文件删了,空目录还在
    const m = await hx.write(['--prune-backups', '--json']);
    expect(m.code, m.err).toBe(0);
    expect(jsonOf(m)).toMatchObject({
      result: 'maintenance_done',
      maintenance: 'done',
      maintenance_kind: 'prune',
      write_level: null,
    });
    expect(await hx.backups()).toHaveLength(11);
  }, 120_000);

  it('30 个 UTC 日:过期的非受保护备份被修剪,受保护备份即使过期也留着;干跑只列 id 与数量', async () => {
    const hx = await claudeHx('a5-prune-age-');
    hx.setNow(new Date(Date.UTC(2026, 8, 1, 12, 0, 0))); // 9 月
    expect((await hx.write(INSTALL)).code).toBe(0); // 无备份
    const u = await hx.write(UNINSTALL); // 备份 A
    const i = await hx.write(INSTALL); // 备份 B(受保护:最新)
    expect(u.code).toBe(0);
    expect(i.code).toBe(0);
    expect(await hx.backups()).toHaveLength(2);
    hx.setNow(new Date(Date.UTC(2026, 10, 2, 12, 0, 0))); // 11 月:都超过 30 天
    const dry = await hx.run(['--prune-backups']);
    expect(dry.code).toBe(0);
    expect(dry.out.match(/would prune txn=/g)).toHaveLength(1);
    expect(dry.out).toContain('prune_count=1');
    expect(dry.audit).toEqual([]);
    const m = await hx.write(['--prune-backups']);
    expect(m.code, m.err).toBe(0);
    const left = await hx.backups();
    expect(left).toHaveLength(1);
    // 留下的是最新事务(受保护)的备份
    const ledger = (await hx.ledger()) as { applied_txns: { txn_id: string }[] };
    expect(ledger.applied_txns.at(-1)?.txn_id).toBe(left[0]);
  });

  it('有在途 journal 引用的备份不修剪', async () => {
    const hx = await claudeHx('a5-prune-inflight-', userSettings());
    hx.setNow(new Date(Date.UTC(2026, 0, 1, 12, 0, 0)));
    await hx.write(INSTALL, { crashAt: 'backup_written' }); // 在途 journal + 备份
    hx.setNow(new Date(Date.UTC(2026, 10, 2, 12, 0, 0)));
    const dry = await hx.run(['--prune-backups']);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('prune_count=0');
  });
});

describe('残留清理的安全与完备(评审采纳)', () => {
  it('目标 tmp 清理先校验父目录:.claude 换成符号链接 → hooks_target_unsafe,链接另一侧的文件不被删', async () => {
    const hx = await claudeHx('a5-tmpanc-');
    await hx.write(INSTALL, { crashAt: 'journal_written' });
    const id = (await hx.journals())[0] as string;
    await hx.rm('.claude');
    await hx.mkdir('real-claude');
    const victim = `real-claude/.settings.json.${id}.tmp`;
    await hx.put(victim, 'victim', 0o600);
    await hx.link('real-claude', '.claude');
    const r = await hx.write(['--prune-backups']);
    expect(r.code).toBe(3);
    expect(lastLine(r.err)).toBe('RSI_FAIL_CLOSED reason=hooks_target_unsafe');
    expect(await hx.read(victim)).toBe('victim');
    expect(await hx.journals()).toEqual([id]);
  });

  it('只有残留 tmp、没有 journal:幂等安装 / 空 prune 不走快捷返回,锁内清理(journal tmp 与 ledger tmp)', async () => {
    const hx = await claudeHx('a5-tmponly-');
    expect((await hx.write(INSTALL)).code).toBe(0);
    // 卸载在 journal tmp 写完 fsync 之后、rename 之前失锁:txn/ 里只剩一个 tmp,目标没动
    const crash = await hx.write(UNINSTALL, { deps: { acquireLock: lockAfter(3) } });
    expect(crash.code).toBe(3);
    expect(await hx.journals()).toEqual([]);
    expect((await hx.names(`${STATE_REL}/txn`)).filter((n) => n.endsWith('.tmp'))).toHaveLength(1);
    const r = await hx.write(INSTALL); // 已装好 → ops 为空
    expect(r.code, r.err).toBe(0);
    expect(jsonOf(r)).toMatchObject({ result: 'unchanged' });
    expect(await hx.names(`${STATE_REL}/txn`)).toEqual([]);
    expect(r.audit.some((c) => c.op.startsWith('hooks.unlink'))).toBe(true);

    await hx.put(`${STATE_REL}/ledger.json.tmp`, 'stale', 0o600);
    const p = await hx.write(['--prune-backups']);
    expect(p.code, p.err).toBe(0);
    expect(await hx.has(`${STATE_REL}/ledger.json.tmp`)).toBe(false);
  });

  it('手动 prune:确认之后、锁内重算的集合变了 → stale_plan,不删用户没确认过的备份', async () => {
    const hx = await claudeHx('a5-prune-stale-');
    expect((await hx.write(INSTALL)).code).toBe(0);
    const old1 = '20200101T000000Z-0000000000000001';
    const old2 = '20200101T000000Z-0000000000000002';
    await hx.mkdir(`${STATE_REL}/backups/${old1}`, 0o700);
    const dry = await hx.run(['--prune-backups']);
    expect(dry.out).toContain(`would prune txn=${old1}`);
    const widen: NonNullable<HooksDeps['acquireLock']> = async (aenv) => {
      const real = await acquireLock(aenv);
      await hx.mkdir(`${STATE_REL}/backups/${old2}`, 0o700); // 确认之后又多出一个过期备份
      return real;
    };
    const r = await hx.write(['--prune-backups'], { deps: { acquireLock: widen } });
    expect(r.code).toBe(4);
    expect(lastLine(r.err)).toBe('RSI_HOOKS_NOT_RUN reason=stale_plan');
    expect(await hx.backups()).toEqual([old1, old2]); // 一个都没删
  });

  it('维护写入的 rename 之后失败(失锁)也按实际阶段记 maintenance=partial(discard)', async () => {
    const mk = async (): Promise<{ hx: Hx; id: string }> => {
      const hx = await claudeHx('a5-discard-prog-');
      await hx.write(INSTALL, { crashAt: 'ledger_marker_created' });
      const id = (await hx.journals())[0] as string;
      await hx.put('.claude/settings.json', canon({ somebody: 'else' }));
      return { hx, id };
    };
    const { hx: base, id: baseId } = await mk();
    const baseline = await base.write(['--discard-residue', baseId, '--agent', 'claude']);
    expect(baseline.code, baseline.err).toBe(0);
    const T = baseline.trace.length;
    expect(T).toBeGreaterThan(8);
    for (let n = 0; n < T; n++) {
      const { hx, id } = await mk();
      const r = await hx.write(['--discard-residue', id, '--agent', 'claude', '--json'], {
        deps: { acquireLock: lockAfter(n) },
      });
      expect(r.code, `n=${n}`).toBe(3);
      const journalPath = `${STATE_REL}/txn/${id}.json`;
      const journal = (await hx.has(journalPath))
        ? (JSON.parse(await hx.read(journalPath)) as { state: string })
        : null;
      const ledger = (await hx.ledger()) as { applied_txns: { status: string }[] } | null;
      const persisted =
        journal?.state === 'discarding' ||
        (ledger?.applied_txns ?? []).some((t) => t.status === 'discarded');
      expect(jsonOf(r), `n=${n}`).toMatchObject({
        write_level: null,
        maintenance: persisted ? 'partial' : 'none',
        maintenance_kind: persisted ? 'discard' : null,
      });
    }
  }, 120_000);
});

describe('restore(R20-15.23)', () => {
  it('只能恢复该目标上最新一个已提交事务:放回备份字节、权限;账本逆变更;源事务记 restored;自身是事务', async () => {
    const hx = await claudeHx('a5-restore-', userSettings());
    const original = await hx.read('.claude/settings.json');
    const inst = await hx.write(INSTALL);
    const id = jsonOf(inst)['txn_id'] as string;
    const dry = await hx.run(['--restore', id, '--agent', 'claude']);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toContain(`would restore agent=claude source_txn=${id}`);
    expect(dry.audit).toEqual([]);
    const r = await hx.write(['--restore', id, '--agent', 'claude', '--json']);
    expect(r.code, r.err).toBe(0);
    expect(jsonOf(r)).toMatchObject({ result: 'committed', write_level: 'committed' });
    expect(await hx.read('.claude/settings.json')).toBe(original);
    const ledger = (await hx.ledger()) as {
      generation: number;
      entries: unknown[];
      applied_txns: { txn_id: string; status: string; op: string; restore_of?: string }[];
    };
    expect(ledger.entries).toEqual([]);
    expect(ledger.generation).toBe(2);
    expect(ledger.applied_txns.find((t) => t.txn_id === id)?.status).toBe('restored');
    expect(ledger.applied_txns.at(-1)).toMatchObject({
      op: 'restore',
      status: 'applied',
      restore_of: id,
    });
    // 再恢复同一个 → restore_not_latest,零写调用
    const again = await hx.run(['--restore', id, '--agent', 'claude', '--write'], {
      tty: true,
      line: 'yes',
    });
    expect(again.code).toBe(4);
    expect(again.err).toBe('RSI_HOOKS_NOT_RUN reason=restore_not_latest\n');
    expect(again.audit).toEqual([]);
  });

  it('写前不存在 → 受保护的删除;恢复后目标消失、归属回到事务之前', async () => {
    const hx = await claudeHx('a5-restore-del-');
    const inst = await hx.write(INSTALL);
    const id = jsonOf(inst)['txn_id'] as string;
    const r = await hx.write(['--restore', id, '--agent', 'claude']);
    expect(r.code, r.err).toBe(0);
    expect(await hx.has('.claude/settings.json')).toBe(false);
    expect(((await hx.ledger()) as { entries: unknown[] }).entries).toEqual([]);
    expect(r.trace.some((e) => e.startsWith('unlink:target/claude'))).toBe(true);
  });

  it('restore 一个 restore 也是合法的(它是新的最新已提交事务)', async () => {
    const hx = await claudeHx('a5-restore-twice-', userSettings());
    const id = jsonOf(await hx.write(INSTALL))['txn_id'] as string;
    const installedText = await hx.read('.claude/settings.json');
    const rid = jsonOf(await hx.write(['--restore', id, '--agent', 'claude', '--json']))[
      'txn_id'
    ] as string;
    const back = await hx.write(['--restore', rid, '--agent', 'claude']);
    expect(back.code, back.err).toBe(0);
    expect(await hx.read('.claude/settings.json')).toBe(installedText);
    expect(((await hx.ledger()) as { entries: unknown[] }).entries).toHaveLength(2);
  });

  it('之后有任何事务(卸载 / discarded)都使旧事务不可恢复;不存在的 id 同码', async () => {
    const hx = await claudeHx('a5-restore-late-', userSettings());
    const id = jsonOf(await hx.write(INSTALL))['txn_id'] as string;
    await hx.write(UNINSTALL);
    const r = await hx.run(['--restore', id, '--agent', 'claude']);
    expect(r.err).toBe('RSI_HOOKS_NOT_RUN reason=restore_not_latest\n');
    expect(r.audit).toEqual([]);
    const unknown = await hx.run([
      '--restore',
      '20260101T000000Z-00000000000000aa',
      '--agent',
      'claude',
    ]);
    expect(unknown.err).toBe('RSI_HOOKS_NOT_RUN reason=restore_not_latest\n');
  });

  it('当前文件已被改(≠ 该事务的 after)→ config_changed_since_install,零写调用', async () => {
    const hx = await claudeHx('a5-restore-chg-', userSettings());
    const id = jsonOf(await hx.write(INSTALL))['txn_id'] as string;
    await hx.put('.claude/settings.json', canon({ changed: true }));
    const r = await hx.write(['--restore', id, '--agent', 'claude']);
    expect(r.code).toBe(4);
    expect(r.err).toBe('RSI_HOOKS_NOT_RUN reason=config_changed_since_install\n');
    expect(r.audit).toEqual([]);
  });

  it('备份损坏 / 被换成链接 / 宽权限 → 退 3 hooks_backup_invalid,零写调用', async () => {
    const mk = async (): Promise<{ hx: Hx; id: string; backup: string }> => {
      const hx = await claudeHx('a5-restore-bad-', userSettings());
      const id = jsonOf(await hx.write(INSTALL))['txn_id'] as string;
      return { hx, id, backup: `${STATE_REL}/backups/${id}/claude` };
    };
    {
      const { hx, id, backup } = await mk();
      await hx.put(backup, 'corrupted', 0o600);
      const r = await hx.write(['--restore', id, '--agent', 'claude']);
      expect(r.code).toBe(3);
      expect(r.err).toBe('RSI_FAIL_CLOSED reason=hooks_backup_invalid\n');
      expect(r.audit).toEqual([]);
    }
    {
      const { hx, id, backup } = await mk();
      const text = await hx.read(backup);
      await hx.rm(backup);
      await hx.put('elsewhere-backup', text, 0o600);
      await hx.link('elsewhere-backup', backup);
      const r = await hx.write(['--restore', id, '--agent', 'claude']);
      expect(r.err).toBe('RSI_FAIL_CLOSED reason=hooks_backup_invalid\n');
    }
    {
      const { hx, id, backup } = await mk();
      await hx.chmod(backup, 0o644); // 不自动修复
      const r = await hx.write(['--restore', id, '--agent', 'claude']);
      expect(r.err).toBe('RSI_FAIL_CLOSED reason=hooks_backup_invalid\n');
      expect((await lstat(hx.abs(backup))).mode & 0o777).toBe(0o644);
    }
  });

  it('restore 的备份回退点:崩溃于 target_renamed 后恢复收敛(账本逆变更只生效一次)', async () => {
    const hx = await claudeHx('a5-restore-crash-', userSettings());
    const original = await hx.read('.claude/settings.json');
    const id = jsonOf(await hx.write(INSTALL))['txn_id'] as string;
    const crash = await hx.write(['--restore', id, '--agent', 'claude'], {
      crashAt: 'target_renamed',
    });
    expect(crash.crashed).toBe(true);
    expect(await hx.read('.claude/settings.json')).toBe(original);
    const rec = await hx.write(INSTALL);
    expect(rec.code, rec.err).toBe(0);
    const ledger = (await hx.ledger()) as {
      generation: number;
      applied_txns: { txn_id: string; status: string }[];
    };
    expect(ledger.applied_txns.find((t) => t.txn_id === id)?.status).toBe('restored');
    expect(await hx.journals()).toEqual([]);
  });
});

describe('私有状态区 / 伪造 journal(R20-15.21a):不满足 → 退 3,不自动修复', () => {
  const state = (s = ''): string => (s === '' ? STATE_REL : `${STATE_REL}/${s}`);

  it('hooks/ 目录宽权限、账本宽权限、账本是链接、账本不可解析 → hooks_ledger_invalid;权限不被自动改回', async () => {
    const mk = async (): Promise<Hx> => {
      const hx = await claudeHx('a5-state-');
      await hx.write(INSTALL);
      return hx;
    };
    const probe = (hx: Hx): Promise<R> => hx.run(['--install', '--agent', 'claude']);
    let hx = await mk();
    await hx.chmod(state(), 0o755);
    expect((await probe(hx)).err).toBe('RSI_FAIL_CLOSED reason=hooks_ledger_invalid\n');
    expect((await lstat(hx.abs(state()))).mode & 0o777).toBe(0o755);

    hx = await mk();
    await hx.chmod(state('ledger.json'), 0o644);
    expect((await probe(hx)).err).toBe('RSI_FAIL_CLOSED reason=hooks_ledger_invalid\n');
    expect((await lstat(hx.abs(state('ledger.json')))).mode & 0o777).toBe(0o644);

    hx = await mk();
    const text = await hx.read(state('ledger.json'));
    await hx.rm(state('ledger.json'));
    await hx.put('elsewhere-ledger', text, 0o600);
    await hx.link('elsewhere-ledger', state('ledger.json'));
    expect((await probe(hx)).err).toBe('RSI_FAIL_CLOSED reason=hooks_ledger_invalid\n');

    hx = await mk();
    await hx.put(state('ledger.json'), '{ not json', 0o600);
    expect((await probe(hx)).err).toBe('RSI_FAIL_CLOSED reason=hooks_ledger_invalid\n');

    hx = await mk();
    await hx.put(
      state('ledger.json'),
      canon({ schema_version: 1, generation: 1, entries: [], applied_txns: [], extra: 1 }),
      0o600,
    );
    expect((await probe(hx)).err).toBe('RSI_FAIL_CLOSED reason=hooks_ledger_invalid\n');
  });

  it('txn/ 换成符号链接 → 不跟随:残留处理读不了 txn/,退 3 hooks_ledger_invalid(等级 lock_only,零后继写)', async () => {
    const hx = await claudeHx('a5-state-link-');
    await hx.write(INSTALL);
    await hx.mkdir('real-txn-copy');
    await hx.rm(state('txn'));
    await hx.link('real-txn-copy', state('txn'));
    const w = await hx.write(['--uninstall', '--agent', 'claude', '--json']);
    expect(w.code).toBe(3);
    expect(lastLine(w.err)).toBe('RSI_FAIL_CLOSED reason=hooks_ledger_invalid');
    expect(jsonOf(w)).toMatchObject({ write_level: 'lock_only' });
    expect(w.trace).toEqual([]);
    expect(await hx.names('real-txn-copy')).toEqual([]);
  });

  it('伪造 journal:文件名与内容 txn_id 不符 / 多余字段(想借路径)/ 目标哈希对不上 → hooks_ledger_invalid;journal 里的路径不作为读写依据', async () => {
    const hx = await claudeHx('a5-forge-');
    await hx.write(INSTALL, { crashAt: 'journal_written' });
    const id = (await hx.journals())[0] as string;
    const j = JSON.parse(await hx.read(state(`txn/${id}.json`))) as Record<string, unknown>;
    // 1) 内容里的 txn_id 与文件名不符
    await hx.put(
      state(`txn/${id}.json`),
      canon({ ...j, txn_id: '20260101T000000Z-ffffffffffffffff' }),
      0o600,
    );
    let r = await hx.write(['--prune-backups']);
    expect(lastLine(r.err)).toBe('RSI_FAIL_CLOSED reason=hooks_ledger_invalid');
    // 2) 多余字段:想让 kit 往别处写
    await hx.put(state(`txn/${id}.json`), canon({ ...j, target_path: '/etc/passwd' }), 0o600);
    r = await hx.write(['--prune-backups']);
    expect(lastLine(r.err)).toBe('RSI_FAIL_CLOSED reason=hooks_ledger_invalid');
    // 3) agent 与计划里的 agent 不一致
    await hx.put(state(`txn/${id}.json`), canon({ ...j, agent: 'codex' }), 0o600);
    r = await hx.write(['--prune-backups']);
    expect(lastLine(r.err)).toBe('RSI_FAIL_CLOSED reason=hooks_ledger_invalid');
    // 4) 字段之间自相矛盾(严格 schema 看不出来):路径、权限、前后状态、记录里的操作 / agent、bootstrap 代次
    const rec = j['ledger_change'] as Record<string, unknown>;
    const record = rec['record'] as Record<string, unknown>;
    const contradictions: [string, Record<string, unknown>][] = [
      ['plan.path', { plan: { ...(j['plan'] as object), path: '~/.claude/other.json' } }],
      ['final_mode', { final_mode: 0o644 }],
      ['original_mode', { original_mode: 0o600 }],
      ['after_exists', { after_exists: false }],
      ['record.op', { ledger_change: { ...rec, record: { ...record, op: 'uninstall' } } }],
      [
        'record.after_sha256',
        { ledger_change: { ...rec, record: { ...record, after_sha256: 'e'.repeat(64) } } },
      ],
      ['record.status', { ledger_change: { ...rec, record: { ...record, status: 'discarded' } } }],
      [
        'record.added.agent',
        {
          ledger_change: {
            ...rec,
            record: {
              ...record,
              added: (record['added'] as Record<string, unknown>[]).map((e) => ({
                ...e,
                agent: 'codex',
              })),
            },
          },
        },
      ],
      ['bootstrap generation', { ledger_change: { ...rec, expected_generation: 5 } }],
    ];
    for (const [name, patch] of contradictions) {
      await hx.put(state(`txn/${id}.json`), canon({ ...j, ...patch }), 0o600);
      r = await hx.write(['--prune-backups']);
      expect(lastLine(r.err), name).toBe('RSI_FAIL_CLOSED reason=hooks_ledger_invalid');
    }
    // 目录里出现不认识的名字
    await hx.put(state(`txn/${id}.json`), canon(j), 0o600);
    await hx.put(state('txn/surprise.txt'), 'x', 0o600);
    r = await hx.write(['--prune-backups']);
    expect(lastLine(r.err)).toBe('RSI_FAIL_CLOSED reason=hooks_ledger_invalid');
    hx.assertAuditInside();
  });

  it('备份区出现不认识的名字 → hooks_backup_invalid', async () => {
    const hx = await claudeHx('a5-state-backup-', userSettings());
    await hx.write(INSTALL);
    await hx.put(state('backups/not-an-id/claude'), 'x', 0o600);
    const r = await hx.run(['--prune-backups']);
    expect(r.code).toBe(3);
    expect(r.err).toBe('RSI_FAIL_CLOSED reason=hooks_backup_invalid\n');
  });
});
