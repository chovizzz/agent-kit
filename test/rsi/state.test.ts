/**
 * R20-A2 B2:`rsiStateOf()`(docs/contracts.md §20.1 R20-1.3 / R20-1.5 / R20-1.5a / R20-1.12)。
 * 4 种状态 × 跳过条件 × 首次 / 失效两种 armed 的矩阵;六条失效判据逐条;收紧排除 / 减少 agent / 新增项目不使确认失效。
 */
import { describe, expect, it } from 'vitest';
import { RsiStateSchema, type RsiConfirm, type RsiState } from '../../src/contracts/rsi.js';
import {
  buildRsiPolicy,
  loadRsiConfig,
  policyFingerprint,
  type RsiConfig,
  type RsiConfigOn,
} from '../../src/rsi/config.js';
import {
  confirmInvalidReason,
  loadRepoIdentity,
  parseRsiStateDoc,
  rsiStateOf,
  type RsiIdentity,
  type RsiStateDoc,
} from '../../src/rsi/state.js';
import { makeRsiFx, rsiToml, writeCfg, type RsiFx } from './rsi-fixture.js';

const NOW = '2026-10-24T08:00:00.000Z';

async function loadOn(f: RsiFx, extra = ''): Promise<RsiConfigOn> {
  await writeCfg(f, rsiToml(f, extra));
  const c = await loadRsiConfig({ home: f.home });
  if (c.status !== 'on') throw new Error(`off(${c.reason})`);
  return c;
}

async function identityOf(c: RsiConfigOn, major = 0): Promise<RsiIdentity> {
  return loadRepoIdentity(c, await buildRsiPolicy(c, major));
}

const confirmOf = (id: RsiIdentity): RsiConfirm => ({
  confirmed_at: NOW,
  kit_major: id.policy.kit_major,
  agents: [...id.policy.agents],
  exclude_hashes: [...id.policy.exclude_hashes],
  repo_sha256: id.repoSha256,
  repo_dev_ino: { ...id.repoDevIno },
  overlay_sha256: id.policy.overlay_sha256,
  policy_fp: policyFingerprint(id.policy),
  baseline_pending: true,
});

const stateWith = (confirm: RsiConfirm | null): RsiState => ({
  schema_version: 1,
  confirm,
  projects_ack_generation: 0,
  attempt: null,
  last_tick: null,
  consecutive_failures: 0,
  breaker: null,
});

const okDoc = (confirm: RsiConfirm | null): RsiStateDoc => ({
  kind: 'ok',
  state: stateWith(confirm),
});

const OFF: RsiConfig = { status: 'off', reason: 'disabled' };

