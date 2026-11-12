/**
 * H3:熔断先写 hint / exec 实际读的持久拒绝标记 `.state/rsi/AUTO_PAUSE`(R21-6.10 / 6.11 第 4 行、R21-12.2),再写 state.json 与 mute。
 * 真文件实现 `makePauseMarkerPort` + 真 hint 读取端口 `makePermitPort(...).pause()`(只 lstat 判存在)。
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readText } from '../../../src/io/read-fs.js';
import * as safe from '../../../src/io/safe-fs.js';
import { makePermitPort } from '../../../src/rsi/canary/permit-read.js';
import { makePauseMarkerPort, parsePauseMarker } from '../../../src/rsi/canary/pause-marker.js';
import {
  NO_PAUSE,
  applyAutoRelease,
  applyResume,
  autoRelease,
  enforceMute,
  resume,
  tripAndMute,
  type AutoPauseState,
  type BreakerDeps,
} from '../../../src/rsi/personal/breaker.js';
import { makeCanaryWorld } from '../canary/w5-fixture.js';
import { NOW, V1B } from './w7-fixture.js';

async function rig(
  prefix: string,
  ops?: string[],
): Promise<{
  d: BreakerDeps;
  file: string;
  hint: () => Promise<'present' | 'absent' | 'unreadable'>;
  state: { value: AutoPauseState };
  failWrite: { value: boolean };
  w: Awaited<ReturnType<typeof makeCanaryWorld>>;
}> {
  const w = await makeCanaryWorld(prefix);
  const state = { value: NO_PAUSE as AutoPauseState };
  const failWrite = { value: false };
  const permit = makePermitPort(w.rsi, w.home);
  // 可注入的 fs 钩子:safe-fs 的写出口在动手前调 `writeAudit(op, path)`,把它和 state.write 记进同一个数组 = 顺序证据
  const io = ops === undefined ? w.io : { ...w.io, writeAudit: (op: string) => void ops.push(op) };
  return {
    w,
    state,
    failWrite,
    file: path.join(w.rsi, 'AUTO_PAUSE'),
    hint: () => permit.pause(),
    d: {
      phase: V1B,
      marker: makePauseMarkerPort(io, w.rsi, () => NOW),
      state: {
        read: async () => state.value,
        write: async (s) => {
          if (failWrite.value) throw new Error('crash');
          ops?.push('state.write');
          state.value = s;
        },
      },
      canary: { mute: async () => true },
    },
  };
}

describe('H3 标记先于状态:崩溃窗口里 hint 也看得到', () => {
  it('state.write 崩溃:hint 的许可端口读到 AUTO_PAUSE=present(状态没写);标记内容 {at, by:breaker, reason}', async () => {
    const r = await rig('w7-marker-a-');
    expect(await r.hint()).toBe('absent');
    r.failWrite.value = true;
    await expect(tripAndMute(r.d, 'gate_internal')).rejects.toThrow('crash');
    expect(r.state.value.reasons).toEqual([]); // 状态没写
    expect(await r.hint()).toBe('present'); // hint 不注入
    expect(JSON.parse(await readText(r.file))).toEqual({
      at: NOW.toISOString(),
      by: 'breaker',
      reason: 'gate_internal',
    });
  });

  it('崩溃后下一次 enforceMute:由标记补码、标记保留', async () => {
    const r = await rig('w7-marker-b-');
    r.failWrite.value = true;
    await expect(tripAndMute(r.d, 'gate_internal')).rejects.toThrow('crash');
    r.failWrite.value = false;
    expect(await enforceMute(r.d)).toBe(true);
    expect(r.state.value.reasons).toEqual(['gate_internal']);
    expect(await r.hint()).toBe('present');
  });

  it('有码缺标记:enforceMute 补标记(独占创建)', async () => {
    const r = await rig('w7-marker-c-');
    r.state.value = { reasons: ['no_observation'], diverged: false, owner_changed: false };
    expect(await r.hint()).toBe('absent');
    await enforceMute(r.d);
    expect(await r.hint()).toBe('present');
    expect(parsePauseMarker(await readText(r.file))).toEqual({
      by: 'breaker',
      reason: 'no_observation',
    });
  });
});

describe('标记端口:不覆盖用户标记;own / any 删除范围', () => {
  it('ensure 遇到用户写的标记 → exists,内容不变;read 为 user', async () => {
    const r = await rig('w7-marker-d-');
    const body = `${JSON.stringify({ at: '2026-11-09T00:00:00.000Z', by: 'user' })}\n`;
    await safe.writeFile(r.w.io, r.file, body, { mode: 0o600 });
    expect(await r.d.marker.ensure('gate_internal')).toBe('exists');
    expect(await readText(r.file)).toBe(body);
    expect(await r.d.marker.read()).toEqual({ by: 'user', reason: null });
    expect(await r.d.marker.remove('own')).toBe(false);
    expect(await r.hint()).toBe('present');
    expect(await r.d.marker.remove('any')).toBe(true);
    expect(await r.hint()).toBe('absent');
    expect(await r.d.marker.remove('any')).toBe(false);
  });

  it('内容读不出(空文件):仍算存在,by=unknown;own 不删;enforceMute 不据此补码,但仍 mute', async () => {
    const r = await rig('w7-marker-e-');
    await safe.writeFile(r.w.io, r.file, '', { mode: 0o600 });
    expect(await r.d.marker.read()).toEqual({ by: 'unknown', reason: null });
    expect(await r.d.marker.remove('own')).toBe(false);
    expect(await enforceMute(r.d)).toBe(true);
    expect(r.state.value.reasons).toEqual([]);
  });

  it('parsePauseMarker:各形态', () => {
    expect(parsePauseMarker('{"by":"user"}')).toEqual({ by: 'user', reason: null });
    expect(parsePauseMarker('{"by":"breaker","reason":"user_vetoes"}')).toEqual({
      by: 'breaker',
      reason: 'user_vetoes',
    });
    expect(parsePauseMarker('{"by":"breaker","reason":"nope"}')).toEqual({
      by: 'unknown',
      reason: null,
    });
    expect(parsePauseMarker('not json')).toEqual({ by: 'unknown', reason: null });
  });
});

describe('解除只在没有剩余码时删标记(真文件)', () => {
  it('自动解除:仍有码 → 标记保留;清空 → 删 worker 写的标记', async () => {
    const r = await rig('w7-marker-f-');
    r.state.value = {
      reasons: ['no_observation', 'budget_high_legacy'],
      diverged: false,
      owner_changed: false,
    };
    await r.d.marker.ensure('no_observation');
    await applyAutoRelease(
      r.d,
      autoRelease(r.state.value, (c) => c === 'budget_high_legacy'),
    );
    expect(await r.hint()).toBe('present');
    await applyAutoRelease(
      r.d,
      autoRelease(r.state.value, () => false),
    );
    expect(await r.hint()).toBe('absent');
  });

  it('自动解除不删用户标记;人工 resume 在无剩余码时删(含用户标记)', async () => {
    const r = await rig('w7-marker-g-');
    r.state.value = { reasons: ['no_observation'], diverged: false, owner_changed: false };
    await safe.writeFile(r.w.io, r.file, '{"by":"user"}\n', { mode: 0o600 });
    await applyAutoRelease(
      r.d,
      autoRelease(r.state.value, () => false),
    );
    expect(await r.hint()).toBe('present');
    r.state.value = { reasons: ['user_paused'], diverged: false, owner_changed: false };
    await applyResume(
      r.d,
      resume(r.state.value, () => false),
    );
    expect(await r.hint()).toBe('absent');
  });
});

describe('H3 持久化(R21-12.2):标记文件与父目录 fsync 之后才写 state', () => {
  const MARKER_OPS = ['syncFile', 'fsyncDir', 'state.write'];
  const pick = (ops: string[]): string[] => ops.filter((o) => MARKER_OPS.includes(o));

  it('新建标记:文件 fsync → 父目录 fsync → state.write(顺序)', async () => {
    const ops: string[] = [];
    const r = await rig('w7-marker-dur-a-', ops);
    await tripAndMute(r.d, 'gate_internal');
    expect(pick(ops)).toEqual(['syncFile', 'fsyncDir', 'state.write']);
    expect(await r.hint()).toBe('present');
  });

  it('标记已存在(可能尚未落盘,如上次崩溃时别的进程刚建):不覆盖内容,但补一次文件 fsync 与父目录 fsync,之后才写 state', async () => {
    const ops: string[] = [];
    const r = await rig('w7-marker-dur-b-', ops);
    const body = `${JSON.stringify({ at: '2026-11-09T00:00:00.000Z', by: 'user' })}\n`;
    await safe.writeFile(r.w.io, r.file, body, { mode: 0o600 });
    await tripAndMute(r.d, 'gate_internal');
    expect(pick(ops)).toEqual(['syncFile', 'fsyncDir', 'state.write']);
    expect(await readText(r.file)).toBe(body);
  });

  it('enforceMute 补标记(有码缺标记)也走同一条持久路径', async () => {
    const ops: string[] = [];
    const r = await rig('w7-marker-dur-c-', ops);
    r.state.value = { reasons: ['no_observation'], diverged: false, owner_changed: false };
    await enforceMute(r.d);
    expect(pick(ops)).toEqual(['syncFile', 'fsyncDir']);
  });

  it('已存在的标记不是单链接普通文件(硬链接)→ 拒绝、不写 state(fail-closed)', async () => {
    const r = await rig('w7-marker-dur-d-');
    const other = path.join(r.w.rsi, 'other-file');
    await safe.writeFile(r.w.io, other, 'x', { mode: 0o600 });
    await safe.hardlink(r.w.io, other, r.file);
    await expect(tripAndMute(r.d, 'gate_internal')).rejects.toThrow();
    expect(r.state.value.reasons).toEqual([]);
  });

  it('创建后写入失败:抛错(调用方不写 state)且**不删除**刚创建的标记(无锁并发下别的 ensure 可能已对它返回 exists)', async () => {
    const r = await rig('w7-marker-dur-e-');
    await expect(
      safe.createExclusiveDurable(r.w.io, r.file, {} as unknown as string, 0o600),
    ).rejects.toThrow();
    expect(await r.hint()).toBe('present'); // 内容不全的标记留着:方向安全(hint 只判存在)
    expect(await r.d.marker.ensure('gate_internal')).toBe('exists');
  });

  it(
    '已存在的标记是没有写端的 FIFO:在有界时间内拒绝(不阻塞在只读打开上),不写 state',
    { timeout: 10_000 },
    async () => {
      const r = await rig('w7-marker-dur-f-');
      execFileSync('mkfifo', [r.file]);
      await expect(tripAndMute(r.d, 'gate_internal')).rejects.toThrow();
      expect(r.state.value.reasons).toEqual([]);
    },
  );
});
