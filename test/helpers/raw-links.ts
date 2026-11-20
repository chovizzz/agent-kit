import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

/**
 * 测试夹具专用:在 safe-fs / home-fs 的「拒硬链接」守卫之外,对**临时目录里**的文件做 link / unlink。
 * 为什么需要:新协议(renameExclusive / 墓碑)的中间态是 nlink=2(甚至对抗性的 nlink=3),
 * 守卫(safe-fs assertWritable、home-fs classifyLeaf)对 nlink>1 的名字一律拒绝读写 / 删除,所以夹具无法用它们在中间态里「换上别人的文件」或造第三个名字。
 * 这里不放宽任何产品守卫;被测代码仍只走 home-fs / safe-fs。只允许绝对路径。
 * eslint 对本文件单独放开 node:fs(见 eslint.config.js);测试不得用它写文件内容。
 */
function abs(p: string): string {
  if (!path.isAbsolute(p)) throw new Error(`raw-links: 只接受绝对路径:${p}`);
  return p;
}

/** 给已存在的文件再加一个名字(不检查来源 nlink) */
export async function rawLink(existing: string, newPath: string): Promise<void> {
  await fsp.link(abs(existing), abs(newPath));
}

/** 删掉一个名字(不检查 nlink);不存在则抛 */
export async function rawUnlink(target: string): Promise<void> {
  await fsp.unlink(abs(target));
}
