/**
 * 端口契约测试套件(W8a 骨架;contracts §21.24 W0-22 第 6、7 条;SOLID 的 L):**同一套用例**对测试假件与生产适配器各跑一遍——假件必须通过同一份契约才可用于命令测试。
 * 契约:读失败 = `unreadable`(绝不返回 `absent` / 空冒充成功);只有「确认不存在」才是 `absent` / `missing`;未装配的端口 fail-closed(`unreadable(not_wired)`)。
 * 本段覆盖用到的读端口:`HomeReadPort`(假件 vs `makeHomeReadPort`)与 `RecordedReadPort`(假件 vs `unwiredRecordedRead` / 真适配器见 `git-readonly.test.ts`)。
 * 写端口(W8b,本文件下半):用户暂停文件(`ensureUser` 不覆盖、指纹 CAS;假件 vs 生产 `makeUserMarkerPort`)、`PauseStatePort` 的锁持有断言、`bump` 单调、
 * 带键效果落地(`applyOnce` 幂等、`blacklist_veto` / `protection_mark` 按 `(id, sha)` 集合插入;生产的 `deferredKeyedEffects` / `unwiredKeyedEffects`)、生产写组装只接了用户标记端口。
 */
import * as path from 'node:path';
import type { RsiAuditLine } from '../../../src/contracts/rsi-personal.js';
import { describe, expect, it } from 'vitest';
import type { HomeReadPort } from '../../../src/rsi/auto/read/ports.js';
import {
  PERSONAL_STATE_REL_READ,
  makeHomeReadPort,
} from '../../../src/rsi/personal/read/home-reads.js';
import { PERSONAL_STATE_REL } from '../../../src/rsi/personal/home-state.js';
import { unwiredRecordedRead } from '../../../src/rsi/personal/read/recorded-port.js';
import {
  RSI_REVOCATION_BY,
  RSI_TRANSITION_REASONS_TERMINATING,
} from '../../../src/contracts/rsi.js';
import { mkdirp, remove, symlink, writeFile } from '../../../src/io/safe-fs.js';
import { makeUserMarkerPort } from '../../../src/rsi/canary/pause-marker.js';
import { CANARY_FILES } from '../../../src/rsi/canary/files.js';
import { productionWritePorts } from '../../../src/rsi/auto/deps-write.js';
import {
  PortNotWired,
  deferredKeyedEffects,
  unwiredKeyedEffects,
  type KeyedEffectSink,
} from '../../../src/rsi/personal/rollback-ports.js';
import type { UserMarkerPort } from '../../../src/rsi/personal/breaker.js';
import type { RsiEarlyContext } from '../../../src/rsi/types.js';
import { readRecordedRecords } from '../../../src/rsi/auto/read/recorded-records.js';
import { sourceCompatible } from '../../../src/rsi/auto/read/journal-check.js';
import { sourceProblem } from '../../../src/rsi/personal/rollback-journal.js';
import { makeWorld as makeIoWorld } from '../personal/repo-helpers.js';
import { makeWorld, portsOf } from './auto-fixture.js';
import { FakeKeyedSink, FakeLocks, FakeMarks, FakePauseState, FakeUser } from './write-fixture.js';

interface HomeHarness {
  port: HomeReadPort;
  putHead(text: string): Promise<void>;
  putRevocations(text: string): Promise<void>;
  putJournal(id: string, text: string): Promise<void>;
  /** 让 head / revocations / journal / txn 目录的读取失败(不是缺失) */
  breakReads(): Promise<void>;
}

const JID = '0123456789abcdef';

const fakeHome = async (): Promise<HomeHarness> => {
  const w = makeWorld();
  const p = portsOf(w).home;
  return {
    port: p,
    putHead: async (t) => void (w.head = { kind: 'ok', text: t }),
    putRevocations: async (t) => void (w.rev = { kind: 'ok', text: t }),
    putJournal: async (id, t) => {
      w.names.push(id);
      w.journals[id] = { kind: 'ok', text: t };
    },
    breakReads: async () => {
      w.head = { kind: 'unreadable' };
      w.rev = { kind: 'unreadable' };
      w.namesUnreadable = true;
      w.journals[JID] = { kind: 'unreadable' };
    },
  };
};

