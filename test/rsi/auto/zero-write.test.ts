/**
 * W8a 只读命令的零写入证据(contracts R21-12.1、§21.24 W0-22 第 6 条):
 *  - `auto status` / `report`:不用 git,保持原四层证据中的 ①(写调用审计)与 ③(import 闭包不含 exec / safe-fs / home-fs / 锁)与 ④(闭包里没有 `runSync` / `runGitClosed`);
 *  - `show` / `auto clear` 干跑 / `rollback --to` 干跑:③ ④ 改为「业务模块闭包仍禁 exec / safe-fs / home-fs / 锁,只有适配器单文件放行子进程,且它自己的闭包没有写出口」;
 *    替代证据 (a)(b) 见 `git-readonly.test.ts`(spawn 间谍记录 argv / env / cwd;真仓库前后整目录快照逐字节相同)。
 *  - 本文件:静态闭包 + 生产只读端口在假 HOME 上的运行期审计(外部累计的写调用为空、目录树前后相同,带「故意写一次」的正向对照)。
 * 未覆盖(如实记录):② 子进程 `KIT_WRITE_ROOTS=:` 与 (c)——当前相位 0 下经 `main()` 的新命令全是桩,子进程辅助脚本不能注入相位;留待 W10 提升相位后补。
 */
import { ESLint } from 'eslint';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDir, readText } from '../../../src/io/read-fs.js';
import { runAutoFamily } from '../../../src/rsi/auto/entry.js';
import { mkdirp, writeFile } from '../../../src/io/safe-fs.js';
import { REPO_ROOT } from '../../helpers/tmp.js';
import {
  ROOT,
  closureOf,
  externalSpecs,
  fsWriteUses,
  identHits,
  importersOf,
} from '../closure-util.js';
import { makeRoFx, runDirect, runMain, type RoFx } from '../ro-fixture.js';
import { treeOf } from '../rsi-fixture.js';
import { viewOf } from './auto-fixture.js';

const READ_ENTRIES = [
  'src/rsi/auto/read/status.ts',
  'src/rsi/auto/read/report.ts',
  'src/rsi/auto/read/show.ts',
  'src/rsi/auto/read/clear-dry.ts',
  'src/rsi/auto/read/rollback-dry.ts',
  'src/rsi/auto/select-rollback.ts',
];
const ADAPTER = 'src/rsi/personal/read/git-readonly.ts';
const HOME_READS = 'src/rsi/personal/read/home-reads.ts';

/** 业务读侧闭包里禁止出现的文件(写出口 / 锁 / 子进程出口 / 回滚写模块 / 暂停标记写端口) */
const FORBIDDEN_FILES = [
  'src/io/safe-fs.ts',
  'src/io/home-fs.ts',
  'src/io/exec.ts',
  'src/io/llm-exec.ts',
  'src/io/net.ts',
  'src/rsi/lock.ts',
  'src/rsi/snapshot.ts',
  'src/rsi/with-lock.ts',
  'src/rsi/rsi-dir.ts',
  'src/rsi/services/commit.ts',
  'src/rsi/services/taint.ts',
  'src/rsi/personal/home-state.ts',
  'src/rsi/personal/rollback.ts',
  'src/rsi/personal/rollback-ports.ts',
  'src/rsi/personal/rollback-journal.ts',
  'src/rsi/personal/revoke-write.ts',
  'src/rsi/personal/clear.ts',
  'src/rsi/personal/commit.ts',
  'src/rsi/personal/personal-lock.ts',
  'src/rsi/canary/pause-marker.ts',
  'src/rsi/auto/deps.ts',
  'src/rsi/auto/entry.ts',
  'src/rsi/auto/exit-map.ts',
  ADAPTER,
];
const WRITE_IDENTS = [
  'acquireRsiLock',
  'acquirePersonalLock',
  'withRsiLock',
  'withRsiLockIfGated',
  'recoverSnapshot',
  'commitSnapshot',
  'commitUnderLock',
  'createExclusive',
  'appendFile',
  'mkdirp',
  'runSync',
  'runSelf',
  'runGitClosed',
  'spawnSync',
  'writeTxn',
  'removeTxn',
];
const ALLOWED_EXTERNALS = [
  'node:crypto',
  'node:fs',
  'node:fs/promises',
  'node:os',
  'node:path',
  'smol-toml',
  'zod',
];

