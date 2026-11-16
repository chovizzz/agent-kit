/**
 * B2 ④:生产惰性逐入口(`inert_at_phase0_<entry>`;设计稿 v3 §D.8):走**真**分发入口(`commands.ts` 导出的子命令,不注入 phase),
 * 相位常量为 0 时每个写入口都是桩——退 64、stderr 只有 `RSI_NOT_IMPLEMENTED subcommand=<规范名>`,假 HOME 与临时根逐字节不变(无锁文件、无账、无审计)。
 */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RSI_AUTO_PHASE } from '../../../src/contracts/rsi.js';
import { readDir, readText } from '../../../src/io/read-fs.js';
import {
  autoSubcommand,
  rollbackSubcommand,
  vetoSubcommand,
} from '../../../src/rsi/auto/commands.js';
import type { RsiEarlyContext } from '../../../src/rsi/types.js';
import { makeWorld } from '../personal/repo-helpers.js';

async function snapshot(
  dir: string,
  out: Record<string, string> = {},
  root = dir,
): Promise<Record<string, string>> {
  for (const e of await readDir(dir)) {
    const p = path.join(dir, e.name);
    if (e.isDirectory) {
      out[path.relative(root, p) + '/'] = 'd';
      await snapshot(p, out, root);
    } else
      out[path.relative(root, p)] = createHash('sha256')
        .update(await readText(p))
        .digest('hex');
  }
  return out;
}

const ENTRIES: [string, typeof autoSubcommand, string[], string][] = [
  ['pause', autoSubcommand, ['pause'], 'auto pause'],
  ['resume', autoSubcommand, ['resume'], 'auto resume'],
  ['clear_write', autoSubcommand, ['clear', '--write'], 'auto clear'],
  ['rebase_baseline', autoSubcommand, ['rebase-baseline'], 'auto rebase-baseline'],
  ['veto', vetoSubcommand, ['ra_0123456789ab'], 'veto'],
  ['veto_lift', vetoSubcommand, ['--lift', 'ra_0123456789ab'], 'veto'],
  ['rollback_to', rollbackSubcommand, ['--to', '2026-01-01', '--write'], 'rollback --to'],
];

describe('生产惰性(相位 0)', () => {
  it('相位常量保持 0', () => {
    expect(RSI_AUTO_PHASE).toBe(0);
  });

  it.each(ENTRIES)(
    'inert_at_phase0_%s:真入口退 64 桩,世界逐字节不变',
    async (_n, sub, argv, canonical) => {
      const w = await makeWorld('b2-inert-');
      const before = await snapshot(w.dir);
      let err = '';
      let out = '';
      const ctx = {
        argv,
        overlayPath: undefined,
        explicitRoot: undefined,
        env: {
          KIT_REAL_HOME_OVERRIDE: w.home,
          KIT_TMP: w.dir,
          KIT_STATE_DIR: path.join(w.dir, 'state'),
        },
        cwd: w.dir,
        stdout: (t: string) => void (out += t),
        stderr: (t: string) => void (err += t),
        isTty: true,
        readLine: async () => undefined,
      } as unknown as RsiEarlyContext;
      const code = await sub.run(ctx as never);
      expect(code).toBe(64);
      expect(err).toBe(`RSI_NOT_IMPLEMENTED subcommand=${canonical}\n`);
      expect(out).toBe('');
      expect(await snapshot(w.dir)).toEqual(before);
    },
  );
});
