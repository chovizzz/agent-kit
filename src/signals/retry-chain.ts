/**
 * 每会话重试链(R21-18 第 20 条 `retry_chain_len`、§21.24 W0-7 `retry_chain_max`;spec §12.2)。
 *
 * 定义:**同一工具**(按工具名)的**连续失败**组成一条链——中间夹着别的工具的结果、用户消息、助手文本都不断链;
 * 该工具的一次**成功结果**结束它的链(「成功结束」);会话读完时仍未成功的链就停在当前长度(「放弃」);
 * 一个会话一个追踪器,**不跨会话**。没有工具名的失败不成链(无法证明是同一工具),不产出链长。
 *
 * 失败信号的 `retry_chain_len` = 这次失败在链里的序号(1 起),只依赖此前的事件(前缀稳定);
 * `max()` = 本会话最大链长,无失败(或没有可成链的失败)为 0,即 `SessionStat.retry_chain_max`。
 */
export class RetryChainTracker {
  private readonly runs = new Map<string, number>();
  private maxLen = 0;

  /**
   * 观察一个 tool_result:失败 → 返回其链内序号;成功 → 结束该工具的链,返回 undefined。
   * `toolName` 缺失时两种情况都返回 undefined 且不改状态。
   */
  observe(toolName: string | undefined, failed: boolean): number | undefined {
    if (toolName === undefined || toolName === '') return undefined;
    if (!failed) {
      this.runs.delete(toolName);
      return undefined;
    }
    const n = (this.runs.get(toolName) ?? 0) + 1;
    this.runs.set(toolName, n);
    if (n > this.maxLen) this.maxLen = n;
    return n;
  }

  max(): number {
    return this.maxLen;
  }
}
