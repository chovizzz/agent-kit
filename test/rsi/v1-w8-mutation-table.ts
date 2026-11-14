/**
 * §21 V1 W8a 必杀变异(命令面的路由 / 能力闸、只读命令、停住候选三态与 `AutoView` 读取语义、两套一致性协议、退出码映射、受限只读 git 适配器、`rollback --to` 选取规则、
 * `rsi report` 已观察范围、show 输出边界;契约 R21-12 / R21-13、§21.24 W0-22 第 3 ~ 8 条、W0-24)。
 * 执行方式同 W5 / W6 / W7:验证机私有检出里 cp 备份 → 按锚点替换(每个锚点在对应文件里**恰好出现一次**)→ 跑 `tests` → 失败集合非空、全部命中 `expectRed`、
 * `mustKill` 每项至少命中一个、没有 skipped → cp 还原并逐文件 sha256 核对。**不用 git checkout / stash 还原**。
 * 本文件只写表与每条变异期望红的测试名(`expectRed` 是杀手测试名里的字面子串;参数化用例只取模板之外的固定片段);变异由主代理执行,
 * 结果记进 `V1_W8_RESULTS`(W8a 实装块不执行变异,故留空)。变异 id 用短的下划线词。
 *
 * W8b 追加(本表后共 58 条:W8b 首版 43 条,接手后新增 12 条〔读写分文件 / resume 自动解除码 / 缩减入口配置不可信 / rollback --to 的 yes 与 STALE / veto 重试〕,再加 `rsi status` 追加键 3 条;id 前缀 pause_ / resume_ / clear_ / out_ / veto_ / rbk_ / rebase_ / status_ / 预检 / 生产组装):写命令的处理函数(pause 不拿锁 / 不覆盖 / 只碰 U;resume 的线性化与指纹、结果行、顺序;
 * clear 的锁序与枚举失败、已完成项先输出;veto 的 deferred 不判 unknown_id、终态只写黑名单、持锁后重读;rollback --to 的 by / reason / 逆序 / 三把锁 / 矛盾记录先于写入;rebase 的确认与持锁复判;未接线预检零写入)。
 * W8b 的结果由主代理跑完回填(`V1_W8_RESULTS` 已重置为 `[]`,主代理整表重跑后统一回填 W8a + W8b)。
 * 不在本表的点(如实记录):端口契约的写侧由 `port-contract.test.ts` 的套件覆盖,不是变异;
 * 零写入的层 ②(`KIT_WRITE_ROOTS=:` 子进程)与 (c):相位 0 下经 `main()` 的新命令全是桩,子进程辅助脚本不能注入相位(见 `zero-write.test.ts` 头注);
 * journal 完整性错误「不被消除」的身份单列(`uniq:` 键)只由退出码相同的用例间接覆盖,不单列变异。
 */
export interface Edit {
  file: string;
  anchor: string;
  replacement: string;
}

export interface V1W8Mutation {
  id: string;
  /** 契约条款 / 该不变量 */
  clause: string;
  edits: readonly Edit[];
  /** 相对 `test/` */
  tests: readonly string[];
  expectRed: readonly string[];
  mustKill: readonly string[];
}

