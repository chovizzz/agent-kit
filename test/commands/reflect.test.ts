import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createReflectCommand } from '../../src/commands/reflect.js';
import type { ReflectCommandDeps } from '../../src/commands/reflect.js';
import { canonicalJson } from '../../src/io/canonical-json.js';
import type { Signal } from '../../src/contracts/signal.js';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { exists, readDir, readText } from '../../src/io/read-fs.js';
import { runReflect } from '../../src/reflect/run.js';
import type { RunDeps, RunOpts, RunResult } from '../../src/reflect/run.js';
import { stageDir } from '../../src/reflect/stage.js';
import {
  ReflectCallLimitError,
  ReflectFailClosedError,
  ReflectUsageError,
} from '../../src/reflect/types.js';
import { SignalStoreError } from '../../src/signals/state-store.js';
import { WriteDeniedError } from '../../src/io/safe-fs.js';
import {
  CANARY_EXT,
  CANARY_LEGACY,
  CANARY_TR,
  CANARY_UM,
  INJECTION,
  StubBackend,
  draft,
  lintDraft,
  okText,
  out as outJson,
  projectKey,
  sig,
  snapshot,
  testRedactor,
} from '../fixtures/reflect/world.js';
import { EGRESS_OVERLAY, ctxFor, kitToml, newR5World, overlayToml } from './r5-world.js';
import type { R5World } from './r5-world.js';

const OLD_KEYS = [
  'backend',
  'budget',
  'calls',
  'duplicates',
  'exit_code',
  'guardrail_mentions',
  'mode',
  'observations',
  'outcome',
  'plan',
  'planned_backend',
  'prompt',
  'rejected',
  'run_id',
  'signals',
  'staged',
];
const CLOCK = (): Date => new Date('2026-10-12T08:00:00Z');
const RUN_ID = 'run-20261012T080000Z-abc123';
const LIVE = ['--run-llm', '--allow-egress', '--owner', '@tester'];

interface Rig {
  w: R5World;
  stub: StubBackend;
  factoryCalls: { n: number };
  cmd: ReturnType<typeof createReflectCommand>;
}

async function rig(
  o: {
    overlay?: string;
    maxLines?: number;
    respond?: ConstructorParameters<typeof StubBackend>[0];
    vendor?: string;
    deps?: Partial<ReflectCommandDeps>;
    signals?: Parameters<typeof newR5World>[0] extends infer T
      ? T extends { signals?: infer S }
        ? S
        : never
      : never;
  } = {},
): Promise<Rig> {
  const w = await newR5World({
    ...(o.overlay !== undefined ? { overlay: o.overlay } : { overlay: EGRESS_OVERLAY }),
    ...(o.maxLines !== undefined ? { maxLines: o.maxLines } : {}),
    ...(o.signals !== undefined ? { signals: o.signals } : {}),
  });
  const stub = new StubBackend(o.respond ?? ((req) => okText(outJson(lintDraft(req.user)))), {
    ...(o.vendor !== undefined ? { vendor: o.vendor } : {}),
  });
  const factoryCalls = { n: 0 };
  const cmd = createReflectCommand({
    clock: CLOCK,
    randomHex: () => 'abc123',
    redactor: testRedactor(),
    createBackends: () => {
      factoryCalls.n++;
      return { glm: stub };
    },
    ...(o.deps ?? {}),
  });
  return { w, stub, factoryCalls, cmd };
}

