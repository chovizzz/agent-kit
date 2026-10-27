/**
 * R20-A2 B2:十个 R20 schema 的合法 / 错误示例矩阵(docs/contracts.md §20.14,带标记,已在 registry.ts 登记)。
 * 错误示例断言「状态、阻断范围、原因码」三者,不只断言 zod 成败:有消费方的 schema 经真实消费路径验证
 * (配置加载器、`parseRsiStateDoc` / `rsiStateOf`、生产校验器);消费方在后续块才落地的(purge journal、taint / stop 标记、日志行)
 * 只断言失败的字段路径,三者的文字说明在文档里,接线时补消费路径断言。
 * 另:稳定码补充枚举与文档一致;R20-2.6 / R20-1.2 的缺省与边界。
 */
import { stringify as tomlStringify } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import {
  RSI_LOCKED_NOT_RUN_CODES,
  RSI_LOCK_STATES,
  RSI_USAGE_REASONS,
  RsiBaseSchema,
  RsiConfirmSchema,
  RsiCountsSchema,
  RsiCursorSchema,
  RsiLogLineSchema,
  RsiPolicySchema,
  RsiProjectIndexSchema,
  RsiPurgeJournalSchema,
  RsiStateSchema,
  RsiStopMarkSchema,
  RsiTaintMarkSchema,
} from '../../src/contracts/rsi.js';
import { readText } from '../../src/io/read-fs.js';
import { chmod, writeFile } from '../../src/io/safe-fs.js';
import { loadRsiConfig } from '../../src/rsi/config.js';
import { privacyGate } from '../../src/rsi/gate.js';
import { parseRsiStateDoc, rsiStateOf } from '../../src/rsi/state.js';
import { productionSnapshotValidator } from '../../src/rsi/validators.js';
import { makeRsiFx } from '../rsi/rsi-fixture.js';
import { SCHEMAS } from './registry.js';

const DOC = new URL('../../docs/contracts.md', import.meta.url).pathname;
const MARKER = /<!-- example:(valid|invalid) schema=([A-Za-z]+) -->\s*```json\n([\s\S]*?)\n```/g;
const NAMES = [
  'RsiBase',
  'RsiPolicy',
  'RsiState',
  'RsiProjectIndex',
  'RsiCounts',
  'RsiCursor',
  'RsiPurgeJournal',
  'RsiTaintMark',
  'RsiStopMark',
  'RsiLogLine',
] as const;

const md = await readText(DOC);
const examples = [...md.matchAll(MARKER)].map((m) => ({
  kind: m[1] as 'valid' | 'invalid',
  schema: m[2] as string,
  json: JSON.parse(m[3] as string) as unknown,
}));
const example = (kind: 'valid' | 'invalid', schema: string): unknown => {
  const e = examples.find((x) => x.kind === kind && x.schema === schema);
  if (e === undefined) throw new Error(`缺示例 ${kind} ${schema}`);
  return e.json;
};
const bytes = (v: unknown): Buffer => Buffer.from(JSON.stringify(v));
const failedPaths = (name: string, v: unknown): string[] => {
  const schema = SCHEMAS[name];
  if (schema === undefined) throw new Error(`未登记 ${name}`);
  const r = schema.safeParse(v);
  expect(r.success).toBe(false);
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
};

describe('十个 R20 schema 都已登记,且各有合法 + 错误示例', () => {
  for (const n of NAMES) {
    it(n, () => {
      expect(SCHEMAS[n]).toBeDefined();
      expect(SCHEMAS[n]?.safeParse(example('valid', n)).success).toBe(true);
      expect(SCHEMAS[n]?.safeParse(example('invalid', n)).success).toBe(false);
    });
  }
});

