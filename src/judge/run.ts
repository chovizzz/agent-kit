/**
 * judge 核心:对一个 run 里的每条提案,按固定兜底链(JUDGE_HOP_CHAIN)逐跳评审。
 *
 * - 后端一律经依赖注入(`JudgeBackends`),本模块不 import 任何后端/llm-exec。
 * - 同厂商(归一化后相等)的跳**不调用**,记 skipped:same-vendor;厂商不可证明不同(unknown/非内置)
 *   的跳同样不调用,记 error:vendor_unknown。
 * - 一跳成功 → 写 `judge` 并删除 `judge_attempts`;全链无成功 → 不写 `judge`,写记满整条链的 `judge_attempts`。
 * - judge **永远不改**提案的其它字段(状态转移只走 promote/retire 的人批 PR)。
 */
import { JUDGE_HOP_CHAIN } from '../contracts/proposal.js';
import type { JudgeHopId, JudgeOutput, Proposal } from '../contracts/proposal.js';
import type { Redactor } from '../contracts/redact.js';
import { deriveVendor, isCrossVendor } from '../contracts/vendor.js';
import type { IoContext } from '../io/paths.js';
import { assertWritable } from '../io/safe-fs.js';
import { ruleSha256 } from '../lifecycle/checks.js';
import type { LlmBackend } from '../reflect/backend-iface.js';
import { JudgeProviderMismatchError, JudgeStateError } from './errors.js';
import { parseJudgeOutput } from './output.js';
import { buildJudgePrompt } from './prompt/v1.js';
import type { JudgePrompt } from './prompt/v1.js';
import {
  SAFE_STORE_FS,
  applyJudgeFields,
  loadKnownAtomIds,
  loadRun,
  serializeProposal,
  writeProposal,
} from './store.js';
import type { LoadedProposal, StoreFs } from './store.js';

export type JudgeBackends = Readonly<Partial<Record<JudgeHopId, LlmBackend>>>;

export type PendingReason = 'no_cross_vendor' | 'all_failed' | 'cooldown';

export interface JudgeDeps {
  readonly io: IoContext;
  readonly redactor: Pick<Redactor, 'pass2'>;
  readonly backends: JudgeBackends;
  /** 测试注入点:默认 safe-fs */
  readonly storeFs?: StoreFs;
  /** 每处理完一条提案回调一次(命令层据此在中途失败时仍能输出已完成部分) */
  readonly onOutcome?: (o: ProposalOutcome) => void;
}

