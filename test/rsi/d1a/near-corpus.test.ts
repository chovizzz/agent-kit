/**
 * D1a:near_fp 语料评估工具(进程内;不含真实语料,全部是合成文本)。
 * 子进程启动器的冒烟用例在 `near-corpus-launcher.test.ts`(单独文件,红了不拖累本文件的判读)。
 */
import { describe, expect, it } from 'vitest';
import {
  CORPUS_KEYS,
  DEFAULT_THRESHOLDS,
  evaluateCorpus,
  formatReport,
  parseCorpus,
  runCorpusCli,
  type CliIo,
  type CorpusCase,
} from '../../tools/near-fp-corpus.js';

const A = 'Always run the unit tests before pushing any code to the shared repository';
const EXPANDED = `${A} branch so that failures are caught early by the whole team before review`;
const PREFIX = 'Always run the unit tests before pushing any';
const REWRITE =
  'Please execute every automated check prior to uploading changes into the common codebase';
const UNRELATED = 'Completely different sentence about database migrations and rollback plans';

const mk = (
  id: string,
  label: 'match' | 'nomatch',
  vetoed: string,
  candidate: string,
): CorpusCase => ({
  id,
  label,
  vetoed,
  candidate,
});

describe('语料评估:统计与阈值建议', () => {
  it('默认阈值 0.05 … 1.00 共 20 档;评估密钥 5 把、各 32 字节、互不相同,第一把是字节 1..32', () => {
    expect(DEFAULT_THRESHOLDS).toHaveLength(20);
    expect(DEFAULT_THRESHOLDS[0]).toBe(0.05);
    expect(DEFAULT_THRESHOLDS[19]).toBe(1);
    expect(CORPUS_KEYS).toHaveLength(5);
    for (const k of CORPUS_KEYS) expect(k.length).toBe(32);
    expect(new Set(CORPUS_KEYS.map((k) => Buffer.from(k).toString('hex'))).size).toBe(5);
    expect(Array.from(CORPUS_KEYS[0] as Uint8Array)).toEqual(
      Array.from({ length: 32 }, (_v, i) => i + 1),
    );
  });

  it('评估统计依赖密钥:超过 64 个 shingle 的被否决内容 → 多密钥最坏情形 + 波动警告;不超过时多 / 单密钥一致(对照)', () => {
    const words = (n: number): string =>
      Array.from({ length: n }, (_v, i) => `w${i + 1}`).join(' ');
    const long = [mk('m_long', 'match', words(80), words(50))];
    const ths = [0.5, 0.6, 0.7];
    const multi = evaluateCorpus(long, { thresholds: ths });
    const single = evaluateCorpus(long, {
      thresholds: ths,
      keys: [CORPUS_KEYS[0] as Uint8Array],
    });
    expect(multi.keys).toBe(5);
    expect(single.keys).toBe(1);
    expect(multi.truncatedIds).toEqual(['m_long']);
    expect(multi.warnings).toContain('bottom_k_truncation_key_dependent');
    multi.thresholds.forEach((t, i) => {
      expect(t.tp).toBeLessThanOrEqual((single.thresholds[i] as { tp: number }).tp);
    });
    // 对照:草图未截断(≤ 64 个 shingle)时与密钥无关
    const short = [mk('m', 'match', A, PREFIX), mk('n', 'nomatch', A, REWRITE)];
    const a = evaluateCorpus(short, { thresholds: ths });
    const b = evaluateCorpus(short, { thresholds: ths, keys: [CORPUS_KEYS[2] as Uint8Array] });
    expect(a.thresholds.map((t) => [t.tp, t.fn, t.fp, t.tn])).toEqual(
      b.thresholds.map((t) => [t.tp, t.fn, t.fp, t.tn]),
    );
    expect(a.warnings).not.toContain('bottom_k_truncation_key_dependent');
    expect(() => evaluateCorpus(short, { keys: [] })).toThrowError(
      new RangeError('at least one evaluation key is required'),
    );
  });

  it('命中 / 误报按阈值分档:前缀(覆盖率 6/11)在 0.5 命中、在 0.6 漏掉;改写与无关恒不命中', () => {
    const r = evaluateCorpus(
      [
        mk('m_expand', 'match', A, EXPANDED),
        mk('m_prefix', 'match', A, PREFIX),
        mk('n_rewrite', 'nomatch', A, REWRITE),
        mk('n_unrelated', 'nomatch', A, UNRELATED),
      ],
      { thresholds: [0.6, 0.5, 1] },
    );
    expect(r.thresholds.map((t) => t.threshold)).toEqual([0.5, 0.6, 1]);
    const [t50, t60, t100] = r.thresholds;
    expect([t50?.tp, t50?.fn, t50?.fp, t50?.tn]).toEqual([2, 0, 0, 2]);
    expect([t60?.tp, t60?.fn, t60?.fp, t60?.tn]).toEqual([1, 1, 0, 2]);
    expect(t60?.fnIds).toEqual(['m_prefix']);
    expect([t100?.tp, t100?.fn]).toEqual([1, 1]);
    expect([t50?.hitRate, t60?.hitRate, t50?.fpRate]).toEqual([1, 0.5, 0]);
    expect(r.recommendation).toEqual({ threshold: 0.5, hitRate: 1, fpRate: 0 });
    expect(r.coverage.match).toEqual({ n: 2, min: 6 / 11, median: 6 / 11, max: 1 });
    expect(r.coverage.nomatch).toEqual({ n: 2, min: 0, median: 0, max: 0 });
  });

  it('误报:同一前缀标成 nomatch 时 0.5 出现误报;maxFpRate = 0 时建议避开它,并列取最高阈值', () => {
    const cases = [
      mk('m_expand', 'match', A, EXPANDED),
      mk('m_prefix', 'match', A, PREFIX),
      mk('n_prefix_like', 'nomatch', A, PREFIX),
    ];
    const strict = evaluateCorpus(cases, { thresholds: [0.5, 0.6, 1], maxFpRate: 0 });
    expect(strict.thresholds[0]?.fpIds).toEqual(['n_prefix_like']);
    expect(strict.thresholds[0]?.fpRate).toBe(1);
    // 0.6 与 1.0 误报都为 0、命中率都为 0.5 → 并列取最高阈值
    expect(strict.recommendation).toEqual({ threshold: 1, hitRate: 0.5, fpRate: 0 });
    // 对照:放宽到 maxFpRate = 1,命中率最高的 0.5 变为建议
    const loose = evaluateCorpus(cases, { thresholds: [0.5, 0.6, 1], maxFpRate: 1 });
    expect(loose.recommendation).toEqual({ threshold: 0.5, hitRate: 1, fpRate: 1 });
  });

  it('被否决内容不足 3 个 token(exact_only)不计入统计,只列 id 并给警告', () => {
    const r = evaluateCorpus(
      [mk('short', 'match', 'a b', 'a b c'), mk('ok', 'match', A, EXPANDED)],
      {
        thresholds: [0.5],
      },
    );
    expect(r.exactOnlyIds).toEqual(['short']);
    expect(r.counts).toEqual({ match: 1, nomatch: 0 });
    expect(r.warnings).toEqual([
      'insufficient_sample',
      'no_nomatch_cases',
      'no_threshold_within_max_fp_rate',
      'exact_only_cases_excluded',
    ]);
  });

  it('没有任何阈值满足误报上限 → recommendation = null 并警告', () => {
    const r = evaluateCorpus(
      [mk('m', 'match', A, EXPANDED), mk('n_same', 'nomatch', A, EXPANDED)],
      { thresholds: [0.5, 1], maxFpRate: 0 },
    );
    expect(r.recommendation).toBeNull();
    expect(r.warnings).toContain('no_threshold_within_max_fp_rate');
  });

  it('样本数达标(每类 ≥ 20)时没有 insufficient_sample 警告(对照)', () => {
    const many: CorpusCase[] = [];
    for (let i = 0; i < 20; i++) {
      many.push(mk(`m${i}`, 'match', `${A} number ${i}`, `${EXPANDED} number ${i}`));
      many.push(mk(`n${i}`, 'nomatch', `${A} number ${i}`, `${UNRELATED} item ${i}`));
    }
    expect(evaluateCorpus(many, { thresholds: [0.5] }).warnings).toEqual([]);
  });

  it('确定性:同输入两次评估结果逐项相等;阈值不合法 → RangeError', () => {
    const cases = [mk('m', 'match', A, EXPANDED), mk('n', 'nomatch', A, REWRITE)];
    expect(evaluateCorpus(cases)).toEqual(evaluateCorpus(cases));
    expect(() => evaluateCorpus(cases, { thresholds: [0] })).toThrowError(RangeError);
    expect(() => evaluateCorpus(cases, { maxFpRate: 2 })).toThrowError(
      new RangeError('maxFpRate must be in [0, 1]'),
    );
  });

  it('报告文本只含 id 与统计,不含语料内容', () => {
    const r = evaluateCorpus(
      [mk('m', 'match', A, PREFIX), mk('n_prefix_like', 'nomatch', A, PREFIX)],
      { thresholds: [0.5, 0.6] },
    );
    const text = formatReport(r);
    expect(text).toContain('false positives @0.50: n_prefix_like');
    expect(text).toContain('recommendation: threshold 0.60');
    for (const secret of [A, PREFIX, 'unit tests', 'repository'])
      expect(text).not.toContain(secret);
    for (const secret of [A, PREFIX, 'unit tests']) {
      expect(JSON.stringify(r)).not.toContain(secret);
    }
  });
});

