/**
 * judge 核心:对一个 run 里的每条提案,按固定兜底链(JUDGE_HOP_CHAIN)逐跳评审。
 *
 * - 后端一律经依赖注入(`JudgeBackends`),本模块不 import 任何后端/llm-exec。
 * - 同厂商(归一化后相等)的跳**不调用**,记 skipped:same-vendor;厂商不可证明不同(unknown/非内置)
 *   的跳同样不调用,记 error:vendor_unknown。
 * - 一跳成功 → 写 `judge` 并删除 `judge_attempts`;全链无成功 → 不写 `judge`,写记满整条链的 `judge_attempts`。
 * - judge **永远不改**提案的其它字段(状态转移只走 promote/retire 的人批 PR)。
 */
import { LifecycleCoreConfigSchema } from '../contracts/config.js';
import { JUDGE_HOP_CHAIN } from '../contracts/proposal.js';
import type { JudgeHopId, JudgeOutput, Proposal } from '../contracts/proposal.js';
import type { Redactor } from '../contracts/redact.js';
import { deriveVendor, isCrossVendor } from '../contracts/vendor.js';
import { loadKitConfig } from '../build/config.js';
import { createGuardGit } from '../guards/git.js';
import type { IoContext } from '../io/paths.js';
import { assertWritable } from '../io/safe-fs.js';
import { ruleSha256 } from '../lifecycle/checks.js';
import type { LlmBackend } from '../reflect/backend-iface.js';
import { JudgeProviderMismatchError, JudgeStateError } from './errors.js';
import { parseJudgeOutput } from './output.js';
import { buildAcceptance, buildPrediction, decidePredictionStatus, isoSeconds } from './freeze.js';
import type { FreezeStatus } from './freeze.js';
import {
  buildJudgePrompt,
  JUDGE_PROMPT_ID as V1_ID,
  JUDGE_PROMPT_TEMPLATE_SHA256 as V1_TEMPLATE_SHA,
} from './prompt/v1.js';
import type { JudgePrompt } from './prompt/v1.js';
import {
  buildJudgePromptV2,
  JUDGE_PROMPT_ID as V2_ID,
  JUDGE_PROMPT_TEMPLATE_SHA256 as V2_TEMPLATE_SHA,
} from './prompt/v2.js';
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

/**
 * 没评上的原因。`not_configured`(链上没有任何已配置的后端)与 `same_vendor_only`(有已配置后端,但都与反思器同厂商)
 * 拆开,是为了让用户看出前者是配置问题(原单码 `no_cross_vendor` 已废,P1 backlog D4)。
 */
export type PendingReason = 'not_configured' | 'same_vendor_only' | 'all_failed' | 'cooldown';

export interface JudgeDeps {
  readonly io: IoContext;
  readonly redactor: Pick<Redactor, 'pass2'>;
  readonly backends: JudgeBackends;
  /** 测试注入点:默认 safe-fs */
  readonly storeFs?: StoreFs;
  /** 测试注入点:judge 运行时仓库 HEAD 的提交 oid;缺省经 guards/git 的 resolveCommit('HEAD')。取不到 → undefined */
  readonly resolveHead?: () => string | undefined;
  /** 测试注入点:judge 时钟(frozen_at),缺省 `new Date()` */
  readonly now?: () => Date;
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
  let sameVendor = false;
  for (const h of hops) {
    if (h.result === 'skipped:cooldown') cooldown = true;
    else if (h.result === 'skipped:same-vendor') sameVendor = true;
    else if (h.result !== 'error:vendor_unknown' && h.result !== 'error:not_configured') {
      return 'all_failed';
    }
  }
  if (cooldown) return 'cooldown';
  return sameVendor ? 'same_vendor_only' : 'not_configured';
}

interface Prepared {
  readonly loaded: LoadedProposal;
  readonly prompt: JudgePrompt | undefined;
  /** 本次实际用的模板 id / 模板哈希(写进 `judge.prompt_id` / `judge.prompt_sha256`);没建提示时为 undefined */
  readonly promptMeta?: { readonly id: string; readonly sha256: string };
  /** kit 决定的预测状态(LLM 不参与);已有 judge 的提案不用 */
  readonly status: FreezeStatus;
}

interface FreezeEnv {
  readonly tileDays: number;
  readonly maxTiles: number;
  /** 干跑不需要 HEAD(不写冻结记录) */
  readonly headOid: string | undefined;
  /** 本次运行的 judge 时钟:运行开始取一次,全部提案共用(frozen_at 在同一 run 内可比、可固定) */
  readonly now: Date;
}

/**
 * 读 kit.toml `[lifecycle]`(冻结参数必须与 CI 读到的基线一致,所以不能凭默认值冻结):
 * kit.toml 缺失/无法解析/未过 schema → fail-closed(退出 3)。`[lifecycle]` 段缺省时用 schema 默认值
 * (与 guards/criteria.ts 的 loadLifecycle 同形)。
 */
