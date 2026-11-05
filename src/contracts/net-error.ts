/**
 * 网络层稳定码(D-AU2 / 评审 H1):码表与类型放在 contracts,让零网络的 `update/policy.ts` 引它而不必 `import type` 到 `io/net.ts`
 * (后者会把 net.ts 带进钩子入口的 import 闭包,R20-1.1)。`io/net.ts` re-export,既有调用点不变。
 * `http_<码>` 另算;与 UPDATE_RESULT_CODES 中的网络类一一对应,host_denied 是网络层多出的策略拒绝。
 */
export const NET_ERROR_CODES = [
  'timeout',
  'dns',
  'connect',
  'tls',
  'proxy',
  'too_large',
  'parse',
  'host_denied',
] as const;
export type NetErrorCode = (typeof NET_ERROR_CODES)[number] | `http_${number}`;
