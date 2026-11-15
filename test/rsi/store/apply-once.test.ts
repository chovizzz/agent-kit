/**
 * B1a:`KeyedEffectSink.applyOnce` / `UserVetoPort` 的端口契约套件——**内存假件与真实现(真文件系统)同跑**,包括错误语义与幂等:
 * 三层结果、同键同 / 异内容、`audit:` 路由、审计满与账满(撤销优先)、压缩不受支持、账不合规、gen 与 lift 语义、零写入。
 */
import { describe, expect, it, vi } from 'vitest';
import { RsiEffectsLedgerSchema, RSI_EFFECTS_LIMITS } from '../../../src/contracts/rsi-store.js';
import { RsiLockError } from '../../../src/rsi/lock-error.js';
import { decodeLedger } from '../../../src/rsi/store/backend.js';
import { AuditKeyConflict, EffectsKeyConflict, StoreError } from '../../../src/rsi/store/errors.js';
import {
  AT1,
  FILES,
  FP,
  ID,
  ID2,
  SHA,
  SHA2,
  auditEffect,
  cool,
  faulty,
  fullAuditText,
  hex16,
  makeWorld,
  markEffect,
  meta,
  seed,
  tomb,
  trow,
  veto,
  compactionDoc,
  type FsKind,
  type World,
} from './store-fixture.js';

// 20000 行审计文件的播种 / 分类在真文件系统上较慢
vi.setConfig({ testTimeout: 120_000 });

const KINDS: readonly FsKind[] = ['mem', 'real'];
const ledgerOf = async (w: World) => {
  const b = await w.bytes(FILES.effects);
  if (b === null) throw new Error('no ledger file');
  return decodeLedger(b);
};
const auditLines = async (w: World): Promise<string[]> => {
  const b = await w.bytes(FILES.audit);
  return b === null
    ? []
    : b
        .toString('utf8')
        .split('\n')
        .filter((l) => l !== '');
};
const rejects = async (p: Promise<unknown>): Promise<StoreError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof StoreError) return e;
    throw e;
  }
  throw new Error('expected rejection');
};
const fullAudit = (): string => fullAuditText();

