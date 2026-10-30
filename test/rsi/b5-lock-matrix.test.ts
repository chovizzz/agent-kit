/**
 * R20-A2 B5e:子进程持锁 × B5 的每个写入命令(契约 §20.5 R20-5.1;方案 §11 第一行)。
 *
 * 持锁方是**真子进程**(test/rsi/proc/child-entry.ts 的 `hold`,经 `startHolder`;握手 = 它打印的第一行,不靠 sleep);被测命令走真实 `main()` 分发器
 * (reflect / judge --run-llm 例外:它们的后端要由工厂注入,走各自的命令工厂 + 与 reflect-rsi-lock / judge-rsi-lock 同样的世界)。
 * 每个入口一行,逐项断言:
 *   ① 退出码与稳定码(`RSI_NOT_RUN` / `SIGNALS_NOT_RUN` / `PROMOTE_NOT_RUN` / `REFLECT_NOT_RUN` / `JUDGE_NOT_RUN` `reason=locked`,退 4),stdout 为空;
 *   ② 零写入:`.state` 树前后一致(持锁方已建好 `rsi/lock`),锁文件逐字节不变且 inode 未变(没有「删掉重建同内容」),
 *      写审计里只有对锁文件的 createExclusive 试探(失败)与对 `.state/`、`.state/rsi/` 的 mkdirp;
 *   ③ 零调用(reflect / judge:后端构造 0 次、LLM 调用 0 次);
 *   ④ 正向对照(同一世界、放锁后同一命令):退出码 / 输出是该入口**精确的**业务结果,且写了数据(不是「因为别的原因没写」)。
 * 反向:未启用 `[rsi]`(无配置 / enabled=false)时,命令不建 `.state/rsi/`(legacy 写入方行为与接线前一致;rsi 自己的入口 4 `off`)。
 * 变异(逐个删掉拿锁、闸门恒真 / 恒假)由 test/rsi/b5-mutation-table.ts 登记并经 cp 备份 / cp 还原在 javis 上跑过;本文件是它们的杀手用例。
 * 范围声明:worker × 各命令的并发组合归 A3;本文件只证明前台入口服从共享锁,不代表真实 worker 的整个持锁生命周期已验收。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../../src/cli.js';
import { createJudgeCommand } from '../../src/commands/judge.js';
import { createReflectCommand } from '../../src/commands/reflect.js';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { exists, lstat, readBytes } from '../../src/io/read-fs.js';
import { remove, writeFile } from '../../src/io/safe-fs.js';
import type { RsiConfig } from '../../src/rsi/config.js';
import { withWriteAudit } from '../helpers/write-audit.js';
import { genClaude } from '../fixtures/sessions/gen-claude.js';
import {
  StubBackend,
  lintDraft,
  okText,
  out as outJson,
  testRedactor,
} from '../fixtures/reflect/world.js';
import { EGRESS_OVERLAY, ctxFor, newR5World } from '../commands/r5-world.js';
import {
  aliasRsiState,
  onConfig,
  startHolder,
  writePurgeJournal,
} from '../commands/rsi-lock-world.js';
import { RUN_ID, cmdCtx, makeStubs, newWork, writeProposal } from '../judge/helpers.js';
import { redactor as judgeRedactor } from '../judge/helpers.js';
import { cmdFxOf, makeTickFx } from './b5a-fixture.js';
import { makeSc } from './b5c-fixture.js';
import { treeOf, writeCfg } from './rsi-fixture.js';
import { makeRoot, makeSvc } from './services-fixture.js';

interface At {
  env: Record<string, string>;
  /** 命令的 cwd(= `[rsi] repo`,里面有 kit.toml,所以通用 IoContext 的状态目录 = `<repo>/.state` = rsi 的状态树) */
  cwd: string;
}
interface Ran {
  code: number;
  out: string;
  err: string;
  audit: { op: string; path: string }[];
}

async function runAt(
  w: At,
  argv: string[],
  over: { isTty?: boolean; line?: string } = {},
): Promise<Ran> {
  const a = withWriteAudit();
  let out = '';
  let err = '';
  const code = await main(argv, {
    env: w.env,
    cwd: w.cwd,
    writeAudit: a.hook,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    ...(over.isTty !== undefined ? { isTty: over.isTty } : {}),
    ...(over.line !== undefined ? { readLine: async () => over.line } : {}),
  });
  return { code, out, err, audit: a.calls };
}

