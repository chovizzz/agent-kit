/**
 * W5 `canary.json` 写入方(R21-6.10、R21-9.5「对账先于授予」、R21-10.1、M13-4):
 * 授予在两把锁内重读撤销凭据与权威记录;写之前复核锁;名额被别的候选占用 / 候选被撤销 / 文档越界一律不写。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, lstat, readText } from '../../../src/io/read-fs.js';
import {
  grantCanary,
  reconcileCaches,
  muteCanary,
  removeCanary,
  type CanaryWriterDeps,
  type GrantInput,
} from '../../../src/rsi/canary/canary-writer.js';
import type { RevocationRead } from '../../../src/rsi/personal/candidate-ports.js';
import { writeFile } from '../../../src/io/safe-fs.js';
import { revocationRefOf } from '../../../src/rsi/canary/files.js';
import { appendStopLine } from '../../../src/rsi/canary/ledger.js';
import { MemStore } from '../personal/w3-fixture.js';
import { SHA as TSHA, entry, rec } from '../personal/transition-fixture.js';
import {
  BODY,
  CID,
  canaryDoc,
  OTHER_CID,
  POLICY,
  REVOKE,
  SHA,
  makeCanaryWorld,
  type CanaryWorld,
} from './w5-fixture.js';

const GRANT: GrantInput = {
  candidate_id: CID,
  content_sha256: SHA,
  p_by_agent: { claude: 0.5 },
  agents_inject: ['claude'],
  background_fp: '1'.repeat(16),
  background_fp_ex: '2'.repeat(16),
  policy_fp: POLICY,
};

interface Rig {
  w: CanaryWorld;
  d: CanaryWriterDeps;
  store: MemStore;
  revs: { value: RevocationRead };
  asserts: { rsi: number; personal: number };
  /** 权威正文来源(测试可改;null = 拿不到) */
  body: { value: string | null };
}

async function rig(o: { rsiFailAt?: number; personalFailAt?: number } = {}): Promise<Rig> {
  const w = await makeCanaryWorld('w5-writer-');
  const store = new MemStore();
  store.put(rec('canary'));
  const revs: { value: RevocationRead } = { value: { kind: 'ok', lines: [] } };
  const asserts = { rsi: 0, personal: 0 };
  const body: { value: string | null } = { value: BODY };
  const mk = (k: 'rsi' | 'personal', failAt: number | undefined) => async (): Promise<void> => {
    asserts[k]++;
    if (failAt !== undefined && asserts[k] >= failAt) throw new Error('lock_lost');
  };
  return {
    w,
    store,
    revs,
    asserts,
    body,
    d: {
      io: w.io,
      rsiDir: w.rsi,
      locks: {
        rsi: { assertHeld: mk('rsi', o.rsiFailAt) },
        personal: { assertHeld: mk('personal', o.personalFailAt) },
      },
      revocations: { read: async () => revs.value },
      store,
      bodyOf: async () => body.value,
    },
  };
}

const file = (r: Rig): string => path.join(r.w.rsi, 'canary.json');

