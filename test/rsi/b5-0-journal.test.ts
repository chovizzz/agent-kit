/**
 * R20-A2 B5-0:`RsiPurgeJournalSchema` 判别联合(purge | salvage,Q-A)。
 * 要点:老文件(无 `mode`)仍按 purge 合法;salvage 只在 `mode:'salvage'` 下合法;一切混用 / 未知形态 / 多余键都不合规(fail-closed);
 * 消费路径 `detectPurgeJournal` 对两种形态都返回 present,对不合规返回 invalid。
 * 每个负例旁边都有正向前提(同一基线先通过),防「基线本来就红」让负向断言空转。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RSI_PURGE_PHASES,
  RSI_SALVAGE_PHASES,
  RsiPurgeJournalSchema,
} from '../../src/contracts/rsi.js';
import { canonicalJson } from '../../src/io/canonical-json.js';
import { detectPurgeJournal } from '../../src/rsi/services/taint.js';
import { KEY_A, ensureRsiDir, makeSvc, put } from './services-fixture.js';

const AT = '2026-10-27T00:00:00.000Z';
const targets = { runs: ['run-1'], promotes: [] as string[] };
const oldPurge = {
  schema_version: 1,
  created_at: AT,
  phase: 'planned',
  keys: [KEY_A],
  taint_targets: targets,
};
const salvage = {
  schema_version: 1,
  created_at: AT,
  mode: 'salvage',
  phase: 'planned',
  keys: [] as string[],
  taint_targets: targets,
};
const ok = (v: unknown): boolean => RsiPurgeJournalSchema.safeParse(v).success;

describe('RsiPurgeJournal 判别联合', () => {
  it('老文件(无 mode)合法,解析后 mode 为 purge;显式 mode:purge 同样合法', () => {
    const r = RsiPurgeJournalSchema.safeParse(oldPurge);
    expect(r.success).toBe(true);
    expect(r.success && r.data.mode).toBe('purge');
    expect(ok({ ...oldPurge, mode: 'purge' })).toBe(true);
    for (const phase of RSI_PURGE_PHASES) expect(ok({ ...oldPurge, phase }), phase).toBe(true);
  });

  it('salvage 合法:三个阶段、keys 为空、taint_targets 可为全部 run / promote', () => {
    const r = RsiPurgeJournalSchema.safeParse(salvage);
    expect(r.success).toBe(true);
    expect(r.success && r.data.mode).toBe('salvage');
    for (const phase of RSI_SALVAGE_PHASES) expect(ok({ ...salvage, phase }), phase).toBe(true);
    expect(ok({ ...salvage, taint_targets: { runs: ['run-1', 'run-2'], promotes: ['p-1'] } })).toBe(
      true,
    );
  });

  it('混形态一律不合规:显式 purge 带 salvage 形态字段、salvage 带 purge 阶段 / 非空 keys', () => {
    // 正向前提:两个基线本身合法
    expect(ok(oldPurge)).toBe(true);
    expect(ok(salvage)).toBe(true);
    // 显式 mode:'purge',但字段是 salvage 形态(keys 空)
    expect(ok({ ...oldPurge, mode: 'purge', keys: [] })).toBe(false);
    // 显式 mode:'salvage',但 keys 非空且 phase 是 purge 专有阶段
    expect(ok({ ...salvage, keys: [KEY_A], phase: 'signals_rewritten' })).toBe(false);
    // salvage + 非空 keys(阶段合法)
    expect(ok({ ...salvage, keys: [KEY_A] })).toBe(false);
    // salvage + purge 专有阶段(keys 为空)
    for (const phase of ['signals_rewritten', 'indexed']) {
      expect(ok({ ...salvage, phase }), phase).toBe(false);
    }
    // purge 阶段名放进 salvage 之外的任何地方:purge 形态不接受 salvage 没有的值
    expect(ok({ ...oldPurge, phase: 'half' })).toBe(false);
  });

  it('未知 / 异常 mode 不合规(含 null、空串、大小写变体、非字符串);mode 缺失仅补成 purge', () => {
    expect(ok(salvage)).toBe(true);
    for (const mode of ['rebuild', 'Salvage', 'PURGE', '', null, 1, {}, ['purge']]) {
      expect(ok({ ...oldPurge, mode }), JSON.stringify(mode)).toBe(false);
      expect(ok({ ...salvage, mode }), JSON.stringify(mode)).toBe(false);
    }
    // 只补缺失的键,不改写其它字段:缺 phase 的老文件仍不合规
    const { phase: _p, ...noPhase } = oldPurge;
    void _p;
    expect(ok(noPhase)).toBe(false);
  });

  it('两个分支都是 strict:多余键不合规', () => {
    expect(ok(oldPurge)).toBe(true);
    expect(ok(salvage)).toBe(true);
    expect(ok({ ...oldPurge, bogus: 1 })).toBe(false);
    expect(ok({ ...oldPurge, mode: 'purge', bogus: 1 })).toBe(false);
    expect(ok({ ...salvage, bogus: 1 })).toBe(false);
  });

  it('非对象 / 数组 / 缺字段 / schema_version 不对 / taint_targets 未升序 都不合规', () => {
    for (const bad of [null, 'x', 1, [], [oldPurge]]) expect(ok(bad)).toBe(false);
    expect(ok({ ...oldPurge, schema_version: 2 })).toBe(false);
    expect(ok({ ...salvage, schema_version: 2 })).toBe(false);
    const unsorted = { runs: ['run-2', 'run-1'], promotes: [] };
    expect(ok({ ...oldPurge, taint_targets: unsorted })).toBe(false);
    expect(ok({ ...salvage, taint_targets: unsorted })).toBe(false);
    const { taint_targets: _t, ...noTargets } = salvage;
    void _t;
    expect(ok(noTargets)).toBe(false);
  });

  it('旧 purge 形态仍要 keys 至少一个(salvage 才允许为空)', () => {
    expect(ok({ ...oldPurge, keys: [] })).toBe(false);
    expect(ok({ ...salvage, keys: [] })).toBe(true);
  });
});

describe('detectPurgeJournal 对新形态', () => {
  it('salvage:present + 阶段;老 purge 不变;混形态 / 未知 mode → invalid', async () => {
    const s = await makeSvc('b50-journal-probe-');
    await ensureRsiDir(s);
    const file = path.join(s.rsi, 'purge-journal.json');
    await put(s, file, canonicalJson(oldPurge));
    expect(await detectPurgeJournal(s.ctx)).toEqual({ state: 'present', phase: 'planned' });
    await put(s, file, canonicalJson({ ...salvage, phase: 'tainted' }));
    expect(await detectPurgeJournal(s.ctx)).toEqual({ state: 'present', phase: 'tainted' });
    await put(s, file, canonicalJson({ ...salvage, phase: 'done' }));
    expect(await detectPurgeJournal(s.ctx)).toEqual({ state: 'present', phase: 'done' });
    for (const bad of [
      { ...salvage, keys: [KEY_A] },
      { ...salvage, phase: 'indexed' },
      { ...oldPurge, mode: 'rebuild' },
    ]) {
      await put(s, file, canonicalJson(bad));
      expect(await detectPurgeJournal(s.ctx), JSON.stringify(bad)).toEqual({ state: 'invalid' });
    }
  });
});
