/**
 * §21 V1 W7 必杀变异(回滚四段与 journal、撤销凭据写入方、缩减入口 clear、熔断、效果续做、反向取锁守卫、harm 串接;契约 R21-3.3 / R21-9.1 / 9.2 / 9.3a /
 * 9.5 / 9.6 / R21-10、§21.24 W0-15 / W0-16 / W0-17)。
 * 执行方式同 W5 / W6:验证机私有检出里 cp 备份 → 按锚点替换(每个锚点在对应文件里**恰好出现一次**)→ 跑 `tests` → 失败集合非空、全部命中 `expectRed`、
 * `mustKill` 每项至少命中一个、没有 skipped → cp 还原并逐文件 sha256 核对。**不用 git checkout / stash 还原**。
 * 本文件只写表与每条变异期望红的测试名(`expectRed` 是杀手测试名里的字面子串,参数化用例只取 `%s` 之外的固定片段);变异由主代理执行,
 * 结果记进 `V1_W7_RESULTS`(W7 实装块不执行变异,故留空)。变异 id 用短的下划线词。
 *
 * 不可变异的点(如实记录):`rollbackTxnId` 里 kind 常量(只影响 id 的哈希值,不影响任何可见行为);journal 写入的 `at` 时间戳;
 * `appendRevocations` 的整文件原子重写由 W2 的用例钉住(本块不改)。
 */
export interface Edit {
  file: string;
  anchor: string;
  replacement: string;
}

export interface V1W7Mutation {
  id: string;
  /** 契约条款 / 该不变量 */
  clause: string;
  edits: readonly Edit[];
  /** 相对 `test/` */
  tests: readonly string[];
  expectRed: readonly string[];
  mustKill: readonly string[];
}

export interface V1W7Result {
  id: string;
  failed: number;
  skipped: number;
  killedBy: readonly string[];
  restored: boolean;
}

const P = 'src/rsi/personal/';
const RB = `${P}rollback.ts`;
const RJ = `${P}rollback-journal.ts`;
const SF = 'src/io/safe-fs.ts';
const RW = `${P}revoke-write.ts`;
const BR = `${P}breaker.ts`;
const CL = `${P}clear.ts`;
const RR = `${P}rollback-repo.ts`;
const RP = `${P}rollback-ports.ts`;
const ER = `${P}effects-recover.ts`;
const HC = `${P}harm-chain.ts`;
const LK = 'src/rsi/lock.ts';
const PL = `${P}personal-lock.ts`;
const PM = 'src/rsi/canary/pause-marker.ts';
const PR = 'src/rsi/canary/permit-read.ts';
const TE = `${P}terminal-effects.ts`;
const TT = `${P}transition-table.ts`;
const TR = `${P}transition.ts`;

const T_RB = 'rsi/rollback/w7-rollback.test.ts';
const T_CR = 'rsi/rollback/w7-crash.test.ts';
const T_CL = 'rsi/rollback/w7-clear.test.ts';
const T_CU = 'rsi/rollback/w7-clear-unit.test.ts';
const T_BR = 'rsi/rollback/w7-breaker.test.ts';
const T_EF = 'rsi/rollback/w7-effects.test.ts';
const T_RW = 'rsi/rollback/w7-revoke-write.test.ts';
const T_HC = 'rsi/rollback/w7-harm-chain.test.ts';
const T_LK = 'rsi/rollback/w7-lock-order.test.ts';
const T_JN = 'rsi/rollback/w7-journal.test.ts';
const T_PM = 'rsi/rollback/w7-pause-marker.test.ts';
const T_JB = 'rsi/rollback/w7-journal-boundary.test.ts';
const T_AK = 'rsi/rollback/w7-audit-key.test.ts';
const T_PR = 'rsi/rollback/w7b-protection.test.ts';
const T_CA = 'rsi/rollback/w7b-cause.test.ts';
const T_PD = 'rsi/canary/w7b-pause-read.test.ts';
const T_HE = 'rsi/canary/w5-hint-e2e.test.ts';

const swap = (file: string, anchor: string, replacement: string): Edit => ({
  file,
  anchor,
  replacement,
});

