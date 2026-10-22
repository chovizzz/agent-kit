/**
 * S5:每个 Dxx 的 ok / 非 ok 两个夹具(夹具矩阵),并断言「检查清单 == 夹具覆盖清单」。
 * 全部在 KIT_TMP 内的假 HOME 上;D01 / D11 经注入,其余用真实磁盘状态。
 */
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCTOR_CHECK_IDS } from '../../src/contracts/doctor.js';
import * as safe from '../../src/io/safe-fs.js';
import {
  CODEX_MD,
  PI_MD,
  SHARED,
  SKILL,
  STATE_PREFIX,
  checkOf,
  chmodRel,
  fakeInstall,
  installed,
  newWorld,
  runDoctor,
  stdFixture,
  writeUpdateState,
  type JsonCheck,
  type RunOpts,
  type World,
} from './world.js';

interface Fixture {
  id: string;
  kind: 'ok' | 'bad';
  name: string;
  /** 建世界;返回 [world, 运行选项] */
  build(): Promise<[World, RunOpts?]>;
  expect: { status: string; result: string };
}

const TESTED_ALL = { claude: 1, codex: 1, pi: 1, kimi: 0, opencode: 0 };

async function cleanWorld(label: string, withPayload = true): Promise<World> {
  const w = await newWorld(label);
  if (withPayload) await w.setPayload(stdFixture());
  return w;
}

/** 没有 claude 规则的 payload(D09 的 ok:claude 用户级 rules 是否加载是 assumed,会让结果变 assumed) */
async function noClaudeWorld(label: string): Promise<World> {
  const w = await newWorld(label);
  await w.setPayload(stdFixture().filter((f) => f.agent !== 'claude'));
  return w;
}

const goodState = (v = '0.2.0') => ({
  schema_version: 1,
  last_check_at: '2026-10-13T00:00:00.000Z',
  last_result: 'up_to_date',
  latest_seen: v,
  max_seen_version: v,
  installed: { version: v, anchor: 'a'.repeat(64), installed_at: '2026-10-01T00:00:00.000Z' },
});

