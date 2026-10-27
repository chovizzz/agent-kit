/**
 * R20-A2 B3b 测试共用:把 reflect / judge 命令接到 rsi/lock 所需的夹具。
 * - `aliasRsiState`:`<dir>/.state` 符号链接指向命令真正使用的状态目录,配合 `onConfig(dir)` 让 `lockGate` 判 `lock`(同一状态树)。
 * - `startHolder`:真子进程持 `rsi/lock`(test/rsi/proc/child-entry.ts),握手以它打印的第一行为准,不靠 sleep。
 */
import * as path from 'node:path';
import type { RsiConfigOn } from '../../src/rsi/config.js';
import type { IoContext } from '../../src/io/paths.js';
import { canonicalJson } from '../../src/io/canonical-json.js';
import { chmod, mkdirp, symlink, writeFile } from '../../src/io/safe-fs.js';
import { makeTempDir } from '../helpers/tmp.js';
import { buildChild, startChild } from '../rsi/proc/helper.js';

export function onConfig(repo: string): RsiConfigOn {
  return {
    status: 'on',
    repo,
    overlayPath: null,
    overlaySha256: null,
    agents: [],
    excludeDirs: [],
    excludeNames: [],
    block: null,
    warnings: [],
  };
}

export async function aliasRsiState(io: IoContext, dir: string): Promise<void> {
  await symlink(io, io.stateDir, path.join(dir, '.state'));
}

export const lockFileOf = (stateDir: string): string => path.join(stateDir, 'rsi', 'lock');

let script: string | undefined;

export interface Holder {
  stop(): Promise<void>;
}

/** 起真子进程持 `<stateDir>/rsi/lock`;返回时锁已被它握住 */
export async function startHolder(stateDir: string, tmp: string): Promise<Holder> {
  if (script === undefined) {
    const { dir } = await makeTempDir('rsi-b3b-build-');
    script = await buildChild(dir);
  }
  const h = startChild(script, { op: 'hold', tmp, state: stateDir });
  const first = JSON.parse(await h.firstLine()) as { held?: boolean };
  if (first.held !== true) throw new Error('holder did not get the lock');
  return {
    async stop() {
      h.child.kill('SIGKILL');
      await h.exited;
    },
  };
}

/** 写一份真实的 purge journal(`<stateDir>/rsi/purge-journal.json`,0600,目录 0700);`raw` 给了就原样写(演练损坏) */
export async function writePurgeJournal(
  io: IoContext,
  stateDir: string,
  raw?: string,
): Promise<string> {
  const dir = path.join(stateDir, 'rsi');
  await mkdirp(io, dir, 0o700);
  await chmod(io, dir, 0o700);
  const file = path.join(dir, 'purge-journal.json');
  const body =
    raw ??
    canonicalJson({
      schema_version: 1,
      created_at: '2026-10-26T00:00:00.000Z',
      phase: 'signals_rewritten',
      keys: ['p_aaaaaaaaaaaaaaaa'],
      taint_targets: { runs: [], promotes: [] },
    });
  await writeFile(io, file, body, { mode: 0o600 });
  await chmod(io, file, 0o600);
  return file;
}
