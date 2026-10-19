import { describe, expect, it } from 'vitest';
import {
  DECISION_CODES,
  DECISION_DETAILS,
  GATE_OFF_REASONS,
  autoUpdateGate,
  checkDue,
  compareSemver,
  decideUpdate,
  mapNetFailure,
  parseHttpDate,
  parseIsoUtc,
  parseSemver,
  readPackument,
  satisfiesPin,
} from '../../src/update/policy.js';
import type { DecideInput, Decision, PackumentView } from '../../src/update/policy.js';

const H = 3_600_000;
const NOW = '2026-10-14T12:00:00.000Z';
const DATE_HDR = 'Wed, 14 Oct 2026 12:00:00 GMT';

function iso(hoursBeforeNow: number): string {
  return new Date(Date.parse(NOW) - hoursBeforeNow * H).toISOString();
}

function view(
  versions: string[],
  tags: Record<string, string>,
  time: Record<string, string>,
  broken: readonly string[] = [],
): PackumentView {
  const v: Record<string, PackumentView['versions'][string]> = {};
  for (const x of versions) {
    const ok = !broken.includes(x);
    v[x] = {
      hasIntegrity: ok,
      hasTarball: true,
      ...(ok ? { integrity: 'sha512-x' } : {}),
      tarball: `https://registry.npmjs.org/@chovizzz/agent-kit/-/agent-kit-${x}.tgz`,
    };
  }
  return { distTags: tags, versions: v, time };
}

/** 基线:已装 0.2.0,latest=0.2.1,发布于 25h 前,冷却期 24h → ok */
function base(over: Partial<DecideInput> = {}, pubHoursAgo = 25): DecideInput {
  const v = view(['0.2.0', '0.2.1'], { latest: '0.2.1' }, { '0.2.1': iso(pubHoursAgo) });
  return {
    installed: '0.2.0',
    badVersions: [],
    channel: 'latest',
    allowMajor: false,
    mirror: false,
    primary: v,
    npmjs: { kind: 'ok', view: v, dateHeader: DATE_HDR },
    ...over,
  };
}

function withNpmjs(
  v: PackumentView,
  dateHeader: string | null = DATE_HDR,
): Pick<DecideInput, 'primary' | 'npmjs'> {
  return { primary: v, npmjs: { kind: 'ok', view: v, dateHeader: dateHeader ?? undefined } };
}

interface Case {
  name: string;
  input: DecideInput;
  expect: { code: Decision['code']; detail?: Decision['detail']; version?: string };
}

