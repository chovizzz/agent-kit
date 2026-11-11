/**
 * W5 hint `--canary` 的执行部分(R21-6.2 / 6.3 / 6.4 / 6.11、W0-3):真实文件系统(KIT_TMP 内的假状态目录)上的分组账、探针票与输出文本。
 * 期望值手写:标记文本、账行字段、文件名都不经被测代码算出。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RSI_AUTO_LABEL, RSI_MARK_PREFIX } from '../../../src/contracts/rsi.js';
import { runCanaryPart } from '../../../src/rsi/canary/canary-hint.js';
import { exists, lstat, readDir } from '../../../src/io/read-fs.js';
import * as safe from '../../../src/io/safe-fs.js';
import {
  BODY,
  CID,
  POLICY,
  adm,
  admitted,
  canaryDoc,
  fakePort,
  ledgerRows,
  makeCanaryWorld,
  ok,
  probing,
  runEnv,
  type CanaryWorld,
  type PortState,
} from './w5-fixture.js';

const GOOD: PortState = { admission: ok(adm(admitted())), canary: ok(canaryDoc()) };
const M1 = 'rsm_0101010101010101';
const AT = '2026-11-10T12:00:00Z';

async function breakLedger(w: CanaryWorld): Promise<void> {
  // 把分组账路径占成目录:追加必然失败(EISDIR),用来演练「账行追加失败」
  await safe.mkdirp(w.io, path.join(w.rsi, 'canary-ledger.jsonl'), 0o700);
}

describe('第 6 / 7 行:随机、分组账、输出', () => {
  it('随机为 treat(u < p):输出 标记行 + 标签行 + 哈希前 12 位 + 正文;账行 arm=treat、p、背景指纹来自 canary.json', async () => {
    const w = await makeCanaryWorld('w5-treat-');
    const out = await runCanaryPart(runEnv(w, fakePort(GOOD), { random: () => 0.1 }));
    expect(out).toBe(`${RSI_MARK_PREFIX} ${M1}\n${RSI_AUTO_LABEL}\n${'a'.repeat(12)}\n${BODY}\n`);
    const rows = await ledgerRows(w);
    expect(rows).toEqual([
      {
        kind: 'assign',
        at: AT,
        agent: 'claude',
        marker: M1,
        candidate_id: CID,
        arm: 'treat',
        reason: null,
        p: 0.5,
        background_fp: '1'.repeat(16),
        background_fp_ex: '2'.repeat(16),
        policy_fp: POLICY,
        case_set_sha256: null,
        overlaps_preset: false,
        hint_version: 1,
      },
    ]);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(1536);
    expect((await lstat(path.join(w.rsi, 'canary-ledger.jsonl'))).mode & 0o777).toBe(0o600);
  });

  it('随机为 control(u ≥ p):只输出标记行,不含标签 / 哈希 / 正文;账行 arm=control', async () => {
    const w = await makeCanaryWorld('w5-control-');
    const out = await runCanaryPart(runEnv(w, fakePort(GOOD), { random: () => 0.5 }));
    expect(out).toBe(`${RSI_MARK_PREFIX} ${M1}\n`);
    expect(out.includes(RSI_AUTO_LABEL)).toBe(false);
    expect(out.includes('做:')).toBe(false);
    const rows = await ledgerRows(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      arm: 'control',
      marker: M1,
      candidate_id: CID,
      p: 0.5,
      reason: null,
    });
  });

  it('treat 概率取该 agent 的 p:p=1 时任何 u ∈ [0,1) 都是 treat', async () => {
    const w = await makeCanaryWorld('w5-p1-');
    const s: PortState = { ...GOOD, canary: ok(canaryDoc({ p_by_agent: { claude: 1 } })) };
    const out = await runCanaryPart(runEnv(w, fakePort(s), { random: () => 0.999999 }));
    expect(out.includes(RSI_AUTO_LABEL)).toBe(true);
  });

  it('两种组别的标记行都 ≤ 64 字节,不含路径 / 项目名', async () => {
    const w = await makeCanaryWorld('w5-marker-');
    const out = await runCanaryPart(runEnv(w, fakePort(GOOD), { random: () => 0.5 }));
    expect(Buffer.byteLength(out.trimEnd(), 'utf8')).toBeLessThanOrEqual(64);
    for (const needle of [w.dir, w.home, '/']) expect(out.includes(needle), needle).toBe(false);
  });
});

describe('第 8 行:未落账不注入', () => {
  it('账行追加失败 → 不输出(treat 与 control 都一样),标记与正文都不泄漏', async () => {
    for (const u of [0.1, 0.9]) {
      const w = await makeCanaryWorld('w5-noledger-');
      await breakLedger(w);
      const out = await runCanaryPart(runEnv(w, fakePort(GOOD), { random: () => u }));
      expect(out).toBe('');
    }
  });

  it('输出只在账行 fsync 之后才产生:账行追加的审计记录早于函数返回,且账里正好有一行', async () => {
    const w = await makeCanaryWorld('w5-order-');
    const ops: string[] = [];
    const env = runEnv(w, fakePort(GOOD), { random: () => 0.1 });
    const io = { ...w.io, writeAudit: (op: string): void => void ops.push(op) };
    const out = await runCanaryPart({ ...env, io });
    expect(out).not.toBe('');
    expect(ops).toEqual(['appendFileSynced']);
    expect(await ledgerRows(w)).toHaveLength(1);
  });

  it('预算已用尽(over)→ 不输出、不落账(落账之前检查)', async () => {
    const w = await makeCanaryWorld('w5-over-');
    const out = await runCanaryPart(runEnv(w, fakePort(GOOD), { over: () => true }));
    expect(out).toBe('');
    expect(await ledgerRows(w)).toEqual([]);
  });
});

describe('第 5 行:随机源报错', () => {
  const bad: [string, () => number][] = [
    [
      '抛错',
      () => {
        throw new Error('rng');
      },
    ],
    ['NaN', () => Number.NaN],
    ['等于 1(越界)', () => 1],
    ['负数', () => -0.1],
  ];
  it.each(bad)(
    '随机源%s → 账行 excluded/rng_error(marker=null、p=0),不输出',
    async (_n, random) => {
      const w = await makeCanaryWorld('w5-rng-');
      const out = await runCanaryPart(runEnv(w, fakePort(GOOD), { random }));
      expect(out).toBe('');
      const rows = await ledgerRows(w);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        arm: 'excluded',
        reason: 'rng_error',
        marker: null,
        candidate_id: CID,
        p: 0,
      });
    },
  );
  it('取标记字节失败同样算 rng_error', async () => {
    const w = await makeCanaryWorld('w5-rngbytes-');
    const out = await runCanaryPart(
      runEnv(w, fakePort(GOOD), {
        randomBytes: () => {
          throw new Error('bytes');
        },
      }),
    );
    expect(out).toBe('');
    expect((await ledgerRows(w))[0]).toMatchObject({ arm: 'excluded', reason: 'rng_error' });
  });
});

describe('第 4 / 4a 行:排除账行', () => {
  it('每个原因码一行 arm=excluded(候选 id 非空、marker=null、p=0),不输出;policy_fp 取现算值', async () => {
    const w = await makeCanaryWorld('w5-excl-');
    const out = await runCanaryPart(
      runEnv(w, fakePort({ ...GOOD, pause: 'present' }), { policyFp: 'c'.repeat(64) }),
    );
    expect(out).toBe('');
    const rows = await ledgerRows(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'assign',
      arm: 'excluded',
      reason: 'paused',
      marker: null,
      candidate_id: CID,
      p: 0,
      policy_fp: 'c'.repeat(64),
    });
  });
  it('读不到许可 → permit_unreadable 一行,不随机、不输出', async () => {
    const w = await makeCanaryWorld('w5-4a-');
    const out = await runCanaryPart(
      runEnv(w, fakePort({ ...GOOD, revocations: { kind: 'unreadable' } })),
    );
    expect(out).toBe('');
    expect((await ledgerRows(w))[0]).toMatchObject({
      arm: 'excluded',
      reason: 'permit_unreadable',
    });
  });
});

describe('第 2 / 3 行:零写入', () => {
  it('没有合法候选(第 3 行)→ 不输出、不创建分组账、不伪造账行', async () => {
    const w = await makeCanaryWorld('w5-row3-');
    const out = await runCanaryPart(runEnv(w, fakePort({ admission: ok(adm(admitted())) })));
    expect(out).toBe('');
    expect(await exists(path.join(w.rsi, 'canary-ledger.jsonl'))).toBe(false);
  });
  it('相位不足 / codex(第 2 行)→ 零写入', async () => {
    const w = await makeCanaryWorld('w5-row2-');
    expect(await runCanaryPart(runEnv(w, fakePort(GOOD), { phase: 1 }))).toBe('');
    expect(await runCanaryPart(runEnv(w, fakePort(GOOD), { agent: 'codex' }))).toBe('');
    expect(await exists(path.join(w.rsi, 'canary-ledger.jsonl'))).toBe(false);
  });
});

describe('第 2a 行:探针票(W0-3)', () => {
  const PROBING: PortState = { admission: ok(adm(probing({ generation: 1 }))) };
  const names = async (w: CanaryWorld): Promise<string[]> =>
    (await readDir(path.join(w.rsi, 'canary-probe', 'claude'))).map((e) => e.name);

  it('依次消费 3 张票:每次输出仅含标记的一行 + 账行 excluded/admission_probe(candidate_id=null、marker 非空、p=0、背景指纹全零);第 4 次不输出', async () => {
    const w = await makeCanaryWorld('w5-probe-');
    const outs: string[] = [];
    for (let i = 1; i <= 4; i++) {
      outs.push(
        await runCanaryPart(
          runEnv(w, fakePort(PROBING), { randomBytes: (k) => new Uint8Array(k).fill(i) }),
        ),
      );
    }
    expect(outs).toEqual([
      `${RSI_MARK_PREFIX} rsm_0101010101010101\n`,
      `${RSI_MARK_PREFIX} rsm_0202020202020202\n`,
      `${RSI_MARK_PREFIX} rsm_0303030303030303\n`,
      '',
    ]);
    const rows = await ledgerRows(w);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r).toMatchObject({
        arm: 'excluded',
        reason: 'admission_probe',
        candidate_id: null,
        p: 0,
        background_fp: '0'.repeat(16),
        background_fp_ex: '0'.repeat(16),
        agent: 'claude',
      });
    }
    expect(await names(w)).toEqual(['1-1.used', '1-2.used', '1-3.used']);
    expect(outs.slice(0, 3).every((o) => !o.includes(RSI_AUTO_LABEL))).toBe(true);
  });

  it('并发消费者至多 tickets 个成功(6 个并发 → 恰好 3 个输出、3 行账、3 个占用文件)', async () => {
    const w = await makeCanaryWorld('w5-probe-race-');
    const outs = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((i) =>
        runCanaryPart(
          runEnv(w, fakePort(PROBING), { randomBytes: (k) => new Uint8Array(k).fill(i) }),
        ),
      ),
    );
    expect(outs.filter((o) => o !== '')).toHaveLength(3);
    expect(await ledgerRows(w)).toHaveLength(3);
    expect(await names(w)).toHaveLength(3);
  });

  it('重新 armed(generation 加 1)后旧代的占用文件作废、不计入本代;旧代标记不被重用', async () => {
    const w = await makeCanaryWorld('w5-probe-gen-');
    for (let i = 1; i <= 3; i++) {
      await runCanaryPart(
        runEnv(w, fakePort(PROBING), { randomBytes: (k) => new Uint8Array(k).fill(i) }),
      );
    }
    const gen2: PortState = { admission: ok(adm(probing({ generation: 2 }))) };
    const out = await runCanaryPart(
      runEnv(w, fakePort(gen2), { randomBytes: (k) => new Uint8Array(k).fill(9) }),
    );
    expect(out).toBe(`${RSI_MARK_PREFIX} rsm_0909090909090909\n`);
    expect(await names(w)).toContain('2-1.used');
    const markers = (await ledgerRows(w)).map((r) => r['marker']);
    expect(new Set(markers).size).toBe(markers.length);
  });

  it('②之后崩溃的等价情形:账行追加失败 → 票已用、不输出(绝不重复授予)', async () => {
    const w = await makeCanaryWorld('w5-probe-crash-');
    await breakLedger(w);
    const out = await runCanaryPart(runEnv(w, fakePort(PROBING)));
    expect(out).toBe('');
    expect(await names(w)).toEqual(['1-1.used']);
    // 同一票不会再被授予:再来一次占的是下一张
    await runCanaryPart(runEnv(w, fakePort(PROBING)));
    expect(await names(w)).toEqual(['1-1.used', '1-2.used']);
  });

  it('①之前失败(取标记字节失败)→ 不消费票、不落账、不创建票目录', async () => {
    const w = await makeCanaryWorld('w5-probe-nobytes-');
    const out = await runCanaryPart(
      runEnv(w, fakePort(PROBING), {
        randomBytes: () => {
          throw new Error('bytes');
        },
      }),
    );
    expect(out).toBe('');
    expect(await exists(path.join(w.rsi, 'canary-probe'))).toBe(false);
    expect(await exists(path.join(w.rsi, 'canary-ledger.jsonl'))).toBe(false);
  });

  it('预算已用尽 → 不消费票', async () => {
    const w = await makeCanaryWorld('w5-probe-over-');
    expect(await runCanaryPart(runEnv(w, fakePort(PROBING), { over: () => true }))).toBe('');
    expect(await exists(path.join(w.rsi, 'canary-probe'))).toBe(false);
  });

  it('探针只在 AUTO_PAUSE 不存在时:AUTO_PAUSE 在场 → 不消费票', async () => {
    const w = await makeCanaryWorld('w5-probe-pause-');
    expect(await runCanaryPart(runEnv(w, fakePort({ ...PROBING, pause: 'present' })))).toBe('');
    expect(await exists(path.join(w.rsi, 'canary-probe'))).toBe(false);
  });
});
