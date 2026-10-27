/**
 * `rsiStateOf()`:自动 RSI 状态机的唯一实现(docs/contracts.md §20.1 R20-1.3 / R20-1.5 / R20-1.5a;R20-A2 B2)。
 *
 * 状态由「配置 + `.state/rsi/state.json` 的确认记录 + 停止标记」**现算**,不存一个可被改成 `confirmed` 的状态字段。
 * 本文件是纯函数 + 几个只读辅助:不读盘(输入由调用方经快照协议 / `loadRsiConfig` 取好)、不写、不拿锁。
 *
 * 判据顺序(先命中先算):
 *  1. `off`:配置结果为 `off`,或调用方声明自动入口被 R20-1.6 条件(`KIT_AUTO_RSI=0` 等)跳过;
 *  2. `stopped`:配置可用且 `STOP` 存在(停止采集 `block` 不改变状态,状态照算);
 *  3. `armed`:无**有效**确认记录;
 *  4. `confirmed`。
 * 确认记录无效(R20-1.5)的六种情形按 ①..⑥ 的顺序取第一个:收紧排除、减少 agent、新增项目都**不**使确认失效。
 * `state.json` 本身过不了 schema(无处记录熔断,R20-6.6)时按 `armed`(最低权限:不读会话正文)并置 `stateInvalid`,
 * `rsi status` 据此退出 3、自动路径空操作。
 */
import { createHash } from 'node:crypto';
import {
  RsiConfirmSchema,
  RsiStateSchema,
  type RsiConfirm,
  type RsiPolicy,
  type RsiState,
} from '../contracts/rsi.js';
import { stat } from '../io/read-fs.js';
import type { RsiBlockReason, RsiConfig, RsiConfigOn, RsiOffReason } from './config.js';

export type RsiStateName = 'off' | 'stopped' | 'armed' | 'confirmed';

/** R20-1.5 的六种失效原因(按判据序号 ①..⑥) */
export type ConfirmInvalidReason =
  'exclude_relaxed' | 'agent_added' | 'repo_changed' | 'overlay_changed' | 'kit_major' | 'schema';

export type RsiStateDoc =
  | { kind: 'absent' }
  /** `state.json` 整体过不了 schema(或不是 JSON) */
  | { kind: 'invalid' }
  | { kind: 'ok'; state: RsiState }
  /** 只有 `confirm` 记录过不了 schema、其余字段合法(R20-1.5 ⑥):按失效处理,不当作整份损坏 */
  | { kind: 'confirm_schema_invalid'; state: Omit<RsiState, 'confirm'> };

/** 解析 `state.json` 的原始字节(调用方经快照协议读到的那份;`null` = 文件不存在) */
export function parseRsiStateDoc(bytes: Uint8Array | null): RsiStateDoc {
  if (bytes === null) return { kind: 'absent' };
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return { kind: 'invalid' };
  }
  const full = RsiStateSchema.safeParse(raw);
  if (full.success) return { kind: 'ok', state: full.data };
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'confirm' in raw) {
    const { confirm, ...rest } = raw as Record<string, unknown>;
    // 只有「confirm 本身不合规、去掉它之后整份合法」才算 confirm 失效;其它任何问题仍是整份 invalid
    if (confirm !== null && !RsiConfirmSchema.safeParse(confirm).success) {
      const without = RsiStateSchema.safeParse({ ...rest, confirm: null });
      if (without.success) {
        const { confirm: _drop, ...state } = without.data;
        void _drop;
        return { kind: 'confirm_schema_invalid', state };
      }
    }
  }
  return { kind: 'invalid' };
}

/** 当前仓库 / 策略身份:确认记录比对的对象(R20-1.5 ①..⑤);调用方现算 */
export interface RsiIdentity {
  /** `sha256(repo 的 realpath)` */
  repoSha256: string;
  repoDevIno: { dev: number; ino: number };
  /** 含 agents、排除哈希集合、overlay 的 sha256(null = 没有 / 不可用)、kit 主版本 */
  policy: RsiPolicy;
}

/** 由已校验的 `[rsi] repo` 取身份(`stat` 即 `(dev, ino)`;只读) */
export async function loadRepoIdentity(cfg: RsiConfigOn, policy: RsiPolicy): Promise<RsiIdentity> {
  const st = await stat(cfg.repo);
  return {
    repoSha256: createHash('sha256').update(cfg.repo).digest('hex'),
    repoDevIno: { dev: st.dev, ino: st.ino },
    policy,
  };
}

