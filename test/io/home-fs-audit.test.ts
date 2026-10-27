/**
 * R20-A2 B2:home-fs 的写审计钩子(与 safe-fs 的 `IoContext.writeAudit` 同一约定,`test/io/safe-fs-audit.test.ts`)。
 * 记录的是**写尝试**:入口第一行、任何校验之前;被守卫拒绝的调用也记;一个导出函数只记一次(内部共享实现不记)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as hfs from '../../src/io/home-fs.js';
import { CURRENT_LINK_REL, HomeWriteDeniedError } from '../../src/io/home-fs.js';
import { exists, readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { makeTempDir, wideCtx } from '../helpers/tmp.js';
import { withWriteAudit } from '../helpers/write-audit.js';

interface Fx {
  home: string;
  audit: ReturnType<typeof withWriteAudit>;
  mk: (scope: string[], audited?: boolean) => hfs.HomeFsContext;
}

async function setup(prefix: string): Promise<Fx> {
  const { ctx, dir } = await makeTempDir(prefix);
  const home = path.join(dir, 'home');
  await safe.mkdirp(wideCtx(dir), home);
  const tmpDir = ctx.tmpDir ?? path.join(ctx.stateDir, 'test-tmp');
  const audit = withWriteAudit();
  return {
    home,
    audit,
    mk: (scope, audited = true) =>
      hfs.createHomeFsContext({
        home,
        planScope: scope,
        tmpDir,
        ...(audited ? { writeAudit: audit.hook } : {}),
      }),
  };
}

const S = '.local/state/agent-kit';
const SH = '.local/share/agent-kit';

interface Case {
  name: string;
  scope: string[];
  /** 成功调用前的准备(不记审计:用不带钩子的上下文) */
  prep?: (fx: Fx) => Promise<void>;
  ok: (ctx: hfs.HomeFsContext) => Promise<unknown>;
  expected: readonly (readonly [op: string, rel: string])[];
  denied: (ctx: hfs.HomeFsContext, fx: Fx) => Promise<unknown>;
  deniedExpected: readonly (readonly [op: string, rel: string])[];
}

