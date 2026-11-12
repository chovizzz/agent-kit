/**
 * W7 回滚四段执行器(R21-9.1 / 9.2 / 9.3a / 9.5):正常路径、顺序、来源保留、deferred、端口缺失、复用 txn、校验。
 * 崩溃矩阵在 `w7-crash.test.ts`。
 */
import { describe, expect, it } from 'vitest';
import { resumeAll, rollbackTxnId, startRollback } from '../../../src/rsi/personal/rollback.js';
import {
  unwiredCacheCleanup,
  unwiredIdentityDeny,
  unwiredKeyedEffects,
  unwiredPayloadSync,
  unwiredRepoRemoval,
  v1PayloadSync,
} from '../../../src/rsi/personal/rollback-ports.js';
import {
  V1A,
  V1B,
  Crash,
  HARM,
  ID,
  SHA,
  canaryRec,
  harmReq,
  recordOf,
  world7,
} from './w7-fixture.js';
import { rec } from '../personal/transition-fixture.js';
import { RsiLockError } from '../../../src/rsi/lock-error.js';

const TXN = rollbackTxnId(ID, SHA);
const idx = (w: { calls: string[] }, c: string): number => w.calls.indexOf(c);

describe('R21-9.1 四段补偿:正常路径', () => {
  it('canary + harm → 四段全部完成:记录 rolled_back / auto_rollback,journal 已删,凭据恰好一行 by=worker reason=harm_c1', async () => {
    const w = world7();
    const r = await startRollback(w.d, harmReq());
    expect(r).toEqual({ status: 'complete', txn: TXN, effects: 'applied' });
    const rc = recordOf(w);
    expect(rc.lifecycle).toBe('rolled_back');
    expect(rc.terminal_reason).toBe('auto_rollback');
    expect(rc.deploy).toEqual({ claude: 'none', pi: 'none', codex: 'none' });
    expect(rc.rollback?.phase).toBe('rollback_complete');
    expect(w.txns.size).toBe(0);
    expect(w.revs).toHaveLength(1);
    expect(w.revs[0]).toMatchObject({
      candidate_id: ID,
      content_sha256: SHA,
      identity12: null,
      reason: 'harm_c1',
      by: 'worker',
    });
    // 三个 rollback 维度条目(requested → disabled → pending → complete),各一条
    expect(
      rc.transitions.filter((t) => t.dim === 'rollback').map((t) => `${t.from}>${t.to}`),
    ).toEqual([
      'rollback_requested>injection_disabled',
      'injection_disabled>static_removal_pending',
      'static_removal_pending>rollback_complete',
    ]);
  });

  it('顺序(安全):journal 先于凭据,凭据先于记录提交与私有仓库移除,仓库移除先于 HOME 清理,效果最后、journal 最后才删', async () => {
    const w = world7();
    await startRollback(w.d, harmReq());
    const order = [
      'txn.write:rollback_requested',
      'revoke.write',
      'cache.clean',
      'repo.remove',
      'payload.revoke',
      'effects.applyOnce',
      'txn.remove',
    ].map((c) => idx(w, c));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // 凭据先于任何记录提交:记录提交发生在 `after:cache` 之后(第三段)
    expect(idx(w, 'revoke.write')).toBeLessThan(idx(w, 'step:enter:static_removal_pending'));
  });

  it('第二段判据:凭据从盘上重读;凭据写入返回成功但读不到 → 本段未完成、不推进 journal', async () => {
    const w = world7();
    const orig = w.d.revoker.write;
    w.d.revoker = {
      write: async (l) => {
        await orig(l);
        w.revs.length = 0; // 写入「成功」但盘上没有
        return 'written';
      },
    };
    const r = await startRollback(w.d, harmReq());
    expect(r).toMatchObject({
      status: 'incomplete',
      phase: 'injection_disabled',
      why: 'revocation_missing',
    });
    expect(w.txns.get(TXN)?.phase).toBe('injection_disabled');
    expect(recordOf(w).lifecycle).toBe('canary'); // 记录一个字没动
  });

  it('第四段:撤销路径的目标 = 凭据全集 + 本候选(上次已同步版本减去凭据所列候选)', async () => {
    const w = world7();
    w.revs.push({
      at: '2026-11-09T00:00:00Z',
      candidate_id: 'ra_ffffffffffff',
      content_sha256: 'b'.repeat(64),
      identity12: null,
      reason: 'cleared',
      by: 'clear',
    });
    await startRollback(w.d, harmReq());
    expect(w.payload.revoked).toEqual([['ra_0123456789ab', 'ra_ffffffffffff'].sort()]);
  });

  it('R21-9.3:撤销路径遇到用户改过的块(drift)→ 停在第四段之前:记录停在 static_removal_pending,journal 保留,未到终态', async () => {
    const w = world7();
    w.payload.mode = 'drift';
    const r = await startRollback(w.d, harmReq());
    expect(r).toMatchObject({
      status: 'incomplete',
      phase: 'rollback_complete',
      why: 'drift:user_edited',
    });
    expect(recordOf(w).lifecycle).toBe('rolling_back');
    expect(recordOf(w).rollback?.phase).toBe('static_removal_pending');
    expect(w.txns.get(TXN)?.phase).toBe('rollback_complete');
    expect(w.revs).toHaveLength(1); // 凭据已落盘:hint 已停
    // 用户处理后续做 → 完成
    w.payload.mode = 'done';
    const again = await resumeAll(w.d);
    expect(again).toEqual([{ status: 'complete', txn: TXN, effects: 'applied' }]);
    expect(recordOf(w).lifecycle).toBe('rolled_back');
  });

  it('R21-9.2:V1 的第四段判据恒真(没有静态部署);相位到 local_payload(V2)时恒真实现自己 fail-closed', async () => {
    const v1 = v1PayloadSync(V1B);
    expect(await v1.revoke(['x'])).toEqual({ status: 'done' });
    expect(await v1.absent('x')).toBe(true);
    const v2 = v1PayloadSync(4);
    await expect(v2.absent('x')).rejects.toThrow(/not wired/);
    expect(v2).toBe(unwiredPayloadSync);
  });
});

