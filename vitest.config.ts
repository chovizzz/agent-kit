import { defineConfig } from 'vitest/config';

// 全仓唯一的 vitest 配置点:超时只在这里改(db/IO 类用例常驻 5s 默认值会偶发红)。
export const TEST_TIMEOUT_MS = 20_000;
// 每个用例要起十几次子进程的慢用例(如 test/ops/inventory-refresh):全量高负载下 120s 仍会偶发超时。
export const SLOW_TEST_TIMEOUT_MS = 300_000;

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/fixtures/**', 'node_modules/**', 'dist/**'],
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: TEST_TIMEOUT_MS,
    // beforeAll 挂掉在 vitest 里显示为 skipped;A12 要求 skipped=0,所以不允许 .skip/.todo 蔓延。
    allowOnly: false,
  },
});
