/**
 * R20-A2 B5g:judge 的 rsi 隐私闸与即时闸(契约 R20-4.8、§20.9 第 11 条、§20.14 订正)。
 * 对着真实配置(假 HOME 里的 config.toml)/ 真实信号库 + 索引 + counts / 真实暂存区;后端是进程内假后端(不联网)。
 * 覆盖方案 §11「R20-4.8 judge」「§2.1 配置来源」「R20-5.1 拿锁」中归 B5g 的部分。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createJudgeCommand } from '../../src/commands/judge.js';
import type { JudgeCommandDeps } from '../../src/commands/judge.js';
import type { CommandContext } from '../../src/commands/types.js';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import type { JudgeHopId } from '../../src/contracts/proposal.js';
import { createIoContext } from '../../src/io/paths.js';
import type { IoContext } from '../../src/io/paths.js';
import { exists, readText } from '../../src/io/read-fs.js';
import { writeFile } from '../../src/io/safe-fs.js';
import {
  CANARY,
  RUN_ID,
  fail,
  makeStubs,
  newWork,
  redactor,
  snapshot,
  writeProposal,
} from '../judge/helpers.js';
import type { Script, Stubs, Work } from '../judge/helpers.js';
import { REPO_ROOT, makeTempDir, wideCtx } from '../helpers/tmp.js';
import {
  CFG_FAILURES,
  aliasState,
  applyCfgFailure,
  makeHome,
  makeProjectRoot,
  putJournal,
  putTaintMark,
  removeIndex,
  rsiText,
  writeCfgText,
  writeIndexAndCounts,
  writeSignals,
} from './b5g-world.js';
import type { HomeCfg } from './b5g-world.js';
import { startHolder } from './rsi-lock-world.js';
import { SALT } from '../rsi/services-fixture.js';

const SIG_HEX = CANARY.sig.slice('sig_'.length);
const KEY = CANARY.project;
const LIVE = ['--run', RUN_ID, '--run-llm', '--allow-egress'];
const DRY = ['--run', RUN_ID];
const myUid = (): number => (typeof process.getuid === 'function' ? process.getuid() : -1);

type CfgMode = 'on' | 'absent' | 'no_section' | 'disabled';

interface GW {
  w: Work;
  fx: IoContext;
  /** 假 HOME 所在目录的写 ctx(HOME 不能在 KIT_TMP 之内:KIT_TMP 不得是 HOME 的上级) */
  fxh: IoContext;
  homeDir: string;
  h: HomeCfg;
  env: Record<string, string>;
  rootA: string;
  /** 写下的所有写调用(io 写审计);`audit.length = 0` 清空 */
  audit: string[];
  exclude(): Promise<void>;
  ctx(argv: string[]): { ctx: CommandContext; out: string[]; err: string[] };
}

async function gateWorld(
  o: {
    cfg?: CfgMode;
    extra?: string;
    alias?: boolean;
    proposals?: number;
    index?: boolean;
  } = {},
): Promise<GW> {
  const w0 = await newWork('judge-gate-');
  const fx = wideCtx(w0.dir);
  const homeDir = (await makeTempDir('judge-gate-home-')).dir;
  const fxh = wideCtx(homeDir);
  const h = await makeHome(fxh, homeDir);
  const env = {
    KIT_TMP: w0.dir,
    KIT_STATE_DIR: w0.state,
    KIT_REAL_HOME_OVERRIDE: h.home,
    PATH: '/usr/bin:/bin',
  };
  const audit: string[] = [];
  const io = createIoContext({
    cwd: REPO_ROOT,
    root: w0.repo,
    env,
    writeAudit: (op, p) => void audit.push(`${op} ${p}`),
  });
  const w: Work = { ...w0, io };
  const n = o.proposals ?? 1;
  for (let i = 1; i <= n; i++) {
    await writeProposal(w, {
      id: `2026-10-12-00${i}`,
      target: i === 1 ? 'new-rule-a' : `new-rule-${String.fromCharCode(96 + i)}`,
    });
  }
  const rootA = await makeProjectRoot(fx, w0.dir, 'A');
  await writeSignals(fx, w.state, [{ hex: SIG_HEX, key: KEY }]);
  if (o.index !== false) await writeIndexAndCounts(fx, w.state, [{ key: KEY, root: rootA }]);
  const mode = o.cfg ?? 'on';
  if (mode === 'on') await writeCfgText(fxh, h, rsiText(w.repo, o.extra ?? ''));
  else if (mode === 'no_section') await writeCfgText(fxh, h, '[other]\nx = 1\n');
  else if (mode === 'disabled') await writeCfgText(fxh, h, '[rsi]\nenabled = false\n');
  if (o.alias !== false) await aliasState(fx, w.repo, w.state);
  audit.length = 0;
  return {
    w,
    fx,
    fxh,
    homeDir,
    h,
    env,
    rootA,
    audit,
    exclude: () =>
      writeCfgText(fxh, h, rsiText(w.repo, `exclude_dirs = [${JSON.stringify(rootA)}]\n`)),
    ctx(argv) {
      const out: string[] = [];
      const err: string[] = [];
      return {
        ctx: {
          argv,
          io,
          env,
          overlayPath: undefined,
          stdout: (t) => out.push(t),
          stderr: (t) => err.push(t),
        },
        out,
        err,
      };
    },
  };
}

