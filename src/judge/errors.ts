/** judge 模块的错误类型。消息里不放任何来自提案/评审输出的文本(诊断输出不能泄露它要拦的东西)。 */

/** 运行目录或提案/规则文件损坏、缺失、不一致:fail-closed(命令退出 3),调用前整体中止。 */
export class JudgeStateError extends Error {
  readonly code = 'JUDGE_STATE_INVALID';
}

/** 提示复扫残留(pass2 命中)或超长:无法证明安全,不发送(命令退出 3)。 */
export class JudgeFailClosedError extends Error {
  readonly code = 'JUDGE_FAIL_CLOSED';
}

/** `judge.provider` 与成功那一跳的槽位 id 不一致(docs/contracts.md §16 的「待 R4」校验)。 */
export class JudgeProviderMismatchError extends Error {
  readonly code = 'JUDGE_PROVIDER_MISMATCH';
}
