// A8 运行期无网络:NODE_OPTIONS=--require ops/guards/no-net.cjs 包住 build/check/redact/signals,
// 全部仍成功且 stderr/日志里没有 [no-net] blocked(被吞掉的联网尝试也算);并带正向对照探针(必须被拦)。
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

// 探针里不写字面量地址/URL(A10 的全量脱敏扫描对 ipv4/url 零容忍),运行时拼出来
const LOOP = ['127', '0', '0', '1'].join('.');
const SCHEME = (p) => `${p}:` + '/' + '/';
export const PROBES = [
  ['net.connect', `require('node:net').connect(9,'${LOOP}').on('error',()=>{})`],
  ['fetch', `Promise.resolve().then(()=>fetch('${SCHEME('http')}${LOOP}:9/')).catch(()=>{})`],
  [
    'https.request',
    `try{require('node:https').request('${SCHEME('https')}${LOOP}:9/').on('error',()=>{}).end()}catch(e){}`,
  ],
  ['dns.lookup', "try{require('node:dns').lookup('example.invalid',()=>{})}catch(e){}"],
  ['spawn curl', "try{require('node:child_process').spawnSync('curl',['--version'])}catch(e){}"],
];

async function a8(argv) {
  const R = new Reporter('A8');
  const { flags } = parseCommon(argv, { value: ['allow-project'] });
  const ctx = makeCtx(flags);
  const shim = path.join(ctx.root, 'ops', 'guards', 'no-net.cjs');
  if (!fs.existsSync(shim)) {
    R.fail(`缺垫片 ${path.relative(ctx.root, shim)}`);
    return R.exit();
  }
  const tmp = mkTmp(ctx, 'a8');
  try {
    const log = path.join(tmp, 'no-net.log');
    const sb = sandbox(tmp);
    const baseEnv = {
      HOME: sb.home,
      KIT_TMP: sb.kit,
      NODE_OPTIONS: `--require ${shim}`,
      KIT_NO_NET_LOG: log,
    };
    const readLog = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');

    // 1) 正向对照:垫片必须真的拦得住(否则下面的"全部成功"没有意义)
    for (const [name, code] of PROBES) {
      fs.rmSync(log, { force: true });
      const r = run(ctx.node, ['-e', code], { env: cleanEnv(baseEnv), cwd: tmp });
      if (!readLog().includes('[no-net] blocked') && !r.stderr.includes('[no-net] blocked')) {
        R.fail(`垫片自检:${name} 没有被拦(垫片失效,A8 结论不可信)`);
      } else R.pass(`垫片自检:${name} 被拦`);
    }

    // 2) 运行期命令
    const emptySource = path.join(tmp, 'source-empty');
    fs.mkdirSync(emptySource, { recursive: true });
    const allow = flags.allowProject ?? 'social-ops-hub';
    const cmds = [
      ['build', ['build']],
      ['check', ['check']],
      ['redact --selftest', ['redact', '--selftest']],
      [
        'signals collect',
        [
          'signals',
          'collect',
          '--agent',
          'claude',
          '--allow-project',
          allow,
          '--source',
          emptySource,
          '--dry',
        ],
      ],
    ];
    if (!fs.existsSync(ctx.cli)) {
      R.notRun(`找不到 CLI:${ctx.cli}`);
      return R.exit();
    }
    for (const [name, args] of cmds) {
      fs.rmSync(log, { force: true });
      const r = run(ctx.node, [ctx.cli, '--root', ctx.root, ...args], {
        env: cleanEnv(baseEnv),
        cwd: ctx.root,
      });
      const blocked =
        readLog().includes('[no-net] blocked') || r.stderr.includes('[no-net] blocked');
      if (r.spawnFailed || r.status === null) R.notRun(`${name}: 未能正常结束`);
      else if (blocked)
        R.fail(`${name}: 尝试了联网(垫片拦截记录:${(readLog() || r.stderr).split('\n')[0]})`);
      else if (r.status === EXIT_STUB) R.notRun(`${name}: 命令桩(退出 64),无法证明运行期零网络`);
      else if (r.status !== 0)
        R.fail(`${name}: 退出 ${r.status}(要求仍成功) :: ${r.stderr.slice(0, 200)}`);
      else R.pass(`${name}: 在垫片下成功,未触网`);
    }
  } finally {
    rmTmp(tmp);
  }
  return R.exit();
}

await runMain(import.meta.url, 'A8', () => a8(process.argv.slice(2)));
