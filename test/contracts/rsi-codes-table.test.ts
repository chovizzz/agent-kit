/**
 * B4-0:R20-3.0 稳定码总表(docs/contracts.md §20.3)与 R20-6.5 结果码表 ↔ `src/contracts/rsi.ts` 枚举的**逐行、双向**一致性。
 * 覆盖全部码(不只 B4 新增的):USAGE / NOT_RUN / 顶层(4) / 顶层(1) / FAIL_CLOSED / 计数码 / 四类结果码。
 *
 * 防「静默变空」:每一行都要解析出非空、无重复的码;解析器自身有反向对照(删一行、删一个码、加一个未知码都必须被抓到)。
 * 例外清单 {@link PENDING_DOC}:枚举里有、文档总表还没并入的码,必须**恰好等于**差集(多了或少了都红),
 * 且每个都要在 §20.14 的订正条款里出现;文档把它并入总表后差集为空,本测试变红,提醒同一次提交里删掉例外。
 */
import { describe, expect, it } from 'vitest';
import {
  RSI_COUNTER_CODES,
  RSI_EXIT1_CODES,
  RSI_FAIL_CLOSED_REASONS,
  RSI_NOT_RUN_REASONS,
  RSI_OUTCOMES,
  RSI_SNAPSHOT_BUSY,
  RSI_USAGE_REASONS,
} from '../../src/contracts/rsi.js';
import { readText } from '../../src/io/read-fs.js';

const FULL = await readText(new URL('../../docs/contracts.md', import.meta.url).pathname);

/** 码总表只在 §20.3 的「稳定码总表」与 `#### 20.3.1` 之间;结果码表只在 R20-6.5 与 R20-6.6 之间(别的表里同名的行不算) */
const sliceBetween = (md: string, from: string, to: string): string => {
  const a = md.indexOf(from);
  const b = md.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`找不到区间 ${from} .. ${to}`);
  return md.slice(a, b);
};
const CODE_TABLE = sliceBetween(FULL, '**稳定码总表(R20-3.0', '#### 20.3.1');
const OUTCOME_TABLE = sliceBetween(FULL, '- R20-6.5 **结果分类**', '- R20-6.6 **熔断**');

/** 枚举有、总表没有的码(来源:§20.14 B3 订正的条款号) */
const PENDING_DOC: Record<string, readonly string[]> = {};

