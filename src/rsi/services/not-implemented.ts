/**
 * R20-A2 B5-0:B5 共享服务签名桩的统一出口(只有类型与 `throw`,不实现任何行为)。
 * 实装块把桩函数体整个替换掉;**签名一律不得改**(由 `test/rsi/b5-stubs.test.ts` 的类型断言钉住)。改签名要走主代理。
 * `args` 只是让桩的形参算「已使用」(`noUnusedParameters`),不参与任何逻辑。
 */
export function notImplemented(name: string, ...args: readonly unknown[]): never {
  void args;
  throw new Error(`not implemented: ${name}`);
}