describe('grantCanary:授予', () => {
  it('overlaps_preset 取权威记录里该候选 G4 的结果(调用方不能自带);true / false 各一', async () => {
    for (const v of [true, false]) {
      const r = await rig();
      r.store.put(rec('canary', { overlaps_preset: v }));
      expect((await grantCanary(r.d, GRANT)).kind).toBe('written');
      const doc = JSON.parse(await readText(file(r))) as { overlaps_preset: boolean };
      expect(doc.overlaps_preset).toBe(v);
    }
  });

  it('成功:0600、十二键齐全、generation 从 1 起、revocation_gen = 写入时撤销凭据的行数;再次授予 generation + 1', async () => {
    const r = await rig();
    r.revs.value = {
      kind: 'ok',
      lines: [REVOKE(OTHER_CID, 'd'.repeat(64)), REVOKE(OTHER_CID, 'e'.repeat(64))],
    };
    await reconcileCaches(r.d, r.revs.value.kind === 'ok' ? r.revs.value.lines : [], new Date());
    const res = await grantCanary(r.d, GRANT);
    expect(res.kind).toBe('written');
    const doc = JSON.parse(await readText(file(r))) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(
      [
        'agents_inject',
        'background_fp',
        'background_fp_ex',
        'body',
        'candidate_id',
        'content_sha12',
        'content_sha256',
        'generation',
        'p_by_agent',
        'policy_fp',
        'revocation_gen',
        'overlaps_preset',
      ].sort(),
    );
    expect(doc['generation']).toBe(1);
    expect(doc['revocation_gen']).toBe(2);
    expect(doc['content_sha12']).toBe('a'.repeat(12));
    expect((await lstat(file(r))).mode & 0o777).toBe(0o600);
    expect((await grantCanary(r.d, GRANT)).kind).toBe('written');
    expect((JSON.parse(await readText(file(r))) as { generation: number }).generation).toBe(2);
  });

  it('对账先于授予:撤销凭据列出该候选 → 拒绝、不写;列的是别的候选 / 别的内容哈希 → 不影响', async () => {
    const r = await rig();
    r.revs.value = { kind: 'ok', lines: [REVOKE()] };
    expect(await grantCanary(r.d, GRANT)).toEqual({ kind: 'refused', reason: 'revoked' });
    expect(await exists(file(r))).toBe(false);
    r.revs.value = { kind: 'ok', lines: [REVOKE(CID, 'd'.repeat(64)), REVOKE(OTHER_CID, SHA)] };
    await reconcileCaches(r.d, r.revs.value.lines, new Date());
    expect((await grantCanary(r.d, GRANT)).kind).toBe('written');
  });

  it('对账屏障(R21-9.5):A 已终态但 canary.json 残留、stop 行未补 → 授予 B 被拒;对账完成后允许', async () => {
    const r = await rig();
    const A = OTHER_CID;
    const SA = 'd'.repeat(64);
    r.store.put(rec('rejected', { id: A, content_sha256: SA }));
    await writeFile(
      r.w.io,
      file(r),
      JSON.stringify(canaryDoc({ candidate_id: A, content_sha256: SA })),
      {
        mode: 0o600,
      },
    );
    r.revs.value = { kind: 'ok', lines: [REVOKE(A, SA)] };
    expect(await grantCanary(r.d, GRANT)).toEqual({
      kind: 'refused',
      reason: 'reconcile_incomplete',
    });
    expect((JSON.parse(await readText(file(r))) as { candidate_id: string }).candidate_id).toBe(A);
    // 只补 stop 行、缓存仍残留 → 仍拒绝
    await appendStopLine(r.w.io, r.w.rsi, r.d.locks.rsi, {
      kind: 'stop',
      at: '2026-11-10T12:00:00Z',
      candidate_id: A,
      reason: 'revocation_reconciled',
      revocation_ref: revocationRefOf(REVOKE(A, SA)),
    });
    expect(await grantCanary(r.d, GRANT)).toEqual({
      kind: 'refused',
      reason: 'reconcile_incomplete',
    });
    await reconcileCaches(r.d, [REVOKE(A, SA)], new Date());
    expect((await grantCanary(r.d, GRANT)).kind).toBe('written');
  });

  it('对账屏障:有凭据而分组账不存在 / 为空 → 拒绝授予(账不存在不等于已补 stop);reconcileCaches 补 stop 后允许', async () => {
    const A = OTHER_CID;
    const SA = 'd'.repeat(64);
    const ledgerFile = (x: Awaited<ReturnType<typeof rig>>): string =>
      path.join(x.w.rsi, 'canary-ledger.jsonl');
    // 账不存在:A 已终态、canary.json 不含 A,唯一缺的是 stop 行
    const r = await rig();
    r.store.put(rec('rejected', { id: A, content_sha256: SA }));
    r.revs.value = { kind: 'ok', lines: [REVOKE(A, SA)] };
    expect(await exists(ledgerFile(r))).toBe(false);
    expect(await grantCanary(r.d, GRANT)).toEqual({
      kind: 'refused',
      reason: 'reconcile_incomplete',
    });
    expect(await exists(file(r))).toBe(false);
    await reconcileCaches(r.d, [REVOKE(A, SA)], new Date());
    expect((await grantCanary(r.d, GRANT)).kind).toBe('written');
    // 账为空文件:同样拒绝
    const r2 = await rig();
    r2.store.put(rec('rejected', { id: A, content_sha256: SA }));
    r2.revs.value = { kind: 'ok', lines: [REVOKE(A, SA)] };
    await writeFile(r2.w.io, ledgerFile(r2), '', { mode: 0o600 });
    expect(await grantCanary(r2.d, GRANT)).toEqual({
      kind: 'refused',
      reason: 'reconcile_incomplete',
    });
  });

  it('对账屏障:凭据列出的候选权威记录仍非终态 → 拒绝授予别的候选;账不合规同样拒绝', async () => {
    const r = await rig();
    r.store.put(rec('shadow', { id: OTHER_CID, content_sha256: 'd'.repeat(64) }));
    r.revs.value = { kind: 'ok', lines: [REVOKE(OTHER_CID, 'd'.repeat(64))] };
    await reconcileCaches(r.d, r.revs.value.lines, new Date());
    expect(await grantCanary(r.d, GRANT)).toEqual({
      kind: 'refused',
      reason: 'reconcile_incomplete',
    });
    const r2 = await rig();
    r2.revs.value = { kind: 'ok', lines: [REVOKE(OTHER_CID, 'd'.repeat(64))] };
    await writeFile(r2.w.io, path.join(r2.w.rsi, 'canary-ledger.jsonl'), 'bad\n', { mode: 0o600 });
    expect(await grantCanary(r2.d, GRANT)).toEqual({
      kind: 'refused',
      reason: 'reconcile_incomplete',
    });
  });

  it('空凭据集 + 不合规账 → 拒绝授予(坏账不因没有凭据而绕过);空凭据集 + 账不存在 → 允许', async () => {
    const r = await rig();
    await writeFile(r.w.io, path.join(r.w.rsi, 'canary-ledger.jsonl'), 'bad\n', { mode: 0o600 });
    expect(await grantCanary(r.d, GRANT)).toEqual({
      kind: 'refused',
      reason: 'reconcile_incomplete',
    });
    expect(await exists(file(r))).toBe(false);
    const r2 = await rig();
    expect((await grantCanary(r2.d, GRANT)).kind).toBe('written');
  });

  it('不可读缓存恢复:坏 JSON 缓存 + 已对账的历史凭据 → 授予被拒;对账清理移除不可读缓存后可恢复', async () => {
    const r = await rig();
    const A = OTHER_CID;
    const SA = 'd'.repeat(64);
    r.store.put(rec('rejected', { id: A, content_sha256: SA }));
    r.revs.value = { kind: 'ok', lines: [REVOKE(A, SA)] };
    await writeFile(r.w.io, file(r), '{bad', { mode: 0o600 });
    await appendStopLine(r.w.io, r.w.rsi, r.d.locks.rsi, {
      kind: 'stop',
      at: '2026-11-10T12:00:00Z',
      candidate_id: A,
      reason: 'revocation_reconciled',
      revocation_ref: revocationRefOf(REVOKE(A, SA)),
    });
    expect(await grantCanary(r.d, GRANT)).toEqual({
      kind: 'refused',
      reason: 'reconcile_incomplete',
    });
    await reconcileCaches(r.d, [REVOKE(A, SA)], new Date());
    expect((await grantCanary(r.d, GRANT)).kind).toBe('written');
  });

  it('M2 adopted 期:本块只给 canary 授予;adopted 候选(V2 推进路径)→ 拒绝(fail-closed,留端口)', async () => {
    const r = await rig();
    r.store.put(rec('adopted', { deploy: { claude: 'injected', pi: 'none', codex: 'none' } }));
    expect(await grantCanary(r.d, GRANT)).toEqual({
      kind: 'refused',
      reason: 'candidate_not_canary',
    });
  });

  it('撤销凭据读不到(invalid)→ 拒绝、不写(不是「没有撤销」)', async () => {
    const r = await rig();
    r.revs.value = { kind: 'invalid', why: 'parse' };
    expect(await grantCanary(r.d, GRANT)).toEqual({
      kind: 'refused',
      reason: 'revocations_invalid',
    });
    expect(await exists(file(r))).toBe(false);
  });

  it('M13-4 名额互斥:别的候选已占用评估名额(canary)→ 拒绝;候选自己在 canary 不算占用', async () => {
    const r = await rig();
    r.store.put(rec('canary', { id: OTHER_CID, transitions: [entry(1), entry(2, 'canary')] }));
    expect(await grantCanary(r.d, GRANT)).toEqual({ kind: 'refused', reason: 'slot_occupied' });
    expect(await exists(file(r))).toBe(false);
    // 别的候选只是 shadow(不占名额)→ 通过
    const r2 = await rig();
    r2.store.put(rec('shadow', { id: OTHER_CID }));
    expect((await grantCanary(r2.d, GRANT)).kind).toBe('written');
  });

  it('候选不在 canary(shadow / 缺失)或内容哈希已变 → 拒绝', async () => {
    const r = await rig();
    r.store.put(rec('shadow'));
    expect(await grantCanary(r.d, GRANT)).toEqual({
      kind: 'refused',
      reason: 'candidate_not_canary',
    });
    expect(await grantCanary(r.d, { ...GRANT, candidate_id: OTHER_CID })).toEqual({
      kind: 'refused',
      reason: 'candidate_not_canary',
    });
    const r2 = await rig();
    r2.store.put(rec('canary', { content_sha256: 'e'.repeat(64) }));
    expect(await grantCanary(r2.d, GRANT)).toEqual({ kind: 'refused', reason: 'content_changed' });
    expect(TSHA).toBe(SHA);
  });

  it('私有仓库读不到(absent / deferred / invalid)→ 拒绝', async () => {
    for (const mode of ['absent', 'deferred', 'invalid'] as const) {
      const r = await rig();
      r.store.mode = mode;
      expect(await grantCanary(r.d, GRANT)).toEqual({ kind: 'refused', reason: 'repo_unreadable' });
      expect(await exists(file(r))).toBe(false);
    }
  });

  const bad: [string, string | null, Partial<GrantInput>, string][] = [
    [
      '正文含关联标记前缀',
      '做:x\nagent-kit RSI 关联标记: rsm_0000000000000000',
      {},
      'body_has_marker_prefix',
    ],
    ['treat 输出超过 1536 字节', '中'.repeat(500), {}, 'treat_over_budget'],
    ['在列的 agent 没有 p', null, { p_by_agent: {} }, 'p_missing'],
    ['p_by_agent 有多余项', null, { p_by_agent: { claude: 0.5, pi: 0.5 } }, 'p_without_inject'],
  ];
  it.each(bad)('文档越界不写:%s', async (_n, body, over, code) => {
    const r = await rig();
    if (body !== null) r.body.value = body;
    expect(await grantCanary(r.d, { ...GRANT, ...over })).toEqual({
      kind: 'refused',
      reason: `doc_invalid:${code}`,
    });
    expect(await exists(file(r))).toBe(false);
  });

  it('schema 不合(正文为空 / p 越界)→ 不写', async () => {
    const r = await rig();
    r.body.value = '';
    expect((await grantCanary(r.d, GRANT)).kind).toBe('refused');
    r.body.value = BODY;
    expect((await grantCanary(r.d, { ...GRANT, p_by_agent: { claude: 1.5 } })).kind).toBe(
      'refused',
    );
    expect(await exists(file(r))).toBe(false);
  });

  it('正文只取权威来源:来源给不出(null / 抛错)→ 拒绝、不写;写进文件的正文就是来源给的那一份', async () => {
    const r = await rig();
    r.body.value = null;
    expect(await grantCanary(r.d, GRANT)).toEqual({ kind: 'refused', reason: 'body_unavailable' });
    const r2 = await rig();
    r2.d.bodyOf = async () => {
      throw new Error('repo down');
    };
    expect(await grantCanary(r2.d, GRANT)).toEqual({ kind: 'refused', reason: 'body_unavailable' });
    const r3 = await rig();
    r3.body.value = '做:权威来源的正文。';
    await grantCanary(r3.d, GRANT);
    expect((JSON.parse(await readText(file(r3))) as { body: string }).body).toBe(
      '做:权威来源的正文。',
    );
    expect(await exists(file(r))).toBe(false);
  });

  it('写点之前复核两把锁:任一把在写阶段丢失 → 抛错、没有 canary.json(也没有残留临时文件)', async () => {
    // 授予前的两次复核各 1 次;写阶段每个写点再各复核一次。第 3 次起失败 = 写阶段丢锁
    for (const o of [{ rsiFailAt: 3 }, { personalFailAt: 3 }] as const) {
      const r = await rig(o);
      await expect(grantCanary(r.d, GRANT)).rejects.toThrow('lock_lost');
      expect(await exists(file(r))).toBe(false);
      expect(await exists(`${file(r)}.tmp`)).toBe(false);
    }
  });

  it('授予需要两把锁:personal 锁一开始就丢 → 不读凭据也不写', async () => {
    const r = await rig({ personalFailAt: 1 });
    await expect(grantCanary(r.d, GRANT)).rejects.toThrow('lock_lost');
    expect(await exists(file(r))).toBe(false);
  });
});

