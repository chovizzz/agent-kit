/**
 * 装配块 A 段:空写入根子进程用例(W8a 遗留的零写入层 ②;contracts R21-12.1)。
 * 两类作业(`proc/asm-a-job.ts`):`read` = 对**真实**只读适配器逐端口取值;`commands` = W8a 遗留的原话对象——对生产组装(`productionAutoPorts`,git 未装配)经 `runAutoFamily` 跑五类只读命令(相位 2 只经 deps 注入,无环境变量后门)。
 * 同一份作业在三个条件下跑:进程内带写审计钩子(层 ① 外部累计数组)、
 * 真子进程 `KIT_WRITE_ROOTS=:`(写入根集合为空,safe-fs 一律拒写;层 ②),前后目录树比较(最终状态)。
 * 对照:同一子进程模式下写探针被拒(IO_WRITE_DENIED),默认写入根下成功并改变目录树——证明空写入根与审计钩子确实在起作用。
 * 夹具遵守 agent-kit-subprocess-test-pitfalls:KIT_TMP / 假 HOME / 仓库互为兄弟(`makeRoFx`),作业体先读到 `.state/rsi` 里的真数据(`state_dir_unsafe` 会让下面的正向断言失败)。
 * 非空世界(有暂存提案 / 真实技能 payload / 有登记目标 / shadow 恢复)另有用例:对每个预期成功的端口断言 `ok` 且无 `err`。shadow 恢复的值是 null(没有 ≥ 20 会话的观察;恢复内部读失败也映射为 null,所以只证明调用执行且无异常传播)。
 * 未覆盖(如实记录):git 子进程出口——`gitPath` 恒解析不到(未装配),受限 git 适配器的真仓库零写入证据仍在 `git-readonly.test.ts`。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as safe from '../../../src/io/safe-fs.js';
import { viewOf } from '../auto/auto-fixture.js';
import { canaryDoc } from '../canary/w5-fixture.js';
import { buildAsmAChild, runAsmAChild } from '../proc/asm-a-helper.js';
import { runAsmAJob, type AsmAJob } from '../proc/asm-a-job.js';
import { RUN_ID } from '../../judge/helpers.js';
import { writeSessionProposal } from '../../judge/ingest/fixtures.js';
import { entry, rec as lifecycleRec, SIG } from '../personal/transition-fixture.js';
import {
  baseState,
  countsOf,
  indexOf,
  key,
  makeRoFx,
  mkProject,
  seed,
  type RoFx,
} from '../ro-fixture.js';
import { sha } from '../../sync/world.js';
import { treeOf } from '../rsi-fixture.js';

const REV = {
  at: '2026-11-10T00:00:00.000Z',
  candidate_id: 'ra_0123456789ab',
  content_sha256: 'a'.repeat(64),
  identity12: null,
  reason: 'harm_c1',
  by: 'worker',
};
const SIGNAL = {
  sig_id: 'sig_0000000000000001',
  agent: 'claude',
  agent_version: '2.1.0',
  agent_version_source: 'session_meta',
  session_ref: 's_0000000000000001',
  project_key: 'p1',
  ts: '2026-11-05T10:00:00Z',
  type: 'event',
  excerpt_redacted: '',
  external_content: false,
  confidence: 1,
  loaded_rule_ids: [],
  event_kind: 'tool_result_failed',
  event_index: 0,
};

/** `rich` = 非空世界:有暂存提案(counts 暂存 run + 真实提案 / 规则文件)、归属为 P 的项目 */
async function world(rich = false): Promise<RoFx> {
  const f = await makeRoFx('asm-a-ro-');
  const proj = rich ? await mkProject(f, 'proj-a') : undefined;
  await seed(f, {
    ...(proj === undefined
      ? {}
      : {
          index: indexOf([{ key: key(1), path: proj.path, dev: proj.dev, ino: proj.ino }]),
          counts: countsOf(
            { [key(1)]: { total: 1 } },
            {
              staged: [{ run_id: RUN_ID, proposals: 1, evidence_keys: [key(1)], tainted: false }],
            },
          ),
        }),
    state: baseState({
      last_tick: {
        completed_at: '2026-11-15T10:00:10.000Z',
        trigger: 'tick',
        outcome: 'ok',
        code: null,
        duration_ms: 10_000,
        files_read: 1,
        bytes_read: 1,
      },
    }),
    side: {
      'canary.json': JSON.stringify(canaryDoc()),
      'canary-ledger.jsonl': '',
      AUTO_PAUSE_BREAKER: JSON.stringify({
        at: '2026-11-15T00:00:00.000Z',
        by: 'breaker',
        reason: 'user_vetoes',
        id: '0123456789abcdef',
      }),
    },
  });
  if (rich) {
    await writeSessionProposal({
      io: f.io,
      runDir: path.join(f.io.stateDir, 'reflect', RUN_ID),
    } as never);
  }
  const sigDir = path.join(f.io.stateDir, 'signals', 'claude');
  await safe.mkdirp(f.io, sigDir, 0o700);
  await safe.writeFile(f.io, path.join(sigDir, '202611.jsonl'), `${JSON.stringify(SIGNAL)}\n`, {
    mode: 0o600,
  });
  const revDir = path.join(f.home, '.local', 'state', 'agent-kit', 'rsi-personal');
  await safe.mkdirp(f.fx, revDir, 0o700);
  await safe.writeFile(f.fx, path.join(revDir, 'revocations.jsonl'), `${JSON.stringify(REV)}\n`, {
    mode: 0o600,
  });
  return f;
}

