/**
 * §21 V1 W4 必杀变异(契约 R21-6.6 / R21-6.9 / R21-18 第 20、40 条 / §21.24 W0-7;每条新不变量一个变异锚点):每条变异后必须有测试红。
 * 执行方式同 W0 / A3–A6:验证机私有检出里 cp 备份 → 按锚点替换(每个锚点在对应文件里**恰好出现一次**)→ 跑 `tests` →
 * 失败集合非空、全部命中 `expectRed`、`mustKill` 每项至少命中一个、没有 skipped → cp 还原并逐文件 sha256 核对。**不用 git checkout / stash 还原**。
 * 本文件只写表与每条变异期望红的测试名(`expectRed` 是杀手测试源码里的字面子串);变异由主代理在验证机上执行,结果记进 `V1_W4_RESULTS`(W4 实装块不执行变异,故留空)。
 * `expectRed` 是实装者按代码推演的预测:执行时若出现表外的红,以实测为准补表(只增不删)。
 */
export interface Edit {
  file: string;
  anchor: string;
  replacement: string;
}

export interface V1W4Mutation {
  id: string;
  /** 契约里的变异点原文 / 本块不变量 */
  clause: string;
  edits: readonly Edit[];
  /** 相对 `test/` */
  tests: readonly string[];
  expectRed: readonly string[];
  mustKill: readonly string[];
}

export interface V1W4Result {
  id: string;
  failed: number;
  skipped: number;
  killedBy: readonly string[];
  restored: boolean;
}

const INJ = 'signals/w4-injection.test.ts';
const SIG = 'signals/w4-signals.test.ts';
const BASE = 'src/signals/base-reader.ts';
const INJECTION = 'src/signals/injection.ts';
const RETRY = 'src/signals/retry-chain.ts';
const TEC = 'src/signals/tool-error-class.ts';
const PIPE = 'src/signals/pipeline.ts';
const SIGNAL = 'src/contracts/signal.ts';
const STAT = 'src/contracts/session-stat.ts';
const CON = 'signals/w4-contracts.test.ts';

