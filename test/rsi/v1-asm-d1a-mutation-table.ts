/**
 * §21 V1 装配块 D1a(指纹 / 近似指纹 / 能力判定 / FactsProvider 纯计算与组合 / 语料工具)必杀变异。
 * 执行方式同 W5 – W8 / B1a:验证机私有检出里 cp 备份 → 按锚点替换(每个锚点在对应文件里**恰好出现一次**)→ 跑 `tests` → 失败集合非空、全部命中 `expectRed`、
 * `mustKill` 每项至少命中一个、没有 skipped → cp 还原并逐文件 sha256 核对。**不用 git checkout / stash 还原**。
 * 本文件只写表与每条变异期望红的测试名(`expectRed` 是杀手测试名里的字面子串);变异由主代理整表执行,结果记进 `V1_ASM_D1A_RESULTS`(本块不执行变异,故留空)。
 * 契约套件(`fp-key-contract.ts` / `facts-contract.ts`)的用例经 `fp-key.test.ts` / `facts-provider.test.ts` 的套件名(字面量)命中。
 * `expectRed` 在具体用例之后追加该测试文件的 describe 前缀字面量作兜底(同一模块内多处联动红,离线逐条推演不可靠;`mustKill` 只列具体用例,保证目标用例必红)。
 * 不在本表的点(如实记录):⓪`facts-provider.ts` 的 `gateFacts` 里 `draft.id !== rec.id || draft.contentSha256 !== rec.content_sha256` 复核:验收评审修复后 `source()` 已先用 `stagedMatchesRecord` 与记录的 id / content_sha256 绑定,这一行成为纵深防御、行为不可单独观察(原变异 `facts_draft_record_mismatch_ok` 已移除,等价);①`facts-provider.ts` 里 `head === null` 的检查(去掉后 `head.sha256` 抛 TypeError,被读失败映射吞成 `null`,行为等价);
 * ②`fp-key.ts` 里 `read()` 返回 `Uint8Array.from` 副本(每次读都是新 Buffer,别名不可观察;假件的副本语义由契约套件单独钉);
 * ③`inert.test.ts` 的闭包检查是静态扫描,正向对照(虚拟入口)代替变异。变异 id 用短的下划线词。
 */
export interface Edit {
  file: string;
  anchor: string;
  replacement: string;
}

export interface V1AsmD1aMutation {
  id: string;
  /** 契约条款 / 该不变量 */
  clause: string;
  edits: readonly Edit[];
  /** 相对 `test/` */
  tests: readonly string[];
  expectRed: readonly string[];
  mustKill: readonly string[];
}