export const FIXTURES: Fixture[] = [
  // D01
  {
    id: 'D01',
    kind: 'ok',
    name: 'node>=22,启动器未安装',
    build: async () => [await cleanWorld('d01-ok-'), { deps: { nodeVersion: '22.4.0' } }],
    expect: { status: 'ok', result: 'ok' },
  },
  {
    id: 'D01',
    kind: 'bad',
    name: 'node 20',
    build: async () => [await cleanWorld('d01-bad-'), { deps: { nodeVersion: '20.11.0' } }],
    expect: { status: 'fail', result: 'node_too_old' },
  },
  // D02
  {
    id: 'D02',
    kind: 'ok',
    name: 'current 逐文件一致且锚点相符',
    build: async () => {
      const w = await cleanWorld('d02-ok-');
      await fakeInstall(w);
      return [w];
    },
    expect: { status: 'ok', result: 'ok' },
  },
  {
    id: 'D02',
    kind: 'bad',
    name: '自洽损坏:文件与 integrity.json 一致,但 integrity.json 自身不等于外部锚点',
    build: async () => {
      const w = await cleanWorld('d02-bad-');
      await fakeInstall(w, { anchor: 'wrong' });
      return [w];
    },
    expect: { status: 'fail', result: 'anchor_mismatch' },
  },
  // D03
  {
    id: 'D03',
    kind: 'ok',
    name: 'payload 完整',
    build: async () => [await cleanWorld('d03-ok-')],
    expect: { status: 'ok', result: 'ok' },
  },
  {
    id: 'D03',
    kind: 'bad',
    name: 'payload 里一个文件被改',
    build: async () => {
      const w = await cleanWorld('d03-bad-');
      const f = path.join(w.payloadRoot, 'payload/files/claude/home', SKILL);
      await safe.writeFile(w.io, f, 'tampered\n');
      return [w];
    },
    expect: { status: 'fail', result: 'payload_invalid' },
  },
  // D04
  {
    id: 'D04',
    kind: 'ok',
    name: '登记表存在且无残留事务',
    build: async () => [await installed('d04-ok-')],
    expect: { status: 'ok', result: 'ok' },
  },
  {
    id: 'D04',
    kind: 'bad',
    name: '登记表损坏',
    build: async () => {
      const w = await installed('d04-bad-');
      await safe.writeFile(w.io, path.join(w.home, STATE_PREFIX, 'sync/ledger.json'), '{not json');
      return [w];
    },
    expect: { status: 'fail', result: 'ledger_invalid' },
  },
  // D05
  {
    id: 'D05',
    kind: 'ok',
    name: '全部条目 ok',
    build: async () => [await installed('d05-ok-')],
    expect: { status: 'ok', result: 'ok' },
  },
  {
    id: 'D05',
    kind: 'bad',
    name: '用户手改了技能文件',
    build: async () => {
      const w = await installed('d05-bad-');
      await w.put(SKILL, '用户改过\n');
      return [w];
    },
    expect: { status: 'fail', result: 'issues' },
  },
  // D06
  {
    id: 'D06',
    kind: 'ok',
    name: '托管块 intact',
    build: async () => [await installed('d06-ok-')],
    expect: { status: 'ok', result: 'ok' },
  },
  {
    id: 'D06',
    kind: 'bad',
    name: '托管块只有 begin',
    build: async () => {
      const w = await installed('d06-bad-');
      await w.put(
        CODEX_MD,
        '<!-- agent-kit:begin id=agent-kit-rules sha256=' + '0'.repeat(64) + ' -->\n半截\n',
      );
      return [w];
    },
    expect: { status: 'fail', result: 'issues' },
  },
  // D07
  {
    id: 'D07',
    kind: 'ok',
    name: '已同步,无待办',
    build: async () => [await installed('d07-ok-')],
    expect: { status: 'ok', result: 'in_sync' },
  },
  {
    id: 'D07',
    kind: 'bad',
    name: '路径中间段是符号链接 → 整次被拒',
    build: async () => {
      const w = await cleanWorld('d07-bad-');
      await safe.symlink(w.io, path.join(w.dir, 'dotfiles'), path.join(w.home, '.claude'));
      return [w];
    },
    expect: { status: 'fail', result: 'blocked' },
  },
  // D08
  {
    id: 'D08',
    kind: 'ok',
    name: '无外来冲突',
    build: async () => [await installed('d08-ok-')],
    expect: { status: 'ok', result: 'ok' },
  },
  {
    id: 'D08',
    kind: 'bad',
    name: '别的管理器占着同名技能',
    build: async () => {
      const w = await cleanWorld('d08-bad-');
      await w.put(SHARED, '别人的技能\n');
      return [w];
    },
    expect: { status: 'fail', result: 'foreign' },
  },
  // D09
  {
    id: 'D09',
    kind: 'ok',
    name: '无遮蔽、无 claude rules',
    build: async () => [await noClaudeWorld('d09-ok-')],
    expect: { status: 'ok', result: 'ok' },
  },
  {
    id: 'D09',
    kind: 'bad',
    name: 'codex 的 AGENTS.override.md 非空',
    build: async () => {
      const w = await noClaudeWorld('d09-bad-');
      await w.put('.codex/AGENTS.override.md', '覆盖\n');
      return [w];
    },
    expect: { status: 'warn', result: 'shadowed' },
  },
  // D10
  {
    id: 'D10',
    kind: 'ok',
    name: '落盘后整文件很小',
    build: async () => [await cleanWorld('d10-ok-')],
    expect: { status: 'ok', result: 'ok' },
  },
  {
    id: 'D10',
    kind: 'bad',
    name: '用户自己的内容 + 托管块 > codex 硬上限 32768',
    build: async () => {
      const w = await cleanWorld('d10-bad-');
      await w.put(CODEX_MD, `${'用户自己的规则。\n'.repeat(1900)}`);
      return [w];
    },
    expect: { status: 'fail', result: 'over' },
  },
  // D11
  {
    id: 'D11',
    kind: 'ok',
    name: '在用的 agent 都有 tested_versions',
    build: async () => [
      await noClaudeWorld('d11-ok-'),
      { deps: { testedVersions: async () => TESTED_ALL } },
    ],
    expect: { status: 'ok', result: 'ok' },
  },
  {
    id: 'D11',
    kind: 'bad',
    name: 'pi 的 tested_versions 为空',
    build: async () => [
      await noClaudeWorld('d11-bad-'),
      { deps: { testedVersions: async () => ({ ...TESTED_ALL, pi: 0 }) } },
    ],
    expect: { status: 'warn', result: 'untested' },
  },
  // D12
  {
    id: 'D12',
    kind: 'ok',
    name: '最近一次检查 up_to_date',
    build: async () => {
      const w = await cleanWorld('d12-ok-');
      await writeUpdateState(w, goodState());
      return [w];
    },
    expect: { status: 'ok', result: 'ok' },
  },
  {
    id: 'D12',
    kind: 'bad',
    name: '最近一次检查 verify_failed',
    build: async () => {
      const w = await cleanWorld('d12-bad-');
      await writeUpdateState(w, { ...goodState(), last_result: 'verify_failed' });
      return [w];
    },
    expect: { status: 'warn', result: 'last_check_failed' },
  },
  // D13
  {
    id: 'D13',
    kind: 'ok',
    name: '恒 n_a',
    build: async () => [await cleanWorld('d13-ok-')],
    expect: { status: 'n_a', result: 'no_hook_rendered' },
  },
  {
    id: 'D13',
    kind: 'bad',
    name: '即使 HOME 里有 hook 设置也恒 n_a(不渲染 hook)',
    build: async () => {
      const w = await cleanWorld('d13-bad-');
      await w.put('.claude/settings.json', '{"hooks":{}}\n', 0o600);
      return [w];
    },
    expect: { status: 'n_a', result: 'no_hook_rendered' },
  },
  // D14
  {
    id: 'D14',
    kind: 'ok',
    name: '状态目录 0700',
    build: async () => {
      const w = await installed('d14-ok-');
      await chmodRel(w, STATE_PREFIX, 0o700);
      return [w];
    },
    expect: { status: 'ok', result: 'ok' },
  },
  {
    id: 'D14',
    kind: 'bad',
    name: '状态目录 0755',
    build: async () => {
      const w = await installed('d14-bad-');
      await chmodRel(w, STATE_PREFIX, 0o755);
      return [w];
    },
    expect: { status: 'fail', result: 'mode_not_0700' },
  },
  // D15
  {
    id: 'D15',
    kind: 'ok',
    name: '覆盖层 egress=false',
    build: async () => {
      const w = await cleanWorld('d15-ok-');
      const ov = path.join(w.dir, 'overlay.toml');
      await safe.writeFile(w.io, ov, '[reflect]\negress = false\n');
      return [w, { overlay: ov }];
    },
    expect: { status: 'ok', result: 'ok' },
  },
  {
    id: 'D15',
    kind: 'bad',
    name: '覆盖层 egress=true',
    build: async () => {
      const w = await cleanWorld('d15-bad-');
      const ov = path.join(w.dir, 'overlay.toml');
      await safe.writeFile(w.io, ov, '[reflect]\negress = true\n');
      return [w, { overlay: ov }];
    },
    expect: { status: 'warn', result: 'egress_on' },
  },
  // D16
  {
    id: 'D16',
    kind: 'ok',
    name: '最近一次自动同步已应用',
    build: async () => {
      const w = await cleanWorld('d16-ok-');
      await writeUpdateState(w, {
        ...goodState(),
        last_auto_sync: {
          at: '2026-10-13T00:00:00.000Z',
          outcome: 'applied',
          txn_id: 'txn-20261013T000000Z-abcdef',
          reasons: [],
          add: 1,
          update: 2,
          remove: 0,
        },
      });
      return [w];
    },
    expect: { status: 'ok', result: 'applied' },
  },
  {
    id: 'D16',
    kind: 'bad',
    name: '最近一次自动同步被拒(drifted)',
    build: async () => {
      const w = await cleanWorld('d16-bad-');
      await writeUpdateState(w, {
        ...goodState(),
        last_auto_sync: {
          at: '2026-10-13T00:00:00.000Z',
          outcome: 'declined',
          reasons: ['drifted'],
          add: 0,
          update: 0,
          remove: 0,
        },
      });
      return [w];
    },
    expect: { status: 'warn', result: 'declined' },
  },
];