export const V1_W4_MUTATIONS: readonly V1W4Mutation[] = [
  {
    id: 'marker-block-counted',
    clause: 'R21-6.9:标记块被计入显式教训 / 工具调用(块所在行的计数事件不再被排除)',
    edits: [
      {
        file: BASE,
        anchor: '(blocks.length > 0 || (ev.text !== undefined && injection.isRecital(ev.text)));',
        replacement: '(ev.text !== undefined && injection.isRecital(ev.text));',
      },
    ],
    tests: [INJ, SIG],
    expectRed: [
      'control 块(只有标记行)作为用户消息',
      '工具结果里被引用的块',
      '被注入排除的结果事件不进链',
      '被排除的外部内容事件仍把会话记为外部内容',
    ],
    mustKill: ['control 块(只有标记行)作为用户消息', '工具结果里被引用的块'],
  },
  {
    id: 'recital-threshold-15',
    clause: 'R21-6.9:复述阈值差一(16 → 15):15 字重合也被排除',
    edits: [
      {
        file: INJECTION,
        anchor: 'export const RECITAL_MIN_CHARS = 16;',
        replacement: 'export const RECITAL_MIN_CHARS = 15;',
      },
    ],
    tests: [INJ],
    expectRed: [
      'RECITAL_MIN_CHARS 是 16',
      '连续重合 16 码点',
      '按码点不是码元',
      '与朴素最长公共子串参考实现对拍',
      '复述:后续消息',
    ],
    mustKill: ['连续重合 16 码点', '复述:后续消息'],
  },
  {
    id: 'recital-threshold-17',
    clause: 'R21-6.9:复述阈值差一(16 → 17):16 字重合不被排除',
    edits: [
      {
        file: INJECTION,
        anchor: 'export const RECITAL_MIN_CHARS = 16;',
        replacement: 'export const RECITAL_MIN_CHARS = 17;',
      },
    ],
    tests: [INJ],
    expectRed: [
      'RECITAL_MIN_CHARS 是 16',
      '连续重合 16 码点',
      '按码点不是码元',
      '与朴素最长公共子串参考实现对拍',
      '复述:后续消息',
    ],
    mustKill: ['连续重合 16 码点', '复述:后续消息'],
  },
  {
    id: 'sig-id-includes-new-field',
    clause: '§21.18 第 40 条:`sig_id` 输入加入新字段(retry_chain_len)',
    edits: [
      {
        file: PIPE,
        anchor: 'sig_id: sigIdFor(deps.salt, sessionRef, c.index),',
        replacement: 'sig_id: sigIdFor(deps.salt, sessionRef, c.index + (c.retryChainLen ?? 0)),',
      },
    ],
    tests: [SIG],
    expectRed: ['sig_id 只由 (盐, session_ref, 事件序号) 决定'],
    mustKill: ['sig_id 只由 (盐, session_ref, 事件序号) 决定'],
  },
  {
    id: 'marker-retrieved-from-quoted',
    clause: 'R21-6.6:工具结果 / 助手文本里被引用的块也取回标记(造成假「多标记」)',
    edits: [
      {
        file: BASE,
        anchor: 'lineEvents.every((e) => INJECTION_SOURCE_KINDS.has(e.kind))',
        replacement: 'true',
      },
    ],
    tests: [INJ],
    expectRed: ['工具结果里被引用的块'],
    mustKill: ['工具结果里被引用的块'],
  },
  {
    id: 'block-prefix-anywhere',
    clause: 'R21-6.9:前缀出现在行中间也算块(应只认行首)',
    edits: [
      {
        file: INJECTION,
        anchor: 'if (lead.startsWith(RSI_MARK_PREFIX)) {',
        replacement: 'if (lead.includes(RSI_MARK_PREFIX)) {',
      },
    ],
    tests: [INJ],
    expectRed: [
      '行首(允许空格 / 制表符)以前缀开头才是块',
      'U+2028 不是行分隔',
      'treat 块作为用户消息',
    ],
    mustKill: ['行首(允许空格 / 制表符)以前缀开头才是块'],
  },
  {
    id: 'multi-marker-threshold',
    clause: 'R21-6.6:≥ 2 个不同标记 → 多标记(门槛改成 3)',
    edits: [
      {
        file: INJECTION,
        anchor: "return distinct >= 2 ? 'multi_marker' : 'ok';",
        replacement: "return distinct >= 3 ? 'multi_marker' : 'ok';",
      },
    ],
    tests: [INJ],
    expectRed: ['0 个 → 关联失败;1 个 → ok', '同一会话两个不同标记 → 多标记'],
    mustKill: ['0 个 → 关联失败;1 个 → ok'],
  },
  {
    id: 'zero-marker-not-failure',
    clause: 'R21-6.6:0 个标记 → 关联失败(改成 ok)',
    edits: [
      {
        file: INJECTION,
        anchor: "if (distinct === 0) return 'correlation_failed';",
        replacement: "if (distinct < 0) return 'correlation_failed';",
      },
    ],
    tests: [INJ],
    expectRed: ['0 个 → 关联失败;1 个 → ok', '同一会话两个不同标记 → 多标记'],
    mustKill: ['0 个 → 关联失败;1 个 → ok'],
  },
  {
    id: 'markers-unsorted',
    clause: 'W0-7:SessionStat.rsi_markers 去重、升序、≤ 4(去掉排序)',
    edits: [
      {
        file: INJECTION,
        anchor: 'markers: [...this.markerSet].sort().slice(0, SESSION_MARKERS_MAX),',
        replacement: 'markers: [...this.markerSet].slice(0, SESSION_MARKERS_MAX),',
      },
    ],
    tests: [INJ],
    expectRed: ['追踪器:去重、升序、≤ 4', '超过 4 个不同标记:去重升序保留前 4 个'],
    mustKill: ['追踪器:去重、升序、≤ 4'],
  },
  {
    id: 'codex-kimi-detect-injection',
    clause: 'W4 范围:codex / kimi 只加两个信号字段,不识别注入(基类默认改成识别)',
    edits: [
      {
        file: BASE,
        anchor: 'protected readonly detectsInjection: boolean = false;',
        replacement: 'protected readonly detectsInjection: boolean = true;',
      },
    ],
    tests: [INJ],
    expectRed: ['read() 不带 injection()'],
    mustKill: ['read() 不带 injection()'],
  },
  {
    id: 'retry-success-not-ending',
    clause: '§21.24 W0-7:重试链被该工具的一次成功结束(成功不再结束链)',
    edits: [
      {
        file: RETRY,
        anchor: 'this.runs.delete(toolName);',
        replacement: 'void toolName;',
      },
    ],
    tests: [SIG],
    expectRed: ['同一工具连续失败累加', '成功结束:失败失败成功再失败'],
    mustKill: ['成功结束:失败失败成功再失败'],
  },
  {
    id: 'retry-other-tool-breaks-chain',
    clause: '§21.24 W0-7:别的工具的成功不得断链(成功时清空全部链)',
    edits: [
      {
        file: RETRY,
        anchor: 'this.runs.delete(toolName);',
        replacement: 'this.runs.clear();',
      },
    ],
    tests: [SIG],
    expectRed: [
      '同一工具连续失败累加',
      '穿插:别的工具的失败 / 成功、用户消息都不断链',
      '链的身份用完整原始工具名',
    ],
    mustKill: ['穿插:别的工具的失败 / 成功、用户消息都不断链'],
  },
  {
    id: 'retry-chain-across-sessions',
    clause: '§21.24 W0-7:跨会话不连(追踪器在会话间共享)',
    edits: [
      {
        file: PIPE,
        anchor: 'const retryChains = new RetryChainTracker();',
        replacement:
          'const retryChains = ((globalThis as { __w4rc?: RetryChainTracker }).__w4rc ??= new RetryChainTracker());',
      },
    ],
    tests: [SIG],
    expectRed: [
      '跨会话不连',
      '放弃:会话结束时链仍未成功',
      '穿插:别的工具的失败 / 成功、用户消息都不断链',
      '没有失败 → retry_chain_max = 0',
      '被注入排除的结果事件不进链',
      '找不到工具名的失败',
      '链的身份用完整原始工具名',
      '成功结束:失败失败成功再失败',
      'sig_id 只由 (盐, session_ref, 事件序号) 决定',
    ],
    mustKill: ['跨会话不连'],
  },
  {
    id: 'retry-unnamed-chains',
    clause: '§21.24 W0-7:没有工具名的失败不成链(改成按空名连成链)',
    edits: [
      {
        file: RETRY,
        anchor: "if (toolName === undefined || toolName === '') return undefined;",
        replacement: "toolName ??= '';",
      },
    ],
    tests: [SIG],
    expectRed: ['没有工具名的失败不成链', '找不到工具名的失败'],
    mustKill: ['没有工具名的失败不成链'],
  },
  {
    id: 'sidechain-block-scanned',
    clause: 'R21-6.9 × C1:整行忽略的侧链行也参与注入识别(取回标记、登记复述正文)',
    edits: [
      {
        file: BASE,
        anchor: 'if (injection !== undefined && !lineIgnored) {',
        replacement: 'if (injection !== undefined) {',
      },
    ],
    tests: [INJ],
    expectRed: ['整行忽略的侧链行不参与识别'],
    mustKill: ['整行忽略的侧链行不参与识别'],
  },
  {
    id: 'excluded-event-loses-external',
    clause: 'contracts #8:被排除(改写成 meta)的外部内容事件不再把会话记为外部内容',
    edits: [
      {
        file: BASE,
        anchor:
          'if (ev.external_content === true || isExternalToolName(ev.tool_name)) external = true;',
        replacement: 'void isExternalToolName;',
      },
    ],
    tests: [INJ],
    expectRed: ['被排除的外部内容事件仍把会话记为外部内容'],
    mustKill: ['被排除的外部内容事件仍把会话记为外部内容'],
  },
  {
    id: 'retry-key-truncated',
    clause: '§21.24 W0-7:重试链按完整原始工具名建键(改成截断 192 码元)',
    edits: [
      {
        file: PIPE,
        anchor: 'retryChainLen = retryChains.observe(ev.tool_name, ev.tool_failed === true);',
        replacement:
          'retryChainLen = retryChains.observe(ev.tool_name?.slice(0, 192), ev.tool_failed === true);',
      },
    ],
    tests: [SIG],
    expectRed: ['链的身份用完整原始工具名'],
    mustKill: ['链的身份用完整原始工具名'],
  },
  {
    id: 'injection-index-unbounded',
    clause: '复述索引会话级上限:去掉上限检查 → 超限不再 fail-closed',
    edits: [
      {
        file: INJECTION,
        anchor:
          'if (this.windows.size > INJECTION_WINDOWS_MAX) throw new InjectionIndexLimitError();',
        replacement: 'void INJECTION_WINDOWS_MAX;',
      },
    ],
    tests: [INJ],
    expectRed: ['窗口总数超过 INJECTION_WINDOWS_MAX', '经管线:多块长会话超限'],
    mustKill: ['窗口总数超过 INJECTION_WINDOWS_MAX', '经管线:多块长会话超限'],
  },
  {
    id: 'invalid-marker-block-body-not-registered',
    clause: 'R21-6.9:标记形状不对的块照常登记正文(不登记 → 其复述漏排除)',
    edits: [
      {
        file: INJECTION,
        anchor: 'if (b.marker !== undefined) this.markerSet.add(b.marker);',
        replacement: 'if (b.marker === undefined) continue;\n      this.markerSet.add(b.marker);',
      },
    ],
    tests: [INJ],
    expectRed: ['标记形状不对的块:照常登记正文'],
    mustKill: ['标记形状不对的块:照常登记正文'],
  },
  {
    id: 'block-body-truncated',
    clause: 'R21-6.9:块正文超过 4096 码点 fail-closed(恢复成截断 → 红)',
    edits: [
      {
        file: INJECTION,
        anchor: 'if (out.length >= max) throw new InjectionIndexLimitError();',
        replacement: 'if (out.length >= max) break;',
      },
    ],
    tests: [INJ],
    expectRed: ['块正文超过 4096 码点'],
    mustKill: ['块正文超过 4096 码点'],
  },
  {
    id: 'signal-fields-any-kind',
    clause: 'W4 schema:tool_error_class / retry_chain_len 只允许在 tool_result_failed 信号上(放开)',
    edits: [
      {
        file: SIGNAL,
        anchor: "s.event_kind !== 'tool_result_failed'",
        replacement: 'false',
      },
    ],
    tests: [CON],
    expectRed: ['字段间约束:tool_error_class / retry_chain_len 只许出现在'],
    mustKill: ['字段间约束:tool_error_class / retry_chain_len 只许出现在'],
  },
  {
    id: 'stat-keys-partial-allowed',
    clause:
      'W4 schema:rsi_markers 与 injection_excluded 成组(放开 → 允许 markers 有而 injection_excluded 缺)',
    edits: [
      {
        file: STAT,
        anchor: 'if ((s.rsi_markers === undefined) !== (s.injection_excluded === undefined)) {',
        replacement: 'if (false) {',
      },
    ],
    tests: [CON],
    expectRed: ['字段间约束:rsi_markers 与 injection_excluded 成组'],
    mustKill: ['字段间约束:rsi_markers 与 injection_excluded 成组'],
  },
  {
    id: 'markers-not-strictly-ascending',
    clause: 'W4 schema:rsi_markers 严格升序(改成只要求相邻不等)',
    edits: [
      {
        file: STAT,
        anchor: '(a[i - 1] as string) < m',
        replacement: '(a[i - 1] as string) !== m',
      },
    ],
    tests: [CON],
    expectRed: ['rsi_markers 必须严格升序'],
    mustKill: ['rsi_markers 必须严格升序'],
  },
  {
    id: 'tool-error-empty-is-other',
    clause: 'R21-18 第 20 条:没有失败文本时不写 tool_error_class(改成写 other)',
    edits: [
      {
        file: TEC,
        anchor: "if (text === undefined || text.trim() === '') return undefined;",
        replacement: "if (text === undefined || text.trim() === '') return 'other';",
      },
    ],
    tests: [SIG],
    expectRed: ['没有失败文本(缺失 / 空 / 纯空白)'],
    mustKill: ['没有失败文本(缺失 / 空 / 纯空白)'],
  },
  {
    id: 'tool-error-table-reversed',
    clause: 'R21-18 第 20 条:固定映射表有序、首个命中即用(顺序反转)',
    edits: [
      {
        file: TEC,
        anchor: 'for (const [cls, re] of TOOL_ERROR_CLASS_TABLE) if (re.test(window)) return cls;',
        replacement:
          'for (const [cls, re] of [...TOOL_ERROR_CLASS_TABLE].reverse()) if (re.test(window)) return cls;',
      },
    ],
    tests: [SIG],
    expectRed: ['有序、首个命中即用'],
    mustKill: ['有序、首个命中即用'],
  },
];