export interface V1W8Result {
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

export const V1_W8_MUTATIONS: readonly V1W8Mutation[] = [
  {
    id: 'gate_skipped',
    clause: 'R21-12.1 / W0-1 能力闸',
    edits: [
      swap(
        'src/rsi/auto/entry.ts',
        'if (!capabilityAvailable(RSI_AUTO_SUBCOMMAND_CAPS[route.canonical], phase)) {',
        'if (phase < -1) {',
      ),
    ],
    tests: ['rsi/auto/entry.test.ts'],
    expectRed: [
      '生产相位恒为 0:全部是桩',
      '未到期的命令不构造端口、不解析参数(坏参数照样是桩)、不调用写处理函数',
    ],
    mustKill: ['生产相位恒为 0:全部是桩'],
  },
  {
    id: 'write_not_stub',
    clause: 'W8a 写命令接未实现桩',
    edits: [
      swap(
        'src/rsi/auto/entry.ts',
        'return h === undefined ? rsiStubExit(ctx, route.canonical) : await h(ctx, route.rest);',
        'return h === undefined ? 0 : await h(ctx, route.rest);',
      ),
    ],
    tests: ['rsi/auto/entry.test.ts'],
    expectRed: ['写命令仍接到「未实现」桩'],
    mustKill: ['写命令仍接到「未实现」桩'],
  },
  {
    id: 'write_flag_ignored',
    clause: 'W8a --write 分流',
    edits: [
      swap(
        'src/rsi/auto/route.ts',
        "sub === 'clear' ? rest.includes('--write') : sub !== 'status'",
        "sub === 'clear' ? false : sub !== 'status'",
      ),
    ],
    tests: ['rsi/auto/entry.test.ts'],
    expectRed: [
      '--write 分流',
      '写处理函数的接缝:注入后按规范名调用,参数是二级命令名之后的 rest(W8b 只需替换处理函数)',
    ],
    mustKill: ['--write 分流'],
  },
  {
    id: 'rollback_write_ignored',
    clause: 'W8a --write 分流',
    edits: [swap('src/rsi/auto/route.ts', "write: argv.includes('--write')", 'write: false')],
    tests: ['rsi/auto/entry.test.ts'],
    expectRed: ['--write 分流'],
    mustKill: ['--write 分流'],
  },
  {
    id: 'unknown_sub_guess',
    clause: 'W8a 二级路由',
    edits: [
      swap(
        'src/rsi/auto/route.ts',
        'if (sub === undefined || !Object.hasOwn(AUTO_SUBS, sub)) return undefined;',
        'if (sub === undefined) return undefined;',
      ),
    ],
    tests: ['rsi/auto/entry.test.ts'],
    expectRed: ['auto 的五个二级命令'],
    mustKill: ['auto 的五个二级命令'],
  },
  {
    id: 'cap_threshold_lowered',
    clause: 'W0-1 cmd_rollback_to 属 V1b',
    edits: [swap('src/contracts/rsi.ts', "  cmd_rollback_to: 'V1b',", "  cmd_rollback_to: 'V1a',")],
    tests: ['rsi/auto/entry.test.ts'],
    expectRed: ['逐能力的相位边界'],
    mustKill: ['逐能力的相位边界'],
  },
  {
    id: 'stale_boundary',
    clause: 'R21-13.1 陈旧 48 小时',
    edits: [
      swap(
        'src/rsi/auto/read/view-read.ts',
        'age > RSI_AUTO_VIEW_STALE_HOURS * 3_600_000',
        'age >= RSI_AUTO_VIEW_STALE_HOURS * 3_600_000',
      ),
    ],
    tests: ['rsi/auto/status.test.ts'],
    expectRed: ['陈旧阈值 48 小时'],
    mustKill: ['陈旧阈值 48 小时'],
  },
  {
    id: 'stale_const_changed',
    clause: 'W0-22 第 7 条常量',
    edits: [
      swap(
        'src/contracts/rsi.ts',
        'export const RSI_AUTO_VIEW_STALE_HOURS = 48;',
        'export const RSI_AUTO_VIEW_STALE_HOURS = 96;',
      ),
    ],
    tests: ['rsi/auto/status.test.ts'],
    expectRed: [
      '陈旧阈值 48 小时',
      '视图陈旧 → 全部 unconfirmed:view_stale,数据照出并带 as_of;缺失 / 损坏视图 → rollback_stalled 为 null',
    ],
    mustKill: ['陈旧阈值 48 小时'],
  },
  {
    id: 'future_asof_fresh',
    clause: 'W0-22 第 7 条 as_of 未来',
    edits: [
      swap(
        'src/rsi/auto/read/view-read.ts',
        "if (age < -VIEW_CLOCK_SKEW_MS) return { state: 'corrupt' };",
        "if (age < -VIEW_CLOCK_SKEW_MS) return { state: 'fresh', view: r.data };",
      ),
    ],
    tests: ['rsi/auto/status.test.ts'],
    expectRed: ['陈旧阈值 48 小时'],
    mustKill: ['陈旧阈值 48 小时'],
  },
  {
    id: 'corrupt_as_missing',
    clause: 'W0-22 第 7 条 损坏语义',
    edits: [
      swap(
        'src/rsi/auto/read/view-read.ts',
        "if (!r.success) return { state: 'corrupt' };",
        "if (!r.success) return { state: 'missing' };",
      ),
    ],
    tests: ['rsi/auto/status.test.ts'],
    expectRed: ['缺失 → missing;读不出 / 非 JSON / 不合 schema → corrupt'],
    mustKill: ['缺失 → missing;读不出 / 非 JSON / 不合 schema → corrupt'],
  },
  {
    id: 'view_missing_zero',
    clause: 'W0-22 第 7 条 缺失不显示全零',
    edits: [
      swap(
        'src/rsi/auto/read/status.ts',
        'pipeline: v?.pipeline ?? null,',
        'pipeline: v?.pipeline ?? { states: {}, last30d: { rejected: 0, rolled_back: 0, expired: 0, retired: 0 } },',
      ),
    ],
    tests: ['rsi/auto/status.test.ts'],
    expectRed: [
      '缺失视图时派生键为 null',
      '损坏的视图:退 0,view_state=corrupt,派生键为 null(不是零)',
    ],
    mustKill: ['缺失视图时派生键为 null'],
  },
  {
    id: 'state_invalid_ignored',
    clause: 'R21-13.1 state 损坏退 3',
    edits: [
      swap(
        'src/rsi/auto/read/status.ts',
        "if (state.kind === 'invalid') return { kind: 'state_invalid' };",
        '',
      ),
    ],
    tests: ['rsi/auto/status.test.ts'],
    expectRed: ['state.json 过不了 schema → 退 3 state_invalid'],
    mustKill: ['state.json 过不了 schema → 退 3 state_invalid'],
  },
  {
    id: 'user_paused_not_added',
    clause: 'W0-22 第 1、7 条 user_paused 按 U 补',
    edits: [
      swap(
        'src/rsi/auto/read/status.ts',
        "if (markers.user === 'present') reasons.push('user_paused');",
        '',
      ),
    ],
    tests: ['rsi/auto/status.test.ts'],
    expectRed: ['用户标记 U 存在 → paused,pause_reasons 含 user_paused'],
    mustKill: ['用户标记 U 存在 → paused,pause_reasons 含 user_paused'],
  },
  {
    id: 'paused_ignores_owner',
    clause: 'W0-22 第 7 条 paused 判据',
    edits: [swap('src/rsi/auto/read/status.ts', 'ap?.ownerChanged === true;', 'false;')],
    tests: ['rsi/auto/status.test.ts'],
    expectRed: ['diverged / owner_changed 各自单独就使 paused 为真'],
    mustKill: ['diverged / owner_changed 各自单独就使 paused 为真'],
  },
  {
    id: 'breaker_marker_always',
    clause: 'W0-22 第 7 条 breaker_marker',
    edits: [
      swap(
        'src/rsi/auto/read/status.ts',
        "markers.breaker === 'present' && (ap?.reasons.length ?? 0) === 0 ? 'pending' : 'absent',",
        "markers.breaker === 'present' ? 'pending' : 'absent',",
      ),
    ],
    tests: ['rsi/auto/status.test.ts'],
    expectRed: ['B 在而状态无熔断码 → paused 且 breaker_marker=pending'],
    mustKill: ['B 在而状态无熔断码 → paused 且 breaker_marker=pending'],
  },
  {
    id: 'profile_effective_raw',
    clause: 'plan V1i-8 profile_effective',
    edits: [
      swap(
        'src/rsi/auto/read/status.ts',
        "profile_effective: phaseAtLeast('V3', phase) ? profile : 'lite',",
        'profile_effective: profile,',
      ),
    ],
    tests: ['rsi/auto/status.test.ts'],
    expectRed: ['profile_effective:相位 < V3 恒为 lite'],
    mustKill: ['profile_effective:相位 < V3 恒为 lite'],
  },
  {
    id: 'stalled_copy_recovers',
    clause: 'W0-22 第 10 条 不宣称自动恢复',
    edits: [
      swap('src/rsi/auto/read/status.ts', '不会自动恢复,终态原因记为', '会自动恢复,终态原因记为'),
    ],
    tests: ['rsi/auto/status.test.ts'],
    expectRed: ['明说「不会自动恢复」'],
    mustKill: ['明说「不会自动恢复」'],
  },
  {
    id: 'grace_inclusive',
    clause: 'W0-22 第 7 条 宽限 60 分钟',
    edits: [
      swap(
        'src/rsi/auto/read/stall.ts',
        'const past = ageMs > RSI_STALL_GRACE_MINUTES * 60_000;',
        'const past = ageMs >= RSI_STALL_GRACE_MINUTES * 60_000;',
      ),
    ],
    tests: ['rsi/auto/status.test.ts'],
    expectRed: ['超过 60 分钟宽限'],
    mustKill: ['超过 60 分钟宽限'],
  },
  {
    id: 'grace_const_changed',
    clause: 'W0-22 第 7 条常量',
    edits: [
      swap(
        'src/contracts/rsi.ts',
        'export const RSI_STALL_GRACE_MINUTES = 60;',
        'export const RSI_STALL_GRACE_MINUTES = 120;',
      ),
    ],
    tests: ['rsi/auto/status.test.ts'],
    expectRed: [
      '超过 60 分钟宽限',
      'harm_* / judge_* / limit_reached 都按不可重建类',
      '该候选已有 journal(按 (id, sha) 现算的 txn 名)→ 不列入;同 id 不同 sha 的 journal 不算',
      'stalled 时给出固定处置;明说「不会自动恢复」;不含「删除即可」,不宣称会自动恢复,不写「完成后 resume」',
    ],
    mustKill: ['超过 60 分钟宽限'],
  },
  {
    id: 'stall_recoverable_as_stalled',
    clause: 'W0-22 第 7 条 不可重建类',
    edits: [
      swap(
        'src/rsi/auto/read/stall.ts',
        "state: stall === 'event_required' && past ? 'stalled' : 'pending',",
        "state: past ? 'stalled' : 'pending',",
      ),
    ],
    tests: ['rsi/auto/status.test.ts'],
    expectRed: ['可重建类原因(cleared)即使超时也不是 stalled'],
    mustKill: ['可重建类原因(cleared)即使超时也不是 stalled'],
  },
  {
    id: 'stall_journal_ignored',
    clause: 'W0-22 第 7 条 有 journal 不列入',
    edits: [
      swap(
        'src/rsi/auto/read/stall.ts',
        '} else if (!ctx.journals.names.has(journalNameOf(e.id, e.content_sha256))) {',
        '} else if (true) {',
      ),
    ],
    tests: ['rsi/auto/status.test.ts'],
    expectRed: [
      '该候选已有 journal',
      'fresh + rolling_back_truncated=true + 可见条目都有 journal → rollback_stalled 为 [],但 rollback_stalled_truncated 为 true(分得清「没有」与「被截断」)',
    ],
    mustKill: ['该候选已有 journal'],
  },
  {
    id: 'stall_sha_ignored',
    clause: 'W0-22 第 7 条 按 (id, sha) 现算',
    edits: [
      swap(
        'src/rsi/auto/read/stall.ts',
        "txnId('rollback', [id], null, contentSha256);",
        "txnId('rollback', [id], null, 'b'.repeat(64));",
      ),
    ],
    tests: ['rsi/auto/status.test.ts'],
    expectRed: ['同 id 不同 sha 的 journal 不算'],
    mustKill: ['同 id 不同 sha 的 journal 不算'],
  },
  {
    id: 'stall_view_stale_ignored',
    clause: 'W0-22 第 7 条 陈旧视图 unconfirmed',
    edits: [
      swap(
        'src/rsi/auto/read/stall.ts',
        "if (ctx.viewState === 'stale') {",
        "if (ctx.viewState === 'never') {",
      ),
    ],
    tests: ['rsi/auto/status.test.ts'],
    expectRed: ['视图陈旧 → 全部 unconfirmed:view_stale'],
    mustKill: ['视图陈旧 → 全部 unconfirmed:view_stale'],
  },
  {
    id: 'existence_single_read',
    clause: 'W0-22 第 7 条 存在性弱协议',
    edits: [swap('src/rsi/auto/read/snapshot.ts', 'const b = await once();', 'const b = a;')],
    tests: ['rsi/auto/status.test.ts'],
    expectRed: [
      '存在性双读之间事务目录变化',
      '撤销凭据在双读之间变化同样 → snapshot_moving;事务目录读不出 → unconfirmed:txn_unreadable',
    ],
    mustKill: ['存在性双读之间事务目录变化'],
  },
  {
    id: 'status_reads_journal',
    clause: 'W0-22 第 7 条 status 不解析 journal',
    edits: [
      swap(
        'src/rsi/auto/read/status.ts',
        'journals = await confirmExistence(p.home);',
        "{\n        const n = await p.home.txnNames();\n        if (n.kind === 'ok') for (const x of n.names) await p.home.journal(x);\n        journals = await confirmExistence(p.home);\n      }",
      ),
    ],
    tests: ['rsi/auto/status.test.ts'],
    expectRed: [
      '完整运行后:受限只读 git 端口与 journal 内容读取的调用次数都是 0',
      '存在性双读之间事务目录变化 → unconfirmed:snapshot_moving(不重试、不退 4)',
    ],
    mustKill: ['完整运行后:受限只读 git 端口与 journal 内容读取的调用次数都是 0'],
  },
  {
    id: 'content_no_recheck',
    clause: 'W0-22 第 5 条 内容验证双读',
    edits: [
      swap(
        'src/rsi/auto/read/snapshot.ts',
        'const s2 = await takeSnapshot(home, Object.keys(s1.journals));',
        'const s2 = s1;',
      ),
    ],
    tests: ['rsi/auto/show.test.ts'],
    expectRed: [
      'head.json 在两次读之间被改动一次',
      '事务目录增删、撤销凭据变化 → 同样不稳定(用尽退 4)',
      '同名原子替换 journal / 只改 phase(目录成员不变)→ 内容摘要变化 → 不稳定;去掉 journal 内容复核会漏掉它',
    ],
    mustKill: ['head.json 在两次读之间被改动一次'],
  },
  {
    id: 'journal_digest_dropped',
    clause: 'W0-22 第 5 条 journal 内容摘要复核',
    edits: [
      swap(
        'src/rsi/auto/read/snapshot.ts',
        'return ka.every((k) => a.journals[k] === b.journals[k]);',
        'return true;',
      ),
    ],
    tests: ['rsi/auto/show.test.ts'],
    expectRed: ['同名原子替换 journal / 只改 phase'],
    mustKill: ['同名原子替换 journal / 只改 phase'],
  },
  {
    id: 'busy_as_failed',
    clause: 'W0-22 第 5 条 用尽退 4',
    edits: [
      swap(
        'src/rsi/auto/read/snapshot.ts',
        "  return { kind: 'busy' };\n}",
        "  return { kind: 'failed', why: 'busy' };\n}",
      ),
    ],
    tests: ['rsi/auto/show.test.ts'],
    expectRed: [
      '用尽退 4 RSI_SNAPSHOT_BUSY',
      '事务目录增删、撤销凭据变化 → 同样不稳定(用尽退 4)',
      '同名原子替换 journal / 只改 phase(目录成员不变)→ 内容摘要变化 → 不稳定;去掉 journal 内容复核会漏掉它',
      '记录提交对象消失(gc)→ 回到开头重试;持续消失 → 用尽退 4,不是「没有候选」',
    ],
    mustKill: ['用尽退 4 RSI_SNAPSHOT_BUSY'],
  },
  {
    id: 'consistency_claims_atomic',
    clause: 'W0-22 第 5 条 不得称原子',
    edits: [
      swap(
        'src/rsi/auto/read/snapshot.ts',
        "export const CONSISTENCY_LABEL = 'consistency=double-read';",
        "export const CONSISTENCY_LABEL = 'consistency=atomic';",
      ),
    ],
    tests: ['rsi/auto/show.test.ts'],
    expectRed: ['每处正文前带 RSI_AUTO_LABEL', '改后改回(ABA)不被检出:输出照常,文案不含「原子」'],
    mustKill: ['每处正文前带 RSI_AUTO_LABEL'],
  },
  {
    id: 'object_missing_not_retry',
    clause: 'W0-22 第 5 条 对象消失重试',
    edits: [
      swap(
        'src/rsi/auto/read/recorded-records.ts',
        "if (c.kind === 'missing') return { kind: 'retry' };",
        "if (c.kind === 'missing') return { kind: 'absent' };",
      ),
    ],
    tests: ['rsi/auto/show.test.ts'],
    expectRed: ['记录提交对象消失(gc)'],
    mustKill: ['记录提交对象消失(gc)'],
  },
  {
    id: 'unreadable_as_empty',
    clause: 'W0-22 第 6 条 读失败不当空',
    edits: [
      swap(
        'src/rsi/auto/read/recorded-records.ts',
        "if (c.kind === 'unreadable') return c;",
        "if (c.kind === 'unreadable') return { kind: 'ok', head, records: [], tree: new Map() };",
      ),
    ],
    tests: ['rsi/auto/show.test.ts'],
    expectRed: ['适配器不可读 / 未装配 → 3 personal_repo_invalid'],
    mustKill: ['适配器不可读 / 未装配 → 3 personal_repo_invalid'],
  },
  {
    id: 'record_id_mismatch_ok',
    clause: 'R21-3.8 文件名与记录 id 一致',
    edits: [
      swap(
        'src/rsi/auto/read/recorded-records.ts',
        "if (!p.success || p.data.id !== m[1]) return { kind: 'invalid', why: 'record' };",
        "if (!p.success) return { kind: 'invalid', why: 'record' };",
      ),
    ],
    tests: ['rsi/auto/show.test.ts'],
    expectRed: ['适配器不可读 / 未装配 → 3 personal_repo_invalid'],
    mustKill: ['适配器不可读 / 未装配 → 3 personal_repo_invalid'],
  },
  {
    id: 'show_no_tty_check',
    clause: 'R21-12.8 show 无 TTY 退 2',
    edits: [swap('src/rsi/auto/read/show.ts', "if (!isTty) return 'not_tty';", '')],
    tests: ['rsi/auto/show.test.ts'],
    expectRed: ['无 TTY → 退 2 not_tty'],
    mustKill: ['无 TTY → 退 2 not_tty'],
  },
  {
    id: 'show_no_leak_gate',
    clause: 'R21-12.8 show 泄漏闸',
    edits: [
      swap(
        'src/rsi/auto/read/show.ts',
        'return emitLines(io.sink, lines, io.forbidden);',
        'return emitLines(io.sink, lines, []);',
      ),
    ],
    tests: ['rsi/auto/show.test.ts'],
    expectRed: ['泄漏闸:正文含禁止值'],
    mustKill: ['泄漏闸:正文含禁止值'],
  },
  {
    id: 'show_label_dropped',
    clause: 'R21-1.9 正文前带标签',
    edits: [
      swap(
        'src/rsi/auto/read/show.ts',
        'import { RSI_AUTO_LABEL, RSI_SNAPSHOT_BUSY } from',
        'import { RSI_SNAPSHOT_BUSY } from',
      ),
      swap(
        'src/rsi/auto/read/show.ts',
        'const ID_RE = /^ra_[0-9a-f]{12}$/;',
        "const ID_RE = /^ra_[0-9a-f]{12}$/;\nconst RSI_AUTO_LABEL = '';",
      ),
    ],
    tests: ['rsi/auto/show.test.ts'],
    expectRed: [
      '每处正文前带 RSI_AUTO_LABEL',
      '有裁决记录 → 段内容带标签与清洗后的字段;自报记录带 declared',
    ],
    mustKill: ['每处正文前带 RSI_AUTO_LABEL'],
  },
  {
    id: 'show_body_unprefixed',
    clause: 'R21-12.8 正文不能伪造本命令的行',
    edits: [
      swap('src/rsi/auto/read/show.ts', 'head: `| ${cleanPath(l)}`', 'head: `${cleanPath(l)}`'),
    ],
    tests: ['rsi/auto/show.test.ts'],
    expectRed: [
      '正文不能伪造本命令的行',
      '每处正文前带 RSI_AUTO_LABEL(只引用常量);正文逐行带「| 」前缀;一致性口径是 double-read,不写「原子」',
      '裁决读取不可用 / 抛错 → 只有该段是 unavailable,其余输出与退出码不变',
    ],
    mustKill: ['正文不能伪造本命令的行'],
  },
  {
    id: 'show_body_unsanitized',
    clause: 'R21-12.8 正文清洗',
    edits: [swap('src/rsi/auto/read/show.ts', 'head: `| ${cleanPath(l)}`', 'head: `| ${l}`')],
    tests: ['rsi/auto/show.test.ts'],
    expectRed: ['正文清洗:控制 / 双向覆盖 / 行分隔字符'],
    mustKill: ['正文清洗:控制 / 双向覆盖 / 行分隔字符'],
  },
  {
    id: 'journal_binding_loose',
    clause: 'W0-22 第 10 条 journal=invalid',
    edits: [
      swap(
        'src/rsi/auto/read/journal-check.ts',
        "if (t.txn_id !== journalNameOf(id, contentSha256) || t.candidate_id !== id) return 'invalid';",
        "if (t.candidate_id !== id) return 'invalid';",
      ),
    ],
    tests: ['rsi/auto/show.test.ts'],
    expectRed: ['absent(只表示「该次读取下不存在」)'],
    mustKill: ['absent(只表示「该次读取下不存在」)'],
  },
  {
    id: 'report_claims_complete',
    clause: 'W0-22 第 8 条 不证明截断',
    edits: [swap('src/rsi/auto/read/report.ts', ';不证明保留策略是否截断', ';已完整覆盖')],
    tests: ['rsi/auto/report.test.ts'],
    expectRed: ['(1)完整但前几天无事件 与 (2)被截断'],
    mustKill: ['(1)完整但前几天无事件 与 (2)被截断'],
  },
  {
    id: 'report_prior_ignored',
    clause: 'W0-22 第 8 条 缺失 / 空文件而账显示有转移',
    edits: [
      swap(
        'src/rsi/auto/read/report.ts',
        "if (await p.priorActivity()) return { kind: 'fail', lines: [] };",
        '',
      ),
    ],
    tests: ['rsi/auto/report.test.ts'],
    expectRed: [
      '(3)空文件',
      '(4)文件缺失:无账显示 → 退 0 并标「无审计文件(未观察到任何事件)」;账显示曾有转移 → 退 3 audit_invalid',
    ],
    mustKill: ['(3)空文件'],
  },
  {
    id: 'report_skip_corrupt',
    clause: 'W0-22 第 8 条 坏行退 3',
    edits: [
      swap(
        'src/rsi/auto/read/report.ts',
        'if (parsed.corrupt > 0) return',
        'if (parsed.corrupt > 9999) return',
      ),
    ],
    tests: ['rsi/auto/report.test.ts'],
    expectRed: ['任一行不合规 → corrupt_lines=<n>'],
    mustKill: ['任一行不合规 → corrupt_lines=<n>'],
  },
  {
    id: 'report_before_flipped',
    clause: 'W0-22 第 8 条 request_before_observed',
    edits: [
      swap(
        'src/rsi/auto/read/report.ts',
        'request_before_observed: range.from < observed.from,',
        'request_before_observed: range.from > observed.from,',
      ),
    ],
    tests: ['rsi/auto/report.test.ts'],
    expectRed: [
      '(1)完整但前几天无事件 与 (2)被截断',
      '请求起点不早于已观察起点 → request_before_observed=false',
    ],
    mustKill: ['(1)完整但前几天无事件 与 (2)被截断'],
  },
  {
    id: 'report_week_start_shifted',
    clause: 'R21-13.3 --week 周一起',
    edits: [
      swap(
        'src/rsi/auto/read/report.ts',
        'const day = (now.getUTCDay() + 6) % 7;',
        'const day = now.getUTCDay();',
      ),
    ],
    tests: ['rsi/auto/report.test.ts'],
    expectRed: ['--week = 当前 UTC 周的周一起'],
    mustKill: ['--week = 当前 UTC 周的周一起'],
  },
  {
    id: 'rb_boundary_inclusive',
    clause: 'W0-22 第 4 条 严格大于',
    edits: [swap('src/rsi/auto/select-rollback.ts', 'if (day > date)', 'if (day >= date)')],
    tests: ['rsi/auto/dry-run.test.ts'],
    expectRed: ['候选「进入 canary 的 UTC 日」> D', '带时区偏移的时间先换算成 UTC 日再比较'],
    mustKill: ['候选「进入 canary 的 UTC 日」> D'],
  },
  {
    id: 'rb_unknown_excluded',
    clause: 'W0-22 第 4 条 日期不可知纳入并单列',
    edits: [
      swap(
        'src/rsi/auto/select-rollback.ts',
        'if (r.transitions_dropped > 0) {',
        'if (r.transitions_dropped > 99999) {',
      ),
    ],
    tests: ['rsi/auto/dry-run.test.ts'],
    expectRed: [
      '日期不可知(transitions_dropped>0',
      'rolling_back 可由从未进入 canary 的候选进入:完整历史(dropped=0)里没有进入记录 = 不在范围,不是 invalid;历史被截断则仍按日期不可知纳入',
      '文本:主列表与「日期不可知,按保守方向纳入」单列一节,计数分开;json 的 date_unknown[] 同样单列',
    ],
    mustKill: ['日期不可知(transitions_dropped>0'],
  },
  {
    id: 'rb_unknown_unlisted',
    clause: 'W0-22 第 4 条 日期不可知单列',
    edits: [
      swap(
        'src/rsi/auto/select-rollback.ts',
        'out.dateUnknown.push({ ...base, entered_on: null, entered_at: null });',
        'void base;',
      ),
    ],
    tests: ['rsi/auto/dry-run.test.ts'],
    expectRed: [
      '日期不可知(transitions_dropped>0',
      'rolling_back 可由从未进入 canary 的候选进入:完整历史(dropped=0)里没有进入记录 = 不在范围,不是 invalid;历史被截断则仍按日期不可知纳入',
      '文本:主列表与「日期不可知,按保守方向纳入」单列一节,计数分开;json 的 date_unknown[] 同样单列',
    ],
    mustKill: ['日期不可知(transitions_dropped>0'],
  },
  {
    id: 'rb_utc_offset_ignored',
    clause: 'W0-22 第 4 条 UTC 日',
    edits: [
      swap(
        'src/rsi/auto/select-rollback.ts',
        'const atUtc = new Date(Date.parse(entry.at)).toISOString();',
        'const atUtc = entry.at;',
      ),
    ],
    tests: ['rsi/auto/dry-run.test.ts'],
    expectRed: ['带时区偏移的时间先换算成 UTC 日再比较'],
    mustKill: ['带时区偏移的时间先换算成 UTC 日再比较'],
  },
  {
    id: 'rb_order_flipped',
    clause: 'W0-22 第 4 条 生效逆序',
    edits: [
      swap(
        'src/rsi/auto/select-rollback.ts',
        '(b.entered_at as string) < (a.entered_at as string)',
        '(a.entered_at as string) < (b.entered_at as string)',
      ),
    ],
    tests: ['rsi/auto/dry-run.test.ts'],
    expectRed: [
      '按生效逆序:进入 canary 晚者在前',
      '候选「进入 canary 的 UTC 日」> D(不含当日):D = 进入日 → 不含;D = 前一天 → 含;差一天的两侧都钉住',
    ],
    mustKill: ['按生效逆序:进入 canary 晚者在前'],
  },
  {
    id: 'rb_bad_date_rollover',
    clause: 'R21-12.7 bad_date',
    edits: [
      swap(
        'src/rsi/auto/select-rollback.ts',
        'Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s',
        'Number.isNaN(d.getTime()) ? null : s',
      ),
    ],
    tests: ['rsi/auto/dry-run.test.ts'],
    expectRed: [
      'parseUtcDate:只接受真实日历日',
      '参数先于任何读取:缺 --to / 坏日期 → 2 bad_date;未知参数 → 2 unknown_arg',
    ],
    mustKill: ['parseUtcDate:只接受真实日历日'],
  },
  {
    id: 'rb_off_exit_zero',
    clause: 'W0-22 第 4 条 [rsi] 关闭退 4',
    edits: [
      swap(
        'src/rsi/auto/read/rollback-dry.ts',
        'if (!(await p.config()).rsiOn) {',
        'if (false as boolean) {',
      ),
    ],
    tests: ['rsi/auto/dry-run.test.ts'],
    expectRed: ['[rsi] 关闭 → 退 4 RSI_NOT_RUN reason=off'],
    mustKill: ['[rsi] 关闭 → 退 4 RSI_NOT_RUN reason=off'],
  },
  {
    id: 'cleardry_lists_terminal',
    clause: 'R21-12.4 干跑只列非终态',
    edits: [
      swap(
        'src/rsi/auto/read/clear-dry.ts',
        '.filter((r) => !TERMINAL.has(r.lifecycle))',
        '.filter(() => true)',
      ),
    ],
    tests: ['rsi/auto/dry-run.test.ts'],
    expectRed: ['只列非终态候选'],
    mustKill: ['只列非终态候选'],
  },
  {
    id: 'exit_priority_reversed',
    clause: 'W0-22 第 3 条 取最小优先级',
    edits: [
      swap(
        'src/rsi/auto/exit-map.ts',
        'const row = Math.min(...rows);',
        'const row = Math.max(...rows);',
      ),
    ],
    tests: ['rsi/auto/exit-map.test.ts'],
    expectRed: ['取最小号'],
    mustKill: ['取最小号'],
  },
  {
    id: 'exit_manual_as_3',
    clause: 'W0-22 第 3 条 第 9 行退 1',
    edits: [
      swap(
        'src/rsi/auto/exit-map.ts',
        'return { exit: 1, row, info, errors: [] };',
        'return { exit: 3, row, info, errors: [] };',
      ),
    ],
    tests: ['rsi/auto/exit-map.test.ts'],
    // 其余是同一行(第 9 行)在别的用例里的出现:逐格 it 的标题带 `→ 退 1`、穷举的 it.each 取 `incomplete × ` 固定前缀
    expectRed: [
      '9a manual_event_required',
      '11 行逐格',
      '第 9 行退 1(不是 3)',
      '失败时已完成的撤销仍先逐行输出',
      'incomplete × ',
      '按 variant × cause 穷举',
      '同一身份的多次失败',
    ],
    mustKill: ['9a manual_event_required'],
  },
  {
    id: 'exit_missing_cause_ok',
    clause: 'W0-22 第 3 条 缺 cause = internal',
    edits: [
      swap(
        'src/rsi/auto/exit-map.ts',
        "let row = cause === '' ? 6 : (CAUSE_ROW[cause] as number);",
        "let row = cause === '' ? 11 : (CAUSE_ROW[cause] as number);",
      ),
    ],
    tests: ['rsi/auto/exit-map.test.ts'],
    expectRed: ['6 失败 variant 上缺失 / 未识别的 cause'],
    mustKill: ['6 失败 variant 上缺失 / 未识别的 cause'],
  },
  {
    id: 'exit_complete_clears_all',
    clause: 'W0-22 第 3 条 身份归并',
    edits: [
      swap('src/rsi/auto/exit-map.ts', 'pending.delete(`txn:${o.txn}`);', 'pending.clear();'),
    ],
    tests: ['rsi/auto/exit-map.test.ts'],
    expectRed: [
      '同一身份的后续 complete 消除此前的失败',
      'journal 完整性错误(refused、txn=null、带 journal 句柄)不被任何 complete 消除;每份独立(同候选两份不一致 journal 各报一份)',
    ],
    mustKill: ['同一身份的后续 complete 消除此前的失败'],
  },
  {
    id: 'exit_enum_failure_ok',
    clause: 'W0-22 第 3 条 枚举失败',
    edits: [
      swap('src/rsi/auto/exit-map.ts', 'if (i.enumerationFailed === true) rows.push(5);', ''),
    ],
    tests: ['rsi/auto/exit-map.test.ts'],
    expectRed: ['候选枚举失败(含部分成功后)'],
    mustKill: ['候选枚举失败(含部分成功后)'],
  },
  {
    id: 'exit_busy_as_locked',
    clause: 'W0-22 第 3 条 第 8 行',
    edits: [
      swap(
        'src/rsi/auto/exit-map.ts',
        "if (i.precondition === 'snapshot_busy') rows.push(8);",
        "if (i.precondition === 'snapshot_busy') rows.push(7);",
      ),
    ],
    tests: ['rsi/auto/exit-map.test.ts'],
    expectRed: ['7 / 8 命令级前置'],
    mustKill: ['7 / 8 命令级前置'],
  },
  {
    id: 'exit_cause_row_swapped',
    clause: 'W0-22 第 3 条 cause 对应的行',
    edits: [
      swap('src/rsi/auto/exit-map.ts', '  credentials_invalid: 2,', '  credentials_invalid: 5,'),
    ],
    tests: ['rsi/auto/exit-map.test.ts'],
    expectRed: [
      '2 credentials_invalid',
      '取最小号:not_wired(1)压过 locked(7);locked(7)压过 manual(9);busy(8)压过 manual(9);cause 优先级 1<2<3<4<5<6',
    ],
    mustKill: ['2 credentials_invalid'],
  },
  {
    id: 'git_no_preflight',
    clause: 'W0-22 第 6 条 每次读取前预检',
    edits: [
      swap(
        'src/rsi/personal/read/git-readonly.ts',
        "if (!pre.ok) return { kind: 'unreadable', why: pre.why };",
        '',
      ),
    ],
    tests: ['rsi/auto/git-readonly.test.ts'],
    expectRed: [
      '预检拒绝:',
      '仓库目录本身不安全 → unreadable 且 spawn = 0:相对路径、符号链接、非本人属主、权限宽于 0700(含 git init 默认的 0755)',
      '每次读取前都预检:装配时 / 第一次读取通过不能替代第二次读取前的检查(第二次读取前改 config 必须被拒)',
    ],
    mustKill: ['预检拒绝:'],
  },
  {
    id: 'git_no_recheck',
    clause: 'W0-22 第 6 条 返回后复核',
    edits: [
      swap(
        'src/rsi/personal/read/git-readonly.ts',
        'if (!post.ok || post.digest !== pre.digest) {',
        'if (false as boolean) {',
      ),
    ],
    tests: ['rsi/auto/git-readonly.test.ts'],
    expectRed: [
      '预检通过后、git 读取之前',
      '存在性集合在 spawn 期间变化(出现 .promisor 文件)同样拒收',
    ],
    mustKill: ['预检通过后、git 读取之前'],
  },
  // 原条目 git_include_allowed(只清空 REJECT_SECTIONS)是等价变异:include / includeif 仍被同一函数里的
  // 节名白名单拒绝(两层冗余),单独去掉一层没有可观察差别。真正放开 include 的变异见 git_include_whitelisted。
  {
    id: 'git_promisor_key_allowed',
    clause: 'W0-22 第 6 条 promisor 键拒绝',
    edits: [
      swap(
        'src/rsi/personal/read/git-readonly.ts',
        "const REJECT_KEYS = new Set(['promisor', 'partialclonefilter']);",
        'const REJECT_KEYS = new Set<string>([]);',
      ),
    ],
    tests: ['rsi/auto/git-readonly.test.ts'],
    expectRed: [
      '拒绝:',
      '每次读取前都预检:装配时 / 第一次读取通过不能替代第二次读取前的检查(第二次读取前改 config 必须被拒)',
    ],
    mustKill: ['拒绝:'],
  },
  {
    id: 'git_extensions_open',
    clause: 'W0-22 第 6 条 extensions 白名单',
    edits: [
      swap(
        'src/rsi/personal/read/git-readonly.ts',
        "if (section === 'extensions' && key !== 'objectformat') return false;",
        '',
      ),
    ],
    tests: ['rsi/auto/git-readonly.test.ts'],
    expectRed: ['拒绝:'],
    mustKill: ['拒绝:'],
  },
  {
    id: 'git_alternates_allowed',
    clause: 'W0-22 第 6 条 alternates 拒绝',
    edits: [
      swap(
        'src/rsi/personal/read/git-readonly.ts',
        "  'objects/info/alternates',",
        "  'objects/info/alternates-x',",
      ),
    ],
    tests: ['rsi/auto/git-readonly.test.ts'],
    expectRed: ['预检拒绝:'],
    mustKill: ['预检拒绝:'],
  },
  {
    id: 'git_promisor_file_ok',
    clause: 'W0-22 第 6 条 .promisor 文件',
    edits: [
      swap(
        'src/rsi/personal/read/git-readonly.ts',
        "if (packs.some((e) => e.name.endsWith('.promisor'))) return rejected;",
        '',
      ),
    ],
    tests: ['rsi/auto/git-readonly.test.ts'],
    expectRed: ['预检拒绝:', '存在性集合在 spawn 期间变化(出现 .promisor 文件)同样拒收'],
    mustKill: ['预检拒绝:'],
  },
  {
    id: 'git_config_cap_removed',
    clause: 'W0-22 第 6 条 config ≤ 64 KiB',
    edits: [
      swap(
        'src/rsi/personal/read/git-readonly.ts',
        'maxBytes: GIT_CONFIG_MAX_BYTES,',
        'maxBytes: GIT_CONFIG_MAX_BYTES * 1024,',
      ),
    ],
    tests: ['rsi/auto/git-readonly.test.ts'],
    expectRed: ['预检拒绝:'],
    mustKill: ['预检拒绝:'],
  },
  {
    id: 'git_argv_shape_open',
    clause: 'W0-22 第 6 条 三种形状',
    edits: [
      swap(
        'src/rsi/personal/read/git-readonly.ts',
        "if (!ok) throw new GitArgvError('shape_mismatch');",
        '',
      ),
    ],
    tests: ['rsi/auto/git-readonly.test.ts'],
    expectRed: ['非法形状', '<FIXED> 逐项等值:缺一项 / 换值 / 换序 / 另一个仓库目录都拒绝'],
    mustKill: ['非法形状'],
  },
  {
    id: 'git_fixed_prefix_loose',
    clause: 'W0-22 第 6 条 <FIXED> 逐项等值',
    edits: [
      swap(
        'src/rsi/personal/read/git-readonly.ts',
        'if (argv.length <= fixed.length || fixed.some((f, i) => argv[i] !== f)) {',
        'if (argv.length <= fixed.length) {',
      ),
    ],
    tests: ['rsi/auto/git-readonly.test.ts'],
    expectRed: ['<FIXED> 逐项等值'],
    mustKill: ['<FIXED> 逐项等值'],
  },
  {
    id: 'git_env_loose',
    clause: 'W0-22 第 6 条 封闭 env',
    edits: [
      swap(
        'src/rsi/personal/read/git-readonly.ts',
        'if (a.length !== b.length || a.some((k, i) => k !== b[i] || env[k] !== want[k])) {',
        'if (a.length < b.length) {',
      ),
    ],
    tests: ['rsi/auto/git-readonly.test.ts'],
    expectRed: ['恰好 12 个键'],
    mustKill: ['恰好 12 个键'],
  },
  {
    id: 'git_env_value_changed',
    clause: 'W0-22 第 6 条 封闭 env 的值',
    edits: [
      swap(
        'src/rsi/personal/read/git-readonly.ts',
        "GIT_NO_LAZY_FETCH: '1',",
        "GIT_NO_LAZY_FETCH: '0',",
      ),
    ],
    tests: ['rsi/auto/git-readonly.test.ts'],
    expectRed: ['恰好 12 个键'],
    mustKill: ['恰好 12 个键'],
  },
  {
    id: 'git_cwd_not_repo',
    clause: 'W0-22 第 6 条 cwd 固定',
    edits: [swap('src/rsi/personal/read/git-readonly.ts', 'cwd: o.gitDir,', "cwd: '/',")],
    tests: ['rsi/auto/git-readonly.test.ts'],
    expectRed: ['三种读取都成功'],
    mustKill: ['三种读取都成功'],
  },
  {
    id: 'git_blob_count_cap',
    clause: 'W0-22 第 6 条 blob 个数',
    edits: [
      swap(
        'src/rsi/personal/read/git-readonly.ts',
        'if (blobs + 1 > GIT_BLOB_MAX_COUNT)',
        'if (blobs + 1 > GIT_BLOB_MAX_COUNT * 100)',
      ),
    ],
    tests: ['rsi/auto/git-readonly.test.ts'],
    expectRed: ['blob 个数上限 512'],
    mustKill: ['blob 个数上限 512'],
  },
  {
    id: 'git_blob_bytes_cap',
    clause: 'W0-22 第 6 条 blob 总字节',
    edits: [
      swap(
        'src/rsi/personal/read/git-readonly.ts',
        'if (blobBytes > GIT_BLOB_MAX_TOTAL_BYTES)',
        'if (blobBytes > GIT_BLOB_MAX_TOTAL_BYTES * 100)',
      ),
    ],
    tests: ['rsi/auto/git-readonly.test.ts'],
    expectRed: ['blob 个数上限 512'],
    mustKill: ['blob 个数上限 512'],
  },
  {
    id: 'git_stdout_cap',
    clause: 'W0-22 第 6 条 stdout 4 MiB',
    edits: [
      swap(
        'src/rsi/personal/read/git-readonly.ts',
        "if (Buffer.byteLength(r.stdout, 'utf8') > GIT_OUTPUT_MAX_BYTES) {",
        "if (Buffer.byteLength(r.stdout, 'utf8') > GIT_OUTPUT_MAX_BYTES * 100) {",
      ),
    ],
    tests: ['rsi/auto/git-readonly.test.ts'],
    expectRed: ['git 异常退出码 → unreadable'],
    mustKill: ['git 异常退出码 → unreadable'],
  },
  {
    id: 'git_nonzero_ok',
    clause: 'W0-22 第 6 条 退出码非 0',
    edits: [
      swap(
        'src/rsi/personal/read/git-readonly.ts',
        "if (r.status === 0) return { kind: 'ok', stdout: r.stdout };",
        "if (r.status === 0 || r.status === 128) return { kind: 'ok', stdout: r.stdout };",
      ),
    ],
    tests: ['rsi/auto/git-readonly.test.ts'],
    expectRed: ['git 异常退出码 → unreadable'],
    mustKill: ['git 异常退出码 → unreadable'],
  },
  {
    id: 'git_missing_any_status1',
    clause: 'W0-22 第 6 条 仅形状 ① 的 1 是 missing',
    edits: [
      swap(
        'src/rsi/personal/read/git-readonly.ts',
        "if (r.status === 1 && missingOnStatus1) return { kind: 'missing' };",
        "if (r.status === 1) return { kind: 'missing' };",
      ),
    ],
    tests: ['rsi/auto/git-readonly.test.ts'],
    expectRed: ['git 异常退出码 → unreadable'],
    mustKill: ['git 异常退出码 → unreadable'],
  },
  {
    id: 'git_uid_unchecked',
    clause: 'W0-22 第 6 条 属主',
    edits: [
      swap(
        'src/rsi/personal/read/git-readonly.ts',
        'if (want !== undefined && st.uid !== want) return unsafe;',
        '',
      ),
    ],
    tests: ['rsi/auto/git-readonly.test.ts'],
    expectRed: ['仓库目录本身不安全'],
    mustKill: ['仓库目录本身不安全'],
  },
  {
    id: 'git_wide_mode_ok',
    clause: 'W0-22 第 6 条 仓库目录权限不宽于 0700',
    edits: [
      swap(
        'src/rsi/personal/read/git-readonly.ts',
        'if ((st.mode & 0o077) !== 0) return unsafe;',
        '',
      ),
    ],
    tests: ['rsi/auto/git-readonly.test.ts'],
    expectRed: ['仓库目录本身不安全'],
    mustKill: ['仓库目录本身不安全'],
  },
  {
    id: 'runner_guard_removed',
    clause: 'W0-24 runGitClosed 守卫',
    edits: [
      swap(
        'src/io/exec.ts',
        "if (!path.isAbsolute(file) || path.basename(file) !== 'git') {",
        'if (false as boolean) {',
      ),
    ],
    tests: ['rsi/auto/git-readonly.test.ts'],
    expectRed: ['runGitClosed 自身的守卫'],
    mustKill: ['runGitClosed 自身的守卫'],
  },
  {
    id: 'home_unreadable_as_absent',
    clause: 'W0-22 第 7 条 读失败不是缺失',
    edits: [
      swap(
        'src/rsi/personal/read/home-reads.ts',
        "return r.kind === 'missing' ? { kind: 'absent' } : { kind: 'unreadable' };",
        "return { kind: 'absent' };",
      ),
    ],
    tests: ['rsi/auto/port-contract.test.ts'],
    expectRed: ['读失败 → unreadable,绝不是 absent / 空'],
    mustKill: ['读失败 → unreadable,绝不是 absent / 空'],
  },
  {
    id: 'git_include_whitelisted',
    clause:
      'W0-22 第 6 条 include 拒绝(两层:显式拒绝集合 + 段名白名单;`git_include_allowed` 只去掉前者,被白名单兜住,等价)',
    edits: [
      swap(
        'src/rsi/personal/read/git-readonly.ts',
        "  'extensions',\n]);\nconst REJECT_SECTIONS = new Set(['include', 'includeif']);",
        "  'extensions',\n  'include',\n  'includeif',\n]);\nconst REJECT_SECTIONS = new Set<string>([]);",
      ),
    ],
    tests: ['rsi/auto/git-readonly.test.ts'],
    expectRed: [
      '拒绝:include 段与 includeIf 段',
      '拒绝:include',
      'includeIf',
      'INCLUDE(大小写不敏感)',
      ' → unreadable 且 spawn 次数 = 0(含「假旧版 git:忽略 GIT_NO_LAZY_FETCH 并对缺失对象尝试抓取」的场景)',
    ],
    mustKill: ['拒绝:include 段与 includeIf 段'],
  },
  {
    id: 'leak_extra_empty',
    clause: 'R21-12.8 泄漏闸:禁止值含仓库根 / 状态目录(端口注入)',
    edits: [
      swap(
        'src/rsi/auto/entry.ts',
        'forbiddenPaths(ctx.env, ports.outputForbidden)',
        'forbiddenPaths(ctx.env, [])',
      ),
    ],
    tests: ['rsi/auto/entry.test.ts'],
    expectRed: ['泄漏闸的禁止值来自端口'],
    mustKill: ['泄漏闸的禁止值来自端口'],
  },
  {
    id: 'status_trunc_keys_dropped',
    clause: 'W0-24 auto status --json 的截断键',
    edits: [
      swap(
        'src/rsi/auto/read/status.ts',
        '        rollback_stalled_truncated: v === null ? null : v.rolling_back_truncated,\n        protection_marks_truncated: v === null ? null : v.protection_marks_truncated,\n',
        '',
      ),
    ],
    tests: ['rsi/auto/status.test.ts'],
    expectRed: ['视图截断(JSON)', '键集合与文本 / JSON 形状'],
    mustKill: ['视图截断(JSON)'],
  },
  {
    id: 'status_trunc_null_as_false',
    clause: 'W0-24 截断键 null 不得写成 false',
    edits: [
      swap(
        'src/rsi/auto/read/status.ts',
        'rollback_stalled_truncated: v === null ? null : v.rolling_back_truncated,',
        'rollback_stalled_truncated: v === null ? false : v.rolling_back_truncated,',
      ),
      swap(
        'src/rsi/auto/read/status.ts',
        'protection_marks_truncated: v === null ? null : v.protection_marks_truncated,',
        'protection_marks_truncated: v === null ? false : v.protection_marks_truncated,',
      ),
    ],
    tests: ['rsi/auto/status.test.ts'],
    expectRed: ['视图截断(JSON)', '键集合与文本 / JSON 形状', '损坏的视图'],
    mustKill: ['视图截断(JSON)'],
  },
  {
    id: 'untrusted_cfg_as_off',
    clause: '复审:配置不可信 → fail-closed(不得当作合法关闭继续)',
    edits: [
      swap(
        'src/rsi/auto/deps.ts',
        "if (cfg.status === 'off' && !LEGIT_OFF.has(cfg.reason)) {",
        'if (false as boolean) {',
      ),
    ],
    tests: ['rsi/auto/deps.test.ts'],
    expectRed: ['配置不可信 → 所有读命令在输出之前 fail-closed'],
    mustKill: ['配置不可信 → 所有读命令在输出之前 fail-closed'],
  },
  {
    id: 'explicit_root_dropped',
    clause: '复审:显式 --root 进入输出禁止集合',
    edits: [
      swap(
        'src/rsi/auto/deps.ts',
        'if (ctx.explicitRoot !== undefined) {',
        'if (false as boolean) {',
      ),
    ],
    tests: ['rsi/auto/deps.test.ts'],
    expectRed: ['合法关闭(absent / no_section / disabled)', 'forbiddenExtra 不静默丢项'],
    mustKill: ['合法关闭(absent / no_section / disabled)'],
  },
  {
    id: 'forbidden_extra_silent',
    clause: '复审:禁止集合不静默丢项',
    edits: [
      swap(
        'src/rsi/auto/deps.ts',
        "      throw new RsiFailClosedError('internal');",
        '      void 0;',
      ),
    ],
    tests: ['rsi/auto/deps.test.ts'],
    expectRed: ['forbiddenExtra 不静默丢项'],
    mustKill: ['forbiddenExtra 不静默丢项'],
  },
  {
    id: 'pause_takes_lock',
    clause: 'R21-12.2 pause 不拿锁',
    edits: [
      swap(
        'src/rsi/auto/write/pause.ts',
        "const marker = await (p.userMarker as NonNullable<WritePorts['userMarker']>)();",
        "const marker = await (p.locks as NonNullable<WritePorts['locks']>).withLocks('rsi_personal_sync', async () => (p.userMarker as NonNullable<WritePorts['userMarker']>)());",
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['pause 创建 U:不拿锁、不要 TTY、只碰 U'],
    mustKill: ['pause 创建 U:不拿锁、不要 TTY、只碰 U'],
  },
  {
    id: 'pause_overwrites',
    clause: 'R21-12.2 pause 已存在不覆盖',
    edits: [
      swap(
        'src/rsi/auto/write/pause.ts',
        'const r = await marker.ensureUser();',
        "let r = await marker.ensureUser();\n  if (r === 'exists') {\n    await marker.remove(await marker.snapshot());\n    r = await marker.ensureUser();\n  }",
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['pause 已存在时不覆盖'],
    mustKill: ['pause 已存在时不覆盖'],
  },
  {
    id: 'pause_touches_state',
    clause: 'R21-12.2 pause 只碰 U',
    edits: [
      swap(
        'src/rsi/auto/write/pause.ts',
        'const r = await marker.ensureUser();',
        'const r = await marker.ensureUser();\n  await p.pauseState?.write({ reasons: [], diverged: false, owner_changed: false });',
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['pause 创建 U:不拿锁、不要 TTY、只碰 U'],
    mustKill: ['pause 创建 U:不拿锁、不要 TTY、只碰 U'],
  },
  {
    id: 'pause_off_runs',
    clause: 'R21-12.2 / W0-22 第 4 条 off 退 4',
    edits: [
      swap(
        'src/rsi/auto/write/pause.ts',
        "if (!(await (p.config as NonNullable<WritePorts['config']>)()).rsiOn) return notRun(ctx, 'off');",
        'void p.config;',
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['pause 在 [rsi] 关闭时退 4 off'],
    mustKill: ['pause 在 [rsi] 关闭时退 4 off'],
  },
  {
    id: 'resume_no_evidence',
    clause: 'W0-23 第 1 条 清到无剩余码的写入带解除证据',
    edits: [
      swap(
        'src/rsi/auto/write/resume.ts',
        'next = await stampReleaseEvidence(ports.breaker, next);',
        'next = { ...next };',
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['resume 清掉条件已不成立的人工码,写解除证据'],
    mustKill: ['resume 清掉条件已不成立的人工码,写解除证据'],
  },
  {
    id: 'resume_clears_holding',
    clause: 'R21-10.4 只清条件已不成立的码',
    edits: [
      swap(
        'src/rsi/auto/write/resume.ts',
        'const r = computeResume(s0, (c) => holds.has(c));',
        'const r = computeResume(s0, () => false);',
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['resume 不清仍成立的码'],
    mustKill: ['resume 不清仍成立的码'],
  },
  {
    id: 'resume_no_bump',
    clause: 'W0-22 第 1 条 bump 入口代',
    edits: [swap('src/rsi/auto/write/resume.ts', 'await ports.marks.bump();', 'void ports.marks;')],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['resume 清掉条件已不成立的人工码,写解除证据', 'resume 的顺序:先写 state'],
    mustKill: ['resume 清掉条件已不成立的人工码,写解除证据'],
  },
  {
    id: 'resume_empty_stamp_deletes',
    clause: 'W0-22 第 1 条 指纹为空永不删 U',
    edits: [
      swap('src/rsi/auto/write/resume.ts', "if (uTok !== 'none') {", 'if (true) {'),
      swap(
        'src/rsi/auto/write/resume.ts',
        'uOut = await um.remove(uTok);',
        "uOut = await um.remove(uTok === 'none' ? await um.snapshot() : uTok);",
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['resume 指纹为空(快照时没有 U)永不删'],
    mustKill: ['resume 指纹为空(快照时没有 U)永不删'],
  },
  {
    id: 'resume_mismatch_deletes',
    clause: 'W0-22 第 1 条 指纹不符保留',
    edits: [
      swap(
        'src/rsi/auto/write/resume.ts',
        'uOut = await um.remove(uTok);',
        'uOut = await um.remove(await um.snapshot());',
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['resume 指纹不符(步骤 ② 之后 U 被换实例)保留并报 changed'],
    mustKill: ['resume 指纹不符(步骤 ② 之后 U 被换实例)保留并报 changed'],
  },
  {
    id: 'resume_touches_breaker',
    clause: 'W0-22 第 1 条 resume 不碰 B',
    edits: [
      swap(
        'src/rsi/auto/write/resume.ts',
        'const b1 = await ports.breaker.read();',
        'await (ports.breaker as unknown as { remove(): Promise<boolean> }).remove();\n      const b1 = await ports.breaker.read();',
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['resume 清掉条件已不成立的人工码,写解除证据'],
    mustKill: ['resume 清掉条件已不成立的人工码,写解除证据'],
  },
  {
    id: 'resume_result_mismatch',
    clause: 'W0-22 第 2 条 R 空 + B 在不得输出 RESUMED',
    edits: [
      swap(
        'src/rsi/auto/write/resume.ts',
        'const bPending = b1 !== null;',
        'const bPending = false;',
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: [
      'resume 清掉条件已不成立的人工码,写解除证据',
      'resume --json:追加 paused 与 request_done',
    ],
    mustKill: ['resume 清掉条件已不成立的人工码,写解除证据'],
  },
  {
    id: 'resume_diverged_dropped',
    clause: 'W0-22 第 1 条 remaining 判据含 diverged',
    edits: [
      swap(
        'src/rsi/auto/write/resume.ts',
        "if (s1.diverged) remaining.add('personal_repo_diverged');",
        'void s1.diverged;',
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['resume 不碰 diverged / owner_changed'],
    mustKill: ['resume 不碰 diverged / owner_changed'],
  },
  {
    id: 'resume_order_swapped',
    clause: 'W0-22 第 1 条 顺序 state → bump → U',
    edits: [
      swap('src/rsi/auto/write/resume.ts', 'await ports.marks.bump();', "done.push('noop');"),
      swap('src/rsi/auto/write/resume.ts', '// ⑦ 读回(不碰 B)', 'await ports.marks.bump();'),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['resume 的顺序:先写 state(带证据),再 bump,最后删 U'],
    mustKill: ['resume 的顺序:先写 state(带证据),再 bump,最后删 U'],
  },
  {
    id: 'resume_user_not_in_r',
    clause: 'W0-22 第 2 条 U 在则不得 RESUMED',
    edits: [
      swap(
        'src/rsi/auto/write/resume.ts',
        "if (u1 !== 'none') remaining.add('user_paused');",
        'void u1;',
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: [
      'resume 指纹为空(快照时没有 U)永不删',
      'resume 指纹不符(步骤 ② 之后 U 被换实例)保留并报 changed',
    ],
    mustKill: ['resume 指纹为空(快照时没有 U)永不删'],
  },
  {
    id: 'resume_two_locks',
    clause: 'R21-10.4 resume 取三把锁',
    edits: [
      swap(
        'src/rsi/auto/write/resume.ts',
        "ports.locks.withLocks('rsi_personal_sync'",
        "ports.locks.withLocks('personal_sync'",
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['resume 清掉条件已不成立的人工码,写解除证据'],
    mustKill: ['resume 清掉条件已不成立的人工码,写解除证据'],
  },
  {
    id: 'clear_takes_rsi_lock',
    clause: 'R21-9.5 缩减入口只拿 personal → sync',
    edits: [
      swap(
        'src/rsi/auto/write/clear-write.ts',
        "locks.withLocks('personal_sync'",
        "locks.withLocks('rsi_personal_sync'",
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['clear 撤销成功:退 0,RSI_CLEAR_DONE 先逐行输出'],
    mustKill: ['clear 撤销成功:退 0,RSI_CLEAR_DONE 先逐行输出'],
  },
  {
    id: 'clear_off_short_circuit',
    clause: 'R21-9.5 clear 不走 off 短路',
    edits: [
      swap(
        'src/rsi/auto/write/clear-write.ts',
        "const bad = precheck(ctx, p, REQUIRED_PORTS['auto clear']);",
        "const bad = precheck(ctx, p, REQUIRED_PORTS['auto clear']) ?? ((await p.config?.())?.rsiOn === false ? 4 : null);",
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['clear 撤销成功:退 0,RSI_CLEAR_DONE 先逐行输出'],
    mustKill: ['clear 撤销成功:退 0,RSI_CLEAR_DONE 先逐行输出'],
  },
  {
    id: 'clear_enum_ignored',
    clause: 'W0-22 第 3 条 枚举失败(含部分成功后)不得退 0',
    edits: [
      swap(
        'src/rsi/auto/write/clear-write.ts',
        'enumerationFailed: report.unavailable !== null,',
        'enumerationFailed: false,',
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['clear 仓库读不出(deferred 且无只读记录)'],
    mustKill: ['clear 仓库读不出(deferred 且无只读记录)'],
  },
  {
    id: 'out_failure_first',
    clause: 'W0-22 第 3 条 已完成的撤销先输出',
    edits: [
      swap(
        'src/rsi/auto/write/outcome-output.ts',
        'for (const l of r.info) ctx.stderr(`${l}\\n`);',
        'for (const l of r.errors) ctx.stderr(`${l}\\n`);',
      ),
      swap(
        'src/rsi/auto/write/outcome-output.ts',
        'for (const l of r.errors) ctx.stderr(`${l}\\n`);\n  // 处置文案',
        'for (const l of r.info) ctx.stderr(`${l}\\n`);\n  // 处置文案',
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['journal 完整性错误(不带身份)不被另一份 journal 的 complete 消除'],
    mustKill: ['journal 完整性错误(不带身份)不被另一份 journal 的 complete 消除'],
  },
  {
    id: 'veto_deferred_unknown_id',
    clause: 'W0-22 第 3 条 / R21-12.6 deferred 不得判 unknown_id',
    edits: [
      swap(
        'src/rsi/auto/write/veto.ts',
        "if (peek.kind !== 'ok') return failClosed(ctx, 'personal_repo_invalid');",
        "if (peek.kind !== 'ok') return usage(ctx, 'unknown_id');",
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['veto 仓库 deferred / invalid 时不得判 unknown_id'],
    mustKill: ['veto 仓库 deferred / invalid 时不得判 unknown_id'],
  },
  {
    id: 'veto_no_reread',
    clause: '写命令持锁后重读记录再判',
    edits: [
      swap(
        'src/rsi/auto/write/veto.ts',
        'const cur = await d.store.read(a.id);',
        'const cur = peek;',
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['veto 持锁后重读记录再判'],
    mustKill: ['veto 持锁后重读记录再判'],
  },
  {
    id: 'veto_terminal_rolls_back',
    clause: 'R21-12.6 已终态只写黑名单',
    edits: [
      swap(
        'src/rsi/auto/write/veto.ts',
        'if (isTerminalLifecycle(rec.lifecycle) || DIRECT.has(rec.lifecycle)) {',
        'if (DIRECT.has(rec.lifecycle)) {',
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['veto 已终态候选只写黑名单'],
    mustKill: ['veto 已终态候选只写黑名单'],
  },
  {
    id: 'veto_wrong_source',
    clause: 'W0-17 veto 的来源 by=veto',
    edits: [swap('src/rsi/auto/write/veto.ts', "by: 'veto',", "by: 'clear',")],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['veto 已部署候选:startRollback(kind=rollback, reason=vetoed, by=veto)'],
    mustKill: ['veto 已部署候选:startRollback(kind=rollback, reason=vetoed, by=veto)'],
  },
  {
    id: 'veto_off_ignored',
    clause: 'W0-22 第 4 条 veto 在 [rsi] 关闭时退 4',
    edits: [
      swap(
        'src/rsi/auto/write/veto.ts',
        "if (!(await (p.config as NonNullable<WritePorts['config']>)()).rsiOn) return notRun(ctx, 'off');",
        'void p.config;',
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['veto 参数 / 环境:非 TTY 退 2;[rsi] 关闭退 4 off'],
    mustKill: ['veto 参数 / 环境:非 TTY 退 2;[rsi] 关闭退 4 off'],
  },
  {
    id: 'veto_lift_ignored',
    clause: 'R21-12.6 --lift 只解除黑名单',
    edits: [swap('src/rsi/auto/write/veto.ts', 'if (a.lift) {', 'if (false) {')],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['veto --lift 只调黑名单解除端口'],
    mustKill: ['veto --lift 只调黑名单解除端口'],
  },
  {
    id: 'veto_e2_not_landed',
    clause: 'W0-22 第 9 条 终态批次 E2 整批落地',
    edits: [
      swap(
        'src/rsi/auto/write/veto.ts',
        'const batch = await landTerminalEffects(d.keyedEffects, r.next);',
        "const batch = 'none' as const;",
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['veto 未部署(shadow)候选'],
    mustKill: ['veto 未部署(shadow)候选'],
  },
  {
    id: 'veto_e1_not_landed',
    clause: 'W0-22 第 9 条 终态上只写黑名单(E1)',
    edits: [
      swap(
        'src/rsi/auto/write/veto.ts',
        'landed.push(await d.keyedEffects.applyOnce(vetoEffectKey(e), [e]));',
        'void e;',
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['veto 已终态候选只写黑名单'],
    mustKill: ['veto 已终态候选只写黑名单'],
  },
  {
    id: 'rbk_wrong_source',
    clause: 'W0-20 rollback --to 的来源',
    edits: [swap('src/rsi/auto/write/rollback-write.ts', "by: 'rollback_to',", "by: 'clear',")],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['rollback --to:by=rollback_to、reason=cleared,按生效逆序'],
    mustKill: ['rollback --to:by=rollback_to、reason=cleared,按生效逆序'],
  },
  {
    id: 'rbk_wrong_reason',
    clause: 'W0-20 rollback_to 只用 cleared',
    edits: [
      swap('src/rsi/auto/write/rollback-write.ts', "reason: 'cleared',", "reason: 'vetoed',"),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['rollback --to:by=rollback_to、reason=cleared,按生效逆序'],
    mustKill: ['rollback --to:by=rollback_to、reason=cleared,按生效逆序'],
  },
  {
    id: 'rbk_order_flipped',
    clause: 'R21-12.7 按生效逆序',
    edits: [
      swap(
        'src/rsi/auto/write/rollback-write.ts',
        'for (const c of [...sel.candidates, ...sel.dateUnknown]) {',
        'for (const c of [...sel.candidates].reverse().concat(sel.dateUnknown)) {',
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['rollback --to:by=rollback_to、reason=cleared,按生效逆序'],
    mustKill: ['rollback --to:by=rollback_to、reason=cleared,按生效逆序'],
  },
  {
    id: 'rbk_unknown_excluded',
    clause: 'W0-22 第 4 条 日期不可知候选不得静默排除',
    edits: [
      swap(
        'src/rsi/auto/write/rollback-write.ts',
        'for (const c of [...sel.candidates, ...sel.dateUnknown]) {',
        'for (const c of sel.candidates) {',
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['rollback --to 日期不可知的候选单列纳入并展示'],
    mustKill: ['rollback --to 日期不可知的候选单列纳入并展示'],
  },
  {
    id: 'rbk_off_exit_zero',
    clause: 'W0-22 第 4 条 off 退 4',
    edits: [
      swap(
        'src/rsi/auto/write/rollback-write.ts',
        'return ExitCode.NOT_RUN;',
        'return ExitCode.OK;',
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['rollback --to:[rsi] 关闭退 4 off 并提示改用 auto clear'],
    mustKill: ['rollback --to:[rsi] 关闭退 4 off 并提示改用 auto clear'],
  },
  {
    id: 'rbk_two_locks',
    clause: 'R21-12.7 三把锁',
    edits: [
      swap(
        'src/rsi/auto/write/rollback-write.ts',
        "locks.withLocks('rsi_personal_sync'",
        "locks.withLocks('personal_sync'",
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['rollback --to:by=rollback_to、reason=cleared,按生效逆序'],
    mustKill: ['rollback --to:by=rollback_to、reason=cleared,按生效逆序'],
  },
  {
    id: 'rbk_invalid_after_write',
    clause: 'W0-22 第 4 条 矛盾记录在任何写入之前退 3',
    edits: [
      swap(
        'src/rsi/auto/write/rollback-write.ts',
        "if (sel0.invalid.length > 0) return failClosed(ctx, 'candidate_invalid');",
        'void sel0.invalid;',
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['rollback --to 记录自相矛盾'],
    mustKill: ['rollback --to 记录自相矛盾'],
  },
  {
    id: 'rebase_no_confirm',
    clause: 'R21-12.5 输入 yes 才改写',
    edits: [
      swap(
        'src/rsi/auto/write/rebase.ts',
        "if (raw === undefined || raw.replace(/\\r$/, '') !== 'yes') {",
        'if (false) {',
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['拒绝(非 yes / EOF)退 1 RSI_CONFIRM_DECLINED'],
    mustKill: ['拒绝(非 yes / EOF)退 1 RSI_CONFIRM_DECLINED'],
  },
  {
    id: 'rebase_non_diverged_runs',
    clause: 'R21-12.5 其它情形退 4 not_diverged',
    edits: [
      swap(
        'src/rsi/auto/write/rebase.ts',
        "if (v0.kind === 'not_diverged') return notRun(ctx, 'not_diverged');",
        'void v0;',
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['非分叉 / 非换主情形退 4 not_diverged'],
    mustKill: ['非分叉 / 非换主情形退 4 not_diverged'],
  },
  {
    id: 'rebase_no_recheck',
    clause: '写命令持锁后重读记录再判(rebase)',
    edits: [
      swap(
        'src/rsi/auto/write/rebase.ts',
        'if (v1.kind !== v0.kind || v1.head !== v0.head) {',
        'if (false) {',
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['持锁后重判:确认之后 HEAD 变了'],
    mustKill: ['持锁后重判:确认之后 HEAD 变了'],
  },
  {
    id: 'rebase_label_dropped',
    clause: 'R21-12.5 / R21-1.9 展示带标签',
    edits: [swap('src/rsi/auto/write/rebase.ts', '      RSI_AUTO_LABEL,', "      'rebase',")],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['分叉:展示带标签的相对路径清单'],
    mustKill: ['分叉:展示带标签的相对路径清单'],
  },
  {
    id: 'rebase_paths_unsanitized',
    clause: 'R21-12 输出边界 路径过清洗',
    edits: [swap('src/rsi/auto/write/rebase.ts', 'cleanPath(x)', 'x')],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['路径清单过清洗:控制字符被替换'],
    mustKill: ['路径清单过清洗:控制字符被替换'],
  },
  {
    id: 'rebase_flag_kept',
    clause: 'R21-10.3 rebase 后清 diverged',
    edits: [
      swap(
        'src/rsi/auto/write/rebase.ts',
        "if (v1.kind === 'baseline' && st.diverged) await pauseState.write({ ...st, diverged: false });",
        'void st;',
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['分叉:展示带标签的相对路径清单'],
    mustKill: ['分叉:展示带标签的相对路径清单'],
  },
  {
    id: 'precheck_skipped',
    clause: 'W0-22 第 8 节 未接线预检零写入',
    edits: [
      swap(
        'src/rsi/auto/write/common.ts',
        "return missingPorts(p, need).length === 0 ? null : failClosed(ctx, 'internal');",
        'return null;',
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['退 3 internal;没有取锁、没有任何写入', '全部未接线(只有 userMarker 与 config)'],
    mustKill: ['退 3 internal;没有取锁、没有任何写入'],
  },
  {
    id: 'ports_before_args',
    clause: '参数 / TTY 校验先于端口装配',
    edits: [
      swap(
        'src/rsi/auto/write/index.ts',
        'run(ctx, rest, () => factory(ctx));',
        'run(ctx, rest, ((g) => () => g)(await factory(ctx)));',
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['参数 / TTY 校验先于端口装配'],
    mustKill: ['参数 / TTY 校验先于端口装配'],
  },
  {
    id: 'prod_wires_locks',
    clause: 'W8b 生产组装只接用户标记端口',
    edits: [
      swap(
        'src/rsi/auto/deps-write.ts',
        "config: async () => ({ rsiOn: cfg.status === 'on' }),",
        "config: async () => ({ rsiOn: cfg.status === 'on' }),\n    locks: {} as never,",
      ),
    ],
    tests: ['rsi/auto/port-contract.test.ts'],
    expectRed: ['字段 = config / userMarker / outputForbidden'],
    mustKill: ['字段 = config / userMarker / outputForbidden'],
  },
  {
    id: 'entry_imports_write',
    clause: 'W8b 读写分文件:读侧入口 entry.ts 的静态闭包不含写处理函数 / 写出口',
    edits: [
      swap(
        'src/rsi/auto/entry.ts',
        "import type { RsiEarlyContext } from '../types.js';",
        "import type { RsiEarlyContext } from '../types.js';\nimport { makeWriteHandlers } from './write/index.js';\nexport const leakedWrite = makeWriteHandlers;",
      ),
    ],
    tests: ['rsi/auto/zero-write.test.ts'],
    expectRed: ['生产入口 entry.ts 的传递闭包'],
    mustKill: ['生产入口 entry.ts 的传递闭包'],
  },
  {
    id: 'clear_untrusted_blocked',
    clause: 'R21-9.5 缩减入口在配置不可信时仍要完成 HOME 侧撤销(不得改回 fail-closed)',
    edits: [
      swap(
        'src/rsi/auto/deps-write.ts',
        "  const gitDir = path.join(getRealHome(env), ...PERSONAL_GIT_DIR_REL.split('/'));\n  if (cfg.status !== 'on') {",
        "  const gitDir = path.join(getRealHome(env), ...PERSONAL_GIT_DIR_REL.split('/'));\n  if (cfg.status === 'off' && !LEGIT_OFF.has(cfg.reason)) {\n    throw new RsiFailClosedError(untrustedReason(cfg.reason));\n  }\n  if (cfg.status !== 'on') {",
      ),
    ],
    tests: ['rsi/auto/write-untrusted-config.test.ts'],
    expectRed: ['配置不可信时 auto clear --write(缩减入口)照常完成 HOME 侧撤销'],
    mustKill: ['配置不可信时 auto clear --write(缩减入口)照常完成 HOME 侧撤销'],
  },
  {
    id: 'clear_prints_paths',
    clause:
      'R21-9.5 缩减入口的输出只含 id / 枚举 / 计数,不含路径(配置不可信时泄漏闸禁止集合不完整,靠这条兜底)',
    edits: [
      swap(
        'src/rsi/auto/write/clear-write.ts',
        '      outcomeCounts(report.outcomes),',
        "      outcomeCounts(report.outcomes) + ' ' + (p.outputForbidden ?? []).join(' '),",
      ),
    ],
    tests: ['rsi/auto/write-untrusted-config.test.ts'],
    expectRed: ['配置不可信时 auto clear --write(缩减入口)照常完成 HOME 侧撤销'],
    mustKill: ['配置不可信时 auto clear --write(缩减入口)照常完成 HOME 侧撤销'],
  },
  {
    id: 'other_writes_fail_open',
    clause: '配置不可信时除 clear 外的写命令保持 fail-closed(放宽只对缩减入口)',
    edits: [
      swap(
        'src/rsi/auto/deps-write.ts',
        "  if (cfg.status === 'off' && !LEGIT_OFF.has(cfg.reason)) {\n    throw new RsiFailClosedError(untrustedReason(cfg.reason));\n  }\n  const open = cfg.status === 'on' ? await openRsiIo(ctx) : null;",
        "  const open = cfg.status === 'on' ? await openRsiIo(ctx) : null;",
      ),
    ],
    tests: ['rsi/auto/write-untrusted-config.test.ts'],
    expectRed: ['配置不可信时其余写命令仍 fail-closed'],
    mustKill: ['配置不可信时其余写命令仍 fail-closed'],
  },
  {
    id: 'rbk_invalid_locked',
    clause: 'W0-22 第 4 条 持锁后重读仍要先判矛盾记录(取锁前出现的不得被当作可回滚)',
    edits: [
      swap(
        'src/rsi/auto/write/rollback-write.ts',
        "if (sel.invalid.length > 0) return failClosed(ctx, 'candidate_invalid');",
        'void sel.invalid;',
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['rollback --to 持锁后重读发现矛盾记录'],
    mustKill: ['rollback --to 持锁后重读发现矛盾记录'],
  },
  {
    id: 'rbk_no_confirm',
    clause: 'W0-25 rollback --to --write 展示两节后要求 yes(批量、用户可见)',
    edits: [
      swap(
        'src/rsi/auto/write/rollback-write.ts',
        "if (raw === undefined || raw.replace(/\\r$/, '') !== 'yes') {",
        'if (false) {',
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['rollback --to 展示两节后要求 yes'],
    mustKill: ['rollback --to 展示两节后要求 yes'],
  },
  {
    id: 'rbk_lock_before_confirm',
    clause: 'W0-25 拒绝时不取锁(确认先于取锁,不在持锁时等人输入)',
    edits: [
      swap(
        'src/rsi/auto/write/rollback-write.ts',
        "    ctx.stderr('RSI_CONFIRM_DECLINED\\n');\n    return ExitCode.CHECK_FAILED;",
        "    await locks.withLocks('rsi_personal_sync', async () => undefined);\n    ctx.stderr('RSI_CONFIRM_DECLINED\\n');\n    return ExitCode.CHECK_FAILED;",
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['rollback --to 展示两节后要求 yes'],
    mustKill: ['rollback --to 展示两节后要求 yes'],
  },
  {
    id: 'rbk_no_stale',
    clause: 'W0-25 持锁后重选与展示不一致 → RSI_CONFIRM_STALE',
    edits: [
      swap(
        'src/rsi/auto/write/rollback-write.ts',
        'if (shownKeys.length !== nowKeys.length || shownKeys.some((k, n) => k !== nowKeys[n])) {',
        'if (false) {',
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['rollback --to 持锁后重读重选'],
    mustKill: ['rollback --to 持锁后重读重选'],
  },
  {
    id: 'veto_no_late_retry',
    clause: 'W7 约定:较晚事件首次没施加(lateEventNotApplied)时命令重试一次',
    edits: [
      swap(
        'src/rsi/auto/write/veto.ts',
        '      out = await startRollback(d, req);',
        '      void req;',
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['veto 复用在途 txn 时较晚的 veto 事件首次没施加'],
    mustKill: ['veto 复用在途 txn 时较晚的 veto 事件首次没施加'],
  },
  {
    id: 'veto_late_complete_lost',
    clause:
      'W7 约定:较晚事件没施加而事务已走完 → 命令改走终态 veto(落黑名单),不新开空事务静默丢 veto',
    edits: [
      swap(
        'src/rsi/auto/write/veto.ts',
        "      if (out.status === 'complete') {",
        '      if (false) {',
      ),
    ],
    tests: ['rsi/auto/write-commands.test.ts'],
    expectRed: ['veto 较晚事件首次没施加、但事务随即走完'],
    mustKill: ['veto 较晚事件首次没施加、但事务随即走完'],
  },
  {
    id: 'status_inert_changed',
    clause: 'R21-13.1 V2+ 的键给惰性值(exec = not_available)',
    edits: [
      swap('src/rsi/auto/read/status-keys.ts', "    exec: 'not_available',", "    exec: 'off',"),
    ],
    tests: ['rsi/status-auto-keys.test.ts'],
    expectRed: ['[rsi] 关闭(off):惰性值'],
    mustKill: ['[rsi] 关闭(off):惰性值'],
  },
  {
    id: 'status_missing_view_zero',
    clause: 'W0-22 第 7 条 视图缺失时派生键为 null,绝不显示成全零',
    edits: [
      swap(
        'src/rsi/auto/read/status-keys.ts',
        '    pipeline: v?.pipeline ?? null,',
        '    pipeline: v?.pipeline ?? { states: {}, last30d: { rejected: 0, rolled_back: 0, expired: 0, retired: 0 } },',
      ),
    ],
    tests: ['rsi/status-auto-keys.test.ts'],
    expectRed: ['on 而没有视图(missing)', '损坏的视图'],
    mustKill: ['on 而没有视图(missing)'],
  },
  {
    id: 'status_user_marker_ignored',
    clause: 'R21-13.1 / W0-22 第 7 条 paused 与 pause_reasons 里 user_paused 按 U 的存在性补',
    edits: [
      swap(
        'src/rsi/auto/read/status-keys.ts',
        "  if (user) reasons.push('user_paused');",
        '  void user;',
      ),
    ],
    tests: ['rsi/status-auto-keys.test.ts'],
    expectRed: ['暂停:U 文件存在'],
    mustKill: ['暂停:U 文件存在'],
  },
];

/** 实测结果:待主代理整表重跑后回填(W8a 86 条 + W8b 58 条) */
export const V1_W8_RESULTS: readonly V1W8Result[] = [];
