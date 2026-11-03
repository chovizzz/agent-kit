/**
 * A5(contracts §20.15-2 R20-15.5–15.7):`kit-hooks` 条目的授权边界——红绿对。
 *  - sync payload 写这三条路径 → 拒;通用 home-fs 原语(writeFile / remove / createExclusive / chmod / rename / copyFile / mkdirp / removeDir / renameDir)
 *    对三个目标与整个 `hooks/` 私有状态子树一律拒;
 *  - 自动入口(poke / hint / worker / kit-schedule / hook-entry)与 sync / update 的 import 闭包不含 `src/rsi/hooks/**` 与 `src/io/hooks-fs.ts`;
 *  - 全仓只有 `src/rsi/hooks/**` 引用 hooks-fs(静态扫描,补 eslint 闸)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HOME_WRITE_TABLE,
  ManagedPathSchema,
  PayloadFileSchema,
  isHomeWritePath,
  isKitHooksReserved,
} from '../../../src/contracts/index.js';
import * as hfs from '../../../src/io/home-fs.js';
import { HOME_DENY, HomeWriteDeniedError } from '../../../src/io/home-fs.js';
import { exists, readDir, readText } from '../../../src/io/read-fs.js';
import * as safe from '../../../src/io/safe-fs.js';
import { REPO_ROOT, makeTempDir, wideCtx } from '../../helpers/tmp.js';
import { closureOf } from '../closure-util.js';

const KIT_HOOKS_PATHS = [
  '.claude/settings.json',
  '.codex/hooks.json',
  '.pi/agent/extensions/agent-kit-rsi.ts',
];
const STATE_PATHS = [
  '.local/state/agent-kit/hooks/ledger.json',
  '.local/state/agent-kit/hooks/ledger.established',
  '.local/state/agent-kit/hooks/txn/20261102T120000Z-0000000000000001.json',
  '.local/state/agent-kit/hooks/backups/20261102T120000Z-0000000000000001/claude',
  // 大小写别名(评审采纳):大小写不敏感的卷上它们与上面是同一批文件,不能借 kit 目录条目的通用授权绕过独占
  '.local/state/agent-kit/HOOKS/ledger.json',
  '.local/state/agent-kit/Hooks/txn/20261102T120000Z-0000000000000001.json',
];

describe('HOME_WRITE_TABLE 与 isHomeWritePath(R20-15.5)', () => {
  it('三条 kit-hooks(json-merge ×2、file ×1),总数 15;无 owner 的 isHomeWritePath 不把它们算作受管路径', () => {
    expect(HOME_WRITE_TABLE).toHaveLength(15);
    for (const p of KIT_HOOKS_PATHS) {
      expect(HOME_WRITE_TABLE.find((e) => e.path === p)?.owner, p).toBe('kit-hooks');
      expect(isHomeWritePath(p), p).toBe(false);
      expect(isHomeWritePath(p, 'adapter'), p).toBe(false);
      expect(isHomeWritePath(p, 'kit-hooks'), p).toBe(true);
      expect(isKitHooksReserved(p), p).toBe(true);
      expect(isHomeWritePath(`${p}/x`, 'kit-hooks'), p).toBe(false);
      expect(ManagedPathSchema.safeParse(p).success, p).toBe(false);
    }
    // 状态子树属于 kit 条目(表里的目录),但被专用出口独占
    for (const p of STATE_PATHS) {
      expect(isHomeWritePath(p), p).toBe(true);
      expect(isKitHooksReserved(p), p).toBe(true);
    }
    expect(isKitHooksReserved('.local/state/agent-kit/hooks')).toBe(true);
    expect(isKitHooksReserved('.local/state/agent-kit/HOOKS')).toBe(true);
    expect(isKitHooksReserved('.local/state/agent-kit/Hooks/backups/x')).toBe(true);
    expect(isKitHooksReserved('.local/state/agent-kit/sync/lock')).toBe(false);
    expect(isKitHooksReserved('.local/state/agent-kit/hooksx')).toBe(false);
  });

  it('sync payload 写这三条路径 → 拒(PayloadFile 只收 adapter 条目);对照:adapter 路径通过', () => {
    const base = {
      agent: 'claude',
      target: 'home',
      mode: 'owned',
      kind: 'skill',
      confidence: 'documented',
      sha256: 'a'.repeat(64),
      bytes: 1,
      payload_path: 'claude/x',
      atoms: [],
    };
    for (const p of KIT_HOOKS_PATHS) {
      expect(PayloadFileSchema.safeParse({ ...base, path: p }).success, p).toBe(false);
    }
    expect(
      PayloadFileSchema.safeParse({ ...base, path: '.claude/skills/x/SKILL.md' }).success,
    ).toBe(true);
  });
});

describe('通用 home-fs 原语对 kit-hooks 条目与 hooks/ 私有状态子树一律拒绝(R20-15.6)', () => {
  async function setup(): Promise<{ ctx: hfs.HomeFsContext; home: string }> {
    const { ctx, dir } = await makeTempDir('a5-gate-');
    const fx = wideCtx(dir);
    const home = path.join(dir, 'home');
    await safe.mkdirp(fx, home);
    const tmpDir = ctx.tmpDir ?? path.join(ctx.stateDir, 'test-tmp');
    // planScope 里放一个合法文件,保证 ctx 能创建;被测路径都不在 scope 里也不在表里
    return {
      ctx: hfs.createHomeFsContext({
        home,
        planScope: ['.codex/AGENTS.md', '.local/state/agent-kit/other/f'],
        tmpDir,
      }),
      home,
    };
  }
  const deny = async (p: Promise<unknown>): Promise<void> => {
    const err = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HomeWriteDeniedError);
    expect((err as HomeWriteDeniedError).code).toBe(HOME_DENY.KIT_HOOKS);
  };

  it('createHomeFsContext:planScope 里放 kit-hooks 路径 → SCOPE_INVALID', async () => {
    const { ctx, dir } = await makeTempDir('a5-gate-scope-');
    const home = path.join(dir, 'home');
    await safe.mkdirp(wideCtx(dir), home);
    const tmpDir = ctx.tmpDir ?? path.join(ctx.stateDir, 'test-tmp');
    for (const p of [...KIT_HOOKS_PATHS, ...STATE_PATHS]) {
      let err: unknown;
      try {
        hfs.createHomeFsContext({ home, planScope: [p], tmpDir });
      } catch (e) {
        err = e;
      }
      expect(err, p).toBeInstanceOf(HomeWriteDeniedError);
      expect((err as HomeWriteDeniedError).code, p).toBe(HOME_DENY.SCOPE_INVALID);
    }
  });

  it('writeFile / remove / createExclusive / chmod / rename / copyFile 两端都拒', async () => {
    const { ctx } = await setup();
    for (const p of [...KIT_HOOKS_PATHS, ...STATE_PATHS]) {
      await deny(hfs.writeFile(ctx, p, 'x'));
      await deny(hfs.remove(ctx, p));
      await deny(hfs.createExclusive(ctx, p, 'x', { mode: 0o600 }));
      await deny(hfs.chmod(ctx, p, 0o600));
      await deny(hfs.rename(ctx, p, '.codex/AGENTS.md'));
      await deny(hfs.rename(ctx, '.codex/AGENTS.md', p));
      await deny(hfs.copyFile(ctx, p, '.codex/AGENTS.md'));
      await deny(hfs.copyFile(ctx, '.codex/AGENTS.md', p));
    }
  });

  it('mkdirp / removeDir / renameDir 对 hooks/ 子树的目录一律拒', async () => {
    const { ctx } = await setup();
    for (const d of [
      '.local/state/agent-kit/hooks',
      '.local/state/agent-kit/hooks/txn',
      '.local/state/agent-kit/hooks/backups/20261102T120000Z-0000000000000001',
    ]) {
      await deny(hfs.mkdirp(ctx, d));
      await deny(hfs.removeDir(ctx, d));
      await deny(hfs.renameDir(ctx, d, '.local/state/agent-kit/other'));
      await deny(hfs.renameDir(ctx, '.local/state/agent-kit/other', d));
    }
  });

  it('对照:同一个 ctx 写合法的 adapter 路径照常成功(闸不是把一切都拒了)', async () => {
    const { ctx, home } = await setup();
    await hfs.writeFile(ctx, '.codex/AGENTS.md', 'ok\n');
    expect(await exists(path.join(home, '.codex/AGENTS.md'))).toBe(true);
  });
});

describe('import 闭包(R20-15.7):自动入口与 sync / update 不引用钩子写原语', () => {
  const HOOKS_PREFIX = 'src/rsi/hooks/';
  const HOOKS_FS = 'src/io/hooks-fs.ts';
  const clean = (entry: string): void => {
    const c = closureOf([entry], { includeTypes: true });
    expect(c.unresolved, entry).toEqual([]);
    const bad = [...c.files].filter((f) => f.startsWith(HOOKS_PREFIX) || f === HOOKS_FS);
    expect(bad, entry).toEqual([]);
  };

  it('poke / hint / worker / kit-schedule / hook-entry 的闭包不含 src/rsi/hooks/** 与 hooks-fs', () => {
    for (const e of [
      'src/rsi/poke.ts',
      'src/rsi/hint.ts',
      'src/rsi/worker.ts',
      'src/rsi/kit-schedule.ts',
      'src/rsi/hook-entry.ts',
    ]) {
      clean(e);
    }
  });

  it('sync / autosync / update 入口的闭包同样不含', () => {
    for (const e of [
      'src/sync/apply.ts',
      'src/commands/sync.ts',
      'src/update/autosync.ts',
      'src/update/install.ts',
      'src/update/worker.ts',
      'src/update/launcher.ts',
    ]) {
      clean(e);
    }
  });

  it('正向对照:分发器的闭包确实包含 hooks(检查器不是空跑)', () => {
    const c = closureOf(['src/commands/rsi.ts']);
    expect(c.files.has(HOOKS_FS)).toBe(true);
    expect([...c.files].some((f) => f.startsWith(HOOKS_PREFIX))).toBe(true);
  });

  it('检查器自身的对照:偷偷 import 钩子命令的虚拟入口会被抓到', () => {
    const p = 'src/rsi/__sim_sneak_hooks.ts';
    const c = closureOf([p], {
      virtual: {
        [p]: "import { subcommand } from './hooks/command.js';\nexport const x = subcommand;\n",
      },
    });
    expect([...c.files].filter((f) => f.startsWith(HOOKS_PREFIX) || f === HOOKS_FS)).not.toEqual(
      [],
    );
  });

  it('全仓静态扫描:引用 hooks-fs 的文件只有 src/rsi/hooks/** 与测试', async () => {
    const hits: string[] = [];
    const walk = async (rel: string): Promise<void> => {
      for (const e of await readDir(path.join(REPO_ROOT, rel))) {
        const r = `${rel}/${e.name}`;
        if (e.isDirectory) await walk(r);
        else if (
          e.isFile &&
          r.endsWith('.ts') &&
          (await readText(path.join(REPO_ROOT, r))).includes('/hooks-fs.js')
        ) {
          hits.push(r);
        }
      }
    };
    await walk('src');
    expect(hits.length).toBeGreaterThan(0); // 正向前提:扫描确实扫到了引用方
    for (const h of hits) expect(h.startsWith(HOOKS_PREFIX), h).toBe(true);
  });
});
