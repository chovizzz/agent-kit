/**
 * R20-A2 B4c2:`runL0UnderLock` / `commitL0` 的提交顺序、counts 三段重算、索引可写条件、baseline、幂等。真实 reader / pipeline / 锁 / 快照,假 HOME。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RSI_INDEX_MAX_ENTRIES,
  RsiCountsSchema,
  RsiCursorSchema,
  RsiProjectIndexSchema,
  type RsiConfirm,
  type RsiState,
} from '../../src/contracts/rsi.js';
import { canonicalJson } from '../../src/io/canonical-json.js';
import { exists, readText, stat } from '../../src/io/read-fs.js';
import { remove } from '../../src/io/safe-fs.js';
import { RsiFailClosedError } from '../../src/rsi/types.js';
import { readSnapshot } from '../../src/rsi/snapshot.js';
import { KEY_A, SALT_FP, countsDoc, put, writeCountsRaw, writeIndex } from './services-fixture.js';
import {
  emptyState,
  inputOf,
  makeRunFx,
  mutator,
  rsiFile,
  runL0,
  type RunFx,
} from './l0-run-fixture.js';

const counts = async (fx: RunFx): Promise<ReturnType<typeof RsiCountsSchema.parse>> =>
  RsiCountsSchema.parse(await rsiFile(fx.s, 'counts.json'));
const indexOf = async (fx: RunFx): Promise<ReturnType<typeof RsiProjectIndexSchema.parse>> =>
  RsiProjectIndexSchema.parse(await rsiFile(fx.s, 'projects.json'));

describe('commitL0:基本提交与顺序', () => {
  it('首次采集:盐首建 → 信号 → 会话计数 → 索引 → counts → state → cursor → 日志 → 清单,顺序与产物都对', async () => {
    const fx = await makeRunFx('l0c-basic-', { salt: false });
    const a = await fx.work('alpha');
    await fx.claude(1, a);
    const order: string[] = [];
    const r = await runL0(fx, inputOf(), {
      beforeWrite: async (op, p) => {
        order.push(`${op}@${path.basename(p) || '-'}`);
      },
    });
    expect(r).toMatchObject({
      outcome: 'ok',
      stage: 'full',
      indexWritten: true,
      cursorWritten: true,
      indexFullDropped: false,
    });
    expect(r.signalsNew).toBe(2);
    expect(r.sessionsNew).toBe(1);
    const pos = {
      salt: order.findIndex((o) => o.startsWith('salt-create')),
      sig: order.findIndex((o) => /^rename@\d{6}\.jsonl$/.test(o)),
      idx: order.findIndex((o) => o.includes('rename:projects.json')),
      counts: order.findIndex((o) => o.includes('rename:counts.json')),
      state: order.findIndex((o) => o.includes('rename:state.json')),
      cursor: order.findIndex((o) => o.includes('rename:cursor.json')),
      snap: order.findIndex((o) => o.includes('snapshot-rename')),
    };
    for (const [k, v] of Object.entries(pos)) expect(v, `${k} 写点存在`).toBeGreaterThanOrEqual(0);
    expect(order[0]).toBe('mkdirp@.state'); // 盐首建的目录创建也经 gate
    expect(pos.salt).toBeLessThan(pos.sig);
    expect(pos.sig).toBeLessThan(pos.idx);
    expect(pos.idx).toBeLessThan(pos.counts);
    expect(pos.counts).toBeLessThan(pos.state);
    expect(pos.state).toBeLessThan(pos.cursor);
    expect(pos.cursor).toBeLessThan(pos.snap);

    const index = await indexOf(fx);
    const c = await counts(fx);
    const cursor = RsiCursorSchema.parse(await rsiFile(fx.s, 'cursor.json'));
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0]).toMatchObject({
      sessions: 1,
      signals: 2,
      first_indexed_generation: 1,
    });
    const key = index.entries[0]?.key as string;
    expect(c.per_key[key]).toMatchObject({ signals_total: 2, sessions: 1 });
    expect(cursor.full_scan).toMatchObject({ epoch: 1, done: true });
    expect(Object.keys(cursor.files)).toHaveLength(1);
    expect((await readSnapshot(fx.s.io)).kind).toBe('ok');
    const log = (await readText(path.join(fx.s.rsi, 'log.jsonl'))).trim().split('\n');
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0] as string)).toMatchObject({ action: 'completed', code: 'ok' });
    expect(r.summary.projects).toEqual({ collecting: 1, excluded: 0, new: 1 });
  });

  it('重跑幂等:第二、三次 signals_new = 0 / sessions_new = 0,counts 三段与索引条目不变,cursor 文件表不变', async () => {
    const fx = await makeRunFx('l0c-idem-');
    const a = await fx.work('alpha');
    await fx.claude(1, a, { text: 'from now on stop running the slow suite' });
    await fx.claude(2, a);
    const r1 = await runL0(fx);
    expect(r1.signalsNew).toBeGreaterThan(0);
    const c1 = await counts(fx);
    const i1 = await indexOf(fx);
    const cur1 = RsiCursorSchema.parse(await rsiFile(fx.s, 'cursor.json'));
    expect(c1.clusters.length).toBeGreaterThan(0); // 正向前提:确有聚类,下面「不变」才不是空对空
    for (let i = 0; i < 2; i++) {
      const r = await runL0(fx);
      expect(r).toMatchObject({ signalsNew: 0, sessionsNew: 0, outcome: 'ok' });
      const c = await counts(fx);
      expect(c.per_key).toEqual(c1.per_key);
      expect(c.clusters).toEqual(c1.clusters);
      expect(c.unknown_keys_signals).toBe(c1.unknown_keys_signals);
      const idx = await indexOf(fx);
      expect(idx.entries).toEqual(i1.entries);
      expect(idx.generation).toBe(i1.generation + i + 1); // 每次提交 generation +1(D7 / 方案 §4.2)
      const cur = RsiCursorSchema.parse(await rsiFile(fx.s, 'cursor.json'));
      expect(cur.files).toEqual(cur1.files);
    }
  });
});

describe('commitL0:counts 三段从磁盘重算(每次提交)', () => {
  it('clusters:C1 之后(C2 之前)崩溃,重跑新增为 0,clusters 仍含上次已入库的信号(D13-A)', async () => {
    const fx = await makeRunFx('l0c-clusters-');
    const a = await fx.work('alpha');
    await fx.claude(1, a, { text: 'from now on stop running the slow suite' });
    // 崩在 C2(会话计数)第一个写点:信号库已提交,counts.json 还没写过
    let crashed = false;
    await expect(
      runL0(fx, inputOf(), {
        beforeWrite: async (_op, p) => {
          if (p.includes(`${path.sep}sessions${path.sep}`) && !crashed) {
            crashed = true;
            throw new Error('crash-after-C1');
          }
        },
      }),
    ).rejects.toThrow('crash-after-C1');
    expect(await exists(path.join(fx.s.rsi, 'counts.json'))).toBe(false);
    expect(await exists(path.join(fx.s.state, 'signals', 'claude', '202610.jsonl'))).toBe(true);
    const r = await runL0(fx);
    expect(r.signalsNew).toBe(0); // 全部被 sig_id 去重
    const c = await counts(fx);
    expect(c.clusters).toHaveLength(1);
    expect(Object.values(c.clusters[0]?.evidence_by_key ?? {})).toEqual([1]);
    expect(Object.keys(c.clusters[0]?.evidence_by_key ?? {})[0]).toMatch(/^p_[0-9a-f]{16}$/);
  });

  it('staged.tainted 只取 TAINTED 文件的事实:证据 key 属 X 但没有 TAINTED 文件 → 仍为 false;手放一个 TAINTED(本次没新增 taint)→ 下一次提交校正为 true', async () => {
    const fx = await makeRunFx('l0c-staged-', {
      extraToml: (f) => `exclude_dirs = [${JSON.stringify(path.join(f.dir, 'work', 'secret'))}]\n`,
    });
    const s = fx.s;
    const a = await fx.work('alpha');
    const secret = await fx.work('secret');
    await fx.claude(1, a);
    // 索引里有 KEY_A → secret(被排除:X),盐指纹一致 → 索引可写;暂存 run 的证据 key 就是这个 X key
    await writeIndex(s, [{ key: KEY_A, root: secret }]);
    await writeCountsRaw(
      s,
      countsDoc(SALT_FP, {
        staged: [{ run_id: 'run-x', proposals: 1, evidence_keys: [KEY_A], tainted: false }],
      }),
    );
    await runL0(fx);
    let c = await counts(fx);
    expect(c.staged).toEqual([
      { run_id: 'run-x', proposals: 1, evidence_keys: [KEY_A], tainted: false },
    ]); // 没有 X 推导掺进来
    await put(
      s,
      path.join(s.state, 'reflect', 'run-x', 'TAINTED'),
      '{"reason":"exclude","at":"2026-10-26T00:00:00.000Z"}\n',
    );
    await runL0(fx);
    c = await counts(fx);
    expect(c.staged[0]?.tainted).toBe(true);
    expect(c.staged[0]?.evidence_keys).toEqual([KEY_A]); // 只改 tainted
  });
});

describe('commitL0:索引可写条件(D7)与 updateIndex.full', () => {
  it('索引损坏 / 盐指纹不符 / 索引缺失但 cursor 在:索引字节不变(不覆盖),信号照写;首次(索引与 cursor 都缺失)建立索引(正向对照)', async () => {
    const fx0 = await makeRunFx('l0c-d7-ok-');
    await fx0.claude(1, await fx0.work('a'));
    expect((await runL0(fx0)).indexWritten).toBe(true);

    for (const kind of ['corrupt', 'salt_mismatch', 'absent_with_cursor'] as const) {
      const fx = await makeRunFx(`l0c-d7-${kind}-`);
      const a = await fx.work('alpha');
      await fx.claude(1, a);
      const s = fx.s;
      const idxFile = path.join(s.rsi, 'projects.json');
      if (kind === 'corrupt') await put(s, idxFile, '{"nope":1}\n');
      else if (kind === 'salt_mismatch')
        await writeIndex(s, [{ key: KEY_A, root: a }], 'f'.repeat(12));
      else {
        // 先正常跑一次留下 cursor,再删索引
        await runL0(fx);
        await remove(s.f.fx, idxFile);
        await fx.claude(2, a);
      }
      const before = (await exists(idxFile)) ? await readText(idxFile) : null;
      const r = await runL0(fx);
      expect(r.indexWritten, kind).toBe(false);
      expect(r.signalsNew, kind).toBeGreaterThan(0); // 信号照写
      const after = (await exists(idxFile)) ? await readText(idxFile) : null;
      expect(after, kind).toBe(before);
    }
  });

  it('updateIndex.full(本次有 key 因索引满被丢)≠ 索引当前已满:满索引 + 新项目 → indexFullDropped=true 且信号照写;满索引 + 没有新 key → false', async () => {
    const fx = await makeRunFx('l0c-full-');
    const s = fx.s;
    const old = await fx.work('old');
    // 构造一个已满的索引(合法 schema,盐指纹一致)
    const st = await stat(old);
    const entries = Array.from({ length: RSI_INDEX_MAX_ENTRIES }, (_, i) => ({
      key: `p_${(i + 1).toString(16).padStart(16, '0')}`,
      roots: [
        { path: old, dev: st.dev, ino: st.ino, first_seen: '2026-10-01', last_seen: '2026-10-01' },
      ],
      sessions: 0,
      signals: 0,
      first_indexed_generation: 1,
    }));
    await put(
      s,
      path.join(s.rsi, 'projects.json'),
      canonicalJson({ schema_version: 1, salt_fp: SALT_FP, generation: 1, entries }),
    );
    const fresh = await fx.work('fresh');
    await fx.claude(1, fresh);
    const r = await runL0(fx);
    expect(r).toMatchObject({ indexWritten: true, indexFullDropped: true });
    expect(r.signalsNew).toBeGreaterThan(0);
    const idx = await indexOf(fx);
    expect(idx.entries).toHaveLength(RSI_INDEX_MAX_ENTRIES);
    expect(r.summary.unknown_signals).toBeGreaterThan(0); // 被丢的 key 的信号计入 U,不是消失
    // 索引**当前**仍是满的,但这次没有新观测(会话未改动)→ 没有 key 被丢 → 不报 indexFullDropped
    const r2 = await runL0(fx);
    expect(r2.indexFullDropped).toBe(false);
    expect((await indexOf(fx)).entries).toHaveLength(RSI_INDEX_MAX_ENTRIES);
  });
});

describe('commitL0:baseline_pending 与 confirm', () => {
  const confirmDoc = (over: Partial<RsiConfirm> = {}): RsiConfirm => ({
    confirmed_at: '2026-10-20T00:00:00.000Z',
    kit_major: 0,
    agents: ['claude', 'codex', 'pi'],
    exclude_hashes: [],
    repo_sha256: 'a'.repeat(64),
    repo_dev_ino: { dev: 1, ino: 1 },
    overlay_sha256: null,
    policy_fp: 'b'.repeat(64),
    baseline_pending: true,
    ...over,
  });
  const writeState = async (fx: RunFx, st: Record<string, unknown>): Promise<void> =>
    put(fx.s, path.join(fx.s.rsi, 'state.json'), canonicalJson(st));
  const readState = async (fx: RunFx): Promise<RsiState> =>
    (await rsiFile(fx.s, 'state.json')) as RsiState;

  it('确认后第一次成功 L0:baseline_pending true → false、projects_ack_generation = 本次索引 generation;之后重跑不再推进(幂等);mutator 想改回 true 也改不动', async () => {
    const fx = await makeRunFx('l0c-ack-');
    await fx.claude(1, await fx.work('alpha'));
    await writeState(fx, { ...emptyState(), confirm: confirmDoc(), projects_ack_generation: 0 });
    await runL0(fx);
    let st = await readState(fx);
    const gen = (await indexOf(fx)).generation;
    expect(st.confirm?.baseline_pending).toBe(false);
    expect(st.projects_ack_generation).toBe(gen);
    await fx.claude(2, await fx.work('beta')); // 新项目:不算「新增」基线之前的,但 ack 不再被推进
    await runL0(
      fx,
      inputOf({
        stateMutator: (prev, s) => ({
          ...mutator(prev, s),
          confirm: confirmDoc({ baseline_pending: true }),
        }),
      }),
    );
    st = await readState(fx);
    expect(st.confirm?.baseline_pending).toBe(false); // true → false 是单向的
    expect(st.projects_ack_generation).toBe(gen); // 不被后续成功 L0 推进(只有 rsi status --ack 能推进)
  });

  it('坏 confirm(单独不合规)原样透传回写:其余字段照常更新,confirm 的原始 JSON 值逐字节不变', async () => {
    const fx = await makeRunFx('l0c-badconfirm-');
    await fx.claude(1, await fx.work('alpha'));
    const bad = { confirmed_at: 'not-a-date', extra: [1, { x: null }], baseline_pending: 'yes' };
    await writeState(fx, { ...emptyState(), confirm: bad });
    await runL0(fx);
    const raw = JSON.parse(await readText(path.join(fx.s.rsi, 'state.json'))) as Record<
      string,
      unknown
    >;
    expect(raw['confirm']).toEqual(bad);
    expect((raw['last_tick'] as { outcome: string }).outcome).toBe('ok'); // 正向:其余字段确实被更新了
  });

  it('state.json 整份过不了 schema → state_invalid(fail-closed),且不写任何数据文件', async () => {
    const fx = await makeRunFx('l0c-stateinvalid-');
    await fx.claude(1, await fx.work('alpha'));
    await writeState(fx, { schema_version: 1, bogus: true });
    await expect(runL0(fx)).rejects.toMatchObject({ reason: 'state_invalid' });
    await expect(runL0(fx)).rejects.toBeInstanceOf(RsiFailClosedError);
    expect(await exists(path.join(fx.s.state, 'signals'))).toBe(false);
  });
});