describe('R21-9.3a 人工分叉下的撤销:凭据先于记录,仓库部分 deferred', () => {
  it('私有仓库 deferred:凭据照样落盘;第三段判据改为 payload 已不含该候选;不提交;收尾因记录推迟而 incomplete,journal 保留', async () => {
    const w = world7();
    w.store.mode = 'deferred';
    const r = await startRollback(w.d, harmReq());
    expect(w.revs).toHaveLength(1);
    expect(w.revs[0]?.by).toBe('worker');
    expect(w.calls).not.toContain('repo.remove'); // 记录读不到 → 没有 target_paths → 不动仓库
    expect(r).toMatchObject({ status: 'incomplete', phase: 'rollback_complete' });
    expect((r as { why: string }).why).toMatch(/^repo_deferred/);
    expect(w.txns.get(TXN)?.phase).toBe('rollback_complete');
    expect(w.store.commits).toHaveLength(0);
    // 分叉解除 → 续做完成(第一个持锁写入方先补做被推迟的提交)
    w.store.mode = 'ok';
    const again = await resumeAll(w.d);
    expect(again).toEqual([{ status: 'complete', txn: TXN, effects: 'applied' }]);
    expect(recordOf(w).lifecycle).toBe('rolled_back');
    expect(w.repoFiles.size).toBe(0); // 被推迟的仓库移除在续做时补上
    expect(w.revs).toHaveLength(1); // 凭据不重复
  });

  it('deferred 下第三段先经撤销路径清 payload(动作含「重渲染本机 payload」),再验证缺席:不死锁', async () => {
    const w = world7();
    w.store.mode = 'deferred';
    w.payload.has.add(ID);
    const r = await startRollback(w.d, harmReq());
    expect(w.payload.revoked.length).toBeGreaterThan(0);
    expect(w.payload.has.has(ID)).toBe(false);
    expect(w.txns.get(TXN)?.phase).toBe('rollback_complete'); // 第三段通过了
    expect((r as { why: string }).why).toMatch(/^repo_deferred/); // 只剩被推迟的记录 / 仓库部分
  });

  it('deferred 且撤销路径之后 payload 仍含该候选:第三段判据不成立 → 停在 static_removal_pending', async () => {
    const w = world7();
    w.store.mode = 'deferred';
    w.payload.has.add(ID);
    w.payload.stuck.add(ID);
    const r = await startRollback(w.d, harmReq());
    expect(r).toMatchObject({
      status: 'incomplete',
      phase: 'static_removal_pending',
      why: 'deferred_payload_still_has_candidate',
    });
  });

  it('deferred 下撤销路径遇到用户改过的块(drift)→ 第三段未完成', async () => {
    const w = world7();
    w.store.mode = 'deferred';
    w.payload.mode = 'drift';
    expect(await startRollback(w.d, harmReq())).toMatchObject({
      status: 'incomplete',
      phase: 'static_removal_pending',
      why: 'drift:user_edited',
    });
  });

  it('记录可读但仓库提交 deferred(第三段「成功」):收尾重新检查并补做仓库移除,没删之前不删 journal、不假装完成', async () => {
    const w = world7();
    w.repoMode.value = 'deferred';
    const r = await startRollback(w.d, harmReq());
    expect(r).toMatchObject({ status: 'incomplete', phase: 'rollback_complete' });
    expect((r as { why: string }).why).toMatch(/^repo_deferred/);
    expect(w.repoFiles.size).toBe(1); // 文件还在
    expect(w.txns.size).toBe(1);
    expect(recordOf(w).lifecycle).toBe('rolling_back');
    w.repoMode.value = 'ok';
    expect((await resumeAll(w.d))[0]?.status).toBe('complete');
    expect(w.repoFiles.size).toBe(0);
    expect(recordOf(w).lifecycle).toBe('rolled_back');
  });

  it('私有仓库 invalid:第三段中止(不当成已完成),凭据已落盘;修好后续做', async () => {
    const w = world7();
    w.store.mode = 'invalid';
    const r = await startRollback(w.d, harmReq());
    expect(r).toMatchObject({ status: 'incomplete', phase: 'static_removal_pending' });
    expect((r as { why: string }).why).toMatch(/^repo_invalid/);
    expect(w.revs).toHaveLength(1);
    w.store.mode = 'ok';
    expect((await resumeAll(w.d))[0]?.status).toBe('complete');
  });

  it('仓库部分 invalid(提交 / 读取失败):不推进记录的 rollback.phase', async () => {
    const w = world7();
    w.repoMode.value = 'invalid';
    const r = await startRollback(w.d, harmReq());
    expect(r).toMatchObject({ status: 'incomplete', phase: 'static_removal_pending' });
    expect(recordOf(w).rollback?.phase).toBe('rollback_requested');
  });
});

