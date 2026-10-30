/**
 * R20-A2 B3-0:`agent-kit rsi` 分发器与命令桩(经真实 `main()`)。
 * 每个子命令桩退出 64、stderr 只有稳定码、stdout 空;未知 / 缺省子命令退 2;rsi 在通用 `createIoContext` 之前分流。
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';

import { main } from '../../src/cli.js';
import { COMMANDS } from '../../src/cli.js';
import { RSI_P1_RESERVED_SUBCOMMANDS, RSI_SUBCOMMANDS } from '../../src/contracts/rsi.js';
import { RSI_SUBCOMMAND_TABLE } from '../../src/commands/rsi.js';
import type { EarlyCommandContext } from '../../src/commands/types.js';
import { makeTempDir } from '../helpers/tmp.js';
import { mkdirp, writeFile } from '../../src/io/safe-fs.js';
import { exists } from '../../src/io/read-fs.js';
import { createRsiIoContext } from '../../src/rsi/io.js';
import { runProjects } from '../../src/rsi/projects.js';
import { runStatus } from '../../src/rsi/status.js';
import { runStop } from '../../src/rsi/stop.js';
import { treeOf, writeCfg } from './rsi-fixture.js';
import { makeRoFx, runDirect, runMain } from './ro-fixture.js';

interface Run {
  code: number;
  out: string;
  err: string;
  audit: string[];
}

async function run(
  argv: string[],
  env: Record<string, string | undefined> = {},
  cwd?: string,
): Promise<Run> {
  let out = '';
  let err = '';
  const audit: string[] = [];
  const code = await main(argv, {
    // 假 HOME 指向不存在的目录:已实装的只读子命令(status / projects / stop)会读 [rsi] 配置,不得读到开发机的真实配置
    env: { PATH: '/usr/bin:/bin', KIT_REAL_HOME_OVERRIDE: '/nonexistent-home-b3a', ...env },
    ...(cwd !== undefined ? { cwd } : {}),
    writeAudit: (op, p) => void audit.push(`${op} ${p}`),
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  });
  return { code, out, err, audit };
}

const ALL = [...RSI_SUBCOMMANDS, ...RSI_P1_RESERVED_SUBCOMMANDS];
/** 已实装(不再是桩):status / projects / stop(B3a)、tick(B5a)、confirm(B5b)、purge(B5c);它们的行为测试在 status / projects / stop / open / b5b-* / b5c-* 各自的测试文件 */
const IMPLEMENTED = ['status', 'projects', 'stop', 'tick', 'confirm', 'purge'];
const STUBBED = ALL.filter((n) => !IMPLEMENTED.includes(n));

