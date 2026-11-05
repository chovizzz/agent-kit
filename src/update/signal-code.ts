/**
 * 子进程被信号终止 / 超时时的退出码折算(shell 惯例 128 + 信号号;未知信号或没有信号记为 129)。
 * 启动器与钩子转发共用(D-AU1 / 评审 H4)。零依赖。
 */
const SIGNAL_NUMBERS: Readonly<Record<string, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGPIPE: 13,
  SIGTERM: 15,
};

export function signalCode(signal: string | null): number {
  return 128 + (signal === null ? 1 : (SIGNAL_NUMBERS[signal] ?? 1));
}
