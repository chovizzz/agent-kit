/**
 * R20-A4:digest 槽位与槽位锁(docs/contracts.md R20-16.10 / R20-16.12 / R20-16.13 / R20-16.25 槽位那几行)。
 * 真实 A1 锁实现;多进程争用用真子进程(由 vite 打成单文件再 node 跑,同 lock-procs.test.ts)。
 * 注意:A1 锁在陈旧锁回收时有已登记的双持有窗口(R20-16.10),这里**不**断言「双持有不可达」,只断言正常争用下不交错,以及窗口的两种触发(pid 已死 / 空锁超宽限)确实可回收。
 */
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RSI_DIGEST_SLOT_COUNT,
  RSI_DIGEST_SLOT_NAME_RE,
  slotName,
  type RsiDigestRecord,
} from '../../src/contracts/rsi.js';
import { exists, readDir, readText } from '../../src/io/read-fs.js';
import { chmod, hardlink, mkdirp, remove, symlink, writeFile } from '../../src/io/safe-fs.js';
import {
  abandonSlot,
  acquireDigestsLock,
  cleanupSlots,
  findDigest,
  invalidateDigests,
  publishSlot,
  readSlot,
  removeDigestIfSame,
  reserveSlot,
  revokeAllSlots,
  withDigestsLock,
} from '../../src/rsi/digest-slots.js';
import { RsiLockError, acquireRsiLock } from '../../src/rsi/lock.js';
import { createIoContext } from '../../src/io/paths.js';
import { REPO_ROOT, makeTempDir } from '../helpers/tmp.js';
import { newWork, type Work } from '../signals/helpers.js';
import { buildChild, runChild, startChild, mkfifo, touchAt } from './proc/helper.js';

const NOW = new Date('2026-10-26T12:00:00.000Z');
const at = (min: number): Date => new Date(NOW.getTime() + min * 60_000);
const dirOf = (w: Work): string => path.join(w.state, 'rsi', 'digests');

function record(id: string, over: Partial<RsiDigestRecord> = {}): RsiDigestRecord {
  return {
    digest_id: `d_${id.padStart(16, '0')}`,
    created_at: NOW.toISOString(),
    expires_at: at(24 * 60).toISOString(),
    agent: 'claude',
    project_key: 'p_aaaaaaaaaaaaaaaa',
    aliases: { e1: 'sig_0000000000000001' },
    session_policy_fp: 'f'.repeat(64),
    snapshot_generation: 1,
    ...over,
  };
}

/** 预留 + 发布一份 digest,返回槽位号 */
async function issue(
  w: Work,
  id: string,
  now = NOW,
  over: Partial<RsiDigestRecord> = {},
): Promise<number> {
  return withDigestsLock(w.io, async (lock) => {
    const r = await reserveSlot(w.io, lock, now);
    if (r === null) throw new Error('backlog');
    expect(await publishSlot(w.io, lock, r, record(id, over))).toBe('published');
    return r.slot;
  });
}

const names = async (w: Work): Promise<string[]> =>
  (await readDir(dirOf(w))).map((e) => e.name).sort();