describe.each(KINDS)('applyOnce 契约(%s)', (kind) => {
  it('三层结果:首次 = committed,同键同内容 = satisfied 且文件字节不变、不写 tmp', async () => {
    let calls: string[] = [];
    const w = await makeWorld(kind, {
      wrap: (inner) => {
        const f = faulty(inner, []);
        calls = f.calls;
        return f;
      },
    });
    const effects = [veto(), tomb(), cool()];
    expect(await w.store.sink.applyOnce('terminal:k1', effects, meta())).toEqual({
      ledger: 'committed',
      audit: 'not_applicable',
    });
    const before = await w.bytes(FILES.effects);
    const writes = calls.filter((c) => c.startsWith('writeTmp')).length;
    expect(writes).toBe(1);
    expect(
      await w.store.sink.applyOnce('terminal:k1', effects, meta('2026-11-15T09:00:00.000Z')),
    ).toEqual({
      ledger: 'satisfied',
      audit: 'not_applicable',
    });
    expect(await w.bytes(FILES.effects)).toEqual(before);
    expect(calls.filter((c) => c.startsWith('writeTmp'))).toHaveLength(writes);
    const l = await ledgerOf(w);
    expect(l.gen).toBe(1);
    expect(RsiEffectsLedgerSchema.safeParse(l).success).toBe(true);
  });

  it('gen 每次提交恰好 +1;satisfied 不增 gen', async () => {
    const w = await makeWorld(kind);
    await w.store.sink.applyOnce('k1', [tomb(ID)], meta());
    await w.store.sink.applyOnce('k2', [tomb(ID2)], meta());
    await w.store.sink.applyOnce('k2', [tomb(ID2)], meta());
    expect((await ledgerOf(w)).gen).toBe(2);
  });

  it('同键不同内容 = EffectsKeyConflict(零写入:账字节不变、无 tmp 残留);对照:换键提交', async () => {
    const w = await makeWorld(kind);
    await w.store.sink.applyOnce('k', [veto()], meta());
    const before = await w.bytes(FILES.effects);
    const e = await rejects(
      w.store.sink.applyOnce('k', [veto()], meta(AT1, { fp_hmac: 'f'.repeat(16) })),
    );
    expect(e).toBeInstanceOf(EffectsKeyConflict);
    expect([e.code, e.detail]).toEqual(['effects_key_conflict', 'key:k']);
    expect(await w.bytes(FILES.effects)).toEqual(before);
    expect(await w.tmpFiles()).toEqual([]);
    expect(await w.store.sink.applyOnce('k2', [veto(ID2, SHA2)], meta())).toMatchObject({
      ledger: 'committed',
    });
  });

  it('墓碑冲突 / 批内同 id 异内容:零写入', async () => {
    const w = await makeWorld(kind);
    await w.store.sink.applyOnce('k1', [tomb(ID, 'rejected', 'vetoed')], meta());
    const before = await w.bytes(FILES.effects);
    const e1 = await rejects(
      w.store.sink.applyOnce('k2', [tomb(ID, 'expired', 'auto_expired')], meta()),
    );
    expect(e1.detail).toBe(`tombstone:${ID}`);
    const e2 = await rejects(
      w.store.sink.applyOnce(
        'k3',
        [tomb(ID2, 'rejected', 'vetoed'), tomb(ID2, 'expired', 'auto_expired')],
        meta(),
      ),
    );
    expect(e2.detail).toBe(`batch_tombstone:${ID2}`);
    expect(await w.bytes(FILES.effects)).toEqual(before);
  });

  it('effects_meta_missing:账类效果缺 meta / 黑名单缺 fp_hmac 都抛,账文件不被创建;审计类效果不需要 meta(对照)', async () => {
    const w = await makeWorld(kind);
    expect(await rejects(w.store.sink.applyOnce('k', [tomb()]))).toMatchObject({
      code: 'effects_meta_missing',
      reason: 'internal',
    });
    expect(await rejects(w.store.sink.applyOnce('k', [veto()], { event_at: AT1 }))).toMatchObject({
      detail: 'fp_hmac',
    });
    expect(await w.bytes(FILES.effects)).toBeNull();
    expect(await w.store.sink.applyOnce('audit:x', [auditEffect(trow(hex16(1)))])).toEqual({
      ledger: 'not_applicable',
      audit: 'appended',
    });
  });

  it('没有可落地的效果 = not_applicable / not_applicable,零写入;commit_lifecycle = unsupported_effect', async () => {
    const w = await makeWorld(kind);
    expect(await w.store.sink.applyOnce('k', [])).toEqual({
      ledger: 'not_applicable',
      audit: 'not_applicable',
    });
    const e = await rejects(
      w.store.sink.applyOnce('k', [{ type: 'commit_lifecycle', id: ID }], meta()),
    );
    expect([e.code, e.detail]).toEqual(['unsupported_effect', 'type:commit_lifecycle']);
    expect(await w.bytes(FILES.effects)).toBeNull();
    expect(await w.bytes(FILES.audit)).toBeNull();
  });

  it('audit: 前缀的键只路由到审计、不进账;带账类效果 = unsupported_effect', async () => {
    const w = await makeWorld(kind);
    const key = `audit:${ID}:${hex16(7)}`;
    const r = await w.store.sink.applyOnce(key, [auditEffect(trow(hex16(7)))]);
    expect(r).toEqual({ ledger: 'not_applicable', audit: 'appended' });
    expect(await w.bytes(FILES.effects)).toBeNull(); // applied 键额度不被审计行占用
    expect(await auditLines(w)).toHaveLength(1);
    const again = await w.store.sink.applyOnce(key, [auditEffect(trow(hex16(7)))]);
    expect(again).toEqual({ ledger: 'not_applicable', audit: 'appended' });
    expect(await auditLines(w)).toHaveLength(1); // 同键同内容 = 不重复
    const e = await rejects(w.store.sink.applyOnce(`audit:${ID}:x`, [tomb()], meta()));
    expect(e.detail).toBe('audit_key_with_ledger_effects');
  });

  it('终态批(账 + 保护标记):账提交 + 审计追加带 idem_key;重放 = satisfied + 行不重复', async () => {
    const w = await makeWorld(kind);
    const batch = [tomb(), cool(), markEffect(hex16(9))];
    expect(await w.store.sink.applyOnce('terminal:t1', batch, meta())).toEqual({
      ledger: 'committed',
      audit: 'appended',
    });
    const lines = await auditLines(w);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      kind: 'reconcile',
      reason: 'protection_unknown',
      idem_key: hex16(9),
    });
    expect(await w.store.sink.applyOnce('terminal:t1', batch, meta())).toEqual({
      ledger: 'satisfied',
      audit: 'appended',
    });
    expect(await auditLines(w)).toHaveLength(1);
  });

  it('effect 的 idem_key 与行内 idem_key 不一致 = audit_key_conflict;append_audit 无键 = audit_key_missing', async () => {
    const w = await makeWorld(kind);
    const mismatch = { ...auditEffect(trow(hex16(1))), idem_key: hex16(2) };
    expect((await rejects(w.store.sink.applyOnce('audit:a', [mismatch]))).detail).toBe(
      'effect_line_key_mismatch',
    );
    const { idem_key: _k, ...noKeyRow } = trow(hex16(1));
    void _k;
    const e = await rejects(
      w.store.sink.applyOnce('audit:a', [{ type: 'append_audit', line: noKeyRow }]),
    );
    expect(e.code).toBe('audit_key_missing');
    expect(await w.bytes(FILES.audit)).toBeNull();
  });

  it('审计满 + 账待提交:账不提交(账后只剩 I/O 失败),cause=audit_full;审计文件与账均不变', async () => {
    const w = await makeWorld(kind);
    await seed(w, FILES.audit, fullAudit());
    const before = await w.bytes(FILES.audit);
    const r = await w.store.sink.applyOnce('terminal:t', [tomb(), markEffect(hex16(5))], meta());
    expect(r).toEqual({ ledger: 'not_committed', audit: 'not_applicable', cause: 'audit_full' });
    expect(await w.bytes(FILES.effects)).toBeNull();
    expect(await w.bytes(FILES.audit)).toEqual(before);
  });

  it('审计满 + 账已满足:ledger=satisfied、audit=pending、cause=audit_full(审计待补,不是错误)', async () => {
    const w = await makeWorld(kind);
    await w.store.sink.applyOnce('terminal:t', [tomb()], meta());
    await seed(w, FILES.audit, fullAudit());
    const r = await w.store.sink.applyOnce('terminal:t', [tomb(), markEffect(hex16(5))], meta());
    expect(r).toEqual({ ledger: 'satisfied', audit: 'pending', cause: 'audit_full' });
  });

  it('账满(黑名单 1000):撤销优先——不抛,ledger=not_committed、cause=effects_full,账字节不变', async () => {
    const w = await makeWorld(kind);
    const items = Array.from({ length: RSI_EFFECTS_LIMITS.blacklist }, (_, i) => ({
      candidate_id: `ra_${i.toString(16).padStart(12, '0')}`,
      content_sha256: SHA,
      fp_hmac: FP,
      near_fp: [],
      at: AT1,
      vetoed_gen: 1,
    }));
    await seed(
      w,
      FILES.effects,
      JSON.stringify({
        schema_version: 1,
        gen: 1,
        blacklist: items,
        tombstones: [],
        cooldowns: [],
        applied: [],
      }),
    );
    const before = await w.bytes(FILES.effects);
    expect(await w.store.sink.applyOnce('k', [veto(ID2, SHA2)], meta())).toEqual({
      ledger: 'not_committed',
      audit: 'not_applicable',
      cause: 'effects_full',
    });
    expect(await w.bytes(FILES.effects)).toEqual(before);
  });

  it('账不合规 = state_invalid 且读写均拒、不覆盖:gen_relation / lifted_pair / duplicate / json', async () => {
    const base = {
      schema_version: 1,
      gen: 1,
      blacklist: [],
      tombstones: [],
      cooldowns: [],
      applied: [],
    };
    const item = {
      candidate_id: ID,
      content_sha256: SHA,
      fp_hmac: FP,
      near_fp: [],
      at: AT1,
      vetoed_gen: 1,
    };
    const cases: [string, string, string][] = [
      [
        'gen_relation',
        JSON.stringify({ ...base, gen: 1, blacklist: [{ ...item, vetoed_gen: 2 }] }),
        'gen_relation',
      ],
      [
        'lifted_pair',
        JSON.stringify({ ...base, gen: 3, blacklist: [{ ...item, lifted_at: AT1 }] }),
        'lifted_pair',
      ],
      [
        'lifted_before_veto',
        JSON.stringify({
          ...base,
          gen: 3,
          blacklist: [{ ...item, vetoed_gen: 2, lifted_at: AT1, lifted_gen: 2 }],
        }),
        'gen_relation',
      ],
      [
        'duplicate',
        JSON.stringify({
          ...base,
          tombstones: [
            { id: ID, terminal: 'rejected', reason: 'vetoed', at: AT1 },
            { id: ID, terminal: 'rejected', reason: 'vetoed', at: AT1 },
          ],
        }),
        'duplicate',
      ],
      ['json', '{not json', 'json'],
    ];
    for (const [name, text, detail] of cases) {
      const w = await makeWorld(kind);
      await seed(w, FILES.effects, text);
      const before = await w.bytes(FILES.effects);
      const e = await rejects(w.store.sink.applyOnce('k', [tomb()], meta()));
      expect([name, e.code, e.detail, e.reason]).toEqual([
        name,
        'state_invalid',
        detail,
        'state_invalid',
      ]);
      expect(await w.bytes(FILES.effects)).toEqual(before);
    }
  });

  it('压缩状态不受支持 = 账与审计的全部写入都拒(compaction_unsupported),零写入;缺失 / 受支持(对照)照常', async () => {
    const bad: [string, string][] = [
      ['today', JSON.stringify(compactionDoc('2026-11-15'))], // through 必须早于今日
      ['future', JSON.stringify(compactionDoc('2027-01-01'))],
      ['json', 'oops'],
      ['version', JSON.stringify({ ...compactionDoc('2026-10-01'), schema_version: 2 })],
      [
        'months',
        JSON.stringify({
          ...compactionDoc('2026-10-01'),
          months: {
            '2026-10': {
              lines: 5,
              deleted: 1,
              derived_missing: 1,
              by_kind: { transition: 5 },
              transition_by_to: {},
            },
          },
        }),
      ],
    ];
    for (const [name, text] of bad) {
      const w = await makeWorld(kind);
      await seed(w, FILES.compaction, text);
      const e1 = await rejects(w.store.sink.applyOnce('k', [tomb()], meta()));
      const e2 = await rejects(
        w.store.appender.appendObservation({ at: AT1, kind: 'evaluation', id: ID }),
      );
      expect([name, e1.code, e2.code, e1.reason]).toEqual([
        name,
        'compaction_unsupported',
        'compaction_unsupported',
        'audit_invalid',
      ]);
      expect(await w.bytes(FILES.effects)).toBeNull();
      expect(await w.bytes(FILES.audit)).toBeNull();
    }
    const ok = await makeWorld(kind);
    await seed(ok, FILES.compaction, JSON.stringify(compactionDoc('2026-11-14')));
    expect(await ok.store.sink.applyOnce('k', [tomb()], meta())).toMatchObject({
      ledger: 'committed',
    });
  });

  it('丢锁:assertHeld 失败 = RsiLockError(lock_lost),不开始写', async () => {
    const w = await makeWorld(kind);
    w.personal.held = false;
    await expect(w.store.sink.applyOnce('k', [tomb()], meta())).rejects.toBeInstanceOf(
      RsiLockError,
    );
    expect(await w.bytes(FILES.effects)).toBeNull();
  });
});

