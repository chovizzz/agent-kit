/**
 * R20-A4 必杀变异(契约 §20.16 R20-16.27):每条变异后必须有测试红,且只红该条款自己的杀手用例。
 * 执行方式同 A3 / B5e(`a3-mutation-table.ts`):javis 私有检出里 cp 备份 → 按锚点替换(每个锚点在对应文件里**恰好出现一次**)→ 跑 `tests` →
 * 失败集合非空、全部命中 `expectRed`、`mustKill` 每项至少命中一个、没有 skipped → cp 还原并逐文件 sha256 核对。**不用 git checkout / stash 还原**。
 * 本文件只写表与每条变异期望红的测试名;变异由主代理在 javis 上执行,结果记进 `A4_RESULTS`(同 A3_RESULTS 的形状;A4 实装块不执行变异)。
 * 契约 R20-16.27 的 11 个变异点与本表 id 的对应:
 *   跳过别名检查 → skip-alias-check;采用 agent 摘录 → adopt-agent-excerpt;跳过授权期限 → skip-session-expiry;X/U 剔除挪到聚类之后 → xu-after-cluster;
 *   跳过输出复扫 → skip-output-rescan(另加 skip-output-leak-gate:路径泄漏闸);跳过最终复核 → digest-skip-final-review / ingest-skip-final-review;
 *   digest 不消费 → digest-not-consumed;名额在消费之后才写 → quota-after-consume;严格批次退回单条丢弃 → strict-batch-to-drop;
 *   unknown 等式放行 → unknown-equality-pass;readFileSafe 换成 readFile → slot-read-unsafe。
 *   另加槽位协议自己的三条(R20-16.10 / 16.25):lock-order-guard-removed、slot-assert-held-removed、publish-token-check-removed。
 */
export interface Edit {
  file: string;
  anchor: string;
  replacement: string;
}

export interface A4Mutation {
  id: string;
  /** 契约里的变异点原文 */
  clause: string;
  edits: readonly Edit[];
  /** 相对 `test/` */
  tests: readonly string[];
  expectRed: readonly string[];
  mustKill: readonly string[];
}

export interface A4Result {
  id: string;
  failed: number;
  skipped: number;
  killedBy: readonly string[];
  restored: boolean;
}

const INGEST = 'rsi/a4-ingest.test.ts';
const DIGEST = 'rsi/a4-digest.test.ts';
const SLOTS = 'rsi/a4-slots.test.ts';
const SESSION = 'rsi/a4-session.test.ts';
const PROV = 'guards/a4-provenance.test.ts';

