/**
 * D1b-2:创建行审计的单一派生点与崩溃补做(`creation-audit.ts`;I13)。
 *  - `creation_row_derivation_single_source`:`creationAuditItems` 的行 = 条目经 `auditOf` 的行;B1b 对账源 `derivedOf` 的创建行与它逐字节相同(同一函数,不是两份各自实现);
 *  - `creation_audit_replay_uses_record_at` / `creation_audit_replay_idempotent`:提交后、审计落地前崩溃 → `recoverCreationAudits` 用**记录里的 `at`**补,按键幂等,第二次 `already`;
 *  - 依赖方向:`store/reconcile-source.ts` → `personal/creation-audit.ts`;反向(creation-audit 的闭包里出现 `store/`)= 红(否则存储核进入 `candidate-step.ts` 的运行时闭包)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PersonalLifecycleRecord } from '../../../src/contracts/rsi-personal.js';
import { readTextSync } from '../../../src/io/read-fs.js';
import { RsiLockError } from '../../../src/rsi/lock-error.js';
import { newRecord, creationAudit } from '../../../src/rsi/personal/candidate-record.js';
import {
  creationAuditItems,
  recoverCreationAudits,
} from '../../../src/rsi/personal/creation-audit.js';
import { auditKeyOf } from '../../../src/rsi/personal/effects-recover.js';
import type {
  KeyedEffectResult,
  KeyedEffectSink,
} from '../../../src/rsi/personal/rollback-ports.js';
import type { TransitionEffect } from '../../../src/rsi/personal/transition.js';
import { auditOf } from '../../../src/rsi/personal/transition.js';
import { createReconcileSource } from '../../../src/rsi/store/reconcile-source.js';
import { ROOT, closureOf } from '../closure-util.js';
import { rec as fixtureRec } from '../personal/transition-fixture.js';
import { draftOf } from '../personal/w3-fixture.js';

const AT = '2026-11-10T12:34:56.000Z';
const created = (id?: string): PersonalLifecycleRecord => {
  const r = newRecord(draftOf(), AT, false);
  return id === undefined ? r : { ...r, id };
};

describe('creationAuditItems:唯一派生函数', () => {
  it('creation_row_derivation_single_source:创建行 → 一条审计行 = auditOf(条目);键 = audit:<id>:<idem_key>;at 取条目的 at', () => {
    const r = created();
    const items = creationAuditItems(r);
    expect(items).toHaveLength(1);
    const e = r.transitions[0];
    expect(e).toBeDefined();
    expect(items[0]).toEqual({
      key: auditKeyOf(r.id, e?.idem_key ?? ''),
      line: auditOf(e as NonNullable<typeof e>, r.id),
      idem_key: e?.idem_key,
    });
    expect(items[0]?.line.at).toBe(AT);
    // 与 candidate-record 的旧构造函数同形(迁移前后行内容不变)
    expect(items[0]?.line).toEqual(creationAudit(r, AT));
  });

  it('transitions[0] 不是创建行(256 条窗口截断后 / 非创建记录)→ 没有创建审计;按内容核对,不按下标假定', () => {
    expect(creationAuditItems(fixtureRec('shadow'))).toEqual([]);
    const r = created();
    const truncated: PersonalLifecycleRecord = {
      ...r,
      transitions: [
        {
          dim: 'lifecycle',
          from: 'proposed',
          to: 'shadow',
          at: AT,
          reason: 'gates_passed',
          idem_key: 'f'.repeat(16),
        },
      ],
      transitions_dropped: 1,
    };
    expect(creationAuditItems(truncated)).toEqual([]);
  });

  it('creation_derivation_duplicated(对照):B1b 对账源 derivedOf 的创建行与 creationAuditItems 逐字节相同(含 idem_key 字段)', async () => {
    const r = created();
    const src = createReconcileSource({
      records: { readAll: async () => ({ kind: 'ok', value: [r] }) },
    });
    const rows = await src.derivedThrough('2099-01-01');
    const item = creationAuditItems(r)[0];
    const row = rows.find((x) => x.idem_key === item?.idem_key);
    expect(row?.row).toEqual({ ...item?.line, idem_key: item?.idem_key });
    expect(row?.locator.kind).toBe('entry');
  });
});

/** 带键幂等的内存假件(与生产 `KeyedEffectSink` 同一契约:同键只生效一次) */
function keyedSink(): {
  sink: KeyedEffectSink;
  landed: Map<string, TransitionEffect[]>;
  calls: string[];
  failKeys: Set<string>;
  deferKeys: Set<string>;
} {
  const landed = new Map<string, TransitionEffect[]>();
  const calls: string[] = [];
  const failKeys = new Set<string>();
  const deferKeys = new Set<string>();
  return {
    landed,
    calls,
    failKeys,
    deferKeys,
    sink: {
      applyOnce: async (key, effects): Promise<KeyedEffectResult> => {
        calls.push(key);
        if (failKeys.has(key)) throw new Error('disk full');
        if (deferKeys.has(key)) return 'deferred';
        if (landed.has(key)) return 'already';
        landed.set(key, [...effects]);
        return 'applied';
      },
    },
  };
}

