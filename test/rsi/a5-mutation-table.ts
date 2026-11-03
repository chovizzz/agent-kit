/**
 * R20-A5 必杀变异(契约 §20.15 R20-15.33 + A5 自己加的几条):每条变异后必须有测试红,且只红该条款自己的杀手用例。
 * 执行方式同 A3 / A4(`a4-mutation-table.ts`):javis 私有检出里 cp 备份 → 按锚点替换(每个锚点在对应文件里**恰好出现一次**)→ 跑 `tests` →
 * 失败集合非空、全部命中 `expectRed`、`mustKill` 每项至少命中一个、没有 skipped → cp 还原并逐文件 sha256 核对。**不用 git checkout / stash 还原**。
 * 本文件只写表与每条变异期望红的测试名(`expectRed` 是测试标题 / 源码里的字面子串);变异由主代理在 javis 上执行,结果记进 `A5_RESULTS`
 * (同 A4_RESULTS 的形状;A5 实装块不执行变异,故留空)。
 * 契约 R20-15.33 的 8 个变异点与本表 id 的对应:
 *   去掉格式保真闸 → remove-canonical-gate;去掉提交前复核 → remove-precommit-recheck;卸载改为按命令串删除 → uninstall-by-command-string;
 *   通用 home-fs 可写 kit-hooks → generic-home-fs-writes-kit-hooks;忽略包装差异 → ignore-wrapper-differences;失锁仍提交 → lock-lost-still-commits;
 *   账本未提交却返回成功 → ledger-not-committed-returns-success;确认后静默重规划 → silent-replan-after-confirm。
 *   另加:残留 aborted 优先、删 journal 前 ensureLedgerDurable、bootstrap 标记、restore 的 after 哈希 / 最新事务限制、受保护备份、generation、
 *   同 txn_id 只生效一次、pi 外来文件、agent 根检查、形状核实闸、本地重复检测、各类 tmp 的清理、硬链接目标。
 */
export interface Edit {
  file: string;
  anchor: string;
  replacement: string;
}

export interface A5Mutation {
  id: string;
  /** 契约里的变异点原文 */
  clause: string;
  edits: readonly Edit[];
  /** 相对 `test/` */
  tests: readonly string[];
  expectRed: readonly string[];
  mustKill: readonly string[];
}

export interface A5Result {
  id: string;
  failed: number;
  skipped: number;
  killedBy: readonly string[];
  restored: boolean;
}

const INSTALL = 'rsi/hooks/a5-install.test.ts';
const CRASH = 'rsi/hooks/a5-crash.test.ts';
const GATE = 'rsi/hooks/a5-gate.test.ts';
const ZERO = 'rsi/hooks/a5-zero-write.test.ts';