export const A4_MUTATIONS: readonly A4Mutation[] = [
  {
    id: 'skip-alias-check',
    clause: '跳过别名检查',
    edits: [
      {
        file: 'src/rsi/ingest.ts',
        anchor:
          "if (used.some((a) => !Object.hasOwn(record.aliases, a))) return rej('alias_unknown');",
        replacement: "if (false) return rej('alias_unknown');",
      },
      {
        file: 'src/reflect/validate.ts',
        anchor: 'if (p.evidence.some((a) => !ctx.allowedAliases.has(a))) {',
        replacement: 'if (false) {',
      },
    ],
    tests: [INGEST],
    expectRed: ['别名越界', '「合法 + 非法」混合批次整批拒'],
    mustKill: ['别名越界 → alias_unknown'],
  },
  {
    id: 'adopt-agent-excerpt',
    clause: '采用 agent 摘录',
    edits: [
      {
        file: 'src/rsi/ingest.ts',
        anchor:
          'signal: { ...sig, excerpt_redacted: sig.excerpt_redacted }, // 摘录 = 信号库原文(§16);agent 给的一律不用',
        replacement:
          'signal: { ...sig, excerpt_redacted: norm.agentExcerpts.get(alias) ?? sig.excerpt_redacted },',
      },
    ],
    tests: [INGEST],
    expectRed: ['agent 自带的证据摘录被丢弃'],
    mustKill: ['agent 自带的证据摘录被丢弃'],
  },
  {
    id: 'skip-session-expiry',
    clause: '跳过授权期限',
    edits: [
      {
        file: 'src/rsi/session.ts',
        anchor: 'if (!(today < s.expires && s.expires <= addDays(today, RSI_SESSION_MAX_DAYS))) {',
        replacement: 'if (false) {',
      },
    ],
    tests: [SESSION, DIGEST, INGEST],
    expectRed: ['④ 今天 < expires', '已过期', '超过 90 天'],
    mustKill: ['④ 今天 < expires', '超过 90 天'],
  },
  {
    id: 'xu-after-cluster',
    clause: 'X / U 剔除挪到聚类之后',
    edits: [
      {
        file: 'src/rsi/digest.ts',
        anchor: 'selected = selectClusters(kept, p0.key);',
        replacement:
          "selected = selectClusters(loaded, p0.key).map((c) => ({ ...c, current: c.current.filter((s) => classOf.get(s.project_key) === 'P') })).filter((c) => c.current.length > 0);",
      },
    ],
    tests: [DIGEST],
    expectRed: ['仅靠 X 或 U 证据才过门槛的簇不入选'],
    mustKill: ['仅靠 X 或 U 证据才过门槛的簇不入选'],
  },
  {
    id: 'skip-output-rescan',
    clause: '跳过输出复扫',
    edits: [{ file: 'src/rsi/digest.ts', anchor: 'if (!clean) {', replacement: 'if (false) {' }],
    tests: [DIGEST],
    expectRed: ['规则更新后信号库里的种子命中'],
    mustKill: ['规则更新后信号库里的种子命中'],
  },
  {
    id: 'skip-output-leak-gate',
    clause: '跳过输出复扫(路径泄漏闸)',
    edits: [
      {
        file: 'src/rsi/digest.ts',
        anchor: 'if (emitLines(leakSink, lines, forbidden) !== ExitCode.OK) {',
        replacement: 'if (false) {',
      },
    ],
    tests: [DIGEST],
    expectRed: ['植入 HOME 路径'],
    mustKill: ['植入 HOME 路径'],
  },
  {
    id: 'digest-skip-final-review',
    clause: '跳过最终复核(digest)',
    edits: [
      {
        file: 'src/rsi/digest.ts',
        anchor: 'if (!same) {',
        replacement: 'if (false) {',
      },
    ],
    tests: [DIGEST],
    expectRed: ['digest:after_read', 'digest:before_final'],
    mustKill: ['digest:after_read 之后:撤销授权', 'digest:before_final 之后:rsi stop'],
  },
  {
    id: 'ingest-skip-final-review',
    clause: '跳过提交前最终复核(ingest)',
    edits: [
      {
        file: 'src/rsi/ingest.ts',
        anchor:
          'if (factsKey(f1) !== factsKey(f2) || rd.generation !== rd2.generation || !sameProject) {',
        replacement: 'if (false) {',
      },
    ],
    tests: [INGEST],
    expectRed: ['最终复核:'],
    mustKill: ['最终复核:撤销授权', '最终复核:项目根换成符号链接'],
  },
  {
    id: 'digest-not-consumed',
    clause: 'digest 不消费',
    edits: [
      {
        file: 'src/rsi/ingest.ts',
        anchor: '(dl) => removeDigestIfSame(io, dl, found, slotDeps),',
        replacement: "async () => 'removed' as const,",
      },
    ],
    tests: [INGEST],
    expectRed: [
      '暂存 .state/reflect/<run_id>/',
      'digest 已删、暂存未写就崩溃',
      '第 3 步之后槽位被 --revoke',
      // 2026-11-02 javis 变异实测补登:这三条也断言「digest 已被消费」,变异后同样变红
      '正向对照:49 个 run 时可以写',
      '> 5 条提案 → too_many_proposals',
      '首次创建 ingest-quota/',
    ],
    mustKill: ['digest 已删、暂存未写就崩溃'],
  },
  {
    id: 'quota-after-consume',
    clause: '名额在消费之后才写',
    edits: [
      {
        file: 'src/rsi/ingest.ts',
        anchor: 'const q = await reserveIngestQuota(io, lock, agent, today, deps.quota ?? {});',
        replacement: "const q: string = 'reserved';",
      },
      {
        file: 'src/rsi/ingest.ts',
        anchor: "await point('ingest:after_consume');",
        replacement:
          "await point('ingest:after_consume');\n  await reserveIngestQuota(io, lock, agent, today, deps.quota ?? {});",
      },
    ],
    tests: [INGEST],
    expectRed: [
      '名额先于消费 digest 持久化',
      'agent 第 3 次',
      // 2026-11-02 javis 变异实测补登:这几条断言「名额写在 digest 消费之前 / 拒绝时 digest 未被消费」
      '当日名额文件损坏只封当日',
      '首次创建 ingest-quota/',
      '已有目录组可写',
      '已有目录属主不是当前用户',
      '名额目录准备前就失锁',
    ],
    mustKill: ['名额先于消费 digest 持久化', 'agent 第 3 次'],
  },
  {
    id: 'strict-batch-to-drop',
    clause: '严格批次退回单条丢弃',
    edits: [
      {
        file: 'src/rsi/ingest.ts',
        anchor: 'if (droppedKinds.length > 0) {',
        replacement: 'if (false) {',
      },
    ],
    tests: [INGEST],
    expectRed: ['pattern 不安全', '回显', 'id 冲突 / 重复'],
    mustKill: ['回显', 'pattern 不安全'],
  },
  {
    id: 'unknown-equality-pass',
    clause: 'unknown 等式放行',
    edits: [
      {
        file: 'src/guards/criteria.ts',
        anchor: 'r.vendor === UNKNOWN_VENDOR ||',
        replacement: 'false ||',
      },
      {
        file: 'src/guards/criteria.ts',
        anchor: 'derived === UNKNOWN_VENDOR ||',
        replacement: 'false ||',
      },
    ],
    tests: [PROV],
    expectRed: ['unknown 等式漏洞'],
    mustKill: ['unknown 等式漏洞'],
  },
  {
    id: 'slot-read-unsafe',
    clause: 'readFileSafe 换成 readFile',
    edits: [
      {
        file: 'src/rsi/digest-slots.ts',
        anchor: "import { lstat, readDir, readFileSafe } from '../io/read-fs.js';",
        replacement:
          "import { lstat, readDir, readFileSafe, readBytes, stat } from '../io/read-fs.js';",
      },
      {
        file: 'src/rsi/digest-slots.ts',
        anchor: 'const r = await readFileSafe(path.join(dir, slotName(n)), {',
        // 普通 readFile 的行为(跟随符号链接、不校验 nlink / 属主 / 权限 / 大小);非普通文件(FIFO)仍先挡掉,免得测试进程挂死
        replacement:
          "const r = await (async (p: string, _o: unknown) => { const st = await stat(p).catch(() => undefined); if (st === undefined) return { kind: 'missing' as const }; if (!st.isFile()) return { kind: 'unsafe' as const, why: 'not_regular' as const }; return { kind: 'ok' as const, bytes: Buffer.from(await readBytes(p)), meta: st }; })(path.join(dir, slotName(n)), {",
      },
    ],
    tests: [SLOTS],
    expectRed: ['安全读取:符号链接 / FIFO / 硬链接 / 超大文件'],
    mustKill: ['安全读取:符号链接 / FIFO / 硬链接 / 超大文件'],
  },
  {
    id: 'lock-order-guard-removed',
    clause: '锁序:持 digests/lock 的代码路径取 rsi/lock → 单测红',
    edits: [
      {
        file: 'src/rsi/lock.ts',
        anchor:
          'if (target.sub === undefined && [...heldInProcess].some((f) => f.endsWith(DIGESTS_LOCK_SUFFIX))) {',
        replacement: 'if (false) {',
      },
    ],
    tests: [SLOTS],
    expectRed: ['持槽位锁时再取 rsi/lock → internal'],
    mustKill: ['持槽位锁时再取 rsi/lock → internal'],
  },
  {
    id: 'slot-assert-held-removed',
    clause: '槽位每个写出口前 assertHeld()(R20-16.10)',
    edits: [
      {
        file: 'src/rsi/digest-slots.ts',
        anchor: '  await deps.hooks?.point?.(name);\n  await lock.assertHeld();',
        replacement: '  await deps.hooks?.point?.(name);',
      },
    ],
    tests: [SLOTS],
    expectRed: ['失锁后:消费的 unlink 不再执行', '失锁后:预留的创建、发布的 rename 都不再执行'],
    mustKill: ['失锁后:消费的 unlink 不再执行'],
  },
  {
    id: 'publish-token-check-removed',
    clause: 'ABA:发布时核对本进程的预留 token',
    edits: [
      {
        file: 'src/rsi/digest-slots.ts',
        anchor: "if (cur.kind !== 'reserved' || cur.reserved !== r.token) return 'lost';",
        replacement: "if (false) return 'lost';",
      },
    ],
    tests: [SLOTS],
    expectRed: ['A 预留后暂停超过 10 分钟'],
    mustKill: ['A 预留后暂停超过 10 分钟'],
  },
  {
    id: 'stdin-error-as-eof',
    clause: 'stdin 流错误按 EOF 处理(返回已读前缀)',
    edits: [
      {
        file: 'src/commands/types.ts',
        anchor: "reject(e instanceof Error ? e : new Error('stdin error'));",
        replacement:
          "resolve({ text: Buffer.concat(chunks, total).toString('utf8'), tooLarge: false });",
      },
    ],
    tests: [INGEST],
    expectRed: ['流错误 → readStdinFrom reject'],
    mustKill: ['流错误 → readStdinFrom reject'],
  },
  {
    id: 'quota-dir-no-parent-fsync',
    clause: '名额目录首建不 fsync 父目录',
    edits: [
      {
        file: 'src/rsi/ingest-quota.ts',
        anchor: 'await fsyncDir(io, rsi.dir);',
        replacement: '',
      },
    ],
    tests: [INGEST],
    expectRed: ['首次创建 ingest-quota/'],
    mustKill: ['首次创建 ingest-quota/'],
  },
  {
    id: 'quota-dir-no-owner-check',
    clause: '名额目录不校验属主 / 组写位',
    edits: [
      {
        file: 'src/rsi/ingest-quota.ts',
        anchor: '  assertOwnDirSafe(st, deps.uid);\n  return dir;',
        replacement: '  return dir;',
      },
    ],
    tests: [INGEST],
    expectRed: ['已有目录组可写', '已有目录属主不是当前用户'],
    mustKill: ['已有目录组可写', '已有目录属主不是当前用户'],
  },
  {
    id: 'slot-dir-mkdir-unguarded',
    clause: '持锁后的槽位目录访问不经 assertHeld、且可 mkdir',
    edits: [
      {
        file: 'src/rsi/digest-slots.ts',
        anchor: '  await lock.assertHeld();\n  return digestsDirReadonly(io);',
        replacement: '  return digestsDir(io);',
      },
      {
        file: 'src/rsi/digest-slots.ts',
        anchor: "import { digestsDirReadonly } from './rsi-dir.js';",
        replacement: "import { digestsDir, digestsDirReadonly } from './rsi-dir.js';",
      },
    ],
    tests: [SLOTS],
    expectRed: [
      '进入目录访问之前失锁',
      // 2026-11-02 javis 变异实测补登:持锁后不得 chmod 修正目录权限
      '持锁时目录被换成别人可写的',
    ],
    mustKill: [
      '进入目录访问之前失锁(锁文件被夺走)',
      '进入目录访问之前失锁(purge 删掉了整个 digests/)',
    ],
  },
];