describe('预留 / 发布 / 放弃(R20-16.10 协议)', () => {
  it('预留取序号最小的空位,写 {reserved, at};发布后槽位内容是 digest 记录(sha256 = 文件字节)', async () => {
    const w = await newWork('a4-slot-basic-');
    await withDigestsLock(w.io, async (lock) => {
      const a = await reserveSlot(w.io, lock, NOW);
      const b = await reserveSlot(w.io, lock, NOW);
      expect([a?.slot, b?.slot]).toEqual([0, 1]);
      const raw = JSON.parse(await readText(path.join(dirOf(w), 's00.json'))) as Record<
        string,
        string
      >;
      expect(raw['reserved']).toBe(a?.token);
      expect(raw['at']).toBe(NOW.toISOString());
      expect((await readSlot(dirOf(w), 0)).kind).toBe('reserved');
      expect(await publishSlot(w.io, lock, a!, record('1'))).toBe('published');
      const c = await readSlot(dirOf(w), 0);
      expect(c.kind).toBe('digest');
      expect(await names(w)).toEqual(['lock', 's00.json', 's01.json']); // 没有残留临时文件
    });
  });

  it('放弃只删本进程 token 的预留;别人的预留 / 已发布的 digest 不动', async () => {
    const w = await newWork('a4-slot-abandon-');
    await withDigestsLock(w.io, async (lock) => {
      const a = (await reserveSlot(w.io, lock, NOW))!;
      const b = (await reserveSlot(w.io, lock, NOW))!;
      expect(await abandonSlot(w.io, lock, { slot: a.slot, token: b.token })).toBe(false); // token 不符
      expect(await abandonSlot(w.io, lock, a)).toBe(true);
      expect((await readSlot(dirOf(w), a.slot)).kind).toBe('empty');
      expect(await publishSlot(w.io, lock, b, record('2'))).toBe('published');
      expect(await abandonSlot(w.io, lock, b)).toBe(false); // 已是 digest,不是预留
      expect((await readSlot(dirOf(w), b.slot)).kind).toBe('digest');
    });
  });

  it('20 个槽位占满 → 无空位(null = digest_backlog);清理掉过期的之后又有空位', async () => {
    const w = await newWork('a4-slot-full-');
    await withDigestsLock(w.io, async (lock) => {
      for (let i = 0; i < RSI_DIGEST_SLOT_COUNT; i++)
        expect((await reserveSlot(w.io, lock, NOW))?.slot).toBe(i);
      expect(await reserveSlot(w.io, lock, NOW)).toBeNull();
      // 10 分钟后预留过期被清理(预留超过 10 分钟仍未发布)
      expect((await reserveSlot(w.io, lock, at(11)))?.slot).toBe(0);
      expect(await names(w)).toEqual(['lock', 's00.json']); // 其余 19 个过期预留已被清理
    });
  });
});

describe('清理(R20-16.10 ①)', () => {
  it('删过期 digest 与过期预留;未过期的、读不过的槽位不删', async () => {
    const w = await newWork('a4-slot-clean-');
    await issue(w, '1'); // s00 过期时间 = NOW + 24h
    await issue(w, '2', NOW, { expires_at: at(5).toISOString() }); // s01 5 分钟后过期
    await withDigestsLock(w.io, async (lock) => {
      await reserveSlot(w.io, lock, NOW); // s02 预留
      expect(await cleanupSlots(w.io, lock, at(1))).toBe(0);
      expect(await cleanupSlots(w.io, lock, at(6))).toBe(1); // s01 过期
      expect((await readSlot(dirOf(w), 1)).kind).toBe('empty');
      expect(await cleanupSlots(w.io, lock, at(11))).toBe(1); // s02 预留超过 10 分钟
      expect((await readSlot(dirOf(w), 0)).kind).toBe('digest');
      expect(await cleanupSlots(w.io, lock, at(24 * 60 + 1))).toBe(1); // s00 过期
    });
  });

  it('安全读取:符号链接 / FIFO / 硬链接 / 超大文件 → invalid(不跟随、不挂住);清理跳过不删;查找不命中', async () => {
    const w = await newWork('a4-slot-unsafe-');
    const real = await issue(w, '1'); // s00 是真 digest,用来造硬链接
    expect(real).toBe(0);
    const d = dirOf(w);
    await writeFile(w.io, path.join(w.state, 'outside.json'), JSON.stringify(record('9')), {
      mode: 0o600,
    });
    await symlink(w.io, path.join(w.state, 'outside.json'), path.join(d, 's01.json'));
    mkfifo(path.join(d, 's02.json'));
    await writeFile(w.io, path.join(d, 's03.json'), 'x'.repeat(70 * 1024), { mode: 0o600 });
    await writeFile(w.io, path.join(w.state, 'outside2.json'), JSON.stringify(record('8')), {
      mode: 0o600,
    });
    await hardlink(w.io, path.join(w.state, 'outside2.json'), path.join(d, 's04.json')); // nlink == 2
    await writeFile(w.io, path.join(d, 's05.json'), '{"nope":1}', { mode: 0o600 });
    await writeFile(w.io, path.join(d, 's06.json'), JSON.stringify(record('7')), { mode: 0o644 }); // 权限宽于 0600
    for (const n of [1, 2, 3, 5, 6])
      expect((await readSlot(d, n)).kind, slotName(n)).toBe('invalid');
    await withDigestsLock(w.io, async (lock) => {
      expect(await findDigest(w.io, lock, record('9').digest_id)).toBeNull(); // 链接指向的内容不被采信
      expect(await findDigest(w.io, lock, record('7').digest_id)).toBeNull();
      await cleanupSlots(w.io, lock, at(48 * 60)); // 远超过期:合法的 s00 被删,读不过的一个不删
    });
    expect((await readSlot(d, 0)).kind).toBe('empty');
    for (const n of [1, 2, 3, 5, 6])
      expect(await exists(path.join(d, slotName(n))), slotName(n)).toBe(true);
  });
});

