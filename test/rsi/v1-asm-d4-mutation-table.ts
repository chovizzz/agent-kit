/**
 * §21 V1 装配块 D4(digest 冷却过滤 / A6 待审口径 / auto-view 构造与写端口)必杀变异
 * (契约 R21-11.1、R21-3.8 段末、§21.24 W0-22 第 7 条 / W0-24;设计稿 verify_r21-asm-d-design.md §7)。
 * 执行方式同 W5 / W6 / W7 / W8 / 装配 A:验证机私有检出里 cp 备份 → 按锚点替换(每个锚点在对应文件里**恰好出现一次**)→ 跑 `tests` →
 * 失败集合非空、全部命中 `expectRed`、`mustKill` 每项至少命中一个、没有 skipped → cp 还原并逐文件 sha256 核对。**不用 git checkout / stash 还原**。
 * 本文件只写表与每条变异期望红的测试名(`expectRed` 是杀手测试名里的字面子串);变异由主代理 / 验证机执行,结果记进 `V1_ASM_D4_RESULTS`(与表**同序**;未执行时留空)。
 * 不在本表的点(如实记录):①「冷却簇不占 5 簇名额」的位置变异(把过滤挪到 `slice` 之后)没有简单的单点替换,由 `d4-digest-cooldown.test.ts` 的「先于 5 簇截断」用例正面断言、未设变异;
 * ②last_rollback 同刻取 id 最小的比较在 prettier 后是多行表达式,单点替换锚点不稳,由用例正面断言、未设变异;③生产适配器(读 effects 账)与 worker 接线不在本块,无对应变异。
 */
export interface Edit {
  file: string;
  anchor: string;
  replacement: string;
}

export interface V1AsmD4Mutation {
  id: string;
  /** 契约条款 / 该不变量 */
  clause: string;
  edits: readonly Edit[];
  /** 相对 `test/` */
  tests: readonly string[];
  expectRed: readonly string[];
  mustKill: readonly string[];
}

export interface V1AsmD4Result {
  id: string;
  failed: number;
  skipped: number;
  killedBy: readonly string[];
  restored: boolean;
}

const swap = (file: string, anchor: string, replacement: string): Edit => ({
  file,
  anchor,
  replacement,
});

const PEND = 'src/rsi/pending.ts';
const CONV = 'src/rsi/pending-converted.ts';
const COOL = 'src/rsi/digest-cooldown.ts';
const DIG = 'src/rsi/digest.ts';
const VB = 'src/rsi/personal/view-build.ts';
const VW = 'src/rsi/personal/view-write.ts';
const T_PEND = 'rsi/d4/d4-pending.test.ts';
const T_COOL = 'rsi/d4/d4-digest-cooldown.test.ts';
const T_VIEW = 'rsi/d4/d4-view.test.ts';
const T_CLOS = 'rsi/d4/d4-closure.test.ts';

/**
 * 每个杀手测试文件里的全部用例名(字面子串)。**expectRed 取「变异专属用例 ∪ 其杀手测试文件的全部用例」**(宽),原因:单点变异会连带打红同文件里
 * 其它带对应断言的用例(含对照分支),72 条逐一手推容易漏,漏了就是实跑时的「计划外红」;装配 A 段同样补宽过一轮。**必杀(mustKill)保持最小**,
 * 只列该变异专属的用例。由 `m()` 合并,不手写。
 */
