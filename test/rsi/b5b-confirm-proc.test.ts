/**
 * R20-A2 B5b:confirm 拒绝路径的零写入 · 第三层(真子进程 + `KIT_WRITE_ROOTS=:`,写入根集合为空,safe-fs 一律拒写)。
 * 只适用于**锁前**的拒绝(非 TTY、DECLINED、EOF、锁前 STALE、前置拒绝);锁后的拒绝一定要建锁,在这一层会因 write_denied 退 3,
 * 它们的零写入由 b5b-confirm.test.ts 的精确写审计证明(只有锁文件的 createExclusive + remove)。
 * 对照:同一子进程模式下 `yes` 退 3 write_denied(证明这层确实会拦住写),默认写入根下成功。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTickFx } from './b5a-fixture.js';
import { writeFile } from '../../src/io/safe-fs.js';
import { setExtra } from './ro-fixture.js';
import { treeOf, rsiToml } from './rsi-fixture.js';
import { buildConfirmChild, runConfirmChild } from './proc/confirm-helper.js';

describe('confirm · 子进程:KIT_TMP + 空写入根(KIT_WRITE_ROOTS=:)', () => {
  it('锁前拒绝:退出码 / 输出符合预期且没有 write_denied,目录树不变;对照:yes 在空写入根下退 3 write_denied,默认写入根下成功', async () => {
    const f = await makeTickFx('cfp-', { projects: 2 });
    const script = await buildConfirmChild(f.tmp);
    const base = { ...f.env, PATH: '/usr/bin:/bin' };
    const denied = { ...base, KIT_WRITE_ROOTS: ':' };
    const job = (over: Partial<Parameters<typeof runConfirmChild>[1]> = {}) => ({
      argv: ['rsi', 'confirm'],
      env: denied,
      cwd: f.dir,
      tty: true,
      lines: ['yes'] as (string | null)[],
      ...over,
    });
    const before = await treeOf(f.dir);

    const notTty = runConfirmChild(script, job({ tty: false }));
    expect([notTty.code, notTty.err, notTty.out]).toEqual([2, 'RSI_USAGE reason=not_tty\n', '']);
    const declined = runConfirmChild(script, job({ lines: ['no'] }));
    expect([declined.code, declined.err]).toEqual([1, 'RSI_CONFIRM_DECLINED\n']);
    expect(declined.out).toContain('status=pending'); // 清单确实展示了(正向前提)
    const eof = runConfirmChild(script, job({ lines: [null] }));
    expect([eof.code, eof.err]).toEqual([1, 'RSI_CONFIRM_DECLINED\n']);
    expect(await treeOf(f.dir)).toEqual(before);

    // 锁前 STALE:等待输入期间改配置(改配置用独立的宽写入根上下文;对 confirm 自己仍是空写入根)
    const cfg = path.join(f.home, '.config', 'agent-kit', 'config.toml');
    const stale = runConfirmChild(
      script,
      job({ onPrompt: { dir: f.dir, file: cfg, content: rsiToml(f, 'agents = ["claude"]\n') } }),
    );
    expect([stale.code, stale.err]).toEqual([1, 'RSI_CONFIRM_STALE\n']);
    for (const r of [notTty, declined, eof, stale]) expect(r.err).not.toContain('write_denied');
    const after = await treeOf(f.dir);
    // 除了被测试自己改掉的配置文件,其余逐项不变
    const strip = (t: string[]): string[] =>
      t.filter((l) => !l.startsWith('home/.config/agent-kit/config.toml'));
    expect(strip(after)).toEqual(strip(before));
    expect(after.some((l) => l.includes('rsi/lock'))).toBe(false);

    // 对照:恢复配置,yes 在空写入根下要拿锁 → 3 write_denied;默认写入根下成功
    const restore = runConfirmChild(
      script,
      job({
        lines: ['no'],
        onPrompt: { dir: f.dir, file: cfg, content: rsiToml(f, '') },
      }),
    );
    expect(restore.code).toBe(1);
    const yesDenied = runConfirmChild(script, job());
    expect([yesDenied.code, yesDenied.err]).toEqual([3, 'RSI_FAIL_CLOSED reason=write_denied\n']);
    const yesOk = runConfirmChild(script, job({ env: base }));
    expect([yesOk.code, yesOk.err]).toEqual([0, '']);
    expect(yesOk.out.endsWith('confirm ok\n')).toBe(true);
  }, 120_000);

  it('前置拒绝也在子进程空写入根下零写入:STOP 过大 / 硬链接式的无法确认身份 → 3 state_dir_unsafe;停止采集 → 3 exclude_invalid', async () => {
    const f = await makeTickFx('cfp2-', { projects: 1 });
    const script = await buildConfirmChild(f.tmp);
    const denied = { ...f.env, PATH: '/usr/bin:/bin', KIT_WRITE_ROOTS: ':' };
    const job = {
      argv: ['rsi', 'confirm'],
      env: denied,
      cwd: f.dir,
      tty: true,
      lines: ['yes'] as (string | null)[],
    };
    await writeFile(f.io, path.join(f.rsiDir, 'STOP'), 'x'.repeat(5000), { mode: 0o600 });
    let before = await treeOf(f.dir);
    const big = runConfirmChild(script, job);
    expect([big.code, big.err, big.out]).toEqual([
      3,
      'RSI_FAIL_CLOSED reason=state_dir_unsafe\n',
      '',
    ]);
    expect(await treeOf(f.dir)).toEqual(before);
    await setExtra(f, 'exclude_dirs = ["relative"]\n');
    before = await treeOf(f.dir);
    const blocked = runConfirmChild(script, job);
    expect([blocked.code, blocked.err, blocked.out]).toEqual([
      3,
      'RSI_FAIL_CLOSED reason=exclude_invalid\n',
      '',
    ]);
    expect(await treeOf(f.dir)).toEqual(before);
  }, 120_000);
});
