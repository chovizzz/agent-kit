/**
 * R20-A0:`UserConfig` 接受 `[rsi]` 段(contracts §20.9 第 1 条 / §20.12 Q1-A;条款 R20-2.6:`[rsi]` 由 rsi 模块分层校验)。
 * 动机:`UserConfigSchema` 是 strictObject,不加 `rsi` 时用户一写 `[rsi]`,`update` 就退出 3 `config_invalid`、后台自动更新停摆。
 * 三种情形逐一钉死(旧配置无 [rsi] / 合法 [rsi] / 非法 [rsi]),update 的退出码与稳定码必须一致;另有反向对照:
 * 其它未知段、`[update]` 自身写错仍是 config_invalid(放宽只限于 `rsi` 这一个键)。worker 与 doctor 共用同一份 schema,一并覆盖。
 */
import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandContext } from '../../src/commands/types.js';
import { UserConfigSchema } from '../../src/contracts/update.js';
import { readText } from '../../src/io/read-fs.js';
import { createBackgroundCommand } from '../../src/update/worker.js';
import {
  FIXED_NOW,
  buildPkg,
  newWorld,
  okVerifier,
  realHomeSnapshot,
  runUpdate,
  stateOf,
  treeOf,
  writeRegistry,
  type World,
} from './install-world.js';
import { put } from './launcher-world.js';

let realBefore: string[] = [];
beforeAll(async () => {
  realBefore = await realHomeSnapshot();
});
afterAll(async () => {
  expect(await realHomeSnapshot()).toEqual(realBefore);
});

const CFG = '.config/agent-kit/config.toml';

async function world(config: string | undefined): Promise<World> {
  const w = await newWorld();
  await writeRegistry(w, { versions: [{ pkg: buildPkg('0.1.1') }], distTags: { latest: '0.1.1' } });
  if (config !== undefined) await put(w, path.join(w.home, CFG), config);
  return w;
}

const VALID_RSI = [
  '[rsi]',
  'enabled = true',
  'repo = "/home/u/agent-kit"',
  'overlay = "/home/u/.config/agent-kit/overlay.toml"',
  'agents = ["claude", "pi"]',
  'exclude_dirs = ["/home/u/clients"]',
  'exclude_names = ["client-x"]',
  '',
].join('\n');

/** 各种在 R20-2.6 分层校验里会失败的 [rsi] —— 对 update 来说都必须无关紧要 */
const INVALID_RSI: Record<string, string> = {
  'enabled 写成字符串': '[rsi]\nenabled = "true"\nrepo = "/r"\n',
  'repo 是相对路径': '[rsi]\nenabled = true\nrepo = "relative/path"\n',
  'agents 含未知值': '[rsi]\nenabled = true\nagents = ["claude", "vim"]\n',
  'exclude_dirs 含相对路径': '[rsi]\nenabled = true\nexclude_dirs = ["clients"]\n',
  未知键: '[rsi]\nenabled = true\nnot_a_key = 1\n[rsi.session]\nwhatever = [1, 2]\n',
  '整个 rsi 不是表': 'rsi = 5\n',
  嵌套表里的类型错乱: '[rsi.session]\nexpires = "soon"\n[rsi.nested.deep]\nx = { y = [true] }\n',
  空段: '[rsi]\n',
};

