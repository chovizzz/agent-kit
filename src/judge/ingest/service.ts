/**
 * `judge --ingest` / `--confirm-reflector` 的服务编排(N4,docs/contracts.md §20.18,R20-18.4 ~ R20-18.12)。
 *
 * 阶段(每步失败的去向在 {@link IngestOutcome}):校验 payload(纯)→ 即时闸 → 读暂存区 → 出计划(干跑止于此)→ 确认屏 + 键入确认(`/dev/tty`,经 `TtyPort`)→
 * 键入后的合理性 / 同厂商检查 → **取锁**(用户输入全部通过之后)→ 锁内:purge / recover / 即时闸 → 重读暂存区、重算展示指纹(不符 → STALE)→
 * 冻结参数(`kit.toml [lifecycle]` + HEAD)→ 构造记录(binding)→ 预检(schema / 往返 / 可写)→ 逐条提案原子写 → 刷新 `counts.staged`。
 *
 * - 写入服务**只收 `TtyConfirmedProof` 令牌**(依赖倒置):`confirmation` 的内容(确认时刻、键入的反思器厂商 / 模型)取自令牌,而不是布尔或调用方传来的字符串。
 * - 本模块不 import `src/commands/**`、不碰 `/dev/tty`:终端、锁、即时闸、时钟全部经 {@link IngestDeps} 注入。
 * - 只写 `proposals/<id>.yaml` 的 `judge`(同时删 `judge_attempts`)与 `reflector.confirmed`,经 `store.ts` 的 `applyIngestFields`(其余字段改动即抛)。
 */
import { BUILTIN_VENDORS, UNKNOWN_VENDOR, deriveVendor } from '../../contracts/vendor.js';
import { judgeBindingSha256, reflectorBindingFor } from '../../contracts/judge-binding.js';
import {
  ProposalSchema,
  type ReflectorConfirmed,
  type SessionConfirmedJudgeRecord,
} from '../../contracts/proposal.js';
import type { JudgeFailClosedReason } from '../../contracts/judge-ingest.js';
import { WriteDeniedError, assertWritable } from '../../io/safe-fs.js';
import {
  readProof,
  runTypedConfirmation,
  type TtyConfirmedProof,
  type TtyProofData,
} from '../../io/tty.js';
import { JudgeStateError } from '../errors.js';
import { buildAcceptance, buildPrediction } from '../freeze.js';
import { loadFreezeEnv, type FreezeEnv } from '../run.js';
import {
  JudgeRunNotFoundError,
  SAFE_STORE_FS,
  applyIngestFields,
  loadKnownAtomIds,
  loadRunEntries,
  serializeProposal,
  writeProposal,
  type RunEntries,
} from '../store.js';
import { buildPlan, viewOf, type Plan, type PlanEntry, type PlanResult } from './plan.js';
import { guardedScreen, planFingerprint, screenLines } from './screen.js';
import {
  IngestLockLostError,
  IngestPurgePendingError,
  type IngestDeps,
  type IngestOutcome,
  type IngestRequest,
  type LockedSession,
} from './types.js';
import { validatePayload, type ValidatedPayload } from './validate.js';

const failClosed = (reason: JudgeFailClosedReason): IngestOutcome => ({
  kind: 'fail_closed',
  reason,
});

function reasonOf(e: unknown): JudgeFailClosedReason {
  if (e instanceof IngestLockLostError) return 'lock_lost';
  if (e instanceof WriteDeniedError) return 'write_denied';
  if (e instanceof JudgeStateError) return 'state_invalid';
  return 'internal';
}

