/**
 * W0-29 ⑤:`rsi hint --canary` 读已提交 `state.json` 的 `auto_pause.reasons` / `diverged` / `owner_changed`:任一非空 / 真 → 本次没有 canary 部分
 * (纯读;计数行不受影响;缺 `auto_pause` 或全空 = 与此前行为相同)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, readText } from '../../../src/io/read-fs.js';
import { writeFile } from '../../../src/io/safe-fs.js';
import { buildRsiPolicy, loadRsiConfig, policyFingerprint } from '../../../src/rsi/config.js';
import { runHint, type RunHintDeps } from '../../../src/rsi/hint.js';
import { makeTickFx, type TickFx } from '../b5a-fixture.js';
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
import { adm, admitted, canaryDoc } from '../canary/w5-fixture.js';

const NOW_MS = Date.parse(NOW);
const ARGV = ['--agent', 'claude', '--format', 'claude-json', '--canary'];
const MARK = 'agent-kit RSI 关联标记:';

type AutoPause = { reasons: string[]; diverged: boolean; owner_changed: boolean };

async function world(prefix: string, autoPause?: AutoPause): Promise<TickFx> {
  const f = await makeTickFx(prefix, { noSeed: true, extra: '\n[rsi.auto]\nenabled = true\n' });
  const p = await mkProject(f, 'one');
  await seed(f, {
    state: baseState({
      confirm: await validConfirm(f),
      projects_ack_generation: 5,
      ...(autoPause !== undefined ? { auto_pause: autoPause } : {}),
    }),
    index: indexOf([{ key: key(1), path: p.path, dev: p.dev, ino: p.ino, firstGen: 9 }], 9),
    counts: countsOf({ [key(1)]: { total: 1 } }),
  });
  const cfg = await loadRsiConfig({ home: f.home });
  if (cfg.status !== 'on') throw new Error('off');
  const fp = policyFingerprint(await buildRsiPolicy(cfg));
  await writeFile(
    f.io,
    path.join(f.rsiDir, 'canary.json'),
    JSON.stringify(canaryDoc({ policy_fp: fp })),
    {
      mode: 0o600,
    },
  );
  await writeFile(
    f.io,
    path.join(f.rsiDir, 'canary-admission.json'),
    JSON.stringify(adm(admitted())),
    {
      mode: 0o600,
    },
  );
  return f;
}

function deps(f: TickFx): RunHintDeps {
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
  };
}
const ctxOf = (out: string): string =>
  (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
    .additionalContext;
const ledgerExists = (f: TickFx): Promise<boolean> =>
  exists(path.join(f.rsiDir, 'canary-ledger.jsonl'));

describe('hint 读已提交 state.json 的暂停事实(canary 部分)', () => {
  it('对照:无 auto_pause → canary 部分照常输出、账落一行', async () => {
    const f = await world('c2-hint-ok-');
    expect(ctxOf(await runHint(ARGV, deps(f)))).toContain(MARK);
    expect(await ledgerExists(f)).toBe(true);
  });

  it('对照:auto_pause 存在但全空 → 与无 auto_pause 相同', async () => {
    const f = await world('c2-hint-empty-', { reasons: [], diverged: false, owner_changed: false });
    expect(ctxOf(await runHint(ARGV, deps(f)))).toContain(MARK);
  });

  it.each([
    ['reasons 非空', { reasons: ['user_vetoes'], diverged: false, owner_changed: false }],
    ['diverged', { reasons: [], diverged: true, owner_changed: false }],
    ['owner_changed', { reasons: [], diverged: false, owner_changed: true }],
  ] as const)('%s → 本次没有 canary 部分(无关联标记、不落账);计数行不受影响', async (_n, ap) => {
    const f = await world(`c2-hint-${_n.slice(0, 4)}-`, { ...ap, reasons: [...ap.reasons] });
    const out = await runHint(ARGV, deps(f));
    const c = out === '' ? '' : ctxOf(out);
    expect(c).not.toContain(MARK);
    expect(await ledgerExists(f)).toBe(false);
    expect(c.startsWith('agent-kit RSI: ')).toBe(true); // 计数行仍在
  });

  it('只读:读 state 不写盘(除计数行去重标记外无新文件)', async () => {
    const f = await world('c2-hint-ro-', {
      reasons: ['user_vetoes'],
      diverged: false,
      owner_changed: false,
    });
    const before = await readText(path.join(f.rsiDir, 'state.json'));
    await runHint(ARGV, deps(f));
    expect(await readText(path.join(f.rsiDir, 'state.json'))).toBe(before);
  });
});
