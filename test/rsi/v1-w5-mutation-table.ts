/**
 * §21 V1 W5 必杀变异(shadow 计数、canary.json 写入方、hint `--canary`、分组账、自动探针准入;契约 R21-6.x、§21.24 W0-3 / W0-13、M13-4 标 W5 的行)。
 * 执行方式同 W0 / W2 / W3:验证机私有检出里 cp 备份 → 按锚点替换(每个锚点在对应文件里**恰好出现一次**)→ 跑 `tests` →
 * 失败集合非空、全部命中 `expectRed`、`mustKill` 每项至少命中一个、没有 skipped → cp 还原并逐文件 sha256 核对。**不用 git checkout / stash 还原**。
 * 本文件只写表与每条变异期望红的测试名(`expectRed` 是杀手测试名里的字面子串;参数化用例名只取 `%s` 之外的固定片段);变异由主代理执行,
 * 结果记进 `V1_W5_RESULTS`(W5 实装块不执行变异,故留空)。条款以 `M13-<n>` 开头的行供 W10b 按 ID 对账。
 *
 * 不可变异的点(如实记录):`appendFileSynced` 里的 `fsync` 与 `O_APPEND` 无法在测试里观测(去掉不会改变任何可见行为),不在表内;
 * 它们的保证靠「落账成功才输出」的顺序用例与 safe-fs 的单一出口。
 */
export interface Edit {
  file: string;
  anchor: string;
  replacement: string;
}

export interface V1W5Mutation {
  id: string;
  /** 契约变异点原文(或该不变量) */
  clause: string;
  edits: readonly Edit[];
  /** 相对 `test/` */
  tests: readonly string[];
  expectRed: readonly string[];
  mustKill: readonly string[];
}

export interface V1W5Result {
  id: string;
  failed: number;
  skipped: number;
  killedBy: readonly string[];
  restored: boolean;
}

const C = 'src/rsi/canary/';
const P = 'src/rsi/personal/';
const DECIDE = `${C}canary-decide.ts`;
const DOC = `${C}canary-doc.ts`;
const HINTP = `${C}canary-hint.ts`;
const WRITER = `${C}canary-writer.ts`;
const LEDGER = `${C}ledger.ts`;
const PERMIT = `${C}permit-read.ts`;
const TICKET = `${C}probe-ticket.ts`;
const FILES = `${C}files.ts`;
const ATOMIC = `${C}atomic-write.ts`;
const PLAN = `${C}admission-plan.ts`;
const AWRITE = `${C}admission-write.ts`;
const HINT = 'src/rsi/hint.ts';
const SCOUNT = `${P}shadow-count.ts`;
const SFACTS = `${P}shadow-facts.ts`;
const SOBS = `${P}shadow-observe.ts`;
const STEP = `${P}candidate-step.ts`;

const T_DECIDE = 'rsi/canary/w5-decide.test.ts';
const T_PART = 'rsi/canary/w5-hint-part.test.ts';
const T_E2E = 'rsi/canary/w5-hint-e2e.test.ts';
const T_LEDGER = 'rsi/canary/w5-ledger.test.ts';
const T_WRITER = 'rsi/canary/w5-writer.test.ts';
const T_DOC = 'rsi/canary/w5-doc.test.ts';
const T_ADM = 'rsi/canary/w5-admission.test.ts';
const T_SHADOW = 'rsi/canary/w5-shadow.test.ts';

const off = (file: string, anchor: string): Edit => ({ file, anchor, replacement: 'void 0;' });
const drop = (file: string, anchor: string): Edit => ({ file, anchor, replacement: '' });

