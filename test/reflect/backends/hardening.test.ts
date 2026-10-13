import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LlmBackend } from '../../../src/reflect/backend-iface.js';
import { CLAUDE_ARGS } from '../../../src/reflect/backends/cli-claude.js';
import { CODEX_ARGS } from '../../../src/reflect/backends/cli-codex.js';
import { PI_ARGS } from '../../../src/reflect/backends/cli-pi.js';
import {
  createSpawnBudget,
  listCliArgSets,
  StubBackend,
} from '../../../src/reflect/backends/index.js';
import { exists } from '../../../src/io/read-fs.js';
import { REPO_ROOT } from '../../helpers/tmp.js';
import { CLAUDE_BINDING, REQ, SYS_PATH, fixture } from './_fixture.js';

const bySlot = (list: readonly LlmBackend[], slot: string): LlmBackend => {
  const b = list.find((x) => x.slot === slot);
  if (b === undefined) throw new Error(`no slot ${slot}`);
  return b;
};

describe('R3 加固:不可变性与内部类型不外泄', () => {
  it('参数集是深冻结的:不能改 verified / build / claims,listCliArgSets 给出的也是冻结对象', () => {
    for (const a of [CLAUDE_ARGS, CODEX_ARGS, PI_ARGS, ...listCliArgSets()]) {
      expect(Object.isFrozen(a)).toBe(true);
      expect(Object.isFrozen(a.claims)).toBe(true);
      expect(Object.isFrozen(a.globalWrites)).toBe(true);
      expect(() => {
        (a as { verified: boolean }).verified = true;
      }).toThrow(TypeError);
      expect(() => {
        (a as { build: unknown }).build = () => [];
      }).toThrow(TypeError);
    }
    expect(CLAUDE_ARGS.verified).toBe(false); // 正向控制:赋值没有生效
  });

  it('后端的 slot / vendor / model 运行期不可写(厂商门读的就是它)', async () => {
    const f = await fixture('hd-immut-');
    const be = bySlot(
      f.build({
        backends: [{ slot: 'glm', cli: 'pi', provider: 'openrouter', model: 'mystery-9' }],
      }),
      'glm',
    );
    expect(be.vendor).toBe('unknown');
    expect(() => {
      (be as { vendor: string }).vendor = 'zhipu';
    }).toThrow(TypeError);
    expect(() => {
      (be as { model: string }).model = 'glm-5';
    }).toThrow(TypeError);
    expect(be.vendor).toBe('unknown');
    expect(await be.complete(REQ)).toMatchObject({ detail: 'unknown_vendor' });
  });

  it('spawn 预算在同一 state 目录内只能创建一次;非 LlmSpawnBudget 的鸭子对象被拒', async () => {
    const f = await fixture('hd-budget-');
    expect(() => createSpawnBudget(f.ctx, 1)).toThrow(/SPAWN_BUDGET_ALREADY_CREATED/);
    const marker = f.rec('ran.marker');
    await f.install('claude', `echo ran > '${marker}'; printf x`);
    const fake = { max: 99, used: 0, consume: () => undefined } as never;
    const be = bySlot(f.build({ backends: [CLAUDE_BINDING] }, { budget: fake }), 'codex');
    expect(await be.complete(REQ)).toEqual({ ok: false, reason: 'error', detail: 'bad_budget' });
    expect(await exists(marker)).toBe(false);
  });

  it('complete() 不会抛:注入的 which / now 抛错都变成 error(internal)', async () => {
    const f = await fixture('hd-nothrow-');
    await f.install('claude', `cat >/dev/null; printf x`);
    const w = bySlot(
      f.build(
        { backends: [CLAUDE_BINDING] },
        {
          which: () => {
            throw new Error('boom');
          },
        },
      ),
      'codex',
    );
    expect(await w.complete(REQ)).toEqual({ ok: false, reason: 'error', detail: 'internal' });
    const n = bySlot(
      f.build({ backends: [CLAUDE_BINDING] }, { now: () => new Date(Number.NaN) }),
      'codex',
    );
    expect(await n.complete(REQ)).toEqual({ ok: false, reason: 'error', detail: 'internal' });
    // 正向控制:正常依赖照样能跑
    const ok = bySlot(f.build({ backends: [CLAUDE_BINDING] }), 'codex');
    expect((await ok.complete(REQ)).ok).toBe(true);
  });

  it('注入的 which 返回非绝对路径 → not_installed(不按进程 cwd 解析)', async () => {
    const f = await fixture('hd-which-');
    await f.install('claude', `printf x`);
    const be = bySlot(f.build({ backends: [CLAUDE_BINDING] }, { which: () => 'claude' }), 'codex');
    expect(await be.complete(REQ)).toEqual({
      ok: false,
      reason: 'not_installed',
      detail: 'binary_not_found',
    });
    expect(f.budget.used).toBe(0);
  });

  it('工厂入参不可信:形状不对的绑定(对象冒充字符串)按 bad_binding 处理', async () => {
    const f = await fixture('hd-binding-');
    const evil = { toString: () => 'openai', toJSON: () => 'deepseek' };
    const list = f.build({
      backends: [{ slot: 'codex', cli: 'codex', provider: evil, model: 'gpt-test-1' } as never],
    });
    expect(await bySlot(list, 'codex').complete(REQ)).toEqual({
      ok: false,
      reason: 'not_configured',
      detail: 'bad_binding',
    });
  });

  it('codex 配了第一方 provider 却与模型族矛盾 → unknown(本地补强 R0 的推导规则)', async () => {
    const f = await fixture('hd-codexvendor-');
    const be = bySlot(
      f.build({
        backends: [{ slot: 'codex', cli: 'codex', provider: 'deepseek', model: 'claude-x' }],
      }),
      'codex',
    );
    expect(be.vendor).toBe('unknown');
    // 正向控制:一致的组合照常推出厂商
    const ok = bySlot(
      f.build({
        backends: [{ slot: 'codex', cli: 'codex', provider: 'deepseek', model: 'deepseek-chat' }],
      }),
      'codex',
    );
    expect(ok.vendor).toBe('deepseek');
  });

  it('StubBackend 默认厂商是 stub(不是内置厂商,不会被当成可证明的跨厂商)', () => {
    expect(new StubBackend().vendor).toBe('stub');
  });
});