describe('语料解析', () => {
  const line = (o: Record<string, unknown>): string => JSON.stringify(o);
  const good = { id: 'c1', label: 'match', vetoed: 'v', candidate: 'c', kind: 'expansion' };

  it('合法行通过;空行忽略;多个文件按给定顺序', () => {
    const r = parseCorpus([
      {
        name: 'a.jsonl',
        text: `${line(good)}\n\n${line({ ...good, id: 'c2', kind: undefined })}\n`,
      },
      { name: 'b.jsonl', text: line({ ...good, id: 'c3', label: 'nomatch' }) },
    ]);
    expect(r.errors).toEqual([]);
    expect(r.cases.map((c) => [c.id, c.label, c.kind])).toEqual([
      ['c1', 'match', 'expansion'],
      ['c2', 'match', undefined],
      ['c3', 'nomatch', 'expansion'],
    ]);
  });

  it('非法行逐条报错,带「文件:行号」,不回显内容', () => {
    const secret = 'SECRET-TEXT-VALUE';
    const r = parseCorpus([
      {
        name: 'x.jsonl',
        text: [
          '{not json',
          '[1]',
          line({ ...good, id: '' }),
          line({ ...good, label: 'maybe', vetoed: secret }),
          line({ ...good, vetoed: 5 }),
          line({ ...good, kind: 3 }),
          line(good),
          line(good),
        ].join('\n'),
      },
    ]);
    expect(r.errors).toEqual([
      'x.jsonl:1: not valid JSON',
      'x.jsonl:2: not an object',
      'x.jsonl:3: id must be a non-empty string',
      'x.jsonl:4: label must be "match" or "nomatch"',
      'x.jsonl:5: vetoed and candidate must be strings',
      'x.jsonl:6: kind must be a string',
      'x.jsonl:8: duplicate id c1',
    ]);
    expect(r.cases.map((c) => c.id)).toEqual(['c1']);
    expect(r.errors.join('\n')).not.toContain(secret);
  });
});

