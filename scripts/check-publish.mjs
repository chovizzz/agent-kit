#!/usr/bin/env node
/**
 * 发布前自检(P1-D:GitHub Actions → npm)。
 *
 * 只做**发布面**的检查,不重复 CI 已经跑过的 typecheck/test/lint:
 *   1. dist/ 存在且入口齐全(打包产物 cli.js + main.js;构建期 tsc 产物目录在);
 *   2. 包内容白名单:只允许 package.json 声明的 `files`(dist/ payload/ integrity.json README.md LICENSE);
 *   3. 禁运形态扫描:会话原文(.jsonl)、.state/、绝对路径(/Users/…)、私钥块;
 *   4. 版本与 tag 一致(在 CI 里由 GITHUB_REF 提供;本地可传 --tag vX.Y.Z);
 *   5. payload 完整性闸(S2):包里必须有 payload/manifest.json 与 integrity.json,逐文件重算 sha256,
 *      manifest ↔ integrity ↔ 文件一致,payload 与重新构建的结果、与仓库 out/ 逐字节一致,
 *      不含 personal 来源,无绝对路径 / HOME 路径泄漏。每项违规带稳定原因码 PAYLOAD_*(见 src/build/payload-verify.ts)。
 *
 *   6. 打包闸(S7b,scripts/lib/bundle-gate.mjs,原因码 BUNDLE_*):dependencies 必须为空;dist 里所有 import / require 说明符
 *      只能是 node:* 或相对路径(AST 扫描);dist/THIRD_PARTY_LICENSES 覆盖产物里实际包含的全部第三方包;dist 无 node_modules 路径、
 *      sourcemap / 产物里无绝对路径或 HOME 泄漏;integrity.json 覆盖 dist 全部文件;bin 入口是带 shebang 的薄入口。
 *
 * 0) 发布冻结(R20-A2 B5-0):仓库根有 `RELEASE_FREEZE`(lstat,含符号链接)→ stderr `PUBLISH_FROZEN: …`,退出 1;**先于一切**(不读 package.json、不要求 dist、不跑 npm pack)。
 *    `--freeze-only`:只做这一项(`package.json` 的 `prepublishOnly` 调它;没冻结 → 退出 0)。`npm publish --ignore-scripts` 会跳过 prepublishOnly,
 *    所以 release.yml 另有一步独立检查,不可删。
 *
 * 退出码:0 通过 | 1 有违规 | 2 用法错 | 4 未执行(缺 dist 等前置)。
 */
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { checkBundle, readDist } from './lib/bundle-gate.mjs';
import { freezeViolations } from './lib/freeze-gate.mjs';
import { packFileList } from './lib/pack.mjs';
import { TSC_OUT } from './lib/paths.mjs';

const EXIT = { ok: 0, violation: 1, usage: 2, notRun: 4 };

function usage(msg) {
  if (msg) console.error(`check-publish: ${msg}`);
  console.error('用法: node scripts/check-publish.mjs [--tag vX.Y.Z | --freeze-only]');
  process.exit(EXIT.usage);
}

const argv = process.argv.slice(2);
let tag;
let freezeOnly = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--freeze-only') {
    freezeOnly = true;
  } else if (argv[i] === '--tag') {
    tag = argv[i + 1];
    if (!tag) usage('--tag 需要一个值');
    i++;
  } else {
    usage(`未知参数 ${argv[i]}`);
  }
}

if (freezeOnly && tag !== undefined)
  usage('--freeze-only 与 --tag 互斥(--freeze-only 不做 tag 校验)');

const root = process.cwd();
const violations = [];

// 0) 发布冻结:先于一切(见文件头)。`--freeze-only` 在这里结束
{
  const frozen = freezeViolations(root);
  if (frozen.length > 0) {
    for (const v of frozen) console.error(v);
    process.exit(EXIT.violation);
  }
  if (freezeOnly) {
    console.log('check-publish: 未冻结(--freeze-only)');
    process.exit(EXIT.ok);
  }
}

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