const prodHome = async (): Promise<HomeHarness> => {
  const w = await makeIoWorld('w8a-contract-');
  const dir = path.join(w.home, ...PERSONAL_STATE_REL_READ.split('/'));
  const put = async (rel: string, text: string, mode = 0o600): Promise<void> => {
    await mkdirp(w.io, path.dirname(path.join(dir, rel)), 0o700);
    await writeFile(w.io, path.join(dir, rel), text, { mode });
  };
  return {
    port: makeHomeReadPort(w.home),
    putHead: (t) => put('head.json', t),
    putRevocations: (t) => put('revocations.jsonl', t),
    putJournal: (id, t) => put(`txn/${id}.json`, t),
    // 权限宽于 0600 = 不安全 = 读失败(不是缺失);目录不可读同理
    breakReads: async () => {
      await put('head.json', 'x', 0o644);
      await put('revocations.jsonl', 'x', 0o644);
      await put(`txn/${JID}.json`, 'x', 0o644);
    },
  };
};

describe.each([
  ['测试假件', fakeHome],
  ['生产适配器 makeHomeReadPort', prodHome],
] as const)('HomeReadPort 契约:%s', (_name, make) => {
  it('什么都没有 → head / revocations / journal 是 absent,事务目录是空(不是读失败)', async () => {
    const h = await make();
    expect(await h.port.head()).toEqual({ kind: 'absent' });
    expect(await h.port.revocations()).toEqual({ kind: 'absent' });
    expect(await h.port.txnNames()).toEqual({ kind: 'ok', names: [] });
    expect(await h.port.journal(JID)).toEqual({ kind: 'absent' });
  });

  it('有内容 → 原文;事务目录名升序', async () => {
    const h = await make();
    await h.putHead('{"a":1}');
    await h.putRevocations('line\n');
    await h.putJournal('bbbbbbbbbbbbbbbb', '{"j":2}');
    await h.putJournal('aaaaaaaaaaaaaaaa', '{"j":1}');
    expect(await h.port.head()).toEqual({ kind: 'ok', text: '{"a":1}' });
    expect(await h.port.revocations()).toEqual({ kind: 'ok', text: 'line\n' });
    expect(await h.port.txnNames()).toEqual({
      kind: 'ok',
      names: ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'],
    });
    expect(await h.port.journal('aaaaaaaaaaaaaaaa')).toEqual({ kind: 'ok', text: '{"j":1}' });
  });

  it('读失败 → unreadable,绝不是 absent / 空', async () => {
    const h = await make();
    await h.breakReads();
    expect((await h.port.head()).kind).toBe('unreadable');
    expect((await h.port.revocations()).kind).toBe('unreadable');
    expect((await h.port.journal(JID)).kind).toBe('unreadable');
  });
});

describe('个人层状态目录常量:读端口与写侧 home-state.ts 指向同一位置', () => {
  it('PERSONAL_STATE_REL_READ === PERSONAL_STATE_REL', () => {
    expect(PERSONAL_STATE_REL_READ).toBe(PERSONAL_STATE_REL);
  });
});

describe.each([
  ['测试假件', () => portsOf(makeWorld()).recorded],
  ['生产未装配实现 unwiredRecordedRead', () => unwiredRecordedRead],
] as const)('RecordedReadPort 契约(未装配 / 缺对象):%s', (name, make) => {
  it('非 40 位小写十六进制的 oid → unreadable(bad_oid)或未装配(not_wired);绝不 ok / missing 冒充', async () => {
    const p = make();
    for (const m of ['readCommit', 'listTree', 'readBlob'] as const) {
      const r = await p[m]('HEAD');
      expect(r.kind, `${name}.${m}`).toBe('unreadable');
    }
  });

  it('未装配 = 恒 unreadable(not_wired)', async () => {
    const r = await unwiredRecordedRead.readCommit('a'.repeat(40));
    expect(r).toEqual({ kind: 'unreadable', why: 'not_wired' });
    expect(await unwiredRecordedRead.listTree('a'.repeat(40))).toEqual({
      kind: 'unreadable',
      why: 'not_wired',
    });
    expect(await unwiredRecordedRead.readBlob('a'.repeat(40))).toEqual({
      kind: 'unreadable',
      why: 'not_wired',
    });
  });
});

