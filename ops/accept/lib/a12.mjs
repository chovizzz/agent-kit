// A12 全量绿灯:在干净克隆里重跑 typecheck / test / lint / format:check;vitest skipped/todo 必须为 0。
// 判据是被克隆的提交(HEAD 或 --ref);源仓库有未提交改动时报告 SHA 并提示(--require-clean-tree 则直接拒绝)。
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  Reporter,
  cleanEnv,
  evaluateVitest,
  mkTmp,
  makeCtx,
  parseCommon,
  rmTmp,
  run,
  runMain,
  sandbox,
} from './common.mjs';

async function a12(argv) {
  const R = new Reporter('A12');
  const { flags } = parseCommon(argv, {
    value: ['ref', 'pnpm'],
    bool: ['require-clean-tree', 'offline'],
  });
  const ctx = makeCtx(flags);
  const pnpm = flags.pnpm ?? 'pnpm';
  if (process.env.KIT_A12_ACTIVE === '1') {
    R.usage('A12 不可嵌套(KIT_A12_ACTIVE=1:当前已在 A12 的克隆里运行)');
    return R.exit();
  }
  const gitEnv = cleanEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  const ref = flags.ref ?? 'HEAD';
  const sha = run('git', ['-C', ctx.root, 'rev-parse', '--verify', `${ref}^{commit}`], {
    env: gitEnv,
  });
  if (sha.status !== 0) {
    R.notRun(`无法解析 ${ref}(不是 git 仓库或 ref 不存在)`);
    return R.exit();
  }
  const commit = sha.stdout.trim();
  const st = run('git', ['-C', ctx.root, 'status', '--porcelain'], { env: gitEnv });
  const dirty = st.stdout
    .split('\n')
    .filter((l) => l && !/^.. (\.state|out)\//.test(l) && !/^\?\? (\.state|out)\//.test(l));
  if (dirty.length) {
    if (flags.requireCleanTree) {
      R.rejected(
        `工作树有 ${dirty.length} 处未提交改动,A12 验的是提交而不是工作树(--require-clean-tree)`,
      );
      return R.exit();
    }
    R.info(
      `注意:源工作树有 ${dirty.length} 处未提交改动,A12 只验提交 ${commit.slice(0, 12)},这些改动不在被验范围内`,
    );
  }
  R.info(`被验提交:${commit}`);

  const tmp = mkTmp(ctx, 'a12');
  try {
    const clone = path.join(tmp, 'clone');
    const c = run('git', ['clone', '--quiet', '--no-hardlinks', ctx.root, clone], { env: gitEnv });
    if (c.status !== 0) {
      R.notRun(`git clone 失败:${c.stderr.slice(0, 160)}`);
      return R.exit();
    }
    const co = run('git', ['-C', clone, 'checkout', '--quiet', '--detach', commit], {
      env: gitEnv,
    });
    if (co.status !== 0) {
      R.notRun(`克隆里检出 ${commit} 失败:${co.stderr.slice(0, 160)}`);
      return R.exit();
    }
    const sb = sandbox(tmp);
    const env = { ...process.env, CI: '1', KIT_A12_ACTIVE: '1', KIT_TMP: sb.kit };
    for (const k of Object.keys(env))
      if (k.startsWith('npm_config_') && k !== 'npm_config_registry') delete env[k];
    const step = (label, args, opts = {}) => {
      const r = run(pnpm, args, { cwd: clone, env, timeoutMs: opts.timeoutMs });
      if (r.spawnFailed) {
        R.notRun(`${label}: 找不到 ${pnpm}`);
        return null;
      }
      if (r.status === null) {
        R.notRun(`${label}: 未能正常结束(超时/信号 ${r.signal ?? ''})`);
        return null;
      }
      if (r.status !== 0)
        R.fail(
          `${label}: 退出 ${r.status} :: ${(r.stdout + r.stderr).split('\n').filter(Boolean).slice(-4).join(' | ').slice(0, 300)}`,
        );
      else R.pass(label);
      return r;
    };
    const install = step('pnpm install --frozen-lockfile --ignore-scripts', [
      'install',
      '--frozen-lockfile',
      '--ignore-scripts',
      flags.offline ? '--offline' : '--prefer-offline',
    ]);
    if (!install || install.status !== 0) return R.exit();
    step('typecheck', ['run', 'typecheck']);
    // build 也在克隆里跑一遍(测试读 dist);失败即失败
    step('build', ['run', 'build']);
    const vjson = path.join(sb.kit, 'vitest.json');
    const t = run(pnpm, ['exec', 'vitest', 'run', '--reporter=json', `--outputFile=${vjson}`], {
      cwd: clone,
      env,
    });
    if (t.spawnFailed || !fs.existsSync(vjson))
      R.notRun(`test: vitest 没有产出结果(exit ${t.status})`);
    else {
      let ev;
      try {
        ev = evaluateVitest(JSON.parse(fs.readFileSync(vjson, 'utf8')));
      } catch {
        ev = null;
      }
      if (!ev) R.notRun('test: 结果不是合法 JSON');
      else if (!ev.ok || t.status !== 0)
        R.fail(`test: ${ev.problems.join('; ') || `退出 ${t.status}`}`);
      else R.pass(`test: ${ev.passed}/${ev.total} 通过,skipped=0 todo=0`);
    }
    step('lint', ['run', 'lint']);
    step('format:check', ['run', 'format:check']);
  } finally {
    rmTmp(tmp);
  }
  return R.exit();
}

await runMain(import.meta.url, 'A12', () => a12(process.argv.slice(2)));