describe('R20-1.3 判据顺序:off → stopped → armed → confirmed', () => {
  it('配置 off(任一原因)→ off,原因码透传;STOP 与确认记录都不改变', async () => {
    const f = await makeRsiFx('st-off-');
    const id = await identityOf(await loadOn(f));
    for (const reason of [
      'absent',
      'no_section',
      'cfg_perm',
      'cfg_schema',
      'disabled',
      'repo_invalid',
    ] as const) {
      const r = rsiStateOf({
        config: { status: 'off', reason },
        stopPresent: true,
        doc: okDoc(confirmOf(id)),
      });
      expect(r, reason).toMatchObject({ state: 'off', reason, firstArmed: false });
    }
  });

  it('自动入口被 R20-1.6 条件命中(autoSkip)→ off/auto_skip;前台命令不传就不受影响', async () => {
    const f = await makeRsiFx('st-skip-');
    const cfg = await loadOn(f);
    const id = await identityOf(cfg);
    const base = { config: cfg, stopPresent: false, doc: okDoc(confirmOf(id)), identity: id };
    expect(rsiStateOf({ ...base, autoSkip: true })).toMatchObject({
      state: 'off',
      reason: 'auto_skip',
    });
    expect(rsiStateOf(base).state).toBe('confirmed');
  });

  it('配置可用且 STOP 存在 → stopped(先于 armed / confirmed:无确认、有效确认、失效确认都是 stopped)', async () => {
    const f = await makeRsiFx('st-stopped-');
    const cfg = await loadOn(f);
    const id = await identityOf(cfg);
    for (const doc of [
      { kind: 'absent' } as RsiStateDoc,
      okDoc(null),
      okDoc(confirmOf(id)),
      okDoc({ ...confirmOf(id), kit_major: 99 }),
    ]) {
      expect(rsiStateOf({ config: cfg, stopPresent: true, doc, identity: id }).state).toBe(
        'stopped',
      );
    }
    // 对照:同一输入去掉 STOP
    expect(
      rsiStateOf({ config: cfg, stopPresent: false, doc: okDoc(confirmOf(id)), identity: id })
        .state,
    ).toBe('confirmed');
  });

  it('armed:无 state.json / 无确认记录 = 首次 armed(firstArmed);confirmed:确认有效', async () => {
    const f = await makeRsiFx('st-armed-');
    const cfg = await loadOn(f);
    const id = await identityOf(cfg);
    expect(rsiStateOf({ config: cfg, stopPresent: false, doc: { kind: 'absent' } })).toMatchObject({
      state: 'armed',
      firstArmed: true,
      confirmInvalid: null,
    });
    expect(rsiStateOf({ config: cfg, stopPresent: false, doc: okDoc(null) })).toMatchObject({
      state: 'armed',
      firstArmed: true,
    });
    expect(
      rsiStateOf({ config: cfg, stopPresent: false, doc: okDoc(confirmOf(id)), identity: id }),
    ).toMatchObject({ state: 'confirmed', firstArmed: false, confirmInvalid: null });
  });

  it('停止采集(overlay_invalid / exclude_invalid)不改变状态,只带 collectBlocked', async () => {
    const f = await makeRsiFx('st-blocked-');
    const cfg = await loadOn(f, 'exclude_dirs = ["relative"]\n');
    expect(cfg.block).toBe('exclude_invalid');
    const id = await identityOf(cfg);
    expect(
      rsiStateOf({ config: cfg, stopPresent: false, doc: okDoc(confirmOf(id)), identity: id }),
    ).toMatchObject({ state: 'confirmed', collectBlocked: 'exclude_invalid' });
    expect(rsiStateOf({ config: cfg, stopPresent: false, doc: { kind: 'absent' } })).toMatchObject({
      state: 'armed',
      collectBlocked: 'exclude_invalid',
    });
  });
});

