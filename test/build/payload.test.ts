import { afterEach, describe, expect, it } from 'vitest';
import { PayloadIntegritySchema, PayloadManifestSchema } from '../../src/contracts/payload.js';
import type { PayloadManifest } from '../../src/contracts/payload.js';
import type { ResolvedAtom } from '../../src/contracts/merge.js';
import type { OutFile } from '../../src/contracts/render.js';
import {
  INTEGRITY_PATH,
  PAYLOAD_MANIFEST_PATH,
  PayloadBuildError,
  buildIntegrity,
  buildPayload,
  classifyKind,
  payloadFileSha,
  sha256Bytes,
} from '../../src/build/payload.js';
import { readOutHomeTree, rebuildPayload } from '../../src/build/payload-rebuild.js';
import { verifyPayload } from '../../src/build/payload-verify.js';
import type { PayloadCode } from '../../src/build/payload-verify.js';
import { canonicalJson } from '../../src/io/canonical-json.js';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { atomMd, fullFiles, makeSandbox, resetBuildDeps, runBuild, writeRepo } from './helpers.js';

afterEach(resetBuildDeps);

const VERSION = '0.1.0';
const STUB_DIST = { 'dist/cli.js': '#!/usr/bin/env node\n', 'package.json': '{"version":"x"}\n' };

/** org-rule 为 must、team-rule 为 should:strength 取错字段时两边会一起露馅。 */
function mustAtom(id: string, layer: string): string {
  return atomMd(id, layer)
    .replace('strength: should', 'strength: must')
    .replace('verifier:\n  type: none\n', 'verifier:\n  type: replay\n  ref: cases/x/\n');
}

async function repoFiles(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  return {
    ...(await fullFiles()),
    'rules/org/org-rule.md': mustAtom('org-rule', 'org'),
    ...extra,
  };
}

interface Pkg {
  /** 包根相对路径 → 文本(含 integrity.json 与两个伪造的 dist 文件) */
  files: Map<string, string>;
  rebuilt: Map<string, string>;
  outTree: Map<string, string>;
}

async function makePkg(extra: Record<string, string> = {}): Promise<Pkg> {
  const sb = await makeSandbox('payload-');
  const root = await writeRepo(sb, 'repo', await repoFiles(extra));
  expect((await runBuild(sb, root)).code).toBe(ExitCode.OK);
  const res = await rebuildPayload(root);
  if (!res.ok) throw new Error(res.message);
  const outTree = await readOutHomeTree(root);
  if (outTree === undefined) throw new Error('no out');
  const files = new Map<string, string>([...res.bundle.tree, ...Object.entries(STUB_DIST)]);
  const pkg: Pkg = { files, rebuilt: res.bundle.tree, outTree };
  seal(pkg);
  return pkg;
}

/** 重新生成 integrity.json(模拟「攻击者把自洽性补齐」) */
function seal(p: Pkg): void {
  p.files.delete(INTEGRITY_PATH);
  const entries = [...p.files].map(([path, c]) => ({ path, content: Buffer.from(c, 'utf8') }));
  p.files.set(INTEGRITY_PATH, buildIntegrity(VERSION, entries).text);
}

function editManifest(p: Pkg, fn: (m: PayloadManifest) => void): void {
  const m = JSON.parse(p.files.get(PAYLOAD_MANIFEST_PATH) as string) as PayloadManifest;
  fn(m);
  p.files.set(PAYLOAD_MANIFEST_PATH, canonicalJson(m));
}

function check(p: Pkg, over: { version?: string; homeDir?: string; skipRebuild?: boolean } = {}) {
  return verifyPayload({
    packFiles: [...p.files.keys()].sort(),
    read: (rel) => (p.files.has(rel) ? Buffer.from(p.files.get(rel) as string, 'utf8') : undefined),
    version: over.version ?? VERSION,
    ...(over.skipRebuild ? {} : { rebuilt: p.rebuilt }),
    outTree: p.outTree,
    ...(over.homeDir !== undefined ? { homeDir: over.homeDir } : {}),
  });
}
const codes = (v: { code: PayloadCode }[]): PayloadCode[] => [...new Set(v.map((x) => x.code))];

