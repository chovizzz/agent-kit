/**
 * 枚举有、契约总表(docs/contracts.md §20.3)还没并入的码(「枚举先于文档」的例外清单;`rsi-codes-table` 与 `rsi-lock-snapshot` 两个一致性测试共用)。
 * 键 = `rsi-codes-table.test.ts` 里 CATS 的 `name`。**文档并入总表后差集为空,对应条目必须在同一次提交里删除。**
 *
 * R20-A2 B5-0:`binding_changed`(Q-B:tick 的 `skipped_binding_changed` 的报码,`RSI_NOT_RUN reason=binding_changed`,退 4)。
 */
export const PENDING_DOC: Readonly<Record<string, readonly string[]>> = {
  not_run: ['binding_changed'],
};

/**
 * 其中 §20.14 的订正条款**也还没写**的码(B5-0 不改 docs/contracts.md,订正文字在 B5 订正笔记里、由主代理并入)。
 * `rsi-codes-table` 对它们豁免「必须出现在 §20.14」这一条,并**反向断言它们确实还不在**——主代理并入订正后该断言变红,提醒同一次提交里删掉本清单。
 */
export const PENDING_NOTE_UNWRITTEN: Readonly<Record<string, readonly string[]>> = {
  not_run: ['binding_changed'],
};
