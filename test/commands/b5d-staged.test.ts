/**
 * R20-A2 B5d:reflect `--run-llm` / judge `--run-llm` 的锁内 recoverUnderLock + resumeTaint,以及写完暂存区后同锁更新 `counts.staged`(方案 §8)。
 * gc `--write` 不调 resumeTaint。全部假 HOME / 临时仓库;`[rsi]` 配置经 `rsiConfig` 注入(不读真实 HOME 的配置)。
 * 每条负向断言旁边都有正向对照。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createJudgeCommand } from '../../src/commands/judge.js';
import type { JudgeCommandDeps } from '../../src/commands/judge.js';
import { createReflectCommand } from '../../src/commands/reflect.js';
import { settleStaged } from '../../src/commands/rsi-staged-wiring.js';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import type { RsiCounts } from '../../src/contracts/rsi.js';
import { canonicalJson } from '../../src/io/canonical-json.js';
import { createIoContext } from '../../src/io/paths.js';
import type { IoContext } from '../../src/io/paths.js';
import { exists, readDir, readText } from '../../src/io/read-fs.js';
import { chmod, mkdirp, writeFile } from '../../src/io/safe-fs.js';
import { acquireRsiLock } from '../../src/rsi/lock.js';
import type { ServiceHooks } from '../../src/rsi/services/staging.js';
import { inspectSnapshot } from '../../src/rsi/snapshot.js';
import { productionSnapshotValidator } from '../../src/rsi/validators.js';
import type { RsiServiceCtx } from '../../src/rsi/types.js';
import { REPO_ROOT, wideCtx } from '../helpers/tmp.js';
import {
  StubBackend,
  lintDraft,
  okText,
  out as outJson,
  testRedactor,
} from '../fixtures/reflect/world.js';
import { RUN_ID, cmdCtx, makeStubs, newWork, redactor, writeProposal } from '../judge/helpers.js';
import type { Work } from '../judge/helpers.js';
import { EXCERPT_MARK, SALT, SALT_FP, countsDoc } from '../rsi/services-fixture.js';
import { treeOf } from '../rsi/rsi-fixture.js';
import { EGRESS_OVERLAY, ctxFor, newR5World } from './r5-world.js';
import type { R5World } from './r5-world.js';
import { aliasRsiState, lockFileOf, onConfig } from './rsi-lock-world.js';

const CLOCK = (): Date => new Date('2026-10-12T08:00:00Z');
const J_LIVE = ['--run', RUN_ID, '--run-llm', '--allow-egress'];
const R_LIVE = ['--run-llm', '--allow-egress', '--owner', '@tester'];

type SaltMode = 'ok' | 'absent' | 'wide';
type CountsMode = 'ok' | 'missing' | 'mismatch' | 'corrupt';

interface Seed {
  salt?: SaltMode;
  counts?: CountsMode;
  /** counts 的 per_key / unknown(证明「只写 staged」时其余段原样) */
  perKey?: boolean;
}

const putFile = async (fx: IoContext, abs: string, text: string, mode = 0o600): Promise<void> => {
  await mkdirp(fx, path.dirname(abs), 0o700);
  await writeFile(fx, abs, text, { mode });
  await chmod(fx, abs, mode);
};

const PER_KEY = { p_aaaaaaaaaaaaaaaa: { signals_total: 7, sessions: 2, signals_by_day: {} } };

async function seed(fx: IoContext, state: string, o: Seed): Promise<void> {
  const rsi = path.join(state, 'rsi');
  if ((o.salt ?? 'ok') !== 'absent') {
    await putFile(fx, path.join(state, 'salt'), SALT, o.salt === 'wide' ? 0o644 : 0o600);
  }
  const mode = o.counts ?? 'missing';
  if (mode === 'missing') return;
  await mkdirp(fx, rsi, 0o700);
  await chmod(fx, rsi, 0o700);
  if (mode === 'corrupt') return putFile(fx, path.join(rsi, 'counts.json'), '{"nope":1}');
  const extra = o.perKey === true ? { per_key: PER_KEY, unknown_keys_signals: 3 } : {};
  const doc = countsDoc(mode === 'mismatch' ? 'ffffffffffff' : SALT_FP, extra);
  await putFile(fx, path.join(rsi, 'counts.json'), canonicalJson(doc));
}

