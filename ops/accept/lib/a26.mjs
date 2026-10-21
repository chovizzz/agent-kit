// A26 doctor 与 sync(干跑)进 A5 零写入。
//   ①静态:A5 的命令清单(commandsText)含 doctor 与 sync,且只含干跑形态(没有 --write / --uninstall / --rollback / --resume / --adopt,没有 update);
//   ②实跑:把这些命令(取自同一份 syncDoctorCommands)交给 ops/zero-write-check.sh,在假 HOME + 两轮 + 无网垫片 + 干净 git 树下必须零写入、退出 0;
//     同一次运行里夹一条探针命令,在命令环境里断言 KIT_AUTO_UPDATE=0(退出码非 0 就会让 zero-write 的 --require-success 变红);
//   ③正向控制:再跑一次,清单里加一条往假 HOME 写文件的命令,必须被 zero-write 判违规(FAKE_HOME_NOT_EMPTY);
//     并且改成带 --write 的 sync 不在 A5 清单里(见①)——真写入的 sync 由 A25 覆盖。
// 前置:pnpm run build(dist/cli.js)与 pnpm run build:payload(sync 干跑用包内 payload);基线 ref 默认 origin/main。
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  EXIT,
  Reporter,
  cleanEnv,
  makeCtx,
  mkTmp,
  parseCommon,
  rmTmp,
  run,
  runMain,
} from './common.mjs';
import {
  DEFAULT_ARGS,
  commandsText,
  interpretReport,
  payloadMissing,
  syncDoctorCommands,
} from './a5.mjs';

const FORBIDDEN = /--(write|uninstall|rollback|resume|adopt)\b|\bupdate\b/;

/** 纯函数:清单里是否有 doctor 与 sync 的干跑行、且没有危险形态。返回问题列表。 */
export function checkCommandList(text) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const problems = [];
  const has = (name) => lines.some((l) => new RegExp(`--root \\{REPO\\} ${name}( |$)`).test(l));
  if (!has('doctor')) problems.push('清单缺 doctor');
  if (!has('sync')) problems.push('清单缺 sync');
  for (const l of lines.filter((x) => /--root \{REPO\} (doctor|sync|update)\b/.test(x)))
    if (FORBIDDEN.test(l)) problems.push(`清单含非干跑形态:${l.slice(0, 80)}`);
  return problems;
}

const PROBE = `if (process.env.KIT_AUTO_UPDATE !== '0') {
  process.stderr.write('KIT_AUTO_UPDATE 不是 0\\n');
  process.exit(1);
}
process.exit(0);
`;
const WRITER = `import * as fs from 'node:fs';
import * as path from 'node:path';
fs.writeFileSync(path.join(process.env.HOME, 'a26-canary.txt'), 'x');
process.exit(0);
`;

function zeroWrite(ctx, script, tmp, cmdText, baseRef, tag, home) {
  const cmdFile = path.join(tmp, `commands-${tag}.txt`);
  fs.writeFileSync(cmdFile, cmdText);
  const args = [
    ...DEFAULT_ARGS,
    '--base-ref',
    baseRef,
    '--repo',
    ctx.root,
    '--commands-file',
    cmdFile,
    '--out-root',
    path.join(tmp, `zw-${tag}`),
    '--tmp',
    tmp,
    ...(home ? ['--home', home] : []),
  ];
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('npm_') || k === 'NODE_OPTIONS') delete env[k];
  const r = run('bash', [script, ...args], { cwd: ctx.root, env });
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
  return { r, report };
}