// 1) dist 齐全
const required = ['dist/cli.js', 'dist/main.js', `${TSC_OUT}/src/build`];
for (const rel of required) {
  if (!existsSync(path.join(root, rel))) violations.push(`缺 ${rel}(先 pnpm run build)`);
}
if (violations.length > 0) {
  for (const v of violations) console.error(`check-publish: ${v}`);
  process.exit(EXIT.notRun);
}

// 2) 包内容白名单:用 npm pack --dry-run 的真实清单(不落地 tarball)
let packed;
try {
  packed = packFileList(root);
} catch (e) {
  console.error(`check-publish: npm pack --dry-run 失败:${e.message}`);
  process.exit(EXIT.notRun);
}

const allowedTop = new Set(['package.json', 'README.md', 'LICENSE', 'integrity.json']);
for (const f of packed) {
  const top = f.split('/')[0];
  const okTop = allowedTop.has(f) || top === 'dist' || top === 'payload';
  if (!okTop) violations.push(`包内出现 files 白名单外的文件:${f}`);
}

// 3) 禁运形态扫描(只看会被发布的内容)
const FORBIDDEN = [
  [/\.jsonl$/, '会话原文(.jsonl)'],
  [/(^|\/)\.state\//, '.state/ 内部状态'],
  [/(^|\/)\.git\//, '.git/'],
];
let scanned = 0;
for (const rel of packed) {
  if (FORBIDDEN.some(([re]) => re.test(rel))) {
    violations.push(`禁运路径:${rel}`);
    continue;
  }
  const abs = path.join(root, rel);
  if (!existsSync(abs) || statSync(abs).isDirectory()) continue;
  scanned++;
  const text = readFileSync(abs, 'utf8');
  // 合成占位符 /Users/someone/ 是脱敏种子夹具(非真实用户名),其余绝对路径一律拦。
  const absPaths = text.match(/\/Users\/[A-Za-z0-9._-]+/g) ?? [];
  const real = absPaths.filter((p) => p !== '/Users/someone');
  if (real.length > 0)
    violations.push(`绝对路径出现在 ${rel}:${[...new Set(real)].slice(0, 2).join(', ')}`);
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) violations.push(`私钥块出现在 ${rel}`);
  if (/(?:^|\W)(?:sk|soh|ghp|xox[bp])[_-][A-Za-z0-9_-]{16,}/.test(text))
    violations.push(`密钥形态出现在 ${rel}`);
}

// 3.5) 三个版本源一致(package.json / src/contracts/meta.ts / kit.toml),防止 bump 漂移
const metaSrc = readFileSync(path.join(root, 'src/contracts/meta.ts'), 'utf8');
const metaVersion = /KIT_VERSION = '([^']+)'/.exec(metaSrc)?.[1];
const kitToml = readFileSync(path.join(root, 'kit.toml'), 'utf8');
const tomlVersion = /^version = "([^"]+)"/m.exec(kitToml)?.[1];
if (metaVersion !== pkg.version)
  violations.push(
    `src/contracts/meta.ts 的 KIT_VERSION(${metaVersion})与 package.json(${pkg.version})不一致`,
  );
if (tomlVersion !== pkg.version)
  violations.push(`kit.toml 的 version(${tomlVersion})与 package.json(${pkg.version})不一致`);

// 3.6) 许可证:package.json 声明 MIT,且 LICENSE 是标准 MIT 全文(仅版权行允许不同)
{
  const licText = readFileSync(path.join(root, 'LICENSE'), 'utf8');
  const COPYRIGHT_RE = /^Copyright \(c\) \d{4} \S.*$/m;
  const MIT_BODY =
    'MIT License\n\n<COPYRIGHT>\n\n' +
    'Permission is hereby granted, free of charge, to any person obtaining a copy\n' +
    'of this software and associated documentation files (the "Software"), to deal\n' +
    'in the Software without restriction, including without limitation the rights\n' +
    'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell\n' +
    'copies of the Software, and to permit persons to whom the Software is\n' +
    'furnished to do so, subject to the following conditions:\n\n' +
    'The above copyright notice and this permission notice shall be included in all\n' +
    'copies or substantial portions of the Software.\n\n' +
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\n' +
    'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\n' +
    'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\n' +
    'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\n' +
    'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\n' +
    'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\n' +
    'SOFTWARE.\n';
  if (pkg.license !== 'MIT')
    violations.push(
      `LICENSE_FIELD package.json 的 license 应为 "MIT",实际 ${JSON.stringify(pkg.license)}`,
    );
  const copyright = COPYRIGHT_RE.exec(licText)?.[0];
  if (copyright === undefined || licText !== MIT_BODY.replace('<COPYRIGHT>', copyright))
    violations.push('LICENSE_TEXT LICENSE 不是标准 MIT 全文(只允许版权行不同)');
}

