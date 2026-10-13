import { describe, expect, it } from 'vitest';
import { command, createJudgeCommand } from '../../src/commands/judge.js';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { readText } from '../../src/io/read-fs.js';
import { writeFile } from '../../src/io/safe-fs.js';
import {
  RUN_ID,
  cmdCtx,
  fail,
  makeStubs,
  newWork,
  okWith,
  outputText,
  redactor,
  snapshot,
  StubBackend,
  writeProposal,
} from '../judge/helpers.js';
import type { Stubs } from '../judge/helpers.js';

const make = (s: Stubs) =>
  createJudgeCommand({
    createBackends: () => s.backends,
    redactor,
    requireOverlayEgress: false,
  });
const LIVE = ['--run', RUN_ID, '--run-llm', '--allow-egress'];

describe('judge 命令:用法与干跑', () => {
  it('默认干跑:退出 0,零调用零写入,打印每跳计划', async () => {
    const w = await newWork();
    await writeProposal(w);
    const before = await snapshot(w.runDir);
    const s = makeStubs();
    const { ctx, out } = cmdCtx(w, ['--run', RUN_ID]);
    expect(await make(s).run(ctx)).toBe(ExitCode.OK);
    expect(s.totalCalls()).toBe(0);
    expect(await snapshot(w.runDir)).toEqual(before);
    const j = JSON.parse(out.join('')) as { dry: boolean; proposals: { status: string }[] };
    expect(j.dry).toBe(true);
    expect(j.proposals[0]!.status).toBe('planned');
  });

  it('--run-llm 缺 --allow-egress → 退出 2,零调用零写入(正向对照:补上后才执行)', async () => {
    const w = await newWork();
    await writeProposal(w);
    const before = await snapshot(w.runDir);
    const s = makeStubs();
    const { ctx, err } = cmdCtx(w, ['--run', RUN_ID, '--run-llm']);
    expect(await make(s).run(ctx)).toBe(ExitCode.USAGE);
    expect(err.join('')).toContain('--allow-egress');
    expect(s.totalCalls()).toBe(0);
    expect(await snapshot(w.runDir)).toEqual(before);

    const c2 = cmdCtx(w, LIVE);
    expect(await make(s).run(c2.ctx)).toBe(ExitCode.OK);
    expect(s.totalCalls()).toBe(1);
  });

  it.each([
    [[]],
    [['--run']],
    [['--run', 'bad id with spaces']],
    [['--run', RUN_ID, '--bogus']],
    [['--run', RUN_ID, '--max-calls', '0']],
    [['--run', RUN_ID, '--max-calls', '1e3']],
    [['--run', RUN_ID, '--max-calls', '101']],
  ])('用法错 %j → 2', async (argv) => {
    const w = await newWork();
    await writeProposal(w);
    const { ctx } = cmdCtx(w, argv as string[]);
    expect(await make(makeStubs()).run(ctx)).toBe(ExitCode.USAGE);
  });

  it('run 不存在 → 2', async () => {
    const w = await newWork();
    const { ctx } = cmdCtx(w, ['--run', 'nope']);
    expect(await make(makeStubs()).run(ctx)).toBe(ExitCode.USAGE);
  });

  it('默认 command(R5 接线):覆盖层未同意外发 → 真跑 2(零写入);干跑 → 0 且不构造后端', async () => {
    const w = await newWork();
    await writeProposal(w);
    const before = await snapshot(w.runDir);
    const live = cmdCtx(w, LIVE);
    expect(await command.run(live.ctx)).toBe(ExitCode.USAGE);
    expect(live.err.join('')).toContain('reflect.egress');
    expect(await snapshot(w.runDir)).toEqual(before);
    const dry = cmdCtx(w, ['--run', RUN_ID]);
    expect(await command.run(dry.ctx)).toBe(ExitCode.OK);
    expect(await snapshot(w.runDir)).toEqual(before);
  });
});

