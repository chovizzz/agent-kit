/**
 * R20-A3 必杀变异(契约 §20.8.2 A3 行「必须覆盖的变异点」):每条变异后必须有测试红,且只红该条款自己的杀手用例。
 * 执行方式同 B5e(`b5-mutation-table.ts`):javis 私有检出里 cp 备份 → 按锚点替换(每个锚点在源码里**恰好出现一次**)→ 跑 `tests` →
 * 失败集合非空、全部命中 `expectRed`、`mustKill` 每项至少命中一个、没有 skipped → cp 还原并逐文件 sha256 核对。结果记在 {@link A3_RESULTS}。
 * 执行器不在仓库内(与 B5e 相同):javis 上的 `~/kit-a3-mutate.mts`(`node --experimental-strip-types` 直接读本文件),只在私有检出里用,不用 git checkout / stash 还原。
 */
export interface Edit {
  file: string;
  anchor: string;
  replacement: string;
}

export interface A3Mutation {
  id: string;
  /** 契约里的变异点原文 */
  clause: string;
  edits: readonly Edit[];
  /** 相对 `test/` */
  tests: readonly string[];
  expectRed: readonly string[];
  mustKill: readonly string[];
}

const UNITS = 'rsi/a3-units.test.ts';
const POKE = 'rsi/a3-poke.test.ts';
const HINT = 'rsi/a3-hint.test.ts';
const WORKER = 'rsi/a3-worker.test.ts';
const DIST = 'rsi/a3-dist.test.ts';
const ENTRY = 'rsi/a3-entry.test.ts';

export const A3_MUTATIONS: readonly A3Mutation[] = [
  {
    id: 'throttle-flipped',
    clause: '节流比较取反',
    edits: [
      {
        file: 'src/rsi/services/breaker.ts',
        anchor: 'return nowMs - at >= RSI_L0_MIN_INTERVAL_MS;',
        replacement: 'return nowMs - at < RSI_L0_MIN_INTERVAL_MS;',
      },
    ],
    tests: [UNITS, POKE, WORKER],
    expectRed: [
      'L0 到期',
      '6h',
      '6 小时',
      '到期 → 预留',
      '残留 attempt',
      '正常运行',
      '熔断',
      'armed',
      'confirmed',
      'log.jsonl',
      '预留标记',
      'pi',
      '持锁期间',
      'update/lock',
      '其它',
      '顺带调度',
      'KIT_AUTO_RSI=1',
      'KIT_LAUNCHED',
    ],
    mustKill: ['L0 到期', '6h'],
  },
  {
    id: 'reservation-check-removed',
    clause: '去掉预留检查(两个 poke 都 spawn)',
    edits: [
      {
        file: 'src/rsi/services/spawn-gate.ts',
        anchor: "if (ro.kind === 'ok' && (await present(path.join(ro.dir, 'poke', markerName)))) {",
        replacement: 'if (false) {',
      },
      {
        file: 'src/rsi/services/spawn-gate.ts',
        anchor: "if ((e as NodeJS.ErrnoException).code === 'EEXIST') return noop('reserved');",
        replacement: "if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;",
      },
    ],
    tests: [POKE, DIST],
    // 端到端用例里第二次 poke 先被 6h 间隔挡住(worker 刚完成),到不了预留检查,所以它杀不了这条变异:只列在允许红的集合里,不算必杀
    expectRed: ['同一窗口', '端到端'],
    mustKill: ['同一窗口'],
  },
  {
    id: 'attempt-after-read',
    clause: 'attempt 在读文件之后才写(预写被移走:读阶段开始时磁盘上没有 attempt)',
    edits: [
      {
        file: 'src/rsi/worker.ts',
        anchor: '{ ...s1.prev, attempt: { started_at: now().toISOString(), nonce: lock.nonce } },',
        replacement: '{ ...s1.prev },',
      },
    ],
    tests: [WORKER],
    expectRed: ['attempt 在读任何会话文件之前'],
    mustKill: ['attempt 在读任何会话文件之前'],
  },
  {
    id: 'hint-cap-removed',
    clause: 'hint 去掉字节上限',
    edits: [
      {
        file: 'src/rsi/hint.ts',
        anchor: "return Buffer.byteLength(text, 'utf8') <= RSI_HINT_MAX_BYTES ? text : '';",
        replacement: 'return text;',
      },
    ],
    tests: [UNITS, HINT],
    expectRed: ['200 字节放行'],
    mustKill: ['200 字节放行'],
  },
  {
    id: 'auto-rsi-check-removed',
    clause: '`KIT_AUTO_RSI` 判断去掉',
    edits: [
      {
        file: 'src/rsi/skip.ts',
        anchor: "if (env['KIT_AUTO_RSI'] === '0') return 'auto_off';",
        replacement: '',
      },
    ],
    tests: [UNITS, POKE, HINT, WORKER],
    expectRed: ['KIT_AUTO_RSI'],
    mustKill: ['KIT_AUTO_RSI="0"', '× KIT_AUTO_RSI=0', 'KIT_AUTO_RSI=0'],
  },
  {
    id: 'entry-through-launcher',
    clause: 'rsi 入口改回经 `launchCurrent`',
    edits: [
      {
        file: 'cli.ts',
        anchor:
          "argv[i] === '__rsi' || (argv[i] === 'rsi' && (argv[i + 1] === 'poke' || argv[i + 1] === 'hint'));",
        replacement:
          "false && (argv[i] === '__rsi' || (argv[i] === 'rsi' && (argv[i + 1] === 'poke' || argv[i + 1] === 'hint')));",
      },
    ],
    tests: [DIST, ENTRY],
    expectRed: ['R20-1.2a', '不读 stdin', '钩子参数', '端到端', '根入口'],
    mustKill: ['R20-1.2a'],
  },
];

