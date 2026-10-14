/**
 * 随 npm 包分发的预渲染 payload(S2,docs/contracts.md §19):out/ 里 target=home 的文件原样复制 +
 * `payload/manifest.json`(PayloadManifest)+ 包根 `integrity.json`(PayloadIntegrity)。
 *
 * 本文件只做**纯计算**:输入渲染结果,输出「相对包根的路径 → 文本」的树;不碰文件系统(写盘由
 * scripts/build-payload.mjs 做:payload/ 在仓库根,不在 io 层的写入根 out/ state KIT_TMP 之内)。
 * 确定性:内容只来自输入(没有时间戳、路径、环境),键按 UTF-8 字节序。
 */
import { createHash } from 'node:crypto';
import { PayloadIntegritySchema, PayloadManifestSchema } from '../contracts/payload.js';
import type { PayloadFile, PayloadIntegrity, PayloadKind } from '../contracts/payload.js';
import type { ChannelName } from '../contracts/config.js';
import type { ResolvedAtom } from '../contracts/merge.js';
import type { Manifest, OutFile } from '../contracts/render.js';
import type { Skill } from '../contracts/skill.js';
import { canonicalJson } from '../io/canonical-json.js';
import { parseManagedBlocks } from '../render/managed-block.js';
import { byteCompare, outKey } from '../render/out-layout.js';

export const PAYLOAD_DIR = 'payload';
export const PAYLOAD_MANIFEST_PATH = 'payload/manifest.json';
export const INTEGRITY_PATH = 'integrity.json';

export class PayloadBuildError extends Error {
  constructor(
    readonly code: 'PAYLOAD_PERSONAL_LEAK' | 'PAYLOAD_UNKNOWN_ATOM' | 'PAYLOAD_BLOCK_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'PayloadBuildError';
  }
}

export const sha256Bytes = (b: Uint8Array | string): string =>
  createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------------------
// kind 判定
// ---------------------------------------------------------------------------

/** 脚本类扩展名:技能目录里出现这些文件,技能按 executable 归类。 */
const SCRIPT_EXT = /\.(?:sh|bash|zsh|fish|py|rb|pl|js|mjs|cjs|ts|mts|ps1|bat|cmd)$/iu;

/** 技能资源里是否有「会被执行」的文件:`scripts/` 目录下的任何文件,或脚本扩展名。(Skill.files 不带权限位。) */
export function skillHasExecutableParts(skill: Pick<Skill, 'files'>): boolean {
  return skill.files.some(
    (f) =>
      f.relPath !== 'SKILL.md' && (f.relPath.startsWith('scripts/') || SCRIPT_EXT.test(f.relPath)),
  );
}

const RULE_FILES = new Set([
  '.codex/AGENTS.md',
  '.config/opencode/AGENTS.md',
  '.kimi-code/AGENTS.md',
  '.pi/agent/AGENTS.md',
]);
const RULE_DIRS = ['.claude/rules/agent-kit/'];
const SKILL_DIRS = ['.claude/skills/', '.agents/skills/'];
const AGENT_DIRS = ['.claude/agents/', '.codex/agents/', '.kimi-code/agents/'];

/**
 * 按落点和来源判定 kind。无法证明是纯指令的一律 `executable`(契约:未知类别按 executable 归类)。
 * - 技能:只有 `<dir>/<name>/SKILL.md` 且来源技能(sourceRefs `skill:<name>`)查得到、没有脚本类资源,才算 `skill`;
 * - 子代理:落在子代理目录、sourceRefs 是 `agent:<name>`,才算 `subagent`(工具能力如 shell 不改变类别);
 * - 规则:已知的规则落点,且文件没有 sourceRefs(规则文件由原子渲染)。
 */
export function classifyKind(
  file: Pick<OutFile, 'relPath' | 'sourceRefs'>,
  skillsByName: ReadonlyMap<string, Pick<Skill, 'files'>>,
): PayloadKind {
  const p = file.relPath;
  const refs = file.sourceRefs ?? [];
  if (RULE_FILES.has(p) || RULE_DIRS.some((d) => p.startsWith(d))) {
    return refs.length === 0 ? 'rules' : 'executable';
  }
  const skillDir = SKILL_DIRS.find((d) => p.startsWith(d));
  if (skillDir !== undefined) {
    const m = /^([^/]+)\/SKILL\.md$/u.exec(p.slice(skillDir.length));
    const ref = refs.length === 1 ? /^skill:(.+)$/u.exec(refs[0] as string) : null;
    if (m === null || ref === null || ref[1] !== m[1]) return 'executable';
    const skill = skillsByName.get(ref[1] as string);
    if (skill === undefined || skillHasExecutableParts(skill)) return 'executable';
    return 'skill';
  }
  if (AGENT_DIRS.some((d) => p.startsWith(d))) {
    const ok = refs.length === 1 && /^agent:.+$/u.test(refs[0] as string);
    return ok ? 'subagent' : 'executable';
  }
  return 'executable';
}

// ---------------------------------------------------------------------------
// 逐文件 sha 的口径
// ---------------------------------------------------------------------------

/**
 * owned:文件全文的 sha256;managed-block:块体的 sha256(口径同 managed-block.ts,取实际块体而非标记行自称的值)。
 * managed-block 文件必须恰含一个 id 等于 blockId 的块,且标记行里的 sha 等于实际块体;不满足返回 undefined。
 */