const CASES: Case[] = [
  { name: '基线:发布 25h、冷却 24h → ok', input: base(), expect: { code: 'ok', version: '0.2.1' } },
  { name: '冷却期边界:恰好 24h00 → ok', input: base({}, 24), expect: { code: 'ok' } },
  {
    name: '冷却期边界:23h59 → cooldown',
    input: base({}, 24 - 1 / 60),
    expect: { code: 'cooldown', detail: 'not_elapsed' },
  },
  {
    name: '冷却期:自定义 48h,25h 的版本 → cooldown',
    input: base({ cooldownHours: 48 }),
    expect: { code: 'cooldown', detail: 'not_elapsed' },
  },
  {
    name: '--now 跳过冷却期',
    input: base({ skipCooldown: true }, 1),
    expect: { code: 'ok' },
  },
  {
    name: '--now 只跳过冷却期,降级照拒',
    input: base({ skipCooldown: true, installed: '0.3.0' }, 1),
    expect: { code: 'downgrade_refused' },
  },
  {
    name: '缺 Date 头 → cooldown',
    input: {
      ...base(),
      ...withNpmjs(view(['0.2.0', '0.2.1'], { latest: '0.2.1' }, { '0.2.1': iso(99) }), null),
    },
    expect: { code: 'cooldown', detail: 'date_header_missing' },
  },
  {
    name: 'Date 头不可解析 → cooldown',
    input: {
      ...base(),
      ...withNpmjs(
        view(['0.2.0', '0.2.1'], { latest: '0.2.1' }, { '0.2.1': iso(99) }),
        'yesterday',
      ),
    },
    expect: { code: 'cooldown', detail: 'date_header_unparseable' },
  },
  {
    name: 'time[v] 缺失 → cooldown',
    input: { ...base(), ...withNpmjs(view(['0.2.0', '0.2.1'], { latest: '0.2.1' }, {})) },
    expect: { code: 'cooldown', detail: 'time_missing' },
  },
  {
    name: 'time[v] 不可解析 → cooldown',
    input: {
      ...base(),
      ...withNpmjs(view(['0.2.0', '0.2.1'], { latest: '0.2.1' }, { '0.2.1': 'not-a-date' })),
    },
    expect: { code: 'cooldown', detail: 'time_unparseable' },
  },
  {
    name: '发布时间在 Date 头之后(负 age)→ cooldown',
    input: base({}, -5),
    expect: { code: 'cooldown', detail: 'negative_age' },
  },
  {
    name: '同 major 内允许(0.2.0 → 0.3.0,0.x 的 minor 视为同 major)',
    input: {
      ...base(),
      ...withNpmjs(view(['0.2.0', '0.3.0'], { latest: '0.3.0' }, { '0.3.0': iso(99) })),
    },
    expect: { code: 'ok', version: '0.3.0' },
  },
  {
    name: '跨 major 默认拒 → major_available',
    input: {
      ...base(),
      ...withNpmjs(view(['0.2.0', '1.0.0'], { latest: '1.0.0' }, { '1.0.0': iso(99) })),
    },
    expect: { code: 'major_available', version: '1.0.0' },
  },
  {
    name: '--major 放行跨 major',
    input: {
      ...base({ allowMajor: true }),
      ...withNpmjs(view(['0.2.0', '1.0.0'], { latest: '1.0.0' }, { '1.0.0': iso(99) })),
    },
    expect: { code: 'ok', version: '1.0.0' },
  },
  {
    name: '--major 放行后冷却期照旧',
    input: {
      ...base({ allowMajor: true }),
      ...withNpmjs(view(['0.2.0', '1.0.0'], { latest: '1.0.0' }, { '1.0.0': iso(2) })),
    },
    expect: { code: 'cooldown', detail: 'not_elapsed' },
  },
  {
    name: '已是最新 → up_to_date',
    input: base({ installed: '0.2.1' }),
    expect: { code: 'up_to_date' },
  },
  {
    name: 'registry 给出更低的 latest → downgrade_refused',
    input: base({ installed: '0.2.5' }),
    expect: { code: 'downgrade_refused', version: '0.2.1' },
  },
  {
    name: '低于 max_seen(回滚之后)→ downgrade_refused',
    input: base({ installed: '0.2.0', maxSeen: '0.2.7' }),
    expect: { code: 'downgrade_refused' },
  },
  {
    name: '预发布之间的降级(rc.1 → rc.0)→ downgrade_refused',
    input: {
      ...base({ installed: '0.2.0-rc.1', channel: 'rc' }),
      ...withNpmjs(view(['0.2.0-rc.0'], { rc: '0.2.0-rc.0' }, { '0.2.0-rc.0': iso(99) })),
    },
    expect: { code: 'downgrade_refused' },
  },
  {
    name: 'latest 指向预发布 → not_ready(预发布不进 latest 通道)',
    input: {
      ...base(),
      ...withNpmjs(
        view(['0.2.0', '0.3.0-rc.0'], { latest: '0.3.0-rc.0' }, { '0.3.0-rc.0': iso(99) }),
      ),
    },
    expect: { code: 'not_ready', detail: 'prerelease_on_latest' },
  },
  {
    name: 'rc 通道允许预发布',
    input: {
      ...base({ channel: 'rc' }),
      ...withNpmjs(view(['0.2.0', '0.3.0-rc.0'], { rc: '0.3.0-rc.0' }, { '0.3.0-rc.0': iso(99) })),
    },
    expect: { code: 'ok', version: '0.3.0-rc.0' },
  },
  {
    name: '预发布 → 其正式版(0.1.0-rc.0 → 0.1.0)允许',
    input: {
      ...base({ installed: '0.1.0-rc.0' }),
      ...withNpmjs(view(['0.1.0-rc.0', '0.1.0'], { latest: '0.1.0' }, { '0.1.0': iso(99) })),
    },
    expect: { code: 'ok', version: '0.1.0' },
  },
  {
    name: 'bad_versions 里的版本不装 → verify_failed/bad_version',
    input: base({ badVersions: ['0.2.1'] }),
    expect: { code: 'verify_failed', detail: 'bad_version' },
  },
  {
    name: 'pin 精确:latest 与 pin 不同、pin 的版本比已装高 → 升到 pin',
    input: {
      ...base({ pin: '0.2.2' }),
      ...withNpmjs(
        view(
          ['0.2.0', '0.2.2', '0.3.0'],
          { latest: '0.3.0' },
          { '0.2.2': iso(99), '0.3.0': iso(99) },
        ),
      ),
    },
    expect: { code: 'ok', version: '0.2.2' },
  },
  {
    name: 'pin 精确:已在 pin 上而 latest 更新 → pinned',
    input: {
      ...base({ installed: '0.2.2', pin: '0.2.2' }),
      ...withNpmjs(
        view(['0.2.2', '0.3.0'], { latest: '0.3.0' }, { '0.2.2': iso(99), '0.3.0': iso(99) }),
      ),
    },
    expect: { code: 'pinned', detail: 'no_version_in_pin' },
  },
  {
    name: 'pin ~0.2:latest 在范围内 → ok',
    input: base({ pin: '~0.2' }),
    expect: { code: 'ok', version: '0.2.1' },
  },
  {
    name: 'pin ~0.2:latest 超出范围,取范围内最高(0.2.4)',
    input: {
      ...base({ pin: '~0.2' }),
      ...withNpmjs(
        view(
          ['0.2.0', '0.2.1', '0.2.4', '0.3.0'],
          { latest: '0.3.0' },
          { '0.2.4': iso(99), '0.3.0': iso(99) },
        ),
      ),
    },
    expect: { code: 'ok', version: '0.2.4' },
  },
  {
    name: 'pin ~0.2:范围内没有更新版本 → pinned',
    input: {
      ...base({ pin: '~0.2' }),
      ...withNpmjs(view(['0.2.0', '0.3.0'], { latest: '0.3.0' }, { '0.3.0': iso(99) })),
    },
    expect: { code: 'pinned' },
  },
  {
    name: 'pin 范围内的坏版本被排除',
    input: {
      ...base({ pin: '~0.2', badVersions: ['0.2.4'] }),
      ...withNpmjs(
        view(
          ['0.2.0', '0.2.3', '0.2.4', '0.3.0'],
          { latest: '0.3.0' },
          { '0.2.3': iso(99), '0.2.4': iso(99), '0.3.0': iso(99) },
        ),
      ),
    },
    expect: { code: 'ok', version: '0.2.3' },
  },
  {
    name: '没有 dist-tag → not_ready/dist_tag_missing',
    input: { ...base(), ...withNpmjs(view(['0.2.0'], {}, {})) },
    expect: { code: 'not_ready', detail: 'dist_tag_missing' },
  },
  {
    name: 'dist-tag 不是合法版本号 → parse',
    input: { ...base(), ...withNpmjs(view(['0.2.0'], { latest: 'banana' }, {})) },
    expect: { code: 'parse', detail: 'dist_tag_invalid' },
  },
  {
    name: '202 半可见:dist-tag 已指向新版本,versions 里还没有 → not_ready/version_missing',
    input: {
      ...base(),
      ...withNpmjs(view(['0.2.0'], { latest: '0.2.1' }, { '0.2.1': iso(99) })),
    },
    expect: { code: 'not_ready', detail: 'version_missing' },
  },
  {
    name: '202 半可见:版本已出现但缺 dist.integrity → not_ready/dist_incomplete',
    input: {
      ...base(),
      ...withNpmjs(view(['0.2.0', '0.2.1'], { latest: '0.2.1' }, { '0.2.1': iso(99) }, ['0.2.1'])),
    },
    expect: { code: 'not_ready', detail: 'dist_incomplete' },
  },
  {
    name: '镜像:npmjs 有、镜像还没有该版本 → not_ready/mirror_lacks_version',
    input: (() => {
      const npm = view(['0.2.0', '0.2.1'], { latest: '0.2.1' }, { '0.2.1': iso(99) });
      return {
        ...base({ mirror: true }),
        primary: view(['0.2.0'], { latest: '0.2.0' }, {}),
        npmjs: { kind: 'ok', view: npm, dateHeader: DATE_HDR } as const,
      };
    })(),
    expect: { code: 'not_ready', detail: 'mirror_lacks_version' },
  },
  {
    name: '镜像:镜像的版本缺 tarball → not_ready/mirror_dist_incomplete',
    input: (() => {
      const npm = view(['0.2.0', '0.2.1'], { latest: '0.2.1' }, { '0.2.1': iso(99) });
      const mir = view(['0.2.0', '0.2.1'], { latest: '0.2.1' }, {});
      const m = mir.versions['0.2.1'];
      if (m === undefined) throw new Error('fixture');
      return {
        ...base({ mirror: true }),
        primary: { ...mir, versions: { ...mir.versions, '0.2.1': { ...m, hasTarball: false } } },
        npmjs: { kind: 'ok', view: npm, dateHeader: DATE_HDR } as const,
      };
    })(),
    expect: { code: 'not_ready', detail: 'mirror_dist_incomplete' },
  },
  {
    name: '镜像:冷却期用 npmjs 的 time,不用镜像自己的 time(镜像把 time 改老也没用)',
    input: (() => {
      const npm = view(['0.2.0', '0.2.1'], { latest: '0.2.1' }, { '0.2.1': iso(1) });
      const mir = view(['0.2.0', '0.2.1'], { latest: '0.2.1' }, { '0.2.1': iso(500) });
      return {
        ...base({ mirror: true }),
        primary: mir,
        npmjs: { kind: 'ok', view: npm, dateHeader: DATE_HDR } as const,
      };
    })(),
    expect: { code: 'cooldown', detail: 'not_elapsed' },
  },
  {
    name: '镜像:npmjs 取不到 → attestations_unreachable(原因保留)',
    input: {
      ...base({ mirror: true }),
      npmjs: { kind: 'unreachable', cause: 'timeout' },
    },
    expect: { code: 'attestations_unreachable', detail: 'npmjs_packument_unreachable' },
  },
];