describe('错误示例:状态 / 阻断范围 / 原因码(经真实消费路径)', () => {
  it('RsiBase(agents 含 kimi):配置 off / cfg_schema;judge / promote 的即时闸 fail-closed 同码(变异:接受 kimi → 红)', async () => {
    const f = await makeRsiFx('b2-base-');
    const bad = example('invalid', 'RsiBase') as Record<string, unknown>;
    expect(failedPaths('RsiBase', bad)).toEqual(['agents.0']);
    const cfgText = tomlStringify({ rsi: { ...bad, repo: f.repo } });
    await writeFile(f.fx, f.cfgFile, cfgText, { mode: 0o600 });
    await chmod(f.fx, f.cfgFile, 0o600);
    const cfg = await loadRsiConfig({ home: f.home });
    expect(cfg).toEqual({ status: 'off', reason: 'cfg_schema' }); // 状态 off、原因码 cfg_schema
    expect(privacyGate(cfg)).toMatchObject({ kind: 'deny', reason: 'cfg_schema', exit: 3 }); // 阻断范围
    // 合法示例换上仓库后是 on
    const okText = tomlStringify({
      rsi: { ...(example('valid', 'RsiBase') as object), repo: f.repo },
    });
    await writeFile(f.fx, f.cfgFile, okText, { mode: 0o600 });
    expect((await loadRsiConfig({ home: f.home })).status).toBe('on');
  });

  it('RsiPolicy(agents 未升序):作为确认记录的 agents 时 confirm 过不了 schema → armed / schema(非首次)', async () => {
    const bad = example('invalid', 'RsiPolicy') as { agents: string[] };
    expect(failedPaths('RsiPolicy', bad)).toEqual(['agents']);
    const f = await makeRsiFx('b2-policy-');
    await writeFile(f.fx, f.cfgFile, `[rsi]\nenabled = true\nrepo = ${JSON.stringify(f.repo)}\n`, {
      mode: 0o600,
    });
    await chmod(f.fx, f.cfgFile, 0o600);
    const cfg = await loadRsiConfig({ home: f.home });
    const good = example('valid', 'RsiState') as { confirm: Record<string, unknown> };
    const doc = parseRsiStateDoc(
      bytes({
        ...(example('valid', 'RsiState') as object),
        confirm: { ...good.confirm, agents: bad.agents },
      }),
    );
    expect(doc.kind).toBe('confirm_schema_invalid');
    expect(rsiStateOf({ config: cfg, stopPresent: false, doc })).toMatchObject({
      state: 'armed',
      firstArmed: false,
      confirmInvalid: 'schema',
    });
    expect(RsiConfirmSchema.safeParse({ ...good.confirm, agents: bad.agents }).success).toBe(false);
  });

  it('RsiState(projects_ack_generation 为负):整份 invalid → state_invalid(生产校验器判否)、状态 armed + stateInvalid(status 退出 3、自动路径空操作)', async () => {
    const bad = example('invalid', 'RsiState');
    expect(failedPaths('RsiState', bad)).toEqual(['projects_ack_generation']);
    expect(productionSnapshotValidator.fixed('state.json', bytes(bad))).toBe(false);
    expect(parseRsiStateDoc(bytes(bad))).toEqual({ kind: 'invalid' });
    const f = await makeRsiFx('b2-state-');
    await writeFile(f.fx, f.cfgFile, `[rsi]\nenabled = true\nrepo = ${JSON.stringify(f.repo)}\n`, {
      mode: 0o600,
    });
    await chmod(f.fx, f.cfgFile, 0o600);
    const cfg = await loadRsiConfig({ home: f.home });
    expect(
      rsiStateOf({ config: cfg, stopPresent: false, doc: parseRsiStateDoc(bytes(bad)) }),
    ).toMatchObject({ state: 'armed', stateInvalid: true });
    expect(
      productionSnapshotValidator.fixed('state.json', bytes(example('valid', 'RsiState'))),
    ).toBe(true);
  });

  it('RsiProjectIndex(roots 为空):索引 invalid,但快照校验不阻断(D4)——index_invalid 只影响索引状态', () => {
    const bad = example('invalid', 'RsiProjectIndex');
    expect(failedPaths('RsiProjectIndex', bad)).toEqual(['entries.0.roots']);
    expect(productionSnapshotValidator.fixed('projects.json', bytes(bad))).toBe(true); // 不阻断
    expect(productionSnapshotValidator.fixed('projects.json', null)).toBe(true); // 缺失放行(D5)
  });

  it('RsiCounts / RsiCursor 错误示例:快照校验判否(counts_invalid / cursor_invalid 由 reasonFor 映射)', () => {
    const counts = example('invalid', 'RsiCounts');
    expect(failedPaths('RsiCounts', counts)[0]).toMatch(/^clusters\.0\.evidence_by_key/);
    expect(productionSnapshotValidator.fixed('counts.json', bytes(counts))).toBe(false);
    const cursor = example('invalid', 'RsiCursor');
    expect(failedPaths('RsiCursor', cursor)[0]).toMatch(/^files\.s_0123456789abcdef\.status/);
    expect(productionSnapshotValidator.fixed('cursor.json', bytes(cursor))).toBe(false);
    for (const n of ['counts.json', 'cursor.json', 'state.json']) {
      expect(productionSnapshotValidator.fixed(n, null), `${n} 缺失 = 损坏`).toBe(false);
    }
  });

  it('RsiPurgeJournal / RsiTaintMark / RsiStopMark / RsiLogLine:失败字段(消费方在 B4 / B5 落地后补消费路径断言)', () => {
    expect(failedPaths('RsiPurgeJournal', example('invalid', 'RsiPurgeJournal'))).toEqual([
      'phase',
    ]);
    expect(failedPaths('RsiTaintMark', example('invalid', 'RsiTaintMark'))).toEqual(['reason']);
    expect(failedPaths('RsiStopMark', example('invalid', 'RsiStopMark'))).toEqual(['by']);
    expect(failedPaths('RsiLogLine', example('invalid', 'RsiLogLine'))).toEqual(['code']);
  });
});

