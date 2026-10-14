#!/usr/bin/env node
/**
 * 生成随 npm 包分发的 payload(S2):`payload/`(out 里 target=home 的文件原样 + manifest.json)与包根 `integrity.json`。
 *
 * 顺序:pnpm run build(tsc)→ node scripts/build-payload.mjs → node scripts/check-publish.mjs → npm publish。
 * integrity.json 覆盖「包内每个文件(不含自身)」,含 dist/,所以必须在 tsc 之后、打包之前生成;
 * 之后再改 dist 会被 check-publish 的 PAYLOAD_FILE_TAMPERED 拦下。
 *
 * payload/ 与 integrity.json 是构建产物,不进 git(.gitignore)。确定性:同输入两次运行字节相同。
 * 退出码:0 成功 | 1 构建失败 | 4 未执行(缺 dist)。
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { packFileList } from './lib/pack.mjs';

const root = process.cwd();
const distSrc = path.join(root, 'dist/src/build');
if (!existsSync(path.join(distSrc, 'payload-rebuild.js'))) {
  console.error('build-payload: 缺 dist(先 pnpm run build)');
  process.exit(4);
}
const { rebuildPayload } = await import(
  pathToFileURL(path.join(distSrc, 'payload-rebuild.js')).href
);
const { buildIntegrity, INTEGRITY_PATH } = await import(
  pathToFileURL(path.join(distSrc, 'payload.js')).href
);

const res = await rebuildPayload(root);
if (!res.ok) {
  console.error(`build-payload: 构建 payload 失败:${res.message}`);
  process.exit(1);
}
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
if (res.kitVersion !== pkg.version) {
  console.error(
    `build-payload: kit.toml 的 version(${res.kitVersion})与 package.json(${pkg.version})不一致`,
  );
  process.exit(1);
}

const payloadDir = path.join(root, 'payload');
for (const p of [payloadDir, path.join(root, INTEGRITY_PATH)]) {
  if (existsSync(p) && lstatSync(p).isSymbolicLink()) {
    console.error(`build-payload: ${path.basename(p)} 是符号链接,拒绝写入`);
    process.exit(1);
  }
}
rmSync(payloadDir, { recursive: true, force: true });
rmSync(path.join(root, INTEGRITY_PATH), { force: true });
for (const [rel, content] of res.bundle.tree) {
  const abs = path.join(root, ...rel.split('/'));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, { mode: 0o644 });
}

const entries = packFileList(root).map((rel) => ({
  path: rel,
  content: readFileSync(path.join(root, rel)),
}));
const { text } = buildIntegrity(pkg.version, entries);
writeFileSync(path.join(root, INTEGRITY_PATH), text, { mode: 0o644 });
console.log(
  `build-payload: payload ${res.bundle.tree.size} 个文件(含 manifest.json);integrity.json 覆盖 ${entries.length} 个包内文件`,
);