/** 实测结果(主代理在验证机上执行变异后填写;W4 实装块不执行,故留空) */
/** 实测结果:作业 r21w4-mut3 @ b31f206(dolphin),BASE 62 条全过,25/25 被杀、逐文件 sha256 还原核对通过;其中 3 条的表外多红已补入 expectRed(主代理验收)。 */
export const V1_W4_RESULTS: readonly V1W4Result[] = [
  {
    id: 'marker-block-counted',
    failed: 4,
    skipped: 0,
    killedBy: [
      'claude:块所在事件与复述事件不计入计数 / 信号,标记被取回 control 块(只有标记行)作为用户消息:同样不计入、不产信号;标记照取',
      'claude:块所在事件与复述事件不计入计数 / 信号,标记被取回 工具结果里被引用的块(cat 了别的会话):排除计数但不取回标记(避免假「多标记」)',
      'claude:块所在事件与复述事件不计入计数 / 信号,标记被取回 被排除的外部内容事件仍把会话记为外部内容:后续信号摘录为空(对照:非外部工具时摘录保留)',
      'retry_chain_len / retry_chain_max(经管线,claude) 被注入排除的结果事件不进链(正向:真实失败照常计链)',
    ],
    restored: true,
  },
  {
    id: 'recital-threshold-15',
    failed: 5,
    skipped: 0,
    killedBy: [
      '块识别(纯函数) RECITAL_MIN_CHARS 是 16(契约 R21-6.9)',
      '复述阈值:16 码点排除、15 码点不排除(边界各一例) 连续重合 16 码点 → 复述;15 码点 → 不是;17 → 是',
      '复述阈值:16 码点排除、15 码点不排除(边界各一例) 按码点不是码元:代理对算一个字',
      '复述阈值:16 码点排除、15 码点不排除(边界各一例) 与朴素最长公共子串参考实现对拍(确定性伪随机,含拼接复述)',
      'claude:块所在事件与复述事件不计入计数 / 信号,标记被取回 复述:后续消息 / 助手文本 / 工具调用里与正文连续 ≥ 16 字重合的都被排除;15 字的不排除',
    ],
    restored: true,
  },
  {
    id: 'recital-threshold-17',
    failed: 5,
    skipped: 0,
    killedBy: [
      '块识别(纯函数) RECITAL_MIN_CHARS 是 16(契约 R21-6.9)',
      '复述阈值:16 码点排除、15 码点不排除(边界各一例) 连续重合 16 码点 → 复述;15 码点 → 不是;17 → 是',
      '复述阈值:16 码点排除、15 码点不排除(边界各一例) 按码点不是码元:代理对算一个字',
      '复述阈值:16 码点排除、15 码点不排除(边界各一例) 与朴素最长公共子串参考实现对拍(确定性伪随机,含拼接复述)',
      'claude:块所在事件与复述事件不计入计数 / 信号,标记被取回 复述:后续消息 / 助手文本 / 工具调用里与正文连续 ≥ 16 字重合的都被排除;15 字的不排除',
    ],
    restored: true,
  },
  {
    id: 'sig-id-includes-new-field',
    failed: 1,
    skipped: 0,
    killedBy: [
      '信号上的 tool_error_class;sig_id 不变(第 40 条) sig_id 只由 (盐, session_ref, 事件序号) 决定:新字段非空时仍等于 sigIdFor;改失败文本(类变了)sig_id 不变',
    ],
    restored: true,
  },
  {
    id: 'marker-retrieved-from-quoted',
    failed: 1,
    skipped: 0,
    killedBy: [
      'claude:块所在事件与复述事件不计入计数 / 信号,标记被取回 工具结果里被引用的块(cat 了别的会话):排除计数但不取回标记(避免假「多标记」)',
    ],
    restored: true,
  },
  {
    id: 'block-prefix-anywhere',
    failed: 3,
    skipped: 0,
    killedBy: [
      '块识别(纯函数) 行首(允许空格 / 制表符)以前缀开头才是块;取回标记要求形状恰好;正文 = 标记行之后各行',
      '块识别(纯函数) 只按 \\n 切行:U+2028 不是行分隔(同 reader 的 C2)',
      'claude:块所在事件与复述事件不计入计数 / 信号,标记被取回 treat 块作为用户消息:不计 user_messages、不产信号;对照:去掉前缀就被计入',
    ],
    restored: true,
  },
  {
    id: 'multi-marker-threshold',
    failed: 2,
    skipped: 0,
    killedBy: [
      '标记归并 R21-6.6 0 个 → 关联失败;1 个 → ok;≥ 2 个不同 → 多标记;同一标记重复不算多;缺键 → 未采集',
      'claude:块所在事件与复述事件不计入计数 / 信号,标记被取回 同一会话两个不同标记 → 多标记;一个都没有 → 关联失败;恰一个 → ok',
    ],
    restored: true,
  },
  {
    id: 'zero-marker-not-failure',
    failed: 2,
    skipped: 0,
    killedBy: [
      '标记归并 R21-6.6 0 个 → 关联失败;1 个 → ok;≥ 2 个不同 → 多标记;同一标记重复不算多;缺键 → 未采集',
      'claude:块所在事件与复述事件不计入计数 / 信号,标记被取回 同一会话两个不同标记 → 多标记;一个都没有 → 关联失败;恰一个 → ok',
    ],
    restored: true,
  },
  {
    id: 'markers-unsorted',
    failed: 2,
    skipped: 0,
    killedBy: [
      '复述索引的会话级上限与块登记规则 超过 4 个不同标记:去重升序保留前 4 个,分类仍为多标记',
      '标记归并 R21-6.6 追踪器:去重、升序、≤ 4',
    ],
    restored: true,
  },
  {
    id: 'codex-kimi-detect-injection',
    failed: 1,
    skipped: 0,
    killedBy: [
      'codex / kimi 不识别注入(行为与引入前一致,不写三键) read() 不带 injection();claude / pi 带',
    ],
    restored: true,
  },
  {
    id: 'retry-success-not-ending',
    failed: 2,
    skipped: 0,
    killedBy: [
      'RetryChainTracker(纯函数) 同一工具连续失败累加;该工具成功结束链;别的工具的结果不断链',
      'retry_chain_len / retry_chain_max(经管线,claude) 成功结束:失败失败成功再失败 → 序号 1、2、(成功断链)、1;max = 2',
    ],
    restored: true,
  },
  {
    id: 'retry-other-tool-breaks-chain',
    failed: 3,
    skipped: 0,
    killedBy: [
      'RetryChainTracker(纯函数) 同一工具连续失败累加;该工具成功结束链;别的工具的结果不断链',
      'retry_chain_len / retry_chain_max(经管线,claude) 穿插:别的工具的失败 / 成功、用户消息都不断链',
      'retry_chain_len / retry_chain_max(经管线,claude) 链的身份用完整原始工具名:共享 192 字符前缀的两个名字是两个工具',
    ],
    restored: true,
  },
  {
    id: 'retry-chain-across-sessions',
    failed: 7,
    skipped: 0,
    killedBy: [
      'retry_chain_len / retry_chain_max(经管线,claude) 放弃:会话结束时链仍未成功 → 停在当前长度(max = 3)',
      'retry_chain_len / retry_chain_max(经管线,claude) 跨会话不连:前一个会话以 Bash 失败结尾,后一个以 Bash 失败开头 → 后者从 1 起',
      'retry_chain_len / retry_chain_max(经管线,claude) 穿插:别的工具的失败 / 成功、用户消息都不断链',
      'retry_chain_len / retry_chain_max(经管线,claude) 没有失败 → retry_chain_max = 0、信号不带 retry_chain_len',
      'retry_chain_len / retry_chain_max(经管线,claude) 被注入排除的结果事件不进链(正向:真实失败照常计链)',
      'retry_chain_len / retry_chain_max(经管线,claude) 找不到工具名的失败(tool_use_id 对不上)→ 不成链,但仍有 tool_error_class',
      '信号上的 tool_error_class;sig_id 不变(第 40 条) sig_id 只由 (盐, session_ref, 事件序号) 决定:新字段非空时仍等于 sigIdFor;改失败文本(类变了)sig_id 不变',
    ],
    restored: true,
  },
  {
    id: 'retry-unnamed-chains',
    failed: 2,
    skipped: 0,
    killedBy: [
      'RetryChainTracker(纯函数) 没有工具名的失败不成链、不改状态',
      'retry_chain_len / retry_chain_max(经管线,claude) 找不到工具名的失败(tool_use_id 对不上)→ 不成链,但仍有 tool_error_class',
    ],
    restored: true,
  },
  {
    id: 'sidechain-block-scanned',
    failed: 1,
    skipped: 0,
    killedBy: [
      'claude:块所在事件与复述事件不计入计数 / 信号,标记被取回 整行忽略的侧链行不参与识别:侧链里的块不取回标记、不登记复述正文(对照:同样的块在主线里就生效)',
    ],
    restored: true,
  },
  {
    id: 'excluded-event-loses-external',
    failed: 1,
    skipped: 0,
    killedBy: [
      'claude:块所在事件与复述事件不计入计数 / 信号,标记被取回 被排除的外部内容事件仍把会话记为外部内容:后续信号摘录为空(对照:非外部工具时摘录保留)',
    ],
    restored: true,
  },
  {
    id: 'retry-key-truncated',
    failed: 1,
    skipped: 0,
    killedBy: [
      'retry_chain_len / retry_chain_max(经管线,claude) 链的身份用完整原始工具名:共享 192 字符前缀的两个名字是两个工具',
    ],
    restored: true,
  },
  {
    id: 'injection-index-unbounded',
    failed: 2,
    skipped: 0,
    killedBy: [
      '复述索引的会话级上限与块登记规则 窗口总数超过 INJECTION_WINDOWS_MAX → 抛 InjectionIndexLimitError(不是静默当无复述);未超则正常',
      '复述索引的会话级上限与块登记规则 经管线:多块长会话超限 → read_error(带类名)、不产信号、不写计数行;对照:3 个块的会话照常 processed',
    ],
    restored: true,
  },
  {
    id: 'invalid-marker-block-body-not-registered',
    failed: 1,
    skipped: 0,
    killedBy: [
      '复述索引的会话级上限与块登记规则 标记形状不对的块:照常登记正文(后续复述被排除),只是不取回标记;对照:同一正文没有块时复述照常计入',
    ],
    restored: true,
  },
  {
    id: 'block-body-truncated',
    failed: 1,
    skipped: 0,
    killedBy: [
      '复述索引的会话级上限与块登记规则 块正文超过 4096 码点 → fail-closed(InjectionIndexLimitError,不截断);恰 4096 照常',
    ],
    restored: true,
  },
  {
    id: 'signal-fields-any-kind',
    failed: 1,
    skipped: 0,
    killedBy: [
      'Signal 追加键 字段间约束:tool_error_class / retry_chain_len 只许出现在 tool_result_failed 信号上',
    ],
    restored: true,
  },
  {
    id: 'stat-keys-partial-allowed',
    failed: 1,
    skipped: 0,
    killedBy: [
      'SessionStat 追加键 字段间约束:rsi_markers 与 injection_excluded 成组;retry_chain_max 独立可选',
    ],
    restored: true,
  },
  {
    id: 'markers-not-strictly-ascending',
    failed: 1,
    skipped: 0,
    killedBy: ['SessionStat 追加键 rsi_markers 必须严格升序'],
    restored: true,
  },
  {
    id: 'tool-error-empty-is-other',
    failed: 1,
    skipped: 0,
    killedBy: [
      'tool_error_class 固定映射表 没有失败文本(缺失 / 空 / 纯空白)→ undefined(不写字段,不写 other)',
    ],
    restored: true,
  },
  {
    id: 'tool-error-table-reversed',
    failed: 1,
    skipped: 0,
    killedBy: ['tool_error_class 固定映射表 有序、首个命中即用:多类重叠归到靠前的类'],
    restored: true,
  },
];