describe('W0-17 来源保留:by 是撤销来源', () => {
  it.each([
    ['clear', 'cleared', 'clear'],
    ['veto', 'vetoed', 'veto'],
    ['exec_event', 'exec_post_check_failed', 'exec_event'],
    ['exec_event', 'exec_timeout_unclean', 'exec_event'],
    ['worker', 'harm_c4', 'worker'],
    ['rollback_to', 'cleared', 'rollback_to'],
  ] as const)('by=%s reason=%s → 凭据行 by=%s,其它字段与请求一致', async (by, reason, expectBy) => {
    const w = world7({ record: rec('shadow') });
    await startRollback(w.d, {
      candidate_id: ID,
      content_sha256: SHA,
      kind: by === 'clear' ? 'clear' : 'rollback',
      reason,
      by,
      target_terminal: 'rolled_back',
      event: { kind: 'clear', evidence: 'x' },
    });
    expect(w.revs).toHaveLength(1);
    expect(w.revs[0]).toMatchObject({
      by: expectBy,
      reason,
      candidate_id: ID,
      content_sha256: SHA,
    });
  });

  it('不相容的 (by, reason) 组合一律拒绝:不写 journal、不写凭据', async () => {
    for (const [by, reason] of [
      ['clear', 'vetoed'],
      ['veto', 'cleared'],
      ['worker', 'cleared'],
      ['worker', 'vetoed'],
      ['exec_event', 'harm_c1'],
      ['worker', 'revocation_reconciled'],
      ['worker', 'compensation_done'],
      ['worker', 'g4_near_duplicate'],
    ] as const) {
      const w = world7();
      const r = await startRollback(w.d, harmReq({ by, reason }));
      expect(r, `${by}/${reason}`).toMatchObject({ status: 'refused' });
      expect(w.txns.size).toBe(0);
      expect(w.revs).toHaveLength(0);
    }
  });

  it('rollback_to 只产出 cleared(本块收窄契约的「全部终止原因」):别的终止原因被拒', async () => {
    const w = world7();
    const r = await startRollback(w.d, harmReq({ by: 'rollback_to', reason: 'harm_c1' }));
    expect(r).toMatchObject({ status: 'refused', why: 'reason_not_allowed' });
    expect(w.revs).toHaveLength(0);
  });

  it('rollback_to ⇔ (kind=rollback ∧ reason=cleared):组合不符一律拒绝(来源才能从 journal 唯一还原)', async () => {
    for (const over of [
      { by: 'rollback_to', kind: 'clear', reason: 'cleared' },
      { by: 'clear', kind: 'rollback', reason: 'cleared' },
      { by: 'veto', kind: 'rollback', reason: 'cleared' },
      { by: 'rollback_to', kind: 'reconcile', reason: 'cleared' },
    ] as const) {
      const w = world7();
      const r = await startRollback(w.d, harmReq(over));
      expect(r, JSON.stringify(over)).toMatchObject({ status: 'refused' });
      expect(w.txns.size).toBe(0);
      expect(w.revs).toHaveLength(0);
    }
    const w = world7();
    expect(
      await startRollback(w.d, harmReq({ by: 'rollback_to', kind: 'clear', reason: 'cleared' })),
    ).toMatchObject({ why: 'rollback_to_kind_mismatch' });
  });

  it('kind=clear 只接受 by=clear / reason=cleared', async () => {
    const w = world7();
    const r = await startRollback(w.d, harmReq({ kind: 'clear' }));
    expect(r).toMatchObject({ status: 'refused', why: 'clear_requires_by_clear' });
  });

  it('kind 与原因互相钉死:identity_changed 只能配 identity_change + identity12,反之亦然;identity_changed 不写凭据', async () => {
    const w = world7();
    expect(await startRollback(w.d, harmReq({ reason: 'identity_changed' }))).toMatchObject({
      status: 'refused',
      why: 'identity_kind_mismatch',
    });
    expect(await startRollback(w.d, harmReq({ kind: 'identity_change' }))).toMatchObject({
      status: 'refused',
      why: 'identity_kind_mismatch',
    });
    expect(
      await startRollback(w.d, harmReq({ kind: 'identity_change', reason: 'identity_changed' })),
    ).toMatchObject({ status: 'refused', why: 'identity12_mismatch' });
    expect(w.revs).toHaveLength(0);
    expect(w.txns.size).toBe(0);
  });
});

