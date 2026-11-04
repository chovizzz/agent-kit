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
    expectRed: [
      '不转发的情形',
      '判据只来自 decideCurrent',
      'b current 损坏',
      'c 不转发',
      'd KIT_LAUNCHED',
      'e poke',
      'f 前台命令备好受控 tmp',
    ],
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
        anchor:
          "    if (!checkDue(st.kind === 'ok' ? st.state.last_check_at : undefined, nowMs).due) {",
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
    expectRed: ['H2-B', '受控 tmp 不存在', '受控 tmp 权限过宽'],
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
    expectRed: ['永不调度', 'b current 损坏', 'c 不转发', 'd KIT_LAUNCHED'],
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
    expectRed: ['b current 损坏', 'c 不转发', 'd KIT_LAUNCHED', 'e poke', 'f 前台命令备好受控 tmp'],
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
    expectRed: [
      'NO 集合内',
      'rsi off',
      'b current 损坏',
      'c 不转发',
      'M1 / L3:源码里出现过的每个 noop why',
    ],
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
    expectRed: ['NO 集合内', '其余 noop why', 'L0 未到期'],
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
    id: 'ensure-hook-tmp-removed',
    clause: '前台命令不再备好受控 tmp(只用 pi 的用户永远调度不起来)',
    edits: [
      {
        file: 'src/update/launcher.ts',
        anchor: '    await ensureHookTmp({ home, env });',
        replacement: '    void ensureHookTmp;',
      },
    ],
    tests: [DIST],
    expectRed: ['全新假 HOME 没有 tmp'],
    mustKill: ['全新假 HOME 没有 tmp'],
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
// 2026-11-04T15:56:55.552Z javis 私有检出 @ dee6813:基线全绿(0 failed);每条变异还原后逐文件 sha256 一致、git 干净;javis HOME 下 .local/state/agent-kit 前后不变
export const AU_RESULTS: readonly AuMutationResult[] = [
  {
    id: 'tree-verify-removed',
    killedBy: [
      'decideCurrent 矩阵 > 锚点不符 → anchor;文件被改 / 多出文件 → tree(完整树校验在「更高同 major」时一定跑)',
      'b current 损坏:静默用自己(stdout / stderr 空、不起 current、零写入) > anchor',
      'forwardHookToCurrent > 不转发的情形 runSelf 一次都不调:相同 / 更低 / 跨 major / 损坏 / 无状态 / KIT_LAUNCHED',
      'forwardHookToCurrent > 判据只来自 decideCurrent:注入的校验器说不过就不转发(不自行比较版本)',
      'b current 损坏:静默用自己(stdout / stderr 空、不起 current、零写入) > tamper',
    ],
    failed: 5,
    skipped: 0,
    restored: true,
  },
  {
    id: 'launched-guard-removed',
    killedBy: [
      'decideCurrent 矩阵 > L5:KIT_LAUNCHED 按 truthyEnv 口径——1 不转发;0 / 空串 / false 与未设相同(转发)',
      'd KIT_LAUNCHED > =1 不转发(防递归);=0 视为未设,照常转发',
      'decideCurrent 矩阵 > M4 短路顺序:每一步失败都不再做后面更贵的读取(记录读取器调用)',
      'forwardHookToCurrent > 不转发的情形 runSelf 一次都不调:相同 / 更低 / 跨 major / 损坏 / 无状态 / KIT_LAUNCHED',
    ],
    failed: 4,
    skipped: 0,
    restored: true,
  },
  {
    id: 'version-compare-inverted',
    killedBy: [
      'c 不转发:相同 / 更低 / 跨 major / 没有安装状态 > 更低',
      'a 有效 current:钩子转发 > hint:stdout 来自 current、退出码恒 0(子进程的 7 被丢弃)、argv 原样、环境(HOME / KIT_TMP / KIT_REAL_HOME_OVERRIDE / KIT_STATE_DIR)正确、KIT_LAUNCHED=1',
      'a 有效 current:钩子转发 > poke:转发(恒 0),父进程不再调度 update worker',
      'a 有效 current:钩子转发 > `__rsi --background`:转发且透传子进程退出码(7)',
      'd KIT_LAUNCHED > =1 不转发(防递归);=0 视为未设,照常转发',
    ],
    failed: 14,
    skipped: 0,
    restored: true,
  },
  {
    id: 'absent-as-broken',
    killedBy: [
      'decideCurrent 矩阵 > M6 state 三态:absent / 没有 installed → 静默用自己(无 broken);unreadable / unsafe → broken=state',
    ],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'forward-ignores-decision',
    killedBy: [
      'forwardHookToCurrent > 不转发的情形 runSelf 一次都不调:相同 / 更低 / 跨 major / 损坏 / 无状态 / KIT_LAUNCHED',
      'b current 损坏:静默用自己(stdout / stderr 空、不起 current、零写入) > anchor',
      'b current 损坏:静默用自己(stdout / stderr 空、不起 current、零写入) > tamper',
      'b current 损坏:静默用自己(stdout / stderr 空、不起 current、零写入) > version',
      'c 不转发:相同 / 更低 / 跨 major / 没有安装状态 > 相同',
    ],
    failed: 20,
    skipped: 0,
    restored: true,
  },
  {
    id: 'signal-not-forwarded',
    killedBy: [
      'forwardHookToCurrent > H4:超时 / 被信号终止(status:null)也算已转发,折成 128+signo,不回退本地',
    ],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'schedule-without-due',
    killedBy: [
      'spawnUpdateWorker:谓词矩阵 / 零写入 / 目标选择 > 24h 节流:23h59m 不调度;恰 24h、从未检查、时钟回拨 → 调度',
      'e poke 顺带调度 update worker > 不调度:未到期(上次检查刚刚)',
      'spawnUpdateWorker:谓词矩阵 / 零写入 / 目标选择 > M5:worker 一旦写下 last_check_at,紧接着的第二次 poke 不再调度(并发窗口内多起的 worker 由 worker 锁 / 锁内复查节流消化)',
    ],
    failed: 3,
    skipped: 0,
    restored: true,
  },
  {
    id: 'tmp-check-removed',
    killedBy: [
      'spawnUpdateWorker:谓词矩阵 / 零写入 / 目标选择 > H2-B:受控 tmp 不存在 / 权限过宽 → 不调度且不创建它(why=tmp)',
      'f 前台命令备好受控 tmp(H2-B):只用 pi 的用户装钩子那一次之后,poke 才调度得起来 > 全新假 HOME 没有 tmp:poke 不调度;先跑一条非 TTY 前台命令(--version)→ tmp 被建出(0700);同一世界再 poke → 恰好一次 __update --background',
      'f 前台命令备好受控 tmp(H2-B):只用 pi 的用户装钩子那一次之后,poke 才调度得起来 > KIT_AUTO_UPDATE=0 的前台命令不建 tmp(之后 poke 也不调度)',
      'e poke 顺带调度 update worker > 不调度:受控 tmp 不存在',
      'e poke 顺带调度 update worker > 不调度:受控 tmp 权限过宽',
    ],
    failed: 5,
    skipped: 0,
    restored: true,
  },
  {
    id: 'launched-blocks-schedule',
    killedBy: [
      'spawnUpdateWorker:谓词矩阵 / 零写入 / 目标选择 > KIT_LAUNCHED=1(poke 跑在被转发的 current 里)不挡调度',
    ],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'hint-also-schedules',
    killedBy: [
      'e poke 顺带调度 update worker > 不调度:hint 永不调度',
      'b current 损坏:静默用自己(stdout / stderr 空、不起 current、零写入) > anchor',
      'b current 损坏:静默用自己(stdout / stderr 空、不起 current、零写入) > tamper',
      'b current 损坏:静默用自己(stdout / stderr 空、不起 current、零写入) > version',
    ],
    failed: 10,
    skipped: 0,
    restored: true,
  },
  {
    id: 'autoskip-after-forward',
    killedBy: [
      'runHookEntry:转发 / 调度 > M2:autoSkip 先于转发——KIT_AUTO_RSI=0 / KIT_RSI_CHILD / CI 下三种钩子都不调桥接',
    ],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'broken-printed',
    killedBy: [
      'b current 损坏:静默用自己(stdout / stderr 空、不起 current、零写入) > anchor',
      'b current 损坏:静默用自己(stdout / stderr 空、不起 current、零写入) > tamper',
      'b current 损坏:静默用自己(stdout / stderr 空、不起 current、零写入) > version',
      'b current 损坏:静默用自己(stdout / stderr 空、不起 current、零写入) > escape',
    ],
    failed: 19,
    skipped: 0,
    restored: true,
  },
  {
    id: 'off-also-schedules',
    killedBy: [
      'M1 调度谓词:noop why 全矩阵 > NO 集合内的 why 不调度',
      'e poke 顺带调度 update worker > 不调度:rsi off',
      'b current 损坏:静默用自己(stdout / stderr 空、不起 current、零写入) > anchor',
      'b current 损坏:静默用自己(stdout / stderr 空、不起 current、零写入) > tamper',
      'b current 损坏:静默用自己(stdout / stderr 空、不起 current、零写入) > version',
    ],
    failed: 11,
    skipped: 0,
    restored: true,
  },
  {
    id: 'throttled-not-scheduled',
    killedBy: [
      'M1 调度谓词:noop why 全矩阵 > 其余 noop why(L0 throttled / breaker_open / stopped / state_invalid 等)、spawned、spawn_failed 都调度',
      'runPoke × scheduleUpdate > L0 未到期(throttled)→ 仍调度,且 rsi 侧零写入',
      'M1 调度谓词:noop why 全矩阵 > NO 集合内的 why 不调度',
    ],
    failed: 3,
    skipped: 0,
    restored: true,
  },
  {
    id: 'policy-imports-net',
    killedBy: [
      'D-AU:零网络闭包 > src/update/installed.ts 的闭包(含 import type)不含网络出口 / 安装器 / 启动器 / 写出口',
      'D-AU:零网络闭包 > H1:policy.ts 引的是 contracts/net-error.ts,不是 io/net.ts;io/net.ts 反向 re-export 码表',
      'D-AU:零网络闭包 > src/update/policy.ts 的闭包(含 import type)不含网络出口 / 安装器 / 启动器 / 写出口',
      'D-AU:零网络闭包 > src/update/state.ts 的闭包(含 import type)不含网络出口 / 安装器 / 启动器 / 写出口',
      'D-AU:零网络闭包 > src/update/self-spawn.ts 的闭包(含 import type)不含网络出口 / 安装器 / 启动器 / 写出口',
    ],
    failed: 9,
    skipped: 0,
    restored: true,
  },
  {
    id: 'ensure-hook-tmp-removed',
    killedBy: [
      'f 前台命令备好受控 tmp(H2-B):只用 pi 的用户装钩子那一次之后,poke 才调度得起来 > 全新假 HOME 没有 tmp:poke 不调度;先跑一条非 TTY 前台命令(--version)→ tmp 被建出(0700);同一世界再 poke → 恰好一次 __update --background',
    ],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'auto-install-fail-open',
    killedBy: [
      'readAutoInstall(H3:worker 与钩子调度共用) > fail-closed:TOML 解析失败 / schema 不合 / 配置路径是目录 → ok:false',
    ],
    failed: 1,
    skipped: 0,
    restored: true,
  },
];