describe('decideUpdate:表驱动', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const d = decideUpdate(c.input);
      expect(d.code).toBe(c.expect.code);
      if (c.expect.detail !== undefined) expect(d.detail).toBe(c.expect.detail);
      else if (c.expect.code === 'ok') expect(d.detail).toBeUndefined();
      if (c.expect.version !== undefined) expect(d.version).toBe(c.expect.version);
    });
  }

  it('原因保留:镜像取不到 npmjs 时 cause 带出原始网络码', () => {
    const d = decideUpdate({
      ...base({ mirror: true }),
      npmjs: { kind: 'unreachable', cause: 'http_503' },
    });
    expect(d.cause).toBe('http_503');
  });

  it('码清单 == 夹具覆盖清单(每个决策码、每个细分都有夹具;host_denied 经 mapNetFailure)', () => {
    const codes = new Set<string>(CASES.map((c) => c.expect.code));
    const details = new Set<string>(
      CASES.flatMap((c) => (c.expect.detail ? [c.expect.detail] : [])),
    );
    // 夹具必须真的产出各自声称的码(上面的用例已断言),这里核对清单两端相等
    const mapped = mapNetFailure('host_denied');
    codes.add(mapped.code);
    if (mapped.detail !== undefined) details.add(mapped.detail);
    expect([...codes].sort()).toEqual([...DECISION_CODES].sort());
    expect([...details].sort()).toEqual([...DECISION_DETAILS].sort());
  });

  it('非法已装版本号直接抛(不静默当作可升级)', () => {
    expect(() => decideUpdate(base({ installed: 'v1' }))).toThrow(RangeError);
  });
});

