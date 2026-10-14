// A5 零写入:薄封装 ops/zero-write-check.sh(B17)。补强:
//  - 自带命令清单(B17 默认清单的 signals collect 缺 --agent/--allow-project,必然退出 2);
//  - dist/cli.js 缺失、基线 ref 不可解析 => 4(不静默跳过基线比较);
//  - 命令桩(退出 64)=> 4,不折成违规 1;
//  - 第二轮的命令退出码与 git 树变化由本脚本补查(B17 只查第一轮)。
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  EXIT,
  Reporter,
  cleanEnv,
  distSrc,
  mkTmp,
  makeCtx,
  parseCommon,
  rmTmp,
  run,
  runMain,
} from './common.mjs';

export const DEFAULT_ARGS = [
  '--two-rounds',
  '--no-net',
  '--require-success',
  '--require-clean-tree',
];

export function commandsText(allowProject, cli = '{REPO}/dist/cli.js', extra = []) {
  return [
    `{NODE} ${cli} --root {REPO} build`,
    `{NODE} ${cli} --root {REPO} check`,
    `{NODE} ${cli} --root {REPO} redact --selftest`,
    ...['claude', 'codex', 'pi', 'kimi'].map(
      (a) =>
        `{NODE} ${cli} --root {REPO} signals collect --agent ${a} --allow-project ${allowProject} --source {SOURCE} --dry`,
    ),
    ...extra,
    '',
  ].join('\n');
}

/**
 * attest / promote / retire 的零写入命令(L7)。真实仓库里的原子都是 org 层 proposed,三条命令对它们退出 2,
 * 所以这三条跑在**合成生命周期仓库**上(A22 的同一份世界),通过包装脚本执行:
 *  - 包装脚本把 KIT_WRITE_ROOTS 收窄到合成仓库自己的 out/ 与 .state/(zero-write 给的是真实仓库的根,合成仓库越界会被产品拒绝);
 *  - 并在命令前后对合成仓库整棵树(含 .git 与 .state)取哈希,不一致就退出 97(这是对合成仓库的零写入判据,真实仓库的 git 树另由 zero-write 查)。
 * 命令集合写死在这里;包装脚本自己的退出码 97 会让 zero-write 的 --require-success 变红。
 */
export const LIFECYCLE_DRY = [
  ['promote', '--rule', 'to-promote', '--to', 'advisory'],
  ['retire', '--rule', 'to-retire', '--to', 'deprecated', '--reason', 'manual'],
  [
    'attest',
    '--rule',
    'to-attest',
    '--member',
    '@alice',
    '--window-start',
    '2026-10-01',
    '--window-end',
    '2026-10-14',
  ],
];

export const WRAPPER_SOURCE = `import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const [cli, root, ...args] = process.argv.slice(2);
const hashTree = (dir) => {
  const h = createHash('sha256');
  const walk = (rel) => {
    for (const n of fs.readdirSync(path.join(dir, rel)).sort()) {
      const r = rel === '' ? n : rel + '/' + n;
      const st = fs.lstatSync(path.join(dir, r));
      if (st.isDirectory()) walk(r);
      else h.update(r + '\\0' + (st.isSymbolicLink() ? fs.readlinkSync(path.join(dir, r)) : fs.readFileSync(path.join(dir, r))) + '\\0');
    }
  };
  walk('');
  return h.digest('hex');
};
const before = hashTree(root);
const env = { ...process.env, KIT_WRITE_ROOTS: [path.join(root, 'out'), path.join(root, '.state')].join(path.delimiter) };
delete env.KIT_STATE_DIR; // 状态目录取合成仓库自己的 .state/(与准备阶段的 signals collect 一致,也在上面收窄后的写入根之内)
const r = spawnSync(process.execPath, [cli, '--root', root, ...args], { env, stdio: 'inherit' });
const after = hashTree(root);
if (before !== after) {
  process.stderr.write('lifecycle-dry-wrapper: 合成仓库在干跑后发生了变化\\n');
  process.exit(97);
}
process.exit(r.status === null ? 98 : r.status);
`;

/** 把 zero-write 的报告 JSON 翻译成 { exit, reasons[] }(纯函数,便于单测)。 */
export function interpretReport(exit, report) {
  const reasons = [];
  if (!report) return { exit, reasons };
  const findings = report.findings ?? [];
  const abnormal = findings.filter((f) => f.code === 'COMMAND_ABNORMAL_EXIT');
  const other = findings.filter((f) => f.code !== 'COMMAND_ABNORMAL_EXIT');
  let code = exit;
  if (exit === EXIT.FAIL && other.length === 0 && abnormal.length > 0) {
    const cmds = abnormal.flatMap((f) => f.commands ?? []);
    if (cmds.length > 0 && cmds.every((c) => c.code === 64 && !c.abnormal)) {
      code = EXIT.NOT_RUN;
      reasons.push(
        `命令桩(退出 64)尚未实现:${cmds.map((c) => c.cmd.split(' ').slice(0, 4).join(' ')).join(' | ')}`,
      );
    }
  }
  // 第二轮补查
  const r2 = (report.rounds ?? [])[1];
  if (r2) {
    const bad = (r2.commands ?? []).filter((c) => c.abnormal || c.code === null || c.code !== 0);
    if (bad.length && code === EXIT.OK) {
      code = bad.every((c) => c.code === 64) ? EXIT.NOT_RUN : EXIT.FAIL;
      reasons.push(
        `第二轮命令退出码异常:${bad.map((c) => `${c.cmd.split(' ').slice(0, 3).join(' ')}=>${c.code}`).join(' | ')}`,
      );
    }
    const t = r2.git_tree;
    if (t?.available && ((t.added ?? []).length || (t.removed ?? []).length) && code === EXIT.OK) {
      code = EXIT.FAIL;
      reasons.push('第二轮 git 工作树发生变化');
    }
    if ((r2.fake_home_leftovers ?? []).length && code === EXIT.OK) {
      code = EXIT.FAIL;
      reasons.push('第二轮假 HOME 有残留');
    }
  } else if (code === EXIT.OK) {
    code = EXIT.FAIL;
    reasons.push('没有第二轮结果(--two-rounds 未生效?)');
  }
  return { exit: code, reasons };
}

