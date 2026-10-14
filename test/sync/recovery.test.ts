/**
 * S4:事务 / 崩溃一致性 / 回滚 / 续跑 / 卸载保护 / 锁 / 备份保留。全部在 KIT_TMP 内的假 HOME 上。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { lstat, readDir, readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import {
  CANARY_USER,
  CODEX_MD,
  PI_MD,
  RULES,
  SHARED,
  SKILL,
  STATE_PREFIX,
  isState,
  newWorld,
  stdFixture,
  treeOf,
  type World,
} from './world.js';

const SYNC_DIR = `${STATE_PREFIX}/sync`;
const LEDGER = `${SYNC_DIR}/ledger.json`;

async function names(w: World, rel: string): Promise<string[]> {
  try {
    return (await readDir(path.join(w.home, rel))).map((e) => e.name);
  } catch {
    return [];
  }
}

const residual = async (w: World): Promise<string[]> =>
  (await names(w, `${SYNC_DIR}/txn`)).map((n) => n.replace(/\.json$/, ''));

async function ready(label: string): Promise<World> {
  const w = await newWorld(label);
  await w.setPayload(stdFixture());
  return w;
}

/** 受管文件视图(排除状态目录):路径 → 权限位 + sha */
const managed = async (w: World): Promise<string[]> =>
  [...(await treeOf(w.home, isState)).files].map(([k, v]) => `${k} ${v}`).sort();

function failAt(point: string): { inject: (p: string) => void } {
  return {
    inject: (p) => {
      if (p === point) throw new Error('EIO injected');
    },
  };
}

/** `.codex/AGENTS.md` 之前的文件已写,之后的没写(写入按路径升序) */
const CRASH_MID = 'after-write:.claude/rules/agent-kit/org.md';