describe('RecordedReadPort 假件:确认不存在才是 missing', () => {
  it('合法 oid 但对象不存在 → missing', async () => {
    const p = portsOf(makeWorld()).recorded;
    expect(await p.readCommit('a'.repeat(40))).toEqual({ kind: 'missing' });
  });
});

describe('journal 来源相容性:读侧镜像与写侧 sourceProblem 逐组合相等(防漂移)', () => {
  it('全部 (by, kind, reason) 组合:sourceCompatible === (sourceProblem === null)', () => {
    const kinds = ['rollback', 'clear', 'reconcile', 'identity_change'] as const;
    const reasons = [...RSI_TRANSITION_REASONS_TERMINATING, 'gates_passed'];
    let n = 0;
    for (const by of RSI_REVOCATION_BY) {
      for (const kind of kinds) {
        for (const reason of reasons) {
          expect(sourceCompatible(by, kind, reason), `${by}/${kind}/${reason}`).toBe(
            sourceProblem(by, kind, reason) === null,
          );
          n += 1;
        }
      }
    }
    expect(n).toBeGreaterThan(100);
  });
});

describe('HOME 事务目录的静态安全检查', () => {
  it('txn 是符号链接 / 权限宽于 0700 → txnNames 读失败(unreadable),不是空', async () => {
    const w = await makeIoWorld('w8a-txn-');
    const dir = path.join(w.home, ...PERSONAL_STATE_REL_READ.split('/'));
    await mkdirp(w.io, path.join(w.dir, 'elsewhere'), 0o700);
    await writeFile(w.io, path.join(w.dir, 'elsewhere', '0123456789abcdef.json'), '{}');
    await mkdirp(w.io, dir, 0o700);
    await symlink(w.io, path.join(w.dir, 'elsewhere'), path.join(dir, 'txn'));
    expect((await makeHomeReadPort(w.home).txnNames()).kind).toBe('unreadable');
    const w2 = await makeIoWorld('w8a-txn2-');
    const d2 = path.join(w2.home, ...PERSONAL_STATE_REL_READ.split('/'), 'txn');
    await mkdirp(w2.io, d2, 0o755);
    expect((await makeHomeReadPort(w2.home).txnNames()).kind).toBe('unreadable');
  });
});

describe('记录提交里 lifecycle 路径的非法形状', () => {
  it('lifecycle/<id>.json 是符号链接 → invalid(record),不是「没有候选」', async () => {
    const oid = 'a'.repeat(40);
    const port = {
      ...portsOf(makeWorld()).recorded,
      readCommit: async () => ({ kind: 'ok' as const, value: { oid } }),
      listTree: async () => ({
        kind: 'ok' as const,
        value: [{ path: 'lifecycle/ra_0123456789ab.json', oid, mode: '120000' }],
      }),
    };
    const head = JSON.stringify({
      schema_version: 1,
      head: oid,
      owner_repo_fp: '0123456789abcdef',
    });
    expect(await readRecordedRecords(port, head)).toEqual({ kind: 'invalid', why: 'record' });
  });
});