describe.each(KINDS)('UserVetoPort 与 lift 语义(%s)', (kind) => {
  const item = async (w: World) => (await ledgerOf(w)).blacklist.find((b) => b.candidate_id === ID);

  it('veto → committed;再 veto(未 lifted)= satisfied 且不写;lift → lifted;再 lift = absent', async () => {
    const w = await makeWorld(kind);
    expect(await w.store.userVeto.veto(ID, SHA, meta())).toEqual({
      ledger: 'committed',
      audit: 'not_applicable',
    });
    const before = await w.bytes(FILES.effects);
    expect(await w.store.userVeto.veto(ID, SHA, meta())).toEqual({
      ledger: 'satisfied',
      audit: 'not_applicable',
    });
    expect(await w.bytes(FILES.effects)).toEqual(before);
    expect(await w.store.userVeto.lift(ID, SHA, AT1)).toBe('lifted');
    const it1 = await item(w);
    expect(it1?.lifted_gen).toBe(2);
    expect(it1?.vetoed_gen).toBe(1);
    expect(await w.store.userVeto.lift(ID, SHA, AT1)).toBe('absent');
    expect(await w.store.userVeto.lift(ID2, SHA, AT1)).toBe('absent');
  });

  it('lift_replay_after_prune_noop:lift 之后 replay(键在 / 键已丢)都不复活', async () => {
    const w = await makeWorld(kind);
    await w.store.sink.applyOnce(`veto:${ID}:${SHA}`, [veto()], meta());
    await w.store.userVeto.lift(ID, SHA, AT1);
    // 同键重放(键仍在):已满足
    expect(await w.store.sink.applyOnce(`veto:${ID}:${SHA}`, [veto()], meta())).toMatchObject({
      ledger: 'satisfied',
    });
    // 换键重放(模拟键被裁):状态层也不复活
    expect(await w.store.sink.applyOnce('terminal:other', [veto()], meta())).toMatchObject({
      ledger: 'satisfied',
    });
    expect((await item(w))?.lifted_gen).toBeDefined();
  });

  it('user_veto_skips_already_shortcircuit:同键已记,lift 后用户再 veto 仍生效(清 lifted、vetoed_gen = 新 gen)', async () => {
    const w = await makeWorld(kind);
    await w.store.sink.applyOnce(`veto:${ID}:${SHA}`, [veto()], meta());
    await w.store.userVeto.lift(ID, SHA, AT1);
    expect(await w.store.userVeto.veto(ID, SHA, meta('2026-11-15T10:00:00.000Z'))).toMatchObject({
      ledger: 'committed',
    });
    const it2 = await item(w);
    expect(it2?.lifted_gen).toBeUndefined();
    expect(it2?.lifted_at).toBeUndefined();
    expect(it2?.vetoed_gen).toBe(3);
    expect(it2?.at).toBe('2026-11-15T10:00:00.000Z');
  });

  it('lift_then_new_user_veto_effective_under_clock_regress:事件时间倒退时仍按 gen 生效', async () => {
    const w = await makeWorld(kind);
    await w.store.userVeto.veto(ID, SHA, meta('2026-11-15T10:00:00.000Z'));
    await w.store.userVeto.lift(ID, SHA, '2026-11-15T11:00:00.000Z');
    await w.store.userVeto.veto(ID, SHA, meta('2026-11-01T00:00:00.000Z')); // 时钟倒退
    const it3 = await item(w);
    expect(it3?.lifted_gen).toBeUndefined();
    expect(it3?.vetoed_gen).toBe(3);
  });

  it('veto 缺 fp_hmac = effects_meta_missing(类型上必带,运行时亦校验)', async () => {
    const w = await makeWorld(kind);
    const bad = { event_at: AT1, fp_hmac: 'nope' };
    expect((await rejects(w.store.userVeto.veto(ID, SHA, bad))).detail).toBe('fp_hmac');
    expect(await w.bytes(FILES.effects)).toBeNull();
  });

  it('replay_paths_cannot_reach_user_veto_intent:applyOnce / recoverThrough 没有 intent 参数', async () => {
    const w = await makeWorld(kind);
    expect(w.store.sink.applyOnce.length).toBeLessThanOrEqual(3);
    // @ts-expect-error applyOnce 只有三个参数,第四个(意图)无法表达
    await w.store.sink.applyOnce('k', [], undefined, 'user_veto');
    expect(Object.keys(w.store.sink)).toEqual(['applyOnce']);
    expect(Object.keys(w.store.recovery)).toEqual(['recoverThrough']);
    // 同一内容经 applyOnce(replay)对已 lifted 的项无效,经 userVeto 才生效
    await w.store.userVeto.veto(ID, SHA, meta());
    await w.store.userVeto.lift(ID, SHA, AT1);
    await w.store.sink.applyOnce('fresh', [veto()], meta());
    expect((await item(w))?.lifted_gen).toBeDefined();
    await w.store.userVeto.veto(ID, SHA, meta());
    expect((await item(w))?.lifted_gen).toBeUndefined();
  });

  it('AuditKeyConflict 是 audit_invalid;EffectsKeyConflict 是 state_invalid(码表映射)', () => {
    expect(new AuditKeyConflict('x').reason).toBe('audit_invalid');
    expect(new EffectsKeyConflict('x').reason).toBe('state_invalid');
  });
});
