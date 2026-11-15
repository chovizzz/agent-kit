/**
 * §21 V1 装配块 C1a(接口先行块)必杀变异:回合 / 写适配器 / 授权令牌与按 op 的检查子集 / `settleSafety` 与预算 / 兜底协调器 / 判决槽 / 冻结常量。
 * 执行方式同 B1a:验证机私有检出里 cp 备份 → 按锚点替换(每个锚点在对应文件里**恰好出现一次**)→ 跑 `tests` → 失败集合非空、全部命中 `expectRed`、
 * `mustKill` 每项至少命中一个、没有 skipped → cp 还原并逐文件 sha256 核对。**不用 git checkout / stash 还原**。
 * 本文件只写表与每条变异期望红的测试名(`expectRed` 是杀手测试名里的字面子串);变异由主代理整表执行,结果记进 `V1_ASM_C1A_RESULTS`(本块不执行变异,故留空)。
 * 不在本表的点(如实记录):纯类型层的约束(`BothRound` / `GrowthPass` 的品牌、`@ts-expect-error` 负向用例)由 `pnpm run typecheck` 强制,vitest 不做类型检查,
 * 故它们的变异(去掉品牌)杀不掉——这里用运行期等价物代替(导出清单 / 登记表 / 回合形态校验);`checkJudgeGrowth` 的超时分支与「非法值」分支结果同码(`judge_indeterminate`),
 * 去掉超时分支是等价变异,不入表;`c1-inert.test.ts` 的静态扫描器是检查器而非被测逻辑(其正向对照已覆盖)。
 * 变异 id 用短的下划线词。本文件不 import 任何东西(验证机用 `node --experimental-strip-types` 直接加载)。
 */
export interface Edit {
  file: string;
  anchor: string;
  replacement: string;
}

export interface V1AsmC1aMutation {
  id: string;
  /** 设计稿条款 / 该不变量 */
  clause: string;
  edits: readonly Edit[];
  /** 相对 `test/` */
  tests: readonly string[];
  expectRed: readonly string[];
  mustKill: readonly string[];
}

