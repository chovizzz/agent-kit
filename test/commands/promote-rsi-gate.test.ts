/**
 * R20-A2 B5g:promote --run 的 rsi 隐私闸、即时闸(两次)、锁与 tainted 产物目录(契约 R20-4.8、§20.9 第 11 / 21 条)。
 * 世界 = promote-adopt 的真实流水线(collect → reflect(stub)→ judge(stub))+ 假 HOME 里的 `[rsi]` 配置 + 状态目录里的索引。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createJudgeCommand } from '../../src/commands/judge.js';
import { createPromoteCommand } from '../../src/commands/promote.js';
import type { PromoteCommandDeps } from '../../src/commands/promote.js';
import { createReflectCommand } from '../../src/commands/reflect.js';
import { command as signalsCollect } from '../../src/commands/signals-collect.js';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { createIoContext } from '../../src/io/paths.js';
import type { IoContext } from '../../src/io/paths.js';
import { exists, readDir, readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { stageDir } from '../../src/reflect/stage.js';
import { REPO_ROOT, makeTempDir, wideCtx } from '../helpers/tmp.js';
import {
  CANARY_UM,
  aliasOf,
  draft,
  okText,
  out as outJson,
  testRedactor,
} from '../fixtures/reflect/world.js';
import { genClaude } from '../fixtures/sessions/gen-claude.js';
import { StubBackend as HopStub, makeStubs, outputText } from '../judge/helpers.js';
import {
  CFG_FAILURES,
  aliasState,
  applyCfgFailure,
  loseLockAtRead,
  makeHome,
  makeProjectRoot,
  putJournal,
  putTaintMark,
  removeIndex,
  rsiText,
  writeCfgText,
  writeIndexAndCounts,
} from './b5g-world.js';
import type { HomeCfg } from './b5g-world.js';
import { ctxFor, newR5World, overlayToml } from './r5-world.js';
import type { R5World } from './r5-world.js';
import { startHolder } from './rsi-lock-world.js';

const LESSON_A = `以后提交代码前必须先运行 lint 检查 ${CANARY_UM}`;
const LESSON_B = '以后提交代码前必须先运行 lint 检查并修复告警';
const CLOCK = (): Date => new Date('2026-10-12T08:00:00Z');
const RUN_ID = 'run-20261012T080000Z-abc123';
const OWNER = '@chovizzz';
const myUid = (): number => (typeof process.getuid === 'function' ? process.getuid() : -1);

interface PW {
  w: R5World;
  fx: IoContext;
  fxh: IoContext;
  homeDir: string;
  h: HomeCfg;
  keys: string[];
  roots: string[];
  audit: string[];
  runDir: string;
  env: Record<string, string>;
}

async function readKeys(w: R5World): Promise<string[]> {
  const dir = path.join(w.state, 'signals', 'claude');
  const keys = new Set<string>();
  for (const f of await readDir(dir)) {
    for (const line of (await readText(path.join(dir, f.name))).split('\n')) {
      if (line.trim() !== '') keys.add((JSON.parse(line) as { project_key: string }).project_key);
    }
  }
  return [...keys].sort();
}

/** 真实流水线 + rsi 层。`cfg`:on(默认,无排除)/ absent / no_section / disabled */
async function pworld(
  o: { cfg?: 'on' | 'absent' | 'no_section' | 'disabled'; alias?: boolean; index?: boolean } = {},
): Promise<PW> {
  const w0 = await newR5World({ signals: null });
  const sessions = path.join(w0.parent, 'sessions');
  const common = { root: sessions, toolCalls: 2, failedResults: 1, version: '2.1.294' } as const;
  await genClaude(w0.io, {
    ...common,
    cwd: '/work/proj-a',
    id: 'sa1',
    userTexts: [LESSON_A, '你好'],
  });
  await genClaude(w0.io, { ...common, cwd: '/work/proj-b', id: 'sb1', userTexts: [LESSON_B] });
  const cerr: string[] = [];
  const cc = await signalsCollect.run({
    argv: [
      '--source',
      sessions,
      '--agent',
      'claude',
      '--allow-project',
      'proj-a',
      '--allow-project',
      'proj-b',
    ],
    io: w0.io,
    overlayPath: undefined,
    stdout: () => undefined,
    stderr: (t) => cerr.push(t),
  });
  expect(cc, cerr.join('')).toBe(0);
  const keys = await readKeys(w0);
  expect(keys).toHaveLength(2);
  const overlayPath = path.join(w0.parent, 'overlay.toml');
  await safe.writeFile(
    w0.io,
    overlayPath,
    overlayToml(
      `egress = true\nbackends = [{ slot = "glm", cli = "pi" }]\nteam_project_keys = ${JSON.stringify(keys)}`,
    ),
  );
  const w1: R5World = { ...w0, overlayPath };
  const stub = new HopStub('glm', 'zhipu', 'glm-example', (req) =>
    okText(
      outJson(draft({ evidence: [aliasOf(req.user, CANARY_UM), aliasOf(req.user, LESSON_B)] })),
    ),
  );
  const reflect = createReflectCommand({
    clock: CLOCK,
    randomHex: () => 'abc123',
    redactor: testRedactor(),
    createBackends: () => ({ glm: stub }),
  });
  const rc = ctxFor(w1, ['--run-llm', '--allow-egress', '--owner', OWNER, '--json']);
  expect(await reflect.run(rc.ctx), rc.err.join('')).toBe(ExitCode.OK);
  const stubs = makeStubs({ codex: () => ({ ok: true, text: outputText() }) }, ['codex', 'kimi']);
  const judge = createJudgeCommand({
    requireOverlayEgress: false,
    createBackends: () => stubs.backends,
    redactor: testRedactor(),
  });
  const jc = ctxFor(w1, ['--run', RUN_ID, '--run-llm', '--allow-egress']);
  expect(await judge.run(jc.ctx), jc.err.join('')).toBe(ExitCode.OK);

  // rsi 层:假 HOME(不在 KIT_TMP 之内)、项目根、索引、`.state` 别名
  const homeDir = (await makeTempDir('promote-gate-home-')).dir;
  const fxh = wideCtx(homeDir);
  const h = await makeHome(fxh, homeDir);
  const fx = wideCtx(w1.parent);
  const roots = [
    await makeProjectRoot(fx, w1.parent, 'A'),
    await makeProjectRoot(fx, w1.parent, 'B'),
  ];
  if (o.index !== false) {
    await writeIndexAndCounts(
      fx,
      w1.state,
      keys.map((key, i) => ({ key, root: roots[i] as string })),
    );
  }
  const mode = o.cfg ?? 'on';
  if (mode === 'on') await writeCfgText(fxh, h, rsiText(w1.repo.dir));
  else if (mode === 'no_section') await writeCfgText(fxh, h, '[other]\nx = 1\n');
  else if (mode === 'disabled') await writeCfgText(fxh, h, '[rsi]\nenabled = false\n');
  if (o.alias !== false) await aliasState(fx, w1.repo.dir, w1.state);
  const env = {
    KIT_TMP: w1.parent,
    KIT_STATE_DIR: w1.state,
    KIT_REAL_HOME_OVERRIDE: h.home,
    PATH: '/usr/bin:/bin',
  };
  const audit: string[] = [];
  const io = createIoContext({
    cwd: REPO_ROOT,
    root: w1.repo.dir,
    env,
    writeAudit: (op, p) => void audit.push(`${op} ${p}`),
  });
  return {
    w: { ...w1, io },
    fx,
    fxh,
    homeDir,
    h,
    keys,
    roots,
    audit,
    runDir: stageDir(w1.io, RUN_ID),
    env,
  };
}

