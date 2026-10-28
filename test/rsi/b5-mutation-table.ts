/**
 * R20-A2 B5 变异与故障注入表(方案 §11)的落盘:B5e 归档。沿用 B4 的形状(`l0-mutation-table.ts`):每行 = 条款 | 入口 | 状态 | 正向 | 反向 | 变异 | 故障点 | 杀手用例;
 * `b5-mutation-table.test.ts` 核对表自身的完整性(引用的测试文件存在、字段非空、变异名唯一、每个可执行变异的锚点在源码里**恰好出现一次**)。
 *
 * 两部分:
 *  1. {@link B5_MUTATION_TABLE}:§11 全表的行级登记。每行的杀手用例是已合并各块里本来就有的测试(B5a / B5b / B5c / B5d / B5g 各自验收时跑过的变异),
 *     B5e 不重复执行,只登记「哪条变异由哪个测试文件杀」;B5e 自己拥有的行(持锁矩阵、零写入矩阵、A5 解析器)在 {@link B5E_MUTATIONS} 里**逐条可执行**。
 *  2. {@link B5E_MUTATIONS}:可执行变异(cp 备份 / cp 还原,**不用 git checkout / stash**;在 javis 私有检出里、假 HOME + 临时仓库下跑)。
 *     每条:`file` 里的 `anchor` 恰好出现一次 → 换成 `replacement`(可附加 `append` 到文件末尾)→ 跑 `tests` → 失败集合必须**非空**、**全部**命中 `expectRed`(= 只有该入口自己的杀手用例红,不是顺带全红)、
 *     没有 skipped、没有超时 / 构建错误;还原后逐文件 sha256 与备份一致;真实 HOME 前后不变。结果记在 {@link B5E_RESULTS}。
 *
 * 注意:`withRsiLockIfGated` 的调用点被换成「不拿锁、给一个 `assertHeld` 恒通过的假句柄」——命令照样走完业务,只是不再互斥;这是「删掉拿锁」最忠实的形态
 * (不是让它因为类型 / 缺字段而红)。
 */
export interface MutationRow {
  clause: string;
  entry: string;
  state: string;
  positive: string;
  negative: string;
  mutation: string;
  faultPoint: string;
  tests: readonly string[];
}

export interface Mutation {
  id: string;
  /** 对应 {@link B5_MUTATION_TABLE} 的哪一行(clause 前缀) */
  row: string;
  file: string;
  /** 恰好出现一次的锚点文本 */
  anchor: string;
  replacement: string;
  /** 追加到文件末尾的辅助函数 */
  append?: string;
  /** 变异后要跑的测试文件(相对 `test/`) */
  tests: readonly string[];
  /** 失败的测试名必须**全部**包含这些子串之一(不能顺带红别的入口) */
  expectRed: readonly string[];
  /** 这些子串必须**每一个**都命中至少一个失败用例(多入口共用一个调用点时,证明每条路径都被杀,不是只杀了一条) */
  mustKill: readonly string[];
}

const FAKE = `{ path: '', nonce: 'fake', assertHeld: async () => undefined, release: async () => undefined }`;
const NO_LOCK = `\nasync function noLockForTest<T>(_ctx: unknown, fn: (l: never) => Promise<T>, _o?: unknown): Promise<T> {\n  return fn(${FAKE} as never);\n}\n`;
const NO_WRITER_LOCK = `\nasync function noWriterLockForTest<T>(ctx: any, wiring: any, fn: (l: never, c: never) => Promise<T>): Promise<T> {\n  const cfg = wiring.rsiConfig !== undefined ? await wiring.rsiConfig() : await (await import('../rsi/config.js')).loadRsiConfig(ctx.env !== undefined ? { env: ctx.env } : {});\n  return fn(${FAKE} as never, cfg as never);\n}\n`;
const MKDIR_RSI = `await (await import('../io/safe-fs.js')).mkdirp(io, (await import('node:path')).join(io.stateDir, 'rsi'), 0o700);`;
const GHOST = (io: string): string =>
  `await (await import('../io/safe-fs.js')).writeFile(${io}, (await import('node:path')).join(${io}.stateDir, 'ghost.tmp'), 'x'); await (await import('../io/safe-fs.js')).remove(${io}, (await import('node:path')).join(${io}.stateDir, 'ghost.tmp'));`;
