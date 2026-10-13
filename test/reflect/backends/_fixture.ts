import * as path from 'node:path';
import type { LlmCompleteRequest } from '../../../src/reflect/backend-iface.js';
import { buildBackends, createSpawnBudget } from '../../../src/reflect/backends/index.js';
import type { BackendDeps, BuildBackendsConfig } from '../../../src/reflect/backends/index.js';
import { createIoContext } from '../../../src/io/paths.js';
import type { IoContext } from '../../../src/io/paths.js';
import { exists, readText } from '../../../src/io/read-fs.js';
import { chmod, mkdirp, writeFile } from '../../../src/io/safe-fs.js';
import { REPO_ROOT, makeTempDir } from '../../helpers/tmp.js';

export const SYS_PATH = '/usr/bin:/bin';
export const T0 = new Date('2026-10-12T10:00:00Z');

export const REQ: LlmCompleteRequest = {
  system: 'sys',
  user: 'usr',
  timeoutMs: 10_000,
  maxOutputBytes: 32 * 1024,
};

/** 假 CLI 一律是写在 KIT_TMP 内的 sh 脚本;不碰任何真实 LLM CLI、真实 HOME。 */
export async function fixture(prefix: string, opts: { budget?: number } = {}) {
  const { dir } = await makeTempDir(prefix);
  const ctx: IoContext = createIoContext({
    cwd: REPO_ROOT,
    env: { KIT_TMP: dir, KIT_STATE_DIR: path.join(dir, 'state'), PATH: SYS_PATH },
  });
  const fakeHome = path.join(dir, 'fake-home');
  await mkdirp(ctx, fakeHome);
  const bin = path.join(dir, 'bin');
  await mkdirp(ctx, bin);
  const install = async (name: string, body: string): Promise<string> => {
    const p = path.join(bin, name);
    await writeFile(ctx, p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    await chmod(ctx, p, 0o755);
    return p;
  };
  const envSource: Record<string, string | undefined> = {
    PATH: `${bin}:${SYS_PATH}`,
    HOME: fakeHome,
    LANG: 'C',
  };
  const budget = createSpawnBudget(ctx, opts.budget ?? 5);
  const unverifiedBins = ['claude', 'codex', 'pi'].map((n) => path.join(bin, n));
  let nowValue = T0;
  const clock = {
    set: (d: Date) => {
      nowValue = d;
    },
  };
  const deps = (over: Partial<BackendDeps> = {}): BackendDeps => ({
    ctx,
    now: () => nowValue,
    budget,
    envSource,
    allowEgress: true,
    allowUnverified: unverifiedBins,
    ...over,
  });
  const rec = (name: string) => path.join(dir, name);
  const read = async (p: string) => ((await exists(p)) ? readText(p) : undefined);
  const build = (config: BuildBackendsConfig, over: Partial<BackendDeps> = {}) =>
    buildBackends(config, deps(over));
  return { dir, ctx, fakeHome, bin, install, envSource, budget, clock, deps, rec, read, build };
}

export const CLAUDE_BINDING = { slot: 'codex', cli: 'claude', model: 'claude-test-1' } as const;
export const CODEX_BINDING = { slot: 'codex', cli: 'codex', model: 'gpt-test-1' } as const;
export const PI_BINDING = {
  slot: 'glm',
  cli: 'pi',
  provider: 'zai',
  model: 'glm-test-1',
} as const;

/** 运行时拼装的假密钥(脚本/源码里不出现密钥字面量)。 */
export const fakeSecret = (tag: string) => ['fake', tag, 'value', '0123456789'].join('_');

export const FIXED_JSON = '{"proposals":[]}';
