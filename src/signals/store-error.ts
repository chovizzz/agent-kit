/** 信号库里有无法解析的行:库已带病,不再往里追加(fail-closed)。从 `state-store.ts` 原样拆出(装配块 A 段):读侧闭包不含该文件的写出口。 */
export class SignalStoreError extends Error {
  readonly code = 'SIGNALS_STORE_CORRUPT';
}