const GHOST_IO = GHOST('io');
const GHOST_CTX_IO = GHOST('ctx.io');
const MATRIX = ['rsi/b5-lock-matrix.test.ts'] as const;
const ZW = ['rsi/b5-zero-write.test.ts'] as const;

export const B5E_MUTATIONS: readonly Mutation[] = [
  // ---- R20-5.1 逐个删掉拿锁(每个单独红)
  {
    id: 'lock-removed:tick',
    row: 'R20-5.1 拿锁',
    file: 'src/rsi/tick.ts',
    anchor: 'const outcome = await withRsiLockIfGated(',
    replacement: 'const outcome = await noLockForTest(',
    append: NO_LOCK,
    tests: MATRIX,
    expectRed: ['tick --write'],
    mustKill: ['tick --write'],
  },
  {
    id: 'lock-removed:confirm',
    row: 'R20-5.1 拿锁',
    file: 'src/rsi/confirm.ts',
    anchor: 'const locked = await withRsiLockIfGated(',
    replacement: 'const locked = await noLockForTest(',
    append: NO_LOCK,
    tests: MATRIX,
    expectRed: ['confirm:'],
    mustKill: ['confirm:'],
  },
  {
    id: 'lock-removed:status-ack',
    row: 'R20-5.1 拿锁',
    file: 'src/rsi/status-ack.ts',
    anchor: 'const done = await withRsiLockIfGated(',
    replacement: 'const done = await noLockForTest(',
    append: NO_LOCK,
    tests: MATRIX,
    expectRed: ['status --ack'],
    mustKill: ['status --ack'],
  },
  {
    id: 'lock-removed:purge',
    row: 'R20-5.1 拿锁',
    file: 'src/rsi/purge.ts',
    anchor: 'const out = await withRsiLockIfGated(',
    replacement: 'const out = await noLockForTest(',
    append: NO_LOCK,
    tests: MATRIX,
    expectRed: ['purge --excluded --write', 'purge --resume --write'],
    mustKill: ['purge --excluded --write', 'purge --resume --write'],
  },
  {
    id: 'lock-removed:rebuild-index',
    row: 'R20-5.1 拿锁',
    file: 'src/rsi/projects-rebuild.ts',
    anchor: 'const done = await withRsiLockIfGated(',
    replacement: 'const done = await noLockForTest(',
    append: NO_LOCK,
    tests: MATRIX,
    expectRed: ['projects --rebuild-index --write'],
    mustKill: ['projects --rebuild-index --write'],
  },
  {
    id: 'lock-removed:collect',
    row: 'R20-5.1 拿锁',
    file: 'src/commands/signals-collect.ts',
    anchor: 'return await withRsiLockIfGated({ io: ctx.io, config }, execute, deps.lockDeps);',
    replacement: 'return await noLockForTest({ io: ctx.io, config }, execute, deps.lockDeps);',
    append: NO_LOCK,
    tests: MATRIX,
    expectRed: ['signals collect'],
    mustKill: ['signals collect'],
  },
  {
    id: 'lock-removed:promote',
    row: 'R20-5.1 拿锁',
    file: 'src/commands/promote.ts',
    anchor: 'return withRsiLockIfGated(',
    replacement: 'return noLockForTest(',
    append: NO_LOCK,
    tests: MATRIX,
    expectRed: ['promote --run --write'],
    mustKill: ['promote --run --write'],
  },
  {
    id: 'lock-removed:reflect-gc',
    row: 'R20-5.1 拿锁',
    file: 'src/commands/reflect.ts',
    anchor: '? await withRsiWriterLock(ctx, wiring, async (lock) => {',
    replacement: '? await noWriterLockForTest(ctx, wiring, async (lock) => {',
    append: NO_WRITER_LOCK,
    tests: MATRIX,
    expectRed: ['reflect --gc --write'],
    mustKill: ['reflect --gc --write'],
  },
  {
    id: 'lock-removed:reflect-run-llm',
    row: 'R20-5.1 拿锁',
    file: 'src/commands/reflect.ts',
    anchor: 'return live ? await withRsiWriterLock(ctx, deps, execute) : await execute(null);',
    replacement:
      'return live ? await noWriterLockForTest(ctx, deps, execute) : await execute(null);',
    append: NO_WRITER_LOCK,
    tests: MATRIX,
    expectRed: ['reflect --run-llm', 'reflect / judge --run-llm'],
    mustKill: ['reflect --run-llm'],
  },
  {
    id: 'lock-removed:judge-run-llm',
    row: 'R20-5.1 拿锁',
    file: 'src/commands/judge.ts',
    anchor:
      'return args.runLlm ? await withRsiWriterLock(ctx, deps, execute) : await execute(null);',
    replacement:
      'return args.runLlm ? await noWriterLockForTest(ctx, deps, execute) : await execute(null);',
    append: NO_WRITER_LOCK,
    tests: MATRIX,
    expectRed: ['judge --run-llm', 'reflect / judge --run-llm'],
    mustKill: ['judge --run-llm'],
  },
  // ---- 闸门恒真 / 恒假 / refuse 变 off
  {
    id: 'gate-always-lock',
    row: 'R20-5.1 拿锁',
    file: 'src/rsi/with-lock.ts',
    anchor: "case 'off':\n      return fn(null);",
    replacement: "case 'off':\n      return withRsiLock(ctx.io, (lock) => fn(lock), opts.lock);",
    tests: MATRIX,
    expectRed: ['未启用', 'legacy'],
    mustKill: ['未启用'],
  },
  {
    id: 'gate-never-lock',
    row: 'R20-5.1 拿锁',
    file: 'src/rsi/with-lock.ts',
    anchor: "case 'lock':\n      return withRsiLock(ctx.io, (lock) => fn(lock), opts.lock);",
    replacement: `case 'lock':\n      return fn(${FAKE} as never);`,
    tests: MATRIX,
    expectRed: ['持锁', '未启用'],
    mustKill: ['持锁'],
  },
  {
    id: 'gate-refuse-as-off',
    row: 'R20-5.1 拿锁',
    file: 'src/rsi/with-lock.ts',
    anchor: "case 'refuse':\n      throw new RsiFailClosedError(gate.reason);",
    replacement: "case 'refuse':\n      return fn(null);",
    tests: ['rsi/with-lock.test.ts'],
    expectRed: ['refuse'],
    mustKill: ['refuse'],
  },
  // ---- 持锁拒绝前「建了又删」:树比较抓不到,只有写审计抓得到(证明 reflect / judge 的审计不是硬编码空数组)
  {
    id: 'audit:write-delete-before-lock:tick',
    row: 'R20-5.1 拿锁',
    file: 'src/rsi/tick.ts',
    anchor: 'const outcome = await withRsiLockIfGated(',
    replacement: `${GHOST_IO} const outcome = await withRsiLockIfGated(`,
    tests: MATRIX,
    expectRed: ['tick --write'],
    mustKill: ['tick --write'],
  },
  {
    id: 'audit:write-delete-before-lock:reflect-run-llm',
    row: 'R20-5.1 拿锁',
    file: 'src/commands/reflect.ts',
    anchor: 'return live ? await withRsiWriterLock(ctx, deps, execute) : await execute(null);',
    replacement: `if (live) { ${GHOST_CTX_IO} }\n        return live ? await withRsiWriterLock(ctx, deps, execute) : await execute(null);`,
    tests: MATRIX,
    expectRed: ['reflect --run-llm'],
    mustKill: ['reflect --run-llm'],
  },
  {
    id: 'audit:write-delete-before-lock:judge-run-llm',
    row: 'R20-5.1 拿锁',
    file: 'src/commands/judge.ts',
    anchor:
      'return args.runLlm ? await withRsiWriterLock(ctx, deps, execute) : await execute(null);',
    replacement: `if (args.runLlm) { ${GHOST_CTX_IO} }\n        return args.runLlm ? await withRsiWriterLock(ctx, deps, execute) : await execute(null);`,
    tests: MATRIX,
    expectRed: ['judge --run-llm'],
    mustKill: ['judge --run-llm'],
  },
  // ---- §10.1 零写入矩阵:干跑 / 被拒路径偷偷写
  {
    id: 'zw:tick-dry-creates-dir',
    row: 'R20-3.1.1',
    file: 'src/rsi/tick.ts',
    anchor: '  let plan: L0Plan;',
    replacement: `  ${MKDIR_RSI}\n  let plan: L0Plan;`,
    tests: ZW,
    expectRed: ['rsi tick(无 --write)', '被中断'],
    mustKill: ['rsi tick(无 --write)'],
  },
  {
    id: 'zw:rebuild-dry-creates-dir',
    row: 'R20-3.1.1',
    file: 'src/rsi/projects.ts',
    anchor: '      planned = await planRebuildForWrite(io, config, l0);',
    replacement: `      ${MKDIR_RSI}\n      planned = await planRebuildForWrite(io, config, l0);`,
    tests: ZW,
    expectRed: ['rebuild-index(干跑)', '被中断'],
    mustKill: ['rebuild-index(干跑)'],
  },
  {
    id: 'zw:purge-dry-creates-dir',
    row: 'R20-3.1.1',
    file: 'src/rsi/purge.ts',
    anchor: '  const r = await resolvePurgeKeys(io, config, mode);',
    replacement: `  ${MKDIR_RSI}\n  const r = await resolvePurgeKeys(io, config, mode);`,
    tests: ZW,
    expectRed: ['rsi purge(无 --write'],
    mustKill: ['rsi purge(无 --write'],
  },
  {
    id: 'zw:confirm-declined-writes',
    row: 'R20-3.1.1',
    file: 'src/rsi/confirm.ts',
    anchor: "      ctx.stderr('RSI_CONFIRM_DECLINED\\n');",
    replacement: `      (await import('node:fs')).writeFileSync((await import('node:path')).join(ctx.cwd ?? '.', 'mutant-write.txt'), 'x');\n      ctx.stderr('RSI_CONFIRM_DECLINED\\n');`,
    tests: ZW,
    expectRed: ['DECLINED'],
    mustKill: ['DECLINED'],
  },
  {
    id: 'zw:confirm-recheck-after-recover',
    row: 'D2 / 锁内顺序',
    file: 'src/rsi/confirm.ts',
    anchor: '        const { obs: obs3, gate: g3 } = await observeChecked(io, ctx.env);',
    replacement:
      "        await (await import('./services/commit.js')).recoverUnderLock(sctx, lock);\n        const { obs: obs3, gate: g3 } = await observeChecked(io, ctx.env);",
    tests: ZW,
    expectRed: ['confirm 锁后 STALE'],
    mustKill: ['confirm 锁后 STALE'],
  },
  {
    id: 'zw:purge-recheck-after-recover',
    row: 'D2 / 锁内顺序',
    file: 'src/rsi/purge.ts',
    anchor: '      // ① 无副作用复检(直读;先于 recover)',
    replacement:
      "      await (await import('./services/commit.js')).recoverUnderLock(sctx, lock);\n      // ① 无副作用复检(直读;先于 recover)",
    tests: ZW,
    expectRed: ['purge --write 锁后 NOT_EXCLUDED'],
    mustKill: ['purge --write 锁后 NOT_EXCLUDED'],
  },
];

