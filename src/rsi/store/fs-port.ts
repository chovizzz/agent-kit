/**
 * 存储核的文件端口(SOLID 的 D):账 / 审计 / 压缩文件的全部 I/O 经这个窄接口,真实现建在 `safe-fs` / `read-fs` 上,
 * 测试用同一接口的故障注入包装(ENOSPC / EACCES / rename 失败 / 部分写 / fsync 失败)。名字都是 `.state/rsi/` 下的相对文件名,
 * 端口不接受路径分隔符(防逃逸)。**只有 `src/rsi/store/**` 与存储核自己的测试可以 import 本文件**(`test/rsi/store/arch.test.ts` 钉住)。
 */
import * as path from 'node:path';
import { RSI_FILE_MODE } from '../../contracts/rsi.js';
import type { IoContext } from '../../io/paths.js';
import { readFileSafe } from '../../io/read-fs.js';
import { appendFileSynced, createExclusiveSynced, remove, rename } from '../../io/safe-fs.js';
import { RSI_FILE_OWNER } from '../lock-read.js';
import { rsiDir } from '../rsi-dir.js';
import { StoreError } from './errors.js';

export type StoreFileRead =
  { kind: 'ok'; bytes: Buffer } | { kind: 'missing' } | { kind: 'unsafe'; why: string };

export interface StoreFs {
  /** 已确认安全的 `.state/rsi` 目录(真实现有;内存假件可无)。与 `LockCap.path` 一起验 root 归属 */
  readonly root?: string;
  /** 句柄级安全读;不存在 = `missing`,链接 / 非普通文件 / 超限 / I/O 错 = `unsafe`(调用方 fail-closed,不当作不存在) */
  read(name: string, maxBytes: number): Promise<StoreFileRead>;
  /** 写临时文件 `<name>.tmp`:先清掉上次崩溃的残留,再独占创建并 fsync;失败 = 抛错,不留半截文件 */
  writeTmp(name: string, text: string): Promise<void>;
  /** `<name>.tmp` → `<name>`(提交点) */
  commitTmp(name: string): Promise<void>;
  /** 清理 `<name>.tmp`(提交失败后尽力而为) */
  removeTmp(name: string): Promise<void>;
  /** 单次 `O_APPEND` + fsync(短写 = 抛错,已写出的前缀留在文件里,由撕裂尾分类处理) */
  appendSynced(name: string, text: string): Promise<void>;
}

const NAME_RE = /^[a-z][a-z0-9.-]*$/;
const checkName = (name: string): void => {
  if (!NAME_RE.test(name)) throw new StoreError('store_io', 'bad_file_name');
};

/** 真实现:`dir` 是已确认安全的 `.state/rsi` 目录(`openRsiStoreFs` 经 `rsiDir` 取得) */
export function safeStoreFs(io: IoContext, dir: string): StoreFs {
  const abs = (n: string): string => {
    checkName(n);
    return path.join(dir, n);
  };
  return {
    root: dir,
    async read(name, maxBytes) {
      const r = await readFileSafe(abs(name), { maxBytes, owner: RSI_FILE_OWNER });
      if (r.kind === 'ok') return { kind: 'ok', bytes: r.bytes };
      if (r.kind === 'missing') return { kind: 'missing' };
      return { kind: 'unsafe', why: r.why };
    },
    async writeTmp(name, text) {
      const tmp = `${abs(name)}.tmp`;
      await remove(io, tmp);
      await createExclusiveSynced(io, tmp, text, RSI_FILE_MODE);
    },
    async commitTmp(name) {
      await rename(io, `${abs(name)}.tmp`, abs(name));
    },
    async removeTmp(name) {
      await remove(io, `${abs(name)}.tmp`);
    },
    async appendSynced(name, text) {
      await appendFileSynced(io, abs(name), text, RSI_FILE_MODE);
    },
  };
}

/** 写侧入口:建 / 校验 `.state/rsi`(会建目录,所以只有真要写的装配才调) */
export async function openRsiStoreFs(io: IoContext): Promise<StoreFs> {
  return safeStoreFs(io, await rsiDir(io));
}