describe('③ ④ 静态:业务读侧的 import 闭包(运行时依赖与含类型依赖两种口径)', () => {
  for (const entry of READ_ENTRIES) {
    for (const includeTypes of [false, true]) {
      it(`${entry}(${includeTypes ? '含类型依赖' : '运行时依赖'}):不含写出口 / 锁 / 子进程出口 / 适配器,无写相关标识符,无动态 import`, () => {
        const c = closureOf([entry], { includeTypes });
        expect(
          [...c.files].filter((f) => FORBIDDEN_FILES.includes(f) || f.startsWith('src/update/')),
        ).toEqual([]);
        expect(identHits(c, WRITE_IDENTS)).toEqual([]);
        expect(c.dynamic).toEqual([]);
        expect(c.unresolved).toEqual([]);
        expect(externalSpecs(c).filter((e) => !ALLOWED_EXTERNALS.includes(e))).toEqual([]);
        expect(externalSpecs(c)).not.toContain('node:child_process');
        for (const spec of ['node:fs', 'node:fs/promises']) {
          expect(importersOf(c, spec).filter((f) => f !== 'src/io/read-fs.ts')).toEqual([]);
        }
      });
    }
  }

  it('适配器单文件:闭包里没有任何写出口 / 子进程模块(spawn 是注入端口);自己没有写类 fs 成员;配置预检只用 read-fs', async () => {
    for (const includeTypes of [false, true]) {
      const c = closureOf([ADAPTER], { includeTypes });
      expect([...c.files].filter((f) => FORBIDDEN_FILES.includes(f) && f !== ADAPTER)).toEqual([]);
      expect(identHits(c, WRITE_IDENTS)).toEqual([]);
      expect(externalSpecs(c)).not.toContain('node:child_process');
      expect(c.dynamic).toEqual([]);
    }
    expect(fsWriteUses(ADAPTER, await readText(path.join(ROOT, ADAPTER)))).toEqual([]);
  });

  it('HOME 侧读端口(home-reads.ts)同样没有写出口', () => {
    const c = closureOf([HOME_READS], { includeTypes: true });
    expect([...c.files].filter((f) => FORBIDDEN_FILES.includes(f))).toEqual([]);
    expect(identHits(c, WRITE_IDENTS)).toEqual([]);
  });

  it('生产入口 entry.ts 的传递闭包(运行时与含类型两种口径):除 deps / entry 自己、exec.ts(runGitClosed)与适配器外,不含任何写出口 / 锁 / 回滚写模块', () => {
    const allowed = new Set([
      'src/rsi/auto/entry.ts',
      'src/rsi/auto/deps.ts',
      'src/io/exec.ts',
      ADAPTER,
    ]);
    for (const includeTypes of [false, true]) {
      const c = closureOf(['src/rsi/auto/entry.ts'], { includeTypes });
      expect([...c.files].filter((f) => FORBIDDEN_FILES.includes(f) && !allowed.has(f))).toEqual(
        [],
      );
      expect(c.dynamic).toEqual([]);
      expect(c.unresolved).toEqual([]);
      expect(importersOf(c, 'node:child_process')).toEqual(['src/io/exec.ts']);
      // 写命令的处理函数表 / 生产写端口 / 装配入口只经 `commands.ts` 进来,读侧入口的闭包里一个都不能有
      expect(
        [...c.files].filter(
          (f) =>
            f.startsWith('src/rsi/auto/write/') ||
            f === 'src/rsi/auto/deps-write.ts' ||
            f === 'src/rsi/auto/commands.ts',
        ),
      ).toEqual([]);
    }
  });

  it('写侧装配入口 commands.ts 的闭包确实含写处理函数表与写出口(对照:拆分后写模块在分发器那一侧,不是丢了);分发器经它取五个子命令', () => {
    const c = closureOf(['src/rsi/auto/commands.ts']);
    expect(c.files.has('src/rsi/auto/entry.ts')).toBe(true);
    expect(c.files.has('src/rsi/auto/write/index.ts')).toBe(true);
    expect(c.files.has('src/rsi/auto/deps-write.ts')).toBe(true);
    expect(c.files.has('src/rsi/personal/clear.ts')).toBe(true);
    expect(c.dynamic).toEqual([]);
    const d = closureOf(['src/commands/rsi.ts']);
    expect(d.files.has('src/rsi/auto/commands.ts')).toBe(true);
  });

  it('对照:deps.ts / entry.ts 的闭包确实含适配器与 exec.ts(审计工具不是空转);exit-map 属写命令一侧,不在读闭包里', () => {
    const c = closureOf(['src/rsi/auto/entry.ts']);
    expect(c.files.has(ADAPTER)).toBe(true);
    expect(c.files.has('src/io/exec.ts')).toBe(true);
    expect(identHits(c, ['runGitClosed']).length).toBeGreaterThan(0);
  });

  it('`runGitClosed` 在 src/rsi/** 内只有 deps.ts 引用(AST 级扫描 + 真实 eslint 夹具:其它路径 import 即红,deps.ts 放行)', async () => {
    const files: string[] = [];
    const walk = async (rel: string): Promise<void> => {
      for (const e of await readDir(path.join(REPO_ROOT, rel))) {
        const r = `${rel}/${e.name}`;
        if (e.isDirectory) await walk(r);
        else if (e.isFile && r.endsWith('.ts')) files.push(r);
      }
    };
    await walk('src/rsi');
    const importing: string[] = [];
    for (const f of files) {
      const src = await readText(path.join(REPO_ROOT, f));
      if (/import\s*(type\s*)?\{[^}]*\brunGitClosed\b[^}]*\}\s*from/.test(src)) importing.push(f);
      if (/export\s*\{[^}]*\brunGitClosed\b[^}]*\}\s*from/.test(src))
        importing.push(`${f}(re-export)`);
    }
    expect(importing).toEqual(['src/rsi/auto/deps.ts']);

    const eslint = new ESLint({ cwd: REPO_ROOT });
    const lintAs = async (code: string, rel: string) => {
      const [res] = await eslint.lintText(code, { filePath: path.join(REPO_ROOT, rel) });
      return (res?.messages ?? []).filter((m) => m.ruleId?.startsWith('no-restricted'));
    };
    const NAMED =
      "import { runGitClosed } from '../../io/exec.js';\nexport const r = runGitClosed;\n";
    expect(await lintAs(NAMED, 'src/rsi/auto/deps.ts')).toEqual([]);
    // 两个出口的授权互不相通:deps.ts 不得 import runSync;既有三个 git 文件不得 import runGitClosed
    const SYNC = "import { runSync } from '../../io/exec.js';\nexport const r = runSync;\n";
    expect((await lintAs(SYNC, 'src/rsi/auto/deps.ts')).length).toBeGreaterThan(0);
    for (const f of ['commit.ts', 'commit-journal.ts', 'repo-check.ts']) {
      expect((await lintAs(NAMED, `src/rsi/personal/${f}`)).length, f).toBeGreaterThan(0);
    }
    for (const bad of [
      'src/rsi/auto/read/status.ts',
      'src/rsi/personal/read/x.ts',
      'src/rsi/auto/exit-map.ts',
      'src/rsi/worker.ts',
    ]) {
      expect((await lintAs(NAMED, bad)).length, bad).toBeGreaterThan(0);
    }
  }, 120_000);
});

