/**
 * W5 分组账(R21-6.4)与 safe-fs 的 `appendFileSynced`、许可读取(R21-6.10):
 * schema 的负向、`O_APPEND` 单行 + fsync、stop 行按 `revocation_ref` 去重、坏账不被追加、许可读取的「读不到 ≠ 不存在」。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RsiCanaryLedgerLine } from '../../../src/contracts/rsi-personal.js';
import { RSI_REVOCATIONS_MAX_BYTES } from '../../../src/contracts/rsi.js';
import { exists, readText } from '../../../src/io/read-fs.js';
import * as safe from '../../../src/io/safe-fs.js';
import { WriteDeniedError } from '../../../src/io/safe-fs.js';
import { revocationRefOf } from '../../../src/rsi/canary/files.js';
import {
  appendLedgerLine,
  appendStopLine,
  ledgerLineText,
  parseLedger,
  readLedger,
} from '../../../src/rsi/canary/ledger.js';
import {
  REVOCATIONS_REL,
  makePermitPort,
  parseRevocations,
} from '../../../src/rsi/canary/permit-read.js';
import { PERSONAL_STATE_FILES, PERSONAL_STATE_REL } from '../../../src/rsi/personal/home-state.js';
import { CID, POLICY, REVOKE, SHA, makeCanaryWorld } from './w5-fixture.js';

const ASSIGN: RsiCanaryLedgerLine = {
  kind: 'assign',
  at: '2026-11-10T12:00:00Z',
  agent: 'claude',
  marker: 'rsm_0123456789abcdef',
  candidate_id: CID,
  arm: 'control',
  reason: null,
  p: 0.5,
  background_fp: '1'.repeat(16),
  background_fp_ex: '2'.repeat(16),
  policy_fp: POLICY,
  case_set_sha256: null,
  overlaps_preset: false,
  hint_version: 1,
  probe_generation: null,
  probe_ticket: null,
};
const STOP = (reason: string, ref: string | null): RsiCanaryLedgerLine =>
  ({
    kind: 'stop',
    at: '2026-11-10T12:00:00Z',
    candidate_id: CID,
    reason,
    revocation_ref: ref,
  }) as RsiCanaryLedgerLine;
const held = { assertHeld: async (): Promise<void> => undefined };

describe('分组账行 schema(R21-6.4)', () => {
  it('合法的 assign / stop 行序列化为单行 JSON + 换行', () => {
    for (const l of [ASSIGN, STOP('vetoed', null), STOP('revocation_reconciled', 'a'.repeat(16))]) {
      const t = ledgerLineText(l);
      expect(t.endsWith('\n')).toBe(true);
      expect(t.slice(0, -1).includes('\n')).toBe(false);
      expect(JSON.parse(t)).toEqual(l);
    }
  });
  const bad: [string, RsiCanaryLedgerLine][] = [
    ['reason=revocation_reconciled 而 revocation_ref 为 null', STOP('revocation_reconciled', null)],
    ['普通 stop 行带 revocation_ref', STOP('vetoed', 'a'.repeat(16))],
    [
      'excluded 行 p 不为 0',
      { ...ASSIGN, arm: 'excluded', reason: 'paused', marker: null, p: 0.5 },
    ],
    ['excluded 行带 marker(非探针)', { ...ASSIGN, arm: 'excluded', reason: 'paused', p: 0 }],
    [
      'admission_probe 行没有 marker',
      {
        ...ASSIGN,
        arm: 'excluded',
        reason: 'admission_probe',
        marker: null,
        candidate_id: null,
        p: 0,
      },
    ],
    [
      'admission_probe 行带 candidate_id',
      { ...ASSIGN, arm: 'excluded', reason: 'admission_probe', p: 0 },
    ],
    ['treat 行 p 为 0', { ...ASSIGN, arm: 'treat', p: 0 }],
    ['treat 行带 reason', { ...ASSIGN, arm: 'treat', reason: 'paused' }],
    ['control 行没有 marker', { ...ASSIGN, marker: null }],
    ['agent 是 codex', { ...ASSIGN, agent: 'codex' } as unknown as RsiCanaryLedgerLine],
    [
      '未知 reason',
      {
        ...ASSIGN,
        arm: 'excluded',
        reason: 'whatever',
        marker: null,
        p: 0,
      } as unknown as RsiCanaryLedgerLine,
    ],
  ];
  it.each(bad)('非法行被拒绝、不落盘:%s', async (_n, line) => {
    expect(() => ledgerLineText(line)).toThrow();
    const w = await makeCanaryWorld('w5-ledger-bad-');
    await expect(appendLedgerLine(w.io, w.rsi, line)).rejects.toThrow();
    expect(await exists(path.join(w.rsi, 'canary-ledger.jsonl'))).toBe(false);
  });
});

describe('appendFileSynced(O_APPEND 单行 + fsync,新增的 safe-fs 原语)', () => {
  it('追加多行、不覆盖;新建文件 0600;写前记审计(含被拒绝的调用)', async () => {
    const w = await makeCanaryWorld('w5-append-');
    const ops: string[] = [];
    const io = { ...w.io, writeAudit: (op: string): void => void ops.push(op) };
    const f = path.join(w.rsi, 'x.jsonl');
    await safe.appendFileSynced(io, f, 'a\n', 0o600);
    await safe.appendFileSynced(io, f, 'b\n', 0o600);
    expect(await readText(f)).toBe('a\nb\n');
    await expect(
      safe.appendFileSynced(io, path.join(w.dir, '..', 'outside.txt'), 'x', 0o600),
    ).rejects.toThrow(WriteDeniedError);
    expect(ops).toEqual(['appendFileSynced', 'appendFileSynced', 'appendFileSynced']);
  });
  it('目标是符号链接 / 硬链接 / 目录 → 拒绝、不写', async () => {
    const w = await makeCanaryWorld('w5-append-deny-');
    const real = path.join(w.rsi, 'real.jsonl');
    await safe.writeFile(w.io, real, 'r\n', { mode: 0o600 });
    const link = path.join(w.rsi, 'link.jsonl');
    await safe.symlink(w.io, real, link);
    await expect(safe.appendFileSynced(w.io, link, 'x\n', 0o600)).rejects.toThrow();
    const hard = path.join(w.rsi, 'hard.jsonl');
    await safe.hardlink(w.io, real, hard);
    await expect(safe.appendFileSynced(w.io, hard, 'x\n', 0o600)).rejects.toThrow();
    await safe.mkdirp(w.io, path.join(w.rsi, 'dir.jsonl'), 0o700);
    await expect(
      safe.appendFileSynced(w.io, path.join(w.rsi, 'dir.jsonl'), 'x\n', 0o600),
    ).rejects.toThrow();
    expect(await readText(real)).toBe('r\n');
  });
});

describe('stop 行与读取(R21-6.4 / R21-9.5)', () => {
  it('同一 revocation_ref 至多一行;不同 ref 各一行;普通 stop 行(ref=null)不去重', async () => {
    const w = await makeCanaryWorld('w5-stop-');
    const a = STOP('revocation_reconciled', 'a'.repeat(16)) as Extract<
      RsiCanaryLedgerLine,
      { kind: 'stop' }
    >;
    expect(await appendStopLine(w.io, w.rsi, held, a)).toBe('appended');
    expect(await appendStopLine(w.io, w.rsi, held, a)).toBe('already_present');
    const b = STOP('revocation_reconciled', 'b'.repeat(16)) as typeof a;
    expect(await appendStopLine(w.io, w.rsi, held, b)).toBe('appended');
    const plain = STOP('vetoed', null) as typeof a;
    expect(await appendStopLine(w.io, w.rsi, held, plain)).toBe('appended');
    expect(await appendStopLine(w.io, w.rsi, held, plain)).toBe('appended');
    const r = await readLedger(w.rsi);
    expect(r.kind === 'ok' ? r.lines.length : -1).toBe(4);
  });
  it('分组账不合规时不在其上追加(抛错、文件逐字节不变)', async () => {
    const w = await makeCanaryWorld('w5-stop-bad-');
    const f = path.join(w.rsi, 'canary-ledger.jsonl');
    await safe.writeFile(w.io, f, 'not json\n', { mode: 0o600 });
    const a = STOP('revocation_reconciled', 'a'.repeat(16)) as Extract<
      RsiCanaryLedgerLine,
      { kind: 'stop' }
    >;
    await expect(appendStopLine(w.io, w.rsi, held, a)).rejects.toThrow(/invalid_ledger/);
    expect(await readText(f)).toBe('not json\n');
  });
  it('丢锁(assertHeld 抛错)→ 不写', async () => {
    const w = await makeCanaryWorld('w5-stop-lock-');
    const lost = {
      assertHeld: async (): Promise<void> => {
        throw new Error('lock_lost');
      },
    };
    const a = STOP('vetoed', null) as Extract<RsiCanaryLedgerLine, { kind: 'stop' }>;
    await expect(appendStopLine(w.io, w.rsi, lost, a)).rejects.toThrow('lock_lost');
    expect(await exists(path.join(w.rsi, 'canary-ledger.jsonl'))).toBe(false);
  });
  it('revocationRefOf 与 W3 对账证据同算法:sha256(canonicalJson(行)) 前 16 位', () => {
    expect(revocationRefOf(REVOKE())).toMatch(/^[0-9a-f]{16}$/);
    expect(revocationRefOf(REVOKE())).not.toBe(revocationRefOf(REVOKE(CID, SHA, 'tainted')));
  });
  it('parseLedger:缺尾换行 / 空行 / 坏 JSON / 坏 schema 都是 invalid;空文本是空账', () => {
    const good = ledgerLineText(ASSIGN);
    expect(parseLedger('')).toEqual({ kind: 'ok', lines: [] });
    expect(parseLedger(good).kind).toBe('ok');
    expect(parseLedger(good.slice(0, -1)).kind).toBe('invalid');
    expect(parseLedger(`${good}\n`).kind).toBe('invalid');
    expect(parseLedger('{}\n').kind).toBe('invalid');
  });
});

describe('许可读取(R21-6.10):读不到 ≠ 不存在', () => {
  it('撤销凭据位置与 home-state 的常量一致', () => {
    expect(REVOCATIONS_REL).toBe(`${PERSONAL_STATE_REL}/${PERSONAL_STATE_FILES.revocations}`);
  });
  it('四个输入各自三态:不存在 → absent;存在且合法 → ok;损坏 → unreadable', async () => {
    const w = await makeCanaryWorld('w5-permit-');
    const port = makePermitPort(w.rsi, w.home);
    expect(await port.pause()).toBe('absent');
    expect((await port.admission()).kind).toBe('absent');
    expect((await port.canary()).kind).toBe('absent');
    expect((await port.revocations()).kind).toBe('absent');
    await safe.writeFile(w.io, path.join(w.rsi, 'AUTO_PAUSE'), '', { mode: 0o600 });
    expect(await port.pause()).toBe('present');
    await safe.writeFile(w.io, path.join(w.rsi, 'canary.json'), '{bad', { mode: 0o600 });
    expect((await port.canary()).kind).toBe('unreadable');
    await safe.writeFile(
      w.io,
      path.join(w.rsi, 'canary-admission.json'),
      '{"schema_version":1,"agents":{"claude":{}}}',
      { mode: 0o600 },
    );
    expect((await port.admission()).kind).toBe('unreadable');
  });
  it('撤销凭据:合法行 ok;超过 1MiB → unreadable(不是「没有撤销」);坏行 → unreadable', async () => {
    const w = await makeCanaryWorld('w5-permit-rev-');
    const file = path.join(w.home, ...REVOCATIONS_REL.split('/'));
    await safe.mkdirp(w.io, path.dirname(file), 0o700);
    const port = makePermitPort(w.rsi, w.home);
    await safe.writeFile(w.io, file, `${JSON.stringify(REVOKE())}\n`, { mode: 0o600 });
    const ok = await port.revocations();
    expect(ok.kind === 'ok' ? ok.value.map((l) => l.candidate_id) : null).toEqual([CID]);
    // 全部是合法行、仅总长超过 1MiB:必须按读取失败处理(不是「没有撤销」,也不是「读一部分」)
    const one = `${JSON.stringify(REVOKE())}\n`;
    const big = one.repeat(Math.ceil(RSI_REVOCATIONS_MAX_BYTES / one.length) + 1);
    expect(Buffer.byteLength(big, 'utf8')).toBeGreaterThan(RSI_REVOCATIONS_MAX_BYTES);
    await safe.writeFile(w.io, file, big, { mode: 0o600 });
    expect((await port.revocations()).kind).toBe('unreadable');
    await safe.writeFile(w.io, file, '{"at":1}\n', { mode: 0o600 });
    expect((await port.revocations()).kind).toBe('unreadable');
    expect(parseRevocations('').kind).toBe('ok');
    expect(parseRevocations(JSON.stringify(REVOKE())).kind).toBe('unreadable');
  });
});
