/**
 * 串行化:`runLlm` 的 cwd 是固定的 `<state>/reflect/cwd/`,并发调用会互相看到对方留下的文件
 * (运行前必须为空 / 运行后清空)。所以同一个 state 目录下的所有 LLM 调用排成一条链,一次只跑一个。
 */
const chains = new Map<string, Promise<void>>();

export function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}