export const V1_W5_MUTATIONS: readonly V1W5Mutation[] = [
  // ---- M13-4 全局名额互斥(W5:canary.json 授予在锁内按权威记录现算名额) ----
  {
    id: 'm13-4-grant-slot-check-removed',
    clause: 'M13-4:名额检查移到锁外 / 去掉(授予时不再按权威记录核对别的候选是否占用名额)',
    edits: [
      {
        file: WRITER,
        anchor: 'if (evaluationSlotOccupied(all.value.filter((r) => r.id !== g.candidate_id))) {',
        replacement: 'if (false) {',
      },
    ],
    tests: [T_WRITER],
    expectRed: ['M13-4 名额互斥'],
    mustKill: ['M13-4 名额互斥'],
  },
  {
    id: 'm13-4-grant-slot-counts-self',
    clause: 'M13-4:候选自己也被算作占用(过滤条件失效)→ 永远授予不了',
    edits: [
      {
        file: WRITER,
        anchor: 'evaluationSlotOccupied(all.value.filter((r) => r.id !== g.candidate_id))',
        replacement: 'evaluationSlotOccupied(all.value)',
      },
    ],
    tests: [T_WRITER],
    expectRed: [
      '成功:0600',
      'M13-4 名额互斥',
      'overlaps_preset 取权威记录里该候选 G4 的结果(调用方不能自带);true / false 各一',
      '对账先于授予:撤销凭据列出该候选 → 拒绝、不写;列的是别的候选 / 别的内容哈希 → 不影响',
      '对账屏障(R21-9.5):A 已终态但 canary.json 残留、stop 行未补 → 授予 B 被拒;对账完成后允许',
      '对账屏障:有凭据而分组账不存在 / 为空 → 拒绝授予(账不存在不等于已补 stop);reconcileCaches 补 stop 后允许',
      '空凭据集 + 不合规账 → 拒绝授予(坏账不因没有凭据而绕过);空凭据集 + 账不存在 → 允许',
      '不可读缓存恢复:坏 JSON 缓存 + 已对账的历史凭据 → 授予被拒;对账清理移除不可读缓存后可恢复',
      '正文含关联标记前缀',
      'treat 输出超过 1536 字节',
      '在列的 agent 没有 p',
      'p_by_agent 有多余项',
      '正文只取权威来源:来源给不出(null / 抛错)→ 拒绝、不写;写进文件的正文就是来源给的那一份',
      '写点之前复核两把锁:任一把在写阶段丢失 → 抛错、没有 canary.json(也没有残留临时文件)',
      'muteCanary(AUTO_PAUSE / 熔断):置为不注入、generation + 1;已不注入 / 无文件 → 不写',
      'muteCanary 不需要 personal 锁,但需要 rsi 锁:丢锁 → 抛错、文件不变',
      'removeCanary:删除缓存文件;丢锁 → 不删',
    ],
    mustKill: ['成功:0600'],
  },
  // ---- R21-9.5 对账先于授予 / 撤销凭据 ----
  {
    id: 'grant-reconcile-removed',
    clause: 'R21-9.5:对账先于授予——持锁重读撤销凭据,被列出的候选不授予(去掉这一检查)',
    edits: [
      {
        file: WRITER,
        anchor: 'if (listed(rv.lines, g.candidate_id, g.content_sha256)) {',
        replacement: 'if (false) {',
      },
    ],
    tests: [T_WRITER],
    expectRed: ['对账先于授予'],
    mustKill: ['对账先于授予'],
  },
  {
    id: 'grant-revocations-invalid-ignored',
    clause: 'R21-6.11 第 4a 行 / R21-9.5:撤销凭据读不到不得授予(把读失败当作「没有撤销」)',
    edits: [
      {
        file: WRITER,
        anchor: "if (rv.kind !== 'ok') return { kind: 'refused', reason: 'revocations_invalid' };",
        replacement: 'void 0;',
      },
    ],
    tests: [T_WRITER],
    expectRed: ['撤销凭据读不到(invalid)'],
    mustKill: ['撤销凭据读不到(invalid)'],
  },
  {
    id: 'grant-lock-not-rechecked-at-write',
    clause: 'R21-6.10:worker 持两把锁写;写点之前复核(assertAll 失效)',
    edits: [
      {
        file: ATOMIC,
        anchor: 'const assertAll = async (): Promise<void> => {',
        replacement: 'const assertAll = async (): Promise<void> => {\n    return;',
      },
    ],
    tests: [T_WRITER],
    expectRed: ['写点之前复核两把锁'],
    mustKill: ['写点之前复核两把锁'],
  },
  // ---- R21-6.4 / R21-6.11 分组账与「未落账不注入」 ----
  {
    id: 'ledger-append-failure-swallowed',
    clause: 'R21-6.11 第 8 行:未落账不注入(追加失败被吞掉 → 照样输出)',
    edits: [
      {
        file: LEDGER,
        anchor:
          'await appendFileSynced(io, path.join(rsiDir, CANARY_FILES.ledger), text, RSI_FILE_MODE);',
        replacement:
          'await appendFileSynced(io, path.join(rsiDir, CANARY_FILES.ledger), text, RSI_FILE_MODE).catch(() => undefined);',
      },
    ],
    tests: [T_PART, T_E2E],
    expectRed: [
      '账行追加失败 → 不输出',
      '未落账不注入',
      '②之后崩溃的等价情形:账行追加失败 → 票已用、不输出(绝不重复授予)',
    ],
    mustKill: ['账行追加失败 → 不输出'],
  },
  {
    id: 'ledger-schema-skipped',
    clause: 'R21-6.4:账行必须过 schema(非法组合不落盘)',
    edits: [off(LEDGER, "if (!p.success) throw new LedgerError('line_invalid');")],
    tests: [T_LEDGER],
    expectRed: ['非法行被拒绝、不落盘'],
    mustKill: ['非法行被拒绝、不落盘'],
  },
  {
    id: 'ledger-stop-ref-dedupe-removed',
    clause: 'R21-6.4:同一 revocation_ref 至多一行 stop(去重失效)',
    edits: [
      {
        file: LEDGER,
        anchor: "l.kind === 'stop' && l.revocation_ref === line.revocation_ref",
        replacement: 'false',
      },
    ],
    tests: [T_LEDGER],
    expectRed: ['同一 revocation_ref 至多一行'],
    mustKill: ['同一 revocation_ref 至多一行'],
  },
  {
    id: 'ledger-append-on-invalid-ledger',
    clause: 'R21-6.4:坏账不被追加',
    edits: [off(LEDGER, "if (cur.kind === 'invalid') throw new LedgerError('invalid_ledger');")],
    tests: [T_LEDGER],
    expectRed: ['分组账不合规时不在其上追加'],
    mustKill: ['分组账不合规时不在其上追加'],
  },
  // ---- R21-6.10 读集合:读不到 ≠ 不存在 ----
  {
    id: 'revocations-size-cap-widened',
    clause: 'R21-6.10:撤销凭据超过 1MiB 按读取失败处理(上限放宽)',
    edits: [
      {
        file: PERMIT,
        anchor: 'maxBytes: RSI_REVOCATIONS_MAX_BYTES,',
        replacement: 'maxBytes: RSI_REVOCATIONS_MAX_BYTES * 8,',
      },
    ],
    tests: [T_LEDGER],
    expectRed: ['超过 1MiB → unreadable'],
    mustKill: ['超过 1MiB → unreadable'],
  },
  // ---- R21-6.11 判定顺序 ----
  {
    id: 'decide-phase-check-dropped',
    clause: 'R21-6.11 第 2 行(W0-3 订正):RSI_AUTO_PHASE < 2 → 无输出无写入(相位检查去掉)',
    edits: [drop(DECIDE, "!phaseAtLeast('V1b', i.phase) || ")],
    tests: [T_DECIDE, T_E2E],
    expectRed: [
      'RSI_AUTO_PHASE 为 1',
      '缺省相位',
      '第 2 行优先于探针:相位 1 时即使 probing 也不探',
      '[rsi.auto] 未开启 / codex / 相位 1 → 第 2 行:无 canary 输出、无账',
    ],
    mustKill: ['RSI_AUTO_PHASE 为 1'],
  },
  {
    id: 'decide-codex-not-excluded',
    clause: 'R21-6.1 / M4:codex 的 hint 永不进入分组路径',
    edits: [drop(DECIDE, " || i.agent === 'codex'")],
    tests: [T_DECIDE, T_E2E],
    expectRed: ['agent 为 codex'],
    mustKill: ['agent 为 codex'],
  },
  {
    id: 'decide-probe-ignores-pause',
    clause: 'W0-3 第 2a 行:探针要求 AUTO_PAUSE 不存在',
    edits: [{ file: DECIDE, anchor: "if (pause === 'absent') {", replacement: 'if (true) {' }],
    tests: [T_DECIDE, T_PART],
    expectRed: ['探针条件不成立', 'AUTO_PAUSE 在场 → 不消费票'],
    mustKill: ['AUTO_PAUSE 在场 → 不消费票'],
  },
  {
    id: 'decide-probe-ignores-expiry',
    clause: 'W0-3:探针只在 probe_expires_at 之前',
    edits: [drop(DECIDE, 'i.nowMs < Date.parse(e.probe_expires_at) &&')],
    tests: [T_DECIDE],
    expectRed: ['探针条件不成立'],
    mustKill: ['探针条件不成立'],
  },
  {
    id: 'decide-null-version-passes',
    clause: 'W0-3:agent_version 现算不出按不一致处理(不因 null == null 放行)',
    edits: [drop(DECIDE, 'i.agentVersion !== null &&')],
    tests: [T_DECIDE, T_E2E],
    expectRed: ['不因 null == null 通过', 'agent 版本现算不出'],
    mustKill: ['不因 null == null 通过'],
  },
  {
    id: 'decide-row4-order-changed',
    clause: 'R21-6.11 第 4 行:并列原因按固定顺序取第一个',
    edits: [
      {
        file: DECIDE,
        anchor: 'export const ROW4_ORDER: readonly Row4Reason[] = Object.freeze([',
        replacement: "export const ROW4_ORDER: readonly Row4Reason[] = Object.freeze(['revoked',",
      },
    ],
    tests: [T_DECIDE],
    expectRed: ['多个原因同时成立时按固定顺序'],
    mustKill: ['多个原因同时成立时按固定顺序'],
  },
  {
    id: 'decide-unreadable-ignored',
    clause: 'R21-6.11 第 4a 行:读不到 ≠ 不存在(读不到时仍随机)',
    edits: [
      off(
        DECIDE,
        "if (unknown) return { kind: 'excluded', row: '4a', reason: 'permit_unreadable', doc };",
      ),
    ],
    tests: [T_DECIDE, T_PART],
    expectRed: ['读不到 ≠ 不存在', '读不到许可'],
    mustKill: ['读不到 ≠ 不存在'],
  },
  {
    id: 'decide-revoked-by-id-only',
    clause: 'R21-6.10:撤销凭据按 (candidate_id, content_sha256) 命中(只比 id)',
    edits: [
      {
        file: DECIDE,
        anchor:
          '(l) => l.candidate_id === doc.candidate_id && l.content_sha256 === doc.content_sha256,',
        replacement: '(l) => l.candidate_id === doc.candidate_id,',
      },
    ],
    tests: [T_DECIDE],
    expectRed: ['只命中 id 不命中 content_sha256'],
    mustKill: ['只命中 id 不命中 content_sha256'],
  },
  // ---- R21-6.2 / 6.3 随机、输出、票 ----
  {
    id: 'hint-rng-range-unchecked',
    clause: 'R21-6.11 第 5 行:随机源报错 / 越界 → excluded rng_error',
    edits: [
      off(
        HINTP,
        "if (typeof u !== 'number' || !Number.isFinite(u) || u < 0 || u >= 1) return { ok: false };",
      ),
    ],
    tests: [T_PART],
    expectRed: ['账行 excluded/rng_error'],
    mustKill: ['账行 excluded/rng_error'],
  },
  {
    id: 'hint-treat-threshold-inverted',
    clause: 'R21-6.2:以概率 p 决定 treat(比较方向反了)',
    edits: [
      {
        file: HINTP,
        anchor: "arm: u < p ? 'treat' : 'control'",
        replacement: "arm: u > p ? 'treat' : 'control'",
      },
    ],
    tests: [T_PART],
    expectRed: ['随机为 treat', '随机为 control', 'treat 概率取该 agent 的 p'],
    mustKill: ['随机为 treat', '随机为 control'],
  },
  {
    id: 'probe-exhausted-returns-grant',
    // 原变异「去掉 hint 里的 `if (grant === null) return ''`」是等价变异:null 继续往下走会在 `grant.generation` 抛 TypeError,
    // 被 runCanaryPart 的外层 catch(第 8 行 fail-closed)吞成 '',可观察行为不变,故换成在源头让「票占满」仍给出伪票。
    clause:
      'W0-3:票全部被占 → 不输出(占满时 consumeProbeTicket 仍返回一张票号合法的伪票(重复票 1)→ 照常落账、输出;票号越界的伪票会被账行 schema 拒绝,等价于不输出,故不用)',
    edits: [
      {
        file: TICKET,
        anchor: '  return null;',
        replacement:
          '  return { ticket: `${entry.generation}-1`, generation: entry.generation, index: 1 };',
      },
    ],
    tests: [T_PART],
    expectRed: ['第 4 次不输出', '并发消费者至多 tickets 个成功'],
    mustKill: ['第 4 次不输出'],
  },
  {
    id: 'probe-eexist-fatal',
    clause: 'W0-3:EEXIST = 这张已被占,试下一张(把 EEXIST 当作致命错误)',
    edits: [off(TICKET, "if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;")],
    tests: [T_PART],
    expectRed: [
      '依次消费 3 张票',
      '并发消费者至多 tickets 个成功(6 个并发 → 恰好 3 个输出、3 行账、3 个占用文件)',
      '重新 armed(generation 加 1)后旧代的占用文件作废、不计入本代;旧代标记不被重用',
      '②之后崩溃的等价情形:账行追加失败 → 票已用、不输出(绝不重复授予)',
    ],
    mustKill: ['依次消费 3 张票'],
  },
  {
    id: 'probe-ticket-name-drops-generation',
    clause: 'W0-3:票号 <generation>-<i>,旧代的占用文件作废(文件名不含代数)',
    edits: [
      {
        file: FILES,
        anchor: 'return `${generation}-${i}.used`;',
        replacement: 'return `${i}.used`;',
      },
    ],
    tests: [T_PART],
    expectRed: [
      '重新 armed(generation 加 1)后旧代的占用文件作废',
      '依次消费 3 张票:每次输出仅含标记的一行 + 账行 excluded/admission_probe(candidate_id=null、marker 非空、p=0、背景指纹全零);第 4 次不输出',
      '②之后崩溃的等价情形:账行追加失败 → 票已用、不输出(绝不重复授予)',
    ],
    mustKill: ['重新 armed(generation 加 1)后旧代的占用文件作废'],
  },
  {
    id: 'doc-control-outputs-body',
    clause: 'R21-6.3:control 组只有标记行',
    edits: [
      {
        file: DOC,
        anchor:
          'export const controlText = (marker: string): string => `${markerLine(marker)}\\n`;',
        replacement:
          'export const controlText = (marker: string): string => `${markerLine(marker)}\\n${RSI_AUTO_LABEL}\\n`;',
      },
    ],
    tests: [T_DOC, T_PART],
    expectRed: [
      'control 只有标记行',
      ':只输出标记行,不含标签 / 哈希 / 正文;账行 arm=control',
      '两种组别的标记行都 ≤ 64 字节,不含路径 / 项目名',
    ],
    mustKill: ['control 只有标记行'],
  },
  {
    id: 'doc-body-marker-prefix-allowed',
    clause: 'R21-6.9:正文不得含 RSI_MARK_PREFIX(否则 reader 把它当又一个注入块)',
    edits: [off(DOC, "if (doc.body.includes(RSI_MARK_PREFIX)) return 'body_has_marker_prefix';")],
    tests: [T_DOC, T_WRITER, T_DECIDE],
    expectRed: ['每种违规一个固定短码', '正文含关联标记前缀'],
    mustKill: ['每种违规一个固定短码'],
  },
  {
    id: 'doc-treat-budget-removed',
    clause: 'M11:标记行 + 追加部分 ≤ 1536 字节',
    edits: [
      {
        file: DOC,
        anchor: 'if (byteLen(treatText(PLACEHOLDER_MARKER, doc)) > RSI_CANARY_INJECT_MAX_BYTES) {',
        replacement: 'if (false) {',
      },
    ],
    tests: [T_DOC, T_WRITER],
    expectRed: ['M11:treat 输出预算', 'treat 输出超过 1536 字节'],
    mustKill: ['M11:treat 输出预算'],
  },
  {
    id: 'doc-sha12-check-removed',
    clause: 'R21-6.3:content_sha12 = content_sha256 前 12 位',
    edits: [
      off(DOC, "if (doc.content_sha12 !== sha12Of(doc.content_sha256)) return 'sha12_mismatch';"),
    ],
    tests: [T_DOC],
    expectRed: ['每种违规一个固定短码'],
    mustKill: ['每种违规一个固定短码'],
  },
  // ---- hint 接线 ----
  {
    id: 'hint-canary-without-format-accepted',
    clause: 'R21-6.11:纯文本模式(无 --format)不走矩阵;--canary 只接在 --format 之后',
    edits: [off(HINT, "if (argv.length === 5 && argv[4] !== '--canary') return undefined;")],
    tests: [T_E2E],
    expectRed: ['--canary 必须带 --format'],
    mustKill: ['--canary 必须带 --format'],
  },
  {
    id: 'hint-canary-part-ignores-confirmed',
    clause: 'R21-6.11 第 1 行:状态 armed / off / stopped → 无 canary 输出',
    edits: [
      {
        file: HINT,
        anchor: "st.state === 'confirmed' && d.kind === 'ok'",
        replacement: "d.kind === 'ok'",
      },
    ],
    tests: [T_E2E],
    expectRed: ['状态不是 confirmed'],
    mustKill: ['状态不是 confirmed'],
  },
  {
    id: 'hint-default-phase-raised',
    clause: 'R21-0.1:缺省相位取代码常量(RSI_AUTO_PHASE = 0 时 canary 部分惰性;两处相位判断都改)',
    edits: [
      {
        file: HINT,
        anchor: 'phase: deps.phase ?? RSI_AUTO_PHASE,',
        replacement: 'phase: deps.phase ?? 2,',
      },
      {
        file: HINT,
        anchor: 'autoLoopEffective: isAutoLoopEffective(',
        replacement: 'autoLoopEffective: true || isAutoLoopEffective(',
      },
    ],
    tests: [T_E2E],
    expectRed: ['缺省相位', '[rsi.auto] 未开启 / codex / 相位 1 → 第 2 行:无 canary 输出、无账'],
    mustKill: ['缺省相位'],
  },
  // ---- W0-3 准入判定(worker) ----
  {
    id: 'admission-multi-marker-not-failed',
    clause: 'R21-6.6 / W0-3:任一会话取回 ≥ 2 个不同标记 → failed(multi_marker)',
    edits: [
      {
        file: PLAN,
        anchor: 'if (views.some((v) => v.sightings.some((s) => s.distinct_markers >= 2))) {',
        replacement: 'if (false) {',
      },
    ],
    tests: [T_ADM],
    expectRed: [
      '立即 failed(multi_marker)',
      '暂停 / 循环失效时不给 admitted(它是授予影响的前置),但失败照常判(只收紧)',
    ],
    mustKill: ['立即 failed(multi_marker)'],
  },
  {
    id: 'admission-quiet-threshold-dropped',
    clause: 'W0-3:会话已静止 ≥ RSI_PROBE_QUIET_MINUTES 才算(静止判据去掉)',
    edits: [
      { file: PLAN, anchor: 's.quiet_minutes >= RSI_PROBE_QUIET_MINUTES,', replacement: 'true,' },
    ],
    tests: [T_ADM],
    expectRed: ['静止恰好 60 分钟'],
    mustKill: ['静止恰好 60 分钟'],
  },
  {
    id: 'admission-unknown-quiet-accepted',
    clause: 'W0-3:静止时长不可知 → 不满足(fail-closed;去掉 null 检查并把 null 当作很久)',
    edits: [
      drop(PLAN, 's.quiet_minutes !== null &&'),
      {
        file: PLAN,
        anchor: 's.quiet_minutes >= RSI_PROBE_QUIET_MINUTES,',
        replacement: '(s.quiet_minutes ?? 9999) >= RSI_PROBE_QUIET_MINUTES,',
      },
    ],
    tests: [T_ADM],
    expectRed: ['静止时长不可知'],
    mustKill: ['静止时长不可知'],
  },
  {
    id: 'admission-shared-marker-accepted',
    clause: 'W0-3:每个标记被恰好一个会话取回(resume / fork 复制不算)',
    edits: [drop(PLAN, 'v.sightings.length === 1 &&')],
    tests: [T_ADM],
    expectRed: [
      '一个标记被两个会话取回',
      '某标记在其账行之后 48 小时仍无人取回 → failed(marker_not_retrieved);不足 48 小时 → 仍 probing',
    ],
    mustKill: ['一个标记被两个会话取回'],
  },
  {
    id: 'admission-old-generation-lines-counted',
    clause: 'W0-18:旧代探针行不计入本代(只认 probe_generation 等于当前代的行)',
    edits: [
      {
        file: PLAN,
        anchor: ' || l.probe_generation !== entry.generation',
        replacement: '',
      },
    ],
    tests: [T_ADM],
    expectRed: [
      '旧代的探针行',
      '旧代 / 越界票号(0、tickets+1)的行不计入本代:既不充数也不阻止本代 admitted',
      '旧代的重复票号不影响本代(只有本代的重复才算)',
      'W0-18:旧代迟到行让账里行数多于本代票数 → 既不充数也不阻挡本代 admitted',
    ],
    mustKill: ['旧代的探针行'],
  },
  {
    id: 'admission-wait-48h-dropped',
    clause: 'W0-3:标记 48 小时仍未取回 → failed(marker_not_retrieved)',
    edits: [
      { file: PLAN, anchor: 'nowMs >= v.atMs + RSI_PROBE_WAIT_HOURS * HOUR', replacement: 'false' },
    ],
    tests: [T_ADM],
    expectRed: ['48 小时仍无人取回'],
    mustKill: ['48 小时仍无人取回'],
  },
  {
    id: 'admission-admitted-while-paused',
    clause: 'W0-3 / R21-2.2:admitted 是授予影响的前置,暂停 / 循环失效时不给',
    edits: [
      {
        file: PLAN,
        anchor: "} else if (v.kind === 'admitted' && mayArm && facts !== undefined) {",
        replacement: "} else if (v.kind === 'admitted' && facts !== undefined) {",
      },
    ],
    tests: [T_ADM],
    expectRed: ['暂停 / 循环失效时不给 admitted'],
    mustKill: ['暂停 / 循环失效时不给 admitted'],
  },
  {
    id: 'admission-arm-ignores-pause',
    clause: 'W0-3:无 AUTO_PAUSE 时才 arm',
    edits: [drop(PLAN, ' && !i.autoPaused;')],
    tests: [T_ADM],
    expectRed: [
      '不 arm:',
      'probing 期间版本变了:旧版本的齐全证据不判 admitted,允许时重新 arm(generation + 1);暂停时原地等待',
      '暂停 / 循环失效时不给 admitted(它是授予影响的前置),但失败照常判(只收紧)',
      '满 7 日的自动重探仍受 arm 条件约束:暂停 / 循环无效 / 相位不足 / 版本不可知 / 钩子未装 → 不重探',
      '前台显式 rearm 才让版本未变、未满 7 日的 failed 重探',
    ],
    mustKill: ['不 arm:'],
  },
  {
    id: 'admission-arm-with-unknown-version',
    clause: 'W0-3:agent_version 不可知时不 arm',
    edits: [
      { file: PLAN, anchor: 'facts.agentVersion === null) return;', replacement: 'false) return;' },
    ],
    tests: [T_ADM],
    expectRed: [
      '不 arm:',
      '满 7 日的自动重探仍受 arm 条件约束:暂停 / 循环无效 / 相位不足 / 版本不可知 / 钩子未装 → 不重探',
    ],
    mustKill: ['不 arm:'],
  },
  {
    id: 'admission-failed-rearms-without-version-change',
    clause: 'W0-3 / W0-18:failed 未满 RSI_PROBE_RETRY_DAYS 且版本未变不自动重探',
    edits: [
      {
        file: PLAN,
        anchor: 'const versionsChanged = (e: AdmEntry, f: AgentFacts): boolean =>',
        replacement: 'const versionsChanged = (e: AdmEntry, f: AgentFacts): boolean => true ||',
      },
    ],
    tests: [T_ADM],
    expectRed: [
      'failed 未满 7 个 UTC 日且版本未变',
      'admitted 且版本未变',
      '3 张票的 3 个标记各被恰好一个会话取回、各会话只取回 1 个标记、静止 ≥ 60 分钟 → admitted(decided_at = 当前)',
      '静止恰好 60 分钟 → admitted;59 分钟 → 仍 probing',
      '静止时长不可知(null)→ 不 admitted(fail-closed)',
      '只有 2 行探针账 → 不 admitted',
      '一个标记被两个会话取回(resume / fork 复制)→ 不 admitted',
      '某标记在其账行之后 48 小时仍无人取回 → failed(marker_not_retrieved);不足 48 小时 → 仍 probing',
      '旧代的探针行(probe_generation ≠ 当前代)不计入:新 arm 之后没有本代行 → 不 admitted',
      '按代号而不是时间认行:本代的行即使 at 早于 armed_at 也计入(W0-18 取代时间窗)',
      '旧代 / 越界票号(0、tickets+1)的行不计入本代:既不充数也不阻止本代 admitted',
      '旧代的重复票号不影响本代(只有本代的重复才算)',
      '票号缺一(1、2 号齐,3 号没有行)→ 不 admitted',
      '其它 agent 的探针行不计入 claude',
      'W0-18:本代只有两行、旧代 hint 迟到落的行带旧代号 → 不替本代凑数,不 admitted',
      'W0-18:旧代迟到行让账里行数多于本代票数 → 既不充数也不阻挡本代 admitted',
      '已 admitted 之后本代出现重复探针票号 → failed(multi_marker);探针窗口到期本身不撤销',
      'failed 满 RSI_PROBE_RETRY_DAYS(7)个 UTC 日 → 自动重新 armed 下一代;按日期差,与时刻无关',
      'failed 满 6 个 UTC 日(11-04 00:00 起算)→ 仍不重探',
      'failed 的 decided_at 缺失 / 不可解析 → 不自动重探(fail-closed)',
      '有变化才写:0600、schema 合法;第二次(无变化)返回 unchanged 且文件逐字节不变',
    ],
    mustKill: ['failed 未满 7 个 UTC 日且版本未变'],
  },
  {
    id: 'admission-ticket-out-of-range-counted',
    clause: 'W0-18:probe_ticket 在 1..tickets 之外的行不计入本代',
    edits: [
      {
        file: PLAN,
        anchor:
          'if (l.probe_ticket === null || l.probe_ticket < 1 || l.probe_ticket > entry.tickets) continue;',
        replacement: 'if (l.probe_ticket === null) continue;',
      },
    ],
    tests: [T_ADM],
    expectRed: ['旧代 / 越界票号'],
    mustKill: ['旧代 / 越界票号'],
  },
  {
    id: 'admission-duplicate-ticket-ignored',
    clause: 'W0-18:同一 (probe_generation, probe_ticket) 出现两行 → failed(multi_marker)',
    edits: [drop(PLAN, 'new Set(lines.map((l) => l.ticket)).size !== lines.length ||')],
    tests: [T_ADM],
    expectRed: [
      '同一 (probe_generation, probe_ticket) 出现两行',
      '已 admitted 之后本代出现重复探针票号 → failed(multi_marker);探针窗口到期本身不撤销',
    ],
    mustKill: ['同一 (probe_generation, probe_ticket) 出现两行'],
  },
  {
    id: 'admission-duplicate-marker-ignored',
    clause: 'W0-18:同一标记落在两个票号的行上 → failed(multi_marker)(更少影响方向)',
    edits: [
      {
        file: PLAN,
        anchor: 'new Set(lines.map((l) => l.marker)).size !== lines.length',
        replacement: 'false',
      },
    ],
    tests: [T_ADM],
    expectRed: ['同一标记落在两个票号的行上'],
    mustKill: ['同一标记落在两个票号的行上'],
  },
  {
    id: 'admission-admitted-duplicate-evidence-ignored',
    clause: 'W0-18:已准入后本代出现重复探针票号 / 标记 → failed(multi_marker)',
    edits: [
      {
        file: PLAN,
        anchor: 'hasDuplicateProbeEvidence(probeLinesOf(agent, e, i.ledger))',
        replacement: 'false',
      },
    ],
    tests: [T_ADM],
    expectRed: ['已 admitted 之后本代出现重复探针票号'],
    mustKill: ['已 admitted 之后本代出现重复探针票号'],
  },
  {
    id: 'admission-retry-never',
    clause: 'W0-18:failed 满 RSI_PROBE_RETRY_DAYS 个 UTC 日自动重新 armed 下一代',
    edits: [drop(PLAN, "else if (retryDue(e, nowMs)) arm('retry');")],
    tests: [T_ADM],
    expectRed: ['自动重新 armed 下一代', '每种 failed 原因满 7 日'],
    mustKill: ['自动重新 armed 下一代'],
  },
  {
    id: 'admission-retry-too-early',
    clause: 'W0-18:满 7 个 UTC 日(日期差口径),不足 7 日不重探',
    edits: [
      {
        file: PLAN,
        anchor: 'iso(at).slice(0, 10)) >= RSI_PROBE_RETRY_DAYS;',
        replacement: 'iso(at).slice(0, 10)) >= RSI_PROBE_RETRY_DAYS - 1;',
      },
    ],
    tests: [T_ADM],
    expectRed: ['满 6 个 UTC 日'],
    mustKill: ['满 6 个 UTC 日'],
  },
  {
    id: 'admission-retry-ignores-arm-conditions',
    clause: 'W0-18:自动重探仍要其余 armed 条件成立(暂停 / 循环无效等不重探)',
    edits: [
      {
        file: PLAN,
        anchor: 'if (mayArm && facts !== undefined) {',
        replacement: 'if (facts !== undefined) {',
      },
    ],
    tests: [T_ADM],
    expectRed: [
      '满 7 日的自动重探仍受 arm 条件约束',
      '前台显式 rearm 才让版本未变、未满 7 日的 failed 重探',
    ],
    mustKill: ['满 7 日的自动重探仍受 arm 条件约束'],
  },
  {
    id: 'admission-retry-bad-decided-at',
    clause: 'W0-18:decided_at 不可解析 → 不自动重探(fail-closed)',
    edits: [off(PLAN, 'if (!Number.isFinite(at)) return false;')],
    tests: [T_ADM],
    expectRed: ['decided_at 缺失 / 不可解析'],
    mustKill: ['decided_at 缺失 / 不可解析'],
  },
  {
    id: 'probe-line-generation-not-bound',
    clause: 'W0-18:探针账行的 probe_generation 取占到的票的代号',
    edits: [{ file: HINTP, anchor: 'generation: grant.generation', replacement: 'generation: 0' }],
    tests: [T_PART],
    expectRed: ['依次消费 3 张票', '重新 armed(generation 加 1)后旧代的占用文件作废'],
    mustKill: ['依次消费 3 张票'],
  },
  {
    id: 'probe-line-ticket-not-bound',
    clause: 'W0-18:探针账行的 probe_ticket 取占到的票序 i',
    edits: [{ file: HINTP, anchor: 'ticket: grant.index', replacement: 'ticket: 1' }],
    tests: [T_PART],
    expectRed: [
      '依次消费 3 张票',
      '重新 armed(generation 加 1)后旧代的占用文件作废、不计入本代;旧代标记不被重用',
    ],
    mustKill: ['依次消费 3 张票'],
  },
  {
    id: 'hint-overlaps-preset-not-copied',
    clause: 'W0-18:hint 把 canary.json 的 overlaps_preset 原样抄进 treat / control 账行',
    edits: [
      {
        file: HINTP,
        anchor: 'overlaps_preset: f.doc?.overlaps_preset ?? false,',
        replacement: 'overlaps_preset: false,',
      },
    ],
    tests: [T_PART],
    expectRed: ['overlaps_preset 原样抄自 canary.json'],
    mustKill: ['overlaps_preset 原样抄自 canary.json'],
  },
  {
    id: 'writer-overlaps-preset-not-from-record',
    clause: 'W0-18:canary.json 的 overlaps_preset 取该候选 G4 结果(权威记录)',
    edits: [
      {
        file: WRITER,
        anchor: 'overlaps_preset: rec.overlaps_preset,',
        replacement: 'overlaps_preset: false,',
      },
    ],
    tests: [T_WRITER],
    expectRed: ['overlaps_preset 取权威记录里该候选 G4 的结果'],
    mustKill: ['overlaps_preset 取权威记录里该候选 G4 的结果'],
  },
  {
    id: 'admission-probing-version-change-ignored',
    clause: 'W0-3:probing 期间版本变化不得用旧版本证据判 admitted',
    edits: [
      {
        file: PLAN,
        anchor: '} else if (facts !== undefined && versionsChanged(e, facts)) {',
        replacement: '} else if (false) {',
      },
    ],
    tests: [T_ADM],
    expectRed: ['probing 期间版本变了'],
    mustKill: ['probing 期间版本变了'],
  },
  {
    id: 'admission-success-before-expiry',
    clause: 'W0-3:probe_expires_at 到期仍未凑齐 → failed(到期先于成功)',
    edits: [
      {
        file: PLAN,
        anchor: 'if (nowMs >= Date.parse(entry.probe_expires_at)) {',
        replacement: 'if (false) {',
      },
    ],
    tests: [T_ADM],
    expectRed: [
      '到期先于成功',
      'probe_expires_at 到期仍未凑齐 → failed(probe_expired);到期当刻也算',
    ],
    mustKill: ['到期先于成功'],
  },
  {
    id: 'admission-corrupt-file-overwritten',
    clause: 'W0-3:唯一写入方;损坏的准入文件不被静默替换',
    edits: [
      off(
        AWRITE,
        "if (cur.kind === 'unreadable') return { kind: 'blocked', why: 'admission_file_unreadable' };",
      ),
    ],
    tests: [T_ADM],
    expectRed: ['现有准入文件不合规'],
    mustKill: ['现有准入文件不合规'],
  },
  {
    id: 'grant-barrier-removed',
    clause: 'R21-9.5:全部凭据对账完成前不做任何授予(去掉统一对账屏障)',
    edits: [{ file: WRITER, anchor: 'if (!barrier.ok) return', replacement: 'if (false) return' }],
    tests: [T_WRITER],
    expectRed: [
      '对账屏障(R21-9.5)',
      '对账屏障:有凭据而分组账不存在 / 为空 → 拒绝授予(账不存在不等于已补 stop);reconcileCaches 补 stop 后允许',
      '对账屏障:凭据列出的候选权威记录仍非终态 → 拒绝授予别的候选;账不合规同样拒绝',
      '空凭据集 + 不合规账 → 拒绝授予(坏账不因没有凭据而绕过);空凭据集 + 账不存在 → 允许',
      '不可读缓存恢复:坏 JSON 缓存 + 已对账的历史凭据 → 授予被拒;对账清理移除不可读缓存后可恢复',
    ],
    mustKill: ['对账屏障(R21-9.5)'],
  },
  {
    id: 'grant-barrier-ignores-cache-residual',
    clause: 'R21-9.5:canary.json 残留被凭据列出的条目 = 未对账',
    edits: [
      { file: WRITER, anchor: 'pending.push(`${ref}:cache_residual`);', replacement: 'void 0;' },
    ],
    tests: [T_WRITER],
    expectRed: ['对账屏障(R21-9.5)'],
    mustKill: ['对账屏障(R21-9.5)'],
  },
  {
    id: 'grant-barrier-ignores-stop-missing',
    clause: 'R21-9.5:分组账缺 stop 行 = 未对账',
    edits: [
      {
        file: WRITER,
        anchor: 'if (!stops.has(ref)) pending.push(`${ref}:stop_missing`);',
        replacement: 'void 0;',
      },
    ],
    tests: [T_WRITER],
    // R21-9.5 原用例的残留缓存本身就拦住授予,独立钉住「缺 stop 行」的是「有凭据而分组账不存在 / 为空」(主代理验收复评 H4-R)
    expectRed: ['对账屏障:有凭据而分组账不存在'],
    mustKill: ['对账屏障:有凭据而分组账不存在'],
  },
  {
    id: 'grant-barrier-stop-only-when-ledger-exists',
    clause: 'R21-9.5:账不存在 ≠ 已补 stop(主代理验收复评 H4-R)—— 变异:只在账存在时检查',
    edits: [
      {
        file: WRITER,
        anchor: 'if (!stops.has(ref)) pending.push(`${ref}:stop_missing`);',
        replacement:
          "if (ledger.kind === 'ok' && !stops.has(ref)) pending.push(`${ref}:stop_missing`);",
      },
    ],
    tests: [T_WRITER],
    expectRed: ['有凭据而分组账不存在'],
    mustKill: ['有凭据而分组账不存在'],
  },
  {
    id: 'grant-barrier-ignores-nonterminal',
    clause: 'R21-9.5:凭据列出的候选权威记录仍非终态 = 未对账',
    edits: [
      {
        file: WRITER,
        anchor: 'pending.push(`${ref}:record_not_terminal`);',
        replacement: 'void 0;',
      },
    ],
    tests: [T_WRITER],
    expectRed: ['仍非终态'],
    mustKill: ['仍非终态'],
  },
  {
    id: 'shadow-observe-swallows-lock-lost',
    clause: '既有停止语义:锁丢失原样传播,不被映射成事实不可得',
    edits: [
      { file: SFACTS, anchor: 'if (e instanceof RsiLockError) throw e;', replacement: 'void 0;' },
    ],
    tests: [T_SHADOW],
    expectRed: ['M3 observer 抛 lock_lost'],
    mustKill: ['M3 observer 抛 lock_lost'],
  },
  {
    id: 'grant-barrier-ledger-check-inside-loop',
    clause: 'R21-9.5:账不合规不得因凭据集为空而绕过屏障',
    edits: [
      {
        file: WRITER,
        anchor: "if (ledger.kind === 'invalid') pending.push('ledger_invalid');",
        replacement: 'void 0;',
      },
    ],
    tests: [T_WRITER],
    expectRed: ['空凭据集 + 不合规账'],
    mustKill: ['空凭据集 + 不合规账'],
  },
  {
    id: 'reconcile-keeps-unreadable-cache',
    clause: 'R21-9.5:不可读缓存可由对账清理收口,否则屏障永远拒绝授予',
    edits: [
      {
        file: WRITER,
        anchor: "cur.kind === 'unreadable' ||",
        replacement: 'false ||',
      },
    ],
    tests: [T_WRITER],
    expectRed: ['不可读缓存'],
    mustKill: ['不可读缓存'],
  },
  // ---- shadow 计数(W0-2 / W0-13 / R21-1.7 / R21-3.8) ----
  {
    id: 'shadow-facts-fail-open',
    clause: 'R21-1.5:计数事实不可得不得按「通过」处理(null 被放过)',
    edits: [
      {
        file: SFACTS,
        anchor: 'if (c === null) return null;',
        replacement: 'if (c === null) return pf;',
      },
    ],
    tests: [T_SHADOW],
    expectRed: ['withShadowCounts'],
    mustKill: ['withShadowCounts'],
  },
  {
    id: 'shadow-entered-at-first-not-last',
    clause: 'W0-13:窗口起点 = 进入 shadow 的那条转移(取最后一条)',
    edits: [
      {
        file: SCOUNT,
        anchor: 'for (let i = rec.transitions.length - 1; i >= 0; i--) {',
        replacement: 'for (let i = 0; i < rec.transitions.length; i++) {',
      },
    ],
    tests: [T_SHADOW],
    expectRed: ['shadowEnteredAt:窗口起点'],
    mustKill: ['shadowEnteredAt:窗口起点'],
  },
  {
    id: 'shadow-sessions-not-deduped',
    clause: 'R21-1.7:会话按 session_ref 去重',
    edits: [off(SCOUNT, 'if (seen.has(s.session_ref)) continue;')],
    tests: [T_SHADOW],
    expectRed: ['hits 是命中会话数'],
    mustKill: ['hits 是命中会话数'],
  },
  {
    id: 'shadow-ready-session-threshold-dropped',
    clause: 'R21-4.1:首次达标需 ≥ 20 有观测会话',
    edits: [drop(SCOUNT, 'upTo.length >= RSI_SHADOW_MIN_SESSIONS &&')],
    tests: [T_SHADOW],
    expectRed: [
      '未达标 → null',
      '首次达标日 = 同时满足 ≥ 20 会话且命中 ≥ 2 的最早 UTC 日',
      '同一天的多个会话按当日全部会话之后的累计值判定',
      'ReadySinceRecovery:历史里能证明达标的最早 UTC 日;未达标 / 读失败 / 无起点 → null',
    ],
    mustKill: ['未达标 → null'],
  },
  {
    id: 'shadow-tool-class-ignored',
    clause: 'W0-2:签名带 tool_error_class 时只收窄不放宽',
    edits: [
      {
        file: SCOUNT,
        anchor: '(signature.tool_error_class === undefined ||',
        replacement: '(true ||',
      },
    ],
    tests: [T_SHADOW],
    expectRed: ['只收窄不放宽'],
    mustKill: ['只收窄不放宽'],
  },
  {
    id: 'shadow-lesson-jaccard-zero',
    clause: 'W0-2:教训类命中判据 token Jaccard ≥ RSI_LESSON_JACCARD',
    edits: [{ file: SCOUNT, anchor: '>= RSI_LESSON_JACCARD', replacement: '>= 0' }],
    tests: [T_SHADOW],
    expectRed: ['lesson 签名'],
    mustKill: ['lesson 签名'],
  },
  {
    id: 'shadow-observe-multi-marker-counted',
    clause: 'R21-1.7 ③ / R21-6.6:多标记会话不计入有观测会话',
    edits: [off(SOBS, "if (kind === 'multi_marker') continue;")],
    tests: [T_SHADOW],
    expectRed: ['「有观测会话」资格'],
    mustKill: ['「有观测会话」资格'],
  },
  {
    id: 'shadow-observe-unlinked-marker-counted',
    clause: 'R21-1.7 ③:被随机的会话须能经标记在分组账里关联',
    edits: [off(SOBS, 'if (m === undefined || !markers.has(m)) continue;')],
    tests: [T_SHADOW],
    expectRed: ['「有观测会话」资格'],
    mustKill: ['「有观测会话」资格'],
  },
  {
    id: 'shadow-observe-excluded-project-counted',
    clause: 'R21-1.7 ②:属「采集中」项目(X / U 不计)',
    edits: [off(SOBS, "if ((await d.classify(s.project_key)) !== 'P') continue;")],
    tests: [T_SHADOW],
    expectRed: ['「有观测会话」资格'],
    mustKill: ['「有观测会话」资格'],
  },
  {
    id: 'shadow-observe-schema-drop-ignored',
    clause: 'R21-1.5:信号库行不合 schema 属事实不可得,不得静默丢弃后照常计数',
    edits: [
      {
        file: SOBS,
        anchor: 'if (loaded.stats.dropped_schema > 0)',
        replacement: 'if (false)',
      },
    ],
    tests: [T_SHADOW],
    expectRed: ['JSON 合法但不合 schema'],
    mustKill: ['JSON 合法但不合 schema'],
  },
  {
    id: 'step-rebuild-counts-not-recomputed',
    clause: 'R21-3.8 / W3 遗留:重建工作副本后 sessions / hits 由计数重算',
    edits: [
      {
        file: STEP,
        anchor: 'counted = await d.shadowCounts.count(rec);',
        replacement: 'counted = null;',
      },
    ],
    tests: [T_SHADOW],
    expectRed: [
      '重建后 sessions / hits 取自计数端口',
      'M3 observer 抛 lock_lost 原样传播:ShadowCountPort / ReadySinceRecovery 抛出,步骤立即 halted=lock_lost;普通错误仍映射 null',
      '计数端口里丢锁(RsiLockError lock_lost)→ 步骤以 lock_lost 中止',
    ],
    mustKill: ['重建后 sessions / hits 取自计数端口'],
  },
];

