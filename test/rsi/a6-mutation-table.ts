/**
 * R20-A6 必杀变异(契约 §20.17 R20-17.26 的 15 个变异点 + A6 自己加的几条):每条变异后必须有测试红,且只红该条款自己的杀手用例。
 * 执行方式同 A3 / A4 / A5(`a5-mutation-table.ts`):javis 私有检出里 cp 备份 → 按锚点替换(每个锚点在对应文件里**恰好出现一次**)→ 跑 `tests` →
 * 失败集合非空、全部命中 `expectRed`、`mustKill` 每项至少命中一个、没有 skipped → cp 还原并逐文件 sha256 核对。**不用 git checkout / stash 还原**。
 * 本文件只写表与每条变异期望红的测试名(`expectRed` 是杀手测试源码里的字面子串;`it.each` / 模板生成的标题只写源码里有的片段);
 * 变异由主代理在 javis 上执行,结果记进 `A6_RESULTS`(A6 实装块不执行变异,故留空)。
 * 契约 R20-17.26 的 15 个变异点与本表 id 的对应:
 *   待审判定漏掉 dismissed → pending-ignores-dismissed;待审判定漏掉当前 X / U 过滤 → pending-skips-attribution-filter;`run_id` 与目录名不核对 → pending-no-runid-check;
 *   提醒不记账(重复提示)→ notice-no-ledger;先印后写 → notice-print-before-write;提醒在非 TTY / `armed` / `stopped` 下输出 → notice-prints-non-tty、notice-prints-armed-stopped;
 *   超时后仍记账 → notice-records-after-timeout(写点)、notice-ignores-budget-in-scan(扫描);`notice.json` 损坏被当空重建 → notice-corrupt-rebuilt;
 *   dismiss 删或改 run 目录 → dismiss-mutates-run-dir;`dismissed.json` 损坏被覆盖 → dismiss-overwrites-corrupt;hint 达上限仍用旧模板 → hint-limit-old-template;
 *   D17 输出绝对路径 → d17-leaks-abs-path;D17 写文件或拿锁 → d17-writes-file、d17-takes-lock;doctor import `hooks-fs.ts` → doctor-imports-hooks-fs;
 *   status 的只读闭包引入 `safe-fs` → status-closure-safe-fs。
 *   另加:`notice_full` 差一(>=)、扫描子项上限差一、dismiss 具名整批拒变成部分接受。
 */
export interface Edit {
  file: string;
  anchor: string;
  replacement: string;
}

export interface A6Mutation {
  id: string;
  /** 契约里的变异点原文 */
  clause: string;
  edits: readonly Edit[];
  /** 相对 `test/` */
  tests: readonly string[];
  expectRed: readonly string[];
  mustKill: readonly string[];
}

export interface A6Result {
  id: string;
  failed: number;
  skipped: number;
  killedBy: readonly string[];
  restored: boolean;
}

const PENDING = 'rsi/a6-pending.test.ts';
const DISMISS = 'rsi/a6-dismiss.test.ts';
const NOTICE = 'rsi/a6-notice.test.ts';
const HINT = 'rsi/a6-hint-status.test.ts';
const DOCTOR = 'rsi/a6-doctor.test.ts';