describe('ABA(R20-16.25):槽位被回收再复用之后,旧持有者不能覆盖或删除新持有者的文件', () => {
  it('A 预留后暂停超过 10 分钟 → 槽位被回收并由 B 预留 / 发布;A 恢复后发布与放弃都不改动 B 的文件', async () => {
    const w = await newWork('a4-slot-aba-');
    const a = await withDigestsLock(w.io, (lock) => reserveSlot(w.io, lock, NOW));
    expect(a?.slot).toBe(0);
    // B 在 11 分钟后:清理回收 A 的预留,B 拿到同一槽位并发布
    await withDigestsLock(w.io, async (lock) => {
      const b = (await reserveSlot(w.io, lock, at(11)))!;
      expect(b.slot).toBe(0);
      expect(b.token).not.toBe(a!.token);
      expect(
        await publishSlot(
          w.io,
          lock,
          b,
          record('b', { expires_at: at(24 * 60 + 11).toISOString() }),
        ),
      ).toBe('published');
    });
    const before = await readText(path.join(dirOf(w), 's00.json'));
    await withDigestsLock(w.io, async (lock) => {
      expect(await publishSlot(w.io, lock, a!, record('a'))).toBe('lost');
      expect(await abandonSlot(w.io, lock, a!)).toBe(false);
    });
    expect(await readText(path.join(dirOf(w), 's00.json'))).toBe(before);
  });

  it('ingest 第 3 步之后槽位被 --revoke 再被新 digest 复用 → 第 5 步(removeDigestIfSame)返回 gone,新 digest 不受影响', async () => {
    const w = await newWork('a4-slot-revoke-reuse-');
    await issue(w, '1');
    const found = (await withDigestsLock(w.io, (lock) =>
      findDigest(w.io, lock, record('1').digest_id),
    ))!;
    await withDigestsLock(w.io, (lock) => revokeAllSlots(w.io, lock));
    expect(await issue(w, '2')).toBe(0); // 新 digest 复用同一槽位
    const before = await readText(path.join(dirOf(w), 's00.json'));
    const r = await withDigestsLock(w.io, (lock) => removeDigestIfSame(w.io, lock, found));
    expect(r).toBe('gone');
    expect(await readText(path.join(dirOf(w), 's00.json'))).toBe(before);
    // 正向对照:内容一致时确实删除
    const again = (await withDigestsLock(w.io, (lock) =>
      findDigest(w.io, lock, record('2').digest_id),
    ))!;
    expect(await withDigestsLock(w.io, (lock) => removeDigestIfSame(w.io, lock, again))).toBe(
      'removed',
    );
    expect(await exists(path.join(dirOf(w), 's00.json'))).toBe(false);
  });
});