describe('R20-A0 §20.9#1 UserConfig:update 在三种 [rsi] 情形下的行为', () => {
  it('旧配置(无 [rsi]):干跑退出 0,计划与不带配置文件完全一致', async () => {
    const noFile = await runUpdate(await world(undefined), []);
    const plain = await runUpdate(await world('[update]\nauto_sync = "safe"\n'), []);
    expect(plain.code).toBe(0);
    expect(plain.out).toContain('would install 0.1.1');
    expect(plain.out).toBe(noFile.out);
    expect(plain.err).toBe('');
  });

  it('合法 [rsi]:退出 0、输出与无 [rsi] 的同内容 update 配置逐字相同(rsi 不改变 update 的任何决定)', async () => {
    const base = await runUpdate(await world('[update]\nchannel = "latest"\n'), []);
    const withRsi = await runUpdate(
      await world(`[update]\nchannel = "latest"\n\n${VALID_RSI}`),
      [],
    );
    expect(withRsi.code).toBe(0);
    expect(withRsi.err).toBe('');
    expect(withRsi.out).toBe(base.out);
    expect(withRsi.out).toContain('would install 0.1.1');
    // 只有 [rsi] 没有 [update] 同样可用
    const onlyRsi = await runUpdate(await world(VALID_RSI), []);
    expect(onlyRsi.code).toBe(0);
    expect(onlyRsi.out).toBe(base.out);
  });

  for (const [name, body] of Object.entries(INVALID_RSI)) {
    it(`非法 [rsi](${name}):update 照常退出 0、无 config_invalid(rsi 写错只让 rsi 自己 off,不连累 update)`, async () => {
      const r = await runUpdate(await world(body), []);
      expect(r.err).toBe('');
      expect(r.code).toBe(0);
      expect(r.out).toContain('would install 0.1.1');
    });
  }

  it('非法 [rsi] 下 --write 照常安装,state 正常落盘', async () => {
    const w = await world(INVALID_RSI['enabled 写成字符串'] as string);
    const r = await runUpdate(w, ['--write']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect((await stateOf(w))['installed'].version).toBe('0.1.1');
  });

  it('反向对照(放宽只限 rsi):其它未知顶层段仍 → 退出 3 UPDATE_FAIL_CLOSED reason=config_invalid', async () => {
    for (const bad of ['[rsi2]\nenabled = true\n', '[Rsi]\nenabled = true\n', '[extra]\nx = 1\n']) {
      const r = await runUpdate(await world(bad), []);
      expect(r.code, bad).toBe(3);
      expect(r.err, bad).toContain('UPDATE_FAIL_CLOSED reason=config_invalid');
    }
  });

  it('反向对照:[update] 自身写错照样 config_invalid,不会被合法的 [rsi] 掩盖', async () => {
    const r = await runUpdate(await world(`[update]\nchannel = "nightly"\n\n${VALID_RSI}`), []);
    expect(r.code).toBe(3);
    expect(r.err).toContain('UPDATE_FAIL_CLOSED reason=config_invalid');
  });

  it('[rsi] 与 [update] 并存时 [update] 的设置照常生效(channel = rc 读 dist-tags.rc)', async () => {
    const w = await newWorld();
    await writeRegistry(w, {
      versions: [{ pkg: buildPkg('0.2.0-rc.1') }],
      distTags: { rc: '0.2.0-rc.1' },
    });
    await put(w, path.join(w.home, CFG), `[update]\nchannel = "rc"\n\n${VALID_RSI}`);
    const r = await runUpdate(w, ['--write']);
    expect(r.err).toBe('');
    expect(r.out).toContain('installed 0.2.0-rc.1');
  });
});

describe('R20-A0 §20.9#1 schema 层', () => {
  it('rsi 原样通过(不裁剪、不校验内容);缺省时不出现该键', () => {
    const parsed = UserConfigSchema.parse(parseToml(VALID_RSI));
    expect(parsed.rsi).toEqual(parseToml(VALID_RSI)['rsi']);
    expect('rsi' in UserConfigSchema.parse({})).toBe(false);
    expect(UserConfigSchema.parse({ rsi: 5 }).rsi).toBe(5);
    expect(UserConfigSchema.parse({ rsi: { anything: [1, { a: null }] } }).rsi).toEqual({
      anything: [1, { a: null }],
    });
  });

  it('strictObject 仍在:其它未知键被拒,[update] 的默认值与约束不变', () => {
    expect(() => UserConfigSchema.parse({ rsi: {}, other: 1 })).toThrow();
    expect(UserConfigSchema.parse({ rsi: { enabled: 'x' } }).update.auto_install).toBe(true);
    expect(() => UserConfigSchema.parse({ update: { cooldown_hours: -1 }, rsi: {} })).toThrow();
  });
});

describe('R20-A0 §20.9#1 worker(后台自动更新)不受 [rsi] 影响', () => {
  async function runWorker(w: World): Promise<void> {
    const ctx: CommandContext = {
      argv: ['--background'],
      io: w.io,
      overlayPath: undefined,
      stdout: () => undefined,
      stderr: () => undefined,
      env: { ...w.env, KIT_REAL_HOME_OVERRIDE: w.home, KIT_LAUNCHED: '1' },
    };
    await createBackgroundCommand({ now: FIXED_NOW, verifier: okVerifier, noSmoke: true }).run(ctx);
  }
  const LOG = '.local/state/agent-kit/update/log';
  const lastLog = async (w: World): Promise<string> =>
    (await readText(path.join(w.home, LOG))).trim().split(' ')[1] as string;

  it('非法 [rsi] 下 worker 照常检查并安装(此前会因 config 校验失败而停摆)', async () => {
    const w = await world(INVALID_RSI['整个 rsi 不是表'] as string);
    await runWorker(w);
    expect((await stateOf(w))['installed'].version).toBe('0.1.1');
    expect(await lastLog(w)).toBe('ok');
  });

  it('[update] auto_install = false 与 [rsi] 并存:worker 仍遵守开关,不联网、不写 state', async () => {
    const w = await world(`[update]\nauto_install = false\n\n${VALID_RSI}`);
    await runWorker(w);
    expect(await lastLog(w)).toBe('skipped_gate');
    expect((await treeOf(w.home)).join('\n')).not.toContain('state.json');
  });
});
