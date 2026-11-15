/**
 * 装配块 A 段:只读适配器的读侧契约测试(真实适配器 + 夹具世界;每条不变量带负向用例与正向对照)。
 * 契约(与测试假件、写侧实现同一份):**读失败 = 抛错 / `invalid` / `unreadable` / `null`,绝不冒充「空 / 缺失 / 干净」**;缺失(absent / missing)只表示「确认不存在」。
 * 覆盖:`peekRecord(s)` / `recordedSha`(经受限只读 git 的 `RecordedReadPort` 假件)、撤销凭据读(与写侧 `homeRevocationReader` 逐输入对拍)、B 标记读(与写侧端口对拍)、
 * `StagedSource` / `SignalLookup` / `PresetSource`、分析源四端口(`collectedThrough` / `c4Bytes` / `payloadDrift`)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RsiRevocationLine } from '../../../src/contracts/rsi-personal.js';
import { RSI_AUTO_PAUSE_REASONS } from '../../../src/contracts/rsi.js';
import { readText } from '../../../src/io/read-fs.js';
import * as safe from '../../../src/io/safe-fs.js';
import {
  makePeekRecord,
  makePeekRecords,
  makeRecordedShaRead,
} from '../../../src/rsi/auto/read/peek.js';
import { makeBreakerMarkerPort } from '../../../src/rsi/canary/pause-marker.js';
import { makeBreakerMarkerReader } from '../../../src/rsi/canary/pause-marker-read.js';
import {
  collectedThroughOf,
  makeAnalysisReadPorts,
} from '../../../src/rsi/analysis/source-ports.js';
import { makeHomeReadPort } from '../../../src/rsi/personal/read/home-reads.js';
import { makeRevocationReadAdapter } from '../../../src/rsi/personal/read/credentials.js';
import {
  makePresetSource,
  makeSignalLookup,
  makeStagedSource,
  presetOf,
  type PresetPayload,
} from '../../../src/rsi/personal/read/step-sources.js';
import { homeRevocationReader } from '../../../src/rsi/personal/rollback-ports.js';
import { HEAD, ID, makeWorld, portsOf, recordFile, setCommit } from '../auto/auto-fixture.js';
import { canaryDoc, makeCanaryWorld } from '../canary/w5-fixture.js';
import { makeWorld as makeHomeWorld } from '../personal/repo-helpers.js';
import { rec } from '../personal/transition-fixture.js';
import { baseState } from '../ro-fixture.js';
import { REPO_ROOT } from '../../helpers/tmp.js';
import { newWorld, sha } from '../../sync/world.js';

// ---------------------------------------------------------------------------
// peek / recordedSha
// ---------------------------------------------------------------------------
describe('peekRecord(s) / recordedSha:经 RecordedReadPort 的只读预读', () => {
  const withRecord = () => {
    const w = makeWorld();
    setCommit(w, HEAD, recordFile(rec('canary')));
    return w;
  };

  it('peek:head.json 不存在 = absent;读成功且 id 在 = ok;读成功且 id 不在 = missing(正向对照)', async () => {
    const none = makeWorld();
    expect(await makePeekRecords(portsOf(none))()).toEqual({ kind: 'absent' });
    expect(await makePeekRecord(portsOf(none))(ID)).toEqual({ kind: 'absent' });

    const w = withRecord();
    const one = await makePeekRecord(portsOf(w))(ID);
    expect(one.kind).toBe('ok');
    expect(one.kind === 'ok' && one.record.id).toBe(ID);
    expect(await makePeekRecord(portsOf(w))('ra_ffffffffffff')).toEqual({
      kind: 'missing',
      head: HEAD,
    });
    const all = await makePeekRecords(portsOf(w))();
    expect(all.kind === 'ok' && all.value.map((r) => r.id)).toEqual([ID]);
  });

  it('peek:读失败 / 记录不合规 / head 不合规 / 不稳定一律是 invalid,绝不是 missing 或 absent', async () => {
    const unreadable = withRecord();
    unreadable.recordedUnreadable = 'timeout';
    expect((await makePeekRecord(portsOf(unreadable))(ID)).kind).toBe('invalid');
    expect((await makePeekRecords(portsOf(unreadable))()).kind).toBe('invalid');

    const badRecord = makeWorld();
    setCommit(badRecord, HEAD, { [`lifecycle/${ID}.json`]: '{bad' });
    expect((await makePeekRecord(portsOf(badRecord))(ID)).kind).toBe('invalid');

    const badHead = withRecord();
    badHead.head = { kind: 'ok', text: '{"nope":1}' };
    expect((await makePeekRecord(portsOf(badHead))(ID)).kind).toBe('invalid');

    const unstable = withRecord();
    unstable.hooks.after = (op, n) => {
      if (op === 'head') {
        unstable.head = {
          kind: 'ok',
          text: JSON.stringify({
            schema_version: 1,
            head: HEAD,
            owner_repo_fp: n.toString(16).padStart(16, '0'),
          }),
        };
      }
    };
    const busy = await makePeekRecord(portsOf(unstable))(ID);
    expect(busy).toEqual({ kind: 'invalid', why: 'snapshot_busy' });

    // 抛错的端口同样 = invalid(不外泄异常、不当成缺失)
    const throwing = withRecord();
    const p = portsOf(throwing);
    const boom = { ...p, home: { ...p.home, head: async () => Promise.reject(new Error('io')) } };
    expect((await makePeekRecord(boom)(ID)).kind).toBe('invalid');
  });

  it('recordedSha:读到 = content_sha256;读不到 / 候选不在 / 记录坏 = null', async () => {
    const w = withRecord();
    const got = await makeRecordedShaRead(portsOf(w))(ID);
    expect(got).toBe(rec('canary').content_sha256);
    expect(await makeRecordedShaRead(portsOf(w))('ra_ffffffffffff')).toBeNull();
    const bad = withRecord();
    bad.recordedUnreadable = 'nonzero_exit';
    expect(await makeRecordedShaRead(portsOf(bad))(ID)).toBeNull();
    expect(await makeRecordedShaRead(portsOf(makeWorld()))(ID)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 撤销凭据读
// ---------------------------------------------------------------------------
const REV = (n: number): RsiRevocationLine => ({
  at: '2026-11-10T00:00:00.000Z',
  candidate_id: ID,
  content_sha256: String(n % 10).repeat(64),
  identity12: null,
  reason: 'harm_c1',
  by: 'worker',
});

describe('撤销凭据读(只读适配器)与写侧 homeRevocationReader 同一契约', () => {
  it('缺失 = ok [];合法 = 行;读失败 / 缺尾换行 / 坏行 / 不合 schema / 权限过宽 = invalid(绝不是空);与写侧逐输入同结论', async () => {
    const w = await makeHomeWorld('asm-a-rev-');
    await safe.mkdirp(w.io, w.h.stateDir, 0o700);
    const file = path.join(w.h.stateDir, 'revocations.jsonl');
    const mine = makeRevocationReadAdapter(makeHomeReadPort(w.home));
    const theirs = homeRevocationReader(w.h);
    const both = async () => [await mine.read(), await theirs.read()] as const;
    const kindsAndLines = (r: Awaited<ReturnType<typeof mine.read>>) => ({
      kind: r.kind,
      lines: r.kind === 'ok' ? r.lines : null,
    });

    // 缺失
    const [a0, b0] = await both();
    expect(kindsAndLines(a0)).toEqual({ kind: 'ok', lines: [] });
    expect(kindsAndLines(b0)).toEqual(kindsAndLines(a0));

    // 合法(对照)
    const good = `${JSON.stringify(REV(1))}\n${JSON.stringify(REV(2))}\n`;
    await safe.writeFile(w.io, file, good, { mode: 0o600 });
    const [a1, b1] = await both();
    expect(a1.kind === 'ok' && a1.lines.length).toBe(2);
    expect(kindsAndLines(b1)).toEqual(kindsAndLines(a1));

    // 各种坏输入:都是 invalid,且两个实现一致
    const bad: [string, string][] = [
      ['缺尾换行', `${JSON.stringify(REV(1))}`],
      ['坏 JSON 行', `${JSON.stringify(REV(1))}\n{nope\n`],
      ['不合 schema', `${JSON.stringify({ ...REV(1), extra: 1 })}\n`],
      ['空行', `${JSON.stringify(REV(1))}\n\n`],
    ];
    for (const [why, text] of bad) {
      await safe.writeFile(w.io, file, text, { mode: 0o600 });
      const [a, b] = await both();
      expect(a.kind, why).toBe('invalid');
      expect(b.kind, why).toBe('invalid');
    }

    // 权限过宽 / 符号链接:读失败 = invalid,不是空
    await safe.writeFile(w.io, file, good, { mode: 0o600 });
    await safe.chmod(w.io, file, 0o644);
    const [a2, b2] = await both();
    expect([a2.kind, b2.kind]).toEqual(['invalid', 'invalid']);
    await safe.remove(w.io, file);
    await safe.symlink(w.io, path.join(w.dir, 'elsewhere'), file);
    const [a3, b3] = await both();
    expect([a3.kind, b3.kind]).toEqual(['invalid', 'invalid']);
  });

  it('端口抛错 → invalid(不外泄、不当成空)', async () => {
    const r = makeRevocationReadAdapter({ revocations: () => Promise.reject(new Error('io')) });
    expect((await r.read()).kind).toBe('invalid');
  });
});

// ---------------------------------------------------------------------------
// B 标记读
// ---------------------------------------------------------------------------
describe('B 标记只读端口与写侧端口 read 同一语义', () => {
  it('缺失 = null;合法 / 不认识的内容 = 与写侧端口相同的解析;类型上只有 read;读错误(非 ENOENT)抛错,绝不是 null;悬空 / 有效符号链接也抛错', async () => {
    const w = await makeCanaryWorld('asm-a-marker-');
    const reader = makeBreakerMarkerReader(w.rsi);
    const writer = makeBreakerMarkerPort(w.io, w.rsi, () => new Date('2026-11-15T00:00:00Z'));
    expect(Object.keys(reader)).toEqual(['read']);
    const file = path.join(w.rsi, 'AUTO_PAUSE_BREAKER');

    expect(await reader.read()).toBeNull();
    expect(await writer.read()).toBeNull();

    const reason = RSI_AUTO_PAUSE_REASONS[0];
    const bodies = [
      JSON.stringify({
        at: '2026-11-15T00:00:00.000Z',
        by: 'breaker',
        reason,
        id: '0123456789abcdef',
      }),
      JSON.stringify({ by: 'user' }),
      'not json',
      '',
    ];
    for (const body of bodies) {
      await safe.remove(w.io, file).catch(() => undefined);
      await safe.writeFile(w.io, file, body, { mode: 0o600 });
      expect(await reader.read(), body).toEqual(await writer.read());
      expect(await reader.read(), body).not.toBeNull();
    }

    // 读侧比写侧更严:符号链接(悬空链接跟随读会报 ENOENT,不能据此说「没有标记」;有效链接也不跟随)→ 抛错。写侧端口对悬空链接返回 null,这里有意不对拍
    const dangling = await makeCanaryWorld('asm-a-marker-dl-');
    await safe.symlink(
      dangling.io,
      path.join(dangling.dir, 'nowhere'),
      path.join(dangling.rsi, 'AUTO_PAUSE_BREAKER'),
    );
    await expect(makeBreakerMarkerReader(dangling.rsi).read()).rejects.toThrow();
    const linked = await makeCanaryWorld('asm-a-marker-ln-');
    await safe.writeFile(linked.io, path.join(linked.dir, 'real-marker'), '{"by":"user"}', {
      mode: 0o600,
    });
    await safe.symlink(
      linked.io,
      path.join(linked.dir, 'real-marker'),
      path.join(linked.rsi, 'AUTO_PAUSE_BREAKER'),
    );
    await expect(makeBreakerMarkerReader(linked.rsi).read()).rejects.toThrow();

    // 读错误:路径是目录 → 两边都抛错(不是 null / 不是「不存在」)
    await safe.remove(w.io, file);
    await safe.mkdirp(w.io, file, 0o700);
    await expect(reader.read()).rejects.toThrow();
    await expect(writer.read()).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// StagedSource
// ---------------------------------------------------------------------------
describe('StagedSource:暂存提案来源', () => {
  const entry = (
    run_id: string,
    o: Partial<{ tainted: boolean; evidence_keys: string[] }> = {},
  ) => ({
    run_id,
    proposals: 1,
    evidence_keys: o.evidence_keys ?? ['p_a'],
    tainted: o.tainted ?? false,
  });
  const loaded = (runId: string) => ({
    loaded: [{ proposal: { id: `prop-${runId}` }, ruleText: `rule ${runId}` }],
    unsupported: [],
  });
  const deps = (entries: ReturnType<typeof entry>[], cls: Record<string, 'P' | 'X' | 'U'>) => {
    const loadedRuns: string[] = [];
    return {
      loadedRuns,
      d: {
        io: {} as never,
        staged: async () => entries as never,
        classify: async (k: string) => cls[k] ?? 'U',
        loadEntries: async (_io: unknown, runId: string) => {
          loadedRuns.push(runId);
          return loaded(runId) as never;
        },
      },
    };
  };

  it('只收未 tainted、证据非空、全部归属 P 的 run;其余不装载(正向对照:合规 run 被装载)', async () => {
    const { d, loadedRuns } = deps(
      [
        entry('run-ok'),
        entry('run-tainted', { tainted: true }),
        entry('run-foreign', { evidence_keys: ['p_a', 'p_x'] }),
        entry('run-empty', { evidence_keys: [] }),
      ],
      { p_a: 'P', p_x: 'X' },
    );
    const out = await makeStagedSource(d).list();
    expect(out.map((s) => s.runId)).toEqual(['run-ok']);
    expect(loadedRuns).toEqual(['run-ok']);
  });

  it('装载失败 / 暂存清单读失败 → 抛错(不跳过坏 run 去尽量)', async () => {
    const { d } = deps([entry('run-a'), entry('run-b')], { p_a: 'P' });
    const failing = {
      ...d,
      loadEntries: async (_io: unknown, runId: string) => {
        if (runId === 'run-b') throw new Error('corrupt run');
        return loaded(runId) as never;
      },
    };
    await expect(makeStagedSource(failing).list()).rejects.toThrow('corrupt run');
    const noCounts = {
      ...d,
      staged: async () => {
        throw new Error('counts unreadable');
      },
    };
    await expect(makeStagedSource(noCounts).list()).rejects.toThrow('counts unreadable');
  });
});

// ---------------------------------------------------------------------------
// SignalLookup
// ---------------------------------------------------------------------------
const signalLine = (n: number, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    sig_id: `sig_${n.toString(16).padStart(16, '0')}`,
    agent: 'claude',
    agent_version: '2.1.0',
    agent_version_source: 'session_meta',
    session_ref: `s_${n.toString(16).padStart(16, '0')}`,
    project_key: 'p1',
    ts: '2026-11-05T10:00:00Z',
    type: 'event',
    excerpt_redacted: '',
    external_content: false,
    confidence: 1,
    loaded_rule_ids: [],
    event_kind: 'tool_result_failed',
    event_index: 0,
    ...extra,
  });
const sigId = (n: number): string => `sig_${n.toString(16).padStart(16, '0')}`;

async function putSignals(
  w: Awaited<ReturnType<typeof makeCanaryWorld>>,
  lines: string[],
): Promise<void> {
  await safe.mkdirp(w.io, path.join(w.io.stateDir, 'signals', 'claude'), 0o700);
  await safe.writeFile(
    w.io,
    path.join(w.io.stateDir, 'signals', 'claude', '202611.jsonl'),
    `${lines.join('\n')}\n`,
    { mode: 0o600 },
  );
}

describe('SignalLookup:按 sig_id 取信号', () => {
  it('只回命中的(库里没有的 id 不在结果里);空输入 = []', async () => {
    const w = await makeCanaryWorld('asm-a-sig-');
    await putSignals(w, [signalLine(1), signalLine(2), signalLine(3)]);
    const lookup = makeSignalLookup({ io: w.io });
    const got = await lookup.getMany([sigId(2), sigId(3), sigId(9)]);
    expect(got.map((s) => s.sig_id)).toEqual([sigId(2), sigId(3)]);
    expect(await lookup.getMany([])).toEqual([]);
  });

  it('任一行不合 schema → 整体抛错(不返回「少几条」冒充成功);信号库不存在 = 空', async () => {
    const w = await makeCanaryWorld('asm-a-sig-bad-');
    await putSignals(w, [signalLine(1), '{"sig_id":"bad"}', signalLine(2)]);
    await expect(makeSignalLookup({ io: w.io }).getMany([sigId(1)])).rejects.toThrow();
    // 对照:同样的查询在合规的库上成功;没有信号库 = 空
    const ok = await makeCanaryWorld('asm-a-sig-ok-');
    await putSignals(ok, [signalLine(1)]);
    expect((await makeSignalLookup({ io: ok.io }).getMany([sigId(1)])).length).toBe(1);
    const none = await makeCanaryWorld('asm-a-sig-none-');
    expect(await makeSignalLookup({ io: none.io }).getMany([sigId(1)])).toEqual([]);
  });
  it('已枚举的月文件打开前消失(scan 返回 null)→ 整体抛错,不当成「这些 id 不存在」(正向对照:scan 返回文件号时成功)', async () => {
    const w = await makeCanaryWorld('asm-a-sig-vanish-');
    const list = async (): Promise<string[]> => ['/x/202611.jsonl'];
    const vanished = makeSignalLookup({ io: w.io, list, scan: async () => null });
    await expect(vanished.getMany([sigId(1)])).rejects.toThrow();
    const present = makeSignalLookup({ io: w.io, list, scan: async () => ({}) as never });
    expect(await present.getMany([sigId(1)])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PresetSource
// ---------------------------------------------------------------------------
const SKILL_MD = (name: string, desc: string, body = 'step one\nstep two\n'): string =>
  `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\n${body}`;

describe('PresetSource:预置技能的比对形', () => {
  const payload =
    (
      files: PresetPayload['manifest']['files'],
      contents: [string, string][],
    ): (() => Promise<PresetPayload>) =>
    async () => ({ manifest: { files }, contents: new Map(contents) });

  it('取包内 kind=skill 的 SKILL.md:id = name、do = description、why = 正文;多 agent 副本只取第一份(按 payload_path 升序);其它类别 / 非 SKILL.md 不收', async () => {
    const src = makePresetSource({
      payload: payload(
        [
          { kind: 'skill', payload_path: 'files/pi/home/x/commit-checklist/SKILL.md' },
          { kind: 'skill', payload_path: 'files/claude/home/x/commit-checklist/SKILL.md' },
          { kind: 'skill', payload_path: 'files/claude/home/x/commit-checklist/notes.md' },
          { kind: 'rules', payload_path: 'files/claude/home/rules/a/SKILL.md' },
        ],
        [
          ['files/pi/home/x/commit-checklist/SKILL.md', SKILL_MD('commit-checklist', 'pi copy')],
          [
            'files/claude/home/x/commit-checklist/SKILL.md',
            SKILL_MD('commit-checklist', 'claude copy'),
          ],
          ['files/claude/home/rules/a/SKILL.md', SKILL_MD('not-a-skill', 'x')],
        ],
      ),
    });
    const got = await src.presets();
    expect(got.map((t) => [t.id, t.do])).toEqual([['commit-checklist', 'claude copy']]);
    expect(got[0]?.why).toContain('step one');
  });

  it('读失败 / 形状不合规 → 抛错,绝不返回空:内容缺失、没有 frontmatter、缺 name / description / 正文', async () => {
    const one = (text: string | undefined) =>
      makePresetSource({
        payload: payload(
          [{ kind: 'skill', payload_path: 'files/a/home/s/SKILL.md' }],
          text === undefined ? [] : [['files/a/home/s/SKILL.md', text]],
        ),
      }).presets();
    expect((await one(SKILL_MD('s', 'd'))).length).toBe(1); // 对照
    await expect(one(undefined)).rejects.toThrow();
    await expect(one('# no frontmatter\n')).rejects.toThrow();
    await expect(one('---\nname: s\n---\nbody\n')).rejects.toThrow();
    await expect(one('---\ndescription: d\n---\nbody\n')).rejects.toThrow();
    await expect(one('---\nname: s\ndescription: d\n---\n   \n')).rejects.toThrow();
    await expect(
      makePresetSource({ payload: () => Promise.reject(new Error('no payload')) }).presets(),
    ).rejects.toThrow('no payload');
    expect(presetOf(SKILL_MD('s', 'd')).id).toBe('s');
  });
  it('frontmatter 按 YAML 取真实值:折叠多行标量、引号;空值 / 非字符串 / 非映射 / 坏 YAML → 抛错;包内真实技能文件可解析', async () => {
    const folded = presetOf(
      '---\nname: review\ndescription: >\n  Review code changes\n  and find regressions.\n---\nbody\n',
    );
    expect(folded.do).toBe('Review code changes and find regressions.');
    expect(presetOf('---\nname: "q: r"\ndescription: \'d: e\'\n---\nbody\n')).toMatchObject({
      id: 'q: r',
      do: 'd: e',
    });
    for (const bad of [
      '---\nname: s\ndescription: ""\n---\nbody\n',
      '---\nname: 5\ndescription: d\n---\nbody\n',
      '---\n- a\n- b\n---\nbody\n',
      '---\nname: s\ndescription: [x\n---\nbody\n',
    ]) {
      expect(() => presetOf(bad), bad).toThrow();
    }
    const real = presetOf(await readText(path.join(REPO_ROOT, 'skills/commit-checklist/SKILL.md')));
    expect(real.id).toBe('commit-checklist');
    expect(real.do.startsWith('提交或汇报完成前')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 分析源四端口
// ---------------------------------------------------------------------------
describe('分析源端口 collectedThrough:最近一次完整成功 tick 的开始时刻', () => {
  const tick = (over: Record<string, unknown>) =>
    Buffer.from(
      JSON.stringify(
        baseState({
          last_tick: {
            completed_at: '2026-11-15T10:00:10.000Z',
            trigger: 'tick',
            outcome: 'ok',
            code: null,
            duration_ms: 10_000,
            files_read: 1,
            bytes_read: 1,
            ...over,
          },
        }),
      ),
    );

  it('ok:取开始时刻(完成时刻减时长);ok_partial / 其它结果 / 无 tick / 缺失 / 不合规 = null(分析 unavailable)', () => {
    expect(collectedThroughOf(tick({}))).toBe('2026-11-15T10:00:00.000Z');
    expect(collectedThroughOf(tick({ outcome: 'ok_partial' }))).toBeNull();
    expect(collectedThroughOf(tick({ outcome: 'io_error' }))).toBeNull();
    expect(collectedThroughOf(Buffer.from(JSON.stringify(baseState())))).toBeNull();
    expect(collectedThroughOf(null)).toBeNull();
    expect(collectedThroughOf(Buffer.from('{nope'))).toBeNull();
    expect(collectedThroughOf(Buffer.from('{"schema_version":1}'))).toBeNull();
  });
});

describe('分析源端口 c4Bytes:canary.json 的 treat 注入字节数', () => {
  it('合规 = 字节数;缺失 / 不合规 = null(不是 0)', async () => {
    const w = await makeCanaryWorld('asm-a-c4-');
    const ports = makeAnalysisReadPorts({
      home: w.home,
      rsiDir: w.rsi,
      classify: async () => 'P',
      readState: async () => null,
    });
    expect(await ports.c4Bytes()).toBeNull();
    await safe.writeFile(w.io, path.join(w.rsi, 'canary.json'), '{bad', { mode: 0o600 });
    expect(await ports.c4Bytes()).toBeNull();
    await safe.writeFile(w.io, path.join(w.rsi, 'canary.json'), JSON.stringify(canaryDoc()), {
      mode: 0o600,
    });
    const n = await ports.c4Bytes();
    expect(typeof n).toBe('number');
    expect(n).toBeGreaterThan(0);
  });
});

describe('分析源端口 payloadDrift:登记表条目的当前内容 vs 登记 sha', () => {
  const SKILL_PATH = '.claude/skills/commit-checklist/SKILL.md';
  const ledger = (text: string) =>
    JSON.stringify({
      schema_version: 1,
      kit_version: '1.0.0',
      payload_sha256: 'c'.repeat(64),
      entries: [
        {
          path: SKILL_PATH,
          kind: 'owned',
          sha256: sha(text),
          created_file: true,
          agents: ['claude'],
          txn: 'txn-20261115T000000Z-000001',
        },
      ],
    });
  const portsFor = (w: Awaited<ReturnType<typeof newWorld>>) =>
    makeAnalysisReadPorts({
      home: w.home,
      rsiDir: w.dir,
      classify: async () => 'P',
      readState: async () => null,
    });

  it('没有登记表 = clean;内容与登记一致 = clean(对照);被改过 = drifted;条目文件已不在 = clean(不算漂移)', async () => {
    const w = await newWorld('asm-a-drift-');
    expect(await portsFor(w).payloadDrift()).toBe('clean');
    await w.put(SKILL_PATH, 'original\n');
    await w.put('.local/state/agent-kit/sync/ledger.json', ledger('original\n'));
    expect(await portsFor(w).payloadDrift()).toBe('clean');
    await w.put(SKILL_PATH, 'edited by user\n');
    expect(await portsFor(w).payloadDrift()).toBe('drifted');
    await safe.remove(w.io, path.join(w.home, SKILL_PATH));
    expect(await portsFor(w).payloadDrift()).toBe('clean');
  });

  it('登记表不合规、条目路径是符号链接 → 抛错(unavailable),绝不落成 clean', async () => {
    const w = await newWorld('asm-a-drift-bad-');
    await w.put('.local/state/agent-kit/sync/ledger.json', '{"x":1}');
    await expect(portsFor(w).payloadDrift()).rejects.toThrow();

    const l = await newWorld('asm-a-drift-link-');
    await l.put('elsewhere.md', 'original\n');
    await l.put('.local/state/agent-kit/sync/ledger.json', ledger('original\n'));
    await safe.mkdirp(l.io, path.join(l.home, '.claude/skills/commit-checklist'), 0o755);
    await safe.symlink(l.io, path.join(l.home, 'elsewhere.md'), path.join(l.home, SKILL_PATH));
    await expect(portsFor(l).payloadDrift()).rejects.toThrow();
  });
});