export const V1_W7_MUTATIONS: readonly V1W7Mutation[] = [
  // ---- R21-9.1 四段与 journal ----
  {
    id: 'rev_criterion_trusted',
    clause: 'R21-9.1 第二段判据:凭据已在盘上(重读,不信写入返回值)',
    edits: [
      swap(
        RB,
        'if (!rv.lines.some((l) => l.candidate_id === t.candidate_id && l.content_sha256 === sha)) {',
        'if (false) {',
      ),
    ],
    tests: [T_RB],
    expectRed: ['第二段判据:凭据从盘上重读'],
    mustKill: ['第二段判据:凭据从盘上重读'],
  },
  {
    id: 'journal_not_advanced',
    clause: 'R21-9.1 / 9.6 journal 的 phase 是执行器进度依据:每段完成后推进',
    edits: [
      swap(
        RB,
        'await d.txns.write(t);\n      await step(d, `journal:${next}`);',
        'await step(d, `journal:${next}`);',
      ),
    ],
    tests: [T_CR, T_RB],
    expectRed: [
      'journal 领先于记录',
      '第二段判据:凭据从盘上重读;凭据写入返回成功但读不到 → 本段未完成、不推进 journal',
      'R21-9.3:撤销路径遇到用户改过的块(drift)→ 停在第四段之前:记录停在 static_removal_pending,journal 保留,未到终态',
      '私有仓库 deferred:凭据照样落盘;第三段判据改为 payload 已不含该候选;不提交;撤销已完成(revocation_complete,仓库部分推迟),journal 保留作待补记任务',
      'deferred 下第三段先经撤销路径清 payload(动作含「重渲染本机 payload」),再验证缺席:不死锁',
      '权威记录读不到(deferred):撤销事务照常运行(HOME 清理不受阻),结果带 lateEventNotApplied;仓库恢复后调用方重试 → 施加并完成(vetoed)',
      'journal 停在第一段、仓库 deferred 时收到较晚事件:凭据与 HOME 撤销照常执行(不被事件持久化失败挡住),事件如实报未施加',
    ],
    // 「记录领先于 journal」那条在一次运行内走完(内存里的 phase 照常前进),看不出 journal 没落盘,不列入
    mustKill: ['journal 领先于记录'],
  },
  {
    id: 'deferred_ignored',
    clause: 'R21-9.3a deferred 下第三段判据改为「本机 payload 已不含该候选」',
    edits: [swap(RB, '    if (!(await d.payload.absent(t.candidate_id))) {', '    if (false) {')],
    tests: [T_RB],
    expectRed: ['deferred 且撤销路径之后 payload 仍含该候选'],
    mustKill: ['deferred 且撤销路径之后 payload 仍含该候选'],
  },
  {
    id: 'record_note_ignored',
    clause: 'R21-9.1 记录没能推进时不删仓库文件(记录仍在生效状态)',
    edits: [swap(RB, "if (part.repo === 'ok' && part.note !== undefined) {", 'if (false) {')],
    tests: [T_RB],
    expectRed: ['V1a 没有 rollback_four_phase'],
    mustKill: ['V1a 没有 rollback_four_phase'],
  },
  {
    id: 'advance_one_step',
    clause: 'R21-9.1 记录的 rollback.phase 逐步追上 journal(落后多段时逐段推进)',
    edits: [
      swap(
        RB,
        'for (const p of PHASES.slice(from + 1, phaseIdx(to) + 1)) {',
        'for (const p of PHASES.slice(from + 1, from + 2)) {',
      ),
    ],
    tests: [T_RB, T_CR],
    expectRed: [
      'canary + harm → 四段全部完成',
      '→ resumeAll 续做到终态',
      ' → 第三次续做仍到终态',
      '同一候选在 rollback_to 的 txn 在途时 clear 再来:复用该 txn,来源取 journal 的(rollback_to),不新开、凭据一行',
      'journal 领先于记录(journal 已到 rollback_complete,记录还在 canary):续做按盘上判据补齐,不回退 journal',
      '顺序(安全):journal 先于凭据,凭据先于记录提交与私有仓库移除,仓库移除先于 HOME 清理,效果最后、journal 最后才删',
      'R21-9.3:撤销路径遇到用户改过的块(drift)→ 停在第四段之前:记录停在 static_removal_pending,journal 保留,未到终态',
      '私有仓库 deferred:凭据照样落盘;第三段判据改为 payload 已不含该候选;不提交;撤销已完成(revocation_complete,仓库部分推迟),journal 保留作待补记任务',
      '记录可读但仓库提交 deferred(第三段「成功」):收尾重新检查并补做仓库移除,没删之前不删 journal、不假装完成',
      '私有仓库 invalid:第三段中止(不当成已完成),凭据已落盘;修好后续做',
      '崩溃后再次发起同一请求:复用同一 journal、凭据不重复;不同 kind / 原因的请求也复用',
      '终态之后重来:凭据 already_present、记录不动、效果按键 already,不产生重复',
      'harm 回滚走到第四段后用户 veto:复用同一 txn,终态理由取优先级最高者(vetoed),否决黑名单落地',
      '权威记录读不到(deferred):撤销事务照常运行(HOME 清理不受阻),结果带 lateEventNotApplied;仓库恢复后调用方重试 → 施加并完成(vetoed)',
      '提交失败(commit_failed):不以旧理由进终态、不删 journal、不返回 complete;重试成功后保留 veto 优先级与黑名单',
      '记录还在 canary(journal 在第二段中断):事件留给第三段施加;第二段失败时 journal 保留,重试走完就是已施加(无标记)',
      '记录已终态:不再施加(终态上的 veto 黑名单归前台命令),如实标记 record_terminal',
      '第三段记录提交后发现丢锁:抛 lock_lost;未调用仓库移除;journal 保留,新持锁者续做完成',
      's 没装配 → incomplete(port_not_wired),journal 保留、凭据已落盘',
      'auto_paused=true、自动循环无效:回滚照常走完(只禁增加影响)',
      'rollback_to 的 txn 在凭据写入前崩溃、clear 再来:凭据的来源仍取 journal 的(rollback_to),不取请求的',
    ],
    mustKill: ['canary + harm → 四段全部完成'],
  },
  {
    id: 'payload_own_only',
    clause: 'R21-9.3a / 9.5 撤销路径目标 = 上次已同步版本减去凭据所列的全部候选',
    edits: [
      swap(
        RB,
        'return [...new Set([...rv.lines.map((l) => l.candidate_id), t.candidate_id])].sort();',
        'return [t.candidate_id];',
      ),
    ],
    tests: [T_RB],
    expectRed: ['第四段:撤销路径的目标'],
    mustKill: ['第四段:撤销路径的目标'],
  },
  {
    id: 'effects_not_landed',
    clause: 'W0-16 终态效果在删 journal 之前经带键落地',
    edits: [swap(RB, 'await landTerminalEffects(d.keyedEffects, rec),', "'none',")],
    tests: [T_RB, T_EF],
    expectRed: [
      'canary + harm → 四段全部完成',
      '回滚执行器:效果落地失败',
      '顺序(安全):journal 先于凭据,凭据先于记录提交与私有仓库移除,仓库移除先于 HOME 清理,效果最后、journal 最后才删',
      'R21-9.3:撤销路径遇到用户改过的块(drift)→ 停在第四段之前:记录停在 static_removal_pending,journal 保留,未到终态',
      '私有仓库 deferred:凭据照样落盘;第三段判据改为 payload 已不含该候选;不提交;撤销已完成(revocation_complete,仓库部分推迟),journal 保留作待补记任务',
      '终态之后重来:凭据 already_present、记录不动、效果按键 already,不产生重复',
      'harm 回滚走到第四段后用户 veto:复用同一 txn,终态理由取优先级最高者(vetoed),否决黑名单落地',
      '提交失败(commit_failed):不以旧理由进终态、不删 journal、不返回 complete;重试成功后保留 veto 优先级与黑名单',
      'journal 无、记录在 rolling_back(别的路径提交了转移):resumeAll 补 kind=reconcile 的 journal 并走完,凭据按原因还原来源',
    ],
    mustKill: ['canary + harm → 四段全部完成', '回滚执行器:效果落地失败'],
  },
  {
    id: 'step_table_short',
    clause: 'R21-9.6 崩溃注入点表覆盖四个子状态与收尾',
    edits: [swap(RB, "'after:effects',", '')],
    tests: [T_CR],
    expectRed: ['步骤点表覆盖四个子状态与收尾'],
    mustKill: ['步骤点表覆盖四个子状态与收尾'],
  },
  {
    id: 'finish_no_removal_check',
    clause: 'R21-9.3a 分叉期间被推迟的仓库移除在收尾重新检查并补做',
    edits: [
      swap(
        RB,
        "if (rem.status === 'deferred') return deferredDone(`repo_deferred:${rem.why}`);",
        '',
      ),
    ],
    tests: [T_RB],
    expectRed: ['记录可读但仓库提交 deferred'],
    mustKill: ['记录可读但仓库提交 deferred'],
  },
  {
    id: 'late_event_dropped',
    clause: 'R21-4.4a ① 复用在途 txn 时较晚到达的终止事件先于动作施加到权威记录',
    edits: [
      swap(
        RB,
        'const lateWhy = await lateEventStatus(d, late, req.candidate_id);',
        'const lateWhy = null;',
      ),
    ],
    tests: [T_RB],
    expectRed: [
      '权威记录读不到(deferred):撤销事务照常运行',
      'harm 回滚走到第四段后用户 veto:复用同一 txn,终态理由取优先级最高者(vetoed),否决黑名单落地',
      'journal 停在第一段、仓库 deferred 时收到较晚事件:凭据与 HOME 撤销照常执行(不被事件持久化失败挡住),事件如实报未施加',
      '提交失败(commit_failed):不以旧理由进终态、不删 journal、不返回 complete;重试成功后保留 veto 优先级与黑名单',
      '记录已终态:不再施加(终态上的 veto 黑名单归前台命令),如实标记 record_terminal',
    ],
    mustKill: ['权威记录读不到(deferred):撤销事务照常运行'],
  },
  {
    id: 'late_event_failure_ignored',
    clause: '较晚终止事件施加失败(halt / stale / refused)→ 如实标记、不以旧理由静默完成',
    edits: [
      swap(RB, "if (r.kind === 'transitioned' || r.kind === 'noop') return null;", 'return null;'),
    ],
    tests: [T_RB],
    expectRed: ['提交失败(commit_failed):不以旧理由进终态'],
    mustKill: ['提交失败(commit_failed):不以旧理由进终态'],
  },
  {
    id: 'late_event_flag_dropped',
    clause: '较晚终止事件没施加时结果带 lateEventNotApplied(调用方据此重试)',
    edits: [swap(RB, 'return { ...out, lateEventNotApplied: lateWhy };', 'return out;')],
    tests: [T_RB],
    expectRed: [
      'journal 停在第一段、仓库 deferred 时收到较晚事件',
      '记录已终态:不再施加',
      '权威记录读不到(deferred):撤销事务照常运行(HOME 清理不受阻),结果带 lateEventNotApplied;仓库恢复后调用方重试 → 施加并完成(vetoed)',
      '提交失败(commit_failed):不以旧理由进终态、不删 journal、不返回 complete;重试成功后保留 veto 优先级与黑名单',
    ],
    mustKill: ['journal 停在第一段、仓库 deferred 时收到较晚事件'],
  },
  {
    id: 'clear_report_unavailable_only',
    clause: 'R21-9.5 缩减入口先续做在途 journal,报告同时给出续做结果与枚举不可用',
    edits: [swap(CL, 'report.outcomes.push(...(await resumeAll(rd)));', '')],
    tests: [T_CU],
    expectRed: ['有在途 journal 而候选全集读不到'],
    mustKill: ['有在途 journal 而候选全集读不到'],
  },
  {
    id: 'lock_lost_ignored',
    clause: '丢锁(applyEvent 返回 lockLost)后立即停止,不继续任何写出口',
    edits: [
      swap(
        RB,
        "if (r.kind === 'transitioned' && r.lockLost === true) throw new RsiLockError('lock_lost');",
        '',
      ),
    ],
    tests: [T_RB],
    expectRed: ['第三段记录提交后发现丢锁'],
    mustKill: ['第三段记录提交后发现丢锁'],
  },
  {
    id: 'deferred_no_revoke',
    clause: 'R21-9.3a deferred 下第三段动作含「重渲染本机 payload」(先清再验缺席,不死锁)',
    edits: [
      swap(
        RB,
        '    const r = await d.payload.revoke(ids);',
        "    const r = { status: 'done' } as const;",
      ),
    ],
    tests: [T_RB],
    expectRed: [
      'deferred 下第三段先经撤销路径清 payload',
      'deferred 下撤销路径遇到用户改过的块(drift)→ 第三段未完成',
    ],
    mustKill: ['deferred 下第三段先经撤销路径清 payload'],
  },
  {
    id: 'clear_no_resume',
    clause: 'R21-9.5 / 9.6 缩减入口先续做在途 journal(自己可重试)',
    edits: [swap(CL, 'report.outcomes.push(...(await resumeAll(rd)));', '')],
    tests: [T_CL],
    expectRed: ['再跑一次 clear 先续做在途 journal'],
    mustKill: ['再跑一次 clear 先续做在途 journal'],
  },
  // ---- W0-17 来源保留 ----
  {
    id: 'source_fallthrough_worker',
    clause:
      'W0-20 旧格式 journal:来源由 (kind, reason) 在 W0-17 表里唯一对应的来源还原(veto / exec_event / worker),不是一律 worker',
    edits: [swap(RJ, 'return owners.length === 1 ? owners[0] : undefined;', "return 'worker';")],
    tests: [T_JB],
    expectRed: [
      '可还原:原因',
      'cleared 的 rolling_back 记录没有 journal:来源有歧义(rollback_to / clear)→ refused by_ambiguous,零动作',
      '):不伪造 → incomplete(terminal_event),不写凭据、记录不动、journal 保留',
      'cleared 配 kind=rollback / reconcile 来源有歧义(rollback_to 或 clear):不推出 → incomplete(by),不写凭据',
      '内容哈希:不信权威副本的当前值(记录里有、但没有凭据也没有 recordedSha)→ W0-20:必需项缺失且不可恢复 = incomplete(带事务身份 txn;cause manual_event_required),不写凭据',
      '内容哈希:recordedSha 对不上 txn_id 不采信;复用入口时请求带来的内容哈希也不是允许的来源',
      '多项缺失一并报告(by + content_sha256;cleared 的事件可重建,不在其列)',
    ],
    mustKill: ['可还原:原因'],
  },
  {
    id: 'source_clear_kind_lost',
    clause: 'W0-20 旧格式 journal:kind=clear → by=clear',
    edits: [
      swap(RJ, "if (kind === 'clear') return 'clear';", "if (kind === 'clear') return 'worker';"),
    ],
    tests: [T_JB],
    expectRed: ['可还原:原因'],
    mustKill: ['可还原:原因'],
  },
  {
    id: 'by_ambiguous_guessed',
    clause:
      'W0-20 旧格式 journal:cleared 配 kind=rollback / reconcile 来源有歧义(rollback_to 或 clear),不推出 → incomplete,不写凭据',
    edits: [swap(RJ, 'return owners.length === 1 ? owners[0] : undefined;', 'return owners[0];')],
    tests: [T_JB],
    expectRed: [
      '来源有歧义(rollback_to 或 clear)',
      'cleared 的 rolling_back 记录没有 journal',
      '多项缺失一并报告(by + content_sha256;cleared 的事件可重建,不在其列)',
    ],
    mustKill: ['来源有歧义(rollback_to 或 clear)', 'cleared 的 rolling_back 记录没有 journal'],
  },
  {
    id: 'reuse_by_request',
    clause: 'W0-17 复用在途 txn 时来源一律取 journal 的',
    edits: [
      swap(
        RB,
        'const jr = await readJournal(d, cur.value);',
        'const jr = await readJournal(d, { ...cur.value, by: req.by, kind: req.kind, reason: req.reason });',
      ),
    ],
    tests: [T_RB, T_CR],
    expectRed: [
      '崩溃后再次发起同一请求',
      'rollback_to 的 txn 在凭据写入前崩溃、clear 再来',
      'harm 回滚走到第四段后用户 veto:复用同一 txn,终态理由取优先级最高者(vetoed),否决黑名单落地',
      '权威记录读不到(deferred):撤销事务照常运行(HOME 清理不受阻),结果带 lateEventNotApplied;仓库恢复后调用方重试 → 施加并完成(vetoed)',
      'journal 停在第一段、仓库 deferred 时收到较晚事件:凭据与 HOME 撤销照常执行(不被事件持久化失败挡住),事件如实报未施加',
      '提交失败(commit_failed):不以旧理由进终态、不删 journal、不返回 complete;重试成功后保留 veto 优先级与黑名单',
      '记录还在 canary(journal 在第二段中断):事件留给第三段施加;第二段失败时 journal 保留,重试走完就是已施加(无标记)',
      '记录已终态:不再施加(终态上的 veto 黑名单归前台命令),如实标记 record_terminal',
    ],
    mustKill: ['崩溃后再次发起同一请求', 'rollback_to 的 txn 在凭据写入前崩溃、clear 再来'],
  },
  {
    id: 'rollback_to_gate_off',
    clause:
      'W0-17 入口闸:rollback_to ⇔ (kind=rollback ∧ reason=cleared),新 journal 的来源与 kind / 原因相容',
    edits: [
      swap(
        RJ,
        "if ((by === 'rollback_to') !== (kind === 'rollback' && reason === 'cleared')) {",
        'if (false) {',
      ),
    ],
    tests: [T_RB],
    expectRed: ['rollback_to ⇔ (kind=rollback ∧ reason=cleared)'],
    mustKill: ['rollback_to ⇔ (kind=rollback ∧ reason=cleared)'],
  },
  {
    id: 'txn_id_ignores_content',
    clause: 'R21-9.1 / W0-17 txn_id 绑定内容:换内容 = 新 txn、新凭据',
    edits: [
      swap(
        RJ,
        "txnId('rollback', [candidateId], null, contentSha256)",
        "txnId('rollback', [candidateId], null, '')",
      ),
    ],
    tests: [T_RB],
    expectRed: ['txn_id 绑定内容'],
    mustKill: ['txn_id 绑定内容'],
  },
  {
    id: 'rev_dedupe_ignores_content',
    clause: 'W0-17 幂等键 = (candidate_id, content_sha256)',
    edits: [
      swap(
        RW,
        'l.candidate_id === line.data.candidate_id && l.content_sha256 === line.data.content_sha256,',
        'l.candidate_id === line.data.candidate_id,',
      ),
    ],
    tests: [T_RW],
    expectRed: ['内容变了必须写新凭据'],
    mustKill: ['内容变了必须写新凭据'],
  },
  {
    id: 'rollback_to_unrestricted',
    // 两层守卫(契约的按来源原因表 + 写入方的收窄)一起拿掉才放开;只拿掉一层时另一层照拦(等价),所以这里两处同改
    clause: 'W0-17 / W0-20 rollback_to 只产出 cleared(契约表与写入方两层)',
    edits: [
      swap(
        RW,
        "if (by === 'rollback_to' && !ROLLBACK_TO_REASONS.includes(reason)) return 'reason_not_allowed';",
        '',
      ),
      swap(
        'src/contracts/rsi.ts',
        "rollback_to: Object.freeze(['cleared']),",
        'rollback_to: Object.freeze([...RSI_ROLLBACK_REVOCATION_REASONS]),',
      ),
    ],
    tests: [T_RW, T_RB],
    expectRed: [
      'rollback_to 只产出 cleared',
      '被拒:RevocationWriteError',
      'journal 无、记录在 rolling_back(别的路径提交了转移):resumeAll 补 kind=reconcile 的 journal 并走完,凭据按原因还原来源',
    ],
    mustKill: ['rollback_to 只产出 cleared'],
  },
  {
    id: 'identity_gets_revocation',
    clause: 'R21-9.1 identity_changed 永不写凭据',
    edits: [swap(RW, "if (reason === 'identity_changed') return 'identity_changed';", '')],
    tests: [T_RW],
    expectRed: [
      'identity_changed 永远不写凭据',
      'rollback_to 只产出 cleared(收窄);契约允许的其余终止原因在本写入方被拒',
    ],
    mustKill: ['identity_changed 永远不写凭据'],
  },
  {
    id: 'by_veto_lost',
    clause: 'W0-17 来源还原:vetoed → veto',
    edits: [swap(RW, "    case 'vetoed':\n      return 'veto';\n", '')],
    tests: [T_RW],
    expectRed: ['byFromReason'],
    mustKill: ['byFromReason'],
  },
  // ---- R21-9.5 缩减入口 ----
  {
    id: 'clear_cache_touched',
    clause: 'R21-9.5 缩减入口不访问仓库 .state(缓存清理恒 pending)',
    edits: [
      swap(
        CL,
        '    cache: pendingCacheCleanup,',
        '    cache: (d as unknown as RollbackDeps).cache,',
      ),
    ],
    tests: [T_CL],
    expectRed: [
      'shadow 候选:凭据 by=clear',
      'canary 候选(V1b):走四段,记录 rolled_back / cleared、deploy 清空;终态效果记待对账(不访问 .state)',
      '工作树被用户改动(diverged):凭据照样落盘;私有仓库不提交、不动引用 / 索引 / 工作树(不 reset 用户改动);journal 保留;分叉解除后续做完成',
      '[rsi] repo 换了(指纹不同):普通读取是 deferred(personal_owner_changed),缩减入口用 head.json 记录的指纹照常完成',
      '持锁方在时 clear 拿不到 personal/lock(locked),不写;释放后 clear 完成,之后 grantCanary 被凭据拒绝(revoked)',
      '①clear 不碰 .state:canary.json 原样残留;hint 对被清候选为 excluded(revoked);worker 首次运行补 stop 行并删缓存,屏障放行;④再对账一次分组账只多一条 stop',
      'journal 在、记录已终态:再跑一次 clear 先续做在途 journal(不依赖 worker)→ 完成,journal 删除,凭据一行;干跑能看到在途 journal',
    ],
    mustKill: ['shadow 候选:凭据 by=clear'],
  },
  {
    id: 'clear_no_phase_gate',
    clause: 'W0-1 cmd_auto_clear 能力闸',
    edits: [swap(CL, "if (!capabilityAvailable('cmd_auto_clear', d.phase)) {", 'if (false) {')],
    tests: [T_CL],
    expectRed: ['能力闸:相位早于 V1a'],
    mustKill: ['能力闸:相位早于 V1a'],
  },
  {
    id: 'clear_dry_run_writes',
    clause: 'R21-12.1 干跑零写入',
    edits: [swap(CL, '  if (!opts.write) {', '  if (false) {')],
    tests: [T_CL],
    expectRed: [
      '干跑(无 --write)',
      'journal 在、记录已终态:再跑一次 clear 先续做在途 journal(不依赖 worker)→ 完成,journal 删除,凭据一行;干跑能看到在途 journal',
    ],
    mustKill: ['干跑(无 --write)'],
  },
  {
    id: 'clear_effects_applied',
    clause: 'R21-9.5 缩减入口的终态效果只记待对账',
    edits: [
      swap(
        CL,
        '    keyedEffects: deferredKeyedEffects,',
        '    keyedEffects: (d as unknown as RollbackDeps).keyedEffects,',
      ),
    ],
    tests: [T_CL],
    expectRed: [
      'canary 候选(V1b):走四段',
      'shadow 候选:凭据 by=clear,私有仓库提交终态 cleared 并删原子文件;没有创建任何仓库 .state / rsi 目录,[rsi] repo 目录仍为空',
      '工作树被用户改动(diverged):凭据照样落盘;私有仓库不提交、不动引用 / 索引 / 工作树(不 reset 用户改动);journal 保留;分叉解除后续做完成',
      '[rsi] repo 换了(指纹不同):普通读取是 deferred(personal_owner_changed),缩减入口用 head.json 记录的指纹照常完成',
      '持锁方在时 clear 拿不到 personal/lock(locked),不写;释放后 clear 完成,之后 grantCanary 被凭据拒绝(revoked)',
      '①clear 不碰 .state:canary.json 原样残留;hint 对被清候选为 excluded(revoked);worker 首次运行补 stop 行并删缓存,屏障放行;④再对账一次分组账只多一条 stop',
      'journal 在、记录已终态:再跑一次 clear 先续做在途 journal(不依赖 worker)→ 完成,journal 删除,凭据一行;干跑能看到在途 journal',
    ],
    mustKill: ['canary 候选(V1b):走四段'],
  },
  {
    id: 'removal_lifecycle_ok',
    clause: 'W0-15 第三段不得删除 lifecycle/ 权威记录',
    edits: [
      swap(
        RR,
        "if (top === 'lifecycle' || !KIT_MANAGED_TOP_DIRS.includes(top)) {",
        'if (!KIT_MANAGED_TOP_DIRS.includes(top)) {',
      ),
    ],
    tests: [T_CL],
    expectRed: ['target_path 指向 lifecycle/ 或管理命名空间之外'],
    mustKill: ['target_path 指向 lifecycle/ 或管理命名空间之外'],
  },
  {
    id: 'removal_any_dir',
    clause: 'W0-15 第三段只删 kit 管理命名空间内的路径',
    edits: [swap(RR, '|| !KIT_MANAGED_TOP_DIRS.includes(top)) {', '|| false) {')],
    tests: [T_CL],
    expectRed: ['target_path 指向 lifecycle/ 或管理命名空间之外'],
    mustKill: ['target_path 指向 lifecycle/ 或管理命名空间之外'],
  },
  {
    id: 'payload_v1_always',
    clause: 'R21-9.2 V1 恒真实现在 local_payload 能力可用时自己 fail-closed',
    edits: [
      swap(RP, "if (capabilityAvailable('local_payload', phase)) return unwiredPayloadSync;", ''),
    ],
    tests: [T_RB],
    expectRed: ['R21-9.2:V1 的第四段判据恒真'],
    mustKill: ['R21-9.2:V1 的第四段判据恒真'],
  },
  // ---- W0-16 效果 ----
  {
    id: 'effects_no_blacklist',
    clause: 'R21-11.3 vetoed 终态带否决黑名单',
    edits: [swap(TE, "if (tr === 'vetoed') {", 'if (false) {')],
    tests: [T_EF, T_RB, T_PR],
    expectRed: [
      '引擎效果(去掉 commit / 审计)== 由终态记录推出的效果',
      'harm → veto:黑名单 + 墓碑 + 90 天,顺序固定',
      'journal 无、记录在 rolling_back',
      'harm 回滚走到第四段后用户 veto:复用同一 txn,终态理由取优先级最高者(vetoed),否决黑名单落地',
      '提交失败(commit_failed):不以旧理由进终态、不删 journal、不返回 complete;重试成功后保留 veto 优先级与黑名单',
      '没走过回滚的终态与改前逐字节相同:闸拒绝无冷却;shadow 到期 30 天;直接 clear / veto 无冷却无标记',
      'harm 回滚中收到 veto(自环):E1 立即按 veto: 键落地;完成后 E2(终态键)含黑名单 + 墓碑 + 90 天(起因 harm),各键只落一次',
      '矛盾记录(rolling_back 夹具无进入条目)走完:终态批次 = 黑名单 + 墓碑 + 90 天 + protection_unclassified(同一批同一键);标记恰好一行,审计出口(audit: 键)没收到它',
      '终态已提交后、效果落地前崩溃:recover 补出含标记的同一批;重复 recover 不重复',
    ],
    mustKill: ['引擎效果(去掉 commit / 审计)== 由终态记录推出的效果'],
  },
  {
    id: 'effects_cooldown_always',
    clause: 'R21-11.1 冷却只对 auto_rollback / expired',
    edits: [swap(TE, "if (rec.lifecycle === 'expired') return", 'if (true) return')],
    tests: [T_EF],
    expectRed: ['人工终态没有冷却', ':引擎效果(去掉 commit / 审计)== 由终态记录推出的效果'],
    mustKill: ['人工终态没有冷却'],
  },
  {
    id: 'effects_key_no_sha',
    clause: 'W0-16 效果键 = 候选 id + 内容哈希',
    edits: [swap(TE, '`terminal:${rec.id}:${rec.content_sha256}`', '`terminal:${rec.id}`')],
    tests: [T_EF],
    expectRed: ['键 = 候选 id + 内容哈希'],
    mustKill: ['键 = 候选 id + 内容哈希'],
  },
  // ---- R21-10 熔断 ----
  {
    id: 'storm_window_31',
    clause: 'R21-10.2 rollback_storm 30 个 UTC 日窗口',
    edits: [
      swap(
        BR,
        'export const ROLLBACK_STORM_WINDOW_DAYS = 30;',
        'export const ROLLBACK_STORM_WINDOW_DAYS = 31;',
      ),
    ],
    tests: [T_BR],
    expectRed: ['rollback_storm:30 个 UTC 日内自动回滚'],
    mustKill: ['rollback_storm:30 个 UTC 日内自动回滚'],
  },
  {
    id: 'storm_threshold_2',
    clause: 'R21-10.2 rollback_storm 自动回滚 ≥ 3 次',
    edits: [
      swap(
        BR,
        'export const ROLLBACK_STORM_AUTO_ROLLBACKS = 3;',
        'export const ROLLBACK_STORM_AUTO_ROLLBACKS = 2;',
      ),
    ],
    tests: [T_BR],
    expectRed: ['rollback_storm:30 个 UTC 日内自动回滚'],
    mustKill: ['rollback_storm:30 个 UTC 日内自动回滚'],
  },
  {
    id: 'veto_window_8',
    clause: 'R21-10.2 user_vetoes 7 个 UTC 日窗口',
    edits: [
      swap(
        BR,
        'export const USER_VETOES_WINDOW_DAYS = 7;',
        'export const USER_VETOES_WINDOW_DAYS = 8;',
      ),
    ],
    tests: [T_BR],
    expectRed: ['user_vetoes:7 个 UTC 日内 veto'],
    mustKill: ['user_vetoes:7 个 UTC 日内 veto'],
  },
  {
    id: 'noobs_gt',
    clause: 'R21-10.2 no_observation 满 7 个 UTC 日触发(差 7 即触发)',
    edits: [
      swap(
        BR,
        'utcDayDiff(f.today, f.lastObservedDay) >= NO_OBSERVATION_DAYS',
        'utcDayDiff(f.today, f.lastObservedDay) > NO_OBSERVATION_DAYS',
      ),
    ],
    tests: [T_BR],
    expectRed: ['no_observation:7 个 UTC 日无观测'],
    mustKill: ['no_observation:7 个 UTC 日无观测'],
  },
  {
    id: 'budget_ignores_loop',
    clause: 'R21-10.2 budget_high_legacy 不是本代循环造成',
    edits: [
      swap(
        BR,
        'f.budgetUsedPct >= BUDGET_HIGH_LEGACY_PCT && !f.budgetCausedByThisLoop',
        'f.budgetUsedPct >= BUDGET_HIGH_LEGACY_PCT',
      ),
    ],
    tests: [T_BR],
    expectRed: ['budget_high_legacy:占用 ≥ 90%'],
    mustKill: ['budget_high_legacy:占用 ≥ 90%'],
  },
  {
    id: 'trip_no_phase_filter',
    clause: 'R21-10.2 按期过滤(V2 / V6b 的码本期不发)',
    edits: [
      swap(BR, 'if (!phaseAtLeast(RSI_AUTO_PAUSE_REASON_PHASE[reason], phase)) {', 'if (false) {'),
    ],
    tests: [T_BR],
    expectRed: [
      '本期不发的码:apply_failed(V2)',
      'rollback_storm 属 V1b:V1a 相位不发(W0-1 订正)',
      '本期不发的码:不写标记、不写状态、不 mute',
    ],
    mustKill: ['本期不发的码:apply_failed(V2)'],
  },
  {
    id: 'paused_ignores_flags',
    clause: 'R21-10.3 diverged / owner_changed 同样只阻挡增加影响',
    edits: [
      swap(
        BR,
        'anyMarkerPresent || s.reasons.length > 0 || s.diverged || s.owner_changed',
        'anyMarkerPresent || s.reasons.length > 0',
      ),
    ],
    tests: [T_BR],
    expectRed: ['四种来源各自成立'],
    mustKill: ['四种来源各自成立'],
  },
  {
    id: 'release_clears_manual',
    clause: 'R21-10.4 自动解除只清自动码',
    edits: [swap(BR, 'RSI_AUTO_RELEASE_REASONS.has(r) && !stillHolds(r)', '!stillHolds(r)')],
    tests: [T_BR],
    expectRed: ['worker 自动解除'],
    mustKill: ['worker 自动解除'],
  },
  {
    id: 'resume_clears_auto',
    clause: 'R21-10.4 resume 只清人工码',
    edits: [swap(BR, 'if (RSI_AUTO_RELEASE_REASONS.has(code)) continue;', '')],
    tests: [T_BR],
    expectRed: [
      'resume 只清人工码',
      '人工 resume(worker 侧):没有剩余熔断码时删 B;仍有码时 B 保留(hint 继续停注入);U 不归这里',
      '内容读不出的 B(创建后写内容前被杀)而状态没有码:人工 resume 可清除;仍有码时不清;自动解除不碰',
    ],
    mustKill: ['resume 只清人工码'],
  },
  {
    id: 'resume_no_recheck',
    clause: 'R21-10.2 / 10.4 resume 重查条件,仍成立的码保留',
    edits: [
      swap(
        BR,
        'const holding = RSI_RESUME_RECHECK[code].find((c) => stillHolds(c));',
        'const holding = undefined as RsiAutoPauseReason | undefined;',
      ),
    ],
    tests: [T_BR],
    expectRed: [
      'resume:rollback_storm / gate_internal 重查四项',
      'resume:apply_failed / personal_repo_invalid 重查自己;其余人工码无条件可清',
      'W0-21:resume 不据 state 里的 user_paused 清码(判据是 U 存在,命令层处理);清掉熔断码且只剩 user_paused → 仍通知 worker 路径删 B;没清则不',
    ],
    mustKill: ['resume:rollback_storm / gate_internal 重查四项'],
  },
  {
    id: 'trip_no_write',
    clause: 'R21-10.1 触发 = 写熔断码,先写状态再置 canary',
    edits: [swap(BR, "if (r.kind === 'tripped') await d.state.write(r.state);", '')],
    tests: [T_BR],
    expectRed: [
      '触发:marker.ensure 先于 state.write 先于 canary.mute',
      '状态写入崩溃:标记已在盘上(hint 看得到),状态没写;下一次 enforceMute 补码、不删标记、补 mute',
      '状态已写、mute 崩溃:下一次 enforceMute 补做(熔断仍在 → mute),无熔断则不 mute',
      '已处于该码:不重写状态,但仍补标记与 mute(幂等)',
      'W0-23 新触发清回证据:tripBreaker / tripAndMute 写出的状态里 released_marker_at = null;已有的码(already)不动',
      'W0-23 已知边界:残留 B 未删时又触发新码——ensure 因 B 已存在不重写(新码只靠状态);状态写入前崩溃 = 尚未触发,下次 enforceMute 仍把 B 当残留删掉',
    ],
    mustKill: ['触发:marker.ensure 先于 state.write 先于 canary.mute'],
  },
  {
    id: 'enforce_no_mute',
    clause: 'R21-10.1 崩溃后每次 worker 步骤补做 canary 置位',
    edits: [swap(BR, 'return d.canary.mute();', 'return false;')],
    tests: [T_BR],
    expectRed: [
      '状态已写、mute 崩溃',
      '状态写入崩溃:标记已在盘上(hint 看得到),状态没写;下一次 enforceMute 补码、不删标记、补 mute',
      'W0-21:U(用户标记)存在而状态没码:worker 不补 user_paused、不写 state,但仍 mute',
      '有码而没有标记(状态已写、标记缺):enforceMute 补 B',
      '部分解除后标记仍在:enforceMute 不复活已被清掉的码(标记只记首个原因;状态里已有别的码时不补)',
      'W0-23 触发窗口仍补码:B 新建、状态未写,证据为 null / 缺键 / 旧值(另一个 at)→ 补码、不删 B',
      'B 的内容不是 by=breaker(by=user / 读不出)时 enforceMute 不据此补码',
      'W0-21 契约用例:worker 熔断 → 用户暂停 → 熔断条件恢复(自动解除):B 删了,U 仍在,isAutoPaused 仍为真、状态里没有 user_paused',
      'W0-23 人工码清除写盘后、删 B 前崩溃:重启后 enforceMute 不复活该码,删 B,U 不变',
      'W0-23 B 内容损坏(读不出 / at 缺失)+ 无码:沿用现有规则(不补码、不删 B、仍 mute),即便证据为 null',
    ],
    mustKill: ['状态已写、mute 崩溃'],
  },
  // ---- 锁序 ----
  {
    id: 'lock_guard_off',
    clause: 'R21-3.3 / W0-15 反向取锁守卫(personal/lock 持有时不得再拿 rsi/lock)',
    edits: [
      swap(
        LK,
        "if (target.sub === undefined && personalLockHeldInProcess()) throw new RsiLockError('internal');",
        '',
      ),
    ],
    tests: [T_LK],
    expectRed: ['先 personal 后 rsi → internal'],
    mustKill: ['先 personal 后 rsi → internal'],
  },
  {
    id: 'lock_mark_missing',
    clause: 'R21-3.3 personal 锁获取成功后登记',
    edits: [swap(PL, '      markPersonalLockHeld(file);\n', '')],
    tests: [T_LK],
    expectRed: ['先 personal 后 rsi → internal'],
    mustKill: ['先 personal 后 rsi → internal'],
  },
  {
    id: 'lock_unmark_missing',
    clause: 'R21-3.3 释放后注销登记(守卫不残留)',
    edits: [swap(PL, '            unmarkPersonalLockHeld(file);\n', '')],
    tests: [T_LK],
    expectRed: [
      '正向顺序 rsi → personal 允许',
      '先 personal 后 rsi → internal(反向取锁);rsi 锁文件没有被创建',
      'personal 锁获取失败(已被占)不会残留登记:登记只在拿到锁之后',
    ],
    mustKill: ['正向顺序 rsi → personal 允许'],
  },
  // ---- harm 串接 ----
  {
    id: 'chain_no_phase_gate',
    clause: 'W0-1 rollback_four_phase 能力闸',
    edits: [
      swap(HC, "if (!capabilityAvailable('rollback_four_phase', env.phase)) {", 'if (false) {'),
    ],
    tests: [T_HC],
    expectRed: ['能力闸:相位未到 V1b'],
    mustKill: ['能力闸:相位未到 V1b'],
  },
  {
    id: 'chain_any_state',
    clause: 'R21-4.4 只有 canary / rolling_back 的候选走 harm 回滚',
    edits: [
      swap(
        HC,
        "if (rec.lifecycle !== 'canary' && rec.lifecycle !== 'rolling_back') {",
        'if (false) {',
      ),
    ],
    tests: [T_HC],
    expectRed: ['候选不在 canary / rolling_back'],
    mustKill: ['候选不在 canary / rolling_back'],
  },
  {
    id: 'chain_by_clear',
    clause: 'W0-17 worker 自身伤害判定用 by=worker',
    edits: [swap(HC, "by: 'worker',", "by: 'clear',")],
    tests: [T_HC],
    expectRed: [
      'harm 结论 → 候选走完四段',
      'C4 越限也是 harm(reason=harm_c4)',
      '生产缺端口(payload 没装配):执行器 incomplete,凭据已落盘(hint 已停),journal 保留 —— 不假装完成',
      '仓库 deferred(人工分叉)时 harm:凭据照样落盘 —— hint 停止注入不依赖私有仓库',
    ],
    mustKill: ['harm 结论 → 候选走完四段'],
  },
  // ---- W0-20 journal 自带恢复事实(H1 / M4)与入口校验 ----
  {
    id: 'journal_no_sha',
    clause: 'W0-20 journal 首次落盘带 content_sha256(续做不依赖仓库 / 权威记录可读)',
    edits: [
      swap(RJ, '    content_sha256: req.content_sha256,\n    by: req.by,', '    by: req.by,'),
    ],
    tests: [T_JN],
    expectRed: [
      '盘上 journal 带齐三项',
      '崩于凭据落盘前',
      'reconcile(kind=reconcile)的 journal 同样带齐三项:终止事实由原因重建(vetoed → veto 事件,证据 txn:<id>)',
      ':崩于凭据落盘后(after:revocation),续做再崩于记录提交前(enter:static_removal_pending)',
      ':崩于记录提交前(enter:static_removal_pending),续做在仓库 deferred 下再崩,最后恢复续做到终态',
      '正常回滚:审计键集合固定(回滚路径 7 条转移条目 → 7 个键 = 条目的 idem_key),每键恰好落地一次',
      '提交后崩溃(after:record_terminal)续做:每个审计键仍只落地一次',
      '审计落地失败(提交之后):收尾抛错、journal 保留;修好后续做补齐全部审计键,各一次',
      'recoverTerminalEffects 对执行器终态补审计(按键幂等,再跑不重复)',
    ],
    mustKill: ['盘上 journal 带齐三项', '崩于凭据落盘前'],
  },
  {
    id: 'journal_no_by',
    clause: 'W0-20 journal 首次落盘带 by(来源保留)',
    edits: [swap(RJ, '    by: req.by,\n    terminal_event: event,', '    terminal_event: event,')],
    tests: [T_JN],
    expectRed: [
      '盘上 journal 带齐三项',
      'reconcile(kind=reconcile)的 journal 同样带齐三项:终止事实由原因重建(vetoed → veto 事件,证据 txn:<id>)',
      ':崩于凭据落盘前(journal:rollback_requested),仓库 deferred 下续做写出凭据,再崩于凭据后',
      ':崩于凭据落盘后(after:revocation),续做再崩于记录提交前(enter:static_removal_pending)',
      ':崩于记录提交前(enter:static_removal_pending),续做在仓库 deferred 下再崩,最后恢复续做到终态',
      '正常回滚:审计键集合固定(回滚路径 7 条转移条目 → 7 个键 = 条目的 idem_key),每键恰好落地一次',
      '提交后崩溃(after:record_terminal)续做:每个审计键仍只落地一次',
      '审计落地失败(提交之后):收尾抛错、journal 保留;修好后续做补齐全部审计键,各一次',
      'recoverTerminalEffects 对执行器终态补审计(按键幂等,再跑不重复)',
    ],
    mustKill: ['盘上 journal 带齐三项'],
  },
  {
    id: 'journal_no_event',
    clause: 'W0-20 journal 首次落盘带 terminal_event(limit_reached 等无法由原因还原的事件)',
    edits: [swap(RJ, '    terminal_event: event,\n  });', '  });')],
    tests: [T_JN],
    expectRed: [
      '盘上 journal 带齐三项',
      '崩于凭据落盘后',
      'reconcile(kind=reconcile)的 journal 同样带齐三项:终止事实由原因重建(vetoed → veto 事件,证据 txn:<id>)',
      ':崩于凭据落盘前(journal:rollback_requested),仓库 deferred 下续做写出凭据,再崩于凭据后',
      ':崩于记录提交前(enter:static_removal_pending),续做在仓库 deferred 下再崩,最后恢复续做到终态',
      '正常回滚:审计键集合固定(回滚路径 7 条转移条目 → 7 个键 = 条目的 idem_key),每键恰好落地一次',
      '提交后崩溃(after:record_terminal)续做:每个审计键仍只落地一次',
      '审计落地失败(提交之后):收尾抛错、journal 保留;修好后续做补齐全部审计键,各一次',
      'recoverTerminalEffects 对执行器终态补审计(按键幂等,再跑不重复)',
    ],
    mustKill: ['盘上 journal 带齐三项', '崩于凭据落盘后'],
  },
  {
    id: 'event_schema_skipped',
    clause: 'W0-20 新 journal 的创建函数:事件在持久化之前过转移引擎的事件 schema',
    edits: [
      swap(
        RJ,
        "if (!p.success) return { ok: false, why: 'event_invalid', cause: 'candidate_invalid' };",
        '',
      ),
    ],
    tests: [T_JN],
    expectRed: ['事件不合规 → refused event_invalid'],
    mustKill: ['事件不合规 → refused event_invalid'],
  },
  {
    id: 'late_event_schema_skipped',
    clause: 'W0-20 复用在途 txn 时较晚事件也先过事件 schema(不合规 = refused,零动作)',
    edits: [
      swap(
        RB,
        "if (!p.success) {\n      return { status: 'refused', txn: null, why: 'event_invalid', cause: 'candidate_invalid' };\n    }",
        '',
      ),
    ],
    tests: [T_JB],
    expectRed: ['较晚事件不合规'],
    mustKill: ['较晚事件不合规'],
  },
  {
    id: 'event_required_off',
    clause: 'W0-20 新 journal:拿不到终止事件(不能无证据重建)就不创建',
    edits: [
      swap(
        RJ,
        "if (event === undefined) {\n      return { ok: false, why: 'event_required', cause: 'manual_event_required' };\n    }",
        '',
      ),
    ],
    tests: [T_JB],
    expectRed: [
      '没有事件而原因不能无证据重建',
      'harm_c1 的 rolling_back 记录没有 journal:refused event_required,不写 journal / 凭据',
    ],
    mustKill: ['没有事件而原因不能无证据重建'],
  },
  {
    id: 'event_reason_unchecked',
    clause:
      'W0-20 terminal_event 与 reason 一致:terminationReason(event) === reason(新建与读取共用)',
    edits: [
      swap(RJ, "if (terminationReason(event) !== reason) return 'event_reason_mismatch';", ''),
    ],
    tests: [T_JB, T_JN],
    expectRed: [
      'cleared 携带 veto 事件',
      'terminal_event 与 reason 不一致(harm_c1 的 journal 带 veto 事件)',
      'vetoed 携带 clear 事件',
      'harm_c1 携带 c2 指标事件',
      'harm_c1 携带 judge 事件',
      'limit_reached 携带 harm 事件',
      '带 HARM 事件但与 reason 不一致的新格式 journal 不被当作旧格式:txn_invalid',
      'terminal_event 与 reason 不一致(harm_c1 的 journal 带 c2 指标的事件)',
    ],
    mustKill: [
      'cleared 携带 veto 事件',
      'terminal_event 与 reason 不一致(harm_c1 的 journal 带 veto 事件)',
    ],
  },
  {
    id: 'event_target_unchecked',
    clause:
      'W0-20 terminal_event 与 target_terminal 相容:terminationTarget(event) === target_terminal',
    edits: [
      swap(RJ, "if (terminationTarget(event) !== target) return 'event_target_mismatch';", ''),
    ],
    tests: [T_JB, T_JN],
    expectRed: [
      'limit_reached 配 target_terminal=rolled_back',
      'terminal_event 与 target_terminal 不一致',
      'harm_c1 配 target_terminal=expired(事件的目标是 rolled_back)',
    ],
    mustKill: [
      'limit_reached 配 target_terminal=rolled_back',
      'terminal_event 与 target_terminal 不一致',
    ],
  },
  {
    id: 'new_event_check_skipped',
    clause: 'W0-20 新 journal 创建函数在持久化前校验事件与 reason / target 一致(零副作用拒绝)',
    edits: [
      swap(
        RJ,
        "  const ep = eventProblem(event, req.reason, req.target_terminal);\n  if (ep !== null) return { ok: false, why: ep, cause: 'candidate_invalid' };\n",
        '',
      ),
    ],
    tests: [T_JB],
    expectRed: [
      'cleared 携带 veto 事件',
      'harm_c1 配 target_terminal=expired',
      'vetoed 携带 clear 事件',
      'harm_c1 携带 c2 指标事件',
      'harm_c1 携带 judge 事件',
      'limit_reached 携带 harm 事件',
      'limit_reached 配 target_terminal=rolled_back(事件的目标是 expired)',
    ],
    mustKill: ['cleared 携带 veto 事件', 'harm_c1 配 target_terminal=expired'],
  },
  {
    id: 'read_event_check_skipped',
    clause:
      'W0-20 读已有 journal:terminal_event 与 reason / target 不一致 = txn_invalid(零后续写入)',
    edits: [
      swap(
        RJ,
        'if (event !== undefined && eventProblem(event, t.reason, t.target_terminal) !== null) return bad;',
        '',
      ),
    ],
    tests: [T_JB, T_JN],
    expectRed: [
      '带 HARM 事件但与 reason 不一致的新格式 journal',
      'terminal_event 与 reason 不一致(harm_c1 的 journal 带 veto 事件)',
      'terminal_event 与 reason 不一致(harm_c1 的 journal 带 c2 指标的事件)',
      'terminal_event 与 target_terminal 不一致(harm 事件配 expired)',
    ],
    mustKill: ['带 HARM 事件但与 reason 不一致的新格式 journal'],
  },
  {
    id: 'journal_event_unchecked',
    clause: 'W0-20 续做:terminal_event 过不了事件 schema = txn_invalid(fail-closed)',
    edits: [
      swap(RJ, '    if (!p.success) return bad;\n    event = p.data;', '    event = p.data;'),
    ],
    tests: [T_JN],
    expectRed: ['terminal_event 过不了转移引擎的事件 schema', 'terminal_event 缺必填字段'],
    mustKill: ['terminal_event 过不了转移引擎的事件 schema'],
  },
  {
    id: 'journal_sha_unchecked',
    clause: 'W0-20 续做:content_sha256 必须与 txn_id 对得上',
    edits: [
      swap(RJ, 'if (rollbackTxnId(t.candidate_id, t.content_sha256) !== t.txn_id) return bad;', ''),
    ],
    tests: [T_JN],
    expectRed: ['content_sha256 与 txn_id 对不上'],
    mustKill: ['content_sha256 与 txn_id 对不上'],
  },
  {
    id: 'journal_by_unchecked',
    clause: 'W0-20 续做:by 必须与 (kind, reason) 相容',
    edits: [swap(RJ, 'if (sourceProblem(t.by, t.kind, t.reason) !== null) return bad;', '')],
    tests: [T_JN],
    expectRed: [
      'by 与 (kind, reason) 不相容',
      '复用在途 txn 的入口读到不合规 journal 同样 refused,且不施加请求带来的较晚事件',
    ],
    mustKill: ['by 与 (kind, reason) 不相容'],
  },
  {
    id: 'event_fabricated',
    clause: 'W0-20 终止事件只对无证据要求的原因重建(harm / judge / limit 不伪造证据)',
    edits: [
      swap(
        RJ,
        "      return { kind: 'taint', evidence };\n    default:\n      return undefined;",
        "      return { kind: 'taint', evidence };\n    default:\n      return { kind: 'harm', evidence, metric: 'c1', worse: true };",
      ),
    ],
    tests: [T_JB],
    expectRed: [
      '终止事件需要原始证据',
      '没有事件而原因不能无证据重建',
      'harm_c1 的 rolling_back 记录没有 journal:refused event_required,不写 journal / 凭据',
      '凭据已写(旧 journal 在第三段)而终止事件拿不到:仍 incomplete,记录与仓库都不再动',
      '只带部分恢复键(sha + by,没有 terminal_event;0e9b1f7 写过这种 reconcile)按键逐个处理:harm_c1 拿不到事件 → incomplete(terminal_event)',
    ],
    mustKill: ['终止事件需要原始证据', '没有事件而原因不能无证据重建'],
  },
  {
    id: 'legacy_sha_unbound',
    clause: 'W0-20 旧 journal 的内容哈希来源必须与 txn_id 对得上',
    edits: [
      swap(
        RJ,
        's !== null && s !== undefined && rollbackTxnId(t.candidate_id, s) === t.txn_id',
        's !== null && s !== undefined',
      ),
    ],
    tests: [T_JB],
    expectRed: ['recordedSha 对不上 txn_id 不采信'],
    mustKill: ['recordedSha 对不上 txn_id 不采信'],
  },
  {
    id: 'legacy_incomplete_ignored',
    clause: 'W0-20 旧 journal 三项事实没收齐 = incomplete,先于任何事务动作(不写凭据)',
    edits: [
      swap(
        RJ,
        'if (missing.length > 0 || by === undefined || event === undefined || sha === undefined) {',
        'if (false) {',
      ),
    ],
    tests: [T_JB],
    expectRed: [
      '终止事件需要原始证据',
      '来源有歧义(rollback_to 或 clear)',
      '内容哈希:不信权威副本的当前值(记录里有、但没有凭据也没有 recordedSha)→ W0-20:必需项缺失且不可恢复 = incomplete(带事务身份 txn;cause manual_event_required),不写凭据',
      '内容哈希:recordedSha 对不上 txn_id 不采信;复用入口时请求带来的内容哈希也不是允许的来源',
      '多项缺失一并报告(by + content_sha256;cleared 的事件可重建,不在其列)',
      '凭据已写(旧 journal 在第三段)而终止事件拿不到:仍 incomplete,记录与仓库都不再动',
      '只带部分恢复键(sha + by,没有 terminal_event;0e9b1f7 写过这种 reconcile)按键逐个处理:harm_c1 拿不到事件 → incomplete(terminal_event)',
    ],
    mustKill: ['终止事件需要原始证据', '来源有歧义(rollback_to 或 clear)'],
  },
  // ---- M5 identity_changed(V6a)本期拒绝 ----
  {
    id: 'identity_runs',
    clause: 'M5 identity_changed 入口拒绝(不写 journal、不部分执行)',
    edits: [
      swap(
        RB,
        "if (identity) {\n    return {\n      status: 'refused',\n      txn: null,\n      why: 'identity_not_available_before_v6a',\n      cause: 'candidate_invalid',\n    };\n  }",
        '',
      ),
    ],
    tests: [T_RB],
    // 没有在途 txn 时创建函数也会拒绝(同一结果);入口这条独有的作用是不让 identity 请求复用在途的回滚 txn
    expectRed: ['已有在途回滚 txn 时 identity 请求同样被入口拒绝'],
    mustKill: ['已有在途回滚 txn 时 identity 请求同样被入口拒绝'],
  },
  {
    id: 'identity_journal_runs',
    clause: 'M5 读到旧的 identity_change journal 不动',
    edits: [
      swap(
        RJ,
        "if (t.kind === 'identity_change') {\n    return {\n      kind: 'invalid',\n      why: 'identity_not_available_before_v6a',\n      cause: 'candidate_invalid',\n    };\n  }",
        '',
      ),
    ],
    tests: [T_RB],
    expectRed: ['读到旧的 identity_change journal'],
    mustKill: ['读到旧的 identity_change journal'],
  },
  // ---- H2 分叉下撤销完成 ----
  {
    id: 'deferred_incomplete',
    clause: 'H2 记录读不到(分叉)时撤销四段完成即 revocation_complete',
    edits: [
      swap(
        RB,
        'return deferredDone(`repo_deferred:${rd.why}`);',
        'return inc(`repo_deferred:${rd.why}`);',
      ),
    ],
    tests: [T_RB, T_CU],
    expectRed: [
      '私有仓库 deferred:凭据照样落盘',
      'clear 遇人工分叉',
      'worker 路径(装配 deferralMark):写 repo_removal_deferred 标记 → workingMarked=true;分叉解除后 resumeAll(仍带 deferralMark)→ complete、journal 删、记录到终态',
      'deferralMark 落地失败:异常向上(journal 保留,凭据已落盘),不返回 workingMarked=true',
      '权威记录读不到(deferred):撤销事务照常运行(HOME 清理不受阻),结果带 lateEventNotApplied;仓库恢复后调用方重试 → 施加并完成(vetoed)',
    ],
    mustKill: ['私有仓库 deferred:凭据照样落盘', 'clear 遇人工分叉'],
  },
  {
    id: 'deferred_rem_incomplete',
    clause: 'H2 仓库提交 deferred 时撤销四段完成即 revocation_complete',
    edits: [
      swap(
        RB,
        'return deferredDone(`repo_deferred:${rem.why}`);',
        'return inc(`repo_deferred:${rem.why}`);',
      ),
    ],
    tests: [T_RB],
    expectRed: ['记录可读但仓库提交 deferred'],
    mustKill: ['记录可读但仓库提交 deferred'],
  },
  {
    id: 'deferral_mark_skipped',
    clause: 'H2 worker 路径写 repo_removal_deferred 标记(deferralMark)',
    edits: [swap(RB, 'await d.deferralMark.mark(t.candidate_id);', '')],
    tests: [T_CU],
    expectRed: [
      'worker 路径(装配 deferralMark)',
      'deferralMark 落地失败:异常向上(journal 保留,凭据已落盘),不返回 workingMarked=true',
    ],
    mustKill: ['worker 路径(装配 deferralMark)'],
  },
  {
    id: 'marked_always',
    clause: 'H2 没有 deferralMark 端口时不宣称已写工作副本(workingMarked=false)',
    edits: [swap(RB, 'let marked = false;', 'let marked = true;')],
    tests: [T_CU, T_RB],
    expectRed: ['clear 遇人工分叉', '私有仓库 deferred:凭据照样落盘'],
    mustKill: ['clear 遇人工分叉'],
  },
  {
    id: 'clear_pending_lost',
    clause: 'H2 clear 报告列出 repoRemovalPending',
    edits: [swap(CL, "(o.status === 'revocation_complete' ? [o.candidate_id] : [])", '[]')],
    tests: [T_CU],
    expectRed: ['clear 遇人工分叉'],
    mustKill: ['clear 遇人工分叉'],
  },
  // ---- H3 AUTO_PAUSE 标记先于状态 ----
  {
    id: 'marker_after_state',
    clause: 'H3 / W0-21 熔断先写 B(AUTO_PAUSE_BREAKER)标记,再写状态,后 mute',
    edits: [
      swap(BR, '  await d.marker.breaker.ensure(reason);\n', ''),
      swap(
        BR,
        '  await d.canary.mute();\n  return r;',
        '  await d.marker.breaker.ensure(reason);\n  await d.canary.mute();\n  return r;',
      ),
    ],
    tests: [T_BR, T_PM],
    expectRed: [
      '触发:marker.ensure 先于 state.write 先于 canary.mute',
      'state.write 崩溃:hint 的许可端口读到',
      '状态写入崩溃:标记已在盘上(hint 看得到),状态没写;下一次 enforceMute 补码、不删标记、补 mute',
      '崩溃后下一次 enforceMute:由标记补码、标记保留',
      '新建标记:文件 fsync → 父目录 fsync → state.write(顺序)',
      'B 已存在(可能尚未落盘,如上次崩溃时别的进程刚建):不覆盖内容,但补一次文件 fsync 与父目录 fsync,之后才写 state',
      '已存在的标记不是单链接普通文件(硬链接)→ 拒绝、不写 state(fail-closed)',
      '已存在的标记是没有写端的 FIFO:在有界时间内拒绝(不阻塞在只读打开上),不写 state',
    ],
    mustKill: [
      '触发:marker.ensure 先于 state.write 先于 canary.mute',
      'state.write 崩溃:hint 的许可端口读到',
    ],
  },
  {
    id: 'enforce_marker_missing',
    clause: 'H3 有码缺标记:enforceMute 补标记',
    edits: [
      swap(BR, 'if (b === null && first !== undefined) await d.marker.breaker.ensure(first);', ''),
    ],
    tests: [T_BR, T_PM],
    expectRed: [
      '有码而没有标记',
      '有码缺标记:enforceMute 补标记',
      'enforceMute 补标记(有码缺标记)也走同一条持久路径',
    ],
    mustKill: ['有码而没有标记'],
  },
  {
    id: 'enforce_code_restore_skipped',
    clause: 'H3 有标记缺码:enforceMute 由标记补码(不删标记)',
    edits: [swap(BR, '    if (cur.reasons.length === 0) {', '    if (false) {')],
    tests: [T_BR, T_PM],
    expectRed: [
      '状态写入崩溃:标记已在盘上',
      '崩溃后下一次 enforceMute:由标记补码',
      'W0-23 触发窗口仍补码:B 新建、状态未写,证据为 null / 缺键 / 旧值(另一个 at)→ 补码、不删 B',
      'W0-23 人工码清除写盘后、删 B 前崩溃:重启后 enforceMute 不复活该码,删 B,U 不变',
      'W0-23 自动解除同款:清码写盘后、删 B 前崩溃 → 重启不复活、删 B',
      'W0-23 W8 resume 只清状态、B 留给 worker(带证据的写入,不调 remove):下次 worker 运行删 B、不补码',
      'W0-23 B 内容损坏(读不出 / at 缺失)+ 无码:沿用现有规则(不补码、不删 B、仍 mute),即便证据为 null',
      'W0-23 已知边界:残留 B 未删时又触发新码——ensure 因 B 已存在不重写(新码只靠状态);状态写入前崩溃 = 尚未触发,下次 enforceMute 仍把 B 当残留删掉',
      '熔断 → 状态带证据地清空(B 留下)→ enforceMute:B 被删、不补码;U 内容不变',
    ],
    mustKill: ['状态写入崩溃:标记已在盘上'],
  },
  {
    id: 'marker_overwrite',
    clause: 'H3 / W0-21 B 标记独占创建、已存在不覆盖',
    edits: [
      swap(
        PM,
        'import { createExclusiveDurable, remove } from',
        'import { createExclusiveDurable, remove, writeFile } from',
      ),
      swap(
        PM,
        'return createExclusiveDurable(io, file, body, RSI_FILE_MODE);\n    },\n    async remove() {',
        "return writeFile(io, file, body, { mode: RSI_FILE_MODE }).then(() => 'created' as const);\n    },\n    async remove() {",
      ),
    ],
    tests: [T_PM],
    expectRed: [
      '熔断写 B 不写 U;U 已存在(用户先暂停)时 ensure 仍创建 B,U 内容不变',
      '新建标记:文件 fsync → 父目录 fsync → state.write(顺序)',
      'B 已存在(可能尚未落盘,如上次崩溃时别的进程刚建):不覆盖内容,但补一次文件 fsync 与父目录 fsync,之后才写 state',
      'enforceMute 补标记(有码缺标记)也走同一条持久路径',
      '创建后写入失败:抛错(调用方不写 state)且**不删除**刚创建的标记(无锁并发下别的 ensure 可能已对它返回 exists)',
      '已存在的标记是没有写端的 FIFO:在有界时间内拒绝(不阻塞在只读打开上),不写 state',
    ],
    mustKill: ['熔断写 B 不写 U;U 已存在(用户先暂停)时 ensure 仍创建 B,U 内容不变'],
  },
  {
    id: 'release_keeps_marker',
    clause: 'H3 自动解除:无剩余码时删 worker 写的标记',
    edits: [swap(BR, 'if (r.clearMarker) await d.marker.breaker.remove();', '')],
    tests: [T_BR, T_PM],
    expectRed: [
      '自动解除:先写状态、后删 B;只在没有剩余码且确有码被清时删;U 无论如何不删',
      '自动解除:仍有码 → B 保留;清空 → 删 B',
      'W0-21 契约用例:worker 熔断 → 用户暂停 → 熔断条件恢复(自动解除):B 删了,U 仍在,isAutoPaused 仍为真、状态里没有 user_paused',
      'W0-23 解除证据:人工解除清到无码时,同一次状态写入记下被解除 B 的 at(部分清除不记);B 不存在时记 null',
      'W0-23 自动解除同款:清码写盘后、删 B 前崩溃 → 重启不复活、删 B',
      '契约用例(W0-21):worker 熔断 → 用户暂停 → 熔断条件恢复:B 被自动解除删掉,U 仍在,hint 仍停注入',
    ],
    mustKill: ['自动解除:先写状态、后删 B;只在没有剩余码且确有码被清时删;U 无论如何不删'],
  },
  {
    id: 'release_removes_any',
    clause: 'W0-21 B 端口只作用于 B:熔断 / 自动解除不得读写删 U(用户标记)',
    edits: [
      swap(
        PM,
        'const file = path.join(rsiDir, CANARY_FILES.pauseBreaker);',
        'const file = path.join(rsiDir, CANARY_FILES.pause);',
      ),
    ],
    tests: [T_PM],
    expectRed: [
      'B 只在 B 上:熔断不创建 U 文件',
      '契约用例(W0-21):worker 熔断 → 用户暂停 → 熔断条件恢复:B 被自动解除删掉,U 仍在,hint 仍停注入',
      'state.write 崩溃:hint 的许可端口读到 B=present(状态没写);标记内容 {at, by:breaker, reason}',
      '有码缺标记:enforceMute 补标记(独占创建)',
      '熔断 → 状态带证据地清空(B 留下)→ enforceMute:B 被删、不补码;U 内容不变',
      '熔断写 B 不写 U;U 已存在(用户先暂停)时 ensure 仍创建 B,U 内容不变',
      '内容读不出(空文件)的 B:仍算存在,by=unknown;enforceMute 不据此补码,但仍 mute',
      '人工 resume 的 worker 侧:无剩余码时删 B、不删 U',
      '已存在的标记不是单链接普通文件(硬链接)→ 拒绝、不写 state(fail-closed)',
      '创建后写入失败:抛错(调用方不写 state)且**不删除**刚创建的标记(无锁并发下别的 ensure 可能已对它返回 exists)',
      '已存在的标记是没有写端的 FIFO:在有界时间内拒绝(不阻塞在只读打开上),不写 state',
    ],
    mustKill: ['B 只在 B 上:熔断不创建 U 文件'],
  },
  {
    id: 'release_marker_early',
    clause: 'H3 自动解除:仍有剩余码时标记保留',
    edits: [
      swap(
        BR,
        'clearMarker: released.length > 0 && reasons.length === 0,',
        'clearMarker: released.length > 0,',
      ),
    ],
    tests: [T_BR],
    expectRed: [
      '自动解除:先写状态、后删 B;只在没有剩余码且确有码被清时删;U 无论如何不删',
      'W0-23 解除证据:人工解除清到无码时,同一次状态写入记下被解除 B 的 at(部分清除不记);B 不存在时记 null',
    ],
    mustKill: ['自动解除:先写状态、后删 B;只在没有剩余码且确有码被清时删;U 无论如何不删'],
  },
  {
    id: 'resume_marker_early',
    clause: 'H3 人工 resume:仍有剩余码时标记保留(hint 继续停注入)',
    edits: [
      swap(
        BR,
        "clearMarker: cleared.length > 0 && reasons.every((r) => r === 'user_paused'),",
        'clearMarker: cleared.length > 0,',
      ),
    ],
    tests: [T_BR],
    expectRed: [
      '人工 resume(worker 侧):没有剩余熔断码时删 B;仍有码时 B 保留(hint 继续停注入);U 不归这里',
    ],
    mustKill: [
      '人工 resume(worker 侧):没有剩余熔断码时删 B;仍有码时 B 保留(hint 继续停注入);U 不归这里',
    ],
  },
  {
    id: 'reuse_check_skipped',
    clause: 'W0-20 复用在途 txn:journal 校验先于较晚事件的施加(不合规 = 零副作用)',
    edits: [swap(RB, "if (jr.kind === 'invalid') return invalidJournal(id, jr);", '')],
    tests: [T_JN],
    expectRed: [
      '较晚事件不施加(记录 / 审计 / 效果 / 凭据 / payload 零写入)',
      '复用在途 txn 的入口读到不合规 journal 同样 refused,且不施加请求带来的较晚事件',
    ],
    mustKill: ['较晚事件不施加(记录 / 审计 / 效果 / 凭据 / payload 零写入)'],
  },
  {
    id: 'enforce_resurrects_partial',
    clause: 'H3 enforceMute 只在状态一个码都没有时由标记补码(部分解除后不复活已清的码)',
    edits: [
      swap(BR, '    if (cur.reasons.length === 0) {', '    if (!cur.reasons.includes(b.reason)) {'),
    ],
    tests: [T_BR],
    expectRed: ['部分解除后标记仍在:enforceMute 不复活已被清掉的码'],
    mustKill: ['部分解除后标记仍在:enforceMute 不复活已被清掉的码'],
  },
  {
    id: 'resume_unknown_marker',
    clause: 'H3 内容读不出的标记(创建后写内容前被杀)可由人工 resume 清除',
    edits: [swap(BR, "if (m !== null && m.by !== 'breaker') await d.marker.breaker.remove();", '')],
    tests: [T_BR],
    expectRed: ['内容读不出的 B(创建后写内容前被杀)而状态没有码'],
    mustKill: ['内容读不出的 B(创建后写内容前被杀)而状态没有码'],
  },
  // ---- M6 审计行按键落地 ----
  {
    id: 'audit_not_keyed',
    clause: 'M6 审计行经带键端口落地(同一行只落一次)',
    edits: [
      swap(
        RB,
        'audit: keyedAuditSink(d.keyedEffects),',
        'audit: { append: async () => undefined },',
      ),
    ],
    tests: [T_JN],
    expectRed: ['rolling_back 上先后到达两个 evidence 不同的 harm_c1 事件'],
    mustKill: ['rolling_back 上先后到达两个 evidence 不同的 harm_c1 事件'],
  },
  {
    id: 'audit_no_finish',
    clause: 'M6 收尾按记录补做审计行(落地失败 / 提交后崩溃不丢)',
    edits: [swap(RB, 'await landAuditEffects(d.keyedEffects, rec),', "'none',")],
    tests: [T_JN],
    expectRed: [
      '审计落地失败(提交之后)',
      'recoverTerminalEffects 对执行器终态补审计(按键幂等,再跑不重复)',
    ],
    mustKill: ['审计落地失败(提交之后)'],
  },
  {
    id: 'audit_no_recover',
    clause: 'M6 recoverTerminalEffects 对执行器终态补审计',
    edits: [swap(ER, '? await landAuditEffects(d.effects, rec)', "? 'none'")],
    tests: [T_JN],
    expectRed: ['recoverTerminalEffects 对执行器终态补审计'],
    mustKill: ['recoverTerminalEffects 对执行器终态补审计'],
  },
  {
    id: 'audit_recover_all',
    clause: 'M6 只补执行器终态理由的审计(其余的审计行是转移当时直接追加的)',
    edits: [
      swap(
        ER,
        'rec.terminal_reason !== null && EXECUTOR_TERMINAL_REASONS.has(rec.terminal_reason)',
        'true',
      ),
    ],
    tests: [T_JN],
    expectRed: ['非执行器终态理由'],
    mustKill: ['非执行器终态理由'],
  },
  {
    id: 'audit_key_no_idem',
    clause: 'M6 审计键 = 转移条目的 idem_key(事件身份):不同条目不同键,即使行内容相同',
    edits: [
      swap(
        ER,
        '`audit:${candidateId}:${idemKey}`',
        '`audit:${candidateId}:${idemKey.slice(0, 0)}`',
      ),
    ],
    tests: [T_JN, T_AK],
    expectRed: [
      '审计键集合固定',
      'auditKeyOf = audit:<候选>:<idem_key>',
      'auditItemsOf:键取自条目的 idem_key,不同条目键不同(即使审计行内容相同)',
      'keyedAuditSink:带键的行经 applyOnce(键 = 事件身份),同一行内容、两个事件身份 → 两次 applyOnce',
      '提交后崩溃(after:record_terminal)续做:每个审计键仍只落地一次',
      '审计落地失败(提交之后):收尾抛错、journal 保留;修好后续做补齐全部审计键,各一次',
      'recoverTerminalEffects 对执行器终态补审计(按键幂等,再跑不重复)',
      'rolling_back 上先后到达两个 evidence 不同的 harm_c1 事件(自环):两行内容完全相同的审计各落一次,恢复补做不再增加',
    ],
    mustKill: ['审计键集合固定', 'auditKeyOf = audit:<候选>:<idem_key>'],
  },
  {
    id: 'audit_key_missing_ignored',
    clause: 'M6 缺事件身份的审计行 fail-closed(不回落到行内容哈希)',
    edits: [swap(ER, "if (it.idem_key === undefined) throw new Error('audit_key_missing');", '')],
    tests: [T_AK],
    expectRed: ['缺事件身份(没有转移条目的审计)'],
    mustKill: ['缺事件身份(没有转移条目的审计)'],
  },
  // ---- H3 标记持久化 ----
  {
    id: 'marker_no_file_sync',
    clause: 'H3 标记文件 fsync 之后才返回(新建与已存在都要;调用方此后才写 state)',
    edits: [
      swap(SF, '    await syncHandle(ctx, handle, abs);\n  } catch (e) {', '  } catch (e) {'),
    ],
    tests: [T_PM],
    expectRed: [
      '新建标记:文件 fsync → 父目录 fsync → state.write(顺序)',
      'B 已存在(可能尚未落盘',
      'enforceMute 补标记(有码缺标记)也走同一条持久路径',
    ],
    mustKill: ['新建标记:文件 fsync → 父目录 fsync → state.write(顺序)', 'B 已存在(可能尚未落盘'],
  },
  {
    id: 'marker_failure_unlinks',
    clause: 'H3 创建后失败不删除标记(无锁并发下别的 ensure 可能已确认它)',
    edits: [
      swap(
        SF,
        '    await handle.close().catch(() => undefined);\n    throw e;',
        '    await handle.close().catch(() => undefined);\n    await fsp.rm(abs, { force: true }).catch(() => undefined);\n    throw e;',
      ),
    ],
    tests: [T_PM],
    expectRed: ['创建后写入失败:抛错'],
    mustKill: ['创建后写入失败:抛错'],
  },
  {
    id: 'marker_fifo_blocks',
    clause: 'H3 已存在的目标是 FIFO:非阻塞打开后类型核对拒绝,不挂起熔断流程',
    edits: [swap(SF, ' | (fs.constants.O_NONBLOCK ?? 0)', '')],
    tests: [T_PM],
    expectRed: ['已存在的标记是没有写端的 FIFO'],
    mustKill: ['已存在的标记是没有写端的 FIFO'],
  },
  {
    id: 'marker_no_dir_sync',
    clause: 'H3 标记的父目录 fsync(目录项落盘)先于 state 写入',
    edits: [
      swap(SF, '  await fsyncDir(ctx, path.dirname(abs));\n  return outcome;', '  return outcome;'),
    ],
    tests: [T_PM],
    expectRed: [
      '新建标记:文件 fsync → 父目录 fsync → state.write(顺序)',
      'enforceMute 补标记(有码缺标记)也走同一条持久路径',
      'B 已存在(可能尚未落盘,如上次崩溃时别的进程刚建):不覆盖内容,但补一次文件 fsync 与父目录 fsync,之后才写 state',
    ],
    mustKill: ['新建标记:文件 fsync → 父目录 fsync → state.write(顺序)'],
  },
  {
    id: 'marker_exists_unchecked',
    clause: 'H3 已存在的标记必须是单链接普通文件,否则拒绝(不写 state)',
    edits: [
      swap(
        SF,
        '      if (!st.isFile() || st.nlink > 1) {\n        throw new WriteDeniedError(`写入被拒绝:已有标记不是单链接的普通文件:${abs}`);\n      }\n',
        '',
      ),
    ],
    tests: [T_PM],
    // 硬链接在更前面的写入守卫(assertWritable)就被拒,这条核对独有的作用是拦非普通文件(FIFO 等)
    expectRed: ['已存在的标记是没有写端的 FIFO'],
    mustKill: ['已存在的标记是没有写端的 FIFO'],
  },
  {
    id: 'origin_unclassified_free',
    clause:
      'W7b R3-H3 矛盾回滚记录(rollback 非空、无进入条目、dropped=0)按保守方向发 90 天 + 标记,不得无冷却',
    edits: [swap(TT, "    : { kind: 'unclassified' };", "    : { kind: 'not_applicable' };")],
    tests: [T_PR],
    expectRed: [
      'unclassified:rollback 非空、无进入条目、dropped = 0(自相矛盾);只有自环条目也算无进入条目',
      'unclassified + clear:90 天 + protection_unclassified(不是 protection_unknown);撤销 / 墓碑照常',
      '矛盾记录(rolling_back 夹具无进入条目)走完:终态批次 = 黑名单 + 墓碑 + 90 天 + protection_unclassified(同一批同一键);标记恰好一行,审计出口(audit: 键)没收到它',
      'unclassified × 改前规则(无 / 30 天 expired / 90 天 auto_rollback):都恰好一条 90 天冷却 + 一条 protection_unclassified(不因 legacy 已有冷却而漏标记)',
      'unclassified[]:矛盾记录的 id 出现在结果里;known / not_applicable 不出现;落地照常完成',
      '业务批次 deferred:标记未落、整体 deferred;批次可用后 recover 补出含标记的同一批,标记恰好一行',
      '终态已提交后、效果落地前崩溃:recover 补出含标记的同一批;重复 recover 不重复',
      '审计行落地 deferred(终态批次已落):收尾整体记 deferred,而不是报成功',
    ],
    mustKill: [
      'unclassified:rollback 非空、无进入条目、dropped = 0(自相矛盾);只有自环条目也算无进入条目',
    ],
  },
  {
    id: 'origin_na_as_unknown',
    clause:
      'W7b originProtection:没走过回滚(rollback=null)是 not_applicable,效果与改前相同,不得并入 unknown',
    edits: [
      swap(
        TT,
        "if (rec.rollback === null) return { kind: 'not_applicable' };",
        "if (rec.rollback === null) return { kind: 'unknown_rollback_origin' };",
      ),
    ],
    tests: [T_PR],
    expectRed: [
      'rollback=null → not_applicable(即便 transitions 里有 rolling_back 条目:以 rollback 字段为准)',
      '没走过回滚的终态与改前逐字节相同:闸拒绝无冷却;shadow 到期 30 天;直接 clear / veto 无冷却无标记',
      'known / not_applicable 永远没有标记',
    ],
    mustKill: [
      'rollback=null → not_applicable(即便 transitions 里有 rolling_back 条目:以 rollback 字段为准)',
    ],
  },
  {
    id: 'origin_null_by_transitions',
    clause: 'W7b originProtection 以 rollback 字段判「走过回滚」,不是以 transitions 里有无条目判',
    edits: [
      swap(
        TT,
        "if (rec.rollback === null) return { kind: 'not_applicable' };",
        "if (rec.transitions.length === 0) return { kind: 'not_applicable' };",
      ),
    ],
    tests: [T_PR],
    expectRed: [
      'rollback=null → not_applicable(即便 transitions 里有 rolling_back 条目:以 rollback 字段为准)',
      '没走过回滚的终态与改前逐字节相同:闸拒绝无冷却;shadow 到期 30 天;直接 clear / veto 无冷却无标记',
      'known / not_applicable 永远没有标记',
    ],
    mustKill: [
      'rollback=null → not_applicable(即便 transitions 里有 rolling_back 条目:以 rollback 字段为准)',
    ],
  },
  {
    id: 'origin_last_entry',
    clause: 'W7b 起因取第一条进入回滚的条目,不是最后一条',
    edits: [
      swap(
        TT,
        'const entering = rec.transitions.find(',
        'const entering = [...rec.transitions].reverse().find(',
      ),
    ],
    tests: [T_PR],
    expectRed: [
      'known:取第一条进入回滚的条目(不是最后一条);自环条目不算;limit_reached → expired,其余 → rolled_back',
    ],
    mustKill: [
      'known:取第一条进入回滚的条目(不是最后一条);自环条目不算;limit_reached → expired,其余 → rolled_back',
    ],
  },
  {
    id: 'origin_loop_counts',
    clause: 'W7b 自环条目(from = to = rolling_back)不算进入回滚的条目',
    edits: [
      swap(
        TT,
        "(e) => e.dim === 'lifecycle' && e.to === 'rolling_back' && e.from !== 'rolling_back',",
        "(e) => e.dim === 'lifecycle' && e.to === 'rolling_back',",
      ),
    ],
    tests: [T_PR],
    expectRed: [
      'known:取第一条进入回滚的条目(不是最后一条);自环条目不算;limit_reached → expired,其余 → rolled_back',
      'unclassified:rollback 非空、无进入条目、dropped = 0(自相矛盾);只有自环条目也算无进入条目',
      '矛盾记录(rolling_back 夹具无进入条目)走完:终态批次 = 黑名单 + 墓碑 + 90 天 + protection_unclassified(同一批同一键);标记恰好一行,审计出口(audit: 键)没收到它',
      '业务批次 deferred:标记未落、整体 deferred;批次可用后 recover 补出含标记的同一批,标记恰好一行',
      '终态已提交后、效果落地前崩溃:recover 补出含标记的同一批;重复 recover 不重复',
      '审计行落地 deferred(终态批次已落):收尾整体记 deferred,而不是报成功',
    ],
    mustKill: [
      'known:取第一条进入回滚的条目(不是最后一条);自环条目不算;limit_reached → expired,其余 → rolled_back',
    ],
  },
  {
    id: 'origin_harm_ignored',
    clause: 'owner 决定 1:harm 起因 → clear / veto / taint 终态仍发 90 天冷却',
    edits: [
      swap(TE, "if (terminalReasonOf(origin.origin_reason) === 'auto_rollback') {", 'if (false) {'),
    ],
    tests: [T_PR, T_EF],
    expectRed: [
      'harm 起因 → clear / veto / taint 终态:仍有 90 天 auto_rollback 冷却(原保护不因终态理由升级而丢)',
      'harm → veto:黑名单 + 墓碑 + 90 天,顺序固定',
      'E1 之后完成:E2 再含同一黑名单(不同键各落一次),集合成员与计数都只一份;E2 落地后再 recover 全 already',
      'harm 回滚中收到 veto(自环):E1 立即按 veto: 键落地;完成后 E2(终态键)含黑名单 + 墓碑 + 90 天(起因 harm),各键只落一次',
    ],
    mustKill: [
      'harm 起因 → clear / veto / taint 终态:仍有 90 天 auto_rollback 冷却(原保护不因终态理由升级而丢)',
    ],
  },
  {
    id: 'origin_limit_dropped',
    clause: 'owner 决定 1:limit_reached 起因 → clear 终态仍发 30 天 expired 冷却',
    edits: [swap(TE, "} else if (origin.origin_target === 'expired') {", '} else if (false) {')],
    tests: [T_PR],
    expectRed: [
      'limit_reached 起因 → clear:30 天 expired 冷却;limit_reached 终态(auto_expired)照旧 30 天',
    ],
    mustKill: [
      'limit_reached 起因 → clear:30 天 expired 冷却;limit_reached 终态(auto_expired)照旧 30 天',
    ],
  },
  {
    id: 'origin_judge_cooldown',
    clause: 'owner 决定 1:判定类起因不新增冷却(原来发什么就发什么)',
    edits: [
      swap(
        TE,
        "if (terminalReasonOf(origin.origin_reason) === 'auto_rollback') {",
        "if (terminalReasonOf(origin.origin_reason) !== 'cleared') {",
      ),
    ],
    tests: [T_PR],
    expectRed: [
      '判定类起因(judge_reject / judge_injection)→ clear:不新增冷却;起因为 cleared / vetoed / tainted 也不多发',
      'limit_reached 起因 → clear:30 天 expired 冷却;limit_reached 终态(auto_expired)照旧 30 天',
    ],
    mustKill: [
      '判定类起因(judge_reject / judge_injection)→ clear:不新增冷却;起因为 cleared / vetoed / tainted 也不多发',
    ],
  },
  {
    id: 'cooldown_two_kinds',
    clause: 'W7b 终态批次冷却至多一条:起因与终态事实同时给 90 与 30 时只留 90',
    edits: [swap(TE, 'if (strongest !== undefined) out.push(strongest);', 'out.push(...chosen);')],
    tests: [T_PR],
    expectRed: [
      '至多一条冷却(负向):limit_reached 进入回滚、补偿期间又收到 harm_c1(目标升为 rolled_back,终态事实给 90、起因给 30)→ 只发 90 天 auto_rollback',
      'limit_reached 起因 → clear:30 天 expired 冷却;limit_reached 终态(auto_expired)照旧 30 天',
      'unclassified × 改前规则(无 / 30 天 expired / 90 天 auto_rollback):都恰好一条 90 天冷却 + 一条 protection_unclassified(不因 legacy 已有冷却而漏标记)',
    ],
    mustKill: [
      '至多一条冷却(负向):limit_reached 进入回滚、补偿期间又收到 harm_c1(目标升为 rolled_back,终态事实给 90、起因给 30)→ 只发 90 天 auto_rollback',
    ],
  },
  {
    id: 'cooldown_weak_wins',
    clause: 'W7b 冷却保护取强:90 天覆盖 30 天',
    edits: [
      swap(
        TE,
        "chosen.find((c) => c.kind === 'auto_rollback') ?? chosen[0]",
        'chosen[chosen.length - 1]',
      ),
    ],
    tests: [T_PR],
    expectRed: [
      '至多一条冷却(负向):limit_reached 进入回滚、补偿期间又收到 harm_c1(目标升为 rolled_back,终态事实给 90、起因给 30)→ 只发 90 天 auto_rollback',
    ],
    mustKill: [
      '至多一条冷却(负向):limit_reached 进入回滚、补偿期间又收到 harm_c1(目标升为 rolled_back,终态事实给 90、起因给 30)→ 只发 90 天 auto_rollback',
    ],
  },
  {
    id: 'marker_dropped',
    clause: 'W7b M3 起因因截断丢失按保守方向补 90 天并发 protection_unknown 审计标记',
    edits: [swap(TE, 'if (mark !== null) out.push(mark);', '')],
    tests: [T_PR],
    expectRed: [
      'unknown_rollback_origin + clear:90 天 + protection_unknown;行可被既有 RsiAuditLineSchema 解析,at = 终态条目时间,不伪造 origin',
      'unclassified + clear:90 天 + protection_unclassified(不是 protection_unknown);撤销 / 墓碑照常',
      'unclassified × 改前规则(无 / 30 天 expired / 90 天 auto_rollback):都恰好一条 90 天冷却 + 一条 protection_unclassified(不因 legacy 已有冷却而漏标记)',
      '保护审计标记只落一次:随终态批次(terminal: 键)与冷却同一次 applyOnce 落地,重复 recover 不重复;不经 audit: 键',
      '批次 deferred:标记与冷却都没落(整批),结果记 deferred;之后批次可用 → 一次补齐,标记恰好一行',
      '矛盾记录(rolling_back 夹具无进入条目)走完:终态批次 = 黑名单 + 墓碑 + 90 天 + protection_unclassified(同一批同一键);标记恰好一行,审计出口(audit: 键)没收到它',
      '业务批次 deferred:标记未落、整体 deferred;批次可用后 recover 补出含标记的同一批,标记恰好一行',
      '终态已提交后、效果落地前崩溃:recover 补出含标记的同一批;重复 recover 不重复',
      '审计行落地 deferred(终态批次已落):收尾整体记 deferred,而不是报成功',
    ],
    mustKill: [
      'unknown_rollback_origin + clear:90 天 + protection_unknown;行可被既有 RsiAuditLineSchema 解析,at = 终态条目时间,不伪造 origin',
    ],
  },
  {
    id: 'marker_at_first_entry',
    clause: 'W7b M3 标记行的 at = 终态那条 lifecycle 条目的时间(确定性,即时与恢复同一行)',
    edits: [
      swap(
        TE,
        'const at = (terminalEntry ?? rec.transitions[rec.transitions.length - 1])?.at;',
        'const at = rec.transitions[0]?.at;',
      ),
    ],
    tests: [T_PR],
    expectRed: [
      'unknown_rollback_origin + clear:90 天 + protection_unknown;行可被既有 RsiAuditLineSchema 解析,at = 终态条目时间,不伪造 origin',
    ],
    mustKill: [
      'unknown_rollback_origin + clear:90 天 + protection_unknown;行可被既有 RsiAuditLineSchema 解析,at = 终态条目时间,不伪造 origin',
    ],
  },
  {
    id: 'unknown_marker_with_legacy',
    clause: 'W7b 改前规则已给冷却(终态 auto_rollback)时不加保护标记',
    edits: [swap(TE, '      if (legacy === null) {', '      if (true) {')],
    tests: [T_PR],
    expectRed: ['unknown 但改前规则已给冷却(终态 auto_rollback):不变,不加标记'],
    mustKill: ['unknown 但改前规则已给冷却(终态 auto_rollback):不变,不加标记'],
  },
  {
    id: 'audit_in_terminal_batch',
    clause:
      'W0-23 保护审计标记不是 append_audit:不走审计出口(audit: 键),只作为终态批次 E2 的 protection_mark 随 terminal: 键整批落地',
    edits: [swap(TE, "type: 'protection_mark',\n    line,", "type: 'append_audit',\n    line,")],
    tests: [T_PR],
    expectRed: [
      '矛盾记录(rolling_back 夹具无进入条目)走完:终态批次 = 黑名单 + 墓碑 + 90 天 + protection_unclassified(同一批同一键);标记恰好一行,审计出口(audit: 键)没收到它',
      '保护审计标记只落一次:随终态批次(terminal: 键)与冷却同一次 applyOnce 落地,重复 recover 不重复;不经 audit: 键',
      'unknown_rollback_origin + clear:90 天 + protection_unknown;行可被既有 RsiAuditLineSchema 解析,at = 终态条目时间,不伪造 origin',
      'unclassified + clear:90 天 + protection_unclassified(不是 protection_unknown);撤销 / 墓碑照常',
      'unclassified × 改前规则(无 / 30 天 expired / 90 天 auto_rollback):都恰好一条 90 天冷却 + 一条 protection_unclassified(不因 legacy 已有冷却而漏标记)',
      '业务批次 deferred:标记未落、整体 deferred;批次可用后 recover 补出含标记的同一批,标记恰好一行',
      '终态已提交后、效果落地前崩溃:recover 补出含标记的同一批;重复 recover 不重复',
      '审计行落地 deferred(终态批次已落):收尾整体记 deferred,而不是报成功',
    ],
    mustKill: [
      '矛盾记录(rolling_back 夹具无进入条目)走完:终态批次 = 黑名单 + 墓碑 + 90 天 + protection_unclassified(同一批同一键);标记恰好一行,审计出口(audit: 键)没收到它',
    ],
  },
  {
    id: 'mark_moved_out_of_batch',
    clause:
      'W0-23 把保护标记移出终态批次(单独 applyOnce、忽略其结果)= 标记与冷却可分离:批次 deferred 而标记已落',
    edits: [
      swap(
        ER,
        'return sink.applyOnce(terminalEffectKey(rec), effects);',
        "const r = await sink.applyOnce(terminalEffectKey(rec), effects.filter((e) => e.type !== 'protection_mark'));\n  for (const e of effects) if (e.type === 'protection_mark') await sink.applyOnce(auditKeyOf(rec.id, e.idem_key), [e]);\n  return r;",
      ),
    ],
    tests: [T_PR],
    expectRed: [
      '批次 deferred:标记与冷却都没落(整批),结果记 deferred;之后批次可用 → 一次补齐,标记恰好一行',
      '矛盾记录(rolling_back 夹具无进入条目)走完:终态批次 = 黑名单 + 墓碑 + 90 天 + protection_unclassified(同一批同一键);标记恰好一行,审计出口(audit: 键)没收到它',
      '保护审计标记只落一次:随终态批次(terminal: 键)与冷却同一次 applyOnce 落地,重复 recover 不重复;不经 audit: 键',
      '业务批次 deferred:标记未落、整体 deferred;批次可用后 recover 补出含标记的同一批,标记恰好一行',
      '终态已提交后、效果落地前崩溃:recover 补出含标记的同一批;重复 recover 不重复',
      '审计行落地 deferred(终态批次已落):收尾整体记 deferred,而不是报成功',
    ],
    mustKill: [
      '批次 deferred:标记与冷却都没落(整批),结果记 deferred;之后批次可用 → 一次补齐,标记恰好一行',
    ],
  },
  {
    id: 'batch_deferred_ignored',
    clause: 'W0-23 终态批次返回 deferred 时整体 deferred(忽略批次结果 = 业务未落却报成功)',
    edits: [
      swap(
        ER,
        'return sink.applyOnce(terminalEffectKey(rec), effects);',
        "await sink.applyOnce(terminalEffectKey(rec), effects);\n  return 'applied';",
      ),
    ],
    tests: [T_PR],
    expectRed: [
      '批次 deferred:标记与冷却都没落(整批),结果记 deferred;之后批次可用 → 一次补齐,标记恰好一行',
      '业务批次 deferred:标记未落、整体 deferred;批次可用后 recover 补出含标记的同一批,标记恰好一行',
      'E1 之后完成:E2 再含同一黑名单(不同键各落一次),集合成员与计数都只一份;E2 落地后再 recover 全 already',
      '终态已提交后、效果落地前崩溃:recover 补出含标记的同一批;重复 recover 不重复',
    ],
    mustKill: [
      '业务批次 deferred:标记未落、整体 deferred;批次可用后 recover 补出含标记的同一批,标记恰好一行',
    ],
  },
  {
    id: 'audit_deferred_ignored',
    clause: 'W0-23 回滚审计行 deferred 并入整体结果(忽略 = 审计未落却报成功)',
    edits: [swap(ER, "return audit === 'deferred' ? 'deferred' : batch;", 'return batch;')],
    tests: [T_PR],
    expectRed: [
      '审计行(回滚路径的转移条目)deferred 并入整体:即使终态批次 already,整体仍记 deferred',
      '审计行落地 deferred(终态批次已落):收尾整体记 deferred,而不是报成功',
    ],
    mustKill: [
      '审计行(回滚路径的转移条目)deferred 并入整体:即使终态批次 already,整体仍记 deferred',
    ],
  },
  {
    id: 'e1_duplicated',
    clause: 'W7b E1 并入 E2:终态批次已含同一 (id, sha) 黑名单时,引擎不在同一数组里重复推入',
    edits: [swap(TR, '    if (!covered) {', '    if (true) {')],
    tests: [T_PR],
    expectRed: ['E1 并入 E2:黑名单在引擎批次里恰好一份(veto 直接进终态:E2 含它,不再单独推 E1)'],
    mustKill: ['E1 并入 E2:黑名单在引擎批次里恰好一份(veto 直接进终态:E2 含它,不再单独推 E1)'],
  },
  {
    id: 'e1_only_when_terminal',
    clause: 'W7b E1:veto 使记录进入回滚(未进终态)时仍产出即时黑名单',
    edits: [swap(TR, '    if (!covered) {', '    if (!covered && terminalBatch.length > 0) {')],
    tests: [T_PR],
    expectRed: [
      'E1:veto 使记录进入回滚(未进终态)→ 只有 E1,没有墓碑;rolling_back 上 veto 自环同样产出 E1',
    ],
    mustKill: [
      'E1:veto 使记录进入回滚(未进终态)→ 只有 E1,没有墓碑;rolling_back 上 veto 自环同样产出 E1',
    ],
  },
  {
    id: 'second_pass_removed',
    clause:
      'W7b recoverTerminalEffects 第二遍:rolling_back 且 rollback.reason=vetoed 的记录补 E1 黑名单',
    edits: [
      swap(
        ER,
        "if (rec.lifecycle !== 'rolling_back' || rec.rollback?.reason !== 'vetoed') continue;",
        'continue;',
      ),
    ],
    tests: [T_PR],
    expectRed: [
      '回滚记录已提交、E1 落地前崩溃且回滚未完成:第二遍补出黑名单(veto: 键);再 recover → already',
    ],
    mustKill: [
      '回滚记录已提交、E1 落地前崩溃且回滚未完成:第二遍补出黑名单(veto: 键);再 recover → already',
    ],
  },
  {
    id: 'second_pass_any_rolling',
    clause: 'W7b 第二遍只补 vetoed 的 rolling_back,不是任何 rolling_back',
    edits: [
      swap(
        ER,
        "if (rec.lifecycle !== 'rolling_back' || rec.rollback?.reason !== 'vetoed') continue;",
        "if (rec.lifecycle !== 'rolling_back') continue;",
      ),
    ],
    tests: [T_PR],
    expectRed: [
      '负向:rolling_back 但原因不是 vetoed、或 veto 之外的状态 → 第二遍不补;非终态不走第一遍',
    ],
    mustKill: [
      '负向:rolling_back 但原因不是 vetoed、或 veto 之外的状态 → 第二遍不补;非终态不走第一遍',
    ],
  },
  {
    id: 'veto_key_is_terminal',
    clause: 'W7b E1 键(veto:)与 E2 键(terminal:)分开,互不混用',
    edits: [
      swap(
        TE,
        '`veto:${rec.id}:${rec.content_sha256}`',
        '`terminal:${rec.id}:${rec.content_sha256}`',
      ),
    ],
    tests: [T_PR],
    expectRed: [
      '键:E1 与 E2 的键不同且互不混用',
      'E1 之后完成:E2 再含同一黑名单(不同键各落一次),集合成员与计数都只一份;E2 落地后再 recover 全 already',
      'harm 回滚中收到 veto(自环):E1 立即按 veto: 键落地;完成后 E2(终态键)含黑名单 + 墓碑 + 90 天(起因 harm),各键只落一次',
      '矛盾记录(rolling_back 夹具无进入条目)走完:终态批次 = 黑名单 + 墓碑 + 90 天 + protection_unclassified(同一批同一键);标记恰好一行,审计出口(audit: 键)没收到它',
      '终态已提交后、效果落地前崩溃:recover 补出含标记的同一批;重复 recover 不重复',
      '审计行落地 deferred(终态批次已落):收尾整体记 deferred,而不是报成功',
    ],
    mustKill: ['键:E1 与 E2 的键不同且互不混用'],
  },
  {
    id: 'executor_drops_e1',
    clause: 'W7b 执行器里 veto 自环的 E1 立即按 veto: 键落地(applyDeps.effects 不能是空实现)',
    edits: [
      swap(
        RB,
        "if (e.type === 'blacklist_veto') await d.keyedEffects.applyOnce(vetoEffectKey(e), [e]);",
        '',
      ),
    ],
    tests: [T_PR],
    expectRed: [
      'harm 回滚中收到 veto(自环):E1 立即按 veto: 键落地;完成后 E2(终态键)含黑名单 + 墓碑 + 90 天(起因 harm),各键只落一次',
    ],
    mustKill: [
      'harm 回滚中收到 veto(自环):E1 立即按 veto: 键落地;完成后 E2(终态键)含黑名单 + 墓碑 + 90 天(起因 harm),各键只落一次',
    ],
  },
  {
    id: 'engine_terminal_forked',
    clause: 'W7b 引擎尾部与 recover 同调 terminalEffectsOf:引擎不另写一份终态效果',
    edits: [
      swap(
        TR,
        '      ? terminalEffectsOf(final)\n      : [];',
        "      ? terminalEffectsOf(final).filter((e) => e.type !== 'start_cooldown')\n      : [];",
      ),
    ],
    tests: [T_PR],
    expectRed: ['引擎的终态部分 == terminalEffectsOf(next)'],
    mustKill: ['引擎的终态部分 == terminalEffectsOf(next)'],
  },
  {
    id: 'cause_not_wired_retryable',
    clause: 'W7b ③ port_not_wired 的 cause 是 not_wired,不归 retryable',
    edits: [
      swap(
        RB,
        "why: `port_not_wired:${e.port}`,\n        cause: 'not_wired',",
        "why: `port_not_wired:${e.port}`,\n        cause: 'retryable',",
      ),
    ],
    tests: [T_CA],
    expectRed: [
      '端口没装配(runGuarded 包成的 port_not_wired)',
      'not_wired 不被归成 retryable',
      'not_wired',
    ],
    mustKill: ['端口没装配(runGuarded 包成的 port_not_wired)'],
  },
  {
    id: 'cause_integrity_has_txn',
    clause: 'W7b ③ R3-H2 journal 完整性错误不带事务身份(txn: null,journal 句柄单给)',
    edits: [
      swap(
        RB,
        "  txn: null,\n  journal,\n  why,\n  cause: 'txn_invalid',",
        "  txn: journal,\n  journal,\n  why,\n  cause: 'txn_invalid',",
      ),
    ],
    tests: [T_CA],
    expectRed: [
      'journal 完整性错误不带事务身份(txn: null,journal 句柄单给):同 (id, sha) 的 complete 消除不了它',
      '不变量:cause=txn_invalid 的 outcome 一律是 refused、txn=null、journal 句柄为字符串(逐 case 校验;失败 variant incomplete 永不带 txn_invalid)',
    ],
    mustKill: [
      'journal 完整性错误不带事务身份(txn: null,journal 句柄单给):同 (id, sha) 的 complete 消除不了它',
    ],
  },
  {
    id: 'cause_drift_swapped',
    clause: 'W7b ③ 第四段 drift 的 cause 是 retryable',
    edits: [
      swap(
        RB,
        "\n  if (r.status === 'drift') return { ok: false, why: `drift:${r.why}`, cause: 'retryable' };",
        "\n  if (r.status === 'drift') return { ok: false, why: `drift:${r.why}`, cause: 'repo_unreadable' };",
      ),
    ],
    tests: [T_CA],
    expectRed: [
      '用户改过的块(drift)',
      'journal 完整性错误不带事务身份(txn: null,journal 句柄单给):同 (id, sha) 的 complete 消除不了它',
    ],
    mustKill: ['用户改过的块(drift)'],
  },
  {
    id: 'cause_legacy_swapped',
    clause:
      'W7b ③ 旧格式 journal:缺原始证据 / 缺内容哈希 → manual_event_required,只缺来源 → manual_by_ambiguous',
    edits: [
      swap(
        RJ,
        "missing.includes('terminal_event') || missing.includes('content_sha256')\n          ? 'manual_event_required'\n          : 'manual_by_ambiguous',",
        "missing.includes('terminal_event') || missing.includes('content_sha256')\n          ? 'manual_by_ambiguous'\n          : 'manual_event_required',",
      ),
    ],
    tests: [T_CA],
    expectRed: [
      '旧格式 journal 缺原始证据(legacy_unrecoverable:terminal_event)',
      '旧格式 journal 缺来源(legacy_unrecoverable:by)',
      'manual_event_required',
    ],
    mustKill: ['旧格式 journal 缺原始证据(legacy_unrecoverable:terminal_event)'],
  },
  {
    id: 'cause_success_carries',
    clause: 'W7b ③ 成功 variant(complete)不带 cause',
    edits: [
      swap(
        RB,
        "  return { status: 'complete', txn: t.txn_id, effects };",
        "  return { status: 'complete', txn: t.txn_id, effects, cause: 'retryable' } as RollbackOutcome;",
      ),
    ],
    tests: [T_CA],
    expectRed: [
      '成功 variant 没有 cause:complete / revocation_complete(后者携 repoRemoval=deferred)不被归成失败',
    ],
    mustKill: [
      '成功 variant 没有 cause:complete / revocation_complete(后者携 repoRemoval=deferred)不被归成失败',
    ],
  },
  {
    id: 'marker_user_remove_unguarded',
    clause: 'W7b U 的 remove 必须比对实例令牌(令牌 none 永不删)',
    edits: [swap(PM, "if (!sameToken(token, cur)) return 'changed';", '')],
    tests: [T_PM],
    expectRed: [
      'remove(token):令牌与当前实例一致才删;令牌 none 永不删(resume 期间新建的 U 保留);实例被换 → changed 不删',
    ],
    mustKill: [
      'remove(token):令牌与当前实例一致才删;令牌 none 永不删(resume 期间新建的 U 保留);实例被换 → changed 不删',
    ],
  },
  {
    id: 'permit_unreadable_wins',
    clause: 'W0-21 hint 读集合:任一 present → present(确证的暂停原因优先于读失败)',
    edits: [swap(PR, "if (user === 'present' || breaker === 'present') return 'present';", '')],
    tests: [T_PD],
    expectRed: [
      'combinePauseReads:3×3 矩阵',
      '负向:U 读失败而 B 在 → present(不是 unreadable);B 读失败而 U 在 → present;只一个读失败而另一个不在 → unreadable(不是 absent)',
      '只有 B → present;只有 U → present;都没有 → absent;两个都在 → present',
    ],
    mustKill: ['combinePauseReads:3×3 矩阵'],
  },
  {
    id: 'permit_unreadable_absent',
    clause: 'W0-21 hint 读集合:否则任一读失败 → unreadable(不可读不等于不存在)',
    edits: [
      swap(PR, "if (user === 'unreadable' || breaker === 'unreadable') return 'unreadable';", ''),
    ],
    tests: [T_PD],
    expectRed: [
      'combinePauseReads:3×3 矩阵',
      '负向:U 读失败而 B 在 → present(不是 unreadable);B 读失败而 U 在 → present;只一个读失败而另一个不在 → unreadable(不是 absent)',
      'rsi 目录本身读不了(路径下面是普通文件 → ENOTDIR,非 ENOENT)→ unreadable,不冒充 absent',
    ],
    mustKill: ['combinePauseReads:3×3 矩阵'],
  },
  {
    id: 'permit_ignores_breaker',
    clause: 'W0-21 hint 读集合追加 AUTO_PAUSE_BREAKER',
    edits: [
      swap(
        PR,
        'readPause(path.join(rsiDir, CANARY_FILES.pauseBreaker)),',
        "Promise.resolve('absent' as PauseRead),",
      ),
    ],
    tests: [T_PD, T_HE],
    expectRed: [
      '只有 B → present;只有 U → present;都没有 → absent;两个都在 → present',
      'W0-21:只有 AUTO_PAUSE_BREAKER 在场(worker 熔断标记)→ 同样 excluded/paused;只有用户 AUTO_PAUSE 也停;两者都不在才恢复',
    ],
    mustKill: ['只有 B → present;只有 U → present;都没有 → absent;两个都在 → present'],
  },
  {
    id: 'enforce_ignores_user',
    clause: 'W0-21 enforceMute 把 U 存在算作暂停(仍 mute),但不补码',
    edits: [
      swap(
        BR,
        'const present = b !== null || userPresent || anyMarkerPresent === true;',
        'const present = b !== null || anyMarkerPresent === true;',
      ),
    ],
    tests: [T_BR],
    expectRed: [
      'W0-21:U(用户标记)存在而状态没码:worker 不补 user_paused、不写 state,但仍 mute',
      'W0-21 契约用例:worker 熔断 → 用户暂停 → 熔断条件恢复(自动解除):B 删了,U 仍在,isAutoPaused 仍为真、状态里没有 user_paused',
      'W0-23 人工码清除写盘后、删 B 前崩溃:重启后 enforceMute 不复活该码,删 B,U 不变',
    ],
    mustKill: ['W0-21:U(用户标记)存在而状态没码:worker 不补 user_paused、不写 state,但仍 mute'],
  },
  {
    id: 'resume_clears_user_paused',
    clause: 'W0-21 user_paused 判据是 U 存在:resume 不据 state 里的该码清码',
    edits: [swap(BR, "if (code === 'user_paused') continue;", '')],
    tests: [T_BR],
    expectRed: [
      'W0-21:resume 不据 state 里的 user_paused 清码(判据是 U 存在,命令层处理);清掉熔断码且只剩 user_paused → 仍通知 worker 路径删 B;没清则不',
    ],
    mustKill: [
      'W0-21:resume 不据 state 里的 user_paused 清码(判据是 U 存在,命令层处理);清掉熔断码且只剩 user_paused → 仍通知 worker 路径删 B;没清则不',
    ],
  },
  {
    id: 'unclassified_legacy_exempt',
    clause:
      'W7b R3-H3 矛盾记录无条件发 90 天 + protection_unclassified(不因改前规则已有冷却而豁免)',
    edits: [
      swap(
        TE,
        "    case 'unclassified':\n      // 自相矛盾的记录(R3-H3):无条件按保守方向贡献 90 天 + 独立标记;最终冷却至多一条由下面的取强保证\n      fromOrigin = cooldown(rec, 'auto_rollback');\n      markReason = PROTECTION_UNCLASSIFIED_REASON;\n",
        "    case 'unclassified':\n      if (legacy === null) {\n        fromOrigin = cooldown(rec, 'auto_rollback');\n        markReason = PROTECTION_UNCLASSIFIED_REASON;\n      }\n",
      ),
    ],
    tests: [T_PR],
    expectRed: [
      'unclassified × 改前规则(无 / 30 天 expired / 90 天 auto_rollback):都恰好一条 90 天冷却 + 一条 protection_unclassified(不因 legacy 已有冷却而漏标记)',
    ],
    mustKill: [
      'unclassified × 改前规则(无 / 30 天 expired / 90 天 auto_rollback):都恰好一条 90 天冷却 + 一条 protection_unclassified(不因 legacy 已有冷却而漏标记)',
    ],
  },
  {
    id: 'cause_halt_flattened',
    clause: 'W7b ③ 引擎 halt 逐值映射 cause(仓库类 halt 不得压成 retryable)',
    edits: [
      swap(
        RB,
        "    case 'repo_absent':\n    case 'repo_deferred':\n    case 'repo_invalid':\n      return 'repo_unreadable';",
        "    case 'repo_absent':\n    case 'repo_deferred':\n    case 'repo_invalid':\n      return 'retryable';",
      ),
    ],
    tests: [T_CA],
    expectRed: ['收尾时引擎 halt 为仓库不可读(finish 的 record_halt:repo_invalid)'],
    mustKill: ['收尾时引擎 halt 为仓库不可读(finish 的 record_halt:repo_invalid)'],
  },
  {
    id: 'legacy_sha_with_identity',
    clause:
      'W7b W0-20 / W0-22 第 13 条:旧格式 journal 缺内容哈希且取不回 = incomplete(带事务身份、不写凭据),不是完整性错误 refused / txn: null',
    edits: [
      swap(
        RJ,
        "    const why = `legacy_unrecoverable:${missing.join(',')}`;\n",
        "    const why = `legacy_unrecoverable:${missing.join(',')}`;\n    if (missing.includes('content_sha256')) return { kind: 'invalid', why, cause: 'txn_invalid' };\n",
      ),
    ],
    tests: [T_JB, T_CA],
    expectRed: [
      'W0-20:必需项缺失且不可恢复 = incomplete(带事务身份 txn;cause manual_event_required),不写凭据',
      '旧格式 journal 缺内容哈希且凭据 / head.json 都取不回(legacy_unrecoverable:content_sha256;W0-20:缺失不可恢复 = incomplete,带事务身份)',
      '内容哈希:recordedSha 对不上 txn_id 不采信;复用入口时请求带来的内容哈希也不是允许的来源',
      '多项缺失一并报告(by + content_sha256;cleared 的事件可重建,不在其列)',
    ],
    mustKill: [
      'W0-20:必需项缺失且不可恢复 = incomplete(带事务身份 txn;cause manual_event_required),不写凭据',
    ],
  },
  // ---- W0-23 解除证据(修复一)----
  {
    id: 'evidence_always_restore',
    clause:
      'W0-23 B 在、状态无码:at 与解除证据相等 = 解除窗口残留,删 B 不补码(去掉比较 = 一律补码,已解除的码复活)',
    edits: [swap(BR, 'if (isReleasedResidue(b, cur)) {', 'if (false) {')],
    tests: [T_BR, T_PM],
    expectRed: [
      'W0-23 人工码清除写盘后、删 B 前崩溃:重启后 enforceMute 不复活该码,删 B,U 不变',
      'W0-23 自动解除同款:清码写盘后、删 B 前崩溃 → 重启不复活、删 B',
      'W0-23 W8 resume 只清状态、B 留给 worker(带证据的写入,不调 remove):下次 worker 运行删 B、不补码',
      'W0-23 已知边界:残留 B 未删时又触发新码——ensure 因 B 已存在不重写(新码只靠状态);状态写入前崩溃 = 尚未触发,下次 enforceMute 仍把 B 当残留删掉',
      '熔断 → 状态带证据地清空(B 留下)→ enforceMute:B 被删、不补码;U 内容不变',
    ],
    mustKill: ['W0-23 人工码清除写盘后、删 B 前崩溃:重启后 enforceMute 不复活该码,删 B,U 不变'],
  },
  {
    id: 'evidence_always_delete',
    clause:
      'W0-23 触发窗口(B 已落盘、状态未写)仍补码:证据不等时不得删 B(去掉比较 = 一律删,破坏触发侧 fail-closed)',
    edits: [swap(BR, 'if (isReleasedResidue(b, cur)) {', 'if (true) {')],
    tests: [T_BR, T_PM],
    expectRed: [
      'W0-23 触发窗口仍补码:B 新建、状态未写,证据为 null / 缺键 / 旧值(另一个 at)→ 补码、不删 B',
      '状态写入崩溃:标记已在盘上(hint 看得到),状态没写;下一次 enforceMute 补码、不删标记、补 mute',
      'W0-23 B 内容损坏(读不出 / at 缺失)+ 无码:沿用现有规则(不补码、不删 B、仍 mute),即便证据为 null',
      '崩溃后下一次 enforceMute:由标记补码、标记保留',
    ],
    mustKill: [
      'W0-23 触发窗口仍补码:B 新建、状态未写,证据为 null / 缺键 / 旧值(另一个 at)→ 补码、不删 B',
    ],
  },
  {
    id: 'evidence_null_matches',
    clause: 'W0-23 比较两边必须都是非空字符串:null / 缺键 / B 读不出不得「相等」',
    edits: [
      swap(
        BR,
        "return typeof b.at === 'string' && b.at !== '' && typeof ev === 'string' && b.at === ev;",
        'return (b.at ?? null) === (ev ?? null);',
      ),
    ],
    tests: [T_BR],
    expectRed: [
      'W0-23 触发窗口仍补码:B 新建、状态未写,证据为 null / 缺键 / 旧值(另一个 at)→ 补码、不删 B',
      'W0-23 B 内容损坏(读不出 / at 缺失)+ 无码:沿用现有规则(不补码、不删 B、仍 mute),即便证据为 null',
    ],
    mustKill: [
      'W0-23 B 内容损坏(读不出 / at 缺失)+ 无码:沿用现有规则(不补码、不删 B、仍 mute),即便证据为 null',
    ],
  },
  {
    id: 'evidence_not_stamped',
    clause:
      'W0-23 清空熔断码的那一次状态写入同时记解除证据(解除时不写证据 = 残留 B 无法与触发窗口区分)',
    edits: [
      swap(BR, 'return { ...next, released_marker_at: b?.at ?? null };', 'return { ...next };'),
    ],
    tests: [T_BR, T_PM],
    expectRed: [
      'W0-23 解除证据:人工解除清到无码时,同一次状态写入记下被解除 B 的 at(部分清除不记);B 不存在时记 null',
      'W0-23 人工码清除写盘后、删 B 前崩溃:重启后 enforceMute 不复活该码,删 B,U 不变',
      'W0-23 自动解除同款:清码写盘后、删 B 前崩溃 → 重启不复活、删 B',
      'W0-23 W8 resume 只清状态、B 留给 worker(带证据的写入,不调 remove):下次 worker 运行删 B、不补码',
      '熔断 → 状态带证据地清空(B 留下)→ enforceMute:B 被删、不补码;U 内容不变',
    ],
    mustKill: [
      'W0-23 解除证据:人工解除清到无码时,同一次状态写入记下被解除 B 的 at(部分清除不记);B 不存在时记 null',
    ],
  },
  {
    id: 'evidence_trip_keeps',
    clause: 'W0-23 新的熔断触发成功写入状态时把解除证据清回 null',
    edits: [
      swap(
        BR,
        "typeof s.released_marker_at === 'string' ? { released_marker_at: null } : ({} as const);",
        '({} as const);',
      ),
    ],
    tests: [T_BR],
    expectRed: [
      'W0-23 新触发清回证据:tripBreaker / tripAndMute 写出的状态里 released_marker_at = null;已有的码(already)不动',
    ],
    mustKill: [
      'W0-23 新触发清回证据:tripBreaker / tripAndMute 写出的状态里 released_marker_at = null;已有的码(already)不动',
    ],
  },
  {
    id: 'evidence_at_unparsed',
    clause:
      'W0-23 B 内容里的 at 由 parsePauseMarker 解出(比较对象);丢掉 = 证据永远不等,残留 B 永远复活码',
    edits: [swap(PM, 'at: okAt ? at : null };', 'at: null };')],
    tests: [T_PM, T_BR],
    expectRed: [
      'parsePauseMarker:各形态',
      'W0-23 解除证据(真文件):清码写盘后残留的 B 不复活码,被 enforceMute 删掉;U 不动',
      '有码缺标记:enforceMute 补标记(独占创建)',
    ],
    mustKill: ['parsePauseMarker:各形态'],
  },
];

/** 变异整表的执行结果(由主代理执行后回填;W7 实装块留空) */
/** 实测结果:crq r21w7-j-mut @8f38b59(seal,97 条)+ r21w7-k-mut2 @fb4aa07(seal,2 条):99/99 KILLED */
export const V1_W7_RESULTS: readonly V1W7Result[] = [
  // W7b 改写 / 新增了变异条目:结果由主代理跑完变异后按变异表同序回填(不自己编结果)
];