const countsOf = async (state: string): Promise<RsiCounts> =>
  JSON.parse(await readText(path.join(state, 'rsi', 'counts.json'))) as RsiCounts;

/** 一个已有 TAINTED、但摘录还没清的暂存 run(resumeTaint 会真的写) */
async function addTaintedRun(fx: IoContext, state: string, id = 'run-tainted'): Promise<string> {
  const dir = path.join(state, 'reflect', id);
  const prop = path.join(dir, 'proposals', '2026-10-12-009.yaml');
  await putFile(
    fx,
    prop,
    `id: 2026-10-12-009\nevidence:\n  - sig: sig_0123456789abcdef\n    project_key: p_fedcba9876543210\n    excerpt: ${EXCERPT_MARK}\n`,
  );
  await putFile(fx, path.join(dir, 'report.json'), `{"run_id":"${id}"}`);
  await putFile(
    fx,
    path.join(dir, 'TAINTED'),
    '{"at":"2026-10-26T00:00:00.000Z","reason":"purge"}',
  );
  return prop;
}

/** 第 k 个服务层写点(`before:<op>`)之前:失锁(换 nonce)或崩溃;`k = Infinity` 只计数 */
function inject(
  fx: IoContext,
  lock: string,
  audit: string[],
  k: number,
  mode: 'lose' | 'crash',
): {
  hooks: ServiceHooks;
  calls: () => number;
  at: () => { name: string; audit: number } | undefined;
} {
  let n = 0;
  let hit: { name: string; audit: number } | undefined;
  return {
    hooks: {
      point: async (name: string): Promise<void> => {
        if (!name.startsWith('before:')) return;
        n++;
        if (n !== k || hit !== undefined) return;
        hit = { name, audit: audit.length };
        if (mode === 'crash') throw new Error('injected crash');
        await writeFile(
          fx,
          lock,
          JSON.stringify({
            pid: 1,
            started_at: '2026-10-26T00:00:00.000Z',
            nonce: 'f'.repeat(16),
            kit_version: '0.1.0',
          }),
          { mode: 0o600 },
        );
      },
    },
    calls: () => n,
    at: () => hit,
  };
}

// ---------------------------------------------------------------------------
// judge
// ---------------------------------------------------------------------------
interface JW {
  w: Work;
  fx: IoContext;
  audit: string[];
  cmd: ReturnType<typeof createJudgeCommand>;
  factory: { n: number };
  lock: string;
}

async function jworld(
  o: Seed & { deps?: Partial<JudgeCommandDeps>; excludeAll?: boolean; taintedRun?: boolean } = {},
): Promise<JW> {
  const w0 = await newWork('b5d-j-');
  const audit: string[] = [];
  const io = createIoContext({
    cwd: REPO_ROOT,
    root: w0.repo,
    env: { KIT_TMP: w0.dir, KIT_STATE_DIR: w0.state, PATH: '/usr/bin:/bin' },
    writeAudit: (op, p) => void audit.push(`${op} ${p}`),
  });
  const w: Work = { ...w0, io };
  await writeProposal(w);
  await aliasRsiState(io, w.dir);
  const fx = wideCtx(w.dir);
  await seed(fx, w.state, o);
  const s = makeStubs();
  const factory = { n: 0 };
  const cmd = createJudgeCommand({
    createBackends: async () => {
      factory.n++;
      return s.backends;
    },
    redactor,
    requireOverlayEgress: false,
    rsiConfig: async () =>
      o.excludeAll === true ? { ...onConfig(w.dir), excludeDirs: [w.dir] } : onConfig(w.dir),
    ...(o.deps ?? {}),
  });
  if (o.taintedRun === true) await addTaintedRun(fx, w.state);
  audit.length = 0;
  return { w, fx, audit, cmd, factory, lock: lockFileOf(w.state) };
}

async function runJ(j: JW): Promise<{ code: number; out: string; err: string }> {
  const { ctx, out, err } = cmdCtx(j.w, J_LIVE);
  const code = await j.cmd.run(ctx);
  return { code, out: out.join(''), err: err.join('') };
}

const proposalOf = (w: Work): string => path.join(w.runDir, 'proposals', '2026-10-12-001.yaml');

