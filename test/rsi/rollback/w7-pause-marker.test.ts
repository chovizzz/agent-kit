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
  stampReleaseEvidence,
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
      id: expect.stringMatching(/^[0-9a-f]{16}$/), // W0-23:实例标识
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
      at: expect.any(String), // W0-23:at 只作展示 / 审计
      id: expect.stringMatching(/^[0-9a-f]{16}$/), // W0-23:id 才是解除证据的比较对象
    });
  });
});

describe('W0-23 解除证据(真文件):清码写盘后残留的 B 不复活码,被 enforceMute 删掉;U 不动', () => {
  it('熔断 → 状态带证据地清空(B 留下)→ enforceMute:B 被删、不补码;U 内容不变', async () => {
    const r = await rig('w7-marker-ev-');
    const body = `${JSON.stringify({ at: '2026-11-09T00:00:00.000Z', by: 'user' })}\n`;
    await safe.writeFile(r.w.io, r.userFile, body, { mode: 0o600 });
    await tripAndMute(r.d, 'gate_internal');
    const res = resume(r.state.value, () => false);
    // W8 形状:只清状态(带证据),B 留给 worker
    r.state.value = await stampReleaseEvidence(r.d.marker.breaker, res.state);
    expect(r.state.value.released_marker_id).toBe(JSON.parse(await readText(r.file)).id);
    expect(await enforceMute(r.d)).toBe(true); // U 仍在 → mute
    expect(await exists(r.file)).toBe(false);
    expect(r.state.value.reasons).toEqual([]);
    expect(await readText(r.userFile)).toBe(body);
  });
});