interface Rig {
  gw: GW;
  s: Stubs;
  factory: { n: number };
  cmd: ReturnType<typeof createJudgeCommand>;
  /** 全部后端合计的 complete 次数(含「开始」、不含被闸拦下的) */
  started: () => number;
}

/** `afterCall(k)`:第 k 次(从 1 起)后端调用返回之前,在 complete 内部执行(此时闸对这次调用已放行) */
function rig(
  gw: GW,
  o: {
    scripts?: Partial<Record<JudgeHopId, Script>>;
    afterCall?: (k: number) => Promise<void>;
    onCreate?: () => Promise<void>;
    deps?: Partial<JudgeCommandDeps>;
  } = {},
): Rig {
  const s = makeStubs(o.scripts ?? {});
  let k = 0;
  for (const b of Object.values(s.byHop)) {
    const orig = b.complete.bind(b);
    b.complete = async (req) => {
      const n = ++k;
      const res = await orig(req);
      await o.afterCall?.(n);
      return res;
    };
  }
  const factory = { n: 0 };
  const cmd = createJudgeCommand({
    createBackends: async () => {
      factory.n++;
      await o.onCreate?.();
      return s.backends;
    },
    redactor,
    requireOverlayEgress: false,
    ...(o.deps ?? {}),
  });
  return { gw, s, factory, cmd, started: () => k };
}

const proposalFile = (w: Work, n = 1): string =>
  path.join(w.runDir, 'proposals', `2026-10-12-00${n}.yaml`);

describe('judge × privacyCheck(cfg_* 不是 legacy)', () => {
  for (const which of CFG_FAILURES) {
    for (const mode of ['dry', 'live'] as const) {
      it(`${which} × ${mode}:退出 3 RSI_FAIL_CLOSED reason=${which};零后端构造、零调用、零输出、零写入`, async () => {
        if (which === 'cfg_unreadable' && myUid() === 0) return;
        const gw = await gateWorld();
        const r = rig(gw);
        // 正向对照:同一世界、配置合规时,命令确实能跑(否则下面的「零」可能只是环境坏了)
        const okCtx = gw.ctx(mode === 'dry' ? DRY : LIVE);
        expect(await r.cmd.run(okCtx.ctx), okCtx.err.join('')).toBe(ExitCode.OK);
        expect(okCtx.out.join('')).toContain(mode === 'dry' ? 'planned' : 'judged');
        // 复位:换一个干净的世界再坏配置(live 已改写了提案)
        const gw2 = await gateWorld();
        const r2 = rig(gw2);
        await applyCfgFailure(gw2.fxh, gw2.h, gw2.w.repo, gw2.w.dir, which);
        gw2.audit.length = 0;
        const before = await snapshot(gw2.w.runDir);
        const c = gw2.ctx(mode === 'dry' ? DRY : LIVE);
        expect(await r2.cmd.run(c.ctx)).toBe(ExitCode.FAIL_CLOSED);
        expect(c.err.join('')).toBe(`RSI_FAIL_CLOSED reason=${which}\n`);
        expect(c.out).toEqual([]);
        expect(r2.factory.n).toBe(0);
        expect(r2.s.totalCalls()).toBe(0);
        expect(gw2.audit, '判定之前零副作用').toEqual([]);
        expect(await snapshot(gw2.w.runDir)).toEqual(before);
        expect(await exists(path.join(gw2.w.state, 'rsi', 'lock'))).toBe(false);
      });
    }
  }
});