async function run(
  pw: PW,
  argv: string[],
  deps: PromoteCommandDeps = {},
): Promise<{ code: number; out: string; err: string; red: { n: number } }> {
  const red = { n: 0 };
  const base = testRedactor();
  const c = ctxFor(pw.w, argv, pw.env);
  const code = await createPromoteCommand({
    redactor: {
      pass2: (t: string) => {
        red.n++;
        return base.pass2(t);
      },
    } as ReturnType<typeof testRedactor>,
    ...deps,
  }).run(c.ctx);
  return { code, out: c.out.join(''), err: c.err.join(''), red };
}

const excludeFirst = (pw: PW): Promise<void> =>
  writeCfgText(
    pw.fxh,
    pw.h,
    rsiText(pw.w.repo.dir, `exclude_dirs = [${JSON.stringify(pw.roots[0])}]\n`),
  );
const promoteRoot = (pw: PW): string => path.join(pw.w.state, 'promote');
const promoteIds = async (pw: PW): Promise<string[]> =>
  (await exists(promoteRoot(pw))) ? (await readDir(promoteRoot(pw))).map((e) => e.name) : [];
const isRsiPath = (pw: PW, l: string): boolean =>
  l.includes(`${path.sep}rsi${path.sep}`) ||
  l.endsWith(`${path.sep}rsi`) ||
  l === `mkdirp ${pw.w.state}`;

