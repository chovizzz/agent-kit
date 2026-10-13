import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LlmBackend } from '../../../src/reflect/backend-iface.js';
import {
  cooldownDir,
  dayKey,
  isCoolingDown,
  markCooldown,
  normalizeResetTz,
} from '../../../src/reflect/backends/cooldown.js';
import { exists, lstat, readDir } from '../../../src/io/read-fs.js';
import { mkdirp, symlink, writeFile } from '../../../src/io/safe-fs.js';
import { REQ, fixture } from './_fixture.js';

const bySlot = (list: readonly LlmBackend[], slot: string): LlmBackend => {
  const b = list.find((x) => x.slot === slot);
  if (b === undefined) throw new Error(`no slot ${slot}`);
  return b;
};
const lines = (s: string | undefined) => (s ?? '').split('\n').slice(0, -1);
const BIND_A = { slot: 'codex', cli: 'claude', model: 'claude-test-1' } as const;
const BIND_B = { slot: 'maas-deepseek', cli: 'codex', model: 'gpt-test-1' } as const;

describe('R3 冷却:日期与时区边界', () => {
  it('dayKey:UTC 跨日瞬间', () => {
    expect(dayKey(new Date('2026-10-12T23:59:59.999Z'), 'UTC')).toBe('20261012');
    expect(dayKey(new Date('2026-10-13T00:00:00.000Z'), 'UTC')).toBe('20261013');
  });

  it('dayKey:Asia/Shanghai 的 0 点 = UTC 16:00(与 UTC 的日期不同,证明时区真的参与了计算)', () => {
    const before = new Date('2026-10-12T15:59:59Z');
    const at = new Date('2026-10-12T16:00:00Z');
    expect(dayKey(before, 'Asia/Shanghai')).toBe('20261012');
    expect(dayKey(at, 'Asia/Shanghai')).toBe('20261013');
    expect(dayKey(at, 'UTC')).toBe('20261012');
  });

  it('dayKey:美东夏令时/冬令时换算与闰日', () => {
    expect(dayKey(new Date('2026-10-12T03:59:59Z'), 'America/New_York')).toBe('20261011');
    expect(dayKey(new Date('2026-10-12T04:00:00Z'), 'America/New_York')).toBe('20261012');
    expect(dayKey(new Date('2028-02-29T12:00:00Z'), 'UTC')).toBe('20280229');
  });

  it('normalizeResetTz:非法时区回落 UTC 并恰好记一条 warning;合法/缺省不记', () => {
    const warns: string[] = [];
    expect(normalizeResetTz('Mars/Olympus', (m) => warns.push(m))).toBe('UTC');
    expect(warns.length).toBe(1);
    expect(normalizeResetTz('', (m) => warns.push(m))).toBe('UTC');
    expect(warns.length).toBe(2);
    expect(normalizeResetTz('Asia/Shanghai', (m) => warns.push(m))).toBe('Asia/Shanghai');
    expect(normalizeResetTz(undefined, (m) => warns.push(m))).toBe('UTC');
    expect(warns.length).toBe(2);
  });
});

