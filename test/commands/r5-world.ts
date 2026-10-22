/**
 * R5 命令级测试夹具:临时 git 仓库(kit.toml + 真实规则文件的副本)+ 仓库外的 state 目录 + 合成信号 + 覆盖层。
 * 全部合成数据;不联网、不 spawn 任何 LLM。
 */
import * as path from 'node:path';
import { afterAll } from 'vitest';
import type { CommandContext } from '../../src/commands/types.js';
import type { Signal } from '../../src/contracts/signal.js';
import { createIoContext } from '../../src/io/paths.js';
import type { IoContext } from '../../src/io/paths.js';
import { readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { makeTestRepo } from '../helpers/make-repo.js';
import type { TestRepo } from '../helpers/make-repo.js';
import { REPO_ROOT } from '../helpers/tmp.js';
import { putSignals, worldSignals } from '../fixtures/reflect/world.js';

export const kitToml = (maxLines: number): string => `[kit]
name = "t"
version = "0.0.0"

[agents]
enabled = ["claude"]

[budget]
enforce = "warn"

[budget.claude]
max_lines = ${maxLines}
limit_source = "documented"

[channels.canary.members]

[channels.stable.members]
`;

export const overlayToml = (reflect: string): string => `[reflect]\n${reflect}\n`;
/** 同意外发、绑定一个槽位(只用于让「已配置」成立;测试里的后端由注入的工厂提供) */
export const EGRESS_OVERLAY = overlayToml('egress = true');

export interface R5World {
  readonly parent: string;
  readonly repo: TestRepo;
  readonly io: IoContext;
  readonly state: string;
  readonly overlayPath: string | undefined;
}

const made: TestRepo[] = [];
afterAll(async () => {
  for (const r of made.splice(0)) await r.dispose();
});

export interface WorldOpts {
  signals?: readonly Signal[] | null;
  overlay?: string;
  /** kit.toml 里 claude 的 max_lines(1 = 预算必满;缺省很大 = 必不满) */
  maxLines?: number;
  rules?: Record<string, string>;
  files?: Record<string, string>;
}

export async function newR5World(o: WorldOpts = {}): Promise<R5World> {
  const repo = await makeTestRepo('r5-');
  made.push(repo);
  const parent = path.dirname(repo.dir);
  // proposed 不渲染、进不了预算:副本改成 advisory(canary 渠道渲染;active/advisory 要有 signature)
  const real = (await readText(path.join(REPO_ROOT, 'rules', 'org', 'keep-changes-minimal.md')))
    .replace('status: proposed', 'status: advisory')
    .replace(
      'verifier:\n',
      'signature:\n  type: phrase\n  pattern: zzz-unrelated-pattern\nverifier:\n',
    );
  const codeowners = await readText(path.join(REPO_ROOT, 'CODEOWNERS'));
  await repo.commit(
    {
      'kit.toml': kitToml(o.maxLines ?? 100000),
      CODEOWNERS: codeowners,
      'cases/keep-changes-minimal/README.md': 'case placeholder\n',
      'rules/org/keep-changes-minimal.md': real,
      ...(o.rules ?? {}),
      ...(o.files ?? {}),
    },
    'base',
  );
  const state = path.join(parent, 'state');
  const io = createIoContext({
    cwd: REPO_ROOT,
    root: repo.dir,
    env: { KIT_TMP: parent, KIT_STATE_DIR: state, PATH: '/usr/bin:/bin' },
  });
  let overlayPath: string | undefined;
  if (o.overlay !== undefined) {
    overlayPath = path.join(parent, 'overlay.toml');
    await safe.writeFile(io, overlayPath, o.overlay);
  }
  if (o.signals !== null) await putSignals(io, o.signals ?? worldSignals());
  return { parent, repo, io, state, overlayPath };
}

export function ctxFor(
  w: R5World,
  argv: string[],
  env?: Record<string, string>,
): { ctx: CommandContext; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    ctx: {
      argv,
      io: w.io,
      overlayPath: w.overlayPath,
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      ...(env !== undefined ? { env } : {}),
    },
    out,
    err,
  };
}
