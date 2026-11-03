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
    expectRed: ['先写后印:第一次 stderr 写入发生时', '首次:先采集、后提案各一行', '锁被占'],
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
    expectRed: ['具名里有一个不是待审 → 整批拒', '已忽略的 run 再具名'],
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
    expectRed: ['输出(text / json)不含 HOME', '一切正常 → ok'],
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
    expectRed: ['零写入、不拿锁、不清理残留', '一切正常 → ok'],
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
export const A6_RESULTS: readonly A6Result[] = [];