describe('sync:崩溃一致性', () => {
  it('中途注入 IO 错误:txn 残留;下一次(干跑也)拒绝 SYNC_TXN_INCOMPLETE,什么都不改', async () => {
    const w = await ready('rec-crash-');
    const before = await managed(w);
    const r = await w.run(['--write'], { deps: failAt(CRASH_MID) });
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r.err).toBe('SYNC_FAIL_CLOSED reason=SYNC_TXN_INCOMPLETE\n');
    expect(await residual(w)).toHaveLength(1);
    const mid = await managed(w);
    expect(mid).not.toEqual(before); // 已写了一部分
    expect(await w.has(SKILL)).toBe(false); // 但没写完
    expect(await w.has(LEDGER)).toBe(false); // 登记表最后写
    // 锁已释放
    expect(await w.has(`${SYNC_DIR}/lock`)).toBe(false);

    for (const args of [['--write'], []]) {
      const again = await w.run(args);
      expect(again.code).toBe(ExitCode.FAIL_CLOSED);
      expect(again.err).toContain('SYNC_FAIL_CLOSED reason=SYNC_TXN_INCOMPLETE');
    }
    expect(await managed(w)).toEqual(mid);
  });

  it('--resume 把残留事务写完:结果与一次干净安装一致,之后幂等', async () => {
    const w = await ready('rec-resume-');
    await w.put(PI_MD, '用户规则\n');
    await w.run(['--write'], { deps: failAt(CRASH_MID) });
    const dry = await w.run(['--resume']);
    expect(dry.code).toBe(0);
    expect(dry.out).toMatch(/^already_done ~\/\.agents\/skills\/commit-checklist\/SKILL\.md$/m);
    expect(dry.out).toMatch(
      /^would resume_write ~\/\.claude\/skills\/commit-checklist\/SKILL\.md$/m,
    );
    expect(await w.has(SKILL)).toBe(false); // 干跑不写
    const r = await w.run(['--write', '--resume']);
    expect(r.code).toBe(0);
    expect(await residual(w)).toEqual([]);

    const clean = await ready('rec-resume-clean-');
    await clean.put(PI_MD, '用户规则\n');
    expect((await clean.run(['--write'])).code).toBe(0);
    expect(await managed(w)).toEqual(await managed(clean));
    // 登记表内容(去掉事务 id)一致
    const strip = (t: string): string => t.replace(/txn-\d{8}T\d{6}Z-[0-9a-f]{6}/g, 'TXN');
    expect(strip(await w.read(LEDGER))).toBe(strip(await clean.read(LEDGER)));
    const idem = await w.run(['--write']);
    expect(idem.out).toMatch(/^plan create=0 update=0 /m);
    // 没有残留事务时 --resume 是空操作
    const none = await w.run(['--write', '--resume']);
    expect(none.code).toBe(0);
    expect(none.out).toContain('resume txn=- pending=0 done=0');
  });

  it('登记表写之前崩溃:文件都已写,--resume 补写登记表', async () => {
    const w = await ready('rec-ledger-');
    await w.run(['--write'], { deps: failAt('before-ledger') });
    expect(await w.has(LEDGER)).toBe(false);
    expect(await w.has(SKILL)).toBe(true);
    expect(await residual(w)).toHaveLength(1);
    expect((await w.run(['--write', '--resume'])).code).toBe(0);
    expect(await w.has(LEDGER)).toBe(true);
    expect(await residual(w)).toEqual([]);
  });

  it('备份没写完就崩溃:--resume 拒绝(backup_incomplete);--rollback 可用且什么都没写过', async () => {
    const w = await ready('rec-nobackup-');
    await w.run(['--write'], { deps: failAt('journal-written') });
    const [id] = await residual(w);
    expect(id).toBeDefined();
    const res = await w.run(['--write', '--resume']);
    expect(res.code).toBe(ExitCode.FAIL_CLOSED);
    expect(res.err).toBe('SYNC_FAIL_CLOSED reason=SYNC_TXN_INCOMPLETE\n');
    const rb = await w.run(['--write', '--rollback', id as string]);
    expect(rb.code).toBe(0);
    expect(await residual(w)).toEqual([]);
    expect(await w.has(SKILL)).toBe(false);
    // 回滚之后可以重新装
    expect((await w.run(['--write'])).code).toBe(0);
    expect(await w.has(SKILL)).toBe(true);
  });

  it('--rollback 残留事务:已写的文件还原到写前,用户文件逐字节一致', async () => {
    const w = await ready('rec-rbmid-');
    await w.put(PI_MD, `用户规则 ${CANARY_USER}`); // 无结尾换行:卸载做不到逐字节,回滚可以
    const before = await managed(w);
    await w.run(['--write'], { deps: failAt('after-write:.pi/agent/AGENTS.md') });
    expect(await residual(w)).toHaveLength(1);
    const [id] = await residual(w);
    const dry = await w.run(['--rollback', id as string]);
    expect(dry.code).toBe(0);
    expect(dry.out).toMatch(/^would restore_remove ~\//m);
    expect(await w.has(SKILL)).toBe(true); // 干跑不动
    const r = await w.run(['--write', '--rollback', id as string]);
    expect(r.code).toBe(0);
    expect(await managed(w)).toEqual(before.filter((l) => !l.startsWith('.local')));
    expect(await residual(w)).toEqual([]);
  });

  it('--rollback 已收尾事务:前提成立则逐字节还原(含无结尾换行的用户文件与权限位),登记表一并还原', async () => {
    const w = await ready('rec-rbdone-');
    await w.put(PI_MD, `用户规则 ${CANARY_USER}`, 0o600);
    const before = await managed(w);
    const inst = await w.run(['--write']);
    const id = /^txn (\S+)$/m.exec(inst.out)?.[1] as string;
    expect((await lstat(path.join(w.home, PI_MD))).mode & 0o777).toBe(0o600); // 更新用户文件保留权限位
    const r = await w.run(['--write', '--rollback', id]);
    expect(r.code).toBe(0);
    expect(await managed(w)).toEqual(before);
    expect(await w.has(LEDGER)).toBe(false);
    // 回滚事务本身也留了备份:可以再回滚(把安装恢复回来)
    const rbId = /^txn (\S+)$/m.exec(r.out)?.[1] as string;
    const redo = await w.run(['--write', '--rollback', rbId]);
    expect(redo.code).toBe(0);
    expect(await w.has(SKILL)).toBe(true);
    expect(await w.has(LEDGER)).toBe(true);
  });

  it('回滚前提不成立 → SYNC_ROLLBACK_MISMATCH,整次不写(文件被改 / 登记表被改 / 不是最新事务 / 未知事务)', async () => {
    const w = await ready('rec-mismatch-');
    const a = await w.run(['--write']);
    const idA = /^txn (\S+)$/m.exec(a.out)?.[1] as string;
    await w.setPayload(stdFixture('v2'));
    const b = await w.run(['--write'], { deps: { now: () => new Date(Date.now() + 5000) } });
    const idB = /^txn (\S+)$/m.exec(b.out)?.[1] as string;
    expect(idB).not.toBe(idA);

    const snapshot = await treeOf(w.home);
    const expectMismatch = async (id: string): Promise<void> => {
      const r = await w.run(['--write', '--rollback', id]);
      expect(r.code).toBe(ExitCode.FAIL_CLOSED);
      expect(r.err).toBe('SYNC_FAIL_CLOSED reason=SYNC_ROLLBACK_MISMATCH\n');
    };
    await expectMismatch(idA); // 不是最新事务:文件当前 sha 是 B 写入的
    await expectMismatch('txn-20200101T000000Z-aaaaaa'); // 未知事务
    expect([...(await treeOf(w.home)).files]).toEqual([...snapshot.files]);

    await w.put(SKILL, `用户后来改的 ${CANARY_USER}\n`); // 文件被改
    await expectMismatch(idB);
    expect(await w.read(SKILL)).toContain(CANARY_USER);
    await w.put(
      SKILL,
      await readText(path.join(w.payloadRoot, `payload/files/claude/home/${SKILL}`)),
    ); // 复原

    await w.put(LEDGER, `${await w.read(LEDGER)}\n`); // 登记表被改
    await expectMismatch(idB);
    // 正向对照:登记表复原后同一回滚成功
    await w.put(LEDGER, (await w.read(LEDGER)).replace(/\n\n$/, '\n'));
    const ok = await w.run(['--write', '--rollback', idB]);
    expect(ok.code).toBe(0);
    expect(await w.read(SKILL)).toContain('v1');
  });
});