/** 可执行变异的结果(javis 私有检出,cp 备份 / cp 还原;`killedBy` = 失败的测试名子串,`exit` = vitest 退出码,`skipped` 必须为 0) */
export interface MutationResult {
  id: string;
  killedBy: readonly string[];
  skipped: number;
  restored: boolean;
}
// 结果由运行脚本在 javis 上生成并并入本表(2026-10-28,22 条全部 KILLED:cp 备份 / cp 还原且 sha256 一致、假 HOME + 临时仓库、真实 HOME 前后不变、无 skipped、失败用例全部在 expectRed 内且每个 mustKill 都命中)。
// 运行脚本与原始结果(含失败用例全名)不入库,留在 agent-kit-wt/b5e-mutation-evidence/(b5e-mutate.mjs + results-20261028.json);未跑过的变异不得出现在这里
export const B5E_RESULTS: readonly MutationResult[] = [
  { id: 'lock-removed:tick', killedBy: ['tick --write'], skipped: 0, restored: true }, // 失败用例 2 个
  { id: 'lock-removed:confirm', killedBy: ['confirm:'], skipped: 0, restored: true }, // 失败用例 1 个
  { id: 'lock-removed:status-ack', killedBy: ['status --ack'], skipped: 0, restored: true }, // 失败用例 1 个
  {
    id: 'lock-removed:purge',
    killedBy: ['purge --excluded --write', 'purge --resume --write'],
    skipped: 0,
    restored: true,
  }, // 失败用例 2 个
  {
    id: 'lock-removed:rebuild-index',
    killedBy: ['projects --rebuild-index --write'],
    skipped: 0,
    restored: true,
  }, // 失败用例 1 个
  { id: 'lock-removed:collect', killedBy: ['signals collect'], skipped: 0, restored: true }, // 失败用例 1 个
  { id: 'lock-removed:promote', killedBy: ['promote --run --write'], skipped: 0, restored: true }, // 失败用例 1 个
  { id: 'lock-removed:reflect-gc', killedBy: ['reflect --gc --write'], skipped: 0, restored: true }, // 失败用例 1 个
  {
    id: 'lock-removed:reflect-run-llm',
    killedBy: ['reflect --run-llm', 'reflect / judge --run-llm'],
    skipped: 0,
    restored: true,
  }, // 失败用例 2 个
  {
    id: 'lock-removed:judge-run-llm',
    killedBy: ['judge --run-llm', 'reflect / judge --run-llm'],
    skipped: 0,
    restored: true,
  }, // 失败用例 2 个
  { id: 'gate-always-lock', killedBy: ['未启用', 'legacy'], skipped: 0, restored: true }, // 失败用例 3 个
  { id: 'gate-never-lock', killedBy: ['持锁', '未启用'], skipped: 0, restored: true }, // 失败用例 12 个
  { id: 'gate-refuse-as-off', killedBy: ['refuse'], skipped: 0, restored: true }, // 失败用例 4 个
  {
    id: 'audit:write-delete-before-lock:tick',
    killedBy: ['tick --write'],
    skipped: 0,
    restored: true,
  }, // 失败用例 2 个
  {
    id: 'audit:write-delete-before-lock:reflect-run-llm',
    killedBy: ['reflect --run-llm'],
    skipped: 0,
    restored: true,
  }, // 失败用例 1 个
  {
    id: 'audit:write-delete-before-lock:judge-run-llm',
    killedBy: ['judge --run-llm'],
    skipped: 0,
    restored: true,
  }, // 失败用例 1 个
  {
    id: 'zw:tick-dry-creates-dir',
    killedBy: ['rsi tick(无 --write)', '被中断'],
    skipped: 0,
    restored: true,
  }, // 失败用例 5 个
  {
    id: 'zw:rebuild-dry-creates-dir',
    killedBy: ['rebuild-index(干跑)', '被中断'],
    skipped: 0,
    restored: true,
  }, // 失败用例 6 个
  {
    id: 'zw:purge-dry-creates-dir',
    killedBy: ['rsi purge(无 --write'],
    skipped: 0,
    restored: true,
  }, // 失败用例 3 个
  { id: 'zw:confirm-declined-writes', killedBy: ['DECLINED'], skipped: 0, restored: true }, // 失败用例 1 个
  {
    id: 'zw:confirm-recheck-after-recover',
    killedBy: ['confirm 锁后 STALE'],
    skipped: 0,
    restored: true,
  }, // 失败用例 1 个
  {
    id: 'zw:purge-recheck-after-recover',
    killedBy: ['purge --write 锁后 NOT_EXCLUDED'],
    skipped: 0,
    restored: true,
  }, // 失败用例 1 个
];