const firstPayloadFile = (p: Pkg, pred: (k: string) => boolean = () => true): string =>
  [...p.files.keys()].find((k) => k.startsWith('payload/files/') && pred(k)) as string;

describe('payload 构造', () => {
  it('manifest 过 schema,只含 target=home,kind/strength 来自原子与落点', async () => {
    const pkg = await makePkg();
    const m = PayloadManifestSchema.parse(
      JSON.parse(pkg.files.get(PAYLOAD_MANIFEST_PATH) as string),
    );
    expect(m.files.length).toBeGreaterThan(5);
    expect(m.files.every((f) => f.target === 'home')).toBe(true);
    expect(new Set(m.files.map((f) => f.kind))).toEqual(new Set(['rules', 'skill', 'subagent']));
    const codexRules = m.files.find((f) => f.path === '.codex/AGENTS.md');
    expect(codexRules?.mode).toBe('managed-block');
    expect(codexRules?.block_id).toBeTruthy();
    expect(codexRules?.atoms).toEqual([
      { id: 'org-rule', layer: 'org', strength: 'must' },
      { id: 'team-rule', layer: 'team', strength: 'should' },
    ]);
    const content = pkg.files.get(`payload/${codexRules?.payload_path}`) as string;
    expect(codexRules?.sha256).toBe(payloadFileSha('managed-block', content, codexRules?.block_id));
    expect(codexRules?.sha256).not.toBe(sha256Bytes(content));
    // 技能与子代理文件没有原子
    expect(m.files.filter((f) => f.kind !== 'rules').every((f) => f.atoms.length === 0)).toBe(true);
    // out/ 里 target=project 的文件不进 payload
    expect([...pkg.files.keys()].some((k) => k.includes('/project/'))).toBe(false);
  });

  it('payload 文件与 out/ 里的 home 文件逐字节相同', async () => {
    const pkg = await makePkg();
    for (const [k, v] of pkg.outTree) {
      if (k.split('/')[1] !== 'home') continue;
      expect(pkg.files.get(`payload/files/${k}`), k).toBe(v);
    }
  });

  it('integrity 过 schema、按 path 升序、不含自身,覆盖包内全部文件', async () => {
    const pkg = await makePkg();
    const ig = PayloadIntegritySchema.parse(JSON.parse(pkg.files.get(INTEGRITY_PATH) as string));
    expect(ig.files.map((f) => f.path)).toEqual(
      [...pkg.files.keys()].filter((k) => k !== INTEGRITY_PATH).sort(),
    );
    expect(ig.files.map((f) => f.path)).not.toContain(INTEGRITY_PATH);
  });

  it('确定性:同输入两次构建字节相同;换仓库位置也相同;内容不含时间戳和绝对路径', async () => {
    const a = await makePkg();
    const b = await makePkg();
    expect([...b.rebuilt]).toEqual([...a.rebuilt]);
    expect(b.files.get(INTEGRITY_PATH)).toBe(a.files.get(INTEGRITY_PATH));
    const all = [...a.rebuilt.values()].join('\n');
    expect(all).not.toMatch(/20[0-9]{2}-[0-9]{2}-[0-9]{2}T/u);
    expect(all).not.toMatch(/\/Users\/|\/home\/[A-Za-z_]|\/private\/|\/var\/folders/u);
  });

  it('manifest 按 <agent>/<target>/<path> 字节序排列(输入乱序也一样)', async () => {
    const sb = await makeSandbox('payload-order-');
    const root = await writeRepo(sb, 'repo', await repoFiles());
    expect((await runBuild(sb, root)).code).toBe(ExitCode.OK);
    const { loadKitConfig } = await import('../../src/build/config.js');
    const { runPipeline } = await import('../../src/build/pipeline.js');
    const cfg = loadKitConfig(root).config;
    if (!cfg) throw new Error('cfg');
    const r = await runPipeline({ root, config: cfg, overlay: undefined });
    if (r.kind !== 'ok') throw new Error('pipeline');
    const mk = (files: readonly OutFile[]) =>
      buildPayload({
        files,
        resolved: r.merge.atoms,
        skills: r.skills,
        kitVersion: VERSION,
        channel: 'canary',
        skippedLayers: r.manifest.skippedLayers,
      });
    const forward = mk(r.rendered.files);
    const reversed = mk([...r.rendered.files].reverse());
    expect(reversed.manifestText).toBe(forward.manifestText);
    const m = JSON.parse(forward.manifestText) as PayloadManifest;
    const keys = m.files.map((f) => `${f.agent}/${f.target}/${f.path}`);
    expect(keys).toEqual([...keys].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y))));
    expect([...forward.tree.keys()]).toEqual(
      [...forward.tree.keys()].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y))),
    );
  });
});

