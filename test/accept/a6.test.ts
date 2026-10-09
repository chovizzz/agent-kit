import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { readText } from '../../src/io/read-fs.js';
import { genClaude } from '../fixtures/sessions/gen-claude.js';
import { genCodex } from '../fixtures/sessions/gen-codex.js';
import { genKimi } from '../fixtures/sessions/gen-kimi.js';
import { genPi } from '../fixtures/sessions/gen-pi.js';
import type { GeneratedSession, SessionSpec } from '../fixtures/sessions/common.js';
import { guardRealHome, makeFx, putOutside, REAL_CLI, REPO_ROOT, runScript } from './helpers.js';
import * as safe from '../../src/io/safe-fs.js';
import type { Fx } from './helpers.js';

guardRealHome();

const AGENTS = ['claude', 'codex', 'pi', 'kimi'] as const;
type Agent = (typeof AGENTS)[number];
const ORACLE = path.join(REPO_ROOT, 'ops', 'reader-oracle', 'run.sh');

interface Plan {
  users: number;
  tools: number;
  failed: number;
}
// 5 个样本:每类计数至少一个 > 0(口径 §5 的正向控制),并且不全相同
const PLANS: Plan[] = [
  { users: 2, tools: 3, failed: 1 },
  { users: 1, tools: 0, failed: 0 },
  { users: 3, tools: 2, failed: 0 },
  { users: 1, tools: 1, failed: 1 },
  { users: 4, tools: 4, failed: 2 },
];

async function gen(agent: Agent, fx: Fx, i: number, p: Plan): Promise<GeneratedSession> {
  const spec: SessionSpec = {
    root: path.join(fx.dir, 'gen', agent),
    cwd: '/work/social-ops-hub',
    id: `${agent}-${i}`,
    userTexts: Array.from({ length: p.users }, (_, k) => `hello ${k}`),
    toolCalls: p.tools,
    failedResults: p.failed,
    ...(agent === 'claude' || agent === 'codex' ? { version: '1.2.3' } : {}),
    baseMs: Date.UTC(2026, 9, 1 + i, 0, 0, 0),
  };
  if (agent === 'claude') return genClaude(fx.ctx, spec);
  if (agent === 'codex') return genCodex(fx.ctx, spec);
  if (agent === 'pi') return genPi(fx.ctx, spec);
  return genKimi(fx.ctx, spec);
}

const wcl = (text: string): number => [...text].filter((c) => c === '\n').length;

interface Setup {
  fx: Fx;
  files: { agent: Agent; file: string }[];
}

async function setup(plans: Plan[] = PLANS): Promise<Setup> {
  const fx = await makeFx('a6-');
  await fx.put('kit.toml', await readText(path.join(REPO_ROOT, 'kit.toml')));
  const files: Setup['files'] = [];
  for (const agent of AGENTS) {
    for (const [i, p] of plans.entries())
      files.push({ agent, file: (await gen(agent, fx, i, p)).file });
  }
  await writeLists(fx, files);
  return { fx, files };
}

async function writeLists(fx: Fx, files: Setup['files']): Promise<void> {
  const local = files.map((f) => `${f.agent}\t${f.file}`).join('\n') + '\n';
  await fx.put('.state/reader-samples.local.txt', local);
  const inv: string[] = [];
  for (const f of files) {
    inv.push(
      `${f.agent}\t${createHash('sha256').update(f.file).digest('hex').slice(0, 16)}\t${wcl(await readText(f.file))}`,
    );
  }
  await fx.put('inventory/reader-samples.txt', '# 合成清单\n' + inv.join('\n') + '\n');
}

const a6 = (fx: Fx, extra: string[] = []) =>
  runScript(
    'a6-readers.sh',
    ['--root', fx.root, '--cli', REAL_CLI, '--oracle', ORACLE, '--no-vitest', ...extra],
    fx.env(),
  );