describe('--revoke 与观察性作废', () => {
  it('revokeAll 删掉全部槽位文件(含预留与读不过的),不动锁文件', async () => {
    const w = await newWork('a4-slot-revokeall-');
    await issue(w, '1');
    await withDigestsLock(w.io, async (lock) => {
      await reserveSlot(w.io, lock, NOW);
      await writeFile(w.io, path.join(dirOf(w), 's05.json'), 'garbage', { mode: 0o600 });
      expect(await revokeAllSlots(w.io, lock)).toBe(3);
    });
    expect((await names(w)).filter((n) => RSI_DIGEST_SLOT_NAME_RE.test(n))).toEqual([]);
  });

  it('invalidateDigests:只删命中的已发布 digest,不删预留;没有 digests/ 目录时不建目录', async () => {
    const w = await newWork('a4-slot-inval-');
    expect(await invalidateDigests(w.io, () => true)).toBe(0);
    expect(await exists(dirOf(w))).toBe(false); // 零写入
    await issue(w, '1', NOW, { agent: 'claude' });
    await issue(w, '2', NOW, { agent: 'codex' });
    await withDigestsLock(w.io, (lock) => reserveSlot(w.io, lock, NOW)); // s02 预留
    expect(await invalidateDigests(w.io, (r) => r.agent === 'codex')).toBe(1);
    expect((await readSlot(dirOf(w), 0)).kind).toBe('digest');
    expect((await readSlot(dirOf(w), 1)).kind).toBe('empty');
    expect((await readSlot(dirOf(w), 2)).kind).toBe('reserved');
    expect(await invalidateDigests(w.io, () => true)).toBe(1); // 预留不算
  });

  it('槽位锁被占时,观察性作废跳过(不等待、不抛错)', async () => {
    const w = await newWork('a4-slot-inval-busy-');
    await issue(w, '1');
    const held = await acquireDigestsLock(w.io);
    try {
      // 同进程内再取会因「不重入」直接失败 → 被当作拿不到锁而跳过
      expect(await invalidateDigests(w.io, () => true)).toBe(0);
    } finally {
      await held.release();
    }
    expect((await readSlot(dirOf(w), 0)).kind).toBe('digest');
  });
});

describe('每个写出口前 assertHeld()(R20-16.10;token 复读不能代替失锁复核)', () => {
  it('失锁后:消费的 unlink 不再执行,槽位文件原样保留', async () => {
    const w = await newWork('a4-slot-lost-');
    await issue(w, '1');
    const found = (await withDigestsLock(w.io, (lock) =>
      findDigest(w.io, lock, record('1').digest_id),
    ))!;
    const err = await withDigestsLock(w.io, (lock) =>
      removeDigestIfSame(w.io, lock, found, {
        hooks: {
          point: async (n) => {
            if (n === 'unlink:s00.json') await remove(w.io, path.join(dirOf(w), 'lock')); // 锁被夺走
          },
        },
      }),
    ).catch((e: unknown) => e);
    expect((err as RsiLockError).kind).toBe('lock_lost');
    expect(await exists(path.join(dirOf(w), 's00.json'))).toBe(true);
  });

  it('失锁后:预留的创建、发布的 rename 都不再执行', async () => {
    const w = await newWork('a4-slot-lost2-');
    const e1 = await withDigestsLock(w.io, (lock) =>
      reserveSlot(w.io, lock, NOW, {
        hooks: { point: async () => void (await remove(w.io, path.join(dirOf(w), 'lock'))) },
      }),
    ).catch((e: unknown) => e);
    expect((e1 as RsiLockError).kind).toBe('lock_lost');
    expect((await names(w)).filter((n) => RSI_DIGEST_SLOT_NAME_RE.test(n))).toEqual([]);

    const r = await withDigestsLock(w.io, (lock) => reserveSlot(w.io, lock, NOW));
    const e2 = await withDigestsLock(w.io, (lock) =>
      publishSlot(w.io, lock, r!, record('1'), {
        hooks: {
          point: async (n) => {
            if (n === 'publish:rename') await remove(w.io, path.join(dirOf(w), 'lock'));
          },
        },
      }),
    ).catch((e: unknown) => e);
    expect((e2 as RsiLockError).kind).toBe('lock_lost');
    expect((await readSlot(dirOf(w), r!.slot)).kind).toBe('reserved'); // 预留原样,没有被覆盖
  });
});

