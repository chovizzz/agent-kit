// A14 交付物齐全:命令面(帮助里的阶段标记、P0 命令不是桩、P1/P2 桩退出 64 并说明阶段)+ 文件清单。
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  EXIT_STUB,
  Reporter,
  cleanEnv,
  mkTmp,
  makeCtx,
  parseCommon,
  rmTmp,
  run,
  runMain,
  sandbox,
} from './common.mjs';

export const COMMAND_PHASES = [
  ['build', 'P0'],
  ['check', 'P0'],
  ['redact', 'P0'],
  ['signals collect', 'P0'],
  ['inventory', 'P1'],
  ['probe', 'P1'],
  ['reflect', 'P1'],
  ['attest', 'P1'],
  ['promote', 'P1'],
  ['retire', 'P1'],
  ['sync', 'P2'],
  ['doctor', 'P2'],
];

/** P1/P2 里已经实装、不再是桩的命令(新增一块实装时在这里登记,否则会被"桩应退出 64"误判)。 */
export const IMPLEMENTED_LATER_PHASE = new Set(['probe']);

export const DELIVERABLES = [
  'kit.toml',
  'ops/zero-write-check.sh',
  'ops/managed-paths.txt',
  'ops/volatile-paths.txt',
  'ops/guards/no-net.cjs',
  'ops/accept-p0.sh',
  'ops/accept/a13-mutation.md',
  'ops/reader-oracle/run.sh',
  'inventory/claude-md-sections.md',
  'inventory/skills-dirs.md',
  'inventory/memory-counts.md',
  'inventory/hooks-and-agents-md.md',
  'inventory/commands.sh',
  'inventory/reader-samples.txt',
  'docs/contracts.md',
  'docs/architecture-p0.md',
  'docs/block-boundaries.md',
  'docs/reader-counting-spec.md',
  'docs/redaction.md',
  'docs/deps.md',
  'docs/release-checklist.md',
];

/** 解析 `agent-kit --help` 里的命令表 => Map(name => phase)。 */
export function parseHelpTable(text) {
  const m = new Map();
  for (const l of text.split('\n')) {
    const r = /^\s{2}(\S+(?: \S+)?)\s+\[(P\d)\]\s/.exec(l);
    if (r) m.set(r[1].replace(/\s+$/, ''), r[2]);
  }
  return m;
}

async function a14(argv) {
  const R = new Reporter('A14');
  const { flags } = parseCommon(argv);
  const ctx = makeCtx(flags);

  const missing = DELIVERABLES.filter((f) => !fs.existsSync(path.join(ctx.root, f)));
  if (missing.length) R.fail(`缺交付物:${missing.join(', ')}`);
  else R.pass(`${DELIVERABLES.length} 个交付物文件齐全`);
  for (const f of ['ops/zero-write-check.sh', 'ops/accept-p0.sh', 'ops/reader-oracle/run.sh']) {
    const p = path.join(ctx.root, f);
    if (fs.existsSync(p) && (fs.statSync(p).mode & 0o111) === 0) R.fail(`${f} 没有可执行位`);
  }
  const accept = fs.existsSync(path.join(ctx.root, 'ops', 'accept'))
    ? fs.readdirSync(path.join(ctx.root, 'ops', 'accept'))
    : [];
  for (let i = 1; i <= 15; i++) {
    const re = new RegExp(`^a${i}-.+\\.(sh|md)$`);
    if (!accept.some((n) => re.test(n))) R.fail(`缺 ops/accept/a${i}-*.sh|md`);
  }

  if (!fs.existsSync(ctx.cli)) {
    R.notRun(`找不到 CLI:${ctx.cli}`);
    return R.exit();
  }
  const tmp = mkTmp(ctx, 'a14');
  try {
    const sb = sandbox(tmp);
    const emptyRoot = path.join(tmp, 'empty-root');
    fs.mkdirSync(emptyRoot, { recursive: true });
    const env = cleanEnv({ HOME: sb.home, KIT_TMP: sb.kit });
    const cli = (args) => run(ctx.node, [ctx.cli, ...args], { cwd: emptyRoot, env });

    const help = cli(['--help']);
    if (help.status !== 0) R.fail(`agent-kit --help 退出 ${help.status}`);
    else {
      const table = parseHelpTable(help.stdout);
      const bad = COMMAND_PHASES.filter(([n, ph]) => table.get(n) !== ph).map(
        ([n, ph]) => `${n}(应为 ${ph},帮助里是 ${table.get(n) ?? '缺失'})`,
      );
      if (bad.length) R.fail(`帮助里的命令/阶段标记不符:${bad.join('; ')}`);
      else R.pass(`${COMMAND_PHASES.length} 个命令都在 --help 里,阶段标记正确`);
    }
    for (const [name, phase] of COMMAND_PHASES) {
      const words = name.split(' ');
      const h = cli([...words, '--help']);
      if (h.status !== 0) R.fail(`${name} --help 退出 ${h.status}`);
      const r = cli(['--root', emptyRoot, ...words]);
      if (phase === 'P0') {
        if (r.spawnFailed || r.status === null) R.notRun(`${name}: 未能正常结束`);
        else if (r.status === EXIT_STUB) R.notRun(`${name}: [P0] 命令仍是桩(退出 64),交付物不齐`);
        else if (r.status === 4) R.notRun(`${name}: [P0] 命令自报未执行(退出 4)`);
        else R.pass(`${name}: [P0] 不是命令桩(空仓库下退出 ${r.status})`);
      } else if (IMPLEMENTED_LATER_PHASE.has(name)) {
        // 已实装的不再是桩:空仓库下必须正常结束且不得自报未执行(与 P0 同一判据)。
        if (r.spawnFailed || r.status === null) R.notRun(`${name}: 未能正常结束`);
        else if (r.status === EXIT_STUB) R.fail(`${name}: [${phase}] 已实装却仍以桩退出 64`);
        else if (r.status === 4) R.notRun(`${name}: [${phase}] 命令自报未执行(退出 4)`);
        else R.pass(`${name}: [${phase}] 已实装(空仓库下退出 ${r.status})`);
      } else if (r.status !== EXIT_STUB)
        R.fail(`${name}: [${phase}] 命令桩应退出 64,实际 ${r.status}`);
      else if (!r.stderr.includes(phase)) R.fail(`${name}: 桩的 stderr 没有说明 ${phase} 才实现`);
      else R.pass(`${name}: [${phase}] 桩退出 64 并说明阶段`);
    }
  } finally {
    rmTmp(tmp);
  }
  return R.exit();
}

await runMain(import.meta.url, 'A14', () => a14(process.argv.slice(2)));
