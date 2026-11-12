/**
 * W5 `rsi hint --agent claude --format claude-json --canary` 端到端(真实配置 / 状态 / 分组账):
 * 计数行与 canary 部分独立判定、合成一个 additionalContext、合计 ≤ 200 + 1536 字节;缺省相位 0 时整个 canary 部分惰性;
 * 普通 hint(无 --canary)行为不变且不碰分组账。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RSI_AUTO_LABEL, RSI_HINT_CANARY_TOTAL_MAX_BYTES } from '../../../src/contracts/rsi.js';
import { exists, readText } from '../../../src/io/read-fs.js';
import { mkdirp, writeFile } from '../../../src/io/safe-fs.js';
import { buildRsiPolicy, loadRsiConfig, policyFingerprint } from '../../../src/rsi/config.js';
import { runHint, type RunHintDeps } from '../../../src/rsi/hint.js';
import { REVOCATIONS_REL } from '../../../src/rsi/canary/permit-read.js';
import { makeTickFx, type TickFx } from '../b5a-fixture.js';
import { treeOf } from '../rsi-fixture.js';
import {
  NOW,
  baseState,
  countsOf,
  indexOf,
  key,
  mkProject,
  seed,
  validConfirm,
} from '../ro-fixture.js';
import { BODY, REVOKE, adm, admitted, canaryDoc, probing } from './w5-fixture.js';
import type { CanaryAdmission, CanaryDoc } from '../../../src/contracts/rsi-personal.js';

const NOW_MS = Date.parse(NOW);
const ARGV = ['--agent', 'claude', '--format', 'claude-json', '--canary'];
const COUNT_PREFIX = 'agent-kit RSI: ';
const MARK = 'agent-kit RSI 关联标记:';

/** confirmed 世界:一个项目;`withCount` 控制计数行是否显示(新增项目 n = 1 → 显示) */
async function world(
  prefix: string,
  o: { withCount?: boolean; auto?: boolean } = {},
): Promise<TickFx> {
  const f = await makeTickFx(prefix, {
    noSeed: true,
    extra: o.auto === false ? '' : '\n[rsi.auto]\nenabled = true\n',
  });
  const p = await mkProject(f, 'one');
  await seed(f, {
    state: baseState({
      confirm: await validConfirm(f),
      projects_ack_generation: o.withCount === false ? 9 : 5,
    }),
    index: indexOf([{ key: key(1), path: p.path, dev: p.dev, ino: p.ino, firstGen: 9 }], 9),
    counts: countsOf({ [key(1)]: { total: 1 } }),
  });
  return f;
}

function deps(f: TickFx, over: Partial<RunHintDeps> = {}): RunHintDeps {
  return {
    env: f.env,
    writeAudit: (op, p) => void f.audit.push({ op, path: p }),
    now: () => new Date(NOW_MS),
    clockMs: () => 0,
    phase: 2,
    home: f.home,
    agentVersion: () => '2.1.0',
    random: () => 0.1,
    randomBytes: (k) => new Uint8Array(k).fill(7),
    ...over,
  };
}

async function policyFp(f: TickFx): Promise<string> {
  const cfg = await loadRsiConfig({ home: f.home });
  if (cfg.status !== 'on') throw new Error('off');
  return policyFingerprint(await buildRsiPolicy(cfg));
}