describe('W0-23 B 的实例标识(真文件):内容 {at, by, reason, id};每次创建换新 id(固定时钟下 at 相同也不同)', () => {
  it('注入 newId:id 写进文件内容;删后重建换新 id,而 at(固定时钟)完全相同——at 不是身份', async () => {
    const w = await makeCanaryWorld('w7-marker-id-');
    const ids = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'];
    let i = 0;
    const port = makeBreakerMarkerPort(
      w.io,
      w.rsi,
      () => NOW,
      () => ids[i++] as string,
    );
    const file = path.join(w.rsi, 'AUTO_PAUSE_BREAKER');
    expect(await port.ensure('gate_internal')).toBe('created');
    const first = JSON.parse(await readText(file));
    expect(first).toEqual({
      at: NOW.toISOString(),
      by: 'breaker',
      id: 'aaaaaaaaaaaaaaaa',
      reason: 'gate_internal',
    });
    expect(await port.ensure('gate_internal')).toBe('exists'); // 已存在不覆盖、不消耗 id
    expect(i).toBe(1);
    expect(await port.remove()).toBe(true);
    expect(await port.ensure('gate_internal')).toBe('created');
    const second = JSON.parse(await readText(file));
    expect(second.at).toBe(first.at); // 固定时钟:at 相同
    expect(second.id).toBe('bbbbbbbbbbbbbbbb');
    expect(second.id).not.toBe(first.id);
    expect((await port.read())?.id).toBe('bbbbbbbbbbbbbbbb');
  });

  it('缺省随机源:连续新建两个 B(固定时钟)的 id 都合规且互不相同', async () => {
    const w = await makeCanaryWorld('w7-marker-id2-');
    const port = makeBreakerMarkerPort(w.io, w.rsi, () => NOW);
    await port.ensure('gate_internal');
    const a = (await port.read())?.id;
    await port.remove();
    await port.ensure('gate_internal');
    const b = (await port.read())?.id;
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(b).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });

  it('评审反例(真文件、固定时钟):旧 B 已解除删除、状态留旧证据;新 B 与旧 B 的 at 相同、id 不同;状态写入前崩溃 → 重启补码、B 保留', async () => {
    const w = await makeCanaryWorld('w7-marker-id3-');
    const ids = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'];
    let i = 0;
    const breaker = makeBreakerMarkerPort(
      w.io,
      w.rsi,
      () => NOW,
      () => ids[i++] as string,
    );
    const file = path.join(w.rsi, 'AUTO_PAUSE_BREAKER');
    let state: AutoPauseState = NO_PAUSE;
    let failWrite = false;
    const d: BreakerDeps = {
      phase: V1B,
      marker: { breaker, user: makeUserMarkerPort(w.io, w.rsi, () => NOW) },
      state: {
        read: async () => state,
        write: async (s) => {
          if (failWrite) throw new Error('crash');
          state = s;
        },
      },
      canary: { mute: async () => true },
    };
    await tripAndMute(d, 'gate_internal'); // 旧 B(id a)
    await applyResume(
      d,
      resume(state, () => false),
    ); // 解除:状态记 id a、删 B
    expect(state.released_marker_id).toBe('aaaaaaaaaaaaaaaa');
    expect(await exists(file)).toBe(false);
    failWrite = true;
    await expect(tripAndMute(d, 'gate_internal')).rejects.toThrow('crash'); // 新 B(id b,at 相同)落盘后状态写入前崩溃
    failWrite = false;
    expect(JSON.parse(await readText(file)).at).toBe(NOW.toISOString());
    expect(await enforceMute(d)).toBe(true);
    expect(state.reasons).toEqual(['gate_internal']); // 补码
    expect(await exists(file)).toBe(true); // B 保留
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
    expect(await r.d.marker.breaker.read()).toEqual({
      by: 'unknown',
      reason: null,
      at: null,
      id: null,
    });
    expect(await enforceMute(r.d)).toBe(true);
    expect(r.state.value.reasons).toEqual([]);
    expect(await r.hint()).toBe('present');
  });

  it('parsePauseMarker:各形态', () => {
    expect(parsePauseMarker('{"by":"user"}')).toEqual({
      by: 'user',
      reason: null,
      at: null,
      id: null,
    });
    expect(parsePauseMarker('{"by":"breaker","reason":"user_vetoes"}')).toEqual({
      by: 'breaker',
      reason: 'user_vetoes',
      at: null,
      id: null, // 没有 id(旧格式 B):永远不会被当成残留删除
    });
    expect(
      parsePauseMarker('{"at":"2026-11-12T01:02:03.000Z","by":"breaker","reason":"user_vetoes"}'),
    ).toEqual({
      by: 'breaker',
      reason: 'user_vetoes',
      at: '2026-11-12T01:02:03.000Z',
      id: null, // 有 at 没 id:at 不能充当身份
    });
    // id 只认 16 位小写十六进制;缺失 / 格式错 / 非字符串 → null
    const withId = (id: string): string =>
      `{"at":"2026-11-12T01:02:03.000Z","by":"breaker","id":${id},"reason":"user_vetoes"}`;
    expect(parsePauseMarker(withId('"0123456789abcdef"')).id).toBe('0123456789abcdef');
    for (const bad of [
      '"0123456789ABCDEF"',
      '"0123456789abcde"',
      '"0123456789abcdefa"',
      '"zzzzzzzzzzzzzzzz"',
      '""',
      '5',
      'null',
    ]) {
      expect(parsePauseMarker(withId(bad)).id, bad).toBeNull();
    }
    // at 不是非空字符串 → null
    expect(parsePauseMarker('{"at":"","by":"breaker","reason":"user_vetoes"}').at).toBeNull();
    expect(parsePauseMarker('{"at":5,"by":"breaker","reason":"user_vetoes"}').at).toBeNull();
    expect(parsePauseMarker('{"by":"breaker","reason":"nope"}')).toEqual({
      by: 'unknown',
      reason: null,
      at: null,
      id: null,
    });
    expect(parsePauseMarker('not json')).toEqual({
      by: 'unknown',
      reason: null,
      at: null,
      id: null,
    });
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