const SKILL_REL = '.claude/skills/commit-checklist/SKILL.md';
const skillText = (desc: string): string =>
  `---\nname: commit-checklist\ndescription: ${desc}\n---\n\n# commit-checklist\n\nstep one\nstep two\n`;

/** 非空世界的 HOME 部分:有登记目标(内容与登记一致)的同步登记表 */
async function seedRegistry(f: RoFx): Promise<void> {
  const body = 'original\n';
  const skill = path.join(f.home, SKILL_REL);
  await safe.mkdirp(f.fx, path.dirname(skill), 0o755);
  await safe.writeFile(f.fx, skill, body, { mode: 0o644 });
  const dir = path.join(f.home, '.local/state/agent-kit/sync');
  await safe.mkdirp(f.fx, dir, 0o700);
  await safe.writeFile(
    f.fx,
    path.join(dir, 'ledger.json'),
    JSON.stringify({
      schema_version: 1,
      kit_version: '1.0.0',
      payload_sha256: 'c'.repeat(64),
      entries: [
        {
          path: SKILL_REL,
          kind: 'owned',
          sha256: sha(body),
          created_file: true,
          agents: ['claude'],
          txn: 'txn-20261115T000000Z-000001',
        },
      ],
    }),
    { mode: 0o600 },
  );
}

const jsonOf = (x: unknown): unknown => JSON.parse(JSON.stringify(x));
/** 命令输出里可能带墙钟时间(`as_of` 等):两次运行必然不同,比较前抹平 */
const norm = (x: unknown): Record<string, unknown> =>
  JSON.parse(
    JSON.stringify(x).replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, '<T>'),
  ) as Record<string, unknown>;

/** 与 `test/rsi/auto/zero-write.test.ts` 的 `populated` 同一世界:假 HOME + 合规 `[rsi] repo` + auto-view / audit 文件 */
async function commandsWorld(): Promise<RoFx> {
  const f = await makeRoFx('asm-a-cmd-');
  const rsiDir = path.join(f.io.stateDir, 'rsi');
  await safe.mkdirp(f.io, rsiDir, 0o700);
  const view = viewOf({
    as_of: new Date().toISOString(),
    pipeline: { states: {}, last30d: { rejected: 0, rolled_back: 0, expired: 0, retired: 0 } },
  });
  await safe.writeFile(f.io, path.join(rsiDir, 'auto-view.json'), JSON.stringify(view), {
    mode: 0o600,
  });
  await safe.writeFile(f.io, path.join(rsiDir, 'audit.jsonl'), '', { mode: 0o600 });
  return f;
}

