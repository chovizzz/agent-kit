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

export function commandsText(allowProject, cli = '{REPO}/dist/cli.js') {
  return [
    `{NODE} ${cli} --root {REPO} build`,
    `{NODE} ${cli} --root {REPO} check`,
    `{NODE} ${cli} --root {REPO} redact --selftest`,
    ...['claude', 'codex', 'pi', 'kimi'].map(
      (a) =>
        `{NODE} ${cli} --root {REPO} signals collect --agent ${a} --allow-project ${allowProject} --source {SOURCE} --dry`,
    ),
    '',
  ].join('\n');
}

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
    fs.writeFileSync(cmdFile, commandsText(flags.allowProject ?? 'social-ops-hub', ctx.cli));
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