describe('sync:收尾边界', () => {
  it('登记表里记的 txn 就是实际落盘的事务 id(审计链不断)', async () => {
    const w = await ready('rec-txnid-');
    const r = await w.run(['--write']);
    const id = /^txn (\S+)$/m.exec(r.out)?.[1] as string;
    const ledger = JSON.parse(await w.read(LEDGER)) as { entries: { txn: string }[] };
    expect(new Set(ledger.entries.map((e) => e.txn))).toEqual(new Set([id]));
    expect(await names(w, `${SYNC_DIR}/backups`)).toEqual([id]);
  });

  it('登记表损坏:所有模式整次拒绝 SYNC_LEDGER_INVALID,不写、不删', async () => {
    const w = await ready('rec-badledger-');
    await w.run(['--write']);
    await w.put(LEDGER, '{"schema_version":1}');
    const before = await managed(w);
    for (const a of [['--write'], ['--write', '--uninstall'], ['--write', '--adopt'], []]) {
      const r = await w.run(a);
      expect(r.code, a.join(' ')).toBe(ExitCode.FAIL_CLOSED);
      expect(r.err).toContain('SYNC_FAIL_CLOSED reason=SYNC_LEDGER_INVALID');
    }
    expect(await managed(w)).toEqual(before);
    expect(await w.read(LEDGER)).toBe('{"schema_version":1}');
  });

  it('登记表已写、只差删 journal 时崩溃:即使用户之后改了某个文件,--resume 也能收尾(不卡死),用户改动保留', async () => {
    const w = await ready('rec-lw-');
    await w.run(['--write'], { deps: failAt('before-journal-delete') });
    expect(await residual(w)).toHaveLength(1);
    expect(await w.has(LEDGER)).toBe(true);
    await w.put(SKILL, `崩溃后用户改的 ${CANARY_USER}\n`);
    const r = await w.run(['--write', '--resume']);
    expect(r.code).toBe(0);
    expect(await residual(w)).toEqual([]);
    expect(await w.read(SKILL)).toContain(CANARY_USER);
    // 之后照常按漂移处理
    expect((await w.run(['--write'])).code).toBe(ExitCode.CHECK_FAILED);
  });

  it('已收尾事务的备份缺 complete 标记:回滚拒绝(不能在不完整的备份上还原)', async () => {
    const w = await ready('rec-nocomplete-');
    const r = await w.run(['--write']);
    const id = /^txn (\S+)$/m.exec(r.out)?.[1] as string;
    await safe.remove(w.io, path.join(w.home, `${SYNC_DIR}/backups/${id}/complete`));
    const rb = await w.run(['--write', '--rollback', id]);
    expect(rb.code).toBe(ExitCode.FAIL_CLOSED);
    expect(rb.err).toBe('SYNC_FAIL_CLOSED reason=SYNC_ROLLBACK_MISMATCH\n');
    expect(await w.has(SKILL)).toBe(true);
  });

  it('两个 --write 同时跑:最多一个真的写(另一个 SYNC_LOCKED 或看到已装好的结果),最终状态等于一次干净安装', async () => {
    const w = await ready('rec-concurrent-');
    const [a, b] = await Promise.all([w.run(['--write']), w.run(['--write'])]);
    expect([a.code, b.code].every((c) => c === 0 || c === ExitCode.NOT_RUN)).toBe(true);
    expect([a.code, b.code]).toContain(0);
    const did = [a.out, b.out].filter((o) => /^did create /m.test(o));
    expect(did).toHaveLength(1);
    const clean = await ready('rec-concurrent-clean-');
    await clean.run(['--write']);
    expect(await managed(w)).toEqual(await managed(clean));
    expect(await residual(w)).toEqual([]);
    expect(await w.has(`${SYNC_DIR}/lock`)).toBe(false);
  });

  it('--rollback / --resume 的 --json 键集合固定', async () => {
    const w = await ready('rec-json-');
    const r = await w.run(['--write']);
    const id = /^txn (\S+)$/m.exec(r.out)?.[1] as string;
    const rb = JSON.parse((await w.run(['--rollback', id, '--json'])).out) as Record<
      string,
      unknown
    >;
    expect(Object.keys(rb).sort()).toEqual(
      ['dry', 'kind', 'ledger_restore', 'mode', 'restore', 'source_txn', 'txn'].sort(),
    );
    const rs = JSON.parse((await w.run(['--resume', '--json'])).out) as Record<string, unknown>;
    expect(Object.keys(rs).sort()).toEqual(['done', 'dry', 'mode', 'pending', 'txn'].sort());
    const pl = JSON.parse((await w.run(['--json'])).out) as Record<string, unknown>;
    expect(Object.keys(pl).sort()).toEqual(
      [
        'codes',
        'dry',
        'exit',
        'files',
        'ledger',
        'mode',
        'ops',
        'skippedLayers',
        'status',
        'summary',
        'txn',
      ].sort(),
    );
  });
});