describe('只读适配器的零写入:进程内写审计 + 空写入根真子进程 + 目录树前后相同', () => {
  it('同一读作业:进程内写审计为空、子进程(KIT_WRITE_ROOTS=:)结果与进程内逐项相等且没有 IO_WRITE_DENIED、目录树不变;且确实读到了数据(不是都在报错)', async () => {
    const f = await world();
    const script = await buildAsmAChild(f.tmp);
    const job: AsmAJob = { kind: 'read', env: f.env, cwd: f.dir, repo: f.repo };
    const before = await treeOf(f.dir);

    const audit: { op: string; path: string }[] = [];
    const inproc = jsonOf(await runAsmAJob(job, audit)) as Record<string, unknown>;
    const child = runAsmAChild(script, { ...job, env: { ...f.env, KIT_WRITE_ROOTS: ':' } });

    expect(audit).toEqual([]);
    expect(child).toEqual(inproc);
    expect(JSON.stringify(child)).not.toContain('IO_WRITE_DENIED');
    expect(JSON.stringify(child)).not.toContain('state_dir_unsafe');
    expect(await treeOf(f.dir)).toEqual(before);

    // 正向前提:端口读到了世界里的真数据
    const ok = (k: string): unknown => (inproc[k] as { ok?: unknown } | undefined)?.ok;
    expect(inproc['spawnCalls']).toEqual([]);
    expect(ok('recorded')).toEqual({ kind: 'unreadable', why: 'not_wired' });
    expect(ok('peekRecords')).toEqual({ kind: 'absent' });
    expect(ok('revocations')).toMatchObject({
      kind: 'ok',
      lines: [{ candidate_id: REV.candidate_id }],
    });
    expect(ok('breaker')).toMatchObject({ by: 'breaker', reason: 'user_vetoes' });
    expect(typeof ok('c4Bytes')).toBe('number');
    expect(ok('collectedThrough')).toBe('2026-11-15T10:00:00.000Z');
    expect((ok('signals') as unknown[]).length).toBe(1);
    expect(ok('staged')).toEqual([]);
    expect(ok('presets')).toEqual([]);
    expect(ok('ledger')).toEqual([]);
    expect(ok('payloadDrift')).toBe('clean');
  }, 120_000);

  it('非空世界:有效暂存提案、真实技能 payload(同 id 相同副本合并 + 不同副本保留)、有登记目标、shadow 恢复;进程内与空写入根子进程逐项相等,每个预期成功的端口有 ok 无 err,写审计为空、目录树不变', async () => {
    const f = await world(true);
    await seedRegistry(f);
    const script = await buildAsmAChild(f.tmp);
    const job: AsmAJob = {
      kind: 'read',
      env: f.env,
      cwd: f.dir,
      repo: f.repo,
      skills: [
        { payload_path: `files/claude/home/${SKILL_REL}`, text: skillText('same copy') },
        { payload_path: `files/codex/home/${SKILL_REL}`, text: skillText('same copy') },
        { payload_path: `files/pi/home/${SKILL_REL}`, text: skillText('pi variant') },
      ],
      shadowRec: lifecycleRec('shadow', {
        transitions: [entry(1), entry(2, 'shadow', '2026-10-01T00:00:00Z')],
        cluster_signature: { ...SIG },
      }),
    };
    const before = await treeOf(f.dir);

    const audit: { op: string; path: string }[] = [];
    const inproc = jsonOf(await runAsmAJob(job, audit)) as Record<string, unknown>;
    const child = runAsmAChild(script, { ...job, env: { ...f.env, KIT_WRITE_ROOTS: ':' } });

    expect(audit).toEqual([]);
    expect(child).toEqual(inproc);
    expect(JSON.stringify(child)).not.toContain('IO_WRITE_DENIED');
    expect(await treeOf(f.dir)).toEqual(before);

    // 每个端口都有 ok 无 err(`take` 会把异常包成 { err },不逐项断言就看不出「相同地失败」)
    for (const [k, v] of Object.entries(inproc)) {
      if (k === 'spawnCalls') continue;
      expect(v, k).toHaveProperty('ok');
      expect(v, k).not.toHaveProperty('err');
    }
    const ok = (k: string): unknown => (inproc[k] as { ok?: unknown }).ok;
    // 非空读到的内容(不是空分支)
    const staged = ok('staged') as { runId: string }[];
    expect(staged.length).toBe(1);
    expect(staged[0]?.runId).toBe(RUN_ID);
    const presets = ok('presets') as { id: string; do: string }[];
    expect(presets.map((t) => t.do).sort()).toEqual(['pi variant', 'same copy']);
    expect(ok('payloadDrift')).toBe('clean');
    expect(ok('breaker')).toMatchObject({ by: 'breaker' });
    expect((ok('signals') as unknown[]).length).toBe(1);
    // shadow 恢复:端口调用成功(未抛);夹具里没有满足 ≥ 20 会话的观察,所以值为 null(恢复内部的读失败也映射为 null,故这里只证明「调用执行且无异常传播」)
    expect(ok('readySince')).toBeNull();
    expect(inproc['spawnCalls']).toEqual([]);
  }, 180_000);

  it('非空世界的对照:登记目标被改 → payloadDrift 为 drifted、被删 → drifted(同一子进程里仍零写入),证明上面的 clean 来自真实比对', async () => {
    const f = await world(true);
    await seedRegistry(f);
    const script = await buildAsmAChild(f.tmp);
    const job: AsmAJob = { kind: 'read', env: f.env, cwd: f.dir, repo: f.repo };
    const env = { ...f.env, KIT_WRITE_ROOTS: ':' };
    expect(runAsmAChild(script, { ...job, env })['payloadDrift']).toEqual({ ok: 'clean' });
    await safe.writeFile(f.fx, path.join(f.home, SKILL_REL), 'edited\n', { mode: 0o644 });
    expect(runAsmAChild(script, { ...job, env })['payloadDrift']).toEqual({ ok: 'drifted' });
    await safe.remove(f.fx, path.join(f.home, SKILL_REL));
    expect(runAsmAChild(script, { ...job, env })['payloadDrift']).toEqual({ ok: 'drifted' });
  }, 180_000);

  it('对照:同一子进程模式下写探针被拒(IO_WRITE_DENIED);默认写入根下写成功并改变目录树(空写入根与审计手段确实有效)', async () => {
    const f = await world();
    const script = await buildAsmAChild(f.tmp);
    const base: AsmAJob = { kind: 'write_probe', env: f.env, cwd: f.dir, repo: f.repo };
    const before = await treeOf(f.dir);
    const denied = runAsmAChild(script, { ...base, env: { ...f.env, KIT_WRITE_ROOTS: ':' } });
    expect(JSON.stringify(denied['probe'])).toContain('IO_WRITE_DENIED');
    expect(await treeOf(f.dir)).toEqual(before);
    const allowed = runAsmAChild(script, base);
    expect(allowed['probe']).toEqual({ ok: true });
    expect(await treeOf(f.dir)).not.toEqual(before);

    // 进程内的写审计钩子对照:同一作业体里的写探针会被钩子记到
    const audit: { op: string; path: string }[] = [];
    const g = await world();
    await runAsmAJob({ kind: 'write_probe', env: g.env, cwd: g.dir, repo: g.repo }, audit);
    expect(audit.length).toBeGreaterThan(0);
  }, 120_000);
  it('W8a 遗留的命令层 ②:五类只读命令(auto status / clear 干跑 / report / show / rollback --to 干跑;相位 2 只经 deps 注入)在空写入根真子进程里与进程内逐项相等、写审计为空、没有 IO_WRITE_DENIED、目录树不变', async () => {
    const f = await commandsWorld();
    const script = await buildAsmAChild(f.tmp);
    const job: AsmAJob = { kind: 'commands', env: f.env, cwd: f.dir, repo: f.repo };
    const before = await treeOf(f.dir);

    const inproc = norm(await runAsmAJob(job));
    const child = norm(runAsmAChild(script, { ...job, env: { ...f.env, KIT_WRITE_ROOTS: ':' } }));

    expect(child).toEqual(inproc);
    for (const [k, v] of Object.entries(child)) {
      const r = v as { code: number; err: string; audit: unknown[] };
      expect(r.audit, k).toEqual([]);
      expect(r.err, k).not.toContain('IO_WRITE_DENIED');
      expect(r.err, k).not.toContain('state_dir_unsafe');
      expect(r.code, k).not.toBe(64); // 不是「未实现」桩
    }
    expect(await treeOf(f.dir)).toEqual(before);

    // 正向前提:命令确实读到了数据而不是都在报错(与 zero-write.test.ts 同一组期望)
    const code = (k: string): unknown => (child[k] as { code: number } | undefined)?.code;
    expect(code('auto status')).toBe(0);
    expect(code('report ')).toBe(0);
    expect(code('auto clear')).toBe(0);
    expect(code('rollback --to 2026-11-01')).toBe(0);
    expect(code('show ra_0123456789ab')).toBe(2); // 没有私有仓库 = 没有候选 = unknown_id
    expect((child['auto status'] as { out: string }).out.length).toBeGreaterThan(0);
  }, 180_000);
});
