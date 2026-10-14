/**
 * S4 测试世界:KIT_TMP 之内的假 HOME + 假「包根」(payload/ + integrity.json 夹具)。
 * 本文件不 import home-fs(只 apply*.test.ts 可以);写盘只经 safe-fs(夹具),被测代码经命令层。
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { RenderAgentId } from '../../src/contracts/common.js';
import { PayloadManifestSchema, type PayloadManifest } from '../../src/contracts/payload.js';
import { buildIntegrity, payloadFileSha } from '../../src/build/payload.js';
import { createSyncCommand, type SyncCommandDeps } from '../../src/commands/sync.js';
import type { EnvCommandContext } from '../../src/commands/reflect.js';
import { canonicalJson } from '../../src/io/canonical-json.js';
import { createIoContext } from '../../src/io/paths.js';
import type { IoContext } from '../../src/io/paths.js';
import { exists, lstat, readBytes, readDir, readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { renderManagedBlock } from '../../src/render/managed-block.js';
import { REPO_ROOT, makeTempDir } from '../helpers/tmp.js';

export const sha = (s: string | Uint8Array): string => createHash('sha256').update(s).digest('hex');

export const CANARY_PAYLOAD = 'kit-canary-PAYLOAD-7f3a';
export const CANARY_USER = 'kit-canary-USER-91bc';
export const BLOCK_ID = 'agent-kit-rules';

export interface FixtureFile {
  agent: RenderAgentId;
  path: string;
  /** owned:文件全文;block:块体 */
  content: string;
  block?: string;
  kind?: 'rules' | 'skill' | 'subagent' | 'executable';
  must?: boolean;
}

export const SKILL = '.claude/skills/commit-checklist/SKILL.md';
export const SHARED = '.agents/skills/commit-checklist/SKILL.md';
export const RULES = '.claude/rules/agent-kit/org.md';
export const CODEX_MD = '.codex/AGENTS.md';
export const PI_MD = '.pi/agent/AGENTS.md';
export const KIMI_MD = '.kimi-code/AGENTS.md';

export const skillText = (v: string): string =>
  `---\nname: commit-checklist\ndescription: 提交前清单 ${v}\n---\n\n提交前检查清单 ${CANARY_PAYLOAD} ${v}\n`;

export function stdFixture(v = 'v1'): FixtureFile[] {
  const skill = skillText(v);
  const rules = `# 团队规则 ${v}\n\n先写测试。${CANARY_PAYLOAD}\n`;
  const body = `规则块 ${v}\n- 先读后改。${CANARY_PAYLOAD}\n`;
  return [
    { agent: 'claude', path: SKILL, content: skill, kind: 'skill' },
    { agent: 'claude', path: RULES, content: rules, kind: 'rules' },
    { agent: 'codex', path: SHARED, content: skill, kind: 'skill' },
    { agent: 'codex', path: CODEX_MD, content: body, block: BLOCK_ID, kind: 'rules' },
    { agent: 'pi', path: SHARED, content: skill, kind: 'skill' },
    { agent: 'pi', path: PI_MD, content: body, block: BLOCK_ID, kind: 'rules' },
    { agent: 'kimi', path: SHARED, content: skill, kind: 'skill' },
    { agent: 'kimi', path: KIMI_MD, content: body, block: BLOCK_ID, kind: 'rules' },
  ];
}

export interface World {
  dir: string;
  home: string;
  payloadRoot: string;
  io: IoContext;
  env: Record<string, string>;
  /** 在假 HOME 里放文件(夹具,经 safe-fs) */
  put(rel: string, content: string, mode?: number): Promise<void>;
  read(rel: string): Promise<string>;
  has(rel: string): Promise<boolean>;
  /** 重写 payload 夹具 */
  setPayload(
    files: FixtureFile[],
    over?: { migrations?: unknown[]; kitVersion?: string },
  ): Promise<void>;
  run(
    args: string[],
    o?: { noHome?: boolean; deps?: SyncCommandDeps; env?: Record<string, string> },
  ): Promise<{ code: number; out: string; err: string }>;
}

export async function newWorld(label: string): Promise<World> {
  const { dir } = await makeTempDir(label);
  const env = { KIT_TMP: dir, PATH: '/usr/bin:/bin' };
  const io = createIoContext({ cwd: REPO_ROOT, env });
  const home = path.join(dir, 'home');
  const payloadRoot = path.join(dir, 'pkg');
  await safe.mkdirp(io, home);
  await safe.mkdirp(io, payloadRoot);
  const w: World = {
    dir,
    home,
    payloadRoot,
    io,
    env,
    async put(rel, content, mode) {
      const abs = path.join(home, rel);
      await safe.mkdirp(io, path.dirname(abs));
      await safe.writeFile(io, abs, content, mode !== undefined ? { mode } : {});
    },
    read: (rel) => readText(path.join(home, rel)),
    has: (rel) => exists(path.join(home, rel)),
    async setPayload(files, over = {}) {
      await writePayloadFixture(w, files, over);
    },
    async run(args, o = {}) {
      const out: string[] = [];
      const err: string[] = [];
      const ctx: EnvCommandContext = {
        argv: [...(o.noHome === true ? [] : ['--home', home]), ...args],
        io,
        overlayPath: undefined,
        stdout: (t) => void out.push(t),
        stderr: (t) => void err.push(t),
        env: { ...env, KIT_PAYLOAD_DIR: payloadRoot, ...o.env },
      };
      const code = await createSyncCommand(o.deps).run(ctx);
      return { code, out: out.join(''), err: err.join('') };
    },
  };
  return w;
}

