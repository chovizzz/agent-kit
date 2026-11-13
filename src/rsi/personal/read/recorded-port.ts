/**
 * 「head.json 记录的提交」的只读业务端口(contracts §21.24 W0-22 第 6 条):业务读侧(`rsi show`、`rsi auto clear` / `rsi rollback --to` 干跑)只依赖它,
 * 不暴露任何 exec / 路径 / 参数;适配器是 `git-readonly.ts`,在部署组装处(`src/rsi/auto/deps.ts`)注入。
 * 结果三态:`ok` / `missing`(对象确认不存在,仅 `readCommit`;调用方可按双读协议回到开头重试)/ `unreadable`(带封闭原因;一律 fail-closed,**不得**当成「空」)。
 * 未装配的实现 {@link unwiredRecordedRead} 恒 `unreadable(not_wired)`(退 3),绝不假装成功。
 */
export const RECORDED_UNREADABLE_WHYS = Object.freeze([
  'not_wired',
  'repo_unsafe',
  'config_rejected',
  'changed_during_read',
  'spawn_failed',
  'nonzero_exit',
  'output_limit',
  'timeout',
  'bad_oid',
  'bad_output',
] as const);
export type RecordedWhy = (typeof RECORDED_UNREADABLE_WHYS)[number];

export type RecordedRead<T> =
  { kind: 'ok'; value: T } | { kind: 'missing' } | { kind: 'unreadable'; why: RecordedWhy };

export interface RecordedTreeEntry {
  /** 仓库相对路径(`ls-tree -r -z --full-tree`) */
  path: string;
  /** 条目对象的 40 位小写十六进制 */
  oid: string;
  mode: string;
}

export interface RecordedReadPort {
  /** 提交存在性(`rev-parse --verify --quiet <oid>^{commit}`):不存在 = `missing` */
  readCommit(oid: string): Promise<RecordedRead<{ oid: string }>>;
  listTree(oid: string): Promise<RecordedRead<readonly RecordedTreeEntry[]>>;
  /** blob 全文(UTF-8) */
  readBlob(oid: string): Promise<RecordedRead<string>>;
}

const notWired = <T>(): Promise<RecordedRead<T>> =>
  Promise.resolve({ kind: 'unreadable', why: 'not_wired' });

export const unwiredRecordedRead: RecordedReadPort = Object.freeze({
  readCommit: () => notWired<{ oid: string }>(),
  listTree: () => notWired<readonly RecordedTreeEntry[]>(),
  readBlob: () => notWired<string>(),
});