/** 执行变异后由主代理回填;W5 实装块不执行变异,故留空 */
/** 实测结果:r21w5-mfinal @ seal,727d5de,74/74 被杀(1 条表外多红已补 expectRed) */
export const V1_W5_RESULTS: readonly V1W5Result[] = [
  {
    id: 'm13-4-grant-slot-check-removed',
    failed: 1,
    skipped: 0,
    killedBy: [
      'grantCanary:授予 M13-4 名额互斥:别的候选已占用评估名额(canary)→ 拒绝;候选自己在 canary 不算占用',
    ],
    restored: true,
  },
  {
    id: 'm13-4-grant-slot-counts-self',
    failed: 17,
    skipped: 0,
    killedBy: [
      'grantCanary:授予 overlaps_preset 取权威记录里该候选 G4 的结果(调用方不能自带);true / false 各一',
      'grantCanary:授予 成功:0600、十二键齐全、generation 从 1 起、revocation_gen = 写入时撤销凭据的行数;再次授予 generation + 1',
      'grantCanary:授予 对账先于授予:撤销凭据列出该候选 → 拒绝、不写;列的是别的候选 / 别的内容哈希 → 不影响',
      'grantCanary:授予 对账屏障(R21-9.5):A 已终态但 canary.json 残留、stop 行未补 → 授予 B 被拒;对账完成后允许',
      'grantCanary:授予 对账屏障:有凭据而分组账不存在 / 为空 → 拒绝授予(账不存在不等于已补 stop);reconcileCaches 补 stop 后允许',
      'grantCanary:授予 空凭据集 + 不合规账 → 拒绝授予(坏账不因没有凭据而绕过);空凭据集 + 账不存在 → 允许',
      'grantCanary:授予 不可读缓存恢复:坏 JSON 缓存 + 已对账的历史凭据 → 授予被拒;对账清理移除不可读缓存后可恢复',
      'grantCanary:授予 M13-4 名额互斥:别的候选已占用评估名额(canary)→ 拒绝;候选自己在 canary 不算占用',
      'grantCanary:授予 文档越界不写:正文含关联标记前缀',
      'grantCanary:授予 文档越界不写:treat 输出超过 1536 字节',
      'grantCanary:授予 文档越界不写:在列的 agent 没有 p',
      'grantCanary:授予 文档越界不写:p_by_agent 有多余项',
      'grantCanary:授予 正文只取权威来源:来源给不出(null / 抛错)→ 拒绝、不写;写进文件的正文就是来源给的那一份',
      'grantCanary:授予 写点之前复核两把锁:任一把在写阶段丢失 → 抛错、没有 canary.json(也没有残留临时文件)',
      'muteCanary / removeCanary:只收紧 muteCanary(AUTO_PAUSE / 熔断):置为不注入、generation + 1;已不注入 / 无文件 → 不写',
      'muteCanary / removeCanary:只收紧 muteCanary 不需要 personal 锁,但需要 rsi 锁:丢锁 → 抛错、文件不变',
      'muteCanary / removeCanary:只收紧 removeCanary:删除缓存文件;丢锁 → 不删',
    ],
    restored: true,
  },
  {
    id: 'grant-reconcile-removed',
    failed: 1,
    skipped: 0,
    killedBy: [
      'grantCanary:授予 对账先于授予:撤销凭据列出该候选 → 拒绝、不写;列的是别的候选 / 别的内容哈希 → 不影响',
    ],
    restored: true,
  },
  {
    id: 'grant-revocations-invalid-ignored',
    failed: 1,
    skipped: 0,
    killedBy: ['grantCanary:授予 撤销凭据读不到(invalid)→ 拒绝、不写(不是「没有撤销」)'],
    restored: true,
  },
  {
    id: 'grant-lock-not-rechecked-at-write',
    failed: 1,
    skipped: 0,
    killedBy: [
      'grantCanary:授予 写点之前复核两把锁:任一把在写阶段丢失 → 抛错、没有 canary.json(也没有残留临时文件)',
    ],
    restored: true,
  },
  {
    id: 'ledger-append-failure-swallowed',
    failed: 3,
    skipped: 0,
    killedBy: [
      '合成输出 未落账不注入:账路径不可追加 → 只剩计数行,标记与正文都不出现',
      '第 8 行:未落账不注入 账行追加失败 → 不输出(treat 与 control 都一样),标记与正文都不泄漏',
      '第 2a 行:探针票(W0-3) ②之后崩溃的等价情形:账行追加失败 → 票已用、不输出(绝不重复授予)',
    ],
    restored: true,
  },
  {
    id: 'ledger-schema-skipped',
    failed: 11,
    skipped: 0,
    killedBy: [
      '分组账行 schema(R21-6.4) 非法行被拒绝、不落盘:reason=revocation_reconciled 而 revocation_ref 为 null',
      '分组账行 schema(R21-6.4) 非法行被拒绝、不落盘:普通 stop 行带 revocation_ref',
      '分组账行 schema(R21-6.4) 非法行被拒绝、不落盘:excluded 行 p 不为 0',
      '分组账行 schema(R21-6.4) 非法行被拒绝、不落盘:excluded 行带 marker(非探针)',
      '分组账行 schema(R21-6.4) 非法行被拒绝、不落盘:admission_probe 行没有 marker',
      '分组账行 schema(R21-6.4) 非法行被拒绝、不落盘:admission_probe 行带 candidate_id',
      '分组账行 schema(R21-6.4) 非法行被拒绝、不落盘:treat 行 p 为 0',
      '分组账行 schema(R21-6.4) 非法行被拒绝、不落盘:treat 行带 reason',
      '分组账行 schema(R21-6.4) 非法行被拒绝、不落盘:control 行没有 marker',
      '分组账行 schema(R21-6.4) 非法行被拒绝、不落盘:agent 是 codex',
      '分组账行 schema(R21-6.4) 非法行被拒绝、不落盘:未知 reason',
    ],
    restored: true,
  },
  {
    id: 'ledger-stop-ref-dedupe-removed',
    failed: 1,
    skipped: 0,
    killedBy: [
      'stop 行与读取(R21-6.4 / R21-9.5) 同一 revocation_ref 至多一行;不同 ref 各一行;普通 stop 行(ref=null)不去重',
    ],
    restored: true,
  },
  {
    id: 'ledger-append-on-invalid-ledger',
    failed: 1,
    skipped: 0,
    killedBy: ['stop 行与读取(R21-6.4 / R21-9.5) 分组账不合规时不在其上追加(抛错、文件逐字节不变)'],
    restored: true,
  },
  {
    id: 'revocations-size-cap-widened',
    failed: 1,
    skipped: 0,
    killedBy: [
      '许可读取(R21-6.10):读不到 ≠ 不存在 撤销凭据:合法行 ok;超过 1MiB → unreadable(不是「没有撤销」);坏行 → unreadable',
    ],
    restored: true,
  },
  {
    id: 'decide-phase-check-dropped',
    failed: 3,
    skipped: 0,
    killedBy: [
      '第 2 行:自动循环 / 相位 / codex RSI_AUTO_PHASE 为 1(< 2,未到 V1b)→ none(2),不读输入',
      '第 2a 行:探针先于候选存在性检查 第 2 行优先于探针:相位 1 时即使 probing 也不探',
      '第 1 / 2 行:惰性 [rsi.auto] 未开启 / codex / 相位 1 → 第 2 行:无 canary 输出、无账',
    ],
    restored: true,
  },
  {
    id: 'decide-codex-not-excluded',
    failed: 1,
    skipped: 0,
    killedBy: ['第 2 行:自动循环 / 相位 / codex agent 为 codex → none(2),不读输入'],
    restored: true,
  },
  {
    id: 'decide-probe-ignores-pause',
    failed: 3,
    skipped: 0,
    killedBy: [
      '第 2a 行:探针先于候选存在性检查 探针条件不成立(AUTO_PAUSE 在场)→ 不是 probe,继续走第 3 行',
      '第 2a 行:探针先于候选存在性检查 探针条件不成立(AUTO_PAUSE 读取失败)→ 不是 probe,继续走第 3 行',
      '第 2a 行:探针票(W0-3) 探针只在 AUTO_PAUSE 不存在时:AUTO_PAUSE 在场 → 不消费票',
    ],
    restored: true,
  },
  {
    id: 'decide-probe-ignores-expiry',
    failed: 1,
    skipped: 0,
    killedBy: [
      '第 2a 行:探针先于候选存在性检查 探针条件不成立(已过期(now = probe_expires_at))→ 不是 probe,继续走第 3 行',
    ],
    restored: true,
  },
  {
    id: 'decide-null-version-passes',
    failed: 1,
    skipped: 0,
    killedBy: [
      '第 2a 行:探针先于候选存在性检查 条目的 agent_version 为 null、现算也是 null:不放行(不因 null == null 通过)',
    ],
    restored: true,
  },
  {
    id: 'decide-row4-order-changed',
    failed: 1,
    skipped: 0,
    killedBy: ['第 4 行:已知候选的排除原因(固定顺序) 多个原因同时成立时按固定顺序取第一个'],
    restored: true,
  },
  {
    id: 'decide-unreadable-ignored',
    failed: 4,
    skipped: 0,
    killedBy: [
      '第 4a 行:读不到 ≠ 不存在 撤销凭据读取失败(含超过 1MiB)→ permit_unreadable,不是「没有撤销」',
      '第 4a 行:读不到 ≠ 不存在 准入文件读取失败 → permit_unreadable,不是 not_admitted',
      '第 4a 行:读不到 ≠ 不存在 AUTO_PAUSE 读取失败 → permit_unreadable,不是 paused 也不是「无暂停」',
      '第 4 / 4a 行:排除账行 读不到许可 → permit_unreadable 一行,不随机、不输出',
    ],
    restored: true,
  },
  {
    id: 'decide-revoked-by-id-only',
    failed: 1,
    skipped: 0,
    killedBy: [
      '第 4 行:已知候选的排除原因(固定顺序) 撤销凭据只命中 id 不命中 content_sha256、或只命中 sha 不命中 id → 不算撤销(负向)',
    ],
    restored: true,
  },
  {
    id: 'hint-rng-range-unchecked',
    failed: 3,
    skipped: 0,
    killedBy: [
      '第 5 行:随机源报错 随机源NaN → 账行 excluded/rng_error(marker=null、p=0),不输出',
      '第 5 行:随机源报错 随机源等于 1(越界) → 账行 excluded/rng_error(marker=null、p=0),不输出',
      '第 5 行:随机源报错 随机源负数 → 账行 excluded/rng_error(marker=null、p=0),不输出',
    ],
    restored: true,
  },
  {
    id: 'hint-treat-threshold-inverted',
    failed: 3,
    skipped: 0,
    killedBy: [
      '第 6 / 7 行:随机、分组账、输出 随机为 treat(u < p):输出 标记行 + 标签行 + 哈希前 12 位 + 正文;账行 arm=treat、p、背景指纹来自 canary.json',
      '第 6 / 7 行:随机、分组账、输出 随机为 control(u ≥ p,u=0.9):只输出标记行,不含标签 / 哈希 / 正文;账行 arm=control',
      '第 6 / 7 行:随机、分组账、输出 treat 概率取该 agent 的 p:p=1 时任何 u ∈ [0,1) 都是 treat',
    ],
    restored: true,
  },
  {
    id: 'probe-exhausted-returns-grant',
    failed: 2,
    skipped: 0,
    killedBy: [
      '第 2a 行:探针票(W0-3) 依次消费 3 张票:每次输出仅含标记的一行 + 账行 excluded/admission_probe(candidate_id=null、marker 非空、p=0、背景指纹全零);第 4 次不输出',
      '第 2a 行:探针票(W0-3) 并发消费者至多 tickets 个成功(6 个并发 → 恰好 3 个输出、3 行账、3 个占用文件)',
    ],
    restored: true,
  },
  {
    id: 'probe-eexist-fatal',
    failed: 4,
    skipped: 0,
    killedBy: [
      '第 2a 行:探针票(W0-3) 依次消费 3 张票:每次输出仅含标记的一行 + 账行 excluded/admission_probe(candidate_id=null、marker 非空、p=0、背景指纹全零);第 4 次不输出',
      '第 2a 行:探针票(W0-3) 并发消费者至多 tickets 个成功(6 个并发 → 恰好 3 个输出、3 行账、3 个占用文件)',
      '第 2a 行:探针票(W0-3) 重新 armed(generation 加 1)后旧代的占用文件作废、不计入本代;旧代标记不被重用',
      '第 2a 行:探针票(W0-3) ②之后崩溃的等价情形:账行追加失败 → 票已用、不输出(绝不重复授予)',
    ],
    restored: true,
  },
  {
    id: 'probe-ticket-name-drops-generation',
    failed: 3,
    skipped: 0,
    killedBy: [
      '第 2a 行:探针票(W0-3) 依次消费 3 张票:每次输出仅含标记的一行 + 账行 excluded/admission_probe(candidate_id=null、marker 非空、p=0、背景指纹全零);第 4 次不输出',
      '第 2a 行:探针票(W0-3) 重新 armed(generation 加 1)后旧代的占用文件作废、不计入本代;旧代标记不被重用',
      '第 2a 行:探针票(W0-3) ②之后崩溃的等价情形:账行追加失败 → 票已用、不输出(绝不重复授予)',
    ],
    restored: true,
  },
  {
    id: 'doc-control-outputs-body',
    failed: 4,
    skipped: 0,
    killedBy: [
      '渲染 control 只有标记行;treat 在其后依次是 R21-1.9 标签、内容哈希前 12 位、正文',
      '第 6 / 7 行:随机、分组账、输出 随机为 control(u ≥ p,u=0.5):只输出标记行,不含标签 / 哈希 / 正文;账行 arm=control',
      '第 6 / 7 行:随机、分组账、输出 随机为 control(u ≥ p,u=0.9):只输出标记行,不含标签 / 哈希 / 正文;账行 arm=control',
      '第 6 / 7 行:随机、分组账、输出 两种组别的标记行都 ≤ 64 字节,不含路径 / 项目名',
    ],
    restored: true,
  },
  {
    id: 'doc-body-marker-prefix-allowed',
    failed: 3,
    skipped: 0,
    killedBy: [
      '第 3 行:没有合法候选 正文含关联标记前缀 → none(3),不读撤销凭据',
      '语义校验的短码 合法文档 → null;每种违规一个固定短码',
      'grantCanary:授予 文档越界不写:正文含关联标记前缀',
    ],
    restored: true,
  },
  {
    id: 'doc-treat-budget-removed',
    failed: 2,
    skipped: 0,
    killedBy: [
      'M11:treat 输出预算 ≤ 1536 字节(含标记行与末尾换行) 边界:恰好 1536 字节通过,多 1 字节被拒',
      'grantCanary:授予 文档越界不写:treat 输出超过 1536 字节',
    ],
    restored: true,
  },
  {
    id: 'doc-sha12-check-removed',
    failed: 1,
    skipped: 0,
    killedBy: ['语义校验的短码 合法文档 → null;每种违规一个固定短码'],
    restored: true,
  },
  {
    id: 'hint-canary-without-format-accepted',
    failed: 1,
    skipped: 0,
    killedBy: [
      '第 1 / 2 行:惰性 --canary 必须带 --format(纯文本模式不走矩阵):参数错误 → 空串、零写入',
    ],
    restored: true,
  },
  {
    id: 'hint-canary-part-ignores-confirmed',
    failed: 1,
    skipped: 0,
    killedBy: ['第 1 / 2 行:惰性 状态不是 confirmed(armed)→ 第 1 行:没有 canary 部分、没有账'],
    restored: true,
  },
  {
    id: 'hint-default-phase-raised',
    failed: 2,
    skipped: 0,
    killedBy: [
      '第 1 / 2 行:惰性 缺省相位(RSI_AUTO_PHASE = 0)→ canary 部分惰性:只有计数行、不碰分组账',
      '第 1 / 2 行:惰性 [rsi.auto] 未开启 / codex / 相位 1 → 第 2 行:无 canary 输出、无账',
    ],
    restored: true,
  },
  {
    id: 'admission-multi-marker-not-failed',
    failed: 2,
    skipped: 0,
    killedBy: [
      '判定 probing:admitted / failed / pending 某会话取回 ≥ 2 个不同标记 → 立即 failed(multi_marker),不等静止',
      '判定 probing:admitted / failed / pending 暂停 / 循环失效时不给 admitted(它是授予影响的前置),但失败照常判(只收紧)',
    ],
    restored: true,
  },
  {
    id: 'admission-quiet-threshold-dropped',
    failed: 1,
    skipped: 0,
    killedBy: [
      '判定 probing:admitted / failed / pending 静止恰好 60 分钟 → admitted;59 分钟 → 仍 probing',
    ],
    restored: true,
  },
  {
    id: 'admission-unknown-quiet-accepted',
    failed: 1,
    skipped: 0,
    killedBy: [
      '判定 probing:admitted / failed / pending 静止时长不可知(null)→ 不 admitted(fail-closed)',
    ],
    restored: true,
  },
  {
    id: 'admission-shared-marker-accepted',
    failed: 2,
    skipped: 0,
    killedBy: [
      '判定 probing:admitted / failed / pending 一个标记被两个会话取回(resume / fork 复制)→ 不 admitted',
      '判定 probing:admitted / failed / pending 某标记在其账行之后 48 小时仍无人取回 → failed(marker_not_retrieved);不足 48 小时 → 仍 probing',
    ],
    restored: true,
  },
  {
    id: 'admission-old-generation-lines-counted',
    failed: 4,
    skipped: 0,
    killedBy: [
      '判定 probing:admitted / failed / pending 旧代的探针行(probe_generation ≠ 当前代)不计入:新 arm 之后没有本代行 → 不 admitted',
      '判定 probing:admitted / failed / pending 旧代 / 越界票号(0、tickets+1)的行不计入本代:既不充数也不阻止本代 admitted',
      '判定 probing:admitted / failed / pending 旧代的重复票号不影响本代(只有本代的重复才算)',
      '判定 probing:admitted / failed / pending W0-18:旧代迟到行让账里行数多于本代票数 → 既不充数也不阻挡本代 admitted',
    ],
    restored: true,
  },
  {
    id: 'admission-wait-48h-dropped',
    failed: 1,
    skipped: 0,
    killedBy: [
      '判定 probing:admitted / failed / pending 某标记在其账行之后 48 小时仍无人取回 → failed(marker_not_retrieved);不足 48 小时 → 仍 probing',
    ],
    restored: true,
  },
  {
    id: 'admission-admitted-while-paused',
    failed: 1,
    skipped: 0,
    killedBy: [
      '判定 probing:admitted / failed / pending 暂停 / 循环失效时不给 admitted(它是授予影响的前置),但失败照常判(只收紧)',
    ],
    restored: true,
  },
  {
    id: 'admission-arm-ignores-pause',
    failed: 5,
    skipped: 0,
    killedBy: [
      'arm:何时开始探针 不 arm:AUTO_PAUSE 在场',
      '判定 probing:admitted / failed / pending probing 期间版本变了:旧版本的齐全证据不判 admitted,允许时重新 arm(generation + 1);暂停时原地等待',
      '判定 probing:admitted / failed / pending 暂停 / 循环失效时不给 admitted(它是授予影响的前置),但失败照常判(只收紧)',
      'admitted / failed 之后 满 7 日的自动重探仍受 arm 条件约束:暂停 / 循环无效 / 相位不足 / 版本不可知 / 钩子未装 → 不重探',
      'admitted / failed 之后 前台显式 rearm 才让版本未变、未满 7 日的 failed 重探',
    ],
    restored: true,
  },
  {
    id: 'admission-arm-with-unknown-version',
    failed: 2,
    skipped: 0,
    killedBy: [
      'arm:何时开始探针 不 arm:agent_version 不可知(hint 不会消费票)',
      'admitted / failed 之后 满 7 日的自动重探仍受 arm 条件约束:暂停 / 循环无效 / 相位不足 / 版本不可知 / 钩子未装 → 不重探',
    ],
    restored: true,
  },
  {
    id: 'admission-failed-rearms-without-version-change',
    failed: 21,
    skipped: 0,
    killedBy: [
      '判定 probing:admitted / failed / pending 3 张票的 3 个标记各被恰好一个会话取回、各会话只取回 1 个标记、静止 ≥ 60 分钟 → admitted(decided_at = 当前)',
      '判定 probing:admitted / failed / pending 静止恰好 60 分钟 → admitted;59 分钟 → 仍 probing',
      '判定 probing:admitted / failed / pending 静止时长不可知(null)→ 不 admitted(fail-closed)',
      '判定 probing:admitted / failed / pending 只有 2 行探针账 → 不 admitted',
      '判定 probing:admitted / failed / pending 一个标记被两个会话取回(resume / fork 复制)→ 不 admitted',
      '判定 probing:admitted / failed / pending 某标记在其账行之后 48 小时仍无人取回 → failed(marker_not_retrieved);不足 48 小时 → 仍 probing',
      '判定 probing:admitted / failed / pending 旧代的探针行(probe_generation ≠ 当前代)不计入:新 arm 之后没有本代行 → 不 admitted',
      '判定 probing:admitted / failed / pending 按代号而不是时间认行:本代的行即使 at 早于 armed_at 也计入(W0-18 取代时间窗)',
      '判定 probing:admitted / failed / pending 旧代 / 越界票号(0、tickets+1)的行不计入本代:既不充数也不阻止本代 admitted',
      '判定 probing:admitted / failed / pending 旧代的重复票号不影响本代(只有本代的重复才算)',
      '判定 probing:admitted / failed / pending 票号缺一(1、2 号齐,3 号没有行)→ 不 admitted',
      '判定 probing:admitted / failed / pending 其它 agent 的探针行不计入 claude',
      '判定 probing:admitted / failed / pending W0-18:本代只有两行、旧代 hint 迟到落的行带旧代号 → 不替本代凑数,不 admitted',
      '判定 probing:admitted / failed / pending W0-18:旧代迟到行让账里行数多于本代票数 → 既不充数也不阻挡本代 admitted',
      'admitted / failed 之后 已 admitted 之后本代出现重复探针票号 → failed(multi_marker);探针窗口到期本身不撤销',
      'admitted / failed 之后 admitted 且版本未变 → 不动',
      'admitted / failed 之后 failed 未满 7 个 UTC 日且版本未变 → 不自动重探;版本变了才立即重探',
      'admitted / failed 之后 failed 满 RSI_PROBE_RETRY_DAYS(7)个 UTC 日 → 自动重新 armed 下一代;按日期差,与时刻无关',
      'admitted / failed 之后 failed 满 6 个 UTC 日(11-04 00:00 起算)→ 仍不重探',
      'admitted / failed 之后 failed 的 decided_at 缺失 / 不可解析 → 不自动重探(fail-closed)',
      'canary-admission.json 的唯一写入方 有变化才写:0600、schema 合法;第二次(无变化)返回 unchanged 且文件逐字节不变',
    ],
    restored: true,
  },
  {
    id: 'admission-ticket-out-of-range-counted',
    failed: 1,
    skipped: 0,
    killedBy: [
      '判定 probing:admitted / failed / pending 旧代 / 越界票号(0、tickets+1)的行不计入本代:既不充数也不阻止本代 admitted',
    ],
    restored: true,
  },
  {
    id: 'admission-duplicate-ticket-ignored',
    failed: 2,
    skipped: 0,
    killedBy: [
      '判定 probing:admitted / failed / pending 同一 (probe_generation, probe_ticket) 出现两行 → 本代 failed(multi_marker)',
      'admitted / failed 之后 已 admitted 之后本代出现重复探针票号 → failed(multi_marker);探针窗口到期本身不撤销',
    ],
    restored: true,
  },
  {
    id: 'admission-duplicate-marker-ignored',
    failed: 1,
    skipped: 0,
    killedBy: [
      '判定 probing:admitted / failed / pending 同一标记落在两个票号的行上 → 本代 failed(multi_marker)',
    ],
    restored: true,
  },
  {
    id: 'admission-admitted-duplicate-evidence-ignored',
    failed: 1,
    skipped: 0,
    killedBy: [
      'admitted / failed 之后 已 admitted 之后本代出现重复探针票号 → failed(multi_marker);探针窗口到期本身不撤销',
    ],
    restored: true,
  },
  {
    id: 'admission-retry-never',
    failed: 2,
    skipped: 0,
    killedBy: [
      'admitted / failed 之后 failed 满 RSI_PROBE_RETRY_DAYS(7)个 UTC 日 → 自动重新 armed 下一代;按日期差,与时刻无关',
      'admitted / failed 之后 每种 failed 原因满 7 日都自动重探(marker_not_retrieved / multi_marker / probe_expired)',
    ],
    restored: true,
  },
  {
    id: 'admission-retry-too-early',
    failed: 1,
    skipped: 0,
    killedBy: ['admitted / failed 之后 failed 满 6 个 UTC 日(11-04 00:00 起算)→ 仍不重探'],
    restored: true,
  },
  {
    id: 'admission-retry-ignores-arm-conditions',
    failed: 2,
    skipped: 0,
    killedBy: [
      'admitted / failed 之后 满 7 日的自动重探仍受 arm 条件约束:暂停 / 循环无效 / 相位不足 / 版本不可知 / 钩子未装 → 不重探',
      'admitted / failed 之后 前台显式 rearm 才让版本未变、未满 7 日的 failed 重探',
    ],
    restored: true,
  },
  {
    id: 'admission-retry-bad-decided-at',
    failed: 1,
    skipped: 0,
    killedBy: [
      'admitted / failed 之后 failed 的 decided_at 缺失 / 不可解析 → 不自动重探(fail-closed)',
    ],
    restored: true,
  },
  {
    id: 'probe-line-generation-not-bound',
    failed: 2,
    skipped: 0,
    killedBy: [
      '第 2a 行:探针票(W0-3) 依次消费 3 张票:每次输出仅含标记的一行 + 账行 excluded/admission_probe(candidate_id=null、marker 非空、p=0、背景指纹全零);第 4 次不输出',
      '第 2a 行:探针票(W0-3) 重新 armed(generation 加 1)后旧代的占用文件作废、不计入本代;旧代标记不被重用',
    ],
    restored: true,
  },
  {
    id: 'probe-line-ticket-not-bound',
    failed: 2,
    skipped: 0,
    killedBy: [
      '第 2a 行:探针票(W0-3) 依次消费 3 张票:每次输出仅含标记的一行 + 账行 excluded/admission_probe(candidate_id=null、marker 非空、p=0、背景指纹全零);第 4 次不输出',
      '第 2a 行:探针票(W0-3) 重新 armed(generation 加 1)后旧代的占用文件作废、不计入本代;旧代标记不被重用',
    ],
    restored: true,
  },
  {
    id: 'hint-overlaps-preset-not-copied',
    failed: 1,
    skipped: 0,
    killedBy: [
      '第 6 / 7 行:随机、分组账、输出 overlaps_preset 原样抄自 canary.json(treat 与 control 都是;W0-18),其余 excluded 行同样带',
    ],
    restored: true,
  },
  {
    id: 'writer-overlaps-preset-not-from-record',
    failed: 1,
    skipped: 0,
    killedBy: [
      'grantCanary:授予 overlaps_preset 取权威记录里该候选 G4 的结果(调用方不能自带);true / false 各一',
    ],
    restored: true,
  },
  {
    id: 'admission-probing-version-change-ignored',
    failed: 1,
    skipped: 0,
    killedBy: [
      '判定 probing:admitted / failed / pending probing 期间版本变了:旧版本的齐全证据不判 admitted,允许时重新 arm(generation + 1);暂停时原地等待',
    ],
    restored: true,
  },
  {
    id: 'admission-success-before-expiry',
    failed: 2,
    skipped: 0,
    killedBy: [
      '判定 probing:admitted / failed / pending probe_expires_at 到期仍未凑齐 → failed(probe_expired);到期当刻也算',
      '判定 probing:admitted / failed / pending 已到期时即使证据齐全也判 probe_expired(到期先于成功)',
    ],
    restored: true,
  },
  {
    id: 'admission-corrupt-file-overwritten',
    failed: 1,
    skipped: 0,
    killedBy: [
      'canary-admission.json 的唯一写入方 现有准入文件不合规 → blocked,不覆盖(损坏的文件不被静默替换成重新开始)',
    ],
    restored: true,
  },
  {
    id: 'grant-barrier-removed',
    failed: 5,
    skipped: 0,
    killedBy: [
      'grantCanary:授予 对账屏障(R21-9.5):A 已终态但 canary.json 残留、stop 行未补 → 授予 B 被拒;对账完成后允许',
      'grantCanary:授予 对账屏障:有凭据而分组账不存在 / 为空 → 拒绝授予(账不存在不等于已补 stop);reconcileCaches 补 stop 后允许',
      'grantCanary:授予 对账屏障:凭据列出的候选权威记录仍非终态 → 拒绝授予别的候选;账不合规同样拒绝',
      'grantCanary:授予 空凭据集 + 不合规账 → 拒绝授予(坏账不因没有凭据而绕过);空凭据集 + 账不存在 → 允许',
      'grantCanary:授予 不可读缓存恢复:坏 JSON 缓存 + 已对账的历史凭据 → 授予被拒;对账清理移除不可读缓存后可恢复',
    ],
    restored: true,
  },
  {
    id: 'grant-barrier-ignores-cache-residual',
    failed: 1,
    skipped: 0,
    killedBy: [
      'grantCanary:授予 对账屏障(R21-9.5):A 已终态但 canary.json 残留、stop 行未补 → 授予 B 被拒;对账完成后允许',
    ],
    restored: true,
  },
  {
    id: 'grant-barrier-ignores-stop-missing',
    failed: 1,
    skipped: 0,
    killedBy: [
      'grantCanary:授予 对账屏障:有凭据而分组账不存在 / 为空 → 拒绝授予(账不存在不等于已补 stop);reconcileCaches 补 stop 后允许',
    ],
    restored: true,
  },
  {
    id: 'grant-barrier-stop-only-when-ledger-exists',
    failed: 1,
    skipped: 0,
    killedBy: [
      'grantCanary:授予 对账屏障:有凭据而分组账不存在 / 为空 → 拒绝授予(账不存在不等于已补 stop);reconcileCaches 补 stop 后允许',
    ],
    restored: true,
  },
  {
    id: 'grant-barrier-ignores-nonterminal',
    failed: 1,
    skipped: 0,
    killedBy: [
      'grantCanary:授予 对账屏障:凭据列出的候选权威记录仍非终态 → 拒绝授予别的候选;账不合规同样拒绝',
    ],
    restored: true,
  },
  {
    id: 'shadow-observe-swallows-lock-lost',
    failed: 1,
    skipped: 0,
    killedBy: [
      'W3 遗留:重建工作副本后 sessions / hits 由计数重算 M3 observer 抛 lock_lost 原样传播:ShadowCountPort / ReadySinceRecovery 抛出,步骤立即 halted=lock_lost;普通错误仍映射 null',
    ],
    restored: true,
  },
  {
    id: 'grant-barrier-ledger-check-inside-loop',
    failed: 1,
    skipped: 0,
    killedBy: [
      'grantCanary:授予 空凭据集 + 不合规账 → 拒绝授予(坏账不因没有凭据而绕过);空凭据集 + 账不存在 → 允许',
    ],
    restored: true,
  },
  {
    id: 'reconcile-keeps-unreadable-cache',
    failed: 1,
    skipped: 0,
    killedBy: [
      'grantCanary:授予 不可读缓存恢复:坏 JSON 缓存 + 已对账的历史凭据 → 授予被拒;对账清理移除不可读缓存后可恢复',
    ],
    restored: true,
  },
  {
    id: 'shadow-facts-fail-open',
    failed: 1,
    skipped: 0,
    killedBy: [
      '端口装配 withShadowCounts:promoteFacts 的 sessions / hits 取自真实计数,其余字段原样;任一事实不可得 → null(W3 据此不推进)',
    ],
    restored: true,
  },
  {
    id: 'shadow-entered-at-first-not-last',
    failed: 1,
    skipped: 0,
    killedBy: [
      'shadowEnteredAt:窗口起点 取最后一条 dim=lifecycle、to=shadow 的转移时间;找不到(被 256 条窗口挤掉)→ null(不退化成从纪元起算)',
    ],
    restored: true,
  },
  {
    id: 'shadow-sessions-not-deduped',
    failed: 1,
    skipped: 0,
    killedBy: [
      '计数与首次达标日 hits 是命中会话数(一个会话里多次命中只记一次);sessions 按 session_ref 去重',
    ],
    restored: true,
  },
  {
    id: 'shadow-ready-session-threshold-dropped',
    failed: 4,
    skipped: 0,
    killedBy: [
      '计数与首次达标日 首次达标日 = 同时满足 ≥ 20 会话且命中 ≥ 2 的最早 UTC 日',
      '计数与首次达标日 未达标 → null:命中只有 1、会话只有 19、两者都不足',
      '计数与首次达标日 同一天的多个会话按当日全部会话之后的累计值判定',
      '端口装配 ReadySinceRecovery:历史里能证明达标的最早 UTC 日;未达标 / 读失败 / 无起点 → null',
    ],
    restored: true,
  },
  {
    id: 'shadow-tool-class-ignored',
    failed: 1,
    skipped: 0,
    killedBy: ['签名命中(W0-2) tool 签名带 tool_error_class:只收窄不放宽;旧信号没有类时不命中'],
    restored: true,
  },
  {
    id: 'shadow-lesson-jaccard-zero',
    failed: 1,
    skipped: 0,
    killedBy: [
      '签名命中(W0-2) lesson 签名:显式教训的 token Jaccard ≥ 0.5 → 命中;无关教训 / 外部内容 → 不命中',
    ],
    restored: true,
  },
  {
    id: 'shadow-observe-multi-marker-counted',
    failed: 1,
    skipped: 0,
    killedBy: [
      '真实来源适配器(会话计数库 + 信号库) 「有观测会话」资格:窗口之后、采集中项目、非多标记、被随机的会话能在分组账里关联;缺键 / 0 个标记照计',
    ],
    restored: true,
  },
  {
    id: 'shadow-observe-unlinked-marker-counted',
    failed: 1,
    skipped: 0,
    killedBy: [
      '真实来源适配器(会话计数库 + 信号库) 「有观测会话」资格:窗口之后、采集中项目、非多标记、被随机的会话能在分组账里关联;缺键 / 0 个标记照计',
    ],
    restored: true,
  },
  {
    id: 'shadow-observe-excluded-project-counted',
    failed: 1,
    skipped: 0,
    killedBy: [
      '真实来源适配器(会话计数库 + 信号库) 「有观测会话」资格:窗口之后、采集中项目、非多标记、被随机的会话能在分组账里关联;缺键 / 0 个标记照计',
    ],
    restored: true,
  },
  {
    id: 'shadow-observe-schema-drop-ignored',
    failed: 1,
    skipped: 0,
    killedBy: [
      '真实来源适配器(会话计数库 + 信号库) 信号库里有「JSON 合法但不合 schema」的行 → 抛错(事实不可得),不静默丢弃后照常计数',
    ],
    restored: true,
  },
  {
    id: 'step-rebuild-counts-not-recomputed',
    failed: 3,
    skipped: 0,
    killedBy: [
      'W3 遗留:重建工作副本后 sessions / hits 由计数重算 缺工作副本的 shadow:重建后 sessions / hits 取自计数端口;读失败 / 事实不可得 → 保持 0;proposed 不调用计数',
      'W3 遗留:重建工作副本后 sessions / hits 由计数重算 M3 observer 抛 lock_lost 原样传播:ShadowCountPort / ReadySinceRecovery 抛出,步骤立即 halted=lock_lost;普通错误仍映射 null',
      'W3 遗留:重建工作副本后 sessions / hits 由计数重算 计数端口里丢锁(RsiLockError lock_lost)→ 步骤以 lock_lost 中止',
    ],
    restored: true,
  },
];