const LOCKED = (prefix: string): string => `${prefix}_NOT_RUN reason=locked\n`;

/** 持锁拒绝时,写审计里只允许对锁文件的 createExclusive 试探与对 `.state/`、`.state/rsi/` 的 mkdirp */
function onlyLockAttempt(audit: readonly { op: string; path: string }[], stateDir: string): void {
  for (const c of audit) {
    if (c.op === 'mkdirp') {
      expect([stateDir, path.join(stateDir, 'rsi')], `mkdirp ${c.path}`).toContain(c.path);
    } else {
      expect([c.op, c.path], '除锁试探外的写调用').toEqual([
        'createExclusive',
        path.join(stateDir, 'rsi', 'lock'),
      ]);
    }
  }
}

interface Locked {
  /** 退出码 / stderr / stdout */
  code: number;
  err: string;
  out: string;
  audit: readonly { op: string; path: string }[];
}

/** 公共的「持锁时」断言:退 4 + 稳定码 + stdout 空 + 零写入 + 锁文件不变 */
async function assertRefused(
  stateDir: string,
  prefix: string,
  run: () => Promise<Locked>,
  opts: { outEmpty?: boolean } = {},
): Promise<void> {
  const lock = path.join(stateDir, 'rsi', 'lock');
  const lockBytes = await readBytes(lock);
  const lockIno = (await lstat(lock)).ino;
  const before = await treeOf(stateDir);
  const r = await run();
  expect([r.code, r.err], `${prefix} 持锁`).toEqual([ExitCode.NOT_RUN, LOCKED(prefix)]);
  if (opts.outEmpty === false) {
    // confirm:拿锁在展示清单与读到 yes 之后,所以 stdout 有清单;但绝不能有成功标记
    expect(r.out, '清单已展示(正向前提)').toContain('projects collecting=');
    expect(r.out).not.toContain('confirm ok');
  } else expect(r.out, '被拒绝的路径 stdout 为空').toBe('');
  expect(await treeOf(stateDir), '② .state 树前后一致').toEqual(before);
  expect(await readBytes(lock), '锁文件字节不变').toEqual(lockBytes);
  expect((await lstat(lock)).ino, '锁文件 inode 不变(不是删掉重建)').toBe(lockIno);
  onlyLockAttempt(r.audit, stateDir);
  // 正向前提:审计钩子确实接在命令上(锁试探那一次 createExclusive 必须被记到)——否则上面「只有锁试探」对空数组恒成立
  expect(
    r.audit.some((c) => c.op === 'createExclusive' && c.path === lock),
    `${prefix}:写审计钩子没接上(没记到锁试探)`,
  ).toBe(true);
}

// ---------------------------------------------------------------------------
// 经 main() 的入口
// ---------------------------------------------------------------------------
interface MainEntry {
  id: string;
  prefix: string;
  /** 造一个「走得到拿锁点」的世界 */
  mk(): Promise<{ at: At; stateDir: string; tmp: string }>;
  argv(at: At): string[];
  tty?: { line?: string };
  /** confirm 在拿锁之前就展示了清单,所以持锁拒绝时 stdout 不为空 */
  outEmpty?: false;
  /** 放锁后同一命令的精确业务结果 */
  after: { code: number; err?: string; outEnds?: string; outHas?: string; writesData: boolean };
}

const KEYED = { PATH: '/usr/bin:/bin' };

async function collectWorld(): Promise<{
  at: At;
  stateDir: string;
  tmp: string;
  argv: string[];
  cfg: string;
  fx: Awaited<ReturnType<typeof makeSvc>>['f']['fx'];
}> {
  const s = await makeSvc('b5e-lm-col-', { salt: false });
  const projA = await makeRoot(s, 'A');
  const sessions = path.join(s.f.dir, 'sessions');
  await genClaude(s.f.fx, {
    root: sessions,
    cwd: projA,
    id: 's1',
    userTexts: ['你好,帮我看看这个'],
    toolCalls: 2,
    failedResults: 1,
    version: '2.1.294',
  });
  return {
    at: { env: { KIT_TMP: s.f.repo, KIT_REAL_HOME_OVERRIDE: s.f.home, ...KEYED }, cwd: s.f.repo },
    stateDir: s.state,
    tmp: s.f.dir,
    cfg: s.f.cfgFile,
    fx: s.f.fx,
    argv: [
      'signals',
      'collect',
      '--source',
      sessions,
      '--agent',
      'claude',
      '--timeout-ms',
      '5000',
      '--allow-project',
      projA,
    ],
  };
}