describe('judge × legacy(没有 [rsi] / 未启用):逐字节同接线前', () => {
  for (const cfg of ['absent', 'no_section', 'disabled'] as const) {
    it(`${cfg}:闸不介入——即使 run 带 TAINTED、索引缺失也照常评审;不建 rsi/;输出与无配置世界相同`, async () => {
      const gw = await gateWorld({ cfg, alias: false, index: false });
      await putTaintMark(gw.fx, gw.w.runDir, 'purge');
      const r = rig(gw);
      const c = gw.ctx(LIVE);
      expect(await r.cmd.run(c.ctx), c.err.join('')).toBe(ExitCode.OK);
      expect(c.out.join('')).toContain('judged');
      expect(c.err.join('')).toBe('');
      expect(await exists(path.join(gw.w.state, 'rsi'))).toBe(false);
      expect(r.s.totalCalls()).toBeGreaterThan(0);

      // 对照世界:同样夹具、配置文件根本不存在 → 同样的 stdout / stderr / 退出码 / 提案变化
      const gw0 = await gateWorld({ cfg: 'absent', alias: false, index: false });
      await putTaintMark(gw0.fx, gw0.w.runDir, 'purge');
      const r0 = rig(gw0);
      const c0 = gw0.ctx(LIVE);
      expect(await r0.cmd.run(c0.ctx)).toBe(ExitCode.OK);
      expect(c.out.join('')).toBe(c0.out.join(''));
      expect(await readText(proposalFile(gw.w))).toContain('judge:');
      expect(await readText(proposalFile(gw0.w))).toContain('judge:');
    });
  }
});

