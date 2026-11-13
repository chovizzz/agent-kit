/**
 * 只读命令(`rsi auto status` / `rsi report` / `rsi show` / `rsi auto clear` 干跑 / `rsi rollback --to` 干跑)的窄端口(SOLID 的 I / D)。
 * 业务只依赖这里的类型;具体实现在部署组装处(`src/rsi/auto/deps.ts`)注入,测试假件遵守同一份契约:
 * **读失败 = `unreadable` 或抛错,绝不返回「空 / 缺失」冒充成功**;缺失(`absent`)只表示「确认不存在」。
 * 本文件只有类型,没有 I/O。
 */
import type { RsiAutoPauseReason } from '../../../contracts/rsi.js';
import type { RecordedReadPort } from '../../personal/read/recorded-port.js';

/** 原始文件读取的三态 */
export type RawRead = { kind: 'absent' } | { kind: 'ok'; text: string } | { kind: 'unreadable' };

/** `state.json` 的读取结果:整份过不了 schema = `invalid`(退 3);缺 `auto_pause` 键 = `autoPause: null` */
export type StateRead =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | {
      kind: 'ok';
      autoPause: {
        reasons: readonly RsiAutoPauseReason[];
        diverged: boolean;
        ownerChanged: boolean;
      } | null;
    };

export interface AutoConfigRead {
  /** `[rsi]` 是否可用(off / 配置不可用 = false) */
  rsiOn: boolean;
  /** `[rsi.auto] enabled`(缺省 false) */
  enabled: boolean;
  profile: 'lite' | 'medium' | 'heavy';
}

/** 两个暂停标记的存在性:`lstat` 失败且不是 ENOENT 也算 `present`(fail-closed,与 hint 一致) */
export interface MarkerRead {
  user: 'absent' | 'present';
  breaker: 'absent' | 'present';
}

export type TxnNamesRead = { kind: 'ok'; names: readonly string[] } | { kind: 'unreadable' };

/** HOME 侧个人层状态的只读端口(`rsi-personal/`;不含任何写出口) */
export interface HomeReadPort {
  /** `head.json` 原文 */
  head(): Promise<RawRead>;
  /** `revocations.jsonl` 原文 */
  revocations(): Promise<RawRead>;
  /** `txn/` 下在途 journal 的 txn_id(升序;目录不存在 = 空) */
  txnNames(): Promise<TxnNamesRead>;
  /** 一份 journal 的原文(`txn/<id>.json`) */
  journal(txnId: string): Promise<RawRead>;
}

/** N4-2「关联提案裁决」段的数据(读取失败只影响该段) */
export type JudgeVerdictRead =
  | { kind: 'absent' }
  | { kind: 'unavailable' }
  | {
      kind: 'ok';
      judge_provenance: string;
      verdict: string;
      overfit: string;
      injection: string;
      /** 自报记录的厂商 / 模型(没有 = null) */
      declared: string | null;
    };
export interface JudgeVerdictPort {
  verdictFor(runId: string, proposalId: string): Promise<JudgeVerdictRead>;
}

export interface AutoReadPorts {
  /** 时钟(时间只经注入) */
  now(): Date;
  config(): Promise<AutoConfigRead>;
  state(): Promise<StateRead>;
  /** `.state/rsi/auto-view.json` 原文 */
  view(): Promise<RawRead>;
  markers(): Promise<MarkerRead>;
  /** `.state/rsi/audit.jsonl` 原文 */
  audit(): Promise<RawRead>;
  /** 账 / 状态是否显示曾有转移(`rsi report` 的缺失 / 空审计文件判定) */
  priorActivity(): Promise<boolean>;
  home: HomeReadPort;
  recorded: RecordedReadPort;
  judge: JudgeVerdictPort;
  /**
   * 输出泄漏闸的**额外**禁止值(生产组装解析:实际仓库根 / 状态目录 / `[rsi] repo` / 私有仓库目录;realpath 由 `forbiddenPaths` 补)。
   * HOME 与 `KIT_TMP` 由 `forbiddenPaths` 自己收;处理函数只接收最终集合,不自己读配置。
   */
  outputForbidden: readonly string[];
}

/** 端口装配阶段的用法错误(如 `--root` 与 `[rsi] repo` 不一致):入口映射为退 2 `RSI_USAGE reason=<reason>` */
export class AutoUsageError extends Error {
  readonly code = 'RSI_AUTO_USAGE';
  constructor(readonly reason: 'root_mismatch') {
    super(`auto usage: ${reason}`);
  }
}
