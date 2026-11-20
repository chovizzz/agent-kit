/**
 * D1b-2:`grantCanary` / `stepAdmission` 的真 `pass: GrowthPass` 形参(I9;owner Q1:这两个汇点取真 pass,`applyEvent` / `runPersonalStep` 走注入端口)。
 * 函数第一条语句检查 pass 的存在与品牌(任何锁断言 / 读写之前):缺 / `null` / 非对象 / 拒绝值 / 强转克隆(无 `minted` 登记)一律拒绝,**零写入、零锁断言、零读**。
 * D1b-2 只验这一层;真实性 / op 绑定 / 一次性由 D2 的 `requireGrowth` 落实。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists } from '../../../src/io/read-fs.js';
import { stepAdmission } from '../../../src/rsi/canary/admission-write.js';
import { grantCanary, type CanaryWriterDeps } from '../../../src/rsi/canary/canary-writer.js';
import { hasSinkPass } from '../../../src/rsi/canary/growth-sinks.js';
import type { RevocationRead } from '../../../src/rsi/personal/candidate-ports.js';
import type { GrowthPass } from '../../../src/rsi/personal/stage/growth.js';
import { rec } from '../personal/transition-fixture.js';
import { MemStore } from '../personal/w3-fixture.js';
import { mintTestPass } from '../stage/growth-fixture.js';
import { BODY, CID, POLICY, SHA, makeCanaryWorld } from '../canary/w5-fixture.js';

const GRANT = {
  candidate_id: CID,
  content_sha256: SHA,
  p_by_agent: { claude: 0.5 },
  agents_inject: ['claude' as const],
  background_fp: '1'.repeat(16),
  background_fp_ex: '2'.repeat(16),
  policy_fp: POLICY,
};

interface Counts {
  rsi: number;
  personal: number;
  revocations: number;
  readAll: number;
  body: number;
}

async function rig(): Promise<{ d: CanaryWriterDeps; c: Counts; rsiDir: string }> {
  const w = await makeCanaryWorld('d1b2-sinks-');
  const store = new MemStore();
  store.put(rec('canary'));
  const c: Counts = { rsi: 0, personal: 0, revocations: 0, readAll: 0, body: 0 };
  const revs: RevocationRead = { kind: 'ok', lines: [] };
  const readAll = store.readAll.bind(store);
  store.readAll = async () => {
    c.readAll++;
    return readAll();
  };
  return {
    rsiDir: w.rsi,
    c,
    d: {
      io: w.io,
      rsiDir: w.rsi,
      locks: {
        rsi: { assertHeld: async () => void c.rsi++ },
        personal: { assertHeld: async () => void c.personal++ },
      },
      revocations: {
        read: async () => {
          c.revocations++;
          return revs;
        },
      },
      store,
      bodyOf: async () => {
        c.body++;
        return BODY;
      },
    },
  };
}

const ZERO: Counts = { rsi: 0, personal: 0, revocations: 0, readAll: 0, body: 0 };

/** 一个真 pass 的字段克隆(对象长得一样,但没有铸造登记) */
async function clonedPass(): Promise<GrowthPass> {
  const real = await mintTestPass('grant');
  return { ...real } as GrowthPass;
}

describe('hasSinkPass:只认铸造登记', () => {
  it('真 pass → true;不消费(连续调用仍为 true)', async () => {
    const p = await mintTestPass('grant');
    expect(hasSinkPass(p)).toBe(true);
    expect(hasSinkPass(p)).toBe(true);
  });

  it('sink_rejects_forged_and_null_pass:null / undefined / 原语 / 空对象 / 拒绝值 / 字段克隆 / 数组 → false,且不抛(isGrowthPass 对 null 会抛,这里必须先挡住)', async () => {
    const forged: unknown[] = [
      null,
      undefined,
      0,
      '',
      'pass',
      true,
      {},
      [],
      { ok: false, code: 'paused' },
      { ok: true },
      await clonedPass(),
      Object.freeze({ rsiNonce: 'x', personalNonce: 'y', gen: 0, op: { cap: 'grant' } }),
    ];
    for (const f of forged) expect(hasSinkPass(f), JSON.stringify(f)).toBe(false);
  });
});

describe('grantCanary:pass 是第一道门', () => {
  it('d1_sinks_refuse_without_pass:缺 / 伪 pass → refused{growth_denied};零锁断言、零读、零正文、canary.json 不存在', async () => {
    const forged: [string, unknown][] = [
      ['undefined', undefined],
      ['null', null],
      ['空对象', {}],
      ['拒绝值', { ok: false, code: 'paused' }],
      ['字段克隆', await clonedPass()],
    ];
    for (const [name, p] of forged) {
      const r = await rig();
      const res = await grantCanary(r.d, GRANT, p as GrowthPass);
      expect(res, name).toEqual({ kind: 'refused', reason: 'growth_denied' });
      expect(r.c, name).toEqual(ZERO);
      expect(await exists(path.join(r.rsiDir, 'canary.json')), name).toBe(false);
    }
  });

  it('正向对照:真 pass → 与改前同一条授予路径(written),锁断言与读都发生', async () => {
    const r = await rig();
    const res = await grantCanary(r.d, GRANT, await mintTestPass('grant'));
    expect(res.kind).toBe('written');
    expect(r.c.rsi).toBeGreaterThan(0);
    expect(r.c.readAll).toBeGreaterThan(0);
    expect(await exists(path.join(r.rsiDir, 'canary.json'))).toBe(true);
  });
});

describe('stepAdmission:pass 是第一道门', () => {
  const inputs = {
    now: new Date('2026-11-10T12:00:00Z'),
    autoLoopEffective: true,
    phase: 2,
    autoPaused: false,
    agents: { claude: undefined, pi: undefined },
    ledger: [],
    markers: { claude: [], pi: [] },
    postAdmissionMultiMarker: { claude: false, pi: false },
  } as unknown as Parameters<typeof stepAdmission>[1];

  it('d1_sinks_refuse_without_pass:缺 / 伪 pass → blocked{growth_denied};零锁断言;准入文件不存在', async () => {
    for (const p of [undefined, null, {}, { ok: false, code: 'paused' }, await clonedPass()]) {
      const r = await rig();
      let asserts = 0;
      const d = {
        io: r.d.io,
        rsiDir: r.rsiDir,
        locks: {
          rsi: { assertHeld: async () => void asserts++ },
          personal: { assertHeld: async () => void asserts++ },
        },
      };
      const res = await stepAdmission(d, inputs, p as unknown as GrowthPass);
      expect(res).toEqual({ kind: 'blocked', why: 'growth_denied' });
      expect(asserts).toBe(0);
      expect(await exists(path.join(r.rsiDir, 'canary-admission.json'))).toBe(false);
    }
  });

  it('正向对照:真 pass → 进入原有路径(锁断言发生)', async () => {
    const r = await rig();
    let asserts = 0;
    const d = {
      io: r.d.io,
      rsiDir: r.rsiDir,
      locks: {
        rsi: { assertHeld: async () => void asserts++ },
        personal: { assertHeld: async () => void asserts++ },
      },
    };
    // 输入只为过类型:判定入参不在本用例的断言范围,锁断言发生在判定之前
    await stepAdmission(d, inputs, await mintTestPass('admission')).catch(() => undefined);
    expect(asserts).toBeGreaterThan(0);
  });
});