describe('sync:卸载', () => {
  it('漂移文件不删:保留文件与登记条目(不丢所有权),退出 1;登记表不删', async () => {
    const w = await ready('rec-uninst-drift-');
    await w.run(['--write']);
    await w.put(RULES, `用户改过 ${CANARY_USER}\n`);
    const r = await w.run(['--write', '--uninstall']);
    expect(r.code).toBe(ExitCode.CHECK_FAILED);
    expect(r.err).toContain('SYNC_DRIFTED');
    expect(await w.read(RULES)).toContain(CANARY_USER);
    expect(await w.has(SKILL)).toBe(false); // 未漂移的照常卸载
    const ledger = JSON.parse(await w.read(LEDGER)) as { entries: { path: string }[] };
    expect(ledger.entries.map((e) => e.path)).toEqual([RULES]);
  });

  it('条目目录里有用户放的别的文件:只删我们登记的文件,目录与用户文件保留', async () => {
    const w = await ready('rec-uninst-dir-');
    await w.run(['--write']);
    await w.put('.claude/skills/commit-checklist/mine.md', '用户的\n');
    expect((await w.run(['--write', '--uninstall'])).code).toBe(0);
    expect(await w.has(SKILL)).toBe(false);
    expect(await w.read('.claude/skills/commit-checklist/mine.md')).toBe('用户的\n');
  });

  it('只卸一个 agent:共用路径仍被其它 agent 请求就保留,登记条目只去掉该 agent', async () => {
    const w = await ready('rec-uninst-part-');
    await w.run(['--write']);
    const r = await w.run(['--write', '--uninstall', '--agent', 'codex']);
    expect(r.code).toBe(0);
    expect(await w.has(CODEX_MD)).toBe(false);
    expect(await w.has(SHARED)).toBe(true); // pi 还在请求
    expect(await w.has(PI_MD)).toBe(true);
    const ledger = JSON.parse(await w.read(LEDGER)) as {
      entries: { path: string; agents: string[] }[];
    };
    expect(ledger.entries.find((e) => e.path === SHARED)?.agents).toEqual(['pi']);
    // 再卸 pi 与 claude:全清,登记表删除
    expect((await w.run(['--write', '--uninstall'])).code).toBe(0);
    expect(await w.has(SHARED)).toBe(false);
    expect(await w.has(LEDGER)).toBe(false);
  });

  it('用户已删除登记过的文件:卸载把登记条目丢掉,不报错', async () => {
    const w = await ready('rec-uninst-gone-');
    await w.run(['--write']);
    await safe.remove(w.io, path.join(w.home, SKILL));
    const r = await w.run(['--write', '--uninstall']);
    expect(r.code).toBe(0);
    expect(await w.has(LEDGER)).toBe(false);
  });

  it('计划之后、写盘之前文件被改(竞态):写前复核指纹,拒绝覆盖 / 删除用户版本', async () => {
    const w = await ready('rec-race-');
    await w.run(['--write']);
    const racing = (): { inject: (p: string) => Promise<void> } => ({
      inject: async (p) => {
        if (p === 'backup-written') await w.put(RULES, `竞态写入 ${CANARY_USER}\n`);
      },
    });
    const r = await w.run(['--write', '--uninstall'], { deps: racing() });
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(await w.read(RULES)).toContain(CANARY_USER); // 用户版本还在,没被删
    expect(r.out).not.toContain(CANARY_USER);
    // 事务已残留:改回之后 --resume 或 --rollback 都能收尾;这里用 rollback(其余文件已部分写)
    const [id] = await residual(w);
    expect(id).toBeDefined();
  });
});