export interface V1AsmC1aResult {
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

export const V1_ASM_C1A_MUTATIONS: readonly V1AsmC1aMutation[] = [
  {
    id: 'write_not_single_flight',
    clause: 'C v2 §4.2 单飞:嵌套 / 并发 = internal',
    edits: [
      swap(
        'src/rsi/personal/stage/round.ts',
        '      if (st.inFlight !== 0) throw new RoundInternalError(`write_in_flight:${kind}`);\n',
        '',
      ),
    ],
    tests: ['rsi/stage/c1-round.test.ts'],
    expectRed: ['concurrent_write_port_use_is_internal_error', 'nested_adapter_is_internal_error'],
    mustKill: ['concurrent_write_port_use_is_internal_error'],
  },
  {
    id: 'bump_after_await_only',
    clause: 'C v2 §4.2 gen 在 finally 无条件推进(覆盖写成功后抛错)',
    edits: [
      swap(
        'src/rsi/personal/stage/round.ts',
        '        return await fn.apply(this, args);',
        '        const r = await fn.apply(this, args);\n        st.gen += 1;\n        return r;',
      ),
      swap(
        'src/rsi/personal/stage/round.ts',
        '        st.gen += 1;\n        if (DIRTY_KIND_SET',
        '        if (DIRTY_KIND_SET',
      ),
    ],
    tests: ['rsi/stage/c1-round.test.ts'],
    expectRed: ['write_then_throw_bumps_gen_and_unsettles'],
    mustKill: ['write_then_throw_bumps_gen_and_unsettles'],
  },
  {
    id: 'unknown_error_not_unsettled',
    clause: 'C v2 §4.2 默认「不确定」:未知错误使本轮未决',
    edits: [
      swap(
        'src/rsi/personal/stage/round.ts',
        '        if (!(e instanceof DefinitelyNotWritten)) st.markUnsettled(`write_outcome_unknown:${kind}`);\n',
        '',
      ),
    ],
    tests: ['rsi/stage/c1-round.test.ts'],
    expectRed: ['write_then_throw_bumps_gen_and_unsettles', '默认一律「不确定」'],
    mustKill: ['write_then_throw_bumps_gen_and_unsettles'],
  },
  {
    id: 'definitely_not_written_unsettles',
    clause: 'C v2 §4.2 DefinitelyNotWritten 不使本轮未决',
    edits: [
      swap(
        'src/rsi/personal/stage/round.ts',
        '!(e instanceof DefinitelyNotWritten)',
        'e !== undefined',
      ),
    ],
    tests: ['rsi/stage/c1-round.test.ts'],
    expectRed: ['prevalidation_failure_not_unsettled'],
    mustKill: ['prevalidation_failure_not_unsettled'],
  },
  {
    id: 'dirty_set_by_all_kinds',
    clause: 'C v2 §4.1 审计补行 / 压缩 / effects 不置脏',
    edits: [
      swap(
        'src/rsi/personal/stage/round.ts',
        'if (DIRTY_KIND_SET.has(kind) && !st.sweeping)',
        'if (!st.sweeping)',
      ),
    ],
    tests: ['rsi/stage/c1-round.test.ts'],
    expectRed: ['写 → 不置脏'],
    mustKill: ['写 → 不置脏'],
  },
  {
    id: 'dirty_not_set_for_dirty_kinds',
    clause: 'C v2 §4.1 暂停码 / 凭据 / 转移 / trip 写置脏',
    edits: [
      swap(
        'src/rsi/personal/stage/round.ts',
        'if (DIRTY_KIND_SET.has(kind) && !st.sweeping)',
        'if (!DIRTY_KIND_SET.has(kind) && !st.sweeping)',
      ),
    ],
    tests: ['rsi/stage/c1-round.test.ts'],
    expectRed: ['写 → 置脏'],
    mustKill: ['写 → 置脏'],
  },
  {
    id: 'sweeping_ignored_by_dirty',
    clause: 'C v2 §4.3 扫尾自己的写不再置脏',
    edits: [
      swap(
        'src/rsi/personal/stage/round.ts',
        'DIRTY_KIND_SET.has(kind) && !st.sweeping',
        'DIRTY_KIND_SET.has(kind)',
      ),
    ],
    tests: ['rsi/stage/c1-settle.test.ts'],
    expectRed: ['扫尾自己的写不再置脏'],
    mustKill: ['扫尾自己的写不再置脏'],
  },
  {
    id: 'latch_overwrites',
    clause: 'W9 §4 blocked latch 单调只加严',
    edits: [
      swap(
        'src/rsi/personal/stage/round.ts',
        'if (!st.latch.has(b.id)) st.latch.set(b.id, b.code);',
        'st.latch.set(b.id, b.code);',
      ),
    ],
    tests: ['rsi/stage/c1-round.test.ts'],
    expectRed: ['同一 id 已有码时保持原码'],
    mustKill: ['同一 id 已有码时保持原码'],
  },
  {
    id: 'attempt_forgery_accepted',
    clause: 'C v1 §3 BothRound 只能由个人锁试锁成功构造',
    edits: [
      swap(
        'src/rsi/personal/stage/round.ts',
        "  if (!isProducedAttempt(attempt)) throw new RoundInternalError('attempt_not_produced');\n",
        '',
      ),
    ],
    tests: ['rsi/stage/c1-round.test.ts'],
    expectRed: ['伪造的试锁结果'],
    mustKill: ['伪造的试锁结果'],
  },
  {
    id: 'same_nonce_accepted',
    clause: 'C v1 §3 两把锁 nonce 相同 = 同一句柄当两把锁',
    edits: [
      swap(
        'src/rsi/personal/stage/round.ts',
        "    if (pn === rsi.nonce) throw new RoundInternalError('same_nonce');\n",
        '',
      ),
    ],
    tests: ['rsi/stage/c1-round.test.ts'],
    expectRed: ['两把锁 nonce 相同'],
    mustKill: ['两把锁 nonce 相同'],
  },
  {
    id: 'unsettled_not_deduped',
    clause: 'C v2 §4.2 未决原因去重',
    edits: [
      swap(
        'src/rsi/personal/stage/round.ts',
        'if (!unsettled.includes(reason)) unsettled.push(reason);',
        'unsettled.push(reason);',
      ),
    ],
    tests: ['rsi/stage/c1-round.test.ts'],
    expectRed: ['去重;只对本模块开的回合有效'],
    mustKill: ['去重;只对本模块开的回合有效'],
  },
  {
    id: 'take_dirty_no_clear',
    clause: 'C v2 §4.3 takeAll 此刻清零',
    edits: [swap('src/rsi/personal/stage/round.ts', '      dirty.clear();\n', '')],
    tests: ['rsi/stage/c1-settle.test.ts'],
    expectRed: ['sweep_clears_dirty_before_run_and_does_not_reloop'],
    mustKill: ['sweep_clears_dirty_before_run_and_does_not_reloop'],
  },
  {
    id: 'busy_round_gets_both_form',
    clause: 'C v1 §3 忙 / 故障轮没有 BothRound(rsi-only 形态)',
    edits: [
      swap(
        'src/rsi/personal/stage/round.ts',
        "const st = makeInternals('rsi_only');",
        "const st = makeInternals('both');",
      ),
    ],
    tests: ['rsi/stage/c1-round.test.ts', 'rsi/stage/c1-types.test.ts'],
    expectRed: ['上限表:持两锁 / 忙', '① BothRound 与 RsiOnlyRound 互不可赋值'],
    mustKill: ['上限表:持两锁 / 忙', '① BothRound 与 RsiOnlyRound 互不可赋值'],
  },
  {
    id: 'busy_swallows_other_errors',
    clause: 'C v1 §2 锁忙只认 locked / locked_over_ttl',
    edits: [
      swap(
        'src/rsi/personal/stage/lock-identity.ts',
        "if (e.kind === 'locked' || e.kind === 'locked_over_ttl') return make({ kind: 'busy' });",
        "return make({ kind: 'busy' });",
      ),
    ],
    tests: ['rsi/stage/c1-round.test.ts'],
    expectRed: ['fault personal_lock_error:<同码>'],
    mustKill: ['fault personal_lock_error:<同码>'],
  },
  {
    id: 'over_ttl_not_busy',
    clause: 'C v1 §2 locked_over_ttl 也是锁忙',
    edits: [
      swap(
        'src/rsi/personal/stage/lock-identity.ts',
        "e.kind === 'locked' || e.kind === 'locked_over_ttl'",
        "e.kind === 'locked'",
      ),
    ],
    tests: ['rsi/stage/c1-round.test.ts'],
    expectRed: ['→ busy(没有个人锁句柄)'],
    mustKill: ['→ busy(没有个人锁句柄)'],
  },
  {
    id: 'personal_lost_not_converted',
    clause: 'C v1 §2 个人锁 lock_lost 转型为 PersonalLockLost',
    edits: [
      swap(
        'src/rsi/personal/stage/lock-identity.ts',
        '        if (isRsiLockLost(e)) throw new PersonalLockLost();\n',
        '',
      ),
    ],
    tests: ['rsi/stage/c1-round.test.ts'],
    expectRed: ['assertHeld 抛 lock_lost → PersonalLockLost'],
    mustKill: ['assertHeld 抛 lock_lost → PersonalLockLost'],
  },
  {
    id: 'non_lock_error_not_fault',
    clause: 'C v1 §2 非 RsiLockError 的获取失败 = 故障',
    edits: [
      swap(
        'src/rsi/personal/stage/lock-identity.ts',
        "return make({ kind: 'fault', fault: { code: 'personal_lock_error:internal' } });",
        "return make({ kind: 'busy' });",
      ),
    ],
    tests: ['rsi/stage/c1-round.test.ts'],
    expectRed: ['非 RsiLockError(普通 Error / 字符串)'],
    mustKill: ['非 RsiLockError(普通 Error / 字符串)'],
  },
  {
    id: 'rsi_lost_not_rethrown',
    clause: 'C v1 §2 rsi lock_lost 无条件上抛',
    edits: [
      swap(
        'src/rsi/personal/stage/errors.ts',
        "  if (isRsiLockLost(e)) return { kind: 'rethrow' };\n",
        '',
      ),
    ],
    tests: ['rsi/stage/c1-fallback.test.ts'],
    expectRed: ['rsi lock_lost → rethrow(无条件上抛)'],
    mustKill: ['rsi lock_lost → rethrow(无条件上抛)'],
  },
  {
    id: 'personal_lost_not_ending_round',
    clause: 'C v1 §2 个人锁丢失结束个人轮',
    edits: [
      swap(
        'src/rsi/personal/stage/errors.ts',
        "  if (e instanceof PersonalLockLost) return { kind: 'end_personal_round' };\n",
        '',
      ),
    ],
    tests: ['rsi/stage/c1-fallback.test.ts'],
    expectRed: ['PersonalLockLost → end_personal_round'],
    mustKill: ['PersonalLockLost → end_personal_round'],
  },
  {
    id: 'halt_lock_lost_as_stop',
    clause: 'W9 §4 StepHalt lock_lost 不能默认当个人锁(须先查明)',
    edits: [
      swap(
        'src/rsi/personal/stage/errors.ts',
        "lock_lost: { kind: 'lock_lost_unresolved' },",
        "lock_lost: { kind: 'stop_step' },",
      ),
    ],
    tests: ['rsi/stage/c1-fallback.test.ts'],
    expectRed: ['逐值钉死'],
    mustKill: ['逐值钉死'],
  },
  {
    id: 'halt_integrity_continues',
    clause: 'W9 §4 仓库完整性 halted 使本轮未决',
    edits: [
      swap(
        'src/rsi/personal/stage/errors.ts',
        "repo_invalid: { kind: 'stop_step_unsettled', cause: 'repo_invalid' },",
        "repo_invalid: { kind: 'stop_step' },",
      ),
    ],
    tests: ['rsi/stage/c1-fallback.test.ts'],
    expectRed: ['逐值钉死'],
    mustKill: ['逐值钉死'],
  },
  {
    id: 'resolve_defaults_to_personal',
    clause: 'W9 §4 失锁归属查不出 = unknown(不默认个人锁)',
    edits: [
      swap(
        'src/rsi/personal/stage/errors.ts',
        "    return isRsiLockLost(e) ? 'rsi' : 'unknown';",
        "    return 'rsi';",
      ),
    ],
    tests: ['rsi/stage/c1-fallback.test.ts'],
    expectRed: ['复核本身 I/O 失败 → unknown'],
    mustKill: ['复核本身 I/O 失败 → unknown'],
  },
  {
    id: 'resolve_rsi_not_preferred',
    clause: 'W9 §4 两把都丢 → rsi 优先(上抛)',
    edits: [
      swap(
        'src/rsi/personal/stage/errors.ts',
        '    await rsi.assertHeld();\n  } catch (e) {',
        '    await personal.assertHeld();\n  } catch (e) {',
      ),
    ],
    tests: ['rsi/stage/c1-fallback.test.ts'],
    expectRed: ['rsi 丢 → rsi;两把都丢 → rsi(上抛优先)'],
    mustKill: ['rsi 丢 → rsi;两把都丢 → rsi(上抛优先)'],
  },
  {
    id: 'pass_constructor_exported',
    clause: 'C v2 §8.1 GrowthPass 构造函数不导出',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        'function mint(round: BothRound, op: GrowthOp, gen: number): GrowthPass {',
        'export function mint(round: BothRound, op: GrowthOp, gen: number): GrowthPass {',
      ),
    ],
    tests: ['rsi/stage/c1-freeze.test.ts'],
    expectRed: ['stage/growth.ts'],
    mustKill: ['stage/growth.ts'],
  },
  {
    id: 'require_ignores_gen',
    clause: 'C v2 §4.2 任何写之后旧 pass 失效',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        "  if (pass.gen !== round.gen()) return 'gen_changed';\n",
        '',
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['pass_after_any_write_refused'],
    mustKill: ['pass_after_any_write_refused'],
  },
  {
    id: 'require_ignores_nonce',
    clause: 'C v1 §3 nonce 不等 → 拒',
    edits: [
      swap('src/rsi/personal/stage/growth.ts', "    return 'nonce_mismatch';", '    return null;'),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['stale_pass_other_round_refused'],
    mustKill: ['stale_pass_other_round_refused'],
  },
  {
    id: 'require_ignores_round_identity',
    clause: 'C v1 §3 pass 绑定回合',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        "  if (rec.round !== round) return 'round_mismatch';\n",
        '',
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['stale_pass_other_round_refused'],
    mustKill: ['stale_pass_other_round_refused'],
  },
  {
    id: 'require_ignores_op',
    clause: 'C v1 §3 op 不等(换候选 / 换能力)→ 拒',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        "  if (!sameOp(pass.op, op)) return 'op_mismatch';\n",
        '',
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['op_mismatch_refused', 'bootstrap_pass_not_accepted_as_create'],
    mustKill: ['op_mismatch_refused'],
  },
  {
    id: 'same_op_ignores_candidate',
    clause: 'C v1 §3 候选类 op 比较 (id, sha) 两项',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        'x.id === y.id && x.content_sha256 === y.content_sha256',
        'x.id === y.id',
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['opOfReq / sameOp:候选类比较 (id, sha) 两项'],
    mustKill: ['opOfReq / sameOp:候选类比较 (id, sha) 两项'],
  },
  {
    id: 'pass_reusable',
    clause: 'C v2 §4.2 一个 pass 至多服务一次写',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        '  const why = staleReason(pass, round, op, true);\n  voidPass(pass);\n',
        '  const why = staleReason(pass, round, op, true);\n',
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['合法一次消费;同一 pass 第二次'],
    mustKill: ['合法一次消费;同一 pass 第二次'],
  },
  {
    id: 'failure_does_not_void',
    clause: 'D v4 §3.2 抛 StaleGrowth 即作废',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        '  const why = staleReason(pass, round, op, true);\n  voidPass(pass);\n',
        '  const why = staleReason(pass, round, op, true);\n  if (why === null) voidPass(pass);\n',
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['失败也使 pass 作废'],
    mustKill: ['失败也使 pass 作废'],
  },
  {
    id: 'registry_not_checked',
    clause: 'C v2 §8.1 pass 只认本模块铸造(强转 / 展开拷贝 → not_minted)',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        "if (rec === undefined) return 'not_minted';",
        'if (rec === undefined) return null;',
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['强转 / 展开拷贝造出的 pass'],
    mustKill: ['强转 / 展开拷贝造出的 pass'],
  },
  {
    id: 'require_ignores_unsettled',
    clause: 'C v2 §4.2 回合未决 → 旧 pass 失效',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        "  if (round.unsettled().length > 0) return 'unsettled';\n",
        '',
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['铸造之后回合变未决'],
    mustKill: ['铸造之后回合变未决'],
  },
  {
    id: 'stage_unwired_not_checked',
    clause: 'C v2 §8.1 缺 stage / ops 缺项 → growth_unwired(最先)',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        "  if (!(ops instanceof Set) || !ops.has(snap.op)) return growthDenied('growth_unwired');\n",
        '',
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['growth_stage_missing_op_growth_unwired'],
    mustKill: ['growth_stage_missing_op_growth_unwired'],
  },
  {
    id: 'mint_allowed_in_flight',
    clause: 'C v2 §4.2 铸造要求 inFlight == 0',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        "  if (st.form !== 'both') throw new RoundInternalError('round_not_both');\n  if (st.inFlight !== 0) throw new RoundInternalError('mint_while_write_in_flight');\n",
        "  if (st.form !== 'both') throw new RoundInternalError('round_not_both');\n",
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['mint_allowed_in_flight 的反面'],
    mustKill: ['mint_allowed_in_flight 的反面'],
  },
  {
    id: 'rsi_only_round_accepted',
    clause: 'C v1 §3 evaluateGrowth 只接受 BothRound(运行期第二道)',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        "  if (st.form !== 'both') throw new RoundInternalError('round_not_both');\n",
        '',
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts', 'rsi/stage/c1-types.test.ts'],
    expectRed: ['① BothRound 与 RsiOnlyRound 互不可赋值'],
    mustKill: ['① BothRound 与 RsiOnlyRound 互不可赋值'],
  },
  {
    id: 'gen_change_during_evaluate_ignored',
    clause: 'C v2 §4.2 评估期间有写 = 事实过时',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        "  if (st.gen !== genAtStart) throw new RoundInternalError('write_during_evaluate');\n",
        '',
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['评估期间发生了写(事实已过时)'],
    mustKill: ['评估期间发生了写(事实已过时)'],
  },
  {
    id: 'unsettled_not_checked_before_readers',
    clause: 'C v2 §4.2 未决轮拒绝增影响',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        "  if (pre !== null) return growthDenied(pre);\n  if (st.unsettled.length > 0) return growthDenied('unsettled');\n",
        '  if (pre !== null) return growthDenied(pre);\n',
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['本轮未决 → unsettled'],
    mustKill: ['本轮未决 → unsettled'],
  },
  {
    id: 'source_unknown_not_checked',
    clause: 'C v1 §6 来源缺失一律拒绝增影响',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        "        if (c.source === null || c.source === undefined) return 'source_unknown';\n",
        '',
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['来源缺失一律拒绝增影响'],
    mustKill: ['来源缺失一律拒绝增影响'],
  },
  {
    id: 'candidate_create_checks_g11',
    clause: 'D v4 §3.3 G11 不对候选创建生效',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        "    G9: 'implied',\n    G10: 'on',\n    G11: 'off',",
        "    G9: 'implied',\n    G10: 'on',\n    G11: 'versions',",
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['candidate_create_not_denied_by_admission', '按 op 的检查子集表(D v4 §3.3)'],
    mustKill: ['candidate_create_not_denied_by_admission'],
  },
  {
    id: 'op_subset_table_skips_g3_for_create',
    clause: 'D v4 §3.3 创建按 G3 全部(含暂停)',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        "    G2: 'on',\n    G3: 'full',\n    G4: 'on',\n    G5: 'on',\n    G6: 'rescan',",
        "    G2: 'on',\n    G3: 'valid_only',\n    G4: 'on',\n    G5: 'on',\n    G6: 'rescan',",
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['暂停:bootstrap 不看暂停', '按 op 的检查子集表(D v4 §3.3)'],
    mustKill: ['暂停:bootstrap 不看暂停'],
  },
  {
    id: 'bootstrap_checks_repo',
    clause: 'D v4 §3.3 bootstrap 不要求 G4(解启动环)',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        "    G3: 'valid_only',\n    G4: 'off',",
        "    G3: 'valid_only',\n    G4: 'on',",
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['按 op 的检查子集表(D v4 §3.3)', 'bootstrap 不看 G4'],
    mustKill: ['按 op 的检查子集表(D v4 §3.3)'],
  },
  {
    id: 'admission_op_checks_candidate_items',
    clause: 'D v4 §3.3 admission 不含候选项(消除自依赖)',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        "    G5: 'on',\n    G6: 'off',\n    G7: 'on',\n    G8: 'off',\n    G9: 'on',\n    G10: 'on',\n    G11: 'off',\n    extra: 'off',",
        "    G5: 'on',\n    G6: 'cand',\n    G7: 'on',\n    G8: 'off',\n    G9: 'on',\n    G10: 'on',\n    G11: 'off',\n    extra: 'off',",
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['按 op 的检查子集表(D v4 §3.3)'],
    mustKill: ['按 op 的检查子集表(D v4 §3.3)'],
  },
  {
    id: 'shadow_requires_effective_admission',
    clause: 'D v4 §3.3 shadow_to_canary 的 G11 仅要求能力已装配',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        "    G10: 'on',\n    G11: 'wired_only',",
        "    G10: 'on',\n    G11: 'versions',",
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['G11:shadow_to_canary 只要「能力已装配」'],
    mustKill: ['G11:shadow_to_canary 只要「能力已装配」'],
  },
  {
    id: 'judge_latch_ignored',
    clause: 'W9 §4 S2 的 blocked latch 并入 G8',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        '      if (latched !== null) return latched; // S2 的 blocked latch 并入(单调只加严)\n',
        '',
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['S2 的 blocked latch 并入 G8'],
    mustKill: ['S2 的 blocked latch 并入 G8'],
  },
  {
    id: 'judge_invalid_value_passes',
    clause: 'W9 §4 非法值 = judge_indeterminate',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        "if (v === null) return 'judge_indeterminate';",
        'if (v === null) return null;',
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['judge reader 返回非法值'],
    mustKill: ['judge reader 返回非法值'],
  },
  {
    id: 'reader_failure_passes',
    clause: 'C v1 §8 读失败绝不放行',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        '      code = denyFromThrown(e, s.id);',
        '      code = null;',
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['抛普通错 →'],
    mustKill: ['抛普通错 →'],
  },
  {
    id: 'rsi_lost_swallowed',
    clause: 'C v1 §2 rsi lock_lost 上抛(evaluateGrowth 不吞)',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        "  if (isRsiLockLost(e)) throw e;\n  return id === 'G10'",
        "  return id === 'G10'",
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['个人失锁(PersonalLockLost)→ lock_lost;rsi 失锁 → 原样上抛'],
    mustKill: ['个人失锁(PersonalLockLost)→ lock_lost;rsi 失锁 → 原样上抛'],
  },
  {
    id: 'post_lock_check_skipped',
    clause: 'C v1 §3 G10 两锁 assertHeld 前后各一次',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        "  const post = profile.G10 === 'on' ? await lockCheck() : null;",
        '  const post = null;',
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['G10 前置 / 后置'],
    mustKill: ['G10 前置 / 后置'],
  },
  {
    id: 'veto_not_read',
    clause: 'C v2 §8.1 消费前现读外部否决事实',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        'v = await readers.externalVeto(round, pass.op);',
        'v = { vetoed: false };',
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['铸造 pass 后出现 B/U / 暂停 / 凭据命中 → vetoed 且 pass 作废'],
    mustKill: ['铸造 pass 后出现 B/U / 暂停 / 凭据命中 → vetoed 且 pass 作废'],
  },
  {
    id: 'vetoed_not_refused',
    clause: 'C v2 §8.1 否决事实命中 → 拒绝并作废',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        "    throw new StaleGrowth('vetoed');",
        '    return;',
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['铸造 pass 后出现 B/U / 暂停 / 凭据命中 → vetoed 且 pass 作废'],
    mustKill: ['铸造 pass 后出现 B/U / 暂停 / 凭据命中 → vetoed 且 pass 作废'],
  },
  {
    id: 'veto_read_failure_ignored',
    clause: 'C v2 §8.1 否决事实读不出 = 拒绝',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        "      if (e instanceof PersonalLockLost || isRsiLockLost(e)) throw e;\n      throw new StaleGrowth('veto_unreadable');",
        '      if (e instanceof PersonalLockLost || isRsiLockLost(e)) throw e;\n      v = { vetoed: false };',
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['读不出(抛错 / 非法值)→ veto_unreadable 且作废'],
    mustKill: ['读不出(抛错 / 非法值)→ veto_unreadable 且作废'],
  },
  {
    id: 'deny_codes_dropped',
    clause: 'D v4 b5 三个新 GrowthDeny 码并入 C1 冻结',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        "  'near_fp_unavailable',\n  'fp_key_unavailable',\n  'creation_unready',\n] as const);",
        "  'near_fp_unavailable',\n  'creation_unready',\n] as const);",
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['GrowthDeny 全集与顺序'],
    mustKill: ['GrowthDeny 全集与顺序'],
  },
  {
    id: 'sweep_clears_dirty_after',
    clause: 'C v2 §4.3 takeAll 在执行前清零',
    edits: [
      swap(
        'src/rsi/personal/stage/settle.ts',
        'const snapshot = st.takeDirty(); // 此刻清零(先于任何扫尾调用)',
        'const snapshot = [...st.dirty]; // mutated: 执行后才清',
      ),
    ],
    tests: ['rsi/stage/c1-settle.test.ts'],
    expectRed: ['sweep_clears_dirty_before_run_and_does_not_reloop', 'sweep_runs_at_most_once'],
    mustKill: ['sweep_clears_dirty_before_run_and_does_not_reloop'],
  },
  {
    id: 'sweep_verify_ignored',
    clause: 'C v2 §4.3 核验失败 → unsettled',
    edits: [
      swap(
        'src/rsi/personal/stage/settle.ts',
        "if (results.length === 3 && results.every((r) => r === 'ok') && faults.length === 0) {",
        'if (results.length === 3) {',
      ),
    ],
    tests: ['rsi/stage/c1-settle.test.ts'],
    expectRed: ['sweep_verify_fails_unsettled', 'sweep_state_write_fails_still_mutes_no_reloop'],
    mustKill: ['sweep_verify_fails_unsettled'],
  },
  {
    id: 'dirty_not_restored_on_failure',
    clause: 'C v2 §4.3 失败时 safetyDirty 保持置位',
    edits: [
      swap(
        'src/rsi/personal/stage/settle.ts',
        '  st.restoreDirty(snapshot); // safetyDirty 保持置位\n',
        '',
      ),
    ],
    tests: ['rsi/stage/c1-settle.test.ts'],
    expectRed: ['sweep_verify_fails_unsettled'],
    mustKill: ['sweep_verify_fails_unsettled'],
  },
  {
    id: 'sweep_swallows_rsi_lost',
    clause: 'C v1 §2 扫尾遇 rsi lock_lost 上抛',
    edits: [
      swap(
        'src/rsi/personal/stage/settle.ts',
        "      if (c.kind === 'rethrow') return { rethrow: e };\n",
        '',
      ),
    ],
    tests: ['rsi/stage/c1-settle.test.ts'],
    expectRed: ['rsi 锁丢失(RsiLockError lock_lost)→ 原样上抛'],
    mustKill: ['rsi 锁丢失(RsiLockError lock_lost)→ 原样上抛'],
  },
  {
    id: 'sweeping_flag_not_set',
    clause: 'C v2 §4.3 扫尾自己的写不再置脏',
    edits: [swap('src/rsi/personal/stage/settle.ts', '  st.sweeping = true;\n', '')],
    tests: ['rsi/stage/c1-settle.test.ts'],
    expectRed: ['扫尾自己的写不再置脏'],
    mustKill: ['扫尾自己的写不再置脏'],
  },
  {
    id: 'sweep_stops_after_first_failure',
    clause: 'C v2 §4.3 固定顺序、各一次、尽力(失败不挡后面)',
    edits: [
      swap(
        'src/rsi/personal/stage/settle.ts',
        "    if (!results.some((r) => typeof r === 'object')) {\n      results.push(\n        await attempt('reconcileCaches'",
        "    if (results.every((r) => r === 'ok')) {\n      results.push(\n        await attempt('reconcileCaches'",
      ),
    ],
    tests: ['rsi/stage/c1-settle.test.ts'],
    expectRed: ['sweep_state_write_fails_still_mutes_no_reloop'],
    mustKill: ['sweep_state_write_fails_still_mutes_no_reloop'],
  },
  {
    id: 'budget_not_enforced',
    clause: 'C v2 §4.3 RoundBudget 超限 = internal 故障',
    edits: [
      swap(
        'src/rsi/personal/stage/settle.ts',
        'if (counts[port] >= limits[port]) {',
        'if (false) {',
      ),
    ],
    tests: ['rsi/stage/c1-round.test.ts', 'rsi/stage/c1-settle.test.ts'],
    expectRed: ['port_call_budget_exceeded_is_fault'],
    mustKill: ['port_call_budget_exceeded_is_fault'],
  },
  {
    id: 'budget_limit_not_required',
    clause: 'C1a 任务:startRollback 上限必填,缺则拒绝构造(fail-closed)',
    edits: [
      swap(
        'src/rsi/personal/stage/settle.ts',
        "if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {",
        'if (false) {',
      ),
    ],
    tests: ['rsi/stage/c1-round.test.ts'],
    expectRed: ['持两锁的回合没给 startRollbackLimit'],
    mustKill: ['持两锁的回合没给 startRollbackLimit'],
  },
  {
    id: 'budget_busy_allows_release',
    clause: 'C v2 §4.3 忙轮没有自动解除',
    edits: [
      swap(
        'src/rsi/personal/stage/settle.ts',
        '    setFlagAndMute: 0,\n    tripAndMute: 1,\n    reconcileCaches: 2,\n    applyAutoRelease: 0,',
        '    setFlagAndMute: 0,\n    tripAndMute: 1,\n    reconcileCaches: 2,\n    applyAutoRelease: 1,',
      ),
    ],
    tests: ['rsi/stage/c1-round.test.ts'],
    expectRed: ['busy_round_has_no_release', '上限表:持两锁 / 忙'],
    mustKill: ['busy_round_has_no_release'],
  },
  {
    id: 'budget_exceed_not_unsettled',
    clause: 'C v2 §4.3 超限使本轮未决',
    edits: [
      swap(
        'src/rsi/personal/stage/settle.ts',
        '        markRoundUnsettled(round, `budget_exceeded:${port}`);\n',
        '',
      ),
    ],
    tests: ['rsi/stage/c1-round.test.ts'],
    expectRed: ['port_call_budget_exceeded_is_fault'],
    mustKill: ['port_call_budget_exceeded_is_fault'],
  },
  {
    id: 'fallback_called_on_lock_lost',
    clause: 'C v2 §2 原异常为 rsi lock_lost 不调兜底',
    edits: [
      swap(
        'src/rsi/personal/stage/fallback.ts',
        "  if (isRsiLockLost(input.original)) return 'rsi_lock_lost';\n",
        '',
      ),
    ],
    tests: ['rsi/stage/c1-fallback.test.ts'],
    expectRed: ['原异常是 rsi lock_lost → rsi_lock_lost(优先于其余'],
    mustKill: ['原异常是 rsi lock_lost → rsi_lock_lost(优先于其余'],
  },
  {
    id: 'fallback_not_guarded',
    clause: 'C v2 §2 零写入五类不调兜底',
    edits: [
      swap(
        'src/rsi/personal/stage/fallback.ts',
        "  if (SKIP_SET.has(input.outcome)) return 'unrecordable_outcome';\n",
        '',
      ),
    ],
    tests: ['rsi/stage/c1-fallback.test.ts'],
    expectRed: ['零写入类 outcome'],
    mustKill: ['零写入类 outcome'],
  },
  {
    id: 'fallback_second_call',
    clause: 'C v2 §2 单飞:二次错误不递归',
    edits: [
      swap(
        'src/rsi/personal/stage/fallback.ts',
        '  if (track.fallbackTried) return track.pending ?? track.fb;\n',
        '',
      ),
      swap(
        'src/rsi/personal/stage/fallback.ts',
        "  if (input.track.fallbackTried) return 'already_tried';\n",
        '',
      ),
    ],
    tests: ['rsi/stage/c1-fallback.test.ts'],
    expectRed: ['fallback_single_shot_after_p_contract_violation'],
    mustKill: ['fallback_single_shot_after_p_contract_violation'],
  },
  {
    id: 'fallback_skip_already_tried_dropped',
    clause: 'C v2 §2 单飞(纯判定表)',
    edits: [
      swap(
        'src/rsi/personal/stage/fallback.ts',
        "  if (input.track.fallbackTried) return 'already_tried';\n",
        '',
      ),
    ],
    tests: ['rsi/stage/c1-fallback.test.ts'],
    expectRed: ['pCompleted / fallbackTried / 无 stage / 无资格 / eligible 抛错'],
    mustKill: ['pCompleted / fallbackTried / 无 stage / 无资格 / eligible 抛错'],
  },
  {
    id: 'fallback_concurrent_returns_early',
    clause: 'C v2 §2 并发入口等同一个进行中的结果',
    edits: [
      swap(
        'src/rsi/personal/stage/fallback.ts',
        '  if (track.fallbackTried) return track.pending ?? track.fb;',
        '  if (track.fallbackTried) return track.fb;',
      ),
    ],
    tests: ['rsi/stage/c1-fallback.test.ts'],
    expectRed: ['fallback_concurrent_entries_share_in_flight_result'],
    mustKill: ['fallback_concurrent_entries_share_in_flight_result'],
  },
  {
    id: 'fallback_not_marked_tried',
    clause: 'C v2 §2 失败的兜底也算已调用',
    edits: [swap('src/rsi/personal/stage/fallback.ts', '  track.fallbackTried = true;\n', '')],
    tests: ['rsi/stage/c1-fallback.test.ts'],
    expectRed: ['失败的兜底也算已调用', 'fallback_single_shot_after_p_contract_violation'],
    mustKill: ['失败的兜底也算已调用'],
  },
  {
    id: 'fallback_outcome_overrides_original',
    clause: 'C v2 §2 原异常的 outcome 永不被兜底替换',
    edits: [
      swap(
        'src/rsi/personal/stage/fallback.ts',
        '  return { outcome, callFinish: true, logCode: fb === null ? null : fallbackLogCode(fb) };',
        "  return {\n    outcome: fb === null ? outcome : 'internal',\n    callFinish: true,\n    logCode: fb === null ? null : fallbackLogCode(fb),\n  };",
      ),
    ],
    tests: ['rsi/stage/c1-fallback.test.ts'],
    expectRed: ['recover_eio_fallback_eio_preserves_original_outcome'],
    mustKill: ['recover_eio_fallback_eio_preserves_original_outcome'],
  },
  {
    id: 'aborted_still_calls_finish',
    clause: 'C v2 §2 兜底失锁 → 不调 finish、零后续写入',
    edits: [
      swap(
        'src/rsi/personal/stage/fallback.ts',
        'return { outcome, callFinish: false, logCode: null };',
        'return { outcome, callFinish: true, logCode: null };',
      ),
    ],
    tests: ['rsi/stage/c1-fallback.test.ts'],
    expectRed: ['aborted_still_calls_finish 的反面'],
    mustKill: ['aborted_still_calls_finish 的反面'],
  },
  {
    id: 'fallback_lock_lost_not_aborted',
    clause: 'C v2 §2 兜底抛 rsi lock_lost → aborted',
    edits: [
      swap(
        'src/rsi/personal/stage/fallback.ts',
        '    report = isRsiLockLost(e)\n',
        '    report = false\n',
      ),
    ],
    tests: ['rsi/stage/c1-fallback.test.ts'],
    expectRed: ['fallback_never_throws'],
    mustKill: ['fallback_never_throws'],
  },
  {
    id: 'fallback_eligible_throw_runs',
    clause: 'C v2 §1 相位资格读不出 = 不进',
    edits: [
      swap(
        'src/rsi/personal/stage/fallback.ts',
        '    eligible = false; // 相位资格读不出 = 不进(fail-closed:不在不确定时写)',
        '    eligible = true;',
      ),
    ],
    tests: ['rsi/stage/c1-fallback.test.ts'],
    expectRed: ['pCompleted / fallbackTried / 无 stage / 无资格 / eligible 抛错'],
    mustKill: ['pCompleted / fallbackTried / 无 stage / 无资格 / eligible 抛错'],
  },
  {
    id: 'fallback_ineligible_ignored',
    clause: 'C v2 §1 相位 < V1a 两处都不进',
    edits: [
      swap(
        'src/rsi/personal/stage/fallback.ts',
        "  return eligible ? null : 'ineligible';",
        '  return null;',
      ),
    ],
    tests: ['rsi/stage/c1-fallback.test.ts'],
    expectRed: ['pCompleted / fallbackTried / 无 stage / 无资格 / eligible 抛错'],
    mustKill: ['pCompleted / fallbackTried / 无 stage / 无资格 / eligible 抛错'],
  },
  {
    id: 'fallback_log_code_wrong',
    clause: 'C v2 §2 日志码 safety_fallback_<kind>',
    edits: [
      swap(
        'src/rsi/personal/stage/fallback.ts',
        '  return `safety_fallback_${r.kind}`;',
        '  return `fallback_${r.kind}`;',
      ),
    ],
    tests: ['rsi/stage/c1-fallback.test.ts'],
    expectRed: ['日志码 safety_fallback_<kind>'],
    mustKill: ['日志码 safety_fallback_<kind>'],
  },
  {
    id: 'unavailable_check_passes',
    clause: 'W9 §4 缺能力 = 拒绝,绝不缺省为通过',
    edits: [
      swap(
        'src/rsi/personal/judge-slot.ts',
        "          : { ok: false, code: 'judge_unavailable' },",
        '          : { ok: true },',
      ),
    ],
    tests: ['rsi/stage/c1-judge-slot.test.ts'],
    expectRed: ['check:带来源 → {ok:false, judge_unavailable}'],
    mustKill: ['check:带来源 → {ok:false, judge_unavailable}'],
  },
  {
    id: 'unavailable_run_reports_available',
    clause: 'W9 §4 默认 run 报告 unavailable',
    edits: [
      swap(
        'src/rsi/personal/judge-slot.ts',
        '  halted: null,\n  unavailable: true,\n});',
        '  halted: null,\n  unavailable: false,\n});',
      ),
    ],
    tests: ['rsi/stage/c1-judge-slot.test.ts'],
    expectRed: ['run:空报告 + unavailable=true'],
    mustKill: ['run:空报告 + unavailable=true'],
  },
  {
    id: 'check_throw_passes',
    clause: 'W9 §4 check 抛错 = judge_indeterminate',
    edits: [
      swap(
        'src/rsi/personal/judge-slot.ts',
        "  } catch {\n    return { ok: false, code: 'judge_indeterminate' };",
        '  } catch {\n    return { ok: true };',
      ),
    ],
    tests: ['rsi/stage/c1-judge-slot.test.ts'],
    expectRed: ['check 抛错(异步 / 同步 / 非 Error)→ judge_indeterminate'],
    mustKill: ['check 抛错(异步 / 同步 / 非 Error)→ judge_indeterminate'],
  },
  {
    id: 'check_invalid_value_passes',
    clause: 'W9 §4 非法值 = judge_indeterminate',
    edits: [
      swap(
        'src/rsi/personal/judge-slot.ts',
        "    return normalizeJudgeVerdict(r) ?? { ok: false, code: 'judge_indeterminate' };",
        '    return r as JudgeGrowthVerdict;',
      ),
    ],
    tests: ['rsi/stage/c1-judge-slot.test.ts'],
    expectRed: ['返回非法值(枚举外的码'],
    mustKill: ['返回非法值(枚举外的码'],
  },
  {
    id: 'check_missing_slot_passes',
    clause: 'W9 §4 未装配 = 拒绝',
    edits: [
      swap(
        'src/rsi/personal/judge-slot.ts',
        "typeof slot.check !== 'function') {\n    return { ok: false, code: 'judge_unavailable' };",
        "typeof slot.check !== 'function') {\n    return { ok: true };",
      ),
    ],
    tests: ['rsi/stage/c1-judge-slot.test.ts'],
    expectRed: ['槽缺失 / 无 check 方法(未装配)→ judge_unavailable'],
    mustKill: ['槽缺失 / 无 check 方法(未装配)→ judge_unavailable'],
  },
  {
    id: 'verdict_unknown_code_accepted',
    clause: 'W9 §4 拒绝码严格枚举',
    edits: [
      swap(
        'src/rsi/personal/judge-slot.ts',
        "if (o.ok === false && typeof o.code === 'string' && DENY_SET.has(o.code)) {",
        "if (o.ok === false && typeof o.code === 'string') {",
      ),
    ],
    tests: ['rsi/stage/c1-judge-slot.test.ts'],
    expectRed: ['normalizeJudgeVerdict:ok:true 带多余字段也只取 {ok:true};拒绝码严格枚举'],
    mustKill: ['normalizeJudgeVerdict:ok:true 带多余字段也只取 {ok:true};拒绝码严格枚举'],
  },
  {
    id: 'monitor_count_threshold_changed',
    clause: 'C v2 §3.3 阈值冻结:连续 ≥ 3 条',
    edits: [
      swap(
        'src/rsi/personal/stage/monitoring.ts',
        'skippedLockedMinCount: 3,',
        'skippedLockedMinCount: 2,',
      ),
    ],
    tests: ['rsi/stage/c1-freeze.test.ts'],
    expectRed: ['阈值 3 条 / 30 分钟 / 24 小时;四个信号逐个钉死'],
    mustKill: ['阈值 3 条 / 30 分钟 / 24 小时;四个信号逐个钉死'],
  },
  {
    id: 'monitor_age_threshold_changed',
    clause: 'C v2 §3.3 阈值冻结:24 小时',
    edits: [
      swap(
        'src/rsi/personal/stage/monitoring.ts',
        'lastTickMaxAgeMs: 24 * 60 * 60 * 1000,',
        'lastTickMaxAgeMs: 12 * 60 * 60 * 1000,',
      ),
    ],
    tests: ['rsi/stage/c1-freeze.test.ts'],
    expectRed: ['阈值 3 条 / 30 分钟 / 24 小时;四个信号逐个钉死'],
    mustKill: ['阈值 3 条 / 30 分钟 / 24 小时;四个信号逐个钉死'],
  },
  {
    id: 'dirty_kinds_includes_audit',
    clause: 'C v2 §4.1 审计补行不置脏',
    edits: [
      swap(
        'src/rsi/personal/stage/types.ts',
        "  'trip',\n] as const satisfies readonly WriteKind[]);",
        "  'trip',\n  'audit_append',\n] as const satisfies readonly WriteKind[]);",
      ),
    ],
    tests: ['rsi/stage/c1-round.test.ts'],
    expectRed: ['DIRTY_KINDS 是 WRITE_KINDS 的子集,且恰为四类', '写 → 不置脏'],
    mustKill: ['DIRTY_KINDS 是 WRITE_KINDS 的子集,且恰为四类'],
  },
  {
    id: 'skip_outcomes_dropped',
    clause: 'C v2 §2 兜底跳过集合 = worker UNRECORDABLE',
    edits: [
      swap(
        'src/rsi/personal/stage/types.ts',
        "  'snapshot_invalid',\n] as const satisfies readonly RsiOutcome[]);",
        '] as const satisfies readonly RsiOutcome[]);',
      ),
    ],
    tests: ['rsi/stage/c1-fallback.test.ts'],
    expectRed: ['FALLBACK_SKIP_OUTCOMES 与 worker.ts 的 UNRECORDABLE 逐项相等'],
    mustKill: ['FALLBACK_SKIP_OUTCOMES 与 worker.ts 的 UNRECORDABLE 逐项相等'],
  },
  {
    id: 'require_skips_veto_mark',
    clause: 'C v2 §8.1 消费前必须现读外部否决事实(同步入口不可绕过)',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        "  if (needVetoMark && rec.vetoClearAtGen !== round.gen()) return 'veto_not_checked';\n",
        '',
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['require_without_veto_check_refused'],
    mustKill: ['require_without_veto_check_refused'],
  },
  {
    id: 'veto_mark_not_recorded',
    clause: 'C v2 §8.1 现读通过才记标记',
    edits: [swap('src/rsi/personal/stage/growth.ts', '  rec.vetoClearAtGen = round.gen();\n', '')],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['无否决 → 记录现读通过;读到的 pass 仍只能消费一次'],
    mustKill: ['无否决 → 记录现读通过;读到的 pass 仍只能消费一次'],
  },
  {
    id: 'request_not_snapshotted',
    clause: 'Pi1 P1-3 检查对象与获准对象不可分叉',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        '  const snap = snapshotReq(req);\n',
        '  const snap = req;\n',
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['评估期间调用方改写原请求对象'],
    mustKill: ['评估期间调用方改写原请求对象'],
  },
  {
    id: 'g6_bool_unchecked',
    clause: 'Pi1 P2-5 G6 对畸形事实 fail-closed',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        "if (typeof f.rescanRequired !== 'boolean' || typeof f.rescanned !== 'boolean') {",
        'if (false) {',
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['G6 事实非布尔 / 缺键 / 非法枚举'],
    mustKill: ['G6 事实非布尔 / 缺键 / 非法枚举'],
  },
  {
    id: 'sweep_not_once_per_round',
    clause: 'Pi1 P2-4 每轮至多真正扫尾一次(状态在回合上)',
    edits: [
      swap(
        'src/rsi/personal/stage/settle.ts',
        '  const prev = sweeps.get(round);\n',
        '  const prev = undefined as SweepRecord | undefined;\n',
      ),
    ],
    tests: ['rsi/stage/c1-settle.test.ts'],
    expectRed: ['settle_once_per_round_failure_not_retried'],
    mustKill: ['settle_once_per_round_failure_not_retried'],
  },
  {
    id: 'sweep_concurrent_returns_settled',
    clause: 'Pi1 P2-4 进行中再调用等同一个结果',
    edits: [
      swap('src/rsi/personal/stage/settle.ts', '    if (o === null) return prev.running;\n', ''),
    ],
    tests: ['rsi/stage/c1-settle.test.ts'],
    expectRed: ['settle_concurrent_call_shares_in_flight_result'],
    mustKill: ['settle_concurrent_call_shares_in_flight_result'],
  },
  {
    id: 'veto_reader_gets_caller_op',
    clause: 'Pi2 F1 现读的对象是冻结的 pass.op(不是调用方的可变参数)',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        'v = await readers.externalVeto(round, pass.op);',
        'v = await readers.externalVeto(round, op);',
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['veto_reader_gets_frozen_pass_op'],
    mustKill: ['veto_reader_gets_frozen_pass_op'],
  },
  {
    id: 'veto_mark_not_cleared_on_recheck',
    clause: 'Pi2 F1 重新现读先撤销旧标记',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        '  rec.vetoClearAtGen = null; // 重新现读先撤销旧标记:检查进行期间不可消费\n',
        '',
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['veto_recheck_invalidates_old_mark'],
    mustKill: ['veto_recheck_invalidates_old_mark'],
  },
  {
    id: 'veto_check_concurrent_allowed',
    clause: 'Pi2 F1 并发现读 = 误用,作废',
    edits: [swap('src/rsi/personal/stage/growth.ts', '  if (rec.checking) {', '  if (false) {')],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['veto_check_in_flight:并发的两次现读'],
    mustKill: ['veto_check_in_flight:并发的两次现读'],
  },
  {
    id: 'veto_late_stale_not_checked',
    clause: 'Pi2 F1 发布标记前重新校验(读期间 gen 变了不盖章)',
    edits: [
      swap(
        'src/rsi/personal/stage/growth.ts',
        '    const late = staleReason(pass, round, pass.op, false);\n    if (late !== null) {\n      voidPass(pass);\n      throw new StaleGrowth(late);\n    }\n',
        '',
      ),
    ],
    tests: ['rsi/stage/c1-growth.test.ts'],
    expectRed: ['现读期间发生了写 → 消费时 gen_changed'],
    mustKill: ['现读期间发生了写 → 消费时 gen_changed'],
  },
  {
    id: 'sweep_rejection_downgraded',
    clause: 'Pi2 F2 rsi 失锁的 rejection 是终态,之后调用不降级',
    edits: [
      swap(
        'src/rsi/personal/stage/settle.ts',
        "    if (o.kind === 'rejected') return Promise.reject(o.error);\n",
        '',
      ),
    ],
    tests: ['rsi/stage/c1-settle.test.ts'],
    expectRed: ['settle_rejection_is_terminal'],
    mustKill: ['settle_rejection_is_terminal'],
  },
  {
    id: 'sweep_registered_after_start',
    clause: 'Pi2 F4 先登记共享 Promise 再启动扫尾',
    edits: [
      swap(
        'src/rsi/personal/stage/settle.ts',
        '  sweeps.set(round, rec);\n  void sweepOnce(',
        '  void sweepOnce(',
      ),
      swap(
        'src/rsi/personal/stage/settle.ts',
        '  return running;\n}\n',
        '  sweeps.set(round, rec);\n  return running;\n}\n',
      ),
    ],
    tests: ['rsi/stage/c1-settle.test.ts'],
    expectRed: ['settle_sync_prefix_reentry_shares_final_result'],
    mustKill: ['settle_sync_prefix_reentry_shares_final_result'],
  },
  {
    id: 'fallback_pending_published_late',
    clause: 'Pi2 F3 先发布共享 Promise 再执行兜底',
    edits: [
      swap(
        'src/rsi/personal/stage/fallback.ts',
        '  track.pending = new Promise<FallbackReport | null>((resolve) => {\n    publish = resolve;\n  });\n',
        '  publish = () => undefined;\n',
      ),
    ],
    tests: ['rsi/stage/c1-fallback.test.ts'],
    expectRed: ['fallback_reentry_from_sync_prefix_sees_pending'],
    mustKill: ['fallback_reentry_from_sync_prefix_sees_pending'],
  },
];

/** 由主代理整表执行变异后回填 */
export const V1_ASM_C1A_RESULTS: readonly V1AsmC1aResult[] = [];