const RED_BY_TEST: Readonly<Record<string, readonly string[]>> = {
  'rsi/d4/d4-pending.test.ts': [
    '正向对照:没有候选副本 → 整个 run 待审、待通知,proposals 是原数',
    '部分转化:仍待审,proposals 变为剩余数(待审与待通知一致)',
    '全部转化:run 不再待审、不再待通知(但仍是暂存 run);其它 run 的副本不影响本 run',
    'counts 的提案数与报告暂存编号(去重)个数不一致 → 该 run 转化未知,不扣减(不隐藏未转化的提案);基数一致才扣(对照)',
    'proposals = 0 的 run 保持改前行为(仍待审)',
    '没有待审 run(没有暂存 run / 暂存 run 都已忽略)时不读候选目录(即使它不安全也不影响)',
    '工作副本的 source 指向本 run、但提案编号不属于它(误写 / 伪造)→ 不扣减真实提案;对照:编号属于它则扣减',
    '转化读取阶段时间预算用尽:扫描仍 known,待审 / 待通知 = 未扣减的旧结果,converted=budget;预算充足时才扣减(对照)',
    '字节预算与报告读取共用同一个总量上限:报告读完只剩 10 字节 → budget、不扣减;余量充足 → 扣减(对照)',
    '候选目录权限过宽(不安全)→ converted=unsafe,整个 run 仍待审;恢复权限后扣减(对照)',
    '候选目录是符号链接 → unsafe,不跟随',
    '坏文件(非 JSON / schema 不过 / 文件名与 id 不符 / 过大)不参与扣减并计入 unreadable;好文件照常扣减',
    '条目数超过上限 → truncated,不给部分结果(一份都不扣);上限内 → ok(对照)',
    '总字节预算 / 调用方时间预算用尽 → budget,不给部分结果',
    '读取上限在读之前按剩余总量设置:文件恰好等于剩余量 → ok;少 1 字节 → budget(不是坏文件);第二个文件无剩余 → budget',
    '候选目录里的非副本名(临时文件 / 点文件 / 目录)被忽略,不算坏文件',
    '扫描前后目录树不变(只读)',
    '提醒(notice):RSI_PROPOSALS_READY 的 proposals= 是剩余数;全部转化后什么都不提示、不记账',
    '报告暂存编号里有重复:即使去重个数恰好等于 counts 的提案数也不扣',
    '`.state/rsi` 本身是指向外部目录的符号链接',
    '`.state/rsi` 不存在 → missing',
  ],
  'rsi/d4/d4-digest-cooldown.test.ts': [
    '未注入端口 → null(未接线,不过滤);注入后原样返回 ok 集合',
    '把「今天」按 UTC 日传给端口(带偏移的时间按 UTC 折算;UTC 日界两侧不同)',
    '端口报告 unavailable:带稳定短码原样保留;短码不合格式(路径 / 异常文本)→ invalid_result',
    '端口抛错 / 返回形状不对(ok 但 active 不是 Set、未知 kind)→ unavailable,不当成「没有冷却」',
    '元素必须是非空字符串(Set<number> / Set<object> / 混合 / 含空串)→ unavailable,不当成「没有命中」',
    '合法集合被复制:适配器读完后再改它,不影响本次结果',
    '未接线 / 未读 → 永远不过滤',
    '命中判定:全部成员的 id 或可作证据成员的 id 任一在冷却集合里 → 冷却;都不在 → 不冷却(对照);空集合 → 不冷却',
    '聚类 id 算不出(null)→ 该簇不在冷却账里(不可能被提成过候选);算 id 抛错 → 按冷却中处理(fail-closed)',
    '端口读不到(unavailable)→ 所有簇都在冷却中,与簇内容无关',
    '报告:未接线 / 未读(已注入但无可提的簇)/ ok / unavailable 四种形状固定',
    '基线(无过滤)→ 8,4,3,3,2;冷却集合不命中时与基线逐项相同(对照)',
    '冷却中的最大簇被丢弃且先于 5 簇截断:原本被挤掉的 1 条簇补位;cooldownDropped 计 1',
    '只数「本来会被提」的簇:只有其它项目有证据的冷却簇不计数(它本来就不入选);同一簇两种证据口径只数一次',
    '读不到冷却事实(unavailable)→ 一个簇也不提,6 个本来会被提的簇全部计入 cooldownDropped',
    '冷却丢弃发生在单条闸之前:被冷却的簇不增加 evidenceDropped / clustersEmptied',
    '未接线 → 与改前相同(2 个簇、clusters_dropped=0),报告 not_wired',
    '正向对照:接线但冷却集合为空 → 与未接线输出相同;端口收到的是 UTC 今天',
    '命中冷却的簇不进摘要(文本不出现),计入 truncated.clusters_dropped;另一个簇照常',
    '读不到冷却事实(端口 unavailable)→ fail-closed:空摘要 reason=no_clusters,两个簇都计入丢弃,退出码仍 0',
    '项目被排除(没有可提的簇)→ 已注入的端口不被调用,报告 skipped;摘要 reason=project_excluded',
    '端口抛错 → 同样 fail-closed,原因 source_threw(异常文本不外泄)',
    '常量钉死:10000 条 / 单个 256 字节 / 累计 1 MiB',
    '条数:恰好 10000 → ok;10001 → unavailable(too_large)',
    '单个 id:恰好 256 字节 → ok;257 字节 → too_large',
    '累计字节:4096 个 256 字节的 id',
    '适配器覆盖迭代器 / size 的 Set 子类',
    '非原生 Set(Proxy / 鸭子类型 / 数组)→ invalid_result',
    'cooldownDropped 口径 = 冷却前具备初始证据的簇',
  ],
  'rsi/d4/d4-view.test.ts': [
    '夹具里的记录都过 PersonalLifecycleRecordSchema(否则下面的断言没有意义)',
    '空快照:每个 lifecycle 状态一个键(0)、四个终态 0、canary / last_rollback 为 null、两个清单空且未截断;过 AutoViewSchema',
    'record_oid 就是输入的权威 HEAD(purge 改写后换了 HEAD,视图跟着换)',
    'pipeline.states 按状态计数',
    '输出与记录输入顺序无关(确定性)',
    '边界:今天 / 前 29 日计入;前 30 日 / 未来日不计;非终态转移、deploy 维度转移不计',
    '取最近一次进入 rolled_back 的转移:at 最晚;同刻取 id 最小;reason 是该转移的原因码',
    '没有进入过 rolled_back → null(不是占位对象);对照:进入 rolling_back 但未完成不算',
    '有 canary 且有分组计数 → {id, treat, control};没有 canary → null',
    '有 canary 但没有它的分组计数 → 不产出(canary_stats_missing);别的候选的计数不能顶替',
    '同时有两个 canary(不变量被破坏)→ 不产出(canary_ambiguous),不挑一个',
    'rolling_back 与 retiring 都列;entered_at 取进入当前状态的最后一次 lifecycle 转移;origin_reason / target_terminal 来自 rollback;最久的在前',
    '找不到进入当前状态的转移(历史被截断)→ 不产出(rolling_back_entry_unknown),不编造时间;补上转移即可产出(对照)',
    '至多 64 条:恰好 64 条不截断;65 条保留最久的 64 条并置 rolling_back_truncated',
    '第 90 个 UTC 日当天移除、前一天仍保留(边界);标记不依赖候选状态',
    '同 (id, mark) 只留最新;同一候选的两种标记各保留;按 at 降序、同刻按 id',
    '至多 64 条:恰好 64 条不截断;65 条保留最新的 64 条(最老的被截)并置 protection_marks_truncated',
    '预算越界 / 负数 / 非十六进制 oid / 非整数计数 → schema_invalid;正向对照:合法值产出',
    '字节均值四舍五入取整(契约是整数);0 与边界 100 合法',
    '标记 / 转移里的时间戳无法解析(日期运算抛错)→ input_invalid,不外抛;对照:合法时间戳产出',
    '写成功:文件 0600、没有临时文件;读侧读回 fresh 且与写入的视图逐键相等;record_oid 不变',
    '再次写入整体替换旧视图(不是合并):读侧看到新的 as_of 与 oid',
    '写前就丢锁 → lock_lost,不创建文件;已有旧视图则原样不动',
    '写的中途(临时文件已建、rename 之前)丢锁 → 旧视图原样不动;RsiLockError(lock_lost) 报 lock_lost,其它错误报 write_failed',
    'rename 失败(目标位置是非空目录)→ write_failed;临时文件被清掉,旧内容(目录)原样不动,不抛错',
    '视图对象本身读取即抛错(奇异对象)→ invalid_view,不外抛,零写入',
    '视图不合 schema(跨信任边界再校验)→ invalid_view,零写入;对照:同一端口写合法视图成功',
    'transitions_dropped > 0 本身不拒绝重建',
    '终态记录里找不到进入该终态的 lifecycle 转移 → history_incomplete',
    '同一 id 的两条记录(非 canary、终态均可)→ input_invalid',
    '违规视图报 invalid_view(不是 write_failed)',
    'last_rollback.reason / rolling_back[].origin_reason 不在转移原因码枚举里',
    'pipeline.states 的键不是生命周期状态集合',
  ],
  'rsi/d4/d4-closure.test.ts': [
    'pending.ts / pending-converted.ts(',
    '对照:写端口 view-write.ts 的闭包含 safe-fs 与写标识符(上面的断言确实能报出写依赖)',
    'view-build.ts 的闭包(含类型)没有写出口 / 锁 / 子进程,无写标识符,外部依赖只有 zod / crypto / path',
    'digest-cooldown.ts 与 digest.ts 的闭包不含候选源(clusterId 由装配处注入)与写出口之外的新依赖',
  ],
};

