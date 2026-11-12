/**
 * §21 V1 W6 必杀变异(变差检验:会话归并、资格、分层、置换检验、OBF 累计边界、C4、背景分段、读取层;契约 R21-6.6 / R21-6.7 / R21-7.2 / R21-7.4 / R21-7.4a /
 * R21-7.6 / R21-7.7 / R21-7.8、§21.24 W0-10 / W0-14)。
 * 执行方式同 W5:验证机私有检出里 cp 备份 → 按锚点替换(每个锚点在对应文件里**恰好出现一次**)→ 跑 `tests` → 失败集合非空、全部命中 `expectRed`、
 * `mustKill` 每项至少命中一个、没有 skipped → cp 还原并逐文件 sha256 核对。**不用 git checkout / stash 还原**。
 * 本文件只写表与每条变异期望红的测试名(`expectRed` 是杀手测试名里的字面子串);变异由主代理执行,结果记进 `V1_W6_RESULTS`(W6 实装块不执行变异,故留空)。
 * 变异 id 用短的下划线词(长串连字符码会被 CI 的 A10 判成高熵)。
 *
 * 不可变异的点(如实记录):`permute.ts` 里浮点并列容差(1e-9)改成 0 不会改变任何可见的 p(并列只在求和顺序不同时才差一个 ulp,夹具的数值恰好精确);
 * `math.ts` 里 `t ≤ 0 → 0` 与 `t = 0` 时 z/√t = ∞ → 上尾 0 等价;`Math.min(1, t)` 的封顶在 `α*` 再被 `min(alpha, …)` 封顶时等价。它们靠入参校验与上下界用例钉住。
 */
export interface Edit {
  file: string;
  anchor: string;
  replacement: string;
}

export interface V1W6Mutation {
  id: string;
  /** 契约条款 / 该不变量 */
  clause: string;
  edits: readonly Edit[];
  /** 相对 `test/` */
  tests: readonly string[];
  expectRed: readonly string[];
  mustKill: readonly string[];
}

export interface V1W6Result {
  id: string;
  failed: number;
  skipped: number;
  killedBy: readonly string[];
  restored: boolean;
}

const A = 'src/rsi/analysis/';
const MATH = `${A}math.ts`;
const RNG = `${A}rng.ts`;
const TYPES = `${A}types.ts`;
const STRATA = `${A}strata.ts`;
const STATS = `${A}stats.ts`;
const PERM = `${A}permute.ts`;
const ASM = `${A}assemble.ts`;
const AN = `${A}analyze.ts`;
const MEAS = `${A}measures.ts`;
const EVT = `${A}events.ts`;
const RUN = `${A}run.ts`;
const READ = `${A}read.ts`;

const T_MATH = 'rsi/analysis/w6-math.test.ts';
const T_STATS = 'rsi/analysis/w6-stats.test.ts';
const T_ASM = 'rsi/analysis/w6-assemble.test.ts';
const T_MEAS = 'rsi/analysis/w6-measures.test.ts';
const T_AN = 'rsi/analysis/w6-analyze.test.ts';
const T_RUN = 'rsi/analysis/w6-run.test.ts';
const T_READ = 'rsi/analysis/w6-read.test.ts';

const drop = (file: string, anchor: string): Edit => ({ file, anchor, replacement: '' });
/** 改动 OBF 边界 / 置换 p 的变异会连带让各指标的「判变差」正例改变,这些用例都可能红 */
const HARM_TESTS = [
  'C1:treat 每会话 3 次失败',
  'C2:retry_chain_max 越大越差',
  'C3:显式教训',
  'C6:treat 的完整率明显更低',
] as const;

/** 新增:C6 分母(ITT)与最坏情况敏感性两条分析用例的名字片段 */
const T_ITT = 'L2 C6 分母按 ITT:已关联且资格不成立的账行不进分母';
const T_WORST = 'M1 R21-6.7 关联失败按最坏情况做敏感性';

const swap = (file: string, anchor: string, replacement: string): Edit => ({
  file,
  anchor,
  replacement,
});

