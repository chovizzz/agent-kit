/**
 * 后端工厂。本目录是唯一允许 import `src/io/llm-exec.ts` 的地方;对外**只导出**工厂、类型与
 * `createSpawnBudget`(命令层经它构造预算,不必自己 import llm-exec)。不导出、不 re-export `runLlm`。
 * 槽位 id 沿用 `JUDGE_HOP_CHAIN`(固定枚举);每个槽位绑哪个 CLI/provider/模型只来自覆盖层配置——
 * core 里没有任何私人账号/渠道默认值。没配置的槽位得到一个总是 `not_configured` 的占位后端。
 */
import { JUDGE_HOP_CHAIN } from '../../contracts/proposal.js';
import type { ReflectBackendBinding } from '../../contracts/config.js';
import { ReflectBackendBindingSchema } from '../../contracts/config.js';
import { UNKNOWN_VENDOR } from '../../contracts/vendor.js';
import type { IoContext } from '../../io/paths.js';
import { LlmSpawnBudget } from '../../io/llm-exec.js';
import type { LlmBackend, LlmBackendCli, LlmCompleteResult } from '../backend-iface.js';
import { CLAUDE_ARGS } from './cli-claude.js';
import { CliBackend } from './cli-common.js';
import { CODEX_ARGS } from './cli-codex.js';
import { PI_ARGS } from './cli-pi.js';
import { normalizeResetTz } from './cooldown.js';
import type { BackendDeps, CliArgSet, SpawnBudget } from './types.js';

export type { BackendDeps, CliArgSet, SpawnBudget } from './types.js';
export { StubBackend } from './stub.js';
export type { StubOptions, StubScript } from './stub.js';
export { dayKey, isCoolingDown, markCooldown, normalizeResetTz } from './cooldown.js';

const ARG_SETS: Readonly<Record<ReflectBackendBinding['cli'], CliArgSet>> = {
  claude: CLAUDE_ARGS,
  codex: CODEX_ARGS,
  pi: PI_ARGS,
};

const issuedBudgets = new Set<string>();

/**
 * 一次运行共享的 spawn 预算(≤10;命令层按 `reflect.max_calls` 创建)。
 * 同一进程里、同一 state 目录**只能创建一次**(契约 §16②:预算单例化,防止每次 buildBackends 都新建一份无限预算);
 * 重复创建抛错。需要多份预算的场景(测试)请用不同的 state 目录。
 */
export function createSpawnBudget(ctx: IoContext, max: number): SpawnBudget {
  const key = ctx.stateDir;
  if (issuedBudgets.has(key)) {
    throw new Error(
      'SPAWN_BUDGET_ALREADY_CREATED: 同一 state 目录在本进程内只能创建一次 spawn 预算',
    );
  }
  const b = new LlmSpawnBudget(max);
  issuedBudgets.add(key);
  return b;
}

/** 只读的参数集清单(给 R6 逐项核实、给报告列出「未核实」项)。 */
export function listCliArgSets(): readonly CliArgSet[] {
  return [CLAUDE_ARGS, CODEX_ARGS, PI_ARGS];
}

export interface BuildBackendsConfig {
  readonly backends?: readonly ReflectBackendBinding[];
  readonly reset_tz?: string;
  readonly vendor_overrides?: Readonly<Record<string, string>>;
}

class UnconfiguredBackend implements LlmBackend {
  readonly #slot: string;
  readonly #detail: string;
  constructor(slot: string, detail = 'slot_not_bound') {
    this.#slot = slot;
    this.#detail = detail;
  }
  get slot(): string {
    return this.#slot;
  }
  get vendor(): string {
    return UNKNOWN_VENDOR;
  }
  get model(): string {
    return 'unconfigured';
  }
  get cli(): LlmBackendCli {
    return 'unconfigured';
  }
  get provider(): string | undefined {
    return undefined;
  }
  complete(): Promise<LlmCompleteResult> {
    return Promise.resolve({ ok: false, reason: 'not_configured', detail: this.#detail });
  }
}

/** 按固定兜底链顺序返回每个槽位的后端(长度恒等于 `JUDGE_HOP_CHAIN`)。 */
export function buildBackends(
  config: BuildBackendsConfig,
  deps: BackendDeps,
): readonly LlmBackend[] {
  const resetTz = normalizeResetTz(config.reset_tz, deps.warn);
  const overrides = config.vendor_overrides ?? {};
  const bound = new Map<string, ReflectBackendBinding>();
  for (const b of config.backends ?? []) if (!bound.has(b.slot)) bound.set(b.slot, b);
  return JUDGE_HOP_CHAIN.map((slot): LlmBackend => {
    const raw = bound.get(slot);
    if (raw === undefined) return new UnconfiguredBackend(slot);
    // 入参不可信(可能没经过配置 schema):再校验一遍,形状不对按未配置处理
    const parsed = ReflectBackendBindingSchema.safeParse(raw);
    if (!parsed.success) return new UnconfiguredBackend(slot, 'bad_binding');
    const b = parsed.data;
    return new CliBackend({
      slot,
      args: ARG_SETS[b.cli],
      provider: b.provider,
      model: b.model,
      vendorOverrides: overrides,
      resetTz,
      deps,
    });
  });
}
