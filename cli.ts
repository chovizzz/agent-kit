#!/usr/bin/env node
/**
 * 薄入口(发布闸要求体积 ≤ 8KB)。启动器 / 主程序都惰性加载:先由启动器决定要不要把控制权交给 `current` 里的新版本,
 * 只有退回自身时才加载本版本的主程序,避免为一份马上被替换的代码付冷启动成本。
 *
 * 例外(契约 R20-1.2a / D-AU1):钩子形状 `rsi poke` / `rsi hint` / `__rsi`(前面可夹全局选项)在加载启动器**之前**分流到零网络入口
 * `src/rsi/hook-entry.ts`:不经启动器(它的闭包含 net.ts)、不提示自动同步;由 hook-entry 经零网络桥接按同一判据转发到 `current`,
 * 并由 poke 顺带调度后台更新(D-AU2)。判定与 `hookShapeOf` 同口径(测试对拍)。
 */
const argv = process.argv.slice(2);
let i = 0;
while (i < argv.length && String(argv[i]).startsWith('-'))
  i += argv[i] === '--root' || argv[i] === '--overlay' ? 2 : 1;
const isHook =
  argv[i] === '__rsi' || (argv[i] === 'rsi' && (argv[i + 1] === 'poke' || argv[i + 1] === 'hint'));
if (isHook) {
  process.exitCode = await (await import('./src/rsi/hook-entry.js')).runHookEntry(argv);
} else {
  const { launchAndSchedule } = await import('./src/update/launcher.js');
  process.exitCode = await launchAndSchedule(argv, async () => (await import('./src/cli.js')).main);
}
