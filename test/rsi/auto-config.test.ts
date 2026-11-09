/**
 * §21 W0-9:L-base 放行 `auto` / `capability` / `contrib` 三个表,L-auto 单独解析(docs/contracts.md R21-2.1 / R21-2.2)。
 * 每条不变量一个负向用例 + 正向对照;变异见 `v1-w0-mutation-table.ts`。
 */
import { describe, expect, it } from 'vitest';
import { RSI_AUTO_PHASE } from '../../src/contracts/rsi.js';
import { isAutoLoopEffective, resolveAutoConfig } from '../../src/rsi/auto-config.js';
import { loadRsiConfig, type RsiConfig } from '../../src/rsi/config.js';
import { makeRsiFx, rsiToml, writeCfg, type RsiFx } from './rsi-fixture.js';

async function loadWith(f: RsiFx, tables: string): Promise<RsiConfig> {
  await writeCfg(f, `${rsiToml(f)}${tables}`);
  return loadRsiConfig({ home: f.home });
}

describe('R21-2.1 L-base 放行 auto / capability / contrib 表', () => {
  it('R21-2.1 [rsi.auto] 写错一个键:`[rsi]` 仍是 on(不连累整个 [rsi] 变 off),只有 L-auto 判 invalid', async () => {
    const f = await makeRsiFx('auto-badkey-');
    const cfg = await loadWith(f, '\n[rsi.auto]\nenabled = true\nmystery = 1\n');
    expect(cfg.status).toBe('on');
    expect(resolveAutoConfig(cfg)).toEqual({ status: 'invalid' });
  });

  it('R21-2.1 [rsi.auto] 合法 → ok,缺省值:enabled=false / profile=medium(有效档 lite)/ exec=off', async () => {
    const f = await makeRsiFx('auto-ok-');
    const empty = await loadWith(f, '\n[rsi.auto]\n');
    expect(resolveAutoConfig(empty)).toEqual({
      status: 'ok',
      enabled: false,
      profile: 'medium',
      profile_effective: 'lite',
      exec: 'off',
    });
    const full = await loadWith(
      f,
      '\n[rsi.auto]\nenabled = true\nprofile = "heavy"\nexec = "host_after_trial"\n',
    );
    expect(resolveAutoConfig(full)).toEqual({
      status: 'ok',
      enabled: true,
      profile: 'heavy',
      profile_effective: 'lite',
      exec: 'host_after_trial',
    });
  });

  it('R21-2.1 字符串 "true" 在 L-auto 失败(不是 L-base),取值越界同样 invalid', async () => {
    const f = await makeRsiFx('auto-string-');
    for (const body of [
      'enabled = "true"\n',
      'profile = "extreme"\n',
      'exec = "always"\n',
      'enabled = 1\n',
    ]) {
      const cfg = await loadWith(f, `\n[rsi.auto]\n${body}`);
      expect(cfg.status, body).toBe('on');
      expect(resolveAutoConfig(cfg), body).toEqual({ status: 'invalid' });
    }
  });

  it('R21-2.1 没有 [rsi.auto] 表 / [rsi] 不可用 → absent;既有配置的结果形状不变(没有 auto 键)', async () => {
    const f = await makeRsiFx('auto-absent-');
    const cfg = await loadWith(f, '');
    expect(cfg.status).toBe('on');
    expect('auto' in cfg).toBe(false);
    expect('capability' in cfg).toBe(false);
    expect('contrib' in cfg).toBe(false);
    expect(resolveAutoConfig(cfg)).toEqual({ status: 'absent' });
    expect(resolveAutoConfig({ status: 'off', reason: 'disabled' })).toEqual({ status: 'absent' });
  });

  it('R21-2.1 capability / contrib 表被放行并原样保存(内容留给 V5 / V4 的 L-cap / L-contrib)', async () => {
    const f = await makeRsiFx('auto-cap-');
    const cfg = await loadWith(
      f,
      '\n[rsi.capability]\nallow_publishers = ["x"]\n[rsi.contrib]\nfork_owner = "me"\n',
    );
    expect(cfg.status).toBe('on');
    if (cfg.status === 'on') {
      expect(cfg.capability).toEqual({ allow_publishers: ['x'] });
      expect(cfg.contrib).toEqual({ fork_owner: 'me' });
    }
  });
});

describe('R21-2.2 开启自动循环的有效条件(四合一;相位经注入)', () => {
  const ok = {
    status: 'ok',
    enabled: true,
    profile: 'medium',
    profile_effective: 'lite',
    exec: 'off',
  } as const;

  it('R21-2.2 W0 相位为 0:任何配置下自动循环都无效(变异:提前把相位当 1 → 红)', () => {
    expect(RSI_AUTO_PHASE).toBe(0);
    expect(isAutoLoopEffective(true, ok)).toBe(false);
  });

  it('R21-2.2 四个条件缺一不可;相位到 V1a(1)且其余满足才有效', () => {
    expect(isAutoLoopEffective(true, ok, 1)).toBe(true);
    expect(isAutoLoopEffective(true, ok, 2)).toBe(true);
    expect(isAutoLoopEffective(false, ok, 1)).toBe(false); // 未 confirmed
    expect(isAutoLoopEffective(true, { ...ok, enabled: false }, 1)).toBe(false);
    expect(isAutoLoopEffective(true, { status: 'invalid' }, 1)).toBe(false);
    expect(isAutoLoopEffective(true, { status: 'absent' }, 1)).toBe(false);
  });
});