describe('promote --run × privacyCheck(cfg_* 不是 legacy)', () => {
  for (const which of CFG_FAILURES) {
    for (const mode of ['dry', 'write'] as const) {
      it(`${which} × ${mode}:退出 3 RSI_FAIL_CLOSED reason=${which};零 planAdoption、零输出、零写入`, async () => {
        if (which === 'cfg_unreadable' && myUid() === 0) return;
        const pw = await pworld();
        // 正向对照:合规配置下同一命令能跑
        const ok = await run(pw, ['--run', RUN_ID, ...(mode === 'write' ? ['--write'] : [])]);
        expect(ok.code, ok.err).toBe(ExitCode.OK);
        expect(ok.red.n).toBeGreaterThan(0);
        const pw2 = await pworld();
        await applyCfgFailure(pw2.fxh, pw2.h, pw2.w.repo.dir, pw2.w.parent, which);
        pw2.audit.length = 0;
        const r = await run(pw2, ['--run', RUN_ID, ...(mode === 'write' ? ['--write'] : [])]);
        expect(r.code).toBe(ExitCode.FAIL_CLOSED);
        expect(r.err).toBe(`RSI_FAIL_CLOSED reason=${which}\n`);
        expect(r.out).toBe('');
        expect(r.red.n).toBe(0);
        expect(pw2.audit).toEqual([]);
        expect(await promoteIds(pw2)).toEqual([]);
      });
    }
  }
});

describe('promote --run × legacy(没有 [rsi] / 未启用):逐字节同接线前', () => {
  for (const cfg of ['absent', 'no_section', 'disabled'] as const) {
    it(`${cfg}:闸不介入——run 带 TAINTED、索引缺失也照常采纳;不建 rsi/lock`, async () => {
      const pw = await pworld({ cfg, alias: false, index: false });
      const r = await run(pw, ['--run', RUN_ID, '--write', '--json']);
      expect(r.code, r.err).toBe(ExitCode.OK);
      expect(r.err).toBe('');
      expect(JSON.parse(r.out)).toMatchObject({ adopted: 1, wrote: true });
      expect(await promoteIds(pw)).toHaveLength(1);
      expect(await exists(path.join(pw.w.state, 'rsi', 'lock'))).toBe(false);
    });
  }
});