describe('reflect 命令:默认干跑', () => {
  it('零后端构造、零调用、零写入;打印计划(正向对照:聚类/证据数 > 0)', async () => {
    const r = await rig();
    const before = await snapshot(r.w.parent);
    const { ctx, out, err } = ctxFor(r.w, []);
    expect(await r.cmd.run(ctx)).toBe(ExitCode.OK);
    expect(r.factoryCalls.n).toBe(0);
    expect(r.stub.calls).toBe(0);
    expect(await snapshot(r.w.parent)).toBe(before);
    expect(await exists(stageDir(r.w.io, RUN_ID))).toBe(false);
    const text = out.join('');
    expect(text).toContain('mode=dry');
    expect(text).toMatch(/clusters=[1-9]/);
    expect(text).toMatch(/evidence=[1-9]/);
    expect(text).toMatch(/bytes=[1-9]\d* sha256=[0-9a-f]{64}/);
    expect(text).toContain('budget=ok');
    expect(err.join('')).toBe('');
  });

  it('--show-prompt:提示只打到 stdout 不落盘(正向对照:含 L1 canary;不含外部/失败结果 canary)', async () => {
    const r = await rig();
    const before = await snapshot(r.w.parent);
    const { ctx, out } = ctxFor(r.w, ['--show-prompt']);
    expect(await r.cmd.run(ctx)).toBe(ExitCode.OK);
    const text = out.join('');
    expect(text).toContain(CANARY_UM);
    for (const c of [CANARY_EXT, CANARY_TR, CANARY_LEGACY]) expect(text).not.toContain(c);
    expect(await snapshot(r.w.parent)).toBe(before);
    expect(r.factoryCalls.n).toBe(0);
  });

  it('--show-prompt 与 --json / --run-llm 互斥 → 2,零写入', async () => {
    const r = await rig();
    const before = await snapshot(r.w.parent);
    for (const argv of [
      ['--show-prompt', '--json'],
      ['--show-prompt', '--run-llm', '--allow-egress', '--owner', '@tester'],
    ]) {
      const { ctx, out } = ctxFor(r.w, argv);
      expect(await r.cmd.run(ctx)).toBe(ExitCode.USAGE);
      expect(out.join('')).toBe('');
    }
    expect(await snapshot(r.w.parent)).toBe(before);
    expect(r.stub.calls + r.factoryCalls.n).toBe(0);
  });

  it('干跑不要求 --owner;--json 摘要只含白名单键,且不含任何摘录/提示文本', async () => {
    const r = await rig();
    const { ctx, out } = ctxFor(r.w, ['--json']);
    expect(await r.cmd.run(ctx)).toBe(ExitCode.OK);
    const text = out.join('');
    const j = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(j).sort()).toEqual([
      'backend',
      'budget',
      'calls',
      'duplicates',
      'exit_code',
      'guardrail_mentions',
      'mode',
      'observations',
      'outcome',
      'plan',
      'planned_backend',
      'project_key_counts',
      'prompt',
      'rejected',
      'run_id',
      'signals',
      'staged',
    ]);
    expect(j['mode']).toBe('dry');
    expect((j['plan'] as { evidence: number }).evidence).toBeGreaterThan(0); // 正向对照
    for (const c of [CANARY_UM, CANARY_EXT, CANARY_TR, INJECTION, '提交代码前']) {
      expect(text).not.toContain(c);
    }
  });
});

describe('reflect 干跑:project_key 计数(供填 team_project_keys)', () => {
  const sigs = (): Signal[] => [
    sig({ project: 'A', session: 'A1', index: 0, text: '以后提交代码前必须先运行 lint 检查' }),
    sig({ project: 'A', session: 'A1', index: 1, text: '以后修改配置前必须先备份旧文件' }),
    sig({ project: 'A', session: 'A2', index: 0, text: '以后发布前必须先跑完整测试' }),
    sig({ project: 'B', session: 'B1', index: 0, text: '以后提交代码前必须先运行 lint 检查并修复告警' }),
  ];

  it('--json:project_key_counts 按 key 升序,会话数按 session_ref 去重(同 key 多会话),信号数按条;旧字段逐字节不变', async () => {
    const r = await rig({ signals: sigs() });
    const { ctx, out } = ctxFor(r.w, ['--json']);
    expect(await r.cmd.run(ctx)).toBe(ExitCode.OK);
    const raw = out.join('');
    const j = JSON.parse(raw) as Record<string, unknown>;
    const counts = j['project_key_counts'] as { project_key: string; sessions: number; signals: number }[];
    const expected = [
      { project_key: projectKey('A'), sessions: 2, signals: 3 },
      { project_key: projectKey('B'), sessions: 1, signals: 1 },
    ].sort((a, b) => (a.project_key < b.project_key ? -1 : 1));
    expect(counts).toEqual(expected);
    // canonical:整份输出等于对解析结果重新 canonical 序列化(新键没有破坏键序/格式)
    expect(raw).toBe(canonicalJson(j));
    // 旧字段不变:去掉新键后的 canonical 字节 = 老形状(不含新键)的字节
    const { project_key_counts: _drop, ...legacy } = j;
    expect(Object.keys(legacy).sort()).toEqual(OLD_KEYS);
    expect((j['signals'] as { loaded: number }).loaded).toBe(4);
  });

  it('文本输出新增一段,只有哈希 id 与计数;不含路径/文本', async () => {
    const r = await rig({ signals: sigs() });
    const { ctx, out } = ctxFor(r.w, []);
    expect(await r.cmd.run(ctx)).toBe(ExitCode.OK);
    const text = out.join('');
    expect(text).toContain('project_keys(');
    expect(text).toContain(`${projectKey('A')} sessions=2 signals=3`);
    expect(text).toContain(`${projectKey('B')} sessions=1 signals=1`);
    expect(text).not.toContain(r.w.parent);
    expect(text).not.toContain('lint');
  });

  it('无信号 → 新键缺省(旧形状);真跑摘要也不带该键(只干跑)', async () => {
    const empty = await rig({ signals: [] });
    const e = ctxFor(empty.w, ['--json']);
    expect(await empty.cmd.run(e.ctx)).toBe(ExitCode.OK);
    expect('project_key_counts' in JSON.parse(e.out.join(''))).toBe(false);
    const live = await rig();
    const l = ctxFor(live.w, [...LIVE, '--json']);
    expect(await live.cmd.run(l.ctx)).toBe(ExitCode.OK);
    expect('project_key_counts' in JSON.parse(l.out.join(''))).toBe(false);
  });
});

