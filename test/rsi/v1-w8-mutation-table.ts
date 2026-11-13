/**
 * §21 V1 W8a 必杀变异(命令面的路由 / 能力闸、只读命令、停住候选三态与 `AutoView` 读取语义、两套一致性协议、退出码映射、受限只读 git 适配器、`rollback --to` 选取规则、
 * `rsi report` 已观察范围、show 输出边界;契约 R21-12 / R21-13、§21.24 W0-22 第 3 ~ 8 条、W0-24)。
 * 执行方式同 W5 / W6 / W7:验证机私有检出里 cp 备份 → 按锚点替换(每个锚点在对应文件里**恰好出现一次**)→ 跑 `tests` → 失败集合非空、全部命中 `expectRed`、
 * `mustKill` 每项至少命中一个、没有 skipped → cp 还原并逐文件 sha256 核对。**不用 git checkout / stash 还原**。
 * 本文件只写表与每条变异期望红的测试名(`expectRed` 是杀手测试名里的字面子串;参数化用例只取模板之外的固定片段);变异由主代理执行,
 * 结果记进 `V1_W8_RESULTS`(W8a 实装块不执行变异,故留空)。变异 id 用短的下划线词。
 *
 * 不在本表的点(如实记录):写命令(pause / resume / clear --write / rebase-baseline / veto / rollback --write)的处理函数与端口契约的写侧(W8b);
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
];

/** 实测结果:r21w8a-mut4 @f38f6c9(86 条) */
export const V1_W8_RESULTS: readonly V1W8Result[] = [
  {
    id: 'gate_skipped',
    failed: 2,
    skipped: 0,
    killedBy: [
      '能力闸 生产相位恒为 0:全部是桩;规范名取表里的键',
      '能力闸 未到期的命令不构造端口、不解析参数(坏参数照样是桩)、不调用写处理函数',
    ],
    restored: true,
  },
  {
    id: 'write_not_stub',
    failed: 1,
    skipped: 0,
    killedBy: [
      '能力闸 相位够了:读命令跑到处理函数(端口只构造一次);写命令仍接到「未实现」桩(W8b 替换),不构造端口',
    ],
    restored: true,
  },
  {
    id: 'write_flag_ignored',
    failed: 2,
    skipped: 0,
    killedBy: [
      'routeAuto(纯函数) --write 分流:pause / resume / rebase-baseline / veto 恒为写;clear 与 rollback 仅在含精确 token `--write` 时为写;status / report / show 恒为读',
      '能力闸 写处理函数的接缝:注入后按规范名调用,参数是二级命令名之后的 rest(W8b 只需替换处理函数)',
    ],
    restored: true,
  },
  {
    id: 'rollback_write_ignored',
    failed: 1,
    skipped: 0,
    killedBy: [
      'routeAuto(纯函数) --write 分流:pause / resume / rebase-baseline / veto 恒为写;clear 与 rollback 仅在含精确 token `--write` 时为写;status / report / show 恒为读',
    ],
    restored: true,
  },
  {
    id: 'unknown_sub_guess',
    failed: 1,
    skipped: 0,
    killedBy: ['routeAuto(纯函数) auto 的五个二级命令;缺失 / 未知 → undefined(不回显、不猜)'],
    restored: true,
  },
  {
    id: 'cap_threshold_lowered',
    failed: 1,
    skipped: 0,
    killedBy: [
      '能力闸 逐能力的相位边界:cmd_* 为 V1a 的命令在相位 1 起可用;cmd_rollback_to 为 V1b,相位 1 仍是桩、相位 2 起可用;不在表里的键恒拒绝',
    ],
    restored: true,
  },
  {
    id: 'stale_boundary',
    failed: 1,
    skipped: 0,
    killedBy: [
      '视图语义(interpretView):缺失 / 损坏 / 陈旧 陈旧阈值 48 小时:恰好 48h 仍 fresh,多 1 毫秒即 stale;as_of 在未来超出时钟容差 → corrupt',
    ],
    restored: true,
  },
  {
    id: 'stale_const_changed',
    failed: 2,
    skipped: 0,
    killedBy: [
      '视图语义(interpretView):缺失 / 损坏 / 陈旧 陈旧阈值 48 小时:恰好 48h 仍 fresh,多 1 毫秒即 stale;as_of 在未来超出时钟容差 → corrupt',
      '停住候选三态(视图 fresh) 视图陈旧 → 全部 unconfirmed:view_stale,数据照出并带 as_of;缺失 / 损坏视图 → rollback_stalled 为 null',
    ],
    restored: true,
  },
  {
    id: 'future_asof_fresh',
    failed: 1,
    skipped: 0,
    killedBy: [
      '视图语义(interpretView):缺失 / 损坏 / 陈旧 陈旧阈值 48 小时:恰好 48h 仍 fresh,多 1 毫秒即 stale;as_of 在未来超出时钟容差 → corrupt',
    ],
    restored: true,
  },
  {
    id: 'corrupt_as_missing',
    failed: 1,
    skipped: 0,
    killedBy: [
      '视图语义(interpretView):缺失 / 损坏 / 陈旧 缺失 → missing;读不出 / 非 JSON / 不合 schema → corrupt;不会显示成全零',
    ],
    restored: true,
  },
  {
    id: 'view_missing_zero',
    failed: 2,
    skipped: 0,
    killedBy: [
      '键集合与文本 / JSON 形状 --json:顶层键与 auto 下的键集合固定;缺失视图时派生键为 null,退 0',
      '键集合与文本 / JSON 形状 损坏的视图:退 0,view_state=corrupt,派生键为 null(不是零)',
    ],
    restored: true,
  },
  {
    id: 'state_invalid_ignored',
    failed: 1,
    skipped: 0,
    killedBy: [
      'paused 判据与 breaker_marker state.json 过不了 schema → 退 3 state_invalid;stdout 为空',
    ],
    restored: true,
  },
  {
    id: 'user_paused_not_added',
    failed: 1,
    skipped: 0,
    killedBy: [
      'paused 判据与 breaker_marker 用户标记 U 存在 → paused,pause_reasons 含 user_paused;U 与熔断码互不替代',
    ],
    restored: true,
  },
  {
    id: 'paused_ignores_owner',
    failed: 1,
    skipped: 0,
    killedBy: [
      'paused 判据与 breaker_marker diverged / owner_changed 各自单独就使 paused 为真;全部为空则为 false',
    ],
    restored: true,
  },
  {
    id: 'breaker_marker_always',
    failed: 1,
    skipped: 0,
    killedBy: [
      'paused 判据与 breaker_marker B 在而状态无熔断码 → paused 且 breaker_marker=pending;B 在且有码 → breaker_marker=absent',
    ],
    restored: true,
  },
  {
    id: 'profile_effective_raw',
    failed: 1,
    skipped: 0,
    killedBy: ['键集合与文本 / JSON 形状 profile_effective:相位 < V3 恒为 lite,相位 ≥ V3 取配置值'],
    restored: true,
  },
  {
    id: 'stalled_copy_recovers',
    failed: 1,
    skipped: 0,
    killedBy: [
      '停住候选的人工处置文案 stalled 时给出固定处置;明说「不会自动恢复」;不含「删除即可」,不宣称会自动恢复,不写「完成后 resume」',
    ],
    restored: true,
  },
  {
    id: 'grace_inclusive',
    failed: 1,
    skipped: 0,
    killedBy: [
      '停住候选三态(视图 fresh) 不可重建类 + 超过 60 分钟宽限 + 无 journal → stalled;宽限内 → pending(60 分钟整仍 pending)',
    ],
    restored: true,
  },
  {
    id: 'grace_const_changed',
    failed: 4,
    skipped: 0,
    killedBy: [
      '停住候选三态(视图 fresh) 不可重建类 + 超过 60 分钟宽限 + 无 journal → stalled;宽限内 → pending(60 分钟整仍 pending)',
      '停住候选三态(视图 fresh) harm_* / judge_* / limit_reached 都按不可重建类',
      '停住候选三态(视图 fresh) 该候选已有 journal(按 (id, sha) 现算的 txn 名)→ 不列入;同 id 不同 sha 的 journal 不算',
      '停住候选的人工处置文案 stalled 时给出固定处置;明说「不会自动恢复」;不含「删除即可」,不宣称会自动恢复,不写「完成后 resume」',
    ],
    restored: true,
  },
  {
    id: 'stall_recoverable_as_stalled',
    failed: 1,
    skipped: 0,
    killedBy: [
      '停住候选三态(视图 fresh) 可重建类原因(cleared)即使超时也不是 stalled(worker 会补 journal)',
    ],
    restored: true,
  },
  {
    id: 'stall_journal_ignored',
    failed: 2,
    skipped: 0,
    killedBy: [
      '停住候选三态(视图 fresh) 该候选已有 journal(按 (id, sha) 现算的 txn 名)→ 不列入;同 id 不同 sha 的 journal 不算',
      '视图截断(JSON):截断标志不丢,缺失 / 损坏为 null 而不是 false fresh + rolling_back_truncated=true + 可见条目都有 journal → rollback_stalled 为 [],但 rollback_stalled_truncated 为 true(分得清「没有」与「被截断」)',
    ],
    restored: true,
  },
  {
    id: 'stall_sha_ignored',
    failed: 1,
    skipped: 0,
    killedBy: [
      '停住候选三态(视图 fresh) 该候选已有 journal(按 (id, sha) 现算的 txn 名)→ 不列入;同 id 不同 sha 的 journal 不算',
    ],
    restored: true,
  },
  {
    id: 'stall_view_stale_ignored',
    failed: 1,
    skipped: 0,
    killedBy: [
      '停住候选三态(视图 fresh) 视图陈旧 → 全部 unconfirmed:view_stale,数据照出并带 as_of;缺失 / 损坏视图 → rollback_stalled 为 null',
    ],
    restored: true,
  },
  {
    id: 'existence_single_read',
    failed: 2,
    skipped: 0,
    killedBy: [
      '停住候选三态(视图 fresh) 存在性双读之间事务目录变化 → unconfirmed:snapshot_moving(不重试、不退 4)',
      '停住候选三态(视图 fresh) 撤销凭据在双读之间变化同样 → snapshot_moving;事务目录读不出 → unconfirmed:txn_unreadable',
    ],
    restored: true,
  },
  {
    id: 'status_reads_journal',
    failed: 2,
    skipped: 0,
    killedBy: [
      '停住候选三态(视图 fresh) 存在性双读之间事务目录变化 → unconfirmed:snapshot_moving(不重试、不退 4)',
      'status 不跑 git、不解析 journal 内容(弱协议) 完整运行后:受限只读 git 端口与 journal 内容读取的调用次数都是 0',
    ],
    restored: true,
  },
  {
    id: 'content_no_recheck',
    failed: 3,
    skipped: 0,
    killedBy: [
      '内容验证双读协议 head.json 在两次读之间被改动一次 → 回到开头重试后成功;每次都被改 → 3 次用尽退 4 RSI_SNAPSHOT_BUSY',
      '内容验证双读协议 事务目录增删、撤销凭据变化 → 同样不稳定(用尽退 4)',
      '内容验证双读协议 同名原子替换 journal / 只改 phase(目录成员不变)→ 内容摘要变化 → 不稳定;去掉 journal 内容复核会漏掉它',
    ],
    restored: true,
  },
  {
    id: 'journal_digest_dropped',
    failed: 1,
    skipped: 0,
    killedBy: [
      '内容验证双读协议 同名原子替换 journal / 只改 phase(目录成员不变)→ 内容摘要变化 → 不稳定;去掉 journal 内容复核会漏掉它',
    ],
    restored: true,
  },
  {
    id: 'busy_as_failed',
    failed: 4,
    skipped: 0,
    killedBy: [
      '内容验证双读协议 head.json 在两次读之间被改动一次 → 回到开头重试后成功;每次都被改 → 3 次用尽退 4 RSI_SNAPSHOT_BUSY',
      '内容验证双读协议 事务目录增删、撤销凭据变化 → 同样不稳定(用尽退 4)',
      '内容验证双读协议 同名原子替换 journal / 只改 phase(目录成员不变)→ 内容摘要变化 → 不稳定;去掉 journal 内容复核会漏掉它',
      '内容验证双读协议 记录提交对象消失(gc)→ 回到开头重试;持续消失 → 用尽退 4,不是「没有候选」',
    ],
    restored: true,
  },
  {
    id: 'consistency_claims_atomic',
    failed: 2,
    skipped: 0,
    killedBy: [
      '输出边界 每处正文前带 RSI_AUTO_LABEL(只引用常量);正文逐行带「| 」前缀;一致性口径是 double-read,不写「原子」',
      '内容验证双读协议 改后改回(ABA)不被检出:输出照常,文案不含「原子」',
    ],
    restored: true,
  },
  {
    id: 'object_missing_not_retry',
    failed: 1,
    skipped: 0,
    killedBy: [
      '内容验证双读协议 记录提交对象消失(gc)→ 回到开头重试;持续消失 → 用尽退 4,不是「没有候选」',
    ],
    restored: true,
  },
  {
    id: 'unreadable_as_empty',
    failed: 1,
    skipped: 0,
    killedBy: [
      '读取失败一律 fail-closed(退 3,不当成「没有候选」) 适配器不可读 / 未装配 → 3 personal_repo_invalid;head.json 不合规 → 同;记录不合规 / 文件名与 id 不符 → 3 candidate_invalid',
    ],
    restored: true,
  },
  {
    id: 'record_id_mismatch_ok',
    failed: 1,
    skipped: 0,
    killedBy: [
      '读取失败一律 fail-closed(退 3,不当成「没有候选」) 适配器不可读 / 未装配 → 3 personal_repo_invalid;head.json 不合规 → 同;记录不合规 / 文件名与 id 不符 → 3 candidate_invalid',
    ],
    restored: true,
  },
  {
    id: 'show_no_tty_check',
    failed: 1,
    skipped: 0,
    killedBy: [
      '参数与 TTY 顺序(都在读取之前判) 无 TTY → 退 2 not_tty,且没有任何读取;未知参数 → unknown_arg;id 形状不对 / 不存在 → unknown_id(退 2)',
    ],
    restored: true,
  },
  {
    id: 'show_no_leak_gate',
    failed: 1,
    skipped: 0,
    killedBy: ['输出边界 泄漏闸:正文含禁止值 → 退 3 output_leak,stdout 一个字节都不写'],
    restored: true,
  },
  {
    id: 'show_label_dropped',
    failed: 2,
    skipped: 0,
    killedBy: [
      '输出边界 每处正文前带 RSI_AUTO_LABEL(只引用常量);正文逐行带「| 」前缀;一致性口径是 double-read,不写「原子」',
      'N4-2 关联提案裁决段(失败只影响该段) 有裁决记录 → 段内容带标签与清洗后的字段;自报记录带 declared',
    ],
    restored: true,
  },
  {
    id: 'show_body_unprefixed',
    failed: 3,
    skipped: 0,
    killedBy: [
      '输出边界 每处正文前带 RSI_AUTO_LABEL(只引用常量);正文逐行带「| 」前缀;一致性口径是 double-read,不写「原子」',
      '输出边界 正文清洗:控制 / 双向覆盖 / 行分隔字符 → `?`;正文不能伪造本命令的行(只有一行真正的 journal=)',
      'N4-2 关联提案裁决段(失败只影响该段) 裁决读取不可用 / 抛错 → 只有该段是 unavailable,其余输出与退出码不变',
    ],
    restored: true,
  },
  {
    id: 'show_body_unsanitized',
    failed: 1,
    skipped: 0,
    killedBy: [
      '输出边界 正文清洗:控制 / 双向覆盖 / 行分隔字符 → `?`;正文不能伪造本命令的行(只有一行真正的 journal=)',
    ],
    restored: true,
  },
  {
    id: 'journal_binding_loose',
    failed: 1,
    skipped: 0,
    killedBy: [
      'journal 三态与保护标记 absent(只表示「该次读取下不存在」)/ ok / invalid;invalid 只写「按运行手册处置」,不含路径与「删除即可」',
    ],
    restored: true,
  },
  {
    id: 'report_claims_complete',
    failed: 1,
    skipped: 0,
    killedBy: [
      '四类情形 (1)完整但前几天无事件 与 (2)被截断:不区分——输出逐字节相同,都是 request_before_observed=true',
    ],
    restored: true,
  },
  {
    id: 'report_prior_ignored',
    failed: 2,
    skipped: 0,
    killedBy: [
      '四类情形 (3)空文件:audit_file=present、observed=null、文本写「观察到 0 行」,不报「0 次转移」;账显示曾有转移 → 退 3 audit_invalid',
      '四类情形 (4)文件缺失:无账显示 → 退 0 并标「无审计文件(未观察到任何事件)」;账显示曾有转移 → 退 3 audit_invalid',
    ],
    restored: true,
  },
  {
    id: 'report_skip_corrupt',
    failed: 1,
    skipped: 0,
    killedBy: ['四类情形 任一行不合规 → corrupt_lines=<n>,退 3,不得跳过后退 0;读不出 → 退 3'],
    restored: true,
  },
  {
    id: 'report_before_flipped',
    failed: 2,
    skipped: 0,
    killedBy: [
      '四类情形 (1)完整但前几天无事件 与 (2)被截断:不区分——输出逐字节相同,都是 request_before_observed=true',
      '四类情形 请求起点不早于已观察起点 → request_before_observed=false',
    ],
    restored: true,
  },
  {
    id: 'report_week_start_shifted',
    failed: 1,
    skipped: 0,
    killedBy: [
      '参数与区间 --week = 当前 UTC 周的周一起;--since D 必须是真实日历日;--week 与 --since 互斥',
    ],
    restored: true,
  },
  {
    id: 'rb_boundary_inclusive',
    failed: 2,
    skipped: 0,
    killedBy: [
      'select-rollback(纯函数):严格大于 / 日期不可知 / 矛盾记录 候选「进入 canary 的 UTC 日」> D(不含当日):D = 进入日 → 不含;D = 前一天 → 含;差一天的两侧都钉住',
      'select-rollback(纯函数):严格大于 / 日期不可知 / 矛盾记录 带时区偏移的时间先换算成 UTC 日再比较',
    ],
    restored: true,
  },
  {
    id: 'rb_unknown_excluded',
    failed: 3,
    skipped: 0,
    killedBy: [
      'select-rollback(纯函数):严格大于 / 日期不可知 / 矛盾记录 日期不可知(transitions_dropped>0 且无进入 canary 的记录)→ 单列纳入,不进主列表;dropped=0 而缺记录 → invalid(不静默排除)',
      'select-rollback(纯函数):严格大于 / 日期不可知 / 矛盾记录 rolling_back 可由从未进入 canary 的候选进入:完整历史(dropped=0)里没有进入记录 = 不在范围,不是 invalid;历史被截断则仍按日期不可知纳入',
      'rsi rollback --to 干跑 文本:主列表与「日期不可知,按保守方向纳入」单列一节,计数分开;json 的 date_unknown[] 同样单列',
    ],
    restored: true,
  },
  {
    id: 'rb_unknown_unlisted',
    failed: 3,
    skipped: 0,
    killedBy: [
      'select-rollback(纯函数):严格大于 / 日期不可知 / 矛盾记录 日期不可知(transitions_dropped>0 且无进入 canary 的记录)→ 单列纳入,不进主列表;dropped=0 而缺记录 → invalid(不静默排除)',
      'select-rollback(纯函数):严格大于 / 日期不可知 / 矛盾记录 rolling_back 可由从未进入 canary 的候选进入:完整历史(dropped=0)里没有进入记录 = 不在范围,不是 invalid;历史被截断则仍按日期不可知纳入',
      'rsi rollback --to 干跑 文本:主列表与「日期不可知,按保守方向纳入」单列一节,计数分开;json 的 date_unknown[] 同样单列',
    ],
    restored: true,
  },
  {
    id: 'rb_utc_offset_ignored',
    failed: 1,
    skipped: 0,
    killedBy: [
      'select-rollback(纯函数):严格大于 / 日期不可知 / 矛盾记录 带时区偏移的时间先换算成 UTC 日再比较',
    ],
    restored: true,
  },
  {
    id: 'rb_order_flipped',
    failed: 2,
    skipped: 0,
    killedBy: [
      'select-rollback(纯函数):严格大于 / 日期不可知 / 矛盾记录 候选「进入 canary 的 UTC 日」> D(不含当日):D = 进入日 → 不含;D = 前一天 → 含;差一天的两侧都钉住',
      'select-rollback(纯函数):严格大于 / 日期不可知 / 矛盾记录 按生效逆序:进入 canary 晚者在前,同刻按 id',
    ],
    restored: true,
  },
  {
    id: 'rb_bad_date_rollover',
    failed: 2,
    skipped: 0,
    killedBy: [
      'select-rollback(纯函数):严格大于 / 日期不可知 / 矛盾记录 parseUtcDate:只接受真实日历日的 YYYY-MM-DD',
      'rsi rollback --to 干跑 参数先于任何读取:缺 --to / 坏日期 → 2 bad_date;未知参数 → 2 unknown_arg',
    ],
    restored: true,
  },
  {
    id: 'rb_off_exit_zero',
    failed: 1,
    skipped: 0,
    killedBy: [
      'rsi rollback --to 干跑 [rsi] 关闭 → 退 4 RSI_NOT_RUN reason=off,提示改用 rsi auto clear;不是 0',
    ],
    restored: true,
  },
  {
    id: 'cleardry_lists_terminal',
    failed: 1,
    skipped: 0,
    killedBy: [
      'rsi auto clear 干跑 只列非终态候选(终态不列);带 journal 三态;不依赖 [rsi](关闭时照常完成)',
    ],
    restored: true,
  },
  {
    id: 'exit_priority_reversed',
    failed: 1,
    skipped: 0,
    killedBy: [
      '优先级 取最小号:not_wired(1)压过 locked(7);locked(7)压过 manual(9);busy(8)压过 manual(9);cause 优先级 1<2<3<4<5<6',
    ],
    restored: true,
  },
  {
    id: 'exit_manual_as_3',
    failed: 13,
    skipped: 0,
    killedBy: [
      '11 行逐格 9a manual_event_required → 退 1',
      '11 行逐格 9b manual_by_ambiguous → 退 1',
      '11 行逐格 9c retryable → 退 1',
      '11 行逐格 9d static_removal_pending → 退 1',
      '优先级 第 9 行退 1(不是 3);匹配 cause 而不是 why 前缀:why 写成 repo_unreadable:… 但 cause=retryable 仍是第 9 行',
      '事务身份归并与完整性错误 失败时已完成的撤销仍先逐行输出(信息行在前,失败行在后);成功 variant 缺 txn 对应候选时以 txn= 代替',
      '按 variant × cause 穷举 incomplete × retryable → 退 1',
      '按 variant × cause 穷举 refused(带事务身份)× retryable → 退 1',
      '按 variant × cause 穷举 incomplete × manual_event_required → 退 1',
      '按 variant × cause 穷举 refused(带事务身份)× manual_event_required → 退 1',
      '按 variant × cause 穷举 incomplete × manual_by_ambiguous → 退 1',
      '按 variant × cause 穷举 refused(带事务身份)× manual_by_ambiguous → 退 1',
      '同一身份的多次失败 严重失败后接轻微失败(及反向)仍保留最严重的;失败→成功→失败仍未解决',
    ],
    restored: true,
  },
  {
    id: 'exit_missing_cause_ok',
    failed: 1,
    skipped: 0,
    killedBy: [
      '11 行逐格 6 失败 variant 上缺失 / 未识别的 cause → 退 3 internal;成功 variant 无 cause 是正常(不打 3)',
    ],
    restored: true,
  },
  {
    id: 'exit_complete_clears_all',
    failed: 2,
    skipped: 0,
    killedBy: [
      '事务身份归并与完整性错误 同一身份的后续 complete 消除此前的失败;同 id 不同 sha(不同 txn)互不消除',
      '事务身份归并与完整性错误 journal 完整性错误(refused、txn=null、带 journal 句柄)不被任何 complete 消除;每份独立(同候选两份不一致 journal 各报一份)',
    ],
    restored: true,
  },
  {
    id: 'exit_enum_failure_ok',
    failed: 1,
    skipped: 0,
    killedBy: [
      '事务身份归并与完整性错误 候选枚举失败(含部分成功后)→ 退 3 personal_repo_invalid,不得退 0;已成功项先输出',
    ],
    restored: true,
  },
  {
    id: 'exit_busy_as_locked',
    failed: 1,
    skipped: 0,
    killedBy: [
      '11 行逐格 7 / 8 命令级前置:locked / off / not_diverged → 退 4 RSI_NOT_RUN;快照协议用尽 → 退 4 RSI_SNAPSHOT_BUSY',
    ],
    restored: true,
  },
  {
    id: 'exit_cause_row_swapped',
    failed: 2,
    skipped: 0,
    killedBy: [
      '11 行逐格 2 credentials_invalid → 退 3 reason=revocations_invalid',
      '优先级 取最小号:not_wired(1)压过 locked(7);locked(7)压过 manual(9);busy(8)压过 manual(9);cause 优先级 1<2<3<4<5<6',
    ],
    restored: true,
  },
  {
    id: 'git_no_preflight',
    failed: 19,
    skipped: 0,
    killedBy: [
      '真仓库(假 HOME 下的私有仓库,真 git) 预检拒绝:include 引入 promisor → unreadable 且 spawn 次数 = 0(含「假旧版 git:忽略 GIT_NO_LAZY_FETCH 并对缺失对象尝试抓取」的场景)',
      '真仓库(假 HOME 下的私有仓库,真 git) 预检拒绝:includeIf → unreadable 且 spawn 次数 = 0(含「假旧版 git:忽略 GIT_NO_LAZY_FETCH 并对缺失对象尝试抓取」的场景)',
      '真仓库(假 HOME 下的私有仓库,真 git) 预检拒绝:extensions.partialClone → unreadable 且 spawn 次数 = 0(含「假旧版 git:忽略 GIT_NO_LAZY_FETCH 并对缺失对象尝试抓取」的场景)',
      '真仓库(假 HOME 下的私有仓库,真 git) 预检拒绝:remote.origin.promisor → unreadable 且 spawn 次数 = 0(含「假旧版 git:忽略 GIT_NO_LAZY_FETCH 并对缺失对象尝试抓取」的场景)',
      '真仓库(假 HOME 下的私有仓库,真 git) 预检拒绝:partialclonefilter → unreadable 且 spawn 次数 = 0(含「假旧版 git:忽略 GIT_NO_LAZY_FETCH 并对缺失对象尝试抓取」的场景)',
      '真仓库(假 HOME 下的私有仓库,真 git) 预检拒绝:续行 \\ → unreadable 且 spawn 次数 = 0(含「假旧版 git:忽略 GIT_NO_LAZY_FETCH 并对缺失对象尝试抓取」的场景)',
      '真仓库(假 HOME 下的私有仓库,真 git) 预检拒绝:旧式段头 [remote.foo] → unreadable 且 spawn 次数 = 0(含「假旧版 git:忽略 GIT_NO_LAZY_FETCH 并对缺失对象尝试抓取」的场景)',
      '真仓库(假 HOME 下的私有仓库,真 git) 预检拒绝:config 超过 64 KiB → unreadable 且 spawn 次数 = 0(含「假旧版 git:忽略 GIT_NO_LAZY_FETCH 并对缺失对象尝试抓取」的场景)',
      '真仓库(假 HOME 下的私有仓库,真 git) 预检拒绝:config 权限 0000(读不出) → unreadable 且 spawn 次数 = 0(含「假旧版 git:忽略 GIT_NO_LAZY_FETCH 并对缺失对象尝试抓取」的场景)',
      '真仓库(假 HOME 下的私有仓库,真 git) 预检拒绝:config 是目录 → unreadable 且 spawn 次数 = 0(含「假旧版 git:忽略 GIT_NO_LAZY_FETCH 并对缺失对象尝试抓取」的场景)',
      '真仓库(假 HOME 下的私有仓库,真 git) 预检拒绝:config 是符号链接 → unreadable 且 spawn 次数 = 0(含「假旧版 git:忽略 GIT_NO_LAZY_FETCH 并对缺失对象尝试抓取」的场景)',
      '真仓库(假 HOME 下的私有仓库,真 git) 预检拒绝:config.worktree 存在 → unreadable 且 spawn 次数 = 0(含「假旧版 git:忽略 GIT_NO_LAZY_FETCH 并对缺失对象尝试抓取」的场景)',
      '真仓库(假 HOME 下的私有仓库,真 git) 预检拒绝:.gitconfig 存在 → unreadable 且 spawn 次数 = 0(含「假旧版 git:忽略 GIT_NO_LAZY_FETCH 并对缺失对象尝试抓取」的场景)',
      '真仓库(假 HOME 下的私有仓库,真 git) 预检拒绝:.config/git 存在 → unreadable 且 spawn 次数 = 0(含「假旧版 git:忽略 GIT_NO_LAZY_FETCH 并对缺失对象尝试抓取」的场景)',
      '真仓库(假 HOME 下的私有仓库,真 git) 预检拒绝:objects/pack/x.promisor → unreadable 且 spawn 次数 = 0(含「假旧版 git:忽略 GIT_NO_LAZY_FETCH 并对缺失对象尝试抓取」的场景)',
      '真仓库(假 HOME 下的私有仓库,真 git) 预检拒绝:objects/info/alternates → unreadable 且 spawn 次数 = 0(含「假旧版 git:忽略 GIT_NO_LAZY_FETCH 并对缺失对象尝试抓取」的场景)',
      '真仓库(假 HOME 下的私有仓库,真 git) 预检拒绝:info/grafts → unreadable 且 spawn 次数 = 0(含「假旧版 git:忽略 GIT_NO_LAZY_FETCH 并对缺失对象尝试抓取」的场景)',
      '真仓库(假 HOME 下的私有仓库,真 git) 仓库目录本身不安全 → unreadable 且 spawn = 0:相对路径、符号链接、非本人属主、权限宽于 0700(含 git init 默认的 0755)',
      '真仓库(假 HOME 下的私有仓库,真 git) 每次读取前都预检:装配时 / 第一次读取通过不能替代第二次读取前的检查(第二次读取前改 config 必须被拒)',
    ],
    restored: true,
  },
  {
    id: 'git_no_recheck',
    failed: 2,
    skipped: 0,
    killedBy: [
      '真仓库(假 HOME 下的私有仓库,真 git) 预检通过后、git 读取之前(spawn 期间)config 被改 → 结果被丢弃并拒收(changed_during_read)。注:此情形只检测并拒收,不保证零写入',
      '真仓库(假 HOME 下的私有仓库,真 git) 存在性集合在 spawn 期间变化(出现 .promisor 文件)同样拒收',
    ],
    restored: true,
  },
  {
    id: 'git_promisor_key_allowed',
    failed: 6,
    skipped: 0,
    killedBy: [
      '配置预检的严格子集解析(纯函数) 拒绝:remote.promisor',
      '配置预检的严格子集解析(纯函数) 拒绝:remote.partialclonefilter',
      '配置预检的严格子集解析(纯函数) 拒绝:任一段内的 promisor 键',
      '真仓库(假 HOME 下的私有仓库,真 git) 预检拒绝:remote.origin.promisor → unreadable 且 spawn 次数 = 0(含「假旧版 git:忽略 GIT_NO_LAZY_FETCH 并对缺失对象尝试抓取」的场景)',
      '真仓库(假 HOME 下的私有仓库,真 git) 预检拒绝:partialclonefilter → unreadable 且 spawn 次数 = 0(含「假旧版 git:忽略 GIT_NO_LAZY_FETCH 并对缺失对象尝试抓取」的场景)',
      '真仓库(假 HOME 下的私有仓库,真 git) 每次读取前都预检:装配时 / 第一次读取通过不能替代第二次读取前的检查(第二次读取前改 config 必须被拒)',
    ],
    restored: true,
  },
  {
    id: 'git_extensions_open',
    failed: 3,
    skipped: 0,
    killedBy: [
      '配置预检的严格子集解析(纯函数) 拒绝:extensions.partialClone',
      '配置预检的严格子集解析(纯函数) 拒绝:extensions 白名单外的键',
      '真仓库(假 HOME 下的私有仓库,真 git) 预检拒绝:extensions.partialClone → unreadable 且 spawn 次数 = 0(含「假旧版 git:忽略 GIT_NO_LAZY_FETCH 并对缺失对象尝试抓取」的场景)',
    ],
    restored: true,
  },
  {
    id: 'git_alternates_allowed',
    failed: 1,
    skipped: 0,
    killedBy: [
      '真仓库(假 HOME 下的私有仓库,真 git) 预检拒绝:objects/info/alternates → unreadable 且 spawn 次数 = 0(含「假旧版 git:忽略 GIT_NO_LAZY_FETCH 并对缺失对象尝试抓取」的场景)',
    ],
    restored: true,
  },
  {
    id: 'git_promisor_file_ok',
    failed: 2,
    skipped: 0,
    killedBy: [
      '真仓库(假 HOME 下的私有仓库,真 git) 预检拒绝:objects/pack/x.promisor → unreadable 且 spawn 次数 = 0(含「假旧版 git:忽略 GIT_NO_LAZY_FETCH 并对缺失对象尝试抓取」的场景)',
      '真仓库(假 HOME 下的私有仓库,真 git) 存在性集合在 spawn 期间变化(出现 .promisor 文件)同样拒收',
    ],
    restored: true,
  },
  {
    id: 'git_config_cap_removed',
    failed: 1,
    skipped: 0,
    killedBy: [
      '真仓库(假 HOME 下的私有仓库,真 git) 预检拒绝:config 超过 64 KiB → unreadable 且 spawn 次数 = 0(含「假旧版 git:忽略 GIT_NO_LAZY_FETCH 并对缺失对象尝试抓取」的场景)',
    ],
    restored: true,
  },
  {
    id: 'git_argv_shape_open',
    failed: 2,
    skipped: 0,
    killedBy: [
      'argv 形状:三种之外一律拒绝 非法形状:多 / 少参数、`--` 路径、非 40 位小写 oid、revision 表达式、第四种操作、形状 ① 的后缀缺失,各一例',
      'argv 形状:三种之外一律拒绝 <FIXED> 逐项等值:缺一项 / 换值 / 换序 / 另一个仓库目录都拒绝',
    ],
    restored: true,
  },
  {
    id: 'git_fixed_prefix_loose',
    failed: 1,
    skipped: 0,
    killedBy: [
      'argv 形状:三种之外一律拒绝 <FIXED> 逐项等值:缺一项 / 换值 / 换序 / 另一个仓库目录都拒绝',
    ],
    restored: true,
  },
  {
    id: 'git_env_loose',
    failed: 1,
    skipped: 0,
    killedBy: [
      '封闭 env 恰好 12 个键,值等于清单;多一键 / 缺一键 / 值不同都拒绝;从不含 GIT_DIR 等危险键',
    ],
    restored: true,
  },
  {
    id: 'git_env_value_changed',
    failed: 1,
    skipped: 0,
    killedBy: [
      '封闭 env 恰好 12 个键,值等于清单;多一键 / 缺一键 / 值不同都拒绝;从不含 GIT_DIR 等危险键',
    ],
    restored: true,
  },
  {
    id: 'git_cwd_not_repo',
    failed: 1,
    skipped: 0,
    killedBy: [
      '真仓库(假 HOME 下的私有仓库,真 git) 三种读取都成功;每次 spawn 的 argv 通过形状校验、env 恰为封闭清单、cwd = 仓库目录、git 是绝对路径',
    ],
    restored: true,
  },
  {
    id: 'git_blob_count_cap',
    failed: 1,
    skipped: 0,
    killedBy: [
      '真仓库(假 HOME 下的私有仓库,真 git) blob 个数上限 512、总字节上限 8 MiB:超限即 unreadable(output_limit)',
    ],
    restored: true,
  },
  {
    id: 'git_blob_bytes_cap',
    failed: 1,
    skipped: 0,
    killedBy: [
      '真仓库(假 HOME 下的私有仓库,真 git) blob 个数上限 512、总字节上限 8 MiB:超限即 unreadable(output_limit)',
    ],
    restored: true,
  },
  {
    id: 'git_stdout_cap',
    failed: 1,
    skipped: 0,
    killedBy: [
      '真仓库(假 HOME 下的私有仓库,真 git) git 异常退出码 → unreadable(stderr 不进输出);超时 / 启动失败 / 输出超 4 MiB 各自映射;形状 ① 的退出码 1 才是 missing',
    ],
    restored: true,
  },
  {
    id: 'git_nonzero_ok',
    failed: 1,
    skipped: 0,
    killedBy: [
      '真仓库(假 HOME 下的私有仓库,真 git) git 异常退出码 → unreadable(stderr 不进输出);超时 / 启动失败 / 输出超 4 MiB 各自映射;形状 ① 的退出码 1 才是 missing',
    ],
    restored: true,
  },
  {
    id: 'git_missing_any_status1',
    failed: 1,
    skipped: 0,
    killedBy: [
      '真仓库(假 HOME 下的私有仓库,真 git) git 异常退出码 → unreadable(stderr 不进输出);超时 / 启动失败 / 输出超 4 MiB 各自映射;形状 ① 的退出码 1 才是 missing',
    ],
    restored: true,
  },
  {
    id: 'git_uid_unchecked',
    failed: 1,
    skipped: 0,
    killedBy: [
      '真仓库(假 HOME 下的私有仓库,真 git) 仓库目录本身不安全 → unreadable 且 spawn = 0:相对路径、符号链接、非本人属主、权限宽于 0700(含 git init 默认的 0755)',
    ],
    restored: true,
  },
  {
    id: 'git_wide_mode_ok',
    failed: 1,
    skipped: 0,
    killedBy: [
      '真仓库(假 HOME 下的私有仓库,真 git) 仓库目录本身不安全 → unreadable 且 spawn = 0:相对路径、符号链接、非本人属主、权限宽于 0700(含 git init 默认的 0755)',
    ],
    restored: true,
  },
  {
    id: 'runner_guard_removed',
    failed: 1,
    skipped: 0,
    killedBy: [
      '封闭 env runGitClosed 自身的守卫:相对路径 / 文件名不是 git / env 键越界 / cwd 非绝对 → 抛错(不 spawn)',
    ],
    restored: true,
  },
  {
    id: 'home_unreadable_as_absent',
    failed: 1,
    skipped: 0,
    killedBy: [
      'HomeReadPort 契约:生产适配器 makeHomeReadPort 读失败 → unreadable,绝不是 absent / 空',
    ],
    restored: true,
  },
  {
    id: 'git_include_whitelisted',
    failed: 6,
    skipped: 0,
    killedBy: [
      '配置预检的严格子集解析(纯函数) 拒绝:include 段与 includeIf 段(单独触发:config 除该段外完全合规,对照组通过)',
      '配置预检的严格子集解析(纯函数) 拒绝:include',
      '配置预检的严格子集解析(纯函数) 拒绝:includeIf',
      '配置预检的严格子集解析(纯函数) 拒绝:INCLUDE(大小写不敏感)',
      '真仓库(假 HOME 下的私有仓库,真 git) 预检拒绝:include 引入 promisor → unreadable 且 spawn 次数 = 0(含「假旧版 git:忽略 GIT_NO_LAZY_FETCH 并对缺失对象尝试抓取」的场景)',
      '真仓库(假 HOME 下的私有仓库,真 git) 预检拒绝:includeIf → unreadable 且 spawn 次数 = 0(含「假旧版 git:忽略 GIT_NO_LAZY_FETCH 并对缺失对象尝试抓取」的场景)',
    ],
    restored: true,
  },
  {
    id: 'leak_extra_empty',
    failed: 3,
    skipped: 0,
    killedBy: [
      '泄漏闸的禁止值来自端口(生产组装注入;HOME 外的仓库根 / 状态目录 / realpath) HOME 外的仓库根 / 状态目录出现在正文 → 退 3 output_leak,stdout 零字节;正文不含这些路径 → 正常输出(正向对照)',
      '泄漏闸的禁止值来自端口(生产组装注入;HOME 外的仓库根 / 状态目录 / realpath) 禁止值的 realpath 同样拦:端口给符号链接路径、正文含其真实路径 → 退 3,stdout 零字节',
      '泄漏闸的禁止值来自端口(生产组装注入;HOME 外的仓库根 / 状态目录 / realpath) 经 emitLines 的其它命令(status)同用端口的禁止值',
    ],
    restored: true,
  },
  {
    id: 'status_trunc_keys_dropped',
    failed: 4,
    skipped: 0,
    killedBy: [
      '键集合与文本 / JSON 形状 --json:顶层键与 auto 下的键集合固定;缺失视图时派生键为 null,退 0',
      '视图截断(JSON):截断标志不丢,缺失 / 损坏为 null 而不是 false fresh + rolling_back_truncated=true + 可见条目都有 journal → rollback_stalled 为 [],但 rollback_stalled_truncated 为 true(分得清「没有」与「被截断」)',
      '视图截断(JSON):截断标志不丢,缺失 / 损坏为 null 而不是 false protection_marks_truncated 独立于 rolling_back_truncated;未截断的 fresh 视图两个键都是 false',
      '视图截断(JSON):截断标志不丢,缺失 / 损坏为 null 而不是 false 视图缺失 / 损坏 → 两个截断键都是 null(不是 false);文本不出现截断提示',
    ],
    restored: true,
  },
  {
    id: 'status_trunc_null_as_false',
    failed: 2,
    skipped: 0,
    killedBy: [
      '键集合与文本 / JSON 形状 --json:顶层键与 auto 下的键集合固定;缺失视图时派生键为 null,退 0',
      '视图截断(JSON):截断标志不丢,缺失 / 损坏为 null 而不是 false 视图缺失 / 损坏 → 两个截断键都是 null(不是 false);文本不出现截断提示',
    ],
    restored: true,
  },
  {
    id: 'untrusted_cfg_as_off',
    failed: 4,
    skipped: 0,
    killedBy: [
      '配置不可信 → 所有读命令在输出之前 fail-closed(退 3,stdout 零字节) cfg_parse:6 个读命令都退 3 RSI_FAIL_CLOSED reason=cfg_parse,stdout 为空',
      '配置不可信 → 所有读命令在输出之前 fail-closed(退 3,stdout 零字节) cfg_schema:6 个读命令都退 3 RSI_FAIL_CLOSED reason=cfg_schema,stdout 为空',
      '配置不可信 → 所有读命令在输出之前 fail-closed(退 3,stdout 零字节) repo_invalid(repo 在 HOME 之外且不存在):6 个读命令都退 3 RSI_FAIL_CLOSED reason=repo_invalid,stdout 为空',
      '配置不可信 → 所有读命令在输出之前 fail-closed(退 3,stdout 零字节) cfg_perm:6 个读命令都退 3 RSI_FAIL_CLOSED reason=cfg_perm,stdout 为空',
    ],
    restored: true,
  },
  {
    id: 'explicit_root_dropped',
    failed: 2,
    skipped: 0,
    killedBy: [
      '禁止集合(端口 outputForbidden) 合法关闭(absent / no_section / disabled):照常组装,显式 --root(相对路径按 cwd 解析)进入集合',
      '禁止集合(端口 outputForbidden) forbiddenExtra 不静默丢项:配置 on 而没有 io / 缺状态目录 / 缺仓库根 → 抛 fail-closed;explicitRoot 是唯一可选来源',
    ],
    restored: true,
  },
  {
    id: 'forbidden_extra_silent',
    failed: 1,
    skipped: 0,
    killedBy: [
      '禁止集合(端口 outputForbidden) forbiddenExtra 不静默丢项:配置 on 而没有 io / 缺状态目录 / 缺仓库根 → 抛 fail-closed;explicitRoot 是唯一可选来源',
    ],
    restored: true,
  },
];