const cases: Case[] = [
  {
    name: 'writeFile',
    scope: ['.codex/AGENTS.md'],
    ok: (c) => hfs.writeFile(c, '.codex/AGENTS.md', 'x'),
    expected: [['home.writeFile', '.codex/AGENTS.md']],
    denied: (c) => hfs.writeFile(c, '.ssh/authorized_keys', 'x'),
    deniedExpected: [['home.writeFile', '.ssh/authorized_keys']],
  },
  {
    name: 'mkdirp',
    scope: [`${S}/x/f`],
    ok: (c) => hfs.mkdirp(c, `${S}/x`),
    expected: [['home.mkdirp', `${S}/x`]],
    denied: (c) => hfs.mkdirp(c, '.ssh'),
    deniedExpected: [['home.mkdirp', '.ssh']],
  },
  {
    name: 'remove',
    scope: ['.codex/AGENTS.md'],
    ok: (c) => hfs.remove(c, '.codex/AGENTS.md'),
    expected: [['home.remove', '.codex/AGENTS.md']],
    denied: (c) => hfs.remove(c, '.ssh/x'),
    deniedExpected: [['home.remove', '.ssh/x']],
  },
  {
    name: 'removeDir',
    scope: [`${S}/x/f`],
    ok: (c) => hfs.removeDir(c, `${S}/x`),
    expected: [['home.removeDir', `${S}/x`]],
    denied: (c) => hfs.removeDir(c, '.ssh'),
    deniedExpected: [['home.removeDir', '.ssh']],
  },
  {
    name: 'rename(来源 + 目标各一条,来源先)',
    scope: [`${S}/a`, `${S}/b`],
    prep: async (fx) => hfs.writeFile(fx.mk([`${S}/a`], false), `${S}/a`, 'a'),
    ok: (c) => hfs.rename(c, `${S}/a`, `${S}/b`),
    expected: [
      ['home.rename.from', `${S}/a`],
      ['home.rename', `${S}/b`],
    ],
    denied: (c) => hfs.rename(c, `${S}/a`, '.ssh/b'),
    deniedExpected: [
      ['home.rename.from', `${S}/a`],
      ['home.rename', '.ssh/b'],
    ],
  },
  {
    name: 'chmod',
    scope: [`${S}/m`],
    prep: async (fx) => hfs.writeFile(fx.mk([`${S}/m`], false), `${S}/m`, 'm'),
    ok: (c) => hfs.chmod(c, `${S}/m`, 0o600),
    expected: [['home.chmod', `${S}/m`]],
    denied: (c) => hfs.chmod(c, '.ssh/m', 0o600),
    deniedExpected: [['home.chmod', '.ssh/m']],
  },
  {
    name: 'copyFile(来源 + 目标各一条)',
    scope: [`${S}/s`, `${S}/d`],
    prep: async (fx) => hfs.writeFile(fx.mk([`${S}/s`], false), `${S}/s`, 's'),
    ok: (c) => hfs.copyFile(c, `${S}/s`, `${S}/d`),
    expected: [
      ['home.copyFile.from', `${S}/s`],
      ['home.copyFile', `${S}/d`],
    ],
    denied: (c) => hfs.copyFile(c, `${S}/s`, '.ssh/d'),
    deniedExpected: [
      ['home.copyFile.from', `${S}/s`],
      ['home.copyFile', '.ssh/d'],
    ],
  },
  {
    name: 'createExclusive',
    scope: [`${S}/lock`],
    ok: (c) => hfs.createExclusive(c, `${S}/lock`, 'x'),
    expected: [['home.createExclusive', `${S}/lock`]],
    denied: (c) => hfs.createExclusive(c, '.ssh/lock', 'x'),
    deniedExpected: [['home.createExclusive', '.ssh/lock']],
  },
  {
    name: 'renameDir(来源 + 目标各一条)',
    scope: [`${SH}/staging/s1/f`, `${SH}/versions/1.0.0/f`],
    prep: async (fx) => hfs.mkdirp(fx.mk([`${SH}/staging/s1/f`], false), `${SH}/staging/s1`),
    ok: (c) => hfs.renameDir(c, `${SH}/staging/s1`, `${SH}/versions/1.0.0`),
    expected: [
      ['home.renameDir.from', `${SH}/staging/s1`],
      ['home.renameDir', `${SH}/versions/1.0.0`],
    ],
    denied: (c) => hfs.renameDir(c, `${SH}/staging/s1`, '.ssh/x'),
    deniedExpected: [
      ['home.renameDir.from', `${SH}/staging/s1`],
      ['home.renameDir', '.ssh/x'],
    ],
  },
  {
    name: 'switchCurrent(记链接位置)',
    scope: [CURRENT_LINK_REL],
    prep: async (fx) =>
      hfs.mkdirp(fx.mk([`${SH}/versions/1.0.0/f`], false), `${SH}/versions/1.0.0`),
    ok: (c) => hfs.switchCurrent(c, '1.0.0'),
    expected: [['home.switchCurrent', CURRENT_LINK_REL]],
    // 计划范围里没有 current 链接:被拒
    denied: (_c, fx) => hfs.switchCurrent(fx.mk([`${S}/other`]), '1.0.0'),
    deniedExpected: [['home.switchCurrent', CURRENT_LINK_REL]],
  },
];