describe('promote --run × 即时闸 #1(planAdoption 之前)', () => {
  const cases: {
    name: string;
    allowRunDir?: boolean;
    exit: number;
    err: (pw: PW) => string;
    setup: (pw: PW) => Promise<void>;
    world?: Parameters<typeof pworld>[0];
  }[] = [
    {
      name: 'X(项目被排除)',
      exit: 1,
      err: () => `RSI_RUN_TAINTED reason=exclude run_id=${RUN_ID}\n`,
      setup: excludeFirst,
    },
    {
      name: 'U(索引缺失)',
      exit: 1,
      err: () => `RSI_RUN_ATTRIBUTION_UNKNOWN run_id=${RUN_ID}\n`,
      setup: async () => undefined,
      world: { index: false },
    },
    {
      name: 'TAINTED 标记',
      allowRunDir: true, // 锁内 resumeTaint 会把已标记 run 的清理补完(摘录置空等),这是 taint 服务的写,不是 promote 的产物
      exit: 1,
      err: () => `RSI_RUN_TAINTED reason=purge run_id=${RUN_ID}\n`,
      setup: (pw) => putTaintMark(pw.fx, pw.runDir, 'purge'),
    },
    {
      name: 'purge journal',
      exit: 3,
      err: () => 'RSI_FAIL_CLOSED reason=purge_incomplete\n',
      setup: (pw) => putJournal(pw.fx, pw.w.state),
    },
  ];
  for (const c of cases) {
    for (const mode of ['dry', 'write'] as const) {
      it(`${c.name} × ${mode}:退出 ${c.exit}、稳定码、planAdoption 未运行、零输出、无产物`, async () => {
        const pw = await pworld(c.world);
        await c.setup(pw);
        pw.audit.length = 0;
        const r = await run(pw, ['--run', RUN_ID, ...(mode === 'write' ? ['--write'] : [])]);
        expect(r.code).toBe(c.exit);
        expect(r.err).toBe(c.err(pw));
        expect(r.out).toBe('');
        expect(r.red.n, '闸先于 planAdoption').toBe(0);
        expect(await promoteIds(pw)).toEqual([]);
        if (mode === 'dry') expect(pw.audit).toEqual([]);
        else {
          expect(
            pw.audit.filter(
              (l) => !isRsiPath(pw, l) && !(c.allowRunDir === true && l.includes(pw.runDir)),
            ),
          ).toEqual([]);
        }
        expect(await exists(path.join(pw.w.state, 'rsi', 'lock'))).toBe(false);
      });
    }
  }

  it('正向对照:enforce 且归属 P → 干跑 / --write 照常;锁用完即释放', async () => {
    const pw = await pworld();
    const d = await run(pw, ['--run', RUN_ID, '--json']);
    expect(d.code, d.err).toBe(ExitCode.OK);
    expect(JSON.parse(d.out)).toMatchObject({ adopted: 1, wrote: false });
    const w = await run(pw, ['--run', RUN_ID, '--write', '--json']);
    expect(w.code, w.err).toBe(ExitCode.OK);
    expect(JSON.parse(w.out)).toMatchObject({ adopted: 1, wrote: true });
    expect(await promoteIds(pw)).toHaveLength(1);
    expect(await exists(path.join(pw.w.state, 'rsi', 'lock'))).toBe(false);
  });
});

describe('promote --run × 即时闸 #2(planAdoption 之后、落盘与输出之前)', () => {
  for (const mode of ['dry', 'write'] as const) {
    it(`${mode}:planAdoption 之后收紧排除 → 退出 1、不输出、不落盘(对照:不收紧则 ${mode === 'dry' ? '输出' : '落盘'})`, async () => {
      const ok = await pworld();
      const rOk = await run(ok, ['--run', RUN_ID, ...(mode === 'write' ? ['--write'] : [])]);
      expect(rOk.code).toBe(ExitCode.OK);
      expect(rOk.out).not.toBe('');

      const pw = await pworld();
      const r = await run(pw, ['--run', RUN_ID, ...(mode === 'write' ? ['--write'] : [])], {
        betweenGates: () => excludeFirst(pw),
      });
      expect(r.red.n, '闸 #1 放行、planAdoption 已运行').toBeGreaterThan(0);
      expect(r.code).toBe(ExitCode.CHECK_FAILED);
      expect(r.err).toBe(`RSI_RUN_TAINTED reason=exclude run_id=${RUN_ID}\n`);
      expect(r.out).toBe('');
      expect(await promoteIds(pw)).toEqual([]);
    });
  }
});

