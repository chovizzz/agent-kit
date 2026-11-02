/**
 * 枚举有、契约总表(docs/contracts.md §20.3)还没并入的码(「枚举先于文档」的例外清单;`rsi-codes-table` 与 `rsi-lock-snapshot` 两个一致性测试共用)。
 * 键 = `rsi-codes-table.test.ts` 里 CATS 的 `name`。**文档并入总表后差集为空,对应条目必须在同一次提交里删除。**
 *
 * R20-A2 B5e:B5-0 登记的 `binding_changed`(拍板 Q-B,tick 的 `skipped_binding_changed` 的报码)已并入 §20.3 总表,订正正文在 §20.14 B5-0-1;
 * 例外清单随之清空(本文件保留为空表,下一次「枚举先于文档」的例外照此登记、并入后同一次提交删除)。
 */
export const PENDING_DOC: Readonly<Record<string, readonly string[]>> = {
  // R20-A4(docs/contracts.md §20.16 R20-16.21 / R20-16.5 / R20-16.14):A4 启用的码;总表待主代理并入
  usage: ['missing:--json', 'missing:--digest', 'missing:--owner'],
  not_run: ['purge_pending', 'digest_backlog', 'policy_changed', 'rate_limited'],
  top1: ['RSI_INGEST_TOO_LARGE', 'RSI_STAGING_FULL', 'RSI_INGEST_REJECTED'],
};

/**
 * 其中 §20.14 的订正条款**也还没写**的码(`rsi-codes-table` 对它们豁免「必须出现在 §20.14」这一条,并**反向断言它们确实还不在**)。
 * 已清空:`binding_changed` 的订正已写进 §20.14 B5-0-1。
 */
export const PENDING_NOTE_UNWRITTEN: Readonly<Record<string, readonly string[]>> = {
  // `missing:--json|--digest|--owner` 是 A4 实装时按 `missing:--agent` 的写法登记的 USAGE 原因码,契约 §20.16 没写具体码(待主代理定夺并入)
  usage: ['missing:--json', 'missing:--digest', 'missing:--owner'],
};