describe('schema 边界', () => {
  it('RsiBase 缺省都是可选(enabled 缺省由加载器按 false 处理);agents 去重前非空;接受 session 表', () => {
    expect(RsiBaseSchema.safeParse({}).success).toBe(true);
    expect(RsiBaseSchema.safeParse({ agents: [] }).success).toBe(false);
    expect(RsiBaseSchema.safeParse({ session: {} }).success).toBe(true);
    expect(RsiBaseSchema.safeParse({ session: [] }).success).toBe(false);
    expect(RsiBaseSchema.safeParse({ enabled: 'true' }).success).toBe(false);
    for (const bad of ['kimi', 'opencode', 'openclaw']) {
      expect(RsiBaseSchema.safeParse({ agents: [bad] }).success, bad).toBe(false);
    }
  });

  it('RsiProjectIndex:key 重复 / 未升序 / 超 8 个 roots / 超 10000 条目 都拒', () => {
    const ok = example('valid', 'RsiProjectIndex') as { entries: Record<string, unknown>[] };
    const e0 = ok.entries[0] as Record<string, unknown> & { roots: unknown[] };
    const key = (n: number): string => `p_${n.toString(16).padStart(16, '0')}`;
    const mk = (keys: string[]): unknown => ({
      ...ok,
      entries: keys.map((k) => ({ ...e0, key: k })),
    });
    expect(RsiProjectIndexSchema.safeParse(mk([key(1), key(2)])).success).toBe(true);
    expect(RsiProjectIndexSchema.safeParse(mk([key(1), key(1)])).success).toBe(false);
    expect(RsiProjectIndexSchema.safeParse(mk([key(2), key(1)])).success).toBe(false);
    expect(
      RsiProjectIndexSchema.safeParse({
        ...ok,
        entries: [{ ...e0, roots: Array.from({ length: 9 }, () => e0.roots[0]) }],
      }).success,
    ).toBe(false);
    expect(
      RsiProjectIndexSchema.safeParse(mk(Array.from({ length: 10001 }, (_, i) => key(i)))).success,
    ).toBe(false);
  });

  it('RsiCounts:signals_by_day 超过 8 个 UTC 日拒;RsiPolicy / RsiState / RsiCursor 拒多余字段', () => {
    const c = example('valid', 'RsiCounts') as {
      per_key: Record<string, { signals_by_day: Record<string, number> }>;
    };
    const k = Object.keys(c.per_key)[0] as string;
    const days = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`2026-10-${String(i + 10)}`, 1]),
    );
    expect(
      RsiCountsSchema.safeParse({
        ...c,
        per_key: { [k]: { ...c.per_key[k], signals_by_day: days } },
      }).success,
    ).toBe(false);
    for (const [name, schema] of [
      ['RsiPolicy', RsiPolicySchema],
      ['RsiState', RsiStateSchema],
      ['RsiCursor', RsiCursorSchema],
      ['RsiPurgeJournal', RsiPurgeJournalSchema],
      ['RsiTaintMark', RsiTaintMarkSchema],
      ['RsiStopMark', RsiStopMarkSchema],
      ['RsiLogLine', RsiLogLineSchema],
    ] as const) {
      expect(
        schema.safeParse({ ...(example('valid', name) as object), extra: 1 }).success,
        name,
      ).toBe(false);
    }
  });
});

describe('稳定码补充枚举与文档一致', () => {
  it('RSI_USAGE reason(R20-3.0 总表第一行)', () => {
    const row = md.split('\n').find((l) => l.startsWith('| `RSI_USAGE reason=`'));
    expect(row).toBeDefined();
    const cell = (row ?? '').split('|')[2] ?? '';
    const codes = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
    expect([...RSI_USAGE_REASONS].sort()).toEqual(codes.sort());
  });

  it('D3:四个 *_NOT_RUN reason=locked 只登记码;D7:lock 枚举含 unsafe(文档与枚举一致)', () => {
    expect([...RSI_LOCKED_NOT_RUN_CODES]).toEqual([
      'SIGNALS_NOT_RUN',
      'PROMOTE_NOT_RUN',
      'REFLECT_NOT_RUN',
      'JUDGE_NOT_RUN',
    ]);
    const section = md.slice(md.indexOf('### 20.14'), md.indexOf('## 21. 自主 RSI'));
    for (const c of RSI_LOCKED_NOT_RUN_CODES) expect(section).toContain(c);
    expect([...RSI_LOCK_STATES]).toEqual(['free', 'held', 'held_over_ttl', 'stale', 'unsafe']);
    expect(md).toContain('`lock`(`free|held|held_over_ttl|stale|unsafe`');
  });
});