describe('judge × 即时闸 #1(读暂存区、构造后端之前)', () => {
  const cases: {
    name: string;
    setup: (gw: GW) => Promise<void>;
    exit: number;
    err: string;
    world?: Parameters<typeof gateWorld>[0];
  }[] = [
    {
      name: 'X(项目被排除)',
      setup: (gw) => gw.exclude(),
      exit: 1,
      err: `RSI_RUN_TAINTED reason=exclude run_id=${RUN_ID}\n`,
    },
    {
      name: 'U(索引缺失)',
      setup: async () => undefined,
      world: { index: false },
      exit: 1,
      err: `RSI_RUN_ATTRIBUTION_UNKNOWN run_id=${RUN_ID}\n`,
    },
    {
      name: 'TAINTED 标记(reason=purge)',
      setup: (gw) => putTaintMark(gw.fx, gw.w.runDir, 'purge'),
      exit: 1,
      err: `RSI_RUN_TAINTED reason=purge run_id=${RUN_ID}\n`,
    },
    {
      name: 'purge journal 在场',
      setup: (gw) => putJournal(gw.fx, gw.w.state),
      exit: 3,
      err: 'RSI_FAIL_CLOSED reason=purge_incomplete\n',
    },
  ];
  for (const c of cases) {
    for (const mode of ['dry', 'live'] as const) {
      it(`${c.name} × ${mode}:退出 ${c.exit}、稳定码、零构造零调用零输出零写入`, async () => {
        const gw = await gateWorld(c.world);
        const r = rig(gw);
        await c.setup(gw);
        gw.audit.length = 0;
        const before = await snapshot(gw.w.runDir);
        const x = gw.ctx(mode === 'dry' ? DRY : LIVE);
        expect(await r.cmd.run(x.ctx)).toBe(c.exit);
        expect(x.err.join('')).toBe(c.err);
        expect(x.out).toEqual([]);
        expect(r.factory.n, '闸在构造后端之前').toBe(0);
        expect(r.s.totalCalls()).toBe(0);
        // B5d 预期变更:真跑在锁内先 `resumeTaint`(补完上一次中断的 taint 清理),所以「已有 TAINTED 标记、摘录还没清」的夹具在真跑下会被清空摘录
        // (标记本身保留、闸照样拦下)。其余情形(含干跑)run 目录逐字节不变。
        const completesTaint = c.name.startsWith('TAINTED') && mode === 'live';
        if (completesTaint) {
          expect(await snapshot(gw.w.runDir), '正向前提:resumeTaint 真的清了摘录').not.toEqual(
            before,
          );
          expect(await readText(proposalFile(gw.w))).not.toContain('CANARY_EXCERPT');
          expect(await exists(path.join(gw.w.runDir, 'TAINTED'))).toBe(true);
          // B5e(B5d 评审遗留 ⑤):对清理后的目录树做精确断言,而不是靠审计里「runDir 下任意写都放行」。
          // 白名单:TAINTED、report.json(逐字节不变)、proposals/*.yaml 与 rules/**/*.md(摘录清空);其余一个都不许剩
          const after = await snapshot(gw.w.runDir);
          expect(Object.keys(after).sort(), '清理后只剩白名单条目').toEqual([
            'TAINTED',
            expect.stringMatching(/^proposals\/[^/]+\.yaml$/),
            'report.json',
            expect.stringMatching(/^rules\/[^/]+\/[^/]+\.md$/),
          ]);
          expect(after['report.json'], 'report.json 不动').toBe(before['report.json']);
          for (const [rel, text] of Object.entries(after)) {
            if (rel === 'TAINTED' || rel === 'report.json') continue;
            expect(text, `${rel} 的摘录已清空`).not.toContain('CANARY_EXCERPT');
          }
          // 对照:变异前的 before 里确实有摘录(断言不是对空夹具成立)
          expect(JSON.stringify(before)).toContain('CANARY_EXCERPT');
        } else {
          expect(await snapshot(gw.w.runDir)).toEqual(before);
        }
        // 真跑只允许有锁文件的创建与删除(及上面 taint 续做对 run 目录的清理);干跑零写入
        if (mode === 'dry') expect(gw.audit).toEqual([]);
        else {
          const stray = gw.audit.filter(
            (l) =>
              !(
                l.includes(`${path.sep}rsi${path.sep}`) ||
                l.endsWith(`${path.sep}rsi`) ||
                l === `mkdirp ${gw.w.state}` || // 取锁前确保状态目录存在(幂等)
                // taint 续做对 run 目录的写:只放行白名单子树(proposals/ 与 rules/<layer>/ 下的文件级写);runDir 下其它任何写都算 stray
                (completesTaint &&
                  new RegExp(
                    `^[\\w.]+ ${gw.w.runDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(proposals|rules/[^/]+)/[^/]+$`,
                  ).test(l))
              ),
          );
          expect(stray).toEqual([]);
        }
        expect(await exists(path.join(gw.w.state, 'rsi', 'lock'))).toBe(false);
      });
    }
  }

  it('正向对照:enforce 且归属为 P(采集中)→ 干跑 / 真跑照常,输出与旧流程一致', async () => {
    const gw = await gateWorld();
    const r = rig(gw);
    const d = gw.ctx(DRY);
    expect(await r.cmd.run(d.ctx), d.err.join('')).toBe(ExitCode.OK);
    expect(d.out.join('')).toContain('planned');
    const l = gw.ctx(LIVE);
    expect(await r.cmd.run(l.ctx), l.err.join('')).toBe(ExitCode.OK);
    expect(l.out.join('')).toContain('judged');
    expect(r.s.totalCalls()).toBeGreaterThan(0);
  });

  it('另一进程持锁:退出 4 JUDGE_NOT_RUN reason=locked,零构造零调用(真实 enforce 配置,不注入 rsiConfig)', async () => {
    const gw = await gateWorld();
    const r = rig(gw);
    const holder = await startHolder(gw.w.state, gw.w.dir);
    try {
      const x = gw.ctx(LIVE);
      expect(await r.cmd.run(x.ctx)).toBe(ExitCode.NOT_RUN);
      expect(x.err.join('')).toBe('JUDGE_NOT_RUN reason=locked\n');
      expect(r.factory.n).toBe(0);
      expect(r.s.totalCalls()).toBe(0);
    } finally {
      await holder.stop();
    }
  });
});

