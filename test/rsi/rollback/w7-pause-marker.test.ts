/**
 * H3 / W0-21:熔断先写 hint / exec 实际读的持久拒绝标记 `.state/rsi/AUTO_PAUSE_BREAKER`(B;用户标记 `AUTO_PAUSE`(U)只归用户命令,worker 只读存在性),再写 state.json 与 mute。
 * 真文件实现 `makeBreakerMarkerPort` / `makeUserMarkerPort` + 真 hint 读取端口 `makePermitPort(...).pause()`(两个文件各 lstat 判存在)。
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, readText } from '../../../src/io/read-fs.js';
import * as safe from '../../../src/io/safe-fs.js';
import { makePermitPort } from '../../../src/rsi/canary/permit-read.js';
import {
  makeBreakerMarkerPort,
  makeUserMarkerPort,
  parsePauseMarker,
} from '../../../src/rsi/canary/pause-marker.js';
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
  /** B */
  file: string;
  /** U */
  userFile: string;
  user: ReturnType<typeof makeUserMarkerPort>;
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
    file: path.join(w.rsi, 'AUTO_PAUSE_BREAKER'),
    userFile: path.join(w.rsi, 'AUTO_PAUSE'),
    user: makeUserMarkerPort(io, w.rsi, () => NOW),
    hint: () => permit.pause(),
    d: {
      phase: V1B,
      marker: {
        breaker: makeBreakerMarkerPort(io, w.rsi, () => NOW),
        user: makeUserMarkerPort(io, w.rsi, () => NOW),
      },
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
  it('state.write 崩溃:hint 的许可端口读到 B=present(状态没写);标记内容 {at, by:breaker, reason}', async () => {
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

describe('标记端口:B 与 U 互不覆盖,各有唯一写者', () => {
  it('熔断写 B 不写 U;U 已存在(用户先暂停)时 ensure 仍创建 B,U 内容不变', async () => {
    const r = await rig('w7-marker-d-');
    const body = `${JSON.stringify({ at: '2026-11-09T00:00:00.000Z', by: 'user' })}\n`;
    await safe.writeFile(r.w.io, r.userFile, body, { mode: 0o600 });
    expect(await r.d.marker.breaker.ensure('gate_internal')).toBe('created');
    expect(await r.d.marker.breaker.ensure('user_vetoes')).toBe('exists'); // B 不覆盖
    expect(JSON.parse(await readText(r.file)).reason).toBe('gate_internal');
    expect(await readText(r.userFile)).toBe(body);
    expect(await r.d.marker.breaker.remove()).toBe(true);
    expect(await r.d.marker.breaker.remove()).toBe(false);
    expect(await readText(r.userFile)).toBe(body); // 删 B 不动 U
    expect(await r.hint()).toBe('present'); // U 仍让 hint 停注入
  });

  it('B 只在 B 上:熔断不创建 U 文件', async () => {
    const r = await rig('w7-marker-d2-');
    await tripAndMute(r.d, 'gate_internal');
    expect(await r.user.exists()).toBe(false);
    expect(await r.hint()).toBe('present');
  });

  it('worker 对 U 只用 exists(BreakerDeps 的类型上没有写 / 删):内容损坏 / 空的 U 仍算存在(user_paused 判据)', async () => {
    const r = await rig('w7-marker-e0-');
    expect(await r.d.marker.user.exists()).toBe(false);
    await safe.writeFile(r.w.io, r.userFile, '', { mode: 0o600 });
    expect(await r.d.marker.user.exists()).toBe(true);
    await safe.writeFile(r.w.io, r.userFile, 'not json', { mode: 0o600 });
    expect(await r.d.marker.user.exists()).toBe(true);
  });

  it('内容读不出(空文件)的 B:仍算存在,by=unknown;enforceMute 不据此补码,但仍 mute', async () => {
    const r = await rig('w7-marker-e-');
    await safe.writeFile(r.w.io, r.file, '', { mode: 0o600 });
    expect(await r.d.marker.breaker.read()).toEqual({ by: 'unknown', reason: null });
    expect(await enforceMute(r.d)).toBe(true);
    expect(r.state.value.reasons).toEqual([]);
    expect(await r.hint()).toBe('present');
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

describe('用户标记 U 的命令端口(W8 的 pause / resume 用;本块不含命令):ensureUser 独占、remove 带实例令牌', () => {
  it('ensureUser:创建 {at, by:user};已存在 = exists 不覆盖', async () => {
    const r = await rig('w7-marker-u1-');
    expect(await r.user.ensureUser()).toBe('created');
    expect(JSON.parse(await readText(r.userFile))).toEqual({
      at: NOW.toISOString(),
      by: 'user',
    });
    expect(await r.user.ensureUser()).toBe('exists');
    expect(await r.hint()).toBe('present');
  });

  it('remove(token):令牌与当前实例一致才删;令牌 none 永不删(resume 期间新建的 U 保留);实例被换 → changed 不删', async () => {
    const r = await rig('w7-marker-u2-');
    // 令牌 none:U 不存在时取的快照,之后用户新建 U'
    const none = await r.user.snapshot();
    expect(none).toBe('none');
    await r.user.ensureUser();
    expect(await r.user.remove(none)).toBe('changed');
    expect(await r.user.exists()).toBe(true);
    // 正常:快照后未变 → removed
    const tok = await r.user.snapshot();
    expect(await r.user.remove(tok)).toBe('removed');
    expect(await r.user.exists()).toBe(false);
    expect(await r.user.remove(tok)).toBe('absent');
    // 换实例:删了再建(新 inode / 大小不同)→ 旧令牌不删
    await safe.writeFile(r.w.io, r.userFile, 'x', { mode: 0o600 });
    const old = await r.user.snapshot();
    await safe.remove(r.w.io, r.userFile);
    await safe.writeFile(r.w.io, r.userFile, 'longer-content', { mode: 0o600 });
    expect(await r.user.remove(old)).toBe('changed');
    expect(await r.user.exists()).toBe(true);
  });
});

describe('解除只在没有剩余码时删 B(真文件);U 任何路径都不删', () => {
  it('自动解除:仍有码 → B 保留;清空 → 删 B', async () => {
    const r = await rig('w7-marker-f-');
    r.state.value = {
      reasons: ['no_observation', 'budget_high_legacy'],
      diverged: false,
      owner_changed: false,
    };
    await r.d.marker.breaker.ensure('no_observation');
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

  it('契约用例(W0-21):worker 熔断 → 用户暂停 → 熔断条件恢复:B 被自动解除删掉,U 仍在,hint 仍停注入', async () => {
    const r = await rig('w7-marker-g-');
    await tripAndMute(r.d, 'no_observation');
    await r.user.ensureUser();
    await applyAutoRelease(
      r.d,
      autoRelease(r.state.value, () => false),
    );
    expect(await exists(r.file)).toBe(false);
    expect(await exists(r.userFile)).toBe(true);
    expect(await r.hint()).toBe('present');
    expect(r.state.value.reasons).toEqual([]);
  });

  it('人工 resume 的 worker 侧:无剩余码时删 B、不删 U', async () => {
    const r = await rig('w7-marker-g2-');
    await tripAndMute(r.d, 'gate_internal');
    await r.user.ensureUser();
    await applyResume(
      r.d,
      resume(r.state.value, () => false),
    );
    expect(await exists(r.file)).toBe(false);
    expect(await exists(r.userFile)).toBe(true);
    expect(await r.hint()).toBe('present');
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

  it('B 已存在(可能尚未落盘,如上次崩溃时别的进程刚建):不覆盖内容,但补一次文件 fsync 与父目录 fsync,之后才写 state', async () => {
    const ops: string[] = [];
    const r = await rig('w7-marker-dur-b-', ops);
    const body = `${JSON.stringify({ at: '2026-11-09T00:00:00.000Z', by: 'breaker', reason: 'gate_internal' })}\n`;
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
    expect(await r.d.marker.breaker.ensure('gate_internal')).toBe('exists');
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