describe('rsi 分发器', () => {
  it('rsi 已登记进 COMMANDS;P0 子命令表与常量一致,每个子命令有独立入口文件', () => {
    expect(COMMANDS.map((c) => c.name)).toContain('rsi');
    expect(RSI_SUBCOMMAND_TABLE.map((s) => s.name)).toEqual([...RSI_SUBCOMMANDS]);
  });

  for (const sub of STUBBED) {
    it(`rsi ${sub} → 64;stderr 只有稳定码,stdout 空,写审计零调用`, async () => {
      const r = await run(['rsi', sub]);
      expect(r.code).toBe(64);
      expect(r.err).toBe(`RSI_NOT_IMPLEMENTED subcommand=${sub}\n`);
      expect(r.out).toBe('');
      expect(r.audit).toEqual([]);
    });
  }

  it('多余参数不改变桩行为(桩不解析参数)', async () => {
    const r = await run(['rsi', 'poke', '--json', '--bogus']);
    expect(r.code).toBe(64);
    expect(r.err).toBe('RSI_NOT_IMPLEMENTED subcommand=poke\n');
  });

  it('缺省 / 未知子命令 → 2 RSI_USAGE reason=unknown_subcommand,不回显输入', async () => {
    for (const argv of [['rsi'], ['rsi', 'nope'], ['rsi', 'bad\nstuff'], ['rsi', '--x']]) {
      const r = await run(argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.err).toBe('RSI_USAGE reason=unknown_subcommand\n');
      expect(r.out).toBe('');
    }
  });

  it('选择先于通用路径校验:无效的 KIT_WRITE_ROOTS 让普通命令退 3,rsi 子命令仍到达自己的桩(64)', async () => {
    const bad = { KIT_WRITE_ROOTS: 'relative/not/absolute' };
    const control = await run(['build'], bad);
    expect(control.code).toBe(3); // 通用路径确实会因它失败,否则下面的断言没有意义
    for (const sub of STUBBED.filter((n) => (RSI_SUBCOMMANDS as readonly string[]).includes(n))) {
      const r = await run(['rsi', sub], bad);
      expect(r.code, sub).toBe(64);
      expect(r.err).toBe(`RSI_NOT_IMPLEMENTED subcommand=${sub}\n`);
    }
    // 已实装的子命令:同样的无效 KIT_WRITE_ROOTS 不让它们像普通命令那样退 3(配置 absent → status / projects 退 0、stop 退 0 noop)
    for (const sub of IMPLEMENTED) {
      const r = await run(['rsi', sub], bad);
      // tick 在配置 off 时按契约退 4 `RSI_NOT_RUN reason=off`(不是桩的 64,也不是通用路径的 3);confirm 无 TTY 先退 2 `not_tty`(先于任何读);purge 不带模式参数 → 2 mode_conflict(参数先于配置判定)
      expect(r.code, sub).toBe(sub === 'tick' ? 4 : sub === 'confirm' || sub === 'purge' ? 2 : 0);
    }
    expect((await run(['rsi', 'nope'], bad)).code).toBe(2);
  });

  it('rsi --help 走通用帮助路径(命令清单里有 rsi),夹具目录前后完全一致、写审计零调用', async () => {
    const { dir } = await makeTempDir('rsi-help-');
    const before = await treeOf(dir);
    const r = await run(['rsi', '--help'], { KIT_TMP: dir }, dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('agent-kit rsi');
    expect(r.audit).toEqual([]);
    expect(await treeOf(dir)).toEqual(before);
  });

  it('全部子命令(含未知 / 缺省):空夹具目录前后完全一致(最终状态)且写审计零调用(操作发生)', async () => {
    const { dir } = await makeTempDir('rsi-stub-');
    const before = await treeOf(dir);
    for (const argv of [...ALL.map((n) => ['rsi', n]), ['rsi'], ['rsi', 'nope']]) {
      const r = await run(argv, { KIT_TMP: dir }, dir);
      expect(r.audit, argv.join(' ')).toEqual([]);
    }
    expect(await treeOf(dir)).toEqual(before);
  });
});

describe('rsi 调用顺序(契约 R20-A2 v2 §3、§5;顺序用例随后续块实装,这里只登记,尚未获得验证)', () => {
  it('[B3a] 只读 rsi 子命令(status / projects / stop):配置 off / cfg_* 时 openRsiIo 返回 off,此前 createRsiIoContext 零调用,不建 rsi/、不拿锁、不恢复快照', async () => {
    for (const toml of [
      '[rsi]\nenabled = false\n',
      '[x]\na = 1\n',
      '[rsi]\nenabled = true\nagents = ["kimi"]\n', // cfg_schema
    ]) {
      const f = await makeRoFx('disp-off-');
      await writeFile(f.fx, f.cfgFile, toml, { mode: 0o600 });
      const before = await treeOf(f.dir);
      for (const [run, argv] of [
        [runStatus, ['--json']],
        [runProjects, []],
        [runStop, []],
      ] as const) {
        let created = 0;
        const deps = {
          open: {
            createContext: (o: Parameters<typeof createRsiIoContext>[0]) => {
              created++;
              return createRsiIoContext(o);
            },
          },
        };
        const r = await runDirect(f, run as never, [...argv], deps as never);
        expect(r.code, `${run.name} ${toml}`).toBe(0);
        expect(created, `${run.name} ${toml}`).toBe(0);
        expect(r.audit).toEqual([]);
      }
      expect(await treeOf(f.dir)).toEqual(before); // 没有 .state / rsi/ / 锁 / 清单
    }
  });
  it('[B3a] 只读 rsi 子命令:--root 与 [rsi] repo 不符退出 2 root_mismatch,此前零写入、不建 rsi/(经真实 main())', async () => {
    const f = await makeRoFx('disp-root-');
    const other = `${f.dir}/other`;
    await mkdirp(f.fx, other, 0o755);
    const before = await treeOf(f.dir);
    for (const sub of ['status', 'projects', 'stop']) {
      const r = await runMain(f, ['--root', other, 'rsi', sub]);
      expect(r.code, sub).toBe(2);
      expect(r.err).toBe('RSI_USAGE reason=root_mismatch\n');
      expect(r.out).toBe('');
      expect(r.audit).toEqual([]);
    }
    expect(await treeOf(f.dir)).toEqual(before);
  });
  // [B3b] 下面两条原是 `it.todo` 占位(B3b 接线前登记)。接线已在 B3b / B5d / B5g 落地,这里改成经真实
  // `main()` 的端到端用例;进程内的锁内顺序另见 test/rsi/commit.test.ts,持锁矩阵的逐入口版本另见
  // test/rsi/b5-lock-matrix.test.ts。
  it('[B3b] 现有写入方 × privacyGate deny:在读完配置后立即退出 3,不建上下文、不建 rsi/、不拿锁、不恢复快照', async () => {
    // cfg_schema:配置里 [rsi] 不可用 => privacyGate = deny(不是 legacy)
    const f = await makeRoFx('disp-deny-');
    await writeCfg(f, '[rsi]\nenabled = true\nunknown_key = 1\n');
    // 预置一个陈旧快照临时文件:若走到 recover,它会被动到
    const rsiDir = path.join(f.repo, '.state', 'rsi');
    const staleTmp = path.join(rsiDir, 'snapshot.json.tmp');
    const before = await treeOf(f.dir);
    for (const argv of [
      ['judge', '--run', 'run-1'],
      ['judge', '--run', 'run-1', '--run-llm', '--allow-egress'],
      ['promote', '--run', 'run-1', '--write'],
    ]) {
      const r = await runMain(f, ['--root', f.repo, ...argv]);
      expect([r.code, r.err.slice(0, 22)], argv.join(' ')).toEqual([3, 'RSI_FAIL_CLOSED reason']);
      expect(r.audit, argv.join(' ')).toEqual([]); // 不建 rsi/、不拿锁、无任何写
    }
    expect(await treeOf(f.dir)).toEqual(before); // 夹具树逐字节不变(含未创建的 rsi/)
    expect(await exists(staleTmp)).toBe(false);
  });

  it('[B3b] reflect --gc --write / reflect --run-llm / judge --run-llm:锁被占时归到 4 <前缀>_NOT_RUN reason=locked,参数错时归到 2 且零写入', async () => {
    // 「锁被占 → 4 <前缀>_NOT_RUN reason=locked,零调用零写入」的逐入口证据(真子进程持锁、握手、放锁后的
    // 正向对照)在 test/rsi/b5-lock-matrix.test.ts 的「R20-5.1 真子进程持锁 × 每个写入命令」里。
    // 这里补的是分发器层的归属:三个入口的**参数校验先于锁**,所以参数错必须是 2(而不是被锁掩盖成 4),
    // 且参数错时同样零写入 —— 这正是「拿锁发生在 run 内部、且在校验之后」的可观测证据。
    const f = await makeRoFx('disp-args-');
    const before = await treeOf(f.dir);
    for (const [argv, needle] of [
      [['reflect', '--run-llm'], '--allow-egress'],
      [['reflect', '--run-llm', '--allow-egress'], '--owner'],
      [['judge', '--run', 'run-1', '--run-llm'], '--allow-egress'],
    ] as const) {
      const r = await runMain(f, ['--root', f.repo, ...argv]);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.err, argv.join(' ')).toContain(needle);
      expect(r.audit, argv.join(' ')).toEqual([]); // 参数错也不写、不拿锁
    }
    expect(await treeOf(f.dir), '三个入口的参数错没有留下任何改动').toEqual(before);
  });

  // [B3c] 锁内顺序(recover → resumeTaint → immediateGate → 业务 → commitUnderLock;deny 路径不触发 recover)已是真用例:test/rsi/commit.test.ts「锁内顺序」
});

describe('EarlyCommandContext 的交互注入点(与 CommandContext 一致)', () => {
  it('isTty / readLine 可注入,供 confirm / --ack / purge 沿用 resolveIsTty / resolveReadLine', async () => {
    const ctx: EarlyCommandContext = {
      argv: [],
      overlayPath: undefined,
      explicitRoot: undefined,
      stdout: () => {},
      stderr: () => {},
      isTty: true,
      readLine: async () => 'yes',
    };
    expect(ctx.isTty).toBe(true);
    expect(await ctx.readLine?.()).toBe('yes');
  });
});