export const A5_MUTATIONS: readonly A5Mutation[] = [
  {
    id: 'remove-canonical-gate',
    clause: '去掉格式保真闸',
    edits: [
      {
        file: 'src/rsi/hooks/plan.ts',
        anchor: "if (!c.ok) return reject('config_not_canonical');",
        replacement: 'void 0;',
      },
    ],
    tests: [INSTALL],
    expectRed: ['紧凑格式', '4 空格缩进', 'CRLF'],
    mustKill: ['紧凑格式'],
  },
  {
    id: 'remove-precommit-recheck',
    clause: '去掉提交前复核',
    edits: [
      {
        file: 'src/io/hooks-fs.ts',
        anchor: 'if ((cur !== null) !== expect.exists || curSha !== expect.sha256) {',
        replacement: 'if (false) {',
      },
    ],
    tests: [CRASH],
    expectRed: ['提交前被改'],
    mustKill: ['提交前被改'],
  },
  {
    id: 'uninstall-by-command-string',
    clause: '卸载改为按命令串删除',
    edits: [
      {
        file: 'src/rsi/hooks/plan.ts',
        anchor: 'const ps = count.get(o.fingerprint) ?? [];',
        replacement: 'const ps = present.filter((p) => p.event === o.event);',
      },
      {
        file: 'src/rsi/hooks/plan.ts',
        anchor: 'isObj(el) && entryFingerprint(op.event, el) === op.entry_fingerprint ? k : -1,',
        replacement: 'isObj(el) && hasKitCommand(el) ? k : -1,',
      },
    ],
    tests: [INSTALL],
    expectRed: ['按命令串删除是错的', '用户混入了自己的钩子到 kit 包装对象'],
    mustKill: ['按命令串删除是错的'],
  },
  {
    id: 'generic-home-fs-writes-kit-hooks',
    clause: '通用 home-fs 可写 kit-hooks',
    edits: [
      {
        file: 'src/io/home-fs.ts',
        anchor:
          'assertSyntax(rel);\n  if (isKitHooksReserved(rel)) throw new HomeWriteDeniedError(HOME_DENY.KIT_HOOKS, rel);\n  if (inSnapshot(rel) && isHomeWritePath(rel)) return;',
        replacement: 'assertSyntax(rel);\n  if (inSnapshot(rel) && isHomeWritePath(rel)) return;',
      },
      {
        file: 'src/io/home-fs.ts',
        anchor:
          "assertSyntax(rel);\n  if (isKitHooksReserved(rel)) throw new HomeWriteDeniedError(HOME_DENY.KIT_HOOKS, rel);\n  for (const e of TABLE) {\n    if (e.kind !== 'dir') continue;\n    if (rel === e.path.slice(0, -1)) throw new HomeWriteDeniedError(HOME_DENY.DIR_ITSELF, rel);\n    if (rel.startsWith(e.path)) {",
        replacement:
          "assertSyntax(rel);\n  for (const e of TABLE) {\n    if (e.kind !== 'dir') continue;\n    if (rel === e.path.slice(0, -1)) throw new HomeWriteDeniedError(HOME_DENY.DIR_ITSELF, rel);\n    if (rel.startsWith(e.path)) {",
      },
      // 再把「可写」的另外三道也翻掉,让三个目标真的变得可写(而不只是错误码从 KIT_HOOKS 变成 NOT_IN_TABLE)
      {
        file: 'src/io/home-fs.ts',
        anchor: "if (e.owner === 'kit-hooks') return false;",
        replacement: 'void 0;',
      },
      {
        file: 'src/io/home-fs.ts',
        anchor: "case 'json-merge':\n        return false;",
        replacement: "case 'json-merge':\n        return rel === e.path;",
      },
      {
        file: 'src/contracts/sync.ts',
        anchor: "if (owner === undefined && e.owner === 'kit-hooks') return false;",
        replacement: 'void 0;',
      },
    ],
    tests: [GATE],
    expectRed: [
      'writeFile / remove / createExclusive / chmod / rename / copyFile 两端都拒',
      'mkdirp / removeDir / renameDir 对 hooks/ 子树的目录一律拒',
    ],
    mustKill: ['writeFile / remove / createExclusive / chmod / rename / copyFile 两端都拒'],
  },
  {
    id: 'ignore-wrapper-differences',
    clause: '忽略包装差异',
    edits: [
      {
        file: 'src/rsi/hooks/plan.ts',
        anchor:
          "for (const p of present) if (!knownFps.has(p.fingerprint)) return reject('foreign_kit_entry');",
        replacement: 'void present;',
      },
    ],
    tests: [INSTALL],
    expectRed: [
      '混合包装',
      '同命令不同 matcher',
      '用户在 kit 条目上加了字段',
      '命令前缀是 agent-kit rsi 却不在形状表里',
    ],
    mustKill: ['混合包装'],
  },
  {
    id: 'lock-lost-still-commits',
    clause: '失锁仍提交',
    edits: [
      {
        file: 'src/rsi/hooks/command.ts',
        anchor: 'await held.assertHeld();',
        replacement: 'void held;',
      },
    ],
    tests: [CRASH],
    expectRed: ['新建(文件不存在)', '合并(已有用户配置 + 备份)', '卸载:同样的矩阵'],
    mustKill: ['新建(文件不存在)'],
  },
  {
    id: 'ledger-not-committed-returns-success',
    clause: '账本未提交却返回成功',
    edits: [
      {
        file: 'src/rsi/hooks/txn.ts',
        anchor: "await commitJournalLedger(env, journal, 'change');",
        replacement: 'void journal;',
      },
    ],
    tests: [INSTALL],
    expectRed: ['提交整个事务'],
    mustKill: ['提交整个事务'],
  },
  {
    id: 'silent-replan-after-confirm',
    clause: '确认后静默重规划',
    edits: [
      {
        file: 'src/rsi/hooks/command.ts',
        anchor:
          "if (canonicalJson(second.plan) !== canonicalJson(first.plan)) throw notRun('stale_plan');\n      if (second.plan.ops.length === 0) {",
        replacement: '\n      if (second.plan.ops.length === 0) {',
      },
    ],
    tests: [CRASH],
    expectRed: [
      '残留处理未写任何东西时的 stale_plan',
      '残留处理写过东西,随后本次计划被拒(stale_plan)',
    ],
    mustKill: ['残留处理未写任何东西时的 stale_plan'],
  },
  {
    id: 'residue-aborted-not-first',
    clause: '残留处理先看 journal 状态,aborted 优先(R20-15.22)',
    edits: [
      {
        file: 'src/rsi/hooks/txn.ts',
        anchor: "if (j.state === 'aborted') return finishAborted(env, j);",
        replacement: 'void 0;',
      },
    ],
    tests: [CRASH],
    expectRed: ['aborted 的 bootstrap journal(标记在、账本缺)'],
    mustKill: ['aborted 的 bootstrap journal(标记在、账本缺)'],
  },
  {
    id: 'skip-ledger-durable-before-journal-delete',
    clause: '删除任何 journal 之前先 ensureLedgerDurable(R20-15.21)',
    edits: [
      {
        file: 'src/rsi/hooks/txn.ts',
        anchor: 'await env.fs.ensureLedgerDurable();\n  await env.fs.deleteJournal(id);',
        replacement: 'await env.fs.deleteJournal(id);',
      },
    ],
    tests: [INSTALL],
    expectRed: ['提交整个事务'],
    mustKill: ['提交整个事务'],
  },
  {
    id: 'bootstrap-marker-skipped',
    clause: '首个 commitLedger 的 rename 之前独占创建 ledger.established 标记并 fsync(R20-15.21)',
    edits: [
      {
        file: 'src/rsi/hooks/txn.ts',
        anchor:
          "await env.fs.createLedgerMarker();\n    await inject(env, 'ledger_marker_created');",
        replacement: '',
      },
    ],
    tests: [INSTALL, CRASH],
    expectRed: ['提交整个事务', '进行中 + 目标 = after'],
    mustKill: ['提交整个事务'],
  },
  {
    id: 'restore-skip-after-check',
    clause: 'restore 前提:当前文件哈希 = 该事务的 after(R20-15.23)',
    edits: [
      {
        file: 'src/rsi/hooks/txn.ts',
        anchor:
          "if (!is(cur, rec.after_exists, rec.after_sha256)) throw notRun('config_changed_since_install');",
        replacement: 'void cur;',
      },
    ],
    tests: [CRASH],
    expectRed: ['当前文件已被改(≠ 该事务的 after)'],
    mustKill: ['当前文件已被改(≠ 该事务的 after)'],
  },
  {
    id: 'restore-any-txn',
    clause: 'restore 只能恢复该目标上最新一个已提交事务(R20-15.23)',
    edits: [
      {
        file: 'src/rsi/hooks/txn.ts',
        anchor: 'const rec = latestCommitted(st.ledger, agent);',
        replacement: 'const rec = st.ledger.applied_txns.find((t) => t.txn_id === sourceTxn);',
      },
    ],
    tests: [CRASH],
    expectRed: ['都使旧事务不可恢复'],
    mustKill: ['都使旧事务不可恢复'],
  },
  {
    id: 'hardlink-target-accepted',
    clause: '读取:目标 nlink == 1(R20-15.14)',
    edits: [
      {
        file: 'src/io/hooks-fs.ts',
        anchor: '!st.isFile() ||\n        st.nlink !== 1 ||',
        replacement: '!st.isFile() ||\n        false ||',
      },
    ],
    tests: [INSTALL],
    expectRed: ['目标是符号链接 / 硬链接 / 组可写 / 属主不符 / 超过 1 MiB'],
    mustKill: ['目标是符号链接 / 硬链接 / 组可写 / 属主不符 / 超过 1 MiB'],
  },
  {
    id: 'prune-unprotects-latest',
    clause: '受保护备份(每个目标最新已提交事务)不修剪(R20-15.24)',
    edits: [
      {
        file: 'src/rsi/hooks/txn.ts',
        anchor: 'if (r !== undefined) protectedIds.add(r.txn_id);',
        replacement: 'void r;',
      },
    ],
    tests: [CRASH],
    expectRed: [
      '受保护备份(每个目标最新一个已提交事务)不计入',
      '30 个 UTC 日:过期的非受保护备份被修剪,受保护备份即使过期也留着',
    ],
    mustKill: ['受保护备份(每个目标最新一个已提交事务)不计入'],
  },
  {
    id: 'generation-not-bumped',
    clause: 'generation 在任何成功事务后加 1(R20-15.29)',
    edits: [
      {
        file: 'src/rsi/hooks/ledger.ts',
        anchor:
          "const bump = c.record.status === 'applied' || c.record.status === 'discarded' ? 1 : 0;",
        replacement: 'const bump = 0;',
      },
    ],
    tests: [INSTALL],
    expectRed: ['提交整个事务'],
    mustKill: ['提交整个事务'],
  },
  {
    id: 'txn-not-idempotent',
    clause: '账本记 applied_txns,同一 txn_id 只生效一次(R20-15.21)',
    edits: [
      {
        file: 'src/rsi/hooks/ledger.ts',
        anchor: 'if (hasTxn(l, c.record.txn_id)) return l;',
        replacement: 'void 0;',
      },
    ],
    tests: [CRASH],
    expectRed: ['账本已提交、journal 未删(崩溃于 ledger_committed)'],
    mustKill: ['账本已提交、journal 未删(崩溃于 ledger_committed)'],
  },
  {
    id: 'pi-overwrites-foreign-file',
    clause: 'pi:同名文件已存在而账本无归属 → 不覆盖(R20-15.13)',
    edits: [
      {
        file: 'src/rsi/hooks/plan.ts',
        anchor:
          "if (own === undefined) return reject('foreign_kit_entry'); // 同名文件存在而账本无归属:不覆盖",
        replacement: 'void own;',
      },
    ],
    tests: [INSTALL],
    expectRed: ['pi 外来文件'],
    mustKill: ['pi 外来文件'],
  },
  {
    id: 'skip-agent-root-check',
    clause: 'agent 根不存在 → 退 4 agent_not_installed,kit 不替 agent 建根目录(R20-15.14)',
    edits: [
      {
        file: 'src/rsi/hooks/command.ts',
        anchor:
          "if (!(await (fs as HooksFs).agentRootExists(agent))) throw notRun('agent_not_installed');",
        replacement: 'void 0;',
      },
    ],
    tests: [INSTALL],
    expectRed: ['agent 根不存在 → 4 agent_not_installed'],
    mustKill: ['agent 根不存在 → 4 agent_not_installed'],
  },
  {
    id: 'shape-gate-removed',
    clause: '形状核实是写能力的闸:未核实 → --install --write 退 4 shape_unverified(R20-15.9)',
    edits: [
      {
        file: 'src/rsi/hooks/command.ts',
        anchor:
          "if (kind === 'install' && p.write && snap.verified !== true) throw notRun('shape_unverified');",
        replacement: 'void 0;',
      },
    ],
    tests: [INSTALL, ZERO],
    expectRed: ['生产形状表三家都是「假设」', '四种证据级别'],
    mustKill: ['生产形状表三家都是「假设」'],
  },
  {
    id: 'local-duplicate-check-removed',
    clause: '只读重复检测:settings.local.json 里已有同形状 → duplicate_in_local(R20-15.27)',
    edits: [
      {
        file: 'src/rsi/hooks/command.ts',
        anchor:
          "if (kind === 'install' && shape.kind === 'json-merge' && shape.local_duplicate_rel !== null) {",
        replacement: 'if (false) {',
      },
    ],
    tests: [INSTALL],
    expectRed: ['settings.local.json 里已有同形状'],
    mustKill: ['settings.local.json 里已有同形状'],
  },
  {
    id: 'stray-tmp-not-removed',
    clause: '残留处理开始时先删 txn/ 下的 *.tmp(R20-15.21)',
    edits: [
      {
        file: 'src/rsi/hooks/txn.ts',
        anchor: 'await env.fs.removeStrayTmps();',
        replacement: 'void 0;',
      },
    ],
    tests: [CRASH],
    expectRed: ['残留的 journal tmp / 账本 tmp / 目标 tmp 都有出口'],
    mustKill: ['残留的 journal tmp / 账本 tmp / 目标 tmp 都有出口'],
  },
  {
    id: 'target-tmp-not-removed',
    clause: '目标 tmp 由 txn_id 推导,残留处理按名字清理',
    edits: [
      {
        file: 'src/rsi/hooks/txn.ts',
        anchor: 'await env.fs.removeTargetTmp(j.agent, id);',
        replacement: 'void 0;',
      },
    ],
    tests: [CRASH],
    expectRed: ['残留的 journal tmp / 账本 tmp / 目标 tmp 都有出口'],
    mustKill: ['残留的 journal tmp / 账本 tmp / 目标 tmp 都有出口'],
  },
  {
    id: 'journal-semantics-unchecked',
    clause:
      'journal 里的任何路径 / 标识都不作为读写依据;与固定推导不符 → hooks_ledger_invalid(R20-15.21a)',
    edits: [
      {
        file: 'src/rsi/hooks/txn.ts',
        anchor:
          "if (j.txn_id !== id || !journalConsistent(j)) throw failClosed('hooks_ledger_invalid');",
        replacement: "if (j.txn_id !== id) throw failClosed('hooks_ledger_invalid');",
      },
    ],
    tests: [CRASH],
    expectRed: ['伪造 journal'],
    mustKill: ['伪造 journal'],
  },
  {
    id: 'prune-set-widened-after-confirm',
    clause: '确认绑定计划:锁内重算与展示不同 → stale_plan(R20-15.19;手动 prune 同样)',
    edits: [
      {
        file: 'src/rsi/hooks/command.ts',
        anchor: 'if (second.length !== first.length || second.some((id, i) => id !== first[i])) {',
        replacement: 'if (false) {',
      },
    ],
    tests: [CRASH],
    expectRed: ['锁内重算的集合变了'],
    mustKill: ['锁内重算的集合变了'],
  },
  {
    id: 'case-alias-not-reserved',
    clause: '通用 home-fs 对 hooks/ 私有状态子树一律拒绝,大小写别名不得绕过(R20-15.6)',
    edits: [
      {
        file: 'src/contracts/sync.ts',
        anchor: 'const lower = rel.toLowerCase();',
        replacement: 'const lower = rel;',
      },
    ],
    tests: [GATE],
    expectRed: [
      'createHomeFsContext:planScope 里放 kit-hooks 路径',
      'writeFile / remove / createExclusive / chmod / rename / copyFile 两端都拒',
    ],
    mustKill: ['writeFile / remove / createExclusive / chmod / rename / copyFile 两端都拒'],
  },
  {
    id: 'target-tmp-cleanup-follows-links',
    clause: '残留处理按 txn_id 清理目标 tmp 前,先按目标安全协议校验祖先(R20-15.14)',
    edits: [
      {
        file: 'src/io/hooks-fs.ts',
        anchor:
          "if (w.leaf === null) return false;\n    this.checkPlainDir(w.leaf, 'target', dirSegs.join('/'));\n    const st = await this.lstatOrNull(t.abs, 'target');",
        replacement: "void w;\n    const st = await this.lstatOrNull(t.abs, 'target');",
      },
    ],
    tests: [CRASH],
    expectRed: ['目标 tmp 清理先校验父目录'],
    mustKill: ['目标 tmp 清理先校验父目录'],
  },
  {
    id: 'idempotent-shortcut-skips-stray-tmp',
    clause: '残留处理开始时先删 txn/ 下的 *.tmp:只有 tmp 时幂等命令也要进入锁内清理(R20-15.21)',
    edits: [
      {
        file: 'src/rsi/hooks/txn.ts',
        anchor:
          'return (await env.fs.listTxnDir()).journals.length > 0 || (await env.fs.hasStrayTmps());',
        replacement: 'return (await env.fs.listTxnDir()).journals.length > 0;',
      },
    ],
    tests: [CRASH],
    expectRed: ['只有残留 tmp、没有 journal'],
    mustKill: ['只有残留 tmp、没有 journal'],
  },
];

/** 主代理在 javis 上执行变异后填写(形状同 A4_RESULTS);A5 实装块不执行变异 */
export const A5_RESULTS: readonly A5Result[] = [];