describe('home-fs 写审计:每个导出写函数调用一次记一次', () => {
  for (const c of cases) {
    it(`${c.name}:成功调用的 op 与路径正确,且只记一次`, async () => {
      const fx = await setup('hfs-audit-ok-');
      await c.prep?.(fx);
      const ctx = fx.mk(c.scope);
      fx.audit.reset();
      await c.ok(ctx);
      expect(fx.audit.calls.map((x) => [x.op, x.path])).toEqual(
        c.expected.map(([op, rel]) => [op, path.join(fx.home, rel)]),
      );
    });

    it(`${c.name}:被守卫拒绝的调用也被记下,且仍抛 HomeWriteDeniedError`, async () => {
      const fx = await setup('hfs-audit-deny-');
      await c.prep?.(fx);
      const ctx = fx.mk(c.scope);
      fx.audit.reset();
      await expect(c.denied(ctx, fx)).rejects.toBeInstanceOf(HomeWriteDeniedError);
      expect(fx.audit.calls.map((x) => [x.op, x.path])).toEqual(
        c.deniedExpected.map(([op, rel]) => [op, path.join(fx.home, rel)]),
      );
    });
  }

  it('tightenKitStateDir:干跑(apply=false)不记、不写;apply=true 记一次', async () => {
    const fx = await setup('hfs-audit-tighten-');
    const ctx = fx.mk([]);
    fx.audit.reset();
    expect(await hfs.tightenKitStateDir(ctx, false)).toEqual({ result: 'absent' });
    expect(fx.audit.calls).toEqual([]);
    expect(await hfs.tightenKitStateDir(ctx, true)).toEqual({ result: 'absent' });
    expect(fx.audit.calls.map((x) => [x.op, x.path])).toEqual([
      ['home.tightenKitStateDir', path.join(fx.home, S)],
    ]);
  });

  it('入口第一行记录:非法 rel(绝对路径、非字符串)也记下字面解析结果,且不改变抛错', async () => {
    const fx = await setup('hfs-audit-bad-');
    const ctx = fx.mk([`${S}/f`]);
    fx.audit.reset();
    await expect(hfs.writeFile(ctx, '/etc/passwd', 'x')).rejects.toBeInstanceOf(
      HomeWriteDeniedError,
    );
    await expect(hfs.writeFile(ctx, 123 as unknown as string, 'x')).rejects.toBeInstanceOf(
      HomeWriteDeniedError,
    );
    expect(fx.audit.calls.map((x) => x.path)).toEqual(['/etc/passwd', path.join(fx.home, '123')]);
  });

  it('一个函数内部多次物理写只记一次(writeFile = 临时文件 + rename;copyFile 来源 + 目标 = 2 条)', async () => {
    const fx = await setup('hfs-audit-once-');
    const ctx = fx.mk([`${S}/s`, `${S}/d`]);
    fx.audit.reset();
    await hfs.writeFile(ctx, `${S}/s`, 'x', { mode: 0o600, dirMode: 0o700 });
    expect(fx.audit.calls).toHaveLength(1);
    fx.audit.reset();
    await hfs.copyFile(ctx, `${S}/s`, `${S}/d`);
    expect(fx.audit.calls).toHaveLength(2);
  });
});

describe('home-fs 写审计:未设置时与今天一致', () => {
  it('不设钩子:上下文上没有 writeAudit 键(Object.hasOwn),写入结果不变', async () => {
    const fx = await setup('hfs-audit-off-');
    const off = fx.mk([`${S}/off`], false);
    const on = fx.mk([`${S}/on`]);
    expect(Object.hasOwn(off, 'writeAudit')).toBe(false);
    expect(Object.hasOwn(on, 'writeAudit')).toBe(true);
    await hfs.writeFile(off, `${S}/off`, 'same', { mode: 0o600, dirMode: 0o700 });
    await hfs.writeFile(on, `${S}/on`, 'same', { mode: 0o600, dirMode: 0o700 });
    expect(await readText(path.join(fx.home, S, 'off'))).toBe(
      await readText(path.join(fx.home, S, 'on')),
    );
    expect(await exists(path.join(fx.home, '.ssh'))).toBe(false);
  });

  it('外部累计:调用方吞掉守卫的拒绝,calls 仍记着那次写', async () => {
    const fx = await setup('hfs-audit-swallow-');
    const ctx = fx.mk([`${S}/f`]);
    fx.audit.reset();
    try {
      await hfs.writeFile(ctx, '.ssh/escaped', 'x');
    } catch {
      // 命令吞掉异常
    }
    expect(fx.audit.calls).toEqual([
      { op: 'home.writeFile', path: path.join(fx.home, '.ssh/escaped') },
    ]);
    expect(await exists(path.join(fx.home, '.ssh'))).toBe(false);
  });
});