export async function writePayloadFixture(
  w: Pick<World, 'io' | 'payloadRoot'>,
  files: FixtureFile[],
  over: { migrations?: unknown[]; kitVersion?: string } = {},
): Promise<PayloadManifest> {
  const kitVersion = over.kitVersion ?? '0.2.0';
  const sorted = [...files].sort((a, b) => {
    const ka = `${a.agent}/home/${a.path}`;
    const kb = `${b.agent}/home/${b.path}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const tree = new Map<string, string>();
  const entries = sorted.map((f) => {
    const text = f.block !== undefined ? renderManagedBlock(f.block, f.content) : f.content;
    const mode = f.block !== undefined ? ('managed-block' as const) : ('owned' as const);
    const payloadPath = `files/${f.agent}/home/${f.path}`;
    tree.set(`payload/${payloadPath}`, text);
    return {
      agent: f.agent,
      target: 'home' as const,
      path: f.path,
      mode,
      ...(f.block !== undefined ? { block_id: f.block } : {}),
      kind: f.kind ?? 'skill',
      confidence: 'documented' as const,
      sha256: payloadFileSha(mode, text, f.block) as string,
      bytes: Buffer.byteLength(text),
      payload_path: payloadPath,
      atoms: [
        { id: 'a-one', layer: 'org' as const, strength: f.must === true ? 'must' : 'should' },
      ],
    };
  });
  const manifest = PayloadManifestSchema.parse({
    schema_version: 1,
    kit_version: kitVersion,
    channel: 'stable',
    files: entries,
    migrations: over.migrations ?? [],
    skippedLayers: [{ layer: 'personal', reason: 'v1' }],
  });
  tree.set('payload/manifest.json', canonicalJson(manifest));
  // 清掉旧夹具再写
  const pdir = path.join(w.payloadRoot, 'payload');
  if (await exists(pdir)) await safe.remove(w.io, pdir);
  const ipath = path.join(w.payloadRoot, 'integrity.json');
  if (await exists(ipath)) await safe.remove(w.io, ipath);
  for (const [rel, text] of tree) {
    const abs = path.join(w.payloadRoot, ...rel.split('/'));
    await safe.mkdirp(w.io, path.dirname(abs));
    await safe.writeFile(w.io, abs, text);
  }
  const integ = buildIntegrity(
    kitVersion,
    [...tree].map(([p, t]) => ({ path: p, content: Buffer.from(t) })),
  );
  await safe.writeFile(w.io, ipath, integ.text);
  return manifest;
}

// ---------------------------------------------------------------------------
// 树快照
// ---------------------------------------------------------------------------

export interface Tree {
  /** 文件:相对路径 → `mode sha256`(符号链接:`link -> 目标`) */
  files: Map<string, string>;
  dirs: Set<string>;
  /** 文件 mtimeMs */
  mtimes: Map<string, number>;
  /** 目录 mtimeMs(创建 / 删除目录项会改它:锁文件的出现与消失也算) */
  dirMtimes: Map<string, number>;
}

export async function treeOf(
  root: string,
  skip: (rel: string) => boolean = () => false,
): Promise<Tree> {
  const t: Tree = { files: new Map(), dirs: new Set(), mtimes: new Map(), dirMtimes: new Map() };
  async function walk(rel: string): Promise<void> {
    const abs = rel === '' ? root : path.join(root, rel);
    for (const e of await readDir(abs)) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (skip(r)) continue;
      const st = await lstat(path.join(root, r));
      if (e.isSymbolicLink) {
        t.files.set(r, 'symlink');
      } else if (e.isDirectory) {
        t.dirs.add(r);
        t.dirMtimes.set(r, st.mtimeMs);
        await walk(r);
      } else {
        t.files.set(
          r,
          `${(st.mode & 0o777).toString(8)} ${sha(await readBytes(path.join(root, r)))}`,
        );
        t.mtimes.set(r, st.mtimeMs);
      }
    }
  }
  await walk('');
  return t;
}

export const STATE_PREFIX = '.local/state/agent-kit';
export const isState = (rel: string): boolean =>
  rel === '.local' ||
  rel === '.local/state' ||
  rel === STATE_PREFIX ||
  rel.startsWith(`${STATE_PREFIX}/`);
