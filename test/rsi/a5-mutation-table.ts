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
    expectRed: [
      '紧凑格式',
      '4 空格缩进',
      'CRLF',
      // 2026-11-02 javis 变异实测补登:同一变异多红的相关用例(只补登记,不改变异与用例)
      'config_not_canonical',
    ],
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
      // 2026-11-02 javis 变异实测补登:同一变异多红的相关用例(只补登记,不改变异与用例)
      'createHomeFsContext:planScope 里放 kit-hooks 路径 → SCOPE_INVALID',
      '三条 kit-hooks(json-merge ×2、file ×1),总数 15;无 owner 的 isHomeWritePath 不把它们算作受管路径',
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
      // 2026-11-02 javis 变异实测补登:同一变异多红的相关用例(只补登记,不改变异与用例)
      ' → foreign_kit_entry',
      '按命令串删除是错的:用户把 kit 包装对象改了(加字段)→ config_changed_since_install,不删',
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
    expectRed: [
      '新建(文件不存在)',
      '合并(已有用户配置 + 备份)',
      '卸载:同样的矩阵',
      // 2026-11-02 javis 变异实测补登:同一变异多红的相关用例(只补登记,不改变异与用例)
      '只有残留 tmp、没有 journal:幂等安装 / 空 prune 不走快捷返回,锁内清理(journal tmp 与 ledger tmp)',
      '残留的 journal tmp / 账本 tmp / 目标 tmp 都有出口:恢复时按 txn_id 与固定名字清理',
      '目标事务已完成而顺带修剪失败 → 仍 committed、退 0,stderr 一行 RSI_HOOKS_WARN,maintenance=partial;下次修剪按无害方向补完',
      '维护写入的 rename 之后失败(失锁)也按实际阶段记 maintenance=partial(discard)',
    ],
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
    expectRed: [
      '提交整个事务',
      // 2026-11-02 javis 变异实测补登:同一变异多红的相关用例(只补登记,不改变异与用例)
      'pi 内容漂移:有记录但被改过 → 卸载 / 重装都拒(config_changed_since_install)',
      'pi:独立文件(不合并),extensions/ 以 0700 建在已存在的 agent 根之下;账本记整文件指纹',
      'plain → canary:remove + add 同一事务;再迁回',
      '卸载 / restore 不看形状核实(只动账本登记过的节点),生产形状表下也能卸掉之前装的',
      '按命令串删除是错的:用户把 kit 包装对象改了(加字段)→ config_changed_since_install,不删',
      '用户内容不动,kit 节点移除;备份整份;账本归属清空',
      '用户混入了自己的钩子到 kit 包装对象 → 不删包装对象(config_changed_since_install)',
      '空对象 {} 也能装;卸载后留下空数组 / 空对象(精确还原归 --restore)',
      '非 kit 节点的字节片段在新文件里与原文件逐字相同;权限沿用原文件;备份只在私有备份文件里含秘密哨兵',
    ],
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
    expectRed: [
      'aborted 的 bootstrap journal(标记在、账本缺)',
      // 2026-11-02 javis 变异实测补登:同一变异多红的相关用例(只补登记,不改变异与用例)
      '④ 本次目标未提交:提交前被改(config_changed_during_write)→ journal 记 aborted、备份保留、临时文件已删、对方的改动不丢',
    ],
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
    expectRed: [
      '提交整个事务',
      '进行中 + 目标 = after',
      // 2026-11-02 javis 变异实测补登:同一变异多红的相关用例(只补登记,不改变异与用例)
      '--discard-residue 只接管所选的那一个;非「第三种值」/ 不存在 / 别的 agent 的 journal → 退 4 residue_not_discardable,不记 discarded',
      '30 个 UTC 日:过期的非受保护备份被修剪,受保护备份即使过期也留着;干跑只列 id 与数量',
      'aborted 的 bootstrap journal(标记在、账本缺)→ 提交只记 aborted 的空账本,再删 journal',
      'discarding(--discard-residue 在 journal 改记后崩溃)→ 下一次任何 --write 补完:只提交 discarded 记录,不提交原计划归属',
      'pi 内容漂移:有记录但被改过 → 卸载 / 重装都拒(config_changed_since_install)',
      'pi:独立文件(不合并),extensions/ 以 0700 建在已存在的 agent 根之下;账本记整文件指纹',
      'plain → canary:remove + add 同一事务;再迁回',
      'restore 一个 restore 也是合法的(它是新的最新已提交事务)',
      'restore 的备份回退点:崩溃于 target_renamed 后恢复收敛(账本逆变更只生效一次)',
      'settings.local.json 里已有同形状 → duplicate_in_local(干跑也拒);读不了 / 不可解析 → duplicate_check_failed;只挡安装不挡卸载',
      'txn/ 换成符号链接 → 不跟随:残留处理读不了 txn/,退 3 hooks_ledger_invalid(等级 lock_only,零后继写)',
      '⑤ 目标已提交、事务待恢复:rename 之后失败(账本 / journal 清理未完成)→ 目标已是 after,下一次 --write 补完',
      '之后有任何事务(卸载 / discarded)都使旧事务不可恢复;不存在的 id 同码',
      '写前不存在 → 受保护的删除;恢复后目标消失、归属回到事务之前',
      '卸载 / restore 不看形状核实(只动账本登记过的节点),生产形状表下也能卸掉之前装的',
      '卸载:同样的矩阵,收敛后账本归属为空、目标里没有 kit 节点',
      '受保护备份(每个目标最新一个已提交事务)不计入、不受 10 份上限约束;其余最多 10 份',
      '只有残留 tmp、没有 journal:幂等安装 / 空 prune 不走快捷返回,锁内清理(journal tmp 与 ledger tmp)',
      '只能恢复该目标上最新一个已提交事务:放回备份字节、权限;账本逆变更;源事务记 restored;自身是事务',
      '备份区出现不认识的名字 → hooks_backup_invalid',
      '备份损坏 / 被换成链接 / 宽权限 → 退 3 hooks_backup_invalid,零写调用',
      '合并(已有用户配置 + 备份)',
      '新建(文件不存在)',
      'target_unwritten',
      'journal_deleted',
      'target_unwritten',
      'target_written_pending',
      'target_written_pending',
      'target_before_write',
      'target_written_pending',
      '幂等:再装一次 = unchanged,零写调用(连锁文件都不碰),账本不变',
      '当前文件已被改(≠ 该事务的 after)→ config_changed_since_install,零写调用',
      '手动 prune:确认之后、锁内重算的集合变了 → stale_plan,不删用户没确认过的备份',
      '按命令串删除是错的:用户把 kit 包装对象改了(加字段)→ config_changed_since_install,不删',
      '改记 aborted 之后、空账本提交之前再次崩溃 → 再下一次恢复照常:空账本只记 aborted(无归属、generation 不动)',
      '标记在、账本缺、没有 bootstrap journal → 退 3 hooks_ledger_invalid(不重建、不猜);账本在而标记缺同样',
      '残留的 journal tmp / 账本 tmp / 目标 tmp 都有出口:恢复时按 txn_id 与固定名字清理',
      '用户内容不动,kit 节点移除;备份整份;账本归属清空',
      '用户混入了自己的钩子到 kit 包装对象 → 不删包装对象(config_changed_since_install)',
      '目标事务已完成而顺带修剪失败 → 仍 committed、退 0,stderr 一行 RSI_HOOKS_WARN,maintenance=partial;下次修剪按无害方向补完',
      '空对象 {} 也能装;卸载后留下空数组 / 空对象(精确还原归 --restore)',
      '维护写入的 rename 之后失败(失锁)也按实际阶段记 maintenance=partial(discard)',
      '节点已被用户删掉:无可卸 = unchanged;账本不变',
      '账本已提交、journal 未删(崩溃于 ledger_committed)→ 恢复时先 ensureLedgerDurable(fsync 账本文件与目录)再删 journal;不重写账本',
      '进行中 + 目标 = before → 先改记 aborted,再提交只记 aborted 的空账本,然后才删 journal;之后正常安装',
      '进行中 + 目标是第三种值 → 退 4 txn_residue_unknown,不建账本、不动目标,journal 原样保留(等级 lock_only)',
      '追加后会超过 1 MiB → config_shape_unsupported,零写调用,文件不动;留有余量则照常安装',
    ],
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
      // 2026-11-02 javis 变异实测补登:同一变异多红的相关用例(只补登记,不改变异与用例)
      '目标事务已完成而顺带修剪失败 → 仍 committed、退 0,stderr 一行 RSI_HOOKS_WARN,maintenance=partial;下次修剪按无害方向补完',
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
    expectRed: [
      '提交整个事务',
      // 2026-11-02 javis 变异实测补登:同一变异多红的相关用例(只补登记,不改变异与用例)
      'plain → canary:remove + add 同一事务;再迁回',
      '空对象 {} 也能装;卸载后留下空数组 / 空对象(精确还原归 --restore)',
    ],
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
    expectRed: [
      '账本已提交、journal 未删(崩溃于 ledger_committed)',
      // 2026-11-02 javis 变异实测补登:同一变异多红的相关用例(只补登记,不改变异与用例)
      '卸载:同样的矩阵,收敛后账本归属为空、目标里没有 kit 节点',
      '合并(已有用户配置 + 备份)',
      '新建(文件不存在)',
      'target_written_pending',
    ],
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
    expectRed: [
      '生产形状表三家都是「假设」',
      '四种证据级别',
      // 2026-11-02 javis 变异实测补登:同一变异多红的相关用例(只补登记,不改变异与用例)
      'hooks --install --agent claude',
      'hooks --install --agent c',
      'hooks --install --agent ',
      '适用的 agent 版本范围:区间内放行;区间外 / 版本未知 / 无法解析 → shape_unverified(fail closed)',
    ],
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
    expectRed: [
      'settings.local.json 里已有同形状',
      // 2026-11-02 javis 变异实测补登:同一变异多红的相关用例(只补登记,不改变异与用例)
      'settings.local.json 的检测要严格:重复键 / 非 UTF-8 / 目标事件不是数组 → duplicate_check_failed(不当作未发现)',
      '不读项目 cwd、不输出冲突条目全文:拒绝信息只有稳定码',
    ],
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
    expectRed: [
      '残留的 journal tmp / 账本 tmp / 目标 tmp 都有出口',
      // 2026-11-02 javis 变异实测补登:同一变异多红的相关用例(只补登记,不改变异与用例)
      '只有残留 tmp、没有 journal:幂等安装 / 空 prune 不走快捷返回,锁内清理(journal tmp 与 ledger tmp)',
      '合并(已有用户配置 + 备份)',
      '新建(文件不存在)',
    ],
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
    expectRed: [
      '残留的 journal tmp / 账本 tmp / 目标 tmp 都有出口',
      // 2026-11-02 javis 变异实测补登:同一变异多红的相关用例(只补登记,不改变异与用例)
      '卸载:同样的矩阵,收敛后账本归属为空、目标里没有 kit 节点',
      '合并(已有用户配置 + 备份)',
      '新建(文件不存在)',
    ],
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
      // 2026-11-02 javis 变异实测补登:同一变异多红的相关用例(只补登记,不改变异与用例)
      '三条 kit-hooks(json-merge ×2、file ×1),总数 15;无 owner 的 isHomeWritePath 不把它们算作受管路径',
    ],
    mustKill: ['writeFile / remove / createExclusive / chmod / rename / copyFile 两端都拒'],
  },
  {
    id: 'target-tmp-cleanup-follows-links',
    clause: '残留处理按 txn_id 清理目标 tmp 前,先按目标安全协议校验祖先(R20-15.14)',
    edits: [
      {
        file: 'src/io/hooks-fs.ts',
        // 2026-11-02 javis 实测:只去叶子检查时 walk 仍拒链接,变异存活;改为去掉整段祖先校验
        anchor:
          "const w = await this.walk(dirSegs, 'target', Number.MAX_SAFE_INTEGER);\n    if (w.leaf === null) return false;\n    this.checkPlainDir(w.leaf, 'target', dirSegs.join('/'));\n    const st = await this.lstatOrNull(t.abs, 'target');",
        replacement: "void dirSegs;\n    const st = await this.lstatOrNull(t.abs, 'target');",
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
  {
    id: 'safe-fs-writes-kit-hooks',
    clause: '主代理验收评审补:普通写出口 safe-fs 可写 kit-hooks 保留路径(§20.15-11 第 3 条)',
    edits: [
      {
        file: 'src/io/safe-fs.ts',
        anchor: 'assertNotKitHooks(real, abs, opts.subtree === true);',
        replacement: 'void assertNotKitHooks;',
      },
    ],
    tests: ['io/safe-fs-kit-hooks.test.ts'],
    expectRed: ['私有子树时', '大小写别名', '递归删除', 'kit-hooks 目标文件'],
    mustKill: ['私有子树时', '递归删除'],
  },
];

/** 主代理在 javis 上执行变异后填写(形状同 A4_RESULTS);A5 实装块不执行变异 */
export const A5_RESULTS: readonly A5Result[] = [
  // 2026-11-03 javis 私有检出 @ 16b384f:基线 141 例全绿、0 skipped;29 条变异全部被杀、无 skipped / 套件错误,每条还原后逐文件 sha256 一致;
  // javis HOME 下 .local/state/agent-kit、.claude/settings.json、.codex/hooks.json、.pi/agent/extensions 前后不变。首轮 15 条多红了表外相关用例(已补登 expectRed),
  // target-tmp-cleanup-follows-links 首轮存活(变异只去了叶子检查,walk 仍拒链接),已加强为去掉整段祖先校验后被杀。
  {
    id: 'remove-canonical-gate',
    killedBy: [
      '4 空格缩进 → config_not_canonical',
      'CRLF → config_not_canonical',
      '两个末尾换行 → config_not_canonical',
      '紧凑格式 → config_not_canonical',
    ],
    failed: 4,
    skipped: 0,
    restored: true,
  },
  {
    id: 'remove-precommit-recheck',
    killedBy: [
      '④ 本次目标未提交:提交前被改(config_changed_during_write)→ journal 记 aborted、备份保留、临时文件已删、对方的改动不丢',
    ],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'uninstall-by-command-string',
    killedBy: [
      '按命令串删除是错的:用户把 kit 包装对象改了(加字段)→ config_changed_since_install,不删',
      '用户混入了自己的钩子到 kit 包装对象 → 不删包装对象(config_changed_since_install)',
    ],
    failed: 2,
    skipped: 0,
    restored: true,
  },
  {
    id: 'generic-home-fs-writes-kit-hooks',
    killedBy: [
      'createHomeFsContext:planScope 里放 kit-hooks 路径 → SCOPE_INVALID',
      'mkdirp / removeDir / renameDir 对 hooks/ 子树的目录一律拒',
      'writeFile / remove / createExclusive / chmod / rename / copyFile 两端都拒',
      '三条 kit-hooks(json-merge ×2、file ×1),总数 15;无 owner 的 isHomeWritePath 不把它们算作受管路径',
    ],
    failed: 4,
    skipped: 0,
    restored: true,
  },
  {
    id: 'ignore-wrapper-differences',
    killedBy: [
      'kit 条目放错了事件 → foreign_kit_entry',
      '同命令不同 matcher → foreign_kit_entry',
      '命令前缀是 agent-kit rsi 却不在形状表里 → foreign_kit_entry',
      '按命令串删除是错的:用户把 kit 包装对象改了(加字段)→ config_changed_since_install,不删',
      '混合包装(kit 钩子与用户钩子在同一个包装里) → foreign_kit_entry',
      '用户在 kit 条目上加了字段 → foreign_kit_entry',
    ],
    failed: 6,
    skipped: 0,
    restored: true,
  },
  {
    id: 'lock-lost-still-commits',
    killedBy: [
      '卸载:同样的矩阵,收敛后账本归属为空、目标里没有 kit 节点',
      '只有残留 tmp、没有 journal:幂等安装 / 空 prune 不走快捷返回,锁内清理(journal tmp 与 ledger tmp)',
      '安装:合并(已有用户配置 + 备份)',
      '安装:新建(文件不存在)',
      '残留的 journal tmp / 账本 tmp / 目标 tmp 都有出口:恢复时按 txn_id 与固定名字清理',
      '目标事务已完成而顺带修剪失败 → 仍 committed、退 0,stderr 一行 RSI_HOOKS_WARN,maintenance=partial;下次修剪按无害方向补完',
      '维护写入的 rename 之后失败(失锁)也按实际阶段记 maintenance=partial(discard)',
    ],
    failed: 7,
    skipped: 0,
    restored: true,
  },
  {
    id: 'ledger-not-committed-returns-success',
    killedBy: [
      'pi 内容漂移:有记录但被改过 → 卸载 / 重装都拒(config_changed_since_install)',
      'pi:独立文件(不合并),extensions/ 以 0700 建在已存在的 agent 根之下;账本记整文件指纹',
      'plain → canary:remove + add 同一事务;再迁回',
      '卸载 / restore 不看形状核实(只动账本登记过的节点),生产形状表下也能卸掉之前装的',
      '按命令串删除是错的:用户把 kit 包装对象改了(加字段)→ config_changed_since_install,不删',
      '提交整个事务:目标内容、权限、账本、标记、journal 已删;JSON 键集固定;fsync / rename 顺序逐项相等',
      '用户内容不动,kit 节点移除;备份整份;账本归属清空',
      '用户混入了自己的钩子到 kit 包装对象 → 不删包装对象(config_changed_since_install)',
      '空对象 {} 也能装;卸载后留下空数组 / 空对象(精确还原归 --restore)',
      '非 kit 节点的字节片段在新文件里与原文件逐字相同;权限沿用原文件;备份只在私有备份文件里含秘密哨兵',
    ],
    failed: 10,
    skipped: 0,
    restored: true,
  },
  {
    id: 'silent-replan-after-confirm',
    killedBy: [
      '② 仅锁基础设施:拿锁失败(locked)与锁内、残留处理未写任何东西时的 stale_plan',
      '③ 仅既有事务的恢复:残留处理写过东西,随后本次计划被拒(stale_plan)',
    ],
    failed: 2,
    skipped: 0,
    restored: true,
  },
  {
    id: 'residue-aborted-not-first',
    killedBy: [
      'aborted 的 bootstrap journal(标记在、账本缺)→ 提交只记 aborted 的空账本,再删 journal',
      '④ 本次目标未提交:提交前被改(config_changed_during_write)→ journal 记 aborted、备份保留、临时文件已删、对方的改动不丢',
    ],
    failed: 2,
    skipped: 0,
    restored: true,
  },
  {
    id: 'skip-ledger-durable-before-journal-delete',
    killedBy: [
      '提交整个事务:目标内容、权限、账本、标记、journal 已删;JSON 键集固定;fsync / rename 顺序逐项相等',
    ],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'bootstrap-marker-skipped',
    killedBy: [
      '--discard-residue 只接管所选的那一个;非「第三种值」/ 不存在 / 别的 agent 的 journal → 退 4 residue_not_discardable,不记 discarded',
      '30 个 UTC 日:过期的非受保护备份被修剪,受保护备份即使过期也留着;干跑只列 id 与数量',
      'aborted 的 bootstrap journal(标记在、账本缺)→ 提交只记 aborted 的空账本,再删 journal',
      'discarding(--discard-residue 在 journal 改记后崩溃)→ 下一次任何 --write 补完:只提交 discarded 记录,不提交原计划归属',
      'pi 内容漂移:有记录但被改过 → 卸载 / 重装都拒(config_changed_since_install)',
      'pi:独立文件(不合并),extensions/ 以 0700 建在已存在的 agent 根之下;账本记整文件指纹',
      'plain → canary:remove + add 同一事务;再迁回',
      'restore 一个 restore 也是合法的(它是新的最新已提交事务)',
      'restore 的备份回退点:崩溃于 target_renamed 后恢复收敛(账本逆变更只生效一次)',
      'settings.local.json 里已有同形状 → duplicate_in_local(干跑也拒);读不了 / 不可解析 → duplicate_check_failed;只挡安装不挡卸载',
      'txn/ 换成符号链接 → 不跟随:残留处理读不了 txn/,退 3 hooks_ledger_invalid(等级 lock_only,零后继写)',
      '⑤ 目标已提交、事务待恢复:rename 之后失败(账本 / journal 清理未完成)→ 目标已是 after,下一次 --write 补完',
      '之后有任何事务(卸载 / discarded)都使旧事务不可恢复;不存在的 id 同码',
      '写前不存在 → 受保护的删除;恢复后目标消失、归属回到事务之前',
      '卸载 / restore 不看形状核实(只动账本登记过的节点),生产形状表下也能卸掉之前装的',
      '卸载:同样的矩阵,收敛后账本归属为空、目标里没有 kit 节点',
      '受保护备份(每个目标最新一个已提交事务)不计入、不受 10 份上限约束;其余最多 10 份',
      '只有残留 tmp、没有 journal:幂等安装 / 空 prune 不走快捷返回,锁内清理(journal tmp 与 ledger tmp)',
      '只能恢复该目标上最新一个已提交事务:放回备份字节、权限;账本逆变更;源事务记 restored;自身是事务',
      '备份区出现不认识的名字 → hooks_backup_invalid',
      '备份损坏 / 被换成链接 / 宽权限 → 退 3 hooks_backup_invalid,零写调用',
      '安装:合并(已有用户配置 + 备份)',
      '安装:新建(文件不存在)',
      '崩溃于 backup_written → 写入承诺 target_unwritten;恢复后收敛、幂等',
      '崩溃于 journal_deleted → 写入承诺 committed;恢复后收敛、幂等',
      '崩溃于 journal_written → 写入承诺 target_unwritten;恢复后收敛、幂等',
      '崩溃于 ledger_committed → 写入承诺 target_written_pending;恢复后收敛、幂等',
      '崩溃于 ledger_marker_created → 写入承诺 target_written_pending;恢复后收敛、幂等',
      '崩溃于 target_before_write → 写入承诺 target_unwritten;恢复后收敛、幂等',
      '崩溃于 target_renamed → 写入承诺 target_written_pending;恢复后收敛、幂等',
      '幂等:再装一次 = unchanged,零写调用(连锁文件都不碰),账本不变',
      '当前文件已被改(≠ 该事务的 after)→ config_changed_since_install,零写调用',
      '手动 prune:确认之后、锁内重算的集合变了 → stale_plan,不删用户没确认过的备份',
      '按命令串删除是错的:用户把 kit 包装对象改了(加字段)→ config_changed_since_install,不删',
      '提交整个事务:目标内容、权限、账本、标记、journal 已删;JSON 键集固定;fsync / rename 顺序逐项相等',
      '改记 aborted 之后、空账本提交之前再次崩溃 → 再下一次恢复照常:空账本只记 aborted(无归属、generation 不动)',
      '标记在、账本缺、没有 bootstrap journal → 退 3 hooks_ledger_invalid(不重建、不猜);账本在而标记缺同样',
      '残留的 journal tmp / 账本 tmp / 目标 tmp 都有出口:恢复时按 txn_id 与固定名字清理',
      '用户内容不动,kit 节点移除;备份整份;账本归属清空',
      '用户混入了自己的钩子到 kit 包装对象 → 不删包装对象(config_changed_since_install)',
      '目标事务已完成而顺带修剪失败 → 仍 committed、退 0,stderr 一行 RSI_HOOKS_WARN,maintenance=partial;下次修剪按无害方向补完',
      '空对象 {} 也能装;卸载后留下空数组 / 空对象(精确还原归 --restore)',
      '维护写入的 rename 之后失败(失锁)也按实际阶段记 maintenance=partial(discard)',
      '节点已被用户删掉:无可卸 = unchanged;账本不变',
      '账本已提交、journal 未删(崩溃于 ledger_committed)→ 恢复时先 ensureLedgerDurable(fsync 账本文件与目录)再删 journal;不重写账本',
      '进行中 + 目标 = after → 提交 journal 里的账本变更,删 journal',
      '进行中 + 目标 = before → 先改记 aborted,再提交只记 aborted 的空账本,然后才删 journal;之后正常安装',
      '进行中 + 目标是第三种值 → 退 4 txn_residue_unknown,不建账本、不动目标,journal 原样保留(等级 lock_only)',
      '追加后会超过 1 MiB → config_shape_unsupported,零写调用,文件不动;留有余量则照常安装',
    ],
    failed: 49,
    skipped: 0,
    restored: true,
  },
  {
    id: 'restore-skip-after-check',
    killedBy: ['当前文件已被改(≠ 该事务的 after)→ config_changed_since_install,零写调用'],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'restore-any-txn',
    killedBy: ['之后有任何事务(卸载 / discarded)都使旧事务不可恢复;不存在的 id 同码'],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'hardlink-target-accepted',
    killedBy: ['目标是符号链接 / 硬链接 / 组可写 / 属主不符 / 超过 1 MiB'],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'prune-unprotects-latest',
    killedBy: [
      '30 个 UTC 日:过期的非受保护备份被修剪,受保护备份即使过期也留着;干跑只列 id 与数量',
      '受保护备份(每个目标最新一个已提交事务)不计入、不受 10 份上限约束;其余最多 10 份',
      '目标事务已完成而顺带修剪失败 → 仍 committed、退 0,stderr 一行 RSI_HOOKS_WARN,maintenance=partial;下次修剪按无害方向补完',
    ],
    failed: 3,
    skipped: 0,
    restored: true,
  },
  {
    id: 'generation-not-bumped',
    killedBy: [
      'plain → canary:remove + add 同一事务;再迁回',
      '提交整个事务:目标内容、权限、账本、标记、journal 已删;JSON 键集固定;fsync / rename 顺序逐项相等',
      '空对象 {} 也能装;卸载后留下空数组 / 空对象(精确还原归 --restore)',
    ],
    failed: 3,
    skipped: 0,
    restored: true,
  },
  {
    id: 'txn-not-idempotent',
    killedBy: [
      '卸载:同样的矩阵,收敛后账本归属为空、目标里没有 kit 节点',
      '安装:合并(已有用户配置 + 备份)',
      '安装:新建(文件不存在)',
      '崩溃于 ledger_committed → 写入承诺 target_written_pending;恢复后收敛、幂等',
      '账本已提交、journal 未删(崩溃于 ledger_committed)→ 恢复时先 ensureLedgerDurable(fsync 账本文件与目录)再删 journal;不重写账本',
    ],
    failed: 5,
    skipped: 0,
    restored: true,
  },
  {
    id: 'pi-overwrites-foreign-file',
    killedBy: [
      'pi 外来文件:同名文件已存在而账本无归属 → 不覆盖(foreign_kit_entry);内容恰好相同则幂等',
    ],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'skip-agent-root-check',
    killedBy: ['agent 根不存在 → 4 agent_not_installed;kit 不替 agent 建根目录'],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'shape-gate-removed',
    killedBy: [
      'hooks --install --agent claude --write → 退 4,写审计 [],树不变',
      'hooks --install --agent codex --write → 退 4,写审计 [],树不变',
      'hooks --install --agent pi --write → 退 4,写审计 [],树不变',
      '四种证据级别:只有「公开文档」「实测运行」开放 --write',
      '生产形状表三家都是「假设」→ --install --write 退 4 shape_unverified,零写调用;干跑照常、verified=false',
      '适用的 agent 版本范围:区间内放行;区间外 / 版本未知 / 无法解析 → shape_unverified(fail closed)',
    ],
    failed: 9,
    skipped: 0,
    restored: true,
  },
  {
    id: 'local-duplicate-check-removed',
    killedBy: [
      'settings.local.json 的检测要严格:重复键 / 非 UTF-8 / 目标事件不是数组 → duplicate_check_failed(不当作未发现)',
      'settings.local.json 里已有同形状 → duplicate_in_local(干跑也拒);读不了 / 不可解析 → duplicate_check_failed;只挡安装不挡卸载',
      '不读项目 cwd、不输出冲突条目全文:拒绝信息只有稳定码',
    ],
    failed: 3,
    skipped: 0,
    restored: true,
  },
  {
    id: 'stray-tmp-not-removed',
    killedBy: [
      '只有残留 tmp、没有 journal:幂等安装 / 空 prune 不走快捷返回,锁内清理(journal tmp 与 ledger tmp)',
      '安装:合并(已有用户配置 + 备份)',
      '安装:新建(文件不存在)',
      '残留的 journal tmp / 账本 tmp / 目标 tmp 都有出口:恢复时按 txn_id 与固定名字清理',
    ],
    failed: 4,
    skipped: 0,
    restored: true,
  },
  {
    id: 'target-tmp-not-removed',
    killedBy: [
      '卸载:同样的矩阵,收敛后账本归属为空、目标里没有 kit 节点',
      '安装:合并(已有用户配置 + 备份)',
      '安装:新建(文件不存在)',
      '残留的 journal tmp / 账本 tmp / 目标 tmp 都有出口:恢复时按 txn_id 与固定名字清理',
    ],
    failed: 4,
    skipped: 0,
    restored: true,
  },
  {
    id: 'journal-semantics-unchecked',
    killedBy: [
      '伪造 journal:文件名与内容 txn_id 不符 / 多余字段(想借路径)/ 目标哈希对不上 → hooks_ledger_invalid;journal 里的路径不作为读写依据',
    ],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'prune-set-widened-after-confirm',
    killedBy: ['手动 prune:确认之后、锁内重算的集合变了 → stale_plan,不删用户没确认过的备份'],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'case-alias-not-reserved',
    killedBy: [
      'createHomeFsContext:planScope 里放 kit-hooks 路径 → SCOPE_INVALID',
      'writeFile / remove / createExclusive / chmod / rename / copyFile 两端都拒',
      '三条 kit-hooks(json-merge ×2、file ×1),总数 15;无 owner 的 isHomeWritePath 不把它们算作受管路径',
    ],
    failed: 3,
    skipped: 0,
    restored: true,
  },
  {
    id: 'target-tmp-cleanup-follows-links',
    killedBy: [
      '目标 tmp 清理先校验父目录:.claude 换成符号链接 → hooks_target_unsafe,链接另一侧的文件不被删',
    ],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'idempotent-shortcut-skips-stray-tmp',
    killedBy: [
      '只有残留 tmp、没有 journal:幂等安装 / 空 prune 不走快捷返回,锁内清理(journal tmp 与 ledger tmp)',
    ],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'safe-fs-writes-kit-hooks',
    killedBy: [
      'kit-hooks 目标文件(~/.claude/settings.json)被拒',
      '写入根覆盖 hooks/ 私有子树时,写 / 建独占文件 / 建目录都被拒且无产物',
      '大小写别名 HOOKS/ 同样被拒',
      '递归删除 / rename 保留子树的祖先被拒,子树仍在',
    ],
    failed: 4,
    skipped: 0,
    restored: true,
  },
];
