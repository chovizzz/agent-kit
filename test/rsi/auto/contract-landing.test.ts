/**
 * W8a 契约落地:两个常量、`RSI_FAIL_CLOSED reason=` 追加项、信息行、`AutoView` schema 与 §21.24 W0-24 订正正文(码表 ↔ 总表的双向一致由 `rsi-codes-table` 测试覆盖)。
 */
import { describe, expect, it } from 'vitest';
import {
  RSI_AUTO_VIEW_FILE,
  RSI_AUTO_VIEW_STALE_HOURS,
  RSI_FAIL_CLOSED_REASONS,
  RSI_INFO_LINE_CODES,
  RSI_P1_RESERVED_SUBCOMMANDS,
  RSI_STALL_GRACE_MINUTES,
  RSI_SUBCOMMANDS,
} from '../../../src/contracts/rsi.js';
import { AutoViewSchema } from '../../../src/contracts/rsi-personal.js';
import { readText } from '../../../src/io/read-fs.js';
import { viewOf } from './auto-fixture.js';

describe('W0-22 第 7 条常量与 AutoView', () => {
  it('RSI_AUTO_VIEW_STALE_HOURS = 48、RSI_STALL_GRACE_MINUTES = 60、视图文件名固定', () => {
    expect([RSI_AUTO_VIEW_STALE_HOURS, RSI_STALL_GRACE_MINUTES, RSI_AUTO_VIEW_FILE]).toEqual([
      48,
      60,
      'auto-view.json',
    ]);
  });

  it('AutoView 是 strictObject:多余键 / 缺键 / content_sha256 不是 64 位 / 超过 64 条 / 未知保护标记都被拒绝', () => {
    const ok = viewOf();
    expect(AutoViewSchema.safeParse(ok).success).toBe(true);
    expect(AutoViewSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    const { budget: _b, ...less } = ok;
    void _b;
    expect(AutoViewSchema.safeParse(less).success).toBe(false);
    const row = {
      id: 'ra_0123456789ab',
      content_sha256: 'a'.repeat(64),
      origin_reason: 'harm_c1',
      target_terminal: 'rolled_back',
      entered_at: '2026-11-12T00:00:00.000Z',
    };
    expect(AutoViewSchema.safeParse({ ...ok, rolling_back: [row] }).success).toBe(true);
    expect(
      AutoViewSchema.safeParse({
        ...ok,
        rolling_back: [{ ...row, content_sha256: 'a'.repeat(12) }],
      }).success,
    ).toBe(false);
    expect(
      AutoViewSchema.safeParse({ ...ok, rolling_back: Array.from({ length: 65 }, () => row) })
        .success,
    ).toBe(false);
    expect(AutoViewSchema.safeParse({ ...ok, record_oid: 'abc' }).success).toBe(false);
  });
});

describe('码表与命令名', () => {
  it('FAIL_CLOSED 追加 revocations_invalid / audit_invalid;信息行追加 RSI_MANUAL / RSI_CLEAR_DONE(不进失败码表)', () => {
    for (const c of ['revocations_invalid', 'audit_invalid']) {
      expect(RSI_FAIL_CLOSED_REASONS).toContain(c);
    }
    expect(RSI_INFO_LINE_CODES).toEqual(expect.arrayContaining(['RSI_MANUAL', 'RSI_CLEAR_DONE']));
    expect(RSI_INFO_LINE_CODES).not.toContain('RSI_AUTO_RESUMED');
  });

  it('命令名:V1 真命令进 RSI_SUBCOMMANDS(只追加、不重排),V4–V6 的命令名注册为桩', () => {
    expect(RSI_SUBCOMMANDS.slice(-5)).toEqual(['auto', 'veto', 'rollback', 'report', 'show']);
    expect(RSI_SUBCOMMANDS.slice(0, 12).at(-1)).toBe('dismiss');
    expect([...RSI_P1_RESERVED_SUBCOMMANDS]).toEqual([
      'should-continue',
      'contrib',
      'capability',
      'isolation',
      'exec-run',
      'exec-prepare',
      'exec-confirm',
    ]);
  });

  it('§21.24 W0-24 订正正文存在,并写明桩的规范名与 runGitClosed 的限域', async () => {
    const md = await readText(new URL('../../../docs/contracts.md', import.meta.url).pathname);
    expect(md).toContain('#### W0-24 W8a 落地订正');
    expect(md).toContain('runGitClosed');
    expect(md).toContain('auto status');
  });
});