describe('judge × 三个回调(每次现算;各有「第一次检查之后状态改变」的用例)', () => {
  it('beforeExternalCall:第一次调用返回后收紧排除 → 下一次外发前被拦(后端只被调用 1 次),不落盘不输出,退出 1', async () => {
    const allFail = Object.fromEntries(
      (['codex', 'maas-deepseek', 'glm', 'kimi', 'official-deepseek'] as const).map((h) => [
        h,
        fail('error'),
      ]),
    );
    // 正向对照:不收紧 → 整条链都会被尝试(>1 次),并写下 judge_attempts
    const gw0 = await gateWorld();
    const r0 = rig(gw0, { scripts: allFail });
    const c0 = gw0.ctx(LIVE);
    await r0.cmd.run(c0.ctx);
    expect(r0.started()).toBeGreaterThan(1);
    expect(await readText(proposalFile(gw0.w))).toContain('judge_attempts');

    const gw = await gateWorld();
    const r = rig(gw, {
      scripts: allFail,
      afterCall: async (k) => {
        if (k === 1) await gw.exclude();
      },
    });
    const before = await snapshot(gw.w.runDir);
    const c = gw.ctx(LIVE);
    expect(await r.cmd.run(c.ctx)).toBe(ExitCode.CHECK_FAILED);
    expect(r.started(), '第二次外发被闸拦下').toBe(1);
    expect(c.err.join('')).toBe(`RSI_RUN_TAINTED reason=exclude run_id=${RUN_ID}\n`);
    expect(c.out).toEqual([]);
    expect(await snapshot(gw.w.runDir)).toEqual(before);
    expect(await exists(path.join(gw.w.state, 'rsi', 'lock'))).toBe(false);
  });

  it('beforePersist:调用已放行、写盘之前收紧排除 → 提案文件逐字节不变,不输出,退出 1', async () => {
    const gw = await gateWorld();
    const r = rig(gw, {
      afterCall: async (k) => {
        if (k === 1) await gw.exclude();
      },
    });
    const before = await snapshot(gw.w.runDir);
    const c = gw.ctx(LIVE);
    expect(await r.cmd.run(c.ctx)).toBe(ExitCode.CHECK_FAILED);
    expect(r.started()).toBe(1);
    expect(await snapshot(gw.w.runDir)).toEqual(before);
    expect(c.out).toEqual([]);
    expect(c.err.join('')).toBe(`RSI_RUN_TAINTED reason=exclude run_id=${RUN_ID}\n`);
    // 对照:不收紧 → 同一世界会写下 judge 记录
    const gwOk = await gateWorld();
    const rOk = rig(gwOk);
    expect(await rOk.cmd.run(gwOk.ctx(LIVE).ctx)).toBe(ExitCode.OK);
    expect(await readText(proposalFile(gwOk.w))).toContain('judge:');
  });

  it('beforePersist:写盘之前出现 purge journal → 退出 3 purge_incomplete,提案不变', async () => {
    const gw = await gateWorld();
    const r = rig(gw, {
      afterCall: async (k) => {
        if (k === 1) await putJournal(gw.fx, gw.w.state);
      },
    });
    const before = await snapshot(gw.w.runDir);
    const c = gw.ctx(LIVE);
    expect(await r.cmd.run(c.ctx)).toBe(ExitCode.FAIL_CLOSED);
    expect(c.err.join('')).toBe('RSI_FAIL_CLOSED reason=purge_incomplete\n');
    expect(await snapshot(gw.w.runDir)).toEqual(before);
    expect(c.out).toEqual([]);
  });

  it('beforeOutput(干跑):闸 #1 之后、打印之前归属变 U → 不打印,退出 1(对照:不变则打印)', async () => {
    const gwOk = await gateWorld();
    const rOk = rig(gwOk);
    const ok = gwOk.ctx(DRY);
    expect(await rOk.cmd.run(ok.ctx)).toBe(ExitCode.OK);
    expect(ok.out.join('')).toContain('planned');

    const gw = await gateWorld();
    const r = rig(gw, { onCreate: () => removeIndex(gw.fx, gw.w.state) });
    const c = gw.ctx(DRY);
    expect(await r.cmd.run(c.ctx)).toBe(ExitCode.CHECK_FAILED);
    expect(c.out).toEqual([]);
    expect(c.err.join('')).toBe(`RSI_RUN_ATTRIBUTION_UNKNOWN run_id=${RUN_ID}\n`);
    expect(r.factory.n).toBe(1); // 闸 #1 放行了(构造后端发生在它之后)
  });

  it('beforeOutput(异常分支):准备打印部分结果时变 U → 不打印部分结果,退出 1;已写下的记录不撤销', async () => {
    const mk = async (
      flip: boolean,
    ): Promise<{ gw: GW; r: Rig; c: ReturnType<GW['ctx']>; code: number }> => {
      const gw = await gateWorld({ proposals: 2 });
      // B5d:有盐,judge 之后才会刷新 counts.staged(盐缺失时跳过);盐指纹与夹具 counts / 索引一致
      await writeFile(gw.fx, path.join(gw.w.state, 'salt'), SALT, { mode: 0o600 });
      const r = rig(gw, {
        afterCall: async (k) => {
          if (k !== 2) return;
          // 第二个提案的文件在评审期间被改动 → writeProposal 在任何写之前就抛(没有 beforePersist 可拦)
          await writeFile(
            gw.fx,
            proposalFile(gw.w, 2),
            `${await readText(proposalFile(gw.w, 2))}# touched\n`,
            { mode: 0o600 },
          );
          if (flip) await removeIndex(gw.fx, gw.w.state);
        },
      });
      const c = gw.ctx(LIVE);
      return { gw, r, c, code: await r.cmd.run(c.ctx) };
    };
    // 对照:不变 U → 部分结果(第一个提案)会被打印,且报 JUDGE_FAIL_CLOSED
    const ok = await mk(false);
    expect(ok.code).toBe(ExitCode.FAIL_CLOSED);
    expect(ok.c.out.join('')).toContain('2026-10-12-001');
    expect(ok.c.err.join('')).toContain('JUDGE_FAIL_CLOSED');

    const g = await mk(true);
    expect(g.r.started()).toBe(2);
    expect(g.code).toBe(ExitCode.CHECK_FAILED); // 闸的 1;已有结果(第一个提案 judged accept = 0)经 combineExitCodes 合并
    expect(g.c.out).toEqual([]);
    expect(g.c.err.join('')).toBe(`RSI_RUN_ATTRIBUTION_UNKNOWN run_id=${RUN_ID}\n`);
    // 第一个提案已经写下 judge 记录:不撤销
    expect(await readText(proposalFile(g.gw.w, 1))).toContain('judge:');
    // B5d:闸停之后不再写 rsi 投影(先判闸、再 settle);对照:没有闸停时同一路径会刷新 counts(generation 1 → 2)
    const gen = async (w: Work): Promise<number> =>
      (
        JSON.parse(await readText(path.join(w.state, 'rsi', 'counts.json'))) as {
          generation: number;
        }
      ).generation;
    expect(await gen(ok.gw.w)).toBe(2);
    expect(await gen(g.gw.w)).toBe(1);
  });
});

