/**
 * R20-A6 R20-17.24:自动化端到端(假 HOME)。
 *  阶段一(采集):合成会话文件 → 钩子入口 `rsi poke`(spawn 注入,不起真进程)→ 自动 L0(进程内 worker)→ 下一次 `rsi hint` 出计数 → 首次 L0 后提醒一次采集开始。
 *  阶段二(产出到达用户):模拟 S1 —— `rsi digest --json` → 固定提案 JSON 经 `reflect --ingest -`(不 spawn 任何 LLM)→ `rsi status` 待审 1 → hint 的 M=1 →
 *    一个 TTY kit 命令后 stderr 恰好一次 `RSI_PROPOSALS_READY runs=1 proposals=1`,再跑一次都不再出现 → `rsi dismiss --all --write` →
 *    status 待审 0、D17 `pending_runs=0`、run 目录字节不变。
 * 全程 exec 审计:kit 进程不 spawn 任何 LLM CLI(llm-exec 的 runLlm 调用数为 0,runSync 只出现 git),且真实 HOME 未被写。
 *
 * 偏差(登记为 A6i):阶段一用 claude 会话夹具而不是 pi——pi 会话的生产形状仍是「假设」(R20-17.27 / A5 形状核实),A3 的 L0 夹具只有 claude 的完整会话形状。
 */
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runReflectIngest } from '../../src/commands/reflect-ingest.js';
import type { CommandContext } from '../../src/commands/types.js';
import { collectD17 } from '../../src/doctor/rsi-face.js';
import { readBytes } from '../../src/io/read-fs.js';
import { runDismiss } from '../../src/rsi/dismiss.js';
import { runHint } from '../../src/rsi/hint.js';
import { runRsiNotice } from '../../src/rsi/notice.js';
import { runPoke } from '../../src/rsi/poke.js';
import { runStatus, type StatusDoc } from '../../src/rsi/status.js';
import { runWorker } from '../../src/rsi/worker.js';
import { draft } from '../fixtures/reflect/world.js';
import {
  DIGEST_ARGS,
  assertNoRealHomeWrites,
  ctxOf,
  digestCmd,
  makeA4World,
  parseDigest,
  type A4World,
} from './a4-fixture.js';
import { makeTickFx } from './b5a-fixture.js';
import { claudeLine, jl, put as putSession, uuid } from './l0-fixture.js';
import { treeOf } from './rsi-fixture.js';
import { NOW, runDirect } from './ro-fixture.js';

const audit = vi.hoisted(() => ({ llm: 0, sync: [] as string[], self: 0 }));
vi.mock('../../src/io/llm-exec.js', async (orig) => {
  const m = await orig<typeof import('../../src/io/llm-exec.js')>();
  return {
    ...m,
    runLlm: ((...a: Parameters<typeof m.runLlm>) => {
      audit.llm++;
      return m.runLlm(...a);
    }) as typeof m.runLlm,
  };
});
vi.mock('../../src/io/exec.js', async (orig) => {
  const m = await orig<typeof import('../../src/io/exec.js')>();
  return {
    ...m,
    runSync: ((...a: Parameters<typeof m.runSync>) => {
      audit.sync.push(String(a[1]));
      return m.runSync(...a);
    }) as typeof m.runSync,
    runSelf: ((...a: Parameters<typeof m.runSelf>) => {
      audit.self++;
      return m.runSelf(...a);
    }) as typeof m.runSelf,
  };
});

const LINE_READY = /^RSI_PROPOSALS_READY runs=1 proposals=1\n$/;
const LINE_STARTED = /^RSI_COLLECTION_STARTED projects=\d+ excluded=\d+\n$/;