export const B5_MUTATION_TABLE: readonly MutationRow[] = [
  {
    clause: 'R20-5.1 拿锁',
    entry:
      'tick --write / confirm / status --ack / purge --write(含 --resume)/ projects --rebuild-index --write / signals collect / reflect(--gc --write、--run-llm)/ judge --run-llm / promote --run --write',
    state: '真子进程持锁',
    positive:
      '各自退 4(RSI_NOT_RUN / SIGNALS_ / REFLECT_ / JUDGE_ / PROMOTE_NOT_RUN reason=locked),零写入、锁文件字节与 inode 不变,零构造零调用;放锁后同一命令走到精确的业务结果',
    negative: '未启用 [rsi] 时不建 .state/rsi/(legacy 写入方照常;rsi 自己的入口 4 off)',
    mutation:
      'lock-removed:tick;lock-removed:confirm;lock-removed:status-ack;lock-removed:purge;lock-removed:rebuild-index;lock-removed:collect;lock-removed:promote;lock-removed:reflect-gc;lock-removed:reflect-run-llm;lock-removed:judge-run-llm;audit:write-delete-before-lock:tick;audit:write-delete-before-lock:reflect-run-llm;audit:write-delete-before-lock:judge-run-llm;gate-always-lock;gate-never-lock;gate-refuse-as-off',
    faultPoint:
      '拿锁移到盐首建 / 读暂存区之后:collect 与 judge 的锁内顺序用例(collect-rsi-lock.test.ts 的「盐首建在锁内」、judge-rsi-lock.test.ts 的「构造后端之前持锁」)',
    tests: [
      'rsi/b5-lock-matrix.test.ts',
      'rsi/with-lock.test.ts',
      'signals/collect-rsi-lock.test.ts',
    ],
  },
  {
    clause: 'D1 状态树独立(lockGate off)',
    entry: 'judge / promote / reflect / collect',
    state: '启用 [rsi] 但状态树确定独立',
    positive: '不拿锁、行为逐字节不变;judge / promote 照样 enforce(Q-M)',
    negative: '—',
    mutation: '只要 on 就拿锁(lockGate 恒 lock);独立树放行 enforce',
    faultPoint: '—',
    tests: [
      'rsi/gate.test.ts',
      'commands/promote-rsi-gate.test.ts',
      'commands/judge-rsi-gate.test.ts',
    ],
  },
  {
    clause: 'D2 / 锁内顺序',
    entry: 'confirm / purge --write(tick、ack、rebuild 同理)',
    state: '锁后 STALE / NOT_EXCLUDED + 预置 snapshot.json.tmp 与未完成提交',
    positive:
      '审计恰好是锁文件的 createExclusive + remove(外加 .state/、rsi/ 的 mkdirp);.tmp 与清单字节不变',
    negative: '同一夹具不被拒绝时 recover 会处理(.tmp 被删)',
    mutation: 'zw:confirm-recheck-after-recover;zw:purge-recheck-after-recover',
    faultPoint: '锁前预检与拿锁之间改配置(afterLock 缝)',
    tests: [
      'rsi/b5-zero-write.test.ts',
      'rsi/b5b-confirm.test.ts',
      'rsi/b5c-cmd.test.ts',
      'rsi/b5a-tick.test.ts',
    ],
  },
  {
    clause: 'R20-3.1.1 / §20.8.1',
    entry: 'tick 干跑 / projects --rebuild-index 干跑 / purge 干跑 / confirm DECLINED、锁前 STALE',
    state:
      'off / 首次 armed / 失效后 armed / confirmed / stopped / busy / 盐违规(+ 无盐、journal、invalid journal、NOT_EXCLUDED、K 空)',
    positive: '进程内写审计 [] + 前后树不变 + 子进程 KIT_WRITE_ROOTS=: 同码、无 write_denied',
    negative:
      '正向对照:rsi stop 记到 createExclusive、空写入根下退 3 write_denied;建了又删只有审计抓得到',
    mutation:
      'zw:tick-dry-creates-dir;zw:rebuild-dry-creates-dir;zw:purge-dry-creates-dir;zw:confirm-declined-writes',
    faultPoint: '干跑在头部读取的 beforeStep 里挂起 + SIGTERM(tick 与 rebuild 各一)',
    tests: ['rsi/b5-zero-write.test.ts', 'rsi/readonly-zero-write.test.ts'],
  },
  {
    clause: '§20.9 第 16 条 A5',
    entry: 'ops/lib/zero-write.mjs 按行允许退出码;ops/accept/lib/a5.mjs 两环境',
    state: '行尾 # exit=…;off / armed 两个环境各两轮',
    positive: '声明只对本行、替换默认集合;allowed_exit 进命令记录;预置 config.toml 逐项不变',
    negative:
      '不合法声明 = 清单违规退 4;引号内不是声明;声明不吞 64 / 信号 / spawn 错误;没有预置的环境不放宽',
    mutation: '声明全局放开;声明追加而非替换默认集合;预置路径进白名单;不核对前置快照',
    faultPoint: '—',
    tests: ['ops/zero-write-exit-decl.test.ts', 'accept/a5.test.ts'],
  },
  {
    clause: 'R20-3.1.2 熔断 / 不预写 attempt',
    entry: 'tick --write',
    state: 'safety / retryable 打开',
    positive: '成功后 breaker=null;skip 类不改',
    negative: '—',
    mutation: '成功不清熔断;熔断打开时拒绝执行;预写 attempt',
    faultPoint: '—',
    tests: ['rsi/b5a-tick.test.ts'],
  },
  {
    clause: 'armed / confirmed 检查点',
    entry: 'tick --write',
    state: 'armed / confirmed',
    positive: 'armed 正常完成;confirmed 收紧排除 → binding_changed 且数据文件不变',
    negative: '检查点看到 STOP → stopped',
    mutation:
      '用 createCheckpoint(恒判 binding_changed);检查点不比对绑定;complete:false 时持久化 armed_listing',
    faultPoint: '读到第 1000 行时改配置;列举中途改 agents',
    tests: ['rsi/b5a-tick.test.ts', 'rsi/l0-binding-real.test.ts'],
  },
  {
    clause: 'R20-3.6.1 / 3.6.3 confirm',
    entry: 'confirm',
    state: '非 TTY / 等待输入期间改 agents、排除、repo、overlay、STOP',
    positive: '2 not_tty 不读输入;STALE 零写入;DECLINED 零写入',
    negative: '输入非 yes → DECLINED',
    mutation:
      '先读状态再判 TTY;不重算指纹;指纹缺 stop;先删 STOP 再写 state;不清 armed_listing;baseline_pending:false',
    faultPoint: 'state 写完、STOP 删除之前崩溃 → 仍是 stopped,重跑成功',
    tests: [
      'rsi/b5b-confirm.test.ts',
      'rsi/b5b-confirm-stopfail.test.ts',
      'rsi/b5b-confirm-proc.test.ts',
    ],
  },
  {
    clause: 'R20-3.4.3 / R20-3.5.5 ack / rebuild',
    entry: 'status --ack / projects --rebuild-index --write',
    state: '有索引 / 旧索引无效且 ack=40',
    positive: 'ack=generation;新 generation > 40',
    negative: '非 TTY 退 2;索引无效退 3;列举不完整且旧索引无效 → 不写',
    mutation: 'ack 改 baseline;generation 不取 max;taint 放在写索引之前',
    faultPoint: '写 state 之后、commit 之前崩溃;写索引之后、counts 之前崩溃',
    tests: ['rsi/b5a-ack-rebuild.test.ts'],
  },
  {
    clause: 'R20-3.8 purge / journal / salvage',
    entry: 'purge(含 --resume、salvage)与 tick 续做',
    state: '五阶段每个边界 + 每个月文件重写前后 + salvage 的 S1..S4',
    positive: '续做完成结果与不崩溃一致,第二遍零写入;月文件永不删除',
    negative: 'unreadable → 3;> 5000 → 3 且零写入',
    mutation:
      '删空月文件;续做从信号库重推目标;cursor 先于信号库;把 invalid 当 absent;S1 不做原子替换;done 时重扫月文件',
    faultPoint: '每个阶段之间、月文件重写前后、done 与删除之间',
    tests: [
      'rsi/b5c-engine.test.ts',
      'rsi/b5c-salvage.test.ts',
      'rsi/b5c-cmd.test.ts',
      'rsi/b5c-rework.test.ts',
    ],
  },
  {
    clause: 'R20-4.7 taint 时机',
    entry: 'tick(两种状态)/ confirm / rebuild / purge',
    state: '刚写下排除',
    positive: '命中 run 的摘录全空、TAINTED 在场',
    negative: '—',
    mutation: '去掉 taintNewlyExcluded;rebuild 把 taint 放在索引之前',
    faultPoint: 'taint 中途崩溃 → 下一个写入方补完',
    tests: [
      'rsi/taint.test.ts',
      'rsi/b5a-tick.test.ts',
      'rsi/b5a-ack-rebuild.test.ts',
      'rsi/b5b-confirm.test.ts',
    ],
  },
  {
    clause: 'R20-4.8 judge / promote 即时闸',
    entry: 'judge 干跑 / 真跑;promote --run 干跑 / --write',
    state: 'X / U / journal / cfg_* / TAINTED 目录',
    positive: '退 1 / 1 / 3 / 3,零 LLM 调用零输出;legacy 逐字节不变',
    negative: 'TAINTED 检查不论闸门结果;未 taint 且一致 → 0',
    mutation:
      '去掉任一回调;cfg_* 当 legacy;闸只放在 runJudge 外层;去掉闸 #2;仍报 PROMOTE_RUN_EXISTS',
    faultPoint: '第一次调用之后收紧排除;闸 #1 之后、写之前改排除',
    tests: [
      'commands/judge-rsi-gate.test.ts',
      'commands/promote-rsi-gate.test.ts',
      'commands/judge-rsi-lock.test.ts',
    ],
  },
  {
    clause: '§20.9 第 8 条 collect',
    entry: 'signals collect(非 --dry)',
    state: '闸门 on',
    positive: '盐在锁内首建;索引 / counts / 清单更新;cursor 不变(Q-E)',
    negative: '闸门 off → 逐字节不变',
    mutation: '盐首建移回锁外;collect 写了 cursor;roots 的 key 用错盐',
    faultPoint: 'C1 / C2 / C3 之后崩溃 → 下一个写入方恢复',
    tests: ['signals/collect-rsi-lock.test.ts', 'signals/b5e-collect-leftovers.test.ts'],
  },
  {
    clause: 'staged / reflect / judge 锁内 recover',
    entry: 'reflect / judge',
    state: 'counts 存在、缺失、盐不符',
    positive: '只写 staged / 写四段',
    negative: '盐缺失 → 不写',
    mutation: '只写 staged 导致 counts「权威但残缺」;掺入 X 推导',
    faultPoint: '写 run 之后、counts 之前崩溃',
    tests: ['commands/b5d-staged.test.ts', 'commands/reflect-rsi-lock.test.ts'],
  },
  {
    clause: 'gc 不调 resumeTaint',
    entry: 'reflect --gc --write',
    state: '超过 5000 个 run',
    positive: 'gc 照常',
    negative: '—',
    mutation: 'gc 加上 resumeTaint(会被 staging_too_large 挡住)',
    faultPoint: '—',
    tests: ['commands/reflect-rsi-lock.test.ts', 'rsi/b5-lock-matrix.test.ts'],
  },
  {
    clause: '失锁',
    entry: '全部新写点',
    state: '—',
    positive: '换掉 nonce 之后写审计为 0',
    negative: '—',
    mutation: '去掉任一写点前的 assertHeld',
    faultPoint: '在每一类写操作之前换 nonce(k 遍历)',
    tests: [
      'rsi/b5a-services.test.ts',
      'rsi/b5c-engine.test.ts',
      'rsi/b5b-confirm.test.ts',
      'rsi/l0-write-faults.test.ts',
    ],
  },
  {
    clause: '闭包',
    entry: '新入口',
    state: '—',
    positive: '闭包里没有 llm / net;status / projects 仍只读;tick 链闭包被真实覆盖',
    negative: '变异:往 reflect/load.ts 加 llm-exec / net;projects.ts 引入 projects-rebuild.ts',
    mutation: 'projects.ts import projects-rebuild.ts;reflect/load.ts import llm-exec',
    faultPoint: '—',
    tests: [
      'rsi/b5-static.test.ts',
      'rsi/import-closure.test.ts',
      'rsi/readonly-zero-write.test.ts',
    ],
  },
  {
    clause: '§0.5 R7 不可达',
    entry: '静态',
    state: 'B5a 之后',
    positive: '没有生产写入者写 purge-journal.json(白名单只有 purge-journal.ts)',
    negative: '—',
    mutation: '在任意 src 文件里加一个写调用',
    faultPoint: '—',
    tests: ['rsi/b5a-journal-unreachable.test.ts'],
  },
  {
    clause: '§0.5 R8 发布冻结',
    entry: 'check-publish / release / ci',
    state: '有 RELEASE_FREEZE',
    positive: 'PUBLISH_FROZEN 退 1;prepublishOnly 拦下;version 变了 CI 红',
    negative: '删掉文件后通过',
    mutation: '去掉任一检查',
    faultPoint: '—',
    tests: ['build/publish-freeze.test.ts'],
  },
];