describe('sync:锁与备份保留', () => {
  it('持锁进程还活着 → 退出 4 SYNC_LOCKED,不写;进程已不在 → 回收;锁内容损坏 → 回收', async () => {
    const w = await ready('rec-lock-');
    const lock = `${SYNC_DIR}/lock`;
    await w.put(
      lock,
      JSON.stringify({ pid: process.pid, started_at: '2026-10-14T00:00:00.000Z', nonce: 'x' }),
      0o600,
    );
    const locked = await w.run(['--write']);
    expect(locked.code).toBe(ExitCode.NOT_RUN);
    expect(locked.err).toBe('SYNC_NOT_RUN reason=SYNC_LOCKED\n');
    expect(await w.has(SKILL)).toBe(false);
    // 超过 TTL 但 pid 还在:只报不杀,仍然 LOCKED
    await w.put(
      lock,
      JSON.stringify({ pid: process.pid, started_at: '2020-01-01T00:00:00.000Z', nonce: 'x' }),
      0o600,
    );
    expect((await w.run(['--write'])).code).toBe(ExitCode.NOT_RUN);
    // pid 已不在
    await w.put(
      lock,
      JSON.stringify({ pid: 2147483646, started_at: '2026-10-14T00:00:00.000Z', nonce: 'x' }),
      0o600,
    );
    expect((await w.run(['--write'], { deps: { isPidAlive: () => false } })).code).toBe(0);
    expect(await w.has(lock)).toBe(false); // 用完释放
    // 损坏的锁
    await w.setPayload(stdFixture('v2'));
    await w.put(lock, '不是 json', 0o600);
    expect((await w.run(['--write'])).code).toBe(0);
    // 干跑不看锁
    await w.put(
      lock,
      JSON.stringify({ pid: process.pid, started_at: '2026-10-14T00:00:00.000Z', nonce: 'x' }),
      0o600,
    );
    expect((await w.run([])).code).toBe(0);
  });

  it('备份只保留最近 5 个事务;残留事务的备份永不修剪', async () => {
    const w = await newWorld('rec-retain-');
    let t = Date.UTC(2026, 9, 14, 12, 0, 0);
    const deps = { now: () => new Date((t += 1000)) };
    for (let i = 1; i <= 8; i++) {
      await w.setPayload(stdFixture(`v${i}`));
      expect((await w.run(['--write'], { deps })).code).toBe(0);
    }
    const kept = await names(w, `${SYNC_DIR}/backups`);
    expect(kept).toHaveLength(5);
    expect([...kept].sort()).toEqual(kept);
    // 残留事务:再来一次崩溃的安装,它的备份必须保留
    await w.setPayload(stdFixture('v9'));
    await w.run(['--write'], {
      deps: {
        ...deps,
        inject: (p) => {
          if (p === 'after-write:.codex/AGENTS.md') throw new Error('x');
        },
      },
    });
    const [res] = await residual(w);
    expect(await names(w, `${SYNC_DIR}/backups`)).toContain(res);
  });
});

describe('sync:home-fs 阶段失败', () => {
  it('原子写在 rename 前失败:目标保持原样、临时文件被清理', async () => {
    const w = await ready('rec-stage-');
    await w.put(PI_MD, '用户\n');
    let n = 0;
    const r = await w.run(['--write'], {
      deps: {
        onStage: (s) => {
          // 只让写 pi 的 AGENTS.md 那次失败:前面还有若干次原子写,按计数挑第一个 owned 目标之后
          if (s === 'pre-rename' && ++n === 9) throw new Error('EIO');
        },
      },
    });
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    const leftovers = (await names(w, '.pi/agent')).filter((x) => x.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });
});