describe('锁序与取锁(R20-16.10)', () => {
  it('持槽位锁时再取 rsi/lock → internal(锁序 rsi/lock → digests/lock);反序合法', async () => {
    const w = await newWork('a4-slot-order-');
    const d = await acquireDigestsLock(w.io);
    try {
      const e = await acquireRsiLock(w.io).catch((x: unknown) => x);
      expect((e as RsiLockError).kind).toBe('internal');
    } finally {
      await d.release();
    }
    const r = await acquireRsiLock(w.io);
    try {
      const d2 = await acquireDigestsLock(w.io); // 先 rsi 后 digests:合法
      await d2.release();
    } finally {
      await r.release();
    }
  });

  it('槽位锁被占:每 50ms 试一次、最多等 2 秒,仍拿不到 → locked(注入时钟,不真等)', async () => {
    const w = await newWork('a4-slot-wait-');
    const held = await acquireDigestsLock(w.io);
    try {
      // 同进程内再取:A1 的「不重入」报 internal,不是占用;用另一个 pid 的新鲜锁文件模拟「别的进程持有」
      await held.release();
      const f = path.join(dirOf(w), 'lock');
      const doc = {
        pid: process.ppid,
        started_at: new Date().toISOString(),
        nonce: 'f'.repeat(16),
        kit_version: '0.0.0',
      };
      await writeFile(w.io, f, JSON.stringify(doc), { mode: 0o600 });
      let t = 0;
      let sleeps = 0;
      const err = await acquireDigestsLock(w.io, {
        clockMs: () => t,
        sleep: async (ms) => {
          sleeps++;
          t += ms;
        },
      }).catch((e: unknown) => e);
      expect((err as RsiLockError).kind).toBe('locked');
      expect(sleeps).toBeGreaterThanOrEqual(39);
      expect(sleeps).toBeLessThanOrEqual(41);
    } finally {
      await remove(w.io, path.join(dirOf(w), 'lock'));
    }
  });

  it('陈旧锁的两种可回收触发:持锁 pid 已死;活进程创建空锁后暂停超过 10 秒(宽限内仍被占)', async () => {
    const w = await newWork('a4-slot-stale-');
    const f = path.join(dirOf(w), 'lock');
    await mkdirp(w.io, dirOf(w), 0o700);
    // (a) pid 已死
    const dead = {
      pid: 4_000_000,
      started_at: new Date().toISOString(),
      nonce: 'e'.repeat(16),
      kit_version: '0.0.0',
    };
    await writeFile(w.io, f, JSON.stringify(dead), { mode: 0o600 });
    const got = await acquireDigestsLock(w.io, { lock: { isAlive: () => false } });
    await got.release();
    // (b) 空锁:宽限内被占,超过 10 秒可回收
    await writeFile(w.io, f, '', { mode: 0o600 });
    let t = 0;
    const e = await acquireDigestsLock(w.io, {
      clockMs: () => t,
      sleep: async (ms) => void (t += ms),
    }).catch((x: unknown) => x);
    expect((e as RsiLockError).kind).toBe('locked');
    touchAt(f, new Date(Date.now() - 60_000));
    const got2 = await acquireDigestsLock(w.io);
    await got2.release();
  });
});