/** 准备合成生命周期仓库 + 包装脚本,返回追加的命令行;CLI 不是本仓库构建的(没有 dist/src/lifecycle)时返回 [] 并说明。 */
export async function lifecycleExtra(R, ctx, tmp) {
  const distSrcDir = distSrc(ctx);
  if (!fs.existsSync(path.join(distSrcDir, 'lifecycle', 'checks.js'))) {
    R.info('未纳入 attest/promote/retire:--cli 旁边没有 dist/src/lifecycle(CLI 不是本仓库构建的)');
    return [];
  }
  const { loadWorldMods, buildDryWorld, writeSessions } = await import('./lc-world.mjs');
  const mods = await loadWorldMods(ctx);
  const synth = path.join(tmp, 'synth-lifecycle');
  buildDryWorld(mods, synth, path.join(tmp, 'synth-githome'));
  const sessions = path.join(tmp, 'synth-sessions');
  writeSessions(sessions);
  const prepHome = path.join(tmp, 'synth-prep-home');
  const prepKit = path.join(tmp, 'synth-prep-kit');
  fs.mkdirSync(prepHome, { recursive: true });
  fs.mkdirSync(prepKit, { recursive: true });
  const prep = run(
    ctx.node,
    [
      ctx.cli,
      '--root',
      synth,
      'signals',
      'collect',
      '--source',
      sessions,
      '--agent',
      'claude',
      '--allow-project',
      'proj-a',
      '--allow-project',
      'proj-b',
    ],
    { env: cleanEnv({ HOME: prepHome, KIT_TMP: prepKit }) },
  );
  if (prep.status !== 0)
    throw new Error(`合成仓库的信号准备失败(退出 ${prep.status}):${prep.stderr.slice(0, 120)}`);
  const wrapper = path.join(tmp, 'lifecycle-dry-wrapper.mjs');
  fs.writeFileSync(wrapper, WRAPPER_SOURCE);
  R.info(`已纳入 attest/promote/retire 三条干跑(合成仓库 ${path.basename(synth)})`);
  return LIFECYCLE_DRY.map((a) => `{NODE} ${wrapper} ${ctx.cli} ${synth} ${a.join(' ')}`);
}

async function a5(argv) {
  const R = new Reporter('A5');
  const { flags } = parseCommon(argv, {
    value: ['base-ref', 'home', 'allow-project', 'zero-write'],
    bool: [],
  });
  const ctx = makeCtx(flags);
  const script = flags.zeroWrite ?? path.join(ctx.root, 'ops', 'zero-write-check.sh');
  if (!fs.existsSync(ctx.cli)) {
    R.notRun(`找不到 ${ctx.cli}:先 pnpm run build`);
    return R.exit();
  }
  if (!fs.existsSync(script)) {
    R.notRun(`找不到 ${script}`);
    return R.exit();
  }
  const baseRef = flags.baseRef ?? 'origin/main';
  const gitEnv = cleanEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  const rp = run(
    'git',
    ['-C', ctx.root, 'rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`],
    { env: gitEnv },
  );
  if (rp.status !== 0) {
    R.notRun(
      `基线 ref ${baseRef} 不可解析:无法做清单基线比较(用 --base-ref <ref> 指定;不静默跳过)`,
    );
    return R.exit();
  }
  const tmp = mkTmp(ctx, 'a5');
  try {
    const cmdFile = path.join(tmp, 'commands.txt');
    const extra = await lifecycleExtra(R, ctx, tmp);
    fs.writeFileSync(cmdFile, commandsText(flags.allowProject ?? 'social-ops-hub', ctx.cli, extra));
    const outRoot = path.join(tmp, 'zw');
    const args = [
      ...DEFAULT_ARGS,
      '--base-ref',
      baseRef,
      '--repo',
      ctx.root,
      '--commands-file',
      cmdFile,
      '--out-root',
      outRoot,
      '--tmp',
      tmp,
      ...(flags.home ? ['--home', flags.home] : []),
    ];
    const env = { ...process.env };
    for (const k of Object.keys(env))
      if (k.startsWith('npm_') || k === 'NODE_OPTIONS') delete env[k];
    const r = run('bash', [script, ...args], { cwd: ctx.root, env });
    process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.spawnFailed || r.status === null) {
      R.notRun('zero-write-check 异常终止(超时/信号)');
      return R.exit();
    }
    let report = null;
    const m = /报告:(.+)/.exec(r.stdout);
    const dir = m ? m[1].trim() : null;
    if (dir && fs.existsSync(path.join(dir, 'report.json'))) {
      try {
        report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
      } catch {
        report = null;
      }
    }
    if (!report && r.status === EXIT.OK) {
      R.fail('zero-write-check 返回 0 但没有可解析的报告(无法核对第二轮)');
      return R.exit();
    }
    const { exit, reasons } = interpretReport(r.status, report);
    for (const why of reasons) R.info(why);
    R.merge(exit, `zero-write-check 退出 ${r.status} => A5 ${exit}`);
  } finally {
    rmTmp(tmp);
  }
  return R.exit();
}

await runMain(import.meta.url, 'A5', () => a5(process.argv.slice(2)));
