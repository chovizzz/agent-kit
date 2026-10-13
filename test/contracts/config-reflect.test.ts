import { describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import {
  KitConfigSchema,
  OverlaySchema,
  ReflectCoreConfigSchema,
  ReflectOverlaySchema,
} from '../../src/contracts/index.js';
import { readText } from '../../src/io/read-fs.js';

const KIT_TOML = new URL('../../kit.toml', import.meta.url).pathname;
const parseReflect = (v: unknown) => ReflectOverlaySchema.safeParse(v);

describe('R0-5 reflect 配置', () => {
  it('旧 kit.toml 与旧覆盖层仍有效(reflect 段整体可选,不出现在解析结果里)', async () => {
    const kit = KitConfigSchema.safeParse(parseToml(await readText(KIT_TOML)));
    expect(kit.success, kit.success ? '' : JSON.stringify(kit.error.issues)).toBe(true);
    if (kit.success) expect(kit.data.reflect).toBeUndefined();
    const ov = OverlaySchema.safeParse({ channel: 'canary' });
    expect(ov.success).toBe(true);
    if (ov.success) expect(ov.data.reflect).toBeUndefined();
  });

  it('默认值:max_proposals=5、max_calls=1、timeout_ms=180000、reset_tz=UTC、egress=false、无后端无覆盖', () => {
    const r = ReflectOverlaySchema.parse({});
    expect(r).toEqual({
      max_proposals: 5,
      max_calls: 1,
      timeout_ms: 180_000,
      reset_tz: 'UTC',
      backends: [],
      vendor_overrides: {},
      egress: false,
    });
    expect(ReflectCoreConfigSchema.parse({})).toEqual({
      max_proposals: 5,
      max_calls: 1,
      timeout_ms: 180_000,
    });
  });

  it('上下限:max_proposals ≤5、max_calls ≤3、timeout_ms 1000..600000', () => {
    expect(parseReflect({ max_proposals: 5, max_calls: 3, timeout_ms: 600_000 }).success).toBe(
      true,
    );
    expect(parseReflect({ max_proposals: 6 }).success).toBe(false);
    expect(parseReflect({ max_proposals: 0 }).success).toBe(false);
    expect(parseReflect({ max_calls: 4 }).success).toBe(false);
    expect(parseReflect({ max_calls: 0 }).success).toBe(false);
    expect(parseReflect({ timeout_ms: 999 }).success).toBe(false);
    expect(parseReflect({ timeout_ms: 600_001 }).success).toBe(false);
    expect(parseReflect({ max_calls: 1.5 }).success).toBe(false);
  });

  it('kit.toml(core)里的 reflect 只有通用上限;egress / 后端绑定 / 厂商覆盖在 core 里被拒', () => {
    const base = {
      kit: { name: 'x', version: '0.1.0' },
      agents: { enabled: ['claude'] },
      budget: {},
      channels: {},
    };
    expect(KitConfigSchema.safeParse({ ...base, reflect: { max_calls: 2 } }).success).toBe(true);
    for (const extra of [
      { egress: true },
      { backends: [] },
      { vendor_overrides: {} },
      { reset_tz: 'UTC' },
    ]) {
      expect(
        KitConfigSchema.safeParse({ ...base, reflect: extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it('reset_tz:IANA 时区通过,垃圾被拒', () => {
    expect(parseReflect({ reset_tz: 'Asia/Shanghai' }).success).toBe(true);
    expect(parseReflect({ reset_tz: 'America/New_York' }).success).toBe(true);
    expect(parseReflect({ reset_tz: 'Mars/Base' }).success).toBe(false);
    expect(parseReflect({ reset_tz: '' }).success).toBe(false);
  });

  it('后端绑定:槽位必须是兜底链枚举;cli 枚举;provider/model 不能以 - 开头;不能有 vendor 字段', () => {
    const ok = { slot: 'glm', cli: 'pi', provider: 'zai', model: 'glm-5.3-flash' };
    expect(parseReflect({ backends: [ok] }).success).toBe(true);
    expect(parseReflect({ backends: [{ slot: 'codex', cli: 'codex' }] }).success).toBe(true);
    expect(parseReflect({ backends: [{ ...ok, slot: 'my-private' }] }).success).toBe(false);
    expect(parseReflect({ backends: [{ ...ok, cli: 'curl' }] }).success).toBe(false);
    expect(parseReflect({ backends: [{ ...ok, model: '--yolo' }] }).success).toBe(false);
    expect(parseReflect({ backends: [{ ...ok, provider: '-x' }] }).success).toBe(false);
    expect(parseReflect({ backends: [{ ...ok, model: 'a b' }] }).success).toBe(false);
    expect(parseReflect({ backends: [{ ...ok, vendor: 'openai' }] }).success).toBe(false);
    expect(parseReflect({ backends: [ok, ok] }).success).toBe(false);
  });

  it('vendor_overrides:追加新家族通过;覆盖内置 → CFG_VENDOR_OVERRIDE_DENIED', () => {
    expect(parseReflect({ vendor_overrides: { mistral: 'mistral-ai' } }).success).toBe(true);
    for (const ov of [
      { claude: 'openai' },
      { gpt: 'gpt' },
      { newfam: 'anthropic' },
      { newfam: 'unknown' },
    ]) {
      const r = parseReflect({ vendor_overrides: ov });
      expect(r.success, JSON.stringify(ov)).toBe(false);
      if (!r.success) {
        expect(JSON.stringify(r.error.issues)).toContain('CFG_VENDOR_OVERRIDE_DENIED');
      }
    }
  });

  it('未知字段被拒(strict);egress 必须是布尔', () => {
    expect(parseReflect({ allow_everything: true }).success).toBe(false);
    expect(parseReflect({ egress: 'yes' }).success).toBe(false);
    expect(parseReflect({ egress: true }).success).toBe(true);
  });

  it('经 OverlaySchema 整体解析(覆盖层路径)', () => {
    const r = OverlaySchema.safeParse({
      reflect: {
        backends: [{ slot: 'kimi', cli: 'pi', provider: 'kimi-coding', model: 'kimi-for-coding' }],
      },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.reflect?.egress).toBe(false);
  });
});