describe('recoverCreationAudits:提交后崩溃的补做', () => {
  it('creation_audit_replay_uses_record_at:缺行 → 以记录里的 at 补(不是补做时刻),效果带 idem_key;键与即时路径同一个键空间', async () => {
    const r = created();
    const k = keyedSink();
    const out = await recoverCreationAudits({
      store: { readAll: async () => ({ kind: 'ok', head: 'h', value: [r] }) },
      sink: k.sink,
    });
    expect(out).toEqual({ applied: [r.id], already: [], deferred: [], failed: [], skipped: null });
    const [key, effects] = [...k.landed.entries()][0] ?? ['', []];
    expect(key).toBe(auditKeyOf(r.id, r.transitions[0]?.idem_key ?? ''));
    expect(effects).toEqual([
      {
        type: 'append_audit',
        line: creationAudit(r, AT),
        idem_key: r.transitions[0]?.idem_key,
      },
    ]);
    expect((effects[0] as { line: { at: string } }).line.at).toBe(AT);
  });

  it('creation_audit_replay_idempotent:再来一次 → already,不重复落行', async () => {
    const r = created();
    const k = keyedSink();
    const d = {
      store: { readAll: async () => ({ kind: 'ok' as const, head: 'h', value: [r] }) },
      sink: k.sink,
    };
    await recoverCreationAudits(d);
    const second = await recoverCreationAudits(d);
    expect(second).toEqual({
      applied: [],
      already: [r.id],
      deferred: [],
      failed: [],
      skipped: null,
    });
    expect(k.landed.size).toBe(1);
  });

  it('单个候选落地失败不挡其余;deferred 如实上报;丢锁立即上抛', async () => {
    const a = created();
    const b = created('ra_bbbbbbbbbbbb');
    const c = created('ra_cccccccccccc');
    const k = keyedSink();
    k.failKeys.add(auditKeyOf(a.id, a.transitions[0]?.idem_key ?? ''));
    k.deferKeys.add(auditKeyOf(b.id, b.transitions[0]?.idem_key ?? ''));
    const store = { readAll: async () => ({ kind: 'ok' as const, head: 'h', value: [a, b, c] }) };
    const out = await recoverCreationAudits({ store, sink: k.sink });
    expect(out.failed).toEqual([{ id: a.id, why: 'disk full' }]);
    expect(out.deferred).toEqual([b.id]);
    expect(out.applied).toEqual([c.id]);
    const lost: KeyedEffectSink = {
      applyOnce: async () => {
        throw new RsiLockError('lock_lost');
      },
    };
    await expect(recoverCreationAudits({ store, sink: lost })).rejects.toBeInstanceOf(RsiLockError);
  });

  it('权威副本读不到(absent / deferred / invalid)→ skipped,没有任何落地(不当成「没有缺行」)', async () => {
    for (const kind of ['absent', 'deferred', 'invalid'] as const) {
      const k = keyedSink();
      const out = await recoverCreationAudits({
        store: { readAll: async () => ({ kind }) as never },
        sink: k.sink,
      });
      expect(out.skipped).toBe(kind);
      expect(k.calls).toEqual([]);
    }
  });

  it('非创建记录(没有创建行)不产生任何调用', async () => {
    const k = keyedSink();
    await recoverCreationAudits({
      store: { readAll: async () => ({ kind: 'ok', head: 'h', value: [fixtureRec('shadow')] }) },
      sink: k.sink,
    });
    expect(k.calls).toEqual([]);
  });
});

describe('personal_does_not_import_store:依赖方向 store → personal', () => {
  const FILE = 'src/rsi/personal/creation-audit.ts';

  it('creation-audit.ts 的闭包(运行时与类型)里没有任何 store/ 文件;它不 import reconcile-source', () => {
    for (const includeTypes of [false, true]) {
      const c = closureOf([FILE], { includeTypes });
      expect(c.unresolved).toEqual([]);
      expect([...c.files].filter((f) => f.startsWith('src/rsi/store/'))).toEqual([]);
    }
    expect(readTextSync(path.join(ROOT, FILE))).not.toMatch(/from '[./]*store\//);
  });

  it('reconcile-source.ts import creation-audit(单向:store → personal)', () => {
    const c = closureOf(['src/rsi/store/reconcile-source.ts']);
    expect(c.files.has(FILE)).toBe(true);
  });

  it('candidate-step.ts 的运行时闭包含 creation-audit 但不含任何 store/ 文件', () => {
    const c = closureOf(['src/rsi/personal/candidate-step.ts'], { includeTypes: true });
    expect(c.files.has(FILE)).toBe(true);
    expect([...c.files].filter((f) => f.startsWith('src/rsi/store/'))).toEqual([]);
  });

  it('正向对照:虚拟的 creation-audit 若反向 import store → 同一检查报出', () => {
    const c = closureOf(['src/rsi/personal/probe-creation-audit.ts'], {
      virtual: {
        'src/rsi/personal/probe-creation-audit.ts':
          "import { createReconcileSource } from '../store/reconcile-source.js';\nexport const x = createReconcileSource;",
      },
    });
    expect([...c.files].filter((f) => f.startsWith('src/rsi/store/')).length).toBeGreaterThan(0);
  });
});