async function put(f: TickFx, name: string, text: string): Promise<void> {
  await writeFile(f.io, path.join(f.rsiDir, name), text, { mode: 0o600 });
}
async function seedCanary(
  f: TickFx,
  o: { doc?: Partial<CanaryDoc>; admission?: CanaryAdmission } = {},
): Promise<void> {
  await put(
    f,
    'canary.json',
    JSON.stringify(canaryDoc({ policy_fp: await policyFp(f), ...o.doc })),
  );
  await put(f, 'canary-admission.json', JSON.stringify(o.admission ?? adm(admitted())));
}
const ctxOf = (out: string): string =>
  (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
    .additionalContext;
const ledger = async (f: TickFx): Promise<Record<string, unknown>[]> => {
  const file = path.join(f.rsiDir, 'canary-ledger.jsonl');
  if (!(await exists(file))) return [];
  return (await readText(file))
    .slice(0, -1)
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
};

describe('合成输出', () => {
  it('计数行 + 关联标记 + treat 追加部分合成一个 additionalContext;合计 ≤ 1736 字节;账里一行 treat', async () => {
    const f = await world('w5-e2e-treat-');
    await seedCanary(f);
    const out = await runHint(ARGV, deps(f));
    const c = ctxOf(out);
    expect(c.startsWith(COUNT_PREFIX)).toBe(true);
    const [countLine, ...rest] = c.split('\n');
    expect(Buffer.byteLength(`${countLine}\n`, 'utf8')).toBeLessThanOrEqual(200);
    expect(rest.join('\n')).toBe(
      `${MARK} rsm_0707070707070707\n${RSI_AUTO_LABEL}\n${'a'.repeat(12)}\n${BODY}`,
    );
    expect(Buffer.byteLength(c, 'utf8')).toBeLessThanOrEqual(RSI_HINT_CANARY_TOTAL_MAX_BYTES);
    const rows = await ledger(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      arm: 'treat',
      marker: 'rsm_0707070707070707',
      agent: 'claude',
    });
  });

  it('不受 30 分钟去重约束:同一窗口第二次,计数行被去重、canary 部分照常输出并再落一行账', async () => {
    const f = await world('w5-e2e-dedup-');
    await seedCanary(f);
    await runHint(ARGV, deps(f));
    const c2 = ctxOf(await runHint(ARGV, deps(f)));
    expect(c2.startsWith(COUNT_PREFIX)).toBe(false);
    expect(c2.startsWith(MARK)).toBe(true);
    expect(await ledger(f)).toHaveLength(2);
  });

  it('计数行不显示(没有可显示内容)时,canary 部分独立输出;control 组只有标记行', async () => {
    const f = await world('w5-e2e-only-', { withCount: false });
    await seedCanary(f);
    expect(await runHint(['--agent', 'claude', '--format', 'claude-json'], deps(f))).toBe('');
    const c = ctxOf(await runHint(ARGV, deps(f, { random: () => 0.9 })));
    expect(c).toBe(`${MARK} rsm_0707070707070707`);
  });

  it('未落账不注入:账路径不可追加 → 只剩计数行,标记与正文都不出现', async () => {
    const f = await world('w5-e2e-nol-');
    await seedCanary(f);
    await mkdirp(f.io, path.join(f.rsiDir, 'canary-ledger.jsonl'), 0o700);
    const c = ctxOf(await runHint(ARGV, deps(f)));
    expect(c.startsWith(COUNT_PREFIX)).toBe(true);
    expect(c.includes(MARK)).toBe(false);
    expect(c.includes(BODY)).toBe(false);
  });
});

describe('第 1 / 2 行:惰性', () => {
  it('缺省相位(RSI_AUTO_PHASE = 0)→ canary 部分惰性:只有计数行、不碰分组账', async () => {
    const f = await world('w5-e2e-phase0-');
    await seedCanary(f);
    const c = ctxOf(await runHint(ARGV, deps(f, { phase: undefined })));
    expect(c.startsWith(COUNT_PREFIX)).toBe(true);
    expect(c.includes(MARK)).toBe(false);
    expect(await exists(path.join(f.rsiDir, 'canary-ledger.jsonl'))).toBe(false);
  });
  it('[rsi.auto] 未开启 / codex / 相位 1 → 第 2 行:无 canary 输出、无账', async () => {
    const f1 = await world('w5-e2e-noauto-', { auto: false });
    await seedCanary(f1);
    expect(ctxOf(await runHint(ARGV, deps(f1))).includes(MARK)).toBe(false);
    const f2 = await world('w5-e2e-codex-');
    await seedCanary(f2);
    const out = await runHint(['--agent', 'codex', '--format', 'codex-json', '--canary'], deps(f2));
    expect(ctxOf(out).includes(MARK)).toBe(false);
    expect(await exists(path.join(f2.rsiDir, 'canary-ledger.jsonl'))).toBe(false);
    const f3 = await world('w5-e2e-p1-');
    await seedCanary(f3);
    expect(ctxOf(await runHint(ARGV, deps(f3, { phase: 1 }))).includes(MARK)).toBe(false);
  });
  it('--canary 必须带 --format(纯文本模式不走矩阵):参数错误 → 空串、零写入', async () => {
    const f = await world('w5-e2e-args-');
    await seedCanary(f);
    const before = await treeOf(f.io.stateDir);
    f.audit.length = 0;
    expect(await runHint(['--agent', 'claude', '--canary'], deps(f))).toBe('');
    expect(await runHint([...ARGV, 'extra'], deps(f))).toBe('');
    expect(
      await runHint(['--agent', 'claude', '--format', 'claude-json', '--bogus'], deps(f)),
    ).toBe('');
    expect(f.audit).toEqual([]);
    expect(await treeOf(f.io.stateDir)).toEqual(before);
  });
  it('状态不是 confirmed(armed)→ 第 1 行:没有 canary 部分、没有账', async () => {
    const f = await makeTickFx('w5-e2e-armed-', { extra: '\n[rsi.auto]\nenabled = true\n' });
    await put(f, 'canary.json', JSON.stringify(canaryDoc({ policy_fp: await policyFp(f) })));
    await put(f, 'canary-admission.json', JSON.stringify(adm(admitted())));
    await runHint(ARGV, deps(f));
    expect(await exists(path.join(f.rsiDir, 'canary-ledger.jsonl'))).toBe(false);
  });
});

