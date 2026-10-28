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

/**
 * A26:doctor 与 sync(干跑,不带 --write / --uninstall / --rollback / --resume / --adopt)进 A5 命令清单。
 * 二者默认零写入:doctor 只读(契约 §19.3),sync 干跑只算计划(§19.2);sync 用包内 payload(`pnpm run build:payload` 产物)。
 * 命令环境固定带 KIT_AUTO_UPDATE=0(ops/lib/zero-write.mjs 的 buildEnv),免得启动器在零写入窗口里拉起后台更新 worker。
 */
export function syncDoctorCommands(cli = '{REPO}/dist/cli.js') {
  return [
    `{NODE} ${cli} --root {REPO} doctor`,
    `{NODE} ${cli} --root {REPO} doctor --json`,
    `{NODE} ${cli} --root {REPO} sync`,
    `{NODE} ${cli} --root {REPO} sync --json`,
  ];
}

/** sync 干跑要用包内 payload(<包根>/payload/manifest.json,包根 = dist/cli.js 的上一级)。CLI 不在含 package.json 的包里(测试桩)时不判。 */
export function payloadMissing(cli) {
  const pkgRoot = path.dirname(path.dirname(cli));
  return (
    fs.existsSync(path.join(pkgRoot, 'package.json')) &&
    !fs.existsSync(path.join(pkgRoot, 'payload', 'manifest.json'))
  );
}

/**
 * probe:干跑与 `--write`(只产补丁文本,不写文件系统;观测值由人给,这里用占位值)。
 * 真实仓库 kit.toml 若没有非 documented 目标,--write 也只打印「没有可写回的目标」;两条都必须零写入、退出 0。
 */
export function probeCommands(cli = '{REPO}/dist/cli.js') {
  return [
    `{NODE} ${cli} --root {REPO} probe`,
    // 只探当前 assumed 的三个 agent(documented 目标本来就跳过);观测值给足够大的占位值(当前 max 均 16384);kit.toml 的 agent/max 变动后需同步这里
    `{NODE} ${cli} --root {REPO} probe --write --agent pi --agent kimi --agent opencode --agent-version pi=1.0.0 --agent-version kimi=1.0.0 --agent-version opencode=1.0.0 --observed pi=65536 --observed kimi=65536 --observed opencode=65536`,
  ];
}

/**
 * R20-A2 B5e(§20.8.1 / §20.9 第 16 条):rsi 干跑 / 只读 / 被拒类命令。全部零写入;`# exit=` 是**逐行**声明的允许退出码(不全局放开)。
 * 两轮环境:`off`(假 HOME 没有 `[rsi]` 配置)与 `armed`(假 HOME 预置合规 config.toml,`[rsi] repo` 指向被测仓库,状态为首次 armed)。
 *  - tick / projects --rebuild-index / purge 在 off 时 4(`RSI_NOT_RUN reason=off`);armed 下 tick 干跑 0,没有盐 = 没有确认过 → rebuild / purge 4(`not_confirmed`);
 *  - status / projects 是只读观察命令,off / armed 都 0;
 *  - confirm 在 A5 里非 TTY → 2(`RSI_USAGE reason=not_tty`,先于任何读);被拒 confirm 与 `purge --write` 的锁后拒绝由 test/rsi/b5-zero-write.test.ts 在进程内证明。
 * poke / hint 的行属于 A3。
 */
export const RSI_DRY = [
  { argv: ['tick'], off: [4], armed: [0] },
  { argv: ['tick', '--json'], off: [4], armed: [0] },
  { argv: ['status'], off: [0], armed: [0] },
  { argv: ['status', '--json'], off: [0], armed: [0] },
  { argv: ['projects'], off: [0], armed: [0] },
  { argv: ['projects', '--json'], off: [0], armed: [0] },
  { argv: ['projects', '--rebuild-index'], off: [4], armed: [4] },
  { argv: ['purge', '--excluded'], off: [4], armed: [4] },
  { argv: ['purge', '--resume'], off: [4], armed: [4] },
  { argv: ['confirm'], off: [2], armed: [2] },
];

export function rsiDryCommands(env, cli = '{REPO}/dist/cli.js') {
  return RSI_DRY.map(
    (c) => `{NODE} ${cli} --root {REPO} rsi ${c.argv.join(' ')} # exit=${c[env].join(',')}`,
  );
}