describe('judge --run-llm × counts.staged(B5d)', () => {
  it('counts 在且盐相符:只写 staged(其余段原样),generation 推进,清单自洽;条目是 {run_id, proposals, tainted:false}', async () => {
    const j = await jworld({ counts: 'ok', perKey: true });
    const r = await runJ(j);
    expect(r.code, r.err).toBe(ExitCode.OK);
    expect(await readText(proposalOf(j.w))).toContain('judge:'); // 正向前提:评审真的写了
    const c = await countsOf(j.w.state);
    expect(c.generation).toBe(2);
    expect(c.per_key).toEqual(PER_KEY);
    expect(c.unknown_keys_signals).toBe(3);
    expect(c.staged).toHaveLength(1);
    expect(c.staged[0]).toMatchObject({ run_id: RUN_ID, proposals: 1, tainted: false });
    expect(await inspectSnapshot(j.w.io, productionSnapshotValidator)).toBe('consistent');
    expect(await exists(path.join(j.w.state, 'rsi', 'log.jsonl'))).toBe(false); // Q-L:不带日志行
    expect(await exists(j.lock)).toBe(false);
  });

  it('counts 缺失 / 盐不符:写四段(全量重建),staged 含本 run;盐缺失:不写 counts、不提交清单,judge 本身照常', async () => {
    for (const counts of ['missing', 'mismatch'] as const) {
      const j = await jworld({ counts });
      const r = await runJ(j);
      expect(r.code, `${counts}:${r.err}`).toBe(ExitCode.OK);
      const c = await countsOf(j.w.state);
      expect(c.salt_fp, counts).toBe(SALT_FP);
      expect(
        c.staged.map((e) => e.run_id),
        counts,
      ).toEqual([RUN_ID]);
      expect(await inspectSnapshot(j.w.io, productionSnapshotValidator)).toBe('consistent');
    }
    const j = await jworld({ salt: 'absent', counts: 'missing' });
    const r = await runJ(j);
    expect(r.code, r.err).toBe(ExitCode.OK);
    expect(await readText(proposalOf(j.w))).toContain('judge:');
    expect(await exists(path.join(j.w.state, 'rsi', 'counts.json'))).toBe(false);
    expect(await exists(path.join(j.w.state, 'rsi', 'snapshot.json'))).toBe(false);
  });

  it('staged 只写 TAINTED 文件事实:证据属被排除项目、但没有 TAINTED 文件 → tainted=false(不掺「证据属 X」的推导);有 TAINTED 文件 → true', async () => {
    const j = await jworld({ counts: 'ok', excludeAll: true });
    const r = await runJ(j);
    expect(r.code, r.err).toBe(ExitCode.OK);
    expect((await countsOf(j.w.state)).staged[0]?.tainted).toBe(false);
    // 正向对照:同世界放一个 TAINTED 文件,事实为 true(用 service 层直接刷新,免得再跑一次 judge)
    await putFile(
      j.fx,
      path.join(j.w.runDir, 'TAINTED'),
      '{"at":"2026-10-26T00:00:00.000Z","reason":"exclude"}',
    );
    const sctx: RsiServiceCtx = { io: j.w.io, config: onConfig(j.w.dir) };
    const lock = await acquireRsiLock(j.w.io);
    try {
      await settleStaged(sctx, lock, testRedactor(), undefined);
    } finally {
      await lock.release();
    }
    expect((await countsOf(j.w.state)).staged[0]?.tainted).toBe(true);
  });

  it('锁内先 recover(inspect):counts 损坏 → 退 3,后端零调用,提案逐字节不变;正向对照:counts 合规时同一世界会评审并写入', async () => {
    const bad = await jworld({ counts: 'corrupt' });
    const before = await readText(proposalOf(bad.w));
    const r = await runJ(bad);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r.err).toMatch(/^RSI_FAIL_CLOSED reason=\w+\n$/);
    expect(bad.factory.n).toBe(0);
    expect(await readText(proposalOf(bad.w))).toBe(before);
    const ok = await jworld({ counts: 'ok' });
    expect((await runJ(ok)).code).toBe(ExitCode.OK);
    expect(await readText(proposalOf(ok.w))).not.toBe(before);
  });

  it('锁内先 resumeTaint:另一个 run 已有 TAINTED 但摘录没清 → judge 之后被清空(标记保留);正向前提:之前摘录在', async () => {
    const j = await jworld({ counts: 'ok' });
    const other = path.join(j.w.state, 'reflect', 'run-tainted');
    await putFile(
      j.fx,
      path.join(other, 'proposals', '2026-10-12-009.yaml'),
      `id: 2026-10-12-009\nevidence:\n  - sig: sig_0123456789abcdef\n    project_key: p_fedcba9876543210\n    excerpt: ${EXCERPT_MARK}\n`,
    );
    await putFile(j.fx, path.join(other, 'report.json'), '{"run_id":"run-tainted"}');
    await putFile(
      j.fx,
      path.join(other, 'TAINTED'),
      '{"at":"2026-10-26T00:00:00.000Z","reason":"purge"}',
    );
    expect(await readText(path.join(other, 'proposals', '2026-10-12-009.yaml'))).toContain(
      EXCERPT_MARK,
    );
    const r = await runJ(j);
    expect(r.code, r.err).toBe(ExitCode.OK);
    expect(await readText(path.join(other, 'proposals', '2026-10-12-009.yaml'))).not.toContain(
      EXCERPT_MARK,
    );
    expect(await exists(path.join(other, 'TAINTED'))).toBe(true);
  });

  it('purge journal 在场:judge 直接拒绝(purge_incomplete),不补 taint(与 reflect 故意不同,见 reflect 用例)', async () => {
    const j = await jworld({ counts: 'ok' });
    await putFile(
      j.fx,
      path.join(j.w.state, 'rsi', 'purge-journal.json'),
      JSON.stringify({
        schema_version: 1,
        created_at: '2026-10-26T00:00:00.000Z',
        phase: 'planned',
        keys: ['p_aaaaaaaaaaaaaaaa'],
        taint_targets: { runs: [RUN_ID], promotes: [] },
      }),
    );
    const r = await runJ(j);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r.err).toBe('RSI_FAIL_CLOSED reason=purge_incomplete\n');
    expect(await exists(path.join(j.w.runDir, 'TAINTED'))).toBe(false); // judge 不补(reflect 会)
    expect(j.factory.n).toBe(0);
  });

  it('刷新失败(盐权限过宽 → salt_invalid):评审记录已写下不撤销,先打印 partial,退 3 稳定码', async () => {
    const j = await jworld({ counts: 'ok', salt: 'wide' });
    const r = await runJ(j);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r.err).toContain('RSI_FAIL_CLOSED reason=salt_invalid\n');
    expect(r.out).toContain('2026-10-12-001'); // partial()
    expect(await readText(proposalOf(j.w))).toContain('judge:');
  });

  it('干跑不拿锁、不刷新 counts:零写入', async () => {
    const j = await jworld({ counts: 'ok' });
    const before = await treeOf(j.w.state);
    const { ctx } = cmdCtx(j.w, ['--run', RUN_ID]);
    expect(await j.cmd.run(ctx)).toBe(ExitCode.OK);
    expect(j.audit).toEqual([]);
    expect(await treeOf(j.w.state)).toEqual(before);
  });

  it('服务层每个写点之前失锁(k 遍历):退 3 lock_lost,该点之后零写入;写点数 >= 8', async () => {
    const holder0: { inj?: ReturnType<typeof inject> } = {};
    const hooks0: ServiceHooks = { point: async (n) => holder0.inj?.hooks.point?.(n) };
    const probe = await jworld({ counts: 'ok', taintedRun: true, deps: { serviceHooks: hooks0 } });
    holder0.inj = inject(probe.fx, probe.lock, probe.audit, Number.POSITIVE_INFINITY, 'lose');
    expect((await runJ(probe)).code).toBe(ExitCode.OK);
    const total = holder0.inj.calls();
    expect(total).toBeGreaterThanOrEqual(8); // 含 taint 清理写点
    for (let k = 1; k <= total; k++) {
      const holder: { j?: JW; inj?: ReturnType<typeof inject> } = {};
      const hooks: ServiceHooks = {
        point: async (name) => holder.inj?.hooks.point?.(name),
      };
      const j = await jworld({ counts: 'ok', taintedRun: true, deps: { serviceHooks: hooks } });
      holder.j = j;
      holder.inj = inject(j.fx, j.lock, j.audit, k, 'lose');
      const r = await runJ(j);
      const hit = holder.inj.at();
      expect(hit, `k=${k}`).toBeDefined();
      expect(r.code, `k=${k} ${hit?.name}`).toBe(ExitCode.FAIL_CLOSED);
      expect(r.err, `k=${k} ${hit?.name}`).toContain('RSI_FAIL_CLOSED reason=lock_lost\n');
      expect(j.audit.slice(hit?.audit ?? 0), `k=${k} ${hit?.name} 失锁之后零写入`).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// reflect
// ---------------------------------------------------------------------------
interface RW {
  w: R5World;
  fx: IoContext;
  audit: string[];
  cmd: ReturnType<typeof createReflectCommand>;
  lock: string;
  stub: StubBackend;
}

async function rworld(
  o: Seed & { deps?: Record<string, unknown>; taintedRun?: boolean } = {},
): Promise<RW> {
  const w0 = await newR5World({ overlay: EGRESS_OVERLAY });
  const audit: string[] = [];
  const io = createIoContext({
    cwd: REPO_ROOT,
    root: w0.repo.dir,
    env: { KIT_TMP: w0.parent, KIT_STATE_DIR: w0.state, PATH: '/usr/bin:/bin' },
    writeAudit: (op, p) => void audit.push(`${op} ${p}`),
  });
  const w: R5World = { ...w0, io };
  await aliasRsiState(io, w.parent);
  const fx = wideCtx(w.parent);
  await seed(fx, w.state, o);
  const stub = new StubBackend((req) => okText(outJson(lintDraft(req.user))));
  const cmd = createReflectCommand({
    clock: CLOCK,
    randomHex: () => 'abc123',
    redactor: testRedactor(),
    createBackends: async () => ({ glm: stub }),
    rsiConfig: async () => onConfig(w.parent),
    ...(o.deps ?? {}),
  });
  if (o.taintedRun === true) await addTaintedRun(fx, w.state);
  audit.length = 0;
  return { w, fx, audit, cmd, lock: lockFileOf(w.state), stub };
}

async function runR(
  r: RW,
  argv: string[] = R_LIVE,
): Promise<{ code: number; out: string; err: string }> {
  const { ctx, out, err } = ctxFor(r.w, argv);
  const code = await r.cmd.run(ctx);
  return { code, out: out.join(''), err: err.join('') };
}

const runIds = async (w: R5World): Promise<string[]> =>
  (await exists(path.join(w.state, 'reflect')))
    ? (await readDir(path.join(w.state, 'reflect'))).map((e) => e.name).sort()
    : [];

describe('reflect --run-llm × counts.staged(B5d)', () => {
  it('counts 在且盐相符:暂存新 run 后只写 staged(其余段原样),条目与磁盘一致,清单自洽;正向前提:run 目录确实建了', async () => {
    const r = await rworld({ counts: 'ok', perKey: true });
    const res = await runR(r);
    expect(res.code, res.err).toBe(ExitCode.OK);
    const ids = await runIds(r.w);
    expect(ids).toHaveLength(1);
    const c = await countsOf(r.w.state);
    expect(c.per_key).toEqual(PER_KEY);
    expect(c.generation).toBe(2);
    expect(c.staged).toHaveLength(1);
    expect(c.staged[0]).toMatchObject({ run_id: ids[0], tainted: false });
    expect(c.staged[0]?.proposals).toBeGreaterThan(0);
    expect(await inspectSnapshot(r.w.io, productionSnapshotValidator)).toBe('consistent');
    expect(await exists(path.join(r.w.state, 'rsi', 'log.jsonl'))).toBe(false);
    expect(await exists(r.lock)).toBe(false);
  });

  it('counts 缺失 / 盐不符 → 四段重建;盐缺失 → 不写 counts(run 照常暂存)', async () => {
    for (const counts of ['missing', 'mismatch'] as const) {
      const r = await rworld({ counts });
      expect((await runR(r)).code, counts).toBe(ExitCode.OK);
      const c = await countsOf(r.w.state);
      expect(c.salt_fp).toBe(SALT_FP);
      expect(c.staged.map((e) => e.run_id)).toEqual(await runIds(r.w));
    }
    const r = await rworld({ salt: 'absent', counts: 'missing' });
    expect((await runR(r)).code).toBe(ExitCode.OK);
    expect(await runIds(r.w)).toHaveLength(1);
    expect(await exists(path.join(r.w.state, 'rsi', 'counts.json'))).toBe(false);
  });

  it('没暂存任何 run(backend_not_configured / 干跑)时不动 counts:generation 不变', async () => {
    const r = await rworld({ counts: 'ok' });
    const before = await readText(path.join(r.w.state, 'rsi', 'counts.json'));
    const dry = await runR(r, []);
    expect(dry.code, dry.err).toBe(ExitCode.OK);
    expect(await readText(path.join(r.w.state, 'rsi', 'counts.json'))).toBe(before);
    const live = await runR(r); // 正向对照:真跑会推进
    expect(live.code, live.err).toBe(ExitCode.OK);
    expect(await readText(path.join(r.w.state, 'rsi', 'counts.json'))).not.toBe(before);
  });

  it('锁内先 recover:counts 损坏 → 退 3,没有建任何 run 目录、后端零调用;正向对照:合规时会建', async () => {
    const bad = await rworld({ counts: 'corrupt' });
    const r = await runR(bad);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r.err).toMatch(/RSI_FAIL_CLOSED reason=\w+\n$/);
    expect(await runIds(bad.w)).toEqual([]);
    expect(bad.stub.calls).toBe(0);
    const ok = await rworld({ counts: 'ok' });
    expect((await runR(ok)).code).toBe(ExitCode.OK);
    expect(await runIds(ok.w)).toHaveLength(1);
  });

  it('锁内先 resumeTaint:已有 TAINTED 但摘录没清的 run,reflect 之后被清空;purge journal 在场时 reflect 先补 taint 再拒绝(purge_incomplete)', async () => {
    const r = await rworld({ counts: 'ok' });
    const other = path.join(r.w.state, 'reflect', 'run-tainted');
    const prop = path.join(other, 'proposals', '2026-10-12-009.yaml');
    await putFile(
      r.fx,
      prop,
      `id: 2026-10-12-009\nevidence:\n  - sig: sig_0123456789abcdef\n    project_key: p_fedcba9876543210\n    excerpt: ${EXCERPT_MARK}\n`,
    );
    await putFile(r.fx, path.join(other, 'report.json'), '{"run_id":"run-tainted"}');
    await putFile(
      r.fx,
      path.join(other, 'TAINTED'),
      '{"at":"2026-10-26T00:00:00.000Z","reason":"purge"}',
    );
    expect(await readText(prop)).toContain(EXCERPT_MARK);
    expect((await runR(r)).code).toBe(ExitCode.OK);
    expect(await readText(prop)).not.toContain(EXCERPT_MARK);
    // journal 在场:先补 taint(目标 run 被标记并清理)再拒绝
    const r2 = await rworld({ counts: 'ok' });
    const tgt = path.join(r2.w.state, 'reflect', 'run-purge');
    const prop2 = path.join(tgt, 'proposals', '2026-10-12-009.yaml');
    await putFile(
      r2.fx,
      prop2,
      `id: 2026-10-12-009\nevidence:\n  - sig: sig_0123456789abcdef\n    project_key: p_fedcba9876543210\n    excerpt: ${EXCERPT_MARK}\n`,
    );
    await putFile(r2.fx, path.join(tgt, 'report.json'), '{"run_id":"run-purge"}');
    await putFile(
      r2.fx,
      path.join(r2.w.state, 'rsi', 'purge-journal.json'),
      JSON.stringify({
        schema_version: 1,
        created_at: '2026-10-26T00:00:00.000Z',
        phase: 'planned',
        keys: ['p_aaaaaaaaaaaaaaaa'],
        taint_targets: { runs: ['run-purge'], promotes: [] },
      }),
    );
    const res = await runR(r2);
    expect(res.code).toBe(ExitCode.FAIL_CLOSED);
    expect(res.err).toContain('RSI_FAIL_CLOSED reason=purge_incomplete\n');
    expect(await exists(path.join(tgt, 'TAINTED'))).toBe(true);
    expect(await readText(prop2)).not.toContain(EXCERPT_MARK);
    expect(r2.stub.calls).toBe(0);
  });

  it('gc --write 不调 resumeTaint:purge journal 不合规时 gc 照常退 0(resumeTaint 会抛 journal_invalid);正向对照:同一世界 reflect --run-llm 被拦', async () => {
    const r = await rworld({ counts: 'ok' });
    await putFile(r.fx, path.join(r.w.state, 'rsi', 'purge-journal.json'), 'not json');
    const gc = await runR(r, ['--gc', '--write']);
    expect(gc.code, gc.err).toBe(ExitCode.OK);
    const live = await runR(r);
    expect(live.code).toBe(ExitCode.FAIL_CLOSED);
    expect(live.err).toContain('journal_invalid');
  });

  it('服务层每个写点之前失锁(k 遍历):退 3 lock_lost,该点之后零写入', async () => {
    const holder0: { inj?: ReturnType<typeof inject> } = {};
    const hooks0: ServiceHooks = { point: async (n) => holder0.inj?.hooks.point?.(n) };
    const probe = await rworld({ counts: 'ok', taintedRun: true, deps: { serviceHooks: hooks0 } });
    holder0.inj = inject(probe.fx, probe.lock, probe.audit, Number.POSITIVE_INFINITY, 'lose');
    expect((await runR(probe)).code).toBe(ExitCode.OK);
    const total = holder0.inj.calls();
    expect(total).toBeGreaterThanOrEqual(8); // 含 taint 清理写点
    for (let k = 1; k <= total; k++) {
      const holder: { inj?: ReturnType<typeof inject> } = {};
      const hooks: ServiceHooks = { point: async (n) => holder.inj?.hooks.point?.(n) };
      const r = await rworld({ counts: 'ok', taintedRun: true, deps: { serviceHooks: hooks } });
      holder.inj = inject(r.fx, r.lock, r.audit, k, 'lose');
      const res = await runR(r);
      const hit = holder.inj.at();
      expect(hit, `k=${k}`).toBeDefined();
      expect(res.code, `k=${k} ${hit?.name}`).toBe(ExitCode.FAIL_CLOSED);
      expect(res.err, `k=${k} ${hit?.name}`).toContain('RSI_FAIL_CLOSED reason=lock_lost\n');
      expect(r.audit.slice(hit?.audit ?? 0), `k=${k} ${hit?.name} 失锁之后零写入`).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 崩溃重跑幂等(服务层:settleStaged 在每个写点崩溃,重跑收敛到同一结果)
// ---------------------------------------------------------------------------
describe('settleStaged:崩溃重跑幂等', () => {
  it('每个写点崩溃 → 重跑 → counts(去掉 generation / computed_at)与清单与无崩溃运行相同', async () => {
    const canon = async (j: JW): Promise<unknown> => {
      const c = (await countsOf(j.w.state)) as unknown as Record<string, unknown>;
      delete c['generation'];
      delete c['computed_at'];
      return { c, snap: await inspectSnapshot(j.w.io, productionSnapshotValidator) };
    };
    const run = async (hooks?: ServiceHooks, j?: JW): Promise<JW> => {
      const w = j ?? (await jworld({ counts: 'ok' }));
      const sctx: RsiServiceCtx = { io: w.w.io, config: onConfig(w.w.dir) };
      const lock = await acquireRsiLock(w.w.io);
      try {
        await settleStaged(sctx, lock, testRedactor(), hooks);
      } finally {
        await lock.release();
      }
      return w;
    };
    const names: string[] = [];
    const base = await run({ point: (n) => void names.push(n) });
    const expected = await canon(base);
    expect((expected as { snap: string }).snap).toBe('consistent');
    const writes = names.filter((n) => n.startsWith('before:'));
    expect(writes.length).toBeGreaterThan(3);
    for (let k = 1; k <= writes.length; k++) {
      let n = 0;
      const j = await jworld({ counts: 'ok' });
      await expect(
        run(
          {
            point: (name) => {
              if (name.startsWith('before:') && ++n === k) throw new Error('crash');
            },
          },
          j,
        ),
      ).rejects.toThrow('crash');
      await run(undefined, j);
      expect(await canon(j), `k=${k} 崩溃重跑`).toEqual(expected);
    }
  });
});
