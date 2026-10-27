/**
 * R20-A2 B2 的 rsi 配置 / 状态 / 闸测试共用夹具:临时目录里造假 HOME(`.config/agent-kit/config.toml`)与合规的 `[rsi] repo`。
 * 全部经 safe-fs 写在 KIT_TMP(或 .state/test-tmp)内,不碰真实 HOME。
 */
import * as path from 'node:path';
import { chmod, mkdirp, writeFile } from '../../src/io/safe-fs.js';
import type { IoContext } from '../../src/io/paths.js';
import { makeTempDir, wideCtx } from '../helpers/tmp.js';

export interface RsiFx {
  dir: string;
  fx: IoContext;
  home: string;
  repo: string;
  cfgDir: string;
  cfgFile: string;
}

export async function makeRsiFx(prefix: string): Promise<RsiFx> {
  const { dir } = await makeTempDir(prefix);
  const fx = wideCtx(dir);
  const home = path.join(dir, 'home');
  const repo = path.join(dir, 'repo');
  const cfgDir = path.join(home, '.config', 'agent-kit');
  await mkdirp(fx, cfgDir, 0o755);
  await chmod(fx, path.join(home, '.config'), 0o755);
  await chmod(fx, cfgDir, 0o755);
  await mkdirp(fx, repo, 0o755);
  await chmod(fx, repo, 0o755);
  await writeFile(fx, path.join(repo, 'kit.toml'), '[kit]\n', { mode: 0o644 });
  return { dir, fx, home, repo, cfgDir, cfgFile: path.join(cfgDir, 'config.toml') };
}

/** 写用户配置(TOML 文本),0600 */
export async function writeCfg(f: RsiFx, toml: string, mode = 0o600): Promise<void> {
  await writeFile(f.fx, f.cfgFile, toml, { mode });
  await chmod(f.fx, f.cfgFile, mode);
}

/** 合法的 `[rsi]` 段文本(可追加 / 覆盖键) */
export function rsiToml(f: RsiFx, extra = '', opts: { repo?: string | null } = {}): string {
  const repo = opts.repo === undefined ? f.repo : opts.repo;
  return `[rsi]\nenabled = true\n${repo === null ? '' : `repo = ${JSON.stringify(repo)}\n`}${extra}`;
}