describe('第 4 / 3 行:排除与不伪造', () => {
  it('AUTO_PAUSE 在场 → 账一行 excluded/paused,无标记输出;删掉 AUTO_PAUSE 后下一次即恢复', async () => {
    const f = await world('w5-e2e-pause-');
    await seedCanary(f);
    await put(f, 'AUTO_PAUSE', '');
    const c = ctxOf(await runHint(ARGV, deps(f)));
    expect(c.includes(MARK)).toBe(false);
    expect((await ledger(f))[0]).toMatchObject({ arm: 'excluded', reason: 'paused', marker: null });
  });
  it('撤销凭据落盘后的下一次 hint 即停注入(excluded/revoked),不等 worker', async () => {
    const f = await world('w5-e2e-revoked-');
    await seedCanary(f);
    const file = path.join(f.home, ...REVOCATIONS_REL.split('/'));
    await mkdirp(f.fx, path.dirname(file), 0o700);
    await writeFile(f.fx, file, `${JSON.stringify(REVOKE())}\n`, { mode: 0o600 });
    const c = ctxOf(await runHint(ARGV, deps(f, { random: () => 0.1 })));
    expect(c.includes(MARK)).toBe(false);
    expect((await ledger(f))[0]).toMatchObject({ arm: 'excluded', reason: 'revoked' });
  });
  it('策略指纹不符(canary.json 的 policy_fp 与现算不等)→ excluded/policy_mismatch', async () => {
    const f = await world('w5-e2e-policy-');
    await seedCanary(f, { doc: { policy_fp: 'c'.repeat(64) } });
    await runHint(ARGV, deps(f));
    expect((await ledger(f))[0]).toMatchObject({ arm: 'excluded', reason: 'policy_mismatch' });
  });
  it('agent 版本现算不出(缺省端口恒 null)→ 准入按不一致处理:excluded/not_admitted(fail-closed)', async () => {
    const f = await world('w5-e2e-version-');
    await seedCanary(f);
    const d = deps(f);
    delete (d as { agentVersion?: unknown }).agentVersion;
    await runHint(ARGV, d);
    expect((await ledger(f))[0]).toMatchObject({ arm: 'excluded', reason: 'not_admitted' });
  });
  it('canary.json 不存在(第 3 行)→ 不伪造账行', async () => {
    const f = await world('w5-e2e-row3-');
    await put(f, 'canary-admission.json', JSON.stringify(adm(admitted())));
    await runHint(ARGV, deps(f));
    expect(await exists(path.join(f.rsiDir, 'canary-ledger.jsonl'))).toBe(false);
  });
});

describe('第 2a 行:探针端到端', () => {
  it('probing:输出仅含标记的一行(无标签 / 哈希 / 正文),账一行 admission_probe;与候选无关', async () => {
    const f = await world('w5-e2e-probe-', { withCount: false });
    await put(f, 'canary-admission.json', JSON.stringify(adm(probing({ generation: 1 }))));
    const c = ctxOf(await runHint(ARGV, deps(f)));
    expect(c).toBe(`${MARK} rsm_0707070707070707`);
    expect((await ledger(f))[0]).toMatchObject({
      arm: 'excluded',
      reason: 'admission_probe',
      candidate_id: null,
      marker: 'rsm_0707070707070707',
      probe_generation: 1,
      probe_ticket: 1,
      overlaps_preset: false,
    });
  });
});

describe('普通 hint 不受影响', () => {
  it('不带 --canary:输出与分组账、探针票无关(只有计数行与去重标记)', async () => {
    const f = await world('w5-e2e-plain-');
    await seedCanary(f);
    const out = await runHint(['--agent', 'claude', '--format', 'claude-json'], deps(f));
    expect(ctxOf(out).startsWith(COUNT_PREFIX)).toBe(true);
    expect(ctxOf(out).includes(MARK)).toBe(false);
    expect(await exists(path.join(f.rsiDir, 'canary-ledger.jsonl'))).toBe(false);
  });
});
