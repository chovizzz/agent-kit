import * as path from 'node:path';
import { main } from '../../src/cli.js';
import { buildDeps } from '../../src/build/pipeline.js';
import { readTree } from '../../src/render/out-layout.js';
import { makeTempDir, wideCtx } from '../helpers/tmp.js';
import { readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import type { IoContext } from '../../src/io/paths.js';
import { GOOD_ATOM, OWNER_LINE } from '../atoms/helpers.js';
import { REPO_ROOT } from '../helpers/tmp.js';

export interface Sandbox {
  /** 临时根(realpath;在仓库外) */
  dir: string;
  /** 假 HOME(空目录,建在仓库之外);测试结束时应仍为空 */
  home: string;
  wctx: IoContext;
}

export async function makeSandbox(prefix = 'build-'): Promise<Sandbox> {
  const { dir } = await makeTempDir(prefix);
  const wctx = wideCtx(dir);
  const home = path.join(dir, 'home');
  await safe.mkdirp(wctx, home);
  return { dir, home, wctx };
}

export async function writeRepo(
  sb: Sandbox,
  name: string,
  files: Record<string, string>,
): Promise<string> {
  const root = path.join(sb.dir, name);
  await safe.mkdirp(sb.wctx, root);
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await safe.mkdirp(sb.wctx, path.dirname(abs));
    await safe.writeFile(sb.wctx, abs, text);
  }
  return root;
}

export interface RunResult {
  code: number;
  out: string;
  err: string;
}

export interface RunOpts {
  /** 传给 main 的 cwd;缺省 = 仓库根(`--root` 才是真正的仓库根) */
  cwd?: string;
  /** 额外环境变量 */
  env?: Record<string, string>;
  /** 命令名之前的全局参数(--root 之外,如 --overlay) */
  globals?: string[];
}

/** 以假 HOME 跑 `agent-kit --root <root> build <args>`(进程内)。 */
export async function runBuild(
  sb: Sandbox,
  root: string,
  args: string[] = [],
  opts: RunOpts = {},
): Promise<RunResult> {
  let out = '';
  let err = '';
  const code = await main(['--root', root, ...(opts.globals ?? []), 'build', ...args], {
    env: {
      PATH: '/usr/bin:/bin',
      KIT_REAL_HOME_OVERRIDE: sb.home,
      HOME: sb.home,
      ...opts.env,
    },
    cwd: opts.cwd ?? REPO_ROOT,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  });
  return { code, out, err };
}

export async function outTree(root: string): Promise<Map<string, string>> {
  return readTree(path.join(root, 'out'));
}

export function resetBuildDeps(): void {
  delete buildDeps.render;
}

export async function realKitToml(): Promise<string> {
  return readText(path.join(REPO_ROOT, 'kit.toml'));
}

/** 一个能通过 lint、会被渲染的原子(status=active + always 签名)。 */
export function atomMd(id: string, layer: string, extra = ''): string {
  return GOOD_ATOM.replace('id: good-atom', `id: ${id}`)
    .replace('layer: team', `layer: ${layer}`)
    .replace('status: proposed', 'status: active\nsignature:\n  type: always')
    .replace('verifier:', `${extra}verifier:`)
    .replace('  type: replay\n  ref: cases/x/\n', '  type: none\n');
}

export const SKILL_MD = '---\nname: my-skill\ndescription: 示例技能。\n---\n\n技能正文。\n';
export const AGENT_YAML =
  'name: diff-reviewer\ndescription: 只读评审者\nprompt: 你是只读的评审者。\ntools: [read, shell]\nmodel_tier: judge\n';

/** 覆盖四层 + 技能 + 子代理的完整仓库(personal 原子 my-habit 是正向控制)。 */
export async function fullFiles(): Promise<Record<string, string>> {
  return {
    'kit.toml': await realKitToml(),
    CODEOWNERS: OWNER_LINE,
    'cases/x/case.yaml': 'name: x\n',
    'rules/org/org-rule.md': atomMd('org-rule', 'org'),
    'rules/team/team-rule.md': atomMd('team-rule', 'team'),
    'rules/personal/my-habit.md': atomMd('my-habit', 'personal'),
    '.kit/rules/project-rule.md': atomMd('project-rule', 'project'),
    'skills/my-skill/SKILL.md': SKILL_MD,
    'agents/diff-reviewer.yaml': AGENT_YAML,
  };
}

/**
 * out/ 树 → 单个可读快照文本(golden 用;不是 md/json,所以不受 prettier 影响)。
 * 每个文件:`@@@ <path> <字节数>` 一行 + 原文。
 */
export function treeSnapshot(tree: ReadonlyMap<string, string>): Map<string, string> {
  const parts: string[] = [];
  for (const [k, v] of [...tree].sort((a, b) =>
    Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])),
  )) {
    parts.push(`@@@ ${k} ${Buffer.byteLength(v, 'utf8')}\n${v}${v.endsWith('\n') ? '' : '\n'}`);
  }
  return new Map([['tree.txt', parts.join('')]]);
}