describe('R3 冷却:标记读写与清理', () => {
  it('markCooldown 写今天的标记(目录 0700、文件 0600);isCoolingDown 只对该槽位为真', async () => {
    const f = await fixture('cd-mark-');
    const cd = { ctx: f.ctx, resetTz: 'UTC' };
    const now = new Date('2026-10-12T10:00:00Z');
    expect(await isCoolingDown(cd, 'codex', now)).toBe(false);
    expect(await markCooldown(cd, 'codex', now)).toBe(true);
    const file = path.join(cooldownDir(f.ctx), 'codex-20261012');
    expect(await exists(file)).toBe(true);
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect((await lstat(cooldownDir(f.ctx))).mode & 0o777).toBe(0o700);
    expect(await isCoolingDown(cd, 'codex', now)).toBe(true);
    expect(await isCoolingDown(cd, 'glm', now)).toBe(false);
  });

  it('读取时删除早于今天的标记;晚于今天的/杂文件/符号链接不删也不算冷却', async () => {
    const f = await fixture('cd-clean-');
    const dir = cooldownDir(f.ctx);
    await mkdirp(f.ctx, dir, 0o700);
    const put = (n: string) => writeFile(f.ctx, path.join(dir, n), '1\n', { mode: 0o600 });
    await put('codex-20261010');
    await put('glm-20261012');
    await put('kimi-20261099');
    await put('notes.txt');
    await put('evil-20261001'); // 不是枚举槽位
    await symlink(f.ctx, dir, path.join(dir, 'maas-deepseek-20261012'));
    const cd = { ctx: f.ctx, resetTz: 'UTC' };
    const now = new Date('2026-10-12T10:00:00Z');
    expect(await isCoolingDown(cd, 'glm', now)).toBe(true);
    const names = (await readDir(dir)).map((e) => e.name);
    expect(names).not.toContain('codex-20261010');
    expect(names).toEqual(
      expect.arrayContaining([
        'glm-20261012',
        'kimi-20261099',
        'notes.txt',
        'evil-20261001',
        'maas-deepseek-20261012',
      ]),
    );
    expect(await isCoolingDown(cd, 'kimi', now)).toBe(false); // 未来日期不算
    expect(await isCoolingDown(cd, 'maas-deepseek', now)).toBe(false); // 符号链接不算
  });

  it('槽位不在固定枚举(含路径穿越)→ 不读不写,目录外无任何文件', async () => {
    const f = await fixture('cd-slot-');
    const cd = { ctx: f.ctx, resetTz: 'UTC' };
    const now = new Date('2026-10-12T10:00:00Z');
    for (const bad of ['../x', 'codex/../../x', 'unknown', '']) {
      expect(await markCooldown(cd, bad, now), bad).toBe(false);
      expect(await isCoolingDown(cd, bad, now), bad).toBe(false);
    }
    expect(await exists(cooldownDir(f.ctx))).toBe(false);
    // 目录外(state 目录与其上级)也没有被写出任何东西
    expect(await exists(f.ctx.stateDir)).toBe(false);
    expect(await exists(path.join(f.ctx.stateDir, '..', 'x-20261012'))).toBe(false);
  });

  it('llm-cooldown 本身是符号链接 → 不读不写不删(不会跟进链接去删别处的文件)', async () => {
    const f = await fixture('cd-linkdir-');
    const elsewhere = path.join(f.ctx.stateDir, 'elsewhere');
    await mkdirp(f.ctx, elsewhere, 0o700);
    const victim = path.join(elsewhere, 'codex-20261001');
    await writeFile(f.ctx, victim, '1\n', { mode: 0o600 });
    const today = path.join(elsewhere, 'glm-20261012');
    await writeFile(f.ctx, today, '1\n', { mode: 0o600 });
    await symlink(f.ctx, elsewhere, cooldownDir(f.ctx));
    expect((await lstat(cooldownDir(f.ctx))).isSymbolicLink()).toBe(true); // 正向控制
    const cd = { ctx: f.ctx, resetTz: 'UTC' };
    const now = new Date('2026-10-12T10:00:00Z');
    expect(await isCoolingDown(cd, 'glm', now)).toBe(false);
    expect(await markCooldown(cd, 'kimi', now)).toBe(false);
    expect(await exists(victim)).toBe(true);
    expect(await exists(path.join(elsewhere, 'kimi-20261012'))).toBe(false);
  });
});