describe('identity_changed 例外(R21-9.1 第二段)', () => {
  it('不写撤销凭据;以旧身份拒绝标记为第二段依据;target=shadow 本期引擎恒拒 → 收尾 incomplete(V6a 才有)', async () => {
    const w = world7();
    const denied = new Set<string>();
    w.d.identity = {
      deny: async (id, i12) => void denied.add(`${id}-${i12}`),
      denied: async (id, i12) => denied.has(`${id}-${i12}`),
    };
    const r = await startRollback(w.d, {
      candidate_id: ID,
      content_sha256: SHA,
      kind: 'identity_change',
      reason: 'identity_changed',
      by: 'worker',
      target_terminal: 'shadow',
      identity12: 'abcdef012345',
      event: HARM,
    });
    expect(w.revs).toHaveLength(0);
    expect(denied.has(`${ID}-abcdef012345`)).toBe(true);
    expect(w.txns.get(TXN)).toMatchObject({ kind: 'identity_change', identity12: 'abcdef012345' });
    expect(r).toMatchObject({
      status: 'incomplete',
      why: 'identity_record_not_available_before_v6a',
    });
  });

  it('拒绝标记没落盘 → 第二段未完成;身份端口没装配 → fail-closed(port_not_wired)', async () => {
    const w = world7();
    w.d.identity = { deny: async () => undefined, denied: async () => false };
    const base = {
      candidate_id: ID,
      content_sha256: SHA,
      kind: 'identity_change',
      reason: 'identity_changed',
      by: 'worker',
      target_terminal: 'shadow',
      identity12: 'abcdef012345',
    } as const;
    expect(await startRollback(w.d, base)).toMatchObject({ why: 'identity_deny_missing' });
    const w2 = world7();
    w2.d.identity = unwiredIdentityDeny;
    expect(await startRollback(w2.d, base)).toMatchObject({
      status: 'incomplete',
      why: 'port_not_wired:identity_deny',
    });
  });
});

