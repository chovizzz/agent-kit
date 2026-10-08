import { defineConfig } from 'vitest/config';

// 全仓唯一的 vitest 配置点:超时只在这里改(db/IO 类用例常驻 5s 默认值会偶发红)。
export const TEST_TIMEOUT_MS = 20_000;

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
