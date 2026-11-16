/**
 * D1a:语料评估启动器 `scripts/near-fp-corpus.mjs` 的真子进程冒烟(单独文件:启动器 / 解析钩子 / type stripping 出问题时只红这里)。
 * 语料是本测试合成的临时文件;启动器以 `--experimental-strip-types` + 解析钩子加载 TS 评估器。
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeFile } from '../../../src/io/safe-fs.js';
import { REPO_ROOT, makeTempDir } from '../../helpers/tmp.js';

const A = 'Always run the unit tests before pushing any code to the shared repository';
const EXPANDED = `${A} branch so that failures are caught early by the whole team before review`;
const REWRITE =
  'Please execute every automated check prior to uploading changes into the common codebase';
const LAUNCHER = path.join(REPO_ROOT, 'scripts', 'near-fp-corpus.mjs');

const run = (args: string[]) =>
  spawnSync(process.execPath, [LAUNCHER, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: { PATH: '/usr/bin:/bin' },
  });

describe('scripts/near-fp-corpus.mjs(真子进程)', () => {
  it('给定语料目录:退出 0,stdout 有统计表与建议、不含语料文本', async () => {
    const { ctx, dir } = await makeTempDir('d1a-corpus-');
    const rows = [
      { id: 'm1', label: 'match', vetoed: A, candidate: EXPANDED },
      { id: 'n1', label: 'nomatch', vetoed: A, candidate: REWRITE },
    ];
    await writeFile(
      ctx,
      path.join(dir, 'one.jsonl'),
      rows.map((r) => JSON.stringify(r)).join('\n'),
    );
    await writeFile(ctx, path.join(dir, 'ignored.txt'), 'not a corpus file');
    const r = run([dir, '--thresholds', '0.5,1']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('near_fp corpus report (algo rsi-near-v1, frozen=false');
    expect(r.stdout).toContain('cases 2: match 1, nomatch 1, exact_only excluded 0');
    expect(r.stdout).toContain('recommendation: threshold 1.00');
    expect(r.stdout).not.toContain('Always run');
  });

  it('语料不合规 → 退出 2,stderr 只有位置', async () => {
    const { ctx, dir } = await makeTempDir('d1a-corpus-bad-');
    await writeFile(ctx, path.join(dir, 'bad.jsonl'), '{"id":"x"}\n');
    const r = run([dir]);
    expect(r.status).toBe(2);
    expect(r.stderr).toBe('corpus error: bad.jsonl:1: label must be "match" or "nomatch"\n');
  });

  it('缺参数 → 退出 2 并打印用法', () => {
    const r = run([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage: near-fp-corpus <corpus-dir>');
  });
});
