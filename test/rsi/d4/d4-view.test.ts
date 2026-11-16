/**
 * D4 / `auto-view.json`:纯构造(`buildAutoView`)与持 `rsi/lock` 的写端口(`writeAutoView`)的端口契约
 * (契约 §21.24 W0-22 第 7 条 / W0-24;设计稿 §7 第 11 行)。**不接进 worker**——接线点见 `verify_r21-asm-d4.md`。
 * 构造用手写期望(不调用被测函数算期望);写端口在真实目录里跑,并用读侧 `interpretView` 读回,证明「写出的就是读侧认得的」。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AutoViewSchema,
  PersonalLifecycleRecordSchema,
  type AutoView,
  type PersonalLifecycleRecord,
} from '../../../src/contracts/rsi-personal.js';
import { RSI_LIFECYCLE_STATES } from '../../../src/contracts/rsi.js';
import { exists, readText, stat } from '../../../src/io/read-fs.js';
import { mkdirp, writeFile } from '../../../src/io/safe-fs.js';
import { interpretView } from '../../../src/rsi/auto/read/view-read.js';
import { RsiLockError } from '../../../src/rsi/lock-error.js';
import {
  buildAutoView,
  VIEW_LIST_MAX,
  type AutoViewSnapshot,
} from '../../../src/rsi/personal/view-build.js';
import { writeAutoView } from '../../../src/rsi/personal/view-write.js';
import { makeCanaryWorld } from '../canary/w5-fixture.js';

const NOW = new Date('2026-11-15T10:00:00.000Z'); // 今天 = 2026-11-15
const OID = 'a'.repeat(40);
let seq = 0;
const idem = (): string => (++seq).toString(16).padStart(16, '0');
const cid = (n: number): string => `ra_${n.toString(16).padStart(12, '0')}`;
const tr = (to: string, at: string, reason: string, dim = 'lifecycle') => ({
  dim: dim as 'lifecycle',
  from: 'x',
  to,
  at,
  reason,
  idem_key: idem(),
});
type Tr = ReturnType<typeof tr>;

function rec(
  n: number,
  lifecycle: PersonalLifecycleRecord['lifecycle'],
  over: Partial<PersonalLifecycleRecord> = {},
): PersonalLifecycleRecord {
  const base = {
    schema_version: 1 as const,
    id: cid(n),
    category: 'rule' as const,
    lifecycle,
    deploy: { claude: 'none', pi: 'none', codex: 'none' } as PersonalLifecycleRecord['deploy'],
    watch: { claude: null, pi: null, codex: null },
    rollback: null,
    target_paths: ['rules/auto-x.md'],
    content_sha256: 'c'.repeat(64),
    fp_hmac: 'd'.repeat(16),
    cluster_id: 'c_0123abcd',
    case_set_sha256: null,
    blocked_from: null,
    transitions: [] as Tr[],
    transitions_dropped: 0,
    terminal_reason: null,
    overlaps_preset: false,
  };
  return { ...base, ...over } as PersonalLifecycleRecord;
}
const terminal = (
  n: number,
  to: 'rejected' | 'rolled_back' | 'expired' | 'retired',
  at: string,
  reason = 'no_hit',
): PersonalLifecycleRecord =>
  rec(n, to, {
    terminal_reason: (
      {
        rejected: 'rejected_gate',
        rolled_back: 'auto_rollback',
        expired: 'auto_expired',
        retired: 'no_hit',
      } as const
    )[to],
    transitions: [tr(to, at, reason)],
  });
const rolling = (
  n: number,
  kind: 'rolling_back' | 'retiring',
  at: string,
  extra: Tr[] = [],
): PersonalLifecycleRecord =>
  rec(n, kind, {
    deploy: { claude: 'removal_pending', pi: 'none', codex: 'none' },
    rollback: {
      phase: 'rollback_requested',
      reason: 'harm_c1',
      target_terminal: kind === 'retiring' ? 'retired' : 'rolled_back',
    },
    transitions: [...extra, tr(kind, at, 'harm_c1')],
  });

const snap = (over: Partial<AutoViewSnapshot> = {}): AutoViewSnapshot => ({
  now: NOW,
  recordOid: OID,
  records: [],
  groupCounts: new Map(),
  budgetUsedPct: 12.5,
  cost: { injectedBytesMean: 340, s2Count: 2 },
  protectionMarks: [],
  ...over,
});
function ok(s: AutoViewSnapshot): AutoView {
  const r = buildAutoView(s);
  if (!r.ok) throw new Error(`构造失败:${r.why}`);
  return r.view;
}
const why = (s: AutoViewSnapshot): string | null => {
  const r = buildAutoView(s);
  return r.ok ? null : r.why;
};
const mark = (n: number, m: 'protection_unknown' | 'protection_unclassified', at: string) => ({
  id: cid(n),
  mark: m,
  at,
});

describe('D4 view 构造:夹具自检与基础形状', () => {
  it('夹具里的记录都过 PersonalLifecycleRecordSchema(否则下面的断言没有意义)', () => {
    for (const r of [
      rec(1, 'proposed'),
      terminal(2, 'expired', '2026-11-01T00:00:00Z'),
      rolling(3, 'rolling_back', '2026-11-14T00:00:00Z'),
      rolling(4, 'retiring', '2026-11-14T00:00:00Z'),
      rec(5, 'canary', { deploy: { claude: 'injected', pi: 'none', codex: 'none' } }),
    ]) {
      expect(PersonalLifecycleRecordSchema.safeParse(r).success, r.lifecycle).toBe(true);
    }
  });

  it('空快照:每个 lifecycle 状态一个键(0)、四个终态 0、canary / last_rollback 为 null、两个清单空且未截断;过 AutoViewSchema', () => {
    const v = ok(snap());
    expect(AutoViewSchema.safeParse(v).success).toBe(true);
    expect(Object.keys(v.pipeline.states).sort()).toEqual([...RSI_LIFECYCLE_STATES].sort());
    expect(Object.values(v.pipeline.states).every((n) => n === 0)).toBe(true);
    expect(v).toMatchObject({
      schema_version: 1,
      as_of: '2026-11-15T10:00:00.000Z',
      record_oid: OID,
      pipeline: { last30d: { rejected: 0, rolled_back: 0, expired: 0, retired: 0 } },
      budget: { used_pct: 12.5 },
      cost: { injected_bytes_mean: 340, s2_count: 2 },
      canary: null,
      last_rollback: null,
      rolling_back: [],
      rolling_back_truncated: false,
      protection_marks: [],
      protection_marks_truncated: false,
    });
  });

  it('record_oid 就是输入的权威 HEAD(purge 改写后换了 HEAD,视图跟着换)', () => {
    expect(ok(snap({ recordOid: 'b'.repeat(40) })).record_oid).toBe('b'.repeat(40));
    expect(ok(snap({ recordOid: OID })).record_oid).toBe(OID);
  });

  it('pipeline.states 按状态计数', () => {
    const v = ok(
      snap({
        records: [
          rec(1, 'proposed'),
          rec(2, 'proposed'),
          rec(3, 'shadow'),
          terminal(4, 'rejected', '2026-01-01T00:00:00Z'),
        ],
      }),
    );
    expect(v.pipeline.states).toMatchObject({ proposed: 2, shadow: 1, rejected: 1, canary: 0 });
  });

  it('输出与记录输入顺序无关(确定性)', () => {
    const recs = [
      terminal(1, 'expired', '2026-11-10T00:00:00Z'),
      rolling(2, 'rolling_back', '2026-11-12T00:00:00Z'),
      rolling(3, 'retiring', '2026-11-12T00:00:00Z'),
      terminal(4, 'rolled_back', '2026-11-11T00:00:00Z'),
    ];
    const marks = [
      mark(1, 'protection_unknown', '2026-11-01T00:00:00Z'),
      mark(2, 'protection_unclassified', '2026-11-01T00:00:00Z'),
    ];
    expect(ok(snap({ records: recs, protectionMarks: marks }))).toEqual(
      ok(snap({ records: [...recs].reverse(), protectionMarks: [...marks].reverse() })),
    );
  });
});

describe('D4 view 构造:last30d 窗口(今天及前 29 个 UTC 日;只数进入终态的转移)', () => {
  it('边界:今天 / 前 29 日计入;前 30 日 / 未来日不计;非终态转移、deploy 维度转移不计', () => {
    const v = ok(
      snap({
        records: [
          terminal(1, 'expired', '2026-11-15T00:00:00Z'), // 今天
          terminal(2, 'expired', '2026-10-17T23:59:59Z'), // 前 29 日
          terminal(3, 'expired', '2026-10-16T23:59:59Z'), // 前 30 日:不计
          terminal(4, 'expired', '2026-11-16T00:00:00Z'), // 未来:不计
          terminal(5, 'rejected', '2026-11-14T00:00:00Z'),
          terminal(6, 'rolled_back', '2026-11-14T00:00:00Z'),
          terminal(7, 'retired', '2026-11-14T00:00:00Z'),
          rec(8, 'shadow', { transitions: [tr('shadow', '2026-11-14T00:00:00Z', 'gates_passed')] }),
          rec(9, 'shadow', {
            transitions: [tr('expired', '2026-11-14T00:00:00Z', 'no_hit', 'deploy')],
          }),
        ],
      }),
    );
    expect(v.pipeline.last30d).toEqual({ rejected: 1, rolled_back: 1, expired: 2, retired: 1 });
  });
});

describe('D4 view 构造:last_rollback', () => {
  it('取最近一次进入 rolled_back 的转移:at 最晚;同刻取 id 最小;reason 是该转移的原因码', () => {
    const v = ok(
      snap({
        records: [
          terminal(2, 'rolled_back', '2026-11-10T00:00:00Z', 'harm_c1'),
          terminal(3, 'rolled_back', '2026-11-12T00:00:00Z', 'harm_c2'),
          terminal(1, 'rolled_back', '2026-11-12T00:00:00Z', 'harm_c3'),
        ],
      }),
    );
    expect(v.last_rollback).toEqual({ id: cid(1), at: '2026-11-12T00:00:00Z', reason: 'harm_c3' });
  });

  it('没有进入过 rolled_back → null(不是占位对象);对照:进入 rolling_back 但未完成不算', () => {
    expect(
      ok(snap({ records: [terminal(1, 'expired', '2026-11-12T00:00:00Z')] })).last_rollback,
    ).toBeNull();
    expect(
      ok(snap({ records: [rolling(1, 'rolling_back', '2026-11-12T00:00:00Z')] })).last_rollback,
    ).toBeNull();
  });
});

describe('D4 view 构造:canary(缺统计不写成 0)', () => {
  const canary = (n: number) =>
    rec(n, 'canary', { deploy: { claude: 'injected', pi: 'none', codex: 'none' } });

  it('有 canary 且有分组计数 → {id, treat, control};没有 canary → null', () => {
    const g = new Map([[cid(5), { treat: 7, control: 6 }]]);
    expect(ok(snap({ records: [canary(5)], groupCounts: g })).canary).toEqual({
      id: cid(5),
      treat: 7,
      control: 6,
    });
    expect(ok(snap({ records: [rec(1, 'shadow')], groupCounts: g })).canary).toBeNull();
  });

  it('有 canary 但没有它的分组计数 → 不产出(canary_stats_missing);别的候选的计数不能顶替', () => {
    const other = new Map([[cid(9), { treat: 1, control: 1 }]]);
    expect(why(snap({ records: [canary(5)], groupCounts: new Map() }))).toBe(
      'canary_stats_missing',
    );
    expect(why(snap({ records: [canary(5)], groupCounts: other }))).toBe('canary_stats_missing');
  });

  it('同时有两个 canary(不变量被破坏)→ 不产出(canary_ambiguous),不挑一个', () => {
    const g = new Map([
      [cid(5), { treat: 1, control: 1 }],
      [cid(6), { treat: 2, control: 2 }],
    ]);
    expect(why(snap({ records: [canary(5), canary(6)], groupCounts: g }))).toBe('canary_ambiguous');
  });
});

describe('D4 view 构造:rolling_back(停住候选清单)', () => {
  it('rolling_back 与 retiring 都列;entered_at 取进入当前状态的最后一次 lifecycle 转移;origin_reason / target_terminal 来自 rollback;最久的在前', () => {
    const v = ok(
      snap({
        records: [
          rolling(3, 'rolling_back', '2026-11-14T08:00:00Z'),
          rolling(2, 'retiring', '2026-11-13T08:00:00Z'),
          // 进入过两次:取最后一次(同时混入 deploy 维度的同名转移,不算)
          rolling(1, 'rolling_back', '2026-11-12T09:00:00Z', [
            tr('rolling_back', '2026-11-01T00:00:00Z', 'harm_c1'),
            tr('rolling_back', '2026-11-20T00:00:00Z', 'harm_c1', 'deploy'),
          ]),
        ],
      }),
    );
    expect(
      v.rolling_back.map((r) => [r.id, r.entered_at, r.origin_reason, r.target_terminal]),
    ).toEqual([
      [cid(1), '2026-11-12T09:00:00Z', 'harm_c1', 'rolled_back'],
      [cid(2), '2026-11-13T08:00:00Z', 'harm_c1', 'retired'],
      [cid(3), '2026-11-14T08:00:00Z', 'harm_c1', 'rolled_back'],
    ]);
    expect(v.rolling_back[0]?.content_sha256).toBe('c'.repeat(64));
  });

  it('找不到进入当前状态的转移(历史被截断)→ 不产出(rolling_back_entry_unknown),不编造时间;补上转移即可产出(对照)', () => {
    const bad = rec(1, 'rolling_back', {
      deploy: { claude: 'removal_pending', pi: 'none', codex: 'none' },
      rollback: { phase: 'rollback_requested', reason: 'harm_c1', target_terminal: 'rolled_back' },
      transitions: [],
      transitions_dropped: 3,
    });
    expect(why(snap({ records: [bad] }))).toBe('rolling_back_entry_unknown');
    expect(why(snap({ records: [rolling(1, 'rolling_back', '2026-11-12T00:00:00Z')] }))).toBeNull();
  });

  it('至多 64 条:恰好 64 条不截断;65 条保留最久的 64 条并置 rolling_back_truncated', () => {
    const mkN = (k: number): PersonalLifecycleRecord[] =>
      Array.from({ length: k }, (_, i) =>
        rolling(i + 1, 'rolling_back', new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString()),
      );
    const a = ok(snap({ records: mkN(VIEW_LIST_MAX) }));
    expect([a.rolling_back.length, a.rolling_back_truncated]).toEqual([64, false]);
    const b = ok(snap({ records: mkN(VIEW_LIST_MAX + 1) }));
    expect([b.rolling_back.length, b.rolling_back_truncated]).toEqual([64, true]);
    expect(b.rolling_back[0]?.id).toBe(cid(1)); // 最久的保留
    expect(b.rolling_back.some((r) => r.id === cid(65))).toBe(false); // 最新的被截
  });
});

describe('D4 view 构造:protection_marks(90 个 UTC 日后移除;至多 64 条保留最新)', () => {
  it('第 90 个 UTC 日当天移除、前一天仍保留(边界);标记不依赖候选状态', () => {
    const v = ok(
      snap({
        protectionMarks: [
          mark(1, 'protection_unknown', '2026-08-17T10:00:00Z'), // 08-17 + 90 日 = 11-15 = 今天:移除
          mark(2, 'protection_unknown', '2026-08-18T00:00:00Z'), // + 90 日 = 11-16:保留
          mark(3, 'protection_unclassified', '2026-01-01T00:00:00Z'), // 早已过期
        ],
      }),
    );
    expect(v.protection_marks.map((m) => m.id)).toEqual([cid(2)]);
  });

  it('同 (id, mark) 只留最新;同一候选的两种标记各保留;按 at 降序、同刻按 id', () => {
    const v = ok(
      snap({
        protectionMarks: [
          mark(1, 'protection_unknown', '2026-11-01T00:00:00Z'),
          mark(1, 'protection_unknown', '2026-11-05T00:00:00Z'),
          mark(1, 'protection_unclassified', '2026-11-02T00:00:00Z'),
          mark(3, 'protection_unknown', '2026-11-05T00:00:00Z'),
          mark(2, 'protection_unknown', '2026-11-05T00:00:00Z'),
        ],
      }),
    );
    expect(v.protection_marks.map((m) => [m.id, m.mark, m.at])).toEqual([
      [cid(1), 'protection_unknown', '2026-11-05T00:00:00Z'],
      [cid(2), 'protection_unknown', '2026-11-05T00:00:00Z'],
      [cid(3), 'protection_unknown', '2026-11-05T00:00:00Z'],
      [cid(1), 'protection_unclassified', '2026-11-02T00:00:00Z'],
    ]);
  });

  it('至多 64 条:恰好 64 条不截断;65 条保留最新的 64 条(最老的被截)并置 protection_marks_truncated', () => {
    const mkN = (k: number) =>
      Array.from({ length: k }, (_, i) =>
        mark(i + 1, 'protection_unknown', new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString()),
      );
    const a = ok(snap({ protectionMarks: mkN(64) }));
    expect([a.protection_marks.length, a.protection_marks_truncated]).toEqual([64, false]);
    const b = ok(snap({ protectionMarks: mkN(65) }));
    expect([b.protection_marks.length, b.protection_marks_truncated]).toEqual([64, true]);
    expect(b.protection_marks[0]?.id).toBe(cid(65)); // 最新在前
    expect(b.protection_marks.some((m) => m.id === cid(1))).toBe(false); // 最老的被截
  });
});

describe('D4 view 构造:出口校验(不合 schema 不产出)', () => {
  it('预算越界 / 负数 / 非十六进制 oid / 非整数计数 → schema_invalid;正向对照:合法值产出', () => {
    expect(why(snap())).toBeNull();
    expect(why(snap({ budgetUsedPct: 100.5 }))).toBe('schema_invalid');
    expect(why(snap({ budgetUsedPct: -1 }))).toBe('schema_invalid');
    expect(why(snap({ recordOid: 'xyz' }))).toBe('schema_invalid');
    expect(why(snap({ cost: { injectedBytesMean: 10, s2Count: -1 } }))).toBe('schema_invalid');
    expect(why(snap({ cost: { injectedBytesMean: 10, s2Count: 1.5 } }))).toBe('schema_invalid');
  });

  it('字节均值四舍五入取整(契约是整数);0 与边界 100 合法', () => {
    expect(
      ok(snap({ cost: { injectedBytesMean: 1234.5, s2Count: 0 } })).cost.injected_bytes_mean,
    ).toBe(1235);
    expect(
      ok(snap({ cost: { injectedBytesMean: 1234.4, s2Count: 0 } })).cost.injected_bytes_mean,
    ).toBe(1234);
    expect(ok(snap({ budgetUsedPct: 0 })).budget.used_pct).toBe(0);
    expect(ok(snap({ budgetUsedPct: 100 })).budget.used_pct).toBe(100);
  });
});

describe('D4 view 构造:历史不可见时拒绝重建(不把「看不见」写成确定的 0 / null)', () => {
  it('transitions_dropped > 0 本身不拒绝重建(终态进入转移是最后追加的条目,截不掉):终态 / 非终态记录照常产出确定计数;对照:截断且进入转移缺失 → history_incomplete', () => {
    const t = terminal(1, 'expired', '2026-11-10T00:00:00Z');
    expect(ok(snap({ records: [t] })).pipeline.last30d.expired).toBe(1);
    expect(ok(snap({ records: [{ ...t, transitions_dropped: 2 }] })).pipeline.last30d.expired).toBe(
      1,
    );
    // 非终态记录上有截断:不可能藏着终态转移,不冻结全局视图
    expect(why(snap({ records: [rec(2, 'shadow', { transitions_dropped: 1 })] }))).toBeNull();
    expect(
      why(snap({ records: [rec(3, 'proposed'), { ...t, id: cid(4), transitions_dropped: 1 }] })),
    ).toBeNull();
    // 对照:同一条终态记录,进入转移真的不在了 → 拒绝(拒绝理由是缺转移,不是截断计数)
    expect(why(snap({ records: [{ ...t, transitions: [], transitions_dropped: 2 }] }))).toBe(
      'history_incomplete',
    );
  });

  it('终态记录里找不到进入该终态的 lifecycle 转移 → history_incomplete(last_rollback 不能写成 null);对照:补上转移即可产出', () => {
    const bare = rec(1, 'rolled_back', { terminal_reason: 'auto_rollback', transitions: [] });
    expect(why(snap({ records: [bare] }))).toBe('history_incomplete');
    // 只有别的状态 / 别的维度的转移也不行
    const other = rec(2, 'expired', {
      terminal_reason: 'auto_expired',
      transitions: [tr('shadow', '2026-11-10T00:00:00Z', 'gates_passed')],
    });
    expect(why(snap({ records: [other] }))).toBe('history_incomplete');
    const good = terminal(1, 'rolled_back', '2026-11-12T00:00:00Z', 'harm_c1');
    expect(ok(snap({ records: [good] })).last_rollback).toEqual({
      id: cid(1),
      at: '2026-11-12T00:00:00Z',
      reason: 'harm_c1',
    });
  });
});

describe('D4 view 构造:候选 id 必须唯一(重复记录不得放大聚合)', () => {
  it('同一 id 的两条记录(非 canary、终态均可)→ input_invalid;对照:不同 id 时各计一次', () => {
    const a = rec(1, 'proposed');
    expect(why(snap({ records: [a, a] }))).toBe('input_invalid');
    const t = terminal(2, 'expired', '2026-11-10T00:00:00Z');
    expect(why(snap({ records: [t, t] }))).toBe('input_invalid');
    // 对照:id 不同 → 状态计数 2、last30d 2(放大的就是这两个数)
    const v = ok(
      snap({
        records: [a, rec(3, 'proposed'), t, terminal(4, 'expired', '2026-11-10T00:00:00Z')],
      }),
    );
    expect([v.pipeline.states['proposed'], v.pipeline.last30d.expired]).toEqual([2, 2]);
  });
});

describe('D4 view 构造:坏输入不外抛', () => {
  it('标记 / 转移里的时间戳无法解析(日期运算抛错)→ input_invalid,不外抛;对照:合法时间戳产出', () => {
    expect(why(snap({ protectionMarks: [mark(1, 'protection_unknown', 'not-a-date')] }))).toBe(
      'input_invalid',
    );
    expect(why(snap({ records: [terminal(1, 'expired', 'also-not-a-date')] }))).toBe(
      'input_invalid',
    );
    expect(
      why(snap({ protectionMarks: [mark(1, 'protection_unknown', '2026-11-01T00:00:00Z')] })),
    ).toBeNull();
  });
});

describe('D4 view 写端口(真实目录;持 rsi/lock;读侧 interpretView 读回)', () => {
  const held = { assertHeld: async (): Promise<void> => undefined };
  const view = (over: Partial<AutoViewSnapshot> = {}): AutoView => ok(snap(over));
  const lockAfter = (okCalls: number, err: Error) => {
    let n = 0;
    return {
      calls: () => n,
      assertHeld: async (): Promise<void> => {
        if (++n > okCalls) throw err;
      },
    };
  };

  it('写成功:文件 0600、没有临时文件;读侧读回 fresh 且与写入的视图逐键相等;record_oid 不变', async () => {
    const w = await makeCanaryWorld('d4-vw-ok-');
    const v = view({ recordOid: 'e'.repeat(40) });
    expect(await writeAutoView({ io: w.io, rsiDir: w.rsi, locks: { rsi: held } }, v)).toEqual({
      ok: true,
    });
    const file = path.join(w.rsi, 'auto-view.json');
    expect(((await stat(file)).mode & 0o777).toString(8)).toBe('600');
    expect(await exists(`${file}.tmp`)).toBe(false);
    const text = await readText(file);
    const read = interpretView({ kind: 'ok', text }, NOW);
    expect(read).toEqual({ state: 'fresh', view: v });
    expect(read.state === 'fresh' && read.view.record_oid).toBe('e'.repeat(40));
  });

  it('再次写入整体替换旧视图(不是合并):读侧看到新的 as_of 与 oid', async () => {
    const w = await makeCanaryWorld('d4-vw-replace-');
    const d = { io: w.io, rsiDir: w.rsi, locks: { rsi: held } };
    await writeAutoView(d, view({ recordOid: '1'.repeat(40) }));
    const later = new Date('2026-11-15T11:00:00.000Z');
    await writeAutoView(d, ok(snap({ now: later, recordOid: '2'.repeat(40) })));
    const read = interpretView(
      { kind: 'ok', text: await readText(path.join(w.rsi, 'auto-view.json')) },
      later,
    );
    expect(read.state === 'fresh' && [read.view.as_of, read.view.record_oid]).toEqual([
      '2026-11-15T11:00:00.000Z',
      '2'.repeat(40),
    ]);
  });

  it('写前就丢锁 → lock_lost,不创建文件;已有旧视图则原样不动', async () => {
    const w = await makeCanaryWorld('d4-vw-lost0-');
    const lost = lockAfter(0, new Error('lock_lost'));
    const file = path.join(w.rsi, 'auto-view.json');
    expect(await writeAutoView({ io: w.io, rsiDir: w.rsi, locks: { rsi: lost } }, view())).toEqual({
      ok: false,
      why: 'lock_lost',
    });
    expect(await exists(file)).toBe(false);
    expect(await exists(`${file}.tmp`)).toBe(false);

    const old = 'OLD-VIEW-BYTES\n';
    await writeFile(w.io, file, old, { mode: 0o600 });
    await writeAutoView(
      { io: w.io, rsiDir: w.rsi, locks: { rsi: lockAfter(0, new Error('x')) } },
      view(),
    );
    expect(await readText(file)).toBe(old);
  });

  it('写的中途(临时文件已建、rename 之前)丢锁 → 旧视图原样不动;RsiLockError(lock_lost) 报 lock_lost,其它错误报 write_failed', async () => {
    const w = await makeCanaryWorld('d4-vw-lost1-');
    const file = path.join(w.rsi, 'auto-view.json');
    const old = 'OLD-VIEW-BYTES\n';
    await writeFile(w.io, file, old, { mode: 0o600 });
    // 调用序:端口预检 1;writeRsiFileAtomic 内 remove 前 2、createExclusive 前 3、rename 前 4 —— 让第 4 次(rename 之前)失败
    const a = lockAfter(3, new RsiLockError('lock_lost'));
    expect(await writeAutoView({ io: w.io, rsiDir: w.rsi, locks: { rsi: a } }, view())).toEqual({
      ok: false,
      why: 'lock_lost',
    });
    expect(a.calls()).toBeGreaterThanOrEqual(4);
    expect(await readText(file)).toBe(old);
    const b = lockAfter(3, new Error('boom'));
    expect(await writeAutoView({ io: w.io, rsiDir: w.rsi, locks: { rsi: b } }, view())).toEqual({
      ok: false,
      why: 'write_failed',
    });
    expect(await readText(file)).toBe(old);
  });

  it('rename 失败(目标位置是非空目录)→ write_failed;临时文件被清掉,旧内容(目录)原样不动,不抛错', async () => {
    const w = await makeCanaryWorld('d4-vw-rename-');
    const file = path.join(w.rsi, 'auto-view.json');
    await mkdirp(w.io, file, 0o700);
    await writeFile(w.io, path.join(file, 'keep'), 'x', { mode: 0o600 });
    expect(await writeAutoView({ io: w.io, rsiDir: w.rsi, locks: { rsi: held } }, view())).toEqual({
      ok: false,
      why: 'write_failed',
    });
    expect(await exists(`${file}.tmp`)).toBe(false);
    expect(await readText(path.join(file, 'keep'))).toBe('x');
  });

  it('视图对象本身读取即抛错(奇异对象)→ invalid_view,不外抛,零写入', async () => {
    const w = await makeCanaryWorld('d4-vw-throwy-');
    const weird = {};
    Object.defineProperty(weird, 'schema_version', {
      enumerable: true,
      get() {
        throw new Error('getter boom');
      },
    });
    expect(
      await writeAutoView({ io: w.io, rsiDir: w.rsi, locks: { rsi: held } }, weird as AutoView),
    ).toEqual({ ok: false, why: 'invalid_view' });
    expect(await exists(path.join(w.rsi, 'auto-view.json'))).toBe(false);
  });

  it('视图不合 schema(跨信任边界再校验)→ invalid_view,零写入;对照:同一端口写合法视图成功', async () => {
    const w = await makeCanaryWorld('d4-vw-invalid-');
    const d = { io: w.io, rsiDir: w.rsi, locks: { rsi: held } };
    const file = path.join(w.rsi, 'auto-view.json');
    const good = view();
    for (const bad of [
      { ...good, record_oid: 'zz' },
      { ...good, extra_key: 1 },
      { ...good, budget: { used_pct: 101 } },
    ]) {
      expect(await writeAutoView(d, bad as unknown as AutoView)).toEqual({
        ok: false,
        why: 'invalid_view',
      });
      expect(await exists(file)).toBe(false);
    }
    expect(await writeAutoView(d, good)).toEqual({ ok: true });
    expect(await exists(file)).toBe(true);
  });

  it('违规视图报 invalid_view(不是 write_failed):校验通过之后才会走到序列化,二者原因码不同;对照:合法视图成功', async () => {
    const w = await makeCanaryWorld('d4-vw-invalid-why-');
    const d = { io: w.io, rsiDir: w.rsi, locks: { rsi: held } };
    const good = view();
    for (const bad of [
      { ...good, record_oid: 'zz' },
      { ...good, budget: { used_pct: 'x' } },
      { ...good, schema_version: 2 },
      { ...good, cost: { injected_bytes_mean: -1, s2_count: 0 } },
    ]) {
      expect(await writeAutoView(d, bad as unknown as AutoView), JSON.stringify(bad)).toEqual({
        ok: false,
        why: 'invalid_view',
      });
    }
    expect(await exists(path.join(w.rsi, 'auto-view.json'))).toBe(false);
    expect(await writeAutoView(d, good)).toEqual({ ok: true });
  });

  describe('写端口的封闭枚举复核(schema 里是开放字符串的三处;不改已冻结的 AutoViewSchema)', () => {
    const withRollback = (): AutoView =>
      view({
        records: [
          terminal(1, 'rolled_back', '2026-11-12T00:00:00Z', 'harm_c1'),
          rolling(2, 'rolling_back', '2026-11-13T00:00:00Z'),
        ],
      });

    it('last_rollback.reason / rolling_back[].origin_reason 不在转移原因码枚举里(如绝对路径 / 用户名)→ invalid_view,零写入;对照:合法原因码写成功', async () => {
      const w = await makeCanaryWorld('d4-vw-reason-');
      const d = { io: w.io, rsiDir: w.rsi, locks: { rsi: held } };
      const file = path.join(w.rsi, 'auto-view.json');
      const good = withRollback();
      expect(good.last_rollback?.reason).toBe('harm_c1');
      expect(good.rolling_back[0]?.origin_reason).toBe('harm_c1');

      const badA = {
        ...good,
        last_rollback: { ...(good.last_rollback as object), reason: '/Users/alice/private' },
      };
      const badB = {
        ...good,
        rolling_back: good.rolling_back.map((r) => ({ ...r, origin_reason: '/home/bob/x' })),
      };
      for (const bad of [badA, badB]) {
        // 前提:它们确实通过 AutoViewSchema(所以只有语义复核能拦住)
        expect(AutoViewSchema.safeParse(bad).success).toBe(true);
        expect(await writeAutoView(d, bad as unknown as AutoView)).toEqual({
          ok: false,
          why: 'invalid_view',
        });
        expect(await exists(file)).toBe(false);
      }
      expect(await writeAutoView(d, good)).toEqual({ ok: true });
      expect(await exists(file)).toBe(true);
    });

    it('pipeline.states 的键不是生命周期状态集合(多一个键 / 少一个键 / 换成路径)→ invalid_view;对照:完整键集写成功', async () => {
      const w = await makeCanaryWorld('d4-vw-states-');
      const d = { io: w.io, rsiDir: w.rsi, locks: { rsi: held } };
      const file = path.join(w.rsi, 'auto-view.json');
      const good = view();
      const withStates = (states: Record<string, number>): AutoView => ({
        ...good,
        pipeline: { ...good.pipeline, states },
      });
      const extra = withStates({ ...good.pipeline.states, '/Users/alice': 1 });
      const fewer = Object.fromEntries(
        Object.entries(good.pipeline.states).filter(([k]) => k !== 'proposed'),
      );
      const renamed = withStates({ ...fewer, '/Users/alice/x': 0 });
      for (const bad of [extra, withStates(fewer), renamed]) {
        expect(AutoViewSchema.safeParse(bad).success).toBe(true);
        expect(await writeAutoView(d, bad)).toEqual({ ok: false, why: 'invalid_view' });
        expect(await exists(file)).toBe(false);
      }
      expect(await writeAutoView(d, good)).toEqual({ ok: true });
    });
  });
});
