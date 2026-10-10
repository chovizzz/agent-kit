#!/usr/bin/env node
/**
 * 发布前自检(P1-D:GitHub Actions → npm)。
 *
 * 只做**发布面**的检查,不重复 CI 已经跑过的 typecheck/test/lint:
 *   1. dist/ 存在且入口齐全(cli.js + src/ + adapters/);
 *   2. 包内容白名单:只允许 package.json 声明的 `files`(dist/ README.md LICENSE);
 *   3. 禁运形态扫描:会话原文(.jsonl)、.state/、绝对路径(/Users/…)、私钥块;
 *   4. 版本与 tag 一致(在 CI 里由 GITHUB_REF 提供;本地可传 --tag vX.Y.Z)。
 *
 * 退出码:0 通过 | 1 有违规 | 2 用法错 | 4 未执行(缺 dist 等前置)。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';

const EXIT = { ok: 0, violation: 1, usage: 2, notRun: 4 };

function usage(msg) {
  if (msg) console.error(`check-publish: ${msg}`);
  console.error('用法: node scripts/check-publish.mjs [--tag vX.Y.Z]');
  process.exit(EXIT.usage);
}

const argv = process.argv.slice(2);
let tag;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--tag') {
    tag = argv[i + 1];
    if (!tag) usage('--tag 需要一个值');
    i++;
  } else {
    usage(`未知参数 ${argv[i]}`);
  }
}

const root = process.cwd();
const violations = [];

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

// 1) dist 齐全
const required = ['dist/cli.js', 'dist/src', 'dist/adapters'];
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
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  packed = JSON.parse(out)[0].files.map((f) => f.path);
} catch (e) {
  console.error(`check-publish: npm pack --dry-run 失败:${e.message}`);
  process.exit(EXIT.notRun);
}

const allowedTop = new Set(['package.json', 'README.md', 'LICENSE']);
for (const f of packed) {
  const top = f.split('/')[0];
  const okTop = allowedTop.has(f) || top === 'dist';
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
