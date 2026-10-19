#!/usr/bin/env node
/**
 * 薄入口(发布闸要求体积 ≤ 8KB)。启动器 / 主程序都惰性加载:先由启动器决定要不要把控制权交给 `current` 里的新版本,
 * 只有退回自身时才加载本版本的主程序,避免为一份马上被替换的代码付冷启动成本。
 */
const { launchAndSchedule } = await import('./src/update/launcher.js');
process.exitCode = await launchAndSchedule(
  process.argv.slice(2),
  async () => (await import('./src/cli.js')).main,
);