/** 读暂存区并出计划;`state_invalid` / `bad_run` 作为结果返回,不抛 */
async function loadAndPlan(
  deps: IngestDeps,
  req: IngestRequest,
  payload: ValidatedPayload | undefined,
): Promise<{ kind: 'plan'; plan: Plan } | { kind: 'result'; result: IngestOutcome }> {
  let entries: RunEntries;
  let known: ReadonlySet<string>;
  try {
    entries = await loadRunEntries(deps.io, req.runId);
    known = req.mode === 'ingest' ? await loadKnownAtomIds(deps.io, req.runId) : new Set<string>();
  } catch (e) {
    if (e instanceof JudgeRunNotFoundError)
      return { kind: 'result', result: { kind: 'usage', reason: 'bad_run' } };
    return { kind: 'result', result: failClosed('state_invalid') };
  }
  let res: PlanResult;
  try {
    res = buildPlan({
      mode: req.mode,
      runId: req.runId,
      loaded: entries.loaded,
      unsupported: entries.unsupported,
      payload,
      replace: req.replace,
      proposalFilter: req.proposalFilter,
      knownAtomIds: known,
      redactor: deps.redactor,
    });
  } catch {
    return { kind: 'result', result: failClosed('state_invalid') };
  }
  if (!res.ok) return { kind: 'result', result: { kind: 'rejected', reason: res.reason } };
  return { kind: 'plan', plan: res.plan };
}

/** 键入后的检查(零写入):反思器侧同厂商、合理性 */
function checkTyped(plan: Plan, data: TtyProofData): IngestOutcome | undefined {
  if (data.reflector.kind !== 'typed') return undefined;
  const typed = data.reflector;
  const declared = plan.payload?.payload.declared.vendor;
  for (const e of plan.entries.filter((x) => x.needsReflectorConfirm)) {
    const counterpart =
      plan.mode === 'ingest'
        ? declared
        : e.existing.kind === 'spawned'
          ? e.existing.vendor
          : e.existing.kind === 'session_confirmed'
            ? e.existing.record.declared.vendor
            : undefined;
    if (counterpart !== undefined && counterpart === typed.vendor) {
      return { kind: 'rejected', reason: 'same_vendor' };
    }
    // 合理性(R20-18.9 declared_vendor_conflict,反思器侧):键入的模型串 + reflector.backend
    const derived = deriveVendor({
      backend: e.loaded.proposal.reflector.backend ?? 'pi',
      model: typed.model,
    });
    if (derived !== UNKNOWN_VENDOR && derived !== typed.vendor) {
      return { kind: 'rejected', reason: 'declared_vendor_conflict' };
    }
  }
  return undefined;
}

interface Prepared {
  readonly entry: PlanEntry;
  readonly next: Record<string, unknown>;
  readonly wroteJudge: boolean;
  readonly wroteConfirmed: boolean;
}

function buildRecords(
  plan: Plan,
  data: TtyProofData,
  freeze: FreezeEnv | undefined,
  kitVersion: string,
): Prepared[] {
  const out: Prepared[] = [];
  for (const e of plan.entries) {
    const l = e.loaded;
    const p = l.proposal;
    let judge: SessionConfirmedJudgeRecord | undefined;
    if (plan.mode === 'ingest') {
      const payload = plan.payload as ValidatedPayload;
      const o = e.output as NonNullable<PlanEntry['output']>;
      if (freeze === undefined || freeze.headOid === undefined) {
        throw new JudgeStateError('JUDGE_STATE_INVALID: 缺少冻结参数');
      }
      const acceptance = buildAcceptance({
        ruleSha256: e.ruleSha,
        signature: l.rule.signature,
        guidance: l.guidance,
        headOid: freeze.headOid,
        now: freeze.now,
        tileDays: freeze.tileDays,
        maxTiles: freeze.maxTiles,
      });
      const prediction = buildPrediction(e.status, o.prediction, acceptance);
      const draft: SessionConfirmedJudgeRecord = {
        provenance: 'session_confirmed',
        verdict: o.verdict,
        overfit_risk: o.overfit_risk,
        injection_suspected: o.injection_suspected,
        conflicts: [...o.conflicts],
        rule_sha256: e.ruleSha,
        prediction,
        acceptance,
        declared: {
          agent: payload.payload.declared.agent,
          vendor: payload.payload.declared.vendor,
          model: payload.declaredModel,
        },
        confirmation: {
          method: 'tty_typed_vendor',
          confirmed_at: data.confirmedAt,
          kit_version: kitVersion,
          payload_sha256: payload.sha256,
          binding_sha256: '0'.repeat(64),
        },
      };
      judge = {
        ...draft,
        confirmation: {
          ...draft.confirmation,
          binding_sha256: judgeBindingSha256(
            {
              id: p.id,
              reflector: { run_id: p.reflector.run_id, input_digest: p.reflector.input_digest },
            },
            draft,
          ),
        },
      };
    }
    let confirmed: ReflectorConfirmed | undefined;
    if (e.needsReflectorConfirm && data.reflector.kind === 'typed') {
      const base = {
        vendor: data.reflector.vendor,
        model: data.reflector.model,
        method: 'tty_typed_vendor' as const,
        confirmed_at: data.confirmedAt,
        kit_version: kitVersion,
      };
      confirmed = { ...base, binding_sha256: reflectorBindingFor(p, base) };
    }
    if (judge === undefined && confirmed === undefined) continue;
    out.push({
      entry: e,
      next: applyIngestFields(l.raw, {
        ...(judge !== undefined ? { judge } : {}),
        ...(confirmed !== undefined ? { confirmed } : {}),
      }),
      wroteJudge: judge !== undefined,
      wroteConfirmed: confirmed !== undefined,
    });
  }
  return out;
}

