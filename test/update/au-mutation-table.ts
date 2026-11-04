/**
 * D-AU1 / D-AU2 必杀变异(contracts §20.19「验收与变异」):每条变异后必须有测试红,且只红该条款自己的杀手用例。
 * 执行方式同 A3(`test/rsi/a3-mutation-table.ts`):javis 私有检出里 cp 备份 → 按锚点替换(每个锚点在源码里**恰好出现一次**)→ 跑 `tests` →
 * 失败集合非空、全部命中 `expectRed`、`mustKill` 每项至少命中一个、没有 skipped → cp 还原并逐文件 sha256 核对。结果记在 {@link AU_RESULTS}。
 * 执行器不在仓库内(`~/kit-au-mutate.mts`,`node --experimental-strip-types` 直接读本文件),只在私有检出里用,不用 git checkout / stash 还原。
 * `expectRed` / `mustKill` 的每一项都是测试源码里的字面子串(`au-mutation-table.test.ts` 核对)。
 */
export interface Edit {
  file: string;
  anchor: string;
  replacement: string;
}

export interface AuMutation {
  id: string;
  clause: string;
  edits: readonly Edit[];
  /** 相对 `test/` */
  tests: readonly string[];
  expectRed: readonly string[];
  mustKill: readonly string[];
}

const INSTALLED = 'update/installed.test.ts';
const SPAWN = 'update/self-spawn-hook.test.ts';
const CLOSURE = 'update/installed-closure.test.ts';
const ENTRY = 'rsi/hook-update.test.ts';
const DIST = 'rsi/hook-forward-dist.test.ts';