export function commandsText(allowProject, cli = '{REPO}/dist/cli.js', extra = []) {
  return [
    `{NODE} ${cli} --root {REPO} build`,
    `{NODE} ${cli} --root {REPO} check`,
    `{NODE} ${cli} --root {REPO} redact --selftest`,
    ...syncDoctorCommands(cli),
    ...probeCommands(cli),
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
    // 行内声明了 `# exit=…` 的命令按它判(allowed_exit);没声明的只收 0
    const bad = (r2.commands ?? []).filter(
      (c) =>
        c.abnormal ||
        c.code === null ||
        !(Array.isArray(c.allowed_exit) ? c.allowed_exit : [0]).includes(c.code),
    );
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

/** lstat 判存在:只有 ENOENT 才是「不存在」;悬空符号链接、权限错误等一律按「存在」(fail-closed) */
function pathPresent(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch (e) {
    return e?.code !== 'ENOENT';
  }
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
  if (payloadMissing(ctx.cli)) {
    R.notRun('包里没有 payload/manifest.json:A5 清单含 sync 干跑,先 pnpm run build:payload');
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
    const extra = await lifecycleExtra(R, ctx, tmp);
    // 真实构建才有 rsi 入口;测试桩 CLI(没有 dist/src/rsi)不纳入 rsi 命令与第二环境
    const hasRsi = fs.existsSync(path.join(path.dirname(path.dirname(ctx.cli)), 'package.json'));
    if (!hasRsi)
      R.info('未纳入 rsi 干跑命令:--cli 不在含 package.json 的包里(测试桩,不是本仓库构建的 CLI)');
    const base = commandsText(flags.allowProject ?? 'social-ops-hub', ctx.cli, extra);
    // rsi 状态树(被测仓库的 .state/{rsi,signals,sessions,salt}):两个环境的干跑 / 只读 / 被拒命令都不得创建它们。
    // 用 lstat 判存在(existsSync 跟随链接,悬空符号链接会被当成「不存在」);ENOENT 之外的错误按「存在」处理(fail-closed)
    const repoReal = fs.realpathSync(ctx.root);
    const rsiState = ['rsi', 'signals', 'sessions', 'salt'].map((n) =>
      path.join(repoReal, '.state', n),
    );
    const presentNow = () => rsiState.filter(pathPresent);
    const preexisting = hasRsi ? presentNow() : [];
    const names = (ps) => ps.map((p) => path.basename(p)).join(',');
    // 第一轮环境:没有 [rsi] 配置(假 HOME 为空)→ 全部 off;rsi 命令随清单一起跑
    await runPass(R, ctx, {
      script,
      tmp,
      baseRef,
      label: hasRsi ? 'off' : 'default',
      text: hasRsi ? base + rsiDryCommands('off', ctx.cli).join('\n') + '\n' : base,
      home: flags.home,
    });
    if (hasRsi) {
      // off 环境之后:事先不存在的状态树不得出现(出现 = 干跑命令写了东西 = 违规 1,不能归成「前提不满足」)
      const createdOff = presentNow().filter((p) => !preexisting.includes(p));
      if (createdOff.length > 0) R.fail(`off 环境的命令创建了 rsi 状态:${names(createdOff)}`);
      else R.pass('off 环境:被测仓库 .state/{rsi,signals,sessions,salt} 没有新增');
      // 第二环境:假 HOME 预置合规 config.toml(`[rsi] repo` = 被测仓库的 realpath,首次 armed)。
      // 预置路径只在这一环境允许存在并逐项核对不变(zero-write --home-seed:含 ino / ctime,抓写后还原与同字节覆盖)。
      if (preexisting.length > 0) {
        R.notRun(
          `armed 环境要求被测仓库 ${path.join('.state', '{rsi,signals,sessions,salt}')} 事先不存在(否则读到的不是首次 armed;已存在:${names(preexisting)}):换一份干净检出`,
        );
      } else if (createdOff.length === 0) {
        const seed = path.join(tmp, 'seed-home');
        const cfgDir = path.join(seed, '.config', 'agent-kit');
        fs.mkdirSync(cfgDir, { recursive: true, mode: 0o755 });
        fs.chmodSync(path.join(seed, '.config'), 0o755);
        fs.chmodSync(cfgDir, 0o755);
        const cfg = path.join(cfgDir, 'config.toml');
        fs.writeFileSync(cfg, `[rsi]\nenabled = true\nrepo = ${JSON.stringify(repoReal)}\n`, {
          mode: 0o600,
        });
        fs.chmodSync(cfg, 0o600);
        await runPass(R, ctx, {
          script,
          tmp,
          baseRef,
          label: 'armed',
          text: rsiDryCommands('armed', ctx.cli).join('\n') + '\n',
          home: flags.home,
          seed,
        });
        const created = presentNow();
        if (created.length > 0) R.fail(`armed 环境的干跑命令创建了 rsi 状态:${names(created)}`);
        else R.pass('armed 环境:被测仓库 .state/{rsi,signals,sessions,salt} 仍不存在');
      }
    }
  } finally {
    rmTmp(tmp);
  }
  return R.exit();
}

/** 跑一轮 zero-write-check(内部 --two-rounds)并把结果并入 R。 */
async function runPass(R, ctx, o) {
  const cmdFile = path.join(o.tmp, `commands-${o.label}.txt`);
  fs.writeFileSync(cmdFile, o.text);
  const outRoot = path.join(o.tmp, `zw-${o.label}`);
  const args = [
    ...DEFAULT_ARGS,
    '--base-ref',
    o.baseRef,
    '--repo',
    ctx.root,
    '--commands-file',
    cmdFile,
    '--out-root',
    outRoot,
    '--tmp',
    o.tmp,
    ...(o.home ? ['--home', o.home] : []),
    ...(o.seed ? ['--home-seed', o.seed] : []),
  ];
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('npm_') || k === 'NODE_OPTIONS') delete env[k];
  const r = run('bash', [o.script, ...args], { cwd: ctx.root, env });
  process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.spawnFailed || r.status === null) {
    R.notRun(`zero-write-check(${o.label})异常终止(超时/信号)`);
    return;
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
    R.fail(`zero-write-check(${o.label})返回 0 但没有可解析的报告(无法核对第二轮)`);
    return;
  }
  const { exit, reasons } = interpretReport(r.status, report);
  for (const why of reasons) R.info(why);
  R.merge(exit, `zero-write-check(${o.label})退出 ${r.status} => A5 ${exit}`);
}

await runMain(import.meta.url, 'A5', () => a5(process.argv.slice(2)));