describe('R3 限流经后端:判定、写标记、下一次不 spawn', () => {
  it('429 → rate_limited 并写标记;同日下一次直接 rate_limited(cooldown)且不 spawn', async () => {
    const f = await fixture('rl-basic-');
    const counter = f.rec('count.txt');
    await f.install(
      'claude',
      `cat >/dev/null; echo x >> '${counter}'; echo 'HTTP 429 Too Many' >&2; exit 1`,
    );
    const be = bySlot(f.build({ backends: [BIND_A] }), 'codex');
    expect(await be.complete(REQ)).toEqual({
      ok: false,
      reason: 'rate_limited',
      detail: 'rate_limit_marked',
    });
    expect(await exists(path.join(cooldownDir(f.ctx), 'codex-20261012'))).toBe(true);
    expect(await be.complete(REQ)).toEqual({
      ok: false,
      reason: 'rate_limited',
      detail: 'cooldown',
    });
    expect(lines(await f.read(counter)).length).toBe(1);
    // 其他槽位不受影响
    await f.install('codex', `cat >/dev/null; printf x`);
    const other = bySlot(f.build({ backends: [BIND_A, BIND_B] }), 'maas-deepseek');
    expect((await other.complete(REQ)).ok).toBe(true);
  });

  it('文案判定:rate limit 大小写不敏感(stdout 也认);429 与 rate limit 之外不算', async () => {
    const f = await fixture('rl-text-');
    for (const [stream, text, limited] of [
      ['stdout', 'Error: RATE LIMIT exceeded', true],
      ['stderr', 'You hit the Rate_Limit', true],
      ['stderr', 'status code: 429', true],
      ['stderr', 'quota exhausted, try later', false],
      ['stderr', 'error id 14290 failed', false],
    ] as const) {
      const g = await fixture('rl-text-each-');
      const redirect = stream === 'stderr' ? ' >&2' : '';
      await g.install('claude', `cat >/dev/null; echo '${text}'${redirect}; exit 1`);
      const be = bySlot(g.build({ backends: [BIND_A] }), 'codex');
      const r = await be.complete(REQ);
      expect(r.ok === false && r.reason === 'rate_limited', text).toBe(limited);
      expect(await exists(path.join(cooldownDir(g.ctx), 'codex-20261012')), text).toBe(limited);
    }
    expect(f.budget.used).toBe(0);
  });

  it('退出码 0 时,模型文本里出现 429 / rate limit 不算限流(防文本诱导写冷却)', async () => {
    const f = await fixture('rl-exit0-');
    await f.install('claude', `cat >/dev/null; printf '%s' 'the 429 rate limit page says'`);
    const be = bySlot(f.build({ backends: [BIND_A] }), 'codex');
    const r = await be.complete(REQ);
    expect(r.ok).toBe(true);
    expect(await exists(path.join(cooldownDir(f.ctx), 'codex-20261012'))).toBe(false);
  });

  it('被信号杀掉(无退出码)时,即使输出里有 429 / rate limit 也不写冷却,报 signal_*', async () => {
    const f = await fixture('rl-signal-');
    await f.install('claude', `cat >/dev/null; echo 'HTTP 429 rate limit'; kill -9 $$`);
    const be = bySlot(f.build({ backends: [BIND_A] }), 'codex');
    expect(await be.complete(REQ)).toEqual({
      ok: false,
      reason: 'error',
      detail: 'signal_SIGKILL',
    });
    expect(await exists(path.join(cooldownDir(f.ctx), 'codex-20261012'))).toBe(false);
  });

  it('冷却过期:跨过重置点后重新 spawn,并清掉旧标记', async () => {
    const f = await fixture('rl-expire-');
    const counter = f.rec('count.txt');
    await f.install(
      'claude',
      `cat >/dev/null; echo x >> '${counter}'; if [ "$(wc -l < '${counter}')" -le 1 ]; then echo 429 >&2; exit 1; fi; printf ok`,
    );
    const be = bySlot(f.build({ backends: [BIND_A] }), 'codex');
    expect((await be.complete(REQ)).ok).toBe(false);
    f.clock.set(new Date('2026-10-12T23:59:59Z'));
    expect(await be.complete(REQ)).toMatchObject({ detail: 'cooldown' });
    f.clock.set(new Date('2026-10-13T00:00:00Z'));
    expect(await be.complete(REQ)).toEqual({ ok: true, text: 'ok' });
    expect(lines(await f.read(counter)).length).toBe(2);
    expect((await readDir(cooldownDir(f.ctx))).map((e) => e.name)).not.toContain('codex-20261012');
  });

  it('reset_tz=Asia/Shanghai:北京 0 点(UTC 16:00)解除;同一时刻 UTC 配置仍在冷却', async () => {
    const script = (counter: string) =>
      `cat >/dev/null; echo x >> '${counter}'; if [ "$(wc -l < '${counter}')" -le 1 ]; then echo 429 >&2; exit 1; fi; printf ok`;
    // Shanghai
    const sh = await fixture('rl-tz-sh-');
    const c1 = sh.rec('count.txt');
    await sh.install('claude', script(c1));
    sh.clock.set(new Date('2026-10-12T15:59:00Z'));
    const beSh = bySlot(sh.build({ backends: [BIND_A], reset_tz: 'Asia/Shanghai' }), 'codex');
    expect((await beSh.complete(REQ)).ok).toBe(false);
    sh.clock.set(new Date('2026-10-12T15:59:59Z'));
    expect(await beSh.complete(REQ)).toMatchObject({ detail: 'cooldown' });
    sh.clock.set(new Date('2026-10-12T16:00:00Z'));
    expect((await beSh.complete(REQ)).ok).toBe(true);
    // UTC:同样的时刻仍在冷却
    const utc = await fixture('rl-tz-utc-');
    const c2 = utc.rec('count.txt');
    await utc.install('claude', script(c2));
    utc.clock.set(new Date('2026-10-12T15:59:00Z'));
    const beUtc = bySlot(utc.build({ backends: [BIND_A] }), 'codex');
    expect((await beUtc.complete(REQ)).ok).toBe(false);
    utc.clock.set(new Date('2026-10-12T16:00:00Z'));
    expect(await beUtc.complete(REQ)).toMatchObject({ detail: 'cooldown' });
  });

  it('非法 reset_tz:回落 UTC,工厂记一条 warning', async () => {
    const f = await fixture('rl-badtz-');
    const warns: string[] = [];
    await f.install('claude', `cat >/dev/null; echo 429 >&2; exit 1`);
    f.clock.set(new Date('2026-10-12T20:00:00Z'));
    const be = bySlot(
      f.build({ backends: [BIND_A], reset_tz: 'Not/AZone' }, { warn: (m) => warns.push(m) }),
      'codex',
    );
    expect(warns.length).toBe(1);
    await be.complete(REQ);
    expect(await exists(path.join(cooldownDir(f.ctx), 'codex-20261012'))).toBe(true);
  });

  it('标记写不进去(路径被占)→ 仍报 rate_limited,detail 说明', async () => {
    const f = await fixture('rl-nowrite-');
    await f.install('claude', `cat >/dev/null; echo 429 >&2; exit 1`);
    await mkdirp(f.ctx, f.ctx.stateDir, 0o700);
    await writeFile(f.ctx, cooldownDir(f.ctx), 'i am a file', { mode: 0o600 });
    const be = bySlot(f.build({ backends: [BIND_A] }), 'codex');
    expect(await be.complete(REQ)).toEqual({
      ok: false,
      reason: 'rate_limited',
      detail: 'cooldown_write_failed',
    });
  });

  it('不读用户私人的限流标记(例如 ~/.claude/hooks/.codex-limited-*):源码里没有这类路径', async () => {
    // 文本断言放在 leak 测试里统一扫;这里只验证行为:假 HOME 里放同名标记,不影响调用
    const f = await fixture('rl-private-');
    const hooks = path.join(f.fakeHome, '.claude', 'hooks');
    await mkdirp(f.ctx, hooks);
    await writeFile(f.ctx, path.join(hooks, '.codex-limited-20261012'), '');
    await f.install('claude', `cat >/dev/null; printf ok`);
    const be = bySlot(f.build({ backends: [BIND_A] }), 'codex');
    expect((await be.complete(REQ)).ok).toBe(true);
  });
});