export interface V1AsmD1aResult {
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

export const V1_ASM_D1A_MUTATIONS: readonly V1AsmD1aMutation[] = [
  {
    id: 'near_shingle_two',
    clause: 'W0-28 near_fp 草案 3-token shingle',
    edits: [
      swap(
        'src/rsi/personal/fp/near-algo.ts',
        'export const NEAR_SHINGLE_TOKENS = 3;',
        'export const NEAR_SHINGLE_TOKENS = 2;',
      ),
    ],
    tests: ['rsi/d1a/near-algo.test.ts'],
    expectRed: ['3-token shingle:token 少于 3 → 空', 'near_fp:'],
    mustKill: ['3-token shingle:token 少于 3 → 空'],
  },
  {
    id: 'near_sketch_32',
    clause: 'W0-28 near_fp 草案 草图取最小 64 个',
    edits: [
      swap(
        'src/rsi/personal/fp/near-algo.ts',
        'export const NEAR_SKETCH_SIZE = 64;',
        'export const NEAR_SKETCH_SIZE = 32;',
      ),
    ],
    tests: ['rsi/d1a/near-algo.test.ts'],
    expectRed: ['超过 64 个 shingle:取最小 64 个', 'near_fp:'],
    mustKill: ['超过 64 个 shingle:取最小 64 个'],
  },
  {
    id: 'near_sketch_descending',
    clause: 'W0-28 near_fp 草案 草图升序最小',
    edits: [
      swap(
        'src/rsi/personal/fp/near-algo.ts',
        '.sort().slice(0, NEAR_SKETCH_SIZE)',
        '.sort().reverse().slice(0, NEAR_SKETCH_SIZE)',
      ),
    ],
    tests: ['rsi/d1a/near-algo.test.ts'],
    expectRed: ['整组 near_fp 黄金值:英文', '超过 64 个 shingle:取最小 64 个', 'near_fp:'],
    mustKill: ['整组 near_fp 黄金值:英文'],
  },
  {
    id: 'near_domain_prefix_changed',
    clause: 'W0-28 near_fp 草案 哈希域前缀 rsi-near-v1',
    edits: [
      swap(
        'src/rsi/personal/fp/near-algo.ts',
        'const NEAR_DOMAIN = `${NEAR_VERSION}',
        'const NEAR_DOMAIN = `x${NEAR_VERSION}',
      ),
    ],
    tests: ['rsi/d1a/near-algo.test.ts'],
    expectRed: ['单个 shingle 的 8 位哈希', 'near_fp:'],
    mustKill: ['单个 shingle 的 8 位哈希'],
  },
  {
    id: 'near_nfkc_dropped',
    clause: 'W0-28 near_fp 草案 NFKC 规范化',
    edits: [
      swap(
        'src/rsi/personal/fp/near-algo.ts',
        "for (const ch of text.normalize('NFKC').toLowerCase()) {",
        'for (const ch of text.toLowerCase()) {',
      ),
    ],
    tests: ['rsi/d1a/near-algo.test.ts'],
    expectRed: ['NFKC:全宽字母与全宽空格归一', 'near_fp:'],
    mustKill: ['NFKC:全宽字母与全宽空格归一'],
  },
  {
    id: 'near_lowercase_dropped',
    clause: 'W0-28 near_fp 草案 小写',
    edits: [
      swap(
        'src/rsi/personal/fp/near-algo.ts',
        "normalize('NFKC').toLowerCase()) {",
        "normalize('NFKC').toString()) {",
      ),
    ],
    tests: ['rsi/d1a/near-algo.test.ts'],
    expectRed: ['ASCII:小写、标点与下划线是分隔符、数字成词', 'near_fp:'],
    mustKill: ['ASCII:小写、标点与下划线是分隔符、数字成词'],
  },
  {
    id: 'near_cjk_split_disabled',
    clause: 'W0-28 near_fp 草案 CJK 每字一个 token',
    edits: [swap('src/rsi/personal/fp/near-algo.ts', 'if (isCjk(cp)) {', 'if (false) {')],
    tests: ['rsi/d1a/near-algo.test.ts'],
    expectRed: ['CJK:表意文字每字一个 token', 'near_fp:'],
    mustKill: ['CJK:表意文字每字一个 token'],
  },
  {
    id: 'near_underscore_is_word',
    clause: 'W0-28 near_fp 草案 下划线是分隔符',
    edits: [
      swap(
        'src/rsi/personal/fp/near-algo.ts',
        'const WORD_CHAR = /^[\\p{L}\\p{N}]$/u;',
        'const WORD_CHAR = /^[\\p{L}\\p{N}_]$/u;',
      ),
    ],
    tests: ['rsi/d1a/near-algo.test.ts'],
    expectRed: ['ASCII:小写、标点与下划线是分隔符、数字成词', 'near_fp:'],
    mustKill: ['ASCII:小写、标点与下划线是分隔符、数字成词'],
  },
  {
    id: 'near_input_cap_removed',
    clause: 'W0-28 near_fp 草案 输入上限',
    edits: [
      swap(
        'src/rsi/personal/fp/near-algo.ts',
        "if (text.length > NEAR_MAX_INPUT_CHARS) throw new NearFpInputError('too_long');",
        '',
      ),
    ],
    tests: ['rsi/d1a/near-algo.test.ts'],
    expectRed: ['输入超过上限', 'near_fp:'],
    mustKill: ['输入超过上限'],
  },
  {
    id: 'near_key_length_unchecked',
    clause: 'W0-28 near_fp 草案 密钥 32 字节',
    edits: [
      swap(
        'src/rsi/personal/fp/near-algo.ts',
        '|| key.length !== KEY_BYTES) throw new NearFpKeyError();',
        ') throw new NearFpKeyError();',
      ),
    ],
    tests: ['rsi/d1a/near-algo.test.ts'],
    expectRed: ['长度不是 32 / 不是 Uint8Array → NearFpKeyError', 'near_fp:'],
    mustKill: ['长度不是 32 / 不是 Uint8Array → NearFpKeyError'],
  },
  {
    id: 'near_key_not_copied',
    clause: 'W0-28 near_fp 草案 构造时复制密钥',
    edits: [
      swap('src/rsi/personal/fp/near-algo.ts', 'return Uint8Array.from(key);', 'return key;'),
    ],
    tests: ['rsi/d1a/near-algo.test.ts'],
    expectRed: ['构造时复制密钥', 'near_fp:'],
    mustKill: ['构造时复制密钥'],
  },
  {
    id: 'near_hash_three_bytes',
    clause: 'W0-28 near_fp 草案 取前 4 字节',
    edits: [swap('src/rsi/personal/fp/near-algo.ts', '.subarray(0, 4)', '.subarray(0, 3)')],
    tests: ['rsi/d1a/near-algo.test.ts'],
    expectRed: ['单个 shingle 的 8 位哈希', 'near_fp:'],
    mustKill: ['单个 shingle 的 8 位哈希'],
  },
  {
    id: 'near_shingle_not_deduped',
    clause: 'W0-28 near_fp 草案 shingle 去重',
    edits: [
      swap(
        'src/rsi/personal/fp/near-algo.ts',
        'seen.add(t.slice(i, i + NEAR_SHINGLE_TOKENS).join(SHINGLE_JOIN));',
        'seen.add(t.slice(i, i + NEAR_SHINGLE_TOKENS).join(SHINGLE_JOIN) + i);',
      ),
    ],
    tests: ['rsi/d1a/near-algo.test.ts'],
    expectRed: ['3-token shingle:token 少于 3 → 空', 'near_fp:'],
    mustKill: ['3-token shingle:token 少于 3 → 空'],
  },
  {
    id: 'near_join_space',
    clause: 'W0-28 near_fp 草案 shingle 连接符 U+001F',
    edits: [
      swap(
        'src/rsi/personal/fp/near-algo.ts',
        "const SHINGLE_JOIN = '\\u001f';",
        "const SHINGLE_JOIN = ' ';",
      ),
    ],
    // 「单个 shingle 的 8 位哈希」直接给已拼好的串、不经连接符,实跑不红(r21d1a-mut2);钉住连接符的是整组草图的黄金值
    tests: ['rsi/d1a/near-algo.test.ts'],
    expectRed: ['整组 near_fp 黄金值:英文 11 个 shingle', 'near_fp:'],
    mustKill: ['整组 near_fp 黄金值:英文 11 个 shingle'],
  },
  {
    id: 'near_coverage_over_candidate',
    clause: 'W0-28 near_fp 草案 覆盖率分母 = |near_fp|',
    edits: [
      swap(
        'src/rsi/personal/fp/near-algo.ts',
        'return hit / near.length;',
        'return hit / Math.max(cand.size, 1);',
      ),
    ],
    tests: ['rsi/d1a/near-algo.test.ts'],
    expectRed: ['扩写:覆盖率 1;前缀:6/11;改写:0', 'near_fp:'],
    mustKill: ['扩写:覆盖率 1;前缀:6/11;改写:0'],
  },
  {
    id: 'near_empty_matches_all',
    clause: 'W0-28 near_fp 草案 near=[] 只精确',
    edits: [
      swap(
        'src/rsi/personal/fp/near-algo.ts',
        'return c !== null && c >= threshold;',
        'return c === null || c >= threshold;',
      ),
    ],
    tests: ['rsi/d1a/near-algo.test.ts'],
    expectRed: ['near = [] 只能精确匹配', 'near_fp:'],
    mustKill: ['near = [] 只能精确匹配'],
  },
  {
    id: 'near_threshold_strict_gt',
    clause: 'W0-28 near_fp 草案 coverage ≥ 阈值',
    edits: [
      swap(
        'src/rsi/personal/fp/near-algo.ts',
        'return c !== null && c >= threshold;',
        'return c !== null && c > threshold;',
      ),
    ],
    tests: ['rsi/d1a/near-algo.test.ts'],
    expectRed: ['阈值显式:前缀在 0.5 命中', 'near_fp:'],
    mustKill: ['阈值显式:前缀在 0.5 命中'],
  },
  {
    id: 'near_threshold_unchecked',
    clause: 'W0-28 near_fp 草案 阈值 (0,1]',
    edits: [
      swap(
        'src/rsi/personal/fp/near-algo.ts',
        "if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0 || t > 1) {",
        'if (false) {',
      ),
    ],
    tests: ['rsi/d1a/near-algo.test.ts'],
    expectRed: ['阈值必须是 (0, 1] 内的有限数', 'near_fp:'],
    mustKill: ['阈值必须是 (0, 1] 内的有限数'],
  },
  {
    id: 'cap_frozen_truthy',
    clause: 'W0-28 near_fp 草案 frozen 严格 === true',
    edits: [
      swap(
        'src/rsi/personal/fp/near-capability.ts',
        'if (i.algo.frozen !== true)',
        'if (!i.algo.frozen)',
      ),
    ],
    tests: ['rsi/d1a/near-capability.test.ts'],
    expectRed: [
      'algo_unfrozen:frozen 必须严格 === true',
      'NearFpCapability(',
      '能力判定的操作级快照',
    ],
    mustKill: ['algo_unfrozen:frozen 必须严格 === true'],
  },
  {
    id: 'cap_producer_not_required',
    clause: 'W0-28 near_fp 草案 能力 unwired',
    edits: [
      swap(
        'src/rsi/personal/fp/near-capability.ts',
        'if (!hasProducer(i.producer)) return',
        'if (false) return',
      ),
    ],
    tests: ['rsi/d1a/near-capability.test.ts'],
    expectRed: ['unwired:没有 producer 引用', 'NearFpCapability(', '能力判定的操作级快照'],
    mustKill: ['unwired:没有 producer 引用'],
  },
  {
    id: 'cap_key_state_ignored',
    clause: 'W0-28 near_fp 草案 能力 key_unavailable',
    edits: [
      swap('src/rsi/personal/fp/near-capability.ts', "if (i.key !== 'ok') {", 'if (false) {'),
    ],
    tests: ['rsi/d1a/near-capability.test.ts'],
    expectRed: [
      'key_unavailable:缺 / 无效 / 读失败,各有原因码',
      'NearFpCapability(',
      '能力判定的操作级快照',
    ],
    mustKill: ['key_unavailable:缺 / 无效 / 读失败,各有原因码'],
  },
  {
    id: 'cap_version_unchecked',
    clause: 'W0-28 near_fp 草案 冻结位为真仍须算法参数合法',
    edits: [swap('src/rsi/personal/fp/near-capability.ts', "typeof v !== 'string' ||", 'false ||')],
    tests: ['rsi/d1a/near-capability.test.ts'],
    expectRed: ['冻结位为真但阈值 / 版本串不合法', 'NearFpCapability(', '能力判定的操作级快照'],
    mustKill: ['冻结位为真但阈值 / 版本串不合法'],
  },
  {
    id: 'cap_read_error_is_ok',
    clause: 'W0-28 near_fp 草案 key 读抛错 → key_read_failed',
    edits: [swap('src/rsi/personal/fp/near-capability.ts', "key = 'read_failed';", "key = 'ok';")],
    tests: ['rsi/d1a/near-capability.test.ts'],
    expectRed: [
      'near_capability_key_unavailable_denied',
      'NearFpCapability(',
      '能力判定的操作级快照',
    ],
    mustKill: ['near_capability_key_unavailable_denied'],
  },
  {
    id: 'fpkey_assert_held_first_dropped',
    clause: 'R21-11.2 fp.key 首建持锁',
    edits: [
      swap(
        'src/rsi/personal/fp/fp-key.ts',
        '    await held.rsi.assertHeld();\n    const dir = await rsiDir(d.io);',
        '    const dir = await rsiDir(d.io);',
      ),
    ],
    tests: ['rsi/d1a/fp-key.test.ts'],
    expectRed: [
      '失锁时 ensure 不建目录',
      '真实现(文件系统)',
      'FpKeyPort 真实现:文件与目录',
      'FpKeyPort 真实现:持久化确认',
    ],
    mustKill: ['失锁时 ensure 不建目录'],
  },
  {
    id: 'fpkey_invalid_treated_exists',
    clause: 'W0-28 fp.key 无效不覆盖重建',
    edits: [
      swap(
        'src/rsi/personal/fp/fp-key.ts',
        "if (cur.kind === 'invalid') throw new FpKeyInvalidError();",
        "if (cur.kind === 'invalid') return 'exists';",
      ),
    ],
    tests: ['rsi/d1a/fp-key.test.ts'],
    expectRed: [
      '权限宽于 0600 → invalid(不修复、不覆盖)',
      '真实现(文件系统)',
      'FpKeyPort 真实现:文件与目录',
      'FpKeyPort 真实现:持久化确认',
    ],
    mustKill: ['权限宽于 0600 → invalid(不修复、不覆盖)'],
  },
  {
    id: 'fpkey_length_unchecked',
    clause: 'R21-11.2 fp.key 32 字节',
    edits: [
      swap(
        'src/rsi/personal/fp/fp-key.ts',
        "if (r.bytes.length !== FP_KEY_BYTES) return { kind: 'invalid' };",
        '',
      ),
    ],
    tests: ['rsi/d1a/fp-key.test.ts'],
    expectRed: [
      '过长文件(> 32 字节)与空文件 → invalid',
      '真实现(文件系统)',
      'FpKeyPort 真实现:文件与目录',
      'FpKeyPort 真实现:持久化确认',
    ],
    mustKill: ['过长文件(> 32 字节)与空文件 → invalid'],
  },
  {
    id: 'fpkey_owner_policy_dropped',
    clause: 'R21-11.2 fp.key 0600',
    edits: [swap('src/rsi/personal/fp/fp-key.ts', '      owner: RSI_FILE_OWNER,\n', '')],
    tests: ['rsi/d1a/fp-key.test.ts'],
    expectRed: [
      '权限宽于 0600 → invalid(不修复、不覆盖)',
      '真实现(文件系统)',
      'FpKeyPort 真实现:文件与目录',
      'FpKeyPort 真实现:持久化确认',
    ],
    mustKill: ['权限宽于 0600 → invalid(不修复、不覆盖)'],
  },
  {
    id: 'fpkey_eexist_fatal',
    clause: 'R21-11.2 createExclusive 竞态',
    edits: [
      swap(
        'src/rsi/personal/fp/fp-key.ts',
        "if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;",
        'throw e;',
      ),
    ],
    tests: ['rsi/d1a/fp-key.test.ts'],
    expectRed: [
      '并发首建:read 之后、createExclusive 之前别人写了有效 key',
      '真实现(文件系统)',
      'FpKeyPort 真实现:文件与目录',
      'FpKeyPort 真实现:持久化确认',
    ],
    mustKill: ['并发首建:read 之后、createExclusive 之前别人写了有效 key'],
  },
  {
    id: 'fpkey_mode_0644',
    clause: 'R21-11.2 fp.key 0600',
    edits: [
      swap(
        'src/rsi/personal/fp/fp-key.ts',
        'createExclusiveSynced(d.io, path.join(dir, FP_KEY_FILE), key, RSI_FILE_MODE);',
        'createExclusiveSynced(d.io, path.join(dir, FP_KEY_FILE), key, 0o644);',
      ),
    ],
    tests: ['rsi/d1a/fp-key.test.ts'],
    expectRed: [
      '首建后 fp.key 为 0600、32 字节普通文件',
      '真实现(文件系统)',
      'FpKeyPort 真实现:文件与目录',
      'FpKeyPort 真实现:持久化确认',
    ],
    mustKill: ['首建后 fp.key 为 0600、32 字节普通文件'],
  },
  {
    id: 'fpkey_random_length_unchecked',
    clause: 'R21-11.2 fp.key 32 字节',
    edits: [
      swap(
        'src/rsi/personal/fp/fp-key.ts',
        'if (key.length !== FP_KEY_BYTES) throw new FpKeyInvalidError();',
        '',
      ),
    ],
    tests: ['rsi/d1a/fp-key.test.ts'],
    expectRed: [
      'randomKey 给出长度不对的 key',
      '真实现(文件系统)',
      'FpKeyPort 真实现:文件与目录',
      'FpKeyPort 真实现:持久化确认',
    ],
    mustKill: ['randomKey 给出长度不对的 key'],
  },
  {
    id: 'exactfp_slice_8',
    clause: 'R21-11.2 fp_hmac 前 16 位',
    edits: [swap('src/rsi/personal/fp/exact-fp.ts', '.slice(0, 16)', '.slice(0, 8)')],
    tests: ['rsi/d1a/exact-fp.test.ts'],
    expectRed: ['黄金值:空串 / ASCII / 中文正文', '精确指纹 fp_hmac'],
    mustKill: ['黄金值:空串 / ASCII / 中文正文'],
  },
  {
    id: 'exactfp_key_length_unchecked',
    clause: 'R21-11.2 密钥 32 字节',
    edits: [swap('src/rsi/personal/fp/exact-fp.ts', '|| key.length !== 32)', '|| false)')],
    tests: ['rsi/d1a/exact-fp.test.ts'],
    expectRed: ['密钥长度不是 32', '精确指纹 fp_hmac'],
    mustKill: ['密钥长度不是 32'],
  },
  {
    id: 'exactfp_key_not_copied',
    clause: 'R21-11.2 构造时复制密钥',
    edits: [
      swap('src/rsi/personal/fp/exact-fp.ts', 'const k = Uint8Array.from(key);', 'const k = key;'),
    ],
    tests: ['rsi/d1a/exact-fp.test.ts'],
    expectRed: ['构造时复制密钥', '精确指纹 fp_hmac'],
    mustKill: ['构造时复制密钥'],
  },
  {
    id: 'facts_taint_run_ignored',
    clause: 'FactsProvider tainted:来源 run 标记',
    edits: [
      swap(
        'src/rsi/personal/facts/facts-pure.ts',
        'return i.runTainted || i.anyEvidenceExcluded || i.purgeJournalPresent;',
        'return i.anyEvidenceExcluded || i.purgeJournalPresent;',
      ),
    ],
    tests: ['rsi/d1a/facts-provider.test.ts'],
    expectRed: [
      '来源 run 带 TAINTED 标记 → tainted',
      '真组合层(makeFactsProvider over 内存读端口)',
      'promoteFacts:',
      'tainted / evidence_valid',
      '墓碑 / 冷却 / 黑名单',
      '近似指纹:显式装配才匹配',
      'gateFacts 的类别与透传',
      'gateFacts:注入的 fingerprint 依赖失败',
      '组合层的来源绑定',
    ],
    mustKill: ['来源 run 带 TAINTED 标记 → tainted'],
  },
  {
    id: 'facts_taint_purge_ignored',
    clause: 'FactsProvider tainted:purge journal 在场',
    edits: [
      swap(
        'src/rsi/personal/facts/facts-pure.ts',
        'return i.runTainted || i.anyEvidenceExcluded || i.purgeJournalPresent;',
        'return i.runTainted || i.anyEvidenceExcluded;',
      ),
    ],
    tests: ['rsi/d1a/facts-provider.test.ts'],
    expectRed: [
      'purge journal 在场 → tainted',
      '真组合层(makeFactsProvider over 内存读端口)',
      'promoteFacts:',
      'tainted / evidence_valid',
      '墓碑 / 冷却 / 黑名单',
      '近似指纹:显式装配才匹配',
      'gateFacts 的类别与透传',
      'gateFacts:注入的 fingerprint 依赖失败',
      '组合层的来源绑定',
    ],
    mustKill: ['purge journal 在场 → tainted'],
  },
  {
    id: 'facts_taint_excluded_ignored',
    clause: 'FactsProvider tainted:证据项目被排除',
    edits: [
      swap(
        'src/rsi/personal/facts/facts-pure.ts',
        'return i.runTainted || i.anyEvidenceExcluded || i.purgeJournalPresent;',
        'return i.runTainted || i.purgeJournalPresent;',
      ),
    ],
    tests: ['rsi/d1a/facts-provider.test.ts'],
    expectRed: [
      '证据项目被排除 → tainted 且 evidence_valid = false',
      '真组合层(makeFactsProvider over 内存读端口)',
      'promoteFacts:',
      'tainted / evidence_valid',
      '墓碑 / 冷却 / 黑名单',
      '近似指纹:显式装配才匹配',
      'gateFacts 的类别与透传',
      'gateFacts:注入的 fingerprint 依赖失败',
      '组合层的来源绑定',
    ],
    mustKill: ['证据项目被排除 → tainted 且 evidence_valid = false'],
  },
  {
    id: 'facts_excluded_flag_dropped',
    clause: 'FactsProvider 证据项目被排除',
    edits: [
      swap('src/rsi/personal/facts/facts-pure.ts', 'excluded: v.excluded,', 'excluded: false,'),
    ],
    tests: ['rsi/d1a/facts-provider.test.ts'],
    expectRed: [
      '证据项目被排除 → tainted 且 evidence_valid = false',
      '真组合层(makeFactsProvider over 内存读端口)',
      'promoteFacts:',
      'tainted / evidence_valid',
      '墓碑 / 冷却 / 黑名单',
      '近似指纹:显式装配才匹配',
      'gateFacts 的类别与透传',
      'gateFacts:注入的 fingerprint 依赖失败',
      '组合层的来源绑定',
    ],
    mustKill: ['证据项目被排除 → tainted 且 evidence_valid = false'],
  },
  {
    id: 'facts_lifted_still_hits',
    clause: 'FactsProvider blacklisted:lifted 不命中',
    edits: [
      swap(
        'src/rsi/personal/facts/facts-pure.ts',
        'if (item.lifted_gen !== undefined) continue;',
        '',
      ),
    ],
    tests: ['rsi/d1a/facts-provider.test.ts'],
    expectRed: [
      '已解除(lifted)的项不再命中',
      '真组合层(makeFactsProvider over 内存读端口)',
      'promoteFacts:',
      'tainted / evidence_valid',
      '墓碑 / 冷却 / 黑名单',
      '近似指纹:显式装配才匹配',
      'gateFacts 的类别与透传',
      'gateFacts:注入的 fingerprint 依赖失败',
      '组合层的来源绑定',
    ],
    mustKill: ['已解除(lifted)的项不再命中'],
  },
  {
    id: 'facts_blacklist_fp_ignored',
    clause: 'FactsProvider blacklisted:fp_hmac',
    edits: [
      swap('src/rsi/personal/facts/facts-pure.ts', 'item.fp_hmac === target.fp_hmac', 'false'),
    ],
    tests: ['rsi/d1a/facts-provider.test.ts'],
    expectRed: [
      '黑名单精确匹配',
      '真组合层(makeFactsProvider over 内存读端口)',
      'promoteFacts:',
      'tainted / evidence_valid',
      '墓碑 / 冷却 / 黑名单',
      '近似指纹:显式装配才匹配',
      'gateFacts 的类别与透传',
      'gateFacts:注入的 fingerprint 依赖失败',
      '组合层的来源绑定',
    ],
    mustKill: ['黑名单精确匹配'],
  },
  {
    id: 'facts_blacklist_sha_ignored',
    clause: 'FactsProvider blacklisted:content_sha256',
    edits: [
      swap(
        'src/rsi/personal/facts/facts-pure.ts',
        'item.content_sha256 === target.content_sha256 ||',
        'false ||',
      ),
    ],
    tests: ['rsi/d1a/facts-provider.test.ts'],
    expectRed: [
      '黑名单精确匹配',
      '真组合层(makeFactsProvider over 内存读端口)',
      'promoteFacts:',
      'tainted / evidence_valid',
      '墓碑 / 冷却 / 黑名单',
      '近似指纹:显式装配才匹配',
      'gateFacts 的类别与透传',
      'gateFacts:注入的 fingerprint 依赖失败',
      '组合层的来源绑定',
    ],
    mustKill: ['黑名单精确匹配'],
  },
  {
    id: 'facts_blacklist_id_ignored',
    clause: 'FactsProvider blacklisted:candidate_id',
    edits: [
      swap(
        'src/rsi/personal/facts/facts-pure.ts',
        'item.candidate_id === target.id ||',
        'false ||',
      ),
    ],
    tests: ['rsi/d1a/facts-provider.test.ts'],
    expectRed: [
      '黑名单精确匹配',
      '真组合层(makeFactsProvider over 内存读端口)',
      'promoteFacts:',
      'tainted / evidence_valid',
      '墓碑 / 冷却 / 黑名单',
      '近似指纹:显式装配才匹配',
      'gateFacts 的类别与透传',
      'gateFacts:注入的 fingerprint 依赖失败',
      '组合层的来源绑定',
    ],
    mustKill: ['黑名单精确匹配'],
  },
  {
    id: 'facts_cooldown_cluster_ignored',
    clause: 'FactsProvider cooldown:同聚类',
    edits: [swap('src/rsi/personal/facts/facts-pure.ts', 'c.cluster_id === clusterId && ', '')],
    tests: ['rsi/d1a/facts-provider.test.ts'],
    expectRed: [
      '冷却:同聚类且未到期',
      '真组合层(makeFactsProvider over 内存读端口)',
      'promoteFacts:',
      'tainted / evidence_valid',
      '墓碑 / 冷却 / 黑名单',
      '近似指纹:显式装配才匹配',
      'gateFacts 的类别与透传',
      'gateFacts:注入的 fingerprint 依赖失败',
      '组合层的来源绑定',
    ],
    mustKill: ['冷却:同聚类且未到期'],
  },
  {
    id: 'facts_cooldown_never_expires',
    clause: 'FactsProvider cooldown:到期用契约谓词',
    edits: [swap('src/rsi/personal/facts/facts-pure.ts', 'cooldownActive(c, today)', 'true')],
    tests: ['rsi/d1a/facts-provider.test.ts'],
    expectRed: [
      '冷却:同聚类且未到期',
      '真组合层(makeFactsProvider over 内存读端口)',
      'promoteFacts:',
      'tainted / evidence_valid',
      '墓碑 / 冷却 / 黑名单',
      '近似指纹:显式装配才匹配',
      'gateFacts 的类别与透传',
      'gateFacts:注入的 fingerprint 依赖失败',
      '组合层的来源绑定',
    ],
    mustKill: ['冷却:同聚类且未到期'],
  },
  {
    id: 'facts_tombstone_any',
    clause: 'FactsProvider tombstoned:本候选 id',
    edits: [
      swap(
        'src/rsi/personal/facts/facts-pure.ts',
        'ledger.tombstones.some((t) => t.id === id)',
        'ledger.tombstones.length > 0',
      ),
    ],
    tests: ['rsi/d1a/facts-provider.test.ts'],
    expectRed: [
      '墓碑:本候选 id',
      '真组合层(makeFactsProvider over 内存读端口)',
      'promoteFacts:',
      'tainted / evidence_valid',
      '墓碑 / 冷却 / 黑名单',
      '近似指纹:显式装配才匹配',
      'gateFacts 的类别与透传',
      'gateFacts:注入的 fingerprint 依赖失败',
      '组合层的来源绑定',
    ],
    mustKill: ['墓碑:本候选 id'],
  },
  {
    id: 'facts_excerpt_mismatch_valid',
    clause: 'FactsProvider evidence_valid:摘录逐字一致',
    edits: [swap('src/rsi/personal/facts/facts-pure.ts', 'e.excerpt === e.signal.excerpt', 'true')],
    tests: ['rsi/d1a/facts-provider.test.ts'],
    expectRed: [
      '摘录与信号库不一致 → evidence_valid = false',
      '真组合层(makeFactsProvider over 内存读端口)',
      'promoteFacts:',
      'tainted / evidence_valid',
      '墓碑 / 冷却 / 黑名单',
      '近似指纹:显式装配才匹配',
      'gateFacts 的类别与透传',
      'gateFacts:注入的 fingerprint 依赖失败',
      '组合层的来源绑定',
    ],
    mustKill: ['摘录与信号库不一致 → evidence_valid = false'],
  },
  {
    id: 'facts_unknown_attribution_valid',
    clause: 'FactsProvider evidence_valid:归属已知',
    edits: [
      swap('src/rsi/personal/facts/facts-pure.ts', "e.signal.attribution !== 'unknown' &&\n", ''),
    ],
    tests: ['rsi/d1a/facts-provider.test.ts'],
    expectRed: [
      '归属未知 → evidence_valid = false',
      '真组合层(makeFactsProvider over 内存读端口)',
      'promoteFacts:',
      'tainted / evidence_valid',
      '墓碑 / 冷却 / 黑名单',
      '近似指纹:显式装配才匹配',
      'gateFacts 的类别与透传',
      'gateFacts:注入的 fingerprint 依赖失败',
      '组合层的来源绑定',
    ],
    mustKill: ['归属未知 → evidence_valid = false'],
  },
  {
    id: 'facts_signature_from_partial_signals',
    clause: 'FactsProvider 签名:证据信号不全不凑',
    edits: [
      swap(
        'src/rsi/personal/facts/facts-pure.ts',
        'if (!proposal.evidence.every((e) => have.has(e.sig))) return null;',
        '',
      ),
    ],
    tests: ['rsi/d1a/facts-provider.test.ts'],
    expectRed: [
      'current_cluster_signature 由信号重新派生',
      '真组合层(makeFactsProvider over 内存读端口)',
      'promoteFacts:',
      'tainted / evidence_valid',
      '墓碑 / 冷却 / 黑名单',
      '近似指纹:显式装配才匹配',
      'gateFacts 的类别与透传',
      'gateFacts:注入的 fingerprint 依赖失败',
      '组合层的来源绑定',
    ],
    mustKill: ['current_cluster_signature 由信号重新派生'],
  },
  {
    id: 'facts_hold_budget_ok',
    clause: 'FactsProvider holdFacts 恒 unavailable',
    edits: [
      swap(
        'src/rsi/personal/facts/facts-pure.ts',
        "budget_high_legacy: 'unavailable',",
        "budget_high_legacy: 'ok',",
      ),
    ],
    tests: ['rsi/d1a/facts-provider.test.ts'],
    expectRed: [
      'legacy HoldFacts:返回值只表示',
      '真组合层(makeFactsProvider over 内存读端口)',
      'promoteFacts:',
      'tainted / evidence_valid',
      '墓碑 / 冷却 / 黑名单',
      '近似指纹:显式装配才匹配',
      'gateFacts 的类别与透传',
      'gateFacts:注入的 fingerprint 依赖失败',
      '组合层的来源绑定',
    ],
    mustKill: ['legacy HoldFacts:返回值只表示'],
  },
  {
    id: 'facts_lock_lost_swallowed',
    clause: 'FactsProvider 锁丢失原样传播',
    edits: [
      swap(
        'src/rsi/personal/facts/facts-provider.ts',
        'if (e instanceof RsiLockError) throw e;',
        '',
      ),
    ],
    tests: ['rsi/d1a/facts-provider.test.ts'],
    expectRed: [
      '真组合层(makeFactsProvider over 内存读端口)',
      '真组合层(makeFactsProvider over 内存读端口)',
      'promoteFacts:',
      'tainted / evidence_valid',
      '墓碑 / 冷却 / 黑名单',
      '近似指纹:显式装配才匹配',
      'gateFacts 的类别与透传',
      'gateFacts:注入的 fingerprint 依赖失败',
      '组合层的来源绑定',
    ],
    mustKill: ['真组合层(makeFactsProvider over 内存读端口)'],
  },
  {
    id: 'facts_read_error_propagates',
    clause: 'FactsProvider 读失败 → null',
    edits: [
      swap(
        'src/rsi/personal/facts/facts-provider.ts',
        'if (e instanceof RsiLockError) throw e;',
        'throw e;',
      ),
    ],
    tests: ['rsi/d1a/facts-provider.test.ts'],
    expectRed: [
      '真组合层(makeFactsProvider over 内存读端口)',
      '真组合层(makeFactsProvider over 内存读端口)',
      'promoteFacts:',
      'tainted / evidence_valid',
      '墓碑 / 冷却 / 黑名单',
      '近似指纹:显式装配才匹配',
      'gateFacts 的类别与透传',
      'gateFacts:注入的 fingerprint 依赖失败',
      '组合层的来源绑定',
    ],
    mustKill: ['真组合层(makeFactsProvider over 内存读端口)'],
  },
  {
    id: 'facts_sessions_nonzero',
    clause: 'FactsProvider sessions / hits 恒 0',
    edits: [swap('src/rsi/personal/facts/facts-provider.ts', 'sessions: 0,', 'sessions: 25,')],
    tests: ['rsi/d1a/facts-provider.test.ts'],
    expectRed: [
      '真组合层(makeFactsProvider over 内存读端口)',
      '真组合层(makeFactsProvider over 内存读端口)',
      'promoteFacts:',
      'tainted / evidence_valid',
      '墓碑 / 冷却 / 黑名单',
      '近似指纹:显式装配才匹配',
      'gateFacts 的类别与透传',
      'gateFacts:注入的 fingerprint 依赖失败',
      '组合层的来源绑定',
    ],
    mustKill: ['真组合层(makeFactsProvider over 内存读端口)'],
  },
  {
    id: 'facts_trigger_always_queried',
    clause: 'FactsProvider 规则类别不查失败触发',
    edits: [
      swap(
        'src/rsi/personal/facts/facts-provider.ts',
        "draft.category === 'pitfall' && trigger !== undefined",
        'true',
      ),
    ],
    tests: ['rsi/d1a/facts-provider.test.ts'],
    expectRed: [
      '规则类别:不查失败触发',
      '真组合层(makeFactsProvider over 内存读端口)',
      'promoteFacts:',
      'tainted / evidence_valid',
      '墓碑 / 冷却 / 黑名单',
      '近似指纹:显式装配才匹配',
      'gateFacts 的类别与透传',
      'gateFacts:注入的 fingerprint 依赖失败',
      '组合层的来源绑定',
    ],
    mustKill: ['规则类别:不查失败触发'],
  },
  {
    id: 'facts_near_threshold_unchecked',
    clause: 'FactsProvider near 阈值构造时校验',
    edits: [
      swap(
        'src/rsi/personal/facts/facts-provider.ts',
        'if (d.near !== undefined) assertNearThreshold(d.near.threshold);',
        '',
      ),
    ],
    tests: ['rsi/d1a/facts-provider.test.ts'],
    expectRed: [
      '阈值不合法(0 / NaN / 1.5)→ 构造时抛 RangeError',
      '真组合层(makeFactsProvider over 内存读端口)',
      'promoteFacts:',
      'tainted / evidence_valid',
      '墓碑 / 冷却 / 黑名单',
      '近似指纹:显式装配才匹配',
      'gateFacts 的类别与透传',
      'gateFacts:注入的 fingerprint 依赖失败',
      '组合层的来源绑定',
    ],
    mustKill: ['阈值不合法(0 / NaN / 1.5)→ 构造时抛 RangeError'],
  },
  {
    id: 'facts_source_proposal_id_ignored',
    clause: 'FactsProvider 来源提案匹配 run + proposal',
    edits: [
      swap(
        'src/rsi/personal/facts/facts-provider.ts',
        ' && s.proposal.id === auth.proposal_id',
        '',
      ),
    ],
    tests: ['rsi/d1a/facts-provider.test.ts'],
    expectRed: [
      '同一 run 里另有别的提案',
      '来源提案已不在暂存 / 工作副本指向别的提案',
      '真组合层(makeFactsProvider over 内存读端口)',
      'promoteFacts:',
      'tainted / evidence_valid',
      '墓碑 / 冷却 / 黑名单',
      '近似指纹:显式装配才匹配',
      'gateFacts 的类别与透传',
      'gateFacts:注入的 fingerprint 依赖失败',
      '组合层的来源绑定',
    ],
    mustKill: ['同一 run 里另有别的提案'],
  },
  {
    id: 'corpus_tie_picks_lowest',
    clause: '语料工具:并列取最高阈值',
    edits: [
      swap(
        'test/tools/near-fp-corpus.ts',
        '.reduce((a, b) => (b.threshold > a.threshold ? b : a));',
        '.reduce((a, b) => (b.threshold < a.threshold ? b : a));',
      ),
    ],
    tests: ['rsi/d1a/near-corpus.test.ts'],
    expectRed: [
      'maxFpRate = 0 时建议避开它,并列取最高阈值',
      '语料评估:统计与阈值建议',
      '语料解析',
      '命令行(进程内,注入 IO)',
      '语料评估:最坏情形口径',
      '语料评估:超长输入按「无法评估」计入',
    ],
    mustKill: ['maxFpRate = 0 时建议避开它,并列取最高阈值'],
  },
  {
    id: 'corpus_fp_limit_ignored',
    clause: '语料工具:误报上限',
    edits: [
      swap(
        'test/tools/near-fp-corpus.ts',
        's.fpRate !== null && s.fpRate <= maxFpRate,',
        's.fpRate !== null,',
      ),
    ],
    tests: ['rsi/d1a/near-corpus.test.ts'],
    expectRed: [
      'maxFpRate = 0 时建议避开它,并列取最高阈值',
      '语料评估:统计与阈值建议',
      '语料解析',
      '命令行(进程内,注入 IO)',
      '语料评估:最坏情形口径',
      '语料评估:超长输入按「无法评估」计入',
    ],
    mustKill: ['maxFpRate = 0 时建议避开它,并列取最高阈值'],
  },
  {
    id: 'corpus_exact_only_counted',
    clause: '语料工具:exact_only 不计入',
    edits: [
      swap(
        'test/tools/near-fp-corpus.ts',
        'const usable = evaluable.filter((c) => (shingleCount.get(c.id) as number) > 0);',
        'const usable = evaluable;',
      ),
    ],
    tests: ['rsi/d1a/near-corpus.test.ts'],
    expectRed: [
      '被否决内容不足 3 个 token(exact_only)不计入统计',
      '语料评估:统计与阈值建议',
      '语料解析',
      '命令行(进程内,注入 IO)',
      '语料评估:最坏情形口径',
      '语料评估:超长输入按「无法评估」计入',
    ],
    mustKill: ['被否决内容不足 3 个 token(exact_only)不计入统计'],
  },
  {
    id: 'corpus_dup_id_allowed',
    clause: '语料工具:id 唯一',
    edits: [swap('test/tools/near-fp-corpus.ts', "if (seen.has(o['id'])) {", 'if (false) {')],
    tests: ['rsi/d1a/near-corpus.test.ts'],
    expectRed: [
      '非法行逐条报错,带「文件:行号」',
      '语料评估:统计与阈值建议',
      '语料解析',
      '命令行(进程内,注入 IO)',
      '语料评估:最坏情形口径',
      '语料评估:超长输入按「无法评估」计入',
    ],
    mustKill: ['非法行逐条报错,带「文件:行号」'],
  },
  {
    id: 'corpus_label_unchecked',
    clause: '语料工具:label 校验',
    edits: [
      swap(
        'test/tools/near-fp-corpus.ts',
        "if (o['label'] !== 'match' && o['label'] !== 'nomatch') {",
        'if (false) {',
      ),
    ],
    tests: ['rsi/d1a/near-corpus.test.ts'],
    expectRed: [
      '非法行逐条报错,带「文件:行号」',
      '语料评估:统计与阈值建议',
      '语料解析',
      '命令行(进程内,注入 IO)',
      '语料评估:最坏情形口径',
      '语料评估:超长输入按「无法评估」计入',
    ],
    mustKill: ['非法行逐条报错,带「文件:行号」'],
  },
  {
    id: 'corpus_worst_fp_lost',
    clause: '语料工具:误报取最坏情形',
    edits: [
      swap('test/tools/near-fp-corpus.ts', 'fp = Math.max(fp, kFp);', 'fp = Math.min(fp, kFp);'),
    ],
    tests: ['rsi/d1a/near-corpus.test.ts'],
    expectRed: [
      'maxFpRate = 0 时建议避开它,并列取最高阈值',
      '语料评估:统计与阈值建议',
      '语料解析',
      '命令行(进程内,注入 IO)',
      '语料评估:最坏情形口径',
      '语料评估:超长输入按「无法评估」计入',
    ],
    mustKill: ['maxFpRate = 0 时建议避开它,并列取最高阈值'],
  },
  {
    id: 'corpus_single_key',
    clause: '语料工具:多密钥评估',
    edits: [
      swap(
        'test/tools/near-fp-corpus.ts',
        'const keys = opts.keys ?? CORPUS_KEYS;',
        'const keys = [CORPUS_KEYS[0] as Uint8Array];',
      ),
    ],
    tests: ['rsi/d1a/near-corpus.test.ts'],
    expectRed: [
      '评估统计依赖密钥:超过 64 个 shingle 的被否决内容',
      '语料评估:统计与阈值建议',
      '语料解析',
      '命令行(进程内,注入 IO)',
      '语料评估:最坏情形口径',
      '语料评估:超长输入按「无法评估」计入',
    ],
    mustKill: ['评估统计依赖密钥:超过 64 个 shingle 的被否决内容'],
  },
  {
    id: 'facts_gate_not_guarded',
    clause: 'FactsProvider gateFacts 草稿构建受 guarded 保护',
    edits: [
      swap(
        'src/rsi/personal/facts/facts-provider.ts',
        'return guarded(async () => {\n      const dr = buildDraft(',
        'return (async () => {\n      const dr = buildDraft(',
      ),
      swap(
        'src/rsi/personal/facts/facts-provider.ts',
        '        replay: await r.context.replay(draft.clusterSignature),\n      };\n    });',
        '        replay: await r.context.replay(draft.clusterSignature),\n      };\n    })();',
      ),
    ],
    tests: ['rsi/d1a/facts-provider.test.ts'],
    expectRed: [
      'fingerprint 抛普通错误 / 返回非法值 → gateFacts = null',
      '真组合层(makeFactsProvider over 内存读端口)',
      'promoteFacts:',
      'tainted / evidence_valid',
      '墓碑 / 冷却 / 黑名单',
      '近似指纹:显式装配才匹配',
      'gateFacts 的类别与透传',
      'gateFacts:注入的 fingerprint 依赖失败',
      '组合层的来源绑定',
    ],
    mustKill: ['fingerprint 抛普通错误 / 返回非法值 → gateFacts = null'],
  },
  {
    id: 'facts_wc_id_unchecked',
    clause: '验收评审高项:工作副本 id 必须等于权威记录 id',
    edits: [
      swap('src/rsi/personal/facts/facts-provider.ts', 'if (wc.id !== rec.id) return null;', ''),
    ],
    tests: ['rsi/d1a/facts-provider.test.ts'],
    expectRed: [
      '工作副本 id 与权威记录 id 不同',
      '组合层的来源绑定',
      '真组合层(makeFactsProvider over 内存读端口)',
      'promoteFacts:',
      'tainted / evidence_valid',
      '墓碑 / 冷却 / 黑名单',
      '近似指纹:显式装配才匹配',
      'gateFacts 的类别与透传',
      'gateFacts:注入的 fingerprint 依赖失败',
    ],
    mustKill: ['工作副本 id 与权威记录 id 不同'],
  },
  {
    id: 'facts_wc_source_unchecked',
    clause: '验收评审高项:工作副本来源必须与权威记录来源一致',
    edits: [
      swap(
        'src/rsi/personal/facts/facts-provider.ts',
        'if (wc.source.run_id !== auth.run_id || wc.source.proposal_id !== auth.proposal_id) return null;',
        '',
      ),
    ],
    tests: ['rsi/d1a/facts-provider.test.ts'],
    expectRed: [
      '高项复现:工作副本 id=A 但 source 改成干净提案 B',
      '组合层的来源绑定',
      '真组合层(makeFactsProvider over 内存读端口)',
      'promoteFacts:',
      'tainted / evidence_valid',
      '墓碑 / 冷却 / 黑名单',
      '近似指纹:显式装配才匹配',
      'gateFacts 的类别与透传',
      'gateFacts:注入的 fingerprint 依赖失败',
    ],
    mustKill: ['高项复现:工作副本 id=A 但 source 改成干净提案 B'],
  },
  {
    id: 'facts_rec_source_null_ok',
    clause: '验收评审高项:权威记录无 source_proposal → null',
    edits: [
      swap(
        'src/rsi/personal/facts/facts-provider.ts',
        'if (auth === null || auth === undefined) return null;',
        '',
      ),
    ],
    tests: ['rsi/d1a/facts-provider.test.ts'],
    expectRed: [
      '权威记录没有 source_proposal',
      '组合层的来源绑定',
      '真组合层(makeFactsProvider over 内存读端口)',
      'promoteFacts:',
      'tainted / evidence_valid',
      '墓碑 / 冷却 / 黑名单',
      '近似指纹:显式装配才匹配',
      'gateFacts 的类别与透传',
      'gateFacts:注入的 fingerprint 依赖失败',
    ],
    mustKill: ['权威记录没有 source_proposal'],
  },
  {
    id: 'facts_staged_material_unbound',
    clause: '验收评审高项:暂存材料必须仍是创建时那份',
    edits: [
      swap(
        'src/rsi/personal/facts/facts-provider.ts',
        'if (!stagedMatchesRecord(sp, rec)) return null;',
        '',
      ),
    ],
    tests: ['rsi/d1a/facts-provider.test.ts'],
    expectRed: [
      '暂存材料在创建后被换了内容',
      '组合层的来源绑定',
      '真组合层(makeFactsProvider over 内存读端口)',
      'promoteFacts:',
      'tainted / evidence_valid',
      '墓碑 / 冷却 / 黑名单',
      '近似指纹:显式装配才匹配',
      'gateFacts 的类别与透传',
      'gateFacts:注入的 fingerprint 依赖失败',
    ],
    mustKill: ['暂存材料在创建后被换了内容'],
  },
  {
    id: 'facts_staged_ambiguity_ok',
    clause: '验收评审高项:同一 (run, 提案) 多份 → 歧义 null',
    edits: [
      swap(
        'src/rsi/personal/facts/facts-provider.ts',
        'if (hits.length !== 1 || sp === undefined) return null;',
        'if (sp === undefined) return null;',
      ),
    ],
    tests: ['rsi/d1a/facts-provider.test.ts'],
    expectRed: [
      '暂存区里同一 (run, 提案 id) 出现两份',
      '组合层的来源绑定',
      '真组合层(makeFactsProvider over 内存读端口)',
      'promoteFacts:',
      'tainted / evidence_valid',
      '墓碑 / 冷却 / 黑名单',
      '近似指纹:显式装配才匹配',
      'gateFacts 的类别与透传',
      'gateFacts:注入的 fingerprint 依赖失败',
    ],
    mustKill: ['暂存区里同一 (run, 提案 id) 出现两份'],
  },
  {
    id: 'facts_staged_run_ignored',
    clause: '验收评审高项:来源提案按 run 与提案 id 两个维度匹配',
    edits: [swap('src/rsi/personal/facts/facts-provider.ts', 's.runId === auth.run_id && ', '')],
    tests: ['rsi/d1a/facts-provider.test.ts'],
    expectRed: [
      '同一 run 里另有别的提案',
      '组合层的来源绑定',
      '真组合层(makeFactsProvider over 内存读端口)',
      'promoteFacts:',
      'tainted / evidence_valid',
      '墓碑 / 冷却 / 黑名单',
      '近似指纹:显式装配才匹配',
      'gateFacts 的类别与透传',
      'gateFacts:注入的 fingerprint 依赖失败',
    ],
    mustKill: ['同一 run 里另有别的提案'],
  },
  {
    id: 'facts_foreign_signal_ok',
    clause: '验收评审高项:信号端口只能返回被请求的 sig',
    edits: [
      swap(
        'src/rsi/personal/facts/facts-provider.ts',
        'if (!allowed.has(s.sig_id) || seen.has(s.sig_id)) return null;',
        'if (seen.has(s.sig_id)) return null;',
      ),
    ],
    tests: ['rsi/d1a/facts-provider.test.ts'],
    expectRed: [
      '信号端口多返回了未被请求的信号',
      '组合层的来源绑定',
      '真组合层(makeFactsProvider over 内存读端口)',
      'promoteFacts:',
      'tainted / evidence_valid',
      '墓碑 / 冷却 / 黑名单',
      '近似指纹:显式装配才匹配',
      'gateFacts 的类别与透传',
      'gateFacts:注入的 fingerprint 依赖失败',
    ],
    mustKill: ['信号端口多返回了未被请求的信号'],
  },
  {
    id: 'facts_dup_signal_ok',
    clause: '验收评审高项:信号端口重复返回同一信号 → null',
    edits: [
      swap(
        'src/rsi/personal/facts/facts-provider.ts',
        '|| seen.has(s.sig_id)) return null;',
        ') return null;',
      ),
    ],
    tests: ['rsi/d1a/facts-provider.test.ts'],
    expectRed: [
      '信号端口把同一个信号返回两次',
      '组合层的来源绑定',
      '真组合层(makeFactsProvider over 内存读端口)',
      'promoteFacts:',
      'tainted / evidence_valid',
      '墓碑 / 冷却 / 黑名单',
      '近似指纹:显式装配才匹配',
      'gateFacts 的类别与透传',
      'gateFacts:注入的 fingerprint 依赖失败',
    ],
    mustKill: ['信号端口把同一个信号返回两次'],
  },
  {
    id: 'fpkey_exists_skips_sync',
    clause: '验收评审中1:exists 路径补文件与目录 fsync',
    edits: [
      swap(
        'src/rsi/personal/fp/fp-key.ts',
        "if (cur.kind === 'ok') return confirmDurable(dir, cur.key);",
        "if (cur.kind === 'ok') return 'exists';",
      ),
    ],
    tests: ['rsi/d1a/fp-key.test.ts'],
    expectRed: [
      '首建时父目录 fsync 失败 → ensure 抛错',
      'FpKeyPort 真实现:持久化确认',
      '权限宽于 0600 → invalid(不修复、不覆盖)',
      '真实现(文件系统)',
      'FpKeyPort 真实现:文件与目录',
    ],
    mustKill: ['首建时父目录 fsync 失败 → ensure 抛错'],
  },
  {
    id: 'fpkey_race_loser_skips_sync',
    clause: '验收评审中1:并发首建败者同样补 fsync',
    edits: [
      swap(
        'src/rsi/personal/fp/fp-key.ts',
        "if (again.kind === 'ok') return confirmDurable(dir, again.key);",
        "if (again.kind === 'ok') return 'exists';",
      ),
    ],
    tests: ['rsi/d1a/fp-key.test.ts'],
    expectRed: [
      '并发首建的败者(EEXIST 后重读有效)同样补文件与目录 fsync',
      'FpKeyPort 真实现:持久化确认',
      '真实现(文件系统)',
      'FpKeyPort 真实现:文件与目录',
    ],
    mustKill: ['并发首建的败者(EEXIST 后重读有效)同样补文件与目录 fsync'],
  },
  {
    id: 'cap_snapshot_not_frozen',
    clause: '验收评审中3:快照是冻结值对象',
    edits: [
      swap(
        'src/rsi/personal/fp/near-capability.ts',
        'return Object.freeze({ state: v.state, reason: v.reason });',
        'return { state: v.state, reason: v.reason };',
      ),
    ],
    tests: ['rsi/d1a/near-capability.test.ts'],
    expectRed: ['快照是冻结的值对象', '能力判定的操作级快照', 'NearFpCapability('],
    mustKill: ['快照是冻结的值对象'],
  },
  {
    id: 'cap_snapshot_rereads_key',
    clause: '验收评审中3:一次快照只读一次 key',
    edits: [
      swap(
        'src/rsi/personal/fp/near-capability.ts',
        'snapshot: async () => freezeNearFpCapability(await decide()) };',
        'snapshot: async () => {\n      await decide();\n      return freezeNearFpCapability(await decide());\n    },\n  };',
      ),
    ],
    tests: ['rsi/d1a/near-capability.test.ts'],
    expectRed: ['快照:取一次(只读一次 key)', '能力判定的操作级快照', 'NearFpCapability('],
    mustKill: ['快照:取一次(只读一次 key)'],
  },
  {
    id: 'cap_denial_ignores_unfrozen',
    clause: '验收评审中3:非 ready 快照一律拒绝',
    edits: [
      swap(
        'src/rsi/personal/fp/near-capability.ts',
        "return s.state === 'ready'\n    ? null",
        "return s.state === 'ready' || s.state === 'algo_unfrozen'\n    ? null",
      ),
    ],
    tests: ['rsi/d1a/near-capability.test.ts'],
    expectRed: [
      '消费者对非 ready 快照给出带状态与原因的拒绝',
      '能力判定的操作级快照',
      'NearFpCapability(',
    ],
    mustKill: ['消费者对非 ready 快照给出带状态与原因的拒绝'],
  },
  {
    id: 'cap_ready_loose',
    clause: '验收评审中3:nearFpReady 只认 ready',
    edits: [
      swap(
        'src/rsi/personal/fp/near-capability.ts',
        "boolean => s.state === 'ready';",
        "boolean => s.state !== 'unwired';",
      ),
    ],
    tests: ['rsi/d1a/near-capability.test.ts'],
    expectRed: [
      '消费者对非 ready 快照给出带状态与原因的拒绝',
      '能力判定的操作级快照',
      'NearFpCapability(',
    ],
    mustKill: ['消费者对非 ready 快照给出带状态与原因的拒绝'],
  },
  {
    id: 'corpus_candidate_len_unchecked',
    clause: '验收评审中2:候选侧超长也判无法评估',
    edits: [
      swap('test/tools/near-fp-corpus.ts', ' || c.candidate.length > NEAR_MAX_INPUT_CHARS;', ';'),
    ],
    tests: ['rsi/d1a/near-corpus.test.ts'],
    expectRed: [
      '两侧都查(含 exact-only 用例)',
      '语料评估:统计与阈值建议',
      '语料解析',
      '命令行(进程内,注入 IO)',
      '语料评估:最坏情形口径',
      '语料评估:超长输入按「无法评估」计入',
    ],
    mustKill: ['两侧都查(含 exact-only 用例)'],
  },
  {
    id: 'corpus_vetoed_len_unchecked',
    clause: '验收评审中2:被否决侧超长判无法评估',
    edits: [swap('test/tools/near-fp-corpus.ts', 'c.vetoed.length > NEAR_MAX_INPUT_CHARS || ', '')],
    tests: ['rsi/d1a/near-corpus.test.ts'],
    expectRed: [
      '两侧都查(含 exact-only 用例)',
      '语料评估:统计与阈值建议',
      '语料解析',
      '命令行(进程内,注入 IO)',
      '语料评估:最坏情形口径',
      '语料评估:超长输入按「无法评估」计入',
    ],
    mustKill: ['两侧都查(含 exact-only 用例)'],
  },
  {
    id: 'corpus_unevaluable_unfiltered',
    clause: '验收评审中2:无法评估的用例不进统计',
    edits: [
      swap(
        'test/tools/near-fp-corpus.ts',
        'const evaluable = cases.filter((c) => !tooLong(c));',
        'const evaluable = cases;',
      ),
    ],
    tests: ['rsi/d1a/near-corpus.test.ts'],
    expectRed: [
      '两侧都查(含 exact-only 用例)',
      '语料评估:统计与阈值建议',
      '语料解析',
      '命令行(进程内,注入 IO)',
      '语料评估:最坏情形口径',
      '语料评估:超长输入按「无法评估」计入',
    ],
    mustKill: ['两侧都查(含 exact-only 用例)'],
  },
  {
    id: 'corpus_unevaluable_exit_zero',
    clause: '验收评审中2:有无法评估的用例 → 退出 2',
    edits: [
      swap(
        'test/tools/near-fp-corpus.ts',
        'if (report.unevaluableIds.length > 0) {',
        'if (false) {',
      ),
    ],
    tests: ['rsi/d1a/near-corpus.test.ts'],
    expectRed: [
      '超长输入:仍输出报告(stdout),stderr 只含 case id,退出 2',
      '语料评估:统计与阈值建议',
      '语料解析',
      '命令行(进程内,注入 IO)',
      '语料评估:最坏情形口径',
      '语料评估:超长输入按「无法评估」计入',
    ],
    mustKill: ['超长输入:仍输出报告(stdout),stderr 只含 case id,退出 2'],
  },
  {
    id: 'corpus_read_failure_unhandled',
    clause: '验收评审中2:语料目录读失败 → 固定文案退出 2',
    edits: [
      swap(
        'test/tools/near-fp-corpus.ts',
        'files = await io.readCorpus(dir);\n  } catch {',
        'files = await io.readCorpus(dir);\n  } catch (e) {\n    throw e;',
      ),
    ],
    tests: ['rsi/d1a/near-corpus.test.ts'],
    expectRed: [
      '语料目录读失败 → 退出 2,固定文案,不回显异常内容',
      '语料评估:统计与阈值建议',
      '语料解析',
      '命令行(进程内,注入 IO)',
      '语料评估:最坏情形口径',
      '语料评估:超长输入按「无法评估」计入',
    ],
    mustKill: ['语料目录读失败 → 退出 2,固定文案,不回显异常内容'],
  },
  {
    id: 'corpus_worst_fp_ids_union',
    clause: '验收评审低1:误报 id 列表与计数同一把最坏密钥',
    edits: [swap('test/tools/near-fp-corpus.ts', 'fpWorst = kFpIds;', 'fpWorst = [...fpSet];')],
    tests: ['rsi/d1a/near-corpus.test.ts'],
    expectRed: [
      'fp 计数 = 最坏密钥下的 id 数',
      '语料评估:统计与阈值建议',
      '语料解析',
      '命令行(进程内,注入 IO)',
      '语料评估:最坏情形口径',
      '语料评估:超长输入按「无法评估」计入',
    ],
    mustKill: ['fp 计数 = 最坏密钥下的 id 数'],
  },
  {
    id: 'corpus_worst_fn_ids_union',
    clause: '验收评审低1:漏报 id 列表与计数同一把最坏密钥',
    edits: [swap('test/tools/near-fp-corpus.ts', 'fnWorst = kFnIds;', 'fnWorst = [...fnSet];')],
    tests: ['rsi/d1a/near-corpus.test.ts'],
    expectRed: [
      'fn 计数 = 最坏密钥下的 id 数',
      '语料评估:统计与阈值建议',
      '语料解析',
      '命令行(进程内,注入 IO)',
      '语料评估:最坏情形口径',
      '语料评估:超长输入按「无法评估」计入',
    ],
    mustKill: ['fn 计数 = 最坏密钥下的 id 数'],
  },
];

/**
 * 由主代理整表执行变异后回填。**本轮(验收评审修复)新增 / 改动了变异条目,旧结果(r21d1a-mut2 @f1f2cf5,63 条)作废,已清空**;
 * 回填时与上方表同序、同条数(83)。
 */
export const V1_ASM_D1A_RESULTS: readonly V1AsmD1aResult[] = [];
