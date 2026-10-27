/**
 * R20-A2 B4b 验收返工 A / B:走真实配置变更路径(loadRsiConfig → buildRsiPolicy → loadRepoIdentity → rsiStateOf → observationFrom)
 * 验证检查点对「收紧排除 / 放宽排除 / agents 增减 / 状态不可算」的判定。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RsiStateSchema, type RsiConfirm } from '../../src/contracts/rsi.js';
import { buildRsiPolicy, loadRsiConfig } from '../../src/rsi/config.js';
import {
  bindingOf,
  compareBinding,
  createCheckpoint,
  observationFrom,
  type BindingObservation,
} from '../../src/rsi/l0/binding.js';
import type { RunBinding } from '../../src/rsi/l0/types.js';
import { loadRepoIdentity, rsiStateOf, type RsiStateDoc } from '../../src/rsi/state.js';
import { mkdirp } from '../../src/io/safe-fs.js';
import { makeL0Fx, type L0Fx } from './l0-fixture.js';
import { baseState, setExtra, validConfirm } from './ro-fixture.js';

async function setCfg(f: L0Fx, extra: string): Promise<void> {
  await setExtra(f, extra);
}
const dirOf = (f: L0Fx, n: string): string => path.join(f.dir, 'work', n);

/** 以磁盘上当前的 `[rsi]` 配置现算一次观测(与检查点上「重读配置与状态」同一条路径) */
async function observe(
  f: L0Fx,
  confirm: RsiConfirm,
  doc?: RsiStateDoc,
  stopPresent = false,
): Promise<{ obs: BindingObservation; state: string; binding: RunBinding | null }> {
  const cfg = await loadRsiConfig({ env: f.env });
  if (cfg.status !== 'on') throw new Error('config off');
  const policy = await buildRsiPolicy(cfg);
  const identity = await loadRepoIdentity(cfg, policy);
  const d: RsiStateDoc = doc ?? {
    kind: 'ok',
    state: RsiStateSchema.parse(baseState({ confirm })),
  };
  const state = rsiStateOf({ config: cfg, stopPresent, doc: d, identity });
  const obs = observationFrom({ state, stopPresent, identity, confirm });
  return { obs, state: state.state, binding: obs.current };
}

/** 运行绑定 = 起跑时(检查点之前)的配置与确认记录 */
async function startBinding(f: L0Fx, confirm: RsiConfirm): Promise<RunBinding> {
  const { obs } = await observe(f, confirm);
  if (obs.current === null) throw new Error('起跑时应是 confirmed');
  return obs.current;
}

const ABORT_BINDING = { kind: 'abort', outcome: 'skipped_binding_changed' } as const;

