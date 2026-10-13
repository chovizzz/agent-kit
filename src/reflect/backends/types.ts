import type { IoContext } from '../../io/paths.js';
import type { LlmSpawnBudget } from '../../io/llm-exec.js';

/** 一次运行共享的 spawn 预算(类型别名;命令层经 `createSpawnBudget` 构造,不 import llm-exec)。 */
export type SpawnBudget = LlmSpawnBudget;

/**
 * 「某条无工具/无会话/无上下文」声明的核实状态。
 * - `unresolved`:没写法;`claimed`:写了但没实测;
 * - `verified`:R6 真实环境实测成立;`not_met`:R6 实测**不成立**(已知做不到)。
 */
export type FlagClaim = 'claimed' | 'unresolved' | 'verified' | 'not_met';

/**
 * 一个 CLI 的参数集。`verified:false` = 整体隔离要求尚未全部核实/满足(R6 已逐项实测部分,
 * 见 `claims`),默认拒绝真跑(见 `BackendDeps.allowUnverified`)。`claims` 逐项说明想达到的隔离效果与现状,供 R6 逐项核对。
 */
export interface CliArgSet {
  readonly cli: 'claude' | 'codex' | 'pi';
  readonly verified: boolean;
  /** 依据:只能引用本仓库文档/设计里已有的信息 */
  readonly basis: string;
  readonly claims: {
    readonly noTools: FlagClaim;
    readonly noMcp: FlagClaim;
    readonly noSession: FlagClaim;
    readonly noProjectContext: FlagClaim;
    /** 不执行项目级/用户级设置里的 hooks 与命令(例如 `.claude/settings.json`) */
    readonly noProjectSettings: FlagClaim;
    /** 用户设置/配置文件不能把请求改道到别家(例如 base URL、自定义 provider):厂商推导才站得住 */
    readonly noUserRouting: FlagClaim;
    /** 提示经 stdin 传入这一条本身是否实测过 */
    readonly inputViaStdin: FlagClaim;
  };
  /** 是否必须配置 provider(claude 不接受;codex 缺省 openai;pi 必填) */
  readonly provider: 'forbidden' | 'optional' | 'required';
  /** R6 在该版本/环境下观察到的全局写入(参数挡不住;不保证每次发生、清单不保证穷尽;A5 零写入验收不覆盖真跑)。深冻结。 */
  readonly globalWrites: readonly string[];
  build(binding: { readonly provider?: string | undefined; readonly model: string }): string[];
}

export interface BackendDeps {
  readonly ctx: IoContext;
  readonly now: () => Date;
  /** 全部槽位共享同一个预算 */
  readonly budget: SpawnBudget;
  /** 宿主环境(来源由命令层给);只有 `LLM_ENV_ALLOW` 名字白名单内的变量会到达子进程 */
  readonly envSource: Readonly<Record<string, string | undefined>>;
  /** 解析二进制;缺省按 `envSource.PATH` 的绝对项查找。返回绝对路径或 undefined */
  readonly which?: (name: string, pathEnv: string) => string | undefined;
  /** 用户是否同时给了 `--run-llm --allow-egress`(命令层决定;false 时 CLI 后端一律不 spawn) */
  readonly allowEgress: boolean;
  /**
   * 放行 `verified:false` 参数集所允许的**二进制绝对路径清单**(按 realpath 比较;只有清单内的二进制才会被真跑)。
   * **只能由代码注入**:不来自配置、环境变量或命令行;缺省/空 = 全部拒绝。
   * (契约配置暂无 `allow_unverified` 字段——待 R0 追加后由命令层接线;R6 实测时把被测 CLI 的绝对路径放进来。)
   */
  readonly allowUnverified?: readonly string[];
  readonly warn?: (message: string) => void;
  /** 跨进程锁的过期时间(ms,缺省 15 分钟);仅供测试注入 */
  readonly lockStaleMs?: number;
}

/** 参数集是进程级常量:深冻结,防止运行期改写 `verified` / `build` / `claims`。 */
export function deepFreezeArgSet(a: CliArgSet): CliArgSet {
  Object.freeze(a.claims);
  Object.freeze(a.globalWrites);
  return Object.freeze(a);
}