// ---------------------------------------------------------------------------
// W8b 写侧端口契约(假件 = 生产同一份契约)
// ---------------------------------------------------------------------------
interface UserHarness {
  port: UserMarkerPort;
  /** 模拟「模型外动作」:删掉当前实例再建一个新的 */
  replaceInstance(): Promise<void>;
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const fakeUser = async (): Promise<UserHarness> => {
  const u = new FakeUser();
  return { port: u, replaceInstance: async () => u.replace() };
};
const prodUser = async (): Promise<UserHarness> => {
  const w = await makeIoWorld('w8b-user-');
  const dir = path.join(w.dir, 'rsi');
  await mkdirp(w.io, dir, 0o700);
  const port = makeUserMarkerPort(w.io, dir, () => new Date('2026-11-13T00:00:00.000Z'));
  return {
    port,
    replaceInstance: async () => {
      await remove(w.io, path.join(dir, CANARY_FILES.pause));
      await sleep(20);
      await port.ensureUser();
    },
  };
};

describe.each([
  ['测试假件 FakeUser', fakeUser],
  ['生产适配器 makeUserMarkerPort', prodUser],
] as const)('UserMarkerPort 写侧契约:%s', (_name, make) => {
  it('ensureUser 独占创建且不覆盖:第一次 created,第二次 exists,实例指纹不变', async () => {
    const h = await make();
    expect(await h.port.snapshot()).toBe('none');
    expect(await h.port.exists()).toBe(false);
    expect(await h.port.ensureUser()).toBe('created');
    const first = await h.port.snapshot();
    expect(first).not.toBe('none');
    expect(await h.port.ensureUser()).toBe('exists');
    expect(await h.port.snapshot()).toEqual(first);
    expect(await h.port.exists()).toBe(true);
  });

  it('remove(指纹):相等才删;换实例后旧指纹 changed 且不删;指纹 none 永不删;不存在 absent', async () => {
    const h = await make();
    expect(await h.port.remove('none')).toBe('absent');
    await h.port.ensureUser();
    const stamp = await h.port.snapshot();
    expect(await h.port.remove('none')).toBe('changed');
    expect(await h.port.exists()).toBe(true);
    await sleep(20);
    await h.replaceInstance();
    expect(await h.port.remove(stamp)).toBe('changed');
    expect(await h.port.exists()).toBe(true);
    const fresh = await h.port.snapshot();
    expect(await h.port.remove(fresh)).toBe('removed');
    expect(await h.port.exists()).toBe(false);
  });
});

describe('PauseStatePort / EntryMarks 假件:锁持有断言与单调', () => {
  it('state.write 在锁外被拒(抛错,不落地);锁内落地,读回是副本', async () => {
    const locks = new FakeLocks();
    const st = new FakePauseState(locks, []);
    const next = { reasons: ['user_vetoes' as const], diverged: false, owner_changed: false };
    await expect(st.write(next)).rejects.toThrow(/lock not held/);
    expect((await st.read()).reasons).toEqual([]);
    await locks.withLocks('rsi_personal_sync', async () => st.write(next));
    const got = await st.read();
    expect(got.reasons).toEqual(['user_vetoes']);
    got.reasons = [];
    expect((await st.read()).reasons).toEqual(['user_vetoes']);
  });

  it('bump 单调递增、锁外被拒', async () => {
    const locks = new FakeLocks();
    const m = new FakeMarks(locks, []);
    await expect(m.bump()).rejects.toThrow(/lock not held/);
    const seen: number[] = [];
    await locks.withLocks('rsi_personal_sync', async () => {
      seen.push(await m.bump(), await m.bump(), await m.bump());
    });
    expect(seen).toEqual([1, 2, 3]);
  });

  it('锁序:rsi → personal → sync 取,逆序放;缩减入口只有 personal → sync', async () => {
    const locks = new FakeLocks();
    await locks.withLocks('rsi_personal_sync', async () => undefined);
    await locks.withLocks('personal_sync', async () => undefined);
    expect(locks.log).toEqual([
      'acquire:rsi',
      'acquire:personal',
      'acquire:sync',
      'release:sync',
      'release:personal',
      'release:rsi',
      'acquire:personal',
      'acquire:sync',
      'release:sync',
      'release:personal',
    ]);
  });
});

const markLine = (reason: string): RsiAuditLine =>
  ({
    at: '2026-11-12T00:00:00.000Z',
    kind: 'reconcile',
    id: 'ra_0123456789ab',
    dim: 'lifecycle',
    from: 'rolling_back',
    to: 'rolled_back',
    reason,
    counts: { cooldown_days: 90 },
  }) as unknown as RsiAuditLine;

describe('KeyedEffectSink 写侧契约(假件):applyOnce 幂等、黑名单按 (id, sha) 集合插入、批次原子', () => {
  const ID = 'ra_0123456789ab';
  const SHA = 'a'.repeat(64);
  const veto = { type: 'blacklist_veto' as const, id: ID, content_sha256: SHA };

  it('同键重复 = already,不重复落地', async () => {
    const s = new FakeKeyedSink();
    expect(await s.applyOnce('k1', [veto])).toBe('applied');
    expect(await s.applyOnce('k1', [veto])).toBe('already');
    expect(s.blacklistCount).toBe(1);
  });

  it('E1(veto:<id>:<sha>)与 E2(terminal:<id>:<sha>)含同一黑名单:不同键各落一次,成员与计数都不重复', async () => {
    const s = new FakeKeyedSink();
    expect(await s.applyOnce(`veto:${ID}:${SHA}`, [veto])).toBe('applied');
    expect(await s.applyOnce(`terminal:${ID}:${SHA}`, [veto])).toBe('applied');
    expect([...s.blacklist]).toEqual([`${ID}:${SHA}`]);
    expect(s.blacklistCount).toBe(1);
    // 不同 sha 是另一个成员
    expect(await s.applyOnce('terminal:x', [{ ...veto, content_sha256: 'b'.repeat(64) }])).toBe(
      'applied',
    );
    expect(s.blacklistCount).toBe(2);
  });

  it('protection_mark 与批次同一步骤:deferred 时没有落行;applied 恰好一行;同键重复为 already 且不重复落行', async () => {
    const s = new FakeKeyedSink();
    const mark = {
      type: 'protection_mark' as const,
      line: markLine('protection_unknown'),
      idem_key: '0'.repeat(16),
    };
    s.deferred = true;
    expect(await s.applyOnce('terminal:k', [veto, mark])).toBe('deferred');
    expect(s.audits).toHaveLength(0);
    expect(s.blacklistCount).toBe(0);
    s.deferred = false;
    expect(await s.applyOnce('terminal:k', [veto, mark])).toBe('applied');
    expect(s.audits).toHaveLength(1);
    expect(await s.applyOnce('terminal:k', [veto, mark])).toBe('already');
    expect(s.audits).toHaveLength(1);
  });
});

describe('KeyedEffectSink 生产实现的写侧契约(缩减入口 / 未装配)', () => {
  const eff = [
    { type: 'blacklist_veto' as const, id: 'ra_0123456789ab', content_sha256: 'a'.repeat(64) },
  ];
  it('deferredKeyedEffects:恒 deferred(缩减入口不访问效果的存放处,记待对账)', async () => {
    const s: KeyedEffectSink = deferredKeyedEffects;
    expect(await s.applyOnce('terminal:x', eff)).toBe('deferred');
    expect(await s.applyOnce('terminal:x', eff)).toBe('deferred');
  });
  it('unwiredKeyedEffects:调用即抛 PortNotWired(fail-closed)', async () => {
    await expect(unwiredKeyedEffects.applyOnce('k', eff)).rejects.toBeInstanceOf(PortNotWired);
  });
});

describe('生产写组装 productionWritePorts:只接了用户标记端口,其余一律缺失(未接线)', () => {
  it('字段 = config / userMarker / outputForbidden;[rsi] 无配置 = 合法关闭(rsiOn=false)', async () => {
    const ctx = {
      argv: [],
      env: { KIT_REAL_HOME_OVERRIDE: '/nonexistent-home-w8b' },
      cwd: '/',
      stdout: () => undefined,
      stderr: () => undefined,
    } as unknown as RsiEarlyContext;
    const p = await productionWritePorts(ctx);
    expect(Object.keys(p).sort()).toEqual(['config', 'outputForbidden', 'userMarker']);
    expect(await p.config?.()).toEqual({ rsiOn: false });
    // 关闭时没有仓库 `.state`:打开用户标记端口 fail-closed(调用方先判 rsiOn,不会走到)
    await expect(p.userMarker?.()).rejects.toThrow();
  });
});