export const A6_MUTATIONS: readonly A6Mutation[] = [
  {
    id: 'pending-ignores-dismissed',
    clause: '待审判定漏掉 dismissed',
    edits: [
      {
        file: 'src/rsi/pending.ts',
        anchor: 'if (input.dismissed.has(run.runId)) continue;',
        replacement: 'void 0;',
      },
    ],
    tests: [PENDING, DISMISS, HINT, NOTICE],
    expectRed: [
      '待审 = 暂存',
      '--all --write:只写 dismissed.json;run 目录逐字节不变',
      '漏掉 dismissed 的实现会被抓到',
      '已忽略的 run 再具名',
      '只计待审',
      '只计待通知 run',
      '具名:只忽略指定的 run;其余仍待审',
    ],
    mustKill: ['待审 = 暂存', '漏掉 dismissed 的实现会被抓到'],
  },
  {
    id: 'pending-skips-attribution-filter',
    clause: '待审判定漏掉当前 X / U 过滤',
    edits: [
      {
        file: 'src/rsi/pending.ts',
        anchor:
          "if (s.evidence_keys.length > 0 && s.evidence_keys.every((k) => classify(k) === 'P')) {",
        replacement: 'if (s.evidence_keys.length > 0) {',
      },
    ],
    tests: [PENDING, DISMISS, HINT],
    expectRed: [
      '含 X / 含 U 的都不是暂存 run',
      '归属按「当前」分类器现算',
      'ingest 之后写下排除',
      '项目根消失(变 U)',
      '写下排除、worker 尚未 taint',
    ],
    mustKill: ['归属按「当前」分类器现算', 'ingest 之后写下排除'],
  },
  {
    id: 'pending-no-runid-check',
    clause: '`run_id` 与目录名不核对',
    edits: [
      {
        file: 'src/rsi/pending.ts',
        anchor: 'if (p.success && p.data.run_id === run.runId) mode = p.data.mode;',
        replacement: 'if (p.success) mode = p.data.mode;',
      },
    ],
    tests: [PENDING, DISMISS, HINT],
    expectRed: ['待审 = 暂存', 'report.run_id 与目录名不同 → 不是待审:具名被拒', '只计待审'],
    mustKill: ['待审 = 暂存', 'report.run_id 与目录名不同 → 不是待审:具名被拒'],
  },
  {
    id: 'notice-no-ledger',
    clause: '提醒不记账(重复提示)',
    edits: [
      {
        file: 'src/rsi/notice.ts',
        anchor: 'await writeAccountingFile(',
        replacement: 'await Promise.resolve(',
      },
    ],
    tests: [NOTICE],
    expectRed: [
      '首次:先采集、后提案各一行',
      '新 run 出现',
      '重新 rsi confirm',
      '先写后印:第一次 stderr 写入发生时',
      '写完后 stderr 写失败',
      '原文件 1500 条但仍存在的只有 300 个、有 1 个新增 → 不是 full:提示发出,记账清理成「仍存在 ∪ 新增」',
      '1000 条仍存在 + 1 个新增 → full:提案提示不发、不新增任何 run_id;采集开始提示不受影响,仍先记账后打印',
      '锁内重算之后、首个写点之前超时:零记账写入(没有 notice.json 也没有 .tmp),无输出',
      'assertHeld 之后、tmp 创建之前 / rename 之前超时:不创建 tmp / 不 rename,无输出,notice.json 不产生',
      '正向对照:预算内同样的世界会落盘并打印',
    ],
    mustKill: ['首次:先采集、后提案各一行', '写完后 stderr 写失败'],
  },
  {
    id: 'notice-print-before-write',
    clause: '先印后写',
    edits: [
      {
        file: 'src/rsi/notice.ts',
        anchor: 'await writeAccountingFile(',
        replacement:
          "input.stderr('RSI_PROPOSALS_READY runs=1 proposals=1\\n');\n        await writeAccountingFile(",
      },
    ],
    tests: [NOTICE],
    expectRed: [
      '先写后印:第一次 stderr 写入发生时',
      '首次:先采集、后提案各一行',
      '锁被占',
      '新 run 出现 → 只出提案行(采集开始行不重复);baseline_pending = true → 没有采集开始行',
      '重新 rsi confirm(确认时刻变了)→ 下一次再提示一次采集开始',
      '写完后 stderr 写失败 → 漏提示但不重复:下一次不再提示(至多一次尝试展示)',
      '原文件 1500 条但仍存在的只有 300 个、有 1 个新增 → 不是 full:提示发出,记账清理成「仍存在 ∪ 新增」',
      '1000 条仍存在 + 1 个新增 → full:提案提示不发、不新增任何 run_id;采集开始提示不受影响,仍先记账后打印',
      '锁内重算之后、首个写点之前超时:零记账写入(没有 notice.json 也没有 .tmp),无输出',
      'assertHeld 之后、tmp 创建之前 / rename 之前超时:不创建 tmp / 不 rename,无输出,notice.json 不产生',
    ],
    mustKill: ['先写后印:第一次 stderr 写入发生时'],
  },
  {
    id: 'notice-prints-non-tty',
    clause: '提醒在非 TTY 下输出',
    edits: [
      {
        file: 'src/rsi/notice.ts',
        anchor: "if (!input.isTty) return { kind: 'skipped', why: 'not_tty' };",
        replacement: 'void 0;',
      },
    ],
    tests: [NOTICE],
    expectRed: ['非 TTY'],
    mustKill: ['非 TTY'],
  },
  {
    id: 'notice-prints-armed-stopped',
    clause: '提醒在 `armed` / `stopped` 下输出',
    edits: [
      {
        file: 'src/rsi/notice.ts',
        anchor: "obs.state.state !== 'confirmed' ||",
        replacement: 'false ||',
      },
      { file: 'src/rsi/notice.ts', anchor: "obs.stop !== 'absent' ||", replacement: 'false ||' },
      { file: 'src/rsi/notice.ts', anchor: "obs.doc.kind !== 'ok' ||", replacement: 'false ||' },
      {
        file: 'src/rsi/notice.ts',
        anchor: 'obs.doc.state.confirm === null',
        replacement: 'false',
      },
    ],
    tests: [NOTICE],
    expectRed: ['stopped', 'armed(无确认记录)一律不提醒'],
    mustKill: ['stopped', 'armed(无确认记录)一律不提醒'],
  },
  {
    id: 'notice-records-after-timeout',
    clause: '超时后仍记账(写点)',
    edits: [
      {
        file: 'src/rsi/services/fixed-write.ts',
        anchor: 'if (opts.overDeadline?.() === true) throw new AccountingDeadlineError();',
        replacement: 'void 0;',
      },
    ],
    tests: [NOTICE],
    expectRed: [
      '锁内重算之后、首个写点之前超时',
      'assertHeld 之后、tmp 创建之前 / rename 之前超时',
    ],
    mustKill: ['锁内重算之后、首个写点之前超时', 'assertHeld 之后、tmp 创建之前 / rename 之前超时'],
  },
  {
    id: 'notice-ignores-budget-in-scan',
    clause: '超时后仍记账(扫描)',
    edits: [
      {
        file: 'src/rsi/pending.ts',
        anchor:
          "if (deps.over?.() === true) return { known: false, reason: 'run_scan_budget', runDirs };",
        replacement: 'void 0;',
      },
    ],
    tests: [PENDING, NOTICE],
    expectRed: ['over() 为真(提醒的预算)', '入口之后立刻超时', '拿到锁之后超时'],
    mustKill: ['over() 为真(提醒的预算)'],
  },
  {
    id: 'notice-corrupt-rebuilt',
    clause: '`notice.json` 损坏被当空重建',
    edits: [
      {
        file: 'src/rsi/notice.ts',
        anchor: "if (notice.kind === 'invalid') return null;",
        replacement: 'void 0;',
      },
    ],
    tests: [NOTICE],
    expectRed: ['notice.json 损坏(schema / JSON / 权限)'],
    mustKill: ['notice.json 损坏(schema / JSON / 权限)'],
  },
  {
    id: 'dismiss-mutates-run-dir',
    clause: 'dismiss 删或改 run 目录',
    edits: [
      {
        file: 'src/rsi/dismiss.ts',
        anchor: 'await writeAccountingFile(',
        replacement:
          "await (await import('../io/safe-fs.js')).remove(sctx.io, path.join(sctx.io.stateDir, 'reflect', sel[0] as string));\n          await writeAccountingFile(",
      },
    ],
    tests: [DISMISS],
    expectRed: [
      '--all --write:只写 dismissed.json;run 目录逐字节不变',
      '窄记账:写审计只涉及',
      'TAINTED 已落盘但摘录未清完',
    ],
    mustKill: ['--all --write:只写 dismissed.json;run 目录逐字节不变'],
  },
  {
    id: 'dismiss-overwrites-corrupt',
    clause: '`dismissed.json` 损坏被覆盖',
    edits: [
      {
        file: 'src/rsi/dismiss.ts',
        // 写路径那一处(干跑路径另有同样的一行,后面跟的是 run_scan_incomplete 判定,锚点靠后续语句区分)
        anchor:
          "if (snap.dismissed.kind === 'invalid') throw new RsiFailClosedError('dismissed_invalid');\n          const sel = select(p, snap.scan);",
        replacement: 'const sel = select(p, snap.scan);',
      },
    ],
    tests: [DISMISS],
    expectRed: [
      '损坏:写路径退 3 RSI_FAIL_CLOSED reason=dismissed_invalid',
      '权限过宽(0644)同样算损坏',
    ],
    mustKill: ['损坏:写路径退 3 RSI_FAIL_CLOSED reason=dismissed_invalid'],
  },
  {
    id: 'dismiss-partial-batch',
    clause: '具名里有一个不是待审即整批拒(R20-17.7)',
    edits: [
      {
        file: 'src/rsi/dismiss.ts',
        anchor: "return p.ids.every((id) => set.has(id)) ? p.ids : 'run_not_pending';",
        replacement: 'return p.ids.filter((id) => set.has(id));',
      },
    ],
    tests: [DISMISS],
    expectRed: [
      '具名里有一个不是待审 → 整批拒',
      '已忽略的 run 再具名',
      'report.run_id 与目录名不同 → 不是待审:具名被拒',
      'ingest 之后写下排除、worker 尚未 taint:该 run 已不计入(dismiss 看不到它),status 同口径',
      '项目根消失(变 U):同样不计入',
    ],
    mustKill: ['具名里有一个不是待审 → 整批拒'],
  },
  {
    id: 'hint-limit-old-template',
    clause: 'hint 达上限仍用旧模板',
    edits: [
      {
        file: 'src/rsi/hint.ts',
        anchor: 'if (scan.runDirs >= RSI_STAGING_MAX_RUNS) {',
        replacement: 'if (false) {',
      },
    ],
    tests: [HINT],
    expectRed: ['目录数 ≥ 50 → 输出换成满区单行'],
    mustKill: ['目录数 ≥ 50 → 输出换成满区单行'],
  },
  {
    id: 'd17-leaks-abs-path',
    clause: 'D17 输出绝对路径',
    edits: [
      {
        file: 'src/doctor/rsi-face.ts',
        anchor: 'items: warns,',
        replacement: 'items: [...warns, a.home],',
      },
    ],
    tests: [DOCTOR],
    expectRed: [
      '输出(text / json)不含 HOME',
      '一切正常 → ok',
      'warn:stopped / armed / 暂存达到 run 上限 / unreadable_runs / dismissed_invalid / notice_invalid / run_scan_truncated',
      '经 doctor:钩子残留报 hooks_residue(不报漂移),退出码 0;facts 带 hooks_residue 数量',
      '零写入、不拿锁、不清理残留:目录树前后一致;另一个存活进程持锁时 D17 照常给出结论(不被锁挡住,也不回收别人的锁)',
    ],
    mustKill: ['输出(text / json)不含 HOME'],
  },
  {
    id: 'd17-writes-file',
    clause: 'D17 写文件',
    edits: [
      {
        file: 'src/doctor/rsi-face.ts',
        anchor: 'const data = await readRsiState(io);',
        replacement:
          "await (await import('../io/safe-fs.js')).writeFile(io, `${io.stateDir}/d17-probe`, 'x');\n    const data = await readRsiState(io);",
      },
    ],
    tests: [DOCTOR],
    expectRed: ['零写入、不拿锁、不清理残留'],
    mustKill: ['零写入、不拿锁、不清理残留'],
  },
  {
    id: 'd17-takes-lock',
    clause: 'D17 拿锁',
    edits: [
      {
        file: 'src/doctor/rsi-face.ts',
        anchor: 'const data = await readRsiState(io);',
        replacement:
          "await (await (await import('../rsi/lock.js')).acquireRsiLock(io)).release();\n    const data = await readRsiState(io);",
      },
    ],
    tests: [DOCTOR],
    expectRed: [
      '零写入、不拿锁、不清理残留',
      '一切正常 → ok',
      'state / 计数读不了或 schema 不过 → fail;私有区目录不安全 → fail 且退出 1(不新增顶层 fail-closed)',
      'doctor 命令的 import 闭包(',
    ],
    mustKill: ['零写入、不拿锁、不清理残留'],
  },
  {
    id: 'doctor-imports-hooks-fs',
    clause: 'doctor import `hooks-fs.ts`',
    edits: [
      {
        file: 'src/doctor/rsi-face.ts',
        anchor: "import { HooksRead } from '../io/hooks-read.js';",
        replacement:
          "import { HooksRead } from '../io/hooks-read.js';\nimport '../io/hooks-fs.js';",
      },
    ],
    tests: [DOCTOR],
    expectRed: ['doctor 命令的 import 闭包'],
    mustKill: ['doctor 命令的 import 闭包'],
  },
  {
    id: 'status-closure-safe-fs',
    clause: 'status 的只读闭包引入 `safe-fs`',
    edits: [
      {
        file: 'src/rsi/status.ts',
        anchor: "import { canonicalJson } from '../io/canonical-json.js';",
        replacement:
          "import { canonicalJson } from '../io/canonical-json.js';\nimport '../io/safe-fs.js';",
      },
    ],
    tests: ['rsi/readonly-zero-write.test.ts'],
    expectRed: ['不含写出口 / 锁 / 快照写侧 / 子进程出口文件'],
    mustKill: ['不含写出口 / 锁 / 快照写侧 / 子进程出口文件'],
  },
  {
    id: 'notice-full-off-by-one',
    clause: '`notice_full` 唯一谓词(R20-17.14a)差一',
    edits: [
      {
        file: 'src/rsi/pending.ts',
        anchor: 'return union.size > RSI_NOTICE_MAX;',
        replacement: 'return union.size >= RSI_NOTICE_MAX;',
      },
    ],
    tests: [PENDING, NOTICE],
    expectRed: [
      '恰好 1000 条仍存在且 T 为空 → 不是 full',
      '恰好 1000 条仍存在且无新增 → 不是 full',
      '1000 条仍存在 + 1 个新增 → full;新增的就在 S 里(并集不变)→ 不是 full',
    ],
    mustKill: ['恰好 1000 条仍存在且 T 为空 → 不是 full'],
  },
  {
    id: 'scan-entry-cap-off-by-one',
    clause: '扫描子项上限(R20-17.4)差一',
    edits: [
      {
        file: 'src/rsi/pending.ts',
        anchor: 'if (entries.length > maxEntries)',
        replacement: 'if (entries.length >= maxEntries)',
      },
    ],
    tests: [PENDING],
    expectRed: ['恰好 1000 个子项仍然已知'],
    mustKill: ['恰好 1000 个子项仍然已知'],
  },
];