const MAIN_ENTRIES: MainEntry[] = [
  {
    id: 'tick --write',
    prefix: 'RSI',
    mk: async () => {
      const f = await makeTickFx('lm-tick-', {});
      return { at: { env: f.env, cwd: f.repo }, stateDir: f.io.stateDir, tmp: f.dir };
    },
    argv: () => ['rsi', 'tick', '--write'],
    after: { code: 0, writesData: true },
  },
  {
    id: 'confirm',
    prefix: 'RSI',
    mk: async () => {
      const f = await makeTickFx('lm-confirm-', {});
      return { at: { env: f.env, cwd: f.repo }, stateDir: f.io.stateDir, tmp: f.dir };
    },
    argv: () => ['rsi', 'confirm'],
    tty: { line: 'yes' },
    outEmpty: false,
    after: { code: 0, outEnds: 'confirm ok\n', writesData: true },
  },
  {
    id: 'status --ack',
    prefix: 'RSI',
    mk: async () => {
      const sc = await makeSc('lm-ack-', { state: 'confirmed' });
      return {
        at: { env: cmdFxOf(sc.s).env, cwd: sc.s.f.repo },
        stateDir: sc.s.state,
        tmp: sc.s.f.dir,
      };
    },
    argv: () => ['rsi', 'status', '--ack'],
    tty: {},
    after: { code: 0, outHas: 'ack generation=', writesData: true },
  },
  {
    id: 'purge --excluded --write',
    prefix: 'RSI',
    mk: async () => {
      const sc = await makeSc('lm-purge-', { state: 'confirmed' });
      return {
        at: { env: cmdFxOf(sc.s).env, cwd: sc.s.f.repo },
        stateDir: sc.s.state,
        tmp: sc.s.f.dir,
      };
    },
    argv: () => ['rsi', 'purge', '--excluded', '--write'],
    tty: {},
    after: { code: 0, writesData: true },
  },
  {
    id: 'purge --resume --write',
    prefix: 'RSI',
    mk: async () => {
      const sc = await makeSc('lm-purge-resume-', { state: 'confirmed' });
      await writePurgeJournal(sc.s.io, sc.s.state); // 合规 journal:新 purge 会被拒,--resume 才走到拿锁
      return {
        at: { env: cmdFxOf(sc.s).env, cwd: sc.s.f.repo },
        stateDir: sc.s.state,
        tmp: sc.s.f.dir,
      };
    },
    argv: () => ['rsi', 'purge', '--resume', '--write'],
    tty: {},
    after: { code: 0, writesData: true },
  },
  {
    id: 'projects --rebuild-index --write',
    prefix: 'RSI',
    mk: async () => {
      const sc = await makeSc('lm-rebuild-', { state: 'confirmed' });
      return {
        at: { env: cmdFxOf(sc.s).env, cwd: sc.s.f.repo },
        stateDir: sc.s.state,
        tmp: sc.s.f.dir,
      };
    },
    argv: () => ['rsi', 'projects', '--rebuild-index', '--write'],
    after: { code: 0, writesData: true },
  },
  {
    id: 'reflect --gc --write',
    prefix: 'REFLECT',
    mk: async () => {
      const sc = await makeSc('lm-gc-', { state: 'confirmed' });
      return {
        at: { env: cmdFxOf(sc.s).env, cwd: sc.s.f.repo },
        stateDir: sc.s.state,
        tmp: sc.s.f.dir,
      };
    },
    argv: () => ['reflect', '--gc', '--write'],
    after: { code: 0, outHas: 'reflect gc: mode=write', writesData: false },
  },
  {
    id: 'promote --run --write',
    prefix: 'PROMOTE',
    mk: async () => {
      const sc = await makeSc('lm-promote-', { state: 'confirmed' });
      return {
        at: { env: cmdFxOf(sc.s).env, cwd: sc.s.f.repo },
        stateDir: sc.s.state,
        tmp: sc.s.f.dir,
      };
    },
    argv: () => ['promote', '--run', 'run-ok', '--write'],
    // 放锁后走到 planAdoption:夹具里的 run 不是完整的可采纳 run,所以是业务失败(不是 4、不是 locked)。精确码见断言
    after: { code: ExitCode.CHECK_FAILED, writesData: false },
  },
];