describe('reflect 命令:egress 门与用法错', () => {
  it('--run-llm 缺 --allow-egress → 2:工厂不构造、后端零调用、零写入(正向对照:补上后才执行)', async () => {
    const r = await rig();
    const before = await snapshot(r.w.parent);
    const { ctx, err } = ctxFor(r.w, ['--run-llm', '--owner', '@tester']);
    expect(await r.cmd.run(ctx)).toBe(ExitCode.USAGE);
    expect(err.join('')).toContain('--allow-egress');
    expect(r.factoryCalls.n).toBe(0);
    expect(r.stub.calls).toBe(0);
    expect(await snapshot(r.w.parent)).toBe(before);

    const ok = ctxFor(r.w, LIVE);
    expect(await r.cmd.run(ok.ctx)).toBe(ExitCode.OK);
    expect(r.stub.calls).toBe(1);
    expect(r.factoryCalls.n).toBe(1);
  });

  it('两个 flag 都给但覆盖层未同意外发(缺覆盖层 / egress=false)→ 2,零构造零调用零写入', async () => {
    for (const overlay of [undefined, overlayToml('egress = false')]) {
      const w = await newR5World(overlay === undefined ? {} : { overlay });
      const stub = new StubBackend((req) => okText(outJson(lintDraft(req.user))));
      let built = 0;
      const cmd = createReflectCommand({
        clock: CLOCK,
        randomHex: () => 'abc123',
        redactor: testRedactor(),
        createBackends: () => {
          built++;
          return { glm: stub };
        },
      });
      const before = await snapshot(w.parent);
      const { ctx, err } = ctxFor(w, LIVE);
      expect(await cmd.run(ctx)).toBe(ExitCode.USAGE);
      expect(err.join('')).toContain('reflect.egress');
      expect(built + stub.calls).toBe(0);
      expect(await snapshot(w.parent)).toBe(before);
    }
  });

  it('--run-llm --allow-egress 缺 --owner → 2;非法 owner → 2;零调用', async () => {
    const r = await rig();
    for (const argv of [
      ['--run-llm', '--allow-egress'],
      ['--run-llm', '--allow-egress', '--owner', 'nobody'],
    ]) {
      const { ctx } = ctxFor(r.w, argv);
      expect(await r.cmd.run(ctx)).toBe(ExitCode.USAGE);
    }
    expect(r.stub.calls).toBe(0);
    expect(await exists(stageDir(r.w.io, RUN_ID))).toBe(false);
  });

  it.each([
    [['--max-calls', '0']],
    [['--max-calls', '4']],
    [['--max-calls', '1e1']],
    [['--max-calls', '0x2']],
    [['--max-calls', '+2']],
    [['--max-calls', '-1']],
    [['--max-calls', '1.5']],
    [['--max-calls', ' 2']],
    [['--max-proposals', '0']],
    [['--max-proposals', '6']],
    [['--max-proposals', '1e0']],
    [['--timeout-ms', '999']],
    [['--timeout-ms', '600001']],
    [['--timeout-ms', '0x3e8']],
    [['--since', '2026-13-01']],
    [['--since', 'yesterday']],
    [['--agent', 'nope']],
    [['--backend', 'nope']],
    [['--bogus']],
    [['--max-calls']],
  ])('数字/枚举参数非法 %j → 2(parseDecimalUint)', async (argv) => {
    const r = await rig();
    const { ctx } = ctxFor(r.w, argv as string[]);
    expect(await r.cmd.run(ctx)).toBe(ExitCode.USAGE);
    expect(r.factoryCalls.n + r.stub.calls).toBe(0);
  });

  it('合法边界值通过(正向对照):--max-calls 3 --max-proposals 5 --timeout-ms 1000', async () => {
    const r = await rig();
    const { ctx } = ctxFor(r.w, [
      '--max-calls',
      '3',
      '--max-proposals',
      '5',
      '--timeout-ms',
      '1000',
    ]);
    expect(await r.cmd.run(ctx)).toBe(ExitCode.OK);
  });

  it('覆盖层损坏 → 2,不回显内容', async () => {
    const r = await rig({ overlay: 'reflect = [[[ SECRET_OVERLAY_TEXT' });
    const { ctx, err, out } = ctxFor(r.w, []);
    expect(await r.cmd.run(ctx)).toBe(ExitCode.USAGE);
    expect(err.join('') + out.join('')).not.toContain('SECRET_OVERLAY_TEXT');
  });
});

