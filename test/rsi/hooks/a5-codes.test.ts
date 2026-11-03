/**
 * A5:稳定码枚举 ↔ 契约文字(R20-15.28 / R20-15.24a / R20-15.25 与 §20.3 的 A5 订正段)逐项对拍;`--json` 固定键集。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RSI_HOOKS_DECLINED,
  RSI_HOOKS_FAIL_CLOSED_REASONS,
  RSI_HOOKS_JSON_KEYS,
  RSI_HOOKS_MODES,
  RSI_HOOKS_MODE_FLAGS,
  RSI_HOOKS_NOT_RUN_REASONS,
  RSI_HOOKS_WARN,
  RSI_HOOKS_WARN_REASONS,
  RSI_HOOKS_WRITE_LEVELS,
} from '../../../src/contracts/rsi-hooks.js';
import {
  RSI_EXIT1_CODES,
  RSI_FAIL_CLOSED_REASONS,
  RSI_USAGE_REASONS,
} from '../../../src/contracts/rsi.js';
import { readText } from '../../../src/io/read-fs.js';
import { REPO_ROOT } from '../../helpers/tmp.js';
import { HooksError, toStable, writeLevelOf, newProgress } from '../../../src/rsi/hooks/env.js';
import { HooksFsError } from '../../../src/io/hooks-fs.js';
import { parseHooksArgs } from '../../../src/rsi/hooks/command.js';

const DOC = await readText(path.join(REPO_ROOT, 'docs/contracts.md'));
const sec = (from: string, to: string): string => {
  const a = DOC.indexOf(from);
  const b = DOC.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`找不到 ${from} .. ${to}`);
  return DOC.slice(a, b);
};
const R28 = sec('- R20-15.28 退出码', '#### 20.15-8');
const R25 = sec('- R20-15.25 输出例外', '- R20-15.26 隐私');

describe('稳定码 ↔ R20-15.28(逐项、同序)', () => {
  it('RSI_HOOKS_NOT_RUN reason= 的封闭集合', () => {
    const m = /RSI_HOOKS_NOT_RUN reason=([a-z_|]+)/.exec(R28);
    expect(m).not.toBeNull();
    expect((m as RegExpExecArray)[1]?.split('|')).toEqual([...RSI_HOOKS_NOT_RUN_REASONS]);
    expect(new Set(RSI_HOOKS_NOT_RUN_REASONS).size).toBe(RSI_HOOKS_NOT_RUN_REASONS.length);
  });

  it('RSI_FAIL_CLOSED reason= 的 hooks 集合;lock_lost / internal 与 R20-3.0 总表共用', () => {
    const m = /RSI_FAIL_CLOSED reason=([a-z_|]+)/.exec(R28);
    expect((m as RegExpExecArray)[1]?.split('|')).toEqual([...RSI_HOOKS_FAIL_CLOSED_REASONS]);
    // 五个都已在 R20-3.0 总表的同一份枚举里(hooks_* 三个随 A5 并入,lock_lost / internal 本来就有)
    for (const r of RSI_HOOKS_FAIL_CLOSED_REASONS) {
      expect((RSI_FAIL_CLOSED_REASONS as readonly string[]).includes(r), r).toBe(true);
    }
    expect((RSI_EXIT1_CODES as readonly string[]).includes(RSI_HOOKS_DECLINED)).toBe(true);
  });

  it('RSI_HOOKS_DECLINED(退 1)与 RSI_HOOKS_WARN 出现在契约文字里;A5 订正段并入了全部新码', () => {
    expect(R28).toContain(RSI_HOOKS_DECLINED);
    expect(DOC).toContain(`${RSI_HOOKS_WARN} reason=${RSI_HOOKS_WARN_REASONS[0]}`);
    const note = sec('> **A5 订正 #1(R20-15.28', '配置类原因码只在');
    for (const c of [
      ...RSI_HOOKS_NOT_RUN_REASONS,
      ...RSI_HOOKS_FAIL_CLOSED_REASONS.filter((x) => x.startsWith('hooks_')),
    ]) {
      expect(note, c).toContain(c);
    }
    expect(note).toContain(RSI_HOOKS_DECLINED);
  });

  it('退出码映射:not_run → 4,fail_closed → 3;文件系统错误码映射到对应稳定原因', () => {
    for (const r of RSI_HOOKS_NOT_RUN_REASONS)
      expect(new HooksError('not_run', r).kind).toBe('not_run');
    expect(toStable(new HooksFsError('hooks_target_unsafe'))).toMatchObject({
      kind: 'fail_closed',
      reason: 'hooks_target_unsafe',
    });
    expect(toStable(new HooksFsError('hooks_ledger_invalid'))).toMatchObject({
      kind: 'fail_closed',
      reason: 'hooks_ledger_invalid',
    });
    expect(toStable(new HooksFsError('hooks_backup_invalid'))).toMatchObject({
      kind: 'fail_closed',
      reason: 'hooks_backup_invalid',
    });
    expect(toStable(new HooksFsError('target_changed'))).toMatchObject({
      kind: 'not_run',
      reason: 'config_changed_during_write',
    });
    expect(toStable(new HooksFsError('io'))).toMatchObject({
      kind: 'fail_closed',
      reason: 'internal',
    });
    // 未识别的异常一律 internal,且不带消息
    expect(toStable(new Error('private path /Users/x'))).toMatchObject({
      kind: 'fail_closed',
      reason: 'internal',
    });
  });
});

describe('--json 固定键集(R20-15.25)与写入承诺等级(R20-15.24a)', () => {
  it('键集合恰为契约列出的 10 个', () => {
    expect(RSI_HOOKS_JSON_KEYS).toHaveLength(10);
    for (const k of RSI_HOOKS_JSON_KEYS) expect(R25, k).toContain(k);
  });

  it('write_level:五级 + committed;writeLevelOf 按进度取值', () => {
    expect([...RSI_HOOKS_WRITE_LEVELS]).toEqual([
      'zero_write',
      'lock_only',
      'recovery_only',
      'target_unwritten',
      'target_written_pending',
      'committed',
    ]);
    const p = newProgress();
    expect(writeLevelOf(p)).toBe('zero_write');
    p.lockAttempted = true;
    expect(writeLevelOf(p)).toBe('lock_only');
    p.recoveryWrote = true;
    expect(writeLevelOf(p)).toBe('recovery_only');
    p.journalWritten = true;
    expect(writeLevelOf(p)).toBe('target_unwritten');
    p.targetCommitted = true;
    expect(writeLevelOf(p)).toBe('target_written_pending');
    p.complete = true;
    expect(writeLevelOf(p)).toBe('committed');
  });
});

describe('参数:复用既有 RSI_USAGE 原因码,六模式互斥', () => {
  it('解析出的原因码都在 R20-3.0 的 RSI_USAGE 枚举里', () => {
    for (const argv of [
      [],
      ['--install'],
      ['--install', '--agent', 'x'],
      ['--install', '--bogus'],
    ]) {
      const r = parseHooksArgs(argv);
      expect(r.ok).toBe(false);
      if (!r.ok)
        expect((RSI_USAGE_REASONS as readonly string[]).includes(r.reason), r.reason).toBe(true);
    }
    expect(RSI_HOOKS_MODES).toHaveLength(6);
    expect(Object.values(RSI_HOOKS_MODE_FLAGS)).toEqual([
      '--print',
      '--install',
      '--uninstall',
      '--restore',
      '--discard-residue',
      '--prune-backups',
    ]);
  });
});
