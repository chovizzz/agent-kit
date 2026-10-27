/**
 * D7 判定(R20-A2 B5a 从 `l0/commit.ts` 抽出,行为不变):索引是否可写。
 * 单独成文件是为了让 `l0/commit.ts` 与 `services/projections.ts` 都能 import 它而不构成循环(projections 要用 commit.ts 的 `recomputeClusters`)。
 */

/** 索引 `ok` 且盐指纹一致,或索引缺失且 cursor 也缺失(首次);其余(损坏 / 盐不符 / 缺失但 cursor 在)都不可写,需 `--rebuild-index --write` */
export function indexWritable(
  prev: { status: 'ok'; saltFp: string } | { status: 'absent' | 'invalid' },
  cursorPresent: boolean,
  saltFp: string,
): boolean {
  const idxOk = prev.status === 'ok' && prev.saltFp === saltFp;
  return idxOk || (prev.status === 'absent' && !cursorPresent);
}