describe('R3 加固:环境快照', () => {
  it('相对路径的 HOME / XDG_* → not_configured(env_relative_path)', async () => {
    const f = await fixture('hd-envrel-');
    const marker = f.rec('ran.marker');
    await f.install('claude', `echo ran > '${marker}'; printf x`);
    for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME']) {
      const envSource = { PATH: `${f.bin}:${SYS_PATH}`, HOME: f.fakeHome, [name]: '../../..' };
      const be = bySlot(f.build({ backends: [CLAUDE_BINDING] }, { envSource }), 'codex');
      expect(await be.complete(REQ), name).toEqual({
        ok: false,
        reason: 'not_configured',
        detail: 'env_relative_path',
      });
    }
    expect(await exists(marker)).toBe(false);
  });

  it('大小写不同写法的仓库路径同样被认作仓库内(macOS 大小写不敏感)', async () => {
    const f = await fixture('hd-envcase-');
    const marker = f.rec('ran.marker');
    await f.install('claude', `echo ran > '${marker}'; printf x`);
    const sneaky = path.join(REPO_ROOT.toLowerCase(), 'sub');
    expect(sneaky).not.toBe(path.join(REPO_ROOT, 'sub'));
    const envSource = { PATH: `${f.bin}:${SYS_PATH}`, HOME: sneaky };
    const be = bySlot(f.build({ backends: [CLAUDE_BINDING] }, { envSource }), 'codex');
    expect(await be.complete(REQ)).toMatchObject({ detail: 'env_in_repo' });
    expect(await exists(marker)).toBe(false);
  });

  it('PATH 里指进仓库的项被剔除,传给子进程的 PATH 里没有它(KIT_TMP 内的 bin 仍在)', async () => {
    const f = await fixture('hd-pathfilter-');
    const dump = f.rec('env.txt');
    await f.install('claude', `cat >/dev/null; env > '${dump}'; printf x`);
    const repoBin = path.join(REPO_ROOT, 'node_modules', '.bin');
    const envSource = { PATH: `${repoBin}:${f.bin}:${SYS_PATH}`, HOME: f.fakeHome };
    const be = bySlot(f.build({ backends: [CLAUDE_BINDING] }, { envSource }), 'codex');
    expect((await be.complete(REQ)).ok).toBe(true);
    const out = (await f.read(dump)) ?? '';
    const pathLine = out.split('\n').find((l) => l.startsWith('PATH=')) ?? '';
    expect(pathLine).toContain(f.bin);
    expect(pathLine).not.toContain(repoBin);
  });
});
