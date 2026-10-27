/**
 * R20-A2 B5g 测试共用夹具:judge / promote 的 rsi 隐私闸与即时闸。
 * 全部经 safe-fs 写在 KIT_TMP 内、假 HOME(`KIT_REAL_HOME_OVERRIDE`);不读真实 HOME 的配置,不 import node:fs。
 *
 * 一个「闸世界」= 一个假 HOME 里的 `[rsi]` 配置 + 仓库内 `.state` 符号链接(指向命令真正用的状态目录,让 `lockGate` 判同一状态树)
 * + 状态目录里的信号库 / 索引 / counts(把某个 key 归属到某个项目根)。
 */
import * as path from 'node:path';
import { canonicalJson } from '../../src/io/canonical-json.js';
import type { IoContext } from '../../src/io/paths.js';
import { exists, stat } from '../../src/io/read-fs.js';
import { chmod, mkdirp, remove, symlink, writeFile } from '../../src/io/safe-fs.js';
import type { RsiLockDeps } from '../../src/rsi/lock.js';
import { SALT_FP, countsDoc, signalObj } from '../rsi/services-fixture.js';

export const GATE_SALT_FP = SALT_FP;

export interface HomeCfg {
  readonly home: string;
  readonly cfgFile: string;
}

/** 建假 HOME 与 `.config/agent-kit/`(权限按 R20-2.2),返回配置文件路径(尚未写) */
export async function makeHome(fx: IoContext, dir: string, name = 'home'): Promise<HomeCfg> {
  const home = path.join(dir, name);
  const cfgDir = path.join(home, '.config', 'agent-kit');
  await mkdirp(fx, cfgDir, 0o755);
  await chmod(fx, path.join(home, '.config'), 0o755);
  await chmod(fx, cfgDir, 0o755);
  return { home, cfgFile: path.join(cfgDir, 'config.toml') };
}

export async function writeCfgText(
  fx: IoContext,
  h: HomeCfg,
  toml: string,
  mode = 0o600,
): Promise<void> {
  await writeFile(fx, h.cfgFile, toml, { mode });
  await chmod(fx, h.cfgFile, mode);
}

/** 合法的 `[rsi]` 段(可追加键) */
export const rsiText = (repo: string, extra = ''): string =>
  `[rsi]\nenabled = true\nrepo = ${JSON.stringify(repo)}\n${extra}`;

/** 五种配置不可用状态(privacyGate 的 deny)→ 配置文本;`chmod000` 另走 {@link applyCfgFailure} */
export type CfgFailure =
  'cfg_schema' | 'cfg_unreadable' | 'repo_invalid' | 'overlay_invalid' | 'exclude_invalid';
export const CFG_FAILURES: readonly CfgFailure[] = [
  'cfg_schema',
  'cfg_unreadable',
  'repo_invalid',
  'overlay_invalid',
  'exclude_invalid',
];

export async function applyCfgFailure(
  fx: IoContext,
  h: HomeCfg,
  repo: string,
  dir: string,
  which: CfgFailure,
): Promise<void> {
  switch (which) {
    case 'cfg_schema':
      return writeCfgText(fx, h, '[rsi]\nenabled = true\nunknown_key = 1\n');
    case 'cfg_unreadable':
      await writeCfgText(fx, h, rsiText(repo));
      return chmod(fx, h.cfgFile, 0o000);
    case 'repo_invalid':
      return writeCfgText(fx, h, rsiText(path.join(dir, 'no-such-repo')));
    case 'overlay_invalid':
      return writeCfgText(
        fx,
        h,
        rsiText(repo, `overlay = ${JSON.stringify(path.join(dir, 'no-overlay.toml'))}\n`),
      );
    case 'exclude_invalid':
      return writeCfgText(fx, h, rsiText(repo, 'exclude_dirs = ["relative"]\n'));
  }
}

const put = async (fx: IoContext, abs: string, content: string, mode = 0o600): Promise<void> => {
  await mkdirp(fx, path.dirname(abs), 0o700);
  await writeFile(fx, abs, content, { mode });
  await chmod(fx, abs, mode);
};

/** 项目根目录(真实目录) */
export async function makeProjectRoot(fx: IoContext, dir: string, name: string): Promise<string> {
  const p = path.join(dir, 'proj', name);
  await mkdirp(fx, p, 0o755);
  return p;
}