describe('judge × 配置来源一致性(§2.1;privacyCheck 用 {env},即时闸用 io.hostEnv.HOME)', () => {
  /** 命令侧(ctx.env)读 S、闸侧(io.hostEnv.HOME)读 L:两份配置各自指向不同的 config.toml */
  async function split(
    s: { exclude: boolean },
    l: { exclude: boolean },
  ): Promise<{ run: () => Promise<{ code: number; err: string; out: string }> }> {
    const gw = await gateWorld({ cfg: 'absent' });
    const hS = await makeHome(gw.fxh, gw.homeDir, 'home-s');
    const hL = await makeHome(gw.fxh, gw.homeDir, 'home-l');
    const ex = `exclude_dirs = [${JSON.stringify(gw.rootA)}]\n`;
    await writeCfgText(gw.fxh, hS, rsiText(gw.w.repo, s.exclude ? ex : ''));
    await writeCfgText(gw.fxh, hL, rsiText(gw.w.repo, l.exclude ? ex : ''));
    const base = { KIT_TMP: gw.w.dir, KIT_STATE_DIR: gw.w.state, PATH: '/usr/bin:/bin' };
    const io = createIoContext({
      cwd: REPO_ROOT,
      root: gw.w.repo,
      env: { ...base, KIT_REAL_HOME_OVERRIDE: hL.home },
    });
    const r = rig(gw);
    return {
      run: async () => {
        const out: string[] = [];
        const err: string[] = [];
        const ctx: CommandContext = {
          argv: DRY,
          io,
          env: { ...base, KIT_REAL_HOME_OVERRIDE: hS.home },
          overlayPath: undefined,
          stdout: (t) => out.push(t),
          stderr: (t) => err.push(t),
        };
        const code = await r.cmd.run(ctx);
        return { code, err: err.join(''), out: out.join('') };
      },
    };
  }

  it('前提:S、L 单独使用时结论确实不同(S 排除 A → tainted;L 不排除 → 放行)', async () => {
    const onlyS = await split({ exclude: true }, { exclude: true });
    expect((await onlyS.run()).code).toBe(ExitCode.CHECK_FAILED);
    const onlyL = await split({ exclude: false }, { exclude: false });
    expect((await onlyL.run()).code).toBe(ExitCode.OK);
  });

  // 接线层把即时闸用的 io 的 HOME 钉成 privacyCheck 读配置用的那个 home(gateIoOf):命令侧(ctx.env)是唯一来源。
  it('方向 1:命令侧读严格的 S、闸侧(io)读宽松的 L → 按 S 拒绝(闸不因读到宽松的 L 而放行)', async () => {
    const t = await split({ exclude: true }, { exclude: false });
    const r = await t.run();
    expect(r.out).toBe('');
    expect(r.err).toBe(`RSI_RUN_TAINTED reason=exclude run_id=${RUN_ID}\n`);
    expect(r.code).toBe(ExitCode.CHECK_FAILED);
  });

  it('方向 2:命令侧读宽松的 S、io 指向严格的 L → 同样只认命令侧的 S(放行;L 不参与)', async () => {
    const t = await split({ exclude: false }, { exclude: true });
    const r = await t.run();
    expect(r.code).toBe(ExitCode.OK);
    expect(r.out).toContain('planned');
  });

  it('状态目录 / HOME 来源:KIT_REAL_HOME_OVERRIDE 与 HOME 指向不同目录、各放一份 config → 只读覆盖那份(真实 HOME 的配置不参与)', async () => {
    const gw = await gateWorld({ cfg: 'absent' });
    const hReal = await makeHome(gw.fxh, gw.homeDir, 'home-real');
    await writeCfgText(gw.fxh, hReal, rsiText(gw.w.repo)); // 「HOME」那份:不排除
    await gw.exclude(); // 覆盖目录那份:排除
    const env = { ...gw.env, HOME: hReal.home };
    const io = createIoContext({ cwd: REPO_ROOT, root: gw.w.repo, env });
    const r = rig(gw);
    const out: string[] = [];
    const err: string[] = [];
    const ctx: CommandContext = {
      argv: DRY,
      io,
      env,
      overlayPath: undefined,
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
    };
    expect(await r.cmd.run(ctx)).toBe(ExitCode.CHECK_FAILED);
    expect(err.join('')).toBe(`RSI_RUN_TAINTED reason=exclude run_id=${RUN_ID}\n`);
  });

  it('状态目录:独立状态树(无 .state 别名,锁闸门 off)→ 不拿锁但照样 enforce:闸读的是命令自己的状态目录(KIT_STATE_DIR)里的索引', async () => {
    const gw = await gateWorld({ alias: false });
    await gw.exclude();
    const r = rig(gw);
    const c = gw.ctx(LIVE);
    expect(await r.cmd.run(c.ctx)).toBe(ExitCode.CHECK_FAILED);
    expect(c.err.join('')).toBe(`RSI_RUN_TAINTED reason=exclude run_id=${RUN_ID}\n`);
    expect(r.factory.n).toBe(0);
    expect(await exists(path.join(gw.w.state, 'rsi', 'lock'))).toBe(false); // 没拿锁
    // 读不到 rsi 的索引 → U → 拒绝(Q-M,fail-closed)
    const gw2 = await gateWorld({ alias: false, index: false });
    const r2 = rig(gw2);
    const c2 = gw2.ctx(LIVE);
    expect(await r2.cmd.run(c2.ctx)).toBe(ExitCode.CHECK_FAILED);
    expect(c2.err.join('')).toBe(`RSI_RUN_ATTRIBUTION_UNKNOWN run_id=${RUN_ID}\n`);
    expect(r2.s.totalCalls()).toBe(0);
    // 对照:同一独立状态树、索引在且为 P → 照常评审(不是一律拒绝)
    const gw3 = await gateWorld({ alias: false });
    const r3 = rig(gw3);
    expect(await r3.cmd.run(gw3.ctx(LIVE).ctx)).toBe(ExitCode.OK);
    expect(r3.s.totalCalls()).toBeGreaterThan(0);
  });
});