describe('muteCanary / removeCanary:只收紧', () => {
  it('muteCanary(AUTO_PAUSE / 熔断):置为不注入、generation + 1;已不注入 / 无文件 → 不写', async () => {
    const r = await rig();
    expect(await muteCanary(r.d)).toBe(false);
    await grantCanary(r.d, GRANT);
    expect(await muteCanary(r.d)).toBe(true);
    const doc = JSON.parse(await readText(file(r))) as Record<string, unknown>;
    expect(doc['agents_inject']).toEqual([]);
    expect(doc['p_by_agent']).toEqual({});
    expect(doc['generation']).toBe(2);
    expect(doc['candidate_id']).toBe(CID);
    expect(await muteCanary(r.d)).toBe(false);
  });
  it('muteCanary 不需要 personal 锁,但需要 rsi 锁:丢锁 → 抛错、文件不变', async () => {
    const r = await rig();
    await grantCanary(r.d, GRANT);
    const before = await readText(file(r));
    const lost = {
      ...r.d,
      locks: {
        rsi: {
          assertHeld: async (): Promise<void> => {
            throw new Error('lock_lost');
          },
        },
      },
    };
    await expect(muteCanary(lost)).rejects.toThrow('lock_lost');
    expect(await readText(file(r))).toBe(before);
  });
  it('removeCanary:删除缓存文件;丢锁 → 不删', async () => {
    const r = await rig();
    await grantCanary(r.d, GRANT);
    const lost = {
      ...r.d,
      locks: {
        rsi: {
          assertHeld: async (): Promise<void> => {
            throw new Error('lock_lost');
          },
        },
      },
    };
    await expect(removeCanary(lost)).rejects.toThrow('lock_lost');
    expect(await exists(file(r))).toBe(true);
    await removeCanary(r.d);
    expect(await exists(file(r))).toBe(false);
  });
});