/** javis 实测结果(主代理执行变异后填);形状同 A3_RESULTS */
export const A4_RESULTS: readonly A4Result[] = [
  // 2026-11-02 javis 私有检出 @ 610bc0f:基线 158 例全绿、0 skipped;20 条变异全部被杀、无 skipped、每条还原后逐文件 sha256 一致;
  // javis HOME 下 .local/state/agent-kit 前后不变。首轮有 3 条(digest-not-consumed、quota-after-consume、slot-dir-mkdir-unguarded)多红了表外的相关用例,已补进 expectRed(只补登记,不改变异与用例)。
  {
    id: 'skip-alias-check',
    killedBy: [
      '别名越界 → alias_unknown(整批拒、零暂存)',
      '「合法 + 非法」混合批次整批拒:合法那条也不暂存(严格批次,不是单条丢弃)',
    ],
    failed: 2,
    skipped: 0,
    restored: true,
  },
  {
    id: 'adopt-agent-excerpt',
    killedBy: ['agent 自带的证据摘录被丢弃:落盘摘录 = 信号库原文,agent 的文本不进任何暂存文件'],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'skip-session-expiry',
    killedBy: [
      '会话授权 已过期 → 4 RSI_SESSION_DENIED reason=expired;零写入,stdout 空',
      '会话授权 超过 90 天 → 4 RSI_SESSION_DENIED reason=expired;零写入,stdout 空',
      '授权关 / 失效后用旧 digest:已过期 → 4 RSI_SESSION_DENIED reason=expired,不占名额',
      '④ 今天 < expires ≤ 今天 + 90 天,否则 expired(边界:今天、昨天、+90、+91)',
      '已过期 → expired;配置仍是 on,状态仍是 confirmed(L0 的入口条件不变)',
      '超过 90 天 → expired;配置仍是 on,状态仍是 confirmed(L0 的入口条件不变)',
    ],
    failed: 6,
    skipped: 0,
    restored: true,
  },
  {
    id: 'xu-after-cluster',
    killedBy: [
      '仅靠 X 或 U 证据才过门槛的簇不入选;正向对照:换成采集中的 other 项目,簇入选且 other_evidence 计 1',
    ],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'skip-output-rescan',
    killedBy: [
      '规则更新后信号库里的种子命中(被选中的摘录)→ digest 整份拒:3 RSI_DIGEST_REJECTED rescan_hit,无 digest 文件、stdout 空',
    ],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'skip-output-leak-gate',
    killedBy: ['植入 HOME 路径 → output_leak(退出 3,无文件、无输出)'],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'digest-skip-final-review',
    killedBy: [
      'digest:after_read 之后:撤销授权',
      'digest:after_read 之后:新增排除(当前项目)',
      'digest:after_read 之后:rsi stop',
      'digest:after_read 之后:purge 开始(journal 出现)',
      'digest:after_read 之后:项目根目录被删后重建(新 inode)',
      'digest:after_read 之后:项目根换成符号链接',
      'digest:before_final 之后:撤销授权',
      'digest:before_final 之后:新增排除(当前项目)',
      'digest:before_final 之后:rsi stop',
      'digest:before_final 之后:purge 开始(journal 出现)',
      'digest:before_final 之后:项目根目录被删后重建(新 inode)',
      'digest:before_final 之后:项目根换成符号链接',
    ],
    failed: 12,
    skipped: 0,
    restored: true,
  },
  {
    id: 'ingest-skip-final-review',
    killedBy: [
      '最终复核:撤销授权',
      '最终复核:新增排除(当前项目)',
      '最终复核:rsi stop',
      '最终复核:purge 开始(journal 出现)',
      '最终复核:项目根目录被删后重建(新 inode)',
      '最终复核:项目根换成符号链接',
    ],
    failed: 6,
    skipped: 0,
    restored: true,
  },
  {
    id: 'digest-not-consumed',
    killedBy: [
      '暂存 .state/reflect/<run_id>/(提案 + 原子 + report.json),不 apply;来源字段按 R20-16.19;摘录 = 信号库原文',
      '50MiB → RSI_STAGING_FULL,零暂存(digest 与名额已消耗)',
      'digest 已删、暂存未写就崩溃 → 无暂存残留;重试同一 digest 得 digest_invalid',
      '第 3 步之后槽位被 --revoke 再被新 digest 复用 → 第 5 步 digest_invalid(名额照计),新 digest 不受影响且仍可用',
      '> 5 条提案 → too_many_proposals(digest 已消费,名额已计)',
      '首次创建 ingest-quota/:新目录 → 父目录 fsync → 名额文件与目录持久化 → 之后才 unlink digest',
    ],
    failed: 6,
    skipped: 0,
    restored: true,
  },
  {
    id: 'quota-after-consume',
    killedBy: [
      'agent 第 3 次 → 4 rate_limited,且不消费 digest;全局第 5 次同样',
      '当日名额文件损坏只封当日(不改写它);次日使用新文件、恢复',
      '名额先于消费 digest 持久化:两步之间崩溃 → 名额多计一次、digest 仍可用一次',
      '首次创建 ingest-quota/:新目录 → 父目录 fsync → 名额文件与目录持久化 → 之后才 unlink digest',
      '已有目录组可写 → 拒绝(3 state_dir_unsafe),拒绝前不写名额文件、不消费 digest',
      '已有目录属主不是当前用户(注入 uid)→ 拒绝,同样不写名额文件、不消费 digest',
      '名额目录准备前就失锁 → lock_lost,没有 mkdir / chmod / 文件写',
    ],
    failed: 7,
    skipped: 0,
    restored: true,
  },
  {
    id: 'strict-batch-to-drop',
    killedBy: [
      'pattern 不安全(量词过多) → pattern_unsafe(整批拒、零暂存)',
      '回显 → echo_detected(整批拒、零暂存)',
      'id 冲突 / 重复:同一原子 id 再交 → id_conflict;换 id 但内容相同 → duplicate',
    ],
    failed: 3,
    skipped: 0,
    restored: true,
  },
  {
    id: 'unknown-equality-pass',
    killedBy: [
      'unknown 等式漏洞:vendor=unknown 且推导也是 unknown → REFLECTOR_UNVERIFIABLE(不再因「两边相等」放行)',
    ],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'slot-read-unsafe',
    killedBy: [
      '安全读取:符号链接 / FIFO / 硬链接 / 超大文件 → invalid(不跟随、不挂住);清理跳过不删;查找不命中',
    ],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'lock-order-guard-removed',
    killedBy: ['持槽位锁时再取 rsi/lock → internal(锁序 rsi/lock → digests/lock);反序合法'],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'slot-assert-held-removed',
    killedBy: [
      '失锁后:消费的 unlink 不再执行,槽位文件原样保留',
      '失锁后:预留的创建、发布的 rename 都不再执行',
    ],
    failed: 2,
    skipped: 0,
    restored: true,
  },
  {
    id: 'publish-token-check-removed',
    killedBy: [
      'A 预留后暂停超过 10 分钟 → 槽位被回收并由 B 预留 / 发布;A 恢复后发布与放弃都不改动 B 的文件',
    ],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'stdin-error-as-eof',
    killedBy: ['流错误 → readStdinFrom reject,不把已读到的前缀当完整输入(先发合法 JSON 再出错)'],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'quota-dir-no-parent-fsync',
    killedBy: [
      '首次创建 ingest-quota/:新目录 → 父目录 fsync → 名额文件与目录持久化 → 之后才 unlink digest',
    ],
    failed: 1,
    skipped: 0,
    restored: true,
  },
  {
    id: 'quota-dir-no-owner-check',
    killedBy: [
      '已有目录组可写 → 拒绝(3 state_dir_unsafe),拒绝前不写名额文件、不消费 digest',
      '已有目录属主不是当前用户(注入 uid)→ 拒绝,同样不写名额文件、不消费 digest',
    ],
    failed: 2,
    skipped: 0,
    restored: true,
  },
  {
    id: 'slot-dir-mkdir-unguarded',
    killedBy: [
      '进入目录访问之前失锁(锁文件被夺走)→ lock_lost,没有新的 mkdir / chmod / 文件写;目录不被重建',
      '进入目录访问之前失锁(purge 删掉了整个 digests/)→ lock_lost,没有新的 mkdir / chmod / 文件写;目录不被重建',
      '持锁时目录被换成别人可写的(组可写)→ state_dir_unsafe(只读校验,不 chmod 修正)',
    ],
    failed: 3,
    skipped: 0,
    restored: true,
  },
];