/** 实测结果(主代理在 javis 上执行变异后填写;A6 实装块不执行,故留空) */
export const A6_RESULTS: readonly A6Result[] = [
  // 2026-11-03 javis 私有检出 @ df5b18c:基线 125 例全绿、0 skipped;21 条变异全部被杀、无 skipped / 套件错误 / 表外多红,每条还原后检出干净;
  // javis HOME 的 agent 配置与 kit 状态前后不变。首轮(@ eea4621)7 条多红了表外相关用例(已补登 expectRed);pending-no-runid-check 首轮漏杀
  // 「run_id 与目录名不同 → 具名被拒」:该用例的 report 过不了 schema、因「读不了」被拒而测不到 run_id 核对,已改为合法 report 后被杀。
  {
    id: 'pending-ignores-dismissed',
    killedBy: [
      '--all --write:只写 dismissed.json;run 目录逐字节不变;status 待审 0;人读输出不含路径',
      '具名:只忽略指定的 run;其余仍待审',
      '已忽略的 run 再具名 → 不是待审 → run_not_pending;--all 没有待审 → 退 0 unchanged,dismissed.json 字节不变',
      '只计待审:可读 report 的暂存 run 计入;已忽略 / report 缺失 / run_id 不符不计;与 status.pending_proposals 对拍',
      '漏掉 dismissed 的实现会被抓到:全部忽略后 M=0,K<3 且 n=0 → hint 空输出、零写入',
      '只计待通知 run:手动 --run-llm(mode=llm)、已忽略、已通知的都不提醒',
      '待审 = 暂存 ∧ report 可读且 run_id 一致 ∧ 未忽略;待通知再要求 mode=ingest 且未通知;读不了 / 不一致 / 目录缺失计入 unreadable',
    ],
    failed: 7,
    skipped: 0,
    restored: true,
  },
  {
    id: 'pending-skips-attribution-filter',
    killedBy: [
      'ingest 之后写下排除、worker 尚未 taint:该 run 已不计入(dismiss 看不到它),status 同口径',
      '项目根消失(变 U):同样不计入',
      '写下排除、worker 尚未 taint:该 run 立即不计入(X 过滤);项目根消失(U)同理',
      'tainted / 证据为空 / 含 X / 含 U 的都不是暂存 run;结果按 run_id 升序',
      '归属按「当前」分类器现算:同一份磁盘数据,分类器把证据判成 X / U 后立刻不再计入',
    ],
    failed: 5,
    skipped: 0,
    restored: true,
  },
  {
    id: 'pending-no-runid-check',
    killedBy: [
      'report.run_id 与目录名不同 → 不是待审:具名被拒',
      '只计待审:可读 report 的暂存 run 计入;已忽略 / report 缺失 / run_id 不符不计;与 status.pending_proposals 对拍',
      '待审 = 暂存 ∧ report 可读且 run_id 一致 ∧ 未忽略;待通知再要求 mode=ingest 且未通知;读不了 / 不一致 / 目录缺失计入 unreadable',
    ],
    failed: 3,
    skipped: 0,
    restored: true,
  },
  {
    id: 'notice-no-ledger',
    killedBy: [
      '首次:先采集、后提案各一行(格式固定,无路径 / run_id / 提案正文);记账 notice.json(0600);再跑零输出零写入',
      '新 run 出现 → 只出提案行(采集开始行不重复);baseline_pending = true → 没有采集开始行',
      '重新 rsi confirm(确认时刻变了)→ 下一次再提示一次采集开始',
      '先写后印:第一次 stderr 写入发生时 notice.json 已落盘且 rsi/lock 已释放',
      '写完后 stderr 写失败 → 漏提示但不重复:下一次不再提示(至多一次尝试展示)',
      '原文件 1500 条但仍存在的只有 300 个、有 1 个新增 → 不是 full:提示发出,记账清理成「仍存在 ∪ 新增」',
      '1000 条仍存在 + 1 个新增 → full:提案提示不发、不新增任何 run_id;采集开始提示不受影响,仍先记账后打印',
      '锁内重算之后、首个写点之前超时:零记账写入(没有 notice.json 也没有 .tmp),无输出',
      'assertHeld 之后、tmp 创建之前 / rename 之前超时:不创建 tmp / 不 rename,无输出,notice.json 不产生',
      '正向对照:预算内同样的世界会落盘并打印',
    ],
    failed: 10,
    skipped: 0,
    restored: true,
  },
  {
    id: 'notice-print-before-write',
    killedBy: [
      '首次:先采集、后提案各一行(格式固定,无路径 / run_id / 提案正文);记账 notice.json(0600);再跑零输出零写入',
      '新 run 出现 → 只出提案行(采集开始行不重复);baseline_pending = true → 没有采集开始行',
      '重新 rsi confirm(确认时刻变了)→ 下一次再提示一次采集开始',
      '先写后印:第一次 stderr 写入发生时 notice.json 已落盘且 rsi/lock 已释放',
      '写完后 stderr 写失败 → 漏提示但不重复:下一次不再提示(至多一次尝试展示)',
      '锁被占(另一个存活进程)→ 不提示、不记账;放锁后恢复',
      '原文件 1500 条但仍存在的只有 300 个、有 1 个新增 → 不是 full:提示发出,记账清理成「仍存在 ∪ 新增」',
      '1000 条仍存在 + 1 个新增 → full:提案提示不发、不新增任何 run_id;采集开始提示不受影响,仍先记账后打印',
      '锁内重算之后、首个写点之前超时:零记账写入(没有 notice.json 也没有 .tmp),无输出',
      'assertHeld 之后、tmp 创建之前 / rename 之前超时:不创建 tmp / 不 rename,无输出,notice.json 不产生',
    ],
    failed: 10,
    skipped: 0,
    restored: true,
  },
  {
    id: 'notice-prints-non-tty',
    killedBy: ['非 TTY'],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'notice-prints-armed-stopped',
    killedBy: ['stopped', 'armed(无确认记录)一律不提醒'],
    failed: 2,
    skipped: 0,
    restored: true,
  },
  {
    id: 'notice-records-after-timeout',
    killedBy: [
      '锁内重算之后、首个写点之前超时:零记账写入(没有 notice.json 也没有 .tmp),无输出',
      'assertHeld 之后、tmp 创建之前 / rename 之前超时:不创建 tmp / 不 rename,无输出,notice.json 不产生',
    ],
    failed: 2,
    skipped: 0,
    restored: true,
  },
  {
    id: 'notice-ignores-budget-in-scan',
    killedBy: ['over() 为真(提醒的预算)→ known:false run_scan_budget'],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'notice-corrupt-rebuilt',
    killedBy: [
      'notice.json 损坏(schema / JSON / 权限)→ 不覆盖、不重建、不提醒;status 报 notice_invalid',
    ],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'dismiss-mutates-run-dir',
    killedBy: [
      '--all --write:只写 dismissed.json;run 目录逐字节不变;status 待审 0;人读输出不含路径',
      '窄记账:写审计只涉及 rsi/lock、rsi/dismissed.json 及其 .tmp,不碰 reflect/、counts / state / snapshot / log',
      'TAINTED 已落盘但摘录未清完:dismiss 只写 dismissed.json,不碰任何 run(不承担 taint 前置)',
    ],
    failed: 3,
    skipped: 0,
    restored: true,
  },
  {
    id: 'dismiss-overwrites-corrupt',
    killedBy: [
      '损坏:写路径退 3 RSI_FAIL_CLOSED reason=dismissed_invalid,文件字节不变(不覆盖、不重建);干跑同样退 3',
      '权限过宽(0644)同样算损坏',
    ],
    failed: 2,
    skipped: 0,
    restored: true,
  },
  {
    id: 'dismiss-partial-batch',
    killedBy: [
      '具名里有一个不是待审 → 整批拒(退 4 run_not_pending),零写入、dismissed.json 不产生',
      '已忽略的 run 再具名 → 不是待审 → run_not_pending;--all 没有待审 → 退 0 unchanged,dismissed.json 字节不变',
      'report.run_id 与目录名不同 → 不是待审:具名被拒',
      'ingest 之后写下排除、worker 尚未 taint:该 run 已不计入(dismiss 看不到它),status 同口径',
      '项目根消失(变 U):同样不计入',
    ],
    failed: 5,
    skipped: 0,
    restored: true,
  },
  {
    id: 'hint-limit-old-template',
    killedBy: [
      '目录数 ≥ 50 → 输出换成满区单行(≤ 200 字节、不暗示 dismiss 能释放容量),即使 M / K / n 都为 0;30 分钟去重同旧',
    ],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'd17-leaks-abs-path',
    killedBy: [
      'confirmed 且一切正常 → ok;facts 只含枚举 / 计数 / 布尔(pending_runs=1 等)',
      'warn:stopped / armed / 暂存达到 run 上限 / unreadable_runs / dismissed_invalid / notice_invalid / run_scan_truncated',
      '经 doctor:钩子残留报 hooks_residue(不报漂移),退出码 0;facts 带 hooks_residue 数量',
      '输出(text / json)不含 HOME、仓库根、KIT_TMP、状态目录的绝对路径,也不含假 HOME 里的用户名样目录名 alice',
      '零写入、不拿锁、不清理残留:目录树前后一致;另一个存活进程持锁时 D17 照常给出结论(不被锁挡住,也不回收别人的锁)',
    ],
    failed: 5,
    skipped: 0,
    restored: true,
  },
  {
    id: 'd17-writes-file',
    killedBy: [
      '零写入、不拿锁、不清理残留:目录树前后一致;另一个存活进程持锁时 D17 照常给出结论(不被锁挡住,也不回收别人的锁)',
    ],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'd17-takes-lock',
    killedBy: [
      'state / 计数读不了或 schema 不过 → fail;私有区目录不安全 → fail 且退出 1(不新增顶层 fail-closed)',
      '零写入、不拿锁、不清理残留:目录树前后一致;另一个存活进程持锁时 D17 照常给出结论(不被锁挡住,也不回收别人的锁)',
      'doctor 命令的 import 闭包(运行时):含 hooks-read.ts、不含 hooks-fs.ts 与写侧钩子 / 锁 / 快照写文件',
      'doctor 命令的 import 闭包(含类型):含 hooks-read.ts、不含 hooks-fs.ts 与写侧钩子 / 锁 / 快照写文件',
    ],
    failed: 4,
    skipped: 0,
    restored: true,
  },
  {
    id: 'doctor-imports-hooks-fs',
    killedBy: [
      'doctor 命令的 import 闭包(运行时):含 hooks-read.ts、不含 hooks-fs.ts 与写侧钩子 / 锁 / 快照写文件',
      'doctor 命令的 import 闭包(含类型):含 hooks-read.ts、不含 hooks-fs.ts 与写侧钩子 / 锁 / 快照写文件',
    ],
    failed: 2,
    skipped: 0,
    restored: true,
  },
  {
    id: 'status-closure-safe-fs',
    killedBy: [
      'src/rsi/status.ts(运行时依赖):不含写出口 / 锁 / 快照写侧 / 子进程出口文件,无写相关标识符,无动态 import',
      'src/rsi/status.ts(含类型依赖):不含写出口 / 锁 / 快照写侧 / 子进程出口文件,无写相关标识符,无动态 import',
      'src/rsi/projects.ts(运行时依赖):不含写出口 / 锁 / 快照写侧 / 子进程出口文件,无写相关标识符,无动态 import',
      'src/rsi/projects.ts(含类型依赖):不含写出口 / 锁 / 快照写侧 / 子进程出口文件,无写相关标识符,无动态 import',
    ],
    failed: 4,
    skipped: 0,
    restored: true,
  },
  {
    id: 'notice-full-off-by-one',
    killedBy: [
      '恰好 1000 条仍存在且 T 为空 → 不是 full',
      '1000 条仍存在 + 1 个新增 → full;新增的就在 S 里(并集不变)→ 不是 full',
    ],
    failed: 2,
    skipped: 0,
    restored: true,
  },
  {
    id: 'scan-entry-cap-off-by-one',
    killedBy: ['恰好 1000 个子项仍然已知;1001 个 → known:false run_scan_truncated(不当作零)'],
    failed: 1,
    skipped: 0,
    restored: true,
  },
];
