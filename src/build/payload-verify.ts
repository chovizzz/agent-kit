/**
 * 发布闸用的 payload 完整性校验(纯函数;文件读取与「重新构建」结果由调用方注入)。
 * 每个违规带稳定原因码(PAYLOAD_*),scripts/check-publish.mjs 原样输出。
 *
 * 校验顺序(前一项缺失时依赖它的后续项跳过,不重复报):
 *  1. 包清单里必须有 payload/manifest.json 与 integrity.json;
 *  2. 两者能解析且过 schema,kit_version 等于 package.json 的 version;
 *  3. integrity 的文件集合 == 包清单(去掉 integrity.json),逐文件重算 sha256/bytes;
 *  4. manifest 的每个条目对得上包内 payload 文件(sha 口径见 payloadFileSha),payload/files 下没有未登记文件,
 *     manifest 与 integrity 对同一文件的哈希一致;
 *  5. 不含 personal 来源;
 *  6. payload 与重新构建的结果、与仓库里的 out/ 逐字节一致;
 *  7. 禁运内容(绝对路径、HOME 路径)。
 */
import { PayloadIntegritySchema, PayloadManifestSchema } from '../contracts/payload.js';
import type { PayloadIntegrity, PayloadManifest } from '../contracts/payload.js';
import { byteCompare } from '../render/out-layout.js';
import {
  INTEGRITY_PATH,
  PAYLOAD_DIR,
  PAYLOAD_MANIFEST_PATH,
  payloadFileSha,
  sha256Bytes,
} from './payload.js';

export const PAYLOAD_CODES = [
  'PAYLOAD_MISSING_MANIFEST',
  'PAYLOAD_MISSING_INTEGRITY',
  'PAYLOAD_MANIFEST_INVALID',
  'PAYLOAD_INTEGRITY_INVALID',
  'PAYLOAD_VERSION_MISMATCH',
  'PAYLOAD_FILE_MISSING',
  'PAYLOAD_FILE_UNLISTED',
  'PAYLOAD_FILE_TAMPERED',
  'PAYLOAD_MANIFEST_MISMATCH',
  'PAYLOAD_PERSONAL_LEAK',
  'PAYLOAD_REBUILD_MISMATCH',
  'PAYLOAD_OUT_MISMATCH',
  'PAYLOAD_FORBIDDEN_CONTENT',
  'PAYLOAD_FORBIDDEN_PATH',
] as const;
export type PayloadCode = (typeof PAYLOAD_CODES)[number];

export interface PayloadViolation {
  code: PayloadCode;
  /** 相关路径(相对包根),可无 */
  path?: string;
  message: string;
}

export interface VerifyPayloadInput {
  /** `npm pack --dry-run` 的文件清单(相对包根) */
  packFiles: readonly string[];
  /** 读包内文件(相对包根);不存在返回 undefined */
  read: (rel: string) => Uint8Array | undefined;
  /** package.json 的 version */
  version: string;
  /** 由源码重新构建出的 payload 树(`payload/**` → 文本);给了才比对 */
  rebuilt?: ReadonlyMap<string, string>;
  /** 仓库里的 out/ 树(`<agent>/<target>/<path>` → 文本,不含 manifest.json);给了才比对 */
  outTree?: ReadonlyMap<string, string>;
  /** 构建机的 HOME(出现在内容里即泄漏);长度 < 2 的忽略 */
  homeDir?: string;
}

const text = (b: Uint8Array): string => Buffer.from(b).toString('utf8');