describe('personal 来源恒为 0', () => {
  it('完整构建:personal 原子不在 payload(正向控制:合并结果里确有它)', async () => {
    const pkg = await makePkg();
    const all = [...pkg.files.values()].join('\n');
    expect(all).not.toContain('my-habit');
    const m = JSON.parse(pkg.files.get(PAYLOAD_MANIFEST_PATH) as string) as PayloadManifest;
    expect(m.files.flatMap((f) => f.atoms).some((a) => a.layer === 'personal')).toBe(false);
    expect(m.skippedLayers.map((s) => s.layer)).toContain('personal');
    expect(check(pkg)).toEqual([]);
  });

  it('buildPayload:文件引用了 personal(coreEligible=false)原子 → 抛 PAYLOAD_PERSONAL_LEAK', async () => {
    const sb = await makeSandbox('payload-personal-');
    const root = await writeRepo(sb, 'repo', await repoFiles());
    const { loadKitConfig } = await import('../../src/build/config.js');
    const { runPipeline } = await import('../../src/build/pipeline.js');
    const cfg = loadKitConfig(root).config;
    if (!cfg) throw new Error('cfg');
    const r = await runPipeline({ root, config: cfg, overlay: undefined });
    if (r.kind !== 'ok') throw new Error('pipeline');
    const personal = r.merge.atoms.find((a) => a.layer === 'personal') as ResolvedAtom;
    expect(personal.coreEligible).toBe(false);
    const rules = r.rendered.files.find((f) => f.relPath === '.codex/AGENTS.md') as OutFile;
    const bad: OutFile = {
      ...rules,
      atomIds: [...rules.atomIds, personal.atom.fm.id],
      atomBytes: { ...rules.atomBytes, [personal.atom.fm.id]: 1 },
    };
    const run = () =>
      buildPayload({
        files: [bad],
        resolved: r.merge.atoms,
        skills: r.skills,
        kitVersion: VERSION,
        channel: 'canary',
        skippedLayers: r.manifest.skippedLayers,
      });
    expect(run).toThrow(PayloadBuildError);
    expect(run).toThrow(/personal/u);
    // 即使 coreEligible 被置 true,layer=personal 也不放行
    const forged = r.merge.atoms.map((a) => (a === personal ? { ...a, coreEligible: true } : a));
    expect(() =>
      buildPayload({
        files: [bad],
        resolved: forged,
        skills: r.skills,
        kitVersion: VERSION,
        channel: 'canary',
        skippedLayers: r.manifest.skippedLayers,
      }),
    ).toThrow(/personal/u);
  });

  it('verify:manifest 里混进 personal 来源 / 没声明跳过 personal → PAYLOAD_PERSONAL_LEAK', async () => {
    const pkg = await makePkg();
    editManifest(pkg, (m) => {
      const f = m.files.find((x) => x.atoms.length > 0);
      (f as { atoms: unknown[] }).atoms.push({
        id: 'my-habit',
        layer: 'personal',
        strength: 'should',
      });
    });
    seal(pkg);
    expect(codes(check(pkg))).toContain('PAYLOAD_PERSONAL_LEAK');

    const pkg2 = await makePkg();
    editManifest(pkg2, (m) => {
      m.skippedLayers = [];
    });
    seal(pkg2);
    expect(codes(check(pkg2))).toContain('PAYLOAD_PERSONAL_LEAK');
  });
});