describe('R20-5.1 真子进程持锁 × 每个写入命令(经 main())', () => {
  for (const e of MAIN_ENTRIES) {
    it(`${e.id}:持锁 → 4 ${e.prefix}_NOT_RUN reason=locked,零写入;放锁后同一命令走到该入口的业务结果(正向对照)`, async () => {
      const w = await e.mk();
      const holder = await startHolder(w.stateDir, w.tmp);
      try {
        await assertRefused(
          w.stateDir,
          e.prefix,
          async () => {
            const r = await runAt(
              w.at,
              e.argv(w.at),
              e.tty !== undefined ? { isTty: true, ...e.tty } : {},
            );
            return r;
          },
          e.outEmpty === false ? { outEmpty: false } : {},
        );
      } finally {
        await holder.stop();
      }
      // 正向对照:持锁方已被 SIGKILL(锁文件是死 pid 留下的,A1 会回收);同一命令、同一世界
      const treeBefore = (await treeOf(w.stateDir)).filter((l) => !l.startsWith('rsi/lock '));
      const ok = await runAt(
        w.at,
        e.argv(w.at),
        e.tty !== undefined ? { isTty: true, ...e.tty } : {},
      );
      expect(ok.err, '放锁后不再是 locked').not.toContain('reason=locked');
      expect(ok.code, `放锁后(stderr=${ok.err})`).toBe(e.after.code);
      if (e.after.outEnds !== undefined) expect(ok.out.endsWith(e.after.outEnds)).toBe(true);
      if (e.after.outHas !== undefined) expect(ok.out).toContain(e.after.outHas);
      if (e.after.writesData) {
        const treeAfter = (await treeOf(w.stateDir)).filter((l) => !l.startsWith('rsi/lock '));
        expect(
          treeAfter,
          '放锁后确实写了数据(拿锁被拒不是因为这个命令本来就什么都不写)',
        ).not.toEqual(treeBefore);
      }
      expect(await exists(path.join(w.stateDir, 'rsi', 'lock')), '命令结束释放锁').toBe(false);
    });
  }

  it('signals collect(非 --dry):持锁 → 4 SIGNALS_NOT_RUN reason=locked,零写入(盐、信号库都不建);放锁后成功并建盐', async () => {
    const w = await collectWorld();
    const salt = path.join(w.stateDir, 'salt');
    const holder = await startHolder(w.stateDir, w.tmp);
    try {
      await assertRefused(w.stateDir, 'SIGNALS', () => runAt(w.at, w.argv));
      expect(await exists(salt), '盐没有在锁外先建').toBe(false);
      expect(await exists(path.join(w.stateDir, 'signals'))).toBe(false);
    } finally {
      await holder.stop();
    }
    const ok = await runAt(w.at, w.argv);
    expect(ok.code, ok.err).toBe(0);
    expect(await exists(salt)).toBe(true);
    expect(await exists(path.join(w.stateDir, 'signals'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reflect / judge --run-llm(命令工厂 + 注入后端;与 reflect-rsi-lock / judge-rsi-lock 同样的世界)
// ---------------------------------------------------------------------------
describe('R20-5.1 真子进程持锁 × reflect --run-llm / judge --run-llm(零构造、零调用)', () => {
  it('reflect --run-llm:持锁 → 4 REFLECT_NOT_RUN reason=locked,后端构造 0、LLM 调用 0、零写入;放锁后同一命令暂存成功', async () => {
    const w = await newR5World({ overlay: EGRESS_OVERLAY });
    await aliasRsiState(w.io, w.parent);
    const stub = new StubBackend((req) => okText(outJson(lintDraft(req.user))));
    const factory = { n: 0 };
    const cmd = createReflectCommand({
      clock: () => new Date('2026-10-12T08:00:00Z'),
      randomHex: () => 'abc123',
      redactor: testRedactor(),
      createBackends: async () => {
        factory.n++;
        return { glm: stub };
      },
      rsiConfig: async () => onConfig(w.parent),
    });
    const LIVE = ['--run-llm', '--allow-egress', '--owner', '@tester'];
    const holder = await startHolder(w.state, w.parent);
    try {
      await assertRefused(w.state, 'REFLECT', async () => {
        const { ctx, out, err } = ctxFor(w, LIVE);
        const a = withWriteAudit(); // 真正的写审计钩子(不是硬编码空数组)
        const code = await cmd.run({ ...ctx, io: { ...ctx.io, writeAudit: a.hook } });
        return { code, err: err.join(''), out: out.join(''), audit: a.calls };
      });
      expect(factory.n, '③ 零后端构造').toBe(0);
      expect(stub.calls, '③ 零 LLM 调用').toBe(0);
    } finally {
      await holder.stop();
    }
    const { ctx, out } = ctxFor(w, LIVE);
    expect(await cmd.run(ctx)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('outcome=staged');
    expect(factory.n).toBe(1);
  });

  it('judge --run-llm:持锁 → 4 JUDGE_NOT_RUN reason=locked,零构造零调用零写入;放锁后同一命令评审成功', async () => {
    const w = await newWork('b5e-lm-judge-');
    await writeProposal(w);
    await aliasRsiState(w.io, w.dir);
    const s = makeStubs();
    const factory = { n: 0 };
    const cmd = createJudgeCommand({
      createBackends: async () => {
        factory.n++;
        return s.backends;
      },
      redactor: judgeRedactor,
      requireOverlayEgress: false,
      rsiConfig: async () => onConfig(w.dir),
    });
    const LIVE = ['--run', RUN_ID, '--run-llm', '--allow-egress'];
    const holder = await startHolder(w.state, w.dir);
    try {
      await assertRefused(w.state, 'JUDGE', async () => {
        const { ctx, out, err } = cmdCtx(w, LIVE);
        const a = withWriteAudit();
        const code = await cmd.run({ ...ctx, io: { ...ctx.io, writeAudit: a.hook } });
        return { code, err: err.join(''), out: out.join(''), audit: a.calls };
      });
      expect(factory.n, '③ 零后端构造').toBe(0);
      expect(s.totalCalls(), '③ 零 LLM 调用').toBe(0);
    } finally {
      await holder.stop();
    }
    const { ctx, out } = cmdCtx(w, LIVE);
    expect(await cmd.run(ctx)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('judged');
    expect(s.totalCalls()).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 反向:未启用 [rsi] 时不建 .state/rsi/
// ---------------------------------------------------------------------------
describe('反向:未启用 [rsi](无配置 / enabled=false)时不建 .state/rsi/', () => {
  for (const mode of ['无配置', 'enabled=false'] as const) {
    it(`legacy 写入方(collect / promote --write / reflect --gc --write)× ${mode}:照常运行、不建 .state/rsi/;正向前提:数据确实写了`, async () => {
      const c = await collectWorld();
      const sc = await makeSc('lm-off-', { state: 'confirmed' });
      // 两个世界都改成「未启用」
      for (const [fx, cfg] of [
        [c.fx, c.cfg],
        [sc.s.f.fx, sc.s.f.cfgFile],
      ] as const) {
        if (mode === '无配置') await remove(fx, cfg);
        else await writeFile(fx, cfg, '[rsi]\nenabled = false\n', { mode: 0o600 });
      }
      const rsiDirOf = (state: string): string => path.join(state, 'rsi');
      const collectRsiBefore = await exists(rsiDirOf(c.stateDir));
      expect(collectRsiBefore, '前提:collect 世界起初没有 rsi/').toBe(false);
      const col = await runAt(c.at, c.argv);
      expect(col.code, col.err).toBe(0);
      expect(
        await exists(path.join(c.stateDir, 'signals')),
        '正向前提:legacy 采集照常写信号库',
      ).toBe(true);
      expect(await exists(rsiDirOf(c.stateDir)), 'collect 不建 .state/rsi/').toBe(false);
      // sc 世界原本就有 rsi/(造数据时建的):用「rsi/lock 从未被创建」与「rsi/ 树不变」判
      const at: At = { env: cmdFxOf(sc.s).env, cwd: sc.s.f.repo };
      const rsiBefore = await treeOf(rsiDirOf(sc.s.state));
      const gc = await runAt(at, ['reflect', '--gc', '--write']);
      expect(gc.code, gc.err).toBe(0);
      const pr = await runAt(at, ['promote', '--run', 'run-ok', '--write']);
      expect(pr.err).not.toContain('reason=locked');
      expect(await treeOf(rsiDirOf(sc.s.state)), 'rsi/ 树不变:没有拿锁、没有写清单').toEqual(
        rsiBefore,
      );
      expect(gc.audit.some((a) => a.path.endsWith('/rsi/lock'))).toBe(false);
      expect(pr.audit.some((a) => a.path.endsWith('/rsi/lock'))).toBe(false);
    });
  }

  it('rsi 自己的写入口(tick --write / confirm / purge --write / rebuild --write / status --ack)× 未启用:4 off,零写入,不建 .state/rsi/', async () => {
    const f = await makeTickFx('lm-off-rsi-', { noSeed: true });
    await writeCfg(f, '[rsi]\nenabled = false\n');
    const at: At = { env: f.env, cwd: f.repo };
    const before = await treeOf(f.dir);
    for (const [argv, tty] of [
      [['rsi', 'tick', '--write'], false],
      [['rsi', 'confirm'], true],
      [['rsi', 'purge', '--excluded', '--write'], true],
      [['rsi', 'projects', '--rebuild-index', '--write'], false],
      [['rsi', 'status', '--ack'], true],
    ] as const) {
      const r = await runAt(at, [...argv], tty ? { isTty: true, line: 'yes' } : {});
      expect([r.code, r.err], argv.join(' ')).toEqual([4, 'RSI_NOT_RUN reason=off\n']);
      expect(r.audit, argv.join(' ')).toEqual([]);
    }
    expect(await treeOf(f.dir)).toEqual(before);
    expect(await exists(path.join(f.io.stateDir, 'rsi'))).toBe(false);
    // 对照:启用时同一世界的 tick --write 会建 .state/rsi/
    const g = await makeTickFx('lm-on-rsi-', { noSeed: true });
    const r = await runAt({ env: g.env, cwd: g.repo }, ['rsi', 'tick', '--write']);
    expect(r.code, r.err).toBe(0);
    expect(await exists(path.join(g.io.stateDir, 'rsi'))).toBe(true);
  });
});

const OFF: RsiConfig = { status: 'off', reason: 'absent' };
describe('反向:reflect / judge --run-llm × 未启用(闸门 off):不建 rsi/,照常运行', () => {
  it('reflect:构造后端 1 次、暂存成功、没有 rsi/;judge 同理', async () => {
    const w = await newR5World({ overlay: EGRESS_OVERLAY });
    const stub = new StubBackend((req) => okText(outJson(lintDraft(req.user))));
    const cmd = createReflectCommand({
      clock: () => new Date('2026-10-12T08:00:00Z'),
      randomHex: () => 'abc123',
      redactor: testRedactor(),
      createBackends: async () => ({ glm: stub }),
      rsiConfig: async () => OFF,
    });
    const { ctx, out } = ctxFor(w, ['--run-llm', '--allow-egress', '--owner', '@tester']);
    expect(await cmd.run(ctx)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('outcome=staged');
    expect(await exists(path.join(w.state, 'rsi'))).toBe(false);
    const jw = await newWork('b5e-lm-judge-off-');
    await writeProposal(jw);
    const s = makeStubs();
    const jcmd = createJudgeCommand({
      createBackends: async () => s.backends,
      redactor: judgeRedactor,
      requireOverlayEgress: false,
      rsiConfig: async () => OFF,
    });
    const jc = cmdCtx(jw, ['--run', RUN_ID, '--run-llm', '--allow-egress']);
    expect(await jcmd.run(jc.ctx)).toBe(ExitCode.OK);
    expect(jc.out.join('')).toContain('judged');
    expect(await exists(path.join(jw.state, 'rsi'))).toBe(false);
  });
});
