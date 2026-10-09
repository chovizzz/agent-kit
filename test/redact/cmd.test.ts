import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { createRedactCommand } from '../../src/commands/redact-cmd.js';
import { chunkForCheck } from '../../src/redact/chunk.js';
import { writeFile } from '../../src/io/safe-fs.js';
import { baseCtx, makeTempDir } from '../helpers/tmp.js';
import { fakeSk, placeholder, rep } from './helpers.js';

async function run(
  argv: string[],
  stdin = '',
  opts: { overlayPath?: string; stdinThrows?: boolean } = {},
) {
  let out = '';
  let err = '';
  const cmd = createRedactCommand({
    readStdin: async () => {
      if (opts.stdinThrows) throw new Error('boom');
      return stdin;
    },
  });
  const code = await cmd.run({
    argv,
    io: baseCtx(),
    overlayPath: opts.overlayPath,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  });
  return { code, out, err };
}

describe('redact --stdin', () => {
  it('脱敏后输出到 stdout,退出 0', async () => {
    const r = await run(['--stdin'], `k=${fakeSk()} tail`);
    expect(r).toEqual({ code: 0, out: `k=${placeholder('api_key')} tail`, err: '' });
  });

  it('保持输入的末尾换行,不额外添加', async () => {
    expect((await run(['--stdin'], 'plain\n')).out).toBe('plain\n');
    expect((await run(['--stdin'], 'plain')).out).toBe('plain');
  });

  it('残留 => 退出 3,stdout 为空,stderr 只有原因码、不含任何输入内容', async () => {
    const secretish = 'sk%25252D' + rep('a1', 22);
    const r = await run(['--stdin'], `hello ${secretish}`);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r.out).toBe('');
    expect(r.err).toBe('REDACT_FAIL_CLOSED reason=residual\n');
    expect(r.err).not.toContain('hello');
  });

  it('超时 => 退出 3', async () => {
    const r = await run(['--stdin', '--timeout-ms', '1'], rep('word ', 60000));
    // 1ms 预算下 300KB 文本必然超时或超上限;无论哪种都是 fail-closed
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r.out).toBe('');
    expect(r.err).toMatch(/^REDACT_FAIL_CLOSED reason=(timeout|error)\n$/);
  });

  it('stdin 读取失败 => 退出 3', async () => {
    const r = await run(['--stdin'], '', { stdinThrows: true });
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r.out).toBe('');
  });

  it('--allow-host 放行指定主机', async () => {
    const u = 'https' + '://github.com/org/repo';
    expect((await run(['--stdin', '--allow-host', 'github.com'], `see ${u}`)).out).toBe(`see ${u}`);
    expect((await run(['--stdin'], `see ${u}`)).out).toBe(`see ${placeholder('url')}`);
  });

  it('--check:干净 0、有命中 1(只打印规则/类型/偏移)、不输出文本', async () => {
    const clean = await run(['--stdin', '--check'], `x ${placeholder('ip')} y`);
    expect(clean).toEqual({ code: 0, out: '', err: '' });
    const k = fakeSk();
    const dirty = await run(['--stdin', '--check'], `a\nb ${k}`);
    expect(dirty.code).toBe(ExitCode.CHECK_FAILED);
    expect(dirty.out).toBe('');
    expect(dirty.err).toBe('REDACT_HIT rule=prefix_sk type=api_key offset=4\n');
    expect(dirty.err).not.toContain(k);
  });

  it('--check 分块扫描超大输入,偏移是整份输入里的绝对偏移', async () => {
    const pad = 'lorem ipsum dolor sit amet\n'.repeat(30_000);
    const k = fakeSk();
    // 本用例只验证分块偏移,与时限无关:显式给足预算,避免机器忙时默认 50ms 触发 fail-closed(退出 3)而偶发红。
    const r = await run(['--stdin', '--check', '--timeout-ms', '10000'], `${pad}${k}\n${pad}`);
    expect(r.code).toBe(ExitCode.CHECK_FAILED);
    expect(r.err).toContain(`offset=${pad.length}`);
  });
});

describe('redact 用法与覆盖层', () => {
  it('用法错误退出 2', async () => {
    for (const argv of [
      [],
      ['--bogus'],
      ['--selftest', '--stdin'],
      ['--mutate'],
      ['--check'],
      ['--stdin', '--timeout-ms', 'abc'],
      ['--stdin', '--allow-host'],
    ]) {
      const r = await run(argv);
      expect(r.code, argv.join(' ')).toBe(ExitCode.USAGE);
    }
  });

  it('--selftest 退出 0 并打印召回统计,不含种子内容', async () => {
    const r = await run(['--selftest']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/recall: (\d+)\/\1\b/);
    expect(r.out).toContain('SELFTEST OK');
  });

  it('--overlay 提供敏感词表与内部域名;覆盖层坏了退出 2 且不回显内容', async () => {
    const { ctx, dir } = await makeTempDir('redact-overlay-');
    const good = path.join(dir, 'overlay.toml');
    await writeFile(
      ctx,
      good,
      'sensitive_words = ["张三科技"]\ninternal_domains = ["corp.acme-fake.dev"]\n',
    );
    const r = await run(['--stdin'], '客户 张三科技 @ a.corp.acme-fake.dev', { overlayPath: good });
    expect(r.code).toBe(0);
    expect(r.out).toBe(`客户 ${placeholder('sensitive')} @ a.${placeholder('domain')}`);

    const bad = path.join(dir, 'bad.toml');
    await writeFile(ctx, bad, 'sensitive_words = "不是数组-这里是机密词"\n');
    const rb = await run(['--stdin'], 'x', { overlayPath: bad });
    expect(rb.code).toBe(ExitCode.USAGE);
    expect(rb.err).not.toContain('机密词');
    const missing = await run(['--stdin'], 'x', { overlayPath: path.join(dir, 'nope.toml') });
    expect(missing.code).toBe(ExitCode.USAGE);
  });
});

describe('chunkForCheck', () => {
  it('短文本不切;长文本每块不超上限、块间重叠、覆盖全部内容', () => {
    expect(chunkForCheck('abc', 100, 10)).toEqual([{ start: 0, text: 'abc' }]);
    const text = 'line number x\n'.repeat(5000);
    const chunks = chunkForCheck(text, 10000, 500);
    expect(chunks.length).toBeGreaterThan(5);
    let covered = 0;
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(10000);
      expect(text.slice(c.start, c.start + c.text.length)).toBe(c.text);
      expect(c.start).toBeLessThanOrEqual(covered);
      covered = Math.max(covered, c.start + c.text.length);
    }
    expect(covered).toBe(text.length);
  });
});