describe('reflect 命令:真跑(注入 stub 后端)', () => {
  it('暂存 report.json / proposals / rules / apply.patch;退出 0;stdout 只含计数与 id', async () => {
    const r = await rig({
      overlay: overlayToml(
        `egress = true\nteam_project_keys = ["${projectKey('A')}", "${projectKey('B')}"]`,
      ),
    });
    const { ctx, out, err } = ctxFor(r.w, [...LIVE, '--json']);
    expect(await r.cmd.run(ctx)).toBe(ExitCode.OK);
    expect(r.stub.calls).toBe(1);
    const dir = stageDir(r.w.io, RUN_ID);
    const names: string[] = [];
    const walk = async (d: string, rel: string): Promise<void> => {
      for (const e of await readDir(d)) {
        if (e.isDirectory) await walk(path.join(d, e.name), `${rel}${e.name}/`);
        else names.push(`${rel}${e.name}`);
      }
    };
    await walk(dir, '');
    expect(names.sort()).toEqual([
      'apply.patch',
      'proposals/2026-10-12-001.yaml',
      'report.json',
      'rules/team/run-lint-before-commit.md',
    ]);
    const j = JSON.parse(out.join('')) as { staged: string[]; outcome: string; mode: string };
    expect(j.outcome).toBe('staged');
    expect(j.mode).toBe('llm');
    expect(j.staged).toEqual(['2026-10-12-001']);
    const all = out.join('') + err.join('');
    for (const c of [
      CANARY_UM,
      CANARY_EXT,
      CANARY_TR,
      INJECTION,
      '提交前先跑 lint',
      'run-lint-before-commit',
    ]) {
      expect(all).not.toContain(c);
    }
    expect(err.join('')).toContain('REFLECT_EGRESS slot=glm vendor=zhipu');
    expect(await readText(path.join(dir, 'rules/team/run-lint-before-commit.md'))).toContain(
      'status: proposed',
    );
  });

  it('team_project_keys 缺省 → 跨项目聚类也判 personal(无 apply.patch);列出两个项目 → team(fail-closed 的反面对照)', async () => {
    const dflt = await rig();
    expect(await dflt.cmd.run(ctxFor(dflt.w, LIVE).ctx)).toBe(0);
    const d1 = stageDir(dflt.w.io, RUN_ID);
    expect(await exists(path.join(d1, 'rules/personal/run-lint-before-commit.md'))).toBe(true);
    expect(await exists(path.join(d1, 'rules/team'))).toBe(false);
    expect(await exists(path.join(d1, 'apply.patch'))).toBe(false);

    const onlyA = await rig({
      overlay: overlayToml(`egress = true\nteam_project_keys = ["${projectKey('A')}"]`),
    });
    expect(await onlyA.cmd.run(ctxFor(onlyA.w, LIVE).ctx)).toBe(0);
    expect(await exists(path.join(stageDir(onlyA.w.io, RUN_ID), 'rules/team'))).toBe(false);

    const both = await rig({
      overlay: overlayToml(
        `egress = true\nteam_project_keys = ["${projectKey('A')}", "${projectKey('B')}"]`,
      ),
    });
    expect(await both.cmd.run(ctxFor(both.w, LIVE).ctx)).toBe(0);
    expect(
      await exists(path.join(stageDir(both.w.io, RUN_ID), 'rules/team/run-lint-before-commit.md')),
    ).toBe(true);
  });

  it('命令层不再有补集代理:runReflect 收到的是 teamProjectKeys 白名单集合(真实 Set,可迭代)', async () => {
    const run = async (overlay: string | undefined): Promise<RunOpts> => {
      const seen: RunOpts[] = [];
      const r = await rig({
        ...(overlay !== undefined ? { overlay } : {}),
        deps: {
          runReflect: (d: RunDeps, o: RunOpts): Promise<RunResult> => {
            seen.push(o);
            return runReflect(d, o);
          },
        },
      });
      expect(await r.cmd.run(ctxFor(r.w, []).ctx)).toBe(0);
      return seen[0]!;
    };
    const dflt = await run(undefined);
    expect(dflt.teamProjectKeys).toBeInstanceOf(Set);
    expect([...dflt.teamProjectKeys!]).toEqual([]); // 缺省 = 空白名单(fail-closed),不是 undefined
    expect('personalProjectKeys' in dflt).toBe(false);
    const two = await run(
      overlayToml(
        `egress = true\nteam_project_keys = ["${projectKey('A')}", "p_unknown0000000000"]`,
      ),
    );
    expect([...two.teamProjectKeys!].sort()).toEqual(
      [projectKey('A'), 'p_unknown0000000000'].sort(),
    );
  });

  it('白名单含未知 key + 只含一个真实项目 → 仍 personal;空白名单 → personal', async () => {
    const r = await rig({
      overlay: overlayToml(
        `egress = true\nteam_project_keys = ["${projectKey('A')}", "p_unknown0000000000"]`,
      ),
    });
    expect(await r.cmd.run(ctxFor(r.w, LIVE).ctx)).toBe(0);
    const d = stageDir(r.w.io, RUN_ID);
    expect(await exists(path.join(d, 'rules/team'))).toBe(false);
    expect(await exists(path.join(d, 'rules/personal/run-lint-before-commit.md'))).toBe(true);
    const empty = await rig({ overlay: overlayToml('egress = true\nteam_project_keys = []') });
    expect(await empty.cmd.run(ctxFor(empty.w, LIVE).ctx)).toBe(0);
    expect(await exists(path.join(stageDir(empty.w.io, RUN_ID), 'rules/team'))).toBe(false);
  });

  it('预算已满 → 真跑不调用后端(摘录不白发)、不写任何文件,退出 1;预算未满时同样的运行会调用(正向对照)', async () => {
    const r = await rig({ maxLines: 1 });
    const before = await snapshot(r.w.parent);
    const { ctx, out, err } = ctxFor(r.w, [...LIVE, '--json']);
    expect(await r.cmd.run(ctx)).toBe(ExitCode.CHECK_FAILED);
    expect(r.stub.calls).toBe(0);
    expect(r.factoryCalls.n).toBe(0);
    expect(out.join('')).toBe('');
    expect(err.join('')).toContain('REFLECT_BUDGET_FULL');
    expect(await snapshot(r.w.parent)).toBe(before);
    // 干跑只报告状态
    const dry = ctxFor(r.w, ['--json']);
    expect(await r.cmd.run(dry.ctx)).toBe(ExitCode.OK);
    expect((JSON.parse(dry.out.join('')) as { budget: string }).budget).toBe('full');
    // 正向对照:预算未满的世界里真跑会调用后端
    const ok = await rig();
    expect(await ok.cmd.run(ctxFor(ok.w, LIVE).ctx)).toBe(ExitCode.OK);
    expect(ok.stub.calls).toBe(1);
  });

  it('上限优先级:命令行 > 覆盖层显式写的值 > kit.toml [reflect] > 内置默认(覆盖层 schema 的默认值不盖 kit.toml)', async () => {
    const kit = `${kitToml(100000)}\n[reflect]\nmax_calls = 2\n`;
    const limitOf = async (o: { overlay?: string; kit?: string }, argv: string[] = []) => {
      const w = await newR5World({
        overlay: o.overlay ?? EGRESS_OVERLAY,
        ...(o.kit !== undefined ? { files: { 'kit.toml': o.kit } } : {}),
      });
      const cmd = createReflectCommand({
        clock: CLOCK,
        randomHex: () => 'abc123',
        redactor: testRedactor(),
      });
      const c = ctxFor(w, ['--json', ...argv]);
      expect(await cmd.run(c.ctx)).toBe(ExitCode.OK);
      return (JSON.parse(c.out.join('')) as { calls: { limit: number } }).calls.limit;
    };
    expect(await limitOf({})).toBe(1); // 内置默认
    expect(await limitOf({ kit })).toBe(2); // kit.toml 生效(覆盖层只写了 egress)
    expect(await limitOf({ kit, overlay: overlayToml('egress = true\nmax_calls = 3') })).toBe(3); // 覆盖层显式写的值
    expect(
      await limitOf({ kit, overlay: overlayToml('egress = true\nmax_calls = 3') }, [
        '--max-calls',
        '1',
      ]),
    ).toBe(1); // 命令行
  });

  it('预算算不出来(仓库没有 kit.toml):干跑报 unknown 仍退 0;真跑 fail-closed 退 3,零调用', async () => {
    const r = await rig();
    // 换一个没有 kit.toml 的根:用 repo 之外的空目录
    const bare = await newR5World({
      overlay: EGRESS_OVERLAY,
      files: { 'kit.toml': 'not = [valid' },
    });
    const stub = new StubBackend(() => okText('{"proposals":[]}'));
    let built = 0;
    const cmd = createReflectCommand({
      clock: CLOCK,
      randomHex: () => 'abc123',
      redactor: testRedactor(),
      createBackends: () => {
        built++;
        return { glm: stub };
      },
    });
    const dry = ctxFor(bare, ['--json']);
    expect(await cmd.run(dry.ctx)).toBe(ExitCode.OK);
    expect((JSON.parse(dry.out.join('')) as { budget: string }).budget).toBe('unknown');
    const live = ctxFor(bare, LIVE);
    expect(await cmd.run(live.ctx)).toBe(ExitCode.FAIL_CLOSED);
    expect(built + stub.calls).toBe(0);
    void r;
  });

  it('后端选择:未配置任何槽位 → 4(零写入);配置多个槽位且未给 --backend → 2;--backend 选中', async () => {
    const w = await newR5World({ overlay: EGRESS_OVERLAY });
    const a = new StubBackend((req) => okText(outJson(lintDraft(req.user))), { slot: 'glm' });
    const b = new StubBackend((req) => okText(outJson(lintDraft(req.user))), {
      slot: 'kimi',
      vendor: 'moonshot',
    });
    const mk = (backends: Record<string, StubBackend>) =>
      createReflectCommand({
        clock: CLOCK,
        randomHex: () => 'abc123',
        redactor: testRedactor(),
        createBackends: () => backends,
      });
    const before = await snapshot(w.parent);
    expect(await mk({}).run(ctxFor(w, LIVE).ctx)).toBe(ExitCode.NOT_RUN);
    expect(await snapshot(w.parent)).toBe(before);
    const many = mk({ glm: a, kimi: b });
    const amb = ctxFor(w, LIVE);
    expect(await many.run(amb.ctx)).toBe(ExitCode.USAGE);
    expect(a.calls + b.calls).toBe(0);
    expect(await many.run(ctxFor(w, [...LIVE, '--backend', 'kimi']).ctx)).toBe(0);
    expect(b.calls).toBe(1);
    expect(a.calls).toBe(0);
    // 指定了未配置的槽位 → 4
    expect(await many.run(ctxFor(w, [...LIVE, '--backend', 'codex']).ctx)).toBe(ExitCode.NOT_RUN);
  });
});