describe('verify:完整性闸', () => {
  it('干净的包:零违规', async () => {
    expect(check(await makePkg())).toEqual([]);
  });

  it('篡改 payload 里的一个文件(integrity 未更新)→ PAYLOAD_FILE_TAMPERED', async () => {
    const pkg = await makePkg();
    const k = firstPayloadFile(pkg);
    pkg.files.set(k, `${pkg.files.get(k)}\n额外一行\n`);
    const v = check(pkg);
    expect(codes(v)).toContain('PAYLOAD_FILE_TAMPERED');
    expect(v.find((x) => x.code === 'PAYLOAD_FILE_TAMPERED')?.path).toBe(k);
  });

  it('篡改 dist 里的文件 → PAYLOAD_FILE_TAMPERED', async () => {
    const pkg = await makePkg();
    pkg.files.set('dist/cli.js', 'process.exit(0)\n');
    expect(codes(check(pkg))).toContain('PAYLOAD_FILE_TAMPERED');
  });

  it('篡改文件且补齐 integrity(自洽损坏)→ manifest 对不上 + 与重新构建/out 不一致', async () => {
    const pkg = await makePkg();
    const k = firstPayloadFile(pkg, (x) => x.endsWith('SKILL.md'));
    pkg.files.set(k, `${pkg.files.get(k)}\n恶意指令\n`);
    seal(pkg);
    const c = codes(check(pkg));
    expect(c).toContain('PAYLOAD_MANIFEST_MISMATCH');
    expect(c).toContain('PAYLOAD_REBUILD_MISMATCH');
    expect(c).toContain('PAYLOAD_OUT_MISMATCH');
    expect(c).not.toContain('PAYLOAD_FILE_TAMPERED');
  });

  it('manifest 与 integrity 不一致:manifest 改了某文件的 sha(integrity 补齐)→ PAYLOAD_MANIFEST_MISMATCH', async () => {
    const pkg = await makePkg();
    editManifest(pkg, (m) => {
      const f = m.files.find((x) => x.mode === 'owned');
      (f as { sha256: string }).sha256 = '0'.repeat(64);
    });
    seal(pkg);
    const c = codes(check(pkg));
    expect(c).toContain('PAYLOAD_MANIFEST_MISMATCH');
    expect(c).toContain('PAYLOAD_REBUILD_MISMATCH');
  });

  it('manifest 改了但没补 integrity → PAYLOAD_FILE_TAMPERED(manifest.json 自己被篡改)', async () => {
    const pkg = await makePkg();
    editManifest(pkg, (m) => {
      m.channel = 'stable';
    });
    expect(codes(check(pkg))).toContain('PAYLOAD_FILE_TAMPERED');
  });

  it('managed-block 文件:块体被改、标记行 sha 没改 → PAYLOAD_MANIFEST_MISMATCH', async () => {
    const pkg = await makePkg();
    const k = 'payload/files/codex/home/.codex/AGENTS.md';
    pkg.files.set(k, (pkg.files.get(k) as string).replace('做某件具体的事', '做某件具体的人'));
    seal(pkg);
    expect(codes(check(pkg, { skipRebuild: true }))).toContain('PAYLOAD_MANIFEST_MISMATCH');
  });

  it('缺 manifest / 缺 integrity → 各自的原因码', async () => {
    const a = await makePkg();
    a.files.delete(PAYLOAD_MANIFEST_PATH);
    expect(codes(check(a, { skipRebuild: true }))).toContain('PAYLOAD_MISSING_MANIFEST');
    const b = await makePkg();
    b.files.delete(INTEGRITY_PATH);
    expect(codes(check(b))).toContain('PAYLOAD_MISSING_INTEGRITY');
  });

  it('manifest / integrity 不是合法内容 → *_INVALID', async () => {
    const a = await makePkg();
    a.files.set(PAYLOAD_MANIFEST_PATH, '{"schema_version":1}');
    expect(codes(check(a))).toContain('PAYLOAD_MANIFEST_INVALID');
    const b = await makePkg();
    b.files.set(INTEGRITY_PATH, 'not json');
    expect(codes(check(b))).toContain('PAYLOAD_INTEGRITY_INVALID');
  });

  it('包里多出未登记文件 / 登记了但缺失 → UNLISTED / FILE_MISSING;payload 下多出文件 → MANIFEST_MISMATCH', async () => {
    const a = await makePkg();
    a.files.set('dist/extra.js', 'x\n');
    expect(codes(check(a))).toContain('PAYLOAD_FILE_UNLISTED');
    const b = await makePkg();
    b.files.delete('dist/cli.js');
    expect(codes(check(b))).toContain('PAYLOAD_FILE_MISSING');
    const c = await makePkg();
    c.files.set('payload/files/claude/home/.claude/skills/evil/SKILL.md', '恶意\n');
    seal(c);
    const cc = codes(check(c));
    expect(cc).toContain('PAYLOAD_MANIFEST_MISMATCH');
    expect(cc).toContain('PAYLOAD_REBUILD_MISMATCH');
  });

  it('非法 UTF-8 字节(可被有损解码掩盖)→ PAYLOAD_MANIFEST_MISMATCH', async () => {
    const pkg = await makePkg();
    const k = firstPayloadFile(pkg, (x) => x.endsWith('SKILL.md'));
    const bytes = Buffer.concat([
      Buffer.from(pkg.files.get(k) as string, 'utf8'),
      Buffer.from([0xff]),
    ]);
    const v = verifyPayload({
      packFiles: [...pkg.files.keys()].sort(),
      read: (rel) => (rel === k ? bytes : Buffer.from(pkg.files.get(rel) as string, 'utf8')),
      version: VERSION,
    });
    expect(codes(v)).toContain('PAYLOAD_MANIFEST_MISMATCH');
  });

  it('版本不一致 → PAYLOAD_VERSION_MISMATCH', async () => {
    expect(codes(check(await makePkg(), { version: '9.9.9' }))).toContain(
      'PAYLOAD_VERSION_MISMATCH',
    );
  });

  it('禁运内容:绝对路径 / 构建机 HOME → PAYLOAD_FORBIDDEN_CONTENT;/Users/someone 合成占位放行', async () => {
    const pkg = await makePkg();
    const k = firstPayloadFile(pkg, (x) => x.endsWith('SKILL.md'));
    const orig = pkg.files.get(k) as string;
    const tamper = (extra: string, home?: string) => {
      const p: Pkg = { ...pkg, files: new Map(pkg.files) };
      p.files.set(k, `${orig}${extra}\n`);
      editManifest(p, (m) => {
        const f = m.files.find((x) => `payload/${x.payload_path}` === k);
        (f as { sha256: string; bytes: number }).sha256 = sha256Bytes(`${orig}${extra}\n`);
        (f as { bytes: number }).bytes = Buffer.byteLength(`${orig}${extra}\n`);
      });
      seal(p);
      return codes(check({ ...p, rebuilt: p.rebuilt }, { homeDir: home, skipRebuild: true }));
    };
    expect(tamper('see /Users/alice/secret')).toContain('PAYLOAD_FORBIDDEN_CONTENT');
    expect(tamper('see /home/bob/x/')).toContain('PAYLOAD_FORBIDDEN_CONTENT');
    expect(tamper('build at /opt/builder/home', '/opt/builder/home')).toContain(
      'PAYLOAD_FORBIDDEN_CONTENT',
    );
    expect(tamper('see /Users/someone/x')).not.toContain('PAYLOAD_FORBIDDEN_CONTENT');
  });

  it('包清单里出现 out/ 或 personal 路径 → PAYLOAD_FORBIDDEN_PATH', async () => {
    const a = await makePkg();
    a.files.set('out/manifest.json', '{}\n');
    seal(a);
    expect(codes(check(a))).toContain('PAYLOAD_FORBIDDEN_PATH');
    const b = await makePkg();
    b.files.set('rules/personal/my-habit.md', 'x\n');
    seal(b);
    expect(codes(check(b))).toContain('PAYLOAD_FORBIDDEN_PATH');
  });
});