export interface A3MutationResult {
  id: string;
  /** 实际红的用例(标题子串) */
  killedBy: readonly string[];
  failed: number;
  skipped: number;
  restored: boolean;
}

/** javis 上的实测结果(执行器输出后登记;没有结果的变异不算数) */
export const A3_RESULTS: readonly A3MutationResult[] = [
  // 2026-11-02 javis 私有检出 @ 5415f8a(首轮 @ 10b6e1c 结果相同):基线 129 例全绿、0 skipped;每条还原后逐文件 sha256 一致、git 干净;javis HOME 下 .local/state/agent-kit 前后不变
  {
    id: 'throttle-flipped',
    killedBy: [
      '上次完成不足 6h → 空操作;恰 6h → spawn;时钟回拨 → spawn',
      'R20-6.3 L0 到期(假时钟) > 恰 6 小时 → 到期;差 1 毫秒 → 不到期(节流比较取反 → 红)',
      '不到 6h:skipped_throttled(日志一行),不写 attempt、不读会话、不建盐',
    ],
    failed: 3,
    skipped: 0,
    restored: true,
  },
  {
    id: 'reservation-check-removed',
    killedBy: [
      '同一窗口的第二个 poke:EEXIST → 空操作、不 spawn、零写入(去掉预留检查 → 两个都 spawn → 红)',
    ],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'attempt-after-read',
    killedBy: [
      'attempt 在读任何会话文件之前已落盘(读阶段第一步时 state.json 里就有;移到读之后 → 红)',
    ],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'hint-cap-removed',
    killedBy: ['200 字节放行、201 字节 → 空串;多字节 UTF-8 按字节算(字节上限去掉 → 红)'],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'auto-rsi-check-removed',
    killedBy: [
      '空串情形(全部零写入) > KIT_AUTO_RSI=0',
      'armed × KIT_AUTO_RSI=0',
      'confirmed × KIT_AUTO_RSI=0',
      'KIT_AUTO_RSI="0" → 跳过(四类自动入口一致)',
      '锁外跳过(零写入) > KIT_AUTO_RSI=0',
    ],
    failed: 5,
    skipped: 0,
    restored: true,
  },
  {
    id: 'entry-through-launcher',
    killedBy: [
      'R20-1.2a 四组合 × off / STOP > off × 非 TTY',
      'R20-1.2a 四组合 × off / STOP > off × TTY',
      'R20-1.2a 四组合 × off / STOP > stop × 非 TTY',
      'R20-1.2a 四组合 × off / STOP > stop × TTY',
      '钩子参数带 --help / --version / 全局选项:仍不进启动器、无输出(__rsi 退 2)',
      '端到端:armed + 到期 → poke 真的起 worker',
    ],
    failed: 6,
    skipped: 0,
    restored: true,
  },
];
