/** 守卫用的路径判定。全部是字符串比较,不碰文件系统。 */

/**
 * 原子文件:`rules/**.md` 与 `.kit/rules/**.md`。比 lint 的发现规则更宽(任意深度、前缀与扩展名不区分大小写):
 * 在 macOS 默认的大小写不敏感文件系统上 `Rules/x.MD` 会被 lint 读到,守卫不能比 lint 窄。
 */
export function isAtomPath(p: string): boolean {
  const lower = p.toLowerCase();
  return (lower.startsWith('rules/') || lower.startsWith('.kit/rules/')) && lower.endsWith('.md');
}

export function isUnderDir(p: string, dir: string): boolean {
  return p.startsWith(`${dir}/`);
}

/** git 树里理论上不会出现、但手工构造的树可能带的路径:空段、`.`、`..`、反斜杠、NUL。 */
export function isUnsafePath(p: string): boolean {
  if (p === '' || p.includes('\\') || p.includes('\0')) return true;
  return p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

export function isRegularMode(mode: string): boolean {
  return mode === '100644' || mode === '100755';
}
