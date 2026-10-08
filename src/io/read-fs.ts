/**
 * 唯一的文件系统「读」出口之一(另一个是 safe-fs.ts 的内部校验)。
 * 本文件只导出读 API:不 import、不导出任何写 API。eslint 把 `node:fs` 系列限定在
 * src/io/{read-fs,safe-fs}.ts 两个文件内(见 eslint.config.js)。
 *
 * 读取本身不受 KIT_WRITE_ROOTS 约束:reader 通过 `--source` 显式读真实会话目录。
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';

export type { Stats, Dirent } from 'node:fs';

/** 目录项,按名字的 UTF-16 码元序(即字节序近似)排序,保证遍历顺序确定。 */
export interface DirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export async function readText(path: string): Promise<string> {
  return fsp.readFile(path, 'utf8');
}

export async function readBytes(path: string): Promise<Uint8Array> {
  return fsp.readFile(path);
}

export async function readDir(path: string): Promise<DirEntry[]> {
  const entries = await fsp.readdir(path, { withFileTypes: true });
  return entries
    .map((e) => ({
      name: e.name,
      isFile: e.isFile(),
      isDirectory: e.isDirectory(),
      isSymbolicLink: e.isSymbolicLink(),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export async function stat(path: string): Promise<fs.Stats> {
  return fsp.stat(path);
}

export async function lstat(path: string): Promise<fs.Stats> {
  return fsp.lstat(path);
}

export async function realpath(path: string): Promise<string> {
  return fsp.realpath(path);
}

export async function exists(path: string): Promise<boolean> {
  try {
    await fsp.access(path);
    return true;
  } catch {
    return false;
  }
}

export function existsSync(path: string): boolean {
  return fs.existsSync(path);
}

export function readTextSync(path: string): string {
  return fs.readFileSync(path, 'utf8');
}

export function lstatSync(path: string): fs.Stats {
  return fs.lstatSync(path);
}

export function realpathSync(path: string): string {
  return fs.realpathSync(path);
}

/**
 * 逐行流式读取(行分隔符只认 \n,行尾的一个 \r 一并去掉,保留空行)。reader 读大 JSONL 用它,不要整个读进内存。
 * 不用 node:readline:它还把 U+2028/U+2029/孤立 \r 当行分隔符,会把 JSON 字符串里的裸 U+2028 切成两行,
 * 与口径 C2(只认 \n)及 jq 对不上。
 */
export async function* readLines(path: string): AsyncGenerator<string, void, undefined> {
  const stream = fs.createReadStream(path, { encoding: 'utf8' });
  let buf = '';
  const strip = (l: string): string => (l.endsWith('\r') ? l.slice(0, -1) : l);
  try {
    for await (const chunk of stream) {
      buf += chunk as string;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        yield strip(line);
      }
    }
    if (buf.length > 0) yield strip(buf);
  } finally {
    stream.destroy();
  }
}
