/**
 * B4c2 变异与故障注入表(B4 方案 §7 中归 B4c2 的部分)。每行:条款 | 入口 / 模式 | 状态 | 正向 | 反向 | 变异(变异后对应测试必须红)| 故障点。
 * `mutation` 的名字就是变异脚本里的名字;`tests` 是应当变红的测试文件;`l0-mutation-table.test.ts` 只核对表自身的完整性(引用的测试文件存在、字段非空)。
 * 变异一律在 javis 私有检出里用 cp 备份 / cp 还原做(不用 git checkout),还原后逐文件 sha256 核对。
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

export const B4C2_MUTATION_TABLE: readonly MutationRow[] = [
  {
    clause: 'R20-6.9 提交顺序',
    entry: 'runL0UnderLock / commitL0',
    state: 'confirmed,首次采集',
    positive: '盐 → 信号库 → 索引 → counts → state → cursor → 清单(写点序号严格递增)',
    negative: '—',
    mutation: 'order-cursor-before-signals;order-state-before-counts',
    faultPoint: '每个写点前崩溃(l0-crash-matrix)',
    tests: ['l0-commit.test.ts', 'l0-run-abort.test.ts'],
  },
  {
    clause: 'B3b-4 / D16 失锁',
    entry: '所有写操作(信号库 / 会话计数 / 盐首建 / 固定文件 / counts / 日志 / 清单)',
    state: '首次 + 增量两个场景',
    positive:
      '每类写点都出现在写点清单里(防 k 遍历空转);第 k 个写点前换 nonce → lock_lost,之后写审计零增长',
    negative: '写点流与记录一致(k ↔ 写点一一对应)',
    mutation:
      'gate-without-assertHeld;gate-missing-chmod-tmp-signals;gate-missing-mkdirp-signals;gate-missing-chmod-final-sessions;gate-missing-salt-create',
    faultPoint: 'k = 1..N 全遍历(lose lock)',
    tests: ['l0-write-faults.test.ts', 'l0-crash-matrix.test.ts'],
  },
  {
    clause: '[A1] cursor 不推进',
    entry: 'commitL0',
    state: '#1..#5 abort',
    positive: '信号库已写;被跳过的数据步骤确实没写;重跑去重追平',
    negative: 'cursor.json 字节不变',
    mutation:
      'cursor-advances-on-abort;a1-sessions-not-skipped;a1-index-not-skipped;a1-skips-counts',
    faultPoint: '在 C1 / C2 / C3 / C4 / C5 之间中止',
    tests: ['l0-run-abort.test.ts'],
  },
  {
    clause: '[A0] 零数据提交',
    entry: 'runL0UnderLock',
    state: '#pre / 读阶段 / #0 abort',
    positive: '不中止的对照确实改变数据文件;state 与清单已提交',
    negative: '信号库 / 会话计数 / 索引 / cursor 逐字节不变;counts 无变化则不重写',
    mutation: 'a0-read-abort-still-commits-data',
    faultPoint: '读阶段第一个文件前 / #0',
    tests: ['l0-run-abort.test.ts'],
  },
  {
    clause: '墙钟在提交阶段',
    entry: 'commitL0 / createCheckpoint',
    state: '时钟在 C1 之前越过 120 秒',
    positive: '提交走完(stage full、cursor 已写);读阶段同一时钟确实返回 time_limit',
    negative: 'commit 检查点永不返回 time_limit(含桩违规时按 continue)',
    mutation: 'wallclock-blocks-commit',
    faultPoint: '时钟在 C1 前跳过 120s',
    tests: ['l0-run-abort.test.ts'],
  },
  {
    clause: 'R20-4.5 clusters(D13-A)',
    entry: 'commitL0',
    state: 'C1 之后崩溃,重跑新增为 0',
    positive: 'clusters 仍含上次已入库的信号',
    negative: '—',
    mutation: 'clusters-only-when-new-signals',
    faultPoint: 'C2 第一个写点前崩溃',
    tests: ['l0-commit.test.ts', 'l0-crash-matrix.test.ts'],
  },
  {
    clause: 'R20-4.5 staged(只写 TAINTED 事实)',
    entry: 'commitL0',
    state: '证据 key 属 X 但无 TAINTED;手放 TAINTED(本次无新增 taint)',
    positive: 'TAINTED 在场 → 下一次提交校正为 true',
    negative: '无 TAINTED → 仍 false(不掺 X 推导);只改 tainted 一个字段',
    mutation: 'staged-mixes-x-derivation;staged-never-corrected-full;staged-never-corrected-a0',
    faultPoint: 'taint 之后、C4 之前',
    tests: ['l0-commit.test.ts', 'l0-run-abort.test.ts'],
  },
  {
    clause: 'R20-4.2 / D7 索引可写条件',
    entry: 'commitL0',
    state: '损坏 / 盐不符 / 缺失但 cursor 在',
    positive: '首次(索引与 cursor 都缺失)建立索引',
    negative: '三种不可写情形索引字节不变、信号照写',
    mutation: 'index-writable-always',
    faultPoint: '—',
    tests: ['l0-commit.test.ts'],
  },
  {
    clause: 'updateIndex.full ≠ status index_full',
    entry: 'commitL0',
    state: '索引已满(10000)',
    positive: '满索引 + 新项目 → indexFullDropped,信号照写并计入 U',
    negative: '满索引 + 没有新观测 → 不报',
    mutation: 'index-full-conflated',
    faultPoint: '—',
    tests: ['l0-commit.test.ts'],
  },
  {
    clause: 'D10 baseline_pending 只 true → false',
    entry: 'commitL0 / state-mutate',
    state: '确认后第一次成功 L0',
    positive: 'ack = 本次索引 generation;之后不再推进',
    negative: '中止的运行不 ack;mutator 改回 true 无效;坏 confirm 原样透传',
    mutation: 'confirm-not-carried;ack-on-aborted-run;bad-confirm-normalized',
    faultPoint: 'C3 之后崩溃(ack 取新 generation)',
    tests: ['l0-commit.test.ts', 'l0-run-abort.test.ts', 'l0-plan.test.ts'],
  },
  {
    clause: 'D2 armed_listing',
    entry: 'runArmedUnderLock / state-mutate',
    state: '首次 armed(无盐)',
    positive: '完整列举 → 写入计数字段;不建盐、不写任何数据文件',
    negative: 'complete === false → 不持久化,保持磁盘原值;mutator 塞的值无效',
    mutation: 'armed-listing-persisted-when-incomplete;armed-field-ignores-complete',
    faultPoint: '—',
    tests: ['l0-plan.test.ts'],
  },
  {
    clause: 'D15 空盐',
    entry: 'runL0UnderLock / reclaimEmptySalt',
    state: '盐首建后崩溃留下空文件',
    positive: '持锁 + 满 10 秒 → 删除重建,采集继续',
    negative: '不足 10 秒 → salt_invalid 不删;不持锁不删;非空 / 违规盐不回收',
    mutation: 'salt-reclaim-ignores-grace;salt-reclaim-without-lock',
    faultPoint: '盐首建的 mkdirp / chmod / salt-create 前失锁',
    tests: ['l0-crash-matrix.test.ts'],
  },
  {
    clause: 'R20-3.1.1 干跑零写入',
    entry: 'planL0',
    state: 'armed / confirmed / 盐不存在',
    positive: '真跑确实写(审计可见)且读到的文件数与计划一致',
    negative: '写审计 0 + 目录树前后相同;signals_new 为 null',
    mutation: 'plan-imports-write-exit',
    faultPoint: '快照不一致 → busy',
    tests: ['l0-closure.test.ts', 'l0-plan.test.ts'],
  },
  {
    clause: '提交前无副作用复检',
    entry: 'commitL0',
    state: '信号库带病',
    positive: '审计在记录(锁的写)',
    negative: '锁以外零写入、数据文件不变',
    mutation: 'no-precommit-inspect',
    faultPoint: '—',
    tests: ['l0-run-abort.test.ts'],
  },
  {
    clause: 'R20-6.9 epoch(4001 文件)',
    entry: 'runL0UnderLock',
    state: '4001 个会话文件',
    positive: '2000 / 2000 / 1 三次提交后 done;每文件一个 epoch 读一次;信号 4001 条',
    negative: 'done 之后不再读',
    mutation: '(B4b 的 cursor 变异在 l0-cursor-budget-binding.test.ts;本块只做端到端覆盖)',
    faultPoint: '—',
    tests: ['l0-full-scan-4001.test.ts'],
  },
];