describe('同一候选只有一个在途 txn(复用)', () => {
  it('崩溃后再次发起同一请求:复用同一 journal、凭据不重复;不同 kind / 原因的请求也复用', async () => {
    const w = world7();
    w.crashAt('after:cache');
    await expect(startRollback(w.d, harmReq())).rejects.toBeInstanceOf(Crash);
    expect(w.txns.size).toBe(1);
    // 同一候选的另一来源(用户 clear)再来:复用在途 txn,不新开,来源以 journal 的原因为准
    const r = await startRollback(w.d, {
      candidate_id: ID,
      content_sha256: SHA,
      kind: 'clear',
      reason: 'cleared',
      by: 'clear',
      target_terminal: 'rolled_back',
    });
    expect(r.status).toBe('complete');
    expect(w.revs).toHaveLength(1);
    expect(w.revs[0]?.by).toBe('worker'); // journal 的原因是 harm_c1
    expect(w.calls.filter((c) => c === 'txn.write:rollback_requested')).toHaveLength(1);
  });

  it('txn_id 绑定内容:同一候选换了内容 → 新 txn、新凭据(内容变了必须写新凭据)', async () => {
    const w = world7();
    await startRollback(w.d, harmReq());
    const SHA2 = 'c'.repeat(64);
    expect(rollbackTxnId(ID, SHA2)).not.toBe(TXN);
    w.store.put(canaryRec({ content_sha256: SHA2 }));
    await startRollback(w.d, harmReq({ content_sha256: SHA2 }));
    expect(w.revs.map((l) => l.content_sha256)).toEqual([SHA, SHA2]);
  });

  it('终态之后重来:凭据 already_present、记录不动、效果按键 already,不产生重复', async () => {
    const w = world7();
    await startRollback(w.d, harmReq());
    const before = JSON.stringify(recordOf(w));
    const r = await startRollback(w.d, harmReq());
    expect(r).toEqual({ status: 'complete', txn: TXN, effects: 'already' });
    expect(JSON.stringify(recordOf(w))).toBe(before);
    expect(w.revs).toHaveLength(1);
    expect([...w.effectApplied.values()]).toEqual([1]);
  });
});

describe('复用在途 txn 时较晚到达的终止事件(R21-4.4a ① 自环)', () => {
  it('harm 回滚走到第四段后用户 veto:复用同一 txn,终态理由取优先级最高者(vetoed),否决黑名单落地', async () => {
    const w = world7();
    w.crashAt('after:payload');
    await expect(startRollback(w.d, harmReq())).rejects.toBeInstanceOf(Crash);
    const r = await startRollback(w.d, {
      ...harmReq(),
      reason: 'vetoed',
      by: 'veto',
      event: { kind: 'veto', evidence: 'rsi veto' },
    });
    expect(r.status).toBe('complete');
    expect(recordOf(w).terminal_reason).toBe('vetoed');
    expect([...w.effectLog.values()][0]?.map((e) => e.type)).toEqual([
      'blacklist_veto',
      'write_tombstone',
    ]);
    expect(w.revs).toHaveLength(1); // 来源保持 journal 的 worker
  });
});

describe('丢锁(applyEvent 提交后返回 lockLost)→ 立即停止,不再继续任何写出口', () => {
  it('第三段记录提交后发现丢锁:抛 lock_lost;未调用仓库移除;journal 保留,新持锁者续做完成', async () => {
    const w = world7();
    const okAppend = w.d.audit.append;
    w.d.audit.append = async () => {
      throw new RsiLockError('lock_lost');
    };
    await expect(startRollback(w.d, harmReq())).rejects.toMatchObject({ kind: 'lock_lost' });
    expect(w.calls).not.toContain('repo.remove');
    expect(w.txns.size).toBe(1);
    w.d.audit.append = okAppend;
    expect((await resumeAll(w.d))[0]?.status).toBe('complete');
  });
});