describe('R20-1.5 确认记录的六条失效判据(失效 → armed,非首次)', () => {
  it('①排除被放宽:确认时的任一排除哈希不在当前集合里', async () => {
    const f = await makeRsiFx('st-c1-');
    const id0 = await identityOf(
      await loadOn(f, 'exclude_dirs = ["/a","/b"]\nexclude_names = ["n"]\n'),
    );
    const confirm = confirmOf(id0);
    expect(confirm.exclude_hashes).toHaveLength(3);
    // 删掉一项 = 放宽
    const id1 = await identityOf(await loadOn(f, 'exclude_dirs = ["/a"]\nexclude_names = ["n"]\n'));
    expect(confirmInvalidReason(confirm, id1)).toBe('exclude_relaxed');
    const r = rsiStateOf({
      config: await loadOn(f, 'exclude_dirs = ["/a"]\n'),
      stopPresent: false,
      doc: okDoc(confirm),
      identity: id1,
    });
    expect(r).toMatchObject({
      state: 'armed',
      firstArmed: false,
      confirmInvalid: 'exclude_relaxed',
    });
    // 把一项换成另一项也是放宽(原哈希不在了)
    const id2 = await identityOf(
      await loadOn(f, 'exclude_dirs = ["/a","/c"]\nexclude_names = ["n"]\n'),
    );
    expect(confirmInvalidReason(confirm, id2)).toBe('exclude_relaxed');
  });

  it('收紧排除(新增项)/ 减少 agent / 新增项目都不使确认失效', async () => {
    const f = await makeRsiFx('st-tighten-');
    const id0 = await identityOf(await loadOn(f, 'exclude_dirs = ["/a"]\n'));
    const confirm = confirmOf(id0);
    const tighter = await identityOf(
      await loadOn(f, 'exclude_dirs = ["/a","/b"]\nexclude_names = ["x"]\n'),
    );
    expect(confirmInvalidReason(confirm, tighter)).toBeNull();
    const fewer = await identityOf(await loadOn(f, 'exclude_dirs = ["/a"]\nagents = ["claude"]\n'));
    expect(confirmInvalidReason(confirm, fewer)).toBeNull();
    const both = await identityOf(await loadOn(f, 'exclude_dirs = ["/a","/b"]\nagents = ["pi"]\n'));
    expect(confirmInvalidReason(confirm, both)).toBeNull();
    // 「新增项目」不在身份里:同一身份下确认依旧有效
    expect(confirmInvalidReason(confirm, id0)).toBeNull();
  });

  it('②当前 agents 含确认时没有的 agent', async () => {
    const f = await makeRsiFx('st-c2-');
    const id0 = await identityOf(await loadOn(f, 'agents = ["claude"]\n'));
    const id1 = await identityOf(await loadOn(f, 'agents = ["claude","pi"]\n'));
    expect(confirmInvalidReason(confirmOf(id0), id1)).toBe('agent_added');
  });

  it('③repo 的 realpath 或 (dev, ino) 与确认时不同(各自单独触发)', async () => {
    const f = await makeRsiFx('st-c3-');
    const id = await identityOf(await loadOn(f));
    const c = confirmOf(id);
    expect(confirmInvalidReason(c, { ...id, repoSha256: 'e'.repeat(64) })).toBe('repo_changed');
    expect(
      confirmInvalidReason(c, {
        ...id,
        repoDevIno: { dev: id.repoDevIno.dev, ino: id.repoDevIno.ino + 1 },
      }),
    ).toBe('repo_changed');
    expect(
      confirmInvalidReason(c, {
        ...id,
        repoDevIno: { dev: id.repoDevIno.dev + 1, ino: id.repoDevIno.ino },
      }),
    ).toBe('repo_changed');
    expect(confirmInvalidReason(c, id)).toBeNull();
  });

  it('④overlay 的有无或内容 sha256 不同(有→无、无→有、内容变)', async () => {
    const f = await makeRsiFx('st-c4-');
    const none = await identityOf(await loadOn(f));
    const withOv = { ...none, policy: { ...none.policy, overlay_sha256: 'a'.repeat(64) } };
    const other = { ...none, policy: { ...none.policy, overlay_sha256: 'b'.repeat(64) } };
    expect(confirmInvalidReason(confirmOf(none), withOv)).toBe('overlay_changed');
    expect(confirmInvalidReason(confirmOf(withOv), none)).toBe('overlay_changed');
    expect(confirmInvalidReason(confirmOf(withOv), other)).toBe('overlay_changed');
    expect(confirmInvalidReason(confirmOf(withOv), withOv)).toBeNull();
  });

  it('⑤kit 主版本不同', async () => {
    const f = await makeRsiFx('st-c5-');
    const cfg = await loadOn(f);
    const v0 = await identityOf(cfg, 0);
    const v1 = await identityOf(cfg, 1);
    expect(confirmInvalidReason(confirmOf(v0), v1)).toBe('kit_major');
  });

  it('⑥记录过不了 schema:confirm 单独不合规 → armed/schema(非首次);整份 state.json 不合规 → armed + stateInvalid', async () => {
    const f = await makeRsiFx('st-c6-');
    const cfg = await loadOn(f);
    const id = await identityOf(cfg);
    const good = JSON.stringify(stateWith(confirmOf(id)));
    expect(parseRsiStateDoc(Buffer.from(good))).toMatchObject({ kind: 'ok' });
    const badConfirm = JSON.stringify({
      ...stateWith(null),
      confirm: { confirmed_at: 'yesterday' },
    });
    const doc = parseRsiStateDoc(Buffer.from(badConfirm));
    expect(doc.kind).toBe('confirm_schema_invalid');
    expect(rsiStateOf({ config: cfg, stopPresent: false, doc, identity: id })).toMatchObject({
      state: 'armed',
      firstArmed: false,
      confirmInvalid: 'schema',
      stateInvalid: false,
    });
    for (const raw of [
      'not json',
      '[]',
      '{"schema_version":1}',
      JSON.stringify({ ...stateWith(null), extra: 1 }),
    ]) {
      expect(parseRsiStateDoc(Buffer.from(raw)), raw).toEqual({ kind: 'invalid' });
    }
    // 整份损坏而 confirm 本身合法:仍是整份 invalid(不把别的损坏当成 confirm 失效)
    const brokenElsewhere = JSON.stringify({
      ...stateWith(confirmOf(id)),
      projects_ack_generation: -1,
    });
    expect(parseRsiStateDoc(Buffer.from(brokenElsewhere))).toEqual({ kind: 'invalid' });
    expect(
      rsiStateOf({ config: cfg, stopPresent: false, doc: { kind: 'invalid' }, identity: id }),
    ).toMatchObject({ state: 'armed', firstArmed: false, stateInvalid: true });
    expect(parseRsiStateDoc(null)).toEqual({ kind: 'absent' });
    expect(RsiStateSchema.safeParse(stateWith(null)).success).toBe(true);
  });

  it('失效原因取第一个命中的(① 先于 ②…⑤);有效确认且身份缺失时按最低权限 armed', async () => {
    const f = await makeRsiFx('st-order-');
    const id0 = await identityOf(
      await loadOn(f, 'exclude_dirs = ["/a"]\nagents = ["claude"]\n'),
      0,
    );
    const id1 = await identityOf(await loadOn(f, 'agents = ["claude","pi"]\n'), 1);
    // 同时命中 ①(放宽)②(新增 agent)⑤(主版本)
    expect(confirmInvalidReason(confirmOf(id0), id1)).toBe('exclude_relaxed');
    const cfg = await loadOn(f);
    expect(rsiStateOf({ config: cfg, stopPresent: false, doc: okDoc(confirmOf(id0)) }).state).toBe(
      'armed',
    );
  });
});