describe('mapNetFailure:网络码不合并', () => {
  it('每个网络码原样保留;host_denied 映射为 verify_failed 但细分保留', () => {
    for (const c of [
      'timeout',
      'dns',
      'connect',
      'tls',
      'proxy',
      'too_large',
      'parse',
      'http_404',
      'http_503',
    ] as const) {
      expect(mapNetFailure(c)).toEqual({ code: c });
    }
    expect(mapNetFailure('host_denied')).toEqual({ code: 'verify_failed', detail: 'host_denied' });
  });
});

describe('semver 与 pin', () => {
  it('排序遵循 SemVer 2.0', () => {
    const order = [
      '0.1.0-alpha',
      '0.1.0-alpha.1',
      '0.1.0-alpha.beta',
      '0.1.0-beta',
      '0.1.0-rc.1',
      '0.1.0',
      '0.1.1',
      '0.10.0',
      '1.0.0',
    ];
    for (let i = 0; i < order.length - 1; i++) {
      const a = parseSemver(order[i] ?? '');
      const b = parseSemver(order[i + 1] ?? '');
      if (a === undefined || b === undefined) throw new Error('fixture');
      expect(compareSemver(a, b)).toBeLessThan(0);
      expect(compareSemver(b, a)).toBeGreaterThan(0);
    }
  });

  it('pin 语义', () => {
    expect(satisfiesPin('0.2.1', '0.2.1')).toBe(true);
    expect(satisfiesPin('0.2.2', '0.2.1')).toBe(false);
    expect(satisfiesPin('0.2.0', '~0.2')).toBe(true);
    expect(satisfiesPin('0.2.99', '~0.2')).toBe(true);
    expect(satisfiesPin('0.3.0', '~0.2')).toBe(false);
    expect(satisfiesPin('0.3.0-rc.0', '~0.2')).toBe(false);
    expect(satisfiesPin('0.2.2', '~0.2.3')).toBe(false);
    expect(satisfiesPin('0.2.3', '~0.2.3')).toBe(true);
    expect(satisfiesPin('0.2.9', '~0.2.3')).toBe(true);
    expect(satisfiesPin('0.2.3-rc.0', '~0.2.3')).toBe(false);
    expect(satisfiesPin('0.2.1', '^0.2')).toBe(false);
    expect(satisfiesPin('0.2.1', '')).toBe(false);
  });
});