const m = (
  id: string,
  clause: string,
  edits: readonly Edit[],
  tests: readonly string[],
  red: readonly string[],
  must: readonly string[] = red,
): V1AsmD4Mutation => ({
  id,
  clause,
  edits,
  tests,
  expectRed: [...new Set([...red, ...tests.flatMap((t) => RED_BY_TEST[t] ?? [])])],
  mustKill: must,
});

export const V1_ASM_D4_MUTATIONS: readonly V1AsmD4Mutation[] = [
  // ---- A6:待审不计已成候选的提案 ----
  m(
    'pend_no_deduction',
    'R21-3.8:已成候选的提案不再算待审——不扣减',
    [
      swap(
        PEND,
        'o.run.proposals - convertedCount(converted, o.run.runId, o.ids)',
        'o.run.proposals',
      ),
    ],
    [T_PEND],
    ['部分转化:仍待审,proposals 变为剩余数', '全部转化:run 不再待审'],
    ['部分转化:仍待审,proposals 变为剩余数'],
  ),
  m(
    'pend_partial_as_done',
    '部分转化的 run 仍待审:改成只要有一个转化就整 run 不再待审',
    [
      swap(
        PEND,
        'if (rest === 0 && o.run.proposals > 0) continue;',
        'if (rest < o.run.proposals) continue;',
      ),
    ],
    [T_PEND],
    ['部分转化:仍待审,proposals 变为剩余数'],
  ),
  m(
    'pend_zero_proposals_dropped',
    'proposals=0 的 run 保持改前行为(仍待审)',
    [swap(PEND, 'if (rest === 0 && o.run.proposals > 0) continue;', 'if (rest === 0) continue;')],
    [T_PEND],
    ['proposals = 0 的 run 保持改前行为(仍待审)'],
  ),
  m(
    'pend_notice_uses_total',
    '待通知的 proposals 取扣减后的剩余数',
    [swap(PEND, 'toNotify.push(ref);', 'toNotify.push(o.run);')],
    [T_PEND],
    ['部分转化:仍待审,proposals 变为剩余数', '提醒(notice):RSI_PROPOSALS_READY'],
    ['部分转化:仍待审,proposals 变为剩余数'],
  ),
  m(
    'pend_pending_uses_total',
    '待审的 proposals 取扣减后的剩余数',
    [swap(PEND, 'pending.push(ref);', 'pending.push(o.run);')],
    [T_PEND],
    ['部分转化:仍待审,proposals 变为剩余数'],
  ),
  m(
    'pend_state_not_reported',
    '数据源状态如实上报(unsafe / truncated / budget / missing / ok)',
    [swap(PEND, 'converted: converted.state,', "converted: 'ok',")],
    [T_PEND],
    ['候选目录权限过宽(不安全)', '正向对照:没有候选副本'],
    ['候选目录权限过宽(不安全)'],
  ),
  m(
    'pend_reads_without_staged',
    '没有暂存 run 时不读候选目录',
    [swap(PEND, 'open.length === 0', 'false')],
    [T_PEND],
    ['没有待审 run(没有暂存 run / 暂存 run 都已忽略)时不读候选目录'],
  ),
  m(
    'conv_other_run_deducted',
    '扣减按 run_id 分组:别的 run 的副本不能扣本 run',
    [
      swap(
        CONV,
        'const done = converted.byRun.get(runId);',
        'const done = [...converted.byRun.values()].reduce((a, x) => new Set([...a, ...x]), new Set<string>());',
      ),
    ],
    [T_PEND],
    ['全部转化:run 不再待审'],
  ),
  m(
    'pend_cardinality_unchecked',
    '两份来源基数一致才扣减:counts 提案数 = report 暂存编号去重个数',
    [
      swap(
        PEND,
        'const consistent = o.ids.length === new Set(o.ids).size && o.ids.length === o.run.proposals;',
        'const consistent = true;',
      ),
    ],
    [T_PEND],
    ['counts 的提案数与报告暂存编号(去重)个数不一致'],
  ),
  m(
    'conv_foreign_id_deducted',
    '扣减只认报告里真实存在的提案编号(source 指向本 run 但编号不属于它不扣)',
    [swap(CONV, 'for (const id of new Set(stagedIds)) if (done.has(id)) n++;', 'n = done.size;')],
    [T_PEND],
    ['工作副本的 source 指向本 run、但提案编号不属于它'],
  ),
  m(
    'pend_total_budget_unshared',
    '字节预算与报告读取共用同一个总量上限(R20-17.4)',
    [swap(PEND, 'const left = Math.max(0, maxTotal - total);', 'const left = maxTotal;')],
    [T_PEND],
    ['字节预算与报告读取共用同一个总量上限'],
  ),
  m(
    'conv_unsafe_dir_read',
    '候选目录不安全 = 转化未知,不扣减',
    [swap(CONV, "if (st.kind === 'unsafe') return unknown('unsafe');", 'void 0;')],
    [T_PEND],
    ['候选目录权限过宽(不安全)', '候选目录是符号链接'],
    ['候选目录权限过宽(不安全)'],
  ),
  m(
    'conv_truncated_partial',
    '条目超过上限 = 转化未知,不给部分结果',
    [swap(CONV, "if (entries.length > maxEntries) return unknown('truncated');", 'void 0;')],
    [T_PEND],
    ['条目数超过上限'],
  ),
  m(
    'conv_byte_budget_ignored',
    '总字节预算:读之前按剩余总量设上限',
    [
      swap(
        CONV,
        'const cap = Math.min(maxFile, Math.max(0, maxTotal - total));',
        'const cap = maxFile;',
      ),
    ],
    [T_PEND],
    ['总字节预算 / 调用方时间预算用尽', '读取上限在读之前按剩余总量设置'],
  ),
  m(
    'conv_cap_overrun_as_bad_file',
    '被剩余预算卡住的超限不是坏文件,而是预算用尽',
    [
      swap(
        CONV,
        "if (r.kind === 'unsafe' && r.why === 'too_large' && cap < maxFile) return unknown('budget');",
        'void 0;',
      ),
    ],
    [T_PEND],
    ['读取上限在读之前按剩余总量设置', '总字节预算 / 调用方时间预算用尽'],
    ['读取上限在读之前按剩余总量设置'],
  ),
  m(
    'conv_time_budget_ignored',
    '调用方时间预算用尽 = 转化未知',
    [swap(CONV, "if (deps.over?.() === true) return unknown('budget');", 'void 0;')],
    [T_PEND],
    ['总字节预算 / 调用方时间预算用尽', '转化读取阶段时间预算用尽'],
  ),
  m(
    'conv_name_id_unchecked',
    '文件名与内容里的 id 不符的副本不可信',
    [swap(CONV, 'if (copy === null || copy.id !== m[1]) {', 'if (copy === null) {')],
    [T_PEND],
    ['坏文件(非 JSON / schema 不过'],
  ),
  m(
    'closure_pending_converted_writes',
    'A6 读侧闭包只读:pending-converted.ts 引入写出口',
    [
      swap(
        CONV,
        "import * as path from 'node:path';",
        "import '../io/safe-fs.js';\nimport * as path from 'node:path';",
      ),
    ],
    [T_CLOS],
    ['pending.ts / pending-converted.ts('],
  ),

  // ---- digest 冷却过滤 ----
  m(
    'cd_filter_disabled',
    'R21-11.1:冷却中的聚类不进 digest——过滤失效',
    [swap(DIG, 'if (cooled?.(c.members, eligible) === true) {', 'if (false as boolean) {')],
    [T_COOL],
    ['冷却中的最大簇被丢弃且先于 5 簇截断', '命中冷却的簇不进摘要'],
    ['冷却中的最大簇被丢弃且先于 5 簇截断'],
  ),
  m(
    'cd_drop_not_counted',
    '冷却丢弃计入 clusters_dropped(簇计数)',
    [swap(DIG, 'if (mine.length >= 1) cooldownDropped++;', 'void 0;')],
    [T_COOL],
    ['冷却中的最大簇被丢弃且先于 5 簇截断', '只数「本来会被提」的簇'],
    ['冷却中的最大簇被丢弃且先于 5 簇截断'],
  ),
  m(
    'cd_count_not_rendered',
    '冷却丢弃数并入 truncated.clusters_dropped',
    [swap(DIG, 'clustersEmptied: clustersEmptied + cooldownDropped,', 'clustersEmptied,')],
    [T_COOL],
    ['命中冷却的簇不进摘要'],
  ),
  m(
    'cd_port_not_threaded',
    'runDigest 把冷却端口接进取舍',
    [
      swap(
        DIG,
        'makeCooldownFilter(deps.cooldown, coolRead),',
        'makeCooldownFilter(undefined, null),',
      ),
    ],
    [T_COOL],
    ['命中冷却的簇不进摘要'],
  ),
  m(
    'cd_read_without_clusters',
    '无可提的簇(项目被排除 / 归属不明)时不读冷却事实',
    [
      swap(
        DIG,
        "const coolRead = p0.reason === 'ok' ? await readCooldown(deps.cooldown, now) : null;",
        'const coolRead = await readCooldown(deps.cooldown, now);',
      ),
    ],
    [T_COOL],
    ['项目被排除(没有可提的簇)'],
  ),
  m(
    'cd_unavailable_open',
    'fail-closed:读不到冷却事实不得当成不在冷却',
    [
      swap(
        COOL,
        "if (read.kind === 'unavailable') return () => true;",
        "if (read.kind === 'unavailable') return () => false;",
      ),
    ],
    [T_COOL],
    [
      '端口读不到(unavailable)→ 所有簇都在冷却中',
      '读不到冷却事实(unavailable)→ 一个簇也不提',
      '读不到冷却事实(端口 unavailable)→ fail-closed',
    ],
  ),
  m(
    'cd_throw_as_unwired',
    'fail-closed:端口抛错不得当成未接线 / 无冷却',
    [swap(COOL, "return { kind: 'unavailable', why: 'source_threw' };", 'return null;')],
    [T_COOL],
    ['端口抛错 / 返回形状不对', '端口抛错 → 同样 fail-closed'],
  ),
  m(
    'cd_invalid_result_as_empty',
    'fail-closed:返回形状不对不得当成空冷却集合',
    [
      swap(
        COOL,
        "return { kind: 'unavailable', why: 'invalid_result' };\n  } catch {",
        "return { kind: 'ok', active: new Set<string>() };\n  } catch {",
      ),
    ],
    [T_COOL],
    ['端口抛错 / 返回形状不对', '端口报告 unavailable:带稳定短码原样保留'],
    ['端口抛错 / 返回形状不对'],
  ),
  m(
    'cd_set_check_dropped',
    '端口返回的 active 必须是原生 Set(鸭子类型 / Proxy / 数组 → invalid_result)',
    [
      swap(
        COOL,
        'size = SET_SIZE.call(raw as Set<unknown>); // 非原生 Set 在这里抛 TypeError',
        'size = 0;',
      ),
    ],
    [T_COOL],
    ['端口抛错 / 返回形状不对'],
  ),
  m(
    'cd_element_unchecked',
    'fail-closed:ok 集合的元素必须是非空字符串(不只看 Set 外壳)',
    [swap(COOL, "if (typeof id !== 'string' || id === '')", 'if (false)')],
    [T_COOL],
    ['元素必须是非空字符串(Set<number> / Set<object> / 混合 / 含空串)'],
  ),
  m(
    'cd_active_aliased',
    '合法集合被复制,不保留适配器可变集合的引用',
    [
      swap(
        COOL,
        "return { kind: 'ok', active: copy };",
        "return { kind: 'ok', active: r.active };",
      ),
    ],
    [T_COOL],
    ['合法集合被复制:适配器读完后再改它'],
  ),
  m(
    'cd_why_unchecked',
    'unavailable 的原因码须是稳定短码(不外泄路径 / 异常文本)',
    [swap(COOL, "typeof r.why === 'string' && WHY_RE.test(r.why)", 'true')],
    [T_COOL],
    ['端口报告 unavailable:带稳定短码原样保留'],
  ),
  m(
    'cd_id_error_not_cooled',
    'fail-closed:算聚类 id 抛错按在冷却中处理',
    [swap(COOL, 'return true; // 算不出 id:不能证明不在冷却中', 'return false;')],
    [T_COOL],
    ['聚类 id 算不出(null)→'],
  ),
  m(
    'cd_eligible_group_ignored',
    '候选签名来自可作证据的成员:两种口径任一命中即冷却',
    [swap(COOL, 'for (const group of [members, eligible]) {', 'for (const group of [members]) {')],
    [T_COOL],
    ['命中判定:全部成员的 id 或可作证据成员的 id 任一在冷却集合里'],
  ),
  m(
    'cd_today_wrong_day',
    '冷却到期按 UTC 日:传给端口的「今天」取 UTC 日',
    [swap(COOL, 'now.toISOString().slice(0, 10)', 'now.toISOString().slice(0, 7)')],
    [T_COOL],
    ['把「今天」按 UTC 日传给端口'],
  ),

  // ---- auto-view 构造 ----
  m(
    'view_marks_no_expiry',
    'W0-22 第 7 条:保护标记自 at 起 90 个 UTC 日后移除——不移除',
    [swap(VB, 'if (addDays(dayOf(m.at), VIEW_MARK_DAYS) <= today) continue;', 'void 0;')],
    [T_VIEW],
    ['第 90 个 UTC 日当天移除、前一天仍保留(边界)'],
  ),
  m(
    'view_marks_boundary_off_by_one',
    '保护标记到期边界(第 90 个 UTC 日当天已移除)',
    [
      swap(
        VB,
        'if (addDays(dayOf(m.at), VIEW_MARK_DAYS) <= today) continue;',
        'if (addDays(dayOf(m.at), VIEW_MARK_DAYS) < today) continue;',
      ),
    ],
    [T_VIEW],
    ['第 90 个 UTC 日当天移除、前一天仍保留(边界)'],
  ),
  m(
    'view_marks_keep_first_dup',
    '同 (id, mark) 只留最新',
    [
      swap(
        VB,
        'if (cur === undefined || Date.parse(m.at) > Date.parse(cur.at)) latest.set(k, m);',
        'if (cur === undefined) latest.set(k, m);',
      ),
    ],
    [T_VIEW],
    ['同 (id, mark) 只留最新'],
  ),
  m(
    'view_marks_key_ignores_mark',
    '同一候选的两种标记各保留',
    [swap(VB, 'const k = `${m.id}|${m.mark}`;', 'const k = m.id;')],
    [T_VIEW],
    ['同 (id, mark) 只留最新'],
  ),
  m(
    'view_marks_oldest_first',
    '保护标记超出 64 条时保留最新(最新在前)',
    [
      swap(
        VB,
        '(a, b) => Date.parse(b.at) - Date.parse(a.at) || byStr(a.id, b.id) || byStr(a.mark, b.mark),',
        '(a, b) => Date.parse(a.at) - Date.parse(b.at) || byStr(a.id, b.id) || byStr(a.mark, b.mark),',
      ),
    ],
    [T_VIEW],
    ['同 (id, mark) 只留最新', '保留最新的 64 条(最老的被截)'],
    ['保留最新的 64 条(最老的被截)'],
  ),
  m(
    'view_marks_truncated_unflagged',
    '保护标记截断必须置 protection_marks_truncated',
    [
      swap(
        VB,
        'protection_marks_truncated: marks.length > VIEW_LIST_MAX,',
        'protection_marks_truncated: false,',
      ),
    ],
    [T_VIEW],
    ['保留最新的 64 条(最老的被截)'],
  ),
  m(
    'view_rolling_truncated_unflagged',
    '停住候选截断必须置 rolling_back_truncated',
    [
      swap(
        VB,
        'rolling_back_truncated: rolling.length > VIEW_LIST_MAX,',
        'rolling_back_truncated: false,',
      ),
    ],
    [T_VIEW],
    ['至多 64 条:恰好 64 条不截断;65 条保留最久的 64 条'],
  ),
  m(
    'view_rolling_unsorted',
    '停住候选按进入时间升序(最久的在前;截断时保留最久的)',
    [
      swap(
        VB,
        'rolling.sort((a, b) => Date.parse(a.entered_at) - Date.parse(b.entered_at) || byStr(a.id, b.id));',
        'void 0;',
      ),
    ],
    [T_VIEW],
    ['rolling_back 与 retiring 都列', '至多 64 条:恰好 64 条不截断;65 条保留最久的 64 条'],
    ['rolling_back 与 retiring 都列'],
  ),
  m(
    'view_entered_first_wins',
    'entered_at 取进入当前状态的最后一次转移',
    [
      swap(
        VB,
        'if (best === null || Date.parse(t.at) >= Date.parse(best)) best = t.at;',
        'if (best === null) best = t.at;',
      ),
    ],
    [T_VIEW],
    ['rolling_back 与 retiring 都列'],
  ),
  m(
    'view_entered_any_dim',
    'entered_at 只看 lifecycle 维度的转移',
    [
      swap(
        VB,
        "if (t.dim !== 'lifecycle' || t.to !== rec.lifecycle) continue;",
        'if (t.to !== rec.lifecycle) continue;',
      ),
    ],
    [T_VIEW],
    ['rolling_back 与 retiring 都列'],
  ),
  m(
    'view_entry_unknown_skipped',
    '进入时间不可知时不产出(不静默漏掉停住候选)',
    [
      swap(
        VB,
        "if (at === null) return { ok: false, why: 'rolling_back_entry_unknown' };",
        'if (at === null) continue;',
      ),
    ],
    [T_VIEW],
    ['找不到进入当前状态的转移(历史被截断)'],
  ),
  m(
    'view_canary_stats_zero_filled',
    '缺 canary 统计不得写成 0',
    [
      swap(
        VB,
        'const g = s.groupCounts.get(c.id);',
        'const g = s.groupCounts.get(c.id) ?? { treat: 0, control: 0 };',
      ),
    ],
    [T_VIEW],
    ['有 canary 但没有它的分组计数'],
  ),
  m(
    'view_canary_ambiguous_picked',
    '两个 canary(不变量被破坏)不产出',
    [
      swap(
        VB,
        "if (canaries.length > 1) return { ok: false, why: 'canary_ambiguous' };",
        'void 0;',
      ),
    ],
    [T_VIEW],
    ['同时有两个 canary'],
  ),
  m(
    'view_input_throws',
    '坏输入(日期运算抛错)只返回 input_invalid,不外抛',
    [swap(VB, "return { ok: false, why: 'input_invalid' };", "throw new Error('input_invalid');")],
    [T_VIEW],
    ['标记 / 转移里的时间戳无法解析'],
  ),
  m(
    'view_window_30_not_29',
    'last30d 窗口 = 今天及前 29 个 UTC 日',
    [
      swap(
        VB,
        'const windowStart = addDays(today, -(VIEW_LAST_DAYS - 1));',
        'const windowStart = addDays(today, -VIEW_LAST_DAYS);',
      ),
    ],
    [T_VIEW],
    ['边界:今天 / 前 29 日计入'],
  ),
  m(
    'view_future_day_counted',
    'last30d 不计未来日期的转移',
    [swap(VB, 'dayOf(t.at) <= today,', 'true,')],
    [T_VIEW],
    ['边界:今天 / 前 29 日计入'],
  ),
  m(
    'view_schema_unchecked',
    '出口校验:不合 AutoViewSchema 不产出',
    [
      swap(
        VB,
        "return parsed.success ? { ok: true, view: parsed.data } : { ok: false, why: 'schema_invalid' };",
        'return { ok: true, view: candidate as AutoView };',
      ),
    ],
    [T_VIEW],
    ['预算越界 / 负数 / 非十六进制 oid'],
  ),
  m(
    'closure_view_build_writes',
    'view 构造是纯函数:引入写出口',
    [
      swap(
        VB,
        "import { RSI_LIFECYCLE_STATES } from '../../contracts/rsi.js';",
        "import '../../io/safe-fs.js';\nimport { RSI_LIFECYCLE_STATES } from '../../contracts/rsi.js';",
      ),
    ],
    [T_CLOS],
    ['view-build.ts 的闭包(含类型)没有写出口'],
  ),

  // ---- auto-view 写端口 ----
  m(
    'vw_no_revalidate',
    '写端口对跨信任边界的视图再校验 schema',
    [swap(VW, "if (!parsed.success) return { ok: false, why: 'invalid_view' };", 'void 0;')],
    [T_VIEW],
    ['视图不合 schema(跨信任边界再校验)', '违规视图报 invalid_view(不是 write_failed)'],
  ),
  m(
    'vw_parse_throws',
    '视图对象本身读取即抛错 → invalid_view,不外抛',
    [
      swap(
        VW,
        "return { ok: false, why: 'invalid_view' }; // 序列化 / 校验本身抛错(循环引用、奇异对象)也不外抛",
        "throw new Error('weird'); // x",
      ),
    ],
    [T_VIEW],
    ['视图对象本身读取即抛错(奇异对象)'],
  ),
  m(
    'vw_no_precheck_lock',
    '写前先复核 rsi/lock(丢锁 → lock_lost,不进写路径)',
    [swap(VW, 'await d.locks.rsi.assertHeld();', 'void 0;')],
    [T_VIEW],
    ['写前就丢锁'],
  ),
  m(
    'vw_lock_not_rechecked',
    '每个写点之前复核锁:提交点(rename)前丢锁不得写',
    [swap(VW, 'RSI_AUTO_VIEW_FILE, text, [d.locks.rsi]', 'RSI_AUTO_VIEW_FILE, text, []')],
    [T_VIEW],
    ['写的中途(临时文件已建、rename 之前)丢锁'],
  ),
  m(
    'vw_lock_lost_as_failed',
    '丢锁(RsiLockError lock_lost)如实报 lock_lost',
    [swap(VW, "if (e instanceof RsiLockError && e.kind === 'lock_lost')", 'if (false)')],
    [T_VIEW],
    ['写的中途(临时文件已建、rename 之前)丢锁'],
  ),
  m(
    'vw_tmp_left_behind',
    '写失败后清掉自己的临时文件',
    [swap(VW, '`${RSI_AUTO_VIEW_FILE}.tmp`', '`${RSI_AUTO_VIEW_FILE}.nope`')],
    [T_VIEW],
    ['rename 失败(目标位置是非空目录)'],
  ),
  // ---- 验收评审补充(M1–M5 与另三条;表末追加,既有条目的顺序不变) ----
  m(
    'pend_dup_ids_counted',
    'A6:report 暂存编号重复 = 报告不可信,即使去重个数 = counts 也不扣',
    [
      swap(
        PEND,
        'o.ids.length === new Set(o.ids).size && o.ids.length === o.run.proposals',
        'new Set(o.ids).size === o.run.proposals',
      ),
    ],
    [T_PEND],
    ['报告暂存编号里有重复:即使去重个数恰好等于 counts 的提案数也不扣'],
  ),
  m(
    'conv_rsi_link_followed',
    '候选读取器先验 rsi 目录本身(符号链接 / 属主 / 权限),不只验末级 candidates',
    [swap(CONV, "if (top.kind === 'unsafe') return unknown('unsafe');", 'void 0;')],
    [T_PEND],
    ['`.state/rsi` 本身是指向外部目录的符号链接'],
  ),
  m(
    'conv_state_dir_unchecked',
    '从 stateDir 出发读候选前用只读 rsiDirReadonly 校验 rsi 目录',
    [swap(CONV, "if (d.kind === 'unsafe') return unknown('unsafe');", 'void 0;')],
    [T_PEND],
    ['`.state/rsi` 本身是指向外部目录的符号链接', '`.state/rsi` 不存在 → missing'],
  ),
  m(
    'cd_too_many_ids',
    'M1:冷却集合条数上限(超限 → unavailable/too_large)',
    [swap(COOL, "if (size > COOLDOWN_MAX_IDS) return 'too_large';", 'void 0;')],
    [T_COOL],
    ['条数:恰好 10000 → ok;10001 → unavailable(too_large)'],
  ),
  m(
    'cd_id_bytes_unbounded',
    'M1:单个 id 的字节上限',
    [swap(COOL, 'n > COOLDOWN_MAX_ID_BYTES || ', 'false || ')],
    [T_COOL],
    ['单个 id:恰好 256 字节 → ok;257 字节 → too_large'],
  ),
  m(
    'cd_total_bytes_unbounded',
    'M1:累计字节上限',
    [swap(COOL, ' || bytes > COOLDOWN_MAX_TOTAL_BYTES', ' || false')],
    [T_COOL],
    ['累计字节:4096 个 256 字节的 id'],
  ),
  m(
    'cd_bytes_as_chars',
    'M1:上限按 UTF-8 字节而不是字符数',
    [swap(COOL, "Buffer.byteLength(id, 'utf8')", 'id.length')],
    [T_COOL],
    ['单个 id:恰好 256 字节 → ok;257 字节 → too_large'],
  ),
  m(
    'cd_overridable_iter',
    'M1:受控遍历原生 Set(不调用适配器可覆盖的迭代器)',
    [swap(COOL, 'SET_VALUES.call(raw as Set<unknown>)', '(raw as Set<unknown>)')],
    [T_COOL],
    ['适配器覆盖迭代器 / size 的 Set 子类'],
  ),
  m(
    'cd_size_overridable',
    'M1:size 取内部槽位(适配器谎报 size 绕不过上限)',
    [
      swap(
        COOL,
        'size = SET_SIZE.call(raw as Set<unknown>); // 非原生 Set 在这里抛 TypeError',
        'size = (raw as Set<unknown>).size;',
      ),
    ],
    [T_COOL],
    ['适配器覆盖迭代器 / size 的 Set 子类', '非原生 Set(Proxy / 鸭子类型 / 数组)→ invalid_result'],
  ),
  m(
    'vb_dropped_rejects',
    'M3(收窄):transitions_dropped > 0 本身不是拒绝理由(否则一条截断过的记录长期冻结整个视图)',
    [
      swap(
        VB,
        'let historyIncomplete = false;',
        'let historyIncomplete = s.records.some((r) => r.transitions_dropped > 0);',
      ),
    ],
    [T_VIEW],
    ['transitions_dropped > 0 本身不拒绝重建'],
  ),
  m(
    'vb_terminal_entry_unchecked',
    'M3:终态记录里找不到进入该终态的转移 → 拒绝重建',
    [
      swap(
        VB,
        '(TERMINALS as readonly string[]).includes(rec.lifecycle) && enteredAt(rec) === null',
        'false',
      ),
    ],
    [T_VIEW],
    ['终态记录里找不到进入该终态的 lifecycle 转移 → history_incomplete'],
  ),
  m(
    'vb_history_flag_ignored',
    'M3:历史不完整的标记必须真的拒绝产出',
    [
      swap(
        VB,
        "if (historyIncomplete) return { ok: false, why: 'history_incomplete' };",
        'void 0;',
      ),
    ],
    [T_VIEW],
    [
      'transitions_dropped > 0 本身不拒绝重建',
      '终态记录里找不到进入该终态的 lifecycle 转移 → history_incomplete',
    ],
  ),
  m(
    'vb_dup_ids_allowed',
    'M5:候选 id 必须唯一(重复记录不得放大聚合)',
    [swap(VB, 'new Set(s.records.map((r) => r.id)).size !== s.records.length', 'false')],
    [T_VIEW],
    ['同一 id 的两条记录(非 canary、终态均可)→ input_invalid'],
  ),
  m(
    'vw_reason_unchecked',
    'M4:写端口按封闭转移原因码复核 last_rollback.reason / rolling_back[].origin_reason',
    [
      swap(
        VW,
        'if (r !== undefined && !RsiTransitionReasonSchema.safeParse(r).success) return false;',
        'void 0;',
      ),
    ],
    [T_VIEW],
    ['last_rollback.reason / rolling_back[].origin_reason 不在转移原因码枚举里'],
  ),
  m(
    'vw_states_keys_unchecked',
    'M4:写端口复核 pipeline.states 的键集合 = 生命周期状态集合',
    [
      swap(
        VW,
        'return keys.length === states.size && keys.every((k) => states.has(k));',
        'return true;',
      ),
    ],
    [T_VIEW],
    ['pipeline.states 的键不是生命周期状态集合'],
  ),
];

/** 执行变异后回填(与 `V1_ASM_D4_MUTATIONS` 同序);未执行时为空 */
export const V1_ASM_D4_RESULTS: readonly V1AsmD4Result[] = [];