/** 状态目录里的信号库:`{sigHex → key}`(sig_id = `sig_<hex16>`) */
export async function writeSignals(
  fx: IoContext,
  state: string,
  list: readonly { hex: string; key: string }[],
): Promise<void> {
  const lines = list.map((x) => JSON.stringify(signalObj(x.hex, x.key)));
  await put(fx, path.join(state, 'signals', 'claude', '202610.jsonl'), `${lines.join('\n')}\n`);
}

export const indexFile = (state: string): string => path.join(state, 'rsi', 'projects.json');

/** 索引 + counts(盐指纹一致):key → 项目根 */
export async function writeIndexAndCounts(
  fx: IoContext,
  state: string,
  entries: readonly { key: string; root: string }[],
): Promise<void> {
  const out = [];
  for (const e of [...entries].sort((a, b) => (a.key < b.key ? -1 : 1))) {
    const st = await stat(e.root);
    out.push({
      key: e.key,
      roots: [
        {
          path: e.root,
          dev: st.dev,
          ino: st.ino,
          first_seen: '2026-10-01',
          last_seen: '2026-10-02',
        },
      ],
      sessions: 1,
      signals: 1,
      first_indexed_generation: 1,
    });
  }
  await mkdirp(fx, path.join(state, 'rsi'), 0o700);
  await chmod(fx, path.join(state, 'rsi'), 0o700);
  await put(
    fx,
    indexFile(state),
    canonicalJson({ schema_version: 1, salt_fp: GATE_SALT_FP, generation: 1, entries: out }),
  );
  await put(fx, path.join(state, 'rsi', 'counts.json'), canonicalJson(countsDoc()));
}

export async function removeIndex(fx: IoContext, state: string): Promise<void> {
  await remove(fx, indexFile(state));
}

/** 仓库里的 `.state` 符号链接 → 命令真正使用的状态目录(让 `lockGate` 判同一状态树) */
export async function aliasState(fx: IoContext, repo: string, state: string): Promise<void> {
  await symlink(fx, state, path.join(repo, '.state'));
}

/** 一份合法 purge journal(`<state>/rsi/purge-journal.json`) */
export async function putJournal(fx: IoContext, state: string, raw?: string): Promise<void> {
  await mkdirp(fx, path.join(state, 'rsi'), 0o700);
  await chmod(fx, path.join(state, 'rsi'), 0o700);
  await put(
    fx,
    path.join(state, 'rsi', 'purge-journal.json'),
    raw ??
      canonicalJson({
        schema_version: 1,
        created_at: '2026-10-26T00:00:00.000Z',
        phase: 'signals_rewritten',
        keys: ['p_aaaaaaaaaaaaaaaa'],
        taint_targets: { runs: [], promotes: [] },
      }),
  );
}

export async function putTaintMark(
  fx: IoContext,
  dir: string,
  reason: 'exclude' | 'purge' = 'exclude',
): Promise<void> {
  await put(
    fx,
    path.join(dir, 'TAINTED'),
    canonicalJson({ reason, at: '2026-10-26T00:00:00.000Z' }),
  );
}

/**
 * `rsi/lock` 失锁注入:第 `k` 次(从 1 起)读锁文件(= 第 k 次 `assertHeld`)之前,把锁文件换成别人的 nonce。
 * 返回 `lockDeps`(传给命令)与计数器(`reads` = 实际发生的读次数)。`k = Infinity` = 只计数、不换。
 */
export function loseLockAtRead(
  fx: IoContext,
  k: number,
  startArmed = true,
): { lock: RsiLockDeps; reads: () => number; lostAt: () => number | undefined; arm: () => void } {
  let armed = startArmed;
  let n = 0;
  let lost: number | undefined;
  return {
    lock: {
      beforeRead: async (file: string): Promise<void> => {
        // 只计「锁已存在」时的读(取锁前的探测读不算);否则换 nonce 会发生在取锁之前
        if (!armed || !(await exists(file))) return;
        n++;
        if (n === k && lost === undefined) {
          lost = n;
          await writeFile(
            fx,
            file,
            JSON.stringify({
              pid: 1,
              started_at: new Date().toISOString(),
              nonce: 'f'.repeat(16),
              kit_version: '0.1.0',
            }),
            { mode: 0o600 },
          );
        }
      },
    },
    reads: () => n,
    lostAt: () => lost,
    arm: () => {
      armed = true;
    },
  };
}