function loadFreezeEnv(deps: JudgeDeps, needHead: boolean): FreezeEnv {
  const loaded = loadKitConfig(deps.io.repoRoot);
  if (loaded.config === undefined) {
    throw new JudgeStateError('JUDGE_STATE_INVALID: 读不到可用的 kit.toml,无法确定冻结参数');
  }
  const lc = loaded.config.lifecycle ?? LifecycleCoreConfigSchema.parse({});
  let headOid: string | undefined;
  if (needHead) {
    try {
      headOid = (deps.resolveHead ?? (() => createGuardGit(deps.io).resolveCommit('HEAD')))();
    } catch {
      headOid = undefined;
    }
    if (headOid === undefined || !/^[0-9a-f]{40}$/.test(headOid)) {
      // 没有仓库 HEAD 就没有外部锚点(judged_at_head):不写冻结记录
      throw new JudgeStateError('JUDGE_STATE_INVALID: 取不到仓库 HEAD 提交,无法冻结验收协议');
    }
  }
  return {
    tileDays: lc.acceptance_tile_days,
    maxTiles: lc.acceptance_max_tiles,
    headOid,
    now: (deps.now ?? (() => new Date()))(),
  };
}

/** 调用前:校验后端表、读取全部提案、为每条建提示(任何一步失败 → 抛错,零调用零写入)。 */
async function prepare(
  deps: JudgeDeps,
  opts: JudgeOptions,
): Promise<{ prepared: Prepared[]; freeze: FreezeEnv }> {
  for (const hop of JUDGE_HOP_CHAIN) {
    const b = deps.backends[hop];
    if (!b) continue;
    assertJudgeProvider(b.slot, hop);
    if (b.vendor.trim() === '' || b.model.trim() === '') {
      throw new JudgeStateError('JUDGE_STATE_INVALID: 后端的 vendor/model 不能为空');
    }
  }
  const loaded = await loadRun(deps.io, opts.runId);
  const freeze = loadFreezeEnv(deps, !opts.dry && loaded.some((l) => !l.proposal.judge));
  const out: Prepared[] = [];
  // 与 buildAcceptance 同精度(整秒):预检与实际冻结必须用同一个时钟值
  const nowMs = Date.parse(isoSeconds(freeze.now));
  for (const l of loaded) {
    const p = l.proposal;
    if (p.reflector.run_id !== opts.runId) {
      throw new JudgeStateError('JUDGE_STATE_INVALID: 提案的 reflector.run_id 与 --run 不一致');
    }
    assertReflectorVendor(p);
    assertExistingJudge(p);
    if (p.judge) {
      out.push({ loaded: l, prompt: undefined, status: 'not_measurable' });
      continue;
    }
    if (!opts.dry) {
      // 调用之前把「写回一定会失败」的情形查掉:往返不一致、写出口不可写
      serializeProposal(l.raw);
      assertWritable(deps.io, l.file);
      assertWritable(deps.io, `${l.file}.preflight.tmp`);
    }
    // 时钟早于引导窗口上界:调用之前就中止(否则花了 LLM 调用才发现写不出一致的冻结记录)
    if (!opts.dry && l.guidance !== undefined && Date.parse(l.guidance.until) > nowMs) {
      throw new JudgeStateError('JUDGE_STATE_INVALID: guidance.until 晚于 judge 时钟,拒绝冻结');
    }
    const status = decidePredictionStatus(l.rule.signature, l.guidance);
    const promptInput = {
      op: p.op,
      layer: p.layer,
      signature: l.rule.signature,
      do: l.rule.do,
      why: l.rule.why,
      verify: l.rule.verify,
      evidence: p.evidence.map((e) => e.excerpt),
    };
    // 只有 kit 判定 predicted 才用 v2(给基线、要 prediction);其余沿用 v1
    const g = status === 'predicted' ? l.guidance : undefined;
    out.push({
      loaded: l,
      status,
      prompt:
        g !== undefined
          ? buildJudgePromptV2({ ...promptInput, baseline: g.baseline }, deps.redactor)
          : buildJudgePrompt(promptInput, deps.redactor),
      promptMeta:
        g !== undefined
          ? { id: V2_ID, sha256: V2_TEMPLATE_SHA }
          : { id: V1_ID, sha256: V1_TEMPLATE_SHA },
    });
  }
  return { prepared: out, freeze };
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
  const { prepared, freeze } = await prepare(deps, opts);
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

  for (const { loaded, prompt, promptMeta, status } of prepared) {
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
      // predicted 时必须有合法 prediction:缺失/非法 = 该跳 invalid_output、走下一跳(③A,堵「挑难题不预测」)
      const parsed = parseJudgeOutput(res.text, deps.redactor, {
        predictionRequired: status === 'predicted',
      });
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
        // 可追溯(K6):纯留痕,不进下面 acceptance 的哈希(buildAcceptance 不接收它们)
        ...(promptMeta !== undefined
          ? { prompt_id: promptMeta.id, prompt_sha256: promptMeta.sha256 }
          : {}),
      };
      assertJudgeProvider(record.provider, hop);
      // 冻结:验收协议与预测都由 kit 确定性计算;LLM 只贡献 predicted 时的四个值
      // (非 predicted 时 parseJudgeOutput 已丢弃 LLM 的 prediction)
      const acceptance = buildAcceptance({
        ruleSha256: record.rule_sha256,
        signature: loaded.rule.signature,
        guidance: loaded.guidance,
        headOid: freeze.headOid as string,
        now: freeze.now,
        tileDays: freeze.tileDays,
        maxTiles: freeze.maxTiles,
      });
      const prediction = buildPrediction(status, value.prediction, acceptance);
      const next = applyJudgeFields(loaded.raw, { judge: { ...record, prediction, acceptance } });
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