describe('端口缺失一律 fail-closed(不推进、不假装完成)', () => {
  it.each([
    ['payload_sync', (w: ReturnType<typeof world7>) => void (w.d.payload = unwiredPayloadSync)],
    ['cache_cleanup', (w: ReturnType<typeof world7>) => void (w.d.cache = unwiredCacheCleanup)],
    ['repo_removal', (w: ReturnType<typeof world7>) => void (w.d.repo = unwiredRepoRemoval)],
    [
      'keyed_effects',
      (w: ReturnType<typeof world7>) => void (w.d.keyedEffects = unwiredKeyedEffects),
    ],
  ])('%s 没装配 → incomplete(port_not_wired),journal 保留、凭据已落盘', async (name, wire) => {
    const w = world7();
    wire(w);
    const r = await startRollback(w.d, harmReq());
    expect(r).toMatchObject({ status: 'incomplete', why: `port_not_wired:${name}` });
    expect(w.txns.size).toBe(1);
    if (name !== 'cache_cleanup') expect(w.revs).toHaveLength(1);
  });
});

describe('熔断不阻挡撤销路径(R21-10.1)', () => {
  it('auto_paused=true、自动循环无效:回滚照常走完(只禁增加影响)', async () => {
    const w = world7();
    w.env.autoPaused = true;
    w.env.autoLoopEffective = false;
    const r = await startRollback(w.d, harmReq());
    expect(r.status).toBe('complete');
    expect(recordOf(w).lifecycle).toBe('rolled_back');
  });
});

describe('记录与 journal 的组合(续做表)', () => {
  it('journal 无、记录在 rolling_back(别的路径提交了转移):resumeAll 补 kind=reconcile 的 journal 并走完,凭据按原因还原来源', async () => {
    const w = world7({
      record: rec('rolling_back', {
        deploy: { claude: 'removal_pending', pi: 'none', codex: 'none' },
        rollback: { phase: 'injection_disabled', reason: 'vetoed', target_terminal: 'rolled_back' },
      }),
    });
    const out = await resumeAll(w.d);
    expect(out).toEqual([{ status: 'complete', txn: TXN, effects: 'applied' }]);
    expect(w.revs[0]).toMatchObject({ reason: 'vetoed', by: 'veto' });
    expect(recordOf(w).lifecycle).toBe('rolled_back');
    expect(recordOf(w).terminal_reason).toBe('vetoed');
    // 记录领先 journal(记录已在 injection_disabled):只补后两步,不回退
    expect(
      recordOf(w)
        .transitions.filter((t) => t.dim === 'rollback')
        .map((t) => t.to),
    ).toEqual(['static_removal_pending', 'rollback_complete']);
    // 终态效果:否决黑名单 + 墓碑
    const eff = [...w.effectLog.values()][0] ?? [];
    expect(eff.map((e) => e.type)).toEqual(['blacklist_veto', 'write_tombstone']);
  });

  it('journal 损坏 / schema 不符:resumeAll 拒绝并保留,不猜测阶段、不删', async () => {
    const w = world7();
    w.d.txns = {
      ...w.d.txns,
      list: async () => [TXN],
      read: async () => ({ kind: 'invalid', why: 'parse' }),
    };
    const out = await resumeAll(w.d);
    expect(out).toEqual([{ status: 'refused', txn: TXN, why: 'txn_parse' }]);
  });
});

describe('相位闸', () => {
  it('V1a 没有 rollback_four_phase:引擎拒绝 canary → rolling_back,记录不动(凭据仍落盘:先停注入)', async () => {
    const w = world7({ phase: V1A });
    const r = await startRollback(w.d, harmReq());
    expect(w.revs).toHaveLength(1);
    expect(recordOf(w).lifecycle).toBe('canary');
    expect(r).toMatchObject({ status: 'incomplete', phase: 'static_removal_pending' });
    expect(w.calls).not.toContain('repo.remove'); // 记录没能推进:不删仓库文件
  });
});
