/**
 * N4 ⑤:唯一控制终端出口(docs/contracts.md R20-18.5 / R20-18.6 / R20-18.25)。终端是注入的假终端,不真开控制终端;
 * `openControlTty` 在无控制终端的环境里返回 undefined(javis 的非交互 ssh 即是),本机交互环境不断言其取值。
 */
import { describe, expect, it } from 'vitest';
import {
  TYPED_LINE_MAX_BYTES,
  TYPED_LINE_TIMEOUT_MS,
  foldTyped,
  readProof,
  runTypedConfirmation,
  type TtyConfirmedProof,
} from '../../src/io/tty.js';
import { BUILTIN_VENDORS } from '../../src/contracts/vendor.js';
import { FakeTty } from '../judge/ingest/fixtures.js';

const spec = (over: Partial<Parameters<typeof runTypedConfirmation>[2]> = {}) => ({
  screen: 'SCREEN\n',
  expectJudgeVendor: 'openai' as string | undefined,
  reflector: undefined,
  fingerprint: 'fp-1',
  ...over,
});

describe('foldTyped:比对规则(R20-18.6 第 2 步)', () => {
  it('去行尾 / 首尾 ASCII 空白、ASCII 大写折小写', () => {
    expect(foldTyped('OpenAI\n')).toBe('openai');
    expect(foldTyped('  openai \r\n')).toBe('openai');
    expect(foldTyped('\topenai\t')).toBe('openai');
  });
  it('空 / 含非 ASCII / 含控制字符 / 内部控制字符 → undefined(不「宽松修复」)', () => {
    for (const bad of ['', '   ', 'оpenai', 'open\u0000ai', 'open\u001bai', 'open​ai', ' openai']) {
      expect(foldTyped(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe('runTypedConfirmation', () => {
  it('铸造令牌后,内容(键入的值、时刻、指纹)只能经 readProof 读出;展示屏写到句柄', async () => {
    const tty = new FakeTty(['OpenAI']);
    const r = await runTypedConfirmation(tty, tty.handle, spec());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(readProof(r.proof)).toEqual({
      judgeVendor: 'openai',
      reflector: { kind: 'not_asked' },
      confirmedAt: '2026-10-14T05:41:00Z',
      fingerprint: 'fp-1',
    });
    expect(tty.writes[0]).toBe('SCREEN\n');
    expect(tty.reads).toEqual([TYPED_LINE_TIMEOUT_MS]);
    expect(TYPED_LINE_MAX_BYTES).toBe(128);
  });
  it('反思器侧:厂商 + 模型串(规范化);空行仅在 allowSkip 时 = 跳过;非内置厂商 / 非法模型串 → invalid', async () => {
    const rs = { prompt: 'p', allowSkip: true, choices: BUILTIN_VENDORS };
    const typed = new FakeTty(['openai', 'Anthropic', 'Claude-Example']);
    const a = await runTypedConfirmation(typed, typed.handle, spec({ reflector: rs }));
    expect(a.ok && readProof(a.proof)?.reflector).toEqual({
      kind: 'typed',
      vendor: 'anthropic',
      model: 'claude-example',
    });
    const skipped = new FakeTty(['openai', '']);
    const b = await runTypedConfirmation(skipped, skipped.handle, spec({ reflector: rs }));
    expect(b.ok && readProof(b.proof)?.reflector).toEqual({ kind: 'skipped' });
    const noSkip = new FakeTty(['openai', '']);
    expect(
      await runTypedConfirmation(
        noSkip,
        noSkip.handle,
        spec({ reflector: { ...rs, allowSkip: false } }),
      ),
    ).toEqual({ ok: false, reason: 'invalid' });
    for (const [v, m] of [
      ['acme', 'm'],
      ['unknown', 'm'],
      ['anthropic', ''],
      ['anthropic', 'Has Space'],
      ['anthropic', 'x'.repeat(65)],
    ] as const) {
      const t = new FakeTty(['openai', v, m]);
      expect(await runTypedConfirmation(t, t.handle, spec({ reflector: rs })), `${v}|${m}`).toEqual(
        { ok: false, reason: 'invalid' },
      );
    }
  });
  it('--confirm-reflector 形态:不问裁判侧(expectJudgeVendor = undefined)', async () => {
    const t = new FakeTty(['anthropic', 'claude-x']);
    const r = await runTypedConfirmation(
      t,
      t.handle,
      spec({
        expectJudgeVendor: undefined,
        reflector: { prompt: 'p', allowSkip: false, choices: BUILTIN_VENDORS },
      }),
    );
    expect(r.ok && readProof(r.proof)).toMatchObject({
      judgeVendor: undefined,
      reflector: { kind: 'typed', vendor: 'anthropic' },
    });
  });
  it('写终端失败 → tty_write_failed(不继续读输入)', async () => {
    const t = new FakeTty(['openai']);
    t.write = () => {
      throw new Error('EIO');
    };
    expect(await runTypedConfirmation(t, t.handle, spec())).toEqual({
      ok: false,
      reason: 'tty_write_failed',
    });
    expect(t.reads).toEqual([]);
  });
});

describe('R20-18.25 TtyConfirmedProof 不可伪造', () => {
  it('运行期:手写对象 / 展开拷贝 / JSON 往返 / null 都读不出内容', async () => {
    const t = new FakeTty(['openai']);
    const r = await runTypedConfirmation(t, t.handle, spec());
    if (!r.ok) throw new Error('unreachable');
    expect(readProof(r.proof)).toBeDefined();
    for (const forged of [
      {},
      { ...(r.proof as object) },
      JSON.parse(JSON.stringify(r.proof)),
      null,
      undefined,
      'x',
      1,
      [],
      Object.create(r.proof as object),
    ]) {
      expect(readProof(forged), JSON.stringify(forged)).toBeUndefined();
    }
    expect(Object.isFrozen(r.proof)).toBe(true);
    expect(Object.keys(r.proof as object)).toEqual([]); // 令牌本身不携带任何可被序列化的内容
    expect(JSON.stringify(r.proof)).toBe('{}');
  });
  it('类型层:模块外构造不出 TtyConfirmedProof(tsc 强制,@ts-expect-error 钉住)', () => {
    // @ts-expect-error 品牌 symbol 未导出,对象字面量缺必需属性
    const forged: TtyConfirmedProof = {};
    // @ts-expect-error 同样不能把布尔当令牌
    const bool: TtyConfirmedProof = true;
    expect(readProof(forged)).toBeUndefined();
    expect(readProof(bool)).toBeUndefined();
  });
});