// 3.8) payload 完整性闸(S2)
{
  const distBuild = path.join(root, TSC_OUT, 'src/build');
  const verifyUrl = pathToFileURL(path.join(distBuild, 'payload-verify.js')).href;
  const rebuildUrl = pathToFileURL(path.join(distBuild, 'payload-rebuild.js')).href;
  if (!existsSync(path.join(distBuild, 'payload-verify.js'))) {
    console.error('check-publish: 缺构建期 payload-verify.js(先 pnpm run build)');
    process.exit(EXIT.notRun);
  }
  const { verifyPayload } = await import(verifyUrl);
  const { rebuildPayload, readOutHomeTree } = await import(rebuildUrl);
  const read = (rel) => {
    const abs = path.join(root, rel);
    try {
      if (lstatSync(abs).isSymbolicLink() || !statSync(abs).isFile()) return undefined;
      return readFileSync(abs);
    } catch {
      return undefined;
    }
  };
  const rebuilt = await rebuildPayload(root);
  if (!rebuilt.ok) {
    violations.push(`PAYLOAD_REBUILD_FAILED 无法重新构建 payload:${rebuilt.message}`);
  }
  const outTree = await readOutHomeTree(root);
  if (outTree === undefined)
    violations.push('PAYLOAD_OUT_MISMATCH 仓库里没有 out/,无法核对 payload');
  const homeDir = process.env.HOME;
  for (const x of verifyPayload({
    packFiles: packed,
    read,
    version: pkg.version,
    ...(rebuilt.ok ? { rebuilt: rebuilt.bundle.tree } : {}),
    ...(outTree ? { outTree } : {}),
    ...(homeDir ? { homeDir } : {}),
  })) {
    violations.push(`${x.code}${x.path ? ` ${x.path}` : ''}: ${x.message}`);
  }
}

// 3.9) 打包闸(S7b):dependencies 为空 / 说明符 / 许可证 / sourcemap 泄漏 / integrity 覆盖 / 薄入口
{
  const { files, symlinks } = readDist(root);
  let integrityPaths;
  const integrityAbs = path.join(root, 'integrity.json');
  // fail-closed:integrity.json 缺失 / 无法解析 / 形态不对,都不能让覆盖检查悄悄跳过
  try {
    integrityPaths = JSON.parse(readFileSync(integrityAbs, 'utf8')).files.map((f) => f.path);
  } catch {
    violations.push('BUNDLE_INTEGRITY_COVERAGE integrity.json 缺失或无法解析,无法核对 dist 覆盖');
  }
  for (const x of checkBundle({
    pkg,
    files,
    symlinks,
    ...(integrityPaths ? { integrityPaths } : {}),
    ...(process.env.HOME ? { homeDir: process.env.HOME } : {}),
  }))
    violations.push(`${x.code}${x.path ? ` ${x.path}` : ''}: ${x.message}`);
}

// 4) 版本与 tag 一致
if (tag !== undefined) {
  const expected = `v${pkg.version}`;
  if (tag !== expected)
    violations.push(`tag ${tag} 与 package.json version 不一致(应为 ${expected})`);
}

if (violations.length > 0) {
  for (const v of violations) console.error(`check-publish: ${v}`);
  process.exit(EXIT.violation);
}
console.log(
  `check-publish: OK(包 ${pkg.name}@${pkg.version};清单 ${packed.length} 项,扫描 ${scanned} 个文件` +
    (tag ? `;tag ${tag} 一致)` : ')'),
);
process.exit(EXIT.ok);