describe('judge 命令:退出码', () => {
  const allFail = (reason: Parameters<typeof fail>[0]) => ({
    codex: fail(reason),
    'maas-deepseek': fail(reason),
    glm: fail(reason),
    kimi: fail(reason),
    'official-deepseek': fail(reason),
  });

  it('accept → 0;reject → 1;injection_suspected → 1(都不改提案状态)', async () => {
    for (const [over, code] of [
      [{}, 0],
      [{ verdict: 'reject' }, 1],
      [{ verdict: 'revise' }, 0],
      [{ injection_suspected: true }, 1],
    ] as const) {
      const w = await newWork();
      await writeProposal(w);
      const s = makeStubs({ codex: okWith(outputText(over)) });
      const { ctx } = cmdCtx(w, LIVE);
      expect(await make(s).run(ctx)).toBe(code);
    }
  });

  it('重跑时已有的 reject 仍计入退出码(不会因为“已评审”变成 0)', async () => {
    const w = await newWork();
    await writeProposal(w);
    const s = makeStubs({ codex: okWith(outputText({ verdict: 'reject' })) });
    expect(await make(s).run(cmdCtx(w, LIVE).ctx)).toBe(1);
    expect(await make(s).run(cmdCtx(w, LIVE).ctx)).toBe(1);
    expect(s.totalCalls()).toBe(1);
  });

  it('pending:cooldown → 4;all_failed 纯后端故障 → 4;含输出校验失败 → 1;no_cross_vendor → 0', async () => {
    let w = await newWork();
    await writeProposal(w);
    expect(await make(makeStubs(allFail('rate_limited'))).run(cmdCtx(w, LIVE).ctx)).toBe(4);

    w = await newWork();
    await writeProposal(w);
    expect(await make(makeStubs(allFail('error'))).run(cmdCtx(w, LIVE).ctx)).toBe(4);

    w = await newWork();
    await writeProposal(w);
    const bad = okWith('not json');
    const c = cmdCtx(w, LIVE);
    expect(
      await make(
        makeStubs({
          codex: bad,
          'maas-deepseek': bad,
          glm: bad,
          kimi: bad,
          'official-deepseek': bad,
        }),
      ).run(c.ctx),
    ).toBe(1);

    w = await newWork();
    await writeProposal(w, {
      reflectorVendor: 'deepseek',
      reflectorBackend: 'pi',
      reflectorModel: 'deepseek-r',
    });
    const same = makeStubs({}, ['maas-deepseek', 'official-deepseek']);
    const c2 = cmdCtx(w, LIVE);
    expect(await make(same).run(c2.ctx)).toBe(0);
    expect(c2.err.join('')).toContain(
      'JUDGE_PENDING proposal=2026-10-12-001 reason=no_cross_vendor',
    );
    const j = JSON.parse(c2.out.join('')) as { proposals: { judge_pending: string }[] };
    expect(j.proposals[0]!.judge_pending).toBe('no_cross_vendor');
  });

  it('已配置的后端厂商全部不可证明 → 3(配置问题,不伪装成 no_cross_vendor 的 0)', async () => {
    const w = await newWork();
    await writeProposal(w);
    const bad = new StubBackend('codex', 'unknown', 'mystery');
    const cmd = createJudgeCommand({
      createBackends: () => ({ codex: bad }),
      redactor,
      requireOverlayEgress: false,
    });
    expect(await cmd.run(cmdCtx(w, LIVE).ctx)).toBe(ExitCode.FAIL_CLOSED);
    expect(bad.calls).toHaveLength(0);
    expect(await cmd.run(cmdCtx(w, ['--run', RUN_ID]).ctx)).toBe(ExitCode.FAIL_CLOSED); // 干跑同判
  });

  it('超过 --max-calls → 4,调用数不超上限', async () => {
    const w = await newWork();
    await writeProposal(w);
    const s = makeStubs(allFail('error'));
    const { ctx } = cmdCtx(w, [...LIVE, '--max-calls', '2']);
    expect(await make(s).run(ctx)).toBe(ExitCode.NOT_RUN);
    expect(s.totalCalls()).toBe(2);
  });

  it('状态损坏 / 复扫残留 / 厂商 unknown / provider 不符 → 3,零调用', async () => {
    const stubs = makeStubs();
    const cases: [string, (w: Awaited<ReturnType<typeof newWork>>) => Promise<void>][] = [
      [
        '坏 yaml',
        async (w) => {
          const f = await writeProposal(w);
          await writeFile(w.io, f, 'id: [x\n');
        },
      ],
      [
        '厂商 unknown',
        async (w) => {
          await writeProposal(w, { reflectorVendor: 'unknown' });
        },
      ],
      [
        '复扫残留',
        async (w) => {
          await writeProposal(w, { excerpts: [`sk-${'a1'.repeat(22)}`] });
        },
      ],
    ];
    for (const [, setup] of cases) {
      const w = await newWork();
      await setup(w);
      const { ctx, err } = cmdCtx(w, LIVE);
      expect(await make(stubs).run(ctx)).toBe(ExitCode.FAIL_CLOSED);
      expect(err.join('')).toContain('JUDGE_FAIL_CLOSED');
    }
    expect(stubs.totalCalls()).toBe(0);
    // provider 不符
    const w = await newWork();
    await writeProposal(w);
    const wrong = makeStubs();
    const cmd = createJudgeCommand({
      createBackends: () => ({
        ...wrong.backends,
        codex: {
          ...wrong.byHop.codex,
          slot: 'glm',
          complete: wrong.byHop.codex.complete.bind(wrong.byHop.codex),
        },
      }),
      redactor,
      requireOverlayEgress: false,
    });
    expect(await cmd.run(cmdCtx(w, LIVE).ctx)).toBe(ExitCode.FAIL_CLOSED);
    expect(wrong.totalCalls()).toBe(0);
  });

  it('stdout 摘要不含评审 notes 与提案文本;stderr 只有稳定码', async () => {
    const w = await newWork();
    await writeProposal(w);
    const s = makeStubs({
      codex: okWith(outputText({ notes: 'NOTES_CANARY_q7', injection_suspected: true })),
    });
    const { ctx, out, err } = cmdCtx(w, LIVE);
    await make(s).run(ctx);
    expect(out.join('') + err.join('')).not.toContain('NOTES_CANARY_q7');
    expect(out.join('')).toContain('"injection_suspected": true'); // 正向对照:摘要里有该字段
    expect(err.join('')).toContain('JUDGE_INJECTION_SUSPECTED');
    expect(await readText(`${w.runDir}/proposals/2026-10-12-001.yaml`)).toContain(
      'injection_suspected: true',
    );
  });
});