describe('评审补充:超大数字预发布与被归一化的非法日期', () => {
  it('预发布数字标识符超过 2^53 仍能正确排序(不经 Number)', () => {
    const a = parseSemver('1.0.0-rc.9007199254740993.0');
    const b = parseSemver('1.0.0-rc.9007199254740992.1');
    if (a === undefined || b === undefined) throw new Error('fixture');
    expect(compareSemver(a, b)).toBeGreaterThan(0);
    expect(compareSemver(b, a)).toBeLessThan(0);
  });

  it('超大预发布数字参与防降级:候选更低 → downgrade_refused', () => {
    const v = view(
      ['1.0.0-rc.9007199254740992.1'],
      { rc: '1.0.0-rc.9007199254740992.1' },
      { '1.0.0-rc.9007199254740992.1': iso(99) },
    );
    const d = decideUpdate({
      ...base({ installed: '1.0.0-rc.9007199254740993.0', channel: 'rc' }),
      ...withNpmjs(v),
    });
    expect(d.code).toBe('downgrade_refused');
  });

  it('不存在的日期(2 月 30 日、4 月 31 日、非闰年 2 月 29 日、星期不符)→ 不可解析', () => {
    for (const s of [
      'Mon, 30 Feb 2026 12:00:00 GMT',
      'Thu, 31 Apr 2026 12:00:00 GMT',
      'Sun, 29 Feb 2026 12:00:00 GMT',
      'Mon, 14 Oct 2026 12:00:00 GMT', // 2026-10-14 是星期三
    ]) {
      expect(parseHttpDate(s)).toBeUndefined();
    }
    for (const s of ['2026-02-30T12:00:00Z', '2026-04-31T12:00:00.000Z', '2026-02-29T00:00:00Z']) {
      expect(parseIsoUtc(s)).toBeUndefined();
    }
    expect(parseHttpDate('Sun, 29 Feb 2032 12:00:00 GMT')).toBe(Date.parse('2032-02-29T12:00:00Z'));
  });

  it('非法 Date 头 → 决策为 date_header_unparseable,不会把「现在」推后', () => {
    const d = decideUpdate({
      ...base(),
      ...withNpmjs(
        view(['0.2.0', '0.2.1'], { latest: '0.2.1' }, { '0.2.1': iso(1) }),
        'Mon, 30 Feb 2026 12:00:00 GMT',
      ),
    });
    expect(d).toMatchObject({ code: 'cooldown', detail: 'date_header_unparseable' });
  });
});

describe('时间解析:fail-closed', () => {
  it('只接受规范写法', () => {
    expect(parseHttpDate(DATE_HDR)).toBe(Date.parse(NOW));
    expect(parseHttpDate('2026-10-14T12:00:00Z')).toBeUndefined();
    expect(parseHttpDate('')).toBeUndefined();
    expect(parseHttpDate(undefined)).toBeUndefined();
    expect(parseHttpDate('Wed, 99 Oct 2026 12:00:00 GMT')).toBeUndefined();
    expect(parseIsoUtc('2026-10-14T03:07:36.838Z')).toBe(Date.parse('2026-10-14T03:07:36.838Z'));
    expect(parseIsoUtc('2026-10-14T03:07:36+08:00')).toBeUndefined();
    expect(parseIsoUtc('2026-10-14')).toBeUndefined();
    expect(parseIsoUtc(undefined)).toBeUndefined();
  });
});