describe('promote --run --write × 锁', () => {
  it('另一进程持锁:退出 4 PROMOTE_NOT_RUN reason=locked,零 planAdoption、零写入', async () => {
    const pw = await pworld();
    const holder = await startHolder(pw.w.state, pw.w.parent);
    try {
      const r = await run(pw, ['--run', RUN_ID, '--write']);
      expect(r.code).toBe(ExitCode.NOT_RUN);
      expect(r.err).toBe('PROMOTE_NOT_RUN reason=locked\n');
      expect(r.red.n).toBe(0);
      expect(await promoteIds(pw)).toEqual([]);
    } finally {
      await holder.stop();
    }
  });

  it('独立状态树(无 .state 别名):不拿锁、不 resumeTaint,但照样 enforce(X → 1;P → 照常写)', async () => {
    const x = await pworld({ alias: false });
    await excludeFirst(x);
    const rx = await run(x, ['--run', RUN_ID, '--write']);
    expect(rx.code).toBe(ExitCode.CHECK_FAILED);
    expect(rx.err).toBe(`RSI_RUN_TAINTED reason=exclude run_id=${RUN_ID}\n`);
    const p = await pworld({ alias: false });
    const rp = await run(p, ['--run', RUN_ID, '--write']);
    expect(rp.code, rp.err).toBe(ExitCode.OK);
    expect(await promoteIds(p)).toHaveLength(1);
    expect(await exists(path.join(p.w.state, 'rsi', 'lock'))).toBe(false);
  });

  it('rsi/ 是符号链接(状态目录不安全)→ 退出 3 RSI_FAIL_CLOSED reason=state_dir_unsafe,零写入', async () => {
    const pw = await pworld({ index: false });
    const decoy = path.join(pw.w.parent, 'decoy-rsi');
    await safe.mkdirp(pw.fx, decoy, 0o700);
    await safe.symlink(pw.fx, decoy, path.join(pw.w.state, 'rsi'));
    pw.audit.length = 0;
    const r = await run(pw, ['--run', RUN_ID, '--write']);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r.err).toBe('RSI_FAIL_CLOSED reason=state_dir_unsafe\n');
    expect(await promoteIds(pw)).toEqual([]);
  });

  // 失锁:第 k 次 assertHeld 之前换掉 nonce。写点 = 入口复核 1 次 + 每个文件 4 步 × 3 + rename 1 = 14 次,另加 release 读 1 次
  const WRITE_POINTS = 14;
  it('正常运行的复核次数 = 写点数 + release(「beforeWrite 只放最外层」的变异会让它变少)', async () => {
    const pw = await pworld();
    const lost = loseLockAtRead(pw.fx, Infinity, false);
    // 从「写盘阶段」开始计数(planAdoption 之后):之前的 assertHeld(resumeTaint 的归属核对等)不算写点
    const r = await run(pw, ['--run', RUN_ID, '--write'], {
      lockDeps: { lock: lost.lock },
      betweenGates: async () => lost.arm(),
    });
    expect(r.code, r.err).toBe(ExitCode.OK);
    expect(lost.reads()).toBe(WRITE_POINTS + 1);
    const ops = pw.audit.filter(
      (l) => l.includes(`${path.sep}promote${path.sep}`) && !l.startsWith('rename.from '),
    );
    expect(ops).toHaveLength(WRITE_POINTS - 1);
  });
  for (const k of [1, 2, 3, 4, 5, 9, 13, WRITE_POINTS]) {
    it(`第 ${k} 个写点失锁:退出 3 lock_lost,此前恰好完成 ${Math.max(0, k - 2)} 个写操作,此后零写入,无正式产物目录`, async () => {
      const pw = await pworld();
      const lost = loseLockAtRead(pw.fx, k, false);
      pw.audit.length = 0;
      const r = await run(pw, ['--run', RUN_ID, '--write'], {
        lockDeps: { lock: lost.lock },
        betweenGates: async () => lost.arm(),
      });
      expect(lost.lostAt()).toBe(k);
      expect(r.code).toBe(ExitCode.FAIL_CLOSED);
      expect(r.err).toBe('RSI_FAIL_CLOSED reason=lock_lost\n');
      expect(r.out).toBe('');
      const ops = pw.audit.filter(
        (l) => l.includes(`${path.sep}promote${path.sep}`) && !l.startsWith('rename.from '),
      );
      expect(ops).toHaveLength(Math.max(0, k - 2));
      const ids = (await promoteIds(pw)).filter((n) => !n.startsWith('.tmp-'));
      expect(ids).toEqual([]);
    });
  }
});