export const V1_W6_MUTATIONS: readonly V1W6Mutation[] = [
  // ---- R21-7.4 α 分配与 OBF 累计边界 ----
  {
    id: 'alpha_div5',
    clause: 'R21-7.4:总 α 在 C1、C2、C3、C6 四项间平分(÷4);分母误取含 C4 的五项',
    edits: [
      swap(TYPES, 'RSI_ALPHA_WORSE_TOTAL / HARM_P_METRICS.length', 'RSI_ALPHA_WORSE_TOTAL / 5'),
    ],
    tests: [T_AN],
    expectRed: ['四项各 0.025', '第 k 次查看的边界', ...HARM_TESTS],
    mustKill: ['四项各 0.025'],
  },
  {
    id: 'obf_incremental',
    clause: 'W0-10:OBF 消耗取累计 α*(t_k)(偏向回滚),不是减去此前消耗的增量',
    edits: [
      swap(
        AN,
        'const boundary = obfCumulativeAlpha(cfg.alphaPerMetric, t);',
        'const boundary = obfCumulativeAlpha(cfg.alphaPerMetric, t) - (k > 1 ? obfCumulativeAlpha(cfg.alphaPerMetric, 0.5) : 0);',
      ),
    ],
    tests: [T_AN],
    expectRed: [
      '第 k 次查看的边界',
      ...HARM_TESTS,
      'R21-7.4 C1:treat 每会话 3 次失败、control 多为 0:信息时间够了才越界(k 在 10–12,t ≥ 0.4),之前的查看都没越',
      'C2:retry_chain_max 越大越差(log(1+x) 的分层均值差);缺键的会话不进 C2、更不当 0',
      'C3:显式教训 / 纠正多的一组更差',
      'C6:treat 的完整率明显更低(关联失败的账行没有项目,按 agent 分层)',
    ],
    mustKill: ['第 k 次查看的边界'],
  },
  {
    id: 'obf_sqrt_flip',
    clause: 'R21-7.4:α*(t) = 2 − 2Φ(z/√t);把 √t 除成乘',
    edits: [swap(MATH, 'z / Math.sqrt(tt)', 'z * Math.sqrt(tt)')],
    tests: [T_MATH, T_AN],
    expectRed: [
      'α*(1) = α',
      '随 t 严格递增',
      '第 k 次查看的边界',
      ...HARM_TESTS,
      '同样的效应出现得太早',
      'R21-7.4 C1:treat 每会话 3 次失败、control 多为 0:信息时间够了才越界(k 在 10–12,t ≥ 0.4),之前的查看都没越',
      'L5 带容差的夹具:Φ⁻¹(0.975) = 1.959964;α*(0.5) ≈ 0.001524(独立算出,容差 ±5e-6)',
    ],
    mustKill: ['α*(1) = α'],
  },
  {
    id: 'quantile_no_refine',
    clause: 'W0-10:Φ⁻¹ 用固定有理逼近;去掉牛顿修正后精度只剩 4.5e-4,夹具容差 5e-5 要红',
    edits: [swap(MATH, 'for (let i = 0; i < 2; i++) z +=', 'for (let i = 0; i < 0; i++) z +=')],
    tests: [T_MATH],
    expectRed: [
      'Φ⁻¹:表值',
      'Φ⁻¹ 与 Φ 互为反函数',
      'α*(1) = α;α*(0.5)、α*(0.25) 取独立算出的表值',
      'L5 带容差的夹具:Φ⁻¹(0.975) = 1.959964;α*(0.5) ≈ 0.001524(独立算出,容差 ±5e-6)',
      '随 t 严格递增、不超过 α;t ≤ 0 为 0(不判);t > 1 按 1',
    ],
    mustKill: ['Φ⁻¹:表值'],
  },
  {
    id: 'info_time_no_cap',
    clause: 'R21-7.4:信息时间 t = min(1, 对照组有观测会话数 / 120)',
    edits: [
      swap(MATH, 'Math.min(1, controlObserved / maxPerArm)', '(controlObserved / maxPerArm)'),
    ],
    tests: [T_MATH],
    expectRed: ['取值与封顶'],
    mustKill: ['取值与封顶'],
  },
  {
    id: 'info_time_all_sessions',
    clause: 'R21-7.4:t 按对照组的有观测会话数计(不是两组合计)',
    edits: [
      swap(
        AN,
        "const controlN = prefix.filter((s) => s.arm === 'control').length;",
        'const controlN = prefix.length;',
      ),
    ],
    tests: [T_AN],
    expectRed: [
      '第 k 次查看的边界',
      ...HARM_TESTS,
      '同样的效应出现得太早',
      'R21-7.4 C1:treat 每会话 3 次失败、control 多为 0:信息时间够了才越界(k 在 10–12,t ≥ 0.4),之前的查看都没越',
      '资格不成立的会话不进统计量,但仍计入信息时间与查看节奏',
      'R21-7.4a 19 个 treat + 1 个 control:并层后仍稀疏 → 全部剔除;look 无效、kind=no_decision、从未有效查看',
      'R21-7.7 当前段 = 账里最后一行的 background_fp;更早的段只出敏感性点估计,不判、不产事件',
      '回到旧指纹(A → B → A)也是新段:t 从 0 重新计,旧的 A 段不并入当前 A 段',
    ],
    mustKill: ['第 k 次查看的边界'],
  },
  // ---- R21-7.4 查看节奏与判变差 ----
  {
    id: 'look_ceil',
    clause: 'R21-7.4:每 RSI_LOOK_EVERY 个新有观测会话查看一次(满 10 个才查看,不是只要有就查)',
    edits: [
      swap(
        AN,
        'Math.floor(segObs.length / cfg.lookEvery)',
        'Math.ceil(segObs.length / cfg.lookEvery)',
      ),
    ],
    tests: [T_AN],
    expectRed: [
      '9 个会话没有查看',
      '部分层稀疏',
      '并层:稀疏项目并入',
      T_WORST,
      'M1 负例:没有任何查看 → 没有最坏情况结果(null)',
    ],
    mustKill: ['9 个会话没有查看'],
  },
  {
    id: 'prefix_unsorted',
    clause: '无状态查看计划:会话按 (ts, session_ref) 排序取前缀,与输入顺序无关',
    edits: [drop(AN, '.sort(bySession)')],
    tests: [T_AN],
    expectRed: ['查看点按 (ts, session_ref) 排序'],
    mustKill: ['查看点按 (ts, session_ref) 排序'],
  },
  {
    id: 'cross_never',
    clause: 'R21-7.4:p ≤ α*(t_k) → 越界;永不越界 = 变差不会触发回滚',
    edits: [swap(AN, 'crossed: r.p <= boundary', 'crossed: false')],
    tests: [T_AN, T_RUN],
    expectRed: [
      ...HARM_TESTS,
      'C1 变差 → harm',
      '没有越界 → 不产出事件',
      'R21-7.4 C1:treat 每会话 3 次失败、control 多为 0:信息时间够了才越界(k 在 10–12,t ≥ 0.4),之前的查看都没越',
      'C2:retry_chain_max 越大越差(log(1+x) 的分层均值差);缺键的会话不进 C2、更不当 0',
      'C3:显式教训 / 纠正多的一组更差',
      'C6:treat 的完整率明显更低(关联失败的账行没有项目,按 agent 分层)',
    ],
    mustKill: ['C1:treat 每会话 3 次失败'],
  },
  {
    id: 'cross_loose',
    clause: 'R21-7.4:边界是 OBF 的 α*(t_k),不是固定阈值;早期查看用宽阈值 = 误回滚',
    edits: [swap(AN, 'crossed: r.p <= boundary', 'crossed: r.p <= 0.01')],
    tests: [T_AN],
    expectRed: [
      '同样的效应出现得太早',
      '没有效应(两组同分布)',
      'R21-7.4 C1:treat 每会话 3 次失败、control 多为 0:信息时间够了才越界(k 在 10–12,t ≥ 0.4),之前的查看都没越',
    ],
    mustKill: ['同样的效应出现得太早'],
  },
  {
    id: 'perm_p_zero_floor',
    clause: 'R21-7.2:置换 p = (1 + #{≥ 观测}) / (1 + B),不是 #/B(p 可以为 0)',
    edits: [swap(PERM, 'p: (1 + atLeast) / (1 + permutations)', 'p: atLeast / permutations')],
    tests: [T_AN, T_STATS],
    expectRed: [
      '同样的效应出现得太早',
      ...HARM_TESTS,
      'R21-7.4 C1:treat 每会话 3 次失败、control 多为 0:信息时间够了才越界(k 在 10–12,t ≥ 0.4),之前的查看都没越',
    ],
    mustKill: ['同样的效应出现得太早'],
  },
  {
    id: 'perm_direction_flip',
    clause: 'R21-7.2:单侧方向 = 统计量越大越差;翻转后变好被当成变差',
    edits: [swap(PERM, 'if (v >= floor) atLeast += 1;', 'if (v <= floor) atLeast += 1;')],
    tests: [T_STATS, T_AN],
    expectRed: [
      '单层 treat [5,5,5] vs control [0,0,0]',
      '方向相反(treat 更好)',
      ...HARM_TESTS,
      T_WORST,
      'R21-7.4 C1:treat 每会话 3 次失败、control 多为 0:信息时间够了才越界(k 在 10–12,t ≥ 0.4),之前的查看都没越',
      '同样的效应出现得太早(40 会话,t ≈ 0.17):OBF 边界极小,不越界',
      'C2:retry_chain_max 越大越差(log(1+x) 的分层均值差);缺键的会话不进 C2、更不当 0',
      'C3:显式教训 / 纠正多的一组更差',
      'C6:treat 的完整率明显更低(关联失败的账行没有项目,按 agent 分层)',
      '两层各 3+3 的均值差:精确 p 与置换 p 接近',
    ],
    mustKill: ['单层 treat [5,5,5] vs control [0,0,0]'],
  },
  {
    id: 'rng_upper_unchecked',
    clause: 'R21-7.2:随机源可注入;[0,1) 之外的值不得静默使用',
    edits: [swap(RNG, '|| u < 0 || u >= 1', '|| u < 0')],
    tests: [T_STATS, T_AN, T_RUN],
    expectRed: ['注入的随机源返回 [0,1) 之外的值', '注入的随机源越界'],
    mustKill: ['注入的随机源返回 [0,1) 之外的值'],
  },
  {
    id: 'rng_label_ignored',
    clause: 'R21-7.2:种子可复算;不同 (指标, 查看序号) 用独立随机流',
    edits: [swap(RNG, ".update(`${seed}\\u0000${label}`, 'utf8')", ".update(seed, 'utf8')")],
    tests: [T_STATS],
    expectRed: ['同一 (种子, 标签) 同一序列'],
    mustKill: ['同一 (种子, 标签) 同一序列'],
  },
  // ---- R21-7.2 统计量 ----
  {
    id: 'mh_wrong_weight',
    clause: 'R21-7.2:MH 率比的分子权重是 n0/N(treat 事件 × control 会话数)',
    edits: [swap(STATS, 'num += (c.s1 * c.n0) / n;', 'num += (c.s1 * c.n1) / n;')],
    tests: [T_STATS],
    expectRed: ['Mantel–Haenszel 率比'],
    mustKill: ['Mantel–Haenszel 率比'],
  },
  {
    id: 'mean_diff_unweighted',
    clause: 'R21-7.2:C2 分层均值差的权重 n1·n0/(n1+n0)',
    edits: [swap(STATS, 'w += (c.n1 * c.n0) / n;', 'w += 1;')],
    tests: [T_STATS],
    expectRed: ['C2 分层均值差', 'C6 完整率差 = control − treat = 均值差的相反数'],
    mustKill: ['C2 分层均值差'],
  },
  {
    id: 'c6_sign_flip',
    clause: 'R21-7.2:C6 完整率差 = control − treat(treat 更不完整才是变差)',
    edits: [swap(STATS, "return kind === 'mean_diff' ? d : -d;", 'return d;')],
    tests: [T_STATS, T_AN],
    expectRed: ['C6 完整率差', 'C6:treat 的完整率明显更低', T_ITT, T_WORST],
    mustKill: ['C6 完整率差'],
  },
  // ---- R21-7.2 / 7.4a 分层 ----
  {
    id: 'strata_no_pool',
    clause: 'R21-7.2:任一组 < 2 的层并入该 agent 的「其它」层',
    edits: [
      drop(STRATA, 'other.treat.push(...acc.treat);'),
      drop(STRATA, 'other.control.push(...acc.control);'),
    ],
    tests: [T_STATS, T_AN],
    expectRed: [
      '两组都 ≥ 2 的层单独保留',
      '并层:稀疏项目并入',
      'claude 与 pi 的「其它」层不合并',
      '19 个 treat + 1 个 control',
      '部分层稀疏',
      '并层后「其它」层仍有一组 < 2',
    ],
    mustKill: ['两组都 ≥ 2 的层单独保留'],
  },
  {
    id: 'strata_agent_merged',
    clause: 'R21-7.2:claude 与 pi 的「其它」层不合并(分层含 agent)',
    edits: [
      swap(STRATA, 'byAgent.get(u.agent)', "byAgent.get('*')"),
      swap(STRATA, 'byAgent.set(u.agent,', "byAgent.set('*',"),
    ],
    tests: [T_STATS],
    expectRed: ['claude 与 pi 的「其它」层不合并', '两组都 ≥ 2 的层单独保留'],
    mustKill: ['claude 与 pi 的「其它」层不合并'],
  },
  {
    id: 'strata_keep_sparse',
    clause: 'R21-7.4a:并层后仍稀疏的层剔除出置换检验',
    edits: [swap(STRATA, 'if (usable(other)) {', 'if (true) {')],
    tests: [T_STATS, T_AN],
    expectRed: [
      '并层后「其它」层仍有一组 < 2',
      '19 个 treat + 1 个 control',
      '部分层稀疏',
      'C2:retry_chain_max 越大越差(log(1+x) 的分层均值差);缺键的会话不进 C2、更不当 0',
      '资格不成立的会话不进统计量,但仍计入信息时间与查看节奏',
    ],
    mustKill: ['并层后「其它」层仍有一组 < 2'],
  },
  {
    id: 'strata_min_one',
    clause: 'R21-7.2:每组至少 2 个会话',
    edits: [
      swap(TYPES, 'export const MIN_ARM_PER_STRATUM = 2;', 'export const MIN_ARM_PER_STRATUM = 1;'),
    ],
    tests: [T_STATS],
    expectRed: [
      '两组都 ≥ 2 的层单独保留',
      'claude 与 pi 的「其它」层不合并',
      '并层后「其它」层仍有一组 < 2',
    ],
    mustKill: ['两组都 ≥ 2 的层单独保留'],
  },
  {
    id: 'dropped_not_counted',
    clause: 'R21-7.4a:剔除的会话数写进审计',
    edits: [drop(STRATA, 'droppedSessions += n;')],
    tests: [T_STATS, T_AN],
    expectRed: ['并层后「其它」层仍有一组 < 2', '部分层稀疏', '19 个 treat + 1 个 control'],
    mustKill: ['并层后「其它」层仍有一组 < 2'],
  },
  {
    id: 'look_always_valid',
    clause: 'R21-7.4a:无层可用 = 本次不判定、不消耗 α;不能当作有效查看',
    edits: [swap(AN, "valid: metrics.some((m) => m.status === 'tested'),", 'valid: true,')],
    tests: [T_AN],
    expectRed: ['19 个 treat + 1 个 control'],
    mustKill: ['19 个 treat + 1 个 control'],
  },
  {
    id: 'zero_events_tested',
    clause: 'R21-7.2:两组均零事件 → 证据不足(不检验、不计作有效查看)',
    edits: [
      swap(
        AN,
        "return { ...base, status: 'insufficient', p: null, crossed: false, estimate: null };",
        "return { ...base, status: 'tested', p: null, crossed: false, estimate: null };",
      ),
    ],
    tests: [T_AN],
    expectRed: ['两组均零事件'],
    mustKill: ['两组均零事件'],
  },
  // ---- C2 / C4 / 资格 ----
  {
    id: 'c2_missing_zero',
    clause: 'W0-14:缺 retry_chain_max = 未测 / 不可比,不得当 0',
    edits: [
      swap(
        AN,
        'if (x.retry_chain_max === null || !C2_COMPARABLE_AGENTS.includes(x.agent)) continue;',
        'if (!C2_COMPARABLE_AGENTS.includes(x.agent)) continue;',
      ),
    ],
    tests: [T_AN],
    expectRed: ['C2:retry_chain_max 越大越差'],
    mustKill: ['C2:retry_chain_max 越大越差'],
  },
  {
    id: 'c2_any_agent',
    clause: 'W0-14:codex / kimi 无工具名,C2 与 claude / pi 不可比',
    edits: [
      swap(
        AN,
        'if (x.retry_chain_max === null || !C2_COMPARABLE_AGENTS.includes(x.agent)) continue;',
        'if (x.retry_chain_max === null) continue;',
      ),
    ],
    tests: [T_AN],
    expectRed: ['C2 不跨 agent 能力比较'],
    mustKill: ['C2 不跨 agent 能力比较'],
  },
  {
    id: 'c6_all_complete',
    clause: 'R21-6.6:关联失败 / 多标记的账行计入 C6 的不完整',
    edits: [swap(AN, 'v: l.complete ? 1 : 0', 'v: 1')],
    tests: [T_AN],
    expectRed: ['C6:treat 的完整率明显更低', T_ITT],
    mustKill: ['C6:treat 的完整率明显更低'],
  },
  {
    id: 'c6_unjudgeable_counted',
    clause: 'R21-1.7:采集尚未覆盖的账行不进 C6(不把「还没读到」当关联失败)',
    edits: [swap(AN, 'l.judgeable && l.eligible !== false', 'l.eligible !== false')],
    tests: [T_AN],
    expectRed: ['C6 负例:采集尚未覆盖'],
    mustKill: ['C6 负例:采集尚未覆盖'],
  },
  {
    id: 'eligibility_ignored',
    clause: 'R21-6.7:统计量只用资格成立的会话',
    edits: [swap(AN, 'const elig = eligibleOf(prefix);', 'const elig = prefix;')],
    tests: [T_AN],
    expectRed: ['资格不成立的会话不进统计量'],
    mustKill: ['资格不成立的会话不进统计量'],
  },
  {
    id: 'c4_limit_ge',
    clause: 'R21-7.1:C4 上限 ≤ 1536 字节(1536 不越限,1537 越限)',
    edits: [swap(AN, "bytes > limit ? 'exceeded'", "bytes >= limit ? 'exceeded'")],
    tests: [T_AN],
    expectRed: ['c4Check:≤ 1536 通过', '越限 → harm_c4'],
    mustKill: ['c4Check:≤ 1536 通过'],
  },
  {
    id: 'c4_unavailable_ok',
    clause: 'fail-closed:C4 字节数不可得不得当作通过',
    edits: [drop(AN, "if (bytes === null) return { status: 'unavailable', bytes, limit };")],
    tests: [T_AN],
    expectRed: ['c4Check:≤ 1536 通过', '越限 → harm_c4'],
    mustKill: ['c4Check:≤ 1536 通过'],
  },
  {
    id: 'c4_not_enforced',
    clause: 'R21-7.4:C4 越限即回滚',
    edits: [swap(AN, "if (c4.status === 'exceeded') harm =", 'if (false) harm =')],
    tests: [T_AN, T_RUN],
    expectRed: ['越限 → harm_c4', 'C4 越限 → harm_c4'],
    mustKill: ['越限 → harm_c4'],
  },
  // ---- R21-7.7 背景分段 ----
  {
    id: 'segment_first',
    clause: 'R21-7.7:主分析只用当前段(账里最后一段)',
    edits: [swap(AN, 'const lastRun = runFp.length - 1;', 'const lastRun = 0;')],
    tests: [T_AN],
    expectRed: [
      '当前段 = 账里最后一行',
      '回到旧指纹(A → B → A)也是新段:t 从 0 重新计,旧的 A 段不并入当前 A 段',
    ],
    mustKill: ['当前段 = 账里最后一行'],
  },
  {
    id: 'segment_merged',
    clause: 'R21-7.7:跨段不合并;新段从 t = 0 重新计',
    edits: [
      swap(AN, 'observed.filter((s) => runOf.get(s.marker) === lastRun)', 'observed.slice()'),
    ],
    tests: [T_AN],
    expectRed: [
      '当前段 = 账里最后一行',
      '回到旧指纹(A → B → A)也是新段:t 从 0 重新计,旧的 A 段不并入当前 A 段',
    ],
    mustKill: ['当前段 = 账里最后一行'],
  },
  // ---- R21-7.6 / 7.8 报告 ----
  {
    id: 'positive_open',
    clause: 'R21-7.13:正向方向恒不可判(没有任何「变好」路径)',
    edits: [swap(AN, "positive: 'not_decidable',", "positive: 'decidable' as never,")],
    tests: [T_AN, T_RUN],
    expectRed: ['方向相反(treat 更好)', 'C1 变差', 'C1:treat 每会话 3 次失败'],
    mustKill: ['方向相反(treat 更好)'],
  },
  {
    id: 'overlaps_mixed_off',
    clause: 'R21-7.8:overlaps_preset 单列报告(各行不一致要标出)',
    edits: [swap(AN, 'new Set(overlaps).size > 1', 'new Set(overlaps).size > 5')],
    tests: [T_AN],
    expectRed: ['overlaps_preset 取本段最后一行'],
    mustKill: ['overlaps_preset 取本段最后一行'],
  },
  {
    id: 'max_arm_min',
    clause: 'R21-7.6:到上限按两组有观测会话数的较大者',
    edits: [swap(AN, 'Math.max(treatObs, controlObs)', 'Math.min(treatObs, controlObs)')],
    tests: [T_AN],
    expectRed: ['max_arm_sessions'],
    mustKill: ['max_arm_sessions'],
  },
  {
    id: 'segment_by_fp_only',
    clause: 'R21-7.7:背景指纹换段后新段从 t = 0 重新计;回到旧指纹(A → B → A)也是新段',
    edits: [
      swap(
        AN,
        'if (runFp[runFp.length - 1] !== l.background_fp) runFp.push(l.background_fp);',
        'if (!runFp.includes(l.background_fp)) runFp.push(l.background_fp);',
      ),
    ],
    tests: [T_AN],
    expectRed: ['回到旧指纹(A → B → A)也是新段'],
    mustKill: ['回到旧指纹(A → B → A)也是新段'],
  },
  // ---- R21-6.6 / W0-14 会话归并 ----
  {
    id: 'dedupe_latest',
    clause: 'W0-14:同一标记出现在多个会话文件,按标记去重,取最早的',
    edits: [swap(ASM, 'startOf(a) - startOf(b) ||', 'startOf(b) - startOf(a) ||')],
    tests: [T_ASM],
    expectRed: [
      '取 (ts, session_ref) 最早的会话',
      '最早的携带者本身是多标记',
      '信号度量与 retry_chain_max 原样带入;retry_chain_max 缺键 = null(不是 0)',
      '账行保持账的先后顺序;background_fp 取自账行',
    ],
    mustKill: ['取 (ts, session_ref) 最早的会话'],
  },
  {
    id: 'dedupe_off',
    clause: 'W0-14:副本会话整个丢弃,不重复计入',
    edits: [swap(ASM, 'if (keeper.get(m) !== it) {', 'if (false) {')],
    tests: [T_ASM],
    expectRed: [
      '取 (ts, session_ref) 最早的会话',
      '开始时刻相同按 session_ref',
      '最早的携带者本身是多标记',
    ],
    mustKill: ['取 (ts, session_ref) 最早的会话'],
  },
  {
    id: 'multi_marker_kept',
    clause: 'R21-6.6:≥ 2 个不同标记 → 多标记,整会话排除',
    edits: [swap(ASM, 'if (markers.length >= 2) {', 'if (markers.length >= 99) {')],
    tests: [T_ASM],
    expectRed: ['≥ 2 个不同标记 → 多标记', '最早的携带者本身是多标记'],
    mustKill: ['≥ 2 个不同标记 → 多标记'],
  },
  {
    id: 'agent_mismatch_linked',
    clause: '账行与计数行的 agent 须一致才算关联',
    edits: [swap(ASM, 'if (it.agent !== line.agent) {', 'if (false) {')],
    tests: [T_ASM],
    expectRed: ['计数行 agent 与账行 agent 不一致'],
    mustKill: ['计数行 agent 与账行 agent 不一致'],
  },
  {
    id: 'ledger_dup_allowed',
    clause: '账里同一标记出现在两行 assign = 输入非法(fail-closed)',
    edits: [
      swap(
        ASM,
        "if (seenMarkers.has(l.marker)) throw new AnalysisInputError('duplicate_marker_in_ledger');",
        'void 0;',
      ),
    ],
    tests: [T_ASM, T_RUN],
    expectRed: ['账里同一标记出现在两行 assign', '账里标记重复'],
    mustKill: ['账里同一标记出现在两行 assign'],
  },
  {
    id: 'other_candidate_lines',
    clause: '分析对象只含本候选的 treat / control 账行',
    edits: [swap(ASM, 'if (l.candidate_id !== input.candidateId) continue;', 'void 0;')],
    tests: [T_ASM],
    expectRed: [
      'excluded 行(含探针行)、别的候选的行',
      'R21-6.4 arm=excluded 的账行不进分析,只按原因码计入审计(C6 分母说明);别的候选 / 窗口之前的不计',
    ],
    mustKill: ['excluded 行(含探针行)、别的候选的行'],
  },
  {
    id: 'excluded_not_counted',
    clause: 'R21-6.4:arm=excluded 的账行按原因码计入审计(C6 分母说明)',
    edits: [
      swap(ASM, 'audit.excluded_by_reason[r] = (audit.excluded_by_reason[r] ?? 0) + 1;', 'void 0;'),
    ],
    tests: [T_ASM],
    expectRed: ['arm=excluded 的账行不进分析'],
    mustKill: ['arm=excluded 的账行不进分析'],
  },
  {
    id: 'window_start_ignored',
    clause: 'R21-7.4:canary 与 adopted 信息不累计:窗口之前的账行不属于本次',
    edits: [drop(ASM, "if (parseMs(l.at, 'ledger_at') < startMs) continue;")],
    tests: [T_ASM, T_RUN],
    expectRed: [
      'excluded 行(含探针行)、别的候选的行',
      '窗口之前的账行不属于本次',
      'R21-6.4 arm=excluded 的账行不进分析,只按原因码计入审计(C6 分母说明);别的候选 / 窗口之前的不计',
    ],
    mustKill: ['excluded 行(含探针行)、别的候选的行'],
  },
  {
    id: 'unjudgeable_judged',
    clause: 'R21-1.7:账行 at 晚于采集覆盖时刻 → 不可判',
    edits: [swap(ASM, 'const judgeable = atMs <= throughMs;', 'const judgeable = true;')],
    tests: [T_ASM],
    expectRed: ['账行 at 晚于采集覆盖时刻'],
    mustKill: ['账行 at 晚于采集覆盖时刻'],
  },
  {
    id: 'not_collecting_observed',
    clause: 'R21-1.7 ②:不属采集中的项目不是有观测会话',
    edits: [swap(ASM, 'if (!input.collecting(it.stat.project_key)) {', 'if (false) {')],
    tests: [T_ASM],
    expectRed: ['不属采集中的项目', '已关联且资格不成立 → eligible=false'],
    mustKill: ['不属采集中的项目'],
  },
  // ---- 信号度量与资格 ----
  {
    id: 'c1_counts_all',
    clause: 'W0-7:C1 = tool_result_failed 信号计数',
    edits: [
      swap(
        MEAS,
        "loaded.filter((s) => s.event_kind === 'tool_result_failed')",
        'loaded.filter((s) => s.event_kind !== undefined)',
      ),
    ],
    tests: [T_MEAS],
    expectRed: ['C1 = tool_result_failed 信号数'],
    mustKill: ['C1 = tool_result_failed 信号数'],
  },
  {
    id: 'c3_typed_dropped',
    clause: 'W0-7:C3 = 显式教训 ∪ 用户纠正',
    edits: [
      drop(
        MEAS,
        "if (s.type === 'explicit_lesson' || s.type === 'user_correction') c3ids.add(s.sig_id);",
      ),
    ],
    tests: [T_MEAS],
    expectRed: ['C3 = 显式教训 ∪ 用户纠正'],
    mustKill: ['C3 = 显式教训 ∪ 用户纠正'],
  },
  {
    id: 'c3_lessons_dropped',
    clause: 'W0-7:C3 含反思器确定性分类的显式教训',
    edits: [drop(MEAS, 'for (const l of classifySignals(loaded).lessons) c3ids.add(l.sig_id);')],
    tests: [T_MEAS],
    expectRed: ['C3 = 显式教训 ∪ 用户纠正'],
    mustKill: ['C3 = 显式教训 ∪ 用户纠正'],
  },
  {
    id: 'eligible_days_long',
    clause: 'R21-6.7:资格窗口 30 个 UTC 日',
    edits: [
      swap(TYPES, 'export const ELIGIBILITY_DAYS = 30;', 'export const ELIGIBILITY_DAYS = 300;'),
    ],
    tests: [T_MEAS, T_RUN],
    expectRed: [
      '窗口内 → 成立',
      'W6b 命中信号早于「待判会话 UTC 日 − 30」',
      'W6b 会话 / 信号读取下限取整到 UTC 日零点',
    ],
    mustKill: ['窗口内 → 成立'],
  },
  {
    id: 'eligible_future_hit',
    clause: 'R21-6.7:只用会话开始之前的数据判定资格',
    edits: [
      swap(
        MEAS,
        '.some((h) => h < tsMs && utcDayStart(h) >= from)',
        '.some((h) => utcDayStart(h) >= from)',
      ),
    ],
    tests: [T_MEAS, T_RUN],
    expectRed: ['只用会话开始之前的数据', 'W6b A 09:00 开始'],
    mustKill: ['只用会话开始之前的数据', 'W6b A 09:00 开始'],
  },
  {
    id: 'eligible_any_project',
    clause: 'R21-6.7:资格看会话所属项目',
    edits: [swap(MEAS, '(byProject.get(projectKey) ?? [])', '[...byProject.values()].flat()')],
    tests: [T_MEAS],
    expectRed: ['只用会话开始之前的数据'],
    mustKill: ['只用会话开始之前的数据'],
  },
  // ---- 产出事件与编排 ----
  {
    id: 'event_worse_false',
    clause: 'R21-7.4:harm 事件的 worse 恒为 true',
    edits: [swap(EVT, 'metric: h.metric, worse: true', 'metric: h.metric, worse: false')],
    tests: [T_RUN],
    expectRed: ['C1 变差 → harm', 'C4 越限 → harm_c4(evidence 只含字节数与上限)'],
    mustKill: ['C1 变差 → harm'],
  },
  {
    id: 'event_for_any_kind',
    clause: '只有 harm 结论才产出事件(paused / unavailable / no_harm 不产出)',
    edits: [drop(EVT, "if (outcome.kind !== 'harm') return null;")],
    tests: [T_RUN],
    expectRed: ['本机 payload 漂移 → paused', '抛错 → unavailable'],
    mustKill: ['本机 payload 漂移 → paused'],
  },
  {
    id: 'drift_not_paused',
    clause: 'R21-7.7:本机 payload 漂移期间分析暂停',
    edits: [swap(RUN, "if ((await source.payloadDrift()) === 'drifted') {", 'if (false) {')],
    tests: [T_RUN],
    expectRed: ['本机 payload 漂移 → paused', ' 抛错 → unavailable(不是 no_harm)'],
    mustKill: ['本机 payload 漂移 → paused'],
  },
  {
    id: 'through_null_ok',
    clause: 'fail-closed:采集覆盖时刻不可得 → 不判定',
    edits: [
      drop(
        RUN,
        "if (throughIso === null) return { kind: 'unavailable', reason: 'collected_through_unknown' };",
      ),
    ],
    tests: [T_RUN],
    expectRed: ['采集覆盖时刻不可得'],
    mustKill: ['采集覆盖时刻不可得'],
  },
  {
    id: 'error_as_no_harm',
    clause: 'fail-closed:读失败永远不能落成「无伤害」',
    edits: [
      swap(
        RUN,
        "return { kind: 'unavailable', reason: reasonOf(e) };",
        "return { kind: 'no_harm' } as never;",
      ),
    ],
    tests: [T_RUN],
    expectRed: ['抛错 → unavailable', '采集覆盖时刻不可得', '注入的随机源越界', 'L1 编程错误'],
    mustKill: ['抛错 → unavailable'],
  },
  // ---- 读取层 ----
  {
    id: 'ledger_invalid_ignored',
    clause: 'fail-closed:坏账不退化成空账',
    edits: [drop(READ, "if (r.kind === 'invalid') throw new ReadError('ledger_invalid');")],
    tests: [T_READ],
    expectRed: ['账不存在 = []'],
    mustKill: ['账不存在 = []'],
  },
  {
    id: 'bad_session_row_skipped',
    clause: 'fail-closed:会话计数行任一行不合规整体失败',
    edits: [
      swap(
        READ,
        'SessionStatSchema.safeParse(value);\n          if (!p.success) return false;',
        'SessionStatSchema.safeParse(value);\n          if (!p.success) return true;',
      ),
    ],
    tests: [T_READ],
    expectRed: ['任一行不合 schema → 整体失败', 'H1 坏行出现在被读取的月份里'],
    mustKill: ['任一行不合 schema → 整体失败'],
  },
  {
    id: 'bad_signal_row_skipped',
    clause: 'fail-closed:信号任一行不合规整体失败(不静默少计)',
    edits: [
      swap(
        READ,
        'SignalSchema.safeParse(value);\n          if (!p.success) return false;',
        'SignalSchema.safeParse(value);\n          if (!p.success) return true;',
      ),
    ],
    tests: [T_READ],
    expectRed: ['任一行不合 schema → 整体失败', 'H1 坏行出现在被读取的月份里'],
    mustKill: ['任一行不合 schema → 整体失败'],
  },
  {
    id: 'since_not_applied',
    clause: '只取 ts ≥ since 的计数行',
    edits: [
      swap(
        READ,
        'if (Date.parse(p.data.ts) >= sinceMs) out.push({ agent, stat: p.data });',
        'out.push({ agent, stat: p.data });',
      ),
    ],
    tests: [T_READ],
    expectRed: ['只取 ts ≥ since 的行', 'H1 跨月'],
    mustKill: ['只取 ts ≥ since 的行'],
  },
  {
    id: 'c4_bytes_body_only',
    clause: 'R21-7.4 C4:字节数 = 整个 treat 输出(标记行 + 标签行 + 哈希行 + 正文),不是只有正文',
    edits: [
      swap(
        READ,
        "Buffer.byteLength(treatText(`rsm_${'0'.repeat(16)}`, doc), 'utf8')",
        "Buffer.byteLength(doc.body, 'utf8')",
      ),
    ],
    tests: [T_READ],
    expectRed: ['C4 字节数口径'],
    mustKill: ['C4 字节数口径'],
  },
  // ---- 验收退回项:H1 / M1 / M2 / L1–L4 ----
  {
    id: 'itt_ineligible_in_c6',
    clause: 'R21-6.7 ITT / L2:已关联且资格不成立的账行不进 C6 分母',
    edits: [swap(AN, 'l.judgeable && l.eligible !== false', 'l.judgeable')],
    tests: [T_AN],
    expectRed: [T_ITT],
    mustKill: [T_ITT],
  },
  {
    id: 'elig_null_dropped',
    clause: 'L2:项目不在采集中的已关联账行资格不可知(null),不能记成不成立',
    edits: [swap(ASM, 'eligibleOf.set(m, null);', 'eligibleOf.set(m, false);')],
    tests: [T_ASM],
    expectRed: ['已关联且资格不成立 → eligible=false'],
    mustKill: ['已关联且资格不成立 → eligible=false'],
  },
  {
    id: 'elig_unlinked_false',
    clause: 'L2:未关联账行的资格不可知(null),保留在分母里',
    edits: [
      swap(
        ASM,
        'eligible: eligibleOf.get(marker) ?? null,',
        'eligible: eligibleOf.get(marker) ?? false,',
      ),
    ],
    tests: [T_ASM],
    expectRed: ['已关联且资格不成立 → eligible=false'],
    mustKill: ['已关联且资格不成立 → eligible=false'],
  },
  {
    id: 'worst_no_impute',
    clause: 'M1 R21-6.7:最坏情况敏感性要把 control 的关联失败记为完整',
    edits: [swap(AN, "v: l.complete ? 1 : l.arm === 'control' ? 1 : 0,", 'v: l.complete ? 1 : 0,')],
    tests: [T_AN],
    expectRed: [T_WORST],
    mustKill: [T_WORST],
  },
  {
    id: 'worst_treat_good',
    clause: 'M1 R21-6.7:最坏情况敏感性里 treat 的关联失败记为不完整(不能记完整)',
    edits: [swap(AN, "l.arm === 'control' ? 1 : 0,", '1,')],
    tests: [T_AN],
    expectRed: [T_WORST],
    mustKill: [T_WORST],
  },
  {
    id: 'beyond_through_kept',
    clause: 'M2 R21-1.7:开始时刻晚于采集覆盖时刻的会话不是有观测会话',
    edits: [swap(ASM, 'if (tsMs > throughMs) {', 'if (false) {')],
    tests: [T_ASM],
    expectRed: ['M2 开始时刻晚于采集覆盖时刻'],
    mustKill: ['M2 开始时刻晚于采集覆盖时刻'],
  },
  {
    id: 'beyond_through_ge',
    clause: 'M2:边界恰等于采集覆盖时刻仍算(≤)',
    edits: [swap(ASM, 'if (tsMs > throughMs) {', 'if (tsMs >= throughMs) {')],
    tests: [T_ASM],
    expectRed: ['M2 边界'],
    mustKill: ['M2 边界'],
  },
  {
    id: 'prog_error_swallowed',
    clause: 'L1:编程错误不能吞成 unavailable',
    edits: [
      drop(
        RUN,
        'if (e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError) throw e;',
      ),
    ],
    tests: [T_RUN],
    expectRed: ['L1 编程错误'],
    mustKill: ['L1 编程错误'],
  },
  {
    id: 'config_honored',
    clause: 'L4 R21-7.1:契约常量不可配置,runAnalysis 不接受 config',
    edits: [
      swap(
        RUN,
        'config: DEFAULT_ANALYSIS_CONFIG,',
        'config: (req as unknown as { config?: typeof DEFAULT_ANALYSIS_CONFIG }).config ?? DEFAULT_ANALYSIS_CONFIG,',
      ),
    ],
    tests: [T_RUN],
    expectRed: ['L4 传入削弱的 config'],
    mustKill: ['L4 传入削弱的 config'],
  },
  {
    id: 'lookback_short',
    clause: 'L3:读取下限要覆盖开始得比窗口早的会话(≥ 60 天)',
    edits: [swap(RUN, 'READ_LOOKBACK_DAYS * DAY_MS', '31 * DAY_MS')],
    tests: [T_RUN],
    expectRed: ['L3 resume', 'W6b 会话 / 信号读取下限取整到 UTC 日零点'],
    mustKill: ['L3 resume'],
  },
  {
    id: 'signals_share_session_floor',
    clause: 'L3 / 复评 M-①:信号下限比会话下限再早一个资格窗口(变异:信号与会话共用下限)',
    edits: [
      swap(
        RUN,
        'const signals = await source.signals(signalsSinceIso);',
        'const signals = await source.signals(sinceIso);',
      ),
    ],
    tests: [T_RUN],
    expectRed: ['L3 信号下限再多一个资格窗口', 'W6b 会话 / 信号读取下限取整到 UTC 日零点'],
    mustKill: ['L3 信号下限再多一个资格窗口'],
  },
  {
    id: 'lookback_const_short',
    clause: 'L3:读取下限常量 = 2 × 30 + 1 天',
    edits: [swap(TYPES, '2 * ELIGIBILITY_DAYS + 1', 'ELIGIBILITY_DAYS + 1')],
    tests: [T_RUN],
    expectRed: ['L3 resume', 'W6b 会话 / 信号读取下限取整到 UTC 日零点'],
    mustKill: ['L3 resume'],
  },
  {
    id: 'hit_ts_window_start',
    clause: 'W6b R21-6.7:命中按命中信号自己的 ts 归时(变异:命中记在窗口起点)',
    edits: [swap(RUN, 'const tsMs = Date.parse(h.ts);', 'const tsMs = startMs;')],
    tests: [T_RUN],
    expectRed: [
      'W6b A 09:00 开始',
      'W6b 命中信号早于「待判会话 UTC 日 − 30」',
      'W6b 命中信号在资格窗口内',
    ],
    mustKill: ['W6b A 09:00 开始'],
  },
  {
    id: 'hits_need_stat_row',
    clause: 'W6b R21-6.7:命中直接从信号生成,不依赖会话计数行的读取窗口(变异:只认有计数行的会话)',
    edits: [
      swap(
        RUN,
        'for (const list of bySession.values()) {',
        'for (const list of [...bySession.values()].filter((l) => stats.some((x) => x.stat.session_ref === l[0]?.session_ref))) {',
      ),
    ],
    tests: [T_RUN],
    expectRed: ['W6b 命中信号在资格窗口内', 'W6b 命中信号早于「待判会话 UTC 日 − 30」'],
    mustKill: ['W6b 命中信号在资格窗口内'],
  },
  {
    id: 'floor_not_rounded',
    clause: 'W6b R21-6.7:读取下限取整到 UTC 日零点(变异:不取整)',
    edits: [
      swap(
        RUN,
        'const floorMs = Math.floor(startMs / DAY_MS) * DAY_MS;',
        'const floorMs = startMs;',
      ),
    ],
    tests: [T_RUN],
    expectRed: ['W6b 会话 / 信号读取下限取整到 UTC 日零点'],
    mustKill: ['W6b 会话 / 信号读取下限取整到 UTC 日零点'],
  },
  {
    id: 'hit_signal_is_failure',
    clause: 'W6b R21-6.7:tool 签名的命中信号是重试调用(变异:取失败信号)',
    edits: [swap(MEAS, '.map((p) => p.retry);', '.map((p) => p.failure);')],
    tests: [T_MEAS],
    expectRed: ['W6b tool 签名的命中信号'],
    mustKill: ['W6b tool 签名的命中信号'],
  },
  {
    id: 'event_c4_metric',
    clause: 'H1:c4 的 harm 事件带 metric:c4(过转移引擎 schema)',
    edits: [swap(EVT, 'metric: h.metric, worse: true', "metric: 'c1', worse: true")],
    tests: [T_RUN],
    expectRed: ['C4 越限 → harm_c4'],
    mustKill: ['C4 越限 → harm_c4'],
  },
  {
    id: 'month_cutoff_stats',
    clause: 'H1:计数行按月份文件裁剪(只读 since 所在月及之后)',
    edits: [
      swap(
        READ,
        'if (monthOf(file) < sinceMonth) continue;\n        const agent = agentOf(file);',
        'if (monthOf(file) > sinceMonth) continue;\n        const agent = agentOf(file);',
      ),
    ],
    tests: [T_READ],
    expectRed: ['H1 跨月'],
    mustKill: ['H1 跨月'],
  },
  {
    id: 'month_cutoff_signals',
    clause: 'H1:信号按月份文件裁剪',
    edits: [
      swap(
        READ,
        'if (monthOf(file) < sinceMonth) continue;\n        agentOf(file);',
        'if (monthOf(file) > sinceMonth) continue;\n        agentOf(file);',
      ),
    ],
    tests: [T_READ],
    expectRed: ['H1 跨月'],
    mustKill: ['H1 跨月'],
  },
  {
    id: 'month_prune_off',
    clause: 'H1:月份键与文件名同形(yyyymm,无连字符),更早月份的文件不读',
    edits: [swap(READ, '`${iso.slice(0, 4)}${iso.slice(5, 7)}`', '`${iso.slice(0, 7)}`')],
    tests: [T_READ],
    expectRed: ['H1 跨月'],
    mustKill: ['H1 跨月'],
  },
];

/**
 * 执行后由主代理回填:每条变异恰有一条结果,按表序。
 * W6b 修复改了资格命中的构造与读取下限,并新增 4 条变异、增补 5 条既有变异的杀手 / expectRed,旧结果(r21w6-mut3 @ seal,2c06761,80/80,基于 W6 原实现)作废,
 * 整张表须在 W6b 最终提交上重跑后回填(未回填前保持空,自检在空时放行)。
 */
export const V1_W6_RESULTS: readonly V1W6Result[] = [];