export function payloadFileSha(
  mode: PayloadFile['mode'],
  content: string,
  blockId?: string,
): string | undefined {
  if (mode === 'owned') return sha256Bytes(content);
  const parsed = parseManagedBlocks(content);
  if (!parsed.ok || parsed.blocks.length !== 1) return undefined;
  const b = parsed.blocks[0];
  if (b === undefined || b.id !== blockId || b.storedSha !== b.actualSha) return undefined;
  return b.actualSha;
}

// ---------------------------------------------------------------------------
// 构造
// ---------------------------------------------------------------------------

export interface PayloadInput {
  /** 渲染结果(全部文件;本函数只取 target=home) */
  files: readonly OutFile[];
  resolved: readonly ResolvedAtom[];
  skills: readonly Skill[];
  kitVersion: string;
  channel: ChannelName;
  /** 取自 out/manifest.json 的 skippedLayers(恒含 personal) */
  skippedLayers: Manifest['skippedLayers'];
}

export interface PayloadBundle {
  /** 相对包根的路径(`payload/manifest.json`、`payload/files/<agent>/home/<path>`)→ 文本;按字节序 */
  tree: Map<string, string>;
  manifestText: string;
}

export function buildPayload(input: PayloadInput): PayloadBundle {
  const byId = new Map<string, ResolvedAtom>();
  for (const r of input.resolved) byId.set(r.atom.fm.id, r);
  const skillsByName = new Map(input.skills.map((s) => [s.fm.name, s]));

  const home = input.files.filter((f) => f.target === 'home');
  const files: PayloadFile[] = [];
  const tree = new Map<string, string>();
  for (const f of [...home].sort((a, b) => byteCompare(outKey(a), outKey(b)))) {
    const key = outKey(f);
    const atoms = [...f.atomIds].sort(byteCompare).map((id) => {
      const r = byId.get(id);
      if (r === undefined) {
        throw new PayloadBuildError('PAYLOAD_UNKNOWN_ATOM', `${key} 引用了未知原子 ${id}`);
      }
      if (!r.coreEligible || r.layer === 'personal') {
        throw new PayloadBuildError(
          'PAYLOAD_PERSONAL_LEAK',
          `${key} 含不得进入 payload 的原子 ${id}(${r.layer})`,
        );
      }
      return { id, layer: r.layer, strength: r.atom.fm.strength };
    });
    let blockId: string | undefined;
    if (f.mode === 'managed-block') {
      const parsed = parseManagedBlocks(f.content);
      if (!parsed.ok || parsed.blocks.length !== 1) {
        throw new PayloadBuildError('PAYLOAD_BLOCK_INVALID', `${key} 不是恰含一个托管块的文件`);
      }
      blockId = (parsed.blocks[0] as { id: string }).id;
    }
    const sha256 = payloadFileSha(f.mode, f.content, blockId);
    if (sha256 === undefined) {
      throw new PayloadBuildError('PAYLOAD_BLOCK_INVALID', `${key} 的托管块标记与块体不符`);
    }
    const payloadPath = `files/${key}`;
    files.push({
      agent: f.agent,
      target: 'home',
      path: f.relPath,
      mode: f.mode,
      ...(blockId !== undefined ? { block_id: blockId } : {}),
      kind: classifyKind(f, skillsByName),
      confidence: f.confidence,
      ...(f.conditional !== undefined ? { conditional: f.conditional } : {}),
      sha256,
      bytes: Buffer.byteLength(f.content, 'utf8'),
      payload_path: payloadPath,
      atoms,
    });
    tree.set(`${PAYLOAD_DIR}/${payloadPath}`, f.content);
  }

  const manifest = PayloadManifestSchema.parse({
    schema_version: 1,
    kit_version: input.kitVersion,
    channel: input.channel,
    files,
    migrations: [],
    skippedLayers: [...input.skippedLayers].sort((a, b) =>
      byteCompare(canonicalJson(a), canonicalJson(b)),
    ),
  });
  const manifestText = canonicalJson(manifest);
  tree.set(PAYLOAD_MANIFEST_PATH, manifestText);
  return {
    tree: new Map([...tree].sort((a, b) => byteCompare(a[0], b[0]))),
    manifestText,
  };
}

// ---------------------------------------------------------------------------
// integrity.json
// ---------------------------------------------------------------------------

export interface IntegrityEntryInput {
  /** 相对包根 */
  path: string;
  content: Uint8Array;
}

/** 包内每个文件(不含 integrity.json 自己)的逐文件哈希,按 path 字节序严格升序。 */
export function buildIntegrity(
  kitVersion: string,
  entries: readonly IntegrityEntryInput[],
): { integrity: PayloadIntegrity; text: string } {
  const files = entries
    .filter((e) => e.path !== INTEGRITY_PATH)
    .map((e) => ({ path: e.path, sha256: sha256Bytes(e.content), bytes: e.content.byteLength }))
    .sort((a, b) => byteCompare(a.path, b.path));
  const integrity = PayloadIntegritySchema.parse({
    schema_version: 1,
    kit_version: kitVersion,
    algorithm: 'sha256',
    files,
  });
  return { integrity, text: canonicalJson(integrity) };
}