describe('真进程多进程争用(R20-16.25:正常争用下清理与预留不交错)', () => {
  let script = '';
  beforeAll(async () => {
    const { dir } = await makeTempDir('a4-slot-build-');
    script = await buildChild(dir);
  }, 120_000);
  afterAll(() => undefined);

  it('持槽位锁的真子进程在时:本进程被拒(locked);子进程被杀后锁被回收', async () => {
    const w = await newWork('a4-slot-proc-hold-');
    const holder = startChild(script, { op: 'dhold', tmp: w.dir, state: w.state });
    try {
      const first = JSON.parse(await holder.firstLine()) as { held?: boolean };
      expect(first.held).toBe(true);
      let t = 0;
      const err = await acquireDigestsLock(w.io, {
        clockMs: () => t,
        sleep: async (ms) => void (t += ms),
      }).catch((x: unknown) => x);
      expect((err as RsiLockError).kind).toBe('locked');
    } finally {
      holder.child.kill('SIGKILL');
      await holder.exited;
    }
    const got = await acquireDigestsLock(w.io); // pid 已死 → 回收
    await got.release();
  });

  it('19 个槽位已占、两个真进程同时预留 → 恰一个拿到 s19,另一个 backlog(null)', async () => {
    const w = await newWork('a4-slot-proc-race-');
    await withDigestsLock(w.io, async (lock) => {
      for (let i = 0; i < RSI_DIGEST_SLOT_COUNT - 1; i++) await reserveSlot(w.io, lock, new Date());
    });
    const startAt = Date.now() + 1500;
    const nowMs = Date.now();
    const [a, b] = await Promise.all([
      runChild(script, { op: 'dreserve', tmp: w.dir, state: w.state, startAt, nowMs }),
      runChild(script, { op: 'dreserve', tmp: w.dir, state: w.state, startAt, nowMs }),
    ]);
    const slots = [...a, ...b].map((x) => (x as { slot?: number | null; error?: string }).slot);
    expect([...a, ...b].some((x) => 'error' in (x as object))).toBe(false);
    expect(slots.filter((s) => s === 19)).toHaveLength(1);
    expect(slots.filter((s) => s === null)).toHaveLength(1);
  }, 60_000);
});

describe('持锁后的目录访问不得写(R20-16.10:拿锁之前的目录初始化与持锁后的业务访问分开)', () => {
  /** 带写审计的 io(同一个状态目录) */
  function auditedIo(w: Work, audit: string[]) {
    return createIoContext({
      cwd: REPO_ROOT,
      env: { KIT_TMP: w.dir, KIT_STATE_DIR: w.state, PATH: '/usr/bin:/bin' },
      writeAudit: (op, p) => void audit.push(`${op} ${p}`),
    });
  }
  const WRITES = /^(mkdirp|chmod|writeFile|createExclusive|rename|remove|fsyncDir)/;
  for (const [name, wipe] of [
    ['锁文件被夺走', (w: Work) => remove(w.io, path.join(dirOf(w), 'lock'))],
    ['purge 删掉了整个 digests/', (w: Work) => remove(w.io, dirOf(w))],
  ] as const) {
    it(`进入目录访问之前失锁(${name})→ lock_lost,没有新的 mkdir / chmod / 文件写;目录不被重建`, async () => {
      const w = await newWork('a4-slot-dirlost-');
      const audit: string[] = [];
      const io = auditedIo(w, audit);
      const lock = await acquireDigestsLock(io);
      try {
        await wipe(w);
        audit.length = 0;
        const e = await reserveSlot(io, lock, NOW).catch((x: unknown) => x);
        expect((e as RsiLockError).kind).toBe('lock_lost');
        expect(audit.filter((a) => WRITES.test(a))).toEqual([]);
        if (name !== '锁文件被夺走') expect(await exists(dirOf(w))).toBe(false);
        for (const f of [
          () => cleanupSlots(io, lock, NOW),
          () => revokeAllSlots(io, lock),
          () => findDigest(io, lock, 'd_0123456789abcdef'),
        ]) {
          expect(((await f().catch((x: unknown) => x)) as RsiLockError).kind).toBe('lock_lost');
        }
        expect(audit.filter((a) => WRITES.test(a))).toEqual([]);
      } finally {
        await lock.release();
      }
    });
  }
  it('持锁时目录被换成别人可写的(组可写)→ state_dir_unsafe(只读校验,不 chmod 修正)', async () => {
    const w = await newWork('a4-slot-dirperm-');
    const audit: string[] = [];
    const io = auditedIo(w, audit);
    const lock = await acquireDigestsLock(io);
    try {
      await chmod(w.io, dirOf(w), 0o770);
      audit.length = 0;
      const e = await reserveSlot(io, lock, NOW).catch((x: unknown) => x);
      expect((e as RsiLockError).kind).toBe('state_dir_unsafe');
      expect(audit.filter((a) => WRITES.test(a))).toEqual([]);
    } finally {
      await lock.release();
    }
  });
});