describe('① 运行期:生产只读端口 + 假 HOME(写调用审计外部累计 + 目录树前后相同)', () => {
  async function populated(): Promise<RoFx> {
    const f = await makeRoFx('w8a-zw-');
    const rsiDir = path.join(f.io.stateDir, 'rsi');
    await mkdirp(f.io, rsiDir, 0o700);
    const view = viewOf({
      as_of: new Date().toISOString(),
      pipeline: { states: {}, last30d: { rejected: 0, rolled_back: 0, expired: 0, retired: 0 } },
    });
    await writeFile(f.io, path.join(rsiDir, 'auto-view.json'), JSON.stringify(view), {
      mode: 0o600,
    });
    await writeFile(f.io, path.join(rsiDir, 'audit.jsonl'), '', { mode: 0o600 });
    return f;
  }

  const CASES: [string, string[]][] = [
    ['auto', ['status']],
    ['auto', ['status', '--json']],
    ['auto', ['clear']],
    ['auto', ['clear', '--json']],
    ['report', []],
    ['report', ['--json', '--since', '2026-01-01']],
    ['show', ['ra_0123456789ab']],
    ['rollback', ['--to', '2026-11-01']],
    ['rollback', ['--to', '2026-11-01', '--json']],
  ];

  it('相位 1 下全部读命令经注入的相位跑到处理函数:退出码符合预期、写审计为空、目录树前后相同', async () => {
    const f = await populated();
    // 能力 cmd_rollback_to 属 V1b:相位 2 才不是桩
    const before = await treeOf(f.dir);
    const seen: Record<string, number> = {};
    const all: string[] = [];
    for (const [family, argv] of CASES) {
      const r = await runDirect(
        f,
        (ctx, d: { phase: number }) =>
          runAutoFamily(family as 'auto' | 'report' | 'show' | 'rollback', ctx, d),
        argv,
        { phase: 2 },
        { isTty: true },
      );
      seen[`${family} ${argv.join(' ')}`] = r.code;
      all.push(...r.audit.map((a) => `${family} ${argv.join(' ')} => ${a.op} ${a.path}`));
      expect(r.code, `${family} ${argv.join(' ')}: ${r.err}`).not.toBe(64);
    }
    expect(all).toEqual([]);
    expect(await treeOf(f.dir)).toEqual(before);
    // 正向前提:命令确实读到了数据而不是都在报错
    expect(seen['auto status']).toBe(0);
    expect(seen['report ']).toBe(0);
    expect(seen['auto clear']).toBe(0);
    expect(seen['rollback --to 2026-11-01']).toBe(0);
    expect(seen['show ra_0123456789ab']).toBe(2); // 没有私有仓库 = 没有候选 = unknown_id
  });

  it('对照:同一写审计钩子与同一夹具下 `rsi stop` 会被记到写调用(钩子确实接在命令上)', async () => {
    const f = await populated();
    const r = await runMain(f, ['rsi', 'stop']);
    expect(r.code).toBe(0);
    expect(r.audit.length).toBeGreaterThan(0);
  });
});