describe('A6 reader 对照(全部用合成样本;脚本自己不碰真实会话)', () => {
  it('4 agent × 5 样本,三计数与 jq oracle 逐项相等 => 0(正向控制),60 个数字', async () => {
    const { fx, files } = await setup();
    const digest = async (): Promise<string[]> =>
      Promise.all(
        files.map(async (f) =>
          createHash('sha256')
            .update(await readText(f.file))
            .digest('hex'),
        ),
      );
    const before = await digest();
    const r = a6(fx);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('逐项相等 60/60');
    expect(await digest()).toEqual(before); // 原样本文件逐字节未变
  }, 120_000);

  it('取不到 SignalSchema(CLI 旁没有 dist/src/contracts)=> 4,不退化成只查字段非空', async () => {
    const { fx } = await setup();
    const stub = await putOutside(fx, 'stub-cli.mjs', 'process.exit(0);');
    const r = runScript(
      'a6-readers.sh',
      ['--root', fx.root, '--cli', stub, '--oracle', ORACLE, '--no-vitest'],
      fx.env(),
    );
    expect(r.status, r.stdout).toBe(4);
    expect(r.stdout).toContain('取不到 SignalSchema');
  }, 60_000);

  it('样本清单缺失 => 4(硬门槛不得当通过)', async () => {
    const fx = await makeFx('a6-');
    const r = a6(fx);
    expect(r.status, r.stdout).toBe(4);
    expect(r.stdout).toContain('样本清单缺失');
  });

  it('某个 agent 只有 4 个样本 / 路径重复 / 行格式错 => 3', async () => {
    const { fx, files } = await setup();
    await fx.put(
      '.state/reader-samples.local.txt',
      files
        .slice(1)
        .map((f) => `${f.agent}\t${f.file}`)
        .join('\n') + '\n',
    );
    const r = a6(fx);
    expect(r.status, r.stdout).toBe(3);
    expect(r.stdout).toContain('claude 样本数 4');
    const dup = [...files.slice(1), files[1] as Setup['files'][number]];
    await fx.put(
      '.state/reader-samples.local.txt',
      dup.map((f) => `${f.agent}\t${f.file}`).join('\n') + '\n',
    );
    expect(a6(fx).stdout).toContain('路径有重复');
    await fx.put('.state/reader-samples.local.txt', 'claude\trelative/path\n');
    expect(a6(fx).status).toBe(3);
  }, 60_000);

  it('本地样本与 inventory 的(路径哈希,行数)对不上 => 3', async () => {
    const { fx, files } = await setup();
    const f = files[0] as Setup['files'][number];
    await safe.writeFile(fx.ctx, f.file, (await readText(f.file)) + '{"type":"x"}\n'); // 行数变了
    const r = a6(fx);
    expect(r.status, r.stdout).toBe(3);
    expect(r.stdout).toContain('claude: 本地样本与 inventory/reader-samples.txt');
  }, 60_000);

  it('清单里的文件不存在 => 4', async () => {
    const { fx, files } = await setup();
    await safe.remove(fx.ctx, (files[3] as Setup['files'][number]).file);
    const r = a6(fx);
    expect(r.status, r.stdout).toBe(4);
  }, 60_000);

  it('oracle 与 reader 不等(假 oracle 少数一个失败)=> 1', async () => {
    const { fx } = await setup();
    // 假 oracle(bash):转调真 oracle,把 tool_failures 减 1(下限 0),再多报一个 tool_calls
    const fake = path.join(fx.dir, 'fake-oracle.sh');
    await safe.writeFile(
      fx.ctx,
      fake,
      `#!/usr/bin/env bash\nbash ${ORACLE} "$@" | jq -c '.tool_failures |= (. - 1 | if . < 0 then 0 else . end) | .tool_calls += 1'\n`,
    );
    const r = runScript(
      'a6-readers.sh',
      ['--root', fx.root, '--cli', REAL_CLI, '--oracle', fake, '--no-vitest'],
      fx.env(),
    );
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toMatch(/计数不等 .*tool_calls: reader=\d+ oracle=\d+/);
  }, 120_000);

  it('全零样本:60 个数字相等也不算(空比对)=> 1', async () => {
    const zero: Plan[] = Array.from({ length: 5 }, () => ({ users: 1, tools: 0, failed: 0 }));
    const { fx } = await setup(zero);
    const r = a6(fx);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('全为 0');
  }, 120_000);
});
