/**
 * R20-A4:`rsi digest --agent <a> --json | --revoke`(docs/contracts.md R20-16.5 ~ R20-16.13;夹具矩阵 R20-16.22 / 16.23 / 16.24 / 16.25 的 digest 部分)。
 * 世界见 `a4-fixture.ts`:cur(当前会话项目)/ other(另一采集中项目)/ ex(被排除)。真实 `[rsi]` 配置、真实锁、真实快照清单、假 HOME。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RSI_DIGEST_MAX_BYTES,
  RSI_EXCERPT_MARK_CLOSE,
  RSI_EXCERPT_MARK_OPEN,
} from '../../src/contracts/rsi.js';
import { exists, readDir, readText } from '../../src/io/read-fs.js';
import { mkdirp, remove, rename, symlink, writeFile } from '../../src/io/safe-fs.js';
import { renderDigest, selectClusters, parseDigestArgs } from '../../src/rsi/digest.js';
import { readSlot, reserveSlot, withDigestsLock } from '../../src/rsi/digest-slots.js';
import { SALT, put, makeRoot } from './services-fixture.js';
import {
  DIGEST_ARGS,
  L_FILES,
  L_TEST,
  assertNoRealHomeWrites,
  digestCmd,
  fakeKey,
  lesson,
  makeA4World,
  parseDigest,
  recommit,
  retry,
  writeSignalFile,
  rewriteCfg,
  SESSION_OK,
  type A4World,
} from './a4-fixture.js';
import { sig } from '../fixtures/reflect/world.js';
import { loadRsiConfig } from '../../src/rsi/config.js';
import { projectKeyFor } from '../../src/signals/ids.js';
import { canonical } from '../../src/signals/exclude.js';

const digestsDir = (w: A4World): string => path.join(w.s.rsi, 'digests');
const slotFiles = async (w: A4World): Promise<string[]> => {
  try {
    return (await readDir(digestsDir(w)))
      .map((e) => e.name)
      .filter((n) => /^s\d\d\.json$/.test(n))
      .sort();
  } catch {
    return [];
  }
};
const noWrites = (w: A4World): void => expect(w.s.audit).toEqual([]);
const STOP_DOC = '{"at":"2026-10-26T00:00:00.000Z","by":"user"}';
const cleanRedactor = { pass2: () => ({ clean: true }) } as never;

describe('R20-16.5 参数(严格)', () => {
  it('解析:合法形状;--scope / 未知 / 重复 / 位置参数 → unknown_arg;缺必填、非法 agent、--revoke 混用', () => {
    expect(parseDigestArgs(['--agent', 'claude', '--json'])).toEqual({
      ok: true,
      revoke: false,
      agent: 'claude',
    });
    expect(parseDigestArgs(['--json', '--agent', 'pi'])).toEqual({
      ok: true,
      revoke: false,
      agent: 'pi',
    });
    expect(parseDigestArgs(['--revoke'])).toEqual({ ok: true, revoke: true });
    const bad = (a: string[]): unknown => (parseDigestArgs(a) as { reason?: string }).reason;
    expect(bad(['--agent', 'claude', '--json', '--scope', 'all'])).toBe('unknown_arg');
    expect(bad(['--scope=all', '--agent', 'claude', '--json'])).toBe('unknown_arg');
    expect(bad(['--agent', 'claude', '--agent', 'pi', '--json'])).toBe('unknown_arg');
    expect(bad(['--json', '--json', '--agent', 'claude'])).toBe('unknown_arg');
    expect(bad(['claude'])).toBe('unknown_arg');
    expect(bad(['--json'])).toBe('missing:--agent');
    expect(bad(['--agent'])).toBe('missing:--agent');
    expect(bad(['--agent', '--json'])).toBe('missing:--agent');
    expect(bad(['--agent', 'kimi', '--json'])).toBe('bad_agent');
    expect(bad(['--agent', 'claude'])).toBe('missing:--json');
    expect(bad(['--revoke', '--json'])).toBe('mode_conflict');
    expect(bad(['--revoke', '--agent', 'claude'])).toBe('mode_conflict');
  });

  it('命令级:--scope → 退出 2 RSI_USAGE;零写入、stdout 空', async () => {
    const w = await makeA4World('a4-dg-scope-');
    w.s.audit.length = 0;
    const r = await digestCmd(w, [...DIGEST_ARGS(), '--scope', 'all']);
    expect([r.code, r.err, r.out]).toEqual([2, 'RSI_USAGE reason=unknown_arg\n', '']);
    noWrites(w);
  });
});

describe('前置条件(每种都是精确码 + 零写入)', () => {
  it('配置 off(没有 [rsi])→ 4 RSI_NOT_RUN reason=off', async () => {
    const w = await makeA4World('a4-dg-off-');
    await put(w.s, w.s.f.cfgFile, '# no rsi\n', 0o600);
    w.s.audit.length = 0;
    const r = await digestCmd(w, DIGEST_ARGS());
    expect([r.code, r.err, r.out]).toEqual([4, 'RSI_NOT_RUN reason=off\n', '']);
    noWrites(w);
  });
  it('armed(未确认)→ 4 not_confirmed;stopped(STOP 在场)→ 4 stopped', async () => {
    const a = await makeA4World('a4-dg-armed-', { armed: true });
    a.s.audit.length = 0;
    expect((await digestCmd(a, DIGEST_ARGS())).err).toBe('RSI_NOT_RUN reason=not_confirmed\n');
    noWrites(a);
    const s = await makeA4World('a4-dg-stop-');
    await put(s.s, path.join(s.s.rsi, 'STOP'), STOP_DOC);
    s.s.audit.length = 0;
    const r = await digestCmd(s, DIGEST_ARGS());
    expect([r.code, r.err]).toEqual([4, 'RSI_NOT_RUN reason=stopped\n']);
    noWrites(s);
  });
  it('purge journal 在 → 4 purge_pending(授权 ok 的前提下)', async () => {
    const w = await makeA4World('a4-dg-journal-');
    await put(w.s, path.join(w.s.rsi, 'purge-journal.json'), '{}');
    w.s.audit.length = 0;
    const r = await digestCmd(w, DIGEST_ARGS());
    expect([r.code, r.err, r.out]).toEqual([4, 'RSI_NOT_RUN reason=purge_pending\n', '']);
    noWrites(w);
  });
  const denied: [string, string | null, string][] = [
    ['缺表', null, 'off'],
    [
      'enabled=false',
      '[rsi.session]\nenabled = false\nagents = ["claude"]\nexpires = "2026-12-31"\n',
      'off',
    ],
    ['schema 错', '[rsi.session]\nenabled = true\nagents = ["claude"]\nexpires = "x"\n', 'invalid'],
    [
      '已过期',
      '[rsi.session]\nenabled = true\nagents = ["claude"]\nexpires = "2026-10-26"\n',
      'expired',
    ],
    [
      '超过 90 天',
      '[rsi.session]\nenabled = true\nagents = ["claude"]\nexpires = "2027-01-25"\n',
      'expired',
    ],
    [
      'agent 未授权',
      '[rsi.session]\nenabled = true\nagents = ["codex"]\nexpires = "2026-12-31"\n',
      'agent_not_authorized',
    ],
  ];
  for (const [name, session, reason] of denied) {
    it(`会话授权 ${name} → 4 RSI_SESSION_DENIED reason=${reason};零写入,stdout 空`, async () => {
      const w = await makeA4World('a4-dg-deny-', { session });
      w.s.audit.length = 0;
      const r = await digestCmd(w, DIGEST_ARGS());
      expect([r.code, r.err, r.out]).toEqual([4, `RSI_SESSION_DENIED reason=${reason}\n`, '']);
      noWrites(w);
    });
  }
  it('正向对照:合法授权 + confirmed → 0', async () => {
    const w = await makeA4World('a4-dg-ok0-');
    expect((await digestCmd(w, DIGEST_ARGS())).code).toBe(0);
  });
});

describe('输出(R20-16.6 ~ R20-16.9)', () => {
  it('当前项目给摘录(原样、包在不可信标记里),其它采集中项目只给计数;别名 e1… 整份唯一;不含路径 / 项目 key / sig_id', async () => {
    const w = await makeA4World('a4-dg-out-');
    const r = await digestCmd(w, DIGEST_ARGS());
    expect([r.code, r.err]).toEqual([0, '']);
    const d = parseDigest(r.out);
    expect(Object.keys(d).sort()).toEqual([
      'agent',
      'clusters',
      'digest_id',
      'expires_at',
      'reason',
      'truncated',
    ]);
    expect(d.reason).toBe('ok');
    expect(d.agent).toBe('claude');
    expect(d.digest_id).toMatch(/^d_[0-9a-f]{16}$/);
    expect(d.expires_at).toBe('2026-10-27T12:00:00.000Z');
    expect(d.truncated).toEqual({ clusters_dropped: 0 });
    expect(d.clusters.map((c) => [c.alias, c.kind, c.evidence.length, c.other_evidence])).toEqual([
      ['c1', 'explicit_lesson', 3, 2], // cur 3 条摘录;other 的 2 条只是计数
      ['c2', 'explicit_lesson', 2, 0],
    ]);
    expect(d.clusters.flatMap((c) => c.evidence.map((e) => e.alias))).toEqual([
      'e1',
      'e2',
      'e3',
      'e4',
      'e5',
    ]);
    for (const c of d.clusters) {
      for (const e of c.evidence) {
        expect(e.excerpt.startsWith(RSI_EXCERPT_MARK_OPEN)).toBe(true);
        expect(e.excerpt.endsWith(RSI_EXCERPT_MARK_CLOSE)).toBe(true);
      }
    }
    expect(d.clusters[0]?.evidence[0]?.excerpt).toBe(
      `${RSI_EXCERPT_MARK_OPEN}${L_TEST}${RSI_EXCERPT_MARK_CLOSE}`,
    );
    expect(d.clusters[1]?.evidence[0]?.excerpt).toContain(L_FILES);
    for (const bad of [
      w.keys.cur,
      w.keys.other,
      w.keys.ex,
      'sig_',
      w.roots.cur,
      w.s.f.dir,
      w.s.f.home,
      'legacy deploy',
    ]) {
      expect(r.out.includes(bad), bad).toBe(false);
    }
    assertNoRealHomeWrites(w);
  });

  it('digest 文件:槽位 s00.json(0600),记录含别名 → sig_id、策略指纹、快照代次;读取走 readFileSafe', async () => {
    const w = await makeA4World('a4-dg-file-');
    const d = parseDigest((await digestCmd(w, DIGEST_ARGS())).out);
    expect(await slotFiles(w)).toEqual(['s00.json']);
    const c = await readSlot(digestsDir(w), 0);
    expect(c.kind).toBe('digest');
    if (c.kind !== 'digest') return;
    expect(c.record.digest_id).toBe(d.digest_id);
    expect(c.record.agent).toBe('claude');
    expect(c.record.project_key).toBe(w.keys.cur);
    expect(Object.keys(c.record.aliases)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
    expect(c.record.session_policy_fp).toMatch(/^[0-9a-f]{64}$/);
    expect(c.record.snapshot_generation).toBeGreaterThanOrEqual(1);
    expect(c.record.expires_at).toBe(d.expires_at);
    // 第二次再发 → 下一个槽位,id 不同
    const d2 = parseDigest((await digestCmd(w, DIGEST_ARGS())).out);
    expect(d2.digest_id).not.toBe(d.digest_id);
    expect(await slotFiles(w)).toEqual(['s00.json', 's01.json']);
  });

  it('cwd 解析不出 / 被排除 / 归属不明 → 空 clusters(摘录 0),reason 如实,仍写 digest 记录', async () => {
    const w = await makeA4World('a4-dg-noproj-');
    const unknown = await makeRoot(w.s, 'unknown'); // 不在索引里
    const cases: [string | undefined, string][] = [
      ['relative/dir', 'no_project'],
      [w.roots.ex, 'project_excluded'],
      [unknown, 'attribution_unknown'],
    ];
    let n = 0;
    for (const [cwd, reason] of cases) {
      const r = await digestCmd(w, DIGEST_ARGS(), { cwd });
      expect(r.code, reason).toBe(0);
      const d = parseDigest(r.out);
      expect([d.reason, d.clusters]).toEqual([reason, []]);
      expect(r.out.includes('legacy deploy')).toBe(false);
      expect(await slotFiles(w)).toHaveLength(++n);
      const c = await readSlot(digestsDir(w), n - 1);
      expect(c.kind === 'digest' && Object.keys(c.record.aliases)).toEqual([]);
    }
  });

  it('没有可给的簇 → 空 clusters + reason=no_clusters', async () => {
    const w = await makeA4World('a4-dg-noclusters-', { noSignals: true });
    const d = parseDigest((await digestCmd(w, DIGEST_ARGS())).out);
    expect([d.reason, d.clusters]).toEqual(['no_clusters', []]);
  });

  it('N3:只有其它项目有证据的簇不入选,其文本不出现在 digest 里', async () => {
    const w = await makeA4World('a4-dg-n3-', {
      extraSignals: ({ keys }) => [
        lesson(keys.other, 'o9', 0, 'from now on prefer ripgrep over grep in every shell script'),
        lesson(keys.other, 'o8', 0, 'from now on prefer ripgrep over grep in every shell script'),
      ],
    });
    const r = await digestCmd(w, DIGEST_ARGS());
    expect(r.out.includes('ripgrep')).toBe(false);
    expect(parseDigest(r.out).clusters).toHaveLength(2);
  });
});

describe('R20-16.7 / 16.23:先剔除 X / U,再聚类(X / U 不影响任何簇的入选、排序与 other_evidence)', () => {
  it('仅靠 X 或 U 证据才过门槛的簇不入选;正向对照:换成采集中的 other 项目,簇入选且 other_evidence 计 1', async () => {
    const unknownKey = 'p_9999999999999999'; // 不在索引里 → U
    const w = await makeA4World('a4-dg-xu-', {
      extraSignals: ({ keys }) => [
        ...retry(keys.cur, 'rc1', 'pnpm --filter pkg test'),
        ...retry(keys.ex, 'rx1', 'pnpm --filter pkg test'), // X
        ...retry(unknownKey, 'ru1', 'pnpm --filter pkg test'), // U
      ],
    });
    const d = parseDigest((await digestCmd(w, DIGEST_ARGS())).out);
    expect(d.clusters.map((c) => c.kind)).toEqual(['explicit_lesson', 'explicit_lesson']);
    expect(d.clusters.map((c) => c.other_evidence)).toEqual([2, 0]); // X / U 也没有混进 other_evidence

    const ctl = await makeA4World('a4-dg-xu-ctl-', {
      extraSignals: ({ keys }) => [
        ...retry(keys.cur, 'rc1', 'pnpm --filter pkg test'),
        ...retry(keys.other, 'ro1', 'pnpm --filter pkg test'), // 采集中
      ],
    });
    const dc = parseDigest((await digestCmd(ctl, DIGEST_ARGS())).out);
    const rc = dc.clusters.find((c) => c.kind === 'tool_fail_retry');
    expect(rc?.evidence).toHaveLength(1);
    expect(rc?.other_evidence).toBe(1);
  });
});

describe('R20-16.8 取舍与截断(纯函数)', () => {
  const mk = (key: string, n: number, text: string, sess: string) =>
    Array.from({ length: n }, (_, i) => lesson(key, `${sess}${i}`, 0, text));
  it('簇按(当前项目证据数降序、簇 id 升序)稳定排序,与输入顺序无关;每簇 ≤ 8 条、最多 5 簇', () => {
    const key = 'p_aaaaaaaaaaaaaaaa';
    const texts = [
      'alpha1 beta1 gamma1 delta1',
      'alpha2 beta2 gamma2 delta2',
      'alpha3 beta3 gamma3 delta3',
      'alpha4 beta4 gamma4 delta4',
      'alpha5 beta5 gamma5 delta5',
      'alpha6 beta6 gamma6 delta6',
    ];
    const sizes = [2, 10, 3, 3, 1, 4];
    const all = texts.flatMap((t, i) => mk(key, sizes[i] as number, `from now on ${t}`, `s${i}x`));
    const a = selectClusters(all, key);
    const b = selectClusters([...all].reverse(), key);
    expect(a.map((c) => c.current.length)).toEqual(b.map((c) => c.current.length));
    expect(a).toHaveLength(5); // 6 个簇只取 5 个
    expect(a.map((c) => c.current.length)).toEqual([8, 4, 3, 3, 2]); // 10 条截到 8;1 条那个被挤掉
    expect(a.map((c) => c.current.map((s) => s.sig_id))).toEqual(
      b.map((c) => c.current.map((s) => s.sig_id)),
    );
  });

  it('整份 > 48KiB 时从末尾整簇丢弃,clusters_dropped 正确,别名连续,输出确定', () => {
    const key = 'p_aaaaaaaaaaaaaaaa';
    const big = (k: number) =>
      Array.from({ length: 8 }, (_, i) => ({
        ...lesson(key, `b${k}${i}`, 0, `from now on ${'x'.repeat(1500)}`),
      }));
    const sel = Array.from({ length: 5 }, (_, k) => ({
      kind: 'explicit_lesson',
      current: big(k),
      other: k,
    }));
    const r = renderDigest({
      digestId: 'd_0123456789abcdef',
      expiresAt: '2026-10-27T00:00:00.000Z',
      agent: 'claude',
      reason: 'ok',
      selected: sel,
    });
    expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(RSI_DIGEST_MAX_BYTES);
    const doc = parseDigest(r.text);
    expect(doc.clusters.length + doc.truncated.clusters_dropped).toBe(5);
    expect(doc.truncated.clusters_dropped).toBeGreaterThanOrEqual(1);
    expect(r.clustersDropped).toBe(doc.truncated.clusters_dropped);
    expect(doc.clusters.map((c) => c.alias)).toEqual(
      sel.slice(0, doc.clusters.length).map((_, i) => `c${i + 1}`),
    );
    expect(Object.keys(r.aliases)).toHaveLength(doc.clusters.length * 8);
    // 保留的是前面的簇(other_evidence 0,1,2… 与输入前缀一致),确定性
    expect(doc.clusters.map((c) => c.other_evidence)).toEqual(
      sel.slice(0, doc.clusters.length).map((c) => c.other),
    );
    expect(
      renderDigest({
        digestId: 'd_0123456789abcdef',
        expiresAt: '2026-10-27T00:00:00.000Z',
        agent: 'claude',
        reason: 'ok',
        selected: sel,
      }).text,
    ).toBe(r.text);
  });
});

describe('R20-16.11 / 16.24 输出复扫', () => {
  it('规则更新后信号库里的种子命中(被选中的摘录)→ digest 整份拒:3 RSI_DIGEST_REJECTED rescan_hit,无 digest 文件、stdout 空', async () => {
    const w = await makeA4World('a4-dg-rescan-', {
      extraSignals: ({ keys }) => [
        lesson(keys.cur, 'k1', 0, `from now on deploy with the key ${fakeKey()} please`),
      ],
    });
    const r = await digestCmd(w, DIGEST_ARGS());
    expect([r.code, r.err, r.out]).toEqual([3, 'RSI_DIGEST_REJECTED reason=rescan_hit\n', '']);
    expect(await slotFiles(w)).toEqual([]); // 预留已放弃
    // 正向对照:没有种子时同一世界成功
    const ok = await makeA4World('a4-dg-rescan-ok-');
    expect((await digestCmd(ok, DIGEST_ARGS())).code).toBe(0);
  });

  it('植入 HOME 路径 → output_leak(退出 3,无文件、无输出)', async () => {
    const w = await makeA4World('a4-dg-leak-');
    // 复扫器放行,只测路径泄漏闸:往信号里植入假 HOME 路径
    await writeSignalFile(w, [
      lesson(w.keys.cur, 'h1', 0, `from now on look under ${w.s.f.home}/notes first`),
    ]);
    await recommit(w);
    const r = await digestCmd(w, DIGEST_ARGS(), { redactor: cleanRedactor });
    expect([r.code, r.err, r.out]).toEqual([3, 'RSI_DIGEST_REJECTED reason=output_leak\n', '']);
    expect(await slotFiles(w)).toEqual([]);
  });
});

describe('R20-16.10 槽位与锁(命令级)', () => {
  it('20 个槽位都被(新鲜的)预留占着 → 4 digest_backlog', async () => {
    const w = await makeA4World('a4-dg-backlog-');
    await withDigestsLock(w.s.io, async (lock) => {
      for (let i = 0; i < 20; i++) await reserveSlot(w.s.io, lock, new Date(w.s.clock.t));
    });
    w.s.audit.length = 0;
    const r = await digestCmd(w, DIGEST_ARGS());
    expect([r.code, r.err, r.out]).toEqual([4, 'RSI_NOT_RUN reason=digest_backlog\n', '']);
  });
  it('槽位锁被别的进程占着 → 4 locked(注入时钟,不真等 2 秒)', async () => {
    const w = await makeA4World('a4-dg-locked-');
    await mkdirp(w.s.f.fx, digestsDir(w), 0o700);
    const doc = {
      pid: process.ppid,
      started_at: new Date().toISOString(),
      nonce: 'f'.repeat(16),
      kit_version: '0.0.0',
    };
    await writeFile(w.s.f.fx, path.join(digestsDir(w), 'lock'), JSON.stringify(doc), {
      mode: 0o600,
    });
    let t = 0;
    const r = await digestCmd(w, DIGEST_ARGS(), {
      slots: { clockMs: () => t, sleep: async (ms) => void (t += ms) },
    });
    expect([r.code, r.err, r.out]).toEqual([4, 'RSI_NOT_RUN reason=locked\n', '']);
  });
  it('快照清单与文件不一致(写入方正在提交,重读一次仍不一致)→ 4 RSI_SNAPSHOT_BUSY;预留已放弃', async () => {
    const w = await makeA4World('a4-dg-busy-');
    await put(w.s, path.join(w.s.rsi, 'counts.json'), '{"changed":true}', 0o600);
    const r = await digestCmd(w, DIGEST_ARGS());
    expect([r.code, r.err, r.out]).toEqual([4, 'RSI_SNAPSHOT_BUSY\n', '']);
    expect(await slotFiles(w)).toEqual([]);
  });
  it('digest 不拿 rsi/lock:rsi/lock 被占着也能发(R20-16.6)', async () => {
    const w = await makeA4World('a4-dg-nolock-');
    const doc = {
      pid: process.ppid,
      started_at: new Date().toISOString(),
      nonce: 'f'.repeat(16),
      kit_version: '0.0.0',
    };
    await writeFile(w.s.f.fx, path.join(w.s.rsi, 'lock'), JSON.stringify(doc), { mode: 0o600 });
    expect((await digestCmd(w, DIGEST_ARGS())).code).toBe(0);
  });
});

describe('R20-16.12 --revoke', () => {
  it('删除全部槽位文件(含预留);不需要 TTY、不看授权状态、不拿 rsi/lock(被占着也能撤销);退出 0', async () => {
    const w = await makeA4World('a4-dg-revoke-');
    await digestCmd(w, DIGEST_ARGS());
    await digestCmd(w, DIGEST_ARGS());
    await withDigestsLock(w.s.io, (lock) => reserveSlot(w.s.io, lock, new Date(w.s.clock.t)));
    expect(await slotFiles(w)).toHaveLength(3);
    // 授权关掉 + rsi/lock 被占
    await rewriteCfg(w, { session: null });
    const doc = {
      pid: process.ppid,
      started_at: new Date().toISOString(),
      nonce: 'f'.repeat(16),
      kit_version: '0.0.0',
    };
    await writeFile(w.s.f.fx, path.join(w.s.rsi, 'lock'), JSON.stringify(doc), { mode: 0o600 });
    const r = await digestCmd(w, ['--revoke']);
    expect([r.code, r.err, r.out]).toEqual([0, '', '']);
    expect(await slotFiles(w)).toEqual([]);
    assertNoRealHomeWrites(w);
  });
  it('没有 digests/ 目录:退出 0、零写入;配置 off:4 off', async () => {
    const w = await makeA4World('a4-dg-revoke-none-');
    w.s.audit.length = 0;
    expect((await digestCmd(w, ['--revoke'])).code).toBe(0);
    noWrites(w);
    await put(w.s, w.s.f.cfgFile, '# off\n', 0o600);
    const r = await digestCmd(w, ['--revoke']);
    expect([r.code, r.err]).toEqual([4, 'RSI_NOT_RUN reason=off\n']);
  });
  it('观察性作废:授权被关掉后再调 digest,旧 digest 被(尽力)删除', async () => {
    const w = await makeA4World('a4-dg-obs-');
    await digestCmd(w, DIGEST_ARGS());
    expect(await slotFiles(w)).toEqual(['s00.json']);
    await rewriteCfg(w, { session: null });
    const r = await digestCmd(w, DIGEST_ARGS());
    expect(r.err).toBe('RSI_SESSION_DENIED reason=off\n');
    expect(await slotFiles(w)).toEqual([]);
  });
  it('观察性作废:授权的 agents 变了(策略指纹不同),下一次 digest 先作废旧 digest', async () => {
    const w = await makeA4World('a4-dg-obs-fp-');
    await digestCmd(w, DIGEST_ARGS());
    await rewriteCfg(w, { session: SESSION_OK.replace('2026-12-31', '2026-12-30') });
    await digestCmd(w, DIGEST_ARGS('codex')); // 新 digest(codex)进来之前旧的(指纹旧)被删
    const kinds = await Promise.all([0, 1].map((n) => readSlot(digestsDir(w), n)));
    expect(kinds.filter((k) => k.kind === 'digest')).toHaveLength(1);
    const cur = kinds.find((k) => k.kind === 'digest');
    expect(cur?.kind === 'digest' && cur.record.agent).toBe('codex');
  });
});

describe('R20-16.11 ② / 16.25 最终复核:输出前的六种变化 → policy_changed,无输出、无 digest 文件', () => {
  type Mut = (w: A4World) => Promise<void>;
  const muts: [string, Mut][] = [
    ['撤销授权', async (w) => rewriteCfg(w, { session: null })],
    ['新增排除(当前项目)', async (w) => rewriteCfg(w, { exclude: [w.roots.ex, w.roots.cur] })],
    ['rsi stop', async (w) => put(w.s, path.join(w.s.rsi, 'STOP'), STOP_DOC)],
    [
      'purge 开始(journal 出现)',
      async (w) => put(w.s, path.join(w.s.rsi, 'purge-journal.json'), '{}'),
    ],
    [
      '项目根目录被删后重建(新 inode)',
      async (w) => {
        const fresh = `${w.roots.cur}-fresh`;
        await mkdirp(w.s.f.fx, fresh, 0o755);
        await rename(w.s.f.fx, w.roots.cur, `${w.roots.cur}-old`);
        await rename(w.s.f.fx, fresh, w.roots.cur);
      },
    ],
    [
      '项目根换成符号链接',
      async (w) => {
        await rename(w.s.f.fx, w.roots.cur, `${w.roots.cur}-old`);
        await symlink(w.s.f.fx, `${w.roots.cur}-old`, w.roots.cur);
      },
    ],
  ];
  for (const point of ['digest:after_read', 'digest:before_final']) {
    for (const [name, mut] of muts) {
      it(`${point} 之后:${name}`, async () => {
        const w = await makeA4World('a4-dg-race-');
        let fired = false;
        const r = await digestCmd(w, DIGEST_ARGS(), {
          hooks: {
            point: async (n) => {
              if (n === point && !fired) {
                fired = true;
                await mut(w);
              }
            },
          },
        });
        expect(fired).toBe(true);
        expect([r.code, r.err, r.out]).toEqual([4, 'RSI_NOT_RUN reason=policy_changed\n', '']);
        expect(await slotFiles(w)).toEqual([]);
        // 正向对照:不变化时同一流程成功
        const ok = await makeA4World('a4-dg-race-ok-');
        expect(
          (await digestCmd(ok, DIGEST_ARGS(), { hooks: { point: () => undefined } })).code,
        ).toBe(0);
      });
    }
  }
  it('发布时发现自己的预留被回收(被 --revoke 删了)→ 4 policy_changed,不碰槽位、无输出', async () => {
    const w = await makeA4World('a4-dg-revoked-mid-');
    const r = await digestCmd(w, DIGEST_ARGS(), {
      hooks: {
        point: async (n) => {
          if (n === 'digest:before_publish') {
            await withDigestsLock(w.s.io, async () =>
              remove(w.s.f.fx, path.join(digestsDir(w), 's00.json')),
            );
          }
        },
      },
    });
    expect([r.code, r.err, r.out]).toEqual([4, 'RSI_NOT_RUN reason=policy_changed\n', '']);
  });
  it('发布(写 digest 文件)失败 → 3 RSI_FAIL_CLOSED reason=internal,不输出', async () => {
    const w = await makeA4World('a4-dg-writefail-');
    const r = await digestCmd(w, DIGEST_ARGS(), {
      slots: {
        hooks: {
          point: (n) => {
            if (n === 'publish:rename') throw new Error('disk full');
          },
        },
      },
    });
    expect([r.code, r.err, r.out]).toEqual([3, 'RSI_FAIL_CLOSED reason=internal\n', '']);
  });
});

describe('杂项', () => {
  it('同一世界读取 digests 文件不会跟随换成链接的槽位(安全读取)', async () => {
    const w = await makeA4World('a4-dg-safe-');
    await digestCmd(w, DIGEST_ARGS());
    expect(await exists(path.join(digestsDir(w), 's00.json'))).toBe(true);
    expect(await readText(path.join(digestsDir(w), 's00.json'))).toContain('digest_id');
  });
  it('辅助:世界的 key 与盐一致(夹具自检)', async () => {
    const w = await makeA4World('a4-dg-fx-');
    expect(w.keys.cur).toBe(projectKeyFor(SALT, await canonical(w.roots.cur)));
    expect((await loadRsiConfig({ home: w.s.f.home })).status).toBe('on');
    expect(sig({ project: 'x', session: 's', index: 0, text: 't' }).sig_id).toMatch(/^sig_/);
  });
});
