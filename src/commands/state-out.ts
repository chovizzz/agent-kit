/**
 * `.state/<命令>/<id>/` 产物目录的落盘(promote / retire 共用):先写 `.tmp-<id>` 再整体 rename;目录 0700、文件 0600;
 * 一律经 safe-fs(写出口守卫);已存在时只在「权限未放宽、全部文件都在且逐字节一致」时报 existing,否则拒绝覆盖。
 * 失败抛 `StateOutError(reason)`,调用方映射成自己的退出码(都是 fail-closed 的 3)。
 */
import * as path from 'node:path';
import type { IoContext } from '../io/paths.js';
import { exists, lstat, readDir, readText } from '../io/read-fs.js';
import { chmod, mkdirp, rename, writeFile } from '../io/safe-fs.js';

export class StateOutError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

async function assertRealDir(dir: string): Promise<void> {
  if (!(await exists(dir))) return;
  const st = await lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new StateOutError('state_dir_unsafe');
}

async function assertRegularFile(file: string): Promise<void> {
  const st = await lstat(file);
  if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1) {
    throw new StateOutError('state_file_unsafe');
  }
}

async function put(io: IoContext, file: string, content: string): Promise<void> {
  await mkdirp(io, path.dirname(file), 0o700);
  await chmod(io, path.dirname(file), 0o700);
  await writeFile(io, file, content, { mode: 0o600 });
  await chmod(io, file, 0o600);
}

/** 写 `<stateDir>/<subdir>/<id>/`;返回 wrote / existing。`existsReason` = 已存在但不一致时的稳定码。 */
export async function writeStateOut(
  io: IoContext,
  subdir: string,
  id: string,
  files: Readonly<Record<string, string>>,
  existsReason: string,
): Promise<{ wrote: boolean; existing: boolean }> {
  const root = path.join(io.stateDir, subdir);
  const dir = path.join(root, id);
  const names = Object.keys(files);
  await assertRealDir(root);
  if (await exists(dir)) {
    await assertRealDir(dir);
    // 内容一致还不够:已有产物的权限被放宽(补丁里有规则与证据)也要拒,不能静默报「已存在」
    if (((await lstat(dir)).mode & 0o777) !== 0o700) throw new StateOutError('state_perm_unsafe');
    // 目录里只许有预期的产物:多出来的任何条目(文件 / 目录 / 符号链接)都不是「已存在且一致」
    const actual = (await readDir(dir)).map((e) => e.name).sort();
    if (actual.join('\0') !== [...names].sort().join('\0')) throw new StateOutError(existsReason);
    for (const n of names) {
      const f = path.join(dir, n);
      if (!(await exists(f))) throw new StateOutError(existsReason);
      await assertRegularFile(f);
      if (((await lstat(f)).mode & 0o777) !== 0o600) throw new StateOutError('state_perm_unsafe');
      if ((await readText(f)) !== files[n]) throw new StateOutError(existsReason);
    }
    return { wrote: false, existing: true };
  }
  const tmp = path.join(root, `.tmp-${id}`);
  if (await exists(tmp)) throw new StateOutError('tmp_exists');
  for (const n of names) await put(io, path.join(tmp, n), files[n] as string);
  await rename(io, tmp, dir);
  return { wrote: true, existing: false };
}