export interface JudgeOptions {
  readonly runId: string;
  /** 干跑:不调用后端、不写文件 */
  readonly dry: boolean;
  /** 本次运行内 `complete` 调用次数上限 */
  readonly maxCalls: number;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export const DEFAULT_JUDGE_TIMEOUT_MS = 120_000;
export const DEFAULT_JUDGE_MAX_OUTPUT_BYTES = 16 * 1024;

export interface HopRecord {
  readonly hop: JudgeHopId;
  readonly vendor: string;
  readonly model: string;
  readonly result: string;
}

export type ProposalStatus =
  | 'judged' // 写了 judge
  | 'pending' // 写了 judge_attempts(或干跑以外的相同内容无需重写)
  | 'already_judged' // 已有 judge,未处理
  | 'planned' // 干跑
  | 'not_run'; // 预算耗尽前未开始

export interface ProposalOutcome {
  readonly proposalId: string;
  readonly status: ProposalStatus;
  readonly hops: readonly HopRecord[];
  readonly verdict?: 'accept' | 'revise' | 'reject';
  readonly injectionSuspected?: boolean;
  readonly pending?: PendingReason;
  /** 本提案是否发生过「输出校验失败」(退出码 1 的依据之一) */
  readonly invalidOutput: boolean;
  /** 链上是否有跳因厂商不可证明而未被调用(没评上时命令退出 3) */
  readonly vendorUnknown: boolean;
  readonly wrote: boolean;
}

export interface JudgeReport {
  readonly runId: string;
  readonly dry: boolean;
  readonly callsMade: number;
  readonly callsLimit: number;
  readonly budgetExhausted: boolean;
  readonly outcomes: readonly ProposalOutcome[];
}

const UNCONFIGURED = { vendor: 'unknown', model: '-' } as const;
const norm = (v: string): string => v.trim().toLowerCase();

/** `judge.provider` 必须等于成功那一跳的槽位 id(设计 §⑧ 第 8 条);不一致抛错。不改 schema。 */
export function assertJudgeProvider(provider: string, lastHop: string): void {
  if (provider !== lastHop) {
    throw new JudgeProviderMismatchError(
      'JUDGE_PROVIDER_MISMATCH: judge.provider 与成功那一跳的槽位 id 不一致',
    );
  }
}

function prefixOk(hops: readonly { hop: string }[]): boolean {
  return hops.every((h, i) => h.hop === JUDGE_HOP_CHAIN[i]);
}

/** 已有 judge 的记录必须自洽:provider = 最后一跳、跨厂商可证明。 */
function assertExistingJudge(p: Proposal): void {
  const j = p.judge;
  if (!j) return;
  const last = j.hops[j.hops.length - 1];
  if (!last || !prefixOk(j.hops))
    throw new JudgeStateError('JUDGE_STATE_INVALID: 既有 judge 的链不合法');
  assertJudgeProvider(j.provider, last.hop);
  if (!isCrossVendor(p.reflector.vendor, j.vendor)) {
    throw new JudgeStateError('JUDGE_STATE_INVALID: 既有 judge 不是可证明的跨厂商评审');
  }
}

function pendingReason(hops: readonly HopRecord[]): PendingReason {
  let cooldown = false;
  for (const h of hops) {
    if (h.result === 'skipped:cooldown') cooldown = true;
    else if (
      h.result !== 'skipped:same-vendor' &&
      h.result !== 'error:vendor_unknown' &&
      h.result !== 'error:not_configured'
    ) {
      return 'all_failed';
    }
  }
  return cooldown ? 'cooldown' : 'no_cross_vendor';
}

interface Prepared {
  readonly loaded: LoadedProposal;
  readonly prompt: JudgePrompt | undefined;
}

/** 调用前:校验后端表、读取全部提案、为每条建提示(任何一步失败 → 抛错,零调用零写入)。 */
async function prepare(deps: JudgeDeps, opts: JudgeOptions): Promise<Prepared[]> {
  for (const hop of JUDGE_HOP_CHAIN) {
    const b = deps.backends[hop];
    if (!b) continue;
    assertJudgeProvider(b.slot, hop);
    if (b.vendor.trim() === '' || b.model.trim() === '') {
      throw new JudgeStateError('JUDGE_STATE_INVALID: 后端的 vendor/model 不能为空');
    }
  }
  const loaded = await loadRun(deps.io, opts.runId);
  const out: Prepared[] = [];
  for (const l of loaded) {
    const p = l.proposal;
    if (p.reflector.run_id !== opts.runId) {
      throw new JudgeStateError('JUDGE_STATE_INVALID: 提案的 reflector.run_id 与 --run 不一致');
    }
    assertReflectorVendor(p);
    assertExistingJudge(p);
    if (p.judge) {
      out.push({ loaded: l, prompt: undefined });
      continue;
    }
    if (!opts.dry) {
      // 调用之前把「写回一定会失败」的情形查掉:往返不一致、写出口不可写
      serializeProposal(l.raw);
      assertWritable(deps.io, l.file);
      assertWritable(deps.io, `${l.file}.preflight.tmp`);
    }
    out.push({
      loaded: l,
      prompt: buildJudgePrompt(
        {
          op: p.op,
          layer: p.layer,
          signature: l.rule.signature,
          do: l.rule.do,
          why: l.rule.why,
          verify: l.rule.verify,
          evidence: p.evidence.map((e) => e.excerpt),
        },
        deps.redactor,
      ),
    });
  }
  return out;
}

/** 内置厂商里随便取一个不同于 v 的,仅用来问「v 本身是不是可证明的内置规范厂商」。 */
function probeOtherVendor(v: string): string {
  return v === 'openai' ? 'anthropic' : 'openai';
}

/**
 * 反思器厂商必须可证明:unknown/非内置/非规范形(`OpenAI `)→ 无法判断谁是「另一家」,整体 fail-closed;
 * 记了 `backend` 时用 deriveVendor 重算,与记录的 vendor 对不上也 fail-closed(手改 yaml 绕不过去)。
 */
function assertReflectorVendor(p: Proposal): void {
  const r = p.reflector;
  if (!isCrossVendor(r.vendor, probeOtherVendor(r.vendor))) {
    throw new JudgeStateError('JUDGE_VENDOR_UNKNOWN: 反思器厂商不可证明');
  }
  if (r.backend !== undefined) {
    const derived = deriveVendor({ backend: r.backend, provider: r.provider, model: r.model });
    if (derived !== r.vendor) {
      throw new JudgeStateError('JUDGE_VENDOR_UNKNOWN: 反思器厂商与 backend 重算结果不一致');
    }
  } else {
    // 没记 backend 就无法完整重算;至少模型串明确属于另一家时拒绝(手改 vendor 绕不过去)
    const byModel = deriveVendor({ backend: 'pi', model: r.model });
    if (byModel !== 'unknown' && byModel !== r.vendor) {
      throw new JudgeStateError('JUDGE_VENDOR_UNKNOWN: 反思器厂商与其模型串矛盾');
    }
  }
}

/**
 * 后端自报的厂商必须能被其模型串证实:由模型族推导出的厂商 == 自报厂商(归一化后)。
 * 推导不出(`opus`、含空白/非法字符的串)或与自报不符 → 不可证明,不放行。
 * (`LlmBackend` 只有 slot/vendor/model,拿不到 CLI 种类与 provider,所以只能靠模型串;见汇报「待主代理」。)
 */
function vendorUnproven(b: LlmBackend): boolean {
  const byModel = deriveVendor({ backend: 'pi', model: b.model });
  return byModel === 'unknown' || byModel !== norm(b.vendor);
}

export async function runJudge(deps: JudgeDeps, opts: JudgeOptions): Promise<JudgeReport> {
  const prepared = await prepare(deps, opts);
  const fsx = deps.storeFs ?? SAFE_STORE_FS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_JUDGE_MAX_OUTPUT_BYTES;
  let callsMade = 0;
  let budgetExhausted = false;
  /** 本次运行内已确认限流的槽位:后续提案不再调用 */
  const coolingDown = new Set<JudgeHopId>();
  const outcomes: ProposalOutcome[] = [];
  const emit = (o: ProposalOutcome): void => {
    outcomes.push(o);
    deps.onOutcome?.(o);
  };
  const known = opts.dry ? new Set<string>() : await loadKnownAtomIds(deps.io, opts.runId);

  for (const { loaded, prompt } of prepared) {
    const p = loaded.proposal;
    if (p.judge || prompt === undefined) {
      emit({
        proposalId: p.id,
        status: 'already_judged',
        hops: p.judge?.hops ?? [],
        ...(p.judge
          ? { verdict: p.judge.verdict, injectionSuspected: p.judge.injection_suspected }
          : {}),
        invalidOutput: false,
        vendorUnknown: false,
        wrote: false,
      });
      continue;
    }
    if (budgetExhausted && !opts.dry) {
      // 预算在上一条提案里耗尽:本条不开始(保持未处理,可重跑)
      emit({
        proposalId: p.id,
        status: 'not_run',
        hops: [],
        invalidOutput: false,
        vendorUnknown: false,
        wrote: false,
      });
      continue;
    }

    const hops: HopRecord[] = [];
    let success: { backend: LlmBackend; hop: JudgeHopId; value: JudgeOutput } | undefined;
    let invalidOutput = false;

    for (const hop of JUDGE_HOP_CHAIN) {
      const backend = deps.backends[hop];
      if (!backend) {
        hops.push({ hop, ...UNCONFIGURED, result: 'error:not_configured' });
        continue;
      }
      const rec = { hop, vendor: norm(backend.vendor), model: backend.model.trim() };
      if (norm(backend.vendor) === norm(p.reflector.vendor)) {
        hops.push({ ...rec, result: 'skipped:same-vendor' });
        continue;
      }
      if (vendorUnproven(backend) || !isCrossVendor(p.reflector.vendor, backend.vendor)) {
        hops.push({ ...rec, result: 'error:vendor_unknown' });
        continue;
      }
      if (coolingDown.has(hop)) {
        hops.push({ ...rec, result: 'skipped:cooldown' });
        continue;
      }
      if (opts.dry) {
        hops.push({ ...rec, result: 'planned:call' });
        continue;
      }
      if (callsMade >= opts.maxCalls) {
        budgetExhausted = true;
        hops.push({ ...rec, result: 'error:budget_exhausted' });
        continue;
      }
      callsMade++;
      let res;
      try {
        res = await backend.complete({
          system: prompt.system,
          user: prompt.user,
          timeoutMs,
          maxOutputBytes,
        });
      } catch {
        res = { ok: false, reason: 'error' } as const;
      }
      if (!res.ok) {
        if (res.reason === 'rate_limited') {
          coolingDown.add(hop);
          hops.push({ ...rec, result: 'skipped:cooldown' });
        } else {
          const code = ['not_installed', 'not_configured', 'timeout', 'error'].includes(res.reason)
            ? res.reason
            : 'error';
          hops.push({ ...rec, result: `error:${code}` });
        }
        continue;
      }
      const parsed = parseJudgeOutput(res.text, deps.redactor);
      if (!parsed.ok) {
        invalidOutput = true;
        hops.push({ ...rec, result: 'error:invalid_output' });
        continue;
      }
      hops.push({ ...rec, result: 'ok' });
      success = { backend, hop, value: parsed.value };
      break;
    }

    if (opts.dry) {
      emit({
        proposalId: p.id,
        status: 'planned',
        hops,
        invalidOutput: false,
        vendorUnknown: hops.some((h) => h.result === 'error:vendor_unknown'),
        wrote: false,
      });
      continue;
    }

    if (success) {
      const { backend, hop, value } = success;
      const record = {
        hops: hops.map((h) => ({ hop: h.hop, vendor: h.vendor, model: h.model, result: h.result })),
        provider: backend.slot,
        vendor: norm(backend.vendor),
        verdict: value.verdict,
        overfit_risk: value.overfit_risk,
        injection_suspected: value.injection_suspected,
        // 评审给的 conflicts 只保留「确实存在的原子 id」:自由文本不得经此落进提案文件
        conflicts: value.conflicts.filter((c) => known.has(c)),
        // 评审结论绑定评审时的规则文本(⑨A):后续规则被改,promote/CI 的 C6 会对不上
        rule_sha256: ruleSha256(loaded.ruleText),
      };
      assertJudgeProvider(record.provider, hop);
      const next = applyJudgeFields(loaded.raw, { judge: record });
      await writeProposal(deps.io, loaded.file, next, loaded.text, fsx);
      emit({
        proposalId: p.id,
        status: 'judged',
        hops,
        verdict: value.verdict,
        injectionSuspected: value.injection_suspected,
        invalidOutput,
        vendorUnknown: hops.some((h) => h.result === 'error:vendor_unknown'),
        wrote: true,
      });
      continue;
    }

    // 全链无成功:不写 judge,写记满整条链的 judge_attempts(整体替换,不追加)
    const attempts = hops.map((h) => ({
      hop: h.hop,
      vendor: h.vendor,
      model: h.model,
      result: h.result,
    }));
    const unchanged =
      loaded.raw['judge'] === undefined &&
      JSON.stringify(loaded.raw['judge_attempts']) === JSON.stringify(attempts);
    let wrote = false;
    if (!unchanged) {
      const next = applyJudgeFields(loaded.raw, { judge_attempts: attempts });
      await writeProposal(deps.io, loaded.file, next, loaded.text, fsx);
      wrote = true;
    }
    emit({
      proposalId: p.id,
      status: 'pending',
      hops,
      pending: pendingReason(hops),
      invalidOutput,
      vendorUnknown: hops.some((h) => h.result === 'error:vendor_unknown'),
      wrote,
    });
  }

  return {
    runId: opts.runId,
    dry: opts.dry,
    callsMade,
    callsLimit: opts.maxCalls,
    budgetExhausted,
    outcomes,
  };
}