describe('readPackument', () => {
  it('收窄出视图;形状不对返回 undefined', () => {
    const v = readPackument({
      'dist-tags': { latest: '0.1.0' },
      versions: {
        '0.1.0': { dist: { integrity: 'sha512-a', tarball: 'https://x/y.tgz' } },
        '0.0.9': {},
      },
      time: { '0.1.0': '2026-10-14T03:07:36.838Z' },
    });
    expect(v?.distTags['latest']).toBe('0.1.0');
    expect(v?.versions['0.1.0']).toMatchObject({ hasIntegrity: true, hasTarball: true });
    expect(v?.versions['0.0.9']).toMatchObject({ hasIntegrity: false, hasTarball: false });
    expect(readPackument(null)).toBeUndefined();
    expect(readPackument([])).toBeUndefined();
    expect(readPackument({ versions: {} })).toBeUndefined();
    // 精简 install-v1 没有 time:视图里 time 为空 → 冷却期按 time_missing 拒
    expect(readPackument({ 'dist-tags': {}, versions: {} })?.time).toEqual({});
  });
});

describe('开关(gate)', () => {
  const on = { env: {}, isTTY: true, autoInstall: true } as const;
  const FIXTURES: Record<(typeof GATE_OFF_REASONS)[number], Parameters<typeof autoUpdateGate>[0]> =
    {
      env_off: { ...on, env: { KIT_AUTO_UPDATE: '0' } },
      launched: { ...on, env: { KIT_LAUNCHED: '1' } },
      ci: { ...on, env: { CI: 'true' } },
      not_tty: { ...on, isTTY: false },
      config_off: { ...on, autoInstall: false },
      command_excluded: { ...on, command: 'build' },
    };

  it('默认(TTY、无 CI、配置开)→ 开', () => {
    expect(autoUpdateGate(on)).toEqual({ enabled: true });
    expect(autoUpdateGate({ ...on, command: 'sync' })).toEqual({ enabled: true });
  });

  for (const [reason, input] of Object.entries(FIXTURES)) {
    it(`关闭原因 ${reason}`, () => {
      expect(autoUpdateGate(input)).toEqual({ enabled: false, reason });
    });
  }

  it('原因码清单 == 夹具覆盖清单', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([...GATE_OFF_REASONS].sort());
  });

  it('KIT_AUTO_UPDATE 优先于其它;CI=false/0 不算 CI;check 也被排除', () => {
    expect(autoUpdateGate({ ...on, env: { KIT_AUTO_UPDATE: '0', CI: 'true' } })).toEqual({
      enabled: false,
      reason: 'env_off',
    });
    expect(autoUpdateGate({ ...on, env: { CI: 'false' } })).toEqual({ enabled: true });
    expect(autoUpdateGate({ ...on, env: { CI: '0' } })).toEqual({ enabled: true });
    expect(autoUpdateGate({ ...on, env: { GITHUB_ACTIONS: 'true' } })).toMatchObject({
      reason: 'ci',
    });
    expect(autoUpdateGate({ ...on, command: 'check' })).toMatchObject({
      reason: 'command_excluded',
    });
  });
});

describe('节流(24h)', () => {
  const last = '2026-10-13T12:00:00.000Z';
  const t = (h: number): number => Date.parse(last) + h * H;
  it('边界:23h59 不检查,24h00 检查', () => {
    expect(checkDue(last, t(24 - 1 / 60))).toEqual({ due: false, reason: 'throttled' });
    expect(checkDue(last, t(24))).toEqual({ due: true, reason: 'elapsed' });
    expect(checkDue(last, t(0))).toEqual({ due: false, reason: 'throttled' });
  });
  it('从没检查过 / 时间戳坏了 / 时钟往回走 → 检查', () => {
    expect(checkDue(undefined, t(1))).toEqual({ due: true, reason: 'never' });
    expect(checkDue('garbage', t(1))).toEqual({ due: true, reason: 'unparseable' });
    expect(checkDue(last, t(-1))).toEqual({ due: true, reason: 'clock_back' });
  });
  it('间隔可注入', () => {
    expect(checkDue(last, t(2), 1).due).toBe(true);
    expect(checkDue(last, t(0.5), 1).due).toBe(false);
  });
});