describe('promote --run --write × tainted 产物目录(契约第 21 条)', () => {
  async function adoptThenTaint(pw: PW): Promise<string> {
    const w = await run(pw, ['--run', RUN_ID, '--write', '--json']);
    expect(w.code, w.err).toBe(ExitCode.OK);
    const id = (JSON.parse(w.out) as { promo_id: string }).promo_id;
    const dir = path.join(promoteRoot(pw), id);
    await putTaintMark(pw.fx, dir, 'exclude');
    await safe.remove(pw.fx, path.join(dir, 'promote.patch'));
    await safe.remove(pw.fx, path.join(dir, 'pr-body.md'));
    return id;
  }

  it('enforce:同 id 目录已 tainted → 退出 1 RSI_RUN_TAINTED(不再是 3 PROMOTE_RUN_EXISTS),目录原样', async () => {
    const pw = await pworld();
    const id = await adoptThenTaint(pw);
    const dir = path.join(promoteRoot(pw), id);
    const before = (await readDir(dir)).map((e) => e.name).sort();
    const r = await run(pw, ['--run', RUN_ID, '--write']);
    expect(r.code).toBe(ExitCode.CHECK_FAILED);
    expect(r.err).toBe(`RSI_RUN_TAINTED reason=exclude run_id=${id}\n`);
    expect(r.out).toBe('');
    expect((await readDir(dir)).map((e) => e.name).sort()).toEqual(before);
  });

  it('不论 [rsi] 是否启用都查:legacy 世界里 tainted 目录同样退 1', async () => {
    const pw = await pworld({ cfg: 'absent', alias: false, index: false });
    const id = await adoptThenTaint(pw);
    const r = await run(pw, ['--run', RUN_ID, '--write']);
    expect(r.code).toBe(ExitCode.CHECK_FAILED);
    expect(r.err).toBe(`RSI_RUN_TAINTED reason=exclude run_id=${id}\n`);
  });

  it('对照:目录未 tainted 且一致 → 退出 0 existing=true', async () => {
    const pw = await pworld();
    const w = await run(pw, ['--run', RUN_ID, '--write']);
    expect(w.code, w.err).toBe(ExitCode.OK);
    const again = await run(pw, ['--run', RUN_ID, '--write', '--json']);
    expect(again.code, again.err).toBe(ExitCode.OK);
    expect(JSON.parse(again.out)).toMatchObject({ wrote: false, existing: true });
  });
});

describe('promote --run × 配置来源(排除项:ctx.env 与 io 同源时按该份配置)', () => {
  it('KIT_REAL_HOME_OVERRIDE 与 HOME 指向不同目录、各放一份 config → 只读覆盖那份', async () => {
    const pw = await pworld();
    const real = await makeHome(pw.fxh, pw.homeDir, 'home-real');
    await writeCfgText(pw.fxh, real, rsiText(pw.w.repo.dir)); // 「HOME」那份:不排除
    await excludeFirst(pw); // 覆盖目录那份:排除
    const env = { ...pw.env, HOME: real.home };
    const io = createIoContext({ cwd: REPO_ROOT, root: pw.w.repo.dir, env });
    const c = ctxFor({ ...pw.w, io }, ['--run', RUN_ID], env);
    const code = await createPromoteCommand({ redactor: testRedactor() }).run(c.ctx);
    expect(code).toBe(ExitCode.CHECK_FAILED);
    expect(c.err.join('')).toBe(`RSI_RUN_TAINTED reason=exclude run_id=${RUN_ID}\n`);
  });
  it('removeIndex 夹具自检:索引被删后同一世界变 U(防夹具静默失效)', async () => {
    const pw = await pworld();
    await removeIndex(pw.fx, pw.w.state);
    const r = await run(pw, ['--run', RUN_ID]);
    expect(r.err).toBe(`RSI_RUN_ATTRIBUTION_UNKNOWN run_id=${RUN_ID}\n`);
  });
});
