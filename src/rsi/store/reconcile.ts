/**
 * `ReconcileSource` 的未接线实现(B1a 只有类型 + 测试假件 + 本文件):任何调用都抛 `compact_unwired`(fail-closed,不得以空扫描通过)。
 * 真适配器(读私有仓库记录)归 B1b,C 注入。
 */
import { StoreError } from './errors.js';
import type { ReconcileSource } from './ports.js';

const unwired = (): Promise<never> => Promise.reject(new StoreError('compact_unwired'));

export const unwiredReconcileSource: ReconcileSource = Object.freeze({
  entriesThrough: unwired,
  batchesThrough: unwired,
  derivedThrough: unwired,
  resolve: unwired,
});
