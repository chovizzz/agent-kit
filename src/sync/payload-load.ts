import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PayloadIntegritySchema,
  PayloadManifestSchema,
  type PayloadManifest,
} from '../contracts/payload.js';
import { canonicalJson } from '../io/canonical-json.js';
import { existsSync, lstat, readBytes, realpath } from '../io/read-fs.js';
import { payloadFileSha } from '../build/payload.js';
import { MAX_READ_BYTES, sha256Of } from './snapshot.js';

/**
 * S4:从包内 `payload/` 读 manifest 与文件,使用前用包根 `integrity.json` 逐文件核对 sha256。
 * 缺失 / 篡改 / 结构非法 → `SYNC_PAYLOAD_INVALID`(退出 3);找不到 payload → `SYNC_NO_PAYLOAD`(退出 4)。
 * 只读:不写盘。
 */

export class SyncPayloadError extends Error {
  constructor(
    readonly code: 'SYNC_NO_PAYLOAD' | 'SYNC_PAYLOAD_INVALID',
    readonly detail: string,
  ) {
    super(`${code} ${detail}`);
    this.name = 'SyncPayloadError';
  }
}

export interface LoadedPayload {
  manifest: PayloadManifest;
  /** `canonicalJson(manifest)` 字节的 sha256(登记表头 / txn 的 payload_sha256) */
  manifestSha256: string;
  /** 本次加载实际读到的包根 `integrity.json` 原始字节的 sha256(自动同步据此对外部锚点:读到的就是锚点认可的那份) */
  integritySha256: string;
  /** `payload_path` → 文件文本(已通过 integrity 核对) */
  contents: ReadonlyMap<string, string>;
  /** `payload_path` → 计划器要的 sha(owned = 全文,managed-block = 块体);算不出为空串 */
  payloadSha: Readonly<Record<string, string>>;
}

/** 包根:本模块往上找到的第一个含 package.json 的目录(dev = 仓库根,安装后 = 包目录)。 */
export function packageRoot(): string | undefined {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/**
 * payload 所在的「包根」目录(含 `payload/` 与 `integrity.json`)。
 * `KIT_PAYLOAD_DIR` 只在它严格位于 KIT_TMP 之内时生效(测试夹具用);否则忽略,用包相对路径。
 */
export async function resolvePayloadRoot(
  env: Readonly<Record<string, string | undefined>> | undefined,
  tmpDir: string | undefined,
): Promise<string | undefined> {
  const override = env?.['KIT_PAYLOAD_DIR'];
  if (override !== undefined && override !== '' && tmpDir !== undefined) {
    try {
      const tmp = await realpath(tmpDir);
      const dir = await realpath(path.resolve(override));
      const rel = path.relative(tmp, dir);
      if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) return dir;
    } catch {
      // 不可解析 → 忽略
    }
  }
  return packageRoot();
}

async function readRegular(root: string, rel: string): Promise<Uint8Array | undefined> {
  const abs = path.join(root, ...rel.split('/'));
  let st;
  try {
    st = await lstat(abs);
  } catch {
    return undefined;
  }
  if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_READ_BYTES) return undefined;
  return readBytes(abs);
}

const invalid = (detail: string): SyncPayloadError =>
  new SyncPayloadError('SYNC_PAYLOAD_INVALID', detail);

export async function loadPayload(root: string | undefined): Promise<LoadedPayload> {
  if (root === undefined) throw new SyncPayloadError('SYNC_NO_PAYLOAD', 'no_package_root');
  const manifestBytes = await readRegular(root, 'payload/manifest.json');
  if (manifestBytes === undefined) {
    // payload/ 目录整体不存在才算「没有 payload」;存在但 manifest 缺失是残缺
    let dirExists = true;
    try {
      await lstat(path.join(root, 'payload'));
    } catch {
      dirExists = false;
    }
    throw dirExists
      ? invalid('manifest_missing')
      : new SyncPayloadError('SYNC_NO_PAYLOAD', 'absent');
  }
  const integrityBytes = await readRegular(root, 'integrity.json');
  if (integrityBytes === undefined) throw invalid('integrity_missing');
  let integrity;
  try {
    const parsed = PayloadIntegritySchema.safeParse(
      JSON.parse(Buffer.from(integrityBytes).toString('utf8')),
    );
    if (!parsed.success) throw invalid('integrity_schema');
    integrity = parsed.data;
  } catch (e) {
    if (e instanceof SyncPayloadError) throw e;
    throw invalid('integrity_parse');
  }
  const expected = new Map(integrity.files.map((f) => [f.path, f] as const));
  const check = (rel: string, bytes: Uint8Array): void => {
    const want = expected.get(rel);
    if (want === undefined) throw invalid('not_in_integrity');
    if (want.sha256 !== sha256Of(bytes) || want.bytes !== bytes.byteLength) {
      throw invalid('integrity_mismatch');
    }
  };
  check('payload/manifest.json', manifestBytes);

  let manifest: PayloadManifest;
  try {
    const parsed = PayloadManifestSchema.safeParse(
      JSON.parse(Buffer.from(manifestBytes).toString('utf8')),
    );
    if (!parsed.success) throw invalid('manifest_schema');
    manifest = parsed.data;
  } catch (e) {
    if (e instanceof SyncPayloadError) throw e;
    throw invalid('manifest_parse');
  }
  if (manifest.kit_version !== integrity.kit_version) throw invalid('version_mismatch');

  const contents = new Map<string, string>();
  const payloadSha: Record<string, string> = {};
  for (const f of manifest.files) {
    if (f.target !== 'home') continue;
    const rel = `payload/${f.payload_path}`;
    const bytes = await readRegular(root, rel);
    if (bytes === undefined) throw invalid('file_missing');
    check(rel, bytes);
    const text = Buffer.from(bytes).toString('utf8');
    contents.set(f.payload_path, text);
    payloadSha[f.payload_path] = payloadFileSha(f.mode, text, f.block_id) ?? '';
  }
  return {
    manifest,
    manifestSha256: sha256Of(canonicalJson(manifest)),
    integritySha256: sha256Of(integrityBytes),
    contents,
    payloadSha,
  };
}