async function a26(argv) {
  const R = new Reporter('A26');
  const { flags } = parseCommon(argv, { value: ['base-ref', 'home', 'zero-write'] });
  const ctx = makeCtx(flags);
  const script = flags.zeroWrite ?? path.join(ctx.root, 'ops', 'zero-write-check.sh');

  // ① 静态
  const listProblems = checkCommandList(commandsText('social-ops-hub', ctx.cli));
  if (listProblems.length > 0) R.fail(`A5 命令清单:${listProblems.join('; ')}`);
  else
    R.pass(
      'A5 命令清单含 doctor 与 sync,且只有干跑形态(无 --write/--uninstall/--rollback/--resume/--adopt,无 update)',
    );
  // 正向对照:检查函数对坏清单要报
  const bad = checkCommandList('{NODE} x --root {REPO} sync --write\n');
  if (bad.length >= 2) R.pass('正向控制:清单检查对缺 doctor、带 --write 的 sync 都报出');
  else R.fail('正向控制失败:清单检查对坏清单没报全');

  if (!fs.existsSync(ctx.cli)) {
    R.notRun(`找不到 ${ctx.cli}:先 pnpm run build`);
    return R.exit();
  }
  if (!fs.existsSync(script)) {
    R.notRun(`找不到 ${script}`);
    return R.exit();
  }
  if (payloadMissing(ctx.cli)) {
    R.notRun('包里没有 payload/manifest.json:sync 干跑需要它,先 pnpm run build:payload');
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
    R.notRun(`基线 ref ${baseRef} 不可解析(用 --base-ref <ref> 指定;不静默跳过)`);
    return R.exit();
  }

  const tmp = mkTmp(ctx, 'a26');
  try {
    const probe = path.join(tmp, 'probe-env.mjs');
    const writer = path.join(tmp, 'writer.mjs');
    fs.writeFileSync(probe, PROBE);
    fs.writeFileSync(writer, WRITER);
    const cmds = [...syncDoctorCommands(ctx.cli), `{NODE} ${probe}`, ''].join('\n');

    // ② 实跑
    const main = zeroWrite(ctx, script, tmp, cmds, baseRef, 'main', flags.home);
    if (main.r.spawnFailed || main.r.status === null) {
      R.notRun('zero-write-check 异常终止(超时/信号)');
      return R.exit();
    }
    process.stdout.write(main.r.stdout);
    if (main.r.stderr) process.stderr.write(main.r.stderr);
    const ran = (main.report?.rounds ?? []).map((x) => (x.commands ?? []).length);
    if (!main.report) {
      R.fail(`zero-write-check 退出 ${main.r.status} 且没有可解析的报告`);
    } else {
      const { exit, reasons } = interpretReport(main.r.status, main.report);
      for (const why of reasons) R.info(why);
      if (
        exit === EXIT.OK &&
        ran.length >= 2 &&
        ran.every((n) => n === syncDoctorCommands(ctx.cli).length + 1)
      )
        R.pass(
          `doctor/sync 干跑 + KIT_AUTO_UPDATE 探针零写入(两轮各 ${ran[0]} 条命令均退出 0,假 HOME 无残留)`,
        );
      else
        R.merge(
          exit === EXIT.OK ? EXIT.FAIL : exit,
          `zero-write-check 退出 ${main.r.status} => ${exit}(各轮命令数 ${ran.join('/')})`,
        );
    }

    // ③ 正向控制
    const ctl = zeroWrite(
      ctx,
      script,
      tmp,
      [...syncDoctorCommands(ctx.cli), `{NODE} ${writer}`, ''].join('\n'),
      baseRef,
      'ctl',
      flags.home,
    );
    if (ctl.r.spawnFailed || ctl.r.status === null)
      R.notRun('正向控制的 zero-write-check 异常终止');
    else if (ctl.r.status === EXIT.FAIL && ctl.r.stdout.includes('FAKE_HOME_NOT_EMPTY'))
      R.pass('正向控制:清单里夹一条写假 HOME 的命令,zero-write 判违规(FAKE_HOME_NOT_EMPTY)');
    else
      R.fail(`正向控制:往假 HOME 写文件的命令没有被判违规(退出 ${ctl.r.status})——A26 可能静默变空`);
  } finally {
    rmTmp(tmp);
  }
  return R.exit();
}

await runMain(import.meta.url, 'A26', () => a26(process.argv.slice(2)));
