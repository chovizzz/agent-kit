#!/usr/bin/env node
/**
 * 发布前门禁:对**实际待发布的 tgz**(release.yml 真实 `npm pack` 出来、随后原样 `npm publish <tgz>` 的那个文件)做三项检查,
 * 任一不过即退出 1,workflow 不发布(docs/contracts.md §19.9.1 D-AU3)。
 *
 *   1. tar header 里 `package/dist/cli.js` 的**原始 mode**恰为 0755(直接读 header,不经 readTgz 的归一化;`& 0o7777`,特殊位也不合格)。
 *      目的:≤ 0.3.3 的旧引导版本的安装器要求 bin 为 0755,新版 tarball 里是 0644 就会被旧版误拉黑该版本号。
 *   2. 用安装器自己的 `checkPackage` 与 `staticSmoke`(tsc 构建期产物,来源同 build-payload.mjs)跑一遍,版本取 tag。
 *   3. 解包到临时目录,`node dist/cli.js --version`,stdout 去空白后等于 tag 版本。
 *
 * 用法:node scripts/check-release-tgz.mjs <file.tgz> --tag vX.Y.Z
 * 退出码:0 通过 | 1 有违规(stderr 每行 `REL_<码>: …`)| 2 用法错 | 4 未执行(缺 tsc 构建产物)。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { TSC_OUT } from './lib/paths.mjs';

const BIN_PATH = 'package/dist/cli.js';

function usage(msg) {
  if (msg) console.error(`check-release-tgz: ${msg}`);
  console.error('用法: node scripts/check-release-tgz.mjs <file.tgz> --tag vX.Y.Z');
  process.exit(2);
}

const args = process.argv.slice(2);
let tgzPath;
let tag;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--tag') tag = args[++i];
  else if (tgzPath === undefined && !args[i].startsWith('-')) tgzPath = args[i];
  else usage(`未知参数 ${args[i]}`);
}
if (tgzPath === undefined || tag === undefined) usage('需要 <file.tgz> 与 --tag');
const m = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
if (m === null) usage(`tag 形态不对:${tag}`);
const version = m[1];

/** 直接读 tar header:返回 BIN_PATH 条目的原始 mode(八进制字段原值),找不到返回 undefined。只认 ustar 普通文件条目与 pax 路径覆盖。 */
function rawModeOf(tar, want) {
  let pos = 0;
  let paxPath;
  while (pos + 512 <= tar.length) {
    const h = tar.subarray(pos, pos + 512);
    if (h.every((b) => b === 0)) return undefined;
    const field = (o, n) => h.toString('latin1', o, o + n).replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(h[156]);
    pos += 512;
    if (type === 'x') {
      const body = tar.toString('utf8', pos, pos + size);
      const mm = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body);
      paxPath = mm?.[1];
    } else {
      const prefix = field(345, 155);
      const name = paxPath ?? (prefix === '' ? field(0, 100) : `${prefix}/${field(0, 100)}`);
      paxPath = undefined;
      if ((type === '0' || type === '\0') && name === want) {
        return parseInt(field(100, 8).trim() || '0', 8);
      }
    }
    pos += Math.ceil(size / 512) * 512;
  }
  return undefined;
}

const violations = [];
const bytes = readFileSync(tgzPath);

// 1. 原始 mode
let tar;
try {
  tar = gunzipSync(bytes);
} catch {
  console.error('REL_TGZ_UNREADABLE: 不是合法的 gzip');
  process.exit(1);
}
const rawMode = rawModeOf(tar, BIN_PATH);
if (rawMode === undefined) violations.push(`REL_BIN_MISSING: tarball 里没有 ${BIN_PATH}`);
else if ((rawMode & 0o7777) !== 0o755) {
  violations.push(
    `REL_BIN_MODE: ${BIN_PATH} 的 tar header mode 是 0${(rawMode & 0o7777).toString(8)},必须恰为 0755(旧引导版本的安装器要求 0755)`,
  );
}

// 2. checkPackage / staticSmoke(安装器同一份实现,来自 tsc 构建期产物)
const outDir = path.join(process.cwd(), TSC_OUT, 'src/update');
if (!existsSync(path.join(outDir, 'install.js'))) {
  console.error('check-release-tgz: 缺 tsc 构建产物(先 pnpm run build)');
  process.exit(4);
}
const { checkPackage, staticSmoke } = await import(pathToFileURL(path.join(outDir, 'install.js')).href);
const { readTgz } = await import(pathToFileURL(path.join(outDir, 'tar.js')).href);
let listing;
try {
  listing = readTgz(bytes);
} catch (e) {
  violations.push(`REL_TAR: 安装器的 tar 读取器拒绝该包:${e?.code ?? e}`);
}
if (listing !== undefined) {
  const pkg = checkPackage(listing, version);
  if (!pkg.ok) violations.push(`REL_PACKAGE: checkPackage 拒绝:${pkg.detail}`);
  const smoke = staticSmoke(listing);
  if (!smoke.ok) violations.push(`REL_SMOKE: staticSmoke 拒绝:${smoke.detail}`);

  // 3. 解包后真执行 `--version`
  const dir = mkdtempSync(path.join(tmpdir(), 'kit-rel-'));
  try {
    for (const f of listing.files) {
      const abs = path.join(dir, 'pkg', ...f.path.split('/'));
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, f.bytes, { mode: f.mode });
    }
    mkdirSync(path.join(dir, 'home'));
    const r = spawnSync(process.execPath, [path.join(dir, 'pkg', 'dist', 'cli.js'), '--version'], {
      encoding: 'utf8',
      timeout: 30_000,
      cwd: dir,
      env: { PATH: path.dirname(process.execPath), HOME: path.join(dir, 'home'), KIT_TMP: dir, KIT_LAUNCHED: '1', KIT_AUTO_UPDATE: '0' },
    });
    if (r.status !== 0 || (r.stdout ?? '').trim() !== version) {
      violations.push(
        `REL_VERSION_RUN: node dist/cli.js --version 退出 ${r.status},输出 ${JSON.stringify((r.stdout ?? '').trim())},期望 ${version}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (violations.length > 0) {
  for (const v of violations) console.error(v);
  process.exit(1);
}
console.log(`check-release-tgz: ${path.basename(tgzPath)} 通过(bin 0755 / checkPackage / staticSmoke / --version = ${version})`);