export const AU_MUTATIONS: readonly AuMutation[] = [
  {
    id: 'tree-verify-removed',
    clause: '去掉转发前的完整树校验(decideCurrent 不再调 verifyTree)',
    edits: [
      {
        file: 'src/update/installed.ts',
        anchor:
          "  if (!tree.ok)\n    return { launch: false, broken: tree.reason === 'anchor_mismatch' ? 'anchor' : 'tree' };",
        replacement: '  void tree;',
      },
    ],
    tests: [INSTALLED, SPAWN, DIST],
    expectRed: [
      '锚点不符',
      '对拍',
      '不转发的情形',
      '判据只来自 decideCurrent',
      'b current 损坏',
      'M4 短路顺序',
    ],
    mustKill: ['锚点不符', 'b current 损坏'],
  },
  {
    id: 'launched-guard-removed',
    clause: '去掉 KIT_LAUNCHED 守卫(防递归)',
    edits: [
      {
        file: 'src/update/installed.ts',
        anchor: "  if (truthyEnv(input.env['KIT_LAUNCHED'])) return { launch: false };",
        replacement: '  void truthyEnv;',
      },
    ],
    tests: [INSTALLED, SPAWN, DIST],
    expectRed: ['L5', 'M4 短路顺序', '不转发的情形', 'd KIT_LAUNCHED'],
    mustKill: ['L5', 'd KIT_LAUNCHED'],
  },
  {
    id: 'version-compare-inverted',
    clause: '版本比较取反(更高才转发 → 不更高才转发)',
    edits: [
      {
        file: 'src/update/installed.ts',
        anchor: '  if (compareSemver(a, b) <= 0 ||',
        replacement: '  if (compareSemver(a, b) >= 0 ||',
      },
    ],
    tests: [INSTALLED, SPAWN, DIST],
    expectRed: [
      '正向对照',
      '相同 / 更低 / 跨 major',
      '对拍',
      'M4 短路顺序',
      '更高同 major',
      '不转发的情形',
      'a 有效 current',
      'c 不转发',
      'b current 损坏',
      'KIT_LAUNCHED',
      'timeoutMs',
      'H4',
      'pickWorkerTarget',
      '判据只来自 decideCurrent',
      '拒绝',
      'L5',
    ],
    mustKill: ['相同 / 更低 / 跨 major', 'a 有效 current'],
  },
  {
    id: 'absent-as-broken',
    clause: 'state 缺失归为 broken(M6:absent 必须静默)',
    edits: [
      {
        file: 'src/update/installed.ts',
        anchor: "  if (state.kind === 'absent') return { launch: false };",
        replacement: "  if (state.kind === 'absent') return { launch: false, broken: 'state' };",
      },
    ],
    tests: [INSTALLED, DIST],
    expectRed: ['M6 state 三态', '对拍', 'M4 短路顺序', 'c 不转发'],
    mustKill: ['M6 state 三态'],
  },
  {
    id: 'forward-ignores-decision',
    clause: '转发绕过 decideCurrent 的结论(自行放行)',
    edits: [
      {
        file: 'src/update/self-spawn.ts',
        anchor: '    if (!d.launch) return { forwarded: false };',
        replacement: '    if (d.launch === undefined) return { forwarded: false };',
      },
    ],
    tests: [SPAWN, DIST],
    expectRed: ['不转发的情形', '判据只来自 decideCurrent', 'b current 损坏', 'c 不转发', 'd KIT_LAUNCHED', 'e poke'],
    mustKill: ['不转发的情形', 'b current 损坏'],
  },
  {
    id: 'signal-not-forwarded',
    clause: '超时 / 信号终止不算已转发(会在本进程重跑,命令执行两遍)',
    edits: [
      {
        file: 'src/update/self-spawn.ts',
        anchor: '    return { forwarded: true, code: run.status ?? signalCode(run.signal) };',
        replacement:
          '    if (run.status === null) return { forwarded: false };\n    return { forwarded: true, code: run.status };',
      },
    ],
    tests: [SPAWN],
    expectRed: ['H4'],
    mustKill: ['H4'],
  },
  {
    id: 'schedule-without-due',
    clause: '调度去掉 checkDue(24h 节流)',
    edits: [
      {
        file: 'src/update/self-spawn.ts',
        anchor: "    if (!checkDue(st.kind === 'ok' ? st.state.last_check_at : undefined, nowMs).due) {",
        replacement: '    if (nowMs < 0) {',
      },
    ],
    tests: [SPAWN, DIST],
    expectRed: ['24h 节流', 'M5', '未到期(上次检查刚刚)'],
    mustKill: ['24h 节流', '未到期(上次检查刚刚)'],
  },
  {
    id: 'tmp-check-removed',
    clause: '调度不再要求受控 tmp 已存在且合格(H2-B)',
    edits: [
      {
        file: 'src/update/self-spawn.ts',
        anchor: "    if (tmp === undefined) return { scheduled: false, why: 'tmp' };",
        replacement: '    void tmp;',
      },
    ],
    tests: [SPAWN, DIST],
    expectRed: ['H2-B', '受控 tmp 不存在'],
    mustKill: ['H2-B', '受控 tmp 不存在'],
  },
  {
    id: 'launched-blocks-schedule',
    clause: 'hookUpdateGate 不再摘掉 KIT_LAUNCHED(被转发的 current 里的 poke 永远调度不了)',
    edits: [
      {
        file: 'src/update/policy.ts',
        anchor: '    env: { ...input.env, KIT_LAUNCHED: undefined },',
        replacement: '    env: input.env,',
      },
    ],
    tests: [SPAWN],
    expectRed: ['KIT_LAUNCHED=1'],
    mustKill: ['KIT_LAUNCHED=1'],
  },
  {
    id: 'hint-also-schedules',
    clause: 'hint 也调度 update worker',
    edits: [
      {
        file: 'src/rsi/hook-entry.ts',
        anchor: '    const text = await runHint(shape.rest, { env });',
        replacement:
          '    await bridge.scheduleUpdate({ home: getRealHome(env), env });\n    const text = await runHint(shape.rest, { env });',
      },
    ],
    tests: [ENTRY, DIST],
    expectRed: ['永不调度'],
    mustKill: ['永不调度'],
  },
  {
    id: 'autoskip-after-forward',
    clause: '跳过条件不再先于转发(M2)',
    edits: [
      {
        file: 'src/rsi/hook-entry.ts',
        anchor: '    if (autoSkip(env, shape.kind) !== null) return ExitCode.OK;',
        replacement: '    void autoSkip;',
      },
    ],
    tests: [ENTRY],
    expectRed: ['M2'],
    mustKill: ['M2'],
  },
  {
    id: 'broken-printed',
    clause: '转发失败时向 stderr 打印 UPDATE_CURRENT_BROKEN(破坏 R20-1.2a 静默)',
    edits: [
      {
        file: 'src/rsi/hook-entry.ts',
        anchor: '    if (f.forwarded) return ExitCode.OK;',
        replacement:
          "    if (f.forwarded) return ExitCode.OK;\n    process.stderr.write('UPDATE_CURRENT_BROKEN\\n');",
      },
    ],
    tests: [DIST],
    expectRed: ['b current 损坏', 'c 不转发', 'd KIT_LAUNCHED', 'e poke'],
    mustKill: ['b current 损坏'],
  },
  {
    id: 'off-also-schedules',
    clause: '谓词:rsi off 也调度',
    edits: [
      {
        file: 'src/rsi/poke.ts',
        anchor: "  'off',\n  'usage',",
        replacement: "  'usage',",
      },
    ],
    tests: [ENTRY, DIST],
    expectRed: ['NO 集合内', 'rsi off'],
    mustKill: ['NO 集合内', 'rsi off'],
  },
  {
    id: 'throttled-not-scheduled',
    clause: '谓词:L0 未到期(throttled)不调度(update 与 rsi 应互相独立)',
    edits: [
      {
        file: 'src/rsi/poke.ts',
        anchor: "  'error',\n]);",
        replacement: "  'error',\n  'not_due',\n]);",
      },
    ],
    tests: [ENTRY],
    expectRed: ['其余 noop why', 'L0 未到期'],
    mustKill: ['其余 noop why', 'L0 未到期'],
  },
  {
    id: 'policy-imports-net',
    clause: 'policy.ts 重新 import type io/net.ts(钩子闭包带进 net.ts)',
    edits: [
      {
        file: 'src/update/policy.ts',
        anchor: "import type { NetErrorCode } from '../contracts/net-error.js';",
        replacement: "import type { NetErrorCode } from '../io/net.js';",
      },
    ],
    tests: [CLOSURE],
    expectRed: [
      '的闭包(含 import type)不含网络出口',
      'H1:policy.ts',
      'self-spawn.ts 的闭包确实走到了新构件',
      'hook-entry.ts 经动态 import',
    ],
    mustKill: ['的闭包(含 import type)不含网络出口', 'H1:policy.ts'],
  },
  {
    id: 'auto-install-fail-open',
    clause: 'readAutoInstall 读不出配置时放行(应 fail-closed)',
    edits: [
      {
        file: 'src/update/auto-install.ts',
        anchor: '    if (probe.text === undefined) return { ok: false };',
        replacement: '    if (probe.text === undefined) return { ok: true, autoInstall: true };',
      },
    ],
    tests: [INSTALLED],
    expectRed: ['fail-closed'],
    mustKill: ['fail-closed'],
  },
];

export interface AuMutationResult {
  id: string;
  /** 实际红的用例(标题子串) */
  killedBy: readonly string[];
  failed: number;
  skipped: number;
  restored: boolean;
}

/** javis 上的实测结果(执行器输出后登记;没有结果的变异不算数) */
export const AU_RESULTS: readonly AuMutationResult[] = [];