/** 绝对路径形态:真实用户目录。合成占位 /Users/someone 与 check-publish 的通用扫描保持同一口径。 */
const ABS_PATH_RES: readonly [RegExp, string][] = [
  [/\/Users\/(?!someone(?![A-Za-z0-9._-]))[A-Za-z0-9._-]+/u, '/Users/<name>'],
  [/\/home\/[A-Za-z_][A-Za-z0-9._-]*\//u, '/home/<name>/'],
  [/[A-Za-z]:\\Users\\/u, 'X:\\Users\\'],
];

function diffTrees(
  expected: ReadonlyMap<string, string>,
  actual: ReadonlyMap<string, string>,
): string[] {
  const out: string[] = [];
  for (const k of [...expected.keys()].sort(byteCompare)) {
    if (!actual.has(k)) out.push(`缺 ${k}`);
    else if (actual.get(k) !== expected.get(k)) out.push(`内容不同 ${k}`);
  }
  for (const k of [...actual.keys()].sort(byteCompare)) {
    if (!expected.has(k)) out.push(`多出 ${k}`);
  }
  return out;
}

const summarize = (items: readonly string[]): string =>
  `${items.slice(0, 5).join('; ')}${items.length > 5 ? `;…共 ${items.length} 处` : ''}`;

export function verifyPayload(input: VerifyPayloadInput): PayloadViolation[] {
  const v: PayloadViolation[] = [];
  const add = (code: PayloadCode, message: string, path?: string): void => {
    v.push({ code, message, ...(path !== undefined ? { path } : {}) });
  };
  const pack = new Set(input.packFiles);

  for (const p of input.packFiles) {
    if (p.split('/').some((seg) => /personal/iu.test(seg))) {
      add('PAYLOAD_FORBIDDEN_PATH', `包内出现 personal 路径`, p);
    }
    if (p === 'out' || p.startsWith('out/')) add('PAYLOAD_FORBIDDEN_PATH', `包内出现 out/`, p);
  }

  // 1) 必备文件
  const manifestBytes = pack.has(PAYLOAD_MANIFEST_PATH)
    ? input.read(PAYLOAD_MANIFEST_PATH)
    : undefined;
  const integrityBytes = pack.has(INTEGRITY_PATH) ? input.read(INTEGRITY_PATH) : undefined;
  if (manifestBytes === undefined) {
    add(
      'PAYLOAD_MISSING_MANIFEST',
      '包清单里没有 payload/manifest.json(先 node scripts/build-payload.mjs)',
      PAYLOAD_MANIFEST_PATH,
    );
  }
  if (integrityBytes === undefined) {
    add(
      'PAYLOAD_MISSING_INTEGRITY',
      '包清单里没有 integrity.json(先 node scripts/build-payload.mjs)',
      INTEGRITY_PATH,
    );
  }

  // 2) 解析
  let manifest: PayloadManifest | undefined;
  if (manifestBytes !== undefined) {
    try {
      const r = PayloadManifestSchema.safeParse(JSON.parse(text(manifestBytes)));
      if (r.success) manifest = r.data;
      else
        add(
          'PAYLOAD_MANIFEST_INVALID',
          `不符合 PayloadManifestSchema:${r.error.issues[0]?.message ?? ''}`,
          PAYLOAD_MANIFEST_PATH,
        );
    } catch {
      add('PAYLOAD_MANIFEST_INVALID', '不是合法 JSON', PAYLOAD_MANIFEST_PATH);
    }
  }
  let integrity: PayloadIntegrity | undefined;
  if (integrityBytes !== undefined) {
    try {
      const r = PayloadIntegritySchema.safeParse(JSON.parse(text(integrityBytes)));
      if (r.success) integrity = r.data;
      else
        add(
          'PAYLOAD_INTEGRITY_INVALID',
          `不符合 PayloadIntegritySchema:${r.error.issues[0]?.message ?? ''}`,
          INTEGRITY_PATH,
        );
    } catch {
      add('PAYLOAD_INTEGRITY_INVALID', '不是合法 JSON', INTEGRITY_PATH);
    }
  }
  if (manifest !== undefined && manifest.kit_version !== input.version) {
    add(
      'PAYLOAD_VERSION_MISMATCH',
      `manifest.kit_version(${manifest.kit_version})与 package.json(${input.version})不一致`,
      PAYLOAD_MANIFEST_PATH,
    );
  }
  if (integrity !== undefined && integrity.kit_version !== input.version) {
    add(
      'PAYLOAD_VERSION_MISMATCH',
      `integrity.kit_version(${integrity.kit_version})与 package.json(${input.version})不一致`,
      INTEGRITY_PATH,
    );
  }

  // 3) integrity ↔ 包清单 ↔ 实际字节
  const integrityByPath = new Map<string, { sha256: string; bytes: number }>();
  if (integrity !== undefined) {
    for (const f of integrity.files) integrityByPath.set(f.path, f);
    for (const f of integrity.files) {
      if (!pack.has(f.path)) {
        add('PAYLOAD_FILE_MISSING', 'integrity 登记了但包清单里没有', f.path);
        continue;
      }
      const b = input.read(f.path);
      if (b === undefined) {
        add('PAYLOAD_FILE_MISSING', 'integrity 登记了但读不到', f.path);
      } else if (sha256Bytes(b) !== f.sha256 || b.byteLength !== f.bytes) {
        add('PAYLOAD_FILE_TAMPERED', '内容的 sha256/字节数与 integrity 不符', f.path);
      }
    }
    for (const p of [...pack].sort(byteCompare)) {
      if (p !== INTEGRITY_PATH && !integrityByPath.has(p)) {
        add('PAYLOAD_FILE_UNLISTED', '包内文件没有登记在 integrity', p);
      }
    }
  }

  // 4) manifest ↔ payload 文件
  const actualPayload = new Map<string, string>();
  for (const p of [...pack].sort(byteCompare)) {
    if (p.startsWith(`${PAYLOAD_DIR}/`)) {
      const b = input.read(p);
      if (b === undefined) continue;
      const t = text(b);
      // 有损解码(非法 UTF-8 被替换成 U+FFFD)会让后面的字符串比较不等价于字节比较:直接拒绝
      if (!Buffer.from(t, 'utf8').equals(Buffer.from(b))) {
        add('PAYLOAD_MANIFEST_MISMATCH', '不是合法 UTF-8 文本(字节无法无损往返)', p);
      }
      actualPayload.set(p, t);
    }
  }
  if (manifest !== undefined) {
    const listed = new Set<string>([PAYLOAD_MANIFEST_PATH]);
    for (const f of manifest.files) {
      const rel = `${PAYLOAD_DIR}/${f.payload_path}`;
      listed.add(rel);
      if (f.target !== 'home' || f.payload_path !== `files/${f.agent}/${f.target}/${f.path}`) {
        add(
          'PAYLOAD_MANIFEST_MISMATCH',
          'payload_path 与 agent/target/path 不对应(或 target 不是 home)',
          rel,
        );
        continue;
      }
      const content = actualPayload.get(rel);
      if (content === undefined) {
        add('PAYLOAD_MANIFEST_MISMATCH', 'manifest 登记了但包内没有该 payload 文件', rel);
        continue;
      }
      if (Buffer.byteLength(content, 'utf8') !== f.bytes) {
        add('PAYLOAD_MANIFEST_MISMATCH', 'manifest 的 bytes 与文件不符', rel);
      }
      const sha = payloadFileSha(f.mode, content, f.block_id);
      if (sha === undefined || sha !== f.sha256) {
        add('PAYLOAD_MANIFEST_MISMATCH', 'manifest 的 sha256 与文件不符(或托管块结构不合法)', rel);
      }
      const ig = integrityByPath.get(rel);
      if (ig !== undefined && f.mode === 'owned' && ig.sha256 !== f.sha256) {
        add('PAYLOAD_MANIFEST_MISMATCH', 'manifest 与 integrity 对同一文件的 sha256 不一致', rel);
      }
    }
    for (const rel of actualPayload.keys()) {
      if (!listed.has(rel))
        add('PAYLOAD_MANIFEST_MISMATCH', 'payload 下的文件没有登记在 manifest', rel);
    }

    // 5) personal
    if (!manifest.skippedLayers.some((s) => s.layer === 'personal')) {
      add(
        'PAYLOAD_PERSONAL_LEAK',
        'skippedLayers 没有声明 personal 层被跳过',
        PAYLOAD_MANIFEST_PATH,
      );
    }
    for (const f of manifest.files) {
      for (const a of f.atoms) {
        if (a.layer === 'personal') {
          add(
            'PAYLOAD_PERSONAL_LEAK',
            `原子 ${a.id} 来自 personal 层`,
            `${PAYLOAD_DIR}/${f.payload_path}`,
          );
        }
      }
    }

    // 6b) 与仓库 out/ 一致
    if (input.outTree !== undefined) {
      const fromPayload = new Map<string, string>();
      for (const f of manifest.files) {
        const c = actualPayload.get(`${PAYLOAD_DIR}/${f.payload_path}`);
        if (c !== undefined) fromPayload.set(`${f.agent}/${f.target}/${f.path}`, c);
      }
      const homeOut = new Map([...input.outTree].filter(([k]) => k.split('/')[1] === 'home'));
      const d = diffTrees(homeOut, fromPayload);
      if (d.length > 0)
        add('PAYLOAD_OUT_MISMATCH', `payload 与 out/ 的 home 文件不一致:${summarize(d)}`);
    }
  }

  // 6a) 与重新构建一致
  if (input.rebuilt !== undefined) {
    const d = diffTrees(input.rebuilt, actualPayload);
    if (d.length > 0)
      add('PAYLOAD_REBUILD_MISMATCH', `payload 与重新构建的结果不一致:${summarize(d)}`);
  }

  // 7) 禁运内容
  for (const [rel, content] of actualPayload) {
    for (const [re, label] of ABS_PATH_RES) {
      if (re.test(content)) add('PAYLOAD_FORBIDDEN_CONTENT', `含绝对路径形态 ${label}`, rel);
    }
    if (
      input.homeDir !== undefined &&
      input.homeDir.length >= 2 &&
      content.includes(input.homeDir)
    ) {
      add('PAYLOAD_FORBIDDEN_CONTENT', '含构建机的 HOME 路径', rel);
    }
  }
  return v;
}
