/** 退出码约定(全仓唯一定义;docs/contracts.md 同表)。 */
export const ExitCode = {
  /** 成功 */
  OK: 0,
  /** 检查失败(lint / budget / guard 判不通过) */
  CHECK_FAILED: 1,
  /** 用法错误(未知命令、缺参数) */
  USAGE: 2,
  /** fail-closed(脱敏异常/超时、写出口拒绝、内部不变量破坏) */
  FAIL_CLOSED: 3,
  /** 未执行(依赖缺失,例如网络审计工具不可用) */
  NOT_RUN: 4,
  /** 未实现(命令桩;P1+ 才有) */
  NOT_IMPLEMENTED: 64,
} as const;
export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