describe('judge × 闸停与失锁同时发生:失锁(3)不被闸的 1 压掉', () => {
  const tamperLock = (gw: GW): Promise<void> =>
    writeFile(
      gw.fx,
      path.join(gw.w.state, 'rsi', 'lock'),
      JSON.stringify({
        pid: 1,
        started_at: new Date().toISOString(),
        nonce: 'f'.repeat(16),
        kit_version: '0.1.0',
      }),
      { mode: 0o600 },
    );

  it('正常返回路径:调用中途收紧排除并换掉锁 → 退出 3 RSI_FAIL_CLOSED reason=lock_lost,不输出', async () => {
    const gw = await gateWorld();
    const r = rig(gw, {
      afterCall: async (k) => {
        if (k !== 1) return;
        await gw.exclude();
        await tamperLock(gw);
      },
    });
    const c = gw.ctx(LIVE);
    expect(await r.cmd.run(c.ctx)).toBe(ExitCode.FAIL_CLOSED);
    expect(c.err.join('')).toBe('RSI_FAIL_CLOSED reason=lock_lost\n');
    expect(c.out).toEqual([]);
    // 正向前提:只收紧排除(不换锁)时报闸的 1
    const gw1 = await gateWorld();
    const r1 = rig(gw1, { afterCall: async (k) => void (k === 1 && (await gw1.exclude())) });
    const c1 = gw1.ctx(LIVE);
    expect(await r1.cmd.run(c1.ctx)).toBe(ExitCode.CHECK_FAILED);
  });

  it('异常分支路径:第二个提案被改动(抛错)+ 变 U + 换掉锁 → 退出 3 lock_lost,不打印部分结果', async () => {
    const gw = await gateWorld({ proposals: 2 });
    const r = rig(gw, {
      afterCall: async (k) => {
        if (k !== 2) return;
        await writeFile(
          gw.fx,
          proposalFile(gw.w, 2),
          `${await readText(proposalFile(gw.w, 2))}# touched\n`,
          {
            mode: 0o600,
          },
        );
        await removeIndex(gw.fx, gw.w.state);
        await tamperLock(gw);
      },
    });
    const c = gw.ctx(LIVE);
    expect(await r.cmd.run(c.ctx)).toBe(ExitCode.FAIL_CLOSED);
    expect(c.err.join('')).toBe('RSI_FAIL_CLOSED reason=lock_lost\n');
    expect(c.out).toEqual([]);
  });
});
