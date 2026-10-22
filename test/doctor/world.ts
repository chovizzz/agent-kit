/**
 * S5 测试世界:复用 test/sync/world.ts 的假 HOME + 假包根,加 doctor 的运行器与「已安装」「假安装(current)」夹具。
 * 全部写盘只经 safe-fs / 假 HOME(KIT_TMP 之内);被测代码是 createDoctorCommand。
 */
import * as path from 'node:path';
import { buildIntegrity } from '../../src/build/payload.js';
import { createDoctorCommand, type DoctorCommandDeps } from '../../src/commands/doctor.js';
import type { EnvCommandContext } from '../../src/commands/reflect.js';
import { canonicalJson } from '../../src/io/canonical-json.js';
import { createIoContext } from '../../src/io/paths.js';
import * as safe from '../../src/io/safe-fs.js';
import { REPO_ROOT } from '../helpers/tmp.js';
import { newWorld, sha, stdFixture, STATE_PREFIX, type World } from '../sync/world.js';

export { newWorld, sha, stdFixture, STATE_PREFIX, treeOf } from '../sync/world.js';
export type { World } from '../sync/world.js';
export {
  BLOCK_ID,
  CANARY_PAYLOAD,
  CANARY_USER,
  CODEX_MD,
  KIMI_MD,
  PI_MD,
  RULES,
  SHARED,
  SKILL,
} from '../sync/world.js';

export interface DoctorRun {
  code: number;
  out: string;
  err: string;
}

export interface RunOpts {
  deps?: DoctorCommandDeps;
  env?: Record<string, string>;
  overlay?: string;
  noHome?: boolean;
  /** 另给仓库 .state 的位置(KIT_TMP 之内),用于 D15 的冷却标记 */
  stateDir?: string;
  noPayload?: boolean;
}

export async function runDoctor(w: World, args: string[], o: RunOpts = {}): Promise<DoctorRun> {
  const out: string[] = [];
  const err: string[] = [];
  // noPayload:不能只是「不设 KIT_PAYLOAD_DIR」——那会回退到真实包根,结果取决于仓库树里有没有 build 过 payload/。
  // 显式指向 KIT_TMP 之内一个空的假包根,前提与仓库树的构建状态无关。
  let payloadDir = w.payloadRoot;
  if (o.noPayload === true) {
    payloadDir = path.join(w.dir, 'empty-pkg');
    await safe.mkdirp(w.io, payloadDir);
  }
  const env: Record<string, string> = {
    ...w.env,
    KIT_PAYLOAD_DIR: payloadDir,
    ...(o.stateDir !== undefined ? { KIT_STATE_DIR: o.stateDir } : {}),
    ...o.env,
  };
  const io = o.stateDir !== undefined ? createIoContext({ cwd: REPO_ROOT, env }) : w.io;
  const ctx: EnvCommandContext = {
    argv: [...(o.noHome === true ? [] : ['--home', w.home]), ...args],
    io,
    overlayPath: o.overlay,
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    env,
  };
  const code = await createDoctorCommand(o.deps).run(ctx);
  return { code, out: out.join(''), err: err.join('') };
}

export interface JsonCheck {
  id: string;
  status: string;
  result: string;
  counts: Record<string, number>;
  facts: Record<string, string | number | boolean | null>;
  items: string[];
}
export interface JsonReport {
  schema_version: number;
  summary: Record<string, number>;
  checks: JsonCheck[];
}

/** `--json --only <id>` 取单个检查 */
export async function checkOf(
  w: World,
  id: string,
  o: RunOpts = {},
): Promise<{ check: JsonCheck; run: DoctorRun }> {
  const run = await runDoctor(w, ['--json', '--only', id], o);
  const rep = JSON.parse(run.out) as JsonReport;
  const check = rep.checks[0] as JsonCheck;
  return { check, run };
}

/** 用真实的 sync --write 把 payload 装进假 HOME(默认 claude / codex / pi)。 */
export async function installed(label: string, over?: { skipRules?: boolean }): Promise<World> {
  const w = await newWorld(label);
  await w.setPayload(
    over?.skipRules === true ? stdFixture().filter((f) => f.agent !== 'claude') : stdFixture(),
  );
  const r = await w.run(['--write']);
  if (r.code !== 0) throw new Error(`夹具安装失败 code=${r.code}`);
  return w;
}

export async function chmodRel(w: World, rel: string, mode: number): Promise<void> {
  await safe.chmod(w.io, path.join(w.home, rel), mode);
}

// ---------------------------------------------------------------------------
// 假安装(S7c 之前没有启动器):versions/<v>/ + current 软链 + state.json 的外部锚点
// ---------------------------------------------------------------------------

export interface FakeInstall {
  version: string;
  integrityText: string;
  integritySha: string;
}

export async function fakeInstall(
  w: World,
  o: { version?: string; anchor?: 'good' | 'wrong' | 'none'; tamperFile?: boolean } = {},
): Promise<FakeInstall> {
  const version = o.version ?? '0.2.0';
  const share = path.join(w.home, '.local/share/agent-kit');
  const root = path.join(share, 'versions', version);
  const files = [
    { path: 'dist/cli.js', content: Buffer.from('console.log(1)\n') },
    { path: 'payload/manifest.json', content: Buffer.from('{}\n') },
  ];
  for (const f of files) {
    const abs = path.join(root, ...f.path.split('/'));
    await safe.mkdirp(w.io, path.dirname(abs), 0o700);
    await safe.writeFile(w.io, abs, f.content);
  }
  const integ = buildIntegrity(version, files);
  await safe.writeFile(w.io, path.join(root, 'integrity.json'), integ.text);
  if (o.tamperFile === true) {
    await safe.writeFile(w.io, path.join(root, 'dist/cli.js'), 'console.log(2)\n');
  }
  await safe.symlink(w.io, root, path.join(share, 'current'));
  const integritySha = sha(integ.text);
  const anchor =
    o.anchor === 'none' ? undefined : o.anchor === 'wrong' ? sha('other') : integritySha;
  if (anchor !== undefined) {
    await writeUpdateState(w, {
      schema_version: 1,
      installed: { version, anchor, installed_at: '2026-10-01T00:00:00.000Z' },
    });
  }
  return { version, integrityText: integ.text, integritySha };
}

export async function writeUpdateState(w: World, state: Record<string, unknown>): Promise<void> {
  await w.put(`${STATE_PREFIX}/update/state.json`, canonicalJson(state), 0o600);
}