describe('命令行(进程内,注入 IO)', () => {
  const corpus = [mk('m', 'match', A, EXPANDED), mk('n', 'nomatch', A, REWRITE)]
    .map((c) => JSON.stringify(c))
    .join('\n');
  const run = async (argv: string[], text = corpus) => {
    let out = '';
    let err = '';
    let asked = '';
    const io: CliIo = {
      readCorpus: async (d) => {
        asked = d;
        return [{ name: 'c.jsonl', text }];
      },
      out: (s) => (out += s),
      err: (s) => (err += s),
    };
    const code = await runCorpusCli(argv, io);
    return { code, out, err, asked };
  };

  it('成功:退出 0,读的是给定目录,输出表头与建议', async () => {
    const r = await run(['/some/dir', '--thresholds', '0.5,1']);
    expect(r.code).toBe(0);
    expect(r.asked).toBe('/some/dir');
    expect(r.out).toContain('threshold    tp   fn   fp   tn  hit_rate  fp_rate');
    expect(r.out).toContain('recommendation: threshold 1.00');
    expect(r.out).not.toContain('0.05');
    expect(r.err).toBe('');
  });

  it('--json:输出可解析,阈值档与参数一致', async () => {
    const r = await run(['d', '--json', '--thresholds', '0.4,0.8', '--max-fp-rate', '0.5']);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as { thresholds: { threshold: number }[]; maxFpRate: number };
    expect(j.thresholds.map((t) => t.threshold)).toEqual([0.4, 0.8]);
    expect(j.maxFpRate).toBe(0.5);
  });

  it('用法错一律退出 2 且不读语料:缺目录 / 未知选项 / 多余参数 / 缺值 / 阈值越界 / 误报率越界', async () => {
    for (const argv of [
      [],
      ['d', '--wat'],
      ['d', 'e'],
      ['d', '--thresholds'],
      ['d', '--thresholds', '0,0.5'],
      ['d', '--thresholds', 'x'],
      ['d', '--max-fp-rate', '2'],
      ['d', '--max-fp-rate', 'abc'],
    ]) {
      const r = await run(argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.asked, argv.join(' ')).toBe('');
      expect(r.err).toContain('usage:');
    }
  });

  it('语料不合规 / 没有用例 → 退出 2,错误只含位置不含内容', async () => {
    const bad = await run(['d'], '{"id":"x","label":"nope","vetoed":"SECRET","candidate":"c"}');
    expect(bad.code).toBe(2);
    expect(bad.err).toBe('corpus error: c.jsonl:1: label must be "match" or "nomatch"\n');
    expect(bad.err).not.toContain('SECRET');
    const empty = await run(['d'], '\n\n');
    expect(empty.code).toBe(2);
    expect(empty.err).toBe('corpus has no cases\n');
  });
});