describe('R20-1.12 矩阵:每个状态 × 首次 / 失效两种 armed', () => {
  it('四种状态各自可达,且 firstArmed 只在「从未确认」的 armed 上为真', async () => {
    const f = await makeRsiFx('st-matrix-');
    const cfg = await loadOn(f);
    const id = await identityOf(cfg);
    const cases: [string, ReturnType<typeof rsiStateOf>][] = [
      ['off', rsiStateOf({ config: OFF, stopPresent: false, doc: { kind: 'absent' } })],
      ['stopped', rsiStateOf({ config: cfg, stopPresent: true, doc: { kind: 'absent' } })],
      ['armed-first', rsiStateOf({ config: cfg, stopPresent: false, doc: { kind: 'absent' } })],
      [
        'armed-invalidated',
        rsiStateOf({
          config: cfg,
          stopPresent: false,
          doc: okDoc({ ...confirmOf(id), kit_major: 9 }),
          identity: id,
        }),
      ],
      [
        'confirmed',
        rsiStateOf({ config: cfg, stopPresent: false, doc: okDoc(confirmOf(id)), identity: id }),
      ],
    ];
    expect(cases.map(([n, r]) => [n, r.state, r.firstArmed])).toEqual([
      ['off', 'off', false],
      ['stopped', 'stopped', false],
      ['armed-first', 'armed', true],
      ['armed-invalidated', 'armed', false],
      ['confirmed', 'confirmed', false],
    ]);
  });
});