/** 该表里以 `| <head>` 开头的行必须**恰好一行**,取第 2 列(0 起第 2 个 `|` 分段) */
function cellOf(table: string, head: string, col = 2): string {
  const rows = table.split('\n').filter((l) => l.startsWith(`| ${head}`));
  if (rows.length === 0) throw new Error(`总表缺行 ${head}`);
  if (rows.length > 1) throw new Error(`总表行 ${head} 出现 ${rows.length} 次`);
  return (rows[0] as string).split('|')[col] ?? '';
}
/** 单元格里**所有**反引号 token 都算码(不用格式正则兼任提取器,免得漏掉格式意外的码);`ignorable` 只放明确的非码记号 */
function rowCodes(
  table: string,
  head: string,
  ignorable: (t: string) => boolean = () => false,
): string[] {
  const codes = [...cellOf(table, head).matchAll(/`([^`]+)`/g)]
    .map((m) => m[1] as string)
    .filter((t) => !ignorable(t));
  if (codes.length === 0) throw new Error(`总表行 ${head} 解析出 0 个码`);
  return codes;
}
/** R20-6.5 的非码记号:`RSI_LIMIT_*` 通配、errno 名(`EIO` 等) */
const outcomeIgnorable = (t: string): boolean => t === 'RSI_LIMIT_*' || /^E[A-Z]+$/.test(t);

const dup = (a: readonly string[]): string[] => a.filter((x, i) => a.indexOf(x) !== i);
const diff = (a: readonly string[], b: readonly string[]): string[] =>
  a.filter((x) => !b.includes(x)).sort();

interface Cat {
  name: string;
  head: string;
  enumCodes: readonly string[];
  pending?: readonly string[];
}
const CATS: Cat[] = [
  { name: 'usage', head: '`RSI_USAGE reason=`', enumCodes: RSI_USAGE_REASONS },
  { name: 'not_run', head: '`RSI_NOT_RUN reason=`', enumCodes: RSI_NOT_RUN_REASONS },
  { name: 'top4', head: '顶层(4)', enumCodes: [RSI_SNAPSHOT_BUSY] },
  { name: 'top1', head: '顶层(1)', enumCodes: RSI_EXIT1_CODES },
  {
    name: 'fail_closed',
    head: '`RSI_FAIL_CLOSED reason=`',
    enumCodes: RSI_FAIL_CLOSED_REASONS,
  },
  { name: 'counter', head: '计数码', enumCodes: RSI_COUNTER_CODES },
];

describe('R20-3.0 稳定码总表 ↔ 枚举(逐行、双向)', () => {
  for (const c of CATS) {
    it(`${c.name}:枚举与表一致(差集恰好等于待并入清单)`, () => {
      const table = rowCodes(CODE_TABLE, c.head);
      expect(dup(table), '表内重复').toEqual([]);
      expect(dup(c.enumCodes), '枚举内重复').toEqual([]);
      expect(diff(table, c.enumCodes), '表里有、枚举没有').toEqual([]);
      expect(diff(c.enumCodes, table), '枚举有、表里没有 = 待并入清单').toEqual(
        [...(c.pending ?? [])].sort(),
      );
    });
  }

  it('待并入清单里的每个码都出现在 §20.14 的订正条款里', () => {
    const sec = FULL.slice(FULL.indexOf('### 20.14'), FULL.indexOf('## 21. 自主 RSI'));
    expect(sec.length).toBeGreaterThan(1000);
    for (const [cat, codes] of Object.entries(PENDING_DOC)) {
      expect(codes.length, cat).toBeGreaterThan(0);
      for (const code of codes) expect(sec, `${cat}:${code}`).toContain(code);
    }
  });

  it('计数码枚举恰为七个,形如 RSI_*', () => {
    expect([...RSI_COUNTER_CODES]).toHaveLength(7);
    for (const c of RSI_COUNTER_CODES) expect(c).toMatch(/^RSI_[A-Z_]+$/);
  });

  it('staging_unsafe_entry 已进枚举(B3c-7)', () => {
    expect(RSI_FAIL_CLOSED_REASONS).toContain('staging_unsafe_entry');
  });
});

describe('R20-6.5 结果码表 ↔ RSI_OUTCOMES(每类独立钉住,并集与枚举双向相等)', () => {
  /** 契约的分类(对熔断的影响不同):把码在类别间挪动会改变熔断语义,所以分类本身也要钉住 */
  const EXPECT: Record<string, readonly string[]> = {
    成功: ['ok', 'ok_partial'],
    正常跳过: [
      'skipped_off',
      'skipped_stopped',
      'skipped_collect_blocked',
      'skipped_throttled',
      'skipped_locked',
      'skipped_update_busy',
      'skipped_ci',
      'skipped_child',
      'skipped_binding_changed',
      'stopped',
    ],
    可重试错误: ['io_error', 'crashed', 'internal'],
    安全阻断: [
      'state_invalid',
      'cursor_invalid',
      'counts_invalid',
      'snapshot_invalid',
      'journal_invalid',
      'signal_store_corrupt',
      'salt_invalid',
      'redactor_init',
      'write_denied',
      'lock_lost',
      'state_dir_unsafe',
      'purge_incomplete',
      'staging_too_large',
    ],
  };
  for (const [head, want] of Object.entries(EXPECT)) {
    it(`${head}:表中该行恰为钉住的集合`, () => {
      const got = rowCodes(OUTCOME_TABLE, head, outcomeIgnorable);
      expect(dup(got)).toEqual([]);
      expect([...got].sort()).toEqual([...want].sort());
    });
  }
  it('四类并集 == 枚举,且各类互不相交', () => {
    const all = Object.values(EXPECT).flat();
    expect(dup(all)).toEqual([]);
    expect(diff(all, RSI_OUTCOMES)).toEqual([]);
    expect(diff(RSI_OUTCOMES, all)).toEqual([]);
    expect(all.length).toBe(RSI_OUTCOMES.length);
  });
});

describe('解析器自身的反向对照(防止「一致」是解析器漏看)', () => {
  const head = '`RSI_NOT_RUN reason=`';
  const rowLine = (): string =>
    CODE_TABLE.split('\n').find((l) => l.startsWith(`| ${head}`)) as string;
  it('删掉一整行:抛错而不是返回空', () => {
    const t = CODE_TABLE.split('\n')
      .filter((l) => !l.startsWith(`| ${head}`))
      .join('\n');
    expect(() => rowCodes(t, head)).toThrow(/缺行/);
  });
  it('同名行出现两次:抛错(不静默取第一行)', () => {
    expect(() => rowCodes(`${CODE_TABLE}\n${rowLine()}\n`, head)).toThrow(/出现 2 次/);
  });
  it('区间外的同名行不算(表定位)', () => {
    expect(CODE_TABLE).not.toContain('## 21. 自主 RSI');
    expect(OUTCOME_TABLE.includes('RSI_USAGE reason=')).toBe(false);
  });
  it('表里删一个码:与枚举的差集立刻非空', () => {
    const t = CODE_TABLE.replace('`no_journal`', '');
    expect(diff(RSI_NOT_RUN_REASONS, rowCodes(t, head))).toEqual(['no_journal']);
  });
  it('表里加一个未知码:反向差集非空', () => {
    const t = CODE_TABLE.replace('`no_journal`', '`no_journal`、`bogus_code`');
    expect(diff(rowCodes(t, head), RSI_NOT_RUN_REASONS)).toEqual(['bogus_code']);
  });
  it('表里加一个带数字 / 连字符的码也抓得到(不被格式正则吞掉)', () => {
    const t = CODE_TABLE.replace('`no_journal`', '`no_journal`、`RSI_NEW_2`、`x-y`');
    expect(diff(rowCodes(t, head), RSI_NOT_RUN_REASONS)).toEqual(['RSI_NEW_2', 'x-y']);
  });
  it('结果码表里加 `ok2`:不被忽略', () => {
    const t = OUTCOME_TABLE.replace('`ok_partial`', '`ok_partial`、`ok2`');
    expect(rowCodes(t, '成功', outcomeIgnorable)).toContain('ok2');
  });
  it('结果码跨类别挪动:该类的钉住集合立刻对不上', () => {
    const lines = OUTCOME_TABLE.split('\n').map((l) =>
      l.startsWith('| 安全阻断') ? l.replace('`state_invalid`、', '') : l,
    );
    const got = rowCodes(lines.join('\n'), '安全阻断', outcomeIgnorable);
    expect(got).not.toContain('state_invalid');
  });
  it('行存在但码被清空:抛错(0 个码)', () => {
    const t = CODE_TABLE.split('\n')
      .map((l) => (l.startsWith(`| ${head}`) ? `| ${head} | | 4 |` : l))
      .join('\n');
    expect(() => rowCodes(t, head)).toThrow(/0 个码/);
  });
  it('枚举新增一个码而表没有:差集抓得到(模拟「枚举先于文档」的情形)', () => {
    const table = rowCodes(CODE_TABLE, '`RSI_FAIL_CLOSED reason=`');
    expect(diff([...RSI_FAIL_CLOSED_REASONS], table)).toEqual([]); // 正向前提:现状一致,差集才有意义
    expect(diff([...RSI_FAIL_CLOSED_REASONS, 'x_new'], table)).toEqual(['x_new']);
  });
});