/** R20-1.5:确认记录相对当前身份是否仍有效;有效返回 `null`,否则返回第一个命中的失效原因(⑥ schema 由 {@link parseRsiStateDoc} 判) */
export function confirmInvalidReason(
  confirm: RsiConfirm,
  id: RsiIdentity,
): ConfirmInvalidReason | null {
  const now = id.policy;
  // ① 排除被放宽:确认时的任一排除项哈希不在当前集合里
  if (confirm.exclude_hashes.some((h) => !now.exclude_hashes.includes(h))) return 'exclude_relaxed';
  // ② 当前 agents 含确认时没有的 agent
  if (now.agents.some((a) => !confirm.agents.includes(a))) return 'agent_added';
  // ③ repo 的 realpath 或 (dev, ino) 与确认时不同
  if (
    confirm.repo_sha256 !== id.repoSha256 ||
    confirm.repo_dev_ino.dev !== id.repoDevIno.dev ||
    confirm.repo_dev_ino.ino !== id.repoDevIno.ino
  ) {
    return 'repo_changed';
  }
  // ④ overlay 的有无或内容 sha256 不同
  if (confirm.overlay_sha256 !== now.overlay_sha256) return 'overlay_changed';
  // ⑤ kit 主版本不同
  if (confirm.kit_major !== now.kit_major) return 'kit_major';
  return null;
}

export interface RsiStateInput {
  config: RsiConfig;
  /** 自动入口(poke / hint / worker)被 R20-1.6 的跳过条件命中;前台命令不传 */
  autoSkip?: boolean;
  /** `.state/rsi/STOP` 是否存在 */
  stopPresent: boolean;
  doc: RsiStateDoc;
  /** `config.status === 'on'` 时必须给 */
  identity?: RsiIdentity;
}

export interface RsiStateResult {
  state: RsiStateName;
  /** `off` 时的原因:配置原因码,或 `auto_skip`;其余状态为 `null` */
  reason: RsiOffReason | 'auto_skip' | null;
  /** R20-1.5a:从未确认过(无确认记录)的 `armed`;失效后的 `armed`、`stopped`、`confirmed` 恒为 false */
  firstArmed: boolean;
  /** `armed` 因确认失效而退回时的原因 */
  confirmInvalid: ConfirmInvalidReason | null;
  /** 停止采集(R20-2.8):状态照算,只是不读会话文件 */
  collectBlocked: RsiBlockReason | null;
  /** `state.json` 整份过不了 schema(R20-6.6):`rsi status` 退出 3,自动路径空操作 */
  stateInvalid: boolean;
}

export function rsiStateOf(input: RsiStateInput): RsiStateResult {
  const { config } = input;
  if (config.status === 'off') {
    return {
      state: 'off',
      reason: config.reason,
      firstArmed: false,
      confirmInvalid: null,
      collectBlocked: null,
      stateInvalid: false,
    };
  }
  const base = { collectBlocked: config.block, reason: null } as const;
  if (input.autoSkip === true) {
    return {
      state: 'off',
      reason: 'auto_skip',
      firstArmed: false,
      confirmInvalid: null,
      collectBlocked: null,
      stateInvalid: false,
    };
  }
  const doc = input.doc;
  const stateInvalid = doc.kind === 'invalid';
  if (input.stopPresent) {
    return { ...base, state: 'stopped', firstArmed: false, confirmInvalid: null, stateInvalid };
  }
  if (doc.kind === 'absent') {
    return { ...base, state: 'armed', firstArmed: true, confirmInvalid: null, stateInvalid };
  }
  if (doc.kind === 'invalid') {
    return { ...base, state: 'armed', firstArmed: false, confirmInvalid: null, stateInvalid };
  }
  if (doc.kind === 'confirm_schema_invalid') {
    return { ...base, state: 'armed', firstArmed: false, confirmInvalid: 'schema', stateInvalid };
  }
  const confirm = doc.state.confirm;
  if (confirm === null) {
    return { ...base, state: 'armed', firstArmed: true, confirmInvalid: null, stateInvalid };
  }
  if (input.identity === undefined) {
    // 配置可用却没有身份可比:无法证明确认仍有效 → 最低权限
    return {
      ...base,
      state: 'armed',
      firstArmed: false,
      confirmInvalid: 'repo_changed',
      stateInvalid,
    };
  }
  const why = confirmInvalidReason(confirm, input.identity);
  if (why !== null) {
    return { ...base, state: 'armed', firstArmed: false, confirmInvalid: why, stateInvalid };
  }
  return { ...base, state: 'confirmed', firstArmed: false, confirmInvalid: null, stateInvalid };
}
