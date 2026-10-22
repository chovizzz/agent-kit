/**
 * 临时 git 仓库的「后台维护」闸:git commit/merge 等命令会 detach 一个 `git maintenance run --auto`(或 gc --auto),
 * 它在 .git/objects 下创建又删除 maintenance.lock;此时测试若恰好遍历 .git,lstat 会 ENOENT(CI 偶发红的根因)。
 * 所以每个测试建的临时仓库都必须:① 每条 git 命令带这些 -c(不依赖仓库已有配置);② init 后写进仓库级配置。
 */
export const GIT_NO_AUTO_ARGS = ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0'] as const;

/** init 之后要写进仓库级配置的键值(不动全局配置) */
export const GIT_NO_AUTO_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ['maintenance.auto', 'false'],
  ['gc.auto', '0'],
];