describe('doctor:夹具矩阵', () => {
  it('检查清单 == 夹具覆盖清单:每个 Dxx 恰好有 ok 与 bad 两类夹具', () => {
    const covered = new Map<string, Set<string>>();
    for (const f of FIXTURES) {
      const s = covered.get(f.id) ?? new Set<string>();
      s.add(f.kind);
      covered.set(f.id, s);
    }
    expect([...covered.keys()].sort()).toEqual([...DOCTOR_CHECK_IDS].sort());
    for (const id of DOCTOR_CHECK_IDS) {
      expect([...(covered.get(id) ?? [])].sort(), id).toEqual(['bad', 'ok']);
    }
  });

  for (const f of FIXTURES) {
    it(`${f.id} ${f.kind}:${f.name}`, async () => {
      const [w, o] = await f.build();
      const { check } = await checkOf(w, f.id, o ?? {});
      expect({ id: check.id, status: check.status, result: check.result }).toEqual({
        id: f.id,
        status: f.expect.status,
        result: f.expect.result,
      });
      // ok 类夹具不得是 fail
      if (f.kind === 'ok') expect(check.status).not.toBe('fail');
    });
  }
});

describe('doctor:各检查的细节', () => {
  const get = async (w: World, id: string, o: RunOpts = {}): Promise<JsonCheck> =>
    (await checkOf(w, id, o)).check;

  it('D02:current 里的文件被改 → file_mismatch(即使锚点一致)', async () => {
    const w = await cleanWorld('d02-file-');
    await fakeInstall(w, { tamperFile: true });
    const c = await get(w, 'D02');
    expect(c).toMatchObject({ status: 'fail', result: 'file_mismatch' });
    expect(c.counts['mismatch']).toBe(1);
  });

  it('D02:有 current 但 state.json 没有锚点 → anchor_missing;没有 current → n_a', async () => {
    const w = await cleanWorld('d02-noanchor-');
    await fakeInstall(w, { anchor: 'none' });
    expect(await get(w, 'D02')).toMatchObject({ status: 'fail', result: 'anchor_missing' });
    const w2 = await cleanWorld('d02-nocur-');
    expect(await get(w2, 'D02')).toMatchObject({ status: 'n_a', result: 'no_current' });
  });

  it('D02:current 指向 versions/ 之外 → current_unsafe', async () => {
    const w = await cleanWorld('d02-escape-');
    const outside = path.join(w.dir, 'elsewhere');
    await safe.mkdirp(w.io, outside);
    await safe.mkdirp(w.io, path.join(w.home, '.local/share/agent-kit/versions'));
    await safe.symlink(w.io, outside, path.join(w.home, '.local/share/agent-kit/current'));
    expect(await get(w, 'D02')).toMatchObject({ status: 'fail', result: 'current_unsafe' });
  });

  it('D01:启动器状态:安装后 installed;using_current 随 KIT_LAUNCHED', async () => {
    const w = await cleanWorld('d01-launcher-');
    expect((await get(w, 'D01')).facts['launcher']).toBe('not_installed');
    await fakeInstall(w);
    const c = await get(w, 'D01', { env: { KIT_LAUNCHED: '1' } });
    expect(c.facts).toMatchObject({
      launcher: 'installed',
      using_current: true,
      current_version: '0.2.0',
    });
  });

  it('D04:残留事务 → txn_residual,条目给出事务 id', async () => {
    const w = await installed('d04-txn-');
    await w.put(`${STATE_PREFIX}/sync/txn/txn-20261013T000000Z-abcdef.json`, '{}', 0o600);
    const c = await get(w, 'D04');
    expect(c).toMatchObject({ status: 'fail', result: 'txn_residual' });
    expect(c.items).toEqual(['txn-20261013T000000Z-abcdef']);
  });

  it('D04:没有登记表 → not_installed(warn,退出码仍 0 或 1 之外不出现 3)', async () => {
    const w = await cleanWorld('d04-none-');
    expect(await get(w, 'D04')).toMatchObject({ status: 'warn', result: 'not_installed' });
    expect(await get(w, 'D05')).toMatchObject({ status: 'n_a', result: 'no_ledger' });
  });

  it('D07:有新版 payload 时给出 add/update 计数;remove 随 payload 删除', async () => {
    const w = await installed('d07-pending-');
    await w.setPayload(stdFixture('v2'));
    const c = await get(w, 'D07');
    expect(c).toMatchObject({ status: 'warn', result: 'pending' });
    expect(c.counts['update']).toBeGreaterThan(0);
    expect(c.counts['add']).toBe(0);
    // 再去掉 claude 的两个文件 → remove
    await w.setPayload(stdFixture('v2').filter((f) => f.agent !== 'claude'));
    const c2 = await get(w, 'D07');
    expect(c2.counts['remove']).toBe(2);
  });

  it('D07:没有 payload → n_a;D08 同', async () => {
    const w = await cleanWorld('d07-nopayload-', false);
    // 正向控制组:假包根里确实没有 payload;并且 D07 在有 payload 的世界里不是 n_a(断言不会变空)
    const empty = path.join(w.dir, 'empty-pkg');
    await safe.mkdirp(w.io, empty);
    expect(existsSync(path.join(empty, 'payload'))).toBe(false);
    const withPayload = await installed('d07-withpayload-');
    expect((await get(withPayload, 'D07')).status).not.toBe('n_a');
    expect(await get(w, 'D07', { noPayload: true })).toMatchObject({
      status: 'n_a',
      result: 'no_payload',
    });
    expect(await get(w, 'D08', { noPayload: true })).toMatchObject({ status: 'n_a' });
  });

  it('D08:条目 id 是受管相对路径', async () => {
    const w = await cleanWorld('d08-items-');
    await w.put(SHARED, '别人的\n');
    const c = await get(w, 'D08');
    expect(c.items).toEqual([`foreign:~/${SHARED}`]);
    expect(c.counts['foreign']).toBe(1);
  });

  it('D09:pi 的 override、PI_CODING_AGENT_DIR 各自触发遮蔽;只有 claude rules 时 assumed', async () => {
    const w = await noClaudeWorld('d09-pi-');
    await w.put('.pi/agent/AGENTS.override.md', 'x\n');
    const c = await get(w, 'D09', { env: { PI_CODING_AGENT_DIR: '/somewhere' } });
    expect(c.items.sort()).toEqual(['shadowed:pi_agents_override', 'shadowed:pi_coding_agent_dir']);
    const w2 = await cleanWorld('d09-assumed-'); // 含 claude rules
    expect(await get(w2, 'D09')).toMatchObject({ status: 'warn', result: 'assumed' });
    expect((await get(w2, 'D09')).facts['claude_user_rules_loaded']).toBe('assumed');
  });

  it('D09:codex override 为空文件不算遮蔽', async () => {
    const w = await noClaudeWorld('d09-empty-');
    await w.put('.codex/AGENTS.override.md', '');
    expect(await get(w, 'D09')).toMatchObject({ status: 'ok' });
  });

  it('D10:按落盘后整个文件算,而不是只算 payload 块体', async () => {
    const w = await cleanWorld('d10-whole-');
    const user = '用户自己的规则。\n'.repeat(1900);
    await w.put(CODEX_MD, user);
    const c = await get(w, 'D10');
    // 用户内容 + 块 ≥ 用户内容字节数;块体本身只有几十字节
    expect(c.counts['codex_bytes']).toBeGreaterThan(Buffer.byteLength(user));
    expect(c.counts['codex_bytes']).toBeGreaterThan(32768);
    expect(c.facts['codex']).toBe('over_hard_limit');
  });

  it('D10:pi 超 max_bytes 但 hard_limit 未知 → warn,不是 over', async () => {
    const w = await cleanWorld('d10-pi-');
    await w.put(PI_MD, '用户。\n'.repeat(4000));
    const c = await get(w, 'D10');
    expect(c.status).toBe('warn');
    expect(c.facts['pi']).toBe('over_max_bytes');
  });

  it('D10:已安装的文件(块已在)按现状整文件算,幂等', async () => {
    const w = await installed('d10-installed-');
    const a = await get(w, 'D10');
    const b = await get(w, 'D10');
    expect(a).toEqual(b);
    expect(a.counts['codex_bytes']).toBeGreaterThan(0);
  });

  it('D11:payload 里 conditional 的文件个数 = pending_probes', async () => {
    const w = await noClaudeWorld('d11-pending-');
    const c = await get(w, 'D11', { deps: { testedVersions: async () => TESTED_ALL } });
    expect(c.counts['pending_probes']).toBe(0);
    expect(c.facts['payload']).toBe('present');
  });

  it('D12:--online 不可用:D12 标 n_a,退出 4,stderr 只有稳定码', async () => {
    const w = await cleanWorld('d12-online-');
    const r = await runDoctor(w, ['--online', '--json']);
    expect(r.code).toBe(4);
    expect(r.err).toBe('DOCTOR_ONLINE_UNAVAILABLE\n');
    const d12 = (JSON.parse(r.out) as { checks: JsonCheck[] }).checks.find((c) => c.id === 'D12');
    expect(d12).toMatchObject({ status: 'n_a', result: 'online_unavailable' });
    // D12 不在 --only 里时 --online 不影响退出码
    const r2 = await runDoctor(w, ['--online', '--only', 'D13']);
    expect(r2.code).toBe(0);
  });

  it('D12:钉版本 / 镜像 / 关闭开关 / staging 残留 / 锁', async () => {
    const w = await cleanWorld('d12-facts-');
    await writeUpdateState(w, goodState());
    await w.put(
      '.config/agent-kit/config.toml',
      '[update]\nauto_install = false\npin = "~0.2"\nregistry = "https://mirror.example.invalid/"\n',
    );
    await w.put(`${STATE_PREFIX}/update/lock`, '1\n', 0o600);
    await w.put('.local/share/agent-kit/staging/x/f', 'x\n');
    const c = await get(w, 'D12');
    expect(c.facts).toMatchObject({
      auto_update: 'config_off',
      pin: '~0.2',
      registry_mirror: true,
      lock_present: true,
      installed_version: '0.2.0',
      max_seen_version: '0.2.0',
    });
    expect(c.counts['staging']).toBe(1);
    expect(c).toMatchObject({ status: 'warn', result: 'staging_residue' });
  });

  it('D12:有更新版本可用 → update_available', async () => {
    const w = await cleanWorld('d12-avail-');
    await writeUpdateState(w, { ...goodState(), latest_seen: '0.3.0' });
    expect(await get(w, 'D12')).toMatchObject({ status: 'warn', result: 'update_available' });
  });

  it('D15:今日冷却标记计数;昨天的不计,也不被删除', async () => {
    const w = await cleanWorld('d15-cool-');
    const stateDir = path.join(w.dir, 'repo-state');
    const dir = path.join(stateDir, 'llm-cooldown');
    await safe.mkdirp(w.io, dir);
    const day = (d: Date): string => d.toISOString().slice(0, 10).replaceAll('-', '');
    const now = new Date('2026-10-14T12:00:00Z');
    await safe.writeFile(w.io, path.join(dir, `codex-${day(now)}`), '');
    await safe.writeFile(w.io, path.join(dir, 'codex-20261013'), '');
    const c = await get(w, 'D15', { stateDir, deps: { now: () => now } });
    expect(c.counts['cooldown_today']).toBe(1);
    expect(c.items).toEqual(['cooldown:codex']);
    const { exists } = await import('../../src/io/read-fs.js');
    expect(await exists(path.join(dir, 'codex-20261013'))).toBe(true);
  });

  it('D15:allow_unverified 槽位计数', async () => {
    const w = await cleanWorld('d15-unv-');
    const ov = path.join(w.dir, 'overlay.toml');
    await safe.writeFile(
      w.io,
      ov,
      '[reflect]\n[[reflect.backends]]\nslot = "codex"\ncli = "codex"\nallow_unverified = true\n',
    );
    const c = await get(w, 'D15', { overlay: ov });
    expect(c).toMatchObject({ status: 'warn', result: 'allow_unverified' });
    expect(c.counts['allow_unverified_slots']).toBe(1);
  });

  it('D16:declined 带原因码条目', async () => {
    const w = await cleanWorld('d16-items-');
    await writeUpdateState(w, {
      ...goodState(),
      last_auto_sync: {
        at: '2026-10-13T00:00:00.000Z',
        outcome: 'declined',
        reasons: ['drifted', 'too_many_ops'],
        add: 0,
        update: 0,
        remove: 0,
      },
    });
    expect((await get(w, 'D16')).items).toEqual(['reason:drifted', 'reason:too_many_ops']);
  });

  it('fail-closed:状态目录是符号链接 → 退出 3;state.json 损坏 → 退出 3', async () => {
    const w = await cleanWorld('fc-link-');
    const real = path.join(w.dir, 'real-state');
    await safe.mkdirp(w.io, real);
    await safe.mkdirp(w.io, path.join(w.home, '.local/state'));
    await safe.symlink(w.io, real, path.join(w.home, STATE_PREFIX));
    const r = await runDoctor(w, []);
    expect(r.code).toBe(3);
    expect(r.err).toContain('DOCTOR_FAIL_CLOSED reason=state_dir_unsafe\n');
    // 带 --only D05 也不会静默放过
    expect((await runDoctor(w, ['--only', 'D05'])).code).toBe(3);

    const w2 = await installed('fc-state-');
    await w2.put(`${STATE_PREFIX}/update/state.json`, '{bad', 0o600);
    const r2 = await runDoctor(w2, []);
    expect(r2.code).toBe(3);
    expect(r2.err).toContain('DOCTOR_FAIL_CLOSED reason=state_unreadable\n');
  });

  it('退出码:有 fail → 1 且 stderr 逐项给稳定码;全 ok/warn → 0', async () => {
    const w = await installed('exit-');
    await chmodRel(w, STATE_PREFIX, 0o700);
    const ok = await runDoctor(w, ['--only', 'D04', '--only', 'D05']);
    expect(ok.code).toBe(0);
    expect(ok.err).toBe('');
    await w.put(SKILL, '改了\n');
    const bad = await runDoctor(w, ['--only', 'D05']);
    expect(bad.code).toBe(1);
    expect(bad.err).toBe('DOCTOR_CHECK_FAILED check=D05 result=issues\n');
  });

  it('--only D12 --online 遇到不安全状态目录仍是退出 3(不被 online 的 4 盖掉)', async () => {
    const w = await cleanWorld('fc-online-');
    const real = path.join(w.dir, 'real-state2');
    await safe.mkdirp(w.io, real);
    await safe.mkdirp(w.io, path.join(w.home, '.local/state'));
    await safe.symlink(w.io, real, path.join(w.home, STATE_PREFIX));
    const r = await runDoctor(w, ['--only', 'D12', '--online']);
    expect(r.code).toBe(3);
    expect(r.err).toContain('reason=state_dir_unsafe');
  });

  it('D12:last_result 为 http_503 → last_check_failed;http_200 不算失败', async () => {
    const w = await cleanWorld('d12-http-');
    await writeUpdateState(w, { ...goodState(), last_result: 'http_503' });
    expect((await checkOf(w, 'D12')).check).toMatchObject({ result: 'last_check_failed' });
    expect((await checkOf(w, 'D12')).check.facts['last_result']).toBe('http_503');
  });

  it('D11:pending_probes 按带 conditional 的文件个数计(同一探针 id 的两个文件算 2)', async () => {
    const w = await newWorld('d11-cond-');
    await w.setPayload(stdFixture());
    // 在 manifest 里给两个文件写同一个 conditional,并重算 integrity
    const { readText } = await import('../../src/io/read-fs.js');
    const mp = path.join(w.payloadRoot, 'payload/manifest.json');
    const m = JSON.parse(await readText(mp)) as { files: { conditional?: string }[] };
    (m.files[0] as { conditional?: string }).conditional = 'P-Q1';
    (m.files[1] as { conditional?: string }).conditional = 'P-Q1';
    const { canonicalJson } = await import('../../src/io/canonical-json.js');
    const { buildIntegrity } = await import('../../src/build/payload.js');
    const text = canonicalJson(m);
    await safe.writeFile(w.io, mp, text);
    const files = JSON.parse(await readText(path.join(w.payloadRoot, 'integrity.json'))) as {
      files: { path: string }[];
    };
    const entries = [];
    for (const f of files.files) {
      const abs = path.join(w.payloadRoot, ...f.path.split('/'));
      entries.push({
        path: f.path,
        content:
          f.path === 'payload/manifest.json' ? Buffer.from(text) : Buffer.from(await readText(abs)),
      });
    }
    await safe.writeFile(
      w.io,
      path.join(w.payloadRoot, 'integrity.json'),
      buildIntegrity('0.2.0', entries).text,
    );
    const c = (await checkOf(w, 'D11', { deps: { testedVersions: async () => TESTED_ALL } })).check;
    expect(c.counts['pending_probes']).toBe(2);
    expect(c).toMatchObject({ status: 'warn', result: 'pending_probes' });
  });
});
