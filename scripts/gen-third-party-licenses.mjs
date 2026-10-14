#!/usr/bin/env node
/**
 * 生成 `dist/THIRD_PARTY_LICENSES`(S7b):汇总**产物里实际包含**的第三方包的许可证标识与正文。
 *
 * 包清单来自产物自身的 `//#region …/node_modules/<pkg>/…` 注释(detectBundledPackages),不是 package.json 的依赖声明:
 * 传递依赖(sigstore 的 50 余个包、tuf-js、make-fetch-happen、cacache、proxy-agent …)全部自动覆盖。
 * 每个条目 = package.json 的 license 字段 + 包目录里的 LICENSE* / LICENCE* / COPYING* 与 NOTICE* 文件原文。
 * 确定性:按 name@version 字节序排序,内容只取自包目录,不含时间 / 路径。
 *
 * 用法:node scripts/gen-third-party-licenses.mjs [--dist <dir>] [--root <repo>]
 * 退出码:0 成功 | 1 某个包没有许可证标识或正文 | 4 缺 dist
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import { NO_LICENSE_FILE_MARKER, detectBundledPackages, readDist } from './lib/bundle-gate.mjs';

const LICENSE_FILE_RE = /^(?:licen[cs]e|copying|notice)(?:[-._].*)?$/i;
const byteCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function parseArgs(argv) {
  const out = { root: process.cwd(), dist: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dist') out.dist = argv[++i];
    else if (argv[i] === '--root') out.root = path.resolve(argv[++i]);
    else {
      console.error(`gen-third-party-licenses: 未知参数 ${argv[i]}`);
      process.exit(2);
    }
  }
  out.dist = path.resolve(out.dist ?? path.join(out.root, 'dist'));
  return out;
}

/** package.json 的 license 字段 → 单行标识(兼容旧的 licenses 数组 / {type}) */
function licenseId(pj) {
  const l = pj.license ?? pj.licenses;
  if (typeof l === 'string') return l;
  if (Array.isArray(l))
    return l
      .map((x) => (typeof x === 'string' ? x : x?.type))
      .filter(Boolean)
      .join(' OR ');
  if (l && typeof l === 'object' && typeof l.type === 'string') return l.type;
  return '';
}

export function buildLicensesText(root, packages) {
  const blocks = [];
  const problems = [];
  const ids = [...packages.keys()].sort(byteCompare);
  for (const key of ids) {
    const dir = path.resolve(root, packages.get(key));
    const pjPath = path.join(dir, 'package.json');
    if (!existsSync(pjPath)) {
      problems.push(`${key}: 找不到 ${path.relative(root, pjPath)}`);
      continue;
    }
    const pj = JSON.parse(readFileSync(pjPath, 'utf8'));
    const name = pj.name ?? key.slice(0, key.lastIndexOf('@'));
    const id = `${name}@${pj.version ?? key.slice(key.lastIndexOf('@') + 1)}`;
    const lic = licenseId(pj);
    const texts = readdirSync(dir)
      .filter((f) => LICENSE_FILE_RE.test(f))
      .sort(byteCompare)
      .map((f) => ({ f, t: readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim() }))
      .filter((x) => x.t !== '');
    if (lic === '') problems.push(`${id}: package.json 没有 license 字段`);
    const author = typeof pj.author === 'string' ? pj.author : (pj.author?.name ?? '');
    const repo = typeof pj.repository === 'string' ? pj.repository : (pj.repository?.url ?? '');
    // 少数包(如 @sigstore/verify、@npmcli/agent)的 npm 发布物不带 LICENSE 文件:退而记录 package.json 的声明,不留空
    const body =
      texts.length === 0
        ? `${NO_LICENSE_FILE_MARKER};以下取自其 package.json)\nlicense: ${lic}\nauthor: ${author}\nrepository: ${repo}`
        : texts.map((x) => (texts.length > 1 ? `--- ${x.f} ---\n${x.t}` : x.t)).join('\n\n');
    blocks.push(`== ${id} (${lic}) ==\n\n${body}\n`);
  }
  const header =
    '本文件由 scripts/gen-third-party-licenses.mjs 生成,汇总打包进 dist/ 的第三方包及其许可证原文。\n' +
    '不要手改;依赖变化后重新 `pnpm run build`。\n\n';
  return { text: header + blocks.join('\n'), problems };
}

if (
  import.meta.url === new URL(process.argv[1], 'file://').href ||
  process.argv[1]?.endsWith('gen-third-party-licenses.mjs')
) {
  const { root, dist } = parseArgs(process.argv.slice(2));
  if (!existsSync(path.join(dist, 'cli.js'))) {
    console.error(`gen-third-party-licenses: 缺 ${dist}/cli.js(先 vite build)`);
    process.exit(4);
  }
  // readDist 以 root 为基准;dist 可能在仓库之外(测试用),所以按目录名读
  const { files } = readDist(path.dirname(dist), path.basename(dist));
  const js = [...files]
    .filter(([rel]) => /\.(?:m?js|cjs)$/.test(rel))
    .map(([, b]) => Buffer.from(b).toString('utf8'));
  const packages = detectBundledPackages(js);
  const { text, problems } = buildLicensesText(root, packages);
  if (problems.length > 0) {
    for (const p of problems) console.error(`gen-third-party-licenses: ${p}`);
    process.exit(1);
  }
  writeFileSync(path.join(dist, 'THIRD_PARTY_LICENSES'), text, { mode: 0o644 });
  console.log(
    `gen-third-party-licenses: ${packages.size} 个第三方包 → ${path.join(path.basename(dist), 'THIRD_PARTY_LICENSES')}`,
  );
}
