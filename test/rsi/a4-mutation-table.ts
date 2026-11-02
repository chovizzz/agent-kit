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
    expectRed: ['别名越界 → alias_unknown', '「合法 + 非法」混合批次整批拒'],
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
    expectRed: ['digest:after_read 之后', 'digest:before_final 之后'],
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
    expectRed: ['名额先于消费 digest 持久化', 'agent 第 3 次'],
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
];

/** javis 实测结果(主代理执行变异后填);形状同 A3_RESULTS */
export const A4_RESULTS: readonly A4Result[] = [];
