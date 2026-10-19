/**
 * S7c-B 测试世界:假 HOME 里手工铺一份「已安装」状态(versions/<v>/ + current 软链 + state.json),
 * 假 cli.js 只把 argv 与收到的环境写进 `$KIT_TMP/marker.json` 然后以 7 退出。绝不联网、不碰真实 HOME。
 */
import * as path from 'node:path';
import { canonicalJson } from '../../src/io/canonical-json.js';
import { readDir, readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { emptyState, markInstalled, serializeUpdateState } from '../../src/update/state.js';
import { buildPkg, sha256, type BuiltPkg, type World } from './install-world.js';

export const FAKE_CLI = (): string =>
  `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
const marker = process.env.KIT_TMP + '/marker-' + process.pid + '.json';
writeFileSync(marker, JSON.stringify({ argv: process.argv.slice(2), env: process.env, execArgv: process.execArgv }));
if (process.argv[2] === '--version') process.stdout.write(process.env.FAKE_VERSION ?? '0.0.0');
process.exit(process.argv[2] === '--version' ? 0 : 7);
`;

export const SHARE = '.local/share/agent-kit';
export const STATE_DIR = '.local/state/agent-kit/update';

async function put(w: World, abs: string, data: string | Buffer, mode = 0o644): Promise<void> {
  await safe.mkdirp(w.fx, path.dirname(abs));
  await safe.writeFile(w.fx, abs, data, { mode });
}

export interface Installed {
  version: string;
  pkg: BuiltPkg;
  root: string;
}

/** 铺 versions/<version>/(带合法 integrity.json),不动 current / state */
export async function lay(w: World, version: string, cli = FAKE_CLI()): Promise<Installed> {
  const pkg = buildPkg(version, {
    edit: (files) => files.map((f) => (f.path === 'dist/cli.js' ? { ...f, data: cli } : f)),
  });
  const root = path.join(w.home, SHARE, 'versions', version);
  for (const f of pkg.files) {
    await put(w, path.join(root, f.path), f.data, f.mode ?? 0o644);
  }
  await put(w, path.join(root, 'integrity.json'), pkg.integrityBytes);
  return { version, pkg, root };
}

export async function link(w: World, version: string): Promise<void> {
  const l = path.join(w.home, SHARE, 'current');
  await safe.mkdirp(w.fx, path.dirname(l));
  await safe.remove(w.fx, l).catch(() => undefined);
  await safe.symlink(w.fx, `versions/${version}`, l);
}

export async function putState(
  w: World,
  version: string,
  anchor: string,
  patch: (s: ReturnType<typeof emptyState>) => ReturnType<typeof emptyState> = (s) => s,
): Promise<void> {
  const s = patch(
    markInstalled(emptyState(), { version, anchor, nowMs: Date.parse('2026-10-14T12:00:00Z') }),
  );
  await put(w, path.join(w.home, STATE_DIR, 'state.json'), serializeUpdateState(s));
}

/** 完整的「已安装 + current + state」 */
export async function installFake(w: World, version: string, cli?: string): Promise<Installed> {
  const inst = await lay(w, version, cli);
  await link(w, version);
  await putState(w, version, inst.pkg.anchor);
  return inst;
}

export async function markers(
  w: World,
): Promise<{ argv: string[]; env: Record<string, string>; execArgv: string[] }[]> {
  const out = [];
  for (const e of await readDir(w.dir)) {
    if (e.name.startsWith('marker-')) {
      out.push(JSON.parse(await readText(path.join(w.dir, e.name))));
    }
  }
  return out;
}

export { canonicalJson, put, sha256 };