describe('reflect 命令:退出码映射', () => {
  const throwing = (e: unknown) => ({
    runReflect: () => Promise.reject(e) as ReturnType<typeof runReflect>,
  });

  it.each([
    ['ReflectUsageError', new ReflectUsageError('SECRET_MSG_q1'), 2],
    ['ReflectFailClosedError', new ReflectFailClosedError('X_CODE', 'SECRET_MSG_q1'), 3],
    ['SignalStoreError', new SignalStoreError('SECRET_MSG_q1'), 3],
    ['WriteDeniedError', new WriteDeniedError('SECRET_MSG_q1'), 3],
    ['ReflectCallLimitError', new ReflectCallLimitError('SECRET_MSG_q1'), 4],
    ['未知异常', new Error('SECRET_MSG_q1'), 3],
  ])('%s → %i,stderr 只有稳定码、不带异常消息', async (_n, err, code) => {
    const r = await rig({ deps: throwing(err) });
    const c = ctxFor(r.w, []);
    expect(await r.cmd.run(c.ctx)).toBe(code);
    expect(c.err.join('') + c.out.join('')).not.toContain('SECRET_MSG_q1');
    expect(c.err.join('')).toMatch(/^REFLECT_(USAGE|NOT_RUN|FAIL_CLOSED) reason=[A-Za-z_]+\n$/);
  });

  it('runReflect 返回的 exitCode 1 / 4 原样带出', async () => {
    for (const exitCode of [1, 4] as const) {
      const real = await rig();
      const r = await rig({
        deps: {
          runReflect: async (d, o) => ({ ...(await runReflect(d, o)), exitCode }),
        },
      });
      void real;
      expect(await r.cmd.run(ctxFor(r.w, []).ctx)).toBe(exitCode);
    }
  });

  it('厂商 unknown → 3,后端零调用(正向对照:换成可证明厂商后才调用)', async () => {
    const r = await rig({ vendor: 'unknown' });
    const c = ctxFor(r.w, LIVE);
    expect(await r.cmd.run(c.ctx)).toBe(ExitCode.FAIL_CLOSED);
    expect(r.stub.calls).toBe(0);
    expect(c.err.join('')).toContain('REFLECT_FAIL_CLOSED reason=REFLECT_VENDOR_UNKNOWN');
    const ok = await rig();
    expect(await ok.cmd.run(ctxFor(ok.w, LIVE).ctx)).toBe(0);
    expect(ok.stub.calls).toBe(1);
  });

  it('批数超过 --max-calls → 4,后端零调用(放大到 3 才执行)', async () => {
    const many = Array.from({ length: 12 }, (_, i) => {
      const filler = Array.from({ length: 30 }, (_, k) =>
        String.fromCodePoint(0x4e00 + ((i * 97 + k * 31) % 20000)),
      ).join('');
      return {
        i,
        text: `以后必须先做${filler}`,
      };
    });
    const { sig } = await import('../fixtures/reflect/world.js');
    const signals = many.map((m) =>
      sig({ project: `P${m.i}`, session: `S${m.i}`, index: 0, text: m.text }),
    );
    const r = await rig({
      signals,
      respond: () => okText('{"proposals":[]}'),
      deps: { runReflect: (d, o) => runReflect(d, { ...o, evidencePerPrompt: 5 }) },
    });
    const c = ctxFor(r.w, [...LIVE, '--max-calls', '2']);
    expect(await r.cmd.run(c.ctx)).toBe(ExitCode.NOT_RUN);
    expect(r.stub.calls).toBe(0);
    expect(c.err.join('')).toContain('REFLECT_NOT_RUN reason=REFLECT_CALL_LIMIT');
    expect(await r.cmd.run(ctxFor(r.w, [...LIVE, '--max-calls', '3']).ctx)).toBe(ExitCode.OK);
    expect(r.stub.calls).toBe(3);
  });

  it('后端报错(限流)→ 4,stderr 只有枚举;输出被拒(坏 JSON)→ 1', async () => {
    const lim = await rig({ respond: () => ({ ok: false, reason: 'rate_limited' }) });
    const c = ctxFor(lim.w, LIVE);
    expect(await lim.cmd.run(c.ctx)).toBe(ExitCode.NOT_RUN);
    expect(c.err.join('')).toContain('REFLECT_NOT_RUN reason=backend_rate_limited');
    const bad = await rig({ respond: () => okText('not json at all') });
    expect(await bad.cmd.run(ctxFor(bad.w, LIVE).ctx)).toBe(ExitCode.CHECK_FAILED);
  });

  it('注入的草案带 status:"active" 等越权字段 → 整批拒绝(退出 1),不暂存', async () => {
    const r = await rig({
      respond: (req) => okText(outJson(lintDraft(req.user, { status: 'active' }))),
    });
    expect(await r.cmd.run(ctxFor(r.w, LIVE).ctx)).toBe(ExitCode.CHECK_FAILED);
    expect(await exists(path.join(stageDir(r.w.io, RUN_ID), 'proposals'))).toBe(false);
    void draft;
  });
});