describe('kind 判定', () => {
  const clean = { files: [{ relPath: 'SKILL.md', bytes: 1, sha256: '0'.repeat(64) }] };
  const withScript = {
    files: [...clean.files, { relPath: 'scripts/run.sh', bytes: 1, sha256: '0'.repeat(64) }],
  };
  const skills = new Map<string, typeof clean>([
    ['plain', clean],
    ['scripted', withScript],
    [
      'pyonly',
      { files: [...clean.files, { relPath: 'tools/x.py', bytes: 1, sha256: '0'.repeat(64) }] },
    ],
  ]);
  const f = (relPath: string, ref?: string) => ({
    relPath,
    ...(ref ? { sourceRefs: [ref] } : {}),
  });

  it('规则 / 技能 / 子代理按落点判定', () => {
    expect(classifyKind(f('.codex/AGENTS.md'), skills)).toBe('rules');
    expect(classifyKind(f('.claude/rules/agent-kit/org.md'), skills)).toBe('rules');
    expect(classifyKind(f('.claude/skills/plain/SKILL.md', 'skill:plain'), skills)).toBe('skill');
    expect(classifyKind(f('.agents/skills/plain/SKILL.md', 'skill:plain'), skills)).toBe('skill');
    expect(classifyKind(f('.claude/agents/r.md', 'agent:r'), skills)).toBe('subagent');
    expect(classifyKind(f('.codex/agents/r.toml', 'agent:r'), skills)).toBe('subagent');
  });

  it('技能带 scripts/ 目录或脚本扩展名的资源 → executable', () => {
    expect(classifyKind(f('.claude/skills/scripted/SKILL.md', 'skill:scripted'), skills)).toBe(
      'executable',
    );
    expect(classifyKind(f('.claude/skills/pyonly/SKILL.md', 'skill:pyonly'), skills)).toBe(
      'executable',
    );
  });

  it('拿不准的一律 executable:未知落点、技能目录里的非 SKILL.md、来源缺失/对不上、规则文件带来源', () => {
    expect(classifyKind(f('.claude/settings.json'), skills)).toBe('executable');
    expect(classifyKind(f('.claude/hooks/pre.sh'), skills)).toBe('executable');
    expect(classifyKind(f('.claude/skills/plain/run.sh', 'skill:plain'), skills)).toBe(
      'executable',
    );
    expect(classifyKind(f('.claude/skills/plain/SKILL.md'), skills)).toBe('executable');
    expect(classifyKind(f('.claude/skills/plain/SKILL.md', 'skill:other'), skills)).toBe(
      'executable',
    );
    expect(classifyKind(f('.claude/skills/ghost/SKILL.md', 'skill:ghost'), skills)).toBe(
      'executable',
    );
    expect(classifyKind(f('.claude/agents/r.md'), skills)).toBe('executable');
    expect(classifyKind(f('.codex/AGENTS.md', 'skill:x'), skills)).toBe('executable');
  });

  it('端到端:技能目录带 scripts/ 的仓库,payload 里该技能标 executable,另一个技能仍是 skill', async () => {
    const pkg = await makePkg({
      'skills/runner/SKILL.md': '---\nname: runner\ndescription: 带脚本的技能。\n---\n\n正文。\n',
      'skills/runner/scripts/run.sh': '#!/bin/sh\necho hi\n',
    });
    const m = JSON.parse(pkg.files.get(PAYLOAD_MANIFEST_PATH) as string) as PayloadManifest;
    const kindOf = (name: string) =>
      new Set(m.files.filter((f) => f.path.includes(`/${name}/SKILL.md`)).map((f) => f.kind));
    expect(kindOf('runner')).toEqual(new Set(['executable']));
    expect(kindOf('my-skill')).toEqual(new Set(['skill']));
    expect(check(pkg)).toEqual([]);
  });
});