describe('R20-17.24 端到端', () => {
  it('阶段一:合成会话 → rsi poke → 自动 L0 → rsi hint 出计数 → 首次 L0 后 TTY 命令提示一次采集开始(再跑不再出现)', async () => {
    const f = await makeTickFx('a6-e2e-l0-', { confirmed: true });
    // 再造两类不同的纠正,各落在两个项目的独立会话里(去重会话数 2 = cluster_min):共 3 个聚类,hint 的 K ≥ 3 门槛成立
    const extra = [
      'from now on always run pnpm lint before committing',
      'from now on never force push to the main branch',
    ];
    for (const [j, text] of extra.entries()) {
      for (const i of [1, 2]) {
        const n = 16 + j * 2 + i;
        const cwd = path.join(f.dir, 'work', `proj${i}`);
        await putSession(
          f,
          'claude',
          `p/${uuid(n)}.jsonl`,
          jl(
            claudeLine(cwd, {
              timestamp: `2026-10-0${i}T01:0${j}:00.000Z`,
              message: { role: 'user', content: text },
            }),
            claudeLine(cwd, { timestamp: `2026-10-0${i}T01:0${j}:01.000Z` }),
          ),
        );
      }
    }
    const T = Date.parse(NOW) + 7 * 3600_000; // 距上次(从未)L0 足够久
    const calls: { args: readonly string[] }[] = [];
    const poke = await runPoke(['--agent', 'claude'], {
      env: f.env,
      writeAudit: (op, p) => void f.audit.push({ op, path: p }),
      now: () => new Date(T),
      nowMs: () => T,
      clockMs: () => 0,
      spawn: {
        runSelf: (o) => {
          calls.push({ args: o.args });
          return { spawned: true, status: null, signal: null, stdout: '' };
        },
      },
    });
    expect(poke).toEqual({ kind: 'spawned' });
    expect(calls[0]?.args).toContain('__rsi'); // 起的是零 LLM 的 L0 worker
    // 注入的 spawn 不起真进程:在进程内跑 worker 完成这次 L0
    const w = await runWorker({
      env: f.env,
      writeAudit: (op, p) => void f.audit.push({ op, path: p }),
      now: () => new Date(T),
      nowMs: () => T,
    });
    expect(w).toMatchObject({ kind: 'ran', outcome: 'ok' });

    // L0 真的采到了信号:status 现算(2 个采集中项目、信号 > 0)
    const st = await runDirect(f, runStatus, ['--json'], { now: () => new Date(T) });
    const counts = (JSON.parse(st.out) as StatusDoc).counts;
    expect(counts.projects_collecting).toBe(2);
    expect(counts.signals_total).toBeGreaterThan(0);
    // 首次 L0 完成即确认基线(新增项目 n = 0)、没有待审提案;3 个聚类使 hint 的 K ≥ 3 门槛成立 → 下一次 hint 出计数(R20-17.24)
    expect(counts.clusters_pending).toBeGreaterThanOrEqual(3);
    const hint = await runHint(['--agent', 'claude'], {
      env: f.env,
      now: () => new Date(T),
      clockMs: () => 0,
    });
    expect(hint).toMatch(/^agent-kit RSI: 新信号 \d+、待反思聚类 [3-9]\d*、待审提案 0、项目 2\(/);

    const lines: string[] = [];
    const n1 = await runRsiNotice(
      { argv: ['status'], env: f.env, isTty: true, stderr: (t) => void lines.push(t) },
      { now: () => new Date(T), clockMs: () => 0 },
    );
    expect(n1.kind).toBe('printed');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(LINE_STARTED);
    const again: string[] = [];
    await runRsiNotice(
      { argv: ['status'], env: f.env, isTty: true, stderr: (t) => void again.push(t) },
      { now: () => new Date(T), clockMs: () => 0 },
    );
    expect(again).toEqual([]);
  });

  it('阶段二:digest → ingest → status 待审 1 → 提醒恰好一次 → dismiss → 待审 0、D17 pending_runs=0、run 目录字节不变;全程零 LLM spawn、真实 HOME 未写', async () => {
    audit.llm = 0;
    audit.sync.length = 0;
    audit.self = 0;
    const w = await makeA4World('a6-e2e-s1-');
    const now = (): Date => new Date(w.s.clock.t);

    const statusDoc = async (): Promise<StatusDoc> => {
      const out = { o: '', e: '' };
      const code = await runStatus(ctxOf(w, ['--json'], out), { now });
      expect(code, out.e).toBe(0);
      return JSON.parse(out.o) as StatusDoc;
    };
    expect((await statusDoc()).counts.pending_runs).toBe(0);

    // S1:digest(JSON)→ 固定提案 → reflect --ingest -
    const d = await digestCmd(w, DIGEST_ARGS('claude'));
    expect(d.code, d.err).toBe(0);
    const digestId = parseDigest(d.out).digest_id;
    const ing = await ingest(w, digestId, JSON.stringify({ proposals: [proposal()] }));
    expect(ing.code, ing.err).toBe(0);
    const runId = (JSON.parse(ing.out) as { run_id: string }).run_id;

    // status 待审 1;hint 的 M = 1
    const st = await statusDoc();
    expect([st.counts.pending_runs, st.counts.pending_proposals]).toEqual([1, 1]);
    const hint = await runHint(['--agent', 'claude'], { env: w.env, now, clockMs: () => 0 });
    expect(hint).toContain('待审提案 1、');

    // 一个 TTY kit 命令之后:恰好一次提醒(采集开始 + 提案就绪),再跑一次都不再出现
    const shown: string[] = [];
    const run = (): ReturnType<typeof runRsiNotice> =>
      runRsiNotice(
        { argv: ['status'], env: w.env, isTty: true, stderr: (t) => void shown.push(t) },
        { now, clockMs: () => 0 },
      );
    expect((await run()).kind).toBe('printed');
    expect(shown).toHaveLength(2);
    expect(shown[0]).toMatch(LINE_STARTED);
    expect(shown[1]).toMatch(LINE_READY);
    for (const l of shown)
      for (const needle of [runId, w.s.f.dir, 'rule-']) expect(l).not.toContain(needle);
    shown.length = 0;
    await run();
    await run();
    expect(shown).toEqual([]);

    // dismiss --all --write:run 目录字节不变,待审 0,D17 pending_runs=0
    const reflectRoot = path.join(w.s.state, 'reflect');
    const before = await treeOf(reflectRoot);
    const rpt = Buffer.from(await readBytes(path.join(reflectRoot, runId, 'report.json')));
    const out = { o: '', e: '' };
    const code = await runDismiss(ctxOf(w, ['--all', '--write', '--json'], out), { now });
    expect([code, out.e]).toEqual([0, '']);
    expect(JSON.parse(out.o)).toEqual({ result: 'dismissed', runs: [runId], count: 1 });
    expect(await treeOf(reflectRoot)).toEqual(before);
    expect(
      Buffer.from(await readBytes(path.join(reflectRoot, runId, 'report.json'))).equals(rpt),
    ).toBe(true);
    const after = await statusDoc();
    expect([after.counts.pending_runs, after.counts.pending_proposals]).toEqual([0, 0]);
    expect(after.counts.staged_runs).toBe(1); // 忽略不释放暂存容量
    const d17 = await collectD17({ home: w.s.f.home, env: w.env, now });
    expect(d17.facts.pending_runs).toBe(0);
    // 待审提案已是 0(忽略生效);hint 仍会输出,因为 A4 夹具里两个项目是「新增」(n ≥ 1 的输出门槛)——这里只钉 M
    const afterHint = await runHint(['--agent', 'codex'], { env: w.env, now, clockMs: () => 0 });
    expect(afterHint).toContain('待审提案 0、');

    // exec 审计:没有任何 LLM CLI 被 spawn;子进程出口只有 git;没有 runSelf
    expect(audit.llm).toBe(0);
    expect(audit.sync.filter((c) => c !== 'git')).toEqual([]);
    expect(audit.self).toBe(0);
    assertNoRealHomeWrites(w);
  });
});

/** 固定提案(与 a4-ingest 的 uniq 同形;证据别名取自 digest 的 e1) */
function proposal(): Record<string, unknown> {
  return draft({
    id: 'rule-rotate-credentials-0',
    title: 'rotate credentials',
    do: 'rotate the credentials quarterly and keep them carefully for the whole team.',
    why: 'Skipping rotate on credentials caused outages 0 times and wasted the whole quarterly cycle.',
    verify: 'The credentials rotate step is visible in the release checklist 0.',
    signature: { type: 'phrase', pattern: 'zzrotate0' },
    rationale: 'Several sessions asked to rotate credentials quarterly.',
  });
}

async function ingest(
  w: A4World,
  digestId: string,
  text: string,
): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const ctx: CommandContext = {
    argv: [],
    io: w.s.io,
    env: w.env,
    overlayPath: undefined,
    stdout: (t) => void (out += t),
    stderr: (t) => void (err += t),
    readStdin: async () => ({ text, tooLarge: false }),
  };
  const code = await runReflectIngest(
    ctx,
    {
      ingestValue: '-',
      digest: digestId,
      agents: ['claude'],
      owner: '@tester',
      json: true,
      conflict: false,
    },
    { clock: () => new Date(w.s.clock.t) },
  );
  return { code, out, err };
}