describe('A:检查点上的配置变更(真实路径)', () => {
  it('正向对照:配置不变 → continue,且确认仍有效', async () => {
    const f = await makeL0Fx('bind-same-');
    const confirm = await validConfirm(f);
    const run = await startBinding(f, confirm);
    const { obs, state } = await observe(f, confirm);
    expect(state).toBe('confirmed');
    expect(compareBinding(run, obs)).toEqual({ kind: 'continue' });
  });

  it('收紧排除:确认仍有效(只判放宽),但运行绑定的 policyFp 变了 → skipped_binding_changed', async () => {
    const f = await makeL0Fx('bind-tighten-');
    await mkdirp(f.fx, dirOf(f, 'x'), 0o755);
    const confirm = await validConfirm(f);
    const run = await startBinding(f, confirm);
    await setCfg(f, `exclude_dirs = [${JSON.stringify(dirOf(f, 'x'))}]\n`);
    const { obs, state } = await observe(f, confirm);
    expect(state).toBe('confirmed'); // 前提:收紧不使确认失效(所以不是靠「状态变 armed」才触发)
    expect(obs.current).not.toBeNull();
    expect(obs.current?.policyFp).not.toBe(run.policyFp);
    expect(compareBinding(run, obs)).toEqual(ABORT_BINDING);
    // 同一路径走真实检查点:行检查点与文件检查点、提交检查点都 abort
    const cp = createCheckpoint({
      nowMs: () => 0,
      startedAtMs: 0,
      maxMs: 1000,
      binding: run,
      observe: async () => (await observe(f, confirm)).obs,
    });
    for (const w of ['file', 'lines', 'commit'] as const)
      expect(await cp(w)).toEqual(ABORT_BINDING);
  });

  it('放宽排除:确认失效(exclude_relaxed)→ armed → current 为 null → skipped_binding_changed', async () => {
    const f = await makeL0Fx('bind-relax-');
    await mkdirp(f.fx, dirOf(f, 'x'), 0o755);
    await setCfg(f, `exclude_dirs = [${JSON.stringify(dirOf(f, 'x'))}]\n`);
    const confirm = await validConfirm(f);
    const run = await startBinding(f, confirm);
    await setCfg(f, '');
    const { obs, state } = await observe(f, confirm);
    expect(state).toBe('armed');
    expect(obs.current).toBeNull();
    expect(compareBinding(run, obs)).toEqual(ABORT_BINDING);
  });

  it('agents 增加:确认失效 → binding_changed;agents 减少:确认仍有效但 agents / policyFp 变 → binding_changed', async () => {
    const f = await makeL0Fx('bind-agents-');
    await setCfg(f, 'agents = ["claude"]\n');
    const confirm1 = await validConfirm(f);
    const run1 = await startBinding(f, confirm1);
    await setCfg(f, 'agents = ["claude", "pi"]\n');
    const added = await observe(f, confirm1);
    expect(added.state).toBe('armed');
    expect(compareBinding(run1, added.obs)).toEqual(ABORT_BINDING);

    await setCfg(f, 'agents = ["claude", "pi"]\n');
    const confirm2 = await validConfirm(f);
    const run2 = await startBinding(f, confirm2);
    expect(run2.agents).toEqual(['claude', 'pi']);
    await setCfg(f, 'agents = ["claude"]\n');
    const reduced = await observe(f, confirm2);
    expect(reduced.state).toBe('confirmed');
    expect(reduced.obs.current?.agents).toEqual(['claude']);
    expect(compareBinding(run2, reduced.obs)).toEqual(ABORT_BINDING);
  });

  it('绑定未变而 confirmed_at 变(重新确认过)→ binding_changed', async () => {
    const f = await makeL0Fx('bind-reconfirm-');
    const confirm = await validConfirm(f);
    const run = await startBinding(f, confirm);
    const again = { ...confirm, confirmed_at: '2026-10-25T00:00:00.000Z' };
    const { obs } = await observe(f, again);
    expect(compareBinding(run, obs)).toEqual(ABORT_BINDING);
  });

  it('bindingOf 的 policyFp 随策略而变(变异靶点的正向前提)', async () => {
    const f = await makeL0Fx('bind-fp-');
    const cfg0 = await loadRsiConfig({ env: f.env });
    if (cfg0.status !== 'on') throw new Error('off');
    const id0 = await loadRepoIdentity(cfg0, await buildRsiPolicy(cfg0));
    await mkdirp(f.fx, dirOf(f, 'y'), 0o755);
    await setCfg(f, `exclude_dirs = [${JSON.stringify(dirOf(f, 'y'))}]\n`);
    const cfg1 = await loadRsiConfig({ env: f.env });
    if (cfg1.status !== 'on') throw new Error('off');
    const id1 = await loadRepoIdentity(cfg1, await buildRsiPolicy(cfg1));
    const b0 = bindingOf({ identity: id0, confirmedAt: null });
    const b1 = bindingOf({ identity: id1, confirmedAt: null });
    expect(b0.policyFp).not.toBe(b1.policyFp);
    expect(b0.repoSha256).toBe(b1.repoSha256);
  });
});

describe('B:状态不可算 / STOP / 配置停止采集的归类', () => {
  it('state.json 过不了 schema(armed + stateInvalid)→ skipped_collect_blocked,不是 binding_changed', async () => {
    const f = await makeL0Fx('bind-invalid-');
    const confirm = await validConfirm(f);
    const run = await startBinding(f, confirm);
    const { obs, state } = await observe(f, confirm, { kind: 'invalid' });
    expect(state).toBe('armed');
    expect(obs.collectBlocked).toBe(true);
    expect(compareBinding(run, obs)).toEqual({ kind: 'abort', outcome: 'skipped_collect_blocked' });
  });

  it('STOP 标记 → stopped(优先于其它);overlay 不合规(config.block)→ skipped_collect_blocked', async () => {
    const f = await makeL0Fx('bind-stop-');
    const confirm = await validConfirm(f);
    const run = await startBinding(f, confirm);
    const stopped = await observe(f, confirm, undefined, true);
    expect(compareBinding(run, stopped.obs)).toEqual({ kind: 'abort', outcome: 'stopped' });
    await setCfg(f, 'exclude_dirs = ["relative/dir"]\n');
    const blocked = await observe(f, confirm);
    expect(blocked.obs.collectBlocked).toBe(true);
    expect(compareBinding(run, blocked.obs)).toEqual({
      kind: 'abort',
      outcome: 'skipped_collect_blocked',
    });
  });
});
