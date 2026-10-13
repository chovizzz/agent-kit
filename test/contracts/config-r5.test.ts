import { describe, expect, it } from 'vitest';
import {
  KitConfigSchema,
  ReflectBackendBindingSchema,
  ReflectOverlaySchema,
} from '../../src/contracts/index.js';

const BASE_KIT = {
  kit: { name: 'x', version: '0.1.0' },
  agents: { enabled: ['claude'] },
  budget: {},
  channels: {},
};

describe('R5 追加的两个可选配置字段(#29)', () => {
  it('allow_unverified:缺省 = 未设置(视为 false);显式 true/false 通过;非布尔被拒', () => {
    const base = { slot: 'codex', cli: 'codex', model: 'm1' };
    const none = ReflectBackendBindingSchema.parse(base);
    expect(none.allow_unverified).toBeUndefined();
    expect(ReflectBackendBindingSchema.parse({ ...base, allow_unverified: true })).toMatchObject({
      allow_unverified: true,
    });
    expect(ReflectBackendBindingSchema.parse({ ...base, allow_unverified: false })).toMatchObject({
      allow_unverified: false,
    });
    for (const bad of ['true', 1, null]) {
      expect(
        ReflectBackendBindingSchema.safeParse({ ...base, allow_unverified: bad }).success,
      ).toBe(false);
    }
  });

  it('team_project_keys:缺省为空数组(= 全部按 personal 层,fail-closed);只接受非空字符串列表', () => {
    expect(ReflectOverlaySchema.parse({}).team_project_keys).toEqual([]);
    expect(ReflectOverlaySchema.parse({ team_project_keys: ['p_0123456789abcdef'] })).toMatchObject(
      {
        team_project_keys: ['p_0123456789abcdef'],
      },
    );
    expect(ReflectOverlaySchema.safeParse({ team_project_keys: [''] }).success).toBe(false);
    expect(ReflectOverlaySchema.safeParse({ team_project_keys: 'p_x' }).success).toBe(false);
    expect(ReflectOverlaySchema.safeParse({ team_project_keys: [1] }).success).toBe(false);
  });

  it('旧覆盖层(不含这两个字段)仍有效;core(kit.toml)里出现它们仍被拒', () => {
    expect(ReflectOverlaySchema.safeParse({ backends: [{ slot: 'glm', cli: 'pi' }] }).success).toBe(
      true,
    );
    const r = KitConfigSchema.safeParse({
      ...BASE_KIT,
      reflect: { team_project_keys: ['p_x'] },
    });
    expect(r.success).toBe(false);
  });
});
