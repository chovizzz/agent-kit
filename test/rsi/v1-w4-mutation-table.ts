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
    expectRed: ['行首(允许空格 / 制表符)以前缀开头才是块', 'treat 块作为用户消息'],
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
    expectRed: ['追踪器:去重、升序、≤ 4'],
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
    expectRed: ['同一工具连续失败累加', '穿插:别的工具的失败 / 成功、用户消息都不断链'],
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
    expectRed: ['跨会话不连'],
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
export const V1_W4_RESULTS: readonly V1W4Result[] = [];