export async function runJudgeIngest(deps: IngestDeps, req: IngestRequest): Promise<IngestOutcome> {
  // ④ payload 校验(纯)
  let payload: ValidatedPayload | undefined;
  if (req.mode === 'ingest') {
    const v = validatePayload(req.payloadText ?? '', req.runId);
    if (!v.ok) return { kind: 'rejected', reason: v.reason };
    payload = v.value;
  }
  // ⑤ 即时闸(只读版)
  const g1 = await deps.gate();
  if (g1 !== null) return { kind: 'exit', exit: g1 };
  // ⑥ 读暂存提案与规则,出计划
  const first = await loadAndPlan(deps, req, payload);
  if (first.kind === 'result') return first.result;
  const plan = first.plan;
  if (plan.entries.length === 0) {
    return { kind: 'dry', runId: req.runId, plan: [], nothingToConfirm: true };
  }
  if (!req.write) {
    return { kind: 'dry', runId: req.runId, plan: viewOf(plan), nothingToConfirm: false };
  }

  // ⑦ 展示与确认(不持锁)
  const screen = guardedScreen(screenLines(plan), deps.forbidden);
  if (screen === undefined) return failClosed('output_leak');
  const fingerprint = planFingerprint(plan);
  const handle = deps.ttyHandle;
  if (handle === undefined) return { kind: 'usage', reason: 'not_tty' };
  const needing = plan.entries.filter((e) => e.needsReflectorConfirm);
  const first0 = needing[0];
  const conf = await runTypedConfirmation(deps.tty, handle, {
    screen,
    expectJudgeVendor: plan.mode === 'ingest' ? plan.payload?.payload.declared.vendor : undefined,
    reflector:
      first0 === undefined
        ? undefined
        : {
            prompt: `产出这${needing.length}条提案的会话(反思器侧,backend=${first0.loaded.proposal.reflector.backend ?? 'undeclared'})是哪家模型?请键入厂商名与模型串(这两个值是你键入的,不是 agent 的声明):`,
            allowSkip: plan.mode === 'ingest',
            choices: BUILTIN_VENDORS,
          },
    fingerprint,
  });
  if (!conf.ok) return { kind: 'declined', reason: conf.reason };
  await deps.hooks?.afterConfirm?.();
  return writePhase(deps, req, payload, plan, conf.proof);
}

