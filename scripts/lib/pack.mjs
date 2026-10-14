/** 发布脚本共用:`npm pack --dry-run` 的真实文件清单(不落地 tarball)。 */
import { execFileSync } from 'node:child_process';

export function packFileList(cwd) {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out)[0].files.map((f) => f.path);
}
