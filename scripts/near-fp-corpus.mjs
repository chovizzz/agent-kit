#!/usr/bin/env node
/**
 * near_fp 语料评估(离线,D1a;供 D3-nf 冻结阈值用):给定语料目录,输出不同阈值下的命中 / 误报统计与阈值建议。
 *
 *   node scripts/near-fp-corpus.mjs <corpus-dir> [--thresholds 0.3,0.5,0.7] [--max-fp-rate 0] [--json]
 *
 * 语料:目录下每个 `*.jsonl`(不递归),每行 {"id","label":"match"|"nomatch","vetoed","candidate","kind"?}。
 * 只输出 case id 与统计,不输出文本。仓库里不含任何真实语料;语料由 owner 离线准备,不要提交进仓库。
 * 退出码:0 完成;2 用法错 / 语料不合规。
 * 实现:本脚本只做目录读取与进程拉起(以 `--experimental-strip-types` 加解析钩子子进程加载 TS 评估器),评估逻辑在 `test/tools/near-fp-corpus.ts`。
 */
import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(import.meta.url);
const CHILD = 'NEAR_FP_CORPUS_CHILD';

if (process.env[CHILD] !== '1') {
  const register = pathToFileURL(path.join(path.dirname(here), 'lib', 'ts-register.mjs')).href;
  const r = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
      '--import',
      register,
      here,
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit', env: { ...process.env, [CHILD]: '1' } },
  );
  process.exit(r.status ?? 1);
}

const tool = await import(
  pathToFileURL(path.resolve(path.dirname(here), '..', 'test', 'tools', 'near-fp-corpus.ts')).href
);
const code = await tool.runCorpusCli(process.argv.slice(2), {
  async readCorpus(dir) {
    const names = (await readdir(dir)).filter((n) => n.endsWith('.jsonl')).sort();
    const out = [];
    for (const name of names)
      out.push({ name, text: await readFile(path.join(dir, name), 'utf8') });
    return out;
  },
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
});
process.exit(code);