/** 写阶段:**只收令牌**。令牌不是 `io/tty.ts` 铸造的 → 内部错误,零写入 */
async function writePhase(
  deps: IngestDeps,
  req: IngestRequest,
  payload: ValidatedPayload | undefined,
  plan: Plan,
  proof: TtyConfirmedProof,
): Promise<IngestOutcome> {
  const data = readProof(proof);
  if (data === undefined) return failClosed('internal');
  const typedBad = checkTyped(plan, data);
  if (typedBad !== undefined) return typedBad;
  const needIds = plan.entries.filter((e) => e.needsReflectorConfirm).map((e) => e.id);

  try {
    return await deps.underLock(async (s: LockedSession): Promise<IngestOutcome> => {
      await s.enter();
      const g2 = await s.gate();
      if (g2 !== null) return { kind: 'exit', exit: g2 };
      // 锁内重读、重算展示指纹:与展示时不同 → STALE(零写入)
      const again = await loadAndPlan(deps, req, payload);
      if (again.kind === 'result') {
        return again.result.kind === 'rejected'
          ? { kind: 'declined', reason: 'stale' }
          : again.result;
      }
      if (planFingerprint(again.plan) !== data.fingerprint) {
        return { kind: 'declined', reason: 'stale' };
      }
      // 写阶段重新验证「哪些提案需要反思器侧确认」:跳过 / 确认的决定只对展示时的集合有效
      const needNow = again.plan.entries.filter((e) => e.needsReflectorConfirm).map((e) => e.id);
      if (JSON.stringify(needNow) !== JSON.stringify(needIds)) {
        return { kind: 'declined', reason: 'stale' };
      }
      const typedBad2 = checkTyped(again.plan, data);
      if (typedBad2 !== undefined) return typedBad2;

      let freeze: FreezeEnv | undefined;
      if (again.plan.mode === 'ingest') {
        try {
          freeze = loadFreezeEnv(
            {
              io: deps.io,
              ...(deps.resolveHead !== undefined ? { resolveHead: deps.resolveHead } : {}),
              now: deps.now,
            },
            true,
          );
        } catch {
          return failClosed('freeze_unavailable');
        }
      }
      let prepared: Prepared[];
      try {
        prepared = buildRecords(again.plan, data, freeze, deps.kitVersion);
        // 预检:调用之前把「写回一定会失败」的情形查掉(零写入)
        for (const pr of prepared) {
          if (!ProposalSchema.safeParse(pr.next).success) {
            throw new JudgeStateError('JUDGE_STATE_INVALID: 更新后的提案未通过 ProposalSchema');
          }
          serializeProposal(pr.next);
          assertWritable(deps.io, pr.entry.loaded.file);
          assertWritable(deps.io, `${pr.entry.loaded.file}.preflight.tmp`);
        }
      } catch (e) {
        return failClosed(reasonOf(e));
      }

      const fsx = deps.storeFs ?? SAFE_STORE_FS;
      const proposals: string[] = [];
      const confirmed: string[] = [];
      let replaced = 0;
      let written = 0;
      let failure: JudgeFailClosedReason | undefined;
      for (const pr of prepared) {
        try {
          await s.assertHeld();
          await writeProposal(deps.io, pr.entry.loaded.file, pr.next, pr.entry.loaded.text, fsx);
        } catch (e) {
          failure = reasonOf(e);
          break;
        }
        written++;
        if (pr.wroteJudge) {
          proposals.push(pr.entry.id);
          if (pr.entry.existing.kind === 'session_confirmed') replaced++;
        }
        if (pr.wroteConfirmed) confirmed.push(pr.entry.id);
      }
      const settled = await s.settle(written > 0);
      if (settled !== undefined) return { kind: 'exit', exit: settled };
      return {
        kind: 'written',
        runId: again.plan.runId,
        partial: failure !== undefined,
        proposals,
        reflectorConfirmed: confirmed,
        written,
        total: prepared.length,
        replaced,
        reflectorUnconfirmed: needNow.length - confirmed.length,
        failure,
      };
    });
  } catch (e) {
    if (e instanceof IngestPurgePendingError) {
      return { kind: 'not_run', code: 'RSI_NOT_RUN', reason: 'purge_pending' };
    }
    throw e; // 锁错误等:命令层映射
  }
}
